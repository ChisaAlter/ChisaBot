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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { SkyBackground } from "@/components/sky-background";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE_CONFIG,
  deriveCustomAccentVars,
  flushAppearanceWrites,
  reloadAppearanceFromStorage,
  resetAppearance,
  setAppearanceMode,
  setCustomAccent,
  setStaticBackground,
  themeMetaColor,
} from "@/lib/appearance";
import { cancelActiveThemeTransition } from "@/lib/theme-transition";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));

afterEach(() => {
  cleanup();
  cancelActiveThemeTransition();
  resetAppearance();
  flushAppearanceWrites();
  window.localStorage.clear();
});

afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(async () => {
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  for (const attr of [
    "data-theme",
    "data-material",
    "data-canvas",
    "data-theme-family",
  ]) {
    document.documentElement.removeAttribute(attr);
  }
  document.head.innerHTML =
    '<meta name="theme-color" content="#9dbddc"><meta name="theme-color" content="#0c1626">';
  await reloadAppearanceFromStorage();
});

function ToggleHarness() {
  const { dark, setDark } = useTheme();
  return (
    <button
      data-testid="toggle-theme"
      onClick={() => setDark(!dark)}
      type="button"
    >
      {dark ? "dark" : "light"}
    </button>
  );
}

type MockViewTransition = {
  ready: Promise<void>;
  finished: Promise<void>;
  updateCallbackDone: Promise<void>;
  types: Set<string>;
  skipTransition: () => void;
};

function installMockStartViewTransition(
  impl: (cb: () => Promise<unknown> | undefined) => MockViewTransition,
): () => void {
  const hadOwn = Object.hasOwn(document, "startViewTransition");
  const original = Object.getOwnPropertyDescriptor(
    document,
    "startViewTransition",
  );
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    writable: true,
    value: (cb: ViewTransitionUpdateCallback) =>
      impl(typeof cb === "function" ? () => cb() : () => undefined),
  });
  return () => {
    if (hadOwn && original) {
      Object.defineProperty(document, "startViewTransition", original);
    } else {
      Reflect.deleteProperty(document, "startViewTransition");
    }
  };
}

