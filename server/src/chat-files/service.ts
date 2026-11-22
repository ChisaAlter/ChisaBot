import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { inflate, inflateRaw } from "node:zlib";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  CHAT_FILES_MARKER,
  type ChatFileKind,
  type ChatFileView,
  chatFileUrl,
  IMAGE_ASPECTS,
  IMAGE_PROVIDER_PRESETS,
  type ImageAspect,
  isInlineSafeMime,
  MAX_CHAT_FILE_BYTES,
} from "../../../shared/chat-files";
import {
  BlockedUrlError,
  guardedFetch,
} from "../../../shared/net/guarded-fetch";
import type { AuditInitiator } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { StoredAttachment } from "../channels/attachment-parts";
import type { Database } from "../db/client";
import { defaultRuntimeEnvironment } from "../config";
import { imageDimsFor } from "../image-dims";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import {
  type ImageProviderConfig,
  ImageProviderError,
  probeImageModel,
  runImageModel,
} from "./image-provider";
import { createMediaModels } from "./media-models";

/**
 * 聊天文件 + 图片生成（DESIGN.md §56，docs/chat-files.md）。
 *
 * 表（开机建，回滚安全）：
 * - chisabot_chat_files：用户上传的、机器人生成 / 修改的图片、机器人交给用户的工作区文件。字节在库里，
 *   按人隔离（owner_user_id），网址 /api/chat-files/<id> 只有本人能取；同时尽量写一份进机器人工作区。
 * - chisabot_image_settings：管理员选的图片模型（一行）。密钥 AES-GCM 加密；没填密钥时 MiniMax 可沿用
 *   部署环境变量（MINIMAX_API_KEY，或 OPENAI_BASE_URL 指向 minimax 时的 OPENAI_API_KEY）。
 *
 * 工具：image_generate / image_edit（只在图片设置打开且完整时给）、file_share、chat_files_recent。
 * 结果最后一行 `⟦chisabot:files⟧[…]` 给网页画卡；模型读到的是前面那句人话。
 */

type FileRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  kind: ChatFileKind;
  name: string;
  mime_type: string;
  size_bytes: number;
  bytes?: Uint8Array;
  workspace_path: string | null;
  prompt: string | null;
  model: string | null;
  source_id: string | null;
  created_at: Date | string;
};

export type ChatFilesWorkspace = {
  /** 把字节写进机器人工作区；返回是否写成。 */
  write: (
    owner: string,
    agentId: string,
    path: string,
    bytes: Buffer,
  ) => Promise<boolean>;
  /** 从机器人工作区读一个文件的字节；文件不在时抛错（错误信息给机器人看）。 */
  read: (
    owner: string,
    agentId: string,
    path: string,
  ) => Promise<{ bytes: Buffer; name: string }>;
};

export class ChatFilesError extends Error {}

const LIST_COLUMNS =
  "id, owner_user_id, agent_id, kind, name, mime_type, size_bytes, workspace_path, prompt, model, source_id, created_at";
const iso = (value: Date | string) => new Date(value).toISOString();

export function fileView(row: FileRow): ChatFileView {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    size: Number(row.size_bytes),
    kind: row.kind,
    url: chatFileUrl(row.id),
    workspacePath: row.workspace_path,
    ...(row.prompt ? { prompt: row.prompt } : {}),
    createdAt: iso(row.created_at),
  };
}

/** 只认真的位图（SVG 能带脚本，不当图片）。 */
/**
 * 每轮系统提示里关于「用户附的图片」的那一句，按 `imageInputFor` 的结果选（审查 M9-1）。
 * 必须和这一轮实际给模型的东西一致：给原图就说给了原图、直接看图；只给描述才说是描述。
 * 原来不管实际给什么都说「由识图模型转成文字描述给你」，模型就先去调 chat_files_recent 找图，或者干脆说没收到图。
 */
export const IMAGE_INPUT_GUIDANCE = {
  main: "用户在消息里附的图片会作为图片直接随这条消息给你，你看到的就是原图：直接看图回答，不要先调 chat_files_recent 或其他工具去找图片，也不要说没收到图片。",
  model:
    "当前聊天模型不能看图片，用户附的图片由识图模型转成文字描述给你（消息里写着【图片描述】）；描述里没有的细节用 image_inspect 追问，不要编。",
  none: "",
} as const;

/** 模型请求里文件部分的数据（字节、base64、data: 地址）→ 字节；外链地址不去拉。 */
function dataBytes(data: unknown): Buffer | null {
  if (data instanceof Uint8Array) return Buffer.from(data);
  const text =
    data instanceof URL ? data.href : typeof data === "string" ? data : null;
  if (text === null) return null;
  if (text.startsWith("data:")) {
    const comma = text.indexOf(",");
    return comma > 0 && text.slice(0, comma).endsWith(";base64")
      ? Buffer.from(text.slice(comma + 1), "base64")
      : null;
  }
  if (/^[a-z]+:\/\//i.test(text)) return null;
  return Buffer.from(text, "base64");
}

export function sniffImage(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

const EXT_MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  log: "text/plain",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
  aac: "audio/aac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/** 按字节判断；只有位图和 PDF 是看字节认的，其他按扩展名给个描述性类型（下载时一律当附件）。 */
export function detectMime(bytes: Uint8Array, name: string): string {
  const image = sniffImage(bytes);
  if (image) return image;
  if (
    bytes.length >= 5 &&
    String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-"
  )
    return "application/pdf";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

/** 文件名：去掉目录、控制字符和路径符号，最长 120。 */
export function safeName(raw: string, fallback = "文件"): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function slugOf(prompt: string) {
  const ascii = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return ascii || "image";
}

function stamp(now = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_CHUNK_OVERLAP = 150;
const SINGLE_CHUNK_INLINE_MAX_CHARS = 3000;
const PREVIEW_MAX_CHARS = 320;
const MAX_DOC_CHUNKS = 500;
const MAX_DOCX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 2000;
const MAX_DOCX_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PDF_STREAMS = 500;
const MAX_PDF_STREAM_IN_BYTES = 5 * 1024 * 1024;
const MAX_PDF_STREAM_OUT_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_DOC_CHARS = 2_000_000;
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function safeClip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, maxChars);
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  return text.slice(0, end);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function docxEntryPriority(rawName: string): number | null {
  const normalized = rawName
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
  if (normalized === "word/document.xml") return 0;
  if (/^word\/header\d*\.xml$/.test(normalized)) return 1;
  if (/^word\/footer\d*\.xml$/.test(normalized)) return 2;
  if (
    normalized === "word/footnotes.xml" ||
    normalized === "word/endnotes.xml"
  ) {
    return 3;
  }
  return null;
}

function decodeXmlEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/g,
    (full, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "nbsp":
          return " ";
        default: {
          const isHex = entity.startsWith("#x") || entity.startsWith("#X");
          const code = Number.parseInt(
            entity.slice(isHex ? 2 : 1),
            isHex ? 16 : 10,
          );
          if (
            !Number.isFinite(code) ||
            code <= 0 ||
            code > 0x10ffff ||
            (code >= 0xd800 && code <= 0xdfff)
          ) {
            return full;
          }
          return String.fromCodePoint(code);
        }
      }
    },
  );
}

