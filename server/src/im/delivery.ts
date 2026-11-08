import type { Database } from "../db/client";
import type { ImDeliveryReceipt, ImInbound, ImReply } from "./types";

export type ImDeliveryState = "queued" | "sending" | "sent" | "outcome_unknown" | "cancelled";
export type ImInboxRecord = {
  id: string; connection_id: string; owner_user_id: string; agent_id: string;
  thread_id: string; inbound: ImInbound; state: "pending" | "staged";
};
export type ImOutboxRecord = {
  id: string; connection_id: string; owner_user_id: string; agent_id: string;
  thread_id: string; inbound: ImInbound; text: string; chunks: string[];
  state: ImDeliveryState; receipt: ImDeliveryReceipt | null; error: string | null;
};

/** Durable handoff inside the IM dispatcher. It never starts or retries model execution. */
export function createImDelivery(database: Database) {
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
          text text NOT NULL, chunks jsonb NOT NULL, state text NOT NULL DEFAULT 'queued',
          receipt jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS chisabot_im_outbox_pending ON chisabot_im_outbox(connection_id) WHERE state IN ('queued','sending');
      `);
    },
    async inbox(id: string) {
      return (await sql.unsafe<ImInboxRecord[]>("SELECT * FROM chisabot_im_inbox WHERE id=$1", [id]))[0] ?? null;
    },
    async accept(input: Omit<ImInboxRecord, "state">) {
      await sql.unsafe(`INSERT INTO chisabot_im_inbox(id,connection_id,owner_user_id,agent_id,thread_id,inbound)
        VALUES($1,$2,$3,$4,$5,$6::text::jsonb) ON CONFLICT(id) DO NOTHING`,
      [input.id, input.connection_id, input.owner_user_id, input.agent_id, input.thread_id, JSON.stringify(input.inbound)]);
    },
    async pending(connectionIds: string[]) {
      return sql.unsafe<ImInboxRecord[]>("SELECT * FROM chisabot_im_inbox WHERE state='pending' AND connection_id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY created_at LIMIT 100", [JSON.stringify(connectionIds)]);
    },
    async stage(input: Omit<ImOutboxRecord, "state" | "receipt" | "error">, inboxId?: string) {
      await sql.begin(async tx => {
        await tx.unsafe(`INSERT INTO chisabot_im_outbox(id,connection_id,owner_user_id,agent_id,thread_id,inbound,text,chunks)
          VALUES($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8::text::jsonb) ON CONFLICT(id) DO NOTHING`,
        [input.id, input.connection_id, input.owner_user_id, input.agent_id, input.thread_id, JSON.stringify(input.inbound), input.text, JSON.stringify(input.chunks)]);
        if (inboxId) await tx.unsafe("UPDATE chisabot_im_inbox SET state='staged' WHERE id=$1", [inboxId]);
      });
    },
    async queued(connectionIds: string[]) {
      return sql.unsafe<{ id: string }[]>("SELECT id FROM chisabot_im_outbox WHERE state IN ('queued','sending') AND connection_id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY created_at LIMIT 100", [JSON.stringify(connectionIds)]);
    },
    async get(id: string) {
      return (await sql.unsafe<ImOutboxRecord[]>("SELECT * FROM chisabot_im_outbox WHERE id=$1", [id]))[0] ?? null;
    },
    /** A session lock survives transactions, and is released by PostgreSQL if this API dies. */
    async dispatch(id: string, target: (record: ImOutboxRecord, reader: Pick<Database["$client"], "unsafe">) => Promise<
      { send: (reply: ImReply) => Promise<void | ImDeliveryReceipt> } | "cancelled" | null
    >) {
      const connection = await sql.reserve();
      let locked = false;
      try {
        const [lock] = await connection.unsafe<{ locked: boolean }[]>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [`im-outbox:${id}`]);
        locked = lock?.locked === true;
        if (!locked) return;
        const record = (await connection.unsafe<ImOutboxRecord[]>("SELECT * FROM chisabot_im_outbox WHERE id=$1", [id]))[0];
        if (!record) return;
        if (record.state === "sending") {
          // The previous sender no longer holds its DB session. The platform may have accepted it.
          await connection.unsafe("UPDATE chisabot_im_outbox SET state='outcome_unknown',error=$2,updated_at=now() WHERE id=$1",
            [id, "发送进程在收到平台确认前中断；原回复已保留，需核对平台收件记录，不会自动重发。"]);
          return "outcome_unknown" as const;
        }
        if (record.state !== "queued") return record.state;
        const destination = await target(record, connection);
        if (!destination) return "queued" as const;
        if (destination === "cancelled") {
          await connection.unsafe("UPDATE chisabot_im_outbox SET state='cancelled',error=$2,updated_at=now() WHERE id=$1", [id, "连接、机器人或收件人授权已变更，回复已保留，未发送。"]);
          return "cancelled" as const;
        }
        const claimed = await connection.unsafe("UPDATE chisabot_im_outbox SET state='sending',updated_at=now() WHERE id=$1 AND state='queued' RETURNING id", [id]);
        if (!claimed.length) return "cancelled" as const;
        try {
          const receipt = await destination.send({ inbound: record.inbound, text: record.text, chunks: record.chunks });
          await connection.unsafe("UPDATE chisabot_im_outbox SET state='sent',receipt=$2::text::jsonb,error=NULL,updated_at=now() WHERE id=$1", [id, JSON.stringify(receipt ?? null)]);
          return "sent" as const;
        } catch (error) {
          await connection.unsafe("UPDATE chisabot_im_outbox SET state='outcome_unknown',error=$2,updated_at=now() WHERE id=$1", [id, String(error instanceof Error ? error.message : error).slice(0, 1000)]);
          return "outcome_unknown" as const;
        }
      } finally {
        try { if (locked) await connection.unsafe("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`im-outbox:${id}`]); }
        finally { connection.release(); }
      }
    },
    async cancelConnection(connectionId: string) {
      // A send already in flight must keep its uncertain state for reconciliation.
      await sql.unsafe("UPDATE chisabot_im_outbox SET state='cancelled',error='连接已删除',updated_at=now() WHERE connection_id=$1 AND state='queued'", [connectionId]);
      await sql.unsafe("UPDATE chisabot_im_inbox SET state='staged' WHERE connection_id=$1", [connectionId]);
    },
    async history(owner: string, connectionId: string) {
      return sql.unsafe<ImOutboxRecord[]>("SELECT * FROM chisabot_im_outbox WHERE owner_user_id=$1 AND connection_id=$2 ORDER BY created_at DESC LIMIT 100", [owner, connectionId]);
    },
  };
}
