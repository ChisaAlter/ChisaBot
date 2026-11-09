/**
 * 任务中心的接线层（docs/research/task-center-core-handoff.md）。
 *
 * service.ts 只管队列、租约、依赖与 Outbox 生命周期；这里决定「谁巡检、谁规划、谁执行、怎么通知」：
 * - collect：task-center/sources.ts 的八种采集器，只读，凭据走既有账号连接，不落 config。
 * - plan：一次无头回合让机器人把目标拆成 <= 6 步，并保存需要文件/发送/设备回执的完成条件。
 * - execute：同一条 governedTurnRunner（定时任务 / 工作流 / 后台任务都在用），在隐藏的
 *   `task-center:<taskId>:<tag>:<attempt>` 线程里跑——每次尝试独立线程（见 taskThreadId）；
 *   线程前缀让 messages 巡检不会再把它扫成「未回复消息」。
 * - notify：Outbox 出现待确认时，在主机器人的对话里记一行活动；通知失败只写在 decision 上，
 *   不阻塞审批本身（decisions.notification_error 在页面上可见）。
 * - learn：任务到达终态后把结果写进「已学到」上下文（appendLearned/learnEntry），
 *   同时沉淀一条 memory-notes 长期记忆（kind=project，按标题合并）——履历给人看，
 *   记忆给机器人检索；执行回合本身也握着 memory_* 工具，可以当场记细节。
 *   交付物包含经实际文件/交付账本验证的引用与回合组件；用量读取原 RUN_FINISHED。
 * - localAgentRun：executor=local-agent 时把任务委派给设备上的本地 agent
 *   （local-agents 子系统做审批 / 隔离 / 并发），任务侧心跳续租约，等它终态。
 */
import type { Message } from "@ag-ui/client";
import type {
  TaskArtifact,
  TaskCapability,
  TaskCenterDecision,
  TaskCenterTask,
  TaskContext,
  TaskExecutionContext,
  TaskExecutionResult,
  TaskPlan,
  TaskUsage,
} from "../../../shared/task-center";
import {
  needsTaskApproval,
  taskCompletionSchema,
  TASK_LEVEL_LABELS,
  validateTaskPlan,
} from "../../../shared/task-center";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import type { Github } from "../github/service";
import type { createMemoryNotes } from "../memory-notes/service";
import type { PersonalSourcesService } from "../personal-sources/service";
import type { DrawnComponent, TurnRunner } from "../turns/types";
import { createTaskCenterRoots } from "./roots";
import { createTaskCenterRoutes } from "./routes";
import {
  createTaskCenter,
  TaskCenterError,
  type TaskCenterService,
} from "./service";
import { isLocalAgentExecutor, localAgentThreadId } from "./local-agent-runner";
import { createTaskSourceCollectors } from "./sources";
import { createTaskCenterTrace } from "./trace";
import { readDurableTurn, BackgroundTurnNeedsReview } from "../turns/durable-outcome";
import { setTimeout as delay } from "node:timers/promises";
import { drawnComponents } from "../turns/run-turn";
import { assertTaskEvidence, taskTurnFailure, TaskResultNeedsReview, verifyTaskTurn } from "./outcome";

const TASK_THREAD_PREFIX = "task-center:";
/**
 * 每次尝试独立线程：上一次异常退出（宿主工具网关 5xx、容器重启等）会把线程标成
 * paused/held，重试沿用同一线程只会重复 409「保留的消息已暂停」，永远到不了模型。
 */
export const taskThreadId = (task: TaskCenterTask, tag: string) =>
  `${TASK_THREAD_PREFIX}${task.id}:${tag}:${task.version > 1 ? `v${task.version}:` : ""}${task.attempts}`;
const MAX_PLAN_STEPS = 6;
const INSTRUCTION_LIMIT = 12_000;
const LEARNED_LIMIT = 5000;
const clip = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n)}…` : text;

/** 模型在回合里画的卡片/组件就是任务的交付物；存成可预览、可下载的 JSON 记录。 */
export function componentArtifacts(
  components: DrawnComponent[] | undefined,
): TaskArtifact[] {
  return (components ?? []).slice(0, 50).map((component, index) => {
    const title = component.args.title ?? component.args.name;
    return {
      name: (typeof title === "string" && title.trim()
        ? title
        : `${component.name} #${index + 1}`
      ).slice(0, 200),
      content: clip(
        JSON.stringify(
          { component: component.name, props: component.args },
          null,
          2,
        ),
        200_000,
      ),
      mediaType: "application/vnd.chisabot.component+json",
    };
  });
}

