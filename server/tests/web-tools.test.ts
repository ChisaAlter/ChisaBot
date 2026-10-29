import { describe, expect, test } from "bun:test";
import { assertPublicUrl, htmlToText, parseDuckDuckGo, webTools } from "../src/web/tools";
import { clampRefresh } from "../src/live-panels/store";

describe("web tools", () => {
  test("parses DuckDuckGo html results and unwraps redirect links", () => {
    const html = `<div class="result results_links results_links_deep web-result "><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example &amp; A</a><a class="result__snippet" href="#">Snippet <b>bold</b></a></div>`;
    expect(parseDuckDuckGo(html)).toEqual([{ title: "Example & A", url: "https://example.com/a", snippet: "Snippet bold" }]);
  });
  test("html to text keeps headings and drops scripts", () => {
    const { title, text } = htmlToText("<html><title>T &amp; U</title><body><script>x()</script><h1>Hi</h1><p>One</p><ul><li>a</li></ul></body></html>");
    expect(title).toBe("T & U");
    expect(text).toContain("# Hi");
    expect(text).toContain("- a");
    expect(text).not.toContain("x()");
  });
  test("refuses private addresses", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertPublicUrl("http://10.1.2.3/")).rejects.toThrow();
    await expect(assertPublicUrl("http://[::1]/")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("http://localhost:3000/")).rejects.toThrow();
  });
  test("web_search advertises that it also covers how to connect a service", () => {
    /*
     * 2026-10-21，生产 v0.1.51：用户让星灵「去连腾讯 ima」，它一次工具都没调，回了三遍「没有连接器 /
     * 需要管理员开通」。同一模型（Magpie 的 codex/gpt-6-luna）在同一条提示词下，只把描述从
     * 「查事实、新闻、价格、天气、某个网站的地址」扩到「也查外部服务怎么接入」，第一轮就调了
     * web_search。模型不是不会用工具，是它没把「接入一个服务」当成搜索能回答的问题。
     */
    const search = webTools().find((tool) => tool.name === "web_search");
    expect(search?.description).toContain("怎么接入");
    expect(search?.description).toContain("MCP");
    expect(search?.description).toContain("开放平台");
  });
  test("live panel refresh floor is one hour", () => {
    expect(clampRefresh(5)).toBe(60);
    expect(clampRefresh(0)).toBeNull();
    expect(clampRefresh(1440)).toBe(1440);
  });
});

