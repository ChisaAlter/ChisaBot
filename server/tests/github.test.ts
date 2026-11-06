import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { githubTokenKind } from "../../shared/github";
import { createDatabase } from "../src/db/client";
import { canConfirm, createGithub, githubGuidance } from "../src/github/service";
import { createVault } from "../src/vault/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** GitHub 账号连接（DESIGN.md §53）：令牌校验 + 存保险箱、读工具、写操作要确认、令牌不出服务器。 */
describe("helpers", () => {
  test("token kind", () => {
    expect(githubTokenKind("github_pat_11AAA")).toBe("fine-grained");
    expect(githubTokenKind("ghp_abc")).toBe("classic");
    expect(githubTokenKind("xyz")).toBe("other");
  });
  test("only a person in the web chat can confirm writes", () => {
    expect(canConfirm(undefined)).toBe(true);
    expect(canConfirm({ kind: "person" })).toBe(true);
    expect(canConfirm({ kind: "person", surface: "web" })).toBe(true);
    // The app has no GitHub action card yet: a write there must be refused, not hung.
    expect(canConfirm({ kind: "person", surface: "app" })).toBe(false);
    expect(canConfirm({ kind: "routine", id: "im:x" })).toBe(false);
    expect(canConfirm({ kind: "handoff", id: "w" })).toBe(false);
  });
  test("guidance never contains a token", () => {
    expect(githubGuidance(null)).toContain("[连接 GitHub](/settings/connected-accounts/github)");
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("github", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const GOOD = "github_pat_11GOODTOKEN0000000000000000000000";
  const seen: { method: string; url: string; auth: string; body?: string }[] = [];
  const reply = (status: number, data: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    seen.push({ method: init?.method ?? "GET", url: u.toString(), auth, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (auth !== `Bearer ${GOOD}`) return reply(401, { message: "Bad credentials" });
    const p = u.pathname;
    if (p === "/user") return reply(200, { login: "octo", name: "Octo Cat", avatar_url: "https://a/x.png", html_url: "https://github.com/octo" });
    if (p === "/user/repos")
      return reply(200, [{ full_name: "octo/demo", private: true, description: "演示", stargazers_count: 3, language: "TS", pushed_at: "2026-10-01T00:00:00Z", default_branch: "main", fork: false }]);
    if (p === "/repos/octo/demo/issues" && (init?.method ?? "GET") === "GET")
      return reply(200, [
        { number: 1, title: "Bug A", state: "open", user: { login: "u" }, comments: 2, labels: [{ name: "bug" }], updated_at: "2026-10-02T00:00:00Z" },
        { number: 2, title: "PR B", state: "open", user: { login: "u" }, comments: 0, labels: [], updated_at: "2026-10-02T00:00:00Z", pull_request: {} },
      ]);
    if (p === "/repos/octo/demo/contents/src/a.ts") return reply(200, { type: "file", name: "a.ts", path: "src/a.ts", size: 20, encoding: "base64", content: Buffer.from(`export const t = "${GOOD}";`).toString("base64") });
    if (p === "/repos/octo/demo/issues" && init?.method === "POST") return reply(201, { number: 7, html_url: "https://github.com/octo/demo/issues/7" });
    if (p === "/repos/octo/private/issues") return reply(404, { message: "Not Found" });
    return reply(404, { message: "Not Found" });
  }) as typeof fetch;
  const vault = url ? createVault(database, { encryptionKey: key, fetch: fakeFetch }) : (null as never);
  const github = url ? createGithub(database, { vault, fetch: fakeFetch }) : (null as never);
  const owner = `ghtest-${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    await vault.ensure();
    await github.ensure();
  });
  afterAll(async () => {
    for (const t of ["chisabot_vault_secrets", "chisabot_vault_requests", "chisabot_github_connections", "chisabot_github_actions"])
      await database.$client.unsafe(`DELETE FROM ${t} WHERE owner_user_id = $1`, [owner]);
  });

  test("an invalid token is refused and nothing is saved", async () => {
    await expect(github.connect(owner, "github_pat_11BADTOKEN000000000000000000000")).rejects.toThrow("无效");
    expect(await github.status(owner)).toBeNull();
    expect(await vault.list(owner)).toHaveLength(0);
    expect(await github.tools(owner, "bot")).toHaveLength(0);
  });

  test("a valid token connects, lands in the vault encrypted and reserved", async () => {
    const view = await github.connect(owner, GOOD);
    expect(view.login).toBe("octo");
    expect(view.tokenKind).toBe("fine-grained");
    expect(JSON.stringify(view)).not.toContain(GOOD);
    const secrets = await vault.list(owner);
    expect(secrets[0]!.name).toBe("github");
    expect(secrets[0]!.managedBy).toBe("github");
    expect(secrets[0]!.domains).toEqual(["api.github.com"]);
    const [row] = await database.$client.unsafe<{ value: string }[]>("SELECT value FROM chisabot_vault_secrets WHERE owner_user_id = $1", [owner]);
    expect(row!.value).not.toContain(GOOD);
    // 保险箱里不能改、不能删、api_request 不能用、不能用卡片要
    await expect(vault.save(owner, { name: "github", label: "x", domains: ["evil.com"], value: "zzzzzzzzzz" })).rejects.toThrow("账号连接");
    await expect(vault.remove(owner, secrets[0]!.id)).rejects.toThrow("账号连接");
    const api = vault.tools(owner, "bot").find((t) => t.name === "api_request")!;
    expect(await api.execute({ url: "https://api.github.com/user", headers: { Authorization: "Bearer {{secret:github}}" } })).toContain("github_*");
    expect(githubGuidance(view)).toContain("@octo");
  });

  test("read tools work and never echo the token", async () => {
    const tools = await github.tools(owner, "bot");
    expect(tools.map((t) => t.name)).toContain("github_create_pr");
    const run = (name: string, args: unknown) => tools.find((t) => t.name === name)!.execute(args);
    expect(await run("github_list_repos", {})).toContain("octo/demo（私有）");
    const issues = await run("github_list_issues", { repo: "octo/demo" });
    expect(issues).toContain("#1 [open] Bug A");
    expect(issues).not.toContain("PR B");
    const file = await run("github_read_file", { repo: "octo/demo", path: "src/a.ts" });
    expect(file).toContain("export const t");
    expect(file).not.toContain(GOOD);
    expect(await run("github_list_issues", { repo: "octo/private" })).toContain("找不到");
    expect(await run("github_list_issues", { repo: "../etc" })).toContain("owner/name");
    for (const s of seen) expect(new URL(s.url).hostname).toBe("api.github.com");
  });

  test("writes wait for the user's yes; no runs without it", async () => {
    const tools = await github.tools(owner, "bot", { kind: "person" });
    const create = tools.find((t) => t.name === "github_create_issue")!;
    const before = seen.filter((s) => s.method === "POST").length;
    const pending = create.execute({ repo: "octo/demo", title: "新 Issue", body: "正文" });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.filter((s) => s.method === "POST").length).toBe(before); // 还没确认，什么都没发
    const [row] = await database.$client.unsafe<{ id: string }[]>("SELECT id FROM chisabot_github_actions WHERE owner_user_id = $1 AND status = 'pending'", [owner]);
    const done = await github.decide(owner, row!.id, true);
    expect(done.status).toBe("done");
    expect(done.result?.number).toBe(7);
    expect(await pending).toContain("Issue #7");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(before + 1);
    // 再点一次不会重复发
    await github.decide(owner, row!.id, true);
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(before + 1);

    const second = create.execute({ repo: "octo/demo", title: "另一个" });
    await new Promise((r) => setTimeout(r, 300));
    const [row2] = await database.$client.unsafe<{ id: string }[]>("SELECT id FROM chisabot_github_actions WHERE owner_user_id = $1 AND status = 'pending'", [owner]);
    expect((await github.decide(owner, row2!.id, false)).status).toBe("rejected");
    expect(await second).toContain("拒绝");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(before + 1);
  });

  test("background turns cannot write", async () => {
    const tools = await github.tools(owner, "bot", { kind: "routine", id: "im:abc" });
    expect(await tools.find((t) => t.name === "github_comment")!.execute({ repo: "octo/demo", number: 1, body: "hi" })).toContain("不在网页聊天");
  });

  test("disconnect removes the token and the tools", async () => {
    await github.disconnect(owner);
    expect(await github.status(owner)).toBeNull();
    expect(await vault.list(owner)).toHaveLength(0);
    expect(await github.tools(owner, "bot")).toHaveLength(0);
  });
});
