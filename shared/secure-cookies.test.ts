import { describe, expect, test } from "bun:test";
import { useSecureCookies } from "./secure-cookies";

describe("useSecureCookies (Track D / PRD-P2-04)", () => {
  test("https auth base URL forces Secure", () => {
    expect(useSecureCookies({ authBaseUrl: "https://ayase.cn:8443" })).toBe(true);
  });

  test("https public URL forces Secure even when auth base is http loopback", () => {
    expect(
      useSecureCookies({
        authBaseUrl: "http://127.0.0.1:3001",
        publicUrl: "https://chat.example.com:8443",
      }),
    ).toBe(true);
  });

  test("http loopback stays off", () => {
    expect(
      useSecureCookies({
        authBaseUrl: "http://localhost:3001",
        publicUrl: "http://127.0.0.1:3001",
      }),
    ).toBe(false);
  });

  test("CHISABOT_SECURE_COOKIES=1 forces on", () => {
    expect(useSecureCookies({ authBaseUrl: "http://127.0.0.1:3001", force: "1" })).toBe(true);
  });

  test("CHISABOT_SECURE_COOKIES=0 forces off even on https", () => {
    expect(useSecureCookies({ authBaseUrl: "https://example.com", force: "0" })).toBe(false);
  });
});
