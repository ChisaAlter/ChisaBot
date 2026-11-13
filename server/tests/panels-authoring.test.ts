import { afterAll, expect, test } from "bun:test";
import { createDatabase } from "../src/db/client";
import { createPanelAuthoring } from "../src/panels/authoring";
import { createPanelStore } from "../src/panels/store";
import { testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), { max: 2 });
afterAll(async () => {
  await db.$client.close();
});
const store = createPanelStore(db);
const definition = {
  name: "计数",
  html: "<main>示例</main>",
  css: "",
  script: "",
  manifest: { data: [], tasks: [] },
  schemaVersion: 1,
  stateSchema: { type: "object", additionalProperties: false },
  initialState: {},
  size: { width: 340, height: "auto" as const },
};
function fixture() {
  const ctx = { actorId: crypto.randomUUID(), botId: crypto.randomUUID() };
  let allowed = true;
  const service = createPanelAuthoring({
    store,
    authorize: async (c, _manage) => {
      if (!allowed || c.actorId !== ctx.actorId || c.botId !== ctx.botId)
        throw Error("denied");
    },
  });
  return {
    ctx,
    service,
    revoke: () => {
      allowed = false;
    },
  };
}
test("tools_cannot_publish_or_grant", async () => {
  const f = fixture();
  const session = await f.service.beginPanelAuthoring(f.ctx);
  const tools = await f.service.tools(f.ctx, session.sessionId);
  expect(tools.map((t: { name: string }) => t.name)).toEqual([
    "proposePanelDraft",
    "revisePanelDraft",
  ]);
  const result = JSON.parse(
    await tools[0].execute({ definition, expectedDraftRevision: 0 }),
  );
  expect(result.status).toBe("ready");
  expect(await store.list(f.ctx)).toHaveLength(0);
});
test("late_result_keeps_original_bot_and_rechecks_permission", async () => {
  const f = fixture();
  const session = await f.service.beginPanelAuthoring(f.ctx);
  await expect(
    f.service.tools({ ...f.ctx, botId: "different" }, session.sessionId),
  ).rejects.toThrow();
  const tools = await f.service.tools(f.ctx, session.sessionId);
  const result = JSON.parse(
    await tools[0].execute({ definition, expectedDraftRevision: 0 }),
  );
  expect((await store.getDraft(f.ctx, result.draftId)).botId).toBe(f.ctx.botId);
  f.revoke();
  await expect(
    tools[1].execute({ definition, expectedDraftRevision: 1 }),
  ).rejects.toThrow();
});
test("stale_versions_keep_draft_and_previous_instance", async () => {
  const f = fixture();
  const session = await f.service.beginPanelAuthoring(f.ctx);
  const tools = await f.service.tools(f.ctx, session.sessionId);
  const result = JSON.parse(
    await tools[0].execute({ definition, expectedDraftRevision: 0 }),
  );
  const saved = await f.service.commit(f.ctx, {
    draftId: result.draftId,
    expectedDraftRevision: 1,
    mode: "first",
    idempotencyKey: crypto.randomUUID(),
    resetState: false,
  });
  const edit = await f.service.beginPanelAuthoring(f.ctx, saved.instanceId);
  const editing = await f.service.tools(f.ctx, edit.sessionId);
  const proposed = JSON.parse(
    await editing[0].execute({
      definition: { ...definition, name: "新版" },
      expectedDraftRevision: 0,
    }),
  );
  await store.updateLayout(f.ctx, {
    instanceId: saved.instanceId,
    expectedVersion: 1,
    title: "并发修改",
  });
  await expect(
    f.service.commit(f.ctx, {
      draftId: proposed.draftId,
      expectedDraftRevision: 1,
      baseInstanceVersion: 1,
      mode: "instance",
      idempotencyKey: crypto.randomUUID(),
      resetState: false,
    }),
  ).rejects.toThrow("version");
  expect((await store.getDraft(f.ctx, proposed.draftId)).status).toBe("ready");
  expect(
    (await store.getInstance(f.ctx, saved.instanceId)).definition.name,
  ).toBe("计数");
});
test("unsafe_and_incomplete_drafts_never_become_previewable", async () => {
  const f = fixture();
  const session = await f.service.beginPanelAuthoring(f.ctx);
  const tools = await f.service.tools(f.ctx, session.sessionId);
  await expect(
    tools[0].execute({
      definition: { ...definition, html: '<script>fetch("/")</script>' },
      expectedDraftRevision: 0,
    }),
  ).rejects.toThrow();
  await expect(
    tools[0].execute({
      definition: { name: "流式半成品" },
      expectedDraftRevision: 0,
    }),
  ).rejects.toThrow();
  expect(await store.list(f.ctx)).toHaveLength(0);
});
