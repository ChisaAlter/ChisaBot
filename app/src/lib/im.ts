import { queryOptions } from "@tanstack/react-query";
import type { ImConnectionView, ImLogEntry } from "../../../shared/im";
import { client } from "@/lib/client";

/** 设置 → IM 接入（DESIGN.md §49，docs/im.md）。列表每 5 秒刷新：状态和「最后消息」几乎实时。 */

export const imKeys = {
  all: ["im"] as const,
  list: ["im", "list"] as const,
  logs: (id: string) => ["im", "logs", id] as const,
};

export function imConnectionsQueryOptions() {
  return queryOptions({
    queryKey: imKeys.list,
    queryFn: ({ signal }): Promise<ImConnectionView[]> =>
      client("/api/im/connections", "connections", { fallback: "无法加载 IM 连接", signal }),
    refetchInterval: 5_000,
    refetchOnWindowFocus: "always",
  });
}

export function imLogsQueryOptions(id: string) {
  return queryOptions({
    queryKey: imKeys.logs(id),
    queryFn: ({ signal }): Promise<ImLogEntry[]> =>
      client(`/api/im/connections/${encodeURIComponent(id)}/logs`, "logs", { fallback: "无法加载日志", signal }),
    refetchInterval: 4_000,
  });
}

export type ImConnectionInput = {
  platform?: string;
  name?: string;
  agentId?: string;
  enabled?: boolean;
  config?: Record<string, string>;
  /** 只放这次填了的密钥；不填 = 沿用已保存的。 */
  secrets?: Record<string, string>;
  allowUsers?: string[];
  /** 主人本人的平台用户 id（私聊审批要靠它认出主人）。 */
  ownerUsers?: string[];
  allowDevices?: boolean;
  /** 「允许内网地址」（仅管理员可改；非管理员传了服务器也忽略）。 */
  allowPrivate?: boolean;
  /** 微信扫码授权成功后服务器给的一次性键（令牌不经过浏览器）。 */
  weixinLogin?: string;
  /** 统一扫码授权（微信 / QQ 官方 / 企业微信 / 钉钉 / 飞书）成功后服务器给的一次性键。 */
  qrLogin?: string;
};

export function createImConnection(input: ImConnectionInput): Promise<ImConnectionView> {
  return client("/api/im/connections", "connection", { method: "POST", body: input, fallback: "保存失败，请重试" });
}

export function updateImConnection(id: string, input: ImConnectionInput): Promise<ImConnectionView> {
  return client(`/api/im/connections/${encodeURIComponent(id)}`, "connection", { method: "PATCH", body: input, fallback: "保存失败，请重试" });
}

export async function deleteImConnection(id: string) {
  await client(`/api/im/connections/${encodeURIComponent(id)}`, { method: "DELETE", fallback: "删除失败，请重试" });
}

export type ImTestResult = { ok: boolean; detail: string };

export async function testImConnection(id: string): Promise<ImTestResult> {
  const response = await client(`/api/im/connections/${encodeURIComponent(id)}/test`, { method: "POST", fallback: "测试失败，请重试" });
  return response.json();
}

export async function testImDraft(input: ImConnectionInput & { id?: string }): Promise<ImTestResult> {
  const response = await client("/api/im/test", { method: "POST", body: input, fallback: "测试失败，请重试" });
  return response.json();
}

export type ImQrStartResult = {
  session: string;
  qrcode: string;
  url: string;
  qrKind?: "url" | "image";
};

export async function startImQr(input: {
  platform: string;
  baseUrl?: string;
  domain?: string;
}): Promise<ImQrStartResult> {
  const response = await client("/api/im/qr/start", {
    method: "POST",
    body: input,
    fallback: "获取二维码失败",
  });
  return response.json();
}

export type ImQrPollResult = {
  status: "wait" | "scanned" | "confirmed" | "expired";
  loginKey?: string;
  account?: string | null;
  config?: Record<string, string>;
  message?: string;
};

export async function pollImQr(session: string, signal?: AbortSignal): Promise<ImQrPollResult> {
  const response = await client(`/api/im/qr/status?session=${encodeURIComponent(session)}`, {
    fallback: "查询扫码状态失败",
    signal,
  });
  return response.json();
}

export async function weixinQr(baseUrl?: string): Promise<{ qrcode: string; url: string }> {
  const response = await client("/api/im/weixin/qr", { method: "POST", body: { baseUrl }, fallback: "获取二维码失败" });
  return response.json();
}

export type WeixinQrStatus = { status: "wait" | "scanned" | "confirmed" | "expired"; loginKey?: string; account?: string | null };

export async function weixinQrStatus(qrcode: string, signal?: AbortSignal): Promise<WeixinQrStatus> {
  const response = await client(`/api/im/weixin/qr/status?qrcode=${encodeURIComponent(qrcode)}`, { fallback: "查询扫码状态失败", signal });
  return response.json();
}

/** 「3 分钟前」。 */
export function agoText(iso: string | null): string | null {
  if (!iso) return null;
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
