/**
 * How long this deployment keeps its audit trail.
 *
 * Every click, keystroke, scroll, tool call, refusal, command and sign-in is a row, so the trail
 * becomes the largest table in the deployment within weeks of real use and nothing in the product
 * ever removed one. That is two problems wearing one hat. The table outgrows its disk, and an
 * enterprise buyer asking "what is your retention policy" had no answer to be given: the honest one
 * was "we keep everything forever and you cannot express anything else".
 *
 * Off unless configured. Deleting somebody's audit trail because a default said so is the worse
 * failure of the two, and a deployment that has not thought about retention should keep everything
 * until it has.
 *
 * The trail stays append-only. The database refuses every delete unless the transaction declares a
 * retention window, and refuses any row inside that window whatever it is set to, so "we removed the
 * rows about the incident" is still impossible and an UPDATE still is under every condition. See
 * migration 0007.
 *
 * One server sweeps, not all of them, decided by a Postgres advisory lock. Without it, N servers run
 * the same delete over the same rows every hour: N times the work for one outcome, on the one table
 * every action writes to.
 */
import postgres from "postgres";
import {
  FRAME_RETENTION_MS,
  type PageFrameStore,
} from "./computer/page-frames";

/**
 * The advisory lock this takes, as an arbitrary but fixed number.
 *
 * Session-scoped, on a connection this module owns for the length of the sweep. It cannot go through
 * the shared pool: a session lock belongs to one connection, so a pool would happily take it on one
 * and try to release it on another, and the lock would leak until that connection died.
 */
const SWEEP_LOCK = 4_192_004;

/** Separate session advisory lock for pruning archived intermediate local conversation events (CB-031). */
export const LOCAL_EVENTS_SWEEP_LOCK = 4_192_005;

/** Default retention window for archived streaming intermediate rows in chisabot_local_events. */
export const DEFAULT_LOCAL_EVENT_RETENTION_DAYS = 14;

/**
 * How many rows one delete removes.
 *
 * Batched because the alternative is a single statement holding locks on millions of rows on the
 * table every action writes to. A deployment that has never swept has years to remove and should not
 * take its own audit trail offline doing it.
 */
const BATCH = 5_000;

/** How many batches one sweep runs before leaving the rest for the next one. */
const MAX_BATCHES = 200;

export type RetentionResult = {
  /** Null when another server was already sweeping. Distinguished from having deleted nothing. */
  deleted: number | null;
};

export type LocalEventsSweepConnection = {
  tryAdvisoryLock: (lockId: number) => Promise<boolean>;
  deleteArchivedBatch: (
    retentionDays: number,
    batchSize: number,
  ) => Promise<number>;
  end: () => Promise<void>;
};

export type LocalEventsSweepOptions = {
  batchSize?: number;
  maxBatches?: number;
  connect?: (databaseUrl: string) => LocalEventsSweepConnection;
};

function defaultLocalEventsConnection(
  databaseUrl: string,
): LocalEventsSweepConnection {
  const connection = postgres(databaseUrl, { max: 1 });
  return {
    async tryAdvisoryLock(lockId: number): Promise<boolean> {
      const [lock] = await connection`
        select pg_try_advisory_lock(${lockId}) as held
      `;
      return Boolean(lock?.held);
    },
    async deleteArchivedBatch(
      retentionDays: number,
      batchSize: number,
    ): Promise<number> {
      const removed = await connection`
        delete from chisabot_local_events where sequence in (
          select e.sequence
          from chisabot_local_events e
          join chisabot_local_threads t on t.id = e.thread_id
          where t.snapshot_sequence is not null
            and e.sequence <= t.snapshot_sequence
            and e.created_at < now() - (${retentionDays} || ' days')::interval
            and coalesce(e.event->>'type', '') not in ('RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR')
          limit ${batchSize}
        )
      `;
      return removed.count ?? 0;
    },
    async end(): Promise<void> {
      await connection.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}

/**
 * Remove expired intermediate streaming rows from `chisabot_local_events` that are already covered
 * by `chisabot_local_threads.snapshot_sequence`, while preserving lifecycle rows
 * (`RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR`).
 */
export async function sweepLocalEvents(
  databaseUrl: string,
  retentionDays: number = DEFAULT_LOCAL_EVENT_RETENTION_DAYS,
  options: LocalEventsSweepOptions = {},
): Promise<RetentionResult> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    return { deleted: null };
  }
  const batchSize =
    options.batchSize && Number.isInteger(options.batchSize) && options.batchSize > 0
      ? options.batchSize
      : BATCH;
  const maxBatches =
    options.maxBatches && Number.isInteger(options.maxBatches) && options.maxBatches > 0
      ? options.maxBatches
      : MAX_BATCHES;
  const connection = (options.connect ?? defaultLocalEventsConnection)(
    databaseUrl,
  );
  try {
    const held = await connection.tryAdvisoryLock(LOCAL_EVENTS_SWEEP_LOCK);
    if (!held) return { deleted: null };

    let deleted = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const count = await connection.deleteArchivedBatch(
        retentionDays,
        batchSize,
      );
      deleted += count;
      if (count < batchSize) break;
    }
    return { deleted };
  } finally {
    await connection.end();
  }
}

