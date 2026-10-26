import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  GITHUB_REPO,
  type GithubActionKind,
  type GithubActionView,
  type GithubConnectionView,
  githubTokenKind,
} from "../../../shared/github";
import type { AuditInitiator } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { markUntrusted } from "../untrusted-content";
import type { Vault } from "../vault/service";

/**
 * GitHub 账号连接（DESIGN.md §53，docs/github.md）。
 *
 * 令牌：用户在 设置 → 账号连接 贴的 GitHub 令牌（推荐 fine-grained）。存进密钥保险箱的保留名字 `github`
 * （只允许发往 api.github.com；保险箱页面不能改、`api_request` 不能用），连接信息（登录名、头像、令牌类型）
 * 在 chisabot_github_connections。令牌只在这里解密，请求地址固定是 GitHub API，回来的内容里再把令牌抹掉。
 *
 * 机器人工具（只在连上之后给）：
 * - 读：github_list_repos / github_list_issues / github_list_pulls / github_get_issue / github_read_file，直接执行。
 * - 写：github_create_issue / github_comment / github_create_pr。先在 chisabot_github_actions 记一条待确认，
 *   聊天里出确认卡片（lib/copilot/github-tool.tsx），用户点「允许」时服务器才真正发请求；工具在服务器上等结果。
 *   网页不在场的回合（IM、长期任务、后台任务）不能确认，直接拒绝。
 *
 * 管理员可以用 CHISABOT_GITHUB_API_BASE 指向 GitHub Enterprise 或测试替身；默认 https://api.github.com。
 */
export const GITHUB_SECRET = "github";
const DEFAULT_BASE = "https://api.github.com";
const ACTION_WAIT_MS = 10 * 60_000;
const MAX_FILE_CHARS = 60_000;

export class GithubError extends Error {}

type ConnectionRow = {
  owner_user_id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
  html_url: string;
  token_kind: string;
  scopes: string;
  status: "ok" | "invalid";
  connected_at: Date | string;
  checked_at: Date | string;
};
type ActionRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  kind: GithubActionKind;
  repo: string;
  payload: unknown;
  status: GithubActionView["status"];
  result: unknown;
  created_at: Date | string;
  decided_at: Date | string | null;
};

const iso = (value: Date | string) => new Date(value).toISOString();
const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return (value ?? fallback) as T;
};
const actionView = (row: ActionRow): GithubActionView => ({
  id: row.id,
  kind: row.kind,
  repo: row.repo,
  agentId: row.agent_id,
  payload: json(row.payload, {}),
  status: row.status,
  result: json(row.result, null),
  createdAt: iso(row.created_at),
  decidedAt: row.decided_at ? iso(row.decided_at) : null,
});

/** 只有有人在网页聊天里的回合才能确认写操作。 */
export function canConfirm(initiator: AuditInitiator | undefined) {
  return !initiator || initiator.kind === "person";
}

/** 每轮给机器人的一句 GitHub 用法。 */
export function githubGuidance(connected: GithubConnectionView | null) {
  if (!connected)
    return "【GitHub】用户还没连接 GitHub。需要读写 GitHub 时，请用户去 设置 → 账号连接 连接 GitHub（贴一个令牌）；不要在聊天里要令牌，也不要用保险箱卡片要。";
  return `【GitHub】已连接 GitHub 账号 @${connected.login}${connected.status === "invalid" ? "（令牌已失效，请用户去 设置 → 账号连接 更换）" : ""}。用 github_* 工具读仓库、Issue、PR 和文件；建 Issue、评论、建 PR 会先弹确认卡片，用户允许后才发出——工具返回「拒绝」就停下，不要换别的方式绕过。`;
}

const repoSchema = z.string().trim().regex(GITHUB_REPO, "仓库写成 owner/name");
const enc = (path: string) =>
  path
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map(encodeURIComponent)
    .join("/");
