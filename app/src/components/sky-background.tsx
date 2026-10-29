import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTheme } from "@/components/theme-provider";
import {
  applyAppearanceToDocument,
  applyThemeColor,
  computePaletteSky,
  getAppearanceState,
  installAppearanceStorageSync,
  paletteThemeColor,
  resolveActiveWallpaperCss,
  resolveEffectiveHarkScene,
  setHarkSkyScene,
  useAppearance,
  useWallpaperLoading,
} from "@/lib/appearance";
import { usePerfMode } from "@/lib/perf-mode";
import { createSkyWindow } from "@/lib/sky-window";

/*
 * Hark 原生 WebGL 动态天空与天气引擎宿主（移植自 Hark wallpaper_core.html + Pp 宿主控制器）：
 *  - DOM 挂载 #sky-root > #skyph + <canvas id="gl"> + <canvas id="skyfreeze"> + #glfail；
 *  - 首帧 WebGL drawArrays 完成时在 <html> 标记 data-sky-painted，隐藏 #skyph 占位并让 body 完全透明；
 *  - 根据当前浅色/深色主题、主题配色或用户手动指定的 12 个精选场景驱动 window.hark.applyScene(0..11) / setLive(true)。
 *
 * 性能（2026-10-29）：引擎本身（wallpaper_core.html）不改，节流全在宿主这边——
 *  - 引擎拿到的 requestAnimationFrame 是这里的 skyRaf：只在「允许跑」的窗口里出帧，最多 15fps；
 *  - 引擎读到的 window.devicePixelRatio 是 min(真实 DPR, 1) × 0.6，画布内部只按 0.6 倍分辨率画，CSS 再拉满；
 *  - 精选场景（默认 auto）= 天空快照：启动、换场景、改窗口大小、天气数据回来时醒来，换场景的 2.5s 渐变画完才停在最后一帧；
 *  - 改窗口大小、从后台回来、从壁纸 / 性能模式切回天空：当帧立即重画（drawSkyNow），不露出被清空的画布；
 *  - 「背景随时间变化」（live）= 动态天空：页面可见、窗口有焦点、且 2.5s 内有操作时才跑；
 *    系统开了「减少动态效果」时退回快照；
 *  - 设了壁纸或开了性能模式：不启动引擎；已经启动的停下并隐藏画布（html[data-sky-off]）；
 *  - 不再强制 preserveDrawingBuffer：停住的画布保留最后一次上屏的画面，不需要每帧多拷一份缓冲。
 */

const SKY_EASE_MS = 1650;
let easeTimer = 0;

/**
 * 在根上挂 `data-sky-ease`，1.6s 渐变跑完拿掉（保留供单元测试与主题切换调用）。
 */
