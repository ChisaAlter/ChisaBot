import { IconChevronRight, IconMessage } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Fragment } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  attentionSummary,
  needsInput,
} from "@/components/bot-profile/attention";
import { PageEmpty, PageRows, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { botAttentionQueryOptions } from "@/lib/bot-lifecycle/queries";
import { latestChannelFor } from "@/lib/channels/latest";
import { channelListQueryOptions } from "@/lib/channels/queries";

export const Route = createFileRoute("/_authed/_app/bots/")({
  component: BotsPage,
});

/**
 * 机器人列表（Track D）：每一行一键打开该机器人的聊天 compose（正确 `?agent=` / 已有频道），
 * 资料页仍从右侧箭头进入。用 ChisaBot Item / Button，不引入外站 chrome。
 */
function BotsPage() {
  const navigate = useNavigate();
  const agents = useQuery(agentListQueryOptions());
  const attention = useQuery(botAttentionQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const byId = new Map((attention.data ?? []).map((bot) => [bot.agentId, bot]));

  async function openCompose(agentId: string) {
    const existing = latestChannelFor(agentId, channels.data)?.id;
    if (existing) {
      await navigate({ to: "/channel/$channelId", params: { channelId: existing } });
      return;
    }
    await navigate({ to: "/channel/new", search: { agent: agentId } });
  }

  return (
    <PageShell
      description={"点一行就打开和这个机器人的对话；箭头进资料。"}
      title={"机器人"}
    >
      {agents.isPending ? (
        <PageSkeleton />
      ) : agents.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {"机器人列表暂时无法加载。"}
        </p>
      ) : agents.data.length === 0 ? (
        <PageEmpty>{"你还没有机器人。"}</PageEmpty>
      ) : (
        <PageRows className="mt-6">
          {agents.data.map((agent, index) => {
            const state = byId.get(agent.id);
            const summary = state
              ? [state.paused ? "Paused" : "", attentionSummary(state)].filter(Boolean).join(" · ")
              : "";
            return (
              <Fragment key={agent.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => void openCompose(agent.id)}
                    type="button"
                  >
                    <ItemMedia>
                      <AbstractAvatar
                        agentId={agent.id}
                        name={agent.name}
                        seed={agent.avatarSeed}
                        size={28}
                      />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{agent.name}</ItemTitle>
                      <ItemDescription>{summary || agent.title}</ItemDescription>
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
    </PageShell>
  );
}
