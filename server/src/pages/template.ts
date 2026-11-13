/**
 * 页面的默认外观（DESIGN.md §54，docs/pages.md）：ChisaBot 自己的蓝天毛玻璃，亮 / 暗跟随系统。
 *
 * 机器人写的是一段正文 HTML（用下面这些类名），服务器在发布时套上这层外壳；写了完整文档
 * （以 <!doctype 或 <html 开头）就原样发布，不套。外壳在每次打开页面时套上，所以以后模板改好看了，
 * 老页面也跟着变好看。
 */
export const PAGE_CSS = `
:root{color-scheme:light dark;--sky-1:#84aee0;--sky-2:#a9cbeb;--sky-3:#d3e5f4;--sky-4:#edf4fa;
--glass:rgba(255,255,255,.66);--glass-2:rgba(255,255,255,.82);--line:rgba(22,36,62,.09);--edge:rgba(255,255,255,.75);
--ink-1:#111a2b;--ink-2:#3b4659;--ink-3:#5f6673;--ink-4:rgba(17,26,43,.4);--accent:#2f74f0;--accent-ink:#1f5fd6;--accent-soft:rgba(47,116,240,.12);
--ok:#17955c;--ok-soft:rgba(23,149,92,.13);--warn:#c97a0c;--warn-soft:rgba(217,138,28,.15);--bad:#d9364c;--bad-soft:rgba(217,54,76,.12);
--shadow:0 1px 2px rgba(22,36,62,.06),0 8px 28px rgba(22,36,62,.08);--r:20px;--r-sm:12px;
--font:"Sora","Inter",system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--sky-1:#0f1c33;--sky-2:#16294a;--sky-3:#1e3558;--sky-4:#264064;
--glass:rgba(22,32,54,.62);--glass-2:rgba(30,42,66,.82);--line:rgba(255,255,255,.08);--edge:rgba(255,255,255,.08);
--ink-1:#e9eef8;--ink-2:#b7c1d3;--ink-3:#8b97ab;--ink-4:rgba(233,238,248,.36);--accent:#5b95ff;--accent-ink:#8ab4ff;--accent-soft:rgba(91,149,255,.16);
--ok:#3ccf8a;--ok-soft:rgba(60,207,138,.15);--warn:#f0b04a;--warn-soft:rgba(240,176,74,.15);--bad:#ff6b80;--bad-soft:rgba(255,107,128,.14);
--shadow:0 1px 2px rgba(0,0,0,.25),0 10px 30px rgba(0,0,0,.25)}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{position:relative;margin:0;min-height:100vh;font-family:var(--font);font-size:16px;line-height:1.65;color:var(--ink-1);background:var(--sky-4);-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(180deg,var(--sky-1) 0%,var(--sky-2) 28%,var(--sky-3) 62%,var(--sky-4) 100%)}
img,video,svg{max-width:100%;height:auto}
a{color:var(--accent-ink);text-decoration:none;text-underline-offset:3px}a:hover{text-decoration:underline}
h1,h2,h3,h4{margin:0 0 .5em;line-height:1.25;letter-spacing:-.01em;color:var(--ink-1)}
h1{font-size:clamp(28px,5vw,40px);font-weight:700}h2{font-size:24px;font-weight:650}h3{font-size:18px;font-weight:600}h4{font-size:16px;font-weight:600}
p{margin:0 0 1em}p:last-child{margin-bottom:0}
ul,ol{margin:0 0 1em;padding-left:1.3em}li+li{margin-top:.3em}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}
code{font-family:var(--mono);font-size:.9em;padding:.1em .4em;border-radius:6px;background:var(--accent-soft)}
pre{font-family:var(--mono);font-size:13px;line-height:1.6;padding:16px;border-radius:var(--r-sm);background:var(--glass-2);border:1px solid var(--line);overflow:auto}
pre code{padding:0;background:none}
blockquote{margin:0 0 1em;padding:4px 0 4px 16px;border-left:3px solid var(--accent);color:var(--ink-2)}
table{width:100%;border-collapse:collapse;font-size:14px;margin:0 0 1em}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;font-weight:600;color:var(--ink-3);text-transform:none;letter-spacing:.02em}
tr:last-child td{border-bottom:0}
.table-wrap{overflow-x:auto;margin:0 0 1em}
.page{max-width:880px;margin:0 auto;padding:48px 20px 40px}
.page.wide{max-width:1120px}
.hero{padding:16px 4px 32px}
.hero .eyebrow{display:inline-block;margin-bottom:12px;font-size:13px;font-weight:600;letter-spacing:.04em;color:var(--accent-ink)}
.hero h1{margin-bottom:12px}
.hero .lead{font-size:18px;line-height:1.6;color:var(--ink-2);max-width:40em}
.hero-img{display:block;width:100%;max-height:420px;object-fit:cover;border-radius:var(--r);margin:0 0 28px;box-shadow:var(--shadow)}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.chip,.badge{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:999px;font-size:13px;font-weight:500;color:var(--ink-2);background:var(--glass);border:1px solid var(--edge);backdrop-filter:blur(12px)}
.badge{height:22px;padding:0 9px;font-size:12px;color:var(--accent-ink);background:var(--accent-soft);border-color:transparent}
.badge.ok{color:var(--ok);background:var(--ok-soft)}.badge.warn{color:var(--warn);background:var(--warn-soft)}.badge.bad{color:var(--bad);background:var(--bad-soft)}
.card{position:relative;margin:0 0 16px;padding:24px;border-radius:var(--r);background:var(--glass);border:1px solid var(--edge);box-shadow:var(--shadow);backdrop-filter:blur(22px) saturate(1.2)}
.card>:last-child{margin-bottom:0}
.card.tight{padding:16px}
.section{margin:40px 0 0}.section>h2{margin-bottom:16px}
.section-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px}
.muted{color:var(--ink-3)}.small{font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:16px;margin:0 0 16px}
.grid>.card{margin:0}
.grid.two{grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr));gap:12px;margin:0 0 16px}
.stat{padding:16px 18px;border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--edge);backdrop-filter:blur(16px)}
.stat .value{display:block;font-size:28px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;white-space:nowrap}
.stat .label{display:block;margin-top:4px;font-size:13px;color:var(--ink-3)}
.timeline{position:relative;margin:0 0 16px;padding:0;list-style:none}
.timeline>li{position:relative;margin:0;padding:0 0 20px 28px}
.timeline>li::before{content:"";position:absolute;left:5px;top:8px;width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
.timeline>li::after{content:"";position:absolute;left:9.5px;top:24px;bottom:0;width:1px;background:var(--line)}
.timeline>li:last-child::after{display:none}
.timeline .time{display:block;font-size:13px;font-weight:600;color:var(--accent-ink);font-variant-numeric:tabular-nums}
.timeline .title{display:block;font-weight:600}
.day{margin:0 0 16px}.day>h3{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px}.day>h3 .muted{font-size:14px;font-weight:500}
.item{display:flex;gap:14px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)}
.item:last-child{border-bottom:0}.item .icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:var(--accent-soft);font-size:20px}
.item .body{min-width:0;flex:1}.item .title{font-weight:600}.item .sub{font-size:14px;color:var(--ink-3)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 20px;border-radius:999px;font:inherit;font-size:15px;font-weight:600;color:#fff;background:var(--ink-1);border:0;cursor:pointer;text-decoration:none;transition:transform .18s cubic-bezier(.22,.8,.24,1),opacity .18s}
@media (prefers-color-scheme:dark){.btn{color:#0f1c33;background:#e9eef8}}
.btn:hover{text-decoration:none;transform:translateY(-1px)}.btn:active{transform:scale(.98)}
.btn.secondary{color:var(--ink-1);background:var(--glass-2);border:1px solid var(--edge)}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0 0}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr));gap:12px;margin:0 0 16px}
.gallery img,figure img{display:block;width:100%;border-radius:var(--r-sm);object-fit:cover}
.gallery img{aspect-ratio:4/3}
figure{margin:0 0 16px}figcaption{margin-top:8px;font-size:13px;color:var(--ink-3)}
.profile{display:flex;gap:20px;align-items:center;flex-wrap:wrap}.avatar{width:96px;height:96px;border-radius:50%;object-fit:cover;box-shadow:var(--shadow)}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.callout{padding:14px 16px;border-radius:var(--r-sm);background:var(--accent-soft);color:var(--ink-1);margin:0 0 16px}
.callout.warn{background:var(--warn-soft)}.callout.ok{background:var(--ok-soft)}
.center{text-align:center}
.page-foot{max-width:880px;margin:24px auto 0;padding:0 20px 32px;font-size:12px;color:var(--ink-4);text-align:center}
.page-foot a{color:inherit}
@media (max-width:600px){.page{padding:28px 16px 32px}.card{padding:18px}.hero{padding:8px 2px 24px}.hero .lead{font-size:16px}}
@media (prefers-reduced-motion:no-preference){.card,.stat,.hero{animation:pg-in .5s cubic-bezier(.22,.8,.24,1) backwards}
.page>:nth-child(2){animation-delay:.04s}.page>:nth-child(3){animation-delay:.08s}.page>:nth-child(4){animation-delay:.12s}
@keyframes pg-in{from{opacity:0;transform:translateY(8px)}}}
@media print{body{background:#fff}.card,.stat{box-shadow:none;backdrop-filter:none;background:#fff;border-color:#ddd}.page-foot{display:none}}
`;

