import { useRenderTool } from "@copilotkit/react-core/v2";
import { IconAlarm } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { z } from "zod";
import { type CardCheck, registerCardCheck } from "./tool-renderers";

/**
 * `schedule_create` 的确认卡（DESIGN.md §55）。RENDER ONLY：工具在服务器上执行，这里只把结果画成一张小卡：
 * ⏰ 名字 · 什么时候 · 下次 ·「管理」。被拒绝（时间过了、太密）就不画，机器人会用文字说明。
 */
const parameters = z.object({ title: z.string().optional() }).passthrough();

type Created = { ok?: boolean; confirmation?: string; schedule?: { id: string; title: string; schedule: string; kind: string; nextRunText: string | null } };

function parse(result: unknown): Created | null {
  // 服务器工具的结果有时被再包一层 JSON 字符串（"\"{…}\""），最多拆两层（同 worker-tool）。
  let value: unknown = result;
  for (let depth = 0; depth < 3 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const created = value as Created | null;
  return created && typeof created === "object" && created.ok && created.schedule ? created : null;
}

/** schedule_create 完成后画不画卡片：建成了才画；被拒绝 / 报错时 ScheduleCard 返回 null（同一个 parse）。 */
export const scheduleDrawsCard: CardCheck = registerCardCheck(["schedule_create"], ({ result }) => parse(result) !== null);

export function ScheduleTool() {
  useRenderTool({
    name: "schedule_create",
    parameters,
    render: ({ parameters: given, status, result }) => <ScheduleCard pending={status !== "complete"} result={parse(result)} title={typeof given?.title === "string" ? given.title : ""} />,
  });
  return null;
}

const ScheduleCard = memo(function ScheduleCard({ pending, result, title }: { pending: boolean; result: Created | null; title: string }) {
  if (!pending && !result) return null;
  const s = result?.schedule;
  return (
    <div className="schedule-card" data-state={pending ? "pending" : "done"} data-testid="schedule-card">
      <span className="schedule-card-ico">
        <IconAlarm className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="schedule-card-t">{s?.title || title || "定时任务"}</div>
        <div className="schedule-card-s">
          {pending ? "正在设置…" : s?.kind === "once" ? `${s.nextRunText ?? s.schedule} 提醒一次` : `${s?.schedule ?? ""}${s?.nextRunText ? ` · 下次 ${s.nextRunText}` : ""}`}
        </div>
      </div>
      {!pending ? (
        <Link className="schedule-card-a" to="/settings/schedules">
          {"管理"}
        </Link>
      ) : null}
    </div>
  );
});
