import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { defaultCapabilities } from "../../shared/devices";
import { createDatabase } from "../src/db/client";
import { agents, agentProfiles, users } from "../src/db/schema";
import { createLocalConversations } from "../src/local-conversations";
import { createConversationBindings } from "../src/conversations/bindings";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import {
  DshRuntimeAgent,
  type DshRuntimeBinding,
} from "../src/agents/dsh-runtime";
import { createTurnRunner } from "../src/turns/run-turn";
import type { TurnRunner } from "../src/turns/types";
import { createHandoffDesk } from "../src/agents/handoff";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { createHandoffDelivery } from "../src/agents/handoff-delivery";
import {
  bindHandoffExecution,
  refreshApprovedHandoffRun,
  signHandoffDeliveryRun,
} from "../src/agents/handoff-signing";
import {
  authoriseCoordinationRun,
  createCoordinationTools,
  readCoordinationHandoffClaim,
} from "../src/agents/handoff-tool";
import {
  mintRunAssertion,
  readRunAssertion,
  type RunAssertion,
} from "../src/agents/callback-token";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { computerAccessCheck } from "../src/agents/computer-access";
import { createAuditStore, type AuditInitiator } from "../src/audit";
import { currentApprovalContext } from "../src/approvals/types";
import { createWorkQueue } from "../src/work/queue";
import { createTeamBots } from "../src/team-bots/team-bots";
import { createLocalAgentService } from "../src/local-agents/service";
import { createDeviceHub } from "../src/devices/hub";
import type { DeviceRecord } from "../src/devices/store";
import {
  buildAgents,
  currentAgentKernel,
  mountConversationRuntime,
  setAgentKernel,
} from "../src/conversation-runtime";
import { withRuntimeSurfaceTools } from "../src/agents/runtime-tool-context";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";
import { createHandoffExecutions } from "../src/agents/handoff-execution";
import { createConfirmations, digestOf } from "../src/confirmations/service";
import { createConfirmationResumer } from "../src/conversations/confirmation-resume";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
const key = "isolated-actor-acceptance-signing-key";
async function until<T>(
  read: () => Promise<T | null | false | undefined>,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error("Actor acceptance did not settle.");
    await Bun.sleep(40);
  }
}

