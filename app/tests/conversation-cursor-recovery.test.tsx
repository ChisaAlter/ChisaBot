import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ConversationSession } from "@/lib/chat/session-client";
import type { ThreadActivity } from "@/lib/conversations/bot-thread";
import { useConversationSync } from "@/lib/conversations/use-conversation-sync";
import { settleReactWork } from "./settle-react-work";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
const listeners = new Set<(activity: ThreadActivity) => void>();
const onActivity = (listener: (activity: ThreadActivity) => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const connect = ({ agent }: { agent: ConversationSession }) => agent.connectAgent();
const cache = new QueryClient();

beforeAll(() => { GlobalRegistrator.register(); });
afterEach(() => { cleanup(); cache.clear(); globalThis.fetch = originalFetch; });
afterAll(async () => { await settleReactWork(); GlobalRegistrator.unregister(); });

function Observe({ agent }: { agent: ConversationSession }) {
  useConversationSync(agent.threadId, agent, connect as never, onActivity, { liveTail: true, snapshotContinuations: true });
  return null;
}

test("reconnecting a live turn preserves the durable prefix and appends only the unseen suffix", async () => {
  const agent = new ConversationSession("bot", "cursor-thread", "channel:cursor");
  agent.setMessages([
    { id: "u", role: "user", content: "Continue" },
    { id: "a", role: "assistant", content: "Before" },
  ]);
  globalThis.fetch = (async () => new NativeResponse([
    { type: "RUN_STARTED", threadId: "cursor-thread", runId: "r" },
    { type: "MESSAGES_SNAPSHOT", messages: [
      { id: "u", role: "user", content: "Continue" },
      { id: "a", role: "assistant", content: "Before restart. " },
    ] },
    { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "After restart." },
    { type: "TEXT_MESSAGE_END", messageId: "a" },
    { type: "RUN_FINISHED", threadId: "cursor-thread", runId: "r" },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  render(<QueryClientProvider client={cache}><Observe agent={agent} /></QueryClientProvider>);
  await act(async () => {
    for (const listener of listeners) listener({ threadId: agent.threadId, seq: "12", running: true, workers: null, inbox: null });
  });
  await waitFor(() => expect(agent.messages.find(message => message.id === "a")?.content).toBe("Before restart. After restart."));
  expect(agent.messages.map(message => message.id)).toEqual(["u", "a"]);
});
