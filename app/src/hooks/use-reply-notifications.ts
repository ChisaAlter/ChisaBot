import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { toast } from "@/components/ui/toast";
import { isBotsChatPath } from "@/lib/bots-location";
import {
  dispatchComposerPrefill,
  sendPromptToChat,
} from "@/lib/chat/quote-event";
import { addDraftFiles } from "@/lib/chat/ui-memory";
import { objectConnectionKey } from "@/lib/connection-key";
import {
  clearForegroundPresence,
  getClientDeviceId,
  notificationPreferencesFrom,
  reportForegroundPresence,
  subscribeReplyNotifications,
} from "@/lib/notifications/api";
import { playNotificationSound } from "@/lib/notifications/sounds";
import { type PcDeepLink, pcBridge } from "@/lib/pc-bridge";
import { useUserPreferences } from "@/lib/settings/message-list";
import {
  activeChannelIdFromPath,
  type ReplyNotificationEvent,
  shouldNotifyReply,
  truncateNotificationText,
} from "../../../shared/notifications";
import { useDocumentEvent, useWindowEvent } from "./use-dom-events";
import { useExternalConnection } from "./use-external-connection";
import { useInterval } from "./use-timers";

export { activeChannelIdFromPath };

/** 心跳保活周期 25s，小于服务端 60s TTL，确保前台状态平滑续期。 */
const HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_LOCAL_SEEN = 256;

type NativeShareDetail = {
  text?: string;
  imageName?: string;
  imageMime?: string;
  imageBase64?: string;
};

function isWindowActivelyViewed(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  if (typeof document.hasFocus === "function") {
    return document.hasFocus();
  }
  return true;
}

function base64ToImageFile(
  base64: string,
  filename: string,
  mimeType: string,
): File | null {
  try {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], filename || "shared-image.png", {
      type: mimeType || "image/png",
    });
  } catch {
    return null;
  }
}

/**
 * 统一托管：
 * 1. 按当前精确 `channelId` 与窗口可见/聚焦态向服务端上报前台心跳；
 * 2. 订阅非当前前台会话的 AI 回复/任务完成/审批通知，触发系统 `Notification`（140 字素安全截断 + 点击聚焦跳转）与 WebAudio 柔和提示音；
 * 3. 接收 PC Electron `chisabot://` 深链导航与 Android 原生分享草稿预填。
 */
