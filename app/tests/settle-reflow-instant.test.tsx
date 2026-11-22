import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { settleReactWork } from "./settle-react-work";

/**
 * 验证竖屏/窄窗滚动回跳的纵深防御修复：
 * 1) SettleAtEnd 以 border-box 观测 content、按内容盒净宽判定 reflowed()，换行贴底走 behavior:"instant"，
 *    避免 clientWidth 盲区注入 .chat-slack 与平滑回追动画；
 * 2) MessageScroller.handleResize 改用 behavior:"instant"，且滚动期间复用 content padding 缓存不再触发
 *    getComputedStyle 强排；
 * 3) ChatTranscript 外层 memo 兼容 AG-UI 对 messages 数组的就地修改，不漏渲染新消息与流式追加。
 */

type ObservedEntry = {
  target: Element;
  callback: ResizeObserverCallback;
  options: ResizeObserverOptions | undefined;
};

const observedEntries: ObservedEntry[] = [];
let RealResizeObserver: typeof ResizeObserver | undefined;
const realFetch = globalThis.fetch;

class FakeResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element, options?: ResizeObserverOptions) {
    observedEntries.push({ target, callback: this.callback, options });
  }
  unobserve(target: Element) {
    for (let i = observedEntries.length - 1; i >= 0; i -= 1) {
      if (
        observedEntries[i]?.target === target &&
        observedEntries[i]?.callback === this.callback
      ) {
        observedEntries.splice(i, 1);
      }
    }
  }
  disconnect() {
    for (let i = observedEntries.length - 1; i >= 0; i -= 1) {
      if (observedEntries[i]?.callback === this.callback) {
        observedEntries.splice(i, 1);
      }
    }
  }
}

function fireResize(target: Element, inlineSize: number, blockSize: number) {
  const entry = {
    target,
    contentRect: new DOMRect(0, 0, inlineSize, blockSize),
    contentBoxSize: [{ inlineSize, blockSize }],
    borderBoxSize: [{ inlineSize, blockSize }],
    devicePixelContentBoxSize: [{ inlineSize, blockSize }],
  } as unknown as ResizeObserverEntry;
  const matched = observedEntries.filter((item) => item.target === target);
  for (const item of matched) {
    item.callback([entry], {} as ResizeObserver);
  }
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  RealResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.fetch = Object.assign(
    async () => Response.json({ ttsReady: false }),
    { preconnect() {} },
  ) as typeof fetch;
});

afterEach(async () => {
  observedEntries.length = 0;
  cleanup();
  await settleReactWork();
});

