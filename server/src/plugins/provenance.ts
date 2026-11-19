import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * 装载物 Provenance 清单校验（Wave 10 §1.6）：
 *
 * 安装/加载任何插件、技能包或补丁物料前，必须先通过本模块的 fail-closed 校验：
 * 1. 清单声明 Schema（`sourceSha256`、`targetSha256`、`declaredBindings[]`）；
 * 2. 校验真实内容 SHA-256（常量时间比对），错版本/被篡改一律拒载；
 * 3. 只允许暴露清单中显式声明过的 binding，出现任何未声明 binding 一律拒载；
 * 4. 输出确定性 `grantDigest`，与 `plugins/store.ts` 的 grant / policy / audit 三层挂接时，
 *    将授权锚定到具体清单 digest 而非裸插件 ID（换包即失效，不静默继承旧 grant）。
 */

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const BINDING_NAME_RE = /^[A-Za-z0-9_.:/-]{1,128}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PROTOTYPE_RESERVED_NAMES = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "tostring",
  "valueof",
  "hasownproperty",
]);

function isSafeIdentifierSegment(value: string): boolean {
  if (!value || value === "." || value.includes("..")) return false;
  if (value.startsWith(".") || value.endsWith(".")) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  const parts = value.split(/[/.:]/);
  for (const part of parts) {
    if (!part) continue;
    if (PROTOTYPE_RESERVED_NAMES.has(part.toLowerCase())) return false;
  }
  return !PROTOTYPE_RESERVED_NAMES.has(value.toLowerCase());
}

export const hexSha256Schema = z
  .string()
  .regex(HEX_SHA256_RE, "必须是 64 位小写十六进制 SHA-256 摘要。");

export const declaredBindingSchema = z.strictObject({
  name: z
    .string()
    .regex(BINDING_NAME_RE, "binding 名称只能包含安全标识符字符（≤128 字符）。")
    .refine(
      isSafeIdentifierSegment,
      "binding 名称禁止包含路径穿越片段（..）或原型保留名。",
    ),
  kind: z.enum(["tool", "skill", "oauth", "webhook", "resource"]),
  effect: z.enum(["read", "write", "admin"]).default("read"),
  digest: hexSha256Schema.optional(),
});

export const provenanceManifestSchema = z.strictObject({
  version: z.literal(1),
  artifactId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(ARTIFACT_ID_RE, "artifactId 仅允许安全 slug 字符。")
    .refine(
      isSafeIdentifierSegment,
      "artifactId 禁止包含路径穿越片段（..）或原型保留名。",
    ),
  artifactVersion: z.string().trim().min(1).max(64),
  sourceSha256: hexSha256Schema,
  targetSha256: hexSha256Schema,
  declaredBindings: z.array(declaredBindingSchema).max(200),
  publisher: z.string().trim().min(1).max(120).optional(),
  issuedAt: z.string().datetime().optional(),
});

export type DeclaredBinding = z.infer<typeof declaredBindingSchema>;
export type ProvenanceManifest = z.infer<typeof provenanceManifestSchema>;

export type ProvenanceFailureCode =
  | "INVALID_MANIFEST"
  | "DUPLICATE_BINDING"
  | "SOURCE_HASH_MISMATCH"
  | "TARGET_HASH_MISMATCH"
  | "UNDECLARED_BINDING"
  | "GRANT_DIGEST_MISMATCH";

export class ProvenanceVerificationError extends Error {
  readonly status = 400;
  constructor(
    readonly code: ProvenanceFailureCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProvenanceVerificationError";
  }
}

export type ProvenanceVerificationResult =
  | {
      ok: true;
      manifest: ProvenanceManifest;
      grantDigest: string;
      actualSourceSha256: string;
      actualTargetSha256: string;
      allowedBindings: ReadonlySet<string>;
    }
  | {
      ok: false;
      code: ProvenanceFailureCode;
      reason: string;
      details?: Record<string, unknown>;
    };

