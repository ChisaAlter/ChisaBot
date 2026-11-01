import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  type HermesHealthCheck,
  hermesHealthUrl,
  probeHermesHealth,
} from "../src/agents/hermes-health";
import { createRuntimeKernelRoutes } from "../src/agents/kernel-status";
import type { AppVariables } from "../src/auth/guards";

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const READY = {
  ok: true,
  hostTools: true,
  healthy: true,
  initialized: true,
  generation: 1,
  sessions: 2,
  queuedScopes: 0,
  activeTurns: 0,
  runRecords: 4,
  persistentState: true,
  stateHealthy: true,
};

test("the health endpoint is the sibling of the AG-UI endpoint", () => {
  expect(hermesHealthUrl("http://172.19.0.1:4100/ag-ui")).toBe(
    "http://172.19.0.1:4100/health",
  );
  expect(hermesHealthUrl("https://host/hermes/ag-ui/")).toBe(
    "https://host/hermes/health",
  );
  expect(hermesHealthUrl("not a url")).toBeNull();
  expect(hermesHealthUrl("file:///tmp/ag-ui")).toBeNull();
});

test("a ready bridge reports its public facts and nothing secret", async () => {
  const health = await probeHermesHealth("http://bridge:4100/ag-ui", {
    fetch: respond(READY),
  });
  expect(health).toEqual({
    ok: true,
    configured: true,
    reachable: true,
    healthy: true,
    initialized: true,
    hostTools: true,
    persistentState: true,
    generation: 1,
    sessions: 2,
  });
  expect(JSON.stringify(health)).not.toContain("token");
});

test("a reachable but unready bridge stays false with a fixed sentence", async () => {
  const health = await probeHermesHealth("http://bridge:4100/ag-ui", {
    fetch: respond({ ...READY, ok: false, initialized: false }),
  });
  expect(health.ok).toBe(false);
  expect(health.reachable).toBe(true);
  expect(health.initialized).toBe(false);
  expect(health.error).toBe("Hermes 桥接还没有就绪");
});

test("HTTP failures and unreachable hosts are distinguished without leaking bodies", async () => {
  const failed = await probeHermesHealth("http://bridge:4100/ag-ui", {
    fetch: respond("internal stack", 503),
  });
  expect(failed).toMatchObject({
    ok: false,
    reachable: true,
    error: "Hermes 健康检查返回 HTTP 503",
  });
  expect(JSON.stringify(failed)).not.toContain("internal stack");

  const down = await probeHermesHealth("http://bridge:4100/ag-ui", {
    fetch: (async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:4100");
    }) as unknown as typeof fetch,
  });
  expect(down).toMatchObject({ ok: false, reachable: false });
  expect(down.error).not.toContain("10.0.0.9");
});

test("an invalid configured address fails closed", async () => {
  expect(await probeHermesHealth("")).toMatchObject({
    ok: false,
    configured: true,
    reachable: false,
  });
});

function app(
  role: "admin" | "user",
  kernel: "hermes" | "builtin",
  probe?: () => Promise<HermesHealthCheck>,
) {
  const requireUser = (async (
    context: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    context.set("actor", {
      id: `${role}-1`,
      email: `${role}@x`,
      name: role,
      role,
    });
    await next();
  }) as never;
  const root = new Hono<{ Variables: AppVariables }>();
  root.route(
    "/api/admin/runtime-kernel",
    createRuntimeKernelRoutes({
      requireUser,
      kernel,
      ...(probe ? { probe } : {}),
    }),
  );
  return root;
}

test("GET /api/admin/runtime-kernel: admins see the kernel and no-store", async () => {
  const response = await app("admin", "hermes", async () => ({
    ok: true,
    configured: true,
    reachable: true,
  })).request("/api/admin/runtime-kernel");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    kernel: "hermes",
    hermes: { ok: true, configured: true, reachable: true },
  });
});

test("GET /api/admin/runtime-kernel: a built-in deployment reports no bridge", async () => {
  const response = await app("admin", "builtin").request(
    "/api/admin/runtime-kernel",
  );
  expect(await response.json()).toEqual({ kernel: "builtin", hermes: null });
});

test("GET /api/admin/runtime-kernel: non-admins are refused", async () => {
  const response = await app("user", "hermes").request(
    "/api/admin/runtime-kernel",
  );
  expect(response.status).toBe(403);
});

test("the adapter's detected model controls are reported only when the bridge has them", async () => {
  const detected = await probeHermesHealth("http://hermes/ag-ui", {
    fetch: respond({
      ...READY,
      modelControls: { fallback: false, maxOutputTokens: true, extra: "x" },
    }),
  });
  expect(detected.modelControls).toEqual({
    fallback: false,
    maxOutputTokens: true,
  });
  const older = await probeHermesHealth("http://hermes/ag-ui", {
    fetch: respond({ ...READY, modelControls: null }),
  });
  expect(older).not.toHaveProperty("modelControls");
});
