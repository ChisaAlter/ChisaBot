import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { channelFromRoster, channelQueryOptions } from "@/lib/channels/queries";
import { threadUi } from "@/lib/chat/ui-memory";
import { useMainBot } from "@/lib/settings/message-list";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";

const PANEL_BOT_KEY = "chisabot-panel-bot";

/**
 * Which Bot's panels the right column shows.
 *
 * This is also the Bot the left roster shows as selected, so the two columns never disagree.
 * The open conversation decides when there is one (its single coworker, or `?agent=` on a new
 * chat). Elsewhere it is the Bot last opened, then the main Bot, then the first Bot on the roster.
 */
export function usePanelBot(): {
  botId: string | undefined;
  routeBotId: string | undefined;
  choose: (botId: string) => void;
} {
  const queryClient = useQueryClient();
  const channelId = useParams({
    strict: false,
    select: (params) => (params as { channelId?: string }).channelId,
  });
  const searchAgent = useRouterState({
    select: (state) =>
      (state.location.search as { agent?: unknown }).agent as
        | string
        | undefined,
  });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isChannel = pathname.startsWith("/channel/") && pathname !== "/channel/new";
  const channel = useQuery({
    ...channelQueryOptions(channelId ?? ""),
    enabled: Boolean(channelId) && isChannel,
    placeholderData: () =>
      channelId ? channelFromRoster(queryClient, channelId) : undefined,
  });
  const agents = useQuery(agentListQueryOptions());
  const [stored, setStored] = useState<string | undefined>(
    () => readStoredPreference(PANEL_BOT_KEY) ?? undefined,
  );

  const routeBotId =
    (isChannel
      ? channel.data?.agentIds.length === 1
        ? channel.data.agentIds[0]
        : channelId
          ? threadUi(channelId)?.agent
          : undefined
      : undefined) ??
    (typeof searchAgent === "string" && searchAgent ? searchAgent : undefined);

  const { mainBotId } = useMainBot();
  const known = agents.data?.map((a) => a.id) ?? [];
  const isKnown = (id: string | null | undefined): id is string =>
    Boolean(id) && (known.length === 0 || known.includes(id as string));
  const fallback = isKnown(stored)
    ? stored
    : isKnown(mainBotId)
      ? mainBotId
      : agents.data?.[0]?.id;

  // A remembered Bot that has since been deleted is forgotten once the roster says so, so the
  // panel rail never asks for panels of a Bot that no longer exists.
  const rosterIds = agents.isSuccess ? known.join("\n") : null;
  useEffect(() => {
    // The open conversation's Bot is never "unknown" here, even when it is hidden from the roster.
    if (rosterIds === null || !stored || stored === routeBotId) return;
    if (!rosterIds.split("\n").includes(stored)) {
      forgetStoredPanelBot(stored);
      setStored(undefined);
    }
  }, [rosterIds, stored, routeBotId]);

  useEffect(() => {
    if (routeBotId && routeBotId !== stored) {
      writeStoredPreference(PANEL_BOT_KEY, routeBotId);
      setStored(routeBotId);
    }
  }, [routeBotId, stored]);

  return {
    botId: routeBotId ?? fallback,
    routeBotId,
    choose: (botId: string) => {
      writeStoredPreference(PANEL_BOT_KEY, botId);
      setStored(botId);
    },
  };
}

/** Forget the remembered panel Bot if it is this one (after it was deleted). */
export function forgetStoredPanelBot(botId: string): void {
  try {
    if (window.localStorage.getItem(PANEL_BOT_KEY) === botId)
      window.localStorage.removeItem(PANEL_BOT_KEY);
  } catch {
    // Storage unavailable: nothing was remembered there either.
  }
}

/** The Bot last opened (the same memory the panel rail and the roster selection use). */
export function readStoredPanelBot(): string | null {
  return readStoredPreference(PANEL_BOT_KEY);
}
