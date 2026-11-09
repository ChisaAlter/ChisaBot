import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { BotReset } from "../src/agents/lifecycle-reset";
import { createAgentPurge } from "../src/agents/purge";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, livePanels, users } from "../src/db/schema";
import { createLivePanelStore } from "../src/live-panels/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 回归：删机器人以前不碰 live_panels——面板行留下、到点照样刷新（2026-10-13 生产上有 3 个孤儿）。
 * 现在：删除时软删除并停掉刷新，机器人真正删掉时连行删除；开机清掉机器人已不在的面板。
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createLivePanelStore(database);
const prefix = `lpdel-${randomUUID().slice(0, 8)}`;
const userId = `${prefix}-user`;
const agentIds: string[] = [];
const panelIds: string[] = [];

afterAll(async () => {
  if (panelIds.length)
    await database.delete(livePanels).where(inArray(livePanels.id, panelIds));
  if (agentIds.length)
    await database.delete(agents).where(inArray(agents.id, agentIds));
  await database.delete(users).where(eq(users.id, userId));
  await database.$client.close();
});

async function bot(deleted = false) {
  const id = `${prefix}-agent-${agentIds.length}`;
  agentIds.push(id);
  await database
    .insert(agents)
    .values({ id, name: id, type: "built_in", configuration: {} });
  await database.insert(agentProfiles).values({
    agentId: id,
    ownerUserId: userId,
    title: "t",
    roleDescription: "r",
    avatarSeed: id,
    visibility: "private",
    deletedAt: deleted ? new Date() : null,
  });
  return id;
}

async function panel(botId: string) {
  const id = `lp_${prefix}-${panelIds.length}`;
  panelIds.push(id);
  await database.insert(livePanels).values({
    id,
    ownerUserId: userId,
    botId,
    title: id,
    status: "ready",
    sources: [],
    instruction: "x",
    refreshMinutes: 60,
    nextRefreshAt: new Date(Date.now() - 60_000),
  });
  return id;
}
const rowOf = async (id: string) =>
  (await database.select().from(livePanels).where(eq(livePanels.id, id)))[0];
const dueIds = async () => (await store.due(500)).map((row) => row.id);

describe("删机器人时它的面板", () => {
  test("setup", async () => {
    await database
      .insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: "lp" });
  });

  test("retireForBot：只软删除这个机器人的面板，并停掉调度", async () => {
    const a = await bot();
    const b = await bot();
    const pa = await panel(a);
    const pb = await panel(b);
    expect(await dueIds()).toEqual(expect.arrayContaining([pa, pb]));
    expect(await store.retireForBot(a)).toEqual([pa]);
    const ra = await rowOf(pa);
    expect(ra?.removed).toBe(true);
    expect(ra?.nextRefreshAt).toBeNull();
    expect(ra?.leaseUntil).toBeNull();
    expect((await rowOf(pb))?.removed).toBe(false);
    const due = await dueIds();
    expect(due).toContain(pb);
    expect(due).not.toContain(pa);
  });

  test("资料已标删除（还没清完）的机器人，面板不再到点刷新", async () => {
    const d = await bot(true);
    const pd = await panel(d);
    expect(await dueIds()).not.toContain(pd);
  });

  test("purge 删掉机器人时连 live_panels 行一起删", async () => {
    const c = await bot();
    const pc = await panel(c);
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, c));
    const retired: string[] = [];
    const reset = { execute: async () => null } as unknown as BotReset;
    const purge = createAgentPurge({
      database,
      reset,
      profilesDir: "/tmp/does-not-exist-lpdel",
      retirePanels: async (agentId) => retired.push(agentId),
    });
    const report = await purge.purge({ id: userId, role: "admin" }, c);
    expect(retired).toEqual([c]);
    expect(report.removed).toBe(true);
    expect(report.panelsRemoved).toBeGreaterThanOrEqual(1);
    expect(await rowOf(pc)).toBeUndefined();
  });

  test("删除机器人时，它的云端浏览器经由浏览器进程删除（DESIGN.md §99）", async () => {
    const c = await bot();
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, c));
    const forgotten: string[] = [];
    const reset = { execute: async () => null } as unknown as BotReset;
    const purge = createAgentPurge({
      database,
      reset,
      profilesDir: "/tmp/does-not-exist-lpdel",
      forgetComputer: async (agentId) => {
        forgotten.push(agentId);
      },
    });
    const report = await purge.purge({ id: userId, role: "admin" }, c);
    expect(report.removed).toBe(true);
    expect(forgotten).toEqual([c]);
  });

  test("开机清孤儿：机器人行没了 / 资料已删的面板删掉，活着的机器人的面板不动", async () => {
    const alive = await bot();
    const pAlive = await panel(alive);
    const gone = `${prefix}-gone`;
    const pGone = await panel(gone); // agents 里根本没有这个机器人
    const del = await bot(true);
    const pDel = await panel(del);
    const removed = await store.sweepOrphans();
    expect(removed).toEqual(expect.arrayContaining([pGone, pDel]));
    expect(removed).not.toContain(pAlive);
    expect(await rowOf(pAlive)).toBeDefined();
    expect(await rowOf(pGone)).toBeUndefined();
    expect(await store.sweepOrphans()).not.toContain(pAlive);
  });
});
