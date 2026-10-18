import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const app = createApp(
  loadConfig({
    ...testEnvironment(),
  }),
);

describe("health endpoint", () => {
  test("reports the server as healthy", async () => {
    const response = await app.request("http://openbot.local/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("runtime capabilities", () => {
  test("reports transcription without exposing its endpoint, model, or key", async () => {
    const configured = createApp(
      loadConfig(
        testEnvironment({
          TRANSCRIPTION_PROVIDER: "openai-compatible",
          TRANSCRIPTION_BASE_URL: "https://speech.private.example/v1",
          TRANSCRIPTION_MODEL: "private-speech-model",
          TRANSCRIPTION_API_KEY: "private-speech-key",
        }),
      ),
    );
    const response = await configured.request("/api/capabilities");
    const body = await response.text();
    expect(JSON.parse(body).transcription).toBe(true);
    expect(body).not.toContain("private");
  });
  test("reports the Intelligence runtime without exposing configuration secrets", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: "intelligence",
      durableHistory: true,
      // Default-on. The browser reads this to decide whether to offer the tool that generates an
      // interface, so it has to be here and not only in the runtime.
      generativeUi: true,
      // 设置 → 管理 →「账号」入口：默认隐藏（CHISABOT_ACCOUNTS_UI）。
      accountsUi: false,
      // 功能精简（DESIGN.md §74）：默认隐藏的功能里重新打开的，默认没有。
      extras: [],
      // Default-on: a fresh clone is somebody evaluating the template.
      selfHostBanner: true,
      transcription: false,
      // Names only. The sign-in screen reads this to know which buttons to draw.
      authProviders: ["google"],
    });
  });

  // The runtime object holds the Intelligence API key and licence token. This endpoint has no
  // authentication, so a projection bug here publishes deployment secrets to anyone who asks.
  test("never serves the Intelligence credentials", async () => {
    const response = await app.request("http://openbot.local/api/capabilities");
    const body = await response.text();
    const parsed = (await new Response(body).json()) as Record<string, unknown>;

    expect(body).not.toContain("tenant-api-key");
    expect(body).not.toContain("license-token");
    // The settings object itself must not be projected, whatever it happens to hold today.
    expect(Object.keys(parsed)).toEqual([
      "mode",
      "durableHistory",
      "generativeUi",
      "accountsUi",
      "extras",
      "selfHostBanner",
      "transcription",
      "authProviders",
    ]);
    // The provider list is names, never the clients and secrets behind them.
    expect(body).not.toContain("google-client-secret");
  });

  /*
   * The answer has to reach the browser, not just the runtime.
   *
   * The app offers the model the tool that generates an interface, and it decides whether to from
   * this field. The two halves disagreeing is the one configuration this capability must not be able
   * to end up in: runtime-only means the tool is never offered, browser-only means a Bot writes a
   * whole interface that nothing renders.
   */
  test("reports generated interfaces as off when the deployment opts out", async () => {
    const disabled = createApp(
      loadConfig(testEnvironment({ OPENBOT_GENERATIVE_UI: "false" })),
    );

    const response = await disabled.request(
      "http://openbot.local/api/capabilities",
    );

    expect(response.status).toBe(200);
    expect((await response.json()).generativeUi).toBe(false);
  });

  // A fork running OpenBot for its own people turns the banner off, and the browser has to hear it.
  test("reports the self-host banner as off when the deployment opts out", async () => {
    const disabled = createApp(
      loadConfig(testEnvironment({ OPENBOT_SELF_HOST_BANNER: "false" })),
    );

    const response = await disabled.request(
      "http://openbot.local/api/capabilities",
    );

    expect(response.status).toBe(200);
    expect((await response.json()).selfHostBanner).toBe(false);
  });
});

describe("authentication availability", () => {
  test("fails loudly when no identity provider has been configured", async () => {
    const response = await app.request(
      "http://openbot.local/api/auth/sign-in/social",
      { method: "POST" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "No identity provider is configured.",
    });
  });

  test("forwards auth requests to the configured Better Auth handler", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response("mounted", { status: 204 }),
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/callback/google",
    );

    expect(response.status).toBe(204);
  });

  test("forwards logout requests to Better Auth", async () => {
    const authenticatedApp = createApp(
      loadConfig({
        ...testEnvironment(),
      }),
      {
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => null,
        },
      },
    );

    const response = await authenticatedApp.request(
      "http://openbot.local/api/auth/sign-out",
      { method: "POST" },
    );

    expect(response.status).toBe(204);
  });
});

/** /api/auth/* goes straight to Better Auth (the SSO plugin and its admin gate went in slimming P6-2). */
describe("auth routes", () => {
  function appFor(roles: ("admin" | "user")[], signedIn = true) {
    let reachedHandler = false;
    const app = createApp(
      loadConfig(testEnvironment()),
      {
        handler: () => {
          reachedHandler = true;
          return new Response(null, { status: 200 });
        },
        api: {
          getSession: async () =>
            signedIn ? { user: { id: "u1", email: "u1@openbot.test" } } : null,
        },
      } as never,
      { rolesForUser: async () => roles },
    );
    return { app, reached: () => reachedHandler };
  }

  // Everything else under /api/auth is Better Auth's own business, including sign-in itself, which
  // by definition happens before anybody has a role.
  test("leaves the rest of the auth routes alone", async () => {
    const { app, reached } = appFor([], false);

    await app.request("http://openbot.test/api/auth/sign-in/social", {
      method: "POST",
    });

    expect(reached()).toBe(true);
  });
});

describe("version endpoint", () => {
  test("reports version fields without leaking secrets or build paths", async () => {
    const response = await app.request("http://openbot.local/api/version");
    expect(response.status).toBe(200);
    const body = await response.text();
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(typeof parsed.version).toBe("string");
    expect(typeof parsed.buildId).toBe("string");
    for (const key of Object.keys(parsed)) {
      expect(["version", "buildId", "commit", "builtAt"]).toContain(key);
    }
    expect(body).not.toContain("tenant-api-key");
    expect(body).not.toContain("license-token");
    expect(body).not.toContain("/app/");
    expect(body).not.toMatch(/postgres(?:ql)?:\/\//i);
  });
});
