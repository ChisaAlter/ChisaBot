import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase } from "../src/db/client";
import { createPersonalNotifications } from "../src/delivery/personal-notifications";
import { createPersonalDelivery } from "../src/personal-sources/delivery";
import { createWorkflowStore } from "../src/workflows/store";
import { testDatabaseUrl } from "./support/database";

const schema = `notification_${randomUUID().replaceAll("-", "")}`;
const database = createDatabase(`${testDatabaseUrl()}?search_path=${schema}`, {
  max: 2,
});
const sql = database.$client;
const sent: string[] = [];
const deliveries = createPersonalDelivery(database);
let flushes = 0;
const sources = {
  notify: async (
    owner: string,
    input: { id: string; title?: string; message: string },
  ) => {
    const id = await deliveries.stage(
      owner,
      "notify",
      "connected",
      { target: "fixture", title: input.title!, body: input.message },
      input,
    );
    sent.push(input.id);
    await sql.unsafe(
      "UPDATE chisabot_personal_deliveries SET state='sent' WHERE id=$1",
      [id],
    );
    return { id, state: "sent" as const };
  },
  flushNotifications: async () => {
    flushes++;
  },
};
const relay = () =>
  createPersonalNotifications({
    database,
    sources,
    publicUrl: "https://assistant.example",
  });

beforeAll(async () => {
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`
    CREATE TABLE chisabot_personal_sources(owner_user_id text PRIMARY KEY,notify_webhook_enc text,notify_connected_at timestamptz);
    CREATE TABLE chisabot_schedules(id text PRIMARY KEY,owner_user_id text,title text,thread_id text,agent_id text,status text);
    CREATE TABLE chisabot_schedule_runs(id text PRIMARY KEY,schedule_id text,owner_user_id text,status text,result text,manual boolean DEFAULT false,finished_at timestamptz DEFAULT now());
    CREATE TABLE chisabot_task_center_tasks(id text PRIMARY KEY,owner_user_id text,payload jsonb,status text,summary text,version int DEFAULT 1);
    CREATE TABLE chisabot_task_center_events(id text PRIMARY KEY,owner_user_id text,task_id text,type text,message text,created_at timestamptz DEFAULT now());
    CREATE TABLE chisabot_task_center_decisions(id text PRIMARY KEY,owner_user_id text,task_id text,task_version int,summary text,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE chisabot_confirm_requests(id text PRIMARY KEY,owner_user_id text,title text,thread_id text,agent_id text,status text,expires_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE approval_requests(id text PRIMARY KEY,owner_user_id text,action jsonb,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE work_items(key text PRIMARY KEY,kind text,payload jsonb,finished_at timestamptz,created_at timestamptz DEFAULT now());
  `);
  const workflowMigration = await readFile(
    new URL("../drizzle/0055_workflows.sql", import.meta.url),
    "utf8",
  );
  await sql.unsafe(
    workflowMigration.replaceAll(
      '"public"."workflow_runs"',
      `"${schema}"."workflow_runs"`,
    ),
  );
  const migration = await readFile(
    new URL("../drizzle/0065_personal_delivery.sql", import.meta.url),
    "utf8",
  );
  await sql.unsafe(migration);
  const columns = await sql.unsafe<{ column_name: string }[]>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='chisabot_personal_deliveries'",
    [schema],
  );
  expect(columns.map((column) => column.column_name)).toContain("attempts");
  expect(columns.map((column) => column.column_name)).toContain(
    "next_attempt_at",
  );
  await deliveries.ensure();
  await sql.unsafe(migration);
  await sql.unsafe(
    "INSERT INTO chisabot_personal_sources VALUES ('owner','encrypted-fixture',now()-interval '1 minute','Asia/Shanghai'),('unconnected',NULL,NULL,'Asia/Shanghai')",
  );
}, 60000);

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  await sql.close();
}, 30000);

