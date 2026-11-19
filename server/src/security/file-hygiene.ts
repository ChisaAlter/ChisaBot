import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 凭据与敏感状态文件安全卫生模块（Wave 10 §1.4 + §1.5）：
 *
 * 1. 读时强制校验：非 Windows 使用 `O_NOFOLLOW` 防符号链接穿越并验证 `(stat.mode & 0o777) === 0o600`
 *    （权限漂移即拒读，能及时发现备份/拷贝把 0600 弄丢成 0644）；Windows 下使用 `lstat` + 句柄 `stat`
 *    绑定 `(dev, ino)` 防 TOCTOU 替换并拒绝符号链接与非普通文件。
 * 2. 原子写强制使用唯一 tmp 名 `${filePath}.${process.pid}.${randomUUID()}.tmp` + `wx` 独占新建 + `fsync`
 *    + `rename`，并在任何异常路径自动清理残留 tmp，避免排空升级重叠窗口内双进程互踩固定 `.tmp`。
 */

export type SecretFileHygieneCode =
  | "SYMLINK"
  | "NOT_REGULAR_FILE"
  | "INSECURE_MODE"
  | "TOO_LARGE"
  | "IDENTITY_CHANGED"
  | "NOT_FOUND";

export class SecretFileHygieneError extends Error {
  constructor(
    readonly code: SecretFileHygieneCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretFileHygieneError";
  }
}

export type ReadSecretFileOptions = {
  /** 最大允许读取字节数，默认 64 KiB。 */
  maxBytes?: number;
  /** 期望的 POSIX 权限位，默认严格要求 0o600。 */
  requiredMode?: number;
  /** 可选覆盖平台判定（仅用于跨平台策略测试）。 */
  platform?: NodeJS.Platform;
  /** 可选校验模拟权限位（在 Windows 上无法通过 chmod 构造 POSIX 位时用于单测验证）。 */
  overrideModeForCheck?: number;
};

export type AtomicWriteOptions = {
  /** 文件权限位，默认 0o600。 */
  mode?: number;
  /** 父目录创建权限位，默认 0o700。 */
  dirMode?: number;
  /** 写入并 rename 后是否尝试 fsync 父目录（非 Windows 默认 true）。 */
  syncDir?: boolean;
};

const DEFAULT_MAX_SECRET_BYTES = 64 * 1024;
const STRICT_SECRET_MODE = 0o600;

function errorCodeOf(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

/** 生成进程与调用双唯一的原子写临时路径，彻底杜绝固定 `.tmp` 并发互相截断。 */
export function uniqueTempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

/**
 * 校验 POSIX 权限位是否严格等于期望值（默认 0o600）。
 * 暴露为纯函数以便跨平台测试与复用。
 */
export function assertStrictFileMode(
  mode: number | bigint,
  requiredMode: number = STRICT_SECRET_MODE,
): void {
  const actual = Number(BigInt(mode) & 0o777n);
  if (actual !== requiredMode) {
    const octActual = actual.toString(8).padStart(4, "0");
    const octRequired = requiredMode.toString(8).padStart(4, "0");
    throw new SecretFileHygieneError(
      "INSECURE_MODE",
      `敏感凭据文件权限漂移（当前 ${octActual}，要求严格 ${octRequired}），已拒绝读取。`,
    );
  }
}

async function syncParentDirectory(dirPath: string): Promise<void> {
  if (process.platform === "win32") return;
  let dirHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    dirHandle = await open(dirPath, constants.O_RDONLY);
    await dirHandle.sync();
  } catch {
    // 部分虚拟文件系统不支持目录 fsync，忽略以免阻断正常落盘。
  } finally {
    await dirHandle?.close().catch(() => {});
  }
}

function syncParentDirectorySync(dirPath: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // 部分文件系统不支持目录 fsync。
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭错误。
      }
    }
  }
}

/**
 * 严格读取敏感凭据文件原始字节：
 * - 非 Windows：使用 `O_NOFOLLOW` 打开，并验证常规文件、大小上限与严格 `0600` 权限位；
 * - Windows：先 `lstat` 拒绝符号链接，打开后比对 `(dev, ino)` 防止竞态替换，并校验常规文件与大小上限。
 */
