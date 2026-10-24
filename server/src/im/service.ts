import type { Message } from "@ag-ui/client";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { IM_PLATFORMS, type ImConnectionView, type ImLogEntry, type ImPlatform, type ImStatus, imPlatform } from "../../../shared/im";
import type { AppVariables } from "../auth/guards";
import { upgradeWebSocket } from "../channels/socket";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import type { TurnRunner } from "../turns/types";
import { OneBotAdapter } from "./adapters/onebot";
import { WEIXIN_DEFAULT_BASE, weixinFetchQr, weixinQrStatus } from "./adapters/weixin";
import { createAdapter, testAdapter } from "./registry";
import { errorText, markdownToPlain, splitText } from "./text";
import type { AdapterContext, FetchLike, ImAdapter, ImAdapterStatus, ImInbound, ImLogLevel, WsFactory, WsLike } from "./types";

/**
 * IM 接入（DESIGN.md §49，docs/im.md）：每个人自己的「连接」，一个连接 = 一个平台账号 → 一个机器人。
 *
 * - 存库：chisabot_im_connections（凭据字段整体 AES-GCM 加密，和部署里其它密钥同一把钥匙）、
 *   chisabot_im_chats（平台会话 → 对话 id；「/new」换一条）、chisabot_im_logs（每个连接最近 300 行）。
 * - 运行：开机把启用的连接都连上（适配器自己断线重连、退避），收到消息 → 群里没 @ 就忽略 → 白名单 →
 *   按 (连接, 会话) 排队，一次跑一轮 → 机器人回合（无头回合，写进 im-… 对话）→ 回复切段发回去。
 * - 机器人在 IM 里以主人的身份运行，但拿不到网页才能显示的工具（render_ui、面板），电脑 / 设备类工具
 *   默认也不给（连接里打开「允许使用电脑和设备」才给），需要网页审批的步骤回一句去网页确认。
 */

export const IM_INITIATOR_PREFIX = "im:";
const CONNECTION_ID = /^im_[a-z0-9]{6,40}$/;
const MAX_QUEUE = 3;
const LOG_KEEP = 300;

type Row = {
  id: string;
  owner_user_id: string;
  platform: ImPlatform;
  name: string;
  agent_id: string;
  enabled: boolean;
  config: Record<string, string>;
  secrets: string | null;
  allow_users: string[];
  allow_devices: boolean;
  account: string | null;
  last_message_at: Date | null;
  last_error: string | null;
  created_at: Date;
};

type Live = { adapter: ImAdapter; status: ImAdapterStatus; ctx: AdapterContext };

export type ImServiceOptions = {
  database: Database;
  encryptionKey: string;
  runTurn: TurnRunner;
  /** 这个机器人是不是这个人能用的（自己的、没删）。 */
  botAvailable: (ownerUserId: string, agentId: string) => Promise<boolean>;
  /** 回合因为要网页审批而停下（HeadlessToolSuspension）。 */
  isSuspension?: (error: unknown) => boolean;
  /** IM 快捷审批：用户在 IM 里回复「允许 / 批准 / 拒绝」时，直接处理该用户挂起的确认卡片。 */
  resolveApproval?: (
    ownerUserId: string,
    threadId: string | null,
    decision: "approve" | "deny",
  ) => Promise<{ title: string; target?: string | null } | null>;
  fetch?: FetchLike;
  ws?: WsFactory;
};

export type ImService = ReturnType<typeof createImService>;

/** IM 回合的 initiator：`{kind:"routine", id:"im:<连接 id>"}`。 */
export function imConnectionOf(initiator: { kind: string; id?: string } | undefined | null): string | null {
  if (!initiator || initiator.kind !== "routine" || typeof initiator.id !== "string") return null;
  return initiator.id.startsWith(IM_INITIATOR_PREFIX) ? initiator.id.slice(IM_INITIATOR_PREFIX.length) : null;
}

const defaultWs: WsFactory = (url, options) =>
  // Bun 的 WebSocket 接受第二个参数里的 headers（浏览器没有）。
  new (WebSocket as unknown as new (url: string, options?: unknown) => WsLike)(url, options);

