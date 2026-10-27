import { useEffect } from "react";
import { prefetchTranscript } from "@/lib/copilot/transcript-cache";
import { latestChannelFor } from "./latest";
import type { ChannelSummary } from "./queries";

/** 打开后多久开始空闲预取（毫秒）：先让当前这段对话把网络和主线程用完。 */
const IDLE_AFTER_MS = 2500;
/** 最多预取几个机器人（左栏前几个）。 */
const MAX_BOTS = 4;

/**
 * 切机器人要「秒切」（DESIGN.md §83）：打开后空闲时，把左栏前几个机器人正在用的那段对话读一次放进
 * `transcript-cache`，切过去第一帧就是它停在底部的样子。手机上没有悬停，只能靠这个。
 * 每段对话 30 秒内只读一次（缓存自己去重），当前打开的机器人不读（它自己在恢复）。
 */
export function usePrefetchBotChats(
  botIds: readonly string[],
  channels: ChannelSummary[] | undefined,
  currentBotId?: string | null,
) {
  const key = botIds.slice(0, MAX_BOTS).join(",");
  const ready = channels !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: channels 每次 socket 补丁都会换引用；只在机器人列表变了 / 列表第一次到时重排
  useEffect(() => {
    if (!ready || !key) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const botId of key.split(",")) {
          if (cancelled) return;
          const latest = latestChannelFor(botId, channels);
          if (botId === currentBotId || !latest) continue;
          await prefetchTranscript(latest.threadId, botId);
        }
      })();
    }, IDLE_AFTER_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // channels 每次 socket 补丁都会换引用；只在机器人列表变了 / 列表第一次到时重排。
  }, [key, ready, currentBotId]);
}

/** 悬停 / 聚焦 / 手指按下左栏某个机器人时先读它的对话（点下去之前那 100–300ms 也用上）。 */
export function prefetchBotChat(botId: string, latest: ChannelSummary | undefined) {
  if (latest) void prefetchTranscript(latest.threadId, botId);
}
