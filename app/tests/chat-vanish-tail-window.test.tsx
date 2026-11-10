import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import {
  ChatTranscript,
  turnIsLive,
} from "@/components/channels/chat-transcript";
import {
  HIDDEN_ACTIVITY_ROW,
  hasVisibleRow,
  TAIL_FIRST_CAP,
} from "@/lib/chat/tail-first-paint";
import { useTailFirstMount } from "@/lib/chat/use-tail-first-mount";
import { settleReactWork } from "./settle-react-work";

/**
 * 聊天记录「消失」（2026-11-10，v0.1.137 线上）：一轮里调了上百次设备工具，重新打开对话是一片空白。
 *
 * 尾窗以前按条数数：尾巴 36 条、补到 96 条全是默认藏起来的过程行（整格 display:none），干活卡画在这一轮第一个
 * 工具那一行里、末尾的「思考中」又因为已经有干活卡而不画——挂着的行一行都看不见；超过 96 条以后一直空白，
 * 内容不够一屏高也滚不动，上面的历史再也补不出来。这里用「历史 + 人发的一条 + 120 次设备工具，还在跑」
 * 的形状断言：首帧和补完之后都看得到人发的那条和干活提示。
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const wrap = (node: ReactNode) => (
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false, enabled: false } },
      })
    }
  >
    {node}
  </QueryClientProvider>
);

function history(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ id: `h-u${i}`, role: "user", content: `早先的问题 ${i}` });
    out.push({ id: `h-a${i}`, role: "assistant", content: `早先的回答 ${i}` });
  }
  return out;
}

const ASK = "帮我把下载文件夹整理一下";

function deviceTurn(tools: number, prefix = "d"): Message[] {
  const out: Message[] = [{ id: `${prefix}-ask`, role: "user", content: ASK }];
  for (let k = 0; k < tools; k++) {
    out.push({
      id: `${prefix}${k}:a`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `${prefix}${k}:c`,
          type: "function",
          function: { name: "device_run_shell", arguments: "{}" },
        },
      ],
    } as Message);
    out.push({
      id: `${prefix}${k}:r`,
      role: "tool",
      toolCallId: `${prefix}${k}:c`,
      content: '{"exitCode":0}',
    } as Message);
  }
  return out;
}

const rows = (c: HTMLElement) => [
  ...c.querySelectorAll<HTMLElement>("[data-slot='message-scroller-item']"),
];
/** 和 styles.css 同一条规则：空的过程行整格 display:none。 */
const visibleRows = (c: HTMLElement) =>
  rows(c).filter(
    (row) =>
      !row.matches(HIDDEN_ACTIVITY_ROW) && !row.hasAttribute("data-folded"),
  );
const pause = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await settleReactWork();
  });

function expectAskAndWork(container: HTMLElement) {
  const shown = visibleRows(container);
  expect(shown.some((row) => row.textContent?.includes(ASK))).toBe(true);
  // 干活提示（干活卡）看得见：要么在这一轮第一个工具那一行里（那一行因此不是空的），要么在末尾兜底。
  const work = container.querySelector('[data-testid="chat-work-card"]');
  expect(work).not.toBeNull();
  const workRow = work?.closest<HTMLElement>(
    "[data-slot='message-scroller-item']",
  );
  if (workRow) expect(workRow.matches(HIDDEN_ACTIVITY_ROW)).toBe(false);
}

test("a live turn of 120 device tool rows shows the ask and the work hint on the first frame and after catch-up", async () => {
  const messages = [...history(30), ...deviceTurn(120)];
  const { container } = render(
    wrap(<ChatTranscript busy messages={messages} scrollKey="vanish-live" />),
  );
  expectAskAndWork(container);
  expect(visibleRows(container).length).toBeGreaterThan(1);
  await pause(1500);
  expectAskAndWork(container);
});

test("remounting a live long turn (switch away and back) still shows it", async () => {
  const messages = [...history(30), ...deviceTurn(120)];
  const first = render(
    wrap(
      <ChatTranscript busy messages={messages} scrollKey="vanish-remount" />,
    ),
  );
  await pause(300);
  first.unmount();
  const again = render(
    wrap(
      <ChatTranscript busy messages={messages} scrollKey="vanish-remount" />,
    ),
  );
  expectAskAndWork(again.container);
  await pause(1500);
  expectAskAndWork(again.container);
});

test("an ended turn longer than the cap still shows rows, and earlier history stays reachable", async () => {
  // 两轮都超过封顶：以前尾巴补到 96 条全是看不见的行，一直空白，也补不出上面的历史。
  const messages = [
    ...history(40),
    ...deviceTurn(TAIL_FIRST_CAP + 30, "p"),
    { id: "p-done", role: "assistant", content: "整理好了" } as Message,
    ...deviceTurn(TAIL_FIRST_CAP + 30, "q"),
    { id: "q-done", role: "assistant", content: "又整理好了" } as Message,
  ];
  const { container } = render(
    wrap(<ChatTranscript messages={messages} scrollKey="vanish-ended" />),
  );
  expect(visibleRows(container).length).toBeGreaterThan(1);
  expect(container.textContent).toContain("又整理好了");
  await pause(1500);
  expect(container.textContent).toContain("整理好了");
  expect(container.textContent).toContain(ASK);
  // 上面还有历史：一直有「显示更早的消息」，点它能补出更早的消息。
  const more = container.querySelector<HTMLButtonElement>(".chat-history-more");
  expect(more).not.toBeNull();
  expect(container.textContent).not.toContain("早先的问题 0");
  for (
    let i = 0;
    i < 10 && container.querySelector(".chat-history-more");
    i++
  ) {
    const button =
      container.querySelector<HTMLButtonElement>(".chat-history-more");
    if (button) fireEvent.click(button);
    await pause(200);
  }
  expect(container.textContent).toContain("早先的问题 0");
  expect(container.querySelector(".chat-history-more")).toBeNull();
});

