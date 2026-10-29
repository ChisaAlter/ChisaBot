# RFC：Hark 界面重做的拆分

状态：**方向已通过，细节待小爱批准**（2026-10-29 第二版）。批准前不改代码。

第一版审阅时小爱定了两件事：手机的红点放在抽屉按钮上；PC 端窗口按钮放最右，头像紧挨在它们左边。见「下一步」的 ③ 和 ④。

- 原分支：`feat/hark-redesign`（只在本地，不推送）。
- 这份 RFC 和主题提案 [`docs/design-system.md`](../design-system.md) 放在同一个 PR 里一起审。
- 分工：主题、颜色和玻璃参数只写在 design-system.md；PR 拆分和账号卡只写在这里。

## 为什么要拆

`feat/hark-redesign` 一口气做了令牌、顶栏、左右栏、输入框四步，再加性能规则，合在一起没法审查，也没法单独回滚。
这里把它拆成可以各自审查、各自回滚的小 PR，并写清顺序、依赖和不许碰的地方。

## PR 状态（2026-10-29）

| PR | 分支 | 状态 | 对应下表 |
|---|---|---|---|
| #363 | `perf/ui-render-budget` | 已合并（`079c3aa`，0.1.104） | PR 0 |
| #369 | `feat/hark-tokens` | 已合并（`8a93056`，0.1.104） | PR 1 |
| #374 | `feat/hark-topbar` | 已开，待审 | PR 2（顶栏、右上角头像菜单） |
| #375 | `perf/global-no-backdrop` | 已开，待审 | 表外：性能模式和「减少透明度」下全局不模糊 |
| #378 | `fix/mobile-drawer-hark` | 已开，待审 | 表外：手机抽屉，账号放到抽屉底部 |

## 已经单独拆出去的：渲染性能（PR 0）

分支 `perf/ui-render-budget`，从 `origin/main` 拉出，**不依赖 Hark 令牌层和新布局**，界面保持 main 的样子，只是模糊少了：

- 毛玻璃预算：大面板 20px、弹层 12px、不超过 30px；气泡、按钮、胶囊、滚动区里的卡片不模糊；不嵌套；去掉滚动遮罩。
- 天空：默认快照；动态天空 15fps、0.6 倍分辨率，空闲 / 失焦 / 隐藏就停；有壁纸或性能模式不启动；去掉 `preserveDrawingBuffer`。
- 无限动画只动 transform / opacity，页面隐藏时暂停。
- 性能模式状态（`chisabot.perf-mode`）+ 系统「减少透明度 / 动态效果」。
- 外观偏好只写改动过的键。
- 静态测试 `app/tests/render-budget.test.ts`。

后面所有 PR 都要让这条测试保持通过，浏览器审计的同屏模糊层数保持 ≤ 6。

## 剩下的拆分和顺序

| # | PR | 改什么 | 依赖 |
|---|----|--------|------|
| 1 | 令牌（第 1 步） | Hark 设计令牌：`--glass-*` 拆成半径 + `--glass-filter`，墨色、填充、圆角、阴影令牌；不改布局 | PR 0 合并后 rebase；把 `render-budget.test.ts` 改成读新令牌名，数值不变（20 / 12px） |
| 2 | 顶栏（第 2 步） | 顶栏布局、搜索入口、胶囊改为不模糊（`is-flat`） | PR 1 |
| 3 | 左右栏（第 3 步 + 详情面板） | 左右栏改成悬浮 24px 玻璃卡，玻璃画在 `::before` 上（绕开旧层的 `animation: none !important`）；里面的卡片只有底色；详情面板在宽度动画期间用实色 | PR 1；和 PR 2 互不依赖 |
| 4 | 输入框（第 4 步） | 悬浮输入框、气泡配色令牌；删掉 composer-block 的旧覆盖规则（`!important` 152 → 126） | PR 1；建议在 PR 3 之后，方便对照截图 |
| 5 | 性能模式入口 | 在外观设置里放开关 | 碰 `appearance-preferences.tsx`（禁区），要文件负责人同意，或等第 6 项之后由负责人来做 |
| 6 | 壁纸存储移出 localStorage | 自定义壁纸 data URL 换存储位置 | 归 ChisaBot开发 的 PR，这边不做，只等它合并 |
| 7 | 天空引擎内部 | `wallpaper_core.html` 里的 1s 时钟、10 分钟天气轮询、内部淡入淡出 | 禁区，交给引擎负责人单独开 PR |
| 8 | 删除旧的 `!important` 玻璃层（第 5 步） | 去掉 `styles.css` 末尾三档玻璃那层的覆盖规则 | PR 3、PR 4 都合并后；碰外观相关样式，要负责人同意 |

