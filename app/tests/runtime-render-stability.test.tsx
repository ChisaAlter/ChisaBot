import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { memo, type ReactNode, useState } from "react";
import { ComposerDock } from "@/components/channels/composer/dock";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import {
  ConversationScopeProvider,
  useConversationScope,
} from "@/lib/chat/conversation-scope";
import {
  flushUiMemory,
  resetUiMemory,
  setThreadUi,
  UI_MEMORY_KEY,
} from "@/lib/chat/ui-memory";
import {
  ActiveBotProvider,
  useActiveBot,
  useActiveBotId,
  useDeclaredBotId,
} from "@/lib/conversations/active-bot";
import {
  RichUiProvider,
  useRichActions,
} from "@/lib/conversations/json-render/rich-context";
import { useThreadActivity } from "@/lib/conversations/thread-activity";
import { settleReactWork } from "./settle-react-work";

/**
 * 渲染稳定性与零抖动护栏：
 * - ActiveBotProvider / ConversationScopeProvider / ThemeProvider / RichUiProvider 稳定 Context 引用，不击穿 memo；
 * - useThreadActivity 返回稳定句柄引用，不击穿 useExternalConnection 守卫；
 * - ComposerDock 拖拽过程直写 DOM，仅 pointerup 提交一次 React state；
 * - ui-memory 合并写盘并在 pagehide 时兜底落盘。
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

beforeEach(() => {
  resetUiMemory();
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  await settleReactWork();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("ActiveBotProvider 父级重渲不穿透 memo 消费者，且不引发 useActiveBot 重建", () => {
  let idConsumerRenders = 0;
  let declaredConsumerRenders = 0;
  const seenBotIds: string[] = [];

  const IdConsumer = memo(function IdConsumer() {
    idConsumerRenders++;
    const botId = useActiveBotId();
    seenBotIds.push(botId);
    return <span data-testid="active-id">{botId}</span>;
  });

  const DeclaredConsumer = memo(function DeclaredConsumer() {
    declaredConsumerRenders++;
    const declared = useDeclaredBotId();
    return <span data-testid="declared-id">{declared ?? "none"}</span>;
  });

  const Surface = memo(function Surface({ botId }: { botId: string }) {
    useActiveBot(botId);
    return null;
  });

  function Host({ tick, botId }: { tick: number; botId: string }) {
    return (
      <div data-tick={tick}>
        <ActiveBotProvider>
          <Surface botId={botId} />
          <IdConsumer />
          <DeclaredConsumer />
        </ActiveBotProvider>
      </div>
    );
  }

  const view = render(<Host botId="bot-alpha" tick={0} />);
  expect(view.getByTestId("active-id").textContent).toBe("bot-alpha");
  expect(view.getByTestId("declared-id").textContent).toBe("bot-alpha");
  const baseIdRenders = idConsumerRenders;
  const baseDeclaredRenders = declaredConsumerRenders;

  // 父组件因路由或壳层状态重渲多次，botId 不变：memo 消费者必须 0 次额外重渲。
  view.rerender(<Host botId="bot-alpha" tick={1} />);
  view.rerender(<Host botId="bot-alpha" tick={2} />);
  expect(idConsumerRenders).toBe(baseIdRenders);
  expect(declaredConsumerRenders).toBe(baseDeclaredRenders);
  expect(seenBotIds.at(-1)).toBe("bot-alpha");

  // botId 真正变化时，消费者正确更新。
  view.rerender(<Host botId="bot-beta" tick={3} />);
  expect(view.getByTestId("active-id").textContent).toBe("bot-beta");
  expect(view.getByTestId("declared-id").textContent).toBe("bot-beta");
});

test("ConversationScopeProvider 标量字段未变时稳定 Context 引用，不穿透 memo 子树", () => {
  let renders = 0;
  const scopes: Array<ReturnType<typeof useConversationScope>> = [];

  const Consumer = memo(function Consumer() {
    renders++;
    const scope = useConversationScope();
    scopes.push(scope);
    return <span data-testid="scope">{scope?.threadId}</span>;
  });

  function Host({
    tick,
    threadId,
    agentId,
    botId,
  }: {
    tick: number;
    threadId: string;
    agentId: string;
    botId?: string;
  }) {
    return (
      <div data-tick={tick}>
        <ConversationScopeProvider
          agentId={agentId}
          botId={botId}
          threadId={threadId}
        >
          <Consumer />
        </ConversationScopeProvider>
      </div>
    );
  }

  const view = render(
    <Host agentId="agent-1" botId="bot-1" threadId="thread-1" tick={0} />,
  );
  expect(renders).toBe(1);

  view.rerender(
    <Host agentId="agent-1" botId="bot-1" threadId="thread-1" tick={1} />,
  );
  view.rerender(
    <Host agentId="agent-1" botId="bot-1" threadId="thread-1" tick={2} />,
  );
  expect(renders).toBe(1);

  view.rerender(
    <Host agentId="agent-1" botId="bot-1" threadId="thread-2" tick={3} />,
  );
  expect(renders).toBe(2);
  expect(scopes[0]).not.toBe(scopes[1]);
  expect(view.getByTestId("scope").textContent).toBe("thread-2");
});

test("useThreadActivity 宿主多次重渲染时返回对象引用恒定", () => {
  const handles: Array<ReturnType<typeof useThreadActivity>> = [];

  function Probe({ tick }: { tick: number }) {
    const handle = useThreadActivity("bot-1", "thread-1");
    handles.push(handle);
    return <div data-tick={tick} />;
  }

  const view = render(<Probe tick={0} />);
  view.rerender(<Probe tick={1} />);
  view.rerender(<Probe tick={2} />);

  expect(handles.length).toBe(3);
  expect(Object.is(handles[0], handles[1])).toBe(true);
  expect(Object.is(handles[1], handles[2])).toBe(true);
});

test("ThemeProvider 与 RichUiProvider 稳定 Context 引用，不击穿 memo 消费者", () => {
  let themeRenders = 0;
  let richRenders = 0;
  const ask = () => {};

  const ThemeConsumer = memo(function ThemeConsumer() {
    themeRenders++;
    const { dark } = useTheme();
    return <span>{dark ? "dark" : "light"}</span>;
  });

  const RichConsumer = memo(function RichConsumer() {
    richRenders++;
    const actions = useRichActions();
    return <span>{actions.surface}</span>;
  });

  function Host({ tick, children }: { tick: number; children?: ReactNode }) {
    return (
      <div data-tick={tick}>
        <ThemeProvider>
          <ThemeConsumer />
          <RichUiProvider value={{ surface: "panel", ask }}>
            <RichConsumer />
          </RichUiProvider>
          {children}
        </ThemeProvider>
      </div>
    );
  }

  const view = render(<Host tick={0} />);
  expect(themeRenders).toBe(1);
  expect(richRenders).toBe(1);

  view.rerender(<Host tick={1} />);
  view.rerender(<Host tick={2} />);
  expect(themeRenders).toBe(1);
  expect(richRenders).toBe(1);
});

test("ComposerDock 拖拽过程直写 DOM 不重渲子树，仅 pointerup 提交一次状态并持久化", () => {
  let childRenders = 0;
  const Child = memo(function Child() {
    childRenders++;
    return <div className="composer-frame">{"editor"}</div>;
  });

  function Host() {
    const [n, setN] = useState(0);
    return (
      <div style={{ position: "relative", width: 1000, height: 800 }}>
        <button onClick={() => setN((v) => v + 1)} type="button">
          {n}
        </button>
        <ComposerDock>
          <Child />
        </ComposerDock>
      </div>
    );
  }

  const view = render(<Host />);
  const box = view.container.querySelector(".chat-composer-box");
  const handle = view.container.querySelector(".chat-dock-e");
  expect(box).not.toBeNull();
  expect(handle).not.toBeNull();

  if (
    !(box instanceof HTMLDivElement) ||
    !(handle instanceof HTMLSpanElement)
  ) {
    throw new Error("ComposerDock DOM missing");
  }

  const pane = box.parentElement;
  if (!pane) throw new Error("pane missing");
  pane.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  box.getBoundingClientRect = () =>
    ({
      left: 100,
      top: 680,
      right: 700,
      bottom: 780,
      width: 600,
      height: 100,
      x: 100,
      y: 680,
      toJSON: () => ({}),
    }) as DOMRect;

  const beforeDragRenders = childRenders;

  act(() => {
    fireEvent.pointerDown(handle, {
      button: 0,
      pointerId: 1,
      clientX: 700,
      clientY: 730,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 740,
      clientY: 730,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: 780,
      clientY: 730,
    });
  });

  // 拖拽中直写 DOM 样式，不触发 React 重渲染，且尚未写入 localStorage。
  expect(box.style.width).toBe("680px");
  expect(childRenders).toBe(beforeDragRenders);
  expect(window.localStorage.getItem("chisabot.composer-dock")).toBeNull();

  act(() => {
    fireEvent.pointerUp(handle, {
      pointerId: 1,
      clientX: 780,
      clientY: 730,
    });
  });

  const saved = window.localStorage.getItem("chisabot.composer-dock");
  expect(saved).not.toBeNull();
  expect(JSON.parse(saved ?? "{}").w).toBe(680);
});

test("ui-memory 合并写盘延迟生效，pagehide 兜底落盘", () => {
  setThreadUi("ch_defer", { draft: [{ type: "text", text: "草稿内容" }] });
  // 节流窗口内尚未同步写盘。
  expect(window.localStorage.getItem(UI_MEMORY_KEY)).toBeNull();

  // 页面隐藏前兜底落盘，确保刷新不丢草稿。
  window.dispatchEvent(new Event("pagehide"));
  const raw = window.localStorage.getItem(UI_MEMORY_KEY);
  expect(raw).not.toBeNull();
  expect(raw).toContain("草稿内容");

  // 显式 flushUiMemory 依然有效。
  setThreadUi("ch_defer", { draft: [{ type: "text", text: "第二版" }] });
  flushUiMemory();
  expect(window.localStorage.getItem(UI_MEMORY_KEY)).toContain("第二版");
});
