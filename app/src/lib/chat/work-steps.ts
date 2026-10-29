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
  /**
   * 用户停掉了这一轮，这一步没有返回（审查模块 7）：标「已停止」，不算失败、不计进「N 步失败」。
   * compactTurns 只在被停掉的一轮里给没有结果 / 服务器补了「This call produced no result」的调用打这个标。
   */
  stopped?: boolean;
};

/**
 * 一步现在是什么状态（审查模块 7）。以前 `!done` 一律当失败：在跑时点开干活卡，还没返回的步骤都标「（失败）」。
 *  - 有结果：看结果做没做成（`failed`）；
 *  - 没有结果、这一轮被停掉：已停止；
 *  - 没有结果、这一轮还在跑（`live`）：进行中；
 *  - 没有结果、这一轮已经结束（出错 / 断线收尾）：没做成，算失败（和以前一样）。
 */
export type WorkCallState = "done" | "failed" | "running" | "stopped";
export function workCallState(call: WorkCall, live = false): WorkCallState {
  if (call.failed) return "failed";
  if (call.stopped) return "stopped";
  if (call.done) return "done";
  return live ? "running" : "failed";
}

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

/**
 * 同时在跑的几步（审查模块 7）：模型一次发了几个调用（并行搜索、同时读几个网页）时，那一行写「正在搜索 2 项」，
 * 不再只写最后一个——以前两个搜索并行跑了 40 秒，那一行一直是第二个，看着像卡在一个搜索上。点开是每一步。
 */
function parallelLabel(running: readonly WorkCall[]): string | null {
  if (running.length < 2) return null;
  const names = new Set(running.map((call) => call.name));
  if (names.size === 1) {
    if (names.has("web_search")) return `正在搜索 ${running.length} 项`;
    if (names.has("web_fetch")) return `正在读取 ${running.length} 个网页`;
    if (names.has("computer_navigate")) return `正在打开 ${running.length} 个网页`;
  }
  return `正在同时做 ${running.length} 件事`;
}

export function summarizeWork(calls: readonly WorkCall[]): WorkSummary | null {
  if (calls.length === 0) return null;
  // 只数干活的调用：同时在画的卡片（render_ui 等）不算「同时在做的事」。
  const running = calls.filter((call) => isWorkCall(call.name) && workCallState(call, true) === "running");
  let current = parallelLabel(running) ?? "";
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

/**
 * 不算「干活」的工具：画卡片、维护清单、读技能说明、机器人往来卡片、向用户递交文件/生成图片、交给后台任务
 * （结束后的一行里不数它们，也不因 quietRows 整行折叠）。
 *
 * `delegate_task`（审查模块 7）：它画的是后台任务卡（WorkerCard），任务常常在这一轮结束后还在跑。以前它算干活，
 * 又常是这一轮第一个干活的调用（干活卡的锚点），这一轮一结束整行跟着收起，停止按钮、进度、步骤都没了，刷新后也不画。
 */
const NOT_WORK = new Set([
  "delegate_task",
  "render_ui",
  "worker_plan",
  "skill_load",
  "skill_list",
  "message_bot",
  "file_share",
  "image_generate",
  "image_edit",
]);

export type DoneWork = {
  label: string;
  steps: string[];
  /** 失败 / 未完成的步数（FIX-07 / FIX-12）。 */
  failed?: number;
  /** 用户停掉时还没返回的步数（审查模块 7）：标「已停止」，不算失败。 */
  stopped?: number;
  /**
   * 这一行只说得出「做了 N 步」，没有任何有信息量的说法（没有搜索 / 网页次数、没有失败）。
   * 2026-10-20 用户：「把做了几步去掉，隐藏」——这种行整行收起，只留回答。
   */
  generic?: boolean;
};

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
  const failed = work.filter((call) => workCallState(call) === "failed").length;
  const stopped = work.filter((call) => workCallState(call) === "stopped").length;
  const label = doneLabel(work);
  return {
    label,
    steps: workStepLines(work),
    // 只是「做了 N 步」：除了步数什么也没说，收起来（§93，2026-10-20）。
    ...(label === `做了 ${work.length} 步` ? { generic: true } : {}),
    ...(failed ? { failed } : {}),
    ...(stopped ? { stopped } : {}),
  };
}

/**
 * 一步的那一句：做完的去掉「正在」；失败的带「（失败）」；停掉时没返回的带「（已停止）」；还在跑的保留「正在…」
 * （审查模块 7：进行中就是进行中，不标失败）。
 */
function stepText(line: string, state: WorkCallState): string {
  if (state === "running") return line;
  const past = line.replace(/^正在/, "");
  return state === "failed" ? `${past}（失败）` : state === "stopped" ? `${past}（已停止）` : past;
}

