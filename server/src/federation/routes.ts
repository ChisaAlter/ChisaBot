import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { guardedFetchResponse } from "../../../shared/net/guarded-fetch";
import { type AppVariables, requireAdmin } from "../auth/guards";
import {
  createPrincipalRateLimiter,
  liveConnections,
  resolveRateLimitPrincipal,
} from "../security/http-hardening";
import {
  type FederationEnvelope,
  NonceReplayCache,
  signFederationEnvelope,
  verifyFederationEnvelope,
} from "./envelope";
import {
  createFederationIdentity,
  FederationError,
  type FederationIdentity,
  type PublicFederationIdentity,
  type SealedFederationIdentity,
  sealFederationIdentity,
  unsealFederationIdentity,
  validateFederationIdentity,
  validateFederationUrl,
} from "./identity";
import {
  acknowledgeOutgoingMessages,
  assertPeerCapabilityAllowed,
  createOneTimeInvitation,
  DEFAULT_MAX_HISTORY_PER_PEER,
  DEFAULT_MAX_QUEUED_PER_PEER,
  type DeliveryAcknowledgement,
  enqueueOutgoingMessage,
  type FederationPeerRecord,
  type FederationQueueState,
  type InboundMessageItem,
  type PeerCapability,
  receiveInboundMessages,
  redeemOneTimeInvitation,
  revokePeerInState,
  type SharedBotDescriptor,
  validatePeerCapabilities,
} from "./queue";

/**
 * Host↔Host 联邦服务与 HTTP 路由（Wave 10 §1.2）：
 *
 * - 节点 Ed25519 身份初始化（私钥以 AES-256-GCM 封存）；
 * - 一次性邀请令牌配对、Ed25519 签名信封校验（±5min + nonce 防重放）；
 * - Per-peer 配额上限与能力白名单；
 * - 硬禁止远端 peer 代批本地审批（`resolve_approval` 等永拒 403）；
 * - 吊销 peer 时立刻调用 `liveConnections.revokePrincipal(\`peer:${peerId}\`)` 掐断其活流。
 */

const pairBodySchema = z.strictObject({
  invitationId: z.string().uuid(),
  token: z.string().min(16).max(128),
  identity: z.strictObject({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    publicKey: z.string().min(32).max(1024),
    name: z.string().trim().min(1).max(100),
    url: z.string().max(500).optional(),
  }),
  bots: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        name: z.string().trim().min(1).max(120),
        description: z.string().max(1000).default(""),
      }),
    )
    .max(100),
});

const syncBodySchema = z.strictObject({
  messages: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        fromAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        toAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        text: z.string().min(1).max(8000),
        createdAt: z.number().int(),
      }),
    )
    .max(20)
    .default([]),
  acks: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        state: z.enum([
          "queued",
          "accepted",
          "running",
          "completed",
          "failed",
          "interrupted",
          "revoked",
          "expired",
        ]),
      }),
    )
    .max(100)
    .default([]),
  bots: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        name: z.string().trim().min(1).max(120),
        description: z.string().max(1000).default(""),
      }),
    )
    .max(100)
    .optional(),
});

const controlBodySchema = z.strictObject({
  action: z.string().trim().min(1).max(128),
  args: z.record(z.string(), z.unknown()).optional(),
});

export type FederationServiceOptions = {
  encryptionKey: string;
  hostName?: string;
  hostUrl?: string;
  identity?: FederationIdentity;
  maxQueuedPerPeer?: number;
  maxHistoryPerPeer?: number;
  now?: () => number;
  listLocalBots?: () => Promise<SharedBotDescriptor[]> | SharedBotDescriptor[];
  allowPrivateHttp?: boolean;
};

