/**
 * WebGL 天空（#gl）的小快照，给液态玻璃的背景采样用（DESIGN.md §10.6）。
 *
 * 天空画布没开 preserveDrawingBuffer：一帧上屏后缓冲就被清掉，帧外 drawImage(#gl) 读到的是
 * 不透明的全黑（alpha 255）。液态玻璃以前就是在帧外读，Hark 亮天空被当成「黑底 + 薄纱」，
 * 整屏判成深釉。所以改由天空宿主在画完一帧的同一个任务里拷一张 1/8 的小图，采样只读这张。
 *
 * - 只有有人订阅（液态玻璃在用）时才拷，薄雾 / 水晶 / 磨砂材质不花这份开销；
 * - 每 SKY_SNAPSHOT_INTERVAL_MS 最多拷一次（live 天空一直在画，跟得上变化又不至于每帧读回）；
 * - 被节流掉的那一帧如果正好是最后一帧（天空画完渐变就停了），到点再请宿主补画一帧来拷，
 *   不然快照会停在渐变的半路。
 */

export const SKY_SNAPSHOT_INTERVAL_MS = 1000;
/** 快照相对画布的缩小倍数（864×540 的画布 → 108×68）。 */
export const SKY_SNAPSHOT_SCALE = 8;

type Listener = () => void;

const listeners = new Set<Listener>();
let snapCanvas: HTMLCanvasElement | null = null;
let snapAt = Number.NEGATIVE_INFINITY;
let snapVersion = 0;
let trailingTimer = 0;
let redrawHook: (() => void) | null = null;

/** 液态玻璃订阅：有新快照时回调（回调里只该标脏 + 排一次采样，不要做重活）。 */
export function subscribeSkySnapshot(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function skySnapshotWanted(): boolean {
  return listeners.size > 0;
}

/** 天空宿主注册「当帧补画一帧」（sky-background 的 drawSkyNow）。 */
export function setSkySnapshotRedraw(fn: (() => void) | null) {
  redrawHook = fn;
}

/** 当前快照（没有就 null）。version 每拷一次 +1。 */
export function getSkySnapshot(): {
  canvas: HTMLCanvasElement;
  at: number;
  version: number;
} | null {
  if (!snapCanvas || snapVersion === 0) return null;
  return { canvas: snapCanvas, at: snapAt, version: snapVersion };
}

/** 画布尺寸变了 / 天空关了：旧快照作废（下一帧重拷）。 */
export function invalidateSkySnapshot() {
  snapVersion = 0;
  snapAt = Number.NEGATIVE_INFINITY;
}

/**
 * 天空宿主在 drawArrays 之后、同一任务里调用。返回是否拷了一张。
 * force：不管节流（尺寸变化后的第一帧、补画的那一帧）。
 */
export function captureSkySnapshot(
  source: HTMLCanvasElement | null,
  now: number = performance.now(),
  force = false,
): boolean {
  if (listeners.size === 0 || !source) return false;
  if (!force && now - snapAt < SKY_SNAPSHOT_INTERVAL_MS) {
    armTrailing(now);
    return false;
  }
  const w = Math.max(2, Math.round(source.width / SKY_SNAPSHOT_SCALE));
  const h = Math.max(2, Math.round(source.height / SKY_SNAPSHOT_SCALE));
  try {
    if (!snapCanvas) snapCanvas = document.createElement("canvas");
    if (snapCanvas.width !== w) snapCanvas.width = w;
    if (snapCanvas.height !== h) snapCanvas.height = h;
    const ctx = snapCanvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(source, 0, 0, w, h);
  } catch {
    return false;
  }
  snapAt = now;
  snapVersion++;
  window.clearTimeout(trailingTimer);
  trailingTimer = 0;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* 订阅方出错不影响天空出帧 */
    }
  }
  return true;
}

/** 节流掉一帧：到点还没拷到新的，就请宿主补画一帧来拷（天空可能已经停了）。 */
function armTrailing(now: number) {
  if (trailingTimer || typeof window === "undefined") return;
  const wait = Math.max(0, SKY_SNAPSHOT_INTERVAL_MS - (now - snapAt)) + 16;
  const versionAtArm = snapVersion;
  trailingTimer = window.setTimeout(() => {
    trailingTimer = 0;
    if (snapVersion !== versionAtArm || listeners.size === 0) return;
    // 到点时已过节流间隔，补画那一帧里宿主的 captureSkySnapshot 自然会拷。
    redrawHook?.();
  }, wait);
}

/** 仅供单元测试：清掉模块状态。 */
export function __resetSkySnapshotForTestOnly() {
  listeners.clear();
  snapCanvas = null;
  invalidateSkySnapshot();
  window.clearTimeout(trailingTimer);
  trailingTimer = 0;
  redrawHook = null;
}
