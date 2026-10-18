import { describe, expect, test } from "bun:test";
import { plainSummary } from "../src/components/chat/worker-card";
import { isWorkCall, summarizeDoneWork, summarizeWork, workStepLines } from "../src/lib/chat/work-steps";

describe("summarizeWork（DESIGN.md §70）", () => {
  test("没有工具调用就没有卡", () => {
    expect(summarizeWork([])).toBeNull();
  });
  test("当前步骤 = 最后一个能描述的调用；数步骤和完成数", () => {
    const s = summarizeWork([
      { name: "web_search", arguments: JSON.stringify({ query: "iPhone 17 Pro 国行价格" }), done: true },
      { name: "web_fetch", arguments: JSON.stringify({ url: "https://www.apple.com.cn/newsroom/" }), done: false },
    ]);
    expect(s).toEqual({ count: 2, done: 1, current: "正在读取 apple.com.cn" });
  });
  test("参数还没写完（半截 JSON）不报错", () => {
    expect(summarizeWork([{ name: "web_search", arguments: '{"query":"iph', done: false }])?.current).toBe("正在搜索");
  });
  test("维护清单这类返回 null 的调用不改那一行", () => {
    const s = summarizeWork([
      { name: "web_search", arguments: JSON.stringify({ query: "天气" }), done: true },
      { name: "worker_plan", arguments: "{}", done: true },
    ]);
    expect(s?.current).toBe("正在搜索「天气」");
  });
  test("没有中文说法的工具（skill_load）不当当前步骤，不露工具名", () => {
    expect(summarizeWork([{ name: "skill_load", arguments: "{}", done: false }])?.current).toBe("正在准备");
    expect(summarizeWork([{ name: "some_tool", arguments: "{}", done: false }])?.current).toBe("正在处理");
    const s = summarizeWork([
      { name: "web_search", arguments: JSON.stringify({ query: "降噪耳机" }), done: true },
      { name: "skill_load", arguments: "{}", done: false },
    ]);
    expect(s?.current).toBe("正在搜索「降噪耳机」");
  });
});

describe("summarizeDoneWork（DESIGN.md §70.2）", () => {
  const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: JSON.stringify(args), done: true });
  test("只有搜索 / 读网页：说搜了几次、看了几个网页", () => {
    const done = summarizeDoneWork([
      call("web_search", { query: "iPhone 17 Pro 价格" }),
      call("web_fetch", { url: "https://www.apple.com.cn/iphone" }),
      call("web_fetch", { url: "https://news.sina.com.cn/x" }),
      call("render_ui"),
    ]);
    expect(done?.label).toBe("搜索 1 次 · 看了 2 个网页");
    expect(done?.steps).toEqual(["搜索「iPhone 17 Pro 价格」", "读取 apple.com.cn", "读取 news.sina.com.cn"]);
  });
  test("有别的工具：做了几步；相同的步骤连着只记一次", () => {
    const done = summarizeDoneWork([call("computer_click"), call("computer_click"), call("web_search", { query: "x" })]);
    expect(done?.label).toBe("做了 3 步");
    expect(done?.steps).toEqual(["点击", "搜索「x」"]);
  });
  test("读技能不算一步；没有中文说法的工具算一步但不列名字", () => {
    const done = summarizeDoneWork([call("skill_load", { name: "x" }), call("web_search", { query: "q" }), call("some_tool")]);
    expect(done?.label).toBe("做了 2 步");
    expect(done?.steps).toEqual(["搜索「q」"]);
  });
  test("只画了卡片：不出这一行", () => {
    expect(summarizeDoneWork([call("render_ui")])).toBeNull();
    expect(summarizeDoneWork([])).toBeNull();
  });
});

