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
import { BotBubbles } from "@/components/chat/bot-bubbles";
import { LONG_MESSAGE_FOLD_THRESHOLD } from "@/lib/chat/fold-long-message";
import { settleReactWork } from "./settle-react-work";

/**
 * 验证聊天滚动单一事实源（Single Source of Truth）不变量：
 * 1) SettleAtEnd 以 border-box 同时观测 content 与 viewport，维护 data-cb-pinned="true"（带脏检查），
 *    在 pinned 态下任意换行/增高/收缩均同步 instant 落底，零 .scroll-smooth、零 minHeight floor、零 .chat-slack 震荡；
 * 2) 仅真实用户输入退出 pinned，内容收缩 clamp 绝不翻转 pinned；
 * 3) MessageScroller.handleResize 改用 behavior:"instant"，且滚动期间复用 content padding 缓存；
 * 4) BotBubbles 流式生成过的长消息结束后不自动塌缩。
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

describe("SettleAtEnd 单一事实源贴底与 MessageScroller 零强排缓存", () => {
  test("SettleAtEnd 以 border-box 观测 content 与 viewport，维护 data-cb-pinned，换行与流式收缩均同步 instant 落底且零留白震荡", async () => {
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

    // 视口禁止挂 scroll-smooth，初始贴底态挂 data-cb-pinned="true"
    expect(viewport.className).not.toContain("scroll-smooth");
    expect(viewport.getAttribute("data-cb-pinned")).toBe("true");

    // 断言 SettleAtEnd 以 border-box 同时观测 content 与 viewport
    const contentObservers = observedEntries.filter(
      (item) => item.target === content,
    );
    const viewportObservers = observedEntries.filter(
      (item) => item.target === viewport,
    );
    expect(
      contentObservers.some((item) => item.options?.box === "border-box"),
    ).toBe(true);
    expect(
      viewportObservers.some((item) => item.options?.box === "border-box"),
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

    // 1. 仅 padding-right 变化（clientWidth 恒 410），内容折行长高 +400px -> 同步 instant 落底
    scrollHeight = 2400;
    offsetHeight = 2400;
    act(() => {
      fireResize(content, 364, 2400);
    });
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls.every((call) => call.behavior === "instant")).toBe(true);
    expect(scrollTop).toBe(1900);
    expect(viewport.getAttribute("data-cb-pinned")).toBe("true");

    // 2. 连续第二帧变窄：同步落底保持 pinned，第二帧继续 instant 贴底
    scrollCalls.length = 0;
    scrollHeight = 2700;
    offsetHeight = 2700;
    act(() => {
      fireResize(content, 330, 2700);
    });
    expect(scrollCalls.length).toBeGreaterThan(0);
    expect(scrollCalls.every((call) => call.behavior === "instant")).toBe(true);
    expect(scrollTop).toBe(2200);

    // 3. 流式态（busy=true）下高度骤减 -500px：不注入 .chat-slack，不写 content.style.minHeight，也不翻转 pinned
    view.rerender(
      <QueryClientProvider client={client}>
        <ChatTranscript busy messages={messages} scrollKey="settle-reflow-1" />
      </QueryClientProvider>,
    );
    await settleReactWork();
    scrollCalls.length = 0;
    scrollHeight = 2200;
    offsetHeight = 2200;
    scrollTop = 1700;
    act(() => {
      fireResize(content, 378, 2200);
    });
    expect(slack.style.display).toBe("none");
    expect(content.style.minHeight).toBe("");
    expect(viewport.getAttribute("data-cb-pinned")).toBe("true");
    expect(scrollTop).toBe(1700);
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

  test("pinned 状态机不变量：脏检查零重复写属性、仅真实用户输入退出、发送/回底恢复且流式长消息结束后不自动折叠", async () => {
    const messages: Message[] = [
      { id: "s1", role: "user", content: "第一条历史消息" },
      { id: "s2", role: "assistant", content: "第一条历史回复" },
    ];
    const client = createClient();
    const view = render(
      <QueryClientProvider client={client}>
        <ChatTranscript messages={messages} scrollKey="scroll-pin-invariant" />
      </QueryClientProvider>,
    );
    await settleReactWork();

    const viewport = view.container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    );
    const content = view.container.querySelector<HTMLElement>(
      '[data-testid="chat-transcript"]',
    );
    expect(viewport).not.toBeNull();
    expect(content).not.toBeNull();
    if (!viewport || !content) return;

    let scrollHeight = 2400;
    const clientHeight = 600;
    let scrollTop = 1800;
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
    const scrollCalls: Array<{ top?: number; behavior?: ScrollBehavior }> = [];
    viewport.scrollTo = ((arg: ScrollToOptions | number) => {
      if (typeof arg === "object" && arg !== null) {
        scrollCalls.push({ top: arg.top, behavior: arg.behavior });
        if (typeof arg.top === "number") scrollTop = arg.top;
      }
    }) as typeof viewport.scrollTo;

    expect(viewport.getAttribute("data-cb-pinned")).toBe("true");

    let pinAttrWrites = 0;
    const origSetAttr = viewport.setAttribute.bind(viewport);
    const origRemoveAttr = viewport.removeAttribute.bind(viewport);
    viewport.setAttribute = ((name: string, value: string) => {
      if (name === "data-cb-pinned") pinAttrWrites += 1;
      origSetAttr(name, value);
    }) as typeof viewport.setAttribute;
    viewport.removeAttribute = ((name: string) => {
      if (name === "data-cb-pinned") pinAttrWrites += 1;
      origRemoveAttr(name);
    }) as typeof viewport.removeAttribute;

    try {
      // 1. 持续贴底期间触发多次 ResizeObserver / scroll：带脏检查零重复写 data-cb-pinned
      for (let i = 0; i < 6; i += 1) {
        scrollHeight = 2400 + i * 20;
        act(() => {
          fireResize(content, 560, scrollHeight);
        });
        viewport.dispatchEvent(new Event("scroll"));
      }
      expect(pinAttrWrites).toBe(0);
      expect(scrollTop).toBe(2500 - 600);

      // 2. 非用户输入的内容收缩 clamp（scrollTop 被浏览器夹小）绝不退出 pinned
      scrollHeight = 2100;
      scrollTop = 1500;
      viewport.dispatchEvent(new Event("scroll"));
      expect(viewport.getAttribute("data-cb-pinned")).toBe("true");
      expect(pinAttrWrites).toBe(0);

      // 3. 向下滚轮（deltaY >= 0）不退出 pinned；向上滚轮（deltaY < 0）退出 pinned
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
      expect(viewport.getAttribute("data-cb-pinned")).toBe("true");
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      expect(viewport.hasAttribute("data-cb-pinned")).toBe(false);

      // 4. 退出 pinned 后，内容增高绝不强拉 scrollTop
      scrollCalls.length = 0;
      scrollTop = 900;
      scrollHeight = 2600;
      act(() => {
        fireResize(content, 560, 2600);
      });
      expect(scrollTop).toBe(900);
      expect(scrollCalls).toHaveLength(0);

      // 5. 主动滚回底缘 <= 4px 重新进入 pinned
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 200 }));
      scrollTop = 1998;
      viewport.dispatchEvent(new Event("scroll"));
      expect(viewport.getAttribute("data-cb-pinned")).toBe("true");

      // 6. 键盘 ArrowUp 退出 pinned，发送新用户消息重新进入 pinned 并同步 instant 落底
      viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
      expect(viewport.hasAttribute("data-cb-pinned")).toBe(false);
      scrollTop = 700;
      scrollHeight = 2800;
      view.rerender(
        <QueryClientProvider client={client}>
          <ChatTranscript
            messages={[
              ...messages,
              { id: "s3", role: "user", content: "继续问" },
            ]}
            scrollKey="scroll-pin-invariant"
          />
        </QueryClientProvider>,
      );
      await settleReactWork();
      expect(viewport.getAttribute("data-cb-pinned")).toBe("true");
      expect(scrollTop).toBe(2200);
    } finally {
      viewport.setAttribute = origSetAttr;
      viewport.removeAttribute = origRemoveAttr;
    }

    // 7. BotBubbles 流式生成过的超长回答在 streaming=false 后不自动折叠塌缩；历史长消息正常折叠
    const huge = "这一段是很长的测试回复正文。".repeat(
      Math.ceil((LONG_MESSAGE_FOLD_THRESHOLD + 500) / 14),
    );
    const liveView = render(<BotBubbles streaming text={huge} />);
    expect(
      liveView.container.querySelector('[data-testid="expand-long-message"]'),
    ).toBeNull();
    liveView.rerender(<BotBubbles streaming={false} text={huge} />);
    expect(
      liveView.container.querySelector('[data-testid="expand-long-message"]'),
    ).toBeNull();

    const historyView = render(<BotBubbles streaming={false} text={huge} />);
    expect(
      historyView.container.querySelector('[data-testid="expand-long-message"]'),
    ).not.toBeNull();
  });

  test("Arriving 历史消息渲染普通 div（保留 data-slot）且无 translateY 内联样式", async () => {
    const messages: Message[] = [
      { id: "h1", role: "user", content: "历史用户消息" },
      { id: "h2", role: "assistant", content: "历史助手回复第一段\n\n第二段" },
      { id: "h3", role: "user", content: "第二条历史用户消息" },
    ];
    const client = createClient();
    const view = render(
      <QueryClientProvider client={client}>
        <ChatTranscript messages={messages} scrollKey="history-no-motion" />
      </QueryClientProvider>,
    );
    await settleReactWork();

    const arrivingNodes = view.container.querySelectorAll<HTMLElement>(
      '[data-slot="message-arriving"]',
    );
    expect(arrivingNodes.length).toBe(3);
    for (const node of arrivingNodes) {
      expect(node.tagName).toBe("DIV");
      expect(node.className).toContain("flex");
      expect(node.className).toContain("w-full");
      expect(node.className).toContain("flex-col");
      const inlineStyle = node.getAttribute("style") ?? "";
      expect(inlineStyle).not.toContain("translateY");
      expect(inlineStyle).not.toContain("transform");
    }
  });
});
