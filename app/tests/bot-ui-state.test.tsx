import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import { openToolCallPending, turnAnswered } from "@/components/channels/channel-chat";
import { botUi, flushUiMemory, resetUiMemory, setBotUi, threadUi } from "@/lib/chat/ui-memory";
import { useBotComputerTab } from "@/lib/chat/use-bot-computer";
import { installOverlayBack, noteUserIntent } from "@/lib/overlay-back";
import { setPanelRailOpen, showRailFor } from "@/lib/panels/rail-open";
import { settleReactWork } from "./settle-react-work";

/**
 * 每个机器人记住「面板 | 计算机」、右栏展开 / 宽度（DESIGN.md §88.2），以及聊天滚动「不往回跳」的接线（§88.1）。
 * 滚动本身在真浏览器里量（tests/bot-state/bot-state.mjs）；这里锁住规则和接线。
 */
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // `useBotComputerTab` 靠 popstate / 用户操作的先后区分「后退关计算机」和「别的导航丢了参数」。
  installOverlayBack();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);
beforeEach(() => {
  resetUiMemory();
  window.localStorage.clear();
  // 每条用例从「最后一次是用户操作」开始；要后退的那条自己再派 popstate。
  noteUserIntent();
});

type Write = { open: boolean; replace: boolean };

function mount(agentId: string | undefined, watch: boolean | undefined) {
  const writes: Write[] = [];
  const hook = renderHook(
    ({ id, w }: { id: string | undefined; w: boolean | undefined }) =>
      useBotComputerTab(id, w, (open, replace) => writes.push({ open, replace })),
    { initialProps: { id: agentId, w: watch } },
  );
  return { hook, writes };
}

