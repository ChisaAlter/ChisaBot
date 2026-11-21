import {
  IconArrowUp,
  IconBolt,
  IconChevronDown,
  IconChevronUp,
  IconMessageReply,
  IconPlus,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  askSideThreadMutationOptions,
  createSideThreadMutationOptions,
  deleteSideThreadMutationOptions,
  type LiveSteerResult,
  sendLiveSteerMutationOptions,
  sideThreadDetailQueryOptions,
  sideThreadListQueryOptions,
} from "@/lib/conversations/side-threads";
import { cn } from "@/lib/utils";

export type SideChatDrawerProps = {
  parentThreadId: string;
  anchorMessageId?: string | null;
  isMainRunning?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialSideThreadId?: string | null;
  onSteerSent?: (result: LiveSteerResult, text: string) => void;
  className?: string;
};

function steerNoticeText(result: LiveSteerResult): string {
  switch (result.kind) {
    case "queued":
      if (result.steerAction === "next-step")
        return "已插话 · 当前操作后接管。";
      if (result.steerAction === "cut" || result.steerAction === "segment-cut")
        return "已立即切入并引导当前回复。";
      return "已将补充指令插入主回合队列，下一步执行时自动生效。";
    case "stopping":
      return "主回合正在停止中，请等待停止完成后在主输入框发送。";
    case "idle":
      return "主回合已结束，请直接在主对话输入框发送新消息。";
  }
}