export async function readSecretFileStrictBytes(
  filePath: string,
  options: ReadSecretFileOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SECRET_BYTES;
  const requiredMode = options.requiredMode ?? STRICT_SECRET_MODE;
  const platform = options.platform ?? process.platform;
  const isWin = platform === "win32";

  let before: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") {
      throw new SecretFileHygieneError(
        "NOT_FOUND",
        `敏感凭据文件不存在：${filePath}`,
      );
    }
    throw error;
  }

  if (before.isSymbolicLink()) {
    throw new SecretFileHygieneError(
      "SYMLINK",
      "拒绝读取指向符号链接的敏感凭据文件。",
    );
  }
  if (!before.isFile()) {
    throw new SecretFileHygieneError(
      "NOT_REGULAR_FILE",
      "敏感凭据路径不是普通文件，已拒绝读取。",
    );
  }
  if (isWin && before.ino === 0n) {
    throw new SecretFileHygieneError(
      "NOT_REGULAR_FILE",
      "敏感凭据路径无法验证文件标识，已拒绝读取。",
    );
  }

  const openFlags =
    constants.O_RDONLY | (constants.O_NOFOLLOW ? constants.O_NOFOLLOW : 0);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, openFlags);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "ELOOP") {
      throw new SecretFileHygieneError(
        "SYMLINK",
        "O_NOFOLLOW 检测到符号链接，已拒绝读取敏感凭据文件。",
      );
    }
    if (code === "ENOENT") {
      throw new SecretFileHygieneError(
        "NOT_FOUND",
        `敏感凭据文件不存在：${filePath}`,
      );
    }
    throw error;
  }

  try {
    const info = await handle.stat({ bigint: true });
    if (before.dev !== info.dev || before.ino !== info.ino) {
      throw new SecretFileHygieneError(
        "IDENTITY_CHANGED",
        "打开敏感凭据文件期间路径指向发生变动，已拒绝读取。",
      );
    }
    if (!info.isFile()) {
      throw new SecretFileHygieneError(
        "NOT_REGULAR_FILE",
        "敏感凭据句柄不是普通文件，已拒绝读取。",
      );
    }
    if (options.overrideModeForCheck !== undefined) {
      assertStrictFileMode(options.overrideModeForCheck, requiredMode);
    } else if (!isWin) {
      assertStrictFileMode(info.mode, requiredMode);
    }
    if (info.size > BigInt(maxBytes)) {
      throw new SecretFileHygieneError(
        "TOO_LARGE",
        `敏感凭据文件超过大小上限（最大 ${maxBytes} 字节），已拒绝读取。`,
      );
    }
    const content = await handle.readFile();
    if (content.byteLength > maxBytes) {
      throw new SecretFileHygieneError(
        "TOO_LARGE",
        `敏感凭据文件超过大小上限（最大 ${maxBytes} 字节），已拒绝读取。`,
      );
    }
    return content;
  } finally {
    await handle.close();
  }
}

/** 严格读取 UTF-8 敏感凭据文本，内置 `0600` 与 `O_NOFOLLOW` 校验。 */
export async function readSecretFileStrict(
  filePath: string,
  options: ReadSecretFileOptions = {},
): Promise<string> {
  const bytes = await readSecretFileStrictBytes(filePath, options);
  return bytes.toString("utf8");
}

const WIN32_RENAME_RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameAtomically(
  tmpPath: string,
  filePath: string,
): Promise<void> {
  if (process.platform !== "win32") {
    await rename(tmpPath, filePath);
    return;
  }
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (error) {
      const code = errorCodeOf(error);
      if (
        !WIN32_RENAME_RETRYABLE_CODES.has(code) ||
        attempt === maxAttempts - 1
      ) {
        throw error;
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, 5 * (attempt + 1)),
      );
    }
  }
}

/**
 * 唯一 tmp 名原子写（异步）：
 * - 强制使用 `${filePath}.${process.pid}.${randomUUID()}.tmp`
 * - `wx` 独占创建（防预置 symlink / 并发撞名）
 * - `fsync` 落盘后再 `rename`
 * - 任何失败路径自动清理残留 tmp
 */
export async function atomicWriteFileUnique(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<string> {
  const mode = options.mode ?? STRICT_SECRET_MODE;
  const dirMode = options.dirMode ?? 0o700;
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: dirMode });

  const tmpPath = uniqueTempPathFor(filePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(tmpPath, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await renameAtomically(tmpPath, filePath);
    renamed = true;

    if (options.syncDir !== false) {
      await syncParentDirectory(dir);
    }
    return tmpPath;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (!renamed) {
      await unlink(tmpPath).catch((unlinkErr) => {
        if (errorCodeOf(unlinkErr) !== "ENOENT") {
          // 保留原始写失败，不覆盖主异常。
        }
      });
    }
    throw error;
  }
}

/**
 * 唯一 tmp 名原子写（同步版本），供系统更新队列等同步路径使用。
 */
export function atomicWriteFileUniqueSync(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): string {
  const mode = options.mode ?? STRICT_SECRET_MODE;
  const dirMode = options.dirMode ?? 0o700;
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: dirMode });

  const tmpPath = uniqueTempPathFor(filePath);
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(tmpPath, "wx", mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    renameSync(tmpPath, filePath);
    renamed = true;

    if (options.syncDir !== false) {
      syncParentDirectorySync(dir);
    }
    return tmpPath;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭失败。
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // 清理失败不覆盖主异常。
      }
    }
    throw error;
  }
}
