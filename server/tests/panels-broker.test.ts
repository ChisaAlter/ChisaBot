import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  panelCapabilityGrants,
  panelTaskRequests,
} from "../src/db/schema/panels";
import { capabilityHash, createPanelBroker } from "../src/panels/broker";
import { createPanelStore } from "../src/panels/store";
import { testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), { max: 2 });
afterAll(async () => {
  await db.$client.close();
});
const store = createPanelStore(db);
const dataCapability = {
  id: "overview",
  adapter: "bot",
  action: "overview",
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: {
    type: "object",
    properties: { total: { type: "integer" } },
    required: ["total"],
    additionalProperties: false,
  },
  scope: { actor: "current", bot: "current" },
  effect: "read" as const,
};
const taskCapability = {
  id: "task",
  adapter: "bot",
  action: "task",
  inputSchema: {
    type: "object",
    properties: { instruction: { type: "string", maxLength: 5000 } },
    required: ["instruction"],
    additionalProperties: false,
  },
  outputSchema: { type: "object", additionalProperties: false },
  scope: { actor: "current", bot: "current" },
  effect: "write" as const,
};
async function fixture(
  query: () => Promise<{
    status: "running" | "waiting" | "unknown" | "succeeded" | "failed";
  }> = async () => ({ status: "running" }),
) {
  const ctx = {
    actorId: `broker-${crypto.randomUUID()}`,
    botId: `broker-${crypto.randomUUID()}`,
  };
  const session = await store.beginSession(ctx);
  const draft = await store.saveDraft(ctx, {
    sessionId: session.sessionId,
    expectedDraftRevision: 0,
    definition: {
      name: "受控",
      html: "<main>受控</main>",
      css: "",
      script: "",
      schemaVersion: 1,
      initialState: {},
      stateSchema: { type: "object", additionalProperties: false },
      manifest: { data: [dataCapability], tasks: [taskCapability] },
      size: { width: 340, height: "auto" },
    },
  });
  const first = await store.commit(ctx, {
    draftId: draft.id,
    expectedDraftRevision: 1,
    mode: "first",
    idempotencyKey: crypto.randomUUID(),
    resetState: false,
  });
  const binding = {
    instanceId: first.instanceId!,
    instanceVersion: 1,
    botId: ctx.botId,
  };
  for (const cap of [dataCapability, taskCapability])
    await db.insert(panelCapabilityGrants).values({
      instanceId: binding.instanceId,
      actorId: ctx.actorId,
      capabilityId: cap.id,
      grant: {
        ...cap,
        instanceId: binding.instanceId,
        actorId: ctx.actorId,
        capabilityId: cap.id,
        capabilityHash: capabilityHash(cap),
      },
    });
  let allowed = true,
    executeCount = 0;
  const executions: unknown[] = [];
  const broker = createPanelBroker({
    database: db,
    store,
    authorize: async (actor: typeof ctx) => {
      if (
        !allowed ||
        actor.actorId !== ctx.actorId ||
        actor.botId !== ctx.botId
      )
        throw new Error("permission unavailable");
    },
    adapters: [
      { definition: dataCapability, read: async () => ({ total: 7 }) },
      {
        definition: taskCapability,
        execute: async (request: unknown) => {
          executeCount++;
          executions.push(structuredClone(request));
          return { runId: "normal-run" };
        },
        query,
        cancel: async () => {},
      },
    ],
  });
  return {
    ctx,
    binding,
    broker,
    revoke: () => {
      allowed = false;
    },
    executionCount: () => executeCount,
    executions,
  };
}
test("fixed_data_adapter_and_actor_binding", async () => {
  const f = await fixture();
  expect(
    await f.broker.readPanelData(f.ctx, f.binding, "overview", {}),
  ).toEqual({ total: 7 });
  await expect(
    f.broker.readPanelData(
      { ...f.ctx, actorId: "other" },
      f.binding,
      "overview",
      {},
    ),
  ).rejects.toThrow();
  await expect(
    f.broker.readPanelData(
      f.ctx,
      { ...f.binding, botId: "other" },
      "overview",
      {},
    ),
  ).rejects.toThrow("binding");
  await expect(
    f.broker.readPanelData(f.ctx, f.binding, "overview", {
      url: "https://evil.invalid",
    }),
  ).rejects.toThrow();
});
test("grant_change_requires_approval", async () => {
  const f = await fixture();
  const session = await store.beginSession(f.ctx, f.binding.instanceId);
  const old = await store.getInstance(f.ctx, f.binding.instanceId);
  const draft = await store.saveDraft(f.ctx, {
    sessionId: session.sessionId,
    expectedDraftRevision: 0,
    definition: {
      ...old.definition,
      manifest: {
        ...old.definition.manifest,
        data: [{ ...dataCapability, scope: { actor: "all", bot: "all" } }],
      },
    },
  });
  await store.commit(f.ctx, {
    draftId: draft.id,
    expectedDraftRevision: 1,
    mode: "instance",
    baseInstanceVersion: 1,
    idempotencyKey: crypto.randomUUID(),
    resetState: false,
  });
  await expect(
    f.broker.readPanelData(
      f.ctx,
      { ...f.binding, instanceVersion: 2 },
      "overview",
      {},
    ),
  ).rejects.toThrow();
  await expect(
    f.broker.readPanelData(f.ctx, f.binding, "overview", {}),
  ).rejects.toThrow("version");
});
test("task_freezes_bot_args_and_confirmation_is_idempotent", async () => {
  const f = await fixture();
  const args = { instruction: "整理待办" };
  const key = crypto.randomUUID();
  const request = await f.broker.requestPanelTask(
    f.ctx,
    f.binding,
    "task",
    args,
    key,
  );
  args.instruction = "偷换";
  const repeated = await f.broker.requestPanelTask(
    f.ctx,
    f.binding,
    "task",
    { instruction: "整理待办" },
    key,
  );
  expect(repeated).toEqual(request);
  expect(f.executionCount()).toBe(0);
  await Promise.all([
    f.broker.confirmPanelTask(f.ctx, request.requestId),
    f.broker.confirmPanelTask(f.ctx, request.requestId),
  ]);
  expect(f.executionCount()).toBe(1);
  const actual = f.executions[0] as {
    botId: string;
    args: { instruction: string };
  };
  expect(actual.botId).toBe(f.ctx.botId);
  expect(actual.args).toEqual({ instruction: "整理待办" });
  await f.broker.queryPanelTask(f.ctx, request.requestId);
  await f.broker.queryPanelTask(f.ctx, request.requestId);
  expect(f.executionCount()).toBe(1);
});
test("revocation_before_confirmation_prevents_run", async () => {
  const f = await fixture();
  const request = await f.broker.requestPanelTask(
    f.ctx,
    f.binding,
    "task",
    { instruction: "待办" },
    crypto.randomUUID(),
  );
  f.revoke();
  await expect(
    f.broker.confirmPanelTask(f.ctx, request.requestId),
  ).rejects.toThrow();
  expect(f.executionCount()).toBe(0);
});
test("only_one_pending_trusted_task_card", async () => {
  const f = await fixture();
  const request = await f.broker.requestPanelTask(
    f.ctx,
    f.binding,
    "task",
    { instruction: "一" },
    crypto.randomUUID(),
  );
  await expect(
    f.broker.requestPanelTask(
      f.ctx,
      f.binding,
      "task",
      { instruction: "二" },
      crypto.randomUUID(),
    ),
  ).rejects.toThrow("pending");
  await f.broker.cancelPanelTask(f.ctx, request.requestId);
  expect(f.executionCount()).toBe(0);
});
test("confirmed_task_can_be_queried_after_instance_version_changes", async () => {
  const f = await fixture();
  const request = await f.broker.requestPanelTask(
    f.ctx,
    f.binding,
    "task",
    { instruction: "继续" },
    crypto.randomUUID(),
  );
  await f.broker.confirmPanelTask(f.ctx, request.requestId);
  await store.updateLayout(f.ctx, {
    instanceId: f.binding.instanceId,
    expectedVersion: 1,
    collapsed: true,
  });
  expect((await f.broker.queryPanelTask(f.ctx, request.requestId)).status).toBe(
    "running",
  );
  expect(f.executionCount()).toBe(1);
  await f.broker.cancelPanelTask(f.ctx, request.requestId);
  expect((await f.broker.queryPanelTask(f.ctx, request.requestId)).status).toBe(
    "cancelled",
  );
});
test("trusted_approval_is_actor_private_and_revocation_stops_data", async () => {
  const f = await fixture();
  await f.broker.revokeCapability(f.ctx, f.binding.instanceId, "overview");
  await expect(
    f.broker.readPanelData(f.ctx, f.binding, "overview", {}),
  ).rejects.toThrow("grant");
  await f.broker.approveCapability(f.ctx, f.binding, "overview");
  expect(
    await f.broker.readPanelData(f.ctx, f.binding, "overview", {}),
  ).toEqual({ total: 7 });
  await expect(
    f.broker.approveCapability(
      f.ctx,
      { ...f.binding, instanceVersion: 9 },
      "overview",
    ),
  ).rejects.toThrow("version");
});

