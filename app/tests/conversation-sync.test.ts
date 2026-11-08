import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readServerThread, writeServerThread } from "../src/lib/copilot/bot-thread";
import { queuedFor, restoreQueue, takeQueued } from "../src/lib/copilot/thread-inbox";
import { mergeSnapshot, userOrderDiffers } from "../src/lib/copilot/use-conversation-sync";

/**
 * 全端同步（DESIGN.md §42）客户端的两件不需要浏览器的事：旧服务器（没有 /api/bot-threads）要被认出来、
 * 退回老办法；别的设备排的消息只显示、回答结束时不由这台补发。
 */
const realFetch = globalThis.fetch;
let replies: ((url: string, init?: RequestInit) => Response)[] = [];

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const next = replies.shift();
    if (!next) throw new Error("no reply queued");
    return next(String(input), init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  replies = [];
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("server thread pointer client", () => {
  test("an old server that answers with the app's HTML is unsupported, not an error", async () => {
    replies.push(() => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await readServerThread("bot-a")).toBe("unsupported");
  });

  test("a 404 is unsupported", async () => {
    replies.push(() => json({ error: "Not found" }, 404));
    expect(await readServerThread("bot-a")).toBe("unsupported");
  });

  test("a network failure is an error (keep the local thread and retry later)", async () => {
    replies.push(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await readServerThread("bot-a")).toBe("error");
  });

  test("reads the current thread", async () => {
    replies.push(() => json({ threadId: "t1", updatedAt: "2026-10-13T11:00:00.000Z" }));
    expect(await readServerThread("bot-a")).toEqual({ threadId: "t1", updatedAt: "2026-10-13T11:00:00.000Z" });
  });

  test("a migration that lost the race returns the thread the server kept", async () => {
    let sent: unknown;
    replies.push((_url, init) => {
      sent = JSON.parse(String(init?.body));
      return json({ threadId: "t-first", updatedAt: null });
    });
    expect(await writeServerThread("bot-a", "t-mine", true)).toBe("t-first");
    expect(sent).toEqual({ threadId: "t-mine", onlyIfNone: true });
  });
});

describe("queued messages from another device", () => {
  test("are shown but never re-sent by this device when the turn ends", async () => {
    replies.push(() =>
      json({
        running: true,
        items: [{ id: "m-remote", status: "queued", kind: "message", message: { content: "另一台设备排的" } }],
      }),
    );
    await restoreQueue("thread-r");
    expect(queuedFor("thread-r").map((item) => [item.id, item.remote])).toEqual([["m-remote", true]]);
    expect(takeQueued("thread-r")).toEqual([]);
    expect(queuedFor("thread-r")).toHaveLength(1);
  });

  test("disappear here once the server no longer has them queued", async () => {
    replies.push(() => json({ running: true, items: [{ id: "m2", status: "queued", kind: "message", message: { content: "x" } }] }));
    await restoreQueue("thread-p");
    replies.push(() => json({ running: true, items: [{ id: "m2", status: "read", kind: "message", message: { content: "x" } }] }));
    await restoreQueue("thread-p");
    expect(queuedFor("thread-p")).toHaveLength(0);
  });
});

describe("mergeSnapshot (merge-mode reconnect)", () => {
  const m = (id: string) => ({ id });
  const ids = (list: { id: string }[]) => list.map((x) => x.id).join(",");
  test("an older, shorter snapshot never deletes newer local messages", () => {
    expect(ids(mergeSnapshot([m("u1"), m("a1"), m("u2"), m("a2")], [m("u1"), m("a1")]))).toBe("u1,a1,u2,a2");
  });
  test("a message only the server has is inserted where the server put it", () => {
    expect(ids(mergeSnapshot([m("u1"), m("a1"), m("a2")], [m("u1"), m("a1"), m("q1"), m("a2")]))).toBe("u1,a1,q1,a2");
  });
  test("new trailing messages are appended", () => {
    expect(ids(mergeSnapshot([m("u1")], [m("u1"), m("a1")]))).toBe("u1,a1");
  });
  test("nothing new returns the same array", () => {
    const local = [m("u1"), m("a1")];
    expect(mergeSnapshot(local, [m("a1")])).toBe(local);
  });
  test("a durable cursor snapshot replaces an interrupted prefix and retains unsent input", () => {
    const local = [{ id: "a1", content: "Before" }, { id: "unsent", content: "My draft" }];
    const recovered = [{ id: "a1", content: "Before restart. After restart." }];
    const merged = mergeSnapshot(local, recovered, true);
    expect(merged).toEqual([recovered[0]!, local[1]!]);
    expect(mergeSnapshot(merged, recovered, true)).toBe(merged);
  });
});

describe("userOrderDiffers (reconcile after a local turn, DESIGN.md §42.7)", () => {
  test("a send the server never stored (failed turn) is not an order mismatch", () => {
    expect(userOrderDiffers(["u1", "u2", "failed"], ["u1", "u2"])).toBe(false);
    expect(userOrderDiffers(["u1", "failed", "u3"], ["u1", "u3"])).toBe(false);
  });
  test("a message only the server has is not an order mismatch (merge join adds it)", () => {
    expect(userOrderDiffers(["u1"], ["u1", "other-device"])).toBe(false);
  });
  test("two devices sending at once: different order is a mismatch", () => {
    expect(userOrderDiffers(["u1", "mine", "theirs"], ["u1", "theirs", "mine"])).toBe(true);
  });
  test("identical lists match", () => {
    expect(userOrderDiffers(["u1", "u2"], ["u1", "u2"])).toBe(false);
  });
});
