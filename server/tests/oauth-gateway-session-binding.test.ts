import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import {
  createGatewayRequireUser,
  GATEWAY_IDENTITY_HEADER,
  resolveGatewayRequest,
  signGatewayIdentity,
} from "../src/auth/gateway-identity";
import type { AppVariables } from "../src/auth/guards";
import { seal } from "../src/auth/signed-value";
import type { DeploymentConfig } from "../src/config";
import { createAppBuilderRoutes } from "../src/plugins/app-builder";
import {
  createAppPackageStore,
  createMemoryAppPackageStorage,
} from "../src/plugins/app-package";
import { createAppSandboxRunner } from "../src/plugins/app-sandbox-runner";
import { sealConnectState } from "../src/plugins/oauth";
import { createPluginRoutes } from "../src/plugins/routes";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const GATEWAY_SECRET = "gateway-oauth-test-secret-0123456789abcdef";

function gatewayHeadersFor(user: {
  id: string;
  name: string;
  role: "admin" | "user";
}) {
  return {
    [GATEWAY_IDENTITY_HEADER]: signGatewayIdentity(GATEWAY_SECRET, user),
    "x-forwarded-for": "203.0.113.10",
  };
}

function gatewaySessionResolver(headers: Headers): Promise<string | null> {
  const resolved = resolveGatewayRequest(GATEWAY_SECRET, headers);
  return Promise.resolve(resolved.kind === "actor" ? resolved.actor.id : null);
}

