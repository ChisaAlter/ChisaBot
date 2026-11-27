import type {
  AppearancePrefs,
  BotSummary,
  BrowserPermissionTier,
  CompanionAuthRecord,
  PendingApprovalItem,
  TabContextSummary,
  ThreadSummary,
} from "../types/protocol";

/**
 * 扩展侧栏直连 HTTP 客户端（/api/devices/agent/companion/*，统一 X-Device-Token 鉴权）。
 * 完整对齐服务端桥接契约：bootstrap / open-thread / send / events / stop / approvals/:id / settings / shots/:shotId。
 */

export interface CompanionBootstrapResponse {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    role?: string;
    image?: string | null;
  };
  bots: BotSummary[];
  defaultBotId: string | null;
  appearance?: Partial<AppearancePrefs>;
  companionConfig?: {
    tier?: BrowserPermissionTier;
    blockedDomains?: string[];
    allowRemoteDispatch?: boolean;
  };
  pendingApprovals?: PendingApprovalItem[];
}

export interface CompanionThreadResponse {
  channelId: string;
  threadId: string;
  botId: string;
  botName?: string;
  running: boolean;
  messages: Array<Record<string, unknown>>;
  history: ThreadSummary[];
}

export interface CompanionApiOptions {
  fetchImpl?: typeof fetch;
}

function parseSseBlock(block: string): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function consumeSseStream(
  response: Response,
  onEvent: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const parsed = parseSseBlock(part);
        if (parsed) onEvent(parsed);
      }
    }
    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed) onEvent(parsed);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流可能已经正常结束
    }
  }
}

