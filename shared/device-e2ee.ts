/**
 * 设备局域网 / Tailscale 候选地址识别与可选端到端加密（E2EE）帧协议。
 *
 * 仅依赖 WebCrypto、TextEncoder/TextDecoder 与 btoa/atob，可同时运行在浏览器、Bun 与 Node >= 20。
 */

export type E2eeAlgorithm = "X25519" | "P-256";

export type E2eeKeyPair = {
  algorithm: E2eeAlgorithm;
  /** base64url 编码公钥（X25519 为 32 字节 raw，P-256 为 65 字节未压缩点）。 */
  publicKey: string;
  privateKey: JsonWebKey;
};

export type E2eeEncryptedFrame = {
  seq: number;
  iv: string;
  ciphertext: string;
};

export type E2eeReplayState = {
  maxSeq: number;
};

const HKDF_INFO = "chisabot-device-e2ee-v1";
const DEFAULT_SALT = "chisabot-device-e2ee-salt";
const E2EE_PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{40,128}$/;

// RFC 8410 X25519 PKCS#8 DER 前缀（16 字节 + 32 字节裸私钥）。
const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04,
  0x22, 0x04, 0x20,
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeBase64Url(encoded: string): Uint8Array {
  const clean = encoded.trim();
  if (!clean || !/^[A-Za-z0-9_-]+$/.test(clean)) {
    throw new Error("无效的 base64url 数据。");
  }
  const padded = clean
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(clean.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("当前运行环境不支持 WebCrypto SubtleCrypto。");
  }
  return subtle;
}

export function isValidE2eePublicKey(value: unknown): value is string {
  return typeof value === "string" && E2EE_PUBLIC_KEY_RE.test(value.trim());
}

/** 生成用于配对握手的临时密钥对（优先 X25519，不支持时自动降级 P-256 ECDH）。 */
export async function generateE2eeKeyPair(): Promise<E2eeKeyPair> {
  const subtle = getSubtle();
  try {
    const pair = (await subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const rawPub = new Uint8Array(
      await subtle.exportKey("raw", pair.publicKey),
    );
    const privateKey = await subtle.exportKey("jwk", pair.privateKey);
    return {
      algorithm: "X25519",
      publicKey: encodeBase64Url(rawPub),
      privateKey,
    };
  } catch {
    const pair = (await subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )) as CryptoKeyPair;
    const rawPub = new Uint8Array(
      await subtle.exportKey("raw", pair.publicKey),
    );
    const privateKey = await subtle.exportKey("jwk", pair.privateKey);
    return {
      algorithm: "P-256",
      publicKey: encodeBase64Url(rawPub),
      privateKey,
    };
  }
}

