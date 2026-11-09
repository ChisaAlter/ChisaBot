import { describe, expect, test } from "bun:test";
import {
  estimateTokens,
  toolAllowed,
  workflowDefinitionSchema,
  workflowProblems,
  workflowStages,
} from "../../shared/workflows";
import type { TurnRunner } from "../src/turns/types";
import {
  createWorkflowEngine,
  extractJson,
  MAX_ACTIVE_RUNS_PER_USER,
  normalizeInputs,
  renderTemplate,
} from "../src/workflows/engine";
import {
  parseWorkflowMarkdown,
  serializeWorkflowMarkdown,
  WorkflowFormatError,
} from "../src/workflows/format";
import {
  clearStepPolicy,
  guardWorkflowCallback,
  registerStepPolicy,
  restrictToolsForWorkflow,
} from "../src/workflows/policy";
import { loadPresets } from "../src/workflows/presets";
import type {
  RunState,
  StoredRun,
  WorkflowStore,
} from "../src/workflows/store";
import {
  createInspectToolSchemaTool,
  findWorkflow,
  workflowChatTools,
} from "../src/workflows/tools";

const base = {
  slug: "t",
  name: "测试",
  bots: [
    { key: "a", name: "甲" },
    { key: "b", name: "乙" },
  ],
  inputs: [{ key: "topic", label: "主题", type: "text", required: true }],
  steps: [
    { id: "one", name: "第一步", bot: "a", prompt: "写 {{inputs.topic}}" },
    { id: "two", name: "第二步", bot: "b", prompt: "改 {{steps.one}}" },
  ],
} as const;

describe("presets", () => {
  test("all presets parse and round-trip", () => {
    const presets = loadPresets();
    expect(presets.map((p) => p.definition.slug)).toEqual([
      "research-report",
      "code-review",
      "daily-brief",
      "web-to-panel",
      "pstack-adversarial-review",
    ]);
    for (const preset of presets) {
      expect(workflowProblems(preset.definition)).toEqual([]);
      const again = parseWorkflowMarkdown(
        serializeWorkflowMarkdown(preset.definition),
      );
      expect(again).toEqual(preset.definition);
    }
  });
  test("code review runs its two reviewers in parallel", () => {
    const review = loadPresets().find(
      (p) => p.definition.slug === "code-review",
    )!;
    expect(
      workflowStages(review.definition.steps).map((s) => s.map((x) => x.id)),
    ).toEqual([["security", "quality"], ["summary"]]);
  });
});

describe("format", () => {
  test("rejects unknown format and bad references", () => {
    expect(() =>
      parseWorkflowMarkdown("---\nformat: other/v9\nslug: x\n---\n"),
    ).toThrow(WorkflowFormatError);
    const def = workflowDefinitionSchema.parse({
      ...base,
      steps: [
        {
          id: "one",
          name: "一",
          bot: "zzz",
          prompt: "{{inputs.nope}} {{steps.later}}",
        },
      ],
    });
    const problems = workflowProblems(def);
    expect(problems.some((p) => p.includes("zzz"))).toBe(true);
    expect(problems.some((p) => p.includes("inputs.nope"))).toBe(true);
    expect(problems.some((p) => p.includes("steps.later"))).toBe(true);
  });
  test("body becomes notes; JSON accepted", () => {
    const def = workflowDefinitionSchema.parse(base);
    const md = serializeWorkflowMarkdown({ ...def, notes: "# 说明\n正文" });
    expect(parseWorkflowMarkdown(md).notes).toBe("# 说明\n正文");
    expect(parseWorkflowMarkdown(JSON.stringify(base)).slug).toBe("t");
  });
});

