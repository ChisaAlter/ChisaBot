import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { createPanelServices } from "../src/panels/service";
import { testDatabaseUrl } from "./support/database";

const db = createDatabase(testDatabaseUrl(), { max: 2 });
afterAll(async () => {
  await db.$client.close();
});
const definition = {
  name: "计数",
  html: "<main>示例</main>",
  css: "",
  script: "",
  manifest: { data: [], tasks: [] },
  schemaVersion: 1,
  stateSchema: {
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"],
    additionalProperties: false,
  },
  initialState: { count: 0 },
  size: { width: 340, height: "auto" as const },
};
function fixture() {
  const run = crypto.randomUUID(),
    a = `bot-a-${run}`,
    b = `bot-b-${run}`,
    alice = `alice-${run}`,
    bob = `bob-${run}`;
  let enabled = true;
  const services = createPanelServices({
    database: db,
    permissions: async (ctx) => {
      if (
        !enabled ||
        ![alice, bob].includes(ctx.actorId) ||
        (ctx.botId !== a && (ctx.botId !== b || ctx.actorId !== alice))
      )
        throw Error("refused");
      return { canManage: ctx.actorId === alice, canInteract: true };
    },
    adapters: [],
    audit: async () => {},
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/panels",
    services.routes(async (c, next) => {
      const actor = c.req.header("x-test-actor");
      if (![alice, bob].includes(actor))
        return c.json({ error: "Authentication required" }, 401);
      c.set("actor", {
        id: actor,
        email: "test@example.invalid",
        role: "user",
      });
      await next();
    }),
  );
  async function req(
    bot: string,
    path = "",
    method = "GET",
    body?: unknown,
    actor = alice,
  ) {
    return app.request(`/api/panels/${bot}${path}`, {
      method,
      headers: {
        "x-test-actor": actor,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function saved(bot = a) {
    const session = await (await req(bot, "/authoring", "POST", {})).json();
    const draft = await (
      await req(bot, "/drafts", "POST", {
        sessionId: session.result.sessionId,
        expectedDraftRevision: 0,
        definition,
      })
    ).json();
    const response = await req(bot, "/commit", "POST", {
      draftId: draft.result.id,
      expectedDraftRevision: 1,
      mode: "first",
      resetState: false,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(200);
    return (await response.json()).result;
  }
  return {
    a,
    b,
    alice,
    bob,
    services,
    app,
    req,
    saved,
    revoke: () => {
      enabled = false;
    },
  };
}
test("create_copy_edit_rollback_restart", async () => {
  const f = fixture(),
    first = await f.saved();
  const installed = await (
    await f.req(f.b, "/install", "POST", {
      libraryId: first.libraryId,
      libraryVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    })
  ).json();
  expect(installed.result.id).not.toBe(first.instanceId);
  const session = await f.services.authoring.beginPanelAuthoring(
    { actorId: f.alice, botId: f.a },
    first.instanceId,
  );
  const draft = await f.services.authoring.proposePanelDraft(
    { actorId: f.alice, botId: f.a },
    {
      sessionId: session.sessionId,
      expectedDraftRevision: 0,
      definition: { ...definition, name: "编辑后的" },
    },
  );
  expect(
    (
      await f.req(f.a, "/commit", "POST", {
        draftId: draft.id,
        expectedDraftRevision: 1,
        baseInstanceVersion: 1,
        mode: "instance",
        resetState: false,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  expect(
    (await (await f.req(f.b)).json()).result.items[0].definition.name,
  ).toBe("计数");
  expect(
    (
      await f.req(f.a, `/instances/${first.instanceId}/rollback`, "POST", {
        expectedVersion: 2,
        version: 1,
        idempotencyKey: crypto.randomUUID(),
        resetState: false,
      })
    ).status,
  ).toBe(200);
  const reopened = createDatabase(testDatabaseUrl(), { max: 1 });
  try {
    expect(
      (
        await (
          await import("../src/panels/store")
        )
          .createPanelStore(reopened)
          .getInstance({ actorId: f.alice, botId: f.a }, first.instanceId)
      ).instanceVersion,
    ).toBe(3);
  } finally {
    await reopened.$client.close();
  }
});
test("visitor_and_private_state", async () => {
  const f = fixture(),
    first = await f.saved(),
    path = `/instances/${first.instanceId}/state`;
  expect((await f.req(f.a, "/authoring", "POST", {}, f.bob)).status).toBe(403);
  expect(
    (
      await f.req(
        f.a,
        path,
        "PUT",
        { instanceVersion: 1, stateRevision: 0, value: { count: 9 } },
        f.alice,
      )
    ).status,
  ).toBe(200);
  expect(
    (await (await f.req(f.a, path, "GET", undefined, f.bob)).json()).result
      .value,
  ).toEqual({ count: 0 });
  expect((await f.req(f.b, "", "GET", undefined, f.bob)).status).toBe(403);
  expect(
    (await f.req(f.b, `/instances/${first.instanceId}`, "GET")).status,
  ).toBe(404);
});
test("logout_and_policy_revocation_refuse_old_bridge", async () => {
  const f = fixture(),
    first = await f.saved();
  expect(
    (
      await f.req(
        f.a,
        `/instances/${first.instanceId}/state`,
        "GET",
        undefined,
        "",
      )
    ).status,
  ).toBe(401);
  f.revoke();
  expect(
    (await f.req(f.a, `/instances/${first.instanceId}/state`)).status,
  ).toBe(403);
  expect((await f.req(f.a, "/authoring", "POST", {})).status).toBe(403);
});
test("trusted_http_rejects_actor_forgery_and_tools_only_make_drafts", async () => {
  const f = fixture();
  expect(
    (await f.req(f.a, "/authoring", "POST", { actorId: f.bob })).status,
  ).toBe(400);
  const session = await f.services.authoring.beginPanelAuthoring({
      actorId: f.alice,
      botId: f.a,
    }),
    tools = await f.services.authoring.tools(
      { actorId: f.alice, botId: f.a },
      session.sessionId,
    );
  const event = JSON.parse(
    await tools[0].execute({ expectedDraftRevision: 0, definition }),
  );
  expect(event.status).toBe("ready");
  expect((await (await f.req(f.a)).json()).result.items).toHaveLength(0);
});
