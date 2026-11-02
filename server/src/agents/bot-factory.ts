/**
 * The tools with which one Bot creates, lists, edits and disables the Bots it made.
 *
 * They hang off the coordination channel beside `message_bot`/`ask_person` (a `bot/…` ref), which
 * is what buys them the signature assertion, the source-thread check and — most importantly — the
 * approvals card: creating a coworker, editing one and pausing one all wait for the person's
 * decision before anything is written, and an approved one resumes through `approval.resume` like a
 * granted hand-off.
 *
 * WHAT A BOT MAY MAKE IS NARROW, deliberately. No endpoint and no key: a Bot-made coworker is a
 * `built_in` one running on its role description, exactly what `createCoworker` makes when the form
 * is submitted with no address. Its only grants at birth are the two `kind="bot"` rows that let it
 * and its creator hand work to each other; it inherits nothing of its creator's connector grants or
 * accounts. Model, when named, has to be a member of the deployment's catalog — the same list the
 * person could pick from, never a free-form id.
 */
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type ApprovalGate,
  ApprovalRefusedError,
  currentApprovalContext,
  PREVIEW_VERBATIM,
} from "../approvals/types";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { BotFactoryCaps } from "../config";
import type { Database } from "../db/client";
import { agentProfiles, agents } from "../db/schema";
import { botLifecycle } from "../db/schema/lifecycle";
import type { GrantedTool } from "../plugins/tools";
import type { RunAssertion } from "./callback-token";
import { validModelId } from "./model-selection";
import type {
  ProfileReadExecutor,
  ProfileWriteExecutor,
} from "./profile-store";
import type { AgentActor } from "./profile-types";
import type { CoworkerActor, CoworkerService } from "./service";

export const CREATE_BOT_TOOL = "create_bot";
export const LIST_MANAGED_BOTS_TOOL = "list_managed_bots";
export const UPDATE_BOT_TOOL = "update_bot";
export const DISABLE_BOT_TOOL = "disable_bot";

/** The four names the coordination dispatcher recognises. */
export const BOT_FACTORY_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_BOT_TOOL,
  LIST_MANAGED_BOTS_TOOL,
  UPDATE_BOT_TOOL,
  DISABLE_BOT_TOOL,
]);

const createParameters = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .describe("The new Bot's name, as it appears in the roster"),
  title: z
    .string()
    .min(1)
    .max(120)
    .describe("What the new Bot is for, in a line"),
  roleDescription: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      "The instruction the new Bot runs on — its duties and how it should answer",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "A model from the deployment's catalog to run it on. Omit for the deployment default.",
    ),
});

const updateParameters = z.object({
  id: z.string().min(1).describe("The id of a Bot you created"),
  name: z.string().min(1).max(80).optional(),
  title: z.string().min(1).max(120).optional(),
  roleDescription: z.string().min(1).max(1000).optional(),
  model: z
    .string()
    .optional()
    .describe("A catalog model to run it on. Omit to leave its model alone."),
});

const disableParameters = z.object({
  id: z.string().min(1).describe("The id of a Bot you created"),
});

const listParameters = z.object({});

export type ManagedBotRow = {
  id: string;
  name: string;
  title: string;
  paused: boolean;
  createdAt: Date;
};

/** The reads the factory needs, narrow enough for a unit test to fake. */
export type BotFactoryQueries = {
  /** The would-be creator's own creation depth, or null when its profile is gone or deleted. */
  depthOf(botId: string): Promise<number | null>;
  /** The live coworkers this Bot made for this person. */
  managedBy(
    creatorBotId: string,
    ownerUserId: string,
  ): Promise<ManagedBotRow[]>;
  /** The live Bot-made coworkers this person has — the number the per-user cap compares against. */
  countForUser(ownerUserId: string): Promise<number>;
  /**
   * A live coworker this Bot made for this person, or null.
   *
   * "Missing" and "made by somebody else" deliberately answer the same thing: distinguishing them
   * would let a Bot enumerate coworkers it was never told about.
   */
  managedTarget(
    creatorBotId: string,
    ownerUserId: string,
    id: string,
  ): Promise<{
    id: string;
    name: string;
    title: string;
    roleDescription: string;
  } | null>;
};

