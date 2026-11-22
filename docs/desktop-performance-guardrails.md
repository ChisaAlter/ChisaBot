# 桌面端流畅度与竖屏防卡顿/防回跳硬红线

本文档沉淀 2026-11-22 桌面端全面流畅度治理、Windows 小窗切换卡顿修复与竖屏面板回跳根治中实证的全部根因、工程红线、实测前后对比与防复发门禁，与 [DESIGN.md](../DESIGN.md)（§41、§147–§151、§153）配套执行。

在修改 PC Electron 外壳、聊天滚动容器、玻璃材质与样式层、或高频 React Context / 侧栏 / 右栏 / 输入框之前，必须逐条核对对应域的硬红线。

---

## 一、PC Electron 壳层与窗口缩放

### 1.1 Windows 小窗 16ms `setBounds` 补间循环与最大化二次闪跳

- **现象与触发路径**：点击顶栏小窗模式图标或按 `Ctrl+Shift+M` 在宽窗（`1280×840`）与小窗（`420×860`）间切换时，Windows 端界面剧烈卡死 3.7–5.4 秒，窗口边缘颤动，且从最大化进/出小窗时会出现先跳回旧普通尺寸再缩/放的二次闪跳。
- **根因（文件与机制）**：
  - `pc/src/compact-window.js` 原实现在 Windows/Linux 上用主进程 `setTimeout(step, 16)` 连续 240ms 调用约 15 次 `win.setBounds(lerpBounds(...))`，且 `lerpBounds` 对 `x` 与 `width` 独立取整导致右缘 ±1px 抖动。每次 `setBounds` 均触发 Win32 `SetWindowPos` / DWM SwapChain 重建与渲染进程全树 4,500+ 节点样式重算、布局与磨砂重绘；单步已超 300ms 时，15 步循环将卡顿放大近 10 倍。
  - 进入小窗前先同步 `unmaximize()` / `setFullScreen(false)` 再读 `win.getBounds()`，退出小窗时先补间回普通尺寸再放大，导致最大化场景下出现明显二次闪跳。
- **硬红线**：
  - **禁止**在 Windows/Linux 上用 `setTimeout` / `setInterval` 循环调用 `win.setBounds()` 模拟窗口缩放动画；Windows/Linux 小窗进出必须单次原子 `win.setBounds(target)` 落位（不修改窗口 `opacity`，避免 Win11 `thickFrame` 阴影或黑闪）；仅 macOS 保留原生 `setBounds(target, true)` 动画，并遵守 `reducedMotion`。
  - 进入小窗必须在退出最大化前基于当前工作区算好目标矩形并紧接原子落位，配短护栏（`COMPACT_SETTLE_MS = 120`）挡住异步晚到的旧宽度 `resize`；退出小窗恢复最大化/全屏必须在单次 `setBounds(restoreBounds)` 后立刻同步调用 `maximize()` / `setFullScreen(true)`；仅当窗口宽度 `<= LEAVE_WIDTH` 时才记录 `lastCompact`。
- **防复发自动门禁**：`pc/test/compact.check.js`（覆盖 Windows 单次原子落位与短护栏、最大化进出零二次闪跳、macOS 原生动画与 `reducedMotion`）。

### 1.2 本地协议 `ses.protocol.handle` 热路径同步磁盘检查与全站流量 JS 逐块转发

- **现象与触发路径**：PC 桌面端每次加载前端静态资源、调用 API 或接收 SSE 流式回复时，主进程事件循环出现额外 I/O 阻塞与内存拷贝，放大流式输出与页面切换延迟。
- **根因（文件与机制）**：
  - `pc/src/local-web.js` 在 `ses.protocol.handle` 热路径中对每个请求同步调用 `fs.existsSync` / `statSync` 探测本地 bundle 文件。
  - 未命中的 API、SSE 与外域请求此前统一经主进程 `net.request` 读取并逐 chunk 拷贝转发回协议响应流，增加主进程调度与拷贝开销；无本地 bundle 时也挂载了协议拦截器。
- **硬红线**：
  - 本地静态资源索引必须在启动时预建内存表（`bundleIndex`），**禁止**在 `ses.protocol.handle` 请求热路径调用 `fs.existsSync` / `statSync` / `readFileSync`；静态文件响应须使用有界 LRU 内存缓存（含并发 in-flight 去重），无本地 bundle 时不得挂载协议处理器。
  - 非导航 API / 静态 / 外域流量必须走 `ses.fetch(request, { bypassCustomProtocolHandlers: true })` 零 JS chunk 拷贝直通；仅文档导航与 `/auth`、`/login`、`/sign`、`/logout` 保留 `net.request` + `redirect: "manual"` 以维持 302 `will-redirect` 语义。
- **防复发自动门禁**：`pc/test/local-web.check.js`（热路径零同步 FS 断言、`ses.fetch` 零拷贝透传、导航 302 保留）。

### 1.3 出网白名单逐请求重复解析 URL 与正则归一化

- **现象与触发路径**：窗口发起大量并发请求、媒体加载或轮询时，主进程 `ses.webRequest.onBeforeRequest` 钩子重复分配对象并执行正则处理。
- **根因（文件与机制）**：`pc/src/desktop-prefs.js` 与 `pc/src/main.js` 过去在每次 `onBeforeRequest` 回调中重新 `new URL(serverOrigin)` 并对 `allowedDomains` 逐项做正则归一化比对。
- **硬红线**：
  - 出网策略必须通过 `compileEgressPolicy({ serverOrigin, allowedDomains })` 预编译 `serverHost` / `Port` / `Protocol`、`exactHosts` `Set` 与 `wildcardDotSuffixes` 并在 `main.js` 缓存，仅在配置变更时重编；**禁止**在 `onBeforeRequest` 热路径重复构造 `serverOrigin` URL 对象或重新编译通配符规则。
- **防复发自动门禁**：`pc/test/local-web.check.js`（`compileEgressPolicy` 语义等价校验）、`server/tests/bot-library-and-webhooks.test.ts`（`desktop-prefs` 用例）。

