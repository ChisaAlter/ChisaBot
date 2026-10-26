import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import type { ApprovalContinuation } from "../src/approvals/types";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createComputerGateway } from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";

/**
 * The browser's command goes through approvals, not the direct /computers/:id/exec route. A real
 * process writes START, waits, then writes DONE: aborting only the browser's promise cannot pass.
 * The portable fixture tests both HTTP disconnects on Bun without requiring bash or Chromium.
 * CHISABOT_COMPUTER_STOP_HTTP=1 also runs against the actual Linux agent-computer dispatcher/shell.
 */
const realComputer = process.env.CHISABOT_COMPUTER_STOP_HTTP === "1";
const token = "computer-stop-test-token";
const delayMs = 900;
if (realComputer && process.platform !== "linux")
  throw new Error("CHISABOT_COMPUTER_STOP_HTTP=1 requires Linux and /bin/bash.");

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for the command fixture's observable condition.");
    await Bun.sleep(10);
  }
}

function snapshot(command: string): ApprovalContinuation {
  const args = { command, timeoutSec: 5 };
  return {
    runId: "stop-run",
    threadId: "stop-thread",
    toolCallId: "stop-call",
    toolName: "computer_run_command",
    args,
    messages: [
      { id: "u1", role: "user", content: "Run the delayed command once." },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "stop-call",
          type: "function",
          function: { name: "computer_run_command", arguments: JSON.stringify(args) },
        }],
      },
    ],
    state: {},
    context: [],
    forwardedProps: {},
  };
}

