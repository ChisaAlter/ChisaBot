import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { LinkCard, LinkCardStack } from "@/components/rich-previews/link-card";
import {
  forgetRememberedPreviews,
  type LinkPreviewData,
  previewClient,
  rememberedPreview,
} from "@/components/rich-previews/link-preview-query";
import { CHISABOT_QUOTE_EVENT } from "@/lib/chat/quote-event";
import { mergeLinkFields } from "@/lib/rich-previews/link-fields";
import { settleReactWork } from "./settle-react-work";

/** 审查模块 6（链接卡）的前端项：追问按钮结构、小图不裁、刷新不跳、favicon 懒加载、calt、视频角标。 */

const css = readFileSync(
  new URL("../src/components/rich-previews/link-card.css", import.meta.url),
  "utf8",
);
/** 某个选择器所在那条规则的声明（只认整条选择器列表里有它的）。 */
function rulesFor(selector: string, source = css): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2]!);
  }
  return out;
}
/** 某个 @media 块的内容（只到第一层花括号配平）。 */
function mediaBlock(query: string): string {
  const at = css.indexOf(`@media ${query} {`);
  expect(at).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  return "";
}

const realFetch = globalThis.fetch;
const previews: Record<string, Partial<LinkPreviewData>> = {};
let seq = 0;
const preview = (url: string, extra: Partial<LinkPreviewData>) => {
  previews[url] = extra;
  return url;
};

