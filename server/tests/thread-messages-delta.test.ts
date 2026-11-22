import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  messagesDelta,
  parseTailLimit,
  prefixHashes,
  sliceTailMessages,
  threadMessagesDelta,
} from "../src/thread-messages-delta";

const user = (id: string, content: string) => ({ id, role: "user", content });
const bot = (id: string, content: string) => ({
  id,
  role: "assistant",
  content,
});

describe("messagesDelta", () => {
  const base = [
    user("u1", "hi"),
    bot("a1", "hello"),
    user("u2", "more"),
    bot("a2", "stream"),
  ];

  test("first read (empty since) returns the whole transcript with a version and cursor", () => {
    const delta = messagesDelta(base, "", null);
    expect(delta).toMatchObject({ start: 0, messages: base });
    expect("version" in delta && delta.version.startsWith("m1.4.")).toBe(true);
    expect("cursor" in delta && delta.cursor.startsWith("m1.3.")).toBe(true);
  });

  test("an unchanged transcript answers unchanged without messages", () => {
    const first = messagesDelta(base, "", null);
    const again = messagesDelta(
      structuredClone(base),
      first.version,
      first.cursor,
    );
    expect(again).toEqual({
      unchanged: true,
      version: first.version,
      cursor: first.cursor,
    });
  });

  test("streaming growth of the last message and appended messages come back as a tail", () => {
    const first = messagesDelta(base, "", null);
    const grown = [
      ...base.slice(0, 3),
      bot("a2", "stream more"),
      user("u3", "next"),
    ];
    const delta = messagesDelta(grown, first.version, first.cursor);
    expect(delta).toMatchObject({ start: 3, messages: grown.slice(3) });
  });

  test("an edit, delete or insert before the cursor falls back to the full transcript", () => {
    const first = messagesDelta(base, "", null);
    const edited = [user("u1", "hi (edited)"), ...base.slice(1)];
    expect(messagesDelta(edited, first.version, first.cursor)).toMatchObject({
      start: 0,
      messages: edited,
    });
    const deleted = [base[0], base[2], base[3]];
    expect(messagesDelta(deleted, first.version, first.cursor)).toMatchObject({
      start: 0,
      messages: deleted,
    });
    const truncated = base.slice(0, 2);
    expect(messagesDelta(truncated, first.version, first.cursor)).toMatchObject(
      { start: 0, messages: truncated },
    );
  });

  test("garbage tokens are treated as a first read", () => {
    expect(messagesDelta(base, "nope", "m1.x.y")).toMatchObject({
      start: 0,
      messages: base,
    });
    expect(messagesDelta(base, null, "m1.99.abc")).toMatchObject({
      start: 0,
      messages: base,
    });
  });

  test("prefix hashes depend on every earlier message", () => {
    const a = prefixHashes(base);
    const b = prefixHashes([user("u1", "HI"), ...base.slice(1)]);
    expect(a[0]).toBe(b[0]);
    for (let index = 1; index <= base.length; index += 1)
      expect(a[index]).not.toBe(b[index]);
  });
});

