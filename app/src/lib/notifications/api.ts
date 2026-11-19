import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { saveUserPreferencesMutationOptions } from "@/lib/settings/message-list";
import {
  DEFAULT_NOTIFICATION_FREQUENCY,
  DEFAULT_NOTIFICATION_SOUND,
  extractBarkEndpointFromCurl,
  type NotificationFrequency,
  type NotificationSoundId,
  type PushDeviceView,
  type PushPlatform,
  type ReplyNotificationEvent,
} from "../../../../shared/notifications";
import type { UserPreferences } from "../../../../shared/user-preferences";

const DEVICE_ID_STORAGE_KEY = "chisabot-foreground-device-id";

let memoryDeviceId: string | null = null;

/**
 * 为每个浏览器标签页维护独立且稳定的前台设备 ID（存 sessionStorage）。
 * 多标签页各自汇报自己的可见性与当前频道，互不覆盖。
 */
export function getClientDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;
  if (typeof window !== "undefined") {
    try {
      const existing = window.sessionStorage.getItem(DEVICE_ID_STORAGE_KEY);
      if (existing && existing.length <= 128) {
        memoryDeviceId = existing;
        return existing;
      }
      const generated =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? `web_${crypto.randomUUID()}`
          : `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      window.sessionStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
      memoryDeviceId = generated;
      return generated;
    } catch {
      // sessionStorage 不可用时退回内存 ID
    }
  }
  memoryDeviceId = `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return memoryDeviceId;
}

const replyListeners = new Set<(event: ReplyNotificationEvent) => void>();

export function emitReplyNotification(event: ReplyNotificationEvent): void {
  for (const listener of replyListeners) {
    try {
      listener(event);
    } catch {
      // 单个监听异常不影响其他消费者
    }
  }
}

export function subscribeReplyNotifications(
  listener: (event: ReplyNotificationEvent) => void,
): () => void {
  replyListeners.add(listener);
  return () => {
    replyListeners.delete(listener);
  };
}

/** 上报当前标签页/客户端的前台活跃状态与正在查看的 channelId。 */
export async function reportForegroundPresence(
  input: {
    deviceId: string;
    channelId: string | null;
    active: boolean;
  },
  options?: { signal?: AbortSignal; keepalive?: boolean },
): Promise<void> {
  await tryClient("/api/notifications/foreground", {
    method: "POST",
    body: input,
    timeoutMs: 8_000,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.keepalive ? { keepalive: true } : {}),
  }).catch(() => undefined);
}

/** 标签页卸载时主动清除前台态。 */
export async function clearForegroundPresence(deviceId: string): Promise<void> {
  await tryClient(
    `/api/notifications/foreground/${encodeURIComponent(deviceId)}`,
    {
      method: "DELETE",
      timeoutMs: 5_000,
      keepalive: true,
    },
  ).catch(() => undefined);
}

export function notificationPreferencesFrom(
  prefs: Partial<UserPreferences> | undefined,
): {
  frequency: NotificationFrequency;
  sound: NotificationSoundId;
} {
  return {
    frequency: prefs?.notificationFrequency ?? DEFAULT_NOTIFICATION_FREQUENCY,
    sound: prefs?.notificationSound ?? DEFAULT_NOTIFICATION_SOUND,
  };
}

export function saveNotificationPreferencesMutationOptions(
  queryClient: QueryClient,
  userId: string | undefined,
) {
  return saveUserPreferencesMutationOptions(queryClient, userId);
}

export const pushDevicesKeys = {
  all: ["push-devices"] as const,
  list: () => [...pushDevicesKeys.all, "list"] as const,
};

export function pushDevicesQueryOptions() {
  return queryOptions({
    queryKey: pushDevicesKeys.list(),
    queryFn: ({ signal }): Promise<PushDeviceView[]> =>
      client<PushDeviceView[]>("/api/push/devices", "devices", {
        signal,
        fallback: "无法加载已注册的推送设备",
      }),
  });
}

export type RegisterPushDevicePayload =
  | {
      provider: "bark";
      platform?: PushPlatform;
      label?: string;
      barkCurl?: string;
      serverUrl?: string;
      deviceKey?: string;
    }
  | {
      provider: "fcm";
      platform?: PushPlatform;
      label?: string;
      deviceToken: string;
      fcmProjectId?: string;
      endpoint?: string;
      accessToken: string;
    }
  | {
      provider: "apns";
      platform?: "ios";
      label?: string;
      deviceToken: string;
      topic: string;
      environment?: "production" | "development";
      bearerToken?: string;
      keyId?: string;
      teamId?: string;
      privateKey?: string;
    };

export function registerPushDeviceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (payload: RegisterPushDevicePayload): Promise<PushDeviceView> =>
      client<PushDeviceView>("/api/push/devices", "device", {
        method: "POST",
        body: payload,
        fallback: "无法登记推送设备",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pushDevicesKeys.all });
    },
  });
}

export function deletePushDeviceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (deviceId: string): Promise<void> => {
      await client(`/api/push/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
        fallback: "无法移除推送设备",
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pushDevicesKeys.all });
    },
  });
}

export type TestPushResult = {
  deviceId: string;
  provider: "bark" | "fcm" | "apns";
  ok: boolean;
  status: number;
  invalidTokenRemoved: boolean;
  error?: string;
};

export async function testPushDevice(
  deviceId: string,
  options?: { channelId?: string; agentId?: string },
): Promise<TestPushResult> {
  const response = await tryClient(
    `/api/push/devices/${encodeURIComponent(deviceId)}/test`,
    {
      method: "POST",
      body: options ?? {},
      timeoutMs: 15_000,
    },
  );
  const parsed = (await response.json().catch(() => null)) as
    | (Partial<TestPushResult> & { error?: string })
    | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("测试推送失败，请稍后重试。");
  }
  if (typeof parsed.ok === "boolean") {
    return {
      deviceId: parsed.deviceId ?? deviceId,
      provider: parsed.provider ?? "bark",
      ok: parsed.ok,
      status: parsed.status ?? response.status,
      invalidTokenRemoved: Boolean(parsed.invalidTokenRemoved),
      ...(parsed.error ? { error: parsed.error } : {}),
    };
  }
  throw new Error(parsed.error ?? "测试推送失败，请稍后重试。");
}

/** 本地实时解析 Bark curl 命令或链接。 */
export function parseBarkInput(raw: string) {
  return extractBarkEndpointFromCurl(raw);
}
