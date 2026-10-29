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
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  ChatTranscript,
  compactTurns,
  toolDrawsCard,
} from "@/components/channels/chat-transcript";
import {
  capsuleSeconds,
  NoAnswerRow,
  PausedCapsule,
  StatusCapsule,
} from "@/components/chat/status-capsule";
import {
  markTurnRunEnded,
  turnStartedAt,
  WorkRow,
} from "@/components/chat/work-card";
import { setWorkUi, workUi } from "@/lib/chat/ui-memory";
import {
  isBlankNote,
  isQuietWork,
  type WorkCall,
  workTimeline,
} from "@/lib/chat/work-steps";
import {
  fileToolDrawsCard,
  imageToolDrawsCard,
} from "@/lib/copilot/chat-file-tools";
import { renderUiDrawsCard } from "@/lib/copilot/render-ui-tool";
import { scheduleDrawsCard } from "@/lib/copilot/schedule-tool";
import {
  lineOnlyRender,
  registeredCardChecks,
} from "@/lib/copilot/tool-renderers";
import { REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { CHAT_FILES_MARKER } from "../../shared/chat-files";
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
  test("只有代码块的一段不算空（以前先去掉代码块再看，整段被当成空段藏起来）", () => {
    for (const text of [
      "```js\nconst a = 1;\n```",
      "```\n---\n```",
      "```\n```",
      "| a |\n|---|\n| 1 |",
      "[链接](https://example.com)",
    ])
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
  test("转圈 + 动作 + 已用秒数；胶囊自己不带 role=status（对话末尾那个一直挂着的读）", () => {
    const { getByTestId } = render(
      <StatusCapsule label="思考中" since={Date.now() - 5_200} />,
    );
    const capsule = getByTestId("status-capsule");
    expect(capsule.getAttribute("data-state")).toBe("live");
    expect(capsule.querySelector(".rs-spinner")).not.toBeNull();
    expect(capsule.querySelector("[role=status]")).toBeNull();
    expect(capsule.querySelector(".rs-capsule-label")?.textContent).toBe(
      "思考中",
    );
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
  test("读屏：按钮名字里有当前动作，不再只是「展开步骤」", () => {
    const { getByTestId } = render(
      <WorkRow calls={[search("东京天气", false)]} live turnKey="rs-label-1" />,
    );
    const label = getByTestId("chat-work-card").getAttribute("aria-label")!;
    expect(label).toContain("东京天气");
    expect(label.endsWith("展开步骤")).toBe(true);
    expect(
      getByTestId("chat-work-card").querySelector("[role=status]"),
    ).toBeNull();
  });
});

describe("PausedCapsule", () => {
  test("停 0.9 秒才出；出来是矮的那一种（和以前停顿的占位等高）；来新字就收", async () => {
    const since = Date.now() - 4_000;
    const { queryByTestId, rerender } = render(
      <PausedCapsule since={since} watch="我先看看" />,
    );
    expect(queryByTestId("transcript-pause-capsule")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 950));
    });
    const capsule = queryByTestId("transcript-pause-capsule")!;
    expect(capsule).not.toBeNull();
    expect(capsule.getAttribute("data-variant")).toBe("pause");
    expect(capsule.textContent).toContain("思考中");
    // 秒数从这一轮开始算，不是从停顿开始。
    expect(capsule.textContent).toContain("4 秒");
    await act(async () => {
      rerender(<PausedCapsule since={since} watch="我先看看，东京" />);
    });
    expect(queryByTestId("transcript-pause-capsule")).toBeNull();
  });
});

describe("秒数切回来不归零", () => {
  test("同一轮的开始时间只记一次：胶囊、干活卡、重挂都用它", () => {
    const first = turnStartedAt("rs-since-1", 1_000);
    expect(first).toBe(1_000);
    // 切到别的频道再回来：组件重挂、再问一次，还是第一次那个时间。
    expect(turnStartedAt("rs-since-1", 9_000)).toBe(1_000);
  });
  test("干活卡卸载再挂上（切频道回来），秒数接着算", () => {
    const key = "rs-since-2";
    const since = turnStartedAt(key, Date.now() - 7_000);
    const first = render(
      <WorkRow
        calls={[search("东京天气", false)]}
        live
        since={since}
        turnKey={key}
      />,
    );
    expect(first.getByTestId("chat-work-card").textContent).toContain("7 秒");
    first.unmount();
    // 回来时上层算出的 since 也是同一个（turnStartedAt），就算没传也按 turnKey 记住的算。
    const again = render(
      <WorkRow calls={[search("东京天气", false)]} live turnKey={key} />,
    );
    expect(again.getByTestId("chat-work-card").textContent).toContain("7 秒");
  });
});

