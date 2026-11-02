import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createGroupRoutes,
  type GroupConversations,
  GroupNotFoundError,
  GroupRefusedError,
} from "../src/channels/group";

/**
 * `/api/groups`, restored as the minimal server surface for group handoffs (no UI).
 *
 * The service's behaviour — membership, mention routing, the desk grant — lives in
 * `group-conversations.test.ts` and the integration suite; this file only proves the HTTP shell
 * maps each verb to the right method with the caller's actor, and that the three failure shapes
 * answer the statuses they used to.
 */

function appWith(calls: string[], service?: Partial<GroupConversations>) {
  const stub = {
    create: async (owner: string, input: unknown) => {
      calls.push(`create:${owner}`);
      return { id: "ch-1", ...(input as object) };
    },
    addMember: async (owner: string, channel: string, input: unknown) => {
      calls.push(`addMember:${owner}:${channel}`);
      return input;
    },
    removeMember: async (owner: string, channel: string, userId: string) => {
      calls.push(`removeMember:${owner}:${channel}:${userId}`);
    },
    list: async (owner: string, channel: string) => {
      calls.push(`list:${owner}:${channel}`);
      return { bots: [], people: [], messages: [] };
    },
    send: async (owner: string, channel: string, input: unknown) => {
      calls.push(`send:${owner}:${channel}`);
      return { id: "m-1", queued: true, ...(input as object) };
    },
    ...service,
  } as unknown as GroupConversations;
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: context.req.header("x-test-user") ?? "anon",
      email: "t@chisabot.test",
      role: "user",
    } as never);
    await next();
  };
  return createGroupRoutes(stub, requireUser);
}

describe("/api/groups", () => {
  test("each verb reaches its service method with the caller's actor", async () => {
    const calls: string[] = [];
    const app = appWith(calls);

    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "u-1" },
      body: JSON.stringify({ agentIds: ["ada", "grace"] }),
    });
    expect(created.status).toBe(201);

    const member = await app.request("/ch-1/members", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "u-1" },
      body: JSON.stringify({ email: "g@x.test" }),
    });
    expect(member.status).toBe(201);

    const removed = await app.request("/ch-1/members/u-2", {
      method: "DELETE",
      headers: { "x-test-user": "u-1" },
    });
    expect(removed.status).toBe(204);

    const listed = await app.request("/ch-1", {
      headers: { "x-test-user": "u-1" },
    });
    expect(listed.status).toBe(200);

    const sent = await app.request("/ch-1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "u-1" },
      body: JSON.stringify({ id: "m-1", text: "@Grace hi" }),
    });
    expect(sent.status).toBe(202);

    expect(calls).toEqual([
      "create:u-1",
      "addMember:u-1:ch-1",
      "removeMember:u-1:ch-1:u-2",
      "list:u-1:ch-1",
      "send:u-1:ch-1",
    ]);
  });

  test("membership, refusal and validation failures keep their statuses", async () => {
    const app = appWith([], {
      list: async () => {
        throw new GroupNotFoundError();
      },
      send: async () => {
        throw new GroupRefusedError("That Bot is not in this conversation.");
      },
      create: async () => {
        throw new GroupRefusedError("Each Bot can be in a group once.");
      },
    });

    // A non-member reads exactly what a missing channel reads.
    expect(
      (await app.request("/nope", { headers: { "x-test-user": "u-9" } }))
        .status,
    ).toBe(404);
    expect(
      (
        await app.request("/ch-1", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "m-1", text: "hi" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentIds: ["ada", "ada"] }),
        })
      ).status,
    ).toBe(400);
  });
});
