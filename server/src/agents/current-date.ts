import { SCHEDULE_DEFAULT_TZ } from "../../../shared/schedules";

/**
 * 用户所在的时区（2026-10-29 模块 8 审查第 1 条）。
 *
 * 以前「当前时间」按服务器进程的时区写，线上容器是 UTC；长期记忆（memory-notes）和定时任务却按
 * Asia/Shanghai 记日期。北京时间 0–8 点这两个日期差一天，模型一边看到「10 月 29 日（UTC）」、一边看到
 * 「今天是 2026-10-30」，问「今天几号 / 明天」就可能答错。现在还没有按人设置的时区，三处统一用这一个。
 */
export const USER_TIME_ZONE = SCHEDULE_DEFAULT_TZ;

const part = (
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
) => parts.find((entry) => entry.type === type)?.value ?? "";

/** 「UTC+08:00」这种写法；认不出来时退回 UTC。 */
function utcOffset(now: Date, timeZone: string): string {
  const name = part(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(now),
    "timeZoneName",
  );
  const offset = name.replace(/^GMT/, "");
  return offset ? `UTC${offset}` : "UTC";
}

/** 这个时区的本地时间，ISO 写法带偏移，例如 2026-10-30T07:30+08:00。 */
function localIso(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const offset = utcOffset(now, timeZone).replace(/^UTC/, "") || "Z";
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}T${part(parts, "hour")}:${part(parts, "minute")}${offset}`;
}

/** 给模型的「当前时间」一段：按用户时区写日期和钟点，并写明是哪个时区。 */
export function currentDateContext(
  now = new Date(),
  timeZone = USER_TIME_ZONE,
): string {
  const zh = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  }).format(now);
  const label = timeZone === "Asia/Shanghai" ? "北京时间，" : "";
  return `【当前时间】${zh}（${label}时区 ${timeZone}，${utcOffset(now, timeZone)}；本地 ISO：${localIso(now, timeZone)}）。用户说的「今天、明天、下周一」都按这个时区的日期算，和长期记忆里的日期是同一套。回答今天几月几号、星期几、当前时间或计算相对日期时直接据此作答，无需调用 computer_run_command 运行 date。`;
}