function cleanWordXml(xml: string): string {
  const prepared = xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/gi, "")
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/gi, "")
    .replace(/<\/w:p>|<\/p>|<\/w:tr>|<\/tr>/gi, "\n")
    .replace(/<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>/gi, "\n")
    .replace(/<w:tab\b[^>]*\/?>|<\/w:tc>|<\/td>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  const decoded = decodeXmlEntities(prepared);
  return decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type ZipEntrySlice = {
  priority: number;
  name: string;
  method: number;
  data: Uint8Array;
};

function readZipEntriesFromCentralDirectory(
  bytes: Uint8Array,
): ZipEntrySlice[] | null {
  const minPos = Math.max(0, bytes.length - 65557);
  let eocdOffset = -1;
  for (let pos = bytes.length - 22; pos >= minPos; pos -= 1) {
    if (readUint32LE(bytes, pos) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const totalEntries = readUint16LE(bytes, eocdOffset + 10);
  const cdSize = readUint32LE(bytes, eocdOffset + 12);
  const cdOffset = readUint32LE(bytes, eocdOffset + 16);
  if (cdOffset >= bytes.length || cdOffset + cdSize > bytes.length) return null;

  const results: ZipEntrySlice[] = [];
  let pos = cdOffset;
  let seen = 0;
  const limit = Math.min(totalEntries, MAX_DOCX_ENTRIES);

  while (pos + 46 <= cdOffset + cdSize && seen < limit) {
    if (readUint32LE(bytes, pos) !== 0x02014b50) break;
    seen += 1;
    const method = readUint16LE(bytes, pos + 10);
    const compSize = readUint32LE(bytes, pos + 20);
    const uncompSize = readUint32LE(bytes, pos + 24);
    const nameLen = readUint16LE(bytes, pos + 28);
    const extraLen = readUint16LE(bytes, pos + 30);
    const commentLen = readUint16LE(bytes, pos + 32);
    const localOffset = readUint32LE(bytes, pos + 42);
    const nameStart = pos + 46;
    const nextPos = nameStart + nameLen + extraLen + commentLen;
    if (nextPos > bytes.length) break;

    const name = Buffer.from(
      bytes.subarray(nameStart, nameStart + nameLen),
    ).toString("utf8");
    const priority = docxEntryPriority(name);
    if (priority !== null && localOffset + 30 <= bytes.length) {
      if (readUint32LE(bytes, localOffset) === 0x04034b50) {
        const lNameLen = readUint16LE(bytes, localOffset + 26);
        const lExtraLen = readUint16LE(bytes, localOffset + 28);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const size = method === 0 && compSize === 0 ? uncompSize : compSize;
        if (
          size > 0 &&
          size <= MAX_DOCX_ENTRY_BYTES &&
          dataStart + size <= bytes.length
        ) {
          results.push({
            priority,
            name,
            method,
            data: bytes.subarray(dataStart, dataStart + size),
          });
        }
      }
    }
    pos = nextPos;
  }

  return results;
}

function readZipEntriesFromLocalHeaders(bytes: Uint8Array): ZipEntrySlice[] {
  const results: ZipEntrySlice[] = [];
  let pos = 0;
  let seen = 0;

  while (pos + 30 <= bytes.length && seen < MAX_DOCX_ENTRIES) {
    if (readUint32LE(bytes, pos) !== 0x04034b50) break;
    seen += 1;
    const flags = readUint16LE(bytes, pos + 6);
    const method = readUint16LE(bytes, pos + 8);
    const compSize = readUint32LE(bytes, pos + 18);
    const uncompSize = readUint32LE(bytes, pos + 22);
    const nameLen = readUint16LE(bytes, pos + 26);
    const extraLen = readUint16LE(bytes, pos + 28);
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (dataStart > bytes.length) break;

    const size = method === 0 && compSize === 0 ? uncompSize : compSize;
    if (size === 0 && (flags & 0x08) !== 0) break;
    if (dataStart + size > bytes.length) break;

    const name = Buffer.from(
      bytes.subarray(nameStart, nameStart + nameLen),
    ).toString("utf8");
    const priority = docxEntryPriority(name);
    if (priority !== null && size > 0 && size <= MAX_DOCX_ENTRY_BYTES) {
      results.push({
        priority,
        name,
        method,
        data: bytes.subarray(dataStart, dataStart + size),
      });
    }
    pos = dataStart + size;
  }

  return results;
}

const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);

/** 零依赖解析 DOCX（ZIP Local File Header / Central Directory + deflate）并清洗正文 XML。 */
export async function extractDocxText(buffer: Uint8Array): Promise<string> {
  if (!buffer || buffer.length < 30 || buffer.length > MAX_DOCX_ARCHIVE_BYTES) {
    return "";
  }
  try {
    const entries =
      readZipEntriesFromCentralDirectory(buffer) ??
      readZipEntriesFromLocalHeaders(buffer);
    if (entries.length === 0) return "";

    entries.sort((a, b) =>
      a.priority !== b.priority
        ? a.priority - b.priority
        : a.name.localeCompare(b.name),
    );

    const sections: string[] = [];
    let totalChars = 0;

    for (const entry of entries) {
      let xmlBytes: Uint8Array;
      try {
        if (entry.method === 0) {
          xmlBytes = entry.data;
        } else if (entry.method === 8) {
          xmlBytes = await inflateRawAsync(entry.data, {
            maxOutputLength: MAX_DOCX_ENTRY_BYTES,
          });
        } else {
          continue;
        }
      } catch {
        continue;
      }

      const xmlText = Buffer.from(xmlBytes).toString("utf8");
      const cleaned = cleanWordXml(xmlText);
      if (!cleaned) continue;

      const remaining = MAX_EXTRACTED_DOC_CHARS - totalChars;
      if (remaining <= 0) break;
      const piece =
        cleaned.length > remaining ? safeClip(cleaned, remaining) : cleaned;
      if (piece) {
        sections.push(piece);
        totalChars += piece.length;
      }
    }

    return sections.join("\n\n").trim();
  } catch {
    return "";
  }
}

function decodeUtf16Be(bytes: Uint8Array): string {
  const units: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    units.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  }
  return String.fromCharCode(...units);
}

function decodePdfBytesToText(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let raw: string;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    raw = decodeUtf16Be(bytes.subarray(2));
  } else {
    try {
      raw = utf8FatalDecoder.decode(bytes);
    } catch {
      raw = Buffer.from(bytes).toString("latin1");
    }
  }
  // 去掉无意义控制字符，仅保留常见空白符与可打印字符。
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function isPdfWhitespace(byte: number): boolean {
  return (
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0d ||
    byte === 0x0c ||
    byte === 0x00
  );
}

function isPdfDelimiter(byte: number): boolean {
  return (
    byte === 0x28 || // (
    byte === 0x29 || // )
    byte === 0x3c || // <
    byte === 0x3e || // >
    byte === 0x5b || // [
    byte === 0x5d || // ]
    byte === 0x7b || // {
    byte === 0x7d || // }
    byte === 0x2f || // /
    byte === 0x25 // %
  );
}

function readPdfLiteralString(
  bytes: Uint8Array,
  startPos: number,
): { text: string; nextPos: number } {
  const out: number[] = [];
  let pos = startPos + 1;
  let depth = 1;

  while (pos < bytes.length && depth > 0) {
    const ch = bytes[pos] ?? 0;
    if (ch === 0x5c) {
      // 反斜杠转义
      pos += 1;
      if (pos >= bytes.length) break;
      const esc = bytes[pos] ?? 0;
      if (esc === 0x6e) {
        out.push(0x0a);
        pos += 1;
      } else if (esc === 0x72) {
        out.push(0x0d);
        pos += 1;
      } else if (esc === 0x74) {
        out.push(0x09);
        pos += 1;
      } else if (esc === 0x62) {
        out.push(0x08);
        pos += 1;
      } else if (esc === 0x66) {
        out.push(0x0c);
        pos += 1;
      } else if (esc === 0x0d) {
        pos += 1;
        if (bytes[pos] === 0x0a) pos += 1;
      } else if (esc === 0x0a) {
        pos += 1;
      } else if (esc >= 0x30 && esc <= 0x37) {
        let octal = esc - 0x30;
        pos += 1;
        for (let k = 0; k < 2 && pos < bytes.length; k += 1) {
          const next = bytes[pos] ?? 0;
          if (next < 0x30 || next > 0x37) break;
          octal = (octal << 3) | (next - 0x30);
          pos += 1;
        }
        out.push(octal & 0xff);
      } else {
        out.push(esc);
        pos += 1;
      }
      continue;
    }
    if (ch === 0x28) {
      depth += 1;
      out.push(ch);
      pos += 1;
      continue;
    }
    if (ch === 0x29) {
      depth -= 1;
      if (depth > 0) out.push(ch);
      pos += 1;
      continue;
    }
    out.push(ch);
    pos += 1;
  }

  return {
    text: decodePdfBytesToText(Uint8Array.from(out)),
    nextPos: pos,
  };
}

function hexNibble(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

function readPdfHexString(
  bytes: Uint8Array,
  startPos: number,
): { text: string; nextPos: number } {
  const nibbles: number[] = [];
  let pos = startPos + 1;
  while (pos < bytes.length) {
    const ch = bytes[pos] ?? 0;
    pos += 1;
    if (ch === 0x3e) break; // >
    if (isPdfWhitespace(ch)) continue;
    const val = hexNibble(ch);
    if (val >= 0) nibbles.push(val);
  }
  if (nibbles.length % 2 === 1) nibbles.push(0);
  const raw = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < raw.length; i += 1) {
    raw[i] = ((nibbles[i * 2] ?? 0) << 4) | (nibbles[i * 2 + 1] ?? 0);
  }
  return {
    text: decodePdfBytesToText(raw),
    nextPos: pos,
  };
}

type PdfOperand =
  | { kind: "str"; text: string }
  | { kind: "num"; value: number }
  | {
      kind: "arr";
      items: ({ kind: "str"; text: string } | { kind: "num"; value: number })[];
    };

function extractTextFromContentStream(bytes: Uint8Array): string {
  const parts: string[] = [];
  let stack: PdfOperand[] = [];
  let inText = false;
  let inArray = false;
  let arrayItems: (
    | { kind: "str"; text: string }
    | { kind: "num"; value: number }
  )[] = [];
  let lastTmY: number | null = null;
  let pos = 0;

  const pushOperand = (op: PdfOperand) => {
    if (inArray && (op.kind === "str" || op.kind === "num")) {
      arrayItems.push(op);
      return;
    }
    stack.push(op);
    if (stack.length > 24) {
      stack = stack.slice(-16);
    }
  };

  while (pos < bytes.length) {
    const ch = bytes[pos] ?? 0;
    if (isPdfWhitespace(ch)) {
      pos += 1;
      continue;
    }
    if (ch === 0x25) {
      // PDF 注释 %... 到行尾
      while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) {
        pos += 1;
      }
      continue;
    }
    if (ch === 0x28) {
      const lit = readPdfLiteralString(bytes, pos);
      pushOperand({ kind: "str", text: lit.text });
      pos = lit.nextPos;
      continue;
    }
    if (ch === 0x3c) {
      if (bytes[pos + 1] === 0x3c) {
        pos += 2;
        continue;
      }
      const hex = readPdfHexString(bytes, pos);
      pushOperand({ kind: "str", text: hex.text });
      pos = hex.nextPos;
      continue;
    }
    if (ch === 0x3e && bytes[pos + 1] === 0x3e) {
      pos += 2;
      continue;
    }
    if (ch === 0x5b) {
      inArray = true;
      arrayItems = [];
      pos += 1;
      continue;
    }
    if (ch === 0x5d) {
      if (inArray) {
        inArray = false;
        pushOperand({ kind: "arr", items: arrayItems });
        arrayItems = [];
      }
      pos += 1;
      continue;
    }
    if (ch === 0x2f) {
      pos += 1;
      while (
        pos < bytes.length &&
        !isPdfWhitespace(bytes[pos] ?? 0) &&
        !isPdfDelimiter(bytes[pos] ?? 0)
      ) {
        pos += 1;
      }
      continue;
    }

    const tokenStart = pos;
    while (
      pos < bytes.length &&
      !isPdfWhitespace(bytes[pos] ?? 0) &&
      !isPdfDelimiter(bytes[pos] ?? 0)
    ) {
      pos += 1;
    }
    if (pos === tokenStart) {
      pos += 1;
      continue;
    }
    const token = Buffer.from(bytes.subarray(tokenStart, pos)).toString(
      "latin1",
    );
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) {
      const value = Number(token);
      if (Number.isFinite(value)) {
        pushOperand({ kind: "num", value });
      }
      continue;
    }

    if (token === "BT") {
      inText = true;
      lastTmY = null;
      stack = [];
      continue;
    }
    if (token === "ET") {
      if (inText && parts.length > 0 && parts[parts.length - 1] !== "\n") {
        parts.push("\n");
      }
      inText = false;
      lastTmY = null;
      stack = [];
      continue;
    }

    if (inText) {
      const top = stack[stack.length - 1];
      if (token === "Tj") {
        if (top?.kind === "str" && top.text) parts.push(top.text);
      } else if (token === "'" || token === '"') {
        if (top?.kind === "str" && top.text) {
          if (parts.length > 0 && parts[parts.length - 1] !== "\n") {
            parts.push("\n");
          }
          parts.push(top.text);
        }
      } else if (token === "TJ") {
        if (top?.kind === "arr") {
          for (const item of top.items) {
            if (item.kind === "str") {
              parts.push(item.text);
            } else if (item.kind === "num" && item.value <= -180) {
              const prev = parts[parts.length - 1];
              if (prev && !prev.endsWith(" ") && !prev.endsWith("\n")) {
                parts.push(" ");
              }
            }
          }
        }
      } else if (token === "T*") {
        if (parts.length > 0 && parts[parts.length - 1] !== "\n") {
          parts.push("\n");
        }
      } else if (token === "Td" || token === "TD") {
        const tx = stack[stack.length - 2];
        const ty = stack[stack.length - 1];
        if (ty?.kind === "num" && Math.abs(ty.value) > 0.5) {
          if (parts.length > 0 && parts[parts.length - 1] !== "\n") {
            parts.push("\n");
          }
        } else if (tx?.kind === "num" && tx.value > 1) {
          const prev = parts[parts.length - 1];
          if (prev && !prev.endsWith(" ") && !prev.endsWith("\n")) {
            parts.push(" ");
          }
        }
      } else if (token === "Tm" && stack.length >= 6) {
        const yOp = stack[stack.length - 1];
        if (yOp?.kind === "num") {
          if (lastTmY !== null && Math.abs(yOp.value - lastTmY) > 0.5) {
            if (parts.length > 0 && parts[parts.length - 1] !== "\n") {
              parts.push("\n");
            }
          }
          lastTmY = yOp.value;
        }
      }
    }

    stack = [];
  }

  return parts.join("");
}

