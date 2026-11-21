/**
 * 流式回复的平滑显示（2026-10-13，用户：「AI 输出的时候一段一段的往外蹦，显得非常卡顿，改成流式的流畅输出」）。
 *
 * 实测（docs/streaming.md）：服务器、网关、Cloudflare 都是逐事件直通的，卡顿来自模型平台本身——
 * 免费模型每 ~200ms 才吐一批字（一批 10–25 个汉字），界面原样一批一批画上去，看起来就是一段一段蹦。
 * 网络这一侧没法让上游更匀，所以在界面上把收到的字「匀速放出来」：
 *
 *  - 每帧按积压量放字：速度 = 积压 / TAU（指数追赶），积压大就快、积压小就慢，最少 MIN_CPS 字/秒；
 *  - 硬上限：任何一个字从收到到显示不超过 MAX_LAG_MS（落后太多就直接追上），所以不会越拖越慢；
 *  - 切口不落在 Markdown 记号中间（「**」「- 」「1. 」「```」等一起放出），避免一帧里先画成别的样子；
 *  - 新内容不是旧内容的延续（重新生成、换了一条）就直接整段显示。
 *
 * 纯函数，不碰 DOM / React；节拍和「标签页隐藏 / 减少动态效果时立刻显示」在 use-smooth-text.ts。
 */

/** 指数追赶的时间常数：突发阻塞批次下约落后这么多毫秒。 */
export const TAU_MS = 90;
/** 硬上限：收到的字最多晚这么久显示。 */
export const MAX_LAG_MS = 220;
/** 积压很少时的最低速度（字/秒），尾巴不会一个字一个字地爬。 */
export const MIN_CPS = 60;

export type RevealState = {
  /** 当前要显示到的全文。 */
  target: string;
  /** 已显示到的位置（带小数，跨帧累计）。 */
  pos: number;
  /** 实际切口（snapCut 之后），即显示 target.slice(0, cut)。 */
  cut: number;
  /** 每次收到新内容时的 [长度, 时间]，用来保证 MAX_LAG_MS。 */
  marks: Array<[number, number]>;
  /** 上一帧时间。 */
  last: number;
  /** 最近一次收到 delta 的时间（用于识别连续均匀小包直通模式）。 */
  lastReceiveAt?: number;
  /** 连续收到小增量、低间隔流式包的次数。 */
  smoothStreak?: number;
};

/** 挂载时已有的内容（历史消息、刷新后）直接整段显示，不重放打字效果。 */
export function initialReveal(text: string, now: number): RevealState {
  return {
    target: text,
    pos: text.length,
    cut: text.length,
    marks: [],
    last: now,
    lastReceiveAt: now,
    smoothStreak: 0,
  };
}

/** 收到新内容。返回新的状态（不改旧对象）。 */
export function receive(
  state: RevealState,
  text: string,
  now: number,
): RevealState {
  if (text === state.target) return state;
  if (!text.startsWith(state.target)) {
    // 不是延续（重新生成、内容被替换）：不做动画，直接整段。
    return initialReveal(text, now);
  }
  const deltaLen = text.length - state.target.length;
  const gap =
    state.lastReceiveAt !== undefined
      ? now - state.lastReceiveAt
      : Number.POSITIVE_INFINITY;
  const smoothStreak =
    deltaLen <= 8 && gap < 80 ? (state.smoothStreak ?? 0) + 1 : 0;
  // 上游已经是高频小包平滑流时直接 0ms 贴合，不再人为滞后一帧以上。
  if (smoothStreak >= 2) {
    return {
      target: text,
      pos: text.length,
      cut: text.length,
      marks: [],
      last: now,
      lastReceiveAt: now,
      smoothStreak,
    };
  }
  const caughtUp = state.cut >= state.target.length;
  return {
    target: text,
    pos: Math.min(state.pos, text.length),
    cut: Math.min(state.cut, text.length),
    marks: [...state.marks, [text.length, now]],
    // 之前已经追平：从现在开始计时，免得空闲那段时间被算成一大步。
    last: caughtUp ? now : state.last,
    lastReceiveAt: now,
    smoothStreak,
  };
}

/** 往前走一帧。 */
export function step(state: RevealState, now: number): RevealState {
  const len = state.target.length;
  if (state.cut >= len)
    return state.last === now
      ? state
      : { ...state, pos: len, last: now, marks: [] };
  const dt = Math.max(0, Math.min(now - state.last, 100));
  const backlog = len - state.pos;
  const perMs = Math.max(backlog / TAU_MS, MIN_CPS / 1000);
  let pos = Math.min(len, state.pos + perMs * dt);
  // 硬上限：MAX_LAG_MS 之前收到的内容此刻必须全部显示。
  let floor = 0;
  const marks = state.marks.filter(([l, at]) => {
    if (now - at >= MAX_LAG_MS) {
      floor = Math.max(floor, l);
      return false;
    }
    return true;
  });
  pos = Math.max(pos, floor);
  const cut = Math.max(state.cut, snapCut(state.target, Math.floor(pos)));
  return {
    target: state.target,
    pos: Math.max(pos, Math.min(cut, len)),
    cut,
    marks,
    last: now,
    lastReceiveAt: state.lastReceiveAt,
    smoothStreak: state.smoothStreak,
  };
}

/** 是否还有没放出来的字。 */
export function pending(state: RevealState): boolean {
  return state.cut < state.target.length;
}

/** Markdown 里单独出现会被画成别的样子的记号字符。 */
const SYNTAX = new Set([
  "*",
  "_",
  "~",
  "`",
  "#",
  ">",
  "-",
  "+",
  "|",
  "[",
  "]",
  "(",
  ")",
  "!",
  "\\",
  "=",
  "<",
  "&",
  ":",
]);
/** 行首的块记号：列表、标题、引用、有序列表、代码围栏、表格行。 */
const LINE_MARKER =
  /^[ \t]*(?:[-*+>|]+|#{1,6}|\d{1,3}[.)]?|`{1,3}\w*|~{1,3})[ \t]?$/;

/**
 * 把切口挪到一个「画出来不会变样」的位置（只往后挪，最多 24 个字符）：
 *  - 不拆开代理对（emoji、生僻字）；
 *  - 行首记号（「- 」「1. 」「## 」「> 」「```ts」）连同后面第一个正文字一起放出；
 *  - 行内记号（「**」「`」「[」「](」等）连同后面紧跟的一个字一起放出。
 */
export function snapCut(text: string, cut: number): number {
  const len = text.length;
  if (cut <= 0) return 0;
  if (cut >= len) return len;
  const limit = Math.min(len, cut + 24);
  const lineStart = text.lastIndexOf("\n", cut - 1) + 1;
  let c = cut;
  // 行首记号：放到记号后面的第一个正文字。
  if (LINE_MARKER.test(text.slice(lineStart, c))) {
    while (c < limit && LINE_MARKER.test(text.slice(lineStart, c + 1))) c++;
    // 记号后再带上一个正文字（如果已经收到）。
    if (c < limit && text[c] !== "\n") c++;
  }
  // 行内记号：结尾是记号字符（或「记号+空格」）就再往后带。
  while (c < limit) {
    const prev = text.charAt(c - 1);
    if (
      SYNTAX.has(prev) ||
      (prev === " " &&
        c >= 2 &&
        SYNTAX.has(text.charAt(c - 2)) &&
        c - 1 > lineStart)
    )
      c++;
    else break;
  }
  // 不拆开代理对。
  if (c < len) {
    const code = text.charCodeAt(c - 1);
    if (code >= 0xd800 && code <= 0xdbff) c++;
  }
  return Math.min(c, len);
}
