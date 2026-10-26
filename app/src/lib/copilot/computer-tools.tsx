import { formatBytes } from "../../../../shared/computer-activity-labels";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { CommandOutput } from "@/components/computer/command-output";
import { BrowseChip } from "@/components/computer/browse-chip";
import { keepShot, ScreenshotCard, shrinkPng } from "@/components/computer/screenshot-card";
import { readScreenshot } from "@/lib/computers/screen";
import {
  describeComputerToolCall,
  lastComputerStatusFor,
  reportComputerActivity,
  reportComputerStatus,
} from "@/lib/copilot/computer-activity";
import { tryClient } from "@/lib/client";
import { syncStartLinks } from "@/lib/browser-bookmarks";
import { noteBrowsed, recordActivity } from "@/lib/computers/activity";
import { callComputer, type ToolOutcome } from "@/lib/computers/call";
import {
  COMMAND_DEFAULT_TIMEOUT_SEC,
  COMMAND_MAX_TIMEOUT_SEC,
  COMMAND_TIMEOUT_GUIDE,
  normalizeCommandTimeout,
} from "../../../../shared/command-timeout";
import { type ControlState, readControl } from "@/lib/computers/control";
import {
  runBrowserRead,
  runHelpRequest,
  runNavigation,
} from "@/lib/computers/handoff";
import { useActiveBotHolder } from "./active-bot";
import { useFrontendTool } from "./approval-tools";
import { useComputerAvailable } from "./computer-available";

/**
 * Frontend registrations for computer tools, including inline rendering and policy-refusal display.
 */

export type { ToolOutcome } from "@/lib/computers/call";
/** What every computer call returns to the model: either the result, or a reason it did not happen. */
export { callComputer } from "@/lib/computers/call";

/**
 * Secret-entry wait window. Browser takeovers use server-authoritative request state instead.
 */
const WAIT_FOR_SECRET_MS = 10 * 60_000;

/** How often the waiting handler asks whether the person has answered yet. */
const WAIT_POLL_MS = 1_000;

