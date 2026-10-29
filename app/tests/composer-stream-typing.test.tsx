import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

/**
 * TYPING WHILE A REPLY STREAMS MUST NOT REORDER OR RESURRECT CHARACTERS.
 *
 * Audit 01-chat-streaming.md #1: under 4x CPU throttling, typing `abcdefghij` into the composer
 * while a reply streamed produced `bcdefghija`; backspacing during a doc-card stream left stray
 * characters that went out with the next message.
 *
 * THE MECHANISM. Every streamed chunk re-renders the chat page, and with it the composer. Before the
 * fix that render handed `prompt-area` a fresh `triggers` array (the parent builds `agents` inline)
 * and a fresh `onChange`, and both are deps of `prompt-area`'s value-sync effect. So each chunk's
 * commit left that passive effect pending, holding the `value` of THAT render. When a keystroke
 * landed between the commit and the effect — which is exactly what a busy main thread makes likely —
 * the keystroke's own state update made React flush the pending effect first: it compared the stale
 * `value` with what the editor had just emitted, saw a difference, and rewrote the DOM with the old
 * text. The next render put the new text back, but the caret had been clamped on the way, so the
 * following keys landed in the wrong place.
 *
 * HOW THE TEST HITS THE WINDOW. Layout effects run inside the commit, before passive effects. The
 * harness below types one key from its own `useLayoutEffect` after a parent re-render — that is a
 * key arriving after a streaming chunk was committed and before its passive effects ran, made
 * deterministic.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[contenteditable]") as HTMLElement;
}

/** What the browser does for one printable key: insert at the caret, move the caret, fire `input`. */
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

/** What the browser does for Backspace with a collapsed caret inside a text node. */
function backspaceAtCaret(editor: HTMLElement) {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) throw new Error("no caret");
  const range = selection.getRangeAt(0);
  let node = range.startContainer;
  let offset = range.startOffset;
  if (node.nodeType !== Node.TEXT_NODE) {
    // Caret between children: step into the text node before it.
    const before = node.childNodes[offset - 1];
    if (!before || before.nodeType !== Node.TEXT_NODE) return;
    node = before;
    offset = (before as Text).length;
  }
  if (offset === 0) return;
  (node as Text).deleteData(offset - 1, 1);
  const next = document.createRange();
  next.setStart(node, offset - 1);
  next.collapse(true);
  selection.removeAllRanges();
  selection.addRange(next);
  fireEvent.input(editor);
}

type Key = { kind: "type"; ch: string } | { kind: "backspace" };

/**
 * Stands in for ChannelChat during a stream: every `tick` is one chunk. It re-renders the composer
 * with a freshly built `agents` array (as channel-chat.tsx does) and, from inside the commit,
 * delivers the key queued for that chunk.
 */
function StreamingParent({
  tick,
  keyRef,
  onSubmit,
}: {
  tick: number;
  keyRef: { current: { editor: HTMLElement | null; key: Key | null } };
  onSubmit: (draft: { text: string }) => void;
}) {
  const agents = [{ id: "agent-1", name: "千纱" }];
  const commands = [{ id: "help", name: "help", description: "帮助" }];
  const seen = useRef(tick);
  useLayoutEffect(() => {
    if (seen.current === tick) return;
    seen.current = tick;
    const { editor, key } = keyRef.current;
    keyRef.current.key = null;
    if (!editor || !key) return;
    if (key.kind === "type") typeAtCaret(editor, key.ch);
    else backspaceAtCaret(editor);
  }, [tick, keyRef]);
  return (
    <Composer
      agents={agents}
      commands={commands}
      compact
      initialValue=""
      onSubmit={onSubmit}
    />
  );
}

function setup() {
  const sent: string[] = [];
  const onSubmit = (draft: { text: string }) => {
    sent.push(draft.text);
  };
  const keyRef: { current: { editor: HTMLElement | null; key: Key | null } } = {
    current: { editor: null, key: null },
  };
  const view = render(
    <StreamingParent keyRef={keyRef} onSubmit={onSubmit} tick={0} />,
  );
  const editor = editorOf(view.container);
  keyRef.current.editor = editor;
  editor.focus();
  let tick = 0;
  /** One streamed chunk, with `key` arriving after its commit and before its passive effects. */
  const chunkThen = async (key: Key) => {
    keyRef.current.key = key;
    tick += 1;
    await act(async () => {
      view.rerender(
        <StreamingParent keyRef={keyRef} onSubmit={onSubmit} tick={tick} />,
      );
    });
  };
  return { view, editor, sent, chunkThen };
}

test("keys that land between a streamed chunk's commit and its effects keep their order", async () => {
  const { editor, chunkThen } = setup();
  for (const ch of "abcdefghij") {
    await chunkThen({ kind: "type", ch });
  }
  expect(editor.textContent).toBe("abcdefghij");
});

test("backspacing during a stream leaves nothing behind, and nothing rides along with the next message", async () => {
  const { editor, sent, view, chunkThen } = setup();
  for (const ch of "测试输入abc") {
    await chunkThen({ kind: "type", ch });
  }
  expect(editor.textContent).toBe("测试输入abc");
  for (let k = 0; k < 7; k++) {
    await chunkThen({ kind: "backspace" });
  }
  expect(editor.textContent).toBe("");

  // The next message is only what is typed now.
  for (const ch of "继续") {
    await chunkThen({ kind: "type", ch });
  }
  const button = view.getByLabelText("发送消息") as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(button);
  });
  expect(sent).toEqual(["继续"]);
});
