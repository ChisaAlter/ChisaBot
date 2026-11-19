"use strict";
/**
 * 4 MiB 分块流式原子下载 + `nativeImage` 零网络本地草稿缩略图辅助。
 *
 * 原子写保证：
 * - 临时文件始终命名为 `${dest}.${process.pid}.${randomUUID()}.tmp`；
 * - 独占创建（`wx`），逐块校验长度/总大小（与可选 SHA-256），完成后 `fsync` + `close` + 原子 `rename`；
 * - 任何失败、取消或中途变更均在 `finally` 清理临时文件，不留残缺产物。
 */
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_LOCAL_PREVIEW_BYTES = 25 * 1024 * 1024;
const DEFAULT_THUMB_MAX_DIM = 360;

function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function normalizePathSlashes(rawPath) {
  return String(rawPath || "")
    .split(path.sep)
    .join("/")
    .split("\\")
    .join("/");
}

function normalizeBoundaryPath(rawPath) {
  const slashed = normalizePathSlashes(rawPath).replace(/\/+$/g, "") || "/";
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

async function resolveDeepestExistingPath(targetPath) {
  const pending = [];
  let cursor = path.resolve(targetPath);
  for (;;) {
    try {
      const real = await fsp.realpath(cursor);
      return pending.length ? path.join(real, ...pending.reverse()) : real;
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return path.resolve(targetPath);
      }
      pending.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertWithinAllowedRoots(resolvedDest, allowedRoots) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new Error("下载根目录白名单 allowedRoots 不能为空。");
  }
  const resolvedRoots = (
    await Promise.all(
      allowedRoots.map(async (root) => {
        const trimmed = typeof root === "string" ? root.trim() : "";
        if (!trimmed) return null;
        try {
          const real = await fsp.realpath(trimmed);
          return normalizeBoundaryPath(real);
        } catch {
          return null;
        }
      }),
    )
  ).filter((value) => typeof value === "string" && value.length > 0);
  if (resolvedRoots.length === 0) {
    throw new Error("下载根目录白名单均无法解析，已拒绝写入（fail-closed）。");
  }
  const destLstat = await fsp.lstat(resolvedDest).catch(() => null);
  if (destLstat?.isSymbolicLink()) {
    throw new Error("下载目标不能是符号链接，已拒绝覆盖。");
  }
  const parentResolved = await resolveDeepestExistingPath(
    path.dirname(resolvedDest),
  );
  const candidate = normalizeBoundaryPath(
    path.join(parentResolved, path.basename(resolvedDest)),
  );
  const allowed = resolvedRoots.some(
    (base) =>
      candidate === base ||
      candidate.startsWith(base === "/" ? "/" : `${base}/`),
  );
  if (!allowed) {
    throw new Error("下载目标路径超出允许根目录范围（可能存在符号链接越界）。");
  }
  return resolvedRoots;
}

/** 构造唯一原子下载临时文件路径：`${dest}.${pid}.${uuid}.tmp`。 */
function makeAtomicTempPath(
  destPath,
  pid = process.pid,
  uuid = crypto.randomUUID(),
) {
  const clean = String(destPath || "").trim();
  if (!clean || hasControlChar(clean)) {
    throw new Error("目标下载路径无效。");
  }
  return `${clean}.${Math.trunc(pid)}.${uuid}.tmp`;
}

/**
 * 分块流式原子下载。
 *
 * @param {object} options
 * @param {string} options.destPath 最终保存路径
 * @param {number} options.totalSize 文件总字节数
 * @param {number} [options.chunkSize] 单块大小（默认 4 MiB）
 * @param {(input: { offset: number, length: number, index: number, signal?: AbortSignal }) => Promise<Buffer|Uint8Array|{ bytes: Buffer|Uint8Array, totalSize?: number }>} options.readChunk
 * @param {string} [options.expectedSha256] 可选预期 SHA-256（十六进制）
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { bytesWritten: number, totalSize: number, fraction: number }) => void} [options.onProgress]
 */
async function atomicChunkedDownload({
  destPath,
  totalSize,
  chunkSize = CHUNK_BYTES,
  maxBytes = MAX_DOWNLOAD_BYTES,
  allowedRoots,
  readChunk,
  expectedSha256,
  signal,
  onProgress,
}) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_DOWNLOAD_BYTES
  ) {
    throw new Error(
      `下载大小上限必须在 1 字节到 ${MAX_DOWNLOAD_BYTES} 字节之间。`,
    );
  }
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new Error("下载文件大小无效。");
  }
  if (totalSize > maxBytes) {
    throw new Error(
      `下载文件体积（${totalSize} 字节）超过上限（${maxBytes} 字节）。`,
    );
  }
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0 ||
    chunkSize > CHUNK_BYTES
  ) {
    throw new Error(`分块大小必须在 1 字节到 ${CHUNK_BYTES} 字节之间。`);
  }
  if (typeof readChunk !== "function") {
    throw new Error("缺少分块读取器 readChunk。");
  }

  const trimmedDest = typeof destPath === "string" ? destPath.trim() : "";
  if (!trimmedDest || hasControlChar(trimmedDest)) {
    throw new Error("下载目标路径无效。");
  }
  const resolvedDest = path.resolve(trimmedDest);
  if (!resolvedDest || hasControlChar(resolvedDest)) {
    throw new Error("下载目标路径无效。");
  }
  let verifiedRoots = null;
  if (allowedRoots !== undefined) {
    verifiedRoots = await assertWithinAllowedRoots(resolvedDest, allowedRoots);
  }
  await fsp.mkdir(path.dirname(resolvedDest), { recursive: true });
  if (verifiedRoots) {
    const realParent = normalizeBoundaryPath(
      await fsp.realpath(path.dirname(resolvedDest)),
    );
    const parentAllowed = verifiedRoots.some(
      (base) =>
        realParent === base ||
        realParent.startsWith(base === "/" ? "/" : `${base}/`),
    );
    if (!parentAllowed) {
      throw new Error(
        "下载目标父目录超出允许根目录范围（可能存在符号链接越界）。",
      );
    }
  }

  const tempPath = makeAtomicTempPath(resolvedDest);
  const hash = crypto.createHash("sha256");
  let handle = null;
  let committed = false;

  try {
    handle = await fsp.open(tempPath, "wx", 0o600);
    let offset = 0;
    let index = 0;

    while (offset < totalSize) {
      signal?.throwIfAborted();
      const length = Math.min(chunkSize, totalSize - offset);
      const raw = await readChunk({ offset, length, index, signal });
      let bytes;
      if (raw instanceof Uint8Array) {
        bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      } else if (
        raw &&
        typeof raw === "object" &&
        raw.bytes instanceof Uint8Array
      ) {
        if (raw.totalSize !== undefined && raw.totalSize !== totalSize) {
          throw new Error("远端文件在下载过程中大小发生变化，已中止下载。");
        }
        bytes = Buffer.from(
          raw.bytes.buffer,
          raw.bytes.byteOffset,
          raw.bytes.byteLength,
        );
      } else {
        throw new Error("分块读取器返回了无效的字节数据。");
      }
      if (bytes.length === 0 || bytes.length > length) {
        throw new Error(
          `第 ${index} 块字节长度异常（收到 ${bytes.length}，期望 ≤ ${length}）。`,
        );
      }
      await handle.writeFile(bytes);
      hash.update(bytes);
      offset += bytes.length;
      index += 1;
      if (typeof onProgress === "function") {
        onProgress({
          bytesWritten: offset,
          totalSize,
          fraction: totalSize > 0 ? offset / totalSize : 1,
        });
      }
    }

    if (offset !== totalSize) {
      throw new Error(`下载不完整（已写入 ${offset}/${totalSize} 字节）。`);
    }

    const digest = hash.digest("hex");
    if (
      expectedSha256 &&
      digest !== String(expectedSha256).trim().toLowerCase()
    ) {
      throw new Error("下载文件 SHA-256 校验失败，已丢弃临时文件。");
    }

    await handle.sync();
    await handle.close();
    handle = null;

    signal?.throwIfAborted();
    await fsp.rename(tempPath, resolvedDest);
    committed = true;
    return {
      ok: true,
      destPath: resolvedDest,
      normalizedPath: normalizePathSlashes(resolvedDest),
      bytesWritten: offset,
      sha256: digest,
    };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (!committed) {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}

/**
 * 使用 Electron `nativeImage` 生成零网络本地草稿缩略图（不发起任何网络请求）。
 */
async function createLocalDraftThumbnail({
  filePath,
  buffer,
  maxWidth = DEFAULT_THUMB_MAX_DIM,
  maxHeight = DEFAULT_THUMB_MAX_DIM,
  nativeImage,
} = {}) {
  let imageApi = nativeImage;
  if (!imageApi) {
    try {
      imageApi = require("electron")?.nativeImage || null;
    } catch {
      imageApi = null;
    }
  }
  if (!imageApi || typeof imageApi.createFromBuffer !== "function") {
    return { ok: false, reason: "nativeImage_unavailable" };
  }

  let rawBuffer = buffer;
  if (!rawBuffer) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      return { ok: false, reason: "missing_source" };
    }
    let fileHandle = null;
    try {
      fileHandle = await fsp.open(filePath, "r");
      const stat = await fileHandle.stat();
      if (!stat.isFile()) {
        return { ok: false, reason: "file_not_found" };
      }
      if (stat.size === 0 || stat.size > MAX_LOCAL_PREVIEW_BYTES) {
        return { ok: false, reason: "file_size_out_of_range" };
      }
      rawBuffer = await fileHandle.readFile();
    } catch {
      return { ok: false, reason: "file_not_found" };
    } finally {
      if (fileHandle) await fileHandle.close().catch(() => {});
    }
  }

  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
  if (buf.length === 0 || buf.length > MAX_LOCAL_PREVIEW_BYTES) {
    return { ok: false, reason: "file_size_out_of_range" };
  }

  const image = imageApi.createFromBuffer(buf);
  if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) {
    return { ok: false, reason: "unsupported_or_invalid_image" };
  }
  const orig =
    typeof image.getSize === "function"
      ? image.getSize()
      : { width: 0, height: 0 };
  const targetW = Math.max(
    16,
    Math.min(2048, Number(maxWidth) || DEFAULT_THUMB_MAX_DIM),
  );
  const targetH = Math.max(
    16,
    Math.min(2048, Number(maxHeight) || DEFAULT_THUMB_MAX_DIM),
  );

  let outputImage = image;
  if (
    orig.width > 0 &&
    orig.height > 0 &&
    (orig.width > targetW || orig.height > targetH)
  ) {
    const scale = Math.min(targetW / orig.width, targetH / orig.height);
    const width = Math.max(1, Math.round(orig.width * scale));
    const height = Math.max(1, Math.round(orig.height * scale));
    outputImage = image.resize({ width, height, quality: "good" });
  }
  const finalSize =
    typeof outputImage.getSize === "function" ? outputImage.getSize() : orig;
  const dataUrl = outputImage.toDataURL();
  return {
    ok: true,
    dataUrl,
    width: finalSize.width,
    height: finalSize.height,
    originalWidth: orig.width,
    originalHeight: orig.height,
    byteLength: buf.length,
  };
}

module.exports = {
  CHUNK_BYTES,
  MAX_DOWNLOAD_BYTES,
  MAX_LOCAL_PREVIEW_BYTES,
  makeAtomicTempPath,
  atomicChunkedDownload,
  createLocalDraftThumbnail,
};
