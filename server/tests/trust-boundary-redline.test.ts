/**
 * Trust-boundary network isolation red-line (v0.1.33).
 *
 * Complements SSRF red-line (PRD-P1-06): who-can-reach-whom for Local-Caller,
 * compose port publishes, friend TRUSTED_ORIGINS, and nginx header clearing.
 * Wired in .github/workflows/chisabot.yml — must stay green on every PR.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertTrustedOriginsLoopbackOnly,
  composeHostBindIsLoopback,
  extractComposePortLines,
  isolateScriptCoversSidecarDeny,
  nginxClearsLocalCallerForAppProxies,
  nginxPinsClientIpHeaders,
} from "../../shared/trust-boundary";
import {
  LOCAL_CALLER_HEADER,
  resolveGatewayRequest,
} from "../src/auth/gateway-identity";

const root = join(import.meta.dir, "../..");
const secret = "unit-test-secret-0123456789abcdef-xyz";

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("Local-Caller binding (host scrape only)", () => {
  test("Local-Caller + no proxy headers → admin", () => {
    const headers = new Headers({ [LOCAL_CALLER_HEADER]: secret });
    expect(resolveGatewayRequest(secret, headers, Date.now(), {}).kind).toBe(
      "actor",
    );
  });

  test("Local-Caller through gateway (X-Forwarded-For) → refused", () => {
    const headers = new Headers({
      [LOCAL_CALLER_HEADER]: secret,
      "x-forwarded-for": "203.0.113.9",
    });
    expect(resolveGatewayRequest(secret, headers, Date.now(), {}).kind).toBe(
      "refuse",
    );
  });

  test("Local-Caller through X-Real-IP → refused", () => {
    const headers = new Headers({
      [LOCAL_CALLER_HEADER]: secret,
      "x-real-ip": "203.0.113.9",
    });
    expect(resolveGatewayRequest(secret, headers, Date.now(), {}).kind).toBe(
      "refuse",
    );
  });

  test("bare request without Local-Caller → refused", () => {
    expect(
      resolveGatewayRequest(secret, new Headers(), Date.now(), {}).kind,
    ).toBe("refuse");
  });
});

describe("compose templates: internal ports loopback-only", () => {
  for (const file of [
    "deploy/compose.yaml",
    "deploy/magpie.compose.yaml",
  ] as const) {
    test(`${file} publishes only on 127.0.0.1`, () => {
      const lines = extractComposePortLines(read(file));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(composeHostBindIsLoopback(line)).toBe(true);
      }
    });
  }
});

describe("friend-pack TRUSTED_ORIGINS", () => {
  test("friend.env.example is loopback-only", () => {
    const text = read("deploy/friend.env.example");
    const m = /^TRUSTED_ORIGINS=(.+)$/m.exec(text);
    expect(m).toBeTruthy();
    expect(assertTrustedOriginsLoopbackOnly(m![1]!).ok).toBe(true);
  });

  test("deploy/compose.yaml default TRUSTED_ORIGINS is loopback-only", () => {
    const text = read("deploy/compose.yaml");
    const m = /TRUSTED_ORIGINS:\s*(\S+)/.exec(text);
    expect(m).toBeTruthy();
    const raw = m![1]!;
    // compose 允许 `${TRUSTED_ORIGINS:-…}` 让部署者用 .env 扩展；红线校验的是**回退默认值**。
    // 没写 `:-` 的插值会让空值绕过 loopback 检查，所以那种写法直接判失败。
    if (raw.startsWith("${")) expect(raw).toContain(":-");
    const fallback = raw.startsWith("${")
      ? raw.slice(raw.indexOf(":-") + 2, -1)
      : raw;
    expect(assertTrustedOriginsLoopbackOnly(fallback).ok).toBe(true);
  });
});

describe("nginx clears Local-Caller on app proxies", () => {
  test("deploy/public/nginx.conf", () => {
    const result = nginxClearsLocalCallerForAppProxies(
      read("deploy/public/nginx.conf"),
    );
    expect(result.missingNear).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("nginx takes the client IP from Cloudflare only (audit #5)", () => {
  test("real_ip_header CF-Connecting-IP + every official Cloudflare range, nothing wider", () => {
    const conf = read("deploy/public/nginx.conf");
    expect(conf).toMatch(/^\s*real_ip_header CF-Connecting-IP;/m);
    for (const cidr of [
      "173.245.48.0/20",
      "103.21.244.0/22",
      "103.22.200.0/22",
      "103.31.4.0/22",
      "141.101.64.0/18",
      "108.162.192.0/18",
      "190.93.240.0/20",
      "188.114.96.0/20",
      "197.234.240.0/22",
      "198.41.128.0/17",
      "162.158.0.0/15",
      "104.16.0.0/13",
      "104.24.0.0/14",
      "172.64.0.0/13",
      "131.0.72.0/22",
      "2400:cb00::/32",
      "2606:4700::/32",
      "2803:f800::/32",
      "2405:b500::/32",
      "2405:8100::/32",
      "2a06:98c0::/29",
      "2c0f:f248::/32",
    ]) {
      expect(conf).toContain(`set_real_ip_from ${cidr};`);
    }
    expect(conf).not.toMatch(/set_real_ip_from\s+(0\.0\.0\.0\/0|::\/0);/);
    const http = conf.indexOf("http {");
    const firstServer = conf.indexOf("server {");
    const realIp = conf.indexOf("real_ip_header");
    expect(realIp).toBeGreaterThan(http);
    expect(realIp).toBeLessThan(firstServer);
  });
});

describe("nginx pins the client IP headers on every proxy (audit #5)", () => {
  test("each proxied location clears CF-Connecting-IP and sets X-Real-IP $remote_addr", () => {
    const result = nginxPinsClientIpHeaders(read("deploy/public/nginx.conf"));
    expect(result.missingNear).toEqual([]);
    expect(result.proxies).toBeGreaterThanOrEqual(13);
    expect(result.ok).toBe(true);
  });
  test("a location that forwards the client's CF-Connecting-IP is flagged", () => {
    const conf = `location / {\n  proxy_pass http://127.0.0.1:3001;\n  proxy_set_header X-Real-IP $remote_addr;\n}\nlocation /a {\n  proxy_pass http://127.0.0.1:3002;\n  proxy_set_header CF-Connecting-IP "";\n  proxy_set_header X-Real-IP $http_x_real_ip;\n}\n`;
    expect(nginxPinsClientIpHeaders(conf).missingNear).toEqual([
      "location /",
      "location /a",
    ]);
  });
});
describe("deploy scripts refuse 0.0.0.0 app bind", () => {
  test("start.sh and friend-up.sh contain bind refusal", () => {
    const start = read("deploy/start.sh");
    const friend = read("deploy/friend-up.sh");
    expect(start).toMatch(/0\.0\.0\.0/);
    expect(start).toMatch(/127\.0\.0\.1:3001/);
    expect(friend).toMatch(/0\.0\.0\.0/);
    expect(friend).toMatch(/TRUSTED_ORIGINS/);
  });
});

describe("nginx sync process (v0.1.34)", () => {
  test("sync-nginx.sh is executable and mentions Local-Caller + apply", () => {
    const sh = read("scripts/ops/sync-nginx.sh");
    expect(sh).toMatch(/X-ChisaBot-Local-Caller/);
    expect(sh).toMatch(/--apply/);
    expect(sh).toMatch(/--check-repo/);
    expect(read("scripts/ops/deploy-serial.sh")).toMatch(/sync-nginx/);
  });
});

describe("sidecar isolate (PRD-P0-02 / v0.1.39)", () => {
  test("isolate-sidecar-app.sh + deploy-serial + systemd unit", () => {
    const iso = read("scripts/ops/isolate-sidecar-app.sh");
    expect(isolateScriptCoversSidecarDeny(iso).ok).toBe(true);
    const serial = read("scripts/ops/deploy-serial.sh");
    expect(serial).toMatch(/isolate-sidecar-app/);
    expect(serial).toMatch(/exit 8/);
    expect(read("deploy/magpie-isolate.service")).toMatch(
      /isolate-sidecar-app/,
    );
    expect(read("deploy/start.sh")).toMatch(/isolate-sidecar-app/);
    expect(read("scripts/ops/check-trust-boundary.sh")).toMatch(
      /isolate-sidecar-app/,
    );
  });

  for (const probe of [
    {
      name: "reachable HTTP 401",
      exit: 0,
      http: "401",
      ok: false,
      message: "can still reach",
    },
    {
      name: "connection timeout",
      exit: 28,
      http: "000",
      ok: true,
      message: "connection refused or timed out",
    },
    {
      name: "connection refused",
      exit: 7,
      http: "000",
      ok: true,
      message: "connection refused or timed out",
    },
    {
      name: "missing curl",
      exit: 127,
      http: "",
      ok: false,
      message: "probe failed",
    },
    {
      name: "container exec failure",
      exit: 126,
      http: "",
      ok: false,
      message: "probe failed",
    },
    {
      name: "DNS failure",
      exit: 6,
      http: "000",
      ok: false,
      message: "probe failed",
    },
    {
      name: "HTTP response before timeout",
      exit: 28,
      http: "200",
      ok: false,
      message: "can still reach",
    },
  ]) {
    test(`live isolation probe distinguishes ${probe.name}`, () => {
      const source = read("scripts/ops/isolate-sidecar-app.sh").replace(
        /\r\n/g,
        "\n",
      );
      const start = source.indexOf("verify_live() {");
      const end = source.indexOf('\ncase "$MODE" in', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const gitShell = join(
        process.env.ProgramFiles || "C:/Program Files",
        "Git/bin/sh.exe",
      );
      const shell =
        process.platform === "win32" && existsSync(gitShell) ? gitShell : "sh";
      const result = spawnSync(shell, ["-s"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PROBE_EXIT: String(probe.exit),
          PROBE_HTTP: probe.http,
        },
        input: `set -eu
APP=chisabot-zh
MAGPIE=magpie
PORT=3001
fail() { echo "$*" >&2; exit 1; }
ok() { echo "$*"; }
check_rules() { :; }
docker() {
  case "$1:$2" in
    inspect:magpie) return 0 ;;
    exec:magpie)
      printf '%s' "$PROBE_HTTP"
      return "$PROBE_EXIT"
      ;;
    exec:chisabot-zh) echo 401 ;;
    *) return 64 ;;
  esac
}
${source.slice(start, end)}
verify_live
`,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(probe.ok ? 0 : 1);
      expect(result.stdout + result.stderr).toContain(probe.message);
    });
  }

  test("allows matching per-account DSH runtimes while still dropping sidecars and unlabeled peers", () => {
    const source = read("scripts/ops/isolate-sidecar-app.sh").replace(
      /\r\n/g,
      "\n",
    );
    const start = source.indexOf("net_runtime_owner() {");
    const end = source.indexOf("\nverify_live() {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const gitShell = join(
      process.env.ProgramFiles || "C:/Program Files",
      "Git/bin/sh.exe",
    );
    const shell =
      process.platform === "win32" && existsSync(gitShell) ? gitShell : "sh";
    const result = spawnSync(shell, ["-s"], {
      encoding: "utf8",
      input: `set -eu
APP=chisabot-zh
PORT=3001
COMMENT=chisabot-sidecar-iso
NETS=$(printf 'chisabot-dsh-u1-net\nopenbot_magpie\n')
RULES_FILE=$(mktemp)
trap 'rm -f "$RULES_FILE"' EXIT
# Seed a stale DROP rule on the DSH runtime (regression for 0.1.143)
printf '%s\n' "-s 10.250.1.3 -d 10.250.1.2 -p tcp --dport 3001 -m comment --comment chisabot-sidecar-iso -j DROP" > "$RULES_FILE"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }
app_ip_on() {
  case "$1" in
    chisabot-dsh-u1-net) echo 10.250.1.2 ;;
    openbot_magpie) echo 172.20.0.3 ;;
  esac
}
peers_on() {
  case "$1" in
    chisabot-dsh-u1-net)
      printf 'chisabot-dsh-u1 10.250.1.3\nrogue-on-dsh 10.250.1.4\n'
      ;;
    openbot_magpie)
      printf 'magpie 172.20.0.2\nchisabot-dsh-u1 172.20.0.9\n'
      ;;
  esac
}
docker() {
  case "$1:$2:$*" in
    network:inspect:*chisabot-dsh-u1-net) echo "user-1" ;;
    network:inspect:*openbot_magpie) echo "" ;;
    inspect:-f:*runtime-owner*chisabot-dsh-u1) echo "user-1" ;;
    inspect:-f:*runtime-family*chisabot-dsh-u1) echo "chisabot-dsh" ;;
    inspect:-f:*rogue-on-dsh) echo "" ;;
    exec:chisabot-dsh-u1:*) echo "200"; return 0 ;;
    *) return 1 ;;
  esac
}
iptables() {
  # Args: -t filter -C|-I|-D DOCKER-USER <rule...>
  op=$3
  shift 4
  rule="$*"
  case "$op" in
    -C) grep -Fxq -- "$rule" "$RULES_FILE" ;;
    -I) printf '%s\n' "$rule" >> "$RULES_FILE" ;;
    -D)
      grep -Fxv -- "$rule" "$RULES_FILE" > "$RULES_FILE.tmp" || true
      mv "$RULES_FILE.tmp" "$RULES_FILE"
      ;;
  esac
}
${source.slice(start, end)}
apply_or_remove apply
verify_runtime_reachability
echo "=== FINAL RULES ==="
cat "$RULES_FILE"
`,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    // Stale DROP rule on legitimate DSH runtime peer on its dedicated network was removed:
    expect(result.stdout).toContain(
      "ALLOW chisabot-dsh-u1(10.250.1.3) -> chisabot-zh(10.250.1.2):3001 on chisabot-dsh-u1-net",
    );
    expect(result.stdout).not.toContain("-s 10.250.1.3 -d 10.250.1.2");
    // Unlabeled rogue container on DSH net AND sidecars/shared-net peers are still DROPPED:
    expect(result.stdout).toContain(
      "-s 10.250.1.4 -d 10.250.1.2 -p tcp --dport 3001 -m comment --comment chisabot-sidecar-iso -j DROP",
    );
    expect(result.stdout).toContain(
      "-s 172.20.0.2 -d 172.20.0.3 -p tcp --dport 3001 -m comment --comment chisabot-sidecar-iso -j DROP",
    );
    expect(result.stdout).toContain(
      "-s 172.20.0.9 -d 172.20.0.3 -p tcp --dport 3001 -m comment --comment chisabot-sidecar-iso -j DROP",
    );
    expect(result.stdout).toContain(
      "Runtime chisabot-dsh-u1->chisabot-zh(10.250.1.2):3001/health reachable (HTTP 200)",
    );
  });
});
