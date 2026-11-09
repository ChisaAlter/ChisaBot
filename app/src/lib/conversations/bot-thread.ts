import { tryClient } from "@/lib/client";

/**
 * 和服务器的「对话同步」接口说话的几个小函数（server/src/bot-threads.ts，DESIGN.md §42 / §64）。
 *
 * 机器人聊天只剩频道聊天一套（CB-046，§68）：对话 id 固定在频道上，不再有「每个机器人一条当前对话」的
 * 前端钩子（原来的 `useBotThread` 随 `/bot` 一起删了）。留下：变化戳（`readSync`，thread-activity.ts 每 2 秒问一次）、
 * 「历史对话」列表（`readThreadHistory`），以及当前对话指针的读写（服务器接口保留，旧客户端和测试还在用）。
 */
/**
 * 全端同步（DESIGN.md §42）：当前对话存在服务器上（server/src/bot-threads.ts），每个人每个机器人一条。
 * 下面这些是和它说话的几个小函数；服务器没有这个接口（旧版本 / 不是本地会话模式）时一律返回 "unsupported"，
 * 调用方按「不支持」处理。
 */
export type ServerThread = { threadId: string | null; updatedAt: string | null };
export type ThreadActivity = {
  threadId: string;
  seq: string;
  running: boolean;
  workers: string | null;
  inbox: string | null;
  /** 对话版本（截断过几次，DESIGN.md §67）；旧服务器没有这个字段。 */
  revision?: string;
};
type SyncReply = { current: ServerThread | null; thread: ThreadActivity | null };

const botThreadsApi = (agentId: string) => `/api/bot-threads/${encodeURIComponent(agentId)}`;

async function readJson<T>(response: Response): Promise<T | "unsupported"> {
  // 旧服务器没有这个路由：404，或者被前端兜底页接住（200 text/html）。都当作「不支持」。
  if (response.status === 404 || response.status === 405) return "unsupported";
  if (!(response.headers.get("content-type") ?? "").includes("json")) return "unsupported";
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as T;
}

export async function readServerThread(agentId: string): Promise<ServerThread | "unsupported" | "error"> {
  try {
    const body = await readJson<ServerThread>(await tryClient(botThreadsApi(agentId)));
    if (body === "unsupported") return body;
    return { threadId: typeof body.threadId === "string" ? body.threadId : null, updatedAt: body.updatedAt ?? null };
  } catch {
    return "error";
  }
}

/** 设成服务器上的当前对话。返回服务器最后认的那条（onlyIfNone 时可能是别的设备先写的）；失败返回 null。 */
export async function writeServerThread(agentId: string, threadId: string, onlyIfNone = false): Promise<string | null> {
  try {
    const body = await readJson<ServerThread>(
      await tryClient(botThreadsApi(agentId), { method: "PUT", body: { threadId, onlyIfNone } }),
    );
    if (body === "unsupported") return null;
    return typeof body.threadId === "string" ? body.threadId : threadId;
  } catch {
    return null;
  }
}

/** 问一次对话的变化戳；「服务器没有这个接口」单独返回 "unsupported"（频道聊天用，见 thread-activity.ts）。 */
export async function readSync(agentId: string, threadId: string): Promise<SyncReply | "unsupported" | null> {
  try {
    return await readJson<SyncReply>(
      await tryClient(`${botThreadsApi(agentId)}/sync?threadId=${encodeURIComponent(threadId)}`),
    );
  } catch {
    return null;
  }
}

/** 页面在前台时多久问一次服务器（隐藏时不问；回到前台、窗口获得焦点、网络恢复时马上问）。 */
export const SYNC_INTERVAL_MS = 2_000;

export type BotThreadSummary = { threadId: string; title: string; messages: number; updatedAt: string | null };

/** 这个机器人的对话列表（「历史对话」）。旧服务器没有这个接口 → "unsupported"。 */
export async function readThreadHistory(agentId: string): Promise<BotThreadSummary[] | "unsupported"> {
  const body = await readJson<{ threads?: BotThreadSummary[] }>(await tryClient(`${botThreadsApi(agentId)}/history`));
  if (body === "unsupported") return body;
  return Array.isArray(body.threads) ? body.threads : [];
}
