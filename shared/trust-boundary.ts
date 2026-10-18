/**
 * Trust-boundary helpers (network isolation → v0.1.33; Magpie/sidecar isolate → v0.1.39).
 *
 * Pure checks used by CI red-line tests and (conceptually) by deploy scripts:
 * - compose host binds must be loopback for internal-only ports
 * - friend-pack TRUSTED_ORIGINS must be loopback-only under single-user
 * - public nginx must clear X-ChisaBot-Local-Caller so clients cannot inject it
 *
 * Runtime Local-Caller acceptance stays in server/src/auth/gateway-identity.ts:
 * viaGateway (X-Forwarded-For / X-Real-IP) refuses Local-Caller; only direct
 * host→127.0.0.1 scrapes (updater, post-deploy-smoke, auth device probe) may use it.
 */

/** Ports that must never be published on 0.0.0.0 / :: in our compose templates. */
export const INTERNAL_ONLY_PORTS = [3001, 3002, 3425, 3430] as const;

const LOOPBACK_HOST =
  /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|\[?0:0:0:0:0:0:0:1\]?)$/i;

/** Hostname (no brackets) is loopback. */
export function isLoopbackHostname(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  return LOOPBACK_HOST.test(bare);
}

/**
 * Origin URL is http(s) to loopback only. Unparseable → not loopback (deny-by-default).
 */
export function isLoopbackOrigin(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Single-user friend-pack: every TRUSTED_ORIGINS entry must be loopback http.
 * https public origins belong on the login gateway, not the app.
 */
export function assertTrustedOriginsLoopbackOnly(
  originsCsv: string,
): { ok: true } | { ok: false; reason: string } {
  const parts = originsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, reason: "TRUSTED_ORIGINS is empty; friend-pack expects loopback origins." };
  }
  for (const origin of parts) {
    if (origin.toLowerCase().startsWith("https://")) {
      return {
        ok: false,
        reason: `TRUSTED_ORIGINS must not include https (got ${origin}); public HTTPS belongs on deploy/public.`,
      };
    }
    if (!isLoopbackOrigin(origin)) {
      return {
        ok: false,
        reason: `TRUSTED_ORIGINS entry is not loopback: ${origin}`,
      };
    }
  }
  return { ok: true };
}

/**
 * A docker-compose `ports:` mapping line is loopback-bound (or not a host publish).
 * Accepts: "127.0.0.1:3001:3001", '127.0.0.1:3001:3001', - "127.0.0.1:3425:3425"
 * Rejects: "0.0.0.0:3001:3001", "3001:3001", "::3001:3001", "[::]:3001:3001"
 */
export function composeHostBindIsLoopback(portLine: string): boolean {
  const trimmed = portLine.trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, "");
  // host:container or ip:host:container
  const m = trimmed.match(
    /^(?:(\[?[0-9a-fA-F:.]+\]?|0\.0\.0\.0|localhost):)?(\d+):(\d+)(?:\/(?:tcp|udp))?$/,
  );
  if (!m) return true; // not a short-syntax publish we understand — leave to other checks
  const host = m[1];
  if (!host) return false; // bare "3001:3001" publishes on all interfaces
  if (host === "0.0.0.0" || host === "::" || host === "[::]") return false;
  return isLoopbackHostname(host);
}

/** Extract short-syntax port publish lines from a compose YAML text (best-effort). */
export function extractComposePortLines(yamlText: string): string[] {
  const lines: string[] = [];
  let inPorts = false;
  let portsIndent = 0;
  for (const line of yamlText.split(/\r?\n/)) {
    const portsMatch = /^(\s*)ports:\s*$/.exec(line);
    if (portsMatch) {
      inPorts = true;
      portsIndent = portsMatch[1]!.length;
      continue;
    }
    if (inPorts) {
      const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      if (indent <= portsIndent) {
        inPorts = false;
      } else if (/^\s*-\s*/.test(line)) {
        lines.push(line.trim());
        continue;
      } else {
        inPorts = false;
      }
    }
  }
  return lines;
}

/** nginx.conf must clear Local-Caller on every proxy_pass to the app (3001). */
export function nginxClearsLocalCallerForAppProxies(nginxConf: string): {
  ok: boolean;
  missingNear: string[];
} {
  const missingNear: string[] = [];
  const blocks = nginxConf.split(/(?=location\s)/);
  for (const block of blocks) {
    if (!/proxy_pass\s+http:\/\/127\.0\.0\.1:3001/.test(block)) continue;
    if (!/proxy_set_header\s+X-ChisaBot-Local-Caller\s+""\s*;/.test(block)) {
      const loc = /^\s*location[^\n{]+/.exec(block)?.[0]?.trim() ?? "unknown location";
      missingNear.push(loc);
    }
  }
  return { ok: missingNear.length === 0, missingNear };
}

/** iptables DOCKER-USER comment for Magpie/sidecar -> app:3001 DROP (PRD-P0-02 / v0.1.39). */
export const SIDECAR_ISOLATE_COMMENT = "chisabot-sidecar-iso";

/** App port sidecars must not initiate to. */
export const SIDECAR_ISOLATE_APP_PORT = 3001;

/**
 * Isolate script text must teach br_netfilter + DOCKER-USER DROP + live verify.
 * Pure string checks for CI (no root/iptables on runners).
 */
export function isolateScriptCoversSidecarDeny(scriptText: string): {
  ok: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  const needles: Array<[string, RegExp]> = [
    ["comment marker", /chisabot-sidecar-iso/],
    ["br_netfilter", /br_netfilter/],
    ["bridge-nf-call-iptables", /bridge-nf-call-iptables/],
    ["--apply", /--apply/],
    ["--check", /--check/],
    ["--verify", /--verify/],
    ["DOCKER-USER", /DOCKER-USER/],
    ["DROP dport app", /--dport/],
  ];
  for (const [label, re] of needles) {
    if (!re.test(scriptText)) missing.push(label);
  }
  return { ok: missing.length === 0, missing };
}
