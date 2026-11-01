import { currentConfirmTurn } from "../confirmations/context";
import type { SearchHit } from "./tools";

/*
 * 推荐类回答要落在搜索结果上（0.1.108 验收 #8，2026-10-29）。
 *
 * 线上「上海有什么好的咖啡店」搜了 4 次，最后答「基于常见门店印象，未核实」：没有地址、人均、来源和链接卡。
 * 两个原因：① 搜索结果只给模型一串标题 + 摘要，摘要里其实有地址和人均，但没人提醒它用；② 一轮里搜索次数
 * 没有上限，模型拿到结果仍嫌不完美就换词重搜，搜完反而不敢用。
 *
 * 这里做两件事：把摘要里的地址 / 人均 / 价格抽出来标在每条结果下面，并在结果后面写明「推荐要用这些结果」；
 * 同一轮（同一个问题）最多联网搜索 {@link SEARCH_TURN_LIMIT} 次，够用就停。没搜到结果的次数上限由 #407 的
 * 相关性过滤和「没搜到最多再换一次」负责，这里不重复实现。
 */

/** 同一轮最多联网搜索几次。要并行的话一次发出两个 web_search，也算两次。 */
export const SEARCH_TURN_LIMIT = 2;

export const SEARCH_TURN_ENOUGH =
  "本轮已经搜过 2 次，不再联网搜索。直接用上面已经拿到的搜索结果回答：推荐时每个选项写名字、结果里出现的地址或人均 / 价格，并附上那条结果的网址作来源；摘要里没有地址时，可以 web_fetch 其中最相关的一个网址补上。";

/** 搜索结果后面跟的一句提醒：推荐 / 地点 / 价格类回答要用结果里的事实和网址，不能说成「凭印象」。 */
export const SEARCH_GROUNDING_NOTE =
  "（回答要用上面结果里的信息：推荐店铺 / 商品 / 地点时，每个选项写名字 + 结果里出现的地址或人均 / 价格 + 一句理由，来源写那条结果的网址；结果里没有的不要编。已经有结果就不要说「凭印象 / 未核实」，也不要为了更完美再换词重搜。）";

const ADDRESS =
  /(?:地址|位于|坐落于)[:：]?\s*([^\s，,。；;|｜]{4,40})|((?:[\p{Script=Han}]{2,4}市)?[\p{Script=Han}]{2,4}(?:区|县)[\p{Script=Han}\d]{1,20}(?:路|街|道|弄|巷|广场)[\d\-－]*(?:号|弄)?[^\s，,。；;|｜]{0,12})/u;
const PER_PERSON = /人均\s*[:：]?\s*[¥￥]?\s*(\d{1,5}(?:\.\d+)?)\s*元?/;
const PRICE = /[¥￥]\s*(\d{1,6}(?:\.\d+)?)|(\d{1,6}(?:\.\d+)?)\s*元(?![素宇])/;

/** 从一条结果的标题 / 摘要里抽出地址、人均或价格。抽不到就是空的，不猜。 */
export function hitFacts(hit: SearchHit): { address?: string; perPerson?: string; price?: string } {
  const text = `${hit.title} ${hit.snippet}`;
  const facts: { address?: string; perPerson?: string; price?: string } = {};
  const address = ADDRESS.exec(text);
  const place = (address?.[1] ?? address?.[2])?.replace(/[)）\]】]+$/, "");
  if (place) facts.address = place;
  const per = PER_PERSON.exec(text);
  if (per) facts.perPerson = `¥${per[1]}`;
  else {
    const price = PRICE.exec(text);
    if (price) facts.price = `¥${price[1] ?? price[2]}`;
  }
  return facts;
}

/** 搜索结果交给模型的文字：每条下面多一行抽出来的地址 / 人均 / 价格，最后跟 {@link SEARCH_GROUNDING_NOTE}。 */
export function formatSearchHits(hits: SearchHit[]): string {
  return hits
    .map((h, i) => {
      const facts = hitFacts(h);
      const extra = [
        facts.address ? `地址：${facts.address}` : "",
        facts.perPerson ? `人均：${facts.perPerson}` : "",
        facts.price ? `价格：${facts.price}` : "",
      ].filter(Boolean);
      return `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}${extra.length ? `\n   ${extra.join(" ｜ ")}` : ""}`;
    })
    .join("\n");
}

const turns = new WeakMap<object, { searches: number }>();

/**
 * 这一轮还能不能再联网搜一次；能的话顺手记上一次。键是这一轮的取消信号（每轮一个），没有就用确认上下文里的
 * 这一轮；都没有（单测、脚本直接调工具）就不限制。
 */
export function takeSearchSlot(signal?: AbortSignal): boolean {
  const key: object | undefined = signal ?? currentConfirmTurn();
  if (!key) return true;
  const state = turns.get(key) ?? { searches: 0 };
  turns.set(key, state);
  if (state.searches >= SEARCH_TURN_LIMIT) return false;
  state.searches++;
  return true;
}
