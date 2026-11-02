import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import { testAgentConnection } from "./connection-test";
import { canDeleteAgent, canManageAgent } from "./profile-policy";
import type { AgentPurge } from "./purge";
import {
  AgentNotFoundError,
  AgentAssignedError,
  AgentNotManageableError,
  type AgentProfileStore,
  ManagedAgentUnavailableError,
  ProtectedAgentError,
} from "./profile-store";
import type { AgentActor, AgentProfile } from "./profile-types";
import {
  createCoworkerService,
  DEV_ACTOR_EMAIL,
  parseAgentInput,
  unsendableHeaderValue,
} from "./service";

// The input parser moved into the shared service; re-exported so existing importers keep working.
export { parseAgentInput };

/**
 * Parse and validate the headers a person attaches to a connection test.
 *
 * Unvalidated, the route cast any object straight into the probe `fetch`, so an array value, a
 * nested object, or a `__proto__` key travelled into the network call and threw a TypeError 500 —
 * or probed header handling the deployment never meant to exercise. Names follow the same rule as
 * the stored agent auth header; values must be strings; the whole map is capped so a pasted dump
 * cannot balloon the probe.
 */
export function parseConnectionHeaders(
  input: unknown,
):
  | { ok: true; value: Record<string, string> | undefined }
  | { ok: false; error: string } {
  if (input === undefined) return { ok: true, value: undefined };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Headers must be an object of name to value." };
  }
  /*
   * A JSON body carrying `__proto__` does not arrive as an own property: `JSON.parse` sets the
   * object's prototype instead, so `Object.entries` never sees it and a name block-list below
   * would pass it straight through into the probe fetch. Refuse any headers object whose prototype
   * is not a plain one before reading entries.
   */
  if (Object.getPrototypeOf(input) !== Object.prototype) {
    return { ok: false, error: "Headers must be an object of name to value." };
  }
  const entries = Object.entries(input);
  if (entries.length > 32) {
    return { ok: false, error: "Headers must have at most 32 entries." };
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      name === "__proto__" ||
      name === "constructor" ||
      name === "prototype" ||
      !/^[A-Za-z0-9-]+$/.test(name) ||
      name.length > 64
    ) {
      return {
        ok: false,
        error: `That is not a valid header name: ${name.slice(0, 64)}.`,
      };
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        error: `Header "${name}" must be a string value.`,
      };
    }
    if (value.length > 4096) {
      return {
        ok: false,
        error: `Header "${name}" must be at most 4096 characters.`,
      };
    }
    const unsendable = unsendableHeaderValue(value);
    if (unsendable) {
      return {
        ok: false,
        error: `Header "${name}" contains ${unsendable}, so it cannot be sent.`,
      };
    }
    headers[name] = value;
  }
  return { ok: true, value: entries.length === 0 ? undefined : headers };
}

