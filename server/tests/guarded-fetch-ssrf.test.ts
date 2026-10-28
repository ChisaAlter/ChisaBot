import { createServer } from "node:http";
import { describe, expect, test } from "bun:test";
import { BlockedUrlError, guardedFetch } from "../../shared/net/guarded-fetch";
import { isBlockedAddress } from "../../shared/net/ssrf";

/**
 * CR-P0-01：公网（或测试里放行的本机）URL 若 302 到内网 / 元数据，guardedFetch 必须在跟跳前拒绝。
 * 旧的 assertPublicUrl + redirect:follow 会跟过去。
 */
describe("guardedFetch SSRF redirects", () => {
  test("refuses a 302 to the cloud metadata address", async () => {
    const server = createServer((req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await expect(
        guardedFetch(`http://127.0.0.1:${port}/start`, {
          maxBytes: 4_096,
          timeoutMs: 5_000,
          // 本测只关心重定向目标；允许连本机测试服务器。
          isBlocked: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
          resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        }),
      ).rejects.toBeInstanceOf(BlockedUrlError);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test("refuses a 302 to RFC1918", async () => {
    const server = createServer((req, res) => {
      res.writeHead(302, { Location: "http://10.0.0.5/secret" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await expect(
        guardedFetch(`http://127.0.0.1:${port}/go`, {
          maxBytes: 4_096,
          timeoutMs: 5_000,
          isBlocked: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
          resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        }),
      ).rejects.toBeInstanceOf(BlockedUrlError);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test("strips authorization, cookie, and proxy-authorization on cross-origin redirect", async () => {
    let secondHopHeaders: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      const host = req.headers.host ?? "";
      if (host.startsWith("origin-a.example")) {
        const { port } = server.address() as { port: number };
        res.writeHead(302, { Location: `http://origin-b.example:${port}/land` });
        res.end();
        return;
      }
      secondHopHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const res = await guardedFetch(`http://origin-a.example:${port}/start`, {
        maxBytes: 4_096,
        timeoutMs: 5_000,
        headers: {
          Authorization: "Bearer secret-token",
          Cookie: "sid=123",
          "Proxy-Authorization": "Basic abc",
          "X-Custom": "keep-me",
        },
        isBlocked: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      });
      expect(res.status).toBe(200);
      expect(secondHopHeaders.authorization).toBeUndefined();
      expect(secondHopHeaders.cookie).toBeUndefined();
      expect(secondHopHeaders["proxy-authorization"]).toBeUndefined();
      expect(secondHopHeaders["x-custom"]).toBe("keep-me");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test("downgrades POST to GET and clears body/content headers on 301/302/303 redirect", async () => {
    let secondHopMethod = "";
    let secondHopBody = "";
    let secondHopHeaders: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      if (req.url === "/post-start") {
        res.writeHead(302, { Location: "/after-post" });
        res.end();
        return;
      }
      secondHopMethod = req.method ?? "";
      secondHopHeaders = req.headers;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        secondHopBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("done");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const res = await guardedFetch(`http://origin-a.example:${port}/post-start`, {
        method: "POST",
        body: JSON.stringify({ secret: 1 }),
        headers: { "Content-Type": "application/json" },
        maxBytes: 4_096,
        timeoutMs: 5_000,
        isBlocked: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      });
      expect(res.status).toBe(200);
      expect(secondHopMethod).toBe("GET");
      expect(secondHopBody).toBe("");
      expect(secondHopHeaders["content-type"]).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
