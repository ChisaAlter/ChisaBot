import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { compactTurns } from "@/components/channels/chat-transcript";
import { clipToolOutput, OUTPUT_LIMIT, ToolLine } from "@/components/channels/tool-line";
import { WorkRow } from "@/components/chat/work-card";
import { WorkerCardBody, workerProgressText } from "@/components/chat/worker-card";
import { setToolActivityVisible } from "@/lib/chat/tool-activity";
import type { WorkerView } from "@/lib/copilot/workers";
import {
  isWorkCall,
  summarizeDoneWork,
  summarizeWork,
  type WorkCall,
  workCallFailed,
  workCallState,
  workStepLines,
  workTimeline,
} from "@/lib/chat/work-steps";
import { describeWorkerStep } from "../../shared/work-step";
import { settleReactWork } from "./settle-react-work";

/**
 * 审查模块 7（工具步骤显示）：后台任务卡不跟着干活卡收起、进行中不算失败、停止后可以回看、并行调用都显示、
 * 读网页写短路径 + 4xx/5xx 算失败、后台任务卡的读屏、调试模式下的工具输出。
 */

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: "http://localhost:3000/" });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const search = (q: string, done = true, extra: Partial<WorkCall> = {}): WorkCall => ({
  name: "web_search",
  arguments: JSON.stringify({ query: q }),
  done,
  ...extra,
});
const fetchPage = (url: string, done = true, extra: Partial<WorkCall> = {}): WorkCall => ({
  name: "web_fetch",
  arguments: JSON.stringify({ url }),
  done,
  ...extra,
});

