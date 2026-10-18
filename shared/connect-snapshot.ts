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
