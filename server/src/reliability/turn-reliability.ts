import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  atomicWriteFileUnique,
  atomicWriteFileUniqueSync,
} from "../security/file-hygiene";

/**
 * 回合级可靠性底盘（Wave 10 §6.3 #9）：
 *
 * 1. 基于 `AsyncLocalStorage` 的父子对话树与 Durable Tool Journal：
 *    - 每次子代理嵌套执行自动继承 `parentConversationId` 与 `rootConversationId`；
 *    - 删除父会话时扫描完整父子孙对话树，若任何子代理仍有活跃工具调用未结束，直接抛出
 *      `ActiveToolJournalError` 拒绝清理并保留全部父子记录；
 *    - 交互卡片延迟续跑通过 `deferred -> resumed-<uuid>` 的原子 `rename` 一次性占坑，
 *      并发或二次续跑绝不会双次执行工具副作用。
 * 2. Handoff 持久化与启动三方双向对账（`handoffStore <-> 会话最后卡片 <-> awaiting 角标`）：
 *    - 完成交接回调失败时保留 pending 绝不丢交接；
 *    - 启动时清除孤儿 pending、从最新未解决交接卡反向恢复遗漏 pending、清除陈旧虚假角标、
 *      修复因回调失败被误清的 awaiting 角标（且绝不覆写其他功能的 awaiting 角标）。
 */

export type ToolJournalScope = {
  conversationId: string;
  parentConversationId?: string;
  rootConversationId: string;
};

const scopeStorage = new AsyncLocalStorage<ToolJournalScope>();

export function currentToolJournalScope(): ToolJournalScope | undefined {
  return scopeStorage.getStore();
}

/** 建立或嵌套一个父子对话树作用域，子代理自动继承父级与根对话 ID。 */
export function withToolJournalScope<T>(
  conversationId: string,
  execute: () => T,
): T {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    throw new Error("Tool Journal 作用域需要非空的 conversationId。");
  }
  const parent = scopeStorage.getStore();
  const nextScope: ToolJournalScope = {
    conversationId: trimmed,
    ...(parent ? { parentConversationId: parent.conversationId } : {}),
    rootConversationId: parent?.rootConversationId ?? trimmed,
  };
  return scopeStorage.run(nextScope, execute);
}

export class ActiveToolJournalError extends Error {
  readonly code = "ACTIVE_TOOL_JOURNAL";
  constructor(
    readonly conversationId: string,
    readonly activeScopeIds: readonly string[],
    message = `对话 ${conversationId} 或其子代理仍有活跃执行中的工具记录，拒绝清理 Tool Journal。`,
  ) {
    super(message);
    this.name = "ActiveToolJournalError";
  }
}

export type ToolJournalOutcome<T> =
  | { kind: "executed"; result: T; resumedFromDeferred: boolean }
  | { kind: "replayed"; result: T }
  | { kind: "unknown"; reason: string; automaticReplayBlocked: true };

type IntentRecord = {
  version: 1;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  fingerprint: string;
  startedAt: string;
};

type SavedResultRecord<T> = {
  version: 1;
  fingerprint: string;
  result: T;
  completedAt: string;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function errCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

async function renameDeferredWithRetry(
  deferredPath: string,
  resumedPath: string,
): Promise<boolean> {
  const retryable = new Set(["EBUSY", "EPERM", "EACCES"]);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(deferredPath, resumedPath);
      return true;
    } catch (error) {
      const code = errCode(error);
      if (code === "ENOENT") return false;
      if (!retryable.has(code) || attempt === 5) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
  return false;
}

function extractDeferredToken(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { deferredToken?: unknown };
    if (
      typeof parsed?.deferredToken === "string" &&
      /^[a-zA-Z0-9_-]{8,128}$/.test(parsed.deferredToken)
    ) {
      return parsed.deferredToken;
    }
  } catch {
    // 兼容旧版纯文本 deferred 标记
  }
  return sha256Hex(raw);
}

/**
 * 原子独占写（无 0 字节窗口）：
 * 先将完整内容写入 `${filePath}.${pid}.${uuid}.tmp` 并 `fsync`，
 * 再通过 `link(tmpPath, filePath)` 原子发布（目标已存在时精确抛 `EEXIST`），
 * 保证并发读者绝不会看到半写或 0 字节的 `intent.json` / `scope.json`。
 */