describe("helpers", () => {
  test("inputs are validated and defaulted", () => {
    const def = workflowDefinitionSchema.parse({
      ...base,
      inputs: [
        { key: "topic", label: "主题", type: "text", required: true },
        { key: "n", label: "条数", type: "number", default: 3 },
        { key: "pick", label: "选", type: "select", options: ["A", "B"] },
        { key: "u", label: "网址", type: "url" },
      ],
    });
    expect(() => normalizeInputs(def, {})).toThrow("请填写「主题」");
    expect(normalizeInputs(def, { topic: "x" })).toEqual({ topic: "x", n: 3 });
    expect(() => normalizeInputs(def, { topic: "x", pick: "C" })).toThrow();
    expect(() =>
      normalizeInputs(def, { topic: "x", u: "javascript:alert(1)" }),
    ).toThrow();
  });
  test("templates, json extraction, token estimate", () => {
    expect(
      renderTemplate(
        "{{inputs.a}}/{{steps.b}}/{{inputs.none}}",
        { a: "1" },
        { b: "2" },
      ),
    ).toBe("1/2/（未填写）");
    expect(extractJson('好的：\n```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson("not json")).toBeNull();
    expect(estimateTokens("你好abcd")).toBe(3);
  });
  test("tool rules: deny wins, allow intersects, groups and names", () => {
    expect(toolAllowed([{ deny: ["devices"] }], "device_run_shell")).toBe(
      false,
    );
    expect(toolAllowed([{ allow: ["computer"] }], "computer_navigate")).toBe(
      true,
    );
    expect(toolAllowed([{ allow: ["computer"] }], "render_ui")).toBe(false);
    expect(
      toolAllowed(
        [{ allow: ["computer", "ui"] }, { allow: ["ui"] }],
        "computer_read",
      ),
    ).toBe(false);
    expect(
      toolAllowed([{ deny: ["memory"] }], "remember", "memory/remember"),
    ).toBe(false);
    expect(toolAllowed([{}], "anything")).toBe(true);
  });
  test("findWorkflow matches by name, slug and slash", () => {
    const list = loadPresets().map((p) => ({
      id: p.id,
      kind: "preset" as const,
      definition: p.definition,
    }));
    expect(findWorkflow(list, "/代码审查")?.definition.slug).toBe(
      "code-review",
    );
    expect(findWorkflow(list, "调研报告工作流")?.definition.slug).toBe(
      "research-report",
    );
    expect(findWorkflow(list, "daily-brief")?.definition.name).toBe("每日简报");
  });
});

describe("policy", () => {
  test("workflow turns only see allowed tools and execution re-checks", async () => {
    const tools = ["computer_navigate", "device_run_shell", "render_ui"].map(
      (name) => ({
        name,
        ref: `x/${name}`,
        description: "",
        parameters: {} as never,
        execute: async () => "ran",
      }),
    );
    const initiator = { kind: "workflow" as const, id: "run1/step1" };
    registerStepPolicy(initiator.id, { rules: [{ deny: ["devices"] }] });
    const offered = await restrictToolsForWorkflow(
      initiator,
      async () => tools,
    )();
    expect(offered.map((t) => t.name)).toEqual([
      "computer_navigate",
      "render_ui",
    ]);
    clearStepPolicy(initiator.id);
    // 进程里没有登记 = 一律拒绝。
    expect(await offered[0]!.execute({})).toContain("Refused");
    const person = await restrictToolsForWorkflow(
      { kind: "person" },
      async () => tools,
    )();
    expect(person).toHaveLength(3);
  });
});

// ── 执行器：内存里的 store + 假回合 ──

function memoryStore() {
  const runs = new Map<string, StoredRun>();
  const events: {
    runId: string;
    kind: string;
    message: string;
    stepId: string | null;
  }[] = [];
  let n = 0;
  const store = {
    list: async () => [],
    get: async () => null,
    create: async () => {
      throw new Error("unused");
    },
    update: async () => null,
    remove: async () => false,
    createRunWithinLimit: async (
      input: {
        ownerUserId: string;
        workflowId: string;
        definition: StoredRun["definition"];
        inputs: StoredRun["inputs"];
        bindings: StoredRun["bindings"];
        source: StoredRun["source"];
        state: RunState;
      },
      maxActive: number,
    ) => {
      // 和数据库版一样：计数和插入之间没有 await，等价于同一事务。
      if (
        [...runs.values()].filter(
          (r) =>
            r.ownerUserId === input.ownerUserId &&
            (r.status === "queued" || r.status === "running"),
        ).length >= maxActive
      )
        return null;
      const run: StoredRun = {
        id: `run${++n}`,
        ...input,
        workflowName: input.definition.name,
        status: "queued",
        output: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
        updatedAt: new Date(),
      };
      runs.set(run.id, structuredClone(run));
      return run;
    },
    getRun: async (id: string) =>
      runs.has(id) ? structuredClone(runs.get(id)!) : null,
    getOwnRun: async (owner: string, id: string) => {
      const run = runs.get(id);
      return run && run.ownerUserId === owner ? structuredClone(run) : null;
    },
    listRuns: async () => [...runs.values()],
    countActive: async () =>
      [...runs.values()].filter(
        (r) => r.status === "queued" || r.status === "running",
      ).length,
    saveRun: async (id: string, patch: Partial<StoredRun>) => {
      const run = runs.get(id)!;
      runs.set(id, {
        ...run,
        ...structuredClone(patch),
        updatedAt: new Date(),
      });
    },
    transitionRun: async (
      id: string,
      from: string[],
      patch: Partial<StoredRun>,
    ) => {
      const run = runs.get(id);
      if (!run || !from.includes(run.status)) return false;
      runs.set(id, {
        ...run,
        ...structuredClone(patch),
        updatedAt: new Date(),
      });
      return true;
    },
    claimRun: async (id: string) => {
      const run = runs.get(id);
      if (run?.status !== "queued") return null;
      runs.set(id, { ...run, status: "running", updatedAt: new Date() });
      return structuredClone(runs.get(id)!);
    },
    touchRun: async (id: string) => {
      const run = runs.get(id);
      if (run && run.status === "running")
        runs.set(id, { ...run, updatedAt: new Date() });
    },
    failStaleRun: async (
      id: string,
      staleBefore: Date,
      patch: Partial<StoredRun>,
    ) => {
      const run = runs.get(id);
      if (
        !run ||
        (run.status !== "queued" && run.status !== "running") ||
        run.updatedAt.getTime() >= staleBefore.getTime()
      )
        return false;
      runs.set(id, {
        ...run,
        ...structuredClone(patch),
        status: "failed",
        updatedAt: new Date(),
      });
      return true;
    },
    deleteRun: async (_o: string, id: string) => runs.delete(id),
    interruptedRuns: async () =>
      [...runs.values()].filter((r) => r.status === "running"),
    addEvent: async (
      runId: string,
      kind: string,
      message: string,
      stepId?: string | null,
    ) => {
      events.push({ runId, kind, message, stepId: stepId ?? null });
    },
    events: async () => [],
  };
  return { store: store as unknown as WorkflowStore, runs, events };
}

async function settle(
  runs: Map<string, StoredRun>,
  id: string,
  want: string[] = ["succeeded", "failed", "cancelled", "waiting_approval"],
) {
  for (let i = 0; i < 200; i++) {
    if (want.includes(runs.get(id)!.status)) return runs.get(id)!;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run stuck at ${runs.get(id)!.status}`);
}

function engineWith(
  runTurn: TurnRunner,
  extra: { runLeaseMs?: number; heartbeatMs?: number } = {},
) {
  const mem = memoryStore();
  const conversations: string[] = [];
  const deleted: string[] = [];
  const engine = createWorkflowEngine({
    store: mem.store,
    runTurn,
    createConversation: async (_o, botId) => {
      const id = `c${conversations.length + 1}`;
      conversations.push(`${id}:${botId}`);
      return { channelId: id, threadId: `t-${id}` };
    },
    deleteConversation: async (_o, id) => {
      deleted.push(id);
    },
    botInfo: async (_o, id) =>
      id.startsWith("bot") ? { id, name: id.toUpperCase() } : null,
    librarySkills: async () => [
      { slug: "lib", title: "库技能", instructions: "照库技能做" },
    ],
    log: () => {},
    ...extra,
  });
  return { engine, ...mem, conversations, deleted };
}

describe("engine", () => {
  test("runs steps in order, hands off output, deletes step conversations", async () => {
    const seen: string[] = [];
    const t = engineWith(async (input) => {
      seen.push(
        `${input.agentId}|${input.initiator?.kind}|${input.instruction}`,
      );
      return { replyText: input.agentId === "bot1" ? "草稿内容" : "终稿内容" };
    });
    const def = workflowDefinitionSchema.parse(base);
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "猫" },
      bindings: { a: "bot1", b: "bot2" },
      source: "page",
    });
    const done = await settle(t.runs, run.id);
    expect(done.status).toBe("succeeded");
    expect(done.output).toBe("终稿内容");
    expect(seen[0]).toContain("写 猫");
    expect(seen[1]).toContain("改 草稿内容");
    expect(seen[0]!.split("|")[1]).toBe("workflow");
    expect(t.deleted).toEqual(["c1", "c2"]);
    expect(done.state.stepsRun).toBe(2);
  });

  test("unknown bot is refused before anything runs", async () => {
    const t = engineWith(async () => ({ replyText: "x" }));
    const def = workflowDefinitionSchema.parse(base);
    await expect(
      t.engine.start({
        ownerUserId: "u",
        workflowId: "w",
        definition: def,
        inputs: { topic: "猫" },
        bindings: { a: "nope" },
        source: "page",
      }),
    ).rejects.toThrow("甲");
  });

  test("parallel group runs concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const t = engineWith(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { replyText: "ok" };
    });
    const def = workflowDefinitionSchema.parse({
      ...base,
      steps: [
        { id: "x", name: "X", bot: "a", prompt: "x", group: "g" },
        { id: "y", name: "Y", bot: "b", prompt: "y", group: "g" },
        { id: "z", name: "Z", bot: "a", prompt: "z", handoff: "all" },
      ],
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "chat",
    });
    expect((await settle(t.runs, run.id)).status).toBe("succeeded");
    expect(peak).toBe(2);
  });

  test("approval gate pauses, approve resumes, reject cancels", async () => {
    const t = engineWith(async (input) => ({
      replyText: `done ${input.agentId}`,
    }));
    const def = workflowDefinitionSchema.parse({
      ...base,
      steps: [
        base.steps[0],
        { ...base.steps[1], approval: true, approvalNote: "看一下" },
      ],
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    const waiting = await settle(t.runs, run.id);
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.state.steps[1]!.status).toBe("waiting_approval");
    await t.engine.approve({
      ownerUserId: "u",
      runId: run.id,
      stepId: "two",
      decision: "approve",
      by: "我",
    });
    expect((await settle(t.runs, run.id, ["succeeded", "failed"])).status).toBe(
      "succeeded",
    );

    const run2 = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    await settle(t.runs, run2.id);
    await t.engine.approve({
      ownerUserId: "u",
      runId: run2.id,
      stepId: "two",
      decision: "reject",
      by: "我",
    });
    const rejected = t.runs.get(run2.id)!;
    expect(rejected.status).toBe("cancelled");
    expect(rejected.state.steps[1]!.status).toBe("cancelled");
  });

  test("token budget stops the run with a constraint event", async () => {
    const t = engineWith(async () => ({ replyText: "字".repeat(3000) }));
    const def = workflowDefinitionSchema.parse({
      ...base,
      constraints: { maxTokens: 2000 },
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    const done = await settle(t.runs, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("token 预算");
    expect(t.events.some((e) => e.kind === "constraint_blocked")).toBe(true);
  });

  test("streaming past the budget aborts the turn", async () => {
    const t = engineWith(async (input) => {
      for (let i = 0; i < 50; i++) {
        if (input.signal?.aborted)
          throw new Error("The headless turn was cancelled.");
        input.onText?.("字".repeat((i + 1) * 100));
        await new Promise((r) => setTimeout(r, 1));
      }
      return { replyText: "字".repeat(5000) };
    });
    const def = workflowDefinitionSchema.parse({
      ...base,
      steps: [base.steps[0]],
      constraints: { maxTokens: 1500 },
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    const done = await settle(t.runs, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("中途停止");
  });

  test("json output is enforced with one repair turn", async () => {
    let calls = 0;
    const t = engineWith(async () => {
      calls++;
      return {
        replyText:
          calls === 1 ? "这里是结果: {oops" : '```json\n{"ok":true}\n```',
      };
    });
    const def = workflowDefinitionSchema.parse({
      ...base,
      steps: [base.steps[0]],
      constraints: { output: { format: "json" } },
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    const done = await settle(t.runs, run.id);
    expect(done.status).toBe("succeeded");
    expect(JSON.parse(done.output!)).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("maxSteps is enforced at run time", async () => {
    const t = engineWith(async () => ({ replyText: "ok" }));
    const parsed = workflowDefinitionSchema.parse(base);
    const def = { ...parsed, constraints: { maxSteps: 1 } };
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    const done = await settle(t.runs, run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("最多步骤数");
  });

  test("cancel stops a running step", async () => {
    const t = engineWith(
      (input) =>
        new Promise((resolve, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          );
          setTimeout(() => resolve({ replyText: "late" }), 2000);
        }),
    );
    const def = workflowDefinitionSchema.parse(base);
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    await new Promise((r) => setTimeout(r, 50));
    await t.engine.cancel("u", run.id);
    const done = await settle(t.runs, run.id);
    expect(done.status).toBe("cancelled");
    expect(done.state.steps[0]!.status).toBe("cancelled");
    expect(done.state.steps[1]!.status).toBe("skipped");
  });
});

// ── S5：审批 / 执行 / 恢复 / 启动的并发 ──
describe("engine concurrency (S5)", () => {
  const gated = workflowDefinitionSchema.parse({
    ...base,
    steps: [base.steps[0], { ...base.steps[1], approval: true }],
  });

  test("two concurrent approvals: only one passes, the gated step runs once", async () => {
    const calls: string[] = [];
    const t = engineWith(async (input) => {
      calls.push(input.instruction.includes("改 ok") ? "two" : "one");
      return { replyText: "ok" };
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: gated,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    expect((await settle(t.runs, run.id)).status).toBe("waiting_approval");
    const results = await Promise.allSettled([
      t.engine.approve({
        ownerUserId: "u",
        runId: run.id,
        stepId: "two",
        decision: "approve",
        by: "甲",
      }),
      t.engine.approve({
        ownerUserId: "u",
        runId: run.id,
        stepId: "two",
        decision: "approve",
        by: "乙",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    )!;
    expect((lost.reason as { status: number }).status).toBe(409);
    expect((await settle(t.runs, run.id, ["succeeded", "failed"])).status).toBe(
      "succeeded",
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.filter((c) => c === "two")).toHaveLength(1);
    expect(
      t.events.filter(
        (e) => e.runId === run.id && e.kind === "approval_decided",
      ),
    ).toHaveLength(1);
  });

  test("approve racing reject: exactly one decision sticks", async () => {
    const t = engineWith(async () => ({ replyText: "ok" }));
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: gated,
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    await settle(t.runs, run.id);
    const results = await Promise.allSettled([
      t.engine.approve({
        ownerUserId: "u",
        runId: run.id,
        stepId: "two",
        decision: "approve",
        by: "甲",
      }),
      t.engine.approve({
        ownerUserId: "u",
        runId: run.id,
        stepId: "two",
        decision: "reject",
        by: "乙",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const final = await settle(t.runs, run.id, [
      "succeeded",
      "cancelled",
      "failed",
    ]);
    expect(final.status).toBe(
      results[0]!.status === "fulfilled" ? "succeeded" : "cancelled",
    );
  });

  test("concurrent execute of the same run only runs it once", async () => {
    let turns = 0;
    const t = engineWith(async () => {
      turns++;
      await new Promise((r) => setTimeout(r, 10));
      return { replyText: "ok" };
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: workflowDefinitionSchema.parse(base),
      inputs: { topic: "t" },
      fallbackBotId: "bot1",
      source: "page",
    });
    await Promise.all([
      t.engine.execute(run.id),
      t.engine.execute(run.id),
      t.engine.execute(run.id),
    ]);
    expect((await settle(t.runs, run.id, ["succeeded", "failed"])).status).toBe(
      "succeeded",
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(turns).toBe(2);
  });

  test("concurrent starts: the 4th is refused with 429", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const t = engineWith(async () => {
      await hold;
      return { replyText: "ok" };
    });
    const def = workflowDefinitionSchema.parse(base);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        t.engine.start({
          ownerUserId: "u",
          workflowId: "w",
          definition: def,
          inputs: { topic: "t" },
          fallbackBotId: "bot1",
          source: "page",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(
      MAX_ACTIVE_RUNS_PER_USER,
    );
    const refused = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(refused).toHaveLength(1);
    expect((refused[0]!.reason as { status: number }).status).toBe(429);
    release();
  });

  test("recover leaves a run with a fresh heartbeat alone and fails a stale one", async () => {
    const t = engineWith(async () => ({ replyText: "ok" }), {
      runLeaseMs: 60_000,
    });
    const def = workflowDefinitionSchema.parse(base);
    const mk = async () => {
      const run = (await t.store.createRunWithinLimit(
        {
          ownerUserId: "u",
          workflowId: "w",
          definition: def,
          inputs: { topic: "t" },
          bindings: { a: "bot1", b: "bot1" },
          source: "page",
          state: { steps: [], tokens: 0, stepsRun: 0, elapsedMs: 0 },
        },
        10,
      ))!;
      t.runs.set(run.id, { ...t.runs.get(run.id)!, status: "running" });
      return run.id;
    };
    const alive = await mk();
    const dead = await mk();
    t.runs.set(dead, {
      ...t.runs.get(dead)!,
      updatedAt: new Date(Date.now() - 5 * 60_000),
    });
    const result = await t.engine.recover();
    expect(result).toEqual({ failed: 1, deferred: 1 });
    expect(t.runs.get(alive)!.status).toBe("running");
    expect(t.runs.get(dead)!.status).toBe("failed");
  });
});

describe("rework loops, stateful retry, gates, and chat control tools", () => {
  test("approval reject with rejectTo reworks earlier step on same threadId and carries feedback", async () => {
    const stepOneThreads: string[] = [];
    const stepOneInstructions: string[] = [];
    const t = engineWith(async (input) => {
      if (input.agentId === "bot1") {
        stepOneThreads.push(input.threadId);
        stepOneInstructions.push(input.instruction);
        return { replyText: `草稿 v${stepOneThreads.length}` };
      }
      return {
        replyText: `终稿基于 ${input.instruction.includes("草稿 v2") ? "v2" : "v1"}`,
      };
    });
    const def = workflowDefinitionSchema.parse({
      ...base,
      steps: [
        base.steps[0],
        { ...base.steps[1], approval: true, rejectTo: "one", maxReworks: 2 },
      ],
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "量子计算" },
      bindings: { a: "bot1", b: "bot2" },
      source: "page",
    });
    const waiting1 = await settle(t.runs, run.id);
    expect(waiting1.status).toBe("waiting_approval");

    // Reject and route back to step "one"
    await t.engine.approve({
      ownerUserId: "u",
      runId: run.id,
      stepId: "two",
      decision: "reject",
      comment: "请补充容错量子比特章节",
      by: "我",
    });

    const waiting2 = await settle(t.runs, run.id);
    expect(waiting2.status).toBe("waiting_approval");
    expect(stepOneThreads).toHaveLength(2);
    // targeted_fix reuses the existing threadId!
    expect(stepOneThreads[1]).toBe(stepOneThreads[0]);
    expect(stepOneInstructions[1]).toContain("请补充容错量子比特章节");

    // Now approve step "two"
    await t.engine.approve({
      ownerUserId: "u",
      runId: run.id,
      stepId: "two",
      decision: "approve",
      by: "我",
    });
    const done = await settle(t.runs, run.id, ["succeeded", "failed"]);
    expect(done.status).toBe("succeeded");
    expect(done.output).toBe("终稿基于 v2");
  });

  test("step retry supports targeted_fix (same thread) vs full_redo (new thread) and overlays latest role bindings", async () => {
    let failStepTwo = true;
    const stepTwoCalls: {
      threadId: string;
      agentId: string;
      instruction: string;
    }[] = [];
    const t = engineWith(async (input) => {
      if (input.initiator?.id.endsWith("/two")) {
        stepTwoCalls.push({
          threadId: input.threadId,
          agentId: input.agentId,
          instruction: input.instruction,
        });
        if (failStepTwo) throw new Error("网络超时");
        return { replyText: "重试成功输出" };
      }
      return { replyText: "第一步结果" };
    });
    const def = workflowDefinitionSchema.parse({
      ...base,
      bots: [
        { key: "a", name: "甲", botId: "bot1" },
        { key: "b", name: "乙", botId: "bot2" },
      ],
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "AI" },
      bindings: { a: "bot1", b: "bot2" },
      source: "page",
    });
    const failed = await settle(t.runs, run.id);
    expect(failed.status).toBe("failed");
    expect(stepTwoCalls).toHaveLength(1);

    // Update workflow definition's default bot for role "b" to "bot3" and retry with targeted_fix
    failStepTwo = false;
    const updatedDef = workflowDefinitionSchema.parse({
      ...def,
      bots: [
        { key: "a", name: "甲", botId: "bot1" },
        { key: "b", name: "乙", botId: "bot3" },
      ],
    });
    await t.engine.retry({
      ownerUserId: "u",
      runId: run.id,
      mode: "targeted_fix",
      comment: "换用稳定接口再试",
      latestDefinition: updatedDef,
    });
    const done = await settle(t.runs, run.id, ["succeeded", "failed"]);
    expect(done.status).toBe("succeeded");
    expect(done.output).toBe("重试成功输出");
    expect(stepTwoCalls).toHaveLength(2);
    // Reused threadId on targeted_fix and overlaid bot3 from latestDefinition
    expect(stepTwoCalls[1]!.threadId).toBe(stepTwoCalls[0]!.threadId);
    expect(stepTwoCalls[1]!.agentId).toBe("bot3");
    expect(stepTwoCalls[1]!.instruction).toContain("换用稳定接口再试");
  });

  test("verification gate (submit_gate_result) supports rework loop and pass", async () => {
    let stepTwoTurns = 0;
    const t = engineWith(async (input) => {
      if (input.initiator?.id.endsWith("/two")) {
        stepTwoTurns++;
        const tools = await restrictToolsForWorkflow(
          input.initiator!,
          async () => [],
        )();
        const gateTool = tools.find((x) => x.name === "submit_gate_result");
        expect(gateTool).toBeDefined();
        if (stepTwoTurns === 1) {
          await gateTool!.execute({
            decision: "rework",
            summary: "第一版缺少引用来源",
            findings: [
              { severity: "high", title: "无引用", detail: "请加上数据出处" },
            ],
          });
          return { replyText: "初稿" };
        }
        await gateTool!.execute({
          decision: "pass",
          summary: "引用已补全，验收通过",
        });
        return { replyText: "带引用的终稿" };
      }
      return { replyText: "调研素材" };
    });
    const def = workflowDefinitionSchema.parse({
      ...base,
      steps: [
        base.steps[0],
        { ...base.steps[1], gate: { enabled: true, maxLoops: 2 } },
      ],
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "芯片" },
      fallbackBotId: "bot1",
      source: "page",
    });
    const done = await settle(t.runs, run.id);
    expect(done.status).toBe("succeeded");
    expect(done.output).toBe("带引用的终稿");
    expect(stepTwoTurns).toBe(2);
    expect(done.state.steps[1]!.gateResult?.decision).toBe("pass");
  });

  test("onFailure: continue allows downstream steps to proceed when a step fails", async () => {
    const t = engineWith(async (input) => {
      if (input.initiator?.id.endsWith("/one"))
        throw new Error("第一步非致命报错");
      return { replyText: `第二步收到：${input.instruction}` };
    });
    const def = workflowDefinitionSchema.parse({
      ...base,
      steps: [{ ...base.steps[0], onFailure: "continue" }, base.steps[1]],
    });
    const run = await t.engine.start({
      ownerUserId: "u",
      workflowId: "w",
      definition: def,
      inputs: { topic: "容错" },
      fallbackBotId: "bot1",
      source: "page",
    });
    const done = await settle(t.runs, run.id);
    expect(done.status).toBe("succeeded");
    expect(done.state.steps[0]!.status).toBe("failed");
    expect(done.state.steps[1]!.status).toBe("succeeded");
  });

  test("guardWorkflowCallback blocks unallowed tools on remote callback path and inspect_tool_schema returns JSON contract", async () => {
    const initiator = { kind: "workflow" as const, id: "run99/step1" };
    registerStepPolicy(initiator.id, { rules: [{ allow: ["computer"] }] });
    expect(guardWorkflowCallback(initiator, "computer_navigate")).toBeNull();
    expect(guardWorkflowCallback(initiator, "device_run_shell")?.isError).toBe(
      true,
    );
    clearStepPolicy(initiator.id);

    const sampleTools = workflowChatTools({
      store: memoryStore().store,
      engine: { current: null },
      ownerUserId: "u",
      actorName: "测试用户",
      botId: "bot1",
      initiator: { kind: "person" },
    });
    expect(sampleTools.map((x) => x.name)).toEqual([
      "list_workflows",
      "run_workflow",
      "get_workflow_run",
      "control_workflow_run",
    ]);

    const inspector = createInspectToolSchemaTool(() => sampleTools);
    const schemaJson = await inspector.execute({
      names: ["control_workflow_run"],
    });
    const parsed = JSON.parse(schemaJson);
    expect(parsed.schemas.control_workflow_run).toBeDefined();
    expect(
      parsed.schemas.control_workflow_run.schema.properties.action.enum,
    ).toEqual(["approve", "reject", "retry", "cancel"]);
  });
});
