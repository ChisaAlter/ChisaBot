import { IconMessages } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type BotThreadSummary, readThreadHistory } from "@/lib/copilot/bot-thread";
import { cn } from "@/lib/utils";

/** 「刚刚 / 3 分钟前 / 5 小时前 / 10月12日」（跨年带年份）。 */
function whenText(at: string | null): string {
  if (!at) return "";
  const ms = Date.now() - Date.parse(at);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    "zh-CN",
    sameYear ? { month: "long", day: "numeric" } : { year: "numeric", month: "long", day: "numeric" },
  );
}

/**
 * 「历史对话」（DESIGN.md §42.6 / §68）：机器人 ⋯ 菜单里打开。列出你和这个机器人的对话（最近 30 条，频道聊天的
 * 和以前 `/bot` 的都在），点一条在频道聊天里打开（没有频道的旧对话由服务器补一个）。只是打开，不删、不改名。
 */
export function BotThreadHistoryDialog({
  agentId,
  currentThreadId,
  open,
  onOpenChange,
  onPick,
}: {
  agentId: string;
  currentThreadId: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (threadId: string) => void;
}) {
  const list = useQuery({
    queryKey: ["bot-thread-history", agentId],
    queryFn: () => readThreadHistory(agentId),
    enabled: open,
    staleTime: 0,
    gcTime: 60_000,
  });
  const threads: BotThreadSummary[] = list.data && list.data !== "unsupported" ? list.data : [];
  const pick = (threadId: string) => {
    onOpenChange(false);
    if (threadId !== currentThreadId) onPick(threadId);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="bot-history max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{"历史对话"}</DialogTitle>
          <DialogDescription>{"点一条打开，接着聊。旧对话都会保留。"}</DialogDescription>
        </DialogHeader>
        {/* biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了 */}
        <div className="bot-history-list" role="list">
          {list.isPending ? (
            [0, 1, 2].map((i) => <div aria-hidden className="bot-history-skel" key={i} />)
          ) : list.isError ? (
            <p className="bot-history-empty">
              {"历史对话没加载出来。"}
              <button className="bot-history-retry" onClick={() => void list.refetch()} type="button">
                {"重试"}
              </button>
            </p>
          ) : list.data === "unsupported" || threads.length === 0 ? (
            <p className="bot-history-empty">{"还没有别的对话。"}</p>
          ) : (
            threads.map((thread) => {
              const current = thread.threadId === currentThreadId;
              return (
                // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: 按钮在 role 列表里充当列表项，是有意的
                // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
                <button
                  aria-current={current ? "true" : undefined}
                  className={cn("bot-history-row", current && "is-current")}
                  key={thread.threadId}
                  onClick={() => pick(thread.threadId)}
                  role="listitem"
                  type="button"
                >
                  <IconMessages aria-hidden className="bot-history-icon" />
                  <span className="bot-history-main">
                    <span className="bot-history-title">{thread.title}</span>
                    <span className="bot-history-sub">
                      {`${thread.messages} 条消息 · ${whenText(thread.updatedAt)}`}
                    </span>
                  </span>
                  {current ? <span className="bot-history-badge">{"当前"}</span> : null}
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
