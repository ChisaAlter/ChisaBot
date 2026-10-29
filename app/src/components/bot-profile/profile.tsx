import {
  IconMessage,
  IconPencil,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Fragment, useRef, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { BotModelSelector } from "@/components/agents/bot-model-selector";
import { BotProfileForm } from "@/components/agents/bot-profile-form";
import { DeleteBotDialog } from "@/components/agents/delete-bot-dialog";
import { PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { runWithPageLoader } from "@/components/ui/page-loader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, SettingRow } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  resetBotMutationOptions,
  setBotNotifyMutationOptions,
  setBotPausedMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type ActivityItem,
  type BotNotify,
  botActivityQueryOptions,
  botLifecycleQueryOptions,
  botResetPlanQueryOptions,
  type ResetPlan,
} from "@/lib/bot-lifecycle/queries";
import { agentModelQueryOptions, modelCatalogQueryOptions } from "@/lib/model-selection/queries";
import { useMainBot } from "@/lib/settings/message-list";
import { queryClient as sharedQueryClient } from "@/query-client";
import { ActivityRow } from "./activity";
import { BotFilesAndPagesSection } from "./files-section";

/*
 * 机器人资料页（/bots/:id，DESIGN.md §47，2026-10-14 用户：「机器人资料页做的太垃圾了。要简洁高效」）。
 *
 *   头部：头像 · 名字 · 一行状态（职责 · 模型 · 运行中/已暂停）· 右边 开始聊天 / 编辑 / 删除
 *   资料：名称 · 职责 · 它做什么，点「编辑」原地变成和新建同一张表（头像 · 名称 · 职责 · 它做什么，§81），一次保存
 *   运行：模型 · 暂停 · 通知
 *   任务：只在有任务时出现（进行中 / 已计划 / 最近完成合成一张卡）
 *   底部一行：重置…
 *
 * 去掉了：页头的空话说明、重复的头像和职责、「已暂停，轻点以恢复」大按钮（状态在头部、开关在「运行」）、
 * 三个常年空着的任务分区、对所有机器人生效的「更新发到哪里」（搬到通知页）、「消息 xx」行（头部有开始聊天）。
 */

const NOTIFY_LABEL: Record<BotNotify, string> = {
  all: "全部",
  needs_input: "仅在需要我时",
  none: "不通知（只显示角标）",
};

/** 重置会删的每一类，中文计数；没有的类不列。 */
function resetLines(plan: ResetPlan): string[] {
  const lines: [number, string][] = [
    [plan.conversations, "个对话"],
    [plan.memorySources, "个记忆来源"],
    [plan.memories, "条导入的记忆"],
    [plan.schedules, "个定时任务"],
    [plan.responsibilities, "项职责"],
    [plan.followUps, "个定时跟进"],
    [plan.formedMemories, "条它自己记下的记忆"],
    [plan.backgroundResearch, "项后台调研"],
    [plan.standingApprovals, "条长期授权"],
  ];
  return lines.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`);
}

function ResetDialog({
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentProfile;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const plan = useQuery({ ...botResetPlanQueryOptions(agent.id), enabled: open });
  const reset = useMutation(resetBotMutationOptions(sharedQueryClient));
  const lines = plan.data ? resetLines(plan.data) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`重置「${agent.name}」？`}</DialogTitle>
          <DialogDescription>
            {"只删除你和它之间的内容，不影响别人。删除后无法恢复。"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? (
            <PageSkeleton rows={2} />
          ) : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              {"无法计算重置会删除的内容。"}
            </p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>{"没有可以删除的内容。"}</p>
              ) : (
                <>
                  <p>{"将删除："}</p>
                  <ul className="list-disc pl-5">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.data.sharedConversationsKept > 0 ? (
                <p className="text-muted-foreground">
                  {`${plan.data.sharedConversationsKept} 个和别人共享的对话会保留。`}
                </p>
              ) : null}
              <p className="text-muted-foreground">{"你直接告诉它要记住的内容会保留。"}</p>
            </div>
          )}
          {reset.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {reset.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" variant="outline">
            {"取消"}
          </Button>
          <Button
            disabled={!plan.data || lines.length === 0 || reset.isPending}
            onClick={() => {
              // 重置要分几步删数据：DESIGN.md §1 ③，整页加载层。
              onOpenChange(false);
              void runWithPageLoader(
                {
                  title: "正在重置机器人…",
                  description: "正在删除它的数据并恢复到初始状态，请稍候。",
                  successText: "已重置",
                  errorTitle: "重置失败",
                },
                () => reset.mutateAsync(agent.id),
              ).catch(() => undefined);
            }}
            size="sm"
            variant="destructive"
          >
            {"删除并重置"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 头部那一行状态：模型 · 运行中 / 已暂停（职责就在下面「资料」卡里，不重复）。 */
function StatusLine({ agent }: { agent: AgentProfile }) {
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const model = useQuery(agentModelQueryOptions(agent.id));
  const catalog = useQuery(modelCatalogQueryOptions());
  const modelId = model.data?.available ? model.data.model : null;
  const modelLabel = modelId
    ? (catalog.data?.models.find((entry) => entry.id === modelId)?.label ?? modelId)
    : model.data && !model.data.available
      ? "外部机器人"
      : null;
  const paused = lifecycle.data?.paused;
  return (
    <span className="bp-status">
      {modelLabel ? (
        <span className="bp-status-item" title={modelId ?? undefined}>
          {modelLabel}
        </span>
      ) : null}
      {paused === undefined ? null : (
        <span className={paused ? "bp-status-item bp-state is-paused" : "bp-status-item bp-state"}>
          <span aria-hidden className="bp-state-dot" />
          {paused ? "已暂停" : "运行中"}
        </span>
      )}
    </span>
  );
}

/** 资料：看的时候是三行，点「编辑」就地变成和新建一样的表单（BotProfileForm，DESIGN.md §81），一次保存。 */
export function IdentityCard({
  agent,
  editing,
  setEditing,
  firstFieldRef,
}: {
  agent: AgentProfile;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  firstFieldRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [expanded, setExpanded] = useState(false);

  if (editing) {
    return (
      <Card className="bp-card">
        <BotProfileForm
          agent={agent}
          firstFieldRef={firstFieldRef}
          onCancel={() => setEditing(false)}
          onSaved={() => setEditing(false)}
          variant="card"
        />
      </Card>
    );
  }

  const long = agent.roleDescription.length > 160 || agent.roleDescription.split("\n").length > 3;
  return (
    <Card className="bp-card">
      <div className="bp-row">
        <span className="bp-label">{"名称"}</span>
        <span className="bp-value">{agent.name}</span>
      </div>
      <div className="bp-row">
        <span className="bp-label">{"职责"}</span>
        <span className="bp-value">{agent.title}</span>
      </div>
      <div className="bp-row is-block">
        <span className="bp-label">{"它做什么"}</span>
        <p className={expanded || !long ? "bp-prompt" : "bp-prompt is-clamped"}>{agent.roleDescription}</p>
        {long ? (
          <button className="bp-more" onClick={() => setExpanded((v) => !v)} type="button">
            {expanded ? "收起" : "展开全部"}
          </button>
        ) : null}
      </div>
    </Card>
  );
}

/** 运行：模型 · 暂停 · 通知（· 浏览器通知还没开时）。 */
function RunCard({ agent }: { agent: AgentProfile }) {
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const pause = useMutation(setBotPausedMutationOptions(sharedQueryClient));
  const notify = useMutation(setBotNotifyMutationOptions(sharedQueryClient));
  const [permission, setPermission] = useState<string>(() => {
    try {
      return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
    } catch {
      return "unsupported";
    }
  });
  return (
    <Card className="bp-card">
      <SettingRow className="bp-srow" title={"模型"}>
        <div className="bp-model">
          <BotModelSelector agentId={agent.id} bare />
        </div>
      </SettingRow>
      {lifecycle.isPending ? (
        <div className="bp-srow-skel"><PageSkeleton rows={2} /></div>
      ) : lifecycle.error ? (
        <p className="bp-error px-5 py-4" role="alert">
          {"无法加载运行状态。"}
        </p>
      ) : (
        <>
          <SettingRow
            className="bp-srow is-inline"
            description={"暂停后，定时任务、长期任务和后台工作都不再运行。"}
            title={"暂停"}
          >
            <Switch
              aria-label={"暂停"}
              checked={lifecycle.data.paused}
              disabled={pause.isPending}
              onCheckedChange={(paused) => pause.mutate({ agentId: agent.id, paused })}
            />
          </SettingRow>
          <SettingRow className="bp-srow" description={"左栏的角标始终显示。"} title={"通知"}>
            <Select
              disabled={notify.isPending}
              items={NOTIFY_LABEL}
              onValueChange={(next) =>
                next && notify.mutate({ agentId: agent.id, notify: next as BotNotify })
              }
              value={lifecycle.data.notify}
            >
              <SelectTrigger aria-label={"通知"} className="bp-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(NOTIFY_LABEL) as BotNotify[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {NOTIFY_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
          {permission === "default" && lifecycle.data.notify !== "none" ? (
            <SettingRow
              className="bp-srow is-inline"
              description={"这个浏览器还没允许通知。"}
              title={"浏览器通知"}
            >
              <Button
                onClick={async () => {
                  try {
                    setPermission(await Notification.requestPermission());
                  } catch {
                    setPermission("unsupported");
                  }
                }}
                size="sm"
                variant="outline"
              >
                {"允许"}
              </Button>
            </SettingRow>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** 任务：只在有任务时出现；进行中、已计划、最近完成（最多 5 条）一张卡。 */
function TasksSection({ agentId }: { agentId: string }) {
  const activity = useQuery(botActivityQueryOptions(agentId));
  if (!activity.data) return null;
  const groups: [string, ActivityItem[]][] = [
    ["进行中", activity.data.inProgress],
    ["已计划", activity.data.scheduled],
    ["最近完成", activity.data.completed.slice(0, 5)],
  ];
  if (groups.every(([, items]) => items.length === 0)) return null;
  return (
    <PageSection title={"任务"}>
      <Card className="bp-card">
        {groups.map(([label, items]) =>
          items.length === 0 ? null : (
            <Fragment key={label}>
              <div className="bp-group">{label}</div>
              <div className="bp-tasks">
                {items.map((item) => (
                  <ActivityRow agentId={agentId} item={item} key={item.id} />
                ))}
              </div>
            </Fragment>
          ),
        )}
      </Card>
    </PageSection>
  );
}

/** 机器人资料页。 */
export function BotProfilePage({ agent }: { agent: AgentProfile }) {
  const navigate = useNavigate();
  const { mainBotId } = useMainBot();
  const isMain = mainBotId === agent.id;
  const [editing, setEditing] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const identityRef = useRef<HTMLDivElement | null>(null);
  const canEdit = agent.canManage;
  const canDelete = agent.canDelete ?? agent.canManage;

  const startEdit = () => {
    setEditing(true);
    requestAnimationFrame(() => {
      identityRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      firstFieldRef.current?.focus();
    });
  };

  return (
    <PageShell
      action={
        <div className="bp-actions">
          <Button
            onClick={() => void navigate({ search: { agent: agent.id }, to: "/channel/new" })}
            size="sm"
          >
            <IconMessage />
            {"开始聊天"}
          </Button>
          {canEdit ? (
            <Button disabled={editing} onClick={startEdit} size="sm" variant="outline">
              <IconPencil />
              {"编辑"}
            </Button>
          ) : null}
          {canDelete ? (
            <span title={isMain ? "先把别的机器人设为主机器人" : undefined}>
              <Button
                aria-label={"删除机器人"}
                className="bp-delete"
                disabled={isMain}
                onClick={() => setDeleteOpen(true)}
                size="sm"
                title={isMain ? "先把别的机器人设为主机器人" : "删除机器人"}
                variant="ghost"
              >
                <IconTrash />
                <span className="bp-delete-text">{"删除"}</span>
              </Button>
            </span>
          ) : null}
        </div>
      }
      backButton={{ label: "机器人", linkProps: { to: "/bots" } }}
      className="bot-profile"
      description={<StatusLine agent={agent} />}
      media={<AbstractAvatar agentId={agent.id} name={agent.name} seed={agent.avatarSeed} size={56} />}
      title={agent.name}
    >
      <div ref={identityRef}>
        <PageSection title={"资料"}>
          <IdentityCard
            agent={agent}
            editing={editing}
            firstFieldRef={firstFieldRef}
            // 审查 10-1：只按机器人 id 换实例。以前按名称/职责/它做什么拼 key，改名保存时 PATCH 一回来表单就被换掉，
            // 随后头像保存失败的错误落在已卸载的实例上，用户看到的是「保存成功」。
            key={agent.id}
            setEditing={setEditing}
          />
        </PageSection>
      </div>
      <PageSection title={"运行"}>
        <RunCard agent={agent} />
      </PageSection>
      <TasksSection agentId={agent.id} />
      <BotFilesAndPagesSection agentId={agent.id} />
      <div className="bp-footer">
        <Button onClick={() => setResetOpen(true)} size="sm" variant="ghost">
          <IconRefresh />
          {"重置对话和记忆…"}
        </Button>
      </div>
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
      {canDelete ? (
        <DeleteBotDialog
          bot={{ id: agent.id, name: agent.name }}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
        />
      ) : null}
    </PageShell>
  );
}
