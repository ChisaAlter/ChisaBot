# 竖屏 / 手机网页 / PC 小窗回归（CB-098）

`mobile-portrait.mjs` 在 360×800、378×842、390×844、412×915、768×1024、1280×800 下把主要路由走一遍，分两种模式：

- `web`：普通浏览器；宽度 < 768 时开触屏，页面会带 `data-phone`（手机布局）。
- `pc`：注入 `window.chisabotWindow` 桩，页面带 `data-desktop`（PC 无边框窗口的样式和拖动区）。

每页检查：横向溢出 = 0、pageErrors = 0。窄屏下的左栏抽屉、窄于 1280 时的右侧面板抽屉检查：

- 宽度不超视口（另一边至少留 24px），内容不伸出抽屉框，抽屉里每个控件滚到可见后中心点 `elementFromPoint` 命中自己；
- 关闭方式都能关：关闭按钮、Esc、点遮罩（中间和顶部 20px）、`window.__chisabotBack()`（关了返回 true，再调返回 false）；
- 「面板 / 计算机」能来回切；PC 模式下分段器中心点不在拖动区、并且落在 no-drag 区里（Chromium 拖动区按几何合并，不看层叠）；
- web 窄屏：浏览器「返回」先关抽屉、不离开页面；按钮关掉后历史顶上不留抽屉那条记录。

只读：非 GET 请求全部拦掉。

```sh
# dev（单用户免登录，app 在 3010、server 在 3001）
BASE=http://127.0.0.1:3010 OUT_DIR=/tmp/mp CHANNEL=<一个已有会话 id> node tests/mobile-portrait/mobile-portrait.mjs
# 只跑一部分
MODES=pc SIZES=378x842 ROUTES=/channel/new node tests/mobile-portrait/mobile-portrait.mjs
```

需要 `playwright-core` 和 Chrome / Chromium（`CHROME=` 指定）。截图和 `results.json` 在 `$OUT_DIR`，退出码非 0 = 有失败项。
真 PC 客户端里拖动区由 Electron 计算，这里只是几何近似；发版前仍需在客户端里手点一次「面板 / 计算机」。
