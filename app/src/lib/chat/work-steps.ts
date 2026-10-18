import { describeWorkerStep } from "../../../../shared/work-step";
import { toolResultFailed } from "../plugins/tool-result";

/**
 * 主对话这一轮干了哪些活（DESIGN.md §70 干活卡）：从这一轮的工具调用里数步骤、取「当前步骤」那一行。
 * 只认结构 `{ name, arguments }`，不依赖聊天记录的具体类型，方便单测。
 */
export type WorkCall = {
  name: string;
  arguments: string;
  done: boolean;
  /** 工具调用 id（简单回合要查它有没有确认卡，§93）。 */
  id?: string;
  /** 结果是拒绝 / 出错 / 被中断（§93：这一轮就不算「简单回合」）。 */
  failed?: boolean;
};

export type WorkSummary = { count: number; done: number; current: string };

/**
 * 准备动作（看有哪些技能、读技能说明）：用户不关心，不当「当前步骤」、不数进「第几步」（DESIGN.md §75.2）。
 * 审计（2026-10-16）里几乎每一轮的干活卡开头都是 3–6 秒的「正在看有哪些技能」。
 */
const PREP = new Set(["skill_list", "skill_load"]);

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    // 流式时参数还没写完：先当没有参数，下一次渲染再读。
    return {};
  }
}

/** 当前在做的那一步（准备动作不算）：给右栏「正在搭建」的面板看（DESIGN.md §77.1）。 */
export function currentWorkStep(calls: readonly WorkCall[]): { name: string; label: string } | null {
  const summary = summarizeWork(calls);
  const last = [...calls].reverse().find((call) => !PREP.has(call.name));
  return last && summary ? { name: last.name, label: summary.current } : null;
}

export function summarizeWork(calls: readonly WorkCall[]): WorkSummary | null {
  if (calls.length === 0) return null;
  let current = "";
  for (let i = calls.length - 1; i >= 0 && !current; i--) {
    const call = calls[i]!;
    if (PREP.has(call.name)) continue;
    const line = describeWorkerStep(call.name, parseArgs(call.arguments)) ?? "";
    // 没有中文说法的工具（skill_load 等）不当「当前步骤」，往前找一个说得出来的；都没有就「正在处理」（§69.3 不给用户看工具名）。
    current = line.startsWith("正在使用 ") ? "" : line;
  }
  const counted = calls.filter((call) => !PREP.has(call.name));
  return {
    count: counted.length,
    done: counted.filter((call) => call.done).length,
    // 只做了准备动作：「正在准备」；有别的工具但都说不出来：「正在处理」。
    current: current || (counted.length === 0 ? "正在准备" : "正在处理"),
  };
}

/** 不算「干活」的工具：画卡片、维护清单、读技能说明（结束后的一行里不数它们）。 */
const NOT_WORK = new Set(["render_ui", "worker_plan", "skill_load", "skill_list"]);

export type DoneWork = { label: string; steps: string[]; /** 失败 / 未完成的步数（FIX-07 / FIX-12）。 */ failed?: number };

/** 真的在干活的调用（干活卡从第一个这样的调用出现、画在它那一行，DESIGN.md §75.1）。 */
export function isWorkCall(name: string): boolean {
  return !NOT_WORK.has(name);
}

/**
 * 一轮结束后收成的一行（DESIGN.md §70.2）：「搜索 2 次 · 看了 3 个网页」/「做了 5 步」，点开是每一步。
 * 只数真的干活的工具；一步都没有返回 null（不出这一行）。
 */
export function summarizeDoneWork(calls: readonly WorkCall[]): DoneWork | null {
  const work = calls.filter((call) => !NOT_WORK.has(call.name));
  if (work.length === 0) return null;
  const failed = work.filter((call) => call.failed || !call.done).length;
  return {
    label: doneLabel(work),
    steps: workStepLines(work),
    ...(failed ? { failed } : {}),
  };
}

