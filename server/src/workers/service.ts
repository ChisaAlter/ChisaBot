import { describeWorkerStep } from "../../../shared/work-step";
import { randomUUID } from "node:crypto";
import { EventType, type BaseEvent, type Message } from "@ag-ui/client";
import { z } from "zod";
import type { Database } from "../db/client";
import { LocalConversationError, type LocalRunControl, type ThreadWorkerRoutes } from "../local-conversations";
import type { GrantedTool } from "../plugins/tools";
import { HeadlessToolSuspension, type HeadlessTool } from "../computer/headless-tools";
import type { TurnRunner } from "../turns/types";
import { type ThreadInbox, WORKER_RESULT_MARKER } from "../thread-inbox";
import { reasonWithoutStatement } from "../db/query-failure";

/**
 * 后台任务（DESIGN.md §38）：机器人把一件耗时、独立的事交给一个并行的「工人」去做，主对话继续能聊。
 *
 * - 工人就是同一个机器人在一个**单独的隐藏对话**（`worker-<id>`）里跑的一轮无头回合：同样的工具
 *   （少了委派，多了 `worker_plan` 维护清单），同样的权限、审批和审计；对话记录存下来，出了事能查。
 * - 并发有上限：每人同时最多 {@link PER_USER_RUNNING} 个在跑，全站 {@link GLOBAL_RUNNING} 个，其余排队；
 *   每人最多 {@link PER_USER_BACKLOG} 个没结束的。每个工人的回合有超时（{@link WORKER_TIMEOUT_MS}），
 *   结果截断到 {@link RESULT_LIMIT} 字，内存里只留卡片要显示的几行状态。
 * - 补充说明 = 往工人的对话收件箱里放一条消息，下一步读进去（thread-inbox.ts，和主对话插话同一套）。
 * - 结束后结果作为一条消息回到发起的对话：那边正在回答就进收件箱（下一步读到），没在回答就起一轮
 *   无头回合，让主机器人用一两句话告诉用户结果。
 * - 服务重启：没跑完的标成失败并写明原因，不会一直显示「运行中」。
 */
export type WorkerStatus = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
export type WorkerPlanStep = { text: string; status: "done" | "current" | "pending" | "blocked" };
export type WorkerView = {
  id: string; title: string; status: WorkerStatus; step: string | null; plan: WorkerPlanStep[];
  summary: string | null; error: string | null; resultMessageId: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
};

type WorkerRow = {
  id: string; owner_user_id: string; parent_thread_id: string; agent_id: string; thread_id: string;
  title: string; task: string; status: WorkerStatus; plan: WorkerPlanStep[]; step: string | null;
  result: string | null; error: string | null; result_message_id: string | null;
  created_at: Date | string; started_at: Date | string | null; finished_at: Date | string | null;
};

export const PER_USER_RUNNING = Number(process.env.CHISABOT_WORKERS_PER_USER) || 3;
export const GLOBAL_RUNNING = Number(process.env.CHISABOT_WORKERS_GLOBAL) || 6;
export const PER_USER_BACKLOG = 6;
export const WORKER_TIMEOUT_MS = 15 * 60_000;
export const RESULT_LIMIT = 6_000;
const ACTIVE: WorkerStatus[] = ["queued", "running", "waiting"];
/** 用户在卡片上停掉的任务交回对话时的说明（结果行展开后看到的就是这句）。 */
export const CANCELLED_BY_USER = "你在任务卡片上停止了这个任务，它没有做完。需要的话可以让我重新做。";

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

// 工具调用 → 「当前步骤」那一行：和主对话的干活卡（DESIGN.md §70）共用一份，在 shared/work-step.ts。
export { describeWorkerStep };

/** 卡片上开头那一行：清单里正在做的那一步，没有清单就说在看任务。 */
export function initialStep(plan: readonly WorkerPlanStep[]): string {
  const current = plan.find((step) => step.status === "current") ?? plan.find((step) => step.status === "pending");
  return current ? clip(current.text, 40) : "正在看任务要求";
}

