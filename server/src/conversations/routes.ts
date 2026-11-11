import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { Hono } from "hono";
import { Observable, type Subscription } from "rxjs";
import { connectSnapshotAnchors } from "../../../shared/connect-snapshot";
import { ToolOutcomeResolutionSchema } from "../../../shared/conversations";
import type { ActorAgentResolver } from "../agents/agent-resolver";
import {
  type HeadlessTool,
  HeadlessToolsMiddleware,
} from "../computer/headless-tools";
import type { IdentifyActor } from "../conversation-runtime";
import type { LocalConversationBackend } from "../local-conversations";
import { publicErrorMessage } from "../public-error";
import type { ConversationCommandRecord } from "./commands";
import { assertConversationAdmissionOpen } from "./maintenance";
import type { ToolOperationStore } from "./tool-operations";

/**
 * What a failed conversation may tell the browser or the log: never a raw `error.message`.
 * Delegates to the one shared redaction (public-error.ts).
 */
export function publicConversationError(error: unknown): string {
  return publicErrorMessage(error);
}

/** Subscription lifetime controls delivery only. The runner owns execution and persistence. */
function eventStream(source: Observable<BaseEvent>) {
  const encoder = new TextEncoder();
  let subscription: Subscription | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        controller.close();
      };
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15_000);
      subscription = source.subscribe({
        next: (event) => {
          if (!closed)
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
        },
        error: (error) => {
          if (!closed)
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "RUN_ERROR", code: "CONVERSATION_FAILED", message: publicConversationError(error) })}\n\n`,
              ),
            );
          close();
        },
        complete: close,
      });
    },
    cancel() {
      clearInterval(heartbeat);
      subscription?.unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

/** AG-UI is retained at the wire boundary for Android and registered external agents. */
export function createConversationRoutes(options: {
  backend: LocalConversationBackend;
  resolver: ActorAgentResolver;
  identifyActor: IdentifyActor;
  toolOperations?: ToolOperationStore;
  prepareAgent?: (
    actorId: string,
    agent: import("@ag-ui/client").AbstractAgent,
  ) => Promise<void>;
  toolsFor?: (
    actorId: string,
    botId: string,
    input: import("@ag-ui/client").RunAgentInput,
  ) => Promise<readonly HeadlessTool[]>;
}) {
  const routes = new Hono();
  const { backend, resolver, identifyActor } = options;
  async function dispatch(
    record: ConversationCommandRecord,
    agent: AbstractAgent,
  ) {
    const dispatchFailed = (error: unknown) => {
      console.warn(
        JSON.stringify({
          type: "conversation-dispatch-error",
          runId: record.run_id,
          message: publicConversationError(error),
        }),
      );
    };
    try {
      if (options.toolsFor)
        agent.use(
          new HeadlessToolsMiddleware(
            [
              ...(await options.toolsFor(
                record.owner_user_id,
                record.bot_id,
                record.input,
              )),
            ],
            { kind: "person" },
          ),
        );
      backend.runner
        .run({ threadId: record.thread_id, agent, input: record.input })
        .subscribe({ error: dispatchFailed });
    } catch (error) {
      dispatchFailed(error);
    }
  }
  async function admit(
    request: Request,
    agentId: string,
    input: import("@ag-ui/client").RunAgentInput,
  ) {
    await assertConversationAdmissionOpen();
    const actor = await identifyActor(request);
    const agent = await resolver.resolveAgentForActor(actor, agentId, {
      initiator: { kind: "person" },
    });
    if (options.prepareAgent) {
      const messageId = input.messages.findLast(
        (message) => message.role === "user",
      )?.id;
      const accepted = messageId
        ? await backend.commands.get(actor.id, input.threadId, messageId)
        : undefined;
      // A retry of an accepted command keeps its receipt even if provisioning later changes.
      if (!accepted) await options.prepareAgent(actor.id, agent);
    }
    await backend.client.getOrCreateThread({
      threadId: input.threadId,
      userId: actor.id,
      agentId,
    });
    const admission = await backend.commands.accept(actor.id, agentId, input);
    const { record } = admission;
    if (!admission.alreadyAccepted) {
      // Subscribe independently of the response. Losing the admission HTTP reply cannot cancel it.
      await dispatch(record, agent);
    }
    return {
      accepted: true,
      alreadyAccepted: admission.alreadyAccepted,
      commandId: record.command_id,
      runId: record.run_id,
      threadId: record.thread_id,
      status: record.status,
    };
  }
  routes.post("/api/conversations/:threadId/commands", async (context) => {
    const body = await context.req.json();
    const input = RunAgentInputSchema.parse({
      ...body.input,
      threadId: context.req.param("threadId"),
    });
    if (typeof body.agentId !== "string" || !body.agentId)
      return context.json({ error: "Bot is required." }, 400);
    const receipt = await admit(context.req.raw, body.agentId, input);
    return context.json(receipt, receipt.alreadyAccepted ? 200 : 202);
  });
  routes.get("/api/conversations/:threadId/operations", async (context) => {
    const actor = await identifyActor(context.req.raw);
    const threadId = context.req.param("threadId");
    return context.json({
      operations: options.toolOperations
        ? await options.toolOperations.listUnknown(actor.id, threadId)
        : [],
    });
  });
  routes.post(
    "/api/conversations/:threadId/operations/:operationId/resolve",
    async (context) => {
      const actor = await identifyActor(context.req.raw);
      const threadId = context.req.param("threadId");
      const thread = await backend.client.getThread({
        threadId,
        userId: actor.id,
      });
      if (!options.toolOperations)
        return context.json({ error: "当前执行内核没有待核对操作。" }, 409);
      const parsed = ToolOutcomeResolutionSchema.safeParse(
        await context.req.json(),
      );
      if (!parsed.success)
        return context.json(
          { error: parsed.error.issues[0]?.message ?? "核对结果不完整。" },
          400,
        );
      const agent = parsed.data.continue
        ? await resolver.resolveAgentForActor(actor, thread.agentId, {
            initiator: { kind: "person" },
          })
        : undefined;
      if (agent) {
        await assertConversationAdmissionOpen();
        await options.prepareAgent?.(actor.id, agent);
      }
      const { record, alreadyAccepted } =
        await options.toolOperations.resolveOutcome(
          actor.id,
          threadId,
          context.req.param("operationId"),
          parsed.data,
        );
      if (record && agent && !alreadyAccepted) await dispatch(record, agent);
      return context.json({
        resolved: true,
        continued: Boolean(record),
        ...(record
          ? { commandId: record.command_id, runId: record.run_id }
          : {}),
      });
    },
  );
  routes.get(
    "/api/conversations/:threadId/commands/:commandId",
    async (context) => {
      const actor = await identifyActor(context.req.raw);
      const record = await backend.commands.get(
        actor.id,
        context.req.param("threadId"),
        context.req.param("commandId"),
      );
      return record
        ? context.json({
            accepted: true,
            commandId: record.command_id,
            runId: record.run_id,
            status: record.status,
          })
        : context.json({ error: "Command not found." }, 404);
    },
  );
  routes.post("/api/conversations/:threadId/events", async (context) => {
    const actor = await identifyActor(context.req.raw);
    const body = await context.req.json();
    const threadId = context.req.param("threadId");
    const record = await backend.commands.get(
      actor.id,
      threadId,
      String(body.commandId ?? ""),
    );
    if (!record) return context.json({ error: "Command not found." }, 404);
    return eventStream(
      backend.runner.connect({
        threadId,
        agentId: record.bot_id,
        commandId: record.command_id,
      }),
    );
  });
  routes.onError((error, context) => {
    const status =
      "status" in error && typeof error.status === "number"
        ? error.status
        : 500;
    return context.json(
      { error: publicConversationError(error) },
      status as 400,
    );
  });
  routes.get("/api/conversations/info", async (context) => {
    const actor = await identifyActor(context.req.raw);
    const agents = await resolver.resolveAgentsForActor(actor);
    return context.json({
      version: "chisabot-1",
      mode: "sse",
      telemetryDisabled: true,
      agents: Object.fromEntries(
        Object.entries(agents).map(([id, agent]) => [
          id,
          { name: id, description: agent.description },
        ]),
      ),
    });
  });
  routes.post("/api/conversations/agent/:agentId/run", async (context) => {
    const input = RunAgentInputSchema.parse(await context.req.json());
    const agentId = context.req.param("agentId");
    const receipt = await admit(context.req.raw, agentId, input);
    return eventStream(
      new Observable<BaseEvent>((observer) => {
        const subscription = backend.runner
          .connect({
            threadId: input.threadId,
            agentId,
            commandId: receipt.commandId,
          })
          .subscribe({
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
        return () => subscription.unsubscribe();
      }),
    );
  });
  routes.post("/api/conversations/agent/:agentId/connect", async (context) => {
    const actor = await identifyActor(context.req.raw);
    const { threadId, snapshotAfter } = await context.req.json();
    if (typeof threadId !== "string" || !threadId || threadId.length > 512)
      return context.json({ error: "Thread is required." }, 400);
    const agentId = context.req.param("agentId");
    await backend.client.getOrCreateThread({
      threadId,
      userId: actor.id,
      agentId,
    });
    const anchors = connectSnapshotAnchors(snapshotAfter);
    return eventStream(
      backend.runner.connect({
        threadId,
        agentId,
        ...(anchors ? { snapshotAfter: anchors } : {}),
      }),
    );
  });
  routes.post(
    "/api/conversations/agent/:agentId/stop/:threadId",
    async (context) => {
      const actor = await identifyActor(context.req.raw);
      const threadId = context.req.param("threadId");
      const thread = await backend.client.getThread({
        threadId,
        userId: actor.id,
      });
      if (thread.agentId !== context.req.param("agentId"))
        return context.json({ error: "Thread not found." }, 404);
      const body = await context.req.json().catch(() => ({}));
      return context.json({
        stopped: await backend.runner.stop({
          threadId,
          ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
        }),
      });
    },
  );
  return routes;
}
