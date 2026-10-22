/**
 * 每个机器人 / 每段对话「我的操作状态」（DESIGN.md §88）。
 *
 * 用户反馈：在一个机器人里把右栏切到「计算机」，去设置 / Claude Code / 别的机器人转一圈回来，又变回「面板」；
 * 写了一半的话、往上翻到的位置、点开的干活卡也都没了。这里把这些记下来：
 *
 * - 按机器人（bot id）：右栏是「面板」还是「计算机」、右栏展开 / 收起、右栏宽度。
 * - 按对话（channel id）：输入框里的草稿（prompt-area 的分段，含 @ / 命令小块）、滚动位置（不在底部时记
 *   第一条看得见的消息和它离顶边多远；在底部时记「在底部」和底下留的空白）、这段对话属于哪个机器人。
 * - 按一轮（干活卡的 turnKey）：干活卡点开了没有、这一轮干了多少秒。
 *
 * 内存里一份（切换时同步读，第一帧就是对的，不闪），写的时候合并 150ms 再落到 localStorage（刷新、重开客户端
 * 还在）。过期：机器人 30 天、草稿 7 天、滚动位置 1 天、干活卡 30 天；条数也有上限，最旧的先丢。
 * 附件（File）只在内存里（`stashDraftFiles`），刷新就没了——文件不往 localStorage 里塞。
 *
 * 只在这台设备、这个浏览器里，不上传，不跨设备。
 */

export const UI_MEMORY_KEY = "chisabot-ui-memory:v1";

const DAY = 24 * 60 * 60 * 1000;
export const BOT_TTL_MS = 30 * DAY;
export const DRAFT_TTL_MS = 7 * DAY;
export const SCROLL_TTL_MS = DAY;
export const WORK_TTL_MS = 30 * DAY;
const MAX_BOTS = 60;
const MAX_THREADS = 80;
const MAX_WORK = 400;
const WRITE_DELAY_MS = 150;

export type BotUi = {
  /** 右栏选的是「计算机」。 */
  computer?: boolean;
  /** 宽窗口右栏展开 / 收起。 */
  railOpen?: boolean;
  /** 宽窗口右栏宽度（px）。 */
  railWidth?: number;
  at: number;
};

export type ScrollMemo = {
  /** 离开时在底部（离底部 ≤ 4px）。 */
  atBottom: boolean;
  /** 在底部时，最后一条下面留的空白（新一轮对齐到顶上时的留白），回来时照样留，画面一模一样。 */
  spacer: number;
  /** 不在底部时：第一条看得见的消息（data-message-id）。 */
  anchor: string | null;
  /** 它的上边离聊天区顶边多少 px（可以是负的：上半截已经滚出去了）。 */
  offset: number;
  at: number;
};

export type ThreadUi = {
  /** 这段对话属于哪个机器人（刷新时对话详情还没读到，先用它把右栏画对）。 */
  agent?: string;
  /** prompt-area 的分段（JSON 原样）；空草稿不存。 */
  draft?: unknown[];
  draftAt?: number;
  scroll?: ScrollMemo;
  /**
   * 最后发出去的那句话（纯文本）和时间。发送失败时输入框会把字放回去（重试用），那份不当草稿记；
   * 记下的草稿和它一样也不放回——已经发出去的话不会「复活」在输入框里（§88.4）。
   */
  sent?: string;
  sentAt?: number;
  at: number;
};

export type WorkUi = { open?: boolean; seconds?: number; at: number };

type Store = {
  bots: Record<string, BotUi>;
  threads: Record<string, ThreadUi>;
  work: Record<string, WorkUi>;
};

let store: Store | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function now(): number {
  return Date.now();
}

function empty(): Store {
  return { bots: {}, threads: {}, work: {} };
}

/** 去掉过期的、超出条数的（最旧的先丢）。 */
function prune(s: Store, at = now()): Store {
  const keep = <T extends { at: number }>(rec: Record<string, T>, ttl: number, max: number, fix?: (v: T) => T | null) => {
    const rows = Object.entries(rec)
      .map(([k, v]) => [k, fix ? fix(v) : v] as const)
      .filter((row): row is readonly [string, T] => row[1] !== null && typeof row[1] === "object" && at - row[1].at <= ttl)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, max);
    return Object.fromEntries(rows) as Record<string, T>;
  };
  return {
    bots: keep(s.bots ?? {}, BOT_TTL_MS, MAX_BOTS),
    threads: keep(s.threads ?? {}, Math.max(DRAFT_TTL_MS, BOT_TTL_MS), MAX_THREADS, (t) => {
      const next: ThreadUi = { ...t };
      if (next.draft && at - (next.draftAt ?? next.at) > DRAFT_TTL_MS) {
        delete next.draft;
        delete next.draftAt;
      }
      if (next.scroll && at - next.scroll.at > SCROLL_TTL_MS) delete next.scroll;
      return next;
    }),
    work: keep(s.work ?? {}, WORK_TTL_MS, MAX_WORK),
  };
}

function load(): Store {
  if (store) return store;
  let parsed: Store = empty();
  const raw = (() => {
    try {
      return storage()?.getItem(UI_MEMORY_KEY) ?? null;
    } catch {
      return null;
    }
  })();
  if (raw) {
    try {
      const value = JSON.parse(raw) as Partial<Store>;
      if (value && typeof value === "object") parsed = { ...empty(), ...value } as Store;
    } catch {
      parsed = empty();
    }
  }
  store = prune(parsed);
  if (!listening && typeof window !== "undefined") {
    listening = true;
    // 刷新 / 关窗口前把还没落盘的写进去。
    window.addEventListener("pagehide", flushUiMemory);
  }
  return store;
}

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(flushUiMemory, WRITE_DELAY_MS);
}

