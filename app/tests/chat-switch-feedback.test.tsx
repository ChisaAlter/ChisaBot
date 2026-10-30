import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import {
  afterNextPaint,
  cancelAfterNextPaint,
  clearPendingBot,
  getPendingBot,
  isPlainClick,
  markPendingBot,
  sendTargetsStaleChannel,
  usePendingBot,
} from "@/lib/chat/pending-switch";
import { settleReactWork } from "./settle-react-work";

/**
 * 切会话即时反馈（FIX-PLAN F0 / P1-1）：左栏高亮先单独提交一次（点下去那一帧就变），
 * 整段对话放到延后渲染；新对话没画好前旧的一页半透明留着，不留白。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(async () => {
  clearPendingBot();
  cleanup();
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function Highlight({ route }: { route: string }) {
  const pending = usePendingBot();
  return <span data-testid="on">{pending ?? route}</span>;
}

test("点下去先亮新机器人，路由跟上后清掉、回到按路由算", () => {
  const view = render(<Highlight route="a" />);
  expect(view.getByTestId("on").textContent).toBe("a");
  act(() => markPendingBot("b"));
  expect(getPendingBot()).toBe("b");
  expect(view.getByTestId("on").textContent).toBe("b");
  act(() => clearPendingBot());
  expect(view.getByTestId("on").textContent).toBe("a");
});

test("连点三个只停在最后一个", () => {
  const view = render(<Highlight route="a" />);
  act(() => {
    markPendingBot("b");
    markPendingBot("c");
    markPendingBot("d");
  });
  expect(view.getByTestId("on").textContent).toBe("d");
});

test("只有普通左键点击才算切过去（新标签页打开不改高亮）", () => {
  const base = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
  };
  expect(isPlainClick(base)).toBe(true);
  expect(isPlainClick({ ...base, ctrlKey: true })).toBe(false);
  expect(isPlainClick({ ...base, metaKey: true })).toBe(false);
  expect(isPlainClick({ ...base, button: 1 })).toBe(false);
  expect(isPlainClick({ ...base, defaultPrevented: true })).toBe(false);
});

test("导航排在高亮那一帧之后", async () => {
  const order: string[] = [];
  afterNextPaint(() => order.push("navigate"));
  order.push("highlight");
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(order).toEqual(["highlight", "navigate"]);
});

test("换对话还没画好：旧的一页半透明留着（data-switching），仍可见但 inert（键盘也进不去）", () => {
  const stage = (id: string, switching: boolean) => (
    <KeepAliveStage
      address={{ id }}
      renderKept={(kept) => <div data-testid="page">{kept.id}</div>}
      same={(a, b) => a.id === b.id}
      switching={switching}
    >
      {null}
    </KeepAliveStage>
  );
  const view = render(stage("c1", true));
  const kept = view.getByTestId("kept-page");
  expect(kept.getAttribute("data-switching")).toBe("true");
  expect(kept.getAttribute("data-visible")).toBe("true");
  expect(kept.hasAttribute("inert")).toBe(true);
  expect(view.getByTestId("page").textContent).toBe("c1");
  view.rerender(stage("c2", false));
  expect(view.getByTestId("kept-page").hasAttribute("data-switching")).toBe(
    false,
  );
  expect(view.getByTestId("page").textContent).toBe("c2");
});

test("连着排两次导航只跑最后一次；撤销后一次都不跑（点会话再马上点设置不会被拉回去）", async () => {
  const ran: string[] = [];
  afterNextPaint(() => ran.push("chat-a"));
  afterNextPaint(() => ran.push("chat-b"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(ran).toEqual(["chat-b"]);
  afterNextPaint(() => ran.push("chat-c"));
  cancelAfterNextPaint(); // 例如马上点了设置
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(ran).toEqual(["chat-b"]);
});

test("输入框属于旧会话（地址已换 / 左栏正在切）时判定为不该发", () => {
  expect(sendTargetsStaleChannel("c1", "/channel/c1")).toBe(false);
  expect(sendTargetsStaleChannel("c1", "/channel/c2")).toBe(true);
  expect(sendTargetsStaleChannel("c1", "/settings")).toBe(false);
  expect(sendTargetsStaleChannel(undefined, "/channel/c2")).toBe(false);
  markPendingBot("b2");
  expect(sendTargetsStaleChannel("c1", "/channel/c1")).toBe(true);
});

test("切换中焦点还在旧输入框里按 Enter：什么都不发，草稿留着", async () => {
  const sent: string[] = [];
  const view = render(
    <Composer
      channelId="c1"
      compact
      initialValue=""
      onSubmit={(draft: { text: string }) => {
        sent.push(draft.text);
      }}
    />,
  );
  const editor = view.container.querySelector(
    "[contenteditable]",
  ) as HTMLElement;
  editor.focus();
  editor.textContent = "hello";
  fireEvent.input(editor);
  act(() => markPendingBot("other-bot"));
  await act(async () => {
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
  });
  await act(async () => {
    fireEvent.click(view.getByLabelText("发送消息"));
  });
  expect(sent).toEqual([]);
  expect(editor.textContent).toBe("hello");
  act(() => clearPendingBot());
  await act(async () => {
    fireEvent.click(view.getByLabelText("发送消息"));
  });
  expect(sent).toEqual(["hello"]);
});
