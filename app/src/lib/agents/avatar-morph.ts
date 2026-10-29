import {
  mixShapes,
  SHAPE_ANCHORS,
  type ShapeGeometry,
} from "@/lib/agents/avatar-shapes";

/**
 * 形象头像「活着」的样子（DESIGN.md §81）：果冻一样的轮廓，沿边缘流动的波，挤压 / 拉伸，会眨眼、会看的眼睛。
 *
 * - 被选中：轻轻弹一下 + 慢慢左右摆，眼睛看向你（正前方、略放大）。
 * - 在想：中等的流动，眼睛往上慢慢飘。
 * - 在干活：持续、明显的流动变形，会往相邻的形状流过去一点，身体轻轻转，眼睛左右扫 / 看向输出（右下）。
 * - 做完了：开心地跳两下（眼睛是 CSS 的 ^ ^），然后落定。
 * 所有切换都走弹簧（每个状态各有一个权重弹簧，切换时再给果冻一下冲量），不会硬切。
 *
 * 性能约定（左栏一屏几十个头像）：
 * - 全局只有一个 requestAnimationFrame 循环；没有在动的头像时循环停掉，待机 0 帧。
 * - 每帧只对「在动且看得见」的头像 setAttribute（d、身体 / 脸的 transform），React 不重渲染。
 * - 标签页隐藏时停循环（visibilitychange 回来再起）；滚出视口的头像（IntersectionObserver）跳过。
 * - 减少动态效果 / 性能模式：调用处根本不登记，不变形。没有 blur / backdrop-filter。
 */

export type MorphLevel = "idle" | "selected" | "thinking" | "working" | "done";
export type MorphState = {
  selected: boolean;
  thinking: boolean;
  working: boolean;
  done: boolean;
};
export const IDLE_STATE: MorphState = {
  selected: false,
  thinking: false,
  working: false,
  done: false,
};

/** 流动波的强度：干活最强，思考中等，被选中最轻（做完了主要是跳）。 */
export const MORPH_INTENSITY: Record<MorphLevel, number> = {
  idle: 0,
  selected: 0.3,
  thinking: 0.6,
  working: 1,
  done: 0.25,
};

/** 强度 1 时流动波让半径最多偏离多少（相对半径）。 */
export const MORPH_AMPLITUDE = 0.09;

/** 沿边缘走的波：k 是绕一圈的鼓包数，period 秒（2–4 s），dir 是走的方向；weight 加起来是 1。 */
const WAVES = [
  { k: 2, period: 3.2, weight: 0.42, dir: 1 },
  { k: 3, period: 2.4, weight: 0.36, dir: -1 },
  { k: 5, period: 3.8, weight: 0.22, dir: 1 },
] as const;

/** 状态权重的弹簧：略过冲再停（「弹回去」），约 0.6 s 落定。 */
const WEIGHT_K = 110;
const WEIGHT_C = 13;
/** 果冻（挤压 / 拉伸）的弹簧：欠阻尼，切换时给一下冲量会抖几下。 */
const JELLY_K = 260;
const JELLY_C = 7;
/** 眼睛的弹簧。 */
const GAZE_K = 160;
const GAZE_C = 18;
const SETTLE = 0.002;
const DONE_HOP_S = 1.3;
/** 选中之后动多久再慢慢停下。 */
export const SELECTED_CALM_S = 4;

export type MorphPose = {
  /** 身体（轮廓 + 脸）的位移、旋转（度）。 */
  tx: number;
  ty: number;
  rot: number;
  /** 眼睛竖向缩放（眨眼时 → 0.1）。 */
  blink: number;
};
export const REST_POSE: MorphPose = { tx: 0, ty: 0, rot: 0, blink: 1 };

export type MorphTarget = {
  /** 观察可见性的元素（svg）。 */
  element: Element;
  /** 当前的「自己的形状」（换形状的弹簧在改它）。 */
  base: () => ShapeGeometry;
  /** 干活时往哪个形状流过去一点（相邻的形状）。 */
  neighbor?: () => ShapeGeometry;
  /** 头像的像素大小：越小动作越大。 */
  size?: () => number;
  /** 把一帧画到 DOM（setAttribute）。 */
  paint: (geometry: ShapeGeometry, pose: MorphPose) => void;
};

export type MorphHandle = {
  setState: (state: MorphState) => void;
  /** 只给强度（0 = 回到自己的形状后停），相当于只有 working 的那一档。 */
  setIntensity: (intensity: number) => void;
  detach: () => void;
};

