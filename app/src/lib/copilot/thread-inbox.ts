import { useSyncExternalStore } from "react";
import { tryClient, type ClientOptions } from "../client";

/**
 * 机器人回答期间又发来的消息（DESIGN.md §38.1；服务器那边是 server/src/thread-inbox.ts）。
 *
 * 发送时如果机器人正在回答，消息不进 CopilotKit 的消息列表，而是 POST 到这个对话的收件箱，界面在消息
 * 列表末尾画一个淡一点的「已排队」气泡。正在跑的那一轮在下一步把它读进去，服务器推一张消息快照，
 * 这条消息出现在对话记录里它被读到的位置——排队气泡消失，那条消息下面淡出一个「已读取」。
 * 运行结束时还在排队的（入队和结束撞上了），由客户端按普通消息发出去，不会丢。
 */
export type QueuedStatus = "sending" | "queued" | "paused" | "failed";
export type QueuedMessage = {
  id: string;
  text: string;
  status: QueuedStatus;
  at: number;
  /**
   * 别的设备排的（全端同步，DESIGN.md §42）：这里只显示，回答结束时不由这台设备补发——补发只归排它的那台，
   * 否则两台设备会把同一条各发一遍。
   */
  remote?: boolean;
  kind?: "message" | "worker_result";
};

