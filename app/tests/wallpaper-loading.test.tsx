import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { settleReactWork } from "./settle-react-work";

/**
 * 刷新时「壁纸读取中」：localStorage 只有占位标记、选的是自定义壁纸时，先只铺主题纯色、不挂天空；
 * IndexedDB 读回成功直接显示壁纸；读取失败、没有记录或超过约 1.5 秒才退回天空。
 * 「天空露出来」= 挂着天空占位（#skyph）却没有壁纸层盖住（有壁纸时天空节点照常在壁纸下面，看不到）。
 * DOM 每次变化（MutationObserver）和外观状态每次变化（subscribeAppearance）都检查一遍：先闪一帧也算失败。
 */
type Appearance = typeof import("../src/lib/appearance");
type Store = typeof import("../src/lib/wallpaper-store");
type Sky = typeof import("../src/components/sky-background");
type Theme = typeof import("../src/components/theme-provider");

let appearance: Appearance;
let store: Store;
let SkyBackground: Sky["SkyBackground"];
let ThemeProvider: Theme["ThemeProvider"];

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  appearance = await import("../src/lib/appearance");
  store = await import("../src/lib/wallpaper-store");
  ({ SkyBackground } = await import("../src/components/sky-background"));
  ({ ThemeProvider } = await import("../src/components/theme-provider"));
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

const DATA_URL = `data:image/webp;base64,${"A".repeat(2048)}`;
let restoreBackend: import("../src/lib/wallpaper-store").WallpaperBackend;
let originalFetch: typeof window.fetch;
let skyShown: string[];
let observer: MutationObserver;
let unsubscribe: () => void;

/** get() 由测试决定什么时候、以什么结果返回。 */
function controlledBackend() {
  let settle: (value: string | null) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const pending = new Promise<string | null>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  restoreBackend = store.setWallpaperBackend({
    get: () => pending,
    put: async () => {},
    remove: async () => {},
  });
  return { settle, fail };
}

beforeEach(() => {
  window.localStorage.clear();
  // 退回天空时组件会去取 /wallpaper_core.html：测试里不发真请求，直接 404（引擎不启动）。
  originalFetch = window.fetch;
  window.fetch = (async () =>
    new Response(null, { status: 404 })) as unknown as typeof window.fetch;
  skyShown = [];
  observer = new MutationObserver(() => {
    const root = document.getElementById("sky-root");
    if (
      root?.querySelector("#skyph") &&
      !root.querySelector(".chisabot-wallpaper")
    )
      skyShown.push("dom");
  });
  observer.observe(document.body, { childList: true, subtree: true });
  unsubscribe = appearance.subscribeAppearance(() => {
    const state = appearance.getAppearanceState();
    if (
      !appearance.isWallpaperLoading() &&
      appearance.resolveActiveWallpaperCss(state) === null
    )
      skyShown.push("state");
  });
});

afterEach(async () => {
  observer.disconnect();
  unsubscribe();
  cleanup();
  appearance.resetAppearanceDefaults();
  appearance.flushAppearanceWrites();
  if (restoreBackend) store.setWallpaperBackend(restoreBackend);
  window.fetch = originalFetch;
  window.localStorage.clear();
  await settleReactWork();
});

/** 模拟刷新：localStorage 里是自定义壁纸 + 占位标记，然后重新读取外观、挂上背景。 */
function refreshWithStoredWallpaper() {
  window.localStorage.setItem(appearance.WALLPAPER_ID_STORAGE_KEY, "custom");
  window.localStorage.setItem(
    appearance.WALLPAPER_CUSTOM_URL_STORAGE_KEY,
    store.WALLPAPER_IDB_MARKER,
  );
  const loaded = appearance.reloadAppearanceFromStorage();
  render(
    <ThemeProvider>
      <SkyBackground />
    </ThemeProvider>,
  );
  return loaded;
}

const skyRoot = () => document.getElementById("sky-root");

function expectLoadingShell() {
  expect(appearance.isWallpaperLoading()).toBe(true);
  const root = skyRoot();
  expect(root?.hasAttribute("data-wallpaper-loading")).toBe(true);
  expect(root?.style.background).toBe("var(--sky-2)");
  expect(root?.querySelector("#skyph")).toBeNull();
  expect(root?.querySelector("#gl")).toBeNull();
  expect(document.documentElement.hasAttribute("data-sky-off")).toBe(true);
}