test("a plain long text conversation still opens on the same bounded tail", async () => {
  const messages = history(150);
  const { container } = render(
    wrap(<ChatTranscript messages={messages} scrollKey="vanish-text" />),
  );
  // 和以前一样：首帧 36 行（看得见的行和条数一致）。
  expect(rows(container).length).toBe(36);
  await pause(1500);
  expect(rows(container).length).toBe(TAIL_FIRST_CAP);
});

test("hasVisibleRow follows the same rule as the stylesheet", () => {
  const root = document.createElement("div");
  root.innerHTML = `
    <div data-slot="message-scroller-item" data-row="activity"><div></div></div>
    <div data-slot="message-scroller-item" data-folded=""><p>收起的</p></div>`;
  expect(hasVisibleRow(root)).toBe(false);
  root.insertAdjacentHTML(
    "beforeend",
    '<div data-slot="message-scroller-item" data-row="activity"><div role="group">审批</div></div>',
  );
  expect(hasVisibleRow(root)).toBe(true);
  expect(hasVisibleRow(null)).toBe(true);
});

/** 判断「看得见」的那一份漏了（这里故意全当看得见），DOM 上却一行都看不见：继续往前补，不受封顶限制。 */
function MisjudgedHarness({
  total,
  visibleFrom,
}: {
  total: number;
  visibleFrom: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { startIndex, truncated } = useTailFirstMount(
    total,
    "misjudged",
    ref,
    "r-0",
  );
  return (
    <div ref={ref} data-truncated={truncated ? "" : undefined}>
      {Array.from({ length: total - startIndex }, (_, i) => {
        const index = startIndex + i;
        return index < visibleFrom ? (
          <div data-slot="message-scroller-item" key={index}>
            <p>{`看得见的 ${index}`}</p>
          </div>
        ) : (
          <div
            data-row="activity"
            data-slot="message-scroller-item"
            key={index}
          >
            <div />
          </div>
        );
      })}
    </div>
  );
}

test("a mounted window with no visible row keeps backfilling past the cap", async () => {
  const total = 400;
  const { container } = render(
    <MisjudgedHarness total={total} visibleFrom={150} />,
  );
  await pause(2500);
  // 末尾 250 条全是看不见的行，远超 96：兜底一直补到露出看得见的那几条。
  expect(container.textContent).toContain("看得见的 149");
  expect(hasVisibleRow(container)).toBe(true);
});

test("turnIsLive follows the server, and the settled-shape rule when the server is idle", () => {
  const shape = { length: 10, last: "x" };
  expect(turnIsLive(false, shape, shape)).toBe(false);
  // §68.4：按下发送后列表还没变，不算正在跑。
  expect(turnIsLive(true, shape, shape)).toBe(false);
  expect(turnIsLive(true, shape, shape, true)).toBe(true);
  expect(turnIsLive(false, shape, shape, true)).toBe(true);
  expect(turnIsLive(true, { length: 11, last: "y" }, shape)).toBe(true);
  expect(turnIsLive(true, shape, null)).toBe(true);
});

test("a running tool turn stays live when busy arrives after an idle paint of the same messages", async () => {
  // 真实打开：先以 busy=false 画出历史（接入还没结束），再 busy=true、列表不变。
  const messages = [...history(2), ...deviceTurn(120)];
  const view = render(
    wrap(
      <ChatTranscript joining messages={messages} scrollKey="live-late-busy" />,
    ),
  );
  view.rerender(
    wrap(
      <ChatTranscript busy messages={messages} scrollKey="live-late-busy" />,
    ),
  );
  expectAskAndWork(view.container);
  expect(view.container.textContent).not.toContain("这一轮没有回答");
});

test("threadLive shows the work hint on the first frame, even while still joining", () => {
  const messages = [...history(2), ...deviceTurn(120)];
  const { container } = render(
    wrap(
      <ChatTranscript
        joining
        threadLive
        messages={messages}
        scrollKey="live-server"
      />,
    ),
  );
  expectAskAndWork(container);
  expect(container.textContent).not.toContain("这一轮没有回答");
  expect(container.textContent).not.toContain("重试");
});

test("busy going true on a finished turn does not revive it as live", () => {
  const messages: Message[] = [
    ...history(2),
    { id: "last-ask", role: "user", content: "上一轮的问题" },
    { id: "last-ans", role: "assistant", content: "上一轮的回答" },
  ];
  const view = render(
    wrap(<ChatTranscript messages={messages} scrollKey="settled-send" />),
  );
  expect(view.container.textContent).toContain("上一轮的回答");
  expect(
    view.container.querySelector('[data-testid="chat-work-card"]'),
  ).toBeNull();
  view.rerender(
    wrap(<ChatTranscript busy messages={messages} scrollKey="settled-send" />),
  );
  // 人那条还没进列表：上一轮必须仍是已完成，不能变成干活卡、也不能丢掉回答。
  expect(view.container.textContent).toContain("上一轮的回答");
  expect(
    view.container.querySelector('[data-testid="chat-work-card"]'),
  ).toBeNull();
  expect(view.container.textContent).not.toContain("这一轮没有回答");
});
