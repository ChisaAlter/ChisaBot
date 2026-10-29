/**
 * Audit module 4 (composer + attachments), one test per finding. Each of these fails on the main
 * this branch started from (80090755) and passes with the fix.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  UPLOAD_FAILED_MESSAGE,
  UPLOAD_OFFLINE_MESSAGE,
  UploadAbortedError,
  uploadToChannel,
} from "@/components/channels/composer/attachments";
import {
  Composer,
  pasteTooLongReason,
} from "@/components/channels/composer/composer";
import { MAX_EXTRACTED_CHARACTERS } from "@/lib/channels/attachments";
import { screenPickedFiles } from "@/components/channels/composer/picked-files";
import { FetchBackedXhr, installFetchBackedXhr } from "./fetch-backed-xhr";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  installFetchBackedXhr();
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let originalMatchMedia: typeof window.matchMedia;
let uploads: { name: string; text?: string }[];
/** What the next upload answers: a status, or `"offline"` for a connection that never opens. */
let answers: (number | "offline" | "hang")[];

beforeEach(() => {
  uploads = [];
  answers = [];
  installFetchBackedXhr();
  originalMatchMedia = window.matchMedia;
  global.fetch = (async (_path: string, init: RequestInit) => {
    const file = (init.body as FormData).get("file") as File;
    uploads.push({ name: file.name, text: await file.text() });
    const answer = answers.shift() ?? 201;
    if (answer === "offline") throw new TypeError("Failed to fetch");
    if (answer === "hang") return new Promise<Response>(() => {});
    if (answer !== 201) {
      return new Response("Internal Server Error", { status: answer });
    }
    return Response.json(
      {
        id: `att-${uploads.length}`,
        name: file.name,
        mimeType: file.type || "text/plain",
      },
      { status: 201 },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[contenteditable]") as HTMLElement;
}

function pick(container: HTMLElement, files: File[]) {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  fireEvent.change(input);
}

function coarsePointer() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("coarse"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

// ── M4-1 ────────────────────────────────────────────────────────────────────────────────────────

test("M4-1: on a touch screen Enter does not send, and the keyboard's key says 'enter'", async () => {
  coarsePointer();
  const sent: string[] = [];
  const { container } = render(
    <Composer
      compact
      initialValue="第一行"
      onSubmit={(draft) => void sent.push(draft.text)}
    />,
  );
  const editor = editorOf(container);
  expect(editor.getAttribute("enterkeyhint")).toBe("enter");
  await act(async () => {
    fireEvent.keyDown(editor, { key: "Enter" });
  });
  expect(sent).toEqual([]);
});

test("M4-1: with a mouse, Enter still sends and the key says 'send'", async () => {
  const sent: string[] = [];
  const { container } = render(
    <Composer
      compact
      initialValue="你好"
      onSubmit={(draft) => void sent.push(draft.text)}
    />,
  );
  const editor = editorOf(container);
  expect(editor.getAttribute("enterkeyhint")).toBe("send");
  await act(async () => {
    fireEvent.keyDown(editor, { key: "Enter" });
  });
  expect(sent).toEqual(["你好"]);
});

// ── M4-2 ────────────────────────────────────────────────────────────────────────────────────────

test("M4-2: the upload reports progress", async () => {
  const seen: number[] = [];
  await uploadToChannel("chan", "group", (_file, fraction) =>
    seen.push(fraction),
  )(new File(["x"], "a.txt", { type: "text/plain" }));
  expect(seen).toEqual([0.5, 1]);
});

test("M4-2: while a file uploads, the composer says how far along it is beside the grey Send", async () => {
  answers = ["hang"];
  const view = render(
    <Composer channelId="c1" compact initialValue="看看" onSubmit={() => {}} />,
  );
  pick(view.container, [
    new File(["hello"], "notes.txt", { type: "text/plain" }),
  ]);
  await waitFor(() =>
    expect(view.getByTestId("composer-upload-hint").textContent).toBe(
      "上传中 50%",
    ),
  );
  expect((view.getByLabelText("发送消息") as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(view.getByTestId("upload-percent").textContent).toBe("上传中 50%");
});

// ── M4-3 ────────────────────────────────────────────────────────────────────────────────────────

test("M4-3: a 500 does not repeat the file name the tile already shows", async () => {
  answers = [500];
  await expect(
    uploadToChannel(
      "chan",
      "group",
    )(new File(["x"], "receipt.png", { type: "image/png" })),
  ).rejects.toThrow(UPLOAD_FAILED_MESSAGE);
  expect(UPLOAD_FAILED_MESSAGE).not.toContain("receipt.png");
});

test("M4-3: offline, the reason is Chinese and says so, not 'Failed to fetch'", async () => {
  answers = ["offline"];
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: false,
  });
  const error = await uploadToChannel(
    "chan",
    "group",
  )(new File(["x"], "a.png", { type: "image/png" })).catch((e: Error) => e);
  expect((error as Error).message).toBe(UPLOAD_OFFLINE_MESSAGE);
  expect((error as Error).message).not.toContain("Failed to fetch");
});

test("M4-3: a failed upload keeps its tile with a retry, and the retry uploads it again", async () => {
  answers = [500, 201];
  const view = render(<Composer channelId="c1" compact onSubmit={() => {}} />);
  pick(view.container, [
    new File(["hello"], "notes.txt", { type: "text/plain" }),
  ]);

  const retry = await waitFor(() => view.getByLabelText("重试上传 notes.txt"));
  expect(view.getByText(UPLOAD_FAILED_MESSAGE)).toBeTruthy();
  await act(async () => {
    fireEvent.click(retry);
  });
  await waitFor(() =>
    expect(view.queryByLabelText("移除 notes.txt")).not.toBeNull(),
  );
  await waitFor(() =>
    expect(view.queryByLabelText("重试上传 notes.txt")).toBeNull(),
  );
  expect(uploads.map((u) => u.name)).toEqual(["notes.txt", "notes.txt"]);
});

test("M4-7: a refusal reason does not repeat the file name the line already starts with", () => {
  const { rejected } = screenPickedFiles(
    [new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })],
    { alreadyStaged: 0 },
  );
  expect(rejected[0]?.reason).not.toContain("logo.svg");
});

/** A `dragleave` heading for `next`; happy-dom drops `relatedTarget` from the init, so it is set by hand. */
function leaving(zone: HTMLElement, dataTransfer: object, next: Element) {
  const event = createEvent.dragLeave(zone, { dataTransfer });
  Object.defineProperty(event, "relatedTarget", { value: next });
  return event;
}

// ── M4-6 ────────────────────────────────────────────────────────────────────────────────────────

test("M4-6: dragging a file over the composer highlights it, and moving onto a child does not flicker it off", async () => {
  const { container } = render(
    <Composer channelId="c1" compact onSubmit={() => {}} />,
  );
  const form = container.querySelector("form") as HTMLFormElement;
  const zone = form.parentElement as HTMLElement;
  const dataTransfer = { files: [], types: ["Files"], dropEffect: "none" };
  await act(async () => {
    fireEvent(zone, createEvent.dragOver(zone, { dataTransfer }));
  });
  expect(form.getAttribute("data-drag-over")).toBe("true");
  await act(async () => {
    fireEvent(zone, leaving(zone, dataTransfer, editorOf(container)));
  });
  expect(form.getAttribute("data-drag-over")).toBe("true");
  await act(async () => {
    fireEvent(zone, leaving(zone, dataTransfer, document.body));
  });
  expect(form.getAttribute("data-drag-over")).toBeNull();
});

// ── M4-9 ────────────────────────────────────────────────────────────────────────────────────────

test("M4-9: the attachment × and the touch toolbar have 44px hit areas", async () => {
  const view = render(<Composer channelId="c1" compact onSubmit={() => {}} />);
  pick(view.container, [
    new File(["hello"], "notes.txt", { type: "text/plain" }),
  ]);
  const remove = await waitFor(() => view.getByLabelText("移除 notes.txt"));
  expect(remove.className).toContain("touch-target");
  const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
  expect(css).toMatch(/\.touch-target::after\s*\{[^}]*44px/);
  expect(css).toMatch(
    /@media \(pointer: coarse\)\s*\{\s*\.glass-composer-toolbar button/,
  );
});

// ── M4-10 ───────────────────────────────────────────────────────────────────────────────────────

test("M4-10: the copy reads as Chinese, and the voice feature has one name", async () => {
  const source = (file: string) =>
    readFileSync(
      join(import.meta.dir, "../src/components/channels/composer", file),
      "utf8",
    );
  const all = ["composer.tsx", "rejected-files.tsx", "dictation-controls.tsx"]
    .map(source)
    .join("\n");
  for (const stale of [
    "队列消息",
    "驳回",
    "再次记录",
    "口述消息",
    "听写",
    "转录",
  ]) {
    expect(all).not.toContain(`"${stale}`);
  }
  expect(source("dictation-controls.tsx")).toContain('"语音输入"');
});

// ── M4-11 ───────────────────────────────────────────────────────────────────────────────────────

test("M4-11: a long paste becomes a text card that still goes with the message and opens to preview", async () => {
  const long = "长".repeat(2500);
  const view = render(<Composer channelId="c1" compact onSubmit={() => {}} />);
  const editor = editorOf(view.container);
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  await act(async () => {
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? long : ""),
      },
    });
  });

  await waitFor(() =>
    expect(view.queryByLabelText("移除 粘贴的文本 1.txt")).not.toBeNull(),
  );
  expect(editor.textContent).toBe("");
  expect(uploads).toEqual([{ name: "粘贴的文本 1.txt", text: long }]);

  await act(async () => {
    fireEvent.click(view.getByLabelText("预览 粘贴的文本 1.txt"));
  });
  await waitFor(() =>
    expect(view.getByTestId("pasted-text-preview").textContent).toBe(long),
  );
});

