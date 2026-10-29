import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { type Observable, of } from "rxjs";
import { useThreadInbox } from "../src/lib/copilot/use-thread-inbox";
import { ACTIVE_WORKER, workerKeys } from "../src/lib/copilot/workers";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
let impl: typeof fetch;
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.fetch = Object.assign(
    (...args: Parameters<typeof fetch>) => impl(...args),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

class Idle extends AbstractAgent {
  run(input: RunAgentInput) {
    return of(
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ) as Observable<BaseEvent>;
  }
}

const user = (id: string, content: string): Message => ({
  id,
  role: "user",
  content,
});
const bot = (id: string, content: string): Message => ({
  id,
  role: "assistant",
  content,
});

test("server turns are pulled incrementally and an unchanged transcript triggers no update", async () => {
  const threadId = "thread-incremental";
  const agent = new Idle({
    agentId: "bot",
    threadId,
    initialMessages: [user("u1", "hi")],
  });
  let updates = 0;
  const setMessages = agent.setMessages.bind(agent);
  agent.setMessages = (messages: Message[]) => {
    updates += 1;
    return setMessages(messages);
  };
  const queries: string[] = [];
  // 服务器那一轮：先回复一句，接着不变，再流式长一截并补一条。
  const answers: unknown[] = [
    {
      version: "v1",
      cursor: "c1",
      start: 0,
      messages: [user("u1", "hi"), bot("a1", "hel")],
    },
    { unchanged: true, version: "v1", cursor: "c1" },
    {
      version: "v2",
      cursor: "c2",
      start: 1,
      messages: [bot("a1", "hello"), bot("a2", "done")],
    },
    { unchanged: true, version: "v2", cursor: "c2" },
  ];
  impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/messages")) {
      queries.push(new URL(url, "http://local").search);
      return Response.json(
        answers.shift() ?? { unchanged: true, version: "v2", cursor: "c2" },
      );
    }
    return Response.json({ running: true, paused: false, items: [] });
  }) as typeof fetch;
  const client = new QueryClient();
  client.setQueryData(workerKeys.thread(threadId), [
    {
      id: "w1",
      status: ACTIVE_WORKER[0],
      createdAt: new Date().toISOString(),
      plan: [],
    },
  ]);
  function Inbox() {
    useThreadInbox(threadId, agent as never, async () => undefined, {
      pullServerTurns: true,
    });
    return null;
  }
  const view = render(
    <QueryClientProvider client={client}>
      <Inbox />
    </QueryClientProvider>,
  );
  try {
    await act(async () => {
      await pause(1350);
    });
    expect(queries).toEqual(["?since="]);
    expect(updates).toBe(1);
    expect(agent.messages.map((message) => message.content)).toEqual([
      "hi",
      "hel",
    ]);
    const afterFirst = agent.messages;

    await act(async () => {
      await pause(1200);
    });
    expect(queries[1]).toBe("?since=v1&cursor=c1");
    expect(updates).toBe(1);
    expect(agent.messages).toBe(afterFirst);

    await act(async () => {
      await pause(1200);
    });
    expect(queries[2]).toBe("?since=v1&cursor=c1");
    expect(updates).toBe(2);
    expect(agent.messages.map((message) => message.content)).toEqual([
      "hi",
      "hello",
      "done",
    ]);

    // 本地另有改动（比如用户刚发了一条）：基准作废，下一次拿整份重新对。
    act(() => {
      agent.addMessage(user("u2", "local"));
    });
    answers.length = 0;
    answers.push({
      version: "v3",
      cursor: "c3",
      start: 0,
      messages: [
        user("u1", "hi"),
        bot("a1", "hello"),
        bot("a2", "done"),
        user("u2", "local"),
      ],
    });
    await act(async () => {
      await pause(1200);
    });
    expect(queries.at(-1)).toBe("?since=");
    expect(updates).toBe(2);
  } finally {
    view.unmount();
    client.clear();
  }
}, 20_000);
