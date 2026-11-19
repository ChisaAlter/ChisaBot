import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  BlockedUrlError,
  guardedFetch,
} from "../../../shared/net/guarded-fetch";
import {
  buildChannelDeepLink,
  extractBarkEndpointFromCurl,
  type NotificationKind,
  type PushDeviceView,
  type PushPlatform,
  type PushProvider,
  truncateNotificationText,
} from "../../../shared/notifications";
import type { AppVariables } from "../auth/guards";
import { DeliveryRefusedError, type PushDevice } from "./types";

const SEAL_PREFIX = "enc:v1:";
const PUSH_BODY_LIMIT_BYTES = 64 * 1024;
const PUSH_TIMEOUT_MS = 10_000;
const PUSH_MAX_RESPONSE_BYTES = 16 * 1024;
const APNS_FCM_PAYLOAD_LIMIT_BYTES = 4096;

/** 与 `DeliveryStore` 的设备存储契约对齐，便于生产直连 Postgres `push_devices` 与单测内存替身复用。 */
export type PushDeviceRecord = PushDevice & {
  createdAt?: Date | string;
};

export type PushDeviceStore = {
  registerDevice(input: Omit<PushDevice, "enabled">): Promise<PushDeviceRecord>;
  devices(owner: string): Promise<PushDeviceRecord[]>;
  device(id: string): Promise<PushDeviceRecord | null>;
  removeDevice(owner: string, id: string): Promise<void>;
};

export type PushNotificationMessage = {
  id: string;
  title: string;
  body: string;
  channelId?: string;
  agentId?: string;
  deepLink: string;
  kind: NotificationKind | "test";
};

export type PushDeliveryOutcome = {
  deviceId: string;
  provider: PushProvider;
  ok: boolean;
  status: number;
  invalidTokenRemoved: boolean;
  error?: string;
};

type StoredDeviceMetadata = {
  v: 1;
  provider: PushProvider;
  label: string;
  host: string | null;
  fingerprint: string;
};

type BarkSecretPayload = {
  provider: "bark";
  serverUrl: string;
  deviceKey: string;
};

type FcmSecretPayload = {
  provider: "fcm";
  deviceToken: string;
  endpoint: string;
  accessToken: string;
  fcmProjectId?: string;
};

type ApnsSecretPayload = {
  provider: "apns";
  deviceToken: string;
  topic: string;
  environment: "production" | "development";
  bearerToken?: string;
  keyId?: string;
  teamId?: string;
  privateKey?: string;
};

type PushSecretPayload =
  | BarkSecretPayload
  | FcmSecretPayload
  | ApnsSecretPayload;

function derivePushKey(encryptionKey: string): Buffer {
  return createHash("sha256")
    .update(`chisabot-push-devices:${encryptionKey}`)
    .digest();
}

/** 使用 AES-256-GCM 封存推送凭据（随机 12 字节 IV + AuthTag），严禁明文落盘。 */
export function sealPushCredential(
  encryptionKey: string,
  plaintext: string,
): string {
  const key = derivePushKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${SEAL_PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

/** 解封 AES-256-GCM 封存的推送凭据。 */
export function unsealPushCredential(
  encryptionKey: string,
  sealed: string,
): string {
  if (!sealed.startsWith(SEAL_PREFIX)) {
    throw new Error("推送凭据格式无效（缺少加密信封前缀）。");
  }
  const rest = sealed.slice(SEAL_PREFIX.length);
  const parts = rest.split(".");
  if (parts.length !== 3) {
    throw new Error("推送凭据信封损坏。");
  }
  const [ivB64, tagB64, dataB64] = parts;
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("推送凭据信封字段缺失。");
  }
  const key = derivePushKey(encryptionKey);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function credentialFingerprint(
  encryptionKey: string,
  canonical: string,
): string {
  return createHmac("sha256", derivePushKey(encryptionKey))
    .update(canonical)
    .digest("hex");
}

/** UTF-8 字节安全截断：按字素/码点裁剪，保证绝不切断多字节字符且严格不超过 maxBytes。 */
export function truncateUtf8Bytes(input: string, maxBytes: number): string {
  const clean = String(input ?? "").trim();
  if (!clean || maxBytes <= 0) return "";
  if (Buffer.byteLength(clean, "utf8") <= maxBytes) return clean;
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  if (maxBytes <= ellipsisBytes) return "";

  const segments =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            clean,
          ),
          (item) => item.segment,
        )
      : Array.from(clean);

  let out = "";
  let used = 0;
  const limit = maxBytes - ellipsisBytes;
  for (const segment of segments) {
    const bytes = Buffer.byteLength(segment, "utf8");
    if (used + bytes > limit) break;
    out += segment;
    used += bytes;
  }
  return out ? `${out}${ellipsis}` : "";
}

