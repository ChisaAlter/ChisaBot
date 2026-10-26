import {
  type ReactFrontendTool,
  useCopilotKit,
  useFrontendTool as useSDKFrontendTool,
} from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { tryClient } from "@/lib/client";
import { botForAgent, useActiveBotHolder, withRunBot } from "./active-bot";
import { backendOwnsFrontendCall, frontendApprovalSnapshot, frontendCallMeta } from "./approval-context";
import { setComputerCallMeta } from "@/lib/computers/call-meta";
import { beginFrontendTool } from "./frontend-tool-activity";
import { markApprovalPause } from "./stopped-turn";

type RenderProps = { toolCallId: string; [key: string]: unknown };

const writes = new Set([
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_run_command",
  "computer_write_file",
]);

/**
 * 工具处理函数绝不抛错（DESIGN.md §100）。
 *
 * CopilotKit 的 `executeSpecificTool` 只有在处理函数没出错时才发起下一轮：一抛错，错误文字记成工具结果，
 * 这一轮就停在那里，没有最终回答、也没有任何提示（2026-10-17 用户截图：「做了 3 步」后什么都没有）。
 * 所以任何异常都变成 `{ ok: false, reason }` 交回去，机器人看得到、能换个办法或照实告诉用户。
 * 用户按了停止（signal 已中止）照旧抛：那一轮本来就该停，结果会被丢弃。
 */
export async function neverThrow<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T | { ok: false; reason: string }> {
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error ?? "");
    console.warn("[chisabot] frontend tool failed", message);
    return {
      ok: false,
      reason: message
        ? `这一步没有成功：${message}`
        : "这一步没有成功。",
    };
  }
}

/**
 * §102：长动作的响应先以 200 开始、结果流式写出，原来的状态码（202 等待、4xx/5xx 错误）放在正文的 `status`。
 * 普通响应没有这个字段，照旧用 HTTP 状态码。
 */
export function effectiveStatus(httpStatus: number, payload: unknown): number {
  return httpStatus === 200 &&
    payload &&
    typeof payload === "object" &&
    "status" in payload &&
    typeof (payload as { status: unknown }).status === "number"
    ? (payload as { status: number }).status
    : httpStatus;
}

/**
 * Route computer changes through the server's durable approval gate, and draw a pending decision
 * inline where the action would have been.
 *
 * EVERY CHANGE GOES THROUGH THE GATE, not only when "Ask before making changes" is on. The server
 * decides, and it can ask for reasons the browser cannot see: a team rule, a safety requirement, the
 * auto-review model. It used to read the person's switch here, and the SDK registers a tool's
 * handler once and never again (its registration effect does not depend on the handler), so the
 * handler kept the switch as it was on first render, usually still loading. Every change then went
 * straight to the computer outside any run, and the gate could only answer "this action needs an
 * authenticated run". Nothing in this handler may depend on render-time state for that reason.
 */
