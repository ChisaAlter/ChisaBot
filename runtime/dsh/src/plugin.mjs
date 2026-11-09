import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { appendPluginRecord } from "@deepseek-ai/dsh-session";
import { ACTION_NUDGE, actionPromise } from "./action-promise.mjs";
import { ChisaModelRouter } from "./model-router.mjs";
import { ensureLoopGuard, toolLoopLimits } from "./tool-loop-guard.mjs";

export const name = "chisabot-runtime";
export const inject = [
  "agents",
  "agentLoop",
  "llm",
  "sessions",
  "sessionPersistence",
  "tools",
  "systemPrompt",
  "sessionController",
  "connection",
  "webServer",
  "credentials",
  "attachments",
];

const requiredText = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    throw new Error(`Invalid ${label}.`);
  return value;
};

export async function apply(ctx, config) {
  const generation = randomUUID();
  const loopLimits = toolLoopLimits(config.toolLoop);
  // References only, never key values. A crash must not leave temporary run credentials forever.
  const keyJournal = join(config.home, "route-keys.json");
  const keyRefs = new Set();
  let keyWrites = Promise.resolve();
  const saveKeyRefs = () => {
    const body = JSON.stringify([...keyRefs]);
    const write = keyWrites.then(async () => {
      await writeFile(`${keyJournal}.tmp`, body, { mode: 0o600 });
      await rename(`${keyJournal}.tmp`, keyJournal);
    });
    keyWrites = write.catch(() => {});
    return write;
  };
  let oldRefs;
  try {
    oldRefs = JSON.parse(await readFile(keyJournal, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    oldRefs = [];
  }
  for (const ref of oldRefs) {
    if (typeof ref !== "string" || !ref.startsWith("CHISABOT_ROUTE_"))
      throw new Error("Invalid temporary credential journal.");
    await ctx.credentials.unset(ref);
  }
  await saveKeyRefs();
  const removeKey = async (ref) => {
    if (!ref) return;
    await ctx.credentials.unset(ref);
    keyRefs.delete(ref);
    await saveKeyRefs();
  };
  let providerProfiles = { ...config.providers };
  const providerFiber = ctx.plugin(PiAi, { providers: providerProfiles });
  await providerFiber;
  let providerUpdate = Promise.resolve();
  const updateProvider = (id, profile) => {
    const update = providerUpdate.then(async () => {
      const next = { ...providerProfiles };
      if (profile) next[id] = profile;
      else delete next[id];
      await providerFiber.update({ providers: next });
      providerProfiles = next;
    });
    providerUpdate = update.catch(() => {});
    return update;
  };
  const router = new ChisaModelRouter(ctx);
  ctx.llm.registerAdapter(["chisabot"], router);
  const sessions = new Map();
  const pending = new Map();
  ctx.on("session/event", (session, event) => {
    const state = sessions.get(session.id);
    if (event.type === "tool/call") {
      state?.calls.set(event.data.callId, { ...event.data, seq: event.seq });
      state?.toolTurns.add(event.data.turn);
    }
    // The last model reply of each turn, for the promise-without-action guard.
    if (state && event.type === "assistant/message")
      state.reply = {
        turn: event.data.turn,
        text: (event.data.message?.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      };
    if (state && event.type === "assistant/attempt")
      state.reply = { turn: event.data?.turn, failed: true };
    if (state && event.type === "tool/result") {
      const key = `${event.data.turn}:${event.data.step}`;
      if (state.resultStep !== key) {
        state.resultStep = key;
        state.resultIds = [];
      }
      state.resultIds.push(
        `${session.id}:${key}:${event.data.message.toolCallId}`,
      );
    }
  });
  const serialized = (id, work) => {
    const result = (pending.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work);
    pending.set(id, result);
    void result
      .finally(() => {
        if (pending.get(id) === result) pending.delete(id);
      })
      .catch(() => {});
    return result;
  };

  function checkBinding(value) {
    for (const key of ["sessionId", "runId", "threadId", "botId", "actorId"])
      requiredText(value[key], key);
    if (value.actorId !== config.ownerUserId)
      throw new Error("This runtime belongs to another account.");
    if (
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      !value.model ||
      !Array.isArray(value.tools)
    )
      throw new Error("Invalid binding revision, model or tools.");
    if (typeof value.prompt !== "string")
      throw new Error("A bound prompt is required.");
    const names = new Set();
    for (const tool of value.tools) {
      requiredText(tool.name, "tool name");
      if (
        names.has(tool.name) ||
        !tool.parameters ||
        typeof tool.description !== "string"
      )
        throw new Error("Invalid or duplicate tool.");
      names.add(tool.name);
    }
    return structuredClone(value);
  }

  async function invokeGateway(state, action, body, signal) {
    const until = Date.now() + 90_000;
    while (true) {
      const token =
        state.binding.toolCapability ?? process.env[config.gatewayTokenEnv];
      if (!config.gatewayUrl || !token)
        throw new Error("The ChisaBot tool gateway is not configured.");
      let response;
      try {
        response = await fetch(
          new URL(
            action,
            config.gatewayUrl.endsWith("/")
              ? config.gatewayUrl
              : `${config.gatewayUrl}/`,
          ),
          {
            method: "POST",
            signal,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              ...body,
              binding: {
                sessionId: state.binding.sessionId,
                runId: state.binding.runId,
                threadId: state.binding.threadId,
                botId: state.binding.botId,
                actorId: state.binding.actorId,
                revision: state.binding.revision,
                generation,
              },
            }),
          },
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (Date.now() >= until) throw error;
        await delay(1000, undefined, { signal });
        continue;
      }
      if (
        [401, 502, 503, 504].includes(response.status) &&
        Date.now() < until
      ) {
        await response.body?.cancel();
        await delay(1000, undefined, { signal });
        continue;
      }
      if (!response.ok)
        throw new Error(`ChisaBot ${action} failed (${response.status}).`);
      try {
        return await response.json();
      } catch (error) {
        // A gateway receipt can be lost after its ledger commit or even after HTTP headers.
        // Retry the same call identity; the gateway returns its saved result or pending card.
        signal?.throwIfAborted();
        if (Date.now() >= until) throw error;
        await delay(1000, undefined, { signal });
      }
    }
  }

  function compose(agentCtx, agent, state) {
    state.steeringInstructions = [];
    state.toolTurns = new Set();
    state.nudgedTurns = new Set();
    state.reply = undefined;
    // Bounds each turn's tool loop. Keep the same guard across rebinds of this run
    // (approval resume must not clear the per-turn counters — QA513 P3).
    ensureLoopGuard(state, loopLimits);
    state.disposers.push(
      agentCtx.systemPrompt.section({
        name: "chisabot:prompt",
        order: 0,
        complete: true,
        interpolate: false,
        text: () => state.binding.prompt,
      }),
    );
    // DSH assembles the system prompt before pre-step. Required context is refreshed after
    // admission, so skills claimed here affect this very request and persist in its journal.
    state.disposers.push(
      agentCtx.systemPrompt.context({
        name: "chisabot:inbox-skills",
        order: 0,
        required: true,
        interpolate: false,
        text: () => state.steeringInstructions.join("\n\n"),
      }),
    );
    for (const tool of state.binding.tools) {
      state.disposers.push(
        agentCtx.tools.register({
          ...tool,
          output: {
            schema: { type: "object", additionalProperties: true },
            render: (_args, value) => [
              {
                type: "text",
                text:
                  typeof value.content === "string"
                    ? value.content
                    : JSON.stringify(value),
              },
            ],
          },
          execute: async (args, execution) => {
            if (state.stopped) throw new Error("This run was stopped.");
            execution.signal.throwIfAborted();
            const call = state.calls.get(execution.callId);
            if (!call || call.name !== tool.name)
              throw new Error(
                "The invocation has no committed DSH tool-call identity.",
              );
            const verdict = state.loopGuard.admit(call.turn, tool.name, args);
            if (verdict.kind === "conclude") {
              // The model ignored the stop notice. End the turn here with a plain account of what
              // happened (projected to the person as the turn's answer) instead of spinning on.
              if (state.loopConcluded !== call.turn) {
                state.loopConcluded = call.turn;
                appendPluginRecord(agent.session, "plugin:chisabot/loop-stop", {
                  turn: call.turn,
                  step: call.step,
                  text: verdict.text,
                });
                await ctx.sessions.flush(agent.session);
              }
              execution.concludeTurn();
              return {
                content:
                  "Not executed: ChisaBot stopped this turn's tool loop and answered the user.",
                stopped: true,
              };
            }
            // Refused calls never reach the gateway; the model is told to stop and answer.
            if (verdict.kind === "refuse") throw new Error(verdict.message);
            let result;
            try {
              result = await invokeGateway(
                state,
                "execute",
                {
                  callId: execution.callId,
                  turn: call.turn,
                  step: call.step,
                  throughSeq: call.seq,
                  name: tool.name,
                  args,
                },
                execution.signal,
              );
            } catch (error) {
              // Gateway 409 / transport failure: not an actual execution (QA513 P3).
              state.loopGuard.observe({ rejected: true });
              throw error;
            }
            if (result.waiting) {
              // Approval pause: the call has not run yet; do not count it as executed.
              state.loopGuard.observe({ deferred: true });
              state.waiting = result.waiting;
              appendPluginRecord(agent.session, "plugin:chisabot/waiting", {
                callId: execution.callId,
                turn: call.turn,
                step: call.step,
                waiting: {
                  kind: result.waiting.kind,
                  requestId: result.waiting.requestId,
                },
              });
              await ctx.sessions.flush(agent.session);
              state.handle.agent.cancel({ kind: "user" });
              throw new Error(
                "Waiting for a ChisaBot approval; the operation has not executed.",
              );
            }
            state.loopGuard.observe({ result });
            return result;
          },
        }),
      );
    }
    state.disposers.push(
      agentCtx.on("agent/pre-step", async (input, next) => {
        if (state.stopped) return { kind: "reject" };
        const decision = await next();
        if (decision.kind !== "enter" || !state.binding.steering)
          return decision;
        const anchors =
          state.resultStep === `${input.turn}:${input.step - 1}`
            ? state.resultIds
            : [];
        const result = await invokeGateway(
          state,
          "steer",
          { turn: input.turn, step: input.step, anchors },
          input.signal,
        );
        if (result.stopped) {
          state.stopped = true;
          agent.cancel({ kind: "user" });
          return { kind: "reject" };
        }
        state.steeringInstructions.push(...(result.instructions ?? []));
        const injected = await Promise.all(
          result.messages.map(async (message) =>
            createUserMessage({
              source: { kind: "user", rpcId: message.id },
              content: await ctx.attachments.admitPromptContent(
                typeof message.content === "string"
                  ? [{ type: "text", text: message.content }]
                  : message.content,
              ),
            }),
          ),
        );
        return { ...decision, messages: [...decision.messages, ...injected] };
      }),
    );
    // Promise without action (ported from the Hermes adapter): a turn about to close on "I'll go
    // check now" — tools on offer, none called this turn — is steered once to actually act.
    state.disposers.push(
      agentCtx.on("agent/turn-stopping", ({ turn, signal }) => {
        const reply = state.reply;
        if (
          signal?.aborted ||
          state.stopped ||
          state.waiting ||
          state.binding.tools.length === 0 ||
          state.toolTurns.has(turn) ||
          state.nudgedTurns.has(turn) ||
          state.loopGuard.isStopped(turn) ||
          reply?.turn !== turn ||
          reply.failed ||
          !actionPromise(reply.text)
        )
          return;
        state.nudgedTurns.add(turn);
        agent.steer(
          createUserMessage({
            source: {
              kind: "user",
              rpcId: `chisabot:action-nudge:${state.binding.runId}:${turn}`,
            },
            content: [{ type: "text", text: ACTION_NUDGE }],
          }),
        );
      }),
    );
    state.disposers.push(
      agentCtx.on("agent/request-error", async (failure, next) =>
        (await router.retry(agent, failure)) ? { kind: "retry" } : next(),
      ),
    );
    // Every offered tool is a ChisaBot executor and asks through its existing policy service.
    // Native tool bundles are absent; an unexpected native approval retains DSH's unavailable outcome.
  }

  async function bind(input) {
    const binding = checkBinding(input);
    return serialized(binding.sessionId, async () => {
      let state = sessions.get(binding.sessionId);
      if (state && state.handle.agent.status !== "idle")
        throw new Error("The session still owns active work.");
      if (
        state &&
        (state.binding.threadId !== binding.threadId ||
          state.binding.botId !== binding.botId ||
          binding.revision < state.binding.revision)
      )
        throw new Error("Session binding conflict.");
      // A run is an execution identity, not a new model. Changing the model ID every turn
      // invokes DSH's strict model-switch compaction even when the provider/model is unchanged.
      // Persist this non-secret selection so an ordinary continuation survives Host restarts too.
      const selection = JSON.stringify({
        connection: binding.connection
          ? {
              api: binding.connection.api,
              baseURL: binding.connection.baseURL,
              target: binding.connection.target,
              models: binding.connection.models,
            }
          : undefined,
        primary: binding.model.primary,
        fallbacks: binding.model.fallbacks ?? [],
        contextWindow: binding.model.contextWindow,
      });
      const existing = state
        ? undefined
        : await ctx.sessionPersistence.stat(binding.sessionId);
      let previousSelection = state?.selection;
      let previousRouteId = state?.routeId;
      if (existing) {
        const stored = await ctx.sessionPersistence.open(
          binding.sessionId,
          "read",
        );
        try {
          const saved = (await stored.read()).events.findLast(
            (event) => event.type === "plugin:chisabot/model-binding",
          )?.data;
          if (
            saved &&
            typeof saved.selection === "string" &&
            typeof saved.routeId === "string"
          ) {
            previousSelection = saved.selection;
            previousRouteId = saved.routeId;
          }
        } finally {
          await stored.close();
        }
      }
      const routeId =
        previousSelection === selection && previousRouteId
          ? previousRouteId
          : `route-${randomUUID()}`;
      let routeFiber;
      let keyRef;
      if (binding.connection) {
        const connection = binding.connection;
        if (
          ![
            "openai-completions",
            "anthropic-messages",
            "openai-responses",
          ].includes(connection.api) ||
          !Array.isArray(connection.models)
        )
          throw new Error("Invalid model connection.");
        const url = new URL(connection.baseURL);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("Invalid model endpoint.");
        const provider = `chisabot-${randomUUID()}`;
        if (connection.apiKey) {
          keyRef = `CHISABOT_ROUTE_${randomUUID().replaceAll("-", "_")}`;
          keyRefs.add(keyRef);
          await saveKeyRefs();
          await ctx.credentials.set(keyRef, connection.apiKey);
        }
        try {
          await updateProvider(provider, {
            api: connection.api,
            baseURL: connection.baseURL,
            models: connection.models,
            ...(keyRef ? { apiKeyEnv: keyRef } : {}),
            timeoutMs: connection.timeoutMs ?? 90_000,
          });
          routeFiber = { dispose: () => updateProvider(provider, undefined) };
        } catch (error) {
          await removeKey(keyRef);
          throw error;
        }
        // The provider id is per binding; the model breaker keys on the real endpoint and model
        // so a dead model stays skipped across turns, sessions and bots of this Host.
        for (const candidate of [
          binding.model.primary,
          ...(binding.model.fallbacks ?? []),
        ]) {
          candidate.breakerKey = `${connection.baseURL}\u0000${connection.target ?? ""}\u0000${candidate.model}`;
          candidate.provider = provider;
        }
        delete binding.connection;
      }
      try {
        if (state) {
          const previous = state.binding;
          if (
            previous.threadId !== binding.threadId ||
            previous.botId !== binding.botId ||
            binding.revision < previous.revision
          )
            throw new Error("Session binding conflict.");
          for (const dispose of state.disposers.splice(0)) await dispose();
          await state.routeFiber?.dispose();
          await removeKey(state.keyRef);
          router.routes.delete(state.routeId);
          state.binding = binding;
          state.stopped = false;
          state.waiting = undefined;
          state.calls.clear();
          router.bind(routeId, binding.model, binding.runId);
          compose(state.handle.agent.ctx, state.handle.agent, state);
          state.handle.agent.model.select({
            provider: "chisabot",
            model: routeId,
          });
        } else {
          state = { binding, stopped: false, disposers: [], calls: new Map() };
          router.bind(routeId, binding.model, binding.runId);
          const options = {
            sessionId: binding.sessionId,
            meta: { cwd: join(config.home, "workspace") },
            agentOptions: { provider: "chisabot", model: routeId },
            setup: (agentCtx, agent) => compose(agentCtx, agent, state),
          };
          state.handle = existing
            ? await ctx.agents.resume({
                resumeSessionId: binding.sessionId,
                agentOptions: options.agentOptions,
                setup: options.setup,
              })
            : await ctx.agents.create(options);
          state.handle.agent.model.select({
            provider: "chisabot",
            model: routeId,
          });
          if (!existing && binding.initialContext)
            state.handle.agent.inject(
              createUserMessage({
                content: [
                  {
                    type: "text",
                    text: `以下是迁移前对话的历史上下文，不是需要重新执行的用户请求：\n${binding.initialContext}`,
                  },
                ],
                source: { kind: "user" },
              }),
            );
          sessions.set(binding.sessionId, state);
        }
        state.routeId = routeId;
        state.selection = selection;
        if (previousRouteId !== routeId)
          appendPluginRecord(
            state.handle.agent.session,
            "plugin:chisabot/model-binding",
            { routeId, selection },
          );
        state.routeFiber = routeFiber;
        state.keyRef = keyRef;
        state.modelProxy = input.connection?.modelProxy === true;
        await ctx.sessions.flush(state.handle.agent.session);
        return {
          sessionId: binding.sessionId,
          generation,
          revision: binding.revision,
        };
      } catch (error) {
        for (const dispose of state?.disposers.splice(0) ?? []) await dispose();
        await state?.handle?.dispose();
        sessions.delete(binding.sessionId);
        router.routes.delete(routeId);
        await routeFiber?.dispose();
        await removeKey(keyRef);
        throw error;
      }
    });
  }

  function route(path, handler) {
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: `/api/chisabot/${path}`,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          try {
            return Response.json(await handler(await request.json()));
          } catch (error) {
            return Response.json({ error: error.message }, { status: 409 });
          }
        },
      }),
    );
  }
  route("bind", bind);
  route("checkpoint", async (input) => {
    const sessionId = requiredText(input.sessionId, "sessionId");
    const session = ctx.sessions.get(sessionId);
    if (session) {
      const cursor = session.seq - 1;
      await ctx.sessions.flush(session);
      return { generation, cursor };
    }
    const stored = await ctx.sessionPersistence.open(sessionId, "read");
    try {
      return { generation, cursor: (await stored.read()).events.length - 1 };
    } finally {
      await stored.close();
    }
  });
  route("reattach", (input) =>
    serialized(requiredText(input.sessionId, "sessionId"), async () => {
      const state = sessions.get(input.sessionId);
      if (
        !state ||
        state.binding.runId !== input.runId ||
        state.binding.actorId !== input.actorId ||
        state.binding.revision !== input.revision ||
        input.generation !== generation
      )
        throw new Error("The recovering observer does not own this run.");
      state.binding.toolCapability = requiredText(
        input.toolCapability,
        "tool capability",
      );
      if (state.modelProxy && state.keyRef)
        await ctx.credentials.set(state.keyRef, state.binding.toolCapability);
      state.binding.steering = input.steering === true;
      return { attached: true, generation };
    }),
  );
  route("receipt", (input) =>
    serialized(requiredText(input.sessionId, "sessionId"), async () => {
      const state = sessions.get(input.sessionId);
      if (!state || state.binding.runId !== input.runId)
        throw new Error("The requested run does not own this session.");
      const sourceMatches = (message) =>
        message.source?.kind === "user" &&
        message.source.rpcId === input.requestId;
      const accepted =
        state.handle.agent.inbox.nextTurn.some(sourceMatches) ||
        state.handle.agent.inbox.nextStep.some(sourceMatches) ||
        state.handle.agent.session
          .snapshotEvents()
          .some(
            (event) =>
              event.type === "user/message" && sourceMatches(event.data),
          );
      await ctx.sessions.flush(state.handle.agent.session);
      return { accepted };
    }),
  );
  route("stop", (input) =>
    serialized(requiredText(input.sessionId, "sessionId"), async () => {
      const state = sessions.get(input.sessionId);
      if (!state || state.binding.runId !== input.runId)
        throw new Error("The requested run does not own this session.");
      state.stopped = true;
      state.handle.agent.cancel({ kind: "user" });
      return { accepted: true, generation, sessionId: input.sessionId };
    }),
  );
  route("release", (input) =>
    serialized(requiredText(input.sessionId, "sessionId"), async () => {
      const state = sessions.get(input.sessionId);
      if (!state || state.binding.runId !== input.runId)
        throw new Error("The requested run does not own this session.");
      if (state.handle.agent.status !== "idle")
        throw new Error("The session still owns active work.");
      await ctx.sessions.flush(state.handle.agent.session);
      await state.routeFiber?.dispose();
      await removeKey(state.keyRef);
      state.routeFiber = undefined;
      state.keyRef = undefined;
      delete state.binding.toolCapability;
      router.routes.delete(state.routeId);
      return { released: true };
    }),
  );
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: "/api/chisabot/health",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async () =>
        Response.json({
          ok: true,
          protocol: 1,
          version: "0.2.2-rc.1",
          generation,
          ownerUserId: config.ownerUserId,
          sessions: [...sessions.values()].map((x) => ({
            sessionId: x.binding.sessionId,
            runId: x.binding.runId,
            state: x.handle.agent.status,
            stopped: x.stopped,
            ...(x.waiting ? { waiting: x.waiting } : {}),
          })),
        }),
    }),
  );
  ctx.on("dispose", async () => {
    await Promise.allSettled(
      [...sessions.values()].map((state) => state.handle.dispose()),
    );
    for (const ref of [...keyRefs]) await removeKey(ref);
  });

  // Private launch-token discovery for the owning backend. Never print this URL.
  const endpoint = ctx.connection.authenticatedUrl(ctx.webServer.getOrigin());
  const destination = join(config.home, "connection.json");
  await writeFile(
    `${destination}.tmp`,
    JSON.stringify({ endpoint, generation, protocol: 1 }),
    { mode: 0o600 },
  );
  await rename(`${destination}.tmp`, destination);
  console.info(
    JSON.stringify({ type: "chisabot-runtime-ready", generation, protocol: 1 }),
  );
}