test("M4-11: a short paste is still typed into the box", async () => {
  const view = render(<Composer channelId="c1" compact onSubmit={() => {}} />);
  const editor = editorOf(view.container);
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  await act(async () => {
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        items: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? "短短一句" : ""),
      },
    });
  });
  expect(uploads).toEqual([]);
});

function pasteText(editor: HTMLElement, value: string) {
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(true);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? value : ""),
    },
  });
}

test("M4-11: a paste the model could only read part of is refused out loud, not turned into a card", async () => {
  const tooLong = "a".repeat(MAX_EXTRACTED_CHARACTERS + 1);
  const view = render(<Composer channelId="c1" compact onSubmit={() => {}} />);
  const editor = editorOf(view.container);
  await act(async () => {
    pasteText(editor, tooLong);
  });
  await waitFor(() =>
    expect(
      view.getByText(pasteTooLongReason(tooLong.length), { exact: false }),
    ).toBeTruthy(),
  );
  expect(uploads).toEqual([]);
  expect(editor.textContent).toBe("");
});

test("M4-11: a paste exactly at the model's limit still becomes a card", async () => {
  const atLimit = "b".repeat(MAX_EXTRACTED_CHARACTERS);
  const view = render(<Composer channelId="c1" compact onSubmit={() => {}} />);
  await act(async () => {
    pasteText(editorOf(view.container), atLimit);
  });
  await waitFor(() => expect(uploads.length).toBe(1));
  expect(uploads[0]?.text?.length).toBe(MAX_EXTRACTED_CHARACTERS);
});

