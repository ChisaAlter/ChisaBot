import { describe, expect, test } from "bun:test";
import { domainToASCII } from "node:url";
import { Hono } from "hono";
import type { GuardedResponse } from "../../shared/net/guarded-fetch";
import type { Database } from "../src/db/client";
import { decodeEntities, displayDomain } from "../src/link-preview/parse";
import {
  apiSourceFor,
  createLinkPreviews,
  directImageTitle,
  githubImageFallbacks,
  isChallengePage,
  type LinkPreview,
  type PreviewFetch,
  redactUrl,
} from "../src/link-preview/service";

/**
 * Audit module 6 (server side of link previews): `build` / `previewFor` / the route, run against an
 * in-memory stand-in for the two cache tables and a scripted `fetch`, so nothing leaves the machine
 * and no database is needed. The SSRF-checked `guardedFetch` itself is covered in link-preview.test.ts.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

type Row = { ok: boolean; data: unknown; ttl: string; expiresAt: number };

/** Just enough of `database.$client.unsafe` for the statements service.ts and image-dims issue. */
function fakeDatabase() {
  const previews = new Map<string, Row>();
  const assets = new Map<string, { mime: string; data: Uint8Array }>();
  const ttlMs = (ttl: string) => {
    const [n, unit] = ttl.split(" ") as [string, string];
    return Number(n) * (unit.startsWith("hour") ? 3_600_000 : 60_000);
  };
  const unsafe = async (sql: string, params: unknown[] = []) => {
    if (
      sql.startsWith(
        "SELECT ok, data, expires_at > now() AS fresh FROM chisabot_link_previews",
      )
    ) {
      const row = previews.get(params[0] as string);
      return row
        ? [{ ok: row.ok, data: row.data, fresh: row.expiresAt > Date.now() }]
        : [];
    }
    if (sql.includes("INSERT INTO chisabot_link_previews")) {
      const [key, , ok, data, ttl] = params as [
        string,
        string,
        boolean,
        string,
        string,
      ];
      previews.set(key, {
        ok,
        data: JSON.parse(data),
        ttl,
        expiresAt: Date.now() + ttlMs(ttl),
      });
      return [];
    }
    if (sql.includes("INSERT INTO chisabot_link_preview_assets")) {
      const [id, mime, data] = params as [string, string, Uint8Array];
      assets.set(id, { mime, data });
      return [];
    }
    if (sql.startsWith("UPDATE chisabot_link_preview_assets")) {
      const row = assets.get(params[0] as string);
      return row ? [row] : [];
    }
    return [];
  };
  const database = { $client: { unsafe } } as unknown as Database;
  return { database, previews, assets };
}

type Reply = Partial<Omit<GuardedResponse, "body">> & {
  body?: string | Buffer;
};
type Script = Record<
  string,
  Reply | ((n: number) => Reply | Promise<Reply>) | Error
>;

/** A scripted fetch: exact URL → reply; anything unscripted is a 404. Records every call. */
function fakeFetch(script: Script) {
  const calls: string[] = [];
  const fetch: PreviewFetch = async (url) => {
    calls.push(url);
    const entry = script[url];
    if (entry instanceof Error) throw entry;
    const n = calls.filter((c) => c === url).length;
    const reply: Reply = (typeof entry === "function"
      ? await entry(n)
      : entry) ?? { status: 404, body: "nope" };
    const body =
      typeof reply.body === "string"
        ? Buffer.from(reply.body)
        : (reply.body ?? Buffer.alloc(0));
    return {
      url: reply.url ?? url,
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
      contentType: reply.contentType ?? "",
      body,
      truncated: reply.truncated ?? false,
    };
  };
  return { fetch, calls };
}

const html = (head: string) => ({
  contentType: "text/html; charset=utf-8",
  body: `<html><head>${head}</head><body></body></html>`,
});
const png = { contentType: "image/png", body: PNG };
const tooMany = {
  status: 429,
  contentType: "text/html; charset=utf-8",
  headers: { "retry-after": "900" },
  body: "Too many requests",
};

const REPO = "https://github.com/ChisaAlter/ChisaBot";
const OG =
  "https://opengraph.githubassets.com/8a7b6492/ChisaAlter/ChisaBot?token=SECRET";
