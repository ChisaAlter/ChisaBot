import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import {
  parseVoiceServerEvent,
  serializeVoiceEvent,
  VOICE_MAX_GLOBAL_CALLS,
  VOICE_SAMPLE_RATE,
  VOICE_WS_PROTOCOL_PREFIX,
  type VoiceAudioProcessing,
  type VoiceClientEvent,
  type VoiceServerEvent,
  type VoiceSessionCreateRequest,
  type VoiceSessionTicketResponse,
  type VoiceStatusResponse,
} from "../../../../shared/voice-call";

const DEFAULT_VOICE_STATUS: VoiceStatusResponse = {
  ready: false,
  asrReady: false,
  ttsReady: false,
  activeCalls: 0,
  maxCalls: VOICE_MAX_GLOBAL_CALLS,
};

const CAPTURE_CHUNK_SAMPLES = 960; // 40ms @ 24kHz (2 x 20ms frames), 低开销且低延迟
const CLIENT_PING_INTERVAL_MS = 25_000;
const DEFAULT_AMPLITUDE_GAIN = 3.2;

export const voiceKeys = {
  all: ["voice"] as const,
  status: ["voice", "status"] as const,
};

/** 查询实时语音通话就绪状态（ASR + TTS 均就绪时 `ready = true`）；离线时静默降级为未就绪。 */
export function voiceStatusQueryOptions() {
  return queryOptions({
    queryKey: voiceKeys.status,
    staleTime: 60_000,
    retry: false,
    queryFn: async ({ signal }): Promise<VoiceStatusResponse> => {
      try {
        const response = await tryClient("/api/voice/status", {
          signal,
          timeoutMs: 5_000,
        });
        if (!response.ok) return DEFAULT_VOICE_STATUS;
        const payload = (await response
          .json()
          .catch(() => null)) as Partial<VoiceStatusResponse> | null;
        if (!payload || typeof payload !== "object") {
          return DEFAULT_VOICE_STATUS;
        }
        return {
          ready: Boolean(payload.ready),
          asrReady: Boolean(payload.asrReady),
          ttsReady: Boolean(payload.ttsReady),
          activeCalls:
            typeof payload.activeCalls === "number" ? payload.activeCalls : 0,
          maxCalls:
            typeof payload.maxCalls === "number"
              ? payload.maxCalls
              : VOICE_MAX_GLOBAL_CALLS,
        };
      } catch {
        return DEFAULT_VOICE_STATUS;
      }
    },
  });
}

/** 申请 60s 一次性语音通话票据（严格经由 `app/src/lib/client.ts` 发送）。 */
export async function createVoiceSessionTicket(
  input: VoiceSessionCreateRequest,
  signal?: AbortSignal,
): Promise<VoiceSessionTicketResponse> {
  const response = await client("/api/voice/sessions", {
    method: "POST",
    body: input,
    fallback: "无法发起实时语音通话，请稍后重试。",
    ...(signal ? { signal } : {}),
  });
  const payload = (await response
    .json()
    .catch(() => null)) as Partial<VoiceSessionTicketResponse> | null;
  if (
    !payload ||
    typeof payload.ticket !== "string" ||
    typeof payload.callId !== "string" ||
    typeof payload.websocketPath !== "string" ||
    typeof payload.sampleRate !== "number" ||
    typeof payload.expiresAt !== "number"
  ) {
    throw new Error("服务端返回的语音通话票据格式无效。");
  }
  return {
    ticket: payload.ticket,
    callId: payload.callId,
    websocketPath: payload.websocketPath,
    sampleRate: payload.sampleRate,
    audioProcessing: payload.audioProcessing ?? "web-aec-v1",
    expiresAt: payload.expiresAt,
  };
}

/** 线性插值重采样 Float32 单声道音频，用于把浏览器 44.1k/48k 麦克风采集合并为 24kHz。 */
export function resampleFloat32(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  if (
    !Number.isFinite(fromRate) ||
    !Number.isFinite(toRate) ||
    fromRate <= 0 ||
    toRate <= 0 ||
    fromRate === toRate
  ) {
    return new Float32Array(input);
  }
  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const pos = i * ratio;
    const leftIndex = Math.floor(pos);
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const frac = pos - leftIndex;
    const left = input[leftIndex] ?? 0;
    const right = input[rightIndex] ?? left;
    output[i] = left + (right - left) * frac;
  }
  return output;
}