~~已定：左下角账号卡（AccountCard）合进左栏，放在左栏底部，不再单独做一张卡，少一层玻璃。在 PR 3 里做。~~ 这条已被「下一步」里「桌面端去掉账号卡」的方案代替。新方案批准前，两条都不实施。

## 每个 PR 都要过的检查

- `bun run typecheck`、`bun run build`、`bun run test:app`、`bun run lint`、`bun run format:check`，和 main 相比没有新问题。
- 截图：桌面深色、桌面浅色、手机，改动前后各一张。
- 浏览器审计：同屏可见的 `backdrop-filter` 层数 ≤ 6（含伪元素），没有嵌套。
- 不新增 `!important`。
- 所有 PR 都不升版本号（根、`app`、`server` 的 `package.json` 都不动）；CHANGELOG.md 和 docs/CHANGELOG.md 的条目一律写在 `## Unreleased` 下，没有这个标题就建一个。版本号只在发版时统一改。

## 禁区（所有 PR 都不碰，除非负责人另外同意）

- `bot-bubbles.tsx`（SVG 清洗）
- `app/public/wallpaper_core.html`
- 壁纸上传：`lib/appearance.ts` 的 `compressUploadedWallpaper`，`appearance-preferences.tsx` 整个文件
- 外观设置相关样式：`data-glass` / `data-palette` / `--lg-alpha` / `.appearance-*`
- 第 5 步的删覆盖层（见上表第 8 项）

## 已知问题（`feat/hark-redesign` 上）

`test:app` 在这个分支跑出了 main 两次基线里都没有的三条失败，PR 2 之前要查清是改动引起的还是用例本身不稳定（main 自己两次跑的失败集合就不一样）：
「a search filters what is loaded and the history is opened by hand」、「Esc while composing (IME) stays in the field」、「a protected page shows loading while the actual authentication guard waits」。

## 下一步

### 桌面端去掉账号卡（待小爱批准，批准前不改代码）

右上角头像已经是账号入口（#374 的 `AccountMenu placement="topbar"`），左栏底部的账号卡和它重复了。方案是去掉账号卡，所有入口收进右上角的头像菜单，待处理红点挂到头像上。这个方案代替上面「账号卡合进左栏底部」那条。

**① 去掉什么**

| 位置 | 现在 | 去掉后 |
|---|---|---|
| `app-sidebar.tsx:969` | 展开的左栏底部 `<AccountCard />`（`.glass-card.acct-card`，里面是 `.acct-row`） | 桌面不渲染 |
| `app-sidebar.tsx:1046` | 收起的左栏底部 `.acct-mini-card`（紧凑的 `AccountMenu`，`.acct-mini`） | 桌面不渲染 |
| `section-rail.tsx:130`、`:167` | 设置 / 管理页左栏的紧凑版和 `AccountCard` | 桌面不渲染 |
| `styles.css` | `.acct-card` / `.acct-row` / `.acct-mini*`（约 L4163–4187、L4308–4310），三档层 L9396 里的 `.acct-card`，性能和减少透明度规则 L9824 / L9834 里的 `.acct-card` | 桌面不再用到；手机抽屉还在用的部分留下（见 ③） |

去掉以后，桌面聊天页同屏的模糊层回到 **4 层**：左栏卡、右栏卡、顶栏搜索、输入框。左栏底部空出来的位置留给机器人列表。

**② 卡片上的入口逐条挪到哪里**

我在 `account-menu.tsx`（main `3856d360`）里逐条查过账号卡上的入口：

| 入口 | 现在在哪 | 去掉账号卡后 |
|---|---|---|
| 头像 + 名字 + 版本号（`/api/version`） | 账号卡按钮上，菜单头部也有一份 | 只留在头像菜单的头部 |
| 待处理红点 `.glass-avatar-dot`（待审批 + 待回答的问题 + 待确认的数量之和，大于 0 时显示） | 账号卡头像上 | 挂到右上角头像上（#374 已经接好了：`hk-avatar-btn` 带红点） |
| 个人资料（打开 `ProfileDialog`） | 账号菜单 | 头像菜单，同一个 `AccountMenu` 组件，代码不用改 |
| 设置 → `/settings` | 账号菜单 | 头像菜单 |
| 定时任务 → `/settings/schedules` | 账号菜单 | 头像菜单 |
| 待处理 → `/approvals`（提示「N 项」） | 账号菜单 | 头像菜单 |
| 绑定手机（打开 `PairPhoneDialog`） | 账号菜单 | 头像菜单 |
| 暗色外观开关 | 账号菜单 | 头像菜单 |
| 退出登录（`signOut`，原型预览里禁用） | 账号菜单 | 头像菜单，放在最后 |
| 切换账号 | **现在没有这个入口**（代码里搜不到） | 不新增 |
| 用量 | **现在没有这个入口**（代码里搜不到） | 不新增 |

