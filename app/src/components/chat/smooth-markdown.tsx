import { type ComponentProps, useContext, useRef } from "react";
import {
  Block,
  type BlockProps,
  parseMarkdownIntoBlocks,
  Streamdown,
} from "streamdown";
import { cjkFriendlyEmphasis } from "@/lib/chat/cjk-emphasis";
import { type MdTail, MdTailContext, withMdCache } from "@/lib/chat/md-cache";
import { STREAMDOWN_ZH } from "@/lib/chat/streamdown-zh";
import { useSmoothText } from "@/lib/chat/use-smooth-text";
import { workspaceLinks } from "@/lib/chat/workspace-links";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";

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
export function SmoothStreamdown({
  children,
  ...props
}: Omit<ComponentProps<typeof Streamdown>, "children"> & { children: string }) {
  const shown = useSmoothText(children ?? "");
  // 工作区文件链接换成这个机器人的下载地址（§101）；在看的就是这个机器人的对话。
  const bot = useDeclaredBotId();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  // 挂载后内容变过就算「流式中」：此后末块不入缓存。块数在 Streamdown 切块时记下（同一次渲染内先于各块）。
  const first = useRef(children);
  const tail = useRef<MdTail | null>(null);
  if (!tail.current) tail.current = { live: false, count: 0 };
  if (children !== first.current) tail.current.live = true;
  const split = useRef((markdown: string) => {
    const blocks = parseMarkdownIntoBlocks(markdown);
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
        {workspaceLinks(cjkFriendlyEmphasis(shown), bot, origin)}
      </Streamdown>
    </MdTailContext.Provider>
  );
}
