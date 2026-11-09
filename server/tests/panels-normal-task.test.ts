import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { panelTaskRequests } from "../src/db/schema/panels";
import { createNormalPanelTaskService } from "../src/panels/normal-task-service";
import { createPanelStore } from "../src/panels/store";
import { testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), { max: 2 });
afterAll(() => db.$client.close());
async function request() {
  const actorId = crypto.randomUUID(),
    botId = crypto.randomUUID(),
    store = createPanelStore(db),
    ctx = { actorId, botId };
  const session = await store.beginSession(ctx);
  const draft = await store.saveDraft(ctx, {
    sessionId: session.sessionId,
    expectedDraftRevision: 0,
    definition: {
      name: "task",
      html: "<p>task</p>",
      css: "",
      script: "",
      manifest: { data: [], tasks: [] },
      stateSchema: { type: "object", additionalProperties: false },
      schemaVersion: 1,
      initialState: {},
      size: { width: 340, height: "auto" },
    },
  });
  const saved = await store.commit(ctx, {
    draftId: draft.id,
    expectedDraftRevision: 1,
    mode: "first",
    resetState: false,
    idempotencyKey: crypto.randomUUID(),
  });
  const id = crypto.randomUUID();
  await db.insert(panelTaskRequests).values({
    id,
    actorId,
    botId,
    instanceId: saved.instanceId!,
    instanceVersion: 1,
    capabilityId: "task",
    capabilityHash: "test",
    args: { value: { instruction: "hello" } },
    status: "confirmed",
    idempotencyKey: id,
  });
  return {
    id,
    actorId,
    botId,
    instanceId: saved.instanceId!,
    instanceVersion: 1,
    args: { instruction: "hello" },
    adapter: "bot",
    action: "task",
    runId: null,
    channelId: null,
    threadId: null,
  };
}
test("normal task starts once with frozen owner Bot and durable run, query never restarts", async () => {
  const r = await request();
  let starts = 0;
  let finish!: (v: { replyText: string }) => void;
  const finished = new Promise<{ replyText: string }>(
    (resolve) => (finish = resolve),
  );
  let captured: any;
  const service = createNormalPanelTaskService({
    database: db,
    createConversation: async () => ({
      channelId: `channel-${r.id}`,
      threadId: `panel-task:${r.id}`,
    }),
    isWaiting: () => false,
    run: async (input: any) => {
      starts++;
      captured = input;
      return finished;
    },
    read: async () => ({ status: "running" }),
    stop: async () => {},
  });
  const first = await service.start(r);
  await service.start(r);
  for (let i = 0; i < 100 && starts === 0; i++) await Bun.sleep(10);
  expect(starts).toBe(1);
  expect(captured).toMatchObject({
    ownerUserId: r.actorId,
    agentId: r.botId,
    threadId: `panel-task:${r.id}`,
    runId: first.runId,
    instruction: "hello",
  });
  await service.query({ ...r, runId: first.runId });
  expect(starts).toBe(1);
  finish({ replyText: "done" });
  await Bun.sleep(20);
  expect(
    (
      await db
        .select()
        .from(panelTaskRequests)
        .where(eq(panelTaskRequests.id, r.id))
    )[0].status,
  ).toBe("succeeded");
});
test("cancel uses exact saved run and aborts without starting another turn", async () => {
  const r = await request();
  let signal!: AbortSignal, stopped: any;
  const service = createNormalPanelTaskService({
    database: db,
    createConversation: async () => ({
      channelId: `channel-${r.id}`,
      threadId: `panel-task:${r.id}`,
    }),
    isWaiting: () => false,
    run: async (input: any) => {
      signal = input.signal;
      return new Promise(() => {});
    },
    read: async () => ({ status: "running" }),
    stop: async (input: any) => {
      stopped = input;
    },
  });
  const run = await service.start(r);
  for (let i = 0; i < 100 && !signal; i++) await Bun.sleep(10);
  await service.cancel({ ...r, runId: run.runId });
  expect(signal.aborted).toBe(true);
  expect(stopped).toEqual({ threadId: `panel-task:${r.id}`, runId: run.runId });
});
test("approval suspension remains waiting and approved continuation tracks a new run without repeating the instruction", async () => {
  const r = await request(),
    waiting = Error("waiting");
  let initial = 0,
    resumed = 0;
  const service = createNormalPanelTaskService({
    database: db,
    createConversation: async () => ({
      channelId: `channel-${r.id}`,
      threadId: `panel-task:${r.id}`,
    }),
    isWaiting: (error) => error === waiting,
    run: async () => {
      initial++;
      throw waiting;
    },
    read: async () => ({ status: "waiting" }),
    stop: async () => {},
  });
  await service.start(r);
  let row: typeof panelTaskRequests.$inferSelect | undefined;
  for (let i = 0; i < 100; i++) {
    [row] = await db
      .select()
      .from(panelTaskRequests)
      .where(eq(panelTaskRequests.id, r.id));
    if (row.status === "waiting") break;
    await Bun.sleep(10);
  }
  expect(row?.status).toBe("waiting");
  expect(row?.channelId).toBe(`channel-${r.id}`);
  const input = {
    ownerUserId: r.actorId,
    agentId: r.botId,
    routineId: "approval",
    threadId: `panel-task:${r.id}`,
    instruction: "",
    runId: "resumed-" + r.id,
  };
  await service.runContinuation(input, async (received) => {
    resumed++;
    expect(received.runId).toBe(input.runId);
    return { replyText: "approved" };
  });
  [row] = await db
    .select()
    .from(panelTaskRequests)
    .where(eq(panelTaskRequests.id, r.id));
  expect(row.status).toBe("succeeded");
  expect(row.runId).toBe(input.runId);
  expect(initial).toBe(1);
  expect(resumed).toBe(1);
  await expect(
    service.runContinuation(input, async () => {
      resumed++;
      return { replyText: "duplicate" };
    }),
  ).rejects.toThrow("task_resume_refused");
  expect(resumed).toBe(1);
});

test("restart recovers persisted approval waiting; cancellation refuses subsequent continuation", async () => {
  const r = await request();
  let started = 0,
    resumed = 0;
  await db
    .update(panelTaskRequests)
    .set({
      runId: "old-run",
      status: "running",
      channelId: `channel-${r.id}`,
      threadId: `panel-task:${r.id}`,
    })
    .where(eq(panelTaskRequests.id, r.id));
  const restarted = createNormalPanelTaskService({
    database: db,
    createConversation: async () => {
      throw Error("must not create");
    },
    isWaiting: () => false,
    run: async () => {
      started++;
      return { replyText: "must not restart" };
    },
    read: async () => ({ status: "waiting" }),
    stop: async () => {},
  });
  await restarted.runContinuation(
    {
      ownerUserId: r.actorId,
      agentId: r.botId,
      routineId: "approval",
      threadId: `panel-task:${r.id}`,
      instruction: "",
      runId: "new-run",
    },
    async () => {
      resumed++;
      return { replyText: "done" };
    },
  );
  expect(started).toBe(0);
  expect(resumed).toBe(1);
  await db
    .update(panelTaskRequests)
    .set({ status: "cancelled" })
    .where(eq(panelTaskRequests.id, r.id));
  await expect(
    restarted.runContinuation(
      {
        ownerUserId: r.actorId,
        agentId: r.botId,
        routineId: "approval",
        threadId: `panel-task:${r.id}`,
        instruction: "",
      },
      async () => {
        resumed++;
        return { replyText: "forbidden" };
      },
    ),
  ).rejects.toThrow("task_resume_refused");
  expect(resumed).toBe(1);
});
