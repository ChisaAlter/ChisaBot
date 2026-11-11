import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createTaskCenterRoutes } from "../src/task-center/routes";
import {
  TaskCenterError,
  type TaskCenterService,
} from "../src/task-center/service";

describe("POST /tasks/:id/priority", () => {
  test("更新任务优先级并校验 0..100 边界与 404", async () => {
    const calls: Array<{ owner: string; id: string; priority: number }> = [];
    const stubService = {
      setTaskPriority: async (owner: string, id: string, priority: number) => {
        if (id === "missing") {
          throw new TaskCenterError("找不到这个任务。", 404);
        }
        calls.push({ owner, id, priority });
        return { id, ownerUserId: owner, priority };
      },
    } as unknown as TaskCenterService;

    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/task-center",
      createTaskCenterRoutes(stubService, async (c, next) => {
        c.set("actor", { id: "user-1", role: "user" } as never);
        await next();
      }),
    );

    const okRes = await app.request("/api/task-center/tasks/t-1/priority", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 95 }),
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({
      task: { id: "t-1", ownerUserId: "user-1", priority: 95 },
    });
    expect(calls).toEqual([{ owner: "user-1", id: "t-1", priority: 95 }]);

    const badRes = await app.request("/api/task-center/tasks/t-1/priority", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 999 }),
    });
    expect(badRes.status).toBe(400);

    const missingRes = await app.request(
      "/api/task-center/tasks/missing/priority",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ priority: 50 }),
      },
    );
    expect(missingRes.status).toBe(404);
  });
});
