# Pipeline run: DOG-02 audit EN + DOG-03 install banner (2026-10-18)

## Scope
Dogfood R1 follow-ups（FIX-10 / FIX-11 残留）· CB-UX-DOG-02 / CB-UX-DOG-03。  
DOG-01（发消息假成功）已在 v0.1.18，**不重开**。  
实现：`/workspace/ChisaBot/repo`（不用 Cursor cloud agents）。未 resume 电车定时。

## Status log
- 2026-10-18 ~15:30 CST Asia/Shanghai — 分支 `fix/dog-02-03-audit-install`；审计中文标签 + 安装横幅占位/永久关闭。
- 单测绿 → PR → 合入 → 发版 0.1.19+ → Haupt updater 部署。

## Root cause

### DOG-02（活动记录英文）
- `#209` FIX-10 只中文化了**电脑侧栏** `activity-log.tsx`（运行/读取/保存）与设备 `ACTION_LABEL`。
- **管理 → 活动记录**仍用 `payload.action.replace("computer_", "")`，于是留下 `navigate` / `type` / `download_file` / `run_command` / `write_file`。
- 人接管时 agent-computer 写英文拒因 `A person has control or has been asked to take control…`，经 `payload.failure` 原样进结果列。模型提示仍认英文，故**只在审计 UI 翻译**，不改 agent-computer 源串。

### DOG-03（安装横幅）
- 胶囊 `position: fixed; top: calc(64px + …)`，正文未让位 → 盖住设置/审计标题。
- Chromium（含本机 box）常有 `beforeinstallprompt` 但 `prompt()` 无窗或挂起；点「安装」不永久关掉则刷新后又出现。
- FIX-11 已有永久关闭 + 接管时隐藏；本次补正文顶距与安装失败/超时也记住关闭。

## What changed
- `app/src/lib/audit/action-label.ts` — `computerActionLabel` / `auditFailureLabel`
- `app/src/routes/_authed/admin/audit.tsx` — 操作列中文；失败/拒因中文；「谁发起」列 `whitespace-nowrap`
- `app/src/components/install-hint.tsx` — 点安装后永久关闭；`data-install-hint` 占位
- `app/src/lib/pwa.ts` — `promptInstall` 12s 超时当取消
- `app/src/styles.css` — `body[data-install-hint=open]` 给 `.glass-body` / 侧栏让出 ~48px
- `app/tests/audit-action-label.test.ts`

## Not in this PR
- DOG-04 搜索深链到消息
- DOG-05 电脑陈旧截图 / 503
- 未改 agent-computer 英文 `HUMAN_HAS_CONTROL`（模型侧仍认）
- 未 resume 电车定时

## How to verify
1. 活动记录：电脑操作行显示「打开网页 / 填写 / 运行命令…」；接管阻拦行结果为中文「有人正在用电脑…」；「谁发起 / 此部署 / 定时任务」不折行。
2. 安装横幅：出现时标题不被挡住；点「安装」或「×」后刷新不再出现（localStorage）。
3. 回归：聊天发消息仍正常（DOG-01）；接管时横幅仍隐藏。

## PR / release
- PR: https://github.com/ChisaAlter/ChisaBot/pull/211 （open，**HOLD**：不 merge / 不发版 / 不部署，等聊天 P0（v0.1.18 仍假成功）先合入）
- 分支: `fix/dog-02-03-audit-install` @ `50c0ac8b`
