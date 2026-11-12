import { botsTarget, isBotsChatPath } from "@/lib/bots-location";

export type ComposerQuotePayload = {
  text: string;
  source?: string | undefined;
  messageId?: string | undefined;
  prompt?: string | undefined;
};

export type ComposerInput =
  | { kind: "quote"; quote: ComposerQuotePayload }
  | { kind: "prefill"; text: string };

export const CHISABOT_QUOTE_EVENT = "chisabot-quote";
export const CHISABOT_SPOTLIGHT_EVENT = "chisabot-spotlight";

type PendingInput = { targetPath: string; input: ComposerInput };
type Consumer = {
  targetPath: string;
  active(): boolean;
  consume(input: ComposerInput): void;
};
const pending: PendingInput[] = [];
const consumers = new Set<Consumer>();

/** Input waiting for navigation belongs to the current signed-in session. */
export function clearComposerInputs() {
  pending.length = 0;
}

/** Current route identity, including the Bot selected on the new-topic page. */
export function currentChatTargetPath(): string {
  if (typeof window === "undefined") return "/";
  const path = window.location.pathname;
  if (path === "/channel/new") {
    const agent = new URLSearchParams(window.location.search).get("agent");
    return agent ? `${path}?agent=${encodeURIComponent(agent)}` : path;
  }
  return path;
}

export function composerTargetPath(channelId?: string, draftKey?: string): string {
  if (channelId) return `/channel/${encodeURIComponent(channelId)}`;
  if (draftKey?.startsWith("new:"))
    return `/channel/new?agent=${encodeURIComponent(draftKey.slice(4))}`;
  return "/channel/new";
}

function targetForChat(): string {
  const current = currentChatTargetPath();
  if (isBotsChatPath(current)) return current;
  const target = botsTarget();
  if (target.to === "/channel/new" && typeof target.search?.agent === "string")
    return `${target.to}?agent=${encodeURIComponent(target.search.agent)}`;
  return target.to;
}

/** A retained hidden Composer cannot consume or steal another conversation's input. */
function drain() {
  const current = currentChatTargetPath();
  if (!isBotsChatPath(current)) return;
  const atCurrentRoute = (item: PendingInput) => item.targetPath === current;
  for (let item = pending.find(atCurrentRoute); item; item = pending.find(atCurrentRoute)) {
    const consumer = [...consumers].find(
      (candidate) => candidate.targetPath === current && candidate.active(),
    );
    if (!consumer) return;
    pending.splice(pending.indexOf(item), 1);
    consumer.consume(item.input);
  }
}

/** A real route redirect carries only inputs addressed to that source route. */
export function transferComposerInputs(from: string, to: string): void {
  if (from === to) return;
  for (const item of pending) {
    if (item.targetPath === from) item.targetPath = to;
  }
  drain();
}

export function receiveComposerInputs(consumer: Consumer) {
  consumers.add(consumer);
  drain();
  return {
    flush: drain,
    dispose: () => consumers.delete(consumer),
  };
}

function enqueue(input: ComposerInput, targetPath = targetForChat()) {
  pending.push({ targetPath, input });
  drain();
  return targetPath;
}

export function openQuickSpotlight(): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(CHISABOT_SPOTLIGHT_EVENT));
}

/** Store the target before navigation; the target Composer consumes once when ready. */
export function dispatchComposerQuote(payload: ComposerQuotePayload): void {
  if (typeof window === "undefined") return;
  const cleaned = payload.text.replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  const quote = { ...payload, text: cleaned.slice(0, 200) };
  const targetPath = enqueue({ kind: "quote", quote });
  window.dispatchEvent(new CustomEvent(CHISABOT_QUOTE_EVENT, {
    detail: { ...quote, targetPath },
  }));
}

export function dispatchComposerPrefill(text: string): void {
  const trimmed = text.trim();
  if (trimmed && typeof window !== "undefined")
    enqueue({ kind: "prefill", text: trimmed });
}

export function dispatchChatAsk(text: string): void {
  const trimmed = text.trim();
  if (trimmed && typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent("chisabot-ask", {
      detail: { text: trimmed, targetPath: currentChatTargetPath() },
    }));
}

export function sendPromptToChat(
  navigate: (opts: never) => unknown,
  text: string,
  sourceLabel?: string,
): void {
  const trimmed = text.trim();
  if (!trimmed || typeof window === "undefined") return;
  const targetPath = targetForChat();
  enqueue(sourceLabel
    ? { kind: "quote", quote: { text: trimmed.slice(0, 200), source: sourceLabel } }
    : { kind: "prefill", text: trimmed }, targetPath);
  if (!isBotsChatPath(window.location.pathname))
    void navigate(botsTarget() as never);
}
