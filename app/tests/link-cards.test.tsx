import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MessageRichPreviews, RichBotStreamdown } from "@/components/rich-previews/rich-previews";

/** 链接卡（DESIGN.md §48）：卡片内容、兜底卡、骨架；正文里出卡的行被拿掉。 */

const preview = (over: Record<string, unknown>) => ({
  preview: {
    url: "",
    finalUrl: "",
    title: "",
    siteName: "",
    domain: "",
    description: "",
    image: null,
    imageKind: "none",
    imagePending: false,
    favicon: null,
    ...over,
  },
});

const realFetch = globalThis.fetch;
let responses: Record<string, { status: number; body: unknown }> = {};
let requested: string[] = [];

describe("链接卡", () => {
  beforeAll(() => {
    // bot-message-list.test.tsx registers at import and never unregisters; file order varies by runner.
    if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const href = String(input);
      const url = decodeURIComponent(href.split("url=")[1] ?? "");
      requested.push(url);
      const hit = responses[url] ?? { status: 422, body: { error: "x" } };
      return new Response(JSON.stringify(hit.body), {
        status: hit.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });
  afterEach(() => {
    cleanup();
    responses = {};
    requested = [];
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    GlobalRegistrator.unregister();
  });

  test("标题、域名、标签；整张是新窗口打开的链接", async () => {
    const url = "https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.7";
    responses[url] = {
      status: 200,
      body: preview({ url, finalUrl: url, title: "Release v0.1.7", domain: "github.com", favicon: "/api/link-preview/asset/aa" }),
    };
    const view = render(<MessageRichPreviews text={`好了：\n[下载 0.1.7](${url})`} />);
    const card = await view.findByTestId("link-card");
    expect(card.getAttribute("href")).toBe(url);
    expect(card.getAttribute("target")).toBe("_blank");
    expect(card.getAttribute("rel")).toContain("noopener");
    expect(card.textContent).toContain("Release v0.1.7");
    expect(card.textContent).toContain("github.com");
    expect(card.querySelector(".rp-link-label")?.textContent).toBe("下载 0.1.7");
    // 没有 og 图：方块里是站点图标（happy-dom 里图片加载失败会退回地球图标），不是缩略图。
    expect(card.querySelector(".rp-link-tile")?.getAttribute("data-kind")).not.toBe("image");
  });

  test("取不到预览（422）也出兜底卡：标题是域名、第二行是短地址，照样能点", async () => {
    const view = render(<MessageRichPreviews text={"https://blocked.example.com/a/b"} />);
    const card = await view.findByTestId("link-card");
    expect(card.hasAttribute("data-degraded")).toBe(true);
    expect(card.querySelector(".rp-link-title")?.textContent).toBe("blocked.example.com");
    expect(card.querySelector(".rp-link-domain")?.textContent).toBe("blocked.example.com/a/b");
    expect(card.getAttribute("href")).toBe("https://blocked.example.com/a/b");
  });

  test("句子里的链接不出卡、不去取预览", async () => {
    const view = render(<MessageRichPreviews text={"来源：[新华网](https://news.cn/x) 和 https://a.cn/b。"} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(view.queryByTestId("link-cards")).toBeNull();
    expect(requested).toEqual([]);
  });

  test("取的时候是同尺寸骨架", async () => {
    const view = render(<MessageRichPreviews text={"https://slow.example.com"} />);
    expect(view.getByTestId("link-card-skeleton")).toBeTruthy();
    await view.findByTestId("link-card");
  });

  test("正文：出卡的那一行拿掉", async () => {
    const view = render(
      <RichBotStreamdown components={{}} text={"看这里：\n\nhttps://example.com/page\n\n结束。"} />,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(view.container.textContent).toContain("看这里");
    expect(view.container.textContent).toContain("结束");
    expect(view.container.textContent).not.toContain("example.com/page");
  });

  test("多卡扇形牌组：悬停某张卡片时该卡聚焦置顶（data-focused），其余卡片背景虚化（data-dimmed）", async () => {
    const u1 = "https://a.example.com/1";
    const u2 = "https://b.example.com/2";
    responses[u1] = { status: 200, body: preview({ url: u1, finalUrl: u1, title: "Card A", domain: "a.example.com" }) };
    responses[u2] = { status: 200, body: preview({ url: u2, finalUrl: u2, title: "Card B", domain: "b.example.com" }) };
    const view = render(<MessageRichPreviews text={`${u1}\n${u2}`} />);
    const cards = await view.findAllByTestId("link-card");
    expect(cards.length).toBe(2);
    const deck = view.getByTestId("link-cards");
    expect(deck.hasAttribute("data-deck")).toBe(true);
    fireEvent.mouseEnter(cards[0]!);
    expect(cards[0]!.hasAttribute("data-focused")).toBe(true);
    expect(cards[1]!.hasAttribute("data-dimmed")).toBe(true);
    fireEvent.mouseLeave(cards[0]!);
    expect(cards[0]!.hasAttribute("data-focused")).toBe(false);
    expect(cards[1]!.hasAttribute("data-dimmed")).toBe(false);
  });
});
