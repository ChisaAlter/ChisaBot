import { expect, test } from "bun:test";
import { Hono } from "hono";
import { markEventStreamUnbuffered } from "../src/event-stream-headers";

const app = new Hono();
app.use("/api/conversations/*", markEventStreamUnbuffered);
app.post("/api/conversations/agent/a/run", () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('data: {"type":"RUN_STARTED"}\n\n'),
      );
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
});
app.get("/api/conversations/info", (c) => c.json({ ok: true }));

test("SSE replies tell proxies not to buffer or compress them", async () => {
  const res = await app.request("/api/conversations/agent/a/run", {
    method: "POST",
  });
  expect(res.headers.get("x-accel-buffering")).toBe("no");
  expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(await res.text()).toContain("RUN_STARTED");
});

test("ordinary JSON replies are left alone", async () => {
  const res = await app.request("/api/conversations/info");
  expect(res.headers.get("x-accel-buffering")).toBeNull();
});
