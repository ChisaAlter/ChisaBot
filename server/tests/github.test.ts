import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ACTION_GUIDANCE } from "../../shared/bot-prompt";
import {
  type GithubConnectionView,
  githubTokenKind,
} from "../../shared/github";
import { describeWorkerStep } from "../../shared/work-step";
import { createDatabase, type Database } from "../src/db/client";
import {
  canConfirm,
  createGithub,
  githubConnectResult,
  githubGuidance,
} from "../src/github/service";
import { createVault, type Vault } from "../src/vault/service";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

function makeConnection(
  overrides: Partial<GithubConnectionView> = {},
): GithubConnectionView {
  return {
    login: "octo",
    name: "Octo Cat",
    avatarUrl: "https://a/x.png",
    htmlUrl: "https://github.com/octo",
    tokenKind: "fine-grained",
    scopes: [],
    hint: "••••0000",
    status: "ok",
    connectedAt: "2026-10-01T00:00:00.000Z",
    checkedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

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
  test("guidance prioritizes github_connect and forbids inline path hints when disconnected or invalid", () => {
    const disconnected = githubGuidance(null);
    expect(disconnected).toContain("github_connect");
    expect(disconnected).toContain("git 地址/远程地址");
    expect(disconnected).toContain("clone/push");
    expect(disconnected).toContain(
      "不要把 `/settings/connected-accounts/github` 塞进括号或行内反引号里",
    );
    expect(disconnected.split("\n")).toContain(
      "[连接 GitHub](/settings/connected-accounts/github)",
    );

    const invalid = githubGuidance(makeConnection({ status: "invalid" }));
    expect(invalid).toContain("@octo");
    expect(invalid).toContain("github_connect");
    expect(invalid).toContain("更换令牌");
    expect(invalid).toContain(
      "不要把 `/settings/connected-accounts/github` 塞进括号或行内反引号里",
    );
    expect(invalid.split("\n")).toContain(
      "[连接 GitHub](/settings/connected-accounts/github)",
    );

    const ok = githubGuidance(makeConnection({ status: "ok" }));
    expect(ok).toContain("@octo");
    expect(ok).toContain("github_*");
  });
  test("githubConnectResult covers disconnected, connected, invalid and non-web fallback", () => {
    const webDisconnected = githubConnectResult(null, {
      kind: "person",
      surface: "web",
    });
    expect(webDisconnected).toStartWith("⟦github:connect⟧");
    expect(webDisconnected).toContain("连接 GitHub");
    expect(webDisconnected).not.toContain(
      "[连接 GitHub](/settings/connected-accounts/github)",
    );

    const imDisconnected = githubConnectResult(null, {
      kind: "routine",
      id: "im:room-1",
    });
    expect(imDisconnected).toStartWith("⟦github:connect⟧");
    expect(imDisconnected.split("\n")).toContain(
      "[连接 GitHub](/settings/connected-accounts/github)",
    );

    const webInvalid = githubConnectResult(
      makeConnection({ status: "invalid" }),
      { kind: "person", surface: "web" },
    );
    expect(webInvalid).toStartWith("⟦github:reconnect⟧");
    expect(webInvalid).toContain("@octo");
    expect(webInvalid).not.toContain(
      "[连接 GitHub](/settings/connected-accounts/github)",
    );

    const appInvalid = githubConnectResult(
      makeConnection({ status: "invalid" }),
      { kind: "person", surface: "app" },
    );
    expect(appInvalid).toStartWith("⟦github:reconnect⟧");
    expect(appInvalid.split("\n")).toContain(
      "[连接 GitHub](/settings/connected-accounts/github)",
    );

    const ok = githubConnectResult(makeConnection({ status: "ok" }));
    expect(ok).toBe(
      "⟦github:connected:@octo⟧ 已连接 GitHub 账号 @octo，可直接调用 github_* 工具读取仓库、Issue、PR、文件或发起写操作。",
    );
  });
  test("tools exposes only github_connect when disconnected and includes it when connected or invalid", async () => {
    let row: {
      owner_user_id: string;
      login: string;
      name: string | null;
      avatar_url: string | null;
      html_url: string;
      token_kind: string;
      scopes: string;
      status: "ok" | "invalid";
      connected_at: string;
      checked_at: string;
    } | null = null;
    let hasSecret = false;

    const fakeDb = {
      $client: {
        unsafe: async () => (row ? [row] : []),
      },
    } as unknown as Database;
    const fakeVault = {
      list: async () =>
        hasSecret
          ? [
              {
                id: "sec_1",
                name: "github",
                label: "GitHub 访问令牌",
                domains: ["api.github.com"],
                hint: "••••0000",
                managedBy: "github",
              },
            ]
          : [],
    } as unknown as Vault;

    const gh = createGithub(fakeDb, { vault: fakeVault });

    const disconnectedTools = await gh.tools("u1", "bot", {
      kind: "person",
      surface: "web",
    });
    expect(disconnectedTools.map((t) => t.name)).toEqual(["github_connect"]);
    const connectTool = disconnectedTools[0];
    expect(connectTool?.ref).toBe("github/github_connect");
    expect(
      await connectTool?.execute({
        reason: "读取仓库代码",
        repo: "octo/demo",
      }),
    ).toStartWith("⟦github:connect⟧");
    expect(await connectTool?.execute({ unknown: true })).toContain("Refused.");
    expect(await connectTool?.execute({ reason: "a".repeat(201) })).toContain(
      "Refused.",
    );

    const imTools = await gh.tools("u1", "bot", {
      kind: "routine",
      id: "im:1",
    });
    expect(imTools.map((t) => t.name)).toEqual(["github_connect"]);
    expect((await imTools[0]?.execute({}))?.split("\n")).toContain(
      "[连接 GitHub](/settings/connected-accounts/github)",
    );

    row = {
      owner_user_id: "u1",
      login: "octo",
      name: "Octo Cat",
      avatar_url: null,
      html_url: "https://github.com/octo",
      token_kind: "fine-grained",
      scopes: "",
      status: "ok",
      connected_at: "2026-10-01T00:00:00.000Z",
      checked_at: "2026-10-01T00:00:00.000Z",
    };
    hasSecret = true;

    const connectedTools = await gh.tools("u1", "bot", {
      kind: "person",
      surface: "web",
    });
    expect(connectedTools.map((t) => t.name)).toContain("github_connect");
    expect(connectedTools.map((t) => t.name)).toContain("github_list_repos");
    expect(connectedTools.map((t) => t.name)).toContain("github_create_pr");
    const connectedConnectTool = connectedTools.find(
      (t) => t.name === "github_connect",
    );
    expect(await connectedConnectTool?.execute({})).toBe(
      "⟦github:connected:@octo⟧ 已连接 GitHub 账号 @octo，可直接调用 github_* 工具读取仓库、Issue、PR、文件或发起写操作。",
    );

    row = { ...row, status: "invalid" };
    const invalidTools = await gh.tools("u1", "bot", {
      kind: "person",
      surface: "web",
    });
    const invalidConnectTool = invalidTools.find(
      (t) => t.name === "github_connect",
    );
    expect(await invalidConnectTool?.execute({})).toStartWith(
      "⟦github:reconnect⟧",
    );
  });
  test("describeWorkerStep formats github_connect and personal-sources connect steps", () => {
    expect(describeWorkerStep("github_connect", {})).toBe(
      "正在推出 GitHub 连接流程",
    );
    expect(describeWorkerStep("connect_service", {})).toBe(
      "正在检查可用连接器",
    );
    expect(describeWorkerStep("calendar_connect", {})).toBe(
      "正在推出日历连接流程",
    );
    expect(describeWorkerStep("email_connect", {})).toBe(
      "正在推出邮箱连接流程",
    );
    expect(describeWorkerStep("notify_webhook_connect", {})).toBe(
      "正在推出通知推送绑定流程",
    );
  });
  test("ACTION_GUIDANCE guides in-chat connect cards instead of sending secrets in chat", () => {
    expect(ACTION_GUIDANCE).toContain("calendar_connect");
    expect(ACTION_GUIDANCE).toContain("email_connect");
    expect(ACTION_GUIDANCE).toContain("notify_webhook_connect");
    expect(ACTION_GUIDANCE).not.toContain("直接发来了日历 ICS 链接或邮箱+应用专用密码");
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("github", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64",
  );
  const GOOD = "github_pat_11GOODTOKEN0000000000000000000000";
  const seen: { method: string; url: string; auth: string; body?: string }[] =
    [];
  const reply = (
    status: number,
    data: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    seen.push({
      method: init?.method ?? "GET",
      url: u.toString(),
      auth,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (auth !== `Bearer ${GOOD}`)
      return reply(401, { message: "Bad credentials" });
    const p = u.pathname;
    if (p === "/user")
      return reply(200, {
        login: "octo",
        name: "Octo Cat",
        avatar_url: "https://a/x.png",
        html_url: "https://github.com/octo",
      });
    if (p === "/user/repos")
      return reply(200, [
        {
          full_name: "octo/demo",
          private: true,
          description: "演示",
          stargazers_count: 3,
          language: "TS",
          pushed_at: "2026-10-01T00:00:00Z",
          default_branch: "main",
          fork: false,
        },
      ]);
    if (p === "/repos/octo/demo/issues" && (init?.method ?? "GET") === "GET")
      return reply(200, [
        {
          number: 1,
          title: "Bug A",
          state: "open",
          user: { login: "u" },
          comments: 2,
          labels: [{ name: "bug" }],
          updated_at: "2026-10-02T00:00:00Z",
        },
        {
          number: 2,
          title: "PR B",
          state: "open",
          user: { login: "u" },
          comments: 0,
          labels: [],
          updated_at: "2026-10-02T00:00:00Z",
          pull_request: {},
        },
      ]);
    if (p === "/repos/octo/demo/contents/src/a.ts")
      return reply(200, {
        type: "file",
        name: "a.ts",
        path: "src/a.ts",
        size: 20,
        encoding: "base64",
        content: Buffer.from(`export const t = "${GOOD}";`).toString("base64"),
      });
    if (p === "/repos/octo/demo/issues" && init?.method === "POST")
      return reply(201, {
        number: 7,
        html_url: "https://github.com/octo/demo/issues/7",
      });
    if (p === "/repos/octo/private/issues")
      return reply(404, { message: "Not Found" });
    return reply(404, { message: "Not Found" });
  }) as typeof fetch;
  const vault = url
    ? createVault(database, { encryptionKey: key, fetch: fakeFetch })
    : (null as never);
  const github = url
    ? createGithub(database, { vault, fetch: fakeFetch })
    : (null as never);
  const owner = `ghtest-${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    await vault.ensure();
    await github.ensure();
  });
  afterAll(async () => {
    for (const t of [
      "chisabot_vault_secrets",
      "chisabot_vault_requests",
      "chisabot_github_connections",
      "chisabot_github_actions",
    ])
      await database.$client.unsafe(
        `DELETE FROM ${t} WHERE owner_user_id = $1`,
        [owner],
      );
  });

  test("an invalid token is refused and nothing is saved", async () => {
    await expect(
      github.connect(owner, "github_pat_11BADTOKEN000000000000000000000"),
    ).rejects.toThrow("无效");
    expect(await github.status(owner)).toBeNull();
    expect(await vault.list(owner)).toHaveLength(0);
    const tools = await github.tools(owner, "bot");
    expect(tools.map((t) => t.name)).toEqual(["github_connect"]);
    expect(await tools[0]?.execute({ reason: "查看仓库" })).toStartWith(
      "⟦github:connect⟧",
    );
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
    const [row] = await database.$client.unsafe<{ value: string }[]>(
      "SELECT value FROM chisabot_vault_secrets WHERE owner_user_id = $1",
      [owner],
    );
    expect(row!.value).not.toContain(GOOD);
    // 保险箱里不能改、不能删、api_request 不能用、不能用卡片要
    await expect(
      vault.save(owner, {
        name: "github",
        label: "x",
        domains: ["evil.com"],
        value: "zzzzzzzzzz",
      }),
    ).rejects.toThrow("账号连接");
    await expect(vault.remove(owner, secrets[0]!.id)).rejects.toThrow(
      "账号连接",
    );
    const api = vault
      .tools(owner, "bot")
      .find((t) => t.name === "api_request")!;
    expect(
      await api.execute({
        url: "https://api.github.com/user",
        headers: { Authorization: "Bearer {{secret:github}}" },
      }),
    ).toContain("github_*");
    expect(githubGuidance(view)).toContain("@octo");
  });

  test("read tools work and never echo the token", async () => {
    const tools = await github.tools(owner, "bot");
    expect(tools.map((t) => t.name)).toContain("github_connect");
    expect(tools.map((t) => t.name)).toContain("github_create_pr");
    const run = (name: string, args: unknown) =>
      tools.find((t) => t.name === name)!.execute(args);
    expect(await run("github_connect", {})).toContain(
      "⟦github:connected:@octo⟧",
    );
    expect(await run("github_list_repos", {})).toContain("octo/demo（私有）");
    const issues = await run("github_list_issues", { repo: "octo/demo" });
    expect(issues).toContain("#1 [open] Bug A");
    expect(issues).not.toContain("PR B");
    const file = await run("github_read_file", {
      repo: "octo/demo",
      path: "src/a.ts",
    });
    expect(file).toContain("export const t");
    expect(file).not.toContain(GOOD);
    expect(await run("github_list_issues", { repo: "octo/private" })).toContain(
      "找不到",
    );
    expect(await run("github_list_issues", { repo: "../etc" })).toContain(
      "owner/name",
    );
    for (const s of seen)
      expect(new URL(s.url).hostname).toBe("api.github.com");
  });

  async function waitForPendingAction() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [row] = await database.$client.unsafe<{ id: string }[]>(
        "SELECT id FROM chisabot_github_actions WHERE owner_user_id = $1 AND status = 'pending'",
        [owner],
      );
      if (row) return row;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("pending github action never appeared");
  }

  test("writes wait for the user's yes; no runs without it", async () => {
    const tools = await github.tools(owner, "bot", { kind: "person" });
    const create = tools.find((t) => t.name === "github_create_issue")!;
    const before = seen.filter((s) => s.method === "POST").length;
    const pending = create.execute({
      repo: "octo/demo",
      title: "新 Issue",
      body: "正文",
    });
    const row = await waitForPendingAction();
    expect(seen.filter((s) => s.method === "POST").length).toBe(before); // 还没确认，什么都没发
    const done = await github.decide(owner, row!.id, true);
    expect(done.status).toBe("done");
    expect(done.result?.number).toBe(7);
    expect(await pending).toContain("Issue #7");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(before + 1);
    // 再点一次不会重复发
    await github.decide(owner, row!.id, true);
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(before + 1);

    const second = create.execute({ repo: "octo/demo", title: "另一个" });
    const row2 = await waitForPendingAction();
    expect((await github.decide(owner, row2.id, false)).status).toBe(
      "rejected",
    );
    expect(await second).toContain("拒绝");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(before + 1);
  });

  test("background turns cannot write", async () => {
    const tools = await github.tools(owner, "bot", {
      kind: "routine",
      id: "im:abc",
    });
    expect(
      await tools
        .find((t) => t.name === "github_comment")!
        .execute({ repo: "octo/demo", number: 1, body: "hi" }),
    ).toContain("不在网页聊天");
  });

  test("disconnect removes the token and leaves only github_connect", async () => {
    await github.disconnect(owner);
    expect(await github.status(owner)).toBeNull();
    expect(await vault.list(owner)).toHaveLength(0);
    const tools = await github.tools(owner, "bot");
    expect(tools.map((t) => t.name)).toEqual(["github_connect"]);
    expect(await tools[0]?.execute({})).toStartWith("⟦github:connect⟧");
  });
});
