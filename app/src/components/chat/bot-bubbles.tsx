import { IconChevronDown, IconFileText, IconMaximize, IconPencil } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SmoothStreamdown } from "@/components/chat/smooth-markdown";
import { useDisplayText } from "@/components/rich-previews/rich-previews";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type BubbleSegment, splitBubbles } from "@/lib/chat/bubbles";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";

export type ReplyTarget = {
  id?: string | undefined;
  text: string;
};

/**
 * 机器人的一条回复画成几个短气泡（DESIGN.md §69，向 Hark 的短信式对话看齐）。
 *
 * - 切法只有一份：`splitBubbles`（空行分段，代码块 / 表格 / 清单不切开）。
 * - 单独一行的链接先按整条消息拿掉（和下面的链接卡同一个结果，§48），再切气泡；只剩链接的段不画气泡。
 * - 短段落的气泡贴着文字宽度（最宽 min(85%, 560px)），表格 / 代码 / 长清单 / 草稿整列宽。
 * - 第一次出现时一个接一个淡入（每个隔 BEAT 秒）；流式写出来的新气泡不加延迟，跟着字走。
 *   `prefers-reduced-motion`：只淡入、不位移、不排队。
 * - ```draft = 草稿卡（可一键复制）；```doc = 文档卡（长总结 / 说明，§76）；段首 `> 原话` = 回复引用。
 */
export const BEAT_SECONDS = 0.16;

export const BotBubbles = memo(function BotBubbles({
  text,
  components,
  delay = 0,
  tone,
  replyTo,
}: {
  text: string;
  components: Record<string, unknown>;
  delay?: number;
  tone?: "lead" | "final" | undefined;
  /** 智能回复引用：当用户在回合内连发多条或隔着干活步骤时，若机器人未手写 `> 引用`，首段自动挂上 `╭─` 引用胶囊。 */
  replyTo?: ReplyTarget | undefined;
}) {
  const display = useDisplayText(text);
  const segments = useMemo(() => splitBubbles(display), [display]);
  const hasExplicitQuote = useMemo(() => segments.some((s) => Boolean(s.quote)), [segments]);
  // 第一次渲染时已经在的气泡排队淡入；之后流式新增的不排队。
  const initial = useRef<number | null>(null);
  if (initial.current === null) initial.current = segments.length;
  const reduce = useReducedMotion();
  if (segments.length === 0) {
    return replyTo?.text ? (
      <div className="chat-bubbles" data-cb-turn={tone}>
        <ReplyQuote targetMessageId={replyTo.id} text={replyTo.text} />
      </div>
    ) : null;
  }
  return (
    <div className="chat-bubbles" data-cb-turn={tone}>
      {segments.map((seg, i) => {
        const effectiveQuote = seg.quote ?? (!hasExplicitQuote && i === 0 ? replyTo?.text : undefined);
        const targetId = seg.quote ? undefined : replyTo?.id;
        return (
          <motion.div
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            className="chat-bubble-arrive"
            data-slot="bubble-arriving"
            initial={i === 0 ? false : { opacity: 0, transform: reduce ? "none" : "translateY(6px)" }}
            // 段落的序号就是它的身份：流式时只会在末尾追加，前面的段不会换位置。
            // biome-ignore lint/suspicious/noArrayIndexKey: 见上
            key={i}
            transition={{
              delay: reduce || i >= (initial.current ?? 0) ? 0 : delay + i * BEAT_SECONDS,
              duration: ENTRANCE_SECONDS,
              ease: EASE_OUT,
            }}
          >
            <Segment
              components={components}
              quote={effectiveQuote}
              seg={seg}
              targetMessageId={targetId ?? replyTo?.id}
            />
          </motion.div>
        );
      })}
    </div>
  );
});

function Segment({
  seg,
  components,
  quote,
  targetMessageId,
}: {
  seg: BubbleSegment;
  components: Record<string, unknown>;
  quote?: string | undefined;
  targetMessageId?: string | undefined;
}) {
  const quoteNode = quote ? <ReplyQuote targetMessageId={targetMessageId} text={quote} /> : null;
  if (seg.kind === "draft") {
    return (
      <>
        {quoteNode}
        <DraftCard text={seg.text} title={seg.title} />
      </>
    );
  }
  if (seg.kind === "doc") {
    return (
      <>
        {quoteNode}
        <DocCard components={components} text={seg.text} title={seg.title} />
      </>
    );
  }
  return (
    <>
      {quoteNode}
      <Bubble
        align="start"
        className={seg.kind === "code" ? "chat-bubble-bare w-full" : seg.wide ? "w-full" : "chat-bubble-fit"}
        data-cb-bubble={seg.kind}
        variant="ghost"
      >
        <BubbleContent className={seg.wide ? "w-full" : undefined}>
          <SmoothStreamdown components={components as never}>{seg.text}</SmoothStreamdown>
        </BubbleContent>
      </Bubble>
    </>
  );
}

function flashMessageElement(el: HTMLElement) {
  const bubble = el.querySelector<HTMLElement>('[data-slot="bubble"]') ?? el;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  bubble.classList.remove("message-flash");
  void bubble.offsetWidth;
  bubble.classList.add("message-flash");
  window.setTimeout(() => {
    bubble.classList.remove("message-flash");
  }, 2200);
}

