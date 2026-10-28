import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  COMMAND_TIMEOUT_GUIDE,
  commandTimeoutNote,
  normalizeCommandTimeout,
} from "../../shared/command-timeout";
import { createApprovalRoutes } from "../src/approvals/routes";
import type { ApprovalService } from "../src/approvals/service";
import { createHeadlessComputerTools, HeadlessToolSuspension } from "../src/computer/headless-tools";
import { createComputerGateway } from "../src/computer/gateway";

/**
 * 机器人自己电脑上的前台命令超时（DESIGN.md §102）。
 *
 * 2026-10-18 真实 UI 长任务：computer_run_command 只收 `command`，默认 120 秒被停；模型传 timeoutSec 被
 * 严格校验拒掉，只好退到云端工作区节点（device_run_shell）跑完，还在用户的云端工作区里留下文件。
 */

describe("normalizeCommandTimeout", () => {
  test("no timeout keeps the 120 s default", () => {
    expect(normalizeCommandTimeout({})).toEqual({ timeoutMs: undefined, effectiveSec: 120, clamped: false });
    expect(normalizeCommandTimeout({ timeoutSec: 0 })).toMatchObject({ timeoutMs: undefined, effectiveSec: 120 });
    expect(normalizeCommandTimeout({ timeoutSec: "abc" })).toMatchObject({ timeoutMs: undefined });
  });
  test("seconds and milliseconds are both accepted; seconds win", () => {
    expect(normalizeCommandTimeout({ timeoutSec: 300 })).toEqual({ timeoutMs: 300_000, effectiveSec: 300, clamped: false });
    expect(normalizeCommandTimeout({ timeoutSec: "300" })).toMatchObject({ timeoutMs: 300_000 });
    expect(normalizeCommandTimeout({ timeoutMs: 240_000 })).toEqual({ timeoutMs: 240_000, effectiveSec: 240, clamped: false });
    expect(normalizeCommandTimeout({ timeoutSec: 200, timeoutMs: 500_000 })).toMatchObject({ timeoutMs: 200_000 });
  });
  test("a tiny timeoutMs is read as seconds, not a 0.3 s kill", () => {
    expect(normalizeCommandTimeout({ timeoutMs: 300 })).toMatchObject({ timeoutMs: 300_000, clamped: false });
  });
  test("out-of-range values are clamped to 1–600 s instead of refused", () => {
    expect(normalizeCommandTimeout({ timeoutSec: 900 })).toEqual({ timeoutMs: 600_000, effectiveSec: 600, clamped: true });
    expect(normalizeCommandTimeout({ timeoutMs: 3_600_000 })).toMatchObject({ timeoutMs: 600_000, clamped: true });
    expect(normalizeCommandTimeout({ timeoutSec: 0.2 })).toMatchObject({ timeoutMs: 1_000, clamped: true });
  });
  test("the note says not to repeat the command unchanged", () => {
    expect(commandTimeoutNote(120)).toContain("larger timeoutSec");
    expect(commandTimeoutNote(120)).toContain("Do not repeat it unchanged");
    expect(commandTimeoutNote(600)).toContain("background");
    expect(COMMAND_TIMEOUT_GUIDE).toContain("600");
  });
});

function harness(execResult: Record<string, unknown> = {}) {
  const received: { path: string; body?: Record<string, unknown> }[] = [];
  const gateway = createComputerGateway({
    provider: {
      name: "test",
      isolation: "per-bot",
      locate: async () => "http://computer:4100",
      status: async (botId) => ({ botId, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: true }),
      reset: async () => ({ cleared: true }),
    },
    auditStore: { insert: async () => {} },
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      received.push({ path, ...(body ? { body } : {}) });
      return Response.json({
        command: body?.command ?? "",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        elapsedMs: 1,
        timedOut: false,
        truncated: false,
        ...execResult,
      });
    },
  });
  const tools = createHeadlessComputerTools({
    gateway,
    botId: "bot",
    actor: { id: "owner", userId: "owner", initiator: { kind: "routine", id: "routine" } },
  });
  const run = (args: unknown) => {
    const tool = tools.find((t) => t.definition.name === "computer_run_command");
    if (!tool) throw new Error("missing computer_run_command");
    return tool.execute(args, { toolCallId: "c1", signal: new AbortController().signal }) as Promise<Record<string, unknown>>;
  };
  const schema = tools.find((t) => t.definition.name === "computer_run_command")?.definition;
  return { received, run, schema };
}