type Item = Parameters<typeof compactTurns>[0][number];
const user = (id: string, text: string): Item => ({ kind: "text", id, role: "user", text }) as Item;
const bot = (id: string, text: string): Item => ({ kind: "text", id, role: "assistant", text }) as Item;
const tool = (id: string, name: string, args: Record<string, unknown>, result?: string): Item =>
  ({
    kind: "tool",
    id,
    toolCall: { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ...(result === undefined ? {} : { result }),
  }) as Item;

describe("进行中的步骤（必改 2）", () => {
  test("在跑的一轮里没返回的步骤是「进行中」，不是失败", () => {
    const calls = [search("东京天气"), search("大阪天气", false)];
    expect(workCallState(calls[1]!, true)).toBe("running");
    const lines = workTimeline(calls, [], true);
    expect(lines.map((line) => line.text)).toEqual(["搜索「东京天气」", "正在搜索「大阪天气」"]);
    expect(lines.map((line) => line.state)).toEqual(["done", "running"]);
    expect(lines.some((line) => line.text.includes("失败"))).toBe(false);
    expect(workStepLines(calls, true)).toEqual(["搜索「东京天气」", "正在搜索「大阪天气」"]);
  });
  test("这一轮已经结束（出错 / 断线收尾）、又不是被停掉：没返回的照旧算失败", () => {
    const calls = [search("东京天气"), search("大阪天气", false)];
    expect(workTimeline(calls).at(-1)?.text).toBe("搜索「大阪天气」（失败）");
    expect(summarizeDoneWork(calls)?.failed).toBe(1);
  });
  test("WorkRow：跑着时点开，进行中的那几步不带「（失败）」、标成当前", () => {
    const view = render(
      <WorkRow calls={[search("东京天气"), search("大阪天气", false)]} live turnKey="ts-live-open" />,
    );
    fireEvent.click(view.getByTestId("chat-work-card"));
    const steps = view.getByTestId("chat-work-steps");
    expect(steps.textContent).not.toContain("失败");
    const current = steps.querySelectorAll("li.is-current");
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("正在搜索「大阪天气」");
    expect(current[0]?.getAttribute("data-state")).toBe("running");
  });
});

describe("停止后的步骤（应改 3）", () => {
  test("没返回的步骤标「已停止」，不计进「N 步失败」", () => {
    const calls = [search("东京天气"), search("大阪天气", false, { stopped: true }), search("杭州天气", false, { stopped: true })];
    const done = summarizeDoneWork(calls);
    expect(done?.label).toBe("搜索 1 次 · 2 步已停止");
    expect(done?.failed).toBeUndefined();
    expect(done?.stopped).toBe(2);
    expect(done?.steps).toEqual(["搜索「东京天气」", "搜索「大阪天气」（已停止）", "搜索「杭州天气」（已停止）"]);
  });
  test("别的工具也一样：做了 N 步 · M 步已停止", () => {
    const calls: WorkCall[] = [
      { name: "computer_click", arguments: "{}", done: true },
      { name: "computer_click", arguments: "{}", done: false, stopped: true },
    ];
    expect(summarizeDoneWork(calls)?.label).toBe("做了 2 步 · 1 步已停止");
  });
  test("compactTurns：被停掉的一轮里没结果 / 服务器补了「没有结果」的调用打上 stopped，有结果的照旧", () => {
    const interrupted = '"This call produced no result: the surface was interrupted before it could answer."';
    const items = [
      user("u1", "查五个城市的天气"),
      tool("t1", "web_search", { query: "东京天气" }, '"晴"'),
      tool("t2", "web_search", { query: "大阪天气" }, interrupted),
      tool("t3", "web_search", { query: "杭州天气" }),
    ];
    const compact = compactTurns(items, false, new Set(["u1"]));
    const work = compact.work.get("t1");
    expect(work?.calls.map((call) => [call.done, Boolean(call.failed), Boolean(call.stopped)])).toEqual([
      [true, false, false],
      [false, false, true],
      [false, false, true],
    ]);
    // 不收：那一行留着（收起的），点开看做过哪些步。
    expect(work?.quiet).toBe(false);
    // 没被停掉的一轮：没结果的还是失败。
    const plain = compactTurns(items, false, new Set()).work.get("t1");
    expect(plain?.calls.some((call) => call.stopped)).toBe(false);
  });
  test("WorkRow：停止后的一行默认收起，点开看得到「已停止」的步骤，不写「步失败」", () => {
    const view = render(
      <WorkRow
        calls={[search("东京天气"), search("大阪天气", false, { stopped: true })]}
        live={false}
        turnKey="ts-stopped"
      />,
    );
    const row = view.getByTestId("chat-work-done");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByTestId("chat-work-steps")).toBeNull();
    expect(row.textContent).toContain("1 步已停止");
    expect(row.textContent).not.toContain("步失败");
    fireEvent.click(row);
    const steps = view.getByTestId("chat-work-steps");
    expect(steps.textContent).toContain("搜索「大阪天气」（已停止）");
    expect(steps.querySelector('[data-state="stopped"]')).not.toBeNull();
  });
});

describe("后台任务卡不被折叠（必改 1）", () => {
  test("delegate_task 不算干活：不当干活卡的锚点，也不进步骤", () => {
    expect(isWorkCall("delegate_task")).toBe(false);
    expect(summarizeDoneWork([{ name: "delegate_task", arguments: "{}", done: true }])).toBeNull();
  });
  test("交给后台后这一轮写完：锚点是后面的干活调用，后台任务那一行不在收起的行里", () => {
    const items = [
      user("u1", "把搜索 X 交给后台任务"),
      tool("d1", "delegate_task", { title: "搜索 X" }, JSON.stringify(JSON.stringify({ workerId: "w1" }))),
      tool("s1", "web_search", { query: "X" }, '"ok"'),
      bot("a1", "已交给后台任务，做完会在这里告诉你。"),
    ];
    for (const live of [true, false]) {
      const compact = compactTurns(items, live, new Set());
      expect(compact.work.has("d1")).toBe(false);
      expect(compact.hidden.has("d1")).toBe(false);
      expect(compact.work.has("s1")).toBe(true);
    }
    // 它也不算一步。
    const calls = compactTurns(items, false, new Set()).work.get("s1")?.calls ?? [];
    expect(summarizeDoneWork(calls)?.label).toBe("搜索 1 次");
    // 只有 delegate_task：这一轮根本没有干活卡，没有东西可收（刷新后也一样：靠的是消息本身）。
    const only = compactTurns([items[0]!, items[1]!, items[3]!], false, new Set());
    expect(only.work.size).toBe(0);
    expect(only.hidden.has("d1")).toBe(false);
  });
});

