import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useDocumentSync, useWindowEvent } from "@/hooks";
import {
  APPEARANCE_STORAGE_KEY,
  applyAppearanceToDocument,
  getAppearanceConfig,
  setAppearanceMode,
  syncAppearanceFromStorage,
  useAppearanceConfig,
} from "@/lib/appearance";
import {
  type AppearanceMode,
  applyDarkTheme,
  notifyAndroidTheme,
  prefersSystemDark,
  resolveDarkTheme,
  subscribeSystemDark,
} from "@/lib/theme";
import {
  notifyThemeTransitionCommitted,
  runThemeTransition,
} from "@/lib/theme-transition";

type ThemeContextValue = {
  mode: AppearanceMode;
  setMode: (mode: AppearanceMode) => void;
  dark: boolean;
  setDark: (dark: boolean) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const appearance = useAppearanceConfig();
  const mode = appearance.mode;
  const systemDark = useSyncExternalStore(
    subscribeSystemDark,
    prefersSystemDark,
    () => false,
  );
  const dark = resolveDarkTheme(mode, systemDark);

  const setMode = useCallback((nextMode: AppearanceMode) => {
    setAppearanceMode(nextMode);
  }, []);

  const setDark = useCallback((nextDark: boolean) => {
    setAppearanceMode(nextDark ? "dark" : "light");
  }, []);

  useDocumentSync({ dark, mode }, (doc, current) => {
    const root = doc.documentElement;
    const syncDom = () => {
      applyDarkTheme(current.dark, {
        toggleRootClass: (name, force) => {
          if (root.classList.contains(name) !== force) {
            root.classList.toggle(name, force);
          }
        },
        setRootColorScheme: (scheme) => {
          if (root.style.colorScheme !== scheme) {
            root.style.colorScheme = scheme;
          }
        },
      });
      applyAppearanceToDocument(getAppearanceConfig(), current.dark);
    };

    const needsDomSwitch = root.classList.contains("dark") !== current.dark;
    if (needsDomSwitch) {
      const cfg = getAppearanceConfig();
      const allowAnimate = !cfg.staticBackground;
      runThemeTransition(syncDom, {
        animate: allowAnimate,
        waitForCommit: false,
      });
    } else {
      syncDom();
      notifyThemeTransitionCommitted();
    }

    notifyAndroidTheme(current.dark, current.mode);
    return undefined;
  });

  // 多标签页同步：别的标签页改了外观存储，这边立即同步。
  useWindowEvent("storage", (event) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== APPEARANCE_STORAGE_KEY) return;
    void syncAppearanceFromStorage(event.key);
  });

  const value = useMemo(
    () => ({ mode, setMode, dark, setDark }),
    [mode, setMode, dark, setDark],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("必须在 ThemeProvider 内部使用 useTheme");
  }

  return value;
}