/** Float32 [-1, 1] 量化为 16-bit signed PCM。 */
export function float32ToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const raw = samples[i] ?? 0;
    const clamped = Math.max(-1, Math.min(1, raw));
    out[i] =
      clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

/** 16-bit signed PCM 还原为 Float32 [-1, 1]。 */
export function pcm16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] ?? 0;
    out[i] = sample < 0 ? sample / 32768 : sample / 32767;
  }
  return out;
}

/** 将 Int16Array 编码为小端序 PCM16 base64 字符串（浏览器与 Bun 测试通用）。 */
export function encodePcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(i * 2, pcm[i] ?? 0, true);
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** 将小端序 PCM16 base64 字符串解码为 Int16Array。 */
export function decodeBase64ToPcm16(base64: string): Int16Array {
  if (!base64) return new Int16Array(0);
  const binary = atob(base64);
  const byteLength = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const sampleCount = byteLength / 2;
  const out = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

/** 提取归一化 RMS 振幅（0..1），驱动 AgentOrb 声波共振。 */
export function computeNormalizedAmplitude(
  samples: Float32Array,
  gain = DEFAULT_AMPLITUDE_GAIN,
): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  return Math.min(1, Math.max(0, rms * gain));
}

/** 从 PCM16 帧提取归一化 RMS 振幅（0..1）。 */
export function computePcm16Amplitude(
  pcm: Int16Array,
  gain = DEFAULT_AMPLITUDE_GAIN,
): number {
  if (pcm.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const s = (pcm[i] ?? 0) / 32768;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / pcm.length);
  return Math.min(1, Math.max(0, rms * gain));
}

/** 根据当前页面协议构造同源 WebSocket 地址。 */
export function buildVoiceWebSocketUrl(
  websocketPath: string,
  loc?: Pick<Location, "protocol" | "host">,
): string {
  const targetLoc =
    loc ?? (typeof window !== "undefined" ? window.location : undefined);
  if (!targetLoc) {
    throw new Error("无法确定当前页面地址以建立语音 WebSocket 连接。");
  }
  const protocol = targetLoc.protocol === "https:" ? "wss:" : "ws:";
  const normalizedPath = websocketPath.startsWith("/")
    ? websocketPath
    : `/${websocketPath}`;
  return `${protocol}//${targetLoc.host}${normalizedPath}`;
}

type VoiceAudioBridgeHint = {
  audioProcessing?: VoiceAudioProcessing;
  constraints?: MediaTrackConstraints;
};

type DesktopVoiceAudioBridge = {
  getPreferredConstraints?: () =>
    | Promise<VoiceAudioBridgeHint | null | undefined>
    | VoiceAudioBridgeHint
    | string
    | null
    | undefined;
  acquireCommunicationAudio?: (
    speakerphoneOn?: boolean,
  ) => Promise<boolean> | boolean;
  releaseCommunicationAudio?: () => Promise<void> | void;
};

function readDesktopVoiceBridge(): DesktopVoiceAudioBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { chisabotVoiceAudio?: DesktopVoiceAudioBridge })
    .chisabotVoiceAudio;
}

function parseVoiceAudioBridgeHint(raw: unknown): VoiceAudioBridgeHint | null {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? (parsed as VoiceAudioBridgeHint)
        : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? (raw as VoiceAudioBridgeHint) : null;
}

/** 检测当前客户端支持的回声消除能力；不支持 echoCancellation 时降级为 legacy 触发服务端半双工门控。 */
export function detectAudioProcessingMode(
  mediaDevices?: Pick<MediaDevices, "getSupportedConstraints"> | null,
): VoiceAudioProcessing {
  const devices =
    mediaDevices !== undefined
      ? mediaDevices
      : typeof navigator !== "undefined"
        ? navigator.mediaDevices
        : undefined;
  if (!devices) {
    return "legacy";
  }
  const supported = devices.getSupportedConstraints?.();
  return supported?.echoCancellation === true ? "web-aec-v1" : "legacy";
}