const short = (text: string | null | undefined, n: number) => {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const day = (value: unknown) => (typeof value === "string" ? value.slice(0, 10) : "");

type Fetch = typeof fetch;

export function createGithub(database: Database, options: { vault: Vault; fetch?: Fetch; apiBase?: string }) {
  const sql = database.$client;
  const doFetch = options.fetch ?? fetch;
  const base = (options.apiBase || DEFAULT_BASE).replace(/\/+$/, "");
  const apiHost = new URL(base).hostname;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_github_connections (
        owner_user_id text PRIMARY KEY,
        login text NOT NULL,
        name text,
        avatar_url text,
        html_url text NOT NULL,
        token_kind text NOT NULL,
        scopes text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'ok',
        connected_at timestamptz NOT NULL DEFAULT now(),
        checked_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS chisabot_github_actions (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        agent_id text NOT NULL,
        kind text NOT NULL,
        repo text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'pending',
        result jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        decided_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS chisabot_github_actions_owner ON chisabot_github_actions (owner_user_id, created_at DESC);
    `);
  }

  const connectionRow = async (owner: string) =>
    (await sql.unsafe<ConnectionRow[]>("SELECT * FROM chisabot_github_connections WHERE owner_user_id = $1", [owner]))[0] ?? null;

  async function status(owner: string): Promise<GithubConnectionView | null> {
    const row = await connectionRow(owner);
    if (!row) return null;
    const secret = (await options.vault.list(owner)).find((s) => s.name === GITHUB_SECRET);
    if (!secret) return null; // 令牌被删了 = 没连接
    return {
      login: row.login,
      name: row.name,
      avatarUrl: row.avatar_url,
      htmlUrl: row.html_url,
      tokenKind: row.token_kind as GithubConnectionView["tokenKind"],
      scopes: row.scopes ? row.scopes.split(",").map((s) => s.trim()).filter(Boolean) : [],
      hint: secret.hint,
      status: row.status,
      connectedAt: iso(row.connected_at),
      checkedAt: iso(row.checked_at),
    };
  }

  /** 用给定的令牌直接发一个 GitHub 请求（地址固定在 API 主机上，不跟随重定向）。 */
  async function raw(token: string, method: string, path: string, body?: unknown, signal?: AbortSignal) {
    const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
    if (url.hostname !== apiHost) throw new GithubError("请求地址不对。");
    const response = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ChisaBot/0.1 (+https://github.com/ChisaAlter/ChisaBot)",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    const text = (await response.text()).split(token).join("••••");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: response.status, headers: response.headers, data, text };
  }

  function explain(status: number, data: unknown, what: string): string {
    const message = short((data as { message?: string } | null)?.message ?? "", 200);
    if (status === 401) return "GitHub 说令牌无效或已过期。请用户在 设置 → 账号连接 更换令牌。";
    if (status === 404) return `找不到${what}：可能不存在，或者令牌没有这个仓库的权限（fine-grained 令牌要在「仓库访问」里选上它）。`;
    if (status === 403 || status === 429)
      return /rate limit/i.test(message)
        ? "GitHub 限流了，过一会儿再试。"
        : `GitHub 拒绝了（${message || "权限不够"}）。令牌可能缺少需要的权限（Contents / Issues / Pull requests）。`;
    if (status === 422) {
      const errors = (data as { errors?: { message?: string; field?: string; code?: string }[] } | null)?.errors ?? [];
      const detail = errors.map((e) => e.message || [e.field, e.code].filter(Boolean).join(" ")).filter(Boolean).join("；");
      return `GitHub 不接受这个请求：${short(detail || message || "参数不对", 300)}`;
    }
    if (status === 301 || status === 302 || status === 307) return `${what}已经搬走了（GitHub 返回重定向），请确认仓库的新名字。`;
    return `GitHub 返回 ${status}${message ? `：${message}` : ""}`;
  }

  async function verify(token: string) {
    const response = await raw(token, "GET", "/user");
    if (response.status !== 200) throw new GithubError(response.status === 401 ? "这个令牌无效或已过期，没有保存。" : explain(response.status, response.data, "账号"));
    const user = response.data as { login?: string; name?: string | null; avatar_url?: string; html_url?: string };
    if (!user?.login) throw new GithubError("GitHub 没有返回账号信息，没有保存。");
    return { user, scopes: response.headers.get("x-oauth-scopes") ?? "" };
  }

  async function connect(owner: string, tokenInput: string) {
    const token = tokenInput.trim();
    if (!token || token.length < 20 || token.length > 400 || /\s/.test(token)) throw new GithubError("这看起来不像 GitHub 令牌。");
    const { user, scopes } = await verify(token);
    await options.vault.internal.save(owner, { name: GITHUB_SECRET, label: "GitHub 访问令牌", domains: [apiHost], value: token });
    await sql.unsafe(
      `INSERT INTO chisabot_github_connections (owner_user_id, login, name, avatar_url, html_url, token_kind, scopes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ok')
       ON CONFLICT (owner_user_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url,
         html_url = EXCLUDED.html_url, token_kind = EXCLUDED.token_kind, scopes = EXCLUDED.scopes, status = 'ok', connected_at = now(), checked_at = now()`,
      [owner, user.login, user.name ?? null, user.avatar_url ?? null, user.html_url ?? `https://github.com/${user.login}`, githubTokenKind(token), scopes],
    );
    return (await status(owner))!;
  }

  /** 最近用过的令牌（只在内存里），用来把工具输出里出现的令牌抹掉（比如仓库文件里正好有它）。 */
  const recent = new Map<string, string>();
  async function token(owner: string) {
    const row = await connectionRow(owner);
    const secret = row ? await options.vault.internal.reveal(owner, GITHUB_SECRET) : null;
    if (!row || !secret) throw new GithubError("用户还没连接 GitHub。请用户去 设置 → 账号连接 连接 GitHub。");
    recent.set(owner, secret.value);
    return secret.value;
  }
  const scrub = (owner: string, text: string) => {
    const value = recent.get(owner);
    return value && value.length >= 8 ? text.split(value).join("••••") : text;
  };

  async function check(owner: string) {
    const value = await token(owner);
    const response = await raw(value, "GET", "/user");
    const ok = response.status === 200;
    await sql.unsafe("UPDATE chisabot_github_connections SET status = $2, checked_at = now() WHERE owner_user_id = $1", [owner, ok ? "ok" : response.status === 401 ? "invalid" : "ok"]);
    if (!ok && response.status !== 401) throw new GithubError(explain(response.status, response.data, "账号"));
    return (await status(owner))!;
  }

  async function disconnect(owner: string) {
    await options.vault.internal.remove(owner, GITHUB_SECRET);
    recent.delete(owner);
    await sql.unsafe("DELETE FROM chisabot_github_connections WHERE owner_user_id = $1", [owner]);
    await sql.unsafe("UPDATE chisabot_github_actions SET status = 'expired', decided_at = now() WHERE owner_user_id = $1 AND status = 'pending'", [owner]);
  }

  /** 用这个人的令牌发请求；401 时把连接标成失效。 */
  async function api(owner: string, method: string, path: string, body?: unknown) {
    const value = await token(owner);
    const response = await raw(value, method, path, body);
    if (response.status === 401) await sql.unsafe("UPDATE chisabot_github_connections SET status = 'invalid', checked_at = now() WHERE owner_user_id = $1", [owner]);
    return response;
  }

  async function read(owner: string, path: string, what: string) {
    const response = await api(owner, "GET", path);
    if (response.status !== 200) throw new GithubError(explain(response.status, response.data, what));
    return response.data;
  }

  // ---- 写操作 ----
  const actionById = async (owner: string, id: string) =>
    (await sql.unsafe<ActionRow[]>("SELECT * FROM chisabot_github_actions WHERE id = $1 AND owner_user_id = $2", [id, owner]))[0] ?? null;

  async function perform(owner: string, row: ActionRow) {
    const p = json<GithubActionView["payload"]>(row.payload, {});
    const repo = row.repo;
    const call =
      row.kind === "create_issue"
        ? api(owner, "POST", `/repos/${repo}/issues`, { title: p.title, body: p.body ?? "", ...(p.labels?.length ? { labels: p.labels } : {}) })
        : row.kind === "comment"
          ? api(owner, "POST", `/repos/${repo}/issues/${p.number}/comments`, { body: p.body ?? "" })
          : api(owner, "POST", `/repos/${repo}/pulls`, { title: p.title, head: p.head, base: p.base, body: p.body ?? "", draft: Boolean(p.draft) });
    const what = row.kind === "comment" ? `#${p.number}` : "仓库";
    try {
      const response = await call;
      if (response.status === 201) {
        const data = response.data as { html_url?: string; number?: number };
        return { status: "done" as const, result: { url: data.html_url, ...(data.number ? { number: data.number } : {}) } };
      }
      return { status: "failed" as const, result: { error: explain(response.status, response.data, what) } };
    } catch (error) {
      return { status: "failed" as const, result: { error: error instanceof GithubError ? error.message : "连不上 GitHub，请稍后再试。" } };
    }
  }

  async function decide(owner: string, id: string, approve: boolean) {
    const [claimed] = await sql.unsafe<ActionRow[]>(
      `UPDATE chisabot_github_actions SET status = $3, decided_at = now()
       WHERE id = $1 AND owner_user_id = $2 AND status = 'pending' AND created_at > now() - interval '10 minutes' RETURNING *`,
      [id, owner, approve ? "running" : "rejected"],
    );
    if (!claimed) {
      const row = await actionById(owner, id);
      if (!row) throw new GithubError("找不到这个操作。");
      if (row.status === "pending") {
        await sql.unsafe("UPDATE chisabot_github_actions SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'pending'", [id]);
        throw new GithubError("这个操作已经过期，请让机器人重新发起。");
      }
      return actionView(row); // 已经处理过（另一台设备点了）
    }
    if (!approve) return actionView(claimed);
    const outcome = await perform(owner, claimed);
    const [done] = await sql.unsafe<ActionRow[]>(
      "UPDATE chisabot_github_actions SET status = $2, result = $3::jsonb WHERE id = $1 RETURNING *",
      [id, outcome.status, JSON.stringify(outcome.result)],
    );
    return actionView(done!);
  }

  async function propose(owner: string, agentId: string, kind: GithubActionKind, repo: string, payload: GithubActionView["payload"]) {
    const id = `ga_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await sql.unsafe("INSERT INTO chisabot_github_actions (id, owner_user_id, agent_id, kind, repo, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", [
      id,
      owner,
      agentId,
      kind,
      repo,
      JSON.stringify(payload),
    ]);
    const deadline = Date.now() + ACTION_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const row = await actionById(owner, id);
      if (!row) return `⟦github:${id}⟧ 这个操作被取消了，没有发出。`;
      if (row.status === "rejected") return `⟦github:${id}⟧ 用户拒绝了，什么都没有发出。不要换别的方式绕过，问用户要怎么改。`;
      if (row.status === "expired") return `⟦github:${id}⟧ 已过期（GitHub 连接被断开或等太久），没有发出。`;
      if (row.status === "done") {
        const r = json<{ url?: string; number?: number }>(row.result, {});
        const label = kind === "create_issue" ? `Issue #${r.number ?? ""}` : kind === "create_pr" ? `PR #${r.number ?? ""}` : "评论";
        return `⟦github:${id}⟧ 用户允许了，已在 ${repo} 创建${label}：${r.url ?? ""}`;
      }
      if (row.status === "failed") return `⟦github:${id}⟧ 用户允许了，但 GitHub 没有接受：${json<{ error?: string }>(row.result, {}).error ?? "未知错误"}`;
    }
    await sql.unsafe("UPDATE chisabot_github_actions SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'pending'", [id]);
    return `⟦github:${id}⟧ 等了 10 分钟用户没有确认，没有发出。`;
  }

  // ---- 机器人工具 ----
  async function tools(owner: string, agentId: string, initiator?: AuditInitiator): Promise<GrantedTool[]> {
    if (!(await connectionRow(owner))) return [];
    const tool = <T extends z.ZodType>(name: string, description: string, parameters: T, run: (input: z.infer<T>) => Promise<string>): GrantedTool => ({
      name,
      ref: `github/${name}`,
      description,
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} ${name} 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
        try {
          return scrub(owner, await run(parsed.data));
        } catch (error) {
          if (error instanceof GithubError) return `${REFUSAL_MARKER} ${scrub(owner, error.message)}`;
          if (error instanceof z.ZodError) return `${REFUSAL_MARKER} ${error.issues[0]?.message ?? "参数不对。"}`;
          if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return `${REFUSAL_MARKER} GitHub 超时了，稍后再试。`;
          if (error instanceof TypeError) return `${REFUSAL_MARKER} 连不上 GitHub，稍后再试。`;
          throw error;
        }
      },
    });
    const untrusted = (text: string, source: string) => markUntrusted(text, source);
    const page = z.number().int().min(1).max(50).optional();
    const write = async (kind: GithubActionKind, repo: string, payload: GithubActionView["payload"]) => {
      if (!canConfirm(initiator))
        return `${REFUSAL_MARKER} 这一轮不在网页聊天里，没法让用户确认 GitHub 写操作。告诉用户想做什么，请他在 ChisaBot 网页聊天里让你再做一次。`;
      return propose(owner, agentId, kind, repo, payload);
    };
    return [
      tool(
        "github_list_repos",
        "列出用户能访问的 GitHub 仓库（最近更新的在前）。给 owner 就列那个用户 / 组织的仓库。",
        z.object({ owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).optional(), page }).strict(),
        async ({ owner: who, page: p }) => {
          const q = `per_page=30&page=${p ?? 1}&sort=updated`;
          const data = (await read(owner, who ? `/users/${who}/repos?${q}` : `/user/repos?${q}&affiliation=owner,collaborator,organization_member`, "仓库")) as {
            full_name: string;
            private: boolean;
            description: string | null;
            stargazers_count: number;
            language: string | null;
            pushed_at: string;
            default_branch: string;
            fork: boolean;
          }[];
          if (!data.length) return "没有仓库（或者令牌没有选任何仓库）。";
          return untrusted(
            data
              .map((r) => `- ${r.full_name}${r.private ? "（私有）" : ""}${r.fork ? "（fork）" : ""} · ★${r.stargazers_count}${r.language ? ` · ${r.language}` : ""} · 默认分支 ${r.default_branch} · 最近推送 ${day(r.pushed_at)}${r.description ? ` — ${short(r.description, 120)}` : ""}`)
              .join("\n") + (data.length === 30 ? `\n（还有更多：page=${(p ?? 1) + 1}）` : ""),
            "github repos",
          );
        },
      ),
      tool(
        "github_list_issues",
        "列出仓库的 Issue（不含 PR）。state: open（默认）/ closed / all；labels 逗号分隔。",
        z.object({ repo: repoSchema, state: z.enum(["open", "closed", "all"]).optional(), labels: z.string().max(200).optional(), page }).strict(),
        async ({ repo, state, labels, page: p }) => {
          const data = (await read(owner, `/repos/${repo}/issues?state=${state ?? "open"}&per_page=30&page=${p ?? 1}${labels ? `&labels=${encodeURIComponent(labels)}` : ""}`, `仓库 ${repo}`)) as {
            number: number;
            title: string;
            state: string;
            user?: { login: string };
            comments: number;
            labels: ({ name?: string } | string)[];
            updated_at: string;
            pull_request?: unknown;
          }[];
          const issues = data.filter((i) => !i.pull_request);
          if (!issues.length) return `${repo} 没有${state === "closed" ? "已关闭的" : state === "all" ? "" : "打开的"} Issue。`;
          return untrusted(
            issues
              .map((i) => {
                const ls = i.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
                return `#${i.number} [${i.state}] ${short(i.title, 140)} — @${i.user?.login ?? "?"} · ${i.comments} 条评论${ls.length ? ` · ${ls.join(", ")}` : ""} · 更新 ${day(i.updated_at)}`;
              })
              .join("\n"),
            `github ${repo} issues`,
          );
        },
      ),
      tool(
        "github_list_pulls",
        "列出仓库的 Pull Request。state: open（默认）/ closed / all。",
        z.object({ repo: repoSchema, state: z.enum(["open", "closed", "all"]).optional(), page }).strict(),
        async ({ repo, state, page: p }) => {
          const data = (await read(owner, `/repos/${repo}/pulls?state=${state ?? "open"}&per_page=30&page=${p ?? 1}`, `仓库 ${repo}`)) as {
            number: number;
            title: string;
            state: string;
            draft?: boolean;
            merged_at?: string | null;
            user?: { login: string };
            head: { ref: string; label?: string };
            base: { ref: string };
            updated_at: string;
          }[];
          if (!data.length) return `${repo} 没有${state === "closed" ? "已关闭的" : state === "all" ? "" : "打开的"} PR。`;
          return untrusted(
            data
              .map((r) => `#${r.number} [${r.merged_at ? "merged" : r.state}${r.draft ? " · 草稿" : ""}] ${short(r.title, 140)} — @${r.user?.login ?? "?"} · ${r.head.label ?? r.head.ref} → ${r.base.ref} · 更新 ${day(r.updated_at)}`)
              .join("\n"),
            `github ${repo} pulls`,
          );
        },
      ),
      tool(
        "github_get_issue",
        "读一个 Issue 或 PR 的正文和最近的评论（PR 还会给分支和改动文件数）。",
        z.object({ repo: repoSchema, number: z.number().int().min(1) }).strict(),
        async ({ repo, number }) => {
          const issue = (await read(owner, `/repos/${repo}/issues/${number}`, `${repo}#${number}`)) as {
            title: string;
            state: string;
            body: string | null;
            user?: { login: string };
            html_url: string;
            created_at: string;
            pull_request?: unknown;
            labels: ({ name?: string } | string)[];
          };
          const lines = [
            `${issue.pull_request ? "PR" : "Issue"} ${repo}#${number} [${issue.state}] ${issue.title}`,
            `作者 @${issue.user?.login ?? "?"} · 创建 ${day(issue.created_at)} · ${issue.html_url}`,
          ];
          if (issue.pull_request) {
            const pr = (await read(owner, `/repos/${repo}/pulls/${number}`, `${repo}#${number}`)) as {
              head: { label?: string; ref: string };
              base: { ref: string };
              merged: boolean;
              mergeable: boolean | null;
              changed_files: number;
              additions: number;
              deletions: number;
              draft?: boolean;
            };
            lines.push(`分支 ${pr.head.label ?? pr.head.ref} → ${pr.base.ref} · ${pr.merged ? "已合并" : pr.mergeable === false ? "有冲突" : "未合并"}${pr.draft ? " · 草稿" : ""} · ${pr.changed_files} 个文件 +${pr.additions} −${pr.deletions}`);
          }
          lines.push("", issue.body?.trim() ? issue.body.slice(0, 8000) : "（没有正文）");
          const comments = (await read(owner, `/repos/${repo}/issues/${number}/comments?per_page=30`, "评论")) as { user?: { login: string }; body: string; created_at: string }[];
          if (comments.length) {
            lines.push("", `评论（${comments.length}）：`);
            for (const c of comments.slice(-20)) lines.push(`— @${c.user?.login ?? "?"}（${day(c.created_at)}）：${(c.body ?? "").slice(0, 2000)}`);
          }
          return untrusted(lines.join("\n"), `github ${repo}#${number}`);
        },
      ),
      tool(
        "github_read_file",
        "读仓库里的一个文件（或列出一个目录）。ref 可以是分支、标签或提交，默认是默认分支。",
        z.object({ repo: repoSchema, path: z.string().max(400).default(""), ref: z.string().max(200).optional() }).strict(),
        async ({ repo, path, ref }) => {
          const data = (await read(owner, `/repos/${repo}/contents/${enc(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, `${repo} 里的 ${path || "根目录"}`)) as
            | { type: string; name: string; path: string; size: number; content?: string; encoding?: string }
            | { type: string; name: string; path: string; size: number }[];
          if (Array.isArray(data))
            return untrusted(
              `${repo}/${path || ""}（${data.length} 项）\n${data.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.path}${e.type === "file" ? ` · ${e.size} B` : ""}`).join("\n")}`,
              `github ${repo} tree`,
            );
          if (data.type !== "file") return `${data.path} 是 ${data.type}，不是普通文件。`;
          if (data.encoding !== "base64" || !data.content) return `${data.path} 太大（${data.size} B），GitHub 接口不直接返回内容。`;
          const bytes = Buffer.from(data.content, "base64");
          if (bytes.includes(0)) return `${data.path} 是二进制文件（${data.size} B），没法当文本读。`;
          const text = bytes.toString("utf8");
          return untrusted(
            `${repo}/${data.path}${ref ? `@${ref}` : ""}（${data.size} B）\n${text.slice(0, MAX_FILE_CHARS)}${text.length > MAX_FILE_CHARS ? "\n（文件过长，已截断）" : ""}`,
            `github ${repo}/${data.path}`,
          );
        },
      ),
      tool(
        "github_create_issue",
        "在仓库里新建一个 Issue。会先在聊天里弹确认卡片，用户点「允许」才发出；拒绝就停下。",
        z
          .object({
            repo: repoSchema,
            title: z.string().trim().min(1).max(256),
            body: z.string().max(60_000).optional(),
            labels: z.array(z.string().max(50)).max(10).optional(),
          })
          .strict(),
        async ({ repo, title, body, labels }) => write("create_issue", repo, { title, body: body ?? "", ...(labels?.length ? { labels } : {}) }),
      ),
      tool(
        "github_comment",
        "在 Issue 或 PR 下发一条评论。会先在聊天里弹确认卡片，用户点「允许」才发出；拒绝就停下。",
        z.object({ repo: repoSchema, number: z.number().int().min(1), body: z.string().trim().min(1).max(60_000) }).strict(),
        async ({ repo, number, body }) => write("comment", repo, { number, body }),
      ),
      tool(
        "github_create_pr",
        "从已有分支创建 Pull Request（head 是改动所在分支，跨仓库写 owner:branch；base 是要合进去的分支）。不会推代码。会先弹确认卡片，用户点「允许」才发出。",
        z
          .object({
            repo: repoSchema,
            title: z.string().trim().min(1).max(256),
            head: z.string().trim().min(1).max(200),
            base: z.string().trim().min(1).max(200),
            body: z.string().max(60_000).optional(),
            draft: z.boolean().optional(),
          })
          .strict(),
        async ({ repo, title, head, base: target, body, draft }) => write("create_pr", repo, { title, head, base: target, body: body ?? "", draft: Boolean(draft) }),
      ),
    ];
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
    app.onError((error, c) => {
      if (error instanceof GithubError) return c.json({ error: error.message }, 400);
      if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? "参数不对。" }, 400);
      if (error instanceof TypeError || error.name === "TimeoutError") return c.json({ error: "连不上 GitHub，请稍后再试。" }, 502);
      console.error(JSON.stringify({ type: "github-error", error: error.name, route: c.req.path }));
      return c.json({ error: "GitHub 连接暂时不可用，请重试。" }, 503);
    });
    app.get("/", async (c) => c.json({ connection: await status(c.var.actor.id) }));
    app.post("/connect", async (c) => {
      const body = z.object({ token: z.string().min(1).max(400) }).strict().parse(await c.req.json());
      return c.json({ connection: await connect(c.var.actor.id, body.token) });
    });
    app.post("/check", async (c) => c.json({ connection: await check(c.var.actor.id) }));
    app.delete("/", async (c) => {
      await disconnect(c.var.actor.id);
      return c.body(null, 204);
    });
    // 确认卡片：工具还没返回时按 kind + repo 找这个人最新的一条；返回后按结果里的 id。
    app.get("/actions/latest", async (c) => {
      const kind = c.req.query("kind") ?? "";
      const repo = c.req.query("repo") ?? "";
      const rows = await sql.unsafe<ActionRow[]>(
        "SELECT * FROM chisabot_github_actions WHERE owner_user_id = $1 AND kind = $2 AND repo = $3 AND created_at > now() - interval '15 minutes' ORDER BY created_at DESC LIMIT 1",
        [c.var.actor.id, kind, repo],
      );
      return c.json({ action: rows[0] ? actionView(rows[0]) : null });
    });
    app.get("/actions/:id", async (c) => {
      const row = await actionById(c.var.actor.id, c.req.param("id"));
      return row ? c.json({ action: actionView(row) }) : c.json({ error: "找不到这个操作。" }, 404);
    });
    app.post("/actions/:id/approve", async (c) => c.json({ action: await decide(c.var.actor.id, c.req.param("id"), true) }));
    app.post("/actions/:id/reject", async (c) => c.json({ action: await decide(c.var.actor.id, c.req.param("id"), false) }));
    return app;
  }

  async function guidance(owner: string) {
    return githubGuidance(await status(owner).catch(() => null));
  }

  return { ensure, status, connect, check, disconnect, tools, routes, guidance, decide, actionById, apiBase: base };
}
export type Github = ReturnType<typeof createGithub>;
