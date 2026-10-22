# 聊天体验：切机器人 / 切回来 / 发消息（2026-10-22）

起因：用户报「bot 切换，或者从别的页面切回 bot，都会触发一次类似发送消息一样的刷新；发送消息的体验非常垃圾，
对话记录充满了跳跃、刷新，完全不丝滑；输入框特别容易闪」。

三份只读审计（证据都带 file:line，基于 2026-10-22 的 HEAD）：

- [nav.md](nav.md) —— 哪些路径会重挂 `ChannelChat`、重跑 connect + 读历史；`/settings` 回来为什么不重挂（§98 成立）。
  结论里的 P1 是这次的总根因：**接入（connect 回放）被当成「一轮在回答」**。
- [scroll.md](scroll.md) —— 滚动 / 对齐引擎：哪些状态变化会让人看到跳、哪些是 §35 / §83 / §94 要的翻页。
  结论里的 H1 已被单测复现：**恢复出来的最新一条用户消息被当成「刚发出去的」**。
- [composer.md](composer.md) —— 输入框：为什么会整块塌 / 闪、焦点与高度的关系。

## 改了什么

1. **打开对话不再像发了一次消息**（`chat-transcript.tsx`，H1）
   新增 `useOpeningWindow`：`hydrating` 加上恢复完成后 `SETTLE_AFTER_HYDRATE_MS`（2.5s）算「还在打开」。
   这段时间里最新一条用户消息换了只重新记基线，不带 `data-scroll-anchor`、不平滑滚、不垫 2/3 屏空白、
   不把历史 id 记成本机发出的时刻（以前那一条还会污染「上一条多久之前」，把之后的翻页关掉 30 分钟）。
   回归：`app/tests/chat-restore-anchor.test.tsx`（恢复不带标记；窗口过后的真发送照旧带）。

2. **接入不是一轮回答**（`channel-chat.tsx`，P1）
   `@copilotkit/core` 的 connect 从开始到回放结束都把 `agent.isRunning` 设成 true。以前它直接喂给
   `busy` / `pending` / `stoppable`：每次切换机器人，发送键先变「停止机器人」、末尾挂一行「思考中」，
   回放完再收回去；那个「停止」按下去撤掉的是回放本身。现在分成两个事实：
   - `agentLive`（发出去还是排队、能不能重新生成）仍含 `agent.isRunning`；
   - `chatBusy`（画给人看的「机器人在回答」）在接入期间不算 `agent.isRunning`。
   6 秒兜底，接入没走到 finally 也不会让停止键永远不出现。

3. **输入框不再动不动塌成一行**（`styles.css` + `composer.tsx`，H3）
   prompt-area 自己在失焦 150ms 后把编辑框高度钉回一行、`overflow: hidden`；上一版又把它的高度过渡关掉了，
   于是点一下模型药丸 / 权限 / 消息区，写好的几行字当场被裁掉，点回来又弹开。现在高度只跟内容走
   （`height: auto`，超过组件给的 `maxHeight` 照旧在框里滚）；发送之后光标当场回输入框，不等整轮回答结束；
   聚焦时的底色改成同一支渐变（以前是渐变↔纯色，浏览器插不了值，只能瞬间跳）。

4. **不再拽往上翻着读的人**（`chat-transcript.tsx`，D3 / D4）
   排队补话的那一下只在人本来就在底部时才跟到底；`useKeepBottomOnPrepend` 不再在「还没收到过滚动事件」时
   假设人在底部，也不再和 §88.3 的位置恢复抢（打开窗口里位置归 `SettleAtEnd`）。

5. **换一段对话就是换一页**（`authed-shell.tsx`，P3）
   `ChannelPage` 加 `key={kept.channelId}`：历史对话弹窗、计算机自动切标签的「上一个机器人」不再跟到新对话上。

## 验证

- 新增 `app/tests/chat-restore-anchor.test.tsx`（2 项）。
- 更新两处「接线」断言（`bot-ui-state.test.tsx`、`open-at-latest.test.ts`）到新契约。
- `message-scroll-reduced-motion.test.tsx` 进 `scripts/run-app-tests.ts` 的隔离名单：Motion 在第一次 import 时
  就把 `prefers-reduced-motion` 记死了，这份用例必须自己一个进程（以前跟着整套跑必红）。
- 顺手修掉两个**既有**红灯（与聊天无关，但让整套一直是红的）：`panel-board.test.tsx` 注册了 happy-dom 却没注销
  （下一个自己注册的 `plugin-logo.test.tsx` 因此撞「already registered」）；`system-update.tsx` 的执行内核徽章
  没包 `<T>`（`ui-align-2` 的 §82.6 约定）。
- `bun scripts/run-app-tests.ts`：**1425 项全绿**（另 10 个独立进程文件各自 0 失败），退出码 0。
- `bun run --filter app typecheck`：只剩 `shared/json-render/catalog.ts` 的 268 条 zod 版本漂移错误（HEAD 就有，
  `shared/` 没有工作区改动），本次改到的文件 0 条。

## 没做（有意）

- `?watch` 在经过 `/` 的那一跳会丢（nav P4）：会在回到对话时补一次 `replace` 导航，但不重挂、不重读，代价可忽略。
- 左栏点机器人打开的是它**最近**的对话（nav P5）：产品上就是这样定的（一个机器人一段对话）。
- `/settings` 撕掉事件 socket（nav P6）：回到聊天时左栏会刷一次列表，聊天本身不重接。
