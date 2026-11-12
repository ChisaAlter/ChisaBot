import type { Database } from "../db/client";
import type { PersonalSourcesService } from "../personal-sources/service";
import {
  type PersonalNotificationSource,
  SCHEDULE_NOTICE_CURRENT,
  TASK_NOTICE_CURRENT,
} from "./personal-notification-state";
import { WORKFLOW_NOTICE_CURRENT } from "./workflow-notifications";

type Notice = {
  id: string;
  owner: string;
  title: string;
  message: string;
  thread_id?: string | null;
  agent_id?: string | null;
  path?: string | null;
  source?: PersonalNotificationSource | null;
};

/** Recover committed task/workflow results into their durable notification intents. */
export function createPersonalNotifications(options: {
  database: Database;
  sources: Pick<PersonalSourcesService, "notify" | "flushNotifications">;
  publicUrl?: string;
}) {
  const sql = options.database.$client;
  let publicOrigin = "";
  if (options.publicUrl) {
    const url = new URL(options.publicUrl);
    if (url.protocol === "https:" || url.protocol === "http:")
      publicOrigin = url.origin;
  }
  const report = (id: string, state: string) =>
    console.warn(
      JSON.stringify({
        type: "personal-notification",
        id,
        state,
      }),
    );

  async function deliver(notice: Notice) {
    // A previously staged intent owns its original text and target, including unknown outcomes.
    // The regular flush handles queued work; producers must never overwrite or resend it.
    const [existing] = await sql.unsafe(
      "SELECT id FROM chisabot_personal_deliveries WHERE id=$1 AND owner_user_id=$2",
      [`personal:${notice.owner}:${notice.id}`, notice.owner],
    );
    if (existing) return;
    const link =
      publicOrigin && notice.path ? `\n${publicOrigin}${notice.path}` : "";
    const outcome = await options.sources.notify(notice.owner, {
      id: notice.id,
      title: notice.title,
      message: `${notice.message.slice(0, 2000 - link.length)}${link}`,
      ...(notice.thread_id ? { threadId: notice.thread_id } : {}),
      ...(notice.agent_id ? { agentId: notice.agent_id } : {}),
      ...(notice.source ? { notificationSource: notice.source } : {}),
    });
    if (outcome.state === "failed" || outcome.state === "outcome_unknown")
      report(notice.id, outcome.state);
  }

  async function sweep() {
    // Older approvals/questions kept their original unprefixed IDs. Attach only their source
    // type before flushing; the saved target and message remain the same, even after a decision.
    await sql.unsafe(`
      WITH sources AS (
        SELECT id,owner_user_id AS owner,'approval'::text AS source FROM approval_requests
        UNION ALL
        SELECT key,payload->>'actorId','question'::text FROM work_items WHERE kind='person.question'
      )
      UPDATE chisabot_personal_deliveries d
      SET payload=jsonb_set(d.payload,'{notificationSource}',to_jsonb(s.source))
      FROM sources s
      WHERE d.id='personal:' || s.owner || ':' || s.id AND d.owner_user_id=s.owner
        AND d.kind='notify' AND d.state='queued' AND NOT (d.payload ? 'notificationSource')
    `);
    // Existing authoritative rows are the recovery cursor. Only events after explicit connection
    // are eligible, so connecting a phone never releases years of historical notifications.
    const rows = await sql.unsafe<Notice[]>(`
      WITH tasks AS (
        SELECT *, CASE WHEN jsonb_typeof(payload)='string' THEN (payload #>> '{}')::jsonb ELSE payload END AS body
        FROM chisabot_task_center_tasks
      ), candidates AS (
        SELECT 'schedule:' || r.id AS id, r.owner_user_id AS owner,
          CASE r.status WHEN 'ok' THEN '定时任务完成' ELSE '定时任务需要处理' END AS title,
          s.title || E'\n' || coalesce(r.result, '请打开定时任务查看结果。') AS message,
          s.thread_id, s.agent_id, '/settings/schedules' AS path, r.finished_at AS at, NULL::text AS source
        FROM chisabot_schedule_runs r JOIN chisabot_schedules s ON s.id=r.schedule_id AND s.owner_user_id=r.owner_user_id
        WHERE ${SCHEDULE_NOTICE_CURRENT}
        UNION ALL
        SELECT 'task-event:' || e.id, e.owner_user_id,
          CASE e.type WHEN 'delivered' THEN '任务完成' ELSE '任务需要处理' END,
          coalesce(t.body->>'title','任务') || E'\n' || CASE e.type WHEN 'delivered' THEN coalesce(t.summary,e.message) ELSE e.message END,
          'task-center:' || t.id, t.body->>'agentId', '/tasks?view=history&task=' || t.id, e.created_at, NULL::text
        FROM chisabot_task_center_events e JOIN tasks t ON t.id=e.task_id AND t.owner_user_id=e.owner_user_id
        WHERE ${TASK_NOTICE_CURRENT}
        UNION ALL
        SELECT 'task-decision:' || d.id, d.owner_user_id, '任务等待确认',
          coalesce(t.body->>'title','任务') || E'\n' || d.summary,
          'task-center:' || t.id, t.body->>'agentId', '/tasks?view=outbox&task=' || t.id, d.created_at, NULL::text
        FROM chisabot_task_center_decisions d JOIN tasks t ON t.id=d.task_id AND t.owner_user_id=d.owner_user_id
        WHERE d.status='pending' AND t.status='waiting_approval' AND t.version=d.task_version
        UNION ALL
        SELECT 'workflow-event:' || e.id, r.owner_user_id,
          CASE r.status WHEN 'waiting_approval' THEN '工作流等待确认'
            WHEN 'succeeded' THEN '工作流完成' ELSE '工作流需要处理' END,
          r.workflow_name || E'\n' || CASE WHEN r.status='succeeded' THEN coalesce(nullif(r.output,''),e.message) ELSE e.message END,
          NULL::text, NULL::text, '/workflows/runs/' || r.id, e.at, NULL::text
        FROM workflow_runs r
        JOIN LATERAL (
          SELECT * FROM workflow_run_events
          WHERE run_id=r.id AND kind IN ('approval_requested','run_finished','run_failed')
          ORDER BY at DESC,id DESC LIMIT 1
        ) e ON true
        WHERE ${WORKFLOW_NOTICE_CURRENT}
        UNION ALL
        SELECT 'confirmation:' || c.id, c.owner_user_id, '操作等待确认',
          c.title || E'\n请在 ChisaBot 中查看完整内容并批准或拒绝。', c.thread_id, c.agent_id, '/approvals', c.created_at, NULL::text
        FROM chisabot_confirm_requests c WHERE c.status='pending' AND c.expires_at>now()
        UNION ALL
        SELECT a.id, a.owner_user_id, '操作等待批准',
          '请求使用 ' || coalesce(a.action->>'toolRef','工具') || '。请在 ChisaBot 中查看完整内容并批准或拒绝。',
          a.action->>'threadId', a.action->>'botId', '/approvals', a.created_at, 'approval'::text
        FROM approval_requests a WHERE a.status='pending'
        UNION ALL
        SELECT w.key, w.payload->>'actorId', '等待你的回答', w.payload->>'question',
          w.payload->>'threadId', coalesce(w.payload->>'sourceBotId',w.payload->>'botId'), '/approvals', w.created_at, 'question'::text
        FROM work_items w WHERE w.kind='person.question' AND w.finished_at IS NULL
      )
      SELECT c.* FROM candidates c
      JOIN chisabot_personal_sources p ON p.owner_user_id=c.owner
      WHERE p.notify_webhook_enc IS NOT NULL AND c.at>=p.notify_connected_at
        AND c.message IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM chisabot_personal_deliveries d WHERE d.id='personal:' || c.owner || ':' || c.id)
      ORDER BY c.at,c.id LIMIT 100
    `);
    for (const notice of rows) {
      try {
        await deliver(notice);
      } catch {
        report(notice.id, "staging_failed");
      }
    }
    await options.sources.flushNotifications();
  }
  return { deliver, sweep };
}
