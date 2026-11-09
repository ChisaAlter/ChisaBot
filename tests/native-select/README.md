# 原生下拉框 + 回合不静默结束（DESIGN.md §100）

`turn.mjs` 建一个一次性机器人（标题「临时测试（会删除）」，`guard.mjs` 保证只删本次建的），跑完删除。不碰已有机器人和对话。

- **A**（只调 API）：把一个含三个原生 `<select>`（Month / Day / Year）的页面写进工作区、打开 → 快照里三个 combobox 带 `options`、没有逐项 option →
  点月份不弹出、返回选项 → `computer_type` 填 7 / 12 / 2000 → 页面显示「已选：2000-07-12」→ 填 1800 得到 400 + 可选项 → 在下拉框上按 Enter 不卡。
- **B**（真模型）：对机器人说「打开这个页面，把出生日期选成 2000 年 7 月 12 日」→ 页面上真的是 2000-07-12、回答里有结果、没有错误卡片。
- **C**（模拟异常）：拦截这一轮接力的第二个 `/api/conversations/agent/*/run` 回 500 → 聊天里出「这一轮没有完成」卡片和「重试」。
- **D**（生产事故本身）：拦截一次 `POST /api/approvals/computer/*` 回 500 → 机器人拿到「没做成」的结果，自己重新读页面把年份改成 1999，不静默结束。

```sh
# 预览（免登录管理员）
BASE=http://127.0.0.1:<端口> PARTS=A,B,C,D node tests/native-select/turn.mjs
# 部署环境：再给一个临时会话令牌 TOK=<会话 cookie 值>（跑完删掉会话）
```

需要 `playwright-core` 和 Chromium（应用镜像里的 `/ms-playwright`），截图写到 `/out`。B / C / D 都会发起模型回合；A 只调用计算机 API。C 针对保留的 AG-UI `/agent/*/run` 接力链路，不能作为 DSH `/api/conversations/:threadId/commands` 链路已验收的证据。
