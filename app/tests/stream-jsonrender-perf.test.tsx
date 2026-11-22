import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Observable } from "rxjs";
import { Composer } from "@/components/channels/composer/composer";
import {
  ConversationSession,
  ConversationSessionProvider,
  useConversationSession,
} from "@/lib/chat/session-client";
import { fitLineElement } from "@/lib/conversations/json-render/registry";
import { useNow } from "@/lib/conversations/json-render/rich-context";
import {
  clearRenderUiFinalCache,
  renderUiDrawsCard,
  renderUiFinal,
} from "@/lib/conversations/render-ui-tool";
import {
  markRead,
  restoreFailedQueue,
  useReadMark,
} from "@/lib/conversations/thread-inbox";
import { mergeSnapshot } from "@/lib/conversations/use-conversation-sync";
import { useThreadInbox } from "@/lib/conversations/use-thread-inbox";
import { KeptVisibleContext } from "@/lib/kept-visible";
import { REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "https://chisabot.test/" });
  }
});

afterEach(async () => {
  cleanup();
  clearRenderUiFinalCache();
  window.localStorage.removeItem("chisabot.composer-expanded");
  await settleReactWork();
});

afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

describe("thread-inbox & useThreadInbox hot path", () => {
  test("useReadMark isolates re-renders per messageId instead of broadcasting to all rows", () => {
    const renders: Record<string, number> = {};
    function Probe({ id }: { id: string }) {
      renders[id] = (renders[id] ?? 0) + 1;
      const marked = useReadMark(id);
      return <span data-testid={`rm-${id}`}>{marked ? "yes" : "no"}</span>;
    }

    const view = render(
      <div>
        <Probe id="m-1" />
        <Probe id="m-2" />
        <Probe id="m-3" />
        <Probe id="m-4" />
      </div>,
    );
    expect(renders).toEqual({ "m-1": 1, "m-2": 1, "m-3": 1, "m-4": 1 });

    act(() => {
      markRead("t-iso-a", "m-1");
    });
    expect(view.getByTestId("rm-m-1").textContent).toBe("yes");
    expect(view.getByTestId("rm-m-2").textContent).toBe("no");
    expect(renders["m-1"]).toBe(2);
    expect(renders["m-2"]).toBe(1);
    expect(renders["m-3"]).toBe(1);
    expect(renders["m-4"]).toBe(1);

    // 无关线程队列变动不应触发任何 useReadMark 重渲
    act(() => {
      restoreFailedQueue("t-iso-other", [
        {
          id: "q-other",
          text: "hello",
          status: "failed",
          at: Date.now(),
        },
      ]);
    });
    expect(renders["m-1"]).toBe(2);
    expect(renders["m-2"]).toBe(1);
    expect(renders["m-3"]).toBe(1);
    expect(renders["m-4"]).toBe(1);
  });

  test("useThreadInbox reconcile skips scanning agent.messages when thread queue is empty", async () => {
    const threadId = "t-empty-reconcile";
    let readCount = 0;
    const rawMessages: Message[] = Array.from({ length: 200 }, (_, i) => ({
      id: `hist-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    }));
    const trackedMessages = new Proxy(rawMessages, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          readCount += 1;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    class StubAgent extends AbstractAgent {
      run(_input: RunAgentInput) {
        return new Observable<BaseEvent>((sub) => {
          sub.complete();
        });
      }
      fireMessagesChanged() {
        for (const sub of this.subscribers) {
          void sub.onMessagesChanged?.({
            messages: this.messages,
            state: this.state,
            agent: this,
          });
        }
      }
    }

    const agent = new StubAgent({ agentId: "bot", threadId });
    agent.messages = trackedMessages;
    const client = new QueryClient();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        running: false,
        paused: false,
        items: [],
      })) as unknown as typeof fetch;

    function Harness() {
      useThreadInbox(threadId, agent, async () => undefined, {
        pullServerTurns: false,
      });
      return null;
    }

    try {
      const view = render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      );
      await act(async () => {
        await settleReactWork();
      });
      readCount = 0;
      for (let i = 0; i < 20; i++) {
        agent.fireMessagesChanged();
      }
      expect(readCount).toBe(0);
      view.unmount();
    } finally {
      globalThis.fetch = realFetch;
      client.clear();
    }
  });
});

describe("ConversationSession non-text rAF throttling & O(1) structural tracking", () => {
  test("TOOL_CALL_ARGS and REASONING_MESSAGE_CONTENT coalesce per animation frame and flush before END", async () => {
    let parentRenders = 0;
    let capturedSession: ConversationSession | null = null;
    let lastArgs = "";
    let lastReasoning = "";

    function Harness() {
      parentRenders += 1;
      const { agent } = useConversationSession({
        agentId: "channel:nontext",
        runtimeAgentId: "bot-nontext",
        threadId: "t-nontext",
      });
      capturedSession = agent;
      const assistant = agent.messages.find((m) => m.role === "assistant");
      const toolCalls =
        assistant && "toolCalls" in assistant && Array.isArray(assistant.toolCalls)
          ? assistant.toolCalls
          : [];
      lastArgs = toolCalls[0]?.function.arguments ?? "";
      const reasoning = agent.messages.find((m) => m.role === "reasoning");
      lastReasoning =
        reasoning && typeof reasoning.content === "string"
          ? reasoning.content
          : "";
      return (
        <div>
          <span data-testid="args">{lastArgs}</span>
          <span data-testid="reasoning">{lastReasoning}</span>
        </div>
      );
    }

    const pendingRafs = new Map<number, FrameRequestCallback>();
    let nextRafId = 1;
    const origRaf = globalThis.requestAnimationFrame;
    const origCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      const id = nextRafId++;
      pendingRafs.set(id, cb);
      return id;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      pendingRafs.delete(id);
    }) as typeof cancelAnimationFrame;

    let emitEvent: ((event: BaseEvent) => void) | null = null;
    let completeStream: (() => void) | null = null;
    const sigSpy = spyOn(ConversationSession.prototype, "structuralSignature");
    const origRun = ConversationSession.prototype.run;
    ConversationSession.prototype.run = () =>
      new Observable<BaseEvent>((observer) => {
        emitEvent = (event) => observer.next(event);
        completeStream = () => observer.complete();
      });

    try {
      const view = render(
        <ConversationSessionProvider>
          <Harness />
        </ConversationSessionProvider>,
      );
      await act(async () => {
        await settleReactWork();
      });
      expect(capturedSession).not.toBeNull();
      const session = capturedSession as unknown as ConversationSession;

      let runDone: Promise<unknown> | null = null;
      await act(async () => {
        runDone = session.runAgent({ runId: "r-nontext" });
        await Promise.resolve();
      });

      const send = (event: BaseEvent) => {
        if (!emitEvent) throw new Error("stream not started");
        emitEvent(event);
      };

      await act(async () => {
        send({
          type: EventType.RUN_STARTED,
          threadId: "t-nontext",
          runId: "r-nontext",
        } as BaseEvent);
        send({
          type: EventType.TOOL_CALL_START,
          toolCallId: "tc-1",
          toolCallName: "render_ui",
          parentMessageId: "a-1",
        } as BaseEvent);
        await Promise.resolve();
      });

      const rendersBeforeToolArgs = parentRenders;
      await act(async () => {
        for (let i = 0; i < 30; i++) {
          send({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "tc-1",
            delta: `{"k":${i}},`,
          } as BaseEvent);
        }
        await Promise.resolve();
      });

      // 30 个 TOOL_CALL_ARGS 在 rAF 触发前不会同步重渲父组件，仅挂起 1 个 rAF
      expect(parentRenders - rendersBeforeToolArgs).toBe(0);
      expect(pendingRafs.size).toBe(1);

      // 尚未触发 rAF 时收到 TOOL_CALL_END：必须立即 flush 并取消挂起 rAF
      await act(async () => {
        send({
          type: EventType.TOOL_CALL_END,
          toolCallId: "tc-1",
        } as BaseEvent);
        await Promise.resolve();
      });
      expect(pendingRafs.size).toBe(0);
      expect(view.getByTestId("args").textContent).toContain(`{"k":29},`);

      // 验证 REASONING_MESSAGE_CONTENT：首字落地立刻展示，后续 25 块走单次 rAF 合并并在 END 立即 flush
      await act(async () => {
        send({
          type: EventType.REASONING_MESSAGE_START,
          messageId: "rs-1",
          role: "reasoning",
        } as BaseEvent);
        send({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "rs-1",
          delta: "first-",
        } as BaseEvent);
        await Promise.resolve();
      });
      expect(view.getByTestId("reasoning").textContent).toBe("first-");

      const rendersBeforeReasoningBurst = parentRenders;
      await act(async () => {
        for (let i = 0; i < 25; i++) {
          send({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: "rs-1",
            delta: `r${i}-`,
          } as BaseEvent);
        }
        await Promise.resolve();
      });
      expect(parentRenders - rendersBeforeReasoningBurst).toBe(0);
      expect(pendingRafs.size).toBe(1);

      // 触发 1 帧 rAF：25 个增量合并为 1 次刷新
      await act(async () => {
        const callbacks = [...pendingRafs.values()];
        pendingRafs.clear();
        for (const cb of callbacks) cb(16);
        await Promise.resolve();
      });
      expect(parentRenders - rendersBeforeReasoningBurst).toBe(1);
      expect(view.getByTestId("reasoning").textContent).toContain("r24-");

      // 再发增量后直接 REASONING_MESSAGE_END（不跑 rAF），仍立即 flush
      await act(async () => {
        send({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: "rs-1",
          delta: "tail-end",
        } as BaseEvent);
        send({
          type: EventType.REASONING_MESSAGE_END,
          messageId: "rs-1",
        } as BaseEvent);
        send({
          type: EventType.RUN_FINISHED,
          threadId: "t-nontext",
          runId: "r-nontext",
        } as BaseEvent);
        completeStream?.();
        await runDone;
      });
      expect(view.getByTestId("reasoning").textContent).toContain("tail-end");
      // 热路径彻底不再调用 O(N) structuralSignature()
      expect(sigSpy).not.toHaveBeenCalled();
    } finally {
      sigSpy.mockRestore();
      ConversationSession.prototype.run = origRun;
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancelRaf;
    }
  });
});

describe("mergeSnapshot fast structural diff & O(N+M) merge", () => {
  test("400 unchanged messages with replaceExisting=true perform 0 JSON.stringify calls and keep identity", () => {
    const local = Array.from({ length: 400 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `hello world message #${i}`,
      toolCalls:
        i % 10 === 0
          ? [{ id: `tc-${i}`, function: { name: "search", arguments: '{"q":1}' } }]
          : undefined,
    }));
    const snapshot = local.map((item) => ({
      ...item,
      ...(item.toolCalls
        ? {
            toolCalls: item.toolCalls.map((c) => ({
              ...c,
              function: { ...c.function },
            })),
          }
        : {}),
    }));

    const stringifySpy = spyOn(JSON, "stringify");
    try {
      const merged = mergeSnapshot(local, snapshot, true);
      expect(merged).toBe(local);
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
    }
  });

  test("preserves exact insertion order for leading, multi-gap, out-of-order anchors, and nested updates", () => {
    const ids = (list: { id: string }[]) => list.map((m) => m.id).join(",");

    // 乱序锚点 + 头部插入 + 多段插入
    expect(
      ids(
        mergeSnapshot(
          [{ id: "a" }, { id: "b" }],
          [{ id: "x1" }, { id: "x2" }, { id: "b" }, { id: "y1" }, { id: "a" }, { id: "z1" }, { id: "z2" }],
        ),
      ),
    ).toBe("x1,x2,a,z1,z2,b,y1");

    // 嵌套 toolCalls 字段变更触发 replaceExisting 替换
    const local = [
      {
        id: "a1",
        content: "",
        toolCalls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }],
      },
      { id: "u2", content: "local draft" },
    ];
    const snapshot = [
      {
        id: "a1",
        content: "",
        toolCalls: [{ id: "t1", function: { name: "f", arguments: '{"a":2}' } }],
      },
    ];
    const merged = mergeSnapshot(local, snapshot, true);
    expect(merged).not.toBe(local);
    expect(merged[0]?.toolCalls?.[0]?.function.arguments).toBe('{"a":2}');
    expect(merged[1]).toBe(local[1]);
  });
});

