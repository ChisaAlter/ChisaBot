import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import {
  workflowDefinitionSchema,
  workflowProblems,
} from "../../shared/workflows";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import { HeadlessToolSuspension } from "../src/computer/headless-tools";
import type { Database } from "../src/db/client";
import type { TurnRunner } from "../src/turns/types";
import {
  createWorkflowEngine,
  WorkflowRunError,
  type WorkflowToolSuspensionNotice,
} from "../src/workflows/engine";
import {
  buildWorkflowFromTranscript,
  extractScheduleHintsFromWorkflow,
  parseWorkflowMarkdown,
  redactSecretText,
  redactWorkflowDefinition,
  serializeRedactedWorkflowMarkdown,
  serializeWorkflowMarkdown,
} from "../src/workflows/format";
import { loadPresets } from "../src/workflows/presets";
import { createWorkflowRoutes } from "../src/workflows/routes";
import {
  createWorkflowStore,
  type RunEvent,
  type RunState,
  type StoredRun,
  type StoredWorkflow,
  type WorkflowStore,
} from "../src/workflows/store";

function makeActor(id: string, name = "测试用户"): AuthenticatedActor {
  return {
    id,
    email: `${id}@example.com`,
    name,
    role: "user",
  };
}

function createMemoryWorkflowStore() {
  const workflowsMap = new Map<string, StoredWorkflow>();
  const runs = new Map<string, StoredRun>();
  const events: RunEvent[] = [];
  let wfSeq = 0;
  let runSeq = 0;
  let evtSeq = 0;

  const store: WorkflowStore = {
    list: async (ownerUserId) =>
      [...workflowsMap.values()]
        .filter((w) => w.ownerUserId === ownerUserId)
        .map((w) => structuredClone(w)),
    get: async (ownerUserId, id) => {
      const wf = workflowsMap.get(id);
      return wf && wf.ownerUserId === ownerUserId ? structuredClone(wf) : null;
    },
    create: async (ownerUserId, definition, origin) => {
      const now = new Date();
      const wf: StoredWorkflow = {
        id: `wf_${++wfSeq}`,
        ownerUserId,
        definition: structuredClone(definition),
        origin,
        createdAt: now,
        updatedAt: now,
      };
      workflowsMap.set(wf.id, structuredClone(wf));
      return structuredClone(wf);
    },
    update: async (ownerUserId, id, definition) => {
      const existing = workflowsMap.get(id);
      if (!existing || existing.ownerUserId !== ownerUserId) return null;
      const updated: StoredWorkflow = {
        ...existing,
        definition: structuredClone(definition),
        updatedAt: new Date(),
      };
      workflowsMap.set(id, structuredClone(updated));
      return structuredClone(updated);
    },
    remove: async (ownerUserId, id) => {
      const existing = workflowsMap.get(id);
      if (!existing || existing.ownerUserId !== ownerUserId) return false;
      return workflowsMap.delete(id);
    },
    createRunWithinLimit: async (input, maxActive) => {
      const activeCount = [...runs.values()].filter(
        (r) =>
          r.ownerUserId === input.ownerUserId &&
          (r.status === "queued" || r.status === "running"),
      ).length;
      if (activeCount >= maxActive) return null;
      const now = new Date();
      const run: StoredRun = {
        id: `wfr_${++runSeq}`,
        ownerUserId: input.ownerUserId,
        workflowId: input.workflowId,
        workflowName: input.definition.name,
        definition: structuredClone(input.definition),
        inputs: structuredClone(input.inputs),
        bindings: structuredClone(input.bindings),
        status: "queued",
        source: input.source,
        state: structuredClone(input.state),
        output: null,
        error: null,
        stepMode: "auto",
        resumeTokenHash: null,
        resumeReason: null,
        resumeExpiresAt: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      };
      runs.set(run.id, structuredClone(run));
      return structuredClone(run);
    },
    getRun: async (id) => {
      const run = runs.get(id);
      return run ? structuredClone(run) : null;
    },
    getOwnRun: async (ownerUserId, id) => {
      const run = runs.get(id);
      return run && run.ownerUserId === ownerUserId
        ? structuredClone(run)
        : null;
    },
    listRuns: async (ownerUserId, limit = 20) =>
      [...runs.values()]
        .filter((r) => r.ownerUserId === ownerUserId)
        .slice(0, limit)
        .map((r) => structuredClone(r)),
    countActive: async (ownerUserId) =>
      [...runs.values()].filter(
        (r) =>
          r.ownerUserId === ownerUserId &&
          (r.status === "queued" || r.status === "running"),
      ).length,
    saveRun: async (id, patch, noticeEvent) => {
      const run = runs.get(id);
      if (!run) return;
      runs.set(id, {
        ...run,
        ...structuredClone(patch),
        updatedAt: new Date(),
      });
      if (noticeEvent) {
        events.push({
          id: `wfe_${++evtSeq}`,
          runId: id,
          at: new Date(),
          kind: noticeEvent.kind,
          stepId: noticeEvent.stepId ?? null,
          message: noticeEvent.message,
          data: noticeEvent.data ? structuredClone(noticeEvent.data) : null,
        });
      }
    },
    transitionRun: async (id, from, patch) => {
      const run = runs.get(id);
      if (!run || !from.includes(run.status)) return false;
      runs.set(id, {
        ...run,
        ...structuredClone(patch),
        updatedAt: new Date(),
      });
      return true;
    },
    consumeResumeToken: async (runId, tokenHash, nextPatch) => {
      const run = runs.get(runId);
      if (!run || !tokenHash) return false;
      if (run.status !== "waiting_approval") return false;
      if (run.resumeTokenHash !== tokenHash) return false;
      if (run.resumeExpiresAt && run.resumeExpiresAt.getTime() <= Date.now()) {
        return false;
      }
      runs.set(runId, {
        ...run,
        ...structuredClone(nextPatch),
        resumeTokenHash: null,
        resumeReason: null,
        resumeExpiresAt: null,
        updatedAt: new Date(),
      });
      return true;
    },
    claimRun: async (id) => {
      const run = runs.get(id);
      if (!run) return null;
      if (run.status !== "queued") return null;
      const next: StoredRun = {
        ...run,
        status: "running",
        updatedAt: new Date(),
      };
      runs.set(id, structuredClone(next));
      return structuredClone(next);
    },
    touchRun: async (id) => {
      const run = runs.get(id);
      if (run && run.status === "running") {
        runs.set(id, { ...run, updatedAt: new Date() });
      }
    },
    failStaleRun: async () => false,
    deleteRun: async (ownerUserId, id) => {
      const run = runs.get(id);
      if (!run || run.ownerUserId !== ownerUserId) return false;
      return runs.delete(id);
    },
    interruptedRuns: async () => [],
    addEvent: async (runId, kind, message, stepId, data) => {
      events.push({
        id: `wfe_${++evtSeq}`,
        runId,
        at: new Date(),
        kind,
        stepId: stepId ?? null,
        message,
        data: data ? structuredClone(data) : null,
      });
    },
    events: async (runId) =>
      events.filter((e) => e.runId === runId).map((e) => structuredClone(e)),
  };

  return { store, workflows: workflowsMap, runs, events };
}

