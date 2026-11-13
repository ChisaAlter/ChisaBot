import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { BrowseChip } from "@/components/computer/browse-chip";
import { CommandOutput } from "@/components/computer/command-output";
import { ScreenshotCard } from "@/components/computer/screenshot-card";
import { noteBrowsed, recordActivity } from "@/lib/computers/activity";
import type { ToolOutcome } from "@/lib/computers/call";
import {
  describeComputerToolCall,
  lastComputerStatusFor,
  reportComputerActivity,
  reportComputerStatus,
} from "@/lib/conversations/computer-activity";
import {
  COMMAND_DEFAULT_TIMEOUT_SEC,
  COMMAND_MAX_TIMEOUT_SEC,
} from "../../../../shared/command-timeout";
import { formatBytes } from "../../../../shared/computer-activity-labels";
import { useComputerToolRenderer } from "./approval-tools";

/**
 * Frontend registrations for computer tools, including inline rendering and policy-refusal display.
 */

export type { ToolOutcome } from "@/lib/computers/call";
/** What every computer call returns to the model: either the result, or a reason it did not happen. */
export { callComputer } from "@/lib/computers/call";

/** What a computer tool's render can read back out of its own result. */
type ComputerOutcome = {
  ok?: boolean;
  stopped?: boolean;
  humanHasControl?: boolean;
  entries?: unknown[];
  /** computer_tabs action=new 带网址时，新标签里打开的那页。 */
  page?: { url?: string; title?: string };
  refused?: boolean;
  reason?: string;
  staleRefs?: boolean;
  elements?: unknown[];
  element?: { role?: string; name?: string };
  /** What a shell call reports back, so the line can show the output rather than only the command. */
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** The far side cut the output short, or stopped the command. */
  truncated?: boolean;
  timedOut?: boolean;
  /** A file write. The size, never what was written. */
  bytes?: number;
  /** A file read. Named `text` on the way back and `contents` on the way in. */
  text?: string;
  /** Where a navigation landed, which is what a finished turn's screen tile remembers. */
  url?: string;
  title?: string;
};

/**
 * What a call printed, as text a person can read.
 *
 * One helper because the three surfaces this feeds all want the same thing and shape it differently:
 * a command has `stdout` and `stderr`, a file read has `contents`, a listing has `entries`. A refusal
 * carries only its reason, and that is the most useful thing on the line.
 *
 * Never guesses. Something with none of those fields gives an empty string, and the pane says the
 * call printed nothing rather than inventing a summary.
 */
export function outputOf(result: ToolOutcome): string {
  if (result.refused === true || result.ok === false) {
    return typeof result.reason === "string" ? result.reason : "";
  }

  // `text`, which is what the read route answers with. Not `contents`: that is the name on the way
  // in, and reading it back gave an empty pane for a file the Bot had just read out loud.
  if (typeof result.text === "string") return result.text;

  if (Array.isArray(result.entries)) {
    return result.entries
      .map((entry) => {
        if (!entry || typeof entry !== "object") return String(entry);
        const { path, kind, bytes } = entry as Record<string, unknown>;
        const label = String(path ?? "");
        // A trailing slash for a folder, the way a terminal marks one, so a listing of a workspace
        // full of folders does not read as a list of extensionless files.
        if (kind === "folder") return `${label}/`;
        return typeof bytes === "number" ? `${label}  ${bytes} bytes` : label;
      })
      .join("\n");
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  // Both, in the order a terminal shows them, and labelled only when there is something on stderr:
  // most commands write nothing there and a permanent empty heading is noise.
  return stderr ? `${stdout}${stdout ? "\n" : ""}${stderr}` : stdout;
}

/**
 * Parse the SDK-render result string so the transcript can distinguish success, refusal, and failure.
 */
function outcomeOf(result: string | undefined): ComputerOutcome {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ComputerOutcome)
      : {};
  } catch {
    // Runtime stringifies thrown handlers as "Error: <message>".
    return result.startsWith("Error:")
      ? { ok: false, reason: result.slice("Error:".length).trim() }
      : {};
  }
}

/**
 * The label of the element an action touched, as the gateway resolved it server-side.
 *
 * Not taken from the model's arguments: those carry only a ref. The server looked the element up in
 * the snapshot it took itself, which is the same value it wrote to the audit trail, so the transcript
 * and the audit row name the thing identically.
 */
