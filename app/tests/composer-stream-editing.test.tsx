import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

/**
 * 回复流式输出时，输入框里的各种编辑都不能被打乱（审查 #415，接 composer-stream-typing.test.tsx）。
 *
 * 那个文件证明了「逐个打字 / 退格」在流式块的提交和它的副作用之间落下时顺序不乱。这里覆盖其余几种
 * 编辑：光标在中间时打字、输入法组字、粘贴、撤销 / 重做、草稿保存。做法相同：每个流式块让父组件带着
 * 新建的 agents / commands 数组重渲染一次输入框（和 channel-chat.tsx 一样），这一步编辑在这次提交的
 * layout effect 里落下——也就是块提交之后、被动副作用之前，主线程忙时按键最容易落进的那个空档。
 *
 * 撤销 / 重做的期望值不写死：同一串编辑在「没有流式」时跑一遍得到的结果就是标准答案，流式时必须一模一样。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Edit = (editor: HTMLElement) => void;

function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[contenteditable]") as HTMLElement;
}

/** 浏览器打一个可见字符：在光标处插入、光标后移、发 input。 */
function typeAtCaret(editor: HTMLElement, ch: string) {
  const selection = document.getSelection();
  if (!selection) throw new Error("no selection");
  let range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (!range || !editor.contains(range.startContainer)) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    const node = startContainer as Text;
    node.insertData(startOffset, ch);
    range.setStart(node, startOffset + ch.length);
  } else {
    const node = document.createTextNode(ch);
    range.insertNode(node);
    range.setStart(node, ch.length);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.input(editor);
}