const repoPage = html(
  `<title>GitHub - ChisaAlter/ChisaBot</title><meta property="og:title" content="ChisaAlter/ChisaBot"><meta property="og:image" content="${OG}">`,
);

async function setup(script: Script) {
  const db = fakeDatabase();
  const net = fakeFetch(script);
  const logs: Record<string, unknown>[] = [];
  const service = await createLinkPreviews(db.database, {
    fetch: net.fetch,
    log: (e) => logs.push(e),
  });
  const ttlOf = () => [...db.previews.values()].map((r) => r.ttl);
  return { ...db, ...net, logs, service, ttlOf };
}

describe("GitHub 预览图（必修）", () => {
  test("og 图 429：记下原因（不带查询串）、不立刻重试、改用仓库固定图，并且只缓存 30 分钟", async () => {
    const t = await setup({
      [REPO]: repoPage,
      [OG]: tooMany,
      "https://opengraph.githubassets.com/1/ChisaAlter/ChisaBot": png,
    });
    const { preview } = await t.service.previewFor(REPO);
    expect(preview?.image).toMatch(
      /^\/api\/link-preview\/asset\/[a-f0-9]{40}$/,
    );
    expect(preview?.imageKind).toBe("og");
    expect(t.calls.filter((u) => u === OG)).toHaveLength(1);
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toMatchObject({
      type: "link-preview-image-failed",
      role: "og",
      reason: "status 429 retry-after=900",
    });
    expect(String(t.logs[0]?.url)).not.toContain("SECRET");
    expect(t.ttlOf()).toEqual(["30 minutes"]);
  });

  test("固定图也被限流：用仓库主人的头像", async () => {
    const t = await setup({
      [REPO]: repoPage,
      [OG]: tooMany,
      "https://opengraph.githubassets.com/1/ChisaAlter/ChisaBot": tooMany,
      "https://avatars.githubusercontent.com/ChisaAlter?s=400": png,
    });
    const { preview } = await t.service.previewFor(REPO);
    expect(preview?.image).not.toBeNull();
    expect(t.logs.map((l) => l.role)).toEqual(["og", "github-fallback"]);
  });

  test("没有 og:image 的仓库页也能拿到兜底图", async () => {
    const t = await setup({
      [REPO]: html("<title>ChisaBot</title>"),
      "https://opengraph.githubassets.com/1/ChisaAlter/ChisaBot": png,
    });
    expect((await t.service.previewFor(REPO)).preview?.imageKind).toBe("og");
  });

  test("网络错误再试一次；不是图片 / 太大不再试，并写明原因", async () => {
    const t = await setup({
      "https://a.example/": html(
        '<title>A</title><meta property="og:image" content="https://img.example/a.png">',
      ),
      "https://img.example/a.png": (n) =>
        n === 1 ? Promise.reject(new Error("socket hang up")) : png,
      "https://b.example/": html(
        '<title>B</title><meta property="og:image" content="https://img.example/b.png">',
      ),
      "https://img.example/b.png": {
        status: 200,
        contentType: "text/html",
        body: "<html>login</html>",
      },
      "https://c.example/": html(
        '<title>C</title><meta property="og:image" content="https://img.example/c.png">',
      ),
      "https://img.example/c.png": {
        status: 200,
        contentType: "image/png",
        body: PNG,
        truncated: true,
      },
    });
    expect(
      (await t.service.previewFor("https://a.example/")).preview?.image,
    ).not.toBeNull();
    expect(t.calls.filter((u) => u.endsWith("/a.png"))).toHaveLength(2);
    expect(
      (await t.service.previewFor("https://b.example/")).preview?.image,
    ).toBeNull();
    expect(
      (await t.service.previewFor("https://c.example/")).preview?.image,
    ).toBeNull();
    expect(
      t.calls.filter((u) => u.endsWith("/b.png") || u.endsWith("/c.png")),
    ).toHaveLength(2);
    expect(t.logs.map((l) => l.reason)).toEqual([
      "not-image (text/html)",
      "too-large (>3145728 bytes)",
    ]);
  });

  test("redactUrl 去掉查询串", () => {
    expect(redactUrl("https://x.example/a/b.png?sig=abc&u=me")).toBe(
      "https://x.example/a/b.png?…",
    );
    expect(redactUrl("https://x.example/a")).toBe("https://x.example/a");
  });

  test("githubImageFallbacks 只认仓库页", () => {
    expect(
      githubImageFallbacks(
        "https://github.com/oven-sh/bun/releases/tag/bun-v1.1.0",
      )[0],
    ).toBe("https://opengraph.githubassets.com/1/oven-sh/bun");
    expect(githubImageFallbacks("https://github.com/")).toEqual([]);
    expect(githubImageFallbacks("https://github.com/settings/profile")).toEqual(
      [],
    );
    expect(githubImageFallbacks("https://gitlab.com/a/b")).toEqual([]);
  });
});

