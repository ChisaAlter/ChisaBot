import {
  IconEye,
  IconFileDiff,
  IconHistory,
  IconRefresh,
  IconRestore,
  IconTool,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, ErrorCard } from "@/components/ui/skyglass";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  computeLineDiff,
  MAX_PROMPT_BYTES,
  type PromptRole,
  type PromptRoleDetail,
  promptDetailQueryOptions,
  promptRolesQueryOptions,
  savePromptRole,
  workbenchKeys,
} from "@/lib/admin-workbench";
import { ClientError } from "@/lib/client";

type CompareTarget = "original" | "current" | "previous";

const COMPARE_LABELS: Record<CompareTarget, string> = {
  original: "原版提示词",
  current: "当前已保存版本",
  previous: "上一个修订版",
};

const ACTION_LABELS: Record<string, string> = {
  edit: "手动编辑",
  "restore-original": "恢复原版",
  "restore-previous": "回滚上一版",
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "尚未修改";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString("zh-CN", { hour12: false });
}

function PromptRoleEditor({ detail }: { detail: PromptRoleDetail }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(detail.content);
  const [compareTarget, setCompareTarget] = useState<CompareTarget>("original");
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const effectiveCompareTarget: CompareTarget =
    compareTarget === "previous" && !detail.previous
      ? "original"
      : compareTarget;

  const comparisonText =
    effectiveCompareTarget === "original"
      ? detail.original
      : effectiveCompareTarget === "previous"
        ? (detail.previous?.content ?? detail.original)
        : detail.content;

  const diff = useMemo(
    () => computeLineDiff(comparisonText, draft, 3),
    [comparisonText, draft],
  );

  const diffRows = useMemo(() => {
    let gapSerial = 0;
    return diff.display.map((entry) => {
      if (entry.kind === "gap") {
        gapSerial += 1;
        return {
          key: `gap:${gapSerial}:${entry.omittedLines}`,
          entry,
        };
      }
      return {
        key: `${entry.kind}:${entry.beforeLine ?? "n"}:${entry.afterLine ?? "n"}`,
        entry,
      };
    });
  }, [diff.display]);

  async function refreshAll() {
    setConflictMessage(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: workbenchKeys.promptRoles }),
      queryClient.invalidateQueries({
        queryKey: workbenchKeys.promptDetail(detail.role),
      }),
    ]);
  }

  async function performSave(restore?: "original" | "previous") {
    setConflictMessage(null);
    try {
      const updated = await savePromptRole(detail.role, {
        digest: detail.originalDigest,
        expectedRevision: detail.revision,
        ...(restore ? { restore } : { content: draft }),
      });
      setDraft(updated.content);
      toast.success(
        restore === "original"
          ? "已恢复为原版提示词。"
          : restore === "previous"
            ? "已回滚到上一个修订版本。"
            : `已保存为 v${updated.revision}，下一回合起冻结生效。`,
      );
      await refreshAll();
    } catch (error) {
      if (error instanceof ClientError && error.status === 409) {
        setConflictMessage(error.message);
      }
      throw error;
    }
  }

  const saveAction = useAsyncAction(() => performSave(), {
    errorToast: (error) => error.message,
  });
  const restoreOriginalAction = useAsyncAction(() => performSave("original"), {
    errorToast: (error) => error.message,
  });
  const restorePreviousAction = useAsyncAction(() => performSave("previous"), {
    errorToast: (error) => error.message,
  });

  const isDirty = draft !== detail.content;
  const isModifiedFromOriginal = detail.content !== detail.original;
  const busy =
    saveAction.state === "pending" ||
    restoreOriginalAction.state === "pending" ||
    restorePreviousAction.state === "pending";

  return (
    <div className="space-y-5">
      {conflictMessage ? (
        <Card className="border-destructive/50 p-4 text-sm" role="alert">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-destructive">{conflictMessage}</span>
            <Button
              onClick={() => void refreshAll()}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconRefresh className="size-3.5" />
              {"重新加载最新版本"}
            </Button>
          </div>
        </Card>
      ) : null}

      {/* 双栏对照与编辑区 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              className="font-medium text-sm"
              htmlFor="prompt-compare-target"
            >
              {"只读对照版本"}
            </label>
            <Select
              onValueChange={(value) => {
                if (
                  value === "original" ||
                  value === "current" ||
                  value === "previous"
                ) {
                  setCompareTarget(value);
                }
              }}
              value={effectiveCompareTarget}
            >
              <SelectTrigger className="w-44" id="prompt-compare-target">
                <SelectValue>
                  {COMPARE_LABELS[effectiveCompareTarget]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="original">原版提示词</SelectItem>
                <SelectItem value="current">当前已保存版本</SelectItem>
                <SelectItem disabled={!detail.previous} value="previous">
                  上一个修订版
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {comparisonText}
          </pre>
        </Card>

        <Card className="p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              className="font-medium text-sm"
              htmlFor="prompt-draft-textarea"
            >
              {`编辑草稿 · ${detail.modified ? `v${detail.revision}（已覆写）` : "原版"}`}
            </label>
            <span className="font-mono text-muted-foreground text-xs">
              {`${draft.length} 字符 · 上限 ${Math.round(MAX_PROMPT_BYTES / 1024)} KiB`}
            </span>
          </div>
          <Textarea
            className="min-h-72 max-h-96 font-mono text-xs leading-relaxed"
            disabled={busy}
            id="prompt-draft-textarea"
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            value={draft}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="font-mono text-muted-foreground text-xs">
              {`摘要 ${detail.originalDigest.slice(0, 12)} · 更新于 ${formatDateTime(detail.updatedAt)}`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={busy || !isModifiedFromOriginal}
                onClick={() => void restoreOriginalAction.run()}
                size="sm"
                state={restoreOriginalAction.state}
                type="button"
                variant="outline"
              >
                <IconRestore className="size-3.5" />
                {"恢复原版"}
              </Button>
              <Button
                disabled={busy || !detail.previous}
                onClick={() => void restorePreviousAction.run()}
                size="sm"
                state={restorePreviousAction.state}
                type="button"
                variant="outline"
              >
                <IconHistory className="size-3.5" />
                {"恢复上一版"}
              </Button>
              <Button
                disabled={busy || !isDirty || !draft.trim()}
                feedback="save"
                onClick={() => void saveAction.run()}
                size="sm"
                state={saveAction.state}
                type="button"
              >
                {"保存新版本"}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {/* 实时 LCS 行级 Diff */}
      <Card className="p-4 space-y-3" data-testid="prompt-lcs-diff">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center gap-2 font-medium text-sm">
            <IconFileDiff className="size-4" />
            {`实时行级差异（对照：${COMPARE_LABELS[effectiveCompareTarget]}）`}
          </div>
          <div className="font-mono text-xs">
            <span className="text-emerald-600 dark:text-emerald-400">
              {`+${diff.added}`}
            </span>
            {" / "}
            <span className="text-destructive">{`-${diff.removed}`}</span>
            {diff.usedFallback ? " · 超大文本快速对比" : " · LCS 精确对比"}
          </div>
        </div>

        {diff.added === 0 && diff.removed === 0 ? (
          <p className="text-muted-foreground text-xs">
            {"当前编辑内容与所选对照版本完全一致。"}
          </p>
        ) : (
          <div className="max-h-72 overflow-auto rounded-lg border font-mono text-xs">
            {diffRows.map(({ key, entry }) => {
              if (entry.kind === "gap") {
                return (
                  <div
                    className="border-y bg-muted/40 px-3 py-1 text-center text-muted-foreground"
                    key={key}
                  >
                    {`⋯ 已折叠 ${entry.omittedLines} 行未变更上下文 ⋯`}
                  </div>
                );
              }
              const rowClass =
                entry.kind === "add"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : entry.kind === "remove"
                    ? "bg-destructive/10 text-destructive"
                    : "text-muted-foreground";
              const prefix =
                entry.kind === "add"
                  ? "+"
                  : entry.kind === "remove"
                    ? "−"
                    : " ";
              return (
                <div
                  className={`flex gap-2 whitespace-pre-wrap break-all px-3 py-0.5 ${rowClass}`}
                  key={key}
                >
                  <span className="w-8 shrink-0 select-none text-right opacity-60">
                    {entry.beforeLine ?? ""}
                  </span>
                  <span className="w-8 shrink-0 select-none text-right opacity-60">
                    {entry.afterLine ?? ""}
                  </span>
                  <span className="w-3 shrink-0 select-none">{prefix}</span>
                  <span className="min-w-0 flex-1">{entry.line || " "}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* 最近一轮脱敏组装与生效工具透视 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4 space-y-3" data-testid="prompt-assembly-preview">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-2 font-medium text-sm">
              <IconEye className="size-4" />
              {"最近一轮脱敏提示词组装"}
            </div>
            <span className="text-muted-foreground text-xs">
              {detail.assembly
                ? `${formatDateTime(detail.assembly.recordedAt)} · v${detail.assembly.revision}`
                : "尚无运行记录"}
            </span>
          </div>
          {detail.assembly ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
              {detail.assembly.assembledPreview}
            </pre>
          ) : (
            <PageEmpty>
              {
                "该角色运行过一轮后，这里会展示分段组装骨架，所有用户隐私与记忆段落自动脱敏为 [动态内容已隐藏]。"
              }
            </PageEmpty>
          )}
        </Card>

        <Card className="p-4 space-y-3" data-testid="prompt-toolset-preview">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-2 font-medium text-sm">
              <IconTool className="size-4" />
              {"最近一轮生效工具清单"}
            </div>
            <span className="text-muted-foreground text-xs">
              {detail.toolset
                ? `${detail.toolset.tools.length} 个工具`
                : "尚未记录"}
            </span>
          </div>
          {detail.toolset && detail.toolset.tools.length > 0 ? (
            <div className="max-h-64 space-y-1.5 overflow-auto pr-1">
              {detail.toolset.tools.map((tool) => (
                <div
                  className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs"
                  key={`${tool.source}:${tool.name}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono font-medium">
                      {tool.name}
                    </div>
                    {tool.identifier ? (
                      <div className="truncate text-muted-foreground">
                        {tool.identifier}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
                      {tool.source}
                    </span>
                    <span className="rounded border px-1.5 py-0.5 text-muted-foreground">
                      {tool.placement === "dynamic" ? "动态装配" : "静态内置"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <PageEmpty>{"最近一轮暂无已记录工具。"}</PageEmpty>
          )}
        </Card>
      </div>

      {/* 历史修订记录（最多 30 版） */}
      {detail.revisions.length > 0 ? (
        <Card className="p-4 space-y-2">
          <div className="font-medium text-sm">
            {`修订历史（保留最近 30 版，当前共 ${detail.revisions.length} 条）`}
          </div>
          <div className="max-h-48 space-y-1.5 overflow-auto text-xs">
            {[...detail.revisions].reverse().map((rev) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-1.5"
                key={`rev-${rev.number}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold">{`v${rev.number}`}</span>
                  <span>{ACTION_LABELS[rev.action] ?? rev.action}</span>
                  <span className="font-mono text-muted-foreground">
                    {rev.digest.slice(0, 10)}
                  </span>
                </div>
                <span className="text-muted-foreground tabular-nums">
                  {formatDateTime(rev.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

export function PromptWorkbench() {
  const rolesQuery = useQuery(promptRolesQueryOptions());
  const [selectedRole, setSelectedRole] = useState<PromptRole>("parent");
  const detailQuery = useQuery(promptDetailQueryOptions(selectedRole));

  return (
    <PageSection
      action={
        <Button
          disabled={rolesQuery.isFetching || detailQuery.isFetching}
          onClick={() => {
            void rolesQuery.refetch();
            void detailQuery.refetch();
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <IconRefresh className="size-3.5" />
          {"刷新"}
        </Button>
      }
      description="集中管理 7 类内置角色的基础系统提示词，支持 30 版历史与 409 乐观锁防并发覆盖、实时 LCS 差异对比、单回合快照冻结，以及最近一轮脱敏组装与生效工具透视。"
      settingItem="workbench.prompt-workbench"
      title="多角色系统提示词版本工作台"
    >
      {rolesQuery.isPending ? (
        <PageSkeleton rows={4} />
      ) : rolesQuery.error || !rolesQuery.data ? (
        <ErrorCard
          action={
            <Button
              onClick={() => void rolesQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              {"重试"}
            </Button>
          }
          description={rolesQuery.error?.message ?? "无法读取系统提示词角色。"}
          title="提示词工作台暂时不可用"
        />
      ) : (
        <div className="space-y-4" data-testid="prompt-workbench">
          <div className="flex flex-wrap gap-2">
            {rolesQuery.data.map((item) => {
              const active = item.role === selectedRole;
              return (
                <Button
                  key={item.role}
                  onClick={() => setSelectedRole(item.role)}
                  size="sm"
                  type="button"
                  variant={active ? "default" : "outline"}
                >
                  {item.label}
                  {item.modified ? ` · v${item.revision}` : ""}
                </Button>
              );
            })}
          </div>

          {detailQuery.isPending ? (
            <PageSkeleton rows={4} tall />
          ) : detailQuery.error || !detailQuery.data ? (
            <ErrorCard
              description={
                detailQuery.error?.message ?? "无法加载该角色提示词详情。"
              }
              title="角色详情加载失败"
            />
          ) : (
            <PromptRoleEditor
              detail={detailQuery.data}
              key={`${detailQuery.data.role}:${detailQuery.data.revision}:${detailQuery.data.originalDigest}`}
            />
          )}
        </div>
      )}
    </PageSection>
  );
}
