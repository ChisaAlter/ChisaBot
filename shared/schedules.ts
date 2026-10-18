/**
 * 定时任务 / 提醒（DESIGN.md §55，docs/schedules.md）：服务器和网页共用的类型与中文描述。
 */
export const SCHEDULE_MARKER = "⟦chisabot:schedule:";
export const SCHEDULE_DEFAULT_TZ = "Asia/Shanghai";

export type ScheduleKind = "once" | "cron";
export type ScheduleStatus = "active" | "paused" | "done" | "cancelled";
export type ScheduleRunStatus =
  | "running"
  | "ok"
  | "failed"
  | "waiting"
  | "skipped"
  | "queued";

export type ScheduleRunView = {
  id: string;
  scheduleId: string;
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: ScheduleRunStatus;
  result: string | null;
  manual: boolean;
};

export type ScheduleView = {
  id: string;
  agentId: string;
  threadId: string;
  source: "web" | "im";
  title: string;
  instruction: string;
  kind: ScheduleKind;
  cron: string | null;
  runAt: string | null;
  timezone: string;
  status: ScheduleStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ScheduleRunStatus | null;
  lastResult: string | null;
  runCount: number;
  createdAt: string;
  /** 「每天 09:00」「10月15日 周四 09:00（一次）」 */
  schedule: string;
  running: boolean;
  recentRuns?: ScheduleRunView[];
};

export type ScheduleEvent = {
  runId: string;
  scheduleId: string;
  title: string;
  agentId: string;
  threadId: string;
  status: ScheduleRunStatus;
  result: string | null;
  manual: boolean;
  finishedAt: string;
};

export const SCHEDULE_STATUS_ZH: Record<ScheduleStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  done: "已结束",
  cancelled: "已取消",
};

/**
 * 根据定时任务回合的回复文字，判断这次运行该记成什么状态（FIX-01）。
 *
 * 以前只要回合没抛错就标「已完成」，但回复里可能是「弹不出确认卡片 / 已放确认卡等你确认 /
 * ERR_TUNNEL」——列表上一片绿，详情才看出没做成。这里按正文归类；拿不准仍算 ok。
 */
/** 最近若干次是否全是 failed（Track B：连续失败自动暂停）。 */
export function failStreakShouldPause(
  recentStatuses: readonly ScheduleRunStatus[],
  streak = 3,
): boolean {
  if (recentStatuses.length < streak) return false;
  return recentStatuses.slice(0, streak).every((s) => s === "failed");
}

export function classifyScheduleReply(
  text: string,
): Exclude<ScheduleRunStatus, "running" | "queued"> {
  const t = text.trim();
  if (!t) return "ok";
  // 真的弹不出卡（无对话 / 非网页）：跳过这一次。
  if (/弹不出确认卡片/.test(t) && !/放了一张确认卡片/.test(t)) return "skipped";
  // 已放确认卡、在等用户：等你确认（非绿）。
  if (
    /放了一张确认卡片|在等他确认|需要你在网页上确认|做到一步需要你在网页上确认|等你确认/.test(
      t,
    )
  )
    return "waiting";
  // 硬失败：隧道、工具拒绝、明确没做成。
  if (
    /ERR_TUNNEL|ERR_[A-Z0-9_]+|隧道|运行失败：|没有执行[：:]|无法完成这次|没能完成|浏览器.*(失败|不可用|中断)/.test(
      t,
    )
  ) {
    return "failed";
  }
  return "ok";
}

export const RUN_STATUS_ZH: Record<ScheduleRunStatus, string> = {
  running: "运行中",
  ok: "已完成",
  failed: "失败",
  waiting: "等你确认",
  skipped: "已跳过",
  queued: "已插入对话",
};

const WEEK_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n: number) => String(n).padStart(2, "0");

/** 某个时刻在某个时区里的年月日时分和星期。 */
export function partsIn(at: Date, timeZone: string) {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = SCHEDULE_DEFAULT_TZ;
  }
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const get = (type: string) =>
    f.formatToParts(at).find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    get("weekday"),
  );
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday,
  };
}

/** 「今天 21:30」「明天 09:00」「10月17日 周六 09:00」「2027年1月2日 周六 09:00」——按那个时区。 */
export function formatWhen(
  at: Date | string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const date = typeof at === "string" ? new Date(at) : at;
  const p = partsIn(date, timeZone);
  const n = partsIn(now, timeZone);
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  const dayNumber = (x: { year: number; month: number; day: number }) =>
    Date.UTC(x.year, x.month - 1, x.day) / 86_400_000;
  const diff = dayNumber(p) - dayNumber(n);
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  if (diff === 2) return `后天 ${time}`;
  if (diff === -1) return `昨天 ${time}`;
  const year = p.year !== n.year ? `${p.year}年` : "";
  return `${year}${p.month}月${p.day}日 ${WEEK_ZH[p.weekday] ?? ""} ${time}`;
}

