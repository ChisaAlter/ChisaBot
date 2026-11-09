import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createBotThreads } from "../src/bot-threads";
import type { Database } from "../src/db/client";

/**
 * 全端同步（DESIGN.md §42）：服务器上的「当前对话」指针。用一个只认这几条 SQL 的假库测路由行为：
 * 迁移只在为空时写、「新对话」覆盖、别人的对话不能设、同步回复带上变化戳。
 */
type ThreadRow = {
  owner_user_id: string;
  agent_id: string;
  locked?: boolean;
  name?: string;
  updated?: number;
  messages?: { role: string; content: unknown }[];
};

function fakeDatabase(threads: Record<string, ThreadRow> = {}, events: Record<string, number> = {}) {
  const pointers = new Map<string, { thread_id: string; updated_at: Date }>();
  const unsafe = async (query: string, params: unknown[] = []) => {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("CREATE TABLE")) return [];
    if (q.startsWith("SELECT thread_id, updated_at FROM chisabot_bot_threads")) {
      const row = pointers.get(`${params[0]}|${params[1]}`);
      return row ? [row] : [];
    }
    if (q.startsWith("INSERT INTO chisabot_bot_threads")) {
      const key = `${params[0]}|${params[1]}`;
      if (q.includes("DO NOTHING") && pointers.has(key)) return [];
      pointers.set(key, { thread_id: String(params[2]), updated_at: new Date() });
      return [];
    }
    if (q.startsWith("SELECT owner_user_id, agent_id FROM chisabot_local_threads")) {
      const row = threads[String(params[0])];
      return row ? [row] : [];
    }
    if (q.startsWith("SELECT (SELECT owner_user_id")) {
      const row = threads[String(params[0])];
      const seq = events[String(params[0])];
      return [{ owner: row?.owner_user_id ?? null, locked: row?.locked ?? null, seq: seq ? String(seq) : null, inbox: null }];
    }
    if (q.startsWith("SELECT max(updated_at) AS at FROM chisabot_workers")) return [{ at: null }];
    if (q.startsWith("SELECT count(*)::text AS n FROM chisabot_thread_truncations")) return [{ n: params[0] === "t1" ? "3" : "0" }];
    if (q.startsWith("SELECT id, name, jsonb_array_length(messages)")) {
      // 只模拟 WHERE 条件：自己的、这个机器人的、不是 worker-*、有消息；按 updated 倒序。
      return Object.entries(threads)
        .filter(([id, row]) => row.owner_user_id === params[0] && row.agent_id === params[1] && !id.startsWith("worker-") && (row.messages?.length ?? 0) > 0)
        .sort((a, b) => (b[1].updated ?? 0) - (a[1].updated ?? 0))
        .map(([id, row]) => ({
          id,
          name: row.name ?? null,
          count: row.messages?.length ?? 0,
          updated_at: new Date(row.updated ?? 0),
          first: row.messages?.find((m) => m.role === "user")?.content ?? null,
        }));
    }
    throw new Error(`unexpected query: ${q}`);
  };
  return { $client: { unsafe } } as unknown as Database;
}

const asUser = (id: string): MiddlewareHandler<{ Variables: AppVariables }> => async (c, next) => {
  c.set("actor", { id, email: `${id}@example.com`, role: "member" } as AppVariables["actor"]);
  await next();
};

async function app(database: Database, user = "u1", active: string[] = []) {
  const threads = await createBotThreads(database, { isActive: (id) => active.includes(id) });
  return threads.routes(asUser(user));
}

