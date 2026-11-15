import { isIP } from "node:net";

/**
 * Network policy: where a Bot's computer may connect — the contract both ends share.
 *
 * Server pushes a policy to the computer (server/src/computer/policy-network.ts), agent-computer's
 * egress filter enforces it (agent-computer/src/egress.ts). The schema and its parsers live here so
 * the two ends cannot disagree; host normalisation and the CIDR/port matchers are part of that
 * contract, which is why the enforcement side imports them back from here.
 *
 * The same four modes Grok Bot's Network Controls offer (no policy, allow all, defaults plus team
 * allowlist, team allowlist only), plus `deny_all`, which is what a Bot gets when its owner's "Cloud
 * network access" capability is off.
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

export function normalizeHost(host: string): string {
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

export function parseCidr(
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

export function portsMatch(spec: string | undefined, port: number): boolean {
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
