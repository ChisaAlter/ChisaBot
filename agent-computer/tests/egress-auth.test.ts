import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import {
  ANONYMOUS_EGRESS_POLICY,
  ANONYMOUS_LOG_LIMIT,
  ANONYMOUS_LOG_WINDOW_MS,
  botProxyKey,
  classifyEgressTunnel,
  egressDecision,
  egressFor,
  egressShellEnvironmentForBot,
  isAlwaysDenied,
  isPrivateEgressHost,
  noteAnonymousEgress,
  proxyCallerFrom,
  recentEgressOutcome,
  setEgressLogger,
  setEgressPolicy,
  setEgressResolver,
  setEgressTimeouts,
  startEgressFilter,
  stopEgressFilter,
} from "../src/egress";
import { navigationProblem } from "../src/screencast";

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

  test("IPv6 unspecified, mapped and compatible forms match the navigation floor", () => {
    for (const address of [
      "::",
      "[::]",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:a9fe:a9fe", // 169.254.169.254
      "::7f00:1", // deprecated compatible [::127.0.0.1]
      "64:ff9b::7f00:1",
      "fd00::1",
      "fe80::1",
      "fd00:ec2::254",
    ]) {
      expect(isAlwaysDenied(address)).toBe(true);
    }
    expect(isPrivateEgressHost("localhost")).toBe(true);
    expect(isPrivateEgressHost("app.localhost")).toBe(true);
    expect(isAlwaysDenied("2001:db8::1")).toBe(false);
    expect(isPrivateEgressHost("example.com")).toBe(false);
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
  test("unspecified IPv6 [::] is refused under allow_all (SSRF floor)", async () => {
    const filter = await startEgressFilter({ env: {} });
    try {
      setEgressPolicy("a", { mode: "allow_all", rules: [] });
      const key = egressFor("a", {})?.password ?? "";
      for (const auth of [undefined, basic(`a:${key}`)]) {
        const header = auth ? `Proxy-Authorization: ${auth}\r\n` : "";
        const answer = await raw(
          filter.port,
          `CONNECT [::]:80 HTTP/1.1\r\nHost: [::]:80\r\n${header}\r\n`,
        );
        expect(answer.split("\r\n")[0]).toContain("403");
      }
      expect(await classifyEgressTunnel("::", 80)).toBe("private");
      expect(await classifyEgressTunnel("192.168.1.1", 443)).toBe("private");
    } finally {
      await stopEgressFilter();
    }
  });

  test("IPv6 zone ids cannot bypass the floor (CONNECT and isAlwaysDenied)", async () => {
    // QA512 r2 P2: Bun BlockList.check misses `::1%lo`; strip zone before judging/connecting.
    for (const address of [
      "::1%lo",
      "::1%25lo",
      "::%lo",
      "[::1%lo]",
      "fe80::1%eth0",
      "fd00::1%eth0",
      "0:0:0:0:0:0:0:1%lo",
    ]) {
      expect(isAlwaysDenied(address)).toBe(true);
    }
    const filter = await startEgressFilter({ env: {} });
    try {
      setEgressPolicy("a", { mode: "allow_all", rules: [] });
      const key = egressFor("a", {})?.password ?? "";
      for (const host of [
        "[::1%lo]",
        "[::1%25lo]",
        "[::%lo]",
        "[fe80::1%eth0]",
        "[fd00::1%eth0]",
        "[0:0:0:0:0:0:0:1%lo]",
      ]) {
        for (const auth of [undefined, basic(`a:${key}`)]) {
          const header = auth ? `Proxy-Authorization: ${auth}\r\n` : "";
          const answer = await raw(
            filter.port,
            `CONNECT ${host}:80 HTTP/1.1\r\nHost: ${host}:80\r\n${header}\r\n`,
          );
          expect(answer.split("\r\n")[0]).toContain("403");
          expect(answer).toContain("x-chisabot-egress-class: private");
          expect(answer).toContain("出于安全原因不允许访问内网地址。");
        }
      }
    } finally {
      await stopEgressFilter();
    }
  });

  test("local NAT64, 6to4 and deprecated site-local are on the floor", () => {
    for (const address of [
      "64:ff9b:1::1",
      "64:ff9b:1:0:0:0:7f00:1",
      "2002:c0a8:0001::1",
      "2002::",
      "fec0::1",
      "fed0::1",
    ]) {
      expect(isAlwaysDenied(address)).toBe(true);
    }
    // 6to4 carrying a public IPv4 is not on the floor (only the embedded IPv4 decides).
    for (const address of [
      "2002:0808:0808::1", // 8.8.8.8
      "2002:808:808::",
      "2002:0101:0101::1", // 1.1.1.1
      "2002:5db8:d822::1",
    ]) {
      expect(isAlwaysDenied(address)).toBe(false);
    }
    // Well-known NAT64 to a public IPv4 stays allowed (embedded check, not the local /48).
    expect(isAlwaysDenied("64:ff9b::808:808")).toBe(false);
    expect(isAlwaysDenied("2001:4860:4860::8888")).toBe(false);
  });

  test("6to4 is judged by the IPv4 it carries: private / reserved refused, public allowed", async () => {
    for (const address of [
      "2002:0a00:0001::1", // 10.0.0.1
      "2002:7f00:0001::", // 127.0.0.1
      "2002:a9fe:a9fe::1", // 169.254.169.254 (metadata)
      "2002:6440:0001::1", // 100.64.0.1
      "2002:ac10:0001::1", // 172.16.0.1
      "2002:6464:64c8::", // 100.100.100.200
      "2002:c000:0201::1", // 192.0.2.1 (TEST-NET-1)
      "2002:c058:6301::1", // 192.88.99.1 (6to4 relay)
      "2002:e000:0001::1", // 224.0.0.1 (multicast)
      "2002:ffff:ffff::1", // 255.255.255.255
      "2002:C0A8:0001:0000:0000:0000:0000:0001", // upper-case, full form
      "2002:7f00:1::%lo", // zone id
    ]) {
      expect(isAlwaysDenied(address)).toBe(true);
    }
    const allowAll = { mode: "allow_all" as const, rules: [] };
    expect(egressDecision(allowAll, "2002:808:808::1", 443).allowed).toBe(true);
    expect(egressDecision(allowAll, "[2002:808:808::1]", 443).allowed).toBe(
      true,
    );
    expect(egressDecision(allowAll, "2002:a00:1::1", 443).denyClass).toBe(
      "private",
    );
    // A name resolving to private-carrying 6to4 is refused too.
    expect(
      egressDecision(allowAll, "sixtofour.test", 443, ["2002:c0a8:1::1"])
        .allowed,
    ).toBe(false);
    const filter = await startEgressFilter({ env: {} });
    try {
      setEgressPolicy("a", allowAll);
      const answer = await raw(
        filter.port,
        "CONNECT [2002:a00:1::1]:443 HTTP/1.1\r\nHost: [2002:a00:1::1]:443\r\n\r\n",
      );
      expect(answer.split("\r\n")[0]).toContain("403");
      expect(answer).toContain("x-chisabot-egress-class: private");
    } finally {
      await stopEgressFilter();
    }
  });

  test("HTTP deny pages are Chinese and unresolved is not called policy", async () => {
    const filter = await startEgressFilter({ env: {} });
    try {
      setEgressPolicy("a", { mode: "deny_all", rules: [] });
      const key = egressFor("a", {})?.password ?? "";
      const policy = await raw(
        filter.port,
        `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: ${basic(`a:${key}`)}\r\nConnection: close\r\n\r\n`,
      );
      expect(policy.split("\r\n")[0]).toContain("403");
      expect(policy).toContain("网络策略不允许访问这个网址。");
      expect(policy).toContain("x-chisabot-egress-class: refused");

      setEgressPolicy("a", { mode: "allow_all", rules: [] });
      const priv = await raw(
        filter.port,
        `GET http://10.0.0.1/ HTTP/1.1\r\nHost: 10.0.0.1\r\nProxy-Authorization: ${basic(`a:${key}`)}\r\nConnection: close\r\n\r\n`,
      );
      expect(priv).toContain("出于安全原因不允许访问内网地址。");
      expect(priv).toContain("x-chisabot-egress-class: private");

      setEgressResolver(async () => {
        throw new Error("ENOTFOUND");
      });
      const miss = await raw(
        filter.port,
        `GET http://nope.invalid/ HTTP/1.1\r\nHost: nope.invalid\r\nProxy-Authorization: ${basic(`a:${key}`)}\r\nConnection: close\r\n\r\n`,
      );
      expect(miss).toContain("连不上这个网址。");
      expect(miss).toContain("x-chisabot-egress-class: unresolved");
      expect(await classifyEgressTunnel("nope.invalid", 80)).toBe(
        "unreachable",
      );
    } finally {
      setEgressResolver(null);
      await stopEgressFilter();
    }
  });

  test("tightening policy drops an already-open CONNECT tunnel", async () => {
    const origin = createServer((_req, res) => {
      res.writeHead(200);
      res.write("keep");
    });
    await new Promise<void>((resolve) =>
      origin.listen(0, "127.0.0.1", resolve),
    );
    const originPort =
      typeof origin.address() === "object" && origin.address()
        ? (origin.address() as { port: number }).port
        : 0;
    // Public doc address via mock: serve on 127.0.0.1 but tell filter the name resolves to a
    // non-ALWAYS_DENIED address we pin... actually ALWAYS_DENIED blocks loopback. Use an upstream
    // mock: start filter with EGRESS_POLICY_REQUIRED=0 and allow_all, connect to a reachable public
    // host is flaky. Instead open a CONNECT that succeeds to a local TCP we expose by temporarily
    // allowing through a name pinned to 127.0.0.1 — that is refused by floor.
    //
    // So: run a second plain TCP echo on a non-loopback? Simplest: use allow_all + connect to the
    // filter's own ability by tunneling to example.com is network-dependent.
    // Unit-level: open CONNECT to 203.0.113.1 (TEST-NET, will 502) is not an open tunnel.
    // Better: listen on 127.0.0.1, set EGRESS_POLICY_REQUIRED=0, and patch is not available.
    // Track by connecting through an upstream that accepts CONNECT to anything.
    const upstreamHits: string[] = [];
    const upstream = createServer();
    upstream.on("connect", (req, client, head) => {
      upstreamHits.push(req.url ?? "");
      // Bridge to the origin.
      const remote = connect(originPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        remote.pipe(client);
        client.pipe(remote);
      });
      remote.on("error", () => client.destroy());
      client.on("error", () => remote.destroy());
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const upPort =
      typeof upstream.address() === "object" && upstream.address()
        ? (upstream.address() as { port: number }).port
        : 0;

    const filter = await startEgressFilter({
      env: { EGRESS_PROXY_DEFAULT: `http://127.0.0.1:${upPort}` },
    });
    try {
      setEgressPolicy("a", { mode: "allow_all", rules: [] });
      const key = egressFor("a", {})?.password ?? "";
      const tunnel = await new Promise<{
        socket: ReturnType<typeof connect>;
        head: string;
      }>((resolve, reject) => {
        const socket = connect(filter.port, "127.0.0.1", () => {
          socket.write(
            `CONNECT example.com:80 HTTP/1.1\r\nHost: example.com:80\r\nProxy-Authorization: ${basic(`a:${key}`)}\r\n\r\n`,
          );
        });
        let seen = "";
        socket.on("data", (chunk) => {
          seen += chunk.toString();
          if (seen.includes("\r\n\r\n")) {
            resolve({ socket, head: seen });
          }
        });
        socket.on("error", reject);
        socket.setTimeout(5_000, () => reject(new Error("tunnel timeout")));
      });
      expect(tunnel.head.split("\r\n")[0]).toContain("200");
      expect(upstreamHits.length).toBe(1);

      let closed = false;
      tunnel.socket.on("close", () => {
        closed = true;
      });
      setEgressPolicy("a", { mode: "deny_all", rules: [] });
      await new Promise((r) => setTimeout(r, 50));
      expect(closed).toBe(true);
    } finally {
      await stopEgressFilter();
      await new Promise<void>((r) => upstream.close(() => r()));
      await new Promise<void>((r) => origin.close(() => r()));
    }
  });
});

/**
 * A policy change cuts only the tunnels it now refuses: the Bot whose policy changed, to targets
 * the new policy refuses; anonymous only when the strictest-Bot fallback itself got stricter.
 */
describe("policy changes cut only the tunnels they now refuse", () => {
  let upstream: Server | null = null;
  let upstreamPort = 0;

  afterEach(async () => {
    setEgressResolver(null);
    setEgressLogger(null);
    await stopEgressFilter();
    if (upstream) await new Promise<void>((r) => upstream?.close(() => r()));
    upstream = null;
  });

  /** An upstream that holds every CONNECT open, so a tunnel only closes when the filter cuts it. */
  async function holdingUpstream() {
    upstream = createServer();
    upstream.on("connect", (_req, client: Socket) => {
      client.on("error", () => undefined);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    await new Promise<void>((r) => upstream?.listen(0, "127.0.0.1", r));
    const address = upstream.address();
    upstreamPort = typeof address === "object" && address ? address.port : 0;
  }

  type Open = { closed: () => boolean; head: string; socket: Socket };

  function open(port: number, target: string, auth?: string): Promise<Open> {
    return new Promise((resolve, reject) => {
      let closed = false;
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
        );
      });
      let seen = "";
      socket.on("data", (chunk) => {
        seen += chunk.toString();
        if (seen.includes("\r\n\r\n"))
          resolve({ closed: () => closed, head: seen, socket });
      });
      socket.on("close", () => {
        closed = true;
      });
      socket.on("error", () => undefined);
      socket.setTimeout(5_000, () => reject(new Error("tunnel timeout")));
    });
  }

  const settle = () => new Promise((r) => setTimeout(r, 60));

  async function filterWithBots() {
    await holdingUpstream();
    setEgressLogger(() => undefined);
    // Public addresses, so the private-net floor never decides these cases.
    setEgressResolver(async () => ["93.184.215.14"]);
    const filter = await startEgressFilter({
      env: { EGRESS_PROXY_DEFAULT: `http://127.0.0.1:${upstreamPort}` },
    });
    setEgressPolicy("bot-a", { mode: "allow_all", rules: [] });
    setEgressPolicy("bot-b", { mode: "allow_all", rules: [] });
    const a = basic(`bot-a:${egressFor("bot-a", {})?.password ?? ""}`);
    const b = basic(`bot-b:${egressFor("bot-b", {})?.password ?? ""}`);
    const tunnelTo = async (target: string, auth?: string) => {
      const t = await open(filter.port, target, auth);
      expect(t.head.split("\r\n")[0]).toContain("200");
      return t;
    };
    return { filter, a, b, tunnelTo };
  }

  test("tightening bot-a cuts bot-a's tunnels and anonymous (strictest got stricter), not bot-b's", async () => {
    const { a, b, tunnelTo } = await filterWithBots();
    const ta = await tunnelTo("example.com:443", a);
    const tb = await tunnelTo("example.com:443", b);
    const anon = await tunnelTo("example.com:443");
    setEgressPolicy("bot-a", { mode: "deny_all", rules: [] });
    await settle();
    expect(ta.closed()).toBe(true);
    expect(tb.closed()).toBe(false);
    expect(anon.closed()).toBe(true);
    tb.socket.destroy();
  });

  test("loosening or rewriting the same policy cuts nobody", async () => {
    const { a, b, tunnelTo } = await filterWithBots();
    setEgressPolicy("bot-a", {
      mode: "defaults_plus_allowlist",
      rules: [{ type: "domain", value: "keep.test" }],
    });
    const ta = await tunnelTo("keep.test:443", a);
    const tb = await tunnelTo("example.com:443", b);
    const anon = await tunnelTo("registry.npmjs.org:443");
    // Same policy again, then looser: nothing may close.
    setEgressPolicy("bot-a", {
      mode: "defaults_plus_allowlist",
      rules: [{ type: "domain", value: "keep.test" }],
    });
    setEgressPolicy("bot-a", { mode: "allow_all", rules: [] });
    setEgressPolicy("bot-b", { mode: "allow_all", rules: [] });
    await settle();
    expect([ta.closed(), tb.closed(), anon.closed()]).toEqual([
      false,
      false,
      false,
    ]);
    for (const t of [ta, tb, anon]) t.socket.destroy();
  });

  test("a tighter allowlist cuts only the targets it no longer allows", async () => {
    const { a, b, tunnelTo } = await filterWithBots();
    const keep = await tunnelTo("keep.test:443", a);
    const drop = await tunnelTo("other.test:443", a);
    const tb = await tunnelTo("other.test:443", b);
    setEgressPolicy("bot-a", {
      mode: "allowlist_only",
      rules: [{ type: "domain", value: "keep.test" }],
    });
    await settle();
    expect(keep.closed()).toBe(false);
    expect(drop.closed()).toBe(true);
    expect(tb.closed()).toBe(false);
    for (const t of [keep, tb]) t.socket.destroy();
  });

  test("anonymous is judged again only when the strictest result changes", async () => {
    const { a, b, tunnelTo } = await filterWithBots();
    // bot-a → defaults_plus_allowlist: anonymous drops to the package registries.
    const registry = await tunnelTo("registry.npmjs.org:443");
    const site = await tunnelTo("example.com:443");
    setEgressPolicy("bot-a", { mode: "defaults_plus_allowlist", rules: [] });
    await settle();
    expect(registry.closed()).toBe(false);
    expect(site.closed()).toBe(true);
    // bot-b tightens too, but anonymous is still "registries only": its tunnel stays, bot-a's too.
    const ta = await tunnelTo("github.com:443", a);
    setEgressPolicy("bot-b", {
      mode: "defaults_plus_allowlist",
      rules: [{ type: "domain", value: "b.test" }],
    });
    await settle();
    expect(registry.closed()).toBe(false);
    expect(ta.closed()).toBe(false);
    // b's own tunnel opened under the new policy, then b's policy deleted: only b's is cut.
    const tb = await tunnelTo("b.test:443", b);
    setEgressPolicy("bot-b", null);
    await settle();
    expect(tb.closed()).toBe(true);
    expect(ta.closed()).toBe(false);
    expect(registry.closed()).toBe(false);
    for (const t of [registry, ta]) t.socket.destroy();
  });
});