export function createAgentRoutes(
  store: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Whether this deployment may talk to its own network. True on a laptop, false when hosted. */
  allowPrivateHosts = false,
  /** Where a Bot's own refusal is recorded. Absent in tests that do not care about the trail. */
  auditStore?: AuditStore,
  /**
   * Private addresses this deployment named as acceptable for an agent to live at.
   *
   * Separate from `allowPrivateHosts` on purpose: that one opens the network, this one opens an
   * address. A hosted deployment sets this and leaves the other off.
   */
  allowedHosts: ReadonlySet<string> = new Set(),
  /**
   * Which Bots a Bot may hand work to, for the screen that grants it.
   *
   * A named object rather than another positional argument: every parameter above this one is
   * optional, so a misplaced one typechecks and silently does nothing, and this list is already at
   * the length where that stops being hypothetical.
   *
   * Absent in a deployment with no plugin store, which is a deployment where no Bot may address any
   * other. The screen is then told the capability is off rather than shown a control that grants
   * nothing.
   */
  handoff?: {
    /** Whether the deployment's own caps leave the capability switched on at all. */
    enabled: boolean;
    /** The Bots this one may address today, read per call so a revoked grant stops showing. */
    reachableFrom: (agentId: string) => Promise<readonly string[]>;
    /**
     * Whether this Bot can be a grantee at all: any Bot that exists, built in or at its own
     * endpoint, since both reach the same handoff desk. Optional so a caller without a plugin store
     * answers "no" rather than crashing the read.
     */
    canHandOn?: (agentId: string) => Promise<boolean | undefined>;
  },
  /**
   * Whether a coworker can run on this deployment's own Bot, i.e. be created with no endpoint.
   *
   * The store already refuses such a create on a deployment with no managed Bot; this exists so a
   * screen can say so before somebody fills in three steps of a form that was always going to fail.
   */
  builtInAvailable = false,
  /**
   * The managed Bot's own address, so a coworker created without an endpoint can be told apart.
   *
   * Creation bakes this address into the coworker's stored configuration, and afterwards nothing in
   * the row says whether a person supplied it. The difference matters to exactly one screen: a
   * coworker running here calls tools back with the deployment's own credential and needs no setup,
   * while one a person hosts needs a callback token put into their process. Without this flag the
   * dialog nagged built-in coworkers about a credential they never needed.
   */
  managedEndpoint?: string,
  /**
   * What finishes a deletion: the Bot's private data, its panels, the main-Bot preference, and the
   * row itself. Absent in tests, where a delete is the profile's soft delete alone.
   */
  purge?: AgentPurge,
) {
  /** The dto with the one fact only this closure knows: whether the coworker runs on our own Bot. */
  const dto = (actor: AgentActor, agent: AgentProfile) => ({
    ...agentDto(actor, agent),
    // A string comparison on purpose: two absent values must not read as "runs on our Bot".
    builtIn:
      typeof agent.endpoint === "string" && agent.endpoint === managedEndpoint,
  });
  /*
   * Create and update are shared with the bot factory (a Bot's `create_bot`/`update_bot` tools go
   * through the same parse, store call and audit row). The other lifecycle writes stay on their
   * routes; the shared service's `record` is what the local helper delegates to.
   */
  const coworker = createCoworkerService({
    store,
    allowPrivateHosts,
    allowedHosts,
    ...(auditStore ? { auditStore } : {}),
  });
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * The Bot declined something, and says so.
   *
   * The audit trail records what a Bot did, decided by the gateway on the way to an action. A model
   * that refuses before calling any tool takes no action, so this records the attempted request.
   *
   * Self-reported, and said so in the row. The Bot calls this because its tool description tells it
   * to, so a model that declines without a tool call still writes nothing. This is evidence, not enforcement:
   * nothing is prevented by it, and a reader must not mistake an empty list for an untroubled Bot.
   */
  routes.post("/:agentId/declined", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    const body = (await context.req.json().catch(() => null)) as {
      reason?: unknown;
      request?: unknown;
    } | null;

    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) {
      return context.json({ error: "A reason is required." }, 400);
    }

    /*
     * The same question every other route here asks first: is this a Bot the caller may reach?
     *
     * The row says "reportedBy: the Bot itself", and the Bot reports through the person's session,
     * so the trail's only way of knowing the report came from a Bot is that the person could have
     * been talking to that Bot. Without this check, any signed-in person could write a decline
     * against any id at all, a coworker they cannot see included, and an administrator reading the
     * trail would take it for something the Bot said. Not found rather than forbidden, as the store
     * answers everywhere else, so the check does not confirm which ids exist.
     */
    const agent = await store.get(context.var.actor, agentId);
    if (!agent) {
      return context.json({ error: "Agent not found." }, 404);
    }

    if (auditStore) {
      const actor = context.var.actor;
      await recordAuditEvent(auditStore, {
        eventType: "bot.declined",
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: {
          bot: agentId,
          actor: actor?.email ?? "unknown",
          reason: reason.slice(0, 500),
          // What it was asked, in the Bot's own words and only if it offered them. Truncated for the
          // same reason every other payload here is: a trail is not a transcript.
          ...(typeof body?.request === "string" && body.request.trim()
            ? { request: body.request.trim().slice(0, 500) }
            : {}),
          reportedBy: "the Bot itself",
        },
      });
    }

    return context.json({ recorded: true });
  });

  routes.get("/", requireUser, async (context) => {
    try {
      const hidden = context.req.query("hidden") === "true";
      let agents = await store.list(context.var.actor, hidden);
      let seededDefault = false;
      /*
       * 首次使用：一个机器人都看不到的人第一次读列表时，给他建一个私有的「助手」（见 `ensureDefaultBot`）。
       * 只在普通列表为空时才问；失败只记日志，列表照常返回，下次读取再试。
       */
      if (!hidden && agents.length === 0 && store.ensureDefaultBot) {
        try {
          if (await store.ensureDefaultBot(context.var.actor)) {
            agents = await store.list(context.var.actor, false);
            seededDefault = true;
          }
        } catch (error) {
          console.error("[agents] default bot seeding failed", error);
        }
      }
      // 多账号（CB-040）：管理员能管理所有机器人，但聊天列表里不出现朋友的私有机器人。
      const me = context.var.actor;
      if (me.role === "admin")
        agents = agents.filter(
          (agent) => agent.visibility !== "private" || !agent.ownerUserId || agent.ownerUserId === me.id || agent.systemOwned || agent.assignedToMe,
        );
      return context.json({
        agents: agents.map((agent) => dto(context.var.actor, agent)),
        // 刚建了默认「助手」（同时可能写了偏好里的 mainBotId）：前端据此刷新偏好，主机器人星标立刻出现。
        ...(seededDefault ? { seededDefault: true } : {}),
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * What kinds of coworker this deployment can create, for the screen that asks.
   *
   * Static per process: whether a managed Bot exists is deployment configuration, not data. Above
   * the parameterised route on purpose, so "capabilities" can never be read as an agent id.
   */
  routes.get("/capabilities", requireUser, (context) =>
    context.json({ capabilities: { builtInAvailable } }),
  );

  routes.get("/:agentId", requireUser, async (context) => {
    // A whitespace id would reach the store query and answer 500 on some backends instead of a
    // 400 for a malformed call. Existence stays a 404; shape is checked here.
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      const agent = await store.get(
        context.var.actor,
        context.req.param("agentId"),
      );
      if (!agent) {
        return context.json({ error: "Agent not found." }, 404);
      }
      return context.json({ agent: dto(context.var.actor, agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * Try an endpoint before saving it.
   *
   * Deliberately not part of create: a person needs to know whether their agent answers before they
   * commit to it, and they need to be able to try again without creating dead
   * Bots on the way. It runs the same target check as saving, so it cannot probe addresses that
   * registration would refuse.
   */
  routes.post("/test-connection", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      endpoint?: unknown;
      headers?: unknown;
    } | null;
    const parsed = parseConnectionHeaders(body?.headers);
    if (!parsed.ok) {
      return context.json({ error: parsed.error }, 400);
    }
    const headers = parsed.value;
    const result = await testAgentConnection(body?.endpoint, {
      headers,
      allowPrivateHosts,
      allowedHosts,
    });
    // 200 either way: the request succeeded, and the verdict is the payload. A failed connection test
    // is an answer, not an error, and a 4xx here would have the surface render it as a broken button.
    return context.json(result);
  });

  /**
   * Record something that changed a Bot.
   *
   * One helper rather than eight copies, because the eight routes below all answer the same question
   * and the payload has to be the same shape for a reader filtering the trail.
   *
   * Never fatal. The change is already made and the caller has been told so; a trail that is briefly
   * unavailable is not a reason to report a failure that did not happen.
   */
  const record = async (
    context: Context<{ Variables: AppVariables }>,
    eventType: Parameters<typeof coworker.record>[1],
    agentId: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    await coworker.record(context.var.actor, eventType, agentId, payload);
  };

  routes.post("/", requireUser, async (context) => {
    try {
      const result = await coworker.createCoworker(
        context.var.actor,
        // Malformed JSON is a recoverable client-input error and is validated by the same parser.
        await context.req.json().catch(() => null),
      );
      if (!result.ok) return context.json({ error: result.error }, 400);
      return context.json({ agent: dto(context.var.actor, result.agent) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.patch("/:agentId", requireUser, async (context) => {
    try {
      const result = await coworker.updateCoworker(
        context.var.actor,
        context.req.param("agentId"),
        // Malformed JSON is a recoverable client-input error and is validated by the same parser.
        await context.req.json().catch(() => null),
      );
      if (!result.ok) return context.json({ error: result.error }, 400);
      return context.json({ agent: dto(context.var.actor, result.agent) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/duplicate", requireUser, async (context) => {
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      const agent = await store.duplicate(
        context.var.actor,
        context.req.param("agentId"),
      );
      // Recorded against the copy, naming the original: a duplicate inherits an endpoint, so the
      // reader needs to know a second Bot now points at it.
      await record(context, "bot.duplicated", agent.id, {
        copiedFrom: context.req.param("agentId"),
      });
      return context.json({ agent: dto(context.var.actor, agent) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/hide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        true,
      );
      await record(context, "bot.hidden", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/unhide", requireUser, async (context) => {
    try {
      await store.setHidden(
        context.var.actor,
        context.req.param("agentId"),
        false,
      );
      await record(context, "bot.unhidden", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/pin", requireUser, async (context) => {
    try {
      await store.setPinned(
        context.var.actor,
        context.req.param("agentId"),
        true,
      );
      await record(context, "bot.pinned", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:agentId/unpin", requireUser, async (context) => {
    try {
      await store.setPinned(
        context.var.actor,
        context.req.param("agentId"),
        false,
      );
      await record(context, "bot.unpinned", context.req.param("agentId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * Issue this agent its callback credential, and show it once.
   *
   * A POST because it writes and because it replaces: calling it again rotates, which is how a leaked
   * token is retired. The token is in the response and nowhere else, ever again, and it is not written
   * to the audit payload either: a trail that records credentials is a credential store with worse
   * access control.
   */
  routes.post("/:agentId/callback-token", requireUser, async (context) => {
    try {
      const token = await store.issueCallbackToken(
        context.var.actor,
        context.req.param("agentId"),
      );
      // That one was issued, never what it is. A trail that records credentials is a credential
      // store with worse access control.
      await record(
        context,
        "bot.callback_token_issued",
        context.req.param("agentId"),
      );
      return context.json({ token }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /** Take it away. The agent may still hold a conversation; it may not reach anything outside one. */
  routes.delete("/:agentId/callback-token", requireUser, async (context) => {
    try {
      await store.revokeCallbackToken(
        context.var.actor,
        context.req.param("agentId"),
      );
      await record(
        context,
        "bot.callback_token_revoked",
        context.req.param("agentId"),
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /** Finish off Bots that were deleted before deletion was complete (or whose purge failed). */
  routes.post("/deleted/purge", requireUser, async (context) => {
    if (!purge) return context.json({ purged: [] });
    const purged = await purge.purgeDeleted(context.var.actor);
    for (const report of purged)
      await record(context, "bot.deleted", report.agentId, { purged: report });
    return context.json({ purged });
  });

  routes.delete("/:agentId", requireUser, async (context) => {
    if (!context.req.param("agentId").trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      const agentId = context.req.param("agentId");
      await store.softDelete(context.var.actor, agentId);
      // The soft delete above is what checks the caller may do this; the purge only ever touches a
      // Bot that is already deleted. A failure here leaves a tombstone that `deleted/purge` retries.
      let purged: Awaited<ReturnType<AgentPurge["purge"]>> | null = null;
      if (purge) {
        try {
          purged = await purge.purge(context.var.actor, agentId);
        } catch (error) {
          console.error(`[agents] purge after deleting ${agentId} failed:`, error);
        }
      }
      await record(context, "bot.deleted", agentId, purged ? { purged } : {});
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * Which Bots this Bot may hand work to.
   *
   * On the Bot's own screen rather than under the connector catalogue, because it is a fact about
   * this Bot and not about a vendor: the catalogue's entries have a fixed list of tools, and the
   * Bots a deployment has are whatever somebody made.
   *
   * `enabled` is reported separately from the grants, because the two fail differently. A grant with
   * the capability switched off is a row in the database that will never be read, and a screen that
   * offered it without saying so would be a switch wired to nothing.
   */
  routes.get("/:agentId/handoff", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!agentId.trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      // Asked of the store, so a Bot somebody may not see is "not found" here as everywhere else,
      // rather than a list of who it can reach.
      const agent = await store.get(context.var.actor, agentId);
      if (!agent) return context.json({ error: "Agent not found." }, 404);
      return context.json({
        handoff: {
          enabled: handoff?.enabled ?? false,
          // Granting is an administrator's, the same as it is on every other grant.
          canGrant: context.var.actor.role === "admin",
          reachable: handoff ? await handoff.reachableFrom(agentId) : [],
          // Whether this Bot can hold such a grant at all; the write path refuses one that cannot,
          // and the screen should say so before a person flips switches that can only bounce.
          grantable: handoff?.canHandOn
            ? ((await handoff.canHandOn(agentId)) ?? false)
            : false,
        },
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function agentDto(actor: AgentActor, agent: AgentProfile) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    roleDescription: agent.roleDescription,
    avatarSeed: agent.avatarSeed,
    visibility: agent.visibility,
    hidden: agent.hidden,
    pinned: agent.pinned,
    systemOwned: agent.systemOwned,
    // Published so the edit form can show it. Safe to expose: it is an address the person supplied,
    // and any credential for it lives in the vault, never in this row.
    endpoint: agent.endpoint,
    hasAuth: agent.hasAuth,
    // Whether one exists, never what it is.
    hasCallbackToken: agent.hasCallbackToken,
    canManage: canManageAgent(actor, agent),
    // 删除和修改分开：部署包机器人不能改，但管理员可以删（见 canDeleteAgent）。
    canDelete: canDeleteAgent(actor, agent),
    // Ownership, kept separate from permission. `canManage` is also true for an administrator on
    // another user's coworker, so a roster that split "mine" on it would file other people's work
    // under yours, and only for administrators, who are the least likely to notice.
    mine: agent.ownerUserId === actor.id,
    assignedToMe: agent.assignedToMe ?? false,
    // Which Bot made this one, when one did. The roster badges it "由 X 创建"; a person-made Bot is null.
    createdByAgentId: agent.createdByAgentId,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof AgentNotManageableError) {
    return context.json(
      { error: "You do not have permission to manage this agent." },
      403,
    );
  }
  if (error instanceof ProtectedAgentError) {
    return context.json({ error: "System-owned agents are protected." }, 403);
  }
  if (error instanceof ManagedAgentUnavailableError) {
    return context.json({ error: error.message }, 400);
  }
  if (error instanceof AgentAssignedError) {
    return context.json({ error: error.message }, 409);
  }
  throw error;
}
