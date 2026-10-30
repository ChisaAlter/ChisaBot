import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let __skyLoopForTestOnly: typeof import("@/components/sky-background").__skyLoopForTestOnly;
let initResizeState: typeof import("@/lib/resize-state").initResizeState;
let isResizing: typeof import("@/lib/resize-state").isResizing;
let subscribeResizing: typeof import("@/lib/resize-state").subscribeResizing;
let RESIZE_SETTLE_MS = 0;

/*
 * P2-3：改窗口大小期间 <html data-resizing>，停下约 150ms 后拿掉；WebGL 天空同一时机暂停 / 恢复。
 * 手写假时钟（setTimeout + rAF），不依赖真实时间。
 */
type Task = { id: number; at: number; fn: (ts: number) => void; raf: boolean };
let now = 0;
let seq = 0;
let tasks: Task[] = [];
let real: Record<string, never>;
function captureReal() {
  real = {
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    raf: window.requestAnimationFrame,
    caf: window.cancelAnimationFrame,
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
    perfNow: performance.now,
  } as unknown as Record<string, never>;
}

beforeAll(async () => {
  GlobalRegistrator.register();
  captureReal();
  ({ __skyLoopForTestOnly } = await import("@/components/sky-background"));
  ({ initResizeState, isResizing, subscribeResizing, RESIZE_SETTLE_MS } =
    await import("@/lib/resize-state"));
});
afterAll(() => GlobalRegistrator.unregister());
const live = new Map<string, number>();
let teardown: () => void = () => {};

function advance(ms: number) {
  const end = now + ms;
  for (;;) {
    const next = tasks
      .filter((t) => t.at <= end)
      .sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!next) break;
    tasks = tasks.filter((t) => t !== next);
    now = Math.max(now, next.at);
    next.fn(now);
  }
  now = end;
}
const resize = () => window.dispatchEvent(new Event("resize"));
const attr = () => document.documentElement.hasAttribute("data-resizing");

beforeEach(() => {
  now = 1000;
  tasks = [];
  live.clear();
  const w = window as unknown as Record<string, unknown>;
  w.setTimeout = (fn: () => void, ms = 0) => {
    const id = ++seq;
    tasks.push({ id, at: now + ms, fn, raf: false });
    return id;
  };
  w.clearTimeout = (id: number) => {
    tasks = tasks.filter((t) => t.id !== id);
  };
  w.requestAnimationFrame = (fn: (ts: number) => void) => {
    const id = ++seq;
    tasks.push({ id, at: now + 16, fn, raf: true });
    return id;
  };
  w.cancelAnimationFrame = w.clearTimeout;
  w.addEventListener = function (this: Window, type: string, ...rest: never[]) {
    live.set(type, (live.get(type) ?? 0) + 1);
    return (real.addEventListener as (...a: unknown[]) => void).call(
      this,
      type,
      ...rest,
    );
  };
  w.removeEventListener = function (
    this: Window,
    type: string,
    ...rest: never[]
  ) {
    live.set(type, (live.get(type) ?? 0) - 1);
    return (real.removeEventListener as (...a: unknown[]) => void).call(
      this,
      type,
      ...rest,
    );
  };
  performance.now = () => now;
  teardown = initResizeState();
});

afterEach(() => {
  teardown();
  const w = window as unknown as Record<string, unknown>;
  w.setTimeout = real.setTimeout;
  w.clearTimeout = real.clearTimeout;
  w.requestAnimationFrame = real.raf;
  w.cancelAnimationFrame = real.caf;
  w.addEventListener = real.addEventListener;
  w.removeEventListener = real.removeEventListener;
  performance.now = real.perfNow;
});

test("resize 开始后下一帧挂上 data-resizing，最后一次 resize 后约 150ms 拿掉", () => {
  expect(attr()).toBe(false);
  resize();
  expect(attr()).toBe(false); // 挂在 rAF 里，不在事件里同步写 DOM
  advance(16);
  expect(attr()).toBe(true);
  expect(isResizing()).toBe(true);
  // 拖动中持续有 resize：一直保持
  for (let i = 0; i < 10; i++) {
    advance(33);
    resize();
  }
  expect(attr()).toBe(true);
  advance(RESIZE_SETTLE_MS - 1);
  expect(attr()).toBe(true);
  advance(1);
  expect(attr()).toBe(false);
  expect(isResizing()).toBe(false);
});

test("订阅者在开始 / 结束各收到一次通知", () => {
  const seen: boolean[] = [];
  const off = subscribeResizing((r) => seen.push(r));
  resize();
  advance(16);
  resize();
  advance(16);
  advance(RESIZE_SETTLE_MS);
  off();
  resize();
  advance(16 + RESIZE_SETTLE_MS);
  expect(seen).toEqual([true, false]);
});

test("WebGL 天空：改窗口大小期间节流循环暂停，停下后恢复", () => {
  __skyLoopForTestOnly.setMode("snapshot");
  __skyLoopForTestOnly.state.wakeUntil = now + 10_000;
  expect(__skyLoopForTestOnly.canRun(now)).toBe(true);
  resize();
  advance(16);
  expect(__skyLoopForTestOnly.canRun(now)).toBe(false);
  advance(RESIZE_SETTLE_MS);
  expect(__skyLoopForTestOnly.canRun(now)).toBe(true);
});

test("init 幂等、拆掉后不留监听和计时器", () => {
  const again = initResizeState();
  expect(again).toBe(teardown);
  expect(live.get("resize")).toBe(1); // 只注册一次
  resize();
  advance(16);
  expect(attr()).toBe(true);
  resize(); // 留一个待定的 settle 计时器
  teardown();
  expect(live.get("resize")).toBe(0);
  expect(attr()).toBe(false);
  expect(tasks.length).toBe(0);
  resize();
  advance(16 + RESIZE_SETTLE_MS);
  expect(attr()).toBe(false);
});

test("WebGL 天空：拖动中不改画布尺寸，停下后按最终尺寸改一次", () => {
  __skyLoopForTestOnly.setMode("snapshot");
  __skyLoopForTestOnly.listen();
  let engineResizes = 0;
  __skyLoopForTestOnly.engineAddEventListener("resize", () => {
    engineResizes++;
  });
  // 不在拖动中：照常同步改尺寸
  __skyLoopForTestOnly.onResizeEvent(new Event("resize"));
  expect(engineResizes).toBe(1);
  advance(1000);
  for (let i = 0; i < 20; i++) {
    resize();
    __skyLoopForTestOnly.onResizeEvent(new Event("resize"));
    advance(33);
  }
  expect(engineResizes).toBe(1);
  advance(RESIZE_SETTLE_MS);
  expect(engineResizes).toBe(2);
});

test("一个订阅者抛错不影响其他订阅者", () => {
  const seen: boolean[] = [];
  const origError = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => logged.push(a);
  const offBad = subscribeResizing(() => {
    throw new Error("boom");
  });
  const offGood = subscribeResizing((r) => seen.push(r));
  try {
    resize();
    advance(16 + RESIZE_SETTLE_MS);
  } finally {
    console.error = origError;
    offBad();
    offGood();
  }
  expect(seen).toEqual([true, false]);
  expect(logged.length).toBe(2);
});
