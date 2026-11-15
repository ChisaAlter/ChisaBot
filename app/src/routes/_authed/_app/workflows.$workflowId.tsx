import { requireExtra } from "@/lib/deployment/extras";
import { IconCopy, IconDownload, IconLock, IconPlayerPlayFilled, IconPlus } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  emptyWorkflow,
  type WorkflowDefinition,
  workflowDefinitionSchema,
  workflowProblems,
} from "../../../../../shared/workflows";
import { PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { WorkflowEditor } from "@/components/workflows/editor";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Card, ErrorCard, SaveBar } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  downloadWorkflow,
  WorkflowSaveError,
  workflowDetailQueryOptions,
  workflowKeys,
  workflowsApi,
} from "@/lib/workflows";

export const Route = createFileRoute("/_authed/_app/workflows/$workflowId")({
  // 功能精简（DESIGN.md §74）：默认隐藏，CHISABOT_EXTRAS 含 workflows 才能进。
  beforeLoad: requireExtra("workflows"),
  component: WorkflowEditPage,
});

/** 客户端先用和服务器同一套规则检查，保存时服务器再查一次。 */
function clientProblems(def: WorkflowDefinition): string[] {
  const parsed = workflowDefinitionSchema.safeParse(def);
  if (!parsed.success)
    return parsed.error.issues.slice(0, 12).map((issue) => {
      const where = issue.path.map((p) => (typeof p === "number" ? `[${p + 1}]` : `.${String(p)}`)).join("").replace(/^\./, "");
      return where ? `${where}：${issue.message}` : issue.message;
    });
  return workflowProblems(parsed.data);
}

