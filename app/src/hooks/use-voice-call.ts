import { type MotionValue, useMotionValue } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceCallClient } from "@/lib/voice/call-client";
import type {
  VoiceAudioProcessing,
  VoiceCallState,
  VoiceServerEvent,
} from "../../../shared/voice-call";

export type VoiceSubtitleEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
  draftText?: string;
  at: number;
};

export type UseVoiceCallOptions = {
  botId: string;
  channelId?: string;
  voice?: string;
  speed?: number;
  onCallEnded?: () => void;
};

export type UseVoiceCallResult = {
  state: VoiceCallState;
  statusDetail: string | null;
  activeToolName: string | null;
  audioProcessing: VoiceAudioProcessing;
  muted: boolean;
  error: string | null;
  durationSeconds: number;
  subtitles: readonly VoiceSubtitleEntry[];
  /** 0..1 实时平滑振幅（MotionValue），零重渲染驱动 AgentOrb 声波共振。 */
  amplitude: MotionValue<number>;
  start: () => Promise<void>;
  hangUp: () => void;
  toggleMute: () => void;
  interrupt: () => void;
  commitSpeech: () => void;
};

const MAX_SUBTITLE_ENTRIES = 24;
const AMPLITUDE_ATTACK = 0.45;
const AMPLITUDE_RELEASE = 0.18;

/**
 * 实时双向语音通话状态管理 Hook：
 * 统一封装麦克风权限申请、WebSocket 通话生命周期、双语/双角色实时字幕流、
 * AgentOrb 声波共振振幅以及静音、手动打断、挂断动作。
 */
