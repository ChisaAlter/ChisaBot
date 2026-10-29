import { type ComponentProps, useEffect, useRef, useState } from "react";
import { parseMarkdownIntoBlocks, Streamdown } from "streamdown";
import { cjkFriendlyEmphasis } from "@/lib/chat/cjk-emphasis";
import { workspaceLinks } from "@/lib/chat/workspace-links";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { STREAMDOWN_ZH } from "@/lib/chat/streamdown-zh";
import { useSmoothText } from "@/lib/chat/use-smooth-text";
import { createIncrementalBlockParser } from "@/lib/chat/incremental-blocks";

/**
 * Bot 的 Markdown 回复，流式时按帧匀速放字（use-smooth-text.ts），不再一批一批地蹦。
 *
 * Streamdown 本身就是给流式写的（未闭合的 ** / ``` 先补上），这里只是把喂给它的文字变匀。
 * 历史消息挂载时整段显示；只有挂载之后继续变长的内容才放字。
 */
export function SmoothStreamdown({ children, ...props }: Omit<ComponentProps<typeof Streamdown>, "children"> & { children: string }) {
  const shown = useSmoothText(children ?? "");
  // 工作区文件链接换成这个机器人的下载地址（§101）；在看的就是这个机器人的对话。
  const bot = useDeclaredBotId();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  // 每条消息一个分块器：流式时只重切没定型的那段，前面封口的块原样复用（incremental-blocks.ts）。
  const [parseBlocks] = useState(createIncrementalBlockParser);
  const growing = useGrowing(shown);
  return (
    <Streamdown
      translations={STREAMDOWN_ZH}
      // 文字停下来（流式结束）后换回整段解析再切一次：万一增量分块和整段有出入，也在这里纠正回来。
      parseMarkdownIntoBlocksFn={growing ? parseBlocks : parseMarkdownIntoBlocks}
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