function expectSkyBack() {
  expect(appearance.isWallpaperLoading()).toBe(false);
  const root = skyRoot();
  expect(root?.hasAttribute("data-wallpaper-loading")).toBe(false);
  expect(root?.querySelector("#skyph")).not.toBeNull();
  expect(root?.querySelector("#gl")).not.toBeNull();
  expect(root?.querySelector(".chisabot-wallpaper")).toBeNull();
}

describe("刷新时自定义壁纸不先闪天空", () => {
  test("IndexedDB 读回成功：读取中只铺纯色，读回后直接显示壁纸，天空一次都没挂过", async () => {
    const db = controlledBackend();
    const loaded = refreshWithStoredWallpaper();
    expectLoadingShell();

    db.settle(DATA_URL);
    await act(async () => {
      await loaded;
    });

    expect(appearance.isWallpaperLoading()).toBe(false);
    expect(appearance.getAppearanceState().customWallpaperUrl).toBe(DATA_URL);
    const root = skyRoot();
    expect(root?.hasAttribute("data-wallpaper-loading")).toBe(false);
    expect(root?.querySelector(".chisabot-wallpaper")).not.toBeNull();
    expect(document.documentElement.getAttribute("data-wallpaper")).toBe("on");
    expect(document.documentElement.hasAttribute("data-sky-off")).toBe(true);
    expect(skyShown).toEqual([]);
  });

  test("读取失败：退回天空", async () => {
    const db = controlledBackend();
    const loaded = refreshWithStoredWallpaper();
    expectLoadingShell();

    db.fail(new Error("IndexedDB 打不开"));
    await act(async () => {
      await loaded;
    });

    expectSkyBack();
    expect(appearance.getAppearanceState().customWallpaperUrl).toBe("");
  });

  test("IndexedDB 里没有记录：退回天空", async () => {
    const db = controlledBackend();
    const loaded = refreshWithStoredWallpaper();
    expectLoadingShell();

    db.settle(null);
    await act(async () => {
      await loaded;
    });

    expectSkyBack();
  });

  test("超过约 1.5 秒还没读回：退回天空，之前一直是纯色", async () => {
    controlledBackend(); // 永远不返回
    const started = performance.now();
    const loaded = refreshWithStoredWallpaper();
    expectLoadingShell();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expectLoadingShell();
    expect(skyShown).toEqual([]);

    await act(async () => {
      await loaded;
    });

    expect(performance.now() - started).toBeGreaterThanOrEqual(
      appearance.WALLPAPER_LOAD_TIMEOUT_MS - 50,
    );
    expectSkyBack();
  });
});

describe("壁纸读取中的边界", () => {
  test("超时退回天空后才读回：照样补上壁纸（只是晚一点，不会丢）", async () => {
    const db = controlledBackend();
    const loaded = refreshWithStoredWallpaper();
    await act(async () => {
      await loaded;
    });
    expectSkyBack();

    await act(async () => {
      db.settle(DATA_URL);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(appearance.getAppearanceState().customWallpaperUrl).toBe(DATA_URL);
    expect(skyRoot()?.querySelector(".chisabot-wallpaper")).not.toBeNull();
  });

  test("读取中改选别的壁纸：立即结束读取中，迟到的读取结果不覆盖用户的选择", async () => {
    const db = controlledBackend();
    const loaded = refreshWithStoredWallpaper();
    expectLoadingShell();

    act(() => {
      appearance.updateAppearance({ wallpaperId: "none" });
    });
    expect(appearance.isWallpaperLoading()).toBe(false);
    expect(skyRoot()?.hasAttribute("data-wallpaper-loading")).toBe(false);

    db.settle(DATA_URL);
    await act(async () => {
      await loaded;
    });
    expect(appearance.getAppearanceState().wallpaperId).toBe("none");
    expect(appearance.getAppearanceState().customWallpaperUrl).toBe("");
    expect(appearance.isWallpaperLoading()).toBe(false);
  });
});
