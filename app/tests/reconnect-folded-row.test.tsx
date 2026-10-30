import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { withStoredTail } from "@/lib/copilot/thread-activity";
import { settleReactWork } from "./settle-react-work";

/*
 * 0.1.110 验收「断网补消息 run2：重连后 5 条、刷新后 4 条」。多出来的那条是开场一句「我去读一下这个页面。」：
 * 它在实时流里先作为气泡显示过，这一轮有了干活的工具、写完结果后被收进干活卡（compactTurns 的 hidden）。
 * 这一页上亲眼见过的行收起时不卸载，留成 0 高、aria-hidden、inert 的 `data-folded` 行（DESIGN.md §82.9），
 * 刷新后本来就不画——所以 DOM 里数 `[data-slot=message]` 会多一条，看得见的行和刷新后一模一样。
 * 这条和断线 / 补齐无关（不断网时同样如此）；这里锁住：看得见的行 = 刷新后的行，多出的只能是收起行。
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const history: Message[] = [
  { id: "u1", role: "user", content: "你好，简单回一句就行" },
  { id: "a1", role: "assistant", content: "你好。" },
  {
    id: "u2",
    role: "user",
    content: "帮我总结这个网页 https://en.wikipedia.org/wiki/Liquid_glass",
  },
];
const lead = "我去读一下这个页面。";
const streaming: Message[] = [
  ...history,
  { id: "lead", role: "assistant", content: lead },
];
const finished: Message[] = [
  ...history,
  {
    id: "lead",
    role: "assistant",
    content: lead,
    toolCalls: [
      {
        id: "call-fetch",
        type: "function",
        function: {
          name: "web_fetch",
          arguments: JSON.stringify({
            url: "https://en.wikipedia.org/wiki/Liquid_glass",
          }),
        },
      },
    ],
  } as Message,
  {
    id: "tool-fetch",
    role: "tool",
    toolCallId: "call-fetch",
    content: "Liquid Glass is a design language…",
  } as Message,
  {
    id: "final",
    role: "assistant",
    content: "Liquid Glass 是苹果于 2025 年推出的跨设备界面设计语言。",
  },
];

function rows(container: HTMLElement) {
  const all = [
    ...container.querySelectorAll<HTMLElement>('[data-slot="message"]'),
  ].filter((node) => node.textContent?.trim());
  const visible = all.filter((node) => !node.closest("[data-folded]"));
  const text = (list: HTMLElement[]) =>
    list.map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
  return { all: text(all), visible: text(visible) };
}

function tree(
  client: QueryClient,
  messages: Message[],
  busy: boolean,
  key: string,
) {
  return (
    <QueryClientProvider client={client}>
      <ChatTranscript busy={busy} messages={messages} scrollKey={key} />
    </QueryClientProvider>
  );
}

test("a lead line seen live folds in place; the visible rows equal a fresh reload", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // 实时流：开场一句先作为气泡出现（断线前看到的就是这样）。
  const live = render(tree(client, streaming, true, "folded-live"));
  await waitFor(() =>
    expect(rows(live.container).visible.join("\n")).toContain(lead),
  );
  // 重连补齐后这一轮写完：开场一句收进干活卡。
  await act(async () => {
    live.rerender(tree(client, finished, false, "folded-live"));
  });
  const reconnected = rows(live.container);
  live.unmount();

  // 刷新：同一份存下的对话重新挂上。
  const reloaded = render(tree(client, finished, false, "folded-reload"));
  await waitFor(() =>
    expect(rows(reloaded.container).visible.join("\n")).toContain(
      "Liquid Glass",
    ),
  );
  const fresh = rows(reloaded.container);

  // 和验收脚本一样数所有 [data-slot=message]：重连后比刷新后多一条，正是那句开场白……
  expect(reconnected.all.length).toBe(fresh.all.length + 1);
  expect(reconnected.all.filter((line) => !fresh.all.includes(line))).toEqual([
    lead,
  ]);
  // ……但它是收起行（0 高、读屏跳过），看得见的行和刷新后完全一样。
  expect(reconnected.visible).toEqual(fresh.visible);
  expect(fresh.all).toEqual(fresh.visible);
  expect(fresh.all.some((line) => line.includes(lead))).toBe(false);
});

/*
 * 断线正好落在「开场一句写完、工具调用还没开始」之间：这台手里的开场一句没有 toolCalls。回答在服务器上写完后
 * 重读存储（channel-chat：withStoredTail(mergeStoredMessages(...))）按 id 保留本地那条，工具结果和结果补在后面——
 * 以前只换正文，开场一句仍然是一条不带工具调用的话，这一轮没有干活卡可收，它就作为气泡露在结果上面，
 * 刷新后却没有。存下的那条带着工具调用：补齐时一起换上，和刷新后一致。
 */
test("a backfill after a drop between the lead line and its tool call adopts the stored tool calls", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const local: Message[] = [...streaming];
  // mergeStoredMessages：本地已有的 id 原样保留，存储里本地没有的按位置补进来。
  const merged = [...local, finished[4]!, finished[5]!];
  const backfilled = withStoredTail(
    merged as never[],
    finished as never[],
  ) as Message[];
  expect((backfilled[3] as { toolCalls?: unknown[] }).toolCalls).toHaveLength(
    1,
  );

  const view = render(tree(client, backfilled, false, "backfill-drop"));
  await waitFor(() =>
    expect(rows(view.container).visible.join("\n")).toContain("Liquid Glass"),
  );
  const reconnected = rows(view.container);
  view.unmount();
  const reloaded = render(tree(client, finished, false, "backfill-reload"));
  await waitFor(() =>
    expect(rows(reloaded.container).visible.join("\n")).toContain(
      "Liquid Glass",
    ),
  );
  expect(reconnected.visible).toEqual(rows(reloaded.container).visible);
  expect(reconnected.visible.some((line) => line.includes(lead))).toBe(false);
});
