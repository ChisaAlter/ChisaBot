import { IconExternalLink, IconWorld } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { memo, useState } from "react";
import type { PageView } from "../../../../shared/pages";
import { buttonVariants } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { pageQueryOptions, pageUrl } from "@/lib/pages";

/**
 * 页面缩略图（DESIGN.md §54）：把真页面放进一个缩小的沙箱 iframe（不交互、不抢焦点、懒加载）。
 * `scale` 决定页面按多宽来排版：容器宽 / scale。加载完才淡入，之前是同尺寸的骨架，不跳版。
 */
export const PageThumb = memo(function PageThumb({ page, scale = 0.3, className }: { page: PageView | null; scale?: number; className?: string }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const key = page ? `${page.slug}:${page.version}` : "";
  const live = page?.published;
  return (
    <span
      className={cn("page-thumb", className)}
      data-loaded={live && loaded === key ? "" : undefined}
      data-off={page && !live ? "" : undefined}
      style={{ "--s": scale } as React.CSSProperties}>
      {live ? (
        <iframe
          aria-hidden
          key={key}
          loading="lazy"
          onLoad={() => setLoaded(key)}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts"
          src={`${page.path}?v=${page.version}`}
          tabIndex={-1}
          title={page.title}
        />
      ) : page ? (
        <span className="page-thumb-off">{"已下线"}</span>
      ) : null}
    </span>
  );
});

/** 聊天里的页面卡片：缩略图 + 标题 / 版本 / 地址 + 打开 · 复制链接。做页面时先出同尺寸骨架。 */
export const PageCard = memo(function PageCard({ pageId, pendingTitle, failed }: { pageId: string | null; pendingTitle?: string; failed?: boolean }) {
  const query = useQuery({ ...pageQueryOptions(pageId ?? ""), enabled: Boolean(pageId) });
  const page = query.data ?? null;
  const gone = Boolean(pageId) && query.isError;
  if (failed && !pageId) return null;
  const building = !pageId || (query.isPending && !gone);
  const url = page ? pageUrl(page) : "";
  const title = page?.title ?? pendingTitle ?? "页面";
  return (
    <div
      className="page-card"
      data-state={building ? "building" : gone ? "gone" : page?.published ? "live" : "off"}
      data-surface="bubble"
    >
      {page?.published ? (
        <a aria-label={`打开页面「${title}」`} className="page-card-media" href={url} rel="noopener noreferrer" target="_blank">
          <PageThumb page={page} scale={0.3} />
        </a>
      ) : (
        <div className="page-card-media">
          {building ? (
            <span className="page-thumb" />
          ) : (
            <span className="page-thumb" data-off="">
              <span className="page-thumb-off">{gone ? "页面已删除" : "已下线"}</span>
            </span>
          )}
        </div>
      )}
      <div className="page-card-foot">
        <span className="page-card-ico">
          <IconWorld className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="page-card-t">{building && !page ? `正在做「${title}」…` : title}</div>
          <div className="page-card-s">
            {page ? `第 ${page.version} 版 · ${page.published ? url.replace(/^https?:\/\//, "") : "已下线，链接打不开"}` : gone ? "这个页面已经删除" : "做好后这里出现链接"}
          </div>
        </div>
        {page?.published ? (
          <span className="page-card-actions">
            <a aria-label="打开页面" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "page-card-open")} href={url} rel="noopener noreferrer" target="_blank" title="打开页面">
              <IconExternalLink className="size-4" />
              <span className="page-card-open-label">{"打开"}</span>
            </a>
            <CopyButton size="sm" value={url} variant="outline">
              {"复制链接"}
            </CopyButton>
          </span>
        ) : null}
      </div>
    </div>
  );
});
