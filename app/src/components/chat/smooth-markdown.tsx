import { type ComponentProps, memo, useContext, useMemo, useRef } from "react";
import {
  Block,
  type BlockProps,
  parseMarkdownIntoBlocks,
  Streamdown,
} from "streamdown";
import { cjkFriendlyEmphasis } from "@/lib/chat/cjk-emphasis";
import { escapeUnknownTags } from "@/lib/chat/escape-unknown-tags";
import { createIncrementalBlockParser } from "@/lib/chat/incremental-blocks";
import { type MdTail, MdTailContext, withMdCache } from "@/lib/chat/md-cache";
import { STREAMDOWN_ZH } from "@/lib/chat/streamdown-zh";
import { useSmoothText } from "@/lib/chat/use-smooth-text";
import { workspaceLinks } from "@/lib/chat/workspace-links";
import { useDeclaredBotId } from "@/lib/conversations/active-bot";

const FENCE_LINE_RE = /^ {0,3}(?:```|~~~)/gm;
const BACKTICK_FENCE_RE = /```/g;
const COMPLEX_FENCE_RE = /`{4,}|~{3,}/;
const ANCHOR_TAG_RE = /<a\s/i;
const SEAL_MIN_CHUNK = 256;

export function preprocessMarkdownText(
  markdown: string,
  bot: string | undefined,
  origin: string,
): string {
  return workspaceLinks(
    cjkFriendlyEmphasis(escapeUnknownTags(markdown)),
    bot,
    origin,
  );
}

/**
 * 流式 Markdown 三步预处理（escapeUnknownTags → cjkFriendlyEmphasis → workspaceLinks）增量封口器：
 * 在安全的空行段落边界封口稳定前缀，避免 60fps 流式长回复每帧对全文重复跑三连正则。
 * 与整段重跑结果保持严格逐字符等价；非安全边界自动回退整段处理。
 */
export function createIncrementalMarkdownPreprocess() {
  let stableRaw = "";
  let stableOut = "";
  let lastRaw = "";
  let lastOut = "";
  let lastBot: string | undefined;
  let lastOrigin = "";
  let hasLast = false;

  const reset = () => {
    stableRaw = "";
    stableOut = "";
    hasLast = false;
  };

  return (
    markdown: string,
    bot: string | undefined,
    origin: string,
    live: boolean,
  ): string => {
    if (hasLast && markdown === lastRaw && bot === lastBot && origin === lastOrigin) {
      return lastOut;
    }
    if (bot !== lastBot || origin !== lastOrigin) {
      reset();
    }
    if (!live) {
      reset();
      const full = preprocessMarkdownText(markdown, bot, origin);
      lastRaw = markdown;
      lastOut = full;
      lastBot = bot;
      lastOrigin = origin;
      hasLast = true;
      return full;
    }
    if (stableRaw.length > 0 && !markdown.startsWith(stableRaw)) {
      reset();
    }
    // 尝试将稳定前缀推进到最后一个安全的 `\n\n` 段落边界
    if (markdown.length - stableRaw.length >= SEAL_MIN_CHUNK) {
      let searchFrom = markdown.length - 1;
      while (searchFrom > stableRaw.length + 1) {
        const boundary = markdown.lastIndexOf("\n\n", searchFrom);
        if (boundary <= stableRaw.length) break;
        const candidateEnd = boundary + 2;
        const nextChar = markdown[candidateEnd];
        const prevChar = boundary > 0 ? markdown[boundary - 1] : "";
        if (
          nextChar !== undefined &&
          !/\s/.test(nextChar) &&
          prevChar !== "(" &&
          prevChar !== "["
        ) {
          const added = markdown.slice(stableRaw.length, candidateEnd);
          if (
            !COMPLEX_FENCE_RE.test(added) &&
            !ANCHOR_TAG_RE.test(added)
          ) {
            const fenceLines = added.match(FENCE_LINE_RE)?.length ?? 0;
            const backticks = added.match(BACKTICK_FENCE_RE)?.length ?? 0;
            if (fenceLines === backticks && backticks % 2 === 0) {
              stableOut += preprocessMarkdownText(added, bot, origin);
              stableRaw = markdown.slice(0, candidateEnd);
              break;
            }
          }
        }
        searchFrom = boundary - 1;
      }
    }
    const tailRaw =
      stableRaw.length > 0 ? markdown.slice(stableRaw.length) : markdown;
    const out =
      stableRaw.length > 0
        ? stableOut + preprocessMarkdownText(tailRaw, bot, origin)
        : preprocessMarkdownText(tailRaw, bot, origin);
    lastRaw = markdown;
    lastOut = out;
    lastBot = bot;
    lastOrigin = origin;
    hasLast = true;
    return out;
  };
}

/**
 * Streamdown 的块组件换成带解析缓存的版本（md-cache.ts）：渲染仍交给 Streamdown 自己的 `Block`，
 * 只是在它的 rehype 插件列表末尾挂上缓存。正在流式变长的末块只查不存。
 */
export function CachedBlock(props: BlockProps) {
  const tail = useContext(MdTailContext);
  // 有动画插件时每块的 hast 带着时间线状态，不能复用。
  if (props.animatePlugin) return <Block {...props} />;
  const growingTail = !!tail?.live && props.index === tail.count - 1;
  return (
    <Block
      {...props}
      rehypePlugins={withMdCache(props.rehypePlugins, !growingTail)}
    />
  );
}

/**
 * Bot 的 Markdown 回复，流式时按帧匀速放字（use-smooth-text.ts），不再一批一批地蹦。
 *
 * Streamdown 本身就是给流式写的（未闭合的 ** / ``` 先补上），这里只是把喂给它的文字变匀。
 * 历史消息挂载时整段显示；只有挂载之后继续变长的内容才放字。
 */
export const SmoothStreamdown = memo(function SmoothStreamdown({
  children,
  streaming,
  ...props
}: Omit<ComponentProps<typeof Streamdown>, "children"> & {
  children: string;
  streaming?: boolean;
}) {
  const shown = useSmoothText(children ?? "", streaming !== false);
  // 正文里的 Vec<String>、Option<T> 不是 HTML：先转义成文字，免得被当未知标签丢掉（escape-unknown-tags.ts）。
  // 工作区文件链接换成这个机器人的下载地址（§101）；在看的就是这个机器人的对话。
  const bot = useDeclaredBotId();
  const origin =
    typeof window === "undefined" ? "" : (window.location?.origin ?? "");
  // 挂载后内容变过就算「流式中」：此后末块不入缓存。块数在 Streamdown 切块时记下（同一次渲染内先于各块）。
  const first = useRef(children);
  const tail = useRef<MdTail | null>(null);
  if (!tail.current) tail.current = { live: false, count: 0 };
  if (streaming === false) tail.current.live = false;
  else if (streaming === true || children !== first.current)
    tail.current.live = true;
  const isLive = tail.current.live;
  const incPreprocessRef = useRef<ReturnType<
    typeof createIncrementalMarkdownPreprocess
  > | null>(null);
  const processed = useMemo(() => {
    if (!isLive) {
      return preprocessMarkdownText(shown, bot, origin);
    }
    if (!incPreprocessRef.current) {
      incPreprocessRef.current = createIncrementalMarkdownPreprocess();
    }
    return incPreprocessRef.current(shown, bot, origin, true);
  }, [shown, bot, origin, isLive]);
  const incRef = useRef<ReturnType<typeof createIncrementalBlockParser> | null>(
    null,
  );
  if (!incRef.current)
    incRef.current = createIncrementalBlockParser(parseMarkdownIntoBlocks);
  const split = useRef((markdown: string) => {
    const blocks =
      tail.current?.live && incRef.current
        ? incRef.current(markdown)
        : parseMarkdownIntoBlocks(markdown);
    if (tail.current) tail.current.count = blocks.length;
    return blocks;
  }).current;
  return (
    <MdTailContext.Provider value={tail.current}>
      <Streamdown
        translations={STREAMDOWN_ZH}
        BlockComponent={CachedBlock}
        parseMarkdownIntoBlocksFn={split}
        {...props}
      >
        {processed}
      </Streamdown>
    </MdTailContext.Provider>
  );
});
