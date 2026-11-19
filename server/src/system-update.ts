import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  projectMagpieGatewayState,
  projectSystemUpdateState,
  SYSTEM_UPDATE_ACTIONS,
  type SystemUpdateAction,
  type SystemUpdateOverview,
} from "../../shared/system-update";
import { type AuditStore, recordAuditEvent } from "./audit";
import type { AppVariables } from "./auth/guards";
import { requireAdmin } from "./auth/guards";
import type { RunningBuild } from "./build-info";
import { atomicWriteFileUniqueSync } from "./security/file-hygiene";

/**
 * 管理后台 → 系统更新（docs/online-update.md）。
 *
 * 这个容器没有、也永远不拿 docker socket。更新由宿主机上的 chisabot-updater（root 的 systemd 服务，
 * deploy/updater/）执行；两边只通过两个挂载目录说话：
 *
 *  - `<dir>/requests/`（读写，只有 API 用户和宿主机 root 能写）：这里写请求文件
 *    `<id>.json` = { id, action: check | update | rollback | magpie, actor, requestedAt, expectCommit? }。
 *    宿主机只认这四种动作，其余字段只用于记录；它从不执行请求里的任何字符串。
 *  - `<dir>/state/`（只读挂载）：宿主机写的 state.json —— 当前镜像、main 上的新提交、正在跑的任务
 *    和日志尾巴、历史。读出来后经 `projectSystemUpdateState` 白名单投影再给浏览器。
 *    同目录还有 magpie.json（deploy/updater/magpie.sh 写的自托管模型网关状态），
 *    经 `projectMagpieGatewayState` 投影后挂在 overview.magpie 上。
 *
 * 身份认证就是文件系统权限：公网网关先认证会话，这里再要求管理员；请求目录只挂进这一个容器。
 */

export type SystemUpdateService = {
  readonly configured: boolean;
  overview(): SystemUpdateOverview;
  request(
    action: SystemUpdateAction,
    actor: { id: string; name?: string | null; email?: string | null },
    expectCommit?: string,
    options?: { full?: boolean },
  ): { id: string } | { error: string; status: 409 | 503 };
  /** 宿主机写完一个任务后，补一条审计（每个任务只记一次）。 */
  pollFinishedJobs(record: (job: NonNullable<SystemUpdateOverview["job"]>) => Promise<void>): Promise<void>;
};

const MAX_STATE_BYTES = 512 * 1024;

