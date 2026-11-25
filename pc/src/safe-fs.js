"use strict";
/**
 * PC 端统一安全文件系统原语（零外部依赖）：
 * - Windows 瞬态文件锁（EPERM / EBUSY / EACCES）重命名退避重试；
 * - 平台大小写归一的同路径异步串行锁队列（支持单路径与多路径死锁安全加锁）；
 * - 抗符号链接与 TOCTOU 的只读打开/读取（lstat + O_NOFOLLOW + fstat dev/ino 校验）；
 * - 抗 TOCTOU、独占临时文件、fsync、allowedRoots 复验与原子落盘写入；
 * - 非 Windows 敏感文件权限收敛（跳过符号链接）。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const SLEEP_WAIT_BUF = new Int32Array(new SharedArrayBuffer(4));

class SafeFsError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = "SafeFsError";
    this.code = code;
  }
}

function pathApi(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function foldPath(targetPath, platform = process.platform) {
  return platform === "win32" ? targetPath.toLowerCase() : targetPath;
}

function isWithinDir(targetPath, rootPath, platform = process.platform) {
  const P = pathApi(platform);
  const a = foldPath(P.resolve(targetPath), platform);
  const b = foldPath(P.resolve(rootPath), platform);
  return a === b || a.startsWith(b.endsWith(P.sep) ? b : `${b}${P.sep}`);
}

/**
 * 判断错误是否为 Windows 常见的瞬态重命名锁冲突（杀毒/索引/Explorer 占用）。
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientRenameError(err) {
  const code = err?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function computeRetryDelay(attempt, baseDelayMs, maxDelayMs, factor) {
  const raw = baseDelayMs * factor ** attempt;
  return Math.min(maxDelayMs, Math.max(0, Math.round(raw)));
}

function defaultSleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_WAIT_BUF, 0, 0, ms);
}

/**
 * 异步重命名，遇瞬态锁错误时按指数退避重试。
 * @param {string} from
 * @param {string} to
 * @param {{
 *   retries?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   factor?: number,
 *   isRetryable?: (err: unknown) => boolean,
 *   renameFn?: (from: string, to: string) => Promise<void>,
 *   sleepFn?: (ms: number) => Promise<void>
 * }} [opts]
 */
async function renameWithRetry(from, to, opts = {}) {
  const retries = Math.max(0, Math.trunc(opts.retries ?? 5));
  const baseDelayMs = Math.max(0, Number(opts.baseDelayMs ?? 20));
  const maxDelayMs = Math.max(baseDelayMs, Number(opts.maxDelayMs ?? 200));
  const factor = Math.max(1, Number(opts.factor ?? 2));
  const isRetryable = opts.isRetryable || isTransientRenameError;
  const renameFn = opts.renameFn || fsp.rename;
  const sleepFn = opts.sleepFn || defaultSleepAsync;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFn(from, to);
      return;
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) {
        throw err;
      }
      const delay = computeRetryDelay(attempt, baseDelayMs, maxDelayMs, factor);
      if (delay > 0) {
        await sleepFn(delay);
      }
    }
  }
}

/**
 * 同步重命名，遇瞬态锁错误时按指数退避重试（用于配置保存等同步路径）。
 * @param {string} from
 * @param {string} to
 * @param {{
 *   retries?: number,
 *   baseDelayMs?: number,
 *   maxDelayMs?: number,
 *   factor?: number,
 *   isRetryable?: (err: unknown) => boolean,
 *   renameSyncFn?: (from: string, to: string) => void,
 *   sleepSyncFn?: (ms: number) => void
 * }} [opts]
 */