describe("renderUiFinal bounded LRU cache", () => {
  const makeSpec = (label: string) =>
    JSON.stringify({
      root: "m",
      elements: {
        m: { type: "Metric", props: { label, value: "42" }, children: [] },
      },
    });

  test("returns cached result identity across repeated calls and distinguishes refusal status", () => {
    const spec = makeSpec("延迟");
    const first = renderUiFinal(spec, "ok");
    expect(first.kind).toBe("card");
    const second = renderUiFinal(spec, "ok");
    expect(second).toBe(first);

    // renderUiDrawsCard 走同一份缓存
    const args = JSON.stringify({ spec });
    expect(renderUiDrawsCard({ args, result: "ok" })).toBe(true);

    // 拒绝态必须隔离缓存键，返回 failed
    const refused = renderUiFinal(spec, `${REFUSAL_MARKER} rejected`);
    expect(refused.kind).toBe("failed");
    expect(renderUiFinal(spec, "ok")).toBe(first);
  });

  test("evicts oldest entries beyond 64-entry LRU bound while retaining recently used hot keys", () => {
    const hot = makeSpec("hot-item");
    const cold = makeSpec("cold-item");
    const hotFirst = renderUiFinal(hot, "ok");
    const coldFirst = renderUiFinal(cold, "ok");

    // 填充 63 个其他键前先触摸 hot，使 cold 成为最老键
    expect(renderUiFinal(hot, "ok")).toBe(hotFirst);
    for (let i = 0; i < 64; i++) {
      renderUiFinal(makeSpec(`fill-${i}`), "ok");
    }

    // cold 已被淘汰，重新计算会生成新对象引用
    const coldAfterEvict = renderUiFinal(cold, "ok");
    expect(coldAfterEvict.kind).toBe("card");
    expect(coldAfterEvict).not.toBe(coldFirst);
  });
});

