import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { isMobilePlatform, type DeviceOperation } from "../../../shared/devices";
import {
  ACTIVE_LOCAL_TASK,
  AGENT_PROFILES,
  type AgentProfile,
  type BuiltinModel,
  DEFAULT_CONTAINER_IMAGE,
  type DeviceAgentDetection,
  type DeviceAgentSettings,
  defaultAgentSettings,
  effectiveRoots,
  ISOLATION_INFO,
  ISOLATIONS,
  type Isolation,
  isInsideRoots,
  LOCAL_AGENT_INFO,
  LOCAL_AGENT_KINDS,
  LOCAL_AGENT_MESSAGE_TYPES,
  LOCAL_AGENT_RESULT_MARKER,
  type LlmContentPart,
  type LlmMessage,
  type LocalAgentDiff,
  type LocalAgentKind,
  type LocalAgentLine,
  type LocalAgentRunMessage,
  type LocalAgentTaskStatus,
  type LocalAgentTaskView,
  narrowerProfile,
  PROFILE_INFO,
  profileAllows,
  profileLine,
} from "../../../shared/local-agents";
import type { AppVariables } from "../auth/guards";
import { connectionLanguageModel, type RuntimeModelConnection } from "../copilot";
import type { Database } from "../db/client";
import type { DeviceHub } from "../devices/hub";
import { type DeviceRecord, type DeviceStore, fullAccessActive } from "../devices/store";
import { resolveDevice } from "../devices/tools";
import type { LocalRunControl } from "../local-conversations";
import { REFUSAL_MARKER, type GrantedTool } from "../plugins/tools";
import type { TurnRunner } from "../turns/types";
import type { ThreadInbox } from "../thread-inbox";
import { reasonWithoutStatement } from "../db/query-failure";

/**
 * 本地 agent 与权限档位（docs/local-agents.md，DESIGN.md「本地 agent」）。
 *
 * - 权限档位：每台设备一个（只读 / 工作区 / 完全访问），挂在设备 hub 上（{@link LocalAgentService.extension}）：
 *   云端机器人的 device_* 调用如果在档位之外，能力是「允许」也改成先审批。档位只收紧、从不放宽。
 * - 本地 agent 任务：机器人用 device_agent_run 把一整件事交给电脑上的 agent。启动先审批（除非完全访问 +
 *   命令行「允许」），电脑上的进度一行行流回来，存进 chisabot_local_agent_tasks；聊天里画成任务卡片（停止、
 *   改动列表、应用 / 放弃改动）；结束时结果作为一条消息回到原对话（同后台任务 §38 的交付）。
 * - 内置 agent 的模型调用由这里代调（用这个机器人的模型连接，密钥不出服务器），每个任务有调用次数上限。
 */

const TASK_TIMEOUT_MS = Number(process.env.CHISABOT_LOCAL_AGENT_TIMEOUT_MS) || 45 * 60_000;
const PER_DEVICE_ACTIVE = 2;
const PER_USER_ACTIVE = 4;
const STORED_LINES = 1500;
const CARD_LINES = 40;
const LLM_CALLS_PER_TASK = Number(process.env.CHISABOT_LOCAL_AGENT_LLM_CALLS) || 80;
const RESULT_LIMIT = 6000;

/** 内置 agent 的工具（和 pc/src/agent-runtime/builtin.js 的 TOOLS 一致；工具在电脑上执行，这里只给模型看定义）。 */
export const BUILTIN_TOOLS: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [
  { name: "list_files", description: "列出目录（相对工作目录，默认工作目录本身）。", parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } },
  {
    name: "read_file",
    description: "读取文本文件。offset/limit 按行（从 1 开始），默认读前 400 行。",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "write_file",
    description: "新建或整个覆盖一个文件。",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
  },
  {
    name: "edit_file",
    description: "把文件里的 old_string 换成 new_string（old_string 必须唯一，除非 replace_all）。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "在工作目录里按正则搜索文件内容（跳过 .git、node_modules），最多 200 条。glob 例如 *.ts。",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "run",
    description: "在工作目录里运行一条命令（Windows 是 PowerShell，其它是 sh），默认 120 秒超时。",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_sec: { type: "integer" } }, required: ["command"], additionalProperties: false },
  },
];

type SettingsRow = {
  device_id: string;
  owner_user_id: string;
  profile: string;
  workspace_roots: string[] | null;
  network: boolean;
  isolation: string;
  default_agent: string;
  builtin_model: BuiltinModel | null;
  container_image: string | null;
  detected: DeviceAgentDetection | null;
  updated_at: Date | string | null;
};

type TaskRow = {
  id: string;
  owner_user_id: string;
  device_id: string;
  device_name: string;
  agent_id: string;
  bot_name: string | null;
  thread_id: string | null;
  agent: string;
  title: string;
  task: string;
  profile: string;
  isolation: string;
  network: boolean;
  cwd: string | null;
  status: LocalAgentTaskStatus;
  step: string | null;
  transcript: LocalAgentLine[] | null;
  line_count: number;
  summary: string | null;
  diff: LocalAgentDiff | null;
  error: string | null;
  llm_calls: number;
  result_message_id: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
};

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class LocalAgentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "LocalAgentError";
  }
}

export type LocalAgentServiceOptions = {
  database: Database;
  hub: DeviceHub;
  deviceStore: Pick<DeviceStore, "get" | "forOwner" | "audit">;
  inbox?: ThreadInbox;
  control?: LocalRunControl;
  deliverTurn?: TurnRunner;
  agentOfThread?: (threadId: string) => Promise<string | null>;
  resolveConnectionForAgent?: (agentId: string) => Promise<RuntimeModelConnection>;
  /** 测试用：替换模型调用。 */
  generate?: (input: { agentId: string; system: string; messages: LlmMessage[]; signal: AbortSignal }) => Promise<LlmContentPart[]>;
  timeoutMs?: number;
};

export type LocalAgentService = ReturnType<typeof createLocalAgentService>;