/**
 * Remove audit rows older than the retention window.
 *
 * Returns what it did so a caller can log it. Its own connection, released whatever happens.
 */
export async function sweepAuditTrail(
  databaseUrl: string,
  retentionDays: number,
): Promise<RetentionResult> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    return { deleted: null };
  }

  const connection = postgres(databaseUrl, { max: 1 });

  try {
    const [lock] = await connection`
      select pg_try_advisory_lock(${SWEEP_LOCK}) as held
    `;
    if (!lock?.held) return { deleted: null };

    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await connection.begin(async (tx) => {
        /*
         * Declared to the trigger, transaction-locally.
         *
         * Retention is the one narrow exception to an append-only table and it has to say so. `true`
         * makes the setting local to this transaction, so the permission cannot outlive the
         * statement that asked for it.
         */
        await tx`select set_config('chisabot.audit_retention_days', ${String(retentionDays)}, true)`;

        /*
         * `ctid` rather than a plain `delete ... where created_at <`.
         *
         * The subquery picks a bounded set using the `created_at` index and the delete removes
         * exactly those, so each statement is short and the table stays writable between them.
         */
        return await tx`
          delete from audit_events where ctid in (
            select ctid from audit_events
            where created_at < now() - (${retentionDays} || ' days')::interval
            limit ${BATCH}
          )
        `;
      });

      const count = removed.count ?? 0;
      deleted += count;
      if (count < BATCH) break;
    }

    return { deleted };
  } finally {
    // Ending the connection releases the lock with it, so a sweep that threw halfway does not leave
    // the lock held and every later sweep skipped.
    await connection.end({ timeout: 5 }).catch(() => undefined);
  }
}

export type RetentionSweeper = { stop: () => void };

/**
 * Sweep on an interval, starting shortly after boot.
 *
 * Not immediately at boot: a deployment rolling several servers would have all of them contend for
 * the lock in the same second, and the one that wins would compete with start-up for the database.
 */
export function startRetentionSweeps(
  databaseUrl: string,
  retentionDays: number | undefined,
  // Swept whatever the audit policy is: their only other caller runs in `computers.mode: sandbox` alone.
  pageFrames?: PageFrameStore,
  options: {
    intervalMs?: number;
    firstRunMs?: number;
    localEventRetentionDays?: number;
  } = {},
): RetentionSweeper {
  const sweepsAudit = Boolean(retentionDays && retentionDays >= 1);
  const localEventDays =
    options.localEventRetentionDays ?? DEFAULT_LOCAL_EVENT_RETENTION_DAYS;
  const sweepsLocalEvents =
    Boolean(databaseUrl) &&
    Number.isInteger(localEventDays) &&
    localEventDays >= 1;
  if (!sweepsAudit && !pageFrames && !sweepsLocalEvents)
    return { stop: () => undefined };

  const intervalMs = options.intervalMs ?? 60 * 60_000;
  const firstRunMs = options.firstRunMs ?? 60_000;
  const timers: ReturnType<typeof setInterval>[] = [];

  const run = () => {
    if (pageFrames) {
      void pageFrames
        .purge(FRAME_RETENTION_MS)
        .then((removed) => {
          if (removed === 0) return;
          console.info(JSON.stringify({ type: "page-frames-swept", removed }));
        })
        .catch((error) => {
          console.error(
            JSON.stringify({
              type: "page-frames-sweep-failed",
              note: "Old turn screenshots were not removed. Nothing is broken; the table is larger than it should be.",
              error: String(error),
            }),
          );
        });
    }
    if (sweepsLocalEvents) {
      void sweepLocalEvents(databaseUrl, localEventDays)
        .then(({ deleted }) => {
          if (deleted === null || deleted === 0) return;
          console.info(
            JSON.stringify({
              type: "local-events-retention-swept",
              deleted,
              retentionDays: localEventDays,
            }),
          );
        })
        .catch((error) => {
          console.error(
            JSON.stringify({
              type: "local-events-retention-failed",
              note: "Archived intermediate conversation events were not pruned. Conversation history is intact.",
              error: String(error),
            }),
          );
        });
    }
    if (!sweepsAudit || !retentionDays) return;
    void sweepAuditTrail(databaseUrl, retentionDays)
      .then(({ deleted }) => {
        if (deleted === null || deleted === 0) return;
        console.info(
          JSON.stringify({
            type: "audit-retention-swept",
            deleted,
            retentionDays,
          }),
        );
      })
      .catch((error) => {
        console.error(
          JSON.stringify({
            type: "audit-retention-failed",
            note: "Old audit rows were not removed. The trail is intact; it is only larger than the policy asks for.",
            error: String(error),
          }),
        );
      });
  };

  const first = setTimeout(() => {
    run();
    const repeating = setInterval(run, intervalMs);
    // Housekeeping should not hold the process open.
    repeating.unref?.();
    timers.push(repeating);
  }, firstRunMs);
  first.unref?.();

  return {
    stop: () => {
      clearTimeout(first);
      for (const timer of timers) clearInterval(timer);
    },
  };
}