describe("FitLine single-pass proportional estimate", () => {
  test("converges in at most 2 fontSize writes instead of 11px loop and skips hidden / fitting elements", () => {
    const realGetComputedStyle = globalThis.getComputedStyle;
    let computedStyleReads = 0;
    globalThis.getComputedStyle = ((el: Element) => {
      computedStyleReads += 1;
      return realGetComputedStyle(el);
    }) as typeof getComputedStyle;

    try {
      // 1) 隐藏态 (clientWidth = 0) 直接跳过
      const hiddenEl = document.createElement("div");
      Object.defineProperty(hiddenEl, "clientWidth", { value: 0, configurable: true });
      Object.defineProperty(hiddenEl, "scrollWidth", { value: 240, configurable: true });
      fitLineElement(hiddenEl);
      expect(computedStyleReads).toBe(0);
      expect(hiddenEl.style.fontSize).toBe("");

      // 2) 未溢出 (scrollWidth <= clientWidth) 零 getComputedStyle、零写入
      const fittingEl = document.createElement("div");
      Object.defineProperty(fittingEl, "clientWidth", { value: 120, configurable: true });
      Object.defineProperty(fittingEl, "scrollWidth", { value: 110, configurable: true });
      fitLineElement(fittingEl);
      expect(computedStyleReads).toBe(0);
      expect(fittingEl.style.fontSize).toBe("");

      // 3) 严重溢出（24px -> 14px，原实现需 10 次逐 px 回流）：新实现 <= 2 次写入即收敛
      const overflowEl = document.createElement("div");
      let currentFontPx = 24;
      let fontWrites = 0;
      const baseStyle = overflowEl.style;
      Object.defineProperty(overflowEl, "style", {
        value: new Proxy(baseStyle, {
          set(target, prop, value) {
            if (prop === "fontSize") {
              if (value === "") {
                currentFontPx = 24;
              } else {
                fontWrites += 1;
                currentFontPx = Number.parseFloat(String(value));
              }
            }
            return Reflect.set(target, prop, value);
          },
          get(target, prop) {
            if (prop === "fontSize") {
              return currentFontPx === 24 ? "" : `${currentFontPx}px`;
            }
            return Reflect.get(target, prop);
          },
        }),
      });
      // 模拟微非线性字宽：10px/字符 * fontSize/24 * 17.5 + 3px kerning
      Object.defineProperty(overflowEl, "clientWidth", {
        value: 100,
        configurable: true,
      });
      Object.defineProperty(overflowEl, "scrollWidth", {
        get() {
          return (currentFontPx / 24) * 168 + 3;
        },
        configurable: true,
      });
      computedStyleReads = 0;
      fitLineElement(overflowEl);
      expect(fontWrites).toBeGreaterThanOrEqual(1);
      expect(fontWrites).toBeLessThanOrEqual(2);
      expect(currentFontPx).toBeGreaterThanOrEqual(13);
      expect(overflowEl.scrollWidth).toBeLessThanOrEqual(100.5);
    } finally {
      globalThis.getComputedStyle = realGetComputedStyle;
    }
  });
});

