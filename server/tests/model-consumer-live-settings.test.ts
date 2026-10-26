import { expect, test } from "bun:test";
import type { RuntimeModelConnection } from "../src/copilot";
import { createChannelTitler } from "../src/channels/titler";

test.each(["title"] as const)(
  "%s uses a complete new model connection on each call, with exact custom endpoint paths",
  async (_kind) => {
    const requests: {
      path: string;
      key: string | null;
      body: Record<string, unknown>;
    }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push({
          path,
          key:
            request.headers.get("authorization") ??
            request.headers.get("x-api-key"),
          body: await request.json(),
        });
        return Response.json(
          path.endsWith("/messages")
            ? { content: [{ type: "text", text: "Launch schedule" }] }
            : { choices: [{ message: { content: "Launch schedule" } }] },
        );
      },
    });
    let connection: RuntimeModelConnection = {
      model: {
        provider: "openai",
        defaultModel: "first-model",
        baseUrl: `${server.url.origin}/custom-api/`,
      },
      apiKey: "first-key",
    };
    let resolutions = 0;
    const resolveConnection = async () => {
      resolutions++;
      return connection;
    };
    const resolveApiKey = async () => {
      throw new Error("legacy key must not be read");
    };
    const title = createChannelTitler({
      model: "stale-model",
      resolveApiKey,
      resolveConnection,
      environment: { OPENAI_BASE_URL: "http://stale.invalid/v1" },
    });
    const call = () => title("Launch discussion");
    try {
      expect(await call()).toBe("Launch schedule");
      connection = {
        model: {
          provider: "anthropic",
          defaultModel: "second-model",
          baseUrl: `${server.url.origin}/native/`,
        },
        apiKey: "second-key",
      };
      expect(await call()).toBe("Launch schedule");
      connection = {
        model: {
          provider: "openai",
          defaultModel: "local-model",
          baseUrl: `${server.url.origin}/local`,
          useApiKey: false,
        },
        apiKey: null,
      };
      expect(await call()).toBe("Launch schedule");
      expect(resolutions).toBe(3);
      expect(
        requests.map(({ path, key, body }) => [path, key, body.model]),
      ).toEqual([
        ["/custom-api/chat/completions", "Bearer first-key", "first-model"],
        ["/native/messages", "second-key", "second-model"],
        ["/local/chat/completions", null, "local-model"],
      ]);
    } finally {
      await server.stop(true);
    }
  },
);

test.each(["title"] as const)(
  "%s honors a live plan snapshot without reading an API credential",
  async (_kind) => {
    const requests: { threadId: string; runId: string; tools: unknown[] }[] =
      [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/model");
        expect(request.headers.get("x-chisabot-agent-token")).toBe(
          "owned-plan-token",
        );
        const input = (await request.json()) as (typeof requests)[number];
        requests.push(input);
        return new Response(
          [
            {
              type: "RUN_STARTED",
              threadId: input.threadId,
              runId: input.runId,
            },
            {
              type: "TEXT_MESSAGE_START",
              messageId: "answer",
              role: "assistant",
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "answer",
              delta: "Launch schedule",
            },
            { type: "TEXT_MESSAGE_END", messageId: "answer" },
            {
              type: "RUN_FINISHED",
              threadId: input.threadId,
              runId: input.runId,
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const connection: RuntimeModelConnection = {
      model: {
        provider: "openai",
        defaultModel: "unused",
        plan: {
          provider: "claude",
          endpoint: new URL("/model", server.url),
          token: "owned-plan-token",
        },
      },
      apiKey: null,
    };
    const common = {
      resolveApiKey: async () => {
        throw new Error("unused legacy credential");
      },
      resolveConnection: async () => connection,
    };
    try {
      const call = () =>
        createChannelTitler({ model: "stale", ...common })("Launch");
      expect(await call()).toBe("Launch schedule");
      expect(await call()).toBe("Launch schedule");
      expect(requests).toHaveLength(2);
      expect(requests[0]!.threadId).not.toBe(requests[1]!.threadId);
      expect(requests.map((request) => request.tools)).toEqual([[], []]);
    } finally {
      await server.stop(true);
    }
  },
);

test.each(["title"] as const)(
  "%s errors disclose only HTTP status, never upstream response bodies",
  async (_kind) => {
    const secret = "synthetic-private-upstream-content";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(secret, { status: 403 }),
    });
    const connection: RuntimeModelConnection = {
      model: {
        provider: "openai",
        defaultModel: "model",
        baseUrl: server.url.origin,
      },
      apiKey: "key",
    };
    const common = {
      resolveApiKey: async () => "key",
      resolveConnection: async () => connection,
      environment: { OPENAI_BASE_URL: `${server.url.origin}/v1` },
    };
    try {
      const error = await createChannelTitler({ model: "stale", ...common })(
        "Launch",
      ).then(
        () => "unexpected success",
        (cause: Error) => cause.message,
      );
      expect(error).toContain("403");
      expect(error).not.toContain(secret);
    } finally {
      await server.stop(true);
    }
  },
);
