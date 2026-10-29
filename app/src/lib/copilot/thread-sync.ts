import type { Message } from "@ag-ui/core";

/**
 * 同步服务器存的对话记录时的增量合并（配合服务器 GET …/threads/:id/messages?since=&cursor=）。
 *
 * 上一次同步后记下服务器给的 version / cursor 和当时放进去的那组消息对象（applied）。
 * 本地消息还是同一组对象（逐个引用相同）时才带着它们去问：没变就只回 unchanged，
 * 变了只回 cursor 之后的尾部；本地被别处改过（流式、发送、别的同步）就不带，拿整份重新对。
 * 判断变化只看 cursor 之后的那几条（id + content），不再把两份完整对话转成字符串比。
 */
export type ThreadSync = {
  version: string;
  cursor: string;
  applied: readonly Message[];
};

export type MergeResult = {
  /** 需要 setMessages 的新列表；没变化时是 null（不触发任何更新）。 */
  next: Message[] | null;
  /** 下一次同步的基准；服务器没给版本（旧服务器）时为 null，下次照旧拿整份。 */
  version: string | null;
  cursor: string | null;
};

/** 本地消息还是上次同步放进去的那组对象。 */
export function untouchedSince(
  current: readonly Message[],
  sync: ThreadSync | null,
): sync is ThreadSync {
  if (!sync || current.length !== sync.applied.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== sync.applied[index]) return false;
  }
  return true;
}

/** 下一次拉取的查询串。 */
export function syncQuery(
  current: readonly Message[],
  sync: ThreadSync | null,
): string {
  const params = new URLSearchParams();
  if (untouchedSince(current, sync)) {
    params.set("since", sync.version);
    params.set("cursor", sync.cursor);
  } else {
    params.set("since", "");
  }
  return params.toString();
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const message = value as { id?: unknown; role?: unknown };
  return typeof message.id === "string" && typeof message.role === "string";
}

function sameContent(a: Message, b: Message): boolean {
  if (a === b) return true;
  if (a.id !== b.id) return false;
  const left = (a as { content?: unknown }).content;
  const right = (b as { content?: unknown }).content;
  if (left === right) return true;
  if (typeof left === "string" || typeof right === "string") return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 从 from 起逐条比 id + content；条数不同就是变了。 */
export function messagesChanged(
  current: readonly Message[],
  next: readonly Message[],
  from = 0,
): boolean {
  if (current.length !== next.length) return true;
  for (let index = from; index < next.length; index += 1) {
    const left = current[index];
    const right = next[index];
    if (!left || !right || !sameContent(left, right)) return true;
  }
  return false;
}

/**
 * 把服务器的回答并进当前消息。返回 null 表示这份回答用不上（格式不对，或它基于的那组本地消息已经被改过），
 * 调用方应丢掉同步基准、下次拿整份。
 */
export function mergeServerMessages(
  current: readonly Message[],
  sync: ThreadSync | null,
  body: unknown,
): MergeResult | null {
  if (!body || typeof body !== "object") return null;
  const answer = body as {
    messages?: unknown;
    unchanged?: unknown;
    version?: unknown;
    cursor?: unknown;
    start?: unknown;
  };
  const versioned =
    typeof answer.version === "string" && typeof answer.cursor === "string";
  const version = versioned ? (answer.version as string) : null;
  const cursor = versioned ? (answer.cursor as string) : null;
  const base = untouchedSince(current, sync);
  if (answer.unchanged === true)
    return base && versioned ? { next: null, version, cursor } : null;
  if (!Array.isArray(answer.messages) || !answer.messages.every(isMessage))
    return null;
  const incoming = answer.messages as Message[];
  const start = answer.start === undefined ? 0 : answer.start;
  if (typeof start !== "number" || !Number.isInteger(start) || start < 0)
    return null;
  if (start > 0 && (!base || start > current.length)) return null;
  const next = start > 0 ? current.slice(0, start).concat(incoming) : incoming;
  if (!messagesChanged(current, next, start))
    return { next: null, version, cursor };
  return { next, version, cursor };
}

/**
 * 存储读（`readThreadMessages`、对话顺序核对）的增量基准：服务器上次原样发来的行（未解析）和它的
 * version / cursor。和上面的 ThreadSync 不同，这里的基准是「服务器那份」的本地副本，与 agent 里的消息无关。
 */
export type StoredSync = {
  version: string;
  cursor: string;
  rows: readonly unknown[];
};

export type StoredAnswer = {
  /** 服务器当前的整份原始行（没变时就是基准里那同一个数组）。 */
  rows: readonly unknown[];
  unchanged: boolean;
  version: string | null;
  cursor: string | null;
};

/** 把服务器对 since/cursor 的回答并回整份原始行；回答用不上（格式不对、基准对不上）时返回 null。 */
export function applyStoredAnswer(
  base: StoredSync | null,
  body: unknown,
): StoredAnswer | null {
  if (!body || typeof body !== "object") return null;
  const answer = body as {
    messages?: unknown;
    unchanged?: unknown;
    version?: unknown;
    cursor?: unknown;
    start?: unknown;
  };
  const version = typeof answer.version === "string" ? answer.version : null;
  const cursor = typeof answer.cursor === "string" ? answer.cursor : null;
  if (answer.unchanged === true)
    return base && version && cursor
      ? { rows: base.rows, unchanged: true, version, cursor }
      : null;
  if (!Array.isArray(answer.messages)) return null;
  const start = answer.start === undefined ? 0 : answer.start;
  if (typeof start !== "number" || !Number.isInteger(start) || start < 0)
    return null;
  if (start > 0 && (!base || start > base.rows.length)) return null;
  const rows =
    start > 0 && base
      ? base.rows.slice(0, start).concat(answer.messages)
      : answer.messages;
  return { rows, unchanged: false, version, cursor };
}