function scrollToQuotedMessage(text: string, targetMessageId?: string) {
  if (typeof document === "undefined") return;
  const needle = text.trim();
  // 1. 先按精确文本找用户气泡（如果机器人在一段里显式写了 `> 某一句`，优先跳到那一句）。
  if (needle) {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="chat-transcript"] [data-message-id]'),
    ).reverse();
    for (const row of rows) {
      if (!row.querySelector('[data-slot="message"][data-align="end"]')) continue;
      const content = row.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (content && (content.includes(needle) || needle.includes(content))) {
        flashMessageElement(row);
        return;
      }
    }
  }
  // 2. 兜底跳到本轮关联的用户消息 id。
  if (targetMessageId) {
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(targetMessageId) : targetMessageId;
    const byId = document.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`);
    if (byId) {
      flashMessageElement(byId);
    }
  }
}

/**
 * 回复引用（Hark 风格）：在气泡外上方画左弯折线 `╭─` + 独立深色/毛玻璃小胶囊，
 * 点击可平滑滚回对应的用户原话并高亮闪烁。
 */
export function ReplyQuote({
  text,
  targetMessageId,
}: {
  text: string;
  targetMessageId?: string | undefined;
}) {
  return (
    <button
      aria-label={`回应：${text}`}
      className="chat-reply-quote"
      data-testid="chat-reply-quote"
      onClick={() => scrollToQuotedMessage(text, targetMessageId)}
      title={`点击定位原消息：${text}`}
      type="button"
    >
      <svg aria-hidden="true" className="chat-reply-elbow" fill="none" viewBox="0 0 22 18">
        <path
          d="M5 17V9.5C5 6.462 7.462 4 10.5 4H20"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.75"
        />
      </svg>
      <span className="chat-reply-pill">
        <span className="chat-reply-text truncate">{text}</span>
      </span>
    </button>
  );
}

/** 草稿卡：要用户发出去的文字（微信、邮件、短信），一键复制；标题可选。 */
export function DraftCard({ text, title }: { text: string; title?: string | undefined }) {
  return (
    <section aria-label={title ? `草稿：${title}` : "草稿"} className="chat-draft-card" data-testid="chat-draft-card">
      <header className="chat-draft-head">
        <IconPencil aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="chat-draft-title">{title || "草稿"}</span>
        <CopyButton className="chat-draft-copy" size="sm" value={text} variant="ghost">
          {"复制"}
        </CopyButton>
      </header>
      <div className="chat-draft-body">{text}</div>
    </section>
  );
}

/** 文档卡收起时的高度（px）：大约 8–10 行正文预览。 */
export const DOC_COLLAPSED_PX = 220;

/**
 * 文档卡（DESIGN.md §76，Hark 的 summary doc 体验）：
 * 外层大圆角深色/玻璃卡片 + 醒目大标题，内嵌深色圆角正文预览框（带底部渐隐遮罩）；
 * 点击卡片或底部按钮弹出居中阅读弹窗（Modal），聊天流本身保持紧凑稳定。
 */
export function DocCard({
  text,
  title,
  components,
}: {
  text: string;
  title?: string | undefined;
  components: Record<string, unknown>;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  /*
   * 只在「这段文字变了」时量一次，宽度变化不再重算（DESIGN.md §106）。
   * layout effect：量完再画，打开对话时不会先展开一次、再当着人面收起。
   */
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    setTall(text.trim().length > 0 && el.scrollHeight > DOC_COLLAPSED_PX + 24);
  }, [text]);
  const heading = title || "文档";
  return (
    <>
      <section aria-label={title ? `文档：${title}` : "文档"} className="chat-draft-card chat-doc-card" data-testid="chat-doc-card">
        <header className="chat-doc-head">
          <div className="chat-doc-head-main">
            <IconFileText aria-hidden="true" className="chat-doc-head-icon size-4 shrink-0" />
            <span className="chat-doc-title">{heading}</span>
          </div>
          <div className="chat-doc-head-actions">
            <CopyButton className="chat-draft-copy" size="sm" value={text} variant="ghost">
              {"复制"}
            </CopyButton>
          </div>
        </header>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: 下方有显式 button 供键盘聚焦打开弹窗 */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 点击预览区打开全文阅读弹窗 */}
        <div
          className="chat-doc-inset"
          onClick={(event) => {
            // 如果用户正在选中文本或点击内部链接，不拦截。
            const sel = typeof window !== "undefined" ? window.getSelection() : null;
            if (sel && sel.toString().length > 0) return;
            if ((event.target as HTMLElement | null)?.closest("a, button")) return;
            setOpen(true);
          }}
        >
          <div
            className="chat-doc-body"
            data-collapsed={tall || undefined}
            ref={body}
            style={{ maxHeight: DOC_COLLAPSED_PX }}
          >
            <div className="chat-doc-inner">
              <SmoothStreamdown components={components as never}>{text}</SmoothStreamdown>
            </div>
          </div>
          <button
            aria-expanded={open}
            className="chat-doc-more"
            data-testid="chat-doc-more"
            onClick={() => setOpen(true)}
            type="button"
          >
            <span>{tall ? "展开全文" : "阅读全文"}</span>
            {tall ? (
              <IconChevronDown aria-hidden="true" className="size-3.5" />
            ) : (
              <IconMaximize aria-hidden="true" className="size-3.5" />
            )}
          </button>
        </div>
      </section>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="chat-doc-dialog">
          <DialogHeader className="chat-doc-dialog-head">
            <div className="chat-doc-dialog-title-wrap">
              <IconFileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <DialogTitle className="truncate">{heading}</DialogTitle>
            </div>
            <CopyButton className="chat-draft-copy mr-7" size="sm" value={text} variant="ghost">
              {"复制"}
            </CopyButton>
          </DialogHeader>
          <div className="chat-doc-dialog-body">
            <div className="chat-doc-inner">
              <SmoothStreamdown components={components as never}>{text}</SmoothStreamdown>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

