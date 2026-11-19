import {
  VOICE_FRAME_BYTES,
  VOICE_FRAME_MS,
  VOICE_MAX_AUDIO_BASE64_LEN,
  VOICE_SAMPLE_RATE,
} from "../../../shared/voice-call";
import {
  type BargeInPolicy,
  LISTENING_ONSET_MS,
  type OnsetCandidate,
  SPEAKING_BARGE_IN_POLICY,
  VoiceOnset,
} from "./voice-onset";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export class VoiceAudioError extends Error {
  constructor(
    message: string,
    readonly status: 400 = 400,
  ) {
    super(message);
    this.name = "VoiceAudioError";
  }
}

/** 将 24kHz 单声道 16-bit LE PCM 包装为标准 44 字节 RIFF/WAVE 头，供 ASR 接口直接转写。 */
export function encodePcm16ToWav(
  pcm: Buffer,
  sampleRate = VOICE_SAMPLE_RATE,
): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(pcm.byteLength + 36, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM linear quantization
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/** 严格解码客户端上行 base64 PCM16 帧，校验长度与 2 字节采样边界。 */
export function decodeBase64Pcm16(value: string): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > VOICE_MAX_AUDIO_BASE64_LEN ||
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new VoiceAudioError("无效的 PCM 音频帧格式。");
  }
  const pcm = Buffer.from(value, "base64");
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new VoiceAudioError("PCM 音频帧未按 16-bit 采样边界对齐。");
  }
  return pcm;
}

export type PcmFrameMetrics = {
  /** 帧均方根能量（0..32768）。 */
  rms: number;
  /** 过零率（0..1），用于过滤直流偏移与高频白噪。 */
  zcr: number;
  /** 帧峰值绝对幅值（0..32768）。 */
  peak: number;
};

/** 计算单帧 PCM16LE 信号的 RMS 能量、过零率（ZCR）与峰值。 */
export function analyzePcm16Frame(frame: Buffer): PcmFrameMetrics {
  const sampleCount = Math.floor(frame.byteLength / 2);
  if (sampleCount <= 0) {
    return { rms: 0, zcr: 0, peak: 0 };
  }
  let sumSq = 0;
  let crossings = 0;
  let peak = 0;
  let prev = frame.readInt16LE(0);
  sumSq += prev * prev;
  peak = Math.abs(prev);

  for (let i = 1; i < sampleCount; i += 1) {
    const sample = frame.readInt16LE(i * 2);
    sumSq += sample * sample;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    if ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0)) {
      crossings += 1;
    }
    prev = sample;
  }

  return {
    rms: Math.sqrt(sumSq / sampleCount),
    zcr: sampleCount > 1 ? crossings / (sampleCount - 1) : 0,
    peak,
  };
}

export type VadDecisionEvent = {
  state: "confirmed" | "rejected";
  strict: boolean;
  voicedMs: number;
  spanMs: number;
  gapMs: number;
  atMs: number;
};

export type VoiceActivityOptions = {
  onStart?: (event: {
    audioStartMs: number;
    strict: boolean;
    evidence: OnsetCandidate;
  }) => void;
  onEnd?: (event: {
    pcm: Buffer;
    audioEndMs: number;
    durationMs: number;
  }) => void;
  onDecision?: (event: VadDecisionEvent) => void;
  /** 说话后持续静音多久自动提交转写（默认 700ms）。 */
  silenceMs?: number;
  /** 单段话语最长录音时长，到达后强制提交（默认 30,000ms）。 */
  maxMs?: number;
  /** 静默等待期低延迟起音阈值（默认 120ms）。 */
  listeningOnsetMs?: number;
  /** 播报期严格打断策略。 */
  bargeInPolicy?: BargeInPolicy;
  /** 动态底噪初始值（默认 90）。 */
  initialNoiseFloor?: number;
  /** 能量判定下限（默认 320）。 */
  minRms?: number;
  /** 能量判定上限（默认 2400）。 */
  maxRms?: number;
  /** 底噪倍率（默认 3.2）。 */
  snrMultiplier?: number;
  /** 过零率有效下限（默认 0.004，排除直流偏移与低频嗡声）。 */
  minZcr?: number;
  /** 过零率有效上限（默认 0.65，排除纯高频白噪）。 */
  maxZcr?: number;
};

