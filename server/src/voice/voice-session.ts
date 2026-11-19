import { randomUUID } from "node:crypto";
import {
  hasClientAec,
  parseVoiceClientEvent,
  SentenceChunker,
  sanitizeSpeechSentence,
  serializeVoiceEvent,
  VOICE_HEARTBEAT_MS,
  VOICE_MAX_BACKPRESSURE_BYTES,
  VOICE_MAX_SESSION_MS,
  VOICE_MAX_WS_PAYLOAD_BYTES,
  VOICE_SAMPLE_RATE,
  type VoiceAudioProcessing,
  type VoiceCallState,
  type VoiceServerEvent,
} from "../../../shared/voice-call";
import {
  decodeBase64Pcm16,
  encodePcm16ToWav,
  VoiceActivityDetector,
  type VoiceActivityOptions,
  VoiceAudioError,
} from "./voice-audio";
import {
  type VoicePlaybackOptions,
  VoicePlaybackTracker,
} from "./voice-playback";
import { VoiceStreamTtsError } from "./voice-stream-tts";

export type VoiceSocketLike = {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  getBufferedAmount?(): number;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  ping?(): unknown;
  terminate?(): void;
};

export type VoiceRunBotTurnInput = {
  botId: string;
  userId: string;
  channelId: string;
  turnId: string;
  text: string;
  signal: AbortSignal;
  onTextDelta: (delta: string) => void;
  onToolStatus?: (toolName: string | null) => void;
};

export type VoiceRunBotTurnResult = {
  replyText: string;
};

export type VoiceSpokenTurnRecord = {
  callId: string;
  botId: string;
  userId: string;
  channelId: string;
  turnId: string;
  userText: string;
  spokenText: string;
  draftText?: string;
  interrupted: boolean;
};

export type VoiceSessionOptions = {
  ws: VoiceSocketLike;
  callId?: string;
  userId: string;
  botId: string;
  channelId: string;
  audioProcessing: VoiceAudioProcessing;
  voice?: string;
  speed?: number;
  transcribe: (input: {
    wav: Buffer;
    signal: AbortSignal;
  }) => Promise<{ text: string }>;
  synthesizeStream: (input: {
    text: string;
    voice?: string;
    speed?: number;
    signal: AbortSignal;
  }) => AsyncIterable<Buffer>;
  runBotTurn: (input: VoiceRunBotTurnInput) => Promise<VoiceRunBotTurnResult>;
  recordSpokenTurn?: (record: VoiceSpokenTurnRecord) => Promise<void> | void;
  onClose?: () => void;
  now?: () => number;
  silenceMs?: number;
  maxUtteranceMs?: number;
  heartbeatMs?: number;
  maxSessionMs?: number;
  maxBackpressureBytes?: number;
  maxPayloadBytes?: number;
  maxFramesPerSecond?: number;
  vadOptions?: Omit<
    VoiceActivityOptions,
    "onStart" | "onEnd" | "silenceMs" | "maxMs"
  >;
  playbackOptions?: VoicePlaybackOptions;
};

type SentenceTask = {
  itemId: string;
  sentenceIndex: number;
  rawText: string;
  ttsText: string;
  played: boolean;
  prefetchPromise?: Promise<PrefetchedSentence>;
};

type PrefetchedSentence = {
  chunks: Buffer[];
  error?: unknown;
};

type TurnState = {
  turnId: string;
  userText: string;
  controller: AbortController;
  sentences: SentenceTask[];
  rawGeneratedText: string;
  readPendingText: () => string;
  botSettled: Promise<void>;
  resolveBotSettled: () => void;
  receiptFallbackTimer?: ReturnType<typeof setTimeout>;
  llmDone: boolean;
  ttsDone: boolean;
  interrupted: boolean;
  committed: boolean;
};

const WS_OPEN = 1;
const DEFAULT_MAX_FRAMES_PER_SEC = 200;
const MAX_PREFETCH_CONCURRENCY = 2;
const DEFAULT_RECEIPT_FALLBACK_MS = 2_000;

