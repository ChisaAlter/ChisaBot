/**
 * Where a Bot's traffic leaves from.
 *
 * Per-Bot egress identity makes traffic attributable to the Bot that caused it. With a distinct
 * upstream proxy per Bot, the far side sees a different address for each Bot and can enforce network
 * rules alongside application policy.
 *
 * This does not anonymise anything and it is not a security boundary by itself. It
 * gives the far side a stable, per-Bot address to allow-list or attribute, which is what a security
 * team actually asks for. A Bot with no proxy configured goes out directly, which is the right default
 * for a laptop and the wrong one for a deployment that cares.
 *
 * This module has no Playwright import, so proxy parsing tests can run outside the browser image.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";

/** A proxy as Playwright wants it: credentials separated from the URL. */
export type Egress = {
  server: string;
  username?: string;
  password?: string;
};

/**
 * The environment variable naming a Bot's proxy.
 *
 * Upper-cased with anything unusual replaced, because a bot id is a free-form string and an
 * environment variable name is not. `sales-bot` reads `EGRESS_PROXY_SALES_BOT`.
 */
export function egressVariableFor(botId: string): string {
  return `EGRESS_PROXY_${botId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

/**
 * Resolve a Bot's proxy from the environment, or null for direct.
 *
 * `EGRESS_PROXY_<BOT>` names one Bot's proxy; `EGRESS_PROXY_DEFAULT` covers the rest.
 */
export function egressFor(
  botId: string,
  env: Record<string, string | undefined>,
): Egress | null {
  /*
   * While the network-policy filter runs, every Bot's browser goes through it, and it carries the
   * Bot in the proxy credentials so one filter can hold a policy per Bot. The filter chains to the
   * configured upstream itself, so the per-Bot address the far side sees is unchanged.
   */
  if (filter) {
    return {
      server: `http://127.0.0.1:${filter.port}`,
      username: botId,
      // This Bot's own key, derived from the filter's master key. It proves this Bot and no other.
      password: botProxyKey(filter.masterKey, botId),
    };
  }
  return upstreamFor(botId, env);
}

/** The configured upstream proxy for a Bot, ignoring the filter. */
export function upstreamFor(
  botId: string,
  env: Record<string, string | undefined>,
): Egress | null {
  const raw = env[egressVariableFor(botId)] ?? env.EGRESS_PROXY_DEFAULT;
  if (!raw?.trim()) return null;
  return splitProxyCredentials(raw);
}

/**
 * Split a proxy string into a server and its credentials.
 *
 * Credentials commonly arrive inside the URL, which is how proxies are handed out. They are split out
 * so that the server string can be shown to a person without leaking a password.
 *
 * Two shapes reach here, and only one of them is a URL as far as the parser is concerned. A bare
 * `host:port` is what an operator writes when they are not thinking about URLs, and Playwright and
 * curl both take it; `new URL` reads `proxy.internal:8080` as the scheme `proxy.internal:` and the
 * path `8080` with an empty host, rather than throwing. `username` and `password` come back empty for
 * that shape, so a proxy written `bot:s3cret@proxy.internal:8080` would keep its password in the
 * string it hands back. Re-parsing behind a synthetic scheme makes the split happen for both shapes;
 * the synthetic scheme is then removed so the server reads the way it was written.
 */
export function splitProxyCredentials(raw: string): Egress {
  const trimmed = raw.trim();

  let url: URL | null = null;
  let synthetic = "";
  try {
    const asWritten = new URL(trimmed);
    if (asWritten.host !== "") url = asWritten;
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
  }
  if (!url) {
    synthetic = "http://";
    try {
      url = new URL(`${synthetic}${trimmed}`);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      // Not addressable either way. Passed through, so an operator who writes the obvious thing is
      // not told they are wrong.
      return { server: trimmed };
    }
  }

  const username = url.username ? decodeUserinfo(url.username) : undefined;
  const password = url.password ? decodeUserinfo(url.password) : undefined;
  url.username = "";
  url.password = "";

  return {
    server: url.toString().replace(/\/$/, "").slice(synthetic.length),
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/**
 * A proxy username or password, percent-decoded where it was percent-encoded.
 *
 * A `%` not followed by two hex digits is a character somebody typed, not an escape, and
 * `decodeURIComponent` throws `URIError` on it. That escaped every caller here, which only catches
 * `TypeError`, and since the shell strips credentials from the proxy variables before every
 * command, one such password made every `/exec` fail. As written is what was meant.
 */
function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    if (e instanceof URIError) return value;
    throw e;
  }
}

/**
 * The label for a Bot's egress, for people and for the admin list.
 *
 * Host only. A proxy URL routinely carries a password, and this string is rendered in a browser and
 * returned by an API.
 */
export function egressLabel(
  botId: string,
  env: Record<string, string | undefined>,
): string | null {
  const proxy = upstreamFor(botId, env);
  if (!proxy) return filter ? "network policy filter" : null;
  try {
    // `||` handles bare `proxy.internal:8080`, which URL parses as a scheme plus path and an empty
    // host rather than throwing.
    return new URL(proxy.server).host || proxy.server;
  } catch {
    return proxy.server;
  }
}

/*
 * ---------------------------------------------------------------------------------------------------
 * Network policy: where a Bot's computer may connect.
 *
 * The same four modes Grok Bot's Network Controls offer (no policy, allow all, defaults plus team
 * allowlist, team allowlist only), plus `deny_all`, which is what a Bot gets when its owner's "Cloud
 * network access" capability is off. The rule engine below is pure and is also what the API server
 * imports to refuse a navigation before it reaches the computer, so the two ends cannot disagree.
 *
 * The filter proxy is what enforces it on the computer itself: the browser is pointed at it through
 * `egressFor`, and shell commands through HTTP(S)_PROXY. A policy pushed to a running computer is
 * consulted on the next connection, so it applies without restarting anything.
 *
 * WHAT THIS CANNOT STOP: a process that ignores proxy variables and opens a raw socket. That is the
 * Kubernetes NetworkPolicy's job, which this narrows rather than replaces.
 * ---------------------------------------------------------------------------------------------------
 */

export type EgressRule =
  | { type: "domain"; value: string }
  | { type: "cidr"; value: string; ports?: string };

export type EgressMode =
  | "allow_all"
  | "defaults_plus_allowlist"
  | "allowlist_only"
  | "deny_all";

export type EgressPolicy = { mode: EgressMode; rules: EgressRule[] };

export const EGRESS_MODES: readonly EgressMode[] = [
  "allow_all",
  "defaults_plus_allowlist",
  "allowlist_only",
  "deny_all",
];

/**
 * What "defaults" means in `defaults_plus_allowlist`: the package registries and source hosts a
 * development computer needs to install anything at all.
 */
export const DEFAULT_EGRESS_DESTINATIONS: readonly string[] = [
  "github.com",
  "githubusercontent.com",
  "ghcr.io",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
];

const DOMAIN =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PORTS = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;

