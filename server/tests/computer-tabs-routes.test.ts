import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createComputerRoutes } from "../src/computer/routes";

/** 浏览器标签接口（DESIGN.md §95）：路由只做形状检查和「能不能用这个机器人」，其余交给网关。 */
function signedIn(id: string): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id, email: `${id}@chisabot.test`, role: "user" });
    await next();
  };
}
const ownedBy = (owner: string) => async (actor: { id: string }, botId: string) =>
  botId === "sales" && actor.id === owner;

function app(actorId: string) {
  const reached: unknown[] = [];
  const view = (activeId: string) => ({
    running: true,
    max: 8,
    activeId,
    tabs: [
      { id: "t1", url: "https://a.test/", title: "A", active: activeId === "t1" },
      { id: "t2", url: "about:blank", title: "新标签页", active: activeId === "t2" },
    ],
  });
  const gateway = {
    tabs: async (botId: string) => {
      reached.push(["tabs", botId]);
      return view("t1");
    },
    tabAction: async (botId: string, actor: { id: string }, input: unknown) => {
      reached.push(["bot", botId, actor.id, input]);
      return view("t2");
    },
    humanTab: async (botId: string, input: unknown) => {
      reached.push(["human", botId, input]);
      return view("t2");
    },
  } as never;
  const routes = createComputerRoutes(
    gateway,
    { get: () => ({ mode: "enforce", deny: [], allow: [] }) } as never,
    signedIn(actorId),
    ownedBy("owner"),
  );
  return { reached, hono: new Hono().route("/api/computers", routes) };
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("computer tabs routes", () => {
  test("lists tabs", async () => {
    const { hono, reached } = app("owner");
    const response = await hono.request("http://t/api/computers/sales/tabs");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tabs: unknown[]; activeId: string };
    expect(body.tabs.length).toBe(2);
    expect(body.activeId).toBe("t1");
    expect(reached).toEqual([["tabs", "sales"]]);
  });

  test("bot opens a tab with a url, switches, closes", async () => {
    const { hono, reached } = app("owner");
    expect((await hono.request("http://t/api/computers/sales/tabs", post({ action: "new", url: " https://b.test/ " }))).status).toBe(200);
    expect((await hono.request("http://t/api/computers/sales/tabs", post({ action: "activate", id: "t1" }))).status).toBe(200);
    expect((await hono.request("http://t/api/computers/sales/tabs", post({ action: "close", id: "t2" }))).status).toBe(200);
    expect(reached).toEqual([
      ["bot", "sales", "owner", { action: "new", url: "https://b.test/" }],
      ["bot", "sales", "owner", { action: "activate", id: "t1" }],
      ["bot", "sales", "owner", { action: "close", id: "t2" }],
    ]);
  });

  test("refuses an unknown action with 400 before reaching the computer", async () => {
    const { hono, reached } = app("owner");
    const response = await hono.request("http://t/api/computers/sales/tabs", post({ action: "nuke" }));
    expect(response.status).toBe(400);
    expect(reached).toEqual([]);
  });

  test("human tab actions go to humanTab, not to the generic human input route", async () => {
    const { hono, reached } = app("owner");
    const response = await hono.request("http://t/api/computers/sales/human/tab", post({ action: "new" }));
    expect(response.status).toBe(200);
    expect(reached).toEqual([["human", "sales", { action: "new" }]]);
  });

  test("somebody else's bot: 404 and nothing reached", async () => {
    const { hono, reached } = app("stranger");
    expect((await hono.request("http://t/api/computers/sales/tabs")).status).toBe(404);
    expect((await hono.request("http://t/api/computers/sales/tabs", post({ action: "new" }))).status).toBe(404);
    expect((await hono.request("http://t/api/computers/sales/human/tab", post({ action: "close", id: "t1" }))).status).toBe(404);
    expect(reached).toEqual([]);
  });
});
