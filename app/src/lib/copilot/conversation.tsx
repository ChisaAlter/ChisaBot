import { createContext, type ReactNode, useContext, useMemo } from "react";

/**
 * Lets transcript-rendered components add a user turn back into the containing conversation.
 */

type Conversation = {
  /** Submit a user turn from a transcript-rendered component. */
  ask: (text: string) => void;
  /**
   * 这次工具调用之后，用户说的第一句话（CB-090）。对话里的选项卡片靠它在刷新 / 换设备后认出「选过哪一个」：
   * 选项点下去就是以用户身份发出 `ask` 的那句话，所以答案就在对话记录里，不用另存。
   */
  replyAfter?: (toolCallId: string) => string | null;
};

const ConversationContext = createContext<Conversation | null>(null);

export function ConversationProvider({
  ask,
  replyAfter,
  children,
}: {
  ask: (text: string) => void;
  replyAfter?: (toolCallId: string) => string | null;
  children: ReactNode;
}) {
  // Keep context identity stable across unrelated composer renders.
  const value = useMemo(() => ({ ask, replyAfter }), [ask, replyAfter]);
  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

/** The conversation this component is drawn in, if it is drawn in one. */
export function useConversation(): Conversation | null {
  return useContext(ConversationContext);
}

type MessageLike = {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: readonly { id?: string }[] | null;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/**
 * 某次工具调用之后的第一条用户消息（去掉首尾空白）；还没有就是 null。
 * 认得两种写法：助手消息的 `toolCalls[].id`，或者工具结果消息的 `toolCallId`——取更靠后的那个位置往后找。
 */
export function replyAfterToolCall(
  messages: readonly MessageLike[],
  toolCallId: string,
): string | null {
  let at = -1;
  messages.forEach((message, index) => {
    if (message.toolCallId === toolCallId || message.toolCalls?.some((call) => call.id === toolCallId)) {
      at = index;
    }
  });
  if (at < 0) return null;
  for (let index = at + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user") {
      const said = textOf(message.content).trim();
      return said || null;
    }
  }
  return null;
}
