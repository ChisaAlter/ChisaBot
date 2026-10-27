// DF-30：卡片外框曾是 <button>，失败时里面又渲染「重试」<button>，React 报
// "In HTML, <button> cannot be a descendant of <button>"（hydration error）。
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";

let originalFetch: typeof fetch;
let originalError: typeof console.error;
const errors: string[] = [];

class VisibleObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() =>
      this.callback(
        [
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
}

class QuietSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send() {}
  close() {
    this.readyState = 3;
  }
}

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.WebSocket = QuietSocket as unknown as typeof WebSocket;
  globalThis.IntersectionObserver =
    VisibleObserver as unknown as typeof IntersectionObserver;
  originalFetch = globalThis.fetch;
  originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  cleanup();
  errors.length = 0;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  console.error = originalError;
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function failingScreen(paths: string[]) {
  globalThis.fetch = (async (input) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/control")) {
      return Response.json({
        holder: "bot",
        since: new Date(0).toISOString(),
        requested: false,
      });
    }
    return new Response("down", { status: 503 });
  }) as typeof fetch;
}

async function renderWithRetry(paths: string[]) {
  failingScreen(paths);
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ComputerView computerId="df30" active intervalMs={10} />
    </QueryClientProvider>,
  );
  const retry = await waitFor(() => view.getByText("重试"));
  return { view, retry };
}

test("截图失败时的「重试」按钮不嵌套在另一个 button 里，也没有 React 嵌套报错", async () => {
  const { view, retry } = await renderWithRetry([]);
  expect(
    errors.filter((line) =>
      /descendant of <button>|cannot contain a nested/.test(line),
    ),
  ).toEqual([]);
  expect(retry.tagName).toBe("BUTTON");
  expect(retry.parentElement?.closest("button")).toBeNull();
  expect(view.container.querySelectorAll("button button").length).toBe(0);
});

test("外框保持可访问：role=button、可聚焦、aria-label 不变", async () => {
  const { view } = await renderWithRetry([]);
  const frame = view.getByLabelText("打开助手屏幕全尺寸");
  expect(frame.getAttribute("role") ?? frame.tagName.toLowerCase()).toBe(
    "button",
  );
  expect(frame.tabIndex).toBe(0);
  expect(frame.className).toContain("computer-frame");
});

test("点「重试」只重拉截图，不会同时打开全尺寸", async () => {
  const paths: string[] = [];
  const { retry } = await renderWithRetry(paths);
  const before = paths.filter((p) => p.endsWith("/screenshot")).length;
  await act(async () => {
    fireEvent.click(retry);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(paths.filter((p) => p.endsWith("/screenshot")).length).toBeGreaterThan(
    before,
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

for (const key of ["Enter", " "]) {
  test(`外框按 ${key === " " ? "Space" : key} 能打开全尺寸`, async () => {
    const { view } = await renderWithRetry([]);
    const frame = view.getByLabelText("打开助手屏幕全尺寸");
    await act(async () => {
      fireEvent.keyDown(frame, { key });
      fireEvent.keyUp(frame, { key });
    });
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
    );
  });
}

test("焦点在「重试」上按 Enter 不会冒泡打开全尺寸", async () => {
  const { retry } = await renderWithRetry([]);
  await act(async () => {
    fireEvent.keyDown(retry, { key: "Enter" });
    fireEvent.keyUp(retry, { key: " " });
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
