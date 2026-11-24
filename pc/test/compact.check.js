"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeCompactBounds,
  clampToArea,
  createCompactController,
  COMPACT_WIDTH,
  COMPACT_HEIGHT,
} = require("../src/compact-window");

const AREA = { x: 0, y: 0, width: 1920, height: 1032 }; // 1080p，任务栏 48px
const SECOND = { x: 1920, y: 0, width: 1280, height: 680 }; // 右边一台矮屏

test("小窗：贴住窗口右上角收缩，留在工作区内", () => {
  const b = computeCompactBounds(
    { x: 200, y: 100, width: 1280, height: 840 },
    AREA,
  );
  assert.deepEqual(b, {
    x: 200 + 1280 - COMPACT_WIDTH,
    y: 100,
    width: COMPACT_WIDTH,
    height: COMPACT_HEIGHT,
  });
});

test("小窗：最大化时贴住工作区右上角并留 12px", () => {
  const b = computeCompactBounds(AREA, AREA, { maximized: true });
  assert.deepEqual(b, {
    x: 1920 - 12 - COMPACT_WIDTH,
    y: 12,
    width: COMPACT_WIDTH,
    height: COMPACT_HEIGHT,
  });
});

test("小窗：矮屏上高度夹到工作区，底边不越过任务栏", () => {
  const b = computeCompactBounds(
    { x: 2000, y: 300, width: 900, height: 360 },
    SECOND,
    { minHeight: 560 },
  );
  assert.equal(b.height, 680 - 24);
  assert.ok(b.y + b.height <= SECOND.y + SECOND.height);
  assert.ok(b.x >= SECOND.x && b.x + b.width <= SECOND.x + SECOND.width);
});

test("小窗：窗口一半在屏幕外时被夹回来", () => {
  const b = computeCompactBounds(
    { x: 1700, y: 900, width: 800, height: 600 },
    AREA,
  );
  assert.ok(b.x + b.width <= 1920 && b.y + b.height <= 1032 && b.y >= 0);
  assert.deepEqual(
    clampToArea({ x: -50, y: -50, width: 3000, height: 100 }, AREA),
    { x: 0, y: 0, width: 1920, height: 100 },
  );
});

function fakeWindow(bounds, { maximized = false } = {}) {
  const handlers = {};
  const win = {
    _b: { ...bounds },
    _max: maximized,
    _normal: { ...bounds },
    _full: false,
    isDestroyed: () => false,
    isMaximized: () => win._max,
    isFullScreen: () => win._full,
    getBounds: () => (win._max ? { ...AREA } : { ...win._b }),
    getNormalBounds: () => ({ ...win._normal }),
    getMinimumSize: () => [380, 560],
    setBounds(b) {
      win._b = { ...b };
      win._normal = { ...b };
      for (const fn of handlers.resize || []) fn();
    },
    maximize() {
      win._max = true;
      for (const fn of handlers.maximize || []) fn();
    },
    unmaximize() {
      win._max = false;
      win._b = { ...win._normal };
    },
    setFullScreen(v) {
      win._full = v;
    },
    on(name, fn) {
      handlers[name] ||= [];
      handlers[name].push(fn);
    },
    emit(name) {
      for (const fn of handlers[name] || []) fn();
    },
  };
  return win;
}

const fakeScreen = {
  getAllDisplays: () => [
    { id: 1, workArea: AREA },
    { id: 2, workArea: SECOND },
  ],
  getDisplayMatching: (b) =>
    b.x >= 1920 ? { id: 2, workArea: SECOND } : { id: 1, workArea: AREA },
};

test("切换：进入小窗再恢复，回到原来的位置和最大化状态", () => {
  const events = [];
  const c = createCompactController({
    screen: fakeScreen,
    onChange: (_w, v) => events.push(v),
  });
  const win = fakeWindow(
    { x: 100, y: 80, width: 1280, height: 840 },
    { maximized: true },
  );
  c.watch(win);
  assert.equal(c.toggle(win), true);
  assert.equal(win._max, false);
  assert.equal(win._b.width, COMPACT_WIDTH);
  assert.equal(win._b.x + win._b.width, 1920 - 12);
  assert.equal(c.toggle(win), false);
  assert.equal(win._max, true, "原来是最大化的，恢复后还是最大化");
  assert.deepEqual(win._normal, { x: 100, y: 80, width: 1280, height: 840 });
  assert.deepEqual(events, [true, false]);
});

