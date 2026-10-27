/**
 * 机器人头像（DESIGN.md §81，docs/bot-avatars.md）——网页、PC、Android 共用的约定。
 *
 * 三种：
 * - image：上传的图片。浏览器先裁成正方形（用户看到的是圆形取景框）、压成 256×256 WebP/JPEG，再上传；
 *   服务器只收 PNG / JPEG / WebP、≤ MAX_AVATAR_BYTES。网址 `/api/bot-avatars/<id>/image?v=<version>`。
 * - emoji：一个表情 + 一种底色。
 * - monogram：名字的第一个字 + 一种底色（改名后跟着变）。
 * 没设置（null）= 以前的花纹头像（boring-avatars，按机器人 id 生成），老机器人看起来不变。
 * 显示一律是圆形。
 */
export const MAX_AVATAR_BYTES = 256 * 1024;
export const AVATAR_SIZE = 256;
export const AVATAR_MIMES = ["image/webp", "image/jpeg", "image/png"] as const;
export type AvatarMime = (typeof AVATAR_MIMES)[number];

/** 底色：键名存库，颜色只在前端（深浅色各一套也不用改库）。 */
export const AVATAR_COLORS = ["sky", "ocean", "mint", "lime", "amber", "coral", "rose", "violet", "slate"] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

/**
 * shape：一个有表情的小形象（形状 + 颜色，眼睛固定在形状里）。形状不是圆的，所以显示时不裁成圆；
 * 被选中、机器人在跑、做完一轮时会变表情（只在前端画，库里只存形状和颜色的键名）。
 * 旧客户端不认识这个类型时退回默认花纹，不会崩。
 */
export const AVATAR_SHAPES = [
  "round", "cloud", "tile", "sparkle", "bloom", "bean", "scallop",
  "drop", "pill", "tri", "hex", "burst", "gem", "fruit",
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

/** 形象的底色（和上面圆形头像的 AVATAR_COLORS 是两套；颜色值只在前端）。 */
export const SHAPE_COLORS = ["ink", "brown", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink", "gray"] as const;
export type ShapeColor = (typeof SHAPE_COLORS)[number];

export const isAvatarShape = (value: unknown): value is AvatarShape =>
  typeof value === "string" && (AVATAR_SHAPES as readonly string[]).includes(value);
export const isShapeColor = (value: unknown): value is ShapeColor =>
  typeof value === "string" && (SHAPE_COLORS as readonly string[]).includes(value);

export type BotAvatar =
  | { kind: "image"; url: string; version: string }
  | { kind: "emoji"; emoji: string; color: AvatarColor }
  | { kind: "monogram"; color: AvatarColor }
  | { kind: "shape"; shape: AvatarShape; color: ShapeColor };

/** PUT /api/bot-avatars/<id> 的 JSON（图片走 PUT …/image，原始字节）。 */
export type BotAvatarPreset =
  | { kind: "emoji"; emoji: string; color: AvatarColor }
  | { kind: "monogram"; color: AvatarColor }
  | { kind: "shape"; shape: AvatarShape; color: ShapeColor };

export const isAvatarColor = (value: unknown): value is AvatarColor =>
  typeof value === "string" && (AVATAR_COLORS as readonly string[]).includes(value);

/** 一个「表情」：1–16 个字符、没有空白和控制字符、没有字母数字（不让它变成一段文字）。 */
export function isAvatarEmoji(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || text.length > 16 || text !== value) return false;
  if (/[\p{Cc}]/u.test(text) || /\s/u.test(text)) return false;
  if (/[\p{L}\p{N}]/u.test(text.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ""))) return false;
  return /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u.test(text);
}

/** 图片类型看文件头，不信 content-type。 */
export function sniffAvatarMime(bytes: Uint8Array): AvatarMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** 名字的第一个字（汉字、字母、表情都算一个）。 */
export function monogramOf(name: string): string {
  const first = Array.from(name.trim())[0] ?? "";
  return /[a-z]/.test(first) ? first.toUpperCase() : first || "?";
}

export const botAvatarImageUrl = (agentId: string, version: string) =>
  `/api/bot-avatars/${encodeURIComponent(agentId)}/image?v=${encodeURIComponent(version)}`;
