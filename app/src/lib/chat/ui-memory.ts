/**
 * 每个机器人 / 每段对话「我的操作状态」（DESIGN.md §88）。
 *
 * 用户反馈：在一个机器人里把右栏切到「计算机」，去设置 / 别的机器人转一圈回来，又变回「面板」；
 * 写了一半的话、往上翻到的位置、点开的干活卡也都没了。这里把这些记下来：
 *
 * - 按机器人（bot id）：右栏是「面板」还是「计算机」、右栏展开 / 收起、右栏宽度。
 * - 按对话（channel id）：输入框里的草稿（prompt-area 的分段，含 @ / 命令小块）、滚动位置（不在底部时记
 *   第一条看得见的消息和它离顶边多远；在底部时记「在底部」和底下留的空白）、这段对话属于哪个机器人。
 * - 按一轮（干活卡的 turnKey）：干活卡点开了没有、这一轮干了多少秒。
 *
 * 内存里一份（切换时同步读，第一帧就是对的，不闪），写的时候合并 150ms 再落到 localStorage（刷新、重开客户端
 * 还在）。过期：机器人 30 天、草稿 7 天、滚动位置 1 天、干活卡 30 天；条数也有上限，最旧的先丢。
 * 附件的路由交接先用内存，Composer 将已选文件按账号保存在 IndexedDB，不占 localStorage。
 *
 * 只在这台设备、这个浏览器里，不上传，不跨设备。
 */

import { toast } from "@/components/ui/toast";
import type { PanelLayout } from "@/lib/panels/panel-layout";
import type { ComposerQuotePayload } from "./quote-event";

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
  /**
   * 右栏面板的看板布局（2026-10-22）：哪两张并排、分隔条比例、拖高的卡片、折叠了哪些。
   * 结构见 `lib/panels/panel-layout.ts`；服务端只记面板的先后（position），这里记这个人的摆法。
   */
  panelLayout?: PanelLayout;
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
  quote?: ComposerQuotePayload;
  restoredSend?: {
    fullText: string;
    bodyText: string;
    quote: ComposerQuotePayload | null;
  };
  draftAt?: number;
  scroll?: ScrollMemo;
  /**
   * 已提交或尚待核对的消息和时间。明确拒收时只撤销对应标记；实际接纳的消息不能作为草稿复活。
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
  const keep = <T extends { at: number }>(
    rec: Record<string, T>,
    ttl: number,
    max: number,
    fix?: (v: T) => T | null,
  ) => {
    const rows = Object.entries(rec)
      .map(([k, v]) => [k, fix ? fix(v) : v] as const)
      .filter(
        (row): row is readonly [string, T] =>
          row[1] !== null &&
          typeof row[1] === "object" &&
          at - row[1].at <= ttl,
      )
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, max);
    return Object.fromEntries(rows) as Record<string, T>;
  };
  return {
    bots: keep(s.bots ?? {}, BOT_TTL_MS, MAX_BOTS),
    threads: keep(
      s.threads ?? {},
      Math.max(DRAFT_TTL_MS, BOT_TTL_MS),
      MAX_THREADS,
      (t) => {
        const next: ThreadUi = { ...t };
        if (
          (next.draft || next.quote || next.restoredSend) &&
          at - (next.draftAt ?? next.at) > DRAFT_TTL_MS
        ) {
          delete next.draft;
          delete next.quote;
          delete next.restoredSend;
          delete next.draftAt;
        }
        if (next.scroll && at - next.scroll.at > SCROLL_TTL_MS)
          delete next.scroll;
        return next;
      },
    ),
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
      if (value && typeof value === "object")
        parsed = { ...empty(), ...value } as Store;
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
  draftFileListeners.clear();
}

export function botUi(botId: string | undefined): BotUi | undefined {
  if (!botId) return undefined;
  return load().bots[botId];
}

export function setBotUi(
  botId: string | undefined,
  patch: Partial<Omit<BotUi, "at">>,
): void {
  if (!botId) return;
  const s = load();
  const prev = s.bots[botId];
  const next = { ...prev, ...patch, at: now() };
  if (
    prev &&
    Object.entries(patch).every(([k, v]) => prev[k as keyof BotUi] === v)
  ) {
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
  if (
    ((t.draft || t.quote || t.restoredSend) &&
      at - (t.draftAt ?? t.at) > DRAFT_TTL_MS) ||
    (t.scroll && at - t.scroll.at > SCROLL_TTL_MS)
  ) {
    const fixed = prune({ bots: {}, threads: { [threadKey]: t }, work: {} }, at)
      .threads[threadKey];
    if (fixed) load().threads[threadKey] = fixed;
    return fixed;
  }
  return t;
}

export function setThreadUi(
  threadKey: string | undefined,
  patch: Partial<Omit<ThreadUi, "at">>,
): void {
  if (!threadKey) return;
  const s = load();
  const next: ThreadUi = { ...s.threads[threadKey], ...patch, at: now() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key as keyof ThreadUi];
  }
  if ("draft" in patch || "quote" in patch) {
    if (next.draft === undefined && next.quote === undefined)
      delete next.draftAt;
    else next.draftAt = next.at;
  }
  s.threads[threadKey] = next;
  schedule();
}

/** 发出去的话多久之内算「刚发过」（不当草稿记、不放回）。 */
export const SENT_GUARD_MS = DAY;

