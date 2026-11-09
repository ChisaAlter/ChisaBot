import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDatabase } from "../src/db/client";
import { collectOpsHealth, createAssistantSignalsProbe } from "../src/ops-health";
import { testDatabaseUrl } from "./support/database";

const schema = `assistant_signals_${randomUUID().replaceAll("-", "")}`;
const database = createDatabase(`${testDatabaseUrl()}?search_path=${schema}`, { max: 2 });
const sql = database.$client;
const probe = createAssistantSignalsProbe(database);

beforeAll(async () => {
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`
    CREATE TABLE chisabot_task_center_tasks(id text PRIMARY KEY,owner_user_id text,status text,created_at timestamptz DEFAULT now(),finished_at timestamptz);
    CREATE INDEX chisabot_task_center_owner ON chisabot_task_center_tasks(owner_user_id,created_at);
    CREATE TABLE chisabot_schedule_runs(id text PRIMARY KEY,owner_user_id text,status text,finished_at timestamptz);
    CREATE INDEX chisabot_schedule_runs_owner ON chisabot_schedule_runs(owner_user_id,finished_at DESC);
    CREATE TABLE chisabot_personal_deliveries(id text PRIMARY KEY,owner_user_id text,state text,created_at timestamptz DEFAULT now());
    CREATE INDEX chisabot_personal_deliveries_owner ON chisabot_personal_deliveries(owner_user_id,created_at);
    CREATE TABLE chisabot_local_threads(id text PRIMARY KEY,owner_user_id text,updated_at timestamptz DEFAULT now());
    CREATE INDEX chisabot_local_threads_owner_updated ON chisabot_local_threads(owner_user_id,updated_at DESC NULLS FIRST);
    CREATE TABLE chisabot_runtime_bindings(id text PRIMARY KEY,thread_id text,owner_user_id text,session_id text,revision int,kernel text DEFAULT 'dsh',UNIQUE(thread_id,revision));
    CREATE TABLE chisabot_tool_operations(id text PRIMARY KEY,owner_user_id text,binding_id text,session_id text,turn_number int,step_number int,call_id text,status text,
      UNIQUE(binding_id,session_id,turn_number,step_number,call_id));
  `);
}, 30000);

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  await sql.close();
}, 30000);

