"use strict";
/**
 * 小窗模式（DESIGN.md §36）：一键把主窗口变成手机比例的竖长小窗（约 420×860），再点一次回到原来的大小和位置。
 *
 *  - 小窗留在窗口当前所在的显示器上，贴着窗口原来的右边缘和上边缘收缩（最大化时 = 贴住工作区右上角，留 12px），
 *    然后整体夹回工作区里，不会跑出屏幕或盖住任务栏。
 *  - 进入时记住原来的位置 / 大小 / 是否最大化 / 是否全屏；退出时原样恢复（原来的显示器已经拔掉就放回当前显示器）。
 *  - 小窗里用户自己拖动过的位置会记住：本次运行里再进小窗时回到那里（同一台显示器上才用）。
 *  - 小窗里用户自己最大化、全屏或把窗口拉宽到不再像小窗（> 640px）时，视为已离开小窗，不再「恢复」。
 *
 * 计算部分（computeCompactBounds / clampToArea）是纯函数，pc/test/compact.check.js 直接测；
 * createCompactController 只在主进程里用，接 BrowserWindow 和 screen。
 */

const COMPACT_WIDTH = 420;
const COMPACT_HEIGHT = 860;
const EDGE_MARGIN = 12;
/** 比这更宽就不算小窗了（用户手动把小窗拉宽）。 */
const LEAVE_WIDTH = 640;
/** macOS 进出小窗系统原生动画时长（毫秒）。 */
const COMPACT_ANIMATE_MS = 240;
/**
 * Windows / Linux 单次原子 setBounds 进入小窗后的短护栏时长（毫秒）：
 * 屏蔽刚 unmaximize / setBounds 时异步晚到的旧宽度 resize 事件，避免误判「用户拉宽离开小窗」。
 */
const COMPACT_SETTLE_MS = 120;

function lerpBounds(from, to, t) {
  return {
    x: Math.round(from.x + (to.x - from.x) * t),
    y: Math.round(from.y + (to.y - from.y) * t),
    width: Math.round(from.width + (to.width - from.width) * t),
    height: Math.round(from.height + (to.height - from.height) * t),
  };
}

/**
 * 把窗口切换到 target，返回取消函数。
 * - macOS：原生 `setBounds(target, true)` 走系统合成动画（减少动画时走无动画单次落位）。
 * - Windows / Linux：取消 16ms 轮询 `setBounds`（会触发 ~15 次 Win32/DWM 交换链重建、跨断点整树拆装与全屏磨砂重排），
 *   改为单次原子 `win.setBounds(target)`；退出恢复（`phase === "leave"`）立刻同步触发 `onDone`，
 *   使恢复最大化紧接在 `setBounds` 之后执行、消除二次闪跳；进入小窗保留短护栏 `settleMs` 再释放 `applying`。
 */
function animateWindowBounds(
  win,
  target,
  {
    durationMs = COMPACT_ANIMATE_MS,
    settleMs = COMPACT_SETTLE_MS,
    platform = process.platform,
    phase = "enter",
    reducedMotion = false,
    onDone,
  } = {},
) {
  if (win.isDestroyed()) {
    onDone?.();
    return () => {};
  }
  if (platform === "darwin" && !reducedMotion) {
    win.setBounds(target, true);
    const timer = setTimeout(() => onDone?.(), durationMs);
    return () => clearTimeout(timer);
  }
  win.setBounds(target);
  if (phase === "leave" || settleMs <= 0) {
    onDone?.();
    return () => {};
  }
  const timer = setTimeout(() => onDone?.(), settleMs);
  return () => clearTimeout(timer);
}

function clampToArea(bounds, area) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * 从当前窗口算出小窗的位置。
 * @param {{x:number,y:number,width:number,height:number}} current 当前窗口（最大化时传工作区）
 * @param {{x:number,y:number,width:number,height:number}} area 当前显示器的工作区
 * @param {{maximized?: boolean, minWidth?: number, minHeight?: number}} [opts]
 */
function computeCompactBounds(current, area, opts = {}) {
  const minWidth = opts.minWidth || 0;
  const minHeight = opts.minHeight || 0;
  const margin = opts.maximized ? EDGE_MARGIN : 0;
  const width = Math.max(minWidth, Math.min(COMPACT_WIDTH, area.width - EDGE_MARGIN * 2));
  const height = Math.max(minHeight, Math.min(COMPACT_HEIGHT, area.height - EDGE_MARGIN * 2));
  // 右边缘、上边缘不动（最大化时向内留一点边），向左下收缩。
  const right = Math.min(current.x + current.width, area.x + area.width) - margin;
  const top = Math.max(current.y, area.y) + margin;
  return clampToArea({ x: right - width, y: top, width, height }, area);
}

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * @param {{ screen: import("electron").Screen,
 *   onChange: (win: import("electron").BrowserWindow, compact: boolean) => void,
 *   animate?: (win: import("electron").BrowserWindow, target: object, done: () => void) => (() => void) | undefined }} deps
 * `animate` 可注入做 bounds 补间（main.js 传 animateWindowBounds，测试省略 = 直接 setBounds 无动画）；
 * 注入方负责调用 done()，返回的函数用来取消。
 */
