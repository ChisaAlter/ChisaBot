/**
 * 本机 Chrome/Edge 登录态按单域名审批导入（Cookie Origin Approval）+ WebAuthn/Passkey 跨端转发服务端桥。
 *
 * 安全红线：
 * 1. 双向挂起队列严格按 `(ownerUserId, deviceId)` 隔离，禁止跨用户、跨设备窃听或抢答；
 * 2. 权限完全基于配对签发的显式设备 scope（`browser_bridge` / `passkey_forward`），绝不信任请求体或设备自报 `platform: "desktop"`；
 * 3. 严格遵循 Wave 4 Harness 开关（`cookieImport` 与 `passkeyForward`），开关关闭时立即 409 拒签；
 * 4. Cookie 审批限定单一 `origin`，服务端对端侧回传的每条 Cookie 二次强校验归属域，防夹带跨域 Cookie；
 * 5. WebAuthn 强校验 `rpId` 与 `origin` 绑定关系，并对一次性 `challenge` 执行 SHA-256 去重防重放。
 */

import { createHash, randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  DEFAULT_HARNESS_FLAGS,
  type HarnessFlags,
} from "../../../shared/admin-workbench";
import {
  type CookieApprovalDecision,
  type CookieApprovalRequest,
  DEFAULT_CHALLENGE_REPLAY_TTL_MS,
  DEFAULT_COOKIE_APPROVAL_TTL_MS,
  DEFAULT_WEBAUTHN_TTL_MS,
  DESKTOP_BRIDGE_SCOPES,
  type DesktopBridgeScope,
  type ImportedBrowserCookie,
  isDesktopBridgeScope,
  normalizeSingleOrigin,
  normalizeWebAuthnChallenge,
  redactCookieSummary,
  validateOriginCookies,
  validateWebAuthnClientDataJson,
  validateWebAuthnOptionsJson,
  validateWebAuthnRpId,
  type WebAuthnCeremonyKind,
  type WebAuthnForwardRequest,
  type WebAuthnForwardResponse,
} from "../../../shared/desktop-browser-bridge";
import { isMobilePlatform } from "../../../shared/devices";
import type { AppVariables } from "../auth/guards";
import type { DeviceHub } from "../devices/hub";
import type { DeviceRecord, DeviceStore } from "../devices/store";
import { type GrantedTool, REFUSAL_MARKER } from "../tools/contract";

export class DesktopBrowserBridgeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 = 400,
  ) {
    super(message);
    this.name = "DesktopBrowserBridgeError";
  }
}

export type DesktopBrowserBridgeOptions = {
  deviceStore: Pick<DeviceStore, "get" | "forOwner" | "audit"> &
    Partial<Pick<DeviceStore, "authenticate">>;
  hub?: Pick<DeviceHub, "isOnline" | "sendRaw">;
  /** Wave 4 Harness 开关读取器；默认采用 DEFAULT_HARNESS_FLAGS。 */
  getHarnessFlags?: () => Promise<HarnessFlags> | HarnessFlags;
  /** 可选自定义设备 scope 解析器（若未提供，使用内置的配对签发 scope 注册表）。 */
  resolveDeviceScopes?: (
    device: DeviceRecord,
  ) => Promise<readonly DesktopBridgeScope[]> | readonly DesktopBridgeScope[];
  now?: () => number;
  cookieApprovalTtlMs?: number;
  webAuthnTtlMs?: number;
  challengeReplayTtlMs?: number;
  settledRetentionMs?: number;
};

const DEFAULT_SETTLED_RETENTION_MS = 15_000;

type PendingCookieEntry = {
  request: CookieApprovalRequest;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  evictTimer?: ReturnType<typeof setTimeout>;
  waiters: Set<
    (
      result: CookieApprovalDecision & {
        status: CookieApprovalRequest["status"];
      },
    ) => void
  >;
  result?: CookieApprovalDecision & { status: CookieApprovalRequest["status"] };
};

type PendingWebAuthnEntry = {
  request: WebAuthnForwardRequest;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  evictTimer?: ReturnType<typeof setTimeout>;
  waiters: Set<
    (
      result: WebAuthnForwardResponse & {
        status: WebAuthnForwardRequest["status"];
      },
    ) => void
  >;
  result?: WebAuthnForwardResponse & {
    status: WebAuthnForwardRequest["status"];
  };
};

function queuePartitionKey(ownerUserId: string, deviceId: string): string {
  return JSON.stringify([ownerUserId, deviceId]);
}

function hashChallenge(
  ownerUserId: string,
  origin: string,
  rpId: string,
  challenge: string,
): string {
  return createHash("sha256")
    .update(`${ownerUserId}\0${origin}\0${rpId}\0${challenge}`)
    .digest("hex");
}

function unrefTimer(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

const cookieItemSchema = z
  .object({
    name: z.string().min(1).max(256),
    value: z.string().max(8192),
    domain: z.string().min(1).max(255),
    path: z.string().min(1).max(1024).default("/"),
    expires: z.number().finite().nullable().optional(),
    httpOnly: z.boolean().default(false),
    secure: z.boolean().default(false),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  })
  .strict();

const cookieCreateSchema = z
  .object({
    deviceId: z.string().min(1).max(120),
    botId: z.string().min(1).max(120).default("default"),
    origin: z.string().min(1).max(512),
    reason: z.string().max(400).optional(),
    profileHint: z.string().max(160).optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
    wait: z.boolean().optional(),
  })
  .strict();

const cookieDecisionSchema = z.discriminatedUnion("approved", [
  z
    .object({
      approved: z.literal(true),
      profileId: z.string().max(160).optional(),
      cookies: z.array(cookieItemSchema).max(200),
    })
    .strict(),
  z
    .object({
      approved: z.literal(false),
      reason: z.string().max(400).optional(),
    })
    .strict(),
]);

const webAuthnCreateSchema = z
  .object({
    deviceId: z.string().min(1).max(120),
    botId: z.string().min(1).max(120).default("default"),
    kind: z.enum(["create", "get"]),
    origin: z.string().min(1).max(512),
    rpId: z.string().min(1).max(253),
    challenge: z.string().min(16).max(512),
    optionsJson: z.string().max(65_536).optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
    wait: z.boolean().optional(),
  })
  .strict();

const webAuthnResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      credentialId: z.string().min(1).max(512),
      clientDataJSON: z.string().min(1).max(16_384),
      attestationObject: z.string().max(65_536).optional(),
      authenticatorData: z.string().max(16_384).optional(),
      signature: z.string().max(8192).optional(),
      userHandle: z.string().max(512).nullable().optional(),
      transports: z.array(z.string().max(40)).max(8).optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      denied: z.boolean().optional(),
      error: z.string().min(1).max(500),
    })
    .strict(),
]);

