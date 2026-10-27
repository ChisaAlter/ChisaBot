import { queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  AVATAR_SIZE,
  type AvatarColor,
  type AvatarShape,
  type BotAvatar,
  MAX_AVATAR_BYTES,
  SHAPE_COLORS,
  type ShapeColor,
} from "../../../../shared/bot-avatars";
import { client } from "@/lib/client";

export type { AvatarColor, AvatarShape, BotAvatar, ShapeColor };
export { AVATAR_COLORS, AVATAR_SHAPES, SHAPE_COLORS };

/**
 * 机器人头像（DESIGN.md §81）。一次读回你能看到的所有机器人的头像（`/api/bot-avatars`），左栏、聊天、资料页、
 * 机器人列表共用这一份缓存。没有条目 = 默认花纹头像。
 */
export const avatarKeys = { all: ["bot-avatars"] as const };

export function botAvatarsQueryOptions() {
  return queryOptions({
    queryKey: avatarKeys.all,
    queryFn: () =>
      client<Record<string, BotAvatar>>("/api/bot-avatars", "avatars", { fallback: "无法加载头像" }),
    staleTime: 5 * 60_000,
    // 旧服务器没有这个接口：当作「都用默认头像」，不报错不重试。
    retry: false,
  });
}

/** 表单里还没保存的头像改动。 */
export type AvatarDraft =
  | { kind: "keep" }
  | { kind: "default" }
  | { kind: "emoji"; emoji: string; color: AvatarColor }
  | { kind: "monogram"; color: AvatarColor }
  | { kind: "shape"; shape: AvatarShape; color: ShapeColor }
  | { kind: "image"; blob: Blob; previewUrl: string };

/** 把表单里的头像改动写到服务器；keep 什么都不做。 */
export async function saveAvatarDraft(queryClient: QueryClient, agentId: string, draft: AvatarDraft): Promise<void> {
  const path = `/api/bot-avatars/${encodeURIComponent(agentId)}`;
  const fallback = "头像没能保存";
  if (draft.kind === "keep") return;
  if (draft.kind === "default") await client(path, { method: "DELETE", fallback });
  else if (draft.kind === "image") {
    const response = await fetch(`${path}/image`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": draft.blob.type || "application/octet-stream" },
      body: draft.blob,
    });
    if (!response.ok) {
      const message = await response.json().then((b: { error?: string }) => b.error).catch(() => undefined);
      throw new Error(message ?? fallback);
    }
  } else await client(path, { method: "PUT", body: draft, fallback });
  await queryClient.invalidateQueries({ queryKey: avatarKeys.all });
}

/** 新建时的默认头像：名字首字 + 一种底色（按名字挑，打开表单时就能看到，建好后和看到的一样）。 */
export function colorFor(text: string): AvatarColor {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export const AVATAR_EMOJIS = [
  "🤖", "🐱", "🐶", "🦊", "🐼", "🐧", "🦉", "🐳",
  "🌸", "🌿", "☀️", "🌙", "⭐", "🔥", "💡", "🎯",
  "📚", "✍️", "💼", "📈", "🧮", "🧑‍💻", "🛠️", "🔍",
  "🎨", "🎵", "🍳", "☕", "✈️", "🏃", "🩺", "❤️",
] as const;

export const ACCEPTED_AVATAR_TYPES = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,image/heic,image/heif";
export const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/**
 * 把取景框里的那块正方形画成 256×256，压成 WebP（不支持就 JPEG），保证 ≤ 256 KB。
 * `crop` 是原图像素坐标里的正方形。
 */
export async function renderAvatar(
  image: CanvasImageSource,
  crop: { x: number; y: number; size: number },
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("这台设备不能处理图片。");
  context.imageSmoothingQuality = "high";
  // 透明 PNG 在圆形里会露出底色：先铺白。
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const encode = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  for (const quality of [0.86, 0.75, 0.6, 0.45]) {
    let blob = await encode("image/webp", quality);
    if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg", quality);
    if (blob && blob.size <= MAX_AVATAR_BYTES) return blob;
  }
  throw new Error("图片压缩后还是太大，请换一张。");
}

/** 读一张本地图片；不是图片、太大、读不出来都说人话。 */
export async function loadAvatarSource(file: File): Promise<{ image: HTMLImageElement; url: string }> {
  if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(file.name))
    throw new Error("请选一张图片（PNG、JPEG、WebP 等）。");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("图片超过 15 MB，请换一张小一点的。");
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("这张图片打不开（可能是这台设备不支持的格式），请换一张 PNG 或 JPEG。");
  }
  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(url);
    throw new Error("这张图片打不开，请换一张。");
  }
  return { image, url };
}
