import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { useBotNames } from "@/lib/agents/bot-names";
import { auditFailureLabel, computerActionLabel } from "@/lib/audit/action-label";
import {
  DID_NOT_HAPPEN_EVENT_TYPES,
  eventTypeFilter,
  outcomeOf,
  REFUSED_EVENT_TYPES,
} from "@/lib/audit/outcome";
import { auditEventsQueryOptions } from "@/lib/audit/queries";
import { silenceOf } from "@/lib/audit/silence";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events.
 */
export const Route = createFileRoute("/_authed/admin/audit")({
  component: AuditPage,
});

/** One row as the API returns it. */
type AuditEvent = {
  id: string;
  actorUserId: string | null;
  /** Absent on a deployment that has not migrated yet. */
  initiatorKind?: string;
  initiatorId?: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

/*
 * The saved views, built from the same lists the row label and colour are decided by.
 *
 * Written out by hand here and again below, they had already drifted: a refusal on one list and not
 * the other is a row drawn as "Allowed" or a row missing from the view somebody clicks to ask what
 * this deployment refused. See `@/lib/audit/outcome`, which is now the only place either question is
 * answered.
 */
const FILTERS = [
  { label: "全部", search: "" },
  { label: "电脑操作", search: "?eventType=computer.action_allowed" },
  { label: "已阻止", search: eventTypeFilter(REFUSED_EVENT_TYPES) },
  {
    label: "未发生",
    search: eventTypeFilter(DID_NOT_HAPPEN_EVENT_TYPES),
  },
  {
    label: "后台发起",
    search: "?initiatorKind=routine,handoff,responsibility,memory",
  },
] as const;

function AuditPage() {
  const [search, setSearch] = useState<string>(FILTERS[0].search);
  const events = useQuery(auditEventsQueryOptions(search));
  const rows = (events.data?.events ?? []) as AuditEvent[];
  const nameFor = useBotNames();

  return (
    /*
     * THE ONE WIDE PAGE IN ADMIN, and the one that keeps a table. Five columns of short values is
     * what a log is; rows of prose would make every entry a paragraph and the scanning this page
     * exists for impossible. It takes the same header and the same type scale as everything else,
     * and differs only where the content forces it to.
     */
    <PageShell
      action={
        <RefreshButton
          onRefresh={() => events.refetch({ throwOnError: true })}
          size="sm"
          variant="ghost"
        />
      }
      description={"机器人做过的每个操作，以及被规则拦下的操作。"}
      title={"活动记录"}
      width="wide"
    >
      <PageSection>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <Button
              key={filter.label}
              onClick={() => setSearch(filter.search)}
              size="sm"
              type="button"
              /* The fill is the state, as on every other set of switches in the app. */
              variant={search === filter.search ? "default" : "outline"}
            >
              {filter.label}
            </Button>
          ))}
        </div>

        {events.isPending ? <PageSkeleton /> : events.isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {"活动记录暂时读不到，刷新一下再试。"}
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>{"这一类还没有记录。"}</PageEmpty>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-card">
            <table className="audit-table w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs uppercase">
                <tr className="border-border border-b">
                  <th className="px-4 py-2 font-medium">{"时间"}</th>
                  <th className="px-4 py-2 font-medium">{"操作"}</th>
                  <th className="px-4 py-2 font-medium">{"对象"}</th>
                  <th className="px-4 py-2 font-medium">{"机器人"}</th>
                  <th className="whitespace-nowrap px-4 py-2 font-medium">{"谁发起"}</th>
                  <th className="px-4 py-2 font-medium">{"结果"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <Row event={event} key={event.id} nameFor={nameFor} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageSection>
    </PageShell>
  );
}

function StartedBy({
  event,
  nameFor,
}: {
  event: AuditEvent;
  nameFor: (botId: string) => string;
}) {
  if (event.initiatorKind === "routine") {
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-500"
        title={event.initiatorId ?? undefined}
      >
        {"定时任务"}
      </span>
    );
  }
  if (event.initiatorKind === "handoff") {
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-500"
        title={event.initiatorId ?? undefined}
      >
        {event.initiatorId ? `由 ${nameFor(event.initiatorId)} 传递` : "已移交"}
      </span>
    );
  }
  if (
    event.initiatorKind === "responsibility" ||
    event.initiatorKind === "memory"
  ) {
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-500"
        title={event.initiatorId ?? undefined}
      >
        {event.initiatorKind === "memory" ? "记忆源" : "长期任务"}
      </span>
    );
  }
  if (event.initiatorKind === "deployment") {
    return <span className="text-muted-foreground">{"此部署"}</span>;
  }
  return <span className="text-muted-foreground">{"个人"}</span>;
}

