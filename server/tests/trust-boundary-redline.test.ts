/**
 * Trust-boundary network isolation red-line (v0.1.33).
 *
 * Complements SSRF red-line (PRD-P1-06): who-can-reach-whom for Local-Caller,
 * compose port publishes, friend TRUSTED_ORIGINS, and nginx header clearing.
 * Wired in .github/workflows/chisabot.yml — must stay green on every PR.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCAL_CALLER_HEADER,
  resolveGatewayRequest,
} from "../src/auth/gateway-identity";
import {
  assertTrustedOriginsLoopbackOnly,
  composeHostBindIsLoopback,
  extractComposePortLines,
  nginxClearsLocalCallerForAppProxies,
  nginxPinsClientIpHeaders,
  isolateScriptCoversSidecarDeny,
} from "../../shared/trust-boundary";

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
    expect(resolveGatewayRequest(secret, new Headers(), Date.now(), {}).kind).toBe(
      "refuse",
    );
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
    for (const cidr of ["173.245.48.0/20","103.21.244.0/22","103.22.200.0/22","103.31.4.0/22","141.101.64.0/18","108.162.192.0/18","190.93.240.0/20","188.114.96.0/20","197.234.240.0/22","198.41.128.0/17","162.158.0.0/15","104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","131.0.72.0/22","2400:cb00::/32","2606:4700::/32","2803:f800::/32","2405:b500::/32","2405:8100::/32","2a06:98c0::/29","2c0f:f248::/32"]) {
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
    expect(nginxPinsClientIpHeaders(conf).missingNear).toEqual(["location /", "location /a"]);
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
    expect(read("deploy/magpie-isolate.service")).toMatch(/isolate-sidecar-app/);
    expect(read("deploy/start.sh")).toMatch(/isolate-sidecar-app/);
    expect(read("scripts/ops/check-trust-boundary.sh")).toMatch(/isolate-sidecar-app/);
  });
});
