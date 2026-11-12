/**
 * 长对话接入快照封顶（生产成熟度 Track B / DOG-01 后续）。
 *
 * connect 已改发 MESSAGES_SNAPSHOT（不再回放整段事件日志），但消息列本身仍可能很大
 * （上千条 / 数百 KB 带图）。浏览器主线程一次 apply 太大仍会拖住 `/run`。
 * 这里按条数 + 序列化体积双限，只留最近一段；更早的仍在服务器 messages 列里，
 * 用户滚动加载历史不受影响（GET .../messages 仍返回全量）。
 */

export type ConnectSnapshotLimits = {
  /** 最多带多少条消息（含可能插入的截断提示）。默认 400。 */
  maxMessages?: number;
  /** JSON.stringify 后大约多少字节封顶。默认 512 KiB。 */
  maxJsonBytes?: number;
};

export const DEFAULT_CONNECT_MAX_MESSAGES = 400;
export const DEFAULT_CONNECT_MAX_JSON_BYTES = 512 * 1024;

const TRUNCATION_NOTE_ID = "chisabot-connect-truncation-note";

export type CapConnectResult<T> = {
  messages: T[];
  truncated: boolean;
  dropped: number;
};

/**
 * 从尾部保留能塞进双限的消息；若裁过，在最前面插一条 system 说明。
 * 不改传入数组；空输入原样返回。
 */
export function capConnectMessages<
  T extends { id?: unknown; role?: unknown; content?: unknown },
>(
  messages: readonly T[],
  limits: ConnectSnapshotLimits = {},
): CapConnectResult<T> {
  const maxMessages = Math.max(
    1,
    limits.maxMessages ?? DEFAULT_CONNECT_MAX_MESSAGES,
  );
  const maxJsonBytes = Math.max(
    8_192,
    limits.maxJsonBytes ?? DEFAULT_CONNECT_MAX_JSON_BYTES,
  );
  if (messages.length === 0)
    return { messages: [], truncated: false, dropped: 0 };

  // 先按条数从尾部切一刀，再按体积往前收。
  let kept =
    messages.length > maxMessages
      ? messages.slice(messages.length - maxMessages)
      : [...messages];
  let dropped = messages.length - kept.length;

  const sizeOf = (list: readonly T[]) => {
    try {
      return JSON.stringify(list).length;
    } catch {
      // 不可序列化时退回条数限制（已经做过）。
      return 0;
    }
  };

  while (kept.length > 1 && sizeOf(kept) > maxJsonBytes) {
    kept = kept.slice(1);
    dropped += 1;
  }

  // 单条就超限：仍带这一条（否则连接空白），由调用方日志告警。
  const truncated = dropped > 0;
  if (!truncated)
    return { messages: kept as T[], truncated: false, dropped: 0 };

  const note = {
    id: TRUNCATION_NOTE_ID,
    role: "system",
    content: `（为加快打开，接入时只带了最近 ${kept.length} 条消息；更早的 ${dropped} 条仍在服务器上，不影响继续聊。）`,
  } as T;

  // 给截断提示留位置：若再超条数上限，丢掉 kept 最前一条。
  if (kept.length + 1 > maxMessages) {
    kept = kept.slice(1);
    dropped += 1;
  }
  return { messages: [note, ...kept], truncated: true, dropped };
}

/** 浏览器最多带多少个锚点 id（见 snapshotSince）。 */
export const MAX_SNAPSHOT_ANCHORS = 16;

/** 请求体里的 `snapshotAfter`：只收字符串 id，最多 MAX_SNAPSHOT_ANCHORS 个；别的形状当没给。 */
export function connectSnapshotAnchors(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter(
      (id): id is string =>
        typeof id === "string" && id.length > 0 && id.length <= 512,
    )
    .slice(-MAX_SNAPSHOT_ANCHORS);
  return ids.length ? ids : undefined;
}

/**
 * 增量接入快照（2026-11-09 重连循环事故）：浏览器手里已经有到哪了，就从那里开始发。
 *
 * 以前每次 connect（打开、sync 重接、每发一句）都发最近 400 条（长对话 ~330–410 KB）；sync 重接只是
 * 为了补几条新的，也照样整段下发。浏览器在合并式接入时带上手里最近几条的 id，这里从其中最早一条也在
 * 存档里的开始切；一条都对不上（被截断过、id 是本机还没存下的）返回 null，由调用方退回封顶快照。
 */
export function snapshotSince<T extends { id?: unknown }>(
  messages: readonly T[],
  anchors: readonly string[] | undefined,
): T[] | null {
  if (!anchors?.length) return null;
  const wanted = new Set(anchors);
  const at = messages.findIndex(
    (message) => typeof message.id === "string" && wanted.has(message.id),
  );
  return at < 0 ? null : messages.slice(at);
}