async function fixture(streamAfterMs: number, actualComputer = false) {
  const root = await mkdtemp(join(tmpdir(), "computer-stop-"));
  const logPath = join(root, "probe.log");
  const audit: AuditEventInput[] = [];
  const workers = new Set<ReturnType<typeof Bun.spawn>>();
  let computer: ReturnType<typeof Bun.serve> | undefined;
  let agent: ReturnType<typeof Bun.spawn> | undefined;
  let base: string;
  let completed = 0;
  if (actualComputer) {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    await probe.stop(true);
    base = `http://127.0.0.1:${port}`;
    agent = Bun.spawn([process.execPath, "src/index.ts"], {
      cwd: join(import.meta.dir, "../../agent-computer"),
      env: {
        ...process.env,
        COMPUTER_TOKEN: token,
        COMPUTER_BROWSER_BACKEND: "managed",
        COMPUTER_BROWSER_MODE: "headless",
        PORT: String(port),
        PROFILES_DIR: join(root, "profiles"),
        WORKSPACE_DIR: root,
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    try {
      await until(async () => {
        if (agent?.exitCode !== null)
          throw new Error(`agent-computer exited with ${agent?.exitCode}.`);
        return fetch(`${base}/health`).then((response) => response.ok, () => false);
      });
    } catch (error) {
      agent.kill();
      await agent.exited;
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  } else {
    computer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { command } = await request.json() as { command: string };
        const worker = Bun.spawn([process.execPath, "-e", command], {
          cwd: root,
          stdout: "ignore",
          stderr: "inherit",
        });
        workers.add(worker);
        const stop = () => worker.kill(9);
        if (request.signal.aborted) stop();
        else request.signal.addEventListener("abort", stop, { once: true });
        const exitCode = await worker.exited;
        request.signal.removeEventListener("abort", stop);
        workers.delete(worker);
        completed++;
        return Response.json({
          command, exitCode, stdout: "", stderr: "", truncated: false,
          timedOut: false, elapsedMs: 1,
        });
      },
    });
    base = String(computer.url).replace(/\/$/, "");
  }
  const gateway = createComputerGateway({
    provider: {
      name: "stop-test",
      isolation: "per-bot",
      locate: async () => base,
      status: async (botId) => ({ botId, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: true }),
      reset: async () => ({ cleared: true }),
    },
    token,
    auditStore: { insert: async (event) => { audit.push(event); } },
    policy: () => ({ mode: "enforce", allow: ["true"], deny: [] }),
    approvalGate: (candidate) => service.gate(candidate),
  });
  const service = createApprovalService(
    { enabled: async () => false } as never,
    undefined,
    async (ownerUserId, botId, action, signal) => {
      const tool = createHeadlessComputerTools({
        gateway,
        botId,
        actor: { id: ownerUserId, initiator: { kind: "person" } },
      }).find((tool) => tool.definition.name === action.toolName);
      if (!tool) throw new Error("Missing command tool.");
      return tool.execute(action.args, { toolCallId: action.toolCallId, signal });
    },
  );
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/api/approvals", createApprovalRoutes(service, async (context, next) => {
    context.set("actor", { id: "owner", email: "owner@example.test", role: "user" });
    await next();
  }, { streamAfterMs, heartbeatMs: 20 }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const command = actualComputer
    // A descendant of bash owns the delayed effect, so killing bash alone cannot pass this test.
    ? `printf 'START\\n' >> probe.log; (sleep ${delayMs / 1000}; printf 'DONE\\n' >> probe.log) & wait`
    : `import { appendFileSync } from "node:fs"; appendFileSync("probe.log", "START\\n"); setTimeout(() => appendFileSync("probe.log", "DONE\\n"), ${delayMs});`;
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot(command)),
  };
  return {
    get log() { return Bun.file(logPath); },
    audit,
    app,
    init,
    url: new URL("api/approvals/computer/bot-stop", server.url),
    started: () => until(async () => {
      const file = Bun.file(logPath);
      return (await file.exists()) && (await file.text()) === "START\n";
    }),
    stopped: () => until(() => audit.some((event) => event.eventType === "computer.action_stopped")),
    completed: () => completed,
    async close() {
      await server.stop(true);
      for (const worker of workers) worker.kill(9);
      await Promise.all([...workers].map((worker) => worker.exited));
      await computer?.stop(true);
      agent?.kill();
      if (agent) await agent.exited;
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Web Stop reaches the executing computer command", () => {
  test("an uninterrupted command really performs its delayed write", async () => {
    const f = await fixture(20);
    try {
      const response = await fetch(f.url, f.init);
      expect(await response.json()).toMatchObject({ result: { ok: true, exitCode: 0 } });
      expect(await f.log.text()).toBe("START\nDONE\n");
      expect(f.completed()).toBe(1);
    } finally {
      await f.close();
    }
  });

  test.each([
    ["before response headers", 20_000],
    ["after the heartbeat stream starts", 20],
  ])("Stop %s prevents the delayed process side effect", async (_name, streamAfterMs) => {
    const f = await fixture(streamAfterMs);
    const controller = new AbortController();
    let receivedResponse = false;
    const request = fetch(f.url, { ...f.init, signal: controller.signal })
      .then(async (response) => {
        receivedResponse = true;
        return response.text();
      }).then(() => "finished", () => "aborted");
    try {
      await f.started();
      if (streamAfterMs < 100) await until(() => receivedResponse);
      else expect(receivedResponse).toBe(false);
      controller.abort();
      expect(await request).toBe("aborted");
      await f.stopped();
      await until(() => f.completed() === 1);
      await Bun.sleep(delayMs + 100);
      expect(await f.log.text()).toBe("START\n");
      expect(f.audit.some((event) => event.eventType === "computer.action_failed")).toBe(false);
    } finally {
      controller.abort();
      await request;
      await f.close();
    }
  }, 15_000);

  test("cancelling a streaming response also stops its action without a request abort", async () => {
    const f = await fixture(20);
    try {
      const response = await f.app.request("/api/approvals/computer/bot-stop", f.init);
      expect(response.headers.get("x-chisabot-long-action")).toBe("1");
      await f.started();
      await response.body!.cancel();
      await f.stopped();
      await until(() => f.completed() === 1);
      await Bun.sleep(delayMs + 100);
      expect(await f.log.text()).toBe("START\n");
    } finally {
      await f.close();
    }
  }, 15_000);
});

describe.skipIf(!realComputer)("Linux Bun request abort reaches the actual agent-computer process group", () => {
  test.each([
    ["before response headers", 20_000],
    ["after the heartbeat stream starts", 20],
  ])("Stop %s kills descendants before they write DONE", async (_name, streamAfterMs) => {
    const f = await fixture(streamAfterMs, true);
    const controller = new AbortController();
    let receivedResponse = false;
    const request = fetch(f.url, { ...f.init, signal: controller.signal })
      .then(async (response) => {
        receivedResponse = true;
        return response.text();
      }).then(() => "finished", () => "aborted");
    try {
      await f.started();
      if (streamAfterMs < 100) await until(() => receivedResponse);
      controller.abort();
      expect(await request).toBe("aborted");
      await f.stopped();
      // Wait beyond the descendant's original write deadline, not only for the HTTP promise to reject.
      await Bun.sleep(delayMs + 100);
      expect(await f.log.text()).toBe("START\n");
      const recovery = await fetch(f.url, {
        ...f.init,
        body: JSON.stringify(snapshot("printf RECOVERY_OK")),
      });
      expect(await recovery.json()).toMatchObject({ result: { ok: true, exitCode: 0, stdout: "RECOVERY_OK" } });
    } finally {
      controller.abort();
      await request;
      await f.close();
    }
  }, 30_000);
});
