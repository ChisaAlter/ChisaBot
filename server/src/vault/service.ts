import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { domainAllowed, VAULT_DOMAIN, VAULT_NAME, vaultReserved, type VaultRequestView, type VaultSecretView } from "../../../shared/vault";
import type { AuditInitiator } from "../audit";
import type { AppVariables } from "../auth/guards";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { markUntrusted } from "../untrusted-content";
import { BlockedUrlError, guardedFetch } from "../../../shared/net/guarded-fetch";
import { assertPublicUrl } from "../web/tools";

/**
 * 密钥保险箱（DESIGN.md §52，docs/vault.md）。
 *
 * 表 chisabot_vault_secrets（值用 KEY_ENCRYPTION_KEY AES-GCM 加密）/ chisabot_vault_requests（机器人请用户
 * 填一个密钥的请求，只存状态，不存值）。开机建表，回滚安全。
 *
 * - `vault_request_secret`：在聊天里出一张安全输入卡片（`useRenderTool` 画），用户填的值直接 POST 到
 *   /api/vault/requests/:id/fill，加密入库；工具在服务器上等结果，只告诉机器人「存好了 / 取消了」。
 * - `api_request`：机器人用 `{{secret:名字}}` 占位，服务器替换后发请求；只发往这个密钥绑定的域名，
 *   不跟随重定向，回来的内容里把值抹成 ••••。
 * - 网页不在线的回合（IM、长期任务、后台刷新）不能弹卡片：`vault_request_secret` 直接拒绝，说去网页上存。
 */
const PLACEHOLDER = /\{\{\s*secret:([a-z0-9][a-z0-9_-]{0,38}[a-z0-9])\s*\}\}/g;
const REQUEST_WAIT_MS = 10 * 60_000;
const MAX_RESPONSE = 400_000;

type SecretRow = {
  id: string;
  owner_user_id: string;
  name: string;
  label: string;
  domains: unknown;
  value: string;
  hint: string;
  created_at: Date | string;
  updated_at: Date | string;
  last_used_at: Date | string | null;
};
type RequestRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  name: string;
  label: string;
  purpose: string | null;
  domains: unknown;
  status: VaultRequestView["status"];
  created_at: Date | string;
};

export class VaultError extends Error {}
const iso = (value: Date | string) => new Date(value).toISOString();
/** Bun SQL 把 jsonb 列有时按字符串返回：统一成字符串数组。 */
export function domainList(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [];
}
const secretView = (row: SecretRow): VaultSecretView => ({
  id: row.id,
  name: row.name,
  label: row.label,
  domains: domainList(row.domains),
  hint: row.hint,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  ...(vaultReserved(row.name) ? { managedBy: vaultReserved(row.name) } : {}),
});
const RESERVED_TEXT = "「github」由 设置 → 账号连接 → GitHub 管理，请在那里连接、更换或断开。";
const requestView = (row: RequestRow): VaultRequestView => ({
  id: row.id,
  name: row.name,
  label: row.label,
  purpose: row.purpose,
  domains: domainList(row.domains),
  status: row.status,
  agentId: row.agent_id,
  createdAt: iso(row.created_at),
});
const hintOf = (value: string) => (value.length >= 8 ? value.slice(-4) : "");
const nameSchema = z.string().trim().toLowerCase().regex(VAULT_NAME, "名字只能用小写字母、数字、下划线和连字符（2–40 个字符）");
const domainsSchema = z
  .array(z.string().trim().toLowerCase().regex(VAULT_DOMAIN, "域名写成 api.example.com 或 *.example.com"))
  .min(1, "至少写一个能用这个密钥的域名")
  .max(10);

/** 网页聊天以外的回合（IM、长期任务、面板刷新、后台任务）弹不出卡片。 */
/** 每轮开头给机器人的保险箱用法（不含任何值）。 */
export const VAULT_GUIDANCE = [
  "【密钥】需要用户的 API 密钥、令牌这类东西时，调用 vault_request_secret，聊天里会出现安全输入卡片，用户在卡片里填；",
  "绝不要让用户把密钥发在聊天里，也绝不要自己做网页、表单、HTML 或链接让用户输入密钥。已有的密钥用 vault_list 查，",
  "用 api_request 加 {{secret:名字}} 调接口。网站账号密码用 computer_request_sign_in 的登录卡片。用户若已把密钥贴在聊天里，提醒他去重置。",
].join("");

