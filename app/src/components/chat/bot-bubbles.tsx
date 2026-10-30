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
import DOMPurify from "dompurify";
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
  const normalizedDisplay = useMemo(() => normalizeDirectiveCards(display), [display]);
  const segments = useMemo(() => splitBubbles(normalizedDisplay), [normalizedDisplay]);
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

export type ParsedStatusCard = {
  title: string;
  status?: string;
  body: string;
};

export function normalizeDirectiveCards(raw: string): string {
  const normalizedNewlines = raw.replace(/\r\n?/g, "\n");
  const rawLines = normalizedNewlines.split("\n");
  const step1: string[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const line = (rawLines[i] ?? "").trim();

    if (line === ":::group") {
      const groupLines: string[] = [rawLines[i]!];
      i++;
      let inCard = false;
      while (i < rawLines.length) {
        const cur = (rawLines[i] ?? "").trim();
        groupLines.push(rawLines[i]!);
        i++;
        if (cur.startsWith(":::card")) {
          inCard = true;
        } else if (cur === ":::") {
          if (inCard) {
            inCard = false;
          } else {
            break;
          }
        }
      }
      step1.push("```cards", ...groupLines, "```");
      continue;
    }

    if (line.startsWith(":::card")) {
      const cardLines: string[] = [rawLines[i]!];
      i++;
      while (i < rawLines.length) {
        const cur = (rawLines[i] ?? "").trim();
        cardLines.push(rawLines[i]!);
        i++;
        if (cur === ":::") break;
      }
      step1.push("```cards", ...cardLines, "```");
      continue;
    }

    // 独立一行的站内操作胶囊（如 `[连接 Google](/settings/connected-accounts)`）自动前后留空行，拆成独立胶囊段
    if (/^\[([^\]]{2,32})\]\((\/[a-zA-Z0-9/_?=&#-]*)\)$/.test(line)) {
      if (step1.length > 0 && step1[step1.length - 1]?.trim() !== "") {
        step1.push("");
      }
      step1.push(line);
      if (i + 1 < rawLines.length && rawLines[i + 1]?.trim() !== "") {
        step1.push("");
      }
      i++;
      continue;
    }

    step1.push(rawLines[i]!);
    i++;
  }

  const joined = step1.join("\n");
  // 若模型输出了多小节结构化长文（≥2 个 Markdown 小标题 + 列表/表格，且未手工包裹 ```doc），
  // 自动把中间的结构化长文段合并为 Hark 风格的 ```doc 摘要卡，保留开头导语气泡与末尾跟进建议气泡。
  if (
    !/^(`{3,}|~{3,})\s*(doc|document|summary|report|brief|morning-brief|daily-brief|cards|draft)\b/im.test(
      joined,
    )
  ) {
    return autoWrapMultiSectionDoc(joined);
  }
  return joined;
}

function autoWrapMultiSectionDoc(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  const headingIndices: number[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = (lines[idx] ?? "").trim();
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,4}\s+\S/.test(trimmed)) {
      headingIndices.push(idx);
    }
  }
  if (headingIndices.length < 2) return text;

  const firstHeadingIdx = headingIndices[0]!;
  const lastHeadingIdx = headingIndices[headingIndices.length - 1]!;
  // 找到最后一个小节结束的位置：如果末尾有一段简短的普通话（非列表、非表格、非标题），留作结尾跟进气泡
  let docEndIdx = lines.length - 1;
  while (docEndIdx > lastHeadingIdx && !(lines[docEndIdx] ?? "").trim()) {
    docEndIdx--;
  }
  // 检查最后一个非空段落是不是简短收尾句（无列表符号、无标题、≤120 字）
  let tailStart = docEndIdx;
  while (tailStart > lastHeadingIdx && (lines[tailStart] ?? "").trim() !== "") {
    tailStart--;
  }
  if (tailStart > lastHeadingIdx) {
    const tailParaLines = lines.slice(tailStart + 1, docEndIdx + 1);
    const tailText = tailParaLines.join("\n").trim();
    const isPlainFollowup =
      tailParaLines.length <= 2 &&
      tailText.length > 0 &&
      tailText.length <= 120 &&
      !tailParaLines.some((l) => /^(\s*[-*+]|\s*\d+[.)]|\s*#|\s*\||\[[^\]]+\]\(\/)/.test(l));
    if (isPlainFollowup) {
      docEndIdx = tailStart - 1;
      while (docEndIdx > lastHeadingIdx && !(lines[docEndIdx] ?? "").trim()) {
        docEndIdx--;
      }
    }
  }

  const docLines = lines.slice(firstHeadingIdx, docEndIdx + 1);
  const nonEmptyDocLines = docLines.filter((l) => l.trim().length > 0);
  const listOrTableLines = nonEmptyDocLines.filter((l) =>
    /^(\s*[-*+]|\s*\d+[.)]|\s*\|)/.test(l),
  );
  if (nonEmptyDocLines.length < 5 || listOrTableLines.length < 2) {
    return text;
  }

  // 提取卡片标题：如果第一行是 # 或 ## 总标题则取它；否则从导语或第一个小标题提炼
  const firstHeadingLine = (docLines[0] ?? "").trim();
  const hMatch = /^(#{1,4})\s+(.+)$/.exec(firstHeadingLine);
  let docTitle = "结构化执行摘要";
  const bodyLines = [...docLines];
  if (hMatch) {
    const hashes = hMatch[1]!;
    const rawHeadingText = hMatch[2]!.replace(/[*_`~]+/g, "").trim();
    if (hashes.length <= 2 && !/^[1一(（]/.test(rawHeadingText)) {
      docTitle = rawHeadingText.slice(0, 40);
      bodyLines.shift();
    } else {
      const leadText = lines
        .slice(0, firstHeadingIdx)
        .join(" ")
        .replace(/[*_`~：:。！!？?]+/g, " ")
        .trim();
      const leadMatch = /(?:整理了|汇总了|生成了|如下|关于)\s*([^，,。：:\s]{3,22})/.exec(leadText);
      docTitle = (leadMatch?.[1] ?? rawHeadingText.replace(/^[0-9一二三四五六七八九十]+[、.．)\s]+/, "")).slice(0, 36) || "重点事项总览";
    }
  }

  const before = lines.slice(0, firstHeadingIdx).join("\n").trim();
  const after = lines.slice(docEndIdx + 1).join("\n").trim();
  const parts: string[] = [];
  if (before) parts.push(before);
  parts.push(["````doc", `标题：${docTitle}`, ...bodyLines, "````"].join("\n"));
  if (after) parts.push(after);
  return parts.join("\n\n");
}

export function parseStatusCardsFence(rawText: string): ParsedStatusCard[] | null {
  const lines = rawText.replace(/\r\n?/g, "\n").split("\n");
  const first = (lines[0] ?? "").trim();
  if (!/^```+cards\b/i.test(first)) return null;
  const inner = lines.slice(1);
  if (inner.length > 0 && /^```+$/.test((inner[inner.length - 1] ?? "").trim())) {
    inner.pop();
  }

  const cards: ParsedStatusCard[] = [];
  let curCard: { title: string; status?: string; bodyLines: string[] } | null = null;

  for (const rawLine of inner) {
    const trimmed = rawLine.trim();
    if (trimmed === ":::group") continue;
    if (trimmed.startsWith(":::card")) {
      if (curCard) {
        cards.push({
          title: curCard.title,
          ...(curCard.status ? { status: curCard.status } : {}),
          body: curCard.bodyLines.join("\n").trim(),
        });
      }
      const titleMatch = /title="([^"]+)"/.exec(trimmed);
      const statusMatch = /status="([^"]+)"/.exec(trimmed);
      curCard = {
        title: titleMatch?.[1]?.trim() || "信息卡片",
        status: statusMatch?.[1]?.trim(),
        bodyLines: [],
      };
      continue;
    }
    if (trimmed === ":::") {
      if (curCard) {
        cards.push({
          title: curCard.title,
          ...(curCard.status ? { status: curCard.status } : {}),
          body: curCard.bodyLines.join("\n").trim(),
        });
        curCard = null;
      }
      continue;
    }
    if (curCard) {
      curCard.bodyLines.push(rawLine);
    }
  }
  if (curCard) {
    cards.push({
      title: curCard.title,
      ...(curCard.status ? { status: curCard.status } : {}),
      body: curCard.bodyLines.join("\n").trim(),
    });
  }
  return cards.length > 0 ? cards : null;
}

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

function parseActionPillSegment(rawText: string): { label: string; href: string } | null {
  const trimmed = rawText.trim();
  const match = /^\[([^\]]{2,32})\]\((\/[a-zA-Z0-9/_?=&#-]*)\)$/.exec(trimmed);
  if (!match) return null;
  const label = match[1]!.replace(/[*_`~]+/g, "").trim();
  const href = match[2]!.trim();
  if (!label || !href) return null;
  return { label, href };
}

function HarkActionPill({ label, href }: { label: string; href: string }) {
  const lower = `${label} ${href}`.toLowerCase();
  const isGoogle = lower.includes("google") || lower.includes("gmail");
  const isCalendar = lower.includes("日历") || lower.includes("calendar");
  const isMail = lower.includes("邮箱") || lower.includes("邮件") || lower.includes("mail");
  return (
    <a
      className="hark-action-pill"
      data-testid="hark-action-pill"
      href={href}
    >
      {isGoogle ? (
        <svg aria-hidden="true" className="size-4 shrink-0" viewBox="0 0 24 24">
          <path
            d="M21.805 10.023h-9.765v3.954h5.617c-.242 1.296-.977 2.391-2.086 3.125v2.594h3.375c1.977-1.82 3.117-4.5 3.117-7.688 0-.664-.062-1.305-.258-1.985z"
            fill="#4285F4"
          />
          <path
            d="M12.04 22c2.812 0 5.172-.93 6.898-2.523l-3.375-2.594c-.937.633-2.133 1.008-3.523 1.008-2.711 0-5.008-1.828-5.828-4.289H2.727v2.68C4.445 19.695 7.969 22 12.04 22z"
            fill="#34A853"
          />
          <path
            d="M6.212 13.602A5.996 5.996 0 0 1 5.89 11.99c0-.562.102-1.109.32-1.617V7.693H2.727A9.963 9.963 0 0 0 1.65 11.99c0 1.617.39 3.148 1.077 4.305l3.485-2.693z"
            fill="#FBBC05"
          />
          <path
            d="M12.04 5.969c1.531 0 2.906.523 3.992 1.562l2.992-2.992C17.204 2.844 14.852 1.98 12.04 1.98 7.969 1.98 4.445 4.285 2.727 7.693l3.485 2.68c.82-2.461 3.117-4.404 5.828-4.404z"
            fill="#EA4335"
          />
        </svg>
      ) : isCalendar ? (
        <IconCalendarEvent aria-hidden="true" className="size-4 shrink-0 text-[#2563eb]" />
      ) : isMail ? (
        <IconMail aria-hidden="true" className="size-4 shrink-0 text-[#2563eb]" />
      ) : (
        <IconSparkles aria-hidden="true" className="size-4 shrink-0 text-[#14171f]" />
      )}
      <span>{label}</span>
    </a>
  );
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
    const statusCards = parseStatusCardsFence(seg.text);
    if (statusCards) {
      return (
        <>
          {quoteNode}
          <StatusCardGroup cards={statusCards} components={components} />
        </>
      );
    }
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
  if (seg.kind === "text") {
    const actionPill = parseActionPillSegment(seg.text);
    if (actionPill) {
      return (
        <>
          {quoteNode}
          <HarkActionPill href={actionPill.href} label={actionPill.label} />
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

/** 文档卡「展开全文 / 阅读全文」的图标：卡片每个 token 重渲，图标元素不变（P2-1）。 */
const DOC_MORE_TALL_ICON = <IconChevronDown aria-hidden="true" className="size-3.5" />;
const DOC_MORE_ICON = <IconMaximize aria-hidden="true" className="size-3.5" />;

/** 「追问」按钮的内容：流式时摘要每个 token 都变，图标和字不变，放模块级（P2-1）。 */
const FOLLOWUP_CONTENT = (
  <>
    <IconMessageReply aria-hidden="true" className="size-3.5" />
    <span>{"追问"}</span>
  </>
);

/** 卡片级「追问」按钮：将卡片标题和摘要塞入输入框引用栏。 */
function CardFollowupButtonImpl({
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
      {FOLLOWUP_CONTENT}
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

/** 文档卡收起时的高度（px）：对齐 Hark summary-card 的约 6–7 行紧凑预览。 */
export const DOC_COLLAPSED_PX = 168;

/**
 * 文档卡（DESIGN.md §76，Hark 的 summary-card 体验）：
 * 外层 24px 圆角深色毛玻璃卡片（padding: 8px, maxWidth: 440px）+ 顶部标题（悬停渐显追问/复制），
 * 内嵌 18px 圆角深色正文预览框（底部渐隐遮罩）；点击卡片任意非按钮区域弹出居中阅读文档窗（带顶部圆形收起按钮与大号衬线标题）。
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
    setTall(text.trim().length > 0 && el.scrollHeight > DOC_COLLAPSED_PX + 20);
  }, [text]);
  const heading = title || "文档";
  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 卡片内含显式 button 供键盘聚焦打开弹窗 */}
      <section
        aria-label={title ? `文档：${title}` : "文档"}
        className="chat-draft-card chat-doc-card"
        data-testid="chat-doc-card"
        onClick={(event) => {
          const sel = typeof window !== "undefined" ? window.getSelection() : null;
          if (sel && sel.toString().length > 0) return;
          if ((event.target as HTMLElement | null)?.closest("a, button")) return;
          setOpen(true);
        }}
      >
        <header className="chat-doc-head">
          <div className="chat-doc-head-main">
            <span className="chat-doc-title">{heading}</span>
          </div>
          <div className="chat-doc-head-actions">
            <CardFollowupButton snippet={text} source={`文档 · ${heading}`} title={heading} />
            <CopyButton className="chat-draft-copy" size="sm" value={text} variant="ghost">
              {"复制"}
            </CopyButton>
          </div>
        </header>
        <div className="chat-doc-inset">
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
            onClick={(e) => {
              e.stopPropagation();
              setOpen(true);
            }}
            type="button"
          >
            <span>{tall ? "展开全文" : "阅读全文"}</span>
            {tall ? DOC_MORE_TALL_ICON : DOC_MORE_ICON}
          </button>
        </div>
      </section>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="chat-doc-dialog">
          <DialogHeader className="chat-doc-dialog-head">
            <div className="chat-doc-dialog-title-wrap">
              <button
                aria-label="收起文档"
                className="chat-doc-collapse-btn"
                data-testid="chat-doc-collapse-btn"
                onClick={() => setOpen(false)}
                title="收起文档 (Esc)"
                type="button"
              >
                <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
                  <path
                    d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                  />
                </svg>
              </button>
              <DialogTitle className="sr-only">{heading}</DialogTitle>
            </div>
            <div className="flex items-center gap-1.5">
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
            <h1 className="chat-doc-sheet-title">{heading}</h1>
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

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
/** 卡片内只允许引用文档内的片段（`#id`）。 */
const SVG_LOCAL_REF = /^#[\w.:-]*$/;
/** `<image>` / `<feImage>` 额外允许内嵌位图；data:image/svg+xml、外部地址一律不行。 */
const SVG_EMBEDDED_RASTER =
  /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]*$/i;
const SVG_URL_ATTRS = new Set(["href", "xlink:href", "src"]);

/**
 * DOMPurify（SVG profile）的配置。DOMPurify 本身已经不放行 `<script>` / `<foreignObject>` /
 * `<animate>` / `<set>` 和所有 `on*` 属性；这里再显式列一遍，免得以后放宽 profile 时漏掉。
 * `<use>` 不在 DOMPurify 的 SVG 白名单里，单独放行，它的 href 由下面的钩子限制成 `#id`。
 */
const SVG_PURIFY_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ["use"],
  // animateTransform / animateMotion 的取值。能改 href 的 <animate> / <set> 已经整个禁掉，这几个属性只影响变换和位移。
  ADD_ATTR: ["from", "to", "by"],
  FORBID_TAGS: [
    "script",
    "foreignObject",
    "iframe",
    "object",
    "embed",
    "animate",
    "set",
    "handler",
    "listener",
  ],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true as const,
};

type SvgPurifier = ReturnType<typeof DOMPurify>;
type SvgWindow = Window & typeof globalThis;
let svgPurifier: { win: SvgWindow; purifier: SvgPurifier } | null = null;

/** 每个 window 一个独立实例：钩子只挂在这个实例上，不影响别处（如 docx 预览）对 DOMPurify 的使用。 */
function getSvgPurifier(win: SvgWindow): SvgPurifier | null {
  if (svgPurifier?.win === win) return svgPurifier.purifier;
  const purifier = DOMPurify(win);
  if (!purifier.isSupported) return null;
  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    if (!SVG_URL_ATTRS.has(data.attrName.toLowerCase())) return;
    const value = data.attrValue.trim();
    const tag = node.nodeName.toLowerCase();
    const allowed =
      SVG_LOCAL_REF.test(value) ||
      ((tag === "image" || tag === "feimage") &&
        SVG_EMBEDDED_RASTER.test(value));
    if (!allowed) data.keepAttr = false;
  });
  svgPurifier = { win, purifier };
  return purifier;
}

/**
 * 净化 ```svg 围栏里的 SVG（审查 S1）：交给 DOMPurify（SVG + SVG filters profile）按白名单清洗，
 * 再用 XMLSerializer 输出成合法的独立 SVG 文档。返回值只给 {@link svgMarkupToDataUrl} 当图片用，
 * 不再插进页面 DOM —— 即便以后白名单有漏洞，图片上下文里的 SVG 也不执行脚本、不加载外部资源、
 * 样式也漏不到主页面。
 *
 * 以前的正则清洗器只认前面带空白的 `on*` 属性，`<image/onerror=…>`、`<animate/onbegin=…>` 能原样通过。
 * 没有 DOM（DOMPurify 不可用）或清洗后根节点不是 `<svg>` 时返回 null，宁可不画也不放行。
 * `win` 只给测试传 jsdom 用（happy-dom 的 nodeName 让 DOMPurify 把所有元素都当成未知标签）。
 */
export function sanitizeSvgMarkup(
  raw: string,
  win: SvgWindow | undefined = typeof window === "undefined"
    ? undefined
    : window,
): string | null {
  const m = /<svg[\s\S]*<\/svg>/i.exec(raw);
  if (!m || !win) return null;
  const purifier = getSvgPurifier(win);
  if (!purifier) return null;
  const fragment = purifier.sanitize(m[0], SVG_PURIFY_CONFIG);
  const root = fragment.firstElementChild;
  if (!root || root.namespaceURI !== SVG_NS || root.localName !== "svg")
    return null;
  let svg = new win.XMLSerializer().serializeToString(root);
  // 独立的 SVG 图片必须带命名空间声明，否则浏览器按 XML 解析失败、显示成破图。
  if (!/^<svg\b[^>]*\sxmlns="/.test(svg))
    svg = svg.replace(/^<svg\b/, `<svg xmlns="${SVG_NS}"`);
  if (svg.includes("xlink:") && !/^<svg\b[^>]*\sxmlns:xlink="/.test(svg)) {
    svg = svg.replace(/^<svg\b/, `<svg xmlns:xlink="${XLINK_NS}"`);
  }
  return svg;
}

/**
 * Mermaid 卡片：本地 mermaid-lite 渲染出的 SVG 再过一遍同一个 purifier 才内联插入。
 * mermaid-lite 用 `<text>` 放标签（没有 foreignObject / htmlLabels），标签文字经过转义；
 * 这一遍是兜底，渲染器将来出漏洞也不会把节点标签里的 `<img onerror>`、`<script>` 带进页面。
 * 继续内联（不走 <img>），所以 `currentColor` / CSS 变量照常跟随主题。
 */
export function sanitizedMermaidSvg(
  code: string,
  win: SvgWindow | undefined = typeof window === "undefined"
    ? undefined
    : window,
): string | null {
  const raw = renderMermaidToSvg(code);
  return raw ? sanitizeSvgMarkup(raw, win) : null;
}

/** 净化后的 SVG 转成 `<img>` 能用的 data URL（图片上下文：不跑脚本、不发请求、样式隔离）。 */
export function svgMarkupToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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
      return sanitizedMermaidSvg(artifact.code) ?? "";
    }
    return "";
  }, [artifact.lang, artifact.code]);

  const svgImageUrl = useMemo(() => {
    if (artifact.lang !== "svg") return "";
    const svg = sanitizeSvgMarkup(artifact.code);
    return svg ? svgMarkupToDataUrl(svg) : "";
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
    if (svgImageUrl) {
      // 用户 / 模型给的 SVG 只当图片显示，不进主页面 DOM（审查 S1）。
      return (
        <div
          className={
            inModal
              ? "chat-artifact-svg chat-artifact-svg-modal"
              : "chat-artifact-svg"
          }
          data-testid="artifact-svg-preview"
        >
          <img
            alt={artifact.title}
            data-testid="artifact-svg-image"
            decoding="async"
            draggable={false}
            src={svgImageUrl}
            style={{ maxWidth: "100%", height: "auto" }}
          />
        </div>
      );
    }
    if (renderedSvg) {
      return (
        <div
          className={
            inModal
              ? "chat-artifact-svg chat-artifact-svg-modal"
              : "chat-artifact-svg"
          }
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid 矢量预览：本地渲染器输出且已过 DOMPurify（sanitizedMermaidSvg）；用户 SVG 走上面的 <img>
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
              <IconSun aria-hidden="true" className="size-4 text-amber-500 dark:text-amber-400" />
              <span>{"今日晨报"}</span>
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

/**
 * `:::group` / `:::card{title="..." status="..."}` 结构化状态卡片与多卡片矩阵：
 * 用于连接器全景、主动巡检动态、邮件代发确认卡片、记忆整理报告与知识库检索结果。
 */
export function StatusCardGroup({
  cards,
  components,
}: {
  cards: ParsedStatusCard[];
  components: Record<string, unknown>;
}) {
  if (cards.length === 1) {
    const card = cards[0]!;
    return (
      <section
        aria-label={card.title}
        className="chat-draft-card chat-doc-card w-full"
        data-testid="chat-status-card"
      >
        <header className="chat-doc-head items-start">
          <div className="chat-doc-head-main min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="chat-doc-title whitespace-normal break-words font-semibold">{card.title}</span>
            {card.status ? (
              <span className="chat-brief-weather shrink-0 text-[11px]">
                {card.status}
              </span>
            ) : null}
          </div>
          <div className="chat-doc-head-actions shrink-0">
            <CardFollowupButton
              snippet={card.body || card.title}
              source={card.title}
              title={card.title}
            />
            <CopyButton className="chat-draft-copy" size="sm" value={card.body} variant="ghost">
              {"复制"}
            </CopyButton>
          </div>
        </header>
        <div className="chat-doc-inset p-3.5">
          <div className="chat-doc-inner text-sm">
            <SmoothStreamdown components={components as never}>{card.body}</SmoothStreamdown>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div
      className="flex w-full flex-col gap-2.5"
      data-testid="chat-status-card-group"
    >
      {cards.map((card, idx) => (
        <section
          aria-label={card.title}
          className="chat-draft-card chat-doc-card w-full"
          data-testid="chat-status-card"
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态卡片组顺序
          key={idx}
        >
          <header className="chat-doc-head items-start">
            <div className="chat-doc-head-main min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="chat-doc-title whitespace-normal break-words font-semibold">{card.title}</span>
              {card.status ? (
                <span className="chat-brief-weather shrink-0 text-[11px]">
                  {card.status}
                </span>
              ) : null}
            </div>
            <div className="chat-doc-head-actions shrink-0">
              <CardFollowupButton
                snippet={card.body || card.title}
                source={card.title}
                title={card.title}
              />
            </div>
          </header>
          <div className="chat-doc-inset p-3">
            <div className="chat-doc-inner text-xs leading-relaxed">
              <SmoothStreamdown components={components as never}>{card.body}</SmoothStreamdown>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

/** 流式时父组件每个 token 都会重渲；props 没变就跳过（jank FIX-PLAN §5 / P2-1）。 */
CardFollowupButtonImpl.displayName = "CardFollowupButton";
const CardFollowupButton = memo(CardFollowupButtonImpl);
