import type {
  ActorContext,
  Json,
  PanelBinding,
  PanelCapability,
} from "../../../shared/panels/types";
import type { Database } from "../db/client";
import type { PanelStore } from "./store";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  assertBoundedJson,
  canonicalJson,
  stateMatches,
} from "../../../shared/panels/state-schema";
import { PanelError } from "../../../shared/panels/types";
import {
  botPanelInstances,
  botPanelInstanceVersions,
  panelCapabilityGrants,
  panelTaskRequests,
} from "../db/schema/panels";
export type FrozenPanelTask = {
  id: string;
  actorId: string;
  botId: string;
  instanceId: string;
  instanceVersion: number;
  args: Json;
  action: string;
  adapter: string;
  runId: string | null;
  channelId: string | null;
  threadId: string | null;
};
export type PanelAdapter = {
  definition: PanelCapability;
  read?: (ctx: ActorContext, args: Json, signal: AbortSignal) => Promise<Json>;
  execute?: (request: FrozenPanelTask) => Promise<{ runId: string }>;
  query?: (request: FrozenPanelTask) => Promise<{
    status: "running" | "waiting" | "unknown" | "succeeded" | "failed";
    replyText?: string;
  }>;
  cancel?: (request: FrozenPanelTask) => Promise<void>;
};
export function capabilityHash(cap: PanelCapability) {
  return createHash("sha256").update(canonicalJson(cap)).digest("hex");
}
type TaskRow = typeof panelTaskRequests.$inferSelect;
type MetadataAudit = {
  actorId: string;
  botId: string;
  instanceId: string;
  instanceVersion: number;
  capabilityId: string;
  operation: "read" | "request" | "confirm" | "cancel" | "grant" | "revoke";
  requestId?: string;
};
function descriptor(cap: PanelCapability) {
  const { adapter, action, inputSchema, outputSchema, scope, effect } = cap;
  return { adapter, action, inputSchema, outputSchema, scope, effect };
}
function frozenTask(
  row: TaskRow,
  capability: PanelCapability,
): FrozenPanelTask {
  function freeze(value: unknown) {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  const args = structuredClone(row.args.value);
  freeze(args);
  return Object.freeze({
    id: row.id,
    actorId: row.actorId,
    botId: row.botId,
    instanceId: row.instanceId,
    instanceVersion: row.instanceVersion,
    args,
    adapter: capability.adapter,
    action: capability.action,
    runId: row.runId,
    channelId: row.channelId,
    threadId: row.threadId,
  });
}
export function createPanelBroker(options: {
  database: Database;
  store: PanelStore;
  authorize(ctx: ActorContext): Promise<void>;
  adapters: readonly PanelAdapter[];
  audit?: (event: MetadataAudit) => Promise<void>;
}) {
  const db = options.database,
    concurrent = new Map<string, number>();
  const adapters = new Map<string, PanelAdapter>();
  for (const adapter of options.adapters) {
    const key = `${adapter.definition.adapter}/${adapter.definition.action}`;
    if (adapters.has(key)) throw new PanelError("duplicate_panel_adapter", 500);
    adapters.set(key, adapter);
  }
  async function authorize(ctx: ActorContext) {
    if (!ctx.actorId || !ctx.botId)
      throw new PanelError("unauthenticated", 401);
    try {
      await options.authorize(ctx);
    } catch (error) {
      if (error instanceof PanelError) throw error;
      throw new PanelError("panel_permission_refused", 403);
    }
  }
  async function capability(
    ctx: ActorContext,
    binding: PanelBinding,
    id: string,
    kind: "data" | "tasks",
    args: Json,
  ) {
    await authorize(ctx);
    assertBoundedJson(args);
    if (binding.botId !== ctx.botId)
      throw new PanelError("panel_binding_refused", 403);
    const instance = await options.store.getInstance(ctx, binding.instanceId);
    if (instance.instanceVersion !== binding.instanceVersion)
      throw new PanelError("instance_version_conflict");
    const cap = instance.definition.manifest[kind].find((c) => c.id === id);
    const adapter = cap && adapters.get(`${cap.adapter}/${cap.action}`);
    if (
      !cap ||
      !adapter ||
      canonicalJson(descriptor(cap)) !==
        canonicalJson(descriptor(adapter.definition))
    )
      throw new PanelError("panel_adapter_refused", 403);
    const [row] = await db
      .select()
      .from(panelCapabilityGrants)
      .where(
        and(
          eq(panelCapabilityGrants.instanceId, binding.instanceId),
          eq(panelCapabilityGrants.actorId, ctx.actorId),
          eq(panelCapabilityGrants.capabilityId, id),
        ),
      );
    const grant = row?.grant;
    if (
      !grant ||
      grant.actorId !== ctx.actorId ||
      grant.instanceId !== binding.instanceId ||
      grant.capabilityId !== id ||
      grant.capabilityHash !== capabilityHash(cap) ||
      canonicalJson({
        adapter: grant.adapter,
        action: grant.action,
        inputSchema: grant.inputSchema,
        outputSchema: grant.outputSchema,
        scope: grant.scope,
        effect: grant.effect,
      }) !== canonicalJson(descriptor(cap))
    )
      throw new PanelError("panel_grant_required", 403);
    if (!stateMatches(cap.inputSchema, args))
      throw new PanelError("invalid_adapter_input", 400);
    return { cap, adapter };
  }
  async function taskRow(ctx: ActorContext, id: string) {
    await authorize(ctx);
    const [row] = await db
      .select()
      .from(panelTaskRequests)
      .where(
        and(
          eq(panelTaskRequests.id, id),
          eq(panelTaskRequests.actorId, ctx.actorId),
          eq(panelTaskRequests.botId, ctx.botId),
        ),
      );
    if (!row) throw new PanelError("task_binding_refused", 404);
    return row;
  }
  const bindingOf = (row: TaskRow): PanelBinding => ({
    instanceId: row.instanceId,
    instanceVersion: row.instanceVersion,
    botId: row.botId,
  });
  async function historicalCapability(row: TaskRow) {
    const [version] = await db
      .select()
      .from(botPanelInstanceVersions)
      .where(
        and(
          eq(botPanelInstanceVersions.instanceId, row.instanceId),
          eq(botPanelInstanceVersions.version, row.instanceVersion),
        ),
      );
    const cap = version?.definition.manifest.tasks.find(
      (c) => c.id === row.capabilityId,
    );
    const adapter = cap && adapters.get(`${cap.adapter}/${cap.action}`);
    if (
      !cap ||
      !adapter ||
      capabilityHash(cap) !== row.capabilityHash ||
      canonicalJson(descriptor(cap)) !==
        canonicalJson(descriptor(adapter.definition))
    )
      throw new PanelError("task_adapter_unavailable", 409);
    return { cap, adapter };
  }
  const audit = async (
    ctx: ActorContext,
    binding: PanelBinding,
    id: string,
    operation: MetadataAudit["operation"],
    requestId?: string,
  ) => {
    try {
      await options.audit?.({
        actorId: ctx.actorId,
        botId: ctx.botId,
        instanceId: binding.instanceId,
        instanceVersion: binding.instanceVersion,
        capabilityId: id,
        operation,
        ...(requestId ? { requestId } : {}),
      });
    } catch {
      throw new PanelError("panel_audit_unavailable", 503);
    }
  };
  return {
    async listGrants(ctx: ActorContext, instanceId: string) {
      await authorize(ctx);
      await options.store.getInstance(ctx, instanceId);
      const rows = await db
        .select()
        .from(panelCapabilityGrants)
        .where(
          and(
            eq(panelCapabilityGrants.instanceId, instanceId),
            eq(panelCapabilityGrants.actorId, ctx.actorId),
          ),
        );
      return rows.map((row) => ({
        capabilityId: row.capabilityId,
        capabilityHash: row.grant.capabilityHash,
      }));
    },
    async approveCapability(
      ctx: ActorContext,
      binding: PanelBinding,
      id: string,
    ) {
      await authorize(ctx);
      if (binding.botId !== ctx.botId)
        throw new PanelError("panel_binding_refused", 403);
      const instance = await options.store.getInstance(ctx, binding.instanceId);
      if (instance.instanceVersion !== binding.instanceVersion)
        throw new PanelError("instance_version_conflict");
      const cap = [
          ...instance.definition.manifest.data,
          ...instance.definition.manifest.tasks,
        ].find((c) => c.id === id),
        adapter = cap && adapters.get(`${cap.adapter}/${cap.action}`);
      if (
        !cap ||
        !adapter ||
        canonicalJson(descriptor(cap)) !==
          canonicalJson(descriptor(adapter.definition))
      )
        throw new PanelError("panel_adapter_refused", 403);
      await audit(ctx, binding, id, "grant");
      const grant = {
        ...cap,
        instanceId: binding.instanceId,
        actorId: ctx.actorId,
        capabilityId: id,
        capabilityHash: capabilityHash(cap),
      };
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(botPanelInstances)
          .where(
            and(
              eq(botPanelInstances.id, binding.instanceId),
              eq(botPanelInstances.botId, ctx.botId),
              eq(botPanelInstances.removed, false),
            ),
          )
          .for("update");
        if (!row || row.currentVersion !== binding.instanceVersion)
          throw new PanelError("instance_version_conflict");
        await tx
          .insert(panelCapabilityGrants)
          .values({
            instanceId: binding.instanceId,
            actorId: ctx.actorId,
            capabilityId: id,
            grant,
          })
          .onConflictDoUpdate({
            target: [
              panelCapabilityGrants.instanceId,
              panelCapabilityGrants.actorId,
              panelCapabilityGrants.capabilityId,
            ],
            set: { grant },
          });
      });
      return { capabilityId: id, capabilityHash: grant.capabilityHash };
    },
    async revokeCapability(ctx: ActorContext, instanceId: string, id: string) {
      await authorize(ctx);
      const instance = await options.store.getInstance(ctx, instanceId);
      await audit(
        ctx,
        {
          botId: ctx.botId,
          instanceId,
          instanceVersion: instance.instanceVersion,
        },
        id,
        "revoke",
      );
      await db
        .delete(panelCapabilityGrants)
        .where(
          and(
            eq(panelCapabilityGrants.instanceId, instanceId),
            eq(panelCapabilityGrants.actorId, ctx.actorId),
            eq(panelCapabilityGrants.capabilityId, id),
          ),
        );
    },
    async readPanelData(
      ctx: ActorContext,
      binding: PanelBinding,
      id: string,
      args: Json,
      signal?: AbortSignal,
    ): Promise<Json> {
      const { cap, adapter } = await capability(ctx, binding, id, "data", args);
      if (!adapter.read || cap.effect !== "read")
        throw new PanelError("panel_adapter_refused", 403);
      const key = `${ctx.actorId}:${binding.instanceId}`;
      if ((concurrent.get(key) ?? 0) >= 2)
        throw new PanelError("data_concurrency_limit", 429);
      concurrent.set(key, (concurrent.get(key) ?? 0) + 1);
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) abort.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await audit(ctx, binding, id, "read");
        if (abort.signal.aborted)
          throw new PanelError("data_read_cancelled", 400);
        const result = await Promise.race([
          adapter.read(
            Object.freeze({ ...ctx }),
            structuredClone(args),
            abort.signal,
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new PanelError("data_read_timeout", 504));
            }, 30000);
          }),
        ]);
        if (abort.signal.aborted)
          throw new PanelError("data_read_cancelled", 400);
        // Recheck revocation/version after a delayed external result.
        await capability(ctx, binding, id, "data", args);
        assertBoundedJson(result);
        if (!stateMatches(cap.outputSchema, result))
          throw new PanelError("invalid_adapter_output", 502);
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        const left = (concurrent.get(key) ?? 1) - 1;
        if (left) concurrent.set(key, left);
        else concurrent.delete(key);
      }
    },
    async requestPanelTask(
      ctx: ActorContext,
      binding: PanelBinding,
      id: string,
      args: Json,
      key: string,
    ) {
      const { cap, adapter } = await capability(
        ctx,
        binding,
        id,
        "tasks",
        args,
      );
      if (
        !adapter.execute ||
        typeof key !== "string" ||
        !key.trim() ||
        key.length > 128
      )
        throw new PanelError("invalid_task_request", 400);
      const frozenArgs = structuredClone(args);
      await audit(ctx, binding, id, "request");
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`panels:task-key:${ctx.actorId}:${key}`}))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`panels:tasks:${ctx.actorId}:${binding.instanceId}`}))`,
        );
        const [previous] = await tx
          .select()
          .from(panelTaskRequests)
          .where(
            and(
              eq(panelTaskRequests.actorId, ctx.actorId),
              eq(panelTaskRequests.idempotencyKey, key),
            ),
          );
        if (previous) {
          if (
            previous.instanceId !== binding.instanceId ||
            previous.botId !== ctx.botId ||
            previous.instanceVersion !== binding.instanceVersion ||
            previous.capabilityId !== id ||
            previous.capabilityHash !== capabilityHash(cap) ||
            canonicalJson(previous.args.value) !== canonicalJson(frozenArgs)
          )
            throw new PanelError("task_idempotency_conflict");
          return { requestId: previous.id };
        }
        const rows = await tx
          .select()
          .from(panelTaskRequests)
          .where(
            and(
              eq(panelTaskRequests.actorId, ctx.actorId),
              eq(panelTaskRequests.instanceId, binding.instanceId),
              gte(panelTaskRequests.createdAt, new Date(Date.now() - 60000)),
            ),
          );
        const [pending] = await tx
          .select({ id: panelTaskRequests.id })
          .from(panelTaskRequests)
          .where(
            and(
              eq(panelTaskRequests.actorId, ctx.actorId),
              eq(panelTaskRequests.instanceId, binding.instanceId),
              eq(panelTaskRequests.status, "pending"),
            ),
          );
        if (pending) throw new PanelError("task_pending_confirmation", 429);
        if (rows.length >= 5) throw new PanelError("task_rate_limit", 429);
        // Bind to the current object again inside the committing transaction.
        const [instance] = await tx
          .select()
          .from(botPanelInstances)
          .where(
            and(
              eq(botPanelInstances.id, binding.instanceId),
              eq(botPanelInstances.botId, ctx.botId),
              eq(botPanelInstances.removed, false),
            ),
          )
          .for("update");
        const [grant] = await tx
          .select()
          .from(panelCapabilityGrants)
          .where(
            and(
              eq(panelCapabilityGrants.instanceId, binding.instanceId),
              eq(panelCapabilityGrants.actorId, ctx.actorId),
              eq(panelCapabilityGrants.capabilityId, id),
            ),
          );
        if (!instance || instance.currentVersion !== binding.instanceVersion)
          throw new PanelError("instance_version_conflict");
        if (grant?.grant.capabilityHash !== capabilityHash(cap))
          throw new PanelError("panel_grant_required", 403);
        const requestId = crypto.randomUUID();
        await tx.insert(panelTaskRequests).values({
          id: requestId,
          actorId: ctx.actorId,
          botId: ctx.botId,
          instanceId: binding.instanceId,
          instanceVersion: binding.instanceVersion,
          capabilityId: id,
          capabilityHash: capabilityHash(cap),
          args: { value: frozenArgs },
          idempotencyKey: key,
          status: "pending",
        });
        return { requestId };
      });
    },
    async confirmPanelTask(ctx: ActorContext, id: string) {
      const row = await taskRow(ctx, id),
        binding = bindingOf(row);
      if (row.status !== "pending") return row;
      const { cap, adapter } = await capability(
        ctx,
        binding,
        row.capabilityId,
        "tasks",
        row.args.value,
      );
      if (!adapter.execute || capabilityHash(cap) !== row.capabilityHash)
        throw new PanelError("task_capability_changed", 403);
      await audit(ctx, binding, row.capabilityId, "confirm", id);
      const claimed = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(panelTaskRequests)
          .where(eq(panelTaskRequests.id, id))
          .for("update");
        if (
          !current ||
          current.actorId !== ctx.actorId ||
          current.botId !== ctx.botId
        )
          throw new PanelError("task_binding_refused", 403);
        if (current.status !== "pending") return false;
        const [instance] = await tx
          .select()
          .from(botPanelInstances)
          .where(eq(botPanelInstances.id, row.instanceId))
          .for("update");
        const [grant] = await tx
          .select()
          .from(panelCapabilityGrants)
          .where(
            and(
              eq(panelCapabilityGrants.instanceId, row.instanceId),
              eq(panelCapabilityGrants.actorId, ctx.actorId),
              eq(panelCapabilityGrants.capabilityId, row.capabilityId),
            ),
          );
        if (
          !instance ||
          instance.removed ||
          instance.botId !== row.botId ||
          instance.currentVersion !== row.instanceVersion
        )
          throw new PanelError("instance_version_conflict");
        if (grant?.grant.capabilityHash !== row.capabilityHash)
          throw new PanelError("panel_grant_required", 403);
        await tx
          .update(panelTaskRequests)
          .set({ status: "confirmed" })
          .where(eq(panelTaskRequests.id, id));
        return true;
      });
      if (!claimed) return taskRow(ctx, id);
      let started = false;
      try {
        await capability(
          ctx,
          binding,
          row.capabilityId,
          "tasks",
          row.args.value,
        );
        started = true;
        const run = await adapter.execute(frozenTask(row, cap));
        if (
          typeof run.runId !== "string" ||
          !run.runId ||
          run.runId.length > 256
        )
          throw new PanelError("invalid_normal_run", 502);
        await db
          .update(panelTaskRequests)
          .set({ status: "running", runId: run.runId })
          .where(
            and(
              eq(panelTaskRequests.id, id),
              eq(panelTaskRequests.status, "confirmed"),
            ),
          );
        return taskRow(ctx, id);
      } catch {
        // Once execution was attempted, an uncertain response must never retry a
        // side effect. Leave confirmed with no run ID for read-only reconciliation.
        if (!started)
          await db
            .update(panelTaskRequests)
            .set({ status: "failed" })
            .where(eq(panelTaskRequests.id, id));
        throw new PanelError(
          started ? "task_result_unknown" : "task_permission_refused",
          started ? 502 : 403,
        );
      }
    },
    async queryPanelTask(ctx: ActorContext, id: string) {
      const row = await taskRow(ctx, id);
      if (
        row.status === "confirmed" ||
        (row.runId && row.status !== "cancelled")
      ) {
        const { cap, adapter } = await historicalCapability(row);
        if (adapter.query) {
          const result = await adapter.query(frozenTask(row, cap));
          if (
            !["running", "waiting", "unknown", "succeeded", "failed"].includes(
              result.status,
            ) ||
            (result.replyText !== undefined &&
              (typeof result.replyText !== "string" ||
                result.replyText.length > 16000))
          )
            throw new PanelError("invalid_normal_run_status", 502);
          if (["confirmed", "running", "unknown"].includes(row.status))
            await db
              .update(panelTaskRequests)
              .set({ status: result.status })
              .where(
                and(
                  eq(panelTaskRequests.id, id),
                  eq(panelTaskRequests.status, row.status),
                  row.runId
                    ? eq(panelTaskRequests.runId, row.runId)
                    : isNull(panelTaskRequests.runId),
                ),
              );
          const current = await taskRow(ctx, id);
          return {
            ...current,
            ...(current.runId === row.runId && result.replyText
              ? { replyText: result.replyText }
              : {}),
          };
        }
      }
      return row;
    },
    async cancelPanelTask(ctx: ActorContext, id: string) {
      const row = await taskRow(ctx, id);
      if (
        row.status === "cancelled" ||
        row.status === "succeeded" ||
        row.status === "failed"
      )
        return row;
      await audit(ctx, bindingOf(row), row.capabilityId, "cancel", id);
      let cancel: (() => Promise<void>) | undefined;
      if (["running", "confirmed", "waiting", "unknown"].includes(row.status)) {
        const { cap, adapter } = await historicalCapability(row);
        const cancelTask = adapter.cancel?.bind(adapter);
        if (!cancelTask)
          throw new PanelError("normal_run_cancel_unavailable", 409);
        cancel = () => cancelTask(frozenTask(row, cap));
      }
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(panelTaskRequests)
          .where(eq(panelTaskRequests.id, id))
          .for("update");
        if (!current || current.actorId !== ctx.actorId)
          throw new PanelError("task_binding_refused", 403);
        if (["succeeded", "failed", "cancelled"].includes(current.status))
          return;
        if (row.status === "pending" && current.status !== "pending")
          throw new PanelError("task_status_conflict");
        await tx
          .update(panelTaskRequests)
          .set({ status: "cancelled" })
          .where(eq(panelTaskRequests.id, id));
      });
      if ((await taskRow(ctx, id)).status === "cancelled") await cancel?.();
      return taskRow(ctx, id);
    },
    async listPanelTasks(ctx: ActorContext, instanceId: string) {
      await authorize(ctx);
      await options.store.getInstance(ctx, instanceId);
      return db
        .select()
        .from(panelTaskRequests)
        .where(
          and(
            eq(panelTaskRequests.actorId, ctx.actorId),
            eq(panelTaskRequests.botId, ctx.botId),
            eq(panelTaskRequests.instanceId, instanceId),
          ),
        )
        .orderBy(
          sql`case when ${panelTaskRequests.status}='pending' then 0 else 1 end`,
          desc(panelTaskRequests.createdAt),
        )
        .limit(50);
    },
  };
}
export type PanelBroker = ReturnType<typeof createPanelBroker>;
