import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import type { BotAvatar } from "../../../shared/bot-avatars";
import type {
  MediaCapability,
  MediaPoolModelEntry,
  MediaPoolModelInput,
} from "../../../shared/media-pool";

export const mediaPoolKeys = {
  all: ["media-pool"] as const,
  list: (capability?: MediaCapability) =>
    ["media-pool", "list", capability ?? "all"] as const,
};

async function callPool<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
  fallback = "多模态模型池请求失败，请重试",
): Promise<T> {
  const response = await tryClient(`/api/media-pool${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
  });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok || !body) {
    throw new Error(body?.error || fallback);
  }
  return body;
}

export function mediaPoolQueryOptions(capability?: MediaCapability) {
  const query = capability
    ? `?capability=${encodeURIComponent(capability)}`
    : "";
  return queryOptions({
    queryKey: mediaPoolKeys.list(capability),
    queryFn: async ({ signal }) => {
      const data = await callPool<{ entries?: MediaPoolModelEntry[] }>(
        query,
        { signal },
        "无法加载多模态模型池",
      );
      return Array.isArray(data.entries) ? data.entries : [];
    },
  });
}

export async function createMediaPoolEntry(
  input: MediaPoolModelInput,
): Promise<MediaPoolModelEntry> {
  const data = await callPool<{ entry: MediaPoolModelEntry }>(
    "",
    { method: "POST", body: input },
    "新增模型池条目失败",
  );
  return data.entry;
}

export async function updateMediaPoolEntry(
  id: string,
  input: MediaPoolModelInput,
): Promise<MediaPoolModelEntry> {
  const data = await callPool<{ entry: MediaPoolModelEntry }>(
    `/${encodeURIComponent(id)}`,
    { method: "PUT", body: input },
    "更新模型池条目失败",
  );
  return data.entry;
}

export async function deleteMediaPoolEntry(id: string): Promise<void> {
  await callPool<void>(
    `/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "删除模型池条目失败",
  );
}

/** 调用 `POST /api/bots/:agentId/avatar/generate` 使用已配生图模型生成并落库 Bot 头像。 */
export async function generateBotAvatar(
  agentId: string,
  input: { prompt?: string; modelId?: string; style?: string } = {},
): Promise<{ avatar: BotAvatar; prompt: string; model: string }> {
  const response = await tryClient(
    `/api/bots/${encodeURIComponent(agentId)}/avatar/generate`,
    {
      method: "POST",
      body: input,
      timeoutMs: 0,
    },
  );
  const body = (await response.json().catch(() => null)) as {
    avatar?: BotAvatar;
    prompt?: string;
    model?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.avatar) {
    throw new Error(body?.error || "AI 生成头像失败，请确认已配置生图模型。");
  }
  return {
    avatar: body.avatar,
    prompt: body.prompt ?? "",
    model: body.model ?? "",
  };
}
