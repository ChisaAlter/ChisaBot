/**
 * 系统提示词多角色版本化工作台管理员 HTTP 路由（/api/admin/prompts/*）。
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import {
  PromptWorkbenchError,
  type PromptWorkbenchStore,
} from "./workbench-store";

const savePromptBodySchema = z
  .object({
    digest: z.string({ error: "缺少原版提示词摘要 digest。" }).min(1),
    expectedRevision: z
      .number({ error: "缺少预期版本号 expectedRevision。" })
      .int("预期版本号必须是整数。")
      .min(0, "预期版本号不能为负数。"),
    content: z.string().optional(),
    restore: z.enum(["original", "previous"]).optional(),
  })
  .strict();

export function createPromptWorkbenchRoutes(options: {
  store: PromptWorkbenchStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.use("*", options.requireUser);
  routes.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/", async (context) => {
    try {
      const roles = await options.store.list();
      return context.json({ roles });
    } catch {
      return context.json(
        { error: "提示词角色列表暂时无法读取，请稍后重试。" },
        503,
      );
    }
  });

  routes.get("/:role", async (context) => {
    const role = context.req.param("role");
    try {
      const prompt = await options.store.get(role);
      return context.json({ prompt });
    } catch (error) {
      if (error instanceof PromptWorkbenchError) {
        return context.json({ error: error.message }, error.status);
      }
      return context.json(
        { error: "提示词详情暂时无法读取，请稍后重试。" },
        503,
      );
    }
  });

  routes.put(
    "/:role",
    bodyLimit({
      maxSize: 300 * 1024,
      onError: (context) =>
        context.json({ error: "提示词请求体过大（上限 300 KiB）。" }, 413),
    }),
    async (context) => {
      const role = context.req.param("role");
      const rawBody: unknown = await context.req.json().catch(() => null);
      const parsed = savePromptBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return context.json(
          { error: parsed.error.issues[0]?.message ?? "提示词保存参数无效。" },
          400,
        );
      }
      try {
        const prompt = await options.store.save(
          role,
          parsed.data,
          context.var.actor.id,
        );
        return context.json({ prompt });
      } catch (error) {
        if (error instanceof PromptWorkbenchError) {
          return context.json({ error: error.message }, error.status);
        }
        return context.json({ error: "提示词暂时无法保存，请稍后重试。" }, 503);
      }
    },
  );

  return routes;
}
