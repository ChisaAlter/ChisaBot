# 页面（机器人做的可分享网页）

DESIGN.md §54。机器人把行程、邀请函、报告、作品集这类内容做成一个单页网页，发布在不公开列出的链接
`/p/<16 位随机串>/` 上：拿到链接的人不用登录就能看。

## 机器人工具（`server/src/pages/service.ts`）

| 工具           | 作用                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| `page_create`  | 标题 + 正文 HTML（+ 追加 CSS + 素材），默认直接发布；聊天里出页面卡片      |
| `page_update`  | 小改用 `edits`（原文 → 新文，原文须唯一），大改给整份 `html`；每次改动一版 |
| `page_get`     | 读当前版正文 / CSS / 素材，改之前用                                        |
| `page_list`    | 列出用户的页面                                                             |
| `page_publish` | 发布 / 下线（下线后链接 404，内容保留）                                    |
| `page_delete`  | 删除（只在用户明确要求时）                                                 |
- 默认外观：`server/src/pages/template.ts`，ChisaBot 蓝天毛玻璃，亮 / 暗跟随系统、手机自适应。机器人只写正文，
  用模板类名（`page` / `hero` / `card` / `grid` / `stats` / `timeline` / `item` / `badge` / `btn` / `callout` / `gallery` …）；
  写完整文档（`<!doctype html>` 开头）就原样发布。外壳在打开时才套，所以模板改进对老页面也生效。
- 素材：工作区文件（`path`，经电脑网关 `computer_download_file`，受同样的策略管）或公网图片（`url`，服务器经
  SSRF 防护下载存进库，不热链）。页面里写 `assets/<名字>`。允许的类型见 `shared/pages.ts` `PAGE_ASSET_TYPES`；
  按字节核对扩展名（PNG/JPEG/GIF/WebP/AVIF/MP4/PDF/SVG），HTML 不能当素材。
- 限制：HTML ≤ 1MB、CSS ≤ 200KB、素材每个 ≤ 8MB、每页 ≤ 40 个 / 40MB、保留最近 50 版、每人 ≤ 200 页。
- 面板后台刷新的回合拿不到页面工具；IM 回合可以用（回复里给完整链接）。

## 数据（开机建表，回滚安全）

`chisabot_pages`（一页一行，`deleted_at` 软删 24 小时后清掉）、`chisabot_page_versions`、`chisabot_page_assets`（bytea）、
`chisabot_page_origins`（浏览器报来的 `location.origin`，用来给机器人完整链接；`CHISABOT_PUBLIC_URL` 优先）。

## 安全

- `/p/` 下每个响应（页面、素材、404）都带
  `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src …; font-src …; frame-src https:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`。
  没有 `allow-same-origin`：页面在不透明的源里跑，读不到本站 Cookie / localStorage，`fetch` / XHR / WebSocket 全被挡，表单交不出去。
  另有 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`、`Permissions-Policy`。
- 只认 16 位小写字母数字的 slug（≈ 82 位熵）；没发布 / 删除 / 不存在一律同一个 404 页。
- 网关（`deploy/public/nginx.conf`）：`location ^~ /p/` 不经 `auth_request`、只放 GET/HEAD、不转发 Cookie / Authorization，
  `X-Frame-Options: SAMEORIGIN`（应用里的缩略图用 iframe 嵌）。沙箱页面自己的子资源请求在浏览器看来是
  `Sec-Fetch-Site: cross-site`，所以 `$fetch_allowed` 对 `8443/p/` 的 GET/HEAD 放行；其它路径的跨站规则不变。

## 网页

- 聊天：`page_create` / `page_update` / `page_publish` 画成页面卡片（`app/src/components/pages/page-card.tsx`）。
- 设置 → 页面（`/settings/pages`）：列表、打开、复制链接、改标题、版本历史（恢复 = 复制成新的一版）、素材（上传 / 删除）、下线 / 重新发布、删除（8 秒撤销）。
- 接口：`/api/pages`（要登录）；公开读 `/p/:slug/`、`/p/:slug/assets/:name`。
