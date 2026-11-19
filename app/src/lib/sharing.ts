import { queryOptions } from "@tanstack/react-query";
import type { ChisaSkill } from "@/lib/chisa-skills";
import { client } from "@/lib/client";
import type {
  ShareExportDraft,
  ShareExportZipRequest,
  ShareImportCommitResult,
  ShareImportPreview,
  SkillAuxFileView,
  SkillDiffResult,
  SkillRevisionView,
} from "../../../shared/sharing";

/**
 * Bot 配方脱敏分享 ZIP 工作台 + 技能版本/Diff/回滚/多文件 API 客户端。
 * 所有请求统一经 `@/lib/client` 发出，严禁裸 fetch。
 */

export const sharingKeys = {
  all: ["sharing"] as const,
  skillRevisions: (slug: string) =>
    ["chisa-skills", "revisions", slug] as const,
  skillFiles: (slug: string) => ["chisa-skills", "files", slug] as const,
};

export function createExportDraft(botId: string): Promise<ShareExportDraft> {
  return client("/api/sharing/export/draft", "draft", {
    method: "POST",
    body: { botId },
    fallback: "无法组装配方导出草稿，请重试",
  });
}

function parseContentDispositionFilename(
  header: string | null,
  fallback: string,
): string {
  if (!header) return fallback;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim());
    } catch {
      return fallback;
    }
  }
  const plainMatch = /filename="([^"]+)"|filename=([^;\s]+)/i.exec(header);
  const raw = plainMatch?.[1] ?? plainMatch?.[2];
  return raw?.trim() || fallback;
}

export async function downloadExportZip(
  input: ShareExportZipRequest,
): Promise<{ blob: Blob; filename: string; digest: string }> {
  const response = await client("/api/sharing/export/zip", {
    method: "POST",
    body: input,
    fallback: "校验或生成配方 ZIP 失败，请检查安全提示后重试",
    timeoutMs: 60_000,
  });
  const blob = await response.blob();
  const filename = parseContentDispositionFilename(
    response.headers.get("content-disposition"),
    `bot-recipe-${input.botId.slice(0, 8)}.zip`,
  );
  const digest = response.headers.get("x-share-package-digest") ?? "";
  return { blob, filename, digest };
}

export function previewImportZip(
  file: File | Blob,
): Promise<ShareImportPreview> {
  const form = new FormData();
  form.append("file", file, file instanceof File ? file.name : "recipe.zip");
  return client("/api/sharing/import/preview", "preview", {
    method: "POST",
    body: form,
    fallback: "解析配方 ZIP 失败，请检查文件完整性与安全规范",
    timeoutMs: 60_000,
  });
}

export function commitImportZip(input: {
  file: File | Blob;
  importId: string;
  packageDigest: string;
  selectedMemoryIndices: number[];
}): Promise<ShareImportCommitResult> {
  const form = new FormData();
  form.append(
    "file",
    input.file,
    input.file instanceof File ? input.file.name : "recipe.zip",
  );
  form.append("importId", input.importId);
  form.append("packageDigest", input.packageDigest);
  form.append(
    "selectedMemoryIndices",
    JSON.stringify(input.selectedMemoryIndices),
  );
  return client("/api/sharing/import/commit", "result", {
    method: "POST",
    body: form,
    fallback: "导入配方失败，可点击断点续导重试（已导入项不会重复创建）",
    timeoutMs: 90_000,
  });
}

// ── 技能不可变版本栈、行级 Diff、回滚与多文件只读资源 ────────────────────

export type SkillRevisionsPayload = {
  currentRevisionId: string | null;
  revisions: SkillRevisionView[];
};

export function skillRevisionsQueryOptions(slug: string) {
  return queryOptions({
    queryKey: sharingKeys.skillRevisions(slug),
    queryFn: async ({ signal }): Promise<SkillRevisionsPayload> => {
      const response = await client(
        `/api/chisa-skills/${encodeURIComponent(slug)}/revisions`,
        { fallback: "无法加载技能历史版本", signal },
      );
      const body = (await response.json()) as Partial<SkillRevisionsPayload>;
      return {
        currentRevisionId: body.currentRevisionId ?? null,
        revisions: Array.isArray(body.revisions) ? body.revisions : [],
      };
    },
    retry: false,
  });
}

export function fetchSkillDiff(
  slug: string,
  fromRevisionId: string,
  toRevisionId: string,
): Promise<SkillDiffResult> {
  const params = new URLSearchParams({
    from: fromRevisionId,
    to: toRevisionId,
  });
  return client(
    `/api/chisa-skills/${encodeURIComponent(slug)}/diff?${params.toString()}`,
    "diff",
    { fallback: "无法对比版本差异" },
  );
}

export async function rollbackSkillRevision(
  slug: string,
  revisionId: string,
): Promise<{ skill: ChisaSkill | null; revision: SkillRevisionView }> {
  const response = await client(
    `/api/chisa-skills/${encodeURIComponent(slug)}/rollback`,
    {
      method: "POST",
      body: { revisionId },
      fallback: "回滚技能版本失败，请重试",
    },
  );
  return (await response.json()) as {
    skill: ChisaSkill | null;
    revision: SkillRevisionView;
  };
}

export function skillFilesQueryOptions(slug: string) {
  return queryOptions({
    queryKey: sharingKeys.skillFiles(slug),
    queryFn: ({ signal }): Promise<SkillAuxFileView[]> =>
      client(`/api/chisa-skills/${encodeURIComponent(slug)}/files`, "files", {
        fallback: "无法加载技能附属文件",
        signal,
      }),
    retry: false,
  });
}

export function saveSkillFiles(
  slug: string,
  files: Array<{ path: string; content: string }>,
): Promise<SkillAuxFileView[]> {
  return client(
    `/api/chisa-skills/${encodeURIComponent(slug)}/files`,
    "files",
    {
      method: "PUT",
      body: { files },
      fallback: "保存技能附属文件失败，请检查路径与安全规范",
    },
  );
}