function normalizeHost(host: string): string {
  let value = host
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  // Bun's BlockList.check returns false for zone ids (`::1%lo`), so strip before any IP check
  // or connect. Chromium never sends them; shell could.
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  return value;
}

function parseCidr(
  value: string,
): { address: string; prefix: number; family: "ipv4" | "ipv6" } | null {
  const [address = "", prefixText, ...rest] = value.trim().split("/");
  // `Number` reads "" as 0 and takes "0x8", so `10.0.0.5/` would allow every address. A zone id
  // passes `isIP` but `BlockList` throws on it when the rule is first used.
  if (rest.length > 0 || address.includes("%")) return null;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const version = isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address, prefix, family: version === 4 ? "ipv4" : "ipv6" };
}

function portsMatch(spec: string | undefined, port: number): boolean {
  if (!spec?.trim()) return true;
  return spec.split(",").some((part) => {
    const [low, high] = part.split("-").map(Number);
    if (low === undefined) return false;
    return high === undefined ? port === low : port >= low && port <= high;
  });
}

/** Read a rule list from JSON, refusing anything that is not exactly a rule. */
export function parseEgressRules(
  input: unknown,
): { ok: true; rules: EgressRule[] } | { ok: false; error: string } {
  if (!Array.isArray(input))
    return { ok: false, error: "rules must be a list." };
  const rules: EgressRule[] = [];
  for (const [index, raw] of input.entries()) {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `Rule ${index + 1} is not an object.` };
    }
    if (entry.type === "domain" && typeof entry.value === "string") {
      const value = normalizeHost(entry.value);
      if (!DOMAIN.test(value)) {
        return { ok: false, error: `"${entry.value}" is not a domain.` };
      }
      rules.push({ type: "domain", value });
      continue;
    }
    if (entry.type === "cidr" && typeof entry.value === "string") {
      if (!parseCidr(entry.value)) {
        return {
          ok: false,
          error: `"${entry.value}" is not an IP address or range such as 10.0.0.0/8.`,
        };
      }
      const ports =
        typeof entry.ports === "string" && entry.ports.trim()
          ? entry.ports.replaceAll(" ", "")
          : undefined;
      if (ports !== undefined && !PORTS.test(ports)) {
        return {
          ok: false,
          error: `"${entry.ports}" is not a port list such as 443 or 5432,8000-8100.`,
        };
      }
      rules.push({
        type: "cidr",
        value: entry.value.trim(),
        ...(ports ? { ports } : {}),
      });
      continue;
    }
    return {
      ok: false,
      error: `Rule ${index + 1} must be { type: "domain", value } or { type: "cidr", value, ports? }.`,
    };
  }
  return { ok: true, rules };
}

export function parseEgressPolicy(
  input: unknown,
): { ok: true; policy: EgressPolicy } | { ok: false; error: string } {
  const candidate = input as { mode?: unknown; rules?: unknown } | null;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !EGRESS_MODES.includes(candidate.mode as EgressMode)
  ) {
    return {
      ok: false,
      error: `mode must be one of ${EGRESS_MODES.join(", ")}.`,
    };
  }
  const rules = parseEgressRules(candidate.rules ?? []);
  if (!rules.ok) return rules;
  return {
    ok: true,
    policy: { mode: candidate.mode as EgressMode, rules: rules.rules },
  };
}

function domainMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
  return host === pattern || host.endsWith(`.${pattern}`);
}

function addressMatches(rule: EgressRule, address: string, port: number) {
  if (rule.type !== "cidr" || !portsMatch(rule.ports, port)) return false;
  const cidr = parseCidr(rule.value);
  const version = isIP(address);
  if (!cidr || version === 0) return false;
  const list = new BlockList();
  list.addSubnet(cidr.address, cidr.prefix, cidr.family);
  return list.check(address, version === 4 ? "ipv4" : "ipv6");
}

export type EgressDenyClass =
  | "private"
  | "refused"
  | "unresolved"
  | "credentials";

export type EgressDecision = {
  allowed: boolean;
  reason: string;
  /** Present when allowed is false; drives Chinese HTTP pages and tunnel classification. */
  denyClass?: EgressDenyClass;
};

/**
 * Addresses no Bot may reach, whatever its policy says, allow_all included.
 *
 * Same private-net floor as navigation (`checkNavigationTarget` / `isPrivateIpv4` /
 * `isPrivateIpv6`): RFC1918, loopback, link-local, and IPv6 unique-local; "this network"
 * (0.0.0.0/8, which Linux connects to loopback) and shared address space (100.64.0.0/10:
 * carrier-grade NAT, Tailscale and similar overlays, where other machines of this deployment sit).
 * Plus the cloud metadata endpoints (169.254/16, Alibaba 100.100.100.200, AWS/GCP IPv6 aliases). A chart
 * NetworkPolicy may also cut these out, but it is off by default — this is the guard a
 * default install actually has. It covers the browser and every command that honours the
 * proxy variables. An allowlist cidr cannot override it.
 */
const ALWAYS_DENIED: readonly [string, number, "ipv4" | "ipv6"][] = [
  // Deployment private network (matches navigation; CR-P1-04 / CB-CR-05).
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  // "This network": 0.0.0.0 reaches the local host on Linux.
  ["0.0.0.0", 8, "ipv4"],
  // Shared address space (RFC 6598): CGNAT, Tailscale and other overlay networks.
  ["100.64.0.0", 10, "ipv4"],
  // Cloud metadata / link-local.
  ["169.254.0.0", 16, "ipv4"],
  ["100.100.100.200", 32, "ipv4"],
  // IPv6: unspecified (:: reaches loopback on Linux, same as 0.0.0.0), loopback,
  // link-local, unique-local (ULA), plus cloud metadata aliases. Aligned with
  // server `checkNavigationTarget` / `isPrivateIpv6` (and shared/net/ssrf embedded forms).
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fec0::", 10, "ipv6"], // deprecated site-local (aligned with shared/net/ssrf)
  ["64:ff9b:1::", 48, "ipv6"], // local-use NAT64 (RFC 8215)
  // 6to4 (2002::/16) is not listed whole: the IPv4 it carries is checked instead (see
  // `sixToFourIpv4`), so 6to4 of a public address still works and 6to4 of a private one does not.
  ["fd00:ec2::254", 128, "ipv6"],
  ["fd20:ce::254", 128, "ipv6"],
];
const alwaysDenied = new BlockList();
for (const [address, prefix, family] of ALWAYS_DENIED)
  alwaysDenied.addSubnet(address, prefix, family);

/**
 * IPv4 ranges a 6to4 address may not carry, on top of {@link ALWAYS_DENIED}: special-purpose and
 * reserved space (RFC 6890) that is never a real public host. Same list as shared/net/ssrf. Kept
 * to the 6to4 path, so the plain IPv4 floor (and fake-IP setups on 198.18/15) is unchanged.
 */
const SIX_TO_FOUR_RESERVED: readonly [string, number][] = [
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];
const sixToFourReserved = new BlockList();
for (const [address, prefix] of SIX_TO_FOUR_RESERVED)
  sixToFourReserved.addSubnet(address, prefix, "ipv4");