async function writeExclusiveFile(
  filePath: string,
  content: string,
): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmpPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmpPath, filePath);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export function createDurableToolJournal(rootDir: string) {
  const baseDir = join(resolve(rootDir), "tool-execution-journal");
  /** key: `${scopeDirPath}::${callDirPath}::${fingerprint}` -> conversationId */
  const activeExecutions = new Map<
    string,
    { scopeDir: string; conversationId: string; promise: Promise<unknown> }
  >();

  async function runJournaledTool<T>(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    turnId?: string;
    signal?: AbortSignal;
    isDeferred?: (error: unknown) => boolean;
    execute: () => Promise<T>;
  }): Promise<ToolJournalOutcome<T>> {
    const scope = scopeStorage.getStore();
    if (!scope) {
      throw new Error("执行持久化工具调用必须位于 withToolJournalScope 内。");
    }
    if (!input.toolCallId.trim()) {
      throw new Error("toolCallId 不能为空。");
    }
    if (input.signal?.aborted) {
      const abortErr = new Error("工具调用在准入前已中止。");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    const turnId = input.turnId ?? "unscoped-turn";
    const fingerprint = sha256Hex(
      JSON.stringify({
        toolName: input.toolName,
        args: canonicalize(input.args),
      }),
    );
    const scopeHash = sha256Hex(scope.conversationId);
    const callHash = sha256Hex(JSON.stringify([turnId, input.toolCallId]));
    const scopeDir = join(baseDir, scopeHash);
    const callDir = join(scopeDir, callHash);
    const activeKey = `${scopeDir}::${callDir}::${fingerprint}`;

    const existingActive = activeExecutions.get(activeKey);
    if (existingActive) {
      return (await existingActive.promise) as ToolJournalOutcome<T>;
    }

    const work = (async (): Promise<ToolJournalOutcome<T>> => {
      await mkdir(callDir, { recursive: true, mode: 0o700 });
      try {
        await writeExclusiveFile(
          join(scopeDir, "scope.json"),
          `${JSON.stringify(scope)}\n`,
        );
      } catch (error) {
        if (errCode(error) !== "EEXIST") throw error;
      }

      const intentPath = join(callDir, "intent.json");
      const resultPath = join(callDir, "result.json");
      const deferredPath = join(callDir, "deferred");
      let resumedFromDeferred = false;

      const intent: IntentRecord = {
        version: 1,
        conversationId: scope.conversationId,
        turnId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        fingerprint,
        startedAt: new Date().toISOString(),
      };

      try {
        await writeExclusiveFile(intentPath, `${JSON.stringify(intent)}\n`);
      } catch (error) {
        if (errCode(error) !== "EEXIST") throw error;

        let existingIntent: IntentRecord;
        try {
          existingIntent = JSON.parse(
            await readFile(intentPath, "utf8"),
          ) as IntentRecord;
        } catch {
          return {
            kind: "unknown",
            reason: "已落盘的执行意图损坏，禁止自动重放。",
            automaticReplayBlocked: true,
          };
        }

        if (existingIntent.fingerprint !== fingerprint) {
          return {
            kind: "unknown",
            reason: "相同 toolCallId 携带了不同参数，禁止重放。",
            automaticReplayBlocked: true,
          };
        }

        try {
          const saved = JSON.parse(
            await readFile(resultPath, "utf8"),
          ) as SavedResultRecord<T>;
          if (saved.version !== 1 || saved.fingerprint !== fingerprint) {
            return {
              kind: "unknown",
              reason: "已保存的工具结果摘要不匹配，禁止重放。",
              automaticReplayBlocked: true,
            };
          }
          return { kind: "replayed", result: saved.result };
        } catch (readErr) {
          if (errCode(readErr) !== "ENOENT") {
            return {
              kind: "unknown",
              reason: "已保存的工具结果无法读取，禁止自动重放。",
              automaticReplayBlocked: true,
            };
          }
        }

        // 交互卡片延迟续跑：先通过 O_CREAT|O_EXCL 独占 claim 跨平台保证单胜者（兼容 Windows Bun rename 并发特性），
        // 再执行 rename("deferred", "resumed-<uuid>") 原子跃迁，彻底杜绝并发或二次续跑。
        let deferredRaw: string;
        try {
          deferredRaw = await readFile(deferredPath, "utf8");
        } catch (readDeferredErr) {
          if (errCode(readDeferredErr) === "ENOENT") {
            return {
              kind: "unknown",
              reason:
                "前次执行尚未完成或延迟续跑已被其他请求占坑，禁止重复执行副作用。",
              automaticReplayBlocked: true,
            };
          }
          throw readDeferredErr;
        }

        if (input.signal?.aborted) {
          return {
            kind: "unknown",
            reason: "在调用工具正文前收到取消信号，未消耗延迟续跑令牌。",
            automaticReplayBlocked: true,
          };
        }

        const deferredToken = extractDeferredToken(deferredRaw);
        const resumeId = randomUUID();
        const claimPath = join(callDir, `deferred-claim-${deferredToken}`);
        try {
          await writeExclusiveFile(claimPath, `${resumeId}\n`);
        } catch (claimErr) {
          if (errCode(claimErr) === "EEXIST") {
            return {
              kind: "unknown",
              reason:
                "前次执行尚未完成或延迟续跑已被其他请求占坑，禁止重复执行副作用。",
              automaticReplayBlocked: true,
            };
          }
          throw claimErr;
        }

        const resumedPath = join(callDir, `resumed-${resumeId}`);
        let renamed = false;
        try {
          renamed = await renameDeferredWithRetry(deferredPath, resumedPath);
        } catch (renameErr) {
          // rename 异常失败时立即撤销 claim，避免残留 deferred-claim-* 导致后续重试永久 EEXIST 死锁。
          await unlink(claimPath).catch(() => {});
          throw renameErr;
        }
        if (!renamed) {
          await unlink(claimPath).catch(() => {});
          return {
            kind: "unknown",
            reason:
              "前次执行尚未完成或延迟续跑已被其他请求占坑，禁止重复执行副作用。",
            automaticReplayBlocked: true,
          };
        }
        resumedFromDeferred = true;
      }

      if (input.signal?.aborted) {
        const outcome: ToolJournalOutcome<T> = {
          kind: "unknown",
          reason: "在调用工具正文前收到取消信号，未执行外部副作用。",
          automaticReplayBlocked: true,
        };
        return outcome;
      }

      let result: T;
      try {
        result = await input.execute();
      } catch (error) {
        if (input.isDeferred?.(error)) {
          await atomicWriteFileUnique(
            deferredPath,
            `${JSON.stringify({
              version: 1,
              deferredToken: randomUUID(),
              deferredAt: new Date().toISOString(),
            })}\n`,
            { mode: 0o600 },
          );
        }
        throw error;
      }

      const savedRecord: SavedResultRecord<T> = {
        version: 1,
        fingerprint,
        result,
        completedAt: new Date().toISOString(),
      };
      await atomicWriteFileUnique(
        resultPath,
        `${JSON.stringify(savedRecord)}\n`,
        { mode: 0o600 },
      );

      return {
        kind: "executed",
        result,
        resumedFromDeferred,
      };
    })();

    activeExecutions.set(activeKey, {
      scopeDir,
      conversationId: scope.conversationId,
      promise: work,
    });
    try {
      return await work;
    } finally {
      activeExecutions.delete(activeKey);
    }
  }

  /**
   * 删除某会话（含其整个子孙会话树）的 Tool Journal。
   * 若父会话或其任一子孙代理仍有活跃工具调用未结束，强制拒绝清理并保留全部父子记录。
   */
  async function removeToolJournal(
    conversationId: string,
  ): Promise<{ removedScopes: number }> {
    const trimmed = conversationId.trim();
    if (!trimmed) {
      throw new Error("removeToolJournal 需要有效的 conversationId。");
    }
    const names = await readdir(baseDir).catch((error) => {
      if (errCode(error) === "ENOENT") return [] as string[];
      throw error;
    });
    const records: Array<{ path: string; scope: ToolJournalScope }> = [];
    for (const name of names) {
      const dirPath = join(baseDir, name);
      try {
        const raw = await readFile(join(dirPath, "scope.json"), "utf8");
        const parsed = JSON.parse(raw) as ToolJournalScope;
        if (
          typeof parsed.conversationId === "string" &&
          parsed.conversationId
        ) {
          records.push({ path: dirPath, scope: parsed });
        }
      } catch {
        // 忽略尚在初始化或损坏的目录项。
      }
    }

    const subtreeIds = new Set<string>([trimmed]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const { scope } of records) {
        if (
          !subtreeIds.has(scope.conversationId) &&
          ((scope.parentConversationId &&
            subtreeIds.has(scope.parentConversationId)) ||
            subtreeIds.has(scope.rootConversationId))
        ) {
          subtreeIds.add(scope.conversationId);
          changed = true;
        }
      }
    }

    const targetDirs = records
      .filter(({ scope }) => subtreeIds.has(scope.conversationId))
      .map(({ path }) => path);
    const targetDirSet = new Set(targetDirs);

    const activeHits: string[] = [];
    for (const entry of activeExecutions.values()) {
      if (
        subtreeIds.has(entry.conversationId) ||
        targetDirSet.has(entry.scopeDir)
      ) {
        activeHits.push(entry.conversationId);
      }
    }
    if (activeHits.length > 0) {
      throw new ActiveToolJournalError(trimmed, [...new Set(activeHits)]);
    }

    for (const dirPath of targetDirs) {
      await rm(dirPath, { recursive: true, force: true });
    }
    return { removedScopes: targetDirs.length };
  }

  return {
    baseDir,
    runJournaledTool,
    removeToolJournal,
    activeCount: () => activeExecutions.size,
  };
}