afterAll(async () => {
  if (RealResizeObserver) globalThis.ResizeObserver = RealResizeObserver;
  globalThis.fetch = realFetch;
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

describe("SettleAtEnd 换行即时贴底与 MessageScroller 零强排缓存", () => {
  test("padding-inline 变更（clientWidth 不变）被 reflowed 识别，贴底走 instant 且流式不注入留白", async () => {
    const messages: Message[] = [
      { id: "u1", role: "user", content: "第一句提问" },
      { id: "a1", role: "assistant", content: "第一段长回答内容" },
    ];
    const client = createClient();
    const view = render(
      <QueryClientProvider client={client}>
        <ChatTranscript messages={messages} scrollKey="settle-reflow-1" />
      </QueryClientProvider>,
    );
    await settleReactWork();

    const viewport = view.container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    );
    const content = view.container.querySelector<HTMLElement>(
      '[data-testid="chat-transcript"]',
    );
    const slack =
      view.container.querySelector<HTMLElement>("[data-chat-slack]");
    expect(viewport).not.toBeNull();
    expect(content).not.toBeNull();
    expect(slack).not.toBeNull();
    if (!viewport || !content || !slack) return;

    // 断言 SettleAtEnd 以 border-box 观测 content，确保 padding-bottom / padding-right 均能唤醒回调
    const contentObservers = observedEntries.filter(
      (item) => item.target === content,
    );
    expect(
      contentObservers.some((item) => item.options?.box === "border-box"),
    ).toBe(true);

    let scrollHeight = 2000;
    const clientHeight = 500;
    let scrollTop = 1500;
    let offsetHeight = 2000;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(content, "clientWidth", {
      configurable: true,
      get: () => 410,
    });
    Object.defineProperty(content, "offsetHeight", {
      configurable: true,
      get: () => offsetHeight,
    });

    const scrollCalls: Array<{ top?: number; behavior?: ScrollBehavior }> = [];
    viewport.scrollTo = ((arg: ScrollToOptions | number, y?: number) => {
      if (typeof arg === "object" && arg !== null) {
        scrollCalls.push({ top: arg.top, behavior: arg.behavior });
        if (typeof arg.top === "number") scrollTop = arg.top;
      } else if (typeof y === "number") {
        scrollCalls.push({ top: y });
        scrollTop = y;
      }
    }) as typeof viewport.scrollTo;

    // 1. 仅 padding-right 变化（clientWidth 恒 410），contentBoxSize.inlineSize 从初始值变为 364，内容折行长高 +400px
    scrollHeight = 2400;
    offsetHeight = 2400;
    act(() => {
      fireResize(content, 364, 2400);
    });
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls.every((call) => call.behavior === "instant")).toBe(true);
    expect(scrollTop).toBe(1900);

    // 2. 连续第二帧变窄（模拟左栏展开过渡）：因上一帧同步落底，seen.atBottom 仍为 true，第二帧继续 instant 贴底
    scrollCalls.length = 0;
    scrollHeight = 2700;
    offsetHeight = 2700;
    act(() => {
      fireResize(content, 330, 2700);
    });
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls.every((call) => call.behavior === "instant")).toBe(true);
    expect(scrollTop).toBe(2200);

    // 3. 流式态（busy=true）下内宽变宽使高度骤减 -500px：reflowed 清掉旧 2700px floor 且不注入 500px 固定留白
    view.rerender(
      <QueryClientProvider client={client}>
        <ChatTranscript busy messages={messages} scrollKey="settle-reflow-1" />
      </QueryClientProvider>,
    );
    await settleReactWork();
    scrollHeight = 2200;
    offsetHeight = 2200;
    scrollTop = 1700;
    act(() => {
      fireResize(content, 378, 2200);
    });
    // 若 reflowed 漏判，L1429 会注入 500px 固定留白或保留旧 2700px floor；修复后仅弹性重挂到新高度 2200px 且 height 为 0px
    expect(slack.style.height === "" || slack.style.height === "0px").toBe(
      true,
    );
    expect(
      content.style.minHeight === "" ||
        content.style.minHeight === "max(100%, 2200px)",
    ).toBe(true);
  });

  test("MessageScroller.handleResize 使用 instant，且滚动热路径零重复调用 getComputedStyle", async () => {
    const { container } = render(
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              {Array.from({ length: 20 }, (_, i) => (
                <MessageScrollerItem key={String(i)} messageId={String(i)}>
                  {`消息 ${i}`}
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>,
    );
    await settleReactWork();

    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    );
    const content = container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-content"]',
    );
    expect(viewport).not.toBeNull();
    expect(content).not.toBeNull();
    if (!viewport || !content) return;

    let scrollHeight = 2200;
    let scrollTop = 1400;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    const resizeBehaviors: Array<ScrollBehavior | undefined> = [];
    viewport.scrollTo = ((arg: ScrollToOptions | number) => {
      if (typeof arg === "object" && arg !== null) {
        resizeBehaviors.push(arg.behavior);
        if (typeof arg.top === "number") scrollTop = arg.top;
      }
    }) as typeof viewport.scrollTo;

    // 触发 content ResizeObserver → rAF → handleResize，必须以 "instant" 跟底而非 "auto"
    scrollHeight = 2500;
    act(() => {
      fireResize(content, 400, 2500);
    });
    await act(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
    });
    expect(resizeBehaviors.length).toBeGreaterThan(0);
    expect(resizeBehaviors.every((b) => b === "instant")).toBe(true);

    // 预热一次滚动建立 padding 缓存，随后连续滚动 10 次不得再对 content 调用 getComputedStyle
    viewport.dispatchEvent(new Event("scroll"));
    const realGetComputedStyle = window.getComputedStyle;
    let contentStyleReads = 0;
    window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
      if (el === content) contentStyleReads += 1;
      return realGetComputedStyle.call(window, el, pseudo);
    }) as typeof window.getComputedStyle;
    try {
      for (let i = 0; i < 10; i += 1) {
        scrollTop = 1000 + i * 30;
        viewport.dispatchEvent(new Event("scroll"));
      }
      expect(contentStyleReads).toBe(0);
    } finally {
      window.getComputedStyle = realGetComputedStyle;
    }
  });

  test("ChatTranscript 外层 memo 仍能捕获 AG-UI 对同一 messages 数组的就地 push 与就地改 content", async () => {
    const client = createClient();
    const sharedMessages: Message[] = [
      { id: "m1", role: "user", content: "你好" },
    ];
    const view = render(
      <QueryClientProvider client={client}>
        <ChatTranscript messages={sharedMessages} scrollKey="inplace-mut" />
      </QueryClientProvider>,
    );
    await settleReactWork();
    expect(view.container.textContent).toContain("你好");

    // 就地 push 新消息（数组引用不变）
    sharedMessages.push({
      id: "m2",
      role: "assistant",
      content: "首段流式回复",
    });
    view.rerender(
      <QueryClientProvider client={client}>
        <ChatTranscript messages={sharedMessages} scrollKey="inplace-mut" />
      </QueryClientProvider>,
    );
    await settleReactWork();
    expect(view.container.textContent).toContain("首段流式回复");

    // 就地修改 content（数组与消息对象引用均不变）
    const reply = sharedMessages[1];
    if (reply && reply.role === "assistant") {
      reply.content = "首段流式回复已更新";
    }
    view.rerender(
      <QueryClientProvider client={client}>
        <ChatTranscript messages={sharedMessages} scrollKey="inplace-mut" />
      </QueryClientProvider>,
    );
    await settleReactWork();
    expect(view.container.textContent).toContain("首段流式回复已更新");
  });
});
