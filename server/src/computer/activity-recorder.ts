/**
 * 把 gateway 包一层，每个计算机动作写一条「活动」（CB-101）。
 *
 * 为什么在 gateway 这一层：浏览器、文件、命令，不管是网页里的前端工具（routes.ts）、审批后服务端执行
 * （approvals）、还是 Hermes / 无头运行（headless-tools.ts），都要经过它。一处埋点就全覆盖，不用每个
 * handler 各记一遍（以前前端各自 recordActivity，浏览器操作一条都没记）。
 *
 * 归属（哪段对话、哪一轮、哪次工具调用）来自两处：路由中间件按请求头放进 AsyncLocalStorage 的
 * `ActivityScope`，以及服务端执行时已有的审批上下文（currentApprovalContext）。
 *
 * 记录失败绝不影响动作：每次写库都 catch，只打日志。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ApprovalRefusedError,
  currentApprovalContext,
} from "../approvals/types";
import {
  clip,
  isSensitiveField,
  looksLikeSecret,
  MASK,
  redactText,
  redactUrl,
} from "./activity-redact";
import {
  type ActivityKind,
  type ActivityStore,
  activityStore,
  type FinishInput,
} from "./activity-store";
import {
  CaptureBusyError,
  ComputerUnavailableError,
  HumanHasControlError,
  NavigationRefusedError,
  PageTimeoutError,
  WorkspaceRefusedError,
} from "./client";
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGateway,
} from "./gateway";
import { HeadlessToolSuspension } from "./headless-tools";
import type { PageFrameStore } from "./page-frames";

export type ActivityScope = {
  threadId?: string | null;
  runId?: string | null;
  toolCallId?: string | null;
  /** 发起请求的人（路由里的 session）。 */
  actorUserId?: string | null;
  /** /human/* 路由：人自己在操作。 */
  human?: boolean;
  /** 这次请求 / 工具调用已经记过一步，后面顺带的截图、读取不再另记。 */
  recorded?: boolean;
};

const scopes = new AsyncLocalStorage<ActivityScope>();

export function withActivityScope<T>(scope: ActivityScope, run: () => T): T {
  return scopes.run(scope, run);
}

export function currentActivityScope(): ActivityScope | undefined {
  return scopes.getStore();
}

const OUTPUT_LIMIT = 16 * 1024;

type Plan = {
  kind: ActivityKind;
  subject: string;
  detail?: Record<string, unknown>;
  /** 只在带工具调用 id 的上下文里记（截图、快照、读页面这类读操作，界面轮询也会调）。 */
  needsToolCall?: boolean;
  human?: boolean;
  /** 结束后补一张缩略图。 */
  frame?: boolean;
  finish?: (result: unknown) => Partial<FinishInput>;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

/** 失败原因 → 状态。拒绝和超时单独标出来，不只是「失败」。 */
export function classifyError(
  error: unknown,
): Pick<FinishInput, "status" | "refusalReason"> & { message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HumanHasControlError)
    return { status: "refused", refusalReason: "user_in_control", message };
  if (error instanceof HeadlessToolSuspension)
    return { status: "refused", refusalReason: "awaiting_approval", message };
  if (error instanceof ActionRefusedError)
    return { status: "refused", refusalReason: "policy_denied", message };
  if (error instanceof NavigationRefusedError)
    return { status: "refused", refusalReason: "site_blocked", message };
  if (error instanceof WorkspaceRefusedError)
    return { status: "refused", refusalReason: "workspace_refused", message };
  if (error instanceof ApprovalRefusedError)
    return { status: "refused", refusalReason: "approval_denied", message };
  if (error instanceof PageTimeoutError) return { status: "timeout", message };
  if (error instanceof CaptureBusyError)
    return { status: "failed", refusalReason: "live_cast", message };
  if (error instanceof ComputerUnavailableError && /control/i.test(message))
    return { status: "refused", refusalReason: "user_in_control", message };
  if (error instanceof DOMException && error.name === "AbortError")
    return { status: "cancelled", message };
  if (error instanceof Error && error.name === "AbortError")
    return { status: "cancelled", message };
  return { status: "failed", message };
}

