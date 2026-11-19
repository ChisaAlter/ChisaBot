import {
  IconFileCode,
  IconGitCompare,
  IconHistory,
  IconPlus,
  IconRestore,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { type ChisaSkill, chisaSkillKeys } from "@/lib/chisa-skills";
import {
  fetchSkillDiff,
  rollbackSkillRevision,
  saveSkillFiles,
  sharingKeys,
  skillFilesQueryOptions,
  skillRevisionsQueryOptions,
} from "@/lib/sharing";
import { cn } from "@/lib/utils";
import type {
  SkillDiffLine,
  SkillDiffResult,
} from "../../../../shared/sharing";

type SideBySideRow = {
  key: string;
  leftLine: number | null;
  leftText: string;
  leftKind: "context" | "remove" | "empty";
  rightLine: number | null;
  rightText: string;
  rightKind: "context" | "add" | "empty";
};

function buildSideBySideRows(lines: readonly SkillDiffLine[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  let seq = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.type === "context") {
      seq += 1;
      rows.push({
        key: `ctx-${seq}-${line.oldLine ?? 0}-${line.newLine ?? 0}`,
        leftLine: line.oldLine,
        leftText: line.text,
        leftKind: "context",
        rightLine: line.newLine,
        rightText: line.text,
        rightKind: "context",
      });
      i += 1;
      continue;
    }
    const removes: SkillDiffLine[] = [];
    const adds: SkillDiffLine[] = [];
    while (i < lines.length && lines[i]?.type === "remove") {
      const item = lines[i];
      if (item) removes.push(item);
      i += 1;
    }
    while (i < lines.length && lines[i]?.type === "add") {
      const item = lines[i];
      if (item) adds.push(item);
      i += 1;
    }
    const count = Math.max(removes.length, adds.length);
    for (let k = 0; k < count; k++) {
      const rem = removes[k];
      const add = adds[k];
      seq += 1;
      rows.push({
        key: `chg-${seq}-${rem?.oldLine ?? "e"}-${add?.newLine ?? "e"}`,
        leftLine: rem?.oldLine ?? null,
        leftText: rem?.text ?? "",
        leftKind: rem ? "remove" : "empty",
        rightLine: add?.newLine ?? null,
        rightText: add?.text ?? "",
        rightKind: add ? "add" : "empty",
      });
    }
  }
  return rows;
}

/**
 * 技能版本治理与多文件只读资源面板（挂载于技能详情/编辑对话框内）：
 * - 不可变历史版本列表 + 并排 Diff 对比 + 一键回滚
 * - 除 SKILL.md 外的多文件只读辅助脚本/模板管理（安全相对路径 + 256 KiB 上限）
 */