/**
 * 仅裁剪指定被打断语音回合（`voice-u-${turnId}` 之后、下一条 `role === "user"` 之前）的助手消息，
 * 绝不跨回合触碰后续轮次的正式对话历史。
 */
export function trimInterruptedVoiceTurnMessages<
  T extends { id?: string; role?: string; content?: unknown },
>(
  messages: readonly T[],
  turnId: string,
  spokenText: string,
): { updated: T[]; changed: boolean } {
  const userMessageId = `voice-u-${turnId}`;
  const userIndex = messages.findIndex((msg) => msg.id === userMessageId);
  if (userIndex < 0) {
    return { updated: [...messages], changed: false };
  }

  let nextUserIndex = messages.length;
  for (let i = userIndex + 1; i < messages.length; i += 1) {
    if (messages[i]?.role === "user") {
      nextUserIndex = i;
      break;
    }
  }

  const assistantIndices: number[] = [];
  for (let i = userIndex + 1; i < nextUserIndex; i += 1) {
    if (messages[i]?.role === "assistant") {
      assistantIndices.push(i);
    }
  }
  if (assistantIndices.length === 0) {
    return { updated: [...messages], changed: false };
  }

  const proseIndices = assistantIndices.filter((idx) => {
    const content = messages[idx]?.content;
    return typeof content === "string" && content.trim().length > 0;
  });
  const targetIndices =
    proseIndices.length > 0
      ? proseIndices
      : [assistantIndices[assistantIndices.length - 1] ?? -1].filter(
          (idx) => idx >= 0,
        );

  const replacement = spokenText || "[语音回复已中断]";
  let changed = false;
  const updated = messages.map((msg, idx) => {
    const pos = targetIndices.indexOf(idx);
    if (pos < 0) return msg;
    const nextContent = pos === 0 ? replacement : "";
    if (msg.content === nextContent) return msg;
    changed = true;
    return { ...msg, content: nextContent };
  });

  return { updated, changed };
}

function waitForPromiseOrAbort(
  promise: Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void promise.then(finish, finish);
  });
}

function isAbortError(error: unknown): boolean {
  if (error instanceof VoiceStreamTtsError && error.code === "cancelled") {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.includes("cancelled") ||
      error.message.includes("aborted"))
  ) {
    return true;
  }
  return false;
}

