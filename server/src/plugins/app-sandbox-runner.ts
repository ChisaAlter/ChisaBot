/**
 * AI 自研微应用严格隔离 `node-stdio` MCP 沙箱运行态管理器：
 *
 * 超越 ProkBot 明文 env 裸跑的硬隔离措施：
 * 1. 强制校验 `approvedDigest === currentDigest`、`installed && enabled`，草稿或未重审升级永不启动；
 * 2. 清空全部继承环境变量，仅传白名单 `PATH` / 独立 `TMPDIR` / `NODE_OPTIONS`（内存上限）+ 本应用声明的非密配置；
 * 3. `OAUTH_CLIENT_SECRET` 等密文永不进普通环境变量，仅由 Host 托管并按需刷新后通过受限 `CHISABOT_APP_AUTH_HEADERS` 注入，
 *    一旦 OAuth 令牌刷新或摘要/配置变更，立即优雅重启子进程并回收旧临时目录；
 * 4. 绑定进程内存上限、单次调用超时、并发上限、空闲自动回收与退出清理（零临时目录泄漏）。
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  type ChisaAppPackage,
  DEFAULT_APP_MEMORY_LIMIT_MB,
  DEFAULT_APP_TIMEOUT_MS,
  MAX_APP_MEMORY_LIMIT_MB,
  MAX_APP_TIMEOUT_MS,
  MIN_APP_MEMORY_LIMIT_MB,
  MIN_APP_TIMEOUT_MS,
} from "../../../shared/app-packages";
import { readAppSandboxBaseEnv } from "../config";
import type { ToolImagePart } from "../conversations/tool-images";
import {
  AppPackageError,
  type AppPackageStore,
  type AppRuntimeAuthorizationSnapshot,
  validateSafePackagePath,
} from "./app-package";
import type { ListedTool, McpCallResult } from "./mcp";
import { resultText } from "./mcp";

const MAX_SANDBOX_PAGES = 20;
const MAX_SANDBOX_TOOLS = 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 16;
const DEFAULT_MAX_CONCURRENT_CALLS_PER_APP = 4;
const MAX_STDERR_CHARS = 8_000;
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;

const SANDBOX_FORBIDDEN_HOST_KEYS: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "KEY_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "COMPOSIO_API_KEY",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SHELL",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
]);

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * 构建严格白名单隔离环境变量：
 * - 拒绝所有继承自宿主环境的密钥、凭据、HOME/USERPROFILE、LD_PRELOAD 与宿主 NODE_OPTIONS；
 * - 仅允许白名单 PATH、隔离 TMPDIR/TEMP/TMP、绑定内存上限的 NODE_OPTIONS、应用声明的非密配置，
 *   以及经校验的 Host 托管 OAuth 请求头（CHISABOT_APP_AUTH_HEADERS）。
 */
