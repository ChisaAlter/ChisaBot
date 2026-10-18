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
    expect(assertTrustedOriginsLoopbackOnly(m![1]!).ok).toBe(true);
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