describe("theme switch synchronizes document tokens with SkyBackground", () => {
  test("toggling dark -> light -> dark updates html.dark, colorScheme, theme-color, and customAccent vars without one-turn lag", async () => {
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        ...DEFAULT_APPEARANCE_CONFIG,
        mode: "dark",
        theme: "sky",
        customAccent: "#facc15",
        canvas: { kind: "pure" },
      }),
    );
    await reloadAppearanceFromStorage();

    const { getByTestId } = render(
      <ThemeProvider>
        <SkyBackground />
        <ToggleHarness />
      </ThemeProvider>,
    );

    const lightAccent = deriveCustomAccentVars("#facc15", false);
    const darkAccent = deriveCustomAccentVars("#facc15", true);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("sky");
    expect(document.documentElement.getAttribute("data-canvas")).toBe("pure");
    expect(
      document.documentElement.style.getPropertyValue("--accent-ink"),
    ).toBe(darkAccent["--accent-ink"]);
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe(themeMetaColor("sky", true));

    act(() => {
      fireEvent.click(getByTestId("toggle-theme"));
    });

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(
      document.documentElement.style.getPropertyValue("--accent-ink"),
    ).toBe(lightAccent["--accent-ink"]);
    expect(
      document.documentElement.style.getPropertyValue("--accent-ink"),
    ).not.toBe(darkAccent["--accent-ink"]);
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe(themeMetaColor("sky", false));

    act(() => {
      fireEvent.click(getByTestId("toggle-theme"));
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(
      document.documentElement.style.getPropertyValue("--accent-ink"),
    ).toBe(darkAccent["--accent-ink"]);

    // 清空自定义强调色后内联变量同步清零
    act(() => {
      setCustomAccent(null);
    });
    expect(
      document.documentElement.style.getPropertyValue("--accent-ink"),
    ).toBe("");
  });

  test("html.dark 翻转瞬间 data-theme-switching=\"1\" 已挂齐，消灭半明半暗 1 帧撕裂", async () => {
    setAppearanceMode("light");
    const root = document.documentElement;
    const capture: { switchingDuringFlip: string | null } = {
      switchingDuringFlip: null,
    };
    const originalToggle = root.classList.toggle.bind(root.classList);
    root.classList.toggle = ((token: string, force?: boolean) => {
      if (token === "dark") {
        capture.switchingDuringFlip = root.getAttribute("data-theme-switching");
      }
      return originalToggle(token, force);
    }) as typeof root.classList.toggle;

    try {
      setAppearanceMode("dark");
      expect(capture.switchingDuringFlip).toBe("1");
      expect(root.classList.contains("dark")).toBe(true);
    } finally {
      root.classList.toggle = originalToggle;
    }
  });

  test("支持 startViewTransition 时走 GPU 交叉淡入，并在 finished 后才解除冻结", async () => {
    setAppearanceMode("light");
    const root = document.documentElement;
    let resolveFinished: (() => void) | undefined;
    let calls = 0;
    const capture: { switchingAtApply: string | null; darkAtApply: boolean } = {
      switchingAtApply: null,
      darkAtApply: false,
    };

    const restoreVT = installMockStartViewTransition((cb) => {
      calls += 1;
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      void Promise.resolve(cb());
      capture.switchingAtApply = root.getAttribute("data-theme-switching");
      capture.darkAtApply = root.classList.contains("dark");
      return {
        ready: Promise.resolve(),
        finished,
        updateCallbackDone: Promise.resolve(),
        types: new Set<string>(),
        skipTransition: () => {},
      };
    });

    try {
      setAppearanceMode("dark");
      expect(calls).toBe(1);
      expect(capture.switchingAtApply).toBe("1");
      expect(capture.darkAtApply).toBe(true);
      expect(root.getAttribute("data-theme-switching")).toBe("1");

      resolveFinished?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(root.getAttribute("data-theme-switching")).toBeNull();
    } finally {
      cancelActiveThemeTransition();
      restoreVT();
    }
  });

  test("快速连点两次切换时 skipTransition 中断旧过渡，旧 finished 晚到不误删新冻结标记", async () => {
    setAppearanceMode("light");
    const root = document.documentElement;
    const finishes: Array<() => void> = [];
    let skippedCount = 0;

    const restoreVT = installMockStartViewTransition((cb) => {
      const finished = new Promise<void>((resolve) => {
        finishes.push(resolve);
      });
      void Promise.resolve(cb());
      return {
        ready: Promise.resolve(),
        finished,
        updateCallbackDone: Promise.resolve(),
        types: new Set<string>(),
        skipTransition: () => {
          skippedCount += 1;
        },
      };
    });

    try {
      setAppearanceMode("dark");
      expect(root.getAttribute("data-theme-switching")).toBe("1");
      setAppearanceMode("light");
      expect(skippedCount).toBe(1);
      expect(root.getAttribute("data-theme-switching")).toBe("1");
      expect(root.classList.contains("dark")).toBe(false);

      // 旧过渡 finished 晚到，不得移除当前第二次切换的 data-theme-switching
      finishes[0]?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(root.getAttribute("data-theme-switching")).toBe("1");

      // 第二个过渡结束后才清理
      finishes[1]?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(root.getAttribute("data-theme-switching")).toBeNull();
    } finally {
      cancelActiveThemeTransition();
      restoreVT();
    }
  });

  test("prefers-reduced-motion 或 staticBackground 时跳过 startViewTransition 走同步冻结回退", () => {
    setAppearanceMode("light");
    const root = document.documentElement;
    const originalMatchMedia = window.matchMedia;
    let vtCalls = 0;

    const restoreVT = installMockStartViewTransition((cb) => {
      vtCalls += 1;
      void Promise.resolve(cb());
      return {
        ready: Promise.resolve(),
        finished: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        types: new Set<string>(),
        skipTransition: () => {},
      };
    });

    try {
      setStaticBackground(true);
      setAppearanceMode("dark");
      expect(vtCalls).toBe(0);
      expect(root.classList.contains("dark")).toBe(true);

      setStaticBackground(false);
      window.matchMedia = ((query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList) as typeof window.matchMedia;

      setAppearanceMode("light");
      expect(vtCalls).toBe(0);
      expect(root.classList.contains("dark")).toBe(false);
    } finally {
      cancelActiveThemeTransition();
      window.matchMedia = originalMatchMedia;
      restoreVT();
    }
  });

  test("styles.css 包含 ViewTransition 非阻塞交叉淡入及减动效归零规则", () => {
    const stylesCss = readFileSync(
      path.join(import.meta.dir, "../src/styles.css"),
      "utf8",
    );
    expect(stylesCss).toMatch(/::view-transition\s*\{[^}]*pointer-events:\s*none;/);
    expect(stylesCss).toContain("ch-theme-crossfade");
    expect(stylesCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?::view-transition-new\(root\)[\s\S]*?animation:\s*none;/,
    );
  });
});
