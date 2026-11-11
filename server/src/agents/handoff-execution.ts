import { randomUUID } from "node:crypto";
import { runAssertionValue } from "../conversations/protocol";
import type { Database } from "../db/client";
import { readDurableTurn } from "../turns/durable-outcome";
import type { RunAssertion } from "./callback-token";
import { HANDOFF_KIND } from "./handoff";
import type { HandoffWork } from "./handoff-runner";

export type HandoffExecution = { threadId: string; runId: string };

/** A queue item keeps one execution identity across leases, approvals and owner restarts. */
export function createHandoffExecutions(
  database: Database,
  mintThreadId: () => string,
  readRun: (value: unknown) => RunAssertion | null,
) {
  const sql = database.$client;
  return {
    async ensure(
      key: string,
      owner: string,
      work: HandoffWork,
    ): Promise<HandoffExecution> {
      const proposed = {
        threadId: work.answerIn ?? mintThreadId(),
        runId: randomUUID(),
      };
      const [row] = await sql.unsafe<{ execution: HandoffExecution }[]>(
        `UPDATE work_items SET payload=jsonb_set(payload,'{execution}',COALESCE(payload->'execution',$4::text::jsonb)),updated_at=now()
         WHERE kind=$1 AND key=$2 AND claimed_by=$3 AND lease_until>now() AND finished_at IS NULL
         RETURNING payload->'execution' AS execution`,
        [HANDOFF_KIND, key, owner, JSON.stringify(proposed)],
      );
      if (!row?.execution?.threadId || !row.execution.runId)
        throw new Error("The handoff execution lease was lost.");
      return row.execution;
    },
    async read(work: HandoffWork, execution: HandoffExecution) {
      // Approval continuation has its own run ID. Follow only a signed continuation of this
      // execution, never an unrelated later user turn in the source conversation used by a relay.
      const rows = await sql.unsafe<
        {
          run_id: string;
          input: { forwardedProps?: { chisabotRun?: unknown } };
        }[]
      >(
        "SELECT run_id,input FROM chisabot_dsh_runs WHERE owner_user_id=$1 AND thread_id=$2 ORDER BY created_at DESC",
        [work.actorId, execution.threadId],
      );
      const latest = rows.find((row) => {
        if (row.run_id === execution.runId) return true;
        const run = readRun(runAssertionValue(row.input?.forwardedProps));
        return (
          run?.actorId === work.actorId &&
          run.botId === work.toBotId &&
          run.handoff &&
          (run.handoff.executionRunId ?? run.runId) === execution.runId
        );
      });
      return latest
        ? readDurableTurn(
            database,
            work.actorId,
            execution.threadId,
            latest.run_id,
          )
        : null;
    },
    /** Observing a running/waiting execution does not spend another execution attempt. */
    async defer(key: string, owner: string, status: string) {
      const rows = await sql.unsafe(
        `UPDATE work_items SET claimed_by=NULL,lease_until=NULL,run_at=now()+interval '2 seconds',
        attempts=GREATEST(0,attempts-1),last_error=$4,updated_at=now()
        WHERE kind=$1 AND key=$2 AND claimed_by=$3 AND finished_at IS NULL RETURNING key`,
        [HANDOFF_KIND, key, owner, `execution_${status}`],
      );
      return rows.length > 0;
    },
  };
}
export type HandoffExecutions = ReturnType<typeof createHandoffExecutions>;
