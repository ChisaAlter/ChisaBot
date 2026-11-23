import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { memo, useMemo } from "react";
import { BotAvatar } from "@/components/agents/bot-avatar";
import { PresenceItem, PresenceList } from "@/components/ui/presence";
import {
  assignDistinctBusyExpressions,
  BUSY_EXPRESSION_LABELS,
  type BusyExpression,
} from "@/lib/agents/avatar-expressions";
import { useActiveBotIds } from "@/lib/agents/bot-activity";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { latestChannelFor } from "@/lib/channels/latest";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { cn } from "@/lib/utils";

/** 顶栏同屏最多直接展开的忙碌 Bot 数量，超出折叠为 `+N` 提示胶囊。 */
export const WORKING_CREW_VISIBLE_LIMIT = 6;

export type WorkingCrewEntry = {
  botId: string;
  name: string;
  seed: string;
  channelId: string | null;
  expression: BusyExpression;
  expressionLabel: string;
};

/**
 * 顶栏忙碌 Bot 状态指示条（Wave 6）：
 * - 当有 Bot 正在思考或执行工具时，在顶栏居中紧凑展示各自互异的微表情神态（6 种去重分配）；
 * - 点击任意胶囊即可直达对应 Bot 的当前对话；
 * - 无忙碌 Bot 时返回 `null`，待机零 DOM、零帧耗。
 */
export const WorkingCrewStrip = memo(function WorkingCrewStrip({
  className,
}: {
  className?: string;
}) {
  const navigate = useNavigate();
  const activeBotIds = useActiveBotIds();
  const agentsQuery = useQuery({
    ...agentListQueryOptions(),
    staleTime: 60_000,
  });
  const channelsQuery = useInfiniteQuery(channelListQueryOptions());

  const entries = useMemo<WorkingCrewEntry[]>(() => {
    const channels = channelsQuery.data ?? [];
    const agents = agentsQuery.data ?? [];
    const agentMap = new Map(agents.map((item) => [item.id, item]));
    const channelByBot = new Map<string, string>();
    const workingIds: string[] = [];
    const seen = new Set<string>();

    const addWorking = (botId: string, channelId: string | null) => {
      if (!botId) return;
      if (channelId && !channelByBot.has(botId)) {
        channelByBot.set(botId, channelId);
      }
      if (!seen.has(botId)) {
        seen.add(botId);
        workingIds.push(botId);
      }
    };

    for (const botId of activeBotIds) {
      const latest = latestChannelFor(botId, channels);
      addWorking(botId, latest?.id ?? null);
    }

    for (const channel of channels) {
      if (!channel.busy) continue;
      if (channel.agentIds.length === 1 && channel.agentIds[0]) {
        addWorking(channel.agentIds[0], channel.id);
      }
    }

    if (workingIds.length === 0) return [];
    const expressions = assignDistinctBusyExpressions(workingIds);

    return workingIds.map((botId) => {
      const profile = agentMap.get(botId);
      const expression = expressions.get(botId) ?? "focused";
      return {
        botId,
        name: profile?.name ?? botId,
        seed: profile?.avatarSeed ?? botId,
        channelId: channelByBot.get(botId) ?? null,
        expression,
        expressionLabel: BUSY_EXPRESSION_LABELS[expression],
      };
    });
  }, [activeBotIds, agentsQuery.data, channelsQuery.data]);

  if (entries.length === 0) return null;

  const shown = entries.slice(0, WORKING_CREW_VISIBLE_LIMIT);
  const overflow = entries.slice(WORKING_CREW_VISIBLE_LIMIT);

  return (
    <nav
      aria-label="正在工作的机器人"
      className={cn("working-crew-strip ch-content-enter relative", className)}
      data-surface="control"
      data-testid="working-crew-strip"
    >
      <PresenceList>
        {shown.map((entry, index) => (
          <PresenceItem key={entry.botId} layoutKey={index}>
            <button
              aria-label={`${entry.name}（${entry.expressionLabel}），点击直达对话`}
              className="working-crew-chip ch-press"
              data-bot-id={entry.botId}
              data-expression={entry.expression}
              data-testid={`working-crew-chip-${entry.botId}`}
              onClick={() => {
                if (entry.channelId) {
                  void navigate({
                    to: "/channel/$channelId",
                    params: { channelId: entry.channelId },
                  });
                } else {
                  void navigate({
                    to: "/channel/new",
                    search: { agent: entry.botId },
                  });
                }
              }}
              title={`${entry.name} · ${entry.expressionLabel}`}
              type="button"
            >
              <BotAvatar
                agentId={entry.botId}
                decorative
                expression={entry.expression}
                name={entry.name}
                seed={entry.seed}
                size={20}
                working
              />
              <span className="working-crew-name">{entry.name}</span>
              <span className="working-crew-mood">{entry.expressionLabel}</span>
            </button>
          </PresenceItem>
        ))}
      </PresenceList>
      {overflow.length > 0 ? (
        <span
          className="working-crew-more ch-content-enter"
          data-testid="working-crew-more"
          title={overflow
            .map((item) => `${item.name} · ${item.expressionLabel}`)
            .join("\n")}
        >
          {`+${overflow.length}`}
          <span className="sr-only">
            {`（还有 ${overflow.length} 个机器人正在工作：${overflow.map((item) => item.name).join("、")}）`}
          </span>
        </span>
      ) : null}
    </nav>
  );
});