describe("缓存", () => {
  test("成功 24 小时、过期后重新抓；兜底卡 30 分钟", async () => {
    const t = await setup({
      "https://ok.example/": html(
        '<title>OK</title><meta property="og:description" content="d">',
      ),
      "https://down.example/": { status: 503, body: "" },
    });
    await t.service.previewFor("https://ok.example/");
    const again = await t.service.previewFor("https://ok.example/");
    expect(again.cached).toBe(true);
    expect(t.calls.filter((u) => u === "https://ok.example/")).toHaveLength(1);
    for (const row of t.previews.values()) row.expiresAt = Date.now() - 1;
    expect((await t.service.previewFor("https://ok.example/")).cached).toBe(
      false,
    );
    expect(t.calls.filter((u) => u === "https://ok.example/")).toHaveLength(2);
    const down = await t.service.previewFor("https://down.example/");
    expect(down.preview?.degraded).toBe(true);
    expect(t.ttlOf().sort()).toEqual(["24 hours", "30 minutes"]);
  });

  test("同一网址并发只抓一次", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const t = await setup({
      "https://slow.example/": async () => {
        await gate;
        return html("<title>Slow</title>");
      },
    });
    const all = Promise.all(
      [1, 2, 3, 4, 5].map(() => t.service.previewFor("https://slow.example/")),
    );
    release();
    const results = await all;
    expect(new Set(results.map((r) => r.preview?.title))).toEqual(
      new Set(["Slow"]),
    );
    expect(t.calls.filter((u) => u === "https://slow.example/")).toHaveLength(
      1,
    );
    expect(t.previews.size).toBe(1);
  });
});

