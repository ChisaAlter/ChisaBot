import { createHash, randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  CONFIRM_CATEGORIES,
  CONFIRM_CATEGORY_INFO,
  CONFIRM_MODE_LABEL,
  CONFIRM_RESUME_MARKER,
  type ConfirmCategory,
  type ConfirmDetail,
  type ConfirmMode,
  type ConfirmPrefView,
  type ConfirmRequestView,
  type ConfirmRuleView,
  type ConfirmStatus,
} from "../../../shared/confirmations";
import { type AuditInitiator, type AuditStore, recordAuditEvent } from "../audit";
import { BOT_PERMISSION_INFO, BOT_PERMISSION_MODES, type BotPermissionMode, type BotPermissionView } from "../../../shared/bot-permission";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import type { DeviceConfirmLink } from "../devices/hub";
import { type GrantedTool, REFUSAL_MARKER } from "../plugins/tools";
import { categoryOfPageAction, categoryOfTool, decideMode, detailsFromArgs, flattenForMatch, titleForTool } from "./classify";
import { currentConfirmActor, currentConfirmInteractive, currentConfirmToolCall, currentConfirmTurn, currentToolAbort, TOOL_STOPPED_ZH, withConfirmInteractive } from "./context";

/**
 * 确认卡片 + 审批偏好（DESIGN.md §58，docs/confirmations.md）。
 *
 * 表（开机建，回滚安全，什么都不删）：
 * - chisabot_confirm_prefs：每类一行「先问我 / 直接做」+ 用户原话；
 * - chisabot_confirm_rules：用户自己的话写的规则（带关键词才由服务器强制，全部命中才算）；
 * - chisabot_confirm_requests：每一张确认卡片。状态 pending → approved / denied / expired / cancelled。
 *
 * 工具在服务器上等卡片的结果（最多 10 分钟，和保险箱卡片一样），所以确认后这一轮直接接着做；
 * 刷新页面、换设备都看得到同一张卡（状态在数据库里）。工具已经不等了（超时、服务重启）之后才确认的，
 * 服务器往对话里发一条「用户确认了」叫机器人接着做，重试同一个工具时凭这次确认放行一次。
 */
const WAIT_MS = 10 * 60_000;
const POLL_MS = 700;
const CARD_TTL_HOURS = 24;
/** 后来才确认的，多久之内重试同一个操作算数。 */
const GRANT_MS = 30 * 60_000;
/** 在网页上确认了付款之后，同一段对话里多久之内云端浏览器的操作不再被上游安全规则拦下。 */
const PURCHASE_WINDOW_MS = 20 * 60_000;
/** 机器人先用 confirm_action 问过（发消息 / 删除）之后，这段对话里多久之内网页上点「发送 / 删除」不再问第二遍。 */
const PAGE_ACTION_WINDOW_MS = 10 * 60_000;

export const DECLINED =
  "用户在确认卡片上点了「取消」，这一步没有执行。这是用户自己的决定，不是系统限制；不要换别的办法再试，除非用户再开口。如实告诉用户你没做。";
export const TIMED_OUT =
  "等了 10 分钟用户没有在确认卡片上回应，这一步没有执行。卡片还留着：用户之后点「确认」，会自动叫你接着做。一句话告诉用户在等他确认。";
export const STOPPED = "用户停止了这一轮，确认卡片已关闭，这一步没有执行。";
export const NOT_INTERACTIVE = (label: string) =>
  `这一步属于「${label}」，用户的审批偏好是「先问我」，但这一轮不在网页聊天里，弹不出确认卡片，所以没有执行。告诉用户：在 ChisaBot 网页聊天里让你再做一次（会出确认卡片），或在 设置 → 权限与审批 把这一类改成「直接做」。`;

/**
 * 定时任务等「用户不在场」的回合（DESIGN.md §101）：以前直接拒绝，定时任务里要发消息的那一步永远做不成
 * （2026-10-17 生产：「和 Claude 聊电车」每 3 小时跑一次，次次都停在「弹不出确认卡片」）。现在照样放一张
 * 确认卡片（聊天里和「待处理」都看得到，24 小时有效），这一轮不等；用户之后点「确认」，服务器叫机器人接着做。
 */
export const DEFERRED = (label: string) =>
  `这一步属于「${label}」，要先经用户确认。这一轮是定时任务 / 后台触发，用户不在场，所以没有等：已经在聊天和「待处理」里放了一张确认卡片（24 小时内有效）。用户点「确认」后会自动叫你接着做。现在不要换别的办法去做这一步；一两句话告诉用户你准备做什么、在等他确认。`;

type PrefRow = { category: ConfirmCategory; mode: ConfirmMode; note: string | null; updated_at: Date | string };
type RuleRow = {
  id: string;
  owner_user_id: string;
  text: string;
  category: ConfirmCategory;
  mode: ConfirmMode;
  keywords: unknown;
  source: "user" | "bot";
  agent_id: string | null;
  created_at: Date | string;
};
type RequestRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  thread_id: string | null;
  tool_call_id: string | null;
  category: ConfirmCategory;
  tool: string;
  title: string;
  target: string | null;
  details: unknown;
  digest: string;
  status: ConfirmStatus;
  decided_via: ConfirmRequestView["decidedVia"];
  external: string | null;
  consumed_at: Date | string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
  expires_at: Date | string;
};