/** 每一步一句（去掉「正在」，相同的连着只记一次，说不出来的不列）。干活卡点开、收成的一行点开都用它。失败步带「（失败）」。 */
export function workStepLines(calls: readonly WorkCall[]): string[] {
  const steps: string[] = [];
  for (const call of calls) {
    if (NOT_WORK.has(call.name)) continue;
    const line = describeWorkerStep(call.name, parseArgs(call.arguments));
    if (!line || line.startsWith("正在使用 ")) continue;
    const past = line.replace(/^正在/, "");
    const marked = call.failed || !call.done ? `${past}（失败）` : past;
    if (steps[steps.length - 1] !== marked) steps.push(marked);
  }
  return steps;
}

/**
 * 一段过程话（DESIGN.md §90）：机器人在两步之间说的话，收进干活卡。`at` = 它前面这一轮已经有几个调用。
 */
export type WorkNote = { at: number; text: string };

/** 过程话里的 markdown 记号去掉（卡片里是一行小字，不画 markdown）。 */
export function plainNote(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 干活卡点开后的一列（§90）：每一步一句（同 `workStepLines`），过程话按它出现的位置插在步骤之间。
 * 没有过程话时与 `workStepLines` 完全一样。
 */
export function workTimeline(calls: readonly WorkCall[], notes: readonly WorkNote[] = []): { kind: "step" | "note"; text: string }[] {
  const lines: { kind: "step" | "note"; text: string }[] = [];
  const pending = [...notes].sort((a, b) => a.at - b.at);
  const flush = (upTo: number) => {
    while (pending.length && pending[0]!.at <= upTo) {
      const text = plainNote(pending.shift()!.text);
      if (text && lines.at(-1)?.text !== text) lines.push({ kind: "note", text });
    }
  };
  let lastStep: string | undefined;
  calls.forEach((call, index) => {
    flush(index);
    if (NOT_WORK.has(call.name)) return;
    const line = describeWorkerStep(call.name, parseArgs(call.arguments));
    if (!line || line.startsWith("正在使用 ")) return;
    const past = line.replace(/^正在/, "");
    const marked = call.failed || !call.done ? `${past}（失败）` : past;
    if (lines.at(-1)?.kind === "step" && lastStep === marked) return;
    lastStep = marked;
    lines.push({ kind: "step", text: marked });
  });
  flush(Number.POSITIVE_INFINITY);
  return lines;
}

function doneLabel(work: readonly WorkCall[]): string {
  // FIX-07：只数做成的搜索 / 读页；失败的不算「看了」。
  let searches = 0;
  let pages = 0;
  let failedPages = 0;
  let failedSearches = 0;
  for (const call of work) {
    const bad = Boolean(call.failed) || !call.done;
    if (call.name === "web_search") {
      if (bad) failedSearches += 1;
      else searches += 1;
    } else if (call.name === "web_fetch" || call.name === "computer_navigate") {
      if (bad) failedPages += 1;
      else pages += 1;
    }
  }
  const webOnly =
    searches + pages + failedSearches + failedPages === work.length &&
    work.every((c) => c.name === "web_search" || c.name === "web_fetch" || c.name === "computer_navigate");
  if (webOnly) {
    const parts = [
      searches ? `搜索 ${searches} 次` : "",
      pages ? `看了 ${pages} 个网页` : "",
      failedPages || failedSearches
        ? `${failedPages + failedSearches} 步失败`
        : "",
    ].filter(Boolean);
    return parts.join(" · ") || "未读到网页";
  }
  const failed = work.filter((c) => c.failed || !c.done).length;
  return failed ? `做了 ${work.length} 步 · ${failed} 步失败` : `做了 ${work.length} 步`;
}

/**
 * 工具结果是不是「没做成」（§93）：服务器工具门报的失败（`toolResultFailed`）、被拒绝（`Refused.`）、服务器补的「This call produced no result」（中断）、
 * JSON 里带 `error` / `ok: false`，或者以 Error / 错误 / 失败 开头。只用来判断这一轮能不能悄悄收起干活卡，
 * 拿不准就当没做成（卡片照常显示）。
 */
export function workCallFailed(result: string | undefined): boolean {
  if (result === undefined) return true;
  if (toolResultFailed(result)) return true;
  let text = result.trim();
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string") text = parsed.trim();
    } catch {
      // 不是 JSON 字符串：按原样看。
    }
  }
  if (text.startsWith("Refused.") || text.includes("This call produced no result")) return true;
  if (/^(error\b|错误|失败)/i.test(text)) return true;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object" && (Boolean(parsed.error) || parsed.ok === false)) return true;
    } catch {
      // 截断的 JSON：不算出错。
    }
  }
  return false;
}