export type PendingHandoff = {
  requestId: string;
  instruction: string;
  tabId?: string;
  createdAt?: number;
};

type PersistedHandoffFile = {
  version: 1;
  entries: Array<[string, PendingHandoff]>;
};

/**
 * Handoff 持久化存储：
 * - 全部落盘走 `atomicWriteFileUniqueSync`（唯一 tmp 名 + 0600 + fsync）；
 * - `complete` 完成交接回调若抛错，保留 pending 绝不丢交接！
 */
export class HandoffStore {
  readonly filename: string;
  private entriesMap: Map<string, PendingHandoff>;
  private readonly completingSessions = new Set<string>();

  constructor(directory: string) {
    const trimmed = directory.trim();
    if (!trimmed) {
      throw new Error("HandoffStore 需要持久化目录路径。");
    }
    mkdirSync(trimmed, { recursive: true, mode: 0o700 });
    this.filename = join(trimmed, "pending-handoffs.json");
    this.entriesMap = new Map();

    let saved: PersistedHandoffFile | undefined;
    try {
      saved = JSON.parse(
        readFileSync(this.filename, "utf8"),
      ) as PersistedHandoffFile;
    } catch (error) {
      if (errCode(error) !== "ENOENT") throw error;
    }

    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.entries)) {
        throw new Error("HandoffStore 持久化文件格式无效。");
      }
      for (const pair of saved.entries) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new Error("HandoffStore 条目格式无效。");
        }
        const [sessionId, entry] = pair;
        if (
          typeof sessionId !== "string" ||
          !sessionId ||
          typeof entry?.requestId !== "string" ||
          !entry.requestId ||
          typeof entry?.instruction !== "string"
        ) {
          throw new Error("HandoffStore 包含非法交接记录。");
        }
        this.entriesMap.set(sessionId, { ...entry });
      }
    }
  }

  private persist(next: Map<string, PendingHandoff>): void {
    const payload: PersistedHandoffFile = {
      version: 1,
      entries: [...next.entries()],
    };
    atomicWriteFileUniqueSync(this.filename, `${JSON.stringify(payload)}\n`, {
      mode: 0o600,
    });
    this.entriesMap = new Map(next);
  }

  get(sessionId: string): PendingHandoff | null {
    const hit = this.entriesMap.get(sessionId);
    return hit ? { ...hit } : null;
  }

  keys(): string[] {
    return [...this.entriesMap.keys()];
  }

  size(): number {
    return this.entriesMap.size;
  }

  set(sessionId: string, pending: PendingHandoff): void {
    const next = new Map(this.entriesMap);
    next.set(sessionId, { ...pending });
    this.persist(next);
  }

  restore(sessionId: string, pending: PendingHandoff): void {
    this.set(sessionId, pending);
  }

  forget(sessionId: string): boolean {
    if (!this.entriesMap.has(sessionId)) return false;
    const next = new Map(this.entriesMap);
    next.delete(sessionId);
    this.persist(next);
    return true;
  }

  /**
   * 结束交接：
   * - 按 sessionId 持有内存互斥锁，防止并发重复调用双次触发 `onComplete`；
   * - 必须等待回调真实成功后才清除 pending；若回调抛错，保留 pending 并释放互斥锁允许后续重试。
   */
  async complete<T>(
    sessionId: string,
    onComplete: (pending: PendingHandoff) => Promise<T> | T,
  ): Promise<T> {
    if (this.completingSessions.has(sessionId)) {
      throw new Error(`会话 ${sessionId} 的交接正在完成中，禁止并发重复提交。`);
    }
    const pending = this.get(sessionId);
    if (!pending) {
      throw new Error(`会话 ${sessionId} 没有待完成的交接记录。`);
    }
    this.completingSessions.add(sessionId);
    try {
      const result = await onComplete(pending);
      this.forget(sessionId);
      return result;
    } finally {
      this.completingSessions.delete(sessionId);
    }
  }
}

