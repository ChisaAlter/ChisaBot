import { type Browser, chromium } from "playwright";
import { guardedFetch } from "../../shared/net/guarded-fetch";
import { checkPublicUrl } from "../../shared/net/ssrf";

/**
 * 链接预览卡的截图（2026-10-13）：网页没有 og:image 时，服务器请这里截一张 1200×630 的图。
 *
 * 和机器人的浏览器完全分开：单独一个无头 Chromium、每张图一个全新的无痕上下文，不带任何机器人的
 * 登录、不碰任何机器人的标签页。空闲 60 秒自动关掉，同一时间只截一张（排队最多 4 个）。
 *
 * 防 SSRF：Chromium 自己**一个字节都不直接上网**——
 * - 所有 http(s) 请求都被 `context.route` 截下，由 `guardedFetch`（DNS 解析后检查、IP 钉死、逐跳查重定向、
 *   限时限大小）代取后原样交回页面；内网 / 本机 / 元数据地址直接中止。非 GET、非 http(s) 一律中止。
 * - 漏网的流量（WebSocket、预连接、WebRTC）：WebSocket 全部关闭；代理指向一个不存在的端口并且不放行
 *   本机（`<-loopback>`），所有主机名解析为不存在，UDP 只能走代理（= 走不了）。
 * - 每页最多 80 个请求、合计 12MB，总时限 20 秒。
 */

const VIEWPORT = { width: 1200, height: 630 };
const MAX_REQUESTS = 80;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const PER_REQUEST_BYTES = 4 * 1024 * 1024;
const TOTAL_MS = 20_000;
const IDLE_CLOSE_MS = 60_000;
const MAX_QUEUE = 4;

const LAUNCH_ARGS = [
  "--disable-dev-shm-usage",
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>",
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--disable-sync",
  "--no-first-run",
  "--mute-audio",
];

let browser: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
const waiting: (() => void)[] = [];

function scheduleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (running > 0 || !browser) return;
    const current = browser;
    browser = null;
    void current.then((b) => b.close()).catch(() => {});
  }, IDLE_CLOSE_MS);
}

function getBrowser(sandbox: boolean): Promise<Browser> {
  if (browser) return browser;
  const launching = chromium
    .launch({
      headless: true,
      chromiumSandbox: sandbox,
      args: sandbox ? LAUNCH_ARGS : ["--no-sandbox", ...LAUNCH_ARGS],
    })
    .catch((error: unknown) => {
      browser = null;
      throw error;
    });
  browser = launching;
  return launching;
}

async function slot(): Promise<() => void> {
  if (running >= 1) {
    if (waiting.length >= MAX_QUEUE) throw new PreviewShotBusyError();
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running += 1;
  return () => {
    running -= 1;
    waiting.shift()?.();
    scheduleClose();
  };
}

export class PreviewShotBusyError extends Error {
  constructor() {
    super("截图排队太多，稍后再试");
  }
}
export class PreviewShotRefusedError extends Error {}

const PASS_HEADERS = [
  "content-type",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "timing-allow-origin",
  "content-language",
];

export async function previewShot(
  rawUrl: string,
  options: { sandbox: boolean },
): Promise<Uint8Array> {
  const verdict = checkPublicUrl(rawUrl);
  if (!verdict.ok) throw new PreviewShotRefusedError(verdict.reason);
  const release = await slot();
  const deadline = Date.now() + TOTAL_MS;
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  try {
    const b = await getBrowser(options.sandbox);
    try {
      context = await b.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        serviceWorkers: "block",
        acceptDownloads: false,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 ChisaBot-LinkPreview/0.1",
      });
    } catch (error) {
      // CR-P2-10：启动成功后浏览器崩了会一直命中坏缓存；清掉好下次重开。
      browser = null;
      void b.close().catch(() => {});
      throw error;
    }
    let requests = 0;
    let bytes = 0;
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      if (!/^https?:/i.test(url) || request.method() !== "GET")
        return route.abort("blockedbyclient");
      requests += 1;
      const left = deadline - Date.now();
      if (requests > MAX_REQUESTS || bytes > MAX_TOTAL_BYTES || left < 500)
        return route.abort("blockedbyclient");
      try {
        const headers = request.headers();
        const res = await guardedFetch(url, {
          maxBytes: PER_REQUEST_BYTES,
          timeoutMs: Math.min(7000, left),
          headers: {
            accept: headers.accept ?? "*/*",
            ...(headers.referer ? { referer: headers.referer } : {}),
          },
        });
        bytes += res.body.length;
        const passed: Record<string, string> = {};
        for (const name of PASS_HEADERS) {
          const value = res.headers[name];
          if (value) passed[name] = value;
        }
        await route.fulfill({
          status: res.status,
          headers: passed,
          body: res.body,
        });
      } catch {
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    const page = await context.newPage();
    await page.goto(verdict.url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1000, deadline - Date.now() - 3000),
    });
    // 等页面基本画完：load 或最多 3 秒，再给字体 / 懒加载图 0.8 秒。
    await Promise.race([
      page.waitForLoadState("load").catch(() => {}),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    await new Promise((r) => setTimeout(r, 800));
    const shot = await page.screenshot({
      type: "jpeg",
      quality: 72,
      timeout: Math.max(1000, deadline - Date.now()),
    });
    return new Uint8Array(shot);
  } finally {
    await context?.close().catch(() => {});
    release();
  }
}
