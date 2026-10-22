import { describe, expect, test } from "bun:test";
import { buildStepText, groupSources, panelEditPrompt } from "../src/components/panels/panel-meta";
import { splitDotted } from "../src/lib/copilot/json-render/rich-utils";
import { currentWorkStep } from "../src/lib/chat/work-steps";

describe("panel sources row (DESIGN.md §77.2)", () => {
  test("sources on one site collapse into one name (common prefix)", () => {
    const groups = groupSources([
      { name: "Open-Meteo 东京 forecast API", url: "https://api.open-meteo.com/v1/forecast?latitude=35.6" },
      { name: "Open-Meteo 上海 forecast API", url: "https://api.open-meteo.com/v1/forecast?latitude=31.2" },
      { name: "Open-Meteo API 文档", url: "https://open-meteo.com/en/docs" },
    ]);
    // api.open-meteo.com 和 open-meteo.com 是同一个网站。
    expect(groups.map((g) => g.label)).toEqual(["Open-Meteo"]);
    expect(groups[0]!.names).toHaveLength(3);
  });
  test("different sites stay separate; sources without url dedupe by name and carry no link", () => {
    const groups = groupSources([
      { name: "中国天气网", url: "https://www.weather.com.cn/a" },
      { name: "本机命令", url: "" },
      { name: "本机命令", url: "" },
      { name: "CoinGecko", url: "https://www.coingecko.com/" },
    ]);
    expect(groups.map((g) => [g.label, g.url])).toEqual([
      ["中国天气网", "https://www.weather.com.cn/a"],
      ["本机命令", ""],
      ["CoinGecko", "https://www.coingecko.com/"],
    ]);
  });
  test("no common prefix → first name", () => {
    const groups = groupSources([
      { name: "东京天气", url: "https://x.cn/1" },
      { name: "上海天气", url: "https://x.cn/2" },
    ]);
    expect(groups[0]!.label).toBe("东京天气");
  });
});

describe("panel building step (DESIGN.md §77.1)", () => {
  test("panel tools read as plain Chinese; other steps pass through the work-card label", () => {
    expect(buildStepText(null)).toBe("正在准备");
    expect(buildStepText({ name: "panel_create", label: "正在更新面板" })).toBe("正在准备");
    expect(buildStepText({ name: "panel_update", label: "正在更新面板" })).toBe("正在把数据排进面板");
    expect(buildStepText({ name: "web_search", label: "正在搜索「东京天气」" })).toBe("正在搜索「东京天气」");
  });
  test("currentWorkStep skips prep tools", () => {
    expect(currentWorkStep([{ name: "skill_list", arguments: "{}", done: true }])).toBeNull();
    const step = currentWorkStep([
      { name: "skill_list", arguments: "{}", done: true },
      { name: "panel_create", arguments: "{}", done: true },
      { name: "web_search", arguments: JSON.stringify({ query: "东京天气" }), done: false },
    ]);
    expect(step?.name).toBe("web_search");
    expect(step?.label).toContain("东京天气");
  });
});

describe("dotted text (DESIGN.md §77.3)", () => {
  test("splits on · only when there are several parts", () => {
    expect(splitDotted("当前降水 0 mm · 风速 5.4 km/h")).toEqual(["当前降水 0 mm", "风速 5.4 km/h"]);
    expect(splitDotted("体感 15.9℃")).toBeNull();
    expect(splitDotted("·")).toBeNull();
  });
});

describe("让 AI 修改…的提示词 (DESIGN.md §109.3)", () => {
  test("带上卡片标题，冒号后面留给用户写要改什么", () => {
    expect(panelEditPrompt("比特币价格")).toBe("帮我改一下右栏这张「比特币价格」面板：");
    // 标题两边的空格不该变成两对引号里的空格。
    expect(panelEditPrompt("  服务器性能  ")).toBe("帮我改一下右栏这张「服务器性能」面板：");
  });
});