test("切换：用户在小窗里自己最大化 = 离开小窗，不再恢复", () => {
  const events = [];
  const c = createCompactController({
    screen: fakeScreen,
    onChange: (_w, v) => events.push(v),
  });
  const win = fakeWindow({ x: 100, y: 80, width: 1280, height: 840 });
  c.watch(win);
  c.toggle(win);
  win.maximize();
  assert.equal(c.isCompact(win), false);
  assert.deepEqual(events, [true, false]);
});

test("切换：小窗被挪过位置，下次进小窗回到那里", () => {
  const c = createCompactController({ screen: fakeScreen, onChange: () => {} });
  const win = fakeWindow({ x: 100, y: 80, width: 1280, height: 840 });
  c.watch(win);
  c.toggle(win);
  win._b = { x: 40, y: 60, width: COMPACT_WIDTH, height: COMPACT_HEIGHT }; // 用户拖到左边
  c.toggle(win);
  c.toggle(win);
  assert.deepEqual(win._b, {
    x: 40,
    y: 60,
    width: COMPACT_WIDTH,
    height: COMPACT_HEIGHT,
  });
});

const {
  computeUpdateWindowBounds,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
} = require("../src/update-placement");

test("更新窗口：主窗口可见时在主窗口内居中打开", () => {
  const b = computeUpdateWindowBounds({
    chat: { x: 200, y: 100, width: 1280, height: 840 },
    chatVisible: true,
    workArea: AREA,
  });
  assert.deepEqual(b, {
    x: 200 + (1280 - DEFAULT_WIDTH) / 2,
    y: 100 + (840 - DEFAULT_HEIGHT) / 2,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
});

test("更新窗口：主窗口最大化带 -8px 隐形边框时按显示器工作区居中，不偏斜", () => {
  const workArea = { x: 72, y: 0, width: 1848, height: 1040 };
  const chat = { x: 64, y: -8, width: 1864, height: 1056 };
  const b = computeUpdateWindowBounds({ chat, chatVisible: true, workArea });
  assert.deepEqual(b, {
    x: 72 + (1848 - DEFAULT_WIDTH) / 2,
    y: (1040 - DEFAULT_HEIGHT) / 2,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
});

test("更新窗口：窄屏/矮屏上夹取宽高并严格留在工作区内", () => {
  const smallArea = { x: 100, y: 50, width: 800, height: 520 };
  const b = computeUpdateWindowBounds({
    chat: { x: 400, y: 100, width: 500, height: 480 },
    chatVisible: true,
    workArea: smallArea,
  });
  assert.equal(b.width, 800 - 48);
  assert.equal(b.height, 520 - 48);
  assert.ok(
    b.x >= smallArea.x && b.x + b.width <= smallArea.x + smallArea.width,
  );
  assert.ok(
    b.y >= smallArea.y && b.y + b.height <= smallArea.y + smallArea.height,
  );
});

test("更新窗口：主窗口在托盘里时在工作区正中央居中", () => {
  const b = computeUpdateWindowBounds({
    chat: null,
    chatVisible: false,
    workArea: SECOND,
  });
  assert.deepEqual(b, {
    x: 1920 + (1280 - DEFAULT_WIDTH) / 2,
    y: (680 - DEFAULT_HEIGHT) / 2,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
});

test("切换动画：animate 走补间，done 之后才解除 applying、宽 resize 才判离小窗", () => {
  const events = [];
  let doneFn = null;
  const seen = [];
  const c = createCompactController({
    screen: fakeScreen,
    onChange: (_w, v) => events.push(v),
    animate: (_win, target, done) => {
      seen.push(target);
      doneFn = done;
      return () => {};
    },
  });
  const win = fakeWindow({ x: 100, y: 80, width: 1280, height: 840 });
  c.watch(win);
  assert.equal(c.toggle(win), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].width, COMPACT_WIDTH);
  // 补间途中的中间帧（宽度 > LEAVE_WIDTH）不触发「用户拉宽」。
  win._b = { x: 200, y: 100, width: 900, height: 840 };
  win.emit("resize");
  assert.equal(c.isCompact(win), true);
  // 动画落地后用户自己拉宽才真正离开小窗。
  doneFn();
  win.emit("resize");
  assert.equal(c.isCompact(win), false);
  assert.deepEqual(events, [true, false]);
});

test("切换动画：恢复也走 animate，补间落地才恢复最大化", () => {
  let doneFn = null;
  const c = createCompactController({
    screen: fakeScreen,
    onChange: () => {},
    animate: (_win, _target, done) => {
      doneFn = done;
      return () => {};
    },
  });
  const win = fakeWindow(
    { x: 100, y: 80, width: 1280, height: 840 },
    { maximized: true },
  );
  c.watch(win);
  c.toggle(win);
  doneFn();
  c.toggle(win);
  assert.equal(win._max, false, "补间还没落地不能提前最大化");
  doneFn();
  assert.equal(win._max, true);
});

test("切换动画：补间被再次切换打断，旧动画取消", () => {
  let cancelled = 0;
  const c = createCompactController({
    screen: fakeScreen,
    onChange: () => {},
    animate: () => () => {
      cancelled++;
    },
  });
  const win = fakeWindow({ x: 100, y: 80, width: 1280, height: 840 });
  c.watch(win);
  c.toggle(win); // enter 动画起跑
  c.toggle(win); // leave：cancel enter + 起跑恢复动画
  assert.equal(cancelled, 1);
});

test("切换动画：lerpBounds 端点与中点", () => {
  const { lerpBounds } = require("../src/compact-window");
  const from = { x: 0, y: 0, width: 1280, height: 840 };
  const to = { x: 1000, y: 12, width: 420, height: 860 };
  assert.deepEqual(lerpBounds(from, to, 0), from);
  assert.deepEqual(lerpBounds(from, to, 1), to);
  assert.deepEqual(lerpBounds(from, to, 0.5), {
    x: 500,
    y: 6,
    width: 850,
    height: 850,
  });
});

test("Windows 原子落位：进入小窗只调 1 次 setBounds（无 16ms 轮询），并在短护栏内挡住延迟 resize", async () => {
  const { animateWindowBounds } = require("../src/compact-window");
  const calls = [];
  const win = fakeWindow({ x: 100, y: 80, width: 1280, height: 840 });
  const origSetBounds = win.setBounds.bind(win);
  win.setBounds = (b, animateFlag) => {
    calls.push({ b, animateFlag });
    origSetBounds(b);
  };
  const c = createCompactController({
    screen: fakeScreen,
    onChange: () => {},
    animate: (w, target, done, meta) =>
      animateWindowBounds(w, target, {
        platform: "win32",
        phase: meta?.phase,
        settleMs: 25,
        onDone: done,
      }),
  });
  c.watch(win);
  assert.equal(c.toggle(win), true);
  assert.equal(
    calls.length,
    1,
    "Windows 只做单次原子 setBounds，不跑 16ms 补间循环",
  );
  assert.equal(calls[0].animateFlag, undefined);
  assert.equal(calls[0].b.width, COMPACT_WIDTH);
  // 护栏期内晚到的宽 resize 不误判离开小窗
  win._b = { x: 100, y: 80, width: 1200, height: 840 };
  win.emit("resize");
  assert.equal(c.isCompact(win), true);
  // 护栏到期后，用户手动拉宽才离开小窗
  await new Promise((resolve) => setTimeout(resolve, 45));
  win.emit("resize");
  assert.equal(c.isCompact(win), false);
});

test("Windows 最大化态进/出小窗：进入前算好目标紧接 unmaximize，退出时单次 setBounds 后立即同步 maximize 零二次闪跳", () => {
  const { animateWindowBounds } = require("../src/compact-window");
  const ops = [];
  const win = fakeWindow(
    { x: 100, y: 80, width: 1280, height: 840 },
    { maximized: true },
  );
  const origSetBounds = win.setBounds.bind(win);
  const origMax = win.maximize.bind(win);
  const origUnmax = win.unmaximize.bind(win);
  win.setBounds = (b) => {
    ops.push(`setBounds:${b.width}x${b.height}`);
    origSetBounds(b);
  };
  win.maximize = () => {
    ops.push("maximize");
    origMax();
  };
  win.unmaximize = () => {
    ops.push("unmaximize");
    origUnmax();
  };
  const c = createCompactController({
    screen: fakeScreen,
    onChange: () => {},
    animate: (w, target, done, meta) =>
      animateWindowBounds(w, target, {
        platform: "win32",
        phase: meta?.phase,
        settleMs: 30,
        onDone: done,
      }),
  });
  c.watch(win);
  assert.equal(c.toggle(win), true);
  assert.deepEqual(ops, [
    `unmaximize`,
    `setBounds:${COMPACT_WIDTH}x${COMPACT_HEIGHT}`,
  ]);
  assert.equal(win._max, false);
  assert.equal(
    win._b.x + win._b.width,
    1920 - 12,
    "贴工作区右上角留 12px，不受 unmaximize 后 normalBounds 影响",
  );

  ops.length = 0;
  assert.equal(c.toggle(win), false);
  assert.deepEqual(
    ops,
    ["setBounds:1280x840", "maximize"],
    "退出小窗立刻同步 maximize，不等定时器造成二次闪跳",
  );
  assert.equal(win._max, true);
});

test("macOS 保留原生 setBounds(target, true) 动画，减少动画时走无动画单次落位", () => {
  const { animateWindowBounds } = require("../src/compact-window");
  const calls = [];
  const win = fakeWindow({ x: 100, y: 80, width: 1280, height: 840 });
  win.setBounds = (b, flag) => calls.push({ b, flag });
  const cancelNormal = animateWindowBounds(
    win,
    { x: 1480, y: 12, width: 420, height: 860 },
    { platform: "darwin", durationMs: 20 },
  );
  cancelNormal();
  const cancelReduced = animateWindowBounds(
    win,
    { x: 1480, y: 12, width: 420, height: 860 },
    { platform: "darwin", reducedMotion: true, settleMs: 20 },
  );
  cancelReduced();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].flag, true);
  assert.equal(calls[1].flag, undefined);
});

test("Windows 最大化态进/出小窗：同步几何变更期间 isTransitioning 为 true，屏蔽中间态 maximized 事件并一次交付最终态", () => {
  const { animateWindowBounds } = require("../src/compact-window");
  const win = fakeWindow(
    { x: 100, y: 80, width: 1280, height: 840 },
    { maximized: true },
  );
  const emitted = [];
  const c = createCompactController({
    screen: fakeScreen,
    onChange: (_w, compact, meta) =>
      emitted.push({ source: "compact", compact, ...meta }),
    animate: (w, target, done, meta) =>
      animateWindowBounds(w, target, {
        platform: "win32",
        phase: meta?.phase,
        settleMs: 25,
        onDone: done,
      }),
  });
  c.watch(win);
  // 模拟 main.js：在 isTransitioning 期间屏蔽 unmaximize / maximize 引发的中间态 window:maximized 推送。
  const sendMax = () => {
    if (c.isTransitioning(win)) return;
    emitted.push({ source: "max", maximized: win.isMaximized() });
  };
  win.on("maximize", sendMax);
  win.on("unmaximize", sendMax);
  const origUnmax = win.unmaximize.bind(win);
  win.unmaximize = () => {
    origUnmax();
    win.emit("unmaximize");
  };

  assert.equal(c.isTransitioning(win), false);
  assert.equal(c.toggle(win), true);
  assert.equal(c.isTransitioning(win), false);
  assert.deepEqual(emitted, [
    { source: "compact", compact: true, maximized: false, transitioning: true },
  ]);

  emitted.length = 0;
  assert.equal(c.toggle(win), false);
  assert.equal(c.isTransitioning(win), false);
  assert.deepEqual(emitted, [
    { source: "compact", compact: false, maximized: true, transitioning: true },
  ]);
});
