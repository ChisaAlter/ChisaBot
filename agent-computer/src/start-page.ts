import type { Page } from "playwright";
import { settleWithin, withDeadline } from "./env";

/** 起始页检查 / 等待别人画完的上限。页面不再响应时不能把导航（和机器人的操作租约）一直挂住。 */
const DRAW_WAIT_MS = 5_000;

/**
 * 浏览器的「新标签页」。
 *
 * 以前 BOT 的浏览器一启动就停在 about:blank：截图是一张纯白的 PNG，网页端只好画一张「浏览器空闲」
 * 卡片，接管之后看到的也是一片白——用户眼里就是「计算机一片空白」。现在空白页上直接画一个本地的起始页
 * （时钟、搜索框、常用网站），不发任何网络请求，网址仍然是 about:blank，所以它不进历史、不占导航，
 * BOT 的工具也照常把它当成「还没打开网页」。
 *
 * 搜索框用必应（中国大陆和海外都能打开）；接管时在这里输入就能直接搜索或打开网址。
 */

/** 起始页 <html> 上的标记，用来判断这张空白页是否已经画过。 */
export const START_PAGE_MARK = "chisabotStart";

/** 正在导航的页面。导航途中网址还是 about:blank，这时候画起始页会和 goto 抢同一个文档。 */
const navigating = new WeakMap<Page, number>();

/** 同一页面同时只画一次。 */
const drawing = new WeakMap<Page, Promise<void>>();

/** 包住一次导航，期间不往这个页面上画起始页。 */
export async function whileNavigating<T>(
  page: Page,
  work: () => Promise<T>,
): Promise<T> {
  navigating.set(page, (navigating.get(page) ?? 0) + 1);
  try {
    // 正在画起始页时先等它画完：setContent 用 document.open，和 goto 同时进行会取消导航。
    const inFlight = drawing.get(page);
    // Bounded: a draw whose page stopped answering must not hold a navigation (and the Bot's action
    // lease) for ever. The draw itself has a 3 s content timeout; the evaluate before it had none.
    if (inFlight) await settleWithin(inFlight, DRAW_WAIT_MS);
    return await work();
  } finally {
    const left = (navigating.get(page) ?? 1) - 1;
    if (left <= 0) navigating.delete(page);
    else navigating.set(page, left);
  }
}


/**
 * 页面停在空白的 about:blank 时，画上起始页。已经画过、正在导航、或者已经打开了真网页，都什么也不做。
 * 永远不抛错：画不上就保持原样，截图和直播照常进行。
 */
export async function ensureStartPage(
  page: Page,
  links: readonly StartLink[] = DEFAULT_START_LINKS,
): Promise<void> {
  if (page.isClosed()) return;
  if (page.url() !== "about:blank") return;
  if (navigating.has(page)) return;
  const inFlight = drawing.get(page);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      // 网站弹出的窗口（OAuth、支付）在加载前也是 about:blank，不能往里画，否则会打断它的导航。
      if (await page.opener().catch(() => null)) return;
      const empty = await withDeadline(page.evaluate(
        (mark) =>
          !document.documentElement.dataset[mark] &&
          (document.body?.childElementCount ?? 0) === 0,
        START_PAGE_MARK,
      ), DRAW_WAIT_MS, () => new Error("start page check timed out"));
      // 再查一次：evaluate 期间可能已经开始导航了。
      if (!empty || navigating.has(page) || page.url() !== "about:blank")
        return;
      await page.setContent(startPageHtml(links), {
        waitUntil: "domcontentloaded",
        timeout: 3_000,
      });
    } catch {
      // 页面在中途关闭或开始导航，下次再画。
    } finally {
      drawing.delete(page);
    }
  })();
  drawing.set(page, run);
  return run;
}

/** 自包含，不引用任何外部资源（字体、图片都不用），所以离线、受限出网时也能画出来。 */
/**
 * 起始页时钟用的时区。容器里一般是 UTC，用户看了会以为时间错了，所以默认北京时间；
 * 部署在别处可以用 COMPUTER_TIMEZONE 改（IANA 名称，如 Asia/Tokyo）。
 */
