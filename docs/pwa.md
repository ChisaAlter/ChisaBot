# 手机网页版与安装成应用（PWA）

ChisaBot 的网页版可以直接在手机浏览器里用，也可以「安装」成一个独立的应用窗口（手机主屏幕图标 / 电脑上的应用窗口）。设计规则见 `DESIGN.md` §40。

## 布局由设备决定

| 设备 | 怎么判断 | 布局 |
| --- | --- | --- |
| 手机（竖屏、横屏都算） | 主要指针是触屏且屏幕短边 < 600px，或浏览器的 UA-CH 说 `mobile` | 窄（竖屏）布局：左栏是抽屉、面板是抽屉、输入框贴底 |
| 平板、电脑浏览器、ChisaBot PC | 看窗口宽度 | < 768px 窄布局，≥ 768px 宽布局（≥ 1280 带右侧面板栏） |
| 安装后的应用（PWA） | 同上 | Windows / macOS 默认宽屏（第一次打开把窗口开到最多 1440×920），手机默认竖屏 |

- 判断在 `app/index.html` 的内联脚本里，第一帧之前把 `data-phone` / `data-ios` / `data-standalone` / `data-android-app` 写到 `<html>` 上；完整说明在 `app/src/lib/device.ts`。
- 手机横屏宽 844px 也用窄布局：`lib/device.ts` 在手机上把样式表里 `max-width ≥ 760px` 的媒体查询改成永远成立、`min-width ≥ 768px` 的改成永远不成立。
- 手动覆盖（调试或用户偏好）：浏览器控制台 `localStorage.setItem("chisabot-layout", "phone")` 或 `"wide"`，刷新生效；`removeItem` 恢复自动。
- 清单里 `orientation: "any"`：转屏不锁，布局由设备决定。

## 安装

- **安卓 Chrome / 电脑 Chrome、Edge**：打开网页版 8 秒后，顶栏下面出现「安装 ChisaBot 应用」，点「安装」弹出浏览器自己的确认；也可以从浏览器菜单「安装应用 / 添加到主屏幕」。
- **iPhone / iPad Safari**：提示里点「怎么装」看步骤：点分享按钮 → 添加到主屏幕。
- ×「不再提示」永久关掉；点「安装」后取消/超时则 14 天内不再出现（`localStorage` 的 `chisabot-install-hint`）。ChisaBot PC、安卓客户端、已经以应用方式打开时都不提示。
- 安装需要 HTTPS（或 localhost）。清单和图标在登录网关后面：清单用 `crossorigin="use-credentials"` 带上登录 cookie。

## Service worker（`app/public/sw.js`）

只做两件事，都不会挡住新版本：

1. **页面导航**：永远先走网络（navigation preload），包括登录网关的跳转；只有断网才给一张「网络不可用」卡片。index.html 从不缓存，部署后刷新一次一定拿到新入口。
2. **`/assets/*`**（带内容哈希、内容不变）：命中缓存直接给，没命中走网络，只存 200。缺失的分包服务器回 404，原样转交、不缓存——前端「分包过期自动刷新一次」（`app/src/lib/stale-chunk.ts`）照常工作。

其它请求（`/api`、`/auth`、WebSocket、非 GET、跨域、Range、`/magpie-admin`、`/downloads`）一律不拦。服务器对 `/sw.js` 和清单回 `Cache-Control: no-cache`，注册时 `updateViaCache: "none"`，部署后下一次打开就换上新的 service worker。

ChisaBot PC（Electron）和安卓客户端里不注册（已经注册过的会注销）。

### 出问题时

- 单个浏览器：控制台 `localStorage.setItem("chisabot-sw", "off")` 后刷新，页面会注销 service worker；`removeItem("chisabot-sw")` 恢复。
- 全部用户：把 `app/public/sw.js` 换成下面这几行发布一次，所有浏览器下次打开就注销它：

```js
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.registration.unregister()));
```

## 图标

`assets/brand/generate.py` 生成：`pwa-any-192/512.png`（圆角透明边，电脑上的应用图标）、`pwa-maskable-192/512.png`（满版，系统按圆 / 圆角裁切，脸和发带都在中间 80% 安全区里），`apple-touch-icon.png`（iOS 主屏幕）。
