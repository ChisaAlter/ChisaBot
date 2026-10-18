/**
 * Authenticated beacon for client-detected error-budget events (PRD-P1-02).
 *
 * Browser detects SEND_UNREACHABLE (tunnel / offline) before the server sees a request;
 * fire-and-forget POST here so `/api/admin/health`.budgets stays honest. Whitelist only.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { OpsCode } from "../../shared/ops-codes";
import { OPS_CODES } from "../../shared/ops-codes";
import { bumpOps, isBudgetCode } from "../../shared/ops-counters";
import type { AppVariables } from "./auth/guards";

const CLIENT_CODES = new Set<string>([
  OPS_CODES.SEND_UNREACHABLE,
  OPS_CODES.SEND_HANG,
  OPS_CODES.SEND_REPLY_HANG,
  OPS_CODES.STREAM_DISCONNECT,
]);

export function createOpsBudgetRoutes(options: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", options.requireUser);

  routes.post("/", async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ ok: false, error: "invalid json" }, 400);
    }
    const code =
      body && typeof body === "object" && "code" in body
        ? String((body as { code: unknown }).code)
        : "";
    if (!isBudgetCode(code) || !CLIENT_CODES.has(code)) {
      return context.json({ ok: false, error: "code not allowed" }, 400);
    }
    bumpOps(code as OpsCode, { fields: { source: "client" } });
    return context.json({ ok: true }, 202);
  });

  return routes;
}