两个位置用的是同一个 `AccountMenu` 组件（#374 加了 `placement="rail" | "topbar"`），所以搬过去不会丢入口。去掉账号卡以后，`placement="rail"` 只在手机抽屉里还用得到。

**③ 手机端**

- **#378 的做法保留**：手机的账号放在抽屉底部，抽屉里的 `AccountCard` 继续用。
- **顶栏头像在手机上不显示**：#374 现在在手机上也渲染右上角头像，两个 PR 合在一起会出现两个账号入口。改成只有宽度 ≥ 768 时才显示。
- **红点**：手机上挂到顶栏左边的抽屉按钮（`glass-menu-btn`）上，打开抽屉以后，底部的账号行上也有红点。
- **小爱已定（第一版审阅）**：手机上的红点放在抽屉按钮上，照上面这样做。不采用「手机也只留右上角头像」的方案，因为那样等于推翻 #378。

**④ PC 客户端**

- **窗口按钮**：
  - 头像在 `.glass-topbar-end` 里，排在窗口按钮（`WindowControls`，3 或 4 个，宽 46px）的左边，中间留 8px 间隔。
  - 头像和菜单都设成 `app-region: no-drag`，否则点不到。
  - #374 已经在顶栏上写了 `data-winctrls="3|4"`，用来算右边距。
  - **小爱已定（第一版审阅）**：窗口按钮放最右，头像紧挨在它们左边。
  - DESIGN.md 原来写的是「右上角只放窗口按钮」：§36.1，以及「顶栏」那一节（main 上 L512「顶栏右上角只放窗口按钮」，L772「右上角只放窗口按钮的规则不变」）。这几处都要改成新规则。
  - DESIGN.md §36.1 这次已经改成「窗口按钮在最右，头像紧挨在它们左边」，并注明头像随账号卡 PR 上线。
  - 「顶栏」那一节（L512）写的是现在的顶栏，main 上还没有头像，先不改，等去掉账号卡的代码 PR 落地时在同一个 PR 里改。这几行 #374 没有动过，不会和 #374 冲突。
- **小窗模式**（§36，420×860）和所有宽度小于 768 的窗口：
  - 侧栏是 #378 的抽屉，规则和手机一样，账号在抽屉底部，红点在抽屉按钮上。
  - 顶栏头像不显示，窗口按钮按 §36.2 收窄到 36px。
- **没有顶栏的页面**：登录、引导这些页面走 `DesktopStrip`，本来就没有账号入口，不受影响。

**⑤ 涉及的文件和测试**

- 代码：
  - `components/layout/account-menu.tsx`（`AccountCard` 只给手机抽屉用；`placement` 判断宽度）
  - `components/layout/app-sidebar.tsx`
  - `components/layout/section-rail.tsx`
  - `components/layout/glass-topbar.tsx`（#374：头像只在宽度 ≥ 768 时显示，抽屉按钮加红点）
  - `styles.css` 里账号卡相关的规则
- 测试：
  - `tests/render-budget.test.ts`：选择器 `:is(.glass-side-card, .acct-card, …)` 去掉 `.acct-card`，同屏层数断言改成 4。
  - `tests/appearance-preferences.test.ts:117`：这里断言了 `.acct-card`。
  - #378 的 `tests/mobile-drawer.test.tsx`：抽屉底部的账号保留。
  - 新增 `tests/account-entry.test.tsx`：桌面不渲染 `.acct-card`，头像菜单里 7 个入口都在，待处理大于 0 时头像有红点，手机和小窗不渲染顶栏头像、抽屉按钮有红点。
- 截图：桌面深浅色、PC 窗口（3 个和 4 个窗口按钮）、PC 小窗、手机，改动前后各一张。
- **依赖**：#374 合并后，再从 main 拉分支。和主题提案的代码 PR 互不依赖（见 [design-system.md §10](../design-system.md#10-依赖和后续-pr-顺序)）。

### 其他

- 主题系统重做（6 套主题、玻璃只留 4 类地方、设置页卡顿）见 [`docs/design-system.md`](../design-system.md)。上表第 8 项「删除旧的 `!important` 玻璃层」并进那边的后续 PR 1（主题数据和切换，同时删掉旧的）。
- 天空小修在这个 PR 之后做。