export function buildSandboxedAppEnv(input: {
  pkg: ChisaAppPackage;
  nonSecretConfig: Record<string, string>;
  authHeaders: Record<string, string>;
  isolatedTmpDir: string;
  hostBaseEnv?: Record<string, string>;
  nodePath?: string;
}): Record<string, string> {
  const hostSource = input.hostBaseEnv ?? readAppSandboxBaseEnv();
  const env: Record<string, string> = {};

  // 1. 仅复制最小白名单宿主变量，再次防御过滤任何非白名单键
  const pathVal = hostSource.PATH ?? hostSource.Path;
  if (typeof pathVal === "string" && pathVal.length > 0) {
    env.PATH = pathVal;
  }
  if (process.platform === "win32") {
    const sysRoot = hostSource.SYSTEMROOT ?? hostSource.SystemRoot;
    if (typeof sysRoot === "string" && sysRoot.length > 0) {
      env.SYSTEMROOT = sysRoot;
    }
    const comSpec = hostSource.COMSPEC ?? hostSource.ComSpec;
    if (typeof comSpec === "string" && comSpec.length > 0) {
      env.COMSPEC = comSpec;
    }
  }

  // 2. 强制将临时目录指向本次会话专属隔离目录
  env.TMPDIR = input.isolatedTmpDir;
  env.TEMP = input.isolatedTmpDir;
  env.TMP = input.isolatedTmpDir;

  // 3. 绑定 V8 内存上限，剥离任何外部注入的 --require / --import / --inspect
  const memoryLimitMb =
    input.pkg.runtime.kind === "node-stdio"
      ? clampInt(
          input.pkg.runtime.memoryLimitMb ?? DEFAULT_APP_MEMORY_LIMIT_MB,
          MIN_APP_MEMORY_LIMIT_MB,
          MAX_APP_MEMORY_LIMIT_MB,
        )
      : DEFAULT_APP_MEMORY_LIMIT_MB;
  env.NODE_OPTIONS = `--max-old-space-size=${memoryLimitMb}`;

  if (input.nodePath?.trim()) {
    env.NODE_PATH = input.nodePath.trim();
  }

  // 4. 仅注入本应用 configSchema 中显式声明的非密配置项
  const allowedNonSecretKeys = new Set(
    input.pkg.configSchema
      .filter((field) => !field.secret)
      .map((field) => field.key),
  );
  for (const [key, value] of Object.entries(input.nonSecretConfig)) {
    if (!allowedNonSecretKeys.has(key)) continue;
    if (SANDBOX_FORBIDDEN_HOST_KEYS.has(key)) continue;
    if (typeof value !== "string" || value.includes("\0")) continue;
    env[key] = value;
  }

  // 5. 注入 Host 托管 OAuth / 认证请求头（严格校验头名与值，不含任何明文 clientSecret/refreshToken）
  const sanitizedHeaders: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(input.authHeaders)) {
    if (
      HEADER_NAME_RE.test(headerName) &&
      typeof headerValue === "string" &&
      !/[\r\n\0]/.test(headerValue)
    ) {
      sanitizedHeaders[headerName] = headerValue;
    }
  }
  if (Object.keys(sanitizedHeaders).length > 0) {
    env.CHISABOT_APP_AUTH_HEADERS = JSON.stringify(sanitizedHeaders);
  }

  env.CHISABOT_APP_ID = input.pkg.id;
  env.CHISABOT_APP_DIGEST = input.pkg.packageDigest;
  if (input.pkg.permissions.network.length > 0) {
    env.CHISABOT_APP_NETWORK_ORIGINS = JSON.stringify(
      input.pkg.permissions.network,
    );
  }

  return env;
}

/**
 * 不继承 `getDefaultEnvironment()` 的严格隔离 stdio MCP 传输层：
 * 直接通过 `child_process.spawn(..., { env, shell: false })` 精确控制子进程环境。
 */
class SandboxedStdioTransport implements Transport {
  private processRef: ChildProcessWithoutNullStreams | null = null;
  private readonly readBuffer = new ReadBuffer();
  private stderrText = "";
  private closed = false;

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(
    private readonly params: {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
    },
  ) {}

  get pid(): number | null {
    return this.processRef?.pid ?? null;
  }

  get recentStderr(): string {
    return this.stderrText;
  }

  async start(): Promise<void> {
    if (this.processRef) {
      throw new Error("SandboxedStdioTransport already started.");
    }
    this.closed = false;
    return new Promise((resolveStart, rejectStart) => {
      let settled = false;
      // Windows 下 Bun spawn 若未显式声明 USERPROFILE 等键，会从宿主进程令牌自动补全真实用户目录；显式置空防止路径泄漏
      const spawnEnv: Record<string, string> =
        process.platform === "win32"
          ? {
              HOME: "",
              USERPROFILE: "",
              HOMEDRIVE: "",
              HOMEPATH: "",
              APPDATA: "",
              LOCALAPPDATA: "",
              ...this.params.env,
            }
          : this.params.env;
      const child = spawn(this.params.command, this.params.args, {
        cwd: this.params.cwd,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: process.platform === "win32",
      });
      this.processRef = child;

      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          rejectStart(error);
        }
        this.onerror?.(error);
      });

      child.on("spawn", () => {
        if (!settled) {
          settled = true;
          resolveStart();
        }
      });

      child.on("close", () => {
        this.processRef = null;
        this.closed = true;
        this.onclose?.();
      });

      child.stdin.on("error", (error) => {
        if (!this.closed) this.onerror?.(error);
      });

