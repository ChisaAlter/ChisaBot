/**
 * 虚拟形象情感微交互核心引擎（Wave 6）：
 * 1. 指针跟随凝视向量计算（边界限幅 + 严格遵守 `prefers-reduced-motion`）；
 * 2. 单 rAF + `WeakMap` 错峰独立冷却 + `IntersectionObserver` 视口裁剪 + 窗口失焦/标签页隐藏自动暂停；
 * 3. 6 种忙碌 Bot 去重微表情池分配器 `assignDistinctBusyExpressions(botIds)`；
 * 4. 登录页表单状态联动表情机（输入密码 `cover-eyes`、提交报错 `shake-error`、登录成功 `happy-squint`）。
 */

export const BUSY_EXPRESSIONS = [
  "reading",
  "typing",
  "thinking",
  "scanning",
  "focused",
  "nodding",
] as const;

export type BusyExpression = (typeof BUSY_EXPRESSIONS)[number];

export const BUSY_EXPRESSION_LABELS: Record<BusyExpression, string> = {
  reading: "正在阅读",
  typing: "正在撰写",
  thinking: "深度思考",
  scanning: "检索分析",
  focused: "专注执行",
  nodding: "确认整理",
};

export type SignAvatarMood =
  | "idle"
  | "gaze"
  | "cover-eyes"
  | "submitting"
  | "shake-error"
  | "happy-squint";

export type SignFormAvatarInput = {
  passwordFocused?: boolean;
  passwordFilled?: boolean;
  submitting?: boolean;
  hasError?: boolean;
  succeeded?: boolean;
  hasPointer?: boolean;
};

export const SIGN_AVATAR_MOOD_LABELS: Record<SignAvatarMood, string> = {
  idle: "等待登录",
  gaze: "注视交互",
  "cover-eyes": "输入密码时闭眼回避",
  submitting: "正在登录",
  "shake-error": "登录出错摇头提醒",
  "happy-squint": "登录成功微笑",
};