function WorkflowEditPage() {
  const { workflowId } = Route.useParams();
  const isNew = workflowId === "new";
  const detail = useQuery({ ...workflowDetailQueryOptions(workflowId), enabled: !isNew });
  const [draft, setDraft] = useState<WorkflowDefinition | null>(isNew ? emptyWorkflow() : null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [view, setView] = useState<"form" | "file">("form");
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const saved = detail.data?.workflow;
  const [loadedFor, setLoadedFor] = useState<string | null>(isNew ? "new" : null);
  // 载入（以及换了一个工作流，比如复制后跳过来）时把草稿换成它。
  if (isNew && loadedFor !== "new") {
    setDraft(emptyWorkflow());
    setLoadedFor("new");
    setServerProblems([]);
  } else if (!isNew && saved && saved.id === workflowId && loadedFor !== workflowId) {
    setDraft(structuredClone(saved.definition));
    setLoadedFor(workflowId);
    setServerProblems([]);
  }

  const readOnly = saved?.kind === "preset";
  const dirty = useMemo(() => {
    if (!draft) return false;
    if (isNew) return true;
    return !!saved && JSON.stringify(saved.definition) !== JSON.stringify(draft);
  }, [draft, saved, isNew]);
  const problems = useMemo(() => (draft && !readOnly ? clientProblems(draft) : []), [draft, readOnly]);

  const save = useAsyncAction(async () => {
    if (!draft) return;
    if (problems.length) throw new Error("请先修正下面列出的问题");
    setServerProblems([]);
    try {
      const parsed = workflowDefinitionSchema.parse(draft);
      if (isNew) {
        const { workflow } = await workflowsApi.create(parsed);
        await queryClient.invalidateQueries({ queryKey: workflowKeys.library });
        setTimeout(() => void navigate({ to: "/workflows/$workflowId", params: { workflowId: workflow.id }, replace: true }), 500);
      } else {
        const { workflow, warnings } = await workflowsApi.update(workflowId, parsed);
        queryClient.setQueryData(workflowKeys.detail(workflowId), { workflow, warnings });
        await queryClient.invalidateQueries({ queryKey: workflowKeys.library });
        setDraft(structuredClone(workflow.definition));
      }
    } catch (error) {
      if (error instanceof WorkflowSaveError) setServerProblems(error.problems);
      throw error;
    }
  });

  const duplicate = useAsyncAction(async () => {
    const { workflow } = await workflowsApi.duplicate(workflowId);
    await queryClient.invalidateQueries({ queryKey: workflowKeys.library });
    toast.success(`已复制为「${workflow.definition.name}」`);
    setTimeout(() => void navigate({ to: "/workflows/$workflowId", params: { workflowId: workflow.id } }), 400);
  });

  if (!isNew && detail.isPending) return <PageSkeleton />;
  if (!isNew && !saved)
    return (
      <PageShell backButton={{ label: "工作流", linkProps: { to: "/workflows" } }} title="工作流">
        <ErrorCard description="可能已经被删除。" title="找不到这个工作流" />
      </PageShell>
    );
  if (!draft || (!isNew && loadedFor !== workflowId)) return <PageSkeleton />;

  const warnings = detail.data?.warnings ?? [];
  const shown = [...problems, ...serverProblems.filter((p) => !problems.includes(p))];

  return (
    <PageShell
      action={
        <div className="flex items-center gap-2">
          <div className="wf-seg" role="tablist" aria-label="视图">
            <button aria-selected={view === "form"} className={cn("wf-seg-item", view === "form" && "is-on")} onClick={() => setView("form")} role="tab" type="button">
              {"表单"}
            </button>
            <button aria-selected={view === "file"} className={cn("wf-seg-item", view === "file" && "is-on")} onClick={() => setView("file")} role="tab" type="button">
              {"WORKFLOW.md"}
            </button>
          </div>
          {isNew ? (
            <Button disabled={problems.length > 0} feedback="create" onClick={() => void save.run().catch((e: Error) => toast.error(e.message))} size="sm" state={save.state}>
              <IconPlus />
              {"创建"}
            </Button>
          ) : (
            <>
              {readOnly ? (
                <Button feedback={{ pending: "复制中…", success: "已复制", error: "复制失败" }} onClick={() => void duplicate.run().catch((e: Error) => toast.error(e.message))} size="sm" state={duplicate.state} variant="outline">
                  <IconCopy />
                  {"复制为我的工作流"}
                </Button>
              ) : null}
              <Button
                aria-label="导出 WORKFLOW.md"
                onClick={() => void downloadWorkflow(workflowId, draft.slug).catch(() => toast.error("导出失败"))}
                size="icon-sm"
                title="导出 WORKFLOW.md"
                variant="ghost"
              >
                <IconDownload />
              </Button>
              <Button disabled={dirty} nativeButton={false} render={<Link search={{ run: workflowId }} to="/workflows" />} size="sm" title={dirty ? "先保存再运行" : undefined}>
                <IconPlayerPlayFilled />
                {"运行"}
              </Button>
            </>
          )}
        </div>
      }
      backButton={{ label: "工作流", linkProps: { to: "/workflows" } }}
      description={readOnly ? undefined : isNew ? "先选好角色和步骤，再按需要加参数、技能和约束。" : draft.description || undefined}
      title={isNew ? "新建工作流" : `${draft.icon} ${draft.name || "未命名"}`}
    >
      {readOnly ? (
        <div className="wf-banner">
          <IconLock className="size-4" />
          {"这是预设，不能直接修改。「复制为我的工作流」后可以随意改。"}
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ErrorCard
          className="mt-3"
          description={
            <span className="wf-problems">
              {shown.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </span>
          }
          title={`还有 ${shown.length} 个问题需要修正`}
        />
      ) : null}
      {warnings.length > 0 && !readOnly ? (
        <p className="wf-muted mt-3">{warnings.join(" ")}</p>
      ) : null}

      {view === "form" ? (
        <WorkflowEditor onChange={setDraft} readOnly={readOnly} value={draft} />
      ) : (
        <SourceView def={draft} />
      )}

      {!isNew && !readOnly ? (
        <SaveBar show={dirty}>
          <Button onClick={() => saved && setDraft(structuredClone(saved.definition))} size="sm" type="button" variant="ghost">
            {"放弃"}
          </Button>
          <Button disabled={problems.length > 0} feedback="save" onClick={() => void save.run().catch((e: Error) => toast.error(e.message))} size="sm" state={save.state}>
            {"保存"}
          </Button>
        </SaveBar>
      ) : null}
    </PageShell>
  );
}

/** WORKFLOW.md 预览：由服务器用和导出同一个函数生成，所见即导出。 */
function SourceView({ def }: { def: WorkflowDefinition }) {
  const key = JSON.stringify(def);
  const query = useQuery({
    queryKey: ["workflows", "render", key],
    queryFn: () => workflowsApi.validate({ definition: def }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const result = query.data;
  return (
    <Card className="wf-source">
      <div className="wf-source-h">
        <span className="wf-label">{"WORKFLOW.md"}</span>
        <span className="flex-1" />
        {result?.ok ? (
          <CopyButton size="sm" value={result.markdown} variant="ghost">
            {"复制"}
          </CopyButton>
        ) : null}
      </div>
      {query.isPending ? (
        <p className="wf-muted p-4">{"生成中…"}</p>
      ) : result?.ok ? (
        <pre className="wf-pre">{result.markdown}</pre>
      ) : (
        <p className="p-4 text-sm text-destructive">{result?.error ?? "无法生成"}</p>
      )}
    </Card>
  );
}