export function easeNextSkyChange(
  root: HTMLElement | undefined = typeof document !== "undefined"
    ? document.documentElement
    : undefined,
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

function createHarkFetch(): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // Privacy: never let the sky engine send the user's IP to a third-party geolocation service.
    if (url.includes("ipapi.co")) {
      return new Response(null, { status: 403 });
    }
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

/* ---------------------------------------------------------------------------------------------
 * 天空节流器：引擎所有的 requestAnimationFrame 都经过这里。
 * ------------------------------------------------------------------------------------------- */
const SKY_FRAME_MS = 66; // ≤ 15fps
const SKY_IDLE_MS = 2500; // live：无操作 2.5s 后暂停
const SKY_SNAPSHOT_MS = 2600; // 快照：引擎一次换场景的交叉渐变是 2.5s（FADE_DUR），加一点余量
const SKY_FADE_HOLD_MS = 8000; // 渐变还没画完就一直醒着，但最多再撑这么久
const SKY_RENDER_SCALE = 0.6;

type SkyMode = "off" | "snapshot" | "live";

const sky = {
  mode: "snapshot" as SkyMode,
  wakeUntil: 0,
  queue: [] as FrameRequestCallback[],
  pending: false,
  /** 上一帧的真实 rAF 时间（节流用）。 */
  last: 0,
  /** 交给引擎的时间 = 真实时间 + skew；立即补画时为了躲开引擎 31ms 的最小帧间隔会往前拨一点。 */
  skew: 0,
  engineLast: 0,
  /** 这一帧里引擎调了几次 drawArrays：≥2 说明正在交叉渐变（旧天空 + 新天空各画一遍）。 */
  draws: 0,
  fadeSince: 0,
  listening: false,
};

function skyCanRun(now: number): boolean {
  if (sky.mode === "off" || typeof document === "undefined" || document.hidden)
    return false;
  if (sky.mode === "live" && !document.hasFocus()) return false;
  return now < sky.wakeUntil;
}

/** 跑一帧引擎。force：不管节流和 31ms 间隔，当帧必须画出来。 */
function runSkyFrame(realTs: number, force: boolean) {
  let ts = realTs + sky.skew;
  if (force && ts < sky.engineLast + 32) {
    sky.skew += sky.engineLast + 32 - ts;
    ts = sky.engineLast + 32;
  }
  sky.last = realTs;
  const callbacks = sky.queue;
  sky.queue = [];
  sky.draws = 0;
  for (const cb of callbacks) cb(ts);
  if (sky.draws > 0) sky.engineLast = ts;
  // 换场景的渐变还在画：醒着直到画完，别停在半路（停在半路的样子再被下一次唤醒接上，看起来就是一跳）。
  if (sky.draws >= 2) {
    const now = performance.now();
    if (!sky.fadeSince) sky.fadeSince = now;
    if (now - sky.fadeSince < SKY_FADE_HOLD_MS) {
      sky.wakeUntil = Math.max(sky.wakeUntil, now + SKY_FRAME_MS * 3);
    }
  } else if (sky.draws === 1) {
    sky.fadeSince = 0;
  }
}

function skyPump() {
  if (sky.pending || sky.queue.length === 0) return;
  if (!skyCanRun(performance.now())) return;
  sky.pending = true;
  const wait = Math.max(0, sky.last + SKY_FRAME_MS - performance.now() - 4);
  window.setTimeout(() => {
    window.requestAnimationFrame((ts) => {
      sky.pending = false;
      if (!skyCanRun(performance.now())) return;
      runSkyFrame(ts, false);
    });
  }, wait);
}

/** 给引擎用的 requestAnimationFrame。 */
function skyRaf(cb: FrameRequestCallback): number {
  sky.queue.push(cb);
  skyPump();
  return 0;
}

/**
 * 当帧立即画一帧，不等 66ms 的节流。
 * 引擎的 resize() 改 canvas.width 会清空画布；页面从后台回来、天空从关闭（壁纸 / 性能模式）切回来时，
 * 浏览器也可能已经丢掉了画布内容。没有 preserveDrawingBuffer，只要等节流的下一拍再画，
 * 中间合成的那一帧就是空画布（GPU 实测：改窗口大小时闪一帧灰）。所以在同一个任务里补画。
 * live 失焦时也补这一帧，不然画布会一直空到重新获得焦点。
 */
function drawSkyNow() {
  if (sky.mode === "off" || document.hidden || sky.queue.length === 0) return;
  runSkyFrame(performance.now(), true);
}

/** 让天空再跑 ms 毫秒（快照：画完这次变化；live：用户有操作）。 */
function wakeSky(ms: number) {
  if (sky.mode === "off") return;
  sky.wakeUntil = Math.max(sky.wakeUntil, performance.now() + ms);
  skyPump();
}

function setSkyMode(mode: SkyMode) {
  if (sky.mode === mode) return;
  const wasOff = sky.mode === "off";
  sky.mode = mode;
  if (mode === "off") {
    sky.wakeUntil = 0;
    document.documentElement.setAttribute("data-sky-off", "");
    return;
  }
  // 从关闭切回来：画布还藏着的时候先当帧画好，再在同一个任务里露出来，中间不会有空帧。
  // 引擎还没启动（队列是空的）时，露出来的是 #skyph 占位，等第一帧画完再撤。
  if (wasOff) drawSkyNow();
  document.documentElement.removeAttribute("data-sky-off");
  wakeSky(SKY_SNAPSHOT_MS);
}

function listenForSkyWakeups() {
  if (sky.listening) return;
  sky.listening = true;
  const onInput = () => {
    if (sky.mode === "live") wakeSky(SKY_IDLE_MS);
  };
  for (const ev of [
    "pointermove",
    "pointerdown",
    "keydown",
    "wheel",
    "touchstart",
  ]) {
    window.addEventListener(ev, onInput, { passive: true, capture: true });
  }
  // 引擎改画布尺寸会清空画布：快照也要补画（当帧那一下在 drawSkyNow，见引擎启动处）。
  window.addEventListener("resize", () => wakeSky(SKY_SNAPSHOT_MS));
  window.addEventListener("focus", () => onInput());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    drawSkyNow();
    if (sky.mode === "live") wakeSky(SKY_IDLE_MS);
    else skyPump();
  });
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

