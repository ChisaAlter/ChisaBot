import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { panelCapabilityGrants } from "../src/db/schema/panels";
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
test("tools_save_to_rail_but_never_grant", async () => {
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
  // 9464e141 起工具直接把面板存进面板栏（可在卡片上撤销），不再停在草稿；
  // 能力授予仍只能走面板实例的 grants 流程——这里不该出现任何 grant 行。
  expect(result.status).toBe("saved");
  const items = await store.list(f.ctx);
  expect(items.map((item) => item.id)).toEqual([result.instanceId]);
  expect(
    await db
      .select({ id: panelCapabilityGrants.instanceId })
      .from(panelCapabilityGrants)
      .where(eq(panelCapabilityGrants.instanceId, result.instanceId)),
  ).toEqual([]);
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
  // 工具自动保存进面板栏，返回 saved + instanceId；实例必须绑在最开始的 Bot 上。
  expect(result.status).toBe("saved");
  expect((await store.getInstance(f.ctx, result.instanceId)).botId).toBe(
    f.ctx.botId,
  );
  f.revoke();
  await expect(
    tools[1].execute({ definition, expectedDraftRevision: 1 }),
  ).rejects.toThrow();
});
test("stale_versions_keep_draft_and_previous_instance", async () => {
  const f = fixture();
  const session = await f.service.beginPanelAuthoring(f.ctx);
  const tools = await f.service.tools(f.ctx, session.sessionId);
  // 首个工具调用直接保存进面板栏（9464e141），返回 saved + instanceId。
  const saved = JSON.parse(
    await tools[0].execute({ definition, expectedDraftRevision: 0 }),
  );
  const edit = await f.service.beginPanelAuthoring(f.ctx, saved.instanceId);
  const editing = await f.service.tools(f.ctx, edit.sessionId);
  // 会话建立后实例被别人改过：工具自动提交按 baseInstanceVersion 冲突退回，草稿留下。
  await store.updateLayout(f.ctx, {
    instanceId: saved.instanceId,
    expectedVersion: 1,
    title: "并发修改",
  });
  const proposed = JSON.parse(
    await editing[0].execute({
      definition: { ...definition, name: "新版" },
      expectedDraftRevision: 0,
    }),
  );
  expect(proposed.status).toBe("ready");
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
