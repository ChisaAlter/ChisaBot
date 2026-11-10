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
import { AppearancePreferences } from "@/components/settings/appearance-preferences";
import {
  flushAppearanceWrites,
  GLASS_STYLE_STORAGE_KEY,
  getAppearanceState,
  reloadAppearanceFromStorage,
  resetAppearanceDefaults,
  setGlassStyle,
} from "@/lib/appearance";
import { paletteBootScript } from "@/lib/palette";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  window.localStorage.clear();
  reloadAppearanceFromStorage();
});

describe("default glass is mist", () => {
  test("fresh storage reads mist at 16/16 haze", () => {
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(getAppearanceState().glassOpacity).toBe(16);
    expect(getAppearanceState().glassOpacityDark).toBe(16);
  });

  test("resetAppearanceDefaults returns to mist, not liquid", () => {
    setGlassStyle("liquid");
    flushAppearanceWrites();
    resetAppearanceDefaults();
    flushAppearanceWrites();
    expect(getAppearanceState().glassStyle).toBe("mist");
    expect(getAppearanceState().glassOpacity).toBe(16);
    expect(getAppearanceState().glassOpacityDark).toBe(16);
    expect(window.localStorage.getItem(GLASS_STYLE_STORAGE_KEY)).toBe("mist");
  });

  test("a stored liquid preference is kept (no migration overwrite)", () => {
    window.localStorage.setItem(GLASS_STYLE_STORAGE_KEY, "liquid");
    reloadAppearanceFromStorage();
    expect(getAppearanceState().glassStyle).toBe("liquid");
  });

  test("boot script writes mist when localStorage has no glass style", () => {
    const boot = paletteBootScript();
    expect(boot).toContain('indexOf(g)>=0?g:"mist"');
    // Evaluate the boot snippet against an empty storage.
    document.documentElement.removeAttribute("data-glass");
    Function(boot)();
    expect(document.documentElement.getAttribute("data-glass")).toBe("mist");
  });

  test("settings dirty check treats mist+16 as default (no reset button)", async () => {
    resetAppearanceDefaults();
    flushAppearanceWrites();
    const view = render(<AppearancePreferences />);
    expect(view.queryByRole("button", { name: "恢复默认" })).toBeNull();
    act(() => {
      setGlassStyle("liquid");
      flushAppearanceWrites();
    });
    view.rerender(<AppearancePreferences />);
    expect(view.getByRole("button", { name: "恢复默认" })).toBeTruthy();
  });
});
