import type { Database } from "../db/client";
import { workflowNoticeIsCurrent } from "./workflow-notifications";

export type PersonalNotificationSource = "approval" | "question";
type Reader = Pick<Database["$client"], "unsafe">;

/** Aliases r and s are the completed firing and its schedule. Successful results remain history. */
export const SCHEDULE_NOTICE_CURRENT = `r.status IN ('ok','failed') AND s.status<>'cancelled'
  AND NOT (r.status='ok' AND NOT r.manual AND r.result='巡检完成：暂无需要打扰用户的事项')
  AND (r.status='ok' OR NOT EXISTS (
    SELECT 1 FROM chisabot_schedule_runs newer
    WHERE newer.schedule_id=r.schedule_id AND newer.owner_user_id=r.owner_user_id
      AND newer.status IN ('ok','failed') AND newer.finished_at>r.finished_at
  ))`;

/** Aliases e and t are the task event and task. A retry supersedes its previous failure. */
export const TASK_NOTICE_CURRENT = `(
  (e.type='delivered' AND t.status='succeeded') OR
  (e.type='failed' AND t.status='failed' AND e.id=(
    SELECT latest.id FROM chisabot_task_center_events latest
    WHERE latest.task_id=t.id AND latest.owner_user_id=t.owner_user_id AND latest.type='failed'
    ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1
  ))
)`;

/** A saved intent is checked again under the outbox lease, including after a rejected send. */
export async function personalNoticeIsCurrent(
  sql: Reader,
  owner: string,
  deliveryId: string,
  source?: PersonalNotificationSource,
): Promise<boolean> {
  const prefix = `personal:${owner}:`;
  if (!deliveryId.startsWith(prefix)) return true;
  const noticeId = deliveryId.slice(prefix.length);
  let query: string;
  let id: string;
  if (noticeId.startsWith("workflow-event:"))
    return workflowNoticeIsCurrent(sql, owner, deliveryId);
  if (noticeId.startsWith("schedule:")) {
    id = noticeId.slice("schedule:".length);
    query = `SELECT 1 FROM chisabot_schedule_runs r
      JOIN chisabot_schedules s ON s.id=r.schedule_id AND s.owner_user_id=r.owner_user_id
      WHERE r.owner_user_id=$1 AND r.id=$2 AND ${SCHEDULE_NOTICE_CURRENT}`;
  } else if (noticeId.startsWith("task-event:")) {
    id = noticeId.slice("task-event:".length);
    query = `SELECT 1 FROM chisabot_task_center_events e
      JOIN chisabot_task_center_tasks t ON t.id=e.task_id AND t.owner_user_id=e.owner_user_id
      WHERE e.owner_user_id=$1 AND e.id=$2 AND ${TASK_NOTICE_CURRENT}`;
  } else if (noticeId.startsWith("task-decision:")) {
    id = noticeId.slice("task-decision:".length);
    query = `SELECT 1 FROM chisabot_task_center_decisions d
      JOIN chisabot_task_center_tasks t ON t.id=d.task_id AND t.owner_user_id=d.owner_user_id
      WHERE d.owner_user_id=$1 AND d.id=$2 AND d.status='pending'
        AND t.status='waiting_approval' AND t.version=d.task_version`;
  } else if (noticeId.startsWith("confirmation:")) {
    id = noticeId.slice("confirmation:".length);
    query = `SELECT 1 FROM chisabot_confirm_requests
      WHERE owner_user_id=$1 AND id=$2 AND status='pending' AND expires_at>now()`;
  } else if (source === "approval") {
    id = noticeId;
    query =
      "SELECT 1 FROM approval_requests WHERE owner_user_id=$1 AND id=$2 AND status='pending'";
  } else if (source === "question") {
    id = noticeId;
    query = `SELECT 1 FROM work_items WHERE kind='person.question' AND key=$2
      AND payload->>'actorId'=$1 AND finished_at IS NULL`;
  } else return true;
  const [row] = await sql.unsafe<{ current: boolean }[]>(
    `SELECT EXISTS (${query}) AS current`,
    [owner, id],
  );
  return row?.current === true;
}