function parseMetadata(projectId: string): StoredDeviceMetadata | null {
  try {
    const parsed = JSON.parse(projectId) as Partial<StoredDeviceMetadata>;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.v === 1 &&
      (parsed.provider === "bark" ||
        parsed.provider === "fcm" ||
        parsed.provider === "apns") &&
      typeof parsed.label === "string" &&
      typeof parsed.fingerprint === "string"
    ) {
      return {
        v: 1,
        provider: parsed.provider,
        label: parsed.label,
        host: typeof parsed.host === "string" ? parsed.host : null,
        fingerprint: parsed.fingerprint,
      };
    }
  } catch {
    // 兼容历史 push_devices 行（旧行 projectId 为纯文本项目名）
  }
  return null;
}

function toPublicDeviceView(row: PushDeviceRecord): PushDeviceView {
  const meta = parseMetadata(row.projectId);
  const createdAt =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : typeof row.createdAt === "string"
        ? row.createdAt
        : new Date().toISOString();
  return {
    id: row.id,
    platform: row.platform,
    provider: meta?.provider ?? (row.platform === "ios" ? "apns" : "fcm"),
    label:
      meta?.label ??
      (row.platform === "ios" ? "iOS 推送设备" : "Android 推送设备"),
    host: meta?.host ?? null,
    enabled: row.enabled,
    createdAt,
  };
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signApnsJwt(input: {
  keyId: string;
  teamId: string;
  privateKey: string;
  nowMs?: number;
}): string {
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const unsigned = `${b64urlJson({ alg: "ES256", kid: input.keyId })}.${b64urlJson({ iss: input.teamId, iat: nowSec })}`;
  const signature = sign("sha256", Buffer.from(unsigned, "utf8"), {
    key: createPrivateKey(input.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

function buildApnsPayloadJson(message: PushNotificationMessage): string {
  const title = truncateUtf8Bytes(
    truncateNotificationText(message.title, 80),
    160,
  );
  let body = truncateUtf8Bytes(
    truncateNotificationText(message.body, 180),
    1024,
  );
  const build = (currentBody: string) =>
    JSON.stringify({
      aps: {
        alert: { title, body: currentBody },
        sound: "default",
        ...(message.channelId ? { "thread-id": message.channelId } : {}),
      },
      notificationId: message.id,
      ...(message.channelId ? { channelId: message.channelId } : {}),
      ...(message.agentId ? { agentId: message.agentId } : {}),
      deepLink: message.deepLink,
    });

  let encoded = build(body);
  while (
    Buffer.byteLength(encoded, "utf8") > APNS_FCM_PAYLOAD_LIMIT_BYTES &&
    body.length > 0
  ) {
    const nextBudget = Math.max(
      0,
      Buffer.byteLength(body, "utf8") -
        (Buffer.byteLength(encoded, "utf8") - APNS_FCM_PAYLOAD_LIMIT_BYTES) -
        16,
    );
    body = truncateUtf8Bytes(body, nextBudget);
    encoded = build(body);
  }
  return encoded;
}

function buildFcmPayloadJson(
  deviceToken: string,
  message: PushNotificationMessage,
): string {
  const title = truncateUtf8Bytes(
    truncateNotificationText(message.title, 80),
    160,
  );
  let body = truncateUtf8Bytes(
    truncateNotificationText(message.body, 180),
    1024,
  );
  const build = (currentBody: string) =>
    JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title, body: currentBody },
        data: {
          notificationId: message.id,
          deepLink: message.deepLink,
          ...(message.channelId ? { channelId: message.channelId } : {}),
          ...(message.agentId ? { agentId: message.agentId } : {}),
          kind: message.kind,
        },
      },
    });

  let encoded = build(body);
  while (
    Buffer.byteLength(encoded, "utf8") > APNS_FCM_PAYLOAD_LIMIT_BYTES &&
    body.length > 0
  ) {
    const nextBudget = Math.max(
      0,
      Buffer.byteLength(body, "utf8") -
        (Buffer.byteLength(encoded, "utf8") - APNS_FCM_PAYLOAD_LIMIT_BYTES) -
        16,
    );
    body = truncateUtf8Bytes(body, nextBudget);
    encoded = build(body);
  }
  return encoded;
}

function isInvalidTokenResponse(
  provider: PushProvider,
  status: number,
  bodyText: string,
): boolean {
  if (status === 404 || status === 410) return true;
  if (
    /unregistered|baddevicetoken|devicetokennotfortopic|invalidregistration|notregistered/i.test(
      bodyText,
    )
  ) {
    return true;
  }
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (provider === "bark") {
      if (parsed.code === 404 || parsed.code === 410) return true;
      if (
        typeof parsed.message === "string" &&
        /device\s*key.*(invalid|not\s*found|unregistered)|failed to get device token/i.test(
          parsed.message,
        )
      ) {
        return true;
      }
    }
    if (provider === "fcm") {
      const errorObj = parsed.error as Record<string, unknown> | undefined;
      if (errorObj?.status === "NOT_FOUND") return true;
      if (
        Array.isArray(errorObj?.details) &&
        errorObj.details.some(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as Record<string, unknown>).errorCode === "UNREGISTERED",
        )
      ) {
        return true;
      }
    }
    if (provider === "apns") {
      const reason = parsed.reason;
      if (
        reason === "Unregistered" ||
        reason === "BadDeviceToken" ||
        reason === "DeviceTokenNotForTopic"
      ) {
        return true;
      }
    }
  } catch {
    // 非 JSON 响应按状态码与文本正则处理
  }
  return false;
}

function validatePublicPushUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DeliveryRefusedError("推送服务地址格式无效。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DeliveryRefusedError("推送服务地址必须使用 HTTP(S) 协议。");
  }
  if (url.username || url.password || url.hash) {
    throw new DeliveryRefusedError("推送服务地址不能包含内嵌账号密码或片段。");
  }
  return url;
}

const SAFE_DEEP_LINK_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

const testDeviceBodySchema = z.strictObject({
  channelId: z
    .string()
    .trim()
    .regex(SAFE_DEEP_LINK_ID_RE, "channelId 格式无效。")
    .refine((value) => value !== "." && value !== "..", "channelId 格式无效。")
    .optional(),
  agentId: z
    .string()
    .trim()
    .regex(SAFE_DEEP_LINK_ID_RE, "agentId 格式无效。")
    .refine((value) => value !== "." && value !== "..", "agentId 格式无效。")
    .optional(),
});

const registerDeviceSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("bark"),
    platform: z.enum(["ios", "android"]).optional(),
    label: z.string().trim().min(1).max(80).optional(),
    barkCurl: z.string().trim().min(1).max(4096).optional(),
    serverUrl: z.string().trim().min(1).max(512).optional(),
    deviceKey: z.string().trim().min(8).max(256).optional(),
  }),
  z.strictObject({
    provider: z.literal("fcm"),
    platform: z.enum(["ios", "android"]).optional(),
    label: z.string().trim().min(1).max(80).optional(),
    deviceToken: z.string().trim().min(16).max(1024),
    fcmProjectId: z.string().trim().min(1).max(128).optional(),
    endpoint: z.string().trim().min(1).max(512).optional(),
    accessToken: z.string().trim().min(8).max(4096),
  }),
  z.strictObject({
    provider: z.literal("apns"),
    platform: z.literal("ios").optional(),
    label: z.string().trim().min(1).max(80).optional(),
    deviceToken: z
      .string()
      .trim()
      .regex(/^(?:[a-fA-F0-9]{2}){16,256}$/, "APNs 设备令牌需为十六进制字符串"),
    topic: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/, "APNs Topic 格式无效"),
    environment: z.enum(["production", "development"]).default("production"),
    bearerToken: z.string().trim().min(16).max(4096).optional(),
    keyId: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    teamId: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    privateKey: z.string().trim().min(32).max(16384).optional(),
  }),
]);