describe("并行调用（应改 4）", () => {
  test("同时在跑的几个搜索：「正在搜索 N 项」", () => {
    expect(summarizeWork([search("东京天气", false), search("大阪天气", false)])?.current).toBe("正在搜索 2 项");
    expect(
      summarizeWork([search("a"), search("b", false), search("c", false), search("d", false)])?.current,
    ).toBe("正在搜索 3 项");
  });
  test("同时读几个网页 / 不同的工具", () => {
    expect(summarizeWork([fetchPage("https://a.cn/x", false), fetchPage("https://b.cn/y", false)])?.current).toBe(
      "正在读取 2 个网页",
    );
    expect(summarizeWork([search("a", false), fetchPage("https://b.cn/y", false)])?.current).toBe("正在同时做 2 件事");
  });
  test("只有一个在跑：照旧写那一个", () => {
    expect(summarizeWork([search("东京天气"), search("大阪天气", false)])?.current).toBe("正在搜索「大阪天气」");
  });
  test("WorkRow：那一行写「正在搜索 2 项」，点开每一项都在、都是进行中", () => {
    const view = render(
      <WorkRow calls={[search("东京天气", false), search("大阪天气", false)]} live turnKey="ts-parallel" />,
    );
    const card = view.getByTestId("chat-work-card");
    expect(card.textContent).toContain("正在搜索 2 项");
    fireEvent.click(card);
    const items = [...view.getByTestId("chat-work-steps").querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["正在搜索「东京天气」", "正在搜索「大阪天气」"]);
  });
});

