import {
  type AgentStateMutation,
  type AgentSubscriber,
  type BaseEvent,
  HttpAgent,
  type Message,
  type RunAgentInput,
  type RunAgentParameters,
} from "@ag-ui/client";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useSyncExternalStore,
} from "react";
import { Observable, type Subscription } from "rxjs";
import { useExternalConnection } from "@/hooks";
import { objectConnectionKey } from "@/lib/connection-key";
import { SendDeliveryUnknownError } from "../conversations/connection-drop";
import { draftFilesAccepted, draftFilesSubmitting } from "./ui-memory";

const ConversationTransport = createContext<"commands">("commands");
export type ConversationConnection = "online" | "reconnecting";

type LiveMessageEntry = {
  readonly text: string;
  readonly streaming: boolean;
};

type LiveThreadStore = {
  entries: Map<string, LiveMessageEntry>;
  listeners: Map<string, Set<() => void>>;
  dirty: Set<string>;
  rafId: number | null;
  microtaskScheduled: boolean;
};

const liveThreads = new Map<string, LiveThreadStore>();

function getLiveThread(threadId: string): LiveThreadStore {
  let store = liveThreads.get(threadId);
  if (!store) {
    store = {
      entries: new Map(),
      listeners: new Map(),
      dirty: new Set(),
      rafId: null,
      microtaskScheduled: false,
    };
    liveThreads.set(threadId, store);
  }
  return store;
}

function notifyLiveListeners(store: LiveThreadStore, ids: Iterable<string>) {
  for (const id of ids) {
    const set = store.listeners.get(id);
    if (!set) continue;
    for (const listener of [...set]) listener();
  }
}

function flushLiveThread(threadId: string) {
  const store = liveThreads.get(threadId);
  if (!store) return;
  store.rafId = null;
  store.microtaskScheduled = false;
  if (store.dirty.size === 0) return;
  const ids = [...store.dirty];
  store.dirty.clear();
  notifyLiveListeners(store, ids);
}

function scheduleLiveFlush(threadId: string, messageId: string) {
  const store = getLiveThread(threadId);
  store.dirty.add(messageId);
  if (store.rafId !== null || store.microtaskScheduled) return;
  if (typeof requestAnimationFrame === "function") {
    store.rafId = requestAnimationFrame(() => flushLiveThread(threadId));
    return;
  }
  store.microtaskScheduled = true;
  queueMicrotask(() => flushLiveThread(threadId));
}

export function setLiveMessageText(
  threadId: string,
  messageId: string,
  text: string,
) {
  const store = getLiveThread(threadId);
  const existing = store.entries.get(messageId);
  if (existing?.text === text && existing.streaming) return;
  store.entries.set(messageId, { text, streaming: true });
  scheduleLiveFlush(threadId, messageId);
}

/**
 * Transitions live streaming entry(ies) to settled (`streaming: false`) WITHOUT deleting their
 * text before `useConversationSession` commits the updated `agent.messages` prop to children.
 * Deleting immediately on `TEXT_MESSAGE_END` caused `LiveBotBubbles` to flash back to the stale
 * first-token `fallbackText` prop for one frame, collapsing message height by thousands of pixels.
 */
function finishLiveMessageText(
  threadId: string,
  messageId?: string,
  finalText?: string,
) {
  const store = liveThreads.get(threadId);
  if (!store) return;
  if (messageId !== undefined) {
    const existing = store.entries.get(messageId);
    const text = finalText ?? existing?.text;
    store.dirty.delete(messageId);
    if (
      text !== undefined &&
      (existing?.text !== text || existing.streaming !== false)
    ) {
      store.entries.set(messageId, { text, streaming: false });
      notifyLiveListeners(store, [messageId]);
    }
    return;
  }
  if (store.rafId !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(store.rafId);
  }
  store.rafId = null;
  store.microtaskScheduled = false;
  store.dirty.clear();
  const changed: string[] = [];
  for (const [id, entry] of store.entries) {
    if (!entry.streaming) continue;
    store.entries.set(id, { text: entry.text, streaming: false });
    changed.push(id);
  }
  if (changed.length > 0) notifyLiveListeners(store, changed);
}