function elementOf(
  result: unknown,
): { role?: string; name?: string } | undefined {
  const element = (result as { element?: unknown } | undefined)?.element;
  if (!element || typeof element !== "object") return undefined;
  const { role, name } = element as { role?: unknown; name?: unknown };
  return {
    ...(typeof role === "string" ? { role } : {}),
    ...(typeof name === "string" ? { name: name.slice(0, 120) } : {}),
  };
}

/** 每个 gateway 方法怎么记。返回 undefined 表示这个调用不记。 */
function planFor(method: string, args: unknown[]): Plan | undefined {
  switch (method) {
    case "navigate":
      return {
        kind: "navigate",
        subject: redactUrl(str(args[2])),
        frame: true,
        finish: (r) => navigated(r),
      };
    case "click":
      return {
        kind: "click",
        subject: "",
        frame: true,
        finish: (r) => {
          const element = elementOf(r);
          return {
            subject: element?.name ?? "",
            detail: {
              ...(element ? { element } : {}),
              url: redactUrl(str((r as { url?: unknown })?.url)),
            },
          };
        },
      };
    case "type": {
      const input = (args[2] ?? {}) as { text?: unknown; submit?: unknown };
      const text = str(input.text);
      return {
        kind: "type",
        subject: "",
        frame: true,
        finish: (r) => {
          const element = elementOf(r);
          const masked = isSensitiveField(element) || looksLikeSecret(text);
          const shown = masked ? MASK : clip(redactText(text), 200).text;
          return {
            subject: shown,
            detail: {
              ...(element ? { element } : {}),
              characters: text.length,
              masked,
              submitted: input.submit === true,
            },
          };
        },
      };
    }
    case "key": {
      const input = (args[2] ?? {}) as { key?: unknown };
      return { kind: "key", subject: str(input.key).slice(0, 40), frame: true };
    }
    case "scroll": {
      const input = (args[2] ?? {}) as { deltaY?: unknown };
      return {
        kind: "scroll",
        subject: "",
        detail: {
          deltaY: typeof input.deltaY === "number" ? input.deltaY : null,
        },
        frame: true,
      };
    }
    case "screenshot":
      return { kind: "screenshot", subject: "", needsToolCall: true };
    case "snapshot":
      return {
        kind: "snapshot",
        subject: "",
        needsToolCall: true,
        finish: (r) => ({
          detail: {
            elements: Array.isArray((r as { elements?: unknown })?.elements)
              ? (r as { elements: unknown[] }).elements.length
              : null,
            url: redactUrl(str((r as { url?: unknown })?.url)),
          },
        }),
      };
    case "read":
      return {
        kind: "read",
        subject: "",
        needsToolCall: true,
        finish: (r) => navigated(r),
      };
    case "tabAction": {
      const input = (args[2] ?? {}) as {
        action?: unknown;
        url?: unknown;
        id?: unknown;
      };
      return {
        kind: "tabs",
        subject: input.url ? redactUrl(str(input.url)) : "",
        detail: { action: str(input.action) },
        frame: true,
      };
    }
    case "humanTab": {
      const input = (args[1] ?? {}) as { action?: unknown };
      return {
        kind: "tabs",
        subject: "",
        detail: { action: str(input.action) },
        human: true,
      };
    }
    case "humanInput": {
      const input = (args[1] ?? {}) as {
        kind?: unknown;
        key?: unknown;
        deltaY?: unknown;
      };
      const kind = str(input.kind);
      if (
        kind !== "click" &&
        kind !== "type" &&
        kind !== "key" &&
        kind !== "scroll"
      )
        return undefined;
      // 人自己输入的文字一律不记内容（千咲评审第 4 项），只记「输入了文字」。
      return {
        kind,
        subject: kind === "key" ? str(input.key).slice(0, 40) : "",
        detail: kind === "type" ? { humanText: true } : {},
        human: true,
      };
    }
    case "runCommand": {
      const input = (args[2] ?? {}) as {
        command?: unknown;
        timeoutMs?: unknown;
      };
      return {
        kind: "run_command",
        subject: redactText(str(input.command)),
        finish: (r) => {
          const result = (r ?? {}) as {
            exitCode?: unknown;
            stdout?: unknown;
            stderr?: unknown;
            truncated?: unknown;
            timedOut?: unknown;
          };
          const printed = [str(result.stdout), str(result.stderr)]
            .filter(Boolean)
            .join(str(result.stdout) && str(result.stderr) ? "\n" : "");
          const exitCode =
            typeof result.exitCode === "number" ? result.exitCode : null;
          const clipped = clip(redactText(printed), OUTPUT_LIMIT);
          return {
            status:
              result.timedOut === true
                ? "timeout"
                : exitCode !== null && exitCode !== 0
                  ? "failed"
                  : "ok",
            output: clipped.text,
            outputTruncated: clipped.truncated || result.truncated === true,
            detail: {
              exitCode,
              lines: lineCount(printed),
              bytes: Buffer.byteLength(printed),
            },
          };
        },
      };
    }
    case "readFile": {
      const input = (args[2] ?? {}) as { path?: unknown };
      // 读文件只记路径和大小，不存正文。
      return {
        kind: "read_file",
        subject: str(input.path),
        finish: (r) => {
          const result = (r ?? {}) as { bytes?: unknown; truncated?: unknown };
          return {
            detail: {
              bytes: typeof result.bytes === "number" ? result.bytes : null,
            },
          };
        },
      };
    }
    case "downloadFile": {
      const input = (args[2] ?? {}) as { path?: unknown };
      return {
        kind: "download_file",
        subject: str(input.path),
        finish: (r) => ({
          detail: {
            bytes:
              typeof (r as { bytes?: unknown })?.bytes === "number"
                ? (r as { bytes: number }).bytes
                : null,
          },
        }),
      };
    }
    case "writeFile": {
      const input = (args[2] ?? {}) as {
        path?: unknown;
        append?: unknown;
        contents?: unknown;
      };
      return {
        kind: "write_file",
        subject: str(input.path),
        detail: { append: input.append === true },
        finish: (r) => ({
          detail: {
            bytes:
              typeof (r as { bytes?: unknown })?.bytes === "number"
                ? (r as { bytes: number }).bytes
                : Buffer.byteLength(str(input.contents)),
          },
        }),
      };
    }
    case "listFiles": {
      const input = (args[2] ?? {}) as { path?: unknown };
      return {
        kind: "list_files",
        subject: str(input.path),
        finish: (r) => ({
          detail: {
            entries: Array.isArray((r as { entries?: unknown })?.entries)
              ? (r as { entries: unknown[] }).entries.length
              : null,
          },
        }),
      };
    }
    case "requestSecret": {
      const input = (args[2] ?? {}) as { label?: unknown };
      return { kind: "secret", subject: str(input.label).slice(0, 120) };
    }
    case "requestHelp":
      return {
        kind: "help",
        subject: clip(redactText(str(args[2])), 300).text,
      };
    default:
      return undefined;
  }
}

