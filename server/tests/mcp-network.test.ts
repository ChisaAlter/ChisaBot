import { afterEach, expect, test } from "bun:test";
import { pinnedMcpFetch } from "../src/plugins/mcp";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function start(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return server;
}

test("MCP connects to the checked address while retaining the endpoint host", async () => {
  let host: string | null = null;
  let body = "";
  const server = start(async (request) => {
    host = request.headers.get("host");
    body = await request.text();
    return Response.json({ ok: true });
  });
  const target = new URL(`http://does-not-resolve.invalid:${server.port}/mcp`);
  const response = await pinnedMcpFetch(target, {
    address: "127.0.0.1",
    family: 4,
  })(target, {
    method: "POST",
    body: '{"jsonrpc":"2.0"}',
  });
  expect(await response.json()).toEqual({ ok: true });
  expect(host).toBe(target.host);
  expect(body).toBe('{"jsonrpc":"2.0"}');
});

test("MCP refuses redirects without sending a named API key to the target", async () => {
  let redirected = 0;
  const destination = start(() => {
    redirected++;
    return Response.json({ ok: true });
  });
  const source = start(() =>
    Response.redirect(`http://127.0.0.1:${destination.port}/steal`, 307),
  );
  const target = new URL(`http://mcp.invalid:${source.port}/mcp`);
  const request = pinnedMcpFetch(target, { address: "127.0.0.1", family: 4 });
  await expect(
    request(target, {
      method: "POST",
      headers: { "x-api-key": "fixture-key" },
      body: "{}",
    }),
  ).rejects.toThrow("redirected");
  // The SDK's independent SSE GET does not inherit requestInit, so it needs the same boundary.
  await expect(
    request(target, { headers: { "x-api-key": "fixture-key" } }),
  ).rejects.toThrow("redirected");
  expect(redirected).toBe(0);
});

test("MCP returns SSE data before the server closes its response", async () => {
  const server = start(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const target = new URL(`http://mcp.invalid:${server.port}/mcp`);
  const response = await pinnedMcpFetch(target, {
    address: "127.0.0.1",
    family: 4,
  })(target);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe("data: hello\n\n");
  await reader.cancel();
});

test("Stop aborts an open MCP response stream", async () => {
  const server = start(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const target = new URL(`http://mcp.invalid:${server.port}/mcp`);
  const controller = new AbortController();
  const response = await pinnedMcpFetch(target, {
    address: "127.0.0.1",
    family: 4,
  })(target, {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  const pending = reader.read();
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(Error);
});
