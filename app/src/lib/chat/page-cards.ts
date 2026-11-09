import { pageIdFromResult } from "@/lib/pages";

/** 在聊天里画成页面卡片的工具（lib/conversations/pages-tool.tsx）。 */
export const PAGE_CARD_TOOLS: ReadonlySet<string> = new Set([
  "page_create",
  "page_update",
  "page_publish",
]);

type PageCall = { id: string; name: string; args: string; result?: string };

/** 这次调用对着哪个页面：有结果看结果里的 ⟦page:pg_…⟧，还在流参数时看参数 page 是不是 pg_ id（slug / 链接要等结果）。 */
export function pageKeyOf(call: PageCall): string | null {
  if (!PAGE_CARD_TOOLS.has(call.name)) return null;
  const fromResult = pageIdFromResult(call.result);
  if (fromResult) return fromResult;
  const arg = /"page"\s*:\s*"(?:[^"]*\/)?(pg_[a-z0-9]+)"/i.exec(call.args)?.[1];
  return arg ?? null;
}

/**
 * CB-021（DESIGN.md §54「同一轮同一页面一张卡」）：同一轮里对同一个页面调了好几次 page_*（做好 → 再改一版），只留一张卡。
 * 留「最后一次有结果的」；后面那次还在流参数、还没结果时，它先不出卡，前一张照常显示——任何时刻只有一张，
 * 结果一到就换成新的那张。不同页面各留各的。返回要藏起来的调用 id。
 */
export function supersededPageCalls(calls: readonly PageCall[]): Set<string> {
  const byPage = new Map<string, PageCall[]>();
  for (const call of calls) {
    const key = pageKeyOf(call);
    if (!key) continue;
    const list = byPage.get(key) ?? [];
    list.push(call);
    byPage.set(key, list);
  }
  const hidden = new Set<string>();
  // 改 / 发布还在流参数、还认不出是哪个页面（参数里 page 没写完，或写的是 slug / 链接），而这一轮前面已经有页面卡：
  // 几乎总是在改刚才那页，先不出骨架，免得旧卡下面闪一张「正在做」（结果一到按页面归组）。
  let seenPage = false;
  for (const call of calls) {
    if (!PAGE_CARD_TOOLS.has(call.name)) continue;
    if (pageKeyOf(call)) seenPage = true;
    else if (
      seenPage &&
      call.name !== "page_create" &&
      call.result === undefined
    )
      hidden.add(call.id);
  }
  for (const list of byPage.values()) {
    if (list.length < 2) continue;
    const keep =
      list.findLast((call) => call.result !== undefined) ??
      list[list.length - 1]!;
    for (const call of list) if (call !== keep) hidden.add(call.id);
  }
  return hidden;
}