test("M4-2: aborting the signal cancels the upload request", async () => {
  answers = ["hang"];
  const controller = new AbortController();
  const before = FetchBackedXhr.aborted;
  const pending = uploadToChannel(
    "chan",
    "group",
    undefined,
    () => controller.signal,
  )(new File(["x"], "a.txt", { type: "text/plain" }));
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(UploadAbortedError);
  expect(FetchBackedXhr.aborted).toBe(before + 1);
});

test("M4-2: once every byte is out, aborting the signal no longer cancels (the row may already exist)", async () => {
  FetchBackedXhr.bodySentBeforeAnswer = true;
  try {
    const controller = new AbortController();
    const before = FetchBackedXhr.aborted;
    const pending = uploadToChannel(
      "chan",
      "group",
      undefined,
      () => controller.signal,
    )(new File(["x"], "a.txt", { type: "text/plain" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ type: "url" });
    expect(FetchBackedXhr.aborted).toBe(before);
  } finally {
    FetchBackedXhr.bodySentBeforeAnswer = false;
  }
});

test("M4-2: removing a chip mid-upload aborts its request and leaves no failed tile", async () => {
  answers = ["hang"];
  const before = FetchBackedXhr.aborted;
  const view = render(<Composer channelId="c1" compact onSubmit={() => {}} />);
  pick(view.container, [
    new File(["hello"], "notes.txt", { type: "text/plain" }),
  ]);
  const remove = await waitFor(() => view.getByLabelText("移除 notes.txt"));
  await act(async () => {
    fireEvent.click(remove);
  });
  await waitFor(() => expect(FetchBackedXhr.aborted).toBe(before + 1));
  await settleReactWork();
  expect(view.queryByLabelText("移除 notes.txt")).toBeNull();
  expect(view.queryByLabelText("重试上传 notes.txt")).toBeNull();
});

void FetchBackedXhr;
