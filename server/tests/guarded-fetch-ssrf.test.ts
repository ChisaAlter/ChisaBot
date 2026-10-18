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
});
