import { IconArrowUpRight, IconWorld } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";
import type { ChatFileView } from "../../../../shared/chat-files";
import type { PageView } from "../../../../shared/pages";
import { PageSection } from "@/components/layout/page-shell";
import { FileCard } from "@/components/rich-previews/rich-previews";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/skyglass";
import { botChatFilesQueryOptions, fetchBotChatFiles } from "@/lib/chat-files";
import { agoText } from "@/lib/im";
import { pagesQueryOptions } from "@/lib/pages";

/**
 * 机器人资料页「文件与页面」分区（CB-092，DESIGN.md §47、§113）。
 *
 * 把这个机器人生成/收到过的文件（chat_files.agent_id）和做过的网页（pages.agent_id）合在一起，
 * 按「今天 / 本周 / 更早」分组。一个都没有时整块不出现（§47）；点文件直接走现有预览（图片灯箱、
 * PDF 弹窗、CB-089 的 .docx 纸张预览、文本阅读器），点页面进详情或新标签页打开。
 */

export type BotArtifactItem =
  | { kind: "file"; id: string; timestamp: string; file: ChatFileView }
  | { kind: "page"; id: string; timestamp: string; page: PageView };

export type ArtifactBucketLabel = "今天" | "本周" | "更早";

export type ArtifactBucket = {
  label: ArtifactBucketLabel;
  items: BotArtifactItem[];
};

const PAGE_SIZE = 30;

/** 按本地日历把文件与页面归入「今天 / 本周（近 7 天） / 更早」，每组内按时间倒序。 */
export function groupArtifactsByBucket(
  files: readonly ChatFileView[],
  pages: readonly PageView[],
  now: Date = new Date(),
): ArtifactBucket[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeekWindow = startOfToday - 6 * 24 * 60 * 60 * 1000;

  const combined: BotArtifactItem[] = [
    ...files.map((file): BotArtifactItem => ({
      kind: "file",
      id: `file:${file.id}`,
      timestamp: file.createdAt,
      file,
    })),
    ...pages.map((page): BotArtifactItem => ({
      kind: "page",
      id: `page:${page.id}`,
      timestamp: page.updatedAt || page.createdAt,
      page,
    })),
  ];

  combined.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const today: BotArtifactItem[] = [];
  const week: BotArtifactItem[] = [];
  const earlier: BotArtifactItem[] = [];

  for (const item of combined) {
    const ms = Date.parse(item.timestamp);
    if (Number.isFinite(ms) && ms >= startOfToday) {
      today.push(item);
    } else if (Number.isFinite(ms) && ms >= startOfWeekWindow) {
      week.push(item);
    } else {
      earlier.push(item);
    }
  }

  const buckets: ArtifactBucket[] = [
    { label: "今天", items: today },
    { label: "本周", items: week },
    { label: "更早", items: earlier },
  ];
  return buckets.filter((bucket) => bucket.items.length > 0);
}

export function BotFilesAndPagesSection({ agentId }: { agentId: string }) {
  const initialFiles = useQuery(botChatFilesQueryOptions(agentId, PAGE_SIZE + 1));
  const allPages = useQuery(pagesQueryOptions());
  const [extraFiles, setExtraFiles] = useState<ChatFileView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const firstBatch = initialFiles.data ?? [];
  useEffect(() => {
    setExtraFiles([]);
    setHasMore(firstBatch.length > PAGE_SIZE);
  }, [agentId, firstBatch.length]);

  const files = [
    ...firstBatch.slice(0, PAGE_SIZE),
    ...extraFiles,
  ];
  const pages = (allPages.data ?? []).filter((page) => page.agentId === agentId);
  const buckets = groupArtifactsByBucket(files, pages);

  if (buckets.length === 0) return null;

  const loadMore = async () => {
    const last = files.at(-1);
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchBotChatFiles(agentId, {
        limit: PAGE_SIZE + 1,
        before: last.createdAt,
      });
      setExtraFiles((prev) => [...prev, ...next.slice(0, PAGE_SIZE)]);
      setHasMore(next.length > PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <PageSection title={"文件与页面"}>
      <Card className="bp-card" data-testid="bot-files-and-pages">
        {buckets.map((bucket) => (
          <Fragment key={bucket.label}>
            <div className="bp-group">{bucket.label}</div>
            <div className="bp-files">
              {bucket.items.map((item) =>
                item.kind === "file" ? (
                  <FileCard
                    key={item.id}
                    metaSuffix={agoText(item.file.createdAt)}
                    mimeType={item.file.mimeType}
                    name={item.file.name}
                    probeSize={false}
                    size={item.file.size}
                    url={item.file.url}
                  />
                ) : (
                  <div className="rp-file" data-preview="page" key={item.id}>
                    <span aria-hidden className="rp-file-icon" data-ext="html">
                      <IconWorld className="size-5" />
                    </span>
                    <Link
                      className="rp-file-text"
                      title={item.page.title}
                      to="/settings/pages"
                    >
                      <span className="rp-file-name">{item.page.title}</span>
                      <span className="rp-file-meta">
                        {[
                          "页面",
                          `第 ${item.page.version} 版`,
                          item.page.published ? "已发布" : "已下线",
                          agoText(item.timestamp),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </Link>
                    {item.page.published ? (
                      <a
                        aria-label={`打开 ${item.page.title}`}
                        className="rp-file-dl"
                        href={item.page.path}
                        rel="noopener noreferrer"
                        target="_blank"
                        title="在新标签页打开"
                      >
                        <IconArrowUpRight className="size-4" />
                      </a>
                    ) : null}
                  </div>
                ),
              )}
            </div>
          </Fragment>
        ))}
        {hasMore ? (
          <div className="px-5 py-3 text-center">
            <Button
              data-testid="bot-files-load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              size="sm"
              variant="ghost"
            >
              {loadingMore ? "正在加载…" : "加载更多"}
            </Button>
          </div>
        ) : null}
      </Card>
    </PageSection>
  );
}
