import {
  type CSSProperties,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTheme } from "@/components/theme-provider";
import { useExternalConnection, useInterval, useTimeout } from "@/hooks";
import {
  type AppearanceConfigV2,
  applyAppearanceToDocument,
  getAppearanceConfig,
  installAppearanceStorageSync,
  resolveAutoSkyHour,
  resolveWallpaperCssFromConfig,
  SKY_SCENE_TO_HARK_INDEX,
  type SkySceneId,
  shouldFetchLiveWeather,
  useAppearanceConfig,
  useCustomWallpaperUrl,
  useWallpaperLoading,
} from "@/lib/appearance";
import { DURATION_MS } from "@/lib/motion";
import {
  isResizing,
  resizeInProgress,
  subscribeResizing,
} from "@/lib/resize-state";
import { noteSkyFrame, skyFadeHolding, wakeSkyOnWeather } from "@/lib/sky-fade";
import {
  noteSkyFrameCost,
  skyFrameDelay,
  skyInputHolding,
} from "@/lib/sky-pace";
import { createSkyWindow } from "@/lib/sky-window";

/*
 * V2 背景画布宿主（三选一严格互斥）：
 *  - `canvas.kind === "pure"`：仅挂载空 `#sky-root`，不挂载 WebGL、不挂载壁纸；
 *  - `canvas.kind === "sky"`：挂载 `#sky-root > #skyph + #gl + #skyfreeze + #glfail`，不挂壁纸；
 *      - 4 个固定时刻（dawn/day/dusk/night）严格按 `SCENES[11/0/6/4]` 渲染，零错配、零网络请求；
 *      - `auto`（随时间流动）关闭天气时按本机时间沿柔和太阳弧线演进，严格 0 Open-Meteo 请求、不写 `hark-wallpaper-v1`；
 *      - `auto` 开启实时天气时按用户配置的城市（空时按时区回退）拉取 Open-Meteo；
 *      - `staticBackground` 或系统减少动态效果时仅绘静帧，不跑持续渲染循环；
 *  - `canvas.kind === "wallpaper"`：不挂载 WebGL，仅在 `#sky-root` 上写 `--canvas-blur` / `--canvas-scrim`
 *    并渲染单层壁纸 `.chisabot-wallpaper > .chisabot-wallpaper-img`（唯一护眼薄幕由 canvas.css 承载）。
 */

const SKY_EASE_MS = 1650;
let easeTimer = 0;

export function easeNextSkyChange(
  root: HTMLElement | undefined = typeof document !== "undefined"
    ? document.documentElement
    : undefined,
): void {
  if (!root || typeof window === "undefined") return;
  root.setAttribute("data-sky-ease", "");
  window.clearTimeout(easeTimer);
  easeTimer = window.setTimeout(() => {
    root.removeAttribute("data-sky-ease");
  }, SKY_EASE_MS);
}

