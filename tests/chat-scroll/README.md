# 聊天滚动回归（DESIGN.md §35）

真浏览器里复现「AI 输出时跳到上面的聊天记录」：假模型每 150ms 一批流式吐长回复，逐帧记录
滚动容器的 scrollTop / scrollHeight / 视口里最早可见的那条消息。

- `mock-model.mjs`：OpenAI 兼容的假模型（`node mock-model.mjs`，端口 4010）。最后一条用户消息是 `SEED n`
  回短回复（用来攒历史），`LONG` 回带标题 / 列表 / 代码 / 表格 / 链接 / 图片的长回复（约 15 秒），`TOOLS`
  先说一句过程话再调一个工具。
- `repro.mjs`（playwright-core，Chromium 路径按 ChisaBot 镜像里的 `/ms-playwright`）：
  1. 在一个独立的预览实例里把默认模型指向假模型（`PUT /api/admin/model-settings`，provider `openai`，
     baseUrl `http://<mock>:4010/v1`），建一个测试机器人，`BOT=<id>`。
  2. `PHASE=seed N=30` 攒 60 条历史，覆盖当前 `ChatTranscript` 的尾屏优先挂载阈值（48 条），把会话存到 `/out/state.json`。
  3. `PHASE=stream PROMPT=LONG STATE=…/state.json`，可加 `MOBILE=1`（390×844）、`SCROLLUP=1`（输出中途往上滚 600px）、
     `CPU=4`、`VIDEO=1`。
- 判定：`HISTORY.framesShowingOlderHistory` 必须是 0（贴底时视口里从不出现比发送时更早的消息）；
  `SCROLLUP=1` 时 `yankedDown` 必须是 false、结束时仍停在用户滚到的位置。

历史复现（2026-10-13，旧虚拟化列表）：发送那一帧 scrollHeight +2958px，视口从第 63 条退到第 61 条再回弹。当前列表实现位于 `app/src/components/channels/chat-transcript.tsx`，挂载窗口规则在 `app/src/lib/chat/tail-first-paint.ts`。

## 发送时整段聊天跳一截（`send-jump.mjs`，DESIGN.md §35.4）

`repro.mjs` 只看滚动区**里面**（scrollTop、视口最早一条），量不到滚动区**自己**被挤动——2026-10-13 第二次报「发送消息，
聊天记录往回跳」就是这种：聊天顶上的红色提示在发送时消失 / 出错时出现，滚动区顶边一帧挪 137–217px。
`send-jump.mjs` 记屏幕坐标：滚动区的位置、发送时视口里一条消息的屏幕位置、scrollTop，相邻两帧有跳就记一笔，
`ASSERT=1` 不过退出码 1。用真实长会话的副本跑（带图片、卡片、代码块、出过错的轮次），宽 1280×800 和窄 420×860 都要过；
`FAIL=1 TWICE=1` 覆盖「上一轮出错 → 再发」。修复前（提示在版面里）：发送那一帧 anchor 屏幕位置 346→209（宽）、407→267（窄）。
`POLLTICK=1` 覆盖全端同步（§42）：发送期间和结束后几秒把每次 `/sync` 回复改成「序号变了 + 服务器在回答」，逼同步反复尝试接入。
另外发送后**任何一条消息被删掉也算失败**（失败的那条留在本机，§42.7；确实需要删的场景用 `ALLOW_REMOVE=1`）。

### 回归跑法（`regression.sh`，每次动聊天 / 同步都要全过）

```
BASE=http://127.0.0.1:<预览端口> BOT=<机器人 id> THREAD=<真实长会话副本 id> sh tests/chat-scroll/regression.sh
```

跑 `wide`（1280×800）、`narrow`（420×860）、`failtwice`、`narrowfail`（FAIL=1 TWICE=1）、`polltick`、`narrowpoll`
（POLLTICK=1 TWICE=1）、`up`（发送前上滑 700px，不许被拽回）。#75 上线后的回归（2026-10-13）：`failtwice` 在发送失败后约
950ms 删掉刚发的气泡、往回跳 119px（#74 = 8fbc4ff 时 0 跳），§42.7 修好。
