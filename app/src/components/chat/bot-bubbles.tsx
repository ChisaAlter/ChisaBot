import {
  IconCalendarEvent,
  IconChevronDown,
  IconCode,
  IconEye,
  IconFileText,
  IconMail,
  IconMaximize,
  IconMessageReply,
  IconPencil,
  IconSparkles,
  IconSun,
} from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SmoothStreamdown } from "@/components/chat/smooth-markdown";
import { useDisplayText } from "@/components/rich-previews/rich-previews";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type BubbleSegment, splitBubbles } from "@/lib/chat/bubbles";
import { renderMermaidToSvg } from "@/lib/chat/mermaid-lite";
import { dispatchComposerQuote } from "@/lib/chat/quote-event";
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
 * - ```draft = 草稿卡（可一键复制）；```doc = 文档卡（长总结 / 说明，§76）；```brief = 每日晨报卡；
 *   ```mermaid / ```svg / ```html = 交互微应用/图表内联预览卡；段首 `> 原话` = 回复引用。
 */
export const BEAT_SECONDS = 0.16;

const EMPTY_COMPONENTS: Record<string, unknown> = {};

export const BotBubbles = memo(function BotBubbles({
  text,
  components = EMPTY_COMPONENTS,
  delay = 0,
  animate = false,
  tone,
  replyTo,
  replyToId,
  replyToText,
}: {
  text: string;
  components?: Record<string, unknown>;
  delay?: number;
  /** 仅对当前会话实时新到的回复播放逐段淡入；打开/切换会话时的历史消息直接实心绘制，避免整屏闪烁。 */
  animate?: boolean | undefined;
  tone?: "lead" | "final" | undefined;
  /** 智能回复引用：当用户在回合内连发多条或隔着干活步骤时，若机器人未手写 `> 引用`，首段自动挂上 `╭─` 引用胶囊。 */
  replyTo?: ReplyTarget | undefined;
  replyToId?: string | undefined;
  replyToText?: string | undefined;
}) {
  const effectiveReplyText = replyToText ?? replyTo?.text;
  const effectiveReplyId = replyToId ?? replyTo?.id;
  const display = useDisplayText(text);
  const segments = useMemo(() => splitBubbles(display), [display]);
  const hasExplicitQuote = useMemo(() => segments.some((s) => Boolean(s.quote)), [segments]);
  // 第一次渲染时已经在的气泡排队淡入；之后流式新增的不排队。
  const initial = useRef<number | null>(null);
  if (initial.current === null) initial.current = segments.length;
  const reduce = useReducedMotion();
  if (segments.length === 0) {
    return effectiveReplyText ? (
      <div className="chat-bubbles" data-cb-turn={tone}>
        <ReplyQuote targetMessageId={effectiveReplyId} text={effectiveReplyText} />
      </div>
    ) : null;
  }
  return (
    <div className="chat-bubbles" data-cb-turn={tone}>
      {segments.map((seg, i) => {
        const effectiveQuote = seg.quote ?? (!hasExplicitQuote && i === 0 ? effectiveReplyText : undefined);
        const targetId = seg.quote ? undefined : effectiveReplyId;
        return (
          <motion.div
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            className="chat-bubble-arrive"
            data-slot="bubble-arriving"
            initial={!animate || i === 0 ? false : { opacity: 0, transform: reduce ? "none" : "translateY(6px)" }}
            // 段落的序号就是它的身份：流式时只会在末尾追加，前面的段不会换位置。
            // biome-ignore lint/suspicious/noArrayIndexKey: 见上
            key={i}
            transition={{
              delay: !animate || reduce || i >= (initial.current ?? 0) ? 0 : delay + i * BEAT_SECONDS,
              duration: ENTRANCE_SECONDS,
              ease: EASE_OUT,
            }}
          >
            <Segment
              components={components}
              quote={effectiveQuote}
              seg={seg}
              targetMessageId={targetId ?? effectiveReplyId}
            />
          </motion.div>
        );
      })}
    </div>
  );
});

type ParsedArtifactFence = {
  lang: "mermaid" | "svg" | "html";
  title: string;
  code: string;
  rawMarkdown: string;
};

