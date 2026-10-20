import { describe, expect, test } from "bun:test";
import { modelMissingFromCatalog } from "../../shared/model-selection";

/**
 * P1（2026-10-20）：选中的模型被服务商下线后，发送前要拦下来。
 * 只认「两份数据都读到了」——列表没读到时一律不判，别把输入框锁死。
 */
const catalog = { models: [{ id: "codex/gpt-6-luna" }, { id: "minimax-m3.1-flash-free" }] };

describe("模型还在不在列表里", () => {
  test("在列表里 → 不拦", () => {
    expect(modelMissingFromCatalog({ model: "codex/gpt-6-luna" }, catalog)).toBe(false);
  });

  test("被下线（列表里没有）→ 拦", () => {
    expect(modelMissingFromCatalog({ model: "space-bunny-free" }, catalog)).toBe(true);
  });

  test("列表或设置还没读到 → 不拦（宁可发一次）", () => {
    expect(modelMissingFromCatalog(undefined, catalog)).toBe(false);
    expect(modelMissingFromCatalog({ model: "space-bunny-free" }, undefined)).toBe(false);
  });

  test("空目录（网关刚起来还没同步）→ 拦", () => {
    expect(modelMissingFromCatalog({ model: "codex/gpt-6-luna" }, { models: [] })).toBe(true);
  });
});