export type RegisterPushDeviceInput = z.infer<typeof registerDeviceSchema>;

export type PushServiceOptions = {
  store: PushDeviceStore;
  encryptionKey: string;
  /** 测试依赖注入用，会透传至 `guardedFetch`（生产默认走内置 DNS 钉死公网校验）。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export function createPushService(options: PushServiceOptions) {
  const { store, encryptionKey } = options;
  const clock = options.now ?? (() => Date.now());

  async function listDevices(ownerUserId: string): Promise<PushDeviceView[]> {
    const rows = await store.devices(ownerUserId);
    return rows.map(toPublicDeviceView);
  }

  async function registerDevice(
    ownerUserId: string,
    input: RegisterPushDeviceInput,
  ): Promise<PushDeviceView> {
    let secretPayload: PushSecretPayload;
    let platform: PushPlatform;
    let host: string | null = null;
    let defaultLabel: string;
    let canonicalId: string;

    if (input.provider === "bark") {
      let serverUrl = input.serverUrl?.trim() ?? "";
      let deviceKey = input.deviceKey?.trim() ?? "";
      if (input.barkCurl) {
        const parsed = extractBarkEndpointFromCurl(input.barkCurl);
        if (!parsed) {
          throw new DeliveryRefusedError(
            "无法从输入中识别 Bark 推送地址和设备 Key，请直接粘贴 Bark App 的完整链接或 curl 命令。",
          );
        }
        serverUrl = parsed.serverUrl;
        deviceKey = parsed.deviceKey;
      }
      if (!serverUrl || !deviceKey) {
        throw new DeliveryRefusedError(
          "请提供 Bark 链接/curl 命令或服务器地址与设备 Key。",
        );
      }
      if (!/^[A-Za-z0-9_-]{8,256}$/.test(deviceKey)) {
        throw new DeliveryRefusedError("Bark 设备 Key 格式无效。");
      }
      const parsedUrl = validatePublicPushUrl(serverUrl);
      const cleanServerUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/push\/?$/i, "").replace(/\/+$/, "")}`;
      host = parsedUrl.host;
      platform = input.platform ?? "ios";
      defaultLabel = `Bark · ${parsedUrl.host}`;
      canonicalId = `bark:${cleanServerUrl}:${deviceKey}`;
      secretPayload = {
        provider: "bark",
        serverUrl: cleanServerUrl,
        deviceKey,
      };
    } else if (input.provider === "fcm") {
      const endpoint = input.endpoint
        ? validatePublicPushUrl(input.endpoint).toString()
        : input.fcmProjectId
          ? `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(input.fcmProjectId)}/messages:send`
          : "";
      if (!endpoint) {
        throw new DeliveryRefusedError(
          "注册 FCM 推送需要提供 fcmProjectId 或推送网关地址。",
        );
      }
      host = new URL(endpoint).host;
      platform = input.platform ?? "android";
      defaultLabel = platform === "ios" ? "FCM · iOS" : "FCM · Android";
      canonicalId = `fcm:${endpoint}:${input.deviceToken}`;
      secretPayload = {
        provider: "fcm",
        deviceToken: input.deviceToken,
        endpoint,
        accessToken: input.accessToken,
        ...(input.fcmProjectId ? { fcmProjectId: input.fcmProjectId } : {}),
      };
    } else {
      const hasJwtParts = Boolean(
        input.keyId && input.teamId && input.privateKey,
      );
      if (!input.bearerToken && !hasJwtParts) {
        throw new DeliveryRefusedError(
          "注册 APNs 需要提供 bearerToken 或完整的 keyId / teamId / P-256 私钥。",
        );
      }
      if (hasJwtParts && input.privateKey) {
        try {
          const parsedKey = createPrivateKey(input.privateKey);
          if (
            parsedKey.asymmetricKeyType !== "ec" ||
            parsedKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
          ) {
            throw new Error("not p256");
          }
        } catch {
          throw new DeliveryRefusedError(
            "APNs 私钥必须是有效的 EC P-256 (.p8) PEM 私钥。",
          );
        }
      }
      const normalizedToken = input.deviceToken.toLowerCase();
      host =
        input.environment === "development"
          ? "api.sandbox.push.apple.com"
          : "api.push.apple.com";
      platform = "ios";
      defaultLabel = `APNs · ${input.topic}`;
      canonicalId = `apns:${input.environment}:${input.topic}:${normalizedToken}`;
      secretPayload = {
        provider: "apns",
        deviceToken: normalizedToken,
        topic: input.topic,
        environment: input.environment,
        ...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
        ...(input.keyId ? { keyId: input.keyId } : {}),
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.privateKey ? { privateKey: input.privateKey } : {}),
      };
    }

    const fingerprint = credentialFingerprint(encryptionKey, canonicalId);
    const existingDevices = await store.devices(ownerUserId);
    const duplicate = existingDevices.find(
      (item) => parseMetadata(item.projectId)?.fingerprint === fingerprint,
    );
    if (duplicate) {
      // 同凭据重复登记时先软禁旧记录，避免积累重复推送条目。
      await store.removeDevice(ownerUserId, duplicate.id);
    }

    const metadata: StoredDeviceMetadata = {
      v: 1,
      provider: secretPayload.provider,
      label: input.label?.trim() || defaultLabel,
      host,
      fingerprint,
    };
    const sealedToken = sealPushCredential(
      encryptionKey,
      JSON.stringify(secretPayload),
    );
    const created = await store.registerDevice({
      id: `push_${randomUUID()}`,
      ownerUserId,
      token: sealedToken,
      projectId: JSON.stringify(metadata),
      platform,
    });
    return toPublicDeviceView(created);
  }

  async function removeDevice(
    ownerUserId: string,
    id: string,
  ): Promise<boolean> {
    const existing = await store.device(id);
    if (
      !existing ||
      existing.ownerUserId !== ownerUserId ||
      !existing.enabled
    ) {
      return false;
    }
    await store.removeDevice(ownerUserId, id);
    return true;
  }

  async function deliverToRecord(
    record: PushDeviceRecord,
    message: PushNotificationMessage,
  ): Promise<PushDeliveryOutcome> {
    const meta = parseMetadata(record.projectId);
    const fallbackProvider: PushProvider =
      meta?.provider ?? (record.platform === "ios" ? "apns" : "fcm");

    let secret: PushSecretPayload;
    try {
      const plaintext = unsealPushCredential(encryptionKey, record.token);
      secret = JSON.parse(plaintext) as PushSecretPayload;
    } catch {
      return {
        deviceId: record.id,
        provider: fallbackProvider,
        ok: false,
        status: 0,
        invalidTokenRemoved: false,
        error: "推送设备凭据无法解密，请删除后重新登记。",
      };
    }

    let endpoint: string;
    let body: string;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (secret.provider === "bark") {
      endpoint = `${secret.serverUrl.replace(/\/+$/, "")}/push`;
      body = JSON.stringify({
        device_key: secret.deviceKey,
        title: truncateUtf8Bytes(
          truncateNotificationText(message.title, 80),
          160,
        ),
        body: truncateUtf8Bytes(
          truncateNotificationText(message.body, 180),
          1024,
        ),
        group: "ChisaBot",
        url: message.deepLink,
        isArchive: "1",
      });
    } else if (secret.provider === "fcm") {
      endpoint = secret.endpoint;
      headers.authorization = `Bearer ${secret.accessToken}`;
      body = buildFcmPayloadJson(secret.deviceToken, message);
    } else {
      const origin =
        secret.environment === "development"
          ? "https://api.sandbox.push.apple.com"
          : "https://api.push.apple.com";
      endpoint = `${origin}/3/device/${encodeURIComponent(secret.deviceToken)}`;
      const authToken =
        secret.bearerToken ??
        (secret.keyId && secret.teamId && secret.privateKey
          ? signApnsJwt({
              keyId: secret.keyId,
              teamId: secret.teamId,
              privateKey: secret.privateKey,
              nowMs: clock(),
            })
          : "");
      if (!authToken) {
        return {
          deviceId: record.id,
          provider: "apns",
          ok: false,
          status: 0,
          invalidTokenRemoved: false,
          error: "APNs 鉴权令牌缺失。",
        };
      }
      headers.authorization = `bearer ${authToken}`;
      headers["apns-topic"] = secret.topic;
      headers["apns-push-type"] = "alert";
      headers["apns-priority"] = "10";
      headers["apns-id"] = randomUUID();
      body = buildApnsPayloadJson(message);
    }

    let response: Awaited<ReturnType<typeof guardedFetch>>;
    try {
      response = await guardedFetch(endpoint, {
        method: "POST",
        headers,
        body,
        timeoutMs: PUSH_TIMEOUT_MS,
        maxBytes: PUSH_MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        return {
          deviceId: record.id,
          provider: secret.provider,
          ok: false,
          status: 0,
          invalidTokenRemoved: false,
          error: "推送目标地址被安全策略拦截（仅允许公网地址）。",
        };
      }
      return {
        deviceId: record.id,
        provider: secret.provider,
        ok: false,
        status: 0,
        invalidTokenRemoved: false,
        error: "推送网关连接失败，请稍后重试。",
      };
    }

    const rawText = response.body.toString("utf8");
    const isBarkOk =
      secret.provider === "bark"
        ? (() => {
            if (
              !response.status ||
              response.status < 200 ||
              response.status >= 300
            ) {
              return false;
            }
            try {
              const parsed = JSON.parse(rawText) as { code?: unknown };
              return parsed.code === undefined || parsed.code === 200;
            } catch {
              return true;
            }
          })()
        : response.status >= 200 && response.status < 300;

    if (isBarkOk) {
      return {
        deviceId: record.id,
        provider: secret.provider,
        ok: true,
        status: response.status,
        invalidTokenRemoved: false,
      };
    }

    const invalid = isInvalidTokenResponse(
      secret.provider,
      response.status,
      rawText,
    );
    if (invalid) {
      await store.removeDevice(record.ownerUserId, record.id).catch(() => {});
    }

    return {
      deviceId: record.id,
      provider: secret.provider,
      ok: false,
      status: response.status,
      invalidTokenRemoved: invalid,
      error: invalid
        ? "推送令牌已失效，系统已自动清理该设备，请重新登记。"
        : `推送服务返回状态码 ${response.status}。`,
    };
  }

  async function sendToUser(
    ownerUserId: string,
    message: PushNotificationMessage,
  ): Promise<PushDeliveryOutcome[]> {
    const rows = await store.devices(ownerUserId);
    if (rows.length === 0) return [];
    const results: PushDeliveryOutcome[] = [];
    for (const row of rows) {
      if (!row.enabled) continue;
      results.push(await deliverToRecord(row, message));
    }
    return results;
  }

  async function sendTest(
    ownerUserId: string,
    deviceId: string,
    optionsInput?: { channelId?: string; agentId?: string },
  ): Promise<PushDeliveryOutcome | null> {
    const existing = await store.device(deviceId);
    if (
      !existing ||
      existing.ownerUserId !== ownerUserId ||
      !existing.enabled
    ) {
      return null;
    }
    const deepLink = optionsInput?.channelId
      ? buildChannelDeepLink(optionsInput.channelId, optionsInput.agentId)
      : "chisabot://channel/home";
    return deliverToRecord(existing, {
      id: `test:${randomUUID()}`,
      title: "ChisaBot 推送测试",
      body: "移动端推送通道已联通，点击可直接打开对应会话。",
      ...(optionsInput?.channelId ? { channelId: optionsInput.channelId } : {}),
      ...(optionsInput?.agentId ? { agentId: optionsInput.agentId } : {}),
      deepLink,
      kind: "test",
    });
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);

    app.get("/devices", async (context) => {
      const devices = await listDevices(context.var.actor.id);
      return context.json({ devices });
    });

    app.post(
      "/devices",
      bodyLimit({ maxSize: PUSH_BODY_LIMIT_BYTES }),
      async (context) => {
        const body = await context.req.json().catch(() => undefined);
        const parsed = registerDeviceSchema.safeParse(body);
        if (!parsed.success) {
          return context.json(
            {
              error:
                parsed.error.issues[0]?.message ?? "推送设备配置格式无效。",
            },
            400,
          );
        }
        try {
          const device = await registerDevice(
            context.var.actor.id,
            parsed.data,
          );
          return context.json({ device }, 201);
        } catch (error) {
          if (error instanceof DeliveryRefusedError) {
            return context.json({ error: error.message }, 400);
          }
          throw error;
        }
      },
    );

    app.delete("/devices/:id", async (context) => {
      const id = context.req.param("id").trim();
      if (!id || id.length > 200) {
        return context.json({ error: "设备 ID 无效。" }, 400);
      }
      const removed = await removeDevice(context.var.actor.id, id);
      if (!removed) {
        return context.json({ error: "推送设备不存在。" }, 404);
      }
      return context.body(null, 204);
    });

    app.post(
      "/devices/:id/test",
      bodyLimit({ maxSize: 16 * 1024 }),
      async (context) => {
        const id = context.req.param("id").trim();
        if (!id || id.length > 200) {
          return context.json({ error: "设备 ID 无效。" }, 400);
        }
        const rawText = await context.req.text().catch(() => "");
        let rawBody: unknown = {};
        if (rawText.trim().length > 0) {
          try {
            rawBody = JSON.parse(rawText);
          } catch {
            return context.json({ error: "测试推送请求体 JSON 无效。" }, 400);
          }
        }
        const parsed = testDeviceBodySchema.safeParse(rawBody);
        if (!parsed.success) {
          return context.json(
            {
              error:
                parsed.error.issues[0]?.message ?? "测试推送目标参数无效。",
            },
            400,
          );
        }
        const outcome = await sendTest(context.var.actor.id, id, {
          ...(parsed.data.channelId
            ? { channelId: parsed.data.channelId }
            : {}),
          ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
        });
        if (!outcome) {
          return context.json({ error: "推送设备不存在。" }, 404);
        }
        return context.json(outcome, outcome.ok ? 200 : 502);
      },
    );

    app.post(
      "/bark/parse",
      bodyLimit({ maxSize: 16 * 1024 }),
      async (context) => {
        const body = (await context.req.json().catch(() => null)) as {
          raw?: unknown;
        } | null;
        if (typeof body?.raw !== "string") {
          return context.json({ error: "请粘贴 Bark 链接或 curl 命令。" }, 400);
        }
        const parsed = extractBarkEndpointFromCurl(body.raw);
        if (!parsed) {
          return context.json(
            { error: "未识别出合法的 Bark 服务器地址与设备 Key。" },
            400,
          );
        }
        const host = new URL(parsed.serverUrl).host;
        const maskedKey =
          parsed.deviceKey.length > 8
            ? `${parsed.deviceKey.slice(0, 4)}…${parsed.deviceKey.slice(-4)}`
            : "****";
        return context.json({
          endpoint: {
            serverUrl: parsed.serverUrl,
            host,
            maskedKey,
          },
        });
      },
    );

    return app;
  }

  return {
    listDevices,
    registerDevice,
    removeDevice,
    sendToUser,
    sendTest,
    routes,
  };
}

export type PushService = ReturnType<typeof createPushService>;
