import { describe, expect, test } from "bun:test";
import type { Database } from "../src/db/client";
import { createPersonalSources, WebhookRateLimitError } from "../src/personal-sources/service";
import type { PluginStore } from "../src/plugins/store";
import { createChisaSkills } from "../src/skills-chisa/tools";

/** 技能（DESIGN.md §51）：目录、加载、新建 / 改写只动自己的、局部修改、搜索。用假的插件存储。 */
type Row = { slug: string; title: string; summary: string; instructions: string; ownerUserId: string | null };
function fakeStore(rows: Row[]) {
  return {
    async listSkills(actor?: { id: string; isAdmin: boolean }) {
      return rows.filter((row) => !actor || actor.isAdmin || row.ownerUserId === null || row.ownerUserId === actor.id).map((row) => ({ ...row, id: row.slug }));
    },
    async skillOwner(slug: string) {
      const row = rows.find((r) => r.slug === slug);
      return row ? row.ownerUserId : undefined;
    },
    async installSkill(input: Row & { by: string }) {
      const existing = rows.find((r) => r.slug === input.slug);
      if (existing) Object.assign(existing, { title: input.title, summary: input.summary, instructions: input.instructions });
      else rows.push({ slug: input.slug, title: input.title, summary: input.summary, instructions: input.instructions, ownerUserId: input.ownerUserId });
    },
    async uninstallSkill(slug: string) {
      rows.splice(rows.findIndex((r) => r.slug === slug), 1);
    },
  } as unknown as PluginStore;
}