test("actual PG: three completed failures and unknown receipts surface without failing image readiness", async () => {
  await sql.unsafe(`
    INSERT INTO chisabot_task_center_tasks(id,owner_user_id,status,created_at,finished_at) VALUES
      ('failed-1','owner','failed',now()-interval '1 minute',now()-interval '1 minute'),
      ('failed-2','owner','failed',now()-interval '2 minutes',now()-interval '2 minutes'),
      ('failed-3','owner','failed',now()-interval '3 minutes',now()-interval '3 minutes'),
      ('success','owner','succeeded',now()-interval '4 minutes',now()-interval '4 minutes'),
      ('paused','owner','paused',now(),NULL),('approval','owner','waiting_approval',now(),NULL),
      ('other-owner','other','succeeded',now(),now());
    INSERT INTO chisabot_personal_deliveries(id,owner_user_id,state) VALUES
      ('private-delivery','owner','outcome_unknown'),('private-other','other','outcome_unknown');
    INSERT INTO chisabot_local_threads VALUES ('thread','owner',now()),('other-thread','other',now());
    INSERT INTO chisabot_runtime_bindings(id,thread_id,owner_user_id,session_id,revision) VALUES ('binding','thread','owner','session',1),('other-binding','other-thread','other','other-session',1);
    INSERT INTO chisabot_tool_operations VALUES
      ('private-operation','owner','binding','session',1,1,'one','outcome_unknown'),
      ('waiting-operation','owner','binding','session',1,2,'two','waiting_approval'),
      ('other-operation','other','other-binding','other-session',1,1,'one','outcome_unknown');
  `);
  const signals = await probe("owner");
  expect(signals.state).toBe("needs_attention");
  expect(signals.taskFailureStreak).toBe(3);
  expect(signals.unknown).toEqual({ personalDeliveriesAtLeast: 1, toolOperationsAtLeast: 1 });
  const health = await collectOpsHealth({ pingDatabase: async () => ({ ok: true }),
    gatewayMode: "on", probeAssistant: () => probe("owner") });
  expect(health.ok).toBe(true);
  expect(health.checks.assistant.ok).toBe(false);
  expect(JSON.stringify(signals)).not.toContain("private-");
  expect((await sql.unsafe("SELECT status FROM chisabot_tool_operations WHERE id='private-operation'"))[0].status).toBe("outcome_unknown");
  const child = Bun.spawn([process.execPath, "deploy/dsh/ops.ts", "signals"], {
    // Local checkout is isolated-linked; production Docker explicitly installs a hoisted tree.
    env: { ...process.env, NODE_PATH: resolve("server/node_modules"), DATABASE_URL: `${testDatabaseUrl()}?search_path=${schema}` }, stdout: "pipe", stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(output, await new Response(child.stderr).text()).not.toBe("");
  expect(await child.exited).toBe(1);
  const hostSignals = JSON.parse(output);
  expect(hostSignals.state).toBe("needs_attention");
  expect(hostSignals.unknown).toEqual({ personalDeliveriesAtLeast: 2, toolOperationsAtLeast: 2 });
  expect(output).not.toContain("other-operation");
}, 30000);

test("actual PG: a newer success clears the completion streak; paused and pending approvals are not failures", async () => {
  await sql.unsafe(`UPDATE chisabot_task_center_tasks SET status='succeeded' WHERE id='failed-1';
    UPDATE chisabot_personal_deliveries SET state='sent' WHERE id='private-delivery';
    UPDATE chisabot_tool_operations SET status='completed' WHERE id='private-operation';`);
  const signals = await probe("owner");
  expect(signals.state).toBe("clear_in_sample");
  expect(signals.taskFailureStreak).toBe(0);
  expect(signals.unknown.toolOperationsAtLeast).toBe(0);
  expect(signals.coverage.unknownCounts).toBe("lower_bound");
  expect((await sql.unsafe("SELECT status FROM chisabot_task_center_tasks WHERE id='paused'"))[0].status).toBe("paused");
  expect((await sql.unsafe("SELECT status FROM chisabot_tool_operations WHERE id='waiting-operation'"))[0].status).toBe("waiting_approval");
}, 30000);

test("actual PG: schedule streak uses terminal results within 24h and resets on a successful result", async () => {
  await sql.unsafe(`INSERT INTO chisabot_schedule_runs VALUES
    ('old','owner','failed',now()-interval '2 days'),
    ('s1','owner','failed',now()-interval '3 minutes'),
    ('s2','owner','failed',now()-interval '2 minutes'),
    ('s3','owner','failed',now()-interval '1 minute'),
    ('waiting','owner','waiting',NULL),('running','owner','running',NULL);`);
  expect((await probe("owner")).scheduleFailureStreak).toBe(3);
  expect((await probe("owner")).state).toBe("needs_attention");
  await sql.unsafe("UPDATE chisabot_schedule_runs SET status='ok' WHERE id='s3'");
  expect((await probe("owner")).scheduleFailureStreak).toBe(0);
  expect((await probe("owner")).state).toBe("clear_in_sample");
}, 30000);

test("actual PG: a clear bounded sample never claims the entire ledger has no unknown outcome", async () => {
  await sql.unsafe(`UPDATE chisabot_personal_deliveries SET state='outcome_unknown',created_at=now()-interval '1 year' WHERE id='private-delivery';
    INSERT INTO chisabot_personal_deliveries(id,owner_user_id,state,created_at)
    SELECT 'recent-'||n,'owner','sent',now() FROM generate_series(1,101) n;`);
  const signals = await probe("owner");
  expect(signals.state).toBe("clear_in_sample");
  expect(signals.unknown.personalDeliveriesAtLeast).toBe(0);
  expect(signals.coverage.personalDeliveries).toBe(100);
  expect(signals.coverage.deliveryLimit).toBe(100);
  expect(signals.coverage.scope).toBe("owner_recent_sample");
  expect(signals.coverage.unknownCounts).toBe("lower_bound");
  expect(signals.coverage.imOutbox).toBe("not_sampled");
  expect((await sql.unsafe("SELECT state FROM chisabot_personal_deliveries WHERE id='private-delivery'"))[0].state).toBe("outcome_unknown");
}, 30000);
