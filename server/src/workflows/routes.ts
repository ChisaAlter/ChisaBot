/**
 * /api/workflows（docs/workflows.md §接口）。都要登录；每个人只看得到预设、自己的工作流和自己的运行。
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type WorkflowDefinition,
  type WorkflowDetail,
  type WorkflowSummary,
  workflowStages,
} from "../../../shared/workflows";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { WorkflowEngine } from "./engine";
import { WorkflowRunError } from "./engine";
import { parseWorkflowMarkdown, serializeWorkflowMarkdown, validateDefinition, WorkflowFormatError } from "./format";
import { loadPresets, PRESET_PREFIX, presetById } from "./presets";
import type { StoredWorkflow, WorkflowStore } from "./store";

const MAX_OWN_WORKFLOWS = 100;

export function summarize(id: string, kind: "preset" | "mine", def: WorkflowDefinition, updatedAt: Date | null): WorkflowSummary {
  return {
    id,
    kind,
    slug: def.slug,
    name: def.name,
    description: def.description,
    icon: def.icon,
    tags: def.tags ?? [],
    botCount: def.bots.length,
    stepCount: def.steps.length,
    hasApproval: def.steps.some((s) => s.approval),
    hasParallel: workflowStages(def.steps).some((stage) => stage.length > 1),
    updatedAt: updatedAt?.toISOString() ?? null,
  };
}

export type ResolvedWorkflow = { id: string; kind: "preset" | "mine"; definition: WorkflowDefinition; updatedAt: Date | null };

/** 按 id 找：预设或自己的。 */
export async function resolveWorkflow(store: WorkflowStore, ownerUserId: string, id: string): Promise<ResolvedWorkflow | null> {
  if (id.startsWith(PRESET_PREFIX)) {
    const preset = presetById(id);
    return preset ? { id: preset.id, kind: "preset", definition: preset.definition, updatedAt: null } : null;
  }
  const own = await store.get(ownerUserId, id);
  return own ? { id: own.id, kind: "mine", definition: own.definition, updatedAt: own.updatedAt } : null;
}

function detail(found: ResolvedWorkflow): WorkflowDetail {
  return {
    id: found.id,
    kind: found.kind,
    definition: found.definition,
    markdown: serializeWorkflowMarkdown(found.definition),
    updatedAt: found.updatedAt?.toISOString() ?? null,
  };
}

