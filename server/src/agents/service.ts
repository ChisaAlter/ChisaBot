/**
 * The shared create and update behind `POST /api/agents` and `PATCH /api/agents/:id`.
 *
 * Extracted rather than left on the routes so the bot factory — one Bot creating another with a
 * tool — stores and validates a coworker exactly the way the form does, without calling its own
 * deployment's HTTP routes. The routes keep their status codes and their DTO; everything between
 * the parser and the audit row lives here once.
 */
import {
  type AuditEventType,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import { checkAgentEndpoint } from "./endpoint";
import type { AgentProfileStore, ProfileWriteExecutor } from "./profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "./profile-types";

type AgentInputParseResult =
  | { ok: true; value: CreateAgentInput }
  | { ok: false; error: string };

type AgentInputObject = {
  name?: unknown;
  title?: unknown;
  roleDescription?: unknown;
  visibility?: unknown;
  endpoint?: unknown;
  auth?: unknown;
};

/**
 * Parse and validate what a user typed into the agent form.
 *
 * `allowPrivateHosts` is passed in rather than read from configuration here so this stays a pure
 * function: a developer's own agent lives on localhost, and a hosted deployment must refuse exactly
 * that, so the answer depends on the deployment and the test suite needs to exercise both.
 */
export function parseAgentInput(
  input: unknown,
  allowPrivateHosts = false,
  /** Private addresses this deployment named as acceptable. Empty is the default posture. */
  allowedHosts: ReadonlySet<string> = new Set(),
): AgentInputParseResult {
  if (!isAgentInputObject(input)) {
    return { ok: false, error: "Agent input must be a JSON object." };
  }

  const name = boundedText(
    input.name,
    80,
    "Name must be text between 1 and 80 characters.",
  );
  if (typeof name !== "string") return name;

  const title = boundedText(
    input.title,
    120,
    "Title must be text between 1 and 120 characters.",
  );
  if (typeof title !== "string") return title;

  const roleDescription = boundedText(
    input.roleDescription,
    1000,
    "Role description must be text between 1 and 1000 characters.",
  );
  if (typeof roleDescription !== "string") return roleDescription;

  /*
   * 所有机器人都是私有的（2026-10-14 用户：「所有的机器人都是私有」，DESIGN.md §46）。界面不再提供
   * 「公开」，这里也不再接受：旧客户端照旧发 visibility 也不报错，但不管发什么都按私有存。
   */
  const visibility = "private" as const;

  // The endpoint is optional and checked. Absent means the Bot in the box, which is what most people
  // want on their first go. Present means this server will POST to an address a person chose, so it
  // goes through the same target check as navigation before it is allowed anywhere near the database.
  let endpoint: string | undefined;
  if (input.endpoint !== undefined && input.endpoint !== "") {
    const verdict = checkAgentEndpoint(input.endpoint, {
      allowPrivateHosts,
      allowedHosts,
    });
    if (!verdict.allowed) return { ok: false, error: verdict.reason };
    endpoint = verdict.url;
  }

  // The key is optional and write-only. An absent field leaves an existing key alone; sending one
  // replaces it. There is no way to read one back, here or anywhere.
  let auth: { header: string; value: string } | undefined;
  if (input.auth !== undefined && input.auth !== null) {
    const supplied = input.auth as { header?: unknown; value?: unknown };
    const value =
      typeof supplied.value === "string" ? supplied.value.trim() : "";
    if (value) {
      const header =
        typeof supplied.header === "string" && supplied.header.trim()
          ? supplied.header.trim()
          : "Authorization";
      if (!/^[A-Za-z0-9-]+$/.test(header)) {
        return { ok: false, error: "That is not a valid header name." };
      }
      // Refused here rather than discovered on the first run. This value is encrypted and stored,
      // and then sent as a header on every turn the Bot takes; one that cannot be a header value
      // throws inside `fetch` every one of those times, long after the form said it was saved.
      const unsendable = unsendableHeaderValue(value);
      if (unsendable) {
        return {
          ok: false,
          error: `That key contains ${unsendable}, so it cannot be sent as a header.`,
        };
      }
      auth = { header, value };
    }
  }

  return {
    ok: true,
    value: { name, title, roleDescription, visibility, endpoint, auth },
  };
}

function isAgentInputObject(input: unknown): input is AgentInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * What in this value stops it being a header, or null when nothing does.
 *
 * `new Headers()` refuses a line break, a NUL, and any code point above U+00FF, and it refuses them
 * by throwing a TypeError from inside `fetch` — which is not a decision this deployment gets to
 * take part in. Both surfaces below take a header value from the same box on the same form and
 * neither looked, so the throw arrived somewhere that reads as something else entirely: on the
 * connection test it lands in the catch written for a dead host, and the person is told "this server
 * could not reach that address", which sends them to their tunnel and their firewall over a key
 * they had just pasted with a wrapped line in it. A hyphen a document turned into an en dash does
 * the same thing, and looks like nothing at all in a password box.
 *
 * The description never contains the value. This is asked of a credential on one of the two paths,
 * and one character of a secret in an error message is one character too many.
 */
export function unsendableHeaderValue(value: string): string | null {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d) return "a line break";
    if (code === 0) return "a null character";
    if (code > 0xff) return "a character that cannot go in a header value";
  }
  return null;
}

