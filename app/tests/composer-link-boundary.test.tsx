import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

/**
 * A BARE URL IN THE BOX STOPS WHERE THE URL STOPS, INCLUDING BEFORE CJK TEXT.
 *
 * `prompt-area` decorates URLs inside the contenteditable: it walks the text nodes after every
 * input and wraps each `https?://` match in an `<a>`. Its matcher is `/https?:\/\/[^\s)]+/g` — a
 * negated class that only stops at whitespace and `)`, so a sentence like
 * 「https://github.com/Tencent/LoopForge这个部署完了吗？」 underlines the Chinese tail as part of
 * the link, and the anchor's href carries it percent-encoded to a page that does not exist.
 * CJK punctuation is never in the match either, so the trailing-trim half cannot rescue it.
 *
 * The patched matcher stops at every non-ASCII byte. These tests pin the boundary down through
 * the real editor rather than the regex: what is inside the `<a>` is what a click opens.
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

function type(editor: HTMLElement, text: string) {
  editor.focus();
  editor.textContent = text;
  fireEvent.input(editor);
}

test("a URL followed by CJK text underlines only the URL", () => {
  const { container } = render(<Composer initialValue="" />);
  const editor = editorOf(container);
  const said = "https://github.com/Tencent/LoopForge这个部署完了吗？";

  type(editor, said);

  const link = editor.querySelector("a[data-url]");
  expect(link).not.toBeNull();
  expect(link?.textContent).toBe("https://github.com/Tencent/LoopForge");
  // The anchor's href is what a click opens — the same boundary, not just the underline.
  expect(link?.getAttribute("href")).toBe(
    "https://github.com/Tencent/LoopForge",
  );
  // Nothing the person typed is lost or reordered: the tail stays, as plain text.
  expect(editor.textContent).toBe(said);
});

test("a URL inside a sentence still links, and ASCII trailing punctuation stays out", () => {
  const { container } = render(<Composer initialValue="" />);
  const editor = editorOf(container);

  type(editor, "看这个 https://example.com/a?b=1, 然后回复");

  const link = editor.querySelector("a[data-url]");
  expect(link?.textContent).toBe("https://example.com/a?b=1");
  expect(editor.textContent).toBe("看这个 https://example.com/a?b=1, 然后回复");
});
