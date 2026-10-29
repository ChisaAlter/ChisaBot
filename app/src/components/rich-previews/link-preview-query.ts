import { QueryClient } from "@tanstack/react-query";

/**
 * `GET /api/link-preview` 的前端一侧（从 rich-previews.tsx 拆出来，2026-10-29）：
 * 链接卡（正文里单独一行的链接、json-render 的 Link）和商品网格的预览图共用同一个查询缓存。
 */

export type LinkPreviewData = {
  url: string;
  finalUrl: string;
  title: string;
  siteName: string;
  domain: string;
  description: string;
  image: string | null;
  imageKind: "og" | "shot" | "direct" | "none";
  imagePending: boolean;
  favicon: string | null;
  /** 网页没取到（被拦 / 超时 / 不是网页）：只有域名和站点图标的兜底卡。 */
  degraded?: boolean;
  /** `image` 的像素宽高（DESIGN.md §83.2）；旧服务器 / 读不出时没有。 */
  imageWidth?: number;
  imageHeight?: number;
  /** 视频链接（服务器以后会加，开发3 在做）：前端只用来叠播放角标，没有也行。 */
  kind?: "video" | (string & {});
  /** 视频缩略图（同上）。 */
  thumbnail?: string | null;
};

export class PreviewMissing extends Error {}

/**
 * 预览自己的查询缓存：不依赖页面上有没有 QueryClientProvider（频道记录、json-render 面板、测试都能直接用），
 * 也不和应用的其它查询混在一起。用的时候把它作为 `useQuery` 的第二个参数传进去。
 */
export const previewClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

/**
 * 这个标签页里取到过的预览（sessionStorage，审查模块 6 第 7 条）：刷新页面后链接卡先同步画成真卡，
 * 不先放骨架、预览回来再换（骨架是图片卡的高度，真卡可能是紧凑卡，换的时候整列消息会跳，桌面刷新 CLS 0.049）。
 * - 只存成功、图不在路上的；最多 {@link REMEMBER_MAX} 条、{@link REMEMBER_MS} 内有效，超了丢最旧的。
 * - 用 sessionStorage 不用 localStorage：只活到标签页关掉，聊天里出现过哪些链接不长期留在这台电脑上。
 * - 拿出来的当作「当时取到的」（initialDataUpdatedAt），过了 staleTime 照常在后台再取一次。
 */
const REMEMBER_KEY = "chisabot.link-previews.v1";
const REMEMBER_MAX = 80;
const REMEMBER_MS = 6 * 60 * 60_000;
type Remembered = Record<string, { at: number; data: LinkPreviewData }>;

function readRemembered(): Remembered {
  try {
    const raw = globalThis.sessionStorage?.getItem(REMEMBER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Remembered) : {};
  } catch {
    return {};
  }
}

let remembered: Remembered | null = null;

function rememberedAll(): Remembered {
  if (!remembered) remembered = readRemembered();
  return remembered;
}

export function rememberPreview(url: string, data: LinkPreviewData) {
  if (data.imagePending) return;
  try {
    const all = rememberedAll();
    all[url] = { at: Date.now(), data };
    const keys = Object.keys(all).sort(
      (a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0),
    );
    for (const k of keys.slice(0, Math.max(0, keys.length - REMEMBER_MAX)))
      delete all[k];
    globalThis.sessionStorage?.setItem(REMEMBER_KEY, JSON.stringify(all));
  } catch {
    // 存不下（隐私模式 / 满了）就算了，只是刷新后多放一次骨架。
  }
}

/** 给 useQuery 的 initialData：这个标签页里取到过就同步返回，没有就是空对象。 */
export function rememberedPreview(url: string): {
  initialData?: LinkPreviewData;
  initialDataUpdatedAt?: number;
} {
  const hit = rememberedAll()[url];
  if (
    !hit ||
    Date.now() - hit.at > REMEMBER_MS ||
    typeof hit.data?.title !== "string"
  )
    return {};
  return { initialData: hit.data, initialDataUpdatedAt: hit.at };
}

/** 测试用：清掉内存里的那份（sessionStorage 由测试自己清）。 */
export function forgetRememberedPreviews() {
  remembered = null;
}

async function fetchPreview(url: string): Promise<LinkPreviewData> {
  const response = await fetch(
    `/api/link-preview?url=${encodeURIComponent(url)}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new PreviewMissing(String(response.status));
  const body = (await response.json().catch(() => null)) as {
    preview?: LinkPreviewData;
  } | null;
  if (!body?.preview || typeof body.preview.title !== "string")
    throw new PreviewMissing("bad body");
  rememberPreview(url, body.preview);
  return body.preview;
}

export function previewQuery(url: string) {
  return {
    queryKey: ["link-preview", url] as const,
    queryFn: () => fetchPreview(url),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    retry: (failures: number, error: unknown) =>
      !(error instanceof PreviewMissing) && failures < 1,
    refetchOnWindowFocus: false,
    // 截图在服务器后台做：先拿到标题，图还在路上时每 2.5 秒问一次，最多约 30 秒。
    refetchInterval: (query: {
      state: { data?: LinkPreviewData; dataUpdateCount: number };
    }) =>
      query.state.data?.imagePending && query.state.dataUpdateCount < 12
        ? 2500
        : false,
  };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
