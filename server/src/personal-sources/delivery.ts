import { randomUUID } from "node:crypto";
import type {
  PersonalDeliveryEvidence,
  PersonalDeliveryView,
} from "../../../shared/personal-sources";
import type { Database } from "../db/client";
import {
  DeliveryOutcomeUnknownError,
  DeliveryRejectedError,
  type DispatchState,
  dispatchDurable,
} from "../delivery/durable-dispatch";
import {
  type PersonalNotificationSource,
  personalNoticeIsCurrent,
} from "../delivery/personal-notification-state";

export type PersonalSendContext = {
  id?: string;
  threadId?: string;
  runId?: string;
  agentId?: string;
  notificationSource?: PersonalNotificationSource;
};
export type PersonalDeliveryPayload = {
  target: string;
  title: string;
  body: string;
  notificationSource?: PersonalNotificationSource;
};
export type PersonalDeliveryRecord = {
  id: string;
  owner_user_id: string;
  kind: "smtp" | "notify";
  connection_version: string;
  payload: PersonalDeliveryPayload;
  state: DispatchState;
  receipt: PersonalDeliveryEvidence | null;
  error: string | null;
  created_at: string | Date;
  run_id: string | null;
  attempts: number;
  next_attempt_at: string | Date | null;
  retry_due?: boolean;
};

export const PERSONAL_DELIVERY_SCHEMA = `CREATE TABLE IF NOT EXISTS chisabot_personal_deliveries (
  id text PRIMARY KEY, owner_user_id text NOT NULL, kind text NOT NULL,
  connection_version text NOT NULL, payload jsonb NOT NULL, thread_id text, run_id text, agent_id text,
  state text NOT NULL DEFAULT 'queued', receipt jsonb, error text,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE chisabot_personal_deliveries ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE chisabot_personal_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS chisabot_personal_deliveries_pending ON chisabot_personal_deliveries(kind) WHERE state IN ('queued','sending');
CREATE INDEX IF NOT EXISTS chisabot_personal_deliveries_owner ON chisabot_personal_deliveries(owner_user_id,created_at);`;

/** Personal channels retain intents, while the existing IM dispatcher owns the shared send protocol. */
export function createPersonalDelivery(database: Database) {
  const sql = database.$client;
  return {
    ensure: () => sql.unsafe(PERSONAL_DELIVERY_SCHEMA),
    async stage(
      owner: string,
      kind: "smtp" | "notify",
      version: string,
      payload: PersonalDeliveryPayload,
      context: PersonalSendContext = {},
    ) {
      const id = context.id
        ? `personal:${owner}:${context.id}`
        : `personal:${randomUUID()}`;
      const encoded = JSON.stringify({
        ...payload,
        ...(context.notificationSource
          ? { notificationSource: context.notificationSource }
          : {}),
      });
      await sql.unsafe(
        `INSERT INTO chisabot_personal_deliveries(id,owner_user_id,kind,connection_version,payload,thread_id,run_id,agent_id)
        VALUES($1,$2,$3,$4,$5::text::jsonb,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
        [
          id,
          owner,
          kind,
          version,
          encoded,
          context.threadId ?? null,
          context.runId ?? null,
          context.agentId ?? null,
        ],
      );
      const [row] = await sql.unsafe<{ matches: boolean }[]>(
        `SELECT owner_user_id=$2 AND kind=$3 AND connection_version=$4 AND payload=$5::text::jsonb AS matches FROM chisabot_personal_deliveries WHERE id=$1`,
        [id, owner, kind, version, encoded],
      );
      if (!row?.matches)
        throw new DeliveryRejectedError(
          "这次发送记录的内容或目标已经改变，请重新确认。",
        );
      return id;
    },
    async get(id: string) {
      return (
        (
          await sql.unsafe<PersonalDeliveryRecord[]>(
            "SELECT * FROM chisabot_personal_deliveries WHERE id=$1",
            [id],
          )
        )[0] ?? null
      );
    },
    async dispatch(
      id: string,
      target: (
        record: PersonalDeliveryRecord,
      ) => Promise<
        { send: () => Promise<PersonalDeliveryEvidence> } | "cancelled" | null
      >,
    ) {
      return dispatchDurable({
        database,
        key: `personal-outbox:${id}`,
        load: async (reader) =>
          (
            await reader.unsafe<PersonalDeliveryRecord[]>(
              "SELECT *,next_attempt_at IS NULL OR next_attempt_at<=now() AS retry_due FROM chisabot_personal_deliveries WHERE id=$1",
              [id],
            )
          )[0] ?? null,
        settle: async (
          reader,
          state,
          receipt?: PersonalDeliveryEvidence,
          error?: string,
        ) => {
          await reader.unsafe(
            "UPDATE chisabot_personal_deliveries SET state=$2,receipt=$3::text::jsonb,error=$4,attempts=attempts+CASE WHEN $2='sending' THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1",
            [id, state, JSON.stringify(receipt ?? null), error ?? null],
          );
        },
        target: async (record, reader) => {
          if (record.retry_due === false) return null;
          if (
            record.kind === "notify" &&
            !(await personalNoticeIsCurrent(
              reader,
              record.owner_user_id,
              record.id,
              record.payload.notificationSource,
            ))
          )
            return "cancelled";
          return target(record);
        },
        retryRejected: async (record, _error, reader) => {
          // Only unattended notifications retry. A chat send stays bound to its original turn's
          // approval and Stop state; SMTP and chat sends require an explicit new decision.
          if (record.kind !== "notify" || record.run_id || record.attempts >= 2)
            return false;
          const delayMs = record.attempts === 0 ? 30_000 : 120_000;
          await reader.unsafe(
            "UPDATE chisabot_personal_deliveries SET next_attempt_at=now()+$2::integer*interval '1 millisecond' WHERE id=$1",
            [id, delayMs],
          );
          return true;
        },
      });
    },
    async accepted(id: string): Promise<PersonalDeliveryEvidence> {
      const [record] = await sql.unsafe<PersonalDeliveryRecord[]>(
        "SELECT * FROM chisabot_personal_deliveries WHERE id=$1",
        [id],
      );
      if (record?.state === "sent" && record.receipt) return record.receipt;
      if (record?.state === "outcome_unknown" || record?.state === "sending")
        throw new DeliveryOutcomeUnknownError(
          `发送结果待核对（${id}），不会自动重发。`,
        );
      throw new DeliveryRejectedError(
        record?.error ?? "发送尚未完成，请查看通知记录。",
      );
    },
    async queuedNotifications() {
      return sql.unsafe<{ id: string }[]>(
        "SELECT id FROM chisabot_personal_deliveries WHERE (kind='notify' AND state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=now())) OR state='sending' ORDER BY created_at LIMIT 100",
      );
    },
    async history(owner: string): Promise<PersonalDeliveryView[]> {
      const rows = await sql.unsafe<PersonalDeliveryRecord[]>(
        "SELECT * FROM chisabot_personal_deliveries WHERE owner_user_id=$1 ORDER BY created_at DESC LIMIT 20",
        [owner],
      );
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        state: row.state,
        title: row.payload.title,
        target: row.payload.target,
        error: row.error,
        createdAt: new Date(row.created_at).toISOString(),
      }));
    },
  };
}
