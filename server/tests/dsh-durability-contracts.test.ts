import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { of } from "rxjs";
import { z } from "zod";
import {
  type ApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import { addAuditTap, createAuditStore } from "../src/audit";
import { createConversationBindings } from "../src/conversations/bindings";
import { createConversationInteractions } from "../src/conversations/interactions";
import { recoverConversations } from "../src/conversations/recovery";
import { createConversationRoutes } from "../src/conversations/routes";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDatabase } from "../src/db/client";
import {
  createLocalConversations,
  type LocalConversationBackend,
} from "../src/local-conversations";
import { createPluginStore } from "../src/plugins/store";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
class FinishedAgent extends AbstractAgent {
  run(input: RunAgentInput) {
    return of(
      {
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
      {
        type: "RUN_FINISHED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent,
    );
  }
}

(address ? describe : describe.skip)(
  "durable commands, tool effects and account isolation",
  () => {
    const owner = `durability-${randomUUID()}`,
      bot = `${owner}-bot`;
    let database: ReturnType<typeof createDatabase>;
    let backend: LocalConversationBackend;
    beforeAll(async () => {
      database = createDatabase(address!, { max: 4 });
      backend = await createLocalConversations(database);
      await createConversationBindings(database).ensure();
      await createToolOperationStore(database).ensure();
      await database.$client.unsafe(
        "CREATE TABLE IF NOT EXISTS work_items(kind text NOT NULL,key text NOT NULL,payload jsonb NOT NULL DEFAULT '{}',PRIMARY KEY(kind,key))",
      );
    }, 30_000);
    afterAll(async () => {
      await database.$client.close();
    });
    const inputFor = (threadId: string): RunAgentInput => ({
      threadId,
      runId: randomUUID(),
      messages: [{ id: randomUUID(), role: "user", content: "Continue once." }],
      state: {},
      tools: [],
      context: [],
    });

    test("maintenance leaves new HTTP and background admissions untouched and holds accepted work", async () => {
      const root = await mkdtemp(join(tmpdir(), "dsh-maintenance-")),
        oldRoot = process.env.CHISABOT_DSH_ROOT;
      const threadId = `${owner}-maintenance`,
        input = inputFor(threadId);
      await backend.client.getOrCreateThread({
        threadId,
        userId: owner,
        agentId: bot,
      });
      const accepted = await backend.commands.accept(owner, bot, input);
      const routes = createConversationRoutes({
        backend,
        identifyActor: async () => ({ id: owner, role: "user" }),
        resolver: {
          resolveAgentForActor: async () => new FinishedAgent({ agentId: bot }),
          resolveAgentsForActor: async () => ({
            [bot]: new FinishedAgent({ agentId: bot }),
          }),
        },
      });
      try {
        process.env.CHISABOT_DSH_ROOT = root;
        await writeFile(join(root, ".maintenance"), "draining");
        const refused = inputFor(threadId);
        const response = await routes.request(
          `/api/conversations/${threadId}/commands`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentId: bot, input: refused }),
          },
        );
        expect(response.status).toBe(503);
        expect(
          await backend.commands.get(owner, threadId, refused.messages[0]!.id),
        ).toBeUndefined();
        expect(() =>
          backend.runner.run({
            threadId,
            agent: new FinishedAgent({ agentId: bot }),
            input: refused,
          }),
        ).toThrow("服务正在更新");
        let builds = 0;
        const recovery = {
          backend,
          journal: createDshRunJournal(database),
          buildAgentFor: async () => {
            builds++;
            return new FinishedAgent({ agentId: bot });
          },
        };
        await recoverConversations(recovery);
        expect(builds).toBe(0);
        expect(
          (
            await backend.commands.get(
              owner,
              threadId,
              accepted.record.command_id,
            )
          )?.status,
        ).toBe("accepted");
        await unlink(join(root, ".maintenance"));
        await recoverConversations(recovery);
        for (let i = 0; i < 100 && backend.control.isActive(threadId); i++)
          await Bun.sleep(20);
        expect(builds).toBe(1);
        expect(
          (
            await backend.commands.get(
              owner,
              threadId,
              accepted.record.command_id,
            )
          )?.status,
        ).toBe("settled");
      } finally {
        if (oldRoot === undefined) delete process.env.CHISABOT_DSH_ROOT;
        else process.env.CHISABOT_DSH_ROOT = oldRoot;
      }
    }, 30_000);

