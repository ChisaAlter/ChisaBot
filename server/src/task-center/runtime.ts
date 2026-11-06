/**
 * 任务中心的接线层（docs/research/task-center-core-handoff.md）。
 *
 * service.ts 只管队列、租约、依赖与 Outbox 生命周期；这里决定「谁巡检、谁规划、谁执行、怎么通知」：
 * - collect：task-center/sources.ts 的八种采集器，只读，凭据走既有账号连接，不落 config。
 * - plan：一次无头回合让机器人把目标拆成 <= 6 步，输出严格 JSON；拆不出来就当单任务直接执行，
 *   绝不因为规划格式问题把任务卡死在重试里。
 * - execute：同一条 governedTurnRunner（定时任务 / 工作流 / 后台任务都在用），在隐藏的
 *   `task-center:<taskId>:<tag>:<attempt>` 线程里跑——每次尝试独立线程（见 taskThreadId）；
 *   线程前缀让 messages 巡检不会再把它扫成「未回复消息」。
 * - notify：Outbox 出现待确认时，在主机器人的对话里记一行活动；通知失败只写在 decision 上，
 *   不阻塞审批本身（decisions.notification_error 在页面上可见）。
 * - learn：任务到达终态后把结果写进「已学到」上下文（appendLearned/learnEntry）；
 *   交付物 = 回合里画出的组件（componentArtifacts），用量 = 回合台账 RUN_FINISHED 的 contextUsage。
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
  TASK_LEVEL_LABELS,
  validateTaskPlan,
} from "../../../shared/task-center";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import type { Github } from "../github/service";
import type { PersonalSourcesService } from "../personal-sources/service";
import type { DrawnComponent, TurnRunner } from "../turns/types";
import {
  createTaskCenter,
  TaskCenterError,
  type TaskCenterService,
} from "./service";
import { createTaskSourceCollectors } from "./sources";

const TASK_THREAD_PREFIX = "task-center:";
/**
 * 每次尝试独立线程：上一次异常退出（宿主工具网关 5xx、容器重启等）会把线程标成
 * paused/held，重试沿用同一线程只会重复 409「保留的消息已暂停」，永远到不了模型。
 */
export const taskThreadId = (task: TaskCenterTask, tag: string) =>
  `${TASK_THREAD_PREFIX}${task.id}:${tag}:${task.attempts}`;
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
  ) => Promise<void>;
  /** 部署策略批准的可巡检目录；缺省 = 不允许读任何本机目录。 */
  localRoots?: () => string[] | Promise<string[]>;
  localConversationsAvailable?: boolean;
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
    `\n完成后：总结实际交付的结果（这段总结进入任务记录），产出文件 / 页面 / 代码要写明位置；做不到就直说原因，不要假装完成。`,
  ]
    .filter(Boolean)
    .join("\n");
}