const put = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("bot thread pointer", () => {
  test("starts empty, then the first device's thread is adopted and a later migration does not overwrite it", async () => {
    const routes = await app(fakeDatabase());
    expect(await (await routes.request("/bot-a")).json()).toEqual({ threadId: null, updatedAt: null });
    const first = await (await routes.request("/bot-a", put({ threadId: "t-web", onlyIfNone: true }))).json();
    expect(first.threadId).toBe("t-web");
    const second = await (await routes.request("/bot-a", put({ threadId: "t-phone", onlyIfNone: true }))).json();
    expect(second.threadId).toBe("t-web");
  });

  test("新对话 replaces the current thread for every device", async () => {
    const routes = await app(fakeDatabase());
    await routes.request("/bot-a", put({ threadId: "t-old" }));
    await routes.request("/bot-a", put({ threadId: "t-new" }));
    expect((await (await routes.request("/bot-a")).json()).threadId).toBe("t-new");
  });

  test("pointers are per person and per bot", async () => {
    const database = fakeDatabase();
    const mine = await app(database, "u1");
    const theirs = await app(database, "u2");
    await mine.request("/bot-a", put({ threadId: "t1" }));
    expect((await (await theirs.request("/bot-a")).json()).threadId).toBeNull();
    expect((await (await mine.request("/bot-b")).json()).threadId).toBeNull();
  });

  test("someone else's thread, or another bot's, cannot be made current", async () => {
    const routes = await app(fakeDatabase({ "t-x": { owner_user_id: "u2", agent_id: "bot-a" }, "t-y": { owner_user_id: "u1", agent_id: "bot-b" } }));
    expect((await routes.request("/bot-a", put({ threadId: "t-x" }))).status).toBe(404);
    expect((await routes.request("/bot-a", put({ threadId: "t-y" }))).status).toBe(404);
    expect((await routes.request("/bot-a", put({ threadId: "bad id with spaces" }))).status).toBe(400);
  });

  test("sync reports the current thread and the shown thread's change stamps", async () => {
    const routes = await app(fakeDatabase({ t1: { owner_user_id: "u1", agent_id: "bot-a" } }, { t1: 42 }), "u1", ["t1"]);
    await routes.request("/bot-a", put({ threadId: "t1" }));
    const reply = await (await routes.request("/bot-a/sync?threadId=t1")).json();
    expect(reply.current.threadId).toBe("t1");
    expect(reply.thread).toEqual({ threadId: "t1", seq: "42", running: true, workers: null, inbox: null, revision: "3" });
  });

  test("sync on a brand-new thread (no row yet) is an empty, idle conversation", async () => {
    const routes = await app(fakeDatabase());
    const reply = await (await routes.request("/bot-a/sync?threadId=t-fresh")).json();
    expect(reply.thread).toEqual({ threadId: "t-fresh", seq: "0", running: false, workers: null, inbox: null, revision: "0" });
  });

  test("sync never describes someone else's thread", async () => {
    const routes = await app(fakeDatabase({ t1: { owner_user_id: "u2", agent_id: "bot-a" } }, { t1: 7 }));
    const reply = await (await routes.request("/bot-a/sync?threadId=t1")).json();
    expect(reply.thread).toBeNull();
  });

  test("history lists this person's threads with this bot, newest first, titled by the first user message", async () => {
    const say = (text: unknown) => [{ role: "user", content: text }, { role: "assistant", content: "好的" }];
    const routes = await app(
      fakeDatabase({
        old: { owner_user_id: "u1", agent_id: "bot-a", updated: 1, messages: say("  帮我查一下\n 明天的天气  ") },
        recent: { owner_user_id: "u1", agent_id: "bot-a", updated: 3, messages: say([{ type: "text", text: "写一封邮件" }]) },
        named: { owner_user_id: "u1", agent_id: "bot-a", updated: 2, name: "周报", messages: say("x") },
        empty: { owner_user_id: "u1", agent_id: "bot-a", updated: 4, messages: [] },
        "worker-1": { owner_user_id: "u1", agent_id: "bot-a", updated: 5, messages: say("任务") },
        other: { owner_user_id: "u2", agent_id: "bot-a", updated: 6, messages: say("别人的") },
        otherBot: { owner_user_id: "u1", agent_id: "bot-b", updated: 7, messages: say("别的机器人") },
      }),
    );
    const reply = await (await routes.request("/bot-a/history")).json();
    expect(reply.threads.map((t: { threadId: string; title: string; messages: number }) => [t.threadId, t.title, t.messages])).toEqual([
      ["recent", "写一封邮件", 2],
      ["named", "周报", 2],
      ["old", "帮我查一下 明天的天气", 2],
    ]);
  });
});
