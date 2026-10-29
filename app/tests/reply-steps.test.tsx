import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { compactTurns } from "@/components/channels/chat-transcript";
import {
  capsuleSeconds,
  StatusCapsule,
} from "@/components/chat/status-capsule";
import { WorkRow } from "@/components/chat/work-card";
import {
  isBlankNote,
  type WorkCall,
  workTimeline,
} from "@/lib/chat/work-steps";
import { settleReactWork } from "./settle-react-work";

/**
 * 回复显示①（2026-10-29，参考 Hark）：工具过程做完收起、空的「---」步骤去掉、等待时只有一行状态胶囊、
 * 不再有「思考中」占位气泡。
 */

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered)
    GlobalRegistrator.register({ url: "http://localhost:3000/" });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const search = (q: string, done = true): WorkCall => ({
  name: "web_search",
  arguments: JSON.stringify({ query: q }),
  done,
});

describe("空的「---」步骤", () => {
  test("只有分隔线 / 标点的一段算没有字", () => {
    for (const text of ["---", " *** ", "___", "- - -", "…", "——", "\n---\n"])
      expect(isBlankNote(text)).toBe(true);
  });
  test("有字、数字或表情的照常", () => {
    for (const text of ["我再查一下", "3", "OK", "👍", "--- 下面是结果"])
      expect(isBlankNote(text)).toBe(false);
  });
  test("干活卡点开的一列里不出现空的一步", () => {
    const lines = workTimeline(
      [search("东京天气"), search("大阪天气")],
      [
        { at: 1, text: "---" },
        { at: 1, text: "接着查大阪" },
        { at: 2, text: "***" },
      ],
    );
    expect(lines.map((line) => line.text)).not.toContain("---");
    expect(lines.map((line) => line.text)).not.toContain("***");
    expect(
      lines.filter((line) => line.kind === "note").map((line) => line.text),
    ).toEqual(["接着查大阪"]);
  });
});

describe("对话里的「---」一段", () => {
  type Item = Parameters<typeof compactTurns>[0][number];
  const user = (id: string, text: string): Item =>
    ({ kind: "text", id, role: "user", text }) as Item;
  const bot = (id: string, text: string): Item =>
    ({ kind: "text", id, role: "assistant", text }) as Item;
  const tool = (id: string, query: string): Item =>
    ({
      kind: "tool",
      id,
      toolCall: {
        id,
        type: "function",
        function: { name: "web_search", arguments: JSON.stringify({ query }) },
      },
      result: "ok",
    }) as Item;
  test("跑着、做完都不画成气泡，也不进干活卡；结果照旧", () => {
    const items = [
      user("u1", "查天气"),
      tool("t1", "东京天气"),
      bot("a1", "---"),
      tool("t2", "大阪天气"),
      bot("a2", "东京晴，大阪多云。"),
    ];
    for (const live of [true, false]) {
      const compact = compactTurns(items, live, new Set());
      expect(compact.hidden.has("a1")).toBe(true);
      expect(
        compact.work.get("t1")?.notes.map((note) => note.text) ?? [],
      ).not.toContain("---");
    }
    const done = compactTurns(items, false, new Set());
    expect(done.tone.get("a2")).toBe("final");
    expect(done.hidden.has("a2")).toBe(false);
  });
});

describe("状态胶囊", () => {
  test("转圈 + 动作 + 已用秒数，读屏只读动作", () => {
    const { getByTestId, getByRole } = render(
      <StatusCapsule label="思考中" since={Date.now() - 5_200} />,
    );
    const capsule = getByTestId("status-capsule");
    expect(capsule.getAttribute("data-state")).toBe("live");
    expect(capsule.querySelector(".rs-spinner")).not.toBeNull();
    expect(getByRole("status").textContent).toBe("思考中");
    const time = capsule.querySelector(".rs-capsule-time")!;
    expect(time.getAttribute("aria-hidden")).toBe("true");
    expect(time.textContent).toBe("5 秒");
  });
  test("不到 1 秒不写秒数", () => {
    expect(capsuleSeconds(1000, 1500)).toBe("");
    expect(capsuleSeconds(1000, 3999)).toBe("2 秒");
  });
  test("干活卡跑着的时候就是这个胶囊：转圈，不再是三个跳点", () => {
    const { getByTestId } = render(
      <WorkRow
        calls={[search("东京天气", false)]}
        live
        since={Date.now() - 3_000}
        turnKey="rs-live-1"
      />,
    );
    const card = getByTestId("chat-work-card");
    expect(card.className).toContain("rs-capsule");
    expect(card.className).not.toContain("chat-thinking");
    expect(card.querySelector(".rs-spinner")).not.toBeNull();
    expect(card.querySelector(".chat-thinking-dots")).toBeNull();
    expect(card.textContent).toContain("3 秒");
  });
});

describe("工具过程做完后收起", () => {
  test("跑着时点开的步骤，这一轮结束就收起", async () => {
    const key = "rs-collapse-1";
    const { getByTestId, queryByTestId, rerender } = render(
      <WorkRow calls={[search("东京天气", false)]} live turnKey={key} />,
    );
    fireEvent.click(getByTestId("chat-work-card"));
    expect(queryByTestId("chat-work-steps")).not.toBeNull();
    await act(async () => {
      rerender(
        <WorkRow calls={[search("东京天气")]} live={false} turnKey={key} />,
      );
    });
    expect(queryByTestId("chat-work-steps")).toBeNull();
    expect(getByTestId("chat-work-done").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });
  test("从历史打开的做完的一轮也是收起的（不沿用点开过的记忆）", () => {
    const key = "rs-collapse-2";
    const first = render(
      <WorkRow calls={[search("东京天气", false)]} live turnKey={key} />,
    );
    fireEvent.click(first.getByTestId("chat-work-card"));
    first.unmount();
    const { queryByTestId } = render(
      <WorkRow calls={[search("东京天气")]} live={false} turnKey={key} />,
    );
    expect(queryByTestId("chat-work-steps")).toBeNull();
  });
});

describe("胶囊样式守规矩", () => {
  // 注释里会写「不用 :has()」这类话：先去掉注释再查。
  const css = readFileSync(
    join(import.meta.dir, "../src/components/chat/status-capsule.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  test("不用 blur、不用 :has()、不加 !important", () => {
    expect(css).not.toMatch(/backdrop-filter\s*:|filter\s*:\s*blur/);
    expect(css).not.toContain(":has(");
    expect(css).not.toContain("!important");
  });
  test("动画只动 transform 和 opacity", () => {
    const frames = [...css.matchAll(/@keyframes[^{]+\{([\s\S]*?)\n\}/g)].map(
      (m) => m[1]!,
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const body of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const prop of props)
        expect(["transform", "opacity"]).toContain(prop);
    }
    for (const m of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
      const value = m[1]!.trim();
      if (value === "none") continue;
      // 只有一项（不写逗号分隔的多项），属性是 opacity / transform。
      expect(["opacity", "transform"]).toContain(value.split(/\s+/)[0]);
      expect(value.replace(/\([^)]*\)/g, "")).not.toContain(",");
    }
  });
  test("减少动态效果、减少透明度、性能模式都有对应", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(css).toContain('html[data-perf="on"] .rs-capsule');
  });
});