function syncLiveMessagesFromSnapshot(
  threadId: string,
  messages: readonly Message[],
) {
  const store = liveThreads.get(threadId);
  if (!store) return;
  if (store.rafId !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(store.rafId);
  }
  store.rafId = null;
  store.microtaskScheduled = false;
  store.dirty.clear();
  const byId = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === "string") {
      byId.set(message.id, message.content);
    }
  }
  const changed: string[] = [];
  for (const [id, entry] of [...store.entries]) {
    const snapshotText = byId.get(id);
    if (snapshotText !== undefined) {
      if (entry.text !== snapshotText || entry.streaming) {
        store.entries.set(id, { text: snapshotText, streaming: false });
        changed.push(id);
      }
    } else {
      store.entries.delete(id);
      changed.push(id);
    }
  }
  if (changed.length > 0) notifyLiveListeners(store, changed);
  if (store.entries.size === 0 && store.listeners.size === 0) {
    liveThreads.delete(threadId);
  }
}

function pruneSettledLiveMessages(
  threadId: string,
  messages: readonly Message[],
) {
  const store = liveThreads.get(threadId);
  if (!store || store.entries.size === 0) return;
  const byId = new Map<string, Message>();
  for (const message of messages) byId.set(message.id, message);
  for (const [id, entry] of [...store.entries]) {
    if (entry.streaming) continue;
    const committed = byId.get(id);
    if (
      !committed ||
      typeof committed.content !== "string" ||
      committed.content === entry.text
    ) {
      store.entries.delete(id);
    }
  }
  if (store.entries.size === 0 && store.listeners.size === 0) {
    liveThreads.delete(threadId);
  }
}

export function clearLiveMessageText(threadId: string, messageId?: string) {
  const store = liveThreads.get(threadId);
  if (!store) return;
  if (messageId !== undefined) {
    const existed = store.entries.delete(messageId);
    store.dirty.delete(messageId);
    if (existed) notifyLiveListeners(store, [messageId]);
    if (store.entries.size === 0 && store.listeners.size === 0) {
      if (store.rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(store.rafId);
      }
      liveThreads.delete(threadId);
    }
    return;
  }
  const ids = [...new Set([...store.entries.keys(), ...store.dirty])];
  store.entries.clear();
  store.dirty.clear();
  if (store.rafId !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(store.rafId);
  }
  store.rafId = null;
  store.microtaskScheduled = false;
  if (ids.length > 0) notifyLiveListeners(store, ids);
  if (store.listeners.size === 0) liveThreads.delete(threadId);
}

function subscribeLiveMessage(
  threadId: string | undefined,
  messageId: string | undefined,
  listener: () => void,
): () => void {
  if (!threadId || !messageId) return () => {};
  const store = getLiveThread(threadId);
  let set = store.listeners.get(messageId);
  if (!set) {
    set = new Set();
    store.listeners.set(messageId, set);
  }
  set.add(listener);
  return () => {
    const current = liveThreads.get(threadId);
    const bucket = current?.listeners.get(messageId);
    bucket?.delete(listener);
    if (bucket && bucket.size === 0) current?.listeners.delete(messageId);
    if (current && current.entries.size === 0 && current.listeners.size === 0) {
      liveThreads.delete(threadId);
    }
  };
}

function getLiveMessageSnapshot(
  threadId: string | undefined,
  messageId: string | undefined,
): LiveMessageEntry | undefined {
  if (!threadId || !messageId) return undefined;
  return liveThreads.get(threadId)?.entries.get(messageId);
}

/** Subscribes only a single message leaf to rAF-coalesced token deltas. */
export function useLiveMessageText(
  threadId: string | undefined,
  messageId: string | undefined,
  fallbackText: string,
): { text: string; streaming: boolean } {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeLiveMessage(threadId, messageId, listener),
    [threadId, messageId],
  );
  const liveEntry = useSyncExternalStore(
    subscribe,
    () => getLiveMessageSnapshot(threadId, messageId),
    () => undefined,
  );
  return liveEntry !== undefined
    ? liveEntry
    : { text: fallbackText, streaming: false };
}

