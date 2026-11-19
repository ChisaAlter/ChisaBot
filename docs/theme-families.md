# 主题族与天空背景

外观模型第三轮：把原来的一条「皮肤」单选轴换成**浅色 / 深色两个模式各自独立选族**的主题族（DESIGN.md §143，CB-140）。
族的四件套 seed（强调色 / 底色 / 文字色 / 对比度）由 `deriveSeed` 纯函数派生整套 CSS 令牌；浅色模式和深色模式可以选不同的族，
「浅色落樱 + 深色伦敦雨」这种混搭在数据结构上就是合法状态，不再是需要特判的组合。

入口：偏好设置 → 通用 → 「主题族与天空背景」（`app/src/components/settings/appearance-preferences.tsx`）。
只改网页表现，没有新增接口、数据表或服务端开关；PC 和 Android 加载同一份网页，发布服务器前端后刷新才生效，不用重装客户端。

## 1. 模型

```ts
Seed        = { ac, bg, fg, c, scene? }        // accent / background / foreground / 对比度 30–70 / 推荐天象场景
ThemeFamily = { id, name, light: Seed, dark: Seed }
```

- `AppearanceState` 里换掉旧的单值 `palette`，改成 `familyLight` / `familyDark` 两个槽 + `customFamilies`（自定义族数组）。
- 浅色模式读 `familyLight`、深色模式读 `familyDark`，各自独立；有效期由 `resolvedThemeFamily(state, dark)` 一处解析。
- 八个内置族（色值是规格常量，写在 `app/src/lib/theme-family.ts`，不要重新采样）：

| id        | 名字   | 浅色 seed（ac / bg） | 深色 seed（ac / bg） |
| --------- | ------ | -------------------- | -------------------- |
| `azure`   | 晴空   | `#4176e6` / `#f3f7fc` | `#6ea8ff` / `#10141c` |
| `mist`    | 晨雾   | `#64748b` / `#f4f5f7` | `#94a3b8` / `#15181d` |
| `celadon` | 青瓷   | `#0f766e` / `#f3faf7` | `#3dd6b5` / `#071411` |
| `sakura`  | 落樱   | `#d4527e` / `#fcf3f6` | `#e0789c` / `#1e1018` |
| `amber`   | 琥珀   | `#b45309` / `#fbf6ee` | `#e2b15c` / `#14100b` |
| `violet`  | 暮紫   | `#7c3aed` / `#f7f3fc` | `#c4a1ff` / `#120e18` |
| `london`  | 伦敦雨 | `#4a6d8c` / `#f0f4f7` | `#7aa4c4` / `#101820` |
| `mono`    | 对比   | `#111111` / `#ffffff` | `#ffffff` / `#050505` |

旧的「素白 / 墨夜」明暗绑定皮肤（`boundMode`）连同「点皮肤卡连模式一起切」的特判整体删除：想要「黑夜观感」就
给深色槽选 `mono`（对比族），不必再让一个皮肤去翻转模式。

## 2. seed 派生令牌

`deriveSeed(seed, dark)`（`app/src/lib/theme-family.ts`）一个纯函数从四件套算出整页变量：

- 强调色系：`--accent-*`、`--ink-primary`、`--on-primary`（按实际按钮底色在 WCAG 里取对比更高的那个）；
- 文字层级 `--ink-1/2/4`、边框 `--stroke-*`（alpha 随 `c` 增大）、玻璃底 `--glass-bg` / `--glass-tint`；
- 四段天空 `--fam-sky-0..3`（「主题天空」卡的渐变和 body 的 `--sky-1..4` 都由它来）。

`styles.css` 里 10 套 `html[data-palette]` 静态令牌块全部删除，只留 `html[data-theme-family]` 的结构规则。
加一个族不再需要手写两份十六进制令牌，改 seed 就行。

## 3. 启动脚本与首帧

`familyBootScript()`（`app/src/lib/theme-family.ts`，由 `app/vite.config.ts` 在构建时把 `deriveSeed` 函数体
`.toString()` 内联进 `<head>`）在 React 挂载前解析当前模式的族并写 `data-theme-family`、整套派生变量、`data-glass`、
meta theme-color（`--fam-sky-0`）。解析顺序：新键 → 自定义族 → 旧 `chisabot-theme-palette` 一次性迁移 → `azure` 兜底。
启动骨架第一帧就是用户的主题，没有「先白一下再换色」。

