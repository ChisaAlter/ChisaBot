import { queryOptions } from "@tanstack/react-query";
import type { ChatFileView, ImageSettingsView } from "../../../shared/chat-files";
import { client } from "@/lib/client";

/** 聊天文件 + 图片生成（DESIGN.md §56，docs/chat-files.md）。 */
export const chatFileKeys = {
  imageSettings: ["chat-files", "image-settings"] as const,
  forBot: (agentId: string) => ["chat-files", "bot", agentId] as const,
};

export async function fetchBotChatFiles(
  agentId: string,
  opts: { limit?: number; before?: string; signal?: AbortSignal } = {},
): Promise<ChatFileView[]> {
  const params = new URLSearchParams({ agentId, limit: String(opts.limit ?? 31) });
  if (opts.before) params.set("before", opts.before);
  return client(`/api/chat-files?${params.toString()}`, "files", {
    fallback: "无法加载文件列表",
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

export function botChatFilesQueryOptions(agentId: string, limit = 31) {
  return queryOptions({
    queryKey: chatFileKeys.forBot(agentId),
    queryFn: ({ signal }): Promise<ChatFileView[]> => fetchBotChatFiles(agentId, { limit, signal }),
    enabled: Boolean(agentId),
  });
}

export async function uploadChatFile(agentId: string, file: File): Promise<ChatFileView> {
  const form = new FormData();
  form.set("agentId", agentId);
  form.set("file", file, file.name);
  const response = await fetch("/api/chat-files", { method: "POST", body: form, credentials: "include" });
  const body = (await response.json().catch(() => null)) as { file?: ChatFileView; error?: string } | null;
  if (!response.ok || !body?.file) throw new Error(body?.error || (response.status === 413 ? "文件太大" : "上传失败，请重试"));
  return body.file;
}

export function imageSettingsQueryOptions() {
  return queryOptions({
    queryKey: chatFileKeys.imageSettings,
    queryFn: ({ signal }): Promise<ImageSettingsView> => client("/api/chat-files/settings/image", "settings", { fallback: "无法加载图片设置", signal }),
  });
}

export type ImageSettingsInput = {
  enabled: boolean;
  provider: "minimax" | "openai";
  baseUrl: string;
  model: string;
  editModel: string;
  apiKey?: string;
};

export function saveImageSettings(input: ImageSettingsInput): Promise<ImageSettingsView> {
  return client("/api/chat-files/settings/image", "settings", { method: "PUT", body: input, fallback: "保存失败，请重试" });
}

export async function testImageSettings(input: Partial<ImageSettingsInput>): Promise<{ ok: boolean; message: string }> {
  const response = await fetch("/api/chat-files/settings/image/test", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
  if (!response.ok) throw new Error(body?.error || "检查失败");
  return { ok: Boolean(body?.ok), message: body?.message ?? "" };
}
