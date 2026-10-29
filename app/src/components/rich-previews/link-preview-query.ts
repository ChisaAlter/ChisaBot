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
};

export class PreviewMissing extends Error {}

/**
 * 预览自己的查询缓存：不依赖页面上有没有 QueryClientProvider（频道记录、json-render 面板、测试都能直接用），
 * 也不和应用的其它查询混在一起。用的时候把它作为 `useQuery` 的第二个参数传进去。
 */
export const previewClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

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
