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
  useMemo,
  useReducer,
} from "react";
import { Observable, type Subscription } from "rxjs";

const ConversationTransport = createContext<"commands" | "legacy">("commands");

/** An observer has no model or tool loop. The server owns every execution. */
export class ConversationSession extends HttpAgent {
  private observedRunId?: string;
  private readonly acceptedCommands = new Set<string>();
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
      },
      onMessagesSnapshotEvent: ({ event }) => {
        for (const message of event.messages)
          if (message.role === "user") this.acceptedCommands.add(message.id);
      },
      onCustomEvent: ({ event }) => {
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
        let response: Response;
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
          if (response.ok) receipt = await response.json();
        } catch (error) {
          abort.signal.throwIfAborted();
          // Losing the admission response is not a failed send. Look up the same immutable ID.
          response = await fetch(
            `${endpoint}/commands/${encodeURIComponent(commandId)}`,
            { credentials: "include", signal: abort.signal },
          );
          if (response.status === 404) throw error;
        }
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error ?? "消息接纳尚未确认，请重试。");
        }
        receipt ??= await response.json();
        // Admission is durable even if the event subscription fails before its first frame.
        this.acceptedCommands.add(commandId);
        this.observedRunId = receipt!.runId;
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
  protected override connect(input: RunAgentInput) {
    const observer = new HttpAgent({
      url: `/api/conversations/agent/${encodeURIComponent(this.runtimeAgentId)}/connect`,
      fetch: (url, init) => fetch(url, { ...init, credentials: "include" }),
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

const sessions = new Map<string, ConversationSession>();
export function ConversationSessionProvider({
  children,
  transport = "commands",
}: {
  children: ReactNode;
  transport?: "commands" | "legacy";
}) {
  useEffect(
    () => () => {
      for (const session of sessions.values()) void session.detachActiveRun();
      sessions.clear();
    },
    [],
  );
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
  const agent = useMemo(() => {
    const key = JSON.stringify([threadId, runtimeAgentId, transport]);
    let session = sessions.get(key);
    if (!session) {
      session = new ConversationSession(
        runtimeAgentId,
        threadId,
        agentId,
        transport,
      );
      sessions.set(key, session);
    }
    return session;
  }, [threadId, runtimeAgentId, agentId, transport]);
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
  return { agent, isReady: true };
}

export const conversationClient = {
  getAgent(agentId: string) {
    return [...sessions.values()].find(
      (session) => session.agentId === agentId,
    );
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
