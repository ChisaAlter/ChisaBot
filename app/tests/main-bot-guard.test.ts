import { describe, expect, test } from "bun:test";
import { mainBotCandidates } from "@/components/agents/main-bot-picker";

/** 主机器人不能直接删除；可以换一个（CB-091）。 */

describe("mainBotCandidates", () => {
  const roster = [
    { id: "chisa", name: "千咲" },
    { id: "helper", name: "小助手" },
    { id: "browser", name: "浏览器", hidden: true },
  ];

  test("everyone visible except the current main bot", () => {
    expect(mainBotCandidates(roster, "chisa").map((bot) => bot.id)).toEqual(["helper"]);
  });

  test("hidden bots are never offered", () => {
    expect(mainBotCandidates(roster, null).map((bot) => bot.id)).toEqual(["chisa", "helper"]);
  });

  test("a lone main bot has no replacement", () => {
    expect(mainBotCandidates([{ id: "chisa", name: "千咲" }], "chisa")).toEqual([]);
    expect(mainBotCandidates(undefined, "chisa")).toEqual([]);
  });
});
