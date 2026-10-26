import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { AbstractAgent, type BaseEvent, EventType, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import {
  AGENT_RUNTIME_UNREACHABLE,
  DEFAULT_AGENT_CONNECT_TIMEOUT_MS,
  FailFastTransport,
  agentConnectTimeoutMs,
} from "../src/agents/pre-stream-failure";

// CB-100b: a server that accepts the TCP connection and never answers.
const sockets: Socket[] = [];
const blackhole = createServer((socket) => {
  sockets.push(socket);
  socket.on("error", () => {});
});
const port: number = await new Promise((resolve) => {
  blackhole.listen(0, "127.0.0.1", () => {
    const address = blackhole.address();
    resolve(typeof address === "object" && address ? address.port : 0);
  });
});
afterAll(() => {
  for (const socket of sockets) socket.destroy();
  blackhole.close();
});

const input = (): RunAgentInput => ({
  threadId: "thread-cb100b",
  runId: "run-cb100b",
  messages: [{ id: "m1", role: "user", content: "你好" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

function collect(agent: AbstractAgent) {
  const started = Date.now();
  return new Promise<{ events: BaseEvent[]; error?: unknown; completed: boolean; ms: number }>((resolve) => {
    const events: BaseEvent[] = [];
    agent.run(input()).subscribe({
      next: (event) => events.push(event),
      error: (error) => resolve({ events, error, completed: false, ms: Date.now() - started }),
      complete: () => resolve({ events, completed: true, ms: Date.now() - started }),
    });
  });
}

describe("CB-100b: FailFastTransport connect timeout", () => {
  test("accepting-but-silent server ends with RUN_ERROR after the timeout", async () => {
    const agent = new FailFastTransport(new HttpAgent({ url: `http://127.0.0.1:${port}/ag-ui` }), 300);
    const outcome = await collect(agent);
    expect(outcome.error).toBeUndefined();
    expect(outcome.completed).toBe(true);
    expect(outcome.ms).toBeGreaterThanOrEqual(250);
    expect(outcome.ms).toBeLessThan(3000);
    const last = outcome.events.at(-1) as BaseEvent & { code?: string; message?: string };
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.code).toBe(AGENT_RUNTIME_UNREACHABLE);
    expect(last.message).toContain("智能体运行时无法连接");
    expect(last.message).toContain("ETIMEDOUT");
  });

  test("timeout stops counting once the first event arrives", async () => {
    class Slow extends AbstractAgent {
      run(): Observable<BaseEvent> {
        return new Observable<BaseEvent>((s) => {
          s.next({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" } as BaseEvent);
          const t = setTimeout(() => {
            s.next({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r" } as BaseEvent);
            s.complete();
          }, 400);
          return () => clearTimeout(t);
        });
      }
    }
    const outcome = await collect(new FailFastTransport(new Slow(), 100));
    expect(outcome.events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  test("env parsing: default, custom, disabled, garbage", () => {
    expect(agentConnectTimeoutMs({})).toBe(DEFAULT_AGENT_CONNECT_TIMEOUT_MS);
    expect(agentConnectTimeoutMs({ CHISABOT_AGENT_CONNECT_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(agentConnectTimeoutMs({ CHISABOT_AGENT_CONNECT_TIMEOUT_MS: "0" })).toBe(0);
    expect(agentConnectTimeoutMs({ CHISABOT_AGENT_CONNECT_TIMEOUT_MS: "abc" })).toBe(DEFAULT_AGENT_CONNECT_TIMEOUT_MS);
  });

  test("clone keeps the timeout", () => {
    const agent = new FailFastTransport(new HttpAgent({ url: "http://127.0.0.1:1" }), 1234);
    expect(agent.clone().connectTimeoutMs).toBe(1234);
  });
});
