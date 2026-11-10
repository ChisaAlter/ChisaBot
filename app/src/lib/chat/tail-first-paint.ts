/**
 * CB-025 / PRD-P2-03：长对话首屏先挂最后一屏，再分批补上面的历史。
 *
 * 不做真正的虚拟列表（§35 不跳版与 message-scroller 按位置找新行），也不再用
 * `content-visibility`（perf/cb-025-cv 实测无收益且引入跳版）。这里只推迟 React 挂载与
 * Markdown 解析：打开时只画尾巴，rAF 分批往前补，补到 TAIL_FIRST_CAP 为止。
 *
 * 再往上的历史不自动挂：DOM 随历史线性变大，切频道、改窗口宽度（每跨一个 CSS 断点整页重算
 * 样式）、滚动都跟着变慢（240 条的对话约 9000 个元素）。人往上滚到顶附近时照旧分批往前挂；
 * 要跳到某条消息（`?message=`、活动记录里的「在对话里看这一步」）或要恢复上次停在中间的位置时，
 * 由调用方要求全部挂上（MOUNT_ALL_HISTORY_EVENT / mountAll）。
 */

/** 超过这个条数才启用尾屏优先（短对话全挂更简单）。 */
export const TAIL_FIRST_THRESHOLD = 48;

/** 首屏至少挂多少条（约两屏，含 peek）。 */
export const TAIL_FIRST_INITIAL = 36;

/**
 * 每批往前补的最少条数。批次随已挂条数增长（翻倍，封顶 TAIL_FIRST_BATCH_MAX），
 * 400 条从 13 批降到 6 批（上限 100 时 400 条约 6 批）：每批一次提交、一次样式重算（jank P1-2）。
 */
export const TAIL_FIRST_BATCH = 40;

/**
 * 单批上限：再大一批的 React 提交本身就成了长任务。160 时 switch 场景最长单任务
 * 比 main 还长（736→821 / 787→1051ms），降到 100（120 / 80 都试过，见 DEVLOG）。按耗时自适应（一帧预算）在 4x 下会一直缩到 40、
 * 批数变多，样式收益掉光，所以用固定上限；同时补行那一批不再被强制同步布局（见 TAIL_BACKFILL_ATTR）。
 */
export const TAIL_FIRST_BATCH_MAX = 100;

/**
 * 补行那一次提交期间挂在滚动视口上的属性（只在有原生 overflow-anchor 时）。提交后的微任务里
 * 跑的 MutationObserver（chat-transcript 的贴底、message-scroller 的 handleContentChange）看到它就
 * 不当场读布局：位置由原生锚定保住，高度变化交给布局之后的 ResizeObserver。
 */
export const TAIL_BACKFILL_ATTR = "data-tail-backfill";

/** `node` 在一次尾屏补行的提交里（视口上挂着 TAIL_BACKFILL_ATTR）。 */
export function isTailBackfill(node: Element | null | undefined): boolean {
  return !!node?.closest(`[${TAIL_BACKFILL_ATTR}]`);
}

/** 批大小：随已挂条数增长，夹在 [BATCH, BATCH_MAX]。 */
export function batchSizeFor(mounted: number): number {
  const m = Math.max(0, Math.floor(mounted));
  return Math.min(TAIL_FIRST_BATCH_MAX, Math.max(TAIL_FIRST_BATCH, m));
}

/** 自动往前补到这么多条为止（超过阈值的长对话）；再往上的历史靠上滚或「全部挂上」。 */
export const TAIL_FIRST_CAP = 96;

/**
 * 要求这段对话把全部历史挂上。派发在滚动容器（`[data-slot="message-scroller-viewport"]`）上，
 * 幂等：已经全挂了就什么也不做。找不到目标行的跳转（MessageFind）发它，再靠自己的轮询找到行。
 */
export const MOUNT_ALL_HISTORY_EVENT = "chisabot:mount-all-history";

/**
 * 主动补行（「显示更早的消息」）恢复锚点时，底下不够滚（内容原本不够一屏，正在看的行在视口上半截）：
 * 浏览器把 scrollTop 夹在最底，正在看的行被拽到视口底部（QA #519 r2 P2-1：偏 408px）。
 * 派发在滚动容器上，`detail` 是还差的像素；谁在最后一条下面管留白（SettleAtEnd）就垫这么多并
 * `preventDefault()`，补行的一方再恢复一次锚点。没人接（没有留白）就保持原样。
 */
export const TAIL_ANCHOR_SLACK_EVENT = "chisabot:tail-anchor-slack";

