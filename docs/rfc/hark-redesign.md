# RFC：Hark 界面重做的拆分

状态：草案（2026-10-29）· 分支：`feat/hark-redesign`（只在本地，不推送）

## 为什么要拆

`feat/hark-redesign` 一口气做了令牌、顶栏、左右栏、输入框四步，再加性能规则，合在一起没法审查，也没法单独回滚。
这里把它拆成可以各自审查、各自回滚的小 PR，并写清顺序、依赖和不许碰的地方。

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

已定：左下角账号卡（AccountCard）合进左栏，放在左栏底部，不再单独做一张卡，少一层玻璃。在 PR 3 里做。

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
