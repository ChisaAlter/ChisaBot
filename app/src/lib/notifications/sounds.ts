import type { NotificationSoundId } from "../../../../shared/notifications";

/** 800ms 防并发叠音去抖窗口，防止多条回复连续到达时音频重叠刺耳。 */
export const NOTIFICATION_SOUND_DEBOUNCE_MS = 800;

type AudioParamLike = {
  setValueAtTime: (value: number, startTime: number) => void;
  linearRampToValueAtTime: (value: number, endTime: number) => void;
  exponentialRampToValueAtTime: (value: number, endTime: number) => void;
};

type GainNodeLike = {
  gain: AudioParamLike;
  connect: (destination: unknown) => void;
  disconnect?: () => void;
};

type OscillatorNodeLike = {
  type: OscillatorType;
  frequency: AudioParamLike;
  connect: (destination: unknown) => void;
  start: (when?: number) => void;
  stop: (when?: number) => void;
  disconnect?: () => void;
  onended: (() => void) | null;
};

export type AudioContextLike = {
  readonly currentTime: number;
  readonly state?: AudioContextState;
  readonly destination: unknown;
  resume?: () => Promise<void>;
  createOscillator: () => OscillatorNodeLike;
  createGain: () => GainNodeLike;
};

type ToneStep = {
  offsetSec: number;
  durationSec: number;
  startHz: number;
  endHz: number;
  gain: number;
  waveform: OscillatorType;
};

/** 5 种克制柔和的合成提示音配方（低增益 + 平滑起止包络，零外部音频文件依赖）。 */
const SOUND_RECIPES: Record<
  Exclude<NotificationSoundId, "none">,
  readonly ToneStep[]
> = {
  "soft-blip": [
    {
      offsetSec: 0,
      durationSec: 0.13,
      startHz: 587.33,
      endHz: 739.99,
      gain: 0.14,
      waveform: "sine",
    },
  ],
  chime: [
    {
      offsetSec: 0,
      durationSec: 0.22,
      startHz: 523.25,
      endHz: 523.25,
      gain: 0.12,
      waveform: "sine",
    },
    {
      offsetSec: 0.075,
      durationSec: 0.28,
      startHz: 783.99,
      endHz: 783.99,
      gain: 0.11,
      waveform: "triangle",
    },
  ],
  bell: [
    {
      offsetSec: 0,
      durationSec: 0.34,
      startHz: 880,
      endHz: 880,
      gain: 0.13,
      waveform: "sine",
    },
    {
      offsetSec: 0,
      durationSec: 0.22,
      startHz: 1760,
      endHz: 1760,
      gain: 0.045,
      waveform: "sine",
    },
  ],
  drop: [
    {
      offsetSec: 0,
      durationSec: 0.11,
      startHz: 440,
      endHz: 659.25,
      gain: 0.15,
      waveform: "sine",
    },
  ],
  pulse: [
    {
      offsetSec: 0,
      durationSec: 0.085,
      startHz: 520,
      endHz: 540,
      gain: 0.13,
      waveform: "triangle",
    },
    {
      offsetSec: 0.105,
      durationSec: 0.11,
      startHz: 640,
      endHz: 680,
      gain: 0.13,
      waveform: "triangle",
    },
  ],
};

function defaultCreateAudioContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null;
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (typeof ctor !== "function") return null;
  try {
    return new ctor() as unknown as AudioContextLike;
  } catch {
    return null;
  }
}

export type SoundPlayerOptions = {
  now?: () => number;
  debounceMs?: number;
  createContext?: () => AudioContextLike | null;
};

export type PlaySoundOptions = {
  /** 用户主动点击试听时跳过 800ms 并发防抖，但仍会先终止上一声防止叠音。 */
  force?: boolean;
};

export function createSoundPlayer(options: SoundPlayerOptions = {}) {
  const clock = options.now ?? (() => Date.now());
  const debounceMs = options.debounceMs ?? NOTIFICATION_SOUND_DEBOUNCE_MS;
  const createContext = options.createContext ?? defaultCreateAudioContext;

  let context: AudioContextLike | null = null;
  let lastPlayedAt = Number.NEGATIVE_INFINITY;
  const activeOscillators = new Set<OscillatorNodeLike>();

  function stopActive(): void {
    for (const osc of activeOscillators) {
      try {
        osc.stop();
      } catch {
        // 已停止的振荡器无需再处理
      }
      try {
        osc.disconnect?.();
      } catch {
        // 忽略断开异常
      }
    }
    activeOscillators.clear();
  }

  function ensureContext(): AudioContextLike | null {
    if (!context) {
      context = createContext();
    }
    if (context && context.state === "suspended") {
      void context.resume?.().catch(() => {});
    }
    return context;
  }

  function play(
    soundId: NotificationSoundId,
    playOptions: PlaySoundOptions = {},
  ): boolean {
    if (soundId === "none") return false;
    const recipe = SOUND_RECIPES[soundId];
    if (!recipe) return false;

    const nowMs = clock();
    if (!playOptions.force && nowMs - lastPlayedAt < debounceMs) {
      return false;
    }

    const audio = ensureContext();
    if (!audio) return false;

    // 停掉任何仍在衰减中的旧振荡器，确保跨端绝不叠音。
    stopActive();
    lastPlayedAt = nowMs;

    const baseTime = audio.currentTime;
    for (const step of recipe) {
      try {
        const startAt = baseTime + step.offsetSec;
        const endAt = startAt + step.durationSec;
        const osc = audio.createOscillator();
        const gainNode = audio.createGain();
        osc.type = step.waveform;
        osc.frequency.setValueAtTime(step.startHz, startAt);
        if (step.endHz !== step.startHz) {
          osc.frequency.exponentialRampToValueAtTime(
            Math.max(20, step.endHz),
            endAt,
          );
        }
        gainNode.gain.setValueAtTime(0.0001, startAt);
        gainNode.gain.linearRampToValueAtTime(
          step.gain,
          startAt + Math.min(0.015, step.durationSec * 0.25),
        );
        gainNode.gain.exponentialRampToValueAtTime(0.0001, endAt);
        osc.connect(gainNode);
        gainNode.connect(audio.destination);
        activeOscillators.add(osc);
        osc.onended = () => {
          activeOscillators.delete(osc);
          try {
            osc.disconnect?.();
            gainNode.disconnect?.();
          } catch {
            // 忽略断开异常
          }
        };
        osc.start(startAt);
        osc.stop(endAt + 0.01);
      } catch {
        // 单个音轨构建失败时静默降级
      }
    }

    return true;
  }

  return {
    play,
    stop: stopActive,
    getLastPlayedAt: () => lastPlayedAt,
  };
}

const defaultSoundPlayer = createSoundPlayer();

export function playNotificationSound(
  soundId: NotificationSoundId,
  options?: PlaySoundOptions,
): boolean {
  return defaultSoundPlayer.play(soundId, options);
}