      child.stdout.on("data", (chunk: Buffer) => {
        try {
          this.readBuffer.append(chunk);
          for (;;) {
            const msg = this.readBuffer.readMessage();
            if (msg === null) break;
            this.onmessage?.(msg);
          }
        } catch (error) {
          this.onerror?.(
            error instanceof Error ? error : new Error(String(error)),
          );
          void this.close().catch(() => {});
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const piece = chunk.toString("utf8");
        this.stderrText = (this.stderrText + piece).slice(-MAX_STDERR_CHARS);
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.processRef;
    if (!child?.stdin.writable) {
      throw new Error("沙箱应用子进程未连接或已退出。");
    }
    const serialized = serializeMessage(message);
    return new Promise((resolveSend, rejectSend) => {
      child.stdin.write(serialized, (err) => {
        if (err) rejectSend(err);
        else resolveSend();
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.processRef;
    this.processRef = null;
    if (!child) {
      this.readBuffer.clear();
      return;
    }

    const exited = new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.killed) {
        resolveExit();
        return;
      }
      child.once("close", () => resolveExit());
    });

    try {
      child.stdin.end();
    } catch {
      // ignore
    }

    await Promise.race([
      exited,
      new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 800);
        timer.unref?.();
      }),
    ]);

    if (child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      await Promise.race([
        exited,
        new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, 1200);
          timer.unref?.();
        }),
      ]);
    }

    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      await Promise.race([
        exited,
        new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, 500);
          timer.unref?.();
        }),
      ]);
    }

    this.readBuffer.clear();
  }
}

