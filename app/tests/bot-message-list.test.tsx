import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { renderUnvirtualizedMessageList } from "@/lib/copilot/message-list";
import { RICH_MESSAGE_VIEW } from "@/lib/copilot/rich-message-view";

if (typeof document === "undefined") GlobalRegistrator.register();

afterEach(() => cleanup());

/**
 * 回归：流式回复时聊天跳回更早的记录（2026-10-13，DESIGN.md §35）。CopilotKit 的消息列表超过
 * 50 条会虚拟化，没量过的行按平均高度估算，行数一变就整体重估，视口上方凭空多出几千像素。
 * 机器人聊天必须给 messageView 一个 `children` 渲染函数——这是 CopilotKit 关闭虚拟化的正式写法。
 */
describe("机器人聊天消息列表不虚拟化", () => {
  test("messageView 插槽带 children 渲染函数（否则 >50 条消息时会被虚拟化）", () => {
    expect(typeof (RICH_MESSAGE_VIEW as { children?: unknown }).children).toBe("function");
    expect((RICH_MESSAGE_VIEW as { children?: unknown }).children).toBe(renderUnvirtualizedMessageList);
  });

  const many = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user" }));
  const elements = many.map((m) => (
    <div className="copilotKitMessage" data-message-id={m.id} key={m.id}>
      {m.id}
    </div>
  ));

  test("所有消息都直接挂在 .copilotKitMessages 下（turn-compaction 和样式按这个结构找消息）", () => {
    const view = render(
      renderUnvirtualizedMessageList({ isRunning: false, messages: many, messageElements: elements, interruptElement: null }),
    );
    const list = view.container.querySelector(".copilotKitMessages");
    expect(list).not.toBeNull();
    expect(list?.getAttribute("data-testid")).toBe("copilot-message-list");
    expect(list?.children.length).toBe(120);
    expect(list?.children[0]?.getAttribute("data-message-id")).toBe("m0");
    expect(list?.children[119]?.getAttribute("data-message-id")).toBe("m119");
    expect(view.container.querySelector("[data-index]")).toBeNull();
    expect(view.container.querySelector('[data-testid="copilot-loading-cursor"]')).toBeNull();
  });

  test("运行中画光标，最后一条是思考时不画；打断元素在消息后面", () => {
    const running = render(
      renderUnvirtualizedMessageList({
        isRunning: true,
        messages: many,
        messageElements: elements.slice(0, 3),
        interruptElement: <div data-testid="interrupt" />,
      }),
    );
    const list = running.container.querySelector(".copilotKitMessages");
    expect(list?.querySelector('[data-testid="copilot-loading-cursor"]')).not.toBeNull();
    expect(list?.children[3]?.getAttribute("data-testid")).toBe("interrupt");
    cleanup();
    const thinking = render(
      renderUnvirtualizedMessageList({
        isRunning: true,
        messages: [...many, { id: "r", role: "reasoning" }],
        messageElements: elements.slice(0, 3),
        interruptElement: null,
      }),
    );
    expect(thinking.container.querySelector('[data-testid="copilot-loading-cursor"]')).toBeNull();
  });

  test("光标与排队位不带 data-message-id，content-visibility 只按消息节点数最后几条（CB-005）", () => {
    const running = render(
      renderUnvirtualizedMessageList({
        isRunning: true,
        messages: many,
        messageElements: elements.slice(0, 4),
        interruptElement: null,
      }),
    );
    const list = running.container.querySelector(".cb-message-list");
    expect(list).not.toBeNull();
    const kids = [...(list?.children ?? [])] as HTMLElement[];
    const withId = kids.filter((el) => el.hasAttribute("data-message-id"));
    const withoutId = kids.filter((el) => !el.hasAttribute("data-message-id"));
    expect(withId.length).toBe(4);
    // 光标包裹层在列表末尾，不能带 data-message-id，否则会挤掉「最后 N 条消息」的热区。
    expect(withoutId.length).toBeGreaterThanOrEqual(1);
    expect(list?.querySelector('[data-testid="copilot-loading-cursor"]')).not.toBeNull();
    expect(
      list?.querySelector('[data-testid="copilot-loading-cursor"]')?.closest("[data-message-id]"),
    ).toBeNull();
  });
});
