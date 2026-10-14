"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeCompactBounds, clampToArea, createCompactController, COMPACT_WIDTH, COMPACT_HEIGHT } = require("../src/compact-window");

const AREA = { x: 0, y: 0, width: 1920, height: 1032 }; // 1080p，任务栏 48px
const SECOND = { x: 1920, y: 0, width: 1280, height: 680 }; // 右边一台矮屏

test("小窗：贴住窗口右上角收缩，留在工作区内", () => {
  const b = computeCompactBounds({ x: 200, y: 100, width: 1280, height: 840 }, AREA);
  assert.deepEqual(b, { x: 200 + 1280 - COMPACT_WIDTH, y: 100, width: COMPACT_WIDTH, height: COMPACT_HEIGHT });
});

test("小窗：最大化时贴住工作区右上角并留 12px", () => {
  const b = computeCompactBounds(AREA, AREA, { maximized: true });
  assert.deepEqual(b, { x: 1920 - 12 - COMPACT_WIDTH, y: 12, width: COMPACT_WIDTH, height: COMPACT_HEIGHT });
});

test("小窗：矮屏上高度夹到工作区，底边不越过任务栏", () => {
  const b = computeCompactBounds({ x: 2000, y: 300, width: 900, height: 360 }, SECOND, { minHeight: 560 });
  assert.equal(b.height, 680 - 24);
  assert.ok(b.y + b.height <= SECOND.y + SECOND.height);
  assert.ok(b.x >= SECOND.x && b.x + b.width <= SECOND.x + SECOND.width);
});

test("小窗：窗口一半在屏幕外时被夹回来", () => {
  const b = computeCompactBounds({ x: 1700, y: 900, width: 800, height: 600 }, AREA);
  assert.ok(b.x + b.width <= 1920 && b.y + b.height <= 1032 && b.y >= 0);
  assert.deepEqual(clampToArea({ x: -50, y: -50, width: 3000, height: 100 }, AREA), { x: 0, y: 0, width: 1920, height: 100 });
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
      (handlers.resize || []).forEach((fn) => fn());
    },
    maximize() {
      win._max = true;
      (handlers.maximize || []).forEach((fn) => fn());
    },
    unmaximize() {
      win._max = false;
      win._b = { ...win._normal };
    },
    setFullScreen(v) {
      win._full = v;
    },
    on(name, fn) {
      (handlers[name] ||= []).push(fn);
    },
    emit(name) {
      (handlers[name] || []).forEach((fn) => fn());
    },
  };
  return win;
}

const fakeScreen = {
  getAllDisplays: () => [{ id: 1, workArea: AREA }, { id: 2, workArea: SECOND }],
  getDisplayMatching: (b) => (b.x >= 1920 ? { id: 2, workArea: SECOND } : { id: 1, workArea: AREA }),
};

test("切换：进入小窗再恢复，回到原来的位置和最大化状态", () => {
  const events = [];
  const c = createCompactController({ screen: fakeScreen, onChange: (_w, v) => events.push(v) });
  const win = fakeWindow({ x: 100, y: 80, width: 1280, height: 840 }, { maximized: true });
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
  const c = createCompactController({ screen: fakeScreen, onChange: (_w, v) => events.push(v) });
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
  assert.deepEqual(win._b, { x: 40, y: 60, width: COMPACT_WIDTH, height: COMPACT_HEIGHT });
});

const { computeUpdateBounds } = require("../src/update-placement");

test("更新提示：主窗口可见时放在主窗口里、顶栏下靠右，跟着主窗口", () => {
  const b = computeUpdateBounds({ chat: { x: 200, y: 100, width: 1280, height: 840 }, chatVisible: true, workArea: AREA, contentHeight: 250 });
  assert.deepEqual(b, { x: 200 + 1280 - 440 - 16, y: 164, width: 440, height: 250, attached: true });
});

test("更新提示：小窗（420 宽）里收窄到 388，仍在窗口内", () => {
  const chat = { x: 1488, y: 12, width: 420, height: 860 };
  const b = computeUpdateBounds({ chat, chatVisible: true, workArea: AREA, contentHeight: 300 });
  assert.equal(b.width, 388);
  assert.ok(b.x >= chat.x && b.x + b.width <= chat.x + chat.width);
  assert.ok(b.y + b.height <= chat.y + chat.height);
});

test("更新提示：主窗口在托盘里时放在工作区右下角", () => {
  const b = computeUpdateBounds({ chat: null, chatVisible: false, workArea: SECOND, contentHeight: 260 });
  assert.deepEqual(b, { x: 1920 + 1280 - 440 - 16, y: 680 - 260 - 16, width: 440, height: 260, attached: false });
});
