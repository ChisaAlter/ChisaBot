import { describeWorkerStep } from "../../../../shared/work-step";

/**
 * 主对话这一轮干了哪些活（DESIGN.md §70 干活卡）：从这一轮的工具调用里数步骤、取「当前步骤」那一行。
 * 只认结构 `{ name, arguments }`，不依赖聊天记录的具体类型，方便单测。
 */
export type WorkCall = { name: string; arguments: string; done: boolean };

export type WorkSummary = { count: number; done: number; current: string };

/**
 * 准备动作（看有哪些技能、读技能说明）：用户不关心，不当「当前步骤」、不数进「第几步」（DESIGN.md §74.2）。
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

export type DoneWork = { label: string; steps: string[] };

/** 真的在干活的调用（干活卡从第一个这样的调用出现、画在它那一行，DESIGN.md §74.1）。 */
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
  return { label: doneLabel(work), steps: workStepLines(work) };
}

/** 每一步一句（去掉「正在」，相同的连着只记一次，说不出来的不列）。干活卡点开、收成的一行点开都用它。 */
export function workStepLines(calls: readonly WorkCall[]): string[] {
  const steps: string[] = [];
  for (const call of calls) {
    if (NOT_WORK.has(call.name)) continue;
    const line = describeWorkerStep(call.name, parseArgs(call.arguments));
    if (!line || line.startsWith("正在使用 ")) continue;
    const past = line.replace(/^正在/, "");
    if (steps[steps.length - 1] !== past) steps.push(past);
  }
  return steps;
}

function doneLabel(work: readonly WorkCall[]): string {
  let searches = 0;
  let pages = 0;
  for (const call of work) {
    if (call.name === "web_search") searches += 1;
    else if (call.name === "web_fetch" || call.name === "computer_navigate") pages += 1;
  }
  const webOnly = searches + pages === work.length;
  return webOnly
    ? [searches ? `搜索 ${searches} 次` : "", pages ? `看了 ${pages} 个网页` : ""].filter(Boolean).join(" · ")
    : `做了 ${work.length} 步`;
}
