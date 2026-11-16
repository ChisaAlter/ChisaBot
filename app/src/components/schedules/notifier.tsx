import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "@/components/ui/toast";
import { useExternalConnection } from "@/hooks";
import { scheduleEvents, scheduleKeys } from "@/lib/schedules";
import { useOpenThread } from "@/lib/channels/open-thread";

const POLL_MS = 20_000;

/**
 * 定时任务跑完时通知（DESIGN.md §55）：每 20 秒问一次「之后有没有跑完的」，有就弹一条带「查看」的提示；
 * 页面在后台且允许了浏览器通知时再发一条系统通知。只报打开页面之后的，不补旧账。
 */
export function ScheduleNotifier() {
  const queryClient = useQueryClient();
  const openThread = useOpenThread();
  const since = useRef<string>(new Date().toISOString());
  const seen = useRef(new Set<string>());
  useExternalConnection(true, (_key, signal) => {
    let timer: number | undefined;
    const tick = async () => {
      try {
        const { events, now } = await scheduleEvents(since.current, signal);
        if (signal.aborted) return;
        const lastEvent = events.at(-1);
        if (lastEvent) {
          since.current = lastEvent.finishedAt;
          await queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
        } else if (now) {
          // 服务器时钟为准，往前留 5 秒余量（跑完和查询同一秒）。
          since.current = new Date(Math.max(Date.parse(since.current), Date.parse(now) - 5000)).toISOString();
        }
        for (const event of events) {
          if (seen.current.has(event.runId)) continue;
          seen.current.add(event.runId);
          const verb = event.status === "failed" ? "没有完成" : event.status === "waiting" ? "在等你确认" : event.status === "skipped" ? "跳过了" : event.manual ? "运行完了" : "到点了";
          const text = `⏰ 定时任务「${event.title}」${verb}${event.result && event.status !== "ok" && event.status !== "queued" ? `：${event.result.slice(0, 60)}` : ""}`;
          toast.action(text, "查看", () => void openThread(event.agentId, event.threadId));
          try {
            if (document.visibilityState === "hidden" && typeof Notification !== "undefined" && Notification.permission === "granted") {
              const n = new Notification(`定时任务「${event.title}」`, { body: (event.result ?? verb).slice(0, 120), tag: `chisabot-schedule-${event.runId}` });
              n.onclick = () => {
                window.focus();
                void openThread(event.agentId, event.threadId);
              };
            }
          } catch {
            // 浏览器不让发系统通知时，页面里的提示照样在。
          }
        }
      } catch {
        // 网络抖动：下一轮再问。
      } finally {
        if (!signal.aborted) timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };
    timer = window.setTimeout(() => void tick(), 4000);
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  });
  return null;
}
