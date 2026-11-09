import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PAGE_LIMITS, PAGE_SLUG } from "../../shared/pages";
import { createDatabase } from "../src/db/client";
import {
  assetName,
  createPages,
  newSlug,
  PAGE_CSP,
  sniffMatches,
  syncHeading,
} from "../src/pages/service";
import { composePage, isFullDocument } from "../src/pages/template";
import { REFUSAL_MARKER } from "../src/plugins/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 页面（DESIGN.md §54）：模板、slug、素材校验、版本、公开读的沙箱头、工具。 */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

describe("pages helpers", () => {
  test("slug is 16 random lowercase alnum", () => {
    const a = newSlug();
    expect(PAGE_SLUG.test(a)).toBe(true);
    expect(newSlug()).not.toBe(a);
  });
  test("template wraps fragments, leaves full documents alone", () => {
    const html = composePage({ title: "<行程>", html: "<h1>你好</h1>" });
    expect(html).toContain("<title>&lt;行程&gt;</title>");
    expect(html).toContain('<main class="page">');
    expect(html).toContain("用 ChisaBot 制作");
    const wrapped = composePage({
      title: "x",
      html: '<main class="page wide"><p>a</p></main>',
    });
    expect(wrapped.match(/<main/g)?.length).toBe(1);
    expect(
      isFullDocument("<!doctype html><html><head></head><body>x</body></html>"),
    ).toBe(true);
    const full = composePage({
      title: "x",
      html: "<!doctype html><html><head></head><body>x</body></html>",
      css: "b{color:red}",
    });
    expect(full.startsWith("<!doctype html><html><head>")).toBe(true);
    expect(full).toContain("b{color:red}");
    expect(full).not.toContain("用 ChisaBot 制作");
    expect(
      composePage({
        title: "x",
        html: "<p>a</p>",
        css: "</style><script>alert(1)</script>",
      }),
    ).not.toContain("</style><script>");
  });
  test("asset names and sniffing", () => {
    expect(assetName("Images/Cover Photo.JPG")).toBe("cover-photo.jpg");
    expect(() => assetName("evil.html")).toThrow();
    expect(sniffMatches("a.png", PNG)).toBe(true);
    expect(sniffMatches("a.png", new TextEncoder().encode("<html>"))).toBe(
      false,
    );
    expect(
      sniffMatches("a.svg", new TextEncoder().encode("<svg xmlns=''></svg>")),
    ).toBe(true);
  });
  test("title change syncs the matching <h1> only", () => {
    expect(
      syncHeading(
        '<header class="hero"><h1 class="x">东京三日游</h1></header>',
        "东京三日游",
        "东京三日游 · 秋",
      ),
    ).toBe('<header class="hero"><h1 class="x">东京三日游 · 秋</h1></header>');
    expect(syncHeading("<h1>别的标题</h1>", "东京三日游", "新")).toBe(
      "<h1>别的标题</h1>",
    );
    expect(syncHeading("<h1>A &amp; B</h1>", "A & B", "C < D")).toBe(
      "<h1>C &lt; D</h1>",
    );
  });
  test("CSP sandboxes without same-origin and blocks network", () => {
    expect(PAGE_CSP).toContain("sandbox allow-scripts");
    expect(PAGE_CSP).not.toContain("allow-same-origin");
    expect(PAGE_CSP).toContain("connect-src 'none'");
    expect(PAGE_CSP).toContain("form-action 'none'");
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("pages service", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const files: Record<string, Uint8Array> = { "img/cover.png": PNG };
  const pages = url
    ? createPages(database, {
        readBotFile: async ({ path }) => {
          const bytes = files[path];
          if (!bytes) throw new Error(`file not found: ${path}`);
          return { bytes, name: path.split("/").pop()! };
        },
        fetchImage: async () => ({ bytes: PNG, contentType: "image/png" }),
      })
    : (null as never);
  const owner = `pagestest-${randomUUID().slice(0, 8)}`;
  const other = `pagestest-${randomUUID().slice(0, 8)}`;
  const app = url ? pages.publicRoutes() : (null as never);
  beforeAll(async () => {
    await pages.ensure();
  });
  afterAll(async () => {
    await database.$client.unsafe(
      "DELETE FROM chisabot_pages WHERE owner_user_id = ANY(string_to_array($1, ','))",
      [`${owner},${other}`],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_page_origins WHERE owner_user_id = $1",
      [owner],
    );
  });

  test("create → public page with sandbox headers; other owners can't see it", async () => {
    const page = await pages.create(owner, {
      agentId: "bot1",
      title: "东京行程",
      html: "<h1>东京</h1>",
    });
    expect(page.version).toBe(1);
    expect(page.published).toBe(true);
    const res = await app.request(`/${page.slug}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(await res.text()).toContain("<h1>东京</h1>");
    const redirect = await app.request(`/${page.slug}`);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe(`/p/${page.slug}/`);
    expect(await pages.get(other, page.id)).toBeNull();
    expect((await app.request("/aaaaaaaaaaaaaaaa/")).status).toBe(404);
    expect((await app.request("/../api/me")).status).toBe(404);
  });

  test("edits make versions; restore copies; unpublish hides", async () => {
    const page = await pages.create(owner, {
      title: "邀请函",
      html: "<p>周六 18:00</p><p>地点 A</p>",
    });
    const { page: v2 } = await pages.update(owner, page.id, {
      edits: [{ find: "18:00", replace: "19:00" }],
      note: "改时间",
    });
    expect(v2.version).toBe(2);
    await expect(
      pages.update(owner, page.id, {
        edits: [{ find: "不存在", replace: "x" }],
      }),
    ).rejects.toThrow();
    await expect(
      pages.update(owner, page.id, {
        edits: [{ find: "<p>", replace: "<p>x" }],
      }),
    ).rejects.toThrow(/不止一次/);
    const same = await pages.update(owner, page.id, {
      html: "<p>周六 19:00</p><p>地点 A</p>",
    });
    expect(same.changed).toBe(false);
    const restored = await pages.restore(owner, page.id, 1);
    expect(restored.version).toBe(3);
    expect(await pages.publicPage(page.slug)).toContain("18:00");
    const versions = await pages.versions(owner, page.id);
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions[0]!.current).toBe(true);
    await pages.setPublished(owner, page.id, false);
    expect((await app.request(`/${page.slug}/`)).status).toBe(404);
    await pages.setPublished(owner, page.id, true);
    expect((await app.request(`/${page.slug}/`)).status).toBe(200);
  });

  test("concurrent edits preserve both changes with unique versions", async () => {
    const page = await pages.create(owner, {
      title: "共同编辑",
      html: "<p>时间 A</p><p>地点 B</p>",
    });
    const results = await Promise.all([
      pages.update(owner, page.id, {
        edits: [{ find: "时间 A", replace: "时间 C" }],
      }),
      pages.update(owner, page.id, {
        edits: [{ find: "地点 B", replace: "地点 D" }],
      }),
    ]);
    expect(results.map((result) => result.page.version).sort()).toEqual([2, 3]);
    const html = await pages.publicPage(page.slug);
    expect(html).toContain("时间 C");
    expect(html).toContain("地点 D");
    expect(
      (await pages.versions(owner, page.id)).map((item) => item.version),
    ).toEqual([3, 2, 1]);
  });

  test("a failed version write rolls back a new page and description changes", async () => {
    // Fail at the database write boundary, after earlier statements have run in the real transaction.
    const failingClient = new Proxy(database.$client, {
      get(target, property) {
        if (property === "begin")
          return (run: (tx: unknown) => unknown) =>
            target.begin((transaction) =>
              run(
                new Proxy(transaction, {
                  get(tx, key) {
                    if (key === "unsafe")
                      return (query: string, values: unknown[]) => {
                        if (
                          query.startsWith("INSERT INTO chisabot_page_versions")
                        )
                          throw new Error("version write failed");
                        return tx.unsafe(query, values);
                      };
                    const value = Reflect.get(tx, key);
                    return typeof value === "function" ? value.bind(tx) : value;
                  },
                }),
              ),
            );
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = createPages({ $client: failingClient } as typeof database);
    const before = (await pages.list(owner)).length;
    await expect(
      failing.create(owner, { title: "不应留下空页", html: "<p>content</p>" }),
    ).rejects.toThrow("version write failed");
    expect((await pages.list(owner)).length).toBe(before);

    const page = await pages.create(owner, {
      title: "原题",
      description: "原简介",
      html: "<p>原文</p>",
    });
    await expect(
      failing.update(owner, page.id, {
        description: "新简介",
        html: "<p>新文</p>",
      }),
    ).rejects.toThrow("version write failed");
    expect((await pages.get(owner, page.id))?.description).toBe("原简介");
    expect((await pages.get(owner, page.id))?.version).toBe(1);
    expect(await pages.publicPage(page.slug)).toContain("原文");
    expect(await pages.versions(owner, page.id)).toHaveLength(1);
  });

  test("concurrent asset uploads cannot both consume the last slot", async () => {
    const page = await pages.create(owner, {
      title: "素材配额",
      html: "<p>assets</p>",
    });
    for (let index = 0; index < PAGE_LIMITS.assetsPerPage - 1; index++) {
      await pages.putAsset(owner, page.id, `asset-${index}.png`, PNG);
    }
    const results = await Promise.allSettled([
      pages.putAsset(owner, page.id, "last-a.png", PNG),
      pages.putAsset(owner, page.id, "last-b.png", PNG),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await pages.assets(owner, page.id)).toHaveLength(
      PAGE_LIMITS.assetsPerPage,
    );
  });

  test("assets round-trip as bytes with the sandbox CSP; bad types refused", async () => {
    const page = await pages.create(owner, {
      title: "作品集",
      html: '<img src="assets/cover.png">',
    });
    await pages.putAsset(owner, page.id, "Cover.png", PNG);
    const res = await app.request(`/${page.slug}/assets/cover.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    await expect(
      pages.putAsset(
        owner,
        page.id,
        "x.png",
        new TextEncoder().encode("<script>"),
      ),
    ).rejects.toThrow();
    await expect(
      pages.putAsset(owner, page.id, "x.html", PNG),
    ).rejects.toThrow();
    expect((await pages.assets(owner, page.id)).map((a) => a.name)).toEqual([
      "cover.png",
    ]);
  });

  test("retitle syncs the page's own <h1>", async () => {
    const page = await pages.create(owner, {
      title: "生日会",
      html: '<header class="hero"><h1>生日会</h1></header><p>x</p>',
    });
    const { page: v2 } = await pages.update(owner, page.id, {
      title: "小林的生日会",
    });
    expect(v2.version).toBe(2);
    expect(await pages.publicPage(page.slug)).toContain(
      "<h1>小林的生日会</h1>",
    );
  });

  test("delete is soft with undo; link dies immediately", async () => {
    const page = await pages.create(owner, { title: "报告", html: "<p>r</p>" });
    expect(await pages.remove(owner, page.id)).toBe(true);
    expect((await app.request(`/${page.slug}/`)).status).toBe(404);
    expect((await pages.list(owner)).some((p) => p.id === page.id)).toBe(false);
    expect(await pages.undoRemove(owner, page.id)).toBe(true);
    expect((await app.request(`/${page.slug}/`)).status).toBe(200);
  });

  test("tools: create with workspace + url assets, marker + full link, update, get, refusal", async () => {
    await pages.setOrigin(owner, "https://chat.example.com:8443/whatever");
    const tools = Object.fromEntries(
      pages.tools(owner, "bot1").map((t) => [t.name, t]),
    );
    expect(Object.keys(tools).sort()).toEqual([
      "page_create",
      "page_delete",
      "page_get",
      "page_list",
      "page_publish",
      "page_update",
    ]);
    const created = await tools.page_create!.execute({
      title: "旅行",
      html: '<header class="hero"><h1>旅行</h1></header><img src="assets/cover.png"><img src="assets/remote.png">',
      assets: [
        { path: "img/cover.png" },
        { url: "https://example.com/remote.png" },
      ],
    });
    expect(created).toMatch(/⟦page:pg_[a-z0-9]+⟧/);
    expect(created).toContain("https://chat.example.com:8443/p/");
    expect(created).toContain("assets/cover.png");
    expect(created).toContain("assets/remote.png");
    const id = created.match(/⟦page:(pg_[a-z0-9]+)⟧/)![1]!;
    const updated = await tools.page_update!.execute({
      page: id,
      edits: [{ find: "<h1>旅行</h1>", replace: "<h1>东京旅行</h1>" }],
    });
    expect(updated).toContain("第 2 版");
    const retitled = await tools.page_update!.execute({
      page: id,
      title: "旅行 · 秋",
    });
    expect(retitled).toContain("第 3 版");
    expect(await tools.page_get!.execute({ page: id })).toContain(
      "<h1>东京旅行</h1>",
    );
    const got = await tools.page_get!.execute({ page: id });
    expect(got).toContain("<h1>东京旅行</h1>");
    const missingFile = await tools.page_update!.execute({
      page: id,
      assets: [{ path: "nope.png" }],
    });
    expect(missingFile.startsWith(REFUSAL_MARKER)).toBe(true);
    const bad = await tools.page_update!.execute({ page: "nope" });
    expect(bad.startsWith(REFUSAL_MARKER)).toBe(true);
    const otherTools = Object.fromEntries(
      pages.tools(other, "bot2").map((t) => [t.name, t]),
    );
    expect(
      (await otherTools.page_get!.execute({ page: id })).startsWith(
        REFUSAL_MARKER,
      ),
    ).toBe(true);
  });
});
