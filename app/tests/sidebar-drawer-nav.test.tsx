import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { BotChatMenuItems } from "@/components/agents/bot-chat-actions";
import { Channel } from "@/components/app-sidebar/channel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sidebar, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { settleReactWork } from "./settle-react-work";

/**
 * 手机抽屉里点导航项要收起抽屉（审计 M3-1 / M3-11）：同一个 scope 里换页时 CloseDrawerOnScope 不关，
 * 抽屉就盖在新页面上，看着像没点中。M3-14：会话行是链接，不带 type="button"。
 */

let originalMatchMedia: typeof window.matchMedia;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register();
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

afterAll(async () => {
  await settleReactWork();
  window.matchMedia = originalMatchMedia;
  GlobalRegistrator.unregister();
});

function State() {
  const sidebar = useSidebar();
  return (
    <>
      <output data-testid="drawer">
        {sidebar.openMobile ? "open" : "closed"}
      </output>
      <button onClick={() => sidebar.setOpenMobile(true)} type="button">
        {"open drawer"}
      </button>
    </>
  );
}

async function renderInDrawer(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(queryClient);
  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Sidebar>{children}</Sidebar>
        <State />
      </SidebarProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => view.getByText("open drawer"));
  act(() => {
    fireEvent.click(view.getByText("open drawer"));
  });
  expect(view.getByTestId("drawer").textContent).toBe("open");
  return { view, router };
}

test("M3-1：点抽屉里的会话行（搜索结果里的本地命中）：进会话并收起抽屉", async () => {
  const { view, router } = await renderInDrawer(
    <Channel
      busy={false}
      channelId="c-42"
      emphasis="thread"
      name="助手"
      participantIds={["bot-a"]}
      pinned={false}
      summary="周报"
      unread={false}
    />,
  );
  const link = view.getByRole("link");
  expect(link.getAttribute("href")).toBe("/channel/c-42");
  // M3-14：<a type="button"> 在 HTML 上无效。
  expect(link.hasAttribute("type")).toBe(false);
  await act(async () => {
    fireEvent.click(link, { button: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFor(() =>
    expect(view.getByTestId("drawer").textContent).toBe("closed"),
  );
  expect(router.state.location.pathname).toBe("/channel/c-42");
});

test("M3-11：机器人菜单的「新话题」做完回调 onDone（抽屉里用它收起抽屉）", async () => {
  let done = 0;
  const { view, router } = await renderInDrawer(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>{"menu"}</DropdownMenuTrigger>
      <DropdownMenuContent>
        <BotChatMenuItems agentId="bot-a" chat={null} onDone={() => done++} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  const item = await waitFor(() => view.getByText("新话题"));
  await act(async () => {
    fireEvent.click(item);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(done).toBe(1);
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/new"),
  );
  expect(router.state.location.search).toMatchObject({
    agent: "bot-a",
    topic: "new",
  });
});

test("M3-11 接线：资料 / 历史对话 / 新话题 / 面板 收起抽屉；挂在行里的对话框类菜单项不收", () => {
  const src = readFileSync(
    path.join(import.meta.dir, "../src/components/app-sidebar/app-sidebar.tsx"),
    "utf8",
  );
  const start = src.indexOf("function BotMenuContent(");
  const menu = src.slice(start, src.indexOf("\n}\n", start));
  expect(menu).toContain("const closeDrawer = useCloseMobileDrawer();");
  expect(menu).toContain(
    '<Link onClick={closeDrawer} params={{ agentId: bot.id }} to="/bots/$agentId" />',
  );
  expect(menu).toContain(
    "<BotChatMenuItems agentId={bot.id} chat={chat} onDone={closeDrawer} />",
  );
  expect(menu).toMatch(/showPanels\(\);\s*closeDrawer\(\);/);
  // 对话框挂在机器人行里（抽屉里面），收起抽屉会把它们一起卸掉。
  expect(menu).toContain("onClick={onComputer}");
  expect(menu).toContain("onClick={onDelete}");
});