export function createCompanionApi(options: CompanionApiOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function requestJson<T>(
    auth: CompanionAuthRecord,
    pathname: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const resp = await fetchImpl(`${auth.serverUrl}${pathname}`, {
      method: init.method ?? "GET",
      headers: {
        "X-Device-Token": auth.deviceToken,
        Accept: "application/json",
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init.signal,
    });

    if (resp.status === 401) {
      throw new Error("设备令牌已失效或已被撤销，请重新登录。");
    }
    if (!resp.ok) {
      const errBody = (await resp.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(errBody?.error || `请求失败（HTTP ${resp.status}）。`);
    }
    return (await resp.json()) as T;
  }

  return {
    async bootstrap(
      auth: CompanionAuthRecord,
    ): Promise<CompanionBootstrapResponse> {
      const raw = await requestJson<Record<string, unknown>>(
        auth,
        "/api/devices/agent/companion/bootstrap",
      );
      const rawBots = Array.isArray(raw.bots) ? raw.bots : [];
      const bots: BotSummary[] = rawBots
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object",
        )
        .filter((item) => item.hidden !== true)
        .map((item) => ({
          id: String(item.id ?? ""),
          name: String(item.name ?? item.title ?? "助手"),
          description:
            typeof item.description === "string"
              ? item.description
              : typeof item.title === "string"
                ? item.title
                : null,
          avatarUrl:
            typeof item.avatarUrl === "string"
              ? item.avatarUrl
              : typeof item.image === "string"
                ? item.image
                : null,
        }))
        .filter((bot) => bot.id.length > 0);

      const rawUser =
        raw.user && typeof raw.user === "object"
          ? (raw.user as Record<string, unknown>)
          : {};

      const rawApprovals = Array.isArray(raw.pendingApprovals)
        ? raw.pendingApprovals
        : [];
      const pendingApprovals: PendingApprovalItem[] = rawApprovals
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object",
        )
        .map((item) => ({
          id: String(item.id ?? ""),
          operation: String(item.operation ?? "browser_click"),
          summary: String(item.summary ?? "等待确认的操作"),
          botName: typeof item.botName === "string" ? item.botName : null,
          expiresAt:
            typeof item.expiresAt === "string"
              ? item.expiresAt
              : new Date(Date.now() + 120_000).toISOString(),
          ...(typeof item.remainingMs === "number"
            ? { remainingMs: item.remainingMs }
            : {}),
          source: "companion" as const,
        }))
        .filter((item) => item.id.length > 0);

      return {
        user: {
          id: String(rawUser.id ?? auth.userId ?? ""),
          name: typeof rawUser.name === "string" ? rawUser.name : null,
          email: typeof rawUser.email === "string" ? rawUser.email : null,
          role: typeof rawUser.role === "string" ? rawUser.role : undefined,
          image: typeof rawUser.image === "string" ? rawUser.image : null,
        },
        bots,
        defaultBotId:
          typeof raw.defaultBotId === "string"
            ? raw.defaultBotId
            : (bots[0]?.id ?? null),
        appearance:
          raw.appearance && typeof raw.appearance === "object"
            ? (raw.appearance as Partial<AppearancePrefs>)
            : undefined,
        companionConfig:
          raw.companionConfig && typeof raw.companionConfig === "object"
            ? (raw.companionConfig as CompanionBootstrapResponse["companionConfig"])
            : undefined,
        pendingApprovals,
      };
    },

    async openThread(
      auth: CompanionAuthRecord,
      input: { botId: string; threadId?: string; fresh?: boolean },
    ): Promise<CompanionThreadResponse> {
      const raw = await requestJson<Record<string, unknown>>(
        auth,
        "/api/devices/agent/companion/open-thread",
        {
          method: "POST",
          body: input,
        },
      );
      const rawHistory = Array.isArray(raw.history) ? raw.history : [];
      const history: ThreadSummary[] = rawHistory
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object",
        )
        .map((item) => ({
          id: String(item.id ?? item.channelId ?? item.threadId ?? ""),
          botId: String(item.botId ?? input.botId),
          title: String(item.title ?? "对话"),
          updatedAt:
            typeof item.updatedAt === "string" ? item.updatedAt : undefined,
        }))
        .filter((item) => item.id.length > 0);

      const threadId = String(raw.threadId ?? raw.channelId ?? "");
      return {
        channelId: String(raw.channelId ?? threadId),
        threadId,
        botId: String(raw.botId ?? input.botId),
        botName: typeof raw.botName === "string" ? raw.botName : undefined,
        running: raw.running === true,
        messages: Array.isArray(raw.messages)
          ? (raw.messages as Array<Record<string, unknown>>)
          : [],
        history,
      };
    },

    async sendMessageStream(
      auth: CompanionAuthRecord,
      input: {
        botId: string;
        threadId?: string;
        text: string;
        messageId?: string;
        attached: boolean;
        attachedTab: TabContextSummary | null;
      },
      onEvent: (event: Record<string, unknown>) => void,
      signal?: AbortSignal,
    ): Promise<{ commandId?: string; runId?: string; threadId?: string }> {
      const resp = await fetchImpl(
        `${auth.serverUrl}/api/devices/agent/companion/send`,
        {
          method: "POST",
          headers: {
            "X-Device-Token": auth.deviceToken,
            "Content-Type": "application/json",
            Accept: "text/event-stream, application/json",
          },
          body: JSON.stringify({
            botId: input.botId,
            ...(input.threadId ? { threadId: input.threadId } : {}),
            text: input.text,
            ...(input.messageId ? { messageId: input.messageId } : {}),
            attached: input.attached,
            attachedTab:
              input.attached && input.attachedTab
                ? {
                    tabId: input.attachedTab.tabId,
                    url: input.attachedTab.url,
                    title: input.attachedTab.title,
                    windowId: input.attachedTab.windowId,
                  }
                : null,
          }),
          signal,
        },
      );

      if (resp.status === 401) {
        throw new Error("设备令牌已失效或已被撤销，请重新登录。");
      }
      if (!resp.ok) {
        const errBody = (await resp.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          errBody?.error || `发送消息失败（HTTP ${resp.status}）。`,
        );
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const commandId = resp.headers.get("x-chisabot-command-id") ?? undefined;
      const runId = resp.headers.get("x-chisabot-run-id") ?? undefined;

      if (contentType.includes("text/event-stream")) {
        await consumeSseStream(resp, onEvent, signal);
        return { commandId, runId, threadId: input.threadId };
      }

      const accepted = (await resp.json().catch(() => ({}))) as {
        commandId?: string;
        runId?: string;
        threadId?: string;
      };
      if (accepted.threadId || input.threadId) {
        const eventsResp = await fetchImpl(
          `${auth.serverUrl}/api/devices/agent/companion/events`,
          {
            method: "POST",
            headers: {
              "X-Device-Token": auth.deviceToken,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              threadId: accepted.threadId ?? input.threadId,
              botId: input.botId,
              ...(accepted.commandId ? { commandId: accepted.commandId } : {}),
            }),
            signal,
          },
        );
        if (eventsResp.ok) {
          await consumeSseStream(eventsResp, onEvent, signal);
        }
      }
      return {
        commandId: accepted.commandId ?? commandId,
        runId: accepted.runId ?? runId,
        threadId: accepted.threadId ?? input.threadId,
      };
    },

    async stopRun(
      auth: CompanionAuthRecord,
      input: { threadId?: string; runId?: string; detach?: boolean },
    ): Promise<void> {
      await requestJson(auth, "/api/devices/agent/companion/stop", {
        method: "POST",
        body: input,
      }).catch(() => {});
    },

    async decideApproval(
      auth: CompanionAuthRecord,
      id: string,
      decision: "approve" | "deny",
    ): Promise<void> {
      await requestJson(
        auth,
        `/api/devices/agent/companion/approvals/${encodeURIComponent(id)}`,
        {
          method: "POST",
          body: { decision },
        },
      );
    },

    async updateSettings(
      auth: CompanionAuthRecord,
      patch: {
        tier?: BrowserPermissionTier;
        blockedDomains?: string[];
        allowRemoteDispatch?: boolean;
        attachedTabId?: number | null;
        tabGroupId?: number | null;
        paused?: boolean;
      },
    ): Promise<void> {
      await requestJson(auth, "/api/devices/agent/companion/settings", {
        method: "PATCH",
        body: patch,
      });
    },

    async fetchShotDataUrl(
      auth: CompanionAuthRecord,
      shotIdOrPath: string,
    ): Promise<string | null> {
      const cleanId = shotIdOrPath
        .replace(/^\/api\/chat-shots\//, "")
        .replace(/^\/api\/devices\/agent\/companion\/shots\//, "")
        .trim();
      if (!cleanId) return null;
      try {
        const resp = await fetchImpl(
          `${auth.serverUrl}/api/devices/agent/companion/shots/${encodeURIComponent(cleanId)}`,
          {
            headers: {
              "X-Device-Token": auth.deviceToken,
            },
          },
        );
        if (!resp.ok) return null;
        const mime = resp.headers.get("content-type") || "image/jpeg";
        const buf = new Uint8Array(await resp.arrayBuffer());
        let binary = "";
        for (let i = 0; i < buf.length; i += 1) {
          binary += String.fromCharCode(buf[i] ?? 0);
        }
        return `data:${mime};base64,${btoa(binary)}`;
      } catch {
        return null;
      }
    },
  };
}

export type CompanionApi = ReturnType<typeof createCompanionApi>;
