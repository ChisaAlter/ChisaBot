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
  reloadAppearanceFromStorage,
  SKY_SOURCE_STORAGE_KEY,
} from "@/lib/appearance";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import {
  deriveSeed,
  familySeed,
  resolveThemeFamily,
} from "@/lib/theme-family";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(SKY_SOURCE_STORAGE_KEY, "theme");
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-family");
  document.documentElement.style.cssText = "";
  reloadAppearanceFromStorage();
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
  test("toggling dark -> light -> dark updates --ink-1 and --glass-bg without one-turn lag", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    document.documentElement.classList.add("dark");

    const { getByTestId } = render(
      <ThemeProvider>
        <SkyBackground />
        <ToggleHarness />
      </ThemeProvider>,
    );

    const family = resolveThemeFamily("azure");
    const lightRoot = deriveSeed(familySeed(family, false), false).root;
    const darkRoot = deriveSeed(familySeed(family, true), true).root;

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--ink-1")).toBe(
      darkRoot["--ink-1"],
    );

    act(() => {
      fireEvent.click(getByTestId("toggle-theme"));
    });

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--ink-1")).toBe(
      lightRoot["--ink-1"],
    );
    expect(document.documentElement.style.getPropertyValue("--ink-1")).not.toBe(
      darkRoot["--ink-1"],
    );
    expect(document.documentElement.style.getPropertyValue("--glass-bg")).toBe(
      lightRoot["--glass-bg"],
    );

    act(() => {
      fireEvent.click(getByTestId("toggle-theme"));
    });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--ink-1")).toBe(
      darkRoot["--ink-1"],
    );
    expect(document.documentElement.style.getPropertyValue("--glass-bg")).toBe(
      darkRoot["--glass-bg"],
    );
  });
});