describe("rich-context useNow visibility & hidden gating", () => {
  test("pauses timer ticks when KeepAlive hidden or document.hidden and refreshes immediately on resume", async () => {
    let renders = 0;
    let latestNow = 0;
    function ClockProbe() {
      renders += 1;
      latestNow = useNow(1);
      return <span data-testid="now">{latestNow}</span>;
    }

    const view = render(
      <KeptVisibleContext.Provider value={false}>
        <ClockProbe />
      </KeptVisibleContext.Provider>,
    );
    const rendersWhenHidden = renders;
    const nowWhenHidden = latestNow;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1150));
    });
    // KeepAlive 离屏期间 0 次定时重渲
    expect(renders).toBe(rendersWhenHidden);

    // 切回 KeepAlive 可见：立刻刷新当前时间
    await act(async () => {
      view.rerender(
        <KeptVisibleContext.Provider value={true}>
          <ClockProbe />
        </KeptVisibleContext.Provider>,
      );
    });
    expect(latestNow).toBeGreaterThan(nowWhenHidden);

    // 模拟页面切后台 (document.hidden = true)
    const hiddenDesc = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "hidden",
    );
    let isHidden = true;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => isHidden,
    });
    try {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const rendersWhileBackground = renders;
      const nowBeforeBackground = latestNow;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 1150));
      });
      expect(renders).toBe(rendersWhileBackground);

      // 切回前台：立即刷新并触发重渲
      isHidden = false;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(renders).toBeGreaterThan(rendersWhileBackground);
      expect(latestNow).toBeGreaterThan(nowBeforeBackground);
    } finally {
      if (hiddenDesc) {
        Object.defineProperty(document, "hidden", hiddenDesc);
      } else {
        delete (document as unknown as Record<string, unknown>).hidden;
      }
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
});