/** 确定性字符串哈希（DJB/31 变体），同一 botId 跨渲染保持稳定首选神态。 */
export function hashAvatarSeed(seed: string): number {
  let sum = 7;
  for (const ch of seed) {
    sum = (sum * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return sum;
}

/**
 * 为同屏多个正在忙碌的 Bot 分配互不重复的 6 种微表情神态：
 * - 每个 botId 从其确定性哈希槽位出发，线性探测首个未被占用的神态；
 * - 1–6 个忙碌 Bot 时保证 100% 各异不千篇一律；
 * - 超过 6 个时按顺位平滑循环复用，不崩溃、不随机闪烁。
 */
export function assignDistinctBusyExpressions(
  botIds: readonly string[],
): Map<string, BusyExpression> {
  const assigned = new Map<string, BusyExpression>();
  const used = new Set<BusyExpression>();

  for (const rawId of botIds) {
    const id = rawId.trim();
    if (!id || assigned.has(id)) continue;
    const start = hashAvatarSeed(id) % BUSY_EXPRESSIONS.length;
    let chosen: BusyExpression = BUSY_EXPRESSIONS[start] ?? "focused";
    for (let offset = 0; offset < BUSY_EXPRESSIONS.length; offset += 1) {
      const candidate =
        BUSY_EXPRESSIONS[(start + offset) % BUSY_EXPRESSIONS.length];
      if (candidate && !used.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    used.add(chosen);
    assigned.set(id, chosen);
    if (used.size >= BUSY_EXPRESSIONS.length) {
      used.clear();
    }
  }

  return assigned;
}

/**
 * 登录页表单状态联动表情机（纯函数，确定性优先级）：
 * 登录成功（眯眼笑） > 提交报错（摇头） > 提交中 > 输入密码（闭眼回避） > 指针跟随凝视 > 待机。
 */
export function deriveSignAvatarMood(
  input: SignFormAvatarInput,
): SignAvatarMood {
  if (input.succeeded) return "happy-squint";
  if (input.hasError) return "shake-error";
  if (input.submitting) return "submitting";
  if (input.passwordFocused || input.passwordFilled) return "cover-eyes";
  if (input.hasPointer) return "gaze";
  return "idle";
}

export type Point2D = { x: number; y: number };

export type GazeVectorOptions = {
  /** 最大偏转占头像宽度的比例，默认 0.075。 */
  reach?: number;
  /** 明确开启减少动态效果时严格归零。 */
  reducedMotion?: boolean;
};

/**
 * 计算虚拟形象眼睛朝向指针的限幅凝视向量（像素偏移）。
 * - `reducedMotion` 为 true 或尺寸无效时严格返回 `{ x: 0, y: 0 }`；
 * - 距离近时线性平滑过渡，距离远时严格限幅在 `size * reach` 半径圆内。
 */
export function computeGazeVector(
  origin: Point2D,
  pointer: Point2D,
  size: number,
  options: GazeVectorOptions = {},
): Point2D {
  if (options.reducedMotion || !Number.isFinite(size) || size <= 0) {
    return { x: 0, y: 0 };
  }
  const reach = options.reach ?? 0.075;
  const maxOffset = Math.max(0, size * reach);
  if (maxOffset === 0) return { x: 0, y: 0 };

  const dx = pointer.x - origin.x;
  const dy = pointer.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 0.001) {
    return { x: 0, y: 0 };
  }
  const scale = Math.min(1, distance / (size * 0.6));
  const magnitude = maxOffset * scale;
  return {
    x: Number(((dx / distance) * magnitude).toFixed(2)),
    y: Number(((dy / distance) * magnitude).toFixed(2)),
  };
}

export type GazeTarget = {
  element: Element;
  /** 返回 true 时跳过凝视（如闭眼/忙碌覆盖态）。 */
  isLocked?: () => boolean;
  /** 应用偏移量到 DOM（如设置 CSS 变量 `--gaze-x` / `--gaze-y`）。 */
  apply: (offset: Point2D) => void;
};

export type GazeSchedulerAdapter = {
  requestFrame: (cb: (now: number) => void) => number;
  cancelFrame: (id: number) => void;
  now: () => number;
  random: () => number;
  isReducedMotion: () => boolean;
};

const defaultGazeAdapter: GazeSchedulerAdapter = {
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
  now: () =>
    typeof performance !== "undefined" ? performance.now() : Date.now(),
  random: () => Math.random(),
  isReducedMotion: () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
};

/**
 * 高性能单 rAF 指针凝视调度器：
 * - `WeakMap<Element, number>` 记录每个头像的独立错峰冷却截止时间（默认 80–420ms），避免同屏多头像机械齐步；
 * - 共享单一 `requestAnimationFrame`，指针停止移动超过 900ms 自动停帧（待机 0 帧）；
 * - 支持 `IntersectionObserver` 视口裁剪（滚出屏幕不测量不绘制）；
 * - 窗口失焦 / 页面隐藏 (`visibilityState === "hidden"`) 或 `prefers-reduced-motion` 时自动暂停并归零。
 */
export function createStaggeredGazeScheduler(
  options: {
    reach?: number;
    minCooldownMs?: number;
    maxCooldownMs?: number;
    idleStopMs?: number;
    adapter?: Partial<GazeSchedulerAdapter>;
  } = {},
) {
  const reach = options.reach ?? 0.075;
  const minCooldownMs = options.minCooldownMs ?? 80;
  const maxCooldownMs = options.maxCooldownMs ?? 420;
  const idleStopMs = options.idleStopMs ?? 900;
  const adapter: GazeSchedulerAdapter = {
    ...defaultGazeAdapter,
    ...options.adapter,
  };

  const targets = new Set<GazeTarget>();
  const targetByElement = new WeakMap<Element, GazeTarget>();
  const visibleMap = new WeakMap<Element, boolean>();
  const nextDueByElement = new WeakMap<Element, number>();

  let pointer: Point2D | null = null;
  let lastMoveAt = 0;
  let frameId: number | null = null;
  let paused = false;
  let observer: IntersectionObserver | null = null;

  function ensureObserver(): IntersectionObserver | null {
    if (observer || typeof IntersectionObserver === "undefined") {
      return observer;
    }
    observer = new IntersectionObserver((records) => {
      for (const record of records) {
        visibleMap.set(record.target, record.isIntersecting);
      }
    });
    return observer;
  }

  function isHiddenOrPaused(): boolean {
    if (paused || adapter.isReducedMotion()) return true;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return true;
    }
    return false;
  }

  function stopLoop(): void {
    if (frameId !== null) {
      adapter.cancelFrame(frameId);
      frameId = null;
    }
  }

  function resetAll(): void {
    for (const target of targets) {
      target.apply({ x: 0, y: 0 });
    }
  }

  function stepFrame(now: number): void {
    frameId = null;
    if (!pointer || isHiddenOrPaused() || targets.size === 0) return;

    for (const target of targets) {
      if (visibleMap.get(target.element) === false) continue;
      if (target.isLocked?.()) {
        target.apply({ x: 0, y: 0 });
        continue;
      }
      const due = nextDueByElement.get(target.element) ?? 0;
      if (now < due) continue;

      const rect = target.element.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const vector = computeGazeVector(
        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        pointer,
        size,
        { reach, reducedMotion: adapter.isReducedMotion() },
      );
      target.apply(vector);
      const cooldown =
        minCooldownMs +
        adapter.random() * Math.max(0, maxCooldownMs - minCooldownMs);
      nextDueByElement.set(target.element, now + cooldown);
    }

    if (now - lastMoveAt < idleStopMs && !isHiddenOrPaused()) {
      frameId = adapter.requestFrame(stepFrame);
    }
  }

  function register(target: GazeTarget): () => void {
    targets.add(target);
    targetByElement.set(target.element, target);
    visibleMap.set(target.element, true);
    ensureObserver()?.observe(target.element);
    return () => {
      targets.delete(target);
      targetByElement.delete(target.element);
      visibleMap.delete(target.element);
      nextDueByElement.delete(target.element);
      observer?.unobserve(target.element);
      if (targets.size === 0) stopLoop();
    };
  }

  function updatePointer(next: Point2D | null): void {
    pointer = next;
    if (!next || isHiddenOrPaused()) {
      stopLoop();
      if (!next) resetAll();
      return;
    }
    lastMoveAt = adapter.now();
    if (frameId === null && targets.size > 0) {
      frameId = adapter.requestFrame(stepFrame);
    }
  }

  function setPaused(nextPaused: boolean): void {
    paused = nextPaused;
    if (paused) {
      stopLoop();
      resetAll();
    } else if (pointer && targets.size > 0 && !adapter.isReducedMotion()) {
      lastMoveAt = adapter.now();
      if (frameId === null) {
        frameId = adapter.requestFrame(stepFrame);
      }
    }
  }

  function dispose(): void {
    stopLoop();
    observer?.disconnect();
    observer = null;
    targets.clear();
    pointer = null;
  }

  return {
    register,
    updatePointer,
    setPaused,
    resetAll,
    dispose,
    isRunning: () => frameId !== null,
  };
}