### 1.4 更新下载进度高频触发同步读盘与托盘重建

- **现象与触发路径**：后台下载桌面端新版本期间，每秒多次进度回调引发主进程卡顿与 UI 操作掉帧。
- **根因（文件与机制）**：`pc/src/main.js` 中 `updater.onState` 在 `download-progress` 高频回调里无条件调用 `refreshTray()`（反复从磁盘读图新建托盘图标与菜单）并向全部窗口群发 `state:changed`。
- **硬红线**：
  - 托盘 `nativeImage` 必须缓存，`refreshTray()` 必须按状态签名去重，状态未变化时**禁止**重复更新托盘图标、Tooltip 或重建菜单。
  - `download-progress` 期间仅广播更新进度（`sendUpdateState()`），状态键未变时**禁止**触发 `refreshTray()` 或全窗口广播 `state:changed`。
- **防复发自动门禁**：`pc/test/update-window.check.js`、`pc/test/update.check.js`、`pc/test/shell.check.js`。

### 1.5 前端双份 `useDesktopWindow()` 订阅与 250ms 轮询双写 `<html>`

- **现象与触发路径**：切换小窗、最大化或窗口 resize 时，`<html>` 的 `data-compact` / `data-maximized` 属性与 `--edge-clip-r` 被重复写入两次，且常驻两套 250ms `setInterval`。
- **根因（文件与机制）**：`GlassTopBar` 与全局常驻 `DesktopStrip` 各自实例化 `useDesktopWindow()`（`app/src/lib/desktop-window.ts`），各自注册 IPC 监听、`resize` 监听和 250ms 定时器。
- **硬红线**：
  - `useDesktopWindow()` 必须保持模块级 `useSyncExternalStore` 单例（零裸 `useEffect`），多个消费组件共享唯一一份 IPC 订阅、`resize` 监听、边缘裁切定时器和 `<html>` 属性写入；末消费方卸载时自动拆除并清理 `--edge-clip-r`。
- **防复发自动门禁**：`app/tests/desktop-window-edge-clip.test.tsx`、`app/tests/no-raw-use-effect.test.ts`。

---

## 二、竖屏滚动与锚点回跳

### 2.1 `< 1280px` 开关面板抽屉卸载重挂 `presenceRef("has-narrow-rail")` 引发 `padding-right` 抖动

- **现象与触发路径**：在竖屏或窄窗（`< 1280px`，如 `420×860`）打开再关闭右侧面板抽屉时，聊天记录瞬间倒退 8 条消息（`scrollHeight` 跳变 `1980px`），随后耗时约 500ms（55 帧）平滑滑回底部；上滑看历史时打开面板则直接被夹到底丢失阅读位置；流式回复中打开面板会闪现约 `2100px` 整屏空白。
- **根因（文件与机制）**：
  - `app/src/components/panels/panel-rail.tsx` 在 `!wide` 下通过条件渲染 `{sheetOpen ? null : <button ref={presenceRef("has-narrow-rail")} />}` 隐藏把手，导致开关抽屉同步移除/恢复 `body[data-has-narrow-rail]`。
  - `app/src/styles.css` 依据 `body[data-has-narrow-rail]` 切换 `[data-testid="chat-transcript"]` 的 `padding-right`（`30px ↔ 16px` 或 `38px ↔ 16px`），触发 Blink `ScrollAnchorDisablingPropertyChanged` 放弃 `overflow-anchor`。
  - `SettleAtEnd.reflowed()`（`app/src/components/channels/chat-transcript.tsx`）原只比较包含 padding 的 `content.clientWidth`，无法察觉净内容宽度已因 `padding-right` 改变，漏判回退为 `behavior: "smooth"` 回追。
- **硬红线**：
  - `< 1280px` 模式下 `body[data-has-narrow-rail]` 必须由 `PanelRail` 顶层 `usePresenceFlag("has-narrow-rail", "body", !wide)` 稳定维护，**禁止**挂在随抽屉开关卸载重挂的按钮上，保证开关面板全程聊天列 `padding-right` 恒定零跳变。
  - `SettleAtEnd.reflowed()` 必须追踪内容盒净宽（优先读 `ResizeObserverEntry.contentBoxSize[0].inlineSize`，正常 `onScroll` 零 `getComputedStyle`），**禁止**仅以包含 padding 的 `clientWidth` 作为是否换行的唯一判定。
- **防复发自动门禁**：`app/tests/narrow-rail-sheet-stability.test.tsx`、`app/tests/settle-reflow-instant.test.tsx`、`tests/chat-scroll/portrait-panel-jump.mjs`。

### 2.2 宽度重排走 `smooth` 与 `MessageScroller.handleResize` 传 `behavior: "auto"` 反复重启平滑滚动

- **现象与触发路径**：桌面竖屏（如 `780×900/1050`）展开/收起左侧边栏、呼出 `Ctrl+K` 或窗口变窄触发消息换行时，底部出现 `70–90px` 缝隙或可见的平滑追底动画。
- **根因（文件与机制）**：
  - `SettleAtEnd` 命中宽度换行重排时调用了 `stickToBottom(s.busy)`，在空闲态传入 `behavior: "smooth"`，过渡期间被下一帧 `look()` 误判脱离底部。
  - `app/src/vendor/shadcn-react-message-scroller/lib/index.js` 中 `handleResize (Ee)` 调用 `scrollToEnd({ behavior: "auto" })`；当滚动容器启用 `.scroll-smooth`（`scroll-behavior: smooth`）时，`"auto"` 会解析为 `"smooth"`，导致容器宽度缩放期间每帧反复重启平滑滚动。
- **硬红线**：
  - 凡由容器宽度变化或消息重新换行触发的贴底同步（`SettleAtEnd` 换行支路与 `MessageScroller.handleResize`），**必须**传入 `behavior: "instant"` 同帧瞬时锁底，**禁止**传 `"smooth"` 或 `"auto"`。