describe("降级路径", () => {
  test("404 / 超时 / 非网页 都是兜底卡，标题是文件名或域名", async () => {
    const t = await setup({
      "https://a.example/missing": { status: 404 },
      "https://b.example/": new Error("请求超时"),
      "https://c.example/report.pdf": {
        contentType: "application/pdf",
        body: "%PDF-1.4",
      },
    });
    const a = (await t.service.previewFor("https://a.example/missing")).preview;
    const b = (await t.service.previewFor("https://b.example/")).preview;
    const c = (await t.service.previewFor("https://c.example/report.pdf"))
      .preview;
    expect([a?.degraded, b?.degraded, c?.degraded]).toEqual([true, true, true]);
    expect([a?.title, b?.title, c?.title]).toEqual([
      "a.example",
      "b.example",
      "report.pdf",
    ]);
    expect(new Set(t.ttlOf())).toEqual(new Set(["30 minutes"]));
  });

  test("200 但没有标题、说明和图（YouTube 给服务器的页面）：兜底卡，不按成功缓存", async () => {
    const t = await setup({
      "https://empty.example/watch?v=1": html("<meta charset=utf-8>"),
    });
    const { preview } = await t.service.previewFor(
      "https://empty.example/watch?v=1",
    );
    expect(preview?.degraded).toBe(true);
    expect(t.ttlOf()).toEqual(["30 minutes"]);
  });

  test("跳到反爬验证页（sec.douban.com）：兜底卡、域名是原链接的、不缓存一天", async () => {
    const t = await setup({
      "https://movie.douban.com/subject/1292052/": {
        ...html("<title>豆瓣</title>"),
        url: "https://sec.douban.com/c?r=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F1292052%2F",
      },
    });
    const { preview } = await t.service.previewFor(
      "https://movie.douban.com/subject/1292052/",
    );
    expect(preview).toMatchObject({
      degraded: true,
      domain: "movie.douban.com",
    });
    expect(t.ttlOf()).toEqual(["30 minutes"]);
  });

  test("普通跳转后，卡片域名仍是原链接的", async () => {
    const t = await setup({
      "https://short.example/x": {
        ...html("<title>Target</title>"),
        url: "https://target.example/page",
      },
    });
    const { preview } = await t.service.previewFor("https://short.example/x");
    expect(preview).toMatchObject({
      title: "Target",
      domain: "short.example",
      finalUrl: "https://target.example/page",
    });
  });

  test("isChallengePage：验证页标题、知乎 zse-ck、sec.* 主机", () => {
    expect(
      isChallengePage(
        "https://baike.baidu.com/item/x",
        "https://baike.baidu.com/item/x",
        "百度安全验证",
        "",
      ),
    ).toBe(true);
    expect(
      isChallengePage(
        "https://www.zhihu.com/q",
        "https://www.zhihu.com/q",
        "",
        '<html><head><meta id="zh-zse-ck" content="x">',
      ),
    ).toBe(true);
    expect(
      isChallengePage("https://a.example/", "https://sec.a.example/c", "A", ""),
    ).toBe(true);
    expect(
      isChallengePage("https://a.example/", "https://a.example/", "Hello", ""),
    ).toBe(false);
  });

  test("isChallengePage：整标题 / 前缀匹配，弱标题要状态码或页面特征佐证", () => {
    const at = (title: string, html = "", status = 200) =>
      isChallengePage(
        "https://a.example/",
        "https://a.example/",
        title,
        html,
        status,
      );
    // 误报：标题里只是含有这些词
    expect(at("短信验证码接口设计 - 知乎")).toBe(false);
    expect(at("Access Denied (2023 film)")).toBe(false);
    expect(at("请稍候，正在加载")).toBe(false);
    expect(at("Access Denied (2023 film)", "", 403)).toBe(false);
    expect(at("如何设计人机验证？")).toBe(false);
    // 真阳性：整个标题就是验证页
    expect(at("Just a moment...")).toBe(true);
    expect(at("Attention Required! | Cloudflare")).toBe(true);
    expect(at("安全验证 - 豆瓣")).toBe(true);
    // 弱标题 + 状态码 / 页面特征
    expect(at("Access denied")).toBe(false);
    expect(at("Access denied", "", 403)).toBe(true);
    expect(
      at("请稍候", '<form id="challenge-form" action="/?__cf_chl_f_tk=x">'),
    ).toBe(true);
    expect(
      at(
        "Please wait | Example",
        '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js">',
      ),
    ).toBe(true);
  });

  test("页面内容里提到验证码的正常文章照常出卡", async () => {
    const t = await setup({
      "https://zhuanlan.example/p/1": html(
        '<title>短信验证码接口设计 - 知乎</title><meta property="og:description" content="正文">',
      ),
    });
    const { preview } = await t.service.previewFor(
      "https://zhuanlan.example/p/1",
    );
    expect(preview?.degraded).toBeUndefined();
    expect(preview?.title).toBe("短信验证码接口设计 - 知乎");
  });
});

describe("图片直链", () => {
  test("标题用文件名；路径最后一段只是 png 时叫「图片」，不是「png」", async () => {
    const t = await setup({
      "https://httpbin.example/image/png": png,
      "https://upload.example/a/Example.jpg": {
        contentType: "image/png",
        body: PNG,
      },
    });
    const a = (await t.service.previewFor("https://httpbin.example/image/png"))
      .preview;
    const b = (
      await t.service.previewFor("https://upload.example/a/Example.jpg")
    ).preview;
    expect(a).toMatchObject({ title: "图片", imageKind: "direct" });
    expect(b?.title).toBe("Example.jpg");
    expect(directImageTitle("https://x.example/")).toBe("图片");
  });
});