describe("chisa skills", () => {
  const rows: Row[] = [
    { slug: "shared-triage", title: "分诊", summary: "处理工单时", instructions: "按优先级分。", ownerUserId: null },
    { slug: "alice-report", title: "写周报", summary: "写周报时", instructions: "1. 列本周完成\n2. 列下周计划", ownerUserId: "alice" },
    { slug: "bob-secret", title: "Bob 的", summary: "", instructions: "x", ownerUserId: "bob" },
  ];
  // alice 是管理员：设置里能看到 bob 的，但机器人不该用别人的技能。
  const skills = createChisaSkills({ store: fakeStore(rows), actorFor: async (id) => ({ id, isAdmin: id === "alice" }) });
  const run = (name: string, args: unknown) => skills.tools("alice", "bot-1").find((tool) => tool.name === name)!.execute(args);

  test("catalog lists own + shared, never someone else's", async () => {
    const catalog = await skills.catalog("alice");
    expect(catalog).toContain("alice-report");
    expect(catalog).toContain("shared-triage");
    expect(catalog).not.toContain("bob-secret");
  });
  test("load returns the instructions", async () => {
    expect(await run("skill_load", { slug: "alice-report" })).toContain("列本周完成");
    expect(await run("skill_load", { slug: "bob-secret" })).toContain("没有叫");
  });
  test("save creates own skills and refuses names taken by others", async () => {
    expect(await run("skill_save", { slug: "trip-plan", title: "做行程", summary: "规划旅行时", instructions: "先问预算" })).toContain("已新建");
    expect(rows.find((r) => r.slug === "trip-plan")?.ownerUserId).toBe("alice");
    expect(await run("skill_save", { slug: "shared-triage", title: "x", summary: "", instructions: "y" })).toContain("占用");
    expect(await run("skill_save", { slug: "Bad Name", title: "x", summary: "", instructions: "y" })).toContain("小写");
  });
  test("edit replaces one exact passage of own skills only", async () => {
    expect(await run("skill_edit", { slug: "alice-report", find: "列下周计划", replace: "列下周计划和风险" })).toContain("已修改");
    expect(rows.find((r) => r.slug === "alice-report")?.instructions).toContain("风险");
    expect(await run("skill_edit", { slug: "shared-triage", find: "按优先级", replace: "z" })).toContain("只读");
    expect(await run("skill_edit", { slug: "alice-report", find: "不存在的话", replace: "z" })).toContain("没找到");
  });
  test("list searches Chinese titles", async () => {
    const out = await run("skill_list", { query: "周报" });
    expect(out.split("\n")[0]).toContain("alice-report");
  });
  test("skill_import_url blocks internal/private URLs via guardedFetch before calling fetchImpl", async () => {
    let called = false;
    const guardedSkills = createChisaSkills({
      store: fakeStore(rows),
      actorFor: async (id) => ({ id, isAdmin: id === "alice" }),
      fetchImpl: (async () => {
        called = true;
        return new Response("# Should Not Reach");
      }) as unknown as typeof fetch,
    });
    const importTool = guardedSkills.tools("alice", "bot-1").find((tool) => tool.name === "skill_import_url")!;
    const out = await importTool.execute({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(called).toBe(false);
    expect(out).toContain("不能访问内网地址");
  });
});

describe("personal sources security, morning brief SQL, and webhook protections", () => {
  function fakeDatabase() {
    const rowsByUser = new Map<string, Record<string, unknown>>();
    const notes = new Map<string, { id: string; owner_user_id: string; kind: string; subject: string; content: string; shared: boolean }>();
    const sqlQueries: string[] = [];
    const sql = {
      async unsafe(query: string, params: unknown[] = []) {
        sqlQueries.push(query);
        if (query.includes("SELECT * FROM chisabot_personal_sources WHERE owner_user_id = $1")) {
          const row = rowsByUser.get(params[0] as string);
          return row ? [row] : [];
        }
        if (query.includes("SELECT * FROM chisabot_personal_sources WHERE inbound_webhook_token = $1")) {
          const token = params[0] as string;
          const found = [...rowsByUser.values()].find((r) => r.inbound_webhook_token === token);
          return found ? [found] : [];
        }
        if (query.includes("UPDATE chisabot_personal_sources SET inbound_last_at")) {
          const [userId, summary] = params as [string, string];
          const existing = rowsByUser.get(userId);
          if (existing) existing.inbound_last_summary = summary;
          return [];
        }
        if (query.includes("FROM chisabot_memory_notes WHERE owner_user_id = $1 AND kind = 'daily'")) {
          const [userId, subject] = params as [string, string];
          const found = [...notes.values()].find(
            (n) => n.owner_user_id === userId && n.kind === "daily" && n.subject.toLowerCase() === subject.toLowerCase() && !n.shared,
          );
          return found ? [{ id: found.id, content: found.content }] : [];
        }
        if (query.includes("UPDATE chisabot_memory_notes SET content = $2")) {
          const [id, content] = params as [string, string];
          const existing = notes.get(id);
          if (existing) existing.content = content;
          return [];
        }
        if (query.includes("SELECT count(*)::int AS n FROM chisabot_memory_notes")) {
          const [userId] = params as [string];
          const n = [...notes.values()].filter((note) => note.owner_user_id === userId).length;
          return [{ n }];
        }
        if (query.includes("INSERT INTO chisabot_memory_notes")) {
          const [id, userId, subject, content] = params as [string, string, string, string];
          notes.set(id, { id, owner_user_id: userId, kind: "daily", subject, content, shared: false });
          return [];
        }
        if (query.includes("FROM chisabot_schedules")) {
          return [{ title: "晨会同步", instruction: "提醒团队开会", cron: "0 9 * * *", run_at: null }];
        }
        if (query.includes("FROM chisabot_memory_notes")) {
          return [];
        }
        return [];
      },
    };
    return {
      database: { $client: sql } as unknown as Database,
      rowsByUser,
      notes,
      sqlQueries,
    };
  }

  test("rejects private/internal URLs on notify webhook connection and CRLF in SMTP headers", async () => {
    const { database, rowsByUser } = fakeDatabase();
    rowsByUser.set("u1", { owner_user_id: "u1", email_address: "alice@example.com", imap_pass_enc: "invalid" });
    const svc = createPersonalSources(database, {
      encryptionKey: "test-secret-key",
      actorFor: async (id) => ({ id, isAdmin: false }),
    });
    await expect(svc.connectNotifyWebhook("u1", { url: "http://169.254.169.254/hook" })).rejects.toThrow("不能访问内网地址");
    await expect(svc.sendSmtpEmail("u1", { to: "bob@example.com\r\nBcc: evil@example.com", subject: "hi", body: "test" })).rejects.toThrow(
      "不能包含换行或控制字符",
    );
  });

  test("morning brief queries title and instruction columns from chisabot_schedules", async () => {
    const { database, sqlQueries } = fakeDatabase();
    const svc = createPersonalSources(database, {
      encryptionKey: "test-secret-key",
      actorFor: async (id) => ({ id, isAdmin: false }),
      fetchFn: (async () => new Response(" Sunny +22°C ")) as unknown as typeof fetch,
    });
    const brief = await svc.generateMorningBrief("u1");
    expect(brief.markdown).toContain("晨会同步");
    const scheduleQuery = sqlQueries.find((q) => q.includes("FROM chisabot_schedules")) ?? "";
    expect(scheduleQuery).toContain("SELECT title, instruction, cron, run_at FROM chisabot_schedules");
    expect(scheduleQuery).not.toContain("description");
  });

  test("webhook merges into single daily memory note and enforces 30/min per-token rate limit", async () => {
    const { database, rowsByUser, notes } = fakeDatabase();
    const token = "whk_testtoken1234567890";
    rowsByUser.set("u1", { owner_user_id: "u1", inbound_webhook_token: token });
    const svc = createPersonalSources(database, {
      encryptionKey: "test-secret-key",
      actorFor: async (id) => ({ id, isAdmin: false }),
    });

    const first = await svc.triggerInboundWebhook(token, { title: "构建完成\r\nInjected", message: "v1.0.0" });
    expect(first?.ok).toBe(true);
    const second = await svc.triggerInboundWebhook(token, { title: "部署完成", message: "prod" });
    expect(second?.ok).toBe(true);
    // Should merge into a single daily note rather than creating unbounded webhook notes
    expect(notes.size).toBe(1);
    const note = [...notes.values()][0]!;
    expect(note.kind).toBe("daily");
    expect(note.content).toContain("构建完成 Injected：v1.0.0");
    expect(note.content).toContain("部署完成：prod");

    for (let i = 2; i < 30; i += 1) {
      await svc.triggerInboundWebhook(token, { title: `ev-${i}` });
    }
    await expect(svc.triggerInboundWebhook(token, { title: "ev-31" })).rejects.toBeInstanceOf(WebhookRateLimitError);
  });
});