export class ConfirmError extends Error {}
const iso = (value: Date | string) => new Date(value).toISOString();
const jsonList = (value: unknown): unknown[] => {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v : [];
};
const ruleView = (row: RuleRow): ConfirmRuleView => ({
  id: row.id,
  text: row.text,
  category: row.category,
  mode: row.mode,
  keywords: jsonList(row.keywords).filter((k): k is string => typeof k === "string"),
  source: row.source,
  agentId: row.agent_id,
  createdAt: iso(row.created_at),
});
const requestView = (row: RequestRow): ConfirmRequestView => ({
  id: row.id,
  agentId: row.agent_id,
  threadId: row.thread_id,
  toolCallId: row.tool_call_id,
  category: row.category,
  tool: row.tool,
  title: row.title,
  target: row.target,
  details: jsonList(row.details).filter((d): d is ConfirmDetail => !!d && typeof d === "object" && "label" in d && "value" in d),
  status: row.status === "pending" && new Date(row.expires_at).getTime() < Date.now() ? "expired" : row.status,
  decidedVia: row.decided_via,
  createdAt: iso(row.created_at),
  decidedAt: row.decided_at ? iso(row.decided_at) : null,
  expiresAt: iso(row.expires_at),
});

function stable(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => stable(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry, depth + 1)]),
  );
}
export const digestOf = (tool: string, args: unknown) =>
  createHash("sha256").update(JSON.stringify([tool, stable(args)])).digest("hex").slice(0, 32);

/** 网页聊天以外的回合（IM、长期任务、面板刷新、后台任务）弹不出卡片；「confirm:」是用户刚在网页上确认后接着做的那一轮。 */
export function interactiveInitiator(initiator: AuditInitiator | undefined) {
  if (!initiator || initiator.kind !== "routine") return true;
  return initiator.id.startsWith("confirm:");
}

export type ConfirmCheck = {
  ownerUserId: string;
  agentId: string;
  category: ConfirmCategory;
  tool: string;
  title: string;
  target?: string | null;
  details?: ConfirmDetail[];
  /** 规则匹配用的文字（工具名 + 参数）。 */
  matchText: string;
  /** 后来才确认时，重试要对得上的「同一个操作」。 */
  digest: string;
  initiator?: AuditInitiator;
};
export type ConfirmOutcome = { ok: true; via: "preference" | "rule" | "grant" | "confirmed" | "bot" } | { ok: false; message: string };

export type ConfirmResume = (input: {
  ownerUserId: string;
  agentId: string;
  threadId: string;
  requestId: string;
  text: string;
}) => Promise<void>;

export type DeviceConfirmHook = DeviceConfirmLink;

/** 设备「询问」能力这一次怎么处理：auto = 按审批偏好直接做；full = 机器人完全访问（连允许文件夹以外也直接加）；ask = 问。 */
export type DeviceDecision = "auto" | "ask" | "full";

/** 机器人权限（输入框的「请求批准 / 完全访问」）：这个人能不能改这个机器人。由 index.ts 接上机器人资料（看得到 = 能改自己的那份）。 */
export type BotAccess = (actor: { id: string; role?: string }, agentId: string) => Promise<boolean>;

export class BotPermissionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

