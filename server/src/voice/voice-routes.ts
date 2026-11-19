import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  VOICE_AUDIO_PROCESSING_MODES,
  VOICE_MAX_GLOBAL_CALLS,
  VOICE_MAX_USER_CALLS,
  VOICE_SAMPLE_RATE,
  VOICE_TICKET_TTL_MS,
  VOICE_WS_PATH,
  VOICE_WS_PROTOCOL_PREFIX,
  type VoiceAudioProcessing,
  type VoiceSessionTicketResponse,
  type VoiceStatusResponse,
} from "../../../shared/voice-call";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import {
  type VoiceRunBotTurnInput,
  type VoiceRunBotTurnResult,
  VoiceSession,
  type VoiceSessionOptions,
  type VoiceSocketLike,
  type VoiceSpokenTurnRecord,
} from "./voice-session";

const SESSION_BODY_LIMIT_BYTES = 16 * 1024;
const MAX_PENDING_TICKETS = 64;
const TICKET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const createSessionSchema = z
  .object({
    botId: z
      .string({ error: "请选择有效的机器人。" })
      .trim()
      .min(1, "机器人 ID 不能为空。")
      .max(128, "机器人 ID 过长。"),
    channelId: z
      .string({ error: "频道 ID 必须是字符串。" })
      .trim()
      .min(1, "频道 ID 不能为空。")
      .max(128, "频道 ID 过长。")
      .optional(),
    audioProcessing: z
      .enum(VOICE_AUDIO_PROCESSING_MODES, {
        error: "不支持的音频处理能力模式。",
      })
      .optional(),
    voice: z.string().trim().min(1).max(128).optional(),
    speed: z.number().finite().min(0.25).max(4).optional(),
  })
  .strict();

type VoiceTicketRecord = {
  callId: string;
  userId: string;
  botId: string;
  channelId: string;
  expectedOrigin: string;
  audioProcessing: VoiceAudioProcessing;
  voice?: string;
  speed?: number;
  expiresAt: number;
};

export type VoiceSocketData = {
  kind: "voice-call";
  callId: string;
  userId: string;
  botId: string;
  channelId: string;
  audioProcessing: VoiceAudioProcessing;
  voice?: string;
  speed?: number;
  session?: VoiceSession;
};

export type VoiceUpgradeResult =
  | { ok: true; data: VoiceSocketData; protocol: string }
  | { ok: false; status: 400 | 401 | 403 | 409 | 503; message: string };

export type VoiceServiceDeps = {
  checkReady: () => Promise<{ asrReady: boolean; ttsReady: boolean }>;
  resolveTargetChannel: (
    actor: AuthenticatedActor,
    botId: string,
    channelId?: string,
  ) => Promise<{ channelId: string } | null>;
  transcribe: VoiceSessionOptions["transcribe"];
  synthesizeStream: VoiceSessionOptions["synthesizeStream"];
  runBotTurn: (input: VoiceRunBotTurnInput) => Promise<VoiceRunBotTurnResult>;
  recordSpokenTurn?: (record: VoiceSpokenTurnRecord) => Promise<void> | void;
  /** 允许的额外可信 Origin 列表（例如配置的 AUTH trustedOrigins）。 */
  trustedOrigins?: readonly string[];
  now?: () => number;
  ticketTtlMs?: number;
  maxGlobalCalls?: number;
  maxUserCalls?: number;
  sessionDefaults?: Partial<
    Pick<
      VoiceSessionOptions,
      | "silenceMs"
      | "maxUtteranceMs"
      | "heartbeatMs"
      | "maxSessionMs"
      | "maxBackpressureBytes"
      | "vadOptions"
      | "playbackOptions"
    >
  >;
};

export type VoiceCallService = {
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }>;
  prepareUpgrade(request: Request): Promise<VoiceUpgradeResult>;
  handleOpen(ws: VoiceSocketLike, data: VoiceSocketData): void;
  handleMessage(
    ws: VoiceSocketLike,
    data: VoiceSocketData,
    raw: string | Buffer | Uint8Array,
  ): void;
  handlePong(data: VoiceSocketData): void;
  handleClose(data: VoiceSocketData, code?: number, reason?: string): void;
  releaseFailedUpgrade(data: VoiceSocketData): void;
  activeCallCount(): number;
  closeAll(): Promise<void>;
};

export function isVoiceSocketData(data: unknown): data is VoiceSocketData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "voice-call"
  );
}

