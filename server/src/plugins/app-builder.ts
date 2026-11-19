/**
 * 内置 `app-builder` AI 工具集与 `/api/apps/*` 管理/用户 API 路由（Wave 8）：
 *
 * 1. `application_development_guide`：返回 `chisabot-app/v1` 开发规范、沙箱边界、Host 托管 OAuth 与提交审批流程；
 * 2. `validate_application`：纯静态结构与安全预检，不落库、不安装、不执行；
 * 3. `submit_application`：**只入目录不执行**，永远落为 `status: "draft"`（`installed: false`），
 *    返回草稿预览链接与 SHA-256 `packageDigest` 供用户在界面审阅源码与权限后再显式点击安装授权；
 * 4. `/api/apps/*` 路由：列表、源码审阅详情、摘要锚定安装启用/停用、AES-256-GCM 配置与 OAuth 绑定、
 *    不可变版本历史与一键回滚、脱敏单 JSON 导入/导出。
 */

import { createHash, randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  type AppPackageSummary,
  CHISABOT_APP_FORMAT,
  MAX_APP_PACKAGE_BYTES,
} from "../../../shared/app-packages";
import { guardedFetchResponse } from "../../../shared/net/guarded-fetch";
import { checkPublicUrl } from "../../../shared/net/ssrf";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import { seal, unseal } from "../auth/signed-value";
import { currentToolAbort, TOOL_STOPPED_ZH } from "../confirmations/context";
import { emitToolImage } from "../conversations/tool-images";
import {
  AppPackageError,
  type AppPackageStore,
  validateChisaAppPackage,
} from "./app-package";
import type { AppSandboxRunner } from "./app-sandbox-runner";
import { formatMcpCallFailure } from "./mcp-enhancements";
import {
  type GrantedTool,
  parametersFor,
  REFUSAL_MARKER,
  vendorAnswer,
} from "./tools";

export const APP_BUILDER_ID = "app-builder";
const APP_OAUTH_STATE_LABEL = "chisabot-app-oauth";
const APP_OAUTH_STATE_TTL_MS = 10 * 60_000;
const APP_OAUTH_CALLBACK_PATH = "/api/apps/oauth/callback";