- **防复发自动门禁**：`app/tests/settle-reflow-instant.test.tsx`、`tests/chat-scroll/portrait-panel-jump.mjs`、`tests/chat-scroll/work-card-jump.mjs`。

### 2.3 `ResizeObserver` 默认 `content-box` 漏检 `--chat-composer-h` 改写 `padding-bottom`

- **现象与触发路径**：输入框展开/收起或高度变化更新 `--chat-composer-h`（改变消息列表底部 `padding-bottom`）时，消息末尾与输入框之间出现约 `56px` 缝隙，未自动补齐贴底。
- **根因（文件与机制）**：`SettleAtEnd` 与 `MessageScrollerContent` 此前对 `content` 注册 `ResizeObserver` 时未指定 `{ box: "border-box" }`，仅 `padding-bottom` 变化不会触发 `content-box` 尺寸回调。
- **硬红线**：
  - 观测消息列表内容容器（`[data-testid="chat-transcript"]` / `MessageScrollerContent`）的 `ResizeObserver` 必须传入 `{ box: "border-box" }`（保留不支持时的兼容兜底），确保 `--chat-composer-h` 改写 `padding-bottom` 能够立即驱动缓存失效与贴底同步。
- **防复发自动门禁**：`app/tests/settle-reflow-instant.test.tsx`、`tests/chat-scroll/portrait-panel-jump.mjs`。

### 2.4 `MessageScroller` 滚动热路径反复 `getComputedStyle`、重复写属性与写后读强排

- **现象与触发路径**：在 240 条历史消息中滚轮滚动时，Chrome Trace 记录到 `message-scroller` 内 81 次全树 4,553 节点 `UpdateLayoutTree`，单次滚动场景仅强排即耗 `20.8s`（4x CPU），帧率跌至 `3.6 fps`（`mist`）。
- **根因（文件与机制）**：
  - `app/src/vendor/shadcn-react-message-scroller/lib/index.js` 在 `syncAfterScroll → commitScrollState → Se → We(e)` 中每次滚动都对内容节点调 `getComputedStyle(e)` 读取 `paddingBlockStart` / `paddingBlockEnd`。
  - `K(s)` 每次滚动无脏检查直接 `setAttribute`/`removeAttribute` 写 `data-scrollable`、`data-autoscrolling` 等属性，把 4,553 个后代节点标脏。
  - `onScroll` 处理器按 `F(), w(), Z()` 顺序先写属性后立即调用 `Z()` 读 `getBoundingClientRect()`，造成经典 Write-then-Read 同步强制重排。
- **硬红线**：
  - `We(e)` 的块向 padding 必须使用 `WeakMap` 缓存，仅在 `setContentElement`、`handleResize`、`scrollToElement` 失效，滚动热路径对 `content` **零 `getComputedStyle`**。
  - 滚动容器上所有 `data-*` 状态属性写入必须先做 `getAttribute`/`hasAttribute` 脏检查去重，值未变不得写入 DOM。
  - `onScroll` 热路径必须严格遵循 **Read-before-Write**（先 `Z()` 读几何量，再 `F(), w()` 写属性/同步状态）。
- **防复发自动门禁**：`app/tests/settle-reflow-instant.test.tsx`（断言连续 10 次滚动对 `content` 零 `getComputedStyle`）、`app/tests/message-scroller-visible-measure.test.tsx`、`perf/jank.mjs`。

---

## 三、渲染合成、玻璃材质与 CSS/DOM

### 3.1 滚动区全量气泡/卡片叠加高半径 `backdrop-filter` 与 `liquid` SVG 位移透镜风暴

- **现象与触发路径**：聊天页开启壁纸并渲染百余条消息时，页面存在 `160–186` 个并发 `backdrop-filter` 合成层；默认 `mist` 滚轮仅 `3.6 fps`，切换 `liquid` 模式流式输出直接跌至 `2.2 fps`（`p95 = 2,971ms`，`forcedMs = 3,961ms`）。
- **根因（文件与机制）**：
  - `app/src/styles.css` 给滚动区内每一条 `[data-slot="bubble-content"]` 与聊天卡片施加了与大面板相同的 `20px`（`mist`）/ `28px`（`frosted`）大半径高斯模糊，且气泡内部 Streamdown 代码块/操作条还会二次嵌套 `backdrop-blur`。
  - `app/src/lib/liquid-glass.ts` 的 `LENS_SKIP_SELECTOR` 漏掉了 `[data-slot="bubble-content"]` 及 `.jr-card` / `.cf-card` / `.gh-card` / `.page-card` / `.schedule-card` / `.bot-exchange-card` / `.chat-question` / `.chat-work-steps` / `.chat-draft-card` / `.chat-history-notice` / `.chat-history-more` / `.to-card` / `.hr-card`，导致 `liquid` 模式下为每条气泡同步逐像素构建位移图 PNG 并挂 9 原语 SVG 滤镜。
- **硬红线**：
  - 滚动区聊天气泡与对话卡片在保留 §151 四档磨砂质感的前提下，必须通过 0 特异度 `:where` 覆写轻量 `--lg-blur`（`mist` `8px`、`frosted` `10px`、`crystal` `6px`），**禁止**在气泡内二次嵌套 `backdrop-filter`；裸代码块气泡保持 `--lg-blur: none`，且绝不覆盖性能模式与减少透明度规则。
  - 所有滚动区聊天气泡与聊天卡片类必须常驻 `liquid-glass.ts` 的 `LENS_SKIP_SELECTOR`，**禁止**为高频滚动元素挂载 SVG 位移透镜；大面板位移图在 `mapFor()` 中必须按尺寸做 2×–4× 降采样生成。
- **防复发自动门禁**：`app/tests/liquid-glass-screen-ink.test.ts`、`app/tests/render-budget.test.ts`、`app/tests/theme-glass-perf.test.tsx`、`app/tests/no-backdrop.test.ts`。

