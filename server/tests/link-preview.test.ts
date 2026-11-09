import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BlockedUrlError,
  guardedFetch,
  resolvePublic,
} from "../../shared/net/guarded-fetch";
import {
  checkPublicUrl,
  embeddedIpv4,
  isBlockedAddress,
  isBlockedHostname,
} from "../../shared/net/ssrf";
import {
  decodeHtml,
  detectCharset,
  parsePage,
} from "../src/link-preview/parse";
import {
  degradedTitle,
  normalizePreviewUrl,
  sniffImage,
} from "../src/link-preview/service";

describe("SSRF 防护：哪些地址不能连", () => {
  test("IPv4 内网、本机、元数据、保留段", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "100.100.100.200",
      "0.0.0.0",
      "192.0.0.170",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "203.0.113.9",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  test("公网 IPv4 放行（含紧挨着内网段的地址）", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "172.15.255.255",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "93.184.216.34",
    ]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  test("IPv6：本机、链路本地、唯一本地、云元数据、组播", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd00:ec2::254",
      "fd20:ce::254",
      "ff02::1",
      "[::1]",
      "fe80::1%eth0",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  test("IPv6 里藏着的 IPv4 先取出来再判", () => {
    expect(embeddedIpv4("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(embeddedIpv4("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(embeddedIpv4("64:ff9b::a9fe:a9fe")).toBe("169.254.169.254");
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("64:ff9b::169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::127.0.0.1")).toBe(true);
    expect(isBlockedAddress("2002:7f00:1::1")).toBe(true); // 6to4 整段拦
    expect(isBlockedAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(true); // Teredo
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  test("不是 IP 的字符串一律当作不能连", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });

  test("主机名：localhost、单段名、内网后缀", () => {
    for (const host of [
      "localhost",
      "LOCALHOST.",
      "foo.localhost",
      "intranet",
      "db",
      "printer.local",
      "metadata.google.internal",
      "nas.lan",
      "router.home.arpa",
    ]) {
      expect(isBlockedHostname(host)).toBe(true);
    }
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("例子.中国")).toBe(false);
  });

  test("网址：只要 http(s)、不带账号密码；各种 127 的写法都被 URL 规范化后拦下", () => {
    expect(checkPublicUrl("https://example.com/a").ok).toBe(true);
    for (const raw of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "gopher://example.com",
      "javascript:alert(1)",
      "http://user:pw@example.com/",
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://017700000001/",
      "http://127.1/",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://0/",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:3001/api",
      "not a url",
    ]) {
      expect(checkPublicUrl(raw).ok).toBe(false);
    }
  });

  test("normalizePreviewUrl 去掉 #，拒绝太长和内网", () => {
    expect(normalizePreviewUrl("https://example.com/a#x")).toBe(
      "https://example.com/a",
    );
    expect(
      normalizePreviewUrl(`https://example.com/${"a".repeat(3000)}`),
    ).toBeNull();
    expect(normalizePreviewUrl("http://10.0.0.1/")).toBeNull();
  });

  test("DNS 解析到内网（哪怕只有一个结果是内网）整体拒绝", async () => {
    await expect(
      resolvePublic("evil.example", {
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(
      resolvePublic("mixed.example", {
        resolve: async () => [
          { address: "93.184.215.14", family: 4 },
          { address: "10.1.1.1", family: 4 },
        ],
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(
      resolvePublic("empty.example", { resolve: async () => [] }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(
      await resolvePublic("ok.example", {
        resolve: async () => [{ address: "93.184.215.14", family: 4 }],
      }),
    ).toEqual({
      address: "93.184.215.14",
      family: 4,
    });
  });
});

describe("guardedFetch：钉死 IP、逐跳检查重定向、限大小", () => {
  // 一个本机测试服务器；测试里把 127.0.0.1 当成「公网」，把 10.x 当内网，验证逻辑而不是真的出网。
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
  const isBlocked = (ip: string) => ip !== "127.0.0.1";
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/page")
          return new Response("<html><head><title>Hi</title></head></html>", {
            headers: { "content-type": "text/html" },
          });
        if (url.pathname === "/to-private")
          return new Response(null, {
            status: 302,
            headers: { location: "http://10.0.0.5/secret" },
          });
        if (url.pathname === "/to-file")
          return new Response(null, {
            status: 302,
            headers: { location: "file:///etc/passwd" },
          });
        if (url.pathname === "/to-page")
          return new Response(null, {
            status: 301,
            headers: { location: "/page" },
          });
        if (url.pathname === "/loop")
          return new Response(null, {
            status: 302,
            headers: { location: "/loop" },
          });
        if (url.pathname === "/big") return new Response("x".repeat(200_000));
        if (url.pathname === "/host")
          return new Response(req.headers.get("host") ?? "");
        return new Response("nope", { status: 404 });
      },
    });
    base = `http://preview-test.example:${server.port}`;
  });
  afterAll(() => server.stop(true));

  test("按主机名请求，但只连钉死的地址（Host 头保持原名）", async () => {
    const res = await guardedFetch(`${base}/host`, {
      maxBytes: 1000,
      timeoutMs: 3000,
      resolve,
      isBlocked,
    });
    expect(res.body.toString()).toBe(`preview-test.example:${server.port}`);
  });

  test("跟随公网重定向", async () => {
    const res = await guardedFetch(`${base}/to-page`, {
      maxBytes: 10_000,
      timeoutMs: 3000,
      resolve,
      isBlocked,
    });
    expect(res.status).toBe(200);
    expect(res.url).toBe(`${base}/page`);
    expect(res.body.toString()).toContain("<title>Hi</title>");
  });

  test("重定向到内网 / 非 http 被拦", async () => {
    await expect(
      guardedFetch(`${base}/to-private`, {
        maxBytes: 1000,
        timeoutMs: 3000,
        resolve,
        isBlocked,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(
      guardedFetch(`${base}/to-file`, {
        maxBytes: 1000,
        timeoutMs: 3000,
        resolve,
        isBlocked,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  test("重定向次数有上限", async () => {
    await expect(
      guardedFetch(`${base}/loop`, {
        maxBytes: 1000,
        timeoutMs: 3000,
        maxRedirects: 3,
        resolve,
        isBlocked,
      }),
    ).rejects.toThrow("重定向次数太多");
  });

  test("超过字节上限就截断", async () => {
    const res = await guardedFetch(`${base}/big`, {
      maxBytes: 50_000,
      timeoutMs: 3000,
      resolve,
      isBlocked,
    });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(50_000);
  });

  test("真实默认设置下，本机地址直接被拒（不发请求）", async () => {
    await expect(
      guardedFetch(`http://127.0.0.1:${server.port}/page`, {
        maxBytes: 1000,
        timeoutMs: 3000,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(
      guardedFetch(`http://localhost:${server.port}/page`, {
        maxBytes: 1000,
        timeoutMs: 3000,
      }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});

describe("网页解析", () => {
  const url = "https://www.example.com/post/1";
  test("og / twitter / title 优先级，相对地址补全，实体解码", () => {
    const html = `<!doctype html><html><head>
      <meta charset="utf-8"><title>页面 &amp; 标题</title>
      <meta property="og:title" content="OG 标题 &quot;x&quot;">
      <meta property="og:site_name" content="示例站">
      <meta name="description" content="一段说明">
      <meta property="og:image" content="/img/cover.jpg">
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel="apple-touch-icon" href="https://cdn.example.com/apple.png">
    </head><body><meta property="og:image" content="https://evil.com/late.png"></body></html>`;
    const page = parsePage(html, url);
    expect(page.title).toBe('OG 标题 "x"');
    expect(page.siteName).toBe("示例站");
    expect(page.description).toBe("一段说明");
    expect(page.image).toBe("https://www.example.com/img/cover.jpg");
    expect(page.icons[0]).toBe("https://www.example.com/favicon-32.png");
    expect(page.icons).toContain("https://www.example.com/favicon.ico");
  });

  test("没有 og 时用 <title> 和 twitter:image；忽略 javascript: / data: 图", () => {
    const page = parsePage(
      `<head><title>
        只有标题
      </title><meta name="twitter:image" content="javascript:alert(1)"><meta property="og:image" content="data:image/png;base64,AAA"></head>`,
      url,
    );
    expect(page.title).toBe("只有标题");
    expect(page.image).toBeNull();
    expect(page.icons).toEqual(["https://www.example.com/favicon.ico"]);
  });

  test("<base href> 生效；属性不带引号也能读", () => {
    const page = parsePage(
      `<head><base href="https://static.example.net/x/"><meta property=og:image content=cover.png></head>`,
      url,
    );
    expect(page.image).toBe("https://static.example.net/x/cover.png");
  });

  test("编码：响应头 > meta charset > utf-8，GBK 页面能解出中文", () => {
    expect(detectCharset("text/html; charset=GBK", new Uint8Array())).toBe(
      "gbk",
    );
    expect(
      detectCharset(
        "text/html",
        new TextEncoder().encode('<meta charset="gb2312">'),
      ),
    ).toBe("gb2312");
    expect(detectCharset("text/html", new TextEncoder().encode("<html>"))).toBe(
      "utf-8",
    );
    // 「中文」的 GBK 编码
    const gbk = new Uint8Array([
      0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0x3c,
      0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e,
    ]);
    expect(decodeHtml("text/html; charset=gbk", gbk)).toContain("中文");
  });

  test("按字节认图片格式，不信 content-type", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe(
      "image/png",
    );
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
    expect(
      sniffImage(
        new TextEncoder().encode(
          "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        ),
      ),
    ).toBe("image/svg+xml");
    expect(
      sniffImage(new TextEncoder().encode("<html>not an image</html>")),
    ).toBeNull();
  });
});

describe("兜底卡（DESIGN.md §48）", () => {
  test("标题：像文件名就用文件名，网页 / 目录用域名", () => {
    expect(
      degradedTitle(
        "https://github.com/ChisaAlter/ChisaBot/releases/download/v0.1.7/ChisaBot-PC-0.1.7-x64-setup.exe",
      ),
    ).toBe("ChisaBot-PC-0.1.7-x64-setup.exe");
    expect(degradedTitle("https://www.example.com/docs/")).toBe("example.com");
    expect(degradedTitle("https://www.example.com/index.html")).toBe(
      "example.com",
    );
    expect(degradedTitle("https://a.cn/%E6%8A%A5%E5%91%8A.pdf")).toBe(
      "报告.pdf",
    );
  });

  test("云元数据、IPv6 映射、十进制 / 十六进制写法的本机地址都不能预览", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/",
      "http://[fd00:ec2::254]/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://127.1/",
      "http://metadata.google.internal/",
      "gopher://example.com/",
    ])
      expect(normalizePreviewUrl(url)).toBeNull();
    expect(normalizePreviewUrl("https://example.com/a#b")).toBe(
      "https://example.com/a",
    );
  });
});
