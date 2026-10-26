/**
 * CB-100b：智能体运行时（Hermes）连不上（ConnectionRefused）时，在真实 PostgreSQL 上验证：
 * 这一轮在库里记为失败（openbot_local_runs.status = 'error'），对话锁被释放，下一条消息能正常开跑。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { AbstractAgent, type BaseEvent, EventType, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { type Observable, of } from "rxjs";
import { AGENT_RUNTIME_UNREACHABLE, FailFastTransport } from "../src/agents/pre-stream-failure";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalConversationBackend } from "../src/local-conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const it = process.env.TEST_DATABASE_URL ? test : test.skip;

async function closedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function collect(stream: Observable<BaseEvent>): Promise<{ events: BaseEvent[]; error?: unknown }> {
  return new Promise((resolve) => {
    const events: BaseEvent[] = [];
    stream.subscribe({
      next: (event) => events.push(event),
      error: (error) => resolve({ events, error }),
      complete: () => resolve({ events }),
    });
  });
}

class AnswerAgent extends AbstractAgent {
  protected run(input: RunAgentInput) {
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
      { type: EventType.TEXT_MESSAGE_START, messageId: "answer-2", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer-2", delta: "恢复了" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "answer-2" },
      { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
    ) as Observable<BaseEvent>;
  }
}

let database: ReturnType<typeof createDatabase>;
let backend: LocalConversationBackend;
const owner = `cb100b-${randomUUID()}`;
const thread = `${owner}-thread`;
const bot = `${owner}-bot`;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  database = createDatabase(testDatabaseUrl(), TEST_POOL);
  backend = await createLocalConversations(database);
  await backend.client.getOrCreateThread({ threadId: thread, userId: owner, agentId: bot });
});

afterAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  await database.$client.unsafe("DELETE FROM openbot_local_threads WHERE owner_user_id = $1", [owner]);
  await database.$client.close();
});

const inputFor = (runId: string, id: string, content: string, history: RunAgentInput["messages"] = []) =>
  ({
    threadId: thread,
    runId,
    messages: [...history, { id, role: "user", content }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: {},
  }) as RunAgentInput;

it("ConnectionRefused: turn is failed in the DB, lock released, next message runs", async () => {
  const port = await closedPort();
  const firstRun = randomUUID();
  const first = inputFor(firstRun, "q1", "你好");
  const unreachable = new FailFastTransport(
    new HttpAgent({ agentId: bot, threadId: thread, url: `http://127.0.0.1:${port}/ag-ui`, initialMessages: first.messages }),
  );
  const started = Date.now();
  const outcome = await collect(backend.runner.run({ threadId: thread, agent: unreachable, input: first }));
  expect(Date.now() - started).toBeLessThan(5000);
  const runError = outcome.events.find((event) => event.type === EventType.RUN_ERROR) as
    | (BaseEvent & { code?: string; message?: string })
    | undefined;
  expect(runError?.code).toBe(AGENT_RUNTIME_UNREACHABLE);
  expect(runError?.message).toContain("智能体运行时无法连接");

  const [run] = await database.$client.unsafe<{ status: string; finished_at: Date | null }[]>(
    "SELECT status, finished_at FROM openbot_local_runs WHERE thread_id = $1 AND run_id = $2",
    [thread, firstRun],
  );
  expect(run?.status).toBe("error");
  expect(run?.finished_at).not.toBeNull();
  const [row] = await database.$client.unsafe<{ run_id: string | null }[]>(
    "SELECT run_id FROM openbot_local_threads WHERE id = $1",
    [thread],
  );
  expect(row?.run_id).toBeNull();
  expect(await backend.runner.isRunning({ threadId: thread })).toBe(false);

  // 下一条消息：能拿到锁、正常跑完。
  const secondRun = randomUUID();
  const second = inputFor(secondRun, "q2", "再试一次", first.messages);
  const next = await collect(
    backend.runner.run({
      threadId: thread,
      agent: new AnswerAgent({ agentId: bot, threadId: thread, initialMessages: second.messages }),
      input: second,
    }),
  );
  expect(next.error).toBeUndefined();
  expect(next.events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(true);
  const [secondRow] = await database.$client.unsafe<{ status: string }[]>(
    "SELECT status FROM openbot_local_runs WHERE thread_id = $1 AND run_id = $2",
    [thread, secondRun],
  );
  expect(secondRow?.status).toBe("finished");
});
