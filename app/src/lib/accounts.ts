import { queryOptions } from "@tanstack/react-query";

/**
 * 设置 → 管理 → 账号（CB-040，DESIGN.md §65）：朋友账号与邀请链接。
 * 账号在登录网关里（deploy/public/auth/server.ts 的 /auth/admin/*），不在应用库里；
 * 没有网关（本机开发、预览）或网关没开多账号时，接口返回 404 / 不是 JSON，页面显示说明。
 */
export type GatewayAccount = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  disabled: boolean;
  builtin: boolean;
  createdAt: number | null;
  lastLoginAt: number | null;
};
export type GatewayInvite = {
  id: string;
  kind: "invite" | "reset";
  accountId: string | null;
  role?: "admin" | "user";
  note: string | null;
  createdAt: number;
  expiresAt: number;
};
export type AccountsState =
  | { available: true; me: string; accounts: GatewayAccount[]; invites: GatewayInvite[]; invitesEnabled: boolean }
  | { available: false; reason: string };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const data = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!response.ok || !data || data.ok === false) throw new Error(data?.error || `请求失败（${response.status}）`);
  return data;
}

export const accountKeys = { all: ["gateway-accounts"] as const };

export function accountsQueryOptions() {
  return queryOptions({
    queryKey: accountKeys.all,
    queryFn: async (): Promise<AccountsState> => {
      const response = await fetch("/auth/admin/accounts", { credentials: "same-origin", headers: { Accept: "application/json" } });
      const type = response.headers.get("Content-Type") || "";
      if (!type.includes("application/json")) return { available: false, reason: "这个部署前面没有 ChisaBot 登录网关，账号由部署方式决定。" };
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; multiAccount?: boolean; me?: string; accounts?: GatewayAccount[]; invites?: GatewayInvite[]; invitesEnabled?: boolean }
        | null;
      if (response.status === 404 && data?.multiAccount === false)
        return { available: false, reason: "登录网关还没开启多账号（服务器上的 identitySecret 没有配置），见 docs/accounts.md。" };
      if (!response.ok || !data?.accounts) throw new Error(data?.error || `读取失败（${response.status}）`);
      // 网关 config.json 的 invites 默认关（2026-10-15）：关着时不显示「邀请朋友」。旧网关没有这个字段 = 开着。
      return { available: true, me: data.me ?? "", accounts: data.accounts, invites: data.invites ?? [], invitesEnabled: data.invitesEnabled !== false };
    },
    staleTime: 10_000,
  });
}

export async function setInvitesEnabled(enabled: boolean) {
  return (await call<{ invitesEnabled: boolean }>("/auth/admin/invites-enabled", { method: "PUT", body: JSON.stringify({ enabled }) })).invitesEnabled;
}
export async function createInvite(input: { note?: string; hours?: number; role?: "admin" | "user" }) {
  return (await call<{ invite: { id: string; url: string; expiresAt: number; role?: "admin" | "user" } }>("/auth/admin/invites", { method: "POST", body: JSON.stringify(input) })).invite;
}
export async function createAccount(input: { username: string; displayName?: string; password: string; role?: "admin" | "user" }) {
  return (await call<{ account: GatewayAccount }>("/auth/admin/accounts", { method: "POST", body: JSON.stringify(input) })).account;
}
export async function revokeInvite(id: string) {
  await call(`/auth/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function setAccountDisabled(id: string, disabled: boolean) {
  await call(`/auth/admin/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
}
export async function setAccountRole(id: string, role: "admin" | "user") {
  return (await call<{ account: GatewayAccount }>(`/auth/admin/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ role }) })).account;
}
export async function setAccountPassword(id: string, password: string) {
  return (await call<{ account: GatewayAccount }>(`/auth/admin/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ password }) })).account;
}
export async function resetAccount(id: string) {
  return (await call<{ invite: { id: string; url: string; expiresAt: number } }>(`/auth/admin/accounts/${encodeURIComponent(id)}/reset`, { method: "POST", body: "{}" })).invite;
}
export async function deleteAccount(id: string) {
  await call(`/auth/admin/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** 「3 天后过期」这类说明。 */
export function expiresText(at: number, now = Date.now()): string {
  const hours = Math.max(0, (at - now) / 3_600_000);
  if (hours < 1) return "不到 1 小时后过期";
  if (hours < 48) return `${Math.round(hours)} 小时后过期`;
  return `${Math.round(hours / 24)} 天后过期`;
}

export function lastSeenText(at: number | null, now = Date.now()): string {
  if (!at) return "还没登录过";
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 60) return "刚刚登录";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前登录`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前登录`;
  return `${Math.floor(seconds / 86400)} 天前登录`;
}