/** 「已学到」是一行一行的执行履历：日期 + 标题 + 结果；超限时丢最旧的行，只进不出人工编写的字段。 */
export function learnEntry(
  task: Pick<TaskCenterTask, "title">,
  outcome: { status: "succeeded" | "failed"; detail: string },
): string {
  const date = new Date().toISOString().slice(0, 10);
  const mark = outcome.status === "succeeded" ? "完成" : "失败";
  const detail = clip(
    outcome.detail.replace(/\s+/g, " ").trim() || "（无说明）",
    220,
  );
  return `[${date}] 「${clip(task.title, 80)}」${mark}：${detail}`;
}

export function appendLearned(
  existing: string,
  entry: string,
  limit = LEARNED_LIMIT,
): string {
  const merged = existing.trim() ? `${existing.trim()}\n${entry}` : entry;
  if (merged.length <= limit) return merged;
  const lines = merged.split("\n");
  while (lines.length > 1 && lines.join("\n").length > limit) lines.shift();
  return lines.join("\n");
}

export type TaskCenterRuntimeOptions = {
  database: Database;
  /** governedTurnRunner：与定时任务、工作流、后台任务同一套治理回合。 */
  runTurn: TurnRunner;
  personalSources: Pick<
    PersonalSourcesService,
    "scanCalendar" | "scanEmails" | "status"
  >;
  github: Pick<Github, "listOpenItems" | "status">;
  /** agentId 不存在或已删除时返回 false；与 schedules 同口径。 */
  botAvailable: (ownerUserId: string, agentId: string) => Promise<boolean>;
  /** 任务未指定机器人时的落点：主机器人；查不到返回 null。 */
  defaultAgentFor: (ownerUserId: string) => Promise<string | null>;
  /** 往主机器人对话里写一行通知；不可用时传 undefined，通知失败不影响 Outbox。 */
  recordNotice?: (
    ownerUserId: string,
    agentId: string,
    text: string,
    context?: { id: string; taskId: string },
  ) => Promise<void>;
  /** 部署策略 + 用户设置的授权巡检目录（按 owner 查）；缺省 = 不允许读任何本机目录。 */
  localRoots?: (ownerUserId: string) => string[] | Promise<string[]>;
  localConversationsAvailable?: boolean;
  /** 长期记忆：终态沉淀 + 执行时检索；缺省则不写记忆。 */
  memoryNotes?: Pick<ReturnType<typeof createMemoryNotes>, "create" | "search">;
  /**
   * executor=local-agent 的执行路径（index.ts 接 local-agents 子系统）：
   * 给设备上的 Codex / Claude 等派发任务，返回其终态结果；缺省 = 该执行器不可用。
   */
  localAgentRun?: (
    task: TaskCenterTask,
    agentId: string,
    context: TaskExecutionContext,
  ) => Promise<TaskExecutionResult>;
  concurrency?: number;
  globalConcurrency?: number;
};

/** L1–L5 是给机器人看的执行边界，不是权限等级；对外与敏感动作仍由风险门 + 工具审批拦。 */
const LEVEL_GUIDANCE: Record<number, string> = {
  1: "只整理与归纳信息，形成结构化要点与背景；不提出执行动作、不调用会改变状态的途径。",
  2: "分析问题并给出建议与可执行方案；方案供人决定，本回合不实施。",
  3: "完成可交付的中间成果（草稿、文档、分析、代码片段）；成果不对外生效。",
  4: "自主完成大部分工作；涉及对外沟通、发布、敏感或不可逆动作时停下报告，等待人工确认。",
  5: "端到端完成任务并自行验证结果；交付成果与验证说明，仍受工具审批与风险边界约束。",
};

const RISK_GUIDANCE: Record<string, string> = {
  read: "本任务只允许读取：不修改、不删除、不发送、不发布任何内容。",
  internal:
    "可以读写账号内部数据（文档、任务、面板等）；不得对外发送或公开发布。",
  external:
    "任务包含对外动作，且已获得人工批准；按已批准的范围执行，不扩大动作。",
  sensitive: "任务涉及敏感操作，且已获得人工批准；最小化动作并如实记录。",
  publish: "任务涉及公开发布，且已获得人工批准；只执行已批准的内容与渠道。",
};