const MIN_NOISE_FLOOR = 30;
const MAX_NOISE_FLOOR = 1_500;
const NOISE_EMA_ALPHA = 0.02;

/**
 * 24kHz PCM16 帧能量/过零率动态底噪跟踪 VAD：
 * - 底噪 EMA 平滑 + 夹持阈值，适应安静房间与轻度背景噪声；
 * - 集成 `VoiceOnset` 分态起音状态机；
 * - 环形 pre-roll 预卷缓冲，确认起音后回溯拼接首字，不吞首音节。
 */
export class VoiceActivityDetector {
  private readonly onStart: VoiceActivityOptions["onStart"];
  private readonly onEnd: VoiceActivityOptions["onEnd"];
  private readonly onDecision: VoiceActivityOptions["onDecision"];
  private readonly silenceMs: number;
  private readonly maxMs: number;
  private readonly listeningOnsetMs: number;
  private readonly bargeInPolicy: BargeInPolicy;
  private readonly minRms: number;
  private readonly maxRms: number;
  private readonly snrMultiplier: number;
  private readonly minZcr: number;
  private readonly maxZcr: number;

  private readonly onset = new VoiceOnset();
  private speaking = false;
  private noiseFloor: number;
  private offsetMs = 0;
  private remainder: Buffer = Buffer.alloc(0);
  private active = false;
  private frames: Buffer[] = [];
  private preRoll: Buffer[] = [];
  private quietMs = 0;
  private durationMs = 0;