const START_PAGE_TIMEZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(
  process.env.COMPUTER_TIMEZONE ?? "",
)
  ? (process.env.COMPUTER_TIMEZONE as string)
  : "Asia/Shanghai";

const START_PAGE_TEMPLATE = `<!doctype html>
<html lang="zh-CN" data-chisabot-start="1">
<head>
<meta charset="utf-8">
<title>新标签页</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0}
  html,body{height:100%}
  body{
    font-family:-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",system-ui,sans-serif;
    color:#0f2a4a;
    background:
      radial-gradient(1200px 600px at 15% 10%,rgba(255,255,255,.75),transparent 60%),
      radial-gradient(900px 500px at 85% 90%,rgba(186,224,255,.8),transparent 60%),
      linear-gradient(160deg,#cfe8ff 0%,#a9d4ff 45%,#8ec5f5 100%);
    display:flex;align-items:center;justify-content:center;overflow:hidden
  }
  .wrap{width:min(720px,88vw);display:flex;flex-direction:column;align-items:center;gap:22px}
  .clock{font-size:72px;font-weight:300;letter-spacing:2px;color:#0b2545;line-height:1}
  .date{font-size:16px;color:rgba(15,42,74,.7);margin-top:-10px}
  form{width:100%;display:flex;gap:10px;padding:8px;border-radius:20px;
    background:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.8);
    box-shadow:0 10px 40px rgba(30,90,160,.18)}
  input{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:18px;padding:10px 14px;color:#0b2545}
  input::placeholder{color:rgba(15,42,74,.45)}
  button{border:0;border-radius:14px;padding:0 22px;font-size:16px;font-weight:600;color:#fff;
    background:linear-gradient(180deg,#3b8cf0,#2a74d6);cursor:pointer}
  .links{display:flex;flex-wrap:wrap;justify-content:center;gap:12px}
  .links a{display:flex;align-items:center;gap:8px;padding:10px 16px;border-radius:14px;text-decoration:none;
    color:#0f2a4a;font-size:15px;background:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.7)}
  .links a:hover{background:rgba(255,255,255,.7)}
  .dot{width:22px;height:22px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;
    font-size:12px;font-weight:700;color:#fff}
  .hint{font-size:14px;color:rgba(15,42,74,.6);text-align:center}
  .brand{position:fixed;left:24px;top:20px;font-size:15px;font-weight:600;color:rgba(11,37,69,.75)}
</style>
</head>
<body>
  <div class="brand">ChisaBot 浏览器</div>
  <div class="wrap">
    <div class="clock" id="clock">--:--</div>
    <div class="date" id="date"></div>
    <form id="f" autocomplete="off">
      <input id="q" name="q" placeholder="搜索，或输入网址" aria-label="搜索，或输入网址">
      <button type="submit">搜索</button>
    </form>
    <div class="links">__LINKS__</div>
    <div class="hint">新标签页。机器人打开网页时画面会出现在这里；接管后可以直接在这里搜索，或点上面的收藏网站。</div>
  </div>
<script>
  (function(){
    var c=document.getElementById('clock'),d=document.getElementById('date');
    var w=['日','一','二','三','四','五','六'];
    function p(n){return (n<10?'0':'')+n}
    var tz='__TZ__';
    function parts(t){try{var o={};new Intl.DateTimeFormat('en-US',{timeZone:tz,hour12:false,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',weekday:'short'}).formatToParts(t).forEach(function(x){o[x.type]=x.value});
      return {h:+o.hour%24,m:+o.minute,mo:+o.month,d:+o.day,w:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(o.weekday)}}
      catch(e){return {h:t.getHours(),m:t.getMinutes(),mo:t.getMonth()+1,d:t.getDate(),w:t.getDay()}}}
    function tick(){var t=parts(new Date());c.textContent=p(t.h)+':'+p(t.m);
      d.textContent=t.mo+'月'+t.d+'日 星期'+w[t.w]}
    tick();setInterval(tick,10000);
    document.getElementById('f').addEventListener('submit',function(e){
      e.preventDefault();var v=document.getElementById('q').value.trim();if(!v)return;
      var u;
      if(/^https?:\\/\\//i.test(v))u=v;
      else if(/^[^\\s]+\\.[a-z]{2,}(\\/.*)?$/i.test(v))u='https://'+v;
      else u='https://www.bing.com/search?q='+encodeURIComponent(v);
      location.href=u;
    });
  })();
</script>
</body>
</html>`.replace("__TZ__", START_PAGE_TIMEZONE);