/** 复制时起一个不和自己已有工作流重名的 slug。 */
function freeSlug(existing: StoredWorkflow[], base: string) {
  const taken = new Set(existing.map((w) => w.definition.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 200; i++) {
    const candidate = `${base.slice(0, 44)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 36)}-${Date.now().toString(36)}`;
}

export function createWorkflowRoutes(options: {
  store: WorkflowStore;
  engine: WorkflowEngine;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  auditStore?: AuditStore;
  /** 这个人能用的技能 slug（只用来给出「找不到技能」的提醒，不拦保存）。 */
  librarySkillSlugs?: (actorId: string) => Promise<Set<string>>;
  /** 检查默认绑定的机器人是否可用（用于运行前预检提醒）。 */
  botInfo?: (actorId: string, botId: string) => Promise<{ id: string; name: string } | null>;
}) {
  const { store, engine } = options;
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", options.requireUser);
  routes.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  const fail = (error: unknown) => {
    if (error instanceof WorkflowFormatError) return { body: { error: error.message, problems: error.problems }, status: 400 as const };
    if (error instanceof WorkflowRunError) return { body: { error: error.message }, status: error.status as 400 };
    throw error;
  };

  const audit = async (actorId: string, change: string, payload: Record<string, unknown>) => {
    if (!options.auditStore) return;
    await recordAuditEvent(options.auditStore, {
      eventType: "configuration.changed",
      targetType: "workflow",
      targetId: typeof payload.id === "string" ? payload.id : undefined,
      actorUserId: actorId,
      payload: { change, ...payload },
    }).catch(() => {});
  };

  const warningsFor = async (actorId: string, def: WorkflowDefinition) => {
    const warnings: string[] = [];
    if (options.librarySkillSlugs) {
      const library = await options.librarySkillSlugs(actorId).catch(() => new Set<string>());
      const embedded = new Set((def.skills ?? []).map((s) => s.slug));
      const missing = [...new Set(def.steps.flatMap((s) => s.skills ?? []))].filter((slug) => !embedded.has(slug) && !library.has(slug));
      for (const slug of missing) {
        warnings.push(`技能 /${slug} 不在你的技能里，运行时会跳过它。`);
      }
    }
    if (options.botInfo) {
      for (const role of def.bots) {
        if (!role.botId?.trim()) continue;
        const info = await options.botInfo(actorId, role.botId.trim()).catch(() => null);
        if (!info) {
          warnings.push(`角色「${role.name}」绑定的默认机器人不可用或已删除，运行时需要重新选择。`);
        }
      }
    }
    return warnings;
  };

  routes.get("/", async (context) => {
    const actor = context.var.actor;
    const [mine, runs] = await Promise.all([store.list(actor.id), store.listRuns(actor.id, 12)]);
    return context.json({
      presets: loadPresets().map((p) => summarize(p.id, "preset", p.definition, null)),
      mine: mine.map((w) => summarize(w.id, "mine", w.definition, w.updatedAt)),
      runs: runs.map((run) => engine.view(run)),
    });
  });

  // ── 运行 ──
  routes.get("/runs", async (context) => {
    const limit = Number(context.req.query("limit") ?? 30);
    const runs = await store.listRuns(context.var.actor.id, Number.isFinite(limit) ? limit : 30);
    return context.json({ runs: runs.map((run) => engine.view(run)) });
  });
  routes.get("/runs/:runId", async (context) => {
    const run = await store.getOwnRun(context.var.actor.id, context.req.param("runId"));
    if (!run) return context.json({ error: "找不到这次运行。" }, 404);
    return context.json({ run: engine.view(run, await store.events(run.id)) });
  });
  routes.post("/runs/:runId/approve", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      stepId?: unknown;
      decision?: unknown;
      comment?: unknown;
      rejectTo?: unknown;
      retryMode?: unknown;
    } | null;
    if (!body || typeof body.stepId !== "string" || (body.decision !== "approve" && body.decision !== "reject"))
      return context.json({ error: "请求格式无效。" }, 400);
    const actor = context.var.actor;
    const retryMode = body.retryMode === "targeted_fix" || body.retryMode === "full_redo" ? body.retryMode : undefined;
    try {
      await engine.approve({
        ownerUserId: actor.id,
        runId: context.req.param("runId"),
        stepId: body.stepId,
        decision: body.decision,
        ...(typeof body.comment === "string" && body.comment.trim() ? { comment: body.comment.trim() } : {}),
        ...(typeof body.rejectTo === "string" && body.rejectTo.trim() ? { rejectTo: body.rejectTo.trim() } : {}),
        ...(retryMode ? { retryMode } : {}),
        by: actor.name?.trim() || actor.email,
      });
    } catch (error) {
      const { body: b, status } = fail(error);
      return context.json(b, status);
    }
    const run = await store.getOwnRun(actor.id, context.req.param("runId"));
    return context.json({ run: run ? engine.view(run) : null });
  });
  routes.post("/runs/:runId/retry", async (context) => {
    const body = (await context.req.json().catch(() => ({}))) as {
      stepId?: unknown;
      mode?: unknown;
      comment?: unknown;
      bindings?: unknown;
    } | null;
    const actor = context.var.actor;
    const mode = body?.mode === "targeted_fix" || body?.mode === "full_redo" ? body.mode : undefined;
    const bindings =
      body?.bindings && typeof body.bindings === "object" && !Array.isArray(body.bindings)
        ? (body.bindings as Record<string, unknown>)
        : undefined;
    try {
      const run = await engine.retry({
        ownerUserId: actor.id,
        runId: context.req.param("runId"),
        ...(typeof body?.stepId === "string" && body.stepId.trim() ? { stepId: body.stepId.trim() } : {}),
        ...(mode ? { mode } : {}),
        ...(typeof body?.comment === "string" && body.comment.trim() ? { comment: body.comment.trim() } : {}),
        ...(bindings ? { bindings } : {}),
        by: actor.name?.trim() || actor.email,
      });
      return context.json({ run: engine.view(run) });
    } catch (error) {
      const { body: b, status } = fail(error);
      return context.json(b, status);
    }
  });
  routes.post("/runs/:runId/cancel", async (context) => {
    try {
      await engine.cancel(context.var.actor.id, context.req.param("runId"));
    } catch (error) {
      const { body, status } = fail(error);
      return context.json(body, status);
    }
    return context.json({ ok: true });
  });
  routes.delete("/runs/:runId", async (context) => {
    try {
      await engine.remove(context.var.actor.id, context.req.param("runId"));
    } catch (error) {
      const { body, status } = fail(error);
      return context.json(body, status);
    }
    return context.json({ ok: true });
  });

  // ── 文件 ──
  routes.post("/validate", async (context) => {
    const body = (await context.req.json().catch(() => null)) as { markdown?: unknown; definition?: unknown } | null;
    try {
      const def =
        typeof body?.markdown === "string" ? parseWorkflowMarkdown(body.markdown) : validateDefinition(body?.definition);
      return context.json({ ok: true, definition: def, markdown: serializeWorkflowMarkdown(def), warnings: await warningsFor(context.var.actor.id, def) });
    } catch (error) {
      const { body: b } = fail(error);
      return context.json({ ok: false, ...b }, 200);
    }
  });

  const createOwn = async (actorId: string, def: WorkflowDefinition, origin: string) => {
    const existing = await store.list(actorId);
    if (existing.length >= MAX_OWN_WORKFLOWS) throw new WorkflowRunError(`最多保存 ${MAX_OWN_WORKFLOWS} 个工作流。`);
    const slugged = { ...def, slug: freeSlug(existing, def.slug) };
    const saved = await store.create(actorId, slugged, origin);
    await audit(actorId, "workflow_created", { id: saved.id, slug: slugged.slug, origin });
    return saved;
  };

  routes.post("/import", async (context) => {
    const body = (await context.req.json().catch(() => null)) as { markdown?: unknown } | null;
    if (typeof body?.markdown !== "string") return context.json({ error: "请选择一个 WORKFLOW.md 文件。" }, 400);
    try {
      const def = parseWorkflowMarkdown(body.markdown);
      const saved = await createOwn(context.var.actor.id, def, "import");
      return context.json({ workflow: detail({ id: saved.id, kind: "mine", definition: saved.definition, updatedAt: saved.updatedAt }) }, 201);
    } catch (error) {
      const { body: b, status } = fail(error);
      return context.json(b, status);
    }
  });

  routes.post("/", async (context) => {
    const body = (await context.req.json().catch(() => null)) as { definition?: unknown } | null;
    try {
      const def = validateDefinition(body?.definition);
      const saved = await createOwn(context.var.actor.id, def, "editor");
      return context.json({ workflow: detail({ id: saved.id, kind: "mine", definition: saved.definition, updatedAt: saved.updatedAt }) }, 201);
    } catch (error) {
      const { body: b, status } = fail(error);
      return context.json(b, status);
    }
  });

  routes.get("/:id/export", async (context) => {
    const found = await resolveWorkflow(store, context.var.actor.id, context.req.param("id"));
    if (!found) return context.json({ error: "找不到这个工作流。" }, 404);
    context.header("Content-Type", "text/markdown; charset=utf-8");
    context.header("Content-Disposition", `attachment; filename="${found.definition.slug}.workflow.md"`);
    return context.body(serializeWorkflowMarkdown(found.definition));
  });

  routes.post("/:id/duplicate", async (context) => {
    const actor = context.var.actor;
    const found = await resolveWorkflow(store, actor.id, context.req.param("id"));
    if (!found) return context.json({ error: "找不到这个工作流。" }, 404);
    try {
      const copy: WorkflowDefinition = {
        ...structuredClone(found.definition),
        name: found.kind === "preset" ? found.definition.name : `${found.definition.name}（副本）`.slice(0, 40),
      };
      const saved = await createOwn(actor.id, copy, found.id);
      return context.json({ workflow: detail({ id: saved.id, kind: "mine", definition: saved.definition, updatedAt: saved.updatedAt }) }, 201);
    } catch (error) {
      const { body, status } = fail(error);
      return context.json(body, status);
    }
  });

  routes.post("/:id/runs", async (context) => {
    const actor = context.var.actor;
    const found = await resolveWorkflow(store, actor.id, context.req.param("id"));
    if (!found) return context.json({ error: "找不到这个工作流。" }, 404);
    const body = (await context.req.json().catch(() => null)) as { inputs?: unknown; bindings?: unknown } | null;
    const asRecord = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
    try {
      const run = await engine.start({
        ownerUserId: actor.id,
        workflowId: found.id,
        definition: found.definition,
        inputs: asRecord(body?.inputs),
        bindings: asRecord(body?.bindings),
        source: "page",
      });
      return context.json({ run: engine.view(run) }, 201);
    } catch (error) {
      const { body: b, status } = fail(error);
      return context.json(b, status);
    }
  });

  routes.get("/:id", async (context) => {
    const actor = context.var.actor;
    const found = await resolveWorkflow(store, actor.id, context.req.param("id"));
    if (!found) return context.json({ error: "找不到这个工作流。" }, 404);
    return context.json({ workflow: detail(found), warnings: await warningsFor(actor.id, found.definition) });
  });

  routes.put("/:id", async (context) => {
    const actor = context.var.actor;
    const id = context.req.param("id");
    if (id.startsWith(PRESET_PREFIX)) return context.json({ error: "预设不能修改，先「复制为我的工作流」。" }, 403);
    const body = (await context.req.json().catch(() => null)) as { definition?: unknown } | null;
    try {
      const def = validateDefinition(body?.definition);
      const others = (await store.list(actor.id)).filter((w) => w.id !== id);
      if (others.some((w) => w.definition.slug === def.slug))
        return context.json({ error: `你已经有一个标识为「${def.slug}」的工作流了，换一个标识。` }, 409);
      const saved = await store.update(actor.id, id, def);
      if (!saved) return context.json({ error: "找不到这个工作流。" }, 404);
      await audit(actor.id, "workflow_saved", { id, slug: def.slug });
      return context.json({
        workflow: detail({ id: saved.id, kind: "mine", definition: saved.definition, updatedAt: saved.updatedAt }),
        warnings: await warningsFor(actor.id, def),
      });
    } catch (error) {
      const { body: b, status } = fail(error);
      return context.json(b, status);
    }
  });

  routes.delete("/:id", async (context) => {
    const actor = context.var.actor;
    const id = context.req.param("id");
    if (id.startsWith(PRESET_PREFIX)) return context.json({ error: "预设不能删除。" }, 403);
    const removed = await store.remove(actor.id, id);
    if (!removed) return context.json({ error: "找不到这个工作流。" }, 404);
    await audit(actor.id, "workflow_deleted", { id });
    return context.json({ ok: true });
  });

  return routes;
}