/** 给机器人的模板说明（写进 page_create 的工具说明）。 */
export const PAGE_TEMPLATE_GUIDE = [
  "默认外观是 ChisaBot 的蓝天毛玻璃（亮 / 暗跟随系统、手机自适应），你只写 <body> 里的正文 HTML，用这些类名：",
  '外层 <main class="page">（宽版加 wide）；开头 <header class="hero"><span class="eyebrow">小标题</span><h1>标题</h1><p class="lead">一句话</p><div class="meta"><span class="chip">📅 10月20日</span></div></header>；',
  '可选头图 <img class="hero-img" src="assets/cover.jpg" alt="">；内容块 <section class="card"><h2>…</h2>…</section>，或 <section class="section"><h2>…</h2>多个 .card</section>；',
  '并排 <div class="grid">（两列 grid two）；数字 <div class="stats"><div class="stat"><span class="value">12</span><span class="label">说明</span></div></div>；',
  '行程 / 日程 <ol class="timeline"><li><span class="time">09:00</span><span class="title">事项</span><p class="muted small">说明</p></li></ol>，按天分组用 <div class="day card"><h3>第 1 天 <span class="muted">10月20日 周一</span></h3>…</div>；',
  '列表行 <div class="item"><span class="icon">🏨</span><div class="body"><div class="title">…</div><div class="sub">…</div></div></div>；',
  '标签 <span class="badge">（ok / warn / bad）；按钮 <div class="actions"><a class="btn" href="…">主要</a><a class="btn secondary" href="…">次要</a></div>；',
  '提示 <div class="callout">（warn / ok）；图集 <div class="gallery"><img src="assets/1.jpg" alt=""></div>；个人简介 <div class="profile"><img class="avatar" src="assets/me.jpg" alt=""><div>…</div></div>；',
  '表格直接用 <table>（宽表外面包 <div class="table-wrap">）；文字辅助类 muted / small / center。',
  "要更个性就加 css 参数（只追加，不要整份重写）；想完全自己设计才写完整 HTML 文档。",
].join("");

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** 是不是一整份文档（这种就不套外壳）。 */
export function isFullDocument(html: string) {
  return /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(
    html,
  );
}

