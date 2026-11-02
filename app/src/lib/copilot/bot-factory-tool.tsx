import { useRenderTool } from "@copilotkit/react-core/v2";
import { IconChevronDown, IconRobot } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { invalidateAgents } from "@/lib/agents/mutations";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { latestChannelFor } from "@/lib/channels/latest";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useToolActivityVisible } from "@/lib/chat/tool-activity";
import { asText } from "@/lib/plugins/tool-result";
import { queryClient as sharedQueryClient } from "@/query-client";

/**
 * 机器人建机器人的四个工具（`create_bot` / `list_managed_bots` / `update_bot` / `disable_bot`）
 * 在对话里的样子。
 *
 * RENDER ONLY，和旁边的 message_bot 同理：工具在服务器上跑，授权、上限、审批卡都在那边。
 * 步骤抽屉里画成单行 ToolLine；主对话流里画成和往来卡同一副面孔的锚点卡——建出来的机器人
 * 直接附「去和这个 bot 聊天」链接。审批卡在「待处理」里由服务器给的 target 画出名字、职责、
 * 完整提示词和模型（inbox.tsx 的 HandOffCard 调本文件的 botFactoryApprovalSpec）。
 */
const createParameters = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  roleDescription: z.string().optional(),
  model: z.string().optional(),
});

const updateParameters = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  roleDescription: z.string().optional(),
  model: z.string().optional(),
});

const disableParameters = z.object({ id: z.string().optional() });
const listParameters = z.object({});

export type FactoryToolName =
  | "create_bot"
  | "list_managed_bots"
  | "update_bot"
  | "disable_bot";

export type FactoryCardState = "running" | "done" | "refused";

/**
 * 工具结果解码后是不是「做成了」。服务端的结果以 JSON 字符串过网络，先 asText 还原再比开头：
 * 建 / 改有固定成功话术，停用的话术是「…is paused:」；`list_managed_bots` 不走审批也没有拒绝路径。
 * 不是字符串的结果按没做成画（和 handoff 的约定一致：读不懂的不当成功）。
 */
export function factorySucceeded(
  tool: FactoryToolName,
  result: unknown,
): boolean {
  if (result === undefined) return true;
  if (typeof result !== "string") return false;
  const text = asText(result).trim();
  switch (tool) {
    case "create_bot":
      return text.startsWith("Created the Bot ");
    case "update_bot":
      // 「资料改了但模型没改成」算做成了：资料确实更新了，那句话由卡片原样展示。
      return (
        text.startsWith("Updated the Bot ") ||
        text.startsWith("The profile was updated")
      );
    case "disable_bot":
      return text.includes(" is paused:");
    case "list_managed_bots":
      return true;
  }
}

function resultText(result: unknown): string {
  return typeof result === "string" ? asText(result).trim() : "";
}

/** create_bot 成功话术末尾的 `Its details: {json}`，从中拿到新 bot 的 id 做聊天链接。 */
export function createdBotFrom(
  result: unknown,
): { id: string; name: string } | null {
  const match = /Its details: (\{[\s\S]*\})\s*$/.exec(resultText(result));
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      const row = parsed as { id: string; name?: unknown };
      return {
        id: row.id,
        name: typeof row.name === "string" ? row.name : row.id,
      };
    }
  } catch {
    // 话术改了就不是成功话术了——比对的正是开头；拿不到 id 只是没有链接。
  }
  return null;
}

/** `Updated the Bot "X" (id).` / `"X" (id) is paused:` 里的名字，拿来做卡片标题。 */
function quotedName(result: unknown): string | undefined {
  return /"([^"]{1,80})"/.exec(resultText(result))?.[1];
}

