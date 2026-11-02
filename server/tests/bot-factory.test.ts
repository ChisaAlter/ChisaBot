import { describe, expect, test } from "bun:test";
import {
  BOT_FACTORY_TOOL_NAMES,
  type BotFactoryQueries,
  createBotFactory,
} from "../src/agents/bot-factory";
import type { RunAssertion } from "../src/agents/callback-token";
import { createCoordinationTools } from "../src/agents/handoff-tool";
import type { AgentProfile } from "../src/agents/profile-types";
import type { CoworkerResult, CoworkerService } from "../src/agents/service";
import { createApprovedActionExecutor } from "../src/approvals/execute";
import { approvalAction } from "../src/approvals/types";
import type { AuditEventInput, AuditStore } from "../src/audit";

const FROM: RunAssertion = {
  botId: "creator-bot",
  actorId: "user-1",
  runId: "run-1",
  threadId: "thread-1",
  depth: 0,
};

const PERSON = { kind: "person" as const };

function profile(id: string, over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    name: "Helper",
    title: "A helper",
    roleDescription: "Helps.",
    avatarSeed: id,
    visibility: "private",
    ownerUserId: FROM.actorId,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    createdByAgentId: FROM.botId,
    createdDepth: 1,
    ...over,
  };
}

type CreateCall = {
  actor: { id: string; email?: string };
  input: unknown;
  options?: {
    createdByAgentId?: string;
    createdDepth?: number;
    model?: string;
    audit?: Record<string, unknown>;
    within?: (
      executor: { execute: (s: unknown) => Promise<unknown> },
      agentId: string,
    ) => Promise<void>;
  };
};

function harness(
  over: {
    depth?: number | null;
    count?: number;
    withinCount?: number;
    managed?: {
      id: string;
      name: string;
      title: string;
      roleDescription: string;
    } | null;
    listed?: Awaited<ReturnType<BotFactoryQueries["managedBy"]>>;
    gate?: "approve" | "deny" | "none";
    catalogModels?: string[];
    catalogFails?: boolean;
    createResult?: CoworkerResult;
    caps?: { maxDepth: number; maxPerUser: number };
  } = {},
) {
  const audit: AuditEventInput[] = [];
  const grants: { ref: string; agentId: string; by: string; inTx: boolean }[] =
    [];
  const gates: {
    toolRef: string;
    effect: string;
    scope: string;
    args: unknown;
    target?: unknown;
  }[] = [];
  const creates: CreateCall[] = [];
  const updates: {
    agentId: string;
    input: unknown;
    audit?: Record<string, unknown>;
  }[] = [];
  const pauses: { ownerUserId: string; agentId: string }[] = [];
  const modelSets: { agentId: string; model: string }[] = [];
  const recorded: {
    eventType: string;
    agentId: string;
    payload: Record<string, unknown>;
  }[] = [];

  const withinQueries: BotFactoryQueries = {
    depthOf: async () => ("depth" in over ? (over.depth ?? null) : 0),
    managedBy: async () => over.listed ?? [],
    countForUser: async () => over.withinCount ?? over.count ?? 0,
    managedTarget: async () => over.managed ?? null,
  };
  const queries: BotFactoryQueries = {
    ...withinQueries,
    countForUser: async () => over.count ?? 0,
  };

  const coworker = {
    async createCoworker(actor, input, options) {
      creates.push({ actor, input, options });
      // Run the caller's same-transaction hook the way the real store does: on an executor, with
      // the new id, before answering.
      await options?.within?.(
        { execute: async () => ({}) } as never,
        "new-agent",
      );
      return over.createResult ?? { ok: true, agent: profile("new-agent") };
    },
    async updateCoworker(_actor, agentId, input, options) {
      updates.push({ agentId, input, audit: options?.audit });
      return { ok: true, agent: profile(agentId) };
    },
    async record(_actor, eventType, agentId, payload = {}) {
      recorded.push({ eventType, agentId, payload });
    },
  } as unknown as CoworkerService;

  const factory = createBotFactory({
    queries,
    queriesWithin: () => withinQueries,
    coworker,
    actorFor: async () => ({
      id: FROM.actorId,
      role: "user",
      email: "owner@chisabot.test",
    }),
    caps: over.caps ?? { maxDepth: 1, maxPerUser: 20 },
    auditStore: {
      insert: async (event) => {
        audit.push(event);
      },
    } satisfies AuditStore,
    ...(over.gate === "none"
      ? {}
      : {
          approvalGate: async (candidate: {
            toolRef: string;
            effect: string;
            scope: string;
            args: unknown;
            target?: unknown;
          }) => {
            gates.push(candidate);
            if (over.gate === "deny") {
              const { ApprovalRefusedError } = await import(
                "../src/approvals/types"
              );
              throw new ApprovalRefusedError("the person declined");
            }
            return undefined;
          },
        }),
    grant: async (_kind, ref, agentId, by, executor) => {
      grants.push({ ref, agentId, by, inTx: executor !== undefined });
    },
    pause: async (ownerUserId, agentId) => {
      pauses.push({ ownerUserId, agentId });
      return 0;
    },
    ...(over.catalogFails
      ? {
          catalog: {
            list: async () => {
              throw new Error("upstream");
            },
          },
        }
      : {
          catalog: {
            list: async () => ({
              models: (over.catalogModels ?? ["model-a", "model-b"]).map(
                (id) => ({ id }),
              ),
            }),
          },
        }),
    setModel: async (_actor, agentId, model) => {
      modelSets.push({ agentId, model });
    },
  });

  return {
    factory,
    audit,
    grants,
    gates,
    creates,
    updates,
    pauses,
    modelSets,
    recorded,
  };
}