describe("computer_run_command (unattended / approvals path)", () => {
  test("the schema offers timeoutSec and timeoutMs and the description explains them", () => {
    const { schema } = harness();
    if (!schema) throw new Error("missing computer_run_command");
    const properties = (schema.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["command", "timeoutMs", "timeoutSec"]);
    expect(schema.description).toContain("timeoutSec");
    expect(schema.description).toContain("600");
  });

  test("timeoutSec reaches /exec as timeoutMs (no more 'Unrecognized key: timeoutSec')", async () => {
    const { received, run } = harness();
    await expect(run({ command: "python3 slow.py", timeoutSec: 300 })).resolves.toMatchObject({ ok: true });
    await run({ command: "sleep 1", timeoutMs: 240_000 });
    await run({ command: "pwd" });
    // The gateway names the Bot itself (never the model), so the command's traffic is that Bot's.
    expect(received.map((r) => r.body)).toEqual([
      { command: "python3 slow.py", timeoutMs: 300_000, botId: "bot" },
      { command: "sleep 1", timeoutMs: 240_000, botId: "bot" },
      { command: "pwd", botId: "bot" },
    ]);
  });

  test("an over-long timeout runs at 600 s and says so", async () => {
    const { received, run } = harness();
    const result = await run({ command: "make", timeoutSec: 3600 });
    expect(received[0]?.body).toEqual({
      command: "make",
      timeoutMs: 600_000,
      botId: "bot",
    });
    expect(String(result.timeoutAdjusted)).toContain("600 seconds");
  });

  test("unknown keys are still refused", async () => {
    const { run } = harness();
    await expect(run({ command: "pwd", botId: "victim" })).rejects.toThrow();
  });

  test("a timed-out command comes back with the limit and a next step", async () => {
    const { run } = harness({ timedOut: true, exitCode: -1 });
    const result = await run({ command: "python3 slow.py", timeoutSec: 30 });
    expect(result).toMatchObject({ ok: true, timedOut: true, timeoutSec: 30 });
    expect(String(result.timeoutNote)).toContain("Do not repeat it unchanged");
    const defaulted = await run({ command: "python3 slow.py" });
    expect(defaulted).toMatchObject({ timeoutSec: 120 });
  });
});

describe("POST /api/approvals/computer/:botId for long actions", () => {
  const app = (frontendAction: () => Promise<unknown>) => {
    const root = new Hono();
    root.route(
      "/",
      createApprovalRoutes(
        { frontendAction } as unknown as ApprovalService,
        async (context, next) => {
          context.set("actor" as never, { id: "dev-local-user", role: "admin" } as never);
          await next();
        },
        { streamAfterMs: 30, heartbeatMs: 10 },
      ),
    );
    return root;
  };
  const post = (frontendAction: () => Promise<unknown>) =>
    app(frontendAction).request("/computer/agent_1", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

  test("a quick action is answered exactly as before", async () => {
    const response = await post(async () => ({ ok: true, stdout: "hi" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-chisabot-long-action")).toBeNull();
    expect(await response.json()).toEqual({ result: { ok: true, stdout: "hi" } });
  });

  test("a long action starts the response at once, keeps it alive, and ends with the result", async () => {
    const response = await post(async () => {
      await Bun.sleep(120);
      return { ok: true, stdout: "done", timedOut: false };
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-chisabot-long-action")).toBe("1");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    // Heartbeats are leading whitespace, which JSON.parse accepts.
    expect(text.length - text.trimStart().length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(text)).toEqual({ result: { ok: true, stdout: "done", timedOut: false } });
  });

  test("a long action that ends in a wait or an error carries its status in the body", async () => {
    const waiting = await post(async () => {
      await Bun.sleep(80);
      throw new HeadlessToolSuspension("needs approval", { kind: "approval", requestId: "a1" });
    });
    expect(waiting.status).toBe(200);
    expect(JSON.parse(await waiting.text())).toEqual({
      waiting: true,
      kind: "approval",
      approvalId: "a1",
      reason: "needs approval",
      status: 202,
    });
    const failed = await post(async () => {
      await Bun.sleep(80);
      throw new TypeError("bug");
    });
    expect(JSON.parse(await failed.text())).toEqual({ error: "bug", status: 500 });
  });
});
