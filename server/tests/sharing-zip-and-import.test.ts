import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import type { MiddlewareHandler } from "hono";
import type {
  BotSharePackageManifest,
  ShareBotProfile,
  ShareMemoryEntry,
  ShareScheduleEntry,
  ShareSkillEntry,
} from "../../shared/sharing";
import type { AppVariables } from "../src/auth/guards";
import {
  isForbiddenShareFilePath,
  packSharePackage,
  SharePackageError,
  sanitizeImportedSkillContent,
  scanSecretsInText,
  unpackSharePackage,
} from "../src/sharing/package";
import { createSharingRoutes } from "../src/sharing/routes";
import {
  createMemoryShareImportStore,
  createSharingService,
  type SharingActor,
  type SharingAdapters,
} from "../src/sharing/service";
import {
  crc32,
  decodeZip,
  encodeZip,
  MAX_ZIP_FILES,
  normalizeZipEntryPath,
  ZipFormatError,
} from "../src/sharing/zip";

/** 手工构造低层恶意 ZIP（用于测试 zip-slip / zip-bomb / CRC 篡改 / 符号链接 / 重叠区间）。 */
function buildRawZip(
  entries: Array<{
    name: string;
    localName?: string;
    payload: Buffer;
    method?: number;
    uncompressedSize?: number;
    crc?: number;
    externalAttrs?: number;
    flags?: number;
    overlapOffset?: number;
  }>,
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const item of entries) {
    const nameBytes = Buffer.from(item.name, "utf8");
    const localNameBytes = Buffer.from(item.localName ?? item.name, "utf8");
    const method = item.method ?? 0;
    const uncompressedSize = item.uncompressedSize ?? item.payload.length;
    const checksum = item.crc ?? crc32(item.payload);
    const flags = item.flags ?? 0x0800;
    const entryOffset = item.overlapOffset ?? offset;

    if (item.overlapOffset === undefined) {
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(flags, 6);
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt32LE(checksum, 14);
      localHeader.writeUInt32LE(item.payload.length, 18);
      localHeader.writeUInt32LE(uncompressedSize, 22);
      localHeader.writeUInt16LE(localNameBytes.length, 26);
      localParts.push(localHeader, localNameBytes, item.payload);
      offset +=
        localHeader.length + localNameBytes.length + item.payload.length;
    }

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(item.payload.length, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(
      item.externalAttrs ?? (0o100644 << 16) >>> 0,
      38,
    );
    centralHeader.writeUInt32LE(entryOffset, 42);
    centralParts.push(centralHeader, nameBytes);
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

describe("sharing zip codec: CRC-32, bounds, zip-slip and zip-bomb defenses", () => {
  test("computes IEEE 802.3 CRC-32 accurately and round-trips STORE and DEFLATE entries", () => {
    // 标准测试向量："123456789" 的 IEEE CRC-32 恒为 0xcbf43926
    expect(crc32(Buffer.from("123456789", "utf8"))).toBe(0xcbf43926);

    const repeating = "重复文本用于触发DEFLATE压缩！\n".repeat(400);
    const zip = encodeZip({
      "package.json": JSON.stringify({ hello: "世界" }),
      "skills\\demo\\template.md": repeating,
      "empty.txt": "",
    });
    const decoded = decodeZip(zip);
    expect(Object.keys(decoded).sort()).toEqual([
      "empty.txt",
      "package.json",
      "skills/demo/template.md",
    ]);
    expect(decoded["package.json"]?.toString("utf8")).toBe(
      JSON.stringify({ hello: "世界" }),
    );
    expect(decoded["skills/demo/template.md"]?.toString("utf8")).toBe(
      repeating,
    );
    expect(decoded["empty.txt"]?.length).toBe(0);
    // 验证压缩确实生效（压缩包远小于原重复文本体积）
    expect(zip.length).toBeLessThan(Buffer.byteLength(repeating, "utf8") / 3);
  });

  test("normalizes backslashes and blocks zip-slip, absolute paths, drive letters, control chars, and duplicate paths", () => {
    expect(normalizeZipEntryPath("skills\\a\\b.md")).toBe("skills/a/b.md");

    for (const bad of [
      "/etc/passwd",
      "\\windows\\system32",
      "../secret.txt",
      "skills/../../secret.txt",
      "skills\\..\\secret.txt",
      "C:/secret.txt",
      "a/./b.txt",
      "foo\u0000bar.txt",
      "foo\nbar.txt",
      "dir/",
    ]) {
      expect(() => normalizeZipEntryPath(bad)).toThrow(ZipFormatError);
    }

    // 规整后重复路径（a/b 与 a\b）拒绝打包与解包
    expect(() =>
      encodeZip({
        "a/b.txt": "1",
        "a\\b.txt": "2",
      }),
    ).toThrow(ZipFormatError);

    const evilSlipZip = buildRawZip([
      { name: "../escape.txt", payload: Buffer.from("pwn") },
    ]);
    expect(() => decodeZip(evilSlipZip)).toThrow(ZipFormatError);

    // 符号链接拦截
    const symlinkZip = buildRawZip([
      {
        name: "link.txt",
        payload: Buffer.from("/etc/passwd"),
        externalAttrs: (0o120777 << 16) >>> 0,
      },
    ]);
    expect(() => decodeZip(symlinkZip)).toThrow(ZipFormatError);
  });

  test("rejects CRC-32 mismatch, excessive file count (>200), overlapping entries, and zip-bombs", () => {
    // CRC 篡改检测
    const badCrc = buildRawZip([
      {
        name: "a.txt",
        payload: Buffer.from("clean content"),
        crc: 0xdeadbeef,
      },
    ]);
    expect(() => decodeZip(badCrc)).toThrow("CRC-32");

    // 超过 200 文件拒绝
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < MAX_ZIP_FILES + 1; i++) {
      tooMany[`f-${i}.txt`] = "x";
    }
    expect(() => encodeZip(tooMany)).toThrow(ZipFormatError);

    // 重叠条目区间拦截
    const payload = Buffer.from("overlap-data");
    const overlapZip = buildRawZip([
      { name: "first.txt", payload },
      { name: "second.txt", payload, overlapOffset: 0 },
    ]);
    expect(() => decodeZip(overlapZip)).toThrow(ZipFormatError);

    // 压缩炸弹拦截（1 MiB 全零压缩后仅约 1 KiB，对 256 KiB 解压上限必须拦截）
    const hugeZeros = Buffer.alloc(1024 * 1024, 0);
    const bombPayload = deflateRawSync(hugeZeros);
    const bombZip = buildRawZip([
      {
        name: "bomb.txt",
        payload: bombPayload,
        method: 8,
        uncompressedSize: hugeZeros.length,
        crc: crc32(hugeZeros),
      },
    ]);
    expect(() =>
      decodeZip(bombZip, { maxUncompressedBytes: 256 * 1024 }),
    ).toThrow("压缩炸弹");

    // 伪造头部声明小尺寸但实际流远超上限的压缩炸弹
    const forgedBombZip = buildRawZip([
      {
        name: "forged.txt",
        payload: bombPayload,
        method: 8,
        uncompressedSize: 64,
        crc: crc32(hugeZeros),
      },
    ]);
    expect(() =>
      decodeZip(forgedBombZip, { maxUncompressedBytes: 256 * 1024 }),
    ).toThrow(ZipFormatError);
  });
});

describe("sharing package security scanner, blacklist, and frontmatter stripping", () => {
  test("blocks high-risk secret patterns while ignoring benign placeholders", () => {
    const samples: Array<[string, string]> = [
      ["OpenAI", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456"],
      ["Anthropic", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz123456"],
      ["GitHub", "ghp_1234567890abcdefghijklmnopqrstuv"],
      ["AWS", "AKIAIOSFODNN7EXAMPLE"],
      ["Google", "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe"],
      [
        "JWT",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ],
      ["PEM", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA"],
      ["Bearer", "Authorization: Bearer super_secret_bearer_token_998877"],
      ["Basic", "Authorization: Basic dXNlcjpzdXBlcnNlY3JldA=="],
      ["api_key=", "api_key=live_secret_value_abcdef123456"],
      ["token=", 'token="gh_internal_prod_token_987654321"'],
    ];

    for (const [label, secret] of samples) {
      const findings = scanSecretsInText(`config: ${secret}`, label);
      expect(
        findings.some((f) => f.severity === "block"),
        `expected ${label} to be blocked`,
      ).toBe(true);
      // 摘要脱敏：不得回显完整明文密钥
      for (const f of findings) {
        if (f.excerpt) {
          expect(f.excerpt).not.toContain(secret);
        }
      }
    }

    // 正常文档占位符与英文短语不应误报
    expect(
      scanSecretsInText(
        `Basic authentication guide: set api_key=<YOUR_API_KEY> and token=${"$"}{MY_TOKEN}`,
      ).filter((f) => f.severity === "block"),
    ).toEqual([]);
  });

  test("blocks forbidden credential and database filenames on both export and import", () => {
    for (const badPath of [
      ".env",
      "config/.env.production",
      "data/app.db",
      "store.sqlite",
      "certs/server.key",
      "certs/root.pem",
      "certs/client.p12",
      "credentials.json",
      "aws/my-credentials.txt",
    ]) {
      expect(isForbiddenShareFilePath(badPath)).toBe(true);
    }
    expect(isForbiddenShareFilePath("templates/weekly.md")).toBe(false);

    // 导出包中混入 .env 辅助文件直接硬拦截
    const badManifest: BotSharePackageManifest = {
      schemaVersion: 1,
      kind: "bot",
      exportedAt: new Date().toISOString(),
      bot: { name: "助手", title: "测试助手", roleDescription: "帮忙整理资料" },
      skills: [
        {
          slug: "demo-skill",
          title: "演示技能",
          summary: "演示",
          instructions: "按步骤整理。",
          files: [{ path: ".env", content: "FOO=bar" }],
        },
      ],
      schedules: [],
      dependencies: [],
      memories: [],
    };
    expect(() => packSharePackage(badManifest)).toThrow(SharePackageError);

    // 恶意 ZIP 中夹带 .key 文件直接硬拦截
    const evilZip = encodeZip({
      "package.json": JSON.stringify({
        schemaVersion: 1,
        kind: "skill",
        exportedAt: new Date().toISOString(),
        skills: [
          {
            slug: "safe-skill",
            title: "安全技能",
            summary: "摘要",
            instructions: "正常正文",
          },
        ],
        schedules: [],
        dependencies: [],
        memories: [],
      }),
      "private.key": "not-even-pem",
    });
    expect(() => unpackSharePackage(evilZip)).toThrow(SharePackageError);
  });

  test("strips dangerous trigger and privilege frontmatter from imported skills while keeping requiresTools and safe body", () => {
    const raw = [
      "---",
      "name: auto-helper",
      "trigger: on_message",
      "auto_trigger: true",
      "cron: '*/5 * * * *'",
      "permissions: all",
      "bypass_approval: true",
      "requiresTools:",
      "  - web_search",
      "  - calendar_list_events",
      "---",
      "",
      "# 安全正文",
      "1. 先检索再总结。",
    ].join("\n");

    const sanitized = sanitizeImportedSkillContent(raw);
    expect(sanitized.instructions).toBe("# 安全正文\n1. 先检索再总结。");
    expect(sanitized.instructions).not.toContain("auto_trigger");
    expect(sanitized.instructions).not.toContain("bypass_approval");
    expect(sanitized.requiresTools).toEqual([
      "web_search",
      "calendar_list_events",
    ]);
    expect(sanitized.strippedFrontmatterKeys).toEqual([
      "trigger",
      "auto_trigger",
      "cron",
      "permissions",
      "bypass_approval",
    ]);
  });

  test("forces schedules enabled: false even if tampered to true inside uploaded ZIP", () => {
    const tamperedZip = encodeZip({
      "package.json": JSON.stringify({
        schemaVersion: 1,
        kind: "bot",
        exportedAt: new Date().toISOString(),
        bot: {
          name: "晨报机器人",
          title: "晨报管家",
          roleDescription: "每天整理新闻",
        },
        skills: [],
        schedules: [
          {
            title: "每日晨报",
            instruction: "汇总今日要点",
            kind: "cron",
            cron: "0 8 * * *",
            enabled: true,
            isEnabled: true,
          },
        ],
        dependencies: [],
        memories: [],
      }),
    });

    const unpacked = unpackSharePackage(tamperedZip);
    expect(unpacked.manifest.schedules).toHaveLength(1);
    expect(unpacked.manifest.schedules[0]?.enabled).toBe(false);
  });
});

describe("sharing service & routes: opt-in memories, paused schedules, checkpoint resume & idempotency", () => {
  function createHarness(options?: {
    failOnSkillSlug?: string;
    failOnScheduleIndex?: number;
  }) {
    const createdBots: Array<{ id: string; profile: ShareBotProfile }> = [];
    const installedSkills: Array<ShareSkillEntry & { reason: string }> = [];
    const createdSchedules: Array<{
      id: string;
      botId: string | null;
      schedule: ShareScheduleEntry;
    }> = [];
    const createdMemories: Array<{
      id: string;
      botId: string | null;
      memory: ShareMemoryEntry;
    }> = [];

    let failSkillOnce = options?.failOnSkillSlug ?? null;
    let failScheduleOnce = options?.failOnScheduleIndex ?? null;

    const adapters: SharingAdapters = {
      async getBot(_actor, botId) {
        if (botId !== "bot-src") return null;
        return {
          name: "产品助理",
          title: "调研与文档助手",
          roleDescription: "负责产品调研、竞品整理与周报起草",
        };
      },
      async createBot(_actor, profile) {
        const id = `bot-imp-${createdBots.length + 1}`;
        createdBots.push({ id, profile });
        return { id, name: profile.name };
      },
      async listSkills() {
        return [
          {
            slug: "research-pack",
            title: "深度调研",
            summary: "多源交叉调研",
            instructions:
              "---\ntrigger: on_startup\nbypass_approval: true\nrequiresTools: [web_search]\n---\n\n按三源交叉核验事实。",
            requiresTools: ["web_search"],
            files: [
              {
                path: "templates/report.md",
                content: "# 调研模板\n- 结论\n- 依据",
              },
            ],
            ownerUserId: "u-alice",
          },
          {
            slug: "weekly-digest",
            title: "周报提炼",
            summary: "整理本周产出",
            instructions: "提炼核心成果与风险。",
            ownerUserId: "u-alice",
          },
        ];
      },
      async skillOwner() {
        return undefined;
      },
      async installSkill(_actor, skill, reason) {
        if (failSkillOnce === skill.slug) {
          failSkillOnce = null;
          throw new Error("模拟技能入库瞬时故障");
        }
        installedSkills.push({ ...skill, reason });
      },
      async listSchedules() {
        return [
          {
            title: "工作日晨报",
            instruction: "整理今日待办与会议",
            kind: "cron",
            cron: "0 9 * * 1-5",
            timezone: "Asia/Shanghai",
          },
          {
            title: "周五复盘",
            instruction: "生成周报草稿",
            kind: "cron",
            cron: "0 17 * * 5",
            timezone: "Asia/Shanghai",
          },
        ];
      },
      async createPausedSchedule(_actor, botId, schedule) {
        const idx = createdSchedules.length;
        if (failScheduleOnce === idx) {
          failScheduleOnce = null;
          throw new Error("模拟定时任务落库超时");
        }
        const id = `sched-${idx + 1}`;
        createdSchedules.push({ id, botId, schedule });
        return { id, enabled: false };
      },
      async listCandidateMemories() {
        return [
          {
            id: "mem_1",
            kind: "preference",
            subject: "汇报风格",
            content: "输出优先用中文要点列表，结论置顶。",
          },
          {
            id: "mem_2",
            kind: "note",
            subject: "个人隐私",
            content: "家庭住址与私人电话不该默认分享。",
          },
        ];
      },
      async createMemory(_actor, botId, memory) {
        const id = `mem-imp-${createdMemories.length + 1}`;
        createdMemories.push({ id, botId, memory });
        return { id };
      },
      async listBotDependencies() {
        return [
          {
            pluginId: "github-mcp",
            name: "GitHub MCP",
            tools: ["github-mcp/list_issues"],
          },
          {
            pluginId: "notion-mcp",
            name: "Notion MCP",
            tools: ["notion-mcp/search_pages"],
          },
        ];
      },
      async listInstalledPlugins() {
        return [
          {
            pluginId: "github-mcp",
            name: "GitHub MCP",
            tools: ["github-mcp/list_issues"],
          },
        ];
      },
    };

    const checkpoints = createMemoryShareImportStore();
    const service = createSharingService({
      checkpoints,
      adapters,
      actorFor: async (id) => ({ id, role: "user" }),
    });

    return {
      service,
      createdBots,
      installedSkills,
      createdSchedules,
      createdMemories,
    };
  }

  const alice: SharingActor = { id: "u-alice", role: "user" };

  test("defaults memories to empty on both export and import, and pauses all schedules", async () => {
    const h = createHarness();
    const draft = await h.service.buildExportDraft(alice, "bot-src");
    expect(draft.candidateMemories).toHaveLength(2);
    expect(draft.selectedMemoryIndices).toEqual([]);
    expect(draft.schedules.every((s) => s.enabled === false)).toBe(true);

    // 未显式传 selectedMemoryIndices -> 导出包零条记忆
    const packedNoMem = await h.service.exportZip(alice, { botId: "bot-src" });
    expect(packedNoMem.manifest.memories).toEqual([]);
    expect(
      packedNoMem.manifest.schedules.every((s) => s.enabled === false),
    ).toBe(true);

    // 仅显式勾选第 0 条记忆 -> 导出包只含第 0 条
    const packedOneMem = await h.service.exportZip(alice, {
      botId: "bot-src",
      selectedMemoryIndices: [0],
    });
    expect(packedOneMem.manifest.memories).toHaveLength(1);
    expect(packedOneMem.manifest.memories[0]?.subject).toBe("汇报风格");

    // 导入预览：默认不选中记忆、标注缺失依赖（notion-mcp 缺失、github-mcp 已装）、剥离技能触发器
    const preview = await h.service.previewImport(alice, packedOneMem.bytes);
    expect(preview.selectedMemoryIndices).toEqual([]);
    expect(preview.candidateMemories).toHaveLength(1);
    expect(preview.schedulesPaused).toBe(true);
    expect(
      preview.dependencies.find((d) => d.pluginId === "github-mcp")?.installed,
    ).toBe(true);
    expect(
      preview.dependencies.find((d) => d.pluginId === "notion-mcp")?.installed,
    ).toBe(false);
    const researchSkill = preview.skills.find(
      (s) => s.slug === "research-pack",
    );
    expect(researchSkill?.strippedFrontmatterKeys).toEqual([
      "trigger",
      "bypass_approval",
    ]);
    expect(researchSkill?.files?.[0]?.path).toBe("templates/report.md");

    // 导入不勾选记忆 -> 零记忆入库，定时任务全部暂停
    const committed = await h.service.commitImport(alice, {
      zipBytes: packedOneMem.bytes,
      importId: preview.suggestedImportId,
      packageDigest: preview.packageDigest,
    });
    expect(committed.memoriesImportedCount).toBe(0);
    expect(h.createdMemories).toHaveLength(0);
    expect(h.createdSchedules).toHaveLength(2);
    expect(h.createdSchedules.every((s) => s.schedule.enabled === false)).toBe(
      true,
    );
  });

  test("resumes from checkpoint after mid-import failure without duplicating bot, skills, schedules, or memories", async () => {
    const h = createHarness({ failOnScheduleIndex: 1 });
    const packed = await h.service.exportZip(alice, {
      botId: "bot-src",
      selectedMemoryIndices: [0],
    });
    const preview = await h.service.previewImport(alice, packed.bytes);

    // 首次提交：Bot、2 个技能、第 1 个定时任务成功后，第 2 个定时任务人为抛错
    await expect(
      h.service.commitImport(alice, {
        zipBytes: packed.bytes,
        importId: preview.suggestedImportId,
        packageDigest: preview.packageDigest,
        selectedMemoryIndices: [0],
      }),
    ).rejects.toThrow("模拟定时任务落库超时");

    expect(h.createdBots).toHaveLength(1);
    expect(h.installedSkills).toHaveLength(2);
    expect(h.createdSchedules).toHaveLength(1);
    expect(h.createdMemories).toHaveLength(0);

    // 使用同一 importId 断点续导：不得重复创建 Bot / 技能 / 第 1 个定时任务，仅补齐第 2 个定时任务和勾选的记忆
    const resumed = await h.service.commitImport(alice, {
      zipBytes: packed.bytes,
      importId: preview.suggestedImportId,
      packageDigest: preview.packageDigest,
      selectedMemoryIndices: [0],
    });
    expect(resumed.reused).toBe(true);
    expect(resumed.checkpoint.status).toBe("completed");
    expect(h.createdBots).toHaveLength(1);
    expect(h.installedSkills).toHaveLength(2);
    expect(h.createdSchedules).toHaveLength(2);
    expect(h.createdMemories).toHaveLength(1);

    // 已完成后再次用同一 importId 幂等重放：完全无副作用
    const replay = await h.service.commitImport(alice, {
      zipBytes: packed.bytes,
      importId: preview.suggestedImportId,
      packageDigest: preview.packageDigest,
      selectedMemoryIndices: [0],
    });
    expect(replay.reused).toBe(true);
    expect(h.createdBots).toHaveLength(1);
    expect(h.installedSkills).toHaveLength(2);
    expect(h.createdSchedules).toHaveLength(2);
    expect(h.createdMemories).toHaveLength(1);

    // 同一 importId 换用不同配方包 -> 409 冲突
    const otherPacked = await h.service.exportZip(alice, {
      botId: "bot-src",
      selectedSkillSlugs: ["weekly-digest"],
    });
    await expect(
      h.service.commitImport(alice, {
        zipBytes: otherPacked.bytes,
        importId: preview.suggestedImportId,
      }),
    ).rejects.toThrow("绑定另一份配方包");
  });

  test("HTTP routes /api/sharing/* and export_bot_template tool work end-to-end", async () => {
    const h = createHarness();
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
    const app = createSharingRoutes(h.service, requireUser);

    // 1. POST /export/draft
    const draftRes = await app.request("/export/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-src" }),
    });
    expect(draftRes.status).toBe(200);
    const draftBody = (await draftRes.json()) as {
      draft: { selectedMemoryIndices: number[] };
    };
    expect(draftBody.draft.selectedMemoryIndices).toEqual([]);

    // 2. POST /export/zip
    const zipRes = await app.request("/export/zip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "bot-src", selectedMemoryIndices: [0] }),
    });
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("content-type")).toBe("application/zip");
    const zipBytes = Buffer.from(await zipRes.arrayBuffer());

    // 3. POST /import/preview (JSON base64)
    const previewRes = await app.request("/import/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ zipBase64: zipBytes.toString("base64") }),
    });
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as {
      preview: {
        suggestedImportId: string;
        packageDigest: string;
        selectedMemoryIndices: number[];
      };
    };
    expect(previewBody.preview.selectedMemoryIndices).toEqual([]);

    // 4. POST /import/commit
    const commitRes = await app.request("/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        zipBase64: zipBytes.toString("base64"),
        importId: previewBody.preview.suggestedImportId,
        packageDigest: previewBody.preview.packageDigest,
        selectedMemoryIndices: [0],
      }),
    });
    expect(commitRes.status).toBe(200);
    const commitBody = (await commitRes.json()) as {
      result: { memoriesImportedCount: number; schedulesPaused: boolean };
    };
    expect(commitBody.result.memoriesImportedCount).toBe(1);
    expect(commitBody.result.schedulesPaused).toBe(true);

    // 5. export_bot_template 对话工具
    const tool = h.service
      .tools("u-alice", "bot-src")
      .find((t) => t.name === "export_bot_template");
    expect(tool).toBeDefined();
    const toolOutput = await tool?.execute({});
    expect(toolOutput).toContain("产品助理");
    expect(toolOutput).toContain("已选中 0 条");
    expect(toolOutput).toContain("/settings/share");
  });
});