export const APP_DEVELOPMENT_GUIDE_MD = `# ChisaBot 微应用 / MCP 插件包开发指南（${CHISABOT_APP_FORMAT}）

你可以替用户在对话中编写自包含、可审阅、可分享的后端 MCP 微应用或纯技能包，并通过单 JSON 格式提交至 ChisaBot 应用目录。

## 核心安全与审批工作流
1. **先读规范再编码**：确认用户所需操作、最小网络权限与外部认证范围。
2. **先静态校验**：编写完单 JSON 应用包后，先调用 \`validate_application\` 进行结构、路径、大小（上限 2 MiB）、内嵌密钥与权限声明检查。
3. **只入目录不擅自执行**：调用 \`submit_application\` 提交草稿。提交**绝不执行任何代码**，应用将落为 \`status: "draft"\`（\`installed: false\`），并生成不可变 SHA-256 \`packageDigest\`。
4. **用户显式审阅授权**：将草稿预览入口与 \`packageDigest\` 告知用户，用户在「设置 → 插件与 MCP → AI 自研微应用」核对源码、网络白名单与摘要后点击安装授权才生效。升级新版本会生成新的 \`packageDigest\`，同样必须经用户重新审阅后才可运行。
5. **脱敏导入/导出**：导出单 JSON 包时系统会自动剥离全部用户配置值、密钥与 OAuth 令牌，严禁把真实密钥写进源码或 \`configSchema[].defaultValue\`。

## 单 JSON 包结构（\`format: "${CHISABOT_APP_FORMAT}"\`）
- \`format\`: 固定为 \`"${CHISABOT_APP_FORMAT}"\`
- \`id\`: 小写字母开头的 2–48 位 slug（如 \`my-weather-mcp\`）
- \`version\`: 语义化版本（如 \`"1.0.0"\`，不可变版本栈禁止覆盖已有版本号的不同内容）
- \`name\` / \`description\`: 字符串或 \`{ "en": "...", "zh-CN": "..." }\`
- \`runtime\`:
  - \`{ "kind": "node-stdio", "entry": "index.mjs", "memoryLimitMb": 128, "timeoutMs": 30000 }\`
  - \`{ "kind": "remote-mcp", "url": "https://example.com/mcp", "transport": "streamable-http" | "sse" }\`
  - \`{ "kind": "skills-only" }\`
- \`files\`: \`[{ "path": "index.mjs", "encoding": "utf8" | "base64", "content": "..." }]\`（仅允许安全相对 POSIX 路径，禁 \`..\` / 绝对路径 / \`.env\` / 密钥文件，总大小 ≤ 2 MiB）
- \`configSchema\`: \`[{ "key": "API_BASE", "name": "接口地址", "secret": false, "required": false }]\`（禁止占用 \`NODE_*\` / \`LD_*\` / \`PATH\` / \`CHISABOT_*\` 等宿主保留环境变量；\`secret: true\` 禁止填 \`defaultValue\`）
- \`oauth\`（可选，Host 托管认证，严禁包含 \`clientSecret\` 或令牌）:
  - OAuth2: \`{ "type": "oauth2", "authorizationUrl": "https://...", "tokenUrl": "https://...", "scopes": ["..."] }\`
  - Bearer / API Key: \`{ "type": "bearer" }\` 或 \`{ "type": "api-key", "headerName": "X-Api-Key" }\`
- \`permissions\`: \`{ "network": ["https://api.example.com"], "workspace": "none" }\`
- \`skills\`（可选）: \`[{ "id": "use-app", "path": "skills/SKILL.md", "name": "...", "description": "...", "requiresTools": ["echo"] }]\`（仅当所需工具全部可用时才激活技能）

## 严格沙箱运行态约定（\`node-stdio\`）
- 子进程在清空后的最小白名单环境中启动（仅含 \`PATH\`、隔离 \`TMPDIR\`、受限 \`NODE_OPTIONS=--max-old-space-size=...\` 与本应用声明的非密配置）。
- Host 托管的 OAuth / Bearer / API Key 请求头通过受限环境变量 \`CHISABOT_APP_AUTH_HEADERS\`（JSON 对象）注入；令牌刷新时 Host 自动优雅重启子进程。切勿在工具结果或日志中回显认证头！
- \`stdout\` 严格保留给 MCP JSON-RPC 帧（换行分隔），调试日志请写往 \`stderr\`。

## 最小可执行示例
\`\`\`json
{
  "format": "chisabot-app/v1",
  "id": "demo-echo",
  "version": "1.0.0",
  "name": { "en": "Demo Echo", "zh-CN": "回声微应用" },
  "description": { "en": "Echo input text safely.", "zh-CN": "安全回显输入文本的示例微应用。" },
  "runtime": { "kind": "node-stdio", "entry": "index.mjs", "memoryLimitMb": 64, "timeoutMs": 10000 },
  "permissions": { "network": [], "workspace": "none" },
  "configSchema": [
    { "key": "PREFIX", "name": { "en": "Prefix", "zh-CN": "前缀" }, "secret": false, "required": false, "defaultValue": "echo:" }
  ],
  "files": [
    {
      "path": "index.mjs",
      "encoding": "utf8",
      "content": "import readline from 'node:readline';\\nconst rl = readline.createInterface({ input: process.stdin });\\nconst send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\\\n');\\nrl.on('line', (line) => {\\n  if (!line.trim()) return;\\n  const msg = JSON.parse(line);\\n  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'demo-echo', version: '1.0.0' } } });\\n  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Return text with prefix', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });\\n  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: (process.env.PREFIX || '') + ' ' + String(msg.params?.arguments?.text ?? '') }] } });\\n});\\n"
    }
  ]
}
\`\`\`
`;

