import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import {
  ANONYMOUS_EGRESS_POLICY,
  ANONYMOUS_LOG_LIMIT,
  ANONYMOUS_LOG_WINDOW_MS,
  botProxyKey,
  egressDecision,
  egressFor,
  egressShellEnvironmentForBot,
  isAlwaysDenied,
  noteAnonymousEgress,
  proxyCallerFrom,
  setEgressLogger,
  setEgressPolicy,
  setEgressResolver,
  startEgressFilter,
  stopEgressFilter,
} from "../src/egress";

function basic(userinfo: string) {
  return `Basic ${Buffer.from(userinfo).toString("base64")}`;
}

describe("proxy credentials: one key per Bot", () => {
  const master = randomBytes(32);

  test("each Bot's key is its own, and proves only that Bot", () => {
    const a = botProxyKey(master, "a");
    const b = botProxyKey(master, "b");
    expect(a).not.toBe(b);
    expect(botProxyKey(master, "a")).toBe(a);
    expect(botProxyKey(randomBytes(32), "a")).not.toBe(a);
    expect(proxyCallerFrom(basic(`a:${a}`), master)).toEqual({
      kind: "bot",
      botId: "a",
    });
    expect(proxyCallerFrom(basic(`b:${b}`), master)).toEqual({
      kind: "bot",
      botId: "b",
    });
  });

  test("no header at all is anonymous, never a Bot", () => {
    expect(proxyCallerFrom(undefined, master)).toEqual({ kind: "anonymous" });
    expect(proxyCallerFrom("", master)).toEqual({ kind: "anonymous" });
  });

  test("an empty password, a wrong one, or A's key for B is rejected, not downgraded", () => {
    const a = botProxyKey(master, "a");
    for (const header of [
      basic("a:"), // empty password (what the shell used to send)
      basic("a"), // no password at all
      basic("a:wrong"),
      basic(`a:${a}x`),
      basic(`a:${a.slice(0, -1)}`),
      basic(`b:${a}`), // A's credentials claiming to be B
      basic(`:${a}`), // no Bot named
      basic(`%20:${a}`), // a Bot id that is only space
      `Bearer ${a}`,
      "Basic",
    ]) {
      expect(proxyCallerFrom(header, master).kind).toBe("rejected");
    }
  });

  test("the browser and the shell are handed the same derived key, never another Bot's", async () => {
    const filter = await startEgressFilter({ env: {}, forShell: true });
    try {
      const a = egressFor("a", {})?.password ?? "";
      const b = egressFor("b", {})?.password ?? "";
      expect(a.length).toBeGreaterThan(20);
      expect(a).not.toBe(b);
      const shell = new URL(egressShellEnvironmentForBot("a").HTTP_PROXY ?? "");
      expect(shell.port).toBe(String(filter.port));
      expect(decodeURIComponent(shell.username)).toBe("a");
      expect(decodeURIComponent(shell.password)).toBe(a);
    } finally {
      await stopEgressFilter();
    }
  });

  test("a restart hands out new keys, so old ones stop working", async () => {
    await startEgressFilter({ env: {} });
    const before = egressFor("a", {})?.password;
    await stopEgressFilter();
    await startEgressFilter({ env: {} });
    const after = egressFor("a", {})?.password;
    await stopEgressFilter();
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });
});

