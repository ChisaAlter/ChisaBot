import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  type ApprovalContinuation,
  withApprovalContext,
} from "../src/approvals/types";
import { createConfirmations } from "../src/confirmations/service";
import { createConversationBindings } from "../src/conversations/bindings";
import { createConfirmationResumer } from "../src/conversations/confirmation-resume";
import {
  continuationView,
  dispatchContinuationWork,
} from "../src/conversations/continuation-work";
import { createConversationInteractions } from "../src/conversations/interactions";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createDatabase } from "../src/db/client";
import {
  createLocalConversations,
  type LocalConversationBackend,
} from "../src/local-conversations";
import { createTurnRunner } from "../src/turns/run-turn";
import { createWorkQueue } from "../src/work/queue";
import { testDatabaseUrl } from "./support/database";

const available = Boolean(process.env.TEST_DATABASE_URL);
(available ? describe : describe.skip)(
  "durable continuation dispatch (PostgreSQL)",
  () => {
    const owner = `continuation-${randomUUID()}`;
    const bot = `${owner}-bot`;
    const kind = "conversation.interaction-response" as const;
    const worker = `${owner}-worker`;
    let database: ReturnType<typeof createDatabase>;
    let backend: LocalConversationBackend;
    let queue: ReturnType<typeof createWorkQueue>;
    let interactions: ReturnType<typeof createConversationInteractions>;
    let confirmations: ReturnType<typeof createConfirmations>;
    let journal: ReturnType<typeof createDshRunJournal>;
    let bindings: ReturnType<typeof createConversationBindings>;
    beforeAll(async () => {
      database = createDatabase(testDatabaseUrl(), { max: 4 });
      backend = await createLocalConversations(database);
      queue = createWorkQueue(database);
      interactions = createConversationInteractions(database);
      confirmations = createConfirmations(database);
      journal = createDshRunJournal(database);
      bindings = createConversationBindings(database);
      await interactions.ensure();
      await confirmations.ensure();
      await bindings.ensure();
    }, 30_000);
    afterAll(async () => {
      await database.$client.unsafe(
        "DELETE FROM work_items WHERE key LIKE $1 OR payload->>'ownerUserId'=$2",
        [`${owner}%`, owner],
      );
      for (const table of [
        "chisabot_conversation_interactions",
        "chisabot_confirm_requests",
        "chisabot_dsh_runs",
        "chisabot_runtime_bindings",
      ])
        await database.$client.unsafe(
          `DELETE FROM ${table} WHERE owner_user_id=$1`,
          [owner],
        );
      await database.$client.unsafe(
        "DELETE FROM chisabot_local_threads WHERE owner_user_id=$1",
        [owner],
      );
      await database.$client.close();
    });
    const cards = () =>
      interactions.routes(async (context, next) => {
        context.set("actor", {
          id: context.req.header("x-actor") ?? owner,
          role: "user",
        });
        await next();
      });
    async function prepare(label: string) {
      const threadId = `${owner}-${label}`,
        callId = `${threadId}-call`,
        runId = `${threadId}-source`;
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
      const snapshot: ApprovalContinuation = {
        threadId,
        runId,
        toolCallId: callId,
        toolName: "ask_person",
        args: { question: label },
        state: {},
        context: [],
        forwardedProps: {},
        messages: [
          { id: `${threadId}-user`, role: "user", content: label },
          {
            id: `${threadId}-assistant`,
            role: "assistant",
            toolCalls: [
              {
                id: callId,
                type: "function",
                function: {
                  name: "ask_person",
                  arguments: JSON.stringify({ question: label }),
                },
              },
            ],
          },
        ],
      };
      await database.$client.unsafe(
        "UPDATE chisabot_local_threads SET messages=$2::text::jsonb WHERE id=$1",
        [threadId, JSON.stringify(snapshot.messages)],
      );
      await database.$client.unsafe(
        "INSERT INTO chisabot_local_runs(thread_id,run_id,status) VALUES($1,$2,'finished')",
        [threadId, runId],
      );
      await journal.accept({
        thread_id: threadId,
        run_id: runId,
        owner_user_id: owner,
        bot_id: bot,
        session_id: binding.sessionId,
        binding_revision: binding.revision,
        generation: owner,
        baseline: 0,
        input: { ...snapshot, tools: [] },
        initiator: { kind: "person" },
        request_id: callId,
      });
      await journal.status(threadId, runId, "waiting");
      const suspended = await withApprovalContext(snapshot, () =>
        interactions.ask(owner, new AbortController().signal),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(suspended).toBeInstanceOf(Error);
      const response = await cards().request(`/${callId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "keep my answer" }),
      });
      expect(response.status).toBe(200);
      return {
        threadId,
        callId,
        snapshot,
        binding,
        runId: `interaction:${callId}`,
      };
    }
    async function claim(callId: string) {
      await database.$client.unsafe(
        "UPDATE work_items SET run_at=now() WHERE kind=$1 AND key=$2",
        [kind, callId],
      );
      const found = (
        await queue.claim({ kind, owner: worker, leaseMs: 60_000, limit: 100 })
      ).find((item) => item.key === callId);
      expect(found).toBeDefined();
      return found!;
    }
    async function state(callId: string) {
      return (
        await database.$client.unsafe<
          { attempts: number; finished_at: Date | null }[]
        >(
          "SELECT attempts,finished_at FROM work_items WHERE kind=$1 AND key=$2",
          [kind, callId],
        )
      )[0]!;
    }
    async function until(check: () => boolean | Promise<boolean>) {
      const end = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() > end) throw new Error("Continuation did not settle.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    test("eight busy claims retain the accepted answer; durable admission frees the queue before the model finishes", async () => {
      const first = await prepare("busy");
      await backend.leases.acquire({
        threadId: first.threadId,
        runId: "busy-predecessor",
        userId: owner,
        agentId: bot,
        ttlSeconds: 120,
      });
      let calls = 0;
      let finish!: () => void;
      const completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      class ControlledAgent extends AbstractAgent {
        executionSettled = false;
        run(input: RunAgentInput) {
          return new Observable<BaseEvent>((subscriber) => {
            void (async () => {
              calls++;
              await journal.accept({
                thread_id: input.threadId,
                run_id: input.runId,
                owner_user_id: owner,
                bot_id: bot,
                session_id: first.binding.sessionId,
                binding_revision: first.binding.revision,
                generation: owner,
                baseline: 0,
                input,
                initiator: { kind: "person" },
                request_id: first.callId,
              });
              subscriber.next({
                type: "RUN_STARTED",
                threadId: input.threadId,
                runId: input.runId,
              } as BaseEvent);
              await completion;
              subscriber.next({
                type: "TEXT_MESSAGE_START",
                messageId: `${input.runId}:reply`,
                role: "assistant",
              } as BaseEvent);
              subscriber.next({
                type: "TEXT_MESSAGE_CONTENT",
                messageId: `${input.runId}:reply`,
                delta: "continued once",
              } as BaseEvent);
              subscriber.next({
                type: "TEXT_MESSAGE_END",
                messageId: `${input.runId}:reply`,
              } as BaseEvent);
              this.executionSettled = true;
              subscriber.next({
                type: "RUN_FINISHED",
                threadId: input.threadId,
                runId: input.runId,
              } as BaseEvent);
              subscriber.complete();
            })().catch((error) => subscriber.error(error));
          });
        }
      }
      const run = createTurnRunner({
        intelligence: backend.client,
        runner: backend.runner,
        buildAgentFor: async () => new ControlledAgent({ agentId: bot }),
        turnTimeoutMs: 10_000,
      });
      try {
        for (let i = 0; i < 8; i++) {
          await dispatchContinuationWork(
            database,
            queue,
            await claim(first.callId),
            worker,
            (admitted) => interactions.resume(first.callId, run, admitted),
          );
          expect((await state(first.callId)).attempts).toBe(0);
        }
        expect(calls).toBe(0);
        expect(
          (await (await cards().request(`/${first.callId}`)).json()).answer,
        ).toBe("keep my answer");
        await backend.leases.release({
          threadId: first.threadId,
          runId: "busy-predecessor",
        });
        await dispatchContinuationWork(
          database,
          queue,
          await claim(first.callId),
          worker,
          (admitted) => interactions.resume(first.callId, run, admitted),
        );
        expect(calls).toBe(1);
        expect((await state(first.callId)).finished_at).not.toBeNull();
        expect(backend.control.isActive(first.threadId)).toBe(true);
        expect(
          (
            await continuationView(database, {
              kind,
              key: first.callId,
              threadId: first.threadId,
              runId: first.runId,
            })
          )?.state,
        ).toBe("running");
        const second = await prepare("independent");
        let secondCalls = 0;
        await dispatchContinuationWork(
          database,
          queue,
          await claim(second.callId),
          worker,
          (admitted) =>
            interactions.resume(
              second.callId,
              async () => {
                secondCalls++;
                return { replyText: "second completed" };
              },
              admitted,
            ),
        );
        expect(secondCalls).toBe(1);
        expect(backend.control.isActive(first.threadId)).toBe(true);
        await interactions.resume(first.callId, run, () => {});
        expect(calls).toBe(1);
      } finally {
        finish();
        await until(() => !backend.control.isActive(first.threadId));
      }
      expect(
        (
          await continuationView(database, {
            kind,
            key: first.callId,
            threadId: first.threadId,
            runId: first.runId,
          })
        )?.state,
      ).toBe("completed");
    }, 20_000);

    test("maintenance preserves accepted answers without spending attempts", async () => {
      const prepared = await prepare("maintenance");
      const root = await mkdtemp(join(tmpdir(), "chisabot-continuation-"));
      const previous = process.env.CHISABOT_DSH_ROOT;
      let calls = 0;
      try {
        process.env.CHISABOT_DSH_ROOT = root;
        await writeFile(join(root, ".maintenance"), "test");
        await dispatchContinuationWork(
          database,
          queue,
          await claim(prepared.callId),
          worker,
          (admitted) =>
            interactions.resume(
              prepared.callId,
              async () => {
                calls++;
                return { replyText: "no" };
              },
              admitted,
            ),
        );
        expect((await state(prepared.callId)).attempts).toBe(0);
        expect(calls).toBe(0);
        expect(
          (await (await cards().request(`/${prepared.callId}`)).json()).status,
        ).toBe("answered");
      } finally {
        if (previous === undefined) delete process.env.CHISABOT_DSH_ROOT;
        else process.env.CHISABOT_DSH_ROOT = previous;
        await rm(root, { recursive: true, force: true });
      }
      await dispatchContinuationWork(
        database,
        queue,
        await claim(prepared.callId),
        worker,
        (admitted) =>
          interactions.resume(
            prepared.callId,
            async () => {
              calls++;
              return { replyText: "yes" };
            },
            admitted,
          ),
      );
      expect(calls).toBe(1);
    });

    test("real exhaustion is visible and owner retry preserves the answer, while admitted effects cannot be replayed", async () => {
      const prepared = await prepare("failure");
      for (let i = 0; i < 5; i++)
        await dispatchContinuationWork(
          database,
          queue,
          await claim(prepared.callId),
          worker,
          (admitted) =>
            interactions.resume(
              prepared.callId,
              async () => {
                throw new Error("Provider is unavailable");
              },
              admitted,
            ),
        );
      const body = await (await cards().request(`/${prepared.callId}`)).json();
      expect(body.continuation).toEqual({
        state: "failed",
        error: "Provider is unavailable",
        retryable: true,
      });
      expect(
        (
          await queue.claim({
            kind,
            owner: worker,
            leaseMs: 60_000,
            limit: 100,
          })
        ).some((item) => item.key === prepared.callId),
      ).toBe(false);
      expect(
        (
          await cards().request(`/${prepared.callId}/retry`, {
            method: "POST",
            headers: { "x-actor": "another-owner" },
          })
        ).status,
      ).toBe(404);
      expect(
        (await cards().request(`/${prepared.callId}/retry`, { method: "POST" }))
          .status,
      ).toBe(200);
      expect((await state(prepared.callId)).attempts).toBe(0);
      expect(
        (await (await cards().request(`/${prepared.callId}`)).json()).answer,
      ).toBe("keep my answer");
      await database.$client.unsafe(
        "INSERT INTO chisabot_local_runs(thread_id,run_id,status) VALUES($1,$2,'error')",
        [prepared.threadId, prepared.runId],
      );
      await database.$client.unsafe(
        "UPDATE work_items SET attempts=5 WHERE kind=$1 AND key=$2",
        [kind, prepared.callId],
      );
      expect(
        (await cards().request(`/${prepared.callId}/retry`, { method: "POST" }))
          .status,
      ).toBe(409);
      expect(
        (await (await cards().request(`/${prepared.callId}`)).json())
          .continuation.retryable,
      ).toBe(false);
    });

    test("a stopped source records why its accepted continuation did not run", async () => {
      const prepared = await prepare("stopped");
      await journal.stop(prepared.threadId, prepared.snapshot.runId);
      let calls = 0;
      await dispatchContinuationWork(
        database,
        queue,
        await claim(prepared.callId),
        worker,
        (admitted) =>
          interactions.resume(
            prepared.callId,
            async () => {
              calls++;
              return { replyText: "unexpected" };
            },
            admitted,
          ),
      );
      expect(calls).toBe(0);
      const body = await (await cards().request(`/${prepared.callId}`)).json();
      expect(body.continuation.state).toBe("failed");
      expect(body.continuation.retryable).toBe(false);
      expect(body.continuation.error).toContain("停止");
      expect((await state(prepared.callId)).finished_at).not.toBeNull();
    });

    test("approved confirmations also defer eight occupied claims without spending failure attempts", async () => {
      const prepared = await prepare("confirmation-busy");
      const confirmation = await confirmations.insertRequest({
        ownerUserId: owner,
        agentId: bot,
        threadId: prepared.threadId,
        toolCallId: prepared.callId,
        category: "message",
        tool: "send",
        title: "approve once",
      });
      await database.$client.unsafe(
        "UPDATE chisabot_confirm_requests SET continuation=$2::text::jsonb WHERE id=$1",
        [confirmation.id, JSON.stringify(prepared.snapshot)],
      );
      await confirmations.decide(owner, confirmation.id, "approve");
      await backend.leases.acquire({
        threadId: prepared.threadId,
        runId: "busy-confirmation",
        userId: owner,
        agentId: bot,
        ttlSeconds: 120,
      });
      let builds = 0;
      const resume = createConfirmationResumer({
        database,
        backend,
        confirmations,
        buildAgentFor: async () => {
          builds++;
          throw new Error("Provider is unavailable");
        },
        runTurn: async () => {
          throw new Error("must not dispatch without the agent");
        },
      });
      const confirmationKind = "conversation.confirmation-response" as const;
      for (let i = 0; i < 8; i++) {
        await database.$client.unsafe(
          "UPDATE work_items SET run_at=now() WHERE kind=$1 AND key=$2",
          [confirmationKind, confirmation.id],
        );
        const [item] = await queue.claim({
          kind: confirmationKind,
          owner: worker,
          leaseMs: 60_000,
        });
        expect(item.key).toBe(confirmation.id);
        await dispatchContinuationWork(
          database,
          queue,
          item,
          worker,
          (admitted) => resume(owner, confirmation.id, admitted),
        );
        const [row] = await database.$client.unsafe<{ attempts: number }[]>(
          "SELECT attempts FROM work_items WHERE kind=$1 AND key=$2",
          [confirmationKind, confirmation.id],
        );
        expect(row.attempts).toBe(0);
      }
      expect(builds).toBe(0);
      expect(
        (await confirmations.list(owner, { threadId: prepared.threadId })).find(
          (row) => row.id === confirmation.id,
        )?.continuation?.state,
      ).toBe("queued");
      await backend.leases.release({
        threadId: prepared.threadId,
        runId: "busy-confirmation",
      });
      await database.$client.unsafe(
        "UPDATE work_items SET run_at=now() WHERE kind=$1 AND key=$2",
        [confirmationKind, confirmation.id],
      );
      const [item] = await queue.claim({
        kind: confirmationKind,
        owner: worker,
        leaseMs: 60_000,
      });
      await dispatchContinuationWork(
        database,
        queue,
        item,
        worker,
        (admitted) => resume(owner, confirmation.id, admitted),
      );
      expect(builds).toBe(1);
      const [row] = await database.$client.unsafe<{ attempts: number }[]>(
        "SELECT attempts FROM work_items WHERE kind=$1 AND key=$2",
        [confirmationKind, confirmation.id],
      );
      expect(row.attempts).toBe(1);
      // Remove only this pending fixture so the pagination assertion has its own six records.
      await database.$client.unsafe(
        "DELETE FROM work_items WHERE kind=$1 AND key=$2",
        [confirmationKind, confirmation.id],
      );
    });

    test("actionable confirmation pages retain old pending and failed records beyond the recent window", async () => {
      const prepared = await prepare("pages");
      const confirmation = await confirmations.insertRequest({
        ownerUserId: owner,
        agentId: bot,
        threadId: prepared.threadId,
        toolCallId: prepared.callId,
        category: "message",
        tool: "send",
        title: "old failed continuation",
      });
      await database.$client.unsafe(
        "UPDATE chisabot_confirm_requests SET status='approved',continuation=$2::text::jsonb,created_at=now()-interval '3 days' WHERE id=$1",
        [confirmation.id, JSON.stringify(prepared.snapshot)],
      );
      await queue.offer({
        kind: "conversation.confirmation-response",
        key: confirmation.id,
        payload: { ownerUserId: owner, requestId: confirmation.id },
      });
      await database.$client.unsafe(
        "UPDATE work_items SET attempts=5,last_error='Connection unavailable' WHERE kind='conversation.confirmation-response' AND key=$1",
        [confirmation.id],
      );
      const pending: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await confirmations.insertRequest({
          ownerUserId: owner,
          agentId: bot,
          threadId: prepared.threadId,
          toolCallId: null,
          category: "message",
          tool: "send",
          title: `old pending ${i}`,
        });
        pending.push(row.id);
        await database.$client.unsafe(
          "UPDATE chisabot_confirm_requests SET created_at=now()-interval '2 days' WHERE id=$1",
          [row.id],
        );
      }
      for (let i = 0; i < 25; i++) {
        const row = await confirmations.insertRequest({
          ownerUserId: owner,
          agentId: bot,
          threadId: prepared.threadId,
          toolCallId: null,
          category: "message",
          tool: "send",
          title: `completed ${i}`,
        });
        await database.$client.unsafe(
          "UPDATE chisabot_confirm_requests SET status='approved' WHERE id=$1",
          [row.id],
        );
      }
      const routes = confirmations.routes(async (context, next) => {
        context.set("actor", { id: owner, role: "user" });
        await next();
      });
      const terminalIds: string[] = [];
      for (const status of ["stopped", "error", "interrupted"]) {
        const terminal = await confirmations.insertRequest({
          ownerUserId: owner,
          agentId: bot,
          threadId: prepared.threadId,
          toolCallId: null,
          category: "message",
          tool: "send",
          title: `old ${status} execution`,
        });
        terminalIds.push(terminal.id);
        await database.$client.unsafe(
          "UPDATE chisabot_confirm_requests SET status='approved',continuation=$2::text::jsonb,created_at=now()-interval '4 days' WHERE id=$1",
          [terminal.id, JSON.stringify(prepared.snapshot)],
        );
        await queue.offer({
          kind: "conversation.confirmation-response",
          key: terminal.id,
          payload: { ownerUserId: owner, requestId: terminal.id },
        });
        await database.$client.unsafe(
          "INSERT INTO chisabot_local_runs(thread_id,run_id,status) VALUES($1,$2,$3)",
          [prepared.threadId, `confirmation:${terminal.id}`, status],
        );
      }
      expect(
        (await confirmations.list(owner, { limit: 20 })).some(
          (row) => row.id === confirmation.id,
        ),
      ).toBe(false);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await (
          await routes.request(
            `/requests?view=actionable&limit=2&thread=${prepared.threadId}${cursor ? `&cursor=${cursor}` : ""}`,
          )
        ).json();
        expect(page.requests.length).toBeLessThanOrEqual(2);
        ids.push(...page.requests.map((row: { id: string }) => row.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(ids).size).toBe(6);
      expect(ids).toContain(confirmation.id);
      for (const id of pending) expect(ids).toContain(id);
      for (const id of terminalIds) expect(ids).not.toContain(id);
      const historyIds: string[] = [];
      cursor = null;
      do {
        const page = await (
          await routes.request(
            `/requests?limit=7&thread=${prepared.threadId}${cursor ? `&cursor=${cursor}` : ""}`,
          )
        ).json();
        expect(page.requests.length).toBeLessThanOrEqual(7);
        historyIds.push(...page.requests.map((row: { id: string }) => row.id));
        for (const row of page.requests)
          if (terminalIds.includes(row.id))
            expect(row.continuation).toMatchObject({
              state: "failed",
              retryable: false,
            });
        cursor = page.nextCursor;
      } while (cursor);
      for (const id of terminalIds) expect(historyIds).toContain(id);
      expect(
        (
          await routes.request(`/requests/${confirmation.id}/retry`, {
            method: "POST",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await confirmations.list(owner, {
            threadId: prepared.threadId,
            limit: 200,
          })
        ).find((row) => row.id === confirmation.id)?.continuation?.state,
      ).toBe("queued");
    }, 20_000);
  },
);
