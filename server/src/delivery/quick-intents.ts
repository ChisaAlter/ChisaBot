import { createHash, randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  buildAgentDeepLink,
  buildChannelDeepLink,
  truncateNotificationText,
} from "../../../shared/notifications";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { ChannelStore } from "../channels/routes";

const INTENTS_BODY_LIMIT_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 64 * 1024;
const DEFAULT_MAX_LEDGER_RECORDS = 1000;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const sendIntentSchema = z.strictObject({
  agentId: z.string().trim().min(1).max(200),
  text: z.string().max(MAX_TEXT_LENGTH),
  clientNonce: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => !hasControlChars(value), "clientNonce 不能包含控制字符"),
  channelId: z.string().trim().min(1).max(200).optional(),
});

export type QuickIntentRunStatus = "running" | "completed" | "failed";

export type QuickIntentRecord = {
  userId: string;
  clientNonce: string;
  digest: string;
  agentId: string;
  channelId: string;
  threadId: string;
  messageId: string;
  deepLink: string;
  runStatus: QuickIntentRunStatus;
  replySummary: string | null;
  error: string | null;
  acceptedAt: string;
  updatedAt: string;
};

export type QuickIntentDispatchInput = {
  actor: AgentActor;
  agent: AgentProfile;
  channelId: string;
  threadId: string;
  messageId: string;
  clientNonce: string;
  text: string;
};

export type QuickIntentDispatchResult = {
  replyText?: string;
};

export type QuickIntentsOptions = {
  agentProfileStore: Pick<AgentProfileStore, "list" | "get">;
  channelStore: Pick<ChannelStore, "direct" | "get">;
  /** 派发后台回合；返回 Promise 在回合完成时提供回复正文，用于更新状态回查摘要。 */
  dispatchTurn: (
    input: QuickIntentDispatchInput,
  ) => Promise<QuickIntentDispatchResult>;
  getMainBotId?: (userId: string) => Promise<string | null>;
  maxRecords?: number;
  now?: () => number;
};

function sortIntentAgents(
  profiles: readonly AgentProfile[],
  mainBotId: string | null,
): AgentProfile[] {
  return [...profiles].sort((left, right) => {
    const leftMain = mainBotId !== null && left.id === mainBotId ? 1 : 0;
    const rightMain = mainBotId !== null && right.id === mainBotId ? 1 : 0;
    if (leftMain !== rightMain) return rightMain - leftMain;

    const leftPinned = left.pinned ? 1 : 0;
    const rightPinned = right.pinned ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;

    if (left.pinned && right.pinned) {
      const leftAt = left.pinnedAt ? Date.parse(left.pinnedAt) : 0;
      const rightAt = right.pinnedAt ? Date.parse(right.pinnedAt) : 0;
      if (leftAt !== rightAt) return rightAt - leftAt;
    }

    return 0;
  });
}

function requestDigest(
  agentId: string,
  text: string,
  channelId: string | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify([agentId, text, channelId ?? ""]))
    .digest("hex");
}

/**
 * 面向 Siri / Apple Shortcuts / Android 快捷指令 / 外部触发器的无界面幂等快捷入口。
 *
 * 挂载路径：`/api/intents`
 * - `GET /agents`：当前用户可见 Bot 列表（主 Bot 与置顶优先）
 * - `POST /send`：按 `(userId, clientNonce)` 幂等去重派发消息，返回 `ACCEPTED` / `DUPLICATE` / `REJECTED`
 * - `GET /status/:nonce`：按当前用户查询执行状态与最新回复摘要
 */
