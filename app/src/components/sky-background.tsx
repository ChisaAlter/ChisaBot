import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTheme } from "@/components/theme-provider";
import {
  type AppearanceState,
  computePaletteSky,
  getAppearanceState,
  resolveActiveWallpaperCss,
  subscribeAppearance,
} from "@/lib/appearance";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";
import {
  applySky,
  computeSky,
  currentMinuteOfDay,
  SKY_STORAGE_KEY,
} from "@/lib/sky";

/*
 * 「背景随时间变化」 state. `enabled` is a browser preference (like the theme, read by the boot script
 * in index.html before paint); `preview` is the settings slider's temporary hour and is never saved.
 */
type SkyState = { enabled: boolean; preview: number | null };

let state: SkyState = {
  enabled: readStoredPreference(SKY_STORAGE_KEY) !== "off",
  preview: null,
};
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setSkyEnabled(enabled: boolean) {
  writeStoredPreference(SKY_STORAGE_KEY, enabled ? "on" : "off");
  state = { ...state, enabled };
  emit();
}

/** A minute of day to show instead of the clock, or null to follow the clock again. */
export function setSkyPreview(preview: number | null) {
  state = { ...state, preview };
  emit();
}

export function useSkyState(): SkyState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

export function useAppearanceState(): AppearanceState {
  return useSyncExternalStore(
    subscribeAppearance,
    getAppearanceState,
    getAppearanceState,
  );
}

/** Keeps the sky custom properties in step with the clock, the theme and the preference. */
/**
 * The sky only fades (1.6s) right after the user changes the sky itself: 「背景随时间变化」 on/off or
 * the settings slider. A dark/light switch and the minute tick apply in one frame — a fading sky
 * makes every glass pane re-blur for the whole fade (CB-024, DESIGN.md §7.4).
 */
const SKY_EASE_MS = 1700;
let easeTimer: number | undefined;
export function easeNextSkyChange(root: HTMLElement = document.documentElement) {
  root.setAttribute("data-sky-ease", "");
  window.clearTimeout(easeTimer);
  easeTimer = window.setTimeout(() => root.removeAttribute("data-sky-ease"), SKY_EASE_MS);
}

export function SkyBackground() {
  const { dark } = useTheme();
  const { enabled, preview } = useSkyState();
  const appearance = useAppearanceState();
  const {
    palette,
    glassStyle,
    glassOpacity,
    wallpaperId,
    customWallpaper,
    wallpaperBlur,
    wallpaperDim,
  } = appearance;
  const activeWallpaperCss = resolveActiveWallpaperCss(appearance);
  const last = useRef<{ enabled: boolean; preview: number | null; palette: string } | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (palette === "default") {
      root.removeAttribute("data-palette");
    } else {
      root.setAttribute("data-palette", palette);
    }
    root.setAttribute("data-glass", glassStyle);
    root.style.setProperty("--lg-alpha", String(glassOpacity / 100));
    if (activeWallpaperCss) {
      root.setAttribute("data-wallpaper", "on");
    } else {
      root.removeAttribute("data-wallpaper");
    }
  }, [palette, glassStyle, glassOpacity, activeWallpaperCss]);

  useEffect(() => {
    const root = document.documentElement;
    const prev = last.current;
    last.current = { enabled, preview, palette };
    if (
      prev &&
      (prev.enabled !== enabled || prev.preview !== preview || prev.palette !== palette)
    ) {
      easeNextSkyChange(root);
    }

    const paletteSky = computePaletteSky(palette, dark);
    if (paletteSky) {
      root.setAttribute("data-sky", "palette");
      applySky(paletteSky);
      return;
    }

    if (!enabled) {
      applySky(null);
      root.removeAttribute("data-sky");
      return;
    }
    root.setAttribute("data-sky", "time");
    const paint = () =>
      applySky(computeSky(preview ?? currentMinuteOfDay(), dark));
    paint();
    if (preview !== null) return;

    // Once a minute, aligned to the minute boundary; catch up at once when the tab comes back.
    let timer: number | undefined;
    const schedule = () => {
      const now = new Date();
      timer = window.setTimeout(
        () => {
          paint();
          schedule();
        },
        60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50,
      );
    };
    schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") paint();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, preview, dark, palette]);

  return (
    <div
      aria-hidden="true"
      className="chisabot-wallpaper"
      data-custom-set={customWallpaper ? "true" : "false"}
      data-testid="chisabot-wallpaper"
      data-wallpaper-id={wallpaperId}
    >
      <div className="chisabot-ambient-orbs" />
      {activeWallpaperCss && (
        <>
          <div
            className="chisabot-wallpaper-img"
            style={{
              backgroundImage: activeWallpaperCss,
              filter: wallpaperBlur > 0 ? `blur(${wallpaperBlur}px)` : undefined,
              transform: wallpaperBlur > 0 ? "scale(1.06)" : undefined,
            }}
          />
          <div
            className="chisabot-wallpaper-dim"
            style={{
              opacity: Math.max(0, Math.min(0.85, wallpaperDim / 100)),
            }}
          />
        </>
      )}
    </div>
  );
}
