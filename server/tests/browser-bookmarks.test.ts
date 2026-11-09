import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import {
  createBrowserBookmarks,
  normaliseBookmarkTitle,
  normaliseBookmarkUrl,
  SEED_BOOKMARKS,
} from "../src/browser-bookmarks/service";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 浏览器收藏夹（DESIGN.md §95）。 */
describe("bookmark input", () => {
  test("url: only http(s); bare host gets https://", () => {
    expect(normaliseBookmarkUrl("github.com")).toBe("https://github.com/");
    expect(normaliseBookmarkUrl(" https://a.example/x?y=1 ")).toBe(
      "https://a.example/x?y=1",
    );
    for (const bad of [
      "",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "chrome://settings",
      3,
      null,
    ])
      expect(() => normaliseBookmarkUrl(bad)).toThrow();
  });
  test("title: trimmed, collapsed, falls back to host, capped at 80", () => {
    expect(normaliseBookmarkTitle("  a   b ", "https://x.example/")).toBe(
      "a b",
    );
    expect(normaliseBookmarkTitle("", "https://x.example/p")).toBe("x.example");
    expect(
      Array.from(normaliseBookmarkTitle("字".repeat(200), "https://x/")).length,
    ).toBe(80);
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("bookmark routes", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const tag = randomUUID().slice(0, 8);
  const owner = { id: `u_bm_${tag}`, role: "user" } as AgentActor;
  const stranger = { id: `s_bm_${tag}`, role: "user" } as AgentActor;
  const mine = `agent_bm_${tag}`;
  const bots = [{ id: mine, ownerUserId: owner.id } as unknown as AgentProfile];
  const pushed: { botId: string; links: { title: string; url: string }[] }[] =
    [];
  const service = url
    ? createBrowserBookmarks(database, {
        agents: {
          get: async (actor: AgentActor, id: string) =>
            bots.find(
              (bot) =>
                bot.id === id &&
                (bot as unknown as { ownerUserId: string }).ownerUserId ===
                  actor.id,
            ) ?? null,
        },
        pushStartLinks: async (botId, links) => {
          pushed.push({ botId, links });
        },
      })
    : (null as never);
  let as: AgentActor = owner;
  const requireUser: MiddlewareHandler = async (c, next) => {
    c.set("actor", as);
    await next();
  };
  const app = url ? service.routes(requireUser as never) : (null as never);
  const call = (path: string, init?: { method?: string; body?: unknown }) =>
    app.request(path, {
      method: init?.method ?? "GET",
      ...(init?.body === undefined
        ? {}
        : {
            body: JSON.stringify(init.body),
            headers: { "content-type": "application/json" },
          }),
    });

  test("first read seeds the five start-page sites once", async () => {
    await service.ensure();
    await service.ensure(); // 幂等
    const first = (await (await call("/")).json()) as {
      bookmarks: { title: string; url: string }[];
    };
    expect(first.bookmarks.map((b) => b.title)).toEqual(
      SEED_BOOKMARKS.map((b) => b.title),
    );
    const again = (await (await call("/")).json()) as { bookmarks: unknown[] };
    expect(again.bookmarks.length).toBe(5);
  });

  test("add / duplicate / rename / reorder / delete", async () => {
    const added = (await (
      await call("/", {
        method: "POST",
        body: { url: "example.com/docs", title: " 文档 " },
      })
    ).json()) as {
      bookmark: { id: string; url: string; title: string; position: number };
    };
    expect(added.bookmark.url).toBe("https://example.com/docs");
    expect(added.bookmark.title).toBe("文档");
    expect(added.bookmark.position).toBe(5);
    const dup = (await (
      await call("/", {
        method: "POST",
        body: { url: "https://example.com/docs" },
      })
    ).json()) as {
      bookmark: { id: string };
    };
    expect(dup.bookmark.id).toBe(added.bookmark.id);
    expect(
      (
        await call("/", {
          method: "POST",
          body: { url: "javascript:alert(1)" },
        })
      ).status,
    ).toBe(400);

    const renamed = await call(`/${added.bookmark.id}`, {
      method: "PATCH",
      body: { title: "新名字" },
    });
    expect(
      ((await renamed.json()) as { bookmark: { title: string } }).bookmark
        .title,
    ).toBe("新名字");

    const list = (
      (await (await call("/")).json()) as { bookmarks: { id: string }[] }
    ).bookmarks;
    const ids = list.map((b) => b.id);
    const reordered = (await (
      await call("/order", {
        method: "PUT",
        body: { ids: [added.bookmark.id, ids[0]] },
      })
    ).json()) as {
      bookmarks: { id: string }[];
    };
    expect(reordered.bookmarks[0]?.id).toBe(added.bookmark.id);
    expect(reordered.bookmarks[1]?.id).toBe(ids[0]);
    expect(reordered.bookmarks.length).toBe(6);

    expect(
      (await call(`/${added.bookmark.id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await call(`/${added.bookmark.id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  test("deleting everything does not re-seed", async () => {
    const list = (
      (await (await call("/")).json()) as { bookmarks: { id: string }[] }
    ).bookmarks;
    for (const b of list) await call(`/${b.id}`, { method: "DELETE" });
    const after = (await (await call("/")).json()) as { bookmarks: unknown[] };
    expect(after.bookmarks).toEqual([]);
  });

  test("per-user scope: a stranger cannot see, edit or delete", async () => {
    const added = (await (
      await call("/", {
        method: "POST",
        body: { url: "https://mine.example/" },
      })
    ).json()) as {
      bookmark: { id: string };
    };
    as = stranger;
    const theirs = (await (await call("/")).json()) as {
      bookmarks: { url: string }[];
    };
    expect(
      theirs.bookmarks.some((b) => b.url === "https://mine.example/"),
    ).toBe(false);
    expect(
      (
        await call(`/${added.bookmark.id}`, {
          method: "PATCH",
          body: { title: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(`/${added.bookmark.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    // 推起始页：别人的机器人 → 404
    expect((await call(`/sync/${mine}`, { method: "POST" })).status).toBe(404);
    as = owner;
  });

  test("sync pushes the first 12 bookmarks to the bot's start page", async () => {
    const response = await call(`/sync/${mine}`, { method: "POST" });
    expect(response.status).toBe(200);
    const last = pushed.at(-1);
    expect(last?.botId).toBe(mine);
    expect(last?.links.map((l) => l.url)).toContain("https://mine.example/");
    await database.$client.unsafe(
      "DELETE FROM chisabot_browser_bookmarks WHERE user_id = ANY(string_to_array($1, ','))",
      [`${owner.id},${stranger.id}`],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_browser_bookmark_seeds WHERE user_id = ANY(string_to_array($1, ','))",
      [`${owner.id},${stranger.id}`],
    );
  });
});
