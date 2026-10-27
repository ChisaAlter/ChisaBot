import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { isAvatarEmoji, isAvatarShape, isShapeColor, monogramOf, sniffAvatarMime } from "../../shared/bot-avatars";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import { avatarView, createBotAvatars } from "../src/bot-avatars/service";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 机器人头像（DESIGN.md §81）。 */
describe("avatar helpers", () => {
  test("emoji check takes pictographs and flags, refuses text", () => {
    for (const ok of ["🐱", "🧑‍💻", "❤️", "🇨🇳", "👍🏽"]) expect(isAvatarEmoji(ok)).toBe(true);
    for (const bad of ["", "a", "猫", "🐱 ", "<b>", "12", "x🐱", "🐱🐱🐱🐱🐱🐱🐱🐱🐱"]) expect(isAvatarEmoji(bad)).toBe(false);
  });
  test("mime is sniffed from the bytes", () => {
    expect(sniffAvatarMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe("image/png");
    expect(sniffAvatarMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffAvatarMime(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffAvatarMime(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
  test("a stored shape avatar comes back as shape + colour, and a row with an unknown shape or colour is dropped, not trusted", () => {
    const row = { agent_id: "a1", kind: "shape" as const, emoji: null, color: "violet", shape: "tile", mime: null, version: "v1" };
    expect(avatarView(row)).toEqual({ kind: "shape", shape: "tile", color: "violet" });
    expect(avatarView({ ...row, shape: "<script>" })).toBeNull();
    expect(avatarView({ ...row, shape: null })).toBeNull();
    // 圆形头像的底色（sky 等）不是形象的颜色，不能串着用。
    expect(avatarView({ ...row, color: "sky" })).toBeNull();
    expect(isAvatarShape("tile") && isShapeColor("violet")).toBe(true);
  });
  test("monogram is the first character", () => {
    expect(monogramOf(" 英语老师")).toBe("英");
    expect(monogramOf("alice")).toBe("A");
    expect(monogramOf("")).toBe("?");
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("bot avatars routes", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const tag = randomUUID().slice(0, 8);
  const mine = `agent_av_${tag}`;
  const others = `agent_av_other_${tag}`;
  const owner: AgentActor = { id: `u_${tag}`, email: "o@example.com", role: "member" } as AgentActor;
  const stranger: AgentActor = { id: `s_${tag}`, email: "s@example.com", role: "member" } as AgentActor;
  const profile = (id: string, ownerUserId: string) =>
    ({ id, ownerUserId, visibility: "private", systemOwned: false, deletedAt: null, name: "x" }) as unknown as AgentProfile;
  const bots = [profile(mine, owner.id), profile(others, stranger.id)];
  const agents = {
    list: async (actor: AgentActor) => bots.filter((bot) => bot.ownerUserId === actor.id),
    get: async (actor: AgentActor, id: string) => bots.find((bot) => bot.id === id && bot.ownerUserId === actor.id) ?? null,
  };
  const service = url ? createBotAvatars(database, agents) : (null as never);
  let as: AgentActor = owner;
  const requireUser: MiddlewareHandler = async (c, next) => {
    c.set("actor", as);
    await next();
  };
  const app = url ? service.routes(requireUser as never) : (null as never);
  const call = (path: string, init?: RequestInit) => app.request(path, init);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]);

  beforeAll(async () => {
    await service.ensure();
    await service.ensure(); // 开机两次也不报错
  });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM chisabot_bot_avatars WHERE agent_id IN ($1, $2)", [mine, others]);
  });

  test("default is no row", async () => {
    as = owner;
    expect(await (await call("/")).json()).toEqual({ avatars: {} });
  });

  test("emoji preset round trip, bad input refused", async () => {
    as = owner;
    const ok = await call(`/${mine}`, { method: "PUT", body: JSON.stringify({ kind: "emoji", emoji: "🐱", color: "sky" }), headers: { "content-type": "application/json" } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).avatar).toEqual({ kind: "emoji", emoji: "🐱", color: "sky" });
    for (const body of [{ kind: "emoji", emoji: "hi", color: "sky" }, { kind: "emoji", emoji: "🐱", color: "#fff" }, { kind: "svg", color: "sky" }]) {
      const bad = await call(`/${mine}`, { method: "PUT", body: JSON.stringify(body) });
      expect(bad.status).toBe(400);
    }
    const list = await (await call("/")).json();
    expect(list.avatars[mine]).toEqual({ kind: "emoji", emoji: "🐱", color: "sky" });
  });

  test("image upload: sniffed, versioned url, served with nosniff; non-images refused", async () => {
    as = owner;
    const svg = await call(`/${mine}/image`, { method: "PUT", body: "<svg/>" });
    expect(svg.status).toBe(400);
    const big = await call(`/${mine}/image`, { method: "PUT", body: new Uint8Array(300 * 1024) });
    expect(big.status).toBe(413);
    const up = await call(`/${mine}/image`, { method: "PUT", body: png });
    expect(up.status).toBe(200);
    const { avatar } = await up.json();
    expect(avatar.kind).toBe("image");
    expect(avatar.url).toBe(`/api/bot-avatars/${mine}/image?v=${avatar.version}`);
    const got = await call(`/${mine}/image?v=${avatar.version}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);
    const stale = await call(`/${mine}/image?v=old`);
    expect(stale.headers.get("cache-control")).toContain("no-cache");
  });

  test("monogram replaces the image; delete goes back to default", async () => {
    as = owner;
    const mono = await call(`/${mine}`, { method: "PUT", body: JSON.stringify({ kind: "monogram", color: "violet" }) });
    expect((await mono.json()).avatar).toEqual({ kind: "monogram", color: "violet" });
    expect((await call(`/${mine}/image`)).status).toBe(404);
    expect((await call(`/${mine}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await call("/")).json()).avatars[mine]).toBeUndefined();
  });

  test("someone else cannot read or change it", async () => {
    as = owner;
    await call(`/${mine}/image`, { method: "PUT", body: png });
    as = stranger;
    expect((await call(`/${mine}/image`)).status).toBe(404);
    expect((await call(`/${mine}`, { method: "PUT", body: JSON.stringify({ kind: "monogram", color: "sky" }) })).status).toBe(404);
    expect((await call(`/${mine}`, { method: "DELETE" })).status).toBe(404);
    expect((await (await call("/")).json()).avatars[mine]).toBeUndefined();
  });
});