/**
 * 「简单回合」允许的工具（§93）：只读、很快、对用户没有信息量——列设备、截屏、看系统信息 / 文件列表、翻记忆、
 * 看页面 / 定时任务 / 面板列表。改东西（写文件、跑命令、装软件、点鼠标）、上网搜索 / 读网页、开浏览器都不在里面：
 * 那些干活卡本身就是用户想看的（搜了什么、跑了什么）。准备动作 / 画卡片（NOT_WORK）不算步骤，也不挡。
 */
export const QUIET_TOOLS: ReadonlySet<string> = new Set([
  "device_list",
  "device_system_info",
  "device_screenshot",
  "device_list_files",
  "device_read_file",
  "device_search",
  "device_processes",
  "device_agent_list",
  "device_agent_status",
  "memory_search",
  "page_list",
  "page_get",
  "schedule_list",
  "panel_list",
  "worker_status",
  "chat_files_recent",
  "list_recent_files",
]);

/** 简单回合最多几步（不算准备动作）。 */
export const QUIET_MAX_STEPS = 3;
/** 简单回合最长几秒（这一页知道用时时才看；从历史打开不知道用时，只按步骤判断）。 */
export const QUIET_MAX_SECONDS = 15;

/**
 * 这一轮做完以后要不要把干活卡整行收起（DESIGN.md §93，用户 2026-10-16「做了 2 步 7 秒这个应该隐藏」）。
 * 唯一的判断，渲染和测试都用它。全部成立才收：
 *  - 这一轮结束了（不在跑）、没被停掉，并且有结果（最后一段回答）；
 *  - 每个调用都有结果、没有一个出错 / 被拒 / 被中断；
 *  - 只用了 QUIET_TOOLS 里的工具（加上不算步骤的准备动作），步数 1..QUIET_MAX_STEPS；
 *  - 没有确认卡（`confirmed` = 有确认请求的调用 id）；
 *  - 用时：这一页知道（亲眼看着跑过 / 记下过）时不超过 QUIET_MAX_SECONDS 秒；不知道就不看。
 * 收起的只是这一行的画法：调用、过程话都还在 `compactTurns().work` 里，打开「调试：显示工具调用」照常全画。
 */
export function isQuietWork({
  calls,
  live,
  stopped = false,
  hasFinal,
  confirmed,
  seconds = null,
}: {
  calls: readonly WorkCall[];
  live: boolean;
  stopped?: boolean;
  hasFinal: boolean;
  confirmed?: ReadonlySet<string> | undefined;
  seconds?: number | null;
}): boolean {
  if (live || stopped || !hasFinal) return false;
  let steps = 0;
  for (const call of calls) {
    if (!call.done || call.failed) return false;
    if (call.id && confirmed?.has(call.id)) return false;
    if (NOT_WORK.has(call.name)) continue;
    if (!QUIET_TOOLS.has(call.name)) return false;
    steps += 1;
  }
  if (steps === 0 || steps > QUIET_MAX_STEPS) return false;
  return seconds === null || seconds <= QUIET_MAX_SECONDS;
}
