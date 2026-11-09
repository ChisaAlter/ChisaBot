import { expect, test } from "bun:test";
import { createMagpieService, MAGPIE_MOUNT } from "../src/magpie";
import { createModelCatalogService } from "../src/model-catalog";

const KEY = "magpie-web-key-for-tests-0123456789";

test("status is a safe projection and never carries keys", async () => {
  const seen: string[] = [];
  const magpie = createMagpieService({
    adminUrl: "http://magpie:3430",
    webKey: KEY,
    fetch: (async (url: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("cookie")).toBe(`magpie_web_3430=${KEY}`);
      expect(headers.get("host")).toBe("localhost:3430");
      seen.push(String(url));
      if (String(url).endsWith("/api/settings"))
        return new Response(
          JSON.stringify({
            version: "v0.1.1141",
            gatewayOn: true,
            githubToken: "secret",
          }),
        );
      return new Response(
        JSON.stringify({
          providers: [
            {
              id: "opencode-zen",
              name: "OpenCode Zen",
              ready: true,
              chosen: ["a", "b"],
              exposed: 2,
              key: "sk-secret",
              keyList: ["sk-x"],
            },
            {
              id: "broken",
              name: "Broken",
              ready: false,
              off: true,
              chosen: [],
            },
          ],
        }),
      );
    }) as unknown as typeof fetch,
  });
  const status = await magpie.status();
  expect(seen.length).toBe(2);
  expect(status.reachable).toBe(true);
  expect(status.version).toBe("v0.1.1141");
  expect(status.providers).toEqual([
    {
      id: "opencode-zen",
      name: "OpenCode Zen",
      ready: true,
      enabled: true,
      models: 2,
    },
    { id: "broken", name: "Broken", ready: false, enabled: false, models: 0 },
  ]);
  expect(JSON.stringify(status)).not.toContain("secret");
  // cached
  await magpie.status();
  expect(seen.length).toBe(2);
});

test("proxy injects the key, rewrites /api/ calls under the mount and refuses cross-site writes", async () => {
  let changed = 0;
  const magpie = createMagpieService({
    adminUrl: "http://magpie:3430",
    webKey: KEY,
    fetch: (async (url: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("cookie")).toBe(`magpie_web_3430=${KEY}`);
      if (String(url).endsWith("/app.js"))
        return new Response('fetch("/api/" + p); x=`/api/gateway/trace`;', {
          headers: {
            "content-type": "text/javascript",
            "set-cookie": "a=b",
            etag: "1",
          },
        });
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  magpie.onChange(() => changed++);
  const js = await magpie.proxy(
    new Request("http://localhost:3001/magpie-admin/app.js", {
      headers: { cookie: "browser=1" },
    }),
    "/app.js",
  );
  const body = await js.text();
  expect(body).toContain(`fetch("${MAGPIE_MOUNT}/api/" + p)`);
  expect(body).toContain(`\`${MAGPIE_MOUNT}/api/gateway/trace\``);
  expect(js.headers.get("set-cookie")).toBeNull();
  expect(js.headers.get("content-security-policy")).toBe(
    "frame-ancestors 'self'",
  );

  const cross = await magpie.proxy(
    new Request("http://localhost:3001/magpie-admin/api/provider/save", {
      method: "POST",
      body: "{}",
      headers: { origin: "https://evil.example", host: "localhost:3001" },
    }),
    "/api/provider/save",
  );
  expect(cross.status).toBe(403);
  expect(changed).toBe(0);

  const same = await magpie.proxy(
    new Request("http://localhost:3001/magpie-admin/api/provider/save", {
      method: "POST",
      body: "{}",
      headers: {
        origin: "http://localhost:3001",
        host: "localhost:3001",
        "sec-fetch-site": "same-origin",
      },
    }),
    "/api/provider/save",
  );
  expect(same.status).toBe(200);
  expect(changed).toBe(1);
});

test("catalog keeps Magpie provider names and serves the last list while the gateway is down", async () => {
  let up = true;
  const catalog = createModelCatalogService({
    resolveConnection: async () => ({
      provider: "anthropic",
      model: "opencode-zen/a",
      baseUrl: "http://magpie:3425/v1",
      useApiKey: true,
      apiKey: "k",
    }),
    fetch: (async () => {
      if (!up) throw new Error("down with secret k");
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "opencode-zen/a",
              display_name: "A",
              owned_by: "opencode-zen",
              magpie_label: "A · OpenCode Zen",
            },
          ],
        }),
      );
    }) as unknown as typeof fetch,
  });
  const first = await catalog.list();
  expect(first.source).toBe("magpie");
  expect(first.models[0]?.providerName).toBe("OpenCode Zen");
  up = false;
  catalog.invalidate();
  const stale = await catalog.list();
  expect(stale.stale).toBe(true);
  expect(stale.models.length).toBe(1);
  await expect(catalog.list({ refresh: true })).rejects.toThrow();
  expect(catalog.sync().lastError).toBeTruthy();
  expect(catalog.sync().count).toBe(1);
});
