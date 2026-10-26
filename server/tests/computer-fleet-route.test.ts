import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The fleet is a fact about the deployment, not about a Bot. This is the same bug as the boundary
 * one in computer-policy-route.test.ts, a second time.
 *
 * Admin listed the fleet by calling `/:botId/computers` with a placeholder id, on the reasoning that
 * the endpoint answers with every computer whatever the path says. True when it was written. Then
 * the bot-access middleware arrived, the placeholder was not a Bot, `canUseBot` said so, and
 * `/admin/computers` answered 404 for everybody including an administrator. The screen renders
 * nothing at all while the list is null, so it did not even look broken: it looked like a
 * deployment with no computers, while two containers were running.
 *
 * The middleware's own comment asked for this: "a second deployment-wide route added later should
 * have to think about this line." It was added later and did not. So the fleet has a route of its
 * own now, and this holds it there.
 *
 * Found by driving the screen against a deployment that had computers, not by reading the diff.
 */

const ADMIN = { id: "u1", email: "admin@chisabot.test", role: "admin" } as const;

function app(role: "admin" | "user" = "admin") {
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN, role });
    await next();
  };

  const gateway = {
    computers: async () => ({
      isolation: "per-bot",
      computers: [
        { botId: "risk-analyst", running: true, startedAt: null },
        { botId: "general-assistant", running: false, startedAt: null },
      ],
    }),
  } as unknown as ComputerGateway;

  const policyStore = {
    get: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    set: async () => undefined,
  } as unknown as PolicyStore;

  const routes = createComputerRoutes(
    gateway,
    policyStore,
    asActor,
    // No Bot is reachable, which is the deployment the bug showed up in: listing the fleet must not
    // depend on the caller having access to a Bot that happens to share the collection's name.
    async () => false,
  );

  return new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    routes,
  );
}

describe("listing every computer in the deployment", () => {
  test("an administrator gets the fleet, whatever Bots they can reach", async () => {
    const response = await app().request("http://t/api/computers/fleet");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      isolation: "per-bot",
      computers: [{ botId: "risk-analyst" }, { botId: "general-assistant" }],
    });
  });

  test("it is still administrator-only", async () => {
    // The exemption is from the bot-access check, not from the admin check. The fleet names every
    // Bot in the deployment, which is exactly what a plain user must not be handed.
    const response = await app("user").request("http://t/api/computers/fleet");

    expect(response.status).toBe(403);
  });

  test("a Bot route is still gated", async () => {
    // One named path, not a hole.
    const response = await app().request(
      "http://t/api/computers/some-bot/status",
    );

    expect(response.status).toBe(404);
  });
});

/**
 * 2026-10-17 用户反馈：「bot删除后，这个浏览器居然还在」「没找到哪里可以删除掉这个」。
 * 列表要说出每个浏览器属于谁（已删除的机器人要标明），并且只有没主人的浏览器能在这里删除。
 */
describe("browsers left over from deleted Bots (DESIGN.md §99)", () => {
  function fleetApp(role: "admin" | "user" = "admin") {
    const forgotten: string[] = [];
    const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", { ...ADMIN, role });
      await next();
    };
    const gateway = {
      computers: async () => ({
        isolation: "shared",
        computers: [
          { botId: "agent_gone", running: false, startedAt: null },
          { botId: "agent_live", running: true, startedAt: null },
          { botId: "shared", running: false, startedAt: null },
        ],
      }),
      forgetComputer: async (botId: string) => {
        forgotten.push(botId);
        return { cleared: true };
      },
    } as unknown as ComputerGateway;
    const routes = createComputerRoutes(
      gateway,
      { get: () => ({ mode: "enforce", deny: [], allow: [] }) } as never,
      asActor,
      async () => false,
      undefined,
      undefined,
      async (_actor, botId) => (botId === "agent_live" ? { name: "Asuna" } : null),
    );
    return {
      forgotten,
      hono: new Hono<{ Variables: AppVariables }>().route("/api/computers", routes),
    };
  }
  const forget = (hono: Hono<{ Variables: AppVariables }>, botId: string) =>
    hono.request("http://t/api/computers/fleet-forget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId }),
    });

  test("the fleet names each browser's Bot and marks the left-over ones", async () => {
    const { hono } = fleetApp();
    const body = (await (await hono.request("http://t/api/computers/fleet")).json()) as {
      computers: { botId: string; owner: string; botName?: string }[];
    };
    expect(body.computers).toEqual([
      expect.objectContaining({ botId: "agent_gone", owner: "deleted" }),
      expect.objectContaining({ botId: "agent_live", owner: "bot", botName: "Asuna" }),
      expect.objectContaining({ botId: "shared", owner: "default" }),
    ]);
  });

  test("a left-over browser can be deleted, even though its Bot no longer exists", async () => {
    const { hono, forgotten } = fleetApp();
    const response = await forget(hono, "agent_gone");
    expect(response.status).toBe(200);
    expect(forgotten).toEqual(["agent_gone"]);
  });

  test("a live Bot's browser and the default browser are refused", async () => {
    const { hono, forgotten } = fleetApp();
    expect((await forget(hono, "agent_live")).status).toBe(409);
    expect((await forget(hono, "shared")).status).toBe(409);
    expect((await forget(hono, "../etc")).status).toBe(400);
    expect(forgotten).toEqual([]);
  });

  test("only an administrator may delete one", async () => {
    const { hono, forgotten } = fleetApp("user");
    expect((await forget(hono, "agent_gone")).status).toBe(403);
    expect(forgotten).toEqual([]);
  });
});