describe("threadMessagesDelta middleware", () => {
  let stored: unknown[] = [user("u1", "hi"), bot("a1", "hello")];
  const app = new Hono();
  app.use("/api/conversations/*", threadMessagesDelta);
  app.get("/api/conversations/threads/:id/messages", (c) =>
    c.json({ messages: stored }),
  );
  app.get("/api/conversations/threads/:id/other", (c) =>
    c.json({ messages: stored }),
  );

  test("old clients without since/cursor get the response untouched", async () => {
    const response = await app.request(
      "/api/conversations/threads/t1/messages",
    );
    expect(await response.json()).toEqual({ messages: stored });
  });

  test("new clients get versions, unchanged answers and tails", async () => {
    const first = await (
      await app.request("/api/conversations/threads/t1/messages?since=")
    ).json();
    expect(first).toMatchObject({ start: 0, messages: stored });
    const query = `since=${encodeURIComponent(first.version)}&cursor=${encodeURIComponent(first.cursor)}`;
    const same = await app.request(
      `/api/conversations/threads/t1/messages?${query}`,
    );
    expect(same.headers.get("cache-control")).toBe("no-store");
    expect(await same.json()).toEqual({
      unchanged: true,
      version: first.version,
      cursor: first.cursor,
    });
    stored = [
      ...stored.slice(0, 1),
      bot("a1", "hello there"),
      user("u2", "ok"),
    ];
    const tail = await (
      await app.request(`/api/conversations/threads/t1/messages?${query}`)
    ).json();
    expect(tail).toMatchObject({ start: 1, messages: stored.slice(1) });
    // 同一份记录再读一次（命中缓存的指纹）：旧的 since 仍拿到尾部，新的 since 拿到 unchanged。
    const again = await (
      await app.request(`/api/conversations/threads/t1/messages?${query}`)
    ).json();
    expect(again).toEqual(tail);
    const latest = `since=${encodeURIComponent(tail.version)}&cursor=${encodeURIComponent(tail.cursor)}`;
    expect(
      await (
        await app.request(`/api/conversations/threads/t1/messages?${latest}`)
      ).json(),
    ).toEqual({ unchanged: true, version: tail.version, cursor: tail.cursor });
  });

  test("other routes and error responses pass through", async () => {
    expect(
      await (
        await app.request("/api/conversations/threads/t1/other?since=")
      ).json(),
    ).toEqual({ messages: stored });
    const missing = await app.request("/api/conversations/nothing?since=");
    expect(missing.status).toBe(404);
  });

  test("cold reads with ?tail= return partial tail without version/cursor on long threads", async () => {
    const longStored = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? user(`u${i}`, `msg ${i}`) : bot(`a${i}`, `reply ${i}`),
    );
    const localApp = new Hono();
    localApp.use("/api/conversations/*", threadMessagesDelta);
    localApp.get("/api/conversations/threads/:id/messages", (c) =>
      c.json({ messages: longStored }),
    );

    const tailRes = await localApp.request(
      "/api/conversations/threads/long1/messages?since=&tail=20",
    );
    const tailBody = await tailRes.json();
    expect(tailBody.partial).toBe(true);
    expect(tailBody.total).toBe(40);
    expect(tailBody.messages).toEqual(longStored.slice(-20));
    expect(tailBody.version).toBeUndefined();
    expect(tailBody.cursor).toBeUndefined();

    // Short read where tail >= total returns full delta with version & cursor
    const fullShort = await localApp.request(
      "/api/conversations/threads/long1/messages?since=&tail=120",
    );
    const fullShortBody = await fullShort.json();
    expect(fullShortBody.partial).toBeUndefined();
    expect(fullShortBody.messages).toEqual(longStored);
    expect(typeof fullShortBody.version).toBe("string");
    expect(typeof fullShortBody.cursor).toBe("string");

    // When since & cursor are present, tail is ignored and incremental path runs
    const sameRes = await localApp.request(
      `/api/conversations/threads/long1/messages?since=${encodeURIComponent(fullShortBody.version)}&cursor=${encodeURIComponent(fullShortBody.cursor)}&tail=20`,
    );
    expect(await sameRes.json()).toEqual({
      unchanged: true,
      version: fullShortBody.version,
      cursor: fullShortBody.cursor,
    });
  });

  test("parseTailLimit and sliceTailMessages enforce byte budget while keeping min 20", () => {
    expect(parseTailLimit(null)).toBeNull();
    expect(parseTailLimit("0")).toBeNull();
    expect(parseTailLimit("-5")).toBeNull();
    expect(parseTailLimit("abc")).toBeNull();
    expect(parseTailLimit("9999")).toBe(500);
    expect(parseTailLimit("120")).toBe(120);

    const huge = Array.from({ length: 30 }, (_, i) =>
      user(`u${i}`, "x".repeat(40_000)),
    );
    const sliced = sliceTailMessages(huge, 30, 512 * 1024);
    // 12 * 40KB < 512KB, minKeep = 20 forces keeping at least 20 latest messages
    expect(sliced.length).toBe(20);
    expect((sliced[0] as { id: string }).id).toBe("u10");

    const medium = Array.from({ length: 80 }, (_, i) =>
      user(`m${i}`, "y".repeat(20_000)),
    );
    const slicedMedium = sliceTailMessages(medium, 80, 512 * 1024);
    // ~25 * 20KB ~ 500KB: capped under 512KB while >= 20
    expect(slicedMedium.length).toBeGreaterThanOrEqual(20);
    expect(slicedMedium.length).toBeLessThan(35);
    expect((slicedMedium.at(-1) as { id: string }).id).toBe("m79");
  });
});
