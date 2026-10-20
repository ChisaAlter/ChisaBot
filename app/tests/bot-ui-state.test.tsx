import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import { botUi, flushUiMemory, resetUiMemory, setBotUi, threadUi } from "@/lib/chat/ui-memory";
import { useBotComputerTab } from "@/lib/chat/use-bot-computer";
import { setPanelRailOpen, showRailFor } from "@/lib/panels/rail-open";
import { turnAnswered } from "@/components/channels/channel-chat";

/**
 * 每个机器人记住「面板 | 计算机」、右栏展开 / 宽度（DESIGN.md §88.2），以及聊天滚动「不往回跳」的接线（§88.1）。
 * 滚动本身在真浏览器里量（tests/bot-state/bot-state.mjs）；这里锁住规则和接线。
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);
beforeEach(() => {
  resetUiMemory();
  window.localStorage.clear();
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
    hook.rerender({ id: "bot_a", w: undefined });
    expect(botUi("bot_a")?.computer).toBe(false);
    hook.rerender({ id: "bot_a", w: undefined });
    expect(hook.result.current[0]).toBe(false);
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
     */
    expect(transcript).toMatch(
      /const freshAnchor = useFreshAnchor\(\s*newestUserMessageId,\s*hydrating,\s*lastSentAt,\s*sendMode,?\s*\)/,
    );
    // §94：连续聊天（上一条 <5 分钟）不带对齐标记
    expect(transcript).toMatch(
      /const fresh =\s*!memo\.continuous &&\s*memo\.id !== null/,
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
});
