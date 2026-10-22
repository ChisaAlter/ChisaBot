import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { ApprovalService } from "./service";
import {
  ApprovalNotFoundError,
  ApprovalRefusedError,
  RULE_BEHAVIOURS,
} from "./types";

const pattern = z.string().trim().min(1).max(300);
/** An action class: which Bot, which tool or app, which kind of effect, and which target. */
const ruleInput = z.strictObject({
  botId: pattern.default("*"),
  toolRef: pattern,
  effect: pattern.default("*"),
  scope: pattern.default("*"),
  behaviour: z.enum(RULE_BEHAVIOURS),
});
const hostCommands = z.enum(["ask", "allow", "never"]);
/** A change to a saved rule: any of its fields, and at least one. */
const ruleChange = z
  .strictObject({
    botId: pattern,
    toolRef: pattern,
    effect: pattern,
    scope: pattern,
    behaviour: z.enum(RULE_BEHAVIOURS),
  })
  .partial()
  .refine(
    (input) => Object.keys(input).length > 0,
    "Change at least one field.",
  );

import { HeadlessToolSuspension } from "../computer/headless-tools";
import { computerFailureOutcome } from "../computer/tool-outcome";

/** §102：动作超过这么久还没结果，就先回响应头、改为带心跳的流式响应（见 POST /computer/:botId）。 */
export const LONG_ACTION_STREAM_AFTER_MS = 20_000;
/** 心跳间隔：远小于 Cloudflare 的 100 秒读超时。 */
export const LONG_ACTION_HEARTBEAT_MS = 15_000;