async function importPrivateKey(
  subtle: SubtleCrypto,
  privateKeyInput: JsonWebKey | Uint8Array,
  algorithm: E2eeAlgorithm,
): Promise<CryptoKey> {
  if (privateKeyInput instanceof Uint8Array) {
    if (algorithm !== "X25519") {
      return subtle.importKey(
        "pkcs8",
        toArrayBuffer(privateKeyInput),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        ["deriveBits"],
      );
    }
    const pkcs8 =
      privateKeyInput.length === 32
        ? (() => {
            const out = new Uint8Array(
              X25519_PKCS8_PREFIX.length + privateKeyInput.length,
            );
            out.set(X25519_PKCS8_PREFIX, 0);
            out.set(privateKeyInput, X25519_PKCS8_PREFIX.length);
            return out;
          })()
        : privateKeyInput;
    return subtle.importKey(
      "pkcs8",
      toArrayBuffer(pkcs8),
      { name: "X25519" },
      false,
      ["deriveBits"],
    );
  }

  if (algorithm === "X25519") {
    return subtle.importKey("jwk", privateKeyInput, { name: "X25519" }, false, [
      "deriveBits",
    ]);
  }
  return subtle.importKey(
    "jwk",
    privateKeyInput,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

/** 通过协商公钥与可选 salt 派生 AES-256-GCM 会话密钥（HKDF-SHA256）。 */
export async function deriveSessionKey(
  privateKey: JsonWebKey | Uint8Array,
  peerPublicKeyBase64Url: string,
  salt?: string | Uint8Array,
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const peerRaw = decodeBase64Url(peerPublicKeyBase64Url);
  const algorithm: E2eeAlgorithm = peerRaw.length === 32 ? "X25519" : "P-256";
  if (algorithm === "P-256" && peerRaw.length !== 65) {
    throw new Error("对端 E2EE 公钥长度无效。");
  }

  const localKey = await importPrivateKey(subtle, privateKey, algorithm);
  const peerKey =
    algorithm === "X25519"
      ? await subtle.importKey(
          "raw",
          toArrayBuffer(peerRaw),
          { name: "X25519" },
          false,
          [],
        )
      : await subtle.importKey(
          "raw",
          toArrayBuffer(peerRaw),
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        );

  const sharedBits = await subtle.deriveBits(
    algorithm === "X25519"
      ? ({ name: "X25519", public: peerKey } as EcdhKeyDeriveParams)
      : { name: "ECDH", public: peerKey },
    localKey,
    256,
  );

  const ikm = await subtle.importKey("raw", sharedBits, "HKDF", false, [
    "deriveKey",
  ]);
  const saltBytes =
    salt instanceof Uint8Array
      ? salt
      : textEncoder.encode(
          typeof salt === "string" && salt ? salt : DEFAULT_SALT,
        );

  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(saltBytes),
      info: toArrayBuffer(textEncoder.encode(HKDF_INFO)),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function frameAad(context: string, seq: number): ArrayBuffer {
  return toArrayBuffer(textEncoder.encode(`${context}#${seq}`));
}

/** 使用 AES-256-GCM 加密设备帧，并将 context 与 seq 绑定为 AAD。 */
export async function encryptDeviceFrame(
  key: CryptoKey,
  seq: number,
  context: string,
  plaintext: string | Uint8Array,
): Promise<E2eeEncryptedFrame> {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("设备帧序号必须为非负安全整数。");
  }
  const subtle = getSubtle();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plainBytes =
    typeof plaintext === "string" ? textEncoder.encode(plaintext) : plaintext;

  const encrypted = new Uint8Array(
    await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: frameAad(context, seq),
      },
      key,
      toArrayBuffer(plainBytes),
    ),
  );

  return {
    seq,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(encrypted),
  };
}

/**
 * 解密设备帧并校验防重放序号（严格要求 frame.seq > state.maxSeq）。
 * 仅在 GCM 认证通过后推进 state.maxSeq，避免伪造坏包污染状态。
 */
export async function decryptDeviceFrame(
  key: CryptoKey,
  state: E2eeReplayState,
  context: string,
  frame: E2eeEncryptedFrame,
): Promise<string> {
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) {
    throw new Error("设备帧序号无效。");
  }
  if (frame.seq <= state.maxSeq) {
    throw new Error(
      `检测到重复或过期帧序号（seq=${frame.seq}, maxSeq=${state.maxSeq}）。`,
    );
  }
  const subtle = getSubtle();
  const iv = decodeBase64Url(frame.iv);
  if (iv.length !== 12) {
    throw new Error("设备帧 IV 长度无效。");
  }
  const cipherBytes = decodeBase64Url(frame.ciphertext);

  const decrypted = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: frameAad(context, frame.seq),
    },
    key,
    toArrayBuffer(cipherBytes),
  );

  state.maxSeq = frame.seq;
  return textDecoder.decode(decrypted);
}

function parseIpv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    octets.push(num);
  }
  return octets;
}

/** 判断主机名或 IP 是否属于 Tailscale（100.64.0.0/10、*.ts.net、fd7a:115c:a1e0::/48）。 */
export function isTailscaleHost(host: string): boolean {
  const clean = host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!clean) return false;
  if (clean.endsWith(".ts.net") && clean.length > ".ts.net".length) {
    return true;
  }
  if (clean.startsWith("fd7a:115c:a1e0:")) {
    return true;
  }
  const v4 = parseIpv4Octets(clean);
  if (!v4) return false;
  const [a, b] = v4;
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * 识别局域网、本机回环或 Tailscale 地址（10/8、172.16/12、192.168/16、100.64/10、*.ts.net、localhost、*.local）。
 */
export function isTailscaleOrLanHost(host: string): boolean {
  const clean = host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!clean) return false;
  if (clean === "localhost" || clean.endsWith(".local")) return true;
  if (isTailscaleHost(clean)) return true;
  if (clean.includes(":")) {
    return (
      clean === "::1" ||
      clean.startsWith("fe80:") ||
      clean.startsWith("fc") ||
      clean.startsWith("fd")
    );
  }
  const v4 = parseIpv4Octets(clean);
  if (!v4) return false;
  const [a, b] = v4;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
