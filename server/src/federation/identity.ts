import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { seal, unseal } from "../auth/signed-value";

/**
 * Host↔Host 联邦节点身份模块（Wave 10 §1.2）：
 *
 * - Ed25519 非对称密钥对：SPKI DER 的 SHA-256（64 位小写 hex）即 `hostId`；
 * - 私钥严禁明文落盘（吸收 §4 反面清单 #4），统一通过 AES-256-GCM 域隔离封存；
 * - 联邦对等 URL 默认只接受 `https://`（吸收 §4 反面清单 #3，绝不静默接受 `http://`）。
 */

const FEDERATION_KEY_SEAL_LABEL = "chisabot-federation-ed25519-private-key";
const HOST_ID_RE = /^[a-f0-9]{64}$/;
const PEER_ADDRESS_RE = /^peer:([a-f0-9]{64}):([A-Za-z0-9_-]{1,128})$/;

export class FederationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FederationError";
  }
}

export type FederationIdentity = {
  /** 公钥 SPKI DER 的 SHA-256 指纹（64 位小写 hex）。 */
  id: string;
  /** Ed25519 公钥（SPKI PEM）。 */
  publicKey: string;
  /** Ed25519 私钥（PKCS8 PEM，仅驻留内存，落盘必须经 AES-256-GCM 封存）。 */
  privateKey: string;
};

export type PublicFederationIdentity = {
  id: string;
  publicKey: string;
  name?: string;
  url?: string;
};

export type SealedFederationIdentity = {
  version: 1;
  id: string;
  publicKey: string;
  sealedPrivateKey: string;
};

/** 计算 Ed25519 公钥的 SHA-256 指纹（即 `hostId`）。 */
export function hostIdFromPublicKey(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new FederationError(
      400,
      "INVALID_KEY_TYPE",
      "联邦节点身份仅支持 Ed25519 公钥。",
    );
  }
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

/** 生成一对全新 Ed25519 联邦节点身份。 */
export function createFederationIdentity(): FederationIdentity {
  const pair = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    id: hostIdFromPublicKey(pair.publicKey),
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
  };
}

/** 校验对外公开的节点身份：必须是有效 Ed25519 公钥且 SHA-256 指纹与 `id` 完全一致。 */
export function validateFederationIdentity(identity: unknown): {
  id: string;
  publicKey: string;
} {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new FederationError(
      400,
      "INVALID_IDENTITY",
      "联邦节点身份格式无效。",
    );
  }
  const candidate = identity as { id?: unknown; publicKey?: unknown };
  if (
    typeof candidate.id !== "string" ||
    !HOST_ID_RE.test(candidate.id) ||
    typeof candidate.publicKey !== "string" ||
    candidate.publicKey.length === 0 ||
    candidate.publicKey.length > 1024
  ) {
    throw new FederationError(
      400,
      "INVALID_IDENTITY",
      "联邦节点公钥或 ID 无效。",
    );
  }
  let computed: string;
  try {
    computed = hostIdFromPublicKey(candidate.publicKey);
  } catch (error) {
    if (error instanceof FederationError) throw error;
    throw new FederationError(
      400,
      "INVALID_PUBLIC_KEY",
      "无法解析 Ed25519 公钥。",
    );
  }
  if (computed !== candidate.id) {
    throw new FederationError(
      400,
      "FINGERPRINT_MISMATCH",
      "联邦节点 hostId 与公钥 SHA-256 指纹不匹配。",
    );
  }
  return { id: candidate.id, publicKey: candidate.publicKey };
}

/** 使用 AES-256-GCM 封存节点 Ed25519 私钥，禁止明文落盘。 */
export async function sealFederationIdentity(
  identity: FederationIdentity,
  encryptionKey: string,
): Promise<SealedFederationIdentity> {
  if (!encryptionKey.trim()) {
    throw new FederationError(
      500,
      "MISSING_ENCRYPTION_KEY",
      "封存联邦私钥需要配置加密主密钥。",
    );
  }
  validateFederationIdentity(identity);
  const privKey = createPrivateKey(identity.privateKey);
  if (privKey.asymmetricKeyType !== "ed25519") {
    throw new FederationError(
      400,
      "INVALID_PRIVATE_KEY",
      "联邦私钥不是 Ed25519。",
    );
  }
  const sealedPrivateKey = await seal(
    identity.privateKey,
    encryptionKey,
    FEDERATION_KEY_SEAL_LABEL,
  );
  return {
    version: 1,
    id: identity.id,
    publicKey: identity.publicKey,
    sealedPrivateKey,
  };
}

/** 解封 AES-256-GCM 封存的联邦节点私钥并校验与公钥指纹一致。 */
export async function unsealFederationIdentity(
  sealed: SealedFederationIdentity,
  encryptionKey: string,
): Promise<FederationIdentity> {
  if (sealed.version !== 1 || !sealed.sealedPrivateKey) {
    throw new FederationError(
      400,
      "INVALID_SEALED_IDENTITY",
      "封存身份版本或结构无效。",
    );
  }
  const verified = validateFederationIdentity(sealed);
  const privateKey = await unseal(
    sealed.sealedPrivateKey,
    encryptionKey,
    FEDERATION_KEY_SEAL_LABEL,
  );
  if (!privateKey) {
    throw new FederationError(
      401,
      "UNSEAL_FAILED",
      "无法解封联邦节点私钥（密钥不匹配或密文已篡改）。",
    );
  }
  const derivedPublic = createPublicKey(createPrivateKey(privateKey)).export({
    type: "spki",
    format: "pem",
  });
  if (hostIdFromPublicKey(String(derivedPublic)) !== verified.id) {
    throw new FederationError(
      400,
      "KEYPAIR_MISMATCH",
      "解封后的联邦私钥与公钥指纹不匹配。",
    );
  }
  return {
    id: verified.id,
    publicKey: verified.publicKey,
    privateKey,
  };
}

/**
 * 校验联邦对等节点 URL：
 * - 默认强制 `https://`（绝不静默接受明文 `http://`）；
 * - 仅在管理员显式确认 `allowPrivateHttp: true` 时允许私网 `http://`；
 * - 拒绝携带 userinfo、query、hash 或非根路径。
 */
export function validateFederationUrl(
  raw: string,
  options: { allowPrivateHttp?: boolean; optional?: boolean } = {},
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    if (options.optional) return "";
    throw new FederationError(400, "INVALID_URL", "联邦节点地址不能为空。");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new FederationError(400, "INVALID_URL", "联邦节点地址不是合法 URL。");
  }
  const protocolOk =
    parsed.protocol === "https:" ||
    (options.allowPrivateHttp === true && parsed.protocol === "http:");
  if (
    !protocolOk ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new FederationError(
      400,
      "INSECURE_URL",
      "联邦节点必须使用纯源地址 HTTPS（仅在显式私网确认下允许 HTTP）。",
    );
  }
  return parsed.origin;
}

export function formatPeerAddress(peerId: string, agentId: string): string {
  return `peer:${peerId}:${agentId}`;
}

export function parsePeerAddress(address: string): {
  peerId: string;
  agentId: string;
} {
  const match = PEER_ADDRESS_RE.exec(address ?? "");
  if (!match?.[1] || !match[2]) {
    throw new FederationError(
      400,
      "INVALID_PEER_ADDRESS",
      "远端 Bot 联邦地址格式无效。",
    );
  }
  return { peerId: match[1], agentId: match[2] };
}
