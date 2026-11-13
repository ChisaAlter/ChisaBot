import { queryOptions } from "@tanstack/react-query";
import type {
  MemoryBotSetting,
  MemoryKind,
  MemoryNoteView,
  MemoryTidyLast,
  MemoryTidyPreview,
  MemoryTidyResult,
  MemoryTidyUndoResult,
} from "../../../shared/memory-notes";
import { client, tryClient } from "@/lib/client";

/** 设置 → 记忆（DESIGN.md §50，docs/memory.md）。 */
export const memoryNoteKeys = {
  all: ["memory-notes"] as const,
  list: ["memory-notes", "list"] as const,
};

export type MemoryNotesPayload = { notes: MemoryNoteView[]; bots: MemoryBotSetting[] };

export function memoryNotesQueryOptions() {
  return queryOptions({
    queryKey: memoryNoteKeys.list,
    queryFn: async ({ signal }): Promise<MemoryNotesPayload> => {
      const response = await client("/api/memory-notes", { fallback: "无法加载记忆", signal });
      const body = (await response.json().catch(() => null)) as MemoryNotesPayload | null;
      if (!body || !Array.isArray(body.notes)) throw new Error("无法加载记忆");
      return { notes: body.notes, bots: Array.isArray(body.bots) ? body.bots : [] };
    },
    refetchOnWindowFocus: "always",
  });
}

export type MemoryNoteInput = { kind: MemoryKind; subject?: string | null; content: string; context?: string | null; shared?: boolean };

/** 撤销一条刚生成的记忆（聊天里的「记忆」小条）：404 算已经删过，不算失败。 */
export async function forgetMemoryNote(noteId: string): Promise<void> {
  const response = await tryClient(
    `/api/memory-notes/${encodeURIComponent(noteId)}`,
    { method: "DELETE" },
  );
  // 删除失败（网络、权限、已被删）不能显示「已撤销」，否则用户以为记忆没了，其实还在。
  if (!response.ok && response.status !== 404)
    throw new Error(`撤销失败（${response.status}）`);
}

export async function createMemoryNote(input: MemoryNoteInput): Promise<MemoryNoteView> {
  const response = await client("/api/memory-notes", { method: "POST", body: input, fallback: "保存失败，请重试" });
  const body = (await response.json()) as { note: MemoryNoteView };
  return body.note;
}

export function updateMemoryNote(id: string, input: Partial<MemoryNoteInput>): Promise<MemoryNoteView> {
  return client(`/api/memory-notes/${encodeURIComponent(id)}`, "note", { method: "PATCH", body: input, fallback: "保存失败，请重试" });
}

export async function deleteMemoryNotes(ids: string[]): Promise<number> {
  const response = await client("/api/memory-notes/forget", { method: "POST", body: { ids }, fallback: "删除失败，请重试" });
  const body = (await response.json().catch(() => null)) as { removed?: number } | null;
  return body?.removed ?? 0;
}

export async function setMemoryBot(agentId: string, enabled: boolean) {
  await client(`/api/memory-notes/bots/${encodeURIComponent(agentId)}`, { method: "PUT", body: { enabled }, fallback: "保存失败，请重试" });
}

/** 整理记忆：先拿预览（将合并的组）和最近一次还能撤销的整理。 */
export async function previewMemoryTidy(): Promise<{ preview: MemoryTidyPreview; last: MemoryTidyLast | null }> {
  const response = await client("/api/memory-notes/dream", { fallback: "整理记忆失败，请重试" });
  return (await response.json()) as { preview: MemoryTidyPreview; last: MemoryTidyLast | null };
}

/** 确认后按预览的 token 整理；记忆在这期间变了服务器回 409，要重新预览。 */
export async function applyMemoryTidy(token: string): Promise<MemoryTidyResult> {
  const response = await client("/api/memory-notes/dream", { method: "POST", body: { token }, fallback: "整理记忆失败，请重试" });
  return (await response.json()) as MemoryTidyResult;
}

/** 撤销一次整理：被合并、被删的原文放回去。 */
export async function undoMemoryTidy(batchId: string): Promise<MemoryTidyUndoResult> {
  const response = await client("/api/memory-notes/dream/undo", { method: "POST", body: { batchId }, fallback: "撤销整理失败，请重试" });
  return (await response.json()) as MemoryTidyUndoResult;
}