/** 自动补到多少条：封顶，除非要全部（跳转 / 恢复位置）。 */
export function catchUpTarget(total: number, full: boolean): number {
  const n = Math.max(0, Math.floor(total));
  return full ? n : Math.min(n, TAIL_FIRST_CAP);
}
export function initialMountedCount(total: number): number {
  const n = Math.max(0, Math.floor(total));
  if (n <= TAIL_FIRST_THRESHOLD) return n;
  return Math.min(n, TAIL_FIRST_INITIAL);
}

export function nextMountedCount(
  current: number,
  total: number,
  batch: number = batchSizeFor(current),
): number {
  const n = Math.max(0, Math.floor(total));
  const c = Math.max(0, Math.floor(current));
  if (c >= n) return n;
  return Math.min(n, c + batchSizeFor(batch));
}

/** `items.slice(start)` 的起点：始终贴着末尾。 */
export function mountStartIndex(total: number, mountedCount: number): number {
  const n = Math.max(0, Math.floor(total));
  const m = Math.max(0, Math.floor(mountedCount));
  return Math.max(0, n - Math.min(n, m));
}

/**
 * 列表变长（历史 prepend / 新消息）时怎么调窗口。
 * - 末尾追加：扩窗保留已挂行（短对话跨过阈值、历史还在补时也一样）。
 * - 前面补历史：已经全挂的长对话继续全挂；否则保持尾窗，新历史等下一轮 rAF。
 * - 变短（截断 / 重生成）：夹到新长度。
 */
export function reconcileMountedCount(
  previousTotal: number,
  nextTotal: number,
  mounted: number,
  appended = false,
): number {
  const prev = Math.max(0, Math.floor(previousTotal));
  const next = Math.max(0, Math.floor(nextTotal));
  const m = Math.max(0, Math.floor(mounted));
  if (next <= TAIL_FIRST_THRESHOLD) return next;
  if (next < prev) return Math.min(m, next);
  if (next > prev && appended) return Math.min(next, m + next - prev);
  // 短对话刚涨成长对话（接入快照 → 历史补上）：别一次全挂，保持尾窗。
  if (m >= prev && prev > TAIL_FIRST_THRESHOLD) return next;
  if (m >= prev) return initialMountedCount(next);
  return Math.min(m, next);
}

/** 粗算：从 initial 扩到 full 需要几步（给回归 / 微基准用）。 */
export function stepsToFullMount(total: number): number {
  let m = initialMountedCount(total);
  if (m >= total) return 0;
  let steps = 0;
  while (m < total) {
    m = nextMountedCount(m, total);
    steps += 1;
    if (steps > 10_000) break;
  }
  return steps;
}

/**
 * 尾窗按「看得见的行」计数（聊天记录消失，2026-11-10）。
 *
 * 过程行（设备工具、浏览步骤）默认不画，整格 `display: none`（见 HIDDEN_ACTIVITY_ROW）。以前窗口按条数数：
 * 一轮里调了几十次工具，尾巴 36 条、补到 96 条全是看不见的行，打开对话就是一片空白，内容不够高也滚不动，
 * 上面的历史补不出来。现在窗口的单位是「格」：看得见的一行算一格，看不见的行按 HIDDEN_ROW_WEIGHT 折算
 * （它们照样挂上——审批卡这类异步出现的东西由 CSS 自己露出来——只是便宜得多，实测挂一行约是正文的 1/7）。
 * 折算而不是算 0：一段几千次工具调用、几乎没有字的对话不会因此一次挂上几千行。
 */
export const HIDDEN_ROW_WEIGHT = 1 / 8;

/**
 * 每一格从哪一条开始（整段列表里的下标，升序）。从末尾往前累加权重，满一格记一次当前下标；
 * 看得见的行权重是 1，所以每个看得见的行都正好是某一格的起点，最上面不足一格的只可能是看不见的行。
 */
export function windowMarks(
  total: number,
  isVisible: (index: number) => boolean,
): number[] {
  const marks: number[] = [];
  let acc = 0;
  for (let i = Math.max(0, Math.floor(total)) - 1; i >= 0; i--) {
    acc += isVisible(i) ? 1 : HIDDEN_ROW_WEIGHT;
    if (acc >= 1 - 1e-9) {
      marks.push(i);
      acc = Math.max(0, acc - 1);
    }
  }
  return marks.reverse();
}

/**
 * 挂 `mounted` 格时的起点（整段列表里的下标）。`marks` 来自 windowMarks。
 * `pin`：这个下标往后的必须挂上（正在进行的这一轮：人发的那条 → 干活提示所在的行）。
 */
export function visibleWindowStart(
  total: number,
  marks: readonly number[],
  mounted: number,
  pin?: number,
): number {
  const n = Math.max(0, Math.floor(total));
  const m = Math.max(0, Math.floor(mounted));
  const start =
    m >= marks.length ? 0 : m <= 0 ? n : (marks[marks.length - m] ?? 0);
  if (pin === undefined || pin < 0) return start;
  return Math.max(0, Math.min(start, pin));
}

