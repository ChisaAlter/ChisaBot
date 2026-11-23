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
  setCustomAccent,
  themeMetaColor,
} from "@/lib/appearance";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));

afterEach(() => {
  cleanup();
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
});
