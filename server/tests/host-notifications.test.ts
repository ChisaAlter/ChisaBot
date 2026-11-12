import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatabase } from "../src/db/client";
import { DeliveryOutcomeUnknownError } from "../src/delivery/durable-dispatch";
import { createHostNotifications } from "../src/delivery/host-notifications";
import { createPersonalNotifications } from "../src/delivery/personal-notifications";
import { createPersonalDelivery } from "../src/personal-sources/delivery";
import { testDatabaseUrl } from "./support/database";

const schema = `host_notice_${randomUUID().replaceAll("-", "")}`;
const url = new URL(testDatabaseUrl());
url.searchParams.set("search_path", schema);
const database = createDatabase(url.href, { max: 2 });
const sql = database.$client;
const deliveries = createPersonalDelivery(database);
const sent: string[] = [];
const observed: string[] = [];
let directory: string;
let unknown = false;
type Observation = {
  owner: string | null;
  checkedAt: string;
  checks: { check: string; ok: boolean }[];
  incident: {
    id: string;
    startedAt: string;
    changedAt: string;
    revision: number;
    failures: string[];
    recoveredAt: string | null;
  } | null;
};
async function observe(
  checks: Observation["checks"],
  owner = "owner",
): Promise<Observation> {
  const child = Bun.spawn(
    [
      "node",
      resolve("deploy/updater/host-monitor-state.mjs"),
      join(directory, "state", "host-monitor.json"),
    ],
    {
      env: { ...process.env, CHISABOT_MONITOR_NOTIFY_OWNER: owner },
      stdin: new TextEncoder().encode(
        checks.map((check) => JSON.stringify(check)).join("\n"),
      ),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(`Observation failed: ${err}`);
  observed.push(JSON.parse(out).state);
  return JSON.parse(
    await readFile(join(directory, "state", "host-monitor.json"), "utf8"),
  );
}
const relay = createPersonalNotifications({
  database,
  publicUrl: "https://assistant.example",
  sources: {
    notify: async (owner, input) => {
      const id = await deliveries.stage(
        owner,
        "notify",
        "connected",
        {
          target: "isolated recipient",
          title: input.title ?? "通知",
          body: input.message,
        },
        input,
      );
      await deliveries.dispatch(id, async () => ({
        send: async () => {
          sent.push(id);
          if (unknown)
            throw new DeliveryOutcomeUnknownError(
              "Receipt missing in isolated transport",
            );
          return {
            type: "personal_delivery",
            id,
            channel: "notify",
            state: "accepted",
            providerMessageIds: [id],
            summary: "accepted by isolated transport",
          };
        },
      }));
      const row = await deliveries.get(id);
      return { id, state: row?.state ?? "queued" };
    },
    flushNotifications: async () => {},
  },
});
const sweep = () =>
  createHostNotifications({
    updaterDir: directory,
    database,
    deliver: relay.deliver,
  })();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "chisabot-host-notice-"));
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(
    "CREATE TABLE chisabot_personal_sources(owner_user_id text PRIMARY KEY,notify_webhook_enc text,notify_connected_at timestamptz)",
  );
  await deliveries.ensure();
  await sql.unsafe(
    "INSERT INTO chisabot_personal_sources VALUES ('owner','configured',now()-interval '1 day'), ('other','configured',now()-interval '1 day'), ('unbound',NULL,now())",
  );
});
afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  await sql.end();
  await rm(directory, { recursive: true, force: true });
});

