import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  AGENT_DRIVER_KINDS,
  AGENT_DRIVER_SPECS,
  AGENT_PROVIDER_PRESETS,
  type AgentDriverConfig,
  type AgentDriverKind,
  type AgentEnvironmentSummary,
  type AgentInstanceView,
  type AgentProbeState,
  agentToolName,
  BOT_AGENT_GRANT_MODES,
  isAgentDriverKind,
  type RuntimeInstanceSpec,
  SERVER_ENVIRONMENT_ID,
} from "../../../shared/agent-providers";
import {
  type DeviceOperation,
  isMobilePlatform,
} from "../../../shared/devices";
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
  type LlmContentPart,
  type LlmMessage,
  LOCAL_AGENT_INFO,
  LOCAL_AGENT_KINDS,
  LOCAL_AGENT_MESSAGE_TYPES,
  LOCAL_AGENT_RESULT_MARKER,
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
import {
  connectionLanguageModel,
  type RuntimeModelConnection,
} from "../conversation-runtime";
import {
  BACKGROUND_CAPACITY,
  backgroundCount,
  executionDeadline,
  lockBackgroundAccount,
  reportCapacityState,
} from "../conversations/capacity";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import type { DeviceHub } from "../devices/hub";
import {
  type DeviceRecord,
  type DeviceStore,
  fullAccessActive,
} from "../devices/store";
import { resolveDevice } from "../devices/tools";
import type { LocalRunControl } from "../local-conversations";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import type { ThreadInbox } from "../thread-inbox";
import type { TurnRunner } from "../turns/types";
import { listAcpRegistryEntries } from "./acp-registry";
import { createAgentInstancesStore, type InstanceRow } from "./instances-store";
import {
  buildServerDeviceRecord,
  createServerAgentHost,
  parseEnvServerRoots,
} from "./server-host";

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

const TASK_TIMEOUT_MS =
  Number(process.env.CHISABOT_LOCAL_AGENT_TIMEOUT_MS) || 45 * 60_000;
const PER_DEVICE_ACTIVE = 2;
const PER_USER_ACTIVE = 4;
const STORED_LINES = 1500;
const CARD_LINES = 40;
const LLM_CALLS_PER_TASK =
  Number(process.env.CHISABOT_LOCAL_AGENT_LLM_CALLS) || 80;
const RESULT_LIMIT = 6000;

/** 内置 agent 的工具（和 pc/src/agent-runtime/builtin.js 的 TOOLS 一致；工具在电脑上执行，这里只给模型看定义）。 */
export const BUILTIN_TOOLS: Array<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}> = [
  {
    name: "list_files",
    description: "列出目录（相对工作目录，默认工作目录本身）。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "读取文本文件。offset/limit 按行（从 1 开始），默认读前 400 行。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "新建或整个覆盖一个文件。",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "把文件里的 old_string 换成 new_string（old_string 必须唯一，除非 replace_all）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      "在工作目录里按正则搜索文件内容（跳过 .git、node_modules），最多 200 条。glob 例如 *.ts。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        glob: { type: "string" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "run",
    description:
      "在工作目录里运行一条命令（Windows 是 PowerShell，其它是 sh），默认 120 秒超时。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_sec: { type: "integer" },
      },
      required: ["command"],
      additionalProperties: false,
    },
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
  instance_id?: string | null;
  instance_name?: string | null;
  environment_id?: string | null;
  parent_task_id?: string | null;
  depth?: number;
  invocation_mode?: string | null;
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
  capacity_active: boolean;
};

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

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
  encryptionKey?: string;
  /** 是否启用服务端本机智能体宿主（environmentId = "server"）。 */
  enableServerHost?: boolean;
  inbox?: ThreadInbox;
  control?: LocalRunControl;
  deliverTurn?: TurnRunner;
  agentOfThread?: (threadId: string) => Promise<string | null>;
  resolveConnectionForAgent?: (
    agentId: string,
  ) => Promise<RuntimeModelConnection>;
  /** 测试用：替换模型调用。 */
  generate?: (input: {
    agentId: string;
    system: string;
    messages: LlmMessage[];
    signal: AbortSignal;
  }) => Promise<LlmContentPart[]>;
  timeoutMs?: number;
};

export type LocalAgentService = ReturnType<typeof createLocalAgentService>;

