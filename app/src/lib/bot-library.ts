import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import {
  type BotLibraryFileView,
  MAX_BOT_LIBRARY_FILE_BYTES,
  MAX_BOT_LIBRARY_FILES,
} from "../../../shared/bot-library";

export {
  type BotLibraryFileView,
  MAX_BOT_LIBRARY_FILE_BYTES,
  MAX_BOT_LIBRARY_FILES,
};

export const botLibraryKeys = {
  all: ["bot-library"] as const,
  forBot: (agentId: string) => ["bot-library", agentId] as const,
};

export type BotLibraryListResponse = {
  files: BotLibraryFileView[];
  limit: number;
  maxFileBytes: number;
};

export function botLibraryQueryOptions(agentId: string) {
  return queryOptions({
    queryKey: botLibraryKeys.forBot(agentId),
    enabled: Boolean(agentId),
    queryFn: async ({ signal }): Promise<BotLibraryListResponse> => {
      const response = await client(
        `/api/bots/${encodeURIComponent(agentId)}/library`,
        {
          signal,
          fallback: "无法加载机器人常驻资料库。",
        },
      );
      const payload = (await response
        .json()
        .catch(() => null)) as BotLibraryListResponse | null;
      if (!payload || !Array.isArray(payload.files)) {
        throw new Error("机器人常驻资料库返回格式无效。");
      }
      return {
        files: payload.files,
        limit: Number(payload.limit ?? MAX_BOT_LIBRARY_FILES),
        maxFileBytes: Number(
          payload.maxFileBytes ?? MAX_BOT_LIBRARY_FILE_BYTES,
        ),
      };
    },
  });
}

export async function uploadBotLibraryFile(
  agentId: string,
  file: File,
): Promise<BotLibraryFileView> {
  if (file.size === 0) {
    throw new Error("不能上传空文件。");
  }
  if (file.size > MAX_BOT_LIBRARY_FILE_BYTES) {
    throw new Error("文件大小超过 20 MB 上限。");
  }
  const form = new FormData();
  form.set("file", file, file.name);
  const response = await tryClient(
    `/api/bots/${encodeURIComponent(agentId)}/library`,
    {
      method: "POST",
      body: form,
      timeoutMs: 0,
    },
  );
  const payload = (await response.json().catch(() => null)) as {
    file?: BotLibraryFileView;
    error?: string;
  } | null;
  if (!response.ok || !payload?.file) {
    throw new Error(
      payload?.error ||
        (response.status === 413
          ? "文件超过 20 MB 上限。"
          : "上传常驻资料失败，请重试。"),
    );
  }
  return payload.file;
}

export async function deleteBotLibraryFile(
  agentId: string,
  fileId: string,
): Promise<void> {
  await client(
    `/api/bots/${encodeURIComponent(agentId)}/library/${encodeURIComponent(fileId)}`,
    {
      method: "DELETE",
      fallback: "移除常驻资料失败，请重试。",
    },
  );
}
