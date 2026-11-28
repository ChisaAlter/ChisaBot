/**
 * 结构化用户表单契约（CB-147）：schema 化多字段表单从问答闭环恢复执行。
 *
 * 在现有 ask_person / person.question 工作队列上演进：问题可携带 fields 结构化字段，
 * 回答从自由文本升级为按 schema 校验的键值对，提交后原 run 恢复。
 *
 * 红线：禁止 password/token/secret 类字段——凭据永远走 vault 专用路径，不进表单不进日志。
 */

import { z } from "zod";

export const USER_FORM_FIELD_TYPES = [
  "text",
  "textarea",
  "select",
  "multiselect",
  "confirm",
] as const;
export type UserFormFieldType = (typeof USER_FORM_FIELD_TYPES)[number];

const fieldBase = {
  /** 字段 id——答案键，同一表单内唯一。 */
  id: z.string().min(1).max(80),
  /** 展示标签。 */
  label: z.string().min(1).max(200),
  /** 补充说明（为什么需要这个值）。 */
  hint: z.string().max(500).optional(),
  /** 缺省必填；confirm 字段必填语义=必须显式选择（true/false 都算作答）。 */
  required: z.boolean().optional(),
};

export const userFormFieldSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    ...fieldBase,
    defaultValue: z.string().max(2000).optional(),
    placeholder: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("textarea"),
    ...fieldBase,
    defaultValue: z.string().max(8000).optional(),
    placeholder: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("select"),
    ...fieldBase,
    options: z.array(z.string().min(1).max(200)).min(1).max(50),
    defaultValue: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("multiselect"),
    ...fieldBase,
    options: z.array(z.string().min(1).max(200)).min(1).max(50),
    defaultValue: z.array(z.string().max(200)).max(50).optional(),
  }),
  z.object({
    type: z.literal("confirm"),
    ...fieldBase,
    defaultValue: z.boolean().optional(),
  }),
]);
export type UserFormField = z.infer<typeof userFormFieldSchema>;

export const userFormFieldsSchema = z.array(userFormFieldSchema).min(1).max(20);

/** 凭据味字段拒收：type 不存在 password，但 id/label 夹带同样违规。 */
const FORBIDDEN_PATTERN = /password|passwd|token|secret|credential|api[_-]?key/i;

export function forbiddenFormFieldReason(field: UserFormField): string | null {
  if (FORBIDDEN_PATTERN.test(field.id) || FORBIDDEN_PATTERN.test(field.label)) {
    return `字段「${field.label}」疑似凭据类输入——凭据请走保管库（vault）专用路径，表单不承载。`;
  }
  return null;
}

/** 整表校验：schema 合法 + id 唯一 + 无凭据味字段；返回中文错误串或 null。 */
export function validateUserFormFields(fields: unknown):
  | { ok: true; fields: UserFormField[] }
  | { ok: false; error: string } {
  const parsed = userFormFieldsSchema.safeParse(fields);
  if (!parsed.success) {
    return { ok: false, error: "表单字段定义不合法。" };
  }
  const ids = new Set<string>();
  for (const field of parsed.data) {
    if (ids.has(field.id)) {
      return { ok: false, error: `字段 id「${field.id}」重复。` };
    }
    ids.add(field.id);
    const forbidden = forbiddenFormFieldReason(field);
    if (forbidden) return { ok: false, error: forbidden };
  }
  return { ok: true, fields: parsed.data };
}

/** 单字段答案校验+归一化；返回错误串或归一值（string | string[] | boolean）。 */
export function validateFieldAnswer(
  field: UserFormField,
  raw: unknown,
): { ok: true; value: string | string[] | boolean } | { ok: false; error: string } {
  const required = field.required !== false;
  switch (field.type) {
    case "text":
    case "textarea": {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) {
        if (required && !field.defaultValue) {
          return { ok: false, error: `「${field.label}」必填。` };
        }
        return { ok: true, value: value || (field.defaultValue ?? "") };
      }
      const cap = field.type === "text" ? 2000 : 8000;
      if (value.length > cap) {
        return { ok: false, error: `「${field.label}」超出长度上限。` };
      }
      return { ok: true, value };
    }
    case "select": {
      const value = typeof raw === "string" ? raw : "";
      if (!value) {
        if (required && !field.defaultValue) {
          return { ok: false, error: `「${field.label}」必选一項。` };
        }
        const fallback = field.defaultValue ?? "";
        if (fallback && !field.options.includes(fallback)) {
          return { ok: false, error: `「${field.label}」默认值不在选项内。` };
        }
        return { ok: true, value: fallback };
      }
      if (!field.options.includes(value)) {
        return { ok: false, error: `「${field.label}」的值不在选项内。` };
      }
      return { ok: true, value };
    }
    case "multiselect": {
      const list = Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === "string")
        : [];
      if (list.length === 0) {
        if (required && (!field.defaultValue || field.defaultValue.length === 0)) {
          return { ok: false, error: `「${field.label}」至少选一项。` };
        }
        return { ok: true, value: field.defaultValue ?? [] };
      }
      for (const item of list) {
        if (!field.options.includes(item)) {
          return { ok: false, error: `「${field.label}」含非法选项。` };
        }
      }
      return { ok: true, value: [...new Set(list)] };
    }
    case "confirm": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (required && typeof field.defaultValue !== "boolean") {
        return { ok: false, error: `「${field.label}」需要明确选择。` };
      }
      return { ok: true, value: field.defaultValue ?? false };
    }
  }
}

/** 把结构化答案合成恢复 run 的人读文本（附在问题后，与自由文本答案同构）。 */
export function renderFormAnswersText(
  fields: readonly UserFormField[],
  answers: Record<string, string | string[] | boolean>,
): string {
  const lines: string[] = [];
  for (const field of fields) {
    const value = answers[field.id];
    if (value === undefined) continue;
    const rendered = Array.isArray(value)
      ? value.join("、")
      : typeof value === "boolean"
        ? value
          ? "是"
          : "否"
        : value;
    lines.push(`${field.label}：${rendered || "（空）"}`);
  }
  return lines.join("\n");
}
