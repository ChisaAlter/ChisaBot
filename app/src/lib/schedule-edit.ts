import { partsIn, type ScheduleView, tzLabel } from "../../../shared/schedules";

/** CB-106 §2：设置 → 定时任务里的「编辑」表单。时间只给常用的几种，其余的按 cron 原样改。 */
export type EditRepeat = "once" | "daily" | "weekdays" | "cron";

export type ScheduleEditForm = {
  title: string;
  instruction: string;
  repeat: EditRepeat;
  /** daily / weekdays：「HH:MM」；once：「YYYY-MM-DDTHH:MM」（datetime-local 的格式）。 */
  at: string;
  cron: string;
};

export type ScheduleEditPatch = {
  title?: string;
  instruction?: string;
  when?:
    | { repeat: "once" | "daily" | "weekdays"; at: string }
    | { repeat: "cron"; cron: string };
};

const pad = (n: number) => String(n).padStart(2, "0");

/** 「00:40 北京时间」里的那个时区名。 */
export function scheduleZone(s: Pick<ScheduleView, "timezone">): string {
  return tzLabel(s.timezone);
}

/** 从已有任务填出表单：「M H * * *」→ 每天，「M H * * 1-5」→ 工作日，一次性 → 本地日期时间，其余 → cron。 */
export function editFormOf(
  s: Pick<
    ScheduleView,
    "title" | "instruction" | "kind" | "cron" | "runAt" | "timezone"
  >,
): ScheduleEditForm {
  const base = {
    title: s.title,
    instruction: s.instruction,
    cron: s.cron ?? "",
  };
  if (s.kind === "once" && s.runAt) {
    const p = partsIn(new Date(s.runAt), s.timezone);
    return {
      ...base,
      repeat: "once",
      at: `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`,
    };
  }
  const m = (s.cron ?? "").trim().match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/);
  if (m)
    return {
      ...base,
      repeat: m[3] === "*" ? "daily" : "weekdays",
      at: `${pad(Number(m[2]))}:${pad(Number(m[1]))}`,
    };
  return { ...base, repeat: "cron", at: "" };
}

/** 表单 → PATCH 体：只带改了的字段；时间没动就不发 when（不重算下次运行）。空名字 / 空内容 / 空时间返回错误。 */
export function editPatchOf(
  original: ScheduleEditForm,
  form: ScheduleEditForm,
): { patch: ScheduleEditPatch } | { error: string } {
  const title = form.title.trim();
  const instruction = form.instruction.trim();
  if (!title) return { error: "名字不能为空" };
  if (!instruction) return { error: "到点时做什么不能为空" };
  const patch: ScheduleEditPatch = {};
  if (title !== original.title.trim()) patch.title = title;
  if (instruction !== original.instruction.trim())
    patch.instruction = instruction;
  const timeChanged =
    form.repeat !== original.repeat ||
    (form.repeat === "cron"
      ? form.cron.trim() !== original.cron.trim()
      : form.at !== original.at);
  if (timeChanged) {
    if (form.repeat === "cron") {
      if (!form.cron.trim()) return { error: "请填写 cron 表达式" };
      patch.when = { repeat: "cron", cron: form.cron.trim() };
    } else if (form.repeat === "once") {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.at))
        return { error: "请选择日期和时间" };
      patch.when = { repeat: "once", at: form.at.replace("T", " ") };
    } else {
      if (!/^\d{2}:\d{2}$/.test(form.at)) return { error: "请选择时间" };
      patch.when = { repeat: form.repeat, at: form.at };
    }
  }
  return { patch };
}

/** 换重复方式时把时间换成对应的格式：每天 ⇄ 一次保留「HH:MM」，一次默认今天的那个时刻（按任务时区）。 */
export function switchRepeat(
  form: ScheduleEditForm,
  repeat: EditRepeat,
  now: Date = new Date(),
  timeZone?: string,
): ScheduleEditForm {
  const hm = form.at.length >= 16 ? form.at.slice(11, 16) : form.at;
  if (repeat === "once") {
    if (form.repeat === "once") return form;
    const p = partsIn(now, timeZone ?? "Asia/Shanghai");
    const time = hm || `${pad(p.hour)}:${pad(p.minute)}`;
    return {
      ...form,
      repeat,
      at: `${p.year}-${pad(p.month)}-${pad(p.day)}T${time}`,
    };
  }
  if (repeat === "cron") return { ...form, repeat };
  return { ...form, repeat, at: hm };
}