function Row({
  event,
  nameFor,
}: {
  event: AuditEvent;
  nameFor: (botId: string) => string;
}) {
  const payload = event.payload ?? {};
  const decision = (payload.decision ?? {}) as {
    allowed?: boolean;
    mode?: string;
    rule?: string | null;
    carriedOut?: boolean;
  };
  const element = payload.element as
    | { role?: string; name?: string }
    | string
    | undefined;
  const outcome = outcomeOf(event.eventType);
  const refused = outcome === "refused";
  const stalled = event.eventType === "agent.stream_stalled";
  /*
   * Three different things, and the difference is what somebody comes to this row to find out.
   *
   * A person naming a coworker, the router matching one, and the router giving up and using the
   * default are not the same event, and one label covering all three would make the row worth less
   * than the reason line under it. Nothing here is a refusal, so none of them take the refusal
   * colour.
   */
  const routed =
    event.eventType === "channel.routed"
      ? payload.viaMention === true
        ? "你点名了这个机器人"
        : payload.fallback === true
          ? "交给默认机器人"
          : "交给对应的机器人"
      : null;
  // Allowed by policy but not carried out. A stalled turn belongs in the same family: the Bot was
  // asked and the answer never arrived. Colour is how this table is read, and a row left in the
  // muted foreground reads as "Allowed", which a turn nobody ever got an answer to was not.
  const failed = outcome === "did-not-happen";
  const silence = stalled ? silenceOf(payload) : null;

  return (
    <tr className="border-border border-t align-top">
      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
        {new Date(event.createdAt).toLocaleTimeString("zh-CN")}
      </td>
      <td className="px-4 py-2 font-medium">
        {/* 电脑工具名中文化（DOG-02）；原始 computer_* 仍在 payload。 */}
        {typeof payload.action === "string" ? (
          computerActionLabel(payload.action)
        ) : (
          // 事件类型显示中文名，原始类型放悬停（CB-056，DESIGN.md §71.6）。
          <span title={event.eventType}>{eventLabel(event.eventType)}</span>
        )}
      </td>
      <td className="px-4 py-2">
        {/*
         * A routing row's subject is the coworker it went to, and it is the only thing on the row
         * worth reading. Its target type is `agent`, which is not a named target because everywhere
         * else an agent id appears it belongs in the Bot column; here nothing acted, so there is no
         * Bot and the target is all there is. Rendered through `nameFor` so it reads as the name on
         * the roster rather than the immutable id.
         */}
        {event.eventType === "channel.routed" && event.targetId ? (
          <span title={event.targetId}>{nameFor(event.targetId)}</span>
        ) : /*
         * A discovery row's subject is the narrowing itself, so the numbers are the subject. A
         * reader asking "why did it not call the tool" needs to see that eleven of thirty were
         * offered before anything else on the row means anything.
         */
        event.eventType === "mcp.tools_discovered" ? (
          <span className="font-mono text-xs">
            {typeof payload.offered === "number" &&
            typeof payload.granted === "number"
              ? `提供 ${payload.offered} / ${payload.granted} 个工具`
              : "-"}
          </span>
        ) : /* Named targets and file paths are the audit subject before page elements. */
        NAMED_TARGETS.has(event.targetType) && event.targetId ? (
          <span className="font-mono text-xs">
            {event.targetId}
            {typeof payload.function === "string" ? (
              <span className="text-muted-foreground">
                {" "}
                · {payload.function}
              </span>
            ) : null}
          </span>
        ) : typeof payload.file === "string" ? (
          <span className="font-mono text-xs">{payload.file}</span>
        ) : typeof payload.command === "string" ? (
          // The command is the subject of its own row, the way a path is for a file action.
          <span className="font-mono text-xs">{payload.command}</span>
        ) : typeof element === "object" && element?.name ? (
          <span>
            {element.name}
            {element.role ? (
              <span className="text-muted-foreground"> ({element.role})</span>
            ) : null}
          </span>
        ) : typeof element === "string" ? (
          <span className="text-muted-foreground">{auditFailureLabel(element)}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
        {/* Page host is meaningful only for browser actions, not workspace file actions. */}
        {typeof payload.file !== "string" &&
        typeof payload.command !== "string" &&
        typeof payload.page === "string" &&
        payload.page ? (
          <div className="text-xs text-muted-foreground">
            {hostOf(payload.page)}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-2 text-muted-foreground">
        {typeof payload.bot === "string" ? (
          // Keep the immutable bot id available even when names collide.
          <span title={payload.bot}>{nameFor(payload.bot)}</span>
        ) : (
          "-"
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-2">
        <StartedBy event={event} nameFor={nameFor} />
      </td>
      <td className="px-4 py-2">
        <span
          className={
            refused
              ? "font-medium text-destructive"
              : failed
                ? "font-medium text-amber-600 dark:text-amber-500"
                : "text-muted-foreground"
          }
        >
          {routed ??
            DECISIONS[event.eventType] ??
            (refused ? "已阻止" : failed ? "未发生" : "允许")}
        </span>
        {/* Refusal reasons mirror the conversation-facing reason. */}
        {(event.eventType === "component.refused" ||
          event.eventType === "component.function_refused" ||
          event.eventType === "mcp.call_rejected") &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 max-w-[22rem] break-words text-xs text-muted-foreground">
            {auditFailureLabel(payload.reason)}
          </div>
        ) : null}
        {/*
         * Why this run was offered what it was, which is the only part of a discovery row that
         * cannot be worked out from the numbers. "Nothing declared" and "selector unavailable" both
         * offer everything and mean entirely different things about the deployment.
         */}
        {event.eventType === "mcp.tools_discovered" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {DISCOVERY_REASONS[payload.reason] ?? payload.reason}
            {Array.isArray(payload.skills) && payload.skills.length > 0
              ? `：${payload.skills.join(", ")}`
              : ""}
          </div>
        ) : null}
        {event.eventType === "mcp.callback_refused" &&
        typeof payload.refusal === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.refusal}
          </div>
        ) : null}
        {/*
         * Why the conversation went where it went, which is the whole reason the row is written.
         * Without it a routing row says "Allowed" and names nobody, which is indistinguishable from
         * a row that failed to write.
         */}
        {event.eventType === "channel.routed" &&
        typeof payload.reason === "string" ? (
          /*
           * A width rather than a max-width, because the table lays itself out from its content and
           * a max-width on a block inside a cell does not constrain that. A router's reason is a
           * sentence a model wrote, not a rule name, and left unbounded in the last column it
           * pushes the table wider than the page and the end of the sentence goes off the edge,
           * where nobody scrolls to find it.
           */
          <div className="mt-0.5 w-[22rem] break-words text-xs text-muted-foreground">
            {payload.reason}
          </div>
        ) : null}
        {event.eventType === "bot.declined" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
            <span className="italic">{", 由机器人本身报告"}</span>
          </div>
        ) : null}
        {failed && typeof payload.failure === "string" ? (
          <div className="mt-0.5 max-w-[22rem] break-words text-xs text-muted-foreground">
            {auditFailureLabel(payload.failure)}
          </div>
        ) : null}
        {/*
         * The two numbers the stall row is worth reading for. Without them every stalled turn looks
         * the same, and the difference between an endpoint that dies halfway through an answer and
         * one that never begins is the difference between a slow Bot and a dead one.
         */}
        {silence ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{silence}</div>
        ) : null}
        {/* Show concrete policy rules, but suppress the uninformative default `true` allow rule. */}
        {decision.rule && decision.rule !== "true" ? (
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {decision.rule}
          </div>
        ) : null}
        {decision.mode === "dry-run" &&
        decision.allowed === false &&
        decision.carriedOut ? (
          <div className="text-xs text-muted-foreground">
            试运行：只记录，没有拦
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Target types whose id is a name worth putting on screen.
 *
 * Anything else falls through to the element or file subject.
 */
/**
 * Why a run was offered the tools it was, in words rather than in the slug the server writes.
 *
 * Every one of these looks the same from outside: the Bot was handed some tools. The distinction is
 * the difference between a deployment that narrowed on purpose, one that has never declared a skill,
 * and one whose selector could not be reached, and only the last is a fault.
 */
const DISCOVERY_REASONS: Record<string, string> = {
  "under-floor": "工具不多，全部提供",
  "nothing-declared": "没有技能声明这些工具",
  unavailable: "没法挑选，全部提供",
  "nothing-chosen": "没有对得上的技能，全部提供",
  selected: "按技能挑选",
};

const NAMED_TARGETS = new Set([
  "component",
  "mcp_tool",
  "mcp_server",
  "skill",
  "credential",
]);

const DECISIONS: Record<string, string> = {
  "bot.declined": "机器人拒绝了",
  // Not a refusal, so not the refusal colour: nothing was blocked. The Bot was asked and never
  // answered, which is the same complaint as an action that was allowed and then did not happen.
  "agent.stream_stalled": "机器人没有回应",
  "computer.policy_loaded": "启动时载入权限规则",
  "computer.isolation_loaded": "启动时载入隔离设置",
  "computer.control_taken": "你接管了电脑",
  "computer.control_released": "交还给机器人",
  "computer.help_requested": "机器人请你帮忙",
  "computer.secret_requested": "机器人要一个密钥",
  "computer.secret_supplied": "你提供了密钥",
  "computer.reset": "电脑已重置",
  "computer.updated": "电脑已更新",
  "computer.stopped": "你按了停止",

  "component.granted": "已授予此机器人",
  "component.revoked": "已从此机器人收回",
  "component.published": "已发布，所有机器人均可使用",
  "component.unpublished": "未发布，任何机器人都不能使用",
  "component.draft_saved": "草稿已保存，尚未发布",
  "component.refused": "已拒绝",
  "component.function_granted": "可读取",
  "component.function_revoked": "不再可读取",
  "component.function_called": "读取了真实数据",
  "component.function_refused": "已拒绝",
  // A function failure is execution failure, not a policy refusal.
  "component.function_failed": "无法读取",

  // Not a call and not a decision: the tools this run was allowed to see. Worded so nobody reads it
  // as permission, which it is not — everything named was already granted.
  "mcp.tools_discovered": "这一轮可用的工具",
  "mcp.call_succeeded": "代机器人调用",
  "mcp.call_rejected": "已阻止",
  "mcp.call_failed": "服务器没有响应",
  // Not "已阻止": nothing about the Bot was judged, because nothing proved which Bot it was.
  "mcp.callback_refused": "无法确认是哪个机器人",

  "configuration.changed": "配置已更改",
  "credential.created": "凭据已保存",
};

/** 「操作」列：事件类型的中文名。没收录的按「对象 + 动作」拼，再不行显示原始类型。 */
const EVENT_LABELS: Record<string, string> = {
  "computer.action_allowed": "电脑操作",
  "computer.action_failed": "电脑操作失败",
  "computer.action_refused": "电脑操作被拦",
  "computer.policy_loaded": "载入权限规则",
  "computer.isolation_loaded": "载入隔离设置",
  "computer.control_taken": "接管电脑",
  "computer.control_released": "交还电脑",
  "computer.help_requested": "请求帮忙",
  "computer.reset": "重置电脑",
  "bot.created": "新建机器人",
  "bot.deleted": "删除机器人",
  "bot.updated": "修改机器人",
  "bot.reset": "重置机器人",
  "bot.declined": "机器人拒绝",
  "bot.follow_up_scheduled": "安排跟进",
  "configuration.changed": "修改设置",
  "mcp.tools_discovered": "准备工具",
  "panel.action": "面板操作",
  "channel.routed": "分配对话",
  "channel.deleted": "删除对话",
  "component.published": "发布组件",
  "workflow.run_started": "工作流开始",
  "workflow.run_finished": "工作流结束",
  "workflow.approval_decided": "工作流审批",
  "agent.stream_stalled": "回答中断",
};
const EVENT_NOUNS: Record<string, string> = {
  bot: "机器人", agent: "机器人", computer: "电脑", configuration: "设置", channel: "对话", component: "组件", credential: "凭据",
  skill: "技能", mcp: "工具", panel: "面板", workflow: "工作流", routines: "定时任务", session: "登录", memory: "记忆",
};
const EVENT_VERBS: Record<string, string> = {
  created: "新建", deleted: "删除", updated: "修改", changed: "修改", reset: "重置", published: "发布", unpublished: "取消发布",
  granted: "授予", revoked: "收回", refused: "被拒绝", failed: "失败", started: "开始", finished: "结束",
};
function eventLabel(type: string): string {
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  const [noun, verb] = type.split(".");
  const n = EVENT_NOUNS[noun ?? ""];
  const v = EVENT_VERBS[(verb ?? "").split("_").pop() ?? ""];
  return n && v ? `${v}${n}` : type;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
