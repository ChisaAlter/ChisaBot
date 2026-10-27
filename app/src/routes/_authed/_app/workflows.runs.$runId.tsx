import { requireExtra } from "@/lib/deployment/extras";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconClock,
  IconCoins,
  IconDots,
  IconDownload,
  IconListNumbers,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconShieldCheck,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Streamdown } from "streamdown";
import { SmoothStreamdown } from "@/components/chat/smooth-markdown";
import {
  ACTIVE_RUN_STATUSES,
  TOOL_GROUP_INFO,
  type WorkflowRunView,
  type WorkflowStepState,
} from "../../../../../shared/workflows";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { RunStatusBadge, StepStatusBadge } from "@/components/workflows/run-status";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { CopyButton } from "@/components/ui/copy-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { markdownComponents } from "@/lib/markdown";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { durationText, tokensText, workflowKeys, workflowRunQueryOptions, workflowsApi } from "@/lib/workflows";

export const Route = createFileRoute("/_authed/_app/workflows/runs/$runId")({
  // 功能精简（DESIGN.md §74）：默认隐藏，CHISABOT_EXTRAS 含 workflows 才能进。
  beforeLoad: requireExtra("workflows"),
  component: RunPage,
});

const SOURCE_LABEL: Record<WorkflowRunView["source"], string> = {
  page: "从工作流页面运行",
  chat: "从聊天运行",
  routine: "由长期任务运行",
  api: "通过接口运行",
};

/** 相邻且同组的步骤是一个并行阶段。 */
function stagesOf(steps: WorkflowStepState[]): WorkflowStepState[][] {
  const stages: WorkflowStepState[][] = [];
  for (const step of steps) {
    const last = stages[stages.length - 1];
    if (last && step.group && last[0]!.group === step.group) last.push(step);
    else stages.push([step]);
  }
  return stages;
}