/** 正文里没有 .page 外层时自动包一层，免得内容贴着屏幕边。 */
function wrapBody(html: string) {
  return /class\s*=\s*["'][^"']*\bpage\b/.test(html)
    ? html
    : `<main class="page">\n${html}\n</main>`;
}

export function composePage(input: {
  title: string;
  description?: string | null;
  html: string;
  css?: string | null;
  footer?: boolean;
}) {
  const title = escapeHtml(input.title);
  const description = input.description ? escapeHtml(input.description) : "";
  const extraCss = input.css?.trim()
    ? `\n<style>\n${input.css.replace(/<\/style/gi, "<\\/style")}\n</style>`
    : "";
  if (isFullDocument(input.html)) {
    // 完整文档原样发，只在 <head> 里补上 viewport / 额外样式（没有 head 就不动）。
    let html = input.html;
    if (extraCss)
      html = /<\/head>/i.test(html)
        ? html.replace(/<\/head>/i, `${extraCss}\n</head>`)
        : html + extraCss;
    return html;
  }
  const foot =
    input.footer === false
      ? ""
      : `\n<footer class="page-foot">用 ChisaBot 制作</footer>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>${description ? `\n<meta name="description" content="${description}">\n<meta property="og:description" content="${description}">` : ""}
<meta property="og:title" content="${title}">
<style>${PAGE_CSS}</style>${extraCss}
</head>
<body>
${wrapBody(input.html)}${foot}
</body>
</html>
`;
}

/** 下线 / 不存在时的页面（同一套外观，不说是谁的、有没有过）。 */
export function notFoundPage() {
  return composePage({
    title: "页面不存在",
    html: `<main class="page"><section class="card center" style="margin-top:12vh"><h1>页面不存在</h1><p class="muted">这个链接可能写错了，或者页面已经下线。</p></section></main>`,
    footer: false,
  });
}
