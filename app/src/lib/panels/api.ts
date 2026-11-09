import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  CommitInput,
  CommitResult,
  Json,
  PanelDefinition,
  PanelDraft,
  PanelInstance,
  PanelLibraryEntry,
  PanelListPage,
  PanelSession,
  PanelTask,
} from "../../../../shared/panels/types";

export type {
  Json,
  PanelDefinition,
  PanelDraft,
  PanelInstance,
  PanelLibraryEntry,
  PanelListPage,
  PanelSession,
  PanelTask,
};

/**
 * The browser's half of the custom panels API (`server/src/panels/routes.ts`).
 *
 * Every route answers `{ result }` on success and `{ error: <code> }` on refusal; `client` throws
 * the code as the error message, and `panelErrorText` turns it into a sentence.
 */
const path = (botId: string, rest = "") =>
  `/api/panels/${encodeURIComponent(botId)}${rest}`;

function call<T>(
  botId: string,
  rest = "",
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  return client<T>(path(botId, rest), "result", {
    fallback: "面板操作失败，请重试。",
    ...options,
  });
}

export type PanelLibraryPage = {
  items: PanelLibraryEntry[];
  nextOffset: number | null;
};

export type PanelStateRead = {
  stateRevision: number;
  value: Json;
  requiresReset: boolean;
};

export type PanelGrantRow = { capabilityId: string } & Record<string, unknown>;

