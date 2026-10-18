/**
 * PRD-P1-06 — CI red-line SSRF suite.
 *
 * Must stay green on every PR (wired in .github/workflows/chisabot.yml).
 * Covers: redirect→internal, IPv4-mapped / NAT64 IPv6 forms, hostname floor.
 * Address-table unit coverage also lives in link-preview.test.ts; this file is the
 * explicit red-line gate so a selective CI job cannot silently drop it.
 */

import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { BlockedUrlError, guardedFetch } from "../../shared/net/guarded-fetch";
import {
  checkPublicUrl,
  embeddedIpv4,
  isBlockedAddress,
  isBlockedHostname,
} from "../../shared/net/ssrf";
import { OPS_CODES } from "../../shared/ops-codes";
import {
  opsCounterSnapshot,
  resetOpsCountersForTests,
} from "../../shared/ops-counters";

describe("SSRF red-line: address / hostname floor", () => {
  test("metadata, RFC1918, loopback, CGNAT blocked", () => {
    for (const ip of [
      "169.254.169.254",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "127.0.0.1",
      "100.100.100.200",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
      expect(checkPublicUrl(`http://${ip}/`).ok).toBe(false);
    }
  });

  test("mapped IPv6 forms extract and block embedded private IPv4", () => {
    expect(embeddedIpv4("::ffff:10.0.0.5")).toBe("10.0.0.5");
    expect(embeddedIpv4("::ffff:a9fe:a9fe")).toBe("169.254.169.254");
    expect(embeddedIpv4("64:ff9b::a9fe:a9fe")).toBe("169.254.169.254");
    expect(isBlockedAddress("::ffff:10.0.0.5")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("64:ff9b::10.1.2.3")).toBe(true);
    expect(checkPublicUrl("http://[::ffff:10.0.0.5]/").ok).toBe(false);
    expect(checkPublicUrl("http://[::ffff:169.254.169.254]/latest/").ok).toBe(
      false,
    );
    expect(checkPublicUrl("http://[64:ff9b::a9fe:a9fe]/").ok).toBe(false);
    // Public mapped address still allowed at the IP layer.
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  test("6to4 / Teredo tunnels blocked wholesale", () => {
    expect(isBlockedAddress("2002:7f00:1::1")).toBe(true);
    expect(isBlockedAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(true);
  });

  test("localhost / single-label / .internal hostnames blocked", () => {
    for (const host of [
      "localhost",
      "metadata.google.internal",
      "db",
      "nas.lan",
    ]) {
      expect(isBlockedHostname(host)).toBe(true);
    }
  });
});

describe("SSRF red-line: redirect must not follow into private space", () => {
  async function withRedirectServer(
    location: string,
    run: (origin: string) => Promise<void>,
  ) {
    const server = createServer((_req, res) => {
      res.writeHead(302, { Location: location });
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  const allowLoopbackOnly = {
    maxBytes: 4_096,
    timeoutMs: 5_000,
    isBlocked: (address: string) =>
      address !== "127.0.0.1" && isBlockedAddress(address),
    resolve: async () => [{ address: "127.0.0.1", family: 4 as const }],
  };

  test("302 → cloud metadata refused", async () => {
    await withRedirectServer(
      "http://169.254.169.254/latest/meta-data/",
      async (origin) => {
        await expect(
          guardedFetch(`${origin}/start`, allowLoopbackOnly),
        ).rejects.toBeInstanceOf(BlockedUrlError);
      },
    );
  });

  test("302 → RFC1918 refused", async () => {
    await withRedirectServer("http://10.0.0.5/secret", async (origin) => {
      await expect(
        guardedFetch(`${origin}/go`, allowLoopbackOnly),
      ).rejects.toBeInstanceOf(BlockedUrlError);
    });
  });

  test("302 → IPv4-mapped metadata refused", async () => {
    await withRedirectServer(
      "http://[::ffff:169.254.169.254]/latest/",
      async (origin) => {
        await expect(
          guardedFetch(`${origin}/map`, allowLoopbackOnly),
        ).rejects.toBeInstanceOf(BlockedUrlError);
      },
    );
  });

  test("302 → IPv4-mapped RFC1918 refused", async () => {
    await withRedirectServer("http://[::ffff:10.1.2.3]/", async (origin) => {
      await expect(
        guardedFetch(`${origin}/map10`, allowLoopbackOnly),
      ).rejects.toBeInstanceOf(BlockedUrlError);
    });
  });
});

describe("SSRF red-line: budget counter bumps on deny", () => {
  test("BlockedUrlError path increments SSRF_DENIED", async () => {
    resetOpsCountersForTests();
    await expect(
      guardedFetch("http://169.254.169.254/", {
        maxBytes: 1024,
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    const snap = opsCounterSnapshot();
    expect(snap.totals[OPS_CODES.SSRF_DENIED]).toBeGreaterThanOrEqual(1);
  });
});