function parsePackageInput(raw: unknown): {
  ok: true;
  value: unknown;
} | {
  ok: false;
  error: string;
} {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: "package JSON 字符串不能为空。" };
    if (trimmed.length > MAX_APP_PACKAGE_BYTES * 2) {
      return { ok: false, error: "package JSON 字符串超过安全大小上限。" };
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch (error) {
      return {
        ok: false,
        error: `package JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, value: raw };
  }
  return { ok: false, error: "请提供有效的 package JSON 对象或 JSON 字符串。" };
}

const emptyGuideInput = z.object({});
const packageArgInput = z.object({
  package: z
    .union([z.record(z.string(), z.unknown()), z.string()])
    .describe("chisabot-app/v1 单 JSON 应用包对象或 JSON 字符串"),
});

/**
 * 创建内置 `app-builder` 3 个 AI 对话工具：
 * - `application_development_guide`
 * - `validate_application`
 * - `submit_application`（只入目录草稿不执行）
 */
export function createAppBuilderTools(options: {
  store: AppPackageStore;
  actorId: string;
  /** 是否为管理员；普通用户禁止覆盖他人应用或已批准安装的线上微应用。 */
  isAdmin?: boolean | (() => boolean | Promise<boolean>);
}): GrantedTool[] {
  const { store, actorId } = options;

  const guideTool: GrantedTool = {
    name: "application_development_guide",
    ref: `${APP_BUILDER_ID}/application_development_guide`,
    effect: "read",
    description:
      "读取 ChisaBot AI 微应用 / MCP 插件包（chisabot-app/v1）的开发规范、沙箱环境变量白名单、Host 托管 OAuth 注入与草稿审阅提交流程。在替用户编写自定义后端微应用之前必须先调用此工具。",
    parameters: emptyGuideInput,
    execute: async () => APP_DEVELOPMENT_GUIDE_MD,
  };

  const validateTool: GrantedTool = {
    name: "validate_application",
    ref: `${APP_BUILDER_ID}/validate_application`,
    effect: "read",
    description:
      "对 chisabot-app/v1 单 JSON 微应用包执行纯静态结构与安全预检（路径穿越、2 MiB 上限、内嵌密钥检测、OAuth/网络权限校验、SHA-256 摘要计算）。不会落库、不会安装，也不会执行任何代码。",
    parameters: packageArgInput,
    execute: async (rawArgs) => {
      const parsedArgs = packageArgInput.safeParse(rawArgs);
      if (!parsedArgs.success) {
        return JSON.stringify({
          valid: false,
          errors: [
            {
              path: "package",
              code: "invalid_arguments",
              message: parsedArgs.error.issues[0]?.message ?? "参数无效。",
              severity: "error",
            },
          ],
        });
      }
      const decoded = parsePackageInput(parsedArgs.data.package);
      if (!decoded.ok) {
        return JSON.stringify({
          valid: false,
          errors: [
            {
              path: "package",
              code: "invalid_json",
              message: decoded.error,
              severity: "error",
            },
          ],
        });
      }
      const result = validateChisaAppPackage(decoded.value);
      return JSON.stringify({
        valid: result.valid,
        id: result.normalized?.id ?? null,
        version: result.normalized?.version ?? null,
        runtime: result.normalized?.runtime.kind ?? null,
        digest: result.digest ?? null,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
        errors: result.errors,
        warnings: result.warnings,
      });
    },
  };

  const submitTool: GrantedTool = {
    name: "submit_application",
    ref: `${APP_BUILDER_ID}/submit_application`,
    effect: "write",
    description:
      "将校验通过的 chisabot-app/v1 微应用包提交到应用目录草稿区（status: draft, installed: false）。绝不自动安装或执行任何应用代码；返回草稿预览链接与 SHA-256 摘要，由用户在管理界面审阅源码和权限声明后手动点击安装授权。",
    parameters: packageArgInput,
    execute: async (rawArgs) => {
      const parsedArgs = packageArgInput.safeParse(rawArgs);
      if (!parsedArgs.success) {
        return `${REFUSAL_MARKER} 参数无效：${parsedArgs.error.issues[0]?.message ?? ""}`;
      }
      const decoded = parsePackageInput(parsedArgs.data.package);
      if (!decoded.ok) {
        return `${REFUSAL_MARKER} ${decoded.error}`;
      }
      const check = validateChisaAppPackage(decoded.value);
      if (!check.valid || !check.normalized) {
        return JSON.stringify({
          submitted: false,
          executed: false,
          errors: check.errors,
          warnings: check.warnings,
        });
      }
      try {
        const isAdmin =
          typeof options.isAdmin === "function"
            ? await options.isAdmin()
            : options.isAdmin === true;
        const { summary, isUpdate } = await store.submitDraft(
          check.normalized,
          actorId,
          { isAdmin },
        );
        return [
          JSON.stringify({
            submitted: true,
            isUpdate,
            id: summary.id,
            version: summary.version,
            status: summary.status,
            installed: summary.installed,
            enabled: summary.enabled,
            needsReview: summary.needsReview,
            executed: false,
            digest: summary.currentDigest,
            runtime: summary.runtime.kind,
            reviewUrl: "/admin/plugins#app-packages",
          }),
          "",
          `应用草稿「${summary.name["zh-CN"]}」（${summary.id}@${summary.version}，SHA-256: \`${summary.currentDigest.slice(0, 16)}…\`）已提交至目录，尚未安装或执行。请引导用户点开下方链接预览源码与权限声明后再安装授权：`,
          "[审阅并安装 AI 微应用](/admin/plugins#app-packages)",
        ].join("\n");
      } catch (error) {
        return `${REFUSAL_MARKER} ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };

  return [guideTool, validateTool, submitTool];
}

/** 按当前可用工具集过滤已启用微应用的捆绑技能（强校验 `requiresTools` 联动）。 */
export function resolveActiveAppSkills(
  apps: readonly AppPackageSummary[],
  availableToolNames: ReadonlySet<string>,
): Array<{
  appId: string;
  skillId: string;
  path: string;
  name: string;
  description: string;
  requiresTools: string[];
}> {
  const active: Array<{
    appId: string;
    skillId: string;
    path: string;
    name: string;
    description: string;
    requiresTools: string[];
  }> = [];
  for (const app of apps) {
    if (!app.installed || !app.enabled || app.needsReview) continue;
    const safeApp = app.id.replace(/[^a-z0-9_]/gi, "_");
    for (const skill of app.skills) {
      const satisfied = skill.requiresTools.every((toolName) => {
        const safeTool = toolName.replace(/[^a-z0-9_]/gi, "_");
        return (
          availableToolNames.has(toolName) ||
          availableToolNames.has(`app__${safeApp}__${safeTool}`) ||
          availableToolNames.has(`app__${app.id}__${toolName}`) ||
          availableToolNames.has(`app:${app.id}/${toolName}`) ||
          availableToolNames.has(`${app.id}/${toolName}`)
        );
      });
      if (!satisfied) continue;
      active.push({
        appId: app.id,
        skillId: skill.id,
        path: skill.path,
        name: skill.name["zh-CN"] || skill.name.en,
        description: skill.description["zh-CN"] || skill.description.en,
        requiresTools: [...skill.requiresTools],
      });
    }
  }
  return active;
}

const MAX_APP_SKILL_SECTION_CHARS = 12_000;
const MAX_SINGLE_APP_SKILL_CHARS = 3_000;

/**
 * 为对话提示词组装已启用微应用的动态技能正文（经 `resolveActiveAppSkills` 按 `requiresTools` 实时联动过滤）：
 * 只有当微应用已审阅批准、当前会话允许访问、且 `requiresTools` 全部存在于本轮可用工具集中时才激活对应技能。
 */
export async function buildActiveAppSkillsPrompt(options: {
  store: AppPackageStore;
  availableToolNames: ReadonlySet<string>;
  canExposeApp?: (app: AppPackageSummary) => boolean | Promise<boolean>;
}): Promise<string> {
  const allApps = await options.store.list();
  const visibleApps: AppPackageSummary[] = [];
  for (const app of allApps) {
    if (!app.installed || !app.enabled || app.needsReview) continue;
    if (options.canExposeApp && !(await options.canExposeApp(app))) continue;
    visibleApps.push(app);
  }
  const activeSkills = resolveActiveAppSkills(
    visibleApps,
    options.availableToolNames,
  );
  if (activeSkills.length === 0) return "";

  const detailCache = new Map<
    string,
    Awaited<ReturnType<AppPackageStore["get"]>>
  >();
  const blocks: string[] = [];
  let totalChars = 0;

  for (const item of activeSkills) {
    let detail = detailCache.get(item.appId);
    if (!detail) {
      detail = await options.store.get(item.appId).catch(() => undefined);
      if (detail) detailCache.set(item.appId, detail);
    }
    const file = detail?.package.files.find((f) => f.path === item.path);
    const rawBody =
      file?.encoding === "utf8"
        ? file.content.trim()
        : file?.encoding === "base64"
          ? Buffer.from(file.content, "base64").toString("utf8").trim()
          : "";
    const snippet = rawBody.slice(0, MAX_SINGLE_APP_SKILL_CHARS);
    const section = [
      `### 微应用技能：${item.name}（${item.appId}/${item.skillId}）`,
      item.description ? `说明：${item.description}` : "",
      snippet,
    ]
      .filter(Boolean)
      .join("\n");
    if (totalChars + section.length > MAX_APP_SKILL_SECTION_CHARS) break;
    blocks.push(section);
    totalChars += section.length;
  }

  if (blocks.length === 0) return "";
  return ["## 已激活的自研微应用技能", ...blocks].join("\n\n");
}