export function useReplyNotifications(): void {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeChannelId = activeChannelIdFromPath(pathname);
  const preferences = useUserPreferences();
  const { frequency, sound } = notificationPreferencesFrom(preferences.data);

  const stateRef = useRef({
    activeChannelId,
    frequency,
    sound,
  });
  stateRef.current = { activeChannelId, frequency, sound };

  const seenRef = useRef<Set<string>>(new Set());

  const pushPresence = useCallback(
    (overrideActive?: boolean, options?: { keepalive?: boolean }) => {
      const deviceId = getClientDeviceId();
      const active =
        overrideActive !== undefined
          ? overrideActive
          : isWindowActivelyViewed();
      const channelId = active ? stateRef.current.activeChannelId : null;
      void reportForegroundPresence({ deviceId, channelId, active }, options);
    },
    [],
  );

  // 路由切换时立刻上报新的精确 channelId（切离某频道时立刻解除抑制，切入时立刻抑制）
  useExternalConnection(`fg:${activeChannelId ?? "none"}`, (_key, signal) => {
    const deviceId = getClientDeviceId();
    const active = isWindowActivelyViewed();
    void reportForegroundPresence(
      {
        deviceId,
        channelId: active ? activeChannelId : null,
        active,
      },
      { signal },
    );
  });

  // 25s 定时心跳保活，维持 <60s TTL
  useInterval(() => {
    if (isWindowActivelyViewed()) {
      pushPresence(true);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 窗口可见性、焦点的即时切换（含离开页与卸载清理）
  useDocumentEvent("visibilitychange", () => {
    pushPresence(isWindowActivelyViewed());
  });
  useWindowEvent("focus", () => {
    pushPresence(true);
  });
  useWindowEvent("blur", () => {
    pushPresence(false);
  });
  useWindowEvent("pagehide", () => {
    void clearForegroundPresence(getClientDeviceId());
  });

  // 订阅站内实时回复通知事件
  useExternalConnection(`notify:${objectConnectionKey(router)}`, () => {
    return subscribeReplyNotifications((event: ReplyNotificationEvent) => {
      const seen = seenRef.current;
      if (seen.has(event.id)) return;
      seen.add(event.id);
      if (seen.size > MAX_LOCAL_SEEN) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }

      const {
        activeChannelId: currentChannel,
        frequency: currentFreq,
        sound: currentSound,
      } = stateRef.current;
      const channelForeground =
        isWindowActivelyViewed() &&
        currentChannel !== null &&
        currentChannel === event.channelId;

      if (
        !shouldNotifyReply({
          frequency: currentFreq,
          kind: event.kind,
          channelForeground,
        })
      ) {
        return;
      }

      const played = playNotificationSound(currentSound);
      const title =
        event.kind === "needs-input"
          ? `${event.agentName} 需要你处理`
          : event.agentName;
      const body = truncateNotificationText(event.preview, 140);

      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          const notice = new Notification(title, {
            body,
            tag: event.id,
            silent: played,
          });
          notice.onclick = () => {
            try {
              window.focus();
            } catch {
              // 忽略无焦点权限环境
            }
            void pcBridge()
              ?.focusWindow?.()
              .catch(() => undefined);
            void router.navigate({
              to: "/channel/$channelId",
              params: { channelId: event.channelId },
            });
            notice.close();
          };
        } catch {
          // 某些 WebView 禁止构造 Notification 时回落为站内轻提示
          toast.action(`${title}：${body}`, "查看", () => {
            void router.navigate({
              to: "/channel/$channelId",
              params: { channelId: event.channelId },
            });
          });
        }
      } else {
        toast.action(`${title}：${body}`, "查看", () => {
          void router.navigate({
            to: "/channel/$channelId",
            params: { channelId: event.channelId },
          });
        });
      }
    });
  });

  // 接收 PC Electron 主进程转发的 chisabot:// 深链
  const navigateDeepLink = useCallback(
    (link: PcDeepLink) => {
      if (link.kind === "channel") {
        void router.navigate({
          to: "/channel/$channelId",
          params: { channelId: link.channelId },
        });
        return;
      }
      if (link.kind === "agent") {
        void router.navigate({
          to: "/channel/new",
          search: { agent: link.agentId },
        });
      }
    },
    [router],
  );

  useExternalConnection(`pc-deeplink:${objectConnectionKey(router)}`, () => {
    const bridge = pcBridge();
    if (!bridge) return;
    void bridge
      .consumeDeepLink?.()
      .then((pending) => {
        if (pending) navigateDeepLink(pending);
      })
      .catch(() => undefined);
    return bridge.onDeepLink?.((link) => {
      navigateDeepLink(link);
    });
  });

  // 接收 Android WebView 注入的系统分享内容（文本 / 图片）并带入当前或默认聊天草稿
  useWindowEvent("chisabot-native-share", (rawEvent) => {
    const detail = (rawEvent as CustomEvent<NativeShareDetail>).detail;
    if (!detail || typeof detail !== "object") return;
    const text = typeof detail.text === "string" ? detail.text.trim() : "";
    const hasImage =
      typeof detail.imageBase64 === "string" && detail.imageBase64.length > 0;

    if (hasImage && detail.imageBase64) {
      const file = base64ToImageFile(
        detail.imageBase64,
        detail.imageName ?? "shared-image.png",
        detail.imageMime ?? "image/png",
      );
      if (file) {
        const currentChannel = stateRef.current.activeChannelId;
        const searchAgent =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("agent")
            : null;
        const threadKey =
          currentChannel ?? (searchAgent ? `new:${searchAgent}` : "new");
        addDraftFiles(threadKey, [file]);
        toast.success(`已添加分享图片：${file.name}`);
      }
    }

    if (text) {
      if (
        typeof window !== "undefined" &&
        isBotsChatPath(window.location.pathname)
      ) {
        dispatchComposerPrefill(text);
      } else {
        sendPromptToChat((opts) => void router.navigate(opts as never), text);
      }
    }
  });
}
