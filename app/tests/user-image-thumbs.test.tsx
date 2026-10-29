import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import type { Attachment } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { toMessageContent } from "@/components/channels/channel-chat";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { attachmentUrl } from "@/lib/channels/attachments";
import { readThreadMessages } from "@/lib/copilot/thread-messages";
import { settleReactWork } from "./settle-react-work";

/**
 * 用户消息里的图片：发出去的那一刻写进消息的附件（含服务器读出的宽高）→ 历史接口原样读回 → 气泡里画成
 * 先留好框的单图，或一摞多图，点开看原图。刷新后看到的就是读回来的这一份，所以三段连起来测。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];

function imagePart(id: string, width = 640, height = 480) {
  return {
    type: "image" as const,
    source: { type: "url" as const, value: attachmentUrl(id) },
    metadata: {
      attachmentId: id,
      filename: `${id.slice(0, 4)}.png`,
      width,
      height,
    },
  };
}

function userTurn(id: string, parts: unknown[]): Message {
  return { id, role: "user", content: parts } as unknown as Message;
}

function renderTranscript(messages: readonly Message[]) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatTranscript messages={messages} />
    </QueryClientProvider>,
  );
}

describe("发出去的那一份", () => {
  test("附件带着上传时读出的宽高写进消息", () => {
    const attachment = {
      id: "local-1",
      type: "image",
      source: {
        type: "url",
        value: attachmentUrl(ids[0]!),
        mimeType: "image/png",
      },
      filename: "shot.png",
      status: "ready",
      metadata: {
        attachmentId: ids[0],
        filename: "shot.png",
        width: 1280,
        height: 720,
      },
    } as unknown as Attachment;
    const content = toMessageContent("看图", [attachment]);
    expect(content).toEqual([
      { type: "text", text: "看图" },
      {
        type: "image",
        source: { type: "url", value: attachmentUrl(ids[0]!) },
        metadata: {
          attachmentId: ids[0],
          filename: "shot.png",
          width: 1280,
          height: 720,
        },
      },
    ]);
  });
});

describe("接口读回来的那一份（刷新以后）", () => {
  test("历史接口里的图片 part 原样留下，宽高也在", async () => {
    const original = globalThis.fetch;
    const turn = {
      id: "u-1",
      role: "user",
      content: [
        { type: "text", text: "两张" },
        imagePart(ids[0]!),
        imagePart(ids[1]!, 300, 900),
      ],
    };
    globalThis.fetch = (async () =>
      Response.json({ messages: [turn] })) as unknown as typeof fetch;
    try {
      const { messages, unreadable } = await readThreadMessages(
        "thread-images",
        "general-assistant",
      );
      expect(unreadable).toBe(0);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toEqual(turn.content as never);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("气泡里的样子", () => {
  test("单图：加载前就按宽高留好框", () => {
    const { container } = renderTranscript([
      userTurn("u-1", [imagePart(ids[0]!)]),
    ]);
    const img = container.querySelector(
      ".rp-image-single img",
    ) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(attachmentUrl(ids[0]!));
    expect(img.style.width).toBe("318px");
    expect(img.style.aspectRatio.replace(/\s/g, "")).toBe("640/480");
  });

  test("多图：画成一摞，每张一个按钮，点开看的是原图", () => {
    const { container, getByRole, getByLabelText } = renderTranscript([
      userTurn("u-2", [
        imagePart(ids[0]!),
        imagePart(ids[1]!),
        imagePart(ids[2]!),
      ]),
    ]);
    const pile = getByRole("group", { name: "3 张图片" });
    expect(pile.classList.contains("rp-pile")).toBe(true);
    const cards = container.querySelectorAll(".rp-pile-card");
    expect(cards).toHaveLength(3);
    expect(
      Array.from(cards).map((card) =>
        card.querySelector("img")?.getAttribute("src"),
      ),
    ).toEqual(ids.slice(0, 3).map((id) => attachmentUrl(id)));

    fireEvent.click(getByLabelText("查看第 2 张图片（共 3 张）"));
    const dialog = getByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      attachmentUrl(ids[1]!),
    );
  });

  test("超过四张：只摆四张，最后一张标出还有几张", () => {
    const { container, getByRole } = renderTranscript([
      userTurn(
        "u-3",
        ids.map((id) => imagePart(id)),
      ),
    ]);
    expect(getByRole("group", { name: "5 张图片" })).toBeTruthy();
    expect(container.querySelectorAll(".rp-pile-card")).toHaveLength(4);
    expect(container.querySelector(".rp-pile-more")?.textContent).toBe("+1");
  });
});