/** 系统「减少动态效果」：动态天空退回快照（只画一帧就停）。 */
function prefersReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

function subscribeReducedMotion(listener: () => void): () => void {
  const mq = reducedMotionQuery();
  if (!mq) return () => {};
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }
  // 旧版 Safari 只有 addListener。
  mq.addListener?.(listener);
  return () => mq.removeListener?.(listener);
}

/** 跟着系统设置实时变（以前只在渲染时读一次，开了「减少动态效果」要等下一次重渲染才生效）。 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => false,
  );
}

/**
 * 刚开了「减少动态效果」：天空当帧停住。不再把正在跑的渐变 / 动态天空画完（以前会再跑 2.6s 快照）。
 * 画布保留最后一次上屏的画面。
 */
export function stopSkyMotionNow() {
  sky.wakeUntil = 0;
  sky.fadeSince = 0;
}

/** 测试用：节流器现在的模式和醒到什么时候。 */
export function readSkyThrottle(): { mode: SkyMode; wakeUntil: number } {
  return { mode: sky.mode, wakeUntil: sky.wakeUntil };
}

export function resolveSkyMode(opts: {
  perf: boolean;
  wallpaper: boolean;
  live: boolean;
  reducedMotion?: boolean;
}): SkyMode {
  if (opts.perf || opts.wallpaper) return "off";
  const reduced = opts.reducedMotion ?? prefersReducedMotion();
  return opts.live && !reduced ? "live" : "snapshot";
}