function findPrecedingPdfDict(buf: Buffer, streamIdx: number): string {
  const minScan = Math.max(0, streamIdx - 4096);
  let depth = 0;
  let dictEnd = -1;
  let dictStart = -1;

  for (let pos = streamIdx - 1; pos > minScan; pos -= 1) {
    if (buf[pos] === 0x3e && buf[pos - 1] === 0x3e) {
      if (dictEnd < 0) dictEnd = pos + 1;
      depth += 1;
      pos -= 1;
      continue;
    }
    if (buf[pos] === 0x3c && buf[pos - 1] === 0x3c) {
      depth -= 1;
      if (depth <= 0 && dictEnd >= 0) {
        dictStart = pos - 1;
        break;
      }
      pos -= 1;
    }
  }

  if (dictStart >= 0 && dictEnd > dictStart) {
    return buf.subarray(dictStart, dictEnd).toString("latin1");
  }
  return "";
}

function isPdfStreamKeywordBoundary(byte: number | undefined): boolean {
  return (
    byte === undefined || isPdfWhitespace(byte) || byte === 0x3e // >
  );
}

/** 零依赖解析 PDF stream（含未压缩与 FlateDecode）内 BT...ET 的 Tj/TJ 文本，安全跳过损坏流。 */
export async function extractPdfText(buffer: Uint8Array): Promise<string> {
  if (!buffer || buffer.length < 8 || buffer.length > MAX_PDF_BYTES) {
    return "";
  }
  try {
    const buf = Buffer.isBuffer(buffer)
      ? buffer
      : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (buf.subarray(0, Math.min(buf.length, 1024)).indexOf("%PDF-") < 0) {
      return "";
    }

    const sections: string[] = [];
    let totalChars = 0;
    let pos = 0;
    let scannedStreams = 0;

    while (pos < buf.length && scannedStreams < MAX_PDF_STREAMS) {
      const idx = buf.indexOf("stream", pos);
      if (idx < 0) break;

      const beforeByte = idx > 0 ? buf[idx - 1] : undefined;
      if (!isPdfStreamKeywordBoundary(beforeByte)) {
        pos = idx + 6;
        continue;
      }

      const after0 = buf[idx + 6];
      const after1 = buf[idx + 7];
      let dataStart = -1;
      if (after0 === 0x0d && after1 === 0x0a) {
        dataStart = idx + 8;
      } else if (after0 === 0x0a || after0 === 0x0d) {
        dataStart = idx + 7;
      } else {
        pos = idx + 6;
        continue;
      }

      scannedStreams += 1;
      const dict = findPrecedingPdfDict(buf, idx);
      const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)\b/.exec(dict);
      const declaredLen = lengthMatch
        ? Number.parseInt(lengthMatch[1] ?? "", 10)
        : -1;

      let dataEnd = -1;
      let nextPos = -1;
      if (
        Number.isFinite(declaredLen) &&
        declaredLen >= 0 &&
        dataStart + declaredLen <= buf.length
      ) {
        const probeFrom = Math.max(dataStart, dataStart + declaredLen - 2);
        const probeTo = Math.min(buf.length, dataStart + declaredLen + 32);
        const relEnd = buf.subarray(probeFrom, probeTo).indexOf("endstream");
        if (relEnd >= 0) {
          dataEnd = dataStart + declaredLen;
          nextPos = probeFrom + relEnd + 9;
        }
      }

      if (dataEnd < 0) {
        const endIdx = buf.indexOf("endstream", dataStart);
        if (endIdx < 0) break;
        dataEnd = endIdx;
        if (
          dataEnd >= dataStart + 2 &&
          buf[dataEnd - 2] === 0x0d &&
          buf[dataEnd - 1] === 0x0a
        ) {
          dataEnd -= 2;
        } else if (
          dataEnd >= dataStart + 1 &&
          (buf[dataEnd - 1] === 0x0a || buf[dataEnd - 1] === 0x0d)
        ) {
          dataEnd -= 1;
        }
        nextPos = endIdx + 9;
      }

      pos = nextPos;
      if (
        dataEnd <= dataStart ||
        dataEnd - dataStart > MAX_PDF_STREAM_IN_BYTES
      ) {
        continue;
      }
      if (/\/(?:DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)\b/.test(dict)) {
        continue;
      }

      const slice = buf.subarray(dataStart, dataEnd);
      const isFlate =
        /\/Filter\b[\s\S]{0,200}(?:\/FlateDecode\b|\/Fl(?![A-Za-z]))/.test(
          dict,
        );

      let decoded: Uint8Array | null = null;
      if (isFlate) {
        try {
          decoded = await inflateAsync(slice, {
            maxOutputLength: MAX_PDF_STREAM_OUT_BYTES,
          });
        } catch {
          try {
            decoded = await inflateRawAsync(slice, {
              maxOutputLength: MAX_PDF_STREAM_OUT_BYTES,
            });
          } catch {
            decoded = null;
          }
        }
      } else {
        decoded = slice;
      }

      if (!decoded || decoded.length === 0) continue;
      const extracted = extractTextFromContentStream(decoded)
        .split(/\r?\n/)
        .map((line) => line.replace(/ {2,}/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (!extracted) continue;
      const remaining = MAX_EXTRACTED_DOC_CHARS - totalChars;
      if (remaining <= 0) break;
      const piece =
        extracted.length > remaining
          ? safeClip(extracted, remaining)
          : extracted;
      if (piece) {
        sections.push(piece);
        totalChars += piece.length;
      }
    }

    if (scannedStreams === 0) {
      const direct = extractTextFromContentStream(buf)
        .split(/\r?\n/)
        .map((line) => line.replace(/ {2,}/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (direct) sections.push(safeClip(direct, MAX_EXTRACTED_DOC_CHARS));
    }

    return sections.join("\n\n").trim();
  } catch {
    return "";
  }
}

/** 按段落与句子边界切分长文本，支持适当重叠并限制最大块数防膨胀。 */
export function chunkDocumentText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_CHUNK_OVERLAP,
): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const size = Math.max(
    1,
    Math.floor(Number.isFinite(chunkSize) ? chunkSize : DEFAULT_CHUNK_SIZE),
  );
  const ov = Math.min(
    Math.max(
      0,
      Math.floor(Number.isFinite(overlap) ? overlap : DEFAULT_CHUNK_OVERLAP),
    ),
    size - 1,
  );

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length && chunks.length < MAX_DOC_CHUNKS) {
    if (start > 0 && isLowSurrogate(normalized.charCodeAt(start))) {
      start += 1;
      if (start >= normalized.length) break;
    }

    let end = Math.min(normalized.length, start + size);
    if (end < normalized.length) {
      const minBreak = start + Math.floor(size * 0.7);
      if (minBreak > start && minBreak < end) {
        const window = normalized.slice(minBreak, end);
        const breakCandidates = [
          window.lastIndexOf("\n\n"),
          window.lastIndexOf("\n"),
          Math.max(
            window.lastIndexOf("。"),
            window.lastIndexOf("！"),
            window.lastIndexOf("？"),
            window.lastIndexOf(". "),
          ),
          window.lastIndexOf(" "),
        ];
        for (const rel of breakCandidates) {
          if (rel > 0) {
            end = minBreak + rel + 1;
            break;
          }
        }
      }
      if (end > start && isHighSurrogate(normalized.charCodeAt(end - 1))) {
        end -= 1;
      }
      if (end <= start) {
        end = Math.min(normalized.length, start + size);
      }
    }

    const piece = normalized.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= normalized.length) break;

    const nextStart = Math.max(start + 1, end - ov);
    start = nextStart;
  }

  return chunks;
}