test("a committed result recovers after a producer crash and restart does not duplicate it", async () => {
  await sql.unsafe(`INSERT INTO chisabot_schedules VALUES ('schedule','owner','每日资料','thread','bot','active');
    INSERT INTO chisabot_schedule_runs(id,schedule_id,owner_user_id,status,result) VALUES ('result','schedule','owner','ok','今天的资料已整理');`);
  await relay().sweep();
  expect(sent).toEqual(["schedule:result"]);
  await relay().sweep();
  expect(sent).toHaveLength(1);
  const record = await deliveries.get("personal:owner:schedule:result");
  expect(record?.payload.body).toContain(
    "https://assistant.example/settings/schedules",
  );
  await sql.unsafe(
    "UPDATE chisabot_personal_deliveries SET state='outcome_unknown' WHERE id=$1",
    [record!.id],
  );
  await relay().deliver({
    id: "schedule:result",
    owner: "owner",
    title: "changed",
    message: "new text",
  });
  expect(sent).toHaveLength(1);
  expect((await deliveries.get(record!.id))?.payload).toEqual(record?.payload);
  expect(flushes).toBe(2);
}, 30000);

test("only connected-owner new events and live approvals notify; silent and historical events stay quiet", async () => {
  await sql.unsafe(`
    INSERT INTO chisabot_schedule_runs(id,schedule_id,owner_user_id,status,result,finished_at) VALUES
      ('silent','schedule','owner','ok','巡检完成：暂无需要打扰用户的事项',now()),
      ('old','schedule','owner','failed','old',now()-interval '1 day');
    INSERT INTO chisabot_task_center_tasks(id,owner_user_id,payload,status,summary) VALUES
      ('report','owner','{"title":"资料报告","agentId":"bot"}','succeeded','结论与来源'),
      ('decision','owner','{"title":"发布草稿","agentId":"bot"}','waiting_approval',NULL),
      ('unbound','unconnected','{}','succeeded','private');
    INSERT INTO chisabot_task_center_events(id,owner_user_id,task_id,type,message) VALUES
      ('done','owner','report','delivered','已交付'),('unbound','unconnected','unbound','delivered','private');
    INSERT INTO chisabot_task_center_decisions(id,owner_user_id,task_id,task_version,summary,status) VALUES
      ('valid','owner','decision',1,'请查看草稿','pending'),('stale','owner','decision',0,'旧版草稿','pending');
    INSERT INTO chisabot_confirm_requests VALUES
      ('expired','owner','expired','thread','bot','pending',now()-interval '1 minute',now()),
      ('current','owner','确认内容','thread','bot','pending',now()+interval '1 hour',now());
    INSERT INTO approval_requests(id,owner_user_id,action,status) VALUES
      ('approval','owner','{"toolRef":"email_send","threadId":"thread","botId":"bot"}','pending');
    INSERT INTO work_items(key,kind,payload) VALUES
      ('question','person.question','{"actorId":"owner","threadId":"thread","botId":"bot","question":"选哪个草稿？"}');
  `);
  await relay().sweep();
  expect(sent.slice(1).sort()).toEqual([
    "approval",
    "confirmation:current",
    "question",
    "task-decision:valid",
    "task-event:done",
  ]);
  expect(
    (await deliveries.get("personal:owner:task-event:done"))?.payload.body,
  ).toContain("/tasks?view=history&task=report");
  await relay().sweep();
  expect(sent).toHaveLength(6);
  const [column] = await sql.unsafe(
    "SELECT calendar_timezone FROM chisabot_personal_sources WHERE owner_user_id='owner'",
  );
  expect(column?.calendar_timezone).toBe("Asia/Shanghai");
}, 30000);

