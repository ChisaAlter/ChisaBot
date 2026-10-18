import {
  IconAlarm,
  IconBrandWechat,
  IconDots,
  IconExternalLink,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useOpenThread } from "@/lib/channels/open-thread";
import { useState } from "react";
import { formatWhen, RUN_STATUS_ZH, type ScheduleRunStatus, type ScheduleView } from "../../../../../shared/schedules";
import { PageEmpty, PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Card, ErrorCard, ListRow } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { agoText } from "@/lib/im";
import { deleteSchedule, patchSchedule, runScheduleNow, scheduleKeys, schedulesQueryOptions, skipScheduleNext } from "@/lib/schedules";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings/schedules")({
  component: SchedulesPage,
});

/** 设置 → 定时任务（DESIGN.md §55）：机器人替你设的提醒和定时任务。 */
function SchedulesPage() {
  const list = useQuery(schedulesQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const queryClient = useQueryClient();
  const botName = new Map((bots.data ?? []).map((bot) => [bot.id, bot.name]));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const items = (list.data ?? []).filter((s) => !hidden.has(s.id));
  const active = items.filter((s) => s.status === "active");
  const paused = items.filter((s) => s.status === "paused");
  const ended = items.filter((s) => s.status === "done" || s.status === "cancelled");
  // FIX-16：已删除机器人下的已结束任务，一键清理（等机器人列表到了再判断，避免全员误判）。
  const orphanEnded = bots.isSuccess ? ended.filter((s) => !botName.has(s.agentId)) : [];
  const shown = items.find((s) => s.id === detail) ?? null;
  const clearOrphans = async () => {
    if (!orphanEnded.length) return;
    const ok = await confirmDialog({
      title: `清理 ${orphanEnded.length} 条已删除机器人下的定时任务？`,
      description: "只删「已结束 / 已取消」且机器人已不在的条目；进行中的不动。",
      confirmLabel: "全部删除",
      destructive: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const s of orphanEnded) {
      try {
        await deleteSchedule(s.id);
      } catch {
        failed += 1;
      }
    }
    await queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
    if (failed) toast.error(`${failed} 条没删掉`);
    else toast.success(`已清理 ${orphanEnded.length} 条`);
  };
  const rows = (group: ScheduleView[]) => (
    <Card className="mem-card sch-card">
      {group.map((s) => (
        <ScheduleRow botName={botName.get(s.agentId) ?? "已删除的机器人"} key={s.id} onHide={(id) => setHidden((h) => new Set([...h, id]))} onOpen={() => setDetail(s.id)} schedule={s} />
      ))}
    </Card>
  );
  return (
    <>
      <ScheduleDialog botName={shown ? (botName.get(shown.agentId) ?? "已删除的机器人") : ""} onOpenChange={(open) => !open && setDetail(null)} schedule={shown} />
      <PageShell
        description="机器人替你设的提醒和定时任务。在任何对话里说「明早 9 点提醒我…」「每个工作日 18:00 帮我…」就会建一个；到点时结果发回原来的对话，并通知你。时间按北京时间，除非你说了别的地方。"
        title="定时任务"
      >
        {list.isPending ? (
          <PageSkeleton rows={3} />
        ) : list.isError ? (
          <ErrorCard
            action={
              <Button className="mt-2" onClick={() => void list.refetch()} size="sm" variant="outline">
                {"重试"}
              </Button>
            }
            description={list.error.message}
            title="定时任务暂时无法读取"
          />
        ) : items.length ? (
          <>
            {active.length ? <PageSection title={`进行中 · ${active.length}`}>{rows(active)}</PageSection> : null}
            {paused.length ? <PageSection title={`已暂停 · ${paused.length}`}>{rows(paused)}</PageSection> : null}
            {ended.length ? (
              <PageSection
                title={`最近结束 · ${ended.length}`}
                action={
                  orphanEnded.length ? (
                    <Button onClick={() => void clearOrphans()} size="sm" variant="outline">
                      {`清理已删除机器人（${orphanEnded.length}）`}
                    </Button>
                  ) : null
                }
              >
                {rows(ended)}
              </PageSection>
            ) : null}
          </>
        ) : (
          <PageEmpty>{"还没有定时任务。在对话里对机器人说「明早 9 点提醒我给妈妈打电话」或「每天 18:00 总结一下今天的新闻」试试。"}</PageEmpty>
        )}
      </PageShell>
    </>
  );
}

function statusTone(status: ScheduleRunStatus | null) {
  return status === "ok" || status === "queued" ? "is-ok" : status === "failed" ? "is-bad" : status === "waiting" ? "is-wait" : status === "running" ? "is-run" : "is-muted";
}

function ScheduleRow({ schedule: s, botName, onOpen, onHide }: { schedule: ScheduleView; botName: string; onOpen: () => void; onHide: (id: string) => void }) {
  const queryClient = useQueryClient();
  const openThread = useOpenThread();
  const refresh = () => queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
  const ended = s.status === "done" || s.status === "cancelled";
  const [on, setOn] = useState(s.status === "active");
  const [toggling, setToggling] = useState(false);
  const run = useAsyncAction(
    async () => {
      await runScheduleNow(s.id);
      await refresh();
    },
    { errorToast: (error) => error.message },
  );
  async function toggle(next: boolean) {
    setOn(next);
    setToggling(true);
    try {
      await patchSchedule(s.id, { paused: !next });
      await refresh();
      toast.success(next ? `已恢复「${s.title}」` : `已暂停「${s.title}」`);
    } catch (error) {
      setOn(!next);
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setToggling(false);
    }
  }
  async function skip() {
    try {
      const updated = await skipScheduleNext(s.id);
      await refresh();
      toast.success(updated.kind === "once" ? `已跳过「${s.title}」` : `已跳过下一次${updated.nextRunAt ? `，下次 ${formatWhen(updated.nextRunAt, updated.timezone)}` : ""}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "跳过失败");
    }
  }
  async function remove() {
    const ok = await confirmDialog({
      title: `删除「${s.title}」？`,
      description: "删除后不会再运行，运行记录也一起删掉，不能撤销。只是暂时不要的话，把开关关掉就行。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    onHide(s.id);
    try {
      await deleteSchedule(s.id);
      await refresh();
      toast.success(`已删除「${s.title}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  }
  const running = s.running || s.lastStatus === "running";
  const last = running ? "正在运行…" : s.lastStatus ? `上次${RUN_STATUS_ZH[s.lastStatus]}${s.lastRunAt ? ` · ${agoText(s.lastRunAt)}` : ""}` : "还没运行过";
  return (
    <div className={cn("im-row sch-row", ended && "is-ended")} data-testid="schedule-row">
      <button className="im-row-main" onClick={onOpen} type="button">
        <ListRow
          icon={
            <span className={cn("mem-ico sch-ico", s.status === "active" ? "is-on" : "is-off")}>
              <IconAlarm className="size-5" />
            </span>
          }
          sub={
            <>
              <span className="device-row-meta">
                <span className="sch-when">{s.schedule}</span>
                <span className="device-cap-chip"><T>{botName}</T></span>
                {s.source === "im" ? (
                  <span className="device-cap-chip">
                    <IconBrandWechat className="size-3" />
                    {"IM"}
                  </span>
                ) : null}
              </span>
              <span className="sch-line">
                {s.status === "active" && s.nextRunAt ? <span className="sch-next">{`下次 ${formatWhen(s.nextRunAt, s.timezone)}`}</span> : null}
                <span className={cn("sch-last", statusTone(running ? "running" : s.lastStatus))}>{last}</span>
                {s.lastResult && !running ? <span className="sch-result">{s.lastResult.replace(/\s+/g, " ")}</span> : null}
              </span>
            </>
          }
          title={s.title}
        />
      </button>
      <div className="sch-actions">
        {!ended ? (
          <Button
            aria-label={`立即运行「${s.title}」`}
            className="sch-run"
            feedback={{ pending: "启动中…", success: "已开始", error: "失败" }}
            onClick={() => void run.run()}
            size="sm"
            state={run.state}
            variant="outline"
          >
            <IconPlayerPlay />
            {"立即运行"}
          </Button>
        ) : null}
        {!ended ? <Switch aria-label={on ? `暂停「${s.title}」` : `恢复「${s.title}」`} checked={on} disabled={toggling} onCheckedChange={(next) => void toggle(next)} /> : null}
        <DropdownMenu>
          <DropdownMenuTrigger render={<button aria-label={`「${s.title}」的更多操作`} className="device-row-more" title={"更多操作"} type="button" />}>
            <IconDots className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="glass-pop w-[188px] p-1.5">
            {!ended ? (
              <DropdownMenuItem className="glass-mi" onClick={() => void run.run()}>
                <IconPlayerPlay className="size-[18px] shrink-0 opacity-80" />
                <span className="min-w-0 flex-1">{"立即运行"}</span>
              </DropdownMenuItem>
            ) : null}
            {s.status === "active" ? (
              <DropdownMenuItem className="glass-mi" onClick={() => void skip()}>
                <IconPlayerSkipForward className="size-[18px] shrink-0 opacity-80" />
                <span className="min-w-0 flex-1">{s.kind === "once" ? "跳过这次提醒" : "跳过下一次"}</span>
              </DropdownMenuItem>
            ) : null}
            {s.source === "web" ? (
              <DropdownMenuItem className="glass-mi" onClick={() => void openThread(s.agentId, s.threadId)}>
                <IconExternalLink className="size-[18px] shrink-0 opacity-80" />
                <span className="min-w-0 flex-1">{"打开对话"}</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator className="glass-sep" />
            <DropdownMenuItem className="glass-mi is-danger" onClick={() => void remove()}>
              <IconTrash className="size-[18px] shrink-0 opacity-80" />
              <span className="min-w-0 flex-1">{"删除…"}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ScheduleDialog({ schedule: s, botName, onOpenChange }: { schedule: ScheduleView | null; botName: string; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(s)}>
      <DialogContent className="im-dialog max-w-lg">
        {s ? (
          <>
            <DialogHeader>
              <DialogTitle>{s.title}</DialogTitle>
              <DialogDescription>{`${s.schedule} · ${botName}${s.source === "im" ? " · 来自 IM" : ""}`}</DialogDescription>
            </DialogHeader>
            <DialogBody className="im-form mt-2">
              <div className="sch-detail">
                <div className="sch-detail-l">{"到点时做什么"}</div>
                <div className="sch-detail-v">{s.instruction}</div>
              </div>
              {s.status === "active" && s.nextRunAt ? (
                <div className="sch-detail">
                  <div className="sch-detail-l">{"下次运行"}</div>
                  <div className="sch-detail-v">{formatWhen(s.nextRunAt, s.timezone)}</div>
                </div>
              ) : null}
              <div className="sch-detail">
                <div className="sch-detail-l">{`最近运行${s.recentRuns?.length ? ` · ${s.recentRuns.length}` : ""}`}</div>
                {s.recentRuns?.length ? (
                  <ul className="sch-runs">
                    {s.recentRuns.map((r) => (
                      <li className="sch-run-item" key={r.id}>
                        <span className={cn("sch-last", statusTone(r.status))}>{RUN_STATUS_ZH[r.status]}</span>
                        <span className="sch-run-at">{`${formatWhen(r.startedAt, s.timezone)}${r.manual ? " · 手动" : ""}`}</span>
                        {r.result ? <span className="sch-run-result">{r.result}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="sch-detail-v is-muted">{"还没运行过。"}</div>
                )}
              </div>
            </DialogBody>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
