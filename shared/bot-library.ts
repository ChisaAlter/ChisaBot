/**
 * 按 Bot 持久化的常驻参考资料库（前后端共用契约）。
 */

export const MAX_BOT_LIBRARY_FILES = 20;
export const MAX_BOT_LIBRARY_FILE_BYTES = 20 * 1024 * 1024;

export type BotLibraryFileView = {
  fileId: string;
  agentId: string;
  name: string;
  mimeType: string;
  size: number;
  chunkCount: number;
  url: string;
  createdAt: string;
};
