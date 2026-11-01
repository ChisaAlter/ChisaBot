import { botsTarget, isBotsChatPath } from "@/lib/bots-location";

export type ComposerQuotePayload = {
  text: string;
  source?: string | undefined;
  messageId?: string | undefined;
  prompt?: string | undefined;
};

export const CHISABOT_QUOTE_EVENT = "chisabot-quote";
export const CHISABOT_SPOTLIGHT_EVENT = "chisabot-spotlight";

export function openQuickSpotlight(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHISABOT_SPOTLIGHT_EVENT));
}

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

export function sendPromptToChat(
  navigate: (opts: never) => unknown,
  text: string,
  sourceLabel?: string,
): void {
  const trimmed = text.trim();
  if (!trimmed || typeof window === "undefined") return;
  const fire = () => {
    if (sourceLabel) {
      dispatchComposerQuote({ text: trimmed, source: sourceLabel });
    } else {
      window.dispatchEvent(new CustomEvent("chisabot-prefill", { detail: trimmed }));
    }
  };
  const hadComposer = Boolean(document.querySelector(".glass-composer"));
  if (!isBotsChatPath(window.location.pathname)) {
    const target = botsTarget();
    void navigate(target as never);
  }
  if (hadComposer) {
    fire();
  } else {
    window.setTimeout(fire, 120);
  }
}
