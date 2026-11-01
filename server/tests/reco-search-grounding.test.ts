import { describe, expect, test } from "bun:test";
import { WORK_STYLE_GUIDANCE } from "../../shared/bot-prompt";
import {
  formatSearchHits,
  hitFacts,
  SEARCH_GROUNDING_NOTE,
  SEARCH_TURN_ENOUGH,
  SEARCH_TURN_LIMIT,
} from "../src/web/search-grounding";
import { type SearchHit, webFetch, webSearch, webTools } from "../src/web/tools";

/*
 * 0.1.108 验收 #8（2026-10-29）：「上海有什么好的咖啡店」搜了 4 次，答「基于常见门店印象，未核实」，
 * 没有地址 / 人均 / 来源。下面用模拟的搜索结果，验证交给模型的结果里带着地址、人均和网址，
 * 提示词要求推荐用它们，并且同一轮最多联网搜 2 次。
 */
const COFFEE: SearchHit[] = [
  {
    title: "Manner Coffee 南京西路店 - 大众点评",
    url: "https://www.dianping.com/shop/manner-njxl",
    snippet: "地址：上海市静安区南京西路1266号恒隆广场B1 人均￥25 招牌拿铁，出杯快。",
  },
  {
    title: "上海 10 家值得专门去的精品咖啡馆",
    url: "https://www.example-guide.cn/shanghai-coffee",
    snippet: "Seesaw Coffee 位于黄浦区淮海中路138号，人均 38 元，手冲单品豆多。",
  },
  {
    title: "咖啡店排行榜",
    url: "https://www.example-rank.cn/list",
    snippet: "看看大家都喜欢哪家。",
  },
];

const tool = (search: typeof webSearch) =>
  webTools({ fetch: webFetch, search }).find((t) => t.name === "web_search")!;

describe("推荐类回答落在搜索结果上", () => {
  test("从摘要里抽出地址和人均，抽不到就不猜", () => {
    expect(hitFacts(COFFEE[0]!)).toEqual({ address: "上海市静安区南京西路1266号恒隆广场B1", perPerson: "¥25" });
    expect(hitFacts(COFFEE[1]!)).toEqual({ address: "黄浦区淮海中路138号", perPerson: "¥38" });
    expect(hitFacts(COFFEE[2]!)).toEqual({});
    expect(hitFacts({ title: "AirPods Pro 2", url: "https://x.cn", snippet: "京东到手价 ¥1399" })).toEqual({ price: "¥1399" });
  });

  test("模拟搜索结果：交给模型的文字带地址、人均、网址和「推荐要用结果」的提醒", async () => {
    const out = String(await tool(async () => COFFEE).execute({ query: "上海 咖啡店 推荐" }));
    expect(out).toContain("https://www.dianping.com/shop/manner-njxl");
    expect(out).toContain("地址：上海市静安区南京西路1266号恒隆广场B1 ｜ 人均：¥25");
    expect(out).toContain("https://www.example-guide.cn/shanghai-coffee");
    expect(out).toContain("地址：黄浦区淮海中路138号 ｜ 人均：¥38");
    expect(out).toContain(SEARCH_GROUNDING_NOTE);
    // 提醒在 untrusted 信封外面，是我们自己的话，不会被当成网页内容忽略。
    expect(out.indexOf(SEARCH_GROUNDING_NOTE)).toBeGreaterThan(out.lastIndexOf("https://www.example-rank.cn/list"));
    expect(formatSearchHits([COFFEE[2]!])).not.toContain("地址：");
  });

  test("同一轮最多联网搜 2 次（并行发出的也算），第 3 次不联网、让它用已有结果回答", async () => {
    let calls = 0;
    const search = tool(async () => {
      calls++;
      return COFFEE;
    });
    const turn = new AbortController();
    const ctx = { signal: turn.signal } as Parameters<typeof search.execute>[1];
    const [a, b] = await Promise.all([
      search.execute({ query: "上海 咖啡店 推荐" }, ctx),
      search.execute({ query: "上海 精品咖啡 人均 地址" }, ctx),
    ]);
    expect(String(a)).toContain("dianping.com");
    expect(String(b)).toContain("dianping.com");
    expect(await search.execute({ query: "上海 咖啡 必去" }, ctx)).toBe(SEARCH_TURN_ENOUGH);
    expect(await search.execute({ query: "上海 咖啡 第四次" }, ctx)).toBe(SEARCH_TURN_ENOUGH);
    expect(calls).toBe(SEARCH_TURN_LIMIT);
    // 下一轮（新的取消信号）重新计数。
    const next = { signal: new AbortController().signal } as Parameters<typeof search.execute>[1];
    expect(String(await search.execute({ query: "北京 咖啡店" }, next))).toContain("dianping.com");
    expect(calls).toBe(3);
  });

  test("提示词：推荐要基于结果、写地址或人均和来源、最多搜 2 次并行、不写「凭印象 / 未核实」", () => {
    const line = WORK_STYLE_GUIDANCE.split("\n").find((l) => l.startsWith("- 推荐类问题"))!;
    expect(line).toContain("答案要落在搜索结果上");
    expect(line).toContain("最多搜 2 次");
    expect(line).toContain("并行");
    expect(line).toContain("地址");
    expect(line).toContain("人均");
    expect(line).toContain("来源");
    expect(line).toContain("不要写「基于常见印象」「未核实」");
    expect(line).not.toContain("搜一两次");
    expect(SEARCH_TURN_ENOUGH).toContain("网址");
  });
});
