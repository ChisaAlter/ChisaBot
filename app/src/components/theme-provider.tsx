import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDocumentSync, useWindowEvent } from "@/hooks";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";
import {
  applyDarkTheme,
  parseStoredDarkTheme,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

type ThemeContextValue = {
  dark: boolean;
  setDark: (dark: boolean) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(() =>
    parseStoredDarkTheme(readStoredPreference(THEME_STORAGE_KEY)),
  );
  const committedDarkRef = useRef(dark);

  useDocumentSync(dark, (doc, isDark) => {
    const isThemeSwitch = committedDarkRef.current !== isDark;
    committedDarkRef.current = isDark;
    const root = doc.documentElement;
    let raf1 = 0;
    let raf2 = 0;

    // 切深浅色时冻结 1 帧全站 CSS transition，防止长对话 240+ 个隐藏操作按钮并发颜色过渡拖垮 INP。
    if (isThemeSwitch) {
      root.setAttribute("data-theme-switching", "1");
    }

    applyDarkTheme(isDark, {
      setStoredValue: writeStoredPreference,
      toggleRootClass: (name, force) => root.classList.toggle(name, force),
      setRootColorScheme: (scheme) => {
        root.style.colorScheme = scheme;
      },
    });
    const bridge = (
      window as Window & {
        ChisaAndroid?: { setTheme?: (mode: "dark" | "light") => void };
      }
    ).ChisaAndroid;
    bridge?.setTheme?.(isDark ? "dark" : "light");

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

  // 多标签页同步：别的标签页切了浅色 / 深色，这边跟着切（storage 事件只在别的标签页写入时触发）。
  useWindowEvent("storage", (event) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    setDark(parseStoredDarkTheme(readStoredPreference(THEME_STORAGE_KEY)));
  });

  const value = useMemo(() => ({ dark, setDark }), [dark]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("必须在 ThemeProvider 内部使用 useTheme");
  }

  return value;
}
