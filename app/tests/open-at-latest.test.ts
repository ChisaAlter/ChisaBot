import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 打开对话落在最新一条、不跳（DESIGN.md §83）。滚动本身由 tests/open-scroll/open-scroll.mjs 在真浏览器里量
 * （happy-dom 没有布局）；这里锁住接线，免得以后改组件时悄悄断掉：
 * - 恢复完成前不画接入回放一段段长出来的样子（先画缓存 / 存储读到的，没有就是骨架）；
 * - 恢复期间和之后一小段时间由 SettleAtEnd 钉在底部，平滑滚动只给「刚发的」；
 * - 打开时读存储和接入同时开始，读到了就不再为「最后一句是机器人说的」再读一遍。
 */
const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");

describe("打开对话落在最新一条", () => {
  const chat = src("components/channels/channel-chat.tsx");
  const transcript = src("components/channels/chat-transcript.tsx");

  test("恢复中画缓存 / 先读到的存储，不画回放的半截", () => {
    // 这一句现在跨了三行（恢复中 → 早读到的 / 缓存 / 空，否则 agent.messages），所以按空白匹配而不是整行字面量。
    expect(chat).toMatch(
      /restoring\s*\?\s*\(early \?\? cached \?\? EMPTY_MESSAGES\)\s*:\s*agent\.messages/,
    );
    expect(chat).toContain("hydrating={restoring}");
  });

  test("读存储和接入同时开始，只读一次", () => {
    // 早读同样跨行（`earlyRead.current =` 换行后才是三元），用带空白的三元找它的位置。
    const mount = chat.search(
      /earlyRead\.current\s*=\s*seed === null\s*\?\s*readThreadMessages\(/,
    );
    const join = chat.indexOf("await joinWithin({");
    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(join);
    expect(chat).toMatch(
      /!\(\s*mountReadOk\.current &&\s*saysActivity\(agentRef\.current\.messages, initialActivity\.text\)\s*\)/,
    );
  });

  test("SettleAtEnd 在滚动容器里，平滑滚动跳过恢复期", () => {
    // 属性各占一行：`<SettleAtEnd` 之后不远就是 `hydrating={hydrating}`。
    expect(transcript).toMatch(
      /<SettleAtEnd[\s\S]{0,400}?hydrating=\{hydrating\}/,
    );
    /*
     * 第三个数是 `opening` 而不是 `hydrating`（2026-10-22）：恢复完成那一刻 `hydrating` 和恢复好的消息在同一次
     * 提交里一起变，只看它会漏掉那一次——历史里的最新一条被当成「刚发的」，平滑滚一下、翻页、垫空白。
     */
    expect(transcript).toContain(
      "const opening = useOpeningWindow(hydrating);",
    );
    expect(transcript).toContain(
      "useSmoothSendScroll(viewportRef, newestUserMessageId, opening)",
    );
    // 钉底部用滚动容器自己的 scrollToEnd（同时把它切回「跟着底部」），不是直接改 scrollTop。
    const settle = transcript.slice(transcript.indexOf("function SettleAtEnd"), transcript.indexOf("const FIRST_PAINT_STAGGER_COUNT"));
    expect(settle).toContain('scrollToEnd({ behavior: "auto" })');
    expect(settle).toContain("requestAnimationFrame");
    for (const event of ['"wheel"', '"touchmove"', '"keydown"']) expect(settle).toContain(event);
    // 高度变化（图片撑高）在 ResizeObserver 回调里当场回到底部，不等下一帧。
    expect(settle).toContain("new ResizeObserver(pinNow)");
  });

  test("离开对话时记下样子、切回来先画它；左栏的行当对话详情先用", () => {
    expect(chat).toContain("rememberTranscript(threadId, agentRef.current.messages)");
    expect(chat).toContain("cachedTranscript(channel.threadId)");
    expect(src("components/channels/channel-page.tsx")).toContain("placeholderData: () => channelFromRoster(queryClient, channelId)");
  });
});
