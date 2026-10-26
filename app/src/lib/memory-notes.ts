import { queryOptions } from "@tanstack/react-query";
import type { MemoryBotSetting, MemoryKind, MemoryNoteView } from "../../../shared/memory-notes";
import { client } from "@/lib/client";

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

export async function dreamMemoryNotes(): Promise<{
  mergedCount: number;
  deduplicatedCount: number;
  totalRemaining: number;
  summary: string;
}> {
  const response = await client("/api/memory-notes/dream", { method: "POST", body: {}, fallback: "整理记忆失败，请重试" });
  return (await response.json()) as {
    mergedCount: number;
    deduplicatedCount: number;
    totalRemaining: number;
    summary: string;
  };
}