interface HarkController {
  applyScene?: (index: number) => void;
  applyFixedScene?: (index: number) => void;
  setAutoTime?: (hour: number, fade?: boolean) => void;
  setWeatherEnabled?: (enabled: boolean, city?: string | null) => void;
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

export type ResolvedSkyTarget =
  | { kind: "off" }
  | { kind: "fixed"; scene: Exclude<SkySceneId, "auto">; harkIndex: number }
  | { kind: "auto-time"; hour: number }
  | { kind: "weather"; city: string | null };

/**
 * 纯函数：根据 V2 外观配置与当前深浅色，解析天空引擎应呈现的真实目标。
 * 固定时刻直接映射到真实场景下标（dawn=11, day=0, dusk=6, night=4），绝不做静默昼夜调包。
 */
export function resolveSkyTarget(
  config: AppearanceConfigV2,
  dark: boolean,
  now: Date = new Date(),
): ResolvedSkyTarget {
  if (config.canvas.kind !== "sky") {
    return { kind: "off" };
  }
  if (config.canvas.scene !== "auto") {
    return {
      kind: "fixed",
      scene: config.canvas.scene,
      harkIndex: SKY_SCENE_TO_HARK_INDEX[config.canvas.scene],
    };
  }
  if (config.canvas.weather.enabled) {
    return { kind: "weather", city: config.canvas.weather.city };
  }
  const localHour =
    now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  return {
    kind: "auto-time",
    hour: resolveAutoSkyHour(localHour, dark),
  };
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

const OFFLINE_GEOCODE_JSON = JSON.stringify({ results: [] });

export function createHarkFetch(
  isWeatherAllowed: () => boolean = () =>
    shouldFetchLiveWeather(getAppearanceConfig()),
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
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

    // 隐私保护：永不向第三方 IP 定位或外网瓦片发请求。
    if (url.includes("ipapi.co")) {
      return new Response(null, { status: 403 });
    }
    if (url.includes("gibs.earthdata.nasa.gov")) {
      return new Response(null, { status: 204 });
    }

    const isOpenMeteo = url.includes("open-meteo.com");
    if (isOpenMeteo && !isWeatherAllowed()) {
      // 天气关闭、非 auto 时刻或非天空画布时：严格 0 网络请求，直接本地返回。
      if (url.includes("geocoding-api.open-meteo.com")) {
        return new Response(OFFLINE_GEOCODE_JSON, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("air-quality-api.open-meteo.com")) {
        return new Response(OFFLINE_AQ_JSON, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(OFFLINE_FORECAST_JSON, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
    if (url.includes("geocoding-api.open-meteo.com")) {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 2800);
      try {
        const res = await window.fetch(input, { ...init, signal: ctrl.signal });
        window.clearTimeout(timer);
        if (res.ok) return res;
      } catch {
        window.clearTimeout(timer);
      }
      return new Response(OFFLINE_GEOCODE_JSON, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return window.fetch(input, init);
  };
}

function syncHarkSkyTarget(target: ResolvedSkyTarget, staticOnly: boolean) {
  const hark = typeof window !== "undefined" ? window.hark : undefined;
  if (!hark || target.kind === "off") return;
  if (target.kind === "fixed") {
    hark.setWeatherEnabled?.(false);
    if (typeof hark.applyFixedScene === "function") {
      hark.applyFixedScene(target.harkIndex);
    } else {
      hark.applyScene?.(target.harkIndex);
    }
    return;
  }
  if (target.kind === "auto-time") {
    hark.setWeatherEnabled?.(false);
    if (typeof hark.setAutoTime === "function") {
      hark.setAutoTime(target.hour, !staticOnly);
    } else {
      hark.setLive?.(false);
      hark.setHour?.(target.hour, !staticOnly);
    }
    return;
  }
  hark.setWeatherEnabled?.(true, target.city);
  hark.setTimeFlow?.(staticOnly ? 0 : 1);
}

/* ---------------------------------------------------------------------------------------------
 * 天空节流器：引擎所有的 requestAnimationFrame 都经过这里。
 * ------------------------------------------------------------------------------------------- */
const SKY_IDLE_MS = 2500;
const SKY_SNAPSHOT_MS = 2600;
const SKY_RENDER_SCALE = 0.6;

type SkyMode = "off" | "snapshot" | "live";

const sky = {
  mode: "snapshot" as SkyMode,
  staticOnly: false,
  wakeUntil: 0,
  queue: [] as FrameRequestCallback[],
  pending: false,
  last: 0,
  skew: 0,
  engineLast: 0,
  draws: 0,
  fadeSince: null as number | null,
  cost: 0,
  inputAt: Number.NEGATIVE_INFINITY,
  listening: false,
};

let cachedHarkScript: string | null = null;
let harkBoundCanvas: HTMLCanvasElement | null = null;
const engineIntervalIds = new Set<number>();

function teardownHarkInstance(): void {
  for (const id of engineIntervalIds) {
    window.clearInterval(id);
  }
  engineIntervalIds.clear();
  deferredSkyResize.handlers = [];
  deferredSkyResize.pending = false;
  sky.queue = [];
  sky.wakeUntil = 0;
  sky.fadeSince = null;
  harkBoundCanvas = null;
  if (typeof window !== "undefined") {
    window.removeEventListener("resize", onSkyResizeEvent);
    window.hark = undefined;
    window.__harkBooting = false;
  }
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-sky-painted");
  }
}

function skyCanRun(now: number): boolean {
  if (sky.mode === "off" || typeof document === "undefined" || document.hidden)
    return false;
  if (isResizing()) return false;
  if (sky.mode === "live" && !document.hasFocus()) return false;
  return now < sky.wakeUntil || skyFadeHolding(sky, now);
}

/** 仅供单元测试：节流循环此刻是否允许出帧，以及切换天空模式 / 拿到排队状态。 */
export const __skyLoopForTestOnly = {
  canRun: (now: number = performance.now()) => skyCanRun(now),
  setMode: (mode: SkyMode) => setSkyMode(mode),
  listen: () => listenForSkyWakeups(),
  state: sky,
  engineAddEventListener: (type: string, fn: EventListener) =>
    engineAddEventListener(type, fn),
  onResizeEvent: (ev: Event) => onSkyResizeEvent(ev),
};

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
  const started = performance.now();
  for (const cb of callbacks) cb(ts);
  if (sky.draws > 0) {
    sky.engineLast = ts;
    noteSkyFrameCost(sky, performance.now() - started);
  }
  if (sky.staticOnly && sky.draws > 0) {
    // 静止动态背景：单帧落盘后立即停止循环，不持续渲染。
    sky.wakeUntil = 0;
    sky.fadeSince = null;
    return;
  }
  noteSkyFrame(sky, sky.draws, performance.now());
}

function skyPump() {
  if (sky.pending || sky.queue.length === 0) return;
  if (!skyCanRun(performance.now())) return;
  sky.pending = true;
  const wait = skyFrameDelay(sky, performance.now());
  window.setTimeout(() => {
    window.requestAnimationFrame((ts) => {
      sky.pending = false;
      const now = performance.now();
      if (!skyCanRun(now)) return;
      if (skyInputHolding(sky, now)) {
        skyPump();
        return;
      }
      runSkyFrame(ts, false);
    });
  }, wait);
}

function skyRaf(cb: FrameRequestCallback): number {
  sky.queue.push(cb);
  skyPump();
  return 0;
}

function drawSkyNow() {
  if (sky.mode === "off" || document.hidden || sky.queue.length === 0) return;
  runSkyFrame(performance.now(), true);
}

const SKY_PREWARM_MAX_MS = 8000;

export function prewarmSkyShaders(script: string): Promise<void> {
  const vert = /const VERT\s*=\s*'([^']*)'/.exec(script)?.[1];
  const frag = /const FRAG\s*=\s*`([\s\S]*?)`;/.exec(script)?.[1];
  if (
    !vert ||
    !frag ||
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined"
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let url = "";
    const done = () => {
      window.clearTimeout(timer);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve();
    };
    const timer = window.setTimeout(done, SKY_PREWARM_MAX_MS);
    try {
      url = URL.createObjectURL(
        new Blob([`(${skyPrewarmWorker.toString()})()`], {
          type: "text/javascript",
        }),
      );
      worker = new Worker(url);
      worker.onmessage = done;
      worker.onerror = done;
      worker.postMessage({ vert, frag });
    } catch {
      done();
    }
  });
}

function skyPrewarmWorker() {
  const scope = self as unknown as {
    onmessage:
      | ((event: MessageEvent<{ vert: string; frag: string }>) => void)
      | null;
    postMessage: (message: unknown) => void;
  };
  scope.onmessage = (event) => {
    const finish = () => scope.postMessage("done");
    try {
      const canvas = new OffscreenCanvas(1, 1);
      const gl = canvas.getContext("webgl", {
        antialias: false,
        alpha: false,
        powerPreference: "low-power",
      }) as WebGLRenderingContext | null;
      const parallel = gl?.getExtension("KHR_parallel_shader_compile");
      const program = gl?.createProgram();
      if (!gl || !program) return finish();
      for (const [type, source] of [
        [gl.VERTEX_SHADER, event.data.vert],
        [gl.FRAGMENT_SHADER, event.data.frag],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) return finish();
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!parallel) {
        gl.getProgramParameter(program, gl.LINK_STATUS);
        return finish();
      }
      const poll = () => {
        if (
          gl.isContextLost() ||
          gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)
        )
          finish();
        else setTimeout(poll, 50);
      };
      poll();
    } catch {
      finish();
    }
  };
}

function wakeSky(ms: number) {
  if (sky.mode === "off") return;
  if (sky.staticOnly) {
    // 静止模式仅允许补画一帧，不进入持续循环。
    drawSkyNow();
    return;
  }
  sky.wakeUntil = Math.max(sky.wakeUntil, performance.now() + ms);
  skyPump();
}

function setSkyMode(mode: SkyMode) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-sky", mode);
  }
  if (sky.mode === mode) {
    if (mode === "off" && typeof document !== "undefined") {
      document.documentElement.setAttribute("data-sky-off", "");
    }
    return;
  }
  const wasOff = sky.mode === "off";
  sky.mode = mode;
  if (mode === "off") {
    sky.wakeUntil = 0;
    sky.fadeSince = null;
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-sky-off", "");
    }
    return;
  }
  if (wasOff) drawSkyNow();
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-sky-off");
  }
  wakeSky(SKY_SNAPSHOT_MS);
}

