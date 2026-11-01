/**
 * 长对话虚拟化（jank P3-3）的纯逻辑：哪些行进虚拟列表、哪些常驻末尾、什么时候开 shift、
 * 行高缓存按会话 key + 消息 id 管、应用内搜索的命中。都是纯函数 / 小容器，单测直接喂。
 */

/** 末尾常驻的行数：流式中的回答、刚发的那条都在这里，不进虚拟列表（FIX-PLAN §8「流式尾部」N=3）。 */
export const VIRTUAL_TAIL_ROWS = 3;

/** 虚拟列表上下各多画多少像素（约一屏）。 */
export const VIRTUAL_BUFFER_PX = 900;

/** 前 `head` 行进虚拟列表，后面的常驻。行数不够时全部常驻。 */
export function splitVirtualTail(total: number, tail = VIRTUAL_TAIL_ROWS) {
  const head = Math.max(0, total - Math.max(0, tail));
  return { head, tail: total - head };
}

/**
 * 这一次的变化是不是「前插历史」：旧的第一行还在，但不在第 0 位了，且它后面的顺序没乱。
 * 是的话 virtua 开 `shift`，视口内容不动（取代 tail-first 的 scrollHeight 补偿）。
 * 追加（第一行没变）、换对话（旧第一行不在了）都不算。
 */
export function isPrepend(
  previousIds: readonly string[],
  nextIds: readonly string[],
): boolean {
  const first = previousIds[0];
  if (first === undefined || nextIds.length <= previousIds.length) return false;
  const at = nextIds.indexOf(first);
  if (at <= 0) return false;
  // 只比较开头几行就够判断「整段往后挪了」，避免长对话每次 O(n) 全比。
  const span = Math.min(previousIds.length, 8);
  for (let i = 0; i < span; i++) {
    if (nextIds[at + i] !== previousIds[i]) return false;
  }
  return true;
}

/**
 * 行高缓存（按会话 key 管、按消息 id 认）。
 *
 * virtua 自己的 CacheSnapshot 是按下标存的，所以这里存「快照 + 当时那串 id」：
 * 切回同一段对话时，只要那串 id 还是现在的前缀（中间没插、没删，只在后面追加），就原样交回去，
 * 实测过的行高直接复用、不重新估；对不上就丢掉（宁可重新量，也不能把 A 的高度安到 B 上）。
 * 另外按 id 记一份最近一次量到的高度（`heightOf`），给搜索跳转估位置、以后接 useKeptSlot 用。
 *
 * 只留最近 `limit` 个会话（默认 8，比 KeepAlive 的 4 多一点），超了丢最久没用的；
 * KeepAlive 卸载一个会话时调 `release(key)` 马上释放。
 */
export class TranscriptSizeCache<Snapshot> {
  private entries = new Map<
    string,
    { ids: readonly string[]; snapshot: Snapshot; heights: Map<string, number> }
  >();
  constructor(private readonly limit = 8) {}

  save(
    key: string,
    ids: readonly string[],
    snapshot: Snapshot,
    sizeAt?: (index: number) => number,
  ) {
    const heights = new Map<string, number>();
    if (sizeAt) {
      for (let i = 0; i < ids.length; i++) {
        const h = sizeAt(i);
        if (h > 0) heights.set(ids[i] as string, h);
      }
    }
    this.entries.delete(key);
    this.entries.set(key, { ids: [...ids], snapshot, heights });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** 存下的那串 id 是现在的前缀才交回快照。 */
  restore(key: string, ids: readonly string[]): Snapshot | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.ids.length === 0 || entry.ids.length > ids.length)
      return undefined;
    for (let i = 0; i < entry.ids.length; i++) {
      if (entry.ids[i] !== ids[i]) return undefined;
    }
    // 访问即续命（LRU）。
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.snapshot;
  }

  heightOf(key: string, id: string): number | undefined {
    return this.entries.get(key)?.heights.get(id);
  }

  release(key: string) {
    this.entries.delete(key);
  }

  get size() {
    return this.entries.size;
  }
}

/** 应用内搜索（Ctrl+F）：在数据里找，不在 DOM 里找——没挂上的行也能命中。返回命中行 id（旧→新）。 */
export function findTranscriptMatches<Row extends { id: string }>(
  rows: readonly Row[],
  query: string,
  textOf: (row: Row) => string | null,
): string[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const hits: string[] = [];
  for (const row of rows) {
    const text = textOf(row);
    if (text?.toLocaleLowerCase().includes(q)) hits.push(row.id);
  }
  return hits;
}

/** 上一个 / 下一个，首尾循环。 */
export function stepMatch(current: number, count: number, delta: 1 | -1) {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/**
 * `?message=` 定位（MessageFind）在 DOM 里找不到那一行时发这个事件：虚拟化下那一行可能只是没挂上，
 * transcript 收到后经数据层滚过去，MessageFind 下一次重试就能找到。flag 关着时没人听，等于没发。
 */
export const REVEAL_MESSAGE_EVENT = "chisabot:transcript-reveal";
