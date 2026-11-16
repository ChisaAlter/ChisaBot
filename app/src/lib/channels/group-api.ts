import {
  type QueryClient,
  mutationOptions,
  queryOptions,
} from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

export type GroupMessageStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed";

export type GroupBotMember = {
  id: string;
  name: string;
};

export type GroupPersonMember = {
  userId: string;
  email: string;
  name: string | null;
  creator: boolean;
};

export type GroupConsentNotice = {
  botId: string;
  serverId: string;
};

export type GroupTranscriptMessage = {
  id: string;
  channelId: string;
  ownerUserId: string;
  agentId: string | null;
  threadId: string | null;
  text: string;
  status: GroupMessageStatus;
  createdAt: string;
  answeredBy?: string;
  consent?: GroupConsentNotice;
  reason?: string;
};

export type GroupConversationDetail = {
  bots: GroupBotMember[];
  people: GroupPersonMember[];
  messages: GroupTranscriptMessage[];
};

export type GroupMembersSummary = {
  bots: GroupBotMember[];
  people: GroupPersonMember[];
};

export type SendGroupMessageInput = {
  channelId: string;
  id: string;
  text: string;
  agentId?: string | null;
  goalMode?: boolean;
};

export type SendGroupMessageResult = {
  id: string;
  queued: boolean;
};

export type GroupAccessProbe =
  | { available: true; detail: GroupConversationDetail }
  | { available: false; status: number };

const FALLBACK = "群聊操作失败";

export const groupKeys = {
  all: ["groups"] as const,
  detail: (channelId: string) => ["groups", "detail", channelId] as const,
  members: (channelId: string) => ["groups", "members", channelId] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGroupMessageStatus(value: unknown): value is GroupMessageStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed"
  );
}

function parseBotMember(raw: unknown): GroupBotMember | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  return { id: raw.id, name: raw.name };
}

function parsePersonMember(raw: unknown): GroupPersonMember | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.userId !== "string" || typeof raw.email !== "string") {
    return null;
  }
  const name = typeof raw.name === "string" ? raw.name : null;
  return {
    userId: raw.userId,
    email: raw.email,
    name,
    creator: raw.creator === true,
  };
}

function parseMessage(raw: unknown): GroupTranscriptMessage | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    typeof raw.channelId !== "string" ||
    typeof raw.ownerUserId !== "string" ||
    typeof raw.text !== "string" ||
    !isGroupMessageStatus(raw.status)
  ) {
    return null;
  }
  const consent =
    isRecord(raw.consent) &&
    typeof raw.consent.botId === "string" &&
    typeof raw.consent.serverId === "string"
      ? { botId: raw.consent.botId, serverId: raw.consent.serverId }
      : undefined;
  return {
    id: raw.id,
    channelId: raw.channelId,
    ownerUserId: raw.ownerUserId,
    agentId: typeof raw.agentId === "string" ? raw.agentId : null,
    threadId: typeof raw.threadId === "string" ? raw.threadId : null,
    text: raw.text,
    status: raw.status,
    createdAt:
      typeof raw.createdAt === "string"
        ? raw.createdAt
        : new Date().toISOString(),
    ...(typeof raw.answeredBy === "string"
      ? { answeredBy: raw.answeredBy }
      : {}),
    ...(consent ? { consent } : {}),
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
  };
}

function parseGroupDetail(raw: unknown): GroupConversationDetail | null {
  if (!isRecord(raw)) return null;
  if (
    !Array.isArray(raw.bots) ||
    !Array.isArray(raw.people) ||
    !Array.isArray(raw.messages)
  ) {
    return null;
  }
  const bots = raw.bots
    .map(parseBotMember)
    .filter((entry): entry is GroupBotMember => entry !== null);
  const people = raw.people
    .map(parsePersonMember)
    .filter((entry): entry is GroupPersonMember => entry !== null);
  const messages = raw.messages
    .map(parseMessage)
    .filter((entry): entry is GroupTranscriptMessage => entry !== null);
  return { bots, people, messages };
}

/**
 * Format outgoing group message text, automatically prefixing `/goal ` when goal-convergence mode
 * is active unless the author already started with `/goal`.
 */