function labelOf(result: string | undefined): string | undefined {
  const element = (outcomeOf(result) as { element?: { name?: unknown } })
    .element;
  const name = element?.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/** 原生下拉框选中的那一项（computer_type / computer_click 结果里的 selected.label，§100）。 */
export function selectedLabel(result: string | undefined): string | undefined {
  const selected = (outcomeOf(result) as { selected?: unknown }).selected;
  const label =
    selected && typeof selected === "object" && "label" in selected
      ? (selected as { label?: unknown }).label
      : undefined;
  return typeof label === "string" && label.trim() ? label.trim() : undefined;
}

/**
 * A compact transcript line that distinguishes policy refusals from ordinary failures.
 */
function ActionLine({
  label,
  detail,
  running,
  refused,
  failed,
}: {
  label: string;
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
}) {
  return (
    <ToolLine
      detail={detail}
      failed={failed}
      label={label}
      refused={refused}
      running={running}
    />
  );
}

/** Whether a result is an ordinary failure rather than a refusal, so the two can render differently. */
function didNotWork(outcome: ComputerOutcome): boolean {
  return outcome.ok === false && outcome.refused !== true;
}

export function ComputerTools() {
  useComputerToolRenderer({
    name: "computer_navigate",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      url: z
        .string()
        .describe(
          "Full web address to open, including https://. Your own workspace files are at https://workspace.local/<path>.",
        ),
    }),
    render: ({ result, status, args }) => {
      /*
       * The page this turn left open, so reopening the conversation shows what it browsed rather
       * than what the Bot has open now. Only once the turn is finished: while it runs, the live
       * frames are its own.
       */
      /*
       * A RESULT IS WHAT MAKES A TURN OVER, not the status.
       *
       * A restored tool call arrives with its result already in hand and a status that is briefly
       * something other than complete, so keying on the status alone made every reopened turn look
       * like one still running: the tile polled the live screen, put today's page under yesterday's
       * answer, and only then restored the frame it should have shown from the start.
       */
      const finished = status === "complete" || result !== undefined;
      const outcome = finished ? outcomeOf(result) : {};
      const page =
        typeof outcome.url === "string"
          ? {
              url: outcome.url,
              ...(typeof outcome.title === "string"
                ? { title: outcome.title }
                : {}),
            }
          : undefined;
      // 一行小条（BrowseChip），画面在右栏「计算机」里；失败 / 拒绝时说清楚。
      return (
        <BrowseChip
          state={
            !finished ? "running" : outcome.ok === false ? "failed" : "done"
          }
          {...(page?.title ? { title: page.title } : {})}
          {...(page?.url
            ? { url: page.url }
            : typeof (args as { url?: unknown } | undefined)?.url === "string"
              ? { url: (args as { url: string }).url }
              : {})}
        />
      );
    },
  });

  useComputerToolRenderer({
    name: "computer_read",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({}),
    render: () => null,
  });

  // 浏览器多标签（DESIGN.md §95）：列出 / 新开 / 切换 / 关闭。机器人总是在「当前标签」上操作。
  useComputerToolRenderer({
    name: "computer_tabs",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      action: z
        .enum(["list", "new", "switch", "close"])
        .describe("What to do."),
      id: z
        .string()
        .optional()
        .describe("Tab id from action=list, for switch / close."),
      url: z
        .string()
        .optional()
        .describe(
          "For action=new: the page to open in the new tab (full https:// address).",
        ),
    }),
    render: ({ args, status, result }) => {
      const a = (args ?? {}) as { action?: string; url?: string };
      const finished = status === "complete" || result !== undefined;
      const outcome = finished ? outcomeOf(result) : {};
      // 只有「新开标签并打开网页」出一行小条；列出 / 切换 / 关闭不占对话。
      if (a.action !== "new" || !a.url) return null;
      return (
        <BrowseChip
          state={
            !finished ? "running" : outcome.ok === false ? "failed" : "done"
          }
          url={a.url}
          {...(typeof outcome.page === "object" &&
          outcome.page &&
          typeof (outcome.page as { title?: unknown }).title === "string"
            ? { title: (outcome.page as { title: string }).title }
            : {})}
        />
      );
    },
  });

  // 收藏夹（DESIGN.md §95）：读、打开；只有用户明确要求时才收藏 / 删除。
  useComputerToolRenderer({
    name: "computer_bookmarks",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      action: z.enum(["list", "open", "add", "remove"]),
      id: z
        .string()
        .optional()
        .describe("Bookmark id from action=list, for open / remove."),
      url: z
        .string()
        .optional()
        .describe(
          "For add: the address to bookmark. Omit to bookmark the active tab.",
        ),
      title: z.string().optional().describe("For add: a short name."),
      newTab: z.boolean().optional().describe("For open: open in a new tab."),
    }),
    render: ({ args, status, result }) => {
      const a = (args ?? {}) as { action?: string; url?: string };
      if (a.action !== "open") return null;
      const finished = status === "complete" || result !== undefined;
      const outcome = finished ? outcomeOf(result) : {};
      const opened =
        typeof outcome.url === "string"
          ? outcome.url
          : typeof outcome.page === "object" && outcome.page
            ? (outcome.page as { url?: string }).url
            : undefined;
      return (
        <BrowseChip
          state={
            !finished ? "running" : outcome.ok === false ? "failed" : "done"
          }
          {...(opened ? { url: opened } : {})}
          {...(typeof outcome.title === "string"
            ? { title: outcome.title }
            : {})}
        />
      );
    },
  });

  // 用户要「截个图」：截当前画面，对话里放缩略图（图片只存本机，不进模型上下文）。
  useComputerToolRenderer({
    name: "computer_screenshot",
    parameters: z.object({}),
    render: ({
      result,
      status,
      toolCallId,
    }: {
      result?: string;
      status: string;
      toolCallId?: string;
    }) => {
      const finished = status === "complete" || result !== undefined;
      const outcome = finished ? outcomeOf(result) : {};
      return (
        <ScreenshotCard
          id={toolCallId}
          running={!finished}
          {...(outcome.ok === false
            ? { failed: outcome.reason ?? "没截到图" }
            : {})}
          {...(typeof outcome.url === "string" ? { url: outcome.url } : {})}
        />
      );
    },
  });

  useComputerToolRenderer({
    name: "computer_snapshot",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({}),
    // Snapshot renders a count only; navigate owns the screen view.
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const elements = Array.isArray(outcome.elements) ? outcome.elements : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label={"读取页面"}
          detail={
            elements.length ? `${elements.length} 个可操作元素` : undefined
          }
        />
      );
    },
  });

  useComputerToolRenderer({
    name: "computer_type",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      ref: z
        .string()
        .describe("Ref of the field, from your most recent snapshot"),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
      text: z.string().describe("The text to enter"),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after typing, to submit a single-field form"),
    }),
    render: ({ args, result, status }) => {
      const field =
        labelOf(result) ??
        (typeof args?.ref === "string" ? args.ref : undefined);
      // 原生下拉框（§100）：选中的是页面上的一个选项，不是输入的内容，可以显示。
      const picked = selectedLabel(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label={picked ? "已选择" : "已填写"}
          detail={
            picked
              ? `${field ? `${field}：` : ""}${picked}`
              : // Never show typed values; identify only the target field.
                field
          }
          refused={outcomeOf(result).refused === true}
          failed={didNotWork(outcomeOf(result))}
        />
      );
    },
  });

  useComputerToolRenderer({
    name: "computer_click",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      ref: z
        .string()
        .describe(
          "Ref of the element to click, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label={selectedLabel(result) ? "已选择" : "已点击"}
          detail={
            // Show refusal reason instead of an internal element ref.
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : (selectedLabel(result) ??
                labelOf(result) ??
                (typeof args?.ref === "string" ? args.ref : undefined))
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useComputerToolRenderer({
    name: "computer_key",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      key: z.string().describe("Key name, such as Enter, Tab or Escape"),
      ref: z.string().optional().describe("Optional ref to press the key on"),
      snapshotId: z
        .number()
        .optional()
        .describe("The snapshotId the ref came from, required if ref is given"),
    }),
    render: ({ args, result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label={"已按下"}
        detail={typeof args?.key === "string" ? args.key : undefined}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  useComputerToolRenderer({
    name: "computer_request_secret",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      label: z
        .string()
        .describe(
          "What you need, in a few words, e.g. 'the code sent to your phone'",
        ),
      ref: z
        .string()
        .describe(
          "Ref of the field it goes in, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    // Rendered by ComputerView as a masked prompt.
    render: () => null,
  });

  /** Self-reported model declines: audit evidence, not an enforcement control. */
  useComputerToolRenderer({
    name: "report_refusal",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      reason: z
        .string()
        .describe("Why you declined, in one sentence and in your own words"),
      request: z
        .string()
        .optional()
        .describe("What you were asked to do, in a few words"),
    }),
    render: () => null,
  });

  useComputerToolRenderer({
    name: "computer_request_help",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      reason: z
        .string()
        .describe(
          "What you need the person to do, in one sentence, e.g. 'This page is asking for a code sent to your phone.'",
        ),
    }),
    // Rendered by ComputerView as the take-the-wheel prompt.
    render: () => null,
  });

  useComputerToolRenderer({
    name: "computer_list_files",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe("Optional folder to list. Omit for the whole workspace."),
    }),
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const entries = Array.isArray(outcome.entries) ? outcome.entries : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label={"列出的文件"}
          detail={
            outcome.refused === true || didNotWork(outcome)
              ? String(outcome.reason ?? "")
              : entries.length
                ? `工作区中有 ${entries.length} 项内容`
                : "尚未保存任何内容"
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useComputerToolRenderer({
    name: "computer_read_file",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      path: z
        .string()
        .describe("Path relative to your workspace, such as notes.md"),
    }),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label={"读取文件"}
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useComputerToolRenderer({
    name: "computer_run_command",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      command: z
        .string()
        .describe("The command to run, such as: sudo apt-get install -y jq"),
      // §102：秒（推荐）或毫秒都收，超出 1–600 秒收到边界上（shared/command-timeout.ts）。
      timeoutSec: z
        .number()
        .optional()
        .describe(
          `Seconds before the command is stopped. Default ${COMMAND_DEFAULT_TIMEOUT_SEC}, max ${COMMAND_MAX_TIMEOUT_SEC}. Set it for long commands.`,
        ),
      timeoutMs: z
        .number()
        .optional()
        .describe("Same limit in milliseconds; prefer timeoutSec."),
    }),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      /*
       * The command on the line, its output behind the chevron.
       *
       * The line stays one line, because a transcript of a Bot working through twenty commands is
       * unreadable if each one dumps a screenful. But the output has to be reachable: this ran on a
       * machine holding somebody's logins, and "take the model's word for what it printed" is not an
       * answer. The pane beside the screen shows the same thing without expanding anything.
       */
      const printed = outputOf(outcome as ToolOutcome);
      const exit = typeof outcome.exitCode === "number" ? outcome.exitCode : 0;
      return (
        <ToolLine
          running={status !== "complete"}
          label={"运行了命令"}
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.command === "string"
                ? args.command
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome) || exit !== 0}
        >
          {status === "complete" ? (
            <CommandOutput
              output={printed}
              exitCode={exit}
              truncated={outcome.truncated === true}
              timedOut={outcome.timedOut === true}
            />
          ) : null}
        </ToolLine>
      );
    },
  });

  useComputerToolRenderer({
    name: "computer_write_file",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      path: z
        .string()
        .describe(
          "Path relative to your workspace, such as reports/august.csv",
        ),
      contents: z.string().describe("The text to save"),
      append: z
        .boolean()
        .optional()
        .describe("Add to the end of the file instead of replacing it"),
    }),
    render: ({ args, result, status }) => {
      const outcome = outcomeOf(result);
      return (
        <ActionLine
          running={status !== "complete"}
          label={args?.append === true ? "已添加到文件" : "已保存的文件"}
          // Show the path, never file contents.
          detail={
            outcome.refused === true
              ? String(outcome.reason ?? "")
              : typeof args?.path === "string"
                ? args.path
                : undefined
          }
          refused={outcome.refused === true}
          failed={didNotWork(outcome)}
        />
      );
    },
  });

  useComputerToolRenderer({
    name: "computer_scroll",
    // 只画一行过程（或什么都不画），不算对话里的卡片（tool-renderers.ts）。
    lineOnly: true,
    parameters: z.object({
      deltaY: z
        .number()
        .optional()
        .describe("Pixels to scroll; positive is down. Defaults to 600."),
    }),
    render: ({ result, status }) => (
      <ActionLine
        running={status !== "complete"}
        label={"已滚动"}
        refused={outcomeOf(result).refused === true}
        failed={didNotWork(outcomeOf(result))}
      />
    ),
  });

  return null;
}