/** 这台设备（这个浏览器）自己排过的消息 id，用来区分「我排的」和「别的设备排的」。 */
const OWN_KEY = "chisabot-inbox-own";
function ownIds(): string[] {
  try {
    const raw = window.localStorage.getItem(OWN_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
function rememberOwn(id: string) {
  try {
    window.localStorage.setItem(OWN_KEY, JSON.stringify([...ownIds().filter((other) => other !== id), id].slice(-200)));
  } catch {
    // 存不了：最坏是刷新后这条被当作别的设备排的，不补发（服务器那一轮仍会读到它）。
  }
}

const queues = new Map<string, QueuedMessage[]>();
/** 刚被读进去的消息 id → 读到的时间（「已读取」标记几秒后淡出）。 */
const readAt = new Map<string, number>();
const listeners = new Set<() => void>();
const EMPTY: QueuedMessage[] = [];
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(threadId: string, next: QueuedMessage[]) {
  if (next.length) queues.set(threadId, next);
  else queues.delete(threadId);
  emit();
}

export function queuedFor(threadId: string | null | undefined): QueuedMessage[] {
  return (threadId && queues.get(threadId)) || EMPTY;
}

export function useQueuedMessages(threadId: string | null | undefined): QueuedMessage[] {
  return useSyncExternalStore(subscribe, () => queuedFor(threadId), () => EMPTY);
}

/** 「已读取」标记要不要画（读到后 6 秒内）。 */
export function useReadMark(messageId: string): boolean {
  useSyncExternalStore(subscribe, () => version, () => 0);
  const at = readAt.get(messageId);
  return at !== undefined && Date.now() - at < 6_000;
}

const api = (threadId: string) => `/api/copilotkit/threads/${encodeURIComponent(threadId)}/inbox`;

/**
 * 机器人正在回答时发一条：进收件箱。返回 "queued" = 已排队；"send" = 那一轮刚好已经结束，调用方照常发送。
 * 失败（网络、排队满）时气泡标成失败，可以重试或撤回。
 */
export async function queueMessage(threadId: string, text: string, id: string = crypto.randomUUID(), options: Pick<ClientOptions, "signal" | "timeoutMs"> = {}): Promise<"queued" | "send" | "failed"> {
  const item: QueuedMessage = { id, text, status: "sending", at: Date.now() };
  rememberOwn(id);
  set(threadId, [...queuedFor(threadId).filter((other) => other.id !== id), item]);
  const update = (status: QueuedStatus) =>
    set(threadId, queuedFor(threadId).map((other) => (other.id === id ? { ...other, status } : other)));
  try {
    const response = await tryClient(api(threadId), { ...options, method: "POST", body: { id, text } });
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { queued?: boolean; status?: string } | null;
    if (!body || typeof body.queued !== "boolean") throw new Error("Invalid inbox response");
    // A confirmed withdrawal can finish before the original POST response arrives.
    if (!queuedFor(threadId).some((other) => other.id === id)) return "queued";
    if (!body.queued) {
      set(threadId, queuedFor(threadId).filter((other) => other.id !== id));
      return "send";
    }
    if (["read", "answered", "withdrawn", "merged"].includes(body.status ?? "")) markRead(threadId, id);
    else update(["paused", "owed", "stopped"].includes(body.status ?? "") ? "paused" : "queued");
    return "queued";
  } catch {
    update("failed");
    return "failed";
  }
}

/** 撤回一条还没被读到的。服务器那边已经读了就撤不回（返回 false，气泡等快照来了自己消失）。 */
export async function withdrawMessage(threadId: string, id: string, options: Pick<ClientOptions, "signal" | "timeoutMs"> = {}): Promise<boolean> {
  const item = queuedFor(threadId).find((other) => other.id === id);
  if (!item) return false;
  try {
    const response = await tryClient(`${api(threadId)}?id=${encodeURIComponent(id)}`, { ...options, method: "DELETE" });
    const body = response.ok ? await response.json() as { withdrawn?: unknown } | null : null;
    const withdrawn = body?.withdrawn === true;
    if (withdrawn) set(threadId, queuedFor(threadId).filter((other) => other.id !== id));
    return withdrawn;
  } catch {
    return false;
  }
}

/** 这条已经出现在对话记录里了：从排队里拿掉，挂几秒「已读取」。 */
export function markRead(threadId: string, id: string) {
  readAt.set(id, Date.now());
  set(threadId, queuedFor(threadId).filter((other) => other.id !== id));
  setTimeout(emit, 6_100);
}

/** 运行结束、还在排队的：交给调用方当普通消息发出去，并从排队里拿掉。 */
export function takeQueued(threadId: string): QueuedMessage[] {
  const taken = queuedFor(threadId).filter((item) => item.status === "queued" && !item.remote);
  if (taken.length) set(threadId, queuedFor(threadId).filter((item) => item.status !== "queued" || item.remote));
  return taken;
}

export type InboxState = {
  running: boolean;
  paused?: boolean;
  items: { id: string; status: string; kind: string; message: { content?: unknown } }[];
};

/** 打开对话时、以及同步发现收件箱变了时：另一台设备 / 刷新前排的队还在服务器上，接回来（别的设备排的标 remote）。 */
export async function restoreQueue(threadId: string, options: Pick<ClientOptions, "signal" | "timeoutMs"> = {}): Promise<InboxState | null> {
  const state = await inboxState(threadId, options);
  if (state) applyInboxState(threadId, state);
  return state;
}

/** Reconcile local and remote ownership without promoting a durable pause back to queued. */
export function applyInboxState(threadId: string, state: InboxState) {
  const current = queuedFor(threadId);
  const own = new Set(ownIds());
  const active = new Map(state.items.filter((item) => ["queued", "paused", "owed", "stopped"].includes(item.status) && (item.kind === "message" || (item.kind === "worker_result" && (state.paused || item.status !== "queued")))).map((item) => [item.id, item]));
  const known = new Set(state.items.map((item) => item.id));
  const next: QueuedMessage[] = [];
  for (const old of current) {
    const item = active.get(old.id);
    if (item) {
      next.push({ ...old, status: item.status === "queued" && !state.paused ? "queued" : "paused" });
      active.delete(old.id);
    } else if (!known.has(old.id) && !old.remote) {
      next.push(state.paused && old.status === "queued" ? { ...old, status: "paused" } : old);
    }
  }
  for (const item of active.values()) {
    const content = typeof item.message.content === "string" ? item.message.content : "";
    const text = item.kind === "worker_result" ? content.replace(/^⟦chisabot:[^⟧]*⟧\s*/, "").split("\n")[0] || "后台任务结果" : content;
    if (text) next.push({ id: item.id, text, kind: item.kind === "worker_result" ? "worker_result" : "message", status: item.status === "queued" && !state.paused ? "queued" : "paused", at: Date.now(), ...(own.has(item.id) ? {} : { remote: true }) });
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) set(threadId, next);
}

export async function inboxState(threadId: string, options: Pick<ClientOptions, "signal" | "timeoutMs"> = {}): Promise<InboxState | null> {
  try {
    const response = await tryClient(api(threadId), options);
    if (!response.ok) return null;
    const state = await response.json() as InboxState;
    return state && typeof state.running === "boolean" && (state.paused === undefined || typeof state.paused === "boolean") && Array.isArray(state.items) &&
      state.items.every((item) => item && typeof item.id === "string" && typeof item.status === "string" && typeof item.kind === "string" && item.message && typeof item.message === "object") ? state : null;
  } catch {
    return null;
  }
}

/** UI sends a request to the mounted channel; it owns full-turn guards and model settings. */
export function sendPausedMessage(threadId: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let handled = false;
    window.dispatchEvent(new CustomEvent("chisabot-send-paused", { detail: { threadId, id, accept: (run: () => Promise<unknown>) => {
      if (handled) return;
      handled = true;
      void run().then(() => resolve(), reject);
    } } }));
    if (!handled) reject(new Error("请先打开这个对话，再发送保留的消息。"));
  });
}
