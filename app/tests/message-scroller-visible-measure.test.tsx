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
