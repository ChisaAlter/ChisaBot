import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  assertBoundedJson,
  canonicalJson,
  stateMatches,
  validateStateSchema,
} from "../../../shared/panels/state-schema";
import {
  PanelError,
  type ActorContext,
  type CommitInput,
  type CommitResult,
  type DraftWrite,
  type PanelDefinition,
  type PanelDraft,
  type PanelInstance,
  type StateWrite,
} from "../../../shared/panels/types";
import type { Database } from "../db/client";
import { validatePanelDefinition } from "../../../shared/panels/validate";
import {
  botPanelInstances as instances,
  botPanelInstanceVersions as versions,
  panelAuthoringSessions as sessions,
  panelDrafts as drafts,
  panelLibraryEntries as libraries,
  panelLibraryVersions as libraryVersions,
  panelOperations as operations,
  panelStates as states,
  panelCapabilityGrants as grants,
} from "../db/schema/panels";
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Tx;
function actor(ctx: ActorContext) {
  if (!ctx.actorId || !ctx.botId) throw new PanelError("unauthenticated", 401);
}
function definitionState(def: PanelDefinition) {
  validatePanelDefinition(def);
  assertBoundedJson(def, 512 * 1024);
  validateStateSchema(def.stateSchema);
  assertBoundedJson(def.initialState);
  if (!stateMatches(def.stateSchema, def.initialState))
    throw new PanelError("invalid_initial_state", 400);
}
function requestHash(input: unknown) {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
async function bound(
  conn: Connection,
  ctx: ActorContext,
  id: string,
  lock = false,
): Promise<PanelInstance> {
  actor(ctx);
  const query = conn
    .select()
    .from(instances)
    .where(
      and(
        eq(instances.id, id),
        eq(instances.botId, ctx.botId),
        eq(instances.removed, false),
      ),
    );
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new PanelError("instance_binding", 404);
  const [v] = await conn
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.instanceId, id),
        eq(versions.version, row.currentVersion),
      ),
    );
  if (!v) throw new PanelError("missing_instance_version", 500);
  return {
    id: row.id,
    botId: row.botId,
    instanceVersion: row.currentVersion,
    definition: v.definition,
    sourceLibraryId: row.sourceLibraryId,
    sourceVersion: row.sourceVersion,
    title: row.title,
    position: row.position,
    collapsed: row.collapsed,
    size: row.size,
  };
}
async function privateState(
  conn: Connection,
  ctx: ActorContext,
  instance: PanelInstance,
) {
  const [s] = await conn
    .select()
    .from(states)
    .where(
      and(eq(states.instanceId, instance.id), eq(states.actorId, ctx.actorId)),
    );
  return {
    stateRevision: s?.stateRevision ?? 0,
    value: s ? s.payload.value : instance.definition.initialState,
  };
}
async function newInstance(
  tx: Tx,
  ctx: ActorContext,
  definition: PanelDefinition,
  libraryId: string,
  sourceVersion: number,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`panels:bot:${ctx.botId}`}))`,
  );
  const rows = await tx
    .select({ position: instances.position })
    .from(instances)
    .where(eq(instances.botId, ctx.botId));
  const id = crypto.randomUUID();
  await tx
    .insert(instances)
    .values({
      id,
      botId: ctx.botId,
      currentVersion: 1,
      sourceLibraryId: libraryId,
      sourceVersion,
      title: definition.name,
      position: rows.reduce((max, r) => Math.max(max, r.position), -1) + 1,
      size: definition.size,
    });
  await tx.insert(versions).values({ instanceId: id, version: 1, definition });
  return id;
}
export function createPanelStore(db: Database) {
  async function idempotent(
    ctx: ActorContext,
    key: string,
    input: unknown,
    run: (tx: Tx) => Promise<CommitResult>,
  ) {
    actor(ctx);
    if (typeof key !== "string" || !key.trim() || key.length > 128)
      throw new PanelError("invalid_idempotency_key", 400);
    const hash = requestHash(input);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`panels:key:${ctx.actorId}:${key}`}))`,
      );
      const [previous] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.actorId, ctx.actorId),
            eq(operations.idempotencyKey, key),
          ),
        );
      if (previous) {
        if (previous.botId !== ctx.botId || previous.requestHash !== hash)
          throw new PanelError("idempotency_conflict");
        return previous.result;
      }
      const result = await run(tx);
      await tx
        .insert(operations)
        .values({
          actorId: ctx.actorId,
          botId: ctx.botId,
          idempotencyKey: key,
          requestHash: hash,
          result,
        });
      return result;
    });
  }
  return {
    async getSession(ctx: ActorContext, id: string) {
      actor(ctx);
      const [session] = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, id),
            eq(sessions.actorId, ctx.actorId),
            eq(sessions.botId, ctx.botId),
          ),
        );
      if (!session || session.cancelled)
        throw new PanelError("session_binding", 404);
      const [draft] = await db
        .select()
        .from(drafts)
        .where(eq(drafts.sessionId, id));
      return {
        sessionId: session.id,
        targetInstanceId: session.targetInstanceId,
        baseInstanceVersion: session.baseInstanceVersion,
        baseLibraryVersion: session.baseLibraryVersion,
        draft: draft ?? null,
      };
    },
    async activeSession(ctx: ActorContext) {
      actor(ctx);
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .leftJoin(drafts, eq(drafts.sessionId, sessions.id))
        .where(
          and(
            eq(sessions.actorId, ctx.actorId),
            eq(sessions.botId, ctx.botId),
            eq(sessions.cancelled, false),
            or(isNull(drafts.id), eq(drafts.status, "ready")),
          ),
        )
        .orderBy(desc(sessions.createdAt))
        .limit(1);
      return row ? this.getSession(ctx, row.id) : null;
    },
    async listLibrary(ctx: ActorContext, limit = 20, offset = 0) {
      actor(ctx);
      return db
        .select({
          id: libraries.id,
          creatorActorId: libraries.creatorActorId,
          version: libraries.currentVersion,
          definition: libraryVersions.definition,
        })
        .from(libraries)
        .innerJoin(
          libraryVersions,
          and(
            eq(libraryVersions.libraryId, libraries.id),
            eq(libraryVersions.version, libraries.currentVersion),
          ),
        )
        .where(eq(libraries.archived, false))
        .orderBy(desc(libraries.createdAt), asc(libraries.id))
        .limit(limit)
        .offset(offset);
    },
    async archiveLibrary(
      ctx: ActorContext,
      id: string,
      expectedVersion: number,
    ) {
      actor(ctx);
      await db.transaction(async (tx) => {
        const [library] = await tx
          .select()
          .from(libraries)
          .where(eq(libraries.id, id))
          .for("update");
        if (
          !library ||
          (library.creatorActorId !== ctx.actorId && !ctx.isAdmin)
        )
          throw new PanelError("library_permission", 403);
        if (library.currentVersion !== expectedVersion)
          throw new PanelError("library_version_conflict");
        await tx
          .update(libraries)
          .set({ archived: true })
          .where(eq(libraries.id, id));
      });
    },
    async updateLayout(
      ctx: ActorContext,
      input: {
        instanceId: string;
        expectedVersion: number;
        title?: string;
        collapsed?: boolean;
        size?: PanelDefinition["size"];
      },
    ) {
      if (
        input.title !== undefined &&
        (!input.title.trim() || input.title.length > 80)
      )
        throw new PanelError("invalid_title", 400);
      if (
        input.size &&
        (!Number.isFinite(input.size.width) ||
          input.size.width < 280 ||
          input.size.width > 600 ||
          (input.size.height !== "auto" &&
            (!Number.isFinite(input.size.height) ||
              input.size.height < 160 ||
              input.size.height > 960)))
      )
        throw new PanelError("invalid_size", 400);
      return db.transaction(async (tx) => {
        const instance = await bound(tx, ctx, input.instanceId, true);
        if (instance.instanceVersion !== input.expectedVersion)
          throw new PanelError("instance_version_conflict");
        const version = instance.instanceVersion + 1;
        await tx
          .insert(versions)
          .values({
            instanceId: instance.id,
            version,
            definition: instance.definition,
          });
        await tx
          .update(instances)
          .set({
            currentVersion: version,
            title: input.title?.trim() ?? instance.title,
            collapsed: input.collapsed ?? instance.collapsed,
            size: input.size ?? instance.size,
          })
          .where(eq(instances.id, instance.id));
        return bound(tx, ctx, instance.id);
      });
    },
    async reorder(
      ctx: ActorContext,
      input: { id: string; expectedVersion: number }[],
    ) {
      actor(ctx);
      if (new Set(input.map((r) => r.id)).size !== input.length)
        throw new PanelError("invalid_order", 400);
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`panels:bot:${ctx.botId}`}))`,
        );
        // Lock in ID order consistently with other batch operations.
        const rows = await tx
          .select()
          .from(instances)
          .where(
            and(eq(instances.botId, ctx.botId), eq(instances.removed, false)),
          )
          .orderBy(asc(instances.id))
          .for("update");
        for (const item of input) {
          const row = rows.find((r) => r.id === item.id);
          if (!row) throw new PanelError("instance_binding", 404);
          if (row.currentVersion !== item.expectedVersion)
            throw new PanelError("instance_version_conflict");
        }
        const selected = new Set(input.map((r) => r.id));
        const order = [
          ...input.map((r) => r.id),
          ...rows
            .filter((r) => !selected.has(r.id))
            .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
            .map((r) => r.id),
        ];
        for (const [position, id] of order.entries()) {
          const row = rows.find((r) => r.id === id)!;
          if (row.position === position) continue;
          const instance = await bound(tx, ctx, id);
          await tx
            .insert(versions)
            .values({
              instanceId: id,
              version: row.currentVersion + 1,
              definition: instance.definition,
            });
          await tx
            .update(instances)
            .set({ position, currentVersion: row.currentVersion + 1 })
            .where(eq(instances.id, id));
        }
      });
    },
    async rollback(
      ctx: ActorContext,
      input: {
        instanceId: string;
        expectedVersion: number;
        version: number;
        idempotencyKey: string;
        resetState: boolean;
      },
    ): Promise<CommitResult> {
      return idempotent(
        ctx,
        input.idempotencyKey,
        { operation: "rollback", input },
        async (tx) => {
          const instance = await bound(tx, ctx, input.instanceId, true);
          if (instance.instanceVersion !== input.expectedVersion)
            throw new PanelError("instance_version_conflict");
          const [target] = await tx
            .select()
            .from(versions)
            .where(
              and(
                eq(versions.instanceId, instance.id),
                eq(versions.version, input.version),
              ),
            );
          if (!target) throw new PanelError("history_version_missing", 404);
          definitionState(target.definition);
          const currentState = await privateState(tx, ctx, instance);
          if (
            !stateMatches(target.definition.stateSchema, currentState.value)
          ) {
            if (!input.resetState) throw new PanelError("state_reset_required");
            await tx
              .insert(states)
              .values({
                instanceId: instance.id,
                actorId: ctx.actorId,
                stateRevision: currentState.stateRevision + 1,
                payload: { value: target.definition.initialState },
              })
              .onConflictDoUpdate({
                target: [states.instanceId, states.actorId],
                set: {
                  stateRevision: currentState.stateRevision + 1,
                  payload: { value: target.definition.initialState },
                },
              });
          }
          const version = instance.instanceVersion + 1;
          await tx
            .insert(versions)
            .values({
              instanceId: instance.id,
              version,
              definition: target.definition,
            });
          await tx
            .update(instances)
            .set({ currentVersion: version })
            .where(eq(instances.id, instance.id));
          await tx.delete(grants).where(eq(grants.instanceId, instance.id));
          return { instanceId: instance.id, instanceVersion: version };
        },
      );
    },
    async history(ctx: ActorContext, id: string) {
      await bound(db, ctx, id);
      return db
        .select({ version: versions.version, definition: versions.definition })
        .from(versions)
        .where(eq(versions.instanceId, id))
        .orderBy(desc(versions.version));
    },
    async remove(ctx: ActorContext, id: string, expectedVersion: number) {
      await db.transaction(async (tx) => {
        const instance = await bound(tx, ctx, id, true);
        if (instance.instanceVersion !== expectedVersion)
          throw new PanelError("instance_version_conflict");
        await tx
          .update(instances)
          .set({ removed: true, currentVersion: expectedVersion + 1 })
          .where(eq(instances.id, id));
        await tx.delete(grants).where(eq(grants.instanceId, id));
      });
    },
    async beginSession(ctx: ActorContext, targetInstanceId?: string) {
      actor(ctx);
      return db.transaction(async (tx) => {
        const instance = targetInstanceId
          ? await bound(tx, ctx, targetInstanceId, true)
          : null;
        const [source] = instance?.sourceLibraryId
          ? await tx
              .select()
              .from(libraries)
              .where(eq(libraries.id, instance.sourceLibraryId))
          : [];
        const sessionId = crypto.randomUUID();
        await tx
          .insert(sessions)
          .values({
            id: sessionId,
            actorId: ctx.actorId,
            botId: ctx.botId,
            targetInstanceId: targetInstanceId ?? null,
            baseInstanceVersion: instance?.instanceVersion ?? null,
            baseLibraryVersion: source?.currentVersion ?? null,
          });
        return { sessionId };
      });
    },
    async saveDraft(ctx: ActorContext, input: DraftWrite): Promise<PanelDraft> {
      actor(ctx);
      definitionState(input.definition);
      return db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.id, input.sessionId),
              eq(sessions.actorId, ctx.actorId),
              eq(sessions.botId, ctx.botId),
            ),
          )
          .for("update");
        if (!session || session.cancelled)
          throw new PanelError("session_binding", 404);
        const [old] = await tx
          .select()
          .from(drafts)
          .where(eq(drafts.sessionId, session.id));
        if (
          (old?.draftRevision ?? 0) !== input.expectedDraftRevision ||
          old?.status === "saved"
        )
          throw new PanelError("draft_revision_conflict");
        const next: PanelDraft = {
          id: old?.id ?? crypto.randomUUID(),
          sessionId: session.id,
          actorId: ctx.actorId,
          botId: ctx.botId,
          targetInstanceId: session.targetInstanceId,
          baseInstanceVersion: session.baseInstanceVersion,
          baseLibraryVersion: session.baseLibraryVersion,
          draftRevision: input.expectedDraftRevision + 1,
          definition: input.definition,
          status: "ready",
        };
        if (old) await tx.update(drafts).set(next).where(eq(drafts.id, old.id));
        else await tx.insert(drafts).values(next);
        return next;
      });
    },
    async getDraft(ctx: ActorContext, id: string): Promise<PanelDraft> {
      actor(ctx);
      const [row] = await db
        .select()
        .from(drafts)
        .where(
          and(
            eq(drafts.id, id),
            eq(drafts.actorId, ctx.actorId),
            eq(drafts.botId, ctx.botId),
          ),
        );
      if (!row) throw new PanelError("draft_binding", 404);
      return row;
    },
    async draftForActor(actorId: string, id: string): Promise<PanelDraft> {
      if (!actorId) throw new PanelError("unauthenticated", 401);
      const [draft] = await db
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, id), eq(drafts.actorId, actorId)));
      if (!draft) throw new PanelError("draft_binding", 404);
      return draft;
    },
    async getInstance(ctx: ActorContext, id: string) {
      return bound(db, ctx, id);
    },
    async list(
      ctx: ActorContext,
      limit = 50,
      offset = 0,
    ): Promise<PanelInstance[]> {
      actor(ctx);
      const rows = await db
        .select({ instance: instances, version: versions })
        .from(instances)
        .innerJoin(
          versions,
          and(
            eq(versions.instanceId, instances.id),
            eq(versions.version, instances.currentVersion),
          ),
        )
        .where(
          and(eq(instances.botId, ctx.botId), eq(instances.removed, false)),
        )
        .orderBy(asc(instances.position), asc(instances.id))
        .limit(limit)
        .offset(offset);
      return rows.map(({ instance: r, version: v }) => ({
        id: r.id,
        botId: r.botId,
        instanceVersion: r.currentVersion,
        definition: v.definition,
        sourceLibraryId: r.sourceLibraryId,
        sourceVersion: r.sourceVersion,
        title: r.title,
        position: r.position,
        collapsed: r.collapsed,
        size: r.size,
      }));
    },
    async commit(ctx: ActorContext, input: CommitInput): Promise<CommitResult> {
      return idempotent(
        ctx,
        input.idempotencyKey,
        { operation: "commit", input },
        async (tx) => {
          const [draft] = await tx
            .select()
            .from(drafts)
            .where(
              and(
                eq(drafts.id, input.draftId),
                eq(drafts.actorId, ctx.actorId),
                eq(drafts.botId, ctx.botId),
              ),
            )
            .for("update");
          if (draft?.status !== "ready")
            throw new PanelError("draft_binding", 404);
          if (draft.draftRevision !== input.expectedDraftRevision)
            throw new PanelError("draft_revision_conflict");
          definitionState(draft.definition);
          let result: CommitResult;
          if (input.mode === "first") {
            if (draft.targetInstanceId)
              throw new PanelError("invalid_commit_mode", 400);
            const libraryId = crypto.randomUUID();
            await tx
              .insert(libraries)
              .values({
                id: libraryId,
                creatorActorId: ctx.actorId,
                currentVersion: 1,
              });
            await tx
              .insert(libraryVersions)
              .values({ libraryId, version: 1, definition: draft.definition });
            const instanceId = await newInstance(
              tx,
              ctx,
              draft.definition,
              libraryId,
              1,
            );
            result = {
              libraryId,
              libraryVersion: 1,
              instanceId,
              instanceVersion: 1,
            };
          } else if (input.mode === "instance") {
            if (!draft.targetInstanceId)
              throw new PanelError("invalid_commit_mode", 400);
            const instance = await bound(tx, ctx, draft.targetInstanceId, true);
            if (
              input.baseInstanceVersion !== instance.instanceVersion ||
              draft.baseInstanceVersion !== instance.instanceVersion
            )
              throw new PanelError("instance_version_conflict");
            const state = await privateState(tx, ctx, instance);
            if (!stateMatches(draft.definition.stateSchema, state.value)) {
              if (!input.resetState)
                throw new PanelError("state_reset_required");
              await tx
                .insert(states)
                .values({
                  instanceId: instance.id,
                  actorId: ctx.actorId,
                  stateRevision: state.stateRevision + 1,
                  payload: { value: draft.definition.initialState },
                })
                .onConflictDoUpdate({
                  target: [states.instanceId, states.actorId],
                  set: {
                    stateRevision: state.stateRevision + 1,
                    payload: { value: draft.definition.initialState },
                  },
                });
            }
            const version = instance.instanceVersion + 1;
            await tx
              .insert(versions)
              .values({
                instanceId: instance.id,
                version,
                definition: draft.definition,
              });
            await tx
              .update(instances)
              .set({ currentVersion: version })
              .where(eq(instances.id, instance.id));
            await tx.delete(grants).where(eq(grants.instanceId, instance.id));
            result = { instanceId: instance.id, instanceVersion: version };
          } else if (
            input.mode === "new-library" ||
            input.mode === "update-library"
          ) {
            if (!draft.targetInstanceId)
              throw new PanelError("invalid_commit_mode", 400);
            const instance = await bound(tx, ctx, draft.targetInstanceId, true);
            if (
              input.baseInstanceVersion !== instance.instanceVersion ||
              draft.baseInstanceVersion !== instance.instanceVersion
            )
              throw new PanelError("instance_version_conflict");
            if (input.mode === "new-library") {
              const libraryId = crypto.randomUUID();
              await tx
                .insert(libraries)
                .values({
                  id: libraryId,
                  creatorActorId: ctx.actorId,
                  currentVersion: 1,
                });
              await tx
                .insert(libraryVersions)
                .values({
                  libraryId,
                  version: 1,
                  definition: draft.definition,
                });
              result = { libraryId, libraryVersion: 1 };
            } else {
              if (
                !input.libraryId ||
                instance.sourceLibraryId !== input.libraryId
              )
                throw new PanelError("library_binding", 400);
              const [library] = await tx
                .select()
                .from(libraries)
                .where(eq(libraries.id, input.libraryId))
                .for("update");
              if (
                !library ||
                library.archived ||
                (library.creatorActorId !== ctx.actorId && !ctx.isAdmin)
              )
                throw new PanelError("library_permission", 403);
              if (
                input.baseLibraryVersion !== library.currentVersion ||
                draft.baseLibraryVersion !== library.currentVersion
              )
                throw new PanelError("library_version_conflict");
              const version = library.currentVersion + 1;
              await tx
                .insert(libraryVersions)
                .values({
                  libraryId: library.id,
                  version,
                  definition: draft.definition,
                });
              await tx
                .update(libraries)
                .set({ currentVersion: version })
                .where(eq(libraries.id, library.id));
              result = { libraryId: library.id, libraryVersion: version };
            }
          } else throw new PanelError("invalid_commit_mode", 400);
          await tx
            .update(drafts)
            .set({ status: "saved" })
            .where(eq(drafts.id, draft.id));
          return result;
        },
      );
    },
    async operationResult(ctx: ActorContext, key: string) {
      actor(ctx);
      const [row] = await db
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.actorId, ctx.actorId),
            eq(operations.botId, ctx.botId),
            eq(operations.idempotencyKey, key),
          ),
        );
      return row?.result ?? null;
    },
    async install(
      ctx: ActorContext,
      input: {
        libraryId: string;
        libraryVersion: number;
        idempotencyKey: string;
      },
    ): Promise<PanelInstance> {
      const result = await idempotent(
        ctx,
        input.idempotencyKey,
        { operation: "install", input },
        async (tx) => {
          const [library] = await tx
            .select()
            .from(libraries)
            .where(
              and(
                eq(libraries.id, input.libraryId),
                eq(libraries.archived, false),
              ),
            )
            .for("update");
          if (!library) throw new PanelError("library_missing", 404);
          const [v] = await tx
            .select()
            .from(libraryVersions)
            .where(
              and(
                eq(libraryVersions.libraryId, library.id),
                eq(libraryVersions.version, input.libraryVersion),
              ),
            );
          if (!v) throw new PanelError("library_version_missing", 404);
          return {
            instanceId: await newInstance(
              tx,
              ctx,
              v.definition,
              library.id,
              v.version,
            ),
            instanceVersion: 1,
          };
        },
      );
      return bound(db, ctx, result.instanceId!);
    },
    async readState(ctx: ActorContext, instanceId: string) {
      const instance = await bound(db, ctx, instanceId);
      const state = await privateState(db, ctx, instance);
      return {
        ...state,
        requiresReset: !stateMatches(
          instance.definition.stateSchema,
          state.value,
        ),
      };
    },
    async writeState(ctx: ActorContext, input: StateWrite) {
      assertBoundedJson(input.value);
      return db.transaction(async (tx) => {
        const instance = await bound(tx, ctx, input.instanceId, true);
        if (instance.instanceVersion !== input.instanceVersion)
          throw new PanelError("instance_version_conflict");
        const old = await privateState(tx, ctx, instance);
        if (old.stateRevision !== input.stateRevision)
          throw new PanelError("state_revision_conflict");
        if (
          !stateMatches(instance.definition.stateSchema, old.value) &&
          !input.resetIncompatible
        )
          throw new PanelError("state_reset_required");
        if (!stateMatches(instance.definition.stateSchema, input.value))
          throw new PanelError("invalid_state", 400);
        await tx
          .insert(states)
          .values({
            instanceId: input.instanceId,
            actorId: ctx.actorId,
            stateRevision: old.stateRevision + 1,
            payload: { value: input.value },
          })
          .onConflictDoUpdate({
            target: [states.instanceId, states.actorId],
            set: {
              stateRevision: old.stateRevision + 1,
              payload: { value: input.value },
            },
          });
      });
    },
    async cancelSession(ctx: ActorContext, sessionId: string) {
      actor(ctx);
      await db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.actorId, ctx.actorId),
              eq(sessions.botId, ctx.botId),
            ),
          )
          .for("update");
        if (!session) throw new PanelError("session_binding", 404);
        await tx
          .update(sessions)
          .set({ cancelled: true })
          .where(eq(sessions.id, sessionId));
        await tx
          .update(drafts)
          .set({ status: "cancelled" })
          .where(
            and(eq(drafts.sessionId, sessionId), eq(drafts.status, "ready")),
          );
      });
    },
  };
}
export type PanelStore = ReturnType<typeof createPanelStore>;