/**
 * A DNS failure and a timeout are different answers: "连不上" for a name that does not resolve (or a
 * lookup that never answers), "网站没有响应" only when dialling / the response really timed out.
 */
describe("DNS failure vs timeout", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    setEgressResolver(null);
    setEgressTimeouts(null);
    setEgressLogger(null);
    await stopEgressFilter();
    for (const server of servers.splice(0))
      await new Promise<void>((r) => server.close(() => r()));
  });

  /** An upstream proxy that accepts the connection and never answers anything. */
  async function silentUpstream() {
    const held: Socket[] = [];
    const server = createServer();
    server.on("connect", (_req, client: Socket) => {
      client.on("error", () => undefined);
      held.push(client);
    });
    server.on("request", () => undefined);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    server.on("close", () => {
      for (const socket of held) socket.destroy();
    });
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  /**
   * Read one answer up to its Content-Length. Bun 1.3.x keeps the client connection open after
   * `response.end()` while the request is still piped, so waiting for close would hang.
   */
  function completeAnswer(port: number, request: string) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(request));
      let seen = Buffer.alloc(0);
      const done = () => {
        socket.destroy();
        resolve(seen.toString());
      };
      socket.setTimeout(5_000, () => socket.destroy(new Error("timed out")));
      socket.on("data", (chunk: Buffer) => {
        seen = Buffer.concat([seen, chunk]);
        const end = seen.indexOf("\r\n\r\n");
        if (end === -1) return;
        const length = /content-length:\s*(\d+)/i.exec(
          seen.subarray(0, end).toString(),
        )?.[1];
        if (length !== undefined && seen.length - end - 4 >= Number(length))
          done();
      });
      socket.on("close", () => resolve(seen.toString()));
      socket.on("error", reject);
    });
  }

  async function filterFor(env: Record<string, string> = {}) {
    setEgressLogger(() => undefined);
    const filter = await startEgressFilter({ env });
    setEgressPolicy("a", { mode: "allow_all", rules: [] });
    const auth = basic(`a:${egressFor("a", {})?.password ?? ""}`);
    return { filter, auth };
  }

  test("a name that does not resolve: 403 unresolved, and the live screen says 连不上", async () => {
    setEgressResolver(async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const { filter, auth } = await filterFor();
    const answer = await raw(
      filter.port,
      `CONNECT nope.invalid:443 HTTP/1.1\r\nHost: nope.invalid:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    expect(answer).toContain("x-chisabot-egress-class: unresolved");
    expect(recentEgressOutcome("nope.invalid", 443)).toBe("unresolved");
    expect(
      await navigationProblem(
        new Error("net::ERR_TUNNEL_CONNECTION_FAILED at https://nope.invalid/"),
        "https://nope.invalid/",
      ),
    ).toBe("连不上这个网址。");
  });

  test("a lookup that never answers is a DNS failure (unresolved), not a timeout page", async () => {
    setEgressTimeouts({ lookupMs: 50 });
    setEgressResolver(() => new Promise<string[]>(() => undefined));
    const { filter, auth } = await filterFor();
    const answer = await raw(
      filter.port,
      `CONNECT slow-dns.test:443 HTTP/1.1\r\nHost: slow-dns.test:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    expect(answer.split("\r\n")[0]).toContain("403");
    expect(answer).toContain("x-chisabot-egress-class: unresolved");
    expect(answer).toContain("连不上这个网址。");
  });

  test("an upstream that never answers the CONNECT: 504 timeout, and the live screen says 没有响应", async () => {
    setEgressTimeouts({ connectMs: 80 });
    setEgressResolver(async () => ["93.184.215.14"]);
    const upstream = await silentUpstream();
    const { filter, auth } = await filterFor({
      EGRESS_PROXY_DEFAULT: `http://127.0.0.1:${upstream}`,
    });
    const answer = await raw(
      filter.port,
      `CONNECT slow.test:443 HTTP/1.1\r\nHost: slow.test:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    expect(answer.split("\r\n")[0]).toContain("504");
    expect(answer).toContain("x-chisabot-egress-class: timeout");
    expect(answer).toContain("网站没有响应，请稍后再试。");
    expect(recentEgressOutcome("slow.test", 443)).toBe("timeout");
    expect(
      await navigationProblem(
        new Error("net::ERR_TUNNEL_CONNECTION_FAILED at https://slow.test/"),
        "https://slow.test/",
      ),
    ).toBe("网站没有响应，请稍后再试。");
  });

  test("an upstream that is down: 502 unreachable, 连不上", async () => {
    setEgressResolver(async () => ["93.184.215.14"]);
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const address = closed.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((r) => closed.close(() => r()));
    const { filter, auth } = await filterFor({
      EGRESS_PROXY_DEFAULT: `http://127.0.0.1:${port}`,
    });
    const answer = await raw(
      filter.port,
      `CONNECT down.test:443 HTTP/1.1\r\nHost: down.test:443\r\nProxy-Authorization: ${auth}\r\n\r\n`,
    );
    expect(answer.split("\r\n")[0]).toContain("502");
    expect(answer).toContain("x-chisabot-egress-class: unreachable");
    expect(answer).toContain("连不上这个网址。");
    expect(await classifyEgressTunnel("down.test", 443)).toBe("unreachable");
  });

  test("plain HTTP with no response head in time: 504 没有响应", async () => {
    setEgressTimeouts({ responseMs: 80 });
    setEgressResolver(async () => ["93.184.215.14"]);
    const upstream = await silentUpstream();
    const { filter, auth } = await filterFor({
      EGRESS_PROXY_DEFAULT: `http://127.0.0.1:${upstream}`,
    });
    const answer = await completeAnswer(
      filter.port,
      `GET http://slow.test/ HTTP/1.1\r\nHost: slow.test\r\nProxy-Authorization: ${auth}\r\nConnection: close\r\n\r\n`,
    );
    expect(answer.split("\r\n")[0]).toContain("504");
    expect(answer).toContain("网站没有响应，请稍后再试。");
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
          "oauth.example.test": ["203.0.113.30"],
          "claude.com": ["160.79.104.10"],
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

  test("when every Bot is allow_all, anonymous reaches public sites (browser has no Proxy-Authorization)", async () => {
    const filter = await start();
    setEgressPolicy("xingling", { mode: "allow_all", rules: [] });
    setEgressPolicy("other", { mode: "allow_all", rules: [] });

    // Chromium goes through the filter without credentials; ChisaBot only pushes allow_all, so
    // public OAuth hosts must open (private-net floor still holds).
    expect(await get(filter.port, "oauth.example.test")).toContain("reached");
    expect(await tunnel(filter.port, "claude.com:443")).toContain("reached");
    expect(await tunnel(filter.port, "100.64.0.1:443")).toContain("403");
    expect(await tunnel(filter.port, "192.168.1.1:443")).toContain("403");
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
