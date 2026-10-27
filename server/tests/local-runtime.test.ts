import { expect, spyOn, test } from "bun:test";
import { HttpAgent } from "@ag-ui/client";
import { InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { mountCopilotRuntime } from "../src/copilot";
import type { LocalConversationBackend } from "../src/local-conversations";
import { testEnvironment } from "./support/environment";

function configuration() {
  return loadConfig(
    testEnvironment({
      CHISABOT_RUNTIME_MODE: "local",
      INTELLIGENCE_API_URL: undefined,
      INTELLIGENCE_GATEWAY_WS_URL: undefined,
      INTELLIGENCE_API_KEY: undefined,
      COPILOTKIT_LICENSE_TOKEN: undefined,
    }),
  );
}

test("local OSS configuration has durable history and no Intelligence credentials", () => {
  expect(configuration().runtime).toEqual({
    mode: "local",
    durableHistory: true,
  });
  expect(() =>
    loadConfig(testEnvironment({ CHISABOT_RUNTIME_MODE: "other" })),
  ).toThrow("CHISABOT_RUNTIME_MODE must be intelligence or local");
});

test("the public SSE runtime reports disabled telemetry and makes no vendor request", async () => {
  const originalTelemetry = process.env.COPILOTKIT_TELEMETRY_DISABLED;
  const originalTracking = process.env.DO_NOT_TRACK;
  const network = spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("A local runtime must not contact CopilotKit.");
  });
  let identityCalls = 0;
  try {
    const backend = {
      runner: new InMemoryAgentRunner(),
      client: {},
      handle: async () => undefined,
    } as LocalConversationBackend;
    const mounted = mountCopilotRuntime(
      configuration(),
      {
        resolveAgentsForActor: async () => ({
          bot: new HttpAgent({ url: "http://127.0.0.1/unused" }),
        }),
        resolveAgentForActor: async () =>
          new HttpAgent({ url: "http://127.0.0.1/unused" }),
      },
      async () => {
        identityCalls++;
        return { id: "owner", name: "Owner" };
      },
      async () => ({ id: "owner", role: "admin" }),
      { localBackend: backend },
    );
    const response = await mounted.handler.request("/api/copilotkit/info");
    expect(response.status).toBe(200);
    const information = await response.json();
    expect(information.mode).toBe("sse");
    expect(information.telemetryDisabled).toBe(true);
    expect(identityCalls).toBe(0);
    expect(network).not.toHaveBeenCalled();
    const appArgs: Parameters<typeof createApp> = [
      configuration(),
      {
        handler: () => new Response("unused"),
        api: {
          getSession: async () => ({
            user: { id: "owner", email: "owner@local.test" },
          }),
        },
      },
      { rolesForUser: async () => ["admin"] },
    ];
    appArgs[6] = mounted.handler;
    appArgs[36] = backend;
    const integratedInfo = await (
      await createApp(...appArgs).request("/api/copilotkit/info")
    ).json();
    expect(integratedInfo.threadEndpoints).toEqual({
      list: true,
      inspect: true,
      mutations: false,
      realtimeMetadata: false,
    });
    expect(integratedInfo.mode).toBe("sse");
    expect(integratedInfo.telemetryDisabled).toBe(true);
    expect(network).not.toHaveBeenCalled();
  } finally {
    network.mockRestore();
    if (originalTelemetry === undefined)
      delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
    else process.env.COPILOTKIT_TELEMETRY_DISABLED = originalTelemetry;
    if (originalTracking === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = originalTracking;
  }
});