describe("addresses no Bot may reach", () => {
  test("0.0.0.0/8 and 100.64.0.0/10 are always denied", () => {
    for (const address of [
      "0.0.0.0",
      "0.1.2.3",
      "0.255.255.255",
      "100.64.0.0",
      "100.64.0.1",
      "100.100.1.1",
      "100.127.255.255",
      "::ffff:0.0.0.0",
      "::ffff:100.64.0.1",
      "64:ff9b::6440:1", // NAT64 -> 100.64.0.1
    ]) {
      expect(isAlwaysDenied(address)).toBe(true);
    }
    for (const address of [
      "1.0.0.0",
      "99.255.255.255",
      "100.63.255.255",
      "100.128.0.0",
    ]) {
      expect(isAlwaysDenied(address)).toBe(false);
    }
  });

  test("allow_all and an allowlist cannot open them, by address or by name", () => {
    const allowAll = { mode: "allow_all" as const, rules: [] };
    const cidr = {
      mode: "allowlist_only" as const,
      rules: [
        { type: "cidr" as const, value: "0.0.0.0/8" },
        { type: "cidr" as const, value: "100.64.0.0/10" },
        { type: "domain" as const, value: "tailnet.example.test" },
      ],
    };
    for (const host of ["0.0.0.0", "100.64.0.1", "100.101.102.103"]) {
      expect(egressDecision(allowAll, host, 80).allowed).toBe(false);
      expect(egressDecision(cidr, host, 80).allowed).toBe(false);
    }
    expect(
      egressDecision(cidr, "tailnet.example.test", 443, ["100.90.0.7"]).allowed,
    ).toBe(false);
  });

  test("through the filter, under allow_all", async () => {
    const filter = await startEgressFilter({ env: {} });
    try {
      setEgressPolicy("a", { mode: "allow_all", rules: [] });
      const key = egressFor("a", {})?.password ?? "";
      for (const target of [
        "0.0.0.0:80",
        "100.64.0.1:80",
        "100.100.100.100:443",
      ]) {
        const answer = await raw(
          filter.port,
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${basic(`a:${key}`)}\r\n\r\n`,
        );
        expect(answer.split("\r\n")[0]).toContain("403");
      }
    } finally {
      await stopEgressFilter();
    }
  });
});

/** Send one raw request to the filter and read the answer. */
function raw(port: number, request: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let seen = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("timed out")));
    socket.on("data", (chunk) => {
      seen += chunk.toString();
      if (seen.includes("reached") || /^HTTP\/1\.1 403/.test(seen)) {
        if (seen.includes("\r\n\r\n")) socket.end();
      }
    });
    socket.on("end", () => resolve(seen));
    socket.on("close", () => resolve(seen));
    socket.on("error", reject);
  });
}

/**
 * The filter in front of an upstream proxy that answers "reached" for anything it is asked, so what
 * the filter lets through is what the upstream records.
 */
describe("the filter: who may go out as whom", () => {
  let upstream: Server | null = null;
  const asked: string[] = [];
  const logged: string[] = [];

  afterEach(async () => {
    await stopEgressFilter();
    setEgressResolver(null);
    setEgressLogger(null);
    asked.length = 0;
    logged.length = 0;
    const running = upstream;
    upstream = null;
    if (running)
      await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  async function start() {
    upstream = createServer((request, response) => {
      asked.push(request.url ?? "");
      response.end("reached");
    });
    upstream.on("connect", (request: IncomingMessage, socket: Socket) => {
      asked.push(request.url ?? "");
      socket.end("HTTP/1.1 200 Connection Established\r\n\r\nreached");
    });
    const running = upstream;
    await new Promise<void>((resolve) =>
      running.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = running.address();
    const upPort = typeof address === "object" && address ? address.port : 0;
    const filter = await startEgressFilter({
      env: { EGRESS_PROXY_DEFAULT: `http://127.0.0.1:${upPort}` },
    });
    setEgressResolver(
      async (host) =>
        ({
          "site.a.test": ["203.0.113.10"],
          "site.b.test": ["203.0.113.11"],
          "anything.example.test": ["203.0.113.12"],
          "registry.npmjs.org": ["203.0.113.20"],
        })[host] ?? [],
    );
    setEgressLogger((line) => logged.push(line));
    return filter;
  }

  function get(port: number, host: string, auth?: string) {
    const header = auth === undefined ? "" : `Proxy-Authorization: ${auth}\r\n`;
    return raw(
      port,
      `GET http://${host}/ HTTP/1.1\r\nHost: ${host}\r\n${header}Connection: close\r\n\r\n`,
    );
  }

  function tunnel(port: number, target: string, auth?: string) {
    const header = auth === undefined ? "" : `Proxy-Authorization: ${auth}\r\n`;
    return raw(
      port,
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${header}\r\n`,
    );
  }

  test("impersonation: only a Bot's own key gets that Bot's policy", async () => {
    const filter = await start();
    setEgressPolicy("a", {
      mode: "allowlist_only",
      rules: [{ type: "domain", value: "site.a.test" }],
    });
    setEgressPolicy("b", {
      mode: "allowlist_only",
      rules: [{ type: "domain", value: "site.b.test" }],
    });
    const keyA = egressFor("a", {})?.password ?? "";
    const keyB = egressFor("b", {})?.password ?? "";

    // Correct credentials: each Bot reaches its own allowlist, and only that.
    expect(await get(filter.port, "site.a.test", basic(`a:${keyA}`))).toContain(
      "reached",
    );
    expect(await get(filter.port, "site.b.test", basic(`b:${keyB}`))).toContain(
      "reached",
    );
    expect(await get(filter.port, "site.b.test", basic(`a:${keyA}`))).toContain(
      "403",
    );
    expect(
      await tunnel(filter.port, "site.a.test:443", basic(`a:${keyA}`)),
    ).toContain("reached");
    expect(asked).toEqual([
      "http://site.a.test/",
      "http://site.b.test/",
      "site.a.test:443",
    ]);
    asked.length = 0;

    // Empty password, wrong password, A's key claiming B: refused, plain HTTP and CONNECT alike.
    for (const auth of [
      basic("b:"),
      basic("b"),
      basic("b:not-the-key"),
      basic(`b:${keyA}`),
      `Bearer ${keyB}`,
    ]) {
      expect(
        (await get(filter.port, "site.b.test", auth)).split("\r\n")[0],
      ).toContain("403");
      expect(
        (await tunnel(filter.port, "site.b.test:443", auth)).split("\r\n")[0],
      ).toContain("403");
    }
    expect(asked).toEqual([]);
    // A refused credential is not anonymous traffic either, and nothing logged carries a key.
    expect(logged).toEqual([]);
  });

  test("no credentials: the independent fallback, which matches no Bot's allowlist", async () => {
    const filter = await start();
    setEgressPolicy("a", {
      mode: "defaults_plus_allowlist",
      rules: [{ type: "domain", value: "site.a.test" }],
    });
    setEgressPolicy("b", { mode: "allow_all", rules: [] });
    expect(ANONYMOUS_EGRESS_POLICY.rules).toEqual([]);

    // A's allowlist and B's allow_all are not anonymous's.
    expect(await get(filter.port, "site.a.test")).toContain("403");
    expect(await get(filter.port, "anything.example.test")).toContain("403");
    expect(await tunnel(filter.port, "site.a.test:443")).toContain("403");
    // The fallback's own defaults (package registries) do go out.
    expect(await get(filter.port, "registry.npmjs.org")).toContain("reached");
    expect(await tunnel(filter.port, "registry.npmjs.org:443")).toContain(
      "reached",
    );
    expect(asked).toEqual([
      "http://registry.npmjs.org/",
      "registry.npmjs.org:443",
    ]);

    // Stripping credentials never gets a stricter Bot more than it has.
    setEgressPolicy("c", {
      mode: "allowlist_only",
      rules: [{ type: "domain", value: "registry.npmjs.org" }],
    });
    expect(await get(filter.port, "registry.npmjs.org")).toContain("403");
    setEgressPolicy("c", { mode: "deny_all", rules: [] });
    expect(await tunnel(filter.port, "registry.npmjs.org:443")).toContain(
      "403",
    );
    // The private-net floor holds for anonymous too.
    setEgressPolicy("c", null);
    expect(await tunnel(filter.port, "100.64.0.1:443")).toContain("403");
  });

  test("anonymous connections are logged with where they came from, throttled, without a key", async () => {
    const filter = await start();
    setEgressPolicy("a", { mode: "defaults_plus_allowlist", rules: [] });
    const keyA = egressFor("a", {})?.password ?? "";
    // A Bot's own traffic is not logged as anonymous.
    await get(filter.port, "registry.npmjs.org", basic(`a:${keyA}`));
    expect(logged).toEqual([]);

    for (let i = 0; i < ANONYMOUS_LOG_LIMIT + 3; i += 1) {
      await get(filter.port, "site.a.test");
    }
    expect(logged.length).toBe(ANONYMOUS_LOG_LIMIT);
    for (const line of logged) {
      const entry = JSON.parse(line);
      expect(entry.code).toBe("EGRESS_ANONYMOUS");
      expect(entry.via).toBe("HTTP");
      expect(entry.target).toBe("site.a.test:80");
      expect(entry.from).toMatch(/^(::ffff:)?127\.0\.0\.1:\d+$/);
      expect(line).not.toContain(keyA);
      expect(line.toLowerCase()).not.toContain("authorization");
    }
  });
});

describe("the anonymous log's throttle", () => {
  afterEach(() => setEgressLogger(null));

  test("a few lines per window, then a count carried into the next window", () => {
    const lines: string[] = [];
    setEgressLogger((line) => lines.push(line));
    const source = {
      via: "CONNECT" as const,
      target: "x.test:443",
      from: "127.0.0.1:5000",
    };
    const start = 1_000_000;
    const written = Array.from({ length: ANONYMOUS_LOG_LIMIT + 4 }, (_, i) =>
      noteAnonymousEgress(source, start + i),
    );
    expect(written.filter(Boolean).length).toBe(ANONYMOUS_LOG_LIMIT);
    expect(written.slice(ANONYMOUS_LOG_LIMIT).every((w) => !w)).toBe(true);
    expect(lines.length).toBe(ANONYMOUS_LOG_LIMIT);
    expect(lines.some((line) => line.includes("suppressedSinceLastLine"))).toBe(
      false,
    );

    // Still inside the window: still quiet.
    expect(
      noteAnonymousEgress(source, start + ANONYMOUS_LOG_WINDOW_MS - 1),
    ).toBe(false);
    // The next window opens with how many were held back.
    expect(noteAnonymousEgress(source, start + ANONYMOUS_LOG_WINDOW_MS)).toBe(
      true,
    );
    const next = JSON.parse(lines.at(-1) ?? "{}");
    expect(next.suppressedSinceLastLine).toBe(5);
    expect(next.target).toBe("x.test:443");
    expect(next.from).toBe("127.0.0.1:5000");
  });
});
