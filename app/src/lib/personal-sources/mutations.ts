import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type { PersonalSourcesStatusView } from "../../../../shared/personal-sources";
import { client, tryClient } from "@/lib/client";
import { personalSourcesKeys } from "./queries";

function setStatus(queryClient: QueryClient) {
  return (next: PersonalSourcesStatusView) =>
    queryClient.setQueryData(personalSourcesKeys.all, next);
}

export type CalendarConnectInput = {
  label?: string;
  icsUrl?: string;
  icsText?: string;
  timeZone: string;
};

export function connectCalendarMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      input: CalendarConnectInput,
    ): Promise<PersonalSourcesStatusView> => {
      const response = await client("/api/personal-sources/calendar", {
        method: "POST",
        body: input,
        fallback: "连接日历失败",
      });
      return response.json();
    },
    onSuccess: setStatus(queryClient),
  });
}

export type EmailConnectInput = {
  email: string;
  imapHost: string;
  imapPort: number;
  password: string;
  smtp?: { host: string; port: number; user?: string; password?: string };
};

export function connectEmailMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      input: EmailConnectInput,
    ): Promise<PersonalSourcesStatusView> => {
      const response = await client("/api/personal-sources/email", {
        method: "POST",
        body: input,
        fallback: "连接邮箱失败",
        // IMAP 探测 8s + SMTP 校验 20s 串行，最坏 ~28s，贴住默认 30s 上限——不设请求超时。
        timeoutMs: 0,
      });
      return response.json();
    },
    onSuccess: setStatus(queryClient),
  });
}

export function bindNotifyWebhookMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      label?: string;
      url: string;
    }): Promise<PersonalSourcesStatusView> => {
      const response = await client("/api/personal-sources/notify-webhook", {
        method: "POST",
        body: input,
        fallback: "绑定通知推送失败",
      });
      return response.json();
    },
    onSuccess: setStatus(queryClient),
  });
}

export function disconnectCalendarMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<PersonalSourcesStatusView> => {
      const response = await client("/api/personal-sources/calendar", {
        method: "DELETE",
        fallback: "断开日历失败，请重试",
      });
      return response.json();
    },
    onSuccess: setStatus(queryClient),
  });
}

export function disconnectEmailMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<PersonalSourcesStatusView> => {
      const response = await client("/api/personal-sources/email", {
        method: "DELETE",
        fallback: "断开收件箱失败，请重试",
      });
      return response.json();
    },
    onSuccess: setStatus(queryClient),
  });
}

export function disconnectNotifyWebhookMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (): Promise<PersonalSourcesStatusView> => {
      const response = await client("/api/personal-sources/notify-webhook", {
        method: "DELETE",
        fallback: "断开通知推送失败，请重试",
      });
      return response.json();
    },
    onSuccess: setStatus(queryClient),
  });
}

/**
 * 轮换入站 Webhook 密钥，返回整份新状态。成功 body 就是新状态，缓存直接吃响应。
 * 失败只报这句：网关回的错误体没有「哪个字段错了」这一层信息。
 */
export function rotateInboundTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<PersonalSourcesStatusView> => {
      const response = await tryClient(
        "/api/personal-sources/inbound-webhook/rotate",
        { method: "POST" },
      );
      if (!response.ok) throw new Error("重置入站密钥失败");
      return response.json();
    },
    onSuccess: setStatus(queryClient),
  });
}

/** 改天气城市。响应本身没有可看的内容（连失败都不挡晨报生成），所以只发不读。 */
export async function saveWeatherCity(city: string): Promise<void> {
  await tryClient("/api/personal-sources/weather-city", {
    method: "PUT",
    body: { city },
  });
}

/** 生成晨报正文（模型调用，不设请求超时）。拿不到 markdown 就是失败。 */
export async function generateMorningBrief(city?: string): Promise<string> {
  const response = await tryClient(
    `/api/personal-sources/morning-brief${city ? `?city=${encodeURIComponent(city)}` : ""}`,
    { method: "POST", timeoutMs: 0 },
  );
  const data = (await response.json().catch(() => null)) as {
    markdown?: string;
    error?: string;
  } | null;
  if (!response.ok || !data?.markdown)
    throw new Error(data?.error || "生成晨报失败");
  return data.markdown;
}

/** 主动巡检（模型调用，不设请求超时）。拿不到 markdown 就是失败。 */
export async function runCheckUpdates(): Promise<string> {
  const response = await tryClient("/api/personal-sources/check-updates", {
    method: "POST",
    timeoutMs: 0,
  });
  const data = (await response.json().catch(() => null)) as {
    markdown?: string;
    error?: string;
  } | null;
  if (!response.ok || !data?.markdown)
    throw new Error(data?.error || "主动巡检失败");
  return data.markdown;
}

/** 往入站 Webhook 地址发一条模拟事件；path 由服务器下发。 */
export async function simulateInboundEvent(path: string): Promise<void> {
  const response = await tryClient(path, {
    method: "POST",
    body: {
      source: "ChisaBot 连接测试",
      title: "入站 Webhook 测试事件",
      message: "这是手动触发的连接测试，可在巡检动态中查看。",
    },
  });
  if (!response.ok) throw new Error("触发模拟事件失败");
}

/** 发一条测试通知；`!response.ok` 时带上服务器给的 error。 */
export async function sendTestNotification(requestId: string): Promise<void> {
  const response = await tryClient("/api/personal-sources/notify-test", {
    method: "POST",
    body: { requestId },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error || "发送测试通知失败");
  }
}