/** 起始页上的一个常用网站（来自用户的收藏夹）。 */
export type StartLink = { title: string; url: string };

/** 没有收藏夹数据时（还没同步过）用的默认五个，和收藏夹第一次使用时的种子一样。 */
export const DEFAULT_START_LINKS: StartLink[] = [
  { title: "必应", url: "https://www.bing.com/" },
  { title: "百度", url: "https://www.baidu.com/" },
  { title: "GitHub", url: "https://github.com/" },
  { title: "维基百科", url: "https://zh.wikipedia.org/" },
  { title: "哔哩哔哩", url: "https://www.bilibili.com/" },
];

const DOT_COLOURS = ["#0f7bd8", "#2b5bd7", "#24292f", "#6b7280", "#fb7299", "#0d9488", "#7c3aed", "#ea580c"];
const KNOWN_DOTS: Record<string, [string, string]> = {
  "www.bing.com": ["B", "#0f7bd8"],
  "www.baidu.com": ["百", "#2b5bd7"],
  "github.com": ["G", "#24292f"],
  "zh.wikipedia.org": ["W", "#6b7280"],
  "www.bilibili.com": ["B", "#fb7299"],
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** 起始页 HTML。链接只收 http/https，最多 12 个；标题和网址都转义。 */
export function startPageHtml(links: readonly StartLink[] = DEFAULT_START_LINKS): string {
  const items = links
    .filter((link) => /^https?:\/\//i.test(link.url))
    .slice(0, 12)
    .map((link) => {
      let host = "";
      try {
        host = new URL(link.url).host;
      } catch {}
      const title = (link.title || host || link.url).slice(0, 40);
      const known = KNOWN_DOTS[host];
      const letter = known?.[0] ?? (Array.from(title.trim())[0] ?? "?").toUpperCase();
      let hash = 0;
      for (const ch of host) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      const colour = known?.[1] ?? DOT_COLOURS[hash % DOT_COLOURS.length];
      return `<a href="${escapeHtml(link.url)}"><span class="dot" style="background:${colour}">${escapeHtml(letter)}</span>${escapeHtml(title)}</a>`;
    })
    .join("\n      ");
  return START_PAGE_TEMPLATE.replace("__LINKS__", items);
}

/** 兼容旧的导入：默认链接的起始页。 */
export const START_PAGE_HTML = startPageHtml();


/**
 * 收藏夹变了：已经画着起始页的空白标签重新画一遍，让上面的常用网站跟着变。
 * 只动还停在 about:blank、带起始页标记、没在导航的页面。
 */
export async function redrawStartPage(page: Page, links: readonly StartLink[]): Promise<void> {
  if (page.isClosed() || page.url() !== "about:blank" || navigating.has(page)) return;
  if (await page.opener().catch(() => null)) return;
  const drawn = await page
    .evaluate((mark) => Boolean(document.documentElement.dataset[mark]), START_PAGE_MARK)
    .catch(() => false);
  if (!drawn) return;
  // 用户正在起始页的搜索框里打字时不重画，免得把字吞掉。
  const typing = await page
    .evaluate(() => (document.getElementById("q") as HTMLInputElement | null)?.value ?? "")
    .catch(() => "");
  if (typing) return;
  await page.setContent(startPageHtml(links), { waitUntil: "domcontentloaded", timeout: 3_000 }).catch(() => undefined);
}