export function useVoiceCall(options: UseVoiceCallOptions): UseVoiceCallResult {
  const { botId, channelId, voice, speed, onCallEnded } = options;

  const [state, setState] = useState<VoiceCallState>("idle");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [audioProcessing, setAudioProcessing] =
    useState<VoiceAudioProcessing>("web-aec-v1");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [subtitles, setSubtitles] = useState<VoiceSubtitleEntry[]>([]);

  const amplitude = useMotionValue(0);
  const clientRef = useRef<VoiceCallClient | null>(null);
  const connectAbortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const micAmpRef = useRef(0);
  const playbackAmpRef = useRef(0);
  const mountedRef = useRef(true);
  const onCallEndedRef = useRef(onCallEnded);
  onCallEndedRef.current = onCallEnded;

  const pushAmplitude = useCallback(
    (rawTarget: number) => {
      const clamped = Math.min(1, Math.max(0, rawTarget));
      const prev = amplitude.get();
      const alpha = clamped > prev ? AMPLITUDE_ATTACK : AMPLITUDE_RELEASE;
      amplitude.set(prev + (clamped - prev) * alpha);
    },
    [amplitude],
  );

  const stopDurationTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    startedAtRef.current = null;
  }, []);

  const startDurationTimer = useCallback(() => {
    stopDurationTimer();
    startedAtRef.current = Date.now();
    setDurationSeconds(0);
    timerRef.current = setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;
      setDurationSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
    }, 1000);
  }, [stopDurationTimer]);

  const appendOrUpdateSubtitle = useCallback(
    (updater: (prev: VoiceSubtitleEntry[]) => VoiceSubtitleEntry[]) => {
      setSubtitles((prev) => {
        const next = updater(prev);
        return next.length > MAX_SUBTITLE_ENTRIES
          ? next.slice(next.length - MAX_SUBTITLE_ENTRIES)
          : next;
      });
    },
    [],
  );

  const handleServerEvent = useCallback(
    (event: VoiceServerEvent) => {
      if (!mountedRef.current) return;
      switch (event.type) {
        case "session.ready":
          setAudioProcessing(event.audioProcessing);
          setError(null);
          break;
        case "state.change":
          setState(event.state);
          setStatusDetail(event.detail ?? null);
          setActiveToolName(event.toolName ?? null);
          if (event.state !== "speaking") {
            playbackAmpRef.current = 0;
          }
          break;
        case "transcript.delta":
          appendOrUpdateSubtitle((prev) => {
            const id = `u:${event.turnId}`;
            const idx = prev.findIndex((item) => item.id === id);
            if (idx >= 0) {
              return prev.map((item, i) =>
                i === idx ? { ...item, text: event.text, final: false } : item,
              );
            }
            return [
              ...prev,
              {
                id,
                role: "user",
                text: event.text,
                final: false,
                at: Date.now(),
              },
            ];
          });
          break;
        case "transcript.final":
          appendOrUpdateSubtitle((prev) => {
            const id = `u:${event.turnId}`;
            const idx = prev.findIndex((item) => item.id === id);
            if (idx >= 0) {
              return prev.map((item, i) =>
                i === idx ? { ...item, text: event.text, final: true } : item,
              );
            }
            return [
              ...prev,
              {
                id,
                role: "user",
                text: event.text,
                final: true,
                at: Date.now(),
              },
            ];
          });
          break;
        case "assistant.text.delta":
          appendOrUpdateSubtitle((prev) => {
            const id = `a:${event.turnId}`;
            const idx = prev.findIndex((item) => item.id === id);
            if (idx >= 0) {
              return prev.map((item, i) =>
                i === idx
                  ? { ...item, text: `${item.text}${event.delta}` }
                  : item,
              );
            }
            return [
              ...prev,
              {
                id,
                role: "assistant",
                text: event.delta,
                final: false,
                at: Date.now(),
              },
            ];
          });
          break;
        case "assistant.spoken.commit":
          appendOrUpdateSubtitle((prev) => {
            const id = `a:${event.turnId}`;
            const idx = prev.findIndex((item) => item.id === id);
            const display =
              event.spokenText || (event.interrupted ? "（回复已打断）" : "");
            if (idx >= 0) {
              return prev.map((item, i) =>
                i === idx
                  ? {
                      ...item,
                      text: display || item.text,
                      final: true,
                      interrupted: event.interrupted,
                      ...(event.draftText
                        ? { draftText: event.draftText }
                        : {}),
                    }
                  : item,
              );
            }
            if (!display && !event.draftText) return prev;
            return [
              ...prev,
              {
                id,
                role: "assistant",
                text: display,
                final: true,
                interrupted: event.interrupted,
                ...(event.draftText ? { draftText: event.draftText } : {}),
                at: Date.now(),
              },
            ];
          });
          break;
        case "barge_in":
          playbackAmpRef.current = 0;
          setStatusDetail("已打断，继续聆听…");
          setActiveToolName(null);
          break;
        case "error":
          setError(event.message);
          if (event.recoverable === false) {
            setState("error");
          }
          break;
        case "assistant.audio.chunk":
        case "assistant.audio.done":
        case "pong":
          break;
      }
    },
    [appendOrUpdateSubtitle],
  );

  const teardown = useCallback(
    (nextState: VoiceCallState, notifyEnded = false) => {
      connectAbortRef.current?.abort();
      connectAbortRef.current = null;
      const activeClient = clientRef.current;
      clientRef.current = null;
      activeClient?.disconnect();
      stopDurationTimer();
      micAmpRef.current = 0;
      playbackAmpRef.current = 0;
      amplitude.set(0);
      if (mountedRef.current) {
        setState(nextState);
        setStatusDetail(null);
        setActiveToolName(null);
        setMuted(false);
      }
      if (notifyEnded) {
        onCallEndedRef.current?.();
      }
    },
    [amplitude, stopDurationTimer],
  );

  const hangUp = useCallback(() => {
    setError(null);
    teardown("idle", true);
  }, [teardown]);

  const start = useCallback(async () => {
    if (!botId) return;
    teardown("connecting", false);
    setError(null);
    setSubtitles([]);
    setStatusDetail("正在申请麦克风并建立通话…");

    const controller = new AbortController();
    connectAbortRef.current = controller;

    const callClient = new VoiceCallClient({
      onServerEvent: handleServerEvent,
      onMicAmplitude: (level) => {
        micAmpRef.current = level;
        pushAmplitude(Math.max(micAmpRef.current, playbackAmpRef.current));
      },
      onPlaybackAmplitude: (level) => {
        playbackAmpRef.current = level;
        pushAmplitude(Math.max(micAmpRef.current, playbackAmpRef.current));
      },
      onClose: (reason) => {
        if (clientRef.current !== callClient) return;
        clientRef.current = null;
        stopDurationTimer();
        micAmpRef.current = 0;
        playbackAmpRef.current = 0;
        amplitude.set(0);
        if (mountedRef.current) {
          setState("idle");
          setStatusDetail(reason);
          setActiveToolName(null);
        }
        onCallEndedRef.current?.();
      },
      onError: (message) => {
        if (!mountedRef.current) return;
        setError(message);
      },
    });
    clientRef.current = callClient;

    try {
      const ticket = await callClient.connect({
        botId,
        ...(channelId ? { channelId } : {}),
        ...(voice ? { voice } : {}),
        ...(speed !== undefined ? { speed } : {}),
        signal: controller.signal,
      });
      if (!mountedRef.current || clientRef.current !== callClient) {
        callClient.disconnect();
        return;
      }
      setAudioProcessing(ticket.audioProcessing);
      startDurationTimer();
    } catch (err) {
      if (clientRef.current === callClient) {
        clientRef.current = null;
      }
      callClient.disconnect();
      stopDurationTimer();
      if (!mountedRef.current || controller.signal.aborted) return;
      const message =
        err instanceof Error && err.message.trim()
          ? err.message
          : "无法建立实时语音通话，请重试。";
      setError(message);
      setState("error");
      setStatusDetail(null);
    }
  }, [
    amplitude,
    botId,
    channelId,
    handleServerEvent,
    pushAmplitude,
    speed,
    startDurationTimer,
    stopDurationTimer,
    teardown,
    voice,
  ]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      clientRef.current?.setMuted(next);
      if (next) {
        micAmpRef.current = 0;
        pushAmplitude(playbackAmpRef.current);
      }
      return next;
    });
  }, [pushAmplitude]);

  const interrupt = useCallback(() => {
    clientRef.current?.interrupt();
    playbackAmpRef.current = 0;
    pushAmplitude(micAmpRef.current);
  }, [pushAmplitude]);

  const commitSpeech = useCallback(() => {
    clientRef.current?.commitSpeech();
  }, []);

  // 组件卸载或切换机器人/频道时自动清理当前通话。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      connectAbortRef.current?.abort();
      connectAbortRef.current = null;
      clientRef.current?.disconnect();
      clientRef.current = null;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return {
    state,
    statusDetail,
    activeToolName,
    audioProcessing,
    muted,
    error,
    durationSeconds,
    subtitles,
    amplitude,
    start,
    hangUp,
    toggleMute,
    interrupt,
    commitSpeech,
  };
}
