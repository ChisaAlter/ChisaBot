import { useEffect, useRef } from "react";
import { useTheme } from "@/components/theme-provider";
import {
  applyAppearanceToDocument,
  computePaletteSky,
  resolveActiveWallpaperCss,
  resolveEffectiveHarkScene,
  setHarkSkyScene,
  useAppearance,
} from "@/lib/appearance";

/*
 * Hark 原生 WebGL 动态天空与天气引擎宿主（移植自 Hark wallpaper_core.html + Pp 宿主控制器）：
 *  - DOM 挂载 #sky-root > #skyph + <canvas id="gl"> + <canvas id="skyfreeze"> + #glfail；
 *  - 首帧 WebGL drawArrays 完成时在 <html> 标记 data-sky-painted，隐藏 #skyph 占位并让 body 完全透明；
 *  - 根据当前浅色/深色主题、主题配色或用户手动指定的 12 个精选场景驱动 window.hark.applyScene(0..11) / setLive(true)。
 */

const SKY_EASE_MS = 1650;
let easeTimer = 0;

/**
 * 在根上挂 `data-sky-ease`，1.6s 渐变跑完拿掉（保留供单元测试与主题切换调用）。
 */
export function easeNextSkyChange(
  root: HTMLElement | undefined = typeof document !== "undefined" ? document.documentElement : undefined,
) {
  if (!root || typeof window === "undefined") return;
  root.setAttribute("data-sky-ease", "");
  window.clearTimeout(easeTimer);
  easeTimer = window.setTimeout(() => {
    root.removeAttribute("data-sky-ease");
  }, SKY_EASE_MS);
}

/**
 * 供「背景随时间变化」开关读取/切换 Hark 实时时钟天空（live）与精选场景（auto）。
 */
export function useSkyState(): { enabled: boolean; preview: number | null } {
  const appearance = useAppearance();
  return {
    enabled: appearance.harkScene === "live",
    preview: null,
  };
}

export function setSkyEnabled(enabled: boolean): void {
  setHarkSkyScene(enabled ? "live" : "auto");
}

export function setSkyPreview(hour: number | null): void {
  if (typeof window === "undefined") return;
  if (hour === null) {
    window.hark?.setLive?.(true);
  } else {
    window.hark?.setHour?.(hour, true);
  }
}

interface HarkController {
  applyScene?: (index: number) => void;
  setLive?: (on: boolean) => void;
  setHour?: (hour: number, fade?: boolean) => void;
  setTimeFlow?: (speed: number) => void;
}

declare global {
  interface Window {
    hark?: HarkController;
    __harkBooting?: boolean;
    webkit?: {
      messageHandlers?: {
        hark?: {
          postMessage: (msg: unknown) => void;
        };
      };
    };
  }
}

const OFFLINE_FORECAST_JSON = JSON.stringify({
  utc_offset_seconds: -new Date().getTimezoneOffset() * 60,
  current: {
    temperature_2m: 20,
    weather_code: 1,
    cloud_cover: 26,
    is_day: 1,
    wind_speed_10m: 9,
    wind_direction_10m: 250,
    relative_humidity_2m: 48,
    cloud_cover_low: 14,
    cloud_cover_mid: 10,
    cloud_cover_high: 22,
    wind_gusts_10m: 14,
  },
  hourly: {
    time: [new Date().toISOString()],
    visibility: [24000],
    direct_radiation: [580],
    diffuse_radiation: [120],
    shortwave_radiation: [700],
    terrestrial_radiation: [920],
    snow_depth: [0],
    cape: [0],
  },
});

const OFFLINE_AQ_JSON = JSON.stringify({
  current: {
    us_aqi: 24,
    aerosol_optical_depth: 0.08,
  },
});

function createHarkFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("gibs.earthdata.nasa.gov")) {
      return new Response(null, { status: 204 });
    }
    if (url.includes("api.open-meteo.com/v1/forecast")) {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 2800);
      try {
        const res = await window.fetch(input, { ...init, signal: ctrl.signal });
        window.clearTimeout(timer);
        if (res.ok) return res;
      } catch {
        window.clearTimeout(timer);
      }
      return new Response(OFFLINE_FORECAST_JSON, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("air-quality-api.open-meteo.com")) {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 2800);
      try {
        const res = await window.fetch(input, { ...init, signal: ctrl.signal });
        window.clearTimeout(timer);
        if (res.ok) return res;
      } catch {
        window.clearTimeout(timer);
      }
      return new Response(OFFLINE_AQ_JSON, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return window.fetch(input, init);
  };
}