async function materializeSandboxDirectory(
  rootParent: string,
  pkg: ChisaAppPackage,
): Promise<{
  sessionRoot: string;
  appDir: string;
  tmpDir: string;
  entryAbsPath: string;
}> {
  if (pkg.runtime.kind !== "node-stdio") {
    throw new AppPackageError(
      `应用 "${pkg.id}" 运行时为 ${pkg.runtime.kind}，不是 node-stdio 沙箱进程。`,
      400,
    );
  }
  const sessionRoot = resolve(
    rootParent,
    `chisabot-app-${pkg.id}-${pkg.packageDigest.slice(0, 12)}-${randomUUID()}`,
  );
  const appDir = join(sessionRoot, "app");
  const tmpDir = join(sessionRoot, "tmp");

  try {
    await mkdir(appDir, { recursive: true, mode: 0o700 });
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });

    const writtenFiles: string[] = [];
    let hasPackageJson = false;

    for (const file of pkg.files) {
      const safe = validateSafePackagePath(file.path);
      if (!safe.ok || !safe.path) {
        throw new AppPackageError(
          safe.reason ?? `拒绝落盘非法路径：${file.path}`,
          400,
        );
      }
      if (safe.path === "package.json") hasPackageJson = true;
      const dest = resolve(appDir, safe.path);
      const rel = relative(appDir, dest);
      if (rel.startsWith("..") || rel.includes("..")) {
        throw new AppPackageError(`拒绝越界路径落盘：${file.path}`, 400);
      }
      const parentDir = dirname(dest);
      await mkdir(parentDir, { recursive: true, mode: 0o700 });
      const parentStat = await lstat(parentDir);
      if (parentStat.isSymbolicLink()) {
        throw new AppPackageError("沙箱目录出现符号链接，已拒绝落盘。", 400);
      }
      const bytes = Buffer.from(file.content, file.encoding);
      await writeFile(dest, bytes, { mode: 0o600 });
      writtenFiles.push(dest);
    }

    if (!hasPackageJson) {
      const pkgJsonPath = join(appDir, "package.json");
      await writeFile(pkgJsonPath, '{"type":"module"}\n', { mode: 0o600 });
      writtenFiles.push(pkgJsonPath);
    }

    // POSIX 下将源码文件收紧为只读，防止子进程篡改自身入口代码
    if (process.platform !== "win32") {
      for (const filePath of writtenFiles) {
        await chmod(filePath, 0o444).catch(() => {});
      }
    }

    const entryAbsPath = resolve(appDir, pkg.runtime.entry);
    const entryRel = relative(appDir, entryAbsPath);
    if (entryRel.startsWith("..") || entryRel.includes("..")) {
      throw new AppPackageError("沙箱入口路径越界。", 400);
    }

    return { sessionRoot, appDir, tmpDir, entryAbsPath };
  } catch (error) {
    await rm(sessionRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupSandboxDirectory(sessionRoot: string): Promise<void> {
  await rm(sessionRoot, { recursive: true, force: true }).catch(() => {});
}

type ActiveSandboxSession = {
  sessionId: string;
  appId: string;
  digest: string;
  authFingerprint: string;
  client: Client;
  transport: SandboxedStdioTransport;
  sessionRoot: string;
  appDir: string;
  tmpDir: string;
  timeoutMs: number;
  inFlight: number;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
};

export type AppSandboxSessionDiagnostics = {
  appId: string;
  sessionId: string;
  pid: number | null;
  digest: string;
  authFingerprint: string;
  sessionRoot: string;
  inFlight: number;
  restartCount: number;
};

export type AppSandboxRunnerOptions = {
  store: AppPackageStore;
  /** 沙箱临时工作目录父路径，默认使用系统 tmpdir。 */
  tempRootDir?: string;
  /** 启动 Node 的命令，默认 "node"。 */
  nodeCommand?: string;
  /** 可选宿主基础环境变量注入（测试隔离用）。 */
  hostBaseEnv?: Record<string, string>;
  /** 可选只读 NODE_PATH，用于解析共享只读依赖而不在沙箱内建任何 symlink。 */
  nodePath?: string;
  /** 空闲会话回收时间，默认 5 分钟。 */
  idleTimeoutMs?: number;
  /** 启动握手超时，默认 15 秒。 */
  connectTimeoutMs?: number;
  /** 全局最大同时存活沙箱进程数，默认 16。 */
  maxActiveSessions?: number;
  /** 单应用最大并发调用数，默认 4。 */
  maxConcurrentCallsPerApp?: number;
  /** 可选 MCP 返回图片提取校验器（由 mcp-enhancements 接入）。 */
  extractImages?: (content: unknown) => ToolImagePart[];
};

export function createAppSandboxRunner(options: AppSandboxRunnerOptions) {
  const tempRootDir = options.tempRootDir ?? tmpdir();
  const nodeCommand = options.nodeCommand ?? "node";
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const maxActiveSessions =
    options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
  const maxConcurrentCallsPerApp =
    options.maxConcurrentCallsPerApp ?? DEFAULT_MAX_CONCURRENT_CALLS_PER_APP;

  const sessions = new Map<string, ActiveSandboxSession>();
  const lifecycleLocks = new Map<string, Promise<unknown>>();
  const restartCounts = new Map<string, number>();

  function withAppLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = lifecycleLocks.get(appId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    lifecycleLocks.set(appId, next);
    void next.finally(() => {
      if (lifecycleLocks.get(appId) === next) {
        lifecycleLocks.delete(appId);
      }
    });
    return next;
  }

  async function destroySession(session: ActiveSandboxSession): Promise<void> {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (sessions.get(session.appId) === session) {
      sessions.delete(session.appId);
    }
    try {
      await session.client.close();
    } catch {
      // ignore close errors
    }
    try {
      await session.transport.close();
    } catch {
      // ignore close errors
    }
    await cleanupSandboxDirectory(session.sessionRoot);
  }

  function resetIdleTimer(session: ActiveSandboxSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.lastUsedAt = Date.now();
    const timer = setTimeout(() => {
      if (session.inFlight > 0) {
        resetIdleTimer(session);
        return;
      }
      void withAppLock(session.appId, async () => {
        if (sessions.get(session.appId) === session && session.inFlight === 0) {
          await destroySession(session);
        }
      });
    }, idleTimeoutMs);
    timer.unref?.();
    session.idleTimer = timer;
  }

  async function evictOldestIdleSessionIfFull(): Promise<void> {
    if (sessions.size < maxActiveSessions) return;
    const candidates = [...sessions.values()]
      .filter((s) => s.inFlight === 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const victim = candidates[0];
    if (!victim) {
      throw new AppPackageError(
        `当前活跃沙箱进程数已达上限（${maxActiveSessions}），请稍后重试。`,
        409,
        "sandbox_capacity_exceeded",
      );
    }
    await destroySession(victim);
  }

  async function ensureSessionLocked(
    snapshot: AppRuntimeAuthorizationSnapshot,
  ): Promise<ActiveSandboxSession> {
    const existing = sessions.get(snapshot.appId);
    if (existing) {
      const sameDigest = existing.digest === snapshot.digest;
      const sameAuth = existing.authFingerprint === snapshot.authFingerprint;
      const alive = existing.transport.pid !== null;
      if (sameDigest && sameAuth && alive) {
        resetIdleTimer(existing);
        return existing;
      }
      // OAuth 令牌刷新、配置变更或版本切换：优雅重启子进程
      await destroySession(existing);
      restartCounts.set(
        snapshot.appId,
        (restartCounts.get(snapshot.appId) ?? 0) + 1,
      );
    }

    await evictOldestIdleSessionIfFull();

    const materialized = await materializeSandboxDirectory(
      tempRootDir,
      snapshot.pkg,
    );
    const env = buildSandboxedAppEnv({
      pkg: snapshot.pkg,
      nonSecretConfig: snapshot.nonSecretConfig,
      authHeaders: snapshot.authHeaders,
      isolatedTmpDir: materialized.tmpDir,
      hostBaseEnv: options.hostBaseEnv,
      nodePath: options.nodePath,
    });

    const transport = new SandboxedStdioTransport({
      command: nodeCommand,
      args: [materialized.entryAbsPath],
      cwd: materialized.appDir,
      env,
    });
    const client = new Client({
      name: "chisabot-app-sandbox",
      version: "1.0.0",
    });

    const timeoutMs =
      snapshot.pkg.runtime.kind === "node-stdio"
        ? clampInt(
            snapshot.pkg.runtime.timeoutMs ?? DEFAULT_APP_TIMEOUT_MS,
            MIN_APP_TIMEOUT_MS,
            MAX_APP_TIMEOUT_MS,
          )
        : DEFAULT_APP_TIMEOUT_MS;

    try {
      await client.connect(transport, { timeout: connectTimeoutMs });
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      await cleanupSandboxDirectory(materialized.sessionRoot);
      const stderrTail = transport.recentStderr.trim().slice(0, 300);
      throw new AppPackageError(
        `应用 "${snapshot.appId}" 沙箱启动或 MCP 握手失败：${error instanceof Error ? error.message : String(error)}${stderrTail ? `（stderr: ${stderrTail}）` : ""}`,
        400,
        "sandbox_start_failed",
      );
    }

    const session: ActiveSandboxSession = {
      sessionId: randomUUID(),
      appId: snapshot.appId,
      digest: snapshot.digest,
      authFingerprint: snapshot.authFingerprint,
      client,
      transport,
      sessionRoot: materialized.sessionRoot,
      appDir: materialized.appDir,
      tmpDir: materialized.tmpDir,
      timeoutMs,
      inFlight: 0,
      lastUsedAt: Date.now(),
      idleTimer: null,
      startedAt: Date.now(),
    };

    transport.onclose = () => {
      if (sessions.get(session.appId) === session) {
        sessions.delete(session.appId);
        if (session.idleTimer) {
          clearTimeout(session.idleTimer);
          session.idleTimer = null;
        }
        void cleanupSandboxDirectory(session.sessionRoot);
      }
    };

    sessions.set(snapshot.appId, session);
    resetIdleTimer(session);
    return session;
  }

  return {
    async listTools(appId: string, signal?: AbortSignal): Promise<ListedTool[]> {
      const snapshot = await options.store.getRuntimeSnapshot(appId);
      if (snapshot.pkg.runtime.kind === "skills-only") return [];
      if (snapshot.pkg.runtime.kind !== "node-stdio") {
        throw new AppPackageError(
          `应用 "${appId}" 不是 node-stdio 运行时，请通过远端 MCP 管线调用。`,
          400,
        );
      }

      const session = await withAppLock(appId, () =>
        ensureSessionLocked(snapshot),
      );

      if (session.inFlight >= maxConcurrentCallsPerApp) {
        throw new AppPackageError(
          `应用 "${appId}" 并发调用数已达上限（${maxConcurrentCallsPerApp}）。`,
          409,
          "sandbox_concurrency_limit",
        );
      }

      session.inFlight += 1;
      try {
        const tools: ListedTool[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < MAX_SANDBOX_PAGES; page += 1) {
          const result = await session.client.listTools(
            cursor ? { cursor } : undefined,
            { timeout: session.timeoutMs, ...(signal ? { signal } : {}) },
          );
          for (const tool of result.tools) {
            tools.push({
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
              ...(tool.annotations?.destructiveHint === true
                ? { effect: "write" as const, destructive: true }
                : {}),
            });
            if (tools.length > MAX_SANDBOX_TOOLS) {
              throw new AppPackageError(
                `应用 "${appId}" 返回工具总数超过上限（${MAX_SANDBOX_TOOLS}）。`,
                400,
              );
            }
          }
          const nextCursor = result.nextCursor;
          if (!nextCursor) {
            cursor = undefined;
            break;
          }
          if (seenCursors.has(nextCursor)) {
            throw new AppPackageError(
              `应用 "${appId}" listTools 返回重复分页游标，已终止防死循环。`,
              400,
            );
          }
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        if (cursor) {
          throw new AppPackageError(
            `应用 "${appId}" listTools 分页超过上限（${MAX_SANDBOX_PAGES} 页）。`,
            400,
          );
        }
        resetIdleTimer(session);
        return tools;
      } finally {
        session.inFlight = Math.max(0, session.inFlight - 1);
      }
    },

    async callTool(
      appId: string,
      toolName: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<McpCallResult & { images?: ToolImagePart[] }> {
      const snapshot = await options.store.getRuntimeSnapshot(appId);
      if (snapshot.pkg.runtime.kind !== "node-stdio") {
        throw new AppPackageError(
          `应用 "${appId}" 不是 node-stdio 运行时，无法通过沙箱执行工具。`,
          400,
        );
      }

      const session = await withAppLock(appId, () =>
        ensureSessionLocked(snapshot),
      );

      if (session.inFlight >= maxConcurrentCallsPerApp) {
        throw new AppPackageError(
          `应用 "${appId}" 并发调用数已达上限（${maxConcurrentCallsPerApp}）。`,
          409,
          "sandbox_concurrency_limit",
        );
      }

      session.inFlight += 1;
      try {
        const result = await session.client.callTool(
          { name: toolName, arguments: args },
          undefined,
          { timeout: session.timeoutMs, ...(signal ? { signal } : {}) },
        );
        resetIdleTimer(session);
        const { text, truncated } = resultText(
          result.content,
          "structuredContent" in result ? result.structuredContent : undefined,
        );
        const images = options.extractImages
          ? options.extractImages(result.content)
          : [];
        return {
          text,
          isError: result.isError === true,
          truncated,
          ...(images.length > 0 ? { images } : {}),
        };
      } catch (error) {
        // 超时或子进程异常退出时直接清理异常会话，并提示模型切勿自动重试
        const msg = error instanceof Error ? error.message : String(error);
        if (/timed out|timeout|closed|epipe|eof/i.test(msg)) {
          void withAppLock(appId, async () => {
            if (sessions.get(appId) === session) {
              await destroySession(session);
            }
          });
          return {
            text: `沙箱微应用工具调用超时或进程中断（${msg}）。外部操作可能已产生副作用，请不要自动重试，请先核查外部状态。`,
            isError: true,
            truncated: false,
          };
        }
        throw error;
      } finally {
        session.inFlight = Math.max(0, session.inFlight - 1);
      }
    },

    async closeSession(appId: string): Promise<void> {
      await withAppLock(appId, async () => {
        const session = sessions.get(appId);
        if (session) {
          await destroySession(session);
        }
      });
    },

    async shutdown(): Promise<void> {
      const appIds = [...sessions.keys()];
      await Promise.allSettled(appIds.map((appId) => this.closeSession(appId)));
    },

    getDiagnostics(appId: string): AppSandboxSessionDiagnostics | null {
      const session = sessions.get(appId);
      if (!session) return null;
      return {
        appId: session.appId,
        sessionId: session.sessionId,
        pid: session.transport.pid,
        digest: session.digest,
        authFingerprint: session.authFingerprint,
        sessionRoot: session.sessionRoot,
        inFlight: session.inFlight,
        restartCount: restartCounts.get(appId) ?? 0,
      };
    },

    getRestartCount(appId: string): number {
      return restartCounts.get(appId) ?? 0;
    },
  };
}

export type AppSandboxRunner = ReturnType<typeof createAppSandboxRunner>;
