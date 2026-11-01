import { setThreadUi, stashDraftFiles, threadUi } from "@/lib/chat/ui-memory";
import { ClientError, tryClient } from "@/lib/client";

/**
 * 新话题页上先加附件时提前建好的对话（A1）。
 *
 * `/channel/new` 还没有对话，附件没有地方上传，所以选文件、粘贴、拖入的那一刻先建一段**草稿对话**
 * （`POST /api/channels` 带 `draft: true`），把输入框里的字和这些文件交给它（`moveTextDraft` +
 * `stashDraftFiles`），再跳过去，那边的输入框自己放回来、开始上传。
 *
 * 草稿对话在服务端第一条消息记进来之前不进任何人的列表（`server/src/channels/routes.ts`
 * `DRAFT_AGENT_CHANNEL_DESCRIPTION`）。这里记着「哪几段是这台设备刚建的、还没发」：
 *
 * - 发出第一条（`settleDraftChannel`）就不再管它——那以后它是一段普通对话。
 * - 没发就离开（对话页卸载：换到别的对话、留着的页面超时）就立刻删掉（`releaseDraftChannel`）。删之前把写了
 *   一半的字放回新话题页，文件丢掉（它们只在内存里，服务器上的那几行由输入框离开时交还）。
 * - 关掉标签页、刷新后再离开：这里不知道了，对话留在服务器上，但仍然不在列表里，用户看不到。
 *
 * 记在 sessionStorage 里（只这一个标签页），刷新以后回到这段草稿、再离开时照样删。
 *
 * 什么时候算「离开」（二轮复审）：藏起来的对话页平时留 10 分钟（`KEPT_TTL_MS`）。草稿对话只有去新话题页
 * （`/channel/new`）时立即卸载回收——那边要接回写了一半的字；去设置等别的页面照常留着，回来图和上传都在
 * （`draftKeptTtl`）。换到别的对话时这一页本来就换掉了，照旧回收。
 *
 * 回收过的也记一笔（同样在 sessionStorage）：它属于哪个机器人。本标签页之后再打开它（后退、旧地址）拿到
 * 404 时，不显示「找不到这段对话」，静默换成这个机器人的新话题页（`releasedDraftRedirect`）。
 */

const STORAGE_KEY = "chisabot-draft-channels:v1";
/** 回收过的草稿：channel id → 机器人 id。 */
const RELEASED_KEY = "chisabot-released-drafts:v1";
/** 只记最近这么多段，够一个标签页用。 */
const MAX_RELEASED = 50;
/** 新话题页的地址：只有去这里时草稿对话藏起来就回收。 */
const NEW_TOPIC_PATH = "/channel/new";

/** channel id → 字放回到哪个草稿键（新话题页的 `new:<agent>`）。 */
let drafts: Map<string, string> | null = null;
/** 正挂着这段对话页面的数量（StrictMode 会挂两次）。 */
const holders = new Map<string, number>();

function load(): Map<string, string> {
  if (drafts) return drafts;
  drafts = new Map();
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, key] of Object.entries(parsed)) {
        if (typeof key === "string") drafts.set(id, key);
      }
    }
  } catch {
    // 读不出来就当没有：最坏是一段草稿没删，它照样不在列表里。
  }
  return drafts;
}

function save() {
  try {
    globalThis.sessionStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(load())),
    );
  } catch {
    // 存不下也照样在内存里管着。
  }
}

/** 刚建好的草稿对话；`returnKey` 是没发就离开时把字放回去的草稿键。 */
export function markDraftChannel(channelId: string, returnKey: string): void {
  load().set(channelId, returnKey);
  save();
}

export function isDraftChannel(channelId: string): boolean {
  return load().has(channelId);
}

/**
 * 藏起来的对话页留多久（外壳的 `KeepAliveStage`）：还没发过的草稿对话、而且是去新话题页，就是 0（立即卸载，
 * 随即回收）；其他情况都是 `keptTtlMs`（10 分钟），去设置再回来图和上传都还在。
 */
export function draftKeptTtl(
  channelId: string,
  pathname: string,
  keptTtlMs: number,
): number {
  return pathname === NEW_TOPIC_PATH && isDraftChannel(channelId)
    ? 0
    : keptTtlMs;
}

function readReleased(): Record<string, string> {
  try {
    const raw = globalThis.sessionStorage?.getItem(RELEASED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [id, agent] of Object.entries(parsed)) {
        if (typeof agent === "string" && agent) out[id] = agent;
      }
      return out;
    }
  } catch {
    // 读不出来就当没有：最坏是照旧显示「找不到这段对话」。
  }
  return {};
}

function rememberReleased(channelId: string, agentId: string) {
  const entries = Object.entries(readReleased()).filter(
    ([id]) => id !== channelId,
  );
  entries.push([channelId, agentId]);
  try {
    globalThis.sessionStorage?.setItem(
      RELEASED_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(-MAX_RELEASED))),
    );
  } catch {
    // 存不下：之后打开它照旧显示「找不到这段对话」。
  }
}

