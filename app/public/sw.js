/*
 * ChisaBot service worker（DESIGN.md §40，docs/pwa.md）。
 *
 * 只做两件事，而且都不会挡住新版本：
 *   1. 页面导航（index.html）：永远先走网络（navigation preload），拿到什么就给什么——包括登录网关的跳转。
 *      只有网络真的断了（navigator.onLine 为 false）才给一张「网络不可用」的离线卡片。
 *      服务器慢（导航 20s 没回）、部署重启、网关 502/503/504/52x：给「服务器响应慢，正在重试…」卡片，
 *      卡片自己按 1/2/4/8/15/30s 退避去探测同一个地址，一恢复就原地刷新回到原页面（DF-13）。
 *      两张卡片都是现拼的、no-store，从不进缓存。旧的 index.html 从不缓存，所以部署后刷新一次一定是新入口。
 *   2. /assets/*（文件名带内容哈希，内容永不改变）：命中缓存直接给，没命中走网络，200 才存。
 *      缺失的分包服务器回 404，这里原样转交、不缓存——前端的「分包过期自动刷新一次」（app/src/lib/stale-chunk.ts，PR #64）照常工作。
 * 其它请求（/api、/auth、WebSocket、非 GET、跨域、Range 请求、/magpie-admin、/downloads…）一律不拦，浏览器照常处理。
 *
 * 出问题时的退路：把这个文件换成只调用 self.registration.unregister() 的版本即可；或者在浏览器里
 * localStorage.setItem("chisabot-sw", "off") 后刷新，页面会注销它（app/src/lib/pwa.ts）。
 */
const SW_VERSION = "2"; // DF-13：导航失败区分离线 / 服务器慢
const ASSET_CACHE = "chisabot-assets-v1";
const NAV_TIMEOUT_MS = 20_000;
const RETRY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const MAX_ASSETS = 400;
const SKIP_NAV = /^\/(api|auth|magpie-admin|downloads|workspace|sign-in)(\/|$)/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("chisabot-") && key !== ASSET_CACHE).map((key) => caches.delete(key)));
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {}
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    if (SKIP_NAV.test(url.pathname)) return;
    event.respondWith(navigate(event));
    return;
  }

  if (url.pathname.startsWith("/assets/") && !request.headers.has("range")) {
    event.respondWith(asset(request));
  }
});

async function navigate(event) {
  let timer;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (controller) {
        try {
          controller.abort();
        } catch {}
      }
      resolve("timeout");
    }, NAV_TIMEOUT_MS);
  });
  try {
    const response = await Promise.race([
      (async () => {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return controller
          ? await fetch(event.request, { signal: controller.signal })
          : await fetch(event.request);
      })(),
      timeout,
    ]);
    if (response === "timeout") return failed();
    if (RETRY_STATUSES.has(response.status) && !isOwnCard(response))
      return slow();
    return response;
  } catch {
    return failed();
  } finally {
    clearTimeout(timer);
  }
}

/** 网络层失败：真断网给离线卡片，否则（超时、连接被重置…）当作服务器慢。 */
function failed() {
  return isOffline() ? offline() : slow();
}

function isOffline() {
  try {
    return self.navigator.onLine === false;
  } catch {
    return false;
  }
}

function isOwnCard(response) {
  return response.headers.get("x-chisabot-sw") !== null;
}

/**
 * 「正在重试」卡片里的脚本。原样 toString() 进页面，所以只能用参数，不能引用外面的变量。
 * env: { win, delays, retryStatuses }，测试里注入假的 win（setTimeout/fetch/navigator/location）。
 */