async function readAdmissionReceipt(response: Response, commandId: string) {
  const body: unknown = await response.json().catch(() => null);
  return body !== null &&
    typeof body === "object" &&
    "commandId" in body &&
    body.commandId === commandId &&
    "runId" in body &&
    typeof body.runId === "string" &&
    body.runId.length > 0
    ? { commandId, runId: body.runId }
    : undefined;
}

/** Transport bookkeeping is not model/tool progress. SSE keepalives are comments, not events. */
export function isConversationProgressEvent(event: {
  type: string;
  name?: string;
}): boolean {
  return (
    event.type !== "RAW" &&
    !(event.type === "CUSTOM" && event.name === "chisabot.connection")
  );
}

const AGUI_CLIENT_META_KEY = "@ag-ui/client";

function authoritativeActivityTypes(
  event: unknown,
): string[] | null | undefined {
  if (!event || typeof event !== "object" || !("metadata" in event))
    return undefined;
  const meta = (event as { metadata?: Record<string, unknown> }).metadata;
  if (
    !meta ||
    typeof meta !== "object" ||
    !Object.hasOwn(meta, AGUI_CLIENT_META_KEY)
  ) {
    return undefined;
  }
  const clientMeta = meta[AGUI_CLIENT_META_KEY];
  if (
    !clientMeta ||
    typeof clientMeta !== "object" ||
    Array.isArray(clientMeta)
  ) {
    return [];
  }
  if (!Object.hasOwn(clientMeta, "authoritativeActivityTypes")) {
    return undefined;
  }
  const types = (clientMeta as { authoritativeActivityTypes?: unknown })
    .authoritativeActivityTypes;
  if (types === null) return null;
  if (Array.isArray(types) && types.every((item) => typeof item === "string")) {
    return types;
  }
  return [];
}

/**
 * Replaces `@ag-ui/client`'s default `MESSAGES_SNAPSHOT` merge, which kept existing IDs in place
 * and `.push()`ed missing older IDs to the end (`[2069..2272, 0..2068]`).
 *
 * Keeps `incoming` in canonical chronological order; when `incoming` is a capped tail overlapping
 * `current` past index 0, preserves the disjoint older prefix `current.slice(0, earliestOverlap)`
 * in front, and preserves local-only `activity`/`reasoning` messages at their relative positions.
 */
export function applyMessagesSnapshot(
  current: readonly Message[],
  incoming: readonly Message[],
  event?: { metadata?: Record<string, unknown> },
): Message[] {
  const normalized = incoming.map((message) => {
    const raw = message as Message & { subagentRunId?: string | null };
    if (raw.subagentRunId !== null) return message;
    const copy = { ...raw };
    delete copy.subagentRunId;
    return copy as Message;
  });

  const authActivity = authoritativeActivityTypes(event);
  const incomingHasActivity = normalized.some((m) => m.role === "activity");
  const incomingHasReasoning = normalized.some((m) => m.role === "reasoning");
  const keepLocalSynthetic = (message: Message): boolean => {
    if (message.role === "activity") {
      const activityType = (message as { activityType?: string }).activityType;
      return authActivity
        ? !(activityType !== undefined && authActivity.includes(activityType))
        : authActivity !== null && !incomingHasActivity;
    }
    return message.role === "reasoning" && !incomingHasReasoning;
  };

  if (normalized.length === 0) {
    return current.filter(keepLocalSynthetic);
  }

  const incomingIds = new Set(normalized.map((m) => m.id));
  const currentIndex = new Map(current.map((m, i) => [m.id, i]));

  let earliestOverlap = Number.POSITIVE_INFINITY;
  for (const m of normalized) {
    const idx = currentIndex.get(m.id);
    if (idx !== undefined && idx < earliestOverlap) {
      earliestOverlap = idx;
      if (earliestOverlap === 0) break;
    }
  }

  const hasOlderPrefix =
    earliestOverlap > 0 && Number.isFinite(earliestOverlap);
  const olderPrefix = hasOlderPrefix ? current.slice(0, earliestOverlap) : [];
  const tailSlice = hasOlderPrefix ? current.slice(earliestOverlap) : current;

  const result: Message[] = [...olderPrefix, ...normalized];
  const syntheticToKeep: { afterId: string | null; message: Message }[] = [];
  let lastSurvivingId: string | null = olderPrefix.at(-1)?.id ?? null;
  for (const message of tailSlice) {
    if (incomingIds.has(message.id)) {
      lastSurvivingId = message.id;
    } else if (keepLocalSynthetic(message)) {
      syntheticToKeep.push({ afterId: lastSurvivingId, message });
      lastSurvivingId = message.id;
    }
  }
  for (const { afterId, message } of syntheticToKeep) {
    if (afterId === null) {
      result.unshift(message);
    } else {
      const idx = result.findIndex((m) => m.id === afterId);
      if (idx >= 0) result.splice(idx + 1, 0, message);
      else result.push(message);
    }
  }

  return result;
}

