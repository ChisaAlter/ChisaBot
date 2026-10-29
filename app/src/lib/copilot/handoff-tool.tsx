import { useRenderTool } from "@copilotkit/react-core/v2";
import { IconArrowsExchange, IconChevronDown } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { latestChannelFor } from "@/lib/channels/latest";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useToolActivityVisible } from "@/lib/chat/tool-activity";
import { HANDED_OVER } from "@/lib/copilot/markers";
import { saidItWentAhead } from "@/lib/plugins/tool-result";
import { queryClient as sharedQueryClient } from "@/query-client";

/**
 * 机器人之间的往来视图（CB-093，DESIGN.md §116）。
 *
 * 当机器人在单聊里调用 `message_bot` 询问另一个机器人时：
 * - 在步骤抽屉（useToolActivityVisible = true）里画成单行 ToolLine；
 * - 在主对话流里画成可展开的「机器人往来锚点卡」（BotExchangeCard）：折叠时只留一行「与『B』往来 · 已转交」，
 *   点开可看 A 发给 B 的任务、约束、期望输出及转交状态；若到达往来深度上限或对方已被删除，在锚点上如实注明。
 */
const parameters = z.object({
  bot: z.string().optional(),
  task: z.string().optional(),
  constraints: z.string().optional(),
  expecting: z.string().optional(),
});

export type HandoffCardState = "running" | "handed-over" | "depth-cap" | "deleted" | "refused";

export type HandoffStatusSummary = {
  state: HandoffCardState;
  title: string;
  badge: string;
  note: string;
};

export function refusedHandoff(result: unknown): boolean {
  return !saidItWentAhead(result, HANDED_OVER);
}

export function describeHandoffStatus(input: {
  asked?: string | undefined;
  running: boolean;
  result?: unknown;
  /** roster 已加载且找不到该机器人（已被删除）。 */
  targetDeleted?: boolean | undefined;
}): HandoffStatusSummary {
  const target = input.asked?.trim() || "另一个机器人";
  if (input.running) {
    return {
      state: "running",
      title: `正在询问「${target}」…`,
      badge: "询问中",
      note: "正在将任务转交给对方并等待回复…",
    };
  }
  const raw = typeof input.result === "string" ? input.result.trim() : "";
  const wentAhead = !refusedHandoff(input.result);

  if (wentAhead) {
    if (input.targetDeleted) {
      return {
        state: "deleted",
        title: `与「${target}」往来`,
        badge: "对方已删除",
        note: "已发起过往来，但该机器人已被删除。",
      };
    }
    return {
      state: "handed-over",
      title: `与「${target}」往来`,
      badge: "已转交",
      note: `已交给「${target}」处理，结果会由当前机器人在这段对话里转述给你。`,
    };
  }

  const isDepthOrFanoutCap =
    /already \d+ Bots? deep|already asked \d+ Bots?|does not let one Bot hand work|上限/i.test(raw);
  if (isDepthOrFanoutCap) {
    return {
      state: "depth-cap",
      title: `与「${target}」往来已达上限`,
      badge: "已达上限",
      note: "已达到单轮机器人往来次数或深度上限，由当前机器人直接为你作答。",
    };
  }

  if (input.targetDeleted || /no Bot called|找不到/i.test(raw)) {
    return {
      state: "deleted",
      title: `与「${target}」往来`,
      badge: "对方已删除",
      note: `找不到「${target}」（可能已被删除或不可见）。`,
    };
  }

  const friendlyNote = /not been given/i.test(raw)
    ? `当前机器人还没有获得询问「${target}」的授权。`
    : /is paused/i.test(raw)
      ? `「${target}」目前处于暂停状态，未发送请求。`
      : raw || "未能转交给对方机器人。";

  return {
    state: "refused",
    title: `未能转交「${target}」`,
    badge: "已阻止",
    note: friendlyNote,
  };
}