function renameWithRetrySync(from, to, opts = {}) {
  const retries = Math.max(0, Math.trunc(opts.retries ?? 5));
  const baseDelayMs = Math.max(0, Number(opts.baseDelayMs ?? 15));
  const maxDelayMs = Math.max(baseDelayMs, Number(opts.maxDelayMs ?? 100));
  const factor = Math.max(1, Number(opts.factor ?? 2));
  const isRetryable = opts.isRetryable || isTransientRenameError;
  const renameSyncFn = opts.renameSyncFn || fs.renameSync;
  const sleepSyncFn = opts.sleepSyncFn || defaultSleepSync;

  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSyncFn(from, to);
      return;
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) {
        throw err;
      }
      const delay = computeRetryDelay(attempt, baseDelayMs, maxDelayMs, factor);
      if (delay > 0) {
        sleepSyncFn(delay);
      }
    }
  }
}

/**
 * 按平台大小写归一的同路径异步串行锁队列，防止并发写同一文件相互踩踏。
 * 支持 `run(path, fn)` 与按字典序加锁的 `runMany(paths, fn)` 以消除多文件死锁。
 * @param {string} [platform]
 */
function createPathLockQueue(platform = process.platform) {
  const P = pathApi(platform);
  const chains = new Map();

  function keyOf(filePath) {
    const resolved = P.resolve(String(filePath));
    return foldPath(resolved, platform);
  }

  function runKey(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const nextTail = prev.then(() => current);
    chains.set(key, nextTail);
    return prev
      .catch(() => {})
      .then(() => fn())
      .finally(() => {
        release();
        if (chains.get(key) === nextTail) {
          chains.delete(key);
        }
      });
  }

  function run(filePath, fn) {
    return runKey(keyOf(filePath), fn);
  }

  function runMany(filePaths, fn) {
    const keys = [...new Set(filePaths.filter(Boolean).map(keyOf))].sort();
    if (keys.length === 0) return Promise.resolve().then(fn);
    if (keys.length === 1) return runKey(keys[0], fn);
    const acquire = (index) => {
      if (index >= keys.length) return fn();
      return runKey(keys[index], () => acquire(index + 1));
    };
    return acquire(0);
  }

  return {
    keyOf,
    run,
    runMany,
    size: () => chains.size,
  };
}

const defaultLockQueue = createPathLockQueue(process.platform);

async function resolveAllowedRoots(allowedRoots, platform = process.platform) {
  const P = pathApi(platform);
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new SafeFsError(
      "允许的文件夹白名单不能为空，已拒绝操作。",
      "ERR_SAFE_FS_OUTSIDE_ROOTS",
    );
  }
  const resolved = [];
  for (const root of allowedRoots) {
    const trimmed = typeof root === "string" ? root.trim() : "";
    if (!trimmed) continue;
    try {
      const real = await fsp.realpath(P.resolve(trimmed));
      resolved.push(real);
    } catch {}
  }
  if (resolved.length === 0) {
    throw new SafeFsError(
      "允许的文件夹白名单均无法解析，已拒绝操作。",
      "ERR_SAFE_FS_OUTSIDE_ROOTS",
    );
  }
  return resolved;
}

async function resolveDeepestExistingRealpath(
  targetPath,
  platform = process.platform,
) {
  const P = pathApi(platform);
  let current = P.resolve(targetPath);
  const tail = [];
  for (;;) {
    try {
      const resolved = await fsp.realpath(current);
      return tail.length ? P.join(resolved, ...tail.reverse()) : resolved;
    } catch {
      const parent = P.dirname(current);
      if (parent === current) return P.resolve(targetPath);
      tail.push(P.basename(current));
      current = parent;
    }
  }
}

async function assertParentInRoots(
  targetFilePath,
  resolvedRoots,
  platform = process.platform,
) {
  const P = pathApi(platform);
  const parentReal = await resolveDeepestExistingRealpath(
    P.dirname(targetFilePath),
    platform,
  );
  const candidate = P.join(parentReal, P.basename(targetFilePath));
  const ok = resolvedRoots.some((root) =>
    isWithinDir(candidate, root, platform),
  );
  if (!ok) {
    throw new SafeFsError(
      `路径父目录超出允许的文件夹范围：${targetFilePath}`,
      "ERR_SAFE_FS_OUTSIDE_ROOTS",
    );
  }
  return parentReal;
}

