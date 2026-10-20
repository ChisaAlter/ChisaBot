import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { LiveScreen } from "@/components/computer/live-screen";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { closeCreateBot } from "@/lib/agents/create-bot";
import { AppHotkeys } from "@/lib/hotkeys/app-hotkeys";
import { settleReactWork } from "./settle-react-work";

/**
 * The app's own shortcuts while a person drives a Bot's browser.
 *
 * Every keystroke then belongs to the Bot's browser: LiveScreen forwards it and prevents its default.
 * The app's shortcuts listen on the same window, and they were bound first, when the signed-in app
 * mounted, so they saw each keystroke before LiveScreen did and acted on it as well. Typing a
 * capital N into a page, "New York" in a search box, started a new chat and took the person away
 * from the Bot mid-word; Ctrl+B, bold in a document, showed or hid the sidebar here as well.
 *
 * 这一支从「开新对话」搬到了「新建机器人」：没有「新对话」这个快捷键了（`AppHotkeys` 的
 * `new-bot`，Shift+N），原来按 N 会跳走的那条路现在打开建机器人的弹窗。要守的不变量没变：
 * 人在开机器人浏览器时，Shift+N / Ctrl+B 都只属于那个页面，应用这边一概不动。
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(_url: string) {
    SocketDouble.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

let originalWebSocket: typeof WebSocket;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
});

afterEach(() => {
  cleanup();
  // 建机器人的开关是模块级的：忘了关，下一个用例就从一张开着的弹窗开始。
  closeCreateBot();
  SocketDouble.latest = undefined;
});

afterAll(async () => {
  // 抽掉 document 之前先把 React 排着的活干完（见 `settle-react-work.ts`），否则它会报成
  // 「Unhandled error between tests」：零个失败用例、非零退出码。
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

function SidebarState() {
  return <output>{useSidebar().open ? "open" : "closed"}</output>;
}

/** The signed-in shell's shortcuts and sidebar, around a conversation showing a Bot's screen. */
async function renderDriving(driving: boolean) {
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <AppHotkeys />
        <SidebarState />
        <Outlet />
      </SidebarProvider>
    ),
  });
  const conversation = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <LiveScreen computerId="shortcut-test" driving={driving} />
    ),
  });
  const newChat = createRoute({
    getParentRoute: () => rootRoute,
    path: "/channel/new",
    component: () => <p>New chat</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([conversation, newChat]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  /*
   * `AppHotkeys` 挂的就是那一个 `CreateAgentDialog`，表单里要 `useQueryClient()`（快捷方式现在打开的
   * 是它）。少了这个 provider，按 N 不是「没打开弹窗」而是整个树炸掉。
   */
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelector("canvas")).not.toBeNull(),
  );
  if (driving) await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  return {
    router,
    view,
    sidebar: () => view.container.querySelector("output")?.textContent,
    /** A keystroke where the browser sends one while the page has no focused field: at the body. */
    press(init: KeyboardEventInit) {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", {
            ...init,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
  };
}

test("a capital N typed into the Bot's browser goes to it, and does not start a new chat", async () => {
  const screen = await renderDriving(true);

  screen.press({ key: "N", code: "KeyN", keyCode: 78, shiftKey: true });
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(screen.router.state.location.pathname).toBe("/");
  // 应用这边的 Shift+N（新建机器人）没有跟着开：N 是那个人正在打的字，不是快捷方式。
  expect(screen.view.queryByRole("dialog")).toBeNull();
  expect(SocketDouble.latest?.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "N",
      code: "KeyN",
      text: "N",
      windowsVirtualKeyCode: 78,
      modifiers: 8,
    },
  ]);
});

test("Ctrl+B typed into the Bot's browser goes to it, and leaves the sidebar alone", async () => {
  const screen = await renderDriving(true);

  screen.press({ key: "b", code: "KeyB", keyCode: 66, ctrlKey: true });

  expect(screen.sidebar()).toBe("open");
  expect(SocketDouble.latest?.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "b",
      code: "KeyB",
      text: "b",
      windowsVirtualKeyCode: 66,
      modifiers: 2,
    },
  ]);
});

test("the same shortcuts still work while nobody is driving", async () => {
  const screen = await renderDriving(false);

  screen.press({ key: "b", code: "KeyB", keyCode: 66, ctrlKey: true });
  expect(screen.sidebar()).toBe("closed");

  // 没人开浏览器时 Shift+N 照常是应用自己的快捷键：打开「新建机器人」。
  screen.press({ key: "N", code: "KeyN", keyCode: 78, shiftKey: true });
  expect(
    await screen.view.findByRole("dialog", { name: "新建机器人" }),
  ).toBeTruthy();
});
