import { z } from "zod";

/**
 * 审批参数 Schema 白名单与辅助审查显式分区（Wave 10 §2.2）：
 *
 * 1. Per-method 参数白名单：所有审批/远端审批决策入口严格按方法名匹配 `z.strictObject`，
 *    绝不透传任意 `args` bag，也绝不允许远端或决策参数注入 `scope: "always"` / 提权字段；
 * 2. 辅助审查显式分区：供未来可选 LLM 辅助审查使用，把 `trusted_user_instructions` 与
 *    `untrusted_agent_narration_and_prior_actions` 严格隔离为结构化分区（不靠单布尔 taint），
 *    并对审查输出执行关闭集合 enum + 逻辑一致性校验，任何异常一律 fail-closed 退回人工审批。
 */

const SAFE_ID = z.string().trim().min(1).max(128);
const SHORT_NOTE = z.string().trim().max(500);

export const APPROVAL_METHOD_SCHEMAS = {
  confirm_decision: z.strictObject({
    requestId: SAFE_ID,
    decision: z.enum(["approve", "deny"]),
    note: SHORT_NOTE.optional(),
  }),
  approval_resolve: z.strictObject({
    requestId: SAFE_ID,
    decision: z.enum(["allow_once", "deny"]),
    reason: SHORT_NOTE.optional(),
  }),
  question_respond: z.strictObject({
    questionId: SAFE_ID,
    response: z.string().trim().min(1).max(6000),
  }),
  device_approval_decision: z.strictObject({
    approvalId: SAFE_ID,
    decision: z.enum(["allow_once", "deny"]),
  }),
  computer_takeover_release: z.strictObject({
    botId: SAFE_ID,
    resume: z.boolean(),
  }),
} as const;

export type ApprovalMethodName = keyof typeof APPROVAL_METHOD_SCHEMAS;

export type ApprovalMethodArgsMap = {
  [K in ApprovalMethodName]: z.infer<(typeof APPROVAL_METHOD_SCHEMAS)[K]>;
};

/** 远端通道（联邦/外部桥接）永久禁止调用的本地高权限审批方法。 */
export const REMOTE_FORBIDDEN_APPROVAL_METHODS: ReadonlySet<string> = new Set([
  "resolve_approval",
  "approval_resolve",
  "confirm_decision",
  "device_approval_decision",
  "create_rule",
  "update_rule",
  "set_preferences",
  "set_team_settings",
]);

const FORBIDDEN_ESCALATION_KEYS: ReadonlySet<string> = new Set([
  "scope",
  "allowalways",
  "autoapprove",
  "bypass",
  "bypassapproval",
  "alwaysallow",
  "args",
  "rawargs",
]);

export type ApprovalArgsRejectionCode =
  | "UNKNOWN_METHOD"
  | "REMOTE_APPROVAL_FORBIDDEN"
  | "FORBIDDEN_ESCALATION"
  | "INVALID_ARGS";

export class ApprovalArgsRejectedError extends Error {
  readonly status: 400 | 403;
  constructor(
    readonly code: ApprovalArgsRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalArgsRejectedError";
    this.status =
      code === "REMOTE_APPROVAL_FORBIDDEN" || code === "FORBIDDEN_ESCALATION"
        ? 403
        : 400;
  }
}