function hashTicket(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintRandomTicket(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeHttpOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function extractTicketProtocol(headerValue: string | null): {
  protocol: string;
  token: string;
} | null {
  if (!headerValue) return null;
  const entries = headerValue
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const matched = entries.filter((entry) =>
    entry.startsWith(VOICE_WS_PROTOCOL_PREFIX),
  );
  if (matched.length !== 1) return null;
  const protocol = matched[0];
  if (!protocol) return null;
  const token = protocol.slice(VOICE_WS_PROTOCOL_PREFIX.length);
  if (!TICKET_TOKEN_PATTERN.test(token)) return null;
  return { protocol, token };
}

/**
 * 实时语音通话 HTTP 路由与 WebSocket 升级分发器：
 * - `GET /api/voice/status`：查询 ASR + TTS 双向就绪状态与当前并发数；
 * - `POST /api/voice/sessions`：严格鉴权签发 60s 一次性随机票据；
 * - `WS /api/voice/ws`：通过 `Sec-WebSocket-Protocol` 消费一次性票据、严格核验 Origin（绝不凭客户端自报 `platform` 放行任意 Origin）、强约束单用户≤1与全局≤4并发。
 */
export function createVoiceCallService(
  deps: VoiceServiceDeps,
): VoiceCallService {
  const now = deps.now ?? Date.now;
  const ticketTtlMs = Math.max(5_000, deps.ticketTtlMs ?? VOICE_TICKET_TTL_MS);
  const maxGlobalCalls = Math.max(
    1,
    deps.maxGlobalCalls ?? VOICE_MAX_GLOBAL_CALLS,
  );
  const maxUserCalls = Math.max(1, deps.maxUserCalls ?? VOICE_MAX_USER_CALLS);
  const trustedOriginSet = new Set(
    (deps.trustedOrigins ?? [])
      .map((origin) => normalizeHttpOrigin(origin))
      .filter((origin): origin is string => origin !== null),
  );

  const tickets = new Map<string, VoiceTicketRecord>();
  const activeSessionsByUser = new Map<string, Set<VoiceSession>>();
  const allActiveSessions = new Set<VoiceSession>();
  /** 正在完成 upgrade 握手的占位计数，防止并发升级绕过并发上限。 */
  const upgradingUsers = new Map<string, number>();
  let totalUpgrading = 0;

  function sweepExpiredTickets(): void {
    const current = now();
    for (const [key, record] of tickets) {
      if (record.expiresAt <= current) {
        tickets.delete(key);
      }
    }
  }

  function userCallCount(userId: string): number {
    return (
      (activeSessionsByUser.get(userId)?.size ?? 0) +
      (upgradingUsers.get(userId) ?? 0)
    );
  }

  function totalCallCount(): number {
    return allActiveSessions.size + totalUpgrading;
  }

  function reserveUpgradeSlot(userId: string): boolean {
    if (
      totalCallCount() >= maxGlobalCalls ||
      userCallCount(userId) >= maxUserCalls
    ) {
      return false;
    }
    upgradingUsers.set(userId, (upgradingUsers.get(userId) ?? 0) + 1);
    totalUpgrading += 1;
    return true;
  }

  function releaseUpgradeSlot(userId: string): void {
    const count = (upgradingUsers.get(userId) ?? 0) - 1;
    if (count <= 0) {
      upgradingUsers.delete(userId);
    } else {
      upgradingUsers.set(userId, count);
    }
    totalUpgrading = Math.max(0, totalUpgrading - 1);
  }

  function registerSession(userId: string, session: VoiceSession): void {
    allActiveSessions.add(session);
    let set = activeSessionsByUser.get(userId);
    if (!set) {
      set = new Set();
      activeSessionsByUser.set(userId, set);
    }
    set.add(session);
  }

  function unregisterSession(userId: string, session: VoiceSession): void {
    allActiveSessions.delete(session);
    const set = activeSessionsByUser.get(userId);
    if (set) {
      set.delete(session);
      if (set.size === 0) {
        activeSessionsByUser.delete(userId);
      }
    }
  }

  function resolveIssueOrigin(request: Request): string | null {
    const requestOrigin = normalizeHttpOrigin(new URL(request.url).origin);
    const headerOriginRaw = request.headers.get("origin");
    if (headerOriginRaw !== null) {
      const parsedHeaderOrigin = normalizeHttpOrigin(headerOriginRaw);
      if (!parsedHeaderOrigin) {
        return null;
      }
      if (
        parsedHeaderOrigin === requestOrigin ||
        trustedOriginSet.has(parsedHeaderOrigin)
      ) {
        return parsedHeaderOrigin;
      }
      return null;
    }
    return requestOrigin;
  }

  function routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }> {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);

    app.get("/status", async (context) => {
      context.header("Cache-Control", "no-store");
      const readiness = await deps
        .checkReady()
        .catch(() => ({ asrReady: false, ttsReady: false }));
      const payload: VoiceStatusResponse = {
        ready: readiness.asrReady && readiness.ttsReady,
        asrReady: readiness.asrReady,
        ttsReady: readiness.ttsReady,
        activeCalls: totalCallCount(),
        maxCalls: maxGlobalCalls,
      };
      return context.json(payload);
    });

    app.post(
      "/sessions",
      bodyLimit({
        maxSize: SESSION_BODY_LIMIT_BYTES,
        onError: (context) => {
          context.header("Cache-Control", "no-store");
          return context.json({ error: "请求体过大。" }, 413);
        },
      }),
      async (context) => {
        context.header("Cache-Control", "no-store");
        const actor = context.var.actor;

        const expectedOrigin = resolveIssueOrigin(context.req.raw);
        if (!expectedOrigin) {
          return context.json({ error: "不受信任的请求来源。" }, 403);
        }

        const rawBody: unknown = await context.req.json().catch(() => null);
        if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
          return context.json({ error: "请提供合法的 JSON 请求体。" }, 400);
        }
        const parsed = createSessionSchema.safeParse(rawBody);
        if (!parsed.success) {
          return context.json(
            {
              error:
                parsed.error.issues[0]?.message ?? "语音通话请求参数无效。",
            },
            400,
          );
        }

        const readiness = await deps
          .checkReady()
          .catch(() => ({ asrReady: false, ttsReady: false }));
        if (!readiness.asrReady || !readiness.ttsReady) {
          const missing =
            !readiness.asrReady && !readiness.ttsReady
              ? "语音识别（ASR）和语音合成（TTS）"
              : !readiness.asrReady
                ? "语音识别（ASR）"
                : "语音合成（TTS）";
          return context.json(
            { error: `实时语音通话需要管理员先配置${missing}服务。` },
            503,
          );
        }

        if (userCallCount(actor.id) >= maxUserCalls) {
          return context.json(
            { error: "你已有一路进行中的语音通话，请先结束当前通话。" },
            409,
          );
        }
        if (totalCallCount() >= maxGlobalCalls) {
          return context.json(
            { error: "当前语音通话线路已满，请稍后再试。" },
            409,
          );
        }

        const target = await deps
          .resolveTargetChannel(actor, parsed.data.botId, parsed.data.channelId)
          .catch(() => null);
        if (!target) {
          return context.json({ error: "找不到该机器人或对话频道。" }, 404);
        }

        sweepExpiredTickets();
        // 同一用户只保留最新一张待消费票据，防止重复发起导致票据积压。
        for (const [hashKey, record] of tickets) {
          if (record.userId === actor.id) {
            tickets.delete(hashKey);
          }
        }
        if (tickets.size >= MAX_PENDING_TICKETS) {
          return context.json(
            { error: "待连接语音会话过多，请稍后重试。" },
            429,
          );
        }

        const ticket = mintRandomTicket();
        const callId = randomUUID();
        const expiresAt = now() + ticketTtlMs;
        const audioProcessing: VoiceAudioProcessing =
          parsed.data.audioProcessing ?? "web-aec-v1";

        tickets.set(hashTicket(ticket), {
          callId,
          userId: actor.id,
          botId: parsed.data.botId,
          channelId: target.channelId,
          expectedOrigin,
          audioProcessing,
          ...(parsed.data.voice ? { voice: parsed.data.voice } : {}),
          ...(parsed.data.speed !== undefined
            ? { speed: parsed.data.speed }
            : {}),
          expiresAt,
        });

        const response: VoiceSessionTicketResponse = {
          ticket,
          callId,
          websocketPath: VOICE_WS_PATH,
          sampleRate: VOICE_SAMPLE_RATE,
          audioProcessing,
          expiresAt,
        };
        return context.json(response, 201);
      },
    );

    return app;
  }

  async function prepareUpgrade(request: Request): Promise<VoiceUpgradeResult> {
    const extracted = extractTicketProtocol(
      request.headers.get("sec-websocket-protocol"),
    );
    if (!extracted) {
      return { ok: false, status: 401, message: "缺少有效的语音通话票据。" };
    }

    sweepExpiredTickets();
    const key = hashTicket(extracted.token);
    const ticket = tickets.get(key);
    if (!ticket || ticket.expiresAt <= now()) {
      tickets.delete(key);
      return { ok: false, status: 401, message: "语音通话票据无效或已过期。" };
    }

    // 严格校验 Origin：只允许与签发票据时完全一致的 Origin；绝不凭任何客户端自报 platform 放行 null / file:// / 跨源。
    const rawOrigin = request.headers.get("origin");
    if (rawOrigin !== null) {
      const normalized = normalizeHttpOrigin(rawOrigin);
      if (!normalized || normalized !== ticket.expectedOrigin) {
        return {
          ok: false,
          status: 403,
          message: "语音连接来源与票据签发来源不匹配。",
        };
      }
    }

    // 必须在任何 await（如 checkReady）之前同步原子消费一次性票据，彻底消除并发升级 TOCTOU 重放窗口。
    tickets.delete(key);

    const readiness = await deps
      .checkReady()
      .catch(() => ({ asrReady: false, ttsReady: false }));
    if (!readiness.asrReady || !readiness.ttsReady) {
      return { ok: false, status: 503, message: "语音服务尚未就绪。" };
    }

    if (!reserveUpgradeSlot(ticket.userId)) {
      return {
        ok: false,
        status: 409,
        message: "语音通话并发数已达上限或已有进行中的通话。",
      };
    }

    return {
      ok: true,
      protocol: extracted.protocol,
      data: {
        kind: "voice-call",
        callId: ticket.callId,
        userId: ticket.userId,
        botId: ticket.botId,
        channelId: ticket.channelId,
        audioProcessing: ticket.audioProcessing,
        ...(ticket.voice ? { voice: ticket.voice } : {}),
        ...(ticket.speed !== undefined ? { speed: ticket.speed } : {}),
      },
    };
  }

  function handleOpen(ws: VoiceSocketLike, data: VoiceSocketData): void {
    const session = new VoiceSession({
      ws,
      callId: data.callId,
      userId: data.userId,
      botId: data.botId,
      channelId: data.channelId,
      audioProcessing: data.audioProcessing,
      ...(data.voice ? { voice: data.voice } : {}),
      ...(data.speed !== undefined ? { speed: data.speed } : {}),
      transcribe: deps.transcribe,
      synthesizeStream: deps.synthesizeStream,
      runBotTurn: deps.runBotTurn,
      ...(deps.recordSpokenTurn
        ? { recordSpokenTurn: deps.recordSpokenTurn }
        : {}),
      now,
      ...deps.sessionDefaults,
      onClose: () => {
        unregisterSession(data.userId, session);
      },
    });
    data.session = session;
    registerSession(data.userId, session);
    releaseUpgradeSlot(data.userId);
  }

  function handleMessage(
    _ws: VoiceSocketLike,
    data: VoiceSocketData,
    raw: string | Buffer | Uint8Array,
  ): void {
    data.session?.handleRawMessage(raw);
  }

  function handlePong(data: VoiceSocketData): void {
    data.session?.handlePong();
  }

  function handleClose(
    data: VoiceSocketData,
    _code?: number,
    _reason?: string,
  ): void {
    if (data.session) {
      void data.session.close("ws-closed");
    } else {
      // 握手成功但 open 未触发就关闭时释放占位槽位。
      releaseUpgradeSlot(data.userId);
    }
  }

  function releaseFailedUpgrade(data: VoiceSocketData): void {
    if (!data.session) {
      releaseUpgradeSlot(data.userId);
    }
  }

  function activeCallCount(): number {
    return totalCallCount();
  }

  async function closeAll(): Promise<void> {
    tickets.clear();
    const closing = [...allActiveSessions].map((session) =>
      session.close("server-shutdown", 1001, "Server shutting down"),
    );
    await Promise.allSettled(closing);
  }

  return {
    routes,
    prepareUpgrade,
    handleOpen,
    handleMessage,
    handlePong,
    handleClose,
    releaseFailedUpgrade,
    activeCallCount,
    closeAll,
  };
}
