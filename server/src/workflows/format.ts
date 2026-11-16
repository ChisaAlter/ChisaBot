/**
 * WORKFLOW.md：YAML 前言 = 完整定义（shared/workflows.ts 的 workflowDefinitionSchema），正文 = 给人看
 * 的说明（存进 definition.notes）。导入、导出、预设都走这里，保证同一份文件来回不走样。
 */
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  WORKFLOW_FORMAT,
  type WorkflowDefinition,
  type WorkflowScheduleDraft,
  workflowDefinitionSchema,
  workflowProblems,
} from "../../../shared/workflows";

export class WorkflowFormatError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "WorkflowFormatError";
  }
}

const MAX_FILE_BYTES = 256 * 1024;

/** zod 的报错变成一句一句的中文，带上字段路径。 */
export function zodProblems(error: {
  issues: { path: PropertyKey[]; message: string }[];
}): string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const where = issue.path
      .map((p) => (typeof p === "number" ? `[${p + 1}]` : `.${String(p)}`))
      .join("")
      .replace(/^\./, "");
    return where ? `${where}：${issue.message}` : issue.message;
  });
}

/** 校验并补默认值。`librarySkills` 给了就检查步骤引用的库技能存在。 */
export function validateDefinition(
  raw: unknown,
  librarySkills?: ReadonlySet<string>,
): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success)
    throw new WorkflowFormatError(
      "工作流定义有问题。",
      zodProblems(parsed.error),
    );
  const problems = workflowProblems(parsed.data, librarySkills);
  if (problems.length > 0)
    throw new WorkflowFormatError("工作流定义有问题。", problems);
  return parsed.data;
}

/** 读 WORKFLOW.md（也接受纯 YAML 或 JSON）。 */
export function parseWorkflowMarkdown(
  text: string,
  librarySkills?: ReadonlySet<string>,
): WorkflowDefinition {
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES)
    throw new WorkflowFormatError("文件太大（最多 256 KB）。");
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  let front: unknown;
  let body = "";
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
  try {
    if (match) {
      front = parse(match[1] ?? "", { maxAliasCount: 0 });
      body = (match[2] ?? "").trim();
    } else if (source.trimStart().startsWith("{")) {
      front = JSON.parse(source);
    } else {
      front = parse(source, { maxAliasCount: 0 });
    }
  } catch (error) {
    throw new WorkflowFormatError(
      `无法解析文件：${error instanceof Error ? error.message.split("\n")[0] : "格式错误"}`,
    );
  }
  if (!front || typeof front !== "object" || Array.isArray(front))
    throw new WorkflowFormatError(
      "文件开头需要 YAML 前言（--- 包起来的工作流定义）。",
    );
  const record = front as Record<string, unknown>;
  if (record.format !== undefined && record.format !== WORKFLOW_FORMAT)
    throw new WorkflowFormatError(
      `不认识的格式「${String(record.format)}」，需要 ${WORKFLOW_FORMAT}。`,
    );
  if (body && record.notes === undefined) record.notes = body;
  return validateDefinition(record, librarySkills);
}

/** 写成 WORKFLOW.md。字段顺序固定，便于阅读和比对。 */
export function serializeWorkflowMarkdown(def: WorkflowDefinition): string {
  const { notes, ...rest } = def;
  const ordered: Record<string, unknown> = {
    format: WORKFLOW_FORMAT,
    slug: rest.slug,
    name: rest.name,
    description: rest.description,
    icon: rest.icon,
    ...(rest.version ? { version: rest.version } : {}),
    ...(rest.tags?.length ? { tags: rest.tags } : {}),
    bots: rest.bots,
    ...(rest.skills?.length ? { skills: rest.skills } : {}),
    inputs: rest.inputs,
    steps: rest.steps,
    ...(rest.schedule ? { schedule: rest.schedule } : {}),
    constraints: rest.constraints,
  };
  const yaml = stringify(ordered, {
    lineWidth: 0,
    blockQuote: "literal",
  }).trimEnd();
  const body =
    notes?.trim() || `# ${def.name}\n\n${def.description || ""}`.trim();
  return `---\n${yaml}\n---\n\n${body}\n`;
}