export function createSystemUpdateService(options: {
  dir?: string;
  /** 宿主机上仓库检出的路径（CHISABOT_SOURCE_DIR），只用来在页面上拼升级命令。 */
  sourceDir?: string;
  running: RunningBuild;
  now?: () => number;
}): SystemUpdateService {
  const dir = options.dir?.trim();
  const now = options.now ?? Date.now;
  const requestsDir = dir ? path.join(dir, "requests") : "";
  const stateFile = dir ? path.join(dir, "state", "state.json") : "";
  const magpieFile = dir ? path.join(dir, "state", "magpie.json") : "";
  const auditedFile = dir ? path.join(requestsDir, ".audited.json") : "";
  const configured = Boolean(dir && existsSync(requestsDir) && existsSync(path.dirname(stateFile)));

  function readState(): unknown {
    if (!configured) return null;
    try {
      const text = readFileSync(stateFile, "utf8");
      if (text.length > MAX_STATE_BYTES) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function readMagpie(): unknown {
    if (!configured || !magpieFile) return null;
    try {
      const text = readFileSync(magpieFile, "utf8");
      if (text.length > MAX_STATE_BYTES) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function pending(): SystemUpdateAction[] {
    if (!configured) return [];
    const out: SystemUpdateAction[] = [];
    try {
      for (const name of readdirSync(requestsDir)) {
        if (!/^[A-Za-z0-9_-]{6,64}\.json$/u.test(name)) continue;
        try {
          const body = JSON.parse(readFileSync(path.join(requestsDir, name), "utf8"));
          if ((SYSTEM_UPDATE_ACTIONS as readonly string[]).includes(body?.action)) out.push(body.action);
        } catch {
          /* 宿主机正在取走 */
        }
      }
    } catch {
      return [];
    }
    return out;
  }

  const sourceDir = options.sourceDir?.trim();
  const source = sourceDir && /^\/[A-Za-z0-9._/-]{1,200}$/u.test(sourceDir) ? { sourceDir } : {};

  function overview(): SystemUpdateOverview {
    if (!configured) {
      return {
        ...projectSystemUpdateState(null, options.running, [], now()),
        configured: false,
        ...source,
      };
    }
    const magpie = projectMagpieGatewayState(readMagpie());
    return {
      ...projectSystemUpdateState(readState(), options.running, pending(), now()),
      ...(magpie ? { magpie } : {}),
      ...source,
    };
  }

  return {
    configured,
    overview,
    request(action, actor, expectCommit, options) {
      if (!configured) return { error: "这个部署没有安装宿主机更新程序。", status: 503 };
      const state = overview();
      if (!state.updaterOnline && action !== "check")
        return { error: "宿主机更新程序没有在运行，暂时不能更新或回滚。", status: 503 };
      const busy =
        (state.job && (state.job.status === "running" || state.job.status === "queued")) ||
        state.pending.some((item) => item !== "check");
      if (busy && action !== "check") return { error: "已经有一个更新或回滚在进行中。", status: 409 };
      if (state.externalBusy && action !== "check")
        return { error: "宿主机上有人正在手动运行更新或回滚，等它结束再试。", status: 409 };
      if (action === "rollback" && !state.previous) return { error: "没有可以回滚到的上一版。", status: 409 };
      // 依赖或底座变了不再拒绝：宿主机自动改为完整构建（「一键完整更新」）。
      if (action === "check" && state.pending.includes("check")) return { id: "pending" };
      const id = `${action}-${randomUUID().replace(/-/gu, "").slice(0, 20)}`;
      const body = {
        id,
        action,
        requestedAt: new Date(now()).toISOString(),
        actor: (actor.name || actor.email || actor.id).slice(0, 80),
        actorId: actor.id.slice(0, 80),
        ...(expectCommit && /^[0-9a-f]{40}$/u.test(expectCommit) ? { expectCommit } : {}),
        ...(action === "update" && (options?.full || state.depsChanged) ? { mode: "full" } : {}),
      };
      try {
        atomicWriteFileUniqueSync(
          path.join(requestsDir, `${id}.json`),
          JSON.stringify(body),
          { mode: 0o600 },
        );
      } catch {
        // 目录是 Docker 自己建的（root 所有）= 宿主机更新服务没装：页面上有安装命令。
        return { error: "无法写入更新请求：宿主机更新服务没有安装好。", status: 503 };
      }
      return { id };
    },
    async pollFinishedJobs(record) {
      if (!configured) return;
      const job = overview().job;
      if (!job || job.action === "check") return;
      if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "rolled_back") return;
      let audited: string[] = [];
      try {
        audited = JSON.parse(readFileSync(auditedFile, "utf8"));
        if (!Array.isArray(audited)) audited = [];
      } catch {
        audited = [];
      }
      if (audited.includes(job.id)) return;
      await record(job);
      try {
        atomicWriteFileUniqueSync(
          auditedFile,
          JSON.stringify([...audited, job.id].slice(-100)),
          { mode: 0o600 },
        );
      } catch {
        /* 下次再记一次也比不记好 */
      }
    },
  };
}

export function createSystemUpdateRoutes(options: {
  service: SystemUpdateService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  auditStore?: AuditStore;
}) {
  const { service, requireUser, auditStore } = options;
  const routes = new Hono<{ Variables: AppVariables }>();

  async function audit(actorUserId: string | undefined, payload: Record<string, unknown>) {
    if (!auditStore) return;
    try {
      await recordAuditEvent(auditStore, {
        eventType: "configuration.changed",
        targetType: "system_update",
        targetId: typeof payload.job === "string" ? payload.job : "system",
        ...(actorUserId ? { actorUserId } : {}),
        ...(actorUserId ? {} : { initiator: { kind: "deployment" } }),
        payload,
      });
    } catch {
      /* 宿主机自己的 audit.log 也有一份 */
    }
  }

  routes.use("*", requireUser, bodyLimit({ maxSize: 32 * 1024 }));
  routes.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    context.header("Cache-Control", "no-store");
    await next();
  });

  routes.get("/", async (context) => {
    await service
      .pollFinishedJobs((job) =>
        audit(undefined, {
          change: `system_update.${job.action}.${job.status}`,
          job: job.id,
          ...(job.fromImage ? { fromImage: job.fromImage } : {}),
          ...(job.toImage ? { toImage: job.toImage } : {}),
          ...(job.targetCommit ? { commit: job.targetCommit } : {}),
          ...(job.error ? { detail: job.error } : {}),
        }),
      )
      .catch(() => undefined);
    return context.json(service.overview());
  });

  for (const action of SYSTEM_UPDATE_ACTIONS) {
    routes.post(`/${action}`, async (context) => {
      const actor = context.var.actor;
      let expectCommit: string | undefined;
      let full = false;
      if (action === "update") {
        try {
          const body = (await context.req.json()) as { expectCommit?: unknown; mode?: unknown };
          if (typeof body?.expectCommit === "string") expectCommit = body.expectCommit;
          full = body?.mode === "full";
        } catch {
          expectCommit = undefined;
        }
      }
      const result = service.request(action, actor, expectCommit, { full });
      if ("error" in result) {
        if (action !== "check")
          await audit(actor.id, { change: `system_update.${action}.refused`, detail: result.error });
        return context.json({ error: result.error }, result.status);
      }
      if (action !== "check")
        await audit(actor.id, {
          change: `system_update.${action}.requested`,
          job: result.id,
          ...(expectCommit ? { commit: expectCommit } : {}),
          ...(full ? { mode: "full" } : {}),
        });
      return context.json({ id: result.id, overview: service.overview() }, 202);
    });
  }

  return routes;
}