(address ? describe : describe.skip)(
  "DSH actor paths through PostgreSQL, Host and governed tools",
  () => {
    const actor = `actor-${randomUUID()}`,
      publisher = `${actor}-publisher`;
    const asker = `${actor}-asker`,
      target = `${actor}-target`,
      source = `${actor}-source`;
    const cleanups: (() => unknown | Promise<unknown>)[] = [];
    const stages: { tool?: string; args?: unknown; answer: string }[] = [];
    const probes: {
      botId: string;
      actorId: string;
      threadId?: string;
      initiator?: AuditInitiator;
    }[] = [];
    const built: {
      actorId: string;
      botId: string;
      initiator?: AuditInitiator;
      depth?: number;
    }[] = [];
    let database: ReturnType<typeof createDatabase>;
    let backend: Awaited<ReturnType<typeof createLocalConversations>>;
    let profiles: ReturnType<typeof createAgentProfileStore>;
    let coordination: ReturnType<typeof createCoordinationTools>;
    let queue: ReturnType<typeof createWorkQueue>;
    let handoffs: ReturnType<typeof createHandoffRunner>;
    let runTurn: TurnRunner;
    let localAgents: ReturnType<typeof createLocalAgentService>;
    let build: (input: {
      actorId: string;
      botId: string;
      initiator?: AuditInitiator;
      depth?: number;
    }) => Promise<DshRuntimeAgent>;
    let device: DeviceRecord;
    let connection: ReturnType<ReturnType<typeof createDeviceHub>["attach"]>;
    const sent: Record<string, any>[] = [];
    let teamBot = "";
    let teamBots: ReturnType<typeof createTeamBots>;
    const teamResults: {
      actor: string;
      computer: boolean;
      sharedCredential: string;
      personalCredential: string;
      initiator?: AuditInitiator;
    }[] = [];
    let requests = 0;
    const providerBodies: any[] = [];
    let selectionBinding: DshRuntimeBinding;
    let selectionModelUrl = "";
    let confirmations: ReturnType<typeof createConfirmations>;
    let approval: any;
    let effects = 0;
    let resumedCoordination = false;
    let restartHost: () => Promise<void>;
    let makeHandoffs: (
      afterDelivery?: () => void,
    ) => ReturnType<typeof createHandoffRunner>;

    beforeAll(async () => {
      database = createDatabase(address!, { max: 6 });
      cleanups.push(() => database.$client.close());
      backend = await createLocalConversations(database);
      confirmations = createConfirmations(database);
      await confirmations.ensure();
      confirmations.setOnOpened((value) => {
        approval = value;
      });
      await backend.client.getOrCreateThread({
        threadId: source,
        userId: actor,
        agentId: asker,
      });
      const bindings = createConversationBindings(database),
        operations = createToolOperationStore(database),
        journal = createDshRunJournal(database);
      await bindings.ensure();
      await operations.ensure();
      const gateway = createDshToolGateway(operations, journal);
      profiles = createAgentProfileStore(
        database,
        new URL("https://isolated.example.test/ag-ui"),
      );
      await database.insert(users).values(
        [actor, publisher].map((id) => ({
          id,
          name: id,
          email: `${id}@example.test`,
        })),
      );
      for (const [id, name] of [
        [asker, "Actor Asker"],
        [target, "Actor Target"],
      ] as const) {
        await database
          .insert(agents)
          .values({ id, name, type: "built_in", configuration: {} });
        await database.insert(agentProfiles).values({
          agentId: id,
          name,
          title: "Acceptance",
          roleDescription: "Check delegation ownership",
          avatarSeed: id,
          visibility: "private",
          ownerUserId: actor,
        });
      }
      const auditStore = createAuditStore(database);
      queue = createWorkQueue(database);
      const desk = createHandoffDesk({
        queue,
        profiles,
        actorFor: async (id) => ({ id, role: "user" }),
        mayAddress: async (from, to) => from === asker && to === target,
        auditStore,
        caps: { maxDepth: 2, maxPerRun: 2 },
      });
      coordination = createCoordinationTools({
        desk,
        auditStore,
        caps: { maxDepth: 2, maxPerRun: 2 },
        botsReachableFrom: async (id) => (id === asker ? [target] : []),
        route: async () => ({ reached: "isolated" }),
        authoriseRun: (run) =>
          authoriseCoordinationRun(run, {
            canUseBot: async (scope) =>
              Boolean(
                await profiles.get(
                  { id: scope.actorId, role: "user" },
                  scope.botId,
                ),
              ),
            sourceThread: async (scope) =>
              scope.actorId === actor && scope.threadId === source
                ? { botId: asker }
                : null,
            delegationFor: (claim, run) =>
              readCoordinationHandoffClaim(database, claim, run),
          }),
      });
      teamBots = createTeamBots({
        database,
        connectedServers: async (id) =>
          new Set(
            id === publisher ? ["shared"] : id === actor ? ["personal"] : [],
          ),
      });
      const runtime = resolve("runtime/dsh");
      await mkdir(join(runtime, ".runtime"), { recursive: true });
      const home = await mkdtemp(join(runtime, ".runtime", "actor-"));
      const bridge = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          if (!new URL(request.url).pathname.startsWith("/v1/"))
            return gateway.routes.fetch(request);
          requests++;
          const body = (await request.json()) as any;
          providerBodies.push(body);
          const stage = stages[0];
          if (!stage)
            throw new Error(
              "Unexpected model execution after the accepted stages.",
            );
          const lastUser = body.messages.findLastIndex(
            (message: any) => message.role === "user",
          );
          const result = body.messages
            .slice(lastUser + 1)
            .some((message: any) => message.role === "tool");
          const callsTool = Boolean(stage.tool && !result);
          const delta = callsTool
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests}`,
                    type: "function",
                    function: {
                      name: stage.tool,
                      arguments: JSON.stringify(stage.args ?? {}),
                    },
                  },
                ],
              }
            : { role: "assistant", content: stage.answer };
          if (!callsTool) stages.shift();
          const frame = (delta: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: "actor", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          return new Response(
            frame(delta, null) +
              frame({}, callsTool ? "tool_calls" : "stop") +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      cleanups.push(() => bridge.stop(true));
      selectionModelUrl = `${bridge.url.origin}/v1`;
      selectionBinding = {
        bindings,
        journal,
        gateway,
        toolGatewayUrl: bridge.url.origin,
        targetFor: async (owner) => ({
          id: "actor-host",
          ownerUserId: owner,
          connectionFile: join(home, "connection.json"),
        }),
        readRun: (value) => readRunAssertion(value, key),
      };
      await writeFile(
        join(home, "chisabot.json"),
        JSON.stringify({
          ownerUserId: actor,
          port: 0,
          providers: {},
          gatewayUrl: bridge.url.origin,
        }),
      );
      const launch = () =>
        spawn("node", ["src/start.mjs"], {
          cwd: runtime,
          env: { ...process.env, CHISABOT_DSH_HOME: home },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      let host = launch();
      let output = "";
      const ready = async () => {
        host.stdout.on("data", (data) => (output += data));
        host.stderr.on("data", (data) => (output += data));
        await until(async () => {
          if (host.exitCode !== null) throw new Error(output);
          return output.includes("chisabot-runtime-ready");
        }, 60_000);
      };
      restartHost = async () => {
        const done = once(host, "exit");
        host.kill("SIGKILL");
        await done;
        output = "";
        host = launch();
        await ready();
      };
      cleanups.push(async () => {
        if (host.exitCode === null) {
          const done = once(host, "exit");
          host.kill();
          await done;
        }
      });
      await ready();
      build = async (input) => {
        built.push(input);
        if (
          !(await profiles.get(
            { id: input.actorId, role: "user" },
            input.botId,
          ))
        )
          throw new Error("Bot is not visible to the actual actor.");
        return new DshRuntimeAgent({
          botId: input.botId,
          binding: {
            bindings,
            journal,
            gateway,
            toolGatewayUrl: bridge.url.origin,
            targetFor: async (owner) => ({
              id: "actor-host",
              ownerUserId: owner,
              connectionFile: join(home, "connection.json"),
            }),
            readRun: (value) => readRunAssertion(value, key),
          },
          signRun: (value) => {
            const execution = {
              actorId: input.actorId,
              botId: input.botId,
              runId: value.runId,
              threadId: value.threadId,
            };
            const previous = readRunAssertion(
              value.forwardedProps?.chisabotRun,
              key,
            );
            return previous?.handoff
              ? bindHandoffExecution(previous, execution, key)
              : mintRunAssertion(
                  {
                    ...execution,
                    initiator: input.initiator,
                    depth: input.depth,
                  },
                  key,
                );
          },
          tools: [
            {
              name: "handoff_approved_effect",
              ref: "test/approved",
              description: "Record one effect after permission.",
              parameters: z.object({}),
              execute: async (args) => {
                const decision = await confirmations.check({
                  ownerUserId: input.actorId,
                  agentId: input.botId,
                  category: "message",
                  tool: "handoff_approved_effect",
                  title: "Approve handoff effect",
                  target: "isolated fixture",
                  matchText: "fixture",
                  digest: digestOf("handoff_approved_effect", args),
                });
                if (!decision.ok) return decision.message;
                const scope = readRunAssertion(
                  currentApprovalContext()?.forwardedProps?.chisabotRun,
                  key,
                )!;
                resumedCoordination = (
                  await coordination.toolsForRun(scope)
                ).some((tool) => tool.name === "ask_person");
                effects++;
                return "Effect recorded once.";
              },
            },
            {
              name: "actor_probe",
              ref: "test/actor",
              description: "Record the current governed actor context.",
              parameters: z.object({}),
              execute: async () => {
                const context = currentApprovalContext();
                probes.push({
                  ...input,
                  threadId: context?.threadId,
                  initiator: context?.initiator,
                });
                return "Actor context recorded.";
              },
            },
            {
              name: "team_authority_probe",
              ref: "test/team",
              description:
                "Check Team Bot permissions through the production authority services.",
              parameters: z.object({}),
              execute: async () => {
                const credentials = teamBots.credentialActorFor(
                  input.actorId,
                  input.botId,
                );
                let personalCredential: string;
                try {
                  personalCredential = await credentials("personal/read");
                } catch (error) {
                  personalCredential = (error as Error).message;
                }
                teamResults.push({
                  actor: input.actorId,
                  computer: await computerAccessCheck(profiles)(
                    { id: input.actorId, role: "user" },
                    input.botId,
                  ),
                  sharedCredential: await credentials("shared/read"),
                  personalCredential,
                  initiator: currentApprovalContext()?.initiator,
                });
                return "Team authority recorded.";
              },
            },
          ],
          toolsFor: async (value) => {
            const signed = readRunAssertion(
              value.forwardedProps?.chisabotRun,
              key,
            );
            const scope: RunAssertion = signed?.handoff
              ? signed
              : {
                  actorId: input.actorId,
                  botId: input.botId,
                  runId: value.runId,
                  threadId: value.threadId,
                  initiator: input.initiator,
                  depth: input.depth,
                };
            const tools = await coordination.toolsForRun(scope);
            const own =
              (
                await profiles.get(
                  { id: input.actorId, role: "user" },
                  input.botId,
                )
              )?.ownerUserId === input.actorId;
            return [
              ...tools,
              ...(localAgents && own
                ? await localAgents.tools({
                    ownerUserId: input.actorId,
                    botId: input.botId,
                    botName: "Acceptance",
                    threadId: value.threadId,
                  })
                : []),
            ];
          },
          prompt: () =>
            "Follow the acceptance task and then report its result.",
          connection: {
            provider: "openai",
            baseUrl: `${bridge.url.origin}/v1`,
            apiKey: null,
            useApiKey: false,
            model: "actor",
          },
          modelInfo: async () => ({
            contextWindow: 32000,
            maxOutputTokens: 1024,
          }),
          fallbacks: async () => [],
        });
      };
      runTurn = createTurnRunner({
        intelligence: backend.client,
        runner: backend.runner,
        buildAgentFor: (input) =>
          build({
            actorId: input.ownerUserId,
            botId: input.agentId,
            initiator: input.initiator,
            depth: input.depth,
          }),
      });
      const mounted = mountConversationRuntime(
        loadConfig(testEnvironment({ CONVERSATION_BACKEND: "local" })),
        {
          resolveAgentsForActor: async () => ({}),
          resolveAgentForActor: (person, botId, context) =>
            build({ actorId: person.id, botId, ...context }),
        },
        async () => actor,
        async () => ({ id: actor, role: "user" }),
        { localBackend: backend },
      );
      const actualDelivery = createHandoffDelivery({
        agentFor: ({ actorId, botId, initiator, depth }) =>
          mounted.agentFor({
            actor: { id: actorId, role: "user" },
            botId,
            initiator,
            depth,
          }),
        history: mounted.history,
        runner: mounted.runner as never,
        lock: mounted.threadLock,
        newRunId: randomUUID,
        mintThreadId: () => `${actor}-scratch-${randomUUID()}`,
      });
      makeHandoffs = (afterDelivery) =>
        createHandoffRunner({
          queue,
          auditStore,
          owner: `${actor}-handoff-${randomUUID()}`,
          executions: createHandoffExecutions(
            database,
            () => `${actor}-scratch-${randomUUID()}`,
            (value) =>
              readRunAssertion(value, key, Date.now(), { ignoreExpiry: true }),
          ),
          sign: (work, claim) =>
            signHandoffDeliveryRun(work, key, undefined, claim),
          delivery: {
            deliver: async (input) => {
              const result = await actualDelivery.deliver(input);
              afterDelivery?.();
              return result;
            },
          },
        });
      handoffs = makeHandoffs();
      device = {
        id: `${actor}-device`,
        ownerUserId: actor,
        name: "Protocol device",
        platform: "linux",
        osVersion: null,
        hostname: "fixture",
        arch: "x64",
        clientVersion: "test",
        capabilities: {
          ...defaultCapabilities(),
          shell: "allow",
          files_read: "allow",
          files_write: "allow",
        },
        allowedRoots: ["/workspace"],
        paused: false,
        revoked: false,
        lastSeenAt: null,
        lastIp: null,
        createdAt: new Date().toISOString(),
        botIds: [],
        lastUsedBy: null,
        tokenHash: "fixture",
      };
      const store = {
        get: async (id: string) => (id === device.id ? device : null),
        forOwner: async (id: string) => (id === actor ? [device] : []),
        audit: async () => randomUUID(),
        touch: async () => {},
        update: async () => device,
        finishAudit: async () => {},
      };
      const hub = createDeviceHub({
        store: store as never,
        approvalTtlMs: 5000,
      });
      localAgents = createLocalAgentService({
        database,
        hub,
        deviceStore: store as never,
        inbox: backend.inbox,
        control: backend.control,
        deliverTurn: runTurn,
        agentOfThread: async () => asker,
      });
      await localAgents.ensure();
      hub.setExtension(localAgents.extension);
      connection = hub.attach(
        device,
        {
          send: (data) => {
            const frame = JSON.parse(data);
            sent.push(frame);
            if (frame.type === "approval_request")
              setTimeout(() => {
                hub.decide(frame.id, true, "web");
              }, 5);
          },
          close() {},
        },
        null,
      );
      await connection.onMessage(
        JSON.stringify({
          type: "agents_detected",
          detection: {
            agents: [
              { kind: "claude", version: "fixture", path: "/fixture/claude" },
            ],
            sandboxes: { git: true, worktree: true },
            platform: "linux",
          },
        }),
      );
    }, 90_000);
    afterAll(async () => {
      if (database)
        await database.$client.unsafe(
          "DELETE FROM work_items WHERE payload->>'actorId'=$1",
          [actor],
        );
      for (const cleanup of cleanups.reverse()) await cleanup();
    }, 30_000);

    test("DSH preserves skill tool selection through buildAgents and clone, including approval recovery", async () => {
      const kernelBefore = currentAgentKernel();
      const catalog = Array.from({ length: 16 }, (_, index) => ({
        name: `selection_${index}`,
        ref: `fixture/tool_${index}`,
        description: `Selection fixture ${index}`,
        parameters: z.object({}),
        execute: async () => "read",
      }));
      let selectedEffect = 0;
      const pendingTool = {
        ...catalog[8]!,
        execute: async (args: unknown) => {
          const result = await confirmations.check({
            ownerUserId: actor,
            agentId: asker,
            category: "message",
            tool: "selection_8",
            title: "Approve selected effect",
            target: "isolated fixture",
            matchText: "selected",
            digest: digestOf("selection_8", args),
          });
          if (!result.ok) return result.message;
          selectedEffect++;
          return "Selected effect finished once.";
        },
      };
      catalog[8] = pendingTool;
      const granted = [
        ...catalog,
        {
          ...catalog[0]!,
          name: "selection_unclaimed",
          ref: "fixture/unclaimed",
        },
      ];
      const skills = [
        {
          slug: "read",
          title: "Read",
          summary: "Read fixtures",
          tools: catalog.slice(0, 2).map((tool) => tool.ref),
        },
        {
          slug: "change",
          title: "Change",
          summary: "Change fixtures",
          tools: catalog.slice(2).map((tool) => tool.ref),
        },
      ];
      let choice: "read" | "change" | "unavailable" = "read";
      const selected: { reason: string; offered: { name: string }[] }[] = [];
      let selectorCalls = 0;
      const construct = async () => {
        const map = await buildAgents(
          [
            {
              id: asker,
              name: "Selection acceptance",
              type: "built_in",
              systemPrompt: "Complete the requested fixture task.",
            },
          ],
          {
            provider: "openai",
            defaultModel: "actor",
            baseUrl: selectionModelUrl,
            useApiKey: false,
          },
          null,
          undefined,
          async () => granted,
          (botId, runId, threadId) =>
            mintRunAssertion({ actorId: actor, botId, runId, threadId }, key),
          undefined,
          undefined,
          {
            loadSkills: async () => skills,
            choose: async () => {
              selectorCalls++;
              if (choice === "unavailable")
                throw new Error("Selector unavailable");
              return JSON.stringify({ skills: [choice] });
            },
            record: async (_bot, result) => {
              selected.push(result);
            },
          },
          undefined,
          async () => [
            {
              ...catalog[0]!,
              name: "selection_handoff",
              ref: "fixture/handoff",
            },
          ],
        );
        return map[asker]!.clone();
      };
      const names = (body: any) =>
        body.tools.map((tool: any) => tool.function.name).sort();
      const execute = async (threadId: string, instruction: string) =>
        withRuntimeSurfaceTools(
          [
            {
              definition: {
                name: "selection_surface",
                description: "Surface fixture",
                parameters: { type: "object", properties: {} },
              },
              execute: async () => "surface",
            },
          ],
          () =>
            createTurnRunner({
              intelligence: backend.client,
              runner: backend.runner,
              buildAgentFor: construct,
            })({
              ownerUserId: actor,
              agentId: asker,
              threadId,
              routineId: "selection",
              instruction,
            }),
        );
      try {
        setAgentKernel({ kind: "dsh", binding: selectionBinding });
        const before = providerBodies.length;
        stages.push({
          tool: "selection_0",
          answer: "Selected tools completed.",
        });
        await execute(`${actor}-selection`, "Read fixture documents.");
        expect(names(providerBodies[before])).toEqual([
          "selection_0",
          "selection_1",
          "selection_handoff",
          "selection_surface",
          "selection_unclaimed",
        ]);
        expect(selected.at(-1)?.reason).toBe("selected");
        expect(selectorCalls).toBe(1);
        choice = "unavailable";
        const [accepted] = await database.$client.unsafe(
          "SELECT input FROM chisabot_dsh_runs WHERE thread_id=$1",
          [`${actor}-selection`],
        );
        const recovered = await construct();
        const callsBeforeReattach = requests;
        const errors: unknown[] = [];
        await new Promise<void>((resolve, reject) =>
          recovered.run(accepted.input).subscribe({
            next: (event) => {
              if (event.type === "RUN_ERROR") errors.push(event);
            },
            error: reject,
            complete: resolve,
          }),
        );
        expect(errors).toEqual([]);
        expect(selectorCalls).toBe(1);
        expect(requests).toBe(callsBeforeReattach);
        const fallbackAt = providerBodies.length;
        stages.push({ answer: "Fallback kept authorized tools." });
        await execute(
          `${actor}-selection-fallback`,
          "Read fixture documents again.",
        );
        expect(names(providerBodies[fallbackAt])).toEqual(
          [
            ...granted.map((tool) => tool.name),
            "selection_handoff",
            "selection_surface",
          ].sort(),
        );
        expect(selected.at(-1)?.reason).toBe("unavailable");

        choice = "change";
        let selectedApproval: any;
        confirmations.setOnOpened((value) => {
          selectedApproval = value;
        });
        stages.push({ tool: "selection_8", answer: "Awaiting decision." });
        await expect(
          execute(
            `${actor}-selection-approval`,
            "Change fixture after approval.",
          ),
        ).rejects.toThrow();
        expect(selectedApproval).toBeTruthy();
        expect(selectedEffect).toBe(0);
        choice = "read"; // The next relevance result excludes the saved operation.
        stages.shift();
        stages.push({ answer: "Approved selected effect completed." });
        await confirmations.decide(actor, selectedApproval.id, "approve");
        const resumer = createConfirmationResumer({
          database,
          backend,
          confirmations,
          buildAgentFor: construct,
          runTurn: createTurnRunner({
            intelligence: backend.client,
            runner: backend.runner,
            buildAgentFor: construct,
          }),
        });
        await resumer(actor, selectedApproval.id);
        expect(selectedEffect).toBe(1);
        expect(
          selected
            .at(-1)
            ?.offered.map((tool) => tool.name)
            .sort(),
        ).toEqual(["selection_0", "selection_1", "selection_unclaimed"]);
        expect(selectorCalls).toBe(4); // Three initial runs and one continuation, never resumeConfirmation.
        expect(stages).toHaveLength(0);
      } finally {
        setAgentKernel(kernelBefore);
      }
    }, 60_000);

    test("message_bot executes the addressed Bot and returns once with the original actor and initiator", async () => {
      const initiator = { kind: "routine" as const, id: `${actor}-schedule` };
      stages.push(
        {
          tool: "message_bot",
          args: { bot: target, task: "Check actor context" },
          answer: "已交给目标 Bot。",
        },
        { tool: "actor_probe", answer: "目标 Bot 已完成。" },
        { answer: "目标 Bot 的结果已回到原对话。" },
      );
      await runTurn({
        ownerUserId: actor,
        agentId: asker,
        threadId: source,
        routineId: initiator.id,
        initiator,
        instruction: "Ask the target Bot to check context.",
      });
      expect((await handoffs.sweep()).delivered).toEqual([target]);
      expect((await handoffs.sweep()).delivered).toEqual([asker]);
      expect(probes).toHaveLength(1);
      expect(probes[0]).toMatchObject({
        botId: target,
        actorId: actor,
        initiator,
      });
      expect(probes[0]!.threadId).not.toBe(source);
      expect(built.find((value) => value.botId === target)).toMatchObject({
        actorId: actor,
        initiator,
        depth: 1,
      });
      const rows = await database.$client.unsafe<
        { owner_user_id: string; agent_id: string; messages: any[] }[]
      >(
        "SELECT owner_user_id,agent_id,messages FROM chisabot_local_threads WHERE id=$1",
        [probes[0]!.threadId!],
      );
      expect(rows[0]).toMatchObject({ owner_user_id: actor, agent_id: target });
      const history = (
        await backend.client.getThreadMessages({
          threadId: source,
          userId: actor,
        })
      ).messages;
      expect(
        history.filter(
          (message) => message.content === "目标 Bot 的结果已回到原对话。",
        ),
      ).toHaveLength(1);
      const before = requests;
      expect((await handoffs.sweep()).delivered).toEqual([]);
      expect(requests).toBe(before);
      expect(stages).toHaveLength(0);
    }, 60_000);

    test("handoff approval survives Host loss and queue reconstruction without finishing or reissuing the effect", async () => {
      const item = `${actor}-approval-hop`;
      await queue.offer({
        kind: "bot.message",
        key: item,
        payload: {
          fromBotId: asker,
          toBotId: target,
          actorId: actor,
          threadId: source,
          runId: `${item}-source`,
          depth: 1,
          initiator: { kind: "routine", id: item },
          task: "Perform the approved effect",
        },
      });
      stages.push({
        tool: "handoff_approved_effect",
        answer: "Approved target finished.",
      });
      const pending = await handoffs.sweep();
      expect(pending.delivered).toEqual([]);
      expect(pending.skipped).toEqual([
        { key: item, reason: "execution_waiting" },
      ]);
      expect(approval).toBeTruthy();
      expect(effects).toBe(0);
      const [waiting] = await database.$client.unsafe(
        "SELECT payload,finished_at,attempts FROM work_items WHERE kind='bot.message' AND key=$1",
        [item],
      );
      expect(waiting.finished_at).toBeNull();
      expect(waiting.payload.execution.threadId).toBe(approval.threadId);
      expect(waiting.attempts).toBe(0);
      await restartHost();
      await database.$client.unsafe(
        "UPDATE work_items SET run_at=now() WHERE key=$1 AND kind='bot.message'",
        [item],
      );
      const restored = makeHandoffs();
      const calls = requests;
      expect((await restored.sweep()).skipped).toEqual([
        { key: item, reason: "execution_waiting" },
      ]);
      expect(requests).toBe(calls);
      expect(effects).toBe(0);
      stages.shift();
      stages.push({ answer: "批准后的目标结果。" });
      confirmations = createConfirmations(database);
      const [savedApproval] = await database.$client.unsafe(
        "SELECT continuation FROM chisabot_confirm_requests WHERE id=$1",
        [approval.id],
      );
      const oldScope = readRunAssertion(
        savedApproval.continuation.forwardedProps.chisabotRun,
        key,
      )!;
      const expired = mintRunAssertion(oldScope, key, 0);
      expect(readRunAssertion(expired, key)).toBeNull();
      await database.$client.unsafe(
        "UPDATE chisabot_confirm_requests SET continuation=jsonb_set(continuation,'{forwardedProps,chisabotRun}',$2::text::jsonb) WHERE id=$1",
        [approval.id, JSON.stringify(expired)],
      );
      await confirmations.decide(actor, approval.id, "approve");
      const resume = createConfirmationResumer({
        database,
        backend,
        confirmations,
        buildAgentFor: (input) =>
          build({
            actorId: input.ownerUserId,
            botId: input.agentId,
            initiator: input.initiator,
          }),
        runTurn,
        refreshRunAssertion: (signed, owner, botId) =>
          refreshApprovedHandoffRun(signed, owner, botId, key),
      });
      await resume(actor, approval.id);
      await resume(actor, approval.id);
      expect(effects).toBe(1);
      expect(resumedCoordination).toBe(true);
      const afterApprovalCalls = requests;
      await database.$client.unsafe(
        "UPDATE work_items SET run_at=now() WHERE key=$1 AND kind='bot.message'",
        [item],
      );
      expect((await restored.sweep()).delivered).toEqual([target]);
      expect(requests).toBe(afterApprovalCalls);
      stages.push({ answer: "审批完成的结果回到原对话。" });
      expect((await restored.sweep()).delivered).toEqual([asker]);
      const [complete] = await database.$client.unsafe(
        "SELECT finished_at FROM work_items WHERE kind='bot.message' AND key=$1",
        [item],
      );
      expect(complete.finished_at).not.toBeNull();
      expect(effects).toBe(1);
      expect(stages).toHaveLength(0);
    }, 70_000);

    test("a reconstructed handoff consumes the committed result after delivery response loss", async () => {
      const item = `${actor}-lost-result-hop`;
      await queue.offer({
        kind: "bot.message",
        key: item,
        payload: {
          fromBotId: asker,
          toBotId: target,
          actorId: actor,
          threadId: source,
          runId: `${item}-source`,
          depth: 1,
          task: "Record the actor once",
        },
      });
      const probesBefore = probes.length;
      stages.push({ tool: "actor_probe", answer: "Durable target result." });
      const lost = makeHandoffs(() => {
        throw new Error("Delivery response lost after committed execution.");
      });
      expect((await lost.sweep()).skipped[0]?.reason).toContain(
        "Delivery response lost",
      );
      expect(probes.length).toBe(probesBefore + 1);
      const [saved] = await database.$client.unsafe(
        "SELECT payload FROM work_items WHERE kind='bot.message' AND key=$1",
        [item],
      );
      await restartHost();
      const calls = requests;
      await database.$client.unsafe(
        "UPDATE work_items SET run_at=now() WHERE key=$1 AND kind='bot.message'",
        [item],
      );
      const restored = makeHandoffs();
      expect((await restored.sweep()).delivered).toEqual([target]);
      expect(requests).toBe(calls);
      expect(probes.length).toBe(probesBefore + 1);
      const [runs] = await database.$client.unsafe(
        "SELECT count(*)::int AS count FROM chisabot_dsh_runs WHERE thread_id=$1",
        [saved.payload.execution.threadId],
      );
      expect(runs.count).toBe(1);
      stages.push({ answer: "重建后回传原结果。" });
      expect((await restored.sweep()).delivered).toEqual([asker]);
      expect((await restored.sweep()).delivered).toEqual([]);
      expect(stages).toHaveLength(0);
    }, 70_000);

    test("a stopped handoff remains terminal when its queue owner returns", async () => {
      const item = `${actor}-stopped-hop`;
      confirmations.setOnOpened((value) => {
        approval = value;
      });
      await queue.offer({
        kind: "bot.message",
        key: item,
        payload: {
          fromBotId: asker,
          toBotId: target,
          actorId: actor,
          threadId: source,
          runId: `${item}-source`,
          depth: 1,
          task: "Perform the approved effect",
        },
      });
      stages.push({
        tool: "handoff_approved_effect",
        answer: "Must not be returned.",
      });
      expect((await makeHandoffs().sweep()).skipped).toEqual([
        { key: item, reason: "execution_waiting" },
      ]);
      const [saved] = await database.$client.unsafe(
        "SELECT payload FROM work_items WHERE kind='bot.message' AND key=$1",
        [item],
      );
      await backend.runner.stop(saved.payload.execution);
      stages.shift();
      const calls = requests,
        effectsBefore = effects;
      await database.$client.unsafe(
        "UPDATE work_items SET run_at=now() WHERE key=$1 AND kind='bot.message'",
        [item],
      );
      const restored = await makeHandoffs().sweep();
      expect(restored.delivered).toEqual([]);
      expect(restored.skipped[0]?.key).toBe(item);
      const [finished] = await database.$client.unsafe(
        "SELECT finished_at FROM work_items WHERE kind='bot.message' AND key=$1",
        [item],
      );
      expect(finished.finished_at).not.toBeNull();
      expect(requests).toBe(calls);
      expect(effects).toBe(effectsBefore);
      const [runs] = await database.$client.unsafe(
        "SELECT count(*)::int AS count FROM chisabot_dsh_runs WHERE thread_id=$1",
        [saved.payload.execution.threadId],
      );
      expect(runs.count).toBe(1);
      // The failure notice is a separate source notification, not another target execution.
      await database.$client.unsafe(
        "DELETE FROM work_items WHERE kind='bot.message' AND key=$1",
        [`notice:${item}`],
      );
      expect(stages).toHaveLength(0);
    }, 45_000);

    test("a Team Bot runs in the teammate's Host and keeps computer and personal credential boundaries", async () => {
      const owner = { id: publisher, role: "user" as const },
        teammate = { id: actor, role: "user" as const };
      teamBot = (
        await profiles.create(owner, {
          name: "Team Acceptance",
          title: "Acceptance",
          roleDescription: "Test shared team authority",
          visibility: "private",
        })
      ).id;
      await teamBots.publish(owner, teamBot, {
        audience: "team",
        emails: [],
        groups: [],
      });
      const thread = `${actor}-team`,
        initiator = { kind: "person" as const, surface: "web" as const };
      stages.push({ tool: "team_authority_probe", answer: "团队权限已核对。" });
      await runTurn({
        ownerUserId: actor,
        agentId: teamBot,
        threadId: thread,
        routineId: "team",
        initiator,
        instruction: "Check Team Bot authority.",
      });
      expect(teamResults[0]).toMatchObject({
        actor,
        computer: false,
        sharedCredential: publisher,
        initiator,
      });
      expect(teamResults[0]!.personalCredential).toContain(
        "[team-bot-consent]",
      );
      const [binding] = await database.$client.unsafe(
        "SELECT owner_user_id,bot_id FROM chisabot_runtime_bindings WHERE thread_id=$1",
        [thread],
      );
      expect(binding).toMatchObject({ owner_user_id: actor, bot_id: teamBot });
      await expect(
        backend.client.getThreadMessages({
          threadId: thread,
          userId: publisher,
        }),
      ).rejects.toThrow();
      await teamBots.consent(teammate, teamBot, "personal", "allow_once");
      stages.push({ tool: "team_authority_probe", answer: "单次授权已使用。" });
      await runTurn({
        ownerUserId: actor,
        agentId: teamBot,
        threadId: thread,
        routineId: "team",
        initiator,
        instruction: "Use the allowed personal credential once.",
      });
      expect(teamResults[1]!.personalCredential).toBe(actor);
      await expect(
        teamBots.credentialActorFor(actor, teamBot)("personal/read"),
      ).rejects.toThrow("[team-bot-consent]");
      expect(stages).toHaveLength(0);
    }, 50_000);

    test("DSH launches a device agent through approval and the device protocol returns to the original thread", async () => {
      const thread = `${actor}-device-thread`;
      stages.push({
        tool: "device_agent_run",
        args: {
          agent: "claude",
          task: "Inspect the workspace",
          title: "Device acceptance",
          cwd: "/workspace",
        },
        answer: "设备任务已发出。",
      });
      await runTurn({
        ownerUserId: actor,
        agentId: asker,
        threadId: thread,
        routineId: "device",
        initiator: { kind: "person", surface: "web" },
        instruction: "Ask the device agent to inspect the workspace.",
      });
      const frame = await until(async () =>
        sent.find((value) => value.type === "agent_run"),
      );
      expect(frame).toMatchObject({
        agent: "claude",
        cwd: "/workspace",
        isolation: "worktree",
        skipPermissions: false,
      });
      expect(sent.some((value) => value.type === "approval_request")).toBe(
        true,
      );
      await connection.onMessage(
        JSON.stringify({ type: "agent_started", taskId: frame.taskId }),
      );
      await localAgents.handleNodeMessage(
        { ...device, id: `${device.id}-other` },
        {
          type: "agent_done",
          taskId: frame.taskId,
          ok: true,
          summary: "forged",
        } as never,
      );
      expect((await localAgents.forThread(actor, thread))[0]!.status).toBe(
        "running",
      );
      expect(await localAgents.forThread(publisher, thread)).toEqual([]);
      await expect(localAgents.stop(publisher, frame.taskId)).rejects.toThrow();
      stages.push({ answer: "设备检查结果已收到。" });
      await connection.onMessage(
        JSON.stringify({
          type: "agent_done",
          taskId: frame.taskId,
          ok: true,
          summary: "Workspace inspected.",
        }),
      );
      await until(async () =>
        (
          await backend.client.getThreadMessages({
            threadId: thread,
            userId: actor,
          })
        ).messages.some(
          (message) => message.content === "设备检查结果已收到。",
        ),
      );
      expect((await localAgents.forThread(actor, thread))[0]).toMatchObject({
        status: "done",
        summary: "Workspace inspected.",
      });
      const [ownedTask] = await database.$client.unsafe(
        "SELECT owner_user_id,thread_id,agent_id FROM chisabot_local_agent_tasks WHERE id=$1",
        [frame.taskId],
      );
      expect(ownedTask).toMatchObject({
        owner_user_id: actor,
        thread_id: thread,
        agent_id: asker,
      });
      const before = requests;
      await connection.onMessage(
        JSON.stringify({
          type: "agent_done",
          taskId: frame.taskId,
          ok: true,
          summary: "duplicate",
        }),
      );
      expect(requests).toBe(before);
      expect(stages).toHaveLength(0);
    }, 50_000);
  },
);