export function createConfirmations(database: Database, options: { auditStore?: AuditStore } = {}) {
  const sql = database.$client;
  let botAccess: BotAccess | undefined;
  /** 这个进程里正在等结果的卡片（工具还在等）。不在这里的 = 工具已经不等了，确认要走「接着做」。 */
  const waiting = new Set<string>();
  const wake = new Map<string, () => void>();
  let resume: ConfirmResume | undefined;
  let deviceDecide: ((approvalId: string, approved: boolean) => boolean) | undefined;

  async function ensure() {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_confirm_prefs (
      owner_user_id text NOT NULL, category text NOT NULL, mode text NOT NULL,
      note text, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_user_id, category)
    )`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_confirm_rules (
      id text PRIMARY KEY, owner_user_id text NOT NULL, text text NOT NULL, category text NOT NULL,
      mode text NOT NULL, keywords jsonb NOT NULL DEFAULT '[]'::jsonb, source text NOT NULL DEFAULT 'user',
      agent_id text, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await sql.unsafe("CREATE INDEX IF NOT EXISTS chisabot_confirm_rules_owner ON chisabot_confirm_rules(owner_user_id, created_at)");
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_confirm_requests (
      id text PRIMARY KEY, owner_user_id text NOT NULL, agent_id text NOT NULL,
      thread_id text, tool_call_id text, category text NOT NULL, tool text NOT NULL,
      title text NOT NULL, target text, details jsonb NOT NULL DEFAULT '[]'::jsonb, digest text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'pending', decided_via text, external text, consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(), decided_at timestamptz,
      expires_at timestamptz NOT NULL
    )`);
    await sql.unsafe("CREATE INDEX IF NOT EXISTS chisabot_confirm_requests_thread ON chisabot_confirm_requests(owner_user_id, thread_id, created_at)");
    await sql.unsafe("CREATE INDEX IF NOT EXISTS chisabot_confirm_requests_owner ON chisabot_confirm_requests(owner_user_id, created_at)");
    await sql.unsafe("CREATE INDEX IF NOT EXISTS chisabot_confirm_requests_external ON chisabot_confirm_requests(external) WHERE external IS NOT NULL");
    // 机器人权限（§97）：每人每个机器人一行，只加表，回滚安全（旧镜像不读它 = 回到审批偏好）。
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS chisabot_bot_permissions (
      owner_user_id text NOT NULL, agent_id text NOT NULL, mode text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by text,
      PRIMARY KEY (owner_user_id, agent_id)
    )`);
  }

  // ── 机器人权限（请求批准 / 完全访问）─────────────────────────────
  async function storedBotMode(owner: string, agentId: string): Promise<{ mode: BotPermissionMode; updatedAt: string } | null> {
    if (!agentId) return null;
    const rows = await sql.unsafe<{ mode: string; updated_at: Date | string }[]>(
      "SELECT mode, updated_at FROM chisabot_bot_permissions WHERE owner_user_id = $1 AND agent_id = $2",
      [owner, agentId],
    );
    const row = rows[0];
    if (!row || !(BOT_PERMISSION_MODES as readonly string[]).includes(row.mode)) return null;
    return { mode: row.mode as BotPermissionMode, updatedAt: iso(row.updated_at) };
  }
  async function botPermission(owner: string, agentId: string): Promise<BotPermissionView> {
    const stored = await storedBotMode(owner, agentId);
    if (stored) return { agentId, mode: stored.mode, stored: stored.mode, updatedAt: stored.updatedAt };
    const pref = (await prefRows(owner)).find((p) => p.category === "device")?.mode;
    return { agentId, mode: pref === "auto" ? "full" : "ask", stored: null, updatedAt: null };
  }
  async function botPermissions(owner: string): Promise<BotPermissionView[]> {
    const rows = await sql.unsafe<{ agent_id: string; mode: string; updated_at: Date | string }[]>(
      "SELECT agent_id, mode, updated_at FROM chisabot_bot_permissions WHERE owner_user_id = $1 ORDER BY updated_at DESC LIMIT 500",
      [owner],
    );
    return rows
      .filter((row) => (BOT_PERMISSION_MODES as readonly string[]).includes(row.mode))
      .map((row) => ({ agentId: row.agent_id, mode: row.mode as BotPermissionMode, stored: row.mode as BotPermissionMode, updatedAt: iso(row.updated_at) }));
  }
  async function setBotPermission(
    actor: { id: string; role?: string },
    agentId: string,
    input: { mode: BotPermissionMode; acknowledged?: boolean },
  ): Promise<BotPermissionView> {
    if (!(BOT_PERMISSION_MODES as readonly string[]).includes(input.mode)) throw new BotPermissionError("没有这个档位。");
    if (!botAccess || !(await botAccess(actor, agentId).catch(() => false))) throw new BotPermissionError("找不到这个机器人。", 404);
    // 打开完全访问必须是用户在网页上的确认框里点过「开启」（不靠前端自觉）。
    if (input.mode === "full" && input.acknowledged !== true) throw new BotPermissionError("打开完全访问需要先确认。");
    const before = await botPermission(actor.id, agentId);
    await sql.unsafe(
      `INSERT INTO chisabot_bot_permissions (owner_user_id, agent_id, mode, updated_at, updated_by) VALUES ($1, $2, $3, now(), $1)
       ON CONFLICT (owner_user_id, agent_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [actor.id, agentId, input.mode],
    );
    const after = await botPermission(actor.id, agentId);
    if (options.auditStore && (before.mode !== after.mode || before.stored !== after.stored)) {
      await recordAuditEvent(options.auditStore, {
        eventType: "configuration.changed",
        targetType: "bot",
        targetId: agentId,
        actorUserId: actor.id,
        payload: {
          change: "bot_permission",
          from: before.stored ?? `inherit:${before.mode}`,
          to: after.mode,
          summary: `机器人权限：${BOT_PERMISSION_INFO[before.mode].label}${before.stored ? "" : "（沿用审批偏好）"} → ${BOT_PERMISSION_INFO[after.mode].label}`,
        },
      }).catch((error) => console.warn(JSON.stringify({ type: "bot-permission-audit-failed", reason: error instanceof Error ? error.message : String(error) })));
    }
    return after;
  }
  /**
   * 设备「询问」的事这一次怎么办（hub 的 before 和 confirm_action 的 device 类都走这里）：
   * - 机器人设成完全访问 → full（用户写的带关键词的「先问我」规则仍然算）；
   * - 机器人设成请求批准 → ask（始终问，审批偏好里的「直接做」不再放行这个机器人）；
   * - 没设过 → 审批偏好（旧行为）。
   */
  async function deviceDecision(owner: string, agentId: string, text: string): Promise<DeviceDecision> {
    const stored = await storedBotMode(owner, agentId);
    if (stored?.mode === "ask") return "ask";
    if (stored?.mode === "full") {
      const decision = decideMode({ category: "device", text, pref: "auto", rules: (await rules(owner)).filter((r) => r.mode === "ask") });
      return decision.mode === "ask" && decision.source === "rule" ? "ask" : "full";
    }
    return (await modeFor(owner, "device", text)).mode;
  }

  // ── 偏好与规则 ─────────────────────────────────────────────
  async function prefRows(owner: string) {
    return sql.unsafe<PrefRow[]>("SELECT category, mode, note, updated_at FROM chisabot_confirm_prefs WHERE owner_user_id = $1", [owner]);
  }
  async function prefs(owner: string): Promise<ConfirmPrefView[]> {
    const rows = await prefRows(owner);
    return CONFIRM_CATEGORIES.map((category) => {
      const info = CONFIRM_CATEGORY_INFO[category];
      const row = rows.find((r) => r.category === category);
      return {
        category,
        label: info.label,
        description: info.description,
        mode: info.locked ? "ask" : (row?.mode ?? "ask"),
        locked: Boolean(info.locked),
        note: row?.note ?? null,
        updatedAt: row ? iso(row.updated_at) : null,
      };
    });
  }
  async function setPref(owner: string, category: ConfirmCategory, mode: ConfirmMode, note?: string | null) {
    if (!CONFIRM_CATEGORIES.includes(category)) throw new ConfirmError("没有这一类。");
    if (CONFIRM_CATEGORY_INFO[category].locked && mode === "auto")
      throw new ConfirmError("付款购买一律先问你（安全底线），不能改成直接做。");
    await sql.unsafe(
      `INSERT INTO chisabot_confirm_prefs (owner_user_id, category, mode, note, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (owner_user_id, category) DO UPDATE SET mode = EXCLUDED.mode, note = EXCLUDED.note, updated_at = now()`,
      [owner, category, mode, note?.trim() || null],
    );
    return (await prefs(owner)).find((p) => p.category === category)!;
  }
  async function rules(owner: string): Promise<ConfirmRuleView[]> {
    const rows = await sql.unsafe<RuleRow[]>("SELECT * FROM chisabot_confirm_rules WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT 200", [owner]);
    return rows.map(ruleView);
  }
  const ruleInput = z
    .object({
      text: z.string().trim().min(1, "写一句规则").max(300, "规则最长 300 字"),
      category: z.enum(CONFIRM_CATEGORIES),
      mode: z.enum(["ask", "auto"]),
      keywords: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
    })
    .strict();
  async function addRule(owner: string, input: z.input<typeof ruleInput>, by: { source: "user" | "bot"; agentId?: string | null } = { source: "user" }) {
    const parsed = ruleInput.parse(input);
    if (CONFIRM_CATEGORY_INFO[parsed.category].locked && parsed.mode === "auto")
      throw new ConfirmError("付款购买一律先问你（安全底线），不能设成直接做。");
    const keywords = [...new Set((parsed.keywords ?? []).map((k) => k.trim()).filter(Boolean))];
    const count = await sql.unsafe<{ n: number }[]>("SELECT count(*)::int AS n FROM chisabot_confirm_rules WHERE owner_user_id = $1", [owner]);
    if ((count[0]?.n ?? 0) >= 200) throw new ConfirmError("规则最多 200 条，先删掉几条不用的。");
    // 同一类、同一组关键词只留一条（新的说法盖掉旧的）。
    const same = (await rules(owner)).filter(
      (r) => r.category === parsed.category && r.keywords.length === keywords.length && r.keywords.every((k) => keywords.includes(k)),
    );
    if (keywords.length) for (const old of same) await sql.unsafe("DELETE FROM chisabot_confirm_rules WHERE owner_user_id = $1 AND id = $2", [owner, old.id]);
    const id = `cr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const rows = await sql.unsafe<RuleRow[]>(
      "INSERT INTO chisabot_confirm_rules (id, owner_user_id, text, category, mode, keywords, source, agent_id) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING *",
      [id, owner, parsed.text, parsed.category, parsed.mode, JSON.stringify(keywords), by.source, by.agentId ?? null],
    );
    return ruleView(rows[0]!);
  }
  async function removeRule(owner: string, id: string) {
    const rows = await sql.unsafe("DELETE FROM chisabot_confirm_rules WHERE owner_user_id = $1 AND id = $2 RETURNING id", [owner, id]);
    return rows.length > 0;
  }
  async function modeFor(owner: string, category: ConfirmCategory, text: string) {
    const [prefList, ruleList] = await Promise.all([prefRows(owner), rules(owner)]);
    return decideMode({ category, text, pref: prefList.find((p) => p.category === category)?.mode, rules: ruleList });
  }

  // ── 卡片 ─────────────────────────────────────────────
  async function requestById(owner: string, id: string) {
    const rows = await sql.unsafe<RequestRow[]>("SELECT * FROM chisabot_confirm_requests WHERE owner_user_id = $1 AND id = $2", [owner, id]);
    return rows[0];
  }
  async function insertRequest(input: {
    ownerUserId: string;
    agentId: string;
    threadId: string | null;
    toolCallId: string | null;
    category: ConfirmCategory;
    tool: string;
    title: string;
    target?: string | null;
    details?: ConfirmDetail[];
    digest?: string;
    external?: string | null;
    expiresAt?: Date;
  }) {
    const id = `cf_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const expires = input.expiresAt ?? new Date(Date.now() + CARD_TTL_HOURS * 3_600_000);
    const rows = await sql.unsafe<RequestRow[]>(
      `INSERT INTO chisabot_confirm_requests (id, owner_user_id, agent_id, thread_id, tool_call_id, category, tool, title, target, details, digest, external, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13) RETURNING *`,
      [
        id,
        input.ownerUserId,
        input.agentId,
        input.threadId,
        input.toolCallId,
        input.category,
        input.tool,
        input.title.slice(0, 200),
        input.target?.slice(0, 300) ?? null,
        JSON.stringify((input.details ?? []).slice(0, 8)),
        input.digest ?? "",
        input.external ?? null,
        expires.toISOString(),
      ],
    );
    return rows[0]!;
  }
  async function setStatus(id: string, from: ConfirmStatus[], status: ConfirmStatus, via: ConfirmRequestView["decidedVia"] = null) {
    const rows = await sql.unsafe<RequestRow[]>(
      `UPDATE chisabot_confirm_requests SET status = $2, decided_via = coalesce($3, decided_via), decided_at = coalesce(decided_at, now())
       WHERE id = $1 AND status IN (${from.map((value) => `'${value.replace(/[^a-z]/g, "")}'`).join(", ")}) RETURNING *`,
      [id, status, via],
    );
    return rows[0];
  }

  /** 工具在服务器上等卡片的结果。 */
  async function waitFor(id: string, stopped: () => boolean): Promise<ConfirmStatus | "timeout"> {
    waiting.add(id);
    try {
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_MS);
          wake.set(id, () => {
            clearTimeout(timer);
            resolve();
          });
        });
        wake.delete(id);
        const rows = await sql.unsafe<{ status: ConfirmStatus }[]>("SELECT status FROM chisabot_confirm_requests WHERE id = $1", [id]);
        const status = rows[0]?.status;
        if (!status) return "cancelled";
        if (status !== "pending") return status;
        if (stopped() || currentToolAbort()?.aborted) {
          await setStatus(id, ["pending"], "cancelled");
          return "cancelled";
        }
      }
      return "timeout";
    } finally {
      waiting.delete(id);
      wake.delete(id);
    }
  }

  /** 后来才确认的那一次：同一段对话里重试同一个操作，放行一次。 */
  async function consumeGrant(owner: string, threadId: string, match: { digest?: string; category?: ConfirmCategory }) {
    const rows = await sql.unsafe<{ id: string }[]>(
      `UPDATE chisabot_confirm_requests SET consumed_at = now()
       WHERE id = (SELECT id FROM chisabot_confirm_requests WHERE owner_user_id = $1 AND thread_id = $2 AND status = 'approved'
         AND consumed_at IS NULL AND decided_at > now() - $5::int * interval '1 millisecond'
         AND (($3::text IS NOT NULL AND digest = $3) OR ($3::text IS NULL AND category = $4))
         ORDER BY decided_at DESC LIMIT 1)
       RETURNING id`,
      [owner, threadId, match.digest ?? null, match.category ?? null, GRANT_MS],
    );
    return rows.length > 0;
  }

  async function check(input: ConfirmCheck): Promise<ConfirmOutcome> {
    if (input.category === "device") {
      const device = await deviceDecision(input.ownerUserId, input.agentId, input.matchText);
      if (device === "full") return { ok: true, via: "bot" };
      if (device === "auto") return { ok: true, via: "preference" };
    } else {
      const decision = await modeFor(input.ownerUserId, input.category, input.matchText);
      if (decision.mode === "auto") return { ok: true, via: decision.source === "rule" ? "rule" : "preference" };
    }
    const turn = currentConfirmTurn();
    const call = currentConfirmToolCall();
    if (turn?.threadId && (await consumeGrant(input.ownerUserId, turn.threadId, { digest: input.digest }))) return { ok: true, via: "grant" };
    if (!turn?.threadId) return { ok: false, message: NOT_INTERACTIVE(CONFIRM_CATEGORY_INFO[input.category].label) };
    if (!interactiveInitiator(input.initiator)) {
      // 同一段对话里同一个工具还没人理的旧卡片作废（定时任务每次触发都会再放一张，只留最新的）。
      await sql.unsafe(
        `UPDATE chisabot_confirm_requests SET status = 'cancelled', decided_at = now()
         WHERE owner_user_id = $1 AND thread_id = $2 AND tool = $3 AND category = $4 AND status = 'pending' AND NOT (id = ANY(string_to_array($5::text, ',')))`,
        [input.ownerUserId, turn.threadId, input.tool, input.category, [...waiting].join(",")],
      );
      await insertRequest({
        ownerUserId: input.ownerUserId,
        agentId: input.agentId,
        threadId: turn.threadId,
        toolCallId: call?.toolCallId ?? null,
        category: input.category,
        tool: input.tool,
        title: input.title,
        target: input.target ?? null,
        details: input.details ?? [],
        digest: input.digest,
      });
      return { ok: false, message: DEFERRED(CONFIRM_CATEGORY_INFO[input.category].label) };
    }
    const row = await insertRequest({
      ownerUserId: input.ownerUserId,
      agentId: input.agentId,
      threadId: turn.threadId,
      toolCallId: call?.toolCallId ?? null,
      category: input.category,
      tool: input.tool,
      title: input.title,
      target: input.target ?? null,
      details: input.details ?? [],
      digest: input.digest,
    });
    const status = await waitFor(row.id, turn.stopped);
    if (status === "approved") {
      await sql.unsafe("UPDATE chisabot_confirm_requests SET consumed_at = now() WHERE id = $1", [row.id]);
      return { ok: true, via: "confirmed" };
    }
    if (status === "denied") return { ok: false, message: DECLINED };
    if (status === "timeout") return { ok: false, message: TIMED_OUT };
    return { ok: false, message: STOPPED };
  }

  async function decide(owner: string, id: string, decision: "approve" | "deny", via: "web" | "device" = "web") {
    const row = await requestById(owner, id);
    if (!row) throw new ConfirmError("找不到这张确认卡片。");
    if (row.status !== "pending") return requestView(row);
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await setStatus(id, ["pending"], "expired");
      throw new ConfirmError("这张确认卡片已经过期了，操作没有执行。");
    }
    // 电脑上的「询问」：交给设备 hub 决定（它会回调 closed 更新这一行）。
    if (row.external?.startsWith("device:")) {
      const ok = deviceDecide?.(row.external.slice("device:".length), decision === "approve") ?? false;
      if (!ok) {
        await setStatus(id, ["pending"], "expired");
        throw new ConfirmError("电脑上的这次请求已经结束了（超时或电脑离线）。");
      }
      return requestView((await requestById(owner, id)) ?? row);
    }
    const updated = await setStatus(id, ["pending"], decision === "approve" ? "approved" : "denied", via);
    if (!updated) return requestView((await requestById(owner, id)) ?? row);
    wake.get(id)?.();
    // 工具已经不等了：叫机器人接着做（重试同一个工具时凭这次确认放行一次）。
    if (decision === "approve" && !waiting.has(id) && updated.thread_id && resume) {
      const text = `${CONFIRM_RESUME_MARKER}${id}⟧\n用户确认了「${updated.title}」${updated.target ? `（${updated.target}）` : ""}。刚才那一步因为等确认停下了，现在接着做：再调用一次同样的工具、用同样的参数，这次不会再问。做完照常告诉用户结果。`;
      void resume({ ownerUserId: owner, agentId: updated.agent_id, threadId: updated.thread_id, requestId: id, text }).catch((error) =>
        console.warn(JSON.stringify({ type: "confirm-resume-failed", id, reason: error instanceof Error ? error.message : String(error) })),
      );
    }
    return requestView(updated);
  }

  async function list(owner: string, options: { threadId?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = options.threadId
      ? await sql.unsafe<RequestRow[]>(
          "SELECT * FROM chisabot_confirm_requests WHERE owner_user_id = $1 AND thread_id = $2 ORDER BY created_at DESC LIMIT $3",
          [owner, options.threadId, limit],
        )
      : await sql.unsafe<RequestRow[]>("SELECT * FROM chisabot_confirm_requests WHERE owner_user_id = $1 ORDER BY created_at DESC LIMIT $2", [owner, limit]);
    return rows.map(requestView);
  }

  /** 在网页上确认过付款（confirm_action 类别 purchase）之后，这段对话里一段时间内云端浏览器的操作直接放行。 */
  async function purchaseConfirmed(owner: string, threadId: string) {
    const rows = await sql.unsafe(
      `SELECT 1 FROM chisabot_confirm_requests WHERE owner_user_id = $1 AND thread_id = $2 AND category = 'purchase'
       AND status = 'approved' AND decided_at > now() - $3::int * interval '1 millisecond' LIMIT 1`,
      [owner, threadId, PURCHASE_WINDOW_MS],
    );
    return rows.length > 0;
  }

  /** 这段对话里最近确认过这一类（发消息 / 删除）的卡片——网页上接着点「发送 / 删除」就不再问。 */
  async function categoryConfirmed(owner: string, threadId: string, category: ConfirmCategory, windowMs: number) {
    const rows = await sql.unsafe(
      `SELECT 1 FROM chisabot_confirm_requests WHERE owner_user_id = $1 AND thread_id = $2 AND category = $3
       AND status = 'approved' AND decided_at > now() - $4::int * interval '1 millisecond' LIMIT 1`,
      [owner, threadId, category, windowMs],
    );
    return rows.length > 0;
  }

  /**
   * 云端浏览器里点按钮之前（index.ts 的 confirmAwareGate 调）：按钮是「发送 / 发布 / 回复」「删除 / 移到回收站」
   * 这类，而机器人这段对话里没先用 confirm_action 问过，就由服务器自己出卡片——不靠模型记得先问。
   * 返回 null = 不是这类按钮，照常走上游的规则。
   */
  async function pageAction(input: { ownerUserId: string; agentId: string; threadId?: string | null; element?: { role?: string; name?: string } | null; pageUrl?: string | null }): Promise<ConfirmOutcome | null> {
    const category = categoryOfPageAction(input.element);
    if (!category) return null;
    const threadId = input.threadId ?? currentConfirmTurn()?.threadId ?? null;
    if (threadId && (await categoryConfirmed(input.ownerUserId, threadId, category, PAGE_ACTION_WINDOW_MS))) return { ok: true, via: "grant" };
    const label = input.element?.name?.trim() ?? "";
    let host = "";
    try {
      host = input.pageUrl ? new URL(input.pageUrl).host : "";
    } catch {}
    const initiator = currentConfirmActor()?.initiator;
    return check({
      ownerUserId: input.ownerUserId,
      agentId: input.agentId,
      category,
      tool: "computer_click",
      title: `在网页上点「${label}」${category === "message" ? "（会发出去）" : "（会删除）"}`,
      target: host || null,
      details: input.pageUrl ? [{ label: "网页", value: input.pageUrl.slice(0, 600), code: true }] : [],
      matchText: [label, host, input.pageUrl ?? ""].join(" "),
      digest: digestOf("computer_click", { category, host, label }),
      ...(initiator ? { initiator } : {}),
    });
  }

  // ── 设备 hub 挂钩 ─────────────────────────────────────────────
  const deviceHook: DeviceConfirmHook = {
    linkable: () => Boolean(currentConfirmTurn()?.threadId) && currentConfirmInteractive(),
    async before(input) {
      return deviceDecision(input.ownerUserId, input.botId, [input.operation, input.operationLabel, input.summary, flattenForMatch(input.args)].join(" "));
    },
    async opened(input) {
      const turn = currentConfirmTurn();
      const call = currentConfirmToolCall();
      if (!turn?.threadId) return; // 网页聊天以外：只有电脑上的弹窗。
      await insertRequest({
        ownerUserId: input.ownerUserId,
        agentId: input.botId,
        threadId: turn.threadId,
        toolCallId: call?.toolCallId ?? null,
        category: "device",
        tool: call?.toolName ?? "device",
        title: `在你的电脑上${input.operationLabel}`,
        target: input.deviceName,
        details: [
          { label: "要做的事", value: input.summary.slice(0, 600), code: /命令|shell|路径/.test(input.operationLabel) },
          ...(input.diff ? [{ label: "改动", value: input.diff.slice(0, 8000), code: true, diff: true }] : []),
        ],
        external: `device:${input.approvalId}`,
        expiresAt: new Date(input.expiresAt),
      });
    },
    async closed(approvalId, decision, by) {
      await sql.unsafe(
        `UPDATE chisabot_confirm_requests SET status = $2, decided_via = $3, decided_at = now()
         WHERE external = $1 AND status = 'pending'`,
        [`device:${approvalId}`, decision === "approve" ? "approved" : decision === "deny" ? "denied" : "expired", decision === "expired" ? null : by === "device" ? "device" : "web"],
      );
    },
  };

  // ── 机器人工具 ─────────────────────────────────────────────
  const detailSchema = z.object({ label: z.string().max(20), value: z.string().max(800) }).strict();
  function tools(owner: string, agentId: string, initiator?: AuditInitiator): GrantedTool[] {
    const tool = (name: string, description: string, parameters: z.ZodType, run: (args: never) => Promise<string>): GrantedTool => ({
      name,
      ref: `confirmations/${name}`,
      description,
      parameters,
      ...(initiator ? { initiator } : {}),
      execute: async (args: unknown) => {
        const parsed = parameters.safeParse(args);
        if (!parsed.success) return `${REFUSAL_MARKER} ${name} 参数不对：${parsed.error.issues[0]?.message ?? ""}`;
        try {
          return await run(parsed.data as never);
        } catch (error) {
          if (error instanceof ConfirmError) return `${REFUSAL_MARKER} ${error.message}`;
          if (error instanceof z.ZodError) return `${REFUSAL_MARKER} ${error.issues[0]?.message ?? "参数不对。"}`;
          throw error;
        }
      },
    });
    return [
      tool(
        "confirm_action",
        "做一件有后果的事之前、而这件事不是用会自动弹确认卡的工具完成时（例如在浏览器里下单付款、在网页上替用户发消息 / 发帖 / 发邮件、在网页上删除东西），先调用它：按用户的审批偏好，要么直接放行，要么在聊天里出一张确认卡片，工具会等用户点「确认 / 取消」再返回。付款一律要问。返回「已确认」才能做；返回「取消」就不要做。不要在聊天里再用文字问一遍。",
        z
          .object({
            category: z.enum(CONFIRM_CATEGORIES).describe("message=对外发消息 delete=删除 purchase=付款购买 device=操作用户的电脑"),
            title: z.string().min(1).max(80).describe("要做什么，一句话，如「在京东下单：AirPods Pro 2」"),
            target: z.string().max(120).optional().describe("对象：发给谁 / 删哪个 / 哪个网站 / 哪台电脑"),
            details: z.array(detailSchema).max(6).optional().describe("细节行，如 [{label:\"金额\",value:\"¥1,899\"},{label:\"收货地址\",value:\"…\"}]"),
          })
          .strict(),
        async (input: { category: ConfirmCategory; title: string; target?: string; details?: ConfirmDetail[] }) => {
          const outcome = await check({
            ownerUserId: owner,
            agentId,
            category: input.category,
            tool: "confirm_action",
            title: input.title,
            target: input.target ?? null,
            details: input.details ?? [],
            matchText: [input.title, input.target ?? "", flattenForMatch(input.details)].join(" "),
            digest: digestOf("confirm_action", { category: input.category, title: input.title, target: input.target ?? "" }),
            ...(initiator ? { initiator } : {}),
          });
          if (outcome.ok)
            return outcome.via === "confirmed" || outcome.via === "grant"
              ? `已确认：用户确认了「${input.title}」。现在去做，不用再问。`
              : outcome.via === "bot"
                ? "已确认：用户给你开了「完全访问」，操作电脑的事不用问，直接做。"
                : `已确认：按用户的审批偏好，「${CONFIRM_CATEGORY_INFO[input.category].label}」这类事不用问，直接做。`;
          return outcome.message;
        },
      ),
      tool(
        "approval_preference_save",
        "用户说「以后 X 不用问我 / 直接做」或「X 要先问我」时调用，把这条审批偏好记下来（之后所有机器人都照做）。text 用用户的原话。只针对某个人 / 某个对象的（如「给张三发微信不用问」）要给 keywords（如 [\"张三\"]，执行时参数里全部出现才算）；针对整一类的不给 keywords，等于改这一类的偏好。付款购买不能设成直接做。",
        z
          .object({
            text: z.string().min(1).max(300).describe("用户原话"),
            category: z.enum(CONFIRM_CATEGORIES),
            mode: z.enum(["ask", "auto"]).describe("ask=先问我 auto=直接做"),
            keywords: z.array(z.string().min(1).max(40)).max(8).optional(),
          })
          .strict(),
        async (input: { text: string; category: ConfirmCategory; mode: ConfirmMode; keywords?: string[] }) => {
          const label = CONFIRM_CATEGORY_INFO[input.category].label;
          if (!input.keywords?.length) {
            await setPref(owner, input.category, input.mode, input.text);
            return `记下了：「${label}」以后${CONFIRM_MODE_LABEL[input.mode]}（用户原话：${input.text}）。用户可以在 设置 → 权限与审批 改。一句话告诉用户。`;
          }
          const rule = await addRule(owner, input, { source: "bot", agentId });
          return `记下了规则：「${rule.text}」→ ${CONFIRM_MODE_LABEL[rule.mode]}（${label}，关键词：${rule.keywords.join("、")}）。用户可以在 设置 → 权限与审批 改或删。一句话告诉用户。`;
        },
      ),
    ];
  }

  /**
   * 把有后果的工具包一层：按偏好问或不问，问就出卡片、等确认，确认了才真的执行。
   * 设备工具不包（hub 在「询问」能力上问），ChisaBot 自己的记录类工具不包（classify.ts）。
   */
  function wrap(list: GrantedTool[], context: { ownerUserId: string; agentId: string; initiator?: AuditInitiator }): GrantedTool[] {
    const interactive = (tool: GrantedTool) => interactiveInitiator(tool.initiator ?? context.initiator);
    return list.map((tool) => {
      const category = categoryOfTool(tool.name, tool.ref);
      if (!category)
        return tool.name.startsWith("device_") ? { ...tool, execute: (args: unknown) => withConfirmInteractive(interactive(tool), () => tool.execute(args)) } : tool;
      return {
        ...tool,
        execute: async (args: unknown, ctx) => {
          if (currentConfirmTurn()?.stopped() || currentToolAbort()?.aborted) {
            return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
          }
          const outcome = await check({
            ownerUserId: context.ownerUserId,
            agentId: context.agentId,
            category,
            tool: tool.name,
            title: titleForTool(tool.name, category),
            target: null,
            details: detailsFromArgs(args),
            matchText: [tool.name, flattenForMatch(args)].join(" "),
            digest: digestOf(tool.name, args),
            initiator: tool.initiator ?? context.initiator,
          });
          if (!outcome.ok) return `${REFUSAL_MARKER} ${outcome.message}`;
          if (currentConfirmTurn()?.stopped() || currentToolAbort()?.aborted) {
            return `${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`;
          }
          return tool.execute(args, ctx);
        },
      };
    });
  }

  /** 每轮开头给机器人的：用法 + 这个人现在的偏好和规则（给了 agentId 就带上这个机器人的权限档位）。 */
  async function context(owner: string, agentId?: string) {
    const [prefList, ruleList, bot] = await Promise.all([prefs(owner), rules(owner), agentId ? storedBotMode(owner, agentId).catch(() => null) : null]);
    const lines = [
      "【审批偏好 · 确认卡片】做有后果的事（对外发消息、删除、付款购买、操作用户的电脑）时，系统按下面的偏好自动处理：「先问我」的，工具会在聊天里出一张确认卡片并等用户点「确认 / 取消」；「直接做」的不问。",
      "所以：直接调用要用的工具即可，不要先在聊天里用文字问「要我做吗」（卡片就是在问）；在浏览器里付款下单、在网页上替用户发消息 / 发帖 / 发邮件、删除网页上的东西这类不经过专门工具的事，**动手前第一步先调用 confirm_action**（它就是聊天里那张确认卡片，会等用户点完才返回）；用户让你调用 confirm_action 时也直接调用，不要先回文字。返回「已确认」再做；被取消就如实说没做，不要换办法绕过。",
      "用户说「以后 X 不用问我」或「X 要先问我」时，调用 approval_preference_save（text 用原话），然后一句话告诉用户记下了。付款购买一律先问，不能改。",
      `当前偏好：${prefList.map((p) => `${p.label}=${CONFIRM_MODE_LABEL[p.mode]}${p.locked ? "（固定）" : ""}`).join("；")}。`,
    ];
    if (bot?.mode === "full")
      lines.push("【你的权限：完全访问】用户在输入框里给你开了完全访问：在用户电脑上运行命令、读写文件这类「操作你的电脑」的事不再问，直接做（付款购买、对外发消息、删除照上面的偏好）。用户想收回时让他在输入框左下角改回「请求批准」。");
    else if (bot?.mode === "ask")
      lines.push("【你的权限：请求批准】用户把你设成了请求批准：在用户电脑上运行命令、改写文件、安装软件这类事，每次都会出确认卡片等用户点头（上面「操作你的电脑」的偏好对你不生效）。");
    if (ruleList.length)
      lines.push(
        `用户的规则（新的在前）：\n${ruleList
          .slice(0, 30)
          .map((r) => `- 「${r.text}」→ ${CONFIRM_MODE_LABEL[r.mode]}（${CONFIRM_CATEGORY_INFO[r.category].label}${r.keywords.length ? `，关键词 ${r.keywords.join("、")}` : ""}）`)
          .join("\n")}`,
      );
    return lines.join("\n");
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
    app.onError((error, c) => {
      if (error instanceof ConfirmError) return c.json({ error: error.message }, 400);
      if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? "参数不对。" }, 400);
      console.error(JSON.stringify({ type: "confirm-error", error: error.name, route: c.req.path }));
      return c.json({ error: "审批暂时不可用，请重试。" }, 503);
    });
    app.get("/prefs", async (c) => c.json({ prefs: await prefs(c.var.actor.id), rules: await rules(c.var.actor.id) }));
    // 机器人权限（输入框的「请求批准 / 完全访问」，§97）。
    app.get("/bot-permissions", async (c) => c.json({ permissions: await botPermissions(c.var.actor.id) }));
    app.get("/bots/:agentId/permission", async (c) => {
      const agentId = c.req.param("agentId");
      if (!botAccess || !(await botAccess(c.var.actor, agentId).catch(() => false))) return c.json({ error: "找不到这个机器人。" }, 404);
      c.header("Cache-Control", "no-store");
      return c.json({ permission: await botPermission(c.var.actor.id, agentId) });
    });
    app.put("/bots/:agentId/permission", async (c) => {
      const body = z.object({ mode: z.enum(BOT_PERMISSION_MODES), acknowledged: z.boolean().optional() }).strict().parse(await c.req.json());
      try {
        return c.json({ permission: await setBotPermission(c.var.actor, c.req.param("agentId"), body) });
      } catch (error) {
        if (error instanceof BotPermissionError) return c.json({ error: error.message }, error.status);
        throw error;
      }
    });
    app.put("/prefs/:category", async (c) => {
      const category = z.enum(CONFIRM_CATEGORIES).parse(c.req.param("category"));
      const body = z.object({ mode: z.enum(["ask", "auto"]), note: z.string().max(300).nullable().optional() }).strict().parse(await c.req.json());
      return c.json({ pref: await setPref(c.var.actor.id, category, body.mode, body.note ?? null) });
    });
    app.post("/rules", async (c) => c.json({ rule: await addRule(c.var.actor.id, await c.req.json()) }, 201));
    app.delete("/rules/:id", async (c) => ((await removeRule(c.var.actor.id, c.req.param("id"))) ? c.body(null, 204) : c.json({ error: "找不到这条规则。" }, 404)));
    app.get("/requests", async (c) => {
      const threadId = c.req.query("thread") || undefined;
      const limit = Number(c.req.query("limit") ?? "") || undefined;
      return c.json({ requests: await list(c.var.actor.id, { ...(threadId ? { threadId } : {}), ...(limit ? { limit } : {}) }) });
    });
    app.post("/requests/:id", async (c) => {
      const body = z.object({ decision: z.enum(["approve", "deny"]) }).strict().parse(await c.req.json());
      return c.json({ request: await decide(c.var.actor.id, c.req.param("id"), body.decision) });
    });
    return app;
  }

  return {
    ensure,
    prefs,
    setPref,
    rules,
    addRule,
    removeRule,
    modeFor,
    check,
    decide,
    list,
    purchaseConfirmed,
    pageAction,
    tools,
    wrap,
    context,
    routes,
    deviceHook,
    insertRequest,
    botPermission,
    botPermissions,
    setBotPermission,
    deviceDecision,
    setBotAccess(fn: BotAccess) {
      botAccess = fn;
    },
    setResume(fn: ConfirmResume) {
      resume = fn;
    },
    setDeviceDecider(fn: (approvalId: string, approved: boolean) => boolean) {
      deviceDecide = fn;
    },
  };
}
export type Confirmations = ReturnType<typeof createConfirmations>;
