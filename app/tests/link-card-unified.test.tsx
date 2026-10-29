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
import {
  mergeLinkFields,
  needsLinkPreview,
} from "@/lib/rich-previews/link-fields";
import { settleReactWork } from "./settle-react-work";

/** Hark 式链接卡（2026-10-29）：字段合并优先级、有图 / 无图两种卡、骨架和卡片同尺寸。 */

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

describe("mergeLinkFields：给的字段优先，缺的用预览补", () => {
  test("模型什么都没给：标题、图、站点名全来自预览", () => {
    const merged = mergeLinkFields(GH, {}, ghPreview);
    expect(merged.title).toBe(ghPreview.title);
    expect(merged.image).toBe(ghPreview.image);
    expect(merged.imageFallback).toBeNull();
    expect(merged.site).toBe("GitHub");
    expect(merged.extra).toBeNull();
    expect(merged.imageWidth).toBe(1200);
    expect(merged.imageHeight).toBe(600);
  });

  test("模型给了标题和补充信息：用模型的；缺的图和站点名用预览的", () => {
    const merged = mergeLinkFields(
      GH,
      { title: "ChisaBot v0.1.13", meta: "v0.1.13" },
      ghPreview,
    );
    expect(merged.title).toBe("ChisaBot v0.1.13");
    expect(merged.image).toBe(ghPreview.image);
    expect(merged.site).toBe("GitHub");
    expect(merged.extra).toBe("v0.1.13");
  });

  test("模型给了 https 图：先用模型的图，失败再换预览图；宽高只跟预览图走", () => {
    const merged = mergeLinkFields(
      GH,
      { image: "https://cdn.example.com/a.png" },
      ghPreview,
    );
    expect(merged.image).toBe("https://cdn.example.com/a.png");
    expect(merged.imageFallback).toBe(ghPreview.image);
    expect(merged.imageWidth).toBeNull();
  });

  test("模型给的图不是 https：不用，退到预览图", () => {
    expect(
      mergeLinkFields(GH, { image: "http://x.example.com/a.png" }, ghPreview)
        .image,
    ).toBe(ghPreview.image);
    expect(
      mergeLinkFields(GH, { image: "javascript:alert(1)" }, ghPreview).image,
    ).toBe(ghPreview.image);
  });

  test("模型给的站点名优先；补充信息和站点名一样时不重复", () => {
    expect(mergeLinkFields(GH, { siteName: "GH" }, ghPreview).site).toBe("GH");
    expect(mergeLinkFields(GH, { meta: "github" }, ghPreview).extra).toBeNull();
  });

  test("没有预览：标题退到域名，站点那一格换成短地址", () => {
    const merged = mergeLinkFields("https://www.example.com/a/b", {}, null);
    expect(merged.title).toBe("example.com");
    expect(merged.site).toBe("example.com/a/b");
    expect(merged.image).toBeNull();
  });

  test("预览说没有图（imageKind none）就没有图", () => {
    expect(
      mergeLinkFields(GH, {}, { ...ghPreview, imageKind: "none" }).image,
    ).toBeNull();
  });

  test("标题、图、站点名都给了才不去问预览", () => {
    expect(
      needsLinkPreview({ title: "a", image: "https://a.example.com/x.png" }),
    ).toBe(true);
    expect(
      needsLinkPreview({
        title: "a",
        image: "https://a.example.com/x.png",
        siteName: "A",
      }),
    ).toBe(false);
    expect(
      needsLinkPreview({
        title: "a",
        image: "http://a.example.com/x.png",
        siteName: "A",
      }),
    ).toBe(true);
  });
});

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

  test("没有图：同宽的紧凑横卡，没有大图框", async () => {
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
    expect(card.getAttribute("data-layout")).toBe("compact");
    expect(card.querySelector(".lc-media")).toBeNull();
    expect(card.querySelector(".lc-badge")).not.toBeNull();
    expect(card.querySelector(".lc-site")?.textContent).toBe(
      "plain.example.com",
    );
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

  test("骨架和有图的卡同一个尺寸：同样的布局、同样的图片预留比例、标题固定两行高", async () => {
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

    // 尺寸写在样式里：卡片定宽、标题两行定高、站点行定高；不用 backdrop-filter。
    const css = readFileSync(
      new URL("../src/components/rich-previews/link-card.css", import.meta.url),
      "utf8",
    );
    expect(css).toContain("width: min(280px, 100%)");
    expect(css).toMatch(
      /\.lc-card\[data-layout="image"\] \.lc-title \{\s*height: 40px;\s*\}/,
    );
    expect(css).toMatch(/\.lc-meta \{[^}]*height: 18px;/);
    expect(css).not.toMatch(/backdrop-filter\s*:/);
  });
});