export function SkillVersionsPanel({
  skillSlug,
  readOnly,
  onRestored,
}: {
  skillSlug: string;
  readOnly: boolean;
  onRestored?: (skill: ChisaSkill) => void;
}) {
  const queryClient = useQueryClient();
  const revisionsQuery = useQuery(skillRevisionsQueryOptions(skillSlug));
  const filesQuery = useQuery(skillFilesQueryOptions(skillSlug));

  const revisions = revisionsQuery.data?.revisions ?? [];
  const currentRevisionId = revisionsQuery.data?.currentRevisionId ?? null;
  const files = filesQuery.data ?? [];

  const [fromRevId, setFromRevId] = useState("");
  const [toRevId, setToRevId] = useState("");
  const [diffResult, setDiffResult] = useState<SkillDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);

  // 多文件辅助资源编辑态
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [newFileContent, setNewFileContent] = useState("");
  const [savingFiles, setSavingFiles] = useState(false);

  const effectiveTo =
    toRevId || currentRevisionId || revisions[0]?.revisionId || "";
  const effectiveFrom =
    fromRevId ||
    revisions.find((r) => r.revisionId !== effectiveTo)?.revisionId ||
    effectiveTo;

  async function handleCompare() {
    if (!effectiveFrom || !effectiveTo) return;
    setDiffLoading(true);
    try {
      const diff = await fetchSkillDiff(skillSlug, effectiveFrom, effectiveTo);
      setDiffResult(diff);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "对比差异失败");
    } finally {
      setDiffLoading(false);
    }
  }

  async function handleRollback(revisionId: string, shortSha: string) {
    const ok = await confirmDialog({
      title: `回滚技能 /${skillSlug} 到快照 ${shortSha}？`,
      description:
        "系统将恢复该不可变快照的标题、简介、正文与工具依赖声明；当前历史快照仍会被完整保留。",
      confirmLabel: "确认回滚",
    });
    if (!ok) return;
    setRollingBackId(revisionId);
    try {
      const res = await rollbackSkillRevision(skillSlug, revisionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: chisaSkillKeys.all }),
        queryClient.invalidateQueries({
          queryKey: sharingKeys.skillRevisions(skillSlug),
        }),
      ]);
      if (res.skill && onRestored) onRestored(res.skill);
      setDiffResult(null);
      toast.success(`已回滚到快照 ${shortSha}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "回滚失败");
    } finally {
      setRollingBackId(null);
    }
  }

  async function handleAddAuxFile() {
    const cleanPath = newFilePath.trim();
    if (!cleanPath) {
      toast.error("请填写辅助文件相对路径（例如 templates/report.md）。");
      return;
    }
    const nextList = [
      ...files
        .filter((f) => f.path !== cleanPath)
        .map((f) => ({ path: f.path, content: f.content })),
      { path: cleanPath, content: newFileContent },
    ];
    setSavingFiles(true);
    try {
      await saveSkillFiles(skillSlug, nextList);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sharingKeys.skillFiles(skillSlug),
        }),
        queryClient.invalidateQueries({ queryKey: chisaSkillKeys.all }),
      ]);
      setSelectedFilePath(cleanPath);
      setNewFilePath("");
      setNewFileContent("");
      toast.success(`已保存只读辅助文件「${cleanPath}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存辅助文件失败");
    } finally {
      setSavingFiles(false);
    }
  }

  async function handleDeleteAuxFile(targetPath: string) {
    const ok = await confirmDialog({
      title: `移除辅助文件「${targetPath}」？`,
      description: "移除后机器人将无法再通过 skill_read_file 读取此文件。",
      confirmLabel: "移除",
      destructive: true,
    });
    if (!ok) return;
    setSavingFiles(true);
    try {
      const remaining = files
        .filter((f) => f.path !== targetPath)
        .map((f) => ({ path: f.path, content: f.content }));
      await saveSkillFiles(skillSlug, remaining);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sharingKeys.skillFiles(skillSlug),
        }),
        queryClient.invalidateQueries({ queryKey: chisaSkillKeys.all }),
      ]);
      if (selectedFilePath === targetPath) setSelectedFilePath(null);
      toast.success(`已移除辅助文件「${targetPath}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "移除辅助文件失败");
    } finally {
      setSavingFiles(false);
    }
  }

  const activeAuxFile =
    files.find((f) => f.path === selectedFilePath) ?? files[0] ?? null;
  const sideRows = diffResult ? buildSideBySideRows(diffResult.lines) : [];

  return (
    <div className="flex flex-col gap-4" data-testid="skill-versions-panel">
      {/* 不可变版本历史与并排 Diff */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-muted/15 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium text-sm">
            <IconHistory className="size-4" />
            <span>{`不可变版本栈（${revisions.length}）`}</span>
          </div>
          {revisions.length >= 2 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <select
                aria-label="基准版本"
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
                onChange={(event) => setFromRevId(event.target.value)}
                value={effectiveFrom}
              >
                {revisions.map((rev) => (
                  <option key={`from-${rev.revisionId}`} value={rev.revisionId}>
                    {`${rev.contentSha256.slice(0, 8)} · ${rev.reason || "快照"}`}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">{"→"}</span>
              <select
                aria-label="目标版本"
                className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
                onChange={(event) => setToRevId(event.target.value)}
                value={effectiveTo}
              >
                {revisions.map((rev) => (
                  <option key={`to-${rev.revisionId}`} value={rev.revisionId}>
                    {`${rev.contentSha256.slice(0, 8)} · ${rev.reason || "快照"}`}
                  </option>
                ))}
              </select>
              <Button
                data-testid="skill-diff-btn"
                disabled={diffLoading || !effectiveFrom || !effectiveTo}
                onClick={() => void handleCompare()}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconGitCompare className="size-3.5" />
                {diffLoading ? "对比中…" : "并排 Diff"}
              </Button>
            </div>
          ) : null}
        </div>

        {revisionsQuery.isPending ? (
          <div className="text-muted-foreground text-xs">
            {"加载版本历史中…"}
          </div>
        ) : revisions.length === 0 ? (
          <div className="text-muted-foreground text-xs">
            {"保存技能后将自动生成按 SHA-256 寻址的不可变版本快照。"}
          </div>
        ) : (
          <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto pr-1">
            {revisions.map((rev) => {
              const isCurrent =
                rev.isCurrent || rev.revisionId === currentRevisionId;
              const shortSha = rev.contentSha256.slice(0, 10);
              return (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/60 px-3 py-2 text-xs"
                  key={rev.revisionId}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="font-mono text-[11px] font-medium">
                        {shortSha}
                      </code>
                      {isCurrent ? (
                        <span className="device-cap-chip">{"当前版本"}</span>
                      ) : null}
                      {rev.requiresTools.length > 0 ? (
                        <span className="device-cap-chip">
                          {`工具依赖：${rev.requiresTools.join(", ")}`}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-muted-foreground">
                      {`${rev.reason || "版本保存"} · 作者 ${rev.author} · ${new Date(rev.createdAt).toLocaleString()}`}
                    </div>
                  </div>
                  {!readOnly && !isCurrent ? (
                    <Button
                      data-testid={`skill-rollback-${rev.revisionId}`}
                      disabled={rollingBackId === rev.revisionId}
                      onClick={() =>
                        void handleRollback(rev.revisionId, shortSha)
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <IconRestore className="size-3.5" />
                      {rollingBackId === rev.revisionId
                        ? "回滚中…"
                        : "回滚到此版本"}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* 并排 Diff 视图 */}
        {diffResult ? (
          <div
            className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background/80 p-2.5"
            data-testid="skill-diff-view"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{"并排版本差异对比"}</span>
              <span className="font-mono text-[11px]">
                <span className="text-emerald-600 dark:text-emerald-400">
                  {`+${diffResult.addedLines}`}
                </span>
                {" / "}
                <span className="text-destructive">
                  {`-${diffResult.removedLines}`}
                </span>
              </span>
            </div>
            <div className="max-h-56 overflow-auto rounded border border-border/50 font-mono text-[11px]">
              <div className="grid grid-cols-2 divide-x divide-border/50">
                <div className="bg-muted/40 px-2 py-1 font-medium text-muted-foreground">
                  {"基准版本"}
                </div>
                <div className="bg-muted/40 px-2 py-1 font-medium text-muted-foreground">
                  {"目标版本"}
                </div>
              </div>
              {sideRows.map((row) => (
                <div
                  className="grid grid-cols-2 divide-x divide-border/40 border-border/30 border-t"
                  key={row.key}
                >
                  <div
                    className={cn(
                      "flex gap-1.5 whitespace-pre-wrap break-all px-2 py-0.5",
                      row.leftKind === "remove" &&
                        "bg-destructive/12 text-destructive",
                      row.leftKind === "empty" && "bg-muted/20",
                    )}
                  >
                    <span className="w-6 shrink-0 select-none text-right text-muted-foreground/70">
                      {row.leftLine ?? ""}
                    </span>
                    <span className="min-w-0 flex-1">{row.leftText}</span>
                  </div>
                  <div
                    className={cn(
                      "flex gap-1.5 whitespace-pre-wrap break-all px-2 py-0.5",
                      row.rightKind === "add" &&
                        "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
                      row.rightKind === "empty" && "bg-muted/20",
                    )}
                  >
                    <span className="w-6 shrink-0 select-none text-right text-muted-foreground/70">
                      {row.rightLine ?? ""}
                    </span>
                    <span className="min-w-0 flex-1">{row.rightText}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* 多文件只读辅助资源列表 */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-muted/15 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-medium text-sm">
            <IconFileCode className="size-4" />
            <span>{`多文件只读资源包（${files.length}）`}</span>
          </div>
          <span className="text-muted-foreground text-xs">
            {"除 SKILL.md 外的模板/脚本 · 单文件 ≤ 256 KiB · 模型只读"}
          </span>
        </div>

        {filesQuery.isPending ? (
          <div className="text-muted-foreground text-xs">
            {"加载附属文件中…"}
          </div>
        ) : files.length === 0 ? (
          <div className="text-muted-foreground text-xs">
            {"尚未附带辅助脚本或模板文件。"}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {files.map((file) => {
                const selected = activeAuxFile?.path === file.path;
                return (
                  <div
                    className={cn(
                      "flex items-center gap-1 rounded-lg border px-2 py-1 text-xs",
                      selected
                        ? "border-primary/50 bg-primary/10"
                        : "border-border/50 bg-background/60",
                    )}
                    key={file.path}
                  >
                    <button
                      className="font-mono"
                      onClick={() => setSelectedFilePath(file.path)}
                      type="button"
                    >
                      {file.path}
                    </button>
                    <span className="text-[11px] text-muted-foreground">
                      {`(${file.bytes}B)`}
                    </span>
                    {!readOnly ? (
                      <button
                        aria-label={`移除 ${file.path}`}
                        className="ml-1 text-muted-foreground hover:text-destructive"
                        disabled={savingFiles}
                        onClick={() => void handleDeleteAuxFile(file.path)}
                        type="button"
                      >
                        <IconTrash className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {activeAuxFile ? (
              <div className="rounded-lg border border-border/50 bg-background/70 p-2.5">
                <div className="mb-1 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                  <span>{`${activeAuxFile.path}（只读）`}</span>
                  <span>{`sha256: ${activeAuxFile.sha256.slice(0, 12)}`}</span>
                </div>
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                  {activeAuxFile.content}
                </pre>
              </div>
            ) : null}
          </div>
        )}

        {!readOnly ? (
          <div className="flex flex-col gap-2 border-border/50 border-t pt-2.5">
            <div className="font-medium text-xs text-muted-foreground">
              {"新增或更新只读辅助文件"}
            </div>
            <Input
              className="font-mono text-xs"
              data-testid="skill-aux-file-path-input"
              onChange={(event) => setNewFilePath(event.target.value)}
              placeholder="相对路径，如 templates/weekly.md 或 scripts/format.py"
              value={newFilePath}
            />
            <Textarea
              className="font-mono text-xs"
              data-testid="skill-aux-file-content-input"
              onChange={(event) => setNewFileContent(event.target.value)}
              placeholder="输入辅助模板或只读脚本文本（禁止包含密钥或 .env 内容）"
              rows={4}
              value={newFileContent}
            />
            <div className="flex justify-end">
              <Button
                data-testid="skill-aux-file-save-btn"
                disabled={savingFiles || !newFilePath.trim()}
                onClick={() => void handleAddAuxFile()}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconPlus className="size-3.5" />
                {savingFiles ? "保存中…" : "保存辅助文件"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