describe("视频和中文站：公开接口", () => {
  test("YouTube 走 oEmbed：真标题、封面、kind=video", async () => {
    const api =
      "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ";
    const t = await setup({
      [api]: {
        contentType: "application/json",
        body: JSON.stringify({
          title: "Never Gonna Give You Up",
          author_name: "Rick Astley",
          thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        }),
      },
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg": png,
    });
    const { preview } = await t.service.previewFor(
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
    );
    expect(preview).toMatchObject({
      title: "Never Gonna Give You Up",
      siteName: "YouTube",
      kind: "video",
      imageKind: "og",
    });
    expect(t.ttlOf()).toEqual(["24 hours"]);
  });

  test("bilibili 走视频信息接口，http 封面换成 https", async () => {
    const t = await setup({
      "https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7": {
        contentType: "application/json",
        body: JSON.stringify({
          code: 0,
          data: {
            title: "【官方 MV】Never Gonna Give You Up",
            pic: "http://i1.hdslb.com/bfs/archive/x.jpg",
            owner: { name: "索尼音乐" },
            desc: "-",
          },
        }),
      },
      "https://i1.hdslb.com/bfs/archive/x.jpg": png,
    });
    const { preview } = await t.service.previewFor(
      "https://www.bilibili.com/video/BV1GJ411x7h7/",
    );
    expect(preview).toMatchObject({
      title: "【官方 MV】Never Gonna Give You Up",
      kind: "video",
      description: "UP 主：索尼音乐",
    });
    expect(preview?.image).not.toBeNull();
  });

  test("接口失败（bilibili 风控 -412）就走网页；网页也是验证页时是兜底卡，封面没取到也只缓存 30 分钟", async () => {
    const t = await setup({
      "https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7": {
        contentType: "application/json",
        body: '{"code":-412}',
      },
      "https://www.bilibili.com/video/BV1GJ411x7h7": { status: 412 },
    });
    const { preview } = await t.service.previewFor(
      "https://www.bilibili.com/video/BV1GJ411x7h7",
    );
    expect(preview?.degraded).toBe(true);
    expect(t.ttlOf()).toEqual(["30 minutes"]);
    const t2 = await setup({
      "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ":
        {
          contentType: "application/json",
          body: JSON.stringify({
            title: "T",
            thumbnail_url: "https://i.ytimg.com/x.jpg",
          }),
        },
    });
    expect(
      (
        await t2.service.previewFor(
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        )
      ).preview?.image,
    ).toBeNull();
    expect(t2.ttlOf()).toEqual(["30 minutes"]);
  });

  test("百度百科走词条卡开放接口", async () => {
    const src = apiSourceFor(
      "https://baike.baidu.com/item/%E5%8C%97%E4%BA%AC/128981",
    );
    expect(src?.api).toContain("bk_key=%E5%8C%97%E4%BA%AC");
    const t = await setup({
      [src!.api]: {
        contentType: "application/json",
        body: JSON.stringify({
          title: "北京市",
          abstract: "中华人民共和国首都",
          image: "https://bkimg.example/x.jpg",
        }),
      },
      "https://bkimg.example/x.jpg": png,
    });
    const { preview } = await t.service.previewFor(
      "https://baike.baidu.com/item/%E5%8C%97%E4%BA%AC/128981",
    );
    expect(preview).toMatchObject({
      title: "北京市",
      siteName: "百度百科",
      description: "中华人民共和国首都",
    });
    expect(preview?.kind).toBeUndefined();
  });

  test("apiSourceFor 认得各种 YouTube 地址，其它站返回 null", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
    ])
      expect(apiSourceFor(u)?.siteName).toBe("YouTube");
    expect(apiSourceFor("https://www.youtube.com/")).toBeNull();
    expect(apiSourceFor("https://www.zhihu.com/question/1")).toBeNull();
  });
});