async function withWillingOAuthVendor<T>(run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: "at-1",
        refresh_token: "rt-1",
        scope: "read",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("OAuth callback session binding in gateway multi-account mode", () => {
  test("createPluginRoutes refuses /oauth/callback when resolveSessionUserId returns null", async () => {
    const recorded: unknown[] = [];
    const store = {
      serverAddress: async () => undefined,
      oauthClientFor: async () => ({ clientId: "dyn-1", clientSecret: "" }),
      ensureOAuthClient: async () => ({ clientId: "dyn-1", clientSecret: "" }),
      recordConnection: async (row: unknown) => {
        recorded.push(row);
      },
    };
    const asUserA: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", {
        id: "u_friend_a",
        email: "u_friend_a@accounts.chisabot.local",
        role: "user",
      });
      await next();
    };
    const app = new Hono().route(
      "/api/plugins",
      createPluginRoutes(store as never, asUserA, async () => true, {
        publicUrl: "https://chisabot.example",
        appUrl: "https://app.example",
        encryptionKey: KEY,
        personHasAccess: async () => true,
        resolveSessionUserId: async () => null,
      }),
    );

    const state = await sealConnectState(
      { userId: "u_friend_a", serverId: "notion", verifier: "v-1" },
      KEY,
    );

    await withWillingOAuthVendor(async () => {
      const response = await app.request(
        `http://t/api/plugins/oauth/callback?code=c1&state=${encodeURIComponent(state)}`,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("connected=failed");
    });
    expect(recorded).toEqual([]);
  });

  test("createApp enforces gateway identity binding on /api/plugins/oauth/callback and never falls back to DEV_ACTOR", async () => {
    const recorded: Array<{ userId: string; serverId: string }> = [];
    const pluginStore = {
      serverAddress: async () => undefined,
      oauthClientFor: async () => ({ clientId: "dyn-1", clientSecret: "" }),
      ensureOAuthClient: async () => ({ clientId: "dyn-1", clientSecret: "" }),
      recordConnection: async (row: { userId: string; serverId: string }) => {
        recorded.push({ userId: row.userId, serverId: row.serverId });
      },
    };
    const peopleStore = {
      find: async (userId: string) => ({ id: userId, revoked: false }),
    };
    const config = {
      singleUser: true,
      keyEncryptionKey: KEY,
      publicUrl: "https://chisabot.example",
      appUrl: "https://app.example",
      runtime: { mode: "local", durableHistory: true },
      auth: { google: null, microsoft: null, okta: null },
      environment: {},
    } as unknown as DeploymentConfig;

    const app = createApp(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pluginStore as never,
      undefined,
      undefined,
      peopleStore as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        singleUserGuard: createGatewayRequireUser(
          GATEWAY_SECRET,
          async () => {},
        ),
        resolveSessionUserId: gatewaySessionResolver,
      },
    );

    const adminState = await sealConnectState(
      { userId: DEV_ACTOR.id, serverId: "notion", verifier: "v-admin" },
      KEY,
    );
    const friendAState = await sealConnectState(
      { userId: "u_friend_a", serverId: "notion", verifier: "v-a" },
      KEY,
    );

    await withWillingOAuthVendor(async () => {
      // Unauthenticated request via gateway must NOT fall back to DEV_ACTOR.
      const unauthAdmin = await app.request(
        `http://t/api/plugins/oauth/callback?code=c1&state=${encodeURIComponent(adminState)}`,
        { headers: { "x-forwarded-for": "203.0.113.10" } },
      );
      expect(unauthAdmin.status).toBe(302);
      expect(unauthAdmin.headers.get("location")).toContain("connected=failed");

      // Friend B cannot complete Friend A's OAuth flow.
      const wrongUser = await app.request(
        `http://t/api/plugins/oauth/callback?code=c1&state=${encodeURIComponent(friendAState)}`,
        {
          headers: gatewayHeadersFor({
            id: "u_friend_b",
            name: "Friend B",
            role: "user",
          }),
        },
      );
      expect(wrongUser.status).toBe(302);
      expect(wrongUser.headers.get("location")).toContain("connected=failed");
      expect(recorded).toEqual([]);

      // Friend A with valid signed gateway header completes their own OAuth flow.
      const rightUser = await app.request(
        `http://t/api/plugins/oauth/callback?code=c1&state=${encodeURIComponent(friendAState)}`,
        {
          headers: gatewayHeadersFor({
            id: "u_friend_a",
            name: "Friend A",
            role: "user",
          }),
        },
      );
      expect(rightUser.status).toBe(302);
      expect(rightUser.headers.get("location")).toBe(
        "https://app.example/settings/connected-accounts/notion",
      );
      expect(recorded).toEqual([{ userId: "u_friend_a", serverId: "notion" }]);
    });
  });

  test("createApp fails closed on /api/plugins/oauth/callback when singleUserGuard is enabled without resolveSessionUserId", async () => {
    const recorded: unknown[] = [];
    const pluginStore = {
      serverAddress: async () => undefined,
      oauthClientFor: async () => ({ clientId: "dyn-1", clientSecret: "" }),
      ensureOAuthClient: async () => ({ clientId: "dyn-1", clientSecret: "" }),
      recordConnection: async (row: unknown) => {
        recorded.push(row);
      },
    };
    const peopleStore = {
      find: async (userId: string) => ({ id: userId, revoked: false }),
    };
    const config = {
      singleUser: true,
      keyEncryptionKey: KEY,
      publicUrl: "https://chisabot.example",
      appUrl: "https://app.example",
      runtime: { mode: "local", durableHistory: true },
      auth: { google: null, microsoft: null, okta: null },
      environment: {},
    } as unknown as DeploymentConfig;

    const app = createApp(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      pluginStore as never,
      undefined,
      undefined,
      peopleStore as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        singleUserGuard: createGatewayRequireUser(
          GATEWAY_SECRET,
          async () => {},
        ),
      },
    );

    const state = await sealConnectState(
      { userId: DEV_ACTOR.id, serverId: "notion", verifier: "v-1" },
      KEY,
    );

    await withWillingOAuthVendor(async () => {
      const response = await app.request(
        `http://t/api/plugins/oauth/callback?code=c1&state=${encodeURIComponent(state)}`,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("connected=failed");
    });
    expect(recorded).toEqual([]);
  });

  test("app-builder /api/apps/oauth/callback rejects unauthenticated and cross-user gateway callbacks", async () => {
    const store = createAppPackageStore({
      storage: createMemoryAppPackageStorage(),
      encryptionKey: KEY,
    });
    const draft = await store.submitDraft(
      {
        format: "chisabot-app/v1",
        id: "oauth-gateway-app",
        version: "1.0.0",
        name: { en: "OAuth App", "zh-CN": "OAuth 应用" },
        description: { en: "OAuth test app", "zh-CN": "OAuth 测试应用" },
        runtime: { kind: "skills-only" },
        permissions: { network: ["https://vendor.example"], workspace: "none" },
        oauth: {
          type: "oauth2",
          authorizationUrl: "https://vendor.example/oauth/authorize",
          tokenUrl: "https://vendor.example/oauth/token",
          clientId: "cid-1",
          scopes: ["read"],
        },
        skills: [
          {
            id: "oauth-guide",
            path: "skills/SKILL.md",
            name: { en: "Guide", "zh-CN": "指南" },
            description: { en: "Usage guide", "zh-CN": "使用指南" },
            requiresTools: [],
          },
        ],
        files: [
          {
            path: "skills/SKILL.md",
            encoding: "utf8",
            content: "# OAuth App Guide\n",
          },
        ],
      },
      DEV_ACTOR.id,
      { isAdmin: true },
    );

    const runner = createAppSandboxRunner({ store });
    let tokenExchangeCount = 0;
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/apps",
      createAppBuilderRoutes({
        store,
        runner,
        requireUser: createGatewayRequireUser(GATEWAY_SECRET, async () => {}),
        encryptionKey: KEY,
        publicUrl: "https://chisabot.example",
        appUrl: "https://app.example",
        resolveSessionUserId: gatewaySessionResolver,
        oauthTokenFetch: async () => {
          tokenExchangeCount += 1;
          return new Response(
            JSON.stringify({
              access_token: "app-at",
              refresh_token: "app-rt",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    );

    const adminState = await seal(
      JSON.stringify({
        appId: "oauth-gateway-app",
        userId: DEV_ACTOR.id,
        digest: draft.summary.currentDigest,
        verifier: "pkce-verifier-admin",
        exp: Date.now() + 60_000,
      }),
      KEY,
      "chisabot-app-oauth",
    );

    // Unauthenticated callback via gateway must be refused (no DEV_ACTOR fallback).
    const unauth = await app.request(
      `http://t/api/apps/oauth/callback?code=c1&state=${encodeURIComponent(adminState)}`,
      { headers: { "x-forwarded-for": "203.0.113.10" } },
    );
    expect(unauth.status).toBe(302);
    expect(unauth.headers.get("location")).toContain("app_oauth=failed");

    // Friend B cannot complete Admin's app OAuth callback.
    const wrongUser = await app.request(
      `http://t/api/apps/oauth/callback?code=c1&state=${encodeURIComponent(adminState)}`,
      {
        headers: gatewayHeadersFor({
          id: "u_friend_b",
          name: "Friend B",
          role: "user",
        }),
      },
    );
    expect(wrongUser.status).toBe(302);
    expect(wrongUser.headers.get("location")).toContain("app_oauth=failed");
    expect(tokenExchangeCount).toBe(0);

    // Admin with valid signed gateway header succeeds.
    const ok = await app.request(
      `http://t/api/apps/oauth/callback?code=c1&state=${encodeURIComponent(adminState)}`,
      {
        headers: gatewayHeadersFor({
          id: DEV_ACTOR.id,
          name: "Admin",
          role: "admin",
        }),
      },
    );
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toContain("app_oauth=connected");
    expect(tokenExchangeCount).toBe(1);

    // Omitting resolveSessionUserId must also fail closed rather than skipping CSRF binding.
    const appWithoutResolver = new Hono<{ Variables: AppVariables }>().route(
      "/api/apps",
      createAppBuilderRoutes({
        store,
        runner,
        requireUser: createGatewayRequireUser(GATEWAY_SECRET, async () => {}),
        encryptionKey: KEY,
        publicUrl: "https://chisabot.example",
        appUrl: "https://app.example",
        oauthTokenFetch: async () => {
          tokenExchangeCount += 1;
          return new Response(JSON.stringify({ access_token: "unexpected" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    );
    const noResolverRes = await appWithoutResolver.request(
      `http://t/api/apps/oauth/callback?code=c1&state=${encodeURIComponent(adminState)}`,
    );
    expect(noResolverRes.status).toBe(302);
    expect(noResolverRes.headers.get("location")).toContain("app_oauth=failed");
    expect(tokenExchangeCount).toBe(1);

    await runner.shutdown();
  });
});
