/**
 * 跨端主动通知、提示音、深链与 Bark 端点解析共享协议。
 * 前后端共用，不依赖 Node 或浏览器私有全局。
 */

export const NOTIFICATION_FREQUENCIES = [
  "every-reply",
  "task-complete",
  "muted",
] as const;

export type NotificationFrequency = (typeof NOTIFICATION_FREQUENCIES)[number];

export const DEFAULT_NOTIFICATION_FREQUENCY: NotificationFrequency =
  "every-reply";

export const NOTIFICATION_FREQUENCY_OPTIONS: readonly {
  id: NotificationFrequency;
  label: string;
  description: string;
}[] = [
  {
    id: "every-reply",
    label: "每条回复",
    description: "非当前前台会话收到 AI 回复、任务完成或审批请求时均提醒。",
  },
  {
    id: "task-complete",
    label: "仅任务完成",
    description:
      "仅在后台任务完成或需要审批/回答时提醒，减少日常多轮对话打扰。",
  },
  {
    id: "muted",
    label: "静音",
    description: "关闭桌面弹窗、提示音与移动推送通知。",
  },
];

export const NOTIFICATION_SOUNDS = [
  "none",
  "soft-blip",
  "chime",
  "bell",
  "drop",
  "pulse",
] as const;

export type NotificationSoundId = (typeof NOTIFICATION_SOUNDS)[number];

export const DEFAULT_NOTIFICATION_SOUND: NotificationSoundId = "soft-blip";

export const NOTIFICATION_SOUND_OPTIONS: readonly {
  id: NotificationSoundId;
  label: string;
  description: string;
}[] = [
  { id: "none", label: "静音", description: "不播放提示音" },
  { id: "soft-blip", label: "柔滴", description: "轻盈柔和的单音上滑" },
  { id: "chime", label: "风铃", description: "温暖的双音五度和弦" },
  { id: "bell", label: "轻铃", description: "清脆克制的泛音铃声" },
  { id: "drop", label: "水滴", description: "短促清亮的水滴音效" },
  { id: "pulse", label: "双轻敲", description: "两声轻柔的节奏轻敲" },
];

export type NotificationKind = "reply" | "task-complete" | "needs-input";

export type ShouldNotifyReplyInput = {
  frequency: NotificationFrequency;
  kind: NotificationKind;
  /** 用户当前是否正通过活连接查看该 channelId 且心跳未过期。 */
  channelForeground: boolean;
};

/**
 * 判定一条回复/任务/审批事件是否应触发主动通知或移动推送。
 *
 * 规则：
 * 1. `muted` 彻底静音；
 * 2. `needs-input`（审批/提问）始终穿透 `task-complete` 与普通回复前台抑制；
 * 3. `channelForeground === true` 时抑制普通回复（`reply` / `task-complete`）弹窗与推送，
 *    避免用户正盯着当前会话聊天时被自己正在看的回复反复打断，同时绝不影响其他频道的通知。
 */
export function shouldNotifyReply(input: ShouldNotifyReplyInput): boolean {
  if (input.frequency === "muted") return false;
  if (input.kind === "needs-input") return true;
  if (input.channelForeground) return false;
  if (input.frequency === "task-complete") {
    return input.kind === "task-complete";
  }
  return true;
}

export function isNotificationFrequency(
  value: unknown,
): value is NotificationFrequency {
  return (
    typeof value === "string" &&
    (NOTIFICATION_FREQUENCIES as readonly string[]).includes(value)
  );
}

export function isNotificationSoundId(
  value: unknown,
): value is NotificationSoundId {
  return (
    typeof value === "string" &&
    (NOTIFICATION_SOUNDS as readonly string[]).includes(value)
  );
}

/** 字素安全截断通知正文（保留 Emoji 组合序列与中文，不截断代理对）。 */
export function truncateNotificationText(
  raw: string,
  maxGraphemes = 140,
): string {
  const normalized = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || maxGraphemes <= 0) return "";
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    const segments: string[] = [];
    for (const part of segmenter.segment(normalized)) {
      segments.push(part.segment);
      if (segments.length > maxGraphemes) break;
    }
    if (segments.length <= maxGraphemes) return normalized;
    if (maxGraphemes === 1) return "…";
    return `${segments.slice(0, maxGraphemes - 1).join("")}…`;
  }
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxGraphemes) return normalized;
  if (maxGraphemes === 1) return "…";
  return `${codePoints.slice(0, maxGraphemes - 1).join("")}…`;
}

const SAFE_ENTITY_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const BARK_KEY_RE = /^[A-Za-z0-9_-]{8,256}$/;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type ChisaDeepLink =
  | { kind: "agent"; agentId: string }
  | { kind: "channel"; channelId: string; agentId?: string }
  | { kind: "pair"; raw: string; server: string; code: string };

export function buildAgentDeepLink(agentId: string): string {
  const clean = agentId.trim();
  if (!SAFE_ENTITY_ID_RE.test(clean)) {
    throw new Error("无效的 Bot ID，无法构造深链。");
  }
  return `chisabot://agent/${encodeURIComponent(clean)}`;
}

export function buildChannelDeepLink(
  channelId: string,
  agentId?: string,
): string {
  const cleanChannel = channelId.trim();
  if (!SAFE_ENTITY_ID_RE.test(cleanChannel)) {
    throw new Error("无效的频道 ID，无法构造深链。");
  }
  const base = `chisabot://channel/${encodeURIComponent(cleanChannel)}`;
  const cleanAgent = agentId?.trim();
  if (cleanAgent && SAFE_ENTITY_ID_RE.test(cleanAgent)) {
    return `${base}?agent=${encodeURIComponent(cleanAgent)}`;
  }
  return base;
}

