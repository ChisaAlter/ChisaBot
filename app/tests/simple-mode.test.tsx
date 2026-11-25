import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
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
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { AccountMenu } from "@/components/layout/account-menu";
import { SimpleModePreference } from "@/components/settings/simple-mode-preference";
import { TaskCenterProvider } from "@/components/task-center/task-center-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { approvalInboxOptions } from "@/lib/approvals";
import { authKeys } from "@/lib/auth/keys";
import { recentConfirmationsQueryOptions } from "@/lib/confirmations";
import { formatHotkey, getHotkey, matchesHotkey } from "@/lib/hotkeys/hotkeys";
import { findEntry } from "@/lib/settings/registry";
import {
  installSimpleMode,
  isSimpleModeEnabled,
  resetSimpleModeForTest,
  SIMPLE_MODE_STORAGE_KEY,
  setSimpleMode,
  toggleSimpleMode,
} from "@/lib/simple-mode";
import { settleReactWork } from "./settle-react-work";

const readAppFile = (rel: string) =>
  readFileSync(path.join(import.meta.dir, "..", rel), "utf8");

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

beforeEach(() => {
  window.localStorage.clear();
  resetSimpleModeForTest();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetSimpleModeForTest();
});

afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

describe("simple-mode 状态与持久化", () => {
  test("默认关闭，且不在 <html> 上挂载 data-simple-mode", () => {
    expect(isSimpleModeEnabled()).toBe(false);
    expect(document.documentElement.dataset.simpleMode).toBeUndefined();
    expect(window.localStorage.getItem(SIMPLE_MODE_STORAGE_KEY)).toBeNull();
  });

  test("setSimpleMode / toggleSimpleMode 同步持久化与 DOM 属性，刷新后记住状态", () => {
    expect(toggleSimpleMode()).toBe(true);
    expect(isSimpleModeEnabled()).toBe(true);
    expect(document.documentElement.dataset.simpleMode).toBe("1");
    expect(window.localStorage.getItem(SIMPLE_MODE_STORAGE_KEY)).toBe("1");

    // 模拟刷新页面（清内存缓存与 DOM，仅保留 localStorage）
    resetSimpleModeForTest();
    expect(isSimpleModeEnabled()).toBe(true);
    const cleanupInstall = installSimpleMode();
    expect(document.documentElement.dataset.simpleMode).toBe("1");
    cleanupInstall();

    expect(toggleSimpleMode()).toBe(false);
    expect(isSimpleModeEnabled()).toBe(false);
    expect(document.documentElement.dataset.simpleMode).toBeUndefined();
    expect(window.localStorage.getItem(SIMPLE_MODE_STORAGE_KEY)).toBe("0");

    setSimpleMode(true);
    expect(isSimpleModeEnabled()).toBe(true);
    expect(document.documentElement.dataset.simpleMode).toBe("1");
  });

  test("installSimpleMode 监听跨标签页 storage 事件并支持卸载清理", () => {
    const dispose = installSimpleMode();
    expect(isSimpleModeEnabled()).toBe(false);

    // 其他键变更不影响精简模式
    window.localStorage.setItem("other-key", "1");
    window.dispatchEvent(
      new window.StorageEvent("storage", {
        key: "other-key",
        newValue: "1",
        storageArea: window.localStorage,
      }),
    );
    expect(isSimpleModeEnabled()).toBe(false);

    // 外部标签页开启精简模式
    window.localStorage.setItem(SIMPLE_MODE_STORAGE_KEY, "1");
    window.dispatchEvent(
      new window.StorageEvent("storage", {
        key: SIMPLE_MODE_STORAGE_KEY,
        newValue: "1",
        storageArea: window.localStorage,
      }),
    );
    expect(isSimpleModeEnabled()).toBe(true);
    expect(document.documentElement.dataset.simpleMode).toBe("1");

    // 外部标签页关闭精简模式
    window.localStorage.setItem(SIMPLE_MODE_STORAGE_KEY, "0");
    window.dispatchEvent(
      new window.StorageEvent("storage", {
        key: SIMPLE_MODE_STORAGE_KEY,
        newValue: "0",
        storageArea: window.localStorage,
      }),
    );
    expect(isSimpleModeEnabled()).toBe(false);
    expect(document.documentElement.dataset.simpleMode).toBeUndefined();

    // 清理后不再响应 storage 事件
    dispose();
    window.localStorage.setItem(SIMPLE_MODE_STORAGE_KEY, "1");
    window.dispatchEvent(
      new window.StorageEvent("storage", {
        key: SIMPLE_MODE_STORAGE_KEY,
        newValue: "1",
        storageArea: window.localStorage,
      }),
    );
    expect(isSimpleModeEnabled()).toBe(false);
  });
});