### 3.2 `liquid-glass.ts` 非液态模式常驻全树观察器与 `liquid` 读写交错强排

- **现象与触发路径**：即使使用默认 `mist`（非 `liquid`）或性能模式，流式输出、打字、开弹窗、停滚都会在后台扫描全文档 59 个玻璃选择器并反复清理属性；开启 `liquid` 时每轮采样引发 O(N) 强排。
- **根因（文件与机制）**：
  - `app/src/lib/liquid-glass.ts` 启动时无条件挂载全树 `MutationObserver`、`ResizeObserver` 与捕获阶段 `window scroll`，非液态模式下每次 DOM 变动仍跑 `GLASS_SURFACE_SELECTOR` 匹配、`syncWallpaperWatch()` 和 `rescan()` 全页查询；每次停滚 150ms 后 `clearAdapted()` 无脏标记全页 `querySelectorAll` 清属性。
  - `liquid` 模式下 `onMutations` 未跳过自身 `svgHost`/`lensStyle` 形成自激，且 `sample()` → `applyAdapt()` 在循环内交错写属性与调 `getComputedStyle(el).getPropertyValue("--lg-alpha")`、重复调 `getBoundingClientRect()`。
- **硬红线**：
  - `LiquidGlass` 在非 `liquid` 或被抑制（`data-perf` / `prefers-reduced-transparency`）时必须保持休眠：仅保留监听 `<html>` 属性的轻量 `htmlObs`，断开 `mutationObs`、`resizeObs`、捕获 `scroll` 与天空/壁纸监听，且仅在 `hasAdapted === true` 时做一次性清理。
  - `liquid` 模式下 `onMutations` 必须跳过 `svgHost`/`lensStyle` 与纯文本变动；`rescan()` 必须先用零布局 `el.closest(LENS_SKIP_SELECTOR)` 预筛并合并为单次几何/样式读取；`sample()` 必须严格分 Read / Compute / Write 三阶段，全局 `--lg-alpha` 从 `#chisabot-glass-alpha` CSSOM 一次性读取（零逐元素 `getComputedStyle`）。
- **防复发自动门禁**：`app/tests/liquid-glass-screen-ink.test.ts`（含 `mist` 模式下 DOM 变更/滚动 0 次 `getBoundingClientRect` 扫描与气泡跳过 SVG 透镜回归用例）、`app/tests/liquid-glass.test.ts`。

### 3.3 全屏遮罩双层模糊与菜单/浮层/抽屉缺失 `glass-hold`

- **现象与触发路径**：打开/关闭弹窗、头像选择器、新建任务、灯箱、菜单或窄窗抽屉 `.hk-drawer` 时掉帧明显，桌面 1x CPU 下 `p3-desktop-popups` 曾达 `maxInpMs = 240ms`、`paint = 334ms`。
- **根因（文件与机制）**：
  - `dialog.tsx`、`sheet.tsx`、`avatar-picker.tsx`、`create-task.tsx` 与 `chat-transcript.tsx` 灯箱在全屏遮罩上挂了 `supports-backdrop-filter:backdrop-blur-xs/sm`，与玻璃弹窗内容叠加形成全屏双层模糊。
  - `styles.css` 原仅给 `dialog`/`sheet` 配了 `glass-hold` 与 `[data-ending-style]` 去模糊，下拉菜单、Popover、Select、业务小浮层与 `.hk-drawer` 均未在开合动画期间剥离模糊，且静止态使用与大面板相同的 `20px`/`28px` 模糊。
- **硬红线**：
  - **禁止**在全屏弹窗/抽屉/灯箱遮罩上叠加 `backdrop-blur-*`，遮罩仅保留轻量半透暗底（暗色弹窗遮罩 alpha `<= 0.28`，见 §147）。
  - 全站菜单、Popover、Select、Combobox、业务浮层与 `.hk-drawer` 必须在起始/退出/关闭态剥离 `--lg-blur: none; backdrop-filter: none;`；transition 驱动弹层与 `.hk-drawer` 打开过渡期必须使用 `glass-hold` 暂停模糊（不干扰 Tailwind `animate-in` 菜单自身动效），静止态菜单/小浮层收敛至 `12px` 轻模糊。
- **防复发自动门禁**：`app/tests/glass-hold-panels.test.ts`、`app/tests/mobile-drawer.test.tsx`、`app/tests/theme-glass-perf.test.tsx`、`app/tests/render-budget.test.ts`。

### 3.4 窗口缩放期过渡与 7 项 `@property` 过渡滥用

- **现象与触发路径**：窗口缩放或切换玻璃参数时，数百条气泡与静态卡片同步跑 7 个注册自定义属性的主线程插值动画。
- **根因（文件与机制）**：`app/src/styles.css` 移除了 `resize-pause.css`（§148 避免黑闪）后未保留纯粹的 `transition: none` 抑制，且将 7 个 `@property` 过渡挂到了 `[data-slot="bubble-content"]`、`.jr-card`、设置页静态卡片等 50 余类选择器上。
- **硬红线**：
  - `html[data-resizing]` 规则内**严禁**出现 `backdrop-filter`、`--lg-blur`、`--glass-bg-opaque`（防止恢复拉伸黑闪，§148），但应仅对主框架面板、侧栏槽与壁纸层设 `transition: none`。
  - **禁止**在聊天气泡和设置页静态大列表卡片上挂载 7 项 `@property` 过渡；完整自适应属性过渡仅在 `html[data-glass="liquid"]` 的主框架与胶囊上启用。
- **防复发自动门禁**：`app/tests/resize-pause.test.ts`、`app/tests/liquid-glass.test.ts`。

### 3.5 `.glass-shell` 全局双层模糊 `text-shadow` 波及长文气泡