function detectEscalationAttempt(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = detectEscalationAttempt(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, "");
    if (FORBIDDEN_ESCALATION_KEYS.has(normalizedKey)) {
      if (
        normalizedKey === "scope" &&
        typeof entry === "string" &&
        entry.trim().toLowerCase() === "always"
      ) {
        return "禁止在审批参数中注入 scope: 'always'";
      }
      return `审批参数包含禁止字段：${key}`;
    }
    const nested = detectEscalationAttempt(entry, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * 校验审批方法名与参数是否严格命中白名单：
 * - 远端来源（`source: "remote"`）硬禁止代批任何本地审批或提权；
 * - 任何未知方法名一律拒绝；
 * - 任何含 `scope: "always"` 或未声明透传字段的 `args` 一律拒绝。
 */
export function validateApprovalMethodArgs<M extends ApprovalMethodName>(
  method: M,
  rawArgs: unknown,
  options?: { source?: "local" | "remote" },
): ApprovalMethodArgsMap[M];
export function validateApprovalMethodArgs(
  method: string,
  rawArgs: unknown,
  options?: { source?: "local" | "remote" },
): ApprovalMethodArgsMap[ApprovalMethodName];
export function validateApprovalMethodArgs(
  method: string,
  rawArgs: unknown,
  options: { source?: "local" | "remote" } = {},
): ApprovalMethodArgsMap[ApprovalMethodName] {
  const source = options.source ?? "local";
  const normalizedMethod = method.trim();

  if (
    source === "remote" &&
    REMOTE_FORBIDDEN_APPROVAL_METHODS.has(normalizedMethod)
  ) {
    throw new ApprovalArgsRejectedError(
      "REMOTE_APPROVAL_FORBIDDEN",
      `远端通道禁止代批或篡改本地审批方法：${normalizedMethod}`,
    );
  }

  const escalationReason = detectEscalationAttempt(rawArgs);
  if (escalationReason) {
    throw new ApprovalArgsRejectedError(
      "FORBIDDEN_ESCALATION",
      escalationReason,
    );
  }

  if (!Object.hasOwn(APPROVAL_METHOD_SCHEMAS, normalizedMethod)) {
    throw new ApprovalArgsRejectedError(
      "UNKNOWN_METHOD",
      `未在审批白名单中注册的方法：${normalizedMethod}`,
    );
  }

  const schema =
    APPROVAL_METHOD_SCHEMAS[normalizedMethod as ApprovalMethodName];
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApprovalArgsRejectedError(
      "INVALID_ARGS",
      `审批参数校验失败（${normalizedMethod}）：${issue?.path.join(".") ?? ""} ${issue?.message ?? "参数无效"}`.trim(),
    );
  }

  return parsed.data;
}

export type UntrustedActionRecord = {
  role: string;
  content: string;
};

export type AuxiliaryReviewInput = {
  trustedUserInstructions: readonly string[];
  untrustedAgentNarrationAndPriorActions: readonly UntrustedActionRecord[];
  proposedToolCall?: {
    toolName: string;
    args: Record<string, unknown>;
  };
  trustedPolicyInstructions?: Record<string, unknown>;
  maxBytes?: number;
};

export type PartitionedAuxiliaryReviewPayload = {
  schemaVersion: 1;
  trustBoundary: "strict-partitioned";
  trusted_user_instructions: readonly string[];
  untrusted_agent_narration_and_prior_actions: readonly {
    role: string;
    content: string;
    trust: "untrusted";
  }[];
  proposed_tool_call?: {
    toolName: string;
    args: Record<string, unknown>;
  };
  trusted_policy_instructions?: Record<string, unknown>;
};

const DEFAULT_MAX_REVIEW_BYTES = 1024 * 1024;

function stripControlChars(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isUnsafeControl =
      (code >= 0 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    out += isUnsafeControl ? " " : text.charAt(i);
  }
  return out;
}

/**
 * 显式构造辅助审查输入分区：
 * - 将用户原始可信指令与 Agent 自述/工具返回严格分离到两个独立字段；
 * - 标记不可信分区元信息并强制总字节上限（默认 1 MiB），防止提示词混喂与上下文炸弹。
 */
export function partitionAuxiliaryReviewInput(
  input: AuxiliaryReviewInput,
): PartitionedAuxiliaryReviewPayload {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_REVIEW_BYTES;
  const trusted = input.trustedUserInstructions
    .filter((item): item is string => typeof item === "string")
    .map((item) => stripControlChars(item.trim()))
    .filter(Boolean);

  const untrusted = input.untrustedAgentNarrationAndPriorActions.map(
    (item) => ({
      role:
        item.role === "user"
          ? "claimed_user_quote"
          : stripControlChars(String(item.role || "assistant")).slice(0, 64),
      content: stripControlChars(String(item.content ?? "")),
      trust: "untrusted" as const,
    }),
  );

  const payload: PartitionedAuxiliaryReviewPayload = {
    schemaVersion: 1,
    trustBoundary: "strict-partitioned",
    trusted_user_instructions: trusted,
    untrusted_agent_narration_and_prior_actions: untrusted,
    ...(input.proposedToolCall
      ? { proposed_tool_call: input.proposedToolCall }
      : {}),
    ...(input.trustedPolicyInstructions
      ? { trusted_policy_instructions: input.trustedPolicyInstructions }
      : {}),
  };

  const serializedBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (serializedBytes > maxBytes) {
    throw new AuxiliaryReviewValidationError(
      `辅助审查输入超过最大字节上限（${serializedBytes} > ${maxBytes}）。`,
    );
  }

  return payload;
}

export const AUXILIARY_REVIEW_DECISIONS = ["ALLOW", "BLOCK"] as const;
export const AUXILIARY_REVIEW_BLOCKED_EFFECTS = [
  "none",
  "destructive_local_state",
  "outbound_or_binding_external_effect",
  "data_or_credential_exfiltration",
  "privilege_escalation",
] as const;
export const AUXILIARY_REVIEW_OUTBOUND_AUTH = [
  "not_applicable",
  "explicitly_authorized",
  "unauthorized_destination",
] as const;

const auxiliaryReviewOutputSchema = z.strictObject({
  decision: z.enum(AUXILIARY_REVIEW_DECISIONS),
  blocked_effect: z.enum(AUXILIARY_REVIEW_BLOCKED_EFFECTS),
  outbound_authorization: z.enum(AUXILIARY_REVIEW_OUTBOUND_AUTH),
  reason: z.string().trim().min(1).max(500),
  who_sees_it: z.string().trim().max(300).optional(),
  proposed_allow_rule: z.string().trim().max(500).optional(),
});

export type AuxiliaryReviewOutput = z.infer<typeof auxiliaryReviewOutputSchema>;

export class AuxiliaryReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuxiliaryReviewValidationError";
  }
}