function boundedText(
  value: unknown,
  maximumLength: number,
  error: string,
): string | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error };
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength
    ? trimmed
    : { ok: false, error };
}

/**
 * The local development actor, which is not a row in `users`.
 *
 * The audit table has a foreign key to that table, so writing this id would fail the constraint and
 * lose the row entirely. Who it was is in the payload either way.
 */
export const DEV_ACTOR_EMAIL = "dev@openbot.local";

/** Whoever asked for the coworker: the signed-in person on the routes, the run's owner from a tool. */
export type CoworkerActor = AgentActor & { email?: string };

export type CoworkerServiceDeps = {
  store: AgentProfileStore;
  /** Whether this deployment may talk to its own network. True on a laptop, false when hosted. */
  allowPrivateHosts?: boolean;
  /** Private addresses this deployment named as acceptable. */
  allowedHosts?: ReadonlySet<string>;
  /** Where a change to a Bot is recorded. Absent in tests that do not care about the trail. */
  auditStore?: AuditStore;
};

/** What a Bot-made coworker carries that a form-made one does not. */
export type CreateCoworkerOptions = {
  /** The Bot creating this one; absent means a person did, which is the default everywhere else. */
  createdByAgentId?: string;
  /** The creating Bot's depth plus one. Read back by the factory's own depth cap. */
  createdDepth?: number;
  /** A catalog model to run on, already validated by the caller. */
  model?: string;
  /**
   * Same-transaction work: the per-user cap re-check and the grants a Bot-made coworker is born
   * holding. See `AgentProfileStore.create`.
   */
  within?: (executor: ProfileWriteExecutor, agentId: string) => Promise<void>;
  /** Extra payload keys on the `bot.created` row (the factory's `byAgent` and `via`). */
  audit?: Record<string, unknown>;
};

export type UpdateCoworkerOptions = {
  /** Extra payload keys on the `bot.updated` row. */
  audit?: Record<string, unknown>;
};

export type CoworkerResult =
  | { ok: true; agent: AgentProfile }
  | { ok: false; error: string };