/** 本标签页回收过的这段草稿属于哪个机器人；没回收过就是 undefined。 */
export function releasedDraftAgent(channelId: string): string | undefined {
  return readReleased()[channelId];
}

/**
 * 打开一段对话失败时：是本标签页回收过的草稿、而且服务器说 404，就返回它的机器人 id（调用方用 replace 跳到
 * `/channel/new?agent=…&topic=new`）；其他情况（别的 404、别的错误）返回 null，照旧显示错误卡。
 */
export function releasedDraftRedirect(
  channelId: string,
  error: unknown,
): string | null {
  if (!(error instanceof ClientError) || error.status !== 404) return null;
  return releasedDraftAgent(channelId) ?? null;
}

/** 第一条消息发出去了：它是一段普通对话了，离开时不删。 */
export function settleDraftChannel(channelId: string): void {
  if (!load().delete(channelId)) return;
  save();
}

/** 把一个草稿键里写了一半的字挪到另一个键（新话题页 ↔ 草稿对话）。目标已经有字时不覆盖。 */
export function moveTextDraft(from: string, to: string): void {
  const draft = threadUi(from)?.draft;
  setThreadUi(from, { draft: undefined });
  if (!Array.isArray(draft) || draft.length === 0) return;
  if (threadUi(to)?.draft) return;
  setThreadUi(to, { draft });
}

/**
 * 新话题页挂上的那一刻（`channel/new.tsx`，在它的输入框读草稿之前）：本标签页还没发、字要回到 `returnKey` 的草稿
 * 对话，先把写了一半的字同步挪过去。
 *
 * 回归（#399）：去新话题页时，藏着的草稿对话页要等新话题页画完、`KeepAliveStage` 的 0ms 计时器到了才卸载，卸载收尾
 * （`holdDraftChannel`）再推迟一拍才 `releaseDraftChannel`。字在那时才挪回 `new:<agent>`，可新话题页的输入框只在
 * 挂载时读一次草稿、早已读到空值，于是一直空着，要去设置再回来（重新挂载）才出现。这里抢在输入框之前挪；之后的回收
 * 照旧删对话、丢文件，`moveTextDraft` 那边已经没有字，什么都不覆盖。
 *
 * 去新话题页时藏着的草稿对话一律立即回收（`draftKeptTtl`），提前挪字不会挪错；去的是别的机器人的新话题页时
 * `returnKey` 对不上，不动，回收时照旧回到原来的机器人。重复调用（StrictMode）是空操作。
 */
export function reclaimDraftText(returnKey: string): void {
  for (const [channelId, key] of load()) {
    if (key === returnKey) moveTextDraft(channelId, returnKey);
  }
}

/**
 * 对话页挂上了。返回卸载时调的函数：那时还是草稿（没发过），就删掉。
 *
 * 推迟一拍再判断：StrictMode 的「挂载 → 卸载 → 挂载」中间那次卸载不算离开；输入框自己的卸载收尾
 * （把文件收进 `stashDraftFiles`）也在同一次提交里，推迟一拍才能在它之后把文件清掉。
 */
export function holdDraftChannel(
  channelId: string,
  remove: (channelId: string) => Promise<unknown> = deleteChannel,
): () => void {
  holders.set(channelId, (holders.get(channelId) ?? 0) + 1);
  return () => {
    holders.set(channelId, (holders.get(channelId) ?? 1) - 1);
    setTimeout(() => {
      if ((holders.get(channelId) ?? 0) > 0) return;
      holders.delete(channelId);
      releaseDraftChannel(channelId, remove);
    }, 0);
  };
}

/** 没发就离开：删掉这段草稿对话，字放回新话题页，文件丢掉。不是草稿（或已经发过）就什么都不做。 */
export function releaseDraftChannel(
  channelId: string,
  remove: (channelId: string) => Promise<unknown> = deleteChannel,
): void {
  const returnKey = load().get(channelId);
  if (returnKey === undefined) return;
  load().delete(channelId);
  save();
  if (returnKey.startsWith("new:") && returnKey.length > 4)
    rememberReleased(channelId, returnKey.slice(4));
  moveTextDraft(channelId, returnKey);
  stashDraftFiles(channelId, []);
  void remove(channelId).catch(() => {
    // 删不掉也看不见：它没有消息，列表不列它。
  });
}

/**
 * 带条件的删除（`?draft=1`）：「是草稿」只记在这个标签页里，复制出来的标签页、或者机器人已经在里面说过话时，
 * 这里以为的草稿其实是真对话。服务端再确认一次，仍是空草稿才删，否则回 409、什么都不动（这里不管结果）。
 */
function deleteChannel(channelId: string) {
  return tryClient(`/api/channels/${encodeURIComponent(channelId)}?draft=1`, {
    method: "DELETE",
  });
}

/** 测试用：清空这台设备记着的草稿。 */
export function resetDraftChannelsForTest(): void {
  // 下次读的时候重新从 sessionStorage 读，和刷新后一样。
  drafts = null;
  holders.clear();
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
    globalThis.sessionStorage?.removeItem(RELEASED_KEY);
  } catch {
    // 没有 sessionStorage 的环境。
  }
}