describe("SimpleModePreference 设置项与快捷键 / 搜索登记", () => {
  test("渲染 data-setting-item 锚点、快捷键说明并可点击切换状态", () => {
    const view = render(<SimpleModePreference />);
    const item = view.container.querySelector(
      '[data-setting-item="general.simple-mode"]',
    );
    expect(item).toBeTruthy();

    const expectedShortcut = formatHotkey(getHotkey("simple-mode").combo).join(
      "+",
    );
    expect(view.container.textContent).toContain("精简模式");
    expect(view.container.textContent).toContain(expectedShortcut);

    const toggle = view.getByTestId("simple-mode-switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(isSimpleModeEnabled()).toBe(true);
    expect(document.documentElement.dataset.simpleMode).toBe("1");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(isSimpleModeEnabled()).toBe(false);
    expect(document.documentElement.dataset.simpleMode).toBeUndefined();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  test("快捷键与设置搜索登记表与契约一致", () => {
    const hotkey = getHotkey("simple-mode");
    expect(hotkey.label).toBe("切换精简模式");
    expect(hotkey.combo).toEqual({ key: "m", mod: true, alt: true });

    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    const matchingEvent = {
      key: "m",
      code: "KeyM",
      ctrlKey: !isMac,
      metaKey: isMac,
      altKey: true,
      shiftKey: false,
    } as KeyboardEvent;
    expect(matchesHotkey(matchingEvent, hotkey.combo)).toBe(true);

    const entry = findEntry("general.simple-mode");
    expect(entry?.item?.find).toBe("精简模式");
    expect(entry?.item?.keywords).toContain("grokbot");
    expect(entry?.item?.keywords).toContain("jjms");
  });

  test("AccountMenu 精简模式开关实时切换并按模式收紧菜单项", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    queryClient.setQueryData(authKeys.currentUser(), {
      id: "u1",
      email: "user@example.com",
      name: "测试用户",
      role: "user",
      onboarding: null,
    });
    queryClient.setQueryData(approvalInboxOptions().queryKey, {
      enabled: false,
      requests: [],
      rules: [],
      teamRules: [],
      questions: [],
    });
    queryClient.setQueryData(recentConfirmationsQueryOptions().queryKey, []);

    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <TaskCenterProvider>
              <AccountMenu />
              <Outlet />
            </TaskCenterProvider>
          </ThemeProvider>
        </QueryClientProvider>
      ),
    });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <div>{"home"}</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();

    const view = render(<RouterProvider router={router} />);
    fireEvent.click(view.getByRole("button", { name: "账号与设置" }));

    await waitFor(() => {
      expect(view.getByTestId("account-simple-mode-row")).toBeTruthy();
    });

    // 标准模式下全部入口均可见
    expect(view.getByText("个人资料")).toBeTruthy();
    expect(view.getByText("设置")).toBeTruthy();
    expect(view.getByText("任务中心")).toBeTruthy();
    expect(view.getByText("定时任务")).toBeTruthy();
    expect(view.getByText("待处理")).toBeTruthy();
    expect(view.getByText("外观")).toBeTruthy();
    expect(view.getByText("退出登录")).toBeTruthy();

    // 点击精简模式开关，立即进入精简模式且菜单不关闭，收紧非核心入口
    fireEvent.click(view.getByTestId("account-simple-mode-switch"));
    await waitFor(() => {
      expect(isSimpleModeEnabled()).toBe(true);
      expect(view.queryByText("任务中心")).toBeNull();
    });
    expect(view.queryByText("定时任务")).toBeNull();
    expect(view.queryByText("待处理")).toBeNull();
    expect(view.getByText("个人资料")).toBeTruthy();
    expect(view.getByText("设置")).toBeTruthy();
    expect(view.getByText("精简模式")).toBeTruthy();
    expect(view.getByText("外观")).toBeTruthy();
    expect(view.getByText("退出登录")).toBeTruthy();

    // 再次点击整行即可一键切回标准模式
    fireEvent.click(view.getByTestId("account-simple-mode-row"));
    await waitFor(() => {
      expect(isSimpleModeEnabled()).toBe(false);
      expect(view.getByText("任务中心")).toBeTruthy();
    });
  });
});

describe("首屏防闪烁与 simple-mode.css 性能红线静态校验", () => {
  test("app/index.html 首屏脚本同步写入 data-simple-mode 且骨架规则在 data-phone 之前", () => {
    const html = readAppFile("index.html");
    expect(html).toContain(
      'window.localStorage.getItem("chisabot.simple-mode") === "1"',
    );
    expect(html).toContain('d.setAttribute("data-simple-mode", "1")');

    const simpleColsIdx = html.indexOf(
      'html[data-simple-mode="1"] .boot-cols { grid-template-columns: 260px minmax(0, 1fr); }',
    );
    const simpleHideThirdIdx = html.indexOf(
      'html[data-simple-mode="1"] .boot-cols > :nth-child(3) { display: none; }',
    );
    const phoneIdx = html.indexOf("html[data-phone] .boot-cols");
    expect(simpleColsIdx).toBeGreaterThan(-1);
    expect(simpleHideThirdIdx).toBeGreaterThan(-1);
    expect(phoneIdx).toBeGreaterThan(simpleColsIdx);
    expect(phoneIdx).toBeGreaterThan(simpleHideThirdIdx);
  });

  test('simple-mode.css 严格遵守性能红线且所有规则带 html[data-simple-mode="1"] 前缀', () => {
    const rawCss = readAppFile("src/styles/simple-mode.css");
    const stripped = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

    expect(stripped).not.toContain(":has(");
    expect(stripped).not.toContain("!important");
    expect(stripped).not.toContain("backdrop-filter");
    expect(stripped).not.toContain("group-has-");
    expect(stripped).not.toContain("peer-has-");
    expect(stripped).not.toMatch(/html[^{]*\{[^}]*--surface-/);

    expect(stripped).toContain(".chat-dock-handles");
    expect(stripped).toContain(".glass-mini-comp");
    expect(stripped).toContain(".composer-spotlight-btn");

    for (const match of stripped.matchAll(/([^{};]+)\{/g)) {
      const prelude = match[1]?.trim() ?? "";
      if (!prelude || prelude.startsWith("@")) continue;
      const selectors = prelude.split(",").map((s) => s.trim());
      for (const selector of selectors) {
        expect(selector.startsWith('html[data-simple-mode="1"]')).toBe(true);
      }
    }
  });
});
