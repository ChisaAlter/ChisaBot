export type PinnedSortableBot = {
  id: string;
  pinned?: boolean;
  pinnedAt?: string | null;
};

function pinnedTimeMs(bot: PinnedSortableBot): number | null {
  if (!bot.pinned || !bot.pinnedAt) return null;
  const parsed = Date.parse(bot.pinnedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 左侧栏机器人排序：主机器人置顶，其余置顶机器人按 `pinnedAt` 降序排在最前，未置顶保持原有相对顺序。
 */
export function sortSidebarRoster<T extends PinnedSortableBot>(
  roster: readonly T[],
  mainBotId: string | null | undefined,
): { mainBot: T | undefined; others: T[]; ordered: T[] } {
  const mainBot = mainBotId
    ? roster.find((bot) => bot.id === mainBotId)
    : undefined;
  const remaining = mainBot
    ? roster.filter((bot) => bot.id !== mainBot.id)
    : [...roster];

  const indexed = remaining.map((bot, index) => ({ bot, index }));
  indexed.sort((left, right) => {
    const leftPinned = Boolean(left.bot.pinned);
    const rightPinned = Boolean(right.bot.pinned);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    if (leftPinned && rightPinned) {
      const leftTime = pinnedTimeMs(left.bot);
      const rightTime = pinnedTimeMs(right.bot);
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      if (leftTime !== null && rightTime === null) return -1;
      if (leftTime === null && rightTime !== null) return 1;
    }
    return left.index - right.index;
  });

  const others = indexed.map((entry) => entry.bot);
  const ordered = mainBot ? [mainBot, ...others] : others;
  return { mainBot, others, ordered };
}
