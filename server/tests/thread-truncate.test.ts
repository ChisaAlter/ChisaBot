import { describe, expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import {
  dropTombstoned,
  planTruncation,
  tombstones,
} from "../src/thread-truncate";

test("a tombstone read failure cannot permit stale history to be merged", async () => {
  const failure = new Error("database connection lost");
  const database = {
    $client: {
      unsafe: async () => {
        throw failure;
      },
    },
  } as unknown as Database;
  await expect(tombstones(database, "thread")).rejects.toBe(failure);
});

/** 重新生成 / 编辑后重发（DESIGN.md §67，CB-042）：从哪里截。 */
describe("planTruncation", () => {
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
    {
      id: "a2",
      role: "assistant",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "x", arguments: "{}" },
        },
      ],
    },
    { id: "t2", role: "tool" },
    { id: "a3", role: "assistant" },
  ] as never[];
  const starts = [
    { sequence: "10", runId: "r1", ids: ["u1"] },
    { sequence: "20", runId: "r2", ids: ["u2"] },
    { sequence: "30", runId: "r2b", ids: ["t2"] },
  ];

  test("cuts at the run that started with this user message and everything after", () => {
    const plan = planTruncation(messages, starts, "u2");
    expect(plan).toEqual({
      ok: true,
      index: 2,
      cutSequence: "20",
      removed: ["u2", "a2", "t2", "a3"],
      removedToolCalls: ["call-1"],
    });
  });

  test("an earlier user message removes later turns too", () => {
    const plan = planTruncation(messages, starts, "u1");
    expect(plan.ok && plan.cutSequence).toBe("10");
    expect(plan.ok && plan.removed.length).toBe(6);
  });

  test("refuses assistant messages, unknown ids and mid-run injections", () => {
    expect(planTruncation(messages, starts, "a1")).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(planTruncation(messages, starts, "nope")).toMatchObject({
      ok: false,
      status: 404,
    });
    const injected = [...messages, { id: "u3", role: "user" }] as never[];
    expect(planTruncation(injected, starts, "u3")).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test("a thread without events cuts only messages", () => {
    expect(planTruncation(messages, [], "u2")).toMatchObject({
      ok: true,
      index: 2,
      cutSequence: null,
    });
  });
});

describe("dropTombstoned", () => {
  test("filters truncated ids and keeps the same array when nothing matches", () => {
    const list = [{ id: "a" }, { id: "b" }];
    expect(dropTombstoned(list, new Set())).toBe(list);
    expect(dropTombstoned(list, new Set(["x"]))).toBe(list);
    expect(dropTombstoned(list, new Set(["a"]))).toEqual([{ id: "b" }]);
  });
});