function syncHarkSkyScene(target: "live" | number) {
  const hark = typeof window !== "undefined" ? window.hark : undefined;
  if (!hark) return;
  if (target === "live") {
    hark.setLive?.(true);
    hark.setTimeFlow?.(1);
  } else {
    hark.applyScene?.(target);
  }
}

export function SkyBackground() {
  const { dark } = useTheme();
  const appearance = useAppearance();
  const desiredSceneRef = useRef<"live" | number>(
    resolveEffectiveHarkScene(appearance, dark),
  );
  desiredSceneRef.current = resolveEffectiveHarkScene(appearance, dark);

  // 1. 同步 HTML data-theme、data-palette、data-glass 与 CSS 预渲染垫片变量
  useEffect(() => {
    applyAppearanceToDocument(appearance);
    const root = document.documentElement;
    root.setAttribute("data-theme", dark ? "dark" : "light");

    const customSky = computePaletteSky(appearance.palette, dark);
    if (customSky) {
      for (const [k, v] of Object.entries(customSky.body)) {
        document.body.style.setProperty(k, v);
      }
      for (const [k, v] of Object.entries(customSky.root)) {
        root.style.setProperty(k, v);
      }
    } else {
      for (const k of ["--sky-0", "--sky-1", "--sky-2", "--sky-3", "--sky-glow", "--sky-glow-a"]) {
        document.body.style.removeProperty(k);
      }
      root.style.removeProperty("--glass-sky");
    }
  }, [dark, appearance]);

  // 2. 启动 Hark 原生 WebGL 动态天空引擎（/wallpaper_core.html）
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.hark) {
      syncHarkSkyScene(desiredSceneRef.current);
      return;
    }
    if (window.__harkBooting) return;
    window.__harkBooting = true;

    const glCanvas = document.getElementById("gl") as HTMLCanvasElement | null;
    if (glCanvas) {
      const origGetContext = glCanvas.getContext.bind(glCanvas);
      let hooked = false;
      glCanvas.getContext = ((contextId: string, options?: unknown) => {
        const opts =
          contextId === "webgl" || contextId === "experimental-webgl"
            ? { ...(typeof options === "object" && options ? options : {}), preserveDrawingBuffer: true }
            : options;
        const ctx = origGetContext(contextId as "webgl", opts as WebGLContextAttributes);
        if (ctx && !hooked && (contextId === "webgl" || contextId === "experimental-webgl")) {
          hooked = true;
          const origDrawArrays = ctx.drawArrays.bind(ctx);
          let painted = false;
          ctx.drawArrays = (mode: number, first: number, count: number) => {
            origDrawArrays(mode, first, count);
            if (!painted) {
              painted = true;
              document.documentElement.setAttribute("data-sky-painted", "");
            }
          };
        }
        return ctx;
      }) as typeof glCanvas.getContext;
    }

    window.webkit = {
      messageHandlers: {
        hark: {
          postMessage: () => {
            // Hark 状态回调（lum / day / dot 等由宿主主题与场景统一管理）
          },
        },
      },
    };

    const harkFetch = createHarkFetch();

    window
      .fetch("/wallpaper_core.html")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((html) => {
        const match = /<script>([\s\S]*?)<\/script>/.exec(html);
        if (!match?.[1]) return;
        const runner = new Function("fetch", "requestAnimationFrame", match[1]);
        runner(harkFetch, window.requestAnimationFrame.bind(window));
        syncHarkSkyScene(desiredSceneRef.current);
      })
      .catch(() => {
        window.__harkBooting = false;
      });
  }, []);

  // 3. 当主题亮暗、配色方案或用户指定的 Hark 场景变化时，立即切换 WebGL 天空场景
  const targetScene = resolveEffectiveHarkScene(appearance, dark);
  useEffect(() => {
    syncHarkSkyScene(targetScene);
  }, [targetScene]);

  const wallpaperCss = resolveActiveWallpaperCss(appearance);

  return (
    <div aria-hidden="true" id="sky-root">
      <div id="skyph" />
      <canvas id="gl" />
      <canvas id="skyfreeze" />
      <p id="glfail" />
      <div className="chisabot-ambient-orbs" />
      {wallpaperCss ? (
        <div className="chisabot-wallpaper" data-testid="chisabot-wallpaper">
          <div
            className="chisabot-wallpaper-img"
            style={{
              backgroundImage: wallpaperCss,
              filter:
                appearance.wallpaperBlur > 0
                  ? `blur(${appearance.wallpaperBlur}px)`
                  : undefined,
              transform: appearance.wallpaperBlur > 0 ? "scale(1.06)" : undefined,
            }}
          />
          <div
            className="chisabot-wallpaper-dim"
            style={{
              opacity: Math.max(0, Math.min(0.85, appearance.wallpaperDim / 100)),
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
