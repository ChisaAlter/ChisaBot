import type { Database } from "../db/client";

/** Aliases r and e are the current run and its latest notification-producing event. */
export const WORKFLOW_NOTICE_CURRENT = `(
  (r.status='succeeded' AND e.kind='run_finished')
  OR (r.status='failed' AND e.kind='run_failed')
  OR (r.status='waiting_approval' AND e.kind='approval_requested' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      (CASE WHEN jsonb_typeof(r.state)='string' THEN (r.state #>> '{}')::jsonb ELSE r.state END)->'steps'
    ) step WHERE step->>'id'=e.step_id AND step->>'status'='waiting_approval'
  ))
)`;

/** Recheck an unattended workflow notice immediately before dispatching its saved intent. */
export async function workflowNoticeIsCurrent(
  sql: Pick<Database["$client"], "unsafe">,
  owner: string,
  deliveryId: string,
): Promise<boolean> {
  const prefix = `personal:${owner}:workflow-event:`;
  if (!deliveryId.startsWith(prefix)) return true;
  const [row] = await sql.unsafe<{ current: boolean }[]>(
    `SELECT EXISTS (
      SELECT 1 FROM workflow_runs r
      JOIN LATERAL (
        SELECT * FROM workflow_run_events
        WHERE run_id=r.id AND kind IN ('approval_requested','run_finished','run_failed')
        ORDER BY at DESC,id DESC LIMIT 1
      ) e ON true
      WHERE r.owner_user_id=$1 AND e.id=$2 AND ${WORKFLOW_NOTICE_CURRENT}
    ) AS current`,
    [owner, deliveryId.slice(prefix.length)],
  );
  return row?.current === true;
}
