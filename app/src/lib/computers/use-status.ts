import { useEffect, useState } from "react";
import {
  type ComputerStatus,
  currentComputerStatus,
  isChatRunning,
  onComputerStatus,
} from "@/lib/conversations/computer-activity";

/**
 * 这个机器人计算机的当前状态行。
 *
 * 一轮还在跑时一直留着最后一句（「刚刚打开 example.com」），不退回空闲提示——两步之间模型要想十几秒，
 * 以前 6 秒后就闪回「机器人用浏览器时…」，下一步一来又跳回来（2026-10-13 第四轮）。
 * 这一轮结束后再留 {@link LINGER_MS}，然后淡出为 null。
 */
const LINGER_MS = 6_000;

export function useComputerStatus(
  botId: string | undefined,
): ComputerStatus | null {
  const [value, setValue] = useState<ComputerStatus | null>(() => {
    const s = currentComputerStatus();
    return s &&
      s.botId === botId &&
      (s.pending || isChatRunning() || Date.now() - s.at < LINGER_MS)
      ? s
      : null;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: ComputerStatus | null = null;
    const settle = () => {
      clearTimeout(timer);
      // 还在动（工具在跑，或这一轮没结束）就不收；否则留一会儿再收。
      if (!last || last.pending || isChatRunning()) return;
      const left = Math.max(0, LINGER_MS - (Date.now() - last.at));
      timer = setTimeout(() => {
        if (!isChatRunning()) setValue(null);
      }, left);
    };
    const off = onComputerStatus((s) => {
      if (!s || s.botId !== botId) return;
      last = s;
      setValue(s);
      settle();
    });
    const onRunning = () => {
      // 一轮结束时从「现在」起再留 LINGER_MS。
      if (last && !isChatRunning()) last = { ...last, at: Date.now() };
      settle();
    };
    window.addEventListener("chisabot-chat-running", onRunning);
    return () => {
      off();
      window.removeEventListener("chisabot-chat-running", onRunning);
      clearTimeout(timer);
    };
  }, [botId]);
  return value;
}
