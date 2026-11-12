/**
 * 工作流执行器（docs/workflows.md §运行）。
 *
 * 不是新的智能体引擎：每个步骤就是「某个机器人在一个新对话里跑一个无头回合」，用的正是定时任务、
 * 长期任务、面板任务在用的 `governedTurnRunner`（routines/run-turn.ts）——同样的机器人解析、
 * 模型连接、授权、工具、审计、暂停检查。这里只做编排：按阶段推进、交接输出、执行约束、等审批、记账。
 *
 * 为什么不用机器人互相 message_bot 的交接链：那是模型自己决定找谁、什么时候停，没法保证步骤顺序，
 * 也没法在两步之间卡预算、卡时间、等人批准。编排放在服务器，约束才是硬的。
 *
 * 每一步开一个只有该机器人的新对话（并行步骤因此不会抢同一个线程锁），步骤结束就删掉
 * （软删除），所以不会出现在任何人的会话里；步骤的产出存在运行记录里，运行页面读它。
 */
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import type { TurnRunner } from "../turns/types";
import {
  ACTIVE_RUN_STATUSES,
  effectiveConstraints,
  estimateTokens,
  OUTPUT_FORMAT_LABEL,
  TOOL_GROUP_INFO,
  type ToolRule,
  type WorkflowDefinition,
  type WorkflowGateFinding,
  type WorkflowGateResult,
  type WorkflowOutputFormat,
  type WorkflowRetryStrategy,
  type WorkflowRunView,
  type WorkflowStep,
  type WorkflowStepFeedback,
  type WorkflowStepState,
  workflowStages,
} from "../../../shared/workflows";
import { clearStepPolicy, registerStepPolicy, SUBMIT_GATE_RESULT_TOOL } from "./policy";
import { presetById, PRESET_PREFIX } from "./presets";
import type { RunEvent, RunEventInput, RunSource, RunState, StoredRun, WorkflowStore } from "./store";

/** 一个人同时最多跑几个工作流（不含等待审批的）。 */
export const MAX_ACTIVE_RUNS_PER_USER = 3;
export const DEFAULT_MAX_REWORKS = 3;
/** 交给下一步时，每段前序输出最多带多少字。 */
const HANDOFF_CHARS = 12_000;
const PERSIST_EVERY_MS = 1_200;
/** 正在跑的运行多久刷新一次心跳（updated_at）。 */
const HEARTBEAT_MS = 30_000;
/** 心跳超过这么久没刷新，才认为跑它的进程已经不在了（开机恢复时据此判断）。 */
const RUN_LEASE_MS = 3 * HEARTBEAT_MS;

/** 机器人在工作流里永远拿不到的工具：不能在工作流里再启动或操控工作流。 */
const ALWAYS_DENIED: ToolRule = {
  deny: ["run_workflow", "list_workflows", "get_workflow_run", "control_workflow_run"],
};

export class WorkflowRunError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "WorkflowRunError";
  }
}

/** 约束触发：记成「约束拦截」事件，运行失败，原因写清是哪条约束。 */
class ConstraintError extends Error {
  constructor(
    message: string,
    readonly constraint: string,
  ) {
    super(message);
    this.name = "ConstraintError";
  }
}
class UserCancelled extends Error {
  constructor() {
    super("已被手动停止。");
    this.name = "UserCancelled";
  }
}

/** 步骤验证门（Gate）或失败策略要求打回上游步骤重做。 */
class StepReworkRequested extends Error {
  constructor(
    readonly fromStepId: string,
    readonly targetStepId: string,
    readonly by: string,
    readonly reason: string,
    readonly findings?: WorkflowGateFinding[],
  ) {
    super(reason);
    this.name = "StepReworkRequested";
  }
}

/** 步骤验证门（Gate）要求人工介入拍板。 */
class GateHumanEscalation extends Error {
  constructor(
    readonly stepId: string,
    readonly stepName: string,
    readonly note: string,
  ) {
    super(note);
    this.name = "GateHumanEscalation";
  }
}

export type BotInfo = { id: string; name: string };
export type LibrarySkill = { slug: string; title: string; instructions: string };

export type WorkflowEngineDeps = {
  store: WorkflowStore;
  runTurn: TurnRunner;
  /** 给这一步开一个只有这个机器人的新对话。 */
  createConversation: (ownerUserId: string, botId: string) => Promise<{ channelId: string; threadId: string }>;
  /** 步骤结束后删掉它（软删除）。失败只记日志。 */
  deleteConversation: (ownerUserId: string, channelId: string) => Promise<void>;
  /** 这个人能不能用这个机器人；能就返回名字。 */
  botInfo: (ownerUserId: string, botId: string) => Promise<BotInfo | null>;
  /** 这个人能用的技能（技能页里的）。 */
  librarySkills: (ownerUserId: string) => Promise<LibrarySkill[]>;
  /** 开一个面板创作会话，让这一步能把面板存进机器人的右栏。 */
  beginPanelSession?: (ownerUserId: string, botId: string) => Promise<string | null>;
  audit?: AuditStore;
  now?: () => Date;
  log?: (line: string) => void;
  /** 测试用：心跳间隔和租约时长（默认 30 秒 / 90 秒）。 */
  heartbeatMs?: number;
  runLeaseMs?: number;
};

type RawInputs = Record<string, unknown>;

export function normalizeInputs(def: WorkflowDefinition, raw: RawInputs | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const source = raw ?? {};
  for (const input of def.inputs) {
    let value = source[input.key];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) value = input.default;
    const empty = value === undefined || value === null || (typeof value === "string" && value.trim() === "");
    if (empty) {
      if (input.required && input.type !== "boolean") throw new WorkflowRunError(`请填写「${input.label}」。`);
      if (input.type === "boolean") out[input.key] = false;
      continue;
    }
    switch (input.type) {
      case "number": {
        const n = typeof value === "number" ? value : Number(String(value).trim());
        if (!Number.isFinite(n)) throw new WorkflowRunError(`「${input.label}」需要是数字。`);
        out[input.key] = n;
        break;
      }
      case "boolean":
        out[input.key] = value === true || value === "true" || value === "是" || value === "1" || value === 1;
        break;
      case "select": {
        const text = String(value).trim();
        if (input.options?.length && !input.options.includes(text))
          throw new WorkflowRunError(`「${input.label}」只能选：${input.options.join(" / ")}。`);
        out[input.key] = text;
        break;
      }
      case "url": {
        const text = String(value).trim();
        let ok = false;
        try {
          const url = new URL(text);
          ok = url.protocol === "http:" || url.protocol === "https:";
        } catch {}
        if (!ok) throw new WorkflowRunError(`「${input.label}」需要是 http(s) 网址。`);
        out[input.key] = text;
        break;
      }
      default: {
        const text = String(value);
        if (text.length > 40_000) throw new WorkflowRunError(`「${input.label}」太长了（最多 40000 字）。`);
        out[input.key] = text;
      }
    }
  }
  return out;
}