/** 这句话刚发出去过（和记下的「最后发出去的那句」一样，且在 SENT_GUARD_MS 之内）。 */
export function wasJustSent(
  threadKey: string | undefined,
  text: string,
): boolean {
  const t = threadUi(threadKey);
  const trimmed = text.trim();
  return Boolean(
    trimmed &&
      t?.sent !== undefined &&
      t.sent === trimmed &&
      now() - (t.sentAt ?? 0) < SENT_GUARD_MS,
  );
}

/** 发出去了：草稿清掉，记下这句（§88.4）。 */
export function markDraftSent(
  threadKey: string | undefined,
  text: string,
): void {
  if (!threadKey) return;
  setThreadUi(threadKey, {
    draft: undefined,
    quote: undefined,
    restoredSend: undefined,
    sent: text.trim(),
    sentAt: now(),
  });
}

/** A confirmed refusal revokes only the marker for that submitted draft. */
export function markDraftRejected(
  threadKey: string | undefined,
  text: string,
): void {
  if (!threadKey || threadUi(threadKey)?.sent !== text.trim()) return;
  setThreadUi(threadKey, { sent: undefined, sentAt: undefined });
}

/*
 * 判过「没发出去」的发送事后对账发现这句其实落地了（channel-chat 的迟到对账）：
 * 失败时塞回输入框的草稿是多余的一份——消息在对话里、回答可能正在写，留着它一发就是重复。
 * 输入框只在「字还没被改过」时才收回去（composer.tsx）。
 */
const SEND_LANDED_EVENT = "chisabot-send-landed";
const DRAFT_FILES_ACCEPTED = "chisabot-draft-files-accepted";
export type DraftFileSubmission = { threadId: string; commandId?: string };
const draftFileSubmissions = new Set<
  (ids: readonly string[], submission: DraftFileSubmission) => Promise<void>
>();

export function attachmentIdsInContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const id = part?.metadata?.attachmentId;
    return typeof id === "string" ? [id] : [];
  });
}

/** A durable command or inbox now owns these uploads, including a lost event stream. */
export function draftFilesAccepted(content: unknown): void {
  const ids = attachmentIdsInContent(content);
  if (ids.length && typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent(DRAFT_FILES_ACCEPTED, { detail: ids }),
    );
}

export function listenDraftFilesAccepted(
  listener: (ids: readonly string[]) => void,
) {
  const receive = (event: Event) => {
    const ids = (event as CustomEvent<string[]>).detail;
    listener(ids);
  };
  window.addEventListener(DRAFT_FILES_ACCEPTED, receive);
  return () => window.removeEventListener(DRAFT_FILES_ACCEPTED, receive);
}

export function listenDraftFileSubmissions(
  listener: (
    ids: readonly string[],
    submission: DraftFileSubmission,
  ) => Promise<void>,
) {
  draftFileSubmissions.add(listener);
  return () => {
    draftFileSubmissions.delete(listener);
  };
}