/** 每一步一句（相同的连着只记一次，说不出来的不列）。干活卡点开、收成的一行点开都用它。`live`：这一轮还在跑。 */
export function workStepLines(calls: readonly WorkCall[], live = false): string[] {
  const steps: string[] = [];
  for (const call of calls) {
    if (NOT_WORK.has(call.name)) continue;
    const line = describeWorkerStep(call.name, parseArgs(call.arguments));
    if (!line || line.startsWith("正在使用 ")) continue;
    const marked = stepText(line, workCallState(call, live));
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

/** 分隔符：横线、星号、下划线、等号、波浪线、句点、中点、省略号、破折号、制表线（可以夹空白）。 */
const SEPARATOR_ONLY = /^[\s\-*_=~.·•…。—–─━]*$/u;

/**
 * 没有字的一段（回复显示①，2026-10-29）：模型在两步之间单独写的「---」「***」「…」这类分隔线，整段只有分隔符
 * （可以夹空白）。干活卡里不当一步，对话里也不画成气泡。
 *
 * 只看分隔符，不先去 markdown：以前先过 `plainNote`，它会把 ``` 代码块整段去掉，只有代码块的回复就被当成空段藏起来了
 * （流式时代码块一闭合，这段就没了）。代码块、表格、链接、标题都不算空。
 */
export function isBlankNote(text: string): boolean {
  return SEPARATOR_ONLY.test(text);
}

/**
 * 干活卡点开后的一列（§90）：每一步一句（同 `workStepLines`），过程话按它出现的位置插在步骤之间。
 * 没有过程话时与 `workStepLines` 完全一样。
 */
export type WorkTimelineLine = {
  kind: "step" | "note";
  text: string;
  /** 这一行对应的工具调用（CB-101：点了跳到活动记录）。 */
  call?: { id?: string; name: string };
  /** 步骤的状态（过程话没有）。 */
  state?: WorkCallState;
};

export function workTimeline(
  calls: readonly WorkCall[],
  notes: readonly WorkNote[] = [],
  /** 这一轮还在跑：没返回的步骤是「进行中」，不是失败（审查模块 7）。 */
  live = false,
): WorkTimelineLine[] {
  const lines: WorkTimelineLine[] = [];
  const pending = [...notes].sort((a, b) => a.at - b.at);
  const flush = (upTo: number) => {
    while (pending.length && pending[0]!.at <= upTo) {
      const text = plainNote(pending.shift()!.text);
      if (text && !isBlankNote(text) && lines.at(-1)?.text !== text) lines.push({ kind: "note", text });
    }
  };
  let lastStep: string | undefined;
  calls.forEach((call, index) => {
    flush(index);
    if (NOT_WORK.has(call.name)) return;
    const line = describeWorkerStep(call.name, parseArgs(call.arguments));
    if (!line || line.startsWith("正在使用 ")) return;
    const state = workCallState(call, live);
    const marked = stepText(line, state);
    if (lines.at(-1)?.kind === "step" && lastStep === marked) return;
    lastStep = marked;
    lines.push({
      kind: "step",
      text: marked,
      call: { id: call.id, name: call.name },
      state,
    });
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
  let stopped = 0;
  for (const call of work) {
    const state = workCallState(call);
    // 停掉时没返回的：既不算做成，也不算失败（审查模块 7）。
    if (state === "stopped") {
      stopped += 1;
      continue;
    }
    const bad = state === "failed";
    if (call.name === "web_search") {
      if (bad) failedSearches += 1;
      else searches += 1;
    } else if (call.name === "web_fetch" || call.name === "computer_navigate") {
      if (bad) failedPages += 1;
      else pages += 1;
    }
  }
  const stoppedText = stopped ? `${stopped} 步已停止` : "";
  const webOnly =
    searches + pages + failedSearches + failedPages + stopped === work.length &&
    work.every((c) => c.name === "web_search" || c.name === "web_fetch" || c.name === "computer_navigate");
  if (webOnly) {
    const parts = [
      searches ? `搜索 ${searches} 次` : "",
      pages ? `看了 ${pages} 个网页` : "",
      failedPages || failedSearches
        ? `${failedPages + failedSearches} 步失败`
        : "",
      stoppedText,
    ].filter(Boolean);
    return parts.join(" · ") || "未读到网页";
  }
  const failed = work.filter((c) => workCallState(c) === "failed").length;
  return [`做了 ${work.length} 步`, failed ? `${failed} 步失败` : "", stoppedText].filter(Boolean).join(" · ");
}

/** web_fetch（server/src/web/tools.ts）结果的头几行：「网址：…」「状态：NNN」。只认 4xx / 5xx。 */
const HTTP_ERROR_HEAD = /^(?:网址：[^\n]*\n)?状态：[45]\d\d\b/;

/** 这一步被打断、没有返回：没有结果，或者服务器补了「This call produced no result」。 */
export function workCallInterrupted(result: string | undefined): boolean {
  return result === undefined || result.includes("This call produced no result");
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
  if (text.startsWith("Refused.") || workCallInterrupted(text)) return true;
  if (/^(error\b|错误|失败)/i.test(text)) return true;
  // 读网页拿到 4xx / 5xx（审查模块 7）：web_fetch 的结果开头是「网址：…\n状态：500」，以前只要有结果就算读到了。
  if (HTTP_ERROR_HEAD.test(text)) return true;
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
 * 做完的一轮还画不画那行步数。
 *
 * 2026-10-20 用户：「全部不显示步数吧，只留回答」。所以做完、有结果的一轮，那行步数一律收起——
 * 失败过的、步数多的、搜索网页的都不再单独占一行，回答就是回答（失败的提示卡「这一轮没有做完」
 * 和确认卡是另外的东西，不受影响）。还在跑的那一行照旧（不然聊天像卡住），只是不再写「第 N 步」。
 *
 * 想改回 §93 的「只收简单回合」，把这里改成 `false` 即可，下面的白名单 / 步数 / 用时规则都还在。
 */
export const HIDE_FINISHED_WORK_SUMMARY = true;

/**
 * 这一轮做完以后要不要把干活卡整行收起（DESIGN.md §93，用户 2026-10-16「做了 2 步 7 秒这个应该隐藏」）。
 * 唯一的判断，渲染和测试都用它。全部成立才收：
 *  - 这一轮结束了（不在跑）、没被停掉，并且有结果（最后一段回答）；
 *  - 每个调用都有结果、没有一个出错 / 被拒 / 被中断；
 *  - 只用了 QUIET_TOOLS 里的工具（加上不算步骤的准备动作），步数 1..QUIET_MAX_STEPS；
 *  - 没有确认卡（`confirmed` = 有确认请求的调用 id）；
 *  - 用时：这一页知道（亲眼看着跑过 / 记下过）时不超过 QUIET_MAX_SECONDS 秒；不知道就不看。
 * 收起的只是这一行的画法：调用、过程话都还在 `compactTurns().work` 里，打开「调试：显示工具调用」照常全画。
 *
 * `genericSummary`（2026-10-20 用户「把做了几步去掉，隐藏」）：这一行除了「做了 N 步」什么也说不出
 * （`summarizeDoneWork().generic`，例如跑了几条命令）。这种行没有信息量：工具白名单和用时都不再拦它，
 * 成功做完、步数不超过 QUIET_MAX_STEPS 就整行收起——「做了 2 步 · 13 秒」不该占在回答上面。
 * 失败的（「1 步失败」）照常显示；步数多的（>QUIET_MAX_STEPS）也照常显示。
 */
export function isQuietWork({
  calls,
  live,
  stopped = false,
  hasFinal,
  confirmed,
  seconds = null,
  genericSummary = false,
  hideSummary = HIDE_FINISHED_WORK_SUMMARY,
}: {
  calls: readonly WorkCall[];
  live: boolean;
  stopped?: boolean;
  hasFinal: boolean;
  confirmed?: ReadonlySet<string> | undefined;
  seconds?: number | null;
  genericSummary?: boolean;
  /** 见 `HIDE_FINISHED_WORK_SUMMARY`：做完有结果就整行收起，不再看失败 / 步数 / 用时。 */
  hideSummary?: boolean;
}): boolean {
  if (live) return false;
  // 用户要的是「只留回答」：有回答时那行步数一律不画（2026-10-20）。
  // 回复显示①（2026-10-29）：没有看得见的回答（工具失败、后面没有字，或只回了「---」）时不收——
  // 收了这一轮就是一片空白；这一行留着（「N 步失败」），下面再挂「这一轮没有回答」和重试。
  // 审查模块 7：被停掉的一轮也不收——那一行留着（收起的，点开看做过哪些步、哪些被停掉），以前停下后只剩「已停止」。
  if (hideSummary) return hasFinal && !stopped;
  if (stopped || !hasFinal) return false;
  let steps = 0;
  for (const call of calls) {
    if (!call.done || call.failed) return false;
    if (call.id && confirmed?.has(call.id)) return false;
    if (NOT_WORK.has(call.name)) continue;
    // 只说得出「做了 N 步」的一轮，工具在不在白名单里都不影响：这一行本来就没说做了什么。
    if (!QUIET_TOOLS.has(call.name) && !genericSummary) return false;
    steps += 1;
  }
  if (steps === 0 || steps > QUIET_MAX_STEPS) return false;
  // 说得出「跑了很久」的那几轮不再悄悄收起；「做了 N 步」本身没有信息量，用时也不拦它。
  if (genericSummary) return true;
  return seconds === null || seconds <= QUIET_MAX_SECONDS;
}