const OUTBOUND_EFFECTS: ReadonlySet<AuxiliaryReviewOutput["blocked_effect"]> =
  new Set([
    "outbound_or_binding_external_effect",
    "data_or_credential_exfiltration",
  ]);

/**
 * 辅助审查输出严格 Enum + 逻辑一致性校验（fail-closed）：
 * - 任何非枚举值、额外未知字段、或自相矛盾的决策（如 BLOCK 但 blocked_effect="none"，
 *   ALLOW 但 blocked_effect!=="none"，或外发拦截缺少目标说明）一律抛出异常，由调用方退回人工审批。
 */
export function validateAuxiliaryReviewOutput(
  raw: unknown,
): AuxiliaryReviewOutput {
  const parsed = auxiliaryReviewOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AuxiliaryReviewValidationError(
      `辅助审查输出未通过 schema 校验：${issue?.path.join(".") ?? ""} ${issue?.message ?? "格式非法"}`.trim(),
    );
  }
  const output = parsed.data;

  if (output.decision === "BLOCK" && output.blocked_effect === "none") {
    throw new AuxiliaryReviewValidationError(
      "辅助审查决策自相矛盾：decision 为 BLOCK 时 blocked_effect 不能为 none。",
    );
  }
  if (output.decision === "ALLOW" && output.blocked_effect !== "none") {
    throw new AuxiliaryReviewValidationError(
      "辅助审查决策自相矛盾：decision 为 ALLOW 时 blocked_effect 必须为 none。",
    );
  }
  if (
    output.decision === "BLOCK" &&
    OUTBOUND_EFFECTS.has(output.blocked_effect) &&
    (output.outbound_authorization !== "unauthorized_destination" ||
      !output.who_sees_it?.trim())
  ) {
    throw new AuxiliaryReviewValidationError(
      "辅助审查外发拦截不完整：必须标注 unauthorized_destination 并指明 who_sees_it。",
    );
  }

  return output;
}
