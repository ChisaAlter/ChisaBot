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
  type WorkflowOutputFormat,
  type WorkflowRunView,
  type WorkflowStep,
  type WorkflowStepState,
  workflowStages,
} from "../../../shared/workflows";
import { clearStepPolicy, registerStepPolicy } from "./policy";
import type { RunEvent, RunSource, RunState, StoredRun, WorkflowStore } from "./store";

/** 一个人同时最多跑几个工作流（不含等待审批的）。 */
export const MAX_ACTIVE_RUNS_PER_USER = 3;
/** 交给下一步时，每段前序输出最多带多少字。 */
const HANDOFF_CHARS = 12_000;
const PERSIST_EVERY_MS = 1_200;
/** 正在跑的运行多久刷新一次心跳（updated_at）。 */
const HEARTBEAT_MS = 30_000;
/** 心跳超过这么久没刷新，才认为跑它的进程已经不在了（开机恢复时据此判断）。 */
const RUN_LEASE_MS = 3 * HEARTBEAT_MS;

/** 机器人在工作流里永远拿不到的工具：不能在工作流里再启动工作流。 */
const ALWAYS_DENIED: ToolRule = { deny: ["run_workflow", "list_workflows"] };

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
  const deny = [...new Set(rules.flatMap((r) => r.deny ?? []))].filter((d) => d !== "run_workflow" && d !== "list_workflows");
  const allows = rules.filter((r) => r.allow && r.allow.length > 0).map((r) => r.allow!);
  const lines: string[] = [];
  if (allows.length > 0) {
    const allowed = allows.reduce((acc, list) => acc.filter((x) => list.includes(x)));
    lines.push(allowed.length ? `只能使用这些工具：${allowed.map(label).join("、")}。` : "这一步不能使用任何工具。");
  }
  if (deny.length) lines.push(`禁止使用：${deny.map(label).join("、")}。`);
  return lines;
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
    const persistNow = async (patch: Partial<Pick<StoredRun, "status" | "output" | "error" | "startedAt" | "finishedAt">> = {}) => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = undefined;
      lastPersist = Date.now();
      state.elapsedMs = elapsed();
      await store.saveRun(runId, { ...patch, state }).catch((error) => log(`[workflows] save failed: ${String(error)}`));
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
        format === "json"
          ? "输出格式：只输出一个合法的 JSON（可以放在 ```json 代码块里），不要其他文字。"
          : format
            ? `输出格式：${OUTPUT_FORMAT_LABEL[format]}。`
            : "",
        isLast && limits.outputInstructions ? `对最终输出的要求：${limits.outputInstructions}` : "",
        isLast && limits.maxChars ? `最终输出不超过 ${limits.maxChars} 字。` : "",
        `预算：这次运行还剩约 ${Math.max(0, remaining)} token，回答尽量控制在 ${Math.max(500, Math.min(8000, Math.floor(remaining / 2)))} token 以内。`,
      ].filter(Boolean);
      const instruction = [
        `你正在执行工作流「${def.name}」的第 ${def.steps.indexOf(step) + 1}/${def.steps.length} 步「${step.name}」。`,
        `你在这个工作流里的角色：${role.name}${role.description ? ` —— ${role.description}` : ""}`,
        `当前时间：${now().toISOString()}（UTC）`,
        "",
        "## 本步骤要求",
        renderTemplate(step.prompt, run!.inputs, outputs),
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
      await persistNow();
      await event(runId, "step_started", `「${step.name}」开始，由 ${st.botName}（${role.name}）负责`, step.id);

      const initiatorId = `${runId}/${step.id}`;
      registerStepPolicy(initiatorId, {
        rules,
        onBlocked: (name) => {
          void event(runId, "tool_blocked", `拦下了被约束禁止的工具调用：${name}`, step.id);
          void audit(run!, "workflow.constraint_blocked", { step: step.id, constraint: "tools", tool: name });
        },
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
          userMessage: { id: `${runId}:${step.id}:${turnCount}`, role: "user", content: text },
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
        conversation = await deps.createConversation(run!.ownerUserId, botId);
        let forwarded: Record<string, unknown> | undefined;
        if (step.panel && deps.beginPanelSession) {
          const sessionId = await deps.beginPanelSession(run!.ownerUserId, botId).catch(() => null);
          if (sessionId) forwarded = { panelAuthoring: { sessionId } };
          else await event(runId, "panel_unavailable", "没能打开面板创作会话，这一步只能输出文字。", step.id);
        }
        let { replyText, used } = await turn(instruction, forwarded);
        let stepTokens = used;
        let output = replyText.trim();
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
        state.stepsRun += 1;
        outputs[step.id] = output;
        await persistNow();
        await event(runId, "step_finished", `「${step.name}」完成（约 ${stepTokens} token）`, step.id, { tokens: stepTokens });
      } catch (error) {
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
        await persistNow();
        throw reason instanceof ConstraintError || reason instanceof UserCancelled
          ? reason
          : new Error(st.error ?? "步骤失败。");
      } finally {
        clearTimeout(stepTimer);
        controller.signal.removeEventListener("abort", onParentAbort);
        clearStepPolicy(initiatorId);
        if (conversation)
          await deps.deleteConversation(run!.ownerUserId, conversation.channelId).catch((error) =>
            log(`[workflows] conversation cleanup failed: ${String(error)}`),
          );
      }
    }

    try {
      await persistNow({ status: "running", ...(run.startedAt ? {} : { startedAt: now() }) });
      for (let index = 0; index < stages.length; index++) {
        const stage = stages[index]!;
        const pending = stage.filter((s) => stateOf(s.id).status !== "succeeded");
        if (pending.length === 0) continue;
        if (controller.signal.aborted) throw controller.signal.reason;

        // 审批关卡：阶段第一步要求审批且还没批准，就停在这里。
        const gate = stage[0]!;
        const gateState = stateOf(gate.id);
        if (gate.approval && gateState.approval?.decision !== "approve") {
          gateState.status = "waiting_approval";
          await persistNow({ status: "waiting_approval" });
          await event(runId, "approval_requested", `「${gate.name}」开始前需要你批准`, gate.id);
          return;
        }
        if (state.stepsRun + pending.length > limits.maxSteps)
          throw new ConstraintError(`超过最多步骤数（${limits.maxSteps}）。`, "maxSteps");

        const results = await Promise.allSettled(pending.map((step) => runStep(step, index)));
        const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failed) throw failed.reason;
      }

      const last = stages[stages.length - 1]!;
      let output =
        last.length === 1
          ? outputs[last[0]!.id]!
          : last.map((s) => `## ${s.name}\n\n${outputs[s.id] ?? ""}`).join("\n\n");
      if (limits.maxChars && output.length > limits.maxChars) {
        output = `${output.slice(0, limits.maxChars)}\n\n…（按约束截断到 ${limits.maxChars} 字）`;
        await event(runId, "output_truncated", `最终输出超过 ${limits.maxChars} 字，已截断`, null);
      }
      await persistNow({ status: "succeeded", output, error: null, finishedAt: now() });
      await event(runId, "run_finished", `运行完成：${state.stepsRun} 步，约 ${state.tokens} token，用时 ${Math.round(elapsed() / 1000)} 秒`, null, {
        tokens: state.tokens,
        steps: state.stepsRun,
        elapsedMs: elapsed(),
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
      await persistNow({ status: cancelled ? "cancelled" : "failed", error: message, finishedAt: now() });
      await event(runId, cancelled ? "run_cancelled" : "run_failed", cancelled ? "运行已停止" : `运行失败：${message}`, null);
      await audit(run, "workflow.run_finished", { status: cancelled ? "cancelled" : "failed", reason: message, tokens: state.tokens, steps: state.stepsRun });
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      if (persistTimer) clearTimeout(persistTimer);
      active.delete(runId);
      if (slot.rerun) void execute(runId);
    }
  }

  async function approve(input: { ownerUserId: string; runId: string; stepId: string; decision: "approve" | "reject"; comment?: string; by: string }) {
    const run = await store.getOwnRun(input.ownerUserId, input.runId);
    if (!run) throw new WorkflowRunError("找不到这次运行。", 404);
    const step = run.state.steps.find((s) => s.id === input.stepId);
    if (run.status !== "waiting_approval" || !step || step.status !== "waiting_approval")
      throw new WorkflowRunError("这一步现在不需要审批。", 409);
    step.approval = {
      required: true,
      ...(step.approval?.note ? { note: step.approval.note } : {}),
      decision: input.decision,
      decidedBy: input.by,
      decidedAt: now().toISOString(),
      ...(input.comment ? { comment: input.comment.slice(0, 500) } : {}),
    };
    const rejected = input.decision === "reject";
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
      });
      if (!marked) continue;
      failed += 1;
      await event(run.id, "run_failed", "服务器重启，运行中断了", null);
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

  return { start, execute, approve, cancel, remove, recover, view, isActive: (id: string) => active.has(id) };
}

export type WorkflowEngine = ReturnType<typeof createWorkflowEngine>;