/** Hold the secret-entry call open until its masked prompt is answered, cancelled, or expires. */
async function waitForSecret(
  botId: string,
  done: (state: ControlState) => boolean,
  signal: AbortSignal | undefined,
  giveUpAfterMs = WAIT_FOR_SECRET_MS,
): Promise<"answered" | "gave up" | "cancelled"> {
  const deadline = Date.now() + giveUpAfterMs;
  while (Date.now() < deadline) {
    // Stop must actually stop, including out of a wait. The SDK aborts this when a person presses it.
    if (signal?.aborted) return "cancelled";
    const state = await readControl(botId).catch(() => null);
    if (state && done(state)) return "answered";
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  return "gave up";
}

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
  const bot = useActiveBotHolder();
  // Not offered to a Team Bot's teammates; see useComputerAvailable.
  const available = useComputerAvailable();

  useFrontendTool({
    available,
    name: "computer_navigate",
    description:
      "Open a web page on your own computer so the person can watch. Use this when asked to look " +
      "at, visit, open or check a website. Returns the page title and its readable text, so answer " +
      "from what comes back rather than telling the person to go and look. To show a page you wrote " +
      "yourself, save it with computer_write_file (e.g. page.html) and open " +
      "https://workspace.local/page.html — file:// addresses do not work.",
    parameters: z.object({
      url: z
        .string()
        .describe(
          "Full web address to open, including https://. Your own workspace files are at https://workspace.local/<path>.",
        ),
    }),
    handler: async (
      { url }: { url: string },
      // Context is optional in the SDK.
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      const computerId = bot.current;
      const result = await runNavigation(computerId, url, toolCall?.id, signal);
      if (result.ok) noteBrowsed(computerId);
      return result;
    },
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
          state={!finished ? "running" : outcome.ok === false ? "failed" : "done"}
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

  useFrontendTool({
    available,
    name: "computer_read",
    description:
      "Read the page currently open on your computer, without opening anything. Use this after you " +
      "click something that changes the page, such as submitting a form, to find out what it now says.",
    parameters: z.object({}),
    handler: async (
      _input: Record<string, never>,
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => runBrowserRead(bot.current, "/read", toolCall?.id, signal),
    render: () => null,
  });

  // 浏览器多标签（DESIGN.md §95）：列出 / 新开 / 切换 / 关闭。机器人总是在「当前标签」上操作。
  useFrontendTool({
    available,
    name: "computer_tabs",
    description:
      "Manage the tabs of your browser (the person sees the same tabs). Every other computer_ tool acts on the " +
      "ACTIVE tab. action=list shows the open tabs (id, title, url, which is active). action=new opens a new tab " +
      "and makes it active; pass url to open a page in it (use this when you want to keep the current page open, " +
      "e.g. to compare two pages). action=switch makes tab `id` active. action=close closes tab `id`. " +
      "At most 8 tabs; close ones you no longer need. If a person has taken control, wait for them.",
    parameters: z.object({
      action: z.enum(["list", "new", "switch", "close"]).describe("What to do."),
      id: z.string().optional().describe("Tab id from action=list, for switch / close."),
      url: z.string().optional().describe("For action=new: the page to open in the new tab (full https:// address)."),
    }),
    handler: async (
      { action, id, url }: { action: "list" | "new" | "switch" | "close"; id?: string; url?: string },
      { signal, toolCall }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      const computerId = bot.current;
      if (action === "list") return callComputer(computerId, "/tabs", undefined, signal);
      if ((action === "switch" || action === "close") && !id)
        return { ok: false, reason: "Pass the tab id from computer_tabs action=list." };
      const result = await callComputer(
        computerId,
        "/tabs",
        {
          method: "POST",
          body: {
            action: action === "switch" ? "activate" : action,
            ...(id ? { id } : {}),
            ...(url ? { url, ...(toolCall?.id ? { toolCallId: toolCall.id } : {}) } : {}),
          },
        },
        signal,
      );
      if (result.ok && url) noteBrowsed(computerId);
      return result;
    },
    render: ({ args, status, result }) => {
      const a = (args ?? {}) as { action?: string; url?: string };
      const finished = status === "complete" || result !== undefined;
      const outcome = finished ? outcomeOf(result) : {};
      // 只有「新开标签并打开网页」出一行小条；列出 / 切换 / 关闭不占对话。
      if (a.action !== "new" || !a.url) return null;
      return (
        <BrowseChip
          state={!finished ? "running" : outcome.ok === false ? "failed" : "done"}
          url={a.url}
          {...(typeof outcome.page === "object" && outcome.page && typeof (outcome.page as { title?: unknown }).title === "string"
            ? { title: (outcome.page as { title: string }).title }
            : {})}
        />
      );
    },
  });

  // 收藏夹（DESIGN.md §95）：读、打开；只有用户明确要求时才收藏 / 删除。
  useFrontendTool({
    available,
    name: "computer_bookmarks",
    description:
      "The person's browser bookmarks (收藏夹), shared by all their bots. action=list returns them (id, title, url). " +
      "action=open opens bookmark `id` in your browser (newTab=true keeps the current page in its own tab). " +
      "action=add bookmarks `url` (or the active page when url is omitted) and action=remove deletes bookmark `id` — " +
      "ONLY do add/remove when the person explicitly asks you to bookmark (收藏) or un-bookmark something.",
    parameters: z.object({
      action: z.enum(["list", "open", "add", "remove"]),
      id: z.string().optional().describe("Bookmark id from action=list, for open / remove."),
      url: z.string().optional().describe("For add: the address to bookmark. Omit to bookmark the active tab."),
      title: z.string().optional().describe("For add: a short name."),
      newTab: z.boolean().optional().describe("For open: open in a new tab."),
    }),
    handler: async (
      input: { action: "list" | "open" | "add" | "remove"; id?: string; url?: string; title?: string; newTab?: boolean },
      { signal, toolCall }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      const computerId = bot.current;
      const listed = await tryClient("/api/browser-bookmarks", signal ? { signal } : {}).catch(() => null);
      const listBody = (await listed?.json().catch(() => null)) as { bookmarks?: { id: string; title: string; url: string }[] } | null;
      if (!listed?.ok || !listBody?.bookmarks) return { ok: false, reason: "The bookmarks could not be read." };
      const bookmarks = listBody.bookmarks.map(({ id, title, url }) => ({ id, title, url }));
      if (input.action === "list") return { ok: true, bookmarks };
      if (input.action === "open") {
        const found = bookmarks.find((bookmark) => bookmark.id === input.id);
        if (!found) return { ok: false, reason: "No bookmark with that id; call action=list first." };
        if (input.newTab) {
          const result = await callComputer(
            computerId,
            "/tabs",
            { method: "POST", body: { action: "new", url: found.url, ...(toolCall?.id ? { toolCallId: toolCall.id } : {}) } },
            signal,
          );
          if (result.ok) noteBrowsed(computerId);
          return result;
        }
        const result = await runNavigation(computerId, found.url, toolCall?.id, signal);
        if (result.ok) noteBrowsed(computerId);
        return result;
      }
      if (input.action === "remove") {
        if (!input.id) return { ok: false, reason: "Pass the bookmark id." };
        const response = await tryClient(`/api/browser-bookmarks/${encodeURIComponent(input.id)}`, { method: "DELETE" }).catch(() => null);
        if (response?.ok) syncStartLinks(computerId);
        return response?.ok ? { ok: true, removed: input.id } : { ok: false, reason: "That bookmark could not be removed." };
      }
      let url = input.url;
      if (!url) {
        const tabs = await callComputer(computerId, "/tabs", undefined, signal);
        const active = Array.isArray(tabs.tabs)
          ? (tabs.tabs as { active?: boolean; url?: string }[]).find((tab) => tab.active)
          : undefined;
        url = active?.url;
        if (!url || !/^https?:\/\//i.test(url)) return { ok: false, reason: "The active tab is not a web page; pass url." };
      }
      const response = await tryClient("/api/browser-bookmarks", {
        method: "POST",
        body: { url, ...(input.title ? { title: input.title } : {}) },
      }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as { bookmark?: unknown; error?: string } | null;
      if (!response?.ok) return { ok: false, reason: body?.error ?? "That page could not be bookmarked." };
      syncStartLinks(computerId);
      return { ok: true, bookmark: body?.bookmark };
    },
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
          state={!finished ? "running" : outcome.ok === false ? "failed" : "done"}
          {...(opened ? { url: opened } : {})}
          {...(typeof outcome.title === "string" ? { title: outcome.title } : {})}
        />
      );
    },
  });

  // 用户要「截个图」：截当前画面，对话里放缩略图（图片只存本机，不进模型上下文）。
  useFrontendTool({
    available,
    name: "computer_screenshot",
    description:
      "Take a screenshot of the page currently open on your computer and show it to the person in the chat. " +
      "Use it only when they ask for a screenshot / 截图 / 截个图 (open the page first with computer_navigate). " +
      "You do not see the image; answer from computer_navigate / computer_read text.",
    parameters: z.object({}),
    handler: async (_input: Record<string, never>, { toolCall }: { toolCall?: { id?: string } } = {}) => {
      const computerId = bot.current;
      reportComputerActivity(computerId);
      const { frame, error } = await readScreenshot(computerId);
      if (!frame) return { ok: false, reason: error ?? "没截到图" };
      try {
        if (toolCall?.id) keepShot(toolCall.id, await shrinkPng(frame.base64), frame.url, computerId ?? undefined);
      } catch {}
      return { ok: true, shown: true, url: frame.url ?? null, note: "截图已显示在对话里，不要再描述截图本身，直接回答用户。" };
    },
    render: ({ result, status, toolCallId }: { result?: string; status: string; toolCallId?: string }) => {
      const finished = status === "complete" || result !== undefined;
      const outcome = finished ? outcomeOf(result) : {};
      return (
        <ScreenshotCard
          id={toolCallId}
          running={!finished}
          {...(outcome.ok === false ? { failed: outcome.reason ?? "没截到图" } : {})}
          {...(typeof outcome.url === "string" ? { url: outcome.url } : {})}
        />
      );
    },
  } as never);

  useFrontendTool({
    available,
    name: "computer_snapshot",
    description:
      "List the things on the current page you can act on: fields, buttons, links and checkboxes, " +
      "each with a ref, its label and its current value. Call this BEFORE clicking or typing, and " +
      "use the refs it returns. Always send back the snapshotId it gives you. If an action reports " +
      "that your refs are stale, the page changed: call this again and use the new refs. " +
      "A dropdown (<select>) appears as a combobox with an `options` list: choose with computer_type.",
    parameters: z.object({}),
    handler: async (
      _input: Record<string, never>,
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => runBrowserRead(bot.current, "/snapshot", toolCall?.id, signal),
    // Snapshot renders a count only; navigate owns the screen view.
    render: ({ result, status }) => {
      const outcome = outcomeOf(result);
      const elements = Array.isArray(outcome.elements) ? outcome.elements : [];
      return (
        <ActionLine
          running={status !== "complete"}
          label={"读取页面"}
          detail={
            elements.length
              ? `${elements.length} 个可操作元素`
              : undefined
          }
        />
      );
    },
  });

  useFrontendTool({
    available,
    name: "computer_type",
    description:
      "Enter text into a field on the page. Give the ref of the field from your most recent " +
      "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
      "Set submit to true to press Enter afterwards. For a dropdown (a combobox with `options` in the " +
      "snapshot) give one option's text or value, e.g. \"Jul\" or \"7\" for a month, \"2000\" for a year: " +
      "this selects it directly. Do not click a dropdown open or press keys on it.",
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
    handler: async (
      input: {
        ref: string;
        snapshotId: number;
        text: string;
        submit?: boolean;
      },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/type",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
    render: ({ args, result, status }) => {
      const field =
        labelOf(result) ?? (typeof args?.ref === "string" ? args.ref : undefined);
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

  useFrontendTool({
    available,
    name: "computer_click",
    description:
      "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
      "from your most recent snapshot and the snapshotId it came from. To choose in a dropdown " +
      "(<select>), use computer_type with the option's text instead of clicking it.",
    parameters: z.object({
      ref: z
        .string()
        .describe(
          "Ref of the element to click, from your most recent snapshot",
        ),
      snapshotId: z.number().describe("The snapshotId that ref came from"),
    }),
    handler: async (
      input: { ref: string; snapshotId: number },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/click",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
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

  useFrontendTool({
    available,
    name: "computer_key",
    description:
      "Press a key, such as Enter, Tab or Escape. Give a ref to press it while a particular field " +
      "is focused, or omit the ref to press it on the page.",
    parameters: z.object({
      key: z.string().describe("Key name, such as Enter, Tab or Escape"),
      ref: z.string().optional().describe("Optional ref to press the key on"),
      snapshotId: z
        .number()
        .optional()
        .describe("The snapshotId the ref came from, required if ref is given"),
    }),
    handler: async (
      input: {
        key: string;
        ref?: string;
        snapshotId?: number;
      },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/key",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
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

  useFrontendTool({
    available,
    name: "computer_request_secret",
    description:
      "Ask the person for ONE value you must not be told: a password, a one-time code, a card number. " +
      "Focus the field first with computer_click, then call this with the ref of that field and a " +
      "short label for what you need. They type it into a masked box that goes straight to the page. " +
      "You will never see the value, and you must not ask for it any other way. Prefer this over a " +
      "full takeover when you only need one field filled in. The value is only TYPED into the field: " +
      "if the form needs submitting, do that yourself afterwards with computer_click.",
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
    handler: async (
      input: { label: string; ref: string; snapshotId: number },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      const botId = bot.current;
      const asked = await callComputer(
        botId,
        "/control/secret",
        {
          method: "POST",
          body: input,
        },
        signal,
      );
      if (!asked.ok) return asked;

      // Completion is `secretWanted` clearing; the value never returns to the model.
      const outcome = await waitForSecret(
        botId,
        (state) => state.secretWanted === undefined,
        signal,
      );
      return {
        ok: true,
        result:
          outcome === "answered"
            ? `The person has entered ${input.label} into the field. It was typed straight into the page and you were not told what it is.`
            : outcome === "cancelled"
              ? "请求已取消。"
              : `Nobody entered ${input.label}. Do not ask for it another way.`,
      };
    },
    // Rendered by ComputerView as a masked prompt.
    render: () => null,
  });

  /** Self-reported model declines: audit evidence, not an enforcement control. */
  useFrontendTool({
    available,
    name: "report_refusal",
    description:
      "Record that you DECLINED something you were asked to do, because it looked unsafe, was outside " +
      "what you are for, or you judged you should not. Call this whenever you say no to a request, in " +
      "addition to telling the person. It changes nothing about your answer; it exists so an " +
      "administrator can see what this Bot is being asked to do. Do not call it when you simply could " +
      "not do something, only when you chose not to.",
    parameters: z.object({
      reason: z
        .string()
        .describe("Why you declined, in one sentence and in your own words"),
      request: z
        .string()
        .optional()
        .describe("What you were asked to do, in a few words"),
    }),
    handler: async (
      input: { reason: string; request?: string },
      { signal }: { signal?: AbortSignal } = {},
    ) => {
      try {
        const response = await tryClient(
          `/api/agents/${encodeURIComponent(bot.current)}/declined`,
          { method: "POST", body: input, signal },
        );
        return response.ok
          ? "Recorded. Now tell the person what you decided and why."
          : "That could not be recorded. Tell the person what you decided anyway.";
      } catch {
        // Audit bookkeeping must not prevent the Bot from answering.
        return "That could not be recorded. Tell the person what you decided anyway.";
      }
    },
    render: () => null,
  });

  useFrontendTool({
    available,
    name: "computer_request_help",
    description:
      "Ask the person to take control of your computer and do something you cannot: sign in, enter a " +
      "password or a one-time code, or clear a CAPTCHA. Say specifically what you need done. They " +
      "will drive the browser themselves and hand it back, and you carry on in the same session. " +
      "Use this INSTEAD of giving up, and instead of ever asking them to type a password to you. " +
      "This call is the only thing that reaches them: until you make it they are not looking at the " +
      "page and have no way to help, so saying you need them to sign in, or asking whether they would " +
      "like to proceed, hands over nothing and leaves the page where it is.",
    parameters: z.object({
      reason: z
        .string()
        .describe(
          "What you need the person to do, in one sentence, e.g. 'This page is asking for a code sent to your phone.'",
        ),
    }),
    handler: async (
      input: { reason: string },
      {
        signal,
        toolCall,
      }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => runHelpRequest(bot.current, input.reason, toolCall?.id, signal),
    // Rendered by ComputerView as the take-the-wheel prompt.
    render: () => null,
  });

  useFrontendTool({
    available,
    name: "computer_list_files",
    description:
      "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
      "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
      "are not sure of. Never guess a filename.",
    parameters: z.object({
      path: z
        .string()
        .optional()
        .describe("Optional folder to list. Omit for the whole workspace."),
    }),
    handler: async (
      input: { path?: string },
      { toolCall }: { toolCall?: { id?: string } } = {},
    ) => {
      const computerId = bot.current;
      const result = await callComputer(computerId, "/files/list", {
        method: "POST",
        body: input ?? {},
      });
      recordActivity(computerId, {
        ...(toolCall?.id ? { toolCallId: toolCall.id } : {}),
        kind: "list_files",
        subject: input?.path ?? "工作区",
        output: outputOf(result),
        ...(result.refused === true ? { refused: true } : {}),
      });
      return result;
    },
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

  useFrontendTool({
    available,
    name: "computer_read_file",
    description:
      "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
      "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
      "this to pick up notes you made before.",
    parameters: z.object({
      path: z
        .string()
        .describe("Path relative to your workspace, such as notes.md"),
    }),
    handler: async (
      input: { path: string },
      { toolCall }: { toolCall?: { id?: string } } = {},
    ) => {
      const computerId = bot.current;
      const result = await callComputer(computerId, "/files/read", {
        method: "POST",
        body: input,
      });
      recordActivity(computerId, {
        ...(toolCall?.id ? { toolCallId: toolCall.id } : {}),
        kind: "read_file",
        subject: input.path,
        output: outputOf(result),
        ...(result.refused === true ? { refused: true } : {}),
      });
      return result;
    },
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

  useFrontendTool({
    available,
    name: "computer_run_command",
    description:
      "Run a shell command on your own computer. Use this for anything the browser cannot do: " +
      "installing a tool you need, processing a file you saved, running a script. The working " +
      "directory is your workspace, so paths are relative to it and files you write here are the " +
      "same ones the file tools see. Commands run in bash, so pipes and && work. Long output is " +
      "truncated from the start. " +
      COMMAND_TIMEOUT_GUIDE +
      " " +
      "You are not the root user, so anything that writes outside your workspace needs sudo, " +
      "which asks for no password: installing a package is " +
      "`sudo apt-get update && sudo apt-get install -y <package>`. If sudo is refused, this " +
      "computer does not grant it, so say so rather than retrying.",
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
    handler: async (
      input: { command: string; timeoutSec?: number; timeoutMs?: number },
      { signal, toolCall }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      const computerId = bot.current;
      // 直连 /exec 时（没有对话快照的界面）也要折算：路由只认整数毫秒 1000–600000。
      const timeout = normalizeCommandTimeout(input);
      const result = await callComputer(
        computerId,
        "/exec",
        {
          method: "POST",
          body: {
            command: input.command,
            ...(timeout.timeoutMs !== undefined
              ? { timeoutMs: timeout.timeoutMs }
              : {}),
          },
        },
        signal,
      );
      /*
       * Recorded here rather than in `render`, which runs again on every re-render and would append
       * the same command each time. This is the only place that runs once per call and has both the
       * command and what it printed.
       */
      recordActivity(computerId, {
        ...(toolCall?.id ? { toolCallId: toolCall.id } : {}),
        kind: "command",
        subject: input.command,
        output: outputOf(result),
        ...(typeof result.exitCode === "number"
          ? { exitCode: result.exitCode }
          : {}),
        ...(result.refused === true ? { refused: true } : {}),
        ...(result.truncated === true ? { truncated: true } : {}),
        ...(result.timedOut === true ? { timedOut: true } : {}),
      });
      return result;
    },
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

  useFrontendTool({
    available,
    name: "computer_write_file",
    description:
      "Save a file in your own workspace so you still have it later. Paths are relative to your " +
      "workspace and folders are created as needed. Set append to true to add to the end of an " +
      "existing file rather than replacing it. Text only.",
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
    handler: async (
      input: {
        path: string;
        contents: string;
        append?: boolean;
      },
      { toolCall }: { toolCall?: { id?: string } } = {},
    ) => {
      const computerId = bot.current;
      const result = await callComputer(computerId, "/files/write", {
        method: "POST",
        body: input,
      });
      /*
       * The path and the size, never the contents. A Bot may well be saving something it was told in
       * confidence, and the write route declines to echo it back for exactly that reason; putting it
       * in a pane would undo that.
       */
      recordActivity(computerId, {
        ...(toolCall?.id ? { toolCallId: toolCall.id } : {}),
        kind: "write_file",
        subject: input.path,
        output:
          result.refused === true
            ? outputOf(result)
            : typeof result.bytes === "number"
              ? `${formatBytes(result.bytes)}${input.append === true ? "，追加写入" : ""}`
              : "",
        ...(result.refused === true ? { refused: true } : {}),
      });
      return result;
    },
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

  useFrontendTool({
    available,
    name: "computer_scroll",
    description: "向下滚动页面，或向上滚动负量，以查看长页面的更多内容。",
    parameters: z.object({
      deltaY: z
        .number()
        .optional()
        .describe("Pixels to scroll; positive is down. Defaults to 600."),
    }),
    handler: async (
      input: { deltaY?: number },
      { signal }: { signal?: AbortSignal } = {},
    ) =>
      callComputer(
        bot.current,
        "/scroll",
        {
          method: "POST",
          body: input,
        },
        signal,
      ),
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
 * 同步服务端（Hermes / 无头工具）执行过的 computer_* 工具调用到右栏「计算机」状态行与「活动」列表。
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