    test("completed command receipt is reconciled, while admission before dispatch executes once", async () => {
      const threadId = `${owner}-completed`;
      await backend.client.getOrCreateThread({
        threadId,
        userId: owner,
        agentId: bot,
      });
      const accepted = await backend.commands.accept(
        owner,
        bot,
        inputFor(threadId),
      );
      await backend.commands.status(
        threadId,
        accepted.record.run_id,
        "dispatched",
      );
      await database.$client.unsafe(
        "INSERT INTO chisabot_local_runs(thread_id,run_id,status,finished_at) VALUES($1,$2,'finished',now())",
        [threadId, accepted.record.run_id],
      );
      await database.$client.unsafe(
        "INSERT INTO chisabot_local_events(thread_id,run_id,event) VALUES($1,$2,$3::text::jsonb)",
        [
          threadId,
          accepted.record.run_id,
          JSON.stringify({
            type: "RUN_FINISHED",
            threadId,
            runId: accepted.record.run_id,
          }),
        ],
      );
      let builds = 0;
      await recoverConversations({
        backend,
        journal: createDshRunJournal(database),
        buildAgentFor: async () => {
          builds++;
          return new FinishedAgent({ agentId: bot });
        },
      });
      expect(builds).toBe(0);
      expect(
        (
          await backend.commands.get(
            owner,
            threadId,
            accepted.record.command_id,
          )
        )?.status,
      ).toBe("settled");
      const restored: BaseEvent[] = [];
      await new Promise<void>((resolve, reject) =>
        backend.runner
          .connect({
            threadId,
            agentId: bot,
            commandId: accepted.record.command_id,
          })
          .subscribe({
            next: (event) => restored.push(event),
            error: reject,
            complete: resolve,
          }),
      );
      expect(
        restored.filter((event) => event.type === "RUN_FINISHED"),
      ).toHaveLength(1);

      const queuedThread = `${owner}-accepted`;
      await backend.client.getOrCreateThread({
        threadId: queuedThread,
        userId: owner,
        agentId: bot,
      });
      const queued = await backend.commands.accept(
        owner,
        bot,
        inputFor(queuedThread),
      );
      await recoverConversations({
        backend,
        journal: createDshRunJournal(database),
        buildAgentFor: async () => {
          builds++;
          return new FinishedAgent({ agentId: bot });
        },
      });
      for (let i = 0; i < 100 && backend.control.isActive(queuedThread); i++)
        await Bun.sleep(20);
      expect(
        (
          await backend.commands.get(
            owner,
            queuedThread,
            queued.record.command_id,
          )
        )?.status,
      ).toBe("settled");
      await recoverConversations({
        backend,
        journal: createDshRunJournal(database),
        buildAgentFor: async () => {
          builds++;
          return new FinishedAgent({ agentId: bot });
        },
      });
      expect(builds).toBe(1);
    }, 30_000);

