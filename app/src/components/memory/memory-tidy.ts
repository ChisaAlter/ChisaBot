import {
  MEMORY_KIND_LABELS,
  MEMORY_LIMITS,
  type MemoryTidyPreview,
} from "../../../../shared/memory-notes";
import { confirmDialog } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import {
  applyMemoryTidy,
  previewMemoryTidy,
  undoMemoryTidy,
} from "@/lib/memory-notes";
import { MEMORY_UNDO_MS } from "./memory-notes";

/**
 * 设置 → 记忆 →「更多」→「整理记忆…」（审计 12-settings 必修 1）。
 * 先拿预览、在确认弹窗里列出将合并的组（太长不合并的也列出来），确认后才整理；整理完 8 秒内可撤销，
 * 之后也能在「更多」→「撤销上次整理」放回原文（服务器留了原文，见 server/src/memory-notes/tidy.ts）。
 */

/** 弹窗里最多列几组，其余合成一行「还有 N 组」。 */
export const TIDY_ITEMS_LIMIT = 12;

/** 确认弹窗的条目：每组一行，写清种类、主题、是哪个机器人记的、几条并成一条。 */
export function tidyConfirmItems(
  preview: MemoryTidyPreview,
  botName: (agentId: string) => string | null = () => null,
): string[] {
  const lines = preview.groups.map((group) => {
    const who = group.agentId ? (botName(group.agentId) ?? "机器人") : "你";
    const head = `${MEMORY_KIND_LABELS[group.kind]}「${group.title || "（无主题）"}」（${who}记的${group.context ? `，${group.context}` : ""}）`;
    return group.skipped === "too_long"
      ? `${head}：${group.count} 条合并后有 ${group.length} 字，超过 ${MEMORY_LIMITS.content} 字，不合并`
      : `${head}：${group.count} 条合并为 1 条`;
  });
  const out = lines.slice(0, TIDY_ITEMS_LIMIT);
  if (lines.length > TIDY_ITEMS_LIMIT)
    out.push(`……还有 ${lines.length - TIDY_ITEMS_LIMIT} 组`);
  if (preview.deduplicatedCount)
    out.push(`另有 ${preview.deduplicatedCount} 条笔记去掉重复的行`);
  return out;
}

/** 撤销一次整理，并刷新列表。 */
export async function undoTidy(
  batchId: string,
  refresh: () => Promise<unknown>,
) {
  try {
    const result = await undoMemoryTidy(batchId);
    await refresh().catch(() => undefined);
    toast.success(
      result.skipped
        ? `已恢复 ${result.restored} 条；${result.skipped} 条整理后又改过，没有覆盖。`
        : `已恢复整理前的 ${result.restored} 条记忆。`,
    );
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : "撤销整理失败，请重试",
    );
  }
}

/** 点「整理记忆…」：预览 → 确认 → 整理 → 8 秒撤销提示。返回是否真的整理了。 */
export async function runMemoryTidy(options: {
  refresh: () => Promise<unknown>;
  botName?: (agentId: string) => string | null;
}): Promise<boolean> {
  const { preview } = await previewMemoryTidy();
  const merging = preview.groups.filter((group) => !group.skipped);
  if (!merging.length && !preview.deduplicatedCount) {
    const skipped = preview.groups.length;
    toast.info(
      skipped
        ? `没有可以合并的记忆（${skipped} 组合并后会超过 ${MEMORY_LIMITS.content} 字，保持原样）。`
        : "记忆已经很整洁，没有要合并的。",
    );
    return false;
  }
  const ok = await confirmDialog({
    title: merging.length
      ? `合并 ${merging.length} 组重复的记忆？`
      : "去掉记忆里重复的行？",
    description: `同一个机器人、同种类、同主题（情境也相同）的笔记会并成一条，被并掉的条目会删除。整理后 8 秒内可以撤销，之后也能在「更多」里撤销上次整理。`,
    items: tidyConfirmItems(preview, options.botName),
    confirmLabel: "整理",
    destructive: true,
  });
  if (!ok) return false;
  const result = await applyMemoryTidy(preview.token);
  await options.refresh().catch(() => undefined);
  const batchId = result.batchId;
  if (batchId)
    toast.undo(
      result.summary,
      () => void undoTidy(batchId, options.refresh),
      MEMORY_UNDO_MS,
    );
  else toast.info(result.summary);
  return true;
}