function contextBrief(context: TaskContext): string {
  const parts = [
    context.responsibilities && `职责：${context.responsibilities}`,
    context.projects && `进行中的项目：${context.projects}`,
    context.goals && `目标：${context.goals}`,
    context.preferences && `偏好：${context.preferences}`,
    context.learned && `已知情况：${context.learned}`,
  ].filter(Boolean);
  return parts.join("\n").slice(0, 4000);
}

function dependenciesBrief(dependencies: TaskCenterTask[]): string {
  if (!dependencies.length) return "";
  const lines = dependencies.map(
    (dep) =>
      `- ${dep.title}（${dep.status === "succeeded" ? "已完成" : dep.status}）${dep.summary ? `：${dep.summary}` : ""}`,
  );
  return `\n\n前置任务结果：\n${lines.join("\n")}`;
}

function approvalBrief(context: TaskExecutionContext): string {
  if (!context.approval) return "";
  return `\n\n此项操作已于 ${context.approval.decidedAt ?? "此前"} 获得人工确认，在批准范围内继续执行。`;
}

export function frameTask(
  task: TaskCenterTask,
  context: TaskExecutionContext,
): string {
  const brief = contextBrief(context.context);
  return [
    `你正在任务中心执行一项交给你的任务，这不是对话闲聊；完成后结果会记入任务历史。`,
    `任务：${task.title}`,
    `自主等级：L${task.level}（${TASK_LEVEL_LABELS[task.level]}）——${LEVEL_GUIDANCE[task.level]}`,
    `风险边界：${RISK_GUIDANCE[task.risk]}`,
    brief ? `\n执行者的工作上下文：\n${brief}` : "",
    `\n背景与要求：\n${clip(task.description, INSTRUCTION_LIMIT)}`,
    dependenciesBrief(context.dependencies),
    approvalBrief(context),
    task.completion ? `\n完成条件：${task.completion.criteria}\n需要核对的回执：${task.completion.required.join("、") || "直接回答即可"}。文件请用 file_share 交付实际文件；仅写路径不会被视为文件成果。` : "",
    `\n执行中如果发现值得长期记住的事实、偏好或教训（用户/项目/习惯），用 memory_save 记入长期记忆，别只写在回复里。`,
    `\n完成后：总结实际交付的结果（这段总结进入任务记录），产出文件 / 页面 / 代码要写明位置；文件须用 file_share 交付，设备文件须实际读回确认；做不到就直说原因，不要假装完成。`,
  ]
    .filter(Boolean)
    .join("\n");
}

