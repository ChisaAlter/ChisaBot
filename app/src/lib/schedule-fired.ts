import type { Message } from "@ag-ui/core";
import {
  parseScheduleMessage,
  partsIn,
  SCHEDULE_DEFAULT_TZ,
  SCHEDULE_MARKER,
} from "../../../shared/schedules";

/**
 * CB-105：对话里的「定时任务到点」行按消息自己的时间显示。旧消息（FIX-09 之前）标题里存的是写入当时的
 * 「今天 HH:00」，原样显示会让几天前的提醒看起来像刚到点；所以只用运行记录的时间，没有就不写时间。
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** 今天的写「今天 07:00」，不是今天的写「10月16日 07:00」，不是今年的再带年份。 */
export function firedTimeLabel(
  at: Date | string,
  now: Date = new Date(),
  timeZone: string = SCHEDULE_DEFAULT_TZ,
): string {
  const p = partsIn(new Date(at), timeZone);
  const n = partsIn(now, timeZone);
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  if (p.year === n.year && p.month === n.month && p.day === n.day)
    return `今天 ${time}`;
  return `${p.year === n.year ? "" : `${p.year}年`}${p.month}月${p.day}日 ${time}`;
}

/** 「定时任务「T」到点了（…）。」→ 名字和动作；括号里那段（可能是过时的「今天 HH:00」）丢掉。 */
export function splitFiredHeadline(headline: string): {
  title: string;
  verb: string;
} {
  const match = headline.match(/^定时任务「(.*)」(到点了|手动运行)/);
  if (!match)
    return {
      title: headline.replace(/（[^（）]*）。?$/, "").replace(/。$/, ""),
      verb: "",
    };
  return { title: match[1] ?? "", verb: match[2] ?? "" };
}

/** 行上的标题：时间来自运行记录；没有就只写「定时任务「T」到点了」，不再照抄旧的相对时间。 */
export function firedHeadline(
  headline: string,
  startedAt: string | null | undefined,
  now: Date = new Date(),
): string {
  const { title, verb } = splitFiredHeadline(headline);
  const base = verb ? `定时任务「${title}」${verb}` : title;
  return startedAt ? `${base}（${firedTimeLabel(startedAt, now)}）` : base;
}

/** 折叠行：「「T」到点 16 次，10/16–10/18」。 */
export function firedGroupSummary(
  title: string,
  count: number,
  times: readonly string[],
): string {
  const head = `「${title}」到点 ${count} 次`;
  if (!times.length) return head;
  const sorted = [...times].sort();
  const day = (at: string) => {
    const p = partsIn(new Date(at), SCHEDULE_DEFAULT_TZ);
    return `${p.month}/${p.day}`;
  };
  const first = day(sorted[0] ?? "");
  const last = day(sorted[sorted.length - 1] ?? "");
  return `${head}，${first === last ? first : `${first}–${last}`}`;
}

const textOf = (message: Readonly<Message>) =>
  typeof message.content === "string" ? message.content : "";

/** 被折进同一行的那几条（按第一条的 id 记）。ScheduleFiredRow 按自己的 id 来取。 */
const groups = new Map<string, readonly Readonly<Message>[]>();

export function scheduleGroupOf(
  messageId: string,
): readonly Readonly<Message>[] | undefined {
  return groups.get(messageId);
}

/**
 * 同一个任务连续出现、中间没有别的消息隔开的提醒，只留第一条，其余记进它的组里。别的消息原样返回。
 * 没有可折叠的时候返回原数组（不新建），不打扰下游按引用的判断。
 */
export function collapseScheduleRuns<T extends Readonly<Message>>(
  messages: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const out: T[] = [];
  let collapsed = false;
  let lead: T | null = null;
  let leadSchedule: string | null = null;
  let members: T[] = [];
  const flush = () => {
    if (lead && members.length > 1) groups.set(lead.id, members);
    else if (lead) groups.delete(lead.id);
  };
  for (const message of messages) {
    const text = message.role === "user" ? textOf(message) : "";
    const scheduleId = text.startsWith(SCHEDULE_MARKER)
      ? (parseScheduleMessage(text)?.scheduleId ?? null)
      : null;
    if (scheduleId && lead && scheduleId === leadSchedule) {
      members.push(message);
      collapsed = true;
      continue;
    }
    flush();
    lead = scheduleId ? message : null;
    leadSchedule = scheduleId;
    members = scheduleId ? [message] : [];
    out.push(message);
  }
  flush();
  return collapsed ? out : messages;
}
