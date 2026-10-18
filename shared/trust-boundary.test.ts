import { describe, expect, test } from "bun:test";
import {
  assertTrustedOriginsLoopbackOnly,
  composeHostBindIsLoopback,
  extractComposePortLines,
  isLoopbackHostname,
  isLoopbackOrigin,
  nginxClearsLocalCallerForAppProxies,
} from "./trust-boundary";

describe("loopback hostname / origin", () => {
  test("loopback hosts accepted", () => {
    for (const h of ["localhost", "127.0.0.1", "127.0.0.2", "::1", "[::1]"]) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
    expect(isLoopbackOrigin("http://127.0.0.1:3001")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:3001")).toBe(true);
  });

  test("LAN / public / garbage denied", () => {
    expect(isLoopbackHostname("192.168.1.1")).toBe(false);
    expect(isLoopbackHostname("ayase.cn")).toBe(false);
    expect(isLoopbackOrigin("https://ayase.cn:8443")).toBe(false);
    expect(isLoopbackOrigin("http://192.168.1.10:3001")).toBe(false);
    expect(isLoopbackOrigin("not-a-url")).toBe(false);
  });
});

describe("TRUSTED_ORIGINS friend-pack rule", () => {
  test("loopback http list ok", () => {
    expect(
      assertTrustedOriginsLoopbackOnly(
        "http://localhost:3001,http://127.0.0.1:3001",
      ).ok,
    ).toBe(true);
  });

  test("https or LAN refused", () => {
    expect(assertTrustedOriginsLoopbackOnly("https://ayase.cn").ok).toBe(false);
    expect(
      assertTrustedOriginsLoopbackOnly("http://192.168.1.10:3001").ok,
    ).toBe(false);
    expect(assertTrustedOriginsLoopbackOnly("").ok).toBe(false);
  });
});

describe("compose host bind", () => {
  test("127.0.0.1 publish accepted; bare / 0.0.0.0 refused", () => {
    expect(composeHostBindIsLoopback('- "127.0.0.1:3001:3001"')).toBe(true);
    expect(composeHostBindIsLoopback("127.0.0.1:3425:3425")).toBe(true);
    expect(composeHostBindIsLoopback('"3001:3001"')).toBe(false);
    expect(composeHostBindIsLoopback("0.0.0.0:3001:3001")).toBe(false);
    expect(composeHostBindIsLoopback("[::]:3001:3001")).toBe(false);
  });

  test("extractComposePortLines finds short publishes", () => {
    const yaml = `
services:
  openbot:
    ports:
      - "127.0.0.1:3001:3001"
    environment:
      X: 1
  magpie:
    ports:
      - "127.0.0.1:3425:3425"
      - "0.0.0.0:3430:3430"
`;
    const lines = extractComposePortLines(yaml);
    expect(lines.length).toBe(3);
    expect(lines.every((l) => composeHostBindIsLoopback(l))).toBe(false);
  });
});

describe("nginx Local-Caller clear", () => {
  test("missing clear is detected; present passes", () => {
    const bad = `
        location / {
            proxy_pass http://127.0.0.1:3001;
            proxy_set_header X-ChisaBot-Identity $cb_identity;
        }
`;
    expect(nginxClearsLocalCallerForAppProxies(bad).ok).toBe(false);
    const good = `
        location / {
            proxy_pass http://127.0.0.1:3001;
            proxy_set_header X-ChisaBot-Local-Caller "";
            proxy_set_header X-ChisaBot-Identity $cb_identity;
        }
`;
    expect(nginxClearsLocalCallerForAppProxies(good).ok).toBe(true);
  });
});