describe("右栏「计算机」按机器人记住", () => {
  test("地址里没有 watch：用这个机器人上次的选择，第一帧就是开着的，并把地址补上（replace）", () => {
    setBotUi("bot_a", { computer: true });
    const { hook, writes } = mount("bot_a", undefined);
    expect(hook.result.current[0]).toBe(true);
    expect(writes).toEqual([{ open: true, replace: true }]);
  });

  test("别的机器人没记过：还是「面板」，不改地址", () => {
    setBotUi("bot_a", { computer: true });
    const { hook, writes } = mount("bot_b", undefined);
    expect(hook.result.current[0]).toBe(false);
    expect(writes).toEqual([]);
  });

  test("打开 / 关上都记下来；离开再回来（重新挂载、地址没有参数）照旧", () => {
    const first = mount("bot_a", undefined);
    act(() => first.hook.result.current[1](true));
    expect(first.writes.at(-1)).toEqual({ open: true, replace: false });
    expect(botUi("bot_a")?.computer).toBe(true);
    first.hook.unmount();
    // 刷新也在
    flushUiMemory();
    resetUiMemory();
    const again = mount("bot_a", undefined);
    expect(again.hook.result.current[0]).toBe(true);
    act(() => again.hook.result.current[1](false));
    expect(botUi("bot_a")?.computer).toBe(false);
    again.hook.unmount();
    expect(mount("bot_a", undefined).hook.result.current[0]).toBe(false);
  });

  test("地址说开着：以地址为准，并记下来", () => {
    const { hook } = mount("bot_a", true);
    expect(hook.result.current[0]).toBe(true);
    expect(botUi("bot_a")?.computer).toBe(true);
  });

  test("浏览器后退把 watch 去掉 = 关上（后退仍然能关）", () => {
    const { hook } = mount("bot_a", true);
    window.dispatchEvent(new Event("popstate"));
    hook.rerender({ id: "bot_a", w: undefined });
    expect(botUi("bot_a")?.computer).toBe(false);
    hook.rerender({ id: "bot_a", w: undefined });
    expect(hook.result.current[0]).toBe(false);
  });

  test("不是后退的导航把 watch 抹掉（`/` 落地跳回、左栏再点同一行）：不算关上，记忆还在、地址补回来", () => {
    const { hook, writes } = mount("bot_a", true);
    // 同一段对话的另一次导航丢了参数：页面没藏过（epoch 不变）、不是 popstate。
    hook.rerender({ id: "bot_a", w: undefined });
    expect(botUi("bot_a")?.computer).toBe(true);
    expect(hook.result.current[0]).toBe(true);
    expect(writes).toEqual([{ open: true, replace: true }]);
  });

  test("机器人还不知道（对话详情没读到）：不动地址", () => {
    const { hook, writes } = mount(undefined, undefined);
    expect(hook.result.current[0]).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe("右栏展开 / 收起按机器人记住", () => {
  test("换到记过的机器人就照它的来；用户的选择记给当前机器人", () => {
    showRailFor("bot_a");
    setPanelRailOpen(false);
    expect(botUi("bot_a")?.railOpen).toBe(false);
    showRailFor("bot_b");
    setPanelRailOpen(true);
    expect(botUi("bot_b")?.railOpen).toBe(true);
    // 回到 a：收起
    showRailFor("bot_a");
    expect(window.localStorage.getItem("chisabot-panel-rail")).toBe("collapsed");
    setBotUi("bot_a", { railWidth: 455 });
    expect(showRailFor("bot_a")).toBe(455);
    expect(showRailFor("bot_c")).toBeUndefined();
  });
});

const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");

describe("接线", () => {
  const transcript = src("components/channels/chat-transcript.tsx");
  const route = src("components/channels/channel-page.tsx");
  const fresh = src("routes/_authed/_app/channel/new.tsx");

  test("只有刚发出去的那一条带对齐标记（历史里的用户消息不会被拉到顶上）", () => {
    /*
     * 换行和缩进是排版，不是行为：这几条断言用能跨行的正则写，锁的仍然是同一件事 ——
     * 对齐标记由 `useFreshAnchor` 用这四个输入决定，而不是「列表里每个用户消息都带」。
     *
     * 第三个输入是 `opening` 而不是 `hydrating`（2026-10-22）：恢复完成那一刻 `hydrating` 就和恢复好的消息
     * 一起变 false，只看它的话，那一次提交里出现的最新一条用户消息会被当成「刚发的」——切个机器人 / 从设置
     * 回来，整段对话就像发了一次消息（翻到 1/3、底下垫 2/3 屏空白）。
     */
    expect(transcript).toMatch(
      /const freshAnchor = useFreshAnchor\(\s*newestUserMessageId,\s*opening,\s*lastSentAt,\s*sendMode,?\s*\)/,
    );
    expect(transcript).toMatch(/const opening = useOpeningWindow\(hydrating\);/);
    // §94：连续聊天（上一条 <5 分钟）不带对齐标记；还在「打开」窗口里也不带
    expect(transcript).toMatch(
      /const fresh =\s*!opening &&\s*!memo\.continuous &&\s*memo\.id !== null/,
    );
    expect(transcript).toContain("const anchorRows = newestAnchor ? new Set([newestAnchor]) : EMPTY_ANCHORS");
    expect(transcript).not.toMatch(/const anchorRows = anchorRowIds\(items\);/);
  });

  test("底下变矮在同一帧补留白；留白在 contents 那一格里", () => {
    const settle = transcript.slice(transcript.indexOf("function SettleAtEnd"), transcript.indexOf("const FIRST_PAINT_STAGGER_COUNT"));
    expect(settle).toContain("setSlack(s.slack + lost)");
    expect(settle).toContain("element.scrollTop = seen.top");
    expect(transcript).toContain('data-chat-slack=""');
    // 滚动位置：恢复完成后记，回来时回到那一条
    expect(settle).toContain("scrollToMessage(r.anchor");
    expect(settle).toContain("setThreadUi(scrollKey");
  });

  test("对话页 / 空聊天都用按机器人记住的「计算机」", () => {
    // 同上：这次调用被格式化成了多行，参数和顺序才是要锁的东西。
    expect(route).toMatch(
      /useBotComputerTab\(\s*agentId,\s*watch,\s*writeWatch,\s*epoch,?\s*\)/,
    );
    expect(fresh).toContain("useBotComputerTab(");
    expect(src("components/channels/channel-chat.tsx")).toContain("draftKey={channel.id}");
    expect(src("components/channels/conversation-view.tsx")).toContain("{...(draftKey ? { draftKey } : {})}");
  });

  test("对话属于哪个机器人记下来（刷新时右栏先画对）", () => {
    expect(route).toContain("threadUi(channelId)?.agent");
    expect(threadUi("nothing")).toBeUndefined();
  });
});

describe("中途断的一轮不把字放回输入框（§88.4）", () => {
  const user = { id: "u1", role: "user", content: "你好?" };
  test("最后一条用户消息之后有回答 / 工具调用 = 已经接着做了事", () => {
    expect(turnAnswered([user] as never)).toBe(false);
    expect(turnAnswered([user, { id: "a1", role: "assistant", content: "我先确认一下" }] as never)).toBe(true);
    expect(turnAnswered([user, { id: "t1", role: "tool", content: "ok", toolCallId: "c" }] as never)).toBe(true);
    expect(turnAnswered([{ id: "a0", role: "assistant", content: "上一轮" }, user] as never)).toBe(false);
  });
  test("接线：只有什么都没回来的失败才抛（放回字）；重试先问 onRetryTurn", () => {
    const chat = src("components/channels/channel-chat.tsx");
    expect(chat).toContain("if (!turnAnswered(target.messages)) throw new Error(turnFailure.current);");
    expect(chat).toContain("onRetryTurn={() => {");
    expect(src("components/channels/conversation-view.tsx")).toContain("if (onRetryTurn?.()) return;");
  });

  test("接线：回复看门狗超时（reply_hang）不直接抛——已落库的一轮交给统一出口判定", () => {
    const chat = src("components/channels/channel-chat.tsx");
    /*
     * 消息没落库（hang）照旧直接抛：屏幕上什么都没有，回填草稿重发是唯一补救。
     * 已落库（reply_hang）只记 turnFailure——曾经在这里 throw new Error(second.reason)，
     * 绕过了下面 turnAnswered 判定：屏上气泡一份、输入框又塞回一份，重试时同一句话发两遍。
     */
    expect(chat).toContain("throw new Error(first.reason)");
    expect(chat).toContain("failRef.current(second.reason)");
    expect(chat).not.toContain("throw new Error(second.reason)");
    // 刚被停掉的 run 也不能 await：HERMES_RUN_CANCELLED 抛到 composer 殊途同归，照样回填。
    const after = chat.slice(chat.indexOf('second.kind === "reply_hang"'));
    const branch = after.slice(0, after.indexOf("persistFailedFrontendResults"));
    expect(branch).toMatch(/\}\s*else\s*\{\s*await runPromise;\s*\}/);
  });
});

describe("在飞的服务端工具调用替整轮作证（看门狗不误杀长命令）", () => {
  const call = (id: string) => ({ id, function: { name: "device_run_shell", arguments: "{}" } });
  const assistant = (id: string, calls: ReturnType<typeof call>[]) => ({ id, role: "assistant", toolCalls: calls });
  const result = (id: string, toolCallId: string) => ({ id, role: "tool", toolCallId, content: "ok" });
  const user = { id: "u1", role: "user", content: "在吗" };

  test("发起了、结果还没回来 = 在飞", () => {
    // 单调用在飞；并行调用只回了一个也算在飞
    expect(openToolCallPending([user, assistant("a1", [call("c1")])] as never)).toBe(true);
    expect(
      openToolCallPending([user, assistant("a1", [call("c1"), call("c2")]), result("t1", "c1")] as never),
    ).toBe(true);
    // 回齐了 / 纯文本回复 / 用户消息收尾 = 没有在飞
    expect(openToolCallPending([user, assistant("a1", [call("c1")]), result("t1", "c1")] as never)).toBe(false);
    expect(openToolCallPending([user, assistant("a1", [])] as never)).toBe(false);
    expect(openToolCallPending([assistant("a1", [call("c1")]), result("t1", "c1"), user] as never)).toBe(false);
    // 更老 assistant 上的历史空洞不算本轮在飞：最近一条 assistant 的调用已答就停
    expect(
      openToolCallPending([
        assistant("a0", [call("stale")]),
        user,
        assistant("a1", [call("c1")]),
        result("t1", "c1"),
      ] as never),
    ).toBe(false);
    expect(openToolCallPending([] as never)).toBe(false);
  });

  test("接线：lastProgressAt 把在飞调用折成 run 事件 + 15 分钟额度", () => {
    const chat = src("components/channels/channel-chat.tsx");
    expect(chat).toContain("OPEN_TOOL_CALL_CREDIT_MS = 15 * 60_000");
    expect(chat).toContain("openToolCallPending(agentRef.current?.messages ?? target.messages)");
    expect(chat).toContain("runProgressAt.current + OPEN_TOOL_CALL_CREDIT_MS");
  });
});
