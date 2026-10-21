/**
 * `GET /api/admin/runtime-kernel` — which loop actually runs a Bot's turns, and whether the host
 * Hermes bridge behind it is ready.
 *
 * Deployment-level configuration, not a per-Bot setting: every built-in Bot uses the same kernel.
 * Administrators only, like the rest of 管理后台 → 系统更新.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { HermesHealthCheck } from "./hermes-health";

export type RuntimeKernelStatus = {
  kernel: "hermes" | "builtin";
  hermes: HermesHealthCheck | null;
};

export function createRuntimeKernelRoutes(options: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  kernel: "hermes" | "builtin";
  probe?: () => Promise<HermesHealthCheck>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", options.requireUser, async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  routes.get("/", async (context) => {
    context.header("Cache-Control", "no-store");
    const status: RuntimeKernelStatus = {
      kernel: options.kernel,
      hermes: options.probe ? await options.probe() : null,
    };
    return context.json(status);
  });
  return routes;
}