function RunPage() {
  const { runId } = Route.useParams();
  const { data: run, isPending, isError, refetch } = useQuery(workflowRunQueryOptions(runId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const active = run ? ACTIVE_RUN_STATUSES.includes(run.status) : false;

  const stop = useAsyncAction(async () => {
    const ok = await confirmDialog({
      title: "停止这次运行？",
      description: "正在进行的步骤会被中断，后面的步骤不再执行。已经完成的步骤结果会保留。",
      confirmLabel: "停止",
      destructive: true,
    });
    if (!ok) return;
    await workflowsApi.cancel(runId);
    await queryClient.invalidateQueries({ queryKey: workflowKeys.run(runId) });
  });

  const removeRun = async () => {
    const ok = await confirmDialog({
      title: "删除这条运行记录？",
      description: "运行的参数、每一步的输出和运行记录都会删除，不能撤销。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    try {
      await workflowsApi.removeRun(runId);
      await queryClient.invalidateQueries({ queryKey: workflowKeys.library });
      toast.success("已删除运行记录");
      void navigate({ to: "/workflows" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  };

  if (isPending) return <PageSkeleton />;
  if (!run)
    return (
      <PageShell backButton={{ label: "工作流", linkProps: { to: "/workflows" } }} title="运行">
        <ErrorCard
          action={
            isError ? (
              <Button className="mt-2" onClick={() => void refetch()} size="sm" variant="outline">
                {"重试"}
              </Button>
            ) : null
          }
          description="可能已经被删除，或者不是你的运行。"
          title="找不到这次运行"
        />
      </PageShell>
    );

  const stages = stagesOf(run.steps);
  const tokenPct = Math.min(100, Math.round((run.usage.tokens / run.limits.maxTokens) * 100));
  const timePct = Math.min(100, Math.round((run.usage.elapsedMs / (run.limits.timeLimitMinutes * 60_000)) * 100));
  const doneSteps = run.steps.filter((s) => s.status === "succeeded").length;

  return (
    <PageShell
      action={
        <div className="flex items-center gap-2">
          {active ? (
            <Button
              feedback={{ pending: "停止中…", success: "已停止", error: "停止失败" }}
              onClick={() => void stop.run().catch((e: Error) => toast.error(e.message))}
              size="sm"
              state={stop.state}
              variant="outline"
            >
              <IconPlayerStopFilled />
              {"停止"}
            </Button>
          ) : (
            <Button
              nativeButton={false}
              render={<Link search={{ run: run.workflowId }} to="/workflows" />}
              size="sm"
            >
              <IconPlayerPlayFilled />
              {"再运行一次"}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button aria-label="更多操作" size="icon-sm" variant="ghost">
                  <IconDots />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void removeRun()} variant="destructive">
                <IconTrash />
                {"删除运行记录"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
      backButton={{ label: "工作流", linkProps: { to: "/workflows" } }}
      title={run.workflowName}
    >
      <Card className="wf-run-head">
        <div className="wf-run-head-top">
          <span aria-hidden className="wf-card-icon">
            {run.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <RunStatusBadge status={run.status} />
              <span className="wf-muted">
                {SOURCE_LABEL[run.source]}
                {" · "}
                {relativeTime(run.createdAt)}
              </span>
            </div>
            <p className="wf-muted mt-1">
              {`${doneSteps}/${run.steps.length} 步完成`}
              {run.tools.deny?.length
                ? ` · 禁止：${run.tools.deny.map((x) => (x in TOOL_GROUP_INFO ? TOOL_GROUP_INFO[x as keyof typeof TOOL_GROUP_INFO].label : x)).join("、")}`
                : ""}
              {run.tools.allow?.length
                ? ` · 只允许：${run.tools.allow.map((x) => (x in TOOL_GROUP_INFO ? TOOL_GROUP_INFO[x as keyof typeof TOOL_GROUP_INFO].label : x)).join("、")}`
                : ""}
            </p>
          </div>
        </div>
        <div className="wf-meters">
          <Meter done={run.status === "succeeded"} icon={<IconCoins className="size-3.5" />} label="Token（估算）" pct={tokenPct} value={`${tokensText(run.usage.tokens)} / ${tokensText(run.limits.maxTokens)}`} />
          <Meter
            icon={<IconListNumbers className="size-3.5" />}
            label="步骤"
            done={run.status === "succeeded"}
            progress
            pct={Math.round((run.usage.steps / run.limits.maxSteps) * 100)}
            value={`${run.usage.steps} / ${run.limits.maxSteps}`}
          />
          <Meter
            icon={<IconClock className="size-3.5" />}
            label="用时"
            done={run.status === "succeeded"}
            pct={timePct}
            value={`${durationText(run.usage.elapsedMs)} / ${run.limits.timeLimitMinutes} 分钟`}
          />
        </div>
      </Card>

      {run.status === "failed" && run.error ? (
        <ErrorCard className="mt-3" description={run.error} title="运行失败" />
      ) : null}
      {run.status === "cancelled" && run.error ? <p className="wf-muted mt-3">{run.error}</p> : null}

      <ol className="wf-timeline" aria-label="步骤">
        {stages.map((stage, index) => (
          <li className="wf-stage" key={stage[0]!.id}>
            <div className="wf-stage-rail" aria-hidden>
              <span className={cn("wf-stage-dot", stageTone(stage))}>{index + 1}</span>
            </div>
            <div className={cn("wf-stage-body", stage.length > 1 && "is-parallel")}>
              {stage.length > 1 ? <div className="wf-parallel-label">{`并行 · ${stage.length} 个步骤同时进行`}</div> : null}
              <div className={stage.length > 1 ? "wf-parallel-grid" : undefined}>
                {stage.map((step) => (
                  <StepCard key={step.id} run={run} step={step} />
                ))}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {run.status === "succeeded" && run.output ? (
        <Card className="wf-final">
          <div className="wf-final-h">
            <span className="wf-final-ico">
              <IconCheck className="size-4" />
            </span>
            <h3>{"最终结果"}</h3>
            <span className="flex-1" />
            <CopyButton size="sm" value={run.output} variant="ghost">
              {"复制"}
            </CopyButton>
            <Button onClick={() => downloadText(run.output!, `${run.workflowName}.${run.outputFormat === "json" ? "json" : "md"}`)} size="sm" variant="ghost">
              <IconDownload />
              {"下载"}
            </Button>
          </div>
          <div className="wf-final-b wf-md">
            {run.outputFormat === "json" ? (
              <pre className="wf-pre">{run.output}</pre>
            ) : (
              <Streamdown components={markdownComponents}>{run.output}</Streamdown>
            )}
          </div>
        </Card>
      ) : null}

      <details className="wf-details">
        <summary>{"运行参数"}</summary>
        <dl className="wf-dl">
          {Object.keys(run.inputs).length === 0 ? <dd className="wf-muted">{"（没有参数）"}</dd> : null}
          {Object.entries(run.inputs).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{typeof value === "boolean" ? (value ? "是" : "否") : String(value)}</dd>
            </div>
          ))}
        </dl>
      </details>
      <details className="wf-details">
        <summary>{`运行记录（${run.events?.length ?? 0}）`}</summary>
        <ul className="wf-events">
          {(run.events ?? []).map((event) => (
            <li className={cn("wf-event", /blocked|failed/.test(event.kind) && "is-danger")} key={event.id}>
              <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })}</time>
              <span>{event.message}</span>
            </li>
          ))}
        </ul>
      </details>
    </PageShell>
  );
}

function stageTone(stage: WorkflowStepState[]) {
  if (stage.some((s) => s.status === "failed")) return "is-danger";
  if (stage.some((s) => s.status === "running")) return "is-running";
  if (stage.some((s) => s.status === "waiting_approval")) return "is-warn";
  if (stage.every((s) => s.status === "succeeded")) return "is-ok";
  return "";
}

/**
 * 计量条。`done`：运行已经成功结束——用满预算不是错误，不画红（2026-10-13 实测：3/3 步完成时步骤条
 * 变红，看起来像出错）。`progress`：这条是进度（步骤），成功结束时画成完成色。
 */
function Meter({ icon, label, value, pct, done = false, progress = false }: { icon: React.ReactNode; label: string; value: string; pct: number; done?: boolean; progress?: boolean }) {
  return (
    <div className="wf-meter">
      <div className="wf-meter-k">
        {icon}
        {label}
        <span className="flex-1" />
        <span className="wf-meter-v">{value}</span>
      </div>
      <div className="wf-meter-bar" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span
          className={cn(
            done && progress && "is-done",
            !done && pct >= 90 && "is-danger",
            !(done && progress) && pct >= 70 && (done || pct < 90) && "is-warn",
          )}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  );
}

function StepCard({ run, step }: { run: WorkflowRunView; step: WorkflowStepState }) {
  const agents = useQuery(agentListQueryOptions());
  const bot = agents.data?.find((b) => b.id === step.botId);
  const [expanded, setExpanded] = useState(false);
  const long = step.output.length > 1600;
  const index = run.steps.indexOf(step) + 1;
  const elapsed = step.startedAt ? (step.finishedAt ? Date.parse(step.finishedAt) : Date.now()) - Date.parse(step.startedAt) : 0;

  return (
    <Card className={cn("wf-step", `is-${step.status}`)}>
      <div className="wf-step-h">
        <div className="min-w-0 flex-1">
          <div className="wf-step-title">
            <span className="wf-step-no">{`第 ${index} 步`}</span>
            {step.name}
          </div>
          <div className="wf-step-who">
            <AbstractAvatar agentId={step.botId} name={step.botName} seed={bot?.avatarSeed ?? step.botId} size={18} />
            <span>{step.botName}</span>
            <IconArrowRight aria-hidden className="size-3 opacity-50" />
            <span>{step.roleName}</span>
            {step.skills.length ? <span className="wf-muted">{` · 技能 ${step.skills.map((s) => `/${s}`).join(" ")}`}</span> : null}
          </div>
        </div>
        <div className="wf-step-meta">
          <StepStatusBadge status={step.status} />
          {step.tokens || elapsed ? (
            <span className="wf-muted">
              {step.tokens ? `约 ${tokensText(step.tokens)} token` : ""}
              {step.tokens && elapsed ? " · " : ""}
              {elapsed ? durationText(elapsed) : ""}
            </span>
          ) : null}
        </div>
      </div>

      {step.status === "waiting_approval" ? <ApprovalCard runId={run.id} step={step} /> : null}
      {step.approval?.decision ? (
        <p className={cn("wf-approval-note", step.approval.decision === "reject" && "is-danger")}>
          {step.approval.decision === "approve" ? <IconShieldCheck className="size-3.5" /> : <IconX className="size-3.5" />}
          {`${step.approval.decidedBy ?? "你"}${step.approval.decision === "approve" ? "批准了这一步" : "拒绝了这一步"}`}
          {step.approval.comment ? `：${step.approval.comment}` : ""}
        </p>
      ) : null}

      {step.output ? (
        <div className={cn("wf-step-out wf-md", long && !expanded && "is-clamped")}>
          <SmoothStreamdown components={markdownComponents}>{step.output}</SmoothStreamdown>
          {step.status === "running" ? <span aria-hidden className="wf-caret" /> : null}
        </div>
      ) : step.status === "running" ? (
        <div className="wf-step-thinking">
          <span className="wf-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          {`${step.botName} 正在处理…`}
        </div>
      ) : null}
      {long ? (
        <button className="wf-more" onClick={() => setExpanded((v) => !v)} type="button">
          {expanded ? "收起" : "展开全部"}
        </button>
      ) : null}
      {step.error ? (
        <p className="wf-step-error" role="alert">
          <IconAlertTriangle className="size-3.5" />
          {step.error}
        </p>
      ) : null}
    </Card>
  );
}

function ApprovalCard({ runId, step }: { runId: string; step: WorkflowStepState }) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const decide = useAsyncAction(async (decision: "approve" | "reject") => {
    await workflowsApi.approve(runId, step.id, decision, comment.trim() || undefined);
    await queryClient.invalidateQueries({ queryKey: workflowKeys.run(runId) });
  });
  return (
    // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
    <div className="wf-approval" role="group" aria-label="审批">
      <div className="wf-approval-h">
        <IconShieldCheck className="size-4" />
        {"这一步开始前需要你批准"}
      </div>
      {step.approval?.note ? <p className="wf-approval-text">{step.approval.note}</p> : null}
      <p className="wf-approval-text">{"先看看上面一步的输出，没问题再继续。"}</p>
      <div className="wf-approval-actions">
        <Input
          aria-label="备注（可选）"
          className="h-8 flex-1"
          maxLength={500}
          onChange={(event) => setComment(event.target.value)}
          placeholder="备注（可选）"
          value={comment}
        />
        <Button
          disabled={decide.state === "pending"}
          onClick={() => void decide.run("reject").catch((e: Error) => toast.error(e.message))}
          size="sm"
          variant="outline"
        >
          {"拒绝"}
        </Button>
        <Button
          feedback={{ pending: "提交中…", success: "已批准", error: "提交失败" }}
          onClick={() => void decide.run("approve").catch((e: Error) => toast.error(e.message))}
          size="sm"
          state={decide.state}
        >
          <IconCheck />
          {"批准并继续"}
        </Button>
      </div>
    </div>
  );
}

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}
