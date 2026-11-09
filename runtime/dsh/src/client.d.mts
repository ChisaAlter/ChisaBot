export type DshEvent = {
  type: string;
  seq: number;
  time: number;
  data: Record<string, any>;
  surfaceOp?: unknown;
};
export type DshFrame =
  | {
      type: "snapshot";
      cursor: number;
      records: { type: "event"; event: DshEvent }[];
      hasMore: boolean;
      assistantStream?: any;
    }
  | { type: "event"; event: DshEvent }
  | { type: "assistant-stream"; frame: any };
export type DshBindingInput = {
  sessionId: string;
  runId: string;
  threadId: string;
  botId: string;
  actorId: string;
  revision: number;
  prompt: string;
  initialContext?: string;
  toolCapability?: string;
  steering?: boolean;
  connection?: {
    api: string;
    baseURL: string;
    apiKey?: string;
    modelProxy?: boolean;
    target?: { provider: string; baseUrl: string };
    models: Record<string, unknown>[];
    timeoutMs?: number;
  };
  model: {
    primary: DshModelChoice;
    fallbacks?: DshModelChoice[];
    firstOutputMs?: number;
    contextWindow?: number;
  };
  tools: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];
};
export type DshModelChoice = {
  provider: string;
  model: string;
  maxTokens?: number;
  reasoningEffort?: string;
};
export class DshHostClient {
  static connect(
    endpoint: string,
    options?: { signal?: AbortSignal },
  ): Promise<DshHostClient>;
  health(signal?: AbortSignal): Promise<{
    ok: boolean;
    protocol: number;
    version: string;
    generation: string;
    ownerUserId: string;
    sessions: {
      sessionId: string;
      runId: string;
      state: string;
      stopped: boolean;
      waiting?: Record<string, unknown>;
    }[];
  }>;
  bind(
    binding: DshBindingInput,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; generation: string; revision: number }>;
  reattach(
    binding: {
      sessionId: string;
      runId: string;
      actorId: string;
      revision: number;
      generation: string;
      toolCapability: string;
      steering: boolean;
    },
    signal?: AbortSignal,
  ): Promise<{ attached: true; generation: string }>;
  receipt(
    sessionId: string,
    runId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean }>;
  stop(
    sessionId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean }>;
  release(
    sessionId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<{ released: true }>;
  checkpoint(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ generation: string; cursor: number }>;
  prompt(
    request: {
      sessionId: string;
      requestId: string;
      mode: "queue" | "steer";
      content: (
        | { type: "text"; text: string }
        | { type: "image"; mediaType: string; data: string; name?: string }
      )[];
    },
    signal?: AbortSignal,
  ): Promise<{ accepted: true }>;
  state(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ active: boolean; running: boolean; cursor: number }>;
  wait(
    sessionId: string,
    options?: { timeoutMs?: number; afterSeq?: number },
    signal?: AbortSignal,
  ): Promise<{
    reason: "idle" | "timeout" | "input-required";
    state: { running: boolean; cursor: number };
    output: unknown;
  }>;
  events(
    sessionId: string,
    options?: {
      throughSeq?: number;
      beforeSeq?: number;
      maxMessages?: number;
      turnWindow?: { minMessages: number; minTurns: number };
    },
    signal?: AbortSignal,
  ): Promise<{
    records: { type: "event"; event: DshEvent }[];
    hasMore: boolean;
    cursor: number;
  }>;
  eventsAfter(
    sessionId: string,
    afterSeq?: number,
    throughSeq?: number,
    signal?: AbortSignal,
  ): Promise<{ records: { type: "event"; event: DshEvent }[]; cursor: number }>;
  follow(sessionId: string, signal?: AbortSignal): AsyncIterable<DshFrame>;
  close(): Promise<void>;
}
export function expandActiveAttempt(baseline: unknown):
  | {
      attemptId: string;
      turn: number;
      step: number;
      nextIndex: number;
      chunks: Record<string, any>[];
    }
  | undefined;