/** 采集音轨就绪后核查实际生效的回声消除状态：若设备显式关闭了 echoCancellation 则同步降级为 legacy。 */
export function resolveAudioProcessingFromTrack(
  preferred: VoiceAudioProcessing,
  stream?: {
    getAudioTracks?: () => Array<{
      getSettings?: () => { echoCancellation?: unknown };
    }>;
  } | null,
): VoiceAudioProcessing {
  if (preferred === "legacy" || !stream?.getAudioTracks) {
    return preferred;
  }
  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.();
  if (settings && settings.echoCancellation === false) {
    return "legacy";
  }
  return preferred;
}

function resolveAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  );
}

type ScheduledItemState = {
  pendingNodes: number;
  doneFromServer: boolean;
  receiptSent: boolean;
};

/**
 * 无缝 AudioBuffer 播放队列：
 * - 连续调度流式 PCM16 块消除句间爆音与卡顿；
 * - 支持毫秒级 `flush()` 在打断时立刻停止全部在播节点；
 * - 跟踪每个 `itemId` 的最后一个 AudioBufferSourceNode `onended`，真实排空后回调 `onItemDrained`。
 */
class VoiceAudioPlaybackQueue {
  private readonly context: AudioContext;
  private readonly sampleRate: number;
  private readonly onItemDrained: (itemId: string) => void;
  private readonly onAmplitude?: (level: number) => void;

  private readonly activeSources = new Set<AudioBufferSourceNode>();
  private readonly items = new Map<string, ScheduledItemState>();
  private nextStartTime = 0;

  constructor(options: {
    context: AudioContext;
    sampleRate: number;
    onItemDrained: (itemId: string) => void;
    onAmplitude?: (level: number) => void;
  }) {
    this.context = options.context;
    this.sampleRate = options.sampleRate;
    this.onItemDrained = options.onItemDrained;
    this.onAmplitude = options.onAmplitude;
  }

  enqueueChunk(itemId: string, base64Pcm: string): void {
    const pcm = decodeBase64ToPcm16(base64Pcm);
    if (pcm.length === 0) return;

    const floatSamples = pcm16ToFloat32(pcm);
    const amp = computePcm16Amplitude(pcm);
    this.onAmplitude?.(amp);

    if (this.context.state === "suspended") {
      void this.context.resume().catch(() => {});
    }

    const buffer = this.context.createBuffer(
      1,
      floatSamples.length,
      this.sampleRate,
    );
    buffer.copyToChannel(new Float32Array(floatSamples), 0);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);

    let state = this.items.get(itemId);
    if (!state) {
      state = { pendingNodes: 0, doneFromServer: false, receiptSent: false };
      this.items.set(itemId, state);
    }
    state.pendingNodes += 1;

    const now = this.context.currentTime;
    const startAt = Math.max(now + 0.012, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      const current = this.items.get(itemId);
      if (!current) return;
      current.pendingNodes = Math.max(0, current.pendingNodes - 1);
      this.checkItemDrained(itemId, current);
      if (this.activeSources.size === 0) {
        this.onAmplitude?.(0);
      }
    };

    try {
      source.start(startAt);
    } catch {
      this.activeSources.delete(source);
      state.pendingNodes = Math.max(0, state.pendingNodes - 1);
      this.checkItemDrained(itemId, state);
    }
  }

  markServerDone(itemId: string): void {
    let state = this.items.get(itemId);
    if (!state) {
      state = { pendingNodes: 0, doneFromServer: true, receiptSent: false };
      this.items.set(itemId, state);
    } else {
      state.doneFromServer = true;
    }
    this.checkItemDrained(itemId, state);
  }

  /** 打断瞬间立刻清空全部在播与排队的音频节点。 */
  flush(): void {
    for (const source of this.activeSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // 忽略已结束节点停止异常
      }
      try {
        source.disconnect();
      } catch {
        // 忽略断开异常
      }
    }
    this.activeSources.clear();
    this.items.clear();
    this.nextStartTime = 0;
    this.onAmplitude?.(0);
  }

  private checkItemDrained(itemId: string, state: ScheduledItemState): void {
    if (state.receiptSent) return;
    if (state.doneFromServer && state.pendingNodes === 0) {
      state.receiptSent = true;
      this.items.delete(itemId);
      this.onItemDrained(itemId);
    }
  }
}

