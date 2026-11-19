import {
  IconAlertTriangle,
  IconCheck,
  IconDownload,
  IconFileZip,
  IconPackageExport,
  IconPackageImport,
  IconPlugConnected,
  IconRefresh,
  IconShieldCheck,
  IconShieldOff,
  IconUpload,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardBody, CardHeader, ListRow } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import { agentKeys, agentListQueryOptions } from "@/lib/agents/queries";
import { chisaSkillKeys } from "@/lib/chisa-skills";
import {
  commitImportZip,
  createExportDraft,
  downloadExportZip,
  previewImportZip,
} from "@/lib/sharing";
import { cn } from "@/lib/utils";
import type {
  ShareExportDraft,
  ShareImportCommitResult,
  ShareImportPreview,
  ShareSafetyFinding,
} from "../../../../shared/sharing";

type WorkbenchMode = "export" | "import";

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SafetyBanner({
  findings,
  blocked,
  cleanLabel,
}: {
  findings: readonly ShareSafetyFinding[];
  blocked: boolean;
  cleanLabel: string;
}) {
  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-700 text-xs dark:text-emerald-300">
        <IconShieldCheck className="size-4 shrink-0" />
        <span>{cleanLabel}</span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-xs",
        blocked
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
      )}
    >
      <div className="flex items-center gap-2 font-medium">
        {blocked ? (
          <IconShieldOff className="size-4 shrink-0" />
        ) : (
          <IconAlertTriangle className="size-4 shrink-0" />
        )}
        <span>
          {blocked
            ? "安全拦截：检测到阻断级凭据或禁传文件，必须清理后才能继续"
            : `安全体检提醒（${findings.length} 项）`}
        </span>
      </div>
      <ul className="flex flex-col gap-1 pl-6">
        {findings.map((finding) => (
          <li
            className="list-disc"
            key={`${finding.rule}:${finding.location ?? ""}:${finding.message}`}
          >
            <span>{finding.message}</span>
            {finding.excerpt ? (
              <code className="ml-1.5 rounded bg-background/60 px-1 py-0.5 font-mono text-[11px]">
                {finding.excerpt}
              </code>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Bot 配方与多文件技能脱敏分享工作台（Wave 5）：
 * - 导出：选机器人 → 组装脱敏草稿 → 安全扫描 → 记忆默认全不选逐条 opt-in → 定时任务强制暂停 → 下载 .zip
 * - 导入：拖入/选择 .zip → 依赖缺失体检 + 触发器剥离审核 + 记忆默认全不选逐条 opt-in → 断点续导提交
 */
export function SharingWorkbench() {
  const queryClient = useQueryClient();
  const botsQuery = useQuery(agentListQueryOptions());
  const bots = botsQuery.data ?? [];

  const [mode, setMode] = useState<WorkbenchMode>("export");

  // ── 导出状态 ───────────────────────────────────────────
  const [selectedBotId, setSelectedBotId] = useState("");
  const [draft, setDraft] = useState<ShareExportDraft | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [exportSkills, setExportSkills] = useState<string[]>([]);
  const [exportSchedules, setExportSchedules] = useState<number[]>([]);
  // 记忆默认恒为空数组，必须逐条勾选
  const [exportMemories, setExportMemories] = useState<number[]>([]);
  const [downloading, setDownloading] = useState(false);

  // ── 导入状态 ───────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ShareImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importId, setImportId] = useState("");
  // 导入记忆同样默认恒为空数组，必须逐条勾选
  const [importMemories, setImportMemories] = useState<number[]>([]);
  const [committing, setCommitting] = useState(false);
  const [commitFailed, setCommitFailed] = useState<string | null>(null);
  const [commitResult, setCommitResult] =
    useState<ShareImportCommitResult | null>(null);

  const effectiveBotId = selectedBotId || bots[0]?.id || "";

  async function handleBuildDraft() {
    if (!effectiveBotId) {
      toast.error("请先选择一个要导出的机器人。");
      return;
    }
    setDraftLoading(true);
    try {
      const next = await createExportDraft(effectiveBotId);
      setDraft(next);
      setExportSkills(next.selectedSkillSlugs);
      setExportSchedules(next.selectedScheduleIndices);
      // 强制归零，绝不沿用上次记忆勾选
      setExportMemories([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "组装导出草稿失败");
    } finally {
      setDraftLoading(false);
    }
  }

  async function handleDownloadZip() {
    if (!draft) return;
    setDownloading(true);
    try {
      const packed = await downloadExportZip({
        botId: draft.botId,
        selectedSkillSlugs: exportSkills,
        selectedScheduleIndices: exportSchedules,
        selectedMemoryIndices: exportMemories,
      });
      triggerBlobDownload(packed.blob, packed.filename);
      toast.success(`已脱敏导出配方包「${packed.filename}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出配方 ZIP 失败");
    } finally {
      setDownloading(false);
    }
  }

  async function handleInspectZipFile(file: File) {
    setImportFile(file);
    setPreview(null);
    setCommitResult(null);
    setCommitFailed(null);
    setImportMemories([]);
    setPreviewLoading(true);
    try {
      const result = await previewImportZip(file);
      setPreview(result);
      setImportId(result.suggestedImportId);
      setImportMemories([]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "解析配方 ZIP 失败");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCommitImport() {
    if (!importFile || !preview || !importId) return;
    setCommitting(true);
    setCommitFailed(null);
    try {
      const result = await commitImportZip({
        file: importFile,
        importId,
        packageDigest: preview.packageDigest,
        selectedMemoryIndices: importMemories,
      });
      setCommitResult(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: agentKeys.all }),
        queryClient.invalidateQueries({ queryKey: chisaSkillKeys.all }),
      ]);
      toast.success(
        result.reused
          ? "已从断点续导完成（未重复创建已有项）"
          : "配方包导入成功，所有定时任务已保持暂停态",
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "导入中途失败";
      setCommitFailed(msg);
      toast.error(msg);
    } finally {
      setCommitting(false);
    }
  }

  const toggleSkill = (slug: string, checked: boolean) => {
    setExportSkills((prev) =>
      checked
        ? prev.includes(slug)
          ? prev
          : [...prev, slug]
        : prev.filter((item) => item !== slug),
    );
  };

  const toggleSchedule = (index: number, checked: boolean) => {
    setExportSchedules((prev) =>
      checked
        ? prev.includes(index)
          ? prev
          : [...prev, index].sort((a, b) => a - b)
        : prev.filter((item) => item !== index),
    );
  };

  const toggleExportMemory = (index: number, checked: boolean) => {
    setExportMemories((prev) =>
      checked
        ? prev.includes(index)
          ? prev
          : [...prev, index].sort((a, b) => a - b)
        : prev.filter((item) => item !== index),
    );
  };

  const toggleImportMemory = (index: number, checked: boolean) => {
    setImportMemories((prev) =>
      checked
        ? prev.includes(index)
          ? prev
          : [...prev, index].sort((a, b) => a - b)
        : prev.filter((item) => item !== index),
    );
  };

  return (
    <PageSection
      description="脱敏打包机器人人设、多文件技能包、暂停态定时任务与插件依赖元数据为 .zip；自动拦截私钥/API 密钥与 .env/.db 文件，双端记忆默认全空需逐条勾选，导入支持缺失依赖体检与断点续导。"
      settingItem="share.share-recipes"
      title="路径三 · Bot 配方与多文件技能包导入 / 导出"
    >
      <Card className="mem-card" data-testid="sharing-workbench-card">
        <CardHeader
          action={
            <div
              aria-label="分享配方模式"
              className="sg-segmented"
              role="tablist"
            >
              <button
                aria-selected={mode === "export"}
                className={cn(mode === "export" && "is-on")}
                data-testid="sharing-mode-export"
                onClick={() => setMode("export")}
                role="tab"
                type="button"
              >
                {"导出脱敏 ZIP"}
              </button>
              <button
                aria-selected={mode === "import"}
                className={cn(mode === "import" && "is-on")}
                data-testid="sharing-mode-import"
                onClick={() => setMode("import")}
                role="tab"
                type="button"
              >
                {"导入 ZIP 配方"}
              </button>
            </div>
          }
          description="密钥零出境 · 记忆逐条勾选 · 定时任务强制暂停 · 断点续导不重复"
          icon={<IconFileZip className="size-5" />}
          title="Bot 配方与技能包工作台"
        />

        <CardBody className="flex flex-col gap-4">
          {mode === "export" ? (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex min-w-[220px] flex-1 flex-col gap-1.5">
                  <span className="font-medium text-xs text-muted-foreground">
                    {"选择要打包分享的机器人"}
                  </span>
                  <select
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                    data-testid="sharing-export-bot-select"
                    disabled={botsQuery.isPending || bots.length === 0}
                    onChange={(event) => {
                      setSelectedBotId(event.target.value);
                      setDraft(null);
                      setExportMemories([]);
                    }}
                    value={effectiveBotId}
                  >
                    {bots.length === 0 ? (
                      <option value="">{"暂无可导出的机器人"}</option>
                    ) : (
                      bots.map((bot) => (
                        <option key={bot.id} value={bot.id}>
                          {`${bot.name}${bot.title && bot.title !== bot.name ? ` · ${bot.title}` : ""}`}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <Button
                  data-testid="sharing-build-draft-btn"
                  disabled={!effectiveBotId || draftLoading}
                  onClick={() => void handleBuildDraft()}
                  size="sm"
                  type="button"
                >
                  <IconPackageExport className="size-4" />
                  {draftLoading ? "正在体检并组装…" : "组装脱敏草稿"}
                </Button>
              </div>

              {draft ? (
                <div
                  className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/15 p-4"
                  data-testid="sharing-export-draft"
                >
                  <SafetyBanner
                    blocked={draft.blocked}
                    cleanLabel="密钥与禁传文件体检通过（未检测到 API 密钥、私钥或敏感数据库文件）"
                    findings={draft.safetyFindings}
                  />

                  <div className="rounded-lg border border-border/50 bg-background/60 p-3">
                    <div className="font-medium text-sm">
                      {`人设预览：${draft.bot.name}`}
                    </div>
                    {draft.bot.title ? (
                      <div className="text-muted-foreground text-xs">
                        {draft.bot.title}
                      </div>
                    ) : null}
                    {draft.bot.roleDescription ? (
                      <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-muted-foreground text-xs">
                        {draft.bot.roleDescription}
                      </p>
                    ) : null}
                  </div>

                  {/* 技能勾选 */}
                  <div className="flex flex-col gap-2">
                    <div className="font-medium text-xs text-muted-foreground">
                      {`附带技能（已选 ${exportSkills.length} / ${draft.skills.length}，含多文件只读资源）`}
                    </div>
                    {draft.skills.length === 0 ? (
                      <div className="text-muted-foreground text-xs">
                        {"当前账号下没有技能可附带。"}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {draft.skills.map((skill) => {
                          const checked = exportSkills.includes(skill.slug);
                          return (
                            <label
                              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-xs"
                              key={skill.slug}
                            >
                              <Checkbox
                                checked={checked}
                                className="mt-0.5"
                                onCheckedChange={(val) =>
                                  toggleSkill(skill.slug, Boolean(val))
                                }
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5 font-medium">
                                  <span>{skill.title}</span>
                                  <span className="font-mono text-[11px] text-muted-foreground">
                                    {`/${skill.slug}`}
                                  </span>
                                  {skill.files?.length ? (
                                    <span className="device-cap-chip">
                                      {`${skill.files.length} 个附属文件`}
                                    </span>
                                  ) : null}
                                  {skill.requiresTools?.length ? (
                                    <span className="device-cap-chip">
                                      {`依赖 ${skill.requiresTools.length} 个工具`}
                                    </span>
                                  ) : null}
                                </div>
                                {skill.summary ? (
                                  <div className="mt-0.5 text-muted-foreground">
                                    {skill.summary}
                                  </div>
                                ) : null}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* 定时任务（双端强制暂停） */}
                  <div className="flex flex-col gap-2">
                    <div className="font-medium text-xs text-muted-foreground">
                      {`定时任务（已选 ${exportSchedules.length} / ${draft.schedules.length} · 安全红线：导出强制 enabled: false 暂停态）`}
                    </div>
                    {draft.schedules.length === 0 ? (
                      <div className="text-muted-foreground text-xs">
                        {"该机器人暂无定时任务。"}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {draft.schedules.map((sched, schedIdx) => {
                          const checked = exportSchedules.includes(schedIdx);
                          return (
                            <label
                              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-xs"
                              key={`${sched.title}:${sched.cron ?? sched.kind}:${sched.instruction.slice(0, 24)}`}
                            >
                              <Checkbox
                                checked={checked}
                                className="mt-0.5"
                                onCheckedChange={(val) =>
                                  toggleSchedule(schedIdx, Boolean(val))
                                }
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5 font-medium">
                                  <span>{sched.title}</span>
                                  <span className="device-cap-chip is-off">
                                    {"导出暂停"}
                                  </span>
                                  {sched.cron ? (
                                    <span className="font-mono text-[11px] text-muted-foreground">
                                      {sched.cron}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                                  {sched.instruction}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* 插件依赖元数据 */}
                  {draft.dependencies.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="font-medium text-xs text-muted-foreground">
                        {`依赖插件 / MCP 元数据（${draft.dependencies.length} 项 · 仅声明名称与工具，绝不含密钥与登录态）`}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {draft.dependencies.map((dep) => (
                          <span className="device-cap-chip" key={dep.pluginId}>
                            <IconPlugConnected className="mr-1 inline size-3" />
                            {`${dep.name} (${dep.tools.length})`}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* 候选记忆逐条勾选（安全默认全不选） */}
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-xs text-muted-foreground">
                        {`候选记忆（默认全不选 · 当前已显式勾选 ${exportMemories.length} / ${draft.candidateMemories.length} 条）`}
                      </span>
                      {exportMemories.length > 0 ? (
                        <Button
                          onClick={() => setExportMemories([])}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          {"全部取消勾选"}
                        </Button>
                      ) : null}
                    </div>
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-amber-800 text-xs dark:text-amber-200">
                      {
                        "隐私保护默认：导出包不包含任何记忆。仅当某条背景知识确实适合分享时，请逐条勾选并确认不含个人敏感信息或密钥。"
                      }
                    </div>
                    {draft.candidateMemories.length > 0 ? (
                      <div className="flex max-h-52 flex-col gap-1.5 overflow-y-auto pr-1">
                        {draft.candidateMemories.map((mem) => {
                          const checked = exportMemories.includes(mem.index);
                          return (
                            <label
                              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-xs"
                              key={mem.id ?? `exp-mem-${mem.index}`}
                            >
                              <Checkbox
                                checked={checked}
                                className="mt-0.5"
                                data-testid={`sharing-export-mem-${mem.index}`}
                                onCheckedChange={(val) =>
                                  toggleExportMemory(mem.index, Boolean(val))
                                }
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="device-cap-chip">
                                    {mem.kind}
                                  </span>
                                  {mem.subject ? (
                                    <span className="font-medium">
                                      {mem.subject}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                                  {mem.content}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2 border-border/50 border-t pt-3">
                    <Button
                      data-testid="sharing-download-zip-btn"
                      disabled={draft.blocked || downloading}
                      onClick={() => void handleDownloadZip()}
                      size="sm"
                      type="button"
                    >
                      <IconDownload className="size-4" />
                      {downloading ? "正在脱敏打包…" : "校验脱敏并下载 .zip"}
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <>
              {/* 拖入或选择 ZIP */}
              <input
                accept=".zip,application/zip"
                className="hidden"
                data-testid="sharing-import-file-input"
                onChange={(event) => {
                  const picked = event.target.files?.[0];
                  if (picked) void handleInspectZipFile(picked);
                  event.target.value = "";
                }}
                ref={fileInputRef}
                type="file"
              />
              <button
                className={cn(
                  "flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
                  dragActive
                    ? "border-primary bg-primary/10"
                    : "border-border/70 bg-muted/15 hover:bg-muted/25",
                )}
                data-testid="sharing-import-dropzone"
                disabled={previewLoading}
                onClick={() => fileInputRef.current?.click()}
                onDragLeave={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  ) {
                    setDragActive(false);
                  }
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                  if (!dragActive) setDragActive(true);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragActive(false);
                  const dropped = event.dataTransfer.files[0];
                  if (dropped) void handleInspectZipFile(dropped);
                }}
                type="button"
              >
                <IconUpload className="size-6 text-muted-foreground" />
                <div className="font-medium text-sm">
                  {previewLoading
                    ? "正在体检解包…"
                    : importFile
                      ? `已选择：${importFile.name}（${Math.max(1, Math.round(importFile.size / 1024))} KiB）· 点击或拖入替换`
                      : "将配方 .zip 文件拖到这里，或点击选择文件预览"}
                </div>
                <div className="text-muted-foreground text-xs">
                  {
                    "纯内存有界解包（≤ 20 MiB / ≤ 200 文件 / 解压 ≤ 50 MiB），自动拦截路径穿越、压缩炸弹与明文密钥"
                  }
                </div>
              </button>

              {preview ? (
                <div
                  className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/15 p-4"
                  data-testid="sharing-import-preview"
                >
                  <SafetyBanner
                    blocked={preview.blocked}
                    cleanLabel={`安全体检通过 · 摘要 ${preview.packageDigest.slice(0, 12)} · 定时任务将强制暂停`}
                    findings={preview.safetyFindings}
                  />

                  {preview.bot ? (
                    <ListRow
                      sub={
                        <span className="mem-body">
                          {preview.bot.roleDescription || preview.bot.title}
                        </span>
                      }
                      title={`将创建新机器人：${preview.bot.name}`}
                    />
                  ) : null}

                  {/* 依赖体检 */}
                  {preview.dependencies.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      <div className="font-medium text-xs text-muted-foreground">
                        {"插件 / MCP 依赖体检"}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {preview.dependencies.map((dep) => (
                          <div
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-xs"
                            key={dep.pluginId}
                          >
                            <div className="min-w-0 flex-1">
                              <span className="font-medium">{dep.name}</span>
                              <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                                {dep.pluginId}
                              </span>
                              {dep.missingTools.length > 0 ? (
                                <div className="mt-0.5 text-amber-700 dark:text-amber-300">
                                  {`缺少工具：${dep.missingTools.join("、")}`}
                                </div>
                              ) : null}
                            </div>
                            <span
                              className={cn(
                                "device-cap-chip",
                                !dep.installed && "is-off",
                              )}
                            >
                              {dep.installed ? "已安装" : "缺失依赖"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* 技能与触发器剥离审核 */}
                  {preview.skills.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="font-medium text-xs text-muted-foreground">
                        {`技能清单（${preview.skills.length} 个，已自动剥离外部触发器与特权声明）`}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {preview.skills.map((skill) => (
                          <div
                            className="rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-xs"
                            key={skill.slug}
                          >
                            <div className="flex flex-wrap items-center gap-1.5 font-medium">
                              <span>{skill.title}</span>
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {`/${skill.slug}`}
                              </span>
                              {preview.conflictingSkillSlugs.includes(
                                skill.slug,
                              ) ? (
                                <span className="device-cap-chip is-off">
                                  {"同名技能将更新/自动防冲突"}
                                </span>
                              ) : null}
                              {skill.files?.length ? (
                                <span className="device-cap-chip">
                                  {`${skill.files.length} 个只读辅助文件`}
                                </span>
                              ) : null}
                            </div>
                            {skill.strippedFrontmatterKeys?.length ? (
                              <div className="mt-1 text-amber-700 dark:text-amber-300">
                                {`已自动剥离特权/触发器字段：${skill.strippedFrontmatterKeys.join("、")}`}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* 定时任务（导入强制暂停） */}
                  {preview.schedules.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="font-medium text-xs text-muted-foreground">
                        {`定时任务（${preview.schedules.length} 个 · 全部以暂停态 enabled: false 导入）`}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {preview.schedules.map((sched) => (
                          <span
                            className="device-cap-chip is-off"
                            key={`${sched.title}:${sched.cron ?? sched.kind}`}
                          >
                            {`${sched.title}${sched.cron ? ` (${sched.cron})` : ""} · 暂停`}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* 导入候选记忆（默认全不选，逐条 opt-in） */}
                  {preview.candidateMemories.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      <div className="font-medium text-xs text-muted-foreground">
                        {`源包附带的候选记忆（安全默认：不导入任何记忆 · 当前勾选 ${importMemories.length} / ${preview.candidateMemories.length} 条）`}
                      </div>
                      <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1">
                        {preview.candidateMemories.map((mem) => {
                          const checked = importMemories.includes(mem.index);
                          return (
                            <label
                              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-xs"
                              key={`imp-mem-${mem.index}-${mem.subject ?? mem.kind}`}
                            >
                              <Checkbox
                                checked={checked}
                                className="mt-0.5"
                                data-testid={`sharing-import-mem-${mem.index}`}
                                onCheckedChange={(val) =>
                                  toggleImportMemory(mem.index, Boolean(val))
                                }
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="device-cap-chip">
                                    {mem.kind}
                                  </span>
                                  {mem.subject ? (
                                    <span className="font-medium">
                                      {mem.subject}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                                  {mem.content}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {commitFailed ? (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
                      {`上次导入中途中断：${commitFailed}。同一导入会话（${importId.slice(0, 8)}）已保存断点，点击下方按钮可安全续导且不重复创建已成功项。`}
                    </div>
                  ) : null}

                  {commitResult ? (
                    <div
                      className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-emerald-800 text-xs dark:text-emerald-200"
                      data-testid="sharing-import-result"
                    >
                      <IconCheck className="mt-0.5 size-4 shrink-0" />
                      <div className="flex flex-col gap-0.5">
                        <div className="font-medium">
                          {commitResult.bot
                            ? `导入完成：已创建机器人「${commitResult.bot.name}」`
                            : "技能包导入完成"}
                        </div>
                        <div>
                          {`技能 ${commitResult.skillsImported.length} 个 · 暂停态定时任务 ${commitResult.schedulesImported.length} 个 · 已勾选记忆 ${commitResult.memoriesImportedCount} 条`}
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-2 border-border/50 border-t pt-3">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {`幂等导入 ID：${importId.slice(0, 12)}`}
                    </span>
                    <Button
                      data-testid="sharing-import-commit-btn"
                      disabled={preview.blocked || committing}
                      onClick={() => void handleCommitImport()}
                      size="sm"
                      type="button"
                    >
                      {commitFailed ? (
                        <IconRefresh className="size-4" />
                      ) : (
                        <IconPackageImport className="size-4" />
                      )}
                      {committing
                        ? "正在导入…"
                        : commitFailed
                          ? "从断点继续导入"
                          : commitResult
                            ? "再次确认幂等状态"
                            : "确认并导入配方"}
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardBody>
      </Card>
    </PageSection>
  );
}