/** list_managed_bots 的 `[{id,name,paused,…}]`，解析不出就空列表。 */
export function managedBotsFrom(
  result: unknown,
): { id: string; name: string; paused: boolean }[] {
  const match = /^Bots you created: (\[[\s\S]*\])\s*$/.exec(resultText(result));
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) =>
      row &&
      typeof row === "object" &&
      typeof (row as { id?: unknown }).id === "string" &&
      typeof (row as { name?: unknown }).name === "string"
        ? [
            {
              id: (row as { id: string }).id,
              name: (row as { name: string }).name,
              paused: (row as { paused?: unknown }).paused === true,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

/**
 * 「待处理」里 bot/ 审批卡的规格行：服务器把要建的东西放在 `action.target`，
 * 卡片据此画出名字、职责、完整提示词和模型（千咲 §9 的要求），不是一坨 args JSON。
 */
export function botFactoryApprovalSpec(
  toolRef: string,
  target: unknown,
): { verb: string; rows: { label: string; value: string }[] } | null {
  const spec =
    target && typeof target === "object"
      ? (target as Record<string, unknown>)
      : {};
  const s = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;
  const who = s(spec.name) ?? s(spec.bot) ?? "";
  switch (toolRef) {
    case "bot/create_bot":
      return {
        verb: "创建机器人",
        rows: [
          { label: "名字", value: who },
          { label: "职责", value: s(spec.title) ?? "" },
          { label: "提示词", value: s(spec.roleDescription) ?? "" },
          { label: "模型", value: s(spec.model) ?? "部署默认" },
        ],
      };
    case "bot/update_bot":
      return {
        verb: "修改机器人",
        rows: who ? [{ label: "机器人", value: who }] : [],
      };
    case "bot/disable_bot":
      return {
        verb: "停用机器人",
        rows: who ? [{ label: "机器人", value: who }] : [],
      };
    default:
      return null;
  }
}

/** 建 / 改 / 停成真后让机器人列表重读：新 bot 和「由 X 创建」徽章才有东西可画。 */
function useAgentsInvalidated(active: boolean) {
  useEffect(() => {
    if (active) void invalidateAgents(sharedQueryClient);
  }, [active]);
}

function BotChatLink({ bot }: { bot: { id: string; name: string } }) {
  // 左栏已加载过会话列表，只读缓存：有现成对话进对话，没有就开一个。
  const channels = useInfiniteQuery(
    { ...channelListQueryOptions(), enabled: false },
    sharedQueryClient,
  );
  const channelId = latestChannelFor(bot.id, channels.data)?.id;
  const text = `去和「${bot.name}」聊天 →`;
  return channelId ? (
    <Link
      className="bot-exchange-link"
      params={{ channelId }}
      to="/channel/$channelId"
    >
      {text}
    </Link>
  ) : (
    <Link
      className="bot-exchange-link"
      search={{ agent: bot.id }}
      to="/channel/new"
    >
      {text}
    </Link>
  );
}

export function FactoryCard({
  state,
  title,
  sub,
  badge,
  note,
  rows,
  linkBot,
}: {
  state: FactoryCardState;
  title: string;
  /** 折叠头第二行（可选）。 */
  sub?: string | undefined;
  badge: string;
  /** 展开后末尾那行说明：成功的后续、或拒绝原因原文。 */
  note?: string | undefined;
  rows?: readonly { label: string; value: string }[] | undefined;
  /** 有它就在展开区画「去和『X』聊天」。 */
  linkBot?: { id: string; name: string } | undefined;
}) {
  const [open, setOpen] = useState(false);
  useAgentsInvalidated(state === "done");
  return (
    <div
      className="bot-exchange-card"
      data-state={state}
      data-testid="bot-factory-card"
    >
      <button
        aria-expanded={open}
        className="bot-exchange-head"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span aria-hidden className="bot-exchange-ico">
          <IconRobot className="size-4" />
        </span>
        <span className="bot-exchange-main">
          <span className="bot-exchange-title">{title}</span>
          {sub ? <span className="bot-exchange-sub">{sub}</span> : null}
        </span>
        <span className="bot-exchange-badge">{badge}</span>
        <IconChevronDown
          aria-hidden
          className={`bot-exchange-chev size-4 ${open ? "is-open" : ""}`}
        />
      </button>
      {open ? (
        <div className="bot-exchange-body" data-testid="bot-factory-body">
          {(rows ?? [])
            .filter((row) => row.value)
            .map((row) => (
              <div className="bot-exchange-row" key={row.label}>
                <span className="bot-exchange-k">{row.label}</span>
                <span className="bot-exchange-v">{row.value}</span>
              </div>
            ))}
          {note ? <p className="bot-exchange-note">{note}</p> : null}
          {linkBot ? <BotChatLink bot={linkBot} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function factoryState(running: boolean, ok: boolean): FactoryCardState {
  return running ? "running" : ok ? "done" : "refused";
}

export function CreateBotCard({
  name,
  title,
  roleDescription,
  model,
  result,
  running,
  knownBots,
}: {
  name?: string | undefined;
  title?: string | undefined;
  roleDescription?: string | undefined;
  model?: string | undefined;
  result?: unknown;
  running: boolean;
  /** 可选注入（单测）；不传从机器人列表读。 */
  knownBots?: readonly { id: string; name: string }[] | undefined;
}) {
  const rosterQuery = useQuery(
    { ...agentListQueryOptions(), enabled: knownBots === undefined },
    sharedQueryClient,
  );
  const roster = knownBots ?? rosterQuery.data;
  const ok = factorySucceeded("create_bot", result);
  const created = ok && !running ? createdBotFrom(result) : null;
  // 话术里没有 id 时按名字在名册里找（同名取不到就算了，只影响链接）。
  const wanted = (created?.name ?? name ?? "").trim().toLowerCase();
  const matched =
    created ??
    (ok && wanted
      ? roster?.find((bot) => bot.name.toLowerCase() === wanted)
      : undefined);
  const state = factoryState(running, ok);
  const label = name?.trim() || "新机器人";
  return (
    <FactoryCard
      badge={running ? "创建中" : ok ? "已创建" : "已阻止"}
      linkBot={
        state === "done" && matched
          ? { id: matched.id, name: matched.name }
          : undefined
      }
      note={
        running
          ? "等你确认后才会真正创建。"
          : ok
            ? "已建好，你们已可以互相派活；它的授权只有这一条。"
            : resultText(result) || "没能创建这个机器人。"
      }
      rows={[
        { label: "名字", value: name ?? "" },
        { label: "职责", value: title ?? "" },
        { label: "提示词", value: roleDescription ?? "" },
        { label: "模型", value: model ?? "部署默认" },
      ]}
      state={state}
      sub={title}
      title={
        running
          ? `正在创建机器人「${label}」…`
          : ok
            ? `创建了机器人「${created?.name ?? label}」`
            : `没能创建机器人「${label}」`
      }
    />
  );
}

export function ManagedBotsCard({
  result,
  running,
}: {
  result?: unknown;
  running: boolean;
}) {
  const bots = running ? [] : managedBotsFrom(result);
  return (
    <FactoryCard
      badge={running ? "查看中" : "已列出"}
      note={
        running
          ? "正在数它创建的机器人…"
          : bots.length === 0
            ? "它还没有创建过机器人。"
            : `它创建的 ${bots.length} 个机器人：`
      }
      rows={bots.map((bot) => ({
        label: bot.paused ? "已暂停" : "机器人",
        value: bot.name,
      }))}
      state={running ? "running" : "done"}
      title={"查看了它创建的机器人"}
    />
  );
}

export function UpdateBotCard({
  id,
  fields,
  result,
  running,
}: {
  id?: string | undefined;
  /** 只放这次给的字段，没给的不画。 */
  fields: { label: string; value: string }[];
  result?: unknown;
  running: boolean;
}) {
  const ok = factorySucceeded("update_bot", result);
  const name = quotedName(result) ?? id ?? "机器人";
  const state = factoryState(running, ok);
  return (
    <FactoryCard
      badge={running ? "修改中" : ok ? "已更新" : "已阻止"}
      note={
        running
          ? "等你确认后才会真正修改。"
          : ok
            ? undefined
            : resultText(result) || "没能修改这个机器人。"
      }
      rows={fields}
      state={state}
      title={
        running
          ? `正在修改机器人「${name}」…`
          : ok
            ? `更新了机器人「${name}」`
            : `没能修改机器人「${name}」`
      }
    />
  );
}

export function DisableBotCard({
  id,
  result,
  running,
}: {
  id?: string | undefined;
  result?: unknown;
  running: boolean;
}) {
  const ok = factorySucceeded("disable_bot", result);
  const name = quotedName(result) ?? id ?? "机器人";
  const state = factoryState(running, ok);
  return (
    <FactoryCard
      badge={running ? "停用中" : ok ? "已停用" : "已阻止"}
      note={
        running
          ? "等你确认后才会真正停用。"
          : ok
            ? "已停用：它不再接对话和派活，可以在机器人页面重新打开——停用不是删除。"
            : resultText(result) || "没能停用这个机器人。"
      }
      state={state}
      title={
        running
          ? `正在停用机器人「${name}」…`
          : ok
            ? `停用了机器人「${name}」`
            : `没能停用机器人「${name}」`
      }
    />
  );
}

export function BotFactoryTool() {
  const inStepDrawer = useToolActivityVisible();

  useRenderTool({
    name: "create_bot",
    parameters: createParameters,
    render: ({ parameters: given, result, status }) => {
      const running = status !== "complete" && result === undefined;
      if (inStepDrawer) {
        return (
          <ToolLine
            detail={given?.name}
            label={running ? "正在创建机器人" : "创建了机器人"}
            refused={!running && !factorySucceeded("create_bot", result)}
            running={running}
          >
            <div className="space-y-1 text-sm">
              {given?.title ? <p>{`职责：${given.title}`}</p> : null}
              {given?.roleDescription ? (
                <p className="text-muted-foreground">
                  {"提示词："}
                  {given.roleDescription}
                </p>
              ) : null}
              {typeof result === "string" ? (
                <p className="text-muted-foreground">{resultText(result)}</p>
              ) : null}
            </div>
          </ToolLine>
        );
      }
      return (
        <CreateBotCard
          model={given?.model}
          name={given?.name}
          result={result}
          roleDescription={given?.roleDescription}
          running={running}
          title={given?.title}
        />
      );
    },
  });

  useRenderTool({
    name: "list_managed_bots",
    parameters: listParameters,
    render: ({ result, status }) => {
      const running = status !== "complete" && result === undefined;
      if (inStepDrawer) {
        return <ToolLine label={"查看了它创建的机器人"} running={running} />;
      }
      return <ManagedBotsCard result={result} running={running} />;
    },
  });

  useRenderTool({
    name: "update_bot",
    parameters: updateParameters,
    render: ({ parameters: given, result, status }) => {
      const running = status !== "complete" && result === undefined;
      const fields = [
        { label: "名字", value: given?.name ?? "" },
        { label: "职责", value: given?.title ?? "" },
        { label: "提示词", value: given?.roleDescription ?? "" },
        { label: "模型", value: given?.model ?? "" },
      ].filter((row) => row.value);
      if (inStepDrawer) {
        return (
          <ToolLine
            detail={given?.id}
            label={running ? "正在修改机器人" : "修改了机器人"}
            refused={!running && !factorySucceeded("update_bot", result)}
            running={running}
          >
            <div className="space-y-1 text-sm">
              {fields.map((row) => (
                <p className="text-muted-foreground" key={row.label}>
                  {`${row.label}：${row.value}`}
                </p>
              ))}
              {typeof result === "string" ? (
                <p className="text-muted-foreground">{resultText(result)}</p>
              ) : null}
            </div>
          </ToolLine>
        );
      }
      return (
        <UpdateBotCard
          fields={fields}
          id={given?.id}
          result={result}
          running={running}
        />
      );
    },
  });

  useRenderTool({
    name: "disable_bot",
    parameters: disableParameters,
    render: ({ parameters: given, result, status }) => {
      const running = status !== "complete" && result === undefined;
      if (inStepDrawer) {
        return (
          <ToolLine
            detail={given?.id}
            label={running ? "正在停用机器人" : "停用了机器人"}
            refused={!running && !factorySucceeded("disable_bot", result)}
            running={running}
          />
        );
      }
      return (
        <DisableBotCard id={given?.id} result={result} running={running} />
      );
    },
  });

  return null;
}
