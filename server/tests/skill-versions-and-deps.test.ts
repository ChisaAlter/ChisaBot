import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { PluginStore } from "../src/plugins/store";
import { createChisaSkills } from "../src/skills-chisa/tools";
import {
  computeLineDiff,
  createMemorySkillVersionStore,
  extractSkillRequiresTools,
  filterSkillsByAvailableTools,
  MAX_SKILL_AUX_FILE_BYTES,
  SkillVersionError,
  validateSkillAuxFilePath,
} from "../src/skills-chisa/version-store";

type FakeSkillRow = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  ownerUserId: string | null;
};

function createFakePluginStore(rows: FakeSkillRow[]): PluginStore {
  return {
    async listSkills(actor?: { id: string; isAdmin: boolean }) {
      return rows
        .filter(
          (row) =>
            !actor ||
            actor.isAdmin ||
            row.ownerUserId === null ||
            row.ownerUserId === actor.id,
        )
        .map((row) => ({
          ...row,
          id: row.slug,
          origin: "user",
          installedBy: row.ownerUserId,
          grantedTo: [],
          tools: [],
        }));
    },
    async skillOwner(slug: string) {
      const row = rows.find((r) => r.slug === slug);
      return row ? row.ownerUserId : undefined;
    },
    async installSkill(input: FakeSkillRow & { by: string }) {
      const existing = rows.find((r) => r.slug === input.slug);
      if (existing) {
        existing.title = input.title;
        existing.summary = input.summary;
        existing.instructions = input.instructions;
      } else {
        rows.push({
          slug: input.slug,
          title: input.title,
          summary: input.summary,
          instructions: input.instructions,
          ownerUserId: input.ownerUserId,
        });
      }
    },
    async uninstallSkill(slug: string) {
      const idx = rows.findIndex((r) => r.slug === slug);
      if (idx >= 0) rows.splice(idx, 1);
    },
  } as unknown as PluginStore;
}

describe("skill version stack, line diff, rollback, and multi-file read-only store", () => {
  test("records content-addressed immutable revisions, diffs lines, and rolls back cleanly", async () => {
    const store = createMemorySkillVersionStore();

    const v1 = await store.recordRevision({
      skillSlug: "weekly-report",
      title: "周报助手",
      summary: "每周五整理周报",
      instructions: "1. 收集本周任务\n2. 列出下周计划",
      requiresTools: ["calendar_list_events"],
      author: "u-alice",
      reason: "初始版本",
    });

    const v2 = await store.recordRevision({
      skillSlug: "weekly-report",
      title: "周报助手",
      summary: "每周五整理周报",
      instructions: "1. 收集本周任务\n2. 补充风险项\n3. 列出下周计划",
      requiresTools: ["calendar_list_events", "email_list_recent"],
      author: "bot:assistant",
      reason: "增加风险项",
    });

    // 相同内容不重复生成新快照（按 SHA-256 不可变去重）
    const v2Dup = await store.recordRevision({
      skillSlug: "weekly-report",
      title: "周报助手",
      summary: "每周五整理周报",
      instructions: "1. 收集本周任务\n2. 补充风险项\n3. 列出下周计划",
      requiresTools: ["email_list_recent", "calendar_list_events"],
      author: "u-alice",
      reason: "重复保存",
    });
    expect(v2Dup.revisionId).toBe(v2.revisionId);
    expect(v2Dup.contentSha256).toBe(v2.contentSha256);

    const listed = await store.listRevisions("weekly-report");
    expect(listed.currentRevisionId).toBe(v2.revisionId);
    expect(listed.revisions).toHaveLength(2);
    expect(listed.revisions[0]?.revisionId).toBe(v2.revisionId);
    expect(listed.revisions[1]?.revisionId).toBe(v1.revisionId);

    // 行级 Diff 验证
    const diff = await store.diffRevisions(
      "weekly-report",
      v1.revisionId,
      v2.revisionId,
    );
    expect(diff.addedLines).toBeGreaterThanOrEqual(2);
    expect(diff.removedLines).toBeGreaterThanOrEqual(1);
    expect(
      diff.lines.some((l) => l.type === "add" && l.text.includes("补充风险项")),
    ).toBe(true);

    // 回滚到 v1：当前激活指针回到 v1，且 v2 不可变快照依然完好
    const rolled = await store.rollbackToRevision(
      "weekly-report",
      v1.revisionId,
    );
    expect(rolled.revisionId).toBe(v1.revisionId);
    expect(rolled.instructions).toBe("1. 收集本周任务\n2. 列出下周计划");
    expect(rolled.requiresTools).toEqual(["calendar_list_events"]);

    const afterRollback = await store.listRevisions("weekly-report");
    expect(afterRollback.currentRevisionId).toBe(v1.revisionId);
    expect(afterRollback.revisions).toHaveLength(2);
    expect(
      afterRollback.revisions.find((r) => r.revisionId === v2.revisionId),
    ).toBeDefined();

    // computeLineDiff 边界：相同文本零变更
    const noop = computeLineDiff("a\nb", "a\nb");
    expect(noop.addedLines).toBe(0);
    expect(noop.removedLines).toBe(0);
  });

  test("validates multi-file safe relative paths, 256 KiB cap, and secret scanning", async () => {
    expect(validateSkillAuxFilePath("templates/report.md")).toBe(
      "templates/report.md",
    );
    expect(validateSkillAuxFilePath("scripts/check.py")).toBe(
      "scripts/check.py",
    );

    for (const badPath of [
      "",
      "/etc/passwd",
      "../escape.txt",
      "templates/../escape.txt",
      "scripts\\run.py",
      "C:/temp.txt",
      "SKILL.md",
      "skill.md",
      ".env",
      "secrets/server.key",
      "dir/",
      "bad\x00name.txt",
    ]) {
      expect(() => validateSkillAuxFilePath(badPath)).toThrow(
        SkillVersionError,
      );
    }

    const store = createMemorySkillVersionStore();
    const saved = await store.setSkillFiles(
      "weekly-report",
      [
        { path: "templates/weekly.md", content: "# 周报模板\n- 本周完成" },
        { path: "scripts/format.py", content: "print('ok')" },
      ],
      "u-alice",
    );
    expect(saved).toHaveLength(2);
    expect(saved[0]?.readOnly).toBe(true);
    expect(saved[0]?.sha256).toHaveLength(64);

    // 文件/目录前缀冲突拒绝
    await expect(
      store.setSkillFiles(
        "weekly-report",
        [
          { path: "scripts", content: "conflict" },
          { path: "scripts/run.py", content: "print(1)" },
        ],
        "u-alice",
      ),
    ).rejects.toThrow("路径冲突");

    // 超过 256 KiB 单文件上限拒绝
    await expect(
      store.setSkillFiles(
        "weekly-report",
        [
          {
            path: "big.txt",
            content: "a".repeat(MAX_SKILL_AUX_FILE_BYTES + 1),
          },
        ],
        "u-alice",
      ),
    ).rejects.toThrow("256 KiB");

    // 辅助文件包含明文密钥拒绝
    await expect(
      store.setSkillFiles(
        "weekly-report",
        [
          {
            path: "scripts/leak.py",
            content: "KEY = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456'",
          },
        ],
        "u-alice",
      ),
    ).rejects.toThrow("安全扫描");
  });
});