export function SkyBackground() {
  const { dark } = useTheme();
  const appearance = useAppearance();
  const desiredSceneRef = useRef<"live" | number>(
    resolveEffectiveHarkScene(appearance, dark),
  );
  desiredSceneRef.current = resolveEffectiveHarkScene(appearance, dark);

  // 1. 挂载时把外观写到 <html>（之后每次改动由 updateAppearance 自己写，不在这里跟着每一步滑块重跑）。
  //    同时开始听别的标签页改外观（storage 事件）。
  useEffect(() => {
    applyAppearanceToDocument(getAppearanceState());
    installAppearanceStorageSync();
  }, []);

  // 2. 深浅色 / 配色变了：data-theme、天空垫片变量（写在 body 上，--sky-* 注册为不继承）、地址栏颜色。
  //    只依赖这两个值：以前依赖整个 appearance 对象，拖一下玻璃滑块这里也重跑一遍。
  const palette = appearance.palette;
  useEffect(() => {
    const root = document.documentElement;
    if (root.getAttribute("data-theme") !== (dark ? "dark" : "light")) {
      root.setAttribute("data-theme", dark ? "dark" : "light");
    }

    const customSky = computePaletteSky(palette, dark);
    if (customSky) {
      for (const [k, v] of Object.entries(customSky.body)) {
        document.body.style.setProperty(k, v);
      }
    } else {
      for (const k of [
        "--sky-0",
        "--sky-1",
        "--sky-2",
        "--sky-3",
        "--sky-glow",
        "--sky-glow-a",
      ]) {
        document.body.style.removeProperty(k);
      }
    }
    // 旧版本写在 <html> 上、没有任何样式读的 --glass-sky：清掉（换配色时它让整页跟着重算）。
    root.style.removeProperty("--glass-sky");
    applyThemeColor(paletteThemeColor(palette, dark));
  }, [dark, palette]);

  const perf = usePerfMode();
  const wallpaperCss = resolveActiveWallpaperCss(appearance);
  const wallpaperLoading = useWallpaperLoading();
  const reducedMotion = useReducedMotion();
  const skyMode = resolveSkyMode({
    perf,
    reducedMotion,
    // 壁纸还在从 IndexedDB 读回时也不启动天空：读回来就是壁纸，先启动只会闪一下。
    wallpaper: wallpaperCss !== null || wallpaperLoading,
    live: appearance.harkScene === "live",
  });

  // 3. 启动 Hark 原生 WebGL 动态天空引擎（/wallpaper_core.html）；壁纸 / 性能模式下不启动。
  useEffect(() => {
    if (typeof window === "undefined") return;
    setSkyMode(skyMode);
    if (skyMode === "off") return;
    listenForSkyWakeups();
    if (window.hark) {
      syncHarkSkyScene(desiredSceneRef.current);
      wakeSky(SKY_SNAPSHOT_MS);
      return;
    }
    if (window.__harkBooting) return;
    window.__harkBooting = true;

    const glCanvas = document.getElementById("gl") as HTMLCanvasElement | null;
    if (glCanvas) {
      const origGetContext = glCanvas.getContext.bind(glCanvas);
      let hooked = false;
      glCanvas.getContext = ((contextId: string, options?: unknown) => {
        const ctx = origGetContext(
          contextId as "webgl",
          options as WebGLContextAttributes,
        );
        if (
          ctx &&
          !hooked &&
          (contextId === "webgl" || contextId === "experimental-webgl")
        ) {
          hooked = true;
          const origDrawArrays = ctx.drawArrays.bind(ctx);
          let painted = false;
          ctx.drawArrays = (mode: number, first: number, count: number) => {
            origDrawArrays(mode, first, count);
            sky.draws++;
            if (!painted) {
              painted = true;
              // 第一帧上屏之后再撤占位图（下一帧），不靠 preserveDrawingBuffer。
              window.requestAnimationFrame(() => {
                document.documentElement.setAttribute("data-sky-painted", "");
              });
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

    const baseFetch = createHarkFetch();
    // 换场景后引擎会去取那个地方的天气，回来时天空还要再变一次：这时候天空可能已经停了，再叫醒一次把这段渐变画完。
    const harkFetch = (input: RequestInfo | URL, init?: RequestInit) =>
      baseFetch(input, init).then((res) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.includes("open-meteo.com")) wakeSky(SKY_SNAPSHOT_MS);
        return res;
      });

    window
      .fetch("/wallpaper_core.html")
      .then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((html) => {
        const match = /<script>([\s\S]*?)<\/script>/.exec(html);
        if (!match?.[1]) return;
        const runner = new Function(
          "fetch",
          "requestAnimationFrame",
          "window",
          match[1],
        );
        wakeSky(SKY_SNAPSHOT_MS);
        runner(harkFetch, skyRaf, createSkyWindow(window, SKY_RENDER_SCALE));
        // 必须注册在引擎自己的 resize 监听之后：先改尺寸，再在同一个事件里补画。
        window.addEventListener("resize", drawSkyNow);
        syncHarkSkyScene(desiredSceneRef.current);
      })
      .catch(() => {
        window.__harkBooting = false;
      });
  }, [skyMode]);

  // 4. 系统开了「减少动态效果」：当帧停住天空（模式切换那条 effect 会退回快照，但快照还会再画 2.6s）。
  useEffect(() => {
    if (reducedMotion) stopSkyMotionNow();
  }, [reducedMotion]);

  // 5. 当主题亮暗、配色方案或用户指定的 Hark 场景变化时，立即切换 WebGL 天空场景
  const targetScene = resolveEffectiveHarkScene(appearance, dark);
  useEffect(() => {
    syncHarkSkyScene(targetScene);
    wakeSky(SKY_SNAPSHOT_MS);
  }, [targetScene]);

  // 壁纸读取中：连静态天空占位也不画，只铺主题纯色（body 的底色 --sky-2）；读回后直接换成壁纸。
  if (wallpaperLoading && !wallpaperCss) {
    return (
      <div
        aria-hidden="true"
        data-wallpaper-loading=""
        id="sky-root"
        style={{ background: "var(--sky-2)" }}
      />
    );
  }

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
              transform:
                appearance.wallpaperBlur > 0 ? "scale(1.06)" : undefined,
            }}
          />
          <div
            className="chisabot-wallpaper-dim"
            style={{
              opacity: Math.max(
                0,
                Math.min(0.85, appearance.wallpaperDim / 100),
              ),
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