- **现象与触发路径**：深色或浅色壁纸模式下渲染长篇 Markdown 回复或滚动对话时，文本光栅化成本高。
- **根因（文件与机制）**：`app/src/styles.css` 对 `.glass-shell` 施加双层模糊 `text-shadow: 0 1px 2px ..., 0 0 1px ...`，继承穿透到每一条聊天气泡与卡片里的上千个字形。
- **硬红线**：
  - 壁纸光学字缘描影（§145）仅用单层轻影（`0 1px 1px`），且自带完整磨砂釉面的 `[data-slot="bubble-content"]`、`.jr-card`、`.page-rows`、`.sg-card`、`.chat-work-steps`、`.chat-draft-card` 必须列入 `text-shadow: none` 豁免名单；仅直接裸浮于壁纸上的文字保留描影。
- **防复发自动门禁**：`app/tests/a11y-contrast.test.ts`（确保对比度模型全族全表面 WCAG AA >= 4.5:1）。

### 3.6 壁纸模式下冗余全屏背景层与天空引擎定时器空转

- **现象与触发路径**：用户启用自定义/预设壁纸后，GPU 仍绘制被遮挡的多重渐变、星空与流光球，主线程每秒仍被天空引擎唤醒。
- **根因（文件与机制）**：
  - `body` 多重 `radial-gradient`、`body::before` 星空、`#skyph` 与 `.chisabot-ambient-orbs` 在 `html[data-wallpaper="on"]` 下仍处于渲染树中，`#sky-root` 缺少 `contain: strict`。
  - `app/public/wallpaper_core.html` 内部直接调用 `setInterval(tick, 1000)` 与 `setInterval(fetchWeather, 10 * 60 * 1000)`，未受 `sky.mode === "off"` 或 `document.hidden` 控制。
- **硬红线**：
  - `#sky-root` 必须保留 `contain: strict`；`html[data-wallpaper="on"]` 下必须关闭 `body` 的 `background-image`（保留纯色 `background-color` 首帧兜底），并 `display: none` 隐藏 `body::before`、`#skyph` 与 `.chisabot-ambient-orbs`。
  - `app/src/components/sky-background.tsx` 启动引擎脚本时必须注入受控 `engineSetInterval`，在 `sky.mode === "off"` 或 `document.hidden` 时跳过 `tick` 与 `fetchWeather`。
- **防复发自动门禁**：`app/tests/perf-noblur-filter.test.ts`、`app/tests/a11y-modes.test.ts`、`app/tests/wallpaper-loading.test.tsx`、`app/tests/sky-snapshot.test.ts`。

### 3.7 历史气泡残留 `motion.div` 合成层与状态胶囊旋转图标牵连重绘

- **现象与触发路径**：百条历史消息页面额外持有大量永久 `transform` 合成层；思考/干活胶囊的旋转图标每帧牵连父级磨砂背景重光栅化。
- **根因（文件与机制）**：
  - `app/src/components/chat/bot-bubbles.tsx` 对每一条历史气泡无条件渲染 `<motion.div animate={{ opacity: 1, transform: "translateY(0px)" }}>`，即便 `initial={false}` 也会在 DOM 上永久保留内联 `transform: translateY(0px)` 迫使浏览器分配独立合成层。
  - `app/src/components/chat/status-capsule.css` 的 `.rs-spinner`（0.9s 无限旋转）缺少 `will-change: transform`。
- **硬红线**：
  - 历史消息与每条消息首段**禁止**包裹 `<motion.div>`，直接渲染普通 `<div>`；入场动画必须使用数值 `y: 0`（动画结束后自动还原 `transform: none`），并锁定首次挂载开关避免流式结束切换元素类型导致正文重挂载。
  - 磨砂胶囊内的高频旋转/脉冲图标（如 `.rs-spinner`）必须声明 `will-change: transform` 隔离合成层。
- **防复发自动门禁**：`app/tests/chat-bubbles.test.ts`、`app/tests/reply-steps.test.tsx`、`app/tests/wave3-smoothness.test.tsx`。

### 3.8 大容器 `:has()`、重型阴影、滤镜过渡与消息行布局隔离

- **现象与触发路径**：流式输出或顶栏变动触发整个容器样式重算；大阴影和 `filter` 过渡加重 GPU 负担。
- **根因（文件与机制）**：
  - `app/src/styles.css` 残留 `html[data-desktop] .glass-topbar:has(.win-ctrls[data-count="3"])`；`--shadow-3` 模糊半径高达 `80px`/`90px`；`liquid` 模式 `--lg-edge-light`/`--lg-edge-dark` 堆叠 7 层阴影；`.win-ctrl svg` 存在 `transition: filter`；消息行 `[data-slot="message-scroller-item"]` 缺少布局隔离。
- **硬红线**：
  - 全站大容器（`html`/`body`/`:root`/`.glass-shell`/`.glass-topbar`/`.glass-main`）保持 **零 `:has()`**，统一改用组件直接输出的 `data-*` 属性（如 `data-winctrls="3"`）。
  - `[data-slot="message-scroller-item"]` 保留 `contain: layout style`（**严禁**对聊天消息行使用 `content-visibility: auto`，以免虚报高度破坏滚动锚点）。
  - 弹窗主阴影模糊半径控制在 `<= 36px`，`liquid` 边缘投影控制在 3 层以内，**禁止**对 `filter` 属性做 CSS `transition`。
- **防复发自动门禁**：`app/tests/no-container-has.test.ts`（`LEGACY` 清零）、`app/tests/no-group-has.test.ts`、`app/tests/no-body-has.test.ts`、`app/tests/theme-glass-perf.test.tsx`。

---

## 四、React 重渲染、状态流与主线程阻塞

### 4.1 `ActiveBotProvider` 伪 `useRef` 击穿 5 层 `React.memo`

