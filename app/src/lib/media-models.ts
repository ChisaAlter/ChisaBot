import { queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import type { ImageSettingsView } from "../../../shared/chat-files";
import type { MediaAdminView, MediaPersonalView, MediaProbeResult, VisionSettingsView } from "../../../shared/media-models";

/** 生图模型 / 识图模型（DESIGN.md §59）：管理员默认 + 个人设置。 */
export const mediaKeys = {
  all: ["media-models"] as const,
  admin: ["media-models", "default"] as const,
  me: ["media-models", "me"] as const,
};

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}, fallback = "请求失败，请重试"): Promise<T> {
  const response = await tryClient(`/api/media-models${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || fallback);
  return body;
}

export function mediaAdminQueryOptions() {
  return queryOptions({ queryKey: mediaKeys.admin, queryFn: ({ signal }) => call<MediaAdminView>("/default", { signal }, "无法加载生图 / 识图设置") });
}
export function mediaPersonalQueryOptions() {
  return queryOptions({ queryKey: mediaKeys.me, queryFn: ({ signal }) => call<MediaPersonalView>("/me", { signal }, "无法加载生图 / 识图设置") });
}

export type ImageDefaultInput = { enabled: boolean; provider: "minimax" | "openai"; baseUrl: string; model: string; editModel: string; apiKey?: string };
export type VisionInput = { mode: "follow" | "custom" | "default"; baseUrl?: string; model?: string; apiKey?: string };
export type PersonalImageInput = { mode: "default" | "custom"; provider?: "minimax" | "openai"; baseUrl?: string; model?: string; editModel?: string; apiKey?: string };

export const saveImageDefault = (input: ImageDefaultInput) => call<{ image: ImageSettingsView }>("/default/image", { method: "PUT", body: input }, "保存失败，请重试");
export const saveVisionDefault = (input: VisionInput) => call<{ vision: VisionSettingsView }>("/default/vision", { method: "PUT", body: input }, "保存失败，请重试");
export const savePersonalImage = (input: PersonalImageInput) => call<MediaPersonalView>("/me/image", { method: "PUT", body: input }, "保存失败，请重试");
export const savePersonalVision = (input: VisionInput) => call<MediaPersonalView>("/me/vision", { method: "PUT", body: input }, "保存失败，请重试");

export const testImageModel = (input: { scope: "default" | "personal"; provider: "minimax" | "openai"; baseUrl: string; model: string; apiKey?: string }) =>
  call<MediaProbeResult>("/test/image", { method: "POST", body: input, timeoutMs: 0 }, "检查失败");
export const testVisionModel = (input: { scope: "default" | "personal"; baseUrl: string; model: string; apiKey?: string }) =>
  call<MediaProbeResult>("/test/vision", { method: "POST", body: input, timeoutMs: 0 }, "检查失败");