function joinSentenceTexts(sentences: readonly SentenceTask[]): string {
  return sentences
    .map((s) => s.rawText.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * 实时双向语音通话会话状态机：
 * 1. 分态 VAD（播报态严格起音防回声、静默态低延迟秒拾单字短词）；
 * 2. 打断瞬间立即 `abort()` 在途 LLM/工具与流式 TTS，清空播报队列，新话语零阻塞接管；
 * 3. `SentenceChunker` 增量分句 + 并行预取流式 PCM16 TTS，首句极速开口；
 * 4. 客户端 `playback.done` 排空回执驱动「仅已播报入史、未播完记为草稿」；
 * 5. 2MB 背压断流 + 30s 心跳 + 30min 上限 + 帧速率限制。
 */
export class VoiceSession {
  readonly callId: string;
  readonly userId: string;
  readonly botId: string;
  readonly channelId: string;
  readonly audioProcessing: VoiceAudioProcessing;

  private readonly ws: VoiceSocketLike;
  private readonly voice?: string;
  private readonly speed?: number;
  private readonly clientAec: boolean;
  private readonly transcribe: VoiceSessionOptions["transcribe"];
  private readonly synthesizeStream: VoiceSessionOptions["synthesizeStream"];
  private readonly runBotTurn: VoiceSessionOptions["runBotTurn"];
  private readonly recordSpokenTurn?: VoiceSessionOptions["recordSpokenTurn"];
  private readonly onClose?: () => void;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly maxSessionMs: number;
  private readonly maxBackpressureBytes: number;
  private readonly maxPayloadBytes: number;
  private readonly maxFramesPerSecond: number;
  private readonly receiptFallbackMs: number;

  private readonly vad: VoiceActivityDetector;
  private readonly playback: VoicePlaybackTracker;

  private state: VoiceCallState = "listening";
  private closed = false;
  private streamingAudio = false;
  private activeTurn: TurnState | null = null;
  private activeAsrController: AbortController | null = null;
  private lastBotSettled: Promise<void> = Promise.resolve();
  private readonly pendingReceiptTurns = new Map<string, TurnState>();
  private readonly itemToTurn = new Map<string, TurnState>();
  private readonly pendingCommits = new Set<Promise<void>>();

  private lastActivityAt: number;
  private frameWindowStartMs: number;
  private frameWindowCount = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: VoiceSessionOptions) {
    this.ws = options.ws;
    this.callId = options.callId ?? randomUUID();
    this.userId = options.userId;
    this.botId = options.botId;
    this.channelId = options.channelId;
    this.audioProcessing = options.audioProcessing;
    this.voice = options.voice;
    this.speed = options.speed;
    this.clientAec = hasClientAec(options.audioProcessing);
    this.transcribe = options.transcribe;
    this.synthesizeStream = options.synthesizeStream;
    this.runBotTurn = options.runBotTurn;
    this.recordSpokenTurn = options.recordSpokenTurn;
    this.onClose = options.onClose;
    this.now = options.now ?? Date.now;
    this.heartbeatMs = options.heartbeatMs ?? VOICE_HEARTBEAT_MS;
    this.maxSessionMs = options.maxSessionMs ?? VOICE_MAX_SESSION_MS;
    this.maxBackpressureBytes =
      options.maxBackpressureBytes ?? VOICE_MAX_BACKPRESSURE_BYTES;
    this.maxPayloadBytes =
      options.maxPayloadBytes ?? VOICE_MAX_WS_PAYLOAD_BYTES;
    this.maxFramesPerSecond =
      options.maxFramesPerSecond ?? DEFAULT_MAX_FRAMES_PER_SEC;
    this.receiptFallbackMs = Math.max(
      100,
      options.playbackOptions?.missingReceiptTimeoutMs ??
        DEFAULT_RECEIPT_FALLBACK_MS,
    );

    this.lastActivityAt = this.now();
    this.frameWindowStartMs = this.lastActivityAt;

    this.playback = new VoicePlaybackTracker({
      now: this.now,
      ...options.playbackOptions,
    });

    this.vad = new VoiceActivityDetector({
      ...options.vadOptions,
      silenceMs: options.silenceMs ?? 700,
      maxMs: options.maxUtteranceMs ?? 30_000,
      onStart: () => {
        this.handleVadSpeechStart();
      },
      onEnd: ({ pcm }) => {
        this.handleVadSpeechEnd(pcm);
      },
    });

    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.onHeartbeatTick();
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    }

    if (this.maxSessionMs > 0) {
      this.expiryTimer = setTimeout(() => {
        this.emitError(
          "session_expired",
          "本次语音通话已达 30 分钟时长上限，已自动结束。",
          false,
        );
        this.close("expired", 1000, "Voice session expired");
      }, this.maxSessionMs);
      this.expiryTimer.unref?.();
    }

    this.emit({
      type: "session.ready",
      callId: this.callId,
      sampleRate: VOICE_SAMPLE_RATE,
      audioProcessing: this.audioProcessing,
    });
    this.setState("listening");
  }

  get currentState(): VoiceCallState {
    return this.state;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 处理底层 WebSocket pong 帧，刷新存活时间。 */
  handlePong(): void {
    this.lastActivityAt = this.now();
  }

  /** 处理客户端上行 JSON 文本消息。 */
  handleRawMessage(raw: string | Buffer | Uint8Array): void {
    if (this.closed) return;

    // 前置单帧原始字节硬上限：在解码 UTF-8 与 JSON.parse 之前拦截恶意或异常超大帧。
    const rawByteLength =
      typeof raw === "string"
        ? raw.length > this.maxPayloadBytes
          ? raw.length
          : Buffer.byteLength(raw, "utf8")
        : raw.byteLength;
    if (rawByteLength > this.maxPayloadBytes) {
      this.emitError(
        "payload_too_large",
        "单条语音消息超过允许的大小上限，连接已关闭。",
        false,
      );
      this.close("payload-too-large", 1009, "Voice message too large");
      return;
    }

    this.lastActivityAt = this.now();

    if (!this.checkFrameRateLimit()) {
      this.emitError(
        "rate_limited",
        "音频发送频率过高，已暂时丢弃超额帧。",
        true,
      );
      return;
    }

    const text =
      typeof raw === "string"
        ? raw
        : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString(
            "utf8",
          );

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      this.emitError("invalid_json", "语音控制消息不是合法的 JSON。", true);
      return;
    }

    const event = parseVoiceClientEvent(parsedJson);
    if (!event) {
      this.emitError("invalid_event", "不支持或格式错误的语音事件。", true);
      return;
    }

    try {
      switch (event.type) {
        case "audio.append": {
          const pcm = decodeBase64Pcm16(event.audio);
          const playing = this.isSpeakerActive();
          if (
            this.playback.shouldGateCapture(this.clientAec) ||
            (!this.clientAec && this.streamingAudio)
          ) {
            this.vad.skip(pcm);
          } else {
            this.vad.setSpeaking(playing);
            this.vad.append(pcm);
          }
          break;
        }
        case "audio.commit": {
          this.vad.commit();
          break;
        }
        case "playback.done": {
          this.handlePlaybackDone(event.itemId);
          break;
        }
        case "barge_in": {
          this.interrupt("client");
          break;
        }
        case "ping": {
          this.emit({
            type: "pong",
            ...(event.ts !== undefined ? { ts: event.ts } : {}),
          });
          break;
        }
        case "session.close": {
          this.close("client-closed", 1000, "Call ended");
          break;
        }
      }
    } catch (error) {
      if (error instanceof VoiceAudioError) {
        this.emitError("invalid_audio", error.message, true);
        return;
      }
      this.emitError("session_error", "处理语音消息失败。", true);
    }
  }

  /** 主动关闭通话会话：中止一切在途推理/TTS、冲刷已播报历史并释放定时器。 */
  close(_reason = "closed", wsCode?: number, wsReason?: string): Promise<void> {
    if (this.closed) {
      return Promise.allSettled(this.pendingCommits).then(() => {});
    }
    this.closed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }

    this.abortInFlight("session-closed");
    this.vad.clear();
    this.playback.clear();

    if (wsCode !== undefined && this.ws.readyState === WS_OPEN) {
      try {
        this.ws.close(wsCode, wsReason);
      } catch {
        // 忽略关闭异常
      }
    }

    this.onClose?.();
    return Promise.allSettled(this.pendingCommits).then(() => {});
  }

  /** 供测试等待所有异步历史落库完成。 */
  flushPendingCommits(): Promise<void> {
    return Promise.allSettled(this.pendingCommits).then(() => {});
  }

  private isSpeakerActive(): boolean {
    return this.streamingAudio || this.playback.isPlaying();
  }

  private checkFrameRateLimit(): boolean {
    const current = this.now();
    if (current - this.frameWindowStartMs >= 1_000) {
      this.frameWindowStartMs = current;
      this.frameWindowCount = 0;
    }
    this.frameWindowCount += 1;
    return this.frameWindowCount <= this.maxFramesPerSecond;
  }

  private onHeartbeatTick(): void {
    if (this.closed) return;
    const elapsed = this.now() - this.lastActivityAt;
    if (elapsed > this.heartbeatMs * 2) {
      try {
        if (this.ws.terminate) {
          this.ws.terminate();
        } else {
          this.ws.close(1001, "Voice heartbeat timeout");
        }
      } catch {
        // 忽略终止异常
      }
      void this.close("heartbeat-timeout");
      return;
    }
    try {
      this.ws.ping?.();
    } catch {
      void this.close("ping-failed");
    }
  }

  private emit(event: VoiceServerEvent): boolean {
    if (this.closed || this.ws.readyState !== WS_OPEN) return false;
    const buffered =
      typeof this.ws.getBufferedAmount === "function"
        ? this.ws.getBufferedAmount()
        : (this.ws.bufferedAmount ?? 0);
    if (buffered > this.maxBackpressureBytes) {
      this.close("backpressure", 1013, "Audio receiver is too slow");
      return false;
    }
    try {
      this.ws.send(serializeVoiceEvent(event));
      return true;
    } catch {
      void this.close("send-failed");
      return false;
    }
  }

  private emitError(code: string, message: string, recoverable: boolean): void {
    this.emit({ type: "error", code, message, recoverable });
  }

  private setState(
    next: VoiceCallState,
    extra?: { detail?: string; toolName?: string },
  ): void {
    if (this.closed) return;
    const changed =
      this.state !== next ||
      extra?.detail !== undefined ||
      extra?.toolName !== undefined;
    this.state = next;
    if (changed) {
      this.emit({
        type: "state.change",
        state: next,
        ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
        ...(extra?.toolName !== undefined ? { toolName: extra.toolName } : {}),
      });
    }
  }

  private handleVadSpeechStart(): void {
    if (this.closed) return;
    const shouldInterrupt =
      this.activeAsrController !== null ||
      this.activeTurn !== null ||
      this.pendingReceiptTurns.size > 0 ||
      this.isSpeakerActive();
    if (shouldInterrupt) {
      this.interrupt("vad");
    }
  }

  private interrupt(reason: "vad" | "client"): void {
    if (this.closed) return;
    const interruptedTurnId = this.activeTurn?.turnId;
    this.abortInFlight(
      `barge-in:${reason}`,
      reason === "client" && this.clientAec,
    );
    this.emit({
      type: "barge_in",
      ...(interruptedTurnId ? { turnId: interruptedTurnId } : {}),
      reason,
    });
    this.setState("listening");
  }

  private abortInFlight(reason: string, immediateListen = false): void {
    const abortError = new DOMException(reason, "AbortError");
    if (this.activeAsrController) {
      this.activeAsrController.abort(abortError);
      this.activeAsrController = null;
    }

    const currentTurn = this.activeTurn;
    this.activeTurn = null;
    this.streamingAudio = false;
    if (immediateListen) {
      this.playback.clear();
    } else {
      this.playback.cancel();
    }

    if (currentTurn) {
      currentTurn.interrupted = true;
      currentTurn.controller.abort(abortError);
      this.commitTurnHistory(currentTurn);
    }

    for (const pendingTurn of [...this.pendingReceiptTurns.values()]) {
      pendingTurn.interrupted = true;
      this.commitTurnHistory(pendingTurn);
    }
  }

  private handleVadSpeechEnd(pcm: Buffer): void {
    if (this.closed || pcm.byteLength === 0) return;

    // 兜底：若客户端手动触发 audio.commit 而未经过 speechStart，先中止旧回合保证零阻塞接管。
    if (this.activeAsrController || this.activeTurn) {
      this.abortInFlight("superseded");
    }

    const turnId = randomUUID();
    const asrController = new AbortController();
    this.activeAsrController = asrController;
    this.setState("thinking", { detail: "正在识别语音…" });

    void this.executeTurn(turnId, pcm, asrController).catch((error) => {
      if (this.closed || asrController.signal.aborted || isAbortError(error)) {
        return;
      }
      const message =
        error instanceof VoiceStreamTtsError
          ? error.message
          : error instanceof Error && error.message.trim()
            ? error.message
            : "语音对话处理失败，请重试。";
      this.emitError("turn_failed", message, true);
      if (!this.activeTurn && !this.activeAsrController) {
        this.setState("listening");
      }
    });
  }

  private async executeTurn(
    turnId: string,
    pcm: Buffer,
    controller: AbortController,
  ): Promise<void> {
    const signal = controller.signal;
    const wav = encodePcm16ToWav(pcm);
    const asrResult = await this.transcribe({ wav, signal });

    if (this.activeAsrController === controller) {
      this.activeAsrController = null;
    }
    if (this.closed || signal.aborted) return;

    const userText = asrResult.text.trim();
    if (!userText) {
      if (!this.activeTurn && !this.isSpeakerActive()) {
        this.setState("listening");
      }
      return;
    }

    this.emit({ type: "transcript.final", turnId, text: userText });

    // 等待上一轮被打断的 Bot 推理彻底退出并落库释放线程锁后，再启动本轮推理，避免 409 锁冲突与脏历史。
    await waitForPromiseOrAbort(
      Promise.allSettled([this.lastBotSettled, ...this.pendingCommits]),
      signal,
    );
    if (this.closed || signal.aborted) return;

    const chunker = new SentenceChunker();
    let resolveBotSettled = () => {};
    const botSettled = new Promise<void>((resolve) => {
      resolveBotSettled = resolve;
    });
    const turn: TurnState = {
      turnId,
      userText,
      controller,
      sentences: [],
      rawGeneratedText: "",
      readPendingText: () => chunker.pending.trim(),
      botSettled,
      resolveBotSettled,
      llmDone: false,
      ttsDone: false,
      interrupted: false,
      committed: false,
    };
    this.activeTurn = turn;
    this.lastBotSettled = botSettled;
    this.pendingReceiptTurns.set(turnId, turn);
    this.setState("thinking", { detail: "思考中…" });

    const queue: SentenceTask[] = [];
    let queueEnded = false;
    let queueWake: (() => void) | null = null;
    let nextSentenceIndex = 0;
    let activePrefetches = 0;

    const notifyQueue = () => {
      if (queueWake) {
        const resolve = queueWake;
        queueWake = null;
        resolve();
      }
    };

    const startPrefetchIfSlotAvailable = (task: SentenceTask) => {
      if (
        task.prefetchPromise ||
        activePrefetches >= MAX_PREFETCH_CONCURRENCY ||
        signal.aborted ||
        this.closed
      ) {
        return;
      }
      activePrefetches += 1;
      task.prefetchPromise = (async (): Promise<PrefetchedSentence> => {
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of this.synthesizeStream({
            text: task.ttsText,
            ...(this.voice ? { voice: this.voice } : {}),
            ...(this.speed !== undefined ? { speed: this.speed } : {}),
            signal,
          })) {
            if (signal.aborted || this.closed) break;
            chunks.push(chunk);
          }
          return { chunks };
        } catch (error) {
          return { chunks, error };
        } finally {
          activePrefetches -= 1;
        }
      })();
    };

    const enqueueSentence = (rawSentence: string) => {
      if (signal.aborted || this.closed) return;
      const cleaned = sanitizeSpeechSentence(rawSentence);
      if (!cleaned) return;
      const sentenceIndex = nextSentenceIndex;
      nextSentenceIndex += 1;
      const itemId = `${turnId}:s${sentenceIndex}`;
      const task: SentenceTask = {
        itemId,
        sentenceIndex,
        rawText: rawSentence,
        ttsText: cleaned,
        played: false,
      };
      turn.sentences.push(task);
      this.itemToTurn.set(itemId, turn);
      queue.push(task);
      // 第二句开始预取，第一句直通流式下发以拿到最低首字延迟！
      if (sentenceIndex > 0) {
        startPrefetchIfSlotAvailable(task);
      }
      notifyQueue();
    };

    const streamSentenceOut = async (task: SentenceTask): Promise<void> => {
      if (signal.aborted || this.closed) return;
      // 触发后续一句并行预取，掩盖句间 TTS 建连延迟。
      const nextQueued = queue[0];
      if (nextQueued) {
        startPrefetchIfSlotAvailable(nextQueued);
      }

      this.streamingAudio = true;
      if (this.state !== "speaking") {
        this.setState("speaking");
      }

      let sentAny = false;
      if (task.prefetchPromise) {
        const prefetched = await task.prefetchPromise;
        if (signal.aborted || this.closed) return;
        if (prefetched.error) {
          throw prefetched.error;
        }
        for (const chunk of prefetched.chunks) {
          if (signal.aborted || this.closed) return;
          this.sendAudioChunk(turn, task, chunk);
          sentAny = true;
        }
      } else {
        // 首句边从上游 ReadableStream 收到音频字节边直接推给前端，首字延迟最低！
        for await (const chunk of this.synthesizeStream({
          text: task.ttsText,
          ...(this.voice ? { voice: this.voice } : {}),
          ...(this.speed !== undefined ? { speed: this.speed } : {}),
          signal,
        })) {
          if (signal.aborted || this.closed) return;
          this.sendAudioChunk(turn, task, chunk);
          sentAny = true;
        }
      }

      if (signal.aborted || this.closed) return;
      if (sentAny) {
        this.emit({
          type: "assistant.audio.done",
          turnId: turn.turnId,
          itemId: task.itemId,
          sentenceIndex: task.sentenceIndex,
          text: task.rawText,
        });
      }
    };

    const drainTtsQueue = (async () => {
      try {
        while (!signal.aborted && !this.closed) {
          const next = queue.shift();
          if (!next) {
            if (queueEnded) break;
            await new Promise<void>((resolve) => {
              queueWake = resolve;
            });
            continue;
          }
          await streamSentenceOut(next);
        }
      } finally {
        if (this.activeTurn === turn) {
          this.streamingAudio = false;
        }
      }
    })();

    let receivedDelta = false;
    let botError: unknown;
    try {
      const botResult = await this.runBotTurn({
        botId: this.botId,
        userId: this.userId,
        channelId: this.channelId,
        turnId,
        text: userText,
        signal,
        onTextDelta: (delta) => {
          if (!delta || signal.aborted || this.closed) return;
          receivedDelta = true;
          turn.rawGeneratedText += delta;
          this.emit({
            type: "assistant.text.delta",
            turnId,
            itemId: turnId,
            delta,
          });
          for (const sentence of chunker.push(delta)) {
            enqueueSentence(sentence);
          }
        },
        onToolStatus: (toolName) => {
          if (signal.aborted || this.closed) return;
          if (toolName) {
            this.setState("thinking", {
              detail: `正在调用工具：${toolName}`,
              toolName,
            });
          } else if (this.state === "thinking") {
            this.setState("thinking", { detail: "整理回复中…" });
          }
        },
      });

      if (!signal.aborted && !this.closed) {
        if (!receivedDelta && botResult.replyText.trim()) {
          turn.rawGeneratedText = botResult.replyText;
          this.emit({
            type: "assistant.text.delta",
            turnId,
            itemId: turnId,
            delta: botResult.replyText,
          });
          for (const sentence of chunker.push(botResult.replyText)) {
            enqueueSentence(sentence);
          }
        }
        const trailing = chunker.flush();
        if (trailing) {
          enqueueSentence(trailing);
        }
      }
    } catch (error) {
      botError = error;
    } finally {
      turn.llmDone = true;
      turn.resolveBotSettled();
      queueEnded = true;
      notifyQueue();
    }

    // 等待正在下发的 TTS 队列排空或随 signal 中止。
    let ttsError: unknown;
    try {
      await drainTtsQueue;
    } catch (error) {
      ttsError = error;
    }

    if (this.activeTurn === turn) {
      this.activeTurn = null;
      this.streamingAudio = false;
    }

    if (signal.aborted || this.closed) {
      return;
    }

    if (botError) {
      this.pendingReceiptTurns.delete(turnId);
      throw botError;
    }
    if (ttsError) {
      this.pendingReceiptTurns.delete(turnId);
      throw ttsError;
    }

    turn.ttsDone = true;
    this.tryFinalizeTurnReceipt(turn);
    this.scheduleReceiptFallback(turn);
  }

  private clearReceiptFallback(turn: TurnState): void {
    if (turn.receiptFallbackTimer !== undefined) {
      clearTimeout(turn.receiptFallbackTimer);
      turn.receiptFallbackTimer = undefined;
    }
  }

  /** 若客户端丢失 `playback.done` 回执，在估算播报时长 + 兜底窗后自动收口入史并切回 listening。 */
  private scheduleReceiptFallback(turn: TurnState): void {
    if (this.closed || turn.committed || !turn.ttsDone) return;
    this.clearReceiptFallback(turn);
    const pendingIds = turn.sentences
      .filter((item) => !item.played)
      .map((item) => item.itemId);
    if (pendingIds.length === 0) return;

    const delayMs =
      this.playback.estimatedRemainingMs(pendingIds) + this.receiptFallbackMs;
    const timer = setTimeout(() => {
      turn.receiptFallbackTimer = undefined;
      if (this.closed || turn.committed || turn.interrupted) return;
      for (const sentence of turn.sentences) {
        if (!sentence.played) {
          sentence.played = true;
          this.playback.finish(sentence.itemId);
        }
      }
      this.tryFinalizeTurnReceipt(turn);
    }, delayMs);
    timer.unref?.();
    turn.receiptFallbackTimer = timer;
  }

  private sendAudioChunk(
    turn: TurnState,
    task: SentenceTask,
    chunk: Buffer,
  ): void {
    this.playback.append(task.itemId, chunk.byteLength);
    if (!this.clientAec) {
      this.vad.clear();
    }
    this.emit({
      type: "assistant.audio.chunk",
      turnId: turn.turnId,
      itemId: task.itemId,
      sentenceIndex: task.sentenceIndex,
      text: task.rawText,
      audio: chunk.toString("base64"),
    });
  }

  private handlePlaybackDone(itemId: string): void {
    this.playback.finish(itemId);
    const turn = this.itemToTurn.get(itemId);
    if (!turn) return;
    const sentence = turn.sentences.find((item) => item.itemId === itemId);
    if (sentence) {
      sentence.played = true;
    }
    this.tryFinalizeTurnReceipt(turn);
  }

  private tryFinalizeTurnReceipt(turn: TurnState): void {
    if (turn.committed || !turn.ttsDone) return;
    const allPlayed = turn.sentences.every((item) => item.played);
    if (!allPlayed) return;

    this.commitTurnHistory(turn);

    if (
      !this.closed &&
      !this.activeTurn &&
      !this.activeAsrController &&
      this.pendingReceiptTurns.size === 0
    ) {
      this.setState("listening");
    }
  }

  private commitTurnHistory(turn: TurnState): void {
    if (turn.committed) return;
    turn.committed = true;
    this.clearReceiptFallback(turn);
    this.pendingReceiptTurns.delete(turn.turnId);
    for (const sentence of turn.sentences) {
      this.itemToTurn.delete(sentence.itemId);
    }

    const playedSentences = turn.sentences.filter((item) => item.played);
    const unplayedSentences = turn.sentences.filter((item) => !item.played);
    const spokenText = joinSentenceTexts(playedSentences);

    const draftParts = [
      joinSentenceTexts(unplayedSentences),
      turn.readPendingText(),
    ].filter(Boolean);
    let draftText = draftParts.join(" ").trim();
    if (turn.interrupted && !draftText && turn.rawGeneratedText.trim()) {
      // 若在切句前就已产生文本但尚未送入 TTS，同样标为未播报草稿。
      const rawTrimmed = turn.rawGeneratedText.trim();
      if (rawTrimmed !== spokenText) {
        draftText =
          spokenText && rawTrimmed.startsWith(spokenText)
            ? rawTrimmed.slice(spokenText.length).trim()
            : rawTrimmed;
      }
    }

    const record: VoiceSpokenTurnRecord = {
      callId: this.callId,
      botId: this.botId,
      userId: this.userId,
      channelId: this.channelId,
      turnId: turn.turnId,
      userText: turn.userText,
      spokenText,
      ...(draftText ? { draftText } : {}),
      interrupted: turn.interrupted,
    };

    if (!this.closed) {
      this.emit({
        type: "assistant.spoken.commit",
        turnId: turn.turnId,
        itemId: turn.turnId,
        spokenText: record.spokenText,
        ...(record.draftText ? { draftText: record.draftText } : {}),
        interrupted: record.interrupted,
      });
    }

    if (this.recordSpokenTurn) {
      // 等在途 `runBotTurn` 真正退出并释放线程锁后，再执行正式对话历史修订落库，彻底消除竞态。
      const promise = Promise.resolve()
        .then(() => turn.botSettled)
        .then(() => this.recordSpokenTurn?.(record))
        .catch(() => {
          // 历史落库失败不阻断当前语音通话会话
        })
        .finally(() => {
          this.pendingCommits.delete(promise);
        });
      this.pendingCommits.add(promise);
    }
  }
}