export function createFederationService(options: FederationServiceOptions) {
  const nowFn = options.now ?? Date.now;
  const maxQueuedPerPeer =
    options.maxQueuedPerPeer ?? DEFAULT_MAX_QUEUED_PER_PEER;
  const maxHistoryPerPeer =
    options.maxHistoryPerPeer ?? DEFAULT_MAX_HISTORY_PER_PEER;
  const identity: FederationIdentity =
    options.identity ?? createFederationIdentity();
  const hostName = options.hostName?.trim() || "ChisaBot Host";
  const hostUrl = options.hostUrl
    ? validateFederationUrl(options.hostUrl, {
        allowPrivateHttp: options.allowPrivateHttp,
        optional: true,
      })
    : "";

  const state: FederationQueueState = {
    peers: [],
    invitations: [],
    messages: [],
  };
  const replayCache = new NonceReplayCache();

  function publicIdentity(): PublicFederationIdentity {
    return {
      id: identity.id,
      publicKey: identity.publicKey,
      name: hostName,
      ...(hostUrl ? { url: hostUrl } : {}),
    };
  }

  async function exportSealedIdentity(): Promise<SealedFederationIdentity> {
    return sealFederationIdentity(identity, options.encryptionKey);
  }

  async function importSealedIdentity(
    sealed: SealedFederationIdentity,
  ): Promise<FederationIdentity> {
    return unsealFederationIdentity(sealed, options.encryptionKey);
  }

  function findPeer(peerId: string): FederationPeerRecord | undefined {
    return state.peers.find((item) => item.id === peerId);
  }

  function createInvitation(input: {
    allowedBots: readonly string[];
    capabilities?: readonly string[];
    ttlMs?: number;
  }) {
    return createOneTimeInvitation(state, {
      identity: publicIdentity(),
      allowedBots: input.allowedBots,
      capabilities: input.capabilities,
      ttlMs: input.ttlMs,
      now: nowFn(),
    });
  }

  type VerifiedSenderHook = {
    assertPeerRateLimit?: (verifiedSender: string) => void;
  };

  async function receivePair(
    envelope: unknown,
    hook?: VerifiedSenderHook,
  ): Promise<
    FederationEnvelope<{
      identity: PublicFederationIdentity;
      bots: SharedBotDescriptor[];
      capabilities: PeerCapability[];
    }>
  > {
    const raw = envelope as { payload?: { body?: { identity?: unknown } } };
    const claimed = validateFederationIdentity(raw?.payload?.body?.identity);
    if (claimed.id === identity.id) {
      throw new FederationError(
        400,
        "SELF_PAIR",
        "节点不能与自身建立联邦配对。",
      );
    }

    const verified = verifyFederationEnvelope(envelope, "pair", {
      expectedPublicKey: claimed.publicKey,
      now: nowFn(),
      replayCache,
    });
    hook?.assertPeerRateLimit?.(verified.sender);
    const parsed = pairBodySchema.safeParse(verified.body);
    if (!parsed.success) {
      throw new FederationError(400, "INVALID_PAIR_BODY", "配对载荷格式无效。");
    }
    const body = parsed.data;
    if (body.identity.id !== verified.sender) {
      throw new FederationError(
        401,
        "IDENTITY_MISMATCH",
        "配对载荷身份与信封签名者不一致。",
      );
    }

    const invite = redeemOneTimeInvitation(state, {
      invitationId: body.invitationId,
      token: body.token,
      claimerHostId: verified.sender,
      now: nowFn(),
    });

    const peerUrl = body.identity.url
      ? validateFederationUrl(body.identity.url, {
          allowPrivateHttp: options.allowPrivateHttp,
          optional: true,
        })
      : "";

    const existing = findPeer(verified.sender);
    const peerRecord: FederationPeerRecord = {
      id: verified.sender,
      publicKey: verified.senderKey,
      name: body.identity.name,
      url: peerUrl,
      enabled: true,
      allowedBots: [...invite.allowedBots],
      remoteBots: body.bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        description: bot.description,
      })),
      capabilities: [...invite.capabilities],
      maxQueuedMessages: maxQueuedPerPeer,
      maxHistoryMessages: maxHistoryPerPeer,
      pairedAt: nowFn(),
      lastSyncAt: null,
      revokedAt: null,
    };

    if (existing) {
      Object.assign(existing, peerRecord);
    } else {
      if (state.peers.length >= 50) {
        throw new FederationError(
          409,
          "PEER_LIMIT_REACHED",
          "已配对联邦节点数达到上限（50）。",
        );
      }
      state.peers.push(peerRecord);
    }

    const allLocalBots = (await options.listLocalBots?.()) ?? [];
    const exportedBots = allLocalBots.filter((bot) =>
      invite.allowedBots.includes(bot.id),
    );

    return signFederationEnvelope(
      identity,
      "pair-result",
      {
        identity: publicIdentity(),
        bots: exportedBots,
        capabilities: [...invite.capabilities],
      },
      { now: nowFn(), nonce: verified.nonce },
    );
  }

  function registerPeerForSync(input: {
    id: string;
    publicKey: string;
    name: string;
    url?: string;
    allowedBots: readonly string[];
    remoteBots: readonly SharedBotDescriptor[];
    capabilities?: readonly string[];
    maxQueuedMessages?: number;
    maxHistoryMessages?: number;
  }): FederationPeerRecord {
    const validated = validateFederationIdentity(input);
    const capabilities = validatePeerCapabilities(
      input.capabilities ?? ["bot_message", "directory_sync", "status_ack"],
    );
    const record: FederationPeerRecord = {
      id: validated.id,
      publicKey: validated.publicKey,
      name: input.name.trim() || "Peer Host",
      url: input.url
        ? validateFederationUrl(input.url, {
            allowPrivateHttp: options.allowPrivateHttp,
            optional: true,
          })
        : "",
      enabled: true,
      allowedBots: [...input.allowedBots],
      remoteBots: input.remoteBots.map((bot) => ({ ...bot })),
      capabilities,
      maxQueuedMessages: input.maxQueuedMessages ?? maxQueuedPerPeer,
      maxHistoryMessages: input.maxHistoryMessages ?? maxHistoryPerPeer,
      pairedAt: nowFn(),
      lastSyncAt: null,
      revokedAt: null,
    };
    const existing = findPeer(record.id);
    if (existing) Object.assign(existing, record);
    else state.peers.push(record);
    return record;
  }

  function receiveSync(envelope: unknown, hook?: VerifiedSenderHook) {
    const senderId = (envelope as { payload?: { sender?: unknown } })?.payload
      ?.sender;
    if (typeof senderId !== "string") {
      throw new FederationError(
        401,
        "INVALID_ENVELOPE",
        "签名信封缺少 sender。",
      );
    }
    const peer = findPeer(senderId);
    if (!peer) {
      throw new FederationError(403, "PEER_NOT_PAIRED", "未配对的联邦节点。");
    }
    const verified = verifyFederationEnvelope(envelope, "sync", {
      expectedPublicKey: peer.publicKey,
      now: nowFn(),
      replayCache,
    });
    hook?.assertPeerRateLimit?.(verified.sender);
    if (!peer.enabled) {
      return signFederationEnvelope(
        identity,
        "sync-result",
        { revoked: true as const },
        { now: nowFn(), nonce: verified.nonce },
      );
    }

    const parsed = syncBodySchema.safeParse(verified.body);
    if (!parsed.success) {
      throw new FederationError(400, "INVALID_SYNC_BODY", "联邦同步载荷无效。");
    }
    const body = parsed.data;
    if (body.bots) {
      assertPeerCapabilityAllowed(peer, "directory_sync");
      peer.remoteBots = body.bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        description: bot.description,
      }));
    }
    const accepted =
      body.messages.length > 0
        ? receiveInboundMessages(
            state,
            peer,
            body.messages as InboundMessageItem[],
            nowFn(),
          )
        : [];
    if (body.acks.length > 0) {
      acknowledgeOutgoingMessages(
        state,
        peer,
        body.acks as DeliveryAcknowledgement[],
        nowFn(),
      );
    }
    peer.lastSyncAt = nowFn();

    const outbound = state.messages
      .filter(
        (msg) =>
          msg.direction === "outbound" &&
          msg.peerId === peer.id &&
          msg.state === "queued",
      )
      .slice(0, 20)
      .map(({ id, fromAgentId, toAgentId, text, createdAt }) => ({
        id,
        fromAgentId,
        toAgentId,
        text: text ?? "",
        createdAt,
      }));

    return signFederationEnvelope(
      identity,
      "sync-result",
      {
        revoked: false as const,
        accepted,
        messages: outbound,
      },
      { now: nowFn(), nonce: verified.nonce },
    );
  }

  /**
   * 远端控制通道：
   * 严格执行能力白名单，硬禁止远端 peer 代批本地审批（`resolve_approval` 等永拒 403）。
   */
  function receiveControl(envelope: unknown, hook?: VerifiedSenderHook): never {
    const senderId = (envelope as { payload?: { sender?: unknown } })?.payload
      ?.sender;
    if (typeof senderId !== "string") {
      throw new FederationError(
        401,
        "INVALID_ENVELOPE",
        "签名信封缺少 sender。",
      );
    }
    const peer = findPeer(senderId);
    if (!peer) {
      throw new FederationError(403, "PEER_NOT_PAIRED", "未配对的联邦节点。");
    }
    const verified = verifyFederationEnvelope(envelope, "control", {
      expectedPublicKey: peer.publicKey,
      now: nowFn(),
      replayCache,
    });
    hook?.assertPeerRateLimit?.(verified.sender);
    const parsed = controlBodySchema.safeParse(verified.body);
    if (!parsed.success) {
      throw new FederationError(
        400,
        "INVALID_CONTROL_BODY",
        "控制请求载荷格式无效。",
      );
    }
    assertPeerCapabilityAllowed(peer, parsed.data.action);
    throw new FederationError(
      403,
      "CONTROL_ACTION_DENIED",
      `当前联邦协议版本不允许通过控制通道执行「${parsed.data.action}」。`,
    );
  }

  function revokePeer(peerId: string): FederationPeerRecord {
    const peer = revokePeerInState(state, peerId, nowFn());
    liveConnections.revokePrincipal(
      `peer:${peer.id}`,
      "federation_peer_revoked",
    );
    liveConnections.revokePrincipal(peer.id, "federation_peer_revoked");
    return peer;
  }

  function receiveRevoke(envelope: unknown, hook?: VerifiedSenderHook) {
    const senderId = (envelope as { payload?: { sender?: unknown } })?.payload
      ?.sender;
    if (typeof senderId !== "string") {
      throw new FederationError(
        401,
        "INVALID_ENVELOPE",
        "签名信封缺少 sender。",
      );
    }
    const peer = findPeer(senderId);
    if (!peer) {
      throw new FederationError(403, "PEER_NOT_PAIRED", "未配对的联邦节点。");
    }
    const verified = verifyFederationEnvelope(envelope, "revoke", {
      expectedPublicKey: peer.publicKey,
      now: nowFn(),
      replayCache,
    });
    hook?.assertPeerRateLimit?.(verified.sender);
    revokePeer(peer.id);
    return signFederationEnvelope(
      identity,
      "revoke-result",
      { revoked: true },
      { now: nowFn(), nonce: verified.nonce },
    );
  }

  async function sendEnvelopeToPeer(
    peerUrl: string,
    path: string,
    envelope: FederationEnvelope<unknown>,
  ): Promise<unknown> {
    const origin = validateFederationUrl(peerUrl, {
      allowPrivateHttp: options.allowPrivateHttp,
    });
    const response = await guardedFetchResponse(
      new URL(path, origin).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        redirectMode: "error",
        maxBytes: 512 * 1024,
        timeoutMs: 15_000,
        ...(options.allowPrivateHttp ? { allowPrivate: true } : {}),
      },
    );
    if (!response.ok) {
      throw new FederationError(
        response.status,
        "REMOTE_HOST_ERROR",
        `远端联邦节点返回 HTTP ${response.status}。`,
      );
    }
    return response.json();
  }

  function enqueueMessage(
    peerId: string,
    input: {
      fromAgentId: string;
      toAgentId: string;
      text: string;
      messageId?: string;
    },
  ) {
    const peer = findPeer(peerId);
    if (!peer) {
      throw new FederationError(
        404,
        "PEER_NOT_FOUND",
        "找不到指定的联邦对等节点。",
      );
    }
    return enqueueOutgoingMessage(state, peer, input, nowFn());
  }

  return {
    identity: publicIdentity,
    signingIdentity: () => identity,
    exportSealedIdentity,
    importSealedIdentity,
    listPeers: () =>
      state.peers.map(({ publicKey: _pk, ...rest }) => ({ ...rest })),
    listMessages: (peerId?: string) =>
      state.messages
        .filter((msg) => !peerId || msg.peerId === peerId)
        .map(({ text: _t, ...view }) => ({ ...view })),
    createInvitation,
    receivePair,
    registerPeerForSync,
    receiveSync,
    receiveControl,
    receiveRevoke,
    revokePeer,
    enqueueMessage,
    sendEnvelopeToPeer,
  };
}