describe("读网页（应改 5）", () => {
  test("写主机名 + 短路径；同一个站的两个网址分得开", () => {
    expect(describeWorkerStep("web_fetch", { url: "https://httpbin.org/status/500" })).toBe("正在读取 httpbin.org/status/500");
    expect(describeWorkerStep("web_fetch", { url: "https://httpbin.org/delay/10?x=1#a" })).toBe("正在读取 httpbin.org/delay/10");
    expect(describeWorkerStep("web_fetch", { url: "https://www.example.com/" })).toBe("正在读取 example.com");
    expect(
      describeWorkerStep("web_fetch", { url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/500" }),
    ).toBe("正在读取 developer.mozilla.org/…/500");
    // 打开网页（电脑）还是只写主机名。
    expect(describeWorkerStep("computer_navigate", { url: "https://httpbin.org/status/500" })).toBe("正在打开 httpbin.org");
  });
  test("HTTP 4xx / 5xx 算失败，2xx / 3xx 不算", () => {
    expect(workCallFailed("网址：https://httpbin.org/status/500\n状态：500\n标题：")).toBe(true);
    expect(workCallFailed(JSON.stringify("网址：https://a.cn/x\n状态：404\n标题："))).toBe(true);
    expect(workCallFailed("状态：403\n内容：…")).toBe(true);
    expect(workCallFailed("网址：https://a.cn/x\n状态：200\n标题：A")).toBe(false);
    expect(workCallFailed("网址：https://a.cn/x\n状态：301\n标题：A")).toBe(false);
    // 正文里提到「状态：500」的不算。
    expect(workCallFailed("网址：https://a.cn/x\n状态：200\n正文：状态：500")).toBe(false);
  });
});

const worker = (extra: Partial<WorkerView> = {}): WorkerView => ({
  id: "w1",
  title: "搜索 X",
  status: "running",
  step: "正在搜索「X」",
  plan: [
    { text: "搜索", status: "done" },
    { text: "整理", status: "current" },
    { text: "汇总", status: "pending" },
  ],
  summary: null,
  error: null,
  resultMessageId: null,
  createdAt: new Date(Date.now() - 5_000).toISOString(),
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  finishedAt: null,
  ...extra,
});
const wrap = (node: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {node}
  </QueryClientProvider>
);

describe("WorkerCard 读屏（应改 6）", () => {
  test("在跑、展开：进度在一个一直挂着的 role=status 里；清单收起后 inert", () => {
    const view = render(wrap(<WorkerCardBody compact={false} threadId="th1" worker={worker()} />));
    const status = view.getByTestId("worker-progress");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("后台任务「搜索 X」正在搜索「X」，步骤 1/3");
    const toggle = view.getByRole("button", { name: /步骤 1\/3/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const plan = view.container.querySelector(".worker-plan-collapse")!;
    expect(plan.hasAttribute("inert")).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(plan.hasAttribute("inert")).toBe(true);
    expect(plan.getAttribute("aria-hidden")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(plan.id);
  });
  test("几个一起跑（收成一行）：两个按钮都是 aria-expanded=false；点开后收起按钮是 true；播报节点不换", () => {
    const view = render(wrap(<WorkerCardBody compact threadId="th1" worker={worker()} />));
    const status = view.getByTestId("worker-progress");
    const buttons = view.container.querySelectorAll(".worker-line, .worker-more");
    expect([...buttons].map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    fireEvent.click(buttons[1]!);
    expect(view.getByRole("button", { name: "收起" }).getAttribute("aria-expanded")).toBe("true");
    expect(view.getByTestId("worker-progress")).toBe(status);
  });
  test("做完收成一行：没有结果消息时那一行是展开（aria-expanded=false），有时是跳到结果（不带）", () => {
    const done = worker({ status: "done", summary: "找到了", finishedAt: new Date().toISOString() });
    const view = render(wrap(<WorkerCardBody compact={false} threadId="th1" worker={done} />));
    expect(view.container.querySelector(".worker-line")?.getAttribute("aria-expanded")).toBe("false");
    expect(view.getByRole("button", { name: "展开详情" }).getAttribute("aria-expanded")).toBe("false");
    expect(view.getByTestId("worker-progress").textContent).toContain("搜索 X");
    cleanup();
    const jump = render(wrap(<WorkerCardBody compact={false} threadId="th1" worker={{ ...done, resultMessageId: "m9" }} />));
    expect(jump.container.querySelector(".worker-line")?.hasAttribute("aria-expanded")).toBe(false);
  });
  test("播报的字：没有清单时不写「步骤」", () => {
    expect(workerProgressText(worker({ plan: [] }))).toBe("后台任务「搜索 X」正在搜索「X」");
  });
});

describe("ToolLine 调试输出（可选）", () => {
  const show = () => setToolActivityVisible(true);
  afterEach(() => setToolActivityVisible(false));
  test("截断：超过上限只留前面，并写明还剩多少", () => {
    const long = "a".repeat(OUTPUT_LIMIT + 123);
    expect(clipToolOutput(long)).toEqual({ text: "a".repeat(OUTPUT_LIMIT), hidden: 123 });
    expect(clipToolOutput("短")).toEqual({ text: "短", hidden: 0 });
  });
  test("纯文本画、点开才画；`#` 不排成标题", () => {
    show();
    const view = render(<ToolLine label="读取了网页" output={`# 标题\n| a |\n${"x".repeat(OUTPUT_LIMIT)}`} />);
    expect(view.queryByTestId("tool-output")).toBeNull();
    const details = view.container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    const output = view.getByTestId("tool-output");
    expect(output.tagName).toBe("PRE");
    expect(output.textContent?.startsWith("# 标题\n| a |")).toBe(true);
    expect(view.container.querySelector("h1")).toBeNull();
    expect(view.container.textContent).toContain("还有");
  });
});
