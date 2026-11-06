import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  contextInputSchema,
  sourceInputSchema,
  taskInputSchema,
} from "../../../shared/task-center";
import type { AppVariables } from "../auth/guards";
import type { TaskCenterRoots } from "./roots";
import { TaskCenterError, type TaskCenterService } from "./service";
import type { TaskCenterTrace } from "./trace";

const resourceId = z.string().trim().min(1).max(128);
const decisionInput = z.object({ approved: z.boolean() }).strict();
const sourcePatchInput = sourceInputSchema.partial().strict();
const rootPathInput = z.object({ path: z.string().min(1).max(1000) }).strict();
const taskActions = ["start", "pause", "resume", "retry", "cancel"] as const;

/**
 * Injected collaborators beyond the queue service: the owner's filesystem whitelist
 * (roots.ts) and the execution-trace reader (trace.ts). Both are optional so the
 * service can wire them independently of this route table.
 */
export type TaskCenterRouteDeps = {
  roots?: TaskCenterRoots;
  trace?: TaskCenterTrace;
};

/** The authenticated actor owns every read, mutation and decision in this API. */
export function createTaskCenterRoutes(
  service: TaskCenterService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: TaskCenterRouteDeps = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser, bodyLimit({ maxSize: 128 * 1024 }));
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof TaskCenterError) {
      return context.json({ error: error.message }, error.status);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return context.json({ error: "请求格式无效，请检查填写的内容。" }, 400);
    }
    return context.json({ error: "任务中心操作失败，请稍后重试。" }, 500);
  });

  app.get("/", async (context) =>
    context.json(await service.snapshot(context.var.actor.id)),
  );
  app.get("/tasks", async (context) =>
    context.json({ tasks: await service.listTasks(context.var.actor.id) }),
  );
  app.post("/tasks", async (context) => {
    const input = taskInputSchema.parse(await context.req.json());
    const task = await service.createTask(context.var.actor.id, input);
    return context.json({ task }, 201);
  });
  app.get("/tasks/:id", async (context) => {
    const owner = context.var.actor.id;
    const id = resourceId.parse(context.req.param("id"));
    const task = await service.getTask(owner, id);
    if (!task) return context.json({ error: "找不到这个任务。" }, 404);
    const [events, tasks] = await Promise.all([
      service.taskEvents(owner, id),
      service.listTasks(owner),
    ]);
    return context.json({
      task,
      events,
      children: tasks.filter((item) => item.parentId === id),
    });
  });
  app.get("/tasks/:id/trace", async (context) => {
    if (!deps.trace)
      throw new TaskCenterError("执行轨迹尚未在此部署启用。", 404);
    const owner = context.var.actor.id;
    const id = resourceId.parse(context.req.param("id"));
    if (!(await service.getTask(owner, id)))
      return context.json({ error: "找不到这个任务。" }, 404);
    return context.json({ threads: await deps.trace.trace(owner, id) });
  });
  for (const action of taskActions) {
    app.post(`/tasks/:id/${action}`, async (context) => {
      const task = await service.controlTask(
        context.var.actor.id,
        resourceId.parse(context.req.param("id")),
        action,
      );
      return context.json({ task });
    });
  }

  app.get("/outbox", async (context) =>
    context.json({ outbox: await service.listDecisions(context.var.actor.id) }),
  );
  app.post("/outbox/:id/decide", async (context) => {
    const { approved } = decisionInput.parse(await context.req.json());
    const decision = await service.decide(
      context.var.actor.id,
      resourceId.parse(context.req.param("id")),
      approved,
    );
    return context.json({ decision });
  });

  app.get("/sources", async (context) =>
    context.json({ sources: await service.listSources(context.var.actor.id) }),
  );
  app.post("/sources", async (context) => {
    const input = sourceInputSchema.parse(await context.req.json());
    const source = await service.createSource(context.var.actor.id, input);
    return context.json({ source }, 201);
  });
  app.patch("/sources/:id", async (context) => {
    const input = sourcePatchInput.parse(await context.req.json());
    const source = await service.updateSource(
      context.var.actor.id,
      resourceId.parse(context.req.param("id")),
      input,
    );
    return context.json({ source });
  });
  app.post("/sources/:id/scan", async (context) => {
    const source = await service.scanSource(
      context.var.actor.id,
      resourceId.parse(context.req.param("id")),
    );
    return context.json({ source }, 202);
  });

  app.get("/context", async (context) =>
    context.json({ context: await service.getContext(context.var.actor.id) }),
  );
  app.put("/context", async (context) => {
    const input = contextInputSchema.parse(await context.req.json());
    return context.json({
      context: await service.setContext(context.var.actor.id, input),
    });
  });
  app.get("/capabilities", async (context) =>
    context.json({
      capabilities: await service.capabilities(context.var.actor.id),
    }),
  );

  const roots = () => {
    if (!deps.roots)
      throw new TaskCenterError("授权目录设置尚未在此部署启用。", 404);
    return deps.roots;
  };
  app.get("/roots", async (context) =>
    context.json({ roots: await roots().list(context.var.actor.id) }),
  );
  app.put("/roots", async (context) => {
    const { path } = rootPathInput.parse(await context.req.json());
    return context.json({
      roots: await roots().add(context.var.actor.id, path),
    });
  });
  app.delete("/roots", async (context) => {
    const { path } = rootPathInput.parse(await context.req.json());
    return context.json({
      roots: await roots().remove(context.var.actor.id, path),
    });
  });
  return app;
}