export function createLocalAgentService(options: LocalAgentServiceOptions) {
  const { database, hub, deviceStore } = options;
  const sql = database.$client;
  const settingsCache = new Map<string, DeviceAgentSettings>();
  type Live = {
    lines: LocalAgentLine[];
    count: number;
    step: string | null;
    flush?: ReturnType<typeof setTimeout>;
    approvalId: string | null;
    approvalSummary: string | null;
    timer?: ReturnType<typeof setTimeout>;
    deadline?: ReturnType<typeof executionDeadline>;
    dispatching?: boolean;
  };
  const live = new Map<string, Live>();
  const modelCalls = new Map<
    string,
    { controller: AbortController; done: Promise<unknown> }
  >();
  const probePending = new Map<
    string,
    (probe: Omit<AgentProbeState, "checkedAt">) => void
  >();
  const waiters = new Map<string, Set<(row: TaskRow) => void>>();
  const deliveredInline = new Set<string>();
  const timeoutMs = options.timeoutMs ?? TASK_TIMEOUT_MS;

  const serverHost = options.enableServerHost
    ? createServerAgentHost({
        onMessage: (message) => {
          void (async () => {
            if (
              message.type === "agents_detected" ||
              message.type === "agent_probe_result"
            ) {
              await handleNodeMessage(
                buildServerDeviceRecord("system", parseEnvServerRoots()),
                message,
              );
              return;
            }
            const taskId = String(message.taskId ?? "");
            const row = taskId ? await taskRow(taskId) : null;
            const sSettings = await settingsFor(SERVER_ENVIRONMENT_ID);
            const roots = serverAllowedRoots(sSettings);
            await handleNodeMessage(
              buildServerDeviceRecord(row?.owner_user_id ?? "system", roots),
              message,
            );
          })().catch((err) => {
            console.warn(
              "server host message error",
              reasonWithoutStatement(err),
            );
          });
        },
      })
    : null;

  function serverAllowedRoots(settings: DeviceAgentSettings): string[] {
    return [...new Set([...parseEnvServerRoots(), ...settings.workspaceRoots])];
  }

  function isEnvironmentOnline(environmentId: string): boolean {
    if (environmentId === SERVER_ENVIRONMENT_ID) return Boolean(serverHost);
    return hub.isOnline(environmentId);
  }

  function sendToEnvironment(
    environmentId: string,
    message: { type: string } & Record<string, unknown>,
  ): boolean {
    if (environmentId === SERVER_ENVIRONMENT_ID) {
      return serverHost ? serverHost.sendRaw(message) : false;
    }
    return hub.sendRaw(environmentId, message);
  }

  async function resolveTargetDevice(
    ownerUserId: string,
    environmentId: string,
  ): Promise<DeviceRecord | null> {
    if (environmentId === SERVER_ENVIRONMENT_ID) {
      if (!serverHost) return null;
      const sSettings = await settingsFor(SERVER_ENVIRONMENT_ID);
      return buildServerDeviceRecord(
        ownerUserId,
        serverAllowedRoots(sSettings),
      );
    }
    const dev = await deviceStore.get(environmentId);
    if (!dev || dev.ownerUserId !== ownerUserId || dev.revoked) return null;
    return dev;
  }

  const instancesStore = createAgentInstancesStore({
    database,
    encryptionKey: options.encryptionKey,
    resolveEnvMeta: async (ownerUserId, environmentId) => {
      if (environmentId === SERVER_ENVIRONMENT_ID) {
        return { name: "服务器本机", online: Boolean(serverHost) };
      }
      const dev = await deviceStore.get(environmentId);
      if (!dev || dev.ownerUserId !== ownerUserId || dev.revoked) {
        return { name: environmentId, online: false };
      }
      return { name: dev.name, online: hub.isOnline(dev.id) };
    },
  });

  function notifyTaskWaiters(row: TaskRow) {
    const set = waiters.get(row.id);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        fn(row);
      } catch {}
    }
  }

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
    await sql.unsafe(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='chisabot_local_agent_tasks'::regclass AND attname='capacity_active' AND NOT attisdropped) THEN
        ALTER TABLE chisabot_local_agent_tasks ADD COLUMN capacity_active boolean NOT NULL DEFAULT false;
        UPDATE chisabot_local_agent_tasks SET capacity_active=true WHERE status IN ('starting','running');
      END IF;
    END $$`);
    await sql.unsafe(`
      ALTER TABLE chisabot_local_agent_tasks ADD COLUMN IF NOT EXISTS instance_id text;
      ALTER TABLE chisabot_local_agent_tasks ADD COLUMN IF NOT EXISTS instance_name text;
      ALTER TABLE chisabot_local_agent_tasks ADD COLUMN IF NOT EXISTS environment_id text;
      ALTER TABLE chisabot_local_agent_tasks ADD COLUMN IF NOT EXISTS parent_task_id text;
      ALTER TABLE chisabot_local_agent_tasks ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;
      ALTER TABLE chisabot_local_agent_tasks ADD COLUMN IF NOT EXISTS invocation_mode text;
    `);
    await instancesStore.ensure();
    if (serverHost) {
      void serverHost.detect().catch((err) => {
        console.warn(
          "server host initial detect failed",
          reasonWithoutStatement(err),
        );
      });
    }
  }

  /** Never resend an already dispatched task. Its device receipt releases uncertain occupancy. */
  async function recover(): Promise<number> {
    const rows = await sql.unsafe<{ id: string }[]>(
      `UPDATE chisabot_local_agent_tasks SET status = 'failed', error = CASE WHEN capacity_active
         THEN '服务重启，已请求停止原设备任务；设备确认前保留执行位，请先核对设备结果。'
         ELSE '服务重启，原审批已失效，任务没有继续。' END, finished_at = now(), updated_at = now()
       WHERE status IN ('pending_approval','running') OR (status='starting' AND capacity_active) RETURNING id`,
    );
    for (const row of await sql.unsafe<TaskRow[]>(
      "SELECT * FROM chisabot_local_agent_tasks WHERE capacity_active AND status='failed'",
    ))
      sendToEnvironment(row.device_id, { type: "agent_stop", taskId: row.id });
    for (const row of await sql.unsafe<TaskRow[]>(
      "SELECT * FROM chisabot_local_agent_tasks WHERE status='starting' AND NOT capacity_active",
    )) {
      void dispatchQueued(row).catch((error) =>
        console.warn(
          "local agent capacity recovery pending",
          reasonWithoutStatement(error),
        ),
      );
    }
    return rows.length;
  }

  // ── 设置 ──────────────────────────────────────────────────────────────

  function fromRow(
    deviceId: string,
    row: SettingsRow | undefined,
  ): DeviceAgentSettings {
    const base = defaultAgentSettings(deviceId);
    if (!row) return base;
    return {
      deviceId,
      profile: (AGENT_PROFILES as readonly string[]).includes(row.profile)
        ? (row.profile as AgentProfile)
        : base.profile,
      workspaceRoots: Array.isArray(row.workspace_roots)
        ? row.workspace_roots.filter((r) => typeof r === "string")
        : [],
      network: row.network !== false,
      isolation: (ISOLATIONS as readonly string[]).includes(row.isolation)
        ? (row.isolation as Isolation)
        : base.isolation,
      defaultAgent: (LOCAL_AGENT_KINDS as readonly string[]).includes(
        row.default_agent,
      )
        ? (row.default_agent as LocalAgentKind)
        : base.defaultAgent,
      builtinModel:
        row.builtin_model &&
        (row.builtin_model.kind === "server" ||
          row.builtin_model.kind === "local")
          ? row.builtin_model
          : base.builtinModel,
      containerImage: row.container_image || DEFAULT_CONTAINER_IMAGE,
      detected: row.detected ?? null,
      saved: true,
      updatedAt: iso(row.updated_at),
    };
  }

  async function settingsFor(deviceId: string): Promise<DeviceAgentSettings> {
    const cached = settingsCache.get(deviceId);
    if (cached) return cached;
    const rows = await sql.unsafe<SettingsRow[]>(
      "SELECT * FROM chisabot_device_agent_settings WHERE device_id = $1",
      [deviceId],
    );
    const settings = fromRow(deviceId, rows[0]);
    settingsCache.set(deviceId, settings);
    return settings;
  }

  async function writeSettings(
    device: DeviceRecord,
    settings: DeviceAgentSettings,
  ) {
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
        .union([
          z.object({ kind: z.literal("server") }),
          z.object({
            kind: z.literal("local"),
            baseUrl: z.string().url().max(500),
            model: z.string().min(1).max(200),
          }),
        ])
        .optional(),
      containerImage: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[\w./:@-]+$/u, "镜像名只能有字母、数字和 ./:@-")
        .optional(),
    })
    .strict();

  /** 只有用户自己（网页 / 手机 / PC 里的网页）能改档位；机器人没有改档位的工具。 */
  async function saveSettings(
    actorId: string,
    deviceId: string,
    patch: z.infer<typeof settingsPatch>,
  ) {
    let device: DeviceRecord;
    if (deviceId === SERVER_ENVIRONMENT_ID) {
      if (!serverHost)
        throw new LocalAgentError("当前部署未启用服务器本机智能体宿主。", 400);
      device = buildServerDeviceRecord("system", parseEnvServerRoots());
    } else {
      const found = await deviceStore.get(deviceId);
      if (!found || found.ownerUserId !== actorId)
        throw new LocalAgentError("没有这台设备。", 404);
      if (isMobilePlatform(found.platform))
        throw new LocalAgentError("手机不能运行本地 agent。", 400);
      device = found;
    }
    if (patch.profile === "full")
      throw new LocalAgentError(
        "「完全访问」在 设置 → 设备 → 权限 里打开（有时限，到期自动回到这里选的档位）。",
        400,
      );
    const before = await settingsFor(deviceId);
    const next: DeviceAgentSettings = {
      ...before,
      ...patch,
      saved: true,
    } as DeviceAgentSettings;
    await writeSettings(device, next);
    const changes: string[] = [];
    if (before.profile !== next.profile)
      changes.push(
        `档位：${PROFILE_INFO[before.profile].label} → ${PROFILE_INFO[next.profile].label}`,
      );
    if (before.isolation !== next.isolation)
      changes.push(`隔离：${ISOLATION_INFO[next.isolation].label}`);
    if (before.network !== next.network)
      changes.push(next.network ? "本地 agent 可以联网" : "本地 agent 断网");
    if (before.defaultAgent !== next.defaultAgent)
      changes.push(`默认 agent：${LOCAL_AGENT_INFO[next.defaultAgent].label}`);
    if (before.workspaceRoots.join("|") !== next.workspaceRoots.join("|"))
      changes.push(
        `工作区文件夹：${next.workspaceRoots.length || "沿用允许的文件夹"}`,
      );
    if (
      JSON.stringify(before.builtinModel) !== JSON.stringify(next.builtinModel)
    )
      changes.push(
        `内置 agent 模型：${next.builtinModel.kind === "server" ? "服务器" : `本地 ${next.builtinModel.model}`}`,
      );
    if (changes.length)
      await deviceStore
        .audit({
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
        })
        .catch(() => {});
    return settingsFor(deviceId);
  }

  /**
   * 实际生效的档位：设备的「完全访问」（ADR-0009，有时限，只能在 设置 → 设备 → 权限 打开）开着时是完全访问，
   * 否则是这里存的 只读 / 工作区（存的 full 是旧数据，按工作区算）。
   */
  function effectiveProfile(
    settings: DeviceAgentSettings,
    record: DeviceRecord,
  ): AgentProfile {
    if (fullAccessActive(record)) return "full";
    return settings.profile === "full" ? "workspace" : settings.profile;
  }

  // ── 设备 hub 扩展 ─────────────────────────────────────────────────────

  const extension = {
    async onHello(record: DeviceRecord) {
      if (!isMobilePlatform(record.platform))
        hub.sendRaw(record.id, { type: "agent_detect" });
      for (const row of await sql.unsafe<{ id: string }[]>(
        "SELECT id FROM chisabot_local_agent_tasks WHERE device_id=$1 AND capacity_active AND status IN ('failed','cancelled')",
        [record.id],
      ))
        hub.sendRaw(record.id, { type: "agent_stop", taskId: row.id });
    },
    async gate(
      record: DeviceRecord,
      operation: DeviceOperation,
      args: Record<string, unknown>,
    ) {
      const settings = await settingsFor(record.id);
      const profile = effectiveProfile(settings, record);
      const verdict = profileAllows(
        profile,
        operation,
        args,
        effectiveRoots(settings, record.allowedRoots),
        record.platform,
      );
      return verdict.inside
        ? null
        : `${verdict.reason ?? "档位之外"}，档位「${PROFILE_INFO[profile].label}」`;
    },
    async onMessage(
      record: DeviceRecord,
      message: { type: string } & Record<string, unknown>,
    ) {
      if (!LOCAL_AGENT_MESSAGE_TYPES.has(message.type)) return;
      await handleNodeMessage(record, message);
    },
  };

  // ── 任务 ──────────────────────────────────────────────────────────────

  /** A task this service just wrote or claimed; its row going missing is a broken invariant. */
  async function savedTaskRow(id: string) {
    const row = await taskRow(id);
    if (!row) throw new Error("本机任务记录已不存在。");
    return row;
  }
  async function taskRow(id: string) {
    return (
      (
        await sql.unsafe<TaskRow[]>(
          "SELECT * FROM chisabot_local_agent_tasks WHERE id = $1",
          [id],
        )
      )[0] ?? null
    );
  }

  function view(
    row: TaskRow,
    full = false,
  ): LocalAgentTaskView & { task?: string; transcript?: LocalAgentLine[] } {
    const state = live.get(row.id);
    const lines = state ? state.lines : (row.transcript ?? []);
    return {
      id: row.id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      environmentId: row.environment_id ?? row.device_id,
      instanceId: row.instance_id ?? null,
      instanceName: row.instance_name ?? null,
      parentTaskId: row.parent_task_id ?? null,
      depth: Number(row.depth ?? 0),
      invocationMode:
        row.invocation_mode === "wait" ||
        row.invocation_mode === "async" ||
        row.invocation_mode === "direct"
          ? row.invocation_mode
          : undefined,
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
      diff: row.diff
        ? {
            ...row.diff,
            patch: full
              ? row.diff.patch
              : row.diff.patch
                ? clip(row.diff.patch, 6000)
                : undefined,
          }
        : null,
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
      state = {
        lines: [],
        count: 0,
        step: null,
        approvalId: null,
        approvalSummary: null,
      };
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
        .unsafe(
          "UPDATE chisabot_local_agent_tasks SET transcript = $2::text::jsonb, line_count = $3, step = $4, updated_at = now() WHERE id = $1",
          [
            id,
            JSON.stringify(state.lines.slice(-STORED_LINES)),
            state.count,
            state.step,
          ],
        )
        .catch(() => {});
    }, 700);
    state.flush.unref?.();
  }

  function pushLine(
    id: string,
    kind: LocalAgentLine["kind"],
    text: string,
    step?: string | null,
  ) {
    const state = liveOf(id);
    state.lines.push({
      at: new Date().toISOString(),
      kind,
      text: clip(String(text), 2000),
    });
    if (state.lines.length > STORED_LINES)
      state.lines.splice(0, state.lines.length - STORED_LINES);
    state.count++;
    if (step) state.step = clip(step, 200);
    scheduleFlush(id);
  }

  async function setStatus(
    id: string,
    status: LocalAgentTaskStatus,
    extra: Record<string, unknown> = {},
  ) {
    const sets = ["status = $2", "updated_at = now()"];
    const params: unknown[] = [id, status];
    for (const [key, value] of Object.entries(extra)) {
      params.push(value);
      sets.push(
        `${key} = $${params.length}${key === "diff" ? "::text::jsonb" : ""}`,
      );
    }
    await sql.unsafe(
      `UPDATE chisabot_local_agent_tasks SET ${sets.join(", ")} WHERE id = $1`,
      params as never[],
    );
  }

  async function finish(
    id: string,
    status: "done" | "failed" | "cancelled",
    fields: {
      summary?: string | null;
      error?: string | null;
      diff?: LocalAgentDiff | null;
      deviceConfirmed?: boolean;
      requestDeviceStop?: string;
    },
  ) {
    const model = modelCalls.get(id);
    model?.controller.abort(new Error("本地 agent 任务已停止。"));
    const state = live.get(id);
    if (state?.flush) clearTimeout(state.flush);
    if (state?.timer) clearTimeout(state.timer);
    state?.deadline?.cancel();
    const rows = await sql.unsafe<TaskRow[]>(
      `UPDATE chisabot_local_agent_tasks SET status = $2, summary = $3, error = $4, diff = coalesce($5::text::jsonb, diff), finished_at = now(), updated_at = now(),
         transcript = coalesce($6::text::jsonb, transcript), line_count = coalesce($7, line_count), step = NULL,
         capacity_active = CASE WHEN $8 THEN false ELSE capacity_active END
       WHERE id = $1 AND status IN ('pending_approval','starting','running') RETURNING *`,
      [
        id,
        status,
        fields.summary ?? null,
        fields.error ?? null,
        fields.diff ? JSON.stringify(fields.diff) : null,
        state ? JSON.stringify(state.lines.slice(-STORED_LINES)) : null,
        state ? state.count : null,
        fields.deviceConfirmed === true && !model,
      ],
    );
    // Order Stop after the durable transition, serialized with dispatch's final row lock.
    // Otherwise an unknown-task Stop can overtake the first agent_run and be lost by old nodes.
    if (fields.requestDeviceStop)
      sendToEnvironment(fields.requestDeviceStop, {
        type: "agent_stop",
        taskId: id,
      });
    live.delete(id);
    const row = rows[0] ?? null;
    if (fields.deviceConfirmed && (model || !row)) {
      if (model) await model.done.catch(() => {});
      await sql.unsafe(
        "UPDATE chisabot_local_agent_tasks SET capacity_active=false WHERE id=$1 AND status IN ('done','failed','cancelled')",
        [id],
      );
    }
    if (row) {
      notifyTaskWaiters(row);
      const label =
        row.instance_name ||
        LOCAL_AGENT_INFO[row.agent as LocalAgentKind]?.label ||
        row.agent;
      await deviceStore
        .audit({
          deviceId: row.device_id,
          ownerUserId: row.owner_user_id,
          actorType: "bot",
          actorId: row.agent_id,
          actorName: row.bot_name,
          action: "local_agent_done",
          summary: clip(
            `${label}：${row.title}${row.diff?.files.length ? `（${row.diff.files.length} 个文件 +${row.diff.added} −${row.diff.removed}）` : ""}`,
            400,
          ),
          outcome:
            status === "done"
              ? "succeeded"
              : status === "cancelled"
                ? "cancelled"
                : "failed",
          detail: row.error,
          durationMs: row.started_at
            ? Date.now() - new Date(row.started_at).getTime()
            : null,
        })
        .catch(() => {});
      if (!deliveredInline.has(id) && !row.parent_task_id) {
        await deliver(row).catch((error) =>
          console.warn("local agent delivery failed", error),
        );
      }
      deliveredInline.delete(id);
    }
    return row;
  }

  function diffLine(diff: LocalAgentDiff | null | undefined) {
    if (!diff || !diff.files.length) return "没有改动文件。";
    const names = diff.files
      .slice(0, 8)
      .map((f) => f.path)
      .join("、");
    return `改动：${diff.files.length} 个文件（+${diff.added} −${diff.removed}）：${names}${diff.files.length > 8 ? " 等" : ""}。${
      diff.pending
        ? "改动在一次性副本里，还没回到原文件夹——用户可以在任务卡片上点「应用改动」或「放弃」。"
        : ""
    }`;
  }

  /** 结果回到原对话（同后台任务 §38.2）。 */
  async function deliver(row: TaskRow) {
    if (
      !row.thread_id ||
      !options.inbox ||
      !options.control ||
      !options.deliverTurn
    )
      return;
    const messageId = `local-agent-result-${row.id}`;
    const agentLabel =
      row.instance_name ||
      LOCAL_AGENT_INFO[row.agent as LocalAgentKind]?.label ||
      row.agent;
    const statusZh =
      row.status === "done"
        ? "已完成"
        : row.status === "cancelled"
          ? "已停止"
          : "没有完成";
    const body =
      row.status === "done"
        ? row.summary || "（没有文字结果）"
        : [row.error, row.summary].filter(Boolean).join("\n\n") ||
          "（没有说明原因）";
    const content = `${LOCAL_AGENT_RESULT_MARKER}${row.id}:${row.status}⟧\n本地 agent「${agentLabel}」在「${row.device_name}」上${statusZh}：${row.title}\n\n${clip(body, RESULT_LIMIT)}\n\n${diffLine(row.diff)}`;
    const message = { id: messageId, role: "user", content } as Message;
    await sql.unsafe(
      "UPDATE chisabot_local_agent_tasks SET result_message_id = $2 WHERE id = $1",
      [row.id, messageId],
    );
    const enqueue = () =>
      options.inbox!.enqueue({
        threadId: row.thread_id!,
        ownerUserId: row.owner_user_id,
        message,
        kind: "worker_result",
      });
    if (options.control.isActive(row.thread_id)) {
      await enqueue();
      if (options.control.isActive(row.thread_id)) return;
    }
    const agentId =
      (await options.agentOfThread?.(row.thread_id)) ?? row.agent_id;
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
        forwardedProps: {
          chisabotWorkerDelivery: { id: row.id },
          chisabotLocalAgentDelivery: { id: row.id },
        },
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "local-agent-delivery-queued",
          task: row.id,
          reason: reasonWithoutStatement(error),
        }),
      );
      await sql
        .unsafe(
          "UPDATE chisabot_thread_inbox SET status = 'queued', updated_at = now() WHERE thread_id = $1 AND id = $2",
          [row.thread_id, messageId],
        )
        .catch(() => {});
      await enqueue().catch(() => {});
    }
  }

  async function generate(
    row: TaskRow,
    system: string,
    messages: LlmMessage[],
    signal: AbortSignal,
  ): Promise<LlmContentPart[]> {
    if (options.generate)
      return options.generate({
        agentId: row.agent_id,
        system,
        messages,
        signal,
      });
    if (!options.resolveConnectionForAgent)
      throw new Error("服务器没有配置模型。");
    const connection = await options.resolveConnectionForAgent(row.agent_id);
    const model = connectionLanguageModel(connection.model, connection.apiKey);
    const prompt: unknown[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user")
        prompt.push({
          role: "user",
          content: [{ type: "text", text: String(m.text ?? "") }],
        });
      else if (m.role === "assistant")
        prompt.push({
          role: "assistant",
          content: (m.content ?? []).map((part) => {
            if (part.type === "text") return { type: "text", text: part.text };
            let input: unknown = {};
            try {
              input = JSON.parse(part.input || "{}");
            } catch {}
            return {
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input,
            };
          }),
        });
      else if (m.role === "tool")
        prompt.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: m.toolCallId,
              toolName: m.toolName,
              output: { type: "text", value: String(m.output ?? "") },
            },
          ],
        });
    }
    const result = await model.doGenerate({
      prompt,
      tools: BUILTIN_TOOLS.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
      maxOutputTokens: 8192,
      abortSignal: signal,
    } as never);
    const parts: LlmContentPart[] = [];
    for (const part of result.content as Array<{
      type: string;
      text?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
    }>) {
      if (part.type === "text" && part.text)
        parts.push({ type: "text", text: part.text });
      else if (part.type === "tool-call")
        parts.push({
          type: "tool-call",
          toolCallId: String(part.toolCallId),
          toolName: String(part.toolName),
          input:
            typeof part.input === "string"
              ? part.input
              : JSON.stringify(part.input ?? {}),
        });
    }
    return parts;
  }

  async function ensureServerSeedsForOwner(ownerUserId: string) {
    if (!serverHost) return;
    const existing = await instancesStore.listRows(
      ownerUserId,
      SERVER_ENVIRONMENT_ID,
    );
    if (existing.length > 0) return;
    const sSettings = await settingsFor(SERVER_ENVIRONMENT_ID);
    if (sSettings.detected?.agents?.length) {
      await instancesStore.syncDetectedAgents(
        ownerUserId,
        SERVER_ENVIRONMENT_ID,
        sSettings.detected.agents,
      );
    }
  }

  async function handleNodeMessage(
    record: DeviceRecord,
    message: { type: string } & Record<string, unknown>,
  ) {
    if (message.type === "agent_probe_result") {
      const reqId = String(message.reqId ?? "");
      const pending = probePending.get(reqId);
      if (pending && message.probe && typeof message.probe === "object") {
        probePending.delete(reqId);
        pending(message.probe as Omit<AgentProbeState, "checkedAt">);
      }
      return;
    }
    if (message.type === "agents_detected") {
      const detection = message.detection as
        | Omit<DeviceAgentDetection, "checkedAt">
        | undefined;
      if (!detection || typeof detection !== "object") return;
      const settings = await settingsFor(record.id);
      const clean: DeviceAgentDetection = {
        agents: Array.isArray(detection.agents)
          ? detection.agents
              .filter(
                (a) =>
                  a &&
                  (LOCAL_AGENT_KINDS as readonly string[]).includes(a.kind),
              )
              .map((a) => ({
                kind: a.kind,
                version: a.version ? String(a.version).slice(0, 40) : null,
                path: a.path ? String(a.path).slice(0, 400) : null,
              }))
          : [],
        sandboxes:
          detection.sandboxes && typeof detection.sandboxes === "object"
            ? Object.fromEntries(
                Object.entries(detection.sandboxes).map(([k, v]) => [
                  k.slice(0, 32),
                  v === true,
                ]),
              )
            : {},
        platform:
          typeof detection.platform === "string"
            ? detection.platform
            : record.platform,
        root: detection.root === true,
        checkedAt: new Date().toISOString(),
      };
      // 检测结果不算用户改设置：保持 saved 原值（没保存过的设备只存检测结果、其余仍是默认值）。
      await writeSettings(record, { ...settings, detected: clean });
      if (record.id === SERVER_ENVIRONMENT_ID) {
        const owners = await sql
          .unsafe<{ owner_user_id: string }[]>(
            "SELECT DISTINCT owner_user_id FROM chisabot_agent_instances WHERE environment_id = $1",
            [SERVER_ENVIRONMENT_ID],
          )
          .catch(() => []);
        for (const item of owners) {
          await instancesStore
            .syncDetectedAgents(
              item.owner_user_id,
              SERVER_ENVIRONMENT_ID,
              clean.agents,
            )
            .catch(() => {});
        }
      } else if (record.ownerUserId) {
        await instancesStore
          .syncDetectedAgents(record.ownerUserId, record.id, clean.agents)
          .catch(() => {});
      }
      return;
    }
    const taskId = String(message.taskId ?? "");
    const row = taskId ? await taskRow(taskId) : null;
    // 只认这台设备自己的任务。
    if (!row || row.device_id !== record.id) return;
    const active = ACTIVE_LOCAL_TASK.includes(row.status);
    switch (message.type) {
      case "agent_started":
        if (active && row.capacity_active)
          await setStatus(taskId, "running", {
            started_at: new Date().toISOString(),
          });
        return;
      case "agent_event":
        if (!active || !row.capacity_active) return;
        if (row.status === "starting")
          await setStatus(taskId, "running", {
            started_at: new Date().toISOString(),
          });
        pushLine(
          taskId,
          (["text", "tool", "status", "stderr", "approval"].includes(
            String(message.kind),
          )
            ? message.kind
            : "text") as LocalAgentLine["kind"],
          String(message.text ?? ""),
          typeof message.step === "string" ? message.step : null,
        );
        return;
      case "agent_done": {
        const diff =
          message.diff && typeof message.diff === "object"
            ? sanitizeDiff(message.diff as LocalAgentDiff)
            : null;
        const ok = message.ok === true;
        const stopped = message.stopped === true;
        await finish(taskId, ok ? "done" : stopped ? "cancelled" : "failed", {
          summary:
            typeof message.summary === "string"
              ? clip(message.summary, 8000)
              : null,
          error: ok
            ? null
            : clip(String(message.error ?? "本地 agent 没有完成。"), 1500),
          diff,
          deviceConfirmed: true,
        });
        return;
      }
      case "agent_applied": {
        if (!row.diff) return;
        const next =
          message.ok === true
            ? {
                ...row.diff,
                pending: false,
                applied: !message.discarded,
                discarded: message.discarded === true,
              }
            : row.diff;
        await sql.unsafe(
          "UPDATE chisabot_local_agent_tasks SET diff = $2::text::jsonb, error = CASE WHEN $3::text IS NULL THEN error ELSE $3 END, updated_at = now() WHERE id = $1",
          [
            taskId,
            JSON.stringify(next),
            message.ok === true
              ? null
              : clip(String(message.error ?? "应用改动失败。"), 600),
          ],
        );
        pendingApply.get(taskId)?.(
          message.ok === true
            ? null
            : String(message.error ?? "应用改动失败。"),
        );
        return;
      }
      case "agent_llm": {
        const reqId = String(message.reqId ?? "");
        const reply = (body: Record<string, unknown>) =>
          sendToEnvironment(record.id, {
            type: "agent_llm_result",
            reqId,
            ...body,
          });
        if (!active || !row.capacity_active || row.agent !== "builtin")
          return void reply({
            ok: false,
            error: "任务未在执行，仍在等待批准、执行位或已经结束。",
          });
        if (modelCalls.has(taskId))
          return void reply({
            ok: false,
            error: "这个任务的上一条模型请求尚未结束。",
          });
        if (row.llm_calls >= LLM_CALLS_PER_TASK)
          return void reply({
            ok: false,
            error: `这个任务的模型调用超过 ${LLM_CALLS_PER_TASK} 次上限，已停止。`,
          });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 170_000);
        const messages = Array.isArray(message.messages)
          ? (message.messages as LlmMessage[]).slice(-200)
          : [];
        const system =
          typeof message.system === "string"
            ? clip(message.system, 6000)
            : "你是 ChisaBot 的本地 agent。";
        const done = Promise.resolve().then(async () => {
          await sql.unsafe(
            "UPDATE chisabot_local_agent_tasks SET llm_calls = llm_calls + 1 WHERE id = $1",
            [taskId],
          );
          const current = await taskRow(taskId);
          if (
            !current ||
            !ACTIVE_LOCAL_TASK.includes(current.status) ||
            !current.capacity_active
          )
            throw new Error("任务已经停止，未调用模型。");
          controller.signal.throwIfAborted();
          return generate(row, system, messages, controller.signal);
        });
        modelCalls.set(taskId, { controller, done });
        try {
          const content = await done;
          reply({ ok: true, content });
        } catch (error) {
          reply({ ok: false, error: clip(reasonWithoutStatement(error), 400) });
        } finally {
          clearTimeout(timer);
          if (modelCalls.get(taskId)?.controller === controller)
            modelCalls.delete(taskId);
        }
        return;
      }
      case "agent_approval": {
        const reqId = String(message.reqId ?? "");
        const reply = (approved: boolean) =>
          sendToEnvironment(record.id, {
            type: "agent_approval_result",
            reqId,
            approved,
          });
        if (!active || !row.capacity_active) return void reply(false);
        const fresh =
          (await resolveTargetDevice(row.owner_user_id, record.id)) ?? record;
        if (fresh.paused || fresh.revoked) return void reply(false);
        const summary = clip(
          `本地 agent 任务「${row.title}」：${String(message.summary ?? "")}`,
          400,
        );
        const state = liveOf(taskId);
        // Existing nodes time out approvals locally and can resume planning without a receipt.
        // Keep their original slot until a device terminal confirms they have really stopped.
        const parked = await sql.unsafe<TaskRow[]>(
          "UPDATE chisabot_local_agent_tasks SET status='pending_approval',step='等待你批准（设备仍保留执行位）',updated_at=now() WHERE id=$1 AND capacity_active AND status IN ('starting','running') RETURNING *",
          [taskId],
        );
        if (!parked.length) return void reply(false);
        state.step = "等待你批准（设备仍保留执行位）";
        const decision = await hub.requestUserApproval(
          fresh,
          {
            bot: { id: row.agent_id, name: row.bot_name },
            operation: message.operation === "shell" ? "shell" : "write_file",
            summary,
          },
          (approvalId) => {
            state.approvalId = approvalId;
            state.approvalSummary = summary;
            if (parked[0]) notifyTaskWaiters(parked[0]);
          },
        );
        state.approvalId = null;
        state.approvalSummary = null;
        const current = await resolveTargetDevice(row.owner_user_id, record.id);
        const currentTask = await taskRow(taskId);
        if (
          !current ||
          current.paused ||
          current.revoked ||
          !isEnvironmentOnline(record.id) ||
          !currentTask ||
          !ACTIVE_LOCAL_TASK.includes(currentTask.status)
        ) {
          sendToEnvironment(record.id, { type: "agent_stop", taskId });
          await finish(taskId, "failed", {
            error:
              "等待批准或执行位期间设备不可用或任务已停止，未继续；设备确认前保留执行位。",
          });
          return void reply(false);
        }
        const currentSettings = await settingsFor(record.id);
        if (
          narrowerProfile(
            effectiveProfile(currentSettings, current),
            row.profile as AgentProfile,
          ) !== row.profile ||
          (row.profile !== "full" &&
            !isInsideRoots(
              row.cwd ?? "",
              effectiveRoots(currentSettings, current.allowedRoots),
              current.platform,
            ))
        ) {
          sendToEnvironment(record.id, { type: "agent_stop", taskId });
          await finish(taskId, "failed", {
            error:
              "设备权限或允许目录已更改，已请求停止原任务；设备确认前保留执行位。",
          });
          return void reply(false);
        }
        const resumed = await sql.unsafe(
          "UPDATE chisabot_local_agent_tasks SET status='running',step='正在执行',updated_at=now() WHERE id=$1 AND status='pending_approval' AND capacity_active RETURNING id",
          [taskId],
        );
        if (!resumed.length) return void reply(false);
        state.step = "正在执行";
        pushLine(
          taskId,
          "approval",
          decision.approved
            ? "已批准"
            : decision.by === "expired"
              ? "审批超时，没有执行"
              : "你拒绝了这一步",
        );
        reply(decision.approved);
        return;
      }
      case "agent_subcall": {
        const reqId = String(message.reqId ?? "");
        const action = String(message.action ?? "");
        const params =
          message.params && typeof message.params === "object"
            ? (message.params as Record<string, unknown>)
            : {};
        const reply = (body: Record<string, unknown>) =>
          sendToEnvironment(record.id, {
            type: "agent_subcall_result",
            reqId,
            ...body,
          });
        if (!active || !row.capacity_active) {
          return void reply({ ok: false, error: "父任务未在运行状态。" });
        }
        try {
          await ensureServerSeedsForOwner(row.owner_user_id);
          const { grant, instances } =
            await instancesStore.listGrantedInstances(
              row.owner_user_id,
              row.agent_id,
              { onlineOnly: true },
            );
          const parentDepth = Number(row.depth ?? 0);
          if (!grant.allowNestedSubagents) {
            return void reply({
              ok: false,
              error: "当前机器人未允许外部智能体嵌套调用子代理。",
            });
          }
          if (parentDepth >= grant.maxDepth) {
            return void reply({
              ok: false,
              error: `已达到子代理嵌套上限（maxDepth = ${grant.maxDepth}）。`,
            });
          }
          if (action === "list") {
            return void reply({
              ok: true,
              data: {
                depth: parentDepth,
                maxDepth: grant.maxDepth,
                instances: instances.map((inst) => ({
                  id: inst.id,
                  slug: inst.slug,
                  name: inst.name,
                  driver: inst.driver,
                  environmentId: inst.environmentId,
                  environmentName: inst.environmentName,
                  description: inst.description,
                })),
              },
            });
          }
          if (action === "run") {
            const subTaskText = String(params.task ?? "").trim();
            const subInstance = String(params.instance ?? "").trim();
            if (!subTaskText || !subInstance) {
              return void reply({
                ok: false,
                error: "subagent_run 需要提供 instance 与 task。",
              });
            }
            const subMode = params.mode === "async" ? "async" : "wait";
            const outcome = await runSubagent({
              ownerUserId: row.owner_user_id,
              botId: row.agent_id,
              botName: row.bot_name,
              threadId: row.thread_id,
              instance: subInstance,
              task: subTaskText,
              title:
                typeof params.title === "string" ? params.title : undefined,
              cwd:
                typeof params.cwd === "string" && params.cwd.trim()
                  ? params.cwd.trim()
                  : (row.cwd ?? undefined),
              profile: row.profile as AgentProfile,
              mode: subMode,
              parentTaskId: row.id,
              depth: parentDepth + 1,
            });
            const t = outcome.task;
            return void reply({
              ok: true,
              data: {
                taskId: t.id,
                status: t.status,
                instanceName: t.instanceName,
                device: t.deviceName,
                summary: t.summary,
                diff: t.diff
                  ? {
                      files: t.diff.files.map((f) => f.path),
                      added: t.diff.added,
                      removed: t.diff.removed,
                      pending: t.diff.pending,
                    }
                  : null,
                error: t.error,
                timedOut: outcome.timedOut,
              },
            });
          }
          if (action === "status") {
            const subId = String(params.taskId ?? "").trim();
            if (!subId) {
              return void reply({ ok: false, error: "需要提供 taskId。" });
            }
            const subRow = await owned(row.owner_user_id, subId);
            const t = view(subRow);
            return void reply({
              ok: true,
              data: {
                taskId: t.id,
                status: t.status,
                step: t.step,
                summary: t.summary,
                recent: t.lines.slice(-10).map((l) => l.text),
                error: t.error,
              },
            });
          }
          if (action === "stop") {
            const subId = String(params.taskId ?? "").trim();
            if (!subId) {
              return void reply({ ok: false, error: "需要提供 taskId。" });
            }
            const t = await stop(row.owner_user_id, subId, "bot");
            return void reply({
              ok: true,
              data: { taskId: t.id, status: t.status },
            });
          }
          return void reply({ ok: false, error: `未知嵌套操作：${action}` });
        } catch (error) {
          return void reply({
            ok: false,
            error: reasonWithoutStatement(error),
          });
        }
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
          status:
            f.status === "added" || f.status === "deleted"
              ? f.status
              : ("modified" as const),
        }))
      : [];
    return {
      files,
      added: Number(diff.added) || 0,
      removed: Number(diff.removed) || 0,
      pending: diff.pending === true && files.length > 0,
      applied: false,
      ...(typeof diff.patch === "string" && diff.patch
        ? { patch: clip(diff.patch, 24_000) }
        : {}),
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
    instance?: string;
    parentTaskId?: string | null;
    depth?: number;
    invocationMode?: "wait" | "async" | "direct";
    bypassBotGrant?: boolean;
    task: string;
    title?: string;
    cwd?: string;
    profile?: AgentProfile;
    isolation?: Isolation;
    network?: boolean;
  };

  /** 交一个任务给宿主上的 agent。返回任务（启动在后台继续：审批 → 发给宿主）。被拒绝时抛 LocalAgentError。 */
  async function start(input: StartInput): Promise<LocalAgentTaskView> {
    let instanceRow: InstanceRow | null = null;
    let device: DeviceRecord;
    const depth = Math.max(0, Math.floor(input.depth ?? 0));

    if (input.instance?.trim()) {
      await ensureServerSeedsForOwner(input.ownerUserId);
      instanceRow = await instancesStore.resolveInstanceRow(
        input.ownerUserId,
        input.instance,
        input.device,
      );
      if (!instanceRow) {
        throw new LocalAgentError(
          `找不到智能体实例「${input.instance}」。请在 设置 → 智能体提供方 中添加或检查标识。`,
          404,
        );
      }
      if (!instanceRow.enabled) {
        throw new LocalAgentError(
          `智能体实例「${instanceRow.name}」当前已禁用，请先在 设置 → 智能体提供方 中启用。`,
          400,
        );
      }
      if (!input.bypassBotGrant) {
        const grant = await instancesStore.getBotGrant(
          input.ownerUserId,
          input.botId,
        );
        if (
          grant.mode === "none" ||
          (grant.mode === "selected" &&
            !grant.instanceIds.includes(instanceRow.id))
        ) {
          throw new LocalAgentError(
            `当前机器人未被授权调用子代理「${instanceRow.name}」。可在机器人设置 → 子代理中开启授权。`,
            403,
          );
        }
      }
      const target = await resolveTargetDevice(
        input.ownerUserId,
        instanceRow.environment_id,
      );
      if (!target) {
        throw new LocalAgentError(
          `智能体「${instanceRow.name}」所属的运行环境不可用。`,
          404,
        );
      }
      device = target;
    } else {
      const picked = await resolveDevice(
        deviceStore,
        input.ownerUserId,
        input.device,
        (id) => hub.isOnline(id),
      );
      if (typeof picked === "string") throw new LocalAgentError(picked);
      device = picked;
    }

    if (
      device.id !== SERVER_ENVIRONMENT_ID &&
      isMobilePlatform(device.platform)
    )
      throw new LocalAgentError("手机不能运行本地 agent。");
    if (!isEnvironmentOnline(device.id))
      throw new LocalAgentError(`「${device.name}」现在离线。`);
    if (device.paused)
      throw new LocalAgentError(`「${device.name}」已紧急停止。`);
    if (device.capabilities.shell === "off")
      throw new LocalAgentError(
        `「${device.name}」的「命令行」能力是关闭的，本地 agent 要运行程序，需要先在 设置 → 设备 → 权限 把它设为「询问」或「允许」。`,
      );
    const settings = await settingsFor(device.id);
    const agent: LocalAgentKind = instanceRow
      ? ((isAgentDriverKind(instanceRow.driver)
          ? instanceRow.driver
          : "custom") as LocalAgentKind)
      : (input.agent ?? settings.defaultAgent);
    const detected = settings.detected?.agents ?? [];
    if (
      !instanceRow &&
      agent !== "builtin" &&
      settings.detected &&
      !detected.some((a) => a.kind === agent)
    ) {
      const have = detected
        .map((a) => LOCAL_AGENT_INFO[a.kind]?.label ?? a.kind)
        .join("、");
      throw new LocalAgentError(
        `「${device.name}」上没有检测到 ${LOCAL_AGENT_INFO[agent].label}。已安装：${have || "只有 ChisaBot 内置"}。`,
      );
    }
    let profile = narrowerProfile(
      effectiveProfile(settings, device),
      input.profile,
    );
    if (instanceRow?.config?.maxProfile) {
      profile = narrowerProfile(profile, instanceRow.config.maxProfile);
    }
    const sandboxes = settings.detected?.sandboxes ?? {};
    let isolation =
      input.isolation ??
      instanceRow?.config?.defaultIsolation ??
      settings.isolation;
    if (
      instanceRow &&
      !input.isolation &&
      !instanceRow.config?.defaultIsolation &&
      isolation === "worktree" &&
      settings.detected &&
      sandboxes.worktree !== true
    ) {
      isolation = "copy";
    }
    const network =
      input.network === undefined
        ? settings.network
        : input.network && settings.network;
    const roots = effectiveRoots(settings, device.allowedRoots);
    const cwd = input.cwd?.trim() || roots[0] || null;
    if (!cwd)
      throw new LocalAgentError(
        device.id === SERVER_ENVIRONMENT_ID
          ? "「服务器本机」还没有配置受控工作区文件夹。请管理员在 设置 → 智能体提供方 顶部设置服务器工作区路径（或配置 CHISABOT_SERVER_AGENT_ROOTS）。"
          : `「${device.name}」还没有工作区文件夹。请在 设置 → 设备 → 本地 agent（或 权限 → 允许的文件夹）里选一个，或者告诉我具体在哪个文件夹做。`,
      );
    if (profile !== "full" && !isInsideRoots(cwd, roots, device.platform))
      throw new LocalAgentError(
        `「${cwd}」不在「${device.name}」允许的工作区文件夹里（${roots.join("、") || "还没有"}）。可以换一个文件夹，或者在设置里加上它。`,
      );
    if (
      isolation !== "none" &&
      isolation !== "copy" &&
      settings.detected &&
      sandboxes[isolation] !== true
    )
      throw new LocalAgentError(
        `「${device.name}」上不能用「${ISOLATION_INFO[isolation].label}」。可用：${ISOLATIONS.filter(
          (i) => i === "none" || i === "copy" || sandboxes[i],
        )
          .map((i) => ISOLATION_INFO[i].label)
          .join("、")}。`,
      );
    if (
      (isolation === "docker" || isolation === "podman") &&
      agent !== "builtin"
    )
      throw new LocalAgentError(
        "容器隔离只给 ChisaBot 内置 agent 用（命令行 agent 要用它自己的登录，在容器里拿不到）。可以改用 worktree / 临时副本 / bubblewrap。",
      );
    const supportsReadOnly =
      AGENT_DRIVER_SPECS[agent as AgentDriverKind]?.fields.supportsReadOnly ??
      (agent === "builtin" || agent === "claude" || agent === "codex");
    if (isolation === "none" && profile === "readonly" && !supportsReadOnly)
      throw new LocalAgentError(
        `${instanceRow?.name ?? LOCAL_AGENT_INFO[agent].label} 没有直接只读模式。请用 Claude Code、Codex、ACP 提供方或内置 agent，或者在一次性副本（worktree / copy）里做。`,
      );
    if (!network && agent !== "builtin")
      throw new LocalAgentError(
        `${instanceRow?.name ?? LOCAL_AGENT_INFO[agent].label} 要联网访问它自己的模型服务，断网时只能用 ChisaBot 内置 agent（配合电脑上的本地模型）。`,
      );
    if (
      !network &&
      agent === "builtin" &&
      settings.builtinModel.kind === "server" &&
      isolation !== "docker" &&
      isolation !== "podman" &&
      isolation !== "bwrap" &&
      isolation !== "sandbox-exec"
    )
      throw new LocalAgentError(
        "「断网」要靠系统级沙盒（bubblewrap / macOS 沙盒 / Docker）才能真正做到；这台电脑当前的隔离方式做不到断网。",
      );
    const sandboxed = ISOLATION_INFO[isolation].sandbox;
    const disposable = ISOLATION_INFO[isolation].disposable;
    if (
      agent !== "builtin" &&
      agent !== "claude" &&
      agent !== "codex" &&
      agent !== "acp" &&
      agent !== "antigravity" &&
      profile !== "full" &&
      !sandboxed &&
      !disposable
    )
      throw new LocalAgentError(
        `${instanceRow?.name ?? LOCAL_AGENT_INFO[agent].label} 没有逐条确认，只在「完全访问」档位、一次性副本或系统级沙盒里使用。`,
      );
    const nestedBonus = input.parentTaskId ? Math.min(depth, 5) : 0;
    const [deviceActive, userActive] = await Promise.all([
      sql.unsafe<{ n: number }[]>(
        "SELECT count(*)::int AS n FROM chisabot_local_agent_tasks WHERE device_id = $1 AND status IN ('pending_approval','starting','running')",
        [device.id],
      ),
      sql.unsafe<{ n: number }[]>(
        "SELECT count(*)::int AS n FROM chisabot_local_agent_tasks WHERE owner_user_id = $1 AND status IN ('pending_approval','starting','running')",
        [input.ownerUserId],
      ),
    ]);
    if ((deviceActive[0]?.n ?? 0) >= PER_DEVICE_ACTIVE + nestedBonus)
      throw new LocalAgentError(
        `「${device.name}」上已经有 ${PER_DEVICE_ACTIVE} 个本地 agent 任务在跑，等一个结束再交新的。`,
        409,
      );
    if ((userActive[0]?.n ?? 0) >= PER_USER_ACTIVE + nestedBonus)
      throw new LocalAgentError(
        `已经有 ${PER_USER_ACTIVE} 个本地 agent 任务在跑。`,
        409,
      );

    const id = randomUUID();
    const title = clip(
      (input.title || input.task).replace(/\s+/g, " ").trim(),
      60,
    );
    const skipPermissions =
      profile === "full" || sandboxed || Boolean(instanceRow && disposable);
    // 旧版裸调用保持非 full 必先弹确认卡；已配置的提供方实例在授权工作区与隔离沙盒内默认直接启动，除非实例显式开启 requireStartApproval。
    const needsApproval = instanceRow
      ? profile !== "full" && instanceRow.config?.requireStartApproval === true
      : profile !== "full";

    const displayLabel = instanceRow?.name ?? LOCAL_AGENT_INFO[agent].label;
    const grant = await instancesStore.getBotGrant(
      input.ownerUserId,
      input.botId,
    );
    const runtimeInstance: RuntimeInstanceSpec | undefined = instanceRow
      ? await instancesStore.toRuntimeSpec(instanceRow)
      : undefined;
    const subagentBridge = {
      enabled: grant.allowNestedSubagents && depth < grant.maxDepth,
      depth,
      maxDepth: grant.maxDepth,
    };

    await sql.unsafe(
      `INSERT INTO chisabot_local_agent_tasks (
         id, owner_user_id, device_id, device_name, agent_id, bot_name, thread_id,
         agent, instance_id, instance_name, environment_id, parent_task_id, depth, invocation_mode,
         title, task, profile, isolation, network, cwd, status, step
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,
         $8,$9,$10,$11,$12,$13,$14,
         $15,$16,$17,$18,$19,$20,$21,$22
       )`,
      [
        id,
        input.ownerUserId,
        device.id,
        device.name,
        input.botId,
        input.botName,
        input.threadId,
        agent,
        instanceRow?.id ?? null,
        instanceRow?.name ?? null,
        device.id,
        input.parentTaskId ?? null,
        depth,
        input.invocationMode ?? null,
        title,
        input.task,
        profile,
        isolation,
        network,
        cwd,
        needsApproval ? "pending_approval" : "starting",
        needsApproval ? "等待你批准" : "等待后台执行位",
      ],
    );
    const state = liveOf(id);
    state.step = needsApproval ? "等待你批准" : "等待后台执行位";
    pushLine(
      id,
      "status",
      `交给「${device.name}」上的 ${displayLabel}：${profileLine({ profile, isolation, network })}，文件夹 ${cwd}`,
    );
    await deviceStore
      .audit({
        deviceId: device.id,
        ownerUserId: device.ownerUserId,
        actorType: "bot",
        actorId: input.botId,
        actorName: input.botName,
        action: "local_agent_task",
        summary: clip(
          `交给 ${displayLabel}：${title}（${profileLine({ profile, isolation, network })}，${cwd}）`,
          400,
        ),
        outcome: "succeeded",
        detail: null,
        durationMs: null,
      })
      .catch(() => {});

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
      ...(runtimeInstance ? { instance: runtimeInstance } : {}),
      subagentBridge,
    };
    void (async () => {
      if (needsApproval) {
        const summary = clip(
          `用 ${displayLabel} 做：${title}（${profileLine({ profile, isolation, network })}，文件夹 ${cwd}${skipPermissions && agent !== "builtin" ? "，agent 跳过它自己的逐条确认" : ""}）`,
          400,
        );
        const decision = await hub.requestUserApproval(
          device,
          {
            bot: { id: input.botId, name: input.botName },
            operation: "shell",
            summary,
          },
          (approvalId) => {
            state.approvalId = approvalId;
            state.approvalSummary = summary;
          },
        );
        state.approvalId = null;
        state.approvalSummary = null;
        if (!decision.approved) {
          await finish(id, "cancelled", {
            error:
              decision.by === "expired"
                ? "2 分钟内没有人批准，任务没有开始。"
                : "你没有批准这个任务，它没有开始。",
          });
          return;
        }
        const fresh = await resolveTargetDevice(input.ownerUserId, device.id);
        if (
          !fresh ||
          fresh.paused ||
          fresh.revoked ||
          !isEnvironmentOnline(device.id)
        ) {
          await finish(id, "failed", {
            error: "批准期间电脑停止、离线或被撤销，任务没有开始。",
          });
          return;
        }
        const approved = await sql.unsafe(
          "UPDATE chisabot_local_agent_tasks SET status='starting',step='等待后台执行位',updated_at=now() WHERE id=$1 AND status='pending_approval' AND NOT capacity_active RETURNING id",
          [id],
        );
        if (!approved.length) return;
        state.step = "正在发给电脑";
        pushLine(id, "approval", "已批准");
      }
      await dispatchQueued(await savedTaskRow(id), run);
    })().catch((error) => {
      console.warn("local agent start failed", error);
      void finish(id, "failed", { error: "启动失败。" });
    });
    return view(await savedTaskRow(id));
  }

  /**
   * 运行子代理任务，支持 `mode: "wait"`（阻塞等待结果直接返回当前回合，不触发二次收件箱回流）
   * 与 `mode: "async"`（立即返回任务卡片，结束后经收件箱回流）。
   */
  async function runSubagent(
    input: StartInput & {
      mode?: "wait" | "async";
      waitTimeoutMs?: number;
    },
  ): Promise<{ task: LocalAgentTaskView; timedOut: boolean }> {
    const mode = input.mode === "wait" ? "wait" : "async";
    const initial = await start({
      ...input,
      invocationMode: input.invocationMode ?? mode,
    });
    if (
      mode !== "wait" ||
      initial.status === "pending_approval" ||
      !ACTIVE_LOCAL_TASK.includes(initial.status)
    ) {
      return { task: initial, timedOut: false };
    }

    const maxWait = Math.min(
      timeoutMs,
      Math.max(1000, input.waitTimeoutMs ?? 180_000),
    );
    return new Promise<{ task: LocalAgentTaskView; timedOut: boolean }>(
      (resolve) => {
        let settled = false;
        const cleanup = () => {
          const set = waiters.get(initial.id);
          if (set) {
            set.delete(onUpdate);
            if (set.size === 0) waiters.delete(initial.id);
          }
          clearTimeout(timer);
        };
        const onUpdate = (updated: TaskRow) => {
          if (settled) return;
          if (!ACTIVE_LOCAL_TASK.includes(updated.status)) {
            settled = true;
            deliveredInline.add(initial.id);
            cleanup();
            resolve({ task: view(updated), timedOut: false });
          } else if (updated.status === "pending_approval") {
            settled = true;
            cleanup();
            resolve({ task: view(updated), timedOut: false });
          }
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          void savedTaskRow(initial.id)
            .then((cur) => resolve({ task: view(cur), timedOut: true }))
            .catch(() => resolve({ task: initial, timedOut: true }));
        }, maxWait);
        timer.unref?.();

        let set = waiters.get(initial.id);
        if (!set) {
          set = new Set();
          waiters.set(initial.id, set);
        }
        set.add(onUpdate);

        // 二次检查，防止在注册监听前任务已极速完成
        void taskRow(initial.id).then((latest) => {
          if (latest) onUpdate(latest);
        });
      },
    );
  }

  async function claimDeviceCapacity(
    row: TaskRow,
    status: "starting" | "running",
  ): Promise<boolean> {
    let waiting = false;
    for (;;) {
      const claimed = await sql.begin(async (tx) => {
        await lockBackgroundAccount(tx, row.owner_user_id);
        const [current] = await tx.unsafe<
          { status: string; capacity_active: boolean }[]
        >(
          "SELECT status,capacity_active FROM chisabot_local_agent_tasks WHERE id=$1 FOR UPDATE",
          [row.id],
        );
        if (
          !current ||
          !ACTIVE_LOCAL_TASK.includes(current.status as LocalAgentTaskStatus)
        )
          return "stopped";
        if (current.capacity_active) return "stopped"; // Another dispatcher already owns this row.
        if (
          !row.parent_task_id &&
          (await backgroundCount(tx, row.owner_user_id)) >= BACKGROUND_CAPACITY
        )
          return "waiting";
        await tx.unsafe(
          "UPDATE chisabot_local_agent_tasks SET capacity_active=true,status=$2,step='正在执行',updated_at=now() WHERE id=$1",
          [row.id, status],
        );
        return "claimed";
      });
      if (claimed === "stopped") return false;
      if (claimed === "claimed") {
        liveOf(row.id).step = "正在执行";
        reportCapacityState("admitted");
        return true;
      }
      if (!waiting) {
        await sql.unsafe(
          "UPDATE chisabot_local_agent_tasks SET step='等待后台执行位',updated_at=now() WHERE id=$1 AND NOT capacity_active",
          [row.id],
        );
        liveOf(row.id).step = "等待后台执行位";
        pushLine(row.id, "status", "后台执行位已满，任务已保留并排队。");
        reportCapacityState("waiting");
        waiting = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /** A queued row is already authorized but has never been dispatched; recovery reuses it. */
  async function dispatchQueued(row: TaskRow, supplied?: LocalAgentRunMessage) {
    const state = liveOf(row.id);
    if (state.dispatching) return;
    state.dispatching = true;
    try {
      if (!(await claimDeviceCapacity(row, "starting"))) return;
      const device = await resolveTargetDevice(
        row.owner_user_id,
        row.device_id,
      );
      if (
        !device ||
        device.paused ||
        device.revoked ||
        !isEnvironmentOnline(row.device_id)
      ) {
        await sql.unsafe(
          "UPDATE chisabot_local_agent_tasks SET capacity_active=false WHERE id=$1",
          [row.id],
        );
        await finish(row.id, "failed", {
          error: "等待执行位期间电脑停止、离线或被撤销，任务没有发出。",
        });
        return;
      }
      const settings = await settingsFor(row.device_id);
      const roots = effectiveRoots(settings, device.allowedRoots);
      if (
        narrowerProfile(
          effectiveProfile(settings, device),
          row.profile as AgentProfile,
        ) !== row.profile ||
        (row.profile !== "full" &&
          !isInsideRoots(row.cwd ?? "", roots, device.platform))
      ) {
        await sql.unsafe(
          "UPDATE chisabot_local_agent_tasks SET capacity_active=false WHERE id=$1",
          [row.id],
        );
        await finish(row.id, "failed", {
          error: "设备权限或允许目录已更改，原任务没有发出。",
        });
        return;
      }
      let recoveredInstance: RuntimeInstanceSpec | undefined;
      if (!supplied && row.instance_id) {
        const instRow = await instancesStore.getRow(
          row.owner_user_id,
          row.instance_id,
        );
        if (instRow) {
          recoveredInstance = await instancesStore.toRuntimeSpec(instRow);
        }
      }
      const grant = !supplied
        ? await instancesStore.getBotGrant(row.owner_user_id, row.agent_id)
        : null;
      const rowDepth = Number(row.depth ?? 0);
      const run: LocalAgentRunMessage = {
        ...(supplied ?? {
          type: "agent_run",
          taskId: row.id,
          agent: row.agent as LocalAgentKind,
          prompt: row.task,
          cwd: row.cwd!,
          profile: row.profile as AgentProfile,
          isolation: row.isolation as Isolation,
          network: row.network,
          roots,
          skipPermissions:
            row.profile === "full" ||
            ISOLATION_INFO[row.isolation as Isolation].sandbox ||
            Boolean(
              row.instance_id &&
                ISOLATION_INFO[row.isolation as Isolation].disposable,
            ),
          builtinModel: settings.builtinModel,
          containerImage: settings.containerImage,
          timeoutMs,
          ...(recoveredInstance ? { instance: recoveredInstance } : {}),
          ...(grant
            ? {
                subagentBridge: {
                  enabled:
                    grant.allowNestedSubagents && rowDepth < grant.maxDepth,
                  depth: rowDepth,
                  maxDepth: grant.maxDepth,
                },
              }
            : {}),
        }),
        roots,
      };
      const dispatched = await sql.begin(async (tx) => {
        const [current] = await tx.unsafe<
          { status: string; capacity_active: boolean }[]
        >(
          "SELECT status,capacity_active FROM chisabot_local_agent_tasks WHERE id=$1 FOR UPDATE",
          [row.id],
        );
        if (
          !current ||
          !ACTIVE_LOCAL_TASK.includes(current.status as LocalAgentTaskStatus) ||
          !current.capacity_active
        )
          return "stopped";
        return sendToEnvironment(
          row.device_id,
          run as unknown as { type: string } & Record<string, unknown>,
        )
          ? "sent"
          : "offline";
      });
      if (dispatched !== "sent") {
        await sql.unsafe(
          "UPDATE chisabot_local_agent_tasks SET capacity_active=false WHERE id=$1",
          [row.id],
        );
        if (dispatched === "stopped") return;
        await finish(row.id, "failed", {
          error: "宿主离线，没能把任务发过去。",
        });
        return;
      }
      state.deadline = executionDeadline(timeoutMs + 60_000, () => {
        sendToEnvironment(row.device_id, {
          type: "agent_stop",
          taskId: row.id,
        });
        void finish(row.id, "failed", {
          error: `超过 ${Math.round(timeoutMs / 60_000)} 分钟没有结束，已请求停止；设备确认前保留执行位。`,
        });
      });
    } finally {
      state.dispatching = false;
    }
  }

  async function owned(actorId: string, id: string) {
    const row = await taskRow(id);
    if (!row || row.owner_user_id !== actorId)
      throw new LocalAgentError("没有这个任务。", 404);
    return row;
  }

  async function stop(
    actorId: string,
    id: string,
    by: "user" | "bot" = "user",
  ) {
    const row = await owned(actorId, id);
    if (!ACTIVE_LOCAL_TASK.includes(row.status)) {
      if (row.capacity_active)
        sendToEnvironment(row.device_id, { type: "agent_stop", taskId: id });
      return view(row);
    }
    const state = live.get(id);
    if (state?.approvalId) hub.decide(state.approvalId, false, "system");
    // 电脑会回 agent_done（stopped）；它离线或没回就在这里收尾。
    const done = await finish(id, "cancelled", {
      error:
        by === "user"
          ? "你在任务卡片上停止了这个任务。"
          : "机器人停止了这个任务。",
      requestDeviceStop: row.device_id,
    });
    return view(done ?? (await savedTaskRow(id)));
  }

  async function applyChanges(actorId: string, id: string, discard: boolean) {
    const row = await owned(actorId, id);
    if (!row.diff?.pending)
      throw new LocalAgentError(
        discard ? "没有要放弃的改动。" : "没有待应用的改动。",
      );
    if (!isEnvironmentOnline(row.device_id))
      throw new LocalAgentError(
        `「${row.device_name}」现在离线，改动还在那台电脑的临时目录里。`,
        409,
      );
    const result = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingApply.delete(id);
        resolve("宿主没有及时回应。");
      }, 60_000);
      pendingApply.set(id, (error) => {
        clearTimeout(timer);
        pendingApply.delete(id);
        resolve(error);
      });
      if (
        !sendToEnvironment(row.device_id, {
          type: discard ? "agent_discard" : "agent_apply",
          taskId: id,
        })
      ) {
        clearTimeout(timer);
        pendingApply.delete(id);
        resolve("宿主离线。");
      }
    });
    const device = await resolveTargetDevice(row.owner_user_id, row.device_id);
    if (device)
      await deviceStore
        .audit({
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
        })
        .catch(() => {});
    if (result) throw new LocalAgentError(result, 409);
    return view(await savedTaskRow(id));
  }

  async function forThread(actorId: string, threadId: string) {
    const rows = await sql.unsafe<TaskRow[]>(
      "SELECT * FROM chisabot_local_agent_tasks WHERE thread_id = $1 AND owner_user_id = $2 ORDER BY created_at ASC LIMIT 50",
      [threadId, actorId],
    );
    return rows.map((row) => view(row));
  }

  async function forDevice(actorId: string, deviceId: string) {
    const rows = await sql.unsafe<TaskRow[]>(
      "SELECT * FROM chisabot_local_agent_tasks WHERE device_id = $1 AND owner_user_id = $2 ORDER BY created_at DESC LIMIT 20",
      [deviceId, actorId],
    );
    return rows.map((row) => view(row));
  }

  /** 删设备时一起删。 */
  async function forgetDevice(deviceId: string) {
    settingsCache.delete(deviceId);
    await sql.unsafe(
      "DELETE FROM chisabot_device_agent_settings WHERE device_id = $1",
      [deviceId],
    );
    await sql.unsafe(
      "DELETE FROM chisabot_agent_instances WHERE environment_id = $1",
      [deviceId],
    );
  }

  // ── 环境列表与实例探活 ─────────────────────────────────────────────────

  async function listEnvironments(
    actorId: string,
  ): Promise<AgentEnvironmentSummary[]> {
    await ensureServerSeedsForOwner(actorId);
    const [devices, allInstances] = await Promise.all([
      deviceStore.forOwner(actorId),
      instancesStore.listRows(actorId),
    ]);
    const countsByEnv = new Map<string, { total: number; enabled: number }>();
    for (const r of allInstances) {
      const cur = countsByEnv.get(r.environment_id) ?? { total: 0, enabled: 0 };
      cur.total++;
      if (r.enabled) cur.enabled++;
      countsByEnv.set(r.environment_id, cur);
    }

    const list: AgentEnvironmentSummary[] = [];
    if (serverHost) {
      const sSettings = await settingsFor(SERVER_ENVIRONMENT_ID);
      const sRoots = serverAllowedRoots(sSettings);
      const sRecord = buildServerDeviceRecord(actorId, sRoots);
      const c = countsByEnv.get(SERVER_ENVIRONMENT_ID) ?? {
        total: 0,
        enabled: 0,
      };
      list.push({
        id: SERVER_ENVIRONMENT_ID,
        name: "服务器本机",
        kind: "server",
        online: true,
        platform: process.platform,
        profile: effectiveProfile(sSettings, sRecord),
        isolation: sSettings.isolation,
        network: sSettings.network,
        workspaceRoots: sRoots,
        detectedAt: sSettings.detected?.checkedAt ?? null,
        instanceCount: c.total,
        enabledCount: c.enabled,
      });
    }

    for (const dev of devices) {
      if (isMobilePlatform(dev.platform) || dev.revoked) continue;
      const dSettings = await settingsFor(dev.id);
      const c = countsByEnv.get(dev.id) ?? { total: 0, enabled: 0 };
      list.push({
        id: dev.id,
        name: dev.name,
        kind: "device",
        online: hub.isOnline(dev.id),
        platform: dev.platform,
        profile: effectiveProfile(dSettings, dev),
        isolation: dSettings.isolation,
        network: dSettings.network,
        workspaceRoots: effectiveRoots(dSettings, dev.allowedRoots),
        detectedAt: dSettings.detected?.checkedAt ?? null,
        instanceCount: c.total,
        enabledCount: c.enabled,
      });
    }
    return list;
  }

  async function probeInstance(
    actorId: string,
    instanceId: string,
  ): Promise<AgentInstanceView> {
    const row = await instancesStore.getRow(actorId, instanceId);
    if (!row) throw new LocalAgentError("没有这个智能体实例。", 404);
    if (!isEnvironmentOnline(row.environment_id)) {
      const offlineProbe: AgentProbeState = {
        status: "unknown",
        version: row.probe?.version ?? null,
        resolvedPath: row.probe?.resolvedPath ?? null,
        authenticated: row.probe?.authenticated ?? null,
        authLabel: row.probe?.authLabel ?? null,
        message: "宿主当前离线，无法检测",
        checkedAt: new Date().toISOString(),
      };
      const saved = await instancesStore.saveProbe(
        actorId,
        row.id,
        offlineProbe,
      );
      if (!saved) throw new LocalAgentError("没有这个智能体实例。", 404);
      return saved;
    }
    const spec = await instancesStore.toRuntimeSpec(row);
    const reqId = `probe_${randomUUID().slice(0, 12)}`;
    const result = await new Promise<Omit<AgentProbeState, "checkedAt">>(
      (resolve) => {
        const timer = setTimeout(() => {
          probePending.delete(reqId);
          resolve({
            status: "error",
            version: null,
            resolvedPath: null,
            authenticated: null,
            authLabel: null,
            message: "检测超时（15 秒未响应）",
          });
        }, 15_000);
        timer.unref?.();
        probePending.set(reqId, (probe) => {
          clearTimeout(timer);
          resolve(probe);
        });
        if (
          !sendToEnvironment(row.environment_id, {
            type: "agent_probe",
            reqId,
            instance: spec,
          })
        ) {
          clearTimeout(timer);
          probePending.delete(reqId);
          resolve({
            status: "unknown",
            version: null,
            resolvedPath: null,
            authenticated: null,
            authLabel: null,
            message: "宿主离线",
          });
        }
      },
    );
    const fullProbe: AgentProbeState = {
      ...result,
      checkedAt: new Date().toISOString(),
    };
    const updated = await instancesStore.saveProbe(actorId, row.id, fullProbe);
    if (!updated) throw new LocalAgentError("没有这个智能体实例。", 404);
    return updated;
  }

  async function probeEnvironment(
    actorId: string,
    environmentId: string,
  ): Promise<AgentInstanceView[]> {
    const target = await resolveTargetDevice(actorId, environmentId);
    if (!target) throw new LocalAgentError("没有这个运行环境。", 404);
    sendToEnvironment(environmentId, { type: "agent_detect" });
    await ensureServerSeedsForOwner(actorId);
    const rows = await instancesStore.listRows(actorId, environmentId);
    const updated: AgentInstanceView[] = [];
    for (const row of rows) {
      updated.push(await probeInstance(actorId, row.id));
    }
    return updated;
  }

  // ── 机器人工具 ────────────────────────────────────────────────────────

  function guidanceText(
    devices: Array<{ device: DeviceRecord; settings: DeviceAgentSettings }>,
    grantedInstances: readonly AgentInstanceView[],
  ) {
    const lines = devices.map(({ device, settings }) => {
      const agents = (
        settings.detected?.agents ?? [{ kind: "builtin" as const }]
      )
        .map((a) => LOCAL_AGENT_INFO[a.kind]?.label ?? a.kind)
        .join("、");
      return `- 电脑「${device.name}」：档位 ${PROFILE_INFO[effectiveProfile(settings, device)].label}，默认隔离 ${ISOLATION_INFO[settings.isolation].label}，已检测：${agents}`;
    });
    const instLines = grantedInstances.map(
      (inst) =>
        `- 子代理实例「${inst.name}」（标识 \`${inst.slug}\`，宿主「${inst.environmentName}」${inst.exposeAsTool ? `，专属工具 \`${inst.toolName}\`` : ""}）：${inst.description || AGENT_DRIVER_SPECS[inst.driver].description}`,
    );
    return [
      "Subagents & Configured Agent Providers (可调用的子代理与本地智能体)：",
      "- 当需要把代码检索、工程实现、重构修复、专项审查或独立子任务委派给已配置好的智能体时，优先使用 `subagent_run` 或对应的 `agent_<slug>` 专属工具。",
      "- 调用模式：`mode = 'wait'`（默认推荐用于分析、问答、中短耗时编程任务）会等待子代理执行完毕并在当前回合直接返回 `{ summary, diff, error }`，拿到结果后直接向用户汇报，无需再等后台消息；`mode = 'async'` 用于耗时较长的大型任务，会立即返回并在聊天里展示实时任务卡片，结束后作为 `⟦chisabot:local-agent-result:...⟧` 消息回到对话。",
      "- 子代理看不到当前聊天上下文，调用时务必在 `task` 参数中写清楚完整背景、目标文件、约束条件与验收标准。",
      ...(instLines.length
        ? ["当前已授权在线的子代理实例：", ...instLines]
        : []),
      ...(lines.length ? ["当前在线设备宿主：", ...lines] : []),
    ].join("\n");
  }

  async function tools(input: {
    ownerUserId: string;
    botId: string;
    botName: string | null;
    threadId: string;
  }): Promise<GrantedTool[]> {
    await ensureServerSeedsForOwner(input.ownerUserId);
    const { grant, instances: grantedInstances } =
      await instancesStore.listGrantedInstances(
        input.ownerUserId,
        input.botId,
        {
          onlineOnly: true,
        },
      );
    if (grant.mode === "none") return [];

    const devices = (await deviceStore.forOwner(input.ownerUserId)).filter(
      (d) => !isMobilePlatform(d.platform) && !d.revoked,
    );
    const online = devices.filter((d) => hub.isOnline(d.id));
    if (!online.length && !grantedInstances.length) return [];

    const withSettings = await Promise.all(
      online.map(async (device) => ({
        device,
        settings: await settingsFor(device.id),
      })),
    );
    const guidance = guidanceText(withSettings, grantedInstances);
    const refuse = (error: unknown) =>
      `${REFUSAL_MARKER} ${reasonWithoutStatement(error)}`;

    const formatOutcome = (outcome: {
      task: LocalAgentTaskView;
      timedOut: boolean;
    }) => {
      const { task, timedOut } = outcome;
      const label =
        task.instanceName || LOCAL_AGENT_INFO[task.agent]?.label || task.agent;
      if (
        task.status === "done" ||
        task.status === "failed" ||
        task.status === "cancelled"
      ) {
        return JSON.stringify({
          taskId: task.id,
          status: task.status,
          instanceName: label,
          device: task.deviceName,
          profile: profileLine(task),
          cwd: task.cwd,
          summary: task.summary,
          diff: task.diff
            ? {
                files: task.diff.files,
                added: task.diff.added,
                removed: task.diff.removed,
                pending: task.diff.pending,
              }
            : null,
          error: task.error,
        });
      }
      return JSON.stringify({
        taskId: task.id,
        status: task.status,
        timedOut,
        instanceName: label,
        device: task.deviceName,
        profile: profileLine(task),
        cwd: task.cwd,
        note:
          task.status === "pending_approval"
            ? "已在任务卡片弹出审批，用户批准后开始执行，完成后结果会回到对话。"
            : timedOut
              ? "子代理仍在后台继续执行，完成后结果会作为消息回到当前对话。"
              : "子代理已开始后台执行，进度在聊天任务卡片实时更新，完成后结果会回到当前对话。",
      });
    };

    const result: GrantedTool[] = [];

    if (grantedInstances.length > 0) {
      const subRunSchema = z.object({
        instance: z
          .string()
          .min(1)
          .describe(
            `目标子代理实例标识（slug 或 id），可选：${grantedInstances
              .map((i) => `${i.slug}（${i.name}@${i.environmentName}）`)
              .join("、")}`,
          ),
        task: z
          .string()
          .min(1)
          .max(20_000)
          .describe(
            "交给子代理执行的完整任务说明（子代理看不到当前对话历史，请写清目标、相关路径与验收要求）",
          ),
        title: z
          .string()
          .max(60)
          .optional()
          .describe("任务简短标题（十来个字）"),
        mode: z
          .enum(["wait", "async"])
          .optional()
          .describe(
            "wait（默认）= 等待子代理完成并直接拿回结果继续回答；async = 立即返回任务卡片，后台跑完再回流通知",
          ),
        cwd: z
          .string()
          .max(1000)
          .optional()
          .describe("工作目录绝对路径；省略则使用宿主默认工作区目录"),
        profile: z
          .enum(AGENT_PROFILES)
          .optional()
          .describe("本次任务权限档位（如 readonly 只读分析），只能比宿主更严"),
        isolation: z
          .enum(ISOLATIONS)
          .optional()
          .describe("worktree / copy = 一次性副本；none = 直接修改工作目录"),
      });

      result.push(
        {
          name: "subagent_list",
          ref: "local-agents/subagent-list",
          description:
            "列出当前已配置且获授权在线的所有子代理实例（Codex、Claude、Antigravity、Codebuddy 等）、所属运行环境与各自擅长的职责。",
          parameters: z.object({}),
          guidance,
          execute: async () => {
            const latest = await instancesStore.listGrantedInstances(
              input.ownerUserId,
              input.botId,
              { onlineOnly: true },
            );
            return JSON.stringify({
              instances: latest.instances.map((i) => ({
                id: i.id,
                slug: i.slug,
                name: i.name,
                driver: i.driver,
                toolName: i.exposeAsTool ? i.toolName : null,
                environmentId: i.environmentId,
                environmentName: i.environmentName,
                description: i.description,
                version: i.probe?.version ?? null,
              })),
            });
          },
        },
        {
          name: "subagent_run",
          ref: "local-agents/subagent-run",
          description:
            "调用指定的已配置智能体实例作为子代理执行任务。支持同步等待结果（mode='wait'）或后台异步执行（mode='async'）。",
          parameters: subRunSchema,
          ...(online.length === 0 ? { guidance } : {}),
          execute: async (raw) => {
            try {
              const args = subRunSchema.parse(raw);
              const outcome = await runSubagent({
                ownerUserId: input.ownerUserId,
                botId: input.botId,
                botName: input.botName,
                threadId: input.threadId,
                instance: args.instance,
                task: args.task,
                title: args.title,
                cwd: args.cwd,
                profile: args.profile,
                isolation: args.isolation,
                mode: args.mode ?? "wait",
              });
              return formatOutcome(outcome);
            } catch (error) {
              return refuse(error);
            }
          },
        },
        {
          name: "subagent_status",
          ref: "local-agents/subagent-status",
          description: "查询子代理任务的当前状态、最近输出与文件改动摘要。",
          parameters: z.object({ taskId: z.string().optional() }),
          execute: async (raw) => {
            try {
              const { taskId } = z
                .object({ taskId: z.string().optional() })
                .parse(raw);
              const list = taskId
                ? [view(await owned(input.ownerUserId, taskId))]
                : (await forThread(input.ownerUserId, input.threadId)).slice(
                    -3,
                  );
              return JSON.stringify(
                list.map((t) => ({
                  taskId: t.id,
                  instanceName: t.instanceName,
                  title: t.title,
                  status: t.status,
                  step: t.step,
                  summary: t.summary,
                  recent: t.lines.slice(-8).map((l) => l.text),
                  diff: t.diff
                    ? {
                        files: t.diff.files.length,
                        added: t.diff.added,
                        removed: t.diff.removed,
                        pending: t.diff.pending,
                      }
                    : null,
                  error: t.error,
                })),
              );
            } catch (error) {
              return refuse(error);
            }
          },
        },
        {
          name: "subagent_stop",
          ref: "local-agents/subagent-stop",
          description: "停止一个正在运行的子代理任务。",
          parameters: z.object({ taskId: z.string().min(1) }),
          execute: async (raw) => {
            try {
              const { taskId } = z
                .object({ taskId: z.string().min(1) })
                .parse(raw);
              const task = await stop(input.ownerUserId, taskId, "bot");
              return JSON.stringify({ taskId: task.id, status: task.status });
            } catch (error) {
              return refuse(error);
            }
          },
        },
      );

      if (grant.exposeNamedTools) {
        const usedNames = new Set(result.map((t) => t.name));
        const namedSchema = z.object({
          task: z
            .string()
            .min(1)
            .max(20_000)
            .describe(
              "派发给该智能体的完整任务说明（包含背景、目标文件路径与验收标准）",
            ),
          title: z.string().max(60).optional().describe("卡片简短标题"),
          mode: z
            .enum(["wait", "async"])
            .optional()
            .describe(
              "wait（默认）= 同步等待结果并在本轮直接拿到输出；async = 后台异步运行",
            ),
          cwd: z
            .string()
            .max(1000)
            .optional()
            .describe("工作目录绝对路径（可选）"),
          profile: z
            .enum(AGENT_PROFILES)
            .optional()
            .describe("权限档位覆盖（如 readonly）"),
        });

        for (const inst of grantedInstances) {
          if (!inst.exposeAsTool) continue;
          let fnName = agentToolName(inst.slug);
          if (usedNames.has(fnName)) {
            fnName = agentToolName(
              `${inst.slug}_${inst.environmentId.slice(0, 8)}`,
            );
          }
          if (usedNames.has(fnName)) continue;
          usedNames.add(fnName);

          const specDesc =
            inst.description || AGENT_DRIVER_SPECS[inst.driver].description;
          result.push({
            name: fnName,
            ref: `local-agents/instance/${inst.slug}`,
            description: `将任务派发给智能体「${inst.name}」（运行于「${inst.environmentName}」）。${specDesc}`,
            parameters: namedSchema,
            execute: async (raw) => {
              try {
                const args = namedSchema.parse(raw);
                const outcome = await runSubagent({
                  ownerUserId: input.ownerUserId,
                  botId: input.botId,
                  botName: input.botName,
                  threadId: input.threadId,
                  instance: inst.id,
                  task: args.task,
                  title: args.title,
                  cwd: args.cwd,
                  profile: args.profile,
                  mode: args.mode ?? "wait",
                });
                return formatOutcome(outcome);
              } catch (error) {
                return refuse(error);
              }
            },
          });
        }
      }
    }

    if (online.length > 0) {
      const runSchema = z.object({
        deviceId: z
          .string()
          .min(1)
          .optional()
          .describe("目标电脑：设备 id 或名称。只有一台在线时可以省略。"),
        agent: z
          .enum(LOCAL_AGENT_KINDS)
          .optional()
          .describe(
            "builtin = ChisaBot 内置；claude = Claude Code；codex = Codex CLI；antigravity / acp / opencode / gemini / aider / custom。省略 = 这台电脑的默认 agent。",
          ),
        task: z
          .string()
          .min(1)
          .max(20_000)
          .describe(
            "交给本地 agent 的完整指令（它看不到这段聊天，要写清楚目标、文件、验收方法）",
          ),
        title: z.string().max(60).optional().describe("卡片标题，十来个字"),
        cwd: z
          .string()
          .max(1000)
          .optional()
          .describe("在哪个文件夹做（绝对路径）；省略 = 工作区第一个文件夹"),
        profile: z
          .enum(AGENT_PROFILES)
          .optional()
          .describe("这次任务的档位，只能比电脑的档位更严（例如只读分析）"),
        isolation: z
          .enum(ISOLATIONS)
          .optional()
          .describe(
            "worktree / copy = 一次性副本（改动要用户点「应用改动」）；none = 直接改；bwrap / sandbox-exec / docker = 系统级沙盒。省略 = 电脑的默认设置",
          ),
        network: z
          .boolean()
          .optional()
          .describe("false = 这次任务断网（只在电脑允许时有效）"),
      });
      result.push(
        {
          name: "device_agent_list",
          ref: "local-agents/list",
          description:
            "列出用户在线电脑上的本地 agent（已安装的 Claude Code / Codex / OpenCode… 和 ChisaBot 内置）、权限档位、可用的沙盒和工作区文件夹。",
          parameters: z.object({}),
          ...(grantedInstances.length === 0 ? { guidance } : {}),
          execute: async () => {
            const fresh = await Promise.all(
              online.map(async (device) => {
                const settings = await settingsFor(device.id);
                return {
                  deviceId: device.id,
                  name: device.name,
                  profile: effectiveProfile(settings, device),
                  profileLabel:
                    PROFILE_INFO[effectiveProfile(settings, device)].label,
                  workspaceRoots: effectiveRoots(settings, device.allowedRoots),
                  defaultIsolation: settings.isolation,
                  network: settings.network,
                  defaultAgent: settings.defaultAgent,
                  agents: (
                    settings.detected?.agents ?? [
                      { kind: "builtin", version: null, path: null },
                    ]
                  ).map((a) => ({
                    agent: a.kind,
                    label: LOCAL_AGENT_INFO[a.kind]?.label,
                    version: a.version,
                  })),
                  sandboxes: Object.entries(settings.detected?.sandboxes ?? {})
                    .filter(([, v]) => v)
                    .map(([k]) => k),
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
          description:
            "把一件事交给用户电脑上的本地 agent（Claude Code、Codex、ChisaBot 内置…）去做，立刻返回并在聊天里显示任务卡片（实时输出、停止、改动）。结果之后作为一条消息回到这里。",
          parameters: runSchema,
          execute: async (raw) => {
            try {
              const args = runSchema.parse(raw);
              const task = await start({
                ownerUserId: input.ownerUserId,
                botId: input.botId,
                botName: input.botName,
                threadId: input.threadId,
                device: args.deviceId,
                agent: args.agent,
                task: args.task,
                title: args.title,
                cwd: args.cwd,
                profile: args.profile,
                isolation: args.isolation,
                network: args.network,
              });
              return JSON.stringify({
                taskId: task.id,
                status: task.status,
                device: task.deviceName,
                agent: LOCAL_AGENT_INFO[task.agent].label,
                profile: profileLine(task),
                cwd: task.cwd,
                note:
                  task.status === "pending_approval"
                    ? "已在网页 / 手机 / 电脑上弹出审批，用户批准后开始。结果会作为一条消息回到这里，现在不用等。"
                    : "已经开始，结果会作为一条消息回到这里，现在不用等。",
              });
            } catch (error) {
              return refuse(error);
            }
          },
        },
        {
          name: "device_agent_status",
          ref: "local-agents/status",
          description:
            "看本地 agent 任务的状态和最近的输出（不给 taskId = 这段对话里最近的任务）。",
          parameters: z.object({ taskId: z.string().optional() }),
          execute: async (raw) => {
            try {
              const { taskId } = z
                .object({ taskId: z.string().optional() })
                .parse(raw);
              const list = taskId
                ? [view(await owned(input.ownerUserId, taskId))]
                : (await forThread(input.ownerUserId, input.threadId)).slice(
                    -3,
                  );
              return JSON.stringify(
                list.map((t) => ({
                  taskId: t.id,
                  title: t.title,
                  status: t.status,
                  step: t.step,
                  recent: t.lines.slice(-8).map((l) => l.text),
                  diff: t.diff
                    ? {
                        files: t.diff.files.length,
                        added: t.diff.added,
                        removed: t.diff.removed,
                        pending: t.diff.pending,
                      }
                    : null,
                  error: t.error,
                })),
              );
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
              const { taskId } = z
                .object({ taskId: z.string().min(1) })
                .parse(raw);
              const task = await stop(input.ownerUserId, taskId, "bot");
              return JSON.stringify({ taskId: task.id, status: task.status });
            } catch (error) {
              return refuse(error);
            }
          },
        },
      );
    }

    return result;
  }

  // ── 接口 ──────────────────────────────────────────────────────────────

  const driverConfigSchema: z.ZodType<AgentDriverConfig> = z
    .object({
      commandPath: z.string().max(600).nullable().optional(),
      homePath: z.string().max(600).nullable().optional(),
      shadowHomePath: z.string().max(600).nullable().optional(),
      extraArgs: z.array(z.string().max(500)).max(40).optional(),
      model: z.string().max(200).nullable().optional(),
      fixProxy: z.boolean().optional(),
      protocolMode: z.enum(["auto", "acp", "cli"]).optional(),
      acpSource: z.enum(["registry", "local"]).optional(),
      acpAgentId: z.string().max(120).nullable().optional(),
      acpLauncher: z.enum(["npx", "uvx", "binary", "custom"]).optional(),
      acpPackage: z.string().max(300).nullable().optional(),
      authMethodId: z.string().max(120).nullable().optional(),
      stdinPrompt: z.boolean().optional(),
      outputFormat: z.enum(["text", "jsonl"]).optional(),
      defaultIsolation: z.enum(ISOLATIONS).nullable().optional(),
      maxProfile: z.enum(AGENT_PROFILES).nullable().optional(),
      requireStartApproval: z.boolean().optional(),
    })
    .strict();

  const envVarInputSchema = z
    .object({
      name: z.string().min(1).max(120),
      value: z.string().max(8000).optional(),
      sensitive: z.boolean().optional(),
      keepExisting: z.boolean().optional(),
    })
    .strict();

  const instanceCreateSchema = z
    .object({
      environmentId: z.string().min(1).max(120),
      driver: z.enum(AGENT_DRIVER_KINDS),
      name: z.string().min(1).max(80),
      slug: z.string().max(60).optional(),
      description: z.string().max(1000).optional(),
      enabled: z.boolean().optional(),
      exposeAsTool: z.boolean().optional(),
      config: driverConfigSchema.optional(),
      envVars: z.array(envVarInputSchema).max(50).optional(),
    })
    .strict();

  const instancePatchSchema = z
    .object({
      name: z.string().min(1).max(80).optional(),
      slug: z.string().max(60).optional(),
      description: z.string().max(1000).optional(),
      enabled: z.boolean().optional(),
      exposeAsTool: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(10_000).optional(),
      config: driverConfigSchema.optional(),
      envVars: z.array(envVarInputSchema).max(50).optional(),
    })
    .strict();

  const botGrantPatchSchema = z
    .object({
      mode: z.enum(BOT_AGENT_GRANT_MODES).optional(),
      instanceIds: z.array(z.string().min(1).max(120)).max(200).optional(),
      exposeNamedTools: z.boolean().optional(),
      allowNestedSubagents: z.boolean().optional(),
      maxDepth: z.number().int().min(1).max(5).optional(),
    })
    .strict();

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser, bodyLimit({ maxSize: 65_536 }));
    app.onError((error, c) => {
      if (error instanceof LocalAgentError)
        return c.json({ error: error.message }, error.status);
      if (error instanceof z.ZodError)
        return c.json({ error: error.issues[0]?.message ?? "参数不对。" }, 400);
      console.error(
        JSON.stringify({
          type: "local-agents-error",
          error: error.name,
          message: reasonWithoutStatement(error).slice(0, 200),
          route: c.req.path,
        }),
      );
      return c.json({ error: "本地 agent 暂时不可用，请重试。" }, 503);
    });

    const assertServerAdminIfNeeded = (
      actor: AppVariables["actor"],
      environmentId: string,
    ) => {
      if (environmentId === SERVER_ENVIRONMENT_ID && actor.role !== "admin") {
        throw new LocalAgentError(
          "只有管理员可以修改服务器本机的智能体提供方与受控目录设置。",
          403,
        );
      }
    };

    const ownEnvironment = async (actorId: string, envId: string) => {
      const target = await resolveTargetDevice(actorId, envId);
      if (!target) throw new LocalAgentError("没有这个运行环境。", 404);
      return target;
    };

    const ownDevice = async (actorId: string, deviceId: string) => {
      if (deviceId === SERVER_ENVIRONMENT_ID) {
        return ownEnvironment(actorId, deviceId);
      }
      const device = await deviceStore.get(deviceId);
      if (!device || device.ownerUserId !== actorId)
        throw new LocalAgentError("没有这台设备。", 404);
      return device;
    };

    app.get("/presets", (c) =>
      c.json({
        presets: AGENT_PROVIDER_PRESETS,
        specs: AGENT_DRIVER_SPECS,
      }),
    );

    app.get("/acp-registry", async (c) => {
      const query = c.req.query("q") ?? "";
      const refresh = c.req.query("refresh") === "1";
      const result = await listAcpRegistryEntries({ query, refresh });
      return c.json(result);
    });

    app.get("/environments", async (c) =>
      c.json({ environments: await listEnvironments(c.var.actor.id) }),
    );

    app.get("/environments/:id/settings", async (c) => {
      const envId = c.req.param("id");
      const target = await ownEnvironment(c.var.actor.id, envId);
      const settings = await settingsFor(target.id);
      return c.json({
        settings,
        effectiveRoots: effectiveRoots(settings, target.allowedRoots),
        envRoots: envId === SERVER_ENVIRONMENT_ID ? parseEnvServerRoots() : [],
        online: isEnvironmentOnline(target.id),
        tasks: await forDevice(c.var.actor.id, target.id),
      });
    });

    app.put("/environments/:id/settings", async (c) => {
      const envId = c.req.param("id");
      assertServerAdminIfNeeded(c.var.actor, envId);
      const patch = settingsPatch.parse(await c.req.json());
      const settings = await saveSettings(c.var.actor.id, envId, patch);
      return c.json({ settings });
    });

    app.post("/environments/:id/probe-all", async (c) => {
      const envId = c.req.param("id");
      const instances = await probeEnvironment(c.var.actor.id, envId);
      return c.json({ instances });
    });

    app.get("/instances", async (c) => {
      const envId = c.req.query("environmentId") || undefined;
      await ensureServerSeedsForOwner(c.var.actor.id);
      const instances = await instancesStore.listInstances(
        c.var.actor.id,
        envId,
      );
      return c.json({ instances });
    });

    app.post("/instances", async (c) => {
      const body = instanceCreateSchema.parse(await c.req.json());
      assertServerAdminIfNeeded(c.var.actor, body.environmentId);
      await ownEnvironment(c.var.actor.id, body.environmentId);
      const created = await instancesStore.createInstance({
        ownerUserId: c.var.actor.id,
        ...body,
      });
      // 若宿主在线，创建后顺手异步探活一次更新版本与认证状态
      if (isEnvironmentOnline(body.environmentId)) {
        const probed = await probeInstance(c.var.actor.id, created.id).catch(
          () => created,
        );
        return c.json({ instance: probed }, 201);
      }
      return c.json({ instance: created }, 201);
    });

    app.get("/instances/:id", async (c) => {
      const inst = await instancesStore.getInstance(
        c.var.actor.id,
        c.req.param("id"),
      );
      if (!inst) throw new LocalAgentError("没有这个智能体实例。", 404);
      return c.json({ instance: inst });
    });

    const updateHandler = async (c: {
      var: { actor: AppVariables["actor"] };
      req: { param: (k: string) => string; json: () => Promise<unknown> };
      json: (body: unknown, status?: number) => Response;
    }) => {
      const id = c.req.param("id");
      const existing = await instancesStore.getRow(c.var.actor.id, id);
      if (!existing) throw new LocalAgentError("没有这个智能体实例。", 404);
      assertServerAdminIfNeeded(c.var.actor, existing.environment_id);
      const patch = instancePatchSchema.parse(await c.req.json());
      const updated = await instancesStore.updateInstance(
        c.var.actor.id,
        id,
        patch,
      );
      if (!updated) throw new LocalAgentError("没有这个智能体实例。", 404);
      return c.json({ instance: updated });
    };

    app.put("/instances/:id", (c) => updateHandler(c as never));
    app.patch("/instances/:id", (c) => updateHandler(c as never));

    app.delete("/instances/:id", async (c) => {
      const id = c.req.param("id");
      const existing = await instancesStore.getRow(c.var.actor.id, id);
      if (!existing) throw new LocalAgentError("没有这个智能体实例。", 404);
      assertServerAdminIfNeeded(c.var.actor, existing.environment_id);
      await instancesStore.deleteInstance(c.var.actor.id, id);
      return c.json({ deleted: true });
    });

    app.post("/instances/:id/probe", async (c) => {
      const instance = await probeInstance(c.var.actor.id, c.req.param("id"));
      return c.json({ instance });
    });

    app.get("/bots/:botId/grants", async (c) => {
      await ensureServerSeedsForOwner(c.var.actor.id);
      const botId = c.req.param("botId");
      const [grant, instances] = await Promise.all([
        instancesStore.getBotGrant(c.var.actor.id, botId),
        instancesStore.listInstances(c.var.actor.id),
      ]);
      return c.json({ grant, instances });
    });

    app.put("/bots/:botId/grants", async (c) => {
      const botId = c.req.param("botId");
      const patch = botGrantPatchSchema.parse(await c.req.json());
      const grant = await instancesStore.saveBotGrant(
        c.var.actor.id,
        botId,
        patch,
      );
      return c.json({ grant });
    });

    app.get("/devices/:id", async (c) => {
      const device = await ownDevice(c.var.actor.id, c.req.param("id"));
      const settings = await settingsFor(device.id);
      return c.json({
        settings,
        effectiveRoots: effectiveRoots(settings, device.allowedRoots),
        online: isEnvironmentOnline(device.id),
        tasks: await forDevice(c.var.actor.id, device.id),
      });
    });
    app.put("/devices/:id", async (c) => {
      const devId = c.req.param("id");
      assertServerAdminIfNeeded(c.var.actor, devId);
      const patch = settingsPatch.parse(await c.req.json());
      const settings = await saveSettings(c.var.actor.id, devId, patch);
      return c.json({ settings });
    });
    app.post("/devices/:id/detect", async (c) => {
      const device = await ownDevice(c.var.actor.id, c.req.param("id"));
      return c.json({
        sent: sendToEnvironment(device.id, { type: "agent_detect" }),
      });
    });
    app.get("/threads/:threadId/tasks", async (c) =>
      c.json({
        tasks: await forThread(c.var.actor.id, c.req.param("threadId")),
      }),
    );
    app.get("/tasks/:id", async (c) =>
      c.json({
        task: view(await owned(c.var.actor.id, c.req.param("id")), true),
      }),
    );
    app.post("/tasks/:id/stop", async (c) =>
      c.json({ task: await stop(c.var.actor.id, c.req.param("id")) }),
    );
    app.post("/tasks/:id/apply", async (c) =>
      c.json({
        task: await applyChanges(c.var.actor.id, c.req.param("id"), false),
      }),
    );
    app.post("/tasks/:id/discard", async (c) =>
      c.json({
        task: await applyChanges(c.var.actor.id, c.req.param("id"), true),
      }),
    );
    return app;
  }

  return {
    ensure,
    recover,
    extension,
    instances: instancesStore,
    settingsFor,
    saveSettings,
    start,
    runSubagent,
    stop,
    applyChanges,
    forThread,
    forDevice,
    forgetDevice,
    listEnvironments,
    probeInstance,
    probeEnvironment,
    tools,
    routes,
    handleNodeMessage,
  };
}