const REDACTED = "<REDACTED>";
const PREFIX_KEY_RE = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g;
const CHISABOT_TOKEN_RE = /(?<![A-Za-z0-9_-])cb[pd]_[A-Za-z0-9_-]{12,}/g;
const BEARER_TOKEN_RE = /\b(Bearer)\s+[A-Za-z0-9._-]{12,}/gi;
const URL_USERINFO_RE = /(https?:\/\/)[^:\s/@]+:[^@\s/]+@/gi;
const ENV_ASSIGNMENT_RE =
  /([A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD))=(["']?)([^\s"'\n]{6,})\2/gi;

/** 识别常见密钥、令牌与账密赋值并替换为 `<REDACTED>`（幂等）。 */
export function redactSecretText(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(PREFIX_KEY_RE, REDACTED);
  out = out.replace(CHISABOT_TOKEN_RE, REDACTED);
  out = out.replace(BEARER_TOKEN_RE, "$1 <REDACTED>");
  out = out.replace(URL_USERINFO_RE, `$1${REDACTED}@`);
  out = out.replace(
    ENV_ASSIGNMENT_RE,
    (match, keyName: string, quote: string, val: string) =>
      val === REDACTED ? match : `${keyName}=${quote}${REDACTED}${quote}`,
  );
  return out;
}

/** 深拷贝工作流定义并对文本字段脱敏，默认清空私有 `bots[].botId`。 */
export function redactWorkflowDefinition(
  def: WorkflowDefinition,
  options?: { stripBotIds?: boolean },
): WorkflowDefinition {
  const stripBotIds = options?.stripBotIds ?? true;
  const cloned = structuredClone(def);
  cloned.description = redactSecretText(cloned.description);
  if (cloned.notes !== undefined) {
    cloned.notes = redactSecretText(cloned.notes);
  }
  for (const input of cloned.inputs) {
    if (typeof input.default === "string") {
      input.default = redactSecretText(input.default);
    }
    if (input.placeholder !== undefined) {
      input.placeholder = redactSecretText(input.placeholder);
    }
    if (input.help !== undefined) {
      input.help = redactSecretText(input.help);
    }
  }
  for (const bot of cloned.bots) {
    if (bot.description !== undefined) {
      bot.description = redactSecretText(bot.description);
    }
    if (stripBotIds) {
      delete bot.botId;
    }
  }
  for (const step of cloned.steps) {
    step.prompt = redactSecretText(step.prompt);
    if (step.approvalNote !== undefined) {
      step.approvalNote = redactSecretText(step.approvalNote);
    }
  }
  if (cloned.skills) {
    for (const skill of cloned.skills) {
      skill.instructions = redactSecretText(skill.instructions);
    }
  }
  if (cloned.schedule?.title !== undefined) {
    cloned.schedule.title = redactSecretText(cloned.schedule.title);
  }
  if (cloned.constraints.output?.instructions !== undefined) {
    cloned.constraints.output.instructions = redactSecretText(
      cloned.constraints.output.instructions,
    );
  }
  return cloned;
}

/** 导出脱敏后的 WORKFLOW.md（默认剥离内部 botId）。 */
export function serializeRedactedWorkflowMarkdown(
  def: WorkflowDefinition,
  options?: { stripBotIds?: boolean },
): string {
  return serializeWorkflowMarkdown(redactWorkflowDefinition(def, options));
}

export type WorkflowScheduleHint = WorkflowScheduleDraft & {
  title: string;
  paused: true;
  source: "schedule" | "notes";
};

const CRON_FIELD =
  "(?:\\*(?:/\\d+)?|[0-9]{1,2}(?:-[0-9]{1,2})?(?:/\\d+)?(?:,[0-9]{1,2}(?:-[0-9]{1,2})?(?:/\\d+)?)*)";
const EXPLICIT_CRON_RE = new RegExp(
  `(?:(?:cron|schedule|定时(?:表达式)?)\\s*[:：=]\\s*[\`"']?(${CRON_FIELD}(?:\\s+${CRON_FIELD}){4})[\`"']?|\`(${CRON_FIELD}(?:\\s+${CRON_FIELD}){4})\`)`,
  "i",
);
const STANDALONE_CRON_RE = new RegExp(
  `(?:^|[\\s(（])(${CRON_FIELD}(?:\\s+${CRON_FIELD}){4})(?=$|[\\s)），。,.])`,
  "m",
);

/** 从 `schedule` 前言字段或正文的显式 Cron 表达式提取定时触发草稿。 */
export function extractScheduleHintsFromWorkflow(
  def: WorkflowDefinition,
): WorkflowScheduleHint | null {
  if (def.schedule?.cron) {
    return {
      cron: def.schedule.cron.trim(),
      title: def.schedule.title?.trim() || def.name,
      ...(def.schedule.timezone ? { timezone: def.schedule.timezone } : {}),
      paused: true,
      source: "schedule",
    };
  }
  const text = [def.notes ?? "", def.description ?? ""]
    .filter(Boolean)
    .join("\n");
  if (!text) return null;
  const explicit = EXPLICIT_CRON_RE.exec(text);
  const explicitExpr = (explicit?.[1] ?? explicit?.[2])
    ?.trim()
    .replace(/\s+/g, " ");
  if (explicitExpr && explicitExpr.split(" ").length === 5) {
    return {
      cron: explicitExpr,
      title: def.name,
      paused: true,
      source: "notes",
    };
  }
  const standalone = STANDALONE_CRON_RE.exec(text);
  const standaloneExpr = standalone?.[1]?.trim().replace(/\s+/g, " ");
  if (standaloneExpr) {
    const fields = standaloneExpr.split(" ");
    if (
      fields.length === 5 &&
      fields.some((f) => f.includes("*") || f.includes("/") || f.includes("-"))
    ) {
      return {
        cron: standaloneExpr,
        title: def.name,
        paused: true,
        source: "notes",
      };
    }
  }
  return null;
}

function deriveTranscriptSlug(name: string, explicitSlug?: string): string {
  if (explicitSlug !== undefined) {
    const trimmed = explicitSlug.trim().toLowerCase();
    if (!trimmed) throw new WorkflowFormatError("工作流标识（slug）不能为空。");
    return trimmed;
  }
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (ascii && /^[a-z0-9][a-z0-9-]*$/.test(ascii)) return ascii;
  const hash = createHash("sha256")
    .update(name.trim())
    .digest("hex")
    .slice(0, 8);
  return `thread-${hash}`;
}

function neutralizeUnknownTemplateRefs(text: string): string {
  return text.replace(
    /\{\{\s*(inputs|steps)\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
    (match, kind: string, refKey: string) =>
      kind === "inputs" && refKey === "context"
        ? match
        : `{ { ${kind}.${refKey} } }`,
  );
}

function clipText(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars - 1))}…`
    : text;
}

/** 从真实聊天记录提炼可复用的标准化工作流定义（自动脱敏后再校验输出）。 */
export function buildWorkflowFromTranscript(input: {
  name: string;
  slug?: string;
  messages: readonly { role: string; text: string }[];
}): WorkflowDefinition {
  const cleanName = redactSecretText(input.name).trim();
  if (!cleanName) throw new WorkflowFormatError("工作流名称不能为空。");
  const name = cleanName.slice(0, 40);
  const slug = deriveTranscriptSlug(name, input.slug);

  const normalizedMessages = input.messages
    .map((m) => ({
      role: m.role.trim().toLowerCase() || "user",
      text: redactSecretText(m.text).trim(),
    }))
    .filter((m) => m.text.length > 0);
  if (normalizedMessages.length === 0) {
    throw new WorkflowFormatError(
      "聊天记录不能为空，至少需要一条消息来提炼工作流。",
    );
  }

  type Segment = { userTexts: string[]; assistantTexts: string[] };
  const segments: Segment[] = [];
  for (const msg of normalizedMessages) {
    if (msg.role === "user") {
      segments.push({ userTexts: [msg.text], assistantTexts: [] });
    } else {
      const current = segments[segments.length - 1];
      if (current) {
        current.assistantTexts.push(msg.text);
      } else {
        segments.push({ userTexts: [msg.text], assistantTexts: [] });
      }
    }
  }

  const MAX_GRADUATED_STEPS = 12;
  const grouped: Segment[] =
    segments.length <= MAX_GRADUATED_STEPS
      ? segments
      : [
          ...segments.slice(0, MAX_GRADUATED_STEPS - 1),
          {
            userTexts: segments
              .slice(MAX_GRADUATED_STEPS - 1)
              .flatMap((s) => s.userTexts),
            assistantTexts: segments
              .slice(MAX_GRADUATED_STEPS - 1)
              .flatMap((s) => s.assistantTexts),
          },
        ];

  const steps = grouped.map((seg, idx) => {
    const rawTitle =
      seg.userTexts[0]?.split(/\r?\n/)[0]?.trim() || `步骤 ${idx + 1}`;
    const stepName = clipText(rawTitle, 32) || `步骤 ${idx + 1}`;
    const goal = neutralizeUnknownTemplateRefs(
      clipText(seg.userTexts.join("\n\n"), 4000),
    );
    const expected = seg.assistantTexts.length
      ? neutralizeUnknownTemplateRefs(
          clipText(seg.assistantTexts.join("\n\n"), 2000),
        )
      : "";
    const parts = [
      `请完成以下任务：\n${goal}`,
      ...(idx === 0 ? ["补充上下文（如有）：{{inputs.context}}"] : []),
      ...(expected ? [`参考历史成功输出风格与要点：\n${expected}`] : []),
    ];
    return {
      id: `step_${idx + 1}`,
      name: stepName,
      bot: "assistant",
      prompt: clipText(parts.join("\n\n"), 7800),
    };
  });

  const firstSummary =
    grouped[0]?.userTexts[0] ?? normalizedMessages[0]?.text ?? name;
  const description = clipText(firstSummary.replace(/\s+/g, " "), 380);
  const transcriptLines = normalizedMessages
    .slice(0, 20)
    .map(
      (m) => `- **${m.role}**：${clipText(m.text.replace(/\s+/g, " "), 300)}`,
    );
  const notes = clipText(
    [
      `# ${name}`,
      "",
      "由真实会话沉淀并经过密钥脱敏生成的标准化工作流。",
      "",
      "## 原始会话摘要",
      ...transcriptLines,
    ].join("\n"),
    19_000,
  );

  const validated = validateDefinition({
    format: WORKFLOW_FORMAT,
    slug,
    name,
    description,
    icon: "⚙️",
    tags: ["会话沉淀"],
    bots: [
      {
        key: "assistant",
        name: "助手",
        description: "按会话沉淀的步骤要求执行任务并交付结果。",
      },
    ],
    inputs: [
      {
        key: "context",
        label: "补充上下文",
        type: "textarea",
        required: false,
        placeholder: "可选：填写本次执行需要补充或覆盖的背景信息",
      },
    ],
    steps,
    constraints: {
      maxSteps: steps.length,
      output: { format: "markdown" },
    },
    notes,
  });

  return redactWorkflowDefinition(validated, { stripBotIds: true });
}
