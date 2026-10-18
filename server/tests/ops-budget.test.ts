import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { OPS_CODES } from "../../shared/ops-codes";
import {
  opsCounterSnapshot,
  resetOpsCountersForTests,
} from "../../shared/ops-counters";
import type { AppVariables } from "../src/auth/guards";
import { createOpsBudgetRoutes } from "../src/ops-budget";

const passUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  c,
  next,
) => {
  c.set("actor", {
    id: "u_test",
    email: "t@example.com",
    role: "user",
    name: "t",
  } as AppVariables["actor"]);
  await next();
};

test("POST /api/ops/budget accepts SEND_UNREACHABLE and bumps counter", async () => {
  resetOpsCountersForTests();
  const app = new Hono();
  app.route("/", createOpsBudgetRoutes({ requireUser: passUser }));
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: OPS_CODES.SEND_UNREACHABLE }),
  });
  expect(res.status).toBe(202);
  expect(opsCounterSnapshot().totals.SEND_UNREACHABLE).toBe(1);
});

test("POST rejects non-whitelist codes", async () => {
  const app = new Hono();
  app.route("/", createOpsBudgetRoutes({ requireUser: passUser }));
  const res = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: OPS_CODES.HEALTH_DEGRADED }),
  });
  expect(res.status).toBe(400);
});
