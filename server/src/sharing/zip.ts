import { deflateRawSync, inflateRawSync } from "node:zlib";
import { SHARE_LIMITS } from "../../../shared/sharing";

/**
 * 纯内存有界 ZIP 编解码器（仅依赖 Node/Bun 内置 `node:zlib`，零第三方库、绝不落盘解压）。
 *
 * 安全约束：
 * - 单包最多 200 文件（MAX_ZIP_FILES）；
 * - 压缩包总字节上限 20 MiB（MAX_ZIP_ARCHIVE_BYTES）；
 * - 解压总字节上限 50 MiB（MAX_ZIP_UNCOMPRESSED_BYTES），防 zip-bomb；
 * - 严格路径规范化：反斜杠 `\` 规整为 `/`，拒绝绝对路径、Windows 盘符、`..`/`.` 穿越、控制字符、重复路径与文件/目录冲突；
 * - 拒绝符号链接、加密条目、重叠条目区间、ZIP64/分卷与本地/中央目录头不一致；
 * - 完整写入并强校验 IEEE 802.3 CRC-32。
 */

export const MAX_ZIP_FILES = SHARE_LIMITS.maxZipFiles;
export const MAX_ZIP_ARCHIVE_BYTES = SHARE_LIMITS.maxZipArchiveBytes;
export const MAX_ZIP_UNCOMPRESSED_BYTES = SHARE_LIMITS.maxZipUncompressedBytes;

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_UTF8 = 0x0800;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const ALLOWED_FLAGS_MASK = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
const UNIX_SYMLINK_MODE = 0xa000;
const UNIX_MODE_MASK = 0xf000;

export type ZipErrorCode =
  | "ZIP_INVALID"
  | "ZIP_TOO_LARGE"
  | "ZIP_TOO_MANY_FILES"
  | "ZIP_BOMB"
  | "ZIP_SLIP"
  | "ZIP_DUPLICATE_PATH"
  | "ZIP_CRC_MISMATCH"
  | "ZIP_UNSUPPORTED";

