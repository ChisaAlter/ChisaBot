/**
 * WORKFLOW.md：YAML 前言 = 完整定义（shared/workflows.ts 的 workflowDefinitionSchema），正文 = 给人看
 * 的说明（存进 definition.notes）。导入、导出、预设都走这里，保证同一份文件来回不走样。
 */
import { parse, stringify } from "yaml";
import {
  WORKFLOW_FORMAT,
  type WorkflowDefinition,
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
export function zodProblems(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const where = issue.path.map((p) => (typeof p === "number" ? `[${p + 1}]` : `.${String(p)}`)).join("").replace(/^\./, "");
    return where ? `${where}：${issue.message}` : issue.message;
  });
}

/** 校验并补默认值。`librarySkills` 给了就检查步骤引用的库技能存在。 */
export function validateDefinition(raw: unknown, librarySkills?: ReadonlySet<string>): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new WorkflowFormatError("工作流定义有问题。", zodProblems(parsed.error));
  const problems = workflowProblems(parsed.data, librarySkills);
  if (problems.length > 0) throw new WorkflowFormatError("工作流定义有问题。", problems);
  return parsed.data;
}

/** 读 WORKFLOW.md（也接受纯 YAML 或 JSON）。 */
export function parseWorkflowMarkdown(text: string, librarySkills?: ReadonlySet<string>): WorkflowDefinition {
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new WorkflowFormatError("文件太大（最多 256 KB）。");
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
    throw new WorkflowFormatError(`无法解析文件：${error instanceof Error ? error.message.split("\n")[0] : "格式错误"}`);
  }
  if (!front || typeof front !== "object" || Array.isArray(front))
    throw new WorkflowFormatError("文件开头需要 YAML 前言（--- 包起来的工作流定义）。");
  const record = front as Record<string, unknown>;
  if (record.format !== undefined && record.format !== WORKFLOW_FORMAT)
    throw new WorkflowFormatError(`不认识的格式「${String(record.format)}」，需要 ${WORKFLOW_FORMAT}。`);
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
    constraints: rest.constraints,
  };
  const yaml = stringify(ordered, { lineWidth: 0, blockQuote: "literal" }).trimEnd();
  const body = notes?.trim() || `# ${def.name}\n\n${def.description || ""}`.trim();
  return `---\n${yaml}\n---\n\n${body}\n`;
}
