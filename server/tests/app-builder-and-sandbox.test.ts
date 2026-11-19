import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { CHISABOT_APP_FORMAT } from "../../shared/app-packages";
import type { AppVariables } from "../src/auth/guards";
import {
  createAppBuilderRoutes,
  createAppBuilderTools,
  resolveActiveAppSkills,
} from "../src/plugins/app-builder";
import {
  AppPackageError,
  createAppPackageStore,
  createMemoryAppPackageStorage,
  validateChisaAppPackage,
} from "../src/plugins/app-package";
import {
  buildSandboxedAppEnv,
  createAppSandboxRunner,
} from "../src/plugins/app-sandbox-runner";
import { extractValidatedMcpImages } from "../src/plugins/mcp-enhancements";

const TEST_KEY = randomBytes(32).toString("base64");

/** 零外部依赖的极简合规 node-stdio MCP 服务端脚本（便于沙箱隔离与 OAuth 重启实测）。 */
const SANDBOX_PROBE_ENTRY_JS = `import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'sandbox-probe', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'inspect_env',
            description: 'Return sandbox process diagnostics',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const authHeaders = JSON.parse(process.env.CHISABOT_APP_AUTH_HEADERS || '{}');
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              pid: process.pid,
              prefix: process.env.APP_PREFIX ?? null,
              hasCanary: Boolean(process.env.HOST_CANARY_SECRET),
              hasHome: Boolean(process.env.HOME || process.env.USERPROFILE),
              hasClientSecretEnv: Boolean(process.env.OAUTH_CLIENT_SECRET),
              nodeOptions: process.env.NODE_OPTIONS ?? null,
              tmpdir: process.env.TMPDIR ?? null,
              authorization: authHeaders.Authorization ?? null,
            }),
          },
        ],
      },
    });
  }
});
`;

function makeSampleAppPackage(overrides?: Record<string, unknown>) {
  return {
    format: CHISABOT_APP_FORMAT,
    id: "sandbox-probe",
    version: "1.0.0",
    name: { en: "Sandbox Probe", "zh-CN": "沙箱探针微应用" },
    description: {
      en: "Inspect sandbox environment safely.",
      "zh-CN": "检查沙箱环境与托管 OAuth 注入。",
    },
    runtime: {
      kind: "node-stdio",
      entry: "index.mjs",
      memoryLimitMb: 64,
      timeoutMs: 10_000,
    },
    permissions: {
      network: ["https://api.example.com"],
      workspace: "none",
    },
    configSchema: [
      {
        key: "APP_PREFIX",
        name: "前缀",
        secret: false,
        required: false,
        defaultValue: "hello",
      },
      {
        key: "API_SECRET",
        name: "应用密文",
        secret: true,
        required: false,
      },
    ],
    oauth: {
      type: "oauth2",
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      scopes: ["read:data"],
      clientId: "demo-client-id",
    },
    skills: [
      {
        id: "use-probe",
        path: "skills/SKILL.md",
        name: "使用探针",
        description: "需要 inspect_env 工具时才激活",
        requiresTools: ["inspect_env"],
      },
    ],
    files: [
      {
        path: "index.mjs",
        encoding: "utf8",
        content: SANDBOX_PROBE_ENTRY_JS,
      },
      {
        path: "skills/SKILL.md",
        encoding: "utf8",
        content: "# Sandbox Probe Skill\nCall inspect_env when requested.\n",
      },
    ],
    ...overrides,
  };
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      await rm(target, { recursive: true, force: true }).catch(() => {});
    }
  }
});