运行时同一个派生路径由 `applyAppearanceToDocument`（`app/src/lib/appearance.ts`）写 DOM，并顺手清掉旧的
`data-palette` 根属性，保证新样式表之外没有残留引用。

## 4. 设置页交互

- **族卡 = 左右分半预览**：每张卡画该族的浅色半边和深色半边（各自 seed 的 bg / ac 小样）。点左半边写
  `familyLight`、点右半边写 `familyDark`（`setThemeHalf(mode, id)` 只写对应槽），另一槽不动。
- **第 9 张卡 = 自定义族**：点开编辑器，分别调浅 / 深两个 seed 的三色 + 对比度滑杆（30–70）+ 背景材质，保存即
  upsert 进 `chisabot-theme-families` 并把两槽都指向它。
- **「恢复默认」**：两槽回 `azure`、清空自定义族、材质 / 雾度 / 天空来源 / 壁纸一并回默认（`resetAppearanceDefaults`）。
- **选族不碰天空**：族卡只管派生令牌，天空来源（`skySource`）和壁纸完全不动——这是与 §140「点皮肤卡切主题天空」
  最大的语义差异。彩色族 + Hark 引擎天象是常态组合；「主题天空」仍是天空组第一张卡，预览画当前族 seed 的渐变。

## 5. 天空背景与昼夜配对（接 §140 不变式）

- 天空三选一互斥：主题天空（`skySource="theme"`）/ Hark 动态天象（`"hark"`）/ 壁纸（`wallpaperId` 非 `none`）。
- `harkScene="auto"` 时不再看旧皮肤配色，而是取当前模式 seed 的 `scene`（未写时按浅 0 晴空 / 深 4 柏林夜兜底），
  再经 §140 的昼夜配对不变式过滤：夜景在浅色下落到黄昏 / 雨景配对，日景在深色下落到夜景配对。任何路径都造不出明暗错配的天空。
- `--sky-lift` / `--sky-muted` 的可读性护栏仍由**有效天空**的真实明暗驱动，与本轮改动无关。

## 6. 存储与迁移

| 键 | 内容 |
| --- | --- |
| `chisabot-theme-family-light` / `chisabot-theme-family-dark` | 两个模式各自的族 id |
| `chisabot-theme-families` | 自定义族 JSON 数组 |
| `chisabot-theme-palette` | 旧皮肤 id；**只**在 `readInitialAppearance` 与启动脚本里读一次做映射迁移 |

迁移映射（`migrateLegacyPalette`）：`default` / `ocean` → 晴空，`stardust` → 晨雾，`emerald` → 青瓷，`sakura` / `ruby` → 落樱，
`sunset` / `gold` → 琥珀，`aurora` / `nocturne` → 暮紫。两槽同写映射结果，之后不再读老键；新键已有值时忽略老键。
旧键本身不删除（回滚兼容）。

外观偏好只存在浏览器 localStorage，不跨设备同步，也没有数据库迁移。

## 7. 已知限制

- 自定义族存在本机浏览器里，换设备 / 清站点数据就没了；没有导出 / 导入。
- 天空来源是三选一互斥，「彩色族 + 引擎天象」是常态组合，但选族本身永远不会替用户切天空。
- 对比度 `c` 只影响派生出的边框 alpha、文字弱化层级和玻璃不透明度，不改强调色本身；`mono` 的 68 / 64 是可达性的上限档，不要往上推。

## 8. 验证

- 模型与迁移：`app/tests/theme-family.test.ts`（seed 派生、内置族常量、旧键迁移、自定义族校验）。
- 迁移后仍要绿的既有外观用例：`palette-theme.test.ts`、`a11y-contrast.test.ts`、`appearance-cards.test.tsx`、
  `appearance-preferences.test.ts`、`appearance-sky-model.test.tsx`、`theme-glass-perf.test.tsx`、`default-mist-glass.test.tsx`、
  `settings-audit-12.test.ts`、`rail-tasks-p3.test.tsx`。
- 真浏览器验收：`node tests/appearance-model/appearance.mjs`（需要先 `bun run generate:app-config && bun run --cwd app build`）。
  覆盖 8 族 × 双半边、点半边只写对应槽、选族不劫持天空来源、§140 昼夜配对、深色不翻转模式、壁纸互斥、420 无横向溢出、
  零控制台错误，并产出桌面浅色 / 桌面深色 / 420 三张截图。