type Spring = { x: number; v: number };
type Entry = {
  target: MorphTarget;
  goal: MorphState;
  sel: Spring;
  think: Spring;
  work: Spring;
  done: Spring;
  /** 只用 setIntensity 时的额外强度。 */
  extra: { goal: number; s: Spring };
  jelly: Spring;
  gx: Spring;
  gy: Spring;
  doneAt: number | null;
  /** 什么时候被选中的（-1 = 下一帧定）；选中满 SELECTED_CALM_S 秒后停下。 */
  selectedAt: number | null;
  nextBlink: number;
  blinkAt: number | null;
  phase: number;
  visible: boolean;
  active: boolean;
};

type Scheduler = {
  request: (callback: (now: number) => void) => number;
  cancel: (id: number) => void;
};

const defaultScheduler: Scheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

let scheduler: Scheduler = defaultScheduler;
const active = new Set<Entry>();
const byElement = new WeakMap<Element, Entry>();
let frameId: number | null = null;
let lastNow: number | null = null;
let clockNow = 0;
let observer: IntersectionObserver | null = null;
let visibilityInstalled = false;
let seed = 0;
let random = Math.random;

/** 测试 / 性能脚本读的计数。 */
export const morphStats = { frames: 0, painted: 0 };

export function morphActiveCount() {
  return active.size;
}

export function morphLoopRunning() {
  return frameId !== null;
}

/** 测试用：换掉 rAF / 随机数，并清空全局状态。 */
export function setMorphSchedulerForTests(
  next: Scheduler | null,
  rng: () => number = Math.random,
) {
  if (frameId !== null) scheduler.cancel(frameId);
  frameId = null;
  lastNow = null;
  scheduler = next ?? defaultScheduler;
  random = rng;
  for (const entry of active) observer?.unobserve(entry.target.element);
  active.clear();
  observer?.disconnect();
  observer = null;
  morphStats.frames = 0;
  blurred = false;
  morphStats.painted = 0;
}

/** 窗口失去焦点（切到别的应用）时也停。焦点进了页面里的 iframe 不算（document.hasFocus() 仍是 true）。 */
let blurred = false;

function hidden() {
  return (
    blurred ||
    (typeof document !== "undefined" && document.visibilityState === "hidden")
  );
}

function installVisibility() {
  if (visibilityInstalled || typeof document === "undefined") return;
  visibilityInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (hidden()) stop();
    else ensureLoop();
  });
  window.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.hasFocus()) return;
      blurred = true;
      stop();
    }, 0);
  });
  window.addEventListener("focus", () => {
    blurred = false;
    ensureLoop();
  });
}

function getObserver(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver === "undefined") return observer;
  observer = new IntersectionObserver((records) => {
    for (const record of records) {
      const entry = byElement.get(record.target);
      if (entry) entry.visible = record.isIntersecting;
    }
    ensureLoop();
  });
  return observer;
}

function stop() {
  if (frameId !== null) scheduler.cancel(frameId);
  frameId = null;
  lastNow = null;
}

function anyRunnable() {
  for (const entry of active) if (entry.visible) return true;
  return false;
}

function ensureLoop() {
  if (frameId !== null || hidden() || !anyRunnable()) return;
  frameId = scheduler.request(frame);
}

function step(spring: Spring, goal: number, k: number, c: number, dt: number) {
  spring.v += (k * (goal - spring.x) - c * spring.v) * dt;
  spring.x += spring.v * dt;
}

function settled(spring: Spring, goal = 0) {
  return Math.abs(spring.x - goal) < SETTLE && Math.abs(spring.v) < SETTLE * 10;
}

const num = (on: boolean) => (on ? 1 : 0);

/**
 * 一帧的形状和姿态（纯函数，测试和录屏脚本也用它）。
 * flow：流动波强度；squash：果冻（>0 横向鼓、竖向扁）；morphTo：往相邻形状流多少。
 */
export function morphGeometry(
  base: ShapeGeometry,
  flow: number,
  seconds: number,
  phase = 0,
  squash = 0,
  neighbor?: ShapeGeometry,
  morphTo = 0,
): ShapeGeometry {
  if (flow === 0 && squash === 0 && morphTo === 0) return base;
  const from =
    neighbor && morphTo > 0 ? mixShapes(base, neighbor, morphTo) : base;
  const amp = MORPH_AMPLITUDE * flow;
  const radii = new Array<number>(SHAPE_ANCHORS);
  for (let i = 0; i < SHAPE_ANCHORS; i++) {
    const theta = (i / SHAPE_ANCHORS) * Math.PI * 2;
    let wave = 0;
    for (let w = 0; w < WAVES.length; w++) {
      const { k, period, weight, dir } = WAVES[w];
      // k·θ − ωt：鼓包沿着边缘绕圈走。
      wave +=
        weight *
        Math.sin(
          k * theta - dir * (seconds / period) * Math.PI * 2 + phase * (w + 1),
        );
    }
    radii[i] = from.radii[i] * (1 + amp * wave + squash * Math.cos(2 * theta));
  }
  return { ...from, radii };
}