/** Expand an IPv6 address into eight 16-bit groups, or null. */
function expandIpv6Groups(address: string): number[] | null {
  let hex = address.toLowerCase();
  const zone = hex.indexOf("%");
  if (zone >= 0) hex = hex.slice(0, zone);
  // Trailing dotted IPv4 (`::ffff:1.2.3.4`) → two hex groups before splitting.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(hex);
  if (dotted) {
    const ipv4 = dotted[1] ?? "";
    const parts = ipv4.split(".").map(Number);
    if (parts.length !== 4) return null;
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    const c = parts[2] ?? 0;
    const d = parts[3] ?? 0;
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    hex = `${hex.slice(0, dotted.index)}${hi}:${lo}`;
  }
  const halves = hex.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if ([...head, ...tail].some((g) => Number.isNaN(g))) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

/**
 * The IPv4 address an IPv6 literal is carrying, if any.
 *
 * Same three prefixes as navigation (`checkNavigationTarget`): `::ffff:0:0/96` (mapped),
 * `64:ff9b::/96` (NAT64), and the deprecated compatible `::/96` form. `::` and `::1` are left
 * alone — their low bits look like 0.0.0.0 / 0.0.0.1 but they are the IPv6 unspecified / loopback
 * addresses and are listed in ALWAYS_DENIED directly.
 */
function embeddedIpv4(address: string): string | null {
  if (isIP(address) !== 6) return null;
  const g = expandIpv6Groups(address);
  if (g?.length !== 8) return null;
  const zeros = (from: number, to: number) =>
    g.slice(from, to).every((n) => n === 0);
  const v4 = (high: number, low: number) =>
    [high >> 8, high & 255, low >> 8, low & 255].join(".");
  const high = g[6] ?? 0;
  const low = g[7] ?? 0;
  // ::ffff:a.b.c.d and ::ffff:XXXX:YYYY
  if (zeros(0, 5) && g[5] === 0xffff) return v4(high, low);
  // ::ffff:0:a.b.c.d (translated)
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(high, low);
  // ::ffff:ffff:a.b.c.d — illegal/confused writing of IPv4-mapped (e.g.
  // [::ffff:ffff:127.0.0.1]). Take the last 32 bits as the IPv4 they meant,
  // so the floor returns 403 rather than letting the connect fail as 502.
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0xffff) return v4(high, low);
  // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4(high, low);
  // Deprecated compatible ::a.b.c.d — not :: / ::1 (those stay IPv6).
  if (zeros(0, 6) && (high !== 0 || low > 1)) return v4(high, low);
  return null;
}

/**
 * The IPv4 a 6to4 address (RFC 3056, `2002:AABB:CCDD::/48`) is built from, or null.
 *
 * Groups 2–3 are the IPv4 of the site's 6to4 router; that is where the packet really goes.
 */