export const panelsApi = {
  list: (botId: string, offset = 0) =>
    call<PanelListPage>(botId, `?limit=50&offset=${offset}`),
  library: (botId: string, offset = 0) =>
    call<PanelLibraryPage>(botId, `/library?limit=50&offset=${offset}`),
  session: (botId: string) => call<PanelSession | null>(botId, "/authoring"),
  begin: (botId: string, targetInstanceId?: string) =>
    call<PanelSession>(botId, "/authoring", {
      method: "POST",
      body: targetInstanceId ? { targetInstanceId } : {},
    }),
  cancel: (botId: string, sessionId: string) =>
    call<{ ok: true }>(botId, `/authoring/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }),
  draft: (botId: string, draftId: string) =>
    call<PanelDraft>(botId, `/drafts/${encodeURIComponent(draftId)}`),
  saveDraft: (
    botId: string,
    body: {
      sessionId: string;
      expectedDraftRevision: number;
      definition: PanelDefinition;
    },
  ) => call<PanelDraft>(botId, "/drafts", { method: "POST", body }),
  commit: async (botId: string, body: CommitInput) => {
    try {
      return await call<CommitResult>(botId, "/commit", {
        method: "POST",
        body,
      });
    } catch (error) {
      // A commit that landed but whose answer was lost is recorded under its idempotency key.
      const landed = await call<CommitResult | null>(
        botId,
        `/operations/${encodeURIComponent(body.idempotencyKey)}`,
      ).catch(() => null);
      if (landed) return landed;
      throw error;
    }
  },
  install: (
    botId: string,
    body: { libraryId: string; libraryVersion: number; idempotencyKey: string },
  ) => call<unknown>(botId, "/install", { method: "POST", body }),
  archive: (botId: string, libraryId: string, expectedVersion: number) =>
    call<{ ok: true }>(botId, `/library/${encodeURIComponent(libraryId)}`, {
      method: "DELETE",
      body: { expectedVersion },
    }),
  layout: (
    botId: string,
    instanceId: string,
    body: { expectedVersion: number; collapsed?: boolean; title?: string },
  ) =>
    call<PanelInstance>(botId, `/instances/${encodeURIComponent(instanceId)}`, {
      method: "PATCH",
      body,
    }),
  remove: (botId: string, instanceId: string, expectedVersion: number) =>
    call<{ ok: true }>(botId, `/instances/${encodeURIComponent(instanceId)}`, {
      method: "DELETE",
      body: { expectedVersion },
    }),
  state: (botId: string, instanceId: string, signal?: AbortSignal) =>
    call<PanelStateRead>(
      botId,
      `/instances/${encodeURIComponent(instanceId)}/state`,
      { signal },
    ),
  writeState: (
    botId: string,
    instanceId: string,
    body: {
      instanceVersion: number;
      stateRevision: number;
      value: Json;
      resetIncompatible?: boolean;
    },
    signal?: AbortSignal,
  ) =>
    call<{ ok: true }>(
      botId,
      `/instances/${encodeURIComponent(instanceId)}/state`,
      { method: "PUT", body, signal },
    ),
  grants: (botId: string, instanceId: string) =>
    call<PanelGrantRow[]>(
      botId,
      `/instances/${encodeURIComponent(instanceId)}/grants`,
    ),
  grant: (
    botId: string,
    instanceId: string,
    capabilityId: string,
    instanceVersion: number,
  ) =>
    call<unknown>(
      botId,
      `/instances/${encodeURIComponent(instanceId)}/grants/${encodeURIComponent(capabilityId)}`,
      { method: "POST", body: { instanceVersion } },
    ),
  revoke: (botId: string, instanceId: string, capabilityId: string) =>
    call<unknown>(
      botId,
      `/instances/${encodeURIComponent(instanceId)}/grants/${encodeURIComponent(capabilityId)}`,
      { method: "DELETE" },
    ),
  data: (
    instance: PanelInstance,
    capabilityId: string,
    args: Json,
    signal?: AbortSignal,
  ) =>
    call<Json>(
      instance.botId,
      `/instances/${encodeURIComponent(instance.id)}/data/${encodeURIComponent(capabilityId)}`,
      {
        method: "POST",
        body: { instanceVersion: instance.instanceVersion, args },
        signal,
      },
    ),
  requestTask: (
    instance: PanelInstance,
    capabilityId: string,
    args: Json,
    signal?: AbortSignal,
  ) =>
    call<PanelTask>(
      instance.botId,
      `/instances/${encodeURIComponent(instance.id)}/tasks/${encodeURIComponent(capabilityId)}`,
      {
        method: "POST",
        body: {
          instanceVersion: instance.instanceVersion,
          args,
          idempotencyKey: crypto.randomUUID(),
        },
        signal,
      },
    ),
  tasks: (botId: string, instanceId: string) =>
    call<PanelTask[]>(
      botId,
      `/instances/${encodeURIComponent(instanceId)}/tasks`,
    ),
  taskAction: (botId: string, taskId: string, action: "confirm" | "cancel") =>
    call<PanelTask>(botId, `/tasks/${encodeURIComponent(taskId)}/${action}`, {
      method: "POST",
    }),
};

export const panelKeys = {
  all: ["panels"] as const,
  list: (botId: string) => ["panels", "list", botId] as const,
  library: (botId: string) => ["panels", "library", botId] as const,
  session: (botId: string) => ["panels", "session", botId] as const,
  draft: (botId: string, draftId: string) =>
    ["panels", "draft", botId, draftId] as const,
  grants: (botId: string, instanceId: string) =>
    ["panels", "grants", botId, instanceId] as const,
  tasks: (botId: string, instanceId: string) =>
    ["panels", "tasks", botId, instanceId] as const,
};

export const panelListQueryOptions = (botId: string) =>
  queryOptions({
    queryKey: panelKeys.list(botId),
    queryFn: () => panelsApi.list(botId),
    retry: 1,
  });

export const panelLibraryQueryOptions = (botId: string) =>
  queryOptions({
    queryKey: panelKeys.library(botId),
    queryFn: () => panelsApi.library(botId),
  });

/** The open authoring session, polled while one exists so a Bot's draft shows up on its own. */
export const panelSessionQueryOptions = (botId: string, enabled = true) =>
  queryOptions({
    queryKey: panelKeys.session(botId),
    queryFn: () => panelsApi.session(botId),
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data ? 4000 : false),
  });

export function panelErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return (
    {
      state_reset_required:
        "此版本与您的已保存状态不兼容。确认后仅重置您自己的状态。",
      state_revision_conflict: "面板状态已在别处更新，请重新加载面板。",
      instance_version_conflict: "面板已被修改，请刷新后重新编辑。",
      draft_revision_conflict: "草稿已有新版本，请刷新后继续。",
      library_version_conflict: "面板库已有新版本，请重新打开编辑。",
      panel_permission_refused: "当前用户没有此 BOT 的面板权限。",
      panel_grant_required: "请先在面板的能力列表中批准此操作。",
      panel_adapter_refused: "此能力不在部署允许的适配器中。",
      task_result_unknown:
        "任务已确认，但执行结果暂不确定。只会查询状态，不会再次执行。",
      active_panel_limit: "已达到活跃面板上限，请折叠其他面板后重试。",
      panel_runtime_timeout: "面板运行超时，已暂停。其他页面仍可使用。",
      panel_bot_unavailable: "此 BOT 不可用。",
      unauthenticated: "登录已过期，请重新登录。",
    }[code] ??
    (code && /[\u4e00-\u9fa5]/.test(code)
      ? code
      : "操作未完成，您的草稿和原面板已保留。请刷新后重试。")
  );
}

/** Begin a panel authoring session for a Bot; the chat then carries it to the Bot. */
export const PANEL_AUTHORING_PROP = "panelAuthoring";

/**
 * 这句话是不是在让机器人「做一个面板」。只看明确的说法（建 / 做 / 创建 / 新建 / 生成 / 弄 / 加 + 面板），
 * 「面板库在哪」「这个面板怎么用」这类问题不算。
 */
export function asksForPanel(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  return (
    /(建立|建|做|创建|新建|生成|弄|加|添加|设计|搞|整)(一个|个|一块|块|一张|张)?[^，。？！,.?!]{0,12}面板/.test(
      t,
    ) && !/面板(库|怎么|在哪|是什么)/.test(t)
  );
}

/**
 * forwardedProps for a run on `botId`: the open authoring session, if any, so the server hands the
 * Bot the propose/revise draft tools for exactly that session.
 *
 * `botId` 必须是机器人自己的 id（runtimeAgentId），不是对话里 会话客户端 的 agentId
 * （`channel:channel_…`）。以前传的是后者，查不到会话，于是机器人拿不到面板工具，只能用 render_ui
 * 在对话里画一张卡，面板栏里什么也没有。
 *
 * `text` 明确在要一个面板、而右栏还没有创作会话时，顺手开一个（与点「新建」相同），这样机器人
 * 总能用面板工具保存，右栏也会显示「正在创建面板」。
 */
export async function panelAuthoringForwardedProps(
  botId: string | undefined,
  text = "",
  onBegan?: () => void,
): Promise<Record<string, unknown> | undefined> {
  if (!botId) return undefined;
  let session = await panelsApi.session(botId).catch(() => null);
  if (!session?.sessionId && asksForPanel(text)) {
    session = await panelsApi.begin(botId).catch(() => null);
    if (session?.sessionId) onBegan?.();
  }
  return session?.sessionId
    ? { [PANEL_AUTHORING_PROP]: { sessionId: session.sessionId } }
    : undefined;
}