export function SideChatDrawer({
  parentThreadId,
  anchorMessageId = null,
  isMainRunning = false,
  open,
  onOpenChange,
  initialSideThreadId = null,
  onSteerSent,
  className,
}: SideChatDrawerProps) {
  const queryClient = useQueryClient();
  const sideInputId = useId();
  const steerInputId = useId();

  const [uncontrolledOpen, setUncontrolledOpen] = useState(true);
  const [prevParentId, setPrevParentId] = useState(parentThreadId);
  const [prevInitialId, setPrevInitialId] = useState(initialSideThreadId);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSideThreadId,
  );
  const [draftingNew, setDraftingNew] = useState(false);
  const [digestExpanded, setDigestExpanded] = useState(false);
  const [sideDraft, setSideDraft] = useState("");
  const [steerDraft, setSteerDraft] = useState("");
  const [steerFeedback, setSteerFeedback] = useState<string | null>(null);

  if (prevParentId !== parentThreadId) {
    setPrevParentId(parentThreadId);
    setPrevInitialId(initialSideThreadId);
    setSelectedId(initialSideThreadId);
    setDraftingNew(false);
    setDigestExpanded(false);
    setSideDraft("");
    setSteerDraft("");
    setSteerFeedback(null);
  } else if (prevInitialId !== initialSideThreadId) {
    setPrevInitialId(initialSideThreadId);
    if (initialSideThreadId) {
      setSelectedId(initialSideThreadId);
      setDraftingNew(false);
    }
  }

  const isOpen = open ?? uncontrolledOpen;
  const handleOpenChange = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const listQuery = useQuery({
    ...sideThreadListQueryOptions(parentThreadId),
    enabled: isOpen && Boolean(parentThreadId),
  });

  const threads = listQuery.data ?? [];
  const anchoredMatch = anchorMessageId
    ? threads.find((item) => item.anchorMessageId === anchorMessageId)
    : undefined;
  const activeSideThreadId = draftingNew
    ? null
    : selectedId &&
        (threads.length === 0 ||
          threads.some((item) => item.id === selectedId) ||
          selectedId === initialSideThreadId)
      ? selectedId
      : (anchoredMatch?.id ?? threads[0]?.id ?? null);

  const detailQuery = useQuery({
    ...sideThreadDetailQueryOptions(activeSideThreadId),
    enabled: isOpen && Boolean(activeSideThreadId),
  });

  const createMutation = useMutation(
    createSideThreadMutationOptions(queryClient),
  );
  const askMutation = useMutation(askSideThreadMutationOptions(queryClient));
  const deleteMutation = useMutation(
    deleteSideThreadMutationOptions(queryClient),
  );
  const steerMutation = useMutation(sendLiveSteerMutationOptions());

  const isAsking = createMutation.isPending || askMutation.isPending;
  const activeThread = detailQuery.data ?? null;
  const activeSummary =
    threads.find((item) => item.id === activeSideThreadId) ?? null;
  const digestText =
    activeThread?.contextDigest ?? activeSummary?.contextDigest ?? "";
  const effectiveAnchorId =
    activeThread?.anchorMessageId ??
    activeSummary?.anchorMessageId ??
    anchorMessageId;

  const submitSideQuestion = () => {
    const text = sideDraft.trim();
    if (!text || !parentThreadId || isAsking) return;

    if (!activeSideThreadId) {
      createMutation.mutate(
        {
          parentThreadId,
          ...(anchorMessageId ? { anchorMessageId } : {}),
          question: text,
        },
        {
          onSuccess: (created) => {
            setSelectedId(created.id);
            setDraftingNew(false);
            setSideDraft("");
          },
        },
      );
      return;
    }

    askMutation.mutate(
      {
        sideThreadId: activeSideThreadId,
        parentThreadId,
        text,
      },
      {
        onSuccess: () => {
          setSideDraft("");
        },
      },
    );
  };

  const handleSideFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitSideQuestion();
  };

  const handleSideKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submitSideQuestion();
    }
  };

  const handleDeleteActive = () => {
    if (!activeSideThreadId || deleteMutation.isPending) return;
    deleteMutation.mutate(
      { sideThreadId: activeSideThreadId, parentThreadId },
      {
        onSuccess: () => {
          setSelectedId(null);
          setDraftingNew(false);
          toast.success("已删除该侧边问答");
        },
        onError: (error) => {
          toast.error(
            error instanceof Error ? error.message : "删除侧边问答失败",
          );
        },
      },
    );
  };

  const submitSteer = () => {
    const text = steerDraft.trim();
    if (!text || !parentThreadId || steerMutation.isPending) return;
    steerMutation.mutate(
      { threadId: parentThreadId, text },
      {
        onSuccess: (result) => {
          const notice = steerNoticeText(result);
          setSteerFeedback(notice);
          if (result.kind === "queued") {
            setSteerDraft("");
            toast.success("已插入补充指令（Live Steer）");
          } else {
            toast.info(notice);
          }
          onSteerSent?.(result, text);
        },
        onError: (error) => {
          const msg =
            error instanceof Error ? error.message : "发送补充指令失败";
          setSteerFeedback(msg);
          toast.error(msg);
        },
      },
    );
  };

  const handleSteerFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitSteer();
  };

  const handleSteerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submitSteer();
    }
  };

  const sideError =
    createMutation.error?.message ??
    askMutation.error?.message ??
    detailQuery.error?.message ??
    listQuery.error?.message ??
    null;

  return (
    <Sheet onOpenChange={handleOpenChange} open={isOpen}>
      <SheetContent
        className={cn(
          "w-full gap-0 bg-[var(--glass-bg-opaque)] p-0 sm:max-w-[440px]",
          className,
        )}
        data-testid="side-chat-drawer"
        side="right"
      >
        <SheetHeader className="border-b border-border px-4 py-3 pr-12">
          <div className="flex items-center gap-2">
            <IconMessageReply className="size-4 shrink-0 text-primary" />
            <SheetTitle className="text-base font-semibold">
              {"旁白侧边问答"}
            </SheetTitle>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
              {"/side"}
            </span>
          </div>
          <SheetDescription className="text-xs font-medium text-muted-foreground">
            {"侧边提问 · 不污染主对话上下文"}
          </SheetDescription>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {
              "仅只读继承主对话摘要，问答只保存在本侧边线程，不会写入主对话记录或左侧历史列表。"
            }
          </p>
        </SheetHeader>

        <div className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-none">
            {threads.map((thread) => {
              const selected = !draftingNew && thread.id === activeSideThreadId;
              return (
                <button
                  className={cn(
                    "max-w-[160px] shrink-0 truncate rounded-full border px-2.5 py-1 text-xs transition-colors",
                    selected
                      ? "border-primary/40 bg-primary/10 font-medium text-foreground"
                      : "border-border bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  key={thread.id}
                  onClick={() => {
                    setDraftingNew(false);
                    setSelectedId(thread.id);
                  }}
                  title={thread.title}
                  type="button"
                >
                  {thread.title}
                </button>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              onClick={() => {
                setDraftingNew(true);
                setSelectedId(null);
              }}
              size="xs"
              type="button"
              variant="outline"
            >
              <IconPlus />
              {"新提问"}
            </Button>
            {activeSideThreadId ? (
              <Button
                aria-label={"删除当前侧边问答"}
                disabled={deleteMutation.isPending}
                onClick={handleDeleteActive}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <IconTrash />
              </Button>
            ) : null}
          </div>
        </div>

        {(digestText || effectiveAnchorId) && (
          <div className="border-b border-border/70 bg-muted/30 px-4 py-2">
            <button
              className="flex w-full items-center justify-between gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setDigestExpanded((prev) => !prev)}
              type="button"
            >
              <span className="flex items-center gap-1.5 font-medium">
                <IconSparkles className="size-3.5 text-primary" />
                {effectiveAnchorId
                  ? "已锚定主对话消息的只读摘要"
                  : "主对话只读上下文摘要"}
              </span>
              {digestText ? (
                digestExpanded ? (
                  <IconChevronUp className="size-3.5 shrink-0" />
                ) : (
                  <IconChevronDown className="size-3.5 shrink-0" />
                )
              ) : null}
            </button>
            {digestExpanded && digestText ? (
              <pre className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/60 bg-background/70 p-2 font-sans text-[11px] leading-relaxed text-muted-foreground">
                {digestText}
              </pre>
            ) : null}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
          {listQuery.isPending ||
          (activeSideThreadId && detailQuery.isPending) ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-12 w-3/4 self-end rounded-xl" />
              <Skeleton className="h-16 w-4/5 rounded-xl" />
              <Skeleton className="h-10 w-2/3 self-end rounded-xl" />
            </div>
          ) : sideError ? (
            <p className="text-xs text-destructive" role="alert">
              {sideError}
            </p>
          ) : !activeThread || activeThread.messages.length === 0 ? (
            <div className="my-auto flex flex-col items-center justify-center gap-2 py-8 text-center">
              <IconMessageReply className="size-7 text-muted-foreground/60" />
              <p className="text-sm font-medium text-foreground">
                {"在这里旁白提问"}
              </p>
              <p className="max-w-[260px] text-xs leading-relaxed text-muted-foreground">
                {
                  "适合临时追问概念、核对细节或展开分支思考，主对话上下文保持干净。"
                }
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {activeThread.messages.map((message) => {
                const isUser = message.role === "user";
                return (
                  <Message align={isUser ? "end" : "start"} key={message.id}>
                    <MessageContent>
                      <MessageHeader>
                        {isUser ? "侧边提问" : "旁白回复"}
                      </MessageHeader>
                      <Bubble
                        align={isUser ? "end" : "start"}
                        variant={isUser ? "default" : "secondary"}
                      >
                        <BubbleContent className="whitespace-pre-wrap">
                          {message.content}
                        </BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-3 border-t border-border bg-background/50 p-4">
          {isMainRunning ? (
            <form
              className="flex flex-col gap-2 rounded-xl border border-primary/35 bg-primary/5 p-3"
              data-testid="live-steer-panel"
              onSubmit={handleSteerFormSubmit}
            >
              <div className="flex items-center justify-between gap-2">
                <label
                  className="flex items-center gap-1.5 text-xs font-semibold text-foreground"
                  htmlFor={steerInputId}
                >
                  <IconBolt className="size-3.5 text-primary" />
                  {"插入补充指令（Live Steer）"}
                </label>
                <span className="text-[11px] font-medium text-primary">
                  {"主回合运行中"}
                </span>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {
                  "插话改方向：直接注入当前正在执行的主对话回合，影响下一步推理。"
                }
              </p>
              <div className="flex items-end gap-2">
                <Textarea
                  className="min-h-10 resize-none bg-background text-xs"
                  disabled={steerMutation.isPending}
                  id={steerInputId}
                  onChange={(event) => setSteerDraft(event.target.value)}
                  onKeyDown={handleSteerKeyDown}
                  placeholder="例如：先别改样式了，优先修好接口报错…"
                  rows={2}
                  value={steerDraft}
                />
                <Button
                  disabled={!steerDraft.trim() || steerMutation.isPending}
                  loading={steerMutation.isPending}
                  size="sm"
                  type="submit"
                  variant="default"
                >
                  {"插话"}
                </Button>
              </div>
              {steerFeedback ? (
                <p className="text-[11px] text-muted-foreground" role="status">
                  {steerFeedback}
                </p>
              ) : null}
            </form>
          ) : null}

          <form className="flex flex-col gap-2" onSubmit={handleSideFormSubmit}>
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor={sideInputId}
            >
              {"旁白侧边问（仅保存在 /side，回车发送）"}
            </label>
            <div className="flex items-end gap-2">
              <Textarea
                className="min-h-11 resize-none bg-background text-sm"
                disabled={isAsking}
                id={sideInputId}
                onChange={(event) => setSideDraft(event.target.value)}
                onKeyDown={handleSideKeyDown}
                placeholder="针对当前内容在侧边追问…（Shift+Enter 换行）"
                rows={2}
                value={sideDraft}
              />
              <Button
                aria-label={"发送侧边提问"}
                disabled={!sideDraft.trim() || isAsking}
                loading={isAsking}
                size="icon"
                type="submit"
                variant="secondary"
              >
                <IconArrowUp />
              </Button>
            </div>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
