import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { mcpServers, mcpTools } from "../src/db/schema";
import { createPluginStore, type PluginStore } from "../src/plugins/store";
import { createChisaSkills } from "../src/skills-chisa/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

function makeInMemorySkillStore(): PluginStore {
  const map = new Map<string, { slug: string; title: string; summary: string; instructions: string; ownerUserId: string | null }>();
  return {
    async listSkills(actor: { id: string; isAdmin: boolean }) {
      const all = [...map.values()];
      if (actor.isAdmin) return all.map((s) => ({ ...s, tools: [] }));
      return all.filter((s) => s.ownerUserId === null || s.ownerUserId === actor.id).map((s) => ({ ...s, tools: [] }));
    },
    async skillOwner(slug: string) {
      const row = map.get(slug);
      return row ? row.ownerUserId : undefined;
    },
    async installSkill(input: { slug: string; title: string; summary: string; instructions: string; ownerUserId: string | null }) {
      map.set(input.slug, {
        slug: input.slug,
        title: input.title,
        summary: input.summary,
        instructions: input.instructions,
        ownerUserId: input.ownerUserId,
      });
    },
    async uninstallSkill(slug: string) {
      map.delete(slug);
    },
  } as unknown as PluginStore;
}

describe("CB-097b: global shared skills via /api/chisa-skills routes", () => {
  test("admin can create, import, edit, and delete global shared skills; normal users see them as read-only shared skills", async () => {
    const store = makeInMemorySkillStore();
    const actors: Record<string, { id: string; role: "admin" | "user" }> = {
      admin1: { id: "u_admin1", role: "admin" },
      member1: { id: "u_member1", role: "user" },
    };
    const chisa = createChisaSkills({
      store,
      actorFor: async (id) => ({ id, isAdmin: id === "u_admin1" }),
    });
    const app = new Hono<{ Variables: AppVariables }>();
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
      const who = c.req.header("X-Test-User") || "admin1";
      const actor = actors[who]!;
      c.set("actor", { kind: "user", id: actor.id, email: `${who}@test.local`, name: who, role: actor.role });
      await next();
    };
    app.route("/api/chisa-skills", chisa.routes(requireUser));

    // 1. 管理员通过 PUT 创建全局共享技能（shared: true → ownerUserId: null）。
    const putShared = await app.request("/api/chisa-skills/team-deploy", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "admin1" },
      body: JSON.stringify({
        title: "团队发布规范",
        summary: "发版前跑测试与快照对比",
        instructions: "1. bun test\n2. deploy-serial.sh",
        create: true,
        shared: true,
      }),
    });
    expect(putShared.status).toBe(200);
    const putBody = (await putShared.json()) as { skill: { slug: string; mine: boolean } };
    expect(putBody.skill).toMatchObject({ slug: "team-deploy", mine: false });

    // 2. 普通成员查询列表能看到该全局共享技能，且机器人目录里带（共享）标识。
    const memberListRes = await app.request("/api/chisa-skills", {
      headers: { "X-Test-User": "member1" },
    });
    expect(memberListRes.status).toBe(200);
    const memberList = (await memberListRes.json()) as { skills: Array<{ slug: string; mine: boolean }> };
    expect(memberList.skills).toEqual([expect.objectContaining({ slug: "team-deploy", mine: false })]);
    expect(await chisa.catalog("u_member1")).toContain("team-deploy：团队发布规范——发版前跑测试与快照对比（共享）");

    // 3. 普通成员不能覆盖或删除全局共享技能。
    const memberOverwrite = await app.request("/api/chisa-skills/team-deploy", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "member1" },
      body: JSON.stringify({ title: "篡改", summary: "", instructions: "bad" }),
    });
    expect(memberOverwrite.status).toBe(409);

    const memberDelete = await app.request("/api/chisa-skills/team-deploy", {
      method: "DELETE",
      headers: { "X-Test-User": "member1" },
    });
    expect(memberDelete.status).toBe(403);

    // 4. 管理员可以直接编辑全局共享技能，也可以通过 import 批量导入全局共享技能。
    const adminEdit = await app.request("/api/chisa-skills/team-deploy", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-User": "admin1" },
      body: JSON.stringify({
        title: "团队发布规范 v2",
        summary: "升级版规范",
        instructions: "1. bun test\n2. typecheck\n3. deploy",
        shared: true,
      }),
    });
    expect(adminEdit.status).toBe(200);
    expect(((await adminEdit.json()) as { skill: { title: string; mine: boolean } }).skill).toMatchObject({
      title: "团队发布规范 v2",
      mine: false,
    });

    const adminImport = await app.request("/api/chisa-skills/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-User": "admin1" },
      body: JSON.stringify({
        markdown: "---\nname: code-review-sop\ndescription: 代码审查清单\n---\n# 代码审查清单\n检查边界条件与权限校验。",
        shared: true,
      }),
    });
    expect(adminImport.status).toBe(200);
    expect(((await adminImport.json()) as { skill: { slug: string; mine: boolean } }).skill).toMatchObject({
      slug: "code-review-sop",
      mine: false,
    });

    // 5. 管理员可删除全局共享技能。
    const adminDelete = await app.request("/api/chisa-skills/team-deploy", {
      method: "DELETE",
      headers: { "X-Test-User": "admin1" },
    });
    expect(adminDelete.status).toBe(204);
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("CB-097c: global MCP auto-grant store (PostgreSQL)", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const store = url
    ? createPluginStore({
        database,
        credentials: {} as never,
      })
    : (null as never);
  const serverId = `test-mcp-${randomUUID().slice(0, 8)}`;
  const fakeAgentId = randomUUID();

  beforeAll(async () => {
    await database.$client.unsafe(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id text PRIMARY KEY,
        title text NOT NULL,
        logo text,
        vendor text,
        url text NOT NULL,
        provenance text,
        credential_id uuid,
        auth_scheme text NOT NULL DEFAULT 'none',
        tools_refreshed_at timestamptz,
        last_error text,
        added_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS mcp_tools (
        server_id text NOT NULL,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
        effect text DEFAULT 'read',
        destructive boolean NOT NULL DEFAULT false,
        version text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (server_id, name)
      );
      ALTER TABLE mcp_tools ADD COLUMN IF NOT EXISTS version text;
      ALTER TABLE mcp_tools ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
      DROP TABLE IF EXISTS plugin_grants;
      CREATE TABLE IF NOT EXISTS plugin_grants (
        kind text NOT NULL,
        ref text NOT NULL,
        agent_id text NOT NULL,
        granted_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, ref, agent_id)
      );
      CREATE TABLE IF NOT EXISTS skills (
        id text PRIMARY KEY,
        owner_user_id text,
        slug text NOT NULL UNIQUE,
        title text NOT NULL,
        summary text NOT NULL,
        instructions text NOT NULL,
        origin text NOT NULL DEFAULT 'yours',
        installed_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS skill_tools (
        skill_id text NOT NULL,
        ref text NOT NULL,
        declared_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (skill_id, ref)
      );
      CREATE TABLE IF NOT EXISTS agent_configs (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        title text,
        owner_id text,
        visibility text NOT NULL DEFAULT 'private',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS credentials (
        id uuid PRIMARY KEY,
        label text NOT NULL,
        kind text NOT NULL,
        ciphertext text NOT NULL,
        iv text NOT NULL,
        auth_tag text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      DROP TABLE IF EXISTS chisabot_mcp_global_grants;
      CREATE TABLE IF NOT EXISTS chisabot_mcp_global_grants (
        server_id text PRIMARY KEY,
        enabled boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await database.insert(mcpServers).values({
      id: serverId,
      title: "全员共享测试 MCP",
      url: "https://mcp.example.com/sse",
      authScheme: "none",
    });
    await database.insert(mcpTools).values({
      serverId,
      name: "search_docs",
      description: "检索内部文档",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      effect: "read",
      destructive: false,
    });
  });

  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM chisabot_mcp_global_grants WHERE server_id = $1", [serverId]);
    await database.$client.unsafe("DELETE FROM mcp_tools WHERE server_id = $1", [serverId]);
    await database.$client.unsafe("DELETE FROM mcp_servers WHERE id = $1", [serverId]);
  });

  test("enabling autoGrantAll grants all tools of the MCP server to any agent without per-agent rows", async () => {
    // 默认未开启时，没有任何授权的机器人拿不到工具且 decide 拒绝。
    const beforeServers = await store.listServers();
    expect(beforeServers.find((s) => s.id === serverId)?.autoGrantAll).toBe(false);
    expect((await store.listForAgent(fakeAgentId)).tools.some((t) => t.ref === `${serverId}/search_docs`)).toBe(false);
    expect((await store.decide("mcp", `${serverId}/search_docs`, fakeAgentId)).allowed).toBe(false);

    // 管理员开启全员默认授权。
    await store.setServerAutoGrantAll(serverId, true, "u_admin");
    const afterServers = await store.listServers();
    expect(afterServers.find((s) => s.id === serverId)?.autoGrantAll).toBe(true);

    // 任意新机器人无需写 plugin_grants 表即可直接获得该 MCP 服务器的工具并通过权限检查。
    const granted = await store.listForAgent(fakeAgentId);
    expect(granted.tools.some((t) => t.ref === `${serverId}/search_docs`)).toBe(true);
    expect(await store.decide("mcp", `${serverId}/search_docs`, fakeAgentId)).toEqual({ allowed: true });

    // 管理员关闭全员默认授权后立即收回。
    await store.setServerAutoGrantAll(serverId, false, "u_admin");
    expect((await store.listForAgent(fakeAgentId)).tools.some((t) => t.ref === `${serverId}/search_docs`)).toBe(false);
    expect((await store.decide("mcp", `${serverId}/search_docs`, fakeAgentId)).allowed).toBe(false);
  });
});