describe("解析：中文域名、命名实体", () => {
  test("punycode 显示成汉字", () => {
    expect(displayDomain("https://xn--fiqs8s.xn--fiqs8s/")).toBe("中国.中国");
    expect(displayDomain(`https://${domainToASCII("中文.中国")}/`)).toBe(
      "中文.中国",
    );
    expect(displayDomain(`https://${domainToASCII("café.fr")}/`)).toBe(
      "café.fr",
    );
    expect(displayDomain(`https://${domainToASCII("日本語.jp")}/`)).toBe(
      "日本語.jp",
    );
  });

  test("同形字：混合文字或整段西里尔 / 希腊的标签保留 xn--", () => {
    // аpple.com：西里尔 а + 拉丁 pple
    expect(displayDomain("https://xn--pple-43d.com/")).toBe("xn--pple-43d.com");
    // аррӏе.com：整段西里尔，看起来像 apple
    const allCyrillic = domainToASCII("аррӏе.com");
    expect(allCyrillic.startsWith("xn--")).toBe(true);
    expect(displayDomain(`https://${allCyrillic}/`)).toBe(allCyrillic);
    // 希腊 ο 混拉丁
    const greek = domainToASCII("gοogle.com");
    expect(displayDomain(`https://${greek}/`)).toBe(greek);
    // 一个标签可疑只影响它自己：中文标签照样显示
    const mixed = domainToASCII("аpple.中国");
    expect(displayDomain(`https://${mixed}/`)).toBe(`xn--pple-43d.中国`);
    expect(displayDomain("https://www.example.com/")).toBe("example.com");
  });
  test("HTML 命名实体（&rsquo; &ldquo; &eacute; &hellip; …）都能解", () => {
    expect(
      decodeEntities(
        "Jun&rsquo;s &ldquo;报告&rdquo;&hellip; caf&eacute; &Eacute; &mdash; &amp; &bogus;",
      ),
    ).toBe("Jun’s “报告”… café É — & &bogus;");
  });
});

describe("路由：限速", () => {
  test("每人每分钟 40 次新抓取，超过 429；缓存命中不算", async () => {
    const script: Script = {
      "https://hit.example/": html("<title>Hit</title>"),
    };
    for (let i = 0; i < 41; i++)
      script[`https://p${i}.example/`] = html(`<title>P${i}</title>`);
    const t = await setup(script);
    const app = new Hono();
    app.route(
      "/api/link-preview",
      t.service.routes(async (c, next) => {
        c.set("actor", { id: "u1" } as never);
        await next();
      }),
    );
    const get = (u: string) =>
      app.request(`/api/link-preview?url=${encodeURIComponent(u)}`);
    expect((await get("https://hit.example/")).status).toBe(200);
    for (let i = 0; i < 39; i++)
      expect((await get(`https://p${i}.example/`)).status).toBe(200);
    expect((await get("https://p40.example/")).status).toBe(429);
    const cached = await get("https://hit.example/");
    expect(cached.status).toBe(200);
    const body = (await cached.json()) as { preview: LinkPreview };
    expect(body.preview.title).toBe("Hit");
  });
});

describe("路由：Cache-Control", () => {
  test("非 2xx 一律 no-store，成功预览 private, max-age=600", async () => {
    const script: Script = {
      "https://ok.example/": html("<title>OK</title>"),
      "https://gone.example/": { status: 404, body: "nope" },
    };
    for (let i = 0; i < 41; i++)
      script[`https://r${i}.example/`] = html(`<title>R${i}</title>`);
    const t = await setup(script);
    const app = new Hono();
    app.route(
      "/api/link-preview",
      t.service.routes(async (c, next) => {
        if (c.req.header("x-deny")) return c.json({ error: "no" }, 401);
        c.set("actor", { id: "u1" } as never);
        await next();
      }),
    );
    const get = (q: string, init?: RequestInit) =>
      app.request(`/api/link-preview${q}`, init);
    const cc = (r: Response) => r.headers.get("cache-control");
    const ok = await get(`?url=${encodeURIComponent("https://ok.example/")}`);
    expect(ok.status).toBe(200);
    expect(cc(ok)).toBe("private, max-age=600");
    const bad = await get("?url=notaurl");
    expect(bad.status).toBe(422);
    expect(cc(bad)).toBe("no-store");
    const gone = await get(
      `?url=${encodeURIComponent("https://gone.example/")}`,
    );
    expect([200, 422]).toContain(gone.status);
    if (gone.status !== 200) expect(cc(gone)).toBe("no-store");
    const asset = await get("/asset/nope");
    expect(asset.status).toBe(404);
    expect(cc(asset)).toBe("no-store");
    const denied = await get("?url=x", { headers: { "x-deny": "1" } });
    expect(denied.status).toBe(401);
    expect(cc(denied)).toBe("no-store");
    let limited: Response | undefined;
    for (let i = 0; i < 41; i++) {
      const r = await get(
        `?url=${encodeURIComponent(`https://r${i}.example/`)}`,
      );
      if (r.status === 429) limited = r;
    }
    expect(limited?.status).toBe(429);
    expect(limited && cc(limited)).toBe("no-store");
  });
});