export class ZipFormatError extends Error {
  constructor(
    message: string,
    readonly code: ZipErrorCode = "ZIP_INVALID",
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
    this.name = "ZipFormatError";
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** 计算标准 IEEE 802.3 CRC-32（无符号 32 位整数）。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    const entry = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = entry ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 校验并规整 ZIP 条目路径：
 * - 将反斜杠 `\` 规整为 `/`；
 * - 拒绝控制字符（0x00–0x1F、0x7F）、冒号（含 Windows 盘符/ADS）、绝对路径、空段、`.` 与 `..`；
 * - 限制最大长度 240 字符。
 */
export function normalizeZipEntryPath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new ZipFormatError("ZIP 条目路径不能为空。", "ZIP_SLIP", 400);
  }
  if (rawPath.length > SHARE_LIMITS.maxPathLength) {
    throw new ZipFormatError("ZIP 条目路径过长。", "ZIP_SLIP", 400);
  }
  for (let i = 0; i < rawPath.length; i++) {
    const code = rawPath.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      throw new ZipFormatError(
        "ZIP 条目路径包含非法控制字符。",
        "ZIP_SLIP",
        400,
      );
    }
  }
  const normalized = rawPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.endsWith("/")) {
    throw new ZipFormatError(
      `ZIP 条目路径不合法（禁止绝对路径或目录项）：${rawPath}`,
      "ZIP_SLIP",
      400,
    );
  }
  if (normalized.includes(":")) {
    throw new ZipFormatError(
      `ZIP 条目路径包含非法盘符或冒号：${rawPath}`,
      "ZIP_SLIP",
      400,
    );
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new ZipFormatError(
        `ZIP 条目路径存在穿越或空段：${rawPath}`,
        "ZIP_SLIP",
        400,
      );
    }
  }
  return normalized;
}

function assertNoPathHierarchyConflicts(paths: Iterable<string>): void {
  const sorted = [...paths].sort();
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (cur && next?.startsWith(`${cur}/`)) {
      throw new ZipFormatError(
        `ZIP 路径存在文件与目录前缀冲突：${cur} 与 ${next}`,
        "ZIP_DUPLICATE_PATH",
        400,
      );
    }
  }
}

export type ZipEncodeOptions = {
  /** 是否优先使用 DEFLATE 压缩（默认 true；若压缩后不更小则自动降级为 STORE） */
  compress?: boolean;
};

/**
 * 纯内存编码 ZIP 字节流。
 * 键为相对路径，值为 Buffer / Uint8Array / UTF-8 字符串。
 */
export function encodeZip(
  files: Record<string, Uint8Array | Buffer | string>,
  options: ZipEncodeOptions = {},
): Buffer {
  const rawEntries = Object.entries(files);
  if (rawEntries.length === 0) {
    throw new ZipFormatError("ZIP 至少需要包含 1 个文件。", "ZIP_INVALID", 400);
  }
  if (rawEntries.length > MAX_ZIP_FILES) {
    throw new ZipFormatError(
      `ZIP 文件数量超出上限（最多 ${MAX_ZIP_FILES} 个）。`,
      "ZIP_TOO_MANY_FILES",
      413,
    );
  }

  const normalizedEntries: Array<{ name: string; content: Buffer }> = [];
  const seen = new Set<string>();
  let totalUncompressed = 0;

  for (const [rawName, rawValue] of rawEntries) {
    const name = normalizeZipEntryPath(rawName);
    if (seen.has(name)) {
      throw new ZipFormatError(
        `ZIP 存在重复条目路径：${name}`,
        "ZIP_DUPLICATE_PATH",
        400,
      );
    }
    seen.add(name);
    const content =
      typeof rawValue === "string"
        ? Buffer.from(rawValue, "utf8")
        : Buffer.from(rawValue);
    totalUncompressed += content.length;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throw new ZipFormatError(
        `ZIP 待打包文件总大小超出 ${Math.round(MAX_ZIP_UNCOMPRESSED_BYTES / (1024 * 1024))} MiB 上限。`,
        "ZIP_BOMB",
        413,
      );
    }
    normalizedEntries.push({ name, content });
  }
  assertNoPathHierarchyConflicts(seen);
  normalizedEntries.sort((a, b) => a.name.localeCompare(b.name));

  const useDeflate = options.compress !== false;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const { name, content } of normalizedEntries) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(content);
    let method = METHOD_STORE;
    let payload: Buffer = content;

    if (useDeflate && content.length > 0) {
      const deflated = deflateRawSync(content);
      if (deflated.length < content.length) {
        method = METHOD_DEFLATE;
        payload = deflated;
      }
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    localHeader.writeUInt16LE(20, 4); // version needed: 2.0
    localHeader.writeUInt16LE(FLAG_UTF8, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // version made by: Unix 2.0
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(FLAG_UTF8, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file 0644
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, nameBytes, payload);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(normalizedEntries.length, 8);
  eocd.writeUInt16LE(normalizedEntries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  const archive = Buffer.concat([...localParts, centralDir, eocd]);
  if (archive.length > MAX_ZIP_ARCHIVE_BYTES) {
    throw new ZipFormatError(
      `ZIP 压缩包体积超出 ${Math.round(MAX_ZIP_ARCHIVE_BYTES / (1024 * 1024))} MiB 上限。`,
      "ZIP_TOO_LARGE",
      413,
    );
  }
  return archive;
}

export type ZipDecodeLimits = {
  maxFiles?: number;
  maxArchiveBytes?: number;
  maxUncompressedBytes?: number;
};

/**
 * 纯内存解码并强校验 ZIP 字节流。
 * 返回无原型字典（规整后路径 -> 文件 Buffer）。
 */
export function decodeZip(
  input: Uint8Array | Buffer,
  limits: ZipDecodeLimits = {},
): Record<string, Buffer> {
  const maxFiles = limits.maxFiles ?? MAX_ZIP_FILES;
  const maxArchiveBytes = limits.maxArchiveBytes ?? MAX_ZIP_ARCHIVE_BYTES;
  const maxUncompressedBytes =
    limits.maxUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;

  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > maxArchiveBytes) {
    throw new ZipFormatError(
      `ZIP 压缩包体积超出 ${Math.round(maxArchiveBytes / (1024 * 1024))} MiB 上限。`,
      "ZIP_TOO_LARGE",
      413,
    );
  }
  if (bytes.length < 22) {
    throw new ZipFormatError(
      "无效的 ZIP 文件（长度不足）。",
      "ZIP_INVALID",
      400,
    );
  }

  // 查找 End of Central Directory（允许最长 65535 字节注释）
  let eocdOffset = -1;
  const minOffset = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (
      bytes.readUInt32LE(i) === EOCD_SIG &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new ZipFormatError(
      "无效的 ZIP 文件（缺少中央目录结束标记）。",
      "ZIP_INVALID",
      400,
    );
  }

  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const cdDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const cdSize = bytes.readUInt32LE(eocdOffset + 12);
  const cdOffset = bytes.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ZipFormatError(
      "不支持多分卷 ZIP 压缩包。",
      "ZIP_UNSUPPORTED",
      400,
    );
  }
  if (
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new ZipFormatError(
      "不支持 ZIP64 格式压缩包。",
      "ZIP_UNSUPPORTED",
      400,
    );
  }
  if (totalEntries === 0) {
    throw new ZipFormatError("ZIP 压缩包为空。", "ZIP_INVALID", 400);
  }
  if (totalEntries > maxFiles) {
    throw new ZipFormatError(
      `ZIP 文件数量（${totalEntries}）超出上限（最多 ${maxFiles} 个）。`,
      "ZIP_TOO_MANY_FILES",
      413,
    );
  }
  if (cdOffset + cdSize !== eocdOffset) {
    throw new ZipFormatError(
      "ZIP 中央目录偏移或长度损坏。",
      "ZIP_INVALID",
      400,
    );
  }

  const files: Record<string, Buffer> = Object.create(null);
  const seenPaths = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (
      cursor + 46 > eocdOffset ||
      bytes.readUInt32LE(cursor) !== CENTRAL_DIR_HEADER_SIG
    ) {
      throw new ZipFormatError("ZIP 中央目录条目损坏。", "ZIP_INVALID", 400);
    }

    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLen = bytes.readUInt16LE(cursor + 28);
    const extraLen = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const entryDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttrs = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);

    if (entryDisk !== 0) {
      throw new ZipFormatError(
        "不支持多分卷 ZIP 条目。",
        "ZIP_UNSUPPORTED",
        400,
      );
    }
    if ((flags & ~ALLOWED_FLAGS_MASK) !== 0) {
      throw new ZipFormatError(
        "不支持加密或含未知标志位的 ZIP 条目。",
        "ZIP_UNSUPPORTED",
        400,
      );
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new ZipFormatError(
        `不支持的 ZIP 压缩方式（method=${method}）。`,
        "ZIP_UNSUPPORTED",
        400,
      );
    }
    if (((externalAttrs >>> 16) & UNIX_MODE_MASK) === UNIX_SYMLINK_MODE) {
      throw new ZipFormatError(
        "安全拦截：ZIP 不允许包含符号链接。",
        "ZIP_SLIP",
        400,
      );
    }
    if (
      cursor + 46 + nameLen + extraLen + commentLen > eocdOffset ||
      localOffset + 30 > cdOffset
    ) {
      throw new ZipFormatError("ZIP 条目边界越界。", "ZIP_INVALID", 400);
    }

    // 预检解压体积，阻止标称尺寸即越界的 zip-bomb
    if (
      uncompressedSize > maxUncompressedBytes ||
      totalUncompressed + uncompressedSize > maxUncompressedBytes
    ) {
      throw new ZipFormatError(
        `ZIP 解压后总大小超出 ${Math.round(maxUncompressedBytes / (1024 * 1024))} MiB 上限，已拦截疑似压缩炸弹。`,
        "ZIP_BOMB",
        413,
      );
    }

    const rawName = bytes
      .subarray(cursor + 46, cursor + 46 + nameLen)
      .toString("utf8");
    const normalizedName = normalizeZipEntryPath(rawName);
    if (seenPaths.has(normalizedName)) {
      throw new ZipFormatError(
        `ZIP 包含重复条目路径：${normalizedName}`,
        "ZIP_DUPLICATE_PATH",
        400,
      );
    }

    // 校验本地文件头与中央目录头一致
    if (bytes.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIG) {
      throw new ZipFormatError("ZIP 本地文件头签名损坏。", "ZIP_INVALID", 400);
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLen = bytes.readUInt16LE(localOffset + 26);
    const localExtraLen = bytes.readUInt16LE(localOffset + 28);
    if (localFlags !== flags || localMethod !== method) {
      throw new ZipFormatError(
        "ZIP 本地头与中央目录标志不一致。",
        "ZIP_INVALID",
        400,
      );
    }
    if ((flags & FLAG_DATA_DESCRIPTOR) === 0) {
      const localCrc = bytes.readUInt32LE(localOffset + 14);
      const localCompressed = bytes.readUInt32LE(localOffset + 18);
      const localUncompressed = bytes.readUInt32LE(localOffset + 22);
      if (
        localCrc !== expectedCrc ||
        localCompressed !== compressedSize ||
        localUncompressed !== uncompressedSize
      ) {
        throw new ZipFormatError(
          "ZIP 本地头与中央目录校验和/尺寸不一致。",
          "ZIP_INVALID",
          400,
        );
      }
    }

    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) {
      throw new ZipFormatError("ZIP 条目数据越界。", "ZIP_INVALID", 400);
    }
    const localRawName = bytes
      .subarray(localOffset + 30, localOffset + 30 + localNameLen)
      .toString("utf8");
    if (localRawName !== rawName) {
      throw new ZipFormatError(
        "ZIP 本地头与中央目录文件名不一致。",
        "ZIP_INVALID",
        400,
      );
    }

    // 拦截重叠数据区间（防 overlap zip-bomb）
    for (const [start, end] of ranges) {
      if (localOffset < end && dataEnd > start) {
        throw new ZipFormatError(
          "安全拦截：ZIP 存在重叠条目数据区。",
          "ZIP_BOMB",
          400,
        );
      }
    }
    ranges.push([localOffset, dataEnd]);

    const compressedSlice = bytes.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (method === METHOD_STORE) {
      if (compressedSize !== uncompressedSize) {
        throw new ZipFormatError(
          "ZIP 非压缩条目长度不一致。",
          "ZIP_INVALID",
          400,
        );
      }
      content = Buffer.from(compressedSlice);
    } else {
      const remainingBudget = maxUncompressedBytes - totalUncompressed;
      const cap = Math.min(uncompressedSize, remainingBudget);
      try {
        // 多允许 1 字节用于精准识别“标称解压长度偏小但实际流更长”的伪装炸弹
        const inflated = inflateRawSync(compressedSlice, {
          maxOutputLength: Math.max(1, cap + 1),
        });
        if (inflated.length > remainingBudget) {
          throw new ZipFormatError(
            `ZIP 实际解压字节超出 ${Math.round(maxUncompressedBytes / (1024 * 1024))} MiB 上限，已拦截疑似压缩炸弹。`,
            "ZIP_BOMB",
            413,
          );
        }
        content = Buffer.from(inflated);
      } catch (error) {
        if (error instanceof ZipFormatError) throw error;
        const message =
          error instanceof Error ? error.message.toLowerCase() : "";
        if (
          message.includes("buffer") ||
          message.includes("length") ||
          message.includes("limit")
        ) {
          throw new ZipFormatError(
            "ZIP 实际解压大小超出声明或安全上限，已拦截疑似压缩炸弹。",
            "ZIP_BOMB",
            413,
          );
        }
        throw new ZipFormatError(
          "ZIP DEFLATE 解压失败（数据损坏）。",
          "ZIP_INVALID",
          400,
        );
      }
    }

    if (content.length !== uncompressedSize) {
      throw new ZipFormatError(
        `ZIP 条目「${normalizedName}」实际解压长度与头声明不符。`,
        "ZIP_BOMB",
        400,
      );
    }
    if (crc32(content) !== expectedCrc) {
      throw new ZipFormatError(
        `ZIP 条目「${normalizedName}」CRC-32 校验失败。`,
        "ZIP_CRC_MISMATCH",
        400,
      );
    }

    seenPaths.add(normalizedName);
    files[normalizedName] = content;
    totalUncompressed += content.length;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new ZipFormatError(
        `ZIP 解压总字节超出 ${Math.round(maxUncompressedBytes / (1024 * 1024))} MiB 上限。`,
        "ZIP_BOMB",
        413,
      );
    }

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  if (cursor !== eocdOffset) {
    throw new ZipFormatError(
      "ZIP 中央目录尾部存在未解析字节。",
      "ZIP_INVALID",
      400,
    );
  }
  assertNoPathHierarchyConflicts(seenPaths);
  return files;
}