/** FIX-09：写进聊天记录的时间用绝对日，避免第二天仍显示「今天」。 */
export function formatWhenAbsolute(
  at: Date | string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const date = typeof at === "string" ? new Date(at) : at;
  const p = partsIn(date, timeZone);
  const n = partsIn(now, timeZone);
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  const year = p.year !== n.year ? `${p.year}年` : "";
  return `${year}${p.month}月${p.day}日 ${WEEK_ZH[p.weekday] ?? ""} ${time}`
    .replace(/ {2,}/g, " ")
    .trim();
}

const TZ_ZH: Record<string, string> = {
  "Asia/Shanghai": "北京时间",
  "Asia/Hong_Kong": "香港时间",
  "Asia/Taipei": "台北时间",
  "Asia/Tokyo": "东京时间",
  "Asia/Singapore": "新加坡时间",
  "Europe/London": "伦敦时间",
  "Europe/Berlin": "柏林时间",
  "America/New_York": "纽约时间",
  "America/Los_Angeles": "洛杉矶时间",
  UTC: "UTC",
};
export const tzLabel = (tz: string) => TZ_ZH[tz] ?? tz;

/** 五段 cron 的中文说法；认不出就原样给出。 */
export function describeCronZh(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return `cron「${cron}」`;
  const [min, hour, dom, mon, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const plain = (s: string, lo: number, hi: number) =>
    /^\d{1,2}$/.test(s) && Number(s) >= lo && Number(s) <= hi
      ? Number(s)
      : null;
  const m = plain(min, 0, 59);
  const h = plain(hour, 0, 23);
  const step = /^\*\/(\d{1,3})$/.exec(min);
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return `每 ${step[1]} 分钟`;
  const hstep = /^\*\/(\d{1,2})$/.exec(hour);
  if (m !== null && hstep && dom === "*" && mon === "*" && dow === "*")
    return `每 ${hstep[1]} 小时（第 ${m} 分）`;
  if (m !== null && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return m === 0 ? "每小时整点" : `每小时第 ${m} 分`;
  if (m === null || h === null) return `cron「${cron}」`;
  const time = `${pad(h)}:${pad(m)}`;
  if (dom === "*" && mon === "*") {
    if (dow === "*") return `每天 ${time}`;
    if (dow === "1-5") return `工作日 ${time}`;
    if (dow === "0,6" || dow === "6,0" || dow === "6,7") return `周末 ${time}`;
    if (/^[0-7](,[0-7])*$/.test(dow)) {
      const days = [...new Set(dow.split(",").map((d) => Number(d) % 7))].sort(
        (a, b) => ((a + 6) % 7) - ((b + 6) % 7),
      );
      return `每${days.map((d) => WEEK_ZH[d]).join("、")} ${time}`;
    }
  }
  if (mon === "*" && dow === "*") {
    const d = plain(dom, 1, 31);
    if (d !== null) return `每月 ${d} 日 ${time}`;
  }
  return `cron「${cron}」`;
}

export function describeSchedule(
  s: {
    kind: ScheduleKind;
    cron: string | null;
    runAt: string | Date | null;
    timezone: string;
  },
  now?: Date,
): string {
  const zone =
    s.timezone === SCHEDULE_DEFAULT_TZ ? "" : `（${tzLabel(s.timezone)}）`;
  if (s.kind === "once")
    return s.runAt
      ? `${formatWhen(s.runAt, s.timezone, now)}（一次）${zone}`
      : "一次";
  return `${describeCronZh(s.cron ?? "")}${zone}`;
}

/** 「⟦chisabot:schedule:<id>:<runId>⟧\n定时任务「标题」到点了（…）。\n…\n说明：…」拆开。 */
export function parseScheduleMessage(
  text: string,
): {
  scheduleId: string;
  runId: string;
  headline: string;
  instruction: string;
} | null {
  if (!text.startsWith(SCHEDULE_MARKER)) return null;
  const end = text.indexOf("⟧");
  if (end < 0) return null;
  const [scheduleId = "", runId = ""] = text
    .slice(SCHEDULE_MARKER.length, end)
    .split(":");
  const rest = text.slice(end + 1).replace(/^\n/, "");
  const [headline = "", ...lines] = rest.split("\n");
  const body = lines.join("\n");
  const at = body.indexOf("说明：");
  return {
    scheduleId,
    runId,
    headline: headline.trim(),
    instruction: (at >= 0 ? body.slice(at + 3) : body).trim(),
  };
}
