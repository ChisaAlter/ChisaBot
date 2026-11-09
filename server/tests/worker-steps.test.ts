import { expect, test } from "bun:test";
import { initialStep, stripWorkerMarkers } from "../src/workers/service";

test("a new task card starts on a meaningful step, never 正在准备", () => {
  expect(initialStep([])).toBe("正在看任务要求");
  expect(
    initialStep([
      { text: "搜索东京天气", status: "current" },
      { text: "整理结果", status: "pending" },
    ]),
  ).toBe("搜索东京天气");
  expect(
    initialStep([
      { text: "打开网页", status: "done" },
      { text: "读取标题", status: "pending" },
    ]),
  ).toBe("读取标题");
});

test("worker markers are stripped", () => {
  expect(stripWorkerMarkers("⟦chisabot:worker-result:abc:done⟧ 结果")).toBe(
    "结果",
  );
});