export function formatGroupMessagePayload(input: {
  text: string;
  goalMode?: boolean;
}): string {
  const trimmed = input.text.trim();
  if (!trimmed) return "";
  if (!input.goalMode) return trimmed;
  if (/^\/goal(?:\s*[:：]|\s)/i.test(trimmed)) return trimmed;
  return `/goal ${trimmed}`;
}

/** Insert a `@BotName ` mention token into a composer draft cleanly. */
export function insertBotMention(draft: string, botName: string): string {
  const trimmedName = botName.trim();
  if (!trimmedName) return draft;
  const token = `@${trimmedName}`;
  if (!draft.trim()) return `${token} `;
  const prefix = /\s$/.test(draft) ? draft : `${draft} `;
  return `${prefix}${token} `;
}

export async function fetchGroupDetail(
  channelId: string,
  signal?: AbortSignal,
): Promise<GroupConversationDetail> {
  const response = await client(
    `/api/groups/${encodeURIComponent(channelId)}`,
    {
      signal,
      fallback: "无法加载群聊内容",
    },
  );
  const parsed = parseGroupDetail(await response.json().catch(() => null));
  if (!parsed) {
    throw new Error("无法加载群聊内容");
  }
  return parsed;
}

/**
 * Non-throwing probe for whether the current member can view this group via `/api/groups/:id`.
 * Uses `tryClient` so 403/404 refusals return as typed status answers rather than exceptions.
 */
export async function checkGroupAccess(
  channelId: string,
  signal?: AbortSignal,
): Promise<GroupAccessProbe> {
  const response = await tryClient(
    `/api/groups/${encodeURIComponent(channelId)}`,
    { signal },
  );
  if (!response.ok) {
    return { available: false, status: response.status };
  }
  const parsed = parseGroupDetail(await response.json().catch(() => null));
  if (!parsed) {
    return { available: false, status: 500 };
  }
  return { available: true, detail: parsed };
}

export function groupDetailQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: groupKeys.detail(channelId),
    queryFn: ({ signal }): Promise<GroupConversationDetail> =>
      fetchGroupDetail(channelId, signal),
  });
}

export function groupMembersQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: groupKeys.members(channelId),
    queryFn: async ({ signal }): Promise<GroupMembersSummary> => {
      const detail = await fetchGroupDetail(channelId, signal);
      return { bots: detail.bots, people: detail.people };
    },
  });
}

export async function sendGroupMessage(
  input: SendGroupMessageInput,
): Promise<SendGroupMessageResult> {
  const formattedText = formatGroupMessagePayload({
    text: input.text,
    goalMode: input.goalMode,
  });
  const response = await client(
    `/api/groups/${encodeURIComponent(input.channelId)}`,
    {
      method: "POST",
      body: {
        id: input.id,
        text: formattedText,
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      },
      fallback: FALLBACK,
    },
  );
  const body = (await response.json().catch(() => null)) as unknown;
  if (isRecord(body) && typeof body.id === "string") {
    return { id: body.id, queued: body.queued === true };
  }
  return { id: input.id, queued: true };
}

function invalidateGroup(queryClient: QueryClient, channelId: string) {
  void queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) });
  void queryClient.invalidateQueries({
    queryKey: groupKeys.members(channelId),
  });
}

export function sendGroupMessageMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      input: SendGroupMessageInput,
    ): Promise<SendGroupMessageResult> => sendGroupMessage(input),
    onSuccess: (_data, variables) => {
      invalidateGroup(queryClient, variables.channelId);
    },
  });
}

export function addGroupMemberMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      email: string;
    }): Promise<{ userId: string }> => {
      const response = await client(
        `/api/groups/${encodeURIComponent(variables.channelId)}/members`,
        {
          method: "POST",
          body: { email: variables.email },
          fallback: FALLBACK,
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (isRecord(body) && typeof body.userId === "string") {
        return { userId: body.userId };
      }
      throw new Error(FALLBACK);
    },
    onSuccess: (_data, variables) => {
      invalidateGroup(queryClient, variables.channelId);
    },
  });
}

export function removeGroupMemberMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      userId: string;
    }): Promise<void> => {
      await client(
        `/api/groups/${encodeURIComponent(variables.channelId)}/members/${encodeURIComponent(variables.userId)}`,
        {
          method: "DELETE",
          fallback: FALLBACK,
        },
      );
    },
    onSuccess: (_data, variables) => {
      invalidateGroup(queryClient, variables.channelId);
    },
  });
}
