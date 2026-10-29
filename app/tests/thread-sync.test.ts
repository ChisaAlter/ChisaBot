import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import {
  mergeServerMessages,
  messagesChanged,
  syncQuery,
  type ThreadSync,
} from "../src/lib/copilot/thread-sync";

const user = (id: string, content: string): Message => ({
  id,
  role: "user",
  content,
});
const bot = (id: string, content: string): Message => ({
  id,
  role: "assistant",
  content,
});

function synced(current: Message[]): ThreadSync {
  return { version: "v1", cursor: "c1", applied: current.slice() };
}

describe("syncQuery", () => {
  test("asks for the whole transcript until there is an untouched base", () => {
    const current = [user("u1", "hi")];
    expect(syncQuery(current, null)).toBe("since=");
    expect(syncQuery(current, synced(current))).toBe("since=v1&cursor=c1");
    // 本地被别处换成了新对象（流式 / 发送）：不带基准。
    expect(syncQuery([{ ...current[0]! }], synced(current))).toBe("since=");
  });
});

describe("mergeServerMessages", () => {
  test("unchanged answer keeps the same array and does not request an update", () => {
    const current = [user("u1", "hi"), bot("a1", "hello")];
    const result = mergeServerMessages(current, synced(current), {
      unchanged: true,
      version: "v1",
      cursor: "c1",
    });
    expect(result).toEqual({ next: null, version: "v1", cursor: "c1" });
  });

  test("a full answer with equal content does not request an update", () => {
    const current = [user("u1", "hi"), bot("a1", "hello")];
    const result = mergeServerMessages(current, null, {
      version: "v2",
      cursor: "c2",
      start: 0,
      messages: structuredClone(current),
    });
    expect(result).toEqual({ next: null, version: "v2", cursor: "c2" });
  });

  test("a tail is merged after the untouched prefix, keeping prefix references", () => {
    const current = [user("u1", "hi"), bot("a1", "hel")];
    const result = mergeServerMessages(current, synced(current), {
      version: "v2",
      cursor: "c2",
      start: 1,
      messages: [bot("a1", "hello"), user("u2", "next")],
    });
    expect(result?.next?.map((message) => message.content)).toEqual([
      "hi",
      "hello",
      "next",
    ]);
    expect(result?.next?.[0]).toBe(current[0]);
    expect(result?.version).toBe("v2");
  });

  test("edits and deletes in a full answer replace the transcript", () => {
    const current = [user("u1", "hi"), bot("a1", "hello"), user("u2", "x")];
    const edited = mergeServerMessages(current, null, {
      version: "v3",
      cursor: "c3",
      start: 0,
      messages: [user("u1", "hi!"), bot("a1", "hello"), user("u2", "x")],
    });
    expect(edited?.next?.[0]?.content).toBe("hi!");
    const deleted = mergeServerMessages(current, null, {
      version: "v4",
      cursor: "c4",
      start: 0,
      messages: [user("u1", "hi"), bot("a1", "hello")],
    });
    expect(deleted?.next?.map((message) => message.id)).toEqual(["u1", "a1"]);
  });

  test("a delta built on a base that changed meanwhile is rejected", () => {
    const current = [user("u1", "hi"), bot("a1", "hello")];
    const sync = synced(current);
    const local = [...current, user("u2", "typed meanwhile")];
    expect(
      mergeServerMessages(local, sync, {
        unchanged: true,
        version: "v1",
        cursor: "c1",
      }),
    ).toBeNull();
    expect(
      mergeServerMessages(local, sync, {
        version: "v2",
        cursor: "c2",
        start: 1,
        messages: [bot("a1", "x")],
      }),
    ).toBeNull();
    expect(
      mergeServerMessages(current, sync, {
        version: "v2",
        cursor: "c2",
        start: 9,
        messages: [],
      }),
    ).toBeNull();
  });

  test("malformed answers are rejected and legacy answers still work", () => {
    const current = [user("u1", "hi")];
    expect(mergeServerMessages(current, null, null)).toBeNull();
    expect(
      mergeServerMessages(current, null, { messages: [{ id: 1 }] }),
    ).toBeNull();
    const legacy = mergeServerMessages(current, null, {
      messages: [user("u1", "hi"), bot("a1", "yo")],
    });
    expect(legacy).toMatchObject({ version: null, cursor: null });
    expect(legacy?.next?.length).toBe(2);
  });

  test("structured content is compared by value", () => {
    const parts = [{ type: "text", text: "a" }];
    const current = [
      { id: "u1", role: "user", content: parts } as unknown as Message,
    ];
    const same = [
      {
        id: "u1",
        role: "user",
        content: structuredClone(parts),
      } as unknown as Message,
    ];
    expect(messagesChanged(current, same)).toBe(false);
    const other = [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "b" }],
      } as unknown as Message,
    ];
    expect(messagesChanged(current, other)).toBe(true);
  });
});