/** 交给模型的任务说明：它是在后台、没人看着，结束时的最后一段话就是交回去的结果。 */
export function frameWorkerTask(title: string, task: string) {
  return [
    `你现在是后台任务「${title}」的执行者。主对话里的你把这件事交给了你，用户此刻不在看这个对话。`,
    "做法：",
    "1. 先调一次 worker_plan，列出 3–6 个简短步骤（中文，每步十个字左右）；每完成一步或换到下一步时再调它更新状态。",
    "2. 独立把事情做完，不要问用户问题；真的缺了做不下去的信息，就把能做的做完，在结果里写清楚缺什么。",
    "3. 过程中可能收到「补充说明」消息，那是用户通过主对话发来的，照着调整。",
    "4. 最后用一段话交回结果：先给结论 / 数据 / 链接，再列关键依据和来源；不要寒暄，不要说「希望有帮助」。",
    "",
    "任务：",
    task,
  ].join("\n");
}

function view(row: WorkerRow, live?: { step?: string | null; plan?: WorkerPlanStep[] }): WorkerView {
  return {
    id: row.id, title: row.title, status: row.status,
    step: live?.step !== undefined ? live.step : row.step,
    plan: live?.plan ?? row.plan ?? [],
    summary: row.result ? clip(row.result.replace(/\s+/g, " ").trim(), 160) : null,
    error: row.error, resultMessageId: row.result_message_id,
    createdAt: iso(row.created_at)!, startedAt: iso(row.started_at), finishedAt: iso(row.finished_at),
  };
}

export type WorkerServiceOptions = {
  database: Database;
  inbox: ThreadInbox;
  control: LocalRunControl;
  /** 跑一轮无头回合（工人自己的、交付结果给主对话的都用它）。 */
  runTurn: TurnRunner;
  /** 交付结果那一轮用的回合（主对话的机器人，普通工具）。不给就用 runTurn。 */
  deliverTurn?: TurnRunner;
  /** 主对话属于哪个机器人（交付结果时起回合要用）。 */
  agentOfThread: (threadId: string) => Promise<string | null>;
};

export type WorkerService = ThreadWorkerRoutes & {
  ensure(): Promise<void>;
  recover(): Promise<number>;
  /** 主对话里的机器人可以用的工具（委派、发补充说明、停止、看状态）。 */
  delegationTools(input: { ownerUserId: string; agentId: string; threadId: string }): GrantedTool[];
  /** 工人回合里额外给的工具（维护清单）。 */
  workerTools(workerId: string): HeadlessTool[];
  start(input: { ownerUserId: string; agentId: string; parentThreadId: string; title: string; task: string; plan?: string[] }): Promise<WorkerView>;
  get(workerId: string): Promise<WorkerView | null>;
  updatePlan(workerId: string, steps: WorkerPlanStep[]): Promise<void>;
  /** 删机器人前：停掉它还在跑 / 排队的后台任务（不交付结果）。返回停了几个。 */
  stopForAgent(agentId: string): Promise<number>;
  /** 清掉孤儿行：机器人已经不存在的后台任务记录、对话已经不存在的收件箱行（超过一小时的）。 */
  sweepOrphans(): Promise<{ workers: number; inbox: number }>;
};