function navigated(result: unknown): Partial<FinishInput> {
  const page = (result ?? {}) as {
    url?: unknown;
    title?: unknown;
    siteBlock?: unknown;
  };
  return {
    ...(page.url ? { subject: redactUrl(str(page.url)) } : {}),
    detail: {
      title: str(page.title).slice(0, 200),
      ...(page.siteBlock ? { siteBlocked: true } : {}),
    },
  };
}

const RECORDED_METHODS = new Set([
  "navigate",
  "click",
  "type",
  "key",
  "scroll",
  "screenshot",
  "snapshot",
  "read",
  "tabAction",
  "humanTab",
  "humanInput",
  "runCommand",
  "readFile",
  "downloadFile",
  "writeFile",
  "listFiles",
  "requestSecret",
  "requestHelp",
]);

/** 人连续的同类操作（一串按键、滚动）并成一行，免得一次接管刷出几百条。 */
const HUMAN_MERGE_MS = 8_000;

export type ActivityRecorderOptions = {
  store?: () => ActivityStore | undefined;
  pageFrames?: PageFrameStore;
  now?: () => number;
};

/** 包好的 gateway：方法签名不变，调用前后写活动记录。 */
export function withComputerActivity(
  gateway: ComputerGateway,
  options: ActivityRecorderOptions = {},
): ComputerGateway {
  const storeOf = options.store ?? activityStore;
  const now = options.now ?? Date.now;
  const lastHuman = new Map<
    string,
    { id: string; kind: string; at: number; count: number }
  >();

  async function captureFrame(
    store: ActivityStore,
    botId: string,
    stepId: string,
  ) {
    if (!options.pageFrames) return;
    try {
      const status = await gateway.status(botId);
      if (status.state !== "ready") return;
      const shot = await gateway.screenshot(botId);
      await options.pageFrames.save({
        computerId: botId,
        toolCallId: `activity:${stepId}`,
        url: shot.url ? redactUrl(shot.url) : "about:blank",
        frame: shot.base64,
      });
      await store.markFrame(stepId);
    } catch {
      // 缩略图只是方便回看；直播中截不了图（CaptureBusy）、电脑睡了都正常，不记失败。
    }
  }

  async function record<T>(
    method: string,
    args: unknown[],
    run: () => Promise<T>,
  ): Promise<T> {
    const store = storeOf();
    const plan = store ? planFor(method, args) : undefined;
    if (!store || !plan) return run();
    const scope = currentActivityScope();
    const approval = currentApprovalContext();
    /*
     * 归属只认调用方显式带来的那一组 id（CB-101 并发修复）：请求头带了工具调用 id 就整组用请求头的，
     * 否则整组用审批上下文（无头运行）的；两边都没有就是未归属，不按时间或「最近一次」去猜，也不把两边拼起来。
     */
    const bound = scope?.toolCallId
      ? { threadId: scope.threadId ?? null, runId: scope.runId ?? null, toolCallId: scope.toolCallId }
      : approval?.toolCallId
        ? { threadId: approval.threadId ?? null, runId: approval.runId ?? null, toolCallId: approval.toolCallId }
        : { threadId: null, runId: null, toolCallId: null };
    const toolCallId = bound.toolCallId;
    const human = plan.human === true || (scope?.human === true && !toolCallId);
    if (scope?.recorded) return run();
    if (plan.needsToolCall && !toolCallId) return run();
    // 没有工具调用 id、又不是 /human/* 的动作：界面自己发起的（地址栏、标签栏），算人的操作。
    const botId = String(args[0] ?? "default");
    const actor = (
      args[1] && typeof args[1] === "object" ? args[1] : undefined
    ) as ActionActor | undefined;
    const actorUserId = scope?.actorUserId ?? actor?.id ?? null;
    const actorKind: "agent" | "human" =
      human || !toolCallId ? "human" : "agent";
    if (scope) scope.recorded = true;

    let stepId: string | null = null;
    if (actorKind === "human") {
      const last = lastHuman.get(botId);
      const t = now();
      if (
        last &&
        last.kind === plan.kind &&
        t - last.at < HUMAN_MERGE_MS &&
        plan.kind !== "click"
      ) {
        last.at = t;
        last.count += 1;
        void store.bump(last.id, { count: last.count }).catch(() => undefined);
        return run();
      }
    }
    try {
      stepId = await store.begin({
        computerId: botId,
        threadId: actorKind === "agent" ? bound.threadId : (scope?.threadId ?? null),
        runId: actorKind === "agent" ? bound.runId : null,
        toolCallId: actorKind === "agent" ? toolCallId : null,
        actorUserId,
        actorKind,
        kind: plan.kind,
        subject: plan.subject,
        ...(plan.detail ? { detail: plan.detail } : {}),
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "computer-activity-write-failed",
          phase: "begin",
          error: String(error),
        }),
      );
    }
    if (stepId && actorKind === "human")
      lastHuman.set(botId, {
        id: stepId,
        kind: plan.kind,
        at: now(),
        count: 1,
      });

    try {
      const result = await run();
      if (stepId) {
        const extra = plan.finish?.(result) ?? {};
        const id = stepId;
        await store
          .finish(id, { status: "ok", ...extra })
          .catch((error) =>
            console.warn(
              JSON.stringify({
                type: "computer-activity-write-failed",
                phase: "finish",
                error: String(error),
              }),
            ),
          );
        if (plan.frame) void captureFrame(store, botId, id);
      }
      return result;
    } catch (error) {
      if (stepId) {
        const verdict = classifyError(error);
        await store
          .finish(stepId, {
            status: verdict.status,
            refusalReason: verdict.refusalReason ?? null,
            // 给模型的原文不进记录：拒绝只存原因代码，界面按代码写给人看的话。
            detail:
              verdict.status === "refused"
                ? {}
                : { error: clip(redactText(verdict.message), 500).text },
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  return new Proxy(gateway, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof property !== "string" ||
        typeof value !== "function" ||
        !RECORDED_METHODS.has(property)
      )
        return value;
      return (...args: unknown[]) =>
        record(property, args, () =>
          (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
        );
    },
  });
}