test("legacy JSON-string task payload and one staging failure do not prevent other notices", async () => {
  await sql.unsafe(`UPDATE chisabot_task_center_tasks SET payload=to_jsonb(payload::text) WHERE id='report';
    INSERT INTO chisabot_task_center_events(id,owner_user_id,task_id,type,message) VALUES
      ('failed-stage','owner','report','delivered','one'),('next','owner','report','delivered','two');`);
  const failing = createPersonalNotifications({
    database,
    sources: {
      ...sources,
      notify: async (owner, input) => {
        if (input.id === "task-event:failed-stage")
          throw Error("database temporarily unavailable");
        return sources.notify(owner, input);
      },
    },
  });
  await failing.sweep();
  expect(sent.at(-1)).toBe("task-event:next");
  expect(
    (await deliveries.get("personal:owner:task-event:next"))?.payload.body,
  ).toStartWith("资料报告");
  await relay().sweep();
  expect(sent.at(-1)).toBe("task-event:failed-stage");
}, 30000);

test("workflow notices recover committed approvals and results without old events or cross-owner delivery", async () => {
  const before = sent.length;
  await sql.unsafe(`
    INSERT INTO workflow_runs(id,owner_user_id,workflow_id,workflow_name,definition,inputs,bindings,status,source,state,output) VALUES
      ('wf-approval','owner','w','审批流程','{}','{}','{}','waiting_approval','page','{"steps":[{"id":"review","status":"waiting_approval"}]}',NULL),
      ('wf-human','owner','w','人工裁决','{}','{}','{}','waiting_approval','page','{"steps":[{"id":"gate","status":"waiting_approval"}]}',NULL),
      ('wf-success','owner','w','完成流程','{}','{}','{}','succeeded','page','{"steps":[]}','交付成果'),
      ('wf-failure','owner','w','失败流程','{}','{}','{}','failed','page','{"steps":[]}',NULL),
      ('wf-old','owner','w','历史流程','{}','{}','{}','succeeded','page','{"steps":[]}',NULL),
      ('wf-other','unconnected','w','他人流程','{}','{}','{}','succeeded','page','{"steps":[]}',NULL),
      ('wf-handled','owner','w','已处理流程','{}','{}','{}','running','page','{"steps":[{"id":"review","status":"running"}]}',NULL);
    INSERT INTO workflow_run_events(id,run_id,kind,step_id,message,at) VALUES
      ('wf-approval-0','wf-approval','approval_requested','review','旧审批',now()-interval '30 seconds'),
      ('wf-approval-1','wf-approval','approval_requested','review','需要批准',now()),
      ('wf-human-1','wf-human','approval_requested','gate','需要人工介入',now()),
      ('wf-success-0','wf-success','run_failed',NULL,'已解决的失败',now()-interval '30 seconds'),
      ('wf-success-1','wf-success','run_finished',NULL,'完成',now()),
      ('wf-failure-1','wf-failure','run_failed',NULL,'失败原因',now()),
      ('wf-old-1','wf-old','run_finished',NULL,'历史完成',now()-interval '1 day'),
      ('wf-other-1','wf-other','run_finished',NULL,'私有内容',now()),
      ('wf-handled-1','wf-handled','approval_requested','review','已处理审批',now());
  `);
  await relay().sweep();
  expect(sent.slice(before).sort()).toEqual([
    "workflow-event:wf-approval-1",
    "workflow-event:wf-failure-1",
    "workflow-event:wf-human-1",
    "workflow-event:wf-success-1",
  ]);
  const notice = await deliveries.get(
    "personal:owner:workflow-event:wf-success-1",
  );
  expect(notice?.payload.body).toContain("交付成果");
  expect(notice?.payload.body).toContain(
    "https://assistant.example/workflows/runs/wf-success",
  );
  await relay().sweep();
  expect(sent.length).toBe(before + 4);
}, 30000);

