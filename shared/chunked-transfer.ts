/**
 * 4 MiB 分块流式上传 / 原子分块下载共享协议与纯逻辑校验。
 *
 * - 固定单块上限 `CHUNK_BYTES = 4 * 1024 * 1024`（4 MiB）；
 * - 普通大文件支持至 `MAX_STANDARD_FILE_BYTES`（25 MiB），视频与受支持大文件分块上限 `MAX_VIDEO_FILE_BYTES`（200 MiB）；
 * - 携带文件修改期指纹（`mtimeMs` + `size`），防上传半截文件被外部修改导致损坏或内容错位；
 * - 路径统一 `split(sep).join("/")` 规范化，杜绝 Windows 反斜杠路径穿越。
 */

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_STANDARD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_FILE_BYTES = 200 * 1024 * 1024;
export const CHUNKED_UPLOAD_TTL_MS = 30 * 60_000;

export const VIDEO_FILE_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "webm",
  "mkv",
  "avi",
  "m4v",
  "mpeg",
  "mpg",
  "ogv",
]);

export type FileFingerprint = {
  size: number;
  mtimeMs: number;
};

export type ChunkDescriptor = {
  index: number;
  offset: number;
  length: number;
};

export type ChunkPlan = {
  totalSize: number;
  chunkSize: number;
  totalChunks: number;
  chunks: ChunkDescriptor[];
};

export type ChunkedUploadInitRequest = {
  agentId: string;
  filename: string;
  mimeType?: string;
  totalSize: number;
  mtimeMs: number;
  chunkSize?: number;
  sha256?: string;
};

export type ChunkedUploadInitResponse = {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  totalSize: number;
  expiresAt: string;
};

export type ChunkedUploadChunkResponse = {
  uploadId: string;
  index: number;
  receivedBytes: number;
  receivedChunks: number;
  totalChunks: number;
};

export type ChunkedUploadCommitRequest = {
  mtimeMs?: number;
  size?: number;
  sha256?: string;
};

export type ChunkedDownloadMeta = {
  totalSize: number;
  chunkSize: number;
  filename: string;
  mimeType?: string;
  sha256?: string;
};

export class ChunkedTransferError extends Error {
  constructor(
    message: string,
    readonly code:
      | "INVALID_NAME"
      | "INVALID_SIZE"
      | "TOO_LARGE"
      | "FILE_MODIFIED"
      | "INVALID_CHUNK"
      | "INCOMPLETE"
      | "CHECKSUM_MISMATCH" = "INVALID_CHUNK",
  ) {
    super(message);
    this.name = "ChunkedTransferError";
  }
}

/** 跨平台路径规范化：将本机分隔符统一替换为 POSIX `/`（先拆再合，避免 Windows `\` 绕过正则）。 */
export function normalizeTransferPath(rawPath: string, sep = "\\"): string {
  const normalizedSep = sep === "/" ? "/" : sep;
  return String(rawPath ?? "")
    .split(normalizedSep)
    .join("/")
    .split("\\")
    .join("/");
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 校验并清洗上传文件名：禁止路径分隔符、控制字符、`..` 与空名。 */
export function sanitizeUploadFilename(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ChunkedTransferError("文件名必须是字符串。", "INVALID_NAME");
  }
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.length > 255 ||
    hasControlChar(trimmed) ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new ChunkedTransferError(
      "文件名无效（不能包含路径分隔符或控制字符）。",
      "INVALID_NAME",
    );
  }
  return trimmed;
}

/** 判断文件是否属于视频/大文件分块通道（200 MiB 上限）。 */
export function isLargeVideoFile(filename: string, mimeType?: string): boolean {
  const mime = String(mimeType ?? "")
    .trim()
    .toLowerCase();
  if (mime.startsWith("video/")) return true;
  const ext = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  return Boolean(ext && VIDEO_FILE_EXTENSIONS.has(ext));
}

/** 根据文件名与 MIME 计算允许的最大分块传输字节上限。 */
export function maxChunkedBytesForFile(
  filename: string,
  mimeType?: string,
): number {
  return isLargeVideoFile(filename, mimeType)
    ? MAX_VIDEO_FILE_BYTES
    : MAX_STANDARD_FILE_BYTES;
}

/** 计算 4 MiB 分块计划。 */
export function computeChunkPlan(
  totalSize: number,
  options: {
    chunkSize?: number;
    maxBytes?: number;
  } = {},
): ChunkPlan {
  const maxBytes = options.maxBytes ?? MAX_VIDEO_FILE_BYTES;
  const chunkSize = options.chunkSize ?? CHUNK_BYTES;
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    throw new ChunkedTransferError(
      "文件大小必须是大于 0 的安全整数。",
      "INVALID_SIZE",
    );
  }
  if (totalSize > maxBytes) {
    throw new ChunkedTransferError(
      `文件大小 ${totalSize} 字节超过分块上传上限 ${maxBytes} 字节。`,
      "TOO_LARGE",
    );
  }
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0 ||
    chunkSize > CHUNK_BYTES
  ) {
    throw new ChunkedTransferError(
      `分块大小必须在 1 字节至 ${CHUNK_BYTES} 字节之间。`,
      "INVALID_CHUNK",
    );
  }
  const totalChunks = Math.ceil(totalSize / chunkSize);
  const chunks: ChunkDescriptor[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const offset = index * chunkSize;
    const length = Math.min(chunkSize, totalSize - offset);
    chunks.push({ index, offset, length });
  }
  return {
    totalSize,
    chunkSize,
    totalChunks,
    chunks,
  };
}

/**
 * 校验文件修改期指纹（`mtimeMs` + `size`）是否在分块上传期间被外部改写。
 * 一旦发现大小或修改时间戳变化，立即拒绝并要求重新初始化上传会话。
 */
export function assertFileFingerprintUnchanged(
  expected: FileFingerprint,
  actual: FileFingerprint,
): void {
  if (
    !Number.isFinite(expected.size) ||
    !Number.isFinite(expected.mtimeMs) ||
    !Number.isFinite(actual.size) ||
    !Number.isFinite(actual.mtimeMs)
  ) {
    throw new ChunkedTransferError("文件指纹无效。", "FILE_MODIFIED");
  }
  if (expected.size !== actual.size || expected.mtimeMs !== actual.mtimeMs) {
    throw new ChunkedTransferError(
      `文件在上传过程中发生变更（预期 size=${expected.size}, mtimeMs=${expected.mtimeMs}；实际 size=${actual.size}, mtimeMs=${actual.mtimeMs}），已拒绝提交，请重新上传。`,
      "FILE_MODIFIED",
    );
  }
}

/** 生成原子临时下载文件名：`${dest}.${pid}.${uuid}.tmp`。 */
export function buildAtomicTempPath(
  destPath: string,
  pid: number,
  uuid: string,
): string {
  const cleanDest = String(destPath ?? "").trim();
  if (!cleanDest || hasControlChar(cleanDest)) {
    throw new ChunkedTransferError("目标文件路径无效。", "INVALID_NAME");
  }
  const safeUuid = String(uuid ?? "").replace(/[^a-zA-Z0-9-]/g, "");
  if (!safeUuid) {
    throw new ChunkedTransferError("临时文件 UUID 无效。", "INVALID_NAME");
  }
  return `${cleanDest}.${Math.trunc(pid)}.${safeUuid}.tmp`;
}
