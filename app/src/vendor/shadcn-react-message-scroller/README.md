# message-scroller（`@shadcn/react@0.3.0`，带本地改动）

**出处**：npm 包 `@shadcn/react`，版本 **0.3.0**，上游 https://github.com/shadcn-ui/ui （`packages/react`），
主页 https://ui.shadcn.com 。许可证 MIT，Copyright (c) 2023 shadcn，原文见同目录 `LICENSE.md`（从包里原样拷贝）。

文件对应：`node_modules/@shadcn/react/dist/message-scroller/index.js` 和 `dist/chunk-HBS6WEDP.js`（改名 `chunk.js`），
类型 `dist/message-scroller/index.d.ts`、`dist/index-DoP2hiBu.d.ts`（改名 `render.d.ts`）。MIT，见 `LICENSE.md`。
放在 `lib/` 下面；`biome.json` 排除了 `app/src/vendor`（打包产物原样保留）。

**相对上游的全部改动**（除此之外逐字未动）：

- 拷贝时的路径改写：`lib/index.js` 里 `'../chunk-HBS6WEDP.js'` → `'./chunk.js'`；`lib/index.d.ts` 里 `'../index-DoP2hiBu.js'` → `'./render.js'`。
- 逻辑改动只有下面三处（jank P1-2，`/workspace/jank-analysis/REPORT.md` 切换场景 message-scroller 逐行量 550ms）：

- `Se`（内容高度）：原来对每一行 `getBoundingClientRect` 取最大 bottom；现在从末尾往前找第一个有尺寸的行。
  列布局里它就是最低的一行；`display: contents` 的 chat-tail 本来就量出 0。
- `Ye`（视口里第一条可见行）：原来从头线性扫；现在对带 `data-message-id` 的行二分，碰到 0 尺寸行退回线性。
- `Te`（`handleContentChange`，内容变化时 MutationObserver / layout effect 调）：开头加一个分支——行数变多、没有待跳的 `scrollToMessage`、并且视口上挂着 `data-tail-backfill`（ChisaBot 的尾屏补行在那次
  提交期间打的标记，只在浏览器有原生 `overflow-anchor` 时打）时，只更新行数 / 第一行，清掉 `prependRestore`，
  排一次 rAF 的状态提交和可见性同步（内容最上面可能有不是消息的固定行，所以不按「旧第一行的位置」判断前插），然后返回：不走 `de()`（前插保位，逐行 getBoundingClientRect）、不走
  `scrollToEnd`（读 scrollHeight）、不走 `Z()`（找锚点行）。位置交给原生锚定。没有标记时行为与上游完全一样。

其余逐字未动。升级 `@shadcn/react` 时：上游若已只量可见行，删掉这个目录、`components/ui/message-scroller.tsx`
改回 `@shadcn/react/message-scroller`；否则在新版本上重做上面两处。测试：`app/tests/message-scroller-visible-measure.test.tsx`。