export type AwaitingBadgeState = {
  tabId: string;
  reason: string;
  since: number;
};

export type SessionHandoffCard = {
  requestId: string;
  instruction?: string;
  resolution?: string | null;
};

export type SessionReconcileHandle = {
  getAwaitingBadge(): AwaitingBadgeState | null;
  setAwaitingBadgeForTab(tabId: string, badge: AwaitingBadgeState | null): void;
  getHandoffCards(): readonly SessionHandoffCard[];
};

export type HandoffReconcileReport = {
  orphansRemoved: string[];
  restored: string[];
  cleared: string[];
  badgesRepaired: string[];
};

/**
 * 启动时 Handoff 三方双向对账（`handoffStore <-> 会话最后卡片 <-> awaiting 角标`）：
 * 1. `handoffStore` 有、但会话已不存在 → 清理孤儿 pending；
 * 2. `handoffStore` 无、但 `awaiting` 角标指向 handoff：检查最新一张交接卡（旧未解卡不算）：
 *    - 最新卡未解决 → 反向恢复入 `handoffStore`；
 *    - 最新卡已解决或无卡 → 清理残留虚假 `awaiting` 角标；
 * 3. `handoffStore` 有 pending（含刚恢复的）→ 若角标因前次回调失败被误清，重新补齐 handoff 角标，
 *    且绝不覆盖属于其他功能标签页的 awaiting 角标。
 */