export type VoiceCallClientCallbacks = {
  onServerEvent: (event: VoiceServerEvent) => void;
  onMicAmplitude: (level: number) => void;
  onPlaybackAmplitude: (level: number) => void;
  onClose: (reason: string) => void;
  onError: (message: string) => void;
};

export type VoiceCallClientConnectOptions = {
  botId: string;
  channelId?: string;
  voice?: string;
  speed?: number;
  signal?: AbortSignal;
};

/**
 * 浏览器端全双工实时语音通话客户端：
 * - WebAudio 采集（默认开启浏览器回声消除 `echoCancellation` + 降噪 + 自动增益，桌面端优先采用原生 AEC3 约束）；
 * - 实时重采样至 24kHz PCM16 并提取 RMS 振幅驱动 AgentOrb；
 * - WebSocket 双向通信（通过 `Sec-WebSocket-Protocol` 携带一次性票据）；
 * - 无缝 AudioBuffer 队列播放，收到 `barge_in` 毫秒级静音清队，播完回传 `playback.done`。
 */
export class VoiceCallClient {
  private readonly callbacks: VoiceCallClientCallbacks;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private playbackQueue: VoiceAudioPlaybackQueue | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private silenceGain: GainNode | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private pcmBuffer: number[] = [];
  private muted = false;
  private disposed = false;
  private communicationAudioAcquired = false;
  private activeVoiceBridge: DesktopVoiceAudioBridge | null = null;
  private sampleRate = VOICE_SAMPLE_RATE;
  private audioProcessing: VoiceAudioProcessing = "web-aec-v1";

  constructor(callbacks: VoiceCallClientCallbacks) {
    this.callbacks = callbacks;
  }