function parseArtifactFence(rawText: string): ParsedArtifactFence | null {
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");
  let heading: string | undefined;
  let fenceStart = -1;
  let lang = "";
  let marker = "```";

  for (let i = 0; i < lines.length; i++) {
    const l = (lines[i] ?? "").trim();
    if (!l) continue;
    const hm = /^#{1,6}\s+(.+)$/.exec(l);
    if (hm && fenceStart === -1) {
      heading = hm[1]?.trim();
      continue;
    }
    const fm = /^(```+|~~~+)\s*([^\s`]*)?/.exec(l);
    if (fm) {
      fenceStart = i;
      marker = fm[1] ?? "```";
      lang = (fm[2] ?? "").toLowerCase();
      break;
    }
    break;
  }

  if (fenceStart === -1) return null;
  if (lang !== "mermaid" && lang !== "svg" && lang !== "html") return null;

  const bodyLines = lines.slice(fenceStart + 1);
  if (bodyLines.length > 0) {
    const last = (bodyLines[bodyLines.length - 1] ?? "").trim();
    if (last.length >= marker.length && last.replace(/[`~]/g, "") === "") {
      bodyLines.pop();
    }
  }

  let title = heading;
  const firstBody = (bodyLines[0] ?? "").trim();
  const tm = /^(?:<!--\s*(?:标题|title)\s*[：:]\s*(.+?)\s*-->|(?:%%|\/\/)\s*(?:标题|title)\s*[：:]\s*(.+)|(?:标题|title)\s*[：:]\s*(.+))$/i.exec(
    firstBody,
  );
  if (tm) {
    title = (tm[1] ?? tm[2] ?? tm[3] ?? "").trim().slice(0, 44);
    bodyLines.shift();
  }

  const code = bodyLines.join("\n").trim();
  if (!code) return null;

  // 对 html 代码块：只对包含实际 HTML 标签的片段启用微应用预览
  if (lang === "html" && !/<[a-z][\s\S]*>/i.test(code)) {
    return null;
  }

  const defaultTitle =
    lang === "mermaid" ? "架构与流程图" : lang === "svg" ? "SVG 矢量图" : "HTML 交互微应用";

  return {
    lang,
    title: title || defaultTitle,
    code,
    rawMarkdown: rawText,
  };
}

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
  if (seg.kind === "brief") {
    return (
      <>
        {quoteNode}
        <BriefCard components={components} text={seg.text} title={seg.title} />
      </>
    );
  }
  if (seg.kind === "code") {
    const artifact = parseArtifactFence(seg.text);
    if (artifact) {
      return (
        <>
          {quoteNode}
          <ArtifactCard artifact={artifact} components={components} />
        </>
      );
    }
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
  const bubble = el.querySelector<HTMLElement>('[data-slot="bubble"], .chat-doc-card, .chat-brief-card, .chat-artifact-card') ?? el;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  bubble.classList.remove("message-flash");
  void bubble.offsetWidth;
  bubble.classList.add("message-flash");
  window.setTimeout(() => {
    bubble.classList.remove("message-flash");
  }, 2200);
}

function scrollToQuotedMessage(text: string, targetMessageId?: string, selfRow?: HTMLElement | null) {
  if (typeof document === "undefined") return;
  const rawNeedle = text.replace(/^\[[^\]]+\]\s*/, "").trim();
  const needle = rawNeedle || text.trim();
  // 1. 先按精确文本找对话流里的原消息（支持跳到用户原话或机器人回复/卡片）。
  if (needle) {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="chat-transcript"] [data-message-id]'),
    ).reverse();
    // 优先搜索用户消息，再兜底搜索任意其他消息行
    const userRows = rows.filter((r) => r !== selfRow && r.querySelector('[data-slot="message"][data-align="end"]'));
    const otherRows = rows.filter((r) => r !== selfRow && !r.querySelector('[data-slot="message"][data-align="end"]'));
    for (const row of [...userRows, ...otherRows]) {
      const content = row.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (content && (content.includes(needle) || needle.includes(content))) {
        flashMessageElement(row);
        return;
      }
    }
  }
  // 2. 兜底跳到本轮关联的消息 id。
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
 * 点击可平滑滚回对应的原话并高亮闪烁。
 */
export function ReplyQuote({
  text,
  targetMessageId,
  align = "start",
}: {
  text: string;
  targetMessageId?: string | undefined;
  align?: "start" | "end" | undefined;
}) {
  return (
    <button
      aria-label={`回应：${text}`}
      className={align === "end" ? "chat-reply-quote self-end" : "chat-reply-quote"}
      data-align={align}
      data-slot="reply-quote"
      data-testid="chat-reply-quote"
      onClick={(e) => {
        const selfRow = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-message-id]");
        scrollToQuotedMessage(text, targetMessageId, selfRow);
      }}
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

/** 卡片级「追问」按钮：将卡片标题和摘要塞入输入框引用栏。 */
function CardFollowupButton({
  title,
  snippet,
  source,
  onDone,
}: {
  title: string;
  snippet: string;
  source: string;
  onDone?: (() => void) | undefined;
}) {
  return (
    <button
      className="chat-card-followup-btn"
      data-testid="card-followup-btn"
      onClick={(e) => {
        e.stopPropagation();
        const summary = snippet.replace(/\s+/g, " ").trim().slice(0, 90);
        dispatchComposerQuote({
          text: summary ? `${title}：${summary}` : title,
          source,
        });
        onDone?.();
      }}
      title={`针对「${title}」继续追问`}
      type="button"
    >
      <IconMessageReply aria-hidden="true" className="size-3.5" />
      <span>{"追问"}</span>
    </button>
  );
}

/** 草稿卡：要用户发出去的文字（微信、邮件、短信），一键复制；标题可选。 */
export function DraftCard({ text, title }: { text: string; title?: string | undefined }) {
  const heading = title || "草稿";
  return (
    <section aria-label={title ? `草稿：${title}` : "草稿"} className="chat-draft-card" data-testid="chat-draft-card">
      <header className="chat-draft-head">
        <IconPencil aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="chat-draft-title">{heading}</span>
        <div className="ml-auto flex items-center gap-1">
          <CardFollowupButton snippet={text} source={`草稿 · ${heading}`} title={heading} />
          <CopyButton className="chat-draft-copy" size="sm" value={text} variant="ghost">
            {"复制"}
          </CopyButton>
        </div>
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
            <CardFollowupButton snippet={text} source={`文档 · ${heading}`} title={heading} />
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
            <div className="mr-7 flex items-center gap-1.5">
              <CardFollowupButton
                onDone={() => setOpen(false)}
                snippet={text}
                source={`文档 · ${heading}`}
                title={heading}
              />
              <CopyButton className="chat-draft-copy" size="sm" value={text} variant="ghost">
                {"复制"}
              </CopyButton>
            </div>
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

function buildHtmlSandboxDoc(code: string): string {
  if (/<html[\s>]/i.test(code)) return code;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: transparent;
    color: #e2e8f0;
    line-height: 1.5;
  }
</style>
</head>
<body>
${code}
</body>
</html>`;
}

/**
 * Mermaid / SVG / HTML 微应用内联渲染卡：
 * 支持「预览 / 源码」一键切换、点击放大弹窗交互、以及卡片级「追问」。
 */
export function ArtifactCard({
  artifact,
  components,
}: {
  artifact: ParsedArtifactFence;
  components: Record<string, unknown>;
}) {
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [open, setOpen] = useState(false);

  const renderedSvg = useMemo(() => {
    if (artifact.lang === "mermaid") {
      return renderMermaidToSvg(artifact.code);
    }
    if (artifact.lang === "svg") {
      const m = /<svg[\s\S]*<\/svg>/i.exec(artifact.code);
      return m ? m[0] : "";
    }
    return "";
  }, [artifact.lang, artifact.code]);

  const htmlDoc = useMemo(
    () => (artifact.lang === "html" ? buildHtmlSandboxDoc(artifact.code) : ""),
    [artifact.lang, artifact.code],
  );

  const badgeLabel =
    artifact.lang === "mermaid" ? "MERMAID" : artifact.lang === "svg" ? "SVG" : "HTML APP";

  const renderPreview = (inModal = false) => {
    if (artifact.lang === "html") {
      return (
        <iframe
          className={inModal ? "chat-artifact-iframe chat-artifact-iframe-modal" : "chat-artifact-iframe"}
          data-testid="artifact-html-preview"
          sandbox="allow-scripts"
          srcDoc={htmlDoc}
          title={artifact.title}
        />
      );
    }
    if (renderedSvg) {
      return (
        <div
          className={inModal ? "chat-artifact-svg chat-artifact-svg-modal" : "chat-artifact-svg"}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: 受控 Mermaid/SVG 矢量预览
          dangerouslySetInnerHTML={{ __html: renderedSvg }}
          data-testid="artifact-svg-preview"
        />
      );
    }
    return (
      <div className="chat-doc-inner p-3">
        <SmoothStreamdown components={components as never}>{artifact.rawMarkdown}</SmoothStreamdown>
      </div>
    );
  };

  return (
    <>
      <section
        aria-label={`${artifact.title} (${badgeLabel})`}
        className="chat-draft-card chat-doc-card chat-artifact-card"
        data-artifact-lang={artifact.lang}
        data-cb-bubble="code"
        data-testid="chat-artifact-card"
      >
        <header className="chat-doc-head">
          <div className="chat-doc-head-main">
            <span className="chat-artifact-badge">{badgeLabel}</span>
            <span className="chat-doc-title">{artifact.title}</span>
          </div>
          <div className="chat-doc-head-actions">
            <div className="chat-artifact-tabs" role="tablist">
              <button
                aria-selected={tab === "preview"}
                className="chat-artifact-tab"
                data-active={tab === "preview" || undefined}
                data-testid="artifact-tab-preview"
                onClick={() => setTab("preview")}
                role="tab"
                type="button"
              >
                <IconEye aria-hidden="true" className="size-3.5" />
                <span>{"预览"}</span>
              </button>
              <button
                aria-selected={tab === "code"}
                className="chat-artifact-tab"
                data-active={tab === "code" || undefined}
                data-testid="artifact-tab-code"
                onClick={() => setTab("code")}
                role="tab"
                type="button"
              >
                <IconCode aria-hidden="true" className="size-3.5" />
                <span>{"源码"}</span>
              </button>
            </div>
            <CardFollowupButton
              snippet={artifact.code}
              source={`${badgeLabel} · ${artifact.title}`}
              title={artifact.title}
            />
            <CopyButton className="chat-draft-copy" size="sm" value={artifact.code} variant="ghost">
              {"复制"}
            </CopyButton>
            <button
              aria-label="全屏查看"
              className="chat-card-followup-btn"
              data-testid="artifact-expand-btn"
              onClick={() => setOpen(true)}
              title="放大查看"
              type="button"
            >
              <IconMaximize aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        </header>
        <div className="chat-doc-inset chat-artifact-inset">
          {tab === "preview" ? (
            renderPreview(false)
          ) : (
            <div className="chat-doc-inner p-3">
              <SmoothStreamdown components={components as never}>{artifact.rawMarkdown}</SmoothStreamdown>
            </div>
          )}
        </div>
      </section>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="chat-doc-dialog">
          <DialogHeader className="chat-doc-dialog-head">
            <div className="chat-doc-dialog-title-wrap">
              <span className="chat-artifact-badge">{badgeLabel}</span>
              <DialogTitle className="truncate">{artifact.title}</DialogTitle>
            </div>
            <div className="mr-7 flex items-center gap-1.5">
              <CardFollowupButton
                onDone={() => setOpen(false)}
                snippet={artifact.code}
                source={`${badgeLabel} · ${artifact.title}`}
                title={artifact.title}
              />
              <CopyButton className="chat-draft-copy" size="sm" value={artifact.code} variant="ghost">
                {"复制"}
              </CopyButton>
            </div>
          </DialogHeader>
          <div className="chat-doc-dialog-body">{renderPreview(true)}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}

type BriefSection = {
  heading: string;
  items: string[];
  kind: "calendar" | "mail" | "reminder" | "highlight";
};

function parseBriefBody(raw: string, fallbackTitle?: string) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let title = fallbackTitle || "今日晨报";
  let dateStr = "";
  let weather = "";
  let greeting = "";
  const sections: BriefSection[] = [];
  let curSection: BriefSection | null = null;

  const inferKind = (h: string): BriefSection["kind"] => {
    if (/日程|日历|会议|calendar|agenda|schedule/i.test(h)) return "calendar";
    if (/邮件|收件箱|信件|mail|inbox|email/i.test(h)) return "mail";
    if (/提醒|待办|定时|todo|reminder|task/i.test(h)) return "reminder";
    return "highlight";
  };

  for (const rawLine of lines) {
    const l = rawLine.trim();
    if (!l) continue;
    const meta = /^(日期|date|天气|weather|问候|导语|greeting|标题|title)\s*[：:]\s*(.+)$/i.exec(l);
    if (meta && sections.length === 0 && !curSection) {
      const k = meta[1]!.toLowerCase();
      const v = meta[2]!.trim();
      if (k === "标题" || k === "title") title = v;
      else if (k === "日期" || k === "date") dateStr = v;
      else if (k === "天气" || k === "weather") weather = v;
      else if (k === "问候" || k === "导语" || k === "greeting") greeting = v;
      continue;
    }
    const hm = /^#{1,4}\s+(.+)$/.exec(l);
    if (hm) {
      const h = hm[1]!.trim();
      curSection = { heading: h, items: [], kind: inferKind(h) };
      sections.push(curSection);
      continue;
    }
    const cleanInline = (s: string) =>
      s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").trim();
    const bm = /^(?:[-*+]|\d+[.)、])\s+(.+)$/.exec(l);
    if (bm) {
      if (!curSection) {
        curSection = { heading: "今日要点", items: [], kind: "highlight" };
        sections.push(curSection);
      }
      curSection.items.push(cleanInline(bm[1]!));
      continue;
    }
    if (!curSection && !greeting) {
      greeting = cleanInline(l);
    } else if (curSection) {
      curSection.items.push(cleanInline(l));
    }
  }

  return { title, dateStr, weather, greeting, sections };
}

/**
 * 每日晨报卡片（CB-014，Hark 风格杂志式晨报）：
 * 聚合天气、今日日程、未读邮件、定时提醒与重点事项，支持卡片追问与弹窗精读。
 */
export function BriefCard({
  text,
  title,
  components,
}: {
  text: string;
  title?: string | undefined;
  components: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => parseBriefBody(text, title), [text, title]);

  return (
    <>
      <section
        aria-label={parsed.title}
        className="chat-draft-card chat-brief-card"
        data-testid="chat-brief-card"
      >
        <header className="chat-brief-hero">
          <div className="chat-brief-hero-top">
            <div className="chat-brief-badge">
              <IconSun aria-hidden="true" className="size-4 text-amber-400" />
              <span>{"MORNING BRIEF"}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {parsed.weather ? (
                <span className="chat-brief-weather" data-testid="brief-weather-pill">
                  {parsed.weather}
                </span>
              ) : null}
              <CardFollowupButton
                snippet={parsed.greeting || text}
                source={`晨报 · ${parsed.title}`}
                title={parsed.title}
              />
            </div>
          </div>
          <div className="chat-brief-title-row">
            <h3 className="chat-brief-title">{parsed.title}</h3>
            {parsed.dateStr ? <span className="chat-brief-date">{parsed.dateStr}</span> : null}
          </div>
          {parsed.greeting ? <p className="chat-brief-greeting">{parsed.greeting}</p> : null}
        </header>

        <div className="chat-brief-grid">
          {parsed.sections.length > 0 ? (
            parsed.sections.slice(0, 4).map((sec, idx) => (
              <div
                className="chat-brief-tile"
                data-brief-kind={sec.kind}
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态顺序
                key={idx}
              >
                <div className="chat-brief-tile-head">
                  {sec.kind === "calendar" ? (
                    <IconCalendarEvent aria-hidden="true" className="size-3.5 text-sky-400" />
                  ) : sec.kind === "mail" ? (
                    <IconMail aria-hidden="true" className="size-3.5 text-indigo-400" />
                  ) : (
                    <IconSparkles aria-hidden="true" className="size-3.5 text-amber-400" />
                  )}
                  <span className="chat-brief-tile-title">{sec.heading}</span>
                </div>
                <ul className="chat-brief-tile-list">
                  {sec.items.slice(0, 3).map((item, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 静态顺序
                    <li key={j}>{item}</li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <div className="chat-doc-inner p-3">
              <SmoothStreamdown components={components as never}>{text}</SmoothStreamdown>
            </div>
          )}
        </div>

        <button
          className="chat-doc-more chat-brief-more"
          data-testid="chat-brief-more"
          onClick={() => setOpen(true)}
          type="button"
        >
          <span>{"展开完整晨报"}</span>
          <IconMaximize aria-hidden="true" className="size-3.5" />
        </button>
      </section>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="chat-doc-dialog" data-testid="chat-brief-dialog">
          <DialogHeader className="chat-doc-dialog-head">
            <div className="chat-doc-dialog-title-wrap">
              <IconSun aria-hidden="true" className="size-4 shrink-0 text-amber-400" />
              <DialogTitle className="truncate">{parsed.title}</DialogTitle>
              {parsed.weather ? <span className="chat-brief-weather ml-2">{parsed.weather}</span> : null}
            </div>
            <div className="mr-7 flex items-center gap-1.5">
              <CardFollowupButton
                onDone={() => setOpen(false)}
                snippet={parsed.greeting || text}
                source={`晨报 · ${parsed.title}`}
                title={parsed.title}
              />
              <CopyButton className="chat-draft-copy" size="sm" value={text} variant="ghost">
                {"复制"}
              </CopyButton>
            </div>
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