describe("只读工具的说法（CB-022，DESIGN.md §70.3）", () => {
  const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: JSON.stringify(args), done: true });
  test("读类工具有中文说法，不露工具名", () => {
    expect(summarizeWork([call("memory_search", { query: "妈妈生日" })])?.current).toBe("正在翻记忆「妈妈生日」");
    expect(summarizeWork([call("github_list_issues", { repo: "ChisaAlter/ChisaBot" })])?.current).toBe("正在看 ChisaAlter/ChisaBot 的 Issue");
    expect(summarizeWork([call("github_get_issue", { repo: "a/b", number: 12 })])?.current).toBe("正在读 a/b#12");
    expect(summarizeWork([call("page_list")])?.current).toBe("正在看你的页面");
    expect(summarizeWork([call("schedule_list")])?.current).toBe("正在看定时任务");
    expect(summarizeWork([call("panel_list")])?.current).toBe("正在看面板");
    expect(summarizeWork([call("memory_save", { text: "x" })])?.current).toBe("正在记下来");
  });
  test("收成的一行把读类步骤列出来（去掉「正在」）", () => {
    const done = summarizeDoneWork([call("memory_search", { query: "护照" }), call("schedule_list")]);
    expect(done).toEqual({ label: "做了 2 步", steps: ["翻记忆「护照」", "看定时任务"] });
  });
});

describe("准备动作不当一步（DESIGN.md §75.2）", () => {
  const call = (name: string, args: Record<string, unknown> = {}, done = true) => ({ name, arguments: JSON.stringify(args), done });
  test("看技能 / 读技能：不当当前步骤、不数进第几步；只做了这些时写「正在准备」", () => {
    expect(summarizeWork([call("skill_list")])).toEqual({ count: 0, done: 0, current: "正在准备" });
    expect(summarizeWork([call("skill_list"), call("skill_load"), call("web_search", { query: "x" }, false)])).toEqual({ count: 1, done: 0, current: "正在搜索「x」" });
    // 最后一个是准备动作：当前步骤仍是前面那个干活的
    expect(summarizeWork([call("web_search", { query: "x" }), call("skill_list")])?.current).toBe("正在搜索「x」");
  });
  test("收成的一行不数看技能：只剩搜索 / 读网页时照样说「搜索 1 次 · 看了 1 个网页」", () => {
    const done = summarizeDoneWork([call("skill_list"), call("web_search", { query: "q" }), call("web_fetch", { url: "https://a.com/x" })]);
    expect(done?.label).toBe("搜索 1 次 · 看了 1 个网页");
    expect(summarizeDoneWork([call("skill_list"), call("render_ui")])).toBeNull();
  });
  test("干活卡点开的步骤 = 收成的一行点开的步骤", () => {
    const calls = [call("skill_list"), call("web_search", { query: "q" }), call("web_search", { query: "q" }), call("render_ui"), call("web_fetch", { url: "https://b.cn/" })];
    expect(workStepLines(calls)).toEqual(["搜索「q」", "读取 b.cn"]);
    expect(summarizeDoneWork(calls)?.steps).toEqual(workStepLines(calls));
  });
  test("哪些算干活（干活卡从它出现）", () => {
    for (const name of ["render_ui", "worker_plan", "skill_list", "skill_load"]) expect(isWorkCall(name)).toBe(false);
    for (const name of ["web_search", "web_fetch", "panel_create", "device_read_file"]) expect(isWorkCall(name)).toBe(true);
  });
});

describe("后台任务卡片收成一行的摘要（§75.2）", () => {
  test("去掉 markdown 记号", () => {
    expect(plainSummary("截至 **2026-10-16**，可优先试用 `TRAE`；见[官网](https://a.com)")).toBe("截至 2026-10-16，可优先试用 TRAE；见官网");
    expect(plainSummary("## 结论\n- 一\n- 二")).toBe("结论 一 二");
  });
});


describe("失败浏览不计「看了」（FIX-07）", () => {
  const call = (name: string, args: Record<string, unknown> = {}, extra: { failed?: boolean; done?: boolean } = {}) => ({
    name,
    arguments: JSON.stringify(args),
    done: extra.done ?? true,
    failed: extra.failed,
  });
  test("失败的 web_fetch 不算看了网页", () => {
    const done = summarizeDoneWork([
      call("web_search", { query: "HN" }),
      call("web_fetch", { url: "https://news.ycombinator.com" }, { failed: true }),
    ]);
    expect(done?.label).toBe("搜索 1 次 · 1 步失败");
    expect(done?.steps.some((s) => s.includes("失败"))).toBe(true);
  });
  test("全部失败时不说「看了 N 个网页」", () => {
    const done = summarizeDoneWork([call("web_fetch", { url: "https://example.com" }, { failed: true })]);
    expect(done?.label).toBe("1 步失败");
  });
});