export const SYNTHETIC_CONNECT_RUN_PREFIX = "connect:";

export function isSyntheticConnectRunId(runId: string | undefined): boolean {
  return (
    typeof runId === "string" && runId.startsWith(SYNTHETIC_CONNECT_RUN_PREFIX)
  );
}

/** An observer has no model or tool loop. The server owns every execution. */
export class ConversationSession extends HttpAgent {
  private observedRunId?: string;
  private syntheticConnectActive = false;
  private readonly acceptedCommands = new Set<string>();
  private readonly activeLiveMessageIds = new Set<string>();
  private structureVersion = 0;
  private lastDeltaKind: "none" | "text" | "non-text" = "none";
  private connection: ConversationConnection = "online";
  private readonly connectionListeners = new Set<() => void>();
  readonly connectionSnapshot = () => this.connection;
  readonly subscribeConnection = (listener: () => void) => {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  };
  private setConnection(connection: ConversationConnection) {
    if (this.connection === connection) return;
    this.connection = connection;
    for (const listener of this.connectionListeners) listener();
  }
  hasActiveLiveMessage() {
    return this.activeLiveMessageIds.size > 0;
  }
  structuralVersion(): number {
    return this.structureVersion;
  }
  isNonTextDeltaPending(): boolean {
    return this.lastDeltaKind === "non-text";
  }
  override addMessage(message: Message): void {
    this.lastDeltaKind = "none";
    this.structureVersion++;
    super.addMessage(message);
  }
  override setMessages(messages: Message[]): void {
    this.lastDeltaKind = "none";
    this.structureVersion++;
    super.setMessages(messages);
  }
  structuralSignature(): string {
    return this.messages
      .map((message) => {
        const toolCount =
          message.role === "assistant" &&
          "toolCalls" in message &&
          Array.isArray(message.toolCalls)
            ? message.toolCalls.length
            : 0;
        const hasText =
          typeof message.content === "string"
            ? message.content.length > 0
            : Array.isArray(message.content) && message.content.length > 0;
        return `${message.id}:${message.role}:${toolCount}:${hasText ? 1 : 0}`;
      })
      .join("|");
  }
  constructor(
    readonly runtimeAgentId: string,
    threadId: string,
    agentId: string,
    readonly transport: "commands" = "commands",
  ) {
    super({
      agentId,
      threadId,
      url: `/api/conversations/agent/${encodeURIComponent(runtimeAgentId)}/run`,
      fetch: (url, init) => fetch(url, { ...init, credentials: "include" }),
    });
    this.subscribe({
      onEvent: ({ event }) => {
        if (
          event.type === "TEXT_MESSAGE_CONTENT" ||
          event.type === "TOOL_CALL_ARGS" ||
          event.type === "REASONING_MESSAGE_CONTENT"
        ) {
          return;
        }
        this.lastDeltaKind = "none";
        if (
          event.type === "ACTIVITY_SNAPSHOT" ||
          event.type === "ACTIVITY_DELTA"
        ) {
          this.structureVersion++;
        }
      },
      onRunStartedEvent: ({ event }) => {
        this.lastDeltaKind = "none";
        if (isSyntheticConnectRunId(event.runId)) {
          this.syntheticConnectActive = true;
        } else {
          this.syntheticConnectActive = false;
          this.observedRunId = event.runId;
        }
        this.setConnection("online");
      },
      onTextMessageStartEvent: ({ event }) => {
        this.lastDeltaKind = "none";
        this.structureVersion++;
        this.activeLiveMessageIds.add(event.messageId);
        setLiveMessageText(this.threadId, event.messageId, "");
      },
      onTextMessageContentEvent: ({ event, textMessageBuffer }) => {
        this.lastDeltaKind = "text";
        if (textMessageBuffer.length === 0 && (event.delta?.length ?? 0) > 0) {
          this.structureVersion++;
        }
        this.activeLiveMessageIds.add(event.messageId);
        setLiveMessageText(
          this.threadId,
          event.messageId,
          `${textMessageBuffer}${event.delta ?? ""}`,
        );
      },
      onTextMessageEndEvent: ({ event, textMessageBuffer }) => {
        this.lastDeltaKind = "none";
        this.structureVersion++;
        this.activeLiveMessageIds.delete(event.messageId);
        finishLiveMessageText(
          this.threadId,
          event.messageId,
          textMessageBuffer,
        );
      },
      onToolCallStartEvent: () => {
        this.lastDeltaKind = "none";
        this.structureVersion++;
      },
      onToolCallArgsEvent: () => {
        this.lastDeltaKind = "non-text";
      },
      onToolCallEndEvent: () => {
        this.lastDeltaKind = "none";
        this.structureVersion++;
      },
      onToolCallResultEvent: () => {
        this.lastDeltaKind = "none";
        this.structureVersion++;
      },
      onReasoningMessageStartEvent: () => {
        this.lastDeltaKind = "none";
        this.structureVersion++;
      },
      onReasoningMessageContentEvent: ({ event, reasoningMessageBuffer }) => {
        this.lastDeltaKind = "non-text";
        if (
          reasoningMessageBuffer.length === 0 &&
          (event.delta?.length ?? 0) > 0
        ) {
          this.structureVersion++;
        }
      },
      onReasoningMessageEndEvent: () => {
        this.lastDeltaKind = "none";
        this.structureVersion++;
      },
      onReasoningEndEvent: () => {
        this.lastDeltaKind = "none";
        this.structureVersion++;
      },
      onRunFinishedEvent: () => {
        this.lastDeltaKind = "none";
        this.activeLiveMessageIds.clear();
        finishLiveMessageText(this.threadId);
        this.setConnection("online");
      },
      onRunErrorEvent: () => {
        this.lastDeltaKind = "none";
        this.activeLiveMessageIds.clear();
        finishLiveMessageText(this.threadId);
        this.setConnection("online");
      },
      onRunFinalized: () => {
        this.lastDeltaKind = "none";
        this.activeLiveMessageIds.clear();
        finishLiveMessageText(this.threadId);
        if (
          this.syntheticConnectActive ||
          isSyntheticConnectRunId(this.observedRunId)
        ) {
          this.syntheticConnectActive = false;
          this.observedRunId = undefined;
        }
        this.setConnection("online");
      },
      onMessagesSnapshotEvent: ({ event }) => {
        this.lastDeltaKind = "none";
        this.structureVersion++;
        this.activeLiveMessageIds.clear();
        syncLiveMessagesFromSnapshot(this.threadId, event.messages);
        for (const message of event.messages)
          if (message.role === "user") this.acceptedCommands.add(message.id);
      },
      onCustomEvent: ({ event }) => {
        if (
          event.name === "chisabot.connection" &&
          (event.value?.status === "reconnecting" ||
            event.value?.status === "online")
        )
          this.setConnection(event.value.status);
        if (
          event.name === "chisabot.execution" &&
          typeof event.value?.runId === "string" &&
          !isSyntheticConnectRunId(event.value.runId)
        ) {
          this.syntheticConnectActive = false;
          this.observedRunId = event.value.runId;
        }
      },
    });
  }
  isCommandAccepted(commandId: string) {
    return this.acceptedCommands.has(commandId);
  }
  protected override apply(
    input: RunAgentInput,
    events$: Observable<BaseEvent>,
    subscribers: AgentSubscriber[],
  ): Observable<AgentStateMutation> {
    return super.apply(input, events$, [
      ...subscribers,
      {
        onMessagesSnapshotEvent: ({ event, messages }) => ({
          messages: applyMessagesSnapshot(
            messages,
            event.messages,
            event as unknown as { metadata?: Record<string, unknown> },
          ),
          stopPropagation: true,
        }),
      },
    ]);
  }
  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((observer) => {
      const abort = new AbortController();
      let subscription: Subscription | undefined;
      const endpoint = `/api/conversations/${encodeURIComponent(this.threadId)}`;
      const commandId = input.messages.findLast(
        (message) => message.role === "user",
      )?.id;
      void (async () => {
        if (!commandId) throw new Error("这条消息没有可接纳的内容。");
        const commandContent = input.messages.findLast(
          (message) => message.id === commandId,
        )?.content;
        await draftFilesSubmitting(commandContent, this.threadId, commandId);
        let response: Response | undefined;
        let receipt: { runId: string; commandId: string } | undefined;
        try {
          response = await fetch(`${endpoint}/commands`, {
            method: "POST",
            credentials: "include",
            signal: abort.signal,
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream, application/json",
            },
            body: JSON.stringify({
              agentId: this.runtimeAgentId,
              input: { ...input, tools: [] },
            }),
          });
        } catch {
          abort.signal.throwIfAborted();
        }
        const responseContentType = response?.headers.get("content-type") ?? "";
        if (response?.ok && responseContentType.includes("text/event-stream")) {
          const headerCommandId = response.headers.get("x-chisabot-command-id");
          const headerRunId = response.headers.get("x-chisabot-run-id");
          let admittedInStream =
            headerCommandId === commandId &&
            typeof headerRunId === "string" &&
            headerRunId.length > 0;
          if (admittedInStream && headerRunId) {
            this.acceptedCommands.add(commandId);
            draftFilesAccepted(commandContent);
            this.syntheticConnectActive = false;
            this.observedRunId = headerRunId;
          }
          const reader = response.body?.getReader();
          const onAbort = () => {
            void reader?.cancel().catch(() => {});
          };
          abort.signal.addEventListener("abort", onAbort, { once: true });
          const parseSseBlock = (block: string) => {
            const dataLines: string[] = [];
            for (const line of block.split(/\r?\n/)) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5);
              dataLines.push(raw.startsWith(" ") ? raw.slice(1) : raw);
            }
            if (dataLines.length === 0) return;
            const payload = dataLines.join("\n").trim();
            if (!payload || payload === "[DONE]") return;
            const event = JSON.parse(payload) as BaseEvent & {
              name?: string;
              value?: { commandId?: string; runId?: string };
            };
            if (
              event.type === "CUSTOM" &&
              event.name === "chisabot.admission" &&
              event.value?.commandId === commandId &&
              typeof event.value?.runId === "string" &&
              event.value.runId.length > 0
            ) {
              admittedInStream = true;
              this.acceptedCommands.add(commandId);
              draftFilesAccepted(commandContent);
              this.syntheticConnectActive = false;
              this.observedRunId = event.value.runId;
            }
            observer.next(event);
          };
          try {
            if (reader) {
              const decoder = new TextDecoder();
              let buffer = "";
              while (!abort.signal.aborted) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const normalized = buffer.replace(/\r\n/g, "\n");
                const parts = normalized.split("\n\n");
                buffer = parts.pop() ?? "";
                for (const part of parts) {
                  parseSseBlock(part);
                }
              }
              buffer += decoder.decode();
              if (buffer.trim().length > 0) {
                for (const part of buffer
                  .replace(/\r\n/g, "\n")
                  .split("\n\n")) {
                  if (part.trim().length > 0) parseSseBlock(part);
                }
              }
            }
            if (admittedInStream) {
              if (!abort.signal.aborted) observer.complete();
              return;
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort);
          }
          if (admittedInStream) {
            return;
          }
        }
        if (
          response?.ok &&
          !responseContentType.includes("text/event-stream")
        ) {
          receipt = await readAdmissionReceipt(response, commandId);
        } else if (response && !response.ok && response.status < 500) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error?.error ?? "消息未被接纳，请重试。");
        }
        if (!receipt) {
          // An interrupted response or 5xx can follow durable admission. Only read the same ID;
          // failing to read it is unknown delivery, not permission to submit the message again.
          abort.signal.throwIfAborted();
          let lookup: Response;
          try {
            lookup = await fetch(
              `${endpoint}/commands/${encodeURIComponent(commandId)}`,
              { credentials: "include", signal: abort.signal },
            );
          } catch (error) {
            abort.signal.throwIfAborted();
            throw new SendDeliveryUnknownError(undefined, { cause: error });
          }
          // A 404 can race the original POST still preparing its agent before commands.accept.
          if (!lookup.ok) throw new SendDeliveryUnknownError();
          receipt = await readAdmissionReceipt(lookup, commandId);
          if (!receipt) throw new SendDeliveryUnknownError();
        }
        const admitted = receipt;
        // Admission is durable even if the event subscription fails before its first frame.
        this.acceptedCommands.add(commandId);
        draftFilesAccepted(commandContent);
        this.syntheticConnectActive = false;
        this.observedRunId = admitted.runId;
        abort.signal.throwIfAborted();
        const events = new HttpAgent({
          url: `${endpoint}/events`,
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              credentials: "include",
              body: JSON.stringify({ commandId }),
            }),
        });
        subscription = events.run(input).subscribe({
          next: (event) => {
            observer.next(event);
            if (event.type === "RUN_STARTED")
              observer.next({
                type: "CUSTOM",
                name: "chisabot.admission",
                value: receipt,
              } as BaseEvent);
          },
          error: (error) => observer.error(error),
          complete: () => observer.complete(),
        });
      })().catch((error) => {
        if (!abort.signal.aborted) observer.error(error);
      });
      return () => {
        abort.abort();
        subscription?.unsubscribe();
      };
    });
  }
  private nextSnapshotAfter?: string[];
  /**
   * 下一次 connect 只要「这几条之后」的快照（sync 合并式接入用，见 snapshotAnchors）；用一次就清掉。
   * 服务器一条都对不上时照旧回封顶快照。
   */
  setConnectSnapshotAfter(ids: readonly string[] | undefined) {
    this.nextSnapshotAfter = ids?.length ? ids.slice(-16) : undefined;
  }
  protected override connect(input: RunAgentInput) {
    const snapshotAfter = this.nextSnapshotAfter;
    this.nextSnapshotAfter = undefined;
    const observer = new HttpAgent({
      url: `/api/conversations/agent/${encodeURIComponent(this.runtimeAgentId)}/connect`,
      // 服务器的 connect 只读 threadId：不再把这台手里的整段消息（长对话几百 KB）每次都上传一遍。
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          credentials: "include",
          body: JSON.stringify({
            threadId: input.threadId,
            runId: input.runId,
            ...(snapshotAfter ? { snapshotAfter } : {}),
          }),
        }),
    });
    return observer.run(input);
  }
  async stop() {
    const response = await fetch(
      `/api/conversations/agent/${encodeURIComponent(this.runtimeAgentId)}/stop/${encodeURIComponent(this.threadId)}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: this.observedRunId }),
      },
    );
    if (!response.ok) throw new Error("停止请求尚未确认，请重试。");
    return response.json() as Promise<{ stopped: boolean }>;
  }
}

type SessionEntry = { agent: ConversationSession; consumers: number };
const sessions = new Map<string, SessionEntry>();

function retainSession(key: string, entry: SessionEntry) {
  entry.consumers++;
  sessions.set(key, entry);
  return () => {
    entry.consumers--;
    // StrictMode and same-commit remounts release then reacquire the same session.
    // KeepAlive's actual eviction is the resource boundary, not merely hiding a tab.
    queueMicrotask(() => {
      if (entry.consumers !== 0 || sessions.get(key) !== entry) return;
      sessions.delete(key);
      clearLiveMessageText(entry.agent.threadId);
      // This only closes the browser's observer. A server-owned run keeps executing.
      void entry.agent.detachActiveRun();
    });
  };
}
export function ConversationSessionProvider({
  children,
  transport = "commands",
}: {
  children: ReactNode;
  transport?: "commands";
}) {
  return createElement(
    ConversationTransport.Provider,
    { value: transport },
    children,
  );
}
export function useConversationSession({
  agentId,
  runtimeAgentId,
  threadId,
}: {
  agentId: string;
  runtimeAgentId: string;
  threadId: string;
}) {
  const transport = useContext(ConversationTransport);
  const key = JSON.stringify([threadId, runtimeAgentId, transport]);
  const entry = useMemo(() => {
    let entry = sessions.get(key);
    if (!entry) {
      entry = {
        agent: new ConversationSession(
          runtimeAgentId,
          threadId,
          agentId,
          transport,
        ),
        consumers: 0,
      };
      sessions.set(key, entry);
    }
    return entry;
  }, [key, threadId, runtimeAgentId, agentId, transport]);
  const agent = entry.agent;
  useLayoutEffect(() => retainSession(key, entry), [key, entry]);
  const connectionStatus = useSyncExternalStore(
    agent.subscribeConnection,
    agent.connectionSnapshot,
    agent.connectionSnapshot,
  );
  const [revision, refresh] = useReducer((value) => value + 1, 0);
  useLayoutEffect(() => {
    if (revision >= 0) pruneSettledLiveMessages(threadId, agent.messages);
  }, [threadId, agent, revision]);
  useExternalConnection(objectConnectionKey(agent), () => {
    let lastVersion = agent.structuralVersion();
    let lastLength = agent.messages.length;
    let lastTailId = agent.messages.at(-1)?.id;
    let rafId: number | null = null;
    let microtaskScheduled = false;
    let pendingThrottled = false;

    const cancelPendingRefresh = () => {
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      rafId = null;
      microtaskScheduled = false;
      pendingThrottled = false;
    };

    const forceRefresh = () => {
      cancelPendingRefresh();
      lastVersion = agent.structuralVersion();
      lastLength = agent.messages.length;
      lastTailId = agent.messages.at(-1)?.id;
      refresh();
    };

    const flushPendingRefresh = () => {
      if (pendingThrottled) forceRefresh();
    };

    const scheduleThrottledRefresh = () => {
      pendingThrottled = true;
      if (rafId !== null || microtaskScheduled) return;
      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (!pendingThrottled) return;
          forceRefresh();
        });
        return;
      }
      microtaskScheduled = true;
      queueMicrotask(() => {
        microtaskScheduled = false;
        if (!pendingThrottled) return;
        forceRefresh();
      });
    };

    const subscription = agent.subscribe({
      onMessagesChanged: () => {
        const nextVersion = agent.structuralVersion();
        const nextLength = agent.messages.length;
        const nextTailId = agent.messages.at(-1)?.id;
        if (
          nextVersion !== lastVersion ||
          nextLength !== lastLength ||
          nextTailId !== lastTailId
        ) {
          forceRefresh();
          return;
        }
        if (agent.isNonTextDeltaPending()) {
          scheduleThrottledRefresh();
          return;
        }
        if (!agent.hasActiveLiveMessage()) {
          forceRefresh();
        }
      },
      onStateChanged: forceRefresh,
      onRunInitialized: forceRefresh,
      onRunFinalized: forceRefresh,
      onRunFinishedEvent: flushPendingRefresh,
      onRunErrorEvent: flushPendingRefresh,
      onRunFailed: flushPendingRefresh,
      onTextMessageEndEvent: forceRefresh,
      onToolCallEndEvent: flushPendingRefresh,
      onToolCallResultEvent: flushPendingRefresh,
      onReasoningMessageEndEvent: flushPendingRefresh,
      onReasoningEndEvent: flushPendingRefresh,
      onMessagesSnapshotEvent: forceRefresh,
    });
    return () => {
      cancelPendingRefresh();
      subscription.unsubscribe();
    };
  });
  return { agent, isReady: true, connectionStatus };
}

export const conversationClient = {
  getAgent(agentId: string) {
    return [...sessions.values()].find(
      (entry) => entry.agent.agentId === agentId,
    )?.agent;
  },
  runAgent({
    agent,
    ...parameters
  }: RunAgentParameters & { agent: ConversationSession }) {
    return agent.runAgent({ ...parameters, tools: [] });
  },
  connectAgent({ agent }: { agent: ConversationSession }) {
    return agent.connectAgent();
  },
  stopAgent({ agent }: { agent: ConversationSession }) {
    return agent.stop();
  },
};