export function interactive(initiator: AuditInitiator | undefined) {
  return !initiator || initiator.kind !== "routine";
}

export function createVault(database: Database, options: { encryptionKey: string; fetch?: typeof fetch }) {
  const sql = database.$client;
  const doFetch = options.fetch ?? fetch;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_vault_secrets (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        name text NOT NULL,
        label text NOT NULL,
        domains jsonb NOT NULL DEFAULT '[]'::jsonb,
        value text NOT NULL,
        hint text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        UNIQUE (owner_user_id, name)
      );
      CREATE TABLE IF NOT EXISTS chisabot_vault_requests (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        agent_id text NOT NULL,
        name text NOT NULL,
        label text NOT NULL,
        purpose text,
        domains jsonb NOT NULL DEFAULT '[]'::jsonb,
        status text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chisabot_vault_requests_owner ON chisabot_vault_requests (owner_user_id, created_at DESC);
    `);
  }

  const list = async (owner: string) =>
    (await sql.unsafe<SecretRow[]>("SELECT * FROM chisabot_vault_secrets WHERE owner_user_id = $1 ORDER BY name", [owner])).map(secretView);
  const byName = async (owner: string, name: string) =>
    (await sql.unsafe<SecretRow[]>("SELECT * FROM chisabot_vault_secrets WHERE owner_user_id = $1 AND name = $2", [owner, name]))[0] ?? null;

  async function save(owner: string, input: { name: string; label: string; domains: string[]; value?: string | null }, internal = false) {
    const name = nameSchema.parse(input.name);
    if (vaultReserved(name) && !internal) throw new VaultError(RESERVED_TEXT);
    const label = z.string().trim().min(1).max(60).parse(input.label);
    const domains = domainsSchema.parse(input.domains);
    const value = input.value?.trim() ? input.value.trim() : null;
    if (value && value.length > 8000) throw new VaultError("密钥太长。");
    const existing = await byName(owner, name);
    if (!existing && !value) throw new VaultError("要填密钥的值。");
    const sealed = value ? await encryptSecret(options.encryptionKey, value) : existing!.value;
    const hint = value ? hintOf(value) : existing!.hint;
    const [row] = await sql.unsafe<SecretRow[]>(
      `INSERT INTO chisabot_vault_secrets (id, owner_user_id, name, label, domains, value, hint)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (owner_user_id, name) DO UPDATE SET label = EXCLUDED.label, domains = EXCLUDED.domains, value = EXCLUDED.value, hint = EXCLUDED.hint, updated_at = now()
       RETURNING *`,
      [`vs_${randomUUID().replace(/-/g, "").slice(0, 20)}`, owner, name, label, JSON.stringify(domains), sealed, hint],
    );
    return secretView(row!);
  }

  async function remove(owner: string, id: string) {
    const target = (await sql.unsafe<SecretRow[]>("SELECT * FROM chisabot_vault_secrets WHERE owner_user_id = $1 AND id = $2", [owner, id]))[0];
    if (target && vaultReserved(target.name)) throw new VaultError(RESERVED_TEXT);
    const rows = await sql.unsafe<SecretRow[]>("DELETE FROM chisabot_vault_secrets WHERE owner_user_id = $1 AND id = $2 RETURNING *", [owner, id]);
    return rows.length > 0;
  }

  const requestById = async (owner: string, id: string) =>
    (await sql.unsafe<RequestRow[]>("SELECT * FROM chisabot_vault_requests WHERE id = $1 AND owner_user_id = $2", [id, owner]))[0] ?? null;

  async function fill(owner: string, id: string, value: string, overrides: { label?: string; domains?: string[] } = {}) {
    const request = await requestById(owner, id);
    if (!request) throw new VaultError("找不到这个请求。");
    if (request.status !== "pending") throw new VaultError("这个请求已经结束了。");
    if (Date.now() - new Date(request.created_at).getTime() > REQUEST_WAIT_MS) {
      await sql.unsafe("UPDATE chisabot_vault_requests SET status = 'expired' WHERE id = $1", [id]);
      throw new VaultError("这个请求已经过期，请让机器人重新请求。");
    }
    if (!value.trim()) throw new VaultError("要填密钥的值。");
    const saved = await save(owner, { name: request.name, label: overrides.label ?? request.label, domains: overrides.domains ?? domainList(request.domains), value });
    await sql.unsafe("UPDATE chisabot_vault_requests SET status = 'filled' WHERE id = $1", [id]);
    return saved;
  }

  async function cancel(owner: string, id: string) {
    await sql.unsafe("UPDATE chisabot_vault_requests SET status = 'cancelled' WHERE id = $1 AND owner_user_id = $2 AND status = 'pending'", [id, owner]);
  }

  /** 发请求：替换占位、只发往绑定的域名、不跟随重定向、回来的内容抹掉密钥。 */
  async function request(owner: string, input: { method: string; url: string; headers?: Record<string, string>; body?: string }, signal?: AbortSignal) {
    const used = new Map<string, SecretRow>();
    const names = new Set<string>();
    const scan = (text: string) => {
      for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]!);
    };
    scan(input.url);
    for (const [k, v] of Object.entries(input.headers ?? {})) {
      scan(k);
      scan(v);
    }
    if (input.body) scan(input.body);
    for (const name of names) {
      if (vaultReserved(name)) throw new VaultError("GitHub 令牌不能用在 api_request 里，请用 github_* 工具（写操作要用户确认）。");
      const row = await byName(owner, name);
      if (!row) throw new VaultError(`保险箱里没有叫「${name}」的密钥。先用 vault_list 看看，或者用 vault_request_secret 请用户存一个。`);
      used.set(name, row);
    }
    // 先按占位后的网址校验域名：密钥只能发往它绑定的域名。
    const target = new URL(input.url.replace(PLACEHOLDER, "x"));
    if (target.protocol !== "https:") throw new VaultError("带密钥的请求只能发 https。");
    for (const [name, row] of used)
      if (!domainAllowed(target.hostname, domainList(row.domains)))
        throw new VaultError(`密钥「${name}」只能发往 ${domainList(row.domains).join("、")}，不能发往 ${target.hostname}。如果确实要用在这个网站，请用户在 设置 → 密钥 里给它加上这个域名。`);
    const values = new Map<string, string>();
    for (const [name, row] of used) values.set(name, await decryptSecret(options.encryptionKey, row.value));
    const fillIn = (text: string) => text.replace(PLACEHOLDER, (_, name: string) => values.get(name) ?? "");
    const method = input.method.toUpperCase();
    const headerRecord: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers ?? {})) headerRecord[fillIn(k)] = fillIn(v);
    if (!Object.keys(headerRecord).some((k) => k.toLowerCase() === "user-agent")) {
      headerRecord["user-agent"] = "ChisaBot/0.1 (+https://github.com/ChisaAlter/ChisaBot)";
    }
    const filledUrl = fillIn(input.url);
    const abort = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000);
    const scrub = (s: string) => {
      let out = s;
      for (const value of values.values()) if (value.length >= 4) out = out.split(value).join("••••");
      return out;
    };

    // 默认走 guardedFetch（DNS 钉死、不跟重定向）；测试注入 fetch 时仍用强 assert + 手动 redirect。
    if (!options.fetch) {
      let guarded;
      try {
        guarded = await guardedFetch(filledUrl, {
          method,
          headers: headerRecord,
          ...(input.body && method !== "GET" && method !== "HEAD"
            ? { body: fillIn(input.body) }
            : {}),
          maxBytes: MAX_RESPONSE + 1,
          timeoutMs: 30_000,
          maxRedirects: 0,
          signal: abort,
        });
      } catch (error) {
        if (error instanceof BlockedUrlError) throw new VaultError(error.message);
        throw error;
      }
      if (used.size)
        await sql.unsafe(
          "UPDATE chisabot_vault_secrets SET last_used_at = now() WHERE owner_user_id = $1 AND name = ANY(string_to_array($2, ','))",
          [owner, [...used.keys()].join(",")],
        );
      const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(guarded.body);
      return {
        status: guarded.status,
        contentType: guarded.contentType,
        location: null,
        body: scrub(bodyText).slice(0, 20_000),
        truncated: guarded.truncated || bodyText.length > 20_000,
      };
    }

    const url = await assertPublicUrl(filledUrl);
    const headers = new Headers(headerRecord);
    const response = await doFetch(url, {
      method,
      headers,
      ...(input.body && method !== "GET" && method !== "HEAD" ? { body: fillIn(input.body) } : {}),
      redirect: "manual",
      signal: abort,
    });
    if (used.size)
      await sql.unsafe("UPDATE chisabot_vault_secrets SET last_used_at = now() WHERE owner_user_id = $1 AND name = ANY(string_to_array($2, ','))", [owner, [...used.keys()].join(",")]);
    let text = "";
    const reader = response.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) {
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    text = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    const location = response.headers.get("location");
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      location: location ? scrub(location) : null,
      body: scrub(text).slice(0, 20_000),
      truncated: size > MAX_RESPONSE || text.length > 20_000,
    };
  }

  function tools(owner: string, agentId: string, initiator?: AuditInitiator): GrantedTool[] {
    const tool = <T extends z.ZodType>(name: string, description: string, parameters: T, run: (input: z.infer<T>) => Promise<string>): GrantedTool => ({
      name,
      ref: `vault/${name}`,
      description,
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} ${name} 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
        try {
          return await run(parsed.data);
        } catch (error) {
          if (error instanceof VaultError) return `${REFUSAL_MARKER} ${error.message}`;
          if (error instanceof z.ZodError) return `${REFUSAL_MARKER} ${error.issues[0]?.message ?? "参数不对。"}`;
          if (error instanceof Error && /网址|内网|http/.test(error.message)) return `${REFUSAL_MARKER} ${error.message}`;
          throw error;
        }
      },
    });
    return [
      tool(
        "vault_list",
        "列出用户保险箱里的密钥（名字、用途、能用的域名；看不到值）。",
        z.object({}).strict(),
        async () => {
          const rows = await list(owner);
          return rows.length ? rows.map((r) => `- ${r.name}：${r.label}（可用于 ${r.domains.join("、")}${r.hint ? `，末四位 ${r.hint}` : ""}）`).join("\n") : "保险箱是空的。";
        },
      ),
      tool(
        "vault_request_secret",
        "需要用户的 API 密钥 / 令牌时调用：聊天里会出现一张安全输入卡片，用户填的值直接加密存进保险箱，你永远看不到值。千万不要让用户把密钥直接发在聊天里。存好后用 api_request 加 {{secret:名字}} 使用。登录网站用 computer_request_sign_in，不用这个。",
        z
          .object({
            name: z.string().max(40).describe("保险箱里的名字，小写字母数字下划线连字符，如 openai_key"),
            label: z.string().min(1).max(60).describe("给用户看的名字，如「OpenAI API 密钥」"),
            purpose: z.string().max(200).optional().describe("一句话说明拿来做什么"),
            domains: z.array(z.string()).min(1).max(5).describe("这个密钥能发往的域名，如 [\"api.openai.com\"]"),
          })
          .strict(),
        async (input) => {
          if (!interactive(initiator)) return `${REFUSAL_MARKER} 这一轮不是在网页聊天里，弹不出安全输入卡片。请用户去 ChisaBot 网页的 设置 → 密钥 里添加「${input.label}」（名字 ${input.name}），或在网页聊天里再让你请求一次。`;
          const name = nameSchema.parse(input.name);
          if (vaultReserved(name)) return `${REFUSAL_MARKER} 要用 GitHub 请让用户在 设置 → 账号连接 里连接 GitHub，不要用保险箱卡片要 GitHub 令牌。`;
          const domains = domainsSchema.parse(input.domains);
          const id = `vr_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
          await sql.unsafe(
            "INSERT INTO chisabot_vault_requests (id, owner_user_id, agent_id, name, label, purpose, domains) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
            [id, owner, agentId, name, input.label.trim(), input.purpose?.trim() || null, JSON.stringify(domains)],
          );
          const deadline = Date.now() + REQUEST_WAIT_MS;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const row = await requestById(owner, id);
            if (!row || row.status === "cancelled") return `用户取消了，没有存「${input.label}」。不要换别的方式索要密钥。`;
            if (row.status === "filled") {
              const secret = await byName(owner, name);
              return `⟦vault:${id}⟧ 用户已把「${secret?.label ?? input.label}」存进保险箱，名字 ${name}，可用于 ${(secret ? domainList(secret.domains) : domains).join("、")}。用法：在 api_request 的网址 / 请求头 / 请求体里写 {{secret:${name}}}。`;
            }
          }
          await sql.unsafe("UPDATE chisabot_vault_requests SET status = 'expired' WHERE id = $1 AND status = 'pending'", [id]);
          return `⟦vault:${id}⟧ 等了 10 分钟用户没有填。告诉用户可以稍后在 设置 → 密钥 里添加。`;
        },
      ),
      tool(
        "api_request",
        "调用需要密钥的 HTTP 接口（https）。在网址、请求头或请求体里用 {{secret:名字}} 引用保险箱里的密钥，服务器替换后发出，回来的内容里密钥会被抹掉。密钥只能发往它绑定的域名；不跟随重定向。不需要密钥的公开网页用 web_fetch。",
        z
          .object({
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
            url: z.string().max(2000),
            headers: z.record(z.string().max(100), z.string().max(4000)).optional(),
            body: z.string().max(100_000).optional(),
          })
          .strict(),
        async (input) => {
          const result = await request(owner, input);
          return `状态：${result.status}${result.contentType ? `\n类型：${result.contentType}` : ""}${result.location ? `\n重定向到：${result.location}（没有跟随）` : ""}${result.truncated ? "\n（内容过长，已截断）" : ""}\n${markUntrusted(result.body || "（空）", input.url.replace(PLACEHOLDER, "{{secret}}"))}`;
        },
      ),
    ];
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser, bodyLimit({ maxSize: 32_768 }));
    app.onError((error, c) => {
      if (error instanceof VaultError) return c.json({ error: error.message }, 400);
      if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? "参数不对。" }, 400);
      console.error(JSON.stringify({ type: "vault-error", error: error.name, route: c.req.path }));
      return c.json({ error: "保险箱暂时不可用，请重试。" }, 503);
    });
    const input = z.object({ name: z.string(), label: z.string(), domains: z.array(z.string()), value: z.string().max(8000).nullable().optional() }).strict();
    app.get("/", async (c) => c.json({ secrets: await list(c.var.actor.id) }));
    app.post("/", async (c) => c.json({ secret: await save(c.var.actor.id, input.parse(await c.req.json())) }, 201));
    app.delete("/:id", async (c) => ((await remove(c.var.actor.id, c.req.param("id"))) ? c.body(null, 204) : c.json({ error: "找不到这个密钥。" }, 404)));
    // 卡片在工具还没返回时就要知道请求 id：按名字拿这个人最新的、还在等的请求。
    app.get("/requests", async (c) => {
      const name = c.req.query("name") ?? "";
      const rows = await sql.unsafe<RequestRow[]>(
        "SELECT * FROM chisabot_vault_requests WHERE owner_user_id = $1 AND name = $2 ORDER BY created_at DESC LIMIT 1",
        [c.var.actor.id, name.toLowerCase()],
      );
      return c.json({ request: rows[0] ? requestView(rows[0]) : null });
    });
    app.get("/requests/:id", async (c) => {
      const row = await requestById(c.var.actor.id, c.req.param("id"));
      return row ? c.json({ request: requestView(row) }) : c.json({ error: "找不到这个请求。" }, 404);
    });
    app.post("/requests/:id/fill", async (c) => {
      const body = z.object({ value: z.string().min(1).max(8000), label: z.string().max(60).optional(), domains: z.array(z.string()).optional() }).strict().parse(await c.req.json());
      const saved = await fill(c.var.actor.id, c.req.param("id"), body.value, {
        ...(body.label?.trim() ? { label: body.label.trim() } : {}),
        ...(body.domains?.length ? { domains: body.domains } : {}),
      });
      return c.json({ secret: saved });
    });
    app.post("/requests/:id/cancel", async (c) => {
      await cancel(c.var.actor.id, c.req.param("id"));
      return c.json({ ok: true });
    });
    return app;
  }

  /** 只给服务器内部（GitHub 连接）用：存 / 取 / 删保留名字的密钥。值不离开服务器。 */
  const internal = {
    save: (owner: string, input: { name: string; label: string; domains: string[]; value: string }) => save(owner, input, true),
    async reveal(owner: string, name: string) {
      const row = await byName(owner, name);
      if (!row) return null;
      await sql.unsafe("UPDATE chisabot_vault_secrets SET last_used_at = now() WHERE id = $1", [row.id]);
      return { value: await decryptSecret(options.encryptionKey, row.value), hint: row.hint, domains: domainList(row.domains) };
    },
    async remove(owner: string, name: string) {
      await sql.unsafe("DELETE FROM chisabot_vault_secrets WHERE owner_user_id = $1 AND name = $2", [owner, name]);
    },
  };

  return { ensure, list, save, remove, fill, cancel, request, tools, routes, requestById, internal };
}
export type Vault = ReturnType<typeof createVault>;
