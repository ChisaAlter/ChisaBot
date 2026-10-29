/**
 * S5：工作流审批 / 执行 / 恢复 / 启动的并发，在真实 PostgreSQL 上验证（需要 TEST_DATABASE_URL）。
 * - 并发启动不能突破 MAX_ACTIVE_RUNS_PER_USER（计数 + 插入在同一事务里，按 owner 加 advisory 锁）。
 * - 两次并发审批只有一个能过，被审批的步骤只执行一次（状态条件更新 CAS）。
 * - queued → running 的占位只有一个能抢到。
 * - 开机恢复不把心跳新鲜（别的容器正在跑）的运行标失败。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { workflowDefinitionSchema } from "../../shared/workflows";
import { createDatabase } from "../src/db/client";
import {
  createWorkflowEngine,
  MAX_ACTIVE_RUNS_PER_USER,
} from "../src/workflows/engine";
import {
  createWorkflowStore,
  type WorkflowStore,
} from "../src/workflows/store";
import { testDatabaseUrl } from "./support/database";

const it = process.env.TEST_DATABASE_URL ? test : test.skip;

let database: ReturnType<typeof createDatabase>;
let store: WorkflowStore;
const owner = `s5-${randomUUID()}`;

const definition = workflowDefinitionSchema.parse({
  slug: "s5",
  name: "S5",
  bots: [{ key: "a", name: "甲" }],
  inputs: [],
  steps: [
    { id: "one", name: "一", bot: "a", prompt: "第一步" },
    { id: "two", name: "二", bot: "a", prompt: "第二步", approval: true },
  ],
});
const emptyState = { steps: [], tokens: 0, stepsRun: 0, elapsedMs: 0 };
const runInput = (ownerUserId = owner) => ({
  ownerUserId,
  workflowId: "wf_s5",
  definition,
  inputs: {},
  bindings: { a: "bot1" },
  source: "page" as const,
  state: emptyState,
});

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  // 连接池开大一点，让并发请求真的在数据库里并发。
  database = createDatabase(testDatabaseUrl(), { max: 8 });
  store = createWorkflowStore(database);
});

afterAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  await database.$client.unsafe(
    "DELETE FROM workflow_runs WHERE owner_user_id LIKE $1",
    [`${owner}%`],
  );
  await database.$client.close();
});

it("concurrent createRunWithinLimit never exceeds the limit", async () => {
  const who = `${owner}-start`;
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.createRunWithinLimit(runInput(who), MAX_ACTIVE_RUNS_PER_USER),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(MAX_ACTIVE_RUNS_PER_USER);
  expect(await store.countActive(who)).toBe(MAX_ACTIVE_RUNS_PER_USER);
});

it("transitionRun is a CAS: only one of two concurrent transitions wins", async () => {
  const run = (await store.createRunWithinLimit(runInput(`${owner}-cas`), 10))!;
  await store.saveRun(run.id, { status: "waiting_approval" });
  const wins = await Promise.all([
    store.transitionRun(run.id, ["waiting_approval"], { status: "queued" }),
    store.transitionRun(run.id, ["waiting_approval"], { status: "cancelled" }),
  ]);
  expect(wins.filter(Boolean)).toHaveLength(1);
});

it("claimRun: only one concurrent claim gets the run", async () => {
  const run = (await store.createRunWithinLimit(
    runInput(`${owner}-claim`),
    10,
  ))!;
  const claims = await Promise.all([
    store.claimRun(run.id),
    store.claimRun(run.id),
    store.claimRun(run.id),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect((await store.getRun(run.id))!.status).toBe("running");
});

it("engine: two concurrent approvals execute the gated step once", async () => {
  const who = `${owner}-approve`;
  const turns: string[] = [];
  const engine = createWorkflowEngine({
    store,
    runTurn: async (input) => {
      turns.push(input.instruction.includes("第二步") ? "two" : "one");
      await new Promise((r) => setTimeout(r, 20));
      return { replyText: "ok" };
    },
    createConversation: async () => ({
      channelId: randomUUID(),
      threadId: randomUUID(),
    }),
    deleteConversation: async () => {},
    botInfo: async (_o, id) => ({ id, name: id }),
    librarySkills: async () => [],
    log: () => {},
  });
  const run = await engine.start({
    ownerUserId: who,
    workflowId: "wf_s5",
    definition,
    bindings: { a: "bot1" },
    source: "page",
  });
  const waitFor = async (statuses: string[]) => {
    for (let i = 0; i < 300; i++) {
      const current = await store.getRun(run.id);
      if (
        current &&
        statuses.includes(current.status) &&
        !engine.isActive(run.id)
      )
        return current;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timeout");
  };
  await waitFor(["waiting_approval"]);
  const results = await Promise.allSettled([
    engine.approve({
      ownerUserId: who,
      runId: run.id,
      stepId: "two",
      decision: "approve",
      by: "甲",
    }),
    engine.approve({
      ownerUserId: who,
      runId: run.id,
      stepId: "two",
      decision: "approve",
      by: "乙",
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await waitFor(["succeeded", "failed"])).status).toBe("succeeded");
  expect(turns.filter((t) => t === "two")).toHaveLength(1);
});

it("recover does not kill a run whose heartbeat is fresh (another container is running it)", async () => {
  const who = `${owner}-recover`;
  const alive = (await store.createRunWithinLimit(runInput(who), 10))!;
  const dead = (await store.createRunWithinLimit(runInput(who), 10))!;
  await store.claimRun(alive.id);
  await store.claimRun(dead.id);
  await database.$client.unsafe(
    "UPDATE workflow_runs SET updated_at = now() - interval '10 minutes' WHERE id = $1",
    [dead.id],
  );
  const engine = createWorkflowEngine({
    store,
    runTurn: async () => ({ replyText: "ok" }),
    createConversation: async () => ({ channelId: "c", threadId: "t" }),
    deleteConversation: async () => {},
    botInfo: async () => null,
    librarySkills: async () => [],
    log: () => {},
  });
  await engine.recover();
  expect((await store.getRun(alive.id))!.status).toBe("running");
  expect((await store.getRun(dead.id))!.status).toBe("failed");
  // 心跳过期的判断本身也是条件更新：心跳刚刷新过就不会被标。
  await store.touchRun(alive.id);
  expect(
    await store.failStaleRun(alive.id, new Date(Date.now() - 60_000), {
      state: emptyState,
      error: "x",
      finishedAt: new Date(),
    }),
  ).toBe(false);
});
