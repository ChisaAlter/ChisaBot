import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { settleReactWork } from "./settle-react-work";

/**
 * jank P1-2：滚动 / 内容变化时，message-scroller 只量最后一行（内容高度）和二分找第一条可见行，
 * 不再逐行 getBoundingClientRect（REPORT §切换：550ms）。改动在 app/src/vendor/shadcn-react-message-scroller（见那里的 README）。
 */

const ROW = 50;
let rowRects = 0;
let restore: (() => void) | null = null;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  const proto = HTMLElement.prototype;
  const real = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const id = this.dataset?.messageId;
    if (id) {
      rowRects += 1;
      const top =
        Number(id) * ROW -
        (this.closest("[data-slot='message-scroller-viewport']")?.scrollTop ??
          0);
      return new DOMRect(0, top, 600, ROW);
    }
    if (this.dataset?.slot === "message-scroller-viewport")
      return new DOMRect(0, 0, 600, 400);
    return real.call(this);
  };
  restore = () => {
    proto.getBoundingClientRect = real;
  };
});

afterEach(() => cleanup());

afterAll(async () => {
  restore?.();
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("scrolling a 400-row transcript measures a handful of rows, not all of them", async () => {
  const n = 400;
  const { container } = render(
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {Array.from({ length: n }, (_, i) => (
              <MessageScrollerItem key={String(i)} messageId={String(i)}>
                {i}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>,
  );
  await act(async () => {
    await settleReactWork();
  });
  const viewport = container.querySelector(
    "[data-slot='message-scroller-viewport']",
  ) as HTMLElement;
  rowRects = 0;
  for (let i = 0; i < 5; i++) {
    viewport.scrollTop = 1000 + i * 100;
    await act(async () => {
      viewport.dispatchEvent(new Event("scroll"));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
  }
  // 以前每次滚动 ≥ 2×400 次逐行量（内容高度 + 找第一条可见行）。
  expect(rowRects).toBeLessThan(5 * 40);
});

function Rows({ from }: { from: number }) {
  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            {Array.from({ length: 400 - from }, (_, i) => (
              <MessageScrollerItem
                key={String(from + i)}
                messageId={String(from + i)}
              >
                {from + i}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

async function prependReads(marked: boolean) {
  const { container, rerender } = render(<Rows from={300} />);
  await act(async () => {
    await settleReactWork();
  });
  const viewport = container.querySelector(
    "[data-slot='message-scroller-viewport']",
  ) as HTMLElement;
  let heightReads = 0;
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => {
      heightReads += 1;
      return 400 * ROW;
    },
  });
  if (marked) viewport.setAttribute("data-tail-backfill", "");
  rowRects = 0;
  act(() => {
    rerender(<Rows from={200} />);
  });
  // handleContentChange 跑在 MutationObserver 的微任务里；只看这一拍（rAF 还没到）。
  await Promise.resolve();
  await Promise.resolve();
  const reads = heightReads + rowRects;
  viewport.removeAttribute("data-tail-backfill");
  cleanup();
  return reads;
}

test("a tail-first backfill prepend does not force layout in handleContentChange", async () => {
  // 对照：没有标记时，前插要量行（保位）或读 scrollHeight（贴底）——证明这个测试量得到。
  expect(await prependReads(false)).toBeGreaterThan(0);
  expect(await prependReads(true)).toBe(0);
});
