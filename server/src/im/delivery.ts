import type { Database } from "../db/client";
import {
  DeliveryRejectedError,
  type DispatchState,
  dispatchDurable,
} from "../delivery/durable-dispatch";
import type { ImDeliveryReceipt, ImInbound, ImReply } from "./types";
import { isImWindowExpiredError } from "./window-expiry";

export type ImDeliveryState =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "outcome_unknown"
  | "cancelled"
  | "window_expired";
export type ImInboxRecord = {
  id: string;
  connection_id: string;
  owner_user_id: string;
  agent_id: string;
  thread_id: string;
  inbound: ImInbound;
  state: "pending" | "staged";
};
export type ImOutboxRecord = {
  id: string;
  connection_id: string;
  owner_user_id: string;
  agent_id: string;
  thread_id: string;
  inbound: ImInbound;
  text: string;
  chunks: string[];
  files?: unknown[];
  state: ImDeliveryState;
  receipt: ImDeliveryReceipt | null;
  error: string | null;
  window_expired_at?: string | null;
};
export type ImDeliveryOptions = {
  onWindowExpired?: (record: ImOutboxRecord, reason: string) => Promise<void>;
};

const DEFAULT_WINDOW_EXPIRED_REASON =
  "当前 IM 会话回复窗口已过期，无法直接推送。";

function normalizeOutboxRecord(row: ImOutboxRecord): ImOutboxRecord {
  const rawExpiredAt: unknown = row.window_expired_at;
  if (rawExpiredAt === undefined) return row;
  const windowExpiredAt =
    rawExpiredAt instanceof Date
      ? rawExpiredAt.toISOString()
      : rawExpiredAt === null
        ? null
        : String(rawExpiredAt);
  return { ...row, window_expired_at: windowExpiredAt };
}

function toDurableRecord(
  row: ImOutboxRecord,
): Omit<ImOutboxRecord, "state"> & { state: DispatchState } {
  if (row.state === "window_expired") {
    // window_expired 是不可重发的终态，映射为 cancelled 让 durable-dispatch 跳过发送与覆写。
    return { ...row, state: "cancelled" };
  }
  return { ...row, state: row.state };
}