/** 把光标放到第 offset 个字符后面（编辑器里只有纯文字时）。 */
function caretAt(editor: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let left = offset;
  let node = walker.nextNode() as Text | null;
  while (node && left > node.length) {
    left -= node.length;
    node = walker.nextNode() as Text | null;
  }
  const range = document.createRange();
  if (node) range.setStart(node, left);
  else {
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function caretToEnd(editor: HTMLElement) {
  caretAt(editor, Number.MAX_SAFE_INTEGER);
}

function paste(editor: HTMLElement, text: string) {
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
}

const typeEach = (text: string): Edit[] => [...text].map((ch) => (editor) => typeAtCaret(editor, ch));
const undo: Edit = (editor) => fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
const redo: Edit = (editor) => fireEvent.keyDown(editor, { key: "z", ctrlKey: true, shiftKey: true });

/** 代替流式中的 ChannelChat：每个 tick 是一个流式块，提交后在 layout effect 里落下排好的那一步编辑。 */
function StreamingParent({
  tick,
  editRef,
  onSubmit,
  draftKey,
}: {
  tick: number;
  editRef: { current: { editor: HTMLElement | null; edit: Edit | null } };
  onSubmit: (draft: { text: string }) => void;
  draftKey?: string;
}) {
  const agents = [{ id: "agent-1", name: "千纱" }];
  const commands = [{ id: "help", name: "help", description: "帮助" }];
  const seen = useRef(tick);
  useLayoutEffect(() => {
    if (seen.current === tick) return;
    seen.current = tick;
    const { editor, edit } = editRef.current;
    editRef.current.edit = null;
    if (editor && edit) edit(editor);
  }, [tick, editRef]);
  return (
    <Composer
      agents={agents}
      commands={commands}
      compact
      draftKey={draftKey}
      initialValue=""
      onSubmit={onSubmit}
    />
  );
}

/**
 * streaming = true：每一步编辑都搭在一个流式块上落下；false：同样的编辑一步一步直接做（对照组）。
 * 每一步之后记下编辑器里的文字。
 */
function setup({ streaming, draftKey }: { streaming: boolean; draftKey?: string }) {
  const sent: string[] = [];
  const onSubmit = (draft: { text: string }) => {
    sent.push(draft.text);
  };
  const editRef: { current: { editor: HTMLElement | null; edit: Edit | null } } = {
    current: { editor: null, edit: null },
  };
  const view = render(<StreamingParent draftKey={draftKey} editRef={editRef} onSubmit={onSubmit} tick={0} />);
  const editor = editorOf(view.container);
  editRef.current.editor = editor;
  editor.focus();
  let tick = 0;
  const snapshots: string[] = [];
  const step = async (edit: Edit) => {
    if (streaming) {
      editRef.current.edit = edit;
      tick += 1;
      await act(async () => {
        view.rerender(<StreamingParent draftKey={draftKey} editRef={editRef} onSubmit={onSubmit} tick={tick} />);
      });
    } else {
      await act(async () => {
        edit(editor);
      });
    }
    snapshots.push(editor.textContent ?? "");
  };
  const run = async (edits: Edit[]) => {
    for (const edit of edits) await step(edit);
  };
  const send = async () => {
    await act(async () => {
      fireEvent.click(view.getByLabelText("发送消息"));
    });
  };
  return { view, editor, sent, step, run, send, snapshots };
}

test("typing with the caret in the middle of the text, during a stream, inserts there and nowhere else", async () => {
  const { editor, run, send, sent } = setup({ streaming: true });
  await run(typeEach("abef"));
  await run([(e) => caretAt(e, 2), ...typeEach("cd")]);
  expect(editor.textContent).toBe("abcdef");
  await run([(e) => caretAt(e, 0), ...typeEach("开头")]);
  expect(editor.textContent).toBe("开头abcdef");
  await send();
  expect(sent).toEqual(["开头abcdef"]);
});

test("an IME composition that spans several streamed chunks is not written over, and commits once", async () => {
  const { editor, run, step, send, sent } = setup({ streaming: true });
  await run(typeEach("我"));
  await step((e) => {
    caretToEnd(e);
    fireEvent.compositionStart(e);
  });
  for (const shown of ["我x", "我xi", "我xia", "我xiang"]) {
    await step((e) => {
      e.textContent = shown;
      fireEvent.input(e);
    });
    // 块提交没有把组字中的文字改回去（改回去就是把输入法的组字打断）。
    expect(editor.textContent).toBe(shown);
  }
  await step((e) => {
    e.textContent = "我想";
    fireEvent.input(e);
    fireEvent.compositionEnd(e, { data: "想" });
  });
  expect(editor.textContent).toBe("我想");
  await run([(e) => caretToEnd(e), ...typeEach("说")]);
  expect(editor.textContent).toBe("我想说");
  await send();
  expect(sent).toEqual(["我想说"]);
});

test("pasting during a stream lands at the caret, and typing continues after it", async () => {
  const script: Edit[] = [
    ...typeEach("ab"),
    (e) => caretToEnd(e),
    (e) => paste(e, "粘贴的字"),
    ...typeEach("c"),
    (e) => caretAt(e, 1),
    (e) => paste(e, "中间"),
  ];
  const idle = setup({ streaming: false });
  await idle.run(script);
  const expected = [...idle.snapshots];
  cleanup();
  const { editor, run, send, sent, snapshots } = setup({ streaming: true });
  await run(script);
  expect(snapshots).toEqual(expected);
  expect(editor.textContent).toBe("a中间b粘贴的字c");
  /*
   * 粘贴后光标的位置由 prompt-area 自己放；happy-dom 里它总落在末尾（没有流式时也一样），所以这里只在
   * 末尾接着打字，中间粘贴之后接着打字的位置不在这个测试里断言。
   */
  await run([(e) => caretToEnd(e), ...typeEach("!")]);
  expect(editor.textContent).toBe("a中间b粘贴的字c!");
  await send();
  expect(sent).toEqual(["a中间b粘贴的字c!"]);
});

test("undo and redo during a stream give exactly what they give with no stream", async () => {
  const script: Edit[] = [
    ...typeEach("abc"),
    (e) => caretToEnd(e),
    (e) => paste(e, "XYZ"),
    ...typeEach("d"),
    undo,
    undo,
    redo,
    ...typeEach("e"),
    undo,
  ];
  const idle = setup({ streaming: false });
  await idle.run(script);
  const expected = [...idle.snapshots];
  cleanup();
  const streamed = setup({ streaming: true });
  await streamed.run(script);
  expect(streamed.snapshots).toEqual(expected);
  // 撤销真的生效了（不是两边都没反应）：撤销后的文字和撤销前不同。
  const firstUndo = script.indexOf(undo);
  expect(expected[firstUndo]).not.toBe(expected[firstUndo - 1]);
});

test("the draft is saved while a stream runs, and comes back when the composer mounts again", async () => {
  const draftKey = "stream-draft-test";
  const first = setup({ streaming: true, draftKey });
  await first.run(typeEach("草稿abc"));
  await first.run([(e) => caretAt(e, 2), (e) => paste(e, "，")]);
  expect(first.editor.textContent).toBe("草稿，abc");
  // 让 composer 把草稿写进内存（同步）和 localStorage（合并 150ms）。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  cleanup();
  const second = setup({ streaming: false, draftKey });
  expect(second.editor.textContent).toBe("草稿，abc");
  await second.send();
  expect(second.sent).toEqual(["草稿，abc"]);
});