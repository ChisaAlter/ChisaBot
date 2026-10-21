import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import type { ChannelSummary } from "@/lib/channels/queries";

/*
 * 「加载更早的会话」——只由这一颗按钮驱动，没有滚动自动加载。
 *
 * 这里曾经有一条 IntersectionObserver 分支：不处于搜索态时，哨兵一进视口就自动翻下一页。导航收敛之后
 * （DESIGN.md §57）左栏只列机器人，会话列表**只在搜索框有字时才画**，而搜索态正是那条分支主动退出的
 * 情况——它再也没有调用点：要么永远不跑，要么（如果谁把它接回去）在人打字过滤时把人整段历史都下载
 * 下来。2026-10-21 实机审查时删掉，只留按钮：翻页发生在一次明确的点击之后。
 */
type Props = {
  query: Pick<
    UseInfiniteQueryResult<ChannelSummary[]>,
    | "hasNextPage"
    | "isFetching"
    | "isFetchingNextPage"
    | "isFetchNextPageError"
    | "fetchNextPage"
  >;
};

export function ChannelPagination({ query }: Props) {
  const sentinel = useRef<HTMLDivElement>(null);
  const {
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = query;

  if (!hasNextPage) return null;

  return (
    <div ref={sentinel} className="px-2 py-3 text-center">
      {isFetchNextPageError ? (
        <p role="alert" className="mb-2 text-xs text-muted-foreground">
          {"无法加载较旧的对话。"}
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="w-full text-xs"
        disabled={isFetching}
        onClick={() => void fetchNextPage({ cancelRefetch: false })}
      >
        {isFetchingNextPage
          ? "正在加载更早的会话…"
          : isFetchNextPageError
            ? "重试加载更早对话"
            : "加载更早的会话"}
      </Button>
    </div>
  );
}