const scopesPatchSchema = z
  .object({
    scopes: z.array(z.enum(DESKTOP_BRIDGE_SCOPES)).max(16),
  })
  .strict();

export function createDesktopBrowserBridge(
  options: DesktopBrowserBridgeOptions,
) {
  const { deviceStore, hub } = options;
  const now = options.now ?? Date.now;
  const cookieApprovalTtlMs =
    options.cookieApprovalTtlMs ?? DEFAULT_COOKIE_APPROVAL_TTL_MS;
  const webAuthnTtlMs = options.webAuthnTtlMs ?? DEFAULT_WEBAUTHN_TTL_MS;
  const challengeReplayTtlMs =
    options.challengeReplayTtlMs ?? DEFAULT_CHALLENGE_REPLAY_TTL_MS;
  const settledRetentionMs = Math.max(
    50,
    options.settledRetentionMs ?? DEFAULT_SETTLED_RETENTION_MS,
  );

  /** 按 `(ownerUserId, deviceId)` 隔离存储设备配对签发的显式 bridge scopes。 */
  const grantedScopesByPartition = new Map<string, Set<DesktopBridgeScope>>();
  const cookieRequests = new Map<string, PendingCookieEntry>();
  const webAuthnRequests = new Map<string, PendingWebAuthnEntry>();
  /** 一次性 WebAuthn challenge 防重放表：hash -> 过期毫秒戳。 */
  const usedChallenges = new Map<string, number>();

  async function readFlags(): Promise<HarnessFlags> {
    if (!options.getHarnessFlags) return { ...DEFAULT_HARNESS_FLAGS };
    return await options.getHarnessFlags();
  }

  function pruneReplayCache() {
    const ts = now();
    for (const [key, expiresAt] of usedChallenges.entries()) {
      if (expiresAt <= ts) usedChallenges.delete(key);
    }
  }

  async function scopesOf(
    device: DeviceRecord,
  ): Promise<Set<DesktopBridgeScope>> {
    if (options.resolveDeviceScopes) {
      const resolved = await options.resolveDeviceScopes(device);
      return new Set(resolved.filter(isDesktopBridgeScope));
    }
    const partition = queuePartitionKey(device.ownerUserId, device.id);
    return new Set(grantedScopesByPartition.get(partition) ?? []);
  }

  /**
   * 显式签发 / 回收某设备的桌面桥接能力 scope（仅设备主人可操作）。
   */
  async function setDeviceScopes(
    ownerUserId: string,
    deviceId: string,
    scopes: readonly DesktopBridgeScope[],
  ): Promise<DesktopBridgeScope[]> {
    const device = await deviceStore.get(deviceId);
    if (!device || device.ownerUserId !== ownerUserId || device.revoked) {
      throw new DesktopBrowserBridgeError(
        "找不到该设备或无权修改其能力授权。",
        404,
      );
    }
    if (isMobilePlatform(device.platform)) {
      throw new DesktopBrowserBridgeError(
        "移动设备不支持桌面浏览器桥接能力。",
        400,
      );
    }
    const clean = [...new Set(scopes.filter(isDesktopBridgeScope))];
    const partition = queuePartitionKey(ownerUserId, deviceId);
    grantedScopesByPartition.set(partition, new Set(clean));
    await deviceStore
      .audit({
        deviceId: device.id,
        ownerUserId,
        actorType: "user",
        actorId: ownerUserId,
        actorName: null,
        action: "desktop_browser_scopes_updated",
        summary: `更新桌面桥接 scope：${clean.length ? clean.join("、") : "（全部关闭）"}`,
        outcome: "succeeded",
        detail: null,
        durationMs: null,
      })
      .catch(() => {});
    return clean;
  }

  async function getDeviceScopes(
    ownerUserId: string,
    deviceId: string,
  ): Promise<DesktopBridgeScope[]> {
    const device = await deviceStore.get(deviceId);
    if (!device || device.ownerUserId !== ownerUserId || device.revoked) {
      throw new DesktopBrowserBridgeError("找不到该设备。", 404);
    }
    return [...(await scopesOf(device))];
  }

  /**
   * 严格校验设备归属、非暂停/撤销与配对签发 scope（绝不信任自报 `platform: "desktop"`）。
   */
  async function assertAuthorizedDevice(
    ownerUserId: string,
    deviceId: string,
    requiredScopes: readonly DesktopBridgeScope[],
  ): Promise<DeviceRecord> {
    const device = await deviceStore.get(deviceId);
    if (!device || device.ownerUserId !== ownerUserId || device.revoked) {
      throw new DesktopBrowserBridgeError(
        "找不到归属当前用户的有效设备。",
        404,
      );
    }
    if (device.paused) {
      throw new DesktopBrowserBridgeError(
        `设备「${device.name}」已开启紧急停止，拒绝桥接请求。`,
        409,
      );
    }
    if (isMobilePlatform(device.platform)) {
      throw new DesktopBrowserBridgeError(
        "手机设备不能充当桌面浏览器桥接端。",
        403,
      );
    }
    const scopes = await scopesOf(device);
    const allowed = requiredScopes.some((scope) => scopes.has(scope));
    if (!allowed) {
      throw new DesktopBrowserBridgeError(
        `设备「${device.name}」未签发所需能力 scope（需要 ${requiredScopes.join(" 或 ")}）；请先在设备设置中显式授权。`,
        403,
      );
    }
    return device;
  }

  function scrubCookieResult(
    result: CookieApprovalDecision & {
      status: CookieApprovalRequest["status"];
    },
  ): CookieApprovalDecision & { status: CookieApprovalRequest["status"] } {
    if (result.approved) {
      return {
        ...result,
        cookies: [],
      };
    }
    return result;
  }

  function scheduleCookieEvict(requestId: string, entry: PendingCookieEntry) {
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    entry.evictTimer = setTimeout(() => {
      if (entry.result) {
        entry.result = scrubCookieResult(entry.result);
      }
      cookieRequests.delete(requestId);
    }, settledRetentionMs);
    unrefTimer(entry.evictTimer);
  }

  function scheduleWebAuthnEvict(
    requestId: string,
    entry: PendingWebAuthnEntry,
  ) {
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
    entry.evictTimer = setTimeout(() => {
      entry.result = undefined;
      webAuthnRequests.delete(requestId);
    }, settledRetentionMs);
    unrefTimer(entry.evictTimer);
  }

  function settleCookieEntry(
    entry: PendingCookieEntry,
    status: CookieApprovalRequest["status"],
    decision: CookieApprovalDecision,
    error?: string | null,
  ) {
    if (entry.request.status !== "pending") return;
    clearTimeout(entry.timer);
    entry.request.status = status;
    entry.request.resolvedAt = new Date(now()).toISOString();
    if (decision.approved) {
      entry.request.cookieCount = decision.cookies.length;
    }
    entry.request.error =
      error ?? (decision.approved ? null : (decision.reason ?? null));
    const finalResult = { ...decision, status };
    const hadWaiters = entry.waiters.size > 0;
    for (const wake of [...entry.waiters]) {
      wake(finalResult);
    }
    entry.waiters.clear();
    // 一旦已通知当前 waiter，立即清除内存中的明文 Cookie，避免长期滞留。
    entry.result = hadWaiters ? scrubCookieResult(finalResult) : finalResult;
    scheduleCookieEvict(entry.request.requestId, entry);
  }

  function settleWebAuthnEntry(
    entry: PendingWebAuthnEntry,
    status: WebAuthnForwardRequest["status"],
    response: WebAuthnForwardResponse,
  ) {
    if (entry.request.status !== "pending") return;
    clearTimeout(entry.timer);
    entry.request.status = status;
    entry.request.resolvedAt = new Date(now()).toISOString();
    entry.request.error = response.ok ? null : response.error;
    const finalResult = { ...response, status };
    entry.result = finalResult;
    for (const wake of [...entry.waiters]) {
      wake(finalResult);
    }
    entry.waiters.clear();
    scheduleWebAuthnEvict(entry.request.requestId, entry);
  }

  /**
   * 发起单域名 Cookie 审批导入请求。
   */
  async function createCookieApproval(input: {
    ownerUserId: string;
    deviceId: string;
    botId: string;
    origin: string;
    reason?: string;
    profileHint?: string;
    timeoutMs?: number;
  }): Promise<CookieApprovalRequest> {
    const flags = await readFlags();
    if (!flags.cookieImport) {
      throw new DesktopBrowserBridgeError(
        "管理员已在 Harness 开关台关闭「导入浏览器登录态（cookieImport）」。",
        409,
      );
    }
    let normalizedOrigin: string;
    try {
      normalizedOrigin = normalizeSingleOrigin(input.origin);
    } catch (error) {
      throw new DesktopBrowserBridgeError(
        error instanceof Error ? error.message : "origin 格式无效。",
        400,
      );
    }
    const device = await assertAuthorizedDevice(
      input.ownerUserId,
      input.deviceId,
      ["browser_bridge"],
    );

    const requestId = `ck_${randomUUID()}`;
    const ttl = Math.min(
      300_000,
      Math.max(500, input.timeoutMs ?? cookieApprovalTtlMs),
    );
    const createdMs = now();
    const expiresAtMs = createdMs + ttl;
    const request: CookieApprovalRequest = {
      requestId,
      ownerUserId: input.ownerUserId,
      deviceId: device.id,
      botId: input.botId,
      origin: normalizedOrigin,
      ...(input.reason ? { reason: input.reason.slice(0, 400) } : {}),
      ...(input.profileHint
        ? { profileHint: input.profileHint.slice(0, 160) }
        : {}),
      status: "pending",
      createdAt: new Date(createdMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      resolvedAt: null,
    };

    const timer = setTimeout(() => {
      const current = cookieRequests.get(requestId);
      if (current && current.request.status === "pending") {
        settleCookieEntry(
          current,
          "expired",
          { approved: false, reason: "Cookie 审批请求已超时过期。" },
          "Cookie 审批请求已超时过期。",
        );
      }
    }, ttl);
    unrefTimer(timer);

    const entry: PendingCookieEntry = {
      request,
      expiresAtMs,
      timer,
      waiters: new Set(),
    };
    cookieRequests.set(requestId, entry);

    hub?.sendRaw(device.id, {
      type: "desktop_browser_cookie_request",
      requestId,
      origin: normalizedOrigin,
      botId: input.botId,
      reason: request.reason,
      profileHint: request.profileHint,
      expiresAt: request.expiresAt,
    });

    await deviceStore
      .audit({
        deviceId: device.id,
        ownerUserId: input.ownerUserId,
        actorType: "bot",
        actorId: input.botId,
        actorName: null,
        action: "desktop_browser_cookie_requested",
        summary: `请求按单域名导入 Cookie：${normalizedOrigin}`,
        outcome: "succeeded",
        detail: null,
        durationMs: null,
      })
      .catch(() => {});

    return { ...request };
  }

  function waitForCookieApproval(
    ownerUserId: string,
    requestId: string,
  ): Promise<
    CookieApprovalDecision & { status: CookieApprovalRequest["status"] }
  > {
    const entry = cookieRequests.get(requestId);
    if (!entry || entry.request.ownerUserId !== ownerUserId) {
      return Promise.reject(
        new DesktopBrowserBridgeError("找不到该 Cookie 审批请求。", 404),
      );
    }
    if (entry.request.status !== "pending" && entry.result) {
      const delivered = entry.result;
      // 一次性消费后立即抹除内存中的明文 Cookie。
      entry.result = scrubCookieResult(delivered);
      return Promise.resolve(delivered);
    }
    if (entry.expiresAtMs <= now()) {
      settleCookieEntry(
        entry,
        "expired",
        { approved: false, reason: "Cookie 审批请求已超时过期。" },
        "Cookie 审批请求已超时过期。",
      );
      return Promise.resolve(
        entry.result ?? {
          approved: false,
          reason: "Cookie 审批请求已超时过期。",
          status: "expired",
        },
      );
    }
    return new Promise((resolve) => {
      entry.waiters.add(resolve);
    });
  }

  async function respondCookieApproval(input: {
    ownerUserId: string;
    deviceId?: string;
    requestId: string;
    decision: CookieApprovalDecision;
  }): Promise<{
    request: CookieApprovalRequest;
    cookies: ImportedBrowserCookie[];
  }> {
    const entry = cookieRequests.get(input.requestId);
    if (!entry || entry.request.ownerUserId !== input.ownerUserId) {
      throw new DesktopBrowserBridgeError("找不到该 Cookie 审批请求。", 404);
    }
    if (input.deviceId && entry.request.deviceId !== input.deviceId) {
      throw new DesktopBrowserBridgeError(
        "设备不匹配：不能代其他设备提交 Cookie 审批结果。",
        403,
      );
    }
    if (entry.request.status !== "pending") {
      throw new DesktopBrowserBridgeError(
        `该审批请求已结束（${entry.request.status}），不能重复提交。`,
        409,
      );
    }
    if (entry.expiresAtMs <= now()) {
      settleCookieEntry(
        entry,
        "expired",
        { approved: false, reason: "Cookie 审批请求已超时过期。" },
        "Cookie 审批请求已超时过期。",
      );
      throw new DesktopBrowserBridgeError(
        "该 Cookie 审批请求已超时过期。",
        410,
      );
    }
    // 响应阶段二次复核设备有效状态、急停状态、非移动平台与配对签发 scope。
    await assertAuthorizedDevice(
      entry.request.ownerUserId,
      entry.request.deviceId,
      ["browser_bridge"],
    );

    if (!input.decision.approved) {
      const reason =
        input.decision.reason || "用户拒绝了本次 Cookie 导入请求。";
      settleCookieEntry(entry, "denied", { approved: false, reason }, reason);
      await deviceStore
        .audit({
          deviceId: entry.request.deviceId,
          ownerUserId: entry.request.ownerUserId,
          actorType: "user",
          actorId: entry.request.ownerUserId,
          actorName: null,
          action: "desktop_browser_cookie_denied",
          summary: `拒绝导入 ${entry.request.origin} Cookie`,
          outcome: "denied",
          detail: reason.slice(0, 300),
          durationMs: null,
        })
        .catch(() => {});
      return { request: { ...entry.request }, cookies: [] };
    }

    // 服务端二次强校验：每条 Cookie 都必须匹配请求的单一 origin，防夹带跨域 Cookie。
    const validated = validateOriginCookies(
      entry.request.origin,
      input.decision.cookies,
    );
    if (!validated.ok) {
      throw new DesktopBrowserBridgeError(validated.error, 400);
    }

    settleCookieEntry(entry, "approved", {
      approved: true,
      ...(input.decision.profileId
        ? { profileId: input.decision.profileId }
        : {}),
      cookies: validated.cookies,
    });

    await deviceStore
      .audit({
        deviceId: entry.request.deviceId,
        ownerUserId: entry.request.ownerUserId,
        actorType: "user",
        actorId: entry.request.ownerUserId,
        actorName: null,
        action: "desktop_browser_cookie_approved",
        summary: `批准导入 ${entry.request.origin} Cookie（共 ${validated.cookies.length} 条）`,
        outcome: "succeeded",
        detail: JSON.stringify(redactCookieSummary(validated.cookies)).slice(
          0,
          800,
        ),
        durationMs: null,
      })
      .catch(() => {});

    return { request: { ...entry.request }, cookies: validated.cookies };
  }

  function cancelCookieApproval(
    ownerUserId: string,
    requestId: string,
  ): CookieApprovalRequest {
    const entry = cookieRequests.get(requestId);
    if (!entry || entry.request.ownerUserId !== ownerUserId) {
      throw new DesktopBrowserBridgeError("找不到该 Cookie 审批请求。", 404);
    }
    if (entry.request.status === "pending") {
      settleCookieEntry(
        entry,
        "cancelled",
        { approved: false, reason: "已取消 Cookie 导入请求。" },
        "已取消 Cookie 导入请求。",
      );
    }
    return { ...entry.request };
  }

  function listCookieApprovals(
    ownerUserId: string,
    filter?: { deviceId?: string; pendingOnly?: boolean },
  ): CookieApprovalRequest[] {
    const ts = now();
    const out: CookieApprovalRequest[] = [];
    for (const entry of cookieRequests.values()) {
      if (entry.request.ownerUserId !== ownerUserId) continue;
      if (filter?.deviceId && entry.request.deviceId !== filter.deviceId) {
        continue;
      }
      if (entry.request.status === "pending" && entry.expiresAtMs <= ts) {
        settleCookieEntry(
          entry,
          "expired",
          { approved: false, reason: "Cookie 审批请求已超时过期。" },
          "Cookie 审批请求已超时过期。",
        );
      }
      if (filter?.pendingOnly && entry.request.status !== "pending") continue;
      out.push({ ...entry.request });
    }
    return out;
  }

  /**
   * 发起 WebAuthn / Passkey 跨端转发挑战（强校验 rpId + 一次性 challenge 防重放）。
   */
  async function createWebAuthnRequest(input: {
    ownerUserId: string;
    deviceId: string;
    botId: string;
    kind: WebAuthnCeremonyKind;
    origin: string;
    rpId: string;
    challenge: string;
    optionsJson?: string;
    timeoutMs?: number;
  }): Promise<WebAuthnForwardRequest> {
    const flags = await readFlags();
    if (!flags.passkeyForward) {
      throw new DesktopBrowserBridgeError(
        "管理员已在 Harness 开关台关闭「通行密钥转发（passkeyForward）」。",
        409,
      );
    }
    const rpCheck = validateWebAuthnRpId(input.rpId, input.origin);
    if (!rpCheck.ok) {
      throw new DesktopBrowserBridgeError(rpCheck.reason, 400);
    }
    let challenge: string;
    try {
      challenge = normalizeWebAuthnChallenge(input.challenge);
    } catch (error) {
      throw new DesktopBrowserBridgeError(
        error instanceof Error ? error.message : "challenge 无效。",
        400,
      );
    }
    const optsCheck = validateWebAuthnOptionsJson(input.optionsJson, {
      rpId: rpCheck.rpId,
      challenge,
    });
    if (!optsCheck.ok) {
      throw new DesktopBrowserBridgeError(optsCheck.reason, 400);
    }
    const device = await assertAuthorizedDevice(
      input.ownerUserId,
      input.deviceId,
      ["browser_bridge", "passkey_forward"],
    );

    pruneReplayCache();
    const challengeKey = hashChallenge(
      input.ownerUserId,
      rpCheck.origin,
      rpCheck.rpId,
      challenge,
    );
    const existingExpiry = usedChallenges.get(challengeKey);
    if (existingExpiry !== undefined && existingExpiry > now()) {
      throw new DesktopBrowserBridgeError(
        "检测到重复使用的 WebAuthn challenge（防重放拦截），请重新生成挑战。",
        409,
      );
    }
    usedChallenges.set(challengeKey, now() + challengeReplayTtlMs);

    const requestId = `pk_${randomUUID()}`;
    const ttl = Math.min(
      300_000,
      Math.max(500, input.timeoutMs ?? webAuthnTtlMs),
    );
    const createdMs = now();
    const expiresAtMs = createdMs + ttl;
    const request: WebAuthnForwardRequest = {
      requestId,
      ownerUserId: input.ownerUserId,
      deviceId: device.id,
      botId: input.botId,
      kind: input.kind,
      origin: rpCheck.origin,
      rpId: rpCheck.rpId,
      challenge,
      ...(input.optionsJson ? { optionsJson: input.optionsJson } : {}),
      status: "pending",
      createdAt: new Date(createdMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      resolvedAt: null,
    };

    const timer = setTimeout(() => {
      const current = webAuthnRequests.get(requestId);
      if (current && current.request.status === "pending") {
        settleWebAuthnEntry(current, "expired", {
          ok: false,
          error: "WebAuthn 挑战请求已超时过期。",
        });
      }
    }, ttl);
    unrefTimer(timer);

    webAuthnRequests.set(requestId, {
      request,
      expiresAtMs,
      timer,
      waiters: new Set(),
    });

    hub?.sendRaw(device.id, {
      type: "desktop_browser_webauthn_request",
      requestId,
      kind: input.kind,
      origin: rpCheck.origin,
      rpId: rpCheck.rpId,
      challenge,
      optionsJson: input.optionsJson,
      botId: input.botId,
      expiresAt: request.expiresAt,
    });

    await deviceStore
      .audit({
        deviceId: device.id,
        ownerUserId: input.ownerUserId,
        actorType: "bot",
        actorId: input.botId,
        actorName: null,
        action: "desktop_browser_webauthn_requested",
        summary: `转发 WebAuthn ${input.kind}：${rpCheck.origin}（rpId=${rpCheck.rpId}）`,
        outcome: "succeeded",
        detail: null,
        durationMs: null,
      })
      .catch(() => {});

    return { ...request };
  }

  function waitForWebAuthn(
    ownerUserId: string,
    requestId: string,
  ): Promise<
    WebAuthnForwardResponse & { status: WebAuthnForwardRequest["status"] }
  > {
    const entry = webAuthnRequests.get(requestId);
    if (!entry || entry.request.ownerUserId !== ownerUserId) {
      return Promise.reject(
        new DesktopBrowserBridgeError("找不到该 WebAuthn 挑战请求。", 404),
      );
    }
    if (entry.request.status !== "pending" && entry.result) {
      return Promise.resolve(entry.result);
    }
    if (entry.expiresAtMs <= now()) {
      settleWebAuthnEntry(entry, "expired", {
        ok: false,
        error: "WebAuthn 挑战请求已超时过期。",
      });
      return Promise.resolve(
        entry.result ?? {
          ok: false,
          error: "WebAuthn 挑战请求已超时过期。",
          status: "expired",
        },
      );
    }
    return new Promise((resolve) => {
      entry.waiters.add(resolve);
    });
  }

  async function respondWebAuthn(input: {
    ownerUserId: string;
    deviceId?: string;
    requestId: string;
    response: WebAuthnForwardResponse;
  }): Promise<WebAuthnForwardRequest> {
    const entry = webAuthnRequests.get(input.requestId);
    if (!entry || entry.request.ownerUserId !== input.ownerUserId) {
      throw new DesktopBrowserBridgeError("找不到该 WebAuthn 挑战请求。", 404);
    }
    if (input.deviceId && entry.request.deviceId !== input.deviceId) {
      throw new DesktopBrowserBridgeError(
        "设备不匹配：不能代其他设备提交 WebAuthn 响应。",
        403,
      );
    }
    if (entry.request.status !== "pending") {
      throw new DesktopBrowserBridgeError(
        `该 WebAuthn 请求已结束（${entry.request.status}），不能重复提交。`,
        409,
      );
    }
    if (entry.expiresAtMs <= now()) {
      settleWebAuthnEntry(entry, "expired", {
        ok: false,
        error: "WebAuthn 挑战请求已超时过期。",
      });
      throw new DesktopBrowserBridgeError("该 WebAuthn 挑战已超时过期。", 410);
    }
    // 响应阶段二次复核设备未撤销、未急停、非移动平台且仍保有 Passkey 转发 scope。
    await assertAuthorizedDevice(
      entry.request.ownerUserId,
      entry.request.deviceId,
      ["browser_bridge", "passkey_forward"],
    );

    if (input.response.ok) {
      const clientDataCheck = validateWebAuthnClientDataJson(
        input.response.clientDataJSON,
        {
          kind: entry.request.kind,
          origin: entry.request.origin,
          challenge: entry.request.challenge,
        },
      );
      if (!clientDataCheck.ok) {
        throw new DesktopBrowserBridgeError(clientDataCheck.reason, 400);
      }
      settleWebAuthnEntry(entry, "completed", input.response);
    } else {
      settleWebAuthnEntry(
        entry,
        input.response.denied ? "denied" : "failed",
        input.response,
      );
    }
    await deviceStore
      .audit({
        deviceId: entry.request.deviceId,
        ownerUserId: entry.request.ownerUserId,
        actorType: "user",
        actorId: entry.request.ownerUserId,
        actorName: null,
        action: input.response.ok
          ? "desktop_browser_webauthn_completed"
          : "desktop_browser_webauthn_rejected",
        summary: `WebAuthn ${entry.request.kind} ${entry.request.rpId}：${entry.request.status}`,
        outcome: input.response.ok ? "succeeded" : "denied",
        detail: input.response.ok ? null : input.response.error.slice(0, 300),
        durationMs: null,
      })
      .catch(() => {});

    return { ...entry.request };
  }

  function cancelWebAuthn(
    ownerUserId: string,
    requestId: string,
  ): WebAuthnForwardRequest {
    const entry = webAuthnRequests.get(requestId);
    if (!entry || entry.request.ownerUserId !== ownerUserId) {
      throw new DesktopBrowserBridgeError("找不到该 WebAuthn 挑战请求。", 404);
    }
    if (entry.request.status === "pending") {
      settleWebAuthnEntry(entry, "cancelled", {
        ok: false,
        error: "已取消 WebAuthn 挑战。",
      });
    }
    return { ...entry.request };
  }

  function listWebAuthnRequests(
    ownerUserId: string,
    filter?: { deviceId?: string; pendingOnly?: boolean },
  ): WebAuthnForwardRequest[] {
    const ts = now();
    const out: WebAuthnForwardRequest[] = [];
    for (const entry of webAuthnRequests.values()) {
      if (entry.request.ownerUserId !== ownerUserId) continue;
      if (filter?.deviceId && entry.request.deviceId !== filter.deviceId) {
        continue;
      }
      if (entry.request.status === "pending" && entry.expiresAtMs <= ts) {
        settleWebAuthnEntry(entry, "expired", {
          ok: false,
          error: "WebAuthn 挑战请求已超时过期。",
        });
      }
      if (filter?.pendingOnly && entry.request.status !== "pending") continue;
      out.push({ ...entry.request });
    }
    return out;
  }

  /** 处理通过设备 WebSocket 回传的桥接响应帧（按已验签 device.ownerUserId + device.id 隔离）。 */
  async function handleDeviceMessage(
    device: DeviceRecord,
    message: { type: string } & Record<string, unknown>,
  ): Promise<boolean> {
    if (message.type === "desktop_browser_cookie_response") {
      const requestId = String(message.requestId ?? "");
      const parsed = cookieDecisionSchema.safeParse(message.decision);
      if (!requestId || !parsed.success) return true;
      await respondCookieApproval({
        ownerUserId: device.ownerUserId,
        deviceId: device.id,
        requestId,
        decision: parsed.data,
      }).catch(() => {});
      return true;
    }
    if (message.type === "desktop_browser_webauthn_response") {
      const requestId = String(message.requestId ?? "");
      const parsed = webAuthnResponseSchema.safeParse(message.result);
      if (!requestId || !parsed.success) return true;
      await respondWebAuthn({
        ownerUserId: device.ownerUserId,
        deviceId: device.id,
        requestId,
        response: parsed.data,
      }).catch(() => {});
      return true;
    }
    return false;
  }

  /** 供云端浏览器 / Bot 调用的按域名审批导入与 Passkey 转发工具。 */
  function toolsForBot(input: {
    ownerUserId: string;
    botId: string;
    defaultDeviceId?: string;
  }): GrantedTool[] {
    const cookieToolSchema = z.object({
      deviceId: z
        .string()
        .min(1)
        .optional()
        .describe("已授权 browser_bridge scope 的本机设备 ID"),
      origin: z
        .string()
        .min(1)
        .describe("单一精确目标 origin（例如 https://github.com）"),
      reason: z.string().max(400).optional().describe("向用户展示的导入原因"),
      profileHint: z.string().max(160).optional(),
    });
    const passkeyToolSchema = z.object({
      deviceId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "已授权 browser_bridge / passkey_forward scope 的本机设备 ID",
        ),
      kind: z.enum(["create", "get"]),
      origin: z.string().min(1),
      rpId: z.string().min(1),
      challenge: z.string().min(16),
      optionsJson: z.string().max(65_536).optional(),
    });

    return [
      {
        name: "desktop_browser_import_cookies",
        ref: "desktop-browser/cookie-import",
        description:
          "向用户配对的桌面设备申请按单一精确 origin 导入本机 Chrome/Edge 登录 Cookie（需用户在本机显式审批确认）。",
        parameters: cookieToolSchema,
        execute: async (raw) => {
          try {
            const args = cookieToolSchema.parse(raw);
            const deviceId = args.deviceId ?? input.defaultDeviceId ?? "";
            if (!deviceId) {
              return `${REFUSAL_MARKER} 请指定已授权 browser_bridge 能力的桌面设备 deviceId。`;
            }
            const req = await createCookieApproval({
              ownerUserId: input.ownerUserId,
              deviceId,
              botId: input.botId,
              origin: args.origin,
              reason: args.reason,
              profileHint: args.profileHint,
            });
            const outcome = await waitForCookieApproval(
              input.ownerUserId,
              req.requestId,
            );
            if (!outcome.approved) {
              return `${REFUSAL_MARKER} ${outcome.reason || "用户未批准 Cookie 导入。"}`;
            }
            return JSON.stringify({
              requestId: req.requestId,
              origin: req.origin,
              status: outcome.status,
              cookieCount: outcome.cookies.length,
              cookies: redactCookieSummary(outcome.cookies),
            });
          } catch (error) {
            return `${REFUSAL_MARKER} ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      },
      {
        name: "desktop_browser_passkey_ceremony",
        ref: "desktop-browser/passkey",
        description:
          "将 WebAuthn / Passkey 的 create 或 get 挑战转发到已授权桌面设备，经用户显式确认后完成通行密钥签名。",
        parameters: passkeyToolSchema,
        execute: async (raw) => {
          try {
            const args = passkeyToolSchema.parse(raw);
            const deviceId = args.deviceId ?? input.defaultDeviceId ?? "";
            if (!deviceId) {
              return `${REFUSAL_MARKER} 请指定已授权 Passkey 转发能力的桌面设备 deviceId。`;
            }
            const req = await createWebAuthnRequest({
              ownerUserId: input.ownerUserId,
              deviceId,
              botId: input.botId,
              kind: args.kind,
              origin: args.origin,
              rpId: args.rpId,
              challenge: args.challenge,
              optionsJson: args.optionsJson,
            });
            const outcome = await waitForWebAuthn(
              input.ownerUserId,
              req.requestId,
            );
            if (!outcome.ok) {
              return `${REFUSAL_MARKER} ${outcome.error}`;
            }
            return JSON.stringify({
              requestId: req.requestId,
              kind: req.kind,
              origin: req.origin,
              rpId: req.rpId,
              credentialId: outcome.credentialId,
              clientDataJSON: outcome.clientDataJSON,
              ...(outcome.attestationObject
                ? { attestationObject: outcome.attestationObject }
                : {}),
              ...(outcome.authenticatorData
                ? { authenticatorData: outcome.authenticatorData }
                : {}),
              ...(outcome.signature ? { signature: outcome.signature } : {}),
            });
          } catch (error) {
            return `${REFUSAL_MARKER} ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      },
    ];
  }

  /**
   * 挂载于 `/api/desktop-browser` 的受控路由（全部加 `bodyLimit` 与身份/设备隔离校验）。
   */
  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();

    app.use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    });

    app.onError((error, c) => {
      c.header("Cache-Control", "no-store");
      if (error instanceof DesktopBrowserBridgeError) {
        return c.json({ error: error.message }, error.status);
      }
      if (error instanceof z.ZodError) {
        return c.json({ error: error.issues[0]?.message ?? "参数无效。" }, 400);
      }
      return c.json({ error: "桌面浏览器桥接服务暂时不可用。" }, 503);
    });

    /** 校验设备令牌身份（供桌面客户端轮询/回传用，绝不信任自报 platform）。 */
    async function authenticateCallerDevice(
      req: Request,
    ): Promise<DeviceRecord | null> {
      const token = req.headers.get("x-device-token")?.trim();
      if (!token || !deviceStore.authenticate) return null;
      const result = await deviceStore.authenticate(token);
      if (!result || result === "revoked") {
        throw new DesktopBrowserBridgeError("设备令牌无效或已被撤销。", 401);
      }
      return result;
    }

    // 设备 scope 管理（仅设备主人可配置）
    app.get("/scopes/:deviceId", requireUser, async (c) => {
      const scopes = await getDeviceScopes(
        c.var.actor.id,
        c.req.param("deviceId"),
      );
      return c.json({ deviceId: c.req.param("deviceId"), scopes });
    });

    app.put(
      "/scopes/:deviceId",
      requireUser,
      bodyLimit({ maxSize: 16_384 }),
      async (c) => {
        const body = scopesPatchSchema.parse(await c.req.json());
        const scopes = await setDeviceScopes(
          c.var.actor.id,
          c.req.param("deviceId"),
          body.scopes,
        );
        return c.json({ deviceId: c.req.param("deviceId"), scopes });
      },
    );

    // ── Cookie Origin Approval 路由 ──

    app.get("/cookie-approvals", requireUser, (c) => {
      const deviceId = c.req.query("deviceId") || undefined;
      const pendingOnly = c.req.query("pending") === "1";
      return c.json({
        requests: listCookieApprovals(c.var.actor.id, {
          deviceId,
          pendingOnly,
        }),
      });
    });

    app.get("/cookie-approvals/pending", async (c) => {
      const device = await authenticateCallerDevice(c.req.raw);
      if (!device) {
        return c.json({ error: "需要有效的 X-Device-Token 设备凭据。" }, 401);
      }
      await assertAuthorizedDevice(device.ownerUserId, device.id, [
        "browser_bridge",
      ]);
      return c.json({
        requests: listCookieApprovals(device.ownerUserId, {
          deviceId: device.id,
          pendingOnly: true,
        }),
      });
    });

    app.post(
      "/cookie-approvals",
      requireUser,
      bodyLimit({ maxSize: 32_768 }),
      async (c) => {
        const body = cookieCreateSchema.parse(await c.req.json());
        const request = await createCookieApproval({
          ownerUserId: c.var.actor.id,
          deviceId: body.deviceId,
          botId: body.botId,
          origin: body.origin,
          reason: body.reason,
          profileHint: body.profileHint,
          timeoutMs: body.timeoutMs,
        });
        if (body.wait) {
          const outcome = await waitForCookieApproval(
            c.var.actor.id,
            request.requestId,
          );
          return c.json(
            {
              request: { ...request, status: outcome.status },
              approved: outcome.approved,
              cookieCount: outcome.approved ? outcome.cookies.length : 0,
            },
            201,
          );
        }
        return c.json({ request }, 201);
      },
    );

    app.post(
      "/cookie-approvals/:requestId/respond",
      bodyLimit({ maxSize: 512 * 1024 }),
      async (c, next) => {
        const device = await authenticateCallerDevice(c.req.raw);
        if (device) {
          const decision = cookieDecisionSchema.parse(await c.req.json());
          const outcome = await respondCookieApproval({
            ownerUserId: device.ownerUserId,
            deviceId: device.id,
            requestId: c.req.param("requestId"),
            decision,
          });
          return c.json({
            request: outcome.request,
            cookieCount: outcome.cookies.length,
          });
        }
        return requireUser(c, async () => {
          const decision = cookieDecisionSchema.parse(await c.req.json());
          const outcome = await respondCookieApproval({
            ownerUserId: c.var.actor.id,
            requestId: c.req.param("requestId"),
            decision,
          });
          c.res = c.json({
            request: outcome.request,
            cookieCount: outcome.cookies.length,
          });
          await next();
        });
      },
    );

    app.post("/cookie-approvals/:requestId/cancel", requireUser, (c) => {
      const request = cancelCookieApproval(
        c.var.actor.id,
        c.req.param("requestId"),
      );
      return c.json({ request });
    });

    // ── WebAuthn / Passkey 跨端转发路由 ──

    app.get("/webauthn/requests", requireUser, (c) => {
      const deviceId = c.req.query("deviceId") || undefined;
      const pendingOnly = c.req.query("pending") === "1";
      return c.json({
        requests: listWebAuthnRequests(c.var.actor.id, {
          deviceId,
          pendingOnly,
        }),
      });
    });

    app.get("/webauthn/pending", async (c) => {
      const device = await authenticateCallerDevice(c.req.raw);
      if (!device) {
        return c.json({ error: "需要有效的 X-Device-Token 设备凭据。" }, 401);
      }
      await assertAuthorizedDevice(device.ownerUserId, device.id, [
        "browser_bridge",
        "passkey_forward",
      ]);
      return c.json({
        requests: listWebAuthnRequests(device.ownerUserId, {
          deviceId: device.id,
          pendingOnly: true,
        }),
      });
    });

    app.post(
      "/webauthn/requests",
      requireUser,
      bodyLimit({ maxSize: 128 * 1024 }),
      async (c) => {
        const body = webAuthnCreateSchema.parse(await c.req.json());
        const request = await createWebAuthnRequest({
          ownerUserId: c.var.actor.id,
          deviceId: body.deviceId,
          botId: body.botId,
          kind: body.kind,
          origin: body.origin,
          rpId: body.rpId,
          challenge: body.challenge,
          optionsJson: body.optionsJson,
          timeoutMs: body.timeoutMs,
        });
        return c.json({ request }, 201);
      },
    );

    app.post(
      "/webauthn/:requestId/respond",
      bodyLimit({ maxSize: 256 * 1024 }),
      async (c, next) => {
        const device = await authenticateCallerDevice(c.req.raw);
        if (device) {
          const response = webAuthnResponseSchema.parse(await c.req.json());
          const request = await respondWebAuthn({
            ownerUserId: device.ownerUserId,
            deviceId: device.id,
            requestId: c.req.param("requestId"),
            response,
          });
          return c.json({ request });
        }
        return requireUser(c, async () => {
          const response = webAuthnResponseSchema.parse(await c.req.json());
          const request = await respondWebAuthn({
            ownerUserId: c.var.actor.id,
            requestId: c.req.param("requestId"),
            response,
          });
          c.res = c.json({ request });
          await next();
        });
      },
    );

    app.post("/webauthn/:requestId/cancel", requireUser, (c) => {
      const request = cancelWebAuthn(c.var.actor.id, c.req.param("requestId"));
      return c.json({ request });
    });

    return app;
  }

  function dispose() {
    for (const entry of cookieRequests.values()) {
      clearTimeout(entry.timer);
      if (entry.evictTimer) clearTimeout(entry.evictTimer);
      if (entry.result) entry.result = scrubCookieResult(entry.result);
    }
    for (const entry of webAuthnRequests.values()) {
      clearTimeout(entry.timer);
      if (entry.evictTimer) clearTimeout(entry.evictTimer);
      entry.result = undefined;
    }
    cookieRequests.clear();
    webAuthnRequests.clear();
    usedChallenges.clear();
  }

  return {
    setDeviceScopes,
    getDeviceScopes,
    createCookieApproval,
    waitForCookieApproval,
    respondCookieApproval,
    cancelCookieApproval,
    listCookieApprovals,
    createWebAuthnRequest,
    waitForWebAuthn,
    respondWebAuthn,
    cancelWebAuthn,
    listWebAuthnRequests,
    handleDeviceMessage,
    toolsForBot,
    routes,
    dispose,
  };
}

export type DesktopBrowserBridge = ReturnType<
  typeof createDesktopBrowserBridge
>;
