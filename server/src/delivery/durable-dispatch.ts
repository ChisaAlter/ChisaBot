import type { Database } from "../db/client";

export type DispatchState = "queued" | "sending" | "sent" | "failed" | "outcome_unknown" | "cancelled";
export class DeliveryRejectedError extends Error {
  override name = "DeliveryRejectedError";
  constructor(message: string, readonly retryable = false) { super(message); }
}
export class DeliveryOutcomeUnknownError extends Error {
  override name = "DeliveryOutcomeUnknownError";
}
type Reader = Pick<Database["$client"], "unsafe">;

/** Shared IM/personal send lease. A lost sender never turns back into a fresh send. */
export async function dispatchDurable<Record extends { state: DispatchState }, Receipt>(options: {
  database: Database;
  key: string;
  load: (reader: Reader) => Promise<Record | null>;
  settle: (reader: Reader, state: DispatchState, receipt?: Receipt, error?: string) => Promise<void>;
  target: (record: Record, reader: Reader) => Promise<{ send: () => Promise<Receipt> } | "cancelled" | null>;
  retryRejected?: (record: Record, error: DeliveryRejectedError, reader: Reader) => Promise<boolean>;
}): Promise<DispatchState | undefined> {
  const connection = await options.database.$client.reserve();
  let locked = false;
  try {
    const [lock] = await connection.unsafe<{ locked: boolean }[]>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [options.key]);
    locked = lock?.locked === true;
    if (!locked) return;
    const record = await options.load(connection);
    if (!record) return;
    if (record.state === "sending") {
      await options.settle(connection, "outcome_unknown", undefined, "发送进程在收到平台确认前中断；需核对收件记录，不会自动重发。");
      return "outcome_unknown";
    }
    if (record.state !== "queued") return record.state;
    const target = await options.target(record, connection);
    if (!target) return "queued";
    if (target === "cancelled") {
      await options.settle(connection, "cancelled", undefined, "连接或收件人授权已变更，未发送。");
      return "cancelled";
    }
    await options.settle(connection, "sending");
    try {
      const receipt = await target.send();
      await options.settle(connection, "sent", receipt);
      return "sent";
    } catch (error) {
      if (error instanceof DeliveryRejectedError && error.retryable && await options.retryRejected?.(record, error, connection)) {
        await options.settle(connection, "queued", undefined, `${error.message} 已排队稍后重试。`);
        return "queued";
      }
      const state = error instanceof DeliveryRejectedError ? "failed" : "outcome_unknown";
      await options.settle(connection, state, undefined, error instanceof Error ? error.message.slice(0, 1000) : "发送结果无法确认。");
      return state;
    }
  } finally {
    try { if (locked) await connection.unsafe("SELECT pg_advisory_unlock(hashtextextended($1,0))", [options.key]); }
    finally { connection.release(); }
  }
}