function retryMain(env) {
  const win = env.win;
  let attempt = 0;
  let timer = null;
  let stopped = false;
  const text = (id, value) => {
    const el = win.document?.getElementById(id);
    if (el) el.textContent = value;
  };
  const schedule = () => {
    if (stopped) return;
    const delay = env.delays[Math.min(attempt, env.delays.length - 1)];
    attempt++;
    text(
      "hint",
      `${Math.round(delay / 1000)} 秒后再试一次（第 ${attempt} 次）`,
    );
    timer = win.setTimeout(probe, delay);
  };
  const probe = async () => {
    timer = null;
    if (win.navigator.onLine === false) {
      text("title", "网络不可用");
      text("hint", "网络恢复后会自动重试");
      return;
    }
    try {
      const res = await win.fetch(win.location.href, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "manual",
        signal: win.AbortSignal?.timeout
          ? win.AbortSignal.timeout(20000)
          : undefined,
      });
      if (!env.retryStatuses.includes(res.status) && res.status < 500) {
        stopped = true;
        win.location.reload();
        return;
      }
    } catch {}
    schedule();
  };
  win.addEventListener("online", () => {
    text("title", "服务器响应慢，正在重试…");
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
    attempt = 0;
    void probe();
  });
  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer !== null) win.clearTimeout(timer);
    },
  };
}

async function asset(request) {
  let cache;
  try {
    cache = await caches.open(ASSET_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
  } catch {
    // Cache storage unavailable (private mode, quota): fall through to the network.
  }
  const response = await fetch(request);
  if (cache && response.status === 200 && response.type === "basic" && !response.redirected) {
    const copy = response.clone();
    cache
      .put(request, copy)
      .then(() => trim(cache))
      .catch(() => {});
  }
  return response;
}

async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_ASSETS;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

const CARD_STYLE = `html,body{margin:0;height:100%}body{display:grid;place-items:center;padding:24px;box-sizing:border-box;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#16181d;background:linear-gradient(180deg,#6f9bc7 0%,#9dbddc 38%,#c9dbeb 68%,#e4ecf3 100%)}
.card{max-width:340px;width:100%;box-sizing:border-box;padding:28px 24px 24px;border-radius:24px;background:rgba(255,255,255,.62);border:1px solid rgba(255,255,255,.75);box-shadow:0 12px 34px rgba(40,70,110,.14);backdrop-filter:saturate(160%) blur(22px);text-align:center}
h1{margin:0 0 8px;font-size:20px;line-height:28px;font-weight:600}p{margin:0 0 20px;font-size:14px;line-height:22px;color:#3b3f48}#hint{margin-top:-8px;font-size:13px;color:#5a606b}
button{height:44px;padding:0 24px;border:0;border-radius:999px;background:#16181d;color:#fff;font:inherit;font-size:15px;cursor:pointer}
@media (prefers-color-scheme:dark){body{color:#e8ecf3;background:linear-gradient(180deg,#0c1626,#12203a 38%,#172a46 68%,#1b304d)}.card{background:rgba(30,42,60,.72);border-color:rgba(255,255,255,.08)}p{color:#c7cedb}#hint{color:#aab3c2}button{background:#e8ecf3;color:#10161f}}`;

function card(kind, title, body, script) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#9dbddc"><title>ChisaBot · ${title}</title><style>
${CARD_STYLE}
</style></head><body><div class="card" role="alert" data-sw-card="${kind}">${body}<button type="button" onclick="location.reload()">重新加载</button></div>${script}</body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-chisabot-sw": `${SW_VERSION}:${kind}`,
    },
  });
}

function offline() {
  return card(
    "offline",
    "网络不可用",
    `<h1 id="title">网络不可用</h1><p>ChisaBot 需要联网才能使用。请检查网络连接后重试。</p>`,
    "",
  );
}

function slow() {
  const env = `{win:window,delays:${JSON.stringify(RETRY_DELAYS_MS)},retryStatuses:${JSON.stringify([...RETRY_STATUSES])}}`;
  return card(
    "slow",
    "服务器响应慢",
    `<h1 id="title">服务器响应慢，正在重试…</h1><p>可能正在更新或者暂时繁忙，恢复后会自动回到这个页面。</p><p id="hint" aria-live="polite"></p>`,
    `<script>(${retryMain.toString()})(${env});</script>`,
  );
}