describe("焦点", () => {
  test("键盘点开步骤后这一轮结束、这一行收起（inert）：焦点移到收起后的那一行，不掉到 body", async () => {
    const key = "rs-focus-1";
    const Row = ({ live, folded }: { live: boolean; folded: boolean }) => (
      <div>
        <div
          data-message-id="t1"
          {...(folded ? { inert: true, "aria-hidden": true } : {})}
        >
          <WorkRow
            calls={[search("东京天气", live ? false : true)]}
            live={live}
            turnKey={key}
          />
        </div>
        <div data-message-id="a1">{"东京今天晴。"}</div>
      </div>
    );
    const { getByTestId, rerender, container } = render(
      <Row folded={false} live />,
    );
    const button = getByTestId("chat-work-card");
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    await act(async () => {
      rerender(<Row folded live={false} />);
    });
    const answer = container.querySelector('[data-message-id="a1"]');
    expect(document.activeElement).toBe(answer);
    expect(answer?.getAttribute("tabindex")).toBe("-1");
  });
  test("这一行没收起（没有回答，留着）：焦点留在按钮上", async () => {
    const key = "rs-focus-2";
    const { getByTestId, rerender } = render(
      <div data-message-id="t1">
        <WorkRow calls={[search("东京天气", false)]} live turnKey={key} />
      </div>,
    );
    getByTestId("chat-work-card").focus();
    await act(async () => {
      rerender(
        <div data-message-id="t1">
          <WorkRow
            calls={[{ ...search("东京天气"), failed: true }]}
            live={false}
            turnKey={key}
          />
        </div>,
      );
    });
    expect(document.activeElement).toBe(getByTestId("chat-work-done"));
  });
});