const CREATE_ARGS = {
  name: "Helper",
  title: "A helper",
  roleDescription: "Helps with chores.",
};

describe("what the factory offers", () => {
  test("offers all four tools to a person-made Bot under the caps", async () => {
    const { factory } = harness();
    expect((await factory.toolsFor(FROM)).map((t) => t.name)).toEqual([
      "create_bot",
      "list_managed_bots",
      "update_bot",
      "disable_bot",
    ]);
  });

  test.each([
    ["depth", { maxDepth: 0, maxPerUser: 20 }],
    ["per-user count", { maxDepth: 1, maxPerUser: 0 }],
  ])(
    "offers nothing when the deployment capped %s at zero",
    async (_label, caps) => {
      const { factory } = harness({ caps });
      expect(await factory.toolsFor(FROM)).toEqual([]);
    },
  );

  test("offers nothing to a Bot-made Bot already at the depth cap", async () => {
    const { factory } = harness({ depth: 1 });
    expect(await factory.toolsFor(FROM)).toEqual([]);
  });

  test("offers nothing when the creator's profile is gone", async () => {
    const { factory } = harness({ depth: null });
    expect(await factory.toolsFor(FROM)).toEqual([]);
  });
});

describe("create_bot", () => {
  test("asks the person with the full spec, then creates with provenance and both grants", async () => {
    const { factory, gates, creates, grants } = harness();

    const tools = await factory.toolsFor(FROM);
    const create = tools.find((t) => t.name === "create_bot");
    const said = await create?.execute({
      ...CREATE_ARGS,
      model: "model-a",
    });

    expect(gates).toEqual([
      expect.objectContaining({
        toolRef: "bot/create_bot",
        effect: "create",
        scope: "Helper",
        args: { ...CREATE_ARGS, model: "model-a" },
        target: {
          bot: "Helper",
          title: "A helper",
          roleDescription: "Helps with chores.",
          model: "model-a",
        },
      }),
    ]);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.input).toEqual(CREATE_ARGS);
    expect(creates[0]?.options).toMatchObject({
      createdByAgentId: FROM.botId,
      createdDepth: 1,
      model: "model-a",
      audit: { byAgent: FROM.botId, via: "bot/create_bot" },
    });
    // Both directions, in the creation transaction: the new Bot may reach its creator and vice versa.
    expect(grants).toEqual([
      {
        ref: "new-agent",
        agentId: FROM.botId,
        by: "owner@chisabot.test",
        inTx: true,
      },
      {
        ref: FROM.botId,
        agentId: "new-agent",
        by: "owner@chisabot.test",
        inTx: true,
      },
    ]);
    expect(said).toContain("Created the Bot");
    expect(said).toContain("new-agent");
    expect(said).toContain("mutualHandoff");
  });

  test("a Bot-made Bot at the depth cap is refused and audited", async () => {
    const { factory, audit, gates } = harness({ depth: 1 });
    const result = await factory.call({
      name: "create_bot",
      args: CREATE_ARGS,
      run: FROM,
    });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("cannot create Bots");
    expect(gates).toHaveLength(0);
    expect(audit).toEqual([
      expect.objectContaining({
        eventType: "bot.factory_refused",
        payload: expect.objectContaining({
          bot: FROM.botId,
          reason: "depth_cap",
          target: "Helper",
        }),
      }),
    ]);
  });

  test("the per-user cap is refused and audited before the card is raised", async () => {
    const { factory, audit, gates } = harness({ count: 20 });
    const result = await factory.call({
      name: "create_bot",
      args: CREATE_ARGS,
      run: FROM,
    });
    expect(result?.isError).toBe(true);
    expect(gates).toHaveLength(0);
    expect(audit[0]).toMatchObject({
      eventType: "bot.factory_refused",
      payload: { reason: "per_user_cap" },
    });
  });

  test("the cap re-check inside the creation transaction refuses the same way", async () => {
    // count passes at pre-flight (0) but the locked recount sees 20.
    const { factory, audit } = harness({ count: 0, withinCount: 20 });
    const result = await factory.call({
      name: "create_bot",
      args: CREATE_ARGS,
      run: FROM,
    });
    expect(result?.isError).toBe(true);
    expect(audit[0]).toMatchObject({
      eventType: "bot.factory_refused",
      payload: { reason: "per_user_cap" },
    });
  });

  test.each([
    ["an invalid model id", "not a model", "That is not a model id."],
    [
      "a model outside the catalog",
      "gpt-99",
      "not in this deployment's model list",
    ],
  ])("refuses %s without asking the person", async (_label, model, message) => {
    const { factory, gates, creates } = harness();
    const result = await factory.call({
      name: "create_bot",
      args: { ...CREATE_ARGS, model },
      run: FROM,
    });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain(message);
    expect(gates).toHaveLength(0);
    expect(creates).toHaveLength(0);
  });

  test("a declined approval creates nothing and answers with a sentence", async () => {
    const { factory, creates } = harness({ gate: "deny" });
    const result = await factory.call({
      name: "create_bot",
      args: CREATE_ARGS,
      run: FROM,
    });
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("the person declined");
    expect(creates).toHaveLength(0);
  });
});