/** Durable handoff inside the IM dispatcher. It never starts or retries model execution. */
export function createImDelivery(
  database: Database,
  options?: ImDeliveryOptions,
) {
  const sql = database.$client;
  return {
    async ensure() {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS chisabot_im_inbox (
          id text PRIMARY KEY, connection_id text NOT NULL, owner_user_id text NOT NULL,
          agent_id text NOT NULL, thread_id text NOT NULL, inbound jsonb NOT NULL,
          state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS chisabot_im_inbox_pending ON chisabot_im_inbox(connection_id) WHERE state='pending';
        CREATE TABLE IF NOT EXISTS chisabot_im_outbox (
          id text PRIMARY KEY, connection_id text NOT NULL, owner_user_id text NOT NULL,
          agent_id text NOT NULL, thread_id text NOT NULL, inbound jsonb NOT NULL,
          text text NOT NULL, chunks jsonb NOT NULL, files jsonb NOT NULL DEFAULT '[]'::jsonb,
          state text NOT NULL DEFAULT 'queued',
          receipt jsonb, error text, window_expired_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE chisabot_im_outbox ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE chisabot_im_outbox ADD COLUMN IF NOT EXISTS window_expired_at timestamptz;
        CREATE INDEX IF NOT EXISTS chisabot_im_outbox_pending ON chisabot_im_outbox(connection_id) WHERE state IN ('queued','sending');
      `);
    },
    async inbox(id: string) {
      return (
        (
          await sql.unsafe<ImInboxRecord[]>(
            "SELECT * FROM chisabot_im_inbox WHERE id=$1",
            [id],
          )
        )[0] ?? null
      );
    },
    async accept(input: Omit<ImInboxRecord, "state">) {
      await sql.unsafe(
        `INSERT INTO chisabot_im_inbox(id,connection_id,owner_user_id,agent_id,thread_id,inbound)
        VALUES($1,$2,$3,$4,$5,$6::text::jsonb) ON CONFLICT(id) DO NOTHING`,
        [
          input.id,
          input.connection_id,
          input.owner_user_id,
          input.agent_id,
          input.thread_id,
          JSON.stringify(input.inbound),
        ],
      );
    },
    async pending(connectionIds: string[]) {
      return sql.unsafe<ImInboxRecord[]>(
        "SELECT * FROM chisabot_im_inbox WHERE state='pending' AND connection_id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY created_at LIMIT 100",
        [JSON.stringify(connectionIds)],
      );
    },
    async stage(
      input: Omit<ImOutboxRecord, "state" | "receipt" | "error">,
      inboxId?: string,
    ) {
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO chisabot_im_outbox(id,connection_id,owner_user_id,agent_id,thread_id,inbound,text,chunks,files)
          VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8::text::jsonb,$9::text::jsonb) ON CONFLICT(id) DO NOTHING`,
          [
            input.id,
            input.connection_id,
            input.owner_user_id,
            input.agent_id,
            input.thread_id,
            JSON.stringify(input.inbound),
            input.text,
            JSON.stringify(input.chunks),
            JSON.stringify(input.files ?? []),
          ],
        );
        if (inboxId)
          await tx.unsafe(
            "UPDATE chisabot_im_inbox SET state='staged' WHERE id=$1",
            [inboxId],
          );
      });
    },
    async queued(connectionIds: string[]) {
      return sql.unsafe<{ id: string }[]>(
        "SELECT id FROM chisabot_im_outbox WHERE state IN ('queued','sending') AND connection_id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY created_at LIMIT 100",
        [JSON.stringify(connectionIds)],
      );
    },
    async get(id: string) {
      const row = (
        await sql.unsafe<ImOutboxRecord[]>(
          "SELECT * FROM chisabot_im_outbox WHERE id=$1",
          [id],
        )
      )[0];
      return row ? normalizeOutboxRecord(row) : null;
    },
    /** A session lock survives transactions, and is released by PostgreSQL if this API dies. */
    async dispatch(
      id: string,
      target: (
        record: ImOutboxRecord,
        reader: Pick<Database["$client"], "unsafe">,
      ) => Promise<
        | { send: (reply: ImReply) => Promise<ImDeliveryReceipt | undefined> }
        | "cancelled"
        | null
      >,
    ): Promise<ImDeliveryState | undefined> {
      const capture: {
        expired: { record: ImOutboxRecord; reason: string } | null;
        settled: ImOutboxRecord | null;
        alreadyExpired: boolean;
      } = {
        expired: null,
        settled: null,
        alreadyExpired: false,
      };
      const outcome = await dispatchDurable<
        Omit<ImOutboxRecord, "state"> & { state: DispatchState },
        ImDeliveryReceipt | undefined
      >({
        database,
        key: `im-outbox:${id}`,
        load: async (reader) => {
          const raw = (
            await reader.unsafe<ImOutboxRecord[]>(
              "SELECT * FROM chisabot_im_outbox WHERE id=$1",
              [id],
            )
          )[0];
          if (!raw) return null;
          const row = normalizeOutboxRecord(raw);
          if (row.state === "window_expired") {
            capture.alreadyExpired = true;
          }
          return toDurableRecord(row);
        },
        settle: async (
          reader,
          state,
          receipt?: ImDeliveryReceipt,
          error?: string,
        ) => {
          if (capture.expired) {
            const rows = await reader.unsafe<ImOutboxRecord[]>(
              "UPDATE chisabot_im_outbox SET state='window_expired',window_expired_at=now(),receipt=NULL,error=$2,updated_at=now() WHERE id=$1 RETURNING *",
              [id, capture.expired.reason],
            );
            const updated = rows[0] ? normalizeOutboxRecord(rows[0]) : null;
            capture.settled = updated?.connection_id
              ? {
                  ...updated,
                  state: "window_expired",
                  receipt: null,
                  error: updated.error ?? capture.expired.reason,
                  window_expired_at:
                    updated.window_expired_at ?? new Date().toISOString(),
                }
              : {
                  ...capture.expired.record,
                  state: "window_expired",
                  receipt: null,
                  error: capture.expired.reason,
                  window_expired_at: new Date().toISOString(),
                };
            return;
          }
          await reader.unsafe(
            "UPDATE chisabot_im_outbox SET state=$2,receipt=$3::text::jsonb,error=$4,updated_at=now() WHERE id=$1",
            [id, state, JSON.stringify(receipt ?? null), error ?? null],
          );
        },
        target: async (record, reader) => {
          const fullRecord: ImOutboxRecord = record;
          const destination = await target(fullRecord, reader);
          if (!destination || destination === "cancelled") return destination;
          return {
            send: async () => {
              try {
                return await destination.send({
                  inbound: fullRecord.inbound,
                  text: fullRecord.text,
                  chunks: fullRecord.chunks,
                });
              } catch (error) {
                if (isImWindowExpiredError(error)) {
                  const reason = (
                    error.message.trim() || DEFAULT_WINDOW_EXPIRED_REASON
                  ).slice(0, 1000);
                  capture.expired = { record: fullRecord, reason };
                  // 借用非重试拒绝错误让 durable-dispatch 走终态结算并释放锁，再在 settle 写入 window_expired。
                  throw new DeliveryRejectedError(reason, false);
                }
                throw error;
              }
            },
          };
        },
      });
      if (capture.alreadyExpired) return "window_expired";
      if (capture.expired) {
        const recordForNotify: ImOutboxRecord = capture.settled ?? {
          ...capture.expired.record,
          state: "window_expired",
          receipt: null,
          error: capture.expired.reason,
          window_expired_at: new Date().toISOString(),
        };
        if (options?.onWindowExpired) {
          try {
            await options.onWindowExpired(
              recordForNotify,
              capture.expired.reason,
            );
          } catch (notifyError) {
            console.warn(
              JSON.stringify({
                type: "im-window-expired-notify-failed",
                outboxId: id,
                reason:
                  notifyError instanceof Error
                    ? notifyError.message.slice(0, 200)
                    : String(notifyError).slice(0, 200),
              }),
            );
          }
        }
        return "window_expired";
      }
      return outcome;
    },
    async cancelConnection(connectionId: string) {
      // A send already in flight must keep its uncertain state for reconciliation.
      await sql.unsafe(
        "UPDATE chisabot_im_outbox SET state='cancelled',error='连接已删除',updated_at=now() WHERE connection_id=$1 AND state='queued'",
        [connectionId],
      );
      await sql.unsafe(
        "UPDATE chisabot_im_inbox SET state='staged' WHERE connection_id=$1",
        [connectionId],
      );
    },
    async history(owner: string, connectionId: string) {
      const rows = await sql.unsafe<ImOutboxRecord[]>(
        "SELECT * FROM chisabot_im_outbox WHERE owner_user_id=$1 AND connection_id=$2 ORDER BY created_at DESC LIMIT 100",
        [owner, connectionId],
      );
      return rows.map(normalizeOutboxRecord);
    },
  };
}
