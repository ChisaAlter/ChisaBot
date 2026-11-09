import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable, of } from "rxjs";
import { createDatabase } from "../src/db/client";
import {
  createLocalConversations,
  type LocalConversationBackend,
} from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 重新生成 / 编辑后重发（DESIGN.md §67，CB-042）：截断接口 + 运行器的墓碑，真库。 */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function collect(stream: Observable<BaseEvent>): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    stream.subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

/** 每一轮回答一条，id 带上轮次（answer-<runId>）。 */
class EchoAgent extends AbstractAgent {
  protected run(input: RunAgentInput) {
    const id = `answer-${input.runId}`;
    return of(
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      { type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: "ok" },
      { type: EventType.TEXT_MESSAGE_END, messageId: id },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ) as Observable<BaseEvent>;
  }
}

class PausedAgent extends AbstractAgent {
  protected run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.TEXT_MESSAGE_START,
        messageId: `p-${input.runId}`,
        role: "assistant",
      } as BaseEvent);
    });
  }
}

suite("thread truncation on a dedicated PostgreSQL database", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: LocalConversationBackend;
  const owner = `trunc-test-${randomUUID()}`;
  const thread = `${owner}-thread`;
  const bot = `${owner}-bot`;
  const input = (runId: string, messages: Message[]) =>
    ({
      threadId: thread,
      runId,
      protocolVersion: "1.0.0",
      messages,
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    }) as RunAgentInput;
  const turn = async (runId: string, messages: Message[]) => {
    const agent = new EchoAgent({ agentId: bot, threadId: thread });
    await collect(
      backend.runner.run({
        threadId: thread,
        agent,
        input: input(runId, messages),
      }),
    );
  };
  const stored = async () =>
    (
      await backend.client.getThreadMessages({
        threadId: thread,
        userId: owner,
      })
    ).messages.map((message) => message.id);
  const truncate = (body: unknown, actor = owner) =>
    backend.handle(
      new Request(
        `http://localhost/api/conversations/threads/${thread}/truncate`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        },
      ),
      actor,
    );

  beforeAll(async () => {
    database = createDatabase(testDatabaseUrl(), TEST_POOL);
    backend = await createLocalConversations(database);
    await backend.client.getOrCreateThread({
      threadId: thread,
      userId: owner,
      agentId: bot,
    });
  });

  afterAll(async () => {
    await database.$client.unsafe(
      "DELETE FROM chisabot_local_threads WHERE owner_user_id = $1",
      [owner],
    );
    await database.$client.close();
  });

  test("truncate removes the turn from messages, events and runs; replay matches", async () => {
    const u1 = { id: "u1", role: "user", content: "one" } as Message;
    const u2 = { id: "u2", role: "user", content: "two" } as Message;
    await turn("r1", [u1]);
    await turn("r2", [
      u1,
      { id: "answer-r1", role: "assistant", content: "ok" } as Message,
      u2,
    ]);
    expect(await stored()).toEqual(["u1", "answer-r1", "u2", "answer-r2"]);

    expect(
      (
        await truncate(
          { fromMessageId: "u2", mode: "regenerate" },
          "someone-else",
        )
      )?.status,
    ).toBe(404);
    expect((await truncate({ fromMessageId: "answer-r1" }))?.status).toBe(400);

    const response = await truncate({
      fromMessageId: "u2",
      mode: "regenerate",
    });
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      removed: string[];
      revision: string;
    };
    expect(body.removed).toEqual(["u2", "answer-r2"]);
    expect(body.revision).toBe("1");
    expect(await stored()).toEqual(["u1", "answer-r1"]);

    const replay = await collect(
      backend.runner.connect({ threadId: thread, agentId: bot }),
    );
    expect(
      replay.filter((event) => event.type === EventType.RUN_STARTED),
    ).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain("answer-r2");
    const runs = await database.$client.unsafe<{ run_id: string }[]>(
      "SELECT run_id FROM chisabot_local_runs WHERE thread_id = $1 ORDER BY run_id",
      [thread],
    );
    expect(runs.map((row) => row.run_id)).toEqual(["r1"]);
  });

  test("a stale device cannot bring truncated messages back", async () => {
    const stale = [
      { id: "u1", role: "user", content: "one" },
      { id: "answer-r1", role: "assistant", content: "ok" },
      { id: "u2", role: "user", content: "two" },
      { id: "answer-r2", role: "assistant", content: "ok" },
      { id: "u3", role: "user", content: "three" },
    ] as Message[];
    await turn("r3", stale);
    expect(await stored()).toEqual(["u1", "answer-r1", "u3", "answer-r3"]);
  });

  test("refused while the thread is answering", async () => {
    const agent = new PausedAgent({ agentId: bot, threadId: thread });
    const runId = randomUUID();
    let started!: () => void;
    const seen = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = backend.runner.run({
      threadId: thread,
      agent,
      input: input(runId, [
        { id: "u4", role: "user", content: "four" } as Message,
      ]),
    });
    stream.subscribe({
      next: (event) => {
        if (event.type === EventType.TEXT_MESSAGE_START) started();
      },
    });
    const done = collect(stream);
    await seen;
    expect((await truncate({ fromMessageId: "u3" }))?.status).toBe(409);
    await backend.runner.stop({ threadId: thread, runId });
    await done;
    const response = await truncate({ fromMessageId: "u3", mode: "edit" });
    expect(response?.status).toBe(200);
    expect(await stored()).toEqual(["u1", "answer-r1"]);
    expect(((await response!.json()) as { revision: string }).revision).toBe(
      "2",
    );
  });
});