const lastSyncedStatusKey = new Map<string, string>();
const BROWSER_VISUAL_TOOLS = new Set([
  "computer_navigate",
  "computer_read",
  "computer_snapshot",
  "computer_screenshot",
  "computer_type",
  "computer_click",
  "computer_key",
  "computer_scroll",
  "computer_tabs",
  "computer_bookmarks",
  "computer_request_help",
  "computer_request_sign_in",
  "computer_request_secret",
]);

/**
 * 同步服务端（外部内核 / 无头工具）执行过的 computer_* 工具调用到右栏「计算机」状态行与「活动」列表。
 * 通过 toolCallId 去重，即使前端 handler 同时跑了也不会重复记。
 */
export function syncComputerMessages(
  computerId: string | undefined,
  messages: readonly {
    id?: string;
    role?: string;
    toolCallId?: string;
    content?: unknown;
    toolCalls?: readonly {
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  }[],
  isLive: boolean,
): void {
  if (!computerId || !Array.isArray(messages) || messages.length === 0) return;
  const toolResults = new Map<string, string>();
  for (const msg of messages) {
    if (msg?.role === "tool" && typeof msg.toolCallId === "string") {
      toolResults.set(
        msg.toolCallId,
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content ?? ""),
      );
    }
  }
  let latestCall: {
    callId: string;
    name: string;
    args: Record<string, unknown>;
    finished: boolean;
  } | null = null;

  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.toolCalls)) continue;
    for (const call of msg.toolCalls) {
      const callId = call?.id;
      const name = call?.function?.name;
      if (
        typeof callId !== "string" ||
        typeof name !== "string" ||
        !name.startsWith("computer_")
      )
        continue;
      let args: Record<string, unknown> = {};
      if (
        typeof call.function?.arguments === "string" &&
        call.function.arguments.trim()
      ) {
        try {
          const parsed = JSON.parse(call.function.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {}
      }
      const rawResult = toolResults.get(callId);
      const finished = rawResult !== undefined;
      latestCall = { callId, name, args, finished };
      if (!finished) continue;

      const outcome = outcomeOf(rawResult);
      if (name === "computer_navigate" && outcome.ok !== false) {
        noteBrowsed(computerId);
      } else if (
        name === "computer_run_command" &&
        typeof args.command === "string"
      ) {
        recordActivity(computerId, {
          toolCallId: callId,
          at: isLive ? undefined : null,
          kind: "command",
          subject: args.command,
          output: outputOf(outcome as ToolOutcome),
          ...(typeof outcome.exitCode === "number"
            ? { exitCode: outcome.exitCode }
            : {}),
          ...(outcome.refused === true ? { refused: true } : {}),
          ...(outcome.truncated === true ? { truncated: true } : {}),
          ...(outcome.timedOut === true ? { timedOut: true } : {}),
        });
      } else if (
        name === "computer_read_file" &&
        typeof args.path === "string"
      ) {
        recordActivity(computerId, {
          toolCallId: callId,
          at: isLive ? undefined : null,
          kind: "read_file",
          subject: args.path,
          output: outputOf(outcome as ToolOutcome),
          ...(outcome.refused === true ? { refused: true } : {}),
        });
      } else if (
        name === "computer_write_file" &&
        typeof args.path === "string"
      ) {
        recordActivity(computerId, {
          toolCallId: callId,
          at: isLive ? undefined : null,
          kind: "write_file",
          subject: args.path,
          output:
            outcome.refused === true
              ? outputOf(outcome as ToolOutcome)
              : typeof outcome.bytes === "number"
                ? `${formatBytes(outcome.bytes)}${args.append === true ? "，追加写入" : ""}`
                : "",
          ...(outcome.refused === true ? { refused: true } : {}),
        });
      } else if (name === "computer_list_files") {
        recordActivity(computerId, {
          toolCallId: callId,
          at: isLive ? undefined : null,
          kind: "list_files",
          subject:
            typeof args.path === "string" && args.path.trim()
              ? args.path
              : "工作区",
          output: outputOf(outcome as ToolOutcome),
          ...(outcome.refused === true ? { refused: true } : {}),
        });
      }
    }
  }

  if (!latestCall) return;
  const label = describeComputerToolCall(latestCall.name, latestCall.args);
  const stateKey = `${latestCall.callId}:${latestCall.finished ? "done" : "pending"}`;
  if (lastSyncedStatusKey.get(computerId) === stateKey) return;
  lastSyncedStatusKey.set(computerId, stateKey);

  if (isLive) {
    if (BROWSER_VISUAL_TOOLS.has(latestCall.name)) {
      reportComputerActivity(computerId);
    }
    if (label) {
      reportComputerStatus(computerId, label, !latestCall.finished);
    }
  } else if (label && !lastComputerStatusFor(computerId)) {
    reportComputerStatus(computerId, label, false);
  }
}
