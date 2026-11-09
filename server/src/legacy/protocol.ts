import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import type { Hono } from "hono";

/** Installed clients keep their old URLs while current callers use the conversation API. */
const PREVIOUS_CONVERSATION_BASE = "/api/copilotkit";
export const CONVERSATION_BASE = "/api/conversations";
export function conversationPath(path: string): string {
  return path === PREVIOUS_CONVERSATION_BASE || path.startsWith(`${PREVIOUS_CONVERSATION_BASE}/`)
    ? CONVERSATION_BASE + path.slice(PREVIOUS_CONVERSATION_BASE.length) : path;
}
export function isConversationPath(path: string): boolean {
  const canonical = conversationPath(path);
  return canonical === CONVERSATION_BASE || canonical.startsWith(`${CONVERSATION_BASE}/`);
}
export function mountPreviousConversationRoutes(app: Hono<any>) {
  app.all(`${PREVIOUS_CONVERSATION_BASE}/*`, async context => {
    const url = new URL(context.req.url);
    url.pathname = conversationPath(url.pathname);
    return previousConversationResponse(await app.fetch(new Request(url, context.req.raw)));
  });
  app.all(PREVIOUS_CONVERSATION_BASE, context => {
    const url = new URL(context.req.url);
    url.pathname = CONVERSATION_BASE;
    return app.fetch(new Request(url, context.req.raw));
  });
}

function previousEvent(value: Record<string, any>): Record<string, any> {
  if (value.type === "CUSTOM" && value.name === "chisabot.headless.waiting")
    return { ...value, name: PREVIOUS_WAITING_EVENT };
  if (value.type === "RUN_FINISHED" && Array.isArray(value.outcome?.interrupts)) {
    return { ...value, outcome: { ...value.outcome, interrupts: value.outcome.interrupts.map((item: any) => {
      if (item.metadata?.chisabotWaiting === undefined) return item;
      const { chisabotWaiting, ...metadata } = item.metadata;
      return { ...item, metadata: { ...metadata, openbotWaiting: chisabotWaiting } };
    }) } };
  }
  return value;
}

/** Preserve the old SSE vocabulary only for a client using the old route. */
function previousConversationResponse(response: Response): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pending = "";
  const rewrite = (line: string) => {
    if (!line.startsWith("data:")) return line;
    try { return `data: ${JSON.stringify(previousEvent(JSON.parse(line.slice(5))))}`; }
    catch { return line; }
  };
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) controller.enqueue(encoder.encode(rewrite(line) + "\n"));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(rewrite(pending)));
    },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Read saved continuations without rewriting their signed assertion or original payload. */
export function runAssertionValue(forwarded: unknown): unknown {
  if (!forwarded || typeof forwarded !== "object") return undefined;
  const props = forwarded as Record<string, unknown>;
  return props.chisabotRun ?? props.openbotRun;
}
export function withoutRunAssertion(forwarded: Record<string, unknown>) {
  const { chisabotRun: _current, openbotRun: _previous, ...rest } = forwarded;
  return rest;
}
export function normalizeRunInput(input: RunAgentInput): RunAgentInput {
  const forwarded = input.forwardedProps;
  if (!forwarded || typeof forwarded !== "object") return input;
  const props = forwarded as Record<string, unknown>;
  if (!["openbotRun", "openbotBotId", "openbotDeploymentTools", "openbotModelOnly"].some(key => key in props)) return input;
  const { openbotRun, openbotBotId, openbotDeploymentTools, openbotModelOnly, ...rest } = props;
  return { ...input, forwardedProps: {
    ...rest,
    ...(rest.chisabotRun === undefined && openbotRun !== undefined ? { chisabotRun: openbotRun } : {}),
    ...(rest.chisabotBotId === undefined && openbotBotId !== undefined ? { chisabotBotId: openbotBotId } : {}),
    ...(rest.chisabotDeploymentTools === undefined && openbotDeploymentTools !== undefined ? { chisabotDeploymentTools: openbotDeploymentTools } : {}),
    ...(rest.chisabotModelOnly === undefined && openbotModelOnly !== undefined ? { chisabotModelOnly: openbotModelOnly } : {}),
  } };
}
export const PREVIOUS_WAITING_EVENT = "openbot.headless.waiting";
export function normalizeConversationEvent(event: BaseEvent): BaseEvent {
  if (event.type === "CUSTOM" && "name" in event && event.name === PREVIOUS_WAITING_EVENT)
    return { ...event, name: "chisabot.headless.waiting" } as BaseEvent;
  if (event.type === "RUN_STARTED" && "input" in event)
    return { ...event, input: normalizeRunInput(event.input as RunAgentInput) } as BaseEvent;
  if (event.type !== "RUN_FINISHED") return event;
  const finished = event as BaseEvent & { outcome?: { type: string; interrupts?: Array<{ metadata?: Record<string, unknown> }> } };
  if (!finished.outcome?.interrupts?.some(item => item.metadata?.openbotWaiting !== undefined)) return event;
  return { ...finished, outcome: { ...finished.outcome, interrupts: finished.outcome.interrupts.map(item => {
    if (!item.metadata || item.metadata.openbotWaiting === undefined) return item;
    const { openbotWaiting, ...metadata } = item.metadata;
    return { ...item, metadata: { ...metadata, chisabotWaiting: metadata.chisabotWaiting ?? openbotWaiting } };
  }) } } as BaseEvent;
}

/** Legacy managed computer/agent metadata retained only at the upgrade boundary. */
export function previousBotAnnotation(annotations: Record<string, string> | undefined): string | undefined {
  return annotations?.["openbot.dev/bot-id"];
}
export const PREVIOUS_MODEL_AUTH_ERROR = "OPENBOT_MODEL_AUTH_REQUIRED";
/** Old installed web bundles still use the previous marker to return to the login page. */
export function authenticationRequired() {
  return { chisabotAuthRequired: true, openbotAuthRequired: true };
}
export function previousManagedImage(image: string, harness: string): boolean {
  return new RegExp(`(?:^|/)openbot-${harness}(?::|@|$)`).test(image);
}

/** Refuse a skipped upgrade instead of creating empty replacement tables beside real history. */
export async function assertConversationNamespace(sql: { unsafe(statement: string): PromiseLike<unknown> }) {
  const rows = await sql.unsafe(`SELECT EXISTS(
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('openbot_local_threads','openbot_local_runs','openbot_local_events')
      AND c.relkind IN ('r','p')
  ) AS requires_migration`) as Array<{ requires_migration: boolean }>;
  if (rows[0]?.requires_migration)
    throw new Error("Conversation storage requires migration 0067 before this application can start.");
}
