import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import { ImagePile, rememberedImageSize } from "@/components/rich-previews/rich-previews";
import { readImageDims } from "@/lib/image-dims";
import { settleReactWork } from "./settle-react-work";

/**
 * 图片宽高（DESIGN.md §83.2）：服务器把宽高写进消息 part 的 metadata / 工具结果的文件清单 / 链接预览，
 * 网页第一次画这张图就先按比例留框，加载完不再把下面的消息推开。
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3000/" });
});
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

describe("readImageDims", () => {
  test("positive integers only", () => {
    expect(readImageDims(640, 480)).toEqual({ width: 640, height: 480 });
    expect(readImageDims(0, 480)).toBeUndefined();
    expect(readImageDims("640", 480)).toBeUndefined();
    expect(readImageDims(640.5, 480)).toBeUndefined();
    expect(readImageDims(undefined, undefined)).toBeUndefined();
  });
});

describe("toVisibleChatItems carries width/height off part metadata", () => {
  const id = "5245264d-dfdd-4590-88c9-7d3b21ccc0aa";
  const message = (metadata: unknown): Message =>
    ({
      id: "u1",
      role: "user",
      content: [{ type: "image", source: { type: "url", value: `/api/attachments/${id}` }, metadata }],
    }) as unknown as Message;

  test("valid dims ride along", () => {
    const [item] = toVisibleChatItems([message({ attachmentId: id, filename: "a.png", width: 640, height: 480 })]);
    expect(item).toMatchObject({ kind: "attachments", attachments: [{ attachmentId: id, filename: "a.png", width: 640, height: 480 }] });
  });
  test("bad or missing dims are dropped, the rest still draws", () => {
    const [bad] = toVisibleChatItems([message({ attachmentId: id, width: "640", height: -1 })]);
    const attachment = (bad as unknown as { attachments: Record<string, unknown>[] }).attachments[0]!;
    expect(attachment.attachmentId).toBe(id);
    expect("width" in attachment).toBe(false);
  });
});

describe("ImagePile reserves the box from given dims before the image loads", () => {
  test("single image: width capped to 318 px and aspect-ratio set", () => {
    const src = "/api/attachments/11111111-1111-1111-1111-111111111111";
    const { container } = render(<ImagePile images={[{ src, width: 640, height: 480 }]} />);
    const img = container.querySelector("img")!;
    expect(img.style.width).toBe("318px");
    expect(img.style.aspectRatio.replace(/\s/g, "")).toBe("640/480");
    // 也记进页面内的尺寸表：同一张图别处再画（正文里的 markdown 图）也能留框。
    expect(rememberedImageSize(src)).toEqual({ width: 640, height: 480 });
  });
  test("tall image: height cap decides the width", () => {
    const { container } = render(<ImagePile images={[{ src: "/api/chat-files/x-tall", width: 1000, height: 3000 }]} />);
    expect(container.querySelector("img")!.style.width).toBe("100px");
  });
  test("no dims and never seen: a fixed placeholder box until it loads (#399 rework)", () => {
    const { container } = render(<ImagePile images={[{ src: "/api/chat-files/never-seen" }]} />);
    const img = container.querySelector("img")!;
    expect(img.style.width).toBe("240px");
    expect(img.style.aspectRatio.replace(/\s/g, "")).toBe("4/3");
  });
});
