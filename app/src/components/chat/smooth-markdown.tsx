import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { cjkFriendlyEmphasis } from "@/lib/chat/cjk-emphasis";
import { escapeUnknownTags } from "@/lib/chat/escape-unknown-tags";
import { workspaceLinks } from "@/lib/chat/workspace-links";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { STREAMDOWN_ZH } from "@/lib/chat/streamdown-zh";
import { useSmoothText } from "@/lib/chat/use-smooth-text";

/**
 * Bot 的 Markdown 回复，流式时按帧匀速放字（use-smooth-text.ts），不再一批一批地蹦。
 *
 * Streamdown 本身就是给流式写的（未闭合的 ** / ``` 先补上），这里只是把喂给它的文字变匀。
 * 历史消息挂载时整段显示；只有挂载之后继续变长的内容才放字。
 */
export function SmoothStreamdown({ children, ...props }: Omit<ComponentProps<typeof Streamdown>, "children"> & { children: string }) {
  const shown = useSmoothText(children ?? "");
  // 正文里的 Vec<String>、Option<T> 不是 HTML：先转义成文字，免得被当未知标签丢掉（escape-unknown-tags.ts）。
  // 工作区文件链接换成这个机器人的下载地址（§101）；在看的就是这个机器人的对话。
  const bot = useDeclaredBotId();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <Streamdown translations={STREAMDOWN_ZH} {...props}>
      {workspaceLinks(cjkFriendlyEmphasis(escapeUnknownTags(shown)), bot, origin)}
    </Streamdown>
  );
}