    test("accepted commands retain their receipt if tool setup fails or maintenance starts before dispatch", async () => {
      const root = await mkdtemp(join(tmpdir(), "dsh-admission-")),
        priorRoot = process.env.CHISABOT_DSH_ROOT;
      let setupCalls = 0;
      const routes = createConversationRoutes({
        backend,
        identifyActor: async () => ({ id: owner, role: "user" }),
        resolver: {
          resolveAgentForActor: async () => new FinishedAgent({ agentId: bot }),
          resolveAgentsForActor: async () => ({
            [bot]: new FinishedAgent({ agentId: bot }),
          }),
        },
        toolsFor: async (_owner, _bot, input) => {
          setupCalls++;
          if (input.threadId.endsWith("setup-error"))
            throw new Error("temporary tool setup failure");
          await writeFile(join(root, ".maintenance"), "draining");
          return [];
        },
      });
      try {
        process.env.CHISABOT_DSH_ROOT = root;
        for (const kind of ["setup-error", "marker-race"]) {
          const threadId = `${owner}-${kind}`,
            input = inputFor(threadId);
          const send = () =>
            routes.request(`/api/conversations/${threadId}/commands`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ agentId: bot, input }),
            });
          const response = await send();
          expect(response.status).toBe(202);
          const receipt = await response.json();
          expect(receipt.accepted).toBe(true);
          expect(
            (await backend.commands.get(owner, threadId, input.messages[0]!.id))
              ?.status,
          ).toBe("accepted");
          expect(backend.control.isActive(threadId)).toBe(false);
          if (kind === "marker-race") await unlink(join(root, ".maintenance"));
          expect((await send()).status).toBe(200);
          await backend.commands.status(threadId, receipt.runId, "stopped");
        }
        expect(setupCalls).toBe(2);
      } finally {
        if (priorRoot === undefined) delete process.env.CHISABOT_DSH_ROOT;
        else process.env.CHISABOT_DSH_ROOT = priorRoot;
      }
    }, 30_000);

    test("skill save, answer and audit commit together, and maintenance prevents the write", async () => {
      // Minimal real tables for this isolated DB; existing migrated schemas remain authoritative.
      await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS skills(id text PRIMARY KEY,slug text UNIQUE NOT NULL,owner_user_id text,
      title text NOT NULL,summary text NOT NULL,instructions text NOT NULL,origin text DEFAULT 'yours' NOT NULL,installed_by text,
      created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`);
      await database.$client.unsafe(`CREATE TABLE IF NOT EXISTS audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_user_id text,
      initiator_kind text NOT NULL DEFAULT 'person',initiator_id text,event_type text NOT NULL,target_type text NOT NULL,target_id text,
      payload jsonb NOT NULL,created_at timestamptz DEFAULT now())`);
      const slug = `atomic-${randomUUID()}`,
        callId = `${slug}:card`,
        threadId = `${owner}-skill`;
      const store = createPluginStore({
        database,
        auditStore: createAuditStore(database),
        credentials: { readSecret: async () => null },
        encryptionKey: "x".repeat(44),
        policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
      });
      let failAfterSave = true,
        writes = 0;
      const taps: string[] = [];
      const removeTap = addAuditTap((event) => {
        if (event.targetId === slug) taps.push(event.eventType);
      });
      const interactions = createConversationInteractions(database, {
        saveSkill: async ({ transaction, afterCommit }) => {
          writes++;
          await store.installSkill(
            {
              slug,
              title: "Atomic skill",
              summary: "Fixture",
              instructions: "Do once",
              ownerUserId: null,
              by: owner,
            },
            { database: transaction, afterCommit },
          );
          if (failAfterSave) throw new Error("failure after skill save");
          return "saved once";
        },
      });
      const snapshot: ApprovalContinuation = {
        ...inputFor(threadId),
        toolCallId: callId,
        toolName: "save_skill",
        args: { slug },
        forwardedProps: {},
      };
      const waiting = await withApprovalContext(snapshot, () =>
        interactions.ask(owner, new AbortController().signal),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(waiting).toBeInstanceOf(Error);
      expect(() => {
        throw waiting;
      }).toThrow("等待你回答卡片");
      const routes = interactions.routes(async (context, next) => {
        context.set("actor", { id: owner, role: "user" });
        await next();
      });
      const answer = () =>
        routes.request(`/${callId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            answer: { kind: "save-skill", values: { slug } },
          }),
        });
      const count = async (table: string, column: string) =>
        (
          await database.$client.unsafe<{ count: number }[]>(
            `SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`,
            [slug],
          )
        )[0]!.count;
      const oldRoot = process.env.CHISABOT_DSH_ROOT,
        root = await mkdtemp(join(tmpdir(), "dsh-skill-maintenance-"));
      try {
        expect((await answer()).status).toBe(409);
        expect(await count("skills", "slug")).toBe(0);
        expect(await count("audit_events", "target_id")).toBe(0);
        expect(taps).toEqual([]);
        expect((await (await routes.request(`/${callId}`)).json()).status).toBe(
          "pending",
        );
        failAfterSave = false;
        process.env.CHISABOT_DSH_ROOT = root;
        await writeFile(join(root, ".maintenance"), "draining");
        expect((await answer()).status).toBe(503);
        expect(writes).toBe(1);
        await unlink(join(root, ".maintenance"));
        expect((await answer()).status).toBe(200);
        expect((await answer()).status).toBe(200);
        expect(writes).toBe(2);
        expect(await count("skills", "slug")).toBe(1);
        expect(await count("audit_events", "target_id")).toBe(1);
        expect(taps).toEqual(["configuration.changed"]);
        expect(await (await routes.request(`/${callId}`)).json()).toEqual({
          status: "answered",
          answer: "saved once",
          continuation: { state: "queued" },
        });
        const [work] = await database.$client.unsafe<{ count: number }[]>(
          "SELECT count(*)::int AS count FROM work_items WHERE kind='conversation.interaction-response' AND key=$1",
          [callId],
        );
        expect(work?.count).toBe(1);
      } finally {
        removeTap();
        if (oldRoot === undefined) delete process.env.CHISABOT_DSH_ROOT;
        else process.env.CHISABOT_DSH_ROOT = oldRoot;
      }
    }, 30_000);

    test("another account cannot observe, stop, append to or answer a known thread", async () => {
      const threadId = `${owner}-private`,
        input = inputFor(threadId);
      await backend.client.getOrCreateThread({
        threadId,
        userId: owner,
        agentId: bot,
      });
      const command = await backend.commands.accept(owner, bot, input);
      const routes = createConversationRoutes({
        backend,
        identifyActor: async (request) => ({
          id: request.headers.get("x-actor") ?? owner,
          role: "user",
        }),
        resolver: {
          resolveAgentForActor: async () => new FinishedAgent({ agentId: bot }),
          resolveAgentsForActor: async () => ({
            [bot]: new FinishedAgent({ agentId: bot }),
          }),
        },
      });
      const attack = {
        headers: {
          "x-actor": "another-account",
          "content-type": "application/json",
        },
      };
      expect(
        (
          await routes.request(
            `/api/conversations/${threadId}/commands/${command.record.command_id}`,
            attack,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await routes.request(`/api/conversations/${threadId}/events`, {
            ...attack,
            method: "POST",
            body: JSON.stringify({ commandId: command.record.command_id }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await routes.request(`/api/conversations/agent/${bot}/connect`, {
            ...attack,
            method: "POST",
            body: JSON.stringify({ threadId }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await routes.request(
            `/api/conversations/agent/${bot}/stop/${threadId}`,
            { ...attack, method: "POST", body: "{}" },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await routes.request(`/api/conversations/${threadId}/commands`, {
            ...attack,
            method: "POST",
            body: JSON.stringify({ agentId: bot, input }),
          })
        ).status,
      ).toBe(404);

      const bindings = createConversationBindings(database),
        journal = createDshRunJournal(database);
      const binding = await bindings.getOrCreate({
        threadId,
        ownerUserId: owner,
        botId: bot,
        runtimeId: "fixture",
      });
      await journal.accept({
        thread_id: threadId,
        run_id: input.runId,
        owner_user_id: owner,
        bot_id: bot,
        session_id: binding.sessionId,
        binding_revision: 1,
        generation: "fixture",
        baseline: 0,
        input,
        initiator: { kind: "person" },
        request_id: input.messages[0]!.id,
      });
      await journal.status(threadId, input.runId, "waiting");
      const interactions = createConversationInteractions(database);
      const snapshot: ApprovalContinuation = {
        ...input,
        toolCallId: `${owner}-question`,
        toolName: "ask_person",
        args: { question: "Continue?" },
        forwardedProps: {},
      };
      const waiting = await withApprovalContext(snapshot, () =>
        interactions.ask(owner, new AbortController().signal),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(waiting).toBeInstanceOf(Error);
      expect(() => {
        throw waiting;
      }).toThrow("等待你回答卡片");
      const cards = interactions.routes(async (context, next) => {
        context.set("actor", {
          id: context.req.header("x-actor") ?? owner,
          role: "user",
        });
        await next();
      });
      expect(
        (
          await cards.request(`/${snapshot.toolCallId}`, {
            ...attack,
            method: "POST",
            body: JSON.stringify({ answer: "yes" }),
          })
        ).status,
      ).toBe(409);
      await journal.stop(threadId, input.runId);
      expect(
        (
          await cards.request(`/${snapshot.toolCallId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ answer: "yes" }),
          })
        ).status,
      ).toBe(409);
      expect(
        (await (await cards.request(`/${snapshot.toolCallId}`)).json()).status,
      ).toBe("pending");
      await backend.runner.stop({ threadId, runId: input.runId });
      expect(
        (await (await cards.request(`/${snapshot.toolCallId}`)).json()).status,
      ).toBe("cancelled");
      await backend.commands.status(threadId, command.record.run_id, "stopped");
    }, 30_000);

    test("a real API crash after the effect records outcome_unknown without repeating it", async () => {
      const threadId = `${owner}-crash`,
        sessionId = randomUUID(),
        callId = "effect",
        runId = randomUUID(),
        bindingId = randomUUID();
      const identity = {
        sessionId,
        runId,
        threadId,
        botId: bot,
        actorId: owner,
        revision: 1,
        generation: "fixture",
      };
      const args = { value: "once" },
        input = inputFor(threadId);
      const messages: Message[] = [
        {
          id: "call",
          role: "assistant",
          toolCalls: [
            {
              id: `${sessionId}:1:1:${callId}`,
              type: "function",
              function: { name: "write_once", arguments: JSON.stringify(args) },
            },
          ],
        },
      ];
      const folder = await mkdtemp(join(tmpdir(), "dsh-effect-")),
        effectFile = join(folder, "effect.txt"),
        configFile = join(folder, "config.json");
      const registration = { bindingId, identity, input };
      await writeFile(
        configFile,
        JSON.stringify({ registration, messages, effectFile }),
      );
      const child = spawn(
        process.execPath,
        [resolve("server/tests/support/dsh-tool-crash-server.ts"), configFile],
        {
          windowsHide: true,
          env: { ...process.env, CHISABOT_DSH_TEST_DATABASE_URL: address },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let logs = "";
      child.stdout.on("data", (chunk) => {
        logs += chunk;
      });
      child.stderr.on("data", (chunk) => {
        logs += chunk;
      });
      try {
        let ready: { origin: string; capability: string } | undefined;
        for (let i = 0; i < 200 && !ready; i++) {
          const line = logs
            .split(/\r?\n/)
            .find((line) => line.startsWith('{"ready":true'));
          if (line) ready = JSON.parse(line);
          else await Bun.sleep(25);
        }
        expect(ready, logs).toBeDefined();
        const body = {
          binding: identity,
          callId,
          name: "write_once",
          args,
          turn: 1,
          step: 1,
          throughSeq: 1,
        };
        const exited = once(child, "exit");
        const disconnected = await fetch(`${ready!.origin}/execute`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ready!.capability}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(disconnected).toBeInstanceOf(Error);
        await exited;
        expect(child.exitCode).toBe(78);
        expect(await readFile(effectFile, "utf8")).toBe("effect\n");
        const operations = createToolOperationStore(database),
          gateway = createDshToolGateway(operations);
        let executions = 0;
        const token = gateway.register({
          ...registration,
          signal: new AbortController().signal,
          continuationMessages: async () => messages,
          tools: [
            {
              name: "write_once",
              ref: "fixture/write",
              description: "Write once.",
              parameters: z.object({ value: z.string() }),
              execute: async () => {
                executions++;
                return "repeated";
              },
            },
          ],
        });
        const request = (value: unknown) =>
          gateway.routes.request("/execute", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token.capability}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(value),
          });
        expect(
          (
            await request({
              ...body,
              binding: { ...identity, actorId: "another-account" },
            })
          ).status,
        ).toBe(403);
        expect(
          (await request({ ...body, args: { value: "tampered" } })).status,
        ).toBe(409);
        const replay = await request(body);
        expect(replay.status).toBe(202);
        expect((await replay.json()).waiting.kind).toBe("operation_unknown");
        expect(executions).toBe(0);
        const [operation] = await database.$client.unsafe<
          { id: string; status: string }[]
        >(
          "SELECT id,status FROM chisabot_tool_operations WHERE binding_id=$1",
          [bindingId],
        );
        expect(operation?.status).toBe("outcome_unknown");
        // A subsequently recovered real receipt may resolve uncertainty; it does not rerun the tool.
        await operations.settle(operation!.id, "completed", {
          content: "receipt recovered",
        });
        expect(await (await request(body)).json()).toEqual({
          content: "receipt recovered",
        });
        expect(executions).toBe(0);
        token.close();
      } finally {
        if (child.exitCode === null) {
          const done = once(child, "exit");
          child.kill();
          await done;
        }
      }
    }, 30_000);
  },
);