const PLAN_PROMPT = `你是任务规划器。把目标拆成可独立推进的子任务（最多 ${MAX_PLAN_STEPS} 步；目标很直接就只留空 steps）。
只输出一个 JSON 对象，不要调用工具，不要输出计划以外的任何文字：
{"summary":"<计划的一句话说明>","completion":{"criteria":"按原要求说明完成条件","required":[]},"steps":[{"key":"s1","title":"…","description":"…","level":1,"risk":"read","category":"research","dependsOn":[],"completion":{"criteria":"此步骤的完成条件","required":[]}}]}
字段约束：key 是步骤间的稳定引用；dependsOn 只能引用其他 key；title<=200 字；description<=2000 字，写清验收标准；
level∈1..5（1 整理信息 / 2 分析建议 / 3 生成成果 / 4 确认后完成 / 5 自主交付）；risk∈read|internal|external|sensitive|publish；
category∈research|development|documents|project|schedule|communication|decision|other。能并行的步骤不要互相依赖。
completion.required 只能包含 file（明确要求实际文件）、delivery（明确要求向外发送或通知）、device（明确要求操作设备），可同时包含多种。
整理、分析、建议或在回复中提供草稿/代码片段用空数组；不得给这类任务强加文件或外发要求。依据用户目标填写，不以机器人声称完成代替回执。
顶层 completion 和每个子任务 completion 都必须填写，即使 steps 为空。不要为核对成果扩大任务范围或新增副作用。`;

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidates = [
    fenced,
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ];
  for (const candidate of candidates) {
    if (!candidate?.trim().startsWith("{")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error("规划回合没有返回可解析的 JSON。");
}

export function createTaskCenterRuntime(
  options: TaskCenterRuntimeOptions,
): TaskCenterService {
  const collectors = createTaskSourceCollectors({
    database: options.database,
    personalSources: options.personalSources,
    github: options.github,
    localRootsFor: options.localRoots
      ? async (owner) => options.localRoots?.(owner) ?? []
      : undefined,
    localConversationsAvailable: options.localConversationsAvailable,
  });

  async function resolveAgent(task: TaskCenterTask): Promise<string> {
    const agentId =
      task.agentId ?? (await options.defaultAgentFor(task.ownerUserId));
    if (!agentId)
      throw new TaskCenterError("请先选择一个机器人来执行任务。", 400);
    return agentId;
  }

  async function runTaskTurn(
    task: TaskCenterTask,
    instruction: string,
    signal: AbortSignal,
    tag: string,
  ) {
    const threadId = taskThreadId(task, tag);
    for (;;) {
      const previous = await readDurableTurn(options.database, task.ownerUserId, threadId);
      if (!previous) break;
      if (previous.status === "finished") return { replyText: previous.replyText, components: drawnComponents(previous.messages ?? []), resumed: true };
      if (previous.status === "failed") {
        const message = previous.error ?? "原执行需要核对，未自动重做。";
        throw tag === "run" ? await taskTurnFailure(options.database, task, previous.runId, message) : new BackgroundTurnNeedsReview(message);
      }
      await delay(1000, undefined, { signal });
    }
    try { return { ...await options.runTurn({
      ownerUserId: task.ownerUserId,
      routineId: `task:${task.id}:${tag}`,
      agentId: await resolveAgent(task),
      threadId,
      runId: threadId,
      instruction,
      initiator: { kind: "routine", id: `task:${task.id}` },
      signal,
      userMessage: {
        id: `task:${task.id}:${tag}`,
        role: "user",
        content: instruction,
      } as Message,
    }), resumed: false }; } catch (error) {
      const durable = await readDurableTurn(options.database, task.ownerUserId, threadId);
      if (durable) {
        const message = error instanceof Error ? error.message : "原执行需要核对，未自动重做。";
        throw tag === "run" ? await taskTurnFailure(options.database, task, durable.runId, message) : new BackgroundTurnNeedsReview(message);
      }
      throw error;
    }
  }

  /**
   * 新计划在执行前明确完成条件；已保存的旧计划仍按原合同读取。
   * L1/L2 只确认完成条件，不拆分任务；显式条件已有时无需再调用模型。
   */
  async function plan(
    task: TaskCenterTask,
    context: TaskContext,
    signal: AbortSignal,
  ): Promise<TaskPlan> {
    if (task.level <= 2 && task.completion)
      return { summary: "整理 / 建议类任务直接执行。", steps: [], completion: task.completion };
    let resumed = false;
    try {
      const outcome = await runTaskTurn(
        task,
        `${PLAN_PROMPT}${task.level <= 2 ? "\n本次只确认完成条件，steps 必须为空，不拆分任务。" : ""}\n\n目标：${task.title}\n\n${clip(task.description, INSTRUCTION_LIMIT)}\n\n${contextBrief(context)}`,
        signal,
        "plan",
      );
      resumed = outcome.resumed;
      const plan = extractJson(outcome.replyText ?? "") as TaskPlan;
      plan.completion = task.completion ?? (plan.completion ? taskCompletionSchema.parse(plan.completion) : undefined);
      if (!resumed && !plan.completion) throw new Error("本次规划缺少完成条件。");
      if (!resumed) for (const step of plan.steps ?? []) taskCompletionSchema.parse(step.completion);
      validateTaskPlan(plan);
      if (plan.steps.length > MAX_PLAN_STEPS) throw new Error(`计划最多 ${MAX_PLAN_STEPS} 步，不能截断依赖。`);
      return {
        summary: clip(String(plan.summary || task.title), 500),
        steps: plan.steps,
        completion: plan.completion,
      };
    } catch (error) {
      if (signal.aborted || error instanceof BackgroundTurnNeedsReview) throw error;
      console.warn(
        JSON.stringify({
          type: "task-center-plan-fallback",
          task: task.id,
          reason: reasonWithoutStatement(error).slice(0, 300),
        }),
      );
      if (!resumed && !task.completion) throw new BackgroundTurnNeedsReview("规划没有给出可核对的完成条件，请检查任务要求后重试；本次尚未执行任务动作。");
      return {
        summary: "任务较直接或规划未产出有效拆解，按单一任务执行。",
        steps: [],
        completion: task.completion,
      };
    }
  }

  /** 按标题 + 类目检索长期记忆，给执行回合当背景；检索失败不给任务加戏。 */
  async function memoryBrief(task: TaskCenterTask): Promise<string> {
    if (!options.memoryNotes) return "";
    try {
      const rows = await options.memoryNotes.search(
        task.ownerUserId,
        `${task.title} ${task.category}`,
        undefined,
        6,
      );
      const lines = rows
        .map(
          (row) =>
            `- [${row.kind}${row.subject ? `·${row.subject}` : ""}] ${clip(String(row.content).replace(/\s+/g, " "), 220)}`,
        )
        .slice(0, 6);
      return lines.length ? `\n\n相关记忆：\n${lines.join("\n")}` : "";
    } catch {
      return "";
    }
  }

  async function execute(
    task: TaskCenterTask,
    context: TaskExecutionContext,
  ): Promise<TaskExecutionResult> {
    if (isLocalAgentExecutor(task.executor)) {
      if (!options.localAgentRun)
        throw new TaskCenterError(
          "执行器「local-agent」尚未接入：没有已连接的设备 Agent。",
          400,
        );
      if (needsTaskApproval(task.risk) && !context.approval)
        throw new TaskCenterError("此操作仍在等待人工确认。", 409);
      const result = await options.localAgentRun(task, await resolveAgent(task), context);
      context.signal.throwIfAborted();
      assertTaskEvidence(task, result);
      return result;
    }
    if (task.executor !== "bot")
      throw new TaskCenterError(
        `执行器「${task.executor}」尚未接入，当前支持 bot 和 local-agent。`,
        400,
      );
    if (needsTaskApproval(task.risk) && !context.approval)
      throw new TaskCenterError("此操作仍在等待人工确认。", 409);
    const outcome = await runTaskTurn(
      task,
      `${frameTask(task, context)}${await memoryBrief(task)}`,
      context.signal,
      "run",
    );
    const durable = await readDurableTurn(options.database, task.ownerUserId, taskThreadId(task, "run"));
    if (durable && durable.status !== "finished") throw new BackgroundTurnNeedsReview("原执行尚未成功结束，任务结果需要核对。");
    const verified = await verifyTaskTurn({ database: options.database, task,
      runId: durable?.runId ?? taskThreadId(task, "run"), messages: durable?.messages ?? [], dependencies: context.dependencies });
    const summary = outcome.replyText?.trim() || (verified.evidence.length ? verified.evidence.map(item => item.detail).join("；") : "");
    if (!summary) throw new TaskResultNeedsReview("执行回合没有交付摘要或可核查成果，请检查本次结果后继续。");
    context.signal.throwIfAborted();
    const result: TaskExecutionResult = {
      summary: clip(summary, 60_000),
      artifacts: [...verified.artifacts, ...componentArtifacts(outcome.components)].slice(0, 50),
      usage: await readTurnUsage(taskThreadId(task, "run")),
      evidence: verified.evidence,
    };
    assertTaskEvidence(task, result);
    return result;
  }

  /**
   * 回合台账（chisabot_local_events）在 RUN_FINISHED 里记录 contextUsage；
   * 读取失败只意味着用量缺失，不值得为此让任务重试。
   */
  async function readTurnUsage(
    threadId: string,
  ): Promise<TaskUsage | undefined> {
    try {
      const [row] = await options.database.$client.unsafe<
        { calls: number; input: number | null; output: number | null }[]
      >(
        `SELECT count(*)::int AS calls,
          sum((event->'metadata'->'contextUsage'->>'inputTokens')::int)::int AS input,
          sum((event->'metadata'->'contextUsage'->>'outputTokens')::int)::int AS output
        FROM chisabot_local_events WHERE thread_id=$1 AND event->>'type'='RUN_FINISHED'`,
        [threadId],
      );
      if (!row?.calls) return undefined;
      return {
        modelCalls: row.calls,
        ...(row.input != null ? { inputTokens: row.input } : {}),
        ...(row.output != null ? { outputTokens: row.output } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async function notify(
    ownerUserId: string,
    decision: TaskCenterDecision,
  ): Promise<void> {
    if (!options.recordNotice) return;
    const [row] = await options.database.$client.unsafe<
      { agent_id: string | null }[]
    >(
      "SELECT (CASE WHEN jsonb_typeof(payload)='string' THEN (payload #>> '{}')::jsonb ELSE payload END)->>'agentId' AS agent_id FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=$2",
      [ownerUserId, decision.taskId],
    );
    const agentId =
      row?.agent_id ?? (await options.defaultAgentFor(ownerUserId));
    if (!agentId) return;
    await options.recordNotice(
      ownerUserId,
      agentId,
      `[任务中心] 「${decision.proposedAction.title}」需要你的确认：到 任务中心 › Outbox 批准或拒绝。`,
      { id: `task-decision:${decision.id}`, taskId: decision.taskId },
    );
  }

  async function capabilities(ownerUserId: string): Promise<TaskCapability[]> {
    const sourceCaps = await collectors.capabilities(ownerUserId);
    const executors: TaskCapability[] = [
      {
        id: "executor:bot",
        name: "ChisaBot 机器人",
        kind: "executor",
        available: options.localConversationsAvailable !== false,
        detail:
          options.localConversationsAvailable !== false
            ? "服务端无头回合：完整宿主工具、审批与审计"
            : "需要本地会话运行模式",
      },
      {
        id: "executor:local-agent",
        name: "本地 Agent（Codex / Claude 等）",
        kind: "executor",
        available: Boolean(options.localAgentRun),
        detail: options.localAgentRun
          ? "经设备节点委派执行：权限档位、隔离与审批沿用设备设置；executor 用 local-agent:<kind> 指定 agent（codex/claude/…）"
          : "需要设备子系统在线；当前部署未启用。",
      },
    ];
    return [...executors, ...sourceCaps];
  }

  let serviceRef: TaskCenterService | undefined;
  const service = createTaskCenter(options.database, {
    hasDurableExecution: async task => {
      if (isLocalAgentExecutor(task.executor) && task.status !== "planning") {
        const [row] = await options.database.$client.unsafe("SELECT id FROM chisabot_local_agent_tasks WHERE owner_user_id=$1 AND thread_id=$2 LIMIT 1", [task.ownerUserId, localAgentThreadId(task)]);
        return Boolean(row);
      }
      return Boolean(await readDurableTurn(options.database, task.ownerUserId, taskThreadId(task, task.status === "planning" ? "plan" : "run")));
    },
    collect: collectors.collect,
    execute,
    plan,
    notify,
    // 任务终态（成功/失败）回写「已学到」履历；人工编写的六个字段永远不动。
    learn: async (ownerUserId, task, outcome) => {
      const service = serviceRef;
      if (!service) return;
      const context = await service.getContext(ownerUserId);
      await service.setLearned(
        ownerUserId,
        appendLearned(context.learned, learnEntry(task, outcome)),
      );
      // 同时沉淀进长期记忆：project 按主题合并，同一任务反复执行只涨一条；
      // 写不进去（记忆满等）不影响履历本身。
      try {
        await options.memoryNotes?.create(
          ownerUserId,
          {
            kind: "project",
            subject: `任务·${clip(task.title, 60)}`,
            content: clip(learnEntry(task, outcome), 1500),
            context: "任务中心执行履历",
          },
          task.agentId ?? null,
        );
      } catch {
        // 记忆写入失败不阻断 learn
      }
    },
    capabilities,
    botAvailable: options.botAvailable,
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.globalConcurrency
      ? { globalConcurrency: options.globalConcurrency }
      : {}),
  });
  serviceRef = service;

  /**
   * service.ts 的 routes 组装点不开放协作者入口，这里在 runtime 层把它接上：
   * 授权目录（roots，用户可维护的本机目录白名单）与执行轨迹（trace，
   * chisabot_local_events 投影）。ensure 顺带建 roots 表，建表失败保持原有行为。
   */
  const roots = createTaskCenterRoots(options.database);
  const trace = createTaskCenterTrace(options.database);
  const innerEnsure = service.ensure;
  service.ensure = async () => {
    await innerEnsure();
    await roots.ensure();
  };
  service.routes = (requireUser) =>
    createTaskCenterRoutes(service, requireUser, { roots, trace });
  return service;
}
