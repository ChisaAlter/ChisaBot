import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { of } from "rxjs";
import { z } from "zod";
import { historyRecoverTools } from "../src/agents/history-recover";
import { ApprovalRefusedError } from "../src/approvals/types";
import { createConversationBindings } from "../src/conversations/bindings";
import { createConversationRoutes } from "../src/conversations/routes";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDatabase } from "../src/db/client";
import { createLocalConversations } from "../src/local-conversations";
import type { GrantedTool } from "../src/plugins/tools";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
(address ? describe : describe.skip)("tool outcome recovery", () => {
  const owner = `outcomes-${randomUUID()}`;
  const bot = `${owner}-bot`;
  let database: ReturnType<typeof createDatabase>;
  let backend: Awaited<ReturnType<typeof createLocalConversations>>;
  let operations: ReturnType<typeof createToolOperationStore>;
  let journal: ReturnType<typeof createDshRunJournal>;
  let bindings: ReturnType<typeof createConversationBindings>;
  beforeAll(async () => {
    database = createDatabase(address!, { max: 4 });
    backend = await createLocalConversations(database);
    operations = createToolOperationStore(database);
    journal = createDshRunJournal(database);
    bindings = createConversationBindings(database);
    await bindings.ensure();
    await operations.ensure();
  }, 30_000);
  afterAll(async () => {
    await database.$client.unsafe(
      "DELETE FROM chisabot_tool_operations WHERE owner_user_id=$1",
      [owner],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_dsh_runs WHERE owner_user_id=$1",
      [owner],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_runtime_bindings WHERE owner_user_id=$1",
      [owner],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_conversation_commands WHERE owner_user_id=$1",
      [owner],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_local_threads WHERE owner_user_id=$1",
      [owner],
    );
    await database.$client.close();
  });

  async function setup(tool: GrantedTool) {
    const threadId = randomUUID(),
      runId = randomUUID();
    await backend.client.getOrCreateThread({
      threadId,
      userId: owner,
      agentId: bot,
    });
    const binding = await bindings.getOrCreate({
      threadId,
      ownerUserId: owner,
      botId: bot,
      runtimeId: owner,
    });
    const toolCallId = `${binding.sessionId}:0:0:call`;
    const messages: Message[] = [
      { id: randomUUID(), role: "user", content: "Perform the isolated task." },
      {
        id: randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: tool.name, arguments: "{}" },
          },
        ],
      },
    ];
    const input: RunAgentInput = {
      threadId,
      runId,
      messages,
      tools: [],
      context: [],
      state: {},
    };
    await journal.accept({
      thread_id: threadId,
      run_id: runId,
      owner_user_id: owner,
      bot_id: bot,
      session_id: binding.sessionId,
      binding_revision: binding.revision,
      generation: "fixture",
      baseline: 0,
      input,
      initiator: { kind: "person" },
      request_id: messages[0]!.id,
    });
    await database.$client.unsafe(
      "INSERT INTO chisabot_local_runs(thread_id,run_id,status) VALUES($1,$2,'finished')",
      [threadId, runId],
    );
    await database.$client.unsafe(
      "UPDATE chisabot_local_threads SET messages=$2::text::jsonb WHERE id=$1",
      [threadId, JSON.stringify(messages)],
    );
    const identity = {
      sessionId: binding.sessionId,
      runId,
      threadId,
      botId: bot,
      actorId: owner,
      revision: binding.revision,
      generation: "fixture",
    };
    const gateway = createDshToolGateway(operations, journal);
    const registered = gateway.register({
      bindingId: binding.bindingId,
      identity,
      input,
      tools: [tool],
      signal: new AbortController().signal,
      continuationMessages: async () => messages,
    });
    const request = () =>
      gateway.routes.request("/execute", {
        method: "POST",
        headers: {
          authorization: `Bearer ${registered.capability}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          binding: identity,
          callId: "call",
          name: tool.name,
          args: {},
          turn: 0,
          step: 0,
          throughSeq: 0,
        }),
      });
    const row = async () =>
      (
        await database.$client.unsafe<
          {
            id: string;
            status: string;
            result: { content: string; error?: string };
          }[]
        >(
          "SELECT id,status,result FROM chisabot_tool_operations WHERE binding_id=$1",
          [binding.bindingId],
        )
      )[0]!;
    return {
      threadId,
      runId,
      binding,
      toolCallId,
      input,
      gateway,
      request,
      row,
    };
  }

  const writeTool = (execute: GrantedTool["execute"]): GrantedTool => ({
    name: "isolated_write",
    ref: "fixture/write",
    effect: "write",
    description: "isolated",
    parameters: z.object({}),
    execute,
  });

  test("history read errors return failed receipts and a duplicate does not execute again", async () => {
    let calls = 0;
    const failingRead = new Proxy(database.$client, {
      get(target, property, receiver) {
        if (property === "unsafe")
          return async () => {
            calls++;
            throw new Error("history unavailable");
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const readDatabase = new Proxy(database, {
      get(target, property, receiver) {
        return property === "$client"
          ? failingRead
          : Reflect.get(target, property, receiver);
      },
    });
    const tool = historyRecoverTools({
      database: readDatabase,
      threadId: "own-history",
    })[0]!;
    const fixture = await setup(tool);
    const first = await fixture.request();
    expect(first.status).toBe(200);
    expect((await first.json()).error).toBe("history unavailable");
    expect((await fixture.row()).status).toBe("failed");
    expect((await fixture.request()).status).toBe(200);
    expect(calls).toBe(1);
  });

  test("known policy refusals are failures while uncertain writes pause without replay", async () => {
    const denied = await setup(
      writeTool(async () => {
        throw new ApprovalRefusedError("Not permitted.");
      }),
    );
    expect((await denied.request()).status).toBe(200);
    expect((await denied.row()).status).toBe("failed");
    let effects = 0;
    const unknown = await setup(
      writeTool(async () => {
        effects++;
        throw new Error("receipt lost");
      }),
    );
    expect((await unknown.request()).status).toBe(202);
    expect((await unknown.request()).status).toBe(202);
    expect((await unknown.row()).status).toBe("outcome_unknown");
    expect(effects).toBe(1);
  });

  test("approval continuation retains a declared read failure instead of suspending or executing twice", async () => {
    let executions = 0;
    const tool: GrantedTool = {
      ...writeTool(async () => {
        executions++;
        throw new Error("read unavailable");
      }),
      effect: "read",
    };
    const fixture = await setup(tool);
    const claim = await operations.claim({
      ownerUserId: owner,
      bindingId: fixture.binding.bindingId,
      sessionId: fixture.binding.sessionId,
      runId: fixture.runId,
      callId: "call",
      turn: 0,
      step: 0,
      name: tool.name,
      args: {},
    });
    if (claim.kind !== "claimed") throw new Error("Expected a new operation");
    const requestId = randomUUID();
    await operations.waitingForConfirmation(claim.id, requestId);
    const resume = () =>
      fixture.gateway.resumeConfirmation({
        ownerUserId: owner,
        requestId,
        approved: true,
        snapshot: {
          ...fixture.input,
          toolCallId: fixture.toolCallId,
          toolName: tool.name,
          args: {},
          forwardedProps: {},
        },
        tools: [tool],
        signal: new AbortController().signal,
      });
    expect((await resume()).error).toBe("read unavailable");
    expect((await fixture.row()).status).toBe("failed");
    expect((await resume()).error).toBe("read unavailable");
    expect(executions).toBe(1);
  });

  async function uncertain() {
    const fixture = await setup(
      writeTool(async () => {
        throw new Error("receipt lost");
      }),
    );
    expect((await fixture.request()).status).toBe(202);
    await journal.status(fixture.threadId, fixture.runId, "waiting");
    return { ...fixture, operation: await fixture.row() };
  }

  test("a recorded human result and one follow-up command commit together and survive lost HTTP reply", async () => {
    const fixture = await uncertain();
    const pending = await operations.listUnknown(owner, fixture.threadId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.canContinue).toBe(true);
    const resolution = {
      outcome: "completed" as const,
      note: "The destination contains the expected entry.",
      continue: true,
    };
    const first = await operations.resolveOutcome(
      owner,
      fixture.threadId,
      fixture.operation.id,
      resolution,
    );
    expect(first.record?.status).toBe("accepted");
    expect(first.record?.input.messages.at(-1)?.content).toContain(
      resolution.note,
    );
    expect((await journal.get(fixture.threadId, fixture.runId))?.status).toBe(
      "settled",
    );
    const repeat = await operations.resolveOutcome(
      owner,
      fixture.threadId,
      fixture.operation.id,
      resolution,
    );
    expect(repeat.alreadyAccepted).toBe(true);
    expect(repeat.record?.command_id).toBe(first.record?.command_id);
    expect(
      (await backend.commands.pending()).filter(
        (record) => record.thread_id === fixture.threadId,
      ),
    ).toHaveLength(1);
    const conflict = await operations
      .resolveOutcome(owner, fixture.threadId, fixture.operation.id, {
        ...resolution,
        outcome: "not_executed",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).message).toContain("另一份");
    expect(await operations.listUnknown(owner, fixture.threadId)).toHaveLength(
      0,
    );
  });

  for (const state of ["stopped", "edited", "busy", "newer"] as const) {
    test(`${state} conversations permit recording, never resuming the old execution`, async () => {
      const fixture = await uncertain();
      if (state === "stopped")
        await journal.stop(fixture.threadId, fixture.runId);
      if (state === "edited")
        await bindings.getOrCreate({
          threadId: fixture.threadId,
          ownerUserId: owner,
          botId: bot,
          runtimeId: owner,
          revision: fixture.binding.revision + 1,
        });
      if (state === "busy")
        await database.$client.unsafe(
          "UPDATE chisabot_local_threads SET run_id=$2 WHERE id=$1",
          [fixture.threadId, randomUUID()],
        );
      if (state === "newer")
        await database.$client.unsafe(
          "INSERT INTO chisabot_local_runs(thread_id,run_id,status,created_at) VALUES($1,$2,'finished',now()+interval '1 second')",
          [fixture.threadId, randomUUID()],
        );
      expect(
        (await operations.listUnknown(owner, fixture.threadId))[0]!.canContinue,
      ).toBe(false);
      const resolution = {
        outcome: "failed" as const,
        note: "The destination is unchanged.",
        continue: true,
      };
      const refusal = await operations
        .resolveOutcome(
          owner,
          fixture.threadId,
          fixture.operation.id,
          resolution,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain("原任务已停止");
      expect((await fixture.row()).status).toBe("outcome_unknown");
      const recorded = await operations.resolveOutcome(
        owner,
        fixture.threadId,
        fixture.operation.id,
        { ...resolution, continue: false },
      );
      expect(recorded.record).toBeUndefined();
      expect((await fixture.row()).status).toBe("failed");
    });
  }

  test("owner isolation and route admission keep resolution inaccessible to another account", async () => {
    const fixture = await uncertain();
    class ReplyAgent extends AbstractAgent {
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
    let actor = "outsider";
    const routes = createConversationRoutes({
      backend,
      toolOperations: operations,
      identifyActor: async () => ({ id: actor, role: "user" }),
      resolver: {
        resolveAgentForActor: async () => new ReplyAgent(),
        resolveAgentsForActor: async () => ({}),
      },
    });
    const root = `/api/conversations/${fixture.threadId}/operations`;
    expect((await (await routes.request(root)).json()).operations).toEqual([]);
    const send = (body: unknown) =>
      routes.request(`${root}/${fixture.operation.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const resolution = {
      outcome: "not_executed",
      note: "No write occurred.",
      continue: false,
    };
    expect((await send(resolution)).status).toBe(404);
    actor = owner;
    expect((await send({ ...resolution, note: "" })).status).toBe(400);
    expect((await send(resolution)).status).toBe(200);
    expect((await fixture.row()).status).toBe("failed");
  });

  test("maintenance refuses continuation before settlement; accepted continuation dispatches once", async () => {
    const fixture = await uncertain();
    let executions = 0;
    class ReplyAgent extends AbstractAgent {
      run(input: RunAgentInput) {
        executions++;
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
    const routes = createConversationRoutes({
      backend,
      toolOperations: operations,
      identifyActor: async () => ({ id: owner, role: "user" }),
      resolver: {
        resolveAgentForActor: async () => new ReplyAgent(),
        resolveAgentsForActor: async () => ({}),
      },
    });
    const request = () =>
      routes.request(
        `/api/conversations/${fixture.threadId}/operations/${fixture.operation.id}/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            outcome: "completed",
            note: "Verified destination entry.",
            continue: true,
          }),
        },
      );
    const root = await mkdtemp(join(tmpdir(), "outcome-maintenance-"));
    const previous = process.env.CHISABOT_DSH_ROOT;
    try {
      process.env.CHISABOT_DSH_ROOT = root;
      await writeFile(join(root, ".maintenance"), "draining");
      expect((await request()).status).toBe(503);
      expect((await fixture.row()).status).toBe("outcome_unknown");
      expect(executions).toBe(0);
      await rm(join(root, ".maintenance"));
      const response = await request();
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.continued).toBe(true);
      for (let i = 0; i < 100; i++) {
        if (
          (
            await backend.commands.get(
              owner,
              fixture.threadId,
              result.commandId,
            )
          )?.status === "settled"
        )
          break;
        await Bun.sleep(20);
      }
      expect(
        (await backend.commands.get(owner, fixture.threadId, result.commandId))
          ?.status,
      ).toBe("settled");
      expect((await request()).status).toBe(200);
      expect(executions).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.CHISABOT_DSH_ROOT;
      else process.env.CHISABOT_DSH_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
