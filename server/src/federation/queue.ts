import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  FederationError,
  formatPeerAddress,
  type PublicFederationIdentity,
} from "./identity";

/**
 * Host↔Host 联邦消息队列、一次性邀请与严格 Per-Peer 配额/能力白名单（Wave 10 §1.2 + §4 反面教训）：
 *
 * 严格吸收 §4 反面清单：
 * 1. **Per-Peer 配额隔离**：队列与历史上限一律按 `peerId` 独立计数，绝不共享全局 10000 池
 *    （一个坏 peer 最多打满自己返回 429，绝不影响其他健康 peer）；
 * 2. **能力白名单 + 硬禁止远端代批审批**：只允许 `bot_message` / `directory_sync` / `status_ack`，
 *    对 `resolve_approval` 等任何本地审批代批动作永久 403 硬拒；
 * 3. **按 `digest` 幂等去重**：同 `(peerId, id)` 重复投递校验内容 digest，一致则幂等复用，
 *    不一致则 409 Conflict 拒绝 ID 篡改复用；
 * 4. **192-bit 一次性邀请令牌**：仅存 SHA-256 哈希，10 分钟过期，常量时间比对且绑定单次 `acceptedBy`。
 */

export const ALLOWED_PEER_CAPABILITIES = [
  "bot_message",
  "directory_sync",
  "status_ack",
] as const;

export type PeerCapability = (typeof ALLOWED_PEER_CAPABILITIES)[number];

/** 永久硬禁止远端 peer 触达的高权限控制能力，尤其是远端代批本地审批。 */
export const FORBIDDEN_PEER_CAPABILITIES: ReadonlySet<string> = new Set([
  "resolve_approval",
  "approval_resolve",
  "confirm_decision",
  "approve_confirmation",
  "device_approval_decision",
  "admin_rpc",
  "credential_read",
  "policy_override",
]);

export const DEFAULT_MAX_QUEUED_PER_PEER = 200;
export const DEFAULT_MAX_HISTORY_PER_PEER = 1000;
export const DEFAULT_INVITATION_TTL_MS = 10 * 60_000;
export const MAX_MESSAGE_TEXT_LENGTH = 8000;
export const MAX_SYNC_BATCH_SIZE = 20;

const FINISHED_STATES: ReadonlySet<FederationMessageState> = new Set([
  "completed",
  "failed",
  "interrupted",
  "revoked",
  "expired",
]);
const UUID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const BOT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type FederationMessageState =
  | "queued"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "revoked"
  | "expired";

export type SharedBotDescriptor = {
  id: string;
  name: string;
  description: string;
};

export type FederationPeerRecord = {
  id: string;
  publicKey: string;
  name: string;
  url: string;
  enabled: boolean;
  allowedBots: string[];
  remoteBots: SharedBotDescriptor[];
  capabilities: PeerCapability[];
  maxQueuedMessages: number;
  maxHistoryMessages: number;
  pairedAt: number;
  lastSyncAt: number | null;
  revokedAt: number | null;
};

export type FederationInvitationRecord = {
  id: string;
  tokenHash: string;
  allowedBots: string[];
  capabilities: PeerCapability[];
  expiresAt: number;
  acceptedBy: string | null;
  createdAt: number;
};

export type FederationMessageRecord = {
  id: string;
  direction: "inbound" | "outbound";
  peerId: string;
  fromAgentId: string;
  toAgentId: string;
  fromAddress?: string;
  text?: string;
  digest: string;
  createdAt: number;
  receivedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  state: FederationMessageState;
};

export type FederationQueueState = {
  peers: FederationPeerRecord[];
  invitations: FederationInvitationRecord[];
  messages: FederationMessageRecord[];
};

export type InboundMessageItem = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  text: string;
  createdAt: number;
};