/**
 * 为已审阅并批准（`installed && enabled && approvedDigest === currentDigest`）的 `node-stdio`
 * 微应用挂载可执行工具，并支持通过三层授权守卫（grant / policy / audit 独立校验）桥接调用。
 */
export async function createApprovedAppTools(options: {
  store: AppPackageStore;
  runner: AppSandboxRunner;
  botId: string;
  actorId: string;
  /** 可选暴露范围过滤（按管理员角色、创建者归属或显式授权隔离，防止跨用户暴露）。 */
  canExposeApp?: (app: AppPackageSummary) => boolean | Promise<boolean>;
  /** 可选三层治理桥接：保留 grant / policy / audit 分层，绝不合并。 */
  authorize?: (input: {
    appId: string;
    digest: string;
    toolName: string;
    effect: "read" | "write";
    botId: string;
    actorId: string;
    args: Record<string, unknown>;
  }) => Promise<{ allowed: true } | { allowed: false; reason: string }>;
}): Promise<GrantedTool[]> {
  const apps = await options.store.list();
  const approvedApps: AppPackageSummary[] = [];
  for (const app of apps) {
    if (
      app.runtime.kind !== "node-stdio" ||
      !app.installed ||
      !app.enabled ||
      app.needsReview ||
      app.approvedDigest !== app.currentDigest
    ) {
      continue;
    }
    if (options.canExposeApp && !(await options.canExposeApp(app))) {
      continue;
    }
    approvedApps.push(app);
  }
  const tools: GrantedTool[] = [];

  for (const app of approvedApps) {
    let listed: Awaited<ReturnType<AppSandboxRunner["listTools"]>>;
    try {
      listed = await options.runner.listTools(app.id);
    } catch {
      continue;
    }
    for (const item of listed) {
      const safeApp = app.id.replace(/[^a-z0-9_]/gi, "_");
      const safeTool = item.name.replace(/[^a-z0-9_]/gi, "_");
      const effect: "read" | "write" =
        item.effect === "read" && !item.destructive ? "read" : "write";
      tools.push({
        name: `app__${safeApp}__${safeTool}`,
        ref: `app:${app.id}/${item.name}`,
        effect,
        description: `[自研微应用 ${app.name["zh-CN"]}] ${item.description}`,
        parameters: parametersFor(item.inputSchema),
        execute: async (rawArgs, ctx) => {
          const signal = ctx?.signal ?? currentToolAbort();
          if (signal?.aborted) return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
          const argsObj =
            rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          if (options.authorize) {
            const verdict = await options.authorize({
              appId: app.id,
              digest: app.currentDigest,
              toolName: item.name,
              effect,
              botId: options.botId,
              actorId: options.actorId,
              args: argsObj,
            });
            if (!verdict.allowed) {
              return `${REFUSAL_MARKER} ${verdict.reason}`;
            }
          }
          try {
            const result = await options.runner.callTool(
              app.id,
              item.name,
              argsObj,
              signal,
            );
            if (signal?.aborted) return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
            if (result.images && result.images.length > 0) {
              for (const img of result.images) {
                emitToolImage(img);
              }
            }
            return vendorAnswer(result);
          } catch (error) {
            if (error instanceof AppPackageError) {
              return `${REFUSAL_MARKER} ${error.message}`;
            }
            return `微应用工具调用失败：${formatMcpCallFailure(error)}`;
          }
        },
      });
    }
  }

  return tools;
}

