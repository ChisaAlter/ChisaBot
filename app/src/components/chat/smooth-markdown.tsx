import type { ComponentProps } from "react";
import type { Streamdown as StreamdownComponent } from "streamdown";
import { lazyPart } from "@/components/ui/lazy-part";
import { cjkFriendlyEmphasis } from "@/lib/chat/cjk-emphasis";
import { workspaceLinks } from "@/lib/chat/workspace-links";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { STREAMDOWN_ZH } from "@/lib/chat/streamdown-zh";
import { useSmoothText } from "@/lib/chat/use-smooth-text";
import { useEffect, useRef, useState } from "react";
import {
  type BlockParser,
  createIncrementalBlockParser,
  loadedFullBlockParser,
  loadFullBlockParser,
} from "@/lib/chat/incremental-blocks";

type StreamdownProps = ComponentProps<typeof StreamdownComponent>;

/*
 * Streamdown（连同 Markdown 解析、代码高亮、公式）用到才下载（DESIGN.md §41.5）：这个组件也被右侧面板、预览卡片
 * 引用，静态 import 会让设置页之类不显示 Markdown 的页面首屏也下载 ~180KB gzip。没下完之前先按原样显示文字
 * （保留换行），下完同步换成渲染结果；聊天页本身静态带着 Streamdown，那里不会看到这一步。
 */
const Streamdown = lazyPart<StreamdownProps>(
  () => import("streamdown").then((m) => m.Streamdown),
  (props) => (
    <div className={props.className} style={{ whiteSpace: "pre-wrap" }}>
      {typeof props.children === "string" ? props.children : null}
    </div>
  ),
);

/**
 * Bot 的 Markdown 回复，流式时按帧匀速放字（use-smooth-text.ts），不再一批一批地蹦。
 *
 * Streamdown 本身就是给流式写的（未闭合的 ** / ``` 先补上），这里只是把喂给它的文字变匀。
 * 历史消息挂载时整段显示；只有挂载之后继续变长的内容才放字。
 */
export function SmoothStreamdown({
  children,
  ...props
}: Omit<StreamdownProps, "children"> & { children: string }) {
  const shown = useSmoothText(children ?? "");
  // 工作区文件链接换成这个机器人的下载地址（§101）；在看的就是这个机器人的对话。
  const bot = useDeclaredBotId();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const growing = useGrowing(shown);
  const parseBlocks = useIncrementalBlocks(growing);
  return (
    <Streamdown
      translations={STREAMDOWN_ZH}
      // 只在文字还在变长时用增量分块；停下来（流式结束）后是 undefined，Streamdown 用它默认的整段分块再切一次，
      // 万一增量分块和整段有出入，也在这里纠正回来。
      parseMarkdownIntoBlocksFn={parseBlocks}
      {...props}
    >
      {workspaceLinks(cjkFriendlyEmphasis(shown), bot, origin)}
    </Streamdown>
  );
}

/** 停下来多久算流式结束：比两帧之间、两段 SSE 之间的空隙都长，又短到看不出来。 */
const SETTLE_MS = 400;

/** 文字挂载之后还在变长时为 true；停下 SETTLE_MS 后变回 false。历史消息挂载时一直是 false。 */
function useGrowing(text: string): boolean {
  const [growing, setGrowing] = useState(false);
  const mountedText = useRef<string | null>(text);
  useEffect(() => {
    // 挂载时那一份不算「在长」；之后任何一次变化都算（包括 StrictMode 下的重复执行，最多多 400ms 增量）。
    if (mountedText.current === text) return;
    mountedText.current = null;
    setGrowing(true);
    const timer = setTimeout(() => setGrowing(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return growing;
}

/**
 * 每条消息一个增量分块器：流式时只重切没定型的那段，前面封口的块原样复用（incremental-blocks.ts）。
 * 整段分块函数从懒加载的 streamdown 模块里拿；拿到之前、以及不在流式时返回 undefined（Streamdown 用默认的整段分块）。
 */
function useIncrementalBlocks(enabled: boolean): BlockParser | undefined {
  const [parser, setParser] = useState<BlockParser | null>(() => {
    const full = loadedFullBlockParser();
    return full ? createIncrementalBlockParser(full) : null;
  });
  useEffect(() => {
    if (parser || !enabled) return;
    let alive = true;
    loadFullBlockParser().then(
      (full) => {
        if (alive) setParser(() => createIncrementalBlockParser(full));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [parser, enabled]);
  return enabled && parser ? parser : undefined;
}
