export type ComposerQuotePayload = {
  text: string;
  source?: string | undefined;
  messageId?: string | undefined;
  prompt?: string | undefined;
};

export const CHISABOT_QUOTE_EVENT = "chisabot-quote";

/**
 * 将一段引文或卡片上下文发送到输入框顶部的「引用追问」胶囊栏。
 */
export function dispatchComposerQuote(payload: ComposerQuotePayload): void {
  if (typeof window === "undefined") return;
  const cleaned = payload.text.replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  window.dispatchEvent(
    new CustomEvent<ComposerQuotePayload>(CHISABOT_QUOTE_EVENT, {
      detail: {
        ...payload,
        text: cleaned.slice(0, 200),
      },
    }),
  );
}
