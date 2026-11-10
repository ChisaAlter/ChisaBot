/**
 * 网站把机器人浏览器拦下来的那一页（不是人机验证，是直接拒绝）。
 *
 * 和 challenge.ts 的区别：人机验证（Cloudflare「Just a moment...」、复选框、验证码）交给人接管就能过，
 * 那条路会暂停 BOT 等人处理。这里认的是「Sorry, you have been blocked」「Access denied / Error 1020」
 * 这种硬拦截：页面上没有任何能点的东西，BOT 反复刷新只会一直看到同一页。以前它被当成普通网页，
 * BOT 读着拦截页的英文继续瞎猜，用户在「计算机」里只看到一张英文的封禁页，不知道为什么、该怎么办。
 *
 * 现在：
 *   - 给 BOT 的结果里带上 `siteBlock`，里面是一段中文说明，让它照实告诉用户、不要重试；
 *   - 在拦截页顶部盖一条中文提示（只改这张页面的 DOM，离开页面就没了），实时画面和截图里人一眼能看懂。
 *
 * 只认文字特征，不认状态码：`/read` 和 `/snapshot` 拿不到响应状态，而拦截页的文字是固定模板。
 */
import type { Page } from "playwright";

export type SiteBlock = {
  kind: "cloudflare-block" | "access-denied";
  /** 被拦的网站（拦截页上写的那个域名，读不到就用当前页面的主机名）。 */
  site: string;
  /** 给 BOT 看的中文说明，它应当照这个意思告诉用户。 */
  notice: string;
};

type Signal = { title: string; text: string; url: string };

const GENERIC_DENIED =
  /^\s*access denied\s*$|you don't have permission to access .{0,200} on this server|error\s*1020\b|request blocked\.?\s*we can'?t connect to the server/im;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function noticeFor(site: string): string {
  const name = site || "这个网站";
  return (
    `${name} 的安全防护（例如 Cloudflare）直接拦截了机器人浏览器，页面显示「已被封禁」，没有任何可用内容。` +
    `不要反复刷新或重试同一个网址。请用中文如实告诉用户：可以点右侧「计算机」里的「接管控制」亲自在这个浏览器里试一次；` +
    `如果亲自打开仍被拦，说明是服务器的出口 IP 被 ${name} 拒绝，需要部署管理员给机器人浏览器配置出口代理（部署环境变量 EGRESS_PROXY_DEFAULT，见部署文档）。` +
    `也可以先换一个能打开的来源（例如用网页搜索）继续完成用户的任务。`
  );
}

export function classifySiteBlock(signal: Signal): SiteBlock | undefined {
  const text = signal.text.slice(0, 20_000);
  const title = signal.title || "";
  const named = /you are unable to access\s+([a-z0-9.-]+\.[a-z]{2,})/i.exec(
    text,
  )?.[1];
  const site = (named || hostOf(signal.url)).replace(/\.$/, "");
  // Cloudflare 的拦截页：标题「Attention Required! | Cloudflare」或正文带「Cloudflare Ray ID」，
  // 并且正文是拦截模板。只有标题没有模板的（部分验证页）交给 challenge.ts。
  const cloudflarePage =
    /attention required!?\s*\|\s*cloudflare/i.test(title) ||
    /cloudflare ray id/i.test(text);
  if (
    cloudflarePage &&
    /sorry,\s*you have been blocked|you are unable to access|access denied|error\s*10\d\d/i.test(
      text,
    )
  )
    return { kind: "cloudflare-block", site, notice: noticeFor(site) };
  // 一般性的「Access Denied」页很短；长页面里出现这几个词多半只是正文的一部分。
  if (text.length < 3000 && (GENERIC_DENIED.test(text) || /^access denied$/i.test(title.trim())))
    return { kind: "access-denied", site, notice: noticeFor(site) };
  return undefined;
}

const BANNER_ID = "chisabot-site-block-banner";

/** 在拦截页顶部盖一条中文提示。失败（页面已经跳走等）不影响结果。 */
async function showBanner(page: Page, block: SiteBlock) {
  await page
    .evaluate(
      ({ id, site }) => {
        if (document.getElementById(id)) return;
        const dark = matchMedia("(prefers-color-scheme: dark)").matches;
        const box = document.createElement("div");
        box.id = id;
        box.setAttribute("role", "alert");
        box.style.cssText = [
          "position:fixed",
          "top:16px",
          "left:50%",
          "transform:translateX(-50%)",
          "z-index:2147483647",
          "max-width:min(640px,calc(100% - 32px))",
          "box-sizing:border-box",
          "padding:12px 16px",
          "border-radius:16px",
          `border:1px solid ${dark ? "rgba(255,255,255,.14)" : "rgba(255,255,255,.7)"}`,
          `background:${dark ? "rgba(22,30,44,.86)" : "rgba(255,255,255,.88)"}`,
          "backdrop-filter:blur(16px) saturate(1.4)",
          "box-shadow:0 8px 32px rgba(30,60,110,.18)",
          `color:${dark ? "#e8eef7" : "#1d2733"}`,
          // 拉丁字母优先用带粗体字面的字体（容器里是 Liberation Sans），中文回落到 PingFang / 雅黑 / Noto / 文泉驿。
          'font:14px/1.6 "PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC","Liberation Sans",Arial,"WenQuanYi Zen Hei",system-ui,sans-serif',
          "font-synthesis:weight",
          "text-align:left",
        ].join(";");
        const title = document.createElement("div");
        // 容器里的中文字体（文泉驿正黑）只有常规体，Chromium 在 Linux 上也不会替它合成粗体，
        // 600 会原样渲染成细字。用和文字同色的 0.6px 描边补出粗体效果；有真粗体的系统上叠一点描边几乎看不出。
        title.style.cssText =
          "font-size:16px;font-weight:700;margin-bottom:4px;-webkit-text-stroke:0.6px currentColor;paint-order:stroke fill";
        title.textContent = `${site || "这个网站"} 拦截了机器人浏览器`;
        const body = document.createElement("div");
        body.style.cssText = `font-size:13px;color:${dark ? "#b4c0d0" : "#4a5869"}`;
        body.textContent =
          "这不是 ChisaBot 出错，是对方网站的安全防护拒绝了访问。可以点「接管控制」亲自试一次；若仍被拦，通常是服务器出口 IP 被拒绝，需要管理员为浏览器配置出口代理（EGRESS_PROXY_DEFAULT）。";
        box.append(title, body);
        (document.body ?? document.documentElement).append(box);
      },
      { id: BANNER_ID, site: block.site },
    )
    .catch(() => {});
}

/** 读当前页面，判断是不是硬拦截页；是的话盖上中文提示并返回说明。 */
export async function detectSiteBlock(
  page: Page,
): Promise<SiteBlock | undefined> {
  const signal = await page
    .evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText ?? "").slice(0, 20_000),
      url: location.href,
    }))
    .catch(() => undefined);
  if (!signal) return undefined;
  const block = classifySiteBlock(signal);
  if (block) await showBanner(page, block);
  return block;
}
