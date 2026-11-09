import { describe, expect, test } from "bun:test";
import type {
  TaskCenterTask,
  TaskExecutionContext,
} from "../../shared/task-center";
import {
  isLocalAgentExecutor,
  localAgentKindOf,
} from "../src/task-center/local-agent-runner";
import {
  appendLearned,
  componentArtifacts,
  extractJson,
  frameTask,
  learnEntry,
  taskThreadId,
} from "../src/task-center/runtime";

function task(overrides: Partial<TaskCenterTask> = {}): TaskCenterTask {
  return {
    id: "t1",
    ownerUserId: "owner",
    agentId: null,
    title: "整理本周进展",
    description: "把本周的进展整理成清单。",
    category: "project",
    level: 1,
    assessment: "",
    risk: "read",
    status: "running",
    executor: "bot",
    workspace: null,
    sourceId: null,
    sourceRef: null,
    sourceUrl: null,
    parentId: null,
    dependencies: [],
    planPrepared: false,
    priority: 50,
    attempts: 1,
    maxAttempts: 3,
    timeoutSeconds: 900,
    summary: null,
    artifacts: [],
    usage: {},
    error: null,
    createdAt: "2026-11-06T00:00:00Z",
    updatedAt: "2026-11-06T00:00:00Z",
    startedAt: null,
    finishedAt: null,
    nextAttemptAt: "2026-11-06T00:00:00Z",
    leaseExpiresAt: null,
    version: 1,
    ...overrides,
  };
}
function context(
  overrides: Partial<TaskExecutionContext> = {},
): TaskExecutionContext {
  return {
    signal: new AbortController().signal,
    context: {
      responsibilities: "",
      projects: "",
      goals: "",
      interests: "",
      habits: "",
      preferences: "",
      updatedAt: null,
      learned: "",
      learnedAt: null,
    },
    dependencies: [],
    approval: null,
    onEvent: async () => {},
    ...overrides,
  };
}

describe("task instruction framing", () => {
  test("level and risk boundaries are stated; description is marked content", () => {
    const text = frameTask(task({ level: 5, risk: "read" }), context());
    expect(text).toContain("L5");
    expect(text).toContain("端到端完成");
    expect(text).toContain("只允许读取");
    expect(text).toContain("整理本周进展");
    expect(text).toContain("不要假装完成");
  });

  test("dependency outcomes and approvals reach the instruction", () => {
    const dep = task({
      id: "d1",
      title: "收集数据",
      status: "succeeded",
      summary: "共 12 条",
    });
    const text = frameTask(
      task(),
      context({
        dependencies: [dep],
        approval: {
          id: "ap",
          taskId: "t1",
          ownerUserId: "owner",
          taskVersion: 1,
          summary: "",
          proposedAction: {
            title: "",
            description: "",
            executor: "bot",
            risk: "external",
          },
          status: "approved",
          createdAt: "",
          decidedAt: "2026-11-06T01:00:00Z",
          notificationError: null,
        },
      }),
    );
    expect(text).toContain("收集数据");
    expect(text).toContain("共 12 条");
    expect(text).toContain("人工确认");
  });

  test("overlong descriptions are clipped, not echoed whole", () => {
    const text = frameTask(
      task({ description: "x".repeat(40_000) }),
      context(),
    );
    expect(text.length).toBeLessThan(20_000);
  });
});

describe("task thread identity", () => {
  test("retries get a fresh thread so a paused thread cannot block re-execution", () => {
    const base = task({ id: "abc", attempts: 1 });
    const retry = task({ id: "abc", attempts: 2 });
    expect(taskThreadId(base, "run")).toBe("task-center:abc:run:1");
    expect(taskThreadId(retry, "run")).toBe("task-center:abc:run:2");
    expect(taskThreadId(base, "run")).not.toBe(taskThreadId(retry, "run"));
    // 前缀不变：messages 巡检靠 task-center: 前缀把执行线程排除在「未回复消息」之外。
    expect(taskThreadId(retry, "run").startsWith("task-center:")).toBe(true);
  });
});

describe("execution bookkeeping", () => {
  test("drawn components become named, downloadable artifacts", () => {
    const artifacts = componentArtifacts([
      { name: "showBarChart", args: { title: "周报图表", points: [] } },
      { name: "showCard", args: {} },
    ]);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].name).toBe("周报图表");
    expect(artifacts[0].mediaType).toContain("component+json");
    expect(artifacts[0].content).toContain('"showBarChart"');
    expect(artifacts[1].name).toBe("showCard #2");
    expect(componentArtifacts(undefined)).toEqual([]);
  });

  test("learned log appends entries and drops the oldest beyond the cap", () => {
    const entry = learnEntry(
      { title: "整理本周进展" },
      { status: "succeeded", detail: "  产出 3 项\n结论 " },
    );
    expect(entry).toMatch(
      /\[\d{4}-\d{2}-\d{2}\] 「整理本周进展」完成：产出 3 项 结论/,
    );
    const merged = appendLearned("", entry, 30);
    expect(merged).toBe(entry);
    const long = appendLearned("x".repeat(40), "new-line", 30);
    expect(long).toBe("new-line");
    const kept = appendLearned("line1\nline2", "line3", 12);
    expect(kept).toBe("line2\nline3");
  });
});

describe("local-agent executor routing", () => {
  test("executor suffix picks an agent kind, bare and unknown stay default", () => {
    expect(localAgentKindOf("local-agent")).toBeUndefined();
    expect(localAgentKindOf("local-agent:codex")).toBe("codex");
    expect(localAgentKindOf("local-agent:CLAUDE")).toBe("claude");
    expect(localAgentKindOf("local-agent:unknown-thing")).toBeUndefined();
  });

  test("local-agent executors route to the device-agent branch", () => {
    expect(isLocalAgentExecutor("local-agent")).toBe(true);
    expect(isLocalAgentExecutor("local-agent:codex")).toBe(true);
    expect(isLocalAgentExecutor("bot")).toBe(false);
    expect(isLocalAgentExecutor("local-agentx")).toBe(false);
  });
});

describe("plan output parsing", () => {
  test("fenced and bare JSON both parse", () => {
    const plan = { summary: "两步", steps: [] };
    expect(
      extractJson(`计划如下：\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``),
    ).toEqual(plan);
    expect(extractJson(JSON.stringify(plan))).toEqual(plan);
  });
  test("prose without JSON raises so the caller can fall back", () => {
    expect(() => extractJson("这个任务很简单，不需要拆解。")).toThrow();
  });
});
