import { expect, test } from "bun:test";
import { AbstractAgent, type BaseEvent, EventType } from "@ag-ui/client";
import { EMPTY, Observable } from "rxjs";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import type { RuntimeModelConnection } from "../src/conversation-runtime";
import {
  resolveScopedModelConnection,
  withModelConnectionScope,
} from "../src/model-connection-context";
import { createTurnRunner } from "../src/turns/run-turn";

function connection(revision: number): RuntimeModelConnection {
  return {
    model: {
      provider: "openai",
      defaultModel: `model-${revision}`,
      baseUrl: `http://model-${revision}.test/v1`,
    },
    apiKey: `key-${revision}`,
  };
}

test("the policy check and delayed runtime build share one connection despite a settings change", async () => {
  let active = connection(1);
  let reads = 0;
  const resolve = async () => {
    reads++;
    return active;
  };
  await withModelConnectionScope(async () => {
    const checked = await resolveScopedModelConnection(resolve);
    active = connection(2);
    await Bun.sleep(1);
    const [built, skills] = await Promise.all([
      resolveScopedModelConnection(resolve),
      resolveScopedModelConnection(resolve),
    ]);
    expect(built).toBe(checked);
    expect(skills).toBe(checked);
    expect(built.model.defaultModel).toBe("model-1");
    expect(built.apiKey).toBe("key-1");
  });
  expect(reads).toBe(1);
  expect(
    (
      await withModelConnectionScope(() =>
        resolveScopedModelConnection(resolve),
      )
    ).model.defaultModel,
  ).toBe("model-2");
  expect(reads).toBe(2);
});

test("parallel turns and nested handoffs isolate connection snapshots", async () => {
  let reads = 0;
  const resolve = async () => connection(++reads);
  const [first, second] = await Promise.all(
    [1, 2].map(() =>
      withModelConnectionScope(async () => {
        const parent = await resolveScopedModelConnection(resolve);
        await Bun.sleep(1);
        const child = await withModelConnectionScope(() =>
          resolveScopedModelConnection(resolve),
        );
        expect(child).not.toBe(parent);
        expect(await resolveScopedModelConnection(resolve)).toBe(parent);
        return parent;
      }),
    ),
  );
  expect(first).not.toBe(second);
  expect(reads).toBe(4);
});

test("failed resolution is cached for the turn and a new turn retries", async () => {
  let reads = 0;
  const failure = new Error("synthetic configuration unavailable");
  const resolve = async () => {
    reads++;
    if (reads === 1) throw failure;
    return connection(reads);
  };
  await withModelConnectionScope(async () => {
    expect(
      await resolveScopedModelConnection(resolve).catch((error) => error),
    ).toBe(failure);
    expect(
      await resolveScopedModelConnection(resolve).catch((error) => error),
    ).toBe(failure);
  });
  expect(reads).toBe(1);
  expect(
    (
      await withModelConnectionScope(() =>
        resolveScopedModelConnection(resolve),
      )
    ).model.defaultModel,
  ).toBe("model-2");
});

test("calls outside a run scope remain fresh and an unused scope performs no model read", async () => {
  let reads = 0;
  const resolve = async () => connection(++reads);
  expect(await withModelConnectionScope(() => "remote turn")).toBe(
    "remote turn",
  );
  expect(reads).toBe(0);
  await resolveScopedModelConnection(resolve);
  await resolveScopedModelConnection(resolve);
  expect(reads).toBe(2);
});

class FixtureAgent extends AbstractAgent {
  run() {
    return EMPTY;
  }
}

test("routine turns retain their built connection through asynchronous execution and refresh on the next turn", async () => {
  let active = connection(1);
  const seen: string[] = [];
  let reads = 0;
  const resolve = async () => {
    reads++;
    return active;
  };
  const run = createTurnRunner({
    conversations: {
      getOrCreateThread: async () => ({}),
      getThreadMessages: async () => ({ messages: [] }),
      acquireThreadLease: async () => ({}),
      renewThreadLease: async () => ({}),
      releaseThreadLease: async () => {},
    },
    leases: {
      acquire: async () => ({}),
      renew: async () => ({}),
      release: async () => {},
    },
    buildAgentFor: async () => {
      seen.push(
        (await resolveScopedModelConnection(resolve)).model.defaultModel,
      );
      active = connection(reads + 1);
      return new FixtureAgent({ agentId: "fixture" });
    },
    runner: {
      run: ({ agent }) =>
        new Observable<BaseEvent>((subscriber) => {
          void (async () => {
            await Bun.sleep(1);
            seen.push(
              (await resolveScopedModelConnection(resolve)).model.defaultModel,
            );
            agent.addMessage({
              id: "reply",
              role: "assistant",
              content: "done",
            });
            subscriber.complete();
          })().catch((error) => subscriber.error(error));
        }),
      stop: async () => true,
    },
  });
  const input = {
    ownerUserId: "owner",
    routineId: "routine",
    agentId: "fixture",
    threadId: "thread",
    instruction: "Reply.",
  };
  await run(input);
  await run(input);
  expect(seen).toEqual(["model-1", "model-1", "model-2", "model-2"]);
  expect(reads).toBe(2);
});

test("handoff delivery shares the connection built before its later history, guard and stream stages", async () => {
  let active = connection(1);
  const seen: string[] = [];
  let reads = 0;
  const resolve = async () => {
    reads++;
    return active;
  };
  const delivery = createHandoffDelivery({
    agentFor: async () => {
      seen.push(
        (await resolveScopedModelConnection(resolve)).model.defaultModel,
      );
      active = connection(reads + 1);
      return new FixtureAgent({ agentId: "fixture" });
    },
    history: async () => {
      seen.push(
        (await resolveScopedModelConnection(resolve)).model.defaultModel,
      );
      return [];
    },
    mintThreadId: () => "thread",
    newRunId: () => "run",
    lock: {
      acquire: async () => ({ runId: "run" }),
      renew: async () => {},
      release: async () => {},
    },
    runner: {
      run: () =>
        new Observable<BaseEvent>((subscriber) => {
          void (async () => {
            await Bun.sleep(1);
            seen.push(
              (await resolveScopedModelConnection(resolve)).model.defaultModel,
            );
            subscriber.next({
              type: EventType.RUN_FINISHED,
              threadId: "thread",
              runId: "run",
            });
            subscriber.complete();
          })().catch((error) => subscriber.error(error));
        }),
    },
  });
  const input = {
    work: {
      fromBotId: "source",
      toBotId: "fixture",
      actorId: "owner",
      threadId: "thread",
      runId: "run",
      depth: 1,
      task: "Reply.",
    },
    message: "Reply.",
    assertion: "assertion",
  };
  await delivery.deliver(input);
  await delivery.deliver(input);
  expect(seen).toEqual([
    "model-1",
    "model-1",
    "model-1",
    "model-2",
    "model-2",
    "model-2",
  ]);
  expect(reads).toBe(2);
});