export async function reconcileHandoffsOnStartup(options: {
  handoffStore: HandoffStore;
  listSessionIds: () => Promise<readonly string[]> | readonly string[];
  openSession: (
    sessionId: string,
  ) => Promise<SessionReconcileHandle | null> | SessionReconcileHandle | null;
  handoffTabId?: string;
  now?: () => number;
}): Promise<HandoffReconcileReport> {
  const tabId = options.handoffTabId ?? "handoff";
  const nowFn = options.now ?? Date.now;
  const sessionIds = new Set(await options.listSessionIds());

  const orphansRemoved: string[] = [];
  const restored: string[] = [];
  const cleared: string[] = [];
  const badgesRepaired: string[] = [];

  for (const existingSessionId of options.handoffStore.keys()) {
    if (!sessionIds.has(existingSessionId)) {
      options.handoffStore.forget(existingSessionId);
      orphansRemoved.push(existingSessionId);
    }
  }

  for (const sessionId of sessionIds) {
    const session = await options.openSession(sessionId);
    if (!session) {
      if (options.handoffStore.forget(sessionId)) {
        orphansRemoved.push(sessionId);
      }
      continue;
    }

    const awaiting = session.getAwaitingBadge();
    let pending = options.handoffStore.get(sessionId);

    if (pending === null && awaiting?.tabId === tabId) {
      const cards = session.getHandoffCards();
      const latest = cards.length > 0 ? cards[cards.length - 1] : undefined;
      if (
        latest &&
        (latest.resolution === null || latest.resolution === undefined)
      ) {
        pending = {
          requestId: latest.requestId,
          instruction: latest.instruction ?? awaiting.reason,
          tabId,
        };
        options.handoffStore.restore(sessionId, pending);
        restored.push(sessionId);
      } else {
        session.setAwaitingBadgeForTab(tabId, null);
        cleared.push(sessionId);
      }
    }

    if (pending !== null) {
      const cards = session.getHandoffCards();
      const latest = cards.length > 0 ? cards[cards.length - 1] : undefined;
      if (
        latest &&
        latest.resolution !== null &&
        latest.resolution !== undefined
      ) {
        // 会话最新交接卡已解决但 handoffStore 残留旧 pending → 清理 pending 与 handoff 角标，绝不复活幽灵角标。
        options.handoffStore.forget(sessionId);
        pending = null;
        if (awaiting?.tabId === tabId) {
          session.setAwaitingBadgeForTab(tabId, null);
        }
        cleared.push(sessionId);
      }
    }

    if (pending !== null) {
      // 仅当目前没有角标或角标本来就属于 handoff 标签页时修复，绝不覆盖其他功能的角标。
      if (awaiting === null || awaiting.tabId === tabId) {
        const needsRepair =
          awaiting === null || awaiting.reason !== pending.instruction;
        session.setAwaitingBadgeForTab(tabId, {
          tabId,
          reason: pending.instruction,
          since: awaiting?.tabId === tabId ? awaiting.since : nowFn(),
        });
        if (needsRepair) {
          badgesRepaired.push(sessionId);
        }
      }
    }
  }

  return {
    orphansRemoved,
    restored,
    cleared,
    badgesRepaired,
  };
}
