import {
  IconBell,
  IconChevronRight,
  IconCpu,
  IconLayoutDashboard,
  IconMessage,
  IconPlayerPause,
  IconRefresh,
  IconRoute,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, type KeyboardEvent, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { BotModelSelector } from "@/components/agents/bot-model-selector";
import { DeleteBotDialog } from "@/components/agents/delete-bot-dialog";
import { BotComputerAccess } from "@/components/devices/bot-computer-access";
import { PageRows } from "@/components/layout/page-shell";
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
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { runWithPageLoader } from "@/components/ui/page-loader";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import { agentQueryOptions } from "@/lib/agents/queries";
import {
  resetBotMutationOptions,
  setBotNotifyMutationOptions,
  setBotPausedMutationOptions,
  setUpdateRoutingMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type BotNotify,
  botLifecycleQueryOptions,
  botResetPlanQueryOptions,
  type ResetPlan,
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import {
  type MemoryRecord,
  type MemorySource,
  memoriesQueryOptions,
  memorySourcesQueryOptions,
} from "@/lib/memory";
import { showPanels } from "@/lib/panels/rail-open";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { BotWorkLists } from "./activity";

/**
 * Who this Bot is, in a pane beside the conversation (or on its own when it has no conversation yet).
 *
 * This is not a PageShell configuration essay. The identity, the three tabs, and the short task
 * list are the page; model, pause, notifications, reset, and delete stay reachable inside 详情,
 * in one settings card, instead of a stack of sections down the center column. Settings rows
 * still use PageRows and Item — only the frame around them is a pane.
 */

const TABS = [
  { id: "details", label: "详情" },
  { id: "library", label: "资料库" },
  { id: "computer", label: "电脑" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const NOTIFY_LABEL: Record<BotNotify, string> = {
  all: "全部",
  needs_input: "仅在需要我时",
  none: "仅侧边栏徽章",
};

const KIND_LABEL: Record<UpdateKind, { title: string; description: string }> = {
  progress: {
    title: "进度",
    description: "您未关注的工作的回复和结果。",
  },
  decision: {
    title: "决策",
    description: "机器人执行前需要的审批。",
  },
  question: {
    title: "问题",
    description: "机器人向您询问并等待的内容。",
  },
};

const TRANSPORTS: { id: UpdateTransport; label: string }[] = [
  { id: "push", label: "推送" },
  { id: "slack", label: "Slack" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "sms", label: "短信" },
];

function resetLines(plan: ResetPlan): string[] {
  const lines: [number, string, string][] = [
    [plan.conversations, "conversation", "conversations"],
    [plan.memorySources, "memory source", "memory sources"],
    [plan.memories, "imported memory", "imported memories"],
    [plan.routines, "routine", "routines"],
    [plan.responsibilities, "responsibility", "responsibilities"],
    [plan.followUps, "scheduled follow-up", "scheduled follow-ups"],
    [plan.formedMemories, "memory it formed", "memories it formed"],
    [plan.backgroundResearch, "background research", "background research"],
    [plan.standingApprovals, "standing permission", "standing permissions"],
  ];
  return lines
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
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
  const plan = useQuery({
    ...botResetPlanQueryOptions(agent.id),
    enabled: open,
  });
  const reset = useMutation(resetBotMutationOptions(queryClient));
  const lines = plan.data ? resetLines(plan.data) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {"重置 "}
            {agent.name}?
          </DialogTitle>
          <DialogDescription>
            {"此操作将删除 "}
            {agent.name}
            {
              " 与您有的内容，仅与您。没有人触及其他人的对话或数据。这不可撤销。"
            }
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? null : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              {"无法计算重置会删除的内容。"}
            </p>
          ) : reset.isSuccess ? (
            <p className="text-sm">
              {"完成。"}
              {agent.name}
              {" 与你重新开始。"}
            </p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>{"没有您的可删除内容。"}</p>
              ) : (
                <>
                  <p>{"这将删除："}</p>
                  <ul className="list-disc pl-5">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.data.sharedConversationsKept > 0 ? (
                <p className="text-muted-foreground">
                  {plan.data.sharedConversationsKept}
                  {" 个与其他人或机器人共享的对话将被保留。"}
                </p>
              ) : null}
              <p className="text-muted-foreground">
                {"您自己的记忆，即您直接告诉机器人的那些记忆，被保留。"}
              </p>
            </div>
          )}
          {reset.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {reset.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            {reset.isSuccess ? "关闭" : "取消"}
          </Button>
          {reset.isSuccess ? null : (
            <Button
              disabled={!plan.data || lines.length === 0 || reset.isPending}
              onClick={() => {
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
              {reset.isPending ? "正在重置…" : "删除并重置"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UpdateRoutingRows() {
  const routing = useQuery(updateRoutingQueryOptions());
  const save = useMutation(setUpdateRoutingMutationOptions(queryClient));
  if (routing.isPending) return null;
  if (routing.error) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {"无法加载更新去向。"}
      </p>
    );
  }
  return (
    <PageRows>
      {(Object.keys(KIND_LABEL) as UpdateKind[]).map((kind, index) => {
        const current = routing.data[kind];
        const allowed = (transport: UpdateTransport) =>
          current === "all" || current.includes(transport);
        return (
          <Fragment key={kind}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconRoute />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{KIND_LABEL[kind].title}</ItemTitle>
                <ItemDescription>
                  {KIND_LABEL[kind].description}
                </ItemDescription>
              </ItemContent>
              <ItemFooter className="gap-4 pl-8">
                {TRANSPORTS.map((transport) => (
                  <div
                    className="flex items-center gap-2 text-sm"
                    key={transport.id}
                  >
                    <Switch
                      aria-label={`${KIND_LABEL[kind].title} 由 ${transport.label}`}
                      checked={allowed(transport.id)}
                      disabled={save.isPending}
                      onCheckedChange={(checked) => {
                        const next = TRANSPORTS.map((item) => item.id).filter(
                          (id) => (id === transport.id ? checked : allowed(id)),
                        );
                        save.mutate({
                          kind,
                          transports:
                            next.length === TRANSPORTS.length ? "all" : next,
                        });
                      }}
                      size="sm"
                    />
                    {transport.label}
                  </div>
                ))}
              </ItemFooter>
            </Item>
          </Fragment>
        );
      })}
    </PageRows>
  );
}

function RuntimeCard({
  agent,
  showChatLink,
}: {
  agent: AgentProfile;
  showChatLink: boolean;
}) {
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const pause = useMutation(setBotPausedMutationOptions(queryClient));
  const notify = useMutation(setBotNotifyMutationOptions(queryClient));
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [permission, setPermission] = useState<string>(() => {
    try {
      return typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission;
    } catch {
      return "unsupported";
    }
  });

  return (
    <div className="mt-8 grid gap-3">
      <h3 className="text-xs font-medium text-muted-foreground">{"运行"}</h3>
      {lifecycle.isPending ? null : lifecycle.error ? (
        <p className="text-destructive text-sm" role="alert">
          {"无法加载此机器人的状态。"}
        </p>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconCpu />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{"模型"}</ItemTitle>
              <ItemDescription>{"与聊天输入框保持同步。"}</ItemDescription>
            </ItemContent>
            <ItemFooter>
              <BotModelSelector agentId={agent.id} compact />
            </ItemFooter>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconPlayerPause />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{"已暂停"}</ItemTitle>
              <ItemDescription>
                {lifecycle.data.paused
                  ? "您没有定时任务、长期任务、移交或后续任务开始运行，已运行的已停止。"
                  : "为您运行定时任务、长期任务、交接和后续工作。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={"已暂停"}
                checked={lifecycle.data.paused}
                disabled={pause.isPending}
                onCheckedChange={(paused) =>
                  pause.mutate({ agentId: agent.id, paused })
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconBell />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{"通知"}</ItemTitle>
              <ItemDescription>
                {NOTIFY_LABEL[lifecycle.data.notify]}
                {"。侧边栏徽章始终显示。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <select
                aria-label={"通知"}
                className="h-8 max-w-full rounded-md border bg-background px-2 text-sm"
                disabled={notify.isPending}
                onChange={(event) =>
                  notify.mutate({
                    agentId: agent.id,
                    notify: event.target.value as BotNotify,
                  })
                }
                value={lifecycle.data.notify}
              >
                {(Object.keys(NOTIFY_LABEL) as BotNotify[]).map((value) => (
                  <option key={value} value={value}>
                    {NOTIFY_LABEL[value]}
                  </option>
                ))}
              </select>
            </ItemActions>
          </Item>
          {permission === "default" ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBell />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{"浏览器通知"}</ItemTitle>
                  <ItemDescription>
                    {"此浏览器中关闭。打开它们以在机器人需要您时听到。"}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
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
                    {"开启"}
                  </Button>
                </ItemActions>
              </Item>
            </>
          ) : null}
          <Separator />
          <Item
            render={<button onClick={() => showPanels()} type="button" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconLayoutDashboard />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{"自定义面板"}</ItemTitle>
              <ItemDescription>
                {"它做的仪表盘、列表和小工具。"}
              </ItemDescription>
            </ItemContent>
          </Item>
          {showChatLink ? (
            <>
              <Separator />
              <Item
                render={<Link search={{ agent: agent.id }} to="/channel/new" />}
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconMessage />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{"发消息"}</ItemTitle>
                  <ItemDescription>{"开始一段对话。"}</ItemDescription>
                </ItemContent>
              </Item>
            </>
          ) : null}
          <Separator />
          <Item
            render={<button onClick={() => setResetOpen(true)} type="button" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconRefresh />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{"重置"}</ItemTitle>
              <ItemDescription>
                {
                  "删除与它的对话、它记住的内容以及它的定时任务。你可以看到先删除什么。"
                }
              </ItemDescription>
            </ItemContent>
          </Item>
          {(agent.canDelete ?? agent.canManage) ? (
            <>
              <Separator />
              <Item
                render={
                  <button onClick={() => setDeleteOpen(true)} type="button" />
                }
                size="sm"
              >
                <ItemMedia className="text-destructive" variant="icon">
                  <IconTrash />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="text-destructive">
                    {"删除机器人"}
                  </ItemTitle>
                  <ItemDescription>
                    {
                      "彻底删除这个机器人，以及你与它的私人会话、记忆、定时任务和面板。此操作无法撤消。"
                    }
                  </ItemDescription>
                </ItemContent>
              </Item>
            </>
          ) : null}
        </PageRows>
      )}
      <button
        aria-expanded={routingOpen}
        className="flex w-full items-center justify-between rounded-md py-1 text-left text-sm text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onClick={() => setRoutingOpen((open) => !open)}
        type="button"
      >
        <span>{"不在时，更新去哪里"}</span>
        <IconChevronRight
          className={cn(
            "size-4 transition-transform",
            routingOpen && "rotate-90",
          )}
        />
      </button>
      {routingOpen ? (
        <div className="grid gap-2">
          <p className="text-muted-foreground text-xs">
            {"网页总是显示一切。这里的选择适用于你的所有机器人。"}
          </p>
          <UpdateRoutingRows />
        </div>
      ) : null}
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
      {deleteOpen ? (
        <DeleteBotDialog
          bot={{ id: agent.id, name: agent.name }}
          onOpenChange={setDeleteOpen}
          open
        />
      ) : null}
    </div>
  );
}

function LibraryTab({ agentId }: { agentId: string }) {
  const memories = useQuery(memoriesQueryOptions());
  const sources = useQuery(memorySourcesQueryOptions());
  if (memories.isPending || sources.isPending) return null;
  if (memories.error || sources.error) {
    return (
      <p className="py-3 text-destructive text-sm" role="alert">
        {"无法加载这个机器人的资料。"}
      </p>
    );
  }
  const mine = (memories.data ?? []).filter(
    (memory: MemoryRecord) => memory.formedByAgentId === agentId,
  );
  const feeds = (sources.data ?? []).filter(
    (source: MemorySource) => source.agentId === agentId,
  );
  if (mine.length === 0 && feeds.length === 0) {
    return (
      <div className="grid gap-3 py-3">
        <p className="text-muted-foreground text-sm">
          {"还没有这个机器人写下的资料。它形成的记忆会出现在这里。"}
        </p>
        <Link
          className="text-sm underline-offset-4 hover:underline"
          to="/memory"
        >
          {"打开全部记忆"}
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-6 py-1">
      {feeds.length > 0 ? (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground">
            {"来源"}
          </h3>
          <ul className="mt-2 grid gap-2">
            {feeds.map((source) => (
              <li className="min-w-0" key={source.id}>
                <p className="truncate text-sm">{source.title}</p>
                <p className="text-muted-foreground text-xs">
                  {source.enabled ? "启用" : "已停用"}
                  {" · "}
                  {source.syncStatus === "running"
                    ? "正在同步"
                    : source.syncStatus === "error"
                      ? "同步失败"
                      : source.syncStatus === "succeeded"
                        ? "已同步"
                        : "尚未同步"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {mine.length > 0 ? (
        <section>
          <h3 className="text-xs font-medium text-muted-foreground">
            {"它记住的"}
          </h3>
          <ul className="mt-2 grid gap-3">
            {mine.map((memory) => (
              <li className="min-w-0" key={memory.id}>
                <p className="line-clamp-3 text-sm">{memory.content}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Link className="text-sm underline-offset-4 hover:underline" to="/memory">
        {"打开全部记忆"}
      </Link>
    </div>
  );
}

function ComputerTab({
  agentId,
  botName,
  onOpenComputer,
}: {
  agentId: string;
  botName: string;
  onOpenComputer?: () => void;
}) {
  return (
    <div className="grid gap-4 py-1">
      <p className="text-muted-foreground text-sm">
        {"设备属于你的账号。这个机器人可以使用在线、并且已经打开能力的设备。"}
      </p>
      {onOpenComputer ? (
        <Button onClick={onOpenComputer} size="sm" variant="outline">
          {"查看计算机画面"}
        </Button>
      ) : null}
      <BotComputerAccess agentId={agentId} botName={botName} compact />
    </div>
  );
}

function Identity({
  onEdit,
  profile,
}: {
  onEdit: () => void;
  profile: AgentProfile;
}) {
  return (
    <header className="flex flex-col items-center gap-2 px-5 pt-6 text-center">
      <AbstractAvatar name={profile.name} seed={profile.avatarSeed} size={72} />
      <h2 className="text-balance font-semibold text-xl tracking-tight">
        {profile.name}
      </h2>
      {profile.title ? (
        <p className="text-balance text-muted-foreground text-sm">
          {profile.title}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-center gap-1.5">
        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
          {profile.visibility === "private" ? "私有" : "公开"}
        </span>
        {profile.systemOwned ? (
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
            {"系统"}
          </span>
        ) : null}
      </div>
      {profile.roleDescription ? (
        <p className="line-clamp-2 max-w-sm text-pretty text-muted-foreground text-sm">
          {profile.roleDescription}
        </p>
      ) : null}
      <Button onClick={onEdit} size="sm" variant="ghost">
        {profile.canManage ? "编辑资料" : "查看资料"}
      </Button>
    </header>
  );
}

export function BotDetailPane({
  agentId,
  onOpenComputer,
  showChatLink = false,
}: {
  agentId: string;
  /** Opens the conversation's computer view. Absent on the standalone page. */
  onOpenComputer?: () => void;
  /** The pane is not beside a conversation, so offer a way to start one. */
  showChatLink?: boolean;
}) {
  const agent = useQuery(agentQueryOptions(agentId));
  const [tab, setTab] = useState<TabId>("details");
  const [editing, setEditing] = useState(false);

  if (agent.isPending) return null;
  if (agent.error || !agent.data) {
    return (
      <div className="px-5 py-8">
        <p className="text-destructive text-sm" role="alert">
          {"无法加载这个机器人。"}
        </p>
        <Button
          className="mt-3"
          onClick={() => void agent.refetch()}
          size="sm"
          variant="outline"
        >
          {"重试"}
        </Button>
      </div>
    );
  }

  const profile = agent.data;
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === tab);
    const next =
      event.key === "ArrowRight"
        ? TABS[(index + 1) % TABS.length]
        : TABS[(index + TABS.length - 1) % TABS.length];
    if (!next) return;
    setTab(next.id);
    document.getElementById(`bot-tab-${profile.id}-${next.id}`)?.focus();
  };

  return (
    <div className="flex w-full flex-col pb-8">
      <Identity onEdit={() => setEditing(true)} profile={profile} />
      <div
        aria-label={"机器人详情"}
        className="mt-4 flex border-[var(--line)] border-b px-2"
        onKeyDown={onTabKey}
        role="tablist"
      >
        {TABS.map((item) => {
          const selected = tab === item.id;
          return (
            <button
              aria-controls={`bot-panel-${profile.id}-${item.id}`}
              aria-selected={selected}
              className={cn(
                "-mb-px inline-flex h-10 flex-1 items-center justify-center border-b-2 font-medium text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected
                  ? "border-[var(--accent-blue)] text-[var(--ink-1)]"
                  : "border-transparent text-[var(--ink-3)] hover:text-[var(--ink-1)]",
              )}
              id={`bot-tab-${profile.id}-${item.id}`}
              key={item.id}
              onClick={() => setTab(item.id)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        aria-labelledby={`bot-tab-${profile.id}-${tab}`}
        className="px-5 pt-4"
        id={`bot-panel-${profile.id}-${tab}`}
        role="tabpanel"
      >
        {tab === "details" ? (
          <>
            <BotWorkLists agentId={profile.id} />
            <RuntimeCard agent={profile} showChatLink={showChatLink} />
          </>
        ) : null}
        {tab === "library" ? <LibraryTab agentId={profile.id} /> : null}
        {tab === "computer" ? (
          <ComputerTab
            agentId={profile.id}
            botName={profile.name}
            onOpenComputer={onOpenComputer}
          />
        ) : null}
      </div>
      {editing ? (
        <AgentDialog
          agentId={profile.id}
          onClose={() => setEditing(false)}
          open
        />
      ) : null}
    </div>
  );
}