async function waitForRunStatus(
  runs: Map<string, StoredRun>,
  runId: string,
  wanted: readonly string[],
) {
  for (let i = 0; i < 200; i++) {
    const current = runs.get(runId);
    if (current && wanted.includes(current.status)) {
      return structuredClone(current);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} timed out at ${runs.get(runId)?.status}`);
}

const twoStepWorkflow = workflowDefinitionSchema.parse({
  slug: "browser-handoff-flow",
  name: "浏览器接管测试流",
  bots: [
    { key: "operator", name: "操作员" },
    { key: "reporter", name: "总结员" },
  ],
  inputs: [{ key: "target", label: "目标", type: "text", required: true }],
  steps: [
    {
      id: "login",
      name: "访问后台",
      bot: "operator",
      prompt: "访问 {{inputs.target}} 并拉取数据",
    },
    {
      id: "report",
      name: "汇总结果",
      bot: "reporter",
      prompt: "汇总 {{steps.login}}",
    },
  ],
});

describe("W3-C graduation & secret redaction", () => {
  test("redactSecretText masks OpenAI/Anthropic keys, Bearer, ChisaBot tokens, URL userinfo, and env assignments idempotently", () => {
    const sample = [
      "OPENAI_API_KEY=sk-proj-1234567890abcdef123456",
      "ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrst",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      "PAIR=cbp_pairtoken_123456 DEV=cbd_devicetoken_987654",
      "URL=https://alice:s3cr3tpass@internal.example.com/hook?ok=1",
      "API_KEY=raw_secret_value TOKEN=\"quoted_secret_tok\" PASSWORD='db_pass_99'",
      "safe identifier task-1234567890abcdef remains untouched",
    ].join("\n");

    const redacted = redactSecretText(sample);
    expect(redacted).not.toContain("sk-proj-1234567890abcdef123456");
    expect(redacted).not.toContain("sk-ant-api03-abcdefghijklmnopqrst");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redacted).not.toContain("cbp_pairtoken_123456");
    expect(redacted).not.toContain("cbd_devicetoken_987654");
    expect(redacted).not.toContain("alice:s3cr3tpass");
    expect(redacted).not.toContain("raw_secret_value");
    expect(redacted).not.toContain("quoted_secret_tok");
    expect(redacted).not.toContain("db_pass_99");

    expect(redacted).toContain("<REDACTED>");
    expect(redacted).toContain("https://<REDACTED>@internal.example.com/hook");
    expect(redacted).toContain("Bearer <REDACTED>");
    expect(redacted).toContain("task-1234567890abcdef");
    expect(redactSecretText(redacted)).toBe(redacted);
  });

  test("redactWorkflowDefinition & serializeRedactedWorkflowMarkdown deep-clone, redact all fields, and strip botIds by default", () => {
    const original = workflowDefinitionSchema.parse({
      slug: "secret-export",
      name: "导出脱敏",
      description: "调用 https://bot:topsecret@api.example.com",
      bots: [
        {
          key: "a",
          name: "甲",
          botId: "bot_private_uuid_123",
          description: "持有 cbp_pairing_secret_1234",
        },
      ],
      inputs: [
        {
          key: "token",
          label: "凭据",
          type: "text",
          default: "sk-1234567890abcdefghij",
          placeholder: "Bearer abcdefghijklmnop",
          help: "例如 TOKEN=my_secret_123",
        },
      ],
      steps: [
        {
          id: "run",
          name: "执行",
          bot: "a",
          prompt: "使用 cbd_device_token_12345 访问接口",
        },
      ],
      constraints: {
        output: {
          format: "markdown",
          instructions: "不要输出 PASSWORD=superpass123",
        },
      },
      notes: "# 说明\nBearer tok_abcdefghijkl",
    });

    const redacted = redactWorkflowDefinition(original);
    expect(original.bots[0]?.botId).toBe("bot_private_uuid_123");
    expect(original.steps[0]?.prompt).toContain("cbd_device_token_12345");

    expect(redacted.bots[0]?.botId).toBeUndefined();
    expect(redacted.description).toBe(
      "调用 https://<REDACTED>@api.example.com",
    );
    expect(redacted.bots[0]?.description).toBe("持有 <REDACTED>");
    expect(redacted.inputs[0]?.default).toBe("<REDACTED>");
    expect(redacted.inputs[0]?.placeholder).toBe("Bearer <REDACTED>");
    expect(redacted.inputs[0]?.help).toBe("例如 TOKEN=<REDACTED>");
    expect(redacted.steps[0]?.prompt).toBe("使用 <REDACTED> 访问接口");
    expect(redacted.constraints.output?.instructions).toBe(
      "不要输出 PASSWORD=<REDACTED>",
    );
    expect(redacted.notes).toBe("# 说明\nBearer <REDACTED>");

    const keepBotId = redactWorkflowDefinition(original, {
      stripBotIds: false,
    });
    expect(keepBotId.bots[0]?.botId).toBe("bot_private_uuid_123");

    const md = serializeRedactedWorkflowMarkdown(original);
    expect(md).not.toContain("bot_private_uuid_123");
    expect(md).not.toContain("topsecret");
    expect(md).not.toContain("sk-1234567890abcdefghij");
    expect(md).not.toContain("cbd_device_token_12345");
    expect(parseWorkflowMarkdown(md).bots[0]?.botId).toBeUndefined();
  });

  test("extractScheduleHintsFromWorkflow reads frontmatter schedule and explicit cron notes without false positives", () => {
    const withSchedule = workflowDefinitionSchema.parse({
      slug: "morning-sync",
      name: "晨间同步",
      bots: [{ key: "a", name: "助手" }],
      steps: [{ id: "do", name: "做", bot: "a", prompt: "汇总" }],
      schedule: { cron: "0 8 * * 1-5", title: "工作日早报", paused: false },
    });
    expect(extractScheduleHintsFromWorkflow(withSchedule)).toEqual({
      cron: "0 8 * * 1-5",
      title: "工作日早报",
      paused: true,
      source: "schedule",
    });
    expect(
      parseWorkflowMarkdown(serializeWorkflowMarkdown(withSchedule)).schedule,
    ).toEqual({
      cron: "0 8 * * 1-5",
      title: "工作日早报",
      paused: false,
    });

    const withNoteCron = workflowDefinitionSchema.parse({
      slug: "note-cron",
      name: "笔记定时",
      bots: [{ key: "a", name: "助手" }],
      steps: [{ id: "do", name: "做", bot: "a", prompt: "汇总" }],
      notes: "推荐运行周期：cron: */30 * * * *",
    });
    expect(extractScheduleHintsFromWorkflow(withNoteCron)).toEqual({
      cron: "*/30 * * * *",
      title: "笔记定时",
      paused: true,
      source: "notes",
    });

    const dailyBrief = loadPresets().find(
      (p) => p.definition.slug === "daily-brief",
    )!;
    expect(extractScheduleHintsFromWorkflow(dailyBrief.definition)).toBeNull();
  });

  test("buildWorkflowFromTranscript distills valid redacted workflow from chat messages", () => {
    const def = buildWorkflowFromTranscript({
      name: "生产巡检毕业",
      messages: [
        {
          role: "user",
          text: "先带着 Authorization: Bearer my_live_jwt_token_999 查询 https://ops:adminpass@status.example.com/api 并忽略 {{inputs.unknown}}",
        },
        {
          role: "assistant",
          text: "已拿到状态摘要：服务全部正常。",
        },
        {
          role: "user",
          text: "再检查 API_KEY=secret_value_123456 是否过期并生成结论。",
        },
      ],
    });

    expect(workflowProblems(def)).toEqual([]);
    expect(def.slug).toMatch(/^thread-[a-f0-9]{8}$/);
    expect(def.steps).toHaveLength(2);
    const serialized = serializeRedactedWorkflowMarkdown(def);
    expect(serialized).not.toContain("my_live_jwt_token_999");
    expect(serialized).not.toContain("adminpass");
    expect(serialized).not.toContain("secret_value_123456");
    expect(serialized).toContain("<REDACTED>");
    expect(parseWorkflowMarkdown(serialized).steps).toHaveLength(2);
  });
});

describe("W3-C HeadlessToolSuspension & single-use resumeToken CAS", () => {
  test("HeadlessToolSuspension suspends without failing or deleting step conversation, hashes token, and resumes on same threadId", async () => {
    const mem = createMemoryWorkflowStore();
    const deletedChannels: string[] = [];
    const seenTurns: {
      threadId: string;
      instruction: string;
      stepId: string;
    }[] = [];
    const suspensionNotices: WorkflowToolSuspensionNotice[] = [];
    let loginAttempt = 0;

    const runTurn: TurnRunner = async (input) => {
      const stepId = input.initiator?.id.split("/")[1] ?? "";
      seenTurns.push({
        threadId: input.threadId,
        instruction: input.instruction,
        stepId,
      });
      if (stepId === "login") {
        loginAttempt += 1;
        if (loginAttempt === 1) {
          throw new HeadlessToolSuspension("请先扫码完成后台登录", {
            kind: "computer_takeover",
            requestId: "takeover_1",
          });
        }
        return { replyText: "登录成功并拉取到 18 条记录" };
      }
      return {
        replyText: `最终报告（基于：${input.instruction.slice(0, 60)}）`,
      };
    };

    const engine = createWorkflowEngine({
      store: mem.store,
      runTurn,
      createConversation: async (_owner, botId) => ({
        channelId: `ch_${botId}_${seenTurns.length + 1}`,
        threadId: `th_${botId}_${seenTurns.length + 1}`,
      }),
      deleteConversation: async (_owner, channelId) => {
        deletedChannels.push(channelId);
      },
      botInfo: async (_owner, id) => ({ id, name: id.toUpperCase() }),
      librarySkills: async () => [],
      onToolSuspension: (notice) => {
        suspensionNotices.push(notice);
      },
      log: () => {},
    });

    const run = await engine.start({
      ownerUserId: "u1",
      workflowId: "wf_1",
      definition: twoStepWorkflow,
      inputs: { target: "https://console.example.com" },
      bindings: { operator: "bot_op", reporter: "bot_rep" },
      source: "page",
    });

    const waiting = await waitForRunStatus(mem.runs, run.id, [
      "waiting_approval",
      "failed",
      "succeeded",
    ]);

    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.error).toBeNull();
    expect(waiting.finishedAt).toBeNull();
    expect(deletedChannels).toEqual([]);

    const stepLogin = waiting.state.steps[0]!;
    expect(stepLogin.status).toBe("waiting_approval");
    expect(stepLogin.finishedAt).toBeUndefined();
    expect(stepLogin.approval).toEqual({
      required: true,
      note: "请先扫码完成后台登录",
    });
    expect(stepLogin.waiting).toEqual({
      kind: "computer_takeover",
      requestId: "takeover_1",
      message: "请先扫码完成后台登录",
    });
    const preservedThreadId = stepLogin.threadId;
    expect(preservedThreadId).toBeDefined();

    expect(suspensionNotices).toHaveLength(1);
    const plainToken = suspensionNotices[0]!.resumeToken;
    expect(plainToken.startsWith("wfr_")).toBe(true);
    const expectedHash = createHash("sha256").update(plainToken).digest("hex");
    expect(waiting.resumeTokenHash).toBe(expectedHash);
    expect(waiting.resumeReason).toBe("请先扫码完成后台登录");
    expect(waiting.resumeExpiresAt).toBeInstanceOf(Date);

    const runEvents = await mem.store.events(run.id);
    const suspensionEvent = runEvents.find(
      (e) => e.kind === "tool_suspension_requested",
    );
    expect(suspensionEvent).toBeDefined();
    expect(suspensionEvent?.stepId).toBe("login");
    expect(suspensionEvent?.data).toMatchObject({
      stepId: "login",
      waiting: { kind: "computer_takeover", requestId: "takeover_1" },
      hasResumeToken: true,
      resumeTokenHashPrefix: expectedHash.slice(0, 12),
    });
    expect(JSON.stringify(waiting)).not.toContain(plainToken);
    expect(JSON.stringify(runEvents)).not.toContain(plainToken);
    const runView = engine.view(waiting, runEvents);
    expect(runView.hasResumeToken).toBe(true);
    expect(runView.resumeReason).toBe("请先扫码完成后台登录");
    expect(JSON.stringify(runView)).not.toContain(expectedHash);

    await expect(
      engine.resumeWithToken({
        ownerUserId: "other_user",
        runId: run.id,
        token: plainToken,
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      engine.resumeWithToken({
        ownerUserId: "u1",
        runId: run.id,
        token: "wfr_invalid_token",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "恢复令牌无效、已过期或已被使用。",
    });

    await engine.resumeWithToken({
      ownerUserId: "u1",
      runId: run.id,
      token: plainToken,
      decision: "approve",
      comment: "已完成扫码登录",
      by: "张三",
    });

    const finished = await waitForRunStatus(mem.runs, run.id, [
      "succeeded",
      "failed",
    ]);
    expect(finished.status).toBe("succeeded");
    expect(finished.resumeTokenHash).toBeNull();
    expect(finished.resumeReason).toBeNull();
    expect(finished.resumeExpiresAt).toBeNull();
    expect(finished.state.steps[0]?.status).toBe("succeeded");
    expect(finished.state.steps[1]?.status).toBe("succeeded");
    expect(seenTurns.filter((t) => t.stepId === "login")).toHaveLength(2);
    expect(seenTurns[1]?.threadId).toBe(preservedThreadId);
    expect(seenTurns[1]?.instruction).toContain("已完成扫码登录");

    await expect(
      engine.resumeWithToken({
        ownerUserId: "u1",
        runId: run.id,
        token: plainToken,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("concurrent resumeWithToken race lets only one caller consume the token and execute once", async () => {
    const mem = createMemoryWorkflowStore();
    let plainToken = "";
    let stepCalls = 0;

    const engine = createWorkflowEngine({
      store: mem.store,
      runTurn: async () => {
        stepCalls += 1;
        if (stepCalls === 1) {
          throw new HeadlessToolSuspension("等待设备确认", {
            kind: "device_confirm",
            requestId: "dev_1",
          });
        }
        await new Promise((r) => setTimeout(r, 20));
        return { replyText: "设备已执行完成" };
      },
      createConversation: async () => ({ channelId: "c1", threadId: "t1" }),
      deleteConversation: async () => {},
      botInfo: async (_o, id) => ({ id, name: id }),
      librarySkills: async () => [],
      onToolSuspension: (notice) => {
        plainToken = notice.resumeToken;
      },
      log: () => {},
    });

    const singleStepDef = workflowDefinitionSchema.parse({
      slug: "single-suspend",
      name: "单步挂起",
      bots: [{ key: "a", name: "甲" }],
      steps: [{ id: "do", name: "做", bot: "a", prompt: "执行" }],
    });

    const run = await engine.start({
      ownerUserId: "u1",
      workflowId: "wf_s",
      definition: singleStepDef,
      bindings: { a: "bot1" },
      source: "page",
    });
    await waitForRunStatus(mem.runs, run.id, ["waiting_approval"]);

    const results = await Promise.allSettled([
      engine.resumeWithToken({
        ownerUserId: "u1",
        runId: run.id,
        token: plainToken,
        by: "甲",
      }),
      engine.resumeWithToken({
        ownerUserId: "u1",
        runId: run.id,
        token: plainToken,
        by: "乙",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(WorkflowRunError);
    expect((rejected[0]!.reason as WorkflowRunError).status).toBe(409);

    const done = await waitForRunStatus(mem.runs, run.id, [
      "succeeded",
      "failed",
    ]);
    expect(done.status).toBe("succeeded");
    expect(stepCalls).toBe(2);
  });

  test("expired token is rejected and approve() clears stale resumeTokenHash", async () => {
    const mem = createMemoryWorkflowStore();
    let nowMs = Date.UTC(2026, 10, 16, 8, 0, 0);
    let plainToken = "";

    const engine = createWorkflowEngine({
      store: mem.store,
      runTurn: async () => {
        if (!plainToken) {
          throw new HeadlessToolSuspension("需要人工确认", {
            kind: "confirm",
            requestId: "req_exp",
          });
        }
        return { replyText: "已通过 approve 恢复完成" };
      },
      createConversation: async () => ({ channelId: "c1", threadId: "t1" }),
      deleteConversation: async () => {},
      botInfo: async (_o, id) => ({ id, name: id }),
      librarySkills: async () => [],
      onToolSuspension: (notice) => {
        plainToken = notice.resumeToken;
      },
      now: () => new Date(nowMs),
      log: () => {},
    });

    const singleStepDef = workflowDefinitionSchema.parse({
      slug: "expiry-test",
      name: "过期测试",
      bots: [{ key: "a", name: "甲" }],
      steps: [{ id: "do", name: "做", bot: "a", prompt: "执行" }],
    });

    const run = await engine.start({
      ownerUserId: "u1",
      workflowId: "wf_exp",
      definition: singleStepDef,
      bindings: { a: "bot1" },
      source: "page",
    });
    await waitForRunStatus(mem.runs, run.id, ["waiting_approval"]);

    mem.runs.set(run.id, {
      ...mem.runs.get(run.id)!,
      resumeExpiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      engine.resumeWithToken({
        ownerUserId: "u1",
        runId: run.id,
        token: plainToken,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await engine.approve({
      ownerUserId: "u1",
      runId: run.id,
      stepId: "do",
      decision: "approve",
      comment: "管理员批准继续",
      by: "管理员",
    });

    const done = await waitForRunStatus(mem.runs, run.id, [
      "succeeded",
      "failed",
    ]);
    expect(done.status).toBe("succeeded");
    expect(done.resumeTokenHash).toBeNull();
    expect(done.resumeReason).toBeNull();
    expect(done.resumeExpiresAt).toBeNull();
    nowMs += 1000;
  });

  test("store.consumeResumeToken builds atomic CAS UPDATE SQL clearing tokenHash and checking expiry", async () => {
    const capturedQueries: { sql: string; params: unknown[] }[] = [];
    const { drizzle } = await import("drizzle-orm/pg-proxy");
    const schema = await import("../src/db/schema");
    let calls = 0;
    const proxyDb = drizzle(
      async (query, params) => {
        capturedQueries.push({ sql: query, params });
        calls += 1;
        return { rows: calls === 1 ? [["wfr_cas_1"]] : [] };
      },
      { schema },
    );
    const realStore = createWorkflowStore(proxyDb as unknown as Database);
    const state: RunState = {
      steps: [],
      tokens: 0,
      stepsRun: 0,
      elapsedMs: 0,
    };

    const first = await realStore.consumeResumeToken("wfr_cas_1", "hash_abc", {
      status: "queued",
      state,
    });
    const second = await realStore.consumeResumeToken("wfr_cas_1", "hash_abc", {
      status: "queued",
      state,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(capturedQueries).toHaveLength(2);

    const queryText = capturedQueries[0]!.sql.toLowerCase();
    expect(queryText).toContain('update "workflow_runs" set');
    expect(queryText).toContain('"resume_token_hash" = $');
    expect(queryText).toContain('"resume_reason" = $');
    expect(queryText).toContain('"resume_expires_at" = $');
    expect(queryText).toContain('"workflow_runs"."status" = $');
    expect(queryText).toContain('"workflow_runs"."resume_token_hash" = $');
    expect(queryText).toContain("resume_expires_at");
    expect(queryText).toContain("now()");
    expect(queryText).toContain("returning");
    expect(capturedQueries[0]!.params).toContain("waiting_approval");
    expect(capturedQueries[0]!.params).toContain("hash_abc");
    expect(capturedQueries[0]!.params).toContain("queued");
  });
});

describe("W3-C HTTP routes", () => {
  function setupRouteApp(options?: {
    createPausedSchedule?: (
      ownerUserId: string,
      cron: string,
      title: string,
    ) => Promise<{ id: string; status: "paused" }>;
  }) {
    const mem = createMemoryWorkflowStore();
    const notices: WorkflowToolSuspensionNotice[] = [];
    let turnCount = 0;
    const engine = createWorkflowEngine({
      store: mem.store,
      runTurn: async () => {
        turnCount += 1;
        if (turnCount === 1) {
          throw new HeadlessToolSuspension("需要人工确认提交", {
            kind: "confirm",
            requestId: "r_route_1",
          });
        }
        return { replyText: "路由恢复成功" };
      },
      createConversation: async () => ({ channelId: "c_r", threadId: "t_r" }),
      deleteConversation: async () => {},
      botInfo: async (_o, id) => ({ id, name: id }),
      librarySkills: async () => [],
      onToolSuspension: (n) => {
        notices.push(n);
      },
      log: () => {},
    });

    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      const uid = c.req.header("x-test-user") ?? "user_a";
      c.set("actor", makeActor(uid));
      await next();
    };

    const app = new Hono();
    app.route(
      "/api/workflows",
      createWorkflowRoutes({
        store: mem.store,
        engine,
        requireUser,
        ...(options?.createPausedSchedule
          ? { createPausedSchedule: options.createPausedSchedule }
          : {}),
      }),
    );

    return { app, mem, engine, notices };
  }

  test("GET /:id/export redacts secrets and strips internal botId while keeping stored definition intact", async () => {
    const { app, mem } = setupRouteApp();
    const saved = await mem.store.create(
      "user_a",
      workflowDefinitionSchema.parse({
        slug: "private-wf",
        name: "含密钥工作流",
        description: "使用 https://u:pass123@example.com",
        bots: [{ key: "a", name: "甲", botId: "bot_secret_internal_99" }],
        steps: [
          {
            id: "s1",
            name: "请求",
            bot: "a",
            prompt: "携带 sk-secretkey1234567890",
          },
        ],
      }),
      "editor",
    );

    const res = await app.request(`/api/workflows/${saved.id}/export`);
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).not.toContain("bot_secret_internal_99");
    expect(md).not.toContain("pass123");
    expect(md).not.toContain("sk-secretkey1234567890");
    expect(md).toContain("<REDACTED>");

    const stored = await mem.store.get("user_a", saved.id);
    expect(stored?.definition.bots[0]?.botId).toBe("bot_secret_internal_99");
  });

  test("POST /from-thread graduates transcript with redaction and validates payload", async () => {
    const { app } = setupRouteApp();

    const badRes = await app.request("/api/workflows/from-thread", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "空会话", messages: [] }),
    });
    expect(badRes.status).toBe(400);

    const res = await app.request("/api/workflows/from-thread", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "每日发布巡检",
        slug: "release-check",
        messages: [
          {
            role: "user",
            text: "连接 cbd_device_123456789012 检查部署",
          },
          { role: "assistant", text: "部署健康。" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      definition: { slug: string; steps: unknown[] };
      markdown: string;
    };
    expect(payload.definition.slug).toBe("release-check");
    expect(payload.definition.steps).toHaveLength(1);
    expect(payload.markdown).not.toContain("cbd_device_123456789012");
    expect(payload.markdown).toContain("<REDACTED>");
  });

  test("POST /import forces imported schedule trigger to paused status and emits safety notice", async () => {
    const scheduleCalls: {
      ownerUserId: string;
      cron: string;
      title: string;
    }[] = [];
    const { app } = setupRouteApp({
      createPausedSchedule: async (ownerUserId, cron, title) => {
        scheduleCalls.push({ ownerUserId, cron, title });
        return { id: `sch_${scheduleCalls.length}`, status: "paused" };
      },
    });

    const wfWithSchedule = serializeWorkflowMarkdown(
      workflowDefinitionSchema.parse({
        slug: "scheduled-wf",
        name: "定时巡检",
        bots: [{ key: "a", name: "甲" }],
        steps: [{ id: "do", name: "检查", bot: "a", prompt: "巡检系统" }],
        schedule: { cron: "0 9 * * *", title: "每天九点巡检", paused: false },
      }),
    );

    const res = await app.request("/api/workflows/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: wfWithSchedule }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workflow: { definition: { schedule?: { paused?: boolean } } };
      schedule?: { id: string; status: string; cron: string; title: string };
      notice?: string;
      warnings?: string[];
    };
    expect(scheduleCalls).toEqual([
      { ownerUserId: "user_a", cron: "0 9 * * *", title: "每天九点巡检" },
    ]);
    expect(body.schedule?.status).toBe("paused");
    expect(body.workflow.definition.schedule?.paused).toBe(true);
    expect(body.notice).toBe(
      "导入的定时触发器默认处于暂停状态，请检查后手动开启",
    );
    expect(body.warnings).toContain(
      "导入的定时触发器默认处于暂停状态，请检查后手动开启",
    );

    const plainWf = serializeWorkflowMarkdown(
      workflowDefinitionSchema.parse({
        slug: "manual-wf",
        name: "手动工作流",
        bots: [{ key: "a", name: "甲" }],
        steps: [{ id: "do", name: "执行", bot: "a", prompt: "完成任务" }],
      }),
    );
    const resPlain = await app.request("/api/workflows/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: plainWf }),
    });
    expect(resPlain.status).toBe(201);
    expect(scheduleCalls).toHaveLength(1);

    const resOverride = await app.request("/api/workflows/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: plainWf,
        schedule: { cron: "15 10 * * *", title: "外部传入定时", paused: false },
      }),
    });
    expect(resOverride.status).toBe(201);
    const overrideBody = (await resOverride.json()) as {
      schedule?: { status: string; cron: string; title: string };
      notice?: string;
    };
    expect(overrideBody.schedule?.status).toBe("paused");
    expect(overrideBody.notice).toBe(
      "导入的定时触发器默认处于暂停状态，请检查后手动开启",
    );
    expect(scheduleCalls).toHaveLength(2);
    expect(scheduleCalls[1]).toEqual({
      ownerUserId: "user_a",
      cron: "15 10 * * *",
      title: "外部传入定时",
    });
  });

  test("POST /runs/:runId/resume consumes token once via CAS and rejects replay with 409", async () => {
    const { app, mem, engine, notices } = setupRouteApp();
    const def = workflowDefinitionSchema.parse({
      slug: "route-resume",
      name: "路由恢复",
      bots: [{ key: "a", name: "甲" }],
      steps: [{ id: "do", name: "执行", bot: "a", prompt: "运行" }],
    });

    const run = await engine.start({
      ownerUserId: "user_a",
      workflowId: "wf_r",
      definition: def,
      bindings: { a: "bot_1" },
      source: "page",
    });
    await waitForRunStatus(mem.runs, run.id, ["waiting_approval"]);
    const token = notices[0]!.resumeToken;

    const wrongOwner = await app.request(
      `/api/workflows/runs/${run.id}/resume`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-user": "user_b",
        },
        body: JSON.stringify({ token }),
      },
    );
    expect(wrongOwner.status).toBe(404);

    const ok = await app.request(`/api/workflows/runs/${run.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, comment: "已确认" }),
    });
    expect(ok.status).toBe(200);

    const replay = await app.request(`/api/workflows/runs/${run.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(replay.status).toBe(409);

    const done = await waitForRunStatus(mem.runs, run.id, [
      "succeeded",
      "failed",
    ]);
    expect(done.status).toBe("succeeded");
  });

  test("POST /runs/:runId/resume with decision reject cancels run and consumes token", async () => {
    const { app, mem, engine, notices } = setupRouteApp();
    const def = workflowDefinitionSchema.parse({
      slug: "route-reject",
      name: "拒绝恢复",
      bots: [{ key: "a", name: "甲" }],
      steps: [{ id: "do", name: "执行", bot: "a", prompt: "运行" }],
    });

    const run = await engine.start({
      ownerUserId: "user_a",
      workflowId: "wf_rej",
      definition: def,
      bindings: { a: "bot_1" },
      source: "page",
    });
    await waitForRunStatus(mem.runs, run.id, ["waiting_approval"]);
    const token = notices[0]!.resumeToken;

    const rejectedRes = await app.request(
      `/api/workflows/runs/${run.id}/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          decision: "reject",
          comment: "不再继续执行",
        }),
      },
    );
    expect(rejectedRes.status).toBe(200);
    const body = (await rejectedRes.json()) as {
      run: { status: string; steps: { status: string }[] };
    };
    expect(body.run.status).toBe("cancelled");
    expect(body.run.steps[0]?.status).toBe("cancelled");
    expect(mem.runs.get(run.id)?.resumeTokenHash).toBeNull();
  });
});
