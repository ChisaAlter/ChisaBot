import { describe, expect, test } from "bun:test";
import { catalogueEntry } from "../src/plugins/catalogue";
import { CHINA_DIRECTORY, pathwayLines } from "../src/plugins/directory";

/**
 * 国内应用目录是「答得出怎么接」的数据面：connect_service 靠它给用户指路，
 * /api/plugins/directory 把它原样喂给浏览页。要钉住的合约有三条：
 * key 不重（alias 表按 key 指条目）；catalogueKey 必须指向真实收录条目
 * （指错了浏览页会链到 404）；每条都有接法（pathwayLines 非空）和文档入口。
 */

describe("the China-app directory", () => {
  test("every key is unique", () => {
    const keys = CHINA_DIRECTORY.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every promoted key names a real catalogue entry", () => {
    for (const entry of CHINA_DIRECTORY) {
      if (entry.catalogueKey) {
        expect(
          catalogueEntry(entry.catalogueKey),
          `${entry.key} promotes ${entry.catalogueKey}`,
        ).not.toBeNull();
      }
    }
  });

  test("every entry carries a pathway and an https docs link", () => {
    for (const entry of CHINA_DIRECTORY) {
      expect(
        pathwayLines(entry).length,
        `${entry.key} has no pathway`,
      ).toBeGreaterThan(0);
      expect(
        entry.docsUrl.startsWith("https://"),
        `${entry.key} docsUrl is not https`,
      ).toBe(true);
    }
  });

  test("a remote entry spells out its endpoint and its credential shape", () => {
    for (const entry of CHINA_DIRECTORY) {
      if (entry.connect.kind === "remote") {
        expect(entry.connect.url.length, entry.key).toBeGreaterThan(0);
        expect(entry.connect.auth.length, entry.key).toBeGreaterThan(0);
      }
      if (entry.connect.kind === "stdio") {
        expect(
          entry.connect.repoUrl ?? entry.connect.command,
          `${entry.key} stdio with no repo and no command`,
        ).toBeTruthy();
      }
    }
  });

  test("session-risk community servers keep their warning note", () => {
    const xiaohongshu = CHINA_DIRECTORY.find((e) => e.key === "xiaohongshu");
    expect(xiaohongshu).toBeDefined();
    expect(xiaohongshu!.official).toBe(false);
    expect(xiaohongshu!.note).toContain("封号");
    expect(xiaohongshu!.connect.kind).toBe("stdio");
  });

  test("the directory only claims what exists — link entries carry no fake MCP", () => {
    for (const entry of CHINA_DIRECTORY) {
      if (entry.connect.kind === "link") {
        expect(entry.catalogueKey, entry.key).toBeUndefined();
      }
    }
  });
});