- **现象与触发路径**：切换频道、打开/切换设置页或任意触发 `ShellFrame` 重渲的操作，都会穿透 5 层 `React.memo` 唤醒所有 KeepAlive 保活频道里的全量 `SmoothStreamdown` Markdown 渲染与 `useActiveBot` 重连。
- **根因（文件与机制）**：`app/src/lib/conversations/active-bot.tsx` 在每次渲染时重写 `value.current = { botId, announce }` 并将其直接作为 Context value，导致所有消费者每次父级渲染均收到新对象引用。
- **硬红线**：
  - `ActiveBotProvider` 必须将不变引用（`ActiveBotContext` 稳定 holder、`ActiveBotAnnounceContext` 稳定 setter）与变化标量（`ActiveBotIdContext` 原始 `string`）拆分；仅声明/上报身份的消费者不得订阅动态 `botId`；`ConversationToolsProvider` 必须包裹 `memo`。
- **防复发自动门禁**：`app/tests/runtime-render-stability.test.tsx`、`app/tests/active-bot-routing.test.tsx`、`app/tests/kept-chat-no-rerender.test.tsx`。

### 4.2 `ConversationScopeProvider` 裸 rest 对象击穿 `Composer` 与气泡 `memo`

- **现象与触发路径**：频道外壳任意状态变动都会导致 `ComposerImpl`、`LiveBotBubbles` 与 `TranscriptToolCall` 不必要地重渲。
- **根因（文件与机制）**：`app/src/lib/chat/conversation-scope.tsx` 直接把 `{ ...rest }` 作为 Context value 向下传递，每次渲染都分配全新对象。
- **硬红线**：
  - `ConversationScopeProvider` 必须按标量字段 `[threadId, agentId, botId]` 用 `useMemo` 稳定 Context value，**禁止**向 Context 透传裸 rest 对象字面量。
- **防复发自动门禁**：`app/tests/runtime-render-stability.test.tsx`。

### 4.3 `useThreadActivity` 返回非稳定对象导致监听重建与空闲守卫失效

- **现象与触发路径**：聊天容器重渲时反复销毁并重建 `useExternalConnection`，重置 `wasRunning` 标志，导致空闲收件箱轮询守卫失效。
- **根因（文件与机制）**：`app/src/lib/conversations/thread-activity.ts` 返回未 `useMemo` 的 `{ onActivity, kick }` 字面量对象。
- **硬红线**：
  - 返回回调集合供下游 `useExternalConnection` 依赖的 Hook（如 `useThreadActivity`）必须用 `useMemo` 稳定返回引用，同时保留 `useKeptVisibility()` 与 `onScreenRef.current ? SYNC_INTERVAL_MS : HIDDEN_SYNC_INTERVAL_MS` 后台降频契约。
- **防复发自动门禁**：`app/tests/runtime-render-stability.test.tsx`、`app/tests/keep-alive.test.tsx`、`app/tests/kept-chat-no-rerender.test.tsx`。

### 4.4 `ChannelChat` 订阅未过滤的全仓 `QueryCache`

- **现象与触发路径**：应用任意角落（设置、模型、任务、右侧面板）的 TanStack Query 刷新都会把所有 KeepAlive 保活的 `ChannelChat` 回调全部跑一遍。
- **根因（文件与机制）**：`app/src/components/channels/channel-chat.tsx` 的 `queryClient.getQueryCache().subscribe` 回调未对事件类型与 `queryKey` 做前置过滤。
- **硬红线**：
  - 全局 `QueryCache.subscribe` 必须在入口第一行按事件类型（`updated` / `added`）与精确 `queryKey` 前缀（如 `channelKeys.list()`）早退过滤，**禁止**全量响应无关查询事件。
- **防复发自动门禁**：`app/tests/runtime-render-stability.test.tsx`、`app/tests/kept-chat-no-rerender.test.tsx`。

### 4.5 隐藏或折叠态右栏持续 2.5s–5s 后台轮询

- **现象与触发路径**：右栏已折叠、抽屉未打开、切到其他 Tab 或离开聊天页后，应用仍在后台每 2.5s–5s 持续拉取面板、任务与工作流接口并触发渲染。
- **根因（文件与机制）**：`panel-rail.tsx`、`tasks-rail-card.tsx`、`live-panels-query.ts`、`task-center-api.ts` 与 `workflows.ts` 缺少基于可见性（`railVisible = (wide ? open : sheetOpen) && useKeptVisible()`）的 `poll` 门控与 `refetchIntervalInBackground: false`。
- **硬红线**：
  - 所有带 `refetchInterval` 的侧栏/右栏/子面板查询必须接入可见性门控（折叠、隐藏 Tab、KeepAlive 离屏或页面后台时一律停止轮询），且设置 `refetchIntervalInBackground: false`。
- **防复发自动门禁**：`app/tests/narrow-rail-sheet-stability.test.tsx`、`app/tests/keep-alive.test.tsx`。

### 4.6 `ChatTranscript` 未记忆化、`compactTurns` $O(N^2)$ 与逐气泡查询 `speechStatus`

- **现象与触发路径**：长对话（200+ 条消息）下输入框打字、聚焦或滚动状态变更都会重跑整棵消息列表的过滤、分组与数十上百个 `useQuery(speechStatusQueryOptions())` 订阅。
- **根因（文件与机制）**：`app/src/components/channels/chat-transcript.tsx` 外层未包 `memo`；`compactTurns` 内部对每条消息调用 `indexOf` + `slice().some` 构成 $O(N^2)$；每条 `CopyMessage` 气泡各自挂载一次 `speechStatusQueryOptions()`。
- **硬红线**：
  - `ChatTranscript` 必须保持 `memo`（含针对 AG-UI `agent.messages` 就地修改的内容快照比对），消息管线/确认集/`compactTurns`/`shownFlags` 必须记忆化且 `compactTurns` 保持 $O(N)$ 线性扫描。
  - `speechStatusQueryOptions()` 必须在 `ChatTranscript` 顶层按 `enabled: hasAssistantText` 单次查询并经 Context 下发，**禁止**在单条消息气泡组件内重复挂载。
- **防复发自动门禁**：`app/tests/settle-reflow-instant.test.tsx`、`app/tests/transcript-attachments.test.tsx`。

### 4.7 `ToggleTip` 首次悬停与按键调用 `ReactDOM.flushSync`