describe("list_managed_bots", () => {
  test("lists what this Bot made, and says so when there is nothing", async () => {
    const empty = await harness().factory.call({
      name: "list_managed_bots",
      args: {},
      run: FROM,
    });
    expect(empty?.text).toContain("have not created");

    const { factory } = harness({
      listed: [
        {
          id: "kid-1",
          name: "Helper",
          title: "A helper",
          paused: false,
          createdAt: new Date("2026-01-01"),
        },
      ],
    });
    const result = await factory.call({
      name: "list_managed_bots",
      args: {},
      run: FROM,
    });
    expect(result?.isError).toBe(false);
    expect(result?.text).toContain("kid-1");
    expect(result?.text).toContain("Helper");
  });
});

describe("update_bot and disable_bot", () => {
  const managed = {
    id: "kid-1",
    name: "Helper",
    title: "A helper",
    roleDescription: "Old instruction.",
  };

  test("update merges the stored row and audits who asked", async () => {
    const { factory, updates, modelSets, gates } = harness({ managed });
    const result = await factory.call({
      name: "update_bot",
      args: {
        id: "kid-1",
        roleDescription: "New instruction.",
        model: "model-b",
      },
      run: FROM,
    });
    expect(result?.isError).toBe(false);
    expect(gates[0]).toMatchObject({
      toolRef: "bot/update_bot",
      effect: "update",
      scope: "kid-1",
    });
    expect(updates[0]?.agentId).toBe("kid-1");
    // Only roleDescription was sent; the other fields come from the stored row.
    expect(updates[0]?.input).toEqual({
      name: "Helper",
      title: "A helper",
      roleDescription: "New instruction.",
    });
    expect(updates[0]?.audit).toMatchObject({
      byAgent: FROM.botId,
      via: "bot/update_bot",
    });
    expect(modelSets).toEqual([{ agentId: "kid-1", model: "model-b" }]);
  });

  test.each(["update_bot", "disable_bot"])(
    "%s refuses a Bot it did not create, with one message for missing and not-owned",
    async (name) => {
      const { factory, audit, gates, pauses, updates } = harness({
        managed: null,
      });
      const result = await factory.call({
        name,
        args: { id: "somebody-elses", name: "x" },
        run: FROM,
      });
      expect(result?.isError).toBe(true);
      expect(result?.text).toContain("not a Bot you created");
      expect(gates).toHaveLength(0);
      expect(updates).toHaveLength(0);
      expect(pauses).toHaveLength(0);
      expect(audit[0]).toMatchObject({
        eventType: "bot.factory_refused",
        payload: { reason: "not_managed", target: "somebody-elses" },
      });
    },
  );

  test("disable pauses through the lifecycle store and writes bot.paused", async () => {
    const { factory, pauses, recorded, gates } = harness({ managed });
    const result = await factory.call({
      name: "disable_bot",
      args: { id: "kid-1" },
      run: FROM,
    });
    expect(result?.isError).toBe(false);
    expect(result?.text).toContain("paused");
    expect(gates[0]).toMatchObject({
      toolRef: "bot/disable_bot",
      effect: "disable",
      scope: "kid-1",
    });
    expect(pauses).toEqual([{ ownerUserId: FROM.actorId, agentId: "kid-1" }]);
    expect(recorded[0]).toMatchObject({
      eventType: "bot.paused",
      agentId: "kid-1",
      payload: { byAgent: FROM.botId, via: "bot/disable_bot" },
    });
  });
});

