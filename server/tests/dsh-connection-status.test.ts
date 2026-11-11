import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { DshHostClient } from "../../runtime/dsh/src/client.mjs";
import { DshRuntimeAgent } from "../src/agents/dsh-runtime";
import { createConversationBindings } from "../src/conversations/bindings";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDatabase } from "../src/db/client";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

(address ? test : test.skip)(
  "DSH reconnect stays recovering until the new follow snapshot is caught up",
  async () => {
    const database = createDatabase(address!, { max: 4 });
    const resources: (() => unknown | Promise<unknown>)[] = [
      () => database.$client.close(),
    ];
    const finishModel = gate();
    const catchup = gate();
    try {
      const bindings = createConversationBindings(database);
      const operations = createToolOperationStore(database);
      const journal = createDshRunJournal(database);
      await bindings.ensure();
      await operations.ensure();
      await journal.ensure();
      const gateway = createDshToolGateway(operations, journal);
      const owner = `connection-${randomUUID()}`;
      const threadId = `thread-${owner}`;
      let requests = 0;
      const encoder = new TextEncoder();
      const bridge = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname.startsWith("/execute"))
            return gateway.routes.fetch(request);
          requests++;
          return new Response(
            new ReadableStream({
              start(controller) {
                const frame = (
                  delta: unknown,
                  finish_reason: string | null = null,
                ) =>
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
                    ),
                  );
                frame({
                  role: "assistant",
                  content: "prefix before reconnect",
                });
                void finishModel.promise.then(() => {
                  frame({ content: " and final tail" });
                  frame({}, "stop");
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                });
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      resources.push(() => bridge.stop(true));
      const runtime = resolve("runtime/dsh");
      await mkdir(join(runtime, ".runtime"), { recursive: true });
      const home = await mkdtemp(join(runtime, ".runtime", "connection-"));
      const connectionFile = join(home, "connection.json");
      await writeFile(
        join(home, "chisabot.json"),
        JSON.stringify({
          ownerUserId: owner,
          port: 0,
          providers: {},
          gatewayUrl: bridge.url.origin,
        }),
      );
      let logs = "";
      const host = spawn("node", ["src/start.mjs"], {
        cwd: runtime,
        windowsHide: true,
        env: { ...process.env, CHISABOT_DSH_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      host.stdout.on("data", (chunk) => {
        logs += chunk;
      });
      host.stderr.on("data", (chunk) => {
        logs += chunk;
      });
      resources.push(async () => {
        if (host.exitCode === null) {
          const ended = once(host, "exit");
          host.kill();
          await ended;
        }
      });
      await until(
        () => logs.includes("chisabot-runtime-ready"),
        logs || "Host not ready",
      );
      let followCount = 0;
      let catchupEntered = false;
      const originalFollow = DshHostClient.prototype.follow;
      const follow = spyOn(
        DshHostClient.prototype,
        "follow",
      ).mockImplementation(async function* (sessionId, signal) {
        const attempt = ++followCount;
        for await (const frame of originalFollow.call(
          this,
          sessionId,
          signal,
        )) {
          yield frame;
          if (attempt === 1 && frame.type === "assistant-stream")
            throw new Error("controlled observation transport drop");
        }
      });
      resources.push(() => follow.mockRestore());
      const originalEvents = DshHostClient.prototype.eventsAfter;
      const eventsAfter = spyOn(
        DshHostClient.prototype,
        "eventsAfter",
      ).mockImplementation(
        async function (sessionId, afterSeq, throughSeq, signal) {
          if (followCount >= 2 && throughSeq !== undefined && !catchupEntered) {
            catchupEntered = true;
            await catchup.promise;
          }
          return originalEvents.call(
            this,
            sessionId,
            afterSeq,
            throughSeq,
            signal,
          );
        },
      );
      resources.push(() => eventsAfter.mockRestore());
      const agent = new DshRuntimeAgent({
        botId: "bot",
        binding: {
          bindings,
          gateway,
          journal,
          toolGatewayUrl: bridge.url.origin,
          targetFor: async () => ({
            id: "fixture",
            ownerUserId: owner,
            connectionFile,
          }),
          readRun: (value) => JSON.parse(String(value)),
        },
        signRun: (value) =>
          JSON.stringify({
            actorId: owner,
            botId: "bot",
            runId: value.runId,
            threadId: value.threadId,
          }),
        tools: [],
        prompt: () => "Reply with text.",
        connection: {
          provider: "openai",
          baseUrl: `${bridge.url.origin}/v1`,
          apiKey: "fixture-only",
          model: "fixture",
        },
        modelInfo: async () => ({
          contextWindow: 32000,
          maxOutputTokens: 1024,
        }),
        fallbacks: async () => [],
      });
      const input: RunAgentInput = {
        threadId,
        runId: `run-${owner}`,
        messages: [{ id: `user-${owner}`, role: "user", content: "Reply" }],
        state: {},
        tools: [],
        context: [],
      };
      const events: BaseEvent[] = [];
      const done = new Promise<void>((resolve, reject) =>
        agent.run(input).subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        }),
      );
      resources.push(async () => {
        catchup.release();
        finishModel.release();
        await done;
      });
      const statuses = () =>
        events
          .filter(
            (event) =>
              event.type === "CUSTOM" &&
              (event as { name?: string }).name === "chisabot.connection",
          )
          .map(
            (event) => (event as { value: { status: string } }).value.status,
          );
      await until(
        () => catchupEntered,
        `reconnect snapshot not reached: ${JSON.stringify(events)}`,
      );
      expect(statuses()).toEqual(["reconnecting"]);
      expect(followCount).toBeGreaterThanOrEqual(2);
      catchup.release();
      await until(
        () => statuses().includes("online"),
        "snapshot catchup did not restore online",
      );
      expect(statuses()).toEqual(["reconnecting", "online"]);
      finishModel.release();
      await done;
      expect(events.some((event) => event.type === "RUN_ERROR")).toBe(false);
      expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(true);
      expect(requests).toBe(1);
      const endpoint = JSON.parse(
        await readFile(connectionFile, "utf8"),
      ).endpoint;
      const check = await DshHostClient.connect(endpoint);
      try {
        expect(
          (await check.health()).sessions.every(
            (session) => session.state === "idle",
          ),
        ).toBe(true);
      } finally {
        await check.close();
      }
    } finally {
      catchup.release();
      finishModel.release();
      for (const close of resources.reverse()) await close();
    }
  },
  40_000,
);
