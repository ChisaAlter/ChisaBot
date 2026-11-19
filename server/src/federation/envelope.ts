import { randomUUID, sign, verify } from "node:crypto";
import {
  FederationError,
  type FederationIdentity,
  hostIdFromPublicKey,
  validateFederationIdentity,
} from "./identity";

/**
 * Host↔Host 联邦签名信封协议（Wave 10 §1.2）：
 *
 * - 字段：`version` + `purpose` + `timestamp`（±5 分钟窗口）+ `nonce`（UUID 防重放）+ `sender` + `senderKey` + `body`；
 * - 使用 Ed25519 对规范化 JSON 字节进行签名；
 * - 验签端同时校验：签名真实性、公钥指纹 === `sender`、`purpose` 一致、时间偏移 ≤ ±5min、
 *   以及 `(sender, nonce)` 在重放缓存中从未出现过。
 */

export const FEDERATION_ENVELOPE_SKEW_MS = 5 * 60_000;
const UUID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ED25519_SIG_RE = /^[A-Za-z0-9_-]{86}$/;

export type FederationEnvelopePayload<T = unknown> = {
  version: 1;
  sender: string;
  senderKey: string;
  purpose: string;
  timestamp: number;
  nonce: string;
  body: T;
};

export type FederationEnvelope<T = unknown> = {
  payload: FederationEnvelopePayload<T>;
  signature: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function serializePayload(payload: FederationEnvelopePayload<unknown>): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(payload)), "utf8");
}

/**
 * 有界 Nonce 防重放缓存：在窗口期（默认 10 分钟 = 2 × ±5 分钟）内拒绝同一 `(sender, nonce)` 再次使用。
 */
export class NonceReplayCache {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = options.ttlMs ?? FEDERATION_ENVELOPE_SKEW_MS * 2;
    this.maxEntries = options.maxEntries ?? 20_000;
  }

  /** 若 `(sender, nonce)` 已出现返回 false（重放）；否则登记并返回 true。 */
  consume(sender: string, nonce: string, now: number = Date.now()): boolean {
    const key = `${sender}:${nonce}`;
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > now) {
      return false;
    }
    if (this.seen.size >= this.maxEntries) {
      for (const [entryKey, expiresAt] of this.seen) {
        if (expiresAt <= now) this.seen.delete(entryKey);
      }
      if (this.seen.size >= this.maxEntries) {
        const oldest = this.seen.keys().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }
    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }
}

/** 构造并签名一个联邦 Ed25519 信封。 */
export function signFederationEnvelope<T>(
  identity: FederationIdentity,
  purpose: string,
  body: T,
  options: { now?: number; nonce?: string } = {},
): FederationEnvelope<T> {
  const trimmedPurpose = purpose.trim();
  if (!trimmedPurpose) {
    throw new FederationError(400, "INVALID_PURPOSE", "签名信封缺少 purpose。");
  }
  const timestamp = options.now ?? Date.now();
  const nonce = options.nonce ?? randomUUID();
  if (!UUID_RE.test(nonce)) {
    throw new FederationError(
      400,
      "INVALID_NONCE",
      "签名信封 nonce 必须为 UUID。",
    );
  }
  const payload: FederationEnvelopePayload<T> = {
    version: 1,
    sender: identity.id,
    senderKey: identity.publicKey,
    purpose: trimmedPurpose,
    timestamp,
    nonce,
    body,
  };
  const signature = sign(
    null,
    serializePayload(payload),
    identity.privateKey,
  ).toString("base64url");

  return { payload, signature };
}

/**
 * 严格验证联邦 Ed25519 签名信封：
 * 1. `version === 1`、`purpose` 严格一致；
 * 2. `senderKey` 为合法 Ed25519 公钥，与预期公钥（若有）一致且其指纹 === `sender`；
 * 3. `|timestamp - now| <= 5 分钟`；
 * 4. `nonce` 合法且未在 `replayCache` 中重放（若传 `expectedNonce` 则必须完全一致）；
 * 5. Ed25519 签名通过密码学校验。
 */