describe("Composer mount & resize zero forced reflow", () => {
  test("avoids offsetHeight/getComputedStyle on mount and ResizeObserver line-wraps, sampling only on expand toggle", () => {
    let formOffsetHeightReads = 0;
    let formComputedStyleReads = 0;
    const animateCalls: unknown[] = [];

    const origOffsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        if (this instanceof HTMLFormElement) {
          formOffsetHeightReads += 1;
          return this.className.includes("glass-composer-pill") ? 48 : 112;
        }
        return origOffsetHeight?.get?.call(this) ?? 0;
      },
    });

    const origGetComputedStyle = globalThis.getComputedStyle;
    globalThis.getComputedStyle = ((el: Element, pseudo?: string | null) => {
      if (el instanceof HTMLFormElement) {
        formComputedStyleReads += 1;
      }
      return origGetComputedStyle(el, pseudo);
    }) as typeof getComputedStyle;

    const origAnimate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (...args: unknown[]) {
      if (this instanceof HTMLFormElement) animateCalls.push(args);
      return { cancel() {} } as unknown as Animation;
    };

    const observerCallbacks: {
      cb: ResizeObserverCallback;
      target: Element;
    }[] = [];
    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(target: Element) {
        observerCallbacks.push({ cb: this.cb, target });
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const view = render(<Composer compact onSubmit={() => {}} />);
      // 首次挂载 commit 期零强制同步回流
      expect(formOffsetHeightReads).toBe(0);
      expect(formComputedStyleReads).toBe(0);

      const form = view.container.querySelector("form");
      expect(form).not.toBeNull();

      // 模拟打字换行触发 5 次 ResizeObserver (带 borderBoxSize)：零 offsetHeight / 零 getComputedStyle
      for (const h of [52, 68, 84, 100, 68]) {
        for (const item of observerCallbacks) {
          if (item.target === form) {
            item.cb(
              [
                {
                  target: form,
                  borderBoxSize: [{ blockSize: h, inlineSize: 420 }],
                  contentRect: { height: h - 4, width: 400 },
                } as unknown as ResizeObserverEntry,
              ],
              {} as ResizeObserver,
            );
          }
        }
      }
      expect(formOffsetHeightReads).toBe(0);
      expect(formComputedStyleReads).toBe(0);

      // 仅在点击切换展开时采样并触发 FLIP 动画（旧高度复用 borderBoxSize 缓存 68，仅新表单读 1 次 offsetHeight）
      const expandBtn = view.getByRole("button", { name: "展开输入框选项" });
      formOffsetHeightReads = 0;
      formComputedStyleReads = 0;
      fireEvent.click(expandBtn);
      expect(formOffsetHeightReads).toBe(1);
      expect(formComputedStyleReads).toBe(2);
      expect(animateCalls.length).toBe(1);
    } finally {
      if (origOffsetHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "offsetHeight",
          origOffsetHeight,
        );
      }
      globalThis.getComputedStyle = origGetComputedStyle;
      HTMLElement.prototype.animate = origAnimate;
      globalThis.ResizeObserver = origRO;
    }
  });
});
