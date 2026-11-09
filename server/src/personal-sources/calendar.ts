import ical, { type ParameterValue } from "node-ical";
import type { CalendarEventItem } from "../../../shared/personal-sources";

export type CalendarWindow = { from?: Date; to?: Date; timeZone?: string };
const text = (value: ParameterValue | undefined) =>
  typeof value === "string" ? value : (value?.val ?? "");

/** Keep the ICS parser authoritative; only give floating times the account's explicit timezone. */
export function parseIcsEvents(
  icsText: string,
  window: CalendarWindow = {},
): CalendarEventItem[] {
  const timeZone = window.timeZone ?? "Asia/Shanghai";
  new Intl.DateTimeFormat("en", { timeZone }).format();
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");
  if (!/^BEGIN:VCALENDAR\s*$/im.test(unfolded))
    throw new Error("日历服务未返回有效的 iCalendar 内容。");
  const calendarZone =
    /^X-WR-TIMEZONE:(.+)$/im.exec(unfolded)?.[1]?.trim() || timeZone;
  new Intl.DateTimeFormat("en", { timeZone: calendarZone }).format();
  let inEvent = false;
  const normalized = unfolded
    .split(/\r?\n/)
    .map((line) => {
      if (line.toUpperCase() === "BEGIN:VEVENT") inEvent = true;
      if (line.toUpperCase() === "END:VEVENT") inEvent = false;
      if (!inEvent) return line;
      const match =
        /^(DTSTART|DTEND|RECURRENCE-ID|EXDATE|RDATE)((?:;[^:]*)?):(.+)$/i.exec(
          line,
        );
      if (!match) return line;
      const [, name, params = "", values = ""] = match;
      if (
        /;TZID=/i.test(params) ||
        /;VALUE=DATE(?:;|$)/i.test(params) ||
        !values.split(",").every((value) => /^\d{8}T\d{6}$/.test(value))
      )
        return line;
      return `${name}${params};TZID=${calendarZone}:${values}`;
    })
    .join("\r\n");
  const parsed = ical.sync.parseICS(normalized);
  const from = window.from ?? new Date(Date.now() - 86_400_000);
  const to = window.to ?? new Date(Date.now() + 30 * 86_400_000);
  if (!Number.isFinite(+from) || !Number.isFinite(+to) || to < from)
    throw new Error("日历查询时间范围不正确。");
  const events: CalendarEventItem[] = [];
  for (const event of Object.values(parsed)) {
    if (event?.type !== "VEVENT" || event.status === "CANCELLED") continue;
    for (const instance of ical.expandRecurringEvent(event, {
      from,
      to,
      expandOngoing: true,
    })) {
      if (instance.event.status === "CANCELLED") continue;
      const recurrence =
        instance.event.recurrenceid?.toISOString() ??
        instance.start.toISOString();
      events.push({
        uid:
          event.rrule || instance.isOverride
            ? `${event.uid}::${recurrence}`
            : event.uid,
        summary: text(instance.summary) || "未命名日程",
        startIso: instance.start.toISOString(),
        endIso: instance.end.toISOString(),
        allDay: instance.isFullDay,
        timeZone: instance.start.tz ?? calendarZone,
        ...(instance.isFullDay
          ? { startDate: instance.start.toISOString().slice(0, 10) }
          : {}),
        ...(text(instance.event.location)
          ? { location: text(instance.event.location) }
          : {}),
        ...(text(instance.event.description)
          ? { description: text(instance.event.description).slice(0, 180) }
          : {}),
      });
    }
  }
  return events.sort((a, b) => a.startIso.localeCompare(b.startIso));
}