/** 计算内容的标准 64 位小写 hex SHA-256 摘要。 */
export function computeContentSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function sameHexDigest(left: string, right: string): boolean {
  if (!HEX_SHA256_RE.test(left) || !HEX_SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * 计算与插件 grant 层锚定的确定性清单 digest。
 * 任何 `artifactId`、`artifactVersion`、`sourceSha256`、`targetSha256` 或 `declaredBindings`
 * 的变动都会产生新的 grantDigest，确保旧 grant 不会静默继承到新版本/新绑定集合上。
 */
export function computeManifestGrantDigest(
  manifest: ProvenanceManifest,
): string {
  const sortedBindings = [...manifest.declaredBindings]
    .map((binding) => ({
      name: binding.name,
      kind: binding.kind,
      effect: binding.effect,
      ...(binding.digest ? { digest: binding.digest } : {}),
    }))
    // 确定性 Unicode 码点排序，避免不同系统 locale 导致同一清单算出不同 grantDigest。
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const canonical = JSON.stringify({
    version: manifest.version,
    artifactId: manifest.artifactId,
    artifactVersion: manifest.artifactVersion,
    sourceSha256: manifest.sourceSha256,
    targetSha256: manifest.targetSha256,
    declaredBindings: sortedBindings,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * 装载物 Provenance fail-closed 验证器：
 * - 清单结构非法 → 拒载
 * - 重复声明同名 binding → 拒载
 * - `sourceBytes` 或 `targetBytes` 真实 SHA-256 与清单不一致 → 拒载
 * - `requestedBindings` 包含任何未在 `declaredBindings` 声明的名称 → 拒载
 * - 传入了来自插件授权表的 `expectedGrantDigest` 但与当前清单 digest 不一致 → 拒载
 */
export function verifyProvenanceManifest(input: {
  manifest: unknown;
  sourceBytes: string | Uint8Array;
  targetBytes: string | Uint8Array;
  requestedBindings?: readonly string[];
  expectedGrantDigest?: string;
}): ProvenanceVerificationResult {
  const parsed = provenanceManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return {
      ok: false,
      code: "INVALID_MANIFEST",
      reason:
        `Provenance 清单校验失败：${firstIssue?.path.join(".") ?? ""} ${firstIssue?.message ?? "结构不合法"}`.trim(),
    };
  }

  const manifest = parsed.data;
  const allowedBindings = new Set<string>();
  for (const binding of manifest.declaredBindings) {
    if (allowedBindings.has(binding.name)) {
      return {
        ok: false,
        code: "DUPLICATE_BINDING",
        reason: `Provenance 清单包含重复的 binding 声明：${binding.name}`,
        details: { binding: binding.name },
      };
    }
    allowedBindings.add(binding.name);
  }

  const actualSourceSha256 = computeContentSha256(input.sourceBytes);
  if (!sameHexDigest(actualSourceSha256, manifest.sourceSha256)) {
    return {
      ok: false,
      code: "SOURCE_HASH_MISMATCH",
      reason: "装载物源内容 SHA-256 与 Provenance 清单声明不一致，已拒绝加载。",
      details: {
        expected: manifest.sourceSha256,
        actual: actualSourceSha256,
      },
    };
  }

  const actualTargetSha256 = computeContentSha256(input.targetBytes);
  if (!sameHexDigest(actualTargetSha256, manifest.targetSha256)) {
    return {
      ok: false,
      code: "TARGET_HASH_MISMATCH",
      reason:
        "装载物目标产物 SHA-256 与 Provenance 清单声明不一致，已拒绝加载。",
      details: {
        expected: manifest.targetSha256,
        actual: actualTargetSha256,
      },
    };
  }

  if (input.requestedBindings && input.requestedBindings.length > 0) {
    const undeclared = input.requestedBindings.filter(
      (name) => !allowedBindings.has(name),
    );
    if (undeclared.length > 0) {
      return {
        ok: false,
        code: "UNDECLARED_BINDING",
        reason: `发现未在 Provenance 清单中声明的 binding：${undeclared.join(", ")}`,
        details: { undeclared },
      };
    }
  }

  const grantDigest = computeManifestGrantDigest(manifest);
  if (input.expectedGrantDigest !== undefined) {
    const expected = input.expectedGrantDigest.trim().toLowerCase();
    if (!sameHexDigest(grantDigest, expected)) {
      return {
        ok: false,
        code: "GRANT_DIGEST_MISMATCH",
        reason:
          "装载物清单 digest 与已锚定的插件 grant digest 不一致，需重新审批授权。",
        details: {
          expected,
          actual: grantDigest,
        },
      };
    }
  }

  return {
    ok: true,
    manifest,
    grantDigest,
    actualSourceSha256,
    actualTargetSha256,
    allowedBindings,
  };
}

/** fail-closed 断言包装：验证失败直接抛出 `ProvenanceVerificationError`。 */
export function assertProvenanceVerified(input: {
  manifest: unknown;
  sourceBytes: string | Uint8Array;
  targetBytes: string | Uint8Array;
  requestedBindings?: readonly string[];
  expectedGrantDigest?: string;
}): Extract<ProvenanceVerificationResult, { ok: true }> {
  const verdict = verifyProvenanceManifest(input);
  if (!verdict.ok) {
    throw new ProvenanceVerificationError(
      verdict.code,
      verdict.reason,
      verdict.details,
    );
  }
  return verdict;
}

/** `verifyProvenanceManifest` 语义别名，供插件与微应用包安装校验链统一调用。 */
export const verifyArtifactProvenance = verifyProvenanceManifest;

/** 仅暴露在已验 Provenance 清单中显式声明过的 binding，过滤掉任何未声明条目。 */
export function filterDeclaredBindings<T extends { name: string }>(
  manifest: ProvenanceManifest,
  candidates: readonly T[],
): T[] {
  const allowed = new Set(manifest.declaredBindings.map((b) => b.name));
  return candidates.filter((item) => allowed.has(item.name));
}
