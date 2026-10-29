import { setThreadUi, stashDraftFiles, threadUi } from "@/lib/chat/ui-memory";
import { tryClient } from "@/lib/client";

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
 */

const STORAGE_KEY = "chisabot-draft-channels:v1";

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
  } catch {
    // 没有 sessionStorage 的环境。
  }
}