/** Save references and the command receipt lookup before direct or queued admission begins. */
export async function draftFilesSubmitting(
  content: unknown,
  threadId: string,
  commandId?: string,
): Promise<void> {
  const ids = attachmentIdsInContent(content);
  if (ids.length)
    await Promise.all(
      [...draftFileSubmissions].map((save) =>
        save(ids, {
          threadId,
          ...(commandId ? { commandId } : {}),
        }),
      ),
    );
}

/** 按草稿键广播：这句其实发出去了。 */
export function sendLanded(threadKey: string, text: string): void {
  window.dispatchEvent(
    new CustomEvent(SEND_LANDED_EVENT, { detail: { threadKey, text } }),
  );
}

/** 挂着那个草稿键的输入框登记收听。返回注销函数。 */
export function listenSendLanded(
  threadKey: string,
  listener: (text: string) => void,
): () => void {
  const on = (event: Event) => {
    const detail = (event as CustomEvent<{ threadKey?: string; text?: string }>)
      .detail;
    if (detail?.threadKey === threadKey && typeof detail.text === "string")
      listener(detail.text);
  };
  window.addEventListener(SEND_LANDED_EVENT, on);
  return () => window.removeEventListener(SEND_LANDED_EVENT, on);
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

export function setWorkUi(
  turnKey: string,
  patch: Partial<Omit<WorkUi, "at">>,
): void {
  if (!turnKey) return;
  const s = load();
  const prev = s.work[turnKey];
  if (
    prev &&
    Object.entries(patch).every(([k, v]) => prev[k as keyof WorkUi] === v)
  )
    return;
  s.work[turnKey] = { ...prev, ...patch, at: now() };
  schedule();
}

/*
 * 附件的同步路由交接：新话题建好草稿对话后，把原始 File 交给目标 Composer。
 * Composer 另按账号 / 草稿保存到 IndexedDB，恢复时复用已有上传引用。
 */
const draftFiles = new Map<string, File[]>();
const MAX_DRAFT_FILE_THREADS = 12;
let draftFileAccount: string | null = null;

/** The authenticated route establishes the account before any Composer mounts. */
export function setDraftFileAccount(accountId: string | null): void {
  if (draftFileAccount === accountId) return;
  draftFileAccount = accountId;
  draftFiles.clear();
  draftFileListeners.clear();
}

export function currentDraftFileAccount(): string | null {
  return draftFileAccount;
}

export function stashDraftFiles(
  threadKey: string | undefined,
  files: readonly File[],
): void {
  if (!threadKey) return;
  draftFiles.delete(threadKey);
  if (files.length === 0) {
    const accountId = draftFileAccount;
    if (accountId)
      void import("./draft-attachment-store")
        .then(({ writeDraftAttachments }) =>
          writeDraftAttachments(accountId, threadKey, []),
        )
        .catch(() => {
          toast.error("未能清除本机的附件草稿，请检查浏览器存储空间。");
        });
    return;
  }
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

/** 正挂着的输入框（按草稿键）：后来追加的文件直接交给它。 */
const draftFileListeners = new Map<string, (files: File[]) => void>();

/**
 * 输入框挂着时登记：`addDraftFiles` 追加的文件直接交给它（放到输入框上、开始上传）。返回注销函数。
 */
export function listenDraftFiles(
  threadKey: string,
  listener: (files: File[]) => void,
): () => void {
  draftFileListeners.set(threadKey, listener);
  return () => {
    if (draftFileListeners.get(threadKey) === listener)
      draftFileListeners.delete(threadKey);
  };
}

/**
 * 追加文件（新话题页跳到草稿对话那一下里又加的，A1）：那边的输入框已经挂着就直接交给它，还没挂上就并进暂存，
 * 挂上时和前面的一起取走。
 */
export function addDraftFiles(
  threadKey: string | undefined,
  files: readonly File[],
): void {
  if (!threadKey || files.length === 0) return;
  const listener = draftFileListeners.get(threadKey);
  if (listener) {
    listener([...files]);
    return;
  }
  stashDraftFiles(threadKey, [...(draftFiles.get(threadKey) ?? []), ...files]);
}

/**
 * 路由交接中尚未被 Composer 接走的附件数；`lib/activity.ts` 将其计入刷新前的确认。
 */
export function stashedAttachmentCount(): number {
  let total = 0;
  for (const files of draftFiles.values()) total += files.length;
  return total;
}