// ── /api/apps/* 管理与用户路由 ────────────────────────────────────────────

type SealedAppOAuthState = {
  appId: string;
  userId: string;
  digest: string;
  verifier: string;
  exp: number;
};

export type AppBuilderRoutesOptions = {
  store: AppPackageStore;
  runner: AppSandboxRunner;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  encryptionKey: string;
  publicUrl?: string;
  appUrl?: string;
  /** 可选校验 OAuth2 回调当前登录会话用户 ID，须与 state.userId 一致防 Login CSRF。 */
  resolveSessionUserId?: (headers: Headers) => Promise<string | null>;
  /** 可选注入 OAuth2 换取 token 网络请求（测试隔离用）。 */
  oauthTokenFetch?: (url: string, init: RequestInit) => Promise<Response>;
};

export function createAppBuilderRoutes(
  options: AppBuilderRoutesOptions,
): Hono<{ Variables: AppVariables }> {
  const { store, runner, requireUser, encryptionKey } = options;
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  });

  const actorLabel = (context: { var: AppVariables }) =>
    context.var.actor.email ?? context.var.actor.id;

  /** 读权限与归属/角色对齐：管理员可读全站应用，普通用户仅可查看/导出本人提交的草稿或应用。 */
  const canReadApp = (
    context: { var: AppVariables },
    createdBy: string,
  ): boolean => {
    const actor = context.var.actor;
    if (actor.role === "admin") return true;
    return (
      createdBy === actor.id ||
      (Boolean(actor.email) && createdBy === actor.email)
    );
  };

  /** 列表：管理员看全站应用，普通用户仅看本人提交的草稿/应用（不含任何密文或令牌）。 */
  routes.get("/", requireUser, async (context) => {
    const apps = (await store.list()).filter((app) =>
      canReadApp(context, app.createdBy),
    );
    return context.json({
      apps,
      oauthCallbackUrl: options.publicUrl
        ? `${options.publicUrl.replace(/\/+$/, "")}${APP_OAUTH_CALLBACK_PATH}`
        : null,
    });
  });

  /** 纯静态校验单 JSON 包，不落库、不执行。 */
  routes.post(
    "/validate",
    requireUser,
    bodyLimit({ maxSize: 4 * 1024 * 1024 }),
    async (context) => {
      const body = (await context.req.json().catch(() => null)) as {
        package?: unknown;
      } | null;
      const candidate =
        body && typeof body === "object" && "package" in body
          ? body.package
          : body;
      const parsed = parsePackageInput(candidate);
      if (!parsed.ok) {
        return context.json({ error: parsed.error }, 400);
      }
      const result = store.validate(parsed.value);
      return context.json({ validation: result });
    },
  );

  /** 导入单 JSON 包到草稿区（管理员；绝不自动安装或执行）。 */
  routes.post(
    "/import",
    requireUser,
    bodyLimit({ maxSize: 4 * 1024 * 1024 }),
    async (context) => {
      const forbidden = requireAdmin(context);
      if (forbidden) return forbidden;

      const body = (await context.req.json().catch(() => null)) as {
        package?: unknown;
      } | null;
      const candidate =
        body && typeof body === "object" && "package" in body
          ? body.package
          : body;
      const parsed = parsePackageInput(candidate);
      if (!parsed.ok) {
        return context.json({ error: parsed.error }, 400);
      }
      try {
        const result = await store.submitDraft(parsed.value, actorLabel(context), {
          isAdmin: true,
        });
        await runner.closeSession(result.summary.id);
        return context.json(
          { app: result.summary, isUpdate: result.isUpdate },
          201,
        );
      } catch (error) {
        if (error instanceof AppPackageError) {
          return context.json(
            { error: error.message, code: error.code },
            error.status,
          );
        }
        throw error;
      }
    },
  );

  /** Host 托管 OAuth2 回调（绑定 appId + userId + digest + PKCE verifier，校验登录态与 client_secret）。 */
  routes.get("/oauth/callback", async (context) => {
    const code = context.req.query("code") ?? "";
    const stateParam = context.req.query("state") ?? "";
    const redirectBackBase = `${options.appUrl?.replace(/\/+$/, "") ?? ""}/admin/plugins`;

    if (!code || !stateParam || !options.publicUrl) {
      return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
    }

    const rawState = await unseal(
      stateParam,
      encryptionKey,
      APP_OAUTH_STATE_LABEL,
    );
    if (!rawState) {
      return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
    }

    let state: SealedAppOAuthState;
    try {
      state = JSON.parse(rawState) as SealedAppOAuthState;
      if (
        !state.appId ||
        !state.userId ||
        !state.digest ||
        !state.verifier ||
        typeof state.exp !== "number" ||
        state.exp <= Date.now()
      ) {
        return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
      }
    } catch {
      return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
    }

    // 校验当前登录会话用户与 state 绑定发起者一致，防止 Login CSRF
    if (options.resolveSessionUserId) {
      const sessionUserId = await options
        .resolveSessionUserId(context.req.raw.headers)
        .catch(() => null);
      if (!sessionUserId || sessionUserId !== state.userId) {
        return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
      }
    }

    try {
      const detail = await store.get(state.appId);
      if (
        detail.currentDigest !== state.digest ||
        detail.oauth?.type !== "oauth2"
      ) {
        return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
      }
      const redirectUri = `${options.publicUrl.replace(/\/+$/, "")}${APP_OAUTH_CALLBACK_PATH}`;
      const clientId =
        detail.nonSecretValues.OAUTH_CLIENT_ID || detail.oauth.clientId || "";
      if (!clientId) {
        return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
      }
      const verdict = checkPublicUrl(detail.oauth.tokenUrl);
      if (!verdict.ok || verdict.url.protocol !== "https:") {
        return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
      }
      const clientSecret = await store.getOAuthClientSecret(state.appId);
      const params = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: state.verifier,
      });
      if (clientSecret) {
        params.set("client_secret", clientSecret);
      }
      const response = options.oauthTokenFetch
        ? await options.oauthTokenFetch(detail.oauth.tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: params.toString(),
          })
        : await guardedFetchResponse(detail.oauth.tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: params.toString(),
            manualRedirect: true,
            maxBytes: 256 * 1024,
            timeoutMs: 15_000,
          });
      if (!response.ok) {
        return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
      }
      const payload = (await response.json().catch(() => null)) as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
        token_type?: unknown;
        scope?: unknown;
      } | null;
      if (
        typeof payload?.access_token !== "string" ||
        !payload.access_token ||
        /[\r\n\0]/.test(payload.access_token) ||
        payload.access_token.length > 8192
      ) {
        return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
      }
      const refreshToken =
        typeof payload.refresh_token === "string" &&
        payload.refresh_token.length > 0 &&
        !/[\r\n\0]/.test(payload.refresh_token) &&
        payload.refresh_token.length <= 8192
          ? payload.refresh_token
          : undefined;
      const tokenType =
        typeof payload.token_type === "string" &&
        payload.token_type.length > 0 &&
        !/[\r\n\0]/.test(payload.token_type) &&
        payload.token_type.length <= 128
          ? payload.token_type
          : "Bearer";
      const expiresIn =
        typeof payload.expires_in === "number" && payload.expires_in > 0
          ? payload.expires_in
          : 3600;
      await store.setOAuthTokens(
        state.appId,
        {
          accessToken: payload.access_token,
          refreshToken,
          tokenType,
          expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
          scope:
            typeof payload.scope === "string" ? payload.scope : undefined,
        },
        state.userId,
      );
      await runner.closeSession(state.appId);
      return context.redirect(
        `${redirectBackBase}?app_oauth=connected&app=${encodeURIComponent(state.appId)}`,
        302,
      );
    } catch {
      return context.redirect(`${redirectBackBase}?app_oauth=failed`, 302);
    }
  });

  /** 详情与源码审阅（包含源码预览、权限声明、摘要、版本历史；限管理员或创建者）。 */
  routes.get("/:id", requireUser, async (context) => {
    try {
      const app = await store.get(context.req.param("id"));
      if (!canReadApp(context, app.createdBy)) {
        return context.json(
          { error: "仅管理员或应用创建者可查看此微应用源码与详情。" },
          403,
        );
      }
      return context.json({ app });
    } catch (error) {
      if (error instanceof AppPackageError) {
        return context.json(
          { error: error.message, code: error.code },
          error.status,
        );
      }
      throw error;
    }
  });

  /** 显式审阅并批准安装特定 `expectedDigest`（防静默执行与 TOCTOU）。 */
  routes.post(
    "/:id/install",
    requireUser,
    bodyLimit({ maxSize: 32 * 1024 }),
    async (context) => {
      const forbidden = requireAdmin(context);
      if (forbidden) return forbidden;

      const body = (await context.req.json().catch(() => null)) as {
        expectedDigest?: unknown;
        probe?: unknown;
      } | null;
      const expectedDigest =
        typeof body?.expectedDigest === "string" ? body.expectedDigest : "";
      if (!expectedDigest.trim()) {
        return context.json(
          {
            error:
              "安装授权必须显式提供已审阅的 expectedDigest（SHA-256 摘要）。",
          },
          400,
        );
      }
      const appId = context.req.param("id");
      try {
        const app = await store.installAndApprove(
          appId,
          expectedDigest,
          actorLabel(context),
        );
        await runner.closeSession(appId);
        let tools: unknown[] | undefined;
        let probeError: string | undefined;
        if (body?.probe === true && app.runtime.kind === "node-stdio") {
          try {
            tools = await runner.listTools(appId);
          } catch (error) {
            probeError = error instanceof Error ? error.message : String(error);
          }
        }
        return context.json({
          app,
          ...(tools ? { tools } : {}),
          ...(probeError ? { probeError } : {}),
        });
      } catch (error) {
        if (error instanceof AppPackageError) {
          return context.json(
            { error: error.message, code: error.code },
            error.status,
          );
        }
        throw error;
      }
    },
  );

  /** 停用微应用并立即终止/清理其沙箱子进程。 */
  routes.post("/:id/disable", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const appId = context.req.param("id");
    try {
      await runner.closeSession(appId);
      const app = await store.disable(appId, actorLabel(context));
      return context.json({ app });
    } catch (error) {
      if (error instanceof AppPackageError) {
        return context.json(
          { error: error.message, code: error.code },
          error.status,
        );
      }
      throw error;
    }
  });

  /** 更新应用配置（AES-256-GCM 封存密钥，更新后自动关闭旧沙箱会话触发热重载）。 */
  routes.put(
    "/:id/config",
    requireUser,
    bodyLimit({ maxSize: 128 * 1024 }),
    async (context) => {
      const forbidden = requireAdmin(context);
      if (forbidden) return forbidden;
      const body = (await context.req.json().catch(() => null)) as {
        values?: unknown;
        clearKeys?: unknown;
      } | null;
      if (
        !body?.values ||
        typeof body.values !== "object" ||
        Array.isArray(body.values)
      ) {
        return context.json({ error: "values 必须是配置键值对象。" }, 400);
      }
      const clearKeys = Array.isArray(body.clearKeys)
        ? body.clearKeys.filter((k): k is string => typeof k === "string")
        : undefined;
      const appId = context.req.param("id");
      try {
        const app = await store.configure(
          appId,
          body.values as Record<string, unknown>,
          actorLabel(context),
          { clearKeys },
        );
        await runner.closeSession(appId);
        return context.json({ app });
      } catch (error) {
        if (error instanceof AppPackageError) {
          return context.json(
            { error: error.message, code: error.code },
            error.status,
          );
        }
        throw error;
      }
    },
  );

  /** 直接绑定或轮换 Host 托管 OAuth / Bearer / API Key 令牌（AES-256-GCM 封存）。 */
  routes.put(
    "/:id/oauth",
    requireUser,
    bodyLimit({ maxSize: 64 * 1024 }),
    async (context) => {
      const forbidden = requireAdmin(context);
      if (forbidden) return forbidden;
      const body = (await context.req.json().catch(() => null)) as {
        accessToken?: unknown;
        refreshToken?: unknown;
        tokenType?: unknown;
        expiresAt?: unknown;
        scope?: unknown;
        headerName?: unknown;
      } | null;
      if (!body || typeof body !== "object") {
        return context.json({ error: "请求体无效。" }, 400);
      }
      const appId = context.req.param("id");
      try {
        const app = await store.setOAuthTokens(
          appId,
          {
            ...(typeof body.accessToken === "string"
              ? { accessToken: body.accessToken }
              : {}),
            ...(typeof body.refreshToken === "string"
              ? { refreshToken: body.refreshToken }
              : {}),
            ...(typeof body.tokenType === "string"
              ? { tokenType: body.tokenType }
              : {}),
            ...(typeof body.expiresAt === "string" || body.expiresAt === null
              ? { expiresAt: body.expiresAt }
              : {}),
            ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
            ...(typeof body.headerName === "string"
              ? { headerName: body.headerName }
              : {}),
          },
          actorLabel(context),
        );
        await runner.closeSession(appId);
        return context.json({ app });
      } catch (error) {
        if (error instanceof AppPackageError) {
          return context.json(
            { error: error.message, code: error.code },
            error.status,
          );
        }
        throw error;
      }
    },
  );

  /** 发起 PKCE S256 OAuth2 授权跳转链接。 */
  routes.post("/:id/oauth/start", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    if (!options.publicUrl) {
      return context.json(
        { error: "部署未配置 CHISABOT_PUBLIC_URL，无法发起 OAuth2 回调流程。" },
        400,
      );
    }
    const appId = context.req.param("id");
    try {
      const detail = await store.get(appId);
      if (detail.oauth?.type !== "oauth2") {
        return context.json({ error: "该应用未声明 OAuth2 授权配置。" }, 400);
      }
      const clientId =
        detail.nonSecretValues.OAUTH_CLIENT_ID || detail.oauth.clientId || "";
      if (!clientId) {
        return context.json(
          { error: "请先在应用配置中填写 OAUTH_CLIENT_ID。" },
          400,
        );
      }
      const verifier = randomBytes(48).toString("base64url");
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const sealedState = await seal(
        JSON.stringify({
          appId,
          userId: context.var.actor.id,
          digest: detail.currentDigest,
          verifier,
          exp: Date.now() + APP_OAUTH_STATE_TTL_MS,
        } satisfies SealedAppOAuthState),
        encryptionKey,
        APP_OAUTH_STATE_LABEL,
      );
      const redirectUri = `${options.publicUrl.replace(/\/+$/, "")}${APP_OAUTH_CALLBACK_PATH}`;
      const authUrl = new URL(detail.oauth.authorizationUrl);
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state: sealedState,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      if (detail.oauth.scopes.length > 0) {
        params.set("scope", detail.oauth.scopes.join(" "));
      }
      for (const [k, v] of Object.entries(
        detail.oauth.authorizationParams ?? {},
      )) {
        params.set(k, v);
      }
      authUrl.search = params.toString();
      return context.json({ authorizationUrl: authUrl.toString(), redirectUri });
    } catch (error) {
      if (error instanceof AppPackageError) {
        return context.json(
          { error: error.message, code: error.code },
          error.status,
        );
      }
      throw error;
    }
  });

  /** 解绑并清空 OAuth 令牌。 */
  routes.delete("/:id/oauth", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const appId = context.req.param("id");
    try {
      await runner.closeSession(appId);
      const app = await store.clearOAuthTokens(appId, actorLabel(context));
      return context.json({ app });
    } catch (error) {
      if (error instanceof AppPackageError) {
        return context.json(
          { error: error.message, code: error.code },
          error.status,
        );
      }
      throw error;
    }
  });

  /** 不可变版本历史列表（限管理员或创建者）。 */
  routes.get("/:id/revisions", requireUser, async (context) => {
    try {
      const appId = context.req.param("id");
      const detail = await store.get(appId);
      if (!canReadApp(context, detail.createdBy)) {
        return context.json(
          { error: "仅管理员或应用创建者可查看此微应用版本历史。" },
          403,
        );
      }
      const revisions = await store.listRevisions(appId);
      return context.json({ revisions });
    } catch (error) {
      if (error instanceof AppPackageError) {
        return context.json(
          { error: error.message, code: error.code },
          error.status,
        );
      }
      throw error;
    }
  });

  /** 一键回滚到历史不可变版本。 */
  routes.post(
    "/:id/rollback",
    requireUser,
    bodyLimit({ maxSize: 32 * 1024 }),
    async (context) => {
      const forbidden = requireAdmin(context);
      if (forbidden) return forbidden;
      const body = (await context.req.json().catch(() => null)) as {
        digest?: unknown;
        approve?: unknown;
      } | null;
      const digest = typeof body?.digest === "string" ? body.digest : "";
      if (!digest.trim()) {
        return context.json({ error: "必须指定要回滚的目标 digest。" }, 400);
      }
      const appId = context.req.param("id");
      try {
        await runner.closeSession(appId);
        const app = await store.rollback(
          appId,
          digest,
          actorLabel(context),
          { approve: body?.approve === true },
        );
        return context.json({ app });
      } catch (error) {
        if (error instanceof AppPackageError) {
          return context.json(
            { error: error.message, code: error.code },
            error.status,
          );
        }
        throw error;
      }
    },
  );

  /** 脱敏导出单 JSON 应用包（严禁含任何用户密文、配置值或 OAuth 令牌；限管理员或创建者）。 */
  routes.get("/:id/export", requireUser, async (context) => {
    const appId = context.req.param("id");
    const digest = context.req.query("digest") || undefined;
    try {
      const detail = await store.get(appId);
      if (!canReadApp(context, detail.createdBy)) {
        return context.json(
          { error: "仅管理员或应用创建者可导出此微应用。" },
          403,
        );
      }
      const pkg = await store.exportPackage(appId, digest);
      return context.json({ package: pkg });
    } catch (error) {
      if (error instanceof AppPackageError) {
        return context.json(
          { error: error.message, code: error.code },
          error.status,
        );
      }
      throw error;
    }
  });

  /** 删除微应用并回收全部沙箱运行资源。 */
  routes.delete("/:id", requireUser, async (context) => {
    const forbidden = requireAdmin(context);
    if (forbidden) return forbidden;
    const appId = context.req.param("id");
    await runner.closeSession(appId);
    const deleted = await store.remove(appId, actorLabel(context));
    if (!deleted) {
      return context.json({ error: `应用 "${appId}" 不存在。` }, 404);
    }
    return context.json({ ok: true });
  });

  return routes;
}
