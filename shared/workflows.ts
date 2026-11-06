/**
 * ChisaBot 预设工作流（docs/workflows.md）。服务器、网页读同一份定义。
 *
 * 一个工作流 = 1–N 个机器人角色 + 若干技能 + 有序步骤（相邻且同一「并行组」的步骤同时跑）
 * + 运行时让人填的输入参数 + 约束（步骤数、token 预算、时间、工具允许/禁止、审批、输出格式）。
 *
 * 文件格式是 WORKFLOW.md：YAML 前言放完整定义，正文是给人看的说明。导入、导出、预设都是这个格式，
 * 和技能一样可以复制、分享。服务器解析 YAML，这里只放与格式无关的结构和规则，网页编辑器也用它校验。
 */
import { z } from "zod";

export const WORKFLOW_FORMAT = "chisabot.workflow/v1";

/** 工具分组：约束里的允许 / 禁止按组写，也可以写具体工具名（如 computer_navigate）。 */
export const WORKFLOW_TOOL_GROUPS = [
  "computer",
  "devices",
  "host",
  "apps",
  "memory",
  "schedule",
  "ui",
  "handoff",
] as const;
export type WorkflowToolGroup = (typeof WORKFLOW_TOOL_GROUPS)[number];

export const TOOL_GROUP_INFO: Record<WorkflowToolGroup, { label: string; description: string }> = {
  computer: { label: "云端浏览器", description: "打开网页、点击、读取页面、在工作区读写文件（computer_*）" },
  devices: { label: "设备", description: "操作已关联的电脑 / 手机（device_*）" },
  host: { label: "本机文件夹", description: "读写桌面端授权的本机文件夹（host_*）" },
  apps: { label: "已连接的应用", description: "插件 / MCP 工具，如 GitHub、Google" },
  memory: { label: "记忆", description: "读写个人记忆" },
  schedule: { label: "提醒与定时", description: "稍后提醒、唤醒（lifecycle）" },
  ui: { label: "界面与面板", description: "render_ui 生成式界面、组件、保存面板" },
  handoff: { label: "找别的机器人", description: "message_bot 把活交给另一个机器人" },
};

/** 一个工具属于哪个分组。名字和 ref 都看，认不出的算 apps（插件工具的名字是供应商起的）。 */
export function toolGroupOf(name: string, ref?: string): WorkflowToolGroup {
  if (name.startsWith("computer_")) return "computer";
  if (name.startsWith("device_")) return "devices";
  if (name.startsWith("host_")) return "host";
  if (ref?.startsWith("memory/")) return "memory";
  if (ref?.startsWith("lifecycle/")) return "schedule";
  if (name === "render_ui" || ref?.startsWith("components/") || name === "proposePanelDraft" || name === "revisePanelDraft")
    return "ui";
  if (name === "message_bot" || name === "ask_person") return "handoff";
  return "apps";
}

export type ToolRule = { allow?: string[]; deny?: string[] };

/**
 * 允许 / 禁止的判定（服务器在给模型列工具时和执行时各判一次）。
 * 规则：deny 优先；有 allow 时只放行 allow 里的；条目可以是分组名或具体工具名。
 * 步骤自己的规则叠加在工作流规则上：两边任一禁止即禁止；两边的 allow 取交集。
 */
export function toolAllowed(rules: ToolRule[], name: string, ref?: string): boolean {
  const group = toolGroupOf(name, ref);
  const hit = (list: string[]) => list.includes(name) || list.includes(group) || (ref ? list.includes(ref) : false);
  for (const rule of rules) {
    if (rule.deny && hit(rule.deny)) return false;
  }
  for (const rule of rules) {
    if (rule.allow && rule.allow.length > 0 && !hit(rule.allow)) return false;
  }
  return true;
}

const slug = z
  .string()
  .trim()
  .min(1, "不能为空")
  .max(48, "最多 48 个字符")
  .regex(/^[a-z0-9][a-z0-9-]*$/, "只能用小写字母、数字和连字符");
const key = z
  .string()
  .trim()
  .min(1, "不能为空")
  .max(32, "最多 32 个字符")
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "以字母开头，只能用字母、数字、下划线");
const toolList = z.array(z.string().trim().min(1).max(80)).max(40);
const toolRule = z.object({ allow: toolList.optional(), deny: toolList.optional() }).strict();

export const workflowBotSchema = z
  .object({
    key,
    name: z.string().trim().min(1, "角色名不能为空").max(24),
    description: z.string().trim().max(400).optional(),
    /** 编辑者绑定的机器人 id（只对自己的工作流有意义，导出时保留，导入后找不到就运行时再选）。 */
    botId: z.string().trim().max(200).optional(),
  })
  .strict();

