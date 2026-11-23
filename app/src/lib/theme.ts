export type AppearanceMode = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "chisabot-theme";

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function parseAppearanceMode(
  value: string | null | undefined,
): AppearanceMode {
  if (value === "dark" || value === "light" || value === "system") {
    return value;
  }
  return "system";
}

export function parseStoredDarkTheme(value: string | null): boolean {
  return value === "dark";
}

function systemDarkMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(SYSTEM_DARK_QUERY);
}

export function prefersSystemDark(): boolean {
  return systemDarkMediaQuery()?.matches ?? false;
}

export function resolveDarkTheme(
  mode: AppearanceMode,
  systemDark?: boolean,
): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return systemDark ?? prefersSystemDark();
}

export function subscribeSystemDark(listener: () => void): () => void {
  const mq = systemDarkMediaQuery();
  if (!mq) return () => {};
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }
  mq.addListener?.(listener);
  return () => mq.removeListener?.(listener);
}

export function notifyAndroidTheme(
  dark: boolean,
  mode?: AppearanceMode,
): void {
  if (typeof window === "undefined") return;
  const bridge = (
    window as Window & {
      ChisaAndroid?: {
        setTheme?: (resolved: "dark" | "light") => void;
        setThemeMode?: (mode: AppearanceMode) => void;
      };
    }
  ).ChisaAndroid;
  if (!bridge) return;
  if (mode === "system" && typeof bridge.setThemeMode === "function") {
    bridge.setThemeMode("system");
    return;
  }
  if (mode && typeof bridge.setThemeMode === "function") {
    bridge.setThemeMode(mode);
  }
  bridge.setTheme?.(dark ? "dark" : "light");
}

type ThemeEffects = {
  setStoredValue?: (key: string, value: string) => void;
  toggleRootClass: (name: string, force: boolean) => void;
  setRootColorScheme: (scheme: "dark" | "light") => void;
};

export function applyDarkTheme(dark: boolean, effects: ThemeEffects): void {
  effects.setStoredValue?.(THEME_STORAGE_KEY, dark ? "dark" : "light");
  effects.toggleRootClass("dark", dark);
  // `index.html` sets this inline before paint, and an inline style outranks the palette.
  effects.setRootColorScheme(dark ? "dark" : "light");
}
