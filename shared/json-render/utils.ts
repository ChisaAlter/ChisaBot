/**
 * 生成式界面（json-render）无 Zod 依赖的纯工具函数，服务端与浏览器共用。
 *
 * 与 `catalog.ts` 分离，避免仅需图片地址校验或语义色归一的模块（如 `rich-utils.ts`）把完整 Zod 和
 * `@json-render/core` 拉入外壳块或非对话路由。
 */

export const TONES = [
  "default",
  "accent",
  "info",
  "success",
  "warn",
  "danger",
] as const;

export type Tone = (typeof TONES)[number];

const TONE_ALIASES: Record<string, Tone> = {
  brand: "accent",
  primary: "accent",
  blue: "accent",
  sky: "accent",
  good: "success",
  ok: "success",
  positive: "success",
  green: "success",
  up: "success",
  warning: "warn",
  amber: "warn",
  yellow: "warn",
  orange: "warn",
  caution: "warn",
  bad: "danger",
  error: "danger",
  negative: "danger",
  red: "danger",
  down: "danger",
  critical: "danger",
  neutral: "default",
  muted: "default",
  gray: "default",
  grey: "default",
  none: "default",
  cyan: "info",
  teal: "info",
  purple: "info",
};

/** 任意写法 → 六种语义色之一。 */
export function normaliseTone(value: unknown): Tone {
  if (typeof value !== "string") return "default";
  const key = value.trim().toLowerCase();
  if ((TONES as readonly string[]).includes(key)) return key as Tone;
  return TONE_ALIASES[key] ?? "default";
}

const LOCAL_CHAT_IMAGE_RE =
  /^\/api\/(?:chat-files\/|channels\/[^/?#]+\/attachments\/)[A-Za-z0-9._-]+(?:\?w=\d+)?$/;

/** 放行外部 https:// 图片与本站受控聊天附件/文件图片路径（拒绝 //、..、http://、data:）。 */
export function isSafeRenderImageSrc(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.includes(".."))
    return false;
  if (/^https:\/\//i.test(trimmed)) return true;
  return LOCAL_CHAT_IMAGE_RE.test(trimmed);
}