  get currentAudioProcessing(): VoiceAudioProcessing {
    return this.audioProcessing;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.callbacks.onMicAmplitude(0);
    }
  }

  async connect(
    options: VoiceCallClientConnectOptions,
  ): Promise<VoiceSessionTicketResponse> {
    if (this.disposed) {
      throw new Error("通话客户端已释放。");
    }

    const AudioContextCtor = resolveAudioContextCtor();
    if (!AudioContextCtor || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持实时音频采集与播放。");
    }

    let connected = false;
    try {
      // 1. 协商回声消除能力与首选麦克风约束（Electron 桌面端 / Android 原生端优先读硬件 AEC3 约束）。
      let preferredProcessing = detectAudioProcessingMode();
      let audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: { ideal: VOICE_SAMPLE_RATE },
      };

      const desktopBridge = readDesktopVoiceBridge();
      if (desktopBridge?.getPreferredConstraints) {
        try {
          const hint = parseVoiceAudioBridgeHint(
            await desktopBridge.getPreferredConstraints(),
          );
          if (hint?.audioProcessing) {
            preferredProcessing = hint.audioProcessing;
          }
          if (hint?.constraints) {
            audioConstraints = { ...audioConstraints, ...hint.constraints };
          }
        } catch {
          // 忽略原生音频桥读取异常，平滑回退到浏览器 Web AEC
        }
      }

      // 2. 通话建立前申请原生通信音频模式与焦点（仅提供该接口的端侧如 Android 调用，桌面端保持兼容）。
      if (typeof desktopBridge?.acquireCommunicationAudio === "function") {
        this.activeVoiceBridge = desktopBridge;
        this.communicationAudioAcquired = true;
        try {
          await desktopBridge.acquireCommunicationAudio(true);
        } catch {
          // 忽略原生通信音频获取异常，平滑回退到浏览器默认音频路由
        }
        if (options.signal?.aborted || this.disposed) {
          throw new DOMException("Voice call cancelled", "AbortError");
        }
      }

      // 3. 先请求麦克风权限并预热 AudioContext（必须在用户点击手势链内触发，防止自动播放拦截）。
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          throw new Error(
            "麦克风权限被拒绝，请在浏览器设置中允许访问麦克风后重试。",
          );
        }
        if (error instanceof DOMException && error.name === "NotFoundError") {
          throw new Error("未检测到可用麦克风设备。");
        }
        throw new Error("无法启动麦克风采集，请检查音频设备连接。");
      }

      if (options.signal?.aborted || this.disposed) {
        for (const track of stream.getTracks()) track.stop();
        throw new DOMException("Voice call cancelled", "AbortError");
      }

      this.stream = stream;
      const effectiveProcessing = resolveAudioProcessingFromTrack(
        preferredProcessing,
        stream,
      );
      this.audioProcessing = effectiveProcessing;

      // 4. 申请 60s 一次性通话票据。
      const ticket = await createVoiceSessionTicket(
        {
          botId: options.botId,
          ...(options.channelId ? { channelId: options.channelId } : {}),
          audioProcessing: effectiveProcessing,
          ...(options.voice ? { voice: options.voice } : {}),
          ...(options.speed !== undefined ? { speed: options.speed } : {}),
        },
        options.signal,
      );

      if (options.signal?.aborted || this.disposed) {
        throw new DOMException("Voice call cancelled", "AbortError");
      }

      this.sampleRate = ticket.sampleRate;
      this.audioProcessing = ticket.audioProcessing;

      // 5. 初始化采集与播放 AudioContext。
      const captureContext = new AudioContextCtor({
        sampleRate: this.sampleRate,
      });
      const playbackContext = new AudioContextCtor({
        sampleRate: this.sampleRate,
      });
      this.captureContext = captureContext;
      this.playbackContext = playbackContext;
      this.playbackQueue = new VoiceAudioPlaybackQueue({
        context: playbackContext,
        sampleRate: this.sampleRate,
        onItemDrained: (itemId) => {
          this.sendEvent({ type: "playback.done", itemId });
        },
        onAmplitude: (level) => {
          this.callbacks.onPlaybackAmplitude(level);
        },
      });

      // 6. 建立 WebSocket 连接（通过子协议携带一次性票据）。
      const wsUrl = buildVoiceWebSocketUrl(ticket.websocketPath);
      const protocol = `${VOICE_WS_PROTOCOL_PREFIX}${ticket.ticket}`;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(wsUrl, [protocol]);
        this.ws = ws;

        const onAbort = () => {
          if (!settled) {
            settled = true;
            reject(new DOMException("Voice call cancelled", "AbortError"));
          }
          this.cleanup();
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });

        ws.onopen = () => {
          options.signal?.removeEventListener("abort", onAbort);
          if (this.disposed) {
            ws.close(1000);
            return;
          }
          this.startMicCapture(captureContext, stream);
          this.startHeartbeat();
          if (!settled) {
            settled = true;
            resolve();
          }
        };

        ws.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(event.data);
          } catch {
            return;
          }
          const serverEvent = parseVoiceServerEvent(parsedJson);
          if (!serverEvent) return;
          this.handleServerEvent(serverEvent);
        };

        ws.onerror = () => {
          options.signal?.removeEventListener("abort", onAbort);
          if (!settled) {
            settled = true;
            this.cleanup();
            reject(new Error("无法建立语音通话实时连接，请检查网络后重试。"));
          } else if (!this.disposed) {
            this.callbacks.onError("语音连接发生网络异常。");
          }
        };

        ws.onclose = (closeEvent) => {
          options.signal?.removeEventListener("abort", onAbort);
          const wasDisposed = this.disposed;
          this.cleanup();
          if (!settled) {
            settled = true;
            reject(
              new Error(
                closeEvent.reason || "语音连接在握手阶段被服务端关闭。",
              ),
            );
            return;
          }
          if (!wasDisposed) {
            this.callbacks.onClose(
              closeEvent.reason ||
                (closeEvent.code === 1000 ? "通话已结束" : "语音连接已断开"),
            );
          }
        };
      });

      connected = true;
      return ticket;
    } finally {
      if (!connected) {
        this.cleanup();
      }
    }
  }

  /** 手动触发打断：立即清空本地扬声器缓冲并通知服务端中止在途推理与 TTS。 */
  interrupt(): void {
    this.playbackQueue?.flush();
    this.sendEvent({ type: "barge_in" });
  }

  /** 手动提交当前麦克风音频缓冲（用于安静环境下提前结束等待）。 */
  commitSpeech(): void {
    this.sendEvent({ type: "audio.commit" });
  }

  disconnect(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sendEvent({ type: "session.close" });
    this.cleanup();
  }

  private handleServerEvent(event: VoiceServerEvent): void {
    if (event.type === "assistant.audio.chunk") {
      this.playbackQueue?.enqueueChunk(event.itemId, event.audio);
    } else if (event.type === "assistant.audio.done") {
      this.playbackQueue?.markServerDone(event.itemId);
    } else if (event.type === "barge_in") {
      this.playbackQueue?.flush();
    }
    this.callbacks.onServerEvent(event);
  }

  private sendEvent(event: VoiceClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(serializeVoiceEvent(event));
    } catch {
      // 忽略关闭瞬间的发送异常
    }
  }

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      this.sendEvent({ type: "ping", ts: Date.now() });
    }, CLIENT_PING_INTERVAL_MS);
  }

  private startMicCapture(context: AudioContext, stream: MediaStream): void {
    if (context.state === "suspended") {
      void context.resume().catch(() => {});
    }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(1024, 1, 1);
    const silenceGain = context.createGain();
    silenceGain.gain.value = 0;

    this.sourceNode = source;
    this.processorNode = processor;
    this.silenceGain = silenceGain;
    this.pcmBuffer = [];

    const sourceRate = context.sampleRate || this.sampleRate;

    processor.onaudioprocess = (audioEvent) => {
      if (this.disposed || this.muted) return;
      const channelData = audioEvent.inputBuffer.getChannelData(0);
      const amplitude = computeNormalizedAmplitude(channelData);
      this.callbacks.onMicAmplitude(amplitude);

      const resampled = resampleFloat32(
        channelData,
        sourceRate,
        this.sampleRate,
      );
      const pcm16 = float32ToPcm16(resampled);
      for (let i = 0; i < pcm16.length; i += 1) {
        this.pcmBuffer.push(pcm16[i] ?? 0);
      }

      while (this.pcmBuffer.length >= CAPTURE_CHUNK_SAMPLES) {
        const frame = new Int16Array(
          this.pcmBuffer.splice(0, CAPTURE_CHUNK_SAMPLES),
        );
        this.sendEvent({
          type: "audio.append",
          audio: encodePcm16ToBase64(frame),
        });
      }
    };

    source.connect(processor);
    processor.connect(silenceGain);
    silenceGain.connect(context.destination);
  }

  private releaseCommunicationAudio(): void {
    if (!this.communicationAudioAcquired) return;
    this.communicationAudioAcquired = false;
    const bridge = this.activeVoiceBridge ?? readDesktopVoiceBridge();
    this.activeVoiceBridge = null;
    if (typeof bridge?.releaseCommunicationAudio !== "function") return;
    try {
      void Promise.resolve(bridge.releaseCommunicationAudio()).catch(() => {});
    } catch {
      // 忽略原生通信音频释放异常
    }
  }

  private cleanup(): void {
    try {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }

      this.playbackQueue?.flush();
      this.playbackQueue = null;

      if (this.processorNode) {
        this.processorNode.onaudioprocess = null;
        try {
          this.processorNode.disconnect();
        } catch {
          // 忽略清理异常
        }
        this.processorNode = null;
      }
      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch {
          // 忽略清理异常
        }
        this.sourceNode = null;
      }
      if (this.silenceGain) {
        try {
          this.silenceGain.disconnect();
        } catch {
          // 忽略清理异常
        }
        this.silenceGain = null;
      }

      if (this.stream) {
        for (const track of this.stream.getTracks()) {
          try {
            track.stop();
          } catch {
            // 忽略轨道停止异常
          }
        }
        this.stream = null;
      }

      if (this.captureContext) {
        void this.captureContext.close().catch(() => {});
        this.captureContext = null;
      }
      if (this.playbackContext) {
        void this.playbackContext.close().catch(() => {});
        this.playbackContext = null;
      }

      const socket = this.ws;
      this.ws = null;
      if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)
      ) {
        try {
          socket.close(1000);
        } catch {
          // 忽略关闭异常
        }
      }

      this.pcmBuffer = [];
      this.callbacks.onMicAmplitude(0);
      this.callbacks.onPlaybackAmplitude(0);
    } finally {
      this.releaseCommunicationAudio();
    }
  }
}