function inputText(value: string | number | boolean | undefined): string {
  if (value === undefined || value === "") return "（未填写）";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

export function renderTemplate(
  text: string,
  inputs: Record<string, string | number | boolean>,
  outputs: Record<string, string>,
): string {
  return text.replace(/\{\{\s*(inputs|steps)\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_, kind: string, key: string) =>
    kind === "inputs" ? inputText(inputs[key]) : (outputs[key] ?? "（该步骤还没有输出）"),
  );
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n…（后面还有 ${text.length - max} 字，已省略）` : text;
}

/** 从回复里取出 JSON：整段、```json 代码块、或第一个 { … } / [ … ]。 */
export function extractJson(text: string): string | null {
  const candidates: string[] = [text.trim()];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fence) candidates.push(fence[1]!.trim());
  const first = text.search(/[[{]/);
  const last = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

function ruleText(rules: ToolRule[]): string[] {
  const label = (item: string) => (item in TOOL_GROUP_INFO ? TOOL_GROUP_INFO[item as keyof typeof TOOL_GROUP_INFO].label : item);
  const deny = [...new Set(rules.flatMap((r) => r.deny ?? []))].filter(
    (d) => !["run_workflow", "list_workflows", "get_workflow_run", "control_workflow_run"].includes(d),
  );
  const allows = rules.filter((r) => r.allow && r.allow.length > 0).map((r) => r.allow!);
  const lines: string[] = [];
  if (allows.length > 0) {
    const allowed = allows.reduce((acc, list) => acc.filter((x) => list.includes(x)));
    lines.push(allowed.length ? `只能使用这些工具：${allowed.map(label).join("、")}。` : "这一步不能使用任何工具。");
  }
  if (deny.length) lines.push(`禁止使用：${deny.map(label).join("、")}。`);
  return lines;
}

function formatFeedbackSection(feedback: WorkflowStepFeedback): string[] {
  const lines = [
    "",
    "## 返工 / 重试修改要求（必须优先处理）",
    `- 来源：${feedback.by}${feedback.fromStepId ? `（步骤 ${feedback.fromStepId}）` : ""}`,
    `- 原因与要求：${feedback.reason}`,
  ];
  if (feedback.findings?.length) {
    lines.push("- 具体问题清单：");
    for (const f of feedback.findings) {
      lines.push(`  - [${f.severity.toUpperCase()}] ${f.title}${f.evidence ? ` — ${f.evidence}` : ""}`);
    }
  }
  return lines;
}

/**
 * 将运行状态从目标步骤所在阶段起重置为 pending，并累加返工计数。
 */
function applyReworkReset(
  def: WorkflowDefinition,
  state: RunState,
  fromStepId: string,
  targetStepId: string,
  feedback: WorkflowStepFeedback,
  retryMode?: WorkflowRetryStrategy,
):
  | { ok: true; targetStageIndex: number; reworkCount: number; maxReworks: number; targetName: string; resetStepIds: string[] }
  | { ok: false; error: string } {
  const stages = workflowStages(def.steps);
  const fromStageIndex = stages.findIndex((stage) => stage.some((s) => s.id === fromStepId));
  const targetStageIndex = stages.findIndex((stage) => stage.some((s) => s.id === targetStepId));
  const targetDef = def.steps.find((s) => s.id === targetStepId);
  const targetState = state.steps.find((s) => s.id === targetStepId);
  if (!targetDef || !targetState || targetStageIndex < 0) {
    return { ok: false, error: `找不到打回的目标步骤「${targetStepId}」。` };
  }
  if (fromStageIndex >= 0 && targetStageIndex >= fromStageIndex) {
    return { ok: false, error: `只能打回给前面的阶段（「${targetDef.name}」不在当前步骤前面）。` };
  }
  const maxReworks = targetDef.maxReworks ?? DEFAULT_MAX_REWORKS;
  const currentReworks = targetState.reworkCount ?? 0;
  if (currentReworks >= maxReworks) {
    return {
      ok: false,
      error: `步骤「${targetDef.name}」已达到最大返工次数上限（${maxReworks} 次），不能继续自动打回。`,
    };
  }
  const nextReworks = currentReworks + 1;
  const effectiveMode = retryMode ?? targetDef.retryStrategy ?? "targeted_fix";
  const resetStepIds: string[] = [];

  for (let i = targetStageIndex; i < stages.length; i++) {
    for (const stepDef of stages[i] ?? []) {
      const st = state.steps.find((s) => s.id === stepDef.id);
      if (!st) continue;
      resetStepIds.push(st.id);
      st.status = "pending";
      delete st.error;
      delete st.finishedAt;
      delete st.gateResult;
      if (stepDef.approval) {
        st.approval = { required: true, ...(stepDef.approvalNote ? { note: stepDef.approvalNote } : {}) };
      } else {
        delete st.approval;
      }
      if (st.id === targetStepId) {
        st.reworkCount = nextReworks;
        st.feedback = feedback;
        st.retryMode = effectiveMode;
        if (effectiveMode === "full_redo") {
          delete st.threadId;
          delete st.channelId;
        }
      } else {
        delete st.feedback;
      }
    }
  }
  return {
    ok: true,
    targetStageIndex,
    reworkCount: nextReworks,
    maxReworks,
    targetName: targetDef.name,
    resetStepIds,
  };
}

export function createWorkflowEngine(deps: WorkflowEngineDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.info(line));
  /** 正在这个进程里跑的运行。 */
  const active = new Map<string, { controller: AbortController; resumedAt: number; baseElapsed: number; rerun?: boolean }>();
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const runLeaseMs = deps.runLeaseMs ?? RUN_LEASE_MS;
  let recoverTimer: ReturnType<typeof setTimeout> | undefined;

  async function audit(run: Pick<StoredRun, "id" | "ownerUserId" | "workflowId" | "workflowName">, eventType: "workflow.run_started" | "workflow.run_finished" | "workflow.approval_decided" | "workflow.constraint_blocked", payload: Record<string, unknown>) {
    if (!deps.audit) return;
    try {
      await recordAuditEvent(deps.audit, {
        eventType,
        targetType: "workflow_run",
        targetId: run.id,
        actorUserId: run.ownerUserId,
        initiator: { kind: "workflow", id: run.id },
        payload: { workflowId: run.workflowId, workflow: run.workflowName, ...payload },
      });
    } catch (error) {
      log(`[workflows] audit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function event(runId: string, kind: string, message: string, stepId?: string | null, data?: Record<string, unknown>) {
    try {
      await store.addEvent(runId, kind, message, stepId, data);
    } catch (error) {
      log(`[workflows] event failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function initialState(def: WorkflowDefinition, bindings: Record<string, string>, bots: Map<string, BotInfo>): RunState {
    return {
      tokens: 0,
      stepsRun: 0,
      elapsedMs: 0,
      steps: def.steps.map((step): WorkflowStepState => {
        const role = def.bots.find((b) => b.key === step.bot)!;
        const botId = bindings[role.key]!;
        return {
          id: step.id,
          name: step.name,
          roleKey: role.key,
          roleName: role.name,
          botId,
          botName: bots.get(botId)?.name ?? botId,
          ...(step.group ? { group: step.group } : {}),
          status: "pending",
          output: "",
          tokens: 0,
          skills: step.skills ?? [],
          ...(step.rejectTo ? { rejectTo: step.rejectTo } : {}),
          ...(step.maxReworks ? { maxReworks: step.maxReworks } : {}),
          ...(step.approval ? { approval: { required: true, ...(step.approvalNote ? { note: step.approvalNote } : {}) } } : {}),
        };
      }),
    };
  }

  /** 开始一次运行。校验输入和机器人，写库，然后在后台执行；立即返回。 */
  async function start(input: {
    ownerUserId: string;
    workflowId: string;
    definition: WorkflowDefinition;
    inputs?: RawInputs;
    bindings?: Record<string, unknown>;
    /** 没指定、工作流里也没绑定的角色用这个机器人（聊天里启动时 = 当前机器人）。 */
    fallbackBotId?: string;
    source: RunSource;
  }): Promise<StoredRun> {
    const def = input.definition;
    const inputs = normalizeInputs(def, input.inputs);
    const bindings: Record<string, string> = {};
    const bots = new Map<string, BotInfo>();
    for (const role of def.bots) {
      const raw = input.bindings?.[role.key];
      const candidates = [typeof raw === "string" ? raw.trim() : "", role.botId ?? "", input.fallbackBotId ?? ""].filter(Boolean);
      let chosen: BotInfo | null = null;
      for (const candidate of candidates) {
        chosen = bots.get(candidate) ?? (await deps.botInfo(input.ownerUserId, candidate));
        if (chosen) break;
      }
      if (!chosen) throw new WorkflowRunError(`请为角色「${role.name}」选一个机器人。`);
      bots.set(chosen.id, chosen);
      bindings[role.key] = chosen.id;
    }
    // 计数和插入在同一个事务里（按 owner 加锁），并发启动也不会突破上限。
    const run = await store.createRunWithinLimit(
      {
        ownerUserId: input.ownerUserId,
        workflowId: input.workflowId,
        definition: def,
        inputs,
        bindings,
        source: input.source,
        state: initialState(def, bindings, bots),
      },
      MAX_ACTIVE_RUNS_PER_USER,
    );
    if (!run) throw new WorkflowRunError(`同时最多运行 ${MAX_ACTIVE_RUNS_PER_USER} 个工作流，等前面的跑完再试。`, 429);
    const limits = effectiveConstraints(def);
    await event(run.id, "run_started", `开始运行（${{ page: "工作流页面", chat: "聊天", routine: "长期任务", api: "接口" }[input.source]}）`, null, {
      bindings,
      limits: { maxSteps: limits.maxSteps, maxTokens: limits.maxTokens, timeLimitMinutes: limits.timeLimitMinutes },
    });
    await audit(run, "workflow.run_started", { source: input.source, bindings, steps: def.steps.length });
    void execute(run.id);
    return run;
  }

  async function execute(runId: string): Promise<void> {
    // 在任何 await 之前同步占位：同一进程里并发的两次 execute 只有一个往下走。
    const existing = active.get(runId);
    if (existing) {
      // 上一段执行还没退出（例如刚停在审批关卡），退出后再试一次，由 claimRun 决定要不要跑。
      existing.rerun = true;
      return;
    }
    const controller = new AbortController();
    const slot: { controller: AbortController; resumedAt: number; baseElapsed: number; rerun?: boolean } = {
      controller,
      resumedAt: Date.now(),
      baseElapsed: 0,
    };
    active.set(runId, slot);
    // 跨进程原子占位：queued → running 只有一个能抢到。
    const run = await store.claimRun(runId).catch((error) => {
      log(`[workflows] claim failed: ${String(error)}`);
      return null;
    });
    if (!run) {
      active.delete(runId);
      if (slot.rerun) void execute(runId);
      return;
    }
    const def = run.definition;
    const limits = effectiveConstraints(def);
    const state = run.state;
    slot.resumedAt = Date.now();
    slot.baseElapsed = state.elapsedMs;
    const heartbeat = setInterval(() => {
      void store.touchRun(runId).catch((error) => log(`[workflows] heartbeat failed: ${String(error)}`));
    }, heartbeatMs);
    heartbeat.unref?.();
    const elapsed = () => slot.baseElapsed + (Date.now() - slot.resumedAt);

    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPersist = 0;
    const persistNow = async (
      patch: Partial<Pick<StoredRun, "status" | "output" | "error" | "startedAt" | "finishedAt">> = {},
      noticeEvent?: RunEventInput,
    ) => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = undefined;
      lastPersist = Date.now();
      state.elapsedMs = elapsed();
      const saved = store.saveRun(runId, { ...patch, state }, noticeEvent);
      if (noticeEvent) await saved;
      else await saved.catch((error) => log(`[workflows] save failed: ${String(error)}`));
    };
    const persistSoon = () => {
      if (persistTimer) return;
      const wait = Math.max(0, PERSIST_EVERY_MS - (Date.now() - lastPersist));
      persistTimer = setTimeout(() => void persistNow(), wait);
    };

    const remainingMs = limits.timeLimitMinutes * 60_000 - state.elapsedMs;
    const deadline = setTimeout(
      () => controller.abort(new ConstraintError(`超过时间上限（${limits.timeLimitMinutes} 分钟）。`, "timeLimitMinutes")),
      Math.max(0, remainingMs),
    );
    const outputs: Record<string, string> = {};
    for (const step of state.steps) if (step.status === "succeeded") outputs[step.id] = step.output;
    let library: LibrarySkill[] | null = null;
    const stages = workflowStages(def.steps);

    const stateOf = (id: string) => state.steps.find((s) => s.id === id)!;

    async function runStep(step: WorkflowStep, stageIndex: number): Promise<void> {
      const st = stateOf(step.id);
      const role = def.bots.find((b) => b.key === step.bot)!;
      const botId = run!.bindings[role.key]!;
      const isLast = stageIndex === stages.length - 1;
      const format: WorkflowOutputFormat | undefined = step.output ?? (isLast ? limits.outputFormat : undefined);
      const rules: ToolRule[] = [limits.tools, step.tools ?? {}, ALWAYS_DENIED];
      const attempt = (st.attempt ?? 0) + 1;
      st.attempt = attempt;
      const retryMode: WorkflowRetryStrategy = st.retryMode ?? step.retryStrategy ?? "targeted_fix";
      const reuseConversation = Boolean(st.threadId && retryMode === "targeted_fix");
      st.botId = botId;

      // 技能：工作流自带的优先，其次技能页里的。
      const skillTexts: string[] = [];
      for (const slug of step.skills ?? []) {
        const embedded = def.skills?.find((s) => s.slug === slug);
        if (embedded) {
          skillTexts.push(`### /${slug} ${embedded.title}\n${embedded.instructions}`);
          continue;
        }
        library ??= await deps.librarySkills(run!.ownerUserId).catch(() => []);
        const found = library.find((s) => s.slug === slug);
        if (found) skillTexts.push(`### /${slug} ${found.title}\n${found.instructions}`);
        else await event(runId, "skill_missing", `技能 /${slug} 找不到，这一步不带它继续。`, step.id);
      }

      // 交接：前面步骤的输出。
      const referenced = new Set([...step.prompt.matchAll(/\{\{\s*steps\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!));
      const handoff = step.handoff ?? "previous";
      const priorSteps =
        handoff === "none"
          ? []
          : handoff === "all"
            ? stages.slice(0, stageIndex).flat()
            : stageIndex > 0
              ? stages[stageIndex - 1]!
              : [];
      const handoffBlocks = priorSteps
        .filter((s) => !referenced.has(s.id) && outputs[s.id])
        .map((s) => {
          const ps = stateOf(s.id);
          return `### 第 ${def.steps.indexOf(s) + 1} 步「${s.name}」（${ps.roleName}）\n${clip(outputs[s.id]!, HANDOFF_CHARS)}`;
        });

      const remaining = limits.maxTokens - state.tokens;
      const inputLines = def.inputs.map((i) => `- ${i.label}：${clip(inputText(run!.inputs[i.key]), 4000)}`);
      const constraintLines = [
        "只完成本步骤，直接给出本步骤的产出；不要寒暄，不要复述要求，不要替后面的步骤做事。",
        "这是自动运行的工作流，中途没有人会回复你：不要向用户提问，信息不足时按合理假设完成并写明假设。",
        ...ruleText(rules),
        step.gate?.enabled
          ? `验证门（Gate）已开启：完成审查或验证后，必须调用 ${SUBMIT_GATE_RESULT_TOOL} 工具提交结构化裁决（pass / rework / fail / human），并在回复中给出结论说明。`
          : "",
        format === "json"
          ? "输出格式：只输出一个合法的 JSON（可以放在 ```json 代码块里），不要其他文字。"
          : format
            ? `输出格式：${OUTPUT_FORMAT_LABEL[format]}。`
            : "",
        isLast && limits.outputInstructions ? `对最终输出的要求：${limits.outputInstructions}` : "",
        isLast && limits.maxChars ? `最终输出不超过 ${limits.maxChars} 字。` : "",
        `预算：这次运行还剩约 ${Math.max(0, remaining)} token，回答尽量控制在 ${Math.max(500, Math.min(8000, Math.floor(remaining / 2)))} token 以内。`,
      ].filter(Boolean);

      const instruction = reuseConversation && st.feedback
        ? [
            `[工作流步骤「${step.name}」第 #${attempt} 次执行 — 基于原对话继续修正]`,
            ...formatFeedbackSection(st.feedback),
            ...(handoffBlocks.length ? ["", "## 最新上游步骤输出", ...handoffBlocks] : []),
            "",
            "请结合你在此对话中已有的上下文和工具结果，直接针对上述反馈完成修改，并输出完整的更新后产物。",
          ].join("\n")
        : [
            `你正在执行工作流「${def.name}」的第 ${def.steps.indexOf(step) + 1}/${def.steps.length} 步「${step.name}」。`,
            `你在这个工作流里的角色：${role.name}${role.description ? ` —— ${role.description}` : ""}`,
            `当前时间：${now().toISOString()}（UTC）`,
            "",
            "## 本步骤要求",
            renderTemplate(step.prompt, run!.inputs, outputs),
            ...(st.feedback ? formatFeedbackSection(st.feedback) : []),
            ...(inputLines.length ? ["", "## 输入参数", ...inputLines] : []),
            ...(skillTexts.length ? ["", "## 本步骤使用的技能（照做）", ...skillTexts] : []),
            ...(handoffBlocks.length ? ["", "## 前面步骤的输出", ...handoffBlocks] : []),
            "",
            "## 约束",
            ...constraintLines.map((line) => `- ${line}`),
          ].join("\n");

      const instructionTokens = estimateTokens(instruction);
      if (state.tokens + instructionTokens > limits.maxTokens)
        throw new ConstraintError(`超出 token 预算（${limits.maxTokens}）：开始「${step.name}」之前预算已不够。`, "maxTokens");

      st.status = "running";
      st.startedAt = now().toISOString();
      st.output = "";
      delete st.error;
      delete st.gateResult;
      await persistNow();
      await event(
        runId,
        "step_started",
        `「${step.name}」开始${attempt > 1 ? `（第 ${attempt} 次尝试${reuseConversation ? " · 复用记忆" : ""}）` : ""}，由 ${st.botName}（${role.name}）负责`,
        step.id,
      );

      let gateSubmitted: WorkflowGateResult | null = null;
      const initiatorId = `${runId}/${step.id}`;
      registerStepPolicy(initiatorId, {
        rules,
        onBlocked: (name) => {
          void event(runId, "tool_blocked", `拦下了被约束禁止的工具调用：${name}`, step.id);
          void audit(run!, "workflow.constraint_blocked", { step: step.id, constraint: "tools", tool: name });
        },
        ...(step.gate?.enabled
          ? {
              onGateSubmit: (res) => {
                gateSubmitted = res;
                st.gateResult = res;
              },
            }
          : {}),
      });
      const stepController = new AbortController();
      const onParentAbort = () => stepController.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", onParentAbort);
      if (controller.signal.aborted) onParentAbort();
      const stepTimer = setTimeout(
        () => stepController.abort(new ConstraintError(`「${step.name}」超过单步时间上限（${limits.stepTimeoutMinutes} 分钟）。`, "stepTimeoutMinutes")),
        limits.stepTimeoutMinutes * 60_000,
      );

      let conversation: { channelId: string; threadId: string } | null = null;
      let createdFreshConversation = false;
      let turnCount = 0;
      const turn = async (text: string, forwardedProps?: Record<string, unknown>) => {
        turnCount += 1;
        const base = state.tokens;
        const inTokens = estimateTokens(text);
        const { replyText } = await deps.runTurn({
          ownerUserId: run!.ownerUserId,
          routineId: runId,
          agentId: botId,
          threadId: conversation!.threadId,
          instruction: text,
          initiator: { kind: "workflow", id: initiatorId },
          signal: stepController.signal,
          userMessage: { id: `${runId}:${step.id}:a${attempt}:${turnCount}`, role: "user", content: text },
          ...(forwardedProps ? { forwardedProps } : {}),
          onText: (partial) => {
            st.output = partial;
            st.tokens = inTokens + estimateTokens(partial);
            if (base + st.tokens > limits.maxTokens && !stepController.signal.aborted)
              stepController.abort(new ConstraintError(`超出 token 预算（${limits.maxTokens}），「${step.name}」被中途停止。`, "maxTokens"));
            persistSoon();
          },
        });
        const used = inTokens + estimateTokens(replyText);
        state.tokens = base + used;
        return { replyText, used };
      };

      try {
        if (reuseConversation && st.threadId) {
          conversation = { channelId: st.channelId ?? "", threadId: st.threadId };
        } else {
          conversation = await deps.createConversation(run!.ownerUserId, botId);
          createdFreshConversation = true;
          st.channelId = conversation.channelId;
          st.threadId = conversation.threadId;
        }
        let forwarded: Record<string, unknown> | undefined;
        if (step.panel && deps.beginPanelSession) {
          const sessionId = await deps.beginPanelSession(run!.ownerUserId, botId).catch(() => null);
          if (sessionId) forwarded = { panelAuthoring: { sessionId } };
          else await event(runId, "panel_unavailable", "没能打开面板创作会话，这一步只能输出文字。", step.id);
        }
        let { replyText, used } = await turn(instruction, forwarded);
        let stepTokens = used;
        let output = replyText.trim();

        // 结构化验证门（Gate）处理
        if (step.gate?.enabled) {
          if (!gateSubmitted) {
            await event(runId, "gate_retry", `「${step.name}」未调用 ${SUBMIT_GATE_RESULT_TOOL}，要求补充裁决。`, step.id);
            const reminded = await turn(
              `你还没有调用 ${SUBMIT_GATE_RESULT_TOOL} 工具。请立即调用 ${SUBMIT_GATE_RESULT_TOOL} 提交你的裁决（pass / rework / fail / human），并保留你的最终结论。`,
            );
            stepTokens += reminded.used;
            if (reminded.replyText.trim()) output = reminded.replyText.trim();
          }
          // 若未配置 rejectTo 且裁决为 rework，支持在当前步骤内按 maxLoops 自我修正
          const maxLoops = step.gate.maxLoops ?? 2;
          let loops = 0;
          while (gateSubmitted && (gateSubmitted as WorkflowGateResult).decision === "rework" && !step.rejectTo && loops < maxLoops) {
            loops += 1;
            const prevGate = gateSubmitted as WorkflowGateResult;
            gateSubmitted = null;
            await event(runId, "gate_self_rework", `「${step.name}」验证门自修正（第 ${loops}/${maxLoops} 次）：${prevGate.reason}`, step.id);
            const selfFixPrompt = [
              `验证门未通过（rework）：${prevGate.reason}`,
              ...(prevGate.actionRequired ? [`需要修正：${prevGate.actionRequired}`] : []),
              ...(prevGate.findings?.length
                ? ["具体问题：", ...prevGate.findings.map((f) => `- [${f.severity}] ${f.title}${f.evidence ? `：${f.evidence}` : ""}`)]
                : []),
              `请直接修正上述问题，完成后再次调用 ${SUBMIT_GATE_RESULT_TOOL} 提交最新裁决，并输出修正后的完整结果。`,
            ].join("\n");
            const fixed = await turn(selfFixPrompt);
            stepTokens += fixed.used;
            if (fixed.replyText.trim()) output = fixed.replyText.trim();
          }
          if (gateSubmitted) {
            const finalGate = gateSubmitted as WorkflowGateResult;
            await event(runId, "gate_decided", `「${step.name}」验证门裁决：${finalGate.decision} —— ${finalGate.reason}`, step.id, {
              decision: finalGate.decision,
              findings: finalGate.findings?.length ?? 0,
            });
            if (finalGate.decision === "fail") {
              throw new Error(`验证门未通过（fail）：${finalGate.reason}`);
            }
            if (finalGate.decision === "human") {
              st.output = output;
              st.tokens = stepTokens;
              throw new GateHumanEscalation(step.id, step.name, finalGate.actionRequired || finalGate.reason);
            }
            if (finalGate.decision === "rework") {
              st.output = output;
              st.tokens = stepTokens;
              if (step.rejectTo) {
                throw new StepReworkRequested(step.id, step.rejectTo, st.botName, finalGate.actionRequired || finalGate.reason, finalGate.findings);
              }
              throw new Error(`验证门经过 ${maxLoops} 次自修正后仍未通过：${finalGate.reason}`);
            }
          }
        }

        if (format === "json" && output) {
          let json = extractJson(output);
          if (!json) {
            await event(runId, "format_retry", "输出不是合法 JSON，要求机器人修正一次。", step.id);
            if (state.tokens + estimateTokens(output) * 2 > limits.maxTokens)
              throw new ConstraintError(`超出 token 预算（${limits.maxTokens}）：没有余量修正 JSON。`, "maxTokens");
            const fixed = await turn("你上一条输出不是合法的 JSON。只输出修正后的 JSON（可以放在 ```json 代码块里），不要任何其他文字。");
            stepTokens += fixed.used;
            json = extractJson(fixed.replyText);
            if (!json) throw new ConstraintError("输出格式约束：最终输出不是合法的 JSON。", "output.format");
          }
          output = JSON.stringify(JSON.parse(json), null, 2);
        }
        if (!output) throw new Error("机器人没有给出任何输出。");
        st.output = output;
        st.tokens = stepTokens;
        st.status = "succeeded";
        st.finishedAt = now().toISOString();
        delete st.retryMode;
        state.stepsRun += 1;
        outputs[step.id] = output;
        await persistNow();
        await event(runId, "step_finished", `「${step.name}」完成（约 ${stepTokens} token）`, step.id, { tokens: stepTokens });
      } catch (error) {
        if (error instanceof GateHumanEscalation) {
          st.status = "waiting_approval";
          st.approval = { required: true, note: `验证门请求人工介入：${error.note}` };
          await persistNow();
          throw error;
        }
        if (error instanceof StepReworkRequested) {
          st.finishedAt = now().toISOString();
          st.status = "succeeded";
          state.stepsRun += 1;
          await persistNow();
          throw error;
        }
        const reason = stepController.signal.aborted ? stepController.signal.reason : error;
        st.finishedAt = now().toISOString();
        if (reason instanceof UserCancelled) {
          st.status = "cancelled";
          st.error = reason.message;
        } else {
          st.status = "failed";
          st.error =
            reason instanceof ConstraintError
              ? reason.message
              : error instanceof HeadlessToolSuspension
                ? "这一步调用了需要人工审批的工具，工作流运行中不能等待工具审批。可以在设备 / 权限里把它改成允许，或在约束里禁止这个工具。"
                : error instanceof Error
                  ? error.message
                  : String(error);
        }
        // 非致命单步失败时，按 step.onFailure 策略分流（但运行级超预算/超时/手动取消除外）
        const isRunLevelConstraint =
          reason instanceof ConstraintError && (reason.constraint === "maxTokens" || reason.constraint === "timeLimitMinutes" || reason.constraint === "maxSteps");
        if (!(reason instanceof UserCancelled) && !isRunLevelConstraint) {
          if (step.onFailure === "continue") {
            outputs[step.id] = `（步骤「${step.name}」执行失败已按容错规则跳过：${st.error}）`;
            await persistNow();
            await event(runId, "step_failed_continued", `「${step.name}」失败但按容错规则继续下一步：${st.error}`, step.id);
            return;
          }
          if (step.onFailure === "reject" && step.rejectTo) {
            await persistNow();
            throw new StepReworkRequested(step.id, step.rejectTo, st.botName, `步骤「${step.name}」执行失败：${st.error}`);
          }
        }
        await persistNow();
        throw reason instanceof ConstraintError || reason instanceof UserCancelled
          ? reason
          : new Error(st.error ?? "步骤失败。");
      } finally {
        clearTimeout(stepTimer);
        controller.signal.removeEventListener("abort", onParentAbort);
        clearStepPolicy(initiatorId);
        // 新建的步骤会话立即软删除以从用户左侧列表隐藏，但底层 threadId 保留在数据库里供 targeted_fix 续跑。
        if (conversation && createdFreshConversation)
          await deps.deleteConversation(run!.ownerUserId, conversation.channelId).catch((error) =>
            log(`[workflows] conversation cleanup failed: ${String(error)}`),
          );
      }
    }

    try {
      await persistNow({ status: "running", ...(run.startedAt ? {} : { startedAt: now() }) });
      for (let index = 0; index < stages.length; index++) {
        const stage = stages[index]!;
        const pending = stage.filter((s) => {
          const st = stateOf(s.id);
          return st.status !== "succeeded" && st.status !== "skipped" && !(st.status === "failed" && s.onFailure === "continue");
        });
        if (pending.length === 0) continue;
        if (controller.signal.aborted) throw controller.signal.reason;

        // 审批关卡：阶段第一步要求审批且还没批准，就停在这里。
        const gate = stage[0]!;
        const gateState = stateOf(gate.id);
        if ((gate.approval || gateState.approval?.required) && gateState.approval?.decision !== "approve") {
          gateState.status = "waiting_approval";
          await persistNow({ status: "waiting_approval" }, {
            kind: "approval_requested", message: `「${gate.name}」开始前需要你批准`, stepId: gate.id,
          });
          return;
        }
        const hasReworks = state.steps.some((s) => (s.reworkCount ?? 0) > 0);
        const stepCap =
          def.constraints?.maxSteps !== undefined
            ? limits.maxSteps
            : hasReworks
              ? def.steps.length * (DEFAULT_MAX_REWORKS + 1)
              : limits.maxSteps;
        if (state.stepsRun + pending.length > stepCap) {
          throw new ConstraintError(`超过最多步骤数（${stepCap}）。`, "maxSteps");
        }

        const results = await Promise.allSettled(pending.map((step) => runStep(step, index)));
        const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (rejected) {
          const reason = rejected.reason;
          if (reason instanceof GateHumanEscalation) {
            await persistNow({ status: "waiting_approval" }, {
              kind: "approval_requested", message: `「${reason.stepName}」请求你介入审批：${reason.note}`, stepId: reason.stepId,
            });
            return;
          }
          if (reason instanceof StepReworkRequested) {
            const rework = applyReworkReset(def, state, reason.fromStepId, reason.targetStepId, {
              fromStepId: reason.fromStepId,
              by: reason.by,
              reason: reason.reason,
              at: now().toISOString(),
              ...(reason.findings ? { findings: reason.findings } : {}),
            });
            if (!rework.ok) {
              throw new Error(`${rework.error}（原因：${reason.reason}）`);
            }
            for (const resetId of rework.resetStepIds) delete outputs[resetId];
            await persistNow();
            await event(
              runId,
              "step_rework_requested",
              `打回「${rework.targetName}」重做（第 ${rework.reworkCount}/${rework.maxReworks} 次）：${reason.reason.slice(0, 200)}`,
              reason.targetStepId,
            );
            index = rework.targetStageIndex - 1;
            continue;
          }
          throw reason;
        }
      }

      const last = stages[stages.length - 1]!;
      let output =
        last.length === 1
          ? (outputs[last[0]!.id] ?? "")
          : last.map((s) => `## ${s.name}\n\n${outputs[s.id] ?? ""}`).join("\n\n");
      if (limits.maxChars && output.length > limits.maxChars) {
        output = `${output.slice(0, limits.maxChars)}\n\n…（按约束截断到 ${limits.maxChars} 字）`;
        await event(runId, "output_truncated", `最终输出超过 ${limits.maxChars} 字，已截断`, null);
      }
      await persistNow({ status: "succeeded", output, error: null, finishedAt: now() }, {
        kind: "run_finished",
        message: `运行完成：${state.stepsRun} 步，约 ${state.tokens} token，用时 ${Math.round(elapsed() / 1000)} 秒`,
        data: { tokens: state.tokens, steps: state.stepsRun, elapsedMs: elapsed() },
      });
      await audit(run, "workflow.run_finished", { status: "succeeded", tokens: state.tokens, steps: state.stepsRun, elapsedMs: elapsed() });
    } catch (thrown) {
      const reason = controller.signal.aborted && !(thrown instanceof ConstraintError) ? controller.signal.reason : thrown;
      const cancelled = reason instanceof UserCancelled;
      const message = reason instanceof Error ? reason.message : String(reason);
      for (const step of state.steps) {
        if (step.status === "pending" || step.status === "waiting_approval") step.status = "skipped";
        if (step.status === "running") {
          step.status = cancelled ? "cancelled" : "failed";
          step.error ??= message;
        }
      }
      if (reason instanceof ConstraintError) {
        await event(runId, "constraint_blocked", message, null, { constraint: reason.constraint });
        await audit(run, "workflow.constraint_blocked", { constraint: reason.constraint, message });
      }
      await persistNow({ status: cancelled ? "cancelled" : "failed", error: message, finishedAt: now() }, {
        kind: cancelled ? "run_cancelled" : "run_failed",
        message: cancelled ? "运行已停止" : `运行失败：${message}`,
      });
      await audit(run, "workflow.run_finished", { status: cancelled ? "cancelled" : "failed", reason: message, tokens: state.tokens, steps: state.stepsRun });
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      if (persistTimer) clearTimeout(persistTimer);
      active.delete(runId);
      if (slot.rerun) void execute(runId);
    }
  }

  async function approve(input: {
    ownerUserId: string;
    runId: string;
    stepId: string;
    decision: "approve" | "reject";
    comment?: string;
    /** 拒绝时打回给哪个前面步骤重做；不传则用步骤定义里的 rejectTo，都没有才整条取消。 */
    rejectTo?: string;
    retryMode?: WorkflowRetryStrategy;
    by: string;
  }) {
    const run = await store.getOwnRun(input.ownerUserId, input.runId);
    if (!run) throw new WorkflowRunError("找不到这次运行。", 404);
    const step = run.state.steps.find((s) => s.id === input.stepId);
    if (run.status !== "waiting_approval" || !step || step.status !== "waiting_approval")
      throw new WorkflowRunError("这一步现在不需要审批。", 409);

    const stepDef = run.definition.steps.find((s) => s.id === input.stepId);
    const rejected = input.decision === "reject";
    // 支持显式传入 rejectTo="__cancel__" 强制终止运行，否则优先取 input.rejectTo 或 stepDef.rejectTo
    const rawTarget = input.rejectTo === "__cancel__" ? undefined : (input.rejectTo?.trim() || stepDef?.rejectTo);

    if (rejected && rawTarget) {
      const reasonText = input.comment?.trim() || `「${step.name}」审批未通过，请按要求修改。`;
      const rework = applyReworkReset(
        run.definition,
        run.state,
        step.id,
        rawTarget,
        {
          fromStepId: step.id,
          by: input.by,
          reason: reasonText,
          at: now().toISOString(),
        },
        input.retryMode,
      );
      if (!rework.ok) throw new WorkflowRunError(rework.error, 409);
      const won = await store.transitionRun(run.id, ["waiting_approval"], {
        status: "queued",
        state: run.state,
        error: null,
      });
      if (!won) throw new WorkflowRunError("这一步已经被处理过了。", 409);
      await event(
        run.id,
        "step_rework_requested",
        `${input.by}拒绝了「${step.name}」并打回「${rework.targetName}」重做（第 ${rework.reworkCount}/${rework.maxReworks} 次）${input.comment ? `：${input.comment.slice(0, 200)}` : ""}`,
        rawTarget,
        { by: input.by, fromStepId: step.id, reworkCount: rework.reworkCount },
      );
      await audit(run, "workflow.approval_decided", {
        step: step.id,
        decision: "reject_rework",
        rejectTo: rawTarget,
        reworkCount: rework.reworkCount,
      });
      void execute(run.id);
      return;
    }

    step.approval = {
      required: true,
      ...(step.approval?.note ? { note: step.approval.note } : {}),
      decision: input.decision,
      decidedBy: input.by,
      decidedAt: now().toISOString(),
      ...(input.comment ? { comment: input.comment.slice(0, 500) } : {}),
    };
    if (rejected) {
      for (const s of run.state.steps) if (s.status === "pending" || s.status === "waiting_approval") s.status = "skipped";
      step.status = "cancelled";
    } else step.status = "pending";
    // CAS：只有状态还是 waiting_approval 时才写入；并发的两次审批只有一个能过，另一个得到 409。
    const won = await store.transitionRun(
      run.id,
      ["waiting_approval"],
      rejected
        ? { status: "cancelled", state: run.state, error: `「${step.name}」的审批没有通过。`, finishedAt: now() }
        : { status: "queued", state: run.state },
    );
    if (!won) throw new WorkflowRunError("这一步已经被处理过了。", 409);
    await event(run.id, "approval_decided", `${rejected ? "拒绝" : "批准"}了「${step.name}」${input.comment ? `：${input.comment.slice(0, 200)}` : ""}`, step.id, { by: input.by });
    await audit(run, "workflow.approval_decided", { step: step.id, decision: input.decision });
    if (rejected) {
      await event(run.id, "run_cancelled", "审批没有通过，运行结束", null);
      await audit(run, "workflow.run_finished", { status: "cancelled", reason: "approval rejected" });
      return;
    }
    void execute(run.id);
  }

  /**
   * 失败或已停止的运行原地重试：
   * - 默认从失败/停止的步骤开始，复用该步骤的对话记忆（targeted_fix）继续修；
   * - 自动叠加工作流定义里最新的角色机器人绑定（修了角色配置立即可重跑），保持步骤图冻结。
   */
  async function retry(input: {
    ownerUserId: string;
    runId: string;
    stepId?: string;
    mode?: WorkflowRetryStrategy;
    comment?: string;
    bindings?: Record<string, unknown>;
    latestDefinition?: WorkflowDefinition;
    by?: string;
  }): Promise<StoredRun> {
    const actorBy = input.by ?? "你";
    const run = await store.getOwnRun(input.ownerUserId, input.runId);
    if (!run) throw new WorkflowRunError("找不到这次运行。", 404);
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new WorkflowRunError("只有失败或已停止的运行才能重试。", 409);
    }
    if ((await store.countActive(input.ownerUserId)) >= MAX_ACTIVE_RUNS_PER_USER) {
      throw new WorkflowRunError(`同时最多运行 ${MAX_ACTIVE_RUNS_PER_USER} 个工作流，等前面的跑完再试。`, 429);
    }

    // overlayLatestNodeBindings：读取最新工作流定义的角色默认绑定（如果存在）并叠加
    const latestWorkflow =
      input.latestDefinition ??
      (run.workflowId.startsWith(PRESET_PREFIX)
        ? presetById(run.workflowId)?.definition
        : (await store.get(input.ownerUserId, run.workflowId))?.definition);
    const nextBindings: Record<string, string> = { ...run.bindings };
    const botNames = new Map<string, string>();
    for (const role of run.definition.bots) {
      const explicit = typeof input.bindings?.[role.key] === "string" ? String(input.bindings[role.key]).trim() : "";
      const latestRoleBot = latestWorkflow?.bots.find((b) => b.key === role.key)?.botId?.trim() ?? "";
      const candidates = [explicit, latestRoleBot, run.bindings[role.key] ?? ""].filter(Boolean);
      let chosen: BotInfo | null = null;
      for (const candidate of candidates) {
        chosen = await deps.botInfo(input.ownerUserId, candidate);
        if (chosen) break;
      }
      if (!chosen) throw new WorkflowRunError(`角色「${role.name}」绑定的机器人已不可用，请先在工作流里更新角色绑定。`);
      nextBindings[role.key] = chosen.id;
      botNames.set(role.key, chosen.name);
    }

    const stages = workflowStages(run.definition.steps);
    let targetStageIndex = -1;
    let targetStepId = input.stepId?.trim();
    if (targetStepId) {
      targetStageIndex = stages.findIndex((stage) => stage.some((s) => s.id === targetStepId));
      if (targetStageIndex < 0) throw new WorkflowRunError(`找不到步骤「${targetStepId}」。`, 400);
    } else {
      targetStageIndex = stages.findIndex((stage) =>
        stage.some((s) => {
          const st = run.state.steps.find((x) => x.id === s.id);
          return st && st.status !== "succeeded";
        }),
      );
      if (targetStageIndex < 0) targetStageIndex = stages.length - 1;
      targetStepId = stages[targetStageIndex]?.[0]?.id ?? "";
    }

    const effectiveMode: WorkflowRetryStrategy = input.mode ?? "targeted_fix";
    for (let i = targetStageIndex; i < stages.length; i++) {
      for (const stepDef of stages[i] ?? []) {
        const st = run.state.steps.find((s) => s.id === stepDef.id);
        if (!st) continue;
        const newBotId = nextBindings[stepDef.bot] ?? st.botId;
        const newBotName = botNames.get(stepDef.bot) ?? newBotId;
        st.botId = newBotId;
        st.botName = newBotName;
        st.status = "pending";
        const previousError = st.error;
        delete st.error;
        delete st.finishedAt;
        delete st.gateResult;
        if (stepDef.approval) {
          st.approval = { required: true, ...(stepDef.approvalNote ? { note: stepDef.approvalNote } : {}) };
        }
        if (i === targetStageIndex) {
          st.retryMode = effectiveMode;
          if (st.retryMode === "full_redo") {
            delete st.threadId;
            delete st.channelId;
          }
          if (input.comment?.trim() || previousError) {
            st.feedback = {
              by: actorBy,
              reason: input.comment?.trim() || `上一次执行未完成（${previousError ?? "已中断"}），请继续完成。`,
              at: now().toISOString(),
            };
          }
        } else {
          delete st.feedback;
        }
      }
    }

    const won = await store.transitionRun(run.id, ["failed", "cancelled"], {
      status: "queued",
      bindings: nextBindings,
      state: run.state,
      error: null,
      finishedAt: null,
    });
    if (!won) throw new WorkflowRunError("运行状态已改变，请刷新后再试。", 409);

    const targetStepName = run.definition.steps.find((s) => s.id === targetStepId)?.name ?? targetStepId;
    await event(
      run.id,
      "run_retried",
      `${actorBy}从「${targetStepName}」发起重试（${effectiveMode === "targeted_fix" ? "保留记忆修正" : "全新重跑"}）${input.comment ? `：${input.comment.slice(0, 200)}` : ""}`,
      targetStepId,
      { mode: effectiveMode, by: input.by },
    );
    void execute(run.id);
    return (await store.getOwnRun(input.ownerUserId, run.id)) ?? run;
  }

  async function cancel(ownerUserId: string, runId: string) {
    const run = await store.getOwnRun(ownerUserId, runId);
    if (!run) throw new WorkflowRunError("找不到这次运行。", 404);
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) return;
    const slot = active.get(runId);
    if (slot) {
      slot.controller.abort(new UserCancelled());
      return;
    }
    for (const s of run.state.steps) if (s.status === "pending" || s.status === "waiting_approval" || s.status === "running") s.status = "cancelled";
    await store.saveRun(run.id, { status: "cancelled", state: run.state, error: "已被手动停止。", finishedAt: now() });
    await event(run.id, "run_cancelled", "运行已停止", null);
    await audit(run, "workflow.run_finished", { status: "cancelled", reason: "cancelled" });
  }

  async function remove(ownerUserId: string, runId: string) {
    const run = await store.getOwnRun(ownerUserId, runId);
    if (!run) throw new WorkflowRunError("找不到这次运行。", 404);
    if (ACTIVE_RUN_STATUSES.includes(run.status)) await cancel(ownerUserId, runId);
    // 等后台把「已停止」写完再删，避免删完又被写回。
    for (let i = 0; i < 50 && active.has(runId); i++) await new Promise((r) => setTimeout(r, 100));
    await store.deleteRun(ownerUserId, runId);
  }

  /**
   * 启动时调用：上个进程里没跑完的运行标成失败（等待审批的不受影响，批准后照常继续）。
   * 部署重叠时另一个容器可能正在跑某个运行：心跳（updated_at）还新鲜的先不动，过了租约再查一次；
   * 标失败本身也是条件更新，只有心跳确实过期的才会被标。
   */
  async function recover() {
    if (recoverTimer) clearTimeout(recoverTimer);
    recoverTimer = undefined;
    const runs = await store.interruptedRuns();
    const staleBefore = new Date(now().getTime() - runLeaseMs);
    let failed = 0;
    let deferred = 0;
    for (const run of runs) {
      if (active.has(run.id)) continue;
      if (run.updatedAt.getTime() >= staleBefore.getTime()) {
        deferred += 1;
        continue;
      }
      for (const s of run.state.steps) {
        if (s.status === "running") {
          s.status = "failed";
          s.error = "服务器重启，这一步被中断了。";
        } else if (s.status === "pending") s.status = "skipped";
      }
      const marked = await store.failStaleRun(run.id, staleBefore, {
        state: run.state,
        error: "服务器重启，运行中断了。可以重新运行。",
        finishedAt: now(),
      }, {
        kind: "run_failed", message: "服务器重启，运行中断了",
      });
      if (!marked) continue;
      failed += 1;
    }
    if (failed) log(`[workflows] marked ${failed} interrupted run(s) as failed`);
    if (deferred) {
      log(`[workflows] ${deferred} run(s) still have a fresh heartbeat; re-checking after the lease`);
      recoverTimer = setTimeout(() => {
        recoverTimer = undefined;
        void recover().catch((error) => log(`[workflows] recover re-check failed: ${String(error)}`));
      }, runLeaseMs + 1_000);
      recoverTimer.unref?.();
    }
    return { failed, deferred };
  }

  function view(run: StoredRun, events?: RunEvent[]): WorkflowRunView {
    const limits = effectiveConstraints(run.definition);
    const slot = active.get(run.id);
    return {
      id: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      icon: run.definition.icon,
      status: run.status,
      source: run.source,
      inputs: run.inputs,
      steps: run.state.steps,
      usage: {
        tokens: run.state.tokens,
        steps: run.state.stepsRun,
        elapsedMs: slot ? slot.baseElapsed + (Date.now() - slot.resumedAt) : run.state.elapsedMs,
      },
      limits: {
        maxTokens: limits.maxTokens,
        maxSteps: limits.maxSteps,
        timeLimitMinutes: limits.timeLimitMinutes,
        stepTimeoutMinutes: limits.stepTimeoutMinutes,
      },
      outputFormat: limits.outputFormat,
      output: run.output,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      tools: limits.tools,
      ...(events
        ? {
            events: events.map((e) => ({ id: e.id, at: e.at.toISOString(), kind: e.kind, stepId: e.stepId, message: e.message })),
          }
        : {}),
    };
  }

  return { start, execute, approve, retry, cancel, remove, recover, view, isActive: (id: string) => active.has(id) };
}

export type WorkflowEngine = ReturnType<typeof createWorkflowEngine>;