export const workflowSkillSchema = z
  .object({
    slug,
    title: z.string().trim().min(1).max(60),
    instructions: z.string().trim().min(1, "技能内容不能为空").max(8000),
  })
  .strict();

export const WORKFLOW_INPUT_TYPES = ["text", "textarea", "number", "select", "boolean", "url"] as const;
export type WorkflowInputType = (typeof WORKFLOW_INPUT_TYPES)[number];
export const INPUT_TYPE_LABEL: Record<WorkflowInputType, string> = {
  text: "单行文字",
  textarea: "多行文字",
  number: "数字",
  select: "下拉选择",
  boolean: "开关",
  url: "网址",
};

export const workflowInputSchema = z
  .object({
    key,
    label: z.string().trim().min(1, "名称不能为空").max(40),
    type: z.enum(WORKFLOW_INPUT_TYPES).default("text"),
    required: z.boolean().optional(),
    default: z.union([z.string().max(4000), z.number(), z.boolean()]).optional(),
    options: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    placeholder: z.string().max(120).optional(),
    help: z.string().max(200).optional(),
  })
  .strict();

export const WORKFLOW_OUTPUT_FORMATS = ["markdown", "text", "json"] as const;
export type WorkflowOutputFormat = (typeof WORKFLOW_OUTPUT_FORMATS)[number];
export const OUTPUT_FORMAT_LABEL: Record<WorkflowOutputFormat, string> = {
  markdown: "Markdown",
  text: "纯文本",
  json: "JSON",
};

export const WORKFLOW_HANDOFFS = ["previous", "all", "none"] as const;
export type WorkflowHandoff = (typeof WORKFLOW_HANDOFFS)[number];
export const HANDOFF_LABEL: Record<WorkflowHandoff, string> = {
  previous: "上一步的输出",
  all: "之前所有步骤的输出",
  none: "不带入",
};

export const WORKFLOW_ON_FAILURES = ["fail", "reject", "continue"] as const;
export type WorkflowOnFailure = (typeof WORKFLOW_ON_FAILURES)[number];
export const ON_FAILURE_LABEL: Record<WorkflowOnFailure, string> = {
  fail: "停止运行",
  reject: "打回前面步骤重做",
  continue: "跳过错误继续下一步",
};

export const WORKFLOW_RETRY_STRATEGIES = ["targeted_fix", "full_redo"] as const;
export type WorkflowRetryStrategy = (typeof WORKFLOW_RETRY_STRATEGIES)[number];
export const RETRY_STRATEGY_LABEL: Record<WorkflowRetryStrategy, string> = {
  targeted_fix: "保留记忆继续修正",
  full_redo: "清空上下文重新开始",
};

export const workflowStepGateSchema = z
  .object({
    /** 开启后，机器人通过 submit_gate_result 提交 pass / rework / fail / human 结构化裁决。 */
    enabled: z.boolean(),
    /** 未配置 rejectTo 时，本步骤内部自修正的最大循环次数（默认 2）。 */
    maxLoops: z.number().int().min(1).max(5).optional(),
  })
  .strict();
export type WorkflowStepGate = z.infer<typeof workflowStepGateSchema>;

export const workflowStepSchema = z
  .object({
    id: key,
    name: z.string().trim().min(1, "步骤名不能为空").max(40),
    /** 由哪个角色（bots[].key）来做。 */
    bot: key,
    /** 要求。可以写 {{inputs.topic}}、{{steps.collect}} 引用输入和前面步骤的输出。 */
    prompt: z.string().trim().min(1, "步骤要求不能为空").max(8000),
    /** 本步骤使用的技能：工作流自带的技能 slug，或「技能」页里的技能 slug。 */
    skills: z.array(slug).max(8).optional(),
    /** 前面步骤的输出怎么交给这一步。默认 previous。 */
    handoff: z.enum(WORKFLOW_HANDOFFS).optional(),
    /** 相邻且 group 相同的步骤并行执行。 */
    group: z.string().trim().max(24).optional(),
    /** 这一步开始前需要人工批准。 */
    approval: z.boolean().optional(),
    /** 审批时给人看的说明。 */
    approvalNote: z.string().trim().max(400).optional(),
    /** 审批拒绝、验证门打回或失败打回时，退回到前面的哪个步骤 id 重新执行。 */
    rejectTo: key.optional(),
    /** 这一步最多允许被下游打回返工几次（默认 3）。 */
    maxReworks: z.number().int().min(1).max(10).optional(),
    /** 步骤执行失败时的策略：默认 fail（停止运行），可选 reject（打回 rejectTo）或 continue（忽略错误继续）。 */
    onFailure: z.enum(WORKFLOW_ON_FAILURES).optional(),
    /** 重试或返工时的上下文策略：默认 targeted_fix（复用原对话带记忆修正），可选 full_redo（新建对话重跑）。 */
    retryStrategy: z.enum(WORKFLOW_RETRY_STRATEGIES).optional(),
    /** 结构化验证门（Gate）：由机器人提交 pass / rework / fail / human 裁决。 */
    gate: workflowStepGateSchema.optional(),
    /** 只对这一步生效的工具规则，叠加在工作流约束上。 */
    tools: toolRule.optional(),
    /** 这一步可以把面板直接保存到该机器人的右栏面板（需要「界面与面板」工具）。 */
    panel: z.boolean().optional(),
    /** 这一步的输出格式。最后一步不写时用约束里的输出格式。 */
    output: z.enum(WORKFLOW_OUTPUT_FORMATS).optional(),
  })
  .strict();

