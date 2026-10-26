import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { AbstractAgent, type BaseEvent, EventType, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  AGENT_RUNTIME_UNREACHABLE,
  FailFastTransport,
} from "../src/agents/pre-stream-failure";

/** A port that was just free and has nothing listening on it any more. */
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

const input = (): RunAgentInput => ({
  threadId: "thread-cb100",
  runId: "run-cb100",
  messages: [{ id: "m1", role: "user", content: "你好" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

type Outcome = { events: BaseEvent[]; error?: unknown; completed: boolean; ms: number };

function collect(agent: AbstractAgent): Promise<Outcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    const events: BaseEvent[] = [];
    agent.run(input()).subscribe({
      next: (event) => events.push(event),
      error: (error) => resolve({ events, error, completed: false, ms: Date.now() - started }),
      complete: () => resolve({ events, completed: true, ms: Date.now() - started }),
    });
  });
}

describe("CB-100: agent runtime unreachable before streaming", () => {
  test("ConnectionRefused becomes a terminal RUN_ERROR and the stream closes within 2s", async () => {
    const port = await closedPort();
    const agent = new FailFastTransport(new HttpAgent({ url: `http://127.0.0.1:${port}/ag-ui` }));
    const outcome = await collect(agent);
    expect(outcome.error).toBeUndefined();
    expect(outcome.completed).toBe(true);
    expect(outcome.ms).toBeLessThan(2000);
    const last = outcome.events.at(-1) as BaseEvent & { code?: string; message?: string };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.code).toBe(AGENT_RUNTIME_UNREACHABLE);
    expect(last.message).toContain("智能体运行时无法连接");
  });

  test("without the wrapper the same refusal is a bare observable error (the old hang)", async () => {
    const port = await closedPort();
    const outcome = await collect(new HttpAgent({ url: `http://127.0.0.1:${port}/ag-ui` }));
    expect(outcome.error).toBeDefined();
    expect(outcome.events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
  });

  test("an error after streaming started is passed through unchanged", async () => {
    const boom = new Error("ECONNRESET mid-stream");
    class Midway extends AbstractAgent {
      run(i: RunAgentInput) {
        return new Observable<BaseEvent>((s) => {
          s.next({ type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId } as BaseEvent);
          s.error(boom);
        });
      }
    }
    const outcome = await collect(new FailFastTransport(new Midway()));
    expect(outcome.error).toBe(boom);
    expect(outcome.events.map((e) => e.type)).toEqual([EventType.RUN_STARTED]);
  });

  test("a cancelled run is not turned into a runtime error", async () => {
    const abort = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    class Aborted extends AbstractAgent {
      run() { return new Observable<BaseEvent>((s) => s.error(abort)); }
    }
    const outcome = await collect(new FailFastTransport(new Aborted()));
    expect(outcome.error).toBe(abort);
  });

  test("clone keeps the fail-fast behaviour", async () => {
    const port = await closedPort();
    const agent = new FailFastTransport(new HttpAgent({ url: `http://127.0.0.1:${port}/ag-ui` })).clone();
    const outcome = await collect(agent);
    expect(outcome.events.at(-1)?.type).toBe(EventType.RUN_ERROR);
  });
});
