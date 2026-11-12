import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  type DecisionListPage,
  type TaskCenterSnapshot,
  type TaskListPage,
  taskInputSchema,
} from "../../shared/task-center";
import { createDatabase } from "../src/db/client";
import { createMemoryNotes } from "../src/memory-notes/service";
import { createTaskCenterRuntime } from "../src/task-center/runtime";
import {
  createTaskCenter,
  type TaskCenterService,
} from "../src/task-center/service";

const address = process.env.CHISABOT_TASK_TEST_DATABASE_URL;
(address ? describe : describe.skip)(
  "task center lists and current context on PostgreSQL",
  () => {
    let database: ReturnType<typeof createDatabase>;
    let center: TaskCenterService;
    const owners: string[] = [];
    const owner = () => {
      const id = `task-lists-${randomUUID()}`;
      owners.push(id);
      return id;
    };
    const appFor = (service: TaskCenterService, actor: string) => {
      const app = new Hono();
      app.route(
        "/api/task-center",
        service.routes(async (c, next) => {
          c.set("actor", { id: actor, role: "user" } as never);
          await next();
        }),
      );
      return app;
    };
    async function seed(
      actor: string,
      status: string,
      count: number,
      prefix: string,
      at: string,
    ) {
      const payload = taskInputSchema.parse({
        title: prefix,
        description: "source data",
        category: "project",
      });
      await database.$client.unsafe(
        `INSERT INTO chisabot_task_center_tasks(id,owner_user_id,payload,status,created_at)
      SELECT $1||'-'||n,$2,$3::text::jsonb || jsonb_build_object('title',$4||'-'||n),$5,$6::timestamptz+n*interval '1 second'
      FROM generate_series(1,$7::int) n`,
        [prefix, actor, JSON.stringify(payload), prefix, status, at, count],
      );
    }
    beforeAll(async () => {
      database = createDatabase(address!, { max: 6 });
      center = createTaskCenter(database, {
        collect: async () => [],
        execute: async () => ({ summary: "done" }),
      });
      await center.ensure();
    }, 60_000);
    afterAll(async () => {
      if (!database) return;
      await center.stop();
      for (const table of [
        "chisabot_task_center_events",
        "chisabot_task_center_decisions",
        "chisabot_task_center_tasks",
        "chisabot_task_center_sources",
        "chisabot_task_center_context",
        "chisabot_memory_notes",
        "chisabot_memory_bots",
      ])
        for (const actor of owners)
          await database.$client.unsafe(
            `DELETE FROM ${table} WHERE owner_user_id=$1`,
            [actor],
          );
      await database.$client.close();
    }, 30_000);

    test("old active task and pending approval survive 520 newer history rows and 320 resolved approvals", async () => {
      const actor = owner();
      const old = await center.createTask(actor, {
        title: "旧待确认",
        description: "保留原请求",
        risk: "external",
      });
      await center.controlTask(actor, old.id, "start");
      await database.$client.unsafe(
        "UPDATE chisabot_task_center_tasks SET created_at='2020-01-01' WHERE id=$1",
        [old.id],
      );
      await database.$client.unsafe(
        "UPDATE chisabot_task_center_decisions SET created_at='2020-01-01' WHERE task_id=$1",
        [old.id],
      );
      await seed(actor, "succeeded", 520, actor, "2021-01-01");
      await database.$client.unsafe(
        `INSERT INTO chisabot_task_center_decisions(id,owner_user_id,task_id,task_version,summary,proposed_action,status)
      SELECT $1||'-approval-'||n,$1,$1||'-'||n,1,'resolved','{}'::jsonb,'approved' FROM generate_series(1,320) n`,
        [actor],
      );
      const snapshot = await center.snapshot(actor);
      expect(snapshot.tasks.some((item) => item.id === old.id)).toBe(true);
      expect(
        snapshot.tasks.filter((item) => item.status === "succeeded"),
      ).toHaveLength(10);
      expect(
        snapshot.outbox.filter((item) => item.status === "pending"),
      ).toHaveLength(1);
      expect(
        snapshot.outbox.filter((item) => item.status !== "pending"),
      ).toHaveLength(10);
      expect(snapshot.counts.waiting_approval).toBe(1);
      expect(snapshot.counts.succeeded).toBe(520);
      expect(snapshot.decisionCounts).toEqual({
        pending: 1,
        approved: 320,
        rejected: 0,
        superseded: 0,
      });
      const app = appFor(center, actor);
      const active = (await (
        await app.request("/api/task-center/tasks?view=active")
      ).json()) as TaskListPage;
      expect(active.tasks.map((item) => item.id)).toEqual([old.id]);
      const pending = (await (
        await app.request("/api/task-center/outbox?status=pending")
      ).json()) as DecisionListPage;
      expect(pending.outbox[0]?.taskId).toBe(old.id);
      expect(pending.total).toBe(1);
      expect(pending.nextOffset).toBeNull();
    });

    test("bounded snapshots link to all active and pending pages; search and counts cover full history", async () => {
      const actor = owner();
      await seed(actor, "waiting_approval", 65, actor, "2022-01-01");
      await database.$client.unsafe(
        `INSERT INTO chisabot_task_center_decisions(id,owner_user_id,task_id,task_version,summary,proposed_action,status)
      SELECT $1||'-approval-'||n,$1,$1||'-'||n,1,'pending','{}'::jsonb,'pending' FROM generate_series(1,65) n`,
        [actor],
      );
      await seed(actor, "failed", 501, `${actor}-history`, "2023-01-01");
      const alien = owner();
      await seed(alien, "running", 1, alien, "2025-01-01");
      const app = appFor(center, actor);
      const snapshot = (await (
        await app.request("/api/task-center")
      ).json()) as TaskCenterSnapshot;
      expect(
        snapshot.tasks.filter((item) => item.status === "waiting_approval"),
      ).toHaveLength(50);
      expect(snapshot.outbox).toHaveLength(50);
      expect(snapshot.counts.waiting_approval).toBe(65);
      expect(snapshot.decisionCounts?.pending).toBe(65);
      const first = (await (
        await app.request("/api/task-center/tasks?view=active&limit=50")
      ).json()) as TaskListPage;
      const second = (await (
        await app.request(
          `/api/task-center/tasks?view=active&offset=${first.nextOffset}&limit=50`,
        )
      ).json()) as TaskListPage;
      expect(first.total).toBe(65);
      expect(first.nextOffset).toBe(50);
      expect(second.tasks).toHaveLength(15);
      expect(second.nextOffset).toBeNull();
      expect(
        new Set([...first.tasks, ...second.tasks].map((item) => item.id)).size,
      ).toBe(65);
      expect(second.tasks.at(-1)?.id).toBe(`${actor}-1`);
      const decisions = (await (
        await app.request("/api/task-center/outbox?status=pending&offset=50")
      ).json()) as DecisionListPage;
      expect(decisions.outbox).toHaveLength(15);
      expect(decisions.total).toBe(65);
      const history = (await (
        await app.request(
          `/api/task-center/tasks?view=history&category=project&search=${encodeURIComponent(`${actor}-history-1`)}`,
        )
      ).json()) as TaskListPage;
      expect(history.total).toBe(111);
      expect(
        history.tasks.every((item) =>
          item.title.includes(`${actor}-history-1`),
        ),
      ).toBe(true);
      const incompatible = (await (
        await app.request(
          "/api/task-center/tasks?view=history&category=schedule",
        )
      ).json()) as TaskListPage;
      expect(incompatible.total).toBe(0);
      expect(incompatible.nextOffset).toBeNull();
      expect(
        (await app.request("/api/task-center/tasks?limit=100000")).status,
      ).toBe(400);
      expect(
        (await (await app.request("/api/task-center/tasks")).json()).tasks,
      ).toHaveLength(500);
    });

    test("old task details retain children outside the latest 500 tasks", async () => {
      const actor = owner();
      const parent = await center.createTask(actor, {
        title: "旧父任务",
        description: "原计划",
      });
      const child = await center.createTask(actor, {
        title: "原子任务",
        description: "原步骤",
      });
      await database.$client.unsafe(
        "UPDATE chisabot_task_center_tasks SET parent_id=$2,created_at='2020-01-01' WHERE id=$1",
        [child.id, parent.id],
      );
      await seed(actor, "succeeded", 501, actor, "2022-01-01");
      const detail = await (
        await appFor(center, actor).request(
          `/api/task-center/tasks/${parent.id}`,
        )
      ).json();
      expect(detail.children.map((item: { id: string }) => item.id)).toEqual([
        child.id,
      ]);
    });

    test("manual source failure is persisted and returned as failure; paused source success remains allowed", async () => {
      const actor = owner();
      const failing = createTaskCenter(database, {
        collect: async () => {
          throw Error("邮箱连接已失效");
        },
        execute: async () => ({ summary: "unused" }),
      });
      const source = await failing.createSource(actor, {
        kind: "email",
        label: "邮件",
        enabled: false,
      });
      const failed = await appFor(failing, actor).request(
        `/api/task-center/sources/${source.id}/scan`,
        { method: "POST" },
      );
      expect(failed.status).toBe(502);
      const body = await failed.json();
      expect(body.error).toBe("邮箱连接已失效");
      expect(body.source.lastStatus).toBe("failed");
      expect((await failing.listSources(actor))[0]?.lastError).toBe(body.error);
      const success = await appFor(center, actor).request(
        `/api/task-center/sources/${source.id}/scan`,
        { method: "POST" },
      );
      expect(success.status).toBe(200);
      const result = await success.json();
      expect(result.source.lastStatus).toBe("succeeded");
      expect(result.source.enabled).toBe(false);
      expect(result.source.lastError).toBeNull();
    });

    test("runtime retires hidden learned writes and respects editable current memory plus per-bot disable", async () => {
      const actor = owner();
      const memories = createMemoryNotes(database);
      await memories.ensure();
      const instructions: string[] = [];
      const runtime = createTaskCenterRuntime({
        database,
        runTurn: async (input) => {
          instructions.push(input.instruction);
          return { replyText: "新的任务履历" };
        },
        personalSources: {
          scanCalendar: async () => [],
          scanEmails: async () => [],
          status: async () => ({
            calendar: null,
            email: null,
            weatherCity: "",
          }),
        },
        github: { listOpenItems: async () => [], status: async () => null },
        botAvailable: async () => true,
        defaultAgentFor: async () => "bot",
        memoryNotes: memories,
      });
      await runtime.setContext(actor, {
        interests: "天文",
        habits: "Asia/Shanghai",
        preferences: "不要公开发布",
      });
      await database.$client.unsafe(
        "UPDATE chisabot_task_center_context SET learned='应被遗忘的旧副本',learned_at='2020-01-01' WHERE owner_user_id=$1",
        [actor],
      );
      const run = async (title: string) => {
        const task = await runtime.createTask(actor, {
          title,
          description: "给出建议",
          level: 1,
          completion: { criteria: "提供建议", required: [] },
        });
        await runtime.controlTask(actor, task.id, "start");
        await runtime.sweep();
        const deadline = Date.now() + 10_000;
        while (
          (await runtime.getTask(actor, task.id))?.status !== "succeeded"
        ) {
          if (Date.now() > deadline)
            throw Error(JSON.stringify(await runtime.getTask(actor, task.id)));
          await Bun.sleep(20);
        }
        await runtime.stop();
        return task;
      };
      await run("记忆核对");
      expect(instructions[0]).toContain("天文");
      expect(instructions[0]).toContain("Asia/Shanghai");
      expect(instructions[0]).toContain("不要公开发布");
      expect(instructions[0]).not.toContain("应被遗忘的旧副本");
      const [note] = await memories.search(actor, "新的任务履历");
      expect(note).toBeDefined();
      expect(await memories.context(actor, "bot")).toContain("新的任务履历");
      await memories.update(actor, note!.id, { content: "修正后的结论" });
      expect(await memories.context(actor, "bot")).toContain("修正后的结论");
      expect(await memories.context(actor, "bot")).not.toContain(
        "新的任务履历",
      );
      await memories.remove(actor, [note!.id]);
      expect(await memories.context(actor, "bot")).not.toContain(
        "修正后的结论",
      );
      expect((await runtime.getContext(actor)).learned).toBe(
        "应被遗忘的旧副本",
      );
      await memories.setBot(actor, "bot", false);
      // stop() only stops its timer; a fresh runtime mirrors the next server-owned execution.
      const disabled = createTaskCenterRuntime({
        database,
        runTurn: async () => ({ replyText: "不应再记录" }),
        personalSources: {
          scanCalendar: async () => [],
          scanEmails: async () => [],
          status: async () => ({
            calendar: null,
            email: null,
            weatherCity: "",
          }),
        },
        github: { listOpenItems: async () => [], status: async () => null },
        botAvailable: async () => true,
        defaultAgentFor: async () => "bot",
        memoryNotes: memories,
      });
      const next = await disabled.createTask(actor, {
        title: "关闭后任务",
        description: "只回答",
        level: 1,
        completion: { criteria: "回答", required: [] },
      });
      await disabled.controlTask(actor, next.id, "start");
      await disabled.sweep();
      const until = Date.now() + 10_000;
      while ((await disabled.getTask(actor, next.id))?.status !== "succeeded") {
        if (Date.now() > until)
          throw Error("disabled-memory task did not complete");
        await Bun.sleep(20);
      }
      await disabled.stop();
      expect(await memories.search(actor, "不应再记录")).toHaveLength(0);
      expect(await memories.context(actor, "bot")).toBe("");
    }, 30_000);

    test("planning and bot execution both consume the same complete saved personal conditions", async () => {
      const actor = owner();
      const received: Array<{ routine: string; instruction: string }> = [];
      const runtime = createTaskCenterRuntime({
        database,
        runTurn: async (input) => {
          received.push({
            routine: input.routineId,
            instruction: input.instruction,
          });
          return {
            replyText: input.routineId.endsWith(":plan")
              ? JSON.stringify({
                  summary: "直接完成",
                  steps: [],
                  completion: { criteria: "给出回复", required: [] },
                })
              : "已给出回复",
          };
        },
        personalSources: {
          scanCalendar: async () => [],
          scanEmails: async () => [],
          status: async () => ({
            calendar: null,
            email: null,
            weatherCity: "",
          }),
        },
        github: { listOpenItems: async () => [], status: async () => null },
        botAvailable: async () => true,
        defaultAgentFor: async () => "bot",
      });
      const saved = await runtime.setContext(actor, {
        responsibilities: "职责".repeat(3000),
        projects: "项目",
        goals: "目标",
        interests: "兴趣",
        habits: "仅工作日 18:00 后处理",
        preferences: "最后条件：不要对外发布",
      });
      const task = await runtime.createTask(actor, {
        title: "规划并回复",
        description: "给出草稿",
        level: 3,
      });
      await runtime.controlTask(actor, task.id, "start");
      const deadline = Date.now() + 10_000;
      while ((await runtime.getTask(actor, task.id))?.status !== "succeeded") {
        await runtime.sweep();
        if (Date.now() > deadline)
          throw Error(JSON.stringify(await runtime.getTask(actor, task.id)));
        await Bun.sleep(20);
      }
      await runtime.stop();
      expect(received.map((item) => item.routine.split(":").at(-1))).toEqual([
        "plan",
        "run",
      ]);
      for (const item of received)
        for (const key of [
          "responsibilities",
          "projects",
          "goals",
          "interests",
          "habits",
          "preferences",
        ] as const)
          expect(item.instruction).toContain(saved[key]);
    }, 15_000);
  },
);
