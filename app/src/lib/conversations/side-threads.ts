import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";

export type SideThreadMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};

export type SideThreadSummary = {
  id: string;
  parentThreadId: string;
  anchorMessageId: string | null;
  agentId: string;
  title: string;
  messageCount: number;
  contextDigest: string;
  createdAt: string;
  updatedAt: string;
};

export type SideThreadRecord = SideThreadSummary & {
  messages: SideThreadMessage[];
};

export type CreateSideThreadInput = {
  parentThreadId: string;
  anchorMessageId?: string | null;
  question?: string;
};

export type AskSideThreadVariables = {
  sideThreadId: string;
  parentThreadId?: string;
  text: string;
};

export type AskSideThreadResponse = {
  thread: SideThreadRecord;
  reply: SideThreadMessage | null;
};

export type DeleteSideThreadVariables = {
  sideThreadId: string;
  parentThreadId?: string;
};

export type LiveSteerResult =
  | {
      kind: "queued";
      status: string;
      id: string;
      steerAction?: "cut" | "next-step" | "segment-cut" | "queued";
    }
  | { kind: "idle"; id: string }
  | { kind: "stopping"; id: string };

const SIDE_FALLBACK = "侧边问答请求失败，请稍后重试。";
const STEER_FALLBACK = "发送补充指令失败，请稍后重试。";
const SIDE_MODEL_TURN_TIMEOUT_MS = 120_000;

export const sideThreadKeys = {
  all: ["side-threads"] as const,
  list: (parentThreadId: string) =>
    ["side-threads", "list", parentThreadId] as const,
  detail: (sideThreadId: string) =>
    ["side-threads", "detail", sideThreadId] as const,
};

export async function listSideThreads(
  parentThreadId: string,
  signal?: AbortSignal,
): Promise<SideThreadSummary[]> {
  return client<SideThreadSummary[]>(
    `/api/side-threads?parentThreadId=${encodeURIComponent(parentThreadId)}`,
    "threads",
    { signal, fallback: SIDE_FALLBACK },
  );
}

export async function getSideThread(
  sideThreadId: string,
  signal?: AbortSignal,
): Promise<SideThreadRecord> {
  return client<SideThreadRecord>(
    `/api/side-threads/${encodeURIComponent(sideThreadId)}`,
    "thread",
    { signal, fallback: SIDE_FALLBACK },
  );
}

export async function createSideThread(
  input: CreateSideThreadInput,
): Promise<SideThreadRecord> {
  const hasQuestion =
    typeof input.question === "string" && input.question.trim().length > 0;
  return client<SideThreadRecord>("/api/side-threads", "thread", {
    method: "POST",
    body: input,
    ...(hasQuestion ? { timeoutMs: SIDE_MODEL_TURN_TIMEOUT_MS } : {}),
    fallback: SIDE_FALLBACK,
  });
}

export async function askSideThread(
  variables: AskSideThreadVariables,
): Promise<AskSideThreadResponse> {
  const response = await client(
    `/api/side-threads/${encodeURIComponent(variables.sideThreadId)}/messages`,
    {
      method: "POST",
      body: { text: variables.text },
      timeoutMs: SIDE_MODEL_TURN_TIMEOUT_MS,
      fallback: SIDE_FALLBACK,
    },
  );
  const body = (await response.json().catch(() => null)) as {
    thread?: SideThreadRecord;
    reply?: SideThreadMessage | null;
  } | null;
  if (!body?.thread) {
    throw new Error(SIDE_FALLBACK);
  }
  return {
    thread: body.thread,
    reply: body.reply ?? null,
  };
}

export async function deleteSideThread(
  sideThreadId: string,
): Promise<{ ok: true }> {
  await client(`/api/side-threads/${encodeURIComponent(sideThreadId)}`, {
    method: "DELETE",
    fallback: SIDE_FALLBACK,
  });
  return { ok: true };
}