test("real host observation keeps one incident through failure and recovery; ledger sends each notice once", async () => {
  await sweep(); // No observation yet.
  const failing = await observe([
    { check: "app", ok: false },
    { check: "dsh", ok: true },
  ]);
  expect(failing.incident?.failures).toEqual(["app"]);
  const repeated = await observe([{ check: "app", ok: false }]);
  expect(repeated.incident?.id).toBe(failing.incident?.id);
  await sweep();
  await sweep();
  expect(sent).toHaveLength(1);
  const id = `personal:owner:host:${failing.incident?.id}:failed:1`;
  const record = await deliveries.get(id);
  expect(record?.state).toBe("sent");
  expect(record?.payload.body).toContain("核心服务");
  expect(record?.payload.body).toContain(
    "https://assistant.example/admin/system-update",
  );
  const recovered = await observe([
    { check: "app", ok: true },
    { check: "backup", ok: false },
  ]);
  expect(recovered.incident?.id).toBe(failing.incident?.id);
  expect(recovered.incident?.recoveredAt).toBeTruthy();
  await sweep();
  await sweep();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(`personal:owner:host:${failing.incident?.id}:recovered`);
}, 30000);

test("API resumes after an outage with both persisted notices; a new outage creates a new identity", async () => {
  const next = await observe([{ check: "dsh", ok: false }]);
  await observe([{ check: "dsh", ok: true }]);
  await sweep();
  expect(sent.slice(-2)).toEqual([
    `personal:owner:host:${next.incident?.id}:failed:1`,
    `personal:owner:host:${next.incident?.id}:recovered`,
  ]);
  expect(new Set(sent).size).toBe(sent.length);
}, 30000);

for (const initialDelivered of [false, true]) {
  test(`a changed fault replaces the current checks and notifies once (initial delivered: ${initialDelivered})`, async () => {
    const before = sent.length;
    const initial = await observe([
      { check: "app", ok: false },
      { check: "disk", ok: true },
    ]);
    if (initialDelivered) await sweep();
    const changed = await observe([
      { check: "app", ok: true },
      { check: "disk", ok: false },
    ]);
    expect(changed.incident?.id).toBe(initial.incident?.id);
    expect(changed.incident?.failures).toEqual(["disk"]);
    expect(changed.incident?.revision).toBe(2);
    await sweep();
    await observe([
      { check: "disk", ok: false },
      { check: "app", ok: true },
    ]);
    await sweep();
    const id = `personal:owner:host:${changed.incident?.id}:failed:2`;
    const row = await deliveries.get(id);
    expect(row?.payload.body).toContain("磁盘空间");
    expect(row?.payload.body).not.toContain("核心服务");
    expect(sent.filter((value) => value === id)).toHaveLength(1);
    await observe([
      { check: "app", ok: true },
      { check: "disk", ok: true },
    ]);
    await sweep();
    expect(sent.at(-1)).toBe(
      `personal:owner:host:${changed.incident?.id}:recovered`,
    );
    expect(sent.length).toBe(before + (initialDelivered ? 3 : 2));
  }, 30000);
}

test("unconfigured, late-connected and switched recipients cannot receive a previous owner's incident", async () => {
  const before = sent.length;
  await observe([{ check: "app", ok: false }], "");
  await sweep();
  expect(observed.at(-1)).toBe("not_configured");
  await observe([{ check: "app", ok: false }], "unbound");
  await sweep();
  const old = await observe([{ check: "app", ok: false }], "owner");
  await sql.unsafe(
    "UPDATE chisabot_personal_sources SET notify_connected_at=now()+interval '1 minute' WHERE owner_user_id='owner'",
  );
  await sweep();
  expect(sent.length).toBe(before);
  const other = await observe([{ check: "disk", ok: false }], "other");
  expect(other.incident?.id).not.toBe(old.incident?.id);
  await sweep();
  expect(sent.at(-1)).toBe(
    `personal:other:host:${other.incident?.id}:failed:1`,
  );
}, 30000);

test("an unknown transport result stays in the existing ledger and never resends on the next sweep", async () => {
  await observe([{ check: "disk", ok: true }], "other");
  await sweep();
  const failure = await observe([{ check: "certificate", ok: false }], "other");
  const before = sent.length;
  unknown = true;
  await sweep();
  await sweep();
  expect(sent.length).toBe(before + 1);
  const row = await deliveries.get(
    `personal:other:host:${failure.incident?.id}:failed:1`,
  );
  expect(row?.state).toBe("outcome_unknown");
  unknown = false;
}, 30000);
