import { describe, expect, test } from "bun:test";
import {
  isWeakLinkTitle,
  mergeLinkFields,
  needsLinkPreview,
} from "@/lib/rich-previews/link-fields";

/** 链接卡字段合并（2026-10-29，Hark 式链接卡；#380 小爱审查补了标题选择和「站点 · 补充信息」）。 */

const GH = "https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.13";
const ghPreview = {
  title: "Release ChisaBot v0.1.13 · ChisaAlter/ChisaBot",
  siteName: "GitHub",
  domain: "github.com",
  description: "Android 0.1.13",
  image: "/api/link-preview/asset/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  imageKind: "og",
  favicon: "/api/link-preview/asset/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  imageWidth: 1200,
  imageHeight: 600,
};
const REPO = "https://github.com/ChisaAlter/ChisaBot";
const repoPreview = {
  ...ghPreview,
  title: "GitHub - ChisaAlter/ChisaBot: 自托管的 AI 助手",
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
      { title: "安卓原生客户端发布", meta: "v0.1.13" },
      ghPreview,
    );
    expect(merged.title).toBe("安卓原生客户端发布");
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

describe("标题选择：模型的标题只是站点名 / 域名，或被 og:title 包含，就改用 og:title", () => {
  test("等于站点名（忽略大小写和首尾空白）", () => {
    for (const title of ["GitHub", "github", "  GITHUB  ", "\tGitHub\n"]) {
      const merged = mergeLinkFields(GH, { title }, ghPreview);
      expect(merged.title).toBe(ghPreview.title);
      expect(merged.site).toBe("GitHub");
    }
  });

  test("等于域名（带不带 www.、只写主名都算）", () => {
    for (const title of ["github.com", "WWW.GitHub.com", "Github"]) {
      expect(
        mergeLinkFields(
          "https://www.github.com/ChisaAlter/ChisaBot",
          { title },
          { ...repoPreview, siteName: "" },
        ).title,
      ).toBe(repoPreview.title);
    }
  });

  test("被 og:title 包含：「ChisaBot」「chisaalter/chisabot」都换成 og:title", () => {
    expect(
      mergeLinkFields(REPO, { title: "ChisaBot" }, repoPreview).title,
    ).toBe(repoPreview.title);
    expect(
      mergeLinkFields(REPO, { title: " chisaalter/chisabot " }, repoPreview)
        .title,
    ).toBe(repoPreview.title);
    expect(
      mergeLinkFields(GH, { title: "ChisaBot v0.1.13" }, ghPreview).title,
    ).toBe(ghPreview.title);
  });

  test("模型的标题比 og:title 多信息（不被包含）就留着；和 og:title 一样也留着", () => {
    expect(
      mergeLinkFields(REPO, { title: "ChisaBot 仓库主页" }, repoPreview).title,
    ).toBe("ChisaBot 仓库主页");
    expect(
      mergeLinkFields(
        REPO,
        { title: repoPreview.title.toUpperCase() },
        repoPreview,
      ).title,
    ).toBe(repoPreview.title.toUpperCase());
  });

  test("没有 og:title 或预览降级时不换（没有更好的可用）", () => {
    expect(
      mergeLinkFields(REPO, { title: "GitHub" }, { ...repoPreview, title: "" })
        .title,
    ).toBe("GitHub");
    expect(
      mergeLinkFields(
        REPO,
        { title: "ChisaBot" },
        {
          ...repoPreview,
          degraded: true,
        },
      ).title,
    ).toBe("ChisaBot");
    expect(mergeLinkFields(REPO, { title: "GitHub" }, null).title).toBe(
      "GitHub",
    );
  });

  test("isWeakLinkTitle 单独看", () => {
    expect(isWeakLinkTitle("GitHub", "Release X", ["GitHub"])).toBe(true);
    expect(isWeakLinkTitle("x", "Release X", [])).toBe(true);
    expect(isWeakLinkTitle("Release X", "release x", [])).toBe(false);
    expect(isWeakLinkTitle("别的", "Release X", ["GitHub"])).toBe(false);
    expect(isWeakLinkTitle("", "Release X", ["GitHub"])).toBe(false);
  });
});

describe("补充信息那一行：「站点 · 补充信息」", () => {
  test("Hark 那张：og:title 做标题，下面「GitHub · v0.1.13」", () => {
    const merged = mergeLinkFields(GH, { meta: "v0.1.13" }, ghPreview);
    expect(merged.title).toBe(ghPreview.title);
    expect(`${merged.site} · ${merged.extra}`).toBe("GitHub · v0.1.13");
  });

  test("没给 meta 时用模型写的一句话（description）；meta 优先", () => {
    expect(
      mergeLinkFields(
        REPO,
        { title: "ChisaBot", description: "代码仓库" },
        repoPreview,
      ).extra,
    ).toBe("代码仓库");
    expect(
      mergeLinkFields(
        REPO,
        { title: "ChisaBot", meta: "主分支", description: "代码仓库" },
        repoPreview,
      ).extra,
    ).toBe("主分支");
  });

  test("补充信息和站点名或标题一样就不显示，只剩站点", () => {
    expect(
      mergeLinkFields(GH, { meta: " github " }, ghPreview).extra,
    ).toBeNull();
    expect(
      mergeLinkFields(GH, { description: ghPreview.title }, ghPreview).extra,
    ).toBeNull();
    expect(mergeLinkFields(GH, {}, ghPreview).extra).toBeNull();
  });
});
