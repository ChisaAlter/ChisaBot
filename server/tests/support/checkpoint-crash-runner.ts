// Owned child for conversation-checkpoints.integration.test.ts; its parent kills this API runner.
import { AbstractAgent, type BaseEvent } from "@ag-ui/client";
import { Observable } from "rxjs";
import { createDatabase } from "../../src/db/client";
import { createLocalConversations } from "../../src/local-conversations";

const [owner, bot, threadId, runId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
const real = createDatabase(process.env.TEST_DATABASE_URL!, { max: 2 });
const unsafe = real.$client.unsafe.bind(real.$client);
const client = new Proxy(real.$client, {
  get(target, key) {
    if (key !== "unsafe") return Reflect.get(target, key, target);
    return async (query: string, params?: unknown[]) => {
      const result = await unsafe(query, params as never);
      if (
        query.includes("INSERT INTO chisabot_local_events") &&
        String(params?.[2]).includes('"delta":"crash-tail"')
      ) {
        console.log("DURABLE_TAIL_READY");
        await new Promise(() => {}); // Parent kills after INSERT, before its projection acknowledgement.
      }
      return result;
    };
  },
});
const database = Object.create(real);
Object.defineProperty(database, "$client", { value: client });
const backend = await createLocalConversations(database);
await backend.client.getOrCreateThread({
  threadId,
  userId: owner,
  agentId: bot,
});
class CrashAgent extends AbstractAgent {
  run() {
    return new Observable<BaseEvent>((sink) => {
      void (async () => {
        sink.next({ type: "RUN_STARTED", threadId, runId } as BaseEvent);
        sink.next({
          type: "TEXT_MESSAGE_START",
          messageId: "crash-answer",
          role: "assistant",
        } as BaseEvent);
        sink.next({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "crash-answer",
          delta: "Before ",
        } as BaseEvent);
        for (;;) {
          const [row] = await unsafe(
            "SELECT messages FROM chisabot_local_threads WHERE id=$1",
            [threadId],
          );
          if (
            row.messages.some(
              (message: { content?: string }) => message.content === "Before ",
            )
          )
            break;
          await Bun.sleep(10);
        }
        sink.next({
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "crash-answer",
          delta: "crash-tail",
        } as BaseEvent);
      })().catch((error) => sink.error(error));
    });
  }
}
backend.runner
  .run({
    threadId,
    agent: new CrashAgent({ agentId: bot, threadId }),
    input: {
      threadId,
      runId,
      messages: [{ id: "crash-question", role: "user", content: "Answer" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
  })
  .subscribe({
    error: (error) => {
      console.error(error);
      process.exit(1);
    },
  });
setInterval(() => {}, 1000);
