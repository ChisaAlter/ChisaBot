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
import { resetUiMemory, setThreadUi, threadUi } from "@/lib/chat/ui-memory";
import { settleReactWork } from "./settle-react-work";

/**
 * 新话题页（A1）：还没有对话，输入框照样能选、拖入、粘贴文件，但不上传——原样交给页面（它先建对话再跳过去），
 * 交出去之前把写了一半的字同步记进草稿键。没给 `onAttachWithoutChannel` 的输入框和以前一样（见
 * composer-attachments-ui.test.tsx）。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let requests: string[];
beforeEach(() => {
  resetUiMemory();
  requests = [];
  global.fetch = (async (path: string) => {
    requests.push(String(path));
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

const png = (name: string) => new File(["png"], name, { type: "image/png" });

test("「+」可用，选的文件交给页面，不上传；字先记进草稿键", async () => {
  setThreadUi("new:bot", { draft: [{ type: "text", text: "看看这张" }] });
  const handed: File[][] = [];
  const view = render(
    <Composer
      compact
      draftKey="new:bot"
      onAttachWithoutChannel={(files) => handed.push(files)}
      onSubmit={async () => {}}
    />,
  );

  const plus = view.getByLabelText("附加文件") as HTMLButtonElement;
  expect(plus.disabled).toBe(false);
  const input = view.getByLabelText("选择文件") as HTMLInputElement;
  expect(input.type).toBe("file");
  expect(input.multiple).toBe(true);

  const files = [png("a.png"), png("b.png")];
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });

  expect(handed).toHaveLength(1);
  expect(handed[0]?.map((file) => file.name)).toEqual(["a.png", "b.png"]);
  expect(requests).toEqual([]);
  expect(threadUi("new:bot")?.draft).toEqual([
    { type: "text", text: "看看这张" },
  ]);
  // 没有在这个输入框里放上任何附件：它们属于马上要建的那段对话。
  expect(view.queryByLabelText("移除 a.png")).toBeNull();
});

test("拖进来的文件也交给页面，不再说「还没有对话」", async () => {
  const handed: File[][] = [];
  const view = render(
    <Composer
      compact
      draftKey="new:bot"
      onAttachWithoutChannel={(files) => handed.push(files)}
      onSubmit={async () => {}}
    />,
  );
  const form = view.container.querySelector("form") as HTMLElement;
  await act(async () => {
    fireEvent.drop(form, {
      dataTransfer: { files: [png("drop.png")], items: [], types: ["Files"] },
    });
  });
  expect(handed.map((files) => files.map((file) => file.name))).toEqual([
    ["drop.png"],
  ]);
  expect(view.queryByText(/还没有对话|there is no conversation/)).toBeNull();
});

test("粘贴的图片也交给页面", async () => {
  const handed: File[][] = [];
  const view = render(
    <Composer
      compact
      draftKey="new:bot"
      onAttachWithoutChannel={(files) => handed.push(files)}
      onSubmit={async () => {}}
    />,
  );
  const editor = view.container.querySelector(
    "[contenteditable]",
  ) as HTMLElement;
  const file = png("paste.png");
  await act(async () => {
    fireEvent.paste(editor, {
      clipboardData: {
        files: [file],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
        types: ["Files"],
        getData: () => "",
      },
    });
  });
  expect(handed.flat().map((f) => f.name)).toEqual(["paste.png"]);
});

test("对话不可用（disabled）时不收", () => {
  const view = render(
    <Composer
      compact
      disabled
      draftKey="new:bot"
      onAttachWithoutChannel={() => {
        throw new Error("should not be called");
      }}
      onSubmit={async () => {}}
    />,
  );
  expect(view.queryByLabelText("选择文件")).toBeNull();
  expect(view.queryByLabelText("附加文件")).toBeNull();
});