export const workflowConstraintsSchema = z
  .object({
    /** 最多执行多少个步骤（每个步骤算一次机器人回合）。 */
    maxSteps: z.number().int().min(1).max(30).optional(),
    /** token 预算（估算：输入 + 输出，中文按字、其他按 4 字符 1 token）。 */
    maxTokens: z.number().int().min(1000).max(2_000_000).optional(),
    /** 整个运行的时间上限（分钟，不含等待审批的时间）。 */
    timeLimitMinutes: z.number().int().min(1).max(240).optional(),
    /** 单个步骤的时间上限（分钟）。 */
    stepTimeoutMinutes: z.number().int().min(1).max(5).optional(),
    tools: toolRule.optional(),
    output: z
      .object({
        format: z.enum(WORKFLOW_OUTPUT_FORMATS).optional(),
        maxChars: z.number().int().min(200).max(200_000).optional(),
        /** 对最终输出的补充要求，如「用表格列出问题」。 */
        instructions: z.string().trim().max(1000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    format: z.literal(WORKFLOW_FORMAT).default(WORKFLOW_FORMAT),
    slug,
    name: z.string().trim().min(1, "名称不能为空").max(40),
    description: z.string().trim().max(400).default(""),
    /** 一个 emoji。 */
    icon: z.string().trim().max(8).default("⚙️"),
    version: z.string().trim().max(20).optional(),
    tags: z.array(z.string().trim().min(1).max(16)).max(8).optional(),
    bots: z.array(workflowBotSchema).min(1, "至少要有一个机器人角色").max(8, "最多 8 个机器人角色"),
    skills: z.array(workflowSkillSchema).max(12).optional(),
    inputs: z.array(workflowInputSchema).max(16).default([]),
    steps: z.array(workflowStepSchema).min(1, "至少要有一个步骤").max(30, "最多 30 个步骤"),
    constraints: workflowConstraintsSchema.default({}),
    /** WORKFLOW.md 正文（给人看的说明）。 */
    notes: z.string().max(20_000).optional(),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowBot = z.infer<typeof workflowBotSchema>;
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type WorkflowSkill = z.infer<typeof workflowSkillSchema>;
export type WorkflowConstraints = z.infer<typeof workflowConstraintsSchema>;

export const DEFAULT_LIMITS = {
  maxTokens: 60_000,
  timeLimitMinutes: 20,
  stepTimeoutMinutes: 5,
} as const;

/** 生效的约束（填好默认值）。 */
export function effectiveConstraints(def: WorkflowDefinition) {
  const c = def.constraints ?? {};
  return {
    maxSteps: c.maxSteps ?? def.steps.length,
    maxTokens: c.maxTokens ?? DEFAULT_LIMITS.maxTokens,
    timeLimitMinutes: c.timeLimitMinutes ?? DEFAULT_LIMITS.timeLimitMinutes,
    stepTimeoutMinutes: c.stepTimeoutMinutes ?? DEFAULT_LIMITS.stepTimeoutMinutes,
    tools: c.tools ?? {},
    outputFormat: c.output?.format ?? ("markdown" as WorkflowOutputFormat),
    maxChars: c.output?.maxChars,
    outputInstructions: c.output?.instructions,
  };
}

/**
 * 结构上的检查（zod 之外）：key 唯一、步骤引用的角色和技能存在、模板引用的输入和步骤存在、
 * 并行组相邻、打回目标在前面、步骤数不超过 maxSteps。`librarySkills` 是此人能用的技能 slug；不传就不检查库技能。
 */
export function workflowProblems(def: WorkflowDefinition, librarySkills?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const dup = (list: string[], what: string) => {
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item)) problems.push(`${what}「${item}」重复了。`);
      seen.add(item);
    }
  };
  dup(def.bots.map((b) => b.key), "机器人角色");
  dup(def.steps.map((s) => s.id), "步骤 id");
  dup(def.inputs.map((i) => i.key), "输入参数");
  dup((def.skills ?? []).map((s) => s.slug), "技能");
  const bots = new Set(def.bots.map((b) => b.key));
  const embedded = new Set((def.skills ?? []).map((s) => s.slug));
  const inputs = new Set(def.inputs.map((i) => i.key));
  const allStepsById = new Map(def.steps.map((s) => [s.id, s]));
  const seenSteps = new Set<string>();
  def.steps.forEach((step, index) => {
    const label = `第 ${index + 1} 步「${step.name}」`;
    if (!bots.has(step.bot)) problems.push(`${label}用的角色「${step.bot}」不存在。`);
    for (const skill of step.skills ?? []) {
      if (!embedded.has(skill) && librarySkills && !librarySkills.has(skill))
        problems.push(`${label}用的技能 /${skill} 找不到。`);
    }
    for (const ref of templateRefs(step.prompt)) {
      if (ref.kind === "inputs" && !inputs.has(ref.key)) problems.push(`${label}引用的输入 {{inputs.${ref.key}}} 不存在。`);
      if (ref.kind === "steps" && !seenSteps.has(ref.key)) problems.push(`${label}引用的步骤 {{steps.${ref.key}}} 不在它前面。`);
    }
    if (step.rejectTo) {
      const target = allStepsById.get(step.rejectTo);
      if (!target) {
        problems.push(`${label}打回的目标步骤「${step.rejectTo}」不存在。`);
      } else if (!seenSteps.has(step.rejectTo) || (step.group && target.group === step.group)) {
        problems.push(`${label}打回的目标步骤「${step.rejectTo}」必须在它前面的阶段。`);
      }
    }
    if (step.onFailure === "reject" && !step.rejectTo) {
      problems.push(`${label}设置了失败时打回重做，需要指定打回的目标步骤（rejectTo）。`);
    }
    if (step.group && index > 0) {
      const prev = def.steps[index - 1]!;
      if (prev.group === step.group && step.approval) problems.push(`${label}在并行组里，不能单独设置审批（把审批放在组里第一步）。`);
    }
    seenSteps.add(step.id);
  });
  // 同一个 group 必须连续。
  const closed = new Set<string>();
  let current: string | undefined;
  for (const step of def.steps) {
    if (step.group !== current) {
      if (current) closed.add(current);
      if (step.group && closed.has(step.group)) problems.push(`并行组「${step.group}」的步骤要挨在一起。`);
      current = step.group;
    }
  }
  for (const input of def.inputs) {
    if (input.type === "select" && !(input.options && input.options.length > 0))
      problems.push(`输入「${input.label}」是下拉选择，需要至少一个选项。`);
  }
  const c = effectiveConstraints(def);
  if (def.steps.length > c.maxSteps) problems.push(`步骤数 ${def.steps.length} 超过了约束里的最多步骤数 ${c.maxSteps}。`);
  return problems;
}

/** 模板里的 {{inputs.x}} / {{steps.y}}。 */
export function templateRefs(text: string): { kind: "inputs" | "steps"; key: string }[] {
  const refs: { kind: "inputs" | "steps"; key: string }[] = [];
  for (const match of text.matchAll(/\{\{\s*(inputs|steps)\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g))
    refs.push({ kind: match[1] as "inputs" | "steps", key: match[2]! });
  return refs;
}

/** 把步骤按「阶段」分组：相邻且 group 相同的步骤同一阶段（并行）。 */
export function workflowStages(steps: readonly WorkflowStep[]): WorkflowStep[][] {
  const stages: WorkflowStep[][] = [];
  for (const step of steps) {
    const last = stages[stages.length - 1];
    if (last && step.group && last[0]!.group === step.group) last.push(step);
    else stages.push([step]);
  }
  return stages;
}

/** 估算 token：CJK 字符按 1 个，其余每 4 个字符 1 个。不精确，但对预算控制足够保守。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/u.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

export function emptyWorkflow(): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    slug: "my-workflow",
    name: "新工作流",
    description: "",
    icon: "⚙️",
    bots: [{ key: "assistant", name: "助手" }],
    inputs: [{ key: "task", label: "任务", type: "textarea", required: true }],
    steps: [{ id: "do", name: "完成任务", bot: "assistant", prompt: "完成这个任务：{{inputs.task}}" }],
    constraints: {},
  });
}

// ─── 运行 ───────────────────────────────────────────────────────────────

export const RUN_STATUSES = ["queued", "running", "waiting_approval", "succeeded", "failed", "cancelled"] as const;
export type WorkflowRunStatus = (typeof RUN_STATUSES)[number];
export const RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_approval: "等待审批",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
};
export const ACTIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ["queued", "running", "waiting_approval"];

export const STEP_STATUSES = ["pending", "waiting_approval", "running", "succeeded", "failed", "skipped", "cancelled"] as const;
export type WorkflowStepStatus = (typeof STEP_STATUSES)[number];
export const STEP_STATUS_LABEL: Record<WorkflowStepStatus, string> = {
  pending: "等待中",
  waiting_approval: "等待审批",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  skipped: "已跳过",
  cancelled: "已停止",
};

export type WorkflowGateFinding = {
  severity: "high" | "medium" | "low";
  title: string;
  evidence?: string;
  detail?: string;
};

export type WorkflowGateResult = {
  decision: "pass" | "rework" | "fail" | "human";
  reason: string;
  summary?: string;
  actionRequired?: string;
  findings?: WorkflowGateFinding[];
  submittedAt: string;
};

export type WorkflowStepFeedback = {
  fromStepId?: string;
  by: string;
  reason: string;
  at: string;
  findings?: WorkflowGateFinding[];
};

export type WorkflowStepState = {
  id: string;
  name: string;
  roleKey: string;
  roleName: string;
  botId: string;
  botName: string;
  group?: string;
  status: WorkflowStepStatus;
  output: string;
  error?: string;
  tokens: number;
  startedAt?: string;
  finishedAt?: string;
  approval?: { required: boolean; note?: string; decidedBy?: string; decidedAt?: string; decision?: "approve" | "reject"; comment?: string };
  skills: string[];
  /** 打回目标步骤 id（来自定义，供审批卡片直接展示「打回给…」）。 */
  rejectTo?: string;
  /** 最多允许返工次数。 */
  maxReworks?: number;
  /** 当前是第几次执行尝试（从 1 开始）。 */
  attempt?: number;
  /** 被下游打回返工的累计次数。 */
  reworkCount?: number;
  /** 步骤专属对话的 channelId / threadId（用于 targeted_fix 带记忆重试）。 */
  channelId?: string;
  threadId?: string;
  /** 下次执行时采用的重试模式（targeted_fix 复用原对话，full_redo 开新对话）。 */
  retryMode?: WorkflowRetryStrategy;
  /** 被打回或重试时附带的反馈意见。 */
  feedback?: WorkflowStepFeedback;
  /** 结构化验证门（Gate）提交的裁决结果。 */
  gateResult?: WorkflowGateResult;
};

export type WorkflowPreflightItem = {
  kind: "missing_role_bot" | "missing_skill" | "computer_unavailable" | "device_unpaired";
  severity: "blocking" | "warning";
  message: string;
  stepId?: string;
  roleKey?: string;
};

export type WorkflowRunEventView = {
  id: string;
  at: string;
  kind: string;
  stepId?: string | null;
  message: string;
};

export type WorkflowRunView = {
  id: string;
  workflowId: string;
  workflowName: string;
  icon: string;
  status: WorkflowRunStatus;
  source: "page" | "chat" | "routine" | "api";
  inputs: Record<string, string | number | boolean>;
  steps: WorkflowStepState[];
  usage: { tokens: number; steps: number; elapsedMs: number };
  limits: { maxTokens: number; maxSteps: number; timeLimitMinutes: number; stepTimeoutMinutes: number };
  outputFormat: WorkflowOutputFormat;
  output: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  events?: WorkflowRunEventView[];
  /** 运行开始时的工具规则（展示用）。 */
  tools: ToolRule;
};

export type WorkflowSummary = {
  id: string;
  kind: "preset" | "mine";
  slug: string;
  name: string;
  description: string;
  icon: string;
  tags: string[];
  botCount: number;
  stepCount: number;
  hasApproval: boolean;
  hasParallel: boolean;
  updatedAt: string | null;
};

export type WorkflowDetail = {
  id: string;
  kind: "preset" | "mine";
  definition: WorkflowDefinition;
  markdown: string;
  updatedAt: string | null;
};
