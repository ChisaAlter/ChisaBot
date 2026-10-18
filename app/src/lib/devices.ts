import { queryOptions } from "@tanstack/react-query";
import type {
  DeviceApprovalView,
  DeviceAuditEntry,
  DeviceCapabilities,
  DeviceView,
} from "../../../shared/devices";
import { client } from "@/lib/client";

/**
 * PC 设备（docs/pc-node.md）。列表每 5 秒刷新一次，这样在线状态和待审批几乎是实时的，
 * 不需要另开一条推送通道。
 */

export const deviceKeys = {
  all: ["devices"] as const,
  list: (all: boolean) => ["devices", "list", all] as const,
  detail: (id: string) => ["devices", "detail", id] as const,
  audit: (id: string) => ["devices", "audit", id] as const,
  activity: (id: string) => ["devices", "activity", id] as const,
  download: ["devices", "download"] as const,
};

export type DeviceList = { devices: DeviceView[]; approvals: DeviceApprovalView[] };

export function deviceListQueryOptions(all = false) {
  return queryOptions({
    queryKey: deviceKeys.list(all),
    queryFn: ({ signal }): Promise<DeviceList> =>
      client(`/api/devices${all ? "?all=1" : ""}`, { fallback: "无法加载设备列表", signal }).then((r) => r.json()),
    refetchInterval: 5_000,
    refetchOnWindowFocus: "always",
  });
}

export function deviceQueryOptions(id: string) {
  return queryOptions({
    queryKey: deviceKeys.detail(id),
    queryFn: ({ signal }): Promise<DeviceView> =>
      client(`/api/devices/${encodeURIComponent(id)}`, "device", { fallback: "无法加载这台设备", signal }),
    refetchInterval: 5_000,
  });
}

export function deviceAuditQueryOptions(id: string) {
  return queryOptions({
    queryKey: deviceKeys.audit(id),
    queryFn: ({ signal }): Promise<DeviceAuditEntry[]> =>
      client(`/api/devices/${encodeURIComponent(id)}/audit?limit=100`, "entries", { fallback: "无法加载操作记录", signal }),
    refetchInterval: 8_000,
  });
}

export type DevicePatch = {
  name?: string;
  capabilities?: Partial<DeviceCapabilities>;
  allowedRoots?: string[];
  paused?: boolean;
  /** 已不起作用（设备由账号下所有机器人共用），只为兼容旧接口保留。 */
  botIds?: string[];
  /** 完全访问（docs/pc-node.md §13）：只有设备主人能在这里打开。 */
  fullAccess?: "1h" | "24h" | "permanent" | "off";
};

/** 电脑 / 服务器 / 手机：手机看平台；服务器 = chisabot-node（客户端版本带 -node）；其余是 PC 客户端。 */
export type DeviceKind = "pc" | "server" | "phone";
export function deviceKind(device: Pick<DeviceView, "platform" | "clientVersion">): DeviceKind {
  if (device.platform === "android" || device.platform === "ios") return "phone";
  if (device.clientVersion?.endsWith("-node") || device.clientVersion?.endsWith("-cli")) return "server";
  return "pc";
}
export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = { pc: "电脑", server: "服务器", phone: "手机" };

/** 「到 10月15日 14:20」/「永久」。 */
export function fullAccessUntilText(until: string | null | undefined) {
  if (!until) return "";
  if (until.startsWith("9999")) return "永久（直到手动关闭）";
  const date = new Date(until);
  return `到 ${date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export type DeviceJob = {
  jobId: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed" | "timeout";
  exitCode: number | string | null;
  startedAt: string;
  endedAt: string | null;
  runningSec: number;
  outputBytes: number;
  botName: string | null;
  elevated: boolean;
  lastLine: string;
};
export type DeviceActivity = {
  live: { jobs: DeviceJob[]; sessions: Array<{ name: string; cwd: string; commands: number }>; elevatedHelper: { startedAt: string } | null; shell: string; git: boolean } | null;
  liveError: string | null;
  edits: DeviceAuditEntry[];
};

export function deviceActivityQueryOptions(id: string, enabled = true) {
  return queryOptions({
    queryKey: deviceKeys.activity(id),
    queryFn: ({ signal }): Promise<DeviceActivity> =>
      client(`/api/devices/${encodeURIComponent(id)}/activity`, { fallback: "无法读取运行中的命令", signal }).then((r) => r.json()),
    refetchInterval: 3_000,
    enabled,
  });
}

export async function killDeviceJob(id: string, jobId: string) {
  await client(`/api/devices/${encodeURIComponent(id)}/jobs/${encodeURIComponent(jobId)}/kill`, { method: "POST", fallback: "结束失败" });
}

export function patchDevice(id: string, patch: DevicePatch): Promise<DeviceView> {
  return client(`/api/devices/${encodeURIComponent(id)}`, "device", {
    method: "PATCH",
    body: patch,
    fallback: "保存失败，请重试",
  });
}

export async function revokeDevice(id: string) {
  await client(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: "POST", fallback: "撤销失败，请重试" });
}

export async function deleteDevice(id: string) {
  await client(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE", fallback: "删除失败，请重试" });
}

export async function testDevice(id: string): Promise<Record<string, unknown>> {
  const response = await client(`/api/devices/${encodeURIComponent(id)}/test`, {
    method: "POST",
    fallback: "测试连接失败",
  });
  return (await response.json()).result ?? {};
}

export async function decideApproval(id: string, decision: "approve" | "deny") {
  await client(`/api/devices/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: { decision },
    fallback: "这个审批已经处理过或已过期",
  });
}

