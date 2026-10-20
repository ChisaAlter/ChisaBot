import { IconArrowBackUp, IconChevronDown, IconFileText, IconPencil } from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SmoothStreamdown } from "@/components/chat/smooth-markdown";
import { useDisplayText } from "@/components/rich-previews/rich-previews";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { CopyButton } from "@/components/ui/copy-button";
import { type BubbleSegment, splitBubbles } from "@/lib/chat/bubbles";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";

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
}: {
  text: string;
  components: Record<string, unknown>;
  delay?: number;
  tone?: "lead" | "final" | undefined;
}) {
  const display = useDisplayText(text);
  const segments = useMemo(() => splitBubbles(display), [display]);
  // 第一次渲染时已经在的气泡排队淡入；之后流式新增的不排队。
  const initial = useRef<number | null>(null);
  if (initial.current === null) initial.current = segments.length;
  const reduce = useReducedMotion();
  return (
    <div className="chat-bubbles" data-cb-turn={tone}>
      {segments.map((seg, i) => (
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
          <Segment components={components} seg={seg} />
        </motion.div>
      ))}
    </div>
  );
});

function Segment({ seg, components }: { seg: BubbleSegment; components: Record<string, unknown> }) {
  if (seg.kind === "draft") return <DraftCard text={seg.text} title={seg.title} />;
  if (seg.kind === "doc") return <DocCard components={components} text={seg.text} title={seg.title} />;
  return (
    <Bubble
      align="start"
      className={seg.kind === "code" ? "chat-bubble-bare w-full" : seg.wide ? "w-full" : "chat-bubble-fit"}
      data-cb-bubble={seg.kind}
      variant="ghost"
    >
      <BubbleContent className={seg.wide ? "w-full" : undefined}>
        {seg.quote ? <ReplyQuote text={seg.quote} /> : null}
        <SmoothStreamdown components={components as never}>{seg.text}</SmoothStreamdown>
      </BubbleContent>
    </Bubble>
  );
}

/** 回复引用：机器人回应的不是紧挨着的上一条时，在气泡顶上带一行对方原话（Hark 的 reply quote）。 */
export function ReplyQuote({ text }: { text: string }) {
  return (
    <div className="chat-reply-quote" data-testid="chat-reply-quote">
      <IconArrowBackUp aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </div>
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

/** 文档卡收起时的高度（px）：大约 10 行正文。超过它才出现「展开全文」。 */
export const DOC_COLLAPSED_PX = 300;

/**
 * 文档卡（DESIGN.md §76，Hark 的 summary doc）：长的总结、说明、对比结论、步骤清单不再塞进一个长气泡，
 * 而是一张玻璃卡——头部「文档图标 · 标题 · 复制」，正文照常是 Markdown（标题、列表、表格、代码都能用）。
 * 正文超过约 10 行时收起（底部淡出 +「展开全文」）：卡片高度封顶，流式写长文时聊天不跟着一直长高；
 * 只有用户点「展开全文」才长高（§35），「收起」回到封顶高度。
 */
export function DocCard({ text, title, components }: { text: string; title?: string | undefined; components: Record<string, unknown> }) {
  const body = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  /*
   * 只在「这段文字变了」时量一次，宽度变化不再重算（DESIGN.md §106）：拖右栏把手时整列重新换行，同一篇文档
   * 在窄几像素的地方就多折两行、跨过 300px 的门槛——以前 ResizeObserver 盯着它，卡片会当场收起 / 展开，
   * 几百 px 的跳。是不是「一篇长文」是这条消息的属性，不该随窗口宽度变。
   * layout effect：量完再画，打开对话时不会先展开一次、再当着人面收起。
   */
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    setTall(text.trim().length > 0 && el.scrollHeight > DOC_COLLAPSED_PX + 24);
  }, [text]);
  const collapsed = tall && !open;
  return (
    <section aria-label={title ? `文档：${title}` : "文档"} className="chat-draft-card chat-doc-card" data-testid="chat-doc-card">
      <header className="chat-draft-head">
        <IconFileText aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="chat-draft-title">{title || "文档"}</span>
        <CopyButton className="chat-draft-copy" size="sm" value={text} variant="ghost">
          {"复制"}
        </CopyButton>
      </header>
      <div className="chat-doc-body" data-collapsed={collapsed || undefined} ref={body} style={collapsed ? { maxHeight: DOC_COLLAPSED_PX } : undefined}>
        <div className="chat-doc-inner">
          <SmoothStreamdown components={components as never}>{text}</SmoothStreamdown>
        </div>
      </div>
      {tall ? (
        <button aria-expanded={open} className="chat-doc-more" data-testid="chat-doc-more" onClick={() => setOpen((value) => !value)} type="button">
          {open ? "收起" : "展开全文"}
          <IconChevronDown aria-hidden="true" className="size-3.5" data-open={open || undefined} />
        </button>
      ) : null}
    </section>
  );
}
