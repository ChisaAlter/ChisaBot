import { mediaTypeOf, namesNoFormat } from "./attachments";

/**
 * 聊天文件与图片生成（DESIGN.md §56，docs/chat-files.md）。服务器和网页共用的类型与常量。
 *
 * - 用户在机器人聊天里上传的文件、机器人生成 / 修改的图片、机器人用 file_share 交给用户的工作区文件，
 *   都存成一行 chisabot_chat_files（字节在库里，按人隔离），网址 `/api/chat-files/<id>`。
 * - 工具结果的最后一行是 `⟦chisabot:files⟧[…]`，网页据此画图片卡 / 文件卡（chat-file-tools.tsx）。
 */

export const CHAT_FILE_URL_PREFIX = "/api/chat-files/";
export const CHAT_FILES_MARKER = "⟦chisabot:files⟧";
/** 上传 / 交付的单个文件上限。 */
export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;

/** 聊天框允许直传至 `/api/chat-files`（由服务端提取分块与检索）的文档 MIME 类型。 */
export const ACCEPTED_CHAT_DOCUMENT_MIME = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

const CHAT_DOCUMENT_EXTENSIONS = new Set(["pdf", "docx"]);

/**
 * 判断一个文件是否为聊天框可直传的 PDF / DOCX 文档。
 *
 * 与 `unreadablePhotoFormat` 规则对称：优先信任明确的媒体类型；
 * 仅当浏览器未给出格式声明（空字符串、`application/octet-stream` 等）时按后缀兜底，
 * 避免伪装成 `.pdf` 的图片或压缩包被误走文档通道。
 */
export function isChatDocumentFile(name: string, mimeType: string): boolean {
  const mediaType = mediaTypeOf(mimeType);
  if ((ACCEPTED_CHAT_DOCUMENT_MIME as readonly string[]).includes(mediaType)) {
    return true;
  }
  if (mediaType && !namesNoFormat(mediaType)) {
    return false;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
  return Boolean(extension && CHAT_DOCUMENT_EXTENSIONS.has(extension));
}

export type ChatFileKind = "upload" | "generated" | "edited" | "shared";

export type ChatFileView = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ChatFileKind;
  url: string;
  /** 在机器人工作区里的相对路径；没写进工作区（没有电脑）时为 null。 */
  workspacePath: string | null;
  prompt?: string | null;
  createdAt: string;
  /** 图片的像素宽高（DESIGN.md §83.2）；不是图片 / 读不出 / 旧数据没有。网页据此先留框。 */
  width?: number;
  height?: number;
};

export type ImageProviderKind = "minimax" | "openai";
export const IMAGE_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

export type ImageSettingsView = {
  enabled: boolean;
  provider: ImageProviderKind;
  baseUrl: string;
  model: string;
  /** 修改图片用的模型；空 = 和生成同一个。 */
  editModel: string;
  /** saved = 管理员存的密钥；environment = 沿用部署环境变量；none = 没有密钥。 */
  keySource: "saved" | "environment" | "none";
  keyHint: string;
  /** 设置完整、可以给机器人用。 */
  ready: boolean;
  updatedAt: string | null;
};

export const IMAGE_PROVIDER_PRESETS: Record<
  ImageProviderKind,
  { label: string; baseUrl: string; model: string; editNote: string }
> = {
  minimax: {
    label: "MiniMax（image-01）",
    baseUrl: "https://api.minimax.cn",
    model: "image-01",
    editNote:
      "MiniMax 的「修改」是参考图生成：以上传的图为主体参考重新画，不是逐像素修图。",
  },
  openai: {
    label: "OpenAI 兼容（/v1/images）",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-1",
    editNote:
      "走 /v1/images/edits，适用于 gpt-image、new-api / One API 等兼容中转。",
  },
};

export const chatFileUrl = (id: string) => `${CHAT_FILE_URL_PREFIX}${id}`;

export function isInlineSafeMime(mime: string): boolean {
  return [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "audio/mpeg",
    "audio/wav",
    "audio/opus",
    "audio/aac",
    "audio/ogg",
    "audio/mp4",
    "video/mp4",
    "video/webm",
    "video/quicktime",
  ].includes(mime);
}

/** AG-UI 把字符串工具结果再 JSON 编码一次（`"\"…\""`）：先解开。 */
function unwrap(result: unknown): string | null {
  if (typeof result !== "string") return null;
  const text = result.trim();
  if (text.startsWith('"')) {
    try {
      const inner = JSON.parse(text) as unknown;
      if (typeof inner === "string") return inner;
    } catch {}
  }
  return result;
}

const SAFE_CHAT_FILE_URL_RE = /^\/api\/chat-files\/[A-Za-z0-9_-]+$/;

/** 工具结果里带的文件清单（网页画卡用）。解析失败返回空数组。 */
export function filesFromToolResult(raw: unknown): ChatFileView[] {
  const result = unwrap(raw);
  if (result === null) return [];
  const at = result.lastIndexOf(CHAT_FILES_MARKER);
  if (at < 0) return [];
  try {
    const parsed = JSON.parse(
      result.slice(at + CHAT_FILES_MARKER.length).trim(),
    ) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (f): f is ChatFileView =>
            Boolean(f) &&
            typeof f === "object" &&
            typeof (f as ChatFileView).id === "string" &&
            typeof (f as ChatFileView).url === "string" &&
            SAFE_CHAT_FILE_URL_RE.test((f as ChatFileView).url),
        )
      : [];
  } catch {
    return [];
  }
}

/** 去掉结果里的文件清单那一行，剩下给人看的话。 */
export function toolResultText(raw: unknown): string {
  const result = unwrap(raw);
  if (result === null) return "";
  const at = result.lastIndexOf(CHAT_FILES_MARKER);
  return (at < 0 ? result : result.slice(0, at)).trim();
}
