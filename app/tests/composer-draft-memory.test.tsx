import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import {
  flushUiMemory,
  resetUiMemory,
  setThreadUi,
  threadUi,
} from "@/lib/chat/ui-memory";
import { settleReactWork } from "./settle-react-work";

/**
 * 输入框草稿按对话记住（DESIGN.md §88）：写了一半离开（切机器人 / 去设置）、回来或刷新后还在；
 * 发出去后草稿清掉；没给 draftKey 的输入框（首页、引导页）什么都不记。
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  resetUiMemory();
  window.localStorage.clear();
});

const typed = (container: HTMLElement) =>
  (container.querySelector("[contenteditable]") as HTMLElement).textContent ??
  "";

function typeInto(container: HTMLElement, words: string) {
  const editor = container.querySelector("[contenteditable]") as HTMLElement;
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? words : ""),
    },
  });
}

test("记下的草稿第一帧就在输入框里", () => {
  setThreadUi("ch_1", { draft: [{ type: "text", text: "写了一半的话" }] });
  const { container } = render(
    <Composer compact draftKey="ch_1" onSubmit={async () => {}} />,
  );
  expect(typed(container)).toContain("写了一半的话");
});

test("打字记下来，离开再回来（重新挂载）、刷新后都在", async () => {
  const first = render(
    <Composer compact draftKey="ch_2" onSubmit={async () => {}} />,
  );
  await act(async () => {
    typeInto(first.container, "明天提醒我交报告");
  });
  expect(typed(first.container)).toContain("明天提醒我交报告");
  first.unmount();
  flushUiMemory();
  resetUiMemory();
  const again = render(
    <Composer compact draftKey="ch_2" onSubmit={async () => {}} />,
  );
  expect(typed(again.container)).toContain("明天提醒我交报告");
});

test("发出去后草稿清掉；再挂载（切走再回来 / 刷新）输入框是空的", async () => {
  setThreadUi("ch_3", { draft: [{ type: "text", text: "你好?" }] });
  const first = render(
    <Composer compact draftKey="ch_3" onSubmit={async () => {}} />,
  );
  expect(typed(first.container)).toContain("你好?");
  await act(async () => {
    fireEvent.click(first.getByLabelText("发送消息"));
  });
  expect(typed(first.container)).toBe("");
  expect(threadUi("ch_3")?.draft).toBeUndefined();
  expect(threadUi("ch_3")?.sent).toBe("你好?");
  first.unmount();
  flushUiMemory();
  resetUiMemory();
  const again = render(
    <Composer compact draftKey="ch_3" onSubmit={async () => {}} />,
  );
  expect(typed(again.container)).toBe("");
});

test("明确发送失败的正文记回草稿，离开和刷新后仍可重试", async () => {
  let fail!: (error: Error) => void;
  const settled = new Promise<void>((_, reject) => {
    fail = reject;
  });
  const first = render(
    <Composer
      compact
      draftKey="ch_6"
      initialValue="你好?"
      onSubmit={() => settled}
    />,
  );
  await act(async () => {
    fireEvent.click(first.getByLabelText("发送消息"));
  });
  await act(async () => {
    fail(new Error("暂时连不上模型服务"));
    await settled.catch(() => undefined);
  });
  // 这个输入框里还在（重试 = 再按发送）
  expect(typed(first.container)).toContain("你好?");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(threadUi("ch_6")?.draft).toEqual([{ type: "text", text: "你好?" }]);
  expect(threadUi("ch_6")?.sent).toBeUndefined();
  first.unmount();
  flushUiMemory();
  resetUiMemory();
  const again = render(
    <Composer compact draftKey="ch_6" onSubmit={async () => {}} />,
  );
  expect(typed(again.container)).toBe("你好?");
});

test("记下的草稿和刚发出去的那句一样（旧版本留下的 / 发送和记草稿撞在一起）：不放回，并清掉", () => {
  setThreadUi("ch_7", {
    draft: [{ type: "text", text: "你好?" }],
    sent: "你好?",
    sentAt: Date.now(),
  });
  const { container } = render(
    <Composer compact draftKey="ch_7" onSubmit={async () => {}} />,
  );
  expect(typed(container)).toBe("");
  expect(threadUi("ch_7")?.draft).toBeUndefined();
});

test("发出去之后接着写的新草稿照常记", async () => {
  setThreadUi("ch_8", { sent: "你好?", sentAt: Date.now() });
  const first = render(
    <Composer compact draftKey="ch_8" onSubmit={async () => {}} />,
  );
  await act(async () => {
    typeInto(first.container, "下一句");
  });
  expect(rememberedText("ch_8")).toContain("下一句");
});

function rememberedText(key: string): string {
  return JSON.stringify(threadUi(key)?.draft ?? []);
}

test("别的对话的草稿不串过来；没有 draftKey 不记", async () => {
  setThreadUi("ch_4", { draft: [{ type: "text", text: "只属于四号" }] });
  const other = render(
    <Composer compact draftKey="ch_5" onSubmit={async () => {}} />,
  );
  expect(typed(other.container)).not.toContain("只属于四号");
  other.unmount();
  const plain = render(<Composer compact onSubmit={async () => {}} />);
  await act(async () => {
    typeInto(plain.container, "首页的字");
  });
  flushUiMemory();
  expect(
    window.localStorage.getItem("chisabot-ui-memory:v1") ?? "",
  ).not.toContain("首页的字");
});