describe("Wave 8 app-builder、包安全校验、digest 锚定与沙箱隔离", () => {
  test("3 个内置 app-builder 工具：指南、静态预检（拒路径穿越/超大/密文）与只入目录草稿不执行", async () => {
    const store = createAppPackageStore({
      storage: createMemoryAppPackageStorage(),
      encryptionKey: TEST_KEY,
    });
    const tools = createAppBuilderTools({ store, actorId: "user-1" });
    expect(tools.map((t) => t.name)).toEqual([
      "application_development_guide",
      "validate_application",
      "submit_application",
    ]);

    const guide = tools[0];
    const validate = tools[1];
    const submit = tools[2];
    if (!guide || !validate || !submit) throw new Error("missing tools");

    const guideText = await guide.execute({});
    expect(guideText).toContain(CHISABOT_APP_FORMAT);
    expect(guideText).toContain("CHISABOT_APP_AUTH_HEADERS");
    expect(guideText).toContain("submit_application");

    // 1. 静态预检拦截路径穿越、绝对路径、保留 env、内嵌密钥与超大包
    const traversalRes = JSON.parse(
      await validate.execute({
        package: makeSampleAppPackage({
          files: [
            { path: "../escape.mjs", encoding: "utf8", content: "console.log(1)" },
            { path: "index.mjs", encoding: "utf8", content: SANDBOX_PROBE_ENTRY_JS },
            { path: "skills/SKILL.md", encoding: "utf8", content: "# ok" },
          ],
        }),
      }),
    ) as { valid: boolean; errors: Array<{ code: string }> };
    expect(traversalRes.valid).toBe(false);
    expect(traversalRes.errors.some((e) => e.code === "unsafe_path")).toBe(true);

    const reservedKeyRes = validateChisaAppPackage(
      makeSampleAppPackage({
        configSchema: [
          { key: "NODE_OPTIONS", name: "evil", secret: false, required: false },
        ],
      }),
    );
    expect(reservedKeyRes.valid).toBe(false);
    expect(
      reservedKeyRes.errors.some((e) => e.code === "reserved_config_key"),
    ).toBe(true);

    const secretInPkgRes = validateChisaAppPackage(
      makeSampleAppPackage({
        oauth: {
          type: "oauth2",
          authorizationUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          scopes: ["read"],
          clientSecret: "leaked-client-secret",
        },
      }),
    );
    expect(secretInPkgRes.valid).toBe(false);
    expect(
      secretInPkgRes.errors.some((e) => e.code === "oauth_secret_in_package"),
    ).toBe(true);

    const oversizedRes = validateChisaAppPackage(
      makeSampleAppPackage({
        files: [
          { path: "index.mjs", encoding: "utf8", content: SANDBOX_PROBE_ENTRY_JS },
          { path: "skills/SKILL.md", encoding: "utf8", content: "# ok" },
          {
            path: "blob1.txt",
            encoding: "utf8",
            content: "a".repeat(950 * 1024),
          },
          {
            path: "blob2.txt",
            encoding: "utf8",
            content: "b".repeat(950 * 1024),
          },
          {
            path: "blob3.txt",
            encoding: "utf8",
            content: "c".repeat(300 * 1024),
          },
        ],
      }),
    );
    expect(oversizedRes.valid).toBe(false);
    expect(
      oversizedRes.errors.some((e) => e.code === "package_too_large"),
    ).toBe(true);

    // 2. submit_application 永远落为 draft（installed: false, executed: false）且绝不执行
    const submitOutput = await submit.execute({
      package: makeSampleAppPackage(),
    });
    expect(submitOutput).toContain('"submitted":true');
    expect(submitOutput).toContain('"status":"draft"');
    expect(submitOutput).toContain('"installed":false');
    expect(submitOutput).toContain('"executed":false');
    expect(submitOutput).toContain("/admin/plugins#app-packages");

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("draft");
    expect(listed[0]?.installed).toBe(false);
    expect(listed[0]?.approvedDigest).toBeNull();
    expect(listed[0]?.needsReview).toBe(true);

    // 草稿状态下调用 getRuntimeSnapshot / 沙箱运行器必须硬拒绝
    await expect(store.getRuntimeSnapshot("sandbox-probe")).rejects.toThrow(
      AppPackageError,
    );
  });

  test("digest 锚定、升级必须重审、不可变版本回滚与脱敏导出不含任何凭据", async () => {
    const store = createAppPackageStore({
      storage: createMemoryAppPackageStorage(),
      encryptionKey: TEST_KEY,
    });

    const v1 = await store.submitDraft(makeSampleAppPackage(), "alice");
    const v1Digest = v1.summary.currentDigest;

    // 错摘要批准必须 409 拒绝（防 TOCTOU）
    await expect(
      store.installAndApprove("sandbox-probe", "0".repeat(64), "admin"),
    ).rejects.toMatchObject({ status: 409, code: "digest_mismatch" });

    // 正确摘要批准生效
    const approvedV1 = await store.installAndApprove(
      "sandbox-probe",
      v1Digest,
      "admin",
    );
    expect(approvedV1.installed).toBe(true);
    expect(approvedV1.enabled).toBe(true);
    expect(approvedV1.approvedDigest).toBe(v1Digest);
    expect(approvedV1.needsReview).toBe(false);

    // 写入配置密钥与 Host 托管 OAuth 令牌
    await store.configure(
      "sandbox-probe",
      {
        APP_PREFIX: "prod-prefix",
        API_SECRET: "super-secret-value-999",
        OAUTH_CLIENT_SECRET: "oauth-client-secret-888",
      },
      "admin",
    );
    await store.setOAuthTokens(
      "sandbox-probe",
      {
        accessToken: "live-access-token-777",
        refreshToken: "live-refresh-token-666",
      },
      "admin",
    );

    // 脱敏导出绝不包含任何配置值、密钥或 OAuth 令牌
    const exported = await store.exportPackage("sandbox-probe");
    const exportedStr = JSON.stringify(exported);
    expect(exportedStr).not.toContain("super-secret-value-999");
    expect(exportedStr).not.toContain("oauth-client-secret-888");
    expect(exportedStr).not.toContain("live-access-token-777");
    expect(exportedStr).not.toContain("live-refresh-token-666");
    expect(exportedStr).not.toContain("prod-prefix");
    expect(exported.packageDigest).toBe(v1Digest);

    // 同版本号提交不同内容必须被不可变版本栈拒绝
    await expect(
      store.submitDraft(
        makeSampleAppPackage({
          files: [
            {
              path: "index.mjs",
              encoding: "utf8",
              content: `${SANDBOX_PROBE_ENTRY_JS}\n// mutated`,
            },
            { path: "skills/SKILL.md", encoding: "utf8", content: "# v1 mod" },
          ],
        }),
        "alice",
      ),
    ).rejects.toMatchObject({ status: 409, code: "immutable_version_conflict" });

    // 提交 v2 新版：绝不静默执行！旧 grant 仍锚定在 v1Digest，v2 处于待重审停用态
    const v2 = await store.submitDraft(
      makeSampleAppPackage({
        version: "1.1.0",
        files: [
          {
            path: "index.mjs",
            encoding: "utf8",
            content: `${SANDBOX_PROBE_ENTRY_JS}\n// v1.1.0`,
          },
          { path: "skills/SKILL.md", encoding: "utf8", content: "# v1.1.0" },
        ],
      }),
      "alice",
    );
    const v2Digest = v2.summary.currentDigest;
    expect(v2Digest).not.toBe(v1Digest);
    expect(v2.summary.approvedDigest).toBe(v1Digest);
    expect(v2.summary.needsReview).toBe(true);
    expect(v2.summary.enabled).toBe(false);
    await expect(store.getRuntimeSnapshot("sandbox-probe")).rejects.toThrow(
      AppPackageError,
    );

    // 显式批准 v2
    const approvedV2 = await store.installAndApprove(
      "sandbox-probe",
      v2Digest,
      "admin",
    );
    expect(approvedV2.approvedDigest).toBe(v2Digest);
    expect(approvedV2.enabled).toBe(true);

    // requiresTools 技能联动校验
    expect(
      resolveActiveAppSkills([approvedV2], new Set(["other_tool"])),
    ).toHaveLength(0);
    expect(
      resolveActiveAppSkills([approvedV2], new Set(["inspect_env"])),
    ).toHaveLength(1);

    // 回滚到 v1 不可变历史版本
    const rolledBack = await store.rollback("sandbox-probe", v1Digest, "admin", {
      approve: true,
    });
    expect(rolledBack.version).toBe("1.0.0");
    expect(rolledBack.currentDigest).toBe(v1Digest);
    expect(rolledBack.approvedDigest).toBe(v1Digest);
    expect(rolledBack.revisions).toHaveLength(2);
  });

  test("严格 node-stdio 沙箱运行态：最小 env 白名单 + OAuth 刷新自动优雅重启子进程 + 退出零泄漏", async () => {
    const tempParent = await mkdtemp(join(tmpdir(), "chisabot-wave8-test-"));
    cleanupPaths.push(tempParent);

    let nowMs = Date.parse("2026-11-19T12:00:00Z");
    let refreshCalls = 0;

    const store = createAppPackageStore({
      storage: createMemoryAppPackageStorage(),
      encryptionKey: TEST_KEY,
      now: () => nowMs,
      refreshFetch: async () => {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: `refreshed-token-${refreshCalls}`,
            refresh_token: "refresh-token-next",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const submitted = await store.submitDraft(makeSampleAppPackage(), "dev");
    await store.installAndApprove(
      "sandbox-probe",
      submitted.summary.currentDigest,
      "admin",
    );
    await store.configure(
      "sandbox-probe",
      {
        APP_PREFIX: "custom-prefix",
        API_SECRET: "must-not-enter-plain-env",
        OAUTH_CLIENT_ID: "demo-client-id",
        OAUTH_CLIENT_SECRET: "host-only-client-secret",
      },
      "admin",
    );
    await store.setOAuthTokens(
      "sandbox-probe",
      {
        accessToken: "initial-token-v1",
        refreshToken: "refresh-token-v1",
        expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
      },
      "admin",
    );

    // 验证纯函数 env 构建严格清空非白名单宿主密钥
    const builtEnv = buildSandboxedAppEnv({
      pkg: (await store.get("sandbox-probe")).package,
      nonSecretConfig: {
        APP_PREFIX: "custom-prefix",
        API_SECRET: "should-be-dropped-because-secret",
      },
      authHeaders: { Authorization: "Bearer initial-token-v1" },
      isolatedTmpDir: join(tempParent, "iso-tmp"),
      hostBaseEnv: {
        PATH: "/usr/bin",
        HOST_CANARY_SECRET: "super-host-secret",
        DATABASE_URL: "postgres://leak",
        HOME: "/root",
      },
    });
    expect(builtEnv.PATH).toBe("/usr/bin");
    expect(builtEnv.HOST_CANARY_SECRET).toBeUndefined();
    expect(builtEnv.DATABASE_URL).toBeUndefined();
    expect(builtEnv.HOME).toBeUndefined();
    expect(builtEnv.API_SECRET).toBeUndefined();
    expect(builtEnv.APP_PREFIX).toBe("custom-prefix");
    expect(builtEnv.NODE_OPTIONS).toBe("--max-old-space-size=64");
    expect(builtEnv.CHISABOT_APP_AUTH_HEADERS).toContain("initial-token-v1");

    const runner = createAppSandboxRunner({
      store,
      tempRootDir: tempParent,
      extractImages: (content) => extractValidatedMcpImages(content).images,
    });

    try {
      const tools = await runner.listTools("sandbox-probe");
      expect(tools.map((t) => t.name)).toEqual(["inspect_env"]);

      const call1 = await runner.callTool("sandbox-probe", "inspect_env", {});
      expect(call1.isError).toBe(false);
      const diag1 = JSON.parse(call1.text) as {
        pid: number;
        prefix: string;
        hasCanary: boolean;
        hasHome: boolean;
        hasClientSecretEnv: boolean;
        nodeOptions: string;
        tmpdir: string;
        authorization: string;
      };
      const sessionBefore = runner.getDiagnostics("sandbox-probe");
      expect(sessionBefore).not.toBeNull();
      const firstRoot = sessionBefore?.sessionRoot ?? "";
      expect(existsSync(firstRoot)).toBe(true);

      expect(diag1.prefix).toBe("custom-prefix");
      expect(diag1.hasCanary).toBe(false);
      expect(diag1.hasHome).toBe(false);
      expect(diag1.hasClientSecretEnv).toBe(false);
      expect(diag1.nodeOptions).toBe("--max-old-space-size=64");
      expect(diag1.tmpdir).toContain("chisabot-app-sandbox-probe");
      expect(diag1.authorization).toBe("Bearer initial-token-v1");

      // 推进时钟触发 OAuth2 token 自动刷新，验证子进程自动优雅重启并收到新令牌
      nowMs += 11 * 60_000;
      const call2 = await runner.callTool("sandbox-probe", "inspect_env", {});
      expect(call2.isError).toBe(false);
      expect(refreshCalls).toBe(1);
      const diag2 = JSON.parse(call2.text) as typeof diag1;
      expect(diag2.authorization).toBe("Bearer refreshed-token-1");
      expect(diag2.pid).not.toBe(diag1.pid);
      expect(runner.getRestartCount("sandbox-probe")).toBe(1);
      // 旧会话临时目录已被回收
      expect(existsSync(firstRoot)).toBe(false);

      const secondRoot = runner.getDiagnostics("sandbox-probe")?.sessionRoot ?? "";
      expect(existsSync(secondRoot)).toBe(true);

      await runner.shutdown();
      // 退出后全部临时目录归零，无泄漏
      expect(existsSync(secondRoot)).toBe(false);
      expect(runner.getDiagnostics("sandbox-probe")).toBeNull();
    } finally {
      await runner.shutdown();
    }
  });

  test("/api/apps/* 路由权限校验、no-store、摘要安装与脱敏导出", async () => {
    const store = createAppPackageStore({
      storage: createMemoryAppPackageStorage(),
      encryptionKey: TEST_KEY,
    });
    const runner = createAppSandboxRunner({ store });
    let actorRole: "admin" | "user" = "admin";
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", {
        id: "u-1",
        email: "admin@example.com",
        role: actorRole,
        name: "Admin",
      });
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/apps",
      createAppBuilderRoutes({
        store,
        runner,
        requireUser,
        encryptionKey: TEST_KEY,
        publicUrl: "https://chisa.example.com",
      }),
    );

    // 普通用户不可导入
    actorRole = "user";
    const memberImport = await app.request("/api/apps/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: makeSampleAppPackage() }),
    });
    expect(memberImport.status).toBe(403);

    // 管理员导入落草稿
    actorRole = "admin";
    const imported = await app.request("/api/apps/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: makeSampleAppPackage() }),
    });
    expect(imported.status).toBe(201);
    expect(imported.headers.get("cache-control")).toBe("no-store");
    const importedJson = (await imported.json()) as {
      app: { id: string; status: string; currentDigest: string };
    };
    expect(importedJson.app.status).toBe("draft");

    // 详情返回源码预览
    const detailRes = await app.request("/api/apps/sandbox-probe");
    expect(detailRes.status).toBe(200);
    const detailJson = (await detailRes.json()) as {
      app: { files: Array<{ path: string; preview: string | null }> };
    };
    expect(
      detailJson.app.files.some(
        (f) => f.path === "index.mjs" && f.preview?.includes("inspect_env"),
      ),
    ).toBe(true);

    // 安装需传精确 expectedDigest
    const installRes = await app.request("/api/apps/sandbox-probe/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedDigest: importedJson.app.currentDigest,
        probe: false,
      }),
    });
    expect(installRes.status).toBe(200);

    // 配置密钥后导出仍不含密钥
    await app.request("/api/apps/sandbox-probe/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        values: { API_SECRET: "route-secret-123" },
      }),
    });
    const exportRes = await app.request("/api/apps/sandbox-probe/export");
    expect(exportRes.status).toBe(200);
    expect(await exportRes.text()).not.toContain("route-secret-123");

    await runner.shutdown();
  });
});
