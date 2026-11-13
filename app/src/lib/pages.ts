import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import type {
  PageAssetView,
  PageVersionView,
  PageView,
} from "../../../shared/pages";

/** 页面（DESIGN.md §54，docs/pages.md）：机器人做的单页网页，/p/<随机串>/ 公开可看。 */
export const pageKeys = {
  all: ["pages"] as const,
  one: (id: string) => ["pages", "one", id] as const,
  versions: (id: string) => ["pages", "versions", id] as const,
  assets: (id: string) => ["pages", "assets", id] as const,
};

/** 浏览器里的完整链接（服务器只知道路径；网关后面它看不到公网地址）。 */
export const pageUrl = (page: Pick<PageView, "path">) =>
  `${window.location.origin}${page.path}`;

export function pagesQueryOptions() {
  return queryOptions({
    queryKey: pageKeys.all,
    queryFn: ({ signal }): Promise<PageView[]> =>
      client("/api/pages", "pages", { fallback: "无法加载页面", signal }),
    refetchOnWindowFocus: "always",
  });
}

export function pageQueryOptions(id: string) {
  return queryOptions({
    queryKey: pageKeys.one(id),
    queryFn: ({ signal }): Promise<PageView> =>
      client(`/api/pages/${encodeURIComponent(id)}`, "page", {
        fallback: "无法读取页面",
        signal,
      }),
    enabled: Boolean(id),
    retry: 1,
  });
}

export function pageVersionsQueryOptions(id: string) {
  return queryOptions({
    queryKey: pageKeys.versions(id),
    queryFn: ({ signal }): Promise<PageVersionView[]> =>
      client(`/api/pages/${encodeURIComponent(id)}/versions`, "versions", {
        fallback: "无法读取版本",
        signal,
      }),
  });
}

export function pageAssetsQueryOptions(id: string) {
  return queryOptions({
    queryKey: pageKeys.assets(id),
    queryFn: ({ signal }): Promise<PageAssetView[]> =>
      client(`/api/pages/${encodeURIComponent(id)}/assets`, "assets", {
        fallback: "无法读取素材",
        signal,
      }),
  });
}

export function patchPage(
  id: string,
  body: { title?: string; description?: string | null; published?: boolean },
): Promise<PageView> {
  return client(`/api/pages/${encodeURIComponent(id)}`, "page", {
    method: "PATCH",
    body,
    fallback: "保存失败，请重试",
  });
}

export function restorePageVersion(
  id: string,
  version: number,
): Promise<PageView> {
  return client(`/api/pages/${encodeURIComponent(id)}/restore`, "page", {
    method: "POST",
    body: { version },
    fallback: "恢复失败，请重试",
  });
}

export async function deletePage(id: string) {
  await client(`/api/pages/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "删除失败，请重试",
  });
}

export async function undoDeletePage(id: string) {
  await client(`/api/pages/${encodeURIComponent(id)}/undo-delete`, {
    method: "POST",
    fallback: "撤销失败",
  });
}

export async function uploadPageAsset(id: string, file: File): Promise<string> {
  const response = await tryClient(
    `/api/pages/${encodeURIComponent(id)}/assets?name=${encodeURIComponent(file.name)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: file,
      timeoutMs: 0,
    },
  );
  const body = (await response.json().catch(() => null)) as {
    name?: string;
    error?: string;
  } | null;
  if (!response.ok) throw new Error(body?.error ?? "上传失败，请重试");
  return body?.name ?? file.name;
}

export async function deletePageAsset(id: string, name: string) {
  await client(
    `/api/pages/${encodeURIComponent(id)}/assets/${encodeURIComponent(name)}`,
    { method: "DELETE", fallback: "删除失败" },
  );
}

/** 告诉服务器这个人从哪个地址打开 ChisaBot，机器人回复里就能给完整链接（每次打开报一次）。 */
let originReported = false;
export function reportPageOrigin() {
  if (originReported || typeof window === "undefined") return;
  originReported = true;
  void tryClient("/api/pages/origin", {
    method: "PUT",
    body: { origin: window.location.origin },
  }).catch(() => {
    originReported = false;
  });
}

/** 工具结果里的 ⟦page:id⟧。 */
export const pageIdFromResult = (result: string | undefined) =>
  result?.match(/(?:⟦|\\u27e6)page:(pg_[a-z0-9]+)/i)?.[1] ?? null;