function listenForSkyWakeups() {
  if (sky.listening) return;
  sky.listening = true;
  const onInput = () => {
    if (sky.mode === "live" && !sky.staticOnly) wakeSky(SKY_IDLE_MS);
  };
  const onPress = () => {
    sky.inputAt = performance.now();
  };
  for (const ev of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(ev, onPress, { passive: true, capture: true });
  }
  for (const ev of [
    "pointermove",
    "pointerdown",
    "keydown",
    "wheel",
    "touchstart",
  ]) {
    window.addEventListener(ev, onInput, { passive: true, capture: true });
  }
  window.addEventListener("resize", () => wakeSky(SKY_SNAPSHOT_MS));
  window.addEventListener("focus", () => onInput());
  subscribeResizing((resizing) => {
    if (resizing) return;
    flushDeferredSkyResize();
    wakeSky(SKY_SNAPSHOT_MS);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    drawSkyNow();
    if (sky.mode === "live" && !sky.staticOnly) wakeSky(SKY_IDLE_MS);
    else skyPump();
  });
}

const deferredSkyResize = { handlers: [] as EventListener[], pending: false };

function onSkyResizeEvent(ev: Event) {
  if (resizeInProgress()) {
    deferredSkyResize.pending = true;
    return;
  }
  for (const fn of deferredSkyResize.handlers) fn(ev);
  drawSkyNow();
}

