import {
  IconAlarm,
  IconBrandWechat,
  IconDots,
  IconExternalLink,
  IconMessageReply,
  IconPencil,
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { sendPromptToChat } from "@/components/chat/quick-spotlight";
import {
  PageEmpty,
  PageSection,
  PageShell,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { ScheduleEditDialog } from "@/components/schedules/edit-dialog";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, ErrorCard, ListRow } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useOpenThread } from "@/lib/channels/open-thread";
import { agoText } from "@/lib/im";
import { scheduleZone } from "@/lib/schedule-edit";
import {
  deleteSchedule,
  patchSchedule,
  purgeOrphanSchedules,
  runScheduleNow,
  scheduleKeys,
  schedulesQueryOptions,
  shownNextRun,
  skipScheduleNext,
} from "@/lib/schedules";
import { cn } from "@/lib/utils";
import {
  formatWhen,
  partitionScheduleList,
  RUN_STATUS_ZH,
  scheduleLastLineZh,
  scheduleLastTone,
  type ScheduleRunStatus,
  type ScheduleView,
} from "../../../../../shared/schedules";

export const Route = createFileRoute("/_authed/settings/schedules")({
  component: SchedulesPage,
});

/** 设置 → 定时任务（DESIGN.md §55）：机器人替你设的提醒和定时任务。 */
function SchedulesPage() {
  const navigate = useNavigate();
  const list = useQuery(schedulesQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const hiddenBots = useQuery(agentListQueryOptions(true));
  const queryClient = useQueryClient();
  const botName = new Map(
    [...(bots.data ?? []), ...(hiddenBots.data ?? [])].map((bot) => [bot.id, bot.name]),
  );
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const items = (list.data ?? []).filter((s) => !hidden.has(s.id));
  // 可见 + 隐藏机器人都算「还在」：只把真删除的标成孤儿（0.1.40），避免隐藏机器人任务被误清。
  const botsReady = bots.isSuccess && hiddenBots.isSuccess;
  const knownBotIds = botsReady
    ? [...(bots.data ?? []), ...(hiddenBots.data ?? [])].map((b) => b.id)
    : items.map((s) => s.agentId);
  // v0.1.34：分区规则抽到 shared（可测）；电车等 paused 任务从不自动回 active。
  const {
    needsAttention,
    activeRest,
    paused,
    ended,
    orphanLive,
    orphanEnded,
    orphanAll,
  } = partitionScheduleList(items, knownBotIds);
  const shown = items.find((s) => s.id === detail) ?? null;
  const editingSchedule = items.find((s) => s.id === editing) ?? null;
  // 模块 13 S2：进设置页不再自动 DELETE /api/schedules/orphans；只在用户点「清理」并确认后删。
  const clearOrphans = async () => {
    if (!orphanAll.length || purging) return;
    const ok = await confirmDialog({
      title: `清理 ${orphanAll.length} 条已删除机器人下的定时任务？`,
      description:
        orphanLive.length > 0
          ? `包含 ${orphanLive.length} 条进行中/已暂停（会直接删除，不会自动恢复电车一类噪音任务）和 ${orphanEnded.length} 条已结束。`
          : "只删机器人已不在的条目。",
      confirmLabel: "全部删除",
      destructive: true,
    });
    if (!ok) return;
    setPurging(true);
    try {
      const r = await purgeOrphanSchedules();
      let n = r.deleted;
      // 服务端按 agent_profiles 硬删；若 UI 仍看见孤儿（隐藏/列表不同步），再逐条兜底。
      if (n === 0 && orphanAll.length) {
        for (const s of orphanAll) {
          try {
            await deleteSchedule(s.id);
            n += 1;
          } catch {
            // 已不存在或无权限：跳过
          }
        }
      }
      await queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
      if (n) toast.success(`已清理 ${n} 条`);
      else toast.success("没有可清理的条目");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清理失败");
    } finally {
      setPurging(false);
    }
  };
  const rows = (group: ScheduleView[]) => (
    <Card className="mem-card sch-card">
      {group.map((s) => (
        <ScheduleRow
          botName={botName.get(s.agentId) ?? "已删除的机器人"}
          key={s.id}
          onHide={(id) => setHidden((h) => new Set([...h, id]))}
          onUnhide={(id) =>
            setHidden((h) => {
              if (!h.has(id)) return h;
              const next = new Set(h);
              next.delete(id);
              return next;
            })
          }
          onEdit={() => setEditing(s.id)}
          onOpen={() => setDetail(s.id)}
          schedule={s}
        />
      ))}
    </Card>
  );
  return (
    <>
      <ScheduleDialog
        botName={shown ? (botName.get(shown.agentId) ?? "已删除的机器人") : ""}
        onEdit={(id) => {
          setDetail(null);
          setEditing(id);
        }}
        onOpenChange={(open) => !open && setDetail(null)}
        schedule={shown}
      />
      <ScheduleEditDialog
        onOpenChange={(open) => !open && setEditing(null)}
        schedule={editingSchedule}
      />
      <PageShell
        action={
          <Button
            data-testid="schedules-go-chat-btn"
            onClick={() =>
              sendPromptToChat(
                navigate,
                "请帮我创建一个定时任务：每天早上 08:30 调用 personal_morning_brief 生成今日晨报并通过 notify_push 推送到我手机",
                "创建定时任务",
              )
            }
            size="sm"
            variant="outline"
          >
            <IconMessageReply className="size-3.5" />
            {"去对话创建定时任务"}
          </Button>
        }
        description="机器人替你设的提醒和定时任务。在任何对话里说「明早 9 点提醒我…」「每个工作日 18:00 帮我…」就会建一个；到点时结果发回原来的对话，并通知你。时间按北京时间，除非你说了别的地方。"
        title="定时任务"
      >
        {list.isPending ? (
          <PageSkeleton rows={3} />
        ) : list.isError ? (
          <ErrorCard
            action={
              <Button
                className="mt-2"
                onClick={() => void list.refetch()}
                size="sm"
                variant="outline"
              >
                {"重试"}
              </Button>
            }
            description={list.error.message}
            title="定时任务暂时无法读取"
          />
        ) : items.length ? (
          <>
            {orphanAll.length ? (
              <div className="mb-3">
                <Button
                  disabled={purging}
                  onClick={() => void clearOrphans()}
                  size="sm"
                  variant="outline"
                >
                  {purging
                    ? "清理中…"
                    : `清理已删除机器人的任务（${orphanAll.length}）`}
                </Button>
              </div>
            ) : null}
            {needsAttention.length ? (
              <PageSection title={`需要关注 · ${needsAttention.length}`}>
                {rows(needsAttention)}
              </PageSection>
            ) : null}
            {activeRest.length ? (
              <PageSection title={`进行中 · ${activeRest.length}`}>
                {rows(activeRest)}
              </PageSection>
            ) : null}
            {paused.length ? (
              <PageSection title={`已暂停 · ${paused.length}`}>
                {rows(paused)}
              </PageSection>
            ) : null}
            {ended.length ? (
              <PageSection title={`最近结束 · ${ended.length}`}>
                {rows(ended)}
              </PageSection>
            ) : null}
          </>
        ) : (
          <PageEmpty>
            <div className="flex flex-col items-center gap-3">
              <span>
                {
                  "还没有定时任务。在对话里对机器人说「明早 9 点提醒我给妈妈打电话」或点击下方模板一键创建："
                }
              </span>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  data-testid="schedule-preset-brief"
                  onClick={() =>
                    sendPromptToChat(
                      navigate,
                      "请帮我设置定时任务：每天早上 08:30 自动生成今日晨报（personal_morning_brief）并推送通知给我",
                      "定时任务模板",
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {"☀️ 每天 08:30 生成今日晨报"}
                </Button>
                <Button
                  data-testid="schedule-preset-mail"
                  onClick={() =>
                    sendPromptToChat(
                      navigate,
                      "请帮我设置定时任务：每个工作日 18:00 巡检今日重要未读邮件与待办（personal_check_updates）并汇总给我",
                      "定时任务模板",
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {"📬 工作日 18:00 汇总邮件与待办"}
                </Button>
                <Button
                  data-testid="schedule-preset-dream"
                  onClick={() =>
                    sendPromptToChat(
                      navigate,
                      "请帮我设置定时任务：每周日晚上 21:00 运行 memory_dream 整理我本周的记忆碎片并生成周报",
                      "定时任务模板",
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {"🧠 每周日 21:00 整理记忆与周报"}
                </Button>
              </div>
            </div>
          </PageEmpty>
        )}
      </PageShell>
    </>
  );
}

function statusTone(status: ScheduleRunStatus | null) {
  return status === "ok" || status === "queued"
    ? "is-ok"
    : status === "failed"
      ? "is-bad"
      : status === "waiting"
        ? "is-wait"
        : status === "running"
          ? "is-run"
          : "is-muted";
}

function ScheduleRow({
  schedule: s,
  botName,
  onOpen,
  onEdit,
  onHide,
  onUnhide,
}: {
  schedule: ScheduleView;
  botName: string;
  onOpen: () => void;
  onEdit: () => void;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const openThread = useOpenThread();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
  const ended = s.status === "done" || s.status === "cancelled";
  const [on, setOn] = useState(s.status === "active");
  const [toggling, setToggling] = useState(false);
  useEffect(() => {
    setOn(s.status === "active");
  }, [s.status]);
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
      toast.success(
        updated.kind === "once"
          ? `已跳过「${s.title}」`
          : `已跳过下一次${updated.nextRunAt ? `，下次 ${formatWhen(updated.nextRunAt, updated.timezone)}` : ""}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "跳过失败");
    }
  }
  async function remove() {
    const ok = await confirmDialog({
      title: `删除「${s.title}」？`,
      description:
        "删除后不会再运行，运行记录也一起删掉，不能撤销。只是暂时不要的话，把开关关掉就行。",
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
      onUnhide(s.id);
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  }
  const running = s.running || s.lastStatus === "running";
  const last = scheduleLastLineZh(
    s,
    s.lastRunAt ? agoText(s.lastRunAt) : null,
  );
  const lastTone = scheduleLastTone(s);
  return (
    <div
      className={cn("im-row sch-row", ended && "is-ended")}
      data-testid="schedule-row"
    >
      <button
        aria-label={`查看「${s.title}」的详情`}
        className="im-row-main"
        onClick={onOpen}
        type="button"
      >
        <ListRow
          icon={
            <span
              className={cn(
                "mem-ico sch-ico",
                s.status === "active" ? "is-on" : "is-off",
              )}
            >
              <IconAlarm className="size-5" />
            </span>
          }
          sub={
            <>
              <span className="device-row-meta">
                <span className="sch-when">{s.schedule}</span>
                <span className="device-cap-chip sch-tz" data-testid="schedule-tz">
                  {scheduleZone(s)}
                </span>
                <span className="device-cap-chip">
                  <T>{botName}</T>
                </span>
                {s.source === "im" ? (
                  <span className="device-cap-chip">
                    <IconBrandWechat className="size-3" />
                    {"IM"}
                  </span>
                ) : null}
                {s.threadDeleted ? (
                  <span
                    className="device-cap-chip sch-thread-gone"
                    data-testid="schedule-thread-deleted"
                    title={"原来那段对话已删除，这个任务已自动取消，不会发到别的对话"}
                  >
                    {"原对话已删除"}
                  </span>
                ) : null}
              </span>
              <span className="sch-line">
                {shownNextRun(s) ? (
                  <span className="sch-next">{`下次 ${formatWhen(shownNextRun(s) ?? "", s.timezone)} ${scheduleZone(s)}`}</span>
                ) : null}
                <span
                  className={cn(
                    "sch-last",
                    statusTone(lastTone),
                  )}
                >
                  {last}
                </span>
                {s.lastResult && !running ? (
                  <span className="sch-result">
                    {s.lastResult.replace(/\s+/g, " ")}
                  </span>
                ) : null}
              </span>
            </>
          }
          title={s.title}
        />
      </button>
      <div className="sch-actions">
        {!ended && !(s.status === "paused" && s.lastStatus === "waiting") ? (
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
        {!ended ? (
          <Switch
            aria-label={on ? `暂停「${s.title}」` : `恢复「${s.title}」`}
            checked={on}
            disabled={toggling}
            onCheckedChange={(next) => void toggle(next)}
          />
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                aria-label={`「${s.title}」的更多操作`}
                className="device-row-more"
                title={"更多操作"}
                type="button"
              />
            }
          >
            <IconDots className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="glass-pop w-[188px] p-1.5"
          >
            {!ended ? (
              <DropdownMenuItem
                className="glass-mi"
                onClick={() => void run.run()}
              >
                <IconPlayerPlay className="size-[18px] shrink-0 opacity-80" />
                <span className="min-w-0 flex-1">{"立即运行"}</span>
              </DropdownMenuItem>
            ) : null}
            {!ended ? (
              <DropdownMenuItem className="glass-mi" onClick={onEdit}>
                <IconPencil className="size-[18px] shrink-0 opacity-80" />
                <span className="min-w-0 flex-1">{"编辑"}</span>
              </DropdownMenuItem>
            ) : null}
            {s.status === "active" ? (
              <DropdownMenuItem
                className="glass-mi"
                onClick={() => void skip()}
              >
                <IconPlayerSkipForward className="size-[18px] shrink-0 opacity-80" />
                <span className="min-w-0 flex-1">
                  {s.kind === "once" ? "跳过这次提醒" : "跳过下一次"}
                </span>
              </DropdownMenuItem>
            ) : null}
            {s.source === "web" ? (
              <DropdownMenuItem
                className="glass-mi"
                onClick={() => void openThread(s.agentId, s.threadId)}
              >
                <IconExternalLink className="size-[18px] shrink-0 opacity-80" />
                <span className="min-w-0 flex-1">{"打开对话"}</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator className="glass-sep" />
            <DropdownMenuItem
              className="glass-mi is-danger"
              onClick={() => void remove()}
            >
              <IconTrash className="size-[18px] shrink-0 opacity-80" />
              <span className="min-w-0 flex-1">{"删除…"}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ScheduleDialog({
  schedule: s,
  botName,
  onEdit,
  onOpenChange,
}: {
  schedule: ScheduleView | null;
  botName: string;
  onEdit: (id: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const ended = s?.status === "done" || s?.status === "cancelled";
  return (
    <Dialog onOpenChange={onOpenChange} open={Boolean(s)}>
      <DialogContent className="im-dialog max-w-lg">
        {s ? (
          <>
            <DialogHeader>
              <DialogTitle>{s.title}</DialogTitle>
              <DialogDescription>{`${s.schedule} · ${scheduleZone(s)} · ${botName}${s.source === "im" ? " · 来自 IM" : ""}`}</DialogDescription>
            </DialogHeader>
            <DialogBody className="im-form mt-2">
              {!ended ? (
                <div>
                  <Button
                    data-testid="schedule-detail-edit"
                    onClick={() => onEdit(s.id)}
                    size="sm"
                    variant="outline"
                  >
                    <IconPencil />
                    {"编辑"}
                  </Button>
                </div>
              ) : null}
              <div className="sch-detail">
                <div className="sch-detail-l">{"到点时做什么"}</div>
                <div className="sch-detail-v">{s.instruction}</div>
              </div>
              {shownNextRun(s) ? (
                <div className="sch-detail">
                  <div className="sch-detail-l">{"下次运行"}</div>
                  <div className="sch-detail-v">
                    {`${formatWhen(shownNextRun(s) ?? "", s.timezone)} ${scheduleZone(s)}`}
                  </div>
                </div>
              ) : null}
              <div className="sch-detail">
                <div className="sch-detail-l">{`最近运行${s.recentRuns?.length ? ` · ${s.recentRuns.length}` : ""}`}</div>
                {s.recentRuns?.length ? (
                  <ul className="sch-runs">
                    {s.recentRuns.map((r) => (
                      <li className="sch-run-item" key={r.id}>
                        <span className={cn("sch-last", statusTone(r.status))}>
                          {RUN_STATUS_ZH[r.status]}
                        </span>
                        <span className="sch-run-at">{`${formatWhen(r.startedAt, s.timezone)}${r.manual ? " · 手动" : ""}`}</span>
                        {r.result ? (
                          <span className="sch-run-result">{r.result}</span>
                        ) : null}
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