const newId = () => `im_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
const newToken = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);

/** 平台会话 → 线程键。 */
export function chatKey(inbound: Pick<ImInbound, "chatType" | "chatId">) {
  return `${inbound.chatType}:${inbound.chatId}`;
}

const NEW_TOPIC = new Set(["/new", "/reset", "新话题", "/新话题", "重新开始"]);
const IM_APPROVE_WORDS = new Set(["允许", "批准", "确认执行", "/approve", "/allow"]);
const IM_DENY_WORDS = new Set(["拒绝", "取消执行", "/deny", "/reject"]);

/** 给机器人看的那条用户消息：哪个平台、谁发的，然后是原文。 */
export function frameInbound(platformName: string, inbound: ImInbound): string {
  const where = inbound.chatType === "group" ? `${platformName}群聊` : `${platformName}私聊`;
  const who = inbound.userName ? `${inbound.userName}（${inbound.userId}）` : inbound.userId;
  const extras = (inbound.attachments ?? []).map((item) => ({ image: "[图片]", file: "[文件]", voice: "[语音]", video: "[视频]" })[item.kind]).join("");
  const text = inbound.text || (extras ? "" : "（空消息）");
  return `［经${where}发来｜发送者：${who}｜你的回复会以文字发回${platformName}，不要画卡片或面板］\n${extras ? `${extras}（这一版收不到附件内容）\n` : ""}${text}`;
}

export function createImService(options: ImServiceOptions) {
  const sql = options.database.$client;
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const wsFactory = options.ws ?? defaultWs;
  const live = new Map<string, Live>();
  const allowDevicesCache = new Map<string, boolean>();
  const queues = new Map<string, { tail: Promise<void>; size: number }>();
  const logCounts = new Map<string, number>();
  type QrLogin = { owner: string; base: string; createdAt: number; result?: { token: string; baseUrl?: string; botId?: string } };
  const qrLogins = new Map<string, QrLogin>();

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_im_connections (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        platform text NOT NULL,
        name text NOT NULL,
        agent_id text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        secrets text,
        allow_users jsonb NOT NULL DEFAULT '[]'::jsonb,
        allow_devices boolean NOT NULL DEFAULT false,
        account text,
        last_message_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chisabot_im_connections_owner ON chisabot_im_connections (owner_user_id);
      CREATE TABLE IF NOT EXISTS chisabot_im_chats (
        connection_id text NOT NULL,
        chat_key text NOT NULL,
        thread_id text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (connection_id, chat_key)
      );
      CREATE TABLE IF NOT EXISTS chisabot_im_logs (
        id bigserial PRIMARY KEY,
        connection_id text NOT NULL,
        at timestamptz NOT NULL DEFAULT now(),
        level text NOT NULL,
        text text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chisabot_im_logs_connection ON chisabot_im_logs (connection_id, id DESC);
      ALTER TABLE chisabot_im_chats ADD COLUMN IF NOT EXISTS last_inbound jsonb;
    `);
  }

  const rowById = async (id: string) => (await sql.unsafe<Row[]>("SELECT * FROM chisabot_im_connections WHERE id = $1", [id]))[0] ?? null;
  const owned = async (owner: string, id: string) => {
    if (!CONNECTION_ID.test(id)) return null;
    const row = await rowById(id);
    return row && row.owner_user_id === owner ? row : null;
  };

  async function readSecrets(row: Pick<Row, "secrets">): Promise<Record<string, string>> {
    if (!row.secrets) return {};
    try {
      return JSON.parse(await decryptSecret(options.encryptionKey, row.secrets));
    } catch {
      return {};
    }
  }
  const sealSecrets = async (secrets: Record<string, string>) =>
    Object.keys(secrets).length ? await encryptSecret(options.encryptionKey, JSON.stringify(secrets)) : null;

  function log(connectionId: string, level: ImLogLevel, text: string) {
    const line = text.slice(0, 1000);
    console.log(JSON.stringify({ type: "im", connection: connectionId, level, text: line.slice(0, 300) }));
    void sql.unsafe("INSERT INTO chisabot_im_logs (connection_id, level, text) VALUES ($1, $2, $3)", [connectionId, level, line]).catch(() => {});
    const count = (logCounts.get(connectionId) ?? 0) + 1;
    logCounts.set(connectionId, count);
    if (count % 50 === 0)
      void sql
        .unsafe(
          "DELETE FROM chisabot_im_logs WHERE connection_id = $1 AND id < (SELECT min(id) FROM (SELECT id FROM chisabot_im_logs WHERE connection_id = $1 ORDER BY id DESC LIMIT $2) newest)",
          [connectionId, LOG_KEEP],
        )
        .catch(() => {});
  }

  function setStatus(connectionId: string, status: ImAdapterStatus) {
    const entry = live.get(connectionId);
    if (!entry) return;
    const previous = entry.status;
    entry.status = { ...status, account: status.account ?? (status.state === "connected" ? null : previous.account) };
    if (status.state === "connected" && status.account && status.account !== previous.account)
      void sql.unsafe("UPDATE chisabot_im_connections SET account = $2 WHERE id = $1", [connectionId, status.account]).catch(() => {});
    if (status.state === "error" && status.detail !== previous.detail)
      void sql.unsafe("UPDATE chisabot_im_connections SET last_error = $2 WHERE id = $1", [connectionId, status.detail ?? null]).catch(() => {});
    if (status.state === "connected" && previous.state !== "connected")
      void sql.unsafe("UPDATE chisabot_im_connections SET last_error = NULL WHERE id = $1", [connectionId]).catch(() => {});
  }

  function view(row: Row, secrets: Record<string, string>): ImConnectionView {
    const info = imPlatform(row.platform);
    const entry = live.get(row.id);
    const status: ImStatus = !row.enabled ? "disabled" : entry ? (entry.status.state as ImStatus) : "error";
    const secretKeys = (info?.fields ?? []).filter((field) => field.type === "secret").map((field) => field.key);
    return {
      id: row.id,
      platform: row.platform,
      name: row.name,
      agentId: row.agent_id,
      enabled: row.enabled,
      config: row.config ?? {},
      secrets: Object.fromEntries(secretKeys.map((key) => [key, Boolean(secrets[key])])),
      allowUsers: Array.isArray(row.allow_users) ? row.allow_users : [],
      allowDevices: row.allow_devices,
      status,
      statusDetail: !row.enabled ? null : entry ? entry.status.detail ?? null : row.last_error ?? "还没有启动",
      account: entry?.status.account ?? row.account,
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.platform === "onebot" && row.config?.mode === "reverse" ? { reversePath: `/api/im/onebot/${row.id}`, reverseToken: secrets.accessToken ?? "" } : {}),
    };
  }

  // ---- 运行 ----

  async function stopLive(id: string) {
    const entry = live.get(id);
    if (!entry) return;
    live.delete(id);
    await entry.adapter.stop().catch(() => {});
  }

  async function startRow(row: Row) {
    await stopLive(row.id);
    allowDevicesCache.set(row.id, row.allow_devices);
    if (!row.enabled) return;
    const secrets = await readSecrets(row);
    const ctx: AdapterContext = {
      connectionId: row.id,
      config: { ...(row.config ?? {}) },
      secrets,
      log: (level, text) => log(row.id, level, text),
      setStatus: (status) => setStatus(row.id, status),
      onMessage: (message) => void onInbound(row.id, message).catch((error) => log(row.id, "error", `处理消息失败：${errorText(error)}`)),
      fetch: fetcher,
      ws: wsFactory,
    };
    const adapter = createAdapter(row.platform, ctx);
    live.set(row.id, { adapter, status: { state: "connecting", account: row.account }, ctx });
    await adapter.start();
  }

  async function startAll() {
    const rows = await sql.unsafe<Row[]>("SELECT * FROM chisabot_im_connections ORDER BY created_at");
    for (const row of rows) {
      allowDevicesCache.set(row.id, row.allow_devices);
      if (!row.enabled) continue;
      try {
        await startRow(row);
      } catch (error) {
        log(row.id, "error", `启动失败：${errorText(error)}`);
      }
    }
    return rows.filter((row) => row.enabled).length;
  }

  async function stopAll() {
    await Promise.all([...live.keys()].map((id) => stopLive(id)));
  }

  async function threadFor(row: Row, key: string, fresh = false): Promise<string> {
    if (!fresh) {
      const found = (await sql.unsafe<{ thread_id: string }[]>("SELECT thread_id FROM chisabot_im_chats WHERE connection_id = $1 AND chat_key = $2", [row.id, key]))[0];
      if (found) return found.thread_id;
    }
    const threadId = `im-${row.id.slice(3)}-${crypto.randomUUID().slice(0, 13)}`;
    await sql.unsafe(
      `INSERT INTO chisabot_im_chats (connection_id, chat_key, thread_id) VALUES ($1, $2, $3)
       ON CONFLICT (connection_id, chat_key) DO UPDATE SET thread_id = EXCLUDED.thread_id, updated_at = now()`,
      [row.id, key, threadId],
    );
    return threadId;
  }

  async function reply(row: Row, adapter: ImAdapter, inbound: ImInbound, text: string) {
    const body = adapter.markdown ? text.trim() : markdownToPlain(text);
    const chunks = splitText(body, adapter.maxChunk);
    if (!chunks.length) return;
    await adapter.send({ inbound, chunks, text: body });
  }

  async function onInbound(connectionId: string, inbound: ImInbound) {
    const entry = live.get(connectionId);
    if (!entry) return;
    if (inbound.chatType === "group" && !inbound.mentioned) return;
    const row = await rowById(connectionId);
    if (!row || !row.enabled) return;
    const platformName = imPlatform(row.platform)?.name ?? row.platform;
    const who = inbound.userName ? `${inbound.userName}（${inbound.userId}）` : inbound.userId;
    const text = inbound.text.trim();
    // 「/id」谁都能用：把自己的 id 发给主人加进白名单。
    if (text === "/id" || text === "/我的id") {
      await reply(row, entry.adapter, inbound, `你的用户 id：${inbound.userId}${inbound.chatType === "group" ? `\n这个群的 id：${inbound.chatId}` : ""}`).catch(() => {});
      return;
    }
    const allow = Array.isArray(row.allow_users) ? row.allow_users : [];
    if (allow.length && !allow.includes(inbound.userId)) {
      log(row.id, "info", `忽略 ${who} 的消息（不在白名单里）`);
      return;
    }
    await sql.unsafe("UPDATE chisabot_im_connections SET last_message_at = now() WHERE id = $1", [row.id]).catch(() => {});
    const key = chatKey(inbound);
    if (NEW_TOPIC.has(text)) {
      await threadFor(row, key, true);
      log(row.id, "info", `${who} 开始了新话题`);
      await reply(row, entry.adapter, inbound, "好的，已开始新话题。").catch((error) => log(row.id, "warn", `回复失败：${errorText(error)}`));
      return;
    }
    if (text === "/help" || text === "/帮助") {
      await reply(
        row,
        entry.adapter,
        inbound,
        "直接发消息就会由机器人回复。\n/new 开始新话题\n/id 查看自己的用户 id\n允许 / 拒绝 直接审批待确认的操作卡片",
      ).catch(() => {});
      return;
    }
    const approvalDecision = IM_APPROVE_WORDS.has(text.toLowerCase())
      ? ("approve" as const)
      : IM_DENY_WORDS.has(text.toLowerCase())
        ? ("deny" as const)
        : null;
    if (approvalDecision && options.resolveApproval) {
      const currentThread = await threadFor(row, key).catch(() => null);
      const resolved = await options.resolveApproval(row.owner_user_id, currentThread, approvalDecision).catch(() => null);
      if (resolved) {
        const targetStr = resolved.target ? `（${resolved.target}）` : "";
        const msg =
          approvalDecision === "approve"
            ? `✅ 已批准「${resolved.title}」${targetStr}，机器人正在继续执行。`
            : `🚫 已拒绝「${resolved.title}」${targetStr}，该操作已取消。`;
        log(row.id, "info", `${who} 在 IM 中${approvalDecision === "approve" ? "批准" : "拒绝"}了操作：${resolved.title}`);
        await reply(row, entry.adapter, inbound, msg).catch(() => {});
        return;
      }
    }
    const queueKey = `${row.id}|${key}`;
    const queue = queues.get(queueKey) ?? { tail: Promise.resolve(), size: 0 };
    if (queue.size >= MAX_QUEUE) {
      log(row.id, "warn", `${who} 的消息太多，排队已满，丢弃一条`);
      await reply(row, entry.adapter, inbound, "上一条还在处理，稍等一下再发。").catch(() => {});
      return;
    }
    queue.size++;
    queues.set(queueKey, queue);
    log(row.id, "info", `收到 ${who}：${text.slice(0, 80) || "（附件）"}`);
    queue.tail = queue.tail
      .then(() => runOne(connectionId, inbound, platformName, key))
      .catch((error) => log(connectionId, "error", `处理失败：${errorText(error)}`))
      .finally(() => {
        queue.size--;
        if (queue.size <= 0) queues.delete(queueKey);
      });
  }

  async function runOne(connectionId: string, inbound: ImInbound, platformName: string, key: string) {
    const entry = live.get(connectionId);
    const row = await rowById(connectionId);
    if (!entry || !row || !row.enabled) return;
    const adapter = entry.adapter;
    if (!(await options.botAvailable(row.owner_user_id, row.agent_id))) {
      log(row.id, "error", "对接的机器人不存在或已删除，请在设置里重新选择");
      await reply(row, adapter, inbound, "这个连接对接的机器人已经不在了，请主人在 ChisaBot 设置里重新选择。").catch(() => {});
      return;
    }
    const threadId = await threadFor(row, key);
    // 定时任务到点要主动推回这个会话（DESIGN.md §55）：记住最近一条消息的回复信息。
    await sql
      .unsafe("UPDATE chisabot_im_chats SET last_inbound = $3::text::jsonb WHERE connection_id = $1 AND chat_key = $2", [row.id, key, JSON.stringify(inbound)])
      .catch(() => {});
    const content = frameInbound(platformName, inbound);
    const started = Date.now();
    void adapter.typing?.(inbound);
    const typingTimer = adapter.typing ? setInterval(() => void adapter.typing?.(inbound), 5000) : null;
    let answer: string;
    try {
      const result = await runWithRetry(() =>
        options.runTurn({
          ownerUserId: row.owner_user_id,
          routineId: `${IM_INITIATOR_PREFIX}${row.id}`,
          agentId: row.agent_id,
          threadId,
          instruction: content,
          initiator: { kind: "routine", id: `${IM_INITIATOR_PREFIX}${row.id}` },
          userMessage: { id: crypto.randomUUID(), role: "user", content } as Message,
          forwardedProps: { chisabotIm: { connectionId: row.id, platform: row.platform } },
        }),
      );
      answer = result.replyText?.trim() || "（这次没有文字回复）";
      if (result.components?.length) answer += "\n\n（这条回复里还有卡片，打开 ChisaBot 网页能看到。）";
    } catch (error) {
      if (options.isSuspension?.(error)) {
        answer = "这一步需要你在 ChisaBot 网页上确认后才能继续（打开网页处理待审批，然后再发一次）。";
        log(row.id, "warn", "回合停在需要网页审批的步骤");
      } else {
        const reason = errorText(error);
        log(row.id, "error", `机器人回合失败：${reason}`);
        answer = `抱歉，这次没能回答：${reason.slice(0, 200)}`;
      }
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
    try {
      await reply(row, adapter, inbound, answer);
      log(row.id, "info", `已回复（${answer.length} 字，用时 ${Math.round((Date.now() - started) / 1000)} 秒）`);
    } catch (error) {
      log(row.id, "error", `回复发送失败：${errorText(error)}`);
    }
  }

  /** 对话刚好被占着（极少：同一条对话另一轮还没放锁）时等一下再试一次。 */
  async function runWithRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!/already running|thread.*lock/i.test(errorText(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return await run();
    }
  }

  // ---- 增删改 ----

  type Input = {
    platform?: unknown;
    name?: unknown;
    agentId?: unknown;
    enabled?: unknown;
    config?: unknown;
    secrets?: unknown;
    allowUsers?: unknown;
    allowDevices?: unknown;
    weixinLogin?: unknown;
  };

  class InputError extends Error {}

  function cleanFields(platform: ImPlatform, input: Input, current: { config: Record<string, string>; secrets: Record<string, string> }, owner: string) {
    const info = imPlatform(platform)!;
    const config: Record<string, string> = { ...current.config };
    const secrets: Record<string, string> = { ...current.secrets };
    const rawConfig = (input.config && typeof input.config === "object" ? input.config : {}) as Record<string, unknown>;
    const rawSecrets = (input.secrets && typeof input.secrets === "object" ? input.secrets : {}) as Record<string, unknown>;
    for (const field of info.fields) {
      if (field.type === "secret") {
        const value = rawSecrets[field.key] ?? rawConfig[field.key];
        if (typeof value === "string" && value.trim()) secrets[field.key] = value.trim().slice(0, 4000);
        else if (value === null) delete secrets[field.key];
        continue;
      }
      const value = rawConfig[field.key];
      if (typeof value === "string") {
        const trimmed = value.trim().slice(0, 500);
        if (field.type === "select" && field.options && trimmed && !field.options.some((option) => option.value === trimmed))
          throw new InputError(`「${field.label}」的值不对`);
        if (field.type === "url" && trimmed && !/^(https?|wss?):\/\//.test(trimmed)) throw new InputError(`「${field.label}」要以 http(s):// 或 ws(s):// 开头`);
        if (trimmed) config[field.key] = trimmed;
        else delete config[field.key];
      }
      if (!config[field.key] && field.default) config[field.key] = field.default;
    }
    if (platform === "weixin" && typeof input.weixinLogin === "string" && input.weixinLogin) {
      const login = qrLogins.get(input.weixinLogin);
      if (!login || login.owner !== owner || !login.result) throw new InputError("微信授权已失效，请重新扫码");
      secrets.token = login.result.token;
      if (login.result.baseUrl) config.baseUrl = login.result.baseUrl.replace(/\/+$/, "");
      if (login.result.botId) config.accountId = login.result.botId;
      qrLogins.delete(input.weixinLogin);
    }
    if (platform === "onebot" && config.mode === "reverse" && !secrets.accessToken) secrets.accessToken = newToken();
    return { config, secrets };
  }

  function missingRequired(platform: ImPlatform, config: Record<string, string>, secrets: Record<string, string>): string | null {
    const info = imPlatform(platform)!;
    for (const field of info.fields) {
      if (field.showIf && config[field.showIf.key] !== field.showIf.equals) continue;
      const required = field.required || (platform === "onebot" && field.key === "url" && config.mode !== "reverse");
      if (!required) continue;
      const value = field.type === "secret" ? secrets[field.key] : config[field.key];
      if (!value) return field.label;
    }
    if (platform === "weixin" && !secrets.token) return "微信扫码授权";
    return null;
  }

  const cleanUsers = (value: unknown) =>
    Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))].slice(0, 200)
      : undefined;

  async function create(owner: string, input: Input): Promise<ImConnectionView> {
    const platform = typeof input.platform === "string" ? (input.platform as ImPlatform) : null;
    if (!platform || !imPlatform(platform)) throw new InputError("不支持这个平台");
    const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
    if (!agentId || !(await options.botAvailable(owner, agentId))) throw new InputError("请选择一个你的机器人");
    const name = (typeof input.name === "string" && input.name.trim() ? input.name.trim() : imPlatform(platform)!.name).slice(0, 40);
    const { config, secrets } = cleanFields(platform, input, { config: {}, secrets: {} }, owner);
    const enabled = input.enabled !== false;
    const missing = missingRequired(platform, config, secrets);
    if (missing && enabled) throw new InputError(`请填写「${missing}」`);
    const id = newId();
    await sql.unsafe(
      `INSERT INTO chisabot_im_connections (id, owner_user_id, platform, name, agent_id, enabled, config, secrets, allow_users, allow_devices)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9::text::jsonb, $10)`,
      [id, owner, platform, name, agentId, enabled, JSON.stringify(config), await sealSecrets(secrets), JSON.stringify(cleanUsers(input.allowUsers) ?? []), input.allowDevices === true],
    );
    log(id, "info", `创建了连接（${imPlatform(platform)!.name}）`);
    const row = (await rowById(id))!;
    await startRow(row);
    return view(row, secrets);
  }

  async function update(owner: string, id: string, input: Input): Promise<ImConnectionView | null> {
    const row = await owned(owner, id);
    if (!row) return null;
    const current = { config: row.config ?? {}, secrets: await readSecrets(row) };
    const { config, secrets } = cleanFields(row.platform, input, current, owner);
    let agentId = row.agent_id;
    if (typeof input.agentId === "string" && input.agentId !== row.agent_id) {
      if (!(await options.botAvailable(owner, input.agentId))) throw new InputError("请选择一个你的机器人");
      agentId = input.agentId;
    }
    const enabled = typeof input.enabled === "boolean" ? input.enabled : row.enabled;
    const missing = missingRequired(row.platform, config, secrets);
    if (missing && enabled) throw new InputError(`请填写「${missing}」`);
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 40) : row.name;
    const allowUsers = cleanUsers(input.allowUsers) ?? row.allow_users;
    const allowDevices = typeof input.allowDevices === "boolean" ? input.allowDevices : row.allow_devices;
    await sql.unsafe(
      `UPDATE chisabot_im_connections SET name = $2, agent_id = $3, enabled = $4, config = $5::text::jsonb, secrets = $6,
       allow_users = $7::text::jsonb, allow_devices = $8, updated_at = now(), last_error = CASE WHEN $4 THEN last_error ELSE NULL END WHERE id = $1`,
      [id, name, agentId, enabled, JSON.stringify(config), await sealSecrets(secrets), JSON.stringify(allowUsers), allowDevices],
    );
    allowDevicesCache.set(id, allowDevices);
    const changes = [
      enabled !== row.enabled ? (enabled ? "启用" : "停用") : null,
      agentId !== row.agent_id ? "换了机器人" : null,
      JSON.stringify(config) !== JSON.stringify(row.config ?? {}) || JSON.stringify(secrets) !== JSON.stringify(current.secrets) ? "改了配置" : null,
    ].filter(Boolean);
    if (changes.length) log(id, "info", `设置已更新：${changes.join("、")}`);
    const next = (await rowById(id))!;
    // 只改了名字 / 白名单 / 机器人：不用重连。
    const reconnect = enabled !== row.enabled || JSON.stringify(config) !== JSON.stringify(row.config ?? {}) || JSON.stringify(secrets) !== JSON.stringify(current.secrets) || (enabled && !live.has(id));
    if (reconnect) await startRow(next);
    return view(next, secrets);
  }

  async function remove(owner: string, id: string): Promise<boolean> {
    const row = await owned(owner, id);
    if (!row) return false;
    await stopLive(id);
    allowDevicesCache.delete(id);
    await sql.unsafe("DELETE FROM chisabot_im_connections WHERE id = $1", [id]);
    await sql.unsafe("DELETE FROM chisabot_im_chats WHERE connection_id = $1", [id]);
    await sql.unsafe("DELETE FROM chisabot_im_logs WHERE connection_id = $1", [id]);
    return true;
  }

  async function list(owner: string): Promise<ImConnectionView[]> {
    const rows = await sql.unsafe<Row[]>("SELECT * FROM chisabot_im_connections WHERE owner_user_id = $1 ORDER BY created_at", [owner]);
    return Promise.all(rows.map(async (row) => view(row, await readSecrets(row))));
  }

  async function logs(owner: string, id: string): Promise<ImLogEntry[] | null> {
    if (!(await owned(owner, id))) return null;
    const rows = await sql.unsafe<{ at: Date; level: ImLogEntry["level"]; text: string }[]>(
      "SELECT at, level, text FROM chisabot_im_logs WHERE connection_id = $1 ORDER BY id DESC LIMIT 100",
      [id],
    );
    return rows.map((row) => ({ at: new Date(row.at).toISOString(), level: row.level, text: row.text }));
  }

  function testContext(id: string, config: Record<string, string>, secrets: Record<string, string>): AdapterContext {
    return { connectionId: id, config, secrets, log: () => {}, setStatus: () => {}, onMessage: () => {}, fetch: fetcher, ws: wsFactory };
  }

  async function test(owner: string, id: string) {
    const row = await owned(owner, id);
    if (!row) return null;
    const secrets = await readSecrets(row);
    const result = await testAdapter(row.platform, testContext(id, row.config ?? {}, secrets), live.get(id)?.adapter);
    log(id, result.ok ? "info" : "warn", `测试连接：${result.detail}`);
    return result;
  }

  /** 保存前测试：用表单里的值（编辑时空密钥沿用已保存的）。 */
  async function testDraft(owner: string, input: Input & { id?: unknown }) {
    const existing = typeof input.id === "string" ? await owned(owner, input.id) : null;
    const platform = (existing?.platform ?? input.platform) as ImPlatform;
    if (!imPlatform(platform)) throw new InputError("不支持这个平台");
    const current = existing ? { config: existing.config ?? {}, secrets: await readSecrets(existing) } : { config: {}, secrets: {} };
    const { weixinLogin: _ignored, ...rest } = input;
    const { config, secrets } = cleanFields(platform, rest, current, owner);
    if (platform === "weixin" && typeof input.weixinLogin === "string") {
      const login = qrLogins.get(input.weixinLogin);
      if (login?.result) secrets.token = login.result.token;
    }
    return testAdapter(platform, testContext(existing?.id ?? "draft", config, secrets), existing ? live.get(existing.id)?.adapter : undefined);
  }

  // ---- 微信扫码授权 ----

  async function weixinQr(owner: string, baseUrl?: string) {
    const base = (baseUrl && /^https?:\/\//.test(baseUrl) ? baseUrl : WEIXIN_DEFAULT_BASE).replace(/\/+$/, "");
    for (const [key, value] of qrLogins) if (Date.now() - value.createdAt > 15 * 60_000) qrLogins.delete(key);
    const qr = await weixinFetchQr(fetcher, base);
    qrLogins.set(qr.qrcode, { owner, base, createdAt: Date.now() });
    return { qrcode: qr.qrcode, url: qr.url };
  }

  async function weixinQrPoll(owner: string, qrcode: string) {
    const login = qrLogins.get(qrcode);
    if (!login || login.owner !== owner) return { status: "expired" as const };
    if (login.result) return { status: "confirmed" as const, loginKey: qrcode, account: login.result.botId ?? null };
    const status = await weixinQrStatus(fetcher, login.base, qrcode);
    if (status.status === "confirmed" && status.token) {
      login.result = { token: status.token, baseUrl: status.baseUrl, botId: status.botId };
      return { status: "confirmed" as const, loginKey: qrcode, account: status.botId ?? null };
    }
    if (status.status === "expired") qrLogins.delete(qrcode);
    return { status: status.status === "scaned" ? ("scanned" as const) : status.status === "expired" ? ("expired" as const) : ("wait" as const) };
  }

  // ---- OneBot 反向连接 ----

  async function authorizeReverse(id: string, token: string): Promise<boolean> {
    if (!CONNECTION_ID.test(id)) return false;
    const row = await rowById(id);
    if (!row || row.platform !== "onebot" || row.config?.mode !== "reverse" || !row.enabled) return false;
    const secrets = await readSecrets(row);
    const expected = secrets.accessToken ?? "";
    if (!expected || token.length !== expected.length) return false;
    let diff = 0;
    for (let index = 0; index < expected.length; index++) diff |= expected.charCodeAt(index) ^ token.charCodeAt(index);
    return diff === 0;
  }

  function attachReverse(id: string, socket: WsLike, selfId: string | null): boolean {
    const entry = live.get(id);
    if (!entry || !(entry.adapter instanceof OneBotAdapter)) return false;
    const ok = entry.adapter.attach(socket, selfId);
    if (ok) log(id, "info", `协议端已连入${selfId ? `（QQ ${selfId}）` : ""}`);
    return ok;
  }

  // ---- 路由 ----

  const reverseFailures = new Map<string, { count: number; until: number }>();

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();

    // 协议端（NapCat 等）连进来：不走登录，用连接自己的 access token（公网网关对 /api/im/onebot/ 放行）。
    app.get(
      "/onebot/:id",
      async (c, next) => {
        const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";
        const failure = reverseFailures.get(ip);
        if (failure && failure.count >= 20 && failure.until > Date.now()) return c.json({ error: "失败次数过多" }, 429);
        const header = c.req.header("authorization") ?? "";
        const token = header.replace(/^(Bearer|Token)\s+/i, "").trim() || c.req.query("access_token") || "";
        if (!(await authorizeReverse(c.req.param("id"), token))) {
          const next429 = failure && failure.until > Date.now() ? failure : { count: 0, until: Date.now() + 10 * 60_000 };
          next429.count++;
          reverseFailures.set(ip, next429);
          return c.json({ error: "token 不对或连接没有启用反向 WebSocket" }, 401);
        }
        if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "这里要用 WebSocket 连接" }, 400);
        await next();
      },
      upgradeWebSocket((c) => {
        const id = c.req.param("id")!;
        const selfId = c.req.header("x-self-id") ?? null;
        const shim: WsLike = { readyState: 0, send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
        return {
          onOpen: (_event, ws) => {
            shim.readyState = 1;
            shim.send = (data) => ws.send(data as string);
            shim.close = (code, reason) => {
              shim.readyState = 3;
              ws.close(code, reason);
            };
            if (!attachReverse(id, shim, selfId)) ws.close(1008, "disabled");
          },
          onMessage: (event) => shim.onmessage?.({ data: event.data }),
          onClose: (event) => {
            shim.readyState = 3;
            shim.onclose?.({ code: (event as { code?: number }).code });
          },
          onError: () => shim.onerror?.({}),
        };
      }),
    );

    const authed = new Hono<{ Variables: AppVariables }>();
    authed.use("*", requireUser);
    const fail = (c: any, error: unknown) =>
      error instanceof InputError ? c.json({ error: error.message }, 400) : (console.error(error), c.json({ error: "出错了，请重试" }, 500));
    authed.get("/platforms", (c) => c.json({ platforms: IM_PLATFORMS }));
    authed.get("/connections", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ connections: await list(c.var.actor.id) });
    });
    authed.post("/connections", async (c) => {
      try {
        return c.json({ connection: await create(c.var.actor.id, (await c.req.json().catch(() => ({}))) as Input) }, 201);
      } catch (error) {
        return fail(c, error);
      }
    });
    authed.post("/test", async (c) => {
      try {
        return c.json(await testDraft(c.var.actor.id, (await c.req.json().catch(() => ({}))) as Input));
      } catch (error) {
        return fail(c, error);
      }
    });
    authed.patch("/connections/:id", async (c) => {
      try {
        const updated = await update(c.var.actor.id, c.req.param("id"), (await c.req.json().catch(() => ({}))) as Input);
        return updated ? c.json({ connection: updated }) : c.json({ error: "没有这个连接" }, 404);
      } catch (error) {
        return fail(c, error);
      }
    });
    authed.delete("/connections/:id", async (c) => ((await remove(c.var.actor.id, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "没有这个连接" }, 404)));
    authed.post("/connections/:id/test", async (c) => {
      const result = await test(c.var.actor.id, c.req.param("id"));
      return result ? c.json(result) : c.json({ error: "没有这个连接" }, 404);
    });
    authed.get("/connections/:id/logs", async (c) => {
      c.header("Cache-Control", "no-store");
      const entries = await logs(c.var.actor.id, c.req.param("id"));
      return entries ? c.json({ logs: entries }) : c.json({ error: "没有这个连接" }, 404);
    });
    authed.post("/weixin/qr", async (c) => {
      try {
        const body = (await c.req.json().catch(() => ({}))) as { baseUrl?: string };
        return c.json(await weixinQr(c.var.actor.id, body.baseUrl));
      } catch (error) {
        return c.json({ error: `获取二维码失败：${errorText(error)}` }, 502);
      }
    });
    authed.get("/weixin/qr/status", async (c) => {
      try {
        c.header("Cache-Control", "no-store");
        return c.json(await weixinQrPoll(c.var.actor.id, c.req.query("qrcode") ?? ""));
      } catch (error) {
        return c.json({ error: `查询扫码状态失败：${errorText(error)}` }, 502);
      }
    });
    app.route("/", authed);
    return app;
  }

  return {
    ensure,
    startAll,
    stopAll,
    list,
    create,
    update,
    remove,
    logs,
    test,
    testDraft,
    routes,
    attachReverse,
    authorizeReverse,
    weixinQr,
    weixinQrPoll,
    /**
     * 主动把一段文字发到某个 IM 对话（定时任务到点，DESIGN.md §55）：按这个对话最近一条消息的回复信息发。
     * 有的平台只许在一段时间内被动回复（QQ 官方机器人 msg_id 5 分钟、企业微信智能机器人按消息流式），过期会失败。
     */
    async pushToThread(threadId: string, text: string) {
      const chat = (await sql.unsafe<{ connection_id: string; last_inbound: unknown }[]>("SELECT connection_id, last_inbound FROM chisabot_im_chats WHERE thread_id = $1", [threadId]))[0];
      if (!chat) throw new Error("找不到这个 IM 对话（可能已经 /new 换了新话题）");
      const entry = live.get(chat.connection_id);
      const row = await rowById(chat.connection_id);
      if (!entry || !row || !row.enabled) throw new Error("IM 连接没有在线");
      let inbound = chat.last_inbound as ImInbound | string | null;
      if (typeof inbound === "string") inbound = JSON.parse(inbound) as ImInbound;
      if (!inbound) throw new Error("这个 IM 对话还没有可回复的消息");
      await reply(row, entry.adapter, inbound, text);
      log(row.id, "info", `定时任务推送（${text.length} 字）`);
    },
    /** IM 回合能不能用电脑 / 设备类工具（连接里的开关）。 */
    allowsDevices: (connectionId: string) => allowDevicesCache.get(connectionId) === true,
    /** 测试用：当前适配器。 */
    adapterOf: (connectionId: string) => live.get(connectionId)?.adapter ?? null,
    statusOf: (connectionId: string) => live.get(connectionId)?.status ?? null,
    InputError,
  };
}