/** 立刻写进 localStorage（离开页面时、测试里）。 */
export function flushUiMemory(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (!store) return;
  try {
    storage()?.setItem(UI_MEMORY_KEY, JSON.stringify(prune(store)));
  } catch {
    // 无痕模式 / 存满：内存里那份照样管用到这次关掉为止。
  }
}

/** Tests only：忘掉内存里的一份（下次从 localStorage 重新读）。 */
export function resetUiMemory(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  store = null;
  draftFiles.clear();
}

export function botUi(botId: string | undefined): BotUi | undefined {
  if (!botId) return undefined;
  return load().bots[botId];
}

export function setBotUi(botId: string | undefined, patch: Partial<Omit<BotUi, "at">>): void {
  if (!botId) return;
  const s = load();
  const prev = s.bots[botId];
  const next = { ...prev, ...patch, at: now() };
  if (prev && Object.entries(patch).every(([k, v]) => prev[k as keyof BotUi] === v)) {
    prev.at = next.at;
  } else {
    s.bots[botId] = next;
  }
  schedule();
}

export function threadUi(threadKey: string | undefined): ThreadUi | undefined {
  if (!threadKey) return undefined;
  const t = load().threads[threadKey];
  if (!t) return undefined;
  const at = now();
  // 读的时候也按各自的有效期挡一下（内存里那份可能放了很久）。
  if ((t.draft && at - (t.draftAt ?? t.at) > DRAFT_TTL_MS) || (t.scroll && at - t.scroll.at > SCROLL_TTL_MS)) {
    const fixed = prune({ bots: {}, threads: { [threadKey]: t }, work: {} }, at).threads[threadKey];
    if (fixed) load().threads[threadKey] = fixed;
    return fixed;
  }
  return t;
}

export function setThreadUi(threadKey: string | undefined, patch: Partial<Omit<ThreadUi, "at">>): void {
  if (!threadKey) return;
  const s = load();
  const next: ThreadUi = { ...s.threads[threadKey], ...patch, at: now() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key as keyof ThreadUi];
  }
  if ("draft" in patch) {
    if (patch.draft === undefined) delete next.draftAt;
    else next.draftAt = next.at;
  }
  s.threads[threadKey] = next;
  schedule();
}

/** 发出去的话多久之内算「刚发过」（不当草稿记、不放回）。 */
export const SENT_GUARD_MS = DAY;

/** 这句话刚发出去过（和记下的「最后发出去的那句」一样，且在 SENT_GUARD_MS 之内）。 */
export function wasJustSent(threadKey: string | undefined, text: string): boolean {
  const t = threadUi(threadKey);
  const trimmed = text.trim();
  return Boolean(trimmed && t?.sent !== undefined && t.sent === trimmed && now() - (t.sentAt ?? 0) < SENT_GUARD_MS);
}

/** 发出去了：草稿清掉，记下这句（§88.4）。 */
export function markDraftSent(threadKey: string | undefined, text: string): void {
  if (!threadKey) return;
  setThreadUi(threadKey, { draft: undefined, sent: text.trim(), sentAt: now() });
}

/**
 * 这段对话记下的草稿（prompt-area 分段），只放回结构对的；和刚发出去的那句一模一样的不放回。
 * `plain` 把分段变回纯文本（和发送时同一个算法）。
 */
export function rememberedDraft<T>(
  threadKey: string | undefined,
  isSegment: (value: unknown) => value is T,
  plain?: (segments: T[]) => string,
): T[] | null {
  const draft = threadUi(threadKey)?.draft;
  if (!Array.isArray(draft) || draft.length === 0) return null;
  if (!draft.every(isSegment)) return null;
  if (plain && wasJustSent(threadKey, plain(draft as T[]))) {
    setThreadUi(threadKey, { draft: undefined });
    return null;
  }
  return draft as T[];
}

export function workUi(turnKey: string): WorkUi | undefined {
  return load().work[turnKey];
}

export function setWorkUi(turnKey: string, patch: Partial<Omit<WorkUi, "at">>): void {
  if (!turnKey) return;
  const s = load();
  const prev = s.work[turnKey];
  if (prev && Object.entries(patch).every(([k, v]) => prev[k as keyof WorkUi] === v)) return;
  s.work[turnKey] = { ...prev, ...patch, at: now() };
  schedule();
}

/*
 * 附件：输入框里已经选好的文件。只在内存里（刷新就没了）。离开对话时放进来，回来时重新上传一遍
 * （服务器上原来那几行在离开时交还，见 composer.tsx）。
 */
const draftFiles = new Map<string, File[]>();
const MAX_DRAFT_FILE_THREADS = 12;

export function stashDraftFiles(threadKey: string | undefined, files: readonly File[]): void {
  if (!threadKey) return;
  draftFiles.delete(threadKey);
  if (files.length === 0) return;
  draftFiles.set(threadKey, [...files]);
  while (draftFiles.size > MAX_DRAFT_FILE_THREADS) {
    const oldest = draftFiles.keys().next().value;
    if (oldest === undefined) break;
    draftFiles.delete(oldest);
  }
}

/** 取走（取一次就没了）。 */
export function takeDraftFiles(threadKey: string | undefined): File[] {
  if (!threadKey) return [];
  const files = draftFiles.get(threadKey) ?? [];
  draftFiles.delete(threadKey);
  return files;
}

/**
 * 收了几个「离开对话时收起来、还没发出去」的附件。这些同样只在内存里——在别的页面点「有新版本，点此刷新」
 * 一样会丢，所以 `lib/activity.ts` 把它也算进刷新前的那道确认。
 */
export function stashedAttachmentCount(): number {
  let total = 0;
  for (const files of draftFiles.values()) total += files.length;
  return total;
}

