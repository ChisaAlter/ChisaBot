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
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useSyncExternalStore,
} from "react";
import { Observable, type Subscription } from "rxjs";
import { SendDeliveryUnknownError } from "../conversations/connection-drop";
import { draftFilesAccepted, draftFilesSubmitting } from "./ui-memory";

const ConversationTransport = createContext<"commands" | "legacy">("commands");
export type ConversationConnection = "online" | "reconnecting";

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
  constructor(
    readonly runtimeAgentId: string,
    threadId: string,
    agentId: string,
    readonly transport: "commands" | "legacy" = "commands",
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
      onRunFinishedEvent: () => this.setConnection("online"),
      onRunErrorEvent: () => this.setConnection("online"),
      onRunFinalized: () => this.setConnection("online"),
      onMessagesSnapshotEvent: ({ event }) => {
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
    if (this.transport === "legacy") return super.run(input);
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
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              agentId: this.runtimeAgentId,
              input: { ...input, tools: [] },
            }),
          });
        } catch {
          abort.signal.throwIfAborted();
        }
        if (response?.ok) {
          receipt = await readAdmissionReceipt(response, commandId);
        } else if (response && response.status < 500) {
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
  transport?: "commands" | "legacy";
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
  useEffect(() => {
    const subscription = agent.subscribe({
      onMessagesChanged: refresh,
      onStateChanged: refresh,
      onRunInitialized: refresh,
      onRunFinalized: refresh,
    });
    return () => subscription.unsubscribe();
  }, [agent]);
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
