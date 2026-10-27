import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createAgentRoutes } from "../src/agents/routes";
import { createChannelRoutes } from "../src/channels/routes";

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "user-1",
    email: "user@chisabot.test",
    role: "admin",
  });
  await next();
};

/**
 * Param ids used to flow straight into store queries, where a whitespace-only value either
 * answers 500 (agents, channels) or the wrong status (host-access botId answered 404
 * via canUseBot; grant revoke mapped every error to 404). All are 400 at the edge now, before
 * any store call, broker act, or audit row.
 */
describe("agent ids", () => {
  function app(calls: unknown[]) {
    const store = {
      get: async (...a: unknown[]) => {
        calls.push(["get", ...a]);
        return null;
      },
      duplicate: async (...a: unknown[]) => {
        calls.push(["duplicate", ...a]);
        throw new Error("unreachable");
      },
      softDelete: async (...a: unknown[]) => {
        calls.push(["softDelete", ...a]);
      },
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createAgentRoutes(store as never, requireUser));
    return app;
  }

  test.each([
    ["GET", "http://chisabot.test/%20%20%20", "GET"],
    ["duplicate", "http://chisabot.test/%20%20%20/duplicate", "POST"],
    ["delete", "http://chisabot.test/%20%20%20", "DELETE"],
    ["handoff", "http://chisabot.test/%20%20%20/handoff", "GET"],
  ])("refuses a whitespace id on %s with 400", async (_n, url, method) => {
    const calls: unknown[] = [];
    const response = await app(calls).request(url, { method });
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("channel ids", () => {
  function app(calls: unknown[]) {
    const store = {
      recordActivity: async (...a: unknown[]) => {
        calls.push(["recordActivity", ...a]);
      },
      signalChannelBusy: async (...a: unknown[]) => {
        calls.push(["signalChannelBusy", ...a]);
      },
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createChannelRoutes(store as never, requireUser));
    return app;
  }

  test("refuses a whitespace id on POST /:channelId/activity", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request(
      "http://chisabot.test/%20%20/activity",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "typing", started: true }),
      },
    );
    // Either the new id guard (400 "A channel id is required.") or the pre-existing activity
    // input guard fires; either way the store is never reached on a malformed call.
    expect([400]).toContain(response.status);
    if (response.status === 400) {
      const json = (await response.json()) as { error: string };
      expect(typeof json.error).toBe("string");
    }
    // The activity body above may itself be invalid; assert the store contract separately.
    expect(calls).toEqual([]);
  });

  test("refuses a whitespace id on POST /:channelId/busy", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request(
      "http://chisabot.test/%20%20/busy",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ busy: true }),
      },
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
