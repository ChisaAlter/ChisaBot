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
import { cleanup, render } from "@testing-library/react";
import {
  LINK_CARD_IMAGE_RATIO,
  LinkCard,
  LinkCardSkeleton,
} from "@/components/rich-previews/link-card";
import { settleReactWork } from "./settle-react-work";

/** Hark 式链接卡（2026-10-29）：有图 / 无图两种卡、骨架和卡片图区同尺寸。字段合并见 link-fields.test.ts。 */

const GH = "https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.13";
const ghPreview = {
  url: GH,
  finalUrl: GH,
  title: "Release ChisaBot v0.1.13 · ChisaAlter/ChisaBot",
  siteName: "GitHub",
  domain: "github.com",
  description: "Android 0.1.13",
  image: "/api/link-preview/asset/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  imageKind: "og",
  imagePending: false,
  favicon: "/api/link-preview/asset/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  imageWidth: 1200,
  imageHeight: 600,
};

const realFetch = globalThis.fetch;
let responses: Record<string, unknown> = {};
let requested: string[] = [];

describe("LinkCard", () => {
  beforeAll(() => {
    if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
    // 转存图是 /api/… 相对地址：about:blank 下解析不出来，happy-dom 会当坏图触发 error，所以给页面一个地址。
    (
      window as unknown as { happyDOM?: { setURL(url: string): void } }
    ).happyDOM?.setURL("http://localhost/");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input).split("url=")[1] ?? "");
      requested.push(url);
      const hit = responses[url];
      return new Response(
        JSON.stringify(hit ? { preview: hit } : { error: "x" }),
        {
          status: hit ? 200 : 422,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
  });
  afterEach(() => {
    cleanup();
    responses = {};
    requested = [];
  });
  afterAll(async () => {
    await settleReactWork();
    globalThis.fetch = realFetch;
    GlobalRegistrator.unregister();
  });

  test("有图：竖卡，上面是懒加载的大图（宽高预留），下面两行标题和「站点 · 补充信息」", async () => {
    const url = `${GH}?a=1`;
    responses[url] = { ...ghPreview, url, finalUrl: url };
    const view = render(<LinkCard meta="v0.1.13" url={url} />);
    const card = await view.findByTestId("link-card");
    expect(card.getAttribute("data-layout")).toBe("image");
    const img = card.querySelector<HTMLImageElement>(".lc-media > img");
    expect(img?.getAttribute("src")).toBe(ghPreview.image);
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("width")).toBe("1200");
    expect(img?.getAttribute("height")).toBe("600");
    expect(card.querySelector(".lc-title")?.textContent).toBe(ghPreview.title);
    expect(card.querySelector(".lc-site")?.textContent).toBe(
      "GitHub · v0.1.13",
    );
    expect(card.getAttribute("href")).toBe(url);
    expect(card.getAttribute("target")).toBe("_blank");
  });

  test("没有图：仍是竖版大卡，图区是横幅（站点渐变 + 首字，不写域名），标题固定两行", async () => {
    const url = "https://plain.example.com/";
    responses[url] = {
      ...ghPreview,
      url,
      finalUrl: url,
      title: "Plain",
      siteName: "",
      domain: "plain.example.com",
      image: null,
      imageKind: "none",
    };
    const view = render(<LinkCard url={url} />);
    const card = await view.findByTestId("link-card");
    expect(card.getAttribute("data-layout")).toBe("image");
    const media = card.querySelector<HTMLElement>(".lc-media");
    expect(media?.style.aspectRatio).toBe(LINK_CARD_IMAGE_RATIO);
    const banner = card.querySelector<HTMLElement>(
      "[data-testid=link-card-banner]",
    );
    expect(banner).not.toBeNull();
    expect(banner?.style.backgroundImage).toContain("linear-gradient");
    // 横幅上不再写域名（标题下面那行已经有），只留图标或首字。
    expect(banner?.querySelector(".lc-banner-label")).toBeNull();
    expect(banner?.textContent).not.toContain("plain.example.com");
    // 图标是转存图时画图标；这里图标坏不了（happy-dom 不加载），所以图标块在。
    expect(banner?.querySelector(".lc-banner-mark")).not.toBeNull();
    expect(card.querySelector(".lc-media > img")).toBeNull();
    expect(card.querySelector(".lc-site")?.textContent).toBe(
      "plain.example.com",
    );
    // 标题固定两行：CSS 里 .lc-title 两行截断、固定 40px 高（20px 行高 × 2）。
    const css = readFileSync(
      new URL("../src/components/rich-previews/link-card.css", import.meta.url),
      "utf8",
    );
    const rule = /\.lc-title \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("-webkit-line-clamp: 2");
    expect(rule).toContain("height: 40px");
    expect(rule).toContain("line-height: 20px");
    expect(css).not.toContain('data-layout="compact"');
  });

  test("GitHub 仓库：og 图拿不到、预览图是主人头像时画成横幅里的圆头像 + owner/repo，标题去掉「GitHub - 」、星标进补充信息", async () => {
    const url = "https://github.com/ChisaAlter/ChisaBot";
    responses[url] = {
      ...ghPreview,
      url,
      finalUrl: url,
      title: "GitHub - ChisaAlter/ChisaBot: 自托管的 AI 助手",
      description: "自托管的 AI 助手",
      imageKind: "avatar",
      favicon: null,
      stars: 1234,
    };
    const view = render(<LinkCard url={url} />);
    const card = await view.findByTestId("link-card");
    expect(card.getAttribute("data-layout")).toBe("image");
    const banner = card.querySelector("[data-testid=link-card-banner]");
    expect(
      banner?.querySelector(".lc-banner-avatar")?.getAttribute("src"),
    ).toBe(ghPreview.image);
    expect(banner?.querySelector(".lc-banner-label")?.textContent).toBe(
      "ChisaAlter/ChisaBot",
    );
    expect(card.querySelector(".lc-title")?.textContent).toBe(
      "ChisaAlter/ChisaBot: 自托管的 AI 助手",
    );
    expect(card.querySelector(".lc-site")?.textContent).toBe("GitHub · ★ 1.2k");
    expect(view.getByTestId("card-followup-btn")).not.toBeNull();
    expect(card.querySelector(".lc-go")).not.toBeNull();
  });

  test("json-render 的 Link：模型写的标题留着，预览图和站点名用预览补上", async () => {
    const url = `${GH}?b=1`;
    responses[url] = { ...ghPreview, url, finalUrl: url };
    const view = render(<LinkCard title="模型写的标题" url={url} />);
    const card = await view.findByTestId("link-card");
    expect(requested).toEqual([url]);
    expect(card.querySelector(".lc-title")?.textContent).toBe("模型写的标题");
    expect(card.querySelector(".lc-media > img")?.getAttribute("src")).toBe(
      ghPreview.image,
    );
    expect(card.querySelector(".lc-site")?.textContent).toBe("GitHub");
  });

  test("json-render 的 Link：模型标题只是站点名，改用 og:title，模型的一句话放进「站点 · 补充信息」", async () => {
    const url = `${GH}?d=1`;
    responses[url] = { ...ghPreview, url, finalUrl: url };
    const view = render(
      <LinkCard description="新版安卓客户端" title=" github " url={url} />,
    );
    const card = await view.findByTestId("link-card");
    expect(card.querySelector(".lc-title")?.textContent).toBe(ghPreview.title);
    expect(card.querySelector(".lc-site")?.textContent).toBe(
      "GitHub · 新版安卓客户端",
    );
  });

  test("标题、图、站点名都给了：直接出卡，不去问预览", async () => {
    const view = render(
      <LinkCard
        image="https://cdn.example.com/a.png"
        siteName="Example"
        title="全给了"
        url="https://full.example.com/x"
      />,
    );
    const card = view.getByTestId("link-card");
    expect(card.getAttribute("data-layout")).toBe("image");
    await new Promise((r) => setTimeout(r, 20));
    expect(requested).toEqual([]);
  });

  test("骨架和有图的卡图区同一尺寸；标题两行高固定（真卡和骨架一样），站点行只有骨架定高", async () => {
    const url = `${GH}?c=1`;
    responses[url] = { ...ghPreview, url, finalUrl: url };
    const view = render(<LinkCard url={url} />);
    const skeleton = view.getByTestId("link-card-skeleton");
    expect(skeleton.getAttribute("data-layout")).toBe("image");
    const skeletonRatio =
      skeleton.querySelector<HTMLElement>(".lc-media")?.style.aspectRatio;
    const card = await view.findByTestId("link-card");
    expect(card.getAttribute("data-layout")).toBe("image");
    expect(
      card.querySelector<HTMLElement>(".lc-media")?.style.aspectRatio,
    ).toBe(skeletonRatio!);
    expect(skeletonRatio).toBe(LINK_CARD_IMAGE_RATIO);
    expect(card.className).toBe(skeleton.className.replace(" lc-skel", ""));

    const lone = render(<LinkCardSkeleton />).getByTestId("link-card-skeleton");
    expect(lone.querySelector(".lc-title")).not.toBeNull();
    expect(lone.querySelector(".lc-meta")).not.toBeNull();

    // 尺寸写在样式里：卡片定宽；标题固定两行高；站点行的固定高度只在骨架（.lc-skel）里。
    const css = readFileSync(
      new URL("../src/components/rich-previews/link-card.css", import.meta.url),
      "utf8",
    );
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(css).toContain("width: min(280px, 100%)");
    // 标题固定两行高（2026-10-30，§48.5）：真卡和骨架都是 40px，卡片高度不随标题变。
    expect(rule(".lc-title")).toContain("height: 40px;");
    expect(rule(".lc-meta")).not.toMatch(/(^|\s)height:/);
    expect(css).not.toMatch(
      /\.lc-card\[data-layout="image"\] \.lc-title \{[^}]*height:/,
    );
    expect(rule(".lc-skel .lc-title")).toContain("height: 40px;");
    expect(rule(".lc-skel .lc-meta")).toContain("height: 18px;");
    expect(css).not.toMatch(/backdrop-filter\s*:/);
  });
});