export function createQuickIntents(options: QuickIntentsOptions) {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_LEDGER_RECORDS;
  const clock = options.now ?? (() => Date.now());
  const records = new Map<string, QuickIntentRecord>();

  function ledgerKey(userId: string, clientNonce: string): string {
    return `${userId}:${clientNonce}`;
  }

  function evictIfNeeded(): void {
    while (records.size >= maxRecords) {
      let victim: string | null = null;
      for (const [key, entry] of records) {
        if (entry.runStatus !== "running") {
          victim = key;
          break;
        }
      }
      if (!victim) {
        victim = records.keys().next().value ?? null;
      }
      if (!victim) break;
      records.delete(victim);
    }
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);

    app.get("/agents", async (context) => {
      const actor = context.var.actor;
      const [profiles, mainBotId] = await Promise.all([
        options.agentProfileStore.list(actor),
        options.getMainBotId
          ? options.getMainBotId(actor.id).catch(() => null)
          : Promise.resolve(null),
      ]);
      const ordered = sortIntentAgents(profiles, mainBotId);
      return context.json({
        agents: ordered.map((profile) => ({
          id: profile.id,
          name: profile.name,
          title: profile.title,
          description: profile.roleDescription,
          pinned: profile.pinned,
          main: mainBotId !== null && profile.id === mainBotId,
          deepLink: buildAgentDeepLink(profile.id),
        })),
      });
    });

    app.post(
      "/send",
      bodyLimit({ maxSize: INTENTS_BODY_LIMIT_BYTES }),
      async (context) => {
        const actor = context.var.actor;
        const parsed = sendIntentSchema.safeParse(
          await context.req.json().catch(() => undefined),
        );
        if (!parsed.success) {
          return context.json(
            {
              status: "REJECTED" as const,
              code: "INVALID_INPUT",
              error:
                parsed.error.issues[0]?.message ?? "快捷指令请求参数无效。",
            },
            400,
          );
        }

        const {
          agentId,
          clientNonce,
          channelId: requestedChannelId,
        } = parsed.data;
        const trimmedText = parsed.data.text.trim();
        if (!trimmedText) {
          return context.json(
            {
              status: "REJECTED" as const,
              code: "EMPTY_MESSAGE",
              error: "消息内容不能为空。",
            },
            400,
          );
        }

        // 先校验权限，严禁越权向他人私有 Bot 或非本人频道发送消息。
        const profile = await options.agentProfileStore.get(actor, agentId);
        if (!profile) {
          return context.json(
            {
              status: "REJECTED" as const,
              code: "BOT_NOT_ACCESSIBLE",
              error: "目标机器人不存在或无访问权限。",
            },
            403,
          );
        }

        if (requestedChannelId) {
          const existingChannel = await options.channelStore.get(
            actor,
            requestedChannelId,
          );
          if (!existingChannel?.agentIds.includes(profile.id)) {
            return context.json(
              {
                status: "REJECTED" as const,
                code: "CHANNEL_NOT_ACCESSIBLE",
                error: "目标会话不存在、无访问权限或未包含该机器人。",
              },
              403,
            );
          }
        }

        const key = ledgerKey(actor.id, clientNonce);
        const digest = requestDigest(
          profile.id,
          trimmedText,
          requestedChannelId,
        );
        const checkExistingRecord = () => {
          const hit = records.get(key);
          if (!hit) return null;
          if (hit.digest !== digest) {
            return context.json(
              {
                status: "REJECTED" as const,
                code: "NONCE_CONFLICT",
                error: "相同的 clientNonce 已用于不同内容，请生成新的幂等键。",
              },
              409,
            );
          }
          return context.json({
            status: "DUPLICATE" as const,
            clientNonce: hit.clientNonce,
            agentId: hit.agentId,
            channelId: hit.channelId,
            messageId: hit.messageId,
            deepLink: hit.deepLink,
            runStatus: hit.runStatus,
            replySummary: hit.replySummary,
          });
        };

        const beforeChannel = checkExistingRecord();
        if (beforeChannel) return beforeChannel;

        const channel = requestedChannelId
          ? await options.channelStore.get(actor, requestedChannelId)
          : await options.channelStore.direct(actor, profile.id);
        if (!channel) {
          return context.json(
            {
              status: "REJECTED" as const,
              code: "CHANNEL_UNAVAILABLE",
              error: "无法定位或创建目标会话。",
            },
            404,
          );
        }

        // 在 await channelStore 之后、写入账本之前做同步复检，彻底消除并发相同 clientNonce 的双发竞态。
        const afterChannel = checkExistingRecord();
        if (afterChannel) return afterChannel;

        evictIfNeeded();
        const nowIso = new Date(clock()).toISOString();
        const messageId = `intent_${randomUUID()}`;
        const deepLink = buildChannelDeepLink(channel.id, profile.id);
        const record: QuickIntentRecord = {
          userId: actor.id,
          clientNonce,
          digest,
          agentId: profile.id,
          channelId: channel.id,
          threadId: channel.threadId,
          messageId,
          deepLink,
          runStatus: "running",
          replySummary: null,
          error: null,
          acceptedAt: nowIso,
          updatedAt: nowIso,
        };
        records.set(key, record);

        // 异步执行回合，避免移动端快捷指令 / Siri 超时；结果实时回写状态账本。
        void Promise.resolve()
          .then(() =>
            options.dispatchTurn({
              actor,
              agent: profile,
              channelId: channel.id,
              threadId: channel.threadId,
              messageId,
              clientNonce,
              text: trimmedText,
            }),
          )
          .then((result) => {
            record.runStatus = "completed";
            record.replySummary = result?.replyText
              ? truncateNotificationText(result.replyText, 240)
              : null;
            record.error = null;
            record.updatedAt = new Date(clock()).toISOString();
          })
          .catch((error: unknown) => {
            record.runStatus = "failed";
            record.error =
              error instanceof Error
                ? error.message.slice(0, 240)
                : "执行失败，请打开 ChisaBot 查看详情。";
            record.updatedAt = new Date(clock()).toISOString();
          });

        return context.json(
          {
            status: "ACCEPTED" as const,
            clientNonce: record.clientNonce,
            agentId: record.agentId,
            channelId: record.channelId,
            messageId: record.messageId,
            deepLink: record.deepLink,
          },
          202,
        );
      },
    );

    app.get("/status/:nonce", (context) => {
      const actor = context.var.actor;
      const nonce = context.req.param("nonce").trim();
      if (!nonce || nonce.length > 128 || hasControlChars(nonce)) {
        return context.json(
          { status: "REJECTED" as const, error: "clientNonce 格式无效。" },
          400,
        );
      }
      const record = records.get(ledgerKey(actor.id, nonce));
      if (!record) {
        return context.json(
          { status: "NOT_FOUND" as const, clientNonce: nonce },
          404,
        );
      }
      return context.json({
        status: record.runStatus,
        clientNonce: record.clientNonce,
        agentId: record.agentId,
        channelId: record.channelId,
        messageId: record.messageId,
        deepLink: record.deepLink,
        replySummary: record.replySummary,
        error: record.error,
        acceptedAt: record.acceptedAt,
        updatedAt: record.updatedAt,
      });
    });

    return app;
  }

  return {
    routes,
    getRecord: (userId: string, clientNonce: string) =>
      records.get(ledgerKey(userId, clientNonce)) ?? null,
  };
}

export type QuickIntentsService = ReturnType<typeof createQuickIntents>;