- **现象与触发路径**：鼠标首次滑过顶栏/侧栏图标按钮或首次按导航键时，出现明显的同步渲染卡顿长帧。
- **根因（文件与机制）**：`app/src/components/layout/glass-topbar.tsx` 的 `ToggleTip` 在首次 `pointerenter` / `focus` 与 `onFirstKeydown` 中同步调用 `ReactDOM.flushSync` 强行打断当前输入帧提交整套 Tooltip 子树。
- **硬红线**：
  - **禁止**在悬停、聚焦、键盘导航等高频交互热路径调用 `ReactDOM.flushSync`；延迟激活类组件必须使用普通 `setState` 或 `startTransition`。
- **防复发自动门禁**：`app/tests/toggle-tip-lazy.test.tsx`、`app/tests/roster-toggle-focus.test.tsx`。

### 4.8 `ComposerDock` 全子树 `MutationObserver` 与拖拽每帧 `setState`

- **现象与触发路径**：在输入框打字、粘贴附件或拖拽调整悬浮输入框尺寸时，持续触发 DOM 观察与每帧 React 重渲，并反复覆写 `--chat-composer-h`。
- **根因（文件与机制）**：`app/src/components/channels/composer/dock.tsx` 挂载了全子树 `MutationObserver`，且拖拽手柄在 `pointermove` 中每帧调用 `setRect` 触发 React 渲染和写入，高度未变也写 CSS 变量。
- **硬红线**：
  - 输入框尺寸观测必须改用 `ResizeObserver` + rAF 合并并按 `lastInsetRef` 脏检查去重写 `--chat-composer-h`，**禁止**在输入框容器挂全子树 `MutationObserver`。
  - 拖拽交互期间只直写 DOM `style`（零 React `setState`），仅在 `pointerup` / `pointercancel` 提交一次状态并持久化。
- **防复发自动门禁**：`app/tests/runtime-render-stability.test.tsx`、`app/tests/composer-dock.test.ts`。

### 4.9 `ui-memory.ts` 150ms 高频全量剪枝并同步写 `localStorage`

- **现象与触发路径**：流式打字或连续操作期间，主线程每隔 150ms 被同步 JSON 序列化、全量剪枝排序与 `localStorage.setItem` 打断。
- **根因（文件与机制）**：`app/src/lib/chat/ui-memory.ts` 写盘防抖仅 `150ms`，且每次落盘无论容量是否超限都执行全量 `prune()`。
- **硬红线**：
  - UI 草稿/折叠等非关键状态落盘防抖须 `>= 600ms`（并配 `pagehide` 仅在存在待落盘定时器时兜底），`prune()` 仅在启动加载与突破上限阈值（`MAX_BOTS`/`MAX_THREADS`/`MAX_WORK`）时执行。
- **防复发自动门禁**：`app/tests/runtime-render-stability.test.tsx`、`app/tests/ui-memory.test.ts`、`app/tests/composer-draft-memory.test.tsx`。

### 4.10 `AppSidebar` 未记忆化与常驻预挂载菜单，以及全局 Context 未记忆化

- **现象与触发路径**：侧栏点击、未读数变化或任意全局状态更新，导致全部机器人行及其未打开的下拉菜单内容整体重渲；主题或富 UI 宿主重渲连带全局消费者重渲。
- **根因（文件与机制）**：
  - `app/src/components/app-sidebar/app-sidebar.tsx` 的 `BotRow` / `MiniBot` 未包裹 `memo`，列表派生数组未 `useMemo`，行回调为内联箭头函数，且 `!menuOpen` 时仍常驻挂载 `BotMenuContent`。
  - `app/src/components/theme-provider.tsx` 与 `app/src/lib/conversations/json-render/rich-context.tsx` 的 Provider 未用 `useMemo` 稳定 value。
- **硬红线**：
  - 侧栏列表行（`BotRow` / `MiniBot`）必须包裹 `memo` 并使用 `useMemo` / `useCallback` 稳定派生数据与事件处理；未打开的右键/更多菜单内容（`BotMenuContent`）必须按 `menuOpen` 延迟挂载。
  - 所有应用级 Context Provider（`ThemeProvider`、`RichUiProvider` 等）必须用 `useMemo` 稳定 value 对象。
- **防复发自动门禁**：`app/tests/runtime-render-stability.test.tsx`、`app/tests/sidebar-drawer-nav.test.tsx`。

---

## 五、2026-11-22 实测前后对比基线

以下数据均来自本机实机 Chromium + `perf/mock-server.mjs`（240 条历史对话 `c1`）与 Chrome Trace 实测（对比基线 commit `54ed8fb8` 与治理终版）。

### 5.1 竖屏小窗切换（`1280×840 ↔ 420×860`，1x 无降速 CPU + Chrome Trace）

| 切换方向 | 优化方式 | 总耗时 wallMs | scriptMs | layoutMs (次数) | paintMs | compositeMs | forcedMs |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 进入小窗 | 15 步补间 → 单步原子 | **5,371 → 547 (-90%)** | **387 → 126 (-67%)** | **809 (35) → 74 (5) (-91%)** | **421 → 31 (-93%)** | **113 → 28 (-75%)** | **17 → 0 (-100%)** |
| 退出小窗 | 15 步补间 → 单步原子 | **3,746 → 631 (-83%)** | **438 → 187 (-57%)** | **523 (38) → 85 (7) (-84%)** | **338 → 34 (-90%)** | **97 → 32 (-67%)** | **87 → 17 (-80%)** |

