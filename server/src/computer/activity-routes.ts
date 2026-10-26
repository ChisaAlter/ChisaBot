/**
 * 活动记录的路由（CB-101）：列表、单步缩略图、实时推送。
 *
 * 挂在 createComputerRoutes 的 `/:botId/*` 守卫之后，所以「能不能用这个 Bot」已经查过；这里只按
 * 当前用户过滤，别人的操作记录看不到。
 */
import type { Context, Hono, MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppVariables } from "../auth/guards";
import { type ActivityCursor, activityStore } from "./activity-store";
import { withActivityScope } from "./activity-recorder";
import type { PageFrameStore } from "./page-frames";

type Env = { Variables: AppVariables };

const ID = /^[\w:.-]{1,200}$/;

function header(context: Context<Env>, name: string): string | null {
  const value = context.req.header(name)?.trim();
  return value && ID.test(value) ? value : null;
}

/**
 * 给这次请求放好活动归属：哪段对话、哪一轮、哪次工具调用。
 *
 * 对话 id 来自浏览器，不能直接信：不是这个人在这个 Bot 上的对话就丢掉（记录仍然写，只是不挂到对话上）。
 */
export function activityScopeMiddleware(): MiddlewareHandler<Env> {
  return async (context, next) => {
    const botId = context.req.param("botId") ?? "";
    const actorId = context.var.actor?.id ?? null;
    let threadId = header(context, "x-chisabot-thread");
    const store = activityStore();
    if (threadId && (!store || !actorId || !(await store.threadOf(threadId, actorId, botId).catch(() => false)))) {
      threadId = null;
    }
    const human = /\/human\//.test(context.req.path);
    return withActivityScope(
      {
        threadId,
        runId: threadId ? header(context, "x-chisabot-run") : null,
        toolCallId: human ? null : header(context, "x-chisabot-tool-call"),
        actorUserId: actorId,
        human,
      },
      () => next(),
    );
  };
}

function cursorOf(raw: string | undefined): ActivityCursor | undefined {
  if (!raw) return undefined;
  const [at, seq] = raw.split("~");
  const number = Number(seq);
  if (!at || Number.isNaN(Date.parse(at)) || !Number.isFinite(number)) return undefined;
  return { at, seq: number };
}

export function registerActivityRoutes(routes: Hono<Env>, pageFrames?: PageFrameStore) {
  routes.get("/:botId/activity", async (context) => {
    const store = activityStore();
    if (!store) return context.json({ error: "Activity is not recorded on this deployment." }, 404);
    const botId = context.req.param("botId");
    const thread = context.req.query("thread")?.trim();
    const limit = Math.min(200, Math.max(1, Number(context.req.query("limit")) || 50));
    const page = await store.list({
      computerId: botId,
      actorUserId: context.var.actor.id,
      ...(thread && ID.test(thread) ? { threadId: thread } : {}),
      ...(cursorOf(context.req.query("before")) ? { before: cursorOf(context.req.query("before")) } : {}),
      limit,
    });
    return context.json({
      steps: page.steps,
      nextCursor: page.nextCursor ? `${page.nextCursor.at}~${page.nextCursor.seq}` : null,
      retentionDays: page.retentionDays,
    });
  });

  routes.get("/:botId/activity/stream", (context) => {
    const store = activityStore();
    if (!store) return context.json({ error: "Activity is not recorded on this deployment." }, 404);
    const botId = context.req.param("botId");
    const actorId = context.var.actor.id;
    context.header("x-accel-buffering", "no");
    context.header("cache-control", "no-cache, no-transform");
    return streamSSE(context, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = store.subscribe((event) => {
        if (event.computerId !== botId) return;
        queue.push(event.stepId);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        if (!queue.length) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 25_000);
          });
          wake = undefined;
          if (!queue.length && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        const ids = [...new Set(queue.splice(0))];
        for (const id of ids) {
          // 只推这个人自己的步骤；按 id 再查一次，顺便拿到完整的行。
          const step = await store.get(botId, actorId, id).catch(() => null);
          if (step) await stream.writeSSE({ event: "step", data: JSON.stringify(step) });
        }
      }
      unsubscribe();
    });
  });

  routes.get("/:botId/activity/:stepId/frame", async (context) => {
    const store = activityStore();
    const botId = context.req.param("botId");
    const stepId = context.req.param("stepId");
    if (!store || !pageFrames || !ID.test(stepId)) return context.json({ frame: null });
    const step = await store.get(botId, context.var.actor.id, stepId);
    if (!step) return context.json({ error: "There is no such step." }, 404);
    // 模型的步骤优先用它自己留下的那张（navigate 存的），其余用记录器补拍的。
    const stored =
      (step.hasFrame ? await pageFrames.load(botId, `activity:${stepId}`) : null) ??
      (step.toolCallId ? await pageFrames.load(botId, step.toolCallId) : null);
    return context.json({ frame: stored });
  });
}