function frame(now: number) {
  frameId = null;
  if (hidden()) return;
  const dt =
    lastNow === null
      ? 1 / 60
      : Math.min(0.05, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  clockNow = now;
  morphStats.frames++;
  const t = now / 1000;
  for (const entry of active) {
    if (!entry.visible) continue;
    const g = entry.goal;
    // 选中几秒后慢慢停下（不然选中的那一个一直在动）。
    if (entry.selectedAt === -1) entry.selectedAt = t;
    const selGoal =
      g.selected &&
      entry.selectedAt !== null &&
      t - entry.selectedAt < SELECTED_CALM_S
        ? 1
        : 0;
    step(entry.sel, selGoal, WEIGHT_K / 3, WEIGHT_C / 1.7, dt);
    step(entry.think, num(g.thinking), WEIGHT_K, WEIGHT_C, dt);
    step(entry.work, num(g.working), WEIGHT_K, WEIGHT_C, dt);
    step(entry.done, num(g.done), WEIGHT_K, WEIGHT_C, dt);
    step(entry.extra.s, entry.extra.goal, WEIGHT_K, WEIGHT_C, dt);
    step(entry.jelly, 0, JELLY_K, JELLY_C, dt);
    const sel = entry.sel.x;
    const think = entry.think.x;
    const work = Math.max(entry.work.x, entry.extra.s.x);
    const done = entry.done.x;
    const ph = entry.phase;

    // 头像越小动作越大（DESIGN.md §81）：40px 以上原样，往下放大，到 18px 封顶；眼睛放得最多（小图上最看得出）。
    const size = entry.target.size?.() ?? 40;
    const small = Math.max(0, Math.min(1, (40 - size) / 22));
    const gain = 1 + 1.6 * small;
    const eyeGain = 1 + 2.6 * small;
    const wave = (period: number, offset = 0) =>
      Math.sin((t * Math.PI * 2) / period + ph + offset);

    // 眼睛：选中看你（正前方）；在想慢慢往上、左右飘（琢磨）；干活快速左右扫 + 偏向右下的输出。
    const glance = Math.tanh(5 * wave(1.6));
    const gazeX =
      eyeGain * (work * (3.5 * glance + 1) + think * 3.5 * wave(3.8, 1));
    const gazeY = eyeGain * (work * 1.6 - think * 3);
    step(entry.gx, gazeX, GAZE_K, GAZE_C, dt);
    step(entry.gy, gazeY, GAZE_K, GAZE_C, dt);

    // 眨眼：随机 2–5 s 一次，0.16 s。
    let blink = 1;
    if (entry.blinkAt === null && t >= entry.nextBlink) entry.blinkAt = t;
    if (entry.blinkAt !== null) {
      const p = (t - entry.blinkAt) / 0.16;
      if (p >= 1) {
        entry.blinkAt = null;
        entry.nextBlink = t + 2 + random() * 3;
      } else blink = 1 - 0.9 * Math.sin(Math.PI * p);
    }

    // 做完了：跳两下，越跳越低；起跳拉长、落地压扁。
    let hopY = 0;
    let hopSquash = 0;
    if (entry.doneAt === -1) entry.doneAt = t;
    if (entry.doneAt !== null) {
      const s = t - entry.doneAt;
      if (s < DONE_HOP_S) {
        const decay = Math.exp(-s / 0.7);
        const hop = Math.abs(Math.sin((Math.PI * s) / 0.45));
        hopY = -9 * gain * hop * decay;
        hopSquash = -0.07 * gain * Math.cos((2 * Math.PI * s) / 0.45) * decay;
      } else entry.doneAt = null;
    }

    const flow =
      gain *
      (sel * MORPH_INTENSITY.selected +
        think * MORPH_INTENSITY.thinking +
        work * MORPH_INTENSITY.working +
        done * MORPH_INTENSITY.done);
    // 选中：每 1.6 s 轻轻蹦一下（落地压扁）+ 慢摆。
    const bounce = Math.max(0, wave(1.6)) ** 2;
    // 在想：慢慢歪头（4.2 s 一个来回）、上下漂。干活：快呼吸（0.9 s）、明显地转。
    const busy = wave(0.9);
    const squash =
      entry.jelly.x +
      hopSquash +
      gain *
        (work * 0.045 * busy +
          sel * 0.05 * (bounce - 0.3) +
          think * 0.015 * wave(2.6));
    const rot =
      gain *
      (sel * 4 * wave(3.6) +
        think * 9 * wave(4.2, 2) +
        work * 6 * wave(2.2, 1));
    const ty =
      hopY +
      gain *
        (sel * -3.5 * bounce + think * 1.8 * wave(3.1) + work * 1.5 * busy);
    const morphTo =
      work * 0.3 * (0.5 - 0.5 * Math.cos((t * Math.PI * 2) / 3.4 + ph));

    const base = entry.target.base();
    const geometry = morphGeometry(
      base,
      flow,
      t,
      ph,
      squash,
      entry.target.neighbor?.(),
      morphTo,
    );
    const face = {
      ...geometry.face,
      x: geometry.face.x + entry.gx.x,
      y: geometry.face.y + entry.gy.x,
      scale: geometry.face.scale * (1 + 0.1 * sel),
    };

    const goalsOff =
      selGoal === 0 &&
      !g.thinking &&
      !g.working &&
      !g.done &&
      entry.extra.goal === 0;
    if (
      goalsOff &&
      entry.doneAt === null &&
      [
        entry.sel,
        entry.think,
        entry.work,
        entry.done,
        entry.extra.s,
        entry.jelly,
        entry.gx,
        entry.gy,
      ].every((s) => settled(s))
    ) {
      // 回到自己的形状，退出循环。
      entry.target.paint(base, REST_POSE);
      morphStats.painted++;
      deactivate(entry);
      continue;
    }
    entry.target.paint({ ...geometry, face }, { tx: 0, ty, rot, blink });
    morphStats.painted++;
  }
  if (anyRunnable()) frameId = scheduler.request(frame);
  else lastNow = null;
}

function activate(entry: Entry) {
  if (entry.active) return;
  entry.active = true;
  active.add(entry);
  entry.nextBlink = clockNow / 1000 + 0.8 + random() * 2;
  getObserver()?.observe(entry.target.element);
  installVisibility();
}

function deactivate(entry: Entry) {
  if (!entry.active) return;
  entry.active = false;
  active.delete(entry);
  observer?.unobserve(entry.target.element);
}

const spring = (): Spring => ({ x: 0, v: 0 });

export function attachMorph(target: MorphTarget): MorphHandle {
  const entry: Entry = {
    target,
    goal: IDLE_STATE,
    sel: spring(),
    think: spring(),
    work: spring(),
    done: spring(),
    extra: { goal: 0, s: spring() },
    jelly: spring(),
    gx: spring(),
    gy: spring(),
    doneAt: null,
    selectedAt: null,
    nextBlink: 0,
    blinkAt: null,
    phase: (seed++ * 2.39996) % (Math.PI * 2),
    visible: true,
    active: false,
  };
  byElement.set(target.element, entry);
  const wake = () => {
    const g = entry.goal;
    const on =
      (g.selected && entry.selectedAt !== null) ||
      g.thinking ||
      g.working ||
      g.done ||
      entry.extra.goal > 0;
    if (on || entry.active) activate(entry);
    ensureLoop();
  };
  return {
    setState(next) {
      const before = entry.goal;
      if (
        before.selected === next.selected &&
        before.thinking === next.thinking &&
        before.working === next.working &&
        before.done === next.done
      )
        return;
      entry.goal = next;
      // 状态一变就给果冻一下：选中是「啵」地一弹，其他是轻轻一抖。
      if (next.selected && !before.selected) entry.jelly.v += 1.6;
      else if (entry.active || next.working || next.thinking)
        entry.jelly.v -= 0.8;
      // 跳的起点在下一帧定（-1 = 待定）。
      if (next.done && !before.done) entry.doneAt = -1;
      entry.selectedAt = next.selected
        ? before.selected
          ? entry.selectedAt
          : -1
        : null;
      wake();
    },
    setIntensity(intensity) {
      entry.extra.goal = intensity;
      wake();
    },
    detach() {
      deactivate(entry);
      byElement.delete(target.element);
      if (!anyRunnable()) stop();
    },
  };
}

/** 状态 → 主导的一档（给 data-activity 和测试）。 */
export function morphLevelOf(state: MorphState): MorphLevel {
  if (state.working) return "working";
  if (state.done) return "done";
  if (state.thinking) return "thinking";
  return state.selected ? "selected" : "idle";
}