export function createLocalAgentService(options: LocalAgentServiceOptions) {
  const { database, hub, deviceStore } = options;
  const sql = database.$client;
  const settingsCache = new Map<string, DeviceAgentSettings>();
  type Live = { lines: LocalAgentLine[]; count: number; step: string | null; flush?: ReturnType<typeof setTimeout>; approvalId: string | null; approvalSummary: string | null; timer?: ReturnType<typeof setTimeout> };
  const live = new Map<string, Live>();
  const timeoutMs = options.timeoutMs ?? TASK_TIMEOUT_MS;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_device_agent_settings (
        device_id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        profile text NOT NULL DEFAULT 'workspace',
        workspace_roots jsonb NOT NULL DEFAULT '[]'::jsonb,
        network boolean NOT NULL DEFAULT true,
        isolation text NOT NULL DEFAULT 'worktree',
        default_agent text NOT NULL DEFAULT 'builtin',
        builtin_model jsonb,
        container_image text,
        detected jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS chisabot_local_agent_tasks (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        device_id text NOT NULL,
        device_name text NOT NULL DEFAULT '',
        agent_id text NOT NULL,
        bot_name text,
        thread_id text,
        agent text NOT NULL,
        title text NOT NULL,
        task text NOT NULL,
        profile text NOT NULL,
        isolation text NOT NULL,
        network boolean NOT NULL DEFAULT true,
        cwd text,
        status text NOT NULL,
        step text,
        transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
        line_count integer NOT NULL DEFAULT 0,
        summary text,
        diff jsonb,
        error text,
        llm_calls integer NOT NULL DEFAULT 0,
        result_message_id text,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        finished_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chisabot_local_agent_tasks_thread ON chisabot_local_agent_tasks (thread_id, created_at);
      CREATE INDEX IF NOT EXISTS chisabot_local_agent_tasks_device ON chisabot_local_agent_tasks (device_id, created_at);
    `);
  }

  /** 服务重启：没跑完的任务标成失败（电脑上的进程可能还在跑，结果回来时会被忽略）。 */
  async function recover(): Promise<number> {
    const rows = await sql.unsafe<{ id: string }[]>(
      `UPDATE chisabot_local_agent_tasks SET status = 'failed', error = '服务重启，任务做到一半被中断（电脑上的进程可能已经停了）。可以让我重新做。', finished_at = now(), updated_at = now()
       WHERE status IN ('pending_approval','starting','running') RETURNING id`,
    );
    return rows.length;
  }

  // ── 设置 ──────────────────────────────────────────────────────────────

  function fromRow(deviceId: string, row: SettingsRow | undefined): DeviceAgentSettings {
    const base = defaultAgentSettings(deviceId);
    if (!row) return base;
    return {
      deviceId,
      profile: (AGENT_PROFILES as readonly string[]).includes(row.profile) ? (row.profile as AgentProfile) : base.profile,
      workspaceRoots: Array.isArray(row.workspace_roots) ? row.workspace_roots.filter((r) => typeof r === "string") : [],
      network: row.network !== false,
      isolation: (ISOLATIONS as readonly string[]).includes(row.isolation) ? (row.isolation as Isolation) : base.isolation,
      defaultAgent: (LOCAL_AGENT_KINDS as readonly string[]).includes(row.default_agent) ? (row.default_agent as LocalAgentKind) : base.defaultAgent,
      builtinModel: row.builtin_model && (row.builtin_model.kind === "server" || row.builtin_model.kind === "local") ? row.builtin_model : base.builtinModel,
      containerImage: row.container_image || DEFAULT_CONTAINER_IMAGE,
      detected: row.detected ?? null,
      saved: true,
      updatedAt: iso(row.updated_at),
    };
  }

  async function settingsFor(deviceId: string): Promise<DeviceAgentSettings> {
    const cached = settingsCache.get(deviceId);
    if (cached) return cached;
    const rows = await sql.unsafe<SettingsRow[]>("SELECT * FROM chisabot_device_agent_settings WHERE device_id = $1", [deviceId]);
    const settings = fromRow(deviceId, rows[0]);
    settingsCache.set(deviceId, settings);
    return settings;
  }

  async function writeSettings(device: DeviceRecord, settings: DeviceAgentSettings) {
    await sql.unsafe(
      `INSERT INTO chisabot_device_agent_settings (device_id, owner_user_id, profile, workspace_roots, network, isolation, default_agent, builtin_model, container_image, detected, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7, $8::text::jsonb, $9, $10::text::jsonb, now())
       ON CONFLICT (device_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, profile = EXCLUDED.profile, workspace_roots = EXCLUDED.workspace_roots,
         network = EXCLUDED.network, isolation = EXCLUDED.isolation, default_agent = EXCLUDED.default_agent, builtin_model = EXCLUDED.builtin_model,
         container_image = EXCLUDED.container_image, detected = EXCLUDED.detected, updated_at = now()`,
      [
        device.id,
        device.ownerUserId,
        settings.profile,
        JSON.stringify(settings.workspaceRoots),
        settings.network,
        settings.isolation,
        settings.defaultAgent,
        JSON.stringify(settings.builtinModel),
        settings.containerImage,
        settings.detected ? JSON.stringify(settings.detected) : null,
      ],
    );
    settingsCache.delete(device.id);
  }

  const settingsPatch = z
    .object({
      profile: z.enum(AGENT_PROFILES).optional(),
      workspaceRoots: z.array(z.string().min(1).max(1000)).max(20).optional(),
      network: z.boolean().optional(),
      isolation: z.enum(ISOLATIONS).optional(),
      defaultAgent: z.enum(LOCAL_AGENT_KINDS).optional(),
      builtinModel: z
        .union([z.object({ kind: z.literal("server") }), z.object({ kind: z.literal("local"), baseUrl: z.string().url().max(500), model: z.string().min(1).max(200) })])
        .optional(),
      containerImage: z.string().min(1).max(200).regex(/^[\w./:@-]+$/u, "镜像名只能有字母、数字和 ./:@-").optional(),
    })
    .strict();

  /** 只有用户自己（网页 / 手机 / PC 里的网页）能改档位；机器人没有改档位的工具。 */
  async function saveSettings(actorId: string, deviceId: string, patch: z.infer<typeof settingsPatch>) {
    const device = await deviceStore.get(deviceId);
    if (!device || device.ownerUserId !== actorId) throw new LocalAgentError("没有这台设备。", 404);
    if (isMobilePlatform(device.platform)) throw new LocalAgentError("手机不能运行本地 agent。", 400);
    if (patch.profile === "full")
      throw new LocalAgentError("「完全访问」在 设置 → 设备 → 权限 里打开（有时限，到期自动回到这里选的档位）。", 400);
    const before = await settingsFor(deviceId);
    const next: DeviceAgentSettings = { ...before, ...patch, saved: true } as DeviceAgentSettings;
    await writeSettings(device, next);
    const changes: string[] = [];
    if (before.profile !== next.profile) changes.push(`档位：${PROFILE_INFO[before.profile].label} → ${PROFILE_INFO[next.profile].label}`);
    if (before.isolation !== next.isolation) changes.push(`隔离：${ISOLATION_INFO[next.isolation].label}`);
    if (before.network !== next.network) changes.push(next.network ? "本地 agent 可以联网" : "本地 agent 断网");
    if (before.defaultAgent !== next.defaultAgent) changes.push(`默认 agent：${LOCAL_AGENT_INFO[next.defaultAgent].label}`);
    if (before.workspaceRoots.join("|") !== next.workspaceRoots.join("|")) changes.push(`工作区文件夹：${next.workspaceRoots.length || "沿用允许的文件夹"}`);
    if (JSON.stringify(before.builtinModel) !== JSON.stringify(next.builtinModel)) changes.push(`内置 agent 模型：${next.builtinModel.kind === "server" ? "服务器" : `本地 ${next.builtinModel.model}`}`);
    if (changes.length)
      await deviceStore.audit({
        deviceId,
        ownerUserId: device.ownerUserId,
        actorType: "user",
        actorId,
        actorName: null,
        action: "agent_profile_changed",
        summary: changes.join("；"),
        outcome: "succeeded",
        detail: null,
        durationMs: null,
      });
    return settingsFor(deviceId);
  }

  /**
   * 实际生效的档位：设备的「完全访问」（ADR-0009，有时限，只能在 设置 → 设备 → 权限 打开）开着时是完全访问，
   * 否则是这里存的 只读 / 工作区（存的 full 是旧数据，按工作区算）。
   */
  function effectiveProfile(settings: DeviceAgentSettings, record: DeviceRecord): AgentProfile {
    if (fullAccessActive(record)) return "full";
    return settings.profile === "full" ? "workspace" : settings.profile;
  }

  // ── 设备 hub 扩展 ─────────────────────────────────────────────────────

  const extension = {
    onHello(record: DeviceRecord) {
      if (!isMobilePlatform(record.platform)) hub.sendRaw(record.id, { type: "agent_detect" });
    },
    async gate(record: DeviceRecord, operation: DeviceOperation, args: Record<string, unknown>) {
      const settings = await settingsFor(record.id);
      const profile = effectiveProfile(settings, record);
      const verdict = profileAllows(profile, operation, args, effectiveRoots(settings, record.allowedRoots), record.platform);
      return verdict.inside ? null : `${verdict.reason ?? "档位之外"}，档位「${PROFILE_INFO[profile].label}」`;
    },
    async onMessage(record: DeviceRecord, message: { type: string } & Record<string, unknown>) {
      if (!LOCAL_AGENT_MESSAGE_TYPES.has(message.type)) return;
      await handleNodeMessage(record, message);
    },
  };

  // ── 任务 ──────────────────────────────────────────────────────────────

  async function taskRow(id: string) {
    return (await sql.unsafe<TaskRow[]>("SELECT * FROM chisabot_local_agent_tasks WHERE id = $1", [id]))[0] ?? null;
  }

  function view(row: TaskRow, full = false): LocalAgentTaskView & { task?: string; transcript?: LocalAgentLine[] } {
    const state = live.get(row.id);
    const lines = state ? state.lines : (row.transcript ?? []);
    return {
      id: row.id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      agent: row.agent as LocalAgentKind,
      title: row.title,
      profile: row.profile as AgentProfile,
      isolation: row.isolation as Isolation,
      network: row.network,
      cwd: row.cwd,
      status: row.status,
      step: state?.step ?? row.step,
      lines: lines.slice(-CARD_LINES),
      lineCount: state ? state.count : row.line_count,
      summary: row.summary,
      diff: row.diff ? { ...row.diff, patch: full ? row.diff.patch : row.diff.patch ? clip(row.diff.patch, 6000) : undefined } : null,
      error: row.error,
      approvalId: state?.approvalId ?? null,
      approvalSummary: state?.approvalSummary ?? null,
      resultMessageId: row.result_message_id,
      createdAt: iso(row.created_at)!,
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      ...(full ? { task: row.task, transcript: lines } : {}),
    };
  }

  function liveOf(id: string): Live {
    let state = live.get(id);
    if (!state) {
      state = { lines: [], count: 0, step: null, approvalId: null, approvalSummary: null };
      live.set(id, state);
    }
    return state;
  }

  function scheduleFlush(id: string) {
    const state = live.get(id);
    if (!state || state.flush) return;
    state.flush = setTimeout(() => {
      state.flush = undefined;
      void sql
        .unsafe("UPDATE chisabot_local_agent_tasks SET transcript = $2::text::jsonb, line_count = $3, step = $4, updated_at = now() WHERE id = $1", [
          id,
          JSON.stringify(state.lines.slice(-STORED_LINES)),
          state.count,
          state.step,
        ])
        .catch(() => {});
    }, 700);
    state.flush.unref?.();
  }

  function pushLine(id: string, kind: LocalAgentLine["kind"], text: string, step?: string | null) {
    const state = liveOf(id);
    state.lines.push({ at: new Date().toISOString(), kind, text: clip(String(text), 2000) });
    if (state.lines.length > STORED_LINES) state.lines.splice(0, state.lines.length - STORED_LINES);
    state.count++;
    if (step) state.step = clip(step, 200);
    scheduleFlush(id);
  }

  async function setStatus(id: string, status: LocalAgentTaskStatus, extra: Record<string, unknown> = {}) {
    const sets = ["status = $2", "updated_at = now()"];
    const params: unknown[] = [id, status];
    for (const [key, value] of Object.entries(extra)) {
      params.push(value);
      sets.push(`${key} = $${params.length}${key === "diff" ? "::text::jsonb" : ""}`);
    }
    await sql.unsafe(`UPDATE chisabot_local_agent_tasks SET ${sets.join(", ")} WHERE id = $1`, params as never[]);
  }

  async function finish(id: string, status: "done" | "failed" | "cancelled", fields: { summary?: string | null; error?: string | null; diff?: LocalAgentDiff | null }) {
    const state = live.get(id);
    if (state?.flush) clearTimeout(state.flush);
    if (state?.timer) clearTimeout(state.timer);
    const rows = await sql.unsafe<TaskRow[]>(
      `UPDATE chisabot_local_agent_tasks SET status = $2, summary = $3, error = $4, diff = coalesce($5::text::jsonb, diff), finished_at = now(), updated_at = now(),
         transcript = coalesce($6::text::jsonb, transcript), line_count = coalesce($7, line_count), step = NULL
       WHERE id = $1 AND status IN ('pending_approval','starting','running') RETURNING *`,
      [
        id,
        status,
        fields.summary ?? null,
        fields.error ?? null,
        fields.diff ? JSON.stringify(fields.diff) : null,
        state ? JSON.stringify(state.lines.slice(-STORED_LINES)) : null,
        state ? state.count : null,
      ],
    );
    live.delete(id);
    const row = rows[0] ?? null;
    if (row)
      await deviceStore
        .audit({
          deviceId: row.device_id,
          ownerUserId: row.owner_user_id,
          actorType: "bot",
          actorId: row.agent_id,
          actorName: row.bot_name,
          action: "local_agent_done",
          summary: clip(`${LOCAL_AGENT_INFO[row.agent as LocalAgentKind]?.label ?? row.agent}：${row.title}${row.diff?.files.length ? `（${row.diff.files.length} 个文件 +${row.diff.added} −${row.diff.removed}）` : ""}`, 400),
          outcome: status === "done" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed",
          detail: row.error,
          durationMs: row.started_at ? Date.now() - new Date(row.started_at).getTime() : null,
        })
        .catch(() => {});
    if (row) await deliver(row).catch((error) => console.warn("local agent delivery failed", error));
    return row;
  }

  function diffLine(diff: LocalAgentDiff | null | undefined) {
    if (!diff || !diff.files.length) return "没有改动文件。";
    const names = diff.files.slice(0, 8).map((f) => f.path).join("、");
    return `改动：${diff.files.length} 个文件（+${diff.added} −${diff.removed}）：${names}${diff.files.length > 8 ? " 等" : ""}。${
      diff.pending ? "改动在一次性副本里，还没回到原文件夹——用户可以在任务卡片上点「应用改动」或「放弃」。" : ""
    }`;
  }

  /** 结果回到原对话（同后台任务 §38.2）。 */
  async function deliver(row: TaskRow) {
    if (!row.thread_id || !options.inbox || !options.control || !options.deliverTurn) return;
    const messageId = `local-agent-result-${row.id}`;
    const agentLabel = LOCAL_AGENT_INFO[row.agent as LocalAgentKind]?.label ?? row.agent;
    const statusZh = row.status === "done" ? "已完成" : row.status === "cancelled" ? "已停止" : "没有完成";
    const body = row.status === "done" ? row.summary || "（没有文字结果）" : [row.error, row.summary].filter(Boolean).join("\n\n") || "（没有说明原因）";
    const content = `${LOCAL_AGENT_RESULT_MARKER}${row.id}:${row.status}⟧\n本地 agent「${agentLabel}」在「${row.device_name}」上${statusZh}：${row.title}\n\n${clip(body, RESULT_LIMIT)}\n\n${diffLine(row.diff)}`;
    const message = { id: messageId, role: "user", content } as Message;
    await sql.unsafe("UPDATE chisabot_local_agent_tasks SET result_message_id = $2 WHERE id = $1", [row.id, messageId]);
    const enqueue = () => options.inbox!.enqueue({ threadId: row.thread_id!, ownerUserId: row.owner_user_id, message, kind: "worker_result" });
    if (options.control.isActive(row.thread_id)) {
      await enqueue();
      if (options.control.isActive(row.thread_id)) return;
    }
    const agentId = (await options.agentOfThread?.(row.thread_id)) ?? row.agent_id;
    try {
      await options.inbox.withdraw(row.thread_id, messageId);
      await options.deliverTurn({
        ownerUserId: row.owner_user_id,
        routineId: `local-agent:${row.id}`,
        agentId,
        threadId: row.thread_id,
        instruction: content,
        initiator: { kind: "routine", id: `local-agent:${row.id}` },
        userMessage: message,
        forwardedProps: { chisabotWorkerDelivery: { id: row.id }, chisabotLocalAgentDelivery: { id: row.id } },
      });
    } catch (error) {
      console.warn(JSON.stringify({ type: "local-agent-delivery-queued", task: row.id, reason: error instanceof Error ? error.message : String(error) }));
      await sql.unsafe("UPDATE chisabot_thread_inbox SET status = 'queued', updated_at = now() WHERE thread_id = $1 AND id = $2", [row.thread_id, messageId]).catch(() => {});
      await enqueue().catch(() => {});
    }
  }

  async function generate(row: TaskRow, system: string, messages: LlmMessage[], signal: AbortSignal): Promise<LlmContentPart[]> {
    if (options.generate) return options.generate({ agentId: row.agent_id, system, messages, signal });
    if (!options.resolveConnectionForAgent) throw new Error("服务器没有配置模型。");
    const connection = await options.resolveConnectionForAgent(row.agent_id);
    const model = connectionLanguageModel(connection.model, connection.apiKey);
    const prompt: unknown[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") prompt.push({ role: "user", content: [{ type: "text", text: String(m.text ?? "") }] });
      else if (m.role === "assistant")
        prompt.push({
          role: "assistant",
          content: (m.content ?? []).map((part) => {
            if (part.type === "text") return { type: "text", text: part.text };
            let input: unknown = {};
            try {
              input = JSON.parse(part.input || "{}");
            } catch {}
            return { type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input };
          }),
        });
      else if (m.role === "tool")
        prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: m.toolCallId, toolName: m.toolName, output: { type: "text", value: String(m.output ?? "") } }] });
    }
    const result = await model.doGenerate({
      prompt,
      tools: BUILTIN_TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.parameters })),
      maxOutputTokens: 8192,
      abortSignal: signal,
    } as never);
    const parts: LlmContentPart[] = [];
    for (const part of result.content as Array<{ type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown }>) {
      if (part.type === "text" && part.text) parts.push({ type: "text", text: part.text });
      else if (part.type === "tool-call")
        parts.push({
          type: "tool-call",
          toolCallId: String(part.toolCallId),
          toolName: String(part.toolName),
          input: typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
        });
    }
    return parts;
  }

  async function handleNodeMessage(record: DeviceRecord, message: { type: string } & Record<string, unknown>) {
    if (message.type === "agents_detected") {
      const detection = message.detection as Omit<DeviceAgentDetection, "checkedAt"> | undefined;
      if (!detection || typeof detection !== "object") return;
      const settings = await settingsFor(record.id);
      const clean: DeviceAgentDetection = {
        agents: Array.isArray(detection.agents)
          ? detection.agents
              .filter((a) => a && (LOCAL_AGENT_KINDS as readonly string[]).includes(a.kind))
              .map((a) => ({ kind: a.kind, version: a.version ? String(a.version).slice(0, 40) : null, path: a.path ? String(a.path).slice(0, 400) : null }))
          : [],
        sandboxes: detection.sandboxes && typeof detection.sandboxes === "object" ? Object.fromEntries(Object.entries(detection.sandboxes).map(([k, v]) => [k.slice(0, 32), v === true])) : {},
        platform: typeof detection.platform === "string" ? detection.platform : record.platform,
        root: detection.root === true,
        checkedAt: new Date().toISOString(),
      };
      // 检测结果不算用户改设置：保持 saved 原值（没保存过的设备只存检测结果、其余仍是默认值）。
      await writeSettings(record, { ...settings, detected: clean });
      return;
    }
    const taskId = String(message.taskId ?? "");
    const row = taskId ? await taskRow(taskId) : null;
    // 只认这台设备自己的任务。
    if (!row || row.device_id !== record.id) return;
    const active = ACTIVE_LOCAL_TASK.includes(row.status);
    switch (message.type) {
      case "agent_started":
        if (active) await setStatus(taskId, "running", { started_at: new Date().toISOString() });
        return;
      case "agent_event":
        if (!active) return;
        if (row.status === "starting") await setStatus(taskId, "running", { started_at: new Date().toISOString() });
        pushLine(taskId, (["text", "tool", "status", "stderr", "approval"].includes(String(message.kind)) ? message.kind : "text") as LocalAgentLine["kind"], String(message.text ?? ""), typeof message.step === "string" ? message.step : null);
        return;
      case "agent_done": {
        if (!active) return;
        const diff = message.diff && typeof message.diff === "object" ? sanitizeDiff(message.diff as LocalAgentDiff) : null;
        const ok = message.ok === true;
        const stopped = message.stopped === true;
        await finish(taskId, ok ? "done" : stopped ? "cancelled" : "failed", {
          summary: typeof message.summary === "string" ? clip(message.summary, 8000) : null,
          error: ok ? null : clip(String(message.error ?? "本地 agent 没有完成。"), 1500),
          diff,
        });
        return;
      }
      case "agent_applied": {
        if (!row.diff) return;
        const next = message.ok === true ? { ...row.diff, pending: false, applied: !message.discarded, discarded: message.discarded === true } : row.diff;
        await sql.unsafe("UPDATE chisabot_local_agent_tasks SET diff = $2::text::jsonb, error = CASE WHEN $3::text IS NULL THEN error ELSE $3 END, updated_at = now() WHERE id = $1", [
          taskId,
          JSON.stringify(next),
          message.ok === true ? null : clip(String(message.error ?? "应用改动失败。"), 600),
        ]);
        pendingApply.get(taskId)?.(message.ok === true ? null : String(message.error ?? "应用改动失败。"));
        return;
      }
      case "agent_llm": {
        const reqId = String(message.reqId ?? "");
        const reply = (body: Record<string, unknown>) => hub.sendRaw(record.id, { type: "agent_llm_result", reqId, ...body });
        if (!active || row.agent !== "builtin") return void reply({ ok: false, error: "任务已经结束。" });
        if (row.llm_calls >= LLM_CALLS_PER_TASK) return void reply({ ok: false, error: `这个任务的模型调用超过 ${LLM_CALLS_PER_TASK} 次上限，已停止。` });
        await sql.unsafe("UPDATE chisabot_local_agent_tasks SET llm_calls = llm_calls + 1 WHERE id = $1", [taskId]);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 170_000);
        try {
          const messages = Array.isArray(message.messages) ? (message.messages as LlmMessage[]).slice(-200) : [];
          const system = typeof message.system === "string" ? clip(message.system, 6000) : "你是 ChisaBot 的本地 agent。";
          const content = await generate(row, system, messages, controller.signal);
          reply({ ok: true, content });
        } catch (error) {
          reply({ ok: false, error: clip(error instanceof Error ? error.message : String(error), 400) });
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      case "agent_approval": {
        const reqId = String(message.reqId ?? "");
        const reply = (approved: boolean) => hub.sendRaw(record.id, { type: "agent_approval_result", reqId, approved });
        if (!active) return void reply(false);
        const fresh = (await deviceStore.get(record.id)) ?? record;
        if (fresh.paused || fresh.revoked) return void reply(false);
        const summary = clip(`本地 agent 任务「${row.title}」：${String(message.summary ?? "")}`, 400);
        const state = liveOf(taskId);
        const decision = await hub.requestUserApproval(
          fresh,
          { bot: { id: row.agent_id, name: row.bot_name }, operation: message.operation === "shell" ? "shell" : "write_file", summary },
          (approvalId) => {
            state.approvalId = approvalId;
            state.approvalSummary = summary;
          },
        );
        state.approvalId = null;
        state.approvalSummary = null;
        pushLine(taskId, "approval", decision.approved ? "已批准" : decision.by === "expired" ? "审批超时，没有执行" : "你拒绝了这一步");
        reply(decision.approved);
        return;
      }
      default:
    }
  }

  function sanitizeDiff(diff: LocalAgentDiff): LocalAgentDiff {
    const files = Array.isArray(diff.files)
      ? diff.files.slice(0, 300).map((f) => ({
          path: clip(String(f.path ?? ""), 400),
          added: Number(f.added) || 0,
          removed: Number(f.removed) || 0,
          status: f.status === "added" || f.status === "deleted" ? f.status : ("modified" as const),
        }))
      : [];
    return {
      files,
      added: Number(diff.added) || 0,
      removed: Number(diff.removed) || 0,
      pending: diff.pending === true && files.length > 0,
      applied: false,
      ...(typeof diff.patch === "string" && diff.patch ? { patch: clip(diff.patch, 24_000) } : {}),
    };
  }

  const pendingApply = new Map<string, (error: string | null) => void>();

  type StartInput = {
    ownerUserId: string;
    botId: string;
    botName: string | null;
    threadId: string | null;
    device?: string;
    agent?: LocalAgentKind;
    task: string;
    title?: string;
    cwd?: string;
    profile?: AgentProfile;
    isolation?: Isolation;
    network?: boolean;
  };

  /** 交一个任务给电脑上的 agent。返回任务（启动在后台继续：审批 → 发给电脑）。被拒绝时抛 LocalAgentError。 */
  async function start(input: StartInput): Promise<LocalAgentTaskView> {
    const picked = await resolveDevice(deviceStore, input.ownerUserId, input.device, (id) => hub.isOnline(id));
    if (typeof picked === "string") throw new LocalAgentError(picked);
    const device = picked;
    if (isMobilePlatform(device.platform)) throw new LocalAgentError("手机不能运行本地 agent。");
    if (!hub.isOnline(device.id)) throw new LocalAgentError(`「${device.name}」现在离线。`);
    if (device.paused) throw new LocalAgentError(`「${device.name}」已紧急停止。`);
    if (device.capabilities.shell === "off")
      throw new LocalAgentError(`「${device.name}」的「命令行」能力是关闭的，本地 agent 要运行程序，需要先在 设置 → 设备 → 权限 把它设为「询问」或「允许」。`);
    const settings = await settingsFor(device.id);
    const agent = input.agent ?? settings.defaultAgent;
    const detected = settings.detected?.agents ?? [];
    if (agent !== "builtin" && settings.detected && !detected.some((a) => a.kind === agent)) {
      const have = detected.map((a) => LOCAL_AGENT_INFO[a.kind]?.label ?? a.kind).join("、");
      throw new LocalAgentError(`「${device.name}」上没有检测到 ${LOCAL_AGENT_INFO[agent].label}。已安装：${have || "只有 ChisaBot 内置"}。`);
    }
    const profile = narrowerProfile(effectiveProfile(settings, device), input.profile);
    const isolation = input.isolation ?? settings.isolation;
    const network = input.network === undefined ? settings.network : input.network && settings.network;
    const roots = effectiveRoots(settings, device.allowedRoots);
    const cwd = input.cwd?.trim() || roots[0] || null;
    if (!cwd) throw new LocalAgentError(`「${device.name}」还没有工作区文件夹。请在 设置 → 设备 → 本地 agent（或 权限 → 允许的文件夹）里选一个，或者告诉我具体在哪个文件夹做。`);
    if (profile !== "full" && !isInsideRoots(cwd, roots, device.platform))
      throw new LocalAgentError(`「${cwd}」不在这台电脑的工作区文件夹里（${roots.join("、") || "还没有"}）。可以换一个文件夹，或者请用户在 设置 → 设备 → 本地 agent 里加上它。`);
    const sandboxes = settings.detected?.sandboxes ?? {};
    if (isolation !== "none" && isolation !== "copy" && settings.detected && sandboxes[isolation] !== true)
      throw new LocalAgentError(`「${device.name}」上不能用「${ISOLATION_INFO[isolation].label}」。可用：${ISOLATIONS.filter((i) => i === "none" || i === "copy" || sandboxes[i]).map((i) => ISOLATION_INFO[i].label).join("、")}。`);
    if ((isolation === "docker" || isolation === "podman") && agent !== "builtin")
      throw new LocalAgentError("容器隔离只给 ChisaBot 内置 agent 用（命令行 agent 要用它自己的登录，在容器里拿不到）。可以改用 worktree / 临时副本 / bubblewrap。");
    if (isolation === "none" && profile === "readonly" && agent !== "builtin" && agent !== "claude" && agent !== "codex")
      throw new LocalAgentError(`${LOCAL_AGENT_INFO[agent].label} 没有只读模式。请用 Claude Code、Codex 或内置 agent，或者在一次性副本里做。`);
    if (!network && agent !== "builtin")
      throw new LocalAgentError(`${LOCAL_AGENT_INFO[agent].label} 要联网访问它自己的模型服务，断网时只能用 ChisaBot 内置 agent（配合电脑上的本地模型）。`);
    if (!network && agent === "builtin" && settings.builtinModel.kind === "server" && isolation !== "docker" && isolation !== "podman" && isolation !== "bwrap" && isolation !== "sandbox-exec")
      throw new LocalAgentError("「断网」要靠系统级沙盒（bubblewrap / macOS 沙盒 / Docker）才能真正做到；这台电脑当前的隔离方式做不到断网。");
    const sandboxed = ISOLATION_INFO[isolation].sandbox;
    const disposable = ISOLATION_INFO[isolation].disposable;
    if (agent !== "builtin" && agent !== "claude" && agent !== "codex" && profile !== "full" && !sandboxed && !disposable)
      throw new LocalAgentError(`${LOCAL_AGENT_INFO[agent].label} 没有逐条确认，只在「完全访问」档位、一次性副本或系统级沙盒里使用。`);
    const [deviceActive, userActive] = await Promise.all([
      sql.unsafe<{ n: number }[]>("SELECT count(*)::int AS n FROM chisabot_local_agent_tasks WHERE device_id = $1 AND status IN ('pending_approval','starting','running')", [device.id]),
      sql.unsafe<{ n: number }[]>("SELECT count(*)::int AS n FROM chisabot_local_agent_tasks WHERE owner_user_id = $1 AND status IN ('pending_approval','starting','running')", [input.ownerUserId]),
    ]);
    if ((deviceActive[0]?.n ?? 0) >= PER_DEVICE_ACTIVE) throw new LocalAgentError(`「${device.name}」上已经有 ${PER_DEVICE_ACTIVE} 个本地 agent 任务在跑，等一个结束再交新的。`, 409);
    if ((userActive[0]?.n ?? 0) >= PER_USER_ACTIVE) throw new LocalAgentError(`已经有 ${PER_USER_ACTIVE} 个本地 agent 任务在跑。`, 409);

    const id = randomUUID();
    const title = clip((input.title || input.task).replace(/\s+/g, " ").trim(), 60);
    const skipPermissions = profile === "full" || sandboxed;
    // 完全访问（ADR-0009：所有能力按「允许」）才直接开始；其余都先在网页 / 手机 / PC 上批准。
    const needsApproval = profile !== "full";
    await sql.unsafe(
      `INSERT INTO chisabot_local_agent_tasks (id, owner_user_id, device_id, device_name, agent_id, bot_name, thread_id, agent, title, task, profile, isolation, network, cwd, status, step)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, input.ownerUserId, device.id, device.name, input.botId, input.botName, input.threadId, agent, title, input.task, profile, isolation, network, cwd, needsApproval ? "pending_approval" : "starting", needsApproval ? "等待你批准" : "正在发给电脑"],
    );
    const state = liveOf(id);
    state.step = needsApproval ? "等待你批准" : "正在发给电脑";
    pushLine(id, "status", `交给「${device.name}」上的 ${LOCAL_AGENT_INFO[agent].label}：${profileLine({ profile, isolation, network })}，文件夹 ${cwd}`);
    await deviceStore.audit({
      deviceId: device.id,
      ownerUserId: device.ownerUserId,
      actorType: "bot",
      actorId: input.botId,
      actorName: input.botName,
      action: "local_agent_task",
      summary: clip(`交给 ${LOCAL_AGENT_INFO[agent].label}：${title}（${profileLine({ profile, isolation, network })}，${cwd}）`, 400),
      outcome: "succeeded",
      detail: null,
      durationMs: null,
    });

    const run: LocalAgentRunMessage = {
      type: "agent_run",
      taskId: id,
      agent,
      prompt: input.task,
      cwd,
      profile,
      isolation,
      network,
      roots,
      skipPermissions,
      builtinModel: settings.builtinModel,
      containerImage: settings.containerImage,
      timeoutMs,
    };
    void (async () => {
      if (needsApproval) {
        const summary = clip(
          `用 ${LOCAL_AGENT_INFO[agent].label} 做：${title}（${profileLine({ profile, isolation, network })}，文件夹 ${cwd}${skipPermissions && agent !== "builtin" ? "，agent 跳过它自己的逐条确认" : ""}）`,
          400,
        );
        const decision = await hub.requestUserApproval(device, { bot: { id: input.botId, name: input.botName }, operation: "shell", summary }, (approvalId) => {
          state.approvalId = approvalId;
          state.approvalSummary = summary;
        });
        state.approvalId = null;
        state.approvalSummary = null;
        if (!decision.approved) {
          await finish(id, "cancelled", { error: decision.by === "expired" ? "2 分钟内没有人批准，任务没有开始。" : "你没有批准这个任务，它没有开始。" });
          return;
        }
        const fresh = await deviceStore.get(device.id);
        if (!fresh || fresh.paused || fresh.revoked || !hub.isOnline(device.id)) {
          await finish(id, "failed", { error: "批准期间电脑停止、离线或被撤销，任务没有开始。" });
          return;
        }
        await setStatus(id, "starting", { step: "正在发给电脑" });
        state.step = "正在发给电脑";
        pushLine(id, "approval", "已批准");
      }
      if (!hub.sendRaw(device.id, run as unknown as { type: string } & Record<string, unknown>)) {
        await finish(id, "failed", { error: "电脑离线，没能把任务发过去。" });
        return;
      }
      state.timer = setTimeout(() => {
        hub.sendRaw(device.id, { type: "agent_stop", taskId: id });
        void finish(id, "failed", { error: `超过 ${Math.round(timeoutMs / 60_000)} 分钟没有结束，已停止。` });
      }, timeoutMs + 60_000);
      state.timer.unref?.();
    })().catch((error) => {
      console.warn("local agent start failed", error);
      void finish(id, "failed", { error: "启动失败。" });
    });
    return view((await taskRow(id))!);
  }

  async function owned(actorId: string, id: string) {
    const row = await taskRow(id);
    if (!row || row.owner_user_id !== actorId) throw new LocalAgentError("没有这个任务。", 404);
    return row;
  }

  async function stop(actorId: string, id: string, by: "user" | "bot" = "user") {
    const row = await owned(actorId, id);
    if (!ACTIVE_LOCAL_TASK.includes(row.status)) return view(row);
    const state = live.get(id);
    if (state?.approvalId) hub.decide(state.approvalId, false, "system");
    hub.sendRaw(row.device_id, { type: "agent_stop", taskId: id });
    // 电脑会回 agent_done（stopped）；它离线或没回就在这里收尾。
    const done = await finish(id, "cancelled", { error: by === "user" ? "你在任务卡片上停止了这个任务。" : "机器人停止了这个任务。" });
    return view(done ?? (await taskRow(id))!);
  }

  async function applyChanges(actorId: string, id: string, discard: boolean) {
    const row = await owned(actorId, id);
    if (!row.diff?.pending) throw new LocalAgentError(discard ? "没有要放弃的改动。" : "没有待应用的改动。");
    if (!hub.isOnline(row.device_id)) throw new LocalAgentError(`「${row.device_name}」现在离线，改动还在那台电脑的临时目录里。`, 409);
    const result = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingApply.delete(id);
        resolve("电脑没有及时回应。");
      }, 60_000);
      pendingApply.set(id, (error) => {
        clearTimeout(timer);
        pendingApply.delete(id);
        resolve(error);
      });
      if (!hub.sendRaw(row.device_id, { type: discard ? "agent_discard" : "agent_apply", taskId: id })) {
        clearTimeout(timer);
        pendingApply.delete(id);
        resolve("电脑离线。");
      }
    });
    const device = await deviceStore.get(row.device_id);
    if (device)
      await deviceStore.audit({
        deviceId: row.device_id,
        ownerUserId: row.owner_user_id,
        actorType: "user",
        actorId,
        actorName: null,
        action: discard ? "local_agent_discard" : "local_agent_apply",
        summary: clip(`${row.title}：${row.diff.files.length} 个文件`, 300),
        outcome: result ? "failed" : "succeeded",
        detail: result,
        durationMs: null,
      });
    if (result) throw new LocalAgentError(result, 409);
    return view((await taskRow(id))!);
  }

  async function forThread(actorId: string, threadId: string) {
    const rows = await sql.unsafe<TaskRow[]>("SELECT * FROM chisabot_local_agent_tasks WHERE thread_id = $1 AND owner_user_id = $2 ORDER BY created_at ASC LIMIT 50", [threadId, actorId]);
    return rows.map((row) => view(row));
  }

  async function forDevice(actorId: string, deviceId: string) {
    const rows = await sql.unsafe<TaskRow[]>("SELECT * FROM chisabot_local_agent_tasks WHERE device_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC LIMIT 20", [deviceId, actorId]);
    return rows.map((row) => view(row));
  }

  /** 删设备时一起删。 */
  async function forgetDevice(deviceId: string) {
    settingsCache.delete(deviceId);
    await sql.unsafe("DELETE FROM chisabot_device_agent_settings WHERE device_id = $1", [deviceId]);
  }

  // ── 机器人工具 ────────────────────────────────────────────────────────

  function guidanceText(devices: Array<{ device: DeviceRecord; settings: DeviceAgentSettings }>) {
    const lines = devices.map(({ device, settings }) => {
      const agents = (settings.detected?.agents ?? [{ kind: "builtin" as const }]).map((a) => LOCAL_AGENT_INFO[a.kind]?.label ?? a.kind).join("、");
      return `- 「${device.name}」：档位 ${PROFILE_INFO[effectiveProfile(settings, device)].label}，默认隔离 ${ISOLATION_INFO[settings.isolation].label}，本地 agent：${agents}（默认 ${LOCAL_AGENT_INFO[settings.defaultAgent].label}）`;
    });
    return [
      "Local agents on the person's computer (本地 agent). The default way to work on their computer is still the device_* tools (you drive each step from the cloud; nothing needs to be installed). Use device_agent_run instead when the person asks for a specific local agent (「用 Claude Code 在我电脑上修这个 bug」「让 Codex 跑一下测试」) or for a longer self-contained coding job on their machine. It returns at once with a task card in chat (live output, stop button, diff); the result comes back later as a message starting with 「⟦chisabot:local-agent-result:」, then summarise it in one or two sentences and mention 应用改动 when the changes are in a disposable copy.",
      "Starting a task shows the person an approval prompt (unless the computer has 完全访问 switched on) — say in one short line they will see it; never ask for permission in chat first. You cannot change a computer's permission profile (只读 / 工作区) or switch on 完全访问, or change its folders: only the person can, in 设置 → 设备 → the computer. A task can ask for a narrower profile than the computer's, never a wider one. Give the agent a clear, complete instruction (it does not see this chat).",
      ...lines,
    ].join("\n");
  }

  async function tools(input: { ownerUserId: string; botId: string; botName: string | null; threadId: string }): Promise<GrantedTool[]> {
    const devices = (await deviceStore.forOwner(input.ownerUserId)).filter((d) => !isMobilePlatform(d.platform) && !d.revoked);
    const online = devices.filter((d) => hub.isOnline(d.id));
    if (!online.length) return [];
    const withSettings = await Promise.all(online.map(async (device) => ({ device, settings: await settingsFor(device.id) })));
    const guidance = guidanceText(withSettings);
    const refuse = (error: unknown) => `${REFUSAL_MARKER} ${error instanceof Error ? error.message : String(error)}`;
    const runSchema = z.object({
      deviceId: z.string().min(1).optional().describe("目标电脑：设备 id 或名称。只有一台在线时可以省略。"),
      agent: z.enum(LOCAL_AGENT_KINDS).optional().describe("builtin = ChisaBot 内置；claude = Claude Code；codex = Codex CLI；opencode / gemini / aider。省略 = 这台电脑的默认 agent。"),
      task: z.string().min(1).max(20_000).describe("交给本地 agent 的完整指令（它看不到这段聊天，要写清楚目标、文件、验收方法）"),
      title: z.string().max(60).optional().describe("卡片标题，十来个字"),
      cwd: z.string().max(1000).optional().describe("在哪个文件夹做（绝对路径）；省略 = 工作区第一个文件夹"),
      profile: z.enum(AGENT_PROFILES).optional().describe("这次任务的档位，只能比电脑的档位更严（例如只读分析）"),
      isolation: z.enum(ISOLATIONS).optional().describe("worktree / copy = 一次性副本（改动要用户点「应用改动」）；none = 直接改；bwrap / sandbox-exec / docker = 系统级沙盒。省略 = 电脑的默认设置"),
      network: z.boolean().optional().describe("false = 这次任务断网（只在电脑允许时有效）"),
    });
    return [
      {
        name: "device_agent_list",
        ref: "local-agents/list",
        description: "列出用户在线电脑上的本地 agent（已安装的 Claude Code / Codex / OpenCode… 和 ChisaBot 内置）、权限档位、可用的沙盒和工作区文件夹。",
        parameters: z.object({}),
        guidance,
        execute: async () => {
          const fresh = await Promise.all(
            online.map(async (device) => {
              const settings = await settingsFor(device.id);
              return {
                deviceId: device.id,
                name: device.name,
                profile: effectiveProfile(settings, device),
                profileLabel: PROFILE_INFO[effectiveProfile(settings, device)].label,
                workspaceRoots: effectiveRoots(settings, device.allowedRoots),
                defaultIsolation: settings.isolation,
                network: settings.network,
                defaultAgent: settings.defaultAgent,
                agents: (settings.detected?.agents ?? [{ kind: "builtin", version: null, path: null }]).map((a) => ({ agent: a.kind, label: LOCAL_AGENT_INFO[a.kind]?.label, version: a.version })),
                sandboxes: Object.entries(settings.detected?.sandboxes ?? {}).filter(([, v]) => v).map(([k]) => k),
                shellCapability: device.capabilities.shell,
              };
            }),
          );
          return JSON.stringify({ devices: fresh });
        },
      },
      {
        name: "device_agent_run",
        ref: "local-agents/run",
        description: "把一件事交给用户电脑上的本地 agent（Claude Code、Codex、ChisaBot 内置…）去做，立刻返回并在聊天里显示任务卡片（实时输出、停止、改动）。结果之后作为一条消息回到这里。",
        parameters: runSchema,
        execute: async (raw) => {
          try {
            const args = runSchema.parse(raw);
            const task = await start({ ownerUserId: input.ownerUserId, botId: input.botId, botName: input.botName, threadId: input.threadId, device: args.deviceId, agent: args.agent, task: args.task, title: args.title, cwd: args.cwd, profile: args.profile, isolation: args.isolation, network: args.network });
            return JSON.stringify({
              taskId: task.id,
              status: task.status,
              device: task.deviceName,
              agent: LOCAL_AGENT_INFO[task.agent].label,
              profile: profileLine(task),
              cwd: task.cwd,
              note: task.status === "pending_approval" ? "已在网页 / 手机 / 电脑上弹出审批，用户批准后开始。结果会作为一条消息回到这里，现在不用等。" : "已经开始，结果会作为一条消息回到这里，现在不用等。",
            });
          } catch (error) {
            return refuse(error);
          }
        },
      },
      {
        name: "device_agent_status",
        ref: "local-agents/status",
        description: "看本地 agent 任务的状态和最近的输出（不给 taskId = 这段对话里最近的任务）。",
        parameters: z.object({ taskId: z.string().optional() }),
        execute: async (raw) => {
          try {
            const { taskId } = z.object({ taskId: z.string().optional() }).parse(raw);
            const list = taskId ? [view(await owned(input.ownerUserId, taskId))] : (await forThread(input.ownerUserId, input.threadId)).slice(-3);
            return JSON.stringify(list.map((t) => ({ taskId: t.id, title: t.title, status: t.status, step: t.step, recent: t.lines.slice(-8).map((l) => l.text), diff: t.diff ? { files: t.diff.files.length, added: t.diff.added, removed: t.diff.removed, pending: t.diff.pending } : null, error: t.error })));
          } catch (error) {
            return refuse(error);
          }
        },
      },
      {
        name: "device_agent_stop",
        ref: "local-agents/stop",
        description: "停止一个本地 agent 任务。",
        parameters: z.object({ taskId: z.string().min(1) }),
        execute: async (raw) => {
          try {
            const { taskId } = z.object({ taskId: z.string().min(1) }).parse(raw);
            const task = await stop(input.ownerUserId, taskId, "bot");
            return JSON.stringify({ taskId: task.id, status: task.status });
          } catch (error) {
            return refuse(error);
          }
        },
      },
    ];
  }

  // ── 接口 ──────────────────────────────────────────────────────────────

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser, bodyLimit({ maxSize: 32_768 }));
    app.onError((error, c) => {
      if (error instanceof LocalAgentError) return c.json({ error: error.message }, error.status);
      if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? "参数不对。" }, 400);
      console.error(JSON.stringify({ type: "local-agents-error", error: error.name, message: reasonWithoutStatement(error).slice(0, 200), route: c.req.path }));
      return c.json({ error: "本地 agent 暂时不可用，请重试。" }, 503);
    });
    const ownDevice = async (actorId: string, deviceId: string) => {
      const device = await deviceStore.get(deviceId);
      if (!device || device.ownerUserId !== actorId) throw new LocalAgentError("没有这台设备。", 404);
      return device;
    };
    app.get("/devices/:id", async (c) => {
      const device = await ownDevice(c.var.actor.id, c.req.param("id"));
      const settings = await settingsFor(device.id);
      return c.json({ settings, effectiveRoots: effectiveRoots(settings, device.allowedRoots), online: hub.isOnline(device.id), tasks: await forDevice(c.var.actor.id, device.id) });
    });
    app.put("/devices/:id", async (c) => {
      const patch = settingsPatch.parse(await c.req.json());
      const settings = await saveSettings(c.var.actor.id, c.req.param("id"), patch);
      return c.json({ settings });
    });
    app.post("/devices/:id/detect", async (c) => {
      const device = await ownDevice(c.var.actor.id, c.req.param("id"));
      return c.json({ sent: hub.sendRaw(device.id, { type: "agent_detect" }) });
    });
    app.get("/threads/:threadId/tasks", async (c) => c.json({ tasks: await forThread(c.var.actor.id, c.req.param("threadId")) }));
    app.get("/tasks/:id", async (c) => c.json({ task: view(await owned(c.var.actor.id, c.req.param("id")), true) }));
    app.post("/tasks/:id/stop", async (c) => c.json({ task: await stop(c.var.actor.id, c.req.param("id")) }));
    app.post("/tasks/:id/apply", async (c) => c.json({ task: await applyChanges(c.var.actor.id, c.req.param("id"), false) }));
    app.post("/tasks/:id/discard", async (c) => c.json({ task: await applyChanges(c.var.actor.id, c.req.param("id"), true) }));
    return app;
  }

  return { ensure, recover, extension, settingsFor, saveSettings, start, stop, applyChanges, forThread, forDevice, forgetDevice, tools, routes, handleNodeMessage };
}