function flushDeferredSkyResize() {
  if (!deferredSkyResize.pending) return;
  deferredSkyResize.pending = false;
  const ev = new Event("resize");
  for (const fn of deferredSkyResize.handlers) fn(ev);
  drawSkyNow();
}

function engineAddEventListener(
  type: string,
  fn: EventListener,
  opts?: AddEventListenerOptions | boolean,
) {
  if (type === "resize" && typeof fn === "function") {
    deferredSkyResize.handlers.push(fn);
    return;
  }
  window.addEventListener(type, fn, opts);
}

function engineSetInterval(
  handler: TimerHandler,
  timeout?: number,
  ...args: unknown[]
): number {
  const id = window.setInterval(() => {
    if (sky.mode === "off" || sky.staticOnly || document.hidden) return;
    if (typeof handler === "function") {
      handler(...args);
    }
  }, timeout);
  engineIntervalIds.add(id);
  return id;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

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
  mq.addListener?.(listener);
  return () => mq.removeListener?.(listener);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => false,
  );
}

export function stopSkyMotionNow(): void {
  sky.wakeUntil = 0;
  sky.fadeSince = 0;
}

export function readSkyThrottle(): { mode: SkyMode; wakeUntil: number } {
  return { mode: sky.mode, wakeUntil: sky.wakeUntil };
}

