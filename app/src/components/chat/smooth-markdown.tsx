import type { ComponentProps } from "react";
import type { Streamdown as StreamdownComponent } from "streamdown";
import { lazyPart } from "@/components/ui/lazy-part";
import { cjkFriendlyEmphasis } from "@/lib/chat/cjk-emphasis";
import { workspaceLinks } from "@/lib/chat/workspace-links";
import { useDeclaredBotId } from "@/lib/copilot/active-bot";
import { STREAMDOWN_ZH } from "@/lib/chat/streamdown-zh";
import { useSmoothText } from "@/lib/chat/use-smooth-text";

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
export function SmoothStreamdown({ children, ...props }: Omit<StreamdownProps, "children"> & { children: string }) {
  const shown = useSmoothText(children ?? "");
  // 工作区文件链接换成这个机器人的下载地址（§101）；在看的就是这个机器人的对话。
  const bot = useDeclaredBotId();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <Streamdown translations={STREAMDOWN_ZH} {...props}>
      {workspaceLinks(cjkFriendlyEmphasis(shown), bot, origin)}
    </Streamdown>
  );
}
