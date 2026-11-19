import { VOICE_FRAME_MS } from "../../../shared/voice-call";

export type BargeInPolicy = {
  /** 播报期触发打断所需的最小累计人声时长（ms）。 */
  readonly voicedMs: number;
  /** 播报期触发打断所需的最小候选窗跨度（ms）。 */
  readonly spanMs: number;
  /** 候选窗内允许的句内短停顿上限（ms），达到即拒绝本次候选。 */
  readonly gapMs: number;
  /** 播报期候选窗最大持续时长（ms），超时仍未满足即拒绝。 */
  readonly windowMs: number;
  /** 打断确认后保留的预卷时长（ms），确保不吞掉用户开口首字。 */
  readonly preRollMs: number;
};

/**
 * 扬声器播报期严格起音门槛：防回声瞬态误打断，同时允许句内短停顿并保留预卷。
 */
export const SPEAKING_BARGE_IN_POLICY: Readonly<BargeInPolicy> = Object.freeze({
  voicedMs: 420,
  spanMs: 500,
  gapMs: 500,
  windowMs: 2_000,
  preRollMs: 1_000,
});

/** 静默等待期低延迟起音门槛（ms），保证「好/嗯/停」等单字短词秒识别。 */
export const LISTENING_ONSET_MS = 120;

/** 静默等待期预卷时长（ms），完整保留起音爆破音与首字辅音。 */
export const LISTENING_PREROLL_MS = 240;

export type OnsetCandidate = {
  /** true 表示该候选在扬声器播报期启动，中途不可放松为静默低延迟阈值。 */
  strict: boolean;
  voicedMs: number;
  spanMs: number;
  gapMs: number;
};

export type OnsetPushOptions = {
  /** 当前扬声器是否正在播报（含尾音保护期）。 */
  speaking: boolean;
  /** 静默等待期的最小人声确认时长（ms，默认 120）。 */
  listeningOnsetMs?: number;
  /** 播报期严格打断策略覆写。 */
  bargeInPolicy?: BargeInPolicy;
};

export type OnsetPushResult = {
  confirmed: boolean;
  retainMs: number;
  evidence?: OnsetCandidate;
  rejected?: OnsetCandidate;
};

/**
 * 分态 VAD 起音状态机：
 * - `speaking = true`（播报态）：启用严格起音确认（voicedMs >= 420 && spanMs >= 500），允许句内短停顿；
 * - `speaking = false`（静默态）：切回低延迟即时拾音（voicedMs >= 120），绝不吞「好/嗯/停」短词；
 * - 播报结束后，已启动的播报期候选窗不会中途放松，防止尾音回声借机触发误打断。
 */
export class VoiceOnset {
  private pendingCandidate: OnsetCandidate | null = null;

  get pending(): Readonly<OnsetCandidate> | null {
    return this.pendingCandidate;
  }

  get isPending(): boolean {
    return this.pendingCandidate !== null;
  }

  reset(): void {
    this.pendingCandidate = null;
  }

  push(voiced: boolean, options: OnsetPushOptions): OnsetPushResult {
    const policy = options.bargeInPolicy ?? SPEAKING_BARGE_IN_POLICY;
    const listeningOnsetMs = Math.max(
      VOICE_FRAME_MS,
      options.listeningOnsetMs ?? LISTENING_ONSET_MS,
    );

    if (!this.pendingCandidate) {
      if (!voiced) {
        return { confirmed: false, retainMs: 0 };
      }
      this.pendingCandidate = {
        strict: options.speaking,
        voicedMs: 0,
        spanMs: 0,
        gapMs: 0,
      };
    }

    const candidate = this.pendingCandidate;
    // 关键约束：播报期已启动的候选窗在播报结束后绝不放松；若静默候选期间开始播报则自动升级严格门槛。
    candidate.strict = candidate.strict || options.speaking;
    candidate.spanMs += VOICE_FRAME_MS;
    candidate.voicedMs += voiced ? VOICE_FRAME_MS : 0;
    candidate.gapMs = voiced ? 0 : candidate.gapMs + VOICE_FRAME_MS;

    const rejected = candidate.strict
      ? candidate.gapMs >= policy.gapMs || candidate.spanMs > policy.windowMs
      : !voiced;

    if (rejected) {
      const snapshot: OnsetCandidate = { ...candidate };
      this.reset();
      if (voiced) {
        this.pendingCandidate = {
          strict: options.speaking,
          voicedMs: VOICE_FRAME_MS,
          spanMs: VOICE_FRAME_MS,
          gapMs: 0,
        };
      }
      return {
        confirmed: false,
        retainMs: this.pendingCandidate?.spanMs ?? 0,
        rejected: snapshot,
      };
    }

    const confirmed =
      voiced &&
      (candidate.strict
        ? candidate.voicedMs >= policy.voicedMs &&
          candidate.spanMs >= policy.spanMs
        : candidate.voicedMs >= listeningOnsetMs);

    const retainMs = candidate.strict
      ? candidate.spanMs + policy.preRollMs
      : candidate.spanMs + LISTENING_PREROLL_MS;

    return {
      confirmed,
      retainMs,
      ...(confirmed ? { evidence: { ...candidate } } : {}),
    };
  }
}
