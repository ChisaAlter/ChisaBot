import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
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
  const committedDarkRef = useRef(dark);

  const setMode = useCallback((nextMode: AppearanceMode) => {
    setAppearanceMode(nextMode);
  }, []);

  const setDark = useCallback((nextDark: boolean) => {
    setAppearanceMode(nextDark ? "dark" : "light");
  }, []);

  useDocumentSync({ dark, mode }, (doc, current) => {
    const isThemeSwitch = committedDarkRef.current !== current.dark;
    committedDarkRef.current = current.dark;
    const root = doc.documentElement;
    let raf1 = 0;
    let raf2 = 0;

    // 切深浅色时冻结 1 帧全站 CSS transition，防止长对话 240+ 个隐藏操作按钮并发颜色过渡拖垮 INP。
    if (isThemeSwitch) {
      root.setAttribute("data-theme-switching", "1");
    }

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
    notifyAndroidTheme(current.dark, current.mode);

    if (!isThemeSwitch) return;
    if (typeof window.requestAnimationFrame === "function") {
      raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => {
          root.removeAttribute("data-theme-switching");
        });
      });
      return () => {
        window.cancelAnimationFrame(raf1);
        window.cancelAnimationFrame(raf2);
        root.removeAttribute("data-theme-switching");
      };
    }
    root.removeAttribute("data-theme-switching");
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
