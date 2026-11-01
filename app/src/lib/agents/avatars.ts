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
import { client, tryClient } from "@/lib/client";

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
    queryFn: async () => {
      // 旧服务器没有这个接口（404）：当作「都用默认头像」。别的失败（500、断网）要报出来，
      // 让头像显示中性兜底而不是花纹（审查 10-3）。
      const response = await tryClient("/api/bot-avatars");
      if (response.status === 404) return {};
      if (!response.ok) throw new Error("无法加载头像");
      const body = (await response.json()) as { avatars?: Record<string, BotAvatar> };
      return body.avatars ?? {};
    },
    staleTime: 5 * 60_000,
    // 别的设备换了头像：切回这个窗口时，超过 staleTime 才重拉（审查 10-2；全局默认是关的，这里单独开）。
    // 同一浏览器的别的标签页不用等，靠下面的 BroadcastChannel 马上失效。
    refetchOnWindowFocus: true,
    // 不自动重试：过期后切回窗口时会再拉。
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
  announceAvatarChange(agentId);
}

/**
 * 跨标签页同步（审查 10-2）：这个标签页存了头像，同一浏览器里别的标签页马上重新拉头像，不等 5 分钟的 staleTime。
 * 别的设备靠上面的 refetchOnWindowFocus。BroadcastChannel 不可用（老 WebView）时什么都不做。
 */
const AVATAR_CHANNEL = "chisabot:bot-avatars";

function openAvatarChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(AVATAR_CHANNEL);
  } catch {
    return null;
  }
}

export function announceAvatarChange(agentId: string): void {
  const channel = openAvatarChannel();
  if (!channel) return;
  try {
    channel.postMessage({ type: "avatar-changed", agentId });
  } finally {
    channel.close();
  }
}

let syncUsers = 0;
let syncChannel: BroadcastChannel | null = null;

/** 订阅别的标签页的头像改动；返回退订。多处调用共用一个频道。 */
export function subscribeAvatarSync(queryClient: QueryClient): () => void {
  syncUsers += 1;
  if (syncUsers === 1) {
    syncChannel = openAvatarChannel();
    if (syncChannel)
      syncChannel.onmessage = (event: MessageEvent<{ type?: string }>) => {
        if (event.data?.type === "avatar-changed") void queryClient.invalidateQueries({ queryKey: avatarKeys.all });
      };
  }
  return () => {
    syncUsers -= 1;
    if (syncUsers === 0) {
      syncChannel?.close();
      syncChannel = null;
    }
  };
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

export const ACCEPTED_AVATAR_TYPES = "image/png,image/jpeg,image/webp,image/gif,image/bmp";
export const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
/** 给用户看的格式说明，和上面 accept、下面 loadAvatarSource 的放行范围一致（审查 10-6）。 */
export const ACCEPTED_AVATAR_HINT = "PNG / JPEG / WebP / GIF / BMP，最大 15 MB";
/** 小于这个边长的图存成 256×256 会发糊，给一句提示（审查 10-9），不拦。 */
export const SMALL_AVATAR_SOURCE = 128;

/** 图片太小时的提示；够大返回 null。 */
export function smallSourceHint(width: number, height: number): string | null {
  const side = Math.min(width, height);
  return side < SMALL_AVATAR_SOURCE ? `这张图只有 ${width}×${height}，放大成头像可能会糊；可以换一张更清晰的。` : null;
}

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
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const encode = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // 透明 PNG 保持透明（审查 10-8）：WebP 带 alpha。只有退到 JPEG（没有 alpha，透明处会变黑）时才垫白底。
  let flattened = false;
  for (const quality of [0.86, 0.75, 0.6, 0.45]) {
    let blob = await encode("image/webp", quality);
    if (!blob || blob.type !== "image/webp") {
      if (!flattened) {
        context.globalCompositeOperation = "destination-over";
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
        context.globalCompositeOperation = "source-over";
        flattened = true;
      }
      blob = await encode("image/jpeg", quality);
    }
    if (blob && blob.size <= MAX_AVATAR_BYTES) return blob;
  }
  throw new Error("图片压缩后还是太大，请换一张。");
}

/** 读一张本地图片；不是图片、太大、读不出来都说人话。 */
export async function loadAvatarSource(file: File): Promise<{ image: HTMLImageElement; url: string }> {
  // 只收 ACCEPTED_AVATAR_TYPES 里的格式（审查 10-6：以前 image/* 全放行，SVG 也进得来，和提示对不上）。
  const accepted = ACCEPTED_AVATAR_TYPES.split(",");
  const typeOk = file.type ? accepted.includes(file.type) : /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
  if (!typeOk) throw new Error(`请选一张图片（${ACCEPTED_AVATAR_HINT}）。`);
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
