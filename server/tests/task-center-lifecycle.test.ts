import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { CHAT_FILES_MARKER } from "../../shared/chat-files";
import type { TaskExecutionResult } from "../../shared/task-center";
import { createChatFiles } from "../src/chat-files/service";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDatabase } from "../src/db/client";
import { taskTurnFailure, verifyTaskTurn } from "../src/task-center/outcome";
import { taskThreadId } from "../src/task-center/runtime";
import {
  createTaskCenter,
  type TaskCenterOptions,
  type TaskCenterService,
} from "../src/task-center/service";

// Set only to a dedicated test database: sweep intentionally claims all due tasks.
const address = process.env.CHISABOT_TASK_TEST_DATABASE_URL;
async function until<T>(
  read: () => Promise<T | null | false>,
  timeout = 20000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline)
      throw Error("Task did not reach the expected persisted state.");
    await Bun.sleep(20);
  }
}

(address ? describe : describe.skip)(
  "task result lifecycle on PostgreSQL",
  () => {
    const owner = `task-outcome-${randomUUID()}`;
    const centers: TaskCenterService[] = [];
    let database: ReturnType<typeof createDatabase>;
    let files: ReturnType<typeof createChatFiles>;
    let operations: ReturnType<typeof createToolOperationStore>;
    const center = (options: Partial<TaskCenterOptions> = {}) => {
      const service = createTaskCenter(database, {
        collect: async () => [],
        execute: async () => ({ summary: "资料结论" }),
        ...options,
      });
      centers.push(service);
      return service;
    };
    const settled = (service: TaskCenterService, id: string) =>
      until(async () => {
        const task = await service.getTask(owner, id);
        return task &&
          ["succeeded", "failed", "cancelled", "paused"].includes(task.status)
          ? task
          : null;
      });
    beforeAll(async () => {
      database = createDatabase(address!, { max: 6 });
      await center().ensure();
      files = createChatFiles(database, {
        encryptionKey: "task-outcome-test-only",
        ownsBot: async () => true,
      });
      await files.ensure();
      operations = createToolOperationStore(database);
      await operations.ensure();
    }, 60000);
    afterAll(async () => {
      for (const service of centers) await service.stop();
      if (!database) return;
      for (const table of [
        "chisabot_task_center_events",
        "chisabot_task_center_decisions",
        "chisabot_task_center_tasks",
        "chisabot_task_center_context",
        "chisabot_tool_operations",
        "chisabot_chat_files",
      ]) {
        await database.$client.unsafe(
          `DELETE FROM ${table} WHERE owner_user_id=$1`,
          [owner],
        );
      }
      await database.$client.close();
    }, 30000);

    test("a legacy text task succeeds and a planned file uses real downloadable bytes", async () => {
      const plain = center();
      const text = await plain.createTask(owner, {
        title: "资料整理",
        description: "在回复中说明结论",
        risk: "read",
      });
      await plain.controlTask(owner, text.id, "start");
      await plain.sweep();
      expect((await settled(plain, text.id)).status).toBe("succeeded");
      const contents = "# 资料报告\n\n结论与来源对应。\n";
      const saved = await files.store(owner, "bot", {
        kind: "shared",
        name: "report.md",
        mimeType: "text/markdown",
        bytes: Buffer.from(contents),
      });
      const completion = {
        criteria: "交付可下载的资料报告",
        required: ["file"] as const,
      };
      const fileCenter = center({
        plan: async () => ({
          summary: "保存报告",
          steps: [],
          completion: { ...completion, required: [...completion.required] },
        }),
        execute: async (task) => {
          const runId = taskThreadId(task, "run");
          const claimed = await operations.claim({
            ownerUserId: owner,
            bindingId: task.id,
            sessionId: task.id,
            runId,
            callId: "file",
            turn: 1,
            step: 1,
            name: "file_share",
            args: { path: "report.md" },
          });
          if (claimed.kind !== "claimed")
            throw Error("Expected one file operation");
          await operations.settle(claimed.id, "completed", {
            content: `${CHAT_FILES_MARKER}${JSON.stringify([saved])}`,
          });
          const checked = await verifyTaskTurn({
            database,
            task,
            runId,
            messages: [],
          });
          return { summary: "报告已保存", ...checked };
        },
      });
      const task = await fileCenter.createTask(owner, {
        title: "资料报告",
        description: completion.criteria,
        risk: "read",
      });
      await fileCenter.controlTask(owner, task.id, "start");
      await fileCenter.sweep();
      const result = await settled(fileCenter, task.id);
      expect(result.status).toBe("succeeded");
      expect(result.completion).toEqual(completion);
      const [shape] = await database.$client.unsafe<{ shape: string }[]>(
        "SELECT jsonb_typeof(payload) AS shape FROM chisabot_task_center_tasks WHERE id=$1",
        [task.id],
      );
      expect(shape?.shape).toBe("object");
      expect(result.artifacts[0]?.uri).toBe(saved.url);
      const delivered = (await fileCenter.taskEvents(owner, task.id)).find(
        (event) => event.type === "delivered",
      );
      expect(delivered?.data.evidence).toMatchObject([
        { kind: "file", reference: saved.url },
      ]);
      const app = new Hono();
      app.route(
        "/api/chat-files",
        files.routes(async (c, next) => {
          c.set("actor", { id: owner, role: "user" } as never);
          await next();
        }),
      );
      const response = await app.request(saved.url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(contents);
    }, 60000);

    test("missing required output fails once; Retry rechecks the same saved attempt", async () => {
      const attempts: string[] = [],
        savedResults = new Map<string, TaskExecutionResult>();
      let effects = 0;
      const service = center({
        execute: async (task) => {
          const identity = taskThreadId(task, "run");
          attempts.push(identity);
          if (!savedResults.has(identity)) {
            effects++;
            savedResults.set(identity, { summary: "已完成" });
          }
          return savedResults.get(identity)!;
        },
      });
      const task = await service.createTask(owner, {
        title: "生成文件",
        description: "需要可读文件",
        risk: "read",
        completion: { criteria: "可读文件", required: ["file"] },
      });
      await service.controlTask(owner, task.id, "start");
      await service.sweep();
      const failed = await settled(service, task.id);
      expect(failed.status).toBe("failed");
      expect(failed.attempts).toBe(1);
      expect(
        (await service.taskEvents(owner, task.id)).some(
          (event) => event.type === "delivered",
        ),
      ).toBe(false);
      await service.sweep();
      expect(effects).toBe(1);
      // Old Bun writes stored JSON strings; the existing reader contract must still support them.
      await database.$client.unsafe(
        "UPDATE chisabot_task_center_events SET data=to_jsonb(data::text) WHERE task_id=$1 AND type='failed'",
        [task.id],
      );
      await service.controlTask(owner, task.id, "retry");
      await service.sweep();
      const rechecked = await settled(service, task.id);
      expect(rechecked.status).toBe("failed");
      expect(rechecked.version).toBe(failed.version);
      expect(rechecked.attempts).toBe(1);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toBe(attempts[1]);
      expect(effects).toBe(1);
    }, 60000);

    test("an explicit completion contract survives planning, and ordinary failures get a fresh version", async () => {
      const completion = { criteria: "返回分析", required: [] };
      const identities: string[] = [];
      const service = center({
        plan: async () => ({
          summary: "分析",
          steps: [],
          completion: { criteria: "不覆盖原条件", required: ["file"] },
        }),
        execute: async (task) => {
          identities.push(taskThreadId(task, "run"));
          if (identities.length === 1)
            throw Error("No effects performed; test executor unavailable");
          return { summary: "分析结论" };
        },
      });
      const task = await service.createTask(owner, {
        title: "分析",
        description: "给出建议",
        risk: "read",
        maxAttempts: 1,
        completion,
      });
      await database.$client.unsafe(
        "UPDATE chisabot_task_center_tasks SET payload=to_jsonb(payload::text) WHERE id=$1",
        [task.id],
      );
      await service.controlTask(owner, task.id, "start");
      await service.sweep();
      expect((await settled(service, task.id)).completion).toEqual(completion);
      await service.controlTask(owner, task.id, "retry");
      await service.sweep();
      const retried = await settled(service, task.id);
      expect(retried.status).toBe("succeeded");
      expect(retried.version).toBe(2);
      expect(identities[0]).not.toBe(identities[1]);
    }, 60000);

    test("stop and pause win over a late executor result and never teach a false success", async () => {
      for (const action of ["cancel", "pause"] as const) {
        let release!: (result: TaskExecutionResult) => void;
        let enter!: () => void;
        const started = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const pending = new Promise<TaskExecutionResult>((resolve) => {
          release = resolve;
        });
        const learned: string[] = [];
        const service = center({
          execute: async () => {
            enter();
            return pending;
          },
          learn: async (_owner, _task, outcome) => {
            learned.push(outcome.status);
          },
        });
        const task = await service.createTask(owner, {
          title: "取消竞态",
          description: "等待结果",
          risk: "read",
        });
        await service.controlTask(owner, task.id, "start");
        await service.sweep();
        await started;
        await service.controlTask(owner, task.id, action);
        release({ summary: "迟到的成功总结" });
        await service.stop();
        const result = await service.getTask(owner, task.id);
        expect(result?.status).toBe(
          action === "cancel" ? "cancelled" : "paused",
        );
        expect(result?.summary).toBeNull();
        expect(learned).toEqual([]);
        expect(
          (await service.taskEvents(owner, task.id)).some(
            (event) => event.type === "delivered",
          ),
        ).toBe(false);
      }
    }, 60000);

    test("a failed final response after an executed tool cannot replay that tool on Retry", async () => {
      let effects = 0;
      const identities: string[] = [];
      const service = center({
        execute: async (task) => {
          const runId = taskThreadId(task, "run");
          identities.push(runId);
          const claim = await operations.claim({
            ownerUserId: owner,
            bindingId: task.id,
            sessionId: task.id,
            runId,
            callId: "effect",
            turn: 1,
            step: 1,
            name: "write_receipt",
            args: {},
          });
          if (claim.kind === "claimed") {
            effects++;
            await operations.settle(claim.id, "completed", {
              content: "操作已完成",
            });
          } else expect(claim.kind).toBe("completed");
          throw await taskTurnFailure(
            database,
            task,
            runId,
            "最终模型回复失败",
          );
        },
      });
      const task = await service.createTask(owner, {
        title: "操作后失败",
        description: "保留原工具效果",
        risk: "read",
      });
      await service.controlTask(owner, task.id, "start");
      await service.sweep();
      expect((await settled(service, task.id)).status).toBe("failed");
      await service.controlTask(owner, task.id, "retry");
      await service.sweep();
      const failed = await settled(service, task.id);
      expect(failed.status).toBe("failed");
      expect(failed.version).toBe(1);
      expect(failed.attempts).toBe(1);
      expect(identities).toHaveLength(2);
      expect(identities[0]).toBe(identities[1]);
      expect(effects).toBe(1);
    }, 60000);
  },
);
