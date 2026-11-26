import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import { appendPluginRecord } from "@deepseek-ai/dsh-session";
import { ACTION_NUDGE, actionPromise } from "./action-promise.mjs";
import {
  detectLeakedToolCall,
  LEAKED_TOOL_CALL_ABORT_MESSAGE,
  LEAKED_TOOL_CALL_NUDGE,
} from "./leaked-tool-call.mjs";
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

const STEER_CUT = "chisabot/steer";
const DEFAULT_MAX_IDLE_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_TTL_MS = 10 * 60_000;

const requiredText = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    throw new Error(`Invalid ${label}.`);
  return value;
};

const readNonNegativeInt = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const findLastModelBinding = (events) => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "plugin:chisabot/model-binding") return event.data;
  }
  return undefined;
};

export async function apply(ctx, config) {
  const generation = randomUUID();
  const loopLimits = toolLoopLimits(config.toolLoop);
  const maxIdleSessions = readNonNegativeInt(
    config.maxIdleSessions ?? process.env.CHISABOT_DSH_MAX_SESSIONS,
    DEFAULT_MAX_IDLE_SESSIONS,
  );
  const sessionIdleTtlMs = readNonNegativeInt(
    config.sessionIdleTtlMs ?? process.env.CHISABOT_DSH_SESSION_IDLE_MS,
    DEFAULT_SESSION_IDLE_TTL_MS,
  );
  // Clean up any legacy on-disk temporary route keys from prior versions, then keep all
  // new run credentials strictly in memory (zero writes to .credentials.yaml or route-keys.json).
  const keyJournal = join(config.home, "route-keys.json");
  let oldRefs;
  try {
    oldRefs = JSON.parse(await readFile(keyJournal, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    oldRefs = undefined;
  }
  if (oldRefs !== undefined) {
    if (!Array.isArray(oldRefs))
      throw new Error("Invalid temporary credential journal.");
    for (const ref of oldRefs) {
      if (typeof ref !== "string" || !ref.startsWith("CHISABOT_ROUTE_"))
        throw new Error("Invalid temporary credential journal.");
      await ctx.credentials.unset(ref);
    }
    await rm(keyJournal, { force: true });
  }
  const ephemeralKeys = new Map();
  const baseCredentials = ctx.credentials;
  const overlayCredentials = {
    resolve: (ref) => {
      if (typeof ref === "string" && ephemeralKeys.has(ref)) {
        return Promise.resolve({
          value: ephemeralKeys.get(ref),
          source: "memory",
        });
      }
      return baseCredentials.resolve(ref);
    },
    describe: (ref) => {
      if (typeof ref === "string" && ephemeralKeys.has(ref)) {
        return Promise.resolve({
          configured: true,
          source: "memory",
          writable: false,
        });
      }
      return baseCredentials.describe(ref);
    },
    set: (ref, value) => baseCredentials.set(ref, value),
    unset: (ref) => baseCredentials.unset(ref),
    readRecord: (key) => baseCredentials.readRecord(key),
    describeRecord: (key) => baseCredentials.describeRecord(key),
    listRecords: () => baseCredentials.listRecords(),
    modifyRecord: (key, mutate) => baseCredentials.modifyRecord(key, mutate),
    deleteRecord: (key) => baseCredentials.deleteRecord(key),
  };
  const piAiCtx =
    typeof ctx.isolate === "function" ? ctx.isolate("credentials") : ctx;
  if (typeof piAiCtx.provide === "function") {
    piAiCtx.provide("credentials", overlayCredentials);
  }
  let providerProfiles = Object.fromEntries(
    Object.entries(config.providers).map(([id, profile]) => [
      id,
      { timeoutMs: 0, streamIdleTimeoutMs: 0, ...profile },
    ]),
  );
  const providerFiber = piAiCtx.plugin(PiAi, { providers: providerProfiles });
  await providerFiber;
  let providerUpdateCount = 0;
  let evictedSessionCount = 0;
  let providerUpdate = Promise.resolve();
  const updateProvider = (id, profile) => {
    const update = providerUpdate.then(async () => {
      const next = { ...providerProfiles };
      if (profile) next[id] = profile;
      else delete next[id];
      await providerFiber.update({ providers: next });
      providerProfiles = next;
      providerUpdateCount += 1;
    });
    providerUpdate = update.catch(() => {});
    return update;
  };
  const router = new ChisaModelRouter(ctx);
  ctx.llm.registerAdapter(["chisabot"], router);
  const sessions = new Map();
  const pending = new Map();
  ctx.on("session/event", (session, event) => {
    if (event.type === "plugin:chisabot/privacy-gate") {
      router.markPrivacyBlocked(session.id);
    }
    const state = sessions.get(session.id);
    if (state) state.lastUsedAt = Date.now();
    if (
      state &&
      event.type === "user/message" &&
      event.data?.source?.kind === "user" &&
      typeof event.data.source.rpcId === "string"
    ) {
      state.seenRpcIds?.add(event.data.source.rpcId);
    }
    if (state && event.type === "turn/start") {
      state.phase = "model";
      state.currentTurn = event.data?.turn ?? state.currentTurn;
      state.inFlightTools?.clear();
    }
    if (event.type === "tool/call") {
      state?.calls.set(event.data.callId, { ...event.data, seq: event.seq });
      state?.toolTurns.add(event.data.turn);
      if (state) {
        state.phase = "tools";
        state.inFlightTools?.add(event.data.callId);
      }
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
      const finishedCallId = event.data.message?.toolCallId;
      if (finishedCallId) state.inFlightTools?.delete(finishedCallId);
      if ((state.inFlightTools?.size ?? 0) === 0 && state.phase === "tools")
        state.phase = "model";
    }
    if (state && event.type === "turn/end") {
      state.phase = "boundary";
      state.inFlightTools?.clear();
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

  const canEvictSession = (state) =>
    Boolean(
      state &&
        state.released === true &&
        !state.waiting &&
        state.handle?.agent?.status === "idle",
    );

  const evictSession = (sessionId, expectedState) =>
    serialized(sessionId, async () => {
      const current = sessions.get(sessionId);
      if (!current || (expectedState && current !== expectedState))
        return false;
      if (!canEvictSession(current)) return false;
      await ctx.sessions.flush(current.handle.agent.session);
      for (const dispose of current.disposers.splice(0)) await dispose();
      if (current.keyRef) ephemeralKeys.delete(current.keyRef);
      await current.routeFiber?.dispose();
      current.routeFiber = undefined;
      current.keyRef = undefined;
      current.providerId = undefined;
      current.connectionFingerprint = undefined;
      if (current.routeId) router.routes.delete(current.routeId);
      router.clearSession(sessionId);
      sessions.delete(sessionId);
      await current.handle.dispose();
      evictedSessionCount += 1;
      return true;
    });

  let sweeping = false;
  const sweepSessions = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const now = Date.now();
      if (sessionIdleTtlMs > 0) {
        for (const [sessionId, state] of [...sessions.entries()]) {
          if (
            canEvictSession(state) &&
            now - (state.lastUsedAt ?? 0) >= sessionIdleTtlMs
          ) {
            await evictSession(sessionId, state).catch(() => {});
          }
        }
      }
      if (maxIdleSessions > 0 && sessions.size > maxIdleSessions) {
        const candidates = [...sessions.entries()]
          .filter(([, state]) => canEvictSession(state))
          .sort(([, a], [, b]) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
        for (const [sessionId, state] of candidates) {
          if (sessions.size <= maxIdleSessions) break;
          await evictSession(sessionId, state).catch(() => {});
        }
      }
    } finally {
      sweeping = false;
    }
  };

  const sweepTimer =
    sessionIdleTtlMs > 0
      ? setInterval(
          () => {
            void sweepSessions().catch(() => {});
          },
          Math.min(60_000, Math.max(50, Math.floor(sessionIdleTtlMs / 2))),
        )
      : undefined;
  sweepTimer?.unref?.();

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
    state.phase = "boundary";
    state.inFlightTools = new Set();
    state.currentTurn = 0;
    state.steeringInstructions = [];
    state.toolTurns = new Set();
    state.nudgedTurns = new Set();
    state.leakNudgedTurns = new Set();
    state.activeAttemptStream = undefined;
    state.reply = undefined;
    // Bounds each turn's tool loop. Keep the same guard across rebinds of this run
    // (approval resume must not clear the per-turn counters — QA513 P3).
    ensureLoopGuard(state, loopLimits);
    state.disposers.push(
      agentCtx.on("agent/assistant-stream", ({ frame }) => {
        if (!frame || state.stopped) return;
        if (frame.type === "start") {
          state.activeAttemptStream = {
            attemptId: frame.attemptId,
            turn: frame.turn,
            step: frame.step,
            order: [],
            blocks: new Map(),
          };
          return;
        }
        if (
          frame.type === "chunk" &&
          state.activeAttemptStream?.attemptId === frame.attemptId
        ) {
          const chunk = frame.chunk;
          if (!chunk || typeof chunk !== "object") return;
          if (chunk.type === "block-start") {
            if (!state.activeAttemptStream.blocks.has(chunk.index)) {
              state.activeAttemptStream.order.push(chunk.index);
              state.activeAttemptStream.blocks.set(chunk.index, {
                type: chunk.blockType,
                text: "",
              });
            }
            return;
          }
          if (chunk.type === "text-delta") {
            let entry = state.activeAttemptStream.blocks.get(chunk.index);
            if (!entry) {
              state.activeAttemptStream.order.push(chunk.index);
              entry = { type: "text", text: "" };
              state.activeAttemptStream.blocks.set(chunk.index, entry);
            }
            if (entry.type === "text" && typeof chunk.text === "string") {
              entry.text += chunk.text;
            }
            return;
          }
          if (chunk.type === "block-end" && chunk.block?.type === "text") {
            let entry = state.activeAttemptStream.blocks.get(chunk.index);
            if (!entry) {
              state.activeAttemptStream.order.push(chunk.index);
              entry = { type: "text", text: "" };
              state.activeAttemptStream.blocks.set(chunk.index, entry);
            }
            if (typeof chunk.block.text === "string") {
              entry.text = chunk.block.text;
            }
            return;
          }
          return;
        }
        if (
          frame.type === "end" &&
          state.activeAttemptStream?.attemptId === frame.attemptId
        ) {
          state.activeAttemptStream = undefined;
        }
      }),
    );
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
            render: (_args, value) => {
              const textPart = {
                type: "text",
                text:
                  typeof value.content === "string"
                    ? value.content
                    : JSON.stringify(value),
              };
              return [
                textPart,
                ...(Array.isArray(value.imageParts) ? value.imageParts : []),
              ];
            },
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
            const rawImages = Array.isArray(result?.images)
              ? result.images
              : [];
            // 立即剥离网关返回的裸 base64 图片，防止写入 DSH 会话日志。
            const { images: _ignored, ...cleanResult } =
              result && typeof result === "object"
                ? result
                : { content: String(result ?? "") };
            const validImages = rawImages.filter(
              (img) =>
                img &&
                typeof img.mediaType === "string" &&
                typeof img.data === "string" &&
                img.data.length > 0,
            );
            let finalResult = cleanResult;
            if (validImages.length > 0) {
              const baseText =
                typeof cleanResult.content === "string"
                  ? cleanResult.content
                  : JSON.stringify(cleanResult);
              if (typeof ctx?.attachments?.admitPromptContent === "function") {
                try {
                  const admitted = await ctx.attachments.admitPromptContent(
                    validImages.map((img) => ({
                      type: "image",
                      mediaType: img.mediaType,
                      data: img.data,
                    })),
                  );
                  const imageParts = Array.isArray(admitted)
                    ? admitted.filter(
                        (part) =>
                          part && part.type === "image" && part.attachment,
                      )
                    : [];
                  if (imageParts.length > 0) {
                    finalResult = { ...cleanResult, imageParts };
                  }
                } catch (error) {
                  const detail =
                    error instanceof Error && error.message
                      ? `：${error.message}`
                      : "";
                  const notice = `[工具图片附件写入失败，已保留文本结果${detail}]`;
                  finalResult = {
                    ...cleanResult,
                    content: baseText ? `${baseText}\n${notice}` : notice,
                  };
                }
              } else {
                const notice = `[工具返回了 ${validImages.length} 张图片，当前运行时未启用附件存储，无法附带原图]`;
                finalResult = {
                  ...cleanResult,
                  content: baseText ? `${baseText}\n${notice}` : notice,
                };
              }
            }
            const outcome = state.loopGuard.observe({ result: finalResult });
            if (outcome?.stop) {
              if (state.loopConcluded !== call.turn) {
                state.loopConcluded = call.turn;
                appendPluginRecord(agent.session, "plugin:chisabot/loop-stop", {
                  turn: call.turn,
                  step: call.step,
                  reason: outcome.reason,
                  text: outcome.concludeText,
                });
              }
              execution.concludeTurn();
              return {
                content: outcome.concludeText,
                isError: true,
                stopped: true,
              };
            }
            const notices = [verdict.notice, outcome?.notice].filter(
              (item) => typeof item === "string" && item.length > 0,
            );
            if (notices.length > 0) {
              const baseText =
                typeof finalResult.content === "string"
                  ? finalResult.content
                  : JSON.stringify(finalResult);
              const joinedNotices = notices.join("\n");
              finalResult = {
                ...finalResult,
                content: baseText
                  ? `${baseText}\n\n[运行时提醒]\n${joinedNotices}`
                  : `[运行时提醒]\n${joinedNotices}`,
              };
            }
            return finalResult;
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
    // Promise without action & leaked tool-call tags: steer back first, abort cleanly if repeated.
    state.disposers.push(
      agentCtx.on("agent/turn-stopping", ({ turn, signal }) => {
        const reply = state.reply;
        if (
          signal?.aborted ||
          state.stopped ||
          state.waiting ||
          state.binding.tools.length === 0 ||
          state.loopGuard.isStopped(turn) ||
          reply?.turn !== turn ||
          reply.failed
        )
          return;
        const leak = detectLeakedToolCall(reply.text, state.binding.tools);
        if (leak) {
          if (!state.leakNudgedTurns.has(turn)) {
            state.leakNudgedTurns.add(turn);
            appendPluginRecord(
              agent.session,
              "plugin:chisabot/leaked-tool-call",
              {
                turn,
                marker: leak.marker,
                toolName: leak.toolName,
                action: "steer",
              },
            );
            agent.steer(
              createUserMessage({
                source: {
                  kind: "user",
                  rpcId: `chisabot:leak-nudge:${state.binding.runId}:${turn}`,
                },
                content: [{ type: "text", text: LEAKED_TOOL_CALL_NUDGE }],
              }),
            );
            return;
          }
          appendPluginRecord(
            agent.session,
            "plugin:chisabot/leaked-tool-call",
            {
              turn,
              marker: leak.marker,
              toolName: leak.toolName,
              action: "abort",
            },
          );
          if (state.loopConcluded !== turn) {
            state.loopConcluded = turn;
            appendPluginRecord(agent.session, "plugin:chisabot/loop-stop", {
              turn,
              reason: "leaked_tool_call",
              text: LEAKED_TOOL_CALL_ABORT_MESSAGE,
            });
          }
          return;
        }
        if (
          state.toolTurns.has(turn) ||
          state.nudgedTurns.has(turn) ||
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
      let routeId;
      let routeFiber;
      let keyRef;
      let providerId;
      let connectionFingerprint;
      let reusedProvider = false;
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
        connectionFingerprint = JSON.stringify({
          api: connection.api,
          baseURL: connection.baseURL,
          target: connection.target ?? null,
          models: connection.models,
          timeoutMs: connection.timeoutMs ?? 0,
          hasKey: Boolean(connection.apiKey),
          modelProxy: input.connection?.modelProxy === true,
        });
        if (
          state?.routeFiber &&
          state.providerId &&
          state.connectionFingerprint === connectionFingerprint &&
          (!connection.apiKey || state.keyRef)
        ) {
          reusedProvider = true;
          providerId = state.providerId;
          routeFiber = state.routeFiber;
          keyRef = state.keyRef;
          if (connection.apiKey && keyRef) {
            ephemeralKeys.set(keyRef, connection.apiKey);
          }
        } else {
          providerId = `chisabot-${randomUUID()}`;
          if (connection.apiKey) {
            keyRef = `CHISABOT_ROUTE_${randomUUID().replaceAll("-", "_")}`;
            ephemeralKeys.set(keyRef, connection.apiKey);
          }
          try {
            await updateProvider(providerId, {
              api: connection.api,
              baseURL: connection.baseURL,
              models: connection.models,
              ...(keyRef ? { apiKeyEnv: keyRef } : {}),
              // No implicit deadline in either HTTP setup or an idle response stream.
              // Explicit caller deadlines still apply; user stop propagates its signal.
              timeoutMs: connection.timeoutMs ?? 0,
              streamIdleTimeoutMs: 0,
            });
            const createdProviderId = providerId;
            routeFiber = {
              dispose: () => updateProvider(createdProviderId, undefined),
            };
          } catch (error) {
            if (keyRef) ephemeralKeys.delete(keyRef);
            throw error;
          }
        }
        // The provider id is per binding; the model breaker keys on the real endpoint and model
        // so a dead model stays skipped across turns, sessions and bots of this Host.
        for (const candidate of [
          binding.model.primary,
          ...(binding.model.fallbacks ?? []),
        ]) {
          candidate.breakerKey = `${connection.baseURL}\u0000${connection.target ?? ""}\u0000${candidate.model}`;
          candidate.provider = providerId;
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
          routeId =
            previousSelection === selection && previousRouteId
              ? previousRouteId
              : `route-${randomUUID()}`;
          for (const dispose of state.disposers.splice(0)) await dispose();
          if (!reusedProvider) {
            if (state.keyRef) ephemeralKeys.delete(state.keyRef);
            await state.routeFiber?.dispose();
          }
          router.routes.delete(state.routeId);
          state.binding = binding;
          state.stopped = false;
          state.released = false;
          state.lastUsedAt = Date.now();
          state.waiting = undefined;
          state.calls.clear();
          router.bind(routeId, binding.model, binding.runId);
          compose(state.handle.agent.ctx, state.handle.agent, state);
          state.handle.agent.model.select({
            provider: "chisabot",
            model: routeId,
          });
        } else {
          state = {
            binding,
            stopped: false,
            released: false,
            lastUsedAt: Date.now(),
            disposers: [],
            calls: new Map(),
            seenRpcIds: new Set(),
          };
          if (existing) {
            // Resume first to avoid double Zstd decompression of the persisted session file.
            // ReactLoopAgent stores agentOptions only as a fallback when no selection is recorded,
            // so omitting provider/model here neither appends model/selection nor triggers compaction.
            state.handle = await ctx.agents.resume({
              resumeSessionId: binding.sessionId,
              agentOptions: {},
              setup: (agentCtx, agent) => compose(agentCtx, agent, state),
            });
            const saved = findLastModelBinding(
              state.handle.agent.session.snapshotEvents(),
            );
            if (
              saved &&
              typeof saved.selection === "string" &&
              typeof saved.routeId === "string"
            ) {
              previousSelection = saved.selection;
              previousRouteId = saved.routeId;
            }
            routeId =
              previousSelection === selection && previousRouteId
                ? previousRouteId
                : `route-${randomUUID()}`;
            router.bind(routeId, binding.model, binding.runId);
          } else {
            routeId = `route-${randomUUID()}`;
            router.bind(routeId, binding.model, binding.runId);
            state.handle = await ctx.agents.create({
              sessionId: binding.sessionId,
              meta: { cwd: join(config.home, "workspace") },
              agentOptions: { provider: "chisabot", model: routeId },
              setup: (agentCtx, agent) => compose(agentCtx, agent, state),
            });
          }
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
        state.providerId = providerId;
        state.connectionFingerprint = connectionFingerprint;
        state.modelProxy = input.connection?.modelProxy === true;
        state.released = false;
        state.lastUsedAt = Date.now();
        await ctx.sessions.flush(state.handle.agent.session);
        if (maxIdleSessions > 0 && sessions.size > maxIdleSessions) {
          void sweepSessions().catch(() => {});
        }
        return {
          sessionId: binding.sessionId,
          generation,
          revision: binding.revision,
        };
      } catch (error) {
        for (const dispose of state?.disposers.splice(0) ?? []) await dispose();
        await state?.handle?.dispose();
        sessions.delete(binding.sessionId);
        if (routeId) router.routes.delete(routeId);
        router.clearSession(binding.sessionId);
        if (keyRef) ephemeralKeys.delete(keyRef);
        await routeFiber?.dispose();
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
            return Response.json(
              await handler(await request.json(), request.signal),
            );
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
        ephemeralKeys.set(state.keyRef, state.binding.toolCapability);
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
      let accepted =
        state.handle.agent.inbox.nextTurn.some(sourceMatches) ||
        state.handle.agent.inbox.nextStep.some(sourceMatches) ||
        Boolean(state.seenRpcIds?.has(input.requestId));
      if (!accepted) {
        const events = state.handle.agent.session.snapshotEvents();
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const event = events[i];
          if (event?.type === "user/message" && sourceMatches(event.data)) {
            accepted = true;
            state.seenRpcIds?.add(input.requestId);
            break;
          }
        }
      }
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
  function extractAttemptPlainText(attemptStream) {
    if (!attemptStream || !Array.isArray(attemptStream.order)) return "";
    const parts = [];
    for (const index of attemptStream.order) {
      const block = attemptStream.blocks.get(index);
      if (
        block?.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0
      ) {
        parts.push(block.text);
      }
    }
    return parts.join("");
  }

  function applySteerDecision(state, agent, item, requestId) {
    const inFlight = state.inFlightTools?.size ?? 0;
    if (
      !state.waiting &&
      state.phase === "model" &&
      inFlight === 0 &&
      agent.status === "running"
    ) {
      const partialText = extractAttemptPlainText(state.activeAttemptStream);
      if (partialText.trim().length > 0) {
        appendPluginRecord(agent.session, "plugin:chisabot/steer-partial", {
          turn: state.activeAttemptStream?.turn ?? state.currentTurn,
          step: state.activeAttemptStream?.step,
          attemptId: state.activeAttemptStream?.attemptId,
          requestId,
          text: partialText,
        });
      }
      agent.inbox.remove(item.id);
      agent.cancel({ kind: "hook", reason: STEER_CUT }, { keepInbox: true });
      agent.followup(item);
      if (
        agent.inbox.nextTurn.length > 1 &&
        agent.inbox.nextTurn[0]?.id !== item.id
      ) {
        agent.inbox.remove(item.id);
        agent.inbox.prepend("next-turn", item);
      }
      return { action: "cut", flush: true };
    }
    if (state.phase === "tools" || inFlight > 0) {
      if (agent.inbox.nextTurn.some((entry) => entry.id === item.id)) {
        agent.inbox.remove(item.id);
        agent.steer(item);
      }
      void invokeGateway(
        state,
        "steer-signal",
        {
          sessionId: state.binding.sessionId,
          runId: state.binding.runId,
          requestId,
          phase: "tools",
        },
        AbortSignal.timeout(3_000),
      ).catch(() => {});
      return {
        action: "next-step",
        flush: false,
        inFlightTools: [...(state.inFlightTools ?? [])],
      };
    }
    if (
      agent.status === "running" &&
      !state.waiting &&
      agent.inbox.nextTurn.some((entry) => entry.id === item.id)
    ) {
      agent.inbox.remove(item.id);
      agent.steer(item);
    }
    return { action: "queued", flush: false };
  }

  route("steer", (input, signal) =>
    serialized(requiredText(input.sessionId, "sessionId"), async () => {
      const state = sessions.get(input.sessionId);
      if (!state || state.binding.runId !== input.runId)
        throw new Error("The requested run does not own this session.");
      if (state.stopped) throw new Error("This run was stopped.");
      const requestId = requiredText(input.requestId, "requestId");
      const content = Array.isArray(input.content) ? input.content : [];
      if (content.length === 0) throw new Error("Steer content is required.");
      const instructions = Array.isArray(input.instructions)
        ? input.instructions.filter(
            (text) => typeof text === "string" && text.trim().length > 0,
          )
        : [];
      if (instructions.length > 0) {
        state.steeringInstructions.push(...instructions);
      }
      const agent = state.handle.agent;
      const inFlight = state.inFlightTools?.size ?? 0;
      const mode =
        state.phase === "model" && inFlight === 0
          ? "queue"
          : agent.status === "running" && !state.waiting
            ? "steer"
            : "queue";
      await ctx.sessionController.prompt(
        {
          sessionId: input.sessionId,
          requestId,
          mode,
          content,
        },
        signal ?? new AbortController().signal,
      );
      const item =
        agent.inbox.nextTurn.find(
          (msg) =>
            msg.source?.kind === "user" && msg.source.rpcId === requestId,
        ) ??
        agent.inbox.nextStep.find(
          (msg) =>
            msg.source?.kind === "user" && msg.source.rpcId === requestId,
        );
      if (!item) {
        return {
          accepted: true,
          action:
            state.phase === "tools" || inFlight > 0 ? "next-step" : "queued",
          phase: state.phase ?? "boundary",
          ...(inFlight > 0
            ? { inFlightTools: [...(state.inFlightTools ?? [])] }
            : {}),
        };
      }
      const decision = applySteerDecision(state, agent, item, requestId);
      if (decision.flush) await ctx.sessions.flush(agent.session);
      return {
        accepted: true,
        action: decision.action,
        phase: state.phase ?? "boundary",
        ...(decision.inFlightTools
          ? { inFlightTools: decision.inFlightTools }
          : {}),
      };
    }),
  );
  route("update-queue", (input) =>
    serialized(requiredText(input.sessionId, "sessionId"), async () => {
      const state = sessions.get(input.sessionId);
      if (!state || state.binding.runId !== input.runId)
        throw new Error("The requested run does not own this session.");
      const itemId = requiredText(input.itemId, "itemId");
      const agent = state.handle.agent;
      const pendingItem =
        agent.inbox.nextTurn.find(
          (msg) =>
            msg.id === itemId ||
            (msg.source?.kind === "user" && msg.source.rpcId === itemId),
        ) ??
        agent.inbox.nextStep.find(
          (msg) =>
            msg.id === itemId ||
            (msg.source?.kind === "user" && msg.source.rpcId === itemId),
        );
      if (!pendingItem) return { accepted: false };
      if (input.action?.kind === "steer") {
        if (state.stopped) throw new Error("This run was stopped.");
        const rpcId =
          pendingItem.source?.kind === "user" &&
          typeof pendingItem.source.rpcId === "string"
            ? pendingItem.source.rpcId
            : itemId;
        const decision = applySteerDecision(state, agent, pendingItem, rpcId);
        if (decision.flush) await ctx.sessions.flush(agent.session);
        return {
          accepted: true,
          action: decision.action,
          phase: state.phase ?? "boundary",
        };
      }
      await ctx.sessionController.updateQueue({
        sessionId: input.sessionId,
        itemId: pendingItem.id,
        action: input.action,
      });
      return { accepted: true };
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
      // Immediately purge the turn's secret from memory while keeping the non-secret provider
      // slot registered for reuse on the next turn (zero disk writes, zero Fiber churn).
      if (state.keyRef) ephemeralKeys.delete(state.keyRef);
      delete state.binding.toolCapability;
      router.routes.delete(state.routeId);
      state.released = true;
      state.lastUsedAt = Date.now();
      if (maxIdleSessions > 0 && sessions.size > maxIdleSessions) {
        void sweepSessions().catch(() => {});
      }
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
          stats: {
            providerUpdates: providerUpdateCount,
            evictedSessions: evictedSessionCount,
            ephemeralKeys: ephemeralKeys.size,
          },
          sessions: [...sessions.values()].map((x) => ({
            sessionId: x.binding.sessionId,
            runId: x.binding.runId,
            state: x.handle.agent.status,
            phase: x.phase ?? "boundary",
            inFlightTools: x.inFlightTools?.size ?? 0,
            stopped: x.stopped,
            ...(x.waiting ? { waiting: x.waiting } : {}),
          })),
        }),
    }),
  );
  ctx.on("dispose", async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    ephemeralKeys.clear();
    await Promise.allSettled(
      [...sessions.values()].map((state) => state.handle.dispose()),
    );
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