export function createCoworkerService(deps: CoworkerServiceDeps) {
  /**
   * Record something that changed a Bot.
   *
   * One helper rather than eight copies, because every route and tool answers the same question and
   * the payload has to be the same shape for a reader filtering the trail.
   *
   * Never fatal. The change is already made and the caller has been told so; a trail that is briefly
   * unavailable is not a reason to report a failure that did not happen.
   */
  const record = async (
    actor: CoworkerActor,
    eventType: Extract<AuditEventType, `bot.${string}`>,
    agentId: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> => {
    if (!deps.auditStore) return;
    try {
      await recordAuditEvent(deps.auditStore, {
        eventType,
        targetType: "agent",
        targetId: agentId,
        ...(actor?.id && actor.email !== DEV_ACTOR_EMAIL
          ? { actorUserId: actor.id }
          : {}),
        payload: { bot: agentId, actor: actor?.email ?? "unknown", ...payload },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "bot-audit-write-failed",
          eventType,
          agentId,
          error: String(error),
        }),
      );
    }
  };

  return {
    /**
     * Create a coworker exactly the way `POST /api/agents` does.
     *
     * Store errors propagate to the caller, which maps them the way the route always has; a parse
     * failure is the one outcome this layer answers itself, because the tool path has no 400 to send.
     */
    async createCoworker(
      actor: CoworkerActor,
      input: unknown,
      options: CreateCoworkerOptions = {},
    ): Promise<CoworkerResult> {
      const parsed = parseAgentInput(
        input,
        deps.allowPrivateHosts,
        deps.allowedHosts,
      );
      if (!parsed.ok) return { ok: false, error: parsed.error };

      /*
       * A coworker with no address runs here, on the text this form already requires.
       *
       * "Agent endpoint (optional)" was not optional on the recommended one-container image: with
       * nothing to bind to, `create` refused with "This deployment has no managed Bot", so a person
       * could not make a coworker at all on the image the README tells them to deploy. The role
       * description is what such a coworker runs on — the same field a `built_in` Bot in the tenant
       * package carries, for the same purpose — and passing it only when no endpoint was given keeps
       * every other path exactly as it was: give an address and it is a remote Bot, as before.
       */
      const agent = await deps.store.create(
        actor,
        {
          ...parsed.value,
          ...(parsed.value.endpoint
            ? {}
            : { systemPrompt: parsed.value.roleDescription }),
          ...(options.createdByAgentId
            ? {
                createdByAgentId: options.createdByAgentId,
                createdDepth: options.createdDepth ?? 0,
              }
            : {}),
          ...(options.model ? { model: options.model } : {}),
        },
        options.within,
      );
      /*
       * The endpoint, because that is where conversation content will be sent, and whether a key was
       * attached, because "this Bot authenticates" is a fact and the key itself never is.
       *
       * And who may reach it. `visibility` is not a display preference: `accessFilter` admits a
       * `public` coworker to every signed-in person, and `canRunAgent` is `canAccessAgent`, so public
       * means everybody in the deployment may act as this Bot and spend the grants it holds. A row
       * that cannot say which it was cannot reconstruct who could use this coworker at the time.
       */
      await record(actor, "bot.created", agent.id, {
        name: parsed.value.name,
        visibility: parsed.value.visibility,
        ...(parsed.value.endpoint ? { endpoint: parsed.value.endpoint } : {}),
        hasKey: Boolean(parsed.value.auth),
        ...(options.audit ?? {}),
      });
      return { ok: true, agent };
    },

    /** Update a coworker exactly the way `PATCH /api/agents/:id` does. */
    async updateCoworker(
      actor: CoworkerActor,
      agentId: string,
      input: unknown,
      options: UpdateCoworkerOptions = {},
    ): Promise<CoworkerResult> {
      const parsed = parseAgentInput(
        input,
        deps.allowPrivateHosts,
        deps.allowedHosts,
      );
      if (!parsed.ok) return { ok: false, error: parsed.error };

      const agent = await deps.store.update(actor, agentId, parsed.value);
      /*
       * What changed, not the new values. Repointing the endpoint is the dangerous edit and is worth
       * naming; a replaced key is worth knowing about and is never worth recording.
       *
       * `visibility` is carried the way `name` is — on every row, whether or not this edit moved it —
       * because it is the second dangerous edit and the route has no before to compare against.
       * Public admits every signed-in person to this coworker, and `canRunAgent` is `canAccessAgent`,
       * so it hands them the right to act as it and spend what it was granted. Without the value on
       * each row, an edit that opened a coworker to the whole deployment is byte-identical to one
       * that corrected its title, and the trail cannot say when it was opened or by whom. Recorded on
       * every row rather than only on the row that changed it, so reading the trail forward tells you
       * what was reachable at any point, which is what an incident asks.
       */
      await record(actor, "bot.updated", agent.id, {
        name: parsed.value.name,
        visibility: parsed.value.visibility,
        ...(parsed.value.endpoint ? { endpoint: parsed.value.endpoint } : {}),
        ...(parsed.value.auth ? { keyReplaced: true } : {}),
        ...(options.audit ?? {}),
      });
      return { ok: true, agent };
    },

    /** The shared audit writer, for callers that changed a Bot through a path this service has no verb for. */
    record,
  };
}

export type CoworkerService = ReturnType<typeof createCoworkerService>;