test("late status for run A cannot complete an approval continuation B", async () => {
  let resolve!: (value: { status: "succeeded" }) => void, queried!: () => void;
  const entered = new Promise<void>((done) => {
    queried = done;
  });
  const result = new Promise<{ status: "succeeded" }>((done) => {
    resolve = done;
  });
  const f = await fixture(async () => {
    queried();
    return result;
  });
  const request = await f.broker.requestPanelTask(
    f.ctx,
    f.binding,
    "task",
    { instruction: "test" },
    crypto.randomUUID(),
  );
  await f.broker.confirmPanelTask(f.ctx, request.requestId);
  const oldQuery = f.broker.queryPanelTask(f.ctx, request.requestId);
  await entered;
  await db
    .update(panelTaskRequests)
    .set({ runId: "continuation-B", status: "running" })
    .where(eq(panelTaskRequests.id, request.requestId));
  resolve({ status: "succeeded" });
  const current = await oldQuery;
  expect(current.runId).toBe("continuation-B");
  expect(current.status).toBe("running");
  await f.broker.cancelPanelTask(f.ctx, request.requestId);
  expect((await f.broker.queryPanelTask(f.ctx, request.requestId)).status).toBe(
    "cancelled",
  );
});

test("waiting and uncertain execution remain query-only and cancellable", async () => {
  let status: "waiting" | "unknown" = "waiting";
  const f = await fixture(async () => ({ status }));
  const request = await f.broker.requestPanelTask(
    f.ctx,
    f.binding,
    "task",
    { instruction: "test" },
    crypto.randomUUID(),
  );
  await f.broker.confirmPanelTask(f.ctx, request.requestId);
  expect((await f.broker.queryPanelTask(f.ctx, request.requestId)).status).toBe(
    "waiting",
  );
  status = "unknown";
  await db
    .update(panelTaskRequests)
    .set({ status: "unknown" })
    .where(eq(panelTaskRequests.id, request.requestId));
  expect((await f.broker.queryPanelTask(f.ctx, request.requestId)).status).toBe(
    "unknown",
  );
  expect(f.executionCount()).toBe(1);
  await f.broker.cancelPanelTask(f.ctx, request.requestId);
  expect((await f.broker.queryPanelTask(f.ctx, request.requestId)).status).toBe(
    "cancelled",
  );
});