type SelectExecutor =
  | Pick<Database, "select">
  | Pick<ProfileReadExecutor, "select">;

/** The queries, bound to a pool or to a caller's open transaction. */
export function createBotFactoryQueries(
  executor: SelectExecutor,
): BotFactoryQueries {
  return {
    async depthOf(botId) {
      const [row] = await executor
        .select({ createdDepth: agentProfiles.createdDepth })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.agentId, botId),
            isNull(agentProfiles.deletedAt),
          ),
        )
        .limit(1);
      return row ? row.createdDepth : null;
    },

    async managedBy(creatorBotId, ownerUserId) {
      const rows = await executor
        .select({
          id: agents.id,
          name: agents.name,
          title: agentProfiles.title,
          createdAt: agentProfiles.createdAt,
          pausedAt: botLifecycle.pausedAt,
        })
        .from(agentProfiles)
        .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
        .leftJoin(
          botLifecycle,
          and(
            eq(botLifecycle.agentId, agentProfiles.agentId),
            eq(botLifecycle.ownerUserId, agentProfiles.ownerUserId),
          ),
        )
        .where(
          and(
            eq(agentProfiles.createdByAgentId, creatorBotId),
            eq(agentProfiles.ownerUserId, ownerUserId),
            isNull(agentProfiles.deletedAt),
          ),
        );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        title: row.title,
        paused: row.pausedAt !== null,
        createdAt: row.createdAt,
      }));
    },

    async countForUser(ownerUserId) {
      const [row] = await executor
        .select({ count: sql<number>`count(*)::int` })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.ownerUserId, ownerUserId),
            isNotNull(agentProfiles.createdByAgentId),
            isNull(agentProfiles.deletedAt),
          ),
        );
      return row?.count ?? 0;
    },

    async managedTarget(creatorBotId, ownerUserId, id) {
      const [row] = await executor
        .select({
          id: agents.id,
          name: agents.name,
          title: agentProfiles.title,
          roleDescription: agentProfiles.roleDescription,
        })
        .from(agentProfiles)
        .innerJoin(agents, eq(agents.id, agentProfiles.agentId))
        .where(
          and(
            eq(agentProfiles.agentId, id),
            eq(agentProfiles.createdByAgentId, creatorBotId),
            eq(agentProfiles.ownerUserId, ownerUserId),
            isNull(agentProfiles.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}

/** The per-user cap tripped inside the creation transaction, told apart from a store error. */
class BotFactoryCapError extends Error {
  override name = "BotFactoryCapError";
}

/** How much of the prompt an IM summary quotes before pointing at the web page for the rest. */
const PROMPT_EXCERPT = 300;

/*
 * Secret-looking shapes, warned about rather than masked: the card must show the prompt exactly as
 * it will run (masking would approve one text and execute another), so what the person gets is a
 * loud `secretWarning` field naming every pattern found. Ordered roughly most- to least-specific.
 */
const SECRET_LIKE: readonly { label: string; pattern: RegExp }[] = [
  { label: "sk-… 样式的密钥", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  {
    label: "GitHub 令牌（ghp_ / github_pat_）",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/,
  },
  { label: "Slack 令牌（xox…-）", pattern: /\bxox[a-z]-[A-Za-z0-9-]{8,}\b/i },
  { label: "AWS 访问密钥（AKIA…）", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    label: "Bearer 令牌",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i,
  },
  { label: "password=/密码=", pattern: /(?:password|passwd|密码)\s*[:=：]/i },
  {
    label: "私钥块",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    label: "长十六进制 / Base64 密钥样式串",
    pattern: /\b[0-9a-fA-F]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2}\b/,
  },
];

/** The labels of every secret-like pattern found in `text`; empty when it reads benign. */
export function secretLikeIn(text: string): string[] {
  return SECRET_LIKE.filter((entry) => entry.pattern.test(text)).map(
    (entry) => entry.label,
  );
}

/** The warning a card and an IM summary carry when a prompt smells like it holds a secret. */
function secretWarningFor(prompt: string): string | undefined {
  const found = secretLikeIn(prompt);
  return found.length
    ? `⚠️ 提示词中检测到疑似敏感信息（${found.join("、")}）。提示词会原样执行、不予遮蔽——请确认这是有意写入的再批准。`
    : undefined;
}

/**
 * A line diff of the stored prompt against the proposed one, in the `-`/`+`/space shape a unified
 * diff uses, so the card can show exactly what the edit would change. Prompts cap at 1000
 * characters, so the LCS table stays trivial.
 */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < a.length) lines.push(`- ${a[i++]}`);
  while (j < b.length) lines.push(`+ ${b[j++]}`);
  return lines.join("\n");
}

export type BotFactory = ReturnType<typeof createBotFactory>;

export function createBotFactory(options: {
  /** Reads on the pool: offer conditions and pre-flight refusals. */
  queries: BotFactoryQueries;
  /** The same reads on the creation transaction, for the cap re-check under the advisory lock. */
  queriesWithin: (executor: ProfileWriteExecutor) => BotFactoryQueries;
  /** The shared create/update behind `POST`/`PATCH /api/agents`. */
  coworker: CoworkerService;
  /** Who the run's owner is, with the email the grant rows and the audit trail record. */
  actorFor: (userId: string) => Promise<CoworkerActor>;
  caps: BotFactoryCaps;
  auditStore: AuditStore;
  /**
   * The person's approval gate: create/update/disable wait on the same card a hand-off does, and an
   * approved action executes on resume through the same `bot/` dispatch.
   */
  approvalGate?: ApprovalGate;
  /**
   * A `kind="bot"` grant — `agentId` is the one that may address, `ref` the one it may reach —
   * optionally on the caller's transaction.
   */
  grant: (
    kind: "bot",
    ref: string,
    agentId: string,
    by: string,
    executor?: ProfileWriteExecutor,
  ) => Promise<void>;
  /** The lifecycle pause (`bot.paused`, reversible — there is no delete tool on purpose). */
  pause: (ownerUserId: string, agentId: string) => Promise<unknown>;
  /** The deployment's model catalog, for the `model` argument's membership check. */
  catalog?: { list(): Promise<{ models: { id: string }[] }> };
  /** Write a model override on an existing `built_in` Bot (the chooser's own write path). */
  setModel?: (
    actor: AgentActor,
    agentId: string,
    model: string,
  ) => Promise<unknown>;
  /**
   * The web page that shows the full approval content — the link an IM summary ends with, so a
   * decision made from a chat app can still be checked against everything first. Left out of the
   * summary when the deployment has no app URL.
   */
  approvalsUrl?: string;
}) {
  const {
    queries,
    queriesWithin,
    coworker,
    actorFor,
    caps,
    auditStore,
    approvalGate,
    grant,
    pause,
    catalog,
    setModel,
    approvalsUrl,
  } = options;

  /**
   * The content summary an IM channel can deliver beside「允许 / 拒绝」: name, model, the first
   * ~300 characters of the prompt the card holds, the secret warning when there is one, and the
   * link to the page showing all of it. Carried on the approval target as `imSummary` — the IM
   * layer only has to read it out of the stored request.
   */
  function imSummary(input: {
    verb: string;
    name: string;
    title?: string;
    model: string;
    prompt: string;
    warning?: string;
  }): string {
    const excerpt =
      input.prompt.length > PROMPT_EXCERPT
        ? `${input.prompt.slice(0, PROMPT_EXCERPT)}…`
        : input.prompt;
    return [
      `【审批内容摘要】${input.verb}机器人`,
      `名字：${input.name}`,
      ...(input.title ? [`职责：${input.title}`] : []),
      `模型：${input.model}`,
      `提示词（${input.prompt.length > PROMPT_EXCERPT ? `前 ${PROMPT_EXCERPT} 字，共 ${input.prompt.length} 字` : "全文"}）：${excerpt}`,
      ...(input.warning ? [input.warning] : []),
      ...(approvalsUrl ? [`完整内容：${approvalsUrl}`] : []),
    ].join("\n");
  }

  /**
   * A cap or ownership refusal: audit it, then hand the model a sentence it can say.
   *
   * The audit row is why this exists — the tool was never offered or a stale call was refused, and
   * without the row nobody can see the Bot reached for the factory and was stopped. `payload.bot`
   * names the asking Bot because the Audit screen's Bot column reads nothing else.
   */
  async function refuse(
    from: RunAssertion,
    input: { reason: string; target?: string; message: string },
  ): Promise<{ text: string; isError: boolean }> {
    try {
      await recordAuditEvent(auditStore, {
        eventType: "bot.factory_refused",
        targetType: "agent",
        targetId: from.botId,
        ...(from.actorId ? { actorUserId: from.actorId } : {}),
        ...(from.initiator ? { initiator: from.initiator } : {}),
        payload: {
          bot: from.botId,
          reason: input.reason,
          ...(input.target ? { target: input.target.slice(0, 120) } : {}),
          run: from.runId,
        },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-audit-write-failed",
          eventType: "bot.factory_refused",
          error: String(error),
        }),
      );
    }
    return { text: input.message, isError: true };
  }

  /**
   * The approval card, in the shape every `bot/` tool raises it.
   *
   * Returns a finished answer (a replayed result or a refusal) or nothing when the action may
   * proceed. A pending approval throws out of here — the run suspends on the card, which is the
   * behaviour the shared gate is for.
   */
  async function gated(input: {
    from: RunAssertion;
    toolRef: string;
    effect: string;
    scope: string;
    args: unknown;
    target?: unknown;
    refused: string;
  }): Promise<{ text: string; isError: boolean } | null> {
    if (!approvalGate) return null;
    try {
      const approval = await approvalGate({
        actorId: input.from.actorId,
        botId: input.from.botId,
        toolRef: input.toolRef,
        effect: input.effect,
        scope: input.scope,
        args: input.args,
        target: input.target,
        continuation: currentApprovalContext(),
      });
      if (approval && "replay" in approval) {
        return {
          text:
            typeof approval.replay === "string"
              ? approval.replay
              : JSON.stringify(approval.replay),
          isError: false,
        };
      }
      return null;
    } catch (error) {
      if (error instanceof ApprovalRefusedError)
        return { text: `${input.refused}: ${error.message}`, isError: true };
      throw error;
    }
  }

  /** Catalog membership, checked per call: the list changes and a stale accept would mint one anyway. */
  async function modelVerdict(
    model: string,
  ): Promise<{ ok: true } | { ok: false; refusal: string }> {
    if (!validModelId(model))
      return { ok: false, refusal: "That is not a model id." };
    const list = await catalog?.list().catch(() => null);
    if (!list)
      return {
        ok: false,
        refusal:
          "The model list could not be loaded right now, so no model could be picked. Try again without a model, or later.",
      };
    if (!list.models.some((entry) => entry.id === model))
      return {
        ok: false,
        refusal: "That model is not in this deployment's model list.",
      };
    return { ok: true };
  }

  async function createBot(from: RunAssertion, args: unknown) {
    const parsed = createParameters.safeParse(args);
    if (!parsed.success) {
      return {
        text: "No Bot was created: name, title and roleDescription are all required.",
        isError: true,
      };
    }
    const data = parsed.data;

    /*
     * The same conditions `toolsFor` offers under, re-checked on the call: an approved action
     * resumes through `call` days later, and a stale remote schema can name a tool it was never
     * shown. The refusal is audited either way — that is exactly the moment `bot.factory_refused`
     * is for.
     */
    const depth = await queries.depthOf(from.botId);
    if (caps.maxDepth <= 0 || caps.maxPerUser <= 0 || depth === null) {
      return refuse(from, {
        reason: "factory_disabled",
        target: data.name,
        message:
          "No Bot was created: this deployment does not let Bots create Bots.",
      });
    }
    if (depth >= caps.maxDepth) {
      return refuse(from, {
        reason: "depth_cap",
        target: data.name,
        message:
          "No Bot was created: Bots you create cannot create Bots of their own. Only a person-made Bot may use this tool.",
      });
    }
    if ((await queries.countForUser(from.actorId)) >= caps.maxPerUser) {
      return refuse(from, {
        reason: "per_user_cap",
        target: data.name,
        message: `No Bot was created: this person already has the most Bot-made Bots this deployment allows (${caps.maxPerUser}).`,
      });
    }
    if (data.model) {
      const verdict = await modelVerdict(data.model);
      if (!verdict.ok) return { text: verdict.refusal, isError: true };
    }

    /*
     * The card shows the whole spec: name, duty, the full prompt and the model. `prompt` carries
     * roleDescription byte-for-byte — it is the text the new Bot will run on, so the preview is
     * marked `previewVerbatim` rather than masked; a prompt that smells like it holds a secret gets
     * a loud `secretWarning` instead of a quiet rewrite. `imSummary` is the same content flattened
     * for chat channels that cannot open the card.
     */
    const warning = secretWarningFor(data.roleDescription);
    const held = await gated({
      from,
      toolRef: `bot/${CREATE_BOT_TOOL}`,
      effect: "create",
      scope: data.name,
      args: data,
      target: {
        bot: data.name,
        title: data.title,
        prompt: data.roleDescription,
        ...(data.model ? { model: data.model } : {}),
        ...(warning ? { secretWarning: warning } : {}),
        imSummary: imSummary({
          verb: "新建",
          name: data.name,
          title: data.title,
          model: data.model ?? "部署默认",
          prompt: data.roleDescription,
          ...(warning ? { warning } : {}),
        }),
        [PREVIEW_VERBATIM]: [
          "prompt",
          "imSummary",
          ...(warning ? ["secretWarning"] : []),
        ],
      },
      refused: "No Bot was created",
    });
    if (held) return held;

    const actor = await actorFor(from.actorId);
    const by = actor.email ?? from.actorId;
    let result: Awaited<ReturnType<CoworkerService["createCoworker"]>>;
    try {
      result = await coworker.createCoworker(
        actor,
        {
          name: data.name,
          title: data.title,
          roleDescription: data.roleDescription,
        },
        {
          createdByAgentId: from.botId,
          createdDepth: depth + 1,
          ...(data.model ? { model: data.model } : {}),
          audit: { byAgent: from.botId, via: `bot/${CREATE_BOT_TOOL}` },
          within: async (executor, newId) => {
            /*
             * Counted again under a per-person advisory lock, on this transaction: two approved
             * creations racing on separate runs both took the pre-flight count, and without the
             * lock both would pass it and commit. The lock serializes them; the second one reads
             * the first's committed row and fails here instead, rolling its own pair of rows back.
             */
            await executor.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`chisabot:bot-factory:${from.actorId}`}, 0))`,
            );
            if (
              (await queriesWithin(executor).countForUser(from.actorId)) >=
              caps.maxPerUser
            )
              throw new BotFactoryCapError();
            /*
             * Born able to work with its maker, and only that: the two `kind="bot"` grants are all
             * it holds. `agentId` is the one that may address, `ref` the one it may reach.
             */
            await grant("bot", newId, from.botId, by, executor);
            await grant("bot", from.botId, newId, by, executor);
          },
        },
      );
    } catch (error) {
      if (error instanceof BotFactoryCapError) {
        return refuse(from, {
          reason: "per_user_cap",
          target: data.name,
          message: `No Bot was created: this person already has the most Bot-made Bots this deployment allows (${caps.maxPerUser}).`,
        });
      }
      throw error;
    }
    if (!result.ok) return { text: result.error, isError: true };

    const agent = result.agent;
    return {
      text:
        `Created the Bot "${agent.name}" (${agent.id}). ` +
        `It runs on this deployment as a private coworker of this person, and you and it may hand ` +
        `work to each other already (mutualHandoff: true). Tell the person it exists and what it is ` +
        `for; they can talk to it from the Bots list, or change or delete it there. Its details: ` +
        JSON.stringify({
          id: agent.id,
          name: agent.name,
          title: agent.title,
          mutualHandoff: true,
        }),
      isError: false,
    };
  }

  async function listManagedBots(from: RunAssertion) {
    const rows = await queries.managedBy(from.botId, from.actorId);
    return {
      text:
        rows.length === 0
          ? "You have not created any Bots."
          : `Bots you created: ${JSON.stringify(rows)}`,
      isError: false,
    };
  }

  async function updateBot(from: RunAssertion, args: unknown) {
    const parsed = updateParameters.safeParse(args);
    if (!parsed.success) {
      return {
        text: "Nothing was changed: name the Bot's id and at least one field to change.",
        isError: true,
      };
    }
    const data = parsed.data;
    const target = await queries.managedTarget(
      from.botId,
      from.actorId,
      data.id,
    );
    if (!target) {
      return refuse(from, {
        reason: "not_managed",
        target: data.id,
        message:
          "Nothing was changed: that is not a Bot you created. You can only change Bots you made yourself.",
      });
    }
    const changes =
      data.name !== undefined ||
      data.title !== undefined ||
      data.roleDescription !== undefined;
    if (!changes && data.model === undefined) {
      return {
        text: "Nothing was changed: no new name, title, roleDescription or model was given.",
        isError: true,
      };
    }
    if (data.model) {
      const verdict = await modelVerdict(data.model);
      if (!verdict.ok) return { text: verdict.refusal, isError: true };
    }

    /*
     * Same rule as create: the prompt the card shows is the prompt that will run, byte-for-byte,
     * so `prompt` (the new text when the edit touches it, the stored one when it does not),
     * `previousPrompt` and `promptDiff` are all `previewVerbatim`. A secret-looking prompt earns a
     * `secretWarning`, never a rewrite.
     */
    const promptChanging = data.roleDescription !== undefined;
    const previewPrompt = data.roleDescription ?? target.roleDescription;
    const warning = secretWarningFor(previewPrompt);
    const held = await gated({
      from,
      toolRef: `bot/${UPDATE_BOT_TOOL}`,
      effect: "update",
      scope: data.id,
      args: data,
      target: {
        bot: data.id,
        name: data.name ?? target.name,
        title: data.title ?? target.title,
        prompt: previewPrompt,
        ...(promptChanging
          ? {
              previousPrompt: target.roleDescription,
              promptDiff: lineDiff(
                target.roleDescription,
                data.roleDescription ?? "",
              ),
            }
          : {}),
        ...(data.model ? { model: data.model } : {}),
        ...(warning ? { secretWarning: warning } : {}),
        imSummary: imSummary({
          verb: "更新",
          name: data.name ?? target.name,
          title: data.title ?? target.title,
          model: data.model ?? "保持不变",
          prompt: previewPrompt,
          ...(warning ? { warning } : {}),
        }),
        [PREVIEW_VERBATIM]: [
          "prompt",
          "imSummary",
          ...(promptChanging ? ["previousPrompt", "promptDiff"] : []),
          ...(warning ? ["secretWarning"] : []),
        ],
      },
      refused: "Nothing was changed",
    });
    if (held) return held;

    const actor = await actorFor(from.actorId);
    if (changes) {
      /*
       * The same write the form's PATCH makes — required fields are filled from the stored row, so
       * a one-field edit does not blank the rest. It cannot touch visibility, the owner, an
       * endpoint or a key: those are simply absent from the tool's parameters.
       */
      const result = await coworker.updateCoworker(
        actor,
        data.id,
        {
          name: data.name ?? target.name,
          title: data.title ?? target.title,
          roleDescription: data.roleDescription ?? target.roleDescription,
        },
        { audit: { byAgent: from.botId, via: `bot/${UPDATE_BOT_TOOL}` } },
      );
      if (!result.ok) return { text: result.error, isError: true };
    }
    if (data.model && setModel) {
      try {
        await setModel(actor, data.id, data.model);
      } catch (error) {
        return {
          text: `The profile was updated, but the model was not: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    }
    return {
      text: `Updated the Bot "${data.name ?? target.name}" (${data.id}).`,
      isError: false,
    };
  }

  async function disableBot(from: RunAssertion, args: unknown) {
    const parsed = disableParameters.safeParse(args);
    if (!parsed.success) {
      return { text: "Nothing was stopped: name the Bot's id.", isError: true };
    }
    const data = parsed.data;
    const target = await queries.managedTarget(
      from.botId,
      from.actorId,
      data.id,
    );
    if (!target) {
      return refuse(from, {
        reason: "not_managed",
        target: data.id,
        message:
          "Nothing was stopped: that is not a Bot you created. You can only disable Bots you made yourself.",
      });
    }

    const held = await gated({
      from,
      toolRef: `bot/${DISABLE_BOT_TOOL}`,
      effect: "disable",
      scope: data.id,
      args: data,
      target: { bot: data.id, name: target.name },
      refused: "Nothing was stopped",
    });
    if (held) return held;

    const actor = await actorFor(from.actorId);
    const stopped = await pause(from.actorId, data.id);
    await coworker.record(actor, "bot.paused", data.id, {
      stoppedTurns: stopped,
      byAgent: from.botId,
      via: `bot/${DISABLE_BOT_TOOL}`,
    });
    return {
      text:
        `"${target.name}" (${data.id}) is paused: it will not take turns or handoffs until it is ` +
        `resumed. The person can switch it back on from the Bot's lifecycle page — disabling is ` +
        `reversible, nothing was deleted.`,
      isError: false,
    };
  }

  const tool = (
    name: string,
    description: string,
    parameters: z.ZodType,
    execute: (args: unknown) => Promise<{ text: string; isError: boolean }>,
  ): GrantedTool => ({
    name,
    ref: `bot/${name}`,
    description,
    parameters,
    execute: async (args) => (await execute(args)).text,
  });

  return {
    /**
     * What this run may see, under the deployment's own offer rule: nothing at all when the factory
     * is off or this Bot is already a Bot-made Bot at the cap.
     *
     * Not offered rather than offered-and-refused — a model shown a tool it may never use spends
     * attention on it and tells the person it tried. `call` re-checks the same conditions, so a
     * stale schema or a resumed approval still gets a refusal instead of an action.
     */
    async toolsFor(from: RunAssertion): Promise<GrantedTool[]> {
      if (caps.maxDepth <= 0 || caps.maxPerUser <= 0) return [];
      const depth = await queries.depthOf(from.botId);
      if (depth === null || depth >= caps.maxDepth) return [];
      return [
        tool(
          CREATE_BOT_TOOL,
          "Create a new Bot for this person: give it a name, a title, and the instruction it " +
            "runs on. It is private to this person, runs on this deployment, and you and it may " +
            "hand work to each other afterwards. Creating one asks the person first.",
          createParameters,
          (args) => createBot(from, args),
        ),
        tool(
          LIST_MANAGED_BOTS_TOOL,
          "List the Bots you created that are still live: their ids, names, whether they are paused.",
          listParameters,
          () => listManagedBots(from),
        ),
        tool(
          UPDATE_BOT_TOOL,
          "Change a Bot you created: its name, title, the instruction it runs on, or its catalog " +
            "model. Only Bots you made yourself can be changed. Changing one asks the person first.",
          updateParameters,
          (args) => updateBot(from, args),
        ),
        tool(
          DISABLE_BOT_TOOL,
          "Pause a Bot you created so it stops taking turns and handoffs. Reversible — the person " +
            "can resume it. You cannot delete Bots. Disabling one asks the person first.",
          disableParameters,
          (args) => disableBot(from, args),
        ),
      ];
    },

    async call(input: {
      name: string;
      args: Record<string, unknown>;
      run: RunAssertion;
    }): Promise<{ text: string; isError: boolean } | null> {
      const name = input.name.replace(/^bot\//, "");
      if (!BOT_FACTORY_TOOL_NAMES.has(name)) return null;
      switch (name) {
        case CREATE_BOT_TOOL:
          return createBot(input.run, input.args);
        case LIST_MANAGED_BOTS_TOOL:
          return listManagedBots(input.run);
        case UPDATE_BOT_TOOL:
          return updateBot(input.run, input.args);
        case DISABLE_BOT_TOOL:
          return disableBot(input.run, input.args);
        default:
          return null;
      }
    },
  };
}