function localApp(signedIn: boolean) {
  const claims: { threadId: string; userId: string; agentId: string }[] = [];
  const readers: string[] = [];
  let sdkCalls = 0;
  const backend = {
    runner: new InMemoryAgentRunner(),
    client: {
      getOrCreateThread: async (scope: {
        threadId: string;
        userId: string;
        agentId: string;
      }) => {
        claims.push(scope);
        if (scope.threadId === "outage")
          throw new Error("private-database-address");
        if (scope.threadId === "foreign")
          throw Object.assign(new Error("denied"), { status: 404 });
        return { id: scope.threadId, agentId: scope.agentId };
      },
      getThread: async ({ threadId }: { threadId: string; userId: string }) => {
        if (threadId === "foreign")
          throw Object.assign(new Error("denied"), { status: 404 });
        return { id: threadId, agentId: "bot" };
      },
    },
    handle: async (request: Request, actorId: string) => {
      readers.push(actorId);
      if (new URL(request.url).pathname.includes("/threads"))
        return Response.json({ owner: actorId });
      return undefined;
    },
  } as unknown as LocalConversationBackend;
  const handler = new Hono().all("/api/copilotkit/*", (context) => {
    sdkCalls++;
    return context.json({ accepted: true });
  });
  const args: Parameters<typeof createApp> = [
    configuration(),
    {
      handler: () => new Response("unused"),
      api: {
        getSession: async () =>
          signedIn
            ? { user: { id: "verified-owner", email: "owner@local.test" } }
            : null,
      },
    },
    { rolesForUser: async () => ["admin"] },
  ];
  args[6] = handler;
  args[36] = backend;
  return { app: createApp(...args), claims, readers, sdkCalls: () => sdkCalls };
}

test("local history and runs require a session and use the verified actor", async () => {
  const anonymous = localApp(false);
  expect(
    (
      await anonymous.app.request("/api/copilotkit/threads/clear", {
        method: "POST",
      })
    ).status,
  ).toBe(401);
  expect(
    (await anonymous.app.request("/api/copilotkit", { method: "POST" })).status,
  ).toBe(401);
  expect(anonymous.readers).toEqual([]);
  const signedIn = localApp(true);
  expect(
    (await signedIn.app.request("/api/copilotkit/threads?userId=spoofed"))
      .status,
  ).toBe(200);
  const response = await signedIn.app.request("/api/copilotkit/agent/bot/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "owned",
      userId: "spoofed",
      agentId: "spoofed",
    }),
  });
  expect(response.status).toBe(200);
  expect(signedIn.claims).toEqual([
    { threadId: "owned", userId: "verified-owner", agentId: "bot" },
  ]);
  expect(
    (
      await signedIn.app.request("/api/copilotkit/agent/bot/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "new-empty-thread",
          userId: "spoofed",
        }),
      })
    ).status,
  ).toBe(200);
  expect(signedIn.claims.at(-1)).toEqual({
    threadId: "new-empty-thread",
    userId: "verified-owner",
    agentId: "bot",
  });
});

test("foreign run and stop scopes never reach the SDK and Learning is unavailable", async () => {
  const { app, sdkCalls } = localApp(true);
  for (const route of [
    "/api/copilotkit/agent/bot/run",
    "/api/copilotkit/agent/bot/stop/foreign",
    "/api/copilotkit/agent/bot/stop/foreign/",
    "/api/copilotkit/agent//bot//stop//foreign//",
    "/api/copilotkit/nested//agent//bot/stop/foreign/",
    "/api/copilotkit/nested//agent//bot/run/",
    "/api/copilotkit/nested//agent//bot/connect//",
  ]) {
    expect(
      (
        await app.request(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: "foreign" }),
        })
      ).status,
    ).toBe(404);
  }
  expect(sdkCalls()).toBe(0);
  const unavailable = await app.request("/api/copilotkit/x/agent/bot/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "outage" }),
  });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.text()).not.toContain("private-database-address");
  expect(sdkCalls()).toBe(0);
  // Automatic Learning was removed in slimming P4b-3: its admin API is gone.
  expect((await app.request("/api/admin/learning/settings")).status).toBe(404);
  expect(await (await app.request("/api/capabilities")).json()).toMatchObject({
    mode: "local",
    durableHistory: true,
    learning: false,
  });
  expect(
    (
      await app.request("/api/copilotkit/nested//agent//bot/stop/owned///", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(200);
  expect(sdkCalls()).toBe(1);
});