describe("没有看得见的回答", () => {
  type Item = Parameters<typeof compactTurns>[0][number];
  const user = (id: string, text: string): Item =>
    ({ kind: "text", id, role: "user", text }) as Item;
  const bot = (id: string, text: string): Item =>
    ({ kind: "text", id, role: "assistant", text }) as Item;
  const tool = (id: string, result: string): Item =>
    ({
      kind: "tool",
      id,
      toolCall: {
        id,
        type: "function",
        function: {
          name: "web_search",
          arguments: JSON.stringify({ query: "东京天气" }),
        },
      },
      result,
    }) as Item;
  const FAIL = JSON.stringify(JSON.stringify({ error: "搜索服务不可用" }));

  test("只有代码块的回复：跑着、做完都照常画（不当成空段藏起来）", () => {
    const code = "```ts\nconst a = 1;\n```";
    const items = [user("u1", "写一行代码"), bot("a1", code)];
    for (const live of [true, false]) {
      const compact = compactTurns(items, live, new Set());
      expect(compact.hidden.has("a1")).toBe(false);
    }
    const done = compactTurns(items, false, new Set());
    expect(done.tone.get("a1")).toBe("final");
    expect(done.noAnswerAfter.size).toBe(0);
  });

  test("工具失败、后面没有文字：干活那一行不收，后面挂「这一轮没有回答」（最后一轮带重试）", () => {
    const items = [
      user("u1", "查东京天气"),
      bot("a0", "我查一下。"),
      tool("t1", FAIL),
    ];
    const compact = compactTurns(items, false, new Set());
    const work = compact.work.get("t1")!;
    expect(work.answered).toBe(false);
    expect(work.quiet).toBe(false);
    expect(compact.noAnswerAfter.get("t1")).toEqual({ last: true });
    // ChatTranscript 渲染时再判一遍的也一样不收。
    expect(
      isQuietWork({
        calls: work.calls,
        live: false,
        hasFinal: work.answered,
        stopped: work.stopped,
      }),
    ).toBe(false);
    // 还在跑时不挂。
    expect(compactTurns(items, true, new Set()).noAnswerAfter.size).toBe(0);
    // 后面又有一轮：这一轮的提示不带重试。
    const more = compactTurns(
      [...items, user("u2", "算了"), bot("a2", "好的。")],
      false,
      new Set(),
    );
    expect(more.noAnswerAfter.get("t1")).toEqual({ last: false });
  });

  test("干活那一行写「N 步失败」", () => {
    const { getByTestId } = render(
      <WorkRow
        calls={[{ ...search("东京天气"), failed: true }]}
        live={false}
        turnKey="rs-fail-1"
      />,
    );
    const row = getByTestId("chat-work-done");
    expect(row.textContent).toContain("1 步失败");
    expect(row.getAttribute("aria-label")).toContain("1 步失败");
  });

  test("只回了「---」：同样挂「这一轮没有回答」", () => {
    const compact = compactTurns(
      [user("u1", "你好"), bot("a1", "---")],
      false,
      new Set(),
    );
    expect(compact.hidden.has("a1")).toBe(true);
    expect(compact.noAnswerAfter.get("u1")).toEqual({ last: true });
  });

  test("有回答、被停掉的一轮不挂", () => {
    const answered = compactTurns(
      [
        user("u1", "查"),
        tool("t1", FAIL),
        bot("a1", "搜索出错了，换个说法再试试？"),
      ],
      false,
      new Set(),
    );
    expect(answered.noAnswerAfter.size).toBe(0);
    expect(answered.work.get("t1")?.quiet).toBe(true);
    const stopped = compactTurns(
      [user("u1", "查"), tool("t1", FAIL)],
      false,
      new Set(["u1"]),
    );
    expect(stopped.noAnswerAfter.size).toBe(0);
  });

  test("NoAnswerRow：一句话 + 重试（点了走现有的重发入口）", () => {
    let retried = 0;
    const { getByTestId, getByRole } = render(
      <NoAnswerRow onRetry={() => (retried += 1)} />,
    );
    expect(getByTestId("turn-no-answer").textContent).toContain(
      "这一轮没有回答",
    );
    fireEvent.click(getByRole("button", { name: "重试" }));
    expect(retried).toBe(1);
  });
  test("NoAnswerRow：没有重试入口时不画按钮", () => {
    const { queryByRole } = render(<NoAnswerRow />);
    expect(queryByRole("button")).toBeNull();
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
  test("不透明底色用 token，不写死颜色（深色也是）", () => {
    for (const m of css.matchAll(/--rs-solid\s*:\s*([^;]+);/g))
      expect(m[1]!.trim().startsWith("var(--")).toBe(true);
    expect(css).not.toMatch(/\.dark\s+\.rs-capsule/);
  });
  test("从「思考中」胶囊换成干活卡不再播一次进场", () => {
    const rule =
      /\.chat-work-card\.rs-capsule\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/animation\s*:\s*none/);
  });
  test("停顿的胶囊和以前停顿的占位等高（上下各 1px + 20px 行高 = 22px）", () => {
    const rule =
      /\.rs-capsule\[data-variant="pause"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("padding-top: 1px");
    expect(rule).toContain("padding-bottom: 1px");
    expect(css).toMatch(/\.rs-capsule\s*\{[^}]*line-height:\s*20px/);
  });
});

describe("以卡片收尾的一轮算有回答（复审 #404 第 1 条）", () => {
  type Item = Parameters<typeof compactTurns>[0][number];
  const user = (id: string, text: string): Item =>
    ({ kind: "text", id, role: "user", text }) as Item;
  const tool = (
    id: string,
    name: string,
    result?: string,
    args = "{}",
  ): Item =>
    ({
      kind: "tool",
      id,
      toolCall: {
        id,
        type: "function",
        function: { name, arguments: args },
      },
      ...(result === undefined ? {} : { result }),
    }) as Item;
  // 渲染器本身随便画什么；画没画出卡片由渲染器模块登记的判断说了算（registeredCardChecks，和渲染器返回 null 同一个函数）。
  const card = () => "card";
  const renderers = [
    { name: "image_generate", render: card },
    { name: "image_edit", render: card },
    { name: "file_share", render: card },
    { name: "schedule_create", render: card },
    { name: "render_ui", render: card },
    { name: "ask_person", render: card },
    { name: "computer_click", render: lineOnlyRender(() => null) },
  ];
  const drawsCard =
    (asked: ReadonlySet<string> = new Set()) =>
    (item: Parameters<typeof toolDrawsCard>[0]) =>
      toolDrawsCard(item, {
        renderers,
        activities: [{ activityType: "open-generative-ui" }],
        asked,
      });
  const OK = JSON.stringify(JSON.stringify({ ok: true }));
  const FAIL = JSON.stringify(JSON.stringify({ error: "失败" }));
  const fileView = (name: string, mimeType: string) => ({
    id: `f-${name}`,
    url: `/api/chat-files/f-${name}`,
    name,
    mimeType,
    size: 10,
    kind: "generated",
  });
  const withFiles = (...files: ReturnType<typeof fileView>[]) =>
    `完成\n${CHAT_FILES_MARKER}${JSON.stringify(files)}`;
  const IMAGE = withFiles(fileView("a.png", "image/png"));
  const PDF = withFiles(fileView("a.pdf", "application/pdf"));
  const SCHEDULED = JSON.stringify({
    ok: true,
    schedule: {
      id: "s1",
      title: "喝水",
      schedule: "每天 9:00",
      kind: "cron",
      nextRunText: "明天 9:00",
    },
  });
  const REJECTED = JSON.stringify({ ok: false, error: "时间已经过了" });
  const uiArgs = (spec: unknown) =>
    JSON.stringify({
      title: "界面",
      spec: typeof spec === "string" ? spec : JSON.stringify(spec),
    });
  const BUTTON_UI = uiArgs({
    root: "b",
    elements: {
      b: {
        type: "Button",
        props: { label: "Word", ask: "用 Word" },
        children: [],
      },
    },
  });
  const NO_ROOT_UI = uiArgs({
    root: "missing",
    elements: {
      b: {
        type: "Button",
        props: { label: "Word", ask: "用 Word" },
        children: [],
      },
    },
  });
  const ending = (name: string, result: string, args?: string) =>
    compactTurns(
      [user("u1", "来一个"), tool("t1", name, result, args)],
      false,
      new Set(),
      undefined,
      drawsCard(),
    );

  test("画卡片的渲染器都登记了自己的判断，toolDrawsCard 默认用这一份", () => {
    expect(registeredCardChecks.get("image_generate")).toBe(imageToolDrawsCard);
    expect(registeredCardChecks.get("image_edit")).toBe(imageToolDrawsCard);
    expect(registeredCardChecks.get("file_share")).toBe(fileToolDrawsCard);
    expect(registeredCardChecks.get("schedule_create")).toBe(
      scheduleDrawsCard,
    );
    expect(registeredCardChecks.get("render_ui")).toBe(renderUiDrawsCard);
  });

  const answered: [string, string, string?][] = [
    ["image_generate", IMAGE],
    ["image_edit", IMAGE],
    ["file_share", PDF],
    ["schedule_create", SCHEDULED],
    ["render_ui", OK, BUTTON_UI],
    ["ask_person", OK],
  ];
  for (const [name, result, args] of answered) {
    test(`以 ${name} 的卡片收尾、后面没有字：不挂「这一轮没有回答」和重试`, () => {
      const compact = ending(name, result, args);
      expect(compact.noAnswerAfter.size).toBe(0);
      const work = compact.work.get("t1");
      if (work) expect(work.answered).toBe(true);
    });
  }

  // 这些情况渲染器返回 null（或只画一行「格式有误」）：屏幕上没有卡片，这一轮算没有回答，要能重试（复审 #404 第三轮）。
  const unanswered: [string, string, string, string?][] = [
    ["image_generate 报错", "image_generate", FAIL],
    ["image_generate 没给图片（只有 PDF）", "image_generate", PDF],
    ["image_edit 没给文件", "image_edit", "改好了"],
    ["file_share 报错", "file_share", FAIL],
    ["file_share 没给文件", "file_share", OK],
    ["schedule_create 被拒绝", "schedule_create", REJECTED],
    ["schedule_create 报错", "schedule_create", FAIL],
    ["render_ui 规范没有根节点", "render_ui", OK, NO_ROOT_UI],
    ["render_ui 规范不是合法 JSON", "render_ui", OK, uiArgs("{不是 JSON")],
    ["render_ui 没给规范", "render_ui", OK, "{}"],
    ["render_ui 被拒绝", "render_ui", `${REFUSAL_MARKER} 不行`, BUTTON_UI],
  ];
  for (const [label, name, result, args] of unanswered) {
    test(`${label}：渲染器什么都不画，仍然挂「这一轮没有回答」`, () => {
      const compact = ending(name, result, args);
      expect(compact.noAnswerAfter.get("t1")).toEqual({ last: true });
      // 图片 / 文件 / 界面不进干活卡；进了的（schedule_create）也要标成没有回答。
      const work = compact.work.get("t1");
      if (work) expect(work.answered).toBe(false);
    });
  }

  test("工具还没有结果时渲染器画的是骨架：照旧算卡片", () => {
    const items = [user("u1", "来一张"), tool("t1", "image_generate")];
    expect(
      compactTurns(items, false, new Set(), undefined, drawsCard())
        .noAnswerAfter.size,
    ).toBe(0);
  });

  test("渲染器的判断和它自己画不画是同一个条件", () => {
    expect(imageToolDrawsCard({ args: "{}", result: IMAGE })).toBe(true);
    expect(imageToolDrawsCard({ args: "{}", result: PDF })).toBe(false);
    expect(fileToolDrawsCard({ args: "{}", result: PDF })).toBe(true);
    expect(fileToolDrawsCard({ args: "{}", result: FAIL })).toBe(false);
    // schedule-tool 的结果有时被再包一层 JSON 字符串。
    expect(
      scheduleDrawsCard({ args: "{}", result: JSON.stringify(SCHEDULED) }),
    ).toBe(true);
    expect(scheduleDrawsCard({ args: "{}", result: REJECTED })).toBe(false);
    expect(renderUiDrawsCard({ args: BUTTON_UI, result: OK })).toBe(true);
    expect(renderUiDrawsCard({ args: NO_ROOT_UI, result: OK })).toBe(false);
  });

  test("等确认的工具（确认卡挂着、还没有结果）算有回答", () => {
    const items = [user("u1", "建个 issue"), tool("t1", "github_create_issue")];
    expect(
      compactTurns(items, false, new Set(), undefined, drawsCard())
        .noAnswerAfter.size,
    ).toBe(1);
    const asked = compactTurns(
      items,
      false,
      new Set(),
      undefined,
      drawsCard(new Set(["t1"])),
    );
    expect(asked.noAnswerAfter.size).toBe(0);
    expect(asked.work.get("t1")?.answered).toBe(true);
  });

  test("宿主被拒的提示（没有渲染器时 ServerToolLine 画的那句）算有回答", () => {
    const items = [
      user("u1", "读一下桌面上的文件"),
      tool("t1", "host_read_file", `${REFUSAL_MARKER} 电脑没连上`),
    ];
    expect(
      compactTurns(items, false, new Set(), undefined, drawsCard())
        .noAnswerAfter.size,
    ).toBe(0);
  });

  test("活动卡（有渲染器的活动消息）算有回答", () => {
    const items = [
      user("u1", "画个界面"),
      {
        kind: "activity",
        id: "act1",
        message: {
          id: "act1",
          role: "activity",
          activityType: "open-generative-ui",
          content: {},
        },
      } as Item,
    ];
    expect(
      compactTurns(items, false, new Set(), undefined, drawsCard())
        .noAnswerAfter.size,
    ).toBe(0);
  });

  test("只画一行过程的渲染器、没有渲染器的普通工具失败：仍然挂「这一轮没有回答」", () => {
    for (const name of ["computer_click", "web_search"]) {
      const compact = compactTurns(
        [user("u1", "点一下"), tool("t1", name, FAIL)],
        false,
        new Set(),
        undefined,
        drawsCard(),
      );
      expect(compact.noAnswerAfter.get("t1")).toEqual({ last: true });
      expect(compact.work.get("t1")?.answered).toBe(false);
    }
  });
});

describe("末尾已经有错误卡", () => {
  const wrap = (node: ReactNode) => (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>
  );
  test("没有看得见的回答、末尾挂着错误卡（带重试）：不再挂一遍「这一轮没有回答」和重试", () => {
    const messages = [
      { id: "eu1", role: "user", content: "查东京天气" },
      // 只回了「---」（这一段不画）：和工具失败后没有字一样，是「这一轮没有回答」。
      { id: "ea1", role: "assistant", content: "---" },
    ] as Message[];
    const { getAllByRole, getByTestId, queryByTestId } = render(
      wrap(
        <ChatTranscript
          messages={messages}
          onRetry={() => undefined}
          onRetryUnanswered={() => undefined}
          scrollKey="rs-error-card"
          stopped="连接中断"
        />,
      ),
    );
    expect(getByTestId("transcript-stopped")).not.toBeNull();
    expect(queryByTestId("turn-no-answer")).toBeNull();
    expect(getAllByRole("button", { name: /重试/ })).toHaveLength(1);
    cleanup();
    // 对照：没有错误卡时，这一轮照常挂「这一轮没有回答」和它自己的重试。
    const plain = render(
      wrap(
        <ChatTranscript
          messages={messages}
          onRetryUnanswered={() => undefined}
          scrollKey="rs-error-card-2"
        />,
      ),
    );
    expect(plain.queryByTestId("transcript-stopped")).toBeNull();
    expect(plain.getByTestId("turn-no-answer")).not.toBeNull();
  });
});

describe("重新开始跑时重新计时（复审 #404 第 3 条）", () => {
  test("上一次跑停了，同一轮再跑：开始时间和用时都从头算", () => {
    const key = "rs-restart-1";
    expect(turnStartedAt(key, 1_000)).toBe(1_000);
    setWorkUi(key, { seconds: 45 });
    markTurnRunEnded(key);
    expect(turnStartedAt(key, 50_000)).toBe(50_000);
    expect(workUi(key)?.seconds).toBeUndefined();
    // 之后同一次跑里再问，还是这次的开始时间。
    expect(turnStartedAt(key, 60_000)).toBe(50_000);
  });

  test("干活卡看着这一轮停下，重试后再跑：不会一出来就是「45 秒」", () => {
    const key = "rs-restart-2";
    const since = turnStartedAt(key, Date.now() - 45_000);
    const view = render(
      <WorkRow
        calls={[search("东京天气", false)]}
        live
        since={since}
        turnKey={key}
      />,
    );
    expect(view.getByTestId("chat-work-card").textContent).toContain("45 秒");
    // 跑完（这一页看着停下）。
    view.rerender(
      <WorkRow
        calls={[{ ...search("东京天气"), failed: true }]}
        live={false}
        turnKey={key}
      />,
    );
    view.unmount();
    // 重试：同一轮又开始跑。
    const again = turnStartedAt(key);
    const retry = render(
      <WorkRow
        calls={[search("东京天气", false)]}
        live
        since={again}
        turnKey={key}
      />,
    );
    const text = retry.getByTestId("chat-work-card").textContent ?? "";
    expect(text).not.toContain("45 秒");
    expect(text).not.toMatch(/\d+ 秒/);
  });

  test("切到别的频道再回来（重挂时还在跑）：不归零", () => {
    const key = "rs-restart-3";
    const since = turnStartedAt(key, Date.now() - 12_000);
    const first = render(
      <WorkRow
        calls={[search("东京天气", false)]}
        live
        since={since}
        turnKey={key}
      />,
    );
    first.unmount();
    const back = render(
      <WorkRow
        calls={[search("东京天气", false)]}
        live
        since={turnStartedAt(key)}
        turnKey={key}
      />,
    );
    expect(back.getByTestId("chat-work-card").textContent).toContain("12 秒");
  });
});

describe("窄屏也看得到「N 步失败」（复审 #404 第 2 条）", () => {
  test("没有回答的那一行带 data-unanswered，有回答的不带", () => {
    const failed = [{ ...search("东京天气"), failed: true }];
    const bare = render(
      <WorkRow calls={failed} live={false} turnKey="rs-narrow-1" />,
    );
    expect(
      bare.getByTestId("chat-work-done").hasAttribute("data-unanswered"),
    ).toBe(false);
    bare.unmount();
    const row = render(
      <WorkRow calls={failed} live={false} turnKey="rs-narrow-2" unanswered />,
    );
    expect(
      row.getByTestId("chat-work-done").hasAttribute("data-unanswered"),
    ).toBe(true);
  });

  test("status-capsule.css 在 ≤560px 用属性选择器重新显示这一格，不用 !important、不改 styles.css", () => {
    const css = readFileSync(
      join(import.meta.dir, "../src/components/chat/status-capsule.css"),
      "utf8",
    );
    expect(css).toMatch(
      /@media \(max-width: 560px\) \{\s*\.chat-work-card\.chat-work-done\[data-unanswered\] \.chat-work-meta \{\s*display: inline;/,
    );
    expect(css).not.toContain("!important");
    const app = readFileSync(
      join(import.meta.dir, "../src/styles.css"),
      "utf8",
    );
    expect(app).toContain(
      "@media (max-width: 560px) { .chat-work-card.chat-work-done .chat-work-meta { display: none; } }",
    );
  });
});