function sixToFourIpv4(address: string): string | null {
  if (isIP(address) !== 6) return null;
  const g = expandIpv6Groups(address);
  if (g?.length !== 8 || g[0] !== 0x2002) return null;
  const high = g[1] ?? 0;
  const low = g[2] ?? 0;
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/**
 * True for a private, loopback, metadata or link-local address, including one written as
 * IPv4-mapped / compatible IPv6, reached through the NAT64 prefix, or carried by a 6to4 address
 * (6to4 of a private or reserved IPv4 is refused; 6to4 of a public IPv4 is not).
 */
export function isAlwaysDenied(addressInput: string): boolean {
  const address = normalizeHost(addressInput);
  const sixToFour = sixToFourIpv4(address);
  if (sixToFour !== null) {
    return (
      alwaysDenied.check(sixToFour, "ipv4") ||
      sixToFourReserved.check(sixToFour, "ipv4")
    );
  }
  const candidate = embeddedIpv4(address) ?? address;
  const version = isIP(candidate);
  if (version === 0) return false;
  return alwaysDenied.check(candidate, version === 4 ? "ipv4" : "ipv6");
}

/** Localhost names Chromium resolves to loopback without DNS (matches navigation). */
export function isPrivateEgressHost(hostInput: string): boolean {
  const host = normalizeHost(hostInput);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isAlwaysDenied(host);
}

export type EgressTunnelClass =
  | "private"
  | "refused"
  | "unreachable"
  | "timeout"
  | "allowed"
  | "unknown";

/**
 * Ask the running filter what a CONNECT to host:port would get — used by the live screen to tell
 * "内网被拦" apart from "策略拒绝" and "上游连不上". Chromium only reports ERR_TUNNEL for all three.
 */
export async function classifyEgressTunnel(
  hostInput: string,
  port: number,
): Promise<EgressTunnelClass> {
  const host = normalizeHost(hostInput);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    return "unknown";
  if (isPrivateEgressHost(host)) return "private";
  const running = filter;
  if (!running) return "unknown";
  // What the filter itself just saw for this destination beats a second attempt.
  const recent = recentEgressOutcome(host, port);
  if (recent === "timeout") return "timeout";
  if (recent === "unresolved" || recent === "unreachable") return "unreachable";
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  const head = await new Promise<string>((resolve) => {
    const socket = connect(running.port, "127.0.0.1", () => {
      socket.write(
        `CONNECT ${authority}:${port} HTTP/1.1\r\nHost: ${authority}:${port}\r\n\r\n`,
      );
    });
    let seen = "";
    const done = () => {
      socket.destroy();
      resolve(seen);
    };
    socket.setTimeout(2_000, done);
    socket.on("data", (chunk) => {
      seen += chunk.toString();
      if (seen.includes("\r\n\r\n")) done();
    });
    socket.on("error", done);
    socket.on("close", () => resolve(seen));
  });
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
  if (status === "200") return "allowed";
  if (status === "502") return "unreachable";
  if (status === "504") return "timeout";
  if (status === "403") {
    const klass = /x-chisabot-egress-class:\s*(\w+)/i.exec(head)?.[1];
    if (klass === "private") return "private";
    if (klass === "unresolved") return "unreachable";
    if (klass === "refused" || klass === "credentials") return "refused";
    // Fallback for older English bodies / in-process probes before headers existed.
    if (/could not be resolved/i.test(head)) return "unreachable";
    if (/own network|cloud metadata|loopback|private|内网/i.test(head))
      return "private";
    return "refused";
  }
  return "unknown";
}

/**
 * May this connection go out?
 *
 * `resolved` is what the host name resolved to, when the caller resolved it. A domain rule matches a
 * name; an IP-range rule matches an address, whether the Bot dialled the address directly or a name
 * that resolved inside the range. Every resolved address must be inside an allowed range, so a name
 * that resolves partly outside is refused rather than connected to whichever address came first.
 */
export function egressDecision(
  policy: EgressPolicy,
  hostInput: string,
  port: number,
  resolved: readonly string[] = [],
): EgressDecision {
  const host = normalizeHost(hostInput);
  const denied = [host, ...resolved].find(isAlwaysDenied);
  if (denied !== undefined) {
    return {
      allowed: false,
      denyClass: "private",
      reason: `${host} is inside this deployment's own network (or a cloud metadata address), which no Bot may reach.`,
    };
  }
  if (policy.mode === "allow_all") {
    return {
      allowed: true,
      reason: "The network policy allows all destinations.",
    };
  }
  if (policy.mode === "deny_all") {
    return {
      allowed: false,
      denyClass: "refused",
      reason: "Network access is turned off for this Bot's computer.",
    };
  }
  const domains = [
    ...(policy.mode === "defaults_plus_allowlist"
      ? DEFAULT_EGRESS_DESTINATIONS
      : []),
    ...policy.rules.flatMap((rule) =>
      rule.type === "domain" ? [rule.value] : [],
    ),
  ];
  if (
    isIP(host) === 0 &&
    domains.some((pattern) => domainMatches(pattern, host))
  ) {
    return { allowed: true, reason: `${host} is on the allowlist.` };
  }
  const addresses = isIP(host) !== 0 ? [host] : [...resolved];
  if (
    addresses.length > 0 &&
    addresses.every((address) =>
      policy.rules.some((rule) => addressMatches(rule, address, port)),
    )
  ) {
    return {
      allowed: true,
      reason: `${host}:${port} is inside an allowed range.`,
    };
  }
  return {
    allowed: false,
    denyClass: "refused",
    reason: `${host}:${port} is not on this deployment's network allowlist.`,
  };
}

/**
 * True when deciding needs the host's addresses under this policy.
 *
 * Any mode other than allow_all / deny_all resolves so domain allowlist entries are checked
 * against the addresses they resolve to (ALWAYS_DENIED + cidr rules), not just spelling
 * (CR-P1-04). allow_all still resolves in {@link decide} so the private-net floor sees
 * addresses through an upstream proxy too.
 */
export function needsResolution(policy: EgressPolicy, host: string): boolean {
  return (
    isIP(normalizeHost(host)) === 0 &&
    policy.mode !== "allow_all" &&
    policy.mode !== "deny_all"
  );
}

/* --------------------------------- the filter on the computer --------------------------------- */

/**
 * `masterKey` never leaves this process. Every Bot is handed only its own key, derived from it
 * (see {@link botProxyKey}), so a Bot's credentials say nothing about any other Bot's.
 */
type RunningFilter = { port: number; masterKey: Buffer; server: Server };
let filter: RunningFilter | null = null;
const policies = new Map<string, EgressPolicy>();
let policyRequired = true;
/** Who opened a CONNECT tunnel, as {@link decide} judged it. */
type TunnelCaller = { kind: "bot"; botId: string } | { kind: "anonymous" };

/** One live CONNECT tunnel and what it was judged on, so a policy change can judge it again. */
type OpenTunnel = {
  caller: TunnelCaller;
  host: string;
  port: number;
  /** The addresses the name resolved to when it was allowed (empty for an IP literal). */
  resolved: readonly string[];
  sockets: readonly Socket[];
};

/**
 * Live CONNECT tunnels. When a policy changes, only the tunnels that policy judges are looked at
 * again, and only those the new policy would refuse are cut (see {@link dropTunnelsRefusedBy}).
 */
const openTunnels = new Set<OpenTunnel>();

function trackTunnel(
  entry: Omit<OpenTunnel, "sockets">,
  client: Socket,
  remote: Socket,
) {
  const tracked: OpenTunnel = { ...entry, sockets: [client, remote] };
  openTunnels.add(tracked);
  const forget = () => openTunnels.delete(tracked);
  client.on("close", forget);
  remote.on("close", forget);
}

function destroyTunnel(tracked: OpenTunnel) {
  openTunnels.delete(tracked);
  for (const socket of tracked.sockets) {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }
}

function dropOpenTunnels() {
  for (const tracked of [...openTunnels]) destroyTunnel(tracked);
}

/**
 * Why these policies would refuse this tunnel now, or null when they still allow it. Same rules as
 * {@link decide}, judged on the addresses the tunnel was opened with, so nothing is resolved again.
 */
function refusalFor(
  judging: EgressPolicy[] | "refuse",
  tracked: Omit<OpenTunnel, "sockets">,
): EgressDenyClass | null {
  if (judging === "refuse") return "refused";
  for (const policy of judging.length > 0 ? judging : [ALLOW_ALL_FALLBACK]) {
    const decision = egressDecision(
      policy,
      tracked.host,
      tracked.port,
      tracked.resolved,
    );
    if (!decision.allowed) return decision.denyClass ?? "refused";
  }
  return null;
}

/**
 * Cut the open tunnels the policy now in force no longer allows.
 *
 * - A Bot's tunnels are judged again only when that Bot's own policy changed.
 * - Anonymous tunnels follow the strictest Bot (see {@link anonymousPolicies}), so they are judged
 *   again only when that anonymous fallback itself changed.
 * - A tunnel the new policy still allows stays open, so loosening (or rewriting the same policy)
 *   cuts nothing, and one Bot's change never touches another Bot's tunnels.
 */
function dropTunnelsRefusedBy(
  botId: string,
  anonymousBefore: EgressPolicy[] | "refuse",
) {
  const anonymousAfter = anonymousPolicies();
  const anonymousChanged = !samePolicies(anonymousBefore, anonymousAfter);
  const botNow = policiesForBot(botId);
  for (const tracked of [...openTunnels]) {
    const judging =
      tracked.caller.kind === "bot"
        ? tracked.caller.botId === botId
          ? botNow
          : null
        : anonymousChanged
          ? anonymousAfter
          : null;
    if (judging === null) continue;
    if (refusalFor(judging, tracked) !== null) destroyTunnel(tracked);
  }
}

function samePolicies(
  a: EgressPolicy[] | "refuse",
  b: EgressPolicy[] | "refuse",
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Resolver = (host: string) => Promise<string[]>;
const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);
let resolver: Resolver = systemResolver;

/** For tests: answer name lookups without DNS. Null puts the system resolver back. */
export function setEgressResolver(next: Resolver | null) {
  resolver = next ?? systemResolver;
}

/** Install (or with null, remove) the policy one Bot's connections are judged by. */
export function setEgressPolicy(botId: string, policy: EgressPolicy | null) {
  const anonymousBefore = anonymousPolicies();
  if (policy) policies.set(botId, policy);
  else policies.delete(botId);
  // A tighter policy applies to tunnels already open too, but only to the ones it now refuses.
  dropTunnelsRefusedBy(botId, anonymousBefore);
}

export function egressPolicyFor(botId: string): EgressPolicy | undefined {
  return policies.get(botId);
}

/**
 * Which policies judge a connection from a Bot that proved who it is (see {@link proxyCallerFrom}).
 *
 * Nothing pushed yet refuses: the API server pushes a computer its policy before it acts and
 * whenever the computer wakes, so a refusal here is only ever the gap before that push.
 * EGRESS_POLICY_REQUIRED=0 lets a computer run with no API server pushing to it at all.
 */
function policiesForBot(botId: string): EgressPolicy[] | "refuse" {
  const own = policies.get(botId);
  if (own) return [own];
  return policyRequired ? "refuse" : [];
}

/**
 * The fallback for a connection with no proxy credentials at all.
 *
 * Such a connection is never any particular Bot: it is not judged by a Bot's policy and never sees a
 * Bot's allowlist. When every Bot on this computer is `allow_all` (ChisaBot's only pushed mode after
 * slimming P6-1), anonymous matches that — Chromium is launched with proxy credentials via Playwright
 * but only sends `Proxy-Authorization` after a 407, and this filter historically answered missing
 * credentials as anonymous instead of challenging, so the browser never proved who it was and was
 * stuck on {@link DEFAULT_EGRESS_DESTINATIONS} (package registries). OAuth pages like claude.com then
 * failed with `ERR_TUNNEL_CONNECTION_FAILED`. Matching `allow_all` keeps the private-net floor
 * ({@link ALWAYS_DENIED}) and unblocks public sites. When any Bot still uses an allowlist mode,
 * anonymous falls back to the registries only (or refuse under `allowlist_only` / `deny_all`).
 */
export const ANONYMOUS_EGRESS_POLICY: EgressPolicy = Object.freeze({
  mode: "defaults_plus_allowlist",
  rules: Object.freeze([]) as unknown as EgressRule[],
}) as EgressPolicy;

const ANONYMOUS_ALLOW_ALL: EgressPolicy = { mode: "allow_all", rules: [] };

const ANONYMOUS_DENY: EgressPolicy = { mode: "deny_all", rules: [] };

/** What a connection is judged by when there is no policy to judge it (EGRESS_POLICY_REQUIRED=0). */
const ALLOW_ALL_FALLBACK: EgressPolicy = { mode: "allow_all", rules: [] };

/**
 * The policy an anonymous connection is judged by. One function on purpose, so the fallback can be
 * changed in one place (to plain refusal, say) without touching the Bot path.
 *
 * - Nothing pushed: refused, as for a Bot (or, with EGRESS_POLICY_REQUIRED=0, no policy at all, the
 *   same as a Bot without one; the private-net floor still applies).
 * - Any Bot is `allowlist_only` / `deny_all`: refuse. Stripping credentials must not get that Bot
 *   more than it has. Only modes are read, never a Bot's rules.
 * - Every Bot is `allow_all`: anonymous is `allow_all` too (still under {@link ALWAYS_DENIED}).
 * - Otherwise {@link ANONYMOUS_EGRESS_POLICY} (package registries only).
 */
function anonymousPolicies(): EgressPolicy[] | "refuse" {
  if (policies.size === 0) return policyRequired ? "refuse" : [];
  for (const policy of policies.values()) {
    if (policy.mode === "allowlist_only" || policy.mode === "deny_all")
      return [ANONYMOUS_DENY];
  }
  for (const policy of policies.values()) {
    if (policy.mode !== "allow_all") return [ANONYMOUS_EGRESS_POLICY];
  }
  return [ANONYMOUS_ALLOW_ALL];
}

/* ------------------------------- who is asking (proxy credentials) ------------------------------- */

/**
 * One Bot's proxy key: HMAC-SHA256 of the Bot id under the filter's master key.
 *
 * The master key is random per filter start and stays in this process, so knowing any number of Bots'
 * keys (each shell command sees its own Bot's, in HTTP(S)_PROXY) does not give another Bot's.
 */
export function botProxyKey(masterKey: Buffer, botId: string): string {
  return createHmac("sha256", masterKey)
    .update(`chisabot-egress-proxy:v1:${botId}`)
    .digest("base64url");
}

/** Who a proxy request is from. `rejected` is never judged by any policy. */
export type ProxyCaller =
  | { kind: "bot"; botId: string }
  | { kind: "anonymous" }
  | { kind: "rejected"; reason: string };

const REJECTED_CREDENTIALS =
  "The proxy credentials were not accepted, so nothing may leave through this filter.";

/** Constant-time on equal-length digests, so neither the content nor the length of a guess leaks. */
function sameSecret(offered: string, expected: string): boolean {
  const a = createHash("sha256").update(offered).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Read a request's Proxy-Authorization.
 *
 * - No header at all: anonymous (see {@link anonymousPolicies}).
 * - A Bot id with its own derived key: that Bot.
 * - Anything else (not Basic, no Bot id, an empty password, a wrong one, or one Bot's key offered
 *   for another Bot): rejected. Never downgraded to anonymous, so a bad guess gains nothing.
 */
export function proxyCallerFrom(
  header: string | undefined,
  masterKey: Buffer,
): ProxyCaller {
  if (header === undefined || header.trim() === "")
    return { kind: "anonymous" };
  if (!/^Basic\s+/i.test(header))
    return { kind: "rejected", reason: REJECTED_CREDENTIALS };
  const decoded = Buffer.from(
    header.replace(/^Basic\s+/i, ""),
    "base64",
  ).toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) return { kind: "rejected", reason: REJECTED_CREDENTIALS };
  const botId = decodeUserinfo(decoded.slice(0, colon)).trim();
  const offered = decodeUserinfo(decoded.slice(colon + 1));
  if (!botId || offered.length === 0)
    return { kind: "rejected", reason: REJECTED_CREDENTIALS };
  if (!sameSecret(offered, botProxyKey(masterKey, botId)))
    return { kind: "rejected", reason: REJECTED_CREDENTIALS };
  return { kind: "bot", botId };
}

/* ------------------------------ anonymous connections, on the record ------------------------------ */

/** Per window, this many anonymous connections are logged one by one; the rest are counted. */
export const ANONYMOUS_LOG_LIMIT = 5;
export const ANONYMOUS_LOG_WINDOW_MS = 60_000;

type EgressLogger = (line: string) => void;
const defaultLogger: EgressLogger = (line) => console.warn(line);
let egressLogger: EgressLogger = defaultLogger;
let anonymousWindow = {
  start: Number.NEGATIVE_INFINITY,
  logged: 0,
  suppressed: 0,
};

/** For tests: capture the filter's log lines. Null puts console.warn back and resets the throttle. */
export function setEgressLogger(next: EgressLogger | null) {
  egressLogger = next ?? defaultLogger;
  anonymousWindow = {
    start: Number.NEGATIVE_INFINITY,
    logged: 0,
    suppressed: 0,
  };
}

/**
 * Record a connection that came with no proxy credentials, throttled.
 *
 * Says where it came from (the local socket) and where it was going, never a credential. The first
 * {@link ANONYMOUS_LOG_LIMIT} per window are written out; the rest are counted and the count is
 * written with the first line of the next window. Returns whether a line was written.
 */
export function noteAnonymousEgress(
  source: { via: "CONNECT" | "HTTP"; target: string; from: string },
  now = Date.now(),
): boolean {
  let carried = 0;
  if (now - anonymousWindow.start >= ANONYMOUS_LOG_WINDOW_MS) {
    carried = anonymousWindow.suppressed;
    anonymousWindow = { start: now, logged: 0, suppressed: 0 };
  }
  if (anonymousWindow.logged >= ANONYMOUS_LOG_LIMIT) {
    anonymousWindow.suppressed += 1;
    return false;
  }
  anonymousWindow.logged += 1;
  egressLogger(
    JSON.stringify({
      type: "ops",
      code: "EGRESS_ANONYMOUS",
      reason:
        "A connection reached the egress filter without proxy credentials; judged by the anonymous fallback, not by any Bot's policy.",
      via: source.via,
      target: source.target,
      from: source.from,
      ...(carried > 0 ? { suppressedSinceLastLine: carried } : {}),
    }),
  );
  return true;
}

async function decide(
  caller: { kind: "bot"; botId: string } | { kind: "anonymous" },
  host: string,
  port: number,
): Promise<EgressDecision & { addresses?: string[]; resolved?: string[] }> {
  const judging =
    caller.kind === "bot" ? policiesForBot(caller.botId) : anonymousPolicies();
  if (judging === "refuse") {
    return {
      allowed: false,
      denyClass: "refused",
      reason:
        "No network policy has reached this computer yet, so nothing may leave it.",
    };
  }
  let resolved: string[] = [];
  /*
   * Always resolve names so ALWAYS_DENIED (RFC1918 + loopback + metadata) sees addresses —
   * including through an upstream proxy and under allow_all. A name that only the upstream can
   * resolve fails closed here rather than skipping the private-net floor. Direct connections
   * also pin to these addresses so a second lookup cannot answer differently.
   */
  const named = isIP(normalizeHost(host)) === 0;
  if (named) {
    try {
      resolved = await withTimeout(
        resolver(normalizeHost(host)),
        timeouts.lookupMs,
      );
      if (resolved.length === 0) throw new Error("No addresses.");
    } catch {
      // A lookup that fails or never answers is the name not resolving: "连不上", not "没有响应".
      noteOutcome(host, port, "unresolved");
      return {
        allowed: false,
        denyClass: "unresolved",
        reason: `${host} could not be resolved.`,
      };
    }
  }
  // Checked even with no policy to judge by, which EGRESS_POLICY_REQUIRED=0 allows.
  for (const policy of judging.length > 0 ? judging : [ALLOW_ALL_FALLBACK]) {
    const decision = egressDecision(policy, host, port, resolved);
    if (!decision.allowed) return decision;
  }
  // Connect only to the addresses that were checked, so a second lookup cannot answer differently.
  return {
    allowed: true,
    reason: "Allowed.",
    ...(resolved.length > 0 ? { addresses: resolved } : {}),
    resolved,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError("Lookup")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function orderedEntries(addresses: readonly string[]) {
  const entries = addresses.map((address) => ({
    address,
    family: (isIP(address) === 6 ? 6 : 4) as 4 | 6,
  }));
  // Prefer IPv4 before IPv6 so dual-stack names reach IPv4 first on containers without an IPv6 route.
  entries.sort((a, b) => a.family - b.family);
  return entries;
}

/**
 * Connection options that reach a name through the addresses already checked, and nothing else.
 *
 * Every address the name resolved to passed the deny check, so any of them may be tried. The `lookup`
 * answers from the checked list without asking DNS, which is what keeps the pin: the name is never
 * resolved a second time. `autoSelectFamily` is kept off because Bun v1.3.14's `node:net` timer
 * callback (`internalConnectMultipleTimeout`) throws an uncaught `TypeError` when an attempt times
 * out; `orderedEntries` prefers IPv4 first and `tunnel` tries each checked address in turn.
 */
function pinnedTo(addresses: readonly string[] | undefined) {
  if (!addresses?.length) return {};
  const entries = orderedEntries(addresses);
  return {
    autoSelectFamily: false,
    lookup: (
      _host: string,
      options: { all?: boolean } | number | undefined,
      callback: (...args: unknown[]) => void,
    ) => {
      if (typeof options === "object" && options?.all) callback(null, entries);
      else callback(null, entries[0]?.address, entries[0]?.family);
    },
  };
}

function basic(username?: string, password?: string): string | undefined {
  if (username === undefined) return undefined;
  return `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}`;
}

function upstreamAddress(upstream: Egress): { host: string; port: number } {
  const url = new URL(
    /^[a-z]+:\/\//i.test(upstream.server)
      ? upstream.server
      : `http://${upstream.server}`,
  );
  return { host: unbracketed(url.hostname), port: Number(url.port || 80) };
}

function chineseDenyBody(kind: EgressDenyClass): string {
  switch (kind) {
    case "private":
      return "出于安全原因不允许访问内网地址。";
    case "refused":
      return "网络策略不允许访问这个网址。";
    case "unresolved":
      return "连不上这个网址。";
    case "credentials":
      return "代理凭据不正确，无法出网。";
  }
}

function denyHeaders(kind: EgressDenyClass): Record<string, string> {
  return {
    "content-type": "text/plain; charset=utf-8",
    "x-chisabot-egress": "refused",
    "x-chisabot-egress-class": kind,
  };
}

function refuse(socket: Socket, kind: EgressDenyClass) {
  const body = chineseDenyBody(kind);
  const headers = denyHeaders(kind);
  socket.end(
    `HTTP/1.1 403 Forbidden\r\ncontent-type: ${headers["content-type"]}\r\nx-chisabot-egress: ${headers["x-chisabot-egress"]}\r\nx-chisabot-egress-class: ${headers["x-chisabot-egress-class"]}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/** Why a connection the policy allowed still did not go through. Drives the 502 / 504 pages. */
export type EgressFailure = "unreachable" | "timeout";

/**
 * How long each step may take. Dialling the target (or the upstream proxy, through its CONNECT
 * answer) and waiting for a plain-HTTP response head are timeouts ("没有响应"); a name lookup that
 * does not answer is a DNS failure ("连不上").
 */
const DEFAULT_TIMEOUTS = {
  connectMs: 15_000,
  lookupMs: 5_000,
  responseMs: 30_000,
};
let timeouts = { ...DEFAULT_TIMEOUTS };

/** For tests: shorten the filter's timeouts. Null puts the defaults back. */
export function setEgressTimeouts(
  next: Partial<typeof DEFAULT_TIMEOUTS> | null,
) {
  timeouts = { ...DEFAULT_TIMEOUTS, ...(next ?? {}) };
}

function timeoutError(what: string): Error {
  return Object.assign(new Error(`${what} timed out.`), { code: "ETIMEDOUT" });
}

/** A connection error that means "no answer in time", as opposed to "refused / reset / no route". */
function isTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT";
}

function failureOf(error: unknown): EgressFailure {
  return isTimeout(error) ? "timeout" : "unreachable";
}

function failureBody(kind: EgressFailure): string {
  return kind === "timeout" ? "网站没有响应，请稍后再试。" : "连不上这个网址。";
}

function failureStatus(kind: EgressFailure): string {
  return kind === "timeout" ? "504 Gateway Timeout" : "502 Bad Gateway";
}

function badGateway(socket: Socket, kind: EgressFailure = "unreachable") {
  const body = failureBody(kind);
  socket.end(
    `HTTP/1.1 ${failureStatus(kind)}\r\ncontent-type: text/plain; charset=utf-8\r\nx-chisabot-egress-class: ${kind}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/*
 * What happened the last time the filter tried a destination, for the live screen.
 *
 * Chromium reports a refused tunnel, a DNS failure and a timeout all as ERR_TUNNEL (and a tunnel that
 * opened and then dropped as ERR_CONNECTION_CLOSED). Only network outcomes are kept here (the name did
 * not resolve, the dial timed out, the target was unreachable), never a policy verdict, so one Bot's
 * policy never colours another Bot's message. Short-lived and bounded.
 */
type NetworkOutcome = "unresolved" | EgressFailure;
const OUTCOME_TTL_MS = 30_000;
const OUTCOME_LIMIT = 256;
const recentOutcomes = new Map<string, { kind: NetworkOutcome; at: number }>();

function outcomeKey(host: string, port: number): string {
  return `${normalizeHost(host)}:${port}`;
}

function noteOutcome(host: string, port: number, kind: NetworkOutcome | null) {
  const key = outcomeKey(host, port);
  recentOutcomes.delete(key);
  if (kind === null) return;
  recentOutcomes.set(key, { kind, at: Date.now() });
  while (recentOutcomes.size > OUTCOME_LIMIT) {
    const oldest = recentOutcomes.keys().next().value;
    if (oldest === undefined) break;
    recentOutcomes.delete(oldest);
  }
}

/** The filter's last network outcome for host:port within the last 30 seconds, if any. */
export function recentEgressOutcome(
  host: string,
  port: number,
  now = Date.now(),
): NetworkOutcome | null {
  const seen = recentOutcomes.get(outcomeKey(host, port));
  if (!seen || now - seen.at > OUTCOME_TTL_MS) return null;
  return seen.kind;
}

/** Open a tunnel to host:port, through the upstream proxy when there is one. */
function tunnel(
  target: { host: string; port: number; addresses?: readonly string[] },
  upstream: Egress | null,
  onReady: (socket: Socket) => void,
  onError: (error: Error) => void,
) {
  if (!upstream) {
    const entries = target.addresses?.length
      ? orderedEntries(target.addresses)
      : [
          {
            address: target.host,
            family: (isIP(target.host) === 6 ? 6 : 4) as 4 | 6,
          },
        ];
    let index = 0;
    const tryNext = (lastError?: Error) => {
      const entry = entries[index++];
      if (!entry) {
        onError(lastError ?? new Error("Connection failed."));
        return;
      }
      const handleAttemptError = (err: Error) => {
        clearTimeout(timer);
        socket.destroy();
        tryNext(err);
      };
      const timer = setTimeout(
        () => handleAttemptError(timeoutError("Connecting")),
        timeouts.connectMs,
      );
      const socket = connect(
        {
          host: entry.address,
          port: target.port,
          family: entry.family,
          autoSelectFamily: false,
        },
        () => {
          clearTimeout(timer);
          socket.off("error", handleAttemptError);
          onReady(socket);
        },
      );
      socket.once("error", handleAttemptError);
    };
    tryNext();
    return;
  }
  const via = upstreamAddress(upstream);
  let settled = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    onError(error);
  };
  const timer = setTimeout(
    () => fail(timeoutError("The upstream proxy")),
    timeouts.connectMs,
  );
  const socket = connect(via.port, via.host, () => {
    const auth = basic(upstream.username, upstream.password);
    // An IPv6 host is bracketed in an authority: `CONNECT ::1:443` cannot be read.
    const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host;
    socket.write(
      `CONNECT ${host}:${target.port} HTTP/1.1\r\nHost: ${host}:${target.port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
    );
  });
  let head = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    socket.off("data", onData);
    const status = head.subarray(0, end).toString();
    if (!/^HTTP\/1\.[01] 200/.test(status)) {
      // An upstream that answers 504 timed out reaching the target itself.
      fail(
        /^HTTP\/1\.[01] 504/.test(status)
          ? timeoutError("The upstream proxy's tunnel")
          : new Error("The upstream proxy refused the tunnel."),
      );
      return;
    }
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const rest = head.subarray(end + 4);
    if (rest.length > 0) socket.unshift(rest);
    onReady(socket);
  };
  socket.on("data", onData);
  socket.once("error", fail);
}

export type EgressFilterOptions = {
  env?: Record<string, string | undefined>;
  /** 0 picks a free port. */
  port?: number;
  /** Point the shell's commands at the filter (see `egressShellEnvironment`). */
  forShell?: boolean;
};

/*
 * NOT THIS PROCESS'S ENVIRONMENT. Bun's `http.request` follows HTTP_PROXY and ignores every option
 * that should stop it (measured: `agent: false`, a fresh Agent and `createConnection` all still went
 * to the proxy). With the filter's own address in this process's HTTP_PROXY, every plain-HTTP request
 * the filter forwarded came straight back into the filter, without end, and a page waiting behind
 * one never loaded. So the shell gets the address from here, and nothing else in this process does.
 */
let shellProxy: string | null = null;

/** The proxy variables a shell command runs with while the filter is up, scoped to one Bot when named. */
export function egressShellEnvironmentForBot(
  botId?: string,
): Record<string, string> {
  if (!shellProxy) return {};
  const trimmed = botId?.trim();
  // A named Bot's commands carry that Bot's own derived key; without a Bot, no credentials at all
  // (the anonymous fallback, see `anonymousPolicies`).
  const proxy =
    trimmed && filter
      ? `http://${encodeURIComponent(trimmed)}:${encodeURIComponent(botProxyKey(filter.masterKey, trimmed))}@127.0.0.1:${filter.port}`
      : shellProxy;
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    // The computer's own loopback services are not the network.
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
}

/** The proxy variables a shell command runs with while the filter is up: the filter, and no other. */
export function egressShellEnvironment(): Record<string, string> {
  return egressShellEnvironmentForBot();
}

/**
 * Start the filter on 127.0.0.1.
 *
 * Idempotent: a second call answers the running filter. Chains to the Bot's configured upstream
 * (`EGRESS_PROXY_<BOT>` / `EGRESS_PROXY_DEFAULT`), so the per-Bot egress identity is kept.
 */
export async function startEgressFilter(
  options: EgressFilterOptions = {},
): Promise<{ port: number; url: string; stop: () => Promise<void> }> {
  const env = options.env ?? process.env;
  policyRequired = !(
    env.EGRESS_POLICY_REQUIRED === "0" || env.EGRESS_POLICY_REQUIRED === "false"
  );
  if (filter) {
    return {
      port: filter.port,
      url: `http://127.0.0.1:${filter.port}`,
      stop: stopEgressFilter,
    };
  }
  const masterKey = randomBytes(32);

  const server = createServer(async (request, response) => {
    // A plain-HTTP request through a proxy names the absolute URL.
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end("A proxy request names an absolute URL.");
      return;
    }
    const caller = proxyCallerFrom(
      request.headers["proxy-authorization"] as string | undefined,
      masterKey,
    );
    const port = Number(
      target.port || (target.protocol === "https:" ? 443 : 80),
    );
    if (caller.kind === "rejected") {
      const body = chineseDenyBody("credentials");
      response.writeHead(403, denyHeaders("credentials")).end(body);
      return;
    }
    if (caller.kind === "anonymous") {
      noteAnonymousEgress({
        via: "HTTP",
        target: `${target.hostname}:${port}`,
        from: `${request.socket.remoteAddress ?? "?"}:${request.socket.remotePort ?? "?"}`,
      });
    }
    // Only a proven Bot uses a Bot's upstream; anonymous gets the default one (or none).
    const upstream = upstreamFor(
      caller.kind === "bot" ? caller.botId : "",
      env,
    );
    const decision = await decide(caller, target.hostname, port);
    if (!decision.allowed) {
      const kind = decision.denyClass ?? "refused";
      const body = chineseDenyBody(kind);
      response.writeHead(403, denyHeaders(kind)).end(body);
      return;
    }
    forwardPlain(request, response, target, upstream, decision.addresses);
  });

  server.on(
    "connect",
    async (request: IncomingMessage, client: Socket, head: Buffer) => {
      const [rawHost = "", portText = "443"] = splitHostPort(request.url ?? "");
      // Strip zone ids before decide/connect — BlockList misses them, net.connect would honour them.
      const host = normalizeHost(rawHost);
      const port = Number(portText);
      const caller = proxyCallerFrom(
        request.headers["proxy-authorization"] as string | undefined,
        masterKey,
      );
      client.on("error", () => undefined);
      if (caller.kind === "rejected") {
        refuse(client, "credentials");
        return;
      }
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        refuse(client, "refused");
        return;
      }
      if (caller.kind === "anonymous") {
        noteAnonymousEgress({
          via: "CONNECT",
          target: `${host}:${port}`,
          from: `${client.remoteAddress ?? "?"}:${client.remotePort ?? "?"}`,
        });
      }
      const upstream = upstreamFor(
        caller.kind === "bot" ? caller.botId : "",
        env,
      );
      const decision = await decide(caller, host, port);
      if (!decision.allowed) {
        refuse(client, decision.denyClass ?? "refused");
        return;
      }
      tunnel(
        {
          host,
          port,
          ...(upstream ? {} : { addresses: decision.addresses }),
        },
        upstream,
        (remote) => {
          const entry = {
            caller:
              caller.kind === "bot"
                ? ({ kind: "bot", botId: caller.botId } as const)
                : ({ kind: "anonymous" } as const),
            host,
            port,
            resolved: decision.resolved ?? [],
          };
          // The policy may have tightened while the tunnel was being dialled.
          const judging =
            entry.caller.kind === "bot"
              ? policiesForBot(entry.caller.botId)
              : anonymousPolicies();
          const refusal = refusalFor(judging, entry);
          if (refusal !== null) {
            remote.destroy();
            refuse(client, refusal);
            return;
          }
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) remote.write(head);
          remote.pipe(client);
          client.pipe(remote);
          remote.on("error", () => client.destroy());
          trackTunnel(entry, client, remote);
          noteOutcome(host, port, null);
        },
        (error) => {
          const kind = failureOf(error);
          noteOutcome(host, port, kind);
          badGateway(client, kind);
        },
      );
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  filter = { port, masterKey, server };

  const url = `http://127.0.0.1:${port}`;
  if (options.forShell) shellProxy = url;
  return { port, url, stop: stopEgressFilter };
}

export async function stopEgressFilter(): Promise<void> {
  const running = filter;
  recentOutcomes.clear();
  filter = null;
  shellProxy = null;
  policies.clear();
  dropOpenTunnels();
  if (running) {
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
  }
}

/** `URL.hostname` keeps an IPv6 address's brackets, and a socket given them looks the name up. */
function unbracketed(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

function splitHostPort(value: string): [string, string] {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return [value.slice(1, end), value.slice(end + 2) || "443"];
  }
  const colon = value.lastIndexOf(":");
  return colon === -1
    ? [value, "443"]
    : [value.slice(0, colon), value.slice(colon + 1)];
}

function forwardPlain(
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  target: URL,
  upstream: Egress | null,
  addresses?: readonly string[],
) {
  const headers = { ...request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const via = upstream ? upstreamAddress(upstream) : null;
  const auth = upstream
    ? basic(upstream.username, upstream.password)
    : undefined;
  const outbound = httpRequest(
    {
      // Reached through the checked addresses only (see `pinnedTo`): a second lookup could answer
      // something else. The Host header still names the site.
      host: via ? via.host : normalizeHost(target.hostname),
      port: via ? via.port : Number(target.port || 80),
      ...(via ? {} : (pinnedTo(addresses) as object)),
      method: request.method,
      path: via ? target.toString() : `${target.pathname}${target.search}`,
      headers: { ...headers, ...(auth ? { "proxy-authorization": auth } : {}) },
    },
    (answer) => {
      clearTimeout(timer);
      if (failed) {
        answer.resume();
        return;
      }
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  // Answer the browser ourselves: Bun's `destroy(error)` on a client request does not reliably emit
  // `error` (1.3.x), so the timeout must not depend on it.
  let failed = false;
  const fail = (kind: EgressFailure) => {
    if (failed) return;
    failed = true;
    clearTimeout(timer);
    if (!response.headersSent) {
      noteOutcome(target.hostname, Number(target.port || 80), kind);
      response.writeHead(kind === "timeout" ? 504 : 502, {
        "content-type": "text/plain; charset=utf-8",
        "x-chisabot-egress-class": kind,
        // The request may still be streaming its body to an outbound that is gone; end this one.
        connection: "close",
      });
      response.end(failureBody(kind));
      return;
    }
    response.end();
  };
  const timer = setTimeout(() => {
    fail("timeout");
    outbound.destroy();
  }, timeouts.responseMs);
  outbound.on("error", (error) => fail(failureOf(error)));
  request.pipe(outbound);
}

/**
 * `PUT /egress-policy` on the computer: the API server pushing a Bot's policy.
 *
 * Mounted by index.ts after its token check. The body is `{ policy: EgressPolicy | null }`; null
 * removes the Bot's policy, which returns it to "nothing pushed".
 */
export async function handleEgressPolicyRequest(
  botId: string,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    policy?: unknown;
  } | null;
  if (!body || !("policy" in body)) {
    return Response.json({ error: "Expected { policy }." }, { status: 400 });
  }
  if (body.policy === null) {
    setEgressPolicy(botId, null);
    return Response.json({ botId, policy: null, filtering: filter !== null });
  }
  const parsed = parseEgressPolicy(body.policy);
  if (!parsed.ok)
    return Response.json({ error: parsed.error }, { status: 400 });
  setEgressPolicy(botId, parsed.policy);
  return Response.json({
    botId,
    policy: parsed.policy,
    filtering: filter !== null,
  });
}
