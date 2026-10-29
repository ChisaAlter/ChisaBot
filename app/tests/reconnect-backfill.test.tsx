import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ThreadActivity } from "@/lib/copilot/bot-thread";
import { useConversationSync } from "@/lib/copilot/use-conversation-sync";

/*
 * 断线重连后补齐（DESIGN.md §42 / §64）：本机一轮刚结束（或刚接完）时 sync 会把「下一次」变化戳只记成基线，
 * 免得重放本机刚收到的东西。可如果紧接着断网，下一次问到戳已经是很久以后——断线期间别处写进来的消息
 * 就被当成基线吞掉、再也不补。断了很久之后问到的第一次戳，序号变了就要合并式接上。
 */
let originalFetch: typeof fetch;
beforeAll(() => {
  GlobalRegistrator.register();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ messages: [] })) as never;
});
afterAll(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

type Subscriber = { onRunFinalized?: () => void; onRunFailed?: () => void };
function setup() {
  const subscribers: Subscriber[] = [];
  const agent = {
    isRunning: false,
    messages: [] as unknown[],
    subscribe(subscriber: Subscriber) {
      subscribers.push(subscriber);
      return { unsubscribe() {} };
    },
  };
  const connects: unknown[] = [];
  const connect = async (options: unknown) => {
    connects.push(options);
  };
  let listener: ((activity: ThreadActivity) => void) | undefined;
  const onActivity = (next: (activity: ThreadActivity) => void) => {
    listener = next;
    return () => {};
  };
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(
    () =>
      useConversationSync("t1", agent as never, connect as never, onActivity, {
        liveTail: true,
      }),
    { wrapper },
  );
  const emit = (seq: string) =>
    act(() => {
      listener?.({
        threadId: "t1",
        seq,
        running: false,
        workers: null,
        inbox: null,
      });
    });
  const finishOwnRun = () =>
    act(() => {
      for (const subscriber of subscribers) subscriber.onRunFinalized?.();
    });
  return { emit, finishOwnRun, connects };
}

test("the first activity after a long gap still backfills what changed meanwhile", async () => {
  let now = 1_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { emit, finishOwnRun, connects } = setup();
    await emit("1"); // 打开后的第一次：只记基线
    await finishOwnRun(); // 本机刚跑完一轮
    now += 60_000; // 紧接着断网一分钟，期间别的设备说了话
    await emit("9");
    expect(connects).toHaveLength(1);
  } finally {
    clock.mockRestore();
    cleanup();
  }
});

test("the poll right after this device's own turn still only rebases", async () => {
  let now = 2_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const { emit, finishOwnRun, connects } = setup();
    await emit("1");
    await finishOwnRun();
    now += 2_000; // 正常的下一次轮询：序号变了是本机这一轮写的
    await emit("5");
    expect(connects).toHaveLength(0);
    now += 2_000;
    await emit("6"); // 之后别处的新动静照旧接上
    expect(connects).toHaveLength(1);
  } finally {
    clock.mockRestore();
    cleanup();
  }
});
