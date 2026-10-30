import { useMemo } from "react";
import { useMessageScroller } from "@/components/ui/message-scroller";

/**
 * 对话的数据层 ↔ 渲染层接口（jank P1-2，给 P3-3 virtua 虚拟化用）。
 *
 * 渲染层只认这四样：消息数组、要更早的历史、滚到底、按 id 跳到某条。现在的实现是
 * tail-first（`useTailFirstMount` + `MessageScroller`）；换成 virtua 时在 flag 后面另写一个
 * 渲染层，拿同一个对象，不碰数据从哪来。
 */
export type TranscriptScrollOptions = {
  align?: "start" | "center" | "end" | "nearest";
  behavior?: ScrollBehavior;
};

export interface TranscriptDataLayer<Row extends { id: string }> {
  /** 完整消息数组，旧 → 新。渲染层自己决定挂哪些（尾窗 / 虚拟窗口）。 */
  readonly items: readonly Row[];
  /** 渲染层滚到顶附近时调：让更早的行可用。tail-first 下是扩窗；位置由 overflow-anchor 保。 */
  prependHistory(): void;
  /** 钉到最底（打开对话、流式跟随、点「到底部」）。返回是否真的滚了。 */
  scrollToBottom(options?: TranscriptScrollOptions): boolean;
  /** 跳到某条（应用内搜索、`?message=`）。还没挂上的返回 false，调用方按现有方式重试。 */
  scrollToMessage(id: string, options?: TranscriptScrollOptions): boolean;
}

/** 在 `MessageScrollerProvider` 里面拿到 tail-first 版的数据层。 */
export function useTailFirstDataLayer<Row extends { id: string }>(
  items: readonly Row[],
  prependHistory: () => void,
): TranscriptDataLayer<Row> {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  return useMemo(
    () => ({
      items,
      prependHistory,
      scrollToBottom: (options) => scrollToEnd(options),
      scrollToMessage: (id, options) => scrollToMessage(id, options),
    }),
    [items, prependHistory, scrollToEnd, scrollToMessage],
  );
}