describe("requiresTools dynamic hiding and chisa-skills integration", () => {
  test("filterSkillsByAvailableTools hides skills with unsatisfied tool dependencies", () => {
    const skills = [
      {
        slug: "plain-writing",
        instructions: "直接写文案，不依赖工具。",
      },
      {
        slug: "web-research",
        instructions: "需要联网搜索。",
        requiresTools: ["web_search", "web_fetch"],
      },
      {
        slug: "frontmatter-dep",
        instructions: "---\nrequiresTools:\n  - email_send\n---\n\n代发邮件。",
      },
      {
        slug: "comment-dep",
        instructions:
          "<!-- requiresTools: github-mcp/create_pr -->\n自动提 PR。",
      },
    ];

    expect(extractSkillRequiresTools(skills[2] ?? {})).toEqual(["email_send"]);
    expect(extractSkillRequiresTools(skills[3] ?? {})).toEqual([
      "github-mcp/create_pr",
    ]);

    // 只有 web_search（缺少 web_fetch / email_send / github-mcp/create_pr）-> 仅 plain-writing 可见
    expect(
      filterSkillsByAvailableTools(skills, ["web_search"]).map((s) => s.slug),
    ).toEqual(["plain-writing"]);

    // 补齐 web_fetch -> web-research 自动现身
    expect(
      filterSkillsByAvailableTools(skills, ["web_search", "web_fetch"]).map(
        (s) => s.slug,
      ),
    ).toEqual(["plain-writing", "web-research"]);

    // 补齐全部所需工具 -> 全部可见
    expect(
      filterSkillsByAvailableTools(skills, [
        "web_search",
        "web_fetch",
        "email_send",
        "github-mcp/create_pr",
      ]).map((s) => s.slug),
    ).toEqual([
      "plain-writing",
      "web-research",
      "frontmatter-dep",
      "comment-dep",
    ]);
  });

  test("records revisions on skill_save/skill_edit, hides skills in catalog/tools, and serves governance routes", async () => {
    const rows: FakeSkillRow[] = [];
    const versionStore = createMemorySkillVersionStore();
    const chisa = createChisaSkills({
      store: createFakePluginStore(rows),
      actorFor: async (id) => ({ id, isAdmin: id === "u-admin" }),
      versionStore,
    });

    const botTools = chisa.tools("u-alice", "bot-1", {
      availableToolNames: () => ["web_search"],
    });
    const run = (name: string, args: unknown) => {
      const target = botTools.find((t) => t.name === name);
      if (!target) throw new Error(`missing tool ${name}`);
      return target.execute(args);
    };

    // 1. skill_save 自动记录 v1（带 requiresTools）
    const createdMsg = await run("skill_save", {
      slug: "ops-audit",
      title: "运维巡检",
      summary: "检查节点健康",
      instructions: "步骤1：执行 df -h\n步骤2：看日志",
      requiresTools: ["web_search", "device_shell"],
      reason: "首次沉淀",
    });
    expect(createdMsg).toContain("已新建");

    // 2. skill_edit 自动记录 v2（保留 requiresTools）
    const editedMsg = await run("skill_edit", {
      slug: "ops-audit",
      find: "步骤2：看日志",
      replace: "步骤2：看最近 100 行错误日志",
      reason: "明确日志行数",
    });
    expect(editedMsg).toContain("已修改");

    const revState = await versionStore.listRevisions("ops-audit");
    expect(revState.revisions).toHaveLength(2);
    expect(revState.revisions[0]?.requiresTools).toEqual([
      "web_search",
      "device_shell",
    ]);

    // 3. 当前回合缺少 device_shell -> catalog 与 skill_list 自动隐身
    const hiddenCatalog = await chisa.catalog("u-alice", undefined, {
      availableToolNames: ["web_search"],
    });
    expect(hiddenCatalog).not.toContain("ops-audit");
    expect(await run("skill_list", {})).not.toContain("ops-audit");

    // 具备全部依赖工具 -> catalog 正常展示
    const visibleCatalog = await chisa.catalog("u-alice", undefined, {
      availableToolNames: ["web_search", "device_shell"],
    });
    expect(visibleCatalog).toContain("ops-audit");

    // 4. 路由验证：GET /:skillId/revisions, GET /:skillId/diff, POST /:skillId/rollback, PUT/GET /:skillId/files
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", {
        id: "u-alice",
        email: "alice@example.com",
        name: "Alice",
        image: null,
        role: "user",
      });
      await next();
    };
    const app = chisa.routes(requireUser);

    const revRes = await app.request("/ops-audit/revisions");
    expect(revRes.status).toBe(200);
    const revBody = (await revRes.json()) as {
      currentRevisionId: string;
      revisions: Array<{ revisionId: string; instructions: string }>;
    };
    expect(revBody.revisions).toHaveLength(2);
    const v1Id = revBody.revisions[1]?.revisionId ?? "";
    const v2Id = revBody.revisions[0]?.revisionId ?? "";

    const diffRes = await app.request(
      `/ops-audit/diff?from=${encodeURIComponent(v1Id)}&to=${encodeURIComponent(v2Id)}`,
    );
    expect(diffRes.status).toBe(200);
    const diffBody = (await diffRes.json()) as {
      diff: { addedLines: number; removedLines: number };
    };
    expect(diffBody.diff.addedLines).toBeGreaterThanOrEqual(1);

    const rollbackRes = await app.request("/ops-audit/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisionId: v1Id }),
    });
    expect(rollbackRes.status).toBe(200);
    expect(rows.find((r) => r.slug === "ops-audit")?.instructions).toContain(
      "步骤2：看日志",
    );

    // 写入一个 > 64 KiB 但 <= 256 KiB 的多文件只读资源，确认不会误触 64 KiB bodyLimit
    const largeTemplate = `# 巡检清单\n${"检查项说明\n".repeat(6000)}`;
    expect(Buffer.byteLength(largeTemplate, "utf8")).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(largeTemplate, "utf8")).toBeLessThan(
      MAX_SKILL_AUX_FILE_BYTES,
    );

    const putFilesRes = await app.request("/ops-audit/files", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ path: "templates/checklist.md", content: largeTemplate }],
      }),
    });
    expect(putFilesRes.status).toBe(200);

    const getFilesRes = await app.request("/ops-audit/files");
    expect(getFilesRes.status).toBe(200);
    const filesBody = (await getFilesRes.json()) as {
      files: Array<{ path: string; readOnly: boolean }>;
    };
    expect(filesBody.files).toHaveLength(1);
    expect(filesBody.files[0]?.path).toBe("templates/checklist.md");
    expect(filesBody.files[0]?.readOnly).toBe(true);

    // skill_read_file 工具在满足工具依赖时可读该只读辅助文件
    const fullTools = chisa.tools("u-alice", "bot-1", {
      availableToolNames: ["web_search", "device_shell"],
    });
    const readTool = fullTools.find((t) => t.name === "skill_read_file");
    const fileText = await readTool?.execute({
      slug: "ops-audit",
      path: "templates/checklist.md",
    });
    expect(fileText).toContain("巡检清单");
  });
});