export function createApprovalRoutes(
  service: ApprovalService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** 测试用：长动作改流式的等待时间和心跳间隔（§102）。 */
  longAction: { streamAfterMs?: number; heartbeatMs?: number } = {},
) {
  const streamAfterMs = longAction.streamAfterMs ?? LONG_ACTION_STREAM_AFTER_MS;
  const heartbeatMs = longAction.heartbeatMs ?? LONG_ACTION_HEARTBEAT_MS;
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) =>
    // A body that is not JSON is the caller's mistake, as the delivery routes answer it, not a
    // 500 carrying the parser's message.
    error instanceof SyntaxError
      ? context.json({ error: "Supply a valid request." }, 400)
      : context.json(
          { error: error.message },
          error instanceof ApprovalNotFoundError
            ? 404
            : error instanceof ApprovalRefusedError ||
                error instanceof z.ZodError
              ? 400
              : 500,
        ),
  );
  routes.get("/", async (context) =>
    context.json(await service.inbox(context.var.actor.id)),
  );
  routes.post("/computer/:botId", async (context) => {
    const botId = context.req.param("botId");
    const input = await context.req.json();
    // This request owns only the unfinished frontend action. Approval decisions and their durable
    // continuations run through separate routes and must keep their own lifetime.
    const action = new AbortController();
    const caller = context.req.raw.signal;
    const onAbort = () => action.abort(caller.reason);
    if (caller.aborted) onAbort();
    else caller.addEventListener("abort", onAbort, { once: true });
    let beat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      caller.removeEventListener("abort", onAbort);
      clearInterval(beat);
    };
    /*
     * 结果 → 状态码 + 内容。和以前一样：200 { result }、202 { waiting… }，别的错误交给 onError 的规则。
     * 抽成一个函数，是因为长动作（§102，最长 600 秒的前台命令）要在响应已经开始之后才知道结果。
     */
    const settle = async (): Promise<{ status: 200 | 202 | 400 | 404 | 500; body: Record<string, unknown> }> => {
      try {
        return {
          status: 200,
          body: { result: await service.frontendAction(context.var.actor.id, botId, input, action.signal) },
        };
      } catch (error) {
        if (error instanceof HeadlessToolSuspension)
          return {
            status: 202,
            body: {
              waiting: true,
              // 前端据此区分：审批卡会接上这一轮；别的等待（例如交还计算机）不会，前端就不能悄悄停掉回合。
              kind: error.waiting.kind,
              approvalId: error.waiting.requestId,
              reason: error.message,
            },
          };
        // 普通的计算机失败（元素过期、下拉框没有这个选项、电脑暂时不可用…）是这一步的结果，不是 500：
        // 交回 { ok:false, reason } 让机器人接着做。抛 500 会让网页里的工具处理函数报错，CopilotKit 就不再
        // 发起下一轮，这一轮静默结束（DESIGN.md §100，2026-10-17 用户截图）。
        const outcome = computerFailureOutcome(error);
        if (outcome) return { status: 200, body: { result: outcome } };
        const message = error instanceof Error ? error.message : String(error);
        return {
          status:
            error instanceof ApprovalNotFoundError
              ? 404
              : error instanceof ApprovalRefusedError || error instanceof z.ZodError || error instanceof SyntaxError
                ? 400
                : 500,
          body: { error: error instanceof SyntaxError ? "Supply a valid request." : message },
        };
      }
    };
    const work = settle().finally(cleanup);
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const quick = await Promise.race([
      work,
      new Promise<null>((resolve) => {
        streamTimer = setTimeout(() => resolve(null), streamAfterMs);
      }),
    ]);
    clearTimeout(streamTimer);
    if (quick) return context.json(quick.body, quick.status);
    /*
     * §102：动作还在跑（多半是长命令）。浏览器直接等这个请求，中间隔着 Cloudflare：100 秒内源站一个字节
     * 都不回就 524，网页里的工具只看到一页 HTML。所以先回 200 和响应头，每 15 秒写一个空格（JSON 允许前导
     * 空白，前端照样 response.json()），结果出来再写正文。状态码已经发出去了，等待 / 错误就写进正文
     * （`status` 字段），前端按正文判断（app/src/lib/copilot/approval-tools.tsx）。
     * text/event-stream：nginx 的 gzip 不压它（不攒缓冲），Cloudflare 也按流式转发。
     */
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // A cancelled response no longer owns an executing computer action.
            action.abort();
            cleanup();
          }
        };
        write(" ");
        beat = setInterval(() => write(" "), heartbeatMs);
        void work.then((settled) => {
          clearInterval(beat);
          write(
            JSON.stringify(
              settled.status === 200 ? settled.body : { ...settled.body, status: settled.status },
            ),
          );
          try {
            controller.close();
          } catch {}
        });
      },
      cancel(reason) {
        // Bun can surface a disconnected streaming response here as well as on request.signal.
        action.abort(reason);
        cleanup();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
        "x-chisabot-long-action": "1",
      },
    });
  });
  routes.patch("/preferences", async (context) => {
    const input = z
      .strictObject({
        enabled: z.boolean().optional(),
        autoReview: z.boolean().optional(),
        hostCommands: hostCommands.optional(),
      })
      .parse(await context.req.json());
    if (!service.store.policy) {
      if (input.enabled === undefined)
        throw new ApprovalRefusedError("Choose whether to ask first.");
      await service.store.setEnabled(context.var.actor.id, input.enabled);
      return context.json({ enabled: input.enabled });
    }
    return context.json(
      await service.setPreferences(context.var.actor.id, input),
    );
  });
  routes.post("/rules", async (context) =>
    context.json(
      {
        rule: await service.createRule(
          context.var.actor.id,
          ruleInput.parse(await context.req.json()),
        ),
      },
      201,
    ),
  );
  routes.patch("/rules/:id", async (context) =>
    context.json({
      rule: await service.updateRule(
        context.var.actor.id,
        context.req.param("id"),
        ruleChange.parse(await context.req.json()),
      ),
    }),
  );
  /** Team rules and settings. Members read them as locked rows in the inbox; only admins change them. */
  routes.patch("/team", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const input = z
      .strictObject({
        enforceAutoReview: z.boolean().optional(),
        customRulesEnabled: z.boolean().optional(),
        hostCommandsCap: hostCommands.optional(),
      })
      .parse(await context.req.json());
    return context.json(
      await service.setTeamSettings(context.var.actor.id, input),
    );
  });
  routes.post("/team/rules", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json(
      {
        rule: await service.createTeamRule(
          context.var.actor.id,
          ruleInput.parse(await context.req.json()),
        ),
      },
      201,
    );
  });
  routes.patch("/team/rules/:id", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    return context.json({
      rule: await service.updateTeamRule(
        context.var.actor.id,
        context.req.param("id"),
        ruleChange.parse(await context.req.json()),
      ),
    });
  });
  routes.delete("/team/rules/:id", async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await service.revokeTeamRule(context.var.actor.id, context.req.param("id"));
    return context.json({ revoked: true });
  });
  routes.post("/questions/:id/respond", async (context) => {
    const input = z
      .strictObject({ response: z.string().trim().min(1).max(6000) })
      .parse(await context.req.json());
    return context.json(
      await service.answerQuestion(
        context.var.actor.id,
        context.req.param("id"),
        input.response,
      ),
    );
  });
  routes.post("/questions/:id/dismiss", async (context) =>
    context.json(
      await service.dismissQuestion(
        context.var.actor.id,
        context.req.param("id"),
      ),
    ),
  );
  routes.post("/:id/decision", async (context) => {
    const input = z
      .strictObject({
        decision: z.enum(["allow_once", "allow_always", "deny", "handled"]),
      })
      .parse(await context.req.json());
    const request = await service.decide(
      context.var.actor.id,
      context.req.param("id"),
      input.decision,
    );
    return context.json({ id: request.id, status: request.status });
  });
  routes.delete("/rules/:id", async (context) => {
    await service.revoke(context.var.actor.id, context.req.param("id"));
    return context.json({ revoked: true });
  });
  return routes;
}