export type DeliveryAcknowledgement = {
  id: string;
  digest: string;
  state: FederationMessageState;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeHashEqual(leftHex: string, rightHex: string): boolean {
  const a = Buffer.from(leftHex, "utf8");
  const b = Buffer.from(rightHex, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 计算联邦消息幂等摘要（与发送方/接收方/文本/创建时间绑定）。 */
export function computeFederationMessageDigest(message: {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  text: string;
  createdAt: number;
}): string {
  return sha256Hex(
    JSON.stringify([
      message.id,
      message.fromAgentId,
      message.toAgentId,
      message.text,
      message.createdAt,
    ]),
  );
}

/** 校验并规整能力白名单；若夹带 `resolve_approval` 等硬禁能力立即 403 拒阻。 */
export function validatePeerCapabilities(
  capabilities: readonly string[],
): PeerCapability[] {
  const allowedSet = new Set<string>(ALLOWED_PEER_CAPABILITIES);
  const result: PeerCapability[] = [];
  for (const raw of capabilities) {
    const cap = raw.trim();
    if (FORBIDDEN_PEER_CAPABILITIES.has(cap)) {
      throw new FederationError(
        403,
        "FORBIDDEN_CAPABILITY",
        `联邦协议硬禁止向远端 peer 授予高危能力：${cap}（远端永不可代批本地审批）。`,
      );
    }
    if (!allowedSet.has(cap)) {
      throw new FederationError(
        400,
        "UNKNOWN_CAPABILITY",
        `不在联邦能力白名单中的能力项：${cap}`,
      );
    }
    if (!result.includes(cap as PeerCapability)) {
      result.push(cap as PeerCapability);
    }
  }
  return result;
}

/** 运行时能力门禁：任何未在白名单或命中硬禁列表（特别是 `resolve_approval`）的远端调用一律 403。 */
export function assertPeerCapabilityAllowed(
  peer: Pick<FederationPeerRecord, "enabled" | "capabilities">,
  capability: string,
): void {
  const cap = capability.trim();
  if (FORBIDDEN_PEER_CAPABILITIES.has(cap)) {
    throw new FederationError(
      403,
      "REMOTE_APPROVAL_FORBIDDEN",
      `拒绝远端联邦操作「${cap}」：远端 peer 永久禁止代批本地审批或执行特权控制。`,
    );
  }
  if (!peer.enabled) {
    throw new FederationError(
      403,
      "PEER_REVOKED",
      "该联邦对等节点已被吊销或禁用。",
    );
  }
  if (!peer.capabilities.includes(cap as PeerCapability)) {
    throw new FederationError(
      403,
      "CAPABILITY_NOT_GRANTED",
      `当前联邦对等节点未被授予「${cap}」能力。`,
    );
  }
}

export function createOneTimeInvitation(
  state: FederationQueueState,
  input: {
    identity: PublicFederationIdentity;
    allowedBots: readonly string[];
    capabilities?: readonly string[];
    ttlMs?: number;
    now?: number;
  },
): {
  invitationId: string;
  token: string;
  expiresAt: number;
  allowedBots: string[];
  capabilities: PeerCapability[];
  identity: PublicFederationIdentity;
} {
  const now = input.now ?? Date.now();
  const bots = [...new Set(input.allowedBots.map((id) => id.trim()))].filter(
    (id) => BOT_ID_RE.test(id),
  );
  if (bots.length === 0 || bots.length > 100) {
    throw new FederationError(
      400,
      "INVALID_BOTS",
      "请至少选择一个有效的本地 Bot。",
    );
  }
  const capabilities = validatePeerCapabilities(
    input.capabilities ?? ["bot_message", "directory_sync", "status_ack"],
  );
  // 清理已过期邀请并限制活跃邀请数量
  state.invitations = state.invitations.filter(
    (item) => item.expiresAt > now && item.acceptedBy === null,
  );
  if (state.invitations.length >= 20) {
    throw new FederationError(
      429,
      "TOO_MANY_INVITATIONS",
      "活跃联邦邀请过多，请稍后再试。",
    );
  }
  // 192-bit 一次性令牌
  const token = `cbf_${randomBytes(24).toString("base64url")}`;
  const invitationId = randomUUID();
  const expiresAt = now + (input.ttlMs ?? DEFAULT_INVITATION_TTL_MS);

  state.invitations.push({
    id: invitationId,
    tokenHash: sha256Hex(token),
    allowedBots: bots,
    capabilities,
    expiresAt,
    acceptedBy: null,
    createdAt: now,
  });

  return {
    invitationId,
    token,
    expiresAt,
    allowedBots: bots,
    capabilities,
    identity: input.identity,
  };
}

/** 校验并消费一次性邀请令牌（同身份重试幂等，换身份或过期/无效一律拒绝）。 */
export function redeemOneTimeInvitation(
  state: FederationQueueState,
  input: {
    invitationId: string;
    token: string;
    claimerHostId: string;
    now?: number;
  },
): FederationInvitationRecord {
  const now = input.now ?? Date.now();
  const invite = state.invitations.find(
    (item) => item.id === input.invitationId,
  );
  if (
    !invite ||
    invite.expiresAt <= now ||
    !constantTimeHashEqual(invite.tokenHash, sha256Hex(input.token))
  ) {
    throw new FederationError(
      401,
      "INVALID_INVITATION",
      "联邦邀请无效、已过期或已撤销。",
    );
  }
  if (invite.acceptedBy !== null && invite.acceptedBy !== input.claimerHostId) {
    throw new FederationError(
      409,
      "INVITATION_USED",
      "一次性联邦邀请已被其他节点消费。",
    );
  }
  invite.acceptedBy = input.claimerHostId;
  return invite;
}

/** 清理某个 peer 自身的过期消息，并严格按该 peer 独立配额检查历史总数。 */
export function enforcePerPeerMessageLimits(
  state: FederationQueueState,
  peer: FederationPeerRecord,
  now: number,
): void {
  const thirtyDaysMs = 30 * 86_400_000;
  const sevenDaysMs = 7 * 86_400_000;

  state.messages = state.messages.filter(
    (msg) =>
      msg.peerId !== peer.id ||
      !FINISHED_STATES.has(msg.state) ||
      (msg.finishedAt ?? msg.createdAt) > now - thirtyDaysMs,
  );

  for (const msg of state.messages) {
    if (
      msg.peerId === peer.id &&
      !FINISHED_STATES.has(msg.state) &&
      (msg.direction === "outbound" || msg.state === "queued") &&
      now - msg.createdAt > sevenDaysMs
    ) {
      msg.state = "expired";
      msg.finishedAt = now;
      delete msg.text;
    }
  }

  let peerHistoryCount = 0;
  let peerActiveCount = 0;
  for (const msg of state.messages) {
    if (msg.peerId !== peer.id) continue;
    peerHistoryCount += 1;
    if (!FINISHED_STATES.has(msg.state)) peerActiveCount += 1;
  }

  if (peerHistoryCount >= peer.maxHistoryMessages) {
    throw new FederationError(
      429,
      "PEER_HISTORY_LIMIT",
      `联邦节点 ${peer.id.slice(0, 12)} 历史消息配额已达上限（${peer.maxHistoryMessages}）。`,
    );
  }
  if (peerActiveCount >= peer.maxQueuedMessages) {
    throw new FederationError(
      429,
      "PEER_QUEUE_FULL",
      `联邦节点 ${peer.id.slice(0, 12)} 活跃队列配额已达上限（${peer.maxQueuedMessages}）。`,
    );
  }
}

export function enqueueOutgoingMessage(
  state: FederationQueueState,
  peer: FederationPeerRecord,
  input: {
    fromAgentId: string;
    toAgentId: string;
    text: string;
    messageId?: string;
  },
  now: number = Date.now(),
): FederationMessageRecord {
  assertPeerCapabilityAllowed(peer, "bot_message");
  if (!peer.allowedBots.includes(input.fromAgentId)) {
    throw new FederationError(
      403,
      "BOT_NOT_ALLOWED",
      "该本地 Bot 未被授权联系此联邦节点。",
    );
  }
  if (!peer.remoteBots.some((bot) => bot.id === input.toAgentId)) {
    throw new FederationError(
      403,
      "REMOTE_BOT_NOT_SHARED",
      "远端节点未共享目标 Bot。",
    );
  }
  const messageId = input.messageId ?? randomUUID();
  if (
    !UUID_RE.test(messageId) ||
    typeof input.text !== "string" ||
    input.text.trim().length === 0 ||
    input.text.length > MAX_MESSAGE_TEXT_LENGTH
  ) {
    throw new FederationError(
      400,
      "INVALID_MESSAGE",
      "联邦消息 ID 或内容无效。",
    );
  }

  const existing = state.messages.find(
    (msg) =>
      msg.direction === "outbound" &&
      msg.peerId === peer.id &&
      msg.id === messageId,
  );
  if (existing) {
    const candidateDigest = computeFederationMessageDigest({
      id: messageId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      text: input.text,
      createdAt: existing.createdAt,
    });
    if (existing.digest !== candidateDigest) {
      throw new FederationError(
        409,
        "MESSAGE_ID_CONFLICT",
        "联邦消息 ID 已被不同内容复用（409 Conflict）。",
      );
    }
    return existing;
  }

  enforcePerPeerMessageLimits(state, peer, now);

  const created: FederationMessageRecord = {
    id: messageId,
    direction: "outbound",
    peerId: peer.id,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    text: input.text,
    digest: computeFederationMessageDigest({
      id: messageId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      text: input.text,
      createdAt: now,
    }),
    createdAt: now,
    state: "queued",
  };
  state.messages.push(created);
  return created;
}

/** 接收远端批量消息：按 `digest` 幂等去重、严格执行 per-peer 配额与 Bot 白名单。 */
export function receiveInboundMessages(
  state: FederationQueueState,
  peer: FederationPeerRecord,
  batch: readonly InboundMessageItem[],
  now: number = Date.now(),
): Array<Omit<FederationMessageRecord, "text">> {
  assertPeerCapabilityAllowed(peer, "bot_message");
  if (!Array.isArray(batch) || batch.length > MAX_SYNC_BATCH_SIZE) {
    throw new FederationError(
      400,
      "INVALID_BATCH",
      "联邦消息批次无效或超过上限（20 条）。",
    );
  }

  const accepted: Array<Omit<FederationMessageRecord, "text">> = [];
  for (const item of batch) {
    if (
      !item ||
      !UUID_RE.test(item.id) ||
      typeof item.text !== "string" ||
      item.text.trim().length === 0 ||
      item.text.length > MAX_MESSAGE_TEXT_LENGTH ||
      !Number.isSafeInteger(item.createdAt) ||
      item.createdAt > now + 5 * 60_000 ||
      item.createdAt < now - 7 * 86_400_000
    ) {
      throw new FederationError(
        400,
        "INVALID_MESSAGE",
        "收到的联邦消息字段无效或已过期。",
      );
    }
    if (
      !peer.allowedBots.includes(item.toAgentId) ||
      !peer.remoteBots.some((bot) => bot.id === item.fromAgentId)
    ) {
      throw new FederationError(
        403,
        "BOT_ACCESS_DENIED",
        "目标或来源 Bot 不在联邦授权白名单内。",
      );
    }

    const digest = computeFederationMessageDigest(item);
    const existing = state.messages.find(
      (msg) =>
        msg.direction === "inbound" &&
        msg.peerId === peer.id &&
        msg.id === item.id,
    );
    if (existing) {
      if (existing.digest !== digest) {
        throw new FederationError(
          409,
          "MESSAGE_DIGEST_CONFLICT",
          "同一联邦消息 ID 的内容摘要不一致，拒绝重放篡改（409 Conflict）。",
        );
      }
      const { text: _omit, ...view } = existing;
      accepted.push(view);
      continue;
    }

    enforcePerPeerMessageLimits(state, peer, now);

    const record: FederationMessageRecord = {
      id: item.id,
      direction: "inbound",
      peerId: peer.id,
      fromAgentId: item.fromAgentId,
      toAgentId: item.toAgentId,
      fromAddress: formatPeerAddress(peer.id, item.fromAgentId),
      text: item.text,
      digest,
      createdAt: item.createdAt,
      receivedAt: now,
      state: "queued",
    };
    state.messages.push(record);
    const { text: _omit, ...view } = record;
    accepted.push(view);
  }

  return accepted;
}

export function acknowledgeOutgoingMessages(
  state: FederationQueueState,
  peer: FederationPeerRecord,
  acks: readonly DeliveryAcknowledgement[],
  now: number = Date.now(),
): void {
  assertPeerCapabilityAllowed(peer, "status_ack");
  if (!Array.isArray(acks) || acks.length > 100) {
    throw new FederationError(400, "INVALID_ACKS", "联邦回执批次无效。");
  }
  for (const ack of acks) {
    const msg = state.messages.find(
      (item) =>
        item.direction === "outbound" &&
        item.peerId === peer.id &&
        item.id === ack.id,
    );
    if (!msg) continue;
    if (ack.digest !== msg.digest) {
      throw new FederationError(
        409,
        "ACK_DIGEST_MISMATCH",
        "联邦送达回执 digest 不匹配。",
      );
    }
    if (FINISHED_STATES.has(msg.state)) continue;
    if (msg.state === "running" && ack.state === "queued") continue;
    msg.state = ack.state === "queued" ? "accepted" : ack.state;
    msg.updatedAt = now;
    if (FINISHED_STATES.has(msg.state)) {
      msg.finishedAt = now;
      delete msg.text;
    }
  }
}

export function revokePeerInState(
  state: FederationQueueState,
  peerId: string,
  now: number = Date.now(),
): FederationPeerRecord {
  const peer = state.peers.find((item) => item.id === peerId);
  if (!peer) {
    throw new FederationError(
      404,
      "PEER_NOT_FOUND",
      "找不到指定的联邦对等节点。",
    );
  }
  peer.enabled = false;
  peer.revokedAt = now;
  for (const msg of state.messages) {
    if (msg.peerId === peerId && !FINISHED_STATES.has(msg.state)) {
      msg.state = "revoked";
      msg.finishedAt = now;
      delete msg.text;
    }
  }
  return peer;
}