export function createWorkerService(options: WorkerServiceOptions): WorkerService {
  const { database, inbox, control, runTurn } = options;
  const deliverTurn = options.deliverTurn ?? runTurn;
  const sql = database.$client;
  type LiveState = { step?: string | null; initialStep?: string; plan?: WorkerPlanStep[]; controller: AbortController; unobserve?: () => void; flush?: ReturnType<typeof setTimeout> };
  const live = new Map<string, LiveState>();
  let pumping = false;

  const row = async (id: string) => (await sql.unsafe<WorkerRow[]>("SELECT * FROM chisabot_workers WHERE id = $1", [id]))[0] ?? null;
  const owned = async (id: string, actorId: string, threadId?: string) => {
    const found = await row(id);
    if (!found || found.owner_user_id !== actorId || (threadId && found.parent_thread_id !== threadId)) throw new LocalConversationError("后台任务不存在", 404);
    return found;
  };

  const lastAssistantText = async (threadId: string): Promise<string | null> => {
    const rows = await sql.unsafe<{ messages: Message[] }[]>("SELECT messages FROM openbot_local_threads WHERE id = $1", [threadId]);
    const messages = rows[0]?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!;
      if (message.role === "user") break;
      if (message.role === "assistant" && textOfContent(message).trim()) return textOfContent(message);
    }
    return null;
  };

  const persistLive = (id: string) => {
    const state = live.get(id);
    if (!state || state.flush) return;
    state.flush = setTimeout(() => {
      state.flush = undefined;
      void sql.unsafe(
        "UPDATE chisabot_workers SET step = $2, plan = $3::text::jsonb, updated_at = now() WHERE id = $1",
        [id, state.step ?? null, JSON.stringify(state.plan ?? [])],
      ).catch(() => {});
    }, 800);
  };

  const finish = async (id: string, status: WorkerStatus, fields: { result?: string | null; error?: string | null }) => {
    const state = live.get(id);
    state?.unobserve?.();
    if (state?.flush) clearTimeout(state.flush);
    live.delete(id);
    const rows = await sql.unsafe<WorkerRow[]>(
      `UPDATE chisabot_workers SET status = $2, result = $3, error = $4, finished_at = now(), updated_at = now(),
       step = $5, plan = coalesce($6::text::jsonb, plan)
       WHERE id = $1 AND status IN ('queued', 'running', 'waiting') RETURNING *`,
      [id, status, fields.result ?? null, fields.error ?? null, null, state?.plan ? JSON.stringify(state.plan) : null],
    );
    return rows[0] ?? null;
  };

  const statusZh = (status: WorkerStatus) => (status === "done" ? "已完成" : status === "failed" ? "没有完成" : status === "waiting" ? "在等你确认" : "已停止");

  /** 结果回到主对话。 */
  const deliver = async (worker: WorkerRow) => {
    const messageId = `worker-result-${worker.id}`;
    // 工人和主机器人读同一份提示词，见过标记的样子，偶尔会在自己的结果里也写一个「⟦chisabot:…⟧」：
    // 剥掉，免得界面把它原样画出来、主机器人把它当成又一条结果（实测 2026-10-13）。
    const body = stripWorkerMarkers(worker.status === "done" ? worker.result || "（没有文字结果）" : worker.error || "（没有说明原因）") || "（没有文字结果）";
    const message = {
      id: messageId, role: "user",
      content: `${WORKER_RESULT_MARKER}${worker.id}:${worker.status}⟧\n后台任务「${worker.title}」${statusZh(worker.status)}。\n\n${clip(body, RESULT_LIMIT)}`,
    } as Message;
    await sql.unsafe("UPDATE chisabot_workers SET result_message_id = $2 WHERE id = $1", [worker.id, messageId]);
    const enqueue = () => inbox.enqueue({ threadId: worker.parent_thread_id, ownerUserId: worker.owner_user_id, message, kind: "worker_result" });
    if (control.isActive(worker.parent_thread_id)) {
      await enqueue();
      // 入队和那一轮结束之间的空当：那一轮刚好结束了就自己起一轮。
      if (control.isActive(worker.parent_thread_id)) return;
    }
    const agentId = (await options.agentOfThread(worker.parent_thread_id)) ?? worker.agent_id;
    try {
      await inbox.withdraw(worker.parent_thread_id, messageId);
      await deliverTurn({
        ownerUserId: worker.owner_user_id, routineId: `worker:${worker.id}`, agentId,
        threadId: worker.parent_thread_id, instruction: textOfContent(message),
        initiator: { kind: "routine", id: `worker:${worker.id}` },
        userMessage: message, forwardedProps: { chisabotWorkerDelivery: { id: worker.id } },
      });
    } catch (error) {
      // 对话刚好被用户占着（锁）或者回合失败：放进收件箱，下一轮一定读到，不丢。
      console.warn(JSON.stringify({ type: "worker-delivery-queued", worker: worker.id, reason: reasonWithoutStatement(error) }));
      await sql.unsafe("UPDATE chisabot_thread_inbox SET status = 'queued', updated_at = now() WHERE thread_id = $1 AND id = $2", [worker.parent_thread_id, messageId]);
      await enqueue().catch(() => {});
    }
  };

  const launch = async (worker: WorkerRow) => {
    const controller = new AbortController();
    // 卡片一出来就有一句有意义的当前步骤（以前前几秒一直是「正在准备」）：有初步清单就用正在做的那一步，
    // 没有就说在看任务；之后第一次工具调用 / 清单更新 / 开口说话会换掉它。
    const firstStep = initialStep(worker.plan ?? []);
    const state: LiveState = { controller, step: firstStep, initialStep: firstStep, plan: worker.plan ?? [] };
    live.set(worker.id, state);
    await sql.unsafe("UPDATE chisabot_workers SET status = 'running', started_at = now(), step = $2, updated_at = now() WHERE id = $1", [worker.id, state.step]);
    const calls = new Map<string, { name: string; args: string }>();
    state.unobserve = control.observe(worker.thread_id, (event: BaseEvent) => {
      const e = event as BaseEvent & { toolCallId?: string; toolCallName?: string; delta?: string; role?: string };
      if (e.type === EventType.TOOL_CALL_START && e.toolCallId) calls.set(e.toolCallId, { name: e.toolCallName ?? "", args: "" });
      else if (e.type === EventType.TOOL_CALL_ARGS && e.toolCallId) { const call = calls.get(e.toolCallId); if (call) call.args += e.delta ?? ""; }
      else if (e.type === EventType.TOOL_CALL_END && e.toolCallId) {
        const call = calls.get(e.toolCallId);
        if (!call) return;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.args || "{}"); } catch { /* 参数不是 JSON：只按名字描述。 */ }
        const line = describeWorkerStep(call.name, args);
        if (line) { state.step = line; persistLive(worker.id); }
      } else if (e.type === EventType.TEXT_MESSAGE_START && (e.role ?? "assistant") === "assistant" && state.step === state.initialStep && !state.plan?.length) {
        // 只在还没做任何事、也没有清单时换掉开头那句；之后的过程话不覆盖上一步（一步一行，不闪）。
        state.step = "正在想怎么做"; persistLive(worker.id);
      }
    });
    const timer = setTimeout(() => controller.abort(new Error("timeout")), WORKER_TIMEOUT_MS);
    timer.unref?.();
    let finished: WorkerRow | null = null;
    try {
      const outcome = await runTurn({
        ownerUserId: worker.owner_user_id, routineId: `worker:${worker.id}`, agentId: worker.agent_id,
        threadId: worker.thread_id, instruction: worker.task,
        initiator: { kind: "routine", id: `worker:${worker.id}` },
        signal: controller.signal,
        userMessage: { id: `worker-task-${worker.id}`, role: "user", content: frameWorkerTask(worker.title, worker.task) } as Message,
        forwardedProps: { chisabotWorker: { id: worker.id } },
      });
      // 交回的结果 = 工人最后一条有字的回复（过程话不算）；读不到再退回整轮的文字。
      const text = ((await lastAssistantText(worker.thread_id)) ?? outcome.replyText).trim();
      if (state.plan?.length) state.plan = state.plan.map((step) => (step.status === "current" || step.status === "pending" ? { ...step, status: "done" } : step));
      finished = await finish(worker.id, "done", { result: clip(text || "（任务做完了，但没有写结果。）", RESULT_LIMIT) });
    } catch (error) {
      const current = await row(worker.id);
      if (current?.status === "cancelled") finished = null;
      else if (error instanceof HeadlessToolSuspension) {
        finished = await finish(worker.id, "failed", { error: `需要你确认一个操作才能继续（${error.message}）。请在「审批」里处理后，让我重新做这件事。` });
      } else if (controller.signal.aborted && String(controller.signal.reason).includes("timeout")) {
        finished = await finish(worker.id, "failed", { error: `超过 ${WORKER_TIMEOUT_MS / 60_000} 分钟还没做完，已停止。` });
      } else {
        finished = await finish(worker.id, "failed", { error: error instanceof Error ? clip(error.message, 400) : "后台任务出错了。" });
      }
    } finally {
      clearTimeout(timer);
      const left = live.get(worker.id);
      left?.unobserve?.();
      live.delete(worker.id);
    }
    if (finished) await deliver(finished).catch((error) => console.warn("worker delivery failed", error));
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const queued = await sql.unsafe<WorkerRow[]>("SELECT * FROM chisabot_workers WHERE status = 'queued' ORDER BY created_at LIMIT 50");
        if (!queued.length) return;
        const running = await sql.unsafe<{ owner_user_id: string; n: number }[]>(
          "SELECT owner_user_id, count(*)::int AS n FROM chisabot_workers WHERE status IN ('running', 'waiting') GROUP BY owner_user_id",
        );
        const per = new Map(running.map((item) => [item.owner_user_id, item.n]));
        let total = running.reduce((sum, item) => sum + item.n, 0);
        let launched = false;
        for (const worker of queued) {
          if (total >= GLOBAL_RUNNING) return;
          if ((per.get(worker.owner_user_id) ?? 0) >= PER_USER_RUNNING) continue;
          const claimed = await sql.unsafe("UPDATE chisabot_workers SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING id", [worker.id]);
          if (!claimed.length) continue;
          per.set(worker.owner_user_id, (per.get(worker.owner_user_id) ?? 0) + 1);
          total++;
          launched = true;
          void launch(worker).finally(() => void pump());
        }
        if (!launched) return;
      }
    } finally {
      pumping = false;
    }
  };

  const service: WorkerService = {
    async ensure() {
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_workers (
        id text PRIMARY KEY, owner_user_id text NOT NULL, parent_thread_id text NOT NULL, agent_id text NOT NULL,
        thread_id text NOT NULL, title text NOT NULL, task text NOT NULL, status text NOT NULL,
        plan jsonb NOT NULL DEFAULT '[]'::jsonb, step text, result text, error text, result_message_id text,
        created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await sql.unsafe("CREATE INDEX IF NOT EXISTS chisabot_workers_parent ON chisabot_workers(parent_thread_id, created_at)");
      await sql.unsafe("CREATE INDEX IF NOT EXISTS chisabot_workers_status ON chisabot_workers(status, created_at)");
    },

    async recover() {
      const rows = await sql.unsafe(
        `UPDATE chisabot_workers SET status = 'failed', finished_at = now(), updated_at = now(), step = NULL,
         error = CASE WHEN status = 'queued' THEN '服务重启了，这个任务还没开始就被取消了。可以让我重新做。'
                      ELSE '服务重启了，任务做到一半被中断（没有完成）。可以让我重新做。' END
         WHERE status IN ('queued', 'running', 'waiting') RETURNING id`,
      );
      return rows.length;
    },

    async start(input) {
      const title = clip(input.title.trim() || "后台任务", 40);
      const task = input.task.trim();
      if (!task) throw new Error("任务说明是空的。");
      const backlog = await sql.unsafe<{ n: number }[]>(
        "SELECT count(*)::int AS n FROM chisabot_workers WHERE owner_user_id = $1 AND status IN ('queued', 'running', 'waiting')", [input.ownerUserId],
      );
      if ((backlog[0]?.n ?? 0) >= PER_USER_BACKLOG) throw new Error(`后台已经有 ${PER_USER_BACKLOG} 个任务没做完，等其中一个结束再委派。`);
      const id = randomUUID();
      const plan = (input.plan ?? []).filter((text) => typeof text === "string" && text.trim()).slice(0, 8)
        .map((text, index) => ({ text: clip(text.trim(), 40), status: index === 0 ? "current" : "pending" }) as WorkerPlanStep);
      const rows = await sql.unsafe<WorkerRow[]>(
        `INSERT INTO chisabot_workers (id, owner_user_id, parent_thread_id, agent_id, thread_id, title, task, status, plan)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8::text::jsonb) RETURNING *`,
        [id, input.ownerUserId, input.parentThreadId, input.agentId, `worker-${id}`, title, clip(task, 8_000), JSON.stringify(plan)],
      );
      void pump();
      return view(rows[0]!);
    },

    async get(id) {
      const found = await row(id);
      return found ? view(found, live.get(id)) : null;
    },

    async updatePlan(id, steps) {
      const clean = steps.slice(0, 10).map((step) => ({
        text: clip(String(step.text ?? "").trim(), 40),
        status: (["done", "current", "pending", "blocked"] as const).includes(step.status) ? step.status : "pending",
      })).filter((step) => step.text);
      const state = live.get(id);
      if (state) {
        state.plan = clean;
        // 还停在开头那句（没调过别的工具）：换成清单里正在做的那一步。
        if (state.step === state.initialStep) state.step = state.initialStep = initialStep(clean);
        persistLive(id);
      }
      else await sql.unsafe("UPDATE chisabot_workers SET plan = $2::text::jsonb, updated_at = now() WHERE id = $1", [id, JSON.stringify(clean)]);
    },

    async list(threadId, actorId) {
      const rows = await sql.unsafe<WorkerRow[]>(
        "SELECT * FROM chisabot_workers WHERE parent_thread_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC LIMIT 20", [threadId, actorId],
      );
      return rows.reverse().map((found) => view(found, live.get(found.id)));
    },

    async steer(threadId, workerId, actorId, text) {
      const found = await owned(workerId, actorId, threadId);
      if (found.status === "queued") {
        await sql.unsafe("UPDATE chisabot_workers SET task = task || $2, updated_at = now() WHERE id = $1", [workerId, `\n\n补充说明：${text}`]);
        return;
      }
      if (found.status !== "running") throw new LocalConversationError("这个任务已经结束了", 409);
      await inbox.enqueue({ threadId: found.thread_id, ownerUserId: actorId, message: { id: randomUUID(), role: "user", content: `补充说明（用户通过主对话发来）：${text}` } as Message });
    },

    async cancel(threadId, workerId, actorId, options) {
      const found = await owned(workerId, actorId, threadId);
      if (!ACTIVE.includes(found.status)) return;
      const announce = !options?.quiet;
      // 要补「已停止」的：同一句里就写上交回消息的 id，卡片 / 页面立刻知道要等这条消息（不和交付抢）。
      const stopped = await sql.unsafe<WorkerRow[]>(
        `UPDATE chisabot_workers SET status = 'cancelled', finished_at = now(), updated_at = now(), step = NULL, error = $2,
         result_message_id = CASE WHEN $3::boolean THEN 'worker-result-' || id ELSE result_message_id END
         WHERE id = $1 AND status IN ('queued', 'running', 'waiting') RETURNING *`,
        [workerId, announce ? CANCELLED_BY_USER : null, announce],
      );
      const state = live.get(workerId);
      state?.controller.abort(new Error("cancelled"));
      await control.stop({ threadId: found.thread_id }).catch(() => false);
      void pump();
      // 用户在卡片上点的停止：主机器人前面说过「做完会把结果发到这里」，不补一句就成了没下文的承诺
      // （实测 2026-10-13）。走和结果同一条路：对话里出现一行「后台任务「x」已停止」，主机器人一句话确认。
      if (announce && stopped[0]) void deliver(stopped[0]).catch((error) => console.warn("worker stop notice failed", error));
    },

    async stopForAgent(agentId) {
      const rows = await sql.unsafe<{ id: string; thread_id: string }[]>(
        `UPDATE chisabot_workers SET status = 'cancelled', finished_at = now(), updated_at = now(), step = NULL
         WHERE agent_id = $1 AND status IN ('queued', 'running', 'waiting') RETURNING id, thread_id`,
        [agentId],
      );
      for (const stopped of rows) {
        live.get(stopped.id)?.controller.abort(new Error("cancelled"));
        await control.stop({ threadId: stopped.thread_id }).catch(() => false);
      }
      return rows.length;
    },

    async sweepOrphans() {
      const workers = await sql.unsafe(
        "DELETE FROM chisabot_workers w WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = w.agent_id) AND w.status NOT IN ('queued', 'running', 'waiting') RETURNING id",
      );
      const inbox = await sql.unsafe(
        `DELETE FROM chisabot_thread_inbox i WHERE i.updated_at < now() - interval '1 hour'
         AND NOT EXISTS (SELECT 1 FROM openbot_local_threads t WHERE t.id = i.thread_id) RETURNING id`,
      );
      return { workers: workers.length, inbox: inbox.length };
    },

    workerTools(workerId) {
      return [{
        definition: {
          name: "worker_plan",
          description: "更新这个后台任务的步骤清单（用户在主对话的任务卡片上看到）。每次传完整清单；status: done 已完成 / current 正在做 / pending 未开始 / blocked 卡住了。",
          parameters: {
            type: "object",
            properties: {
              steps: {
                type: "array", maxItems: 10,
                items: {
                  type: "object",
                  properties: { text: { type: "string", description: "十个字左右的中文步骤" }, status: { type: "string", enum: ["done", "current", "pending", "blocked"] } },
                  required: ["text", "status"],
                },
              },
            },
            required: ["steps"],
          },
        },
        execute: async (args: unknown) => {
          const steps = (args as { steps?: unknown })?.steps;
          if (!Array.isArray(steps)) return "steps 需要是数组。";
          await service.updatePlan(workerId, steps as WorkerPlanStep[]);
          return "清单已更新。";
        },
      }];
    },

    delegationTools({ ownerUserId, agentId, threadId }) {
      const tool = (name: string, description: string, parameters: z.ZodType, execute: (args: never) => Promise<string>): GrantedTool => ({
        name, description, parameters, ref: `chisabot/${name}`,
        execute: (args: unknown) => execute(args as never),
      });
      return [
        {
          ...tool(
            "delegate_task",
            "把一件耗时、独立、不需要边做边问用户的事（例如：调研对比、整理大量资料、在网上办一件多步骤的事）交给后台任务并行去做，主对话可以继续聊。会立刻返回；结果做完后自动回到这个对话。简单问题、几秒能答的、需要用户边看边决定的不要委派。",
            z.object({
              title: z.string().describe("几个字的任务名，显示在任务卡片上，例如「对比三款降噪耳机」"),
              task: z.string().describe("完整的任务说明：要做什么、标准、限制、交回什么。后台任务看不到这段对话，所以把需要的背景都写进去。"),
              plan: z.array(z.string()).max(8).optional().describe("建议给：初步步骤 3–5 步（每步十个字左右）。卡片会立刻显示第一步，用户不用干等「准备中」。"),
            }),
            async (args: { title: string; task: string; plan?: string[] }) => {
              const started = await service.start({ ownerUserId, agentId, parentThreadId: threadId, title: args.title, task: args.task, plan: args.plan });
              return JSON.stringify({
                workerId: started.id, title: started.title, status: started.status,
                note: "已交给后台。用一句话告诉用户你已经开始在后台做、做完会把结果发到这里；不要等待它，也不要编造结果。",
              });
            },
          ),
          guidance: [
            "后台任务：耗时较长、可以独立完成的事（多来源调研、大量整理、多步骤网上操作）用 delegate_task 交给后台并行做，主对话保持能聊；每个任务给一个几个字的标题和完整说明（后台看不到这段对话）。",
            `同时最多 ${PER_USER_RUNNING} 个在跑；多出来的会自动排队（卡片显示「排队中」），前面的做完就自动开始，最多 ${PER_USER_BACKLOG} 个没结束的。所以用户要几个就照常委派几个，不要自己设提醒等空位再补开。后台任务和你共用同一个浏览器，所以同一时间最多委派一个需要用浏览器的任务，而且它在用浏览器时你自己不要用。`,
            "用户想给某个后台任务补充要求就用 worker_message；想取消就用 worker_cancel；问进度用 worker_status。结果回来时会是一条以「⟦chisabot:worker-result:」开头的消息。",
            "结果消息说「已停止」时，是用户自己在任务卡片上停掉的：只用一句话确认已经停止，不要重新开始、不要重新委派，也不要追问。",
          ].join("\n"),
        },
        tool(
          "worker_message",
          "给正在运行的后台任务发一条补充说明（它在下一步读到并调整）。",
          z.object({ workerId: z.string(), text: z.string() }),
          async (args: { workerId: string; text: string }) => {
            try { await service.steer(threadId, args.workerId, ownerUserId, args.text); return "已发给后台任务。"; }
            catch (error) { return error instanceof Error ? error.message : "发送失败。"; }
          },
        ),
        tool(
          "worker_cancel",
          "停止一个后台任务。",
          z.object({ workerId: z.string() }),
          async (args: { workerId: string }) => {
            try { await service.cancel(threadId, args.workerId, ownerUserId, { quiet: true }); return "已停止。"; }
            catch (error) { return error instanceof Error ? error.message : "停止失败。"; }
          },
        ),
        tool(
          "worker_status",
          "查看这个对话里后台任务的状态（标题、状态、当前步骤、清单）。",
          z.object({}),
          async () => JSON.stringify((await service.list(threadId, ownerUserId)).map((worker) => {
            const item = worker as WorkerView;
            return { workerId: item.id, title: item.title, status: item.status, step: item.step, plan: item.plan, error: item.error };
          })),
        ),
      ];
    },
  };
  return service;
}

/** 去掉文本里混进来的结果标记（「⟦chisabot:worker-result:…⟧」之类）。 */
export function stripWorkerMarkers(text: string): string {
  return text.replace(/⟦chisabot:[^⟧\n]{0,200}⟧[ \t]*/gu, "").trim();
}

function textOfContent(message: Message): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : "";
}