export function resolveSkyMode(opts: {
  perf: boolean;
  wallpaper: boolean;
  live: boolean;
  paletteGradient?: boolean;
  reducedMotion?: boolean;
  staticBackground?: boolean;
}): SkyMode {
  if (opts.perf || opts.wallpaper || opts.paletteGradient) return "off";
  const reduced = opts.reducedMotion ?? prefersReducedMotion();
  if (opts.staticBackground || reduced) return "snapshot";
  return opts.live ? "live" : "snapshot";
}

export function SkyBackground() {
  const { dark } = useTheme();
  const config = useAppearanceConfig();
  const customWallpaperUrl = useCustomWallpaperUrl();
  const wallpaperLoading = useWallpaperLoading();
  const reducedMotion = useReducedMotion();

  const staticOnly = config.staticBackground || reducedMotion;
  sky.staticOnly = staticOnly;

  const target = resolveSkyTarget(config, dark);
  const targetRef = useRef<ResolvedSkyTarget>(target);
  targetRef.current = target;
  const staticOnlyRef = useRef(staticOnly);
  staticOnlyRef.current = staticOnly;

  // 1. 挂载时同步文档根属性 + 注册跨标签页 storage 监听。
  useExternalConnection(true, () => {
    applyAppearanceToDocument(getAppearanceConfig(), dark);
    installAppearanceStorageSync();
  });

  const wallpaperCss = resolveWallpaperCssFromConfig(
    config,
    customWallpaperUrl,
  );
  // 自定义壁纸从 IndexedDB 读回失败/缺失/超时时安全退回天空，避免空白画布；
  // 正在读取中（wallpaperLoading）保持纯色占位不闪天空。
  const effectiveCanvasKind =
    config.canvas.kind === "wallpaper" && !wallpaperLoading && !wallpaperCss
      ? "sky"
      : config.canvas.kind;

  const isPerfSolid = config.material === "solid" && config.staticBackground;
  const skyMode = resolveSkyMode({
    perf: isPerfSolid && effectiveCanvasKind !== "sky",
    wallpaper: effectiveCanvasKind === "wallpaper",
    paletteGradient: effectiveCanvasKind === "pure",
    live:
      effectiveCanvasKind === "sky" &&
      config.canvas.kind === "sky" &&
      config.canvas.scene === "auto" &&
      !config.staticBackground,
    reducedMotion,
    staticBackground: config.staticBackground,
  });

  // 2. 启动或销毁 WebGL 天空引擎（仅当有效画布为 sky 时挂载与运行）。
  const engineKey = `${effectiveCanvasKind}:${skyMode}`;
  useExternalConnection(engineKey, () => {
    if (typeof window === "undefined") return;
    if (effectiveCanvasKind !== "sky" || skyMode === "off") {
      setSkyMode("off");
      if (harkBoundCanvas) {
        teardownHarkInstance();
      }
      return;
    }

    setSkyMode(skyMode);
    listenForSkyWakeups();

    const glCanvas = document.getElementById("gl") as HTMLCanvasElement | null;
    if (!glCanvas) return;

    if (window.hark && harkBoundCanvas === glCanvas) {
      // 引擎已就绪时仅切换节流模式，不在点击同步提交期直接调用 syncHarkSkyTarget；
      // 场景 / 天气变更统一由 Effect #4 在下一帧（rAF + setTimeout(0)）异步同步，保护点击 INP。
      if (staticOnlyRef.current) {
        drawSkyNow();
      } else {
        wakeSky(SKY_SNAPSHOT_MS);
      }
      return;
    }

    if (harkBoundCanvas && harkBoundCanvas !== glCanvas) {
      teardownHarkInstance();
    }
    if (window.__harkBooting) return;
    window.__harkBooting = true;
    harkBoundCanvas = glCanvas;

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
            window.requestAnimationFrame(() => {
              document.documentElement.setAttribute("data-sky-painted", "");
            });
          }
        };
      }
      return ctx;
    }) as typeof glCanvas.getContext;

    window.webkit = {
      messageHandlers: {
        hark: {
          postMessage: () => {},
        },
      },
    };

    const harkFetch = wakeSkyOnWeather(
      createHarkFetch(() => shouldFetchLiveWeather(getAppearanceConfig())),
      () => wakeSky(SKY_SNAPSHOT_MS),
    );

    const scriptPromise = cachedHarkScript
      ? Promise.resolve(cachedHarkScript)
      : window
          .fetch("/wallpaper_core.html")
          .then((r) =>
            r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)),
          )
          .then((html) => {
            const match = /<script>([\s\S]*?)<\/script>/.exec(html);
            if (!match?.[1]) return null;
            cachedHarkScript = match[1];
            return prewarmSkyShaders(match[1]).then(() => match[1]);
          });

    scriptPromise
      .then((script) => {
        if (!script || harkBoundCanvas !== glCanvas || !glCanvas.isConnected) {
          if (harkBoundCanvas === glCanvas) harkBoundCanvas = null;
          window.__harkBooting = false;
          return;
        }
        const runner = new Function(
          "fetch",
          "requestAnimationFrame",
          "window",
          "addEventListener",
          "setInterval",
          script,
        );
        sky.wakeUntil = performance.now() + SKY_SNAPSHOT_MS;
        runner(
          harkFetch,
          skyRaf,
          createSkyWindow(window, SKY_RENDER_SCALE),
          engineAddEventListener,
          engineSetInterval,
        );
        window.addEventListener("resize", onSkyResizeEvent);
        syncHarkSkyTarget(targetRef.current, staticOnlyRef.current);
        if (staticOnlyRef.current) {
          drawSkyNow();
        }
      })
      .catch(() => {
        if (harkBoundCanvas === glCanvas) harkBoundCanvas = null;
        if (typeof window !== "undefined") {
          window.__harkBooting = false;
        }
      });
  });

  // 3. 系统减少动效或静止动态背景打开：立刻停止正在运行的循环。
  useExternalConnection(staticOnly, () => {
    if (staticOnly) {
      stopSkyMotionNow();
    }
  });

  // 4. 场景 / 天气开关 / 城市 / 明暗变化时，在下一帧同步给引擎（不阻塞点击 INP）。
  const targetKey =
    target.kind === "off"
      ? "off"
      : target.kind === "fixed"
        ? `fixed:${target.scene}:${target.harkIndex}`
        : target.kind === "weather"
          ? `weather:${target.city ?? ""}`
          : `auto:${dark ? "d" : "l"}:${Math.round(target.hour * 10)}`;

  useExternalConnection(targetKey, () => {
    if (target.kind === "off") return;
    let raf = 0;
    let timer = 0;
    raf = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        syncHarkSkyTarget(targetRef.current, staticOnlyRef.current);
        if (staticOnlyRef.current) {
          drawSkyNow();
        } else {
          wakeSky(SKY_SNAPSHOT_MS);
        }
      }, 0);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  });

  // 5. 「随时间流动（auto）」关闭天气时，每分钟平滑推进太阳时刻（静止模式不跑定时器）。
  const tickAutoTime = useCallback(() => {
    const latest = resolveSkyTarget(getAppearanceConfig(), dark);
    if (latest.kind !== "auto-time") return;
    syncHarkSkyTarget(latest, false);
    wakeSky(SKY_SNAPSHOT_MS);
  }, [dark]);

  useInterval(
    tickAutoTime,
    target.kind === "auto-time" && !staticOnly ? 60_000 : null,
  );

  // 6. 壁纸切换平滑淡入（仅壁纸模式且未开启静止/减少动效时）。
  const [wallpaperSwap, setWallpaperSwap] = useState<{
    current: string | null;
    previous: string | null;
    seq: number;
  }>(() => ({
    current: wallpaperCss,
    previous: null,
    seq: 0,
  }));

  if (wallpaperSwap.current !== wallpaperCss) {
    const canCrossfade =
      Boolean(wallpaperSwap.current) && Boolean(wallpaperCss) && !staticOnly;
    setWallpaperSwap({
      current: wallpaperCss,
      previous: canCrossfade ? wallpaperSwap.current : null,
      seq: wallpaperSwap.seq + 1,
    });
  } else if (wallpaperSwap.previous && staticOnly) {
    setWallpaperSwap({
      current: wallpaperSwap.current,
      previous: null,
      seq: wallpaperSwap.seq,
    });
  }

  const clearPreviousWallpaper = useCallback(() => {
    setWallpaperSwap((prev) =>
      prev.previous === null ? prev : { ...prev, previous: null },
    );
  }, []);

  useTimeout(
    clearPreviousWallpaper,
    wallpaperSwap.previous ? DURATION_MS.slow + 40 : null,
    wallpaperSwap.seq,
  );

  // ── 严格三选一互斥渲染 ──

  if (effectiveCanvasKind === "pure") {
    return <div aria-hidden="true" id="sky-root" />;
  }

  if (effectiveCanvasKind === "wallpaper" && config.canvas.kind === "wallpaper") {
    const wallpaperRootStyle = {
      "--canvas-blur": `${config.canvas.blur}px`,
      "--canvas-scrim": (config.canvas.scrim / 100).toFixed(2),
    } as CSSProperties;

    if (wallpaperLoading && !wallpaperCss) {
      return (
        <div
          aria-hidden="true"
          data-wallpaper-loading=""
          id="sky-root"
          style={{ ...wallpaperRootStyle, background: "var(--sky-2)" }}
        />
      );
    }

    const blurActive = config.canvas.blur > 0;
    const blurCssValue = `${config.canvas.blur}px`;
    return (
      <div aria-hidden="true" id="sky-root" style={wallpaperRootStyle}>
        {wallpaperCss ? (
          <div className="chisabot-wallpaper" data-testid="chisabot-wallpaper">
            {wallpaperSwap.previous ? (
              <div
                className="chisabot-wallpaper-img chisabot-wallpaper-img-prev"
                data-blur={blurActive ? "" : undefined}
                style={
                  {
                    "--canvas-blur": blurCssValue,
                    backgroundImage: wallpaperSwap.previous,
                    transform: blurActive ? "scale(1.06)" : undefined,
                  } as CSSProperties
                }
              />
            ) : null}
            <div
              className={
                wallpaperSwap.previous
                  ? "chisabot-wallpaper-img chisabot-wallpaper-img-enter"
                  : "chisabot-wallpaper-img"
              }
              data-blur={blurActive ? "" : undefined}
              key={wallpaperSwap.previous ? wallpaperSwap.seq : "steady"}
              style={
                {
                  "--canvas-blur": blurCssValue,
                  backgroundImage: wallpaperCss,
                  transform: blurActive ? "scale(1.06)" : undefined,
                } as CSSProperties
              }
            />
          </div>
        ) : null}
      </div>
    );
  }

  // canvas.kind === "sky"
  return (
    <div aria-hidden="true" id="sky-root">
      <div id="skyph" />
      <canvas id="gl" />
      <canvas id="skyfreeze" />
      <p id="glfail" />
    </div>
  );
}