const CHUNK_CJK_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CHUNK_CJK_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CHUNK_LATIN_WORD = /[a-z0-9][a-z0-9._@+-]*/g;

function tokenizeChunkQuery(query: string) {
  const phrase = query.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const terms = new Set<string>();
  const bigrams = new Set<string>();
  if (!phrase)
    return { phrase: "", terms: [] as string[], bigrams: [] as string[] };

  for (const word of phrase.match(CHUNK_LATIN_WORD) ?? []) {
    if (word.length >= 2 || !CHUNK_CJK_CHAR.test(phrase)) {
      terms.add(word);
    }
  }
  for (const run of phrase.match(CHUNK_CJK_RUN) ?? []) {
    terms.add(run);
    if (run.length === 1) {
      bigrams.add(run);
    } else {
      for (let i = 0; i + 1 < run.length; i += 1) {
        bigrams.add(run.slice(i, i + 2));
      }
    }
  }
  if (terms.size === 0 && bigrams.size === 0) {
    terms.add(phrase);
  }
  return { phrase, terms: [...terms], bigrams: [...bigrams] };
}

function scoreChunkText(
  content: string,
  tokens: { phrase: string; terms: string[]; bigrams: string[] },
): number {
  const hay = content.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (!hay || !tokens.phrase) return 0;

  let total = 0;
  if (hay.includes(tokens.phrase)) total += 10;

  let termHits = 0;
  for (const term of tokens.terms) {
    if (hay.includes(term)) termHits += 1;
  }
  if (tokens.terms.length > 0 && termHits > 0) {
    total += (termHits / tokens.terms.length) * 6;
  }

  let bigramHits = 0;
  for (const bg of tokens.bigrams) {
    if (hay.includes(bg)) bigramHits += 1;
  }
  if (tokens.bigrams.length > 0 && bigramHits > 0) {
    const ratio = bigramHits / tokens.bigrams.length;
    if (ratio >= 0.4 || termHits > 0) {
      total += ratio * 3;
    }
  }
  return total;
}

function isDocxFile(mimeType: string, name: string): boolean {
  return mimeType === DOCX_MIME || name.toLowerCase().endsWith(".docx");
}

function isPdfFile(mimeType: string, name: string): boolean {
  return mimeType === "application/pdf" || name.toLowerCase().endsWith(".pdf");
}

function isTextFile(mimeType: string, name: string): boolean {
  return (
    TEXT_TYPES.has(mimeType) || /\.(txt|md|markdown|csv|json|log)$/i.test(name)
  );
}

async function extractDocumentChunks(
  bytes: Uint8Array,
  mimeType: string,
  name: string,
): Promise<{ text: string; chunks: string[]; isStructuredDoc: boolean }> {
  if (isDocxFile(mimeType, name)) {
    const text = await extractDocxText(bytes);
    return {
      text,
      chunks: text ? chunkDocumentText(text) : [],
      isStructuredDoc: true,
    };
  }
  if (isPdfFile(mimeType, name)) {
    const text = await extractPdfText(bytes);
    return {
      text,
      chunks: text ? chunkDocumentText(text) : [],
      isStructuredDoc: true,
    };
  }
  if (isTextFile(mimeType, name)) {
    if (bytes.subarray(0, 8192).includes(0)) {
      return { text: "", chunks: [], isStructuredDoc: false };
    }
    const text = Buffer.from(bytes).toString("utf8").trim();
    const chunks =
      text.length > DEFAULT_CHUNK_SIZE ? chunkDocumentText(text) : [];
    return { text, chunks, isStructuredDoc: false };
  }
  return { text: "", chunks: [], isStructuredDoc: false };
}

