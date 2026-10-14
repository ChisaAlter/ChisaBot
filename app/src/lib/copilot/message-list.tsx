import { CopilotChatMessageView } from "@copilotkit/react-core/v2";
import type { ReactElement } from "react";
import { QueuedMessages } from "@/components/chat/queued-messages";

/**
 * 机器人聊天的消息列表：不虚拟化（2026-10-13，修「AI 输出的时候有时候会跳到聊天记录上面」；DESIGN.md §35）。
 *
 * 根因：CopilotKit 1.77 的消息列表超过 50 条就用 @tanstack/react-virtual 虚拟化，没量过的行按
 * 「已量过的行的平均高度」估算。每当行数变化（发一条消息、流式回复开始、出现思考 / 工具步骤），
 * 所有没量过的行都用新的平均值重新估一遍；长回复把平均值拉高，几十行一起变高，视口上方凭空多出
 * 两三千像素——scrollTop 没变，内容整体往下推，眼前换成了更早的聊天记录，然后贴底动画再把它拖回去。
 * 实测（tests/chat-scroll/repro.mjs，64 条历史）：发送那一帧 scrollHeight +2958px，视口最上面那条从第 63 条
 * 退到第 61 条，随后 ~400ms 的回弹。用户上滑看历史时同样的估算抖动也会让正在看的内容错位。
 *
 * 修法：给 messageView 传 `children` 渲染函数（CopilotKit 文档里关闭虚拟化的正式写法），所有消息
 * 都挂载、高度都是真实的，贴底 / 上滑不再被估算值打乱。消息组件本身是 memo 的，流式时只有最后一条
 * 重渲染；顺带让 turn-compaction 在长会话里也能工作（虚拟化时 `.copilotKitMessages` 下面只有一个
 * 包裹层，它找不到消息）。屏幕外旧消息用 content-visibility（styles.css §35；只按 [data-message-id]
 * 数最后几条，别把光标 / 排队气泡算进去）。本机跑完一轮后同步不要为了服务器还亮着的 running 误重连
 * （use-conversation-sync shouldCatchRunningOnRebase，CB-005）。
 *
 * 结构与 CopilotKit 不虚拟化时自己画的一致：同样的类名 / testid、打断（interrupt）元素、
 * 运行中的光标（最后一条是思考时不画），所以 styles.css 和 turn-compaction 的选择器都照常认得。
 */
export type MessageListRenderProps = {
  isRunning: boolean;
  messages: ReadonlyArray<{ role?: string }>;
  messageElements: ReactElement[];
  interruptElement: ReactElement | null;
};

export function renderUnvirtualizedMessageList({
  isRunning,
  messages,
  messageElements,
  interruptElement,
}: MessageListRenderProps): ReactElement {
  const last = messages[messages.length - 1];
  const showCursor = isRunning && last?.role !== "reasoning";
  return (
    <div
      className="copilotKitMessages cb-message-list"
      data-copilotkit=""
      data-testid="copilot-message-list"
    >
      {messageElements}
      {interruptElement}
      {/* 回答期间发的、还没被读到的消息（DESIGN.md §38.1）。 */}
      <QueuedMessages />
      {showCursor ? (
        <div className="cpk:mt-2">
          <CopilotChatMessageView.Cursor />
        </div>
      ) : null}
    </div>
  );
}