function statsMatch(current, expected) {
  if (!current || !expected) return false;
  if (BigInt(current.dev) !== BigInt(expected.dev)) return false;
  if (BigInt(current.ino) !== BigInt(expected.ino)) return false;
  if (current.ctimeNs !== undefined && expected.ctimeNs !== undefined) {
    return BigInt(current.ctimeNs) === BigInt(expected.ctimeNs);
  }
  return Number(current.ctimeMs) === Number(expected.ctimeMs);
}

/**
 * 抗符号链接与 TOCTOU 的只读打开：`lstat` 拒符号链接 → `O_RDONLY | O_NOFOLLOW` 打开 → `fstat` 核对 `dev`/`ino` 与 `isFile()`。
 * @param {string} filePath
 * @param {{ allowedRoots?: string[], platform?: string }} [opts]
 * @returns {Promise<{ handle: import("node:fs/promises").FileHandle, stat: fs.BigIntStats, size: number }>}
 */
async function openFileNoFollow(filePath, opts = {}) {
  const platform = opts.platform || process.platform;
  const P = pathApi(platform);
  const resolvedRoots =
    opts.allowedRoots !== undefined
      ? await resolveAllowedRoots(opts.allowedRoots, platform)
      : null;

  if (resolvedRoots) {
    const parentReal = await fsp
      .realpath(P.dirname(filePath))
      .catch(() => null);
    if (
      !parentReal ||
      !resolvedRoots.some((root) =>
        isWithinDir(P.join(parentReal, P.basename(filePath)), root, platform),
      )
    ) {
      throw new SafeFsError(
        `路径超出允许的文件夹范围：${filePath}`,
        "ERR_SAFE_FS_OUTSIDE_ROOTS",
      );
    }
  }

  const before = await fsp.lstat(filePath, { bigint: true });
  if (before.isSymbolicLink()) {
    throw new SafeFsError(`拒绝打开符号链接文件：${filePath}`, "ELOOP");
  }
  if (!before.isFile()) {
    throw new SafeFsError(
      `目标不是普通文件：${filePath}`,
      before.isDirectory() ? "EISDIR" : "ERR_SAFE_FS_NOT_FILE",
    );
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(filePath, flags);
  try {
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      !after.isFile()
    ) {
      throw new SafeFsError(
        `文件在打开期间发生变动，已拒绝读取：${filePath}`,
        "ERR_SAFE_FS_TOCTOU",
      );
    }
    if (resolvedRoots) {
      const parentAfter = await fsp
        .realpath(P.dirname(filePath))
        .catch(() => null);
      if (
        !parentAfter ||
        !resolvedRoots.some((root) =>
          isWithinDir(
            P.join(parentAfter, P.basename(filePath)),
            root,
            platform,
          ),
        )
      ) {
        throw new SafeFsError(
          `路径父目录在打开期间超出允许范围：${filePath}`,
          "ERR_SAFE_FS_OUTSIDE_ROOTS",
        );
      }
    }
    return { handle, stat: after, size: Number(after.size) };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

/**
 * 安全读取文件（抗符号链接与 TOCTOU），支持字节上限截断并返回元信息。
 * @param {string} filePath
 * @param {{
 *   maxBytes?: number,
 *   maxFileSize?: number,
 *   encoding?: BufferEncoding,
 *   allowedRoots?: string[],
 *   platform?: string
 * }} [opts]
 */
async function readFileNoFollow(filePath, opts = {}) {
  const { handle, stat, size } = await openFileNoFollow(filePath, opts);
  try {
    if (Number.isFinite(opts.maxFileSize) && size > opts.maxFileSize) {
      throw new SafeFsError(
        `文件大小超出限制（${size} > ${opts.maxFileSize}）：${filePath}`,
        "ERR_SAFE_FS_TOO_LARGE",
      );
    }
    let buffer;
    let truncated = false;
    if (opts.maxBytes !== undefined && opts.maxBytes !== null) {
      const max = Math.max(0, Math.trunc(Number(opts.maxBytes)));
      const targetLen = Math.min(max, size);
      const raw = Buffer.alloc(targetLen);
      let offset = 0;
      while (offset < targetLen) {
        const { bytesRead } = await handle.read(
          raw,
          offset,
          targetLen - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      buffer = offset === targetLen ? raw : raw.subarray(0, offset);
      truncated = size > max;
    } else {
      buffer = await handle.readFile();
    }
    return {
      path: filePath,
      buffer,
      size,
      truncated,
      stat,
      ...(opts.encoding ? { content: buffer.toString(opts.encoding) } : {}),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeAllToHandle(handle, buf) {
  let offset = 0;
  while (offset < buf.length) {
    const { bytesWritten } = await handle.write(
      buf,
      offset,
      buf.length - offset,
    );
    if (bytesWritten <= 0) {
      throw new Error("写入临时文件时未推进字节数");
    }
    offset += bytesWritten;
  }
}

/**
 * 串行安全原子写：
 * 同路径串行队列 → `allowedRoots` 校验 → `wx` 独占临时文件 → 写前 `lstat` 拒符号链接与 `expectedStat` 防外部替换 →
 * 可选 `fsync` → `renameWithRetry` → `finally` 清理临时文件。
 *
 * @param {string} filePath
 * @param {string | Buffer | Uint8Array} data
 * @param {{
 *   lockQueue?: ReturnType<typeof createPathLockQueue> | null,
 *   allowedRoots?: string[],
 *   expectedStat?: fs.Stats | fs.BigIntStats | null,
 *   mustNotExist?: boolean,
 *   mode?: number,
 *   encoding?: BufferEncoding,
 *   fsync?: boolean,
 *   mkdir?: boolean,
 *   platform?: string,
 *   renameOpts?: object
 * }} [opts]
 */
async function writeFileAtomicSafe(filePath, data, opts = {}) {
  const platform = opts.platform || process.platform;
  const P = pathApi(platform);
  const resolvedTarget = P.resolve(String(filePath));
  const queue =
    opts.lockQueue === undefined ? defaultLockQueue : opts.lockQueue;

  const execute = async () => {
    const parentDir = P.dirname(resolvedTarget);
    const baseName = P.basename(resolvedTarget);
    const resolvedRoots =
      opts.allowedRoots !== undefined
        ? await resolveAllowedRoots(opts.allowedRoots, platform)
        : null;

    if (resolvedRoots) {
      await assertParentInRoots(resolvedTarget, resolvedRoots, platform);
    }
    if (opts.mkdir !== false) {
      await fsp.mkdir(parentDir, { recursive: true });
    }

    const realParent = await fsp.realpath(parentDir);
    if (resolvedRoots) {
      const ok = resolvedRoots.some((root) =>
        isWithinDir(P.join(realParent, baseName), root, platform),
      );
      if (!ok) {
        throw new SafeFsError(
          `目标父目录超出允许的文件夹范围：${resolvedTarget}`,
          "ERR_SAFE_FS_OUTSIDE_ROOTS",
        );
      }
    }

    const verifyTargetState = async () => {
      const cur = await fsp
        .lstat(resolvedTarget, { bigint: true })
        .catch((err) => {
          if (err?.code === "ENOENT") return null;
          throw err;
        });
      if (cur) {
        if (cur.isSymbolicLink()) {
          throw new SafeFsError(`拒绝覆盖符号链接：${resolvedTarget}`, "ELOOP");
        }
        if (!cur.isFile()) {
          throw new SafeFsError(
            `目标不是普通文件：${resolvedTarget}`,
            cur.isDirectory() ? "EISDIR" : "ERR_SAFE_FS_NOT_FILE",
          );
        }
        if (opts.mustNotExist) {
          throw new SafeFsError(`目标文件已存在：${resolvedTarget}`, "EEXIST");
        }
      }
      if (opts.expectedStat && (!cur || !statsMatch(cur, opts.expectedStat))) {
        throw new SafeFsError(
          `文件在写入前已被外部修改或替换：${resolvedTarget}`,
          "ERR_SAFE_FS_TOCTOU",
        );
      }
      return cur;
    };

    const initialStat = await verifyTargetState();
    const encoding = opts.encoding || "utf8";
    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(String(data ?? ""), encoding);

    const openMode =
      typeof opts.mode === "number"
        ? opts.mode
        : initialStat && platform !== "win32"
          ? Number(initialStat.mode) & 0o777
          : 0o666;

    const tmpPath = P.join(
      realParent,
      `${baseName}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let handle = null;
    let committed = false;

    try {
      handle = await fsp.open(tmpPath, "wx", openMode);
      await writeAllToHandle(handle, buf);
      if (typeof opts.mode === "number" && platform !== "win32") {
        await handle.chmod(opts.mode);
      }
      if (opts.fsync !== false) {
        await handle.sync();
      }
      await handle.close();
      handle = null;

      const parentBeforeRename = await fsp.realpath(parentDir);
      if (
        foldPath(parentBeforeRename, platform) !==
        foldPath(realParent, platform)
      ) {
        throw new SafeFsError(
          `目标父目录在写入期间发生变动：${resolvedTarget}`,
          "ERR_SAFE_FS_TOCTOU",
        );
      }
      await verifyTargetState();

      await renameWithRetry(tmpPath, resolvedTarget, opts.renameOpts);
      committed = true;
      const finalStat = await fsp
        .lstat(resolvedTarget, { bigint: true })
        .catch(() => null);
      return { path: resolvedTarget, bytes: buf.length, stat: finalStat };
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
      }
      if (!committed) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
      }
    }
  };

  return queue ? queue.run(resolvedTarget, execute) : execute();
}

/**
 * 非 Windows 下跳过符号链接，将敏感文件（或目录）权限收敛至指定模式（默认 `0o600`）。
 * @param {string} filePath
 * @param {number} [mode]
 * @param {{ platform?: string }} [opts]
 */
async function hardenFilePermissions(filePath, mode = 0o600, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === "win32") return { hardened: false, skipped: "win32" };
  let st;
  try {
    st = await fsp.lstat(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") return { hardened: false, skipped: "missing" };
    throw err;
  }
  if (st.isSymbolicLink()) return { hardened: false, skipped: "symlink" };
  if (!st.isFile() && !st.isDirectory()) {
    return { hardened: false, skipped: "unsupported" };
  }
  if ((st.mode & 0o777) === mode)
    return { hardened: false, skipped: "already" };
  await fsp.chmod(filePath, mode);
  return { hardened: true, mode };
}

/**
 * `hardenFilePermissions` 的同步版本。
 * @param {string} filePath
 * @param {number} [mode]
 * @param {{ platform?: string }} [opts]
 */
function hardenFilePermissionsSync(filePath, mode = 0o600, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === "win32") return { hardened: false, skipped: "win32" };
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") return { hardened: false, skipped: "missing" };
    throw err;
  }
  if (st.isSymbolicLink()) return { hardened: false, skipped: "symlink" };
  if (!st.isFile() && !st.isDirectory()) {
    return { hardened: false, skipped: "unsupported" };
  }
  if ((st.mode & 0o777) === mode)
    return { hardened: false, skipped: "already" };
  fs.chmodSync(filePath, mode);
  return { hardened: true, mode };
}

module.exports = {
  SafeFsError,
  isTransientRenameError,
  renameWithRetry,
  renameWithRetrySync,
  createPathLockQueue,
  resolveAllowedRoots,
  assertParentInRoots,
  openFileNoFollow,
  readFileNoFollow,
  writeFileAtomicSafe,
  hardenFilePermissions,
  hardenFilePermissionsSync,
  statsMatch,
};
