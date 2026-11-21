import {
  type BaseEvent,
  HttpAgent,
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

type LiveThreadStore = {
  texts: Map<string, string>;
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
      texts: new Map(),
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
  if (store.texts.get(messageId) === text) return;
  store.texts.set(messageId, text);
  scheduleLiveFlush(threadId, messageId);
}

export function clearLiveMessageText(threadId: string, messageId?: string) {
  const store = liveThreads.get(threadId);
  if (!store) return;
  if (messageId !== undefined) {
    const existed = store.texts.delete(messageId);
    store.dirty.delete(messageId);
    if (existed) notifyLiveListeners(store, [messageId]);
    if (store.texts.size === 0 && store.listeners.size === 0) {
      if (store.rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(store.rafId);
      }
      liveThreads.delete(threadId);
    }
    return;
  }
  const ids = [...new Set([...store.texts.keys(), ...store.dirty])];
  store.texts.clear();
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
    if (current && current.texts.size === 0 && current.listeners.size === 0) {
      liveThreads.delete(threadId);
    }
  };
}

function getLiveMessageSnapshot(
  threadId: string | undefined,
  messageId: string | undefined,
): string | undefined {
  if (!threadId || !messageId) return undefined;
  return liveThreads.get(threadId)?.texts.get(messageId);
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
  const liveText = useSyncExternalStore(
    subscribe,
    () => getLiveMessageSnapshot(threadId, messageId),
    () => undefined,
  );
  return liveText !== undefined
    ? { text: liveText, streaming: true }
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

/** An observer has no model or tool loop. The server owns every execution. */
export class ConversationSession extends HttpAgent {
  private observedRunId?: string;
  private readonly acceptedCommands = new Set<string>();
  private readonly activeLiveMessageIds = new Set<string>();
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
      onRunStartedEvent: ({ event }) => {
        this.observedRunId = event.runId;
        this.setConnection("online");
      },
      onTextMessageStartEvent: ({ event }) => {
        this.activeLiveMessageIds.add(event.messageId);
        setLiveMessageText(this.threadId, event.messageId, "");
      },
      onTextMessageContentEvent: ({ event, textMessageBuffer }) => {
        this.activeLiveMessageIds.add(event.messageId);
        setLiveMessageText(this.threadId, event.messageId, textMessageBuffer);
      },
      onTextMessageEndEvent: ({ event }) => {
        this.activeLiveMessageIds.delete(event.messageId);
        clearLiveMessageText(this.threadId, event.messageId);
      },
      onRunFinishedEvent: () => {
        this.activeLiveMessageIds.clear();
        clearLiveMessageText(this.threadId);
        this.setConnection("online");
      },
      onRunErrorEvent: () => {
        this.activeLiveMessageIds.clear();
        clearLiveMessageText(this.threadId);
        this.setConnection("online");
      },
      onRunFinalized: () => {
        this.activeLiveMessageIds.clear();
        clearLiveMessageText(this.threadId);
        this.setConnection("online");
      },
      onMessagesSnapshotEvent: ({ event }) => {
        this.activeLiveMessageIds.clear();
        clearLiveMessageText(this.threadId);
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
          typeof event.value?.runId === "string"
        )
          this.observedRunId = event.value.runId;
      },
    });
  }
  isCommandAccepted(commandId: string) {
    return this.acceptedCommands.has(commandId);
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
  const [, refresh] = useReducer((value) => value + 1, 0);
  useExternalConnection(objectConnectionKey(agent), () => {
    let lastSignature = agent.structuralSignature();
    const forceRefresh = () => {
      lastSignature = agent.structuralSignature();
      refresh();
    };
    const subscription = agent.subscribe({
      onMessagesChanged: () => {
        const nextSignature = agent.structuralSignature();
        if (nextSignature !== lastSignature || !agent.hasActiveLiveMessage()) {
          lastSignature = nextSignature;
          refresh();
        }
      },
      onStateChanged: forceRefresh,
      onRunInitialized: forceRefresh,
      onRunFinalized: forceRefresh,
      onTextMessageEndEvent: forceRefresh,
      onMessagesSnapshotEvent: forceRefresh,
    });
    return () => subscription.unsubscribe();
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