export function verifyFederationEnvelope<T = unknown>(
  envelope: unknown,
  expectedPurpose: string,
  options: {
    expectedPublicKey?: string;
    now?: number;
    expectedNonce?: string;
    replayCache?: NonceReplayCache;
    maxSkewMs?: number;
  } = {},
): {
  sender: string;
  senderKey: string;
  nonce: string;
  timestamp: number;
  body: T;
} {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new FederationError(401, "INVALID_ENVELOPE", "签名信封结构无效。");
  }
  const raw = envelope as { payload?: unknown; signature?: unknown };
  if (
    !raw.payload ||
    typeof raw.payload !== "object" ||
    Array.isArray(raw.payload)
  ) {
    throw new FederationError(
      401,
      "INVALID_ENVELOPE",
      "签名信封缺少 payload。",
    );
  }
  const payload = raw.payload as Partial<FederationEnvelopePayload<T>>;
  const now = options.now ?? Date.now();
  const maxSkewMs = options.maxSkewMs ?? FEDERATION_ENVELOPE_SKEW_MS;

  if (
    payload.version !== 1 ||
    typeof payload.sender !== "string" ||
    typeof payload.senderKey !== "string" ||
    typeof payload.purpose !== "string" ||
    payload.purpose !== expectedPurpose ||
    typeof payload.timestamp !== "number" ||
    !Number.isSafeInteger(payload.timestamp) ||
    typeof payload.nonce !== "string" ||
    !UUID_RE.test(payload.nonce)
  ) {
    throw new FederationError(
      401,
      "INVALID_ENVELOPE",
      "签名信封字段或用途校验失败。",
    );
  }

  if (Math.abs(payload.timestamp - now) > maxSkewMs) {
    throw new FederationError(
      401,
      "TIMESTAMP_OUT_OF_WINDOW",
      "签名信封时间戳超出 ±5 分钟允许窗口，已拒收。",
    );
  }

  if (options.expectedNonce && payload.nonce !== options.expectedNonce) {
    throw new FederationError(
      401,
      "NONCE_MISMATCH",
      "签名信封响应 nonce 不匹配。",
    );
  }

  const validated = validateFederationIdentity({
    id: payload.sender,
    publicKey: payload.senderKey,
  });

  if (options.expectedPublicKey) {
    const expectedId = hostIdFromPublicKey(options.expectedPublicKey);
    if (
      expectedId !== validated.id ||
      options.expectedPublicKey.trim() !== validated.publicKey.trim()
    ) {
      throw new FederationError(
        401,
        "SENDER_KEY_MISMATCH",
        "签名信封发送方公钥与已配对节点公钥不一致。",
      );
    }
  }

  if (
    typeof raw.signature !== "string" ||
    !ED25519_SIG_RE.test(raw.signature)
  ) {
    throw new FederationError(
      401,
      "INVALID_SIGNATURE",
      "签名信封签名编码无效。",
    );
  }

  const verified = verify(
    null,
    serializePayload(payload as FederationEnvelopePayload<unknown>),
    validated.publicKey,
    Buffer.from(raw.signature, "base64url"),
  );
  if (!verified) {
    throw new FederationError(
      401,
      "SIGNATURE_VERIFICATION_FAILED",
      "Ed25519 签名验证失败。",
    );
  }

  // 防重放登记必须在签名验真之后，防止未认证攻击者用伪造信封刷爆重放缓存。
  if (
    options.replayCache &&
    !options.replayCache.consume(validated.id, payload.nonce, now)
  ) {
    throw new FederationError(
      401,
      "NONCE_REPLAYED",
      "检测到重复的签名信封 nonce（重放攻击），已拒收。",
    );
  }

  return {
    sender: validated.id,
    senderKey: validated.publicKey,
    nonce: payload.nonce,
    timestamp: payload.timestamp,
    body: payload.body as T,
  };
}