import {
  DDG_COOLDOWN_MS,
  isDuckDuckGoChallenge,
  NO_SEARCH_HITS,
  parseBing,
  queryUnits,
  relevantHits,
  resetSearchState,
  SEARCH_SOURCE_DOWN,
  searchResultText,
  SEARCH_TURN_STOPPED,
  SEARCH_TURN_STOPPED_DOWN,
  type SearchOutcome,
  searchWeb,
  unwrapBingUrl,
} from "../src/web/tools";
describe("Bing 回退（hark 对比 #3 #8 #11，2026-10-29）", () => {
  const ck = (real: string) => `https://www.bing.com/ck/a?!&&p=abc&ptn=3&ver=2&hsh=4&u=a1${Buffer.from(real).toString("base64url")}&ntb=1`;
  test("结果链接还原成真实网址，模型才能注明来源网站", () => {
    expect(unwrapBingUrl(ck("https://www.edifier.com/cn/w820nb-plus"))).toBe("https://www.edifier.com/cn/w820nb-plus");
    expect(unwrapBingUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(unwrapBingUrl("https://www.bing.com/ck/a?u=a1bm90IGEgdXJs")).toBe("https://www.bing.com/ck/a?u=a1bm90IGEgdXJs");
    const html = `<li class="b_algo"><h2><a href="${ck("https://www.edifier.com/").replace(/&/g, "&amp;")}">漫步者官网</a></h2><p>漫步者 W820NB Plus</p></li>`;
    expect(parseBing(html)[0]?.url).toBe("https://www.edifier.com/");
  });
  test("解出来的地址指向内网 / 本机时保留原 Bing 链接", () => {
    for (const inner of ["http://127.0.0.1/admin", "http://localhost:3000/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data"])
      expect(unwrapBingUrl(ck(inner))).toBe(ck(inner));
  });
  test("和问题无关的结果丢掉，相关的留下", () => {
    const hit = (title: string, snippet = "", url = "https://x.test/") => ({ title, snippet, url });
    const q = "500元以内 降噪耳机 推荐";
    expect(queryUnits(q)).toEqual(["元以", "降噪", "噪耳", "耳机"]);
    expect(queryUnits("500")).toEqual(["500"]);
    expect(relevantHits(q, [hit("Online CFD Trading | Plus500"), hit("500彩票网 - 彩票开奖"), hit("500元以下推荐哪款降噪蓝牙耳机？")]).map((h) => h.title)).toEqual(["500元以下推荐哪款降噪蓝牙耳机？"]);
    // 任一完整词命中就留下（「上海」），命中多的排前面
    expect(relevantHits("上海 咖啡店 推荐", [hit("上海市_百度百科", "上海市，简称沪"), hit("上海最值得去的18间精品咖啡馆")]).map((h) => h.title)).toEqual(["上海最值得去的18间精品咖啡馆", "上海市_百度百科"]);
    expect(relevantHits("latest technology news", [hit("latest - LEO Wörterbuch"), hit("Tech News | Today's Latest Technology News")])).toHaveLength(1);
    expect(relevantHits("site:reuters.com AI", [hit("AI news", "", "https://www.reuters.com/technology/")])).toHaveLength(1);
  });
  test("中文真实查询不被误杀（小爱审查 #407）：任一完整词命中即保留，两字词兜底", () => {
    const hit = (title: string, snippet = "", url = "https://x.test/") => ({ title, snippet, url });
    const titles = (q: string, hits: ReturnType<typeof hit>[]) => relevantHits(q, hits).map((h) => h.title);
    const keep = (q: string, good: string[], bad: string[] = []) => {
      const got = titles(q, [...bad.map((t) => hit(t)), ...good.map((t) => hit(t))]);
      expect([...got].sort()).toEqual([...good].sort());
    };
    keep("科技新闻 今天", ["IT之家 科技资讯", "今日科技要闻"], ["Online CFD Trading | Plus500"]);
    keep("漫步者 W820NB 价格", ["Edifier W820NB 评测"], ["Starbucks Coffee Company"]);
    keep("上海 咖啡店", ["上海十大咖啡店 - 大众点评", "Manner Coffee 上海门店"], ["Shanghai – Wikipedia"]);
    keep("小米 手环", ["小米手环 9 NFC版 - 小米商城", "Xiaomi Smart Band 9 小米 手环 评测"], ["Starbucks 星巴克"]);
    // hark 对比里线上真实发出的查询
    keep("科技新闻 2026年10月29日 AI 芯片 科技公司", ["IT之家 - 科技新闻", "AI 芯片出口新规"], ["QQ邮箱 - 登录"]);
    keep("latest technology news October 29 2026 AI technology Reuters", ["Technology News | Reuters"], ["latest - LEO Wörterbuch"]);
    keep("Apple iPhone 17 technical specifications official 6.3-inch A19 48MP", ["iPhone 17 - 技术规格 - Apple (中国大陆)"], ["Hotels in Berlin"]);
    keep("Google Pixel 10 specs official 6.3 inch Tensor G5 48 MP", ["Pixel 10 tech specs - Google Store"], ["Pexels: free stock photos"]);
    keep("上海 精品咖啡店 推荐 武康路 愚园路 咖啡 2025", ["武康路咖啡地图", "上海精品咖啡店推荐"], ["Shanghai – Wikipedia"]);
    keep("500元以内 主动降噪 真无线 耳机 2025 Redmi Buds 6 Pro 价格 评测", ["Redmi Buds 6 Pro - 小米商城", "真无线耳机 500 元档推荐"], ["Online CFD Trading | Plus500", "Fiat 500 – Wikipedia"]);
    // 英文按整词：「AI」不算命中 mail.qq.com
    expect(relevantHits("AI 芯片", [hit("QQ邮箱 - 登录", "", "https://mail.qq.com/")])).toEqual([]);
  });
  test("DuckDuckGo 回 202 反爬页：认出来、记日志，冷却期内直接走 Bing", async () => {
    resetSearchState();
    const bingGood = `<li class="b_algo"><h2><a href="https://www.edifier.com/">漫步者 W820NB Plus 降噪耳机</a></h2><p>漫步者官网</p></li>`;
    const calls: string[] = [];
    let clock = 1_000_000;
    const fetchPage = async (url: string) => {
      calls.push(url.includes("duckduckgo") ? "ddg" : "bing");
      return url.includes("duckduckgo") ? { status: 202, body: "<script src=\"/anomaly.js?cc=botnet\"></script>" } : { status: 200, body: bingGood };
    };
    const warn = console.warn;
    const logged: string[] = [];
    console.warn = (line: string) => logged.push(line);
    try {
      // 202 本身不算反爬，要同时有 anomaly 验证脚本（小爱审查 #407）
      expect(isDuckDuckGoChallenge({ status: 202, body: "" })).toBe(false);
      expect(isDuckDuckGoChallenge({ status: 202, body: '<div class="result"><a class="result__a" href="x">r</a></div>' })).toBe(false);
      expect(isDuckDuckGoChallenge({ status: 202, body: "<script src=\"/anomaly.js\"></script>" })).toBe(true);
      expect(isDuckDuckGoChallenge({ status: 200, body: "anomaly.js" })).toBe(true);
      expect(isDuckDuckGoChallenge({ status: 200, body: '<a class="result__a" href="x">anomaly</a>' })).toBe(false);
      const q = "漫步者 W820NB Plus 价格";
      const first = await searchWeb(q, 5, undefined, { fetchPage, now: () => clock });
      expect(first.hits.map((h) => h.url)).toEqual(["https://www.edifier.com/"]);
      expect(calls).toEqual(["ddg", "bing"]);
      expect(logged.some((line) => line.includes('"reason":"challenge"'))).toBe(true);
      expect(logged.join("")).not.toContain("W820NB");
      clock += DDG_COOLDOWN_MS - 1;
      await searchWeb(q, 5, undefined, { fetchPage, now: () => clock });
      expect(calls).toEqual(["ddg", "bing", "bing"]);
      clock += 2;
      await searchWeb(q, 5, undefined, { fetchPage, now: () => clock });
      expect(calls).toEqual(["ddg", "bing", "bing", "ddg", "bing"]);
    } finally {
      console.warn = warn;
      resetSearchState();
    }
  });
  test("DuckDuckGo 失败且 Bing 也失败：明说搜索源不可用；Bing 有结果但都不相关：只算没搜到", async () => {
    resetSearchState();
    const ddgOk = `<div class="result results_links"><a class="result__a" href="https://cafe.test/">上海咖啡馆推荐</a><a class="result__snippet">上海 咖啡</a></div>`;
    const bingJunk = `<li class="b_algo"><h2><a href="https://www.plus500.com/">Online CFD Trading | Plus500</a></h2><p>trade</p></li>`;
    const fake = (ddg: { status: number; body: string } | Error, bing: { status: number; body: string } | Error) => async (url: string) => {
      const r = url.includes("duckduckgo") ? ddg : bing;
      if (r instanceof Error) throw r;
      return r;
    };
    const q = "500元以内 降噪耳机";
    const down = await searchWeb(q, 5, undefined, { fetchPage: fake(new Error("blocked"), new Error("bing down")) });
    expect(down).toEqual({ hits: [], sourceDown: true });
    const bingEmpty = await searchWeb(q, 5, undefined, { fetchPage: fake(new Error("blocked"), { status: 200, body: "<html></html>" }) });
    expect(bingEmpty.sourceDown).toBe(true);
    // 过滤后为空不是源不可用（小爱审查 #407）
    const filtered = await searchWeb(q, 5, undefined, { fetchPage: fake(new Error("blocked"), { status: 200, body: bingJunk }) });
    expect(filtered).toEqual({ hits: [], sourceDown: false });
    expect(searchResultText(filtered)).toBe(NO_SEARCH_HITS);
    expect(searchResultText(down)).toBe(SEARCH_SOURCE_DOWN);
    expect(SEARCH_SOURCE_DOWN).toContain("当前搜索源不可用");
    expect(SEARCH_SOURCE_DOWN).toContain("不要再调用 web_search");
    const challenged = await searchWeb(q, 5, undefined, { fetchPage: fake({ status: 202, body: "anomaly.js" }, new Error("x")) });
    expect(challenged.sourceDown).toBe(true);
    resetSearchState();
    // DuckDuckGo 正常回了页面只是没结果：算没搜到，不算源不可用
    const empty = await searchWeb(q, 5, undefined, { fetchPage: fake({ status: 200, body: "<html>no results</html>" }, { status: 200, body: bingJunk }) });
    expect(empty.sourceDown).toBe(false);
    expect(searchResultText(empty)).toBe(NO_SEARCH_HITS);
    const ok = await searchWeb("上海 咖啡", 5, undefined, { fetchPage: fake({ status: 200, body: ddgOk }, new Error("unused")) });
    expect(ok.hits.map((h) => h.url)).toEqual(["https://cafe.test/"]);
    expect(searchResultText(ok)).toContain("https://cafe.test/");
    resetSearchState();
  });
  test("每轮在代码里限次：2 次没搜到后、或源不可用后，本轮不再联网搜索", async () => {
    let calls = 0;
    let next: SearchOutcome = { hits: [], sourceDown: false };
    const search = webTools({
      fetch: async () => {
        throw new Error("unused");
      },
      search: async () => [],
      outcome: async () => {
        calls++;
        return next;
      },
    }).find((tool) => tool.name === "web_search");
    if (!search) throw new Error("web_search missing");
    const turnA = new AbortController().signal;
    expect(await search.execute({ query: "上海 咖啡店" }, { signal: turnA })).toBe(NO_SEARCH_HITS);
    next = { hits: [{ title: "上海咖啡", url: "https://cafe.test/", snippet: "" }], sourceDown: false };
    expect(await search.execute({ query: "上海 咖啡" }, { signal: turnA })).toContain("https://cafe.test/");
    next = { hits: [], sourceDown: false };
    expect(await search.execute({ query: "上海 咖啡馆" }, { signal: turnA })).toBe(NO_SEARCH_HITS);
    expect(calls).toBe(3);
    expect(await search.execute({ query: "上海 精品咖啡" }, { signal: turnA })).toBe(SEARCH_TURN_STOPPED);
    expect(calls).toBe(3);
    // 新的一轮重新计数
    const turnB = new AbortController().signal;
    next = { hits: [], sourceDown: true };
    expect(await search.execute({ query: "小米 手环" }, { signal: turnB })).toBe(SEARCH_SOURCE_DOWN);
    expect(calls).toBe(4);
    next = { hits: [{ title: "小米手环", url: "https://mi.test/", snippet: "" }], sourceDown: false };
    expect(await search.execute({ query: "小米手环 9" }, { signal: turnB })).toBe(SEARCH_TURN_STOPPED_DOWN);
    expect(calls).toBe(4);
    expect(SEARCH_TURN_STOPPED).toStartWith("本轮不再搜索");
    expect(SEARCH_TURN_STOPPED_DOWN).toStartWith("本轮不再搜索");
  });
  test("没搜到时不叫模型接着换词连搜", () => {
    expect(NO_SEARCH_HITS).not.toContain("换个说法再搜一次");
    expect(NO_SEARCH_HITS).toContain("最多再换一次");
    expect(NO_SEARCH_HITS).toContain("没有联网核实");
  });
});

import { emptyMetrics } from "../src/live-panels/service";
test("面板 Metric 没有数值会被拦下", () => {
  const ok = JSON.stringify({ root: "c", elements: { c: { type: "Card", props: { title: "BTC" }, children: ["m"] }, m: { type: "Metric", props: { label: "现价", value: "$82,407" }, children: [] } } });
  const bad = JSON.stringify({ root: "c", elements: { c: { type: "Card", props: { title: "BTC" }, children: ["m"] }, m: { type: "Metric", props: { label: "现价", value: { $state: "/btc/price" } }, children: [] } } });
  expect(emptyMetrics(ok)).toEqual([]);
  expect(emptyMetrics(bad)).toEqual(["现价"]);
});

import { emptySections, pruneEmptySections } from "../../shared/json-render/empty-sections";
test("空的列表 / 重复区块：服务器报出来，浏览器剪掉（连同小标题）", () => {
  const spec = {
    root: "c",
    state: { days: [] as unknown[] },
    elements: {
      c: { type: "Card", props: { title: "香港天气" }, children: ["now", "h", "rep", "h2", "list"] },
      now: { type: "Metric", props: { label: "气温", value: "24.8°C" }, children: [] },
      h: { type: "Heading", props: { text: "未来 5 天" }, children: [] },
      rep: { type: "Stack", props: {}, repeat: { statePath: "/days" }, children: ["d"] },
      d: { type: "Text", props: { text: { $item: "label" } }, children: [] },
      h2: { type: "Heading", props: { text: "提醒" }, children: [] },
      list: { type: "List", props: { items: [{ title: "带伞" }] }, children: [] },
    },
  };
  expect(emptySections(spec as never)).toEqual(["未来 5 天"]);
  const pruned = pruneEmptySections(spec as never) as typeof spec;
  expect(pruned.elements.c.children).toEqual(["now", "h2", "list"]);
  const full = { ...spec, state: { days: [{ label: "周二" }] } };
  expect(emptySections(full as never)).toEqual([]);
  const emptyList = { root: "c", elements: { c: { type: "Stack", props: {}, children: ["h", "l"] }, h: { type: "Heading", props: { text: "新闻" }, children: [] }, l: { type: "List", props: { items: { $state: "/news" } }, children: [] } } };
  expect(emptySections(emptyList as never)).toContain("新闻");
});