/**
 * 解析 ChisaBot 自定义协议深链：
 * - `chisabot://agent/<id>`
 * - `chisabot://channel/<id>[?agent=<id>]`
 * - `chisabot://pair?server=<origin>&code=<code...>`（兼容既有扫码绑定协议）
 */
export function parseChisaDeepLink(raw: string): ChisaDeepLink | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || hasControlChars(trimmed)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== "chisabot:") return null;
  if (url.username || url.password || url.hash) return null;

  const host = url.hostname.toLowerCase();
  if (host === "pair") {
    const server = url.searchParams.get("server")?.trim() ?? "";
    const code = url.searchParams.get("code")?.trim() ?? "";
    if (!server || !code) return null;
    return { kind: "pair", raw: trimmed, server, code };
  }

  const rawSegments = url.pathname.split("/").filter(Boolean);
  if (rawSegments.length !== 1) return null;
  const firstSegment = rawSegments[0];
  if (!firstSegment) return null;

  let decodedId: string;
  try {
    decodedId = decodeURIComponent(firstSegment);
  } catch {
    return null;
  }
  if (
    !SAFE_ENTITY_ID_RE.test(decodedId) ||
    decodedId === "." ||
    decodedId === ".."
  ) {
    return null;
  }

  if (host === "agent") {
    if (url.search) return null;
    return { kind: "agent", agentId: decodedId };
  }

  if (host === "channel") {
    const agentParam = url.searchParams.get("agent")?.trim();
    if (agentParam !== undefined && agentParam !== "") {
      if (!SAFE_ENTITY_ID_RE.test(agentParam)) return null;
      return { kind: "channel", channelId: decodedId, agentId: agentParam };
    }
    return { kind: "channel", channelId: decodedId };
  }

  return null;
}

/** 将已解析的导航深链转换为应用内相对路由路径。 */
export function deepLinkToAppPath(link: ChisaDeepLink): string | null {
  if (link.kind === "channel") {
    return `/channel/${encodeURIComponent(link.channelId)}`;
  }
  if (link.kind === "agent") {
    return `/channel/new?agent=${encodeURIComponent(link.agentId)}`;
  }
  return null;
}

/** 从应用内路径提取当前精确激活的 channelId（排除 `/channel/new`）。 */
export function activeChannelIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith("/channel/")) return null;
  const rest = pathname.slice("/channel/".length).split("/")[0] ?? "";
  if (!rest || rest === "new") return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

export type BarkEndpoint = {
  /** 规范化的 Bark 服务基址（无尾部斜杠，如 `https://api.day.app` 或含自定义子路径）。 */
  serverUrl: string;
  deviceKey: string;
};

function extractDeviceKeyFromCurlBody(raw: string): string | null {
  const jsonMatch = raw.match(/"device_key"\s*:\s*"([A-Za-z0-9_-]{8,256})"/);
  if (jsonMatch?.[1]) return jsonMatch[1];
  const singleQuoteJson = raw.match(
    /'device_key'\s*:\s*'([A-Za-z0-9_-]{8,256})'/,
  );
  if (singleQuoteJson?.[1]) return singleQuoteJson[1];
  const formMatch = raw.match(
    /(?:^|[&?\s"'`])device_key=([A-Za-z0-9_-]{8,256})/,
  );
  if (formMatch?.[1]) return formMatch[1];
  return null;
}

/**
 * 从 Bark App 复制的 `curl` 示例命令或完整推送 URL 中安全提取 `{ serverUrl, deviceKey }`。
 * 纯字符串解析，绝不执行命令；拒绝含账号密码或片段的 URL。
 */
export function extractBarkEndpointFromCurl(raw: string): BarkEndpoint | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096) return null;

  const urlMatches = trimmed.match(/https?:\/\/[^\s"'<>`\\]+/gi);
  if (!urlMatches || urlMatches.length === 0) return null;

  for (const candidate of urlMatches) {
    const cleanedCandidate = candidate.replace(/[),;]+$/, "");
    let url: URL;
    try {
      url = new URL(cleanedCandidate);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.username || url.password || url.hash) return null;

    let segments: string[];
    try {
      segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return null;
    }

    const queryKey = url.searchParams.get("device_key")?.trim() ?? "";
    const bodyKey = extractDeviceKeyFromCurlBody(trimmed) ?? "";

    // 形式 1: https://host[/prefix]/push?device_key=KEY 或 curl -X POST https://host[/prefix]/push -d '{"device_key":"KEY"}'
    if (queryKey || bodyKey) {
      const key = queryKey || bodyKey;
      if (!BARK_KEY_RE.test(key)) return null;
      const prefix = url.pathname
        .replace(/\/push\/?$/i, "")
        .replace(/\/+$/, "");
      return {
        serverUrl: `${url.origin}${prefix}`,
        deviceKey: key,
      };
    }

    // 形式 2: https://api.day.app/<deviceKey>[/title][/body]
    const first = segments[0];
    if (first && first.toLowerCase() !== "push" && BARK_KEY_RE.test(first)) {
      return {
        serverUrl: url.origin,
        deviceKey: first,
      };
    }
  }

  return null;
}

export type PushProvider = "bark" | "fcm" | "apns";
export type PushPlatform = "ios" | "android";

export type PushDeviceView = {
  id: string;
  platform: PushPlatform;
  provider: PushProvider;
  label: string;
  host: string | null;
  enabled: boolean;
  createdAt: string;
};

export type ReplyNotificationEvent = {
  id: string;
  kind: NotificationKind;
  channelId: string;
  agentId: string;
  agentName: string;
  preview: string;
  deepLink: string;
  createdAt: string;
};