export function BotExchangeCard({
  asked,
  task,
  constraints,
  expecting,
  running,
  result,
  knownBots,
}: {
  asked?: string | undefined;
  task?: string | undefined;
  constraints?: string | undefined;
  expecting?: string | undefined;
  running: boolean;
  result?: unknown;
  /** 可选传入（方便单测直接注入）；不传时从 agentListQueryOptions 读。 */
  knownBots?: readonly { id: string; name: string; hidden?: boolean }[] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const rosterQuery = useQuery(
    {
      ...agentListQueryOptions(),
      enabled: knownBots === undefined,
    },
    sharedQueryClient,
  );
  const roster = knownBots ?? rosterQuery.data;
  const wanted = asked?.trim().toLowerCase() ?? "";
  const matchedBot =
    wanted && roster
      ? roster.find(
          (b) => !b.hidden && (b.id.toLowerCase() === wanted || b.name.toLowerCase() === wanted),
        )
      : undefined;
  // 「去「X」的对话」是它正在用的那段对话：左栏已经加载过会话列表，这里只读缓存、不另外请求。
  // /channel/new 本身总是开新话题，所以有对话时直接链到那个频道。
  const channels = useInfiniteQuery(
    { ...channelListQueryOptions(), enabled: false },
    sharedQueryClient,
  );
  const matchedChannelId = matchedBot
    ? latestChannelFor(matchedBot.id, channels.data)?.id
    : undefined;
  const targetDeleted = Boolean(wanted && roster && !matchedBot);

  const summary = describeHandoffStatus({
    asked,
    running,
    result,
    targetDeleted,
  });

  return (
    <div
      className="bot-exchange-card"
      data-state={summary.state}
      data-testid="bot-exchange-card"
    >
      <button
        aria-expanded={open}
        className="bot-exchange-head"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span aria-hidden className="bot-exchange-ico">
          <IconArrowsExchange className="size-4" />
        </span>
        <span className="bot-exchange-main">
          <span className="bot-exchange-title">{summary.title}</span>
          {task ? <span className="bot-exchange-sub">{task}</span> : null}
        </span>
        <span className="bot-exchange-badge">{summary.badge}</span>
        <IconChevronDown
          aria-hidden
          className={`bot-exchange-chev size-4 ${open ? "is-open" : ""}`}
        />
      </button>
      {open ? (
        <div className="bot-exchange-body" data-testid="bot-exchange-body">
          {task ? (
            <div className="bot-exchange-row">
              <span className="bot-exchange-k">{"委派任务"}</span>
              <span className="bot-exchange-v">{task}</span>
            </div>
          ) : null}
          {constraints ? (
            <div className="bot-exchange-row">
              <span className="bot-exchange-k">{"约束条件"}</span>
              <span className="bot-exchange-v">{constraints}</span>
            </div>
          ) : null}
          {expecting ? (
            <div className="bot-exchange-row">
              <span className="bot-exchange-k">{"期望输出"}</span>
              <span className="bot-exchange-v">{expecting}</span>
            </div>
          ) : null}
          <p className="bot-exchange-note">{summary.note}</p>
          {matchedBot ? (
            matchedChannelId ? (
              <Link
                className="bot-exchange-link"
                params={{ channelId: matchedChannelId }}
                to="/channel/$channelId"
              >
                {`去「${matchedBot.name}」的对话 →`}
              </Link>
            ) : (
              <Link
                className="bot-exchange-link"
                search={{ agent: matchedBot.id }}
                to="/channel/new"
              >
                {`去「${matchedBot.name}」的对话 →`}
              </Link>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function HandoffTool() {
  const inStepDrawer = useToolActivityVisible();
  useRenderTool({
    name: "message_bot",
    parameters,
    render: ({ parameters: given, result, status }) => {
      const asked = given?.bot?.trim();
      const running = status !== "complete" && result === undefined;
      if (inStepDrawer) {
        return (
          <ToolLine
            detail={given?.task}
            label={asked ? `询问了 ${asked}` : "询问了另一个机器人"}
            refused={!running && refusedHandoff(result)}
            running={running}
          >
            <div className="space-y-1 text-sm">
              {given?.task ? <p>{given.task}</p> : null}
              {given?.constraints ? (
                <p className="text-muted-foreground">
                  {"约束："}
                  {given.constraints}
                </p>
              ) : null}
              {given?.expecting ? (
                <p className="text-muted-foreground">
                  {"想要回来："}
                  {given.expecting}
                </p>
              ) : null}
              {typeof result === "string" ? (
                <p className="text-muted-foreground">{result}</p>
              ) : null}
            </div>
          </ToolLine>
        );
      }
      return (
        <BotExchangeCard
          asked={asked}
          constraints={given?.constraints}
          expecting={given?.expecting}
          result={result}
          running={running}
          task={given?.task}
        />
      );
    },
  });

  return null;
}