### 5.2 竖屏模式面板/侧栏回跳（`420×860` 与 `780×1050`，1x CPU）

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| `420×860` 贴底开关右侧面板 Sheet | `padding-right` `30↔16px`，`Δsh = 1,980px`，倒退 8 条（`L237→L229`）再 55 帧平滑滑回 | `prChanged = false`，`Δsh = 0`，`maxGap = 0`，`smoothCalls = 0`，背景气泡逐像素零位移 |
| `420×860` 上滑看历史开关面板 | 打开即被夹回底部丢位，关闭回跳 8 条 | 中段 `L235@-223` 保持 `0px` 漂移 |
| `420×860` 流式 `toolTurn` 开关面板 | `.chat-slack` 暴涨至 `2,118px` 闪屏空白 | `blankFrames = 0`，`maxSlack = 94px` |
| `780×1050` 展开/收起左侧 `BotMiniRail` | `maxGap = 70–90px`，1 次 `smooth` 回追 | `endGap = 0`，`smoothOrAuto = 0` |

### 5.3 桌面端全场景流畅度（`perf/jank.mjs` 4x CPU + `1280×840` 1x CPU）

| 场景（材质 / CPU 档位） | fps | p95 (ms) | longTaskMs | styleMs | scriptMs | 关键补充 |
| --- | --- | --- | --- | --- | --- | --- |
| `liquid` `stream` (4x CPU + trace) | **2.2 → 49 (+2127%)** | **2,971 → 109.1 (-96%)** | **14,006 → 7,813 (-44%)** | **3,963 → 1,009 (-75%)** | 5,291 → 5,566 | `forcedMs -61%`；`presentation 308 → 37ms (-88%)`；`liquid-glass` 强排归零 |
| `liquid` `scroll` (4x CPU + trace) | **17.1 → 25.5 (+49%)** | 242.3 → 285.1 | **123,152 → 44,135 (-64%)** | **56,377 → 13,050 (-77%)** | **31,853 → 8,725 (-73%)** | `maxLongTask 15,011 → 3,606ms (-76%)`；`layoutMs -86%`；`forcedMs -64%` |
| `mist` `scroll` (4x CPU) | **3.6 → 7.3 (+103%)** (最优 `10.6`) | **527.6 → 236.4 (-55%)** | **41,238 → 23,652 (-43%)** | **15,478 → 8,157 (-47%)** | **9,405 → 3,788 (-60%)** | 默认材质滚轮帧率翻倍以上 |
| `mist` `idle` (4x CPU) | **2.4 → 30.7 (+1179%)** | **2,752.7 → 188 (-93%)** | **4,488 → 2,988 (-33%)** | - | - | 非液态休眠消除闲置空转 |
| `mist` `sidebar` (4x CPU) | **29.8 → 51.1 (+71%)** | **109.3 → 48.7 (-55%)** | **6,623 → 4,251 (-36%)** | **1,799 → 1,099 (-39%)** | **3,867 → 2,517 (-35%)** | `worst INP 1,208 → 896ms (-26%)` |
| `mist` `settings-pages` (4x CPU) | **4.4 → 11.1 (+152%)** | **1,418.7 → 230.3 (-84%)** | - | - | **9,706 → 5,679 (-41%)** | `worst INP 1,936 → 1,280ms (-34%)` |
| `1280×840` 弹窗+侧栏 (1x CPU) | - | - | **329 → 251 (-24%)** | **-18%** | **-23%** | `maxInpMs 240 → 184ms (-23%，落回 200ms 线内)`；`paint 334 → 98ms (-71%)` |
| `1280×840` 打字 30 字 / 滚动 (1x CPU) | - | - | `0 longTasks` | 滚动 recalcs **-54%** | 打字 **-29%** | 打字 `maxInpMs = 24ms`，滚动 layouts **-54%** |

---

## 六、复测命令与何时必须重跑基准

凡修改以下任一区域，**合并前必须跑对应单测与实机基准**：

- 改动 `pc/src/compact-window.js`、`pc/src/local-web.js`、`pc/src/desktop-prefs.js`、`pc/src/main.js` 或 `app/src/lib/desktop-window.ts`；
- 改动 `app/src/styles.css` 玻璃材质/遮罩/阴影/过渡、`app/src/lib/liquid-glass.ts`、`app/src/components/sky-background.tsx` 或气泡动画；
- 改动 `app/src/components/channels/chat-transcript.tsx`、`panel-rail.tsx` 或 `app/src/vendor/shadcn-react-message-scroller/lib/index.js`；
- 改动 `app/src/lib/chat/`、`app/src/lib/conversations/`、`app/src/components/app-sidebar/`、`composer/dock.tsx` 或全局 Context Provider。

### 标准自动门禁与实机复测命令

```bash
# 1. 快速门禁与文档真实性校验
bun run check
bun test server/tests/docs-truth-guards.test.ts

# 2. PC 外壳与协议单测（含外壳指纹检查）
cd pc && npm test
node pc/scripts/shell-fingerprint.js --check

# 3. 专项前端性能与防回跳回归单测
bun test \
  app/tests/narrow-rail-sheet-stability.test.tsx \
  app/tests/settle-reflow-instant.test.tsx \
  app/tests/runtime-render-stability.test.tsx \
  app/tests/liquid-glass.test.ts \
  app/tests/liquid-glass-screen-ink.test.ts \
  app/tests/render-budget.test.ts \
  app/tests/theme-glass-perf.test.tsx \
  app/tests/resize-pause.test.ts \
  app/tests/glass-hold-panels.test.ts \
  app/tests/no-container-has.test.ts \
  app/tests/no-group-has.test.ts \
  app/tests/desktop-window-edge-clip.test.tsx

# 4. 实机浏览器竖屏面板防回跳与流式干活卡回归（需先构建 app/dist 或传入 --dist）
node tests/chat-scroll/portrait-panel-jump.mjs
node tests/chat-scroll/work-card-jump.mjs

# 5. 实机 Chromium 4x CPU 卡顿基准（Windows 显式传 --chrome 指向 Chrome/Edge 可执行文件）
node perf/jank.mjs --dist=app/dist --out=/tmp/perf-mist --scenario=all --runs=1 --cpu=4
node perf/jank.mjs --dist=app/dist --out=/tmp/perf-liquid --glass=liquid --scenario=idle,scroll,stream --runs=1 --cpu=4 --trace
node perf/compare.mjs /tmp/perf-before /tmp/perf-after --interactions
```