describe("审查模块 6", () => {
  beforeAll(() => {
    if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://x").searchParams.get("url")!;
      const hit = previews[url];
      if (!hit)
        return new Response(JSON.stringify({ error: "x" }), { status: 422 });
      return new Response(
        JSON.stringify({
          preview: {
            url,
            finalUrl: url,
            title: "预览标题",
            siteName: "Example",
            domain: new URL(url).hostname,
            description: null,
            image: null,
            imageKind: "none",
            imagePending: false,
            favicon: null,
            ...hit,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });
  afterEach(async () => {
    cleanup();
    await settleReactWork();
    previewClient.clear();
    sessionStorage.clear();
    forgetRememberedPreviews();
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  describe("1. 「追问」不嵌在链接里，看不见时点不到", () => {
    test("按钮是 <a> 的兄弟；<a> 里没有别的可交互元素", async () => {
      const view = render(
        <LinkCard title="甲" url={`https://a${++seq}.example.com/`} />,
      );
      const card = await view.findByTestId("link-card");
      expect(card.tagName).toBe("A");
      expect(card.querySelector("a, button, input, [tabindex]")).toBeNull();
      const btn = view.getByTestId("card-followup-btn");
      expect(card.contains(btn)).toBe(false);
      expect(btn.parentElement).toBe(card.parentElement);
      expect(btn.parentElement!.classList.contains("lc-item")).toBe(true);
    });

    test("点追问只加引用、不触发链接；点卡片照常是链接", async () => {
      const quotes: unknown[] = [];
      const onQuote = (e: Event) => quotes.push((e as CustomEvent).detail);
      window.addEventListener(CHISABOT_QUOTE_EVENT, onQuote);
      const view = render(
        <LinkCard title="乙" url={`https://b${++seq}.example.com/`} />,
      );
      const card = await view.findByTestId("link-card");
      let linkClicks = 0;
      card.addEventListener("click", (e) => {
        linkClicks++;
        e.preventDefault();
      });
      fireEvent.click(view.getByTestId("card-followup-btn"));
      expect(linkClicks).toBe(0);
      fireEvent.click(card);
      expect(linkClicks).toBe(1);
      window.removeEventListener(CHISABOT_QUOTE_EVENT, onQuote);
      expect(quotes).toHaveLength(1);
    });

    test("CSS：默认透明且 pointer-events: none；显示时才 auto；悬停显示只给真鼠标；触屏明确显示", () => {
      const base = rulesFor(".lc-followup").join("\n");
      expect(rulesFor(".lc-go").some((r) => /opacity: 0;/.test(r))).toBe(true);
      const shared = css.match(/\.lc-go,\s*\.lc-followup \{([^}]*)\}/)![1]!;
      expect(shared).toMatch(/opacity: 0;/);
      expect(shared).toMatch(/pointer-events: none;/);
      expect(base).not.toMatch(/pointer-events: auto/);
      // 每一条把它变得可见（opacity: 1）的规则都同时打开 pointer-events，反过来也一样。
      for (const m of css.matchAll(
        /([^{}]*\.lc-followup[^{}]*)\{([^{}]*)\}/g,
      )) {
        const body = m[2]!;
        if (/opacity: 1;/.test(body))
          expect(body).toMatch(/pointer-events: auto;/);
        if (/pointer-events: auto;/.test(body))
          expect(body).toMatch(/opacity: 1;/);
      }
      expect(css).not.toMatch(/@media \(hover: hover\) \{/);
      expect(mediaBlock("(hover: hover) and (pointer: fine)")).toMatch(
        /\.lc-item:not\(\[data-stack-slot\]\):hover :is\(\.lc-go, \.lc-followup\)/,
      );
      const touch = mediaBlock("(hover: none), (any-pointer: coarse)");
      expect(touch).toMatch(
        /\.lc-item:not\(\[data-stack-slot\]\) > \.lc-followup \{\s*opacity: 1;\s*transform: none;\s*pointer-events: auto;/,
      );
      // 窄容器里一叠的「追问」去掉（手机上一叠只剩换主位和打开两件事）。
      expect(css).toMatch(
        /@container \(max-width: 420px\) \{[\s\S]*?\.lc-stack\[data-deck\] \.lc-followup \{\s*display: none;/,
      );
    });

    test("触屏一叠：第一下挪到主位不打开，第二下才打开；点不到别的卡的追问", async () => {
      const urls = [1, 2, 3].map((n) => `https://d${seq}-${n}.example.com/`);
      seq++;
      const view = render(
        <LinkCardStack
          items={urls.map((url, i) => ({ url, title: `卡${i}` }))}
        />,
      );
      const cards = await view.findAllByTestId("link-card");
      const item = (c: HTMLElement) => c.closest<HTMLElement>(".lc-item")!;
      const tap = (el: HTMLElement) => {
        fireEvent.pointerDown(el, { pointerType: "touch" });
        // fireEvent.click 返回「没被 preventDefault」= 浏览器会跟着打开链接。
        return fireEvent.click(el);
      };
      expect(tap(cards[0]!)).toBe(false);
      expect(item(cards[0]!).getAttribute("data-stack-slot")).toBe("main");
      expect(tap(cards[0]!)).toBe(true);
      const hidden =
        ".lc-stack[data-deck] .lc-item:not([data-primary]) :is(.lc-go, .lc-followup)";
      const buttons = cards.map((c) => item(c).querySelector(".lc-followup")!);
      expect(buttons.map((b) => b.matches(hidden))).toEqual([
        false,
        true,
        true,
      ]);
    });
  });

  describe("2. 小图不放大、不裁", () => {
    test("服务器给的宽度比卡窄（172×178）：contain，不放大", async () => {
      const url = preview(`https://s${++seq}.example.com/`, {
        image: "https://s.example.com/Example.jpg",
        imageKind: "og",
        imageWidth: 172,
        imageHeight: 178,
      });
      const view = render(<LinkCard url={url} />);
      await waitFor(() =>
        expect(view.container.querySelector(".lc-media img")).not.toBeNull(),
      );
      const media = view.container.querySelector<HTMLElement>(".lc-media")!;
      expect(media.getAttribute("data-fit")).toBe("contain");
    });

    test("大图照旧按真实比例铺满（不是 contain）", async () => {
      const url = preview(`https://l${++seq}.example.com/`, {
        image: "https://l.example.com/og.png",
        imageKind: "og",
        imageWidth: 1200,
        imageHeight: 630,
      });
      const view = render(<LinkCard url={url} />);
      await waitFor(() =>
        expect(view.container.querySelector(".lc-media img")).not.toBeNull(),
      );
      expect(
        view.container.querySelector(".lc-media")!.hasAttribute("data-fit"),
      ).toBe(false);
    });

    test("没给宽高的：加载出来发现比卡窄，也换成 contain", async () => {
      const view = render(
        <LinkCard
          image="https://n.example.com/tiny.png"
          title="小"
          url={`https://n${++seq}.example.com/`}
        />,
      );
      const img = await waitFor(() => {
        const el =
          view.container.querySelector<HTMLImageElement>(".lc-media img");
        expect(el).not.toBeNull();
        return el!;
      });
      Object.defineProperty(img, "naturalWidth", { value: 172 });
      Object.defineProperty(img, "naturalHeight", { value: 90 });
      fireEvent.load(img);
      await waitFor(() =>
        expect(
          view.container.querySelector(".lc-media")!.getAttribute("data-fit"),
        ).toBe("contain"),
      );
    });

    test("CSS：contain 时宽高 auto、最大 100%、居中，不会大于原始尺寸；衬底是 .lc-media 的主题色", () => {
      const rule = rulesFor('.lc-media[data-fit="contain"] > img').join("\n");
      expect(rule).toMatch(/width: auto;/);
      expect(rule).toMatch(/height: auto;/);
      expect(rule).toMatch(/max-width: 100%;/);
      expect(rule).toMatch(/max-height: 100%;/);
      expect(rule).toMatch(/margin: auto;/);
      expect(rule).toMatch(/object-fit: contain;/);
      expect(rulesFor(".lc-media").join("\n")).toMatch(
        /background: color-mix\(in srgb, var\(--text\)/,
      );
    });
  });

  describe("3. 刷新后不跳：这个标签页取到过的预览同步画出真卡", () => {
    test("取到过一次 → 存进 sessionStorage；刷新（清掉内存缓存）后第一帧就是真卡，不是骨架", async () => {
      const url = preview(`https://r${++seq}.example.com/`, { title: "仓库" });
      const first = render(<LinkCard url={url} />);
      await waitFor(() =>
        expect(first.getByTestId("link-card").textContent).toContain("仓库"),
      );
      cleanup();
      previewClient.clear();
      forgetRememberedPreviews();
      expect(rememberedPreview(url).initialData?.title).toBe("仓库");
      const again = render(<LinkCard url={url} />);
      expect(again.queryByTestId("link-card-skeleton")).toBeNull();
      expect(again.getByTestId("link-card").textContent).toContain("仓库");
    });

    test("图还在路上的不存；没取到过的照旧先放骨架", async () => {
      const url = preview(`https://p${++seq}.example.com/`, {
        imagePending: true,
      });
      const view = render(<LinkCard url={url} />);
      expect(view.getByTestId("link-card-skeleton")).toBeTruthy();
      await waitFor(() =>
        expect(view.queryByTestId("link-card")).not.toBeNull(),
      );
      forgetRememberedPreviews();
      expect(rememberedPreview(url)).toEqual({});
    });
  });

  test("4. favicon 懒加载、异步解码、写明宽高", async () => {
    const url = preview(`https://f${++seq}.example.com/`, {
      favicon: "https://f.example.com/favicon.ico",
    });
    const view = render(<LinkCard url={url} />);
    const icon = await waitFor(() => {
      const el =
        view.container.querySelector<HTMLImageElement>(".lc-badge img");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(icon.getAttribute("loading")).toBe("lazy");
    expect(icon.getAttribute("decoding")).toBe("async");
    expect(icon.getAttribute("width")).toBe("28");
    expect(icon.getAttribute("height")).toBe("28");
  });

  test("5. 网址 / 编号不做 Inter 的上下文替换（411x7 不变成 411×7）", () => {
    expect(rulesFor(".lc-card").join("\n")).toMatch(
      /font-feature-settings: "calt" 0;/,
    );
    const transcript = readFileSync(
      new URL(
        "../src/components/channels/chat-transcript.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(transcript).toContain(
      `<span className="whitespace-pre-wrap [font-feature-settings:'calt'_0]">`,
    );
  });

  describe('6. 视频角标（服务器以后给 kind: "video"，前端可有可无）', () => {
    test("kind=video：图上叠播放角标，aria-hidden；不是视频就没有", async () => {
      const v = preview(`https://v${++seq}.example.com/`, {
        kind: "video",
        thumbnail: "https://v.example.com/thumb.jpg",
      });
      const view = render(<LinkCard url={v} />);
      const play = await view.findByTestId("link-card-play");
      expect(play.getAttribute("aria-hidden")).toBe("true");
      expect(play.closest(".lc-media")).not.toBeNull();
      expect(view.getByTestId("link-card").getAttribute("data-kind")).toBe(
        "video",
      );
      // 没有 og:image 时缩略图当预览图。
      expect(
        view.container
          .querySelector<HTMLImageElement>(".lc-media img")!
          .getAttribute("src"),
      ).toBe("https://v.example.com/thumb.jpg");
      cleanup();
      const plain = preview(`https://w${++seq}.example.com/`, {
        image: "https://w.example.com/og.png",
        imageKind: "og",
      });
      const other = render(<LinkCard url={plain} />);
      await waitFor(() =>
        expect(other.container.querySelector(".lc-media img")).not.toBeNull(),
      );
      expect(other.queryByTestId("link-card-play")).toBeNull();
    });

    test('字段合并：只认 "video"，别的值当没有', () => {
      const base = { title: "t", domain: "x.example.com", imageKind: "none" };
      expect(
        mergeLinkFields(
          "https://x.example.com/",
          {},
          { ...base, kind: "video" },
        ).kind,
      ).toBe("video");
      expect(
        mergeLinkFields("https://x.example.com/", {}, { ...base, kind: "live" })
          .kind,
      ).toBeNull();
      expect(
        mergeLinkFields("https://x.example.com/", {}, base).kind,
      ).toBeNull();
    });

    test("CSS：角标不模糊、不接事件", () => {
      const rule = rulesFor(".lc-play").join("\n");
      expect(rule).toMatch(/pointer-events: none;/);
      expect(rule).not.toMatch(/filter/);
      expect(css).not.toMatch(/(backdrop-)?filter\s*:/);
    });
  });
});