export function createChatFiles(
  database: Database,
  options: {
    encryptionKey: string;
    fetch?: typeof fetch;
    ownsBot: (owner: string, agentId: string) => Promise<boolean>;
    workspace?: ChatFilesWorkspace;
    env?: Record<string, string | undefined>;
    /** 网址结果的下载；默认只许公网地址、最大 20MB。测试里换掉。 */
    download?: (url: string) => Promise<Buffer>;
    /** 这个机器人当前的聊天模型能不能看图（模型目录里的 input modalities）；不知道 = undefined。 */
    mainModelSupportsImages?: (
      agentId: string,
      modelId?: string,
    ) => Promise<boolean | undefined>;
    isAdmin?: (userId: string) => Promise<boolean>;
    assertPublic?: (url: string) => Promise<unknown>;
  },
) {
  const sql = database.$client;
  const doFetch = options.fetch ?? fetch;
  const env = options.env ?? defaultRuntimeEnvironment();
  const media = createMediaModels(database, {
    encryptionKey: options.encryptionKey,
    fetch: doFetch,
    env,
    ...(options.mainModelSupportsImages
      ? { mainModelSupportsImages: options.mainModelSupportsImages }
      : {}),
    ...(options.isAdmin ? { isAdmin: options.isAdmin } : {}),
    ...(options.assertPublic ? { assertPublic: options.assertPublic } : {}),
  });

  async function defaultDownload(url: string): Promise<Buffer> {
    // CR-P0-01：不许再用 assertPublicUrl + redirect:follow（公网 302 → 元数据会跟过去）。
    // guardedFetch 钉死 DNS、逐跳重验，超大截断。
    let response: Awaited<ReturnType<typeof guardedFetch>>;
    try {
      response = await guardedFetch(url, {
        maxBytes: MAX_CHAT_FILE_BYTES + 1,
        timeoutMs: 60_000,
      });
    } catch (error) {
      if (error instanceof BlockedUrlError)
        throw new ImageProviderError(error.message);
      throw error;
    }
    if (response.status >= 400)
      throw new ImageProviderError(`取图片失败（HTTP ${response.status}）。`);
    if (response.truncated || response.body.length > MAX_CHAT_FILE_BYTES)
      throw new ImageProviderError("图片太大。");
    return response.body;
  }
  const download = options.download ?? defaultDownload;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_chat_files (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        agent_id text NOT NULL,
        kind text NOT NULL,
        name text NOT NULL,
        mime_type text NOT NULL,
        size_bytes integer NOT NULL,
        bytes bytea NOT NULL,
        workspace_path text,
        prompt text,
        model text,
        source_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chisabot_chat_files_owner ON chisabot_chat_files (owner_user_id, agent_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS chisabot_image_settings (
        id text PRIMARY KEY DEFAULT 'default',
        enabled boolean NOT NULL DEFAULT false,
        provider text NOT NULL DEFAULT 'minimax',
        base_url text NOT NULL DEFAULT '',
        model text NOT NULL DEFAULT '',
        edit_model text NOT NULL DEFAULT '',
        api_key text,
        key_hint text NOT NULL DEFAULT '',
        updated_at timestamptz,
        updated_by text
      );
      CREATE TABLE IF NOT EXISTS chisabot_chat_file_chunks (
        file_id text NOT NULL,
        owner_user_id text NOT NULL,
        chunk_index integer NOT NULL,
        content text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (file_id, chunk_index)
      );
      CREATE INDEX IF NOT EXISTS chisabot_chat_file_chunks_owner_file ON chisabot_chat_file_chunks (owner_user_id, file_id);
    `);
  }

  // ------------------------------------------------------------------ 图片模型设置（生图 / 识图，media-models.ts）

  /** 管理员的生图默认（§56 原接口，保留给 /api/chat-files/settings/image 和旧测试）。 */
  const settingsView = () => media.imageDefaultView();
  const providerConfig = (override?: Partial<ImageProviderConfig>) =>
    media.imageDefaultConfig(override);
  const saveSettings = (actorId: string, raw: unknown) =>
    media.saveImageDefault(actorId, raw);
  async function testSettings(
    raw: unknown,
  ): Promise<{ ok: boolean; message: string }> {
    const input = z
      .object({
        provider: z.enum(["minimax", "openai"]).optional(),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
        apiKey: z.string().max(4000).optional(),
      })
      .passthrough()
      .parse(raw ?? {});
    const config = await providerConfig({
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    });
    if (!config)
      return {
        ok: false,
        message: "没有密钥：填一个密钥，或者在部署环境变量里配置。",
      };
    return probeImageModel(config, doFetch);
  }

  // ------------------------------------------------------------------ 文件

  async function indexDocumentChunks(
    fileId: string,
    owner: string,
    bytes: Buffer,
    mimeType: string,
    name: string,
  ): Promise<void> {
    const extracted = await extractDocumentChunks(bytes, mimeType, name);
    if (extracted.chunks.length === 0) return;
    try {
      for (let index = 0; index < extracted.chunks.length; index += 1) {
        const content = extracted.chunks[index];
        if (!content) continue;
        await sql.unsafe(
          `INSERT INTO chisabot_chat_file_chunks (file_id, owner_user_id, chunk_index, content)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (file_id, chunk_index) DO UPDATE SET content = EXCLUDED.content`,
          [fileId, owner, index, content],
        );
      }
    } catch {
      // 兼容缺少 chisabot_chat_file_chunks 表的精简测试桩数据库，不阻断文件上传落库。
    }
  }

  async function loadFileChunks(
    owner: string,
    fileId: string,
  ): Promise<string[]> {
    try {
      const rows = await sql.unsafe<{ chunk_index: number; content: string }[]>(
        `SELECT chunk_index, content
         FROM chisabot_chat_file_chunks
         WHERE file_id = $1 AND owner_user_id = $2
         ORDER BY chunk_index ASC`,
        [fileId, owner],
      );
      return rows
        .map((entry) => entry.content)
        .filter((text) => text.length > 0);
    } catch {
      return [];
    }
  }

  async function hasIndexedChunks(owner: string): Promise<boolean> {
    try {
      const rows = await sql.unsafe<{ ok: number }[]>(
        "SELECT 1 AS ok FROM chisabot_chat_file_chunks WHERE owner_user_id = $1 LIMIT 1",
        [owner],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async function store(
    owner: string,
    agentId: string,
    input: {
      kind: ChatFileKind;
      name: string;
      mimeType: string;
      bytes: Buffer;
      workspacePath?: string | null;
      prompt?: string | null;
      model?: string | null;
      sourceId?: string | null;
    },
  ): Promise<ChatFileView> {
    const id = randomUUID();
    const rows = await sql.unsafe<FileRow[]>(
      `INSERT INTO chisabot_chat_files (id, owner_user_id, agent_id, kind, name, mime_type, size_bytes, bytes, workspace_path, prompt, model, source_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${LIST_COLUMNS}`,
      [
        id,
        owner,
        agentId,
        input.kind,
        input.name,
        input.mimeType,
        input.bytes.length,
        input.bytes,
        input.workspacePath ?? null,
        input.prompt ?? null,
        input.model ?? null,
        input.sourceId ?? null,
      ],
    );
    const inserted = rows[0];
    if (!inserted) throw new Error(`写入对话文件记录后未返回行：${id}`);
    const view = fileView(inserted);
    if (input.mimeType.startsWith("image/")) {
      // 图片记下宽高，随工具结果的文件清单给网页（DESIGN.md §83.2）。
      const dims = await imageDimsFor(database).remember(
        `cf:${id}`,
        input.bytes,
      );
      return dims ? { ...view, width: dims.width, height: dims.height } : view;
    }
    if (input.kind === "upload" || input.kind === "shared") {
      await indexDocumentChunks(
        id,
        owner,
        input.bytes,
        input.mimeType,
        input.name,
      );
    }
    return view;
  }

  async function setWorkspacePath(id: string, path: string | null) {
    await sql.unsafe(
      "UPDATE chisabot_chat_files SET workspace_path = $2 WHERE id = $1",
      [id, path],
    );
  }

  async function row(
    owner: string,
    id: string,
    withBytes = false,
  ): Promise<FileRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const rows = await sql.unsafe<FileRow[]>(
      `SELECT ${LIST_COLUMNS}${withBytes ? ", bytes" : ""} FROM chisabot_chat_files WHERE id = $1 AND owner_user_id = $2`,
      [id, owner],
    );
    return rows[0] ?? null;
  }

  async function list(
    owner: string,
    agentId?: string,
    opts: { imagesOnly?: boolean; limit?: number; before?: string } = {},
  ): Promise<ChatFileView[]> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const beforeMs = opts.before ? Date.parse(opts.before) : Number.NaN;
    const beforeIso = Number.isFinite(beforeMs)
      ? new Date(beforeMs).toISOString()
      : null;
    const rows = beforeIso
      ? await sql.unsafe<FileRow[]>(
          `SELECT ${LIST_COLUMNS} FROM chisabot_chat_files WHERE owner_user_id = $1 ${agentId ? "AND agent_id = $2" : "AND $2::text IS NULL"} AND created_at < $3::timestamptz
       ${opts.imagesOnly ? "AND mime_type LIKE 'image/%' AND mime_type <> 'image/svg+xml'" : ""} ORDER BY created_at DESC LIMIT ${limit}`,
          [owner, agentId ?? null, beforeIso],
        )
      : await sql.unsafe<FileRow[]>(
          `SELECT ${LIST_COLUMNS} FROM chisabot_chat_files WHERE owner_user_id = $1 ${agentId ? "AND agent_id = $2" : "AND $2::text IS NULL"}
       ${opts.imagesOnly ? "AND mime_type LIKE 'image/%' AND mime_type <> 'image/svg+xml'" : ""} ORDER BY created_at DESC LIMIT ${limit}`,
          [owner, agentId ?? null],
        );
    return rows.map(fileView);
  }

  let threadInboxTablePresent = false;

  async function remove(owner: string, id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    const rows = await sql.begin(async (transaction) => {
      // Serialize staged cleanup with inbox admission's ownership transfer.
      await transaction.unsafe(
        "SELECT id FROM chisabot_chat_files WHERE id=$1 AND owner_user_id=$2 FOR UPDATE",
        [id, owner],
      );
      let inboxPresent = threadInboxTablePresent;
      if (!inboxPresent) {
        const [inbox] = await transaction.unsafe<{ present: boolean }[]>(
          "SELECT to_regclass('chisabot_thread_inbox') IS NOT NULL AS present",
        );
        inboxPresent = Boolean(inbox?.present);
        if (inboxPresent) threadInboxTablePresent = true;
      }
      if (inboxPresent) {
        const held = await transaction.unsafe(
          `SELECT 1 FROM chisabot_thread_inbox i,
          LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.message->'content')='array' THEN i.message->'content' ELSE '[]'::jsonb END) part
          WHERE i.owner_user_id=$1 AND i.status <> 'withdrawn'
          AND split_part(split_part(part->'source'->>'value', '?', 1), '#', 1)=$2 LIMIT 1`,
          [owner, chatFileUrl(id)],
        );
        if (held.length) return [];
      }
      return transaction.unsafe<{ id: string }[]>(
        "DELETE FROM chisabot_chat_files WHERE id = $1 AND owner_user_id = $2 RETURNING id",
        [id, owner],
      );
    });
    if (rows.length > 0) {
      await media.forgetDescriptions(id).catch(() => {});
      await sql
        .unsafe(
          "DELETE FROM chisabot_chat_file_chunks WHERE file_id = $1 AND owner_user_id = $2",
          [id, owner],
        )
        .catch(() => {});
    }
    return rows.length > 0;
  }

  /** 工作区里一个不和自己已有记录撞名的路径。 */
  async function freePath(
    owner: string,
    agentId: string,
    folder: string,
    name: string,
  ): Promise<string> {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 1; n < 50; n += 1) {
      const candidate = `${folder}/${n === 1 ? name : `${stem}-${n}${ext}`}`;
      const taken = await sql.unsafe<{ id: string }[]>(
        "SELECT id FROM chisabot_chat_files WHERE owner_user_id = $1 AND agent_id = $2 AND workspace_path = $3 LIMIT 1",
        [owner, agentId, candidate],
      );
      if (taken.length === 0) return candidate;
    }
    return `${folder}/${stem}-${randomUUID().slice(0, 6)}${ext}`;
  }

  async function intoWorkspace(
    owner: string,
    agentId: string,
    folder: string,
    name: string,
    bytes: Buffer,
  ): Promise<string | null> {
    if (!options.workspace) return null;
    try {
      const path = await freePath(owner, agentId, folder, name);
      return (await options.workspace.write(owner, agentId, path, bytes))
        ? path
        : null;
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "chat-files-workspace-write-failed",
          error: error instanceof Error ? error.name : "UnknownError",
          agentId,
        }),
      );
      return null;
    }
  }

  async function upload(
    owner: string,
    agentId: string,
    file: { name: string; bytes: Buffer },
  ): Promise<ChatFileView> {
    if (!(await options.ownsBot(owner, agentId)))
      throw new ChatFilesError("找不到这个机器人。");
    if (file.bytes.length === 0) throw new ChatFilesError("文件是空的。");
    if (file.bytes.length > MAX_CHAT_FILE_BYTES)
      throw new ChatFilesError(`文件超过 ${formatSize(MAX_CHAT_FILE_BYTES)}。`);
    const name = safeName(file.name);
    const mimeType = detectMime(file.bytes, name);
    const workspacePath = await intoWorkspace(
      owner,
      agentId,
      "uploads",
      name,
      file.bytes,
    );
    return store(owner, agentId, {
      kind: "upload",
      name,
      mimeType,
      bytes: file.bytes,
      workspacePath,
    });
  }

  /**
   * 图片怎么给主模型（DESIGN.md §59 识图模型，审查 M9-1 之后）：
   * - 主模型能看图（目录没说不能 = 能）：原图，不管有没有另配识图模型（识图模型只给 image_inspect 用）。
   * - 主模型看不了图、有识图模型：识图模型写详细描述 + OCR（按 `cacheId` + 模型缓存），把文字给主模型，
   *   并告诉它可以用 image_inspect 追问。识图失败就如实说明。
   * - 主模型看不了图又没有识图模型：给一句说明，让机器人请用户去配置。
   *
   * 聊天文件（`cf:`）和频道附件（`/api/attachments/<id>`）都走这里，两条路给模型的东西一致。
   * `inspectSource` 是 image_inspect 认得的写法；频道附件不在聊天文件表里，没有就不提 image_inspect。
   */
  async function imageForModel(
    owner: string,
    agentId: string,
    image: {
      cacheId: string;
      name: string;
      mimeType: string;
      bytes: Buffer;
      head: string;
      createdAt?: Date | string;
      inspectSource?: string;
    },
    /** 这一轮实际用的聊天模型；没给就按这一轮的选择找（media.imageInputFor）。 */
    modelId?: string,
  ): Promise<StoredAttachment> {
    const { name, bytes, head } = image;
    const input = await media
      .imageInputFor(owner, agentId, modelId)
      .catch(() => ({ kind: "main" }) as const);
    if (input.kind === "main") return { mimeType: image.mimeType, name, bytes };
    const note = (text: string): StoredAttachment => ({
      mimeType: "text/plain",
      name,
      bytes: Buffer.from(text),
    });
    if (input.kind === "none") {
      return note(
        `${head}。当前聊天模型不能看图片，也没有配置识图模型，所以你看不到图片内容。请告诉用户：在 设置 → 生图与识图（或管理员在 设置 → 模型 → 识图模型）里配置一个识图模型后再发。`,
      );
    }
    const ask = image.inspectSource
      ? `描述里没有的细节用 image_inspect（source 填 ${image.inspectSource}）去问，`
      : "描述里没有的细节如实说看不到，";
    const fresh =
      image.createdAt === undefined ||
      Date.now() - new Date(image.createdAt).getTime() <
        media.DESCRIBE_FRESH_MS;
    try {
      const text = await media.describe(
        image.cacheId,
        { bytes, mimeType: image.mimeType },
        input.config,
        { fresh },
      );
      if (text === null) {
        return note(
          image.inspectSource
            ? `${head}。这是较早的图片，没有现成的描述；需要它的内容时用 image_inspect（source 填 ${image.inspectSource}）提问。`
            : `${head}。这是较早的图片，没有现成的描述，你看不到它的内容；需要时请用户重新发一次。`,
        );
      }
      return note(
        `${head}。当前聊天模型不能看图片，下面是识图模型（${input.label}）对它的描述，按这个回答；${ask}不要编。\n\n【图片描述】\n${text}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知错误";
      console.error(
        JSON.stringify({
          type: "chat-files-describe-failed",
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return note(
        `${head}。识图模型没能读这张图（${reason.slice(0, 200)}），你看不到图片内容；如实告诉用户。`,
      );
    }
  }

  async function imageForTurn(
    owner: string,
    found: FileRow,
    bytes: Buffer,
    mimeType: string,
    where: string,
    modelId?: string,
  ): Promise<StoredAttachment> {
    return imageForModel(
      owner,
      found.agent_id,
      {
        cacheId: found.id,
        name: found.name,
        mimeType,
        bytes,
        head: `用户上传的图片「${found.name}」（${where}，文件 id：${found.id}）`,
        createdAt: found.created_at,
        inspectSource: "文件 id",
      },
      modelId,
    );
  }

  /**
   * 频道附件（`/api/attachments/<id>`）交给某个机器人的主模型之前过一遍：图片按 {@link imageForModel}，
   * 其他原样。主模型能看图时是原样返回（同一个对象），和改之前一样。
   */
  async function channelAttachmentForModel(
    owner: string,
    agentId: string,
    attachmentId: string,
    attachment: StoredAttachment,
    modelId?: string,
  ): Promise<StoredAttachment> {
    const image = sniffImage(attachment.bytes);
    if (!image) return attachment;
    const described = await imageForModel(
      owner,
      agentId,
      {
        cacheId: `att:${attachmentId}`,
        name: attachment.name,
        mimeType: image,
        bytes: attachment.bytes,
        head: `用户在这条消息里附的图片「${attachment.name}」`,
      },
      modelId,
    );
    return described.mimeType === "text/plain" ? described : attachment;
  }

  /**
   * 换到备用模型时（agents/model-fallback.ts）把这一次请求按备用模型改一遍（审查 #417）：备用模型能看图就原样；
   * 看不了就把请求里用户消息上的图片换成识图模型的描述（没配识图模型就换成一句如实的说明），系统提示里
   * 「图片直接随消息给你」那句也换成描述版。主模型那一次请求不经过这里。
   */
  async function promptForModel(
    owner: string,
    agentId: string,
    modelId: string,
    callOptions: unknown,
  ): Promise<unknown> {
    const options = callOptions as { prompt?: unknown } | null;
    if (!options || !Array.isArray(options.prompt)) return callOptions;
    const prompt = options.prompt as { role?: string; content?: unknown }[];
    const isImage = (
      part: unknown,
    ): part is {
      type: "file";
      mediaType: string;
      data: unknown;
      filename?: string;
    } =>
      !!part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "file" &&
      String((part as { mediaType?: unknown }).mediaType ?? "").startsWith(
        "image/",
      );
    if (
      !prompt.some(
        (m) =>
          m.role === "user" &&
          Array.isArray(m.content) &&
          m.content.some(isImage),
      )
    )
      return callOptions;
    const input = await media
      .imageInputFor(owner, agentId, modelId)
      .catch(() => ({ kind: "main" }) as const);
    if (input.kind === "main") return callOptions;
    const short = modelId.split("/").filter(Boolean).pop() || modelId;
    const textFor = async (part: {
      mediaType: string;
      data: unknown;
      filename?: string;
    }): Promise<string> => {
      const label = part.filename ? `图片「${part.filename}」` : "一张图片";
      if (input.kind === "none")
        return `[用户附了${label}。现在换用的备用模型 ${short} 不能看图片，也没有配置识图模型，你看不到它的内容；如实告诉用户。]`;
      const bytes = dataBytes(part.data);
      if (!bytes)
        return `[用户附了${label}，但没法交给识图模型，你看不到它的内容；如实告诉用户。]`;
      try {
        const text = await media.describeTransient(
          { bytes, mimeType: part.mediaType },
          input.config,
        );
        return `[用户附了${label}。现在换用的备用模型 ${short} 不能看图片，下面是识图模型（${input.label}）的描述，按它回答，描述里没有的不要编。]\n【图片描述】\n${text}`;
      } catch {
        console.error(
          JSON.stringify({ type: "fallback-image-describe-failed" }),
        );
        return `[用户附了${label}，识图模型没能读它，你看不到它的内容；如实告诉用户。]`;
      }
    };
    const next = await Promise.all(
      prompt.map(async (message) => {
        if (message.role === "system" && typeof message.content === "string") {
          return {
            ...message,
            content: message.content.replace(
              IMAGE_INPUT_GUIDANCE.main,
              IMAGE_INPUT_GUIDANCE[input.kind],
            ),
          };
        }
        if (
          message.role !== "user" ||
          !Array.isArray(message.content) ||
          !message.content.some(isImage)
        )
          return message;
        return {
          ...message,
          content: await Promise.all(
            message.content.map(async (part) =>
              isImage(part)
                ? { type: "text", text: await textFor(part) }
                : part,
            ),
          ),
        };
      }),
    );
    return { ...options, prompt: next };
  }

  /**
   * 模型读一个聊天文件（attachment-parts 的 `cf:` 引用）：图片给字节；小的文本给文字；
   * 其他（PDF、Office、压缩包…）给一句说明，告诉机器人文件在工作区哪里、可以怎么处理。
   */
  async function loadForTurn(
    owner: string,
    id: string,
    turn?: { agentId?: string; modelId?: string },
  ): Promise<StoredAttachment | null> {
    const found = await row(owner, id, true);
    if (!found?.bytes) return null;
    const bytes = Buffer.from(found.bytes);
    const where = found.workspace_path
      ? `已保存在你的工作区 ${found.workspace_path}`
      : "没能写进你的工作区";
    const image = sniffImage(bytes);
    // 这一轮的模型只在文件就是这个机器人的时候才算数；别的机器人的文件按它自己的模型走（和以前一样）。
    if (image)
      return imageForTurn(
        owner,
        found,
        bytes,
        image,
        where,
        turn?.agentId === found.agent_id ? turn.modelId : undefined,
      );

    if (found.mime_type.toLowerCase().startsWith("video/")) {
      return {
        mimeType: found.mime_type,
        name: found.name,
        bytes,
      };
    }

    const storedChunks = await loadFileChunks(owner, found.id);
    const fallbackExtracted =
      storedChunks.length === 0
        ? await extractDocumentChunks(bytes, found.mime_type, found.name)
        : null;
    const chunks =
      storedChunks.length > 0
        ? storedChunks
        : (fallbackExtracted?.chunks ?? []);

    if (chunks.length > 0) {
      const rawLength = chunks.reduce((sum, piece) => sum + piece.length, 0);
      const estimatedOverlap =
        Math.max(0, chunks.length - 1) * DEFAULT_CHUNK_OVERLAP;
      const totalChars =
        fallbackExtracted?.text.length ??
        Math.max(chunks[0]?.length ?? 0, rawLength - estimatedOverlap);

      if (chunks.length > 1 || totalChars > SINGLE_CHUNK_INLINE_MAX_CHARS) {
        const preview = safeClip(chunks[0] ?? "", PREVIEW_MAX_CHARS).trim();
        const summary = [
          `用户上传了文档「${found.name}」（${found.mime_type}，${formatSize(bytes.length)}），${where}。文件 id：${found.id}`,
          `文档摘要：正文共约 ${totalChars} 字，已分为 ${chunks.length} 块（由于篇幅较长未全量注入上下文）。`,
          preview
            ? `首段预览：\n${preview}${totalChars > preview.length ? "…" : ""}`
            : "",
          `请调用 chat_file_search 工具按关键词检索需要的内容（可传入 fileId="${found.id}" 与 query）。`,
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          mimeType: "text/plain",
          name: found.name,
          bytes: Buffer.from(summary),
        };
      }

      if (!TEXT_TYPES.has(found.mime_type)) {
        return {
          mimeType: "text/plain",
          name: found.name,
          bytes: Buffer.from(
            `用户上传了文档「${found.name}」（${found.mime_type}，${formatSize(bytes.length)}），${where}。文件 id：${found.id}\n\n【文档正文】\n${chunks[0] ?? ""}`,
          ),
        };
      }
    }

    if (TEXT_TYPES.has(found.mime_type) && bytes.length <= 512 * 1024) {
      return {
        mimeType: "text/plain",
        name: found.name,
        bytes: Buffer.concat([Buffer.from(`（${where}）\n\n`), bytes]),
      };
    }
    const hint =
      found.mime_type === "application/pdf"
        ? "要读内容用 computer_run_command：有 pdftotext 就用它，没有就用 strings / cat 看文字流。"
        : "要读内容用 computer_run_command 里合适的命令处理（unzip、strings 等）。";
    return {
      mimeType: "text/plain",
      name: found.name,
      bytes: Buffer.from(
        `用户上传了文件「${found.name}」（${found.mime_type}，${formatSize(bytes.length)}），${where}。${found.workspace_path ? hint : ""}文件 id：${found.id}`,
      ),
    };
  }

  // ------------------------------------------------------------------ 图片

  async function sourceImage(
    owner: string,
    agentId: string,
    source: string | undefined,
  ): Promise<{
    bytes: Buffer;
    mimeType: string;
    name: string;
    id: string | null;
  }> {
    const ref = source?.trim() ?? "";
    const id = ref.replace(/^.*\/api\/chat-files\//, "").replace(/[?#].*$/, "");
    if (/^[0-9a-f-]{36}$/i.test(id)) {
      const found = await row(owner, id, true);
      if (!found?.bytes)
        throw new ChatFilesError(
          "找不到这张图片（文件 id 不对，或者已经删了）。",
        );
      const bytes = Buffer.from(found.bytes);
      const mimeType = sniffImage(bytes);
      if (!mimeType)
        throw new ChatFilesError(
          `「${found.name}」不是 PNG / JPEG / GIF / WebP 图片。`,
        );
      return { bytes, mimeType, name: found.name, id: found.id };
    }
    if (ref) {
      if (!options.workspace)
        throw new ChatFilesError("这个部署没有工作区；请用文件 id 指定图片。");
      const file = await options.workspace.read(owner, agentId, ref);
      const mimeType = sniffImage(file.bytes);
      if (!mimeType)
        throw new ChatFilesError(`${ref} 不是 PNG / JPEG / GIF / WebP 图片。`);
      return { ...file, mimeType, id: null };
    }
    const [latest] = await list(owner, agentId, { imagesOnly: true, limit: 1 });
    if (!latest)
      throw new ChatFilesError(
        "还没有可以修改的图片：请用户先上传一张，或先用 image_generate 生成。",
      );
    return sourceImage(owner, agentId, latest.id);
  }

  async function makeImage(
    owner: string,
    agentId: string,
    input: {
      prompt: string;
      aspect: ImageAspect;
      edit?: boolean;
      source?: string;
    },
    signal?: AbortSignal,
  ): Promise<ChatFileView> {
    const chosen = await media.imageFor(owner);
    if (!chosen)
      throw new ChatFilesError(
        "图片生成没有打开：请管理员在 设置 → 模型 → 生图模型 里打开，或者在 设置 → 生图与识图 里填自己的生图模型。",
      );
    const config = chosen.config;
    const src = input.edit
      ? await sourceImage(owner, agentId, input.source)
      : null;
    const result = await runImageModel(
      config,
      {
        prompt: input.prompt,
        aspect: input.aspect,
        ...(src
          ? {
              input: {
                bytes: src.bytes,
                mimeType: src.mimeType,
                name: src.name,
              },
            }
          : {}),
      },
      { fetch: doFetch, download, ...(signal ? { signal } : {}) },
    );
    const mimeType = sniffImage(result.bytes);
    if (!mimeType) throw new ChatFilesError("图片模型返回的不是图片。");
    const name = `${stamp()}-${slugOf(input.prompt)}.${EXT_FOR_MIME[mimeType] ?? "png"}`;
    const workspacePath = await intoWorkspace(
      owner,
      agentId,
      "images",
      name,
      result.bytes,
    );
    return store(owner, agentId, {
      kind: src ? "edited" : "generated",
      name,
      mimeType,
      bytes: result.bytes,
      workspacePath,
      prompt: input.prompt,
      model: src ? config.editModel || config.model : config.model,
      sourceId: src?.id ?? null,
    });
  }

  async function share(
    owner: string,
    agentId: string,
    path: string,
    title?: string,
  ): Promise<ChatFileView> {
    if (!options.workspace) throw new ChatFilesError("这个部署没有工作区。");
    const file = await options.workspace.read(owner, agentId, path);
    if (file.bytes.length > MAX_CHAT_FILE_BYTES)
      throw new ChatFilesError(
        `文件超过 ${formatSize(MAX_CHAT_FILE_BYTES)}，不能交给用户。`,
      );
    const base = safeName(file.name || path.split("/").pop() || "文件");
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
    const name = title?.trim()
      ? safeName(
          title.trim().endsWith(ext) ? title.trim() : `${title.trim()}${ext}`,
        )
      : base;
    return store(owner, agentId, {
      kind: "shared",
      name,
      mimeType: detectMime(file.bytes, base),
      bytes: file.bytes,
      workspacePath: path,
    });
  }

  // ------------------------------------------------------------------ 机器人

  const withFiles = (text: string, files: ChatFileView[]) =>
    `${text}\n${CHAT_FILES_MARKER}${JSON.stringify(files.map(({ prompt: _p, ...rest }) => rest))}`;

  function describe(file: ChatFileView) {
    return `文件 id：${file.id}；${file.workspacePath ? `工作区路径：${file.workspacePath}` : "没有写进工作区"}；${formatSize(file.size)}`;
  }

  async function tools(
    owner: string,
    agentId: string,
    initiator?: AuditInitiator,
  ): Promise<GrantedTool[]> {
    void initiator;
    const tool = <T extends z.ZodType>(
      name: string,
      description: string,
      parameters: T,
      run: (input: z.infer<T>) => Promise<string>,
      effect?: "read" | "write",
    ): GrantedTool => ({
      name,
      ref: `chat-files/${name}`,
      ...(effect ? { effect } : {}),
      description,
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success)
          return `${REFUSAL_MARKER} ${name} 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
        try {
          return await run(parsed.data);
        } catch (error) {
          if (
            error instanceof ChatFilesError ||
            error instanceof ImageProviderError
          )
            return `${REFUSAL_MARKER} ${error.message}`;
          if (
            error instanceof Error &&
            /file|path|workspace|There is no|文件/i.test(error.message)
          )
            return `${REFUSAL_MARKER} ${error.message}`;
          throw error;
        }
      },
    });
    const out: GrantedTool[] = [];
    const images = await media.imageViewFor(owner).catch(() => null);
    if (images?.ready) {
      const aspect = z
        .enum(IMAGE_ASPECTS)
        .optional()
        .describe("画幅，默认 1:1");
      out.push(
        tool(
          "image_generate",
          "按文字描述生成一张图片。图片会自动显示在聊天里（可以点开看大图、下载），同时存进你的工作区 images/。不要再用 Markdown 贴图或贴链接。提示词写清主体、风格、构图。",
          z
            .object({
              prompt: z
                .string()
                .min(1)
                .max(2000)
                .describe("图片描述（中英文都可以）"),
              aspect_ratio: aspect,
            })
            .strict(),
          async (input) => {
            const file = await makeImage(owner, agentId, {
              prompt: input.prompt,
              aspect: input.aspect_ratio ?? "1:1",
            });
            return withFiles(
              `已生成 1 张图片，已经显示在聊天里，用户可以点开看大图、下载。不要再贴这张图或它的链接。${describe(file)}`,
              [file],
            );
          },
        ),
        tool(
          "image_edit",
          `按要求修改一张已有的图片（用户上传的、你生成的，或工作区里的图片），结果显示在聊天里并存进工作区 images/。不写 source 就改这个聊天里最近的一张图片。${images.provider === "minimax" ? IMAGE_PROVIDER_PRESETS.minimax.editNote : ""}`,
          z
            .object({
              prompt: z
                .string()
                .min(1)
                .max(2000)
                .describe("怎么改，或者修改后的样子"),
              source: z
                .string()
                .max(400)
                .optional()
                .describe(
                  "要改的图片：文件 id、/api/chat-files/… 网址，或工作区路径（如 uploads/a.png）；不写 = 最近一张",
                ),
              aspect_ratio: aspect,
            })
            .strict(),
          async (input) => {
            const file = await makeImage(owner, agentId, {
              prompt: input.prompt,
              aspect: input.aspect_ratio ?? "1:1",
              edit: true,
              ...(input.source ? { source: input.source } : {}),
            });
            return withFiles(
              `已改好，新图片已经显示在聊天里。不要再贴这张图或它的链接。${describe(file)}`,
              [file],
            );
          },
        ),
      );
    }
    if (options.workspace) {
      out.push(
        tool(
          "file_share",
          "把你工作区里的一个文件交给用户：聊天里会出现一张可以下载的文件卡（图片和 PDF 能预览）。做好报告、表格、压缩包、图片等要给用户时用它，不要贴工作区路径或 workspace.local 链接让用户自己找。",
          z
            .object({
              path: z
                .string()
                .min(1)
                .max(400)
                .describe("工作区里的相对路径，如 report.pdf"),
              title: z
                .string()
                .max(80)
                .optional()
                .describe("给用户看的文件名（可选）"),
            })
            .strict(),
          async (input) => {
            const file = await share(
              owner,
              agentId,
              input.path.trim(),
              input.title,
            );
            return withFiles(
              `已把「${file.name}」交给用户（聊天里有下载卡片）。不要再贴路径或链接，但在回复正文里请直接写出文件中的关键结论或摘要，让用户不打开文件也能一眼看到结果。${describe(file)}`,
              [file],
            );
          },
        ),
      );
    }
    const vision = await media.visionFor(owner, agentId).catch(() => null);
    if (vision?.kind === "model") {
      const input = await media.imageInputFor(owner, agentId).catch(() => null);
      out.push(
        tool(
          "image_inspect",
          input?.kind === "main"
            ? "让识图模型看一张图片并回答一个具体问题。用户附在消息里的图片你自己就能看到原图，直接看图回答，不需要这个工具；只有要看工作区里或更早的图片、而它不在当前消息里时才用。"
            : "让识图模型看一张图片并回答一个具体问题（图里某处写了什么、某个数字、某个细节）。上传的图片你只拿到了文字描述；描述里没有的细节用它去问，不要编。",
          z
            .object({
              question: z
                .string()
                .min(1)
                .max(1000)
                .describe("要问识图模型的具体问题"),
              source: z
                .string()
                .max(400)
                .optional()
                .describe(
                  "哪张图片：文件 id、/api/chat-files/… 网址，或工作区路径；不写 = 这个聊天里最近的一张",
                ),
            })
            .strict(),
          async (input) => {
            const src = await sourceImage(owner, agentId, input.source);
            const answer = await media.ask(
              vision.config,
              { bytes: src.bytes, mimeType: src.mimeType },
              `${input.question}\n\n只根据图片回答，用中文；看不清就说看不清。`,
            );
            return `识图模型（${vision.label}）对「${src.name}」的回答：\n${answer}`;
          },
          "read",
        ),
      );
    }
    out.push(
      tool(
        "chat_files_recent",
        "列出这个聊天里最近的文件：用户上传的、你生成的图片、你交给用户的文件（文件 id、工作区路径）。",
        z
          .object({
            images_only: z.boolean().optional(),
            limit: z.number().int().min(1).max(30).optional(),
          })
          .strict(),
        async (input) => {
          const files = await list(owner, agentId, {
            imagesOnly: input.images_only === true,
            limit: input.limit ?? 10,
          });
          if (files.length === 0) return "还没有文件。";
          const label = {
            upload: "用户上传",
            generated: "你生成",
            edited: "你修改",
            shared: "你交给用户",
          } as const;
          return files
            .map(
              (f) =>
                `- ${f.name}（${label[f.kind]}，${f.mimeType}，${formatSize(f.size)}）id ${f.id}${f.workspacePath ? `，工作区 ${f.workspacePath}` : ""}`,
            )
            .join("\n");
        },
        "read",
      ),
    );
    if (await hasIndexedChunks(owner)) {
      out.push(
        tool(
          "chat_file_search",
          "在当前用户上传的文档分块（PDF / DOCX / 长文本）中按关键词检索相关片段，返回所属文件 id、文件名、分块序号 chunkIndex 与命中片段。",
          z
            .object({
              query: z
                .string()
                .trim()
                .min(1, "请提供要检索的关键词。")
                .max(300)
                .describe("要检索的关键词或短语（支持中英文）"),
              fileId: z
                .string()
                .trim()
                .min(1)
                .max(64)
                .optional()
                .describe("可选，只检索指定文件 id 的分块"),
              file_id: z
                .string()
                .trim()
                .min(1)
                .max(64)
                .optional()
                .describe("fileId 的可选别名"),
              limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe("最多返回条数，默认 5，上限 20"),
            })
            .strict(),
          async (input) => {
            const targetFileId = input.fileId ?? input.file_id ?? null;
            const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
            const tokens = tokenizeChunkQuery(input.query);
            if (!tokens.phrase) {
              return JSON.stringify(
                {
                  total: 0,
                  results: [],
                  message: "请提供有效检索关键词。",
                },
                null,
                2,
              );
            }

            type ChunkSearchRow = {
              file_id: string;
              owner_user_id?: string;
              chunk_index: number;
              content: string;
              file_name?: string | null;
            };

            let rows: ChunkSearchRow[] = [];
            try {
              rows = targetFileId
                ? await sql.unsafe<ChunkSearchRow[]>(
                    `SELECT c.file_id, c.owner_user_id, c.chunk_index, c.content, f.name AS file_name
                     FROM chisabot_chat_file_chunks c
                     LEFT JOIN chisabot_chat_files f
                       ON f.id = c.file_id AND f.owner_user_id = c.owner_user_id
                     WHERE c.owner_user_id = $1 AND c.file_id = $2
                     ORDER BY c.chunk_index ASC
                     LIMIT 500`,
                    [owner, targetFileId],
                  )
                : await sql.unsafe<ChunkSearchRow[]>(
                    `SELECT c.file_id, c.owner_user_id, c.chunk_index, c.content, f.name AS file_name
                     FROM chisabot_chat_file_chunks c
                     LEFT JOIN chisabot_chat_files f
                       ON f.id = c.file_id AND f.owner_user_id = c.owner_user_id
                     WHERE c.owner_user_id = $1
                     ORDER BY c.created_at DESC, c.chunk_index ASC
                     LIMIT 500`,
                    [owner],
                  );
            } catch {
              rows = [];
            }

            const ranked = rows
              .filter(
                (entry) =>
                  (entry.owner_user_id === undefined ||
                    entry.owner_user_id === owner) &&
                  (!targetFileId || entry.file_id === targetFileId),
              )
              .map((entry) => ({
                fileId: entry.file_id,
                fileName: entry.file_name || entry.file_id,
                chunkIndex: Number(entry.chunk_index),
                excerpt: entry.content,
                score: scoreChunkText(entry.content, tokens),
              }))
              .filter((hit) => hit.score > 0)
              .sort((a, b) =>
                b.score !== a.score
                  ? b.score - a.score
                  : a.chunkIndex - b.chunkIndex,
              )
              .slice(0, limit)
              .map(({ score: _score, ...rest }) => rest);

            if (ranked.length === 0) {
              return JSON.stringify(
                {
                  total: 0,
                  results: [],
                  message: "没有找到匹配的文件分块。",
                },
                null,
                2,
              );
            }

            return JSON.stringify(
              {
                total: ranked.length,
                results: ranked,
              },
              null,
              2,
            );
          },
          "read",
        ),
      );
    }
    return out;
  }

  /** 每轮开头给机器人的用法（不点名具体文件）。 */
  async function guidance(owner?: string, agentId?: string): Promise<string> {
    const images = owner
      ? await media.imageViewFor(owner).catch(() => null)
      : await settingsView().catch(() => null);
    const input =
      owner && agentId
        ? await media.imageInputFor(owner, agentId).catch(() => null)
        : null;
    return [
      "【文件】用户在聊天里上传的文件会存进你的工作区 uploads/（消息里能看到图片和说明）。",
      options.workspace
        ? "要把工作区里的文件给用户，用 file_share（聊天里出下载卡片），不要贴路径或 workspace.local 链接；同时在回复正文里直接写出关键结论或内容摘要。"
        : "",
      images?.ready
        ? "要画图用 image_generate，要改图（包括用户刚上传的）用 image_edit；结果会自动显示，不要再用 Markdown 贴图。"
        : "还没打开图片生成：用户要你画图时，告诉他请管理员在 设置 → 模型 → 生图模型 里打开，或在 设置 → 生图与识图 里填自己的生图模型。",
      input ? IMAGE_INPUT_GUIDANCE[input.kind] : "",
    ]
      .filter(Boolean)
      .join("");
  }

  // ------------------------------------------------------------------ 路由

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.onError((error, c) => {
      if (error instanceof ChatFilesError)
        return c.json({ error: error.message }, 400);
      if (error instanceof z.ZodError)
        return c.json({ error: error.issues[0]?.message ?? "参数不对。" }, 400);
      console.error(
        JSON.stringify({
          type: "chat-files-error",
          error: error.name,
          route: c.req.path,
        }),
      );
      return c.json({ error: "文件服务暂时不可用，请重试。" }, 503);
    });
    const admin: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      if (c.var.actor.role !== "admin")
        return c.json({ error: "只有管理员能改图片模型。" }, 403);
      await next();
    };
    app.get("/settings/image", admin, async (c) =>
      c.json({ settings: await settingsView() }),
    );
    app.put(
      "/settings/image",
      admin,
      bodyLimit({ maxSize: 16_384 }),
      async (c) =>
        c.json({
          settings: await saveSettings(c.var.actor.id, await c.req.json()),
        }),
    );
    app.post(
      "/settings/image/test",
      admin,
      bodyLimit({ maxSize: 16_384 }),
      async (c) =>
        c.json(await testSettings(await c.req.json().catch(() => ({})))),
    );
    app.get("/", async (c) => {
      const agentId = c.req.query("agentId") || undefined;
      const before = c.req.query("before") || undefined;
      return c.json({
        files: await list(c.var.actor.id, agentId, {
          imagesOnly: c.req.query("images") === "1",
          limit: Number(c.req.query("limit") ?? 30) || 30,
          ...(before ? { before } : {}),
        }),
      });
    });
    app.post(
      "/",
      bodyLimit({
        maxSize: MAX_CHAT_FILE_BYTES + 512 * 1024,
        onError: (c) =>
          c.json(
            { error: `文件超过 ${formatSize(MAX_CHAT_FILE_BYTES)}。` },
            413,
          ),
      }),
      async (c) => {
        const form = await c.req.formData().catch(() => null);
        const file = form?.get("file");
        const agentId = String(form?.get("agentId") ?? "");
        if (!(file instanceof File)) throw new ChatFilesError("没有收到文件。");
        if (!agentId) throw new ChatFilesError("缺少机器人。");
        const saved = await upload(c.var.actor.id, agentId, {
          name: file.name,
          bytes: Buffer.from(await file.arrayBuffer()),
        });
        return c.json({ file: saved }, 201);
      },
    );
    app.get("/:id", async (c) => {
      const isHead = c.req.method === "HEAD";
      const found = await row(c.var.actor.id, c.req.param("id"), !isHead);
      if (!found || (!isHead && !found.bytes))
        return c.json({ error: "找不到这个文件。" }, 404);
      const inline =
        isInlineSafeMime(found.mime_type) && c.req.query("download") !== "1";
      const encoded = encodeURIComponent(found.name);
      const headers: Record<string, string> = {
        "content-type": inline ? found.mime_type : "application/octet-stream",
        "content-length": String(found.size_bytes),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=31536000, immutable",
      };
      // PDF 要浏览器自带的阅读器，沙箱 CSP 会把它挡掉；图片和附件都加沙箱。
      if (found.mime_type !== "application/pdf" || !inline)
        headers["content-security-policy"] = "sandbox; default-src 'none'";
      const bytes = found.bytes;
      const bodyView =
        isHead || !bytes
          ? null
          : bytes.buffer instanceof ArrayBuffer
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            : new Uint8Array(bytes);
      return new Response(bodyView, { headers });
    });
    app.delete("/:id", async (c) =>
      (await remove(c.var.actor.id, c.req.param("id")))
        ? c.body(null, 204)
        : c.json({ error: "找不到这个文件。" }, 404),
    );
    return app;
  }

  async function ensureAll() {
    await ensure();
    await media.ensure();
  }

  return {
    ensure: ensureAll,
    media,
    settingsView,
    saveSettings,
    testSettings,
    providerConfig,
    store,
    setWorkspacePath,
    row,
    list,
    remove,
    upload,
    loadForTurn,
    channelAttachmentForModel,
    promptForModel,
    makeImage,
    share,
    tools,
    guidance,
    routes,
  };
}
export type ChatFiles = ReturnType<typeof createChatFiles>;
