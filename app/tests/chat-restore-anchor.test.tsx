import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { settleReactWork } from "./settle-react-work";

/**
 * 打开一段对话不是「发了一句」（DESIGN.md §83 / §88.1）。
 *
 * 打开时历史是异步到的，来之前列表是空的（或者只有这台设备上次看到的缓存）。最新一条用户消息第一次出现，
 * 以前被当成「人刚发的那一条」：带上 `data-scroll-anchor`，滚动容器把问题翻到视口上 1/3、下面留 2/3 空白，
 * 下一帧再被钉回底部——用户看到的就是「切个机器人 / 从设置回来，整段对话像发消息一样刷新一次」。
 *
 * 这里钉住：恢复完成那一刻出现的最新一条用户消息不带对齐标记；恢复之后人真的发的那一条才带。
 */

let ChatTranscript: typeof import("@/components/channels/chat-transcript").ChatTranscript;
let SETTLE_AFTER_HYDRATE_MS: number;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  ({ ChatTranscript, SETTLE_AFTER_HYDRATE_MS } = await import(
    "@/components/channels/chat-transcript"
  ));
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const HISTORY: Message[] = [
  { id: "restore-user-1", role: "user", content: "把上周的报表整理一下" },
  { id: "restore-answer-1", role: "assistant", content: "整理好了，放在共享盘里。" },
];

function tree(messages: readonly Message[], hydrating: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ChatTranscript
        hydrating={hydrating}
        messages={messages}
        restoring={hydrating}
        scrollKey="restore-anchor-thread"
      />
    </QueryClientProvider>
  );
}

const anchorOf = (container: HTMLElement, id: string) =>
  container
    .querySelector(`[data-message-id="${id}"]`)
    ?.getAttribute("data-scroll-anchor");

/**
 * 让入场动画跑完再拆。中途拆掉时 happy-dom 会 cancel 一个还在跑的 Animation，它的 `finished` 是一个被拒的
 * promise——bun 记成「测试之间的未处理错误」，0 fail 也非 0 退出。
 */
async function finishEntrances() {
  await settleReactWork();
  await new Promise((resolve) => setTimeout(resolve, 260));
}

test("恢复历史时最新一条用户消息不当成「刚发的」", async () => {
  const view = render(tree([], true));
  view.rerender(tree(HISTORY, false));
  expect(anchorOf(view.container, "restore-user-1")).toBe("false");
  await finishEntrances();
});

test("恢复之后人发的那一条也走连续跟底（不挂 data-scroll-anchor 触发 2/3 屏翻页跳动）", async () => {
  const view = render(tree([], true));
  view.rerender(tree(HISTORY, false));
  await settleReactWork();
  const real = performance.now.bind(performance);
  performance.now = () => real() + SETTLE_AFTER_HYDRATE_MS + 1_000;
  try {
    view.rerender(
      tree(
        [...HISTORY, { id: "real-send", role: "user", content: "再补一列同比" }],
        false,
      ),
    );
    expect(anchorOf(view.container, "real-send")).toBe("false");
  } finally {
    performance.now = real;
  }
  // 打开时那一条不会被回头补上标记。
  expect(anchorOf(view.container, "restore-user-1")).toBe("false");
  await finishEntrances();
});