describe("through the coordination channel", () => {
  function coordinationHarness(over: Parameters<typeof harness>[0] = {}) {
    const inner = harness(over);
    const coordination = createCoordinationTools({
      desk: { send: async () => ({ ok: false, refusal: "no" }) },
      caps: { maxDepth: 1, maxPerRun: 3 },
      botsReachableFrom: async () => [],
      route: async () => ({ reached: "nobody" }),
      auditStore: {
        insert: async (event) => {
          inner.audit.push(event);
        },
      },
      authoriseRun: async () => true,
      factory: inner.factory,
    });
    return { coordination, ...inner };
  }

  test("the four names ride toolsForRun and call beside the original two", async () => {
    const { coordination } = coordinationHarness();
    const names = (await coordination.toolsForRun(FROM)).map((t) => t.name);
    expect(names).toContain("ask_person");
    for (const name of BOT_FACTORY_TOOL_NAMES) expect(names).toContain(name);

    const created = await coordination.call({
      name: "bot/create_bot",
      args: CREATE_ARGS,
      run: FROM,
    });
    expect(created?.isError).toBe(false);
    expect(created?.text).toContain("Created the Bot");
  });

  test("a refusal carries the refusal marker the transcript matches on", async () => {
    const { coordination } = coordinationHarness({ depth: 1 });
    const result = await coordination.call({
      name: "create_bot",
      args: CREATE_ARGS,
      run: FROM,
    });
    expect(result?.isError).toBe(true);
    expect(result?.text).toStartWith("Refused.");
  });

  test("an approved create_bot resumes through approval.resume and is executed", async () => {
    const { coordination, creates } = coordinationHarness();
    const args = CREATE_ARGS;
    const action = approvalAction({
      actorId: FROM.actorId,
      botId: FROM.botId,
      toolRef: "bot/create_bot",
      effect: "create",
      scope: "Helper",
      args,
      target: { bot: "Helper" },
      continuation: {
        runId: FROM.runId,
        threadId: FROM.threadId ?? "thread-1",
        toolCallId: "call-1",
        toolName: "create_bot",
        args,
        messages: [],
        state: {},
        context: [],
        forwardedProps: {},
      },
    });
    const execute = createApprovedActionExecutor({
      sourceFor: async () => ({ channelId: "channel" }),
      gate: async () => undefined,
      computerTools: async () => [],
      callTool: async () => ({ text: "", isError: false }),
      credentialActorFor: async (actorId) => actorId,
      coordinationCall: (input) => coordination.call(input),
      answer: (result) => result.text,
      privateShareToolRef: "chisabot/private_share",
      refusalMarker: "Refused.",
      personInitiator: PERSON,
    });

    const outcome = await execute(action);
    expect(String(outcome)).toContain("Created the Bot");
    expect(creates).toHaveLength(1);
  });
});
