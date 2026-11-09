import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { defaultCapabilities } from "../../shared/devices";
import type { DeviceRecord } from "../src/devices/store";
import { createDatabase } from "../src/db/client";
import { createLocalConversations } from "../src/local-conversations";
import { createLocalAgentService } from "../src/local-agents/service";
import { backgroundCount, executionClass } from "../src/conversations/capacity";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
async function until(check: () => Promise<unknown>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw new Error("Capacity state did not settle"); await Bun.sleep(20); }
}

describe.skipIf(!url)("shared background capacity device lifecycle (PostgreSQL)", () => {
  const database = url ? createDatabase(url, TEST_POOL) : null!;
  const sql = database?.$client;
  const owner = `capacity-device-${randomUUID()}`, bot = `${owner}-bot`;
  let backend: Awaited<ReturnType<typeof createLocalConversations>>;
  let device: DeviceRecord = { id: `${owner}-device`, ownerUserId: owner, name: "capacity fixture", platform: "linux", osVersion: null,
    hostname: "fixture", arch: "x64", clientVersion: "0.1.8", capabilities: { ...defaultCapabilities(), shell: "allow", files_read: "allow", files_write: "allow" },
    allowedRoots: ["/tmp/capacity-fixture"], paused: false, revoked: false, lastSeenAt: null, lastIp: null, createdAt: new Date().toISOString(), botIds: [], lastUsedBy: null,
    tokenHash: "fixture", fullAccessUntil: new Date(Date.now() + 60_000).toISOString() };
  const sent: any[] = [];
  let decision: ((value: { approved: boolean; by: string }) => void) | undefined;
  let pendingDeviceRead: (() => void) | undefined;
  let delayDeviceRead = false;
  const store = { get: async () => { if (delayDeviceRead) { delayDeviceRead = false; await new Promise<void>(resolve => pendingDeviceRead = resolve); } return device; },
    forOwner: async () => [device], audit: async () => "fixture-audit" };
  const hub = { isOnline: () => true, sendRaw: (_id: string, value: any) => (sent.push(value), true), decide: () => true,
    requestUserApproval: async (_record: any, _input: any, created: (id: string) => void) => { created(randomUUID()); return new Promise<{ approved: boolean; by: string }>(resolve => decision = resolve); } };
  let finishModel: (() => void) | undefined;
  let modelStarted = false, modelAborted = false;
  const options = { database, hub: hub as never, deviceStore: store as never, generate: async ({ signal }: { signal: AbortSignal }) => {
    modelStarted = true; signal.addEventListener("abort", () => modelAborted = true, { once: true });
    await new Promise<void>(resolve => finishModel = resolve); return [{ type: "text" as const, text: "settled" }];
  } };
  const service = url ? createLocalAgentService(options) : null!;
  const start = (task: string, profile?: "workspace") => service.start({ ownerUserId: owner, botId: bot, botName: "fixture", threadId: `${owner}-${task}`, task, ...(profile ? { profile } : {}) });
  const node = (taskId: string, message: any) => service.handleNodeMessage(device, { taskId, ...message });
  const count = () => backgroundCount(sql, owner);
  const row = async (id: string) => (await sql.unsafe<any[]>("SELECT * FROM chisabot_local_agent_tasks WHERE id=$1", [id]))[0];
  async function reserve(name: string) {
    const threadId = `${owner}-${name}`, runId = randomUUID();
    await backend.client.getOrCreateThread({ threadId, userId: owner, agentId: bot });
    await backend.capacity.enqueue(threadId, runId, { ...executionClass({ kind: "routine", id: name }), input: { threadId, runId, messages: [], state: {}, tools: [], context: [] } });
    expect(await backend.capacity.claim(owner, threadId, runId)).toBe("claimed");
    return async () => { await backend.capacity.releaseReservation(threadId, runId); await backend.capacity.stop(threadId, runId); };
  }
  beforeAll(async () => { backend = await createLocalConversations(database); await service.ensure(); });
  afterAll(async () => { await sql.unsafe("DELETE FROM chisabot_local_agent_tasks WHERE owner_user_id=$1", [owner]); await sql.unsafe("DELETE FROM chisabot_device_agent_settings WHERE owner_user_id=$1", [owner]); await sql.unsafe("DELETE FROM chisabot_local_threads WHERE owner_user_id=$1", [owner]); await sql.close(); });

  test("initial human wait is free, and Stop cannot be undone by a late approval", async () => {
    const task = await start("initial-approval", "workspace");
    await until(async () => !!decision);
    expect(await count()).toBe(0);
    delayDeviceRead = true;
    decision!({ approved: true, by: "fixture" }); decision = undefined;
    await until(async () => !!pendingDeviceRead);
    await service.stop(owner, task.id);
    pendingDeviceRead!(); pendingDeviceRead = undefined;
    await Bun.sleep(50);
    expect((await row(task.id)).status).toBe("cancelled");
    expect(sent.some(value => value.type === "agent_run" && value.taskId === task.id)).toBe(false);
    expect(await count()).toBe(0);
  });

  test("device and model threads share slots; old-node mid-task approval retains its slot", async () => {
    const first = await start("device-first");
    await until(async () => sent.some(value => value.type === "agent_run" && value.taskId === first.id));
    const release = await reserve("model-thread");
    expect(await count()).toBe(2);
    const approval = node(first.id, { type: "agent_approval", reqId: "mid-approval", summary: "fixture operation" });
    await until(async () => !!decision);
    expect((await row(first.id)).status).toBe("pending_approval");
    expect(await count()).toBe(2); // Old PCs may resume after their own 150s timeout.
    const queued = await start("queued-device");
    await until(async () => (await row(queued.id)).step === "等待后台执行位");
    await service.ensure();
    expect((await row(queued.id)).capacity_active).toBe(false);
    expect(sent.some(value => value.type === "agent_run" && value.taskId === queued.id)).toBe(false);
    decision!({ approved: true, by: "fixture" }); decision = undefined; await approval;
    expect(sent.some(value => value.type === "agent_approval_result" && value.reqId === "mid-approval" && value.approved)).toBe(true);
    await node(first.id, { type: "agent_done", ok: true, summary: "once" });
    await until(async () => sent.some(value => value.type === "agent_run" && value.taskId === queued.id));
    expect(await count()).toBe(2);
    await service.stop(owner, queued.id);
    expect(await count()).toBe(2); // Stop request is not proof the remote process stopped.
    const stops = sent.filter(value => value.type === "agent_stop" && value.taskId === queued.id).length;
    await service.stop(owner, queued.id);
    expect(sent.filter(value => value.type === "agent_stop" && value.taskId === queued.id)).toHaveLength(stops + 1);
    await node(queued.id, { type: "agent_done", ok: false, stopped: true });
    await node(queued.id, { type: "agent_done", ok: false, stopped: true });
    expect((await row(queued.id)).status).toBe("cancelled"); expect(await count()).toBe(1);
    await release(); expect(await count()).toBe(0);
  }, 15_000);

  test("an approved but undispatched queue survives owner recovery and is dispatched once", async () => {
    const releaseA = await reserve("recovery-a"), releaseB = await reserve("recovery-b");
    const task = await start("recover-device");
    await until(async () => (await row(task.id)).step === "等待后台执行位");
    const restarted = createLocalAgentService(options); await restarted.ensure(); await restarted.recover();
    expect((await row(task.id)).capacity_active).toBe(false);
    await releaseA();
    await until(async () => sent.some(value => value.type === "agent_run" && value.taskId === task.id));
    await Bun.sleep(1100);
    expect(sent.filter(value => value.type === "agent_run" && value.taskId === task.id)).toHaveLength(1);
    expect(await count()).toBe(2);
    await restarted.handleNodeMessage(device, { type: "agent_done", taskId: task.id, ok: true });
    await releaseB(); expect(await count()).toBe(0);
  }, 15_000);

  test("device terminal waits for an already running cloud model to actually settle before freeing its slot", async () => {
    const task = await start("model-stop"); await until(async () => (await row(task.id)).capacity_active);
    const llm = node(task.id, { type: "agent_llm", reqId: "model", messages: [] });
    await until(async () => modelStarted);
    await service.stop(owner, task.id);
    expect(modelAborted).toBe(true);
    const terminal = node(task.id, { type: "agent_done", stopped: true, ok: false });
    await Bun.sleep(30); expect(await count()).toBe(1);
    finishModel!(); await llm; await terminal;
    expect(await count()).toBe(0);
  });
});