function createCompactController({ screen, onChange, animate }) {
  /** @type {WeakMap<object, {restore: {bounds: object, maximized: boolean, fullScreen: boolean}, applying: boolean}>} */
  const states = new WeakMap();
  /** 进行中的窗口动画：enter/leave 互相打断、窗口关闭时取消。 */
  const anims = new WeakMap();
  /** 本次运行里用户最后一次摆放的小窗（显示器 id + 位置）。 */
  let lastCompact = null;

  const isCompact = (win) => Boolean(win && states.has(win));

  const cancelAnim = (win) => {
    const cancel = anims.get(win);
    anims.delete(win);
    if (typeof cancel === "function") cancel();
  };

  /** 把窗口送到 target；有 animate 就交由它落位，没有就直接 setBounds——两条路都一定会调到 done。 */
  const runTo = (win, target, done, meta) => {
    cancelAnim(win);
    if (!animate) {
      win.setBounds(target);
      done?.();
      return;
    }
    try {
      const cancel = animate(win, target, done, meta);
      anims.set(win, typeof cancel === "function" ? cancel : () => {});
    } catch {
      win.setBounds(target);
      done?.();
    }
  };

  function leave(win, { restore }) {
    const state = states.get(win);
    if (!state) return;
    states.delete(win);
    // 进入动画还在跑就打断——窗口已经不算小窗了，别再把它往小窗里拉。
    cancelAnim(win);
    if (!win.isDestroyed()) {
      const b = win.getBounds();
      if (b.width <= LEAVE_WIDTH) {
        lastCompact = { displayId: screen.getDisplayMatching(b).id, bounds: b };
      }
    }
    if (restore && !win.isDestroyed()) {
      const { bounds, maximized, fullScreen } = state.restore;
      // 原来的显示器还在就原样放回；拔掉了就夹进现在这台显示器的工作区。
      const onScreen = screen.getAllDisplays().some((d) => intersects(d.workArea, bounds));
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      const target = onScreen ? bounds : clampToArea(bounds, area);
      // 落位后恢复最大化 / 全屏（Windows 原子落位时同步紧接 maximize，不先停留在普通尺寸再二次闪跳）。
      runTo(
        win,
        target,
        () => {
          if (win.isDestroyed()) return;
          if (maximized) win.maximize();
          if (fullScreen) win.setFullScreen(true);
        },
        { phase: "leave", maximized, fullScreen },
      );
    }
    if (!win.isDestroyed()) onChange(win, false);
  }

  function enter(win) {
    const maximized = win.isMaximized();
    const fullScreen = win.isFullScreen();
    const currentBounds = win.getBounds();
    const restoreBounds = maximized || fullScreen ? win.getNormalBounds() : currentBounds;
    const display = screen.getDisplayMatching(currentBounds);
    const area = display.workArea;
    const [minWidth, minHeight] = win.getMinimumSize();
    // 在解除最大化/全屏之前就算好小窗目标位置，使 unmaximize() 与 setBounds(target) 紧接执行，减少中间态闪跳。
    let target =
      lastCompact && lastCompact.displayId === display.id
        ? clampToArea(lastCompact.bounds, area)
        : computeCompactBounds(maximized || fullScreen ? area : currentBounds, area, {
            maximized: maximized || fullScreen,
            minWidth,
            minHeight,
          });
    if (target.width > LEAVE_WIDTH) target = computeCompactBounds(area, area, { maximized: true, minWidth, minHeight });
    const state = { restore: { bounds: restoreBounds, maximized, fullScreen }, applying: true };
    states.set(win, state);
    if (fullScreen) win.setFullScreen(false);
    if (maximized) win.unmaximize();
    // 落位期间（含异步晚到的 resize）不算「用户把窗口拉宽」；done 之后才恢复判宽。
    runTo(
      win,
      target,
      () => {
        state.applying = false;
      },
      { phase: "enter", maximized, fullScreen },
    );
    onChange(win, true);
  }

  /** 主窗口创建后调用一次：用户在小窗里自己最大化 / 全屏 / 拉宽 = 离开小窗（不恢复）。 */
  function watch(win) {
    const bail = () => {
      if (isCompact(win)) leave(win, { restore: false });
    };
    win.on("maximize", bail);
    win.on("enter-full-screen", bail);
    win.on("resize", () => {
      const state = states.get(win);
      if (!state || state.applying) return;
      if (win.getBounds().width > LEAVE_WIDTH) leave(win, { restore: false });
    });
    win.on("closed", () => {
      cancelAnim(win);
      states.delete(win);
    });
  }

  function toggle(win) {
    if (!win || win.isDestroyed()) return false;
    if (isCompact(win)) leave(win, { restore: true });
    else enter(win);
    return isCompact(win);
  }

  return { toggle, isCompact, watch };
}

module.exports = {
  COMPACT_WIDTH,
  COMPACT_HEIGHT,
  COMPACT_ANIMATE_MS,
  COMPACT_SETTLE_MS,
  EDGE_MARGIN,
  LEAVE_WIDTH,
  animateWindowBounds,
  clampToArea,
  computeCompactBounds,
  createCompactController,
  lerpBounds,
};
