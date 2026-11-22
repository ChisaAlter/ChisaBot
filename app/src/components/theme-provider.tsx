import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
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

  useDocumentSync(dark, (doc, isDark) => {
    applyDarkTheme(isDark, {
      setStoredValue: writeStoredPreference,
      toggleRootClass: (name, force) =>
        doc.documentElement.classList.toggle(name, force),
      setRootColorScheme: (scheme) => {
        doc.documentElement.style.colorScheme = scheme;
      },
    });
    const bridge = (
      window as Window & {
        ChisaAndroid?: { setTheme?: (mode: "dark" | "light") => void };
      }
    ).ChisaAndroid;
    bridge?.setTheme?.(isDark ? "dark" : "light");
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