/** 网关上托管的 PC 客户端安装包清单（/downloads/pc/latest.json）。不存在时为 null。 */
export type PcDownload = {
  version: string;
  publishedAt?: string;
  files: Array<{ kind: "installer" | "portable"; name: string; url: string; bytes: number; sha256?: string }>;
};

export function pcDownloadQueryOptions() {
  return queryOptions({
    queryKey: deviceKeys.download,
    queryFn: async (): Promise<PcDownload | null> => {
      const response = await fetch("/downloads/pc/latest.json", { credentials: "include" });
      if (!response.ok) return null;
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("json")) return null;
      return response.json();
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function platformLabel(platform: string) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "android") return "Android";
  if (platform === "ios") return "iOS";
  return platform || "未知系统";
}

export function bytesText(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 「刚刚 / 3 分钟前 / 昨天 14:20」。 */
export function seenText(at: string | null, online: boolean) {
  if (online) return "在线";
  if (!at) return "从未连接";
  const ms = Date.now() - Date.parse(at);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "刚刚在线";
  if (minutes < 60) return `${minutes} 分钟前在线`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前在线`;
  return `${new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} 在线`;
}

function relative(at: string) {
  const ms = Date.now() - Date.parse(at);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 「关联于 10月12日」（跨年时带年份）。 */
export function linkedText(at: string) {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return `关联于 ${date.toLocaleDateString("zh-CN", sameYear ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" })}`;
}

/** 「助手 · 3 分钟前」：最近一次使用这台设备的机器人。 */
export function lastUsedText(use: { botName: string | null; at: string }) {
  return `${use.botName ?? "机器人"} · ${relative(use.at)}`;
}

export const OUTCOME_LABEL: Record<string, { text: string; tone: "ok" | "warn" | "danger" | "muted" }> = {
  succeeded: { text: "成功", tone: "ok" },
  requested: { text: "进行中", tone: "muted" },
  failed: { text: "失败", tone: "danger" },
  refused: { text: "已拒绝", tone: "warn" },
  denied: { text: "用户拒绝", tone: "warn" },
  expired: { text: "审批超时", tone: "warn" },
  offline: { text: "设备离线", tone: "muted" },
  timeout: { text: "超时", tone: "danger" },
  approved_local: { text: "PC 上批准", tone: "ok" },
  denied_local: { text: "PC 上拒绝", tone: "warn" },
};

export const ACTION_LABEL: Record<string, string> = {
  enrolled: "登记设备",
  revoked: "撤销设备",
  unenrolled: "PC 上退出登录",
  config_changed: "修改设置",
  kill_switch_on: "紧急停止",
  kill_switch_off: "解除紧急停止",
  full_access_on: "开启完全访问",
  full_access_off: "关闭完全访问",
  full_access_expired: "完全访问到期",
  full_access_accepted: "本机同意完全访问",
  full_access_declined: "本机拒绝完全访问",
  edit_file: "修改文件",
  apply_patch: "应用补丁",
  search: "搜索文件",
  git: "git",
  exec_start: "后台命令",
  exec_kill: "结束命令",
  file_upload: "传文件到设备",
  file_download: "从设备取文件",
  list_files: "列出文件",
  read_file: "读取文件",
  write_file: "写入文件",
  shell: "运行命令",
  screenshot: "截屏",
  open: "打开",
  input: "输入",
  system_info: "系统信息",
};

// ---- 手机扫码绑定（DESIGN.md §33） ----

export type PairingTicket = { id: string; code: string; expiresAt: string; ttlSeconds: number; kind?: "phone" | "node" };
export type PairingStatus = {
  id: string;
  state: "pending" | "bound" | "expired" | "cancelled";
  expiresAt: string;
  device: { id: string; name: string } | null;
};

export function createPairing(kind: "phone" | "node" = "phone"): Promise<PairingTicket> {
  return client("/api/devices/pairing", {
    method: "POST",
    ...(kind === "node" ? { body: { kind } } : {}),
    fallback: kind === "node" ? "无法生成安装命令，请重试" : "无法生成二维码，请重试",
  }).then((r) => r.json());
}

/** 服务器节点一行安装命令（docs/pc-node.md §14）。 */
export function nodeInstallCommand(origin: string, code: string, options: { fullAccess: boolean; name?: string }) {
  const extra = `${options.fullAccess ? "" : " --no-full-access"}${options.name ? ` --name '${options.name.replace(/'/g, "")}'` : ""}`;
  return `curl -fsSL ${origin}/api/devices/agent/node/install.sh | sh -s -- --server ${origin} --code ${code}${extra}`;
}

export function pairingStatus(id: string, signal?: AbortSignal): Promise<PairingStatus> {
  return client(`/api/devices/pairing/${encodeURIComponent(id)}`, { fallback: "无法读取绑定状态", signal }).then((r) => r.json());
}

export async function cancelPairing(id: string) {
  await client(`/api/devices/pairing/${encodeURIComponent(id)}`, { method: "DELETE", fallback: "取消失败" }).catch(() => {});
}