  constructor(options: VoiceActivityOptions = {}) {
    this.onStart = options.onStart;
    this.onEnd = options.onEnd;
    this.onDecision = options.onDecision;
    this.silenceMs = Math.max(100, options.silenceMs ?? 700);
    this.maxMs = Math.max(1_000, options.maxMs ?? 30_000);
    this.listeningOnsetMs = Math.max(
      VOICE_FRAME_MS,
      options.listeningOnsetMs ?? LISTENING_ONSET_MS,
    );
    this.bargeInPolicy = options.bargeInPolicy ?? SPEAKING_BARGE_IN_POLICY;
    this.minRms = options.minRms ?? 320;
    this.maxRms = options.maxRms ?? 2_400;
    this.snrMultiplier = options.snrMultiplier ?? 3.2;
    this.minZcr = options.minZcr ?? 0.004;
    this.maxZcr = options.maxZcr ?? 0.65;
    this.noiseFloor = Math.min(
      MAX_NOISE_FLOOR,
      Math.max(MIN_NOISE_FLOOR, options.initialNoiseFloor ?? 90),
    );
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  isActive(): boolean {
    return this.active;
  }

  getNoiseFloor(): number {
    return this.noiseFloor;
  }

  getThresholdRms(): number {
    return Math.max(
      this.minRms,
      Math.min(this.maxRms, this.noiseFloor * this.snrMultiplier),
    );
  }

  reset(): void {
    this.active = false;
    this.frames = [];
    this.preRoll = [];
    this.onset.reset();
    this.quietMs = 0;
    this.durationMs = 0;
  }

  clear(): void {
    this.reset();
    this.remainder = Buffer.alloc(0);
  }

  /** 半双工播报门控期间丢弃麦克风音频，但保持时间轴单调推进。 */
  skip(pcm: Buffer): void {
    this.clear();
    this.offsetMs += (pcm.byteLength / (VOICE_SAMPLE_RATE * 2)) * 1000;
  }

  append(pcm: Buffer): void {
    if (pcm.byteLength === 0) return;
    const buffer =
      this.remainder.byteLength > 0
        ? Buffer.concat([this.remainder, pcm])
        : pcm;
    let offset = 0;
    while (offset + VOICE_FRAME_BYTES <= buffer.byteLength) {
      const slice = Buffer.from(
        buffer.subarray(offset, offset + VOICE_FRAME_BYTES),
      );
      this.processFrame(slice);
      offset += VOICE_FRAME_BYTES;
    }
    this.remainder =
      offset < buffer.byteLength
        ? Buffer.from(buffer.subarray(offset))
        : Buffer.alloc(0);
  }

  commit(): void {
    if (!this.active) return;
    const pcm = Buffer.concat(this.frames);
    const audioEndMs = this.offsetMs;
    const durationMs = this.durationMs;
    this.reset();
    this.onEnd?.({ pcm, audioEndMs, durationMs });
  }

  private isVoicedFrame(frame: Buffer): { voiced: boolean; rms: number } {
    const { rms, zcr } = analyzePcm16Frame(frame);
    const threshold = this.getThresholdRms();
    if (rms <= threshold) {
      return { voiced: false, rms };
    }
    const zcrValid =
      (zcr >= this.minZcr && zcr <= this.maxZcr) || rms > threshold * 2.5;
    return { voiced: zcrValid, rms };
  }

  private processFrame(frame: Buffer): void {
    const { voiced, rms } = this.isVoicedFrame(frame);
    this.offsetMs += VOICE_FRAME_MS;

    if (!this.active) {
      const decision = this.onset.push(voiced, {
        speaking: this.speaking,
        listeningOnsetMs: this.listeningOnsetMs,
        bargeInPolicy: this.bargeInPolicy,
      });

      this.preRoll.push(frame);
      const keepFrames = Math.max(
        18,
        Math.ceil((this.listeningOnsetMs + 240) / VOICE_FRAME_MS),
        Math.ceil(decision.retainMs / VOICE_FRAME_MS),
      );
      if (this.preRoll.length > keepFrames) {
        this.preRoll.splice(0, this.preRoll.length - keepFrames);
      }

      // 候选窗内停顿不更新环境底噪，防止说话间隙污染底噪基线。
      if (!voiced && !this.onset.isPending) {
        const nextNoise =
          this.noiseFloor * (1 - NOISE_EMA_ALPHA) + rms * NOISE_EMA_ALPHA;
        this.noiseFloor = Math.min(
          MAX_NOISE_FLOOR,
          Math.max(MIN_NOISE_FLOOR, nextNoise),
        );
      }

      if (decision.rejected) {
        this.onDecision?.({
          state: "rejected",
          strict: decision.rejected.strict,
          voicedMs: decision.rejected.voicedMs,
          spanMs: decision.rejected.spanMs,
          gapMs: decision.rejected.gapMs,
          atMs: this.offsetMs,
        });
      }

      if (!decision.confirmed || !decision.evidence) {
        return;
      }

      this.active = true;
      this.frames = this.preRoll;
      this.preRoll = [];
      this.durationMs = this.frames.length * VOICE_FRAME_MS;
      this.quietMs = 0;

      this.onDecision?.({
        state: "confirmed",
        strict: decision.evidence.strict,
        voicedMs: decision.evidence.voicedMs,
        spanMs: decision.evidence.spanMs,
        gapMs: decision.evidence.gapMs,
        atMs: this.offsetMs,
      });
      this.onStart?.({
        audioStartMs: Math.max(0, this.offsetMs - this.durationMs),
        strict: decision.evidence.strict,
        evidence: decision.evidence,
      });
      return;
    }

    this.frames.push(frame);
    this.durationMs += VOICE_FRAME_MS;
    this.quietMs = voiced ? 0 : this.quietMs + VOICE_FRAME_MS;

    if (this.quietMs >= this.silenceMs || this.durationMs >= this.maxMs) {
      this.commit();
    }
  }
}