export function useFrontendTool<T extends Record<string, unknown>>(
  tool: ReactFrontendTool<T>,
) {
  const { copilotkit } = useCopilotKit();
  // Stable for the provider's life, so the SDK's once-registered handler may keep it.
  const queryClient = useQueryClient();
  const bot = useActiveBotHolder();
  const render = tool.render;
  useSDKFrontendTool({
    ...tool,
    ...(writes.has(tool.name)
      ? {
          // A component, so the approval card can use hooks; the SDK keeps this function forever.
          render: (props: RenderProps) => {
            const Original = render as
              | ((props: RenderProps) => ReactNode)
              | undefined;
            return (
              <InlineApproval
                toolCallId={props.toolCallId}
                fallback={Original ? <Original {...props} /> : null}
              />
            );
          },
        }
      : {}),
    handler: tool.handler
      ? async (args, context) => {
          if (backendOwnsFrontendCall(context) && context.agent) {
            markApprovalPause();
            copilotkit.stopAgent({ agent: context.agent });
            return undefined;
          }
          /*
           * 工具在浏览器里跑，这一轮就没有 SSE 进展可看：`computer_run_command` 最长 600 秒，中间没有任何
           * 事件。开始 / 结束各打一次点，让发送看门狗知道「在动」，而不是到点把它掐掉
           * （frontend-tool-activity.ts 记着 2026-10-20 那次「运行命令 一直失败」）。
           */
          const done = beginFrontendTool();
          // CB-101：这次工具调用里发出的计算机请求带上对话 / 轮次 / 工具调用 id，服务端据此记活动。
          const releaseMeta = setComputerCallMeta(frontendCallMeta(context));
          try {
            return await neverThrow(context.signal, async () => {
              // 这次调用属于哪段对话的机器人（§101），不是「现在看着的」那个。
              const runBot = botForAgent(context.agent) ?? bot.current;
              if (!writes.has(tool.name))
                return withRunBot(bot, runBot, () => tool.handler?.(args, context));
              let snapshot: ReturnType<typeof frontendApprovalSnapshot>;
              try {
                snapshot = frontendApprovalSnapshot(context);
              } catch {
                // A surface with no observed conversation. The server still gates the action; it can
                // run it when nothing asks, and says why when something does.
                return withRunBot(bot, runBot, () => tool.handler?.(args, context));
              }
              const response = await tryClient(
                `/api/approvals/computer/${encodeURIComponent(runBot)}`,
                {
                  method: "POST", body: snapshot, signal: context.signal,
                  // Leave room for approval evaluation plus the server's 615s command backstop.
                  // This deadline and Stop both apply while the heartbeat response is consumed.
                  timeoutMs: 660_000,
                },
              );
              const payload: unknown = await response.json();
              /*
               * §102：动作跑得久（长命令）时服务器先回 200 再流式写结果，等待 / 错误的状态码写在正文的 `status` 里。
               * 这里按正文还原成原来的状态，后面的判断不用变。
               */
              const status = effectiveStatus(response.status, payload);
              const ok = status >= 200 && status < 300;
              if (status === 202) {
                const kind =
                  payload && typeof payload === "object" && "kind" in payload && typeof payload.kind === "string"
                    ? payload.kind
                    : "approval";
                // 只有审批会在决定之后接上这一轮。别的等待（例如等人交还计算机）没有东西会接上：
                // 以前这里一样 stopAgent，用户只看到机器人说了一句就再没下文（2026-10-13）。
                // 现在把原因作为工具结果交回去，让机器人把话说完。
                if (!kind.startsWith("approval")) {
                  const reason =
                    payload && typeof payload === "object" && "reason" in payload && typeof payload.reason === "string"
                      ? payload.reason
                      : "";
                  return {
                    ok: false,
                    reason: `没有执行，需要用户先处理右栏「计算机」里的请求（${reason || kind}）。如实告诉用户，不要说已经完成。`,
                  };
                }
                if (!context.agent) throw new Error("中断的对话不可用。");
                markApprovalPause();
                // Stop signals the SDK to discard this handler's unfinished result. The server owns
                // resume: the decision executes the action once and continues this conversation.
                copilotkit.stopAgent({ agent: context.agent });
                // Draw the card now rather than on the inbox's next poll.
                void queryClient.invalidateQueries({ queryKey: ["approvals"] });
                return { waiting: true };
              }
              if (!ok) {
                const error =
                  payload &&
                  typeof payload === "object" &&
                  "error" in payload &&
                  typeof payload.error === "string"
                    ? payload.error
                    : "";
                // 交回一个「没做成」的结果而不是抛错：抛错会让 CopilotKit 不再发起下一轮，这一轮静默结束（§100）。
                return {
                  ok: false,
                  reason: error || `计算机操作没有成功（HTTP ${status}）。`,
                  ...(status === 400 || status === 403 ? { refused: true } : {}),
                };
              }
              if (!payload || typeof payload !== "object" || !("result" in payload))
                return { ok: false, reason: "计算机操作没有返回结果。" };
              return payload.result;
            });
          } finally {
            done();
            releaseMeta();
          }
        }
      : undefined,
  });
}