export function buildLiveSteerPayload(
  text: string,
  id: string = crypto.randomUUID(),
): { id: string; text: string } {
  const cleanId = id.trim();
  const cleanText = text.trim();
  if (!cleanId) throw new Error("补充指令 id 无效。");
  if (!cleanText) throw new Error("补充指令不能为空。");
  return { id: cleanId, text: cleanText };
}

export async function sendLiveSteer(
  threadId: string,
  text: string,
  id: string = crypto.randomUUID(),
): Promise<LiveSteerResult> {
  const payload = buildLiveSteerPayload(text, id);
  const response = await client(
    `/api/conversations/threads/${encodeURIComponent(threadId)}/inbox`,
    {
      method: "POST",
      body: { ...payload, mode: "steer" },
      fallback: STEER_FALLBACK,
    },
  );
  const body = (await response.json().catch(() => null)) as {
    queued?: unknown;
    status?: unknown;
    stopping?: unknown;
    steerAction?: unknown;
  } | null;
  if (body?.queued === true) {
    const steerAction =
      body.steerAction === "cut" ||
      body.steerAction === "next-step" ||
      body.steerAction === "segment-cut" ||
      body.steerAction === "queued"
        ? body.steerAction
        : undefined;
    return {
      kind: "queued",
      status: typeof body.status === "string" ? body.status : "queued",
      id: payload.id,
      ...(steerAction ? { steerAction } : {}),
    };
  }
  if (body?.stopping === true) {
    return { kind: "stopping", id: payload.id };
  }
  return { kind: "idle", id: payload.id };
}

export function sideThreadListQueryOptions(
  parentThreadId: string | null | undefined,
) {
  return queryOptions({
    queryKey: sideThreadKeys.list(parentThreadId ?? ""),
    enabled: Boolean(parentThreadId),
    queryFn: ({ signal }): Promise<SideThreadSummary[]> => {
      if (!parentThreadId) return Promise.resolve([]);
      return listSideThreads(parentThreadId, signal);
    },
  });
}

export function sideThreadDetailQueryOptions(
  sideThreadId: string | null | undefined,
) {
  return queryOptions({
    queryKey: sideThreadKeys.detail(sideThreadId ?? ""),
    enabled: Boolean(sideThreadId),
    queryFn: ({ signal }): Promise<SideThreadRecord> => {
      if (!sideThreadId) {
        return Promise.reject(new Error("缺少侧边问答 id"));
      }
      return getSideThread(sideThreadId, signal);
    },
  });
}

export function createSideThreadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: CreateSideThreadInput): Promise<SideThreadRecord> =>
      createSideThread(input),
    onSuccess: (thread, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sideThreadKeys.list(variables.parentThreadId),
      });
      void queryClient.invalidateQueries({
        queryKey: sideThreadKeys.detail(thread.id),
      });
    },
  });
}

export function askSideThreadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (
      variables: AskSideThreadVariables,
    ): Promise<AskSideThreadResponse> => askSideThread(variables),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sideThreadKeys.detail(variables.sideThreadId),
      });
      if (variables.parentThreadId) {
        void queryClient.invalidateQueries({
          queryKey: sideThreadKeys.list(variables.parentThreadId),
        });
      }
    },
  });
}

export function deleteSideThreadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: DeleteSideThreadVariables): Promise<{ ok: true }> =>
      deleteSideThread(variables.sideThreadId),
    onSuccess: (_data, variables) => {
      queryClient.removeQueries({
        queryKey: sideThreadKeys.detail(variables.sideThreadId),
      });
      if (variables.parentThreadId) {
        void queryClient.invalidateQueries({
          queryKey: sideThreadKeys.list(variables.parentThreadId),
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: sideThreadKeys.all });
      }
    },
  });
}

export function sendLiveSteerMutationOptions() {
  return mutationOptions({
    mutationFn: (variables: {
      threadId: string;
      text: string;
      id?: string;
    }): Promise<LiveSteerResult> =>
      sendLiveSteer(variables.threadId, variables.text, variables.id),
  });
}
