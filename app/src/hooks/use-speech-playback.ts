import { useCallback, useEffect, useRef, useState } from "react";
import {
  type SynthesizeSpeechAudioInput,
  synthesizeSpeechAudio,
} from "@/lib/audio/speech";

export type SpeechPlaybackStatus = "idle" | "loading" | "playing" | "error";

export type SpeechPlaybackState = {
  status: SpeechPlaybackStatus;
  activeId: string | null;
  error: string | null;
};

export type SpeechPlaybackItem = {
  id: string;
  text: string;
  voice?: string;
};

export type SpeechAudioPlayer = {
  src: string;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: "ended" | "error", listener: () => void): void;
  removeEventListener(type: "ended" | "error", listener: () => void): void;
  removeAttribute?(qualifiedName: string): void;
};

export type SpeechPlaybackOptions = {
  synthesize?: (input: SynthesizeSpeechAudioInput) => Promise<Blob>;
  createAudio?: (url: string) => SpeechAudioPlayer;
  onError?: (message: string) => void;
};

export type SpeechPlaybackControls = SpeechPlaybackState & {
  speak: (item: SpeechPlaybackItem) => Promise<void>;
  stop: () => void;
};

const IDLE_STATE: SpeechPlaybackState = {
  status: "idle",
  activeId: null,
  error: null,
};

/**
 * 模块级单路互斥协调器：确保整个页面同一时刻最多只有一个朗读/试听实例处于加载或播放状态。
 * 新实例调用 `speak` 时自动停止先前的活跃实例并释放其网络请求与对象 URL。
 */
let activePlaybackStopper: (() => void) | null = null;

function claimActivePlayback(stopper: () => void): void {
  if (activePlaybackStopper && activePlaybackStopper !== stopper) {
    const previous = activePlaybackStopper;
    activePlaybackStopper = null;
    previous();
  }
  activePlaybackStopper = stopper;
}

function releaseActivePlayback(stopper: () => void): void {
  if (activePlaybackStopper === stopper) {
    activePlaybackStopper = null;
  }
}

function defaultCreateAudio(url: string): SpeechAudioPlayer {
  if (typeof Audio === "undefined") {
    throw new Error("当前环境不支持音频播放。");
  }
  return new Audio(url);
}

function toPlaybackErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "浏览器阻止了音频自动播放，请再次点击播放。";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "语音播放失败，请稍后重试。";
}

/**
 * 语音朗读播放控制 Hook：统一管理请求中止、对象 URL 释放、跨组件单路互斥与卸载清理。
 */
export function useSpeechPlayback(
  options?: SpeechPlaybackOptions,
): SpeechPlaybackControls {
  const [state, setState] = useState<SpeechPlaybackState>(IDLE_STATE);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<SpeechAudioPlayer | null>(null);
  const detachAudioRef = useRef<(() => void) | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const synthesizeRef = useRef(options?.synthesize ?? synthesizeSpeechAudio);
  synthesizeRef.current = options?.synthesize ?? synthesizeSpeechAudio;
  const createAudioRef = useRef(options?.createAudio ?? defaultCreateAudio);
  createAudioRef.current = options?.createAudio ?? defaultCreateAudio;
  const onErrorRef = useRef(options?.onError);
  onErrorRef.current = options?.onError;

  const cleanupMedia = useCallback(() => {
    // 必须先解绑事件再清空音频源，避免主动停止时触发多余的 error 回调。
    detachAudioRef.current?.();
    detachAudioRef.current = null;

    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      try {
        audio.pause();
      } catch {
        // 忽略宿主环境销毁阶段的暂停异常
      }
      try {
        audio.removeAttribute?.("src");
        audio.src = "";
      } catch {
        // 忽略只读媒体属性异常
      }
    }

    const url = objectUrlRef.current;
    objectUrlRef.current = null;
    if (url) {
      URL.revokeObjectURL(url);
    }
  }, []);

  const cancelInFlight = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const stopImplRef = useRef<() => void>(() => {});
  const stableStopper = useCallback(() => {
    stopImplRef.current();
  }, []);

  const stop = useCallback(() => {
    releaseActivePlayback(stableStopper);
    generationRef.current += 1;
    cancelInFlight();
    cleanupMedia();
    if (!mountedRef.current) return;
    setState((prev) =>
      prev.status === "idle" && prev.activeId === null && prev.error === null
        ? prev
        : IDLE_STATE,
    );
  }, [cancelInFlight, cleanupMedia, stableStopper]);

  stopImplRef.current = stop;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseActivePlayback(stableStopper);
      generationRef.current += 1;
      cancelInFlight();
      cleanupMedia();
    };
  }, [cancelInFlight, cleanupMedia, stableStopper]);

  const speak = useCallback(
    async (item: SpeechPlaybackItem): Promise<void> => {
      if (!mountedRef.current) return;

      claimActivePlayback(stableStopper);
      generationRef.current += 1;
      const generation = generationRef.current;
      cancelInFlight();
      cleanupMedia();

      const text = item.text.trim();
      if (!text) {
        releaseActivePlayback(stableStopper);
        const message = "朗读文本不能为空。";
        setState({
          status: "error",
          activeId: item.id,
          error: message,
        });
        onErrorRef.current?.(message);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setState({
        status: "loading",
        activeId: item.id,
        error: null,
      });

      try {
        const blob = await synthesizeRef.current({
          text,
          ...(item.voice?.trim() ? { voice: item.voice.trim() } : {}),
          signal: controller.signal,
        });

        if (
          !mountedRef.current ||
          generation !== generationRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        if (blob.size === 0) {
          throw new Error("语音合成返回了空音频，请重试。");
        }

        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;

        const audio = createAudioRef.current(url);
        audioRef.current = audio;

        const onEnded = () => {
          if (!mountedRef.current || generation !== generationRef.current) {
            return;
          }
          if (abortRef.current === controller) {
            abortRef.current = null;
          }
          releaseActivePlayback(stableStopper);
          cleanupMedia();
          setState(IDLE_STATE);
        };

        const onError = () => {
          if (!mountedRef.current || generation !== generationRef.current) {
            return;
          }
          if (abortRef.current === controller) {
            abortRef.current = null;
          }
          releaseActivePlayback(stableStopper);
          cleanupMedia();
          const message = "音频播放失败，请稍后重试。";
          setState({
            status: "error",
            activeId: item.id,
            error: message,
          });
          onErrorRef.current?.(message);
        };

        audio.addEventListener("ended", onEnded);
        audio.addEventListener("error", onError);
        detachAudioRef.current = () => {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
        };

        await Promise.resolve(audio.play());

        if (
          !mountedRef.current ||
          generation !== generationRef.current ||
          audioRef.current !== audio
        ) {
          return;
        }

        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setState({
          status: "playing",
          activeId: item.id,
          error: null,
        });
      } catch (error) {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        // 已切换新播放或组件已卸载时，当前代次的媒体已由新流程接管并清理，不能误清下一代的资源。
        if (!mountedRef.current || generation !== generationRef.current) {
          return;
        }
        releaseActivePlayback(stableStopper);
        cleanupMedia();
        if (controller.signal.aborted) {
          return;
        }
        const message = toPlaybackErrorMessage(error);
        setState({
          status: "error",
          activeId: item.id,
          error: message,
        });
        onErrorRef.current?.(message);
      }
    },
    [cancelInFlight, cleanupMedia, stableStopper],
  );

  return {
    status: state.status,
    activeId: state.activeId,
    error: state.error,
    speak,
    stop,
  };
}
