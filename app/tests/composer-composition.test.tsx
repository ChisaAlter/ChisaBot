import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

/**
 * THE COMPOSING TEXT AN INPUT METHOD HOLDS IS NOT THE COMPOSER'S VALUE YET.
 *
 * `prompt-area` renders the controlled `value` back into the contenteditable whenever it changes.
 * A Chinese/Japanese IME delivers its first composing character through `onChange` while the
 * composition is still open, and writing that value back at that moment is what cancelled the
 * composition: the first character looked like it never reached the box. The composer now holds
 * every change until `compositionend` and commits it there — these two tests pin down both halves,
 * and the way out of a composition that never ends.
 *
 * THERE IS NO IME IN HAPPY-DOM, so the composition is driven the way the browser would drive it:
 * `compositionstart` on the editor, the editor's text changed in place, an `input` event, then
 * `compositionend`. What the test watches is not pixels but the composer's value — which is what
 * the send button and the message are built from. A value that moved mid-composition is exactly
 * the write-back that cancelled it.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll` and `cleanup` in
 * `afterEach`, matching `composer-send-failure.test.tsx` for the reason recorded there: bun walks
 * every file into one process, and a document another file tore down mid-run fails invisibly.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

/** The editor inside the composer: the element the words actually live in. */
function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[contenteditable]") as HTMLElement;
}

/**
 * One IME step: the editor's text becomes what the input method is showing, and the browser fires
 * the `input` event that `prompt-area` turns into `onChange`.
 */
function composingStep(editor: HTMLElement, text: string) {
  editor.focus();
  editor.textContent = text;
  fireEvent.input(editor);
}

/** A send whose text this test records, so "what was sent" is an assertion. */
function recordingSend() {
  const sent: string[] = [];
  return {
    sent,
    onSubmit: (draft: { text: string }) => {
      sent.push(draft.text);
    },
  };
}

test("composing text is neither committed nor sendable until the composition ends", async () => {
  const send = recordingSend();
  const { container, getByLabelText } = render(
    <Composer compact initialValue="" onSubmit={send.onSubmit} />,
  );
  const editor = editorOf(container);
  const button = getByLabelText("发送消息") as HTMLButtonElement;

  await act(async () => {
    fireEvent.compositionStart(editor);
  });
  composingStep(editor, "ni");

  // The editor keeps what the IME is showing, and the composer's value is still empty — the
  // change was held instead of written back.
  expect(editor.textContent).toBe("ni");
  expect(button.disabled).toBe(true);

  // A press while the candidate is open cannot carry the half-finished composition out.
  await act(async () => {
    fireEvent.click(button);
  });
  expect(send.sent).toEqual([]);

  // Committing the candidate commits the text, once.
  await act(async () => {
    fireEvent.compositionEnd(editor);
  });
  expect(button.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(button);
  });
  expect(send.sent).toEqual(["ni"]);
});

test("an interrupted composition does not leave the box swallowing every later keystroke", async () => {
  const send = recordingSend();
  const { container, getByLabelText } = render(
    <Composer compact initialValue="" onSubmit={send.onSubmit} />,
  );
  const editor = editorOf(container);
  const button = getByLabelText("发送消息") as HTMLButtonElement;

  await act(async () => {
    fireEvent.compositionStart(editor);
  });
  composingStep(editor, "ni");

  // THE INTERRUPTION: focus leaves while the candidate is still open. Some IMEs and platforms
  // never deliver the `compositionend` that would clear the flag, and an editor that can no longer
  // be typed into is worse than the bug this file is about. Blurring commits what is on screen.
  await act(async () => {
    fireEvent.blur(editor);
  });
  expect(button.disabled).toBe(false);

  composingStep(editor, "ni好");
  await act(async () => {
    fireEvent.click(button);
  });
  expect(send.sent).toEqual(["ni好"]);
});

/**
 * THE PROMPT UNDER THE PINYIN.
 *
 * `prompt-area` draws its placeholder whenever the controlled `value` is empty, and during a
 * composition the value IS empty on purpose: the text the IME is still building is not committed
 * until `compositionend`. So the box showed "输入消息…" underneath the letters of the composition,
 * two sets of glyphs in the same place. The placeholder now steps aside for the duration.
 *
 * This is the one place a render during a composition is allowed here: it changes the placeholder
 * string and nothing else, while `value` keeps its identity, so the editor's DOM is never written.
 */
test("the placeholder does not sit on top of the composition", async () => {
  const { container } = render(
    <Composer compact initialValue="" onSubmit={() => {}} />,
  );
  const editor = editorOf(container);
  const prompt = "输入消息…";

  // The empty box shows its prompt.
  expect(container.textContent).toContain(prompt);

  await act(async () => {
    fireEvent.compositionStart(editor);
  });
  composingStep(editor, "ni");

  // The pinyin is on screen, and the prompt is not drawn under it.
  expect(editor.textContent).toBe("ni");
  expect(container.textContent).not.toContain(prompt);

  await act(async () => {
    fireEvent.compositionEnd(editor);
  });
  // The composition committed real text, so the prompt stays away for the same reason it always
  // would — there is something in the box.
  expect(container.textContent).not.toContain(prompt);
});

test("a composition that commits nothing gives the prompt back", async () => {
  const { container } = render(
    <Composer compact initialValue="" onSubmit={() => {}} />,
  );
  const editor = editorOf(container);
  const prompt = "输入消息…";

  await act(async () => {
    fireEvent.compositionStart(editor);
  });
  expect(container.textContent).not.toContain(prompt);

  // Cancelled before any character was committed: the box is empty again, and so is the prompt
  // story — it has to come back, or the empty box would have no words in it at all.
  await act(async () => {
    fireEvent.compositionEnd(editor);
  });
  expect(container.textContent).toContain(prompt);
});