/**
 * 默认藏起来的过程行（和 styles.css 里那条规则同一个选择器）：工具 / 浏览那一格里只剩空 div、没有带 role 的元素。
 * 尾窗用它在 DOM 上兜底判断「挂着的行里一行看得见的都没有」。
 */
export const HIDDEN_ACTIVITY_ROW =
  '[data-row="activity"]:not(:has(:not(div))):not(:has([role]))';

/** 挂着的消息行里有没有看得见的（不是收起的过程行、不是 `data-folded` 的 0 高行）。选择器不支持 `:has` 时当看得见（那时规则本身也不生效）。 */
export function hasVisibleRow(root: ParentNode | null | undefined): boolean {
  if (!root) return true;
  const rows = root.querySelectorAll<HTMLElement>(
    '[data-slot="message-scroller-item"]',
  );
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.hasAttribute("data-folded")) continue;
    try {
      if (!row.matches(HIDDEN_ACTIVITY_ROW)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** 「显示更早的消息」补行前记下的锚：正在看的那一行，以及它相对视口顶的偏移。 */
export type ScrollAnchor = {
  id: string;
  node: HTMLElement;
  offset: number;
};

function rowIsHidden(row: HTMLElement): boolean {
  if (row.hasAttribute("data-folded")) return true;
  try {
    return row.matches(HIDDEN_ACTIVITY_ROW);
  } catch {
    return false;
  }
}

/**
 * 视口里正在看的那一行：第一条底边还在视口顶下面的可见消息行，以及它相对视口顶的偏移。
 * 给补行前用。scrollTop 为 0 时浏览器不做原生滚动锚定，必须靠这个在 layout 里同步恢复。
 */
export function captureScrollAnchor(
  viewport: HTMLElement,
): ScrollAnchor | null {
  const top = viewport.getBoundingClientRect().top;
  const rows = viewport.querySelectorAll<HTMLElement>(
    '[data-slot="message-scroller-item"]',
  );
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || rowIsHidden(row)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= top + 0.5) continue;
    return {
      id: row.getAttribute("data-message-id") ?? "",
      node: row,
      offset: rect.top - top,
    };
  }
  return null;
}

function findAnchorNode(
  viewport: HTMLElement,
  anchor: ScrollAnchor,
): HTMLElement | null {
  if (anchor.id) {
    try {
      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(anchor.id)
          : anchor.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const found = viewport.querySelector<HTMLElement>(
        `[data-message-id="${escaped}"]`,
      );
      if (found) return found;
    } catch {
      // 选择器写不出就退回节点引用
    }
  }
  return anchor.node.isConnected ? anchor.node : null;
}

/**
 * 恢复之后锚点行还比记下的位置低多少（px，>0）。只有底下不够滚、scrollTop 被夹住时才会是正数。
 */
export function anchorShortfall(
  viewport: HTMLElement,
  anchor: ScrollAnchor,
): number {
  const node = findAnchorNode(viewport, anchor);
  if (!node) return 0;
  const top = viewport.getBoundingClientRect().top;
  const short = node.getBoundingClientRect().top - top - anchor.offset;
  return short > 0.5 ? short : 0;
}

/** 请留白的一方在最后一条下面垫 `px`；有人接了返回 true。 */
export function requestAnchorSlack(viewport: HTMLElement, px: number): boolean {
  const event = new CustomEvent<number>(TAIL_ANCHOR_SLACK_EVENT, {
    cancelable: true,
    detail: px,
  });
  viewport.dispatchEvent(event);
  return event.defaultPrevented;
}

/** 立刻改 scrollTop，不走平滑滚动。 */
export function withoutSmoothScroll(
  viewport: HTMLElement,
  write: () => void,
): void {
  const behavior = viewport.style.scrollBehavior;
  viewport.style.scrollBehavior = "auto";
  write();
  viewport.style.scrollBehavior = behavior;
}

/**
 * 把锚点行移回捕获时的偏移。成功返回 true。必须在 layout effect 里同步调用，屏幕上才不会闪。
 */
export function restoreScrollAnchor(
  viewport: HTMLElement,
  anchor: ScrollAnchor,
): boolean {
  const node = findAnchorNode(viewport, anchor);
  if (!node) return false;
  const top = viewport.getBoundingClientRect().top;
  const current = node.getBoundingClientRect().top - top;
  const delta = current - anchor.offset;
  if (Math.abs(delta) < 0.5) return true;
  withoutSmoothScroll(viewport, () => {
    viewport.scrollTop += delta;
  });
  return true;
}
