import {
  IconArrowsExchange,
  IconChevronRight,
  IconDots,
  IconMessage,
  IconStar,
  IconStarFilled,
  IconStarOff,
  IconTrash,
  IconUserCircle,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { mainBotCandidates } from "@/components/agents/main-bot-picker";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import {
  PageEmpty,
  PageRows,
  PageShell,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { lazyDialog } from "@/components/ui/lazy-dialog";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import { createdByLabel } from "@/lib/agents/created-by";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { latestChannelFor } from "@/lib/channels/latest";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useMainBot } from "@/lib/settings/message-list";

const DeleteBotDialog = lazyDialog(() =>
  import("@/components/agents/delete-bot-dialog").then(
    (m) => m.DeleteBotDialog,
  ),
);

const MainBotPickerDialog = lazyDialog(() =>
  import("@/components/agents/main-bot-picker").then(
    (m) => m.MainBotPickerDialog,
  ),
);

export const Route = createFileRoute("/_authed/_app/bots/")({
  component: BotsPage,
});

/**
 * 机器人列表（Track D）：每一行一键打开该机器人的聊天 compose（正确 `?agent=` / 已有频道），
 * 主 Agent 自动置顶并带星标徽饰，行尾菜单支持设置/取消/更换主 Agent，资料页仍从右侧箭头进入。
 */
function BotsPage() {
  const navigate = useNavigate();
  const agents = useQuery(agentListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const { mainBotId, setMainBotAsync } = useMainBot();
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));
  const allAgents = agents.data ?? [];
  const orderedAgents = mainBotId
    ? [
        ...allAgents.filter((agent) => agent.id === mainBotId),
        ...allAgents.filter((agent) => agent.id !== mainBotId),
      ]
    : allAgents;

  async function openCompose(agentId: string) {
    const existing = latestChannelFor(agentId, channels.data)?.id;
    if (existing) {
      await navigate({
        to: "/channel/$channelId",
        params: { channelId: existing },
      });
      return;
    }
    await navigate({ to: "/channel/new", search: { agent: agentId } });
  }

  async function applyMainBot(nextAgentId: string | null) {
    try {
      await setMainBotAsync(nextAgentId);
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "更新主 Agent 失败",
      );
    }
  }

  return (
    <PageShell
      description={"点一行就打开和这个机器人的对话；箭头进资料。"}
      title={"机器人"}
    >
      {/*
        只有「手里没有列表 + 读失败」才把整页换成错误：react-query 在「有缓存数据 + 后台 refetch 失败」时
        isError 仍为 true，按 `agents.error` 判断会把本来正常的名单替换成「暂时无法加载」（和上游 #463 同一类，
        2026-10-20 清基线时抓到）。
      */}
      {agents.isPending ? (
        <PageSkeleton />
      ) : agents.error && !agents.data ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {"机器人列表暂时无法加载。"}
        </p>
      ) : agents.data.length === 0 ? (
        <PageEmpty>{"你还没有机器人。"}</PageEmpty>
      ) : (
        <PageRows className="mt-6">
          {orderedAgents.map((agent, index) => {
            const state = byId.get(agent.id);
            const summary = state
              ? [state.paused ? "已暂停" : "", attentionSummary(state)]
                  .filter(Boolean)
                  .join(" · ")
              : "";
            const createdBy = createdByLabel(agent, allAgents);
            const isMain = mainBotId === agent.id;
            const canDelete = agent.canDelete ?? agent.canManage;
            const canReplaceMain =
              isMain && mainBotCandidates(allAgents, agent.id).length > 0;
            return (
              <Fragment key={agent.id}>
                {index > 0 ? <Separator /> : null}
                <Item
                  data-bot-id={agent.id}
                  data-primary={isMain ? "true" : "false"}
                  data-testid={`bot-row-${agent.id}`}
                  size="sm"
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => void openCompose(agent.id)}
                    type="button"
                  >
                    <ItemMedia>
                      <div className="glass-bot-ava">
                        <AbstractAvatar
                          agentId={agent.id}
                          name={agent.name}
                          seed={agent.avatarSeed}
                          size={28}
                        />
                        {isMain ? (
                          <span
                            aria-hidden
                            className="glass-bot-star"
                            data-testid="primary-agent-star"
                          >
                            <IconStarFilled className="size-2.5" />
                          </span>
                        ) : null}
                      </div>
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="flex items-center gap-1.5">
                        <span className="truncate">{agent.name}</span>
                        {isMain ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-px font-medium text-[11px] text-amber-700 dark:text-amber-300"
                            data-testid="primary-agent-badge"
                          >
                            <IconStarFilled aria-hidden className="size-2.5" />
                            {"主 Agent"}
                          </span>
                        ) : null}
                      </ItemTitle>
                      <ItemDescription>
                        {createdBy ? (
                          <span
                            className="mr-1.5 inline-flex items-center rounded-full bg-muted px-1.5 py-px font-medium text-[11px] text-muted-foreground"
                            data-testid="created-by-badge"
                          >
                            {createdBy}
                          </span>
                        ) : null}
                        {summary || agent.title}
                      </ItemDescription>
                    </ItemContent>
                  </button>
                  <ItemActions>
                    {state && needsInput(state) > 0 ? (
                      <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground tabular-nums">
                        {needsInput(state)}
                      </span>
                    ) : null}
                    <Button
                      aria-label={`和「${agent.name}」聊天`}
                      onClick={() => void openCompose(agent.id)}
                      size="icon-xs"
                      title={"开始聊天"}
                      type="button"
                      variant="ghost"
                    >
                      <IconMessage className="size-4" />
                    </Button>
                    <DropdownMenu
                      onOpenChange={(next) => {
                        if (next) {
                          DeleteBotDialog.preload();
                          MainBotPickerDialog.preload();
                        }
                      }}
                    >
                      <DropdownMenuTrigger
                        render={
                          <Button
                            aria-label={`「${agent.name}」更多操作`}
                            data-testid={`bot-row-menu-${agent.id}`}
                            size="icon-xs"
                            title={"更多操作"}
                            type="button"
                            variant="ghost"
                          />
                        }
                      >
                        <IconDots className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="glass-pop w-[240px] p-1.5"
                      >
                        {isMain ? (
                          <DropdownMenuItem
                            className="glass-mi"
                            onClick={() => void applyMainBot(null)}
                          >
                            <IconStarOff className="size-4 shrink-0" />
                            <span>{"取消主 Agent"}</span>
                          </DropdownMenuItem>
                        ) : !agent.hidden ? (
                          <DropdownMenuItem
                            className="glass-mi"
                            onClick={() => void applyMainBot(agent.id)}
                          >
                            <IconStar className="size-4 shrink-0" />
                            <span>{"设为主 Agent"}</span>
                          </DropdownMenuItem>
                        ) : null}
                        {canReplaceMain ? (
                          <DropdownMenuItem
                            className="glass-mi"
                            onClick={() => {
                              setPickerTarget({
                                id: agent.id,
                                name: agent.name,
                              });
                              setPickerOpen(true);
                            }}
                          >
                            <IconArrowsExchange className="size-4 shrink-0" />
                            <span>{"更换主 Agent…"}</span>
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                          className="glass-mi"
                          render={
                            <Link
                              params={{ agentId: agent.id }}
                              to="/bots/$agentId"
                            />
                          }
                        >
                          <IconUserCircle className="size-4 shrink-0" />
                          <span>{"查看资料"}</span>
                        </DropdownMenuItem>
                        {canDelete ? (
                          <>
                            <DropdownMenuSeparator className="glass-sep" />
                            <DropdownMenuItem
                              className="glass-mi"
                              data-testid={`bot-row-delete-${agent.id}`}
                              disabled={isMain}
                              onClick={() => {
                                if (isMain) return;
                                setDeleteTarget({
                                  id: agent.id,
                                  name: agent.name,
                                });
                                setDeleteOpen(true);
                              }}
                              variant={isMain ? "default" : "destructive"}
                            >
                              <IconTrash className="size-4 shrink-0" />
                              <span className="min-w-0 flex-1">
                                <span className="block">{"删除机器人…"}</span>
                                {isMain ? (
                                  <span className="glass-mi-sub">
                                    {"需先取消或更换主 Agent"}
                                  </span>
                                ) : null}
                              </span>
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Link
                      aria-label={`「${agent.name}」的资料`}
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60"
                      params={{ agentId: agent.id }}
                      title={"资料"}
                      to="/bots/$agentId"
                    >
                      <IconChevronRight className="size-4" />
                    </Link>
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
      {deleteTarget ? (
        <DeleteBotDialog
          bot={deleteTarget}
          onOpenChange={setDeleteOpen}
          open={deleteOpen}
        />
      ) : null}
      {pickerTarget ? (
        <MainBotPickerDialog
          currentName={pickerTarget.name}
          onOpenChange={setPickerOpen}
          open={pickerOpen}
        />
      ) : null}
    </PageShell>
  );
}
