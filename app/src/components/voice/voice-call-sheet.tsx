import {
  IconHandStop,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneCall,
  IconPhoneOff,
  IconTool,
  IconWaveSine,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import type { AIState } from "@/components/agents/orb/ai-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ContentEnter,
  SmoothCollapse,
} from "@/components/ui/motion-primitives";
import { useExternalConnection } from "@/hooks";
import { useVoiceCall } from "@/hooks/use-voice-call";
import { useRetainedValue } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { voiceStatusQueryOptions } from "@/lib/voice/call-client";
import type {
  VoiceAudioProcessing,
  VoiceCallState,
} from "../../../../shared/voice-call";

function mapCallStateToOrbState(state: VoiceCallState): AIState {
  switch (state) {
    case "listening":
      return "listening";
    case "connecting":
    case "thinking":
      return "thinking";
    case "speaking":
      return "streaming";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function stateLabel(state: VoiceCallState): string {
  switch (state) {
    case "connecting":
      return "连接中…";
    case "listening":
      return "正在聆听";
    case "thinking":
      return "思考中";
    case "speaking":
      return "正在播报";
    case "error":
      return "连接异常";
    default:
      return "待机";
  }
}

function aecBadgeLabel(mode: VoiceAudioProcessing): string {
  switch (mode) {
    case "native-aec3-v1":
      return "硬件 AEC3 · 全双工";
    case "web-aec-v1":
      return "Web AEC · 全双工";
    default:
      return "半双工保护";
  }
}

/**
 * 聊天输入框旁的实时语音通话入口按钮：
 * 仅在服务端 ASR 与 TTS 均已就绪时显示，零打扰未配置语音服务的部署。
 */
export const VoiceCallTriggerButton = memo(function VoiceCallTriggerButton({
  disabled = false,
  onOpen,
}: {
  disabled?: boolean;
  onOpen: () => void;
}) {
  const voiceStatus = useQuery(voiceStatusQueryOptions());
  if (!voiceStatus.data?.ready) {
    return null;
  }

  return (
    <button
      aria-label="发起实时语音通话"
      className={cn(
        "perm-chip inline-flex items-center gap-1.5 text-foreground/80 transition-colors hover:text-foreground",
        disabled && "pointer-events-none opacity-50",
      )}
      data-testid="voice-call-trigger"
      disabled={disabled}
      onClick={onOpen}
      title="与当前机器人发起双向实时语音通话（支持随时插话打断）"
      type="button"
    >
      <IconPhoneCall className="size-3.5" />
      <span className="perm-chip-label">{"语音通话"}</span>
    </button>
  );
});

export type VoiceCallSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  botId: string;
  botName?: string;
  channelId?: string;
  onCallEnded?: () => void;
};

/**
 * 沉浸式双向实时语音通话浮层：
 * - 真正激活 `AgentOrb` 的实时 `amplitude` 声波共振与状态动效；
 * - 实时滚动展示用户与机器人字幕，并明确标识工具调用与被打断未播完草稿；
 * - 提供静音、随时手动打断与挂断控制。
 */
export function VoiceCallSheet({
  open,
  onOpenChange,
  botId,
  botName,
  channelId,
  onCallEnded,
}: VoiceCallSheetProps) {
  const call = useVoiceCall({
    botId,
    ...(channelId ? { channelId } : {}),
    ...(onCallEnded ? { onCallEnded } : {}),
  });

  // 打开浮层自动发起通话，关闭浮层自动挂断并释放麦克风与 WebSocket。
  useExternalConnection(open ? `${botId}\0${channelId ?? ""}` : false, () => {
    void call.start();
    return () => {
      call.hangUp();
    };
  });

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        call.hangUp();
      }
      onOpenChange(nextOpen);
    },
    [call, onOpenChange],
  );

  const orbState = mapCallStateToOrbState(call.state);
  const canInterrupt = call.state === "thinking" || call.state === "speaking";
  const isLive =
    call.state === "connecting" ||
    call.state === "listening" ||
    call.state === "thinking" ||
    call.state === "speaking";
  const shownError = useRetainedValue(call.error || null);

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent
        className="max-w-md gap-5 border-border/70 p-6"
        data-testid="voice-call-sheet"
      >
        <DialogHeader className="gap-1">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              <IconWaveSine className="size-4 text-primary" />
              <span>{botName ? `与 ${botName} 语音通话` : "实时语音通话"}</span>
            </DialogTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 font-medium text-foreground/80">
              <span
                className={cn(
                  "size-1.5 rounded-full transition-colors duration-200",
                  call.state === "listening" && "bg-emerald-500",
                  call.state === "speaking" && "bg-sky-500",
                  (call.state === "thinking" || call.state === "connecting") &&
                    "bg-amber-500",
                  call.state === "error" && "bg-destructive",
                  call.state === "idle" && "bg-muted-foreground/50",
                )}
              />
              {stateLabel(call.state)}
            </span>
            <span className="rounded-full bg-muted/50 px-2 py-0.5">
              {aecBadgeLabel(call.audioProcessing)}
            </span>
            {isLive ? (
              <span className="tabular-nums">
                {formatDuration(call.durationSeconds)}
              </span>
            ) : null}
          </div>
        </DialogHeader>

        {/* 核心视觉：AgentOrb 声波共振舞台 */}
        <div className="flex flex-col items-center justify-center gap-3 py-3">
          <div className="relative flex items-center justify-center">
            <AgentOrb
              active={isLive}
              amplitude={call.amplitude}
              size="172px"
              state={orbState}
            />
          </div>

          <ContentEnter
            key={
              call.activeToolName
                ? `tool:${call.activeToolName}`
                : call.statusDetail
                  ? `detail:${call.statusDetail}`
                  : `hint:${call.state}`
            }
          >
            {call.activeToolName ? (
              <div
                className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/60 px-3 py-1 text-xs text-foreground/85"
                role="status"
              >
                <IconTool className="size-3.5 text-amber-500 motion-safe:animate-pulse" />
                <span>{`正在调用工具：${call.activeToolName}`}</span>
              </div>
            ) : call.statusDetail ? (
              <p
                className="text-center text-xs text-muted-foreground"
                role="status"
              >
                {call.statusDetail}
              </p>
            ) : (
              <p className="text-center text-xs text-muted-foreground">
                {call.state === "speaking"
                  ? "直接开口即可随时打断播报"
                  : call.state === "listening"
                    ? "请说话，停顿片刻自动发送"
                    : "准备就绪"}
              </p>
            )}
          </ContentEnter>
        </div>

        {/* 实时字幕流 */}
        <div
          aria-live="polite"
          className="flex max-h-48 min-h-24 flex-col gap-2 overflow-y-auto rounded-lg border border-border/50 bg-background/50 p-3 text-xs"
          data-testid="voice-call-subtitles"
        >
          {call.subtitles.length === 0 ? (
            <p className="my-auto text-center text-muted-foreground">
              {"实时对话字幕将显示在这里"}
            </p>
          ) : (
            call.subtitles.map((entry) => (
              <div
                className={cn(
                  "list-enter flex flex-col gap-0.5",
                  entry.role === "user" ? "items-end" : "items-start",
                )}
                key={entry.id}
              >
                <span className="text-[10px] text-muted-foreground">
                  {entry.role === "user" ? "你" : (botName ?? "机器人")}
                  {entry.interrupted ? " · 已打断" : ""}
                </span>
                <div
                  className={cn(
                    "max-w-[90%] rounded-lg px-2.5 py-1.5 leading-relaxed",
                    entry.role === "user"
                      ? "bg-primary/12 text-foreground"
                      : "bg-muted/80 text-foreground",
                  )}
                >
                  <span>{entry.text}</span>
                  {entry.draftText ? (
                    <span className="mt-1 block border-t border-border/40 pt-1 text-[11px] text-muted-foreground line-through">
                      {`未播完草稿：${entry.draftText}`}
                    </span>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>

        <SmoothCollapse open={Boolean(call.error)} unmountOnExit>
          {shownError ? (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role={call.error ? "alert" : undefined}
            >
              {shownError}
            </div>
          ) : null}
        </SmoothCollapse>

        {/* 底部控制栏 */}
        <div className="flex items-center justify-center gap-3 pt-1">
          <Button
            aria-label={call.muted ? "取消静音" : "静音麦克风"}
            disabled={!isLive}
            onClick={call.toggleMute}
            size="sm"
            type="button"
            variant={call.muted ? "secondary" : "outline"}
          >
            {call.muted ? (
              <IconMicrophoneOff className="size-4 text-destructive" />
            ) : (
              <IconMicrophone className="size-4" />
            )}
            <span>{call.muted ? "已静音" : "静音"}</span>
          </Button>

          <Button
            aria-label="打断当前回复"
            disabled={!canInterrupt}
            onClick={call.interrupt}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconHandStop className="size-4" />
            <span>{"打断"}</span>
          </Button>

          {isLive ? (
            <Button
              aria-label="挂断语音通话"
              onClick={() => handleOpenChange(false)}
              size="sm"
              type="button"
              variant="destructive"
            >
              <IconPhoneOff className="size-4" />
              <span>{"挂断"}</span>
            </Button>
          ) : (
            <Button
              aria-label="重新连接语音通话"
              onClick={() => void call.start()}
              size="sm"
              type="button"
              variant="default"
            >
              <IconPhoneCall className="size-4" />
              <span>{"重新连接"}</span>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