const PLAN_PROMPT = `你是任务规划器。把目标拆成可独立推进的子任务（最多 ${MAX_PLAN_STEPS} 步；目标很直接就只留空 steps）。
只输出一个 JSON 对象，不要调用工具，不要输出计划以外的任何文字：
{"summary":"<计划的一句话说明>","steps":[{"key":"s1","title":"…","description":"…","level":1,"risk":"read","category":"research","dependsOn":[]}]}
字段约束：key 是步骤间的稳定引用；dependsOn 只能引用其他 key；title<=200 字；description<=2000 字，写清验收标准；
level∈1..5（1 整理信息 / 2 分析建议 / 3 生成成果 / 4 确认后完成 / 5 自主交付）；risk∈read|internal|external|sensitive|publish；
category∈research|development|documents|project|schedule|communication|decision|other。能并行的步骤不要互相依赖。`;

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
      ? async () => options.localRoots?.() ?? []
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
    return options.runTurn({
      ownerUserId: task.ownerUserId,
      routineId: `task:${task.id}:${tag}`,
      agentId: await resolveAgent(task),
      threadId: taskThreadId(task, tag),
      instruction,
      initiator: { kind: "routine", id: `task:${task.id}` },
      signal,
      userMessage: {
        id: `task:${task.id}:${tag}`,
        role: "user",
        content: instruction,
      } as Message,
    });
  }

  /**
   * 规划回合失败只降级为「按单任务执行」，不让模型输出格式问题变成任务失败重试。
   * L1/L2 任务本身就是「整理 / 建议」粒度，直接执行比再花一次模型调用拆解划算。
   */
  async function plan(
    task: TaskCenterTask,
    context: TaskContext,
    signal: AbortSignal,
  ): Promise<TaskPlan> {
    if (task.level <= 2)
      return { summary: "整理 / 建议类任务直接执行。", steps: [] };
    try {
      const outcome = await runTaskTurn(
        task,
        `${PLAN_PROMPT}\n\n目标：${task.title}\n\n${clip(task.description, INSTRUCTION_LIMIT)}\n\n${contextBrief(context)}`,
        signal,
        "plan",
      );
      const plan = extractJson(outcome.replyText ?? "") as TaskPlan;
      validateTaskPlan(plan);
      if (plan.steps.length > MAX_PLAN_STEPS)
        plan.steps = plan.steps.slice(0, MAX_PLAN_STEPS);
      return {
        summary: clip(String(plan.summary || task.title), 500),
        steps: plan.steps,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(
        JSON.stringify({
          type: "task-center-plan-fallback",
          task: task.id,
          reason: reasonWithoutStatement(error).slice(0, 300),
        }),
      );
      return {
        summary: "任务较直接或规划未产出有效拆解，按单一任务执行。",
        steps: [],
      };
    }
  }

  async function execute(
    task: TaskCenterTask,
    context: TaskExecutionContext,
  ): Promise<TaskExecutionResult> {
    if (task.executor !== "bot")
      throw new TaskCenterError(
        `执行器「${task.executor}」尚未接入，当前支持 bot。`,
        400,
      );
    if (needsTaskApproval(task.risk) && !context.approval)
      throw new TaskCenterError("此操作仍在等待人工确认。", 409);
    const outcome = await runTaskTurn(
      task,
      frameTask(task, context),
      context.signal,
      "run",
    );
    const summary = outcome.replyText?.trim();
    if (!summary) throw new TaskCenterError("执行回合没有产出结果摘要。");
    return {
      summary: clip(summary, 60_000),
      artifacts: componentArtifacts(outcome.components),
      usage: await readTurnUsage(taskThreadId(task, "run")),
    };
  }

  /**
   * 回合台账（openbot_local_events）在 RUN_FINISHED 里记录 contextUsage；
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
        FROM openbot_local_events WHERE thread_id=$1 AND event->>'type'='RUN_FINISHED'`,
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
      "SELECT payload->>'agentId' AS agent_id FROM chisabot_task_center_tasks WHERE owner_user_id=$1 AND id=$2",
      [ownerUserId, decision.taskId],
    );
    const agentId =
      row?.agent_id ?? (await options.defaultAgentFor(ownerUserId));
    if (!agentId) return;
    await options.recordNotice(
      ownerUserId,
      agentId,
      `[任务中心] 「${decision.proposedAction.title}」需要你的确认：到 任务中心 › Outbox 批准或拒绝。`,
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
        available: false,
        detail: "经设备节点委派执行；当前版本执行器为 bot，后续迭代接入。",
      },
    ];
    return [...executors, ...sourceCaps];
  }

  let serviceRef: TaskCenterService | undefined;
  const service = createTaskCenter(options.database, {
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
    },
    capabilities,
    botAvailable: options.botAvailable,
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    ...(options.globalConcurrency
      ? { globalConcurrency: options.globalConcurrency }
      : {}),
  });
  serviceRef = service;
  return service;
}