test("queued workflow notices are rechecked before delivery; handled, retried and deleted runs stay quiet", async () => {
  for (const [suffix, status] of [
    ["handled", "waiting_approval"],
    ["retried", "failed"],
    ["deleted", "succeeded"],
    ["current", "succeeded"],
  ]) {
    await sql.unsafe(
      `INSERT INTO workflow_runs(id,owner_user_id,workflow_id,workflow_name,definition,inputs,bindings,status,source,state)
      VALUES($1,'owner','w','通知流程','{}','{}','{}',$2,'page','{"steps":[{"id":"review","status":"waiting_approval"}]}')`,
      [`queued-${suffix}`, status],
    );
    await sql.unsafe(
      "INSERT INTO workflow_run_events(id,run_id,kind,step_id,message) VALUES($1,$2,$3,'review','通知内容')",
      [
        `queued-${suffix}`,
        `queued-${suffix}`,
        status === "waiting_approval"
          ? "approval_requested"
          : status === "failed"
            ? "run_failed"
            : "run_finished",
      ],
    );
    await deliveries.stage(
      "owner",
      "notify",
      "connected",
      { target: "fixture", title: "通知", body: "通知内容" },
      { id: `workflow-event:queued-${suffix}` },
    );
  }
  await sql.unsafe(
    "UPDATE workflow_runs SET status='running' WHERE id='queued-handled'; UPDATE workflow_runs SET status='queued' WHERE id='queued-retried'; DELETE FROM workflow_runs WHERE id='queued-deleted';",
  );
  const delivered: string[] = [];
  for (const suffix of ["handled", "retried", "deleted", "current"]) {
    const id = `personal:owner:workflow-event:queued-${suffix}`;
    await deliveries.dispatch(id, async () => ({
      send: async () => {
        delivered.push(id);
        return {
          type: "personal_delivery",
          id,
          channel: "notify",
          state: "accepted",
          providerMessageIds: ["local-receipt"],
          summary: "fixture accepted",
        };
      },
    }));
    expect((await deliveries.get(id))?.state).toBe(
      suffix === "current" ? "sent" : "cancelled",
    );
  }
  expect(delivered).toEqual(["personal:owner:workflow-event:queued-current"]);
}, 30000);

test("workflow status and notice event commit together, including stale-run recovery", async () => {
  const store = createWorkflowStore(database);
  await sql.unsafe(`INSERT INTO workflow_runs(id,owner_user_id,workflow_id,workflow_name,definition,inputs,bindings,status,source,state,updated_at)
    VALUES('atomic','owner','w','原子提交','{}','{}','{}','running','page','{"steps":[]}',now()-interval '10 minutes');
    ALTER TABLE workflow_run_events ADD CONSTRAINT event_rejected CHECK (kind<>'test_rejected');`);
  let rejected: unknown;
  // Await the real transaction directly: Bun 1.3.14's rejects matcher stalls its BEGIN callback.
  try {
    await store.saveRun(
      "atomic",
      { status: "succeeded", output: "不能独自落库" },
      { kind: "test_rejected", message: "拒绝事件" },
    );
  } catch (error) {
    rejected = error;
  }
  expect(rejected).toBeInstanceOf(Error);
  expect(String((rejected as Error & { cause?: unknown }).cause)).toContain(
    "event_rejected",
  );
  expect((await store.getRun("atomic"))?.status).toBe("running");
  await store.saveRun(
    "atomic",
    { status: "waiting_approval" },
    { kind: "approval_requested", message: "审批", stepId: "review" },
  );
  expect((await store.events("atomic")).map((e) => e.kind)).toEqual([
    "approval_requested",
  ]);
  await sql.unsafe(
    "UPDATE workflow_runs SET status='running',updated_at=now()-interval '10 minutes' WHERE id='atomic'",
  );
  const recovered = await store.failStaleRun(
    "atomic",
    new Date(),
    {
      state: { steps: [], tokens: 0, stepsRun: 0, elapsedMs: 0 },
      error: "重启中断",
      finishedAt: new Date(),
    },
    { kind: "run_failed", message: "重启中断" },
  );
  expect(recovered).toBe(true);
  expect((await store.getRun("atomic"))?.status).toBe("failed");
  expect((await store.events("atomic")).map((e) => e.kind)).toEqual([
    "approval_requested",
    "run_failed",
  ]);
}, 30000);