export type FederationService = ReturnType<typeof createFederationService>;

/**
 * 联邦 HTTP 路由（挂载于 `/api/federation`）：
 * - 管理接口（`/identity`、`/invitations`、`/peers`、`/peers/:id/revoke`）：`requireUser` + `requireAdmin`；
 * - 联邦协议接口（`/v1/pair`、`/v1/sync`、`/v1/control`、`/v1/revoke`）：Ed25519 签名信封认证 + per-peer 限流 + `bodyLimit`。
 */
export function createFederationRoutes(options: {
  service: FederationService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  peerRateLimitPerMinute?: number;
  preAuthRateLimitPerMinute?: number;
  trustForwardedHeaders?: boolean;
  trustedProxies?: ReadonlySet<string>;
}) {
  const { service, requireUser } = options;
  const routes = new Hono<{ Variables: AppVariables }>();
  const peerLimit = options.peerRateLimitPerMinute ?? 120;
  const ingressLimiter = createPrincipalRateLimiter({
    limit: options.preAuthRateLimitPerMinute ?? Math.max(240, peerLimit * 3),
    windowMs: 60_000,
  });
  const peerLimiter = createPrincipalRateLimiter({
    limit: peerLimit,
    windowMs: 60_000,
  });

  routes.use(
    "*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (context) => {
        context.header("Cache-Control", "no-store");
        return context.json({ error: "联邦请求体过大。" }, 413);
      },
    }),
  );

  routes.onError((error, context) => {
    context.header("Cache-Control", "no-store");
    if (error instanceof FederationError) {
      return context.json(
        { error: error.message, code: error.code },
        error.status as 400 | 401 | 403 | 404 | 409 | 429 | 500,
      );
    }
    return context.json({ error: "联邦请求处理失败。" }, 500);
  });

  const adminGuard: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    context.header("Cache-Control", "no-store");
    await next();
  };

  routes.get("/identity", requireUser, adminGuard, (context) =>
    context.json({ identity: service.identity() }),
  );

  routes.get("/peers", requireUser, adminGuard, (context) =>
    context.json({ peers: service.listPeers() }),
  );

  routes.post("/invitations", requireUser, adminGuard, async (context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = z
      .strictObject({
        allowedBots: z.array(z.string().min(1).max(128)).min(1).max(100),
        capabilities: z.array(z.string().min(1).max(64)).max(16).optional(),
        ttlMs: z.number().int().min(60_000).max(3_600_000).optional(),
      })
      .safeParse(body);
    if (!parsed.success) {
      return context.json({ error: "邀请参数无效。" }, 400);
    }
    const invitation = service.createInvitation(parsed.data);
    return context.json({ invitation }, 201);
  });

  routes.post("/peers/:peerId/revoke", requireUser, adminGuard, (context) => {
    const peer = service.revokePeer(context.req.param("peerId"));
    return context.json({ revoked: true, peerId: peer.id });
  });

  // /v1/* 协议端点统一禁止缓存，且验签前仅按请求来源做前置防洪限流，绝不污染合法节点桶。
  routes.use("/v1/*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const ingressKey = resolveRateLimitPrincipal(context, {
      trustForwardedHeaders: options.trustForwardedHeaders,
      trustedProxies: options.trustedProxies,
    });
    if (!ingressLimiter.check(ingressKey).allowed) {
      return context.json(
        { error: "联邦入口请求过于频繁。", code: "INGRESS_RATE_LIMITED" },
        429,
      );
    }
    await next();
  });

  // 仅在 Ed25519 验签通过后才按已认证 sender 扣减 per-peer 配额，彻底防 Rate-Limit Bucket Poisoning DoS。
  const assertPeerRateLimit = (verifiedSender: string): void => {
    if (!peerLimiter.check(`peer:${verifiedSender}`).allowed) {
      throw new FederationError(
        429,
        "PEER_RATE_LIMITED",
        "联邦节点请求过于频繁。",
      );
    }
  };

  routes.post("/v1/pair", async (context) => {
    const envelope = await context.req.json().catch(() => null);
    return context.json(
      await service.receivePair(envelope, { assertPeerRateLimit }),
    );
  });

  routes.post("/v1/sync", async (context) => {
    const envelope = await context.req.json().catch(() => null);
    return context.json(service.receiveSync(envelope, { assertPeerRateLimit }));
  });

  routes.post("/v1/control", async (context) => {
    const envelope = await context.req.json().catch(() => null);
    return context.json(
      service.receiveControl(envelope, { assertPeerRateLimit }),
    );
  });

  routes.post("/v1/revoke", async (context) => {
    const envelope = await context.req.json().catch(() => null);
    return context.json(
      service.receiveRevoke(envelope, { assertPeerRateLimit }),
    );
  });

  return routes;
}
