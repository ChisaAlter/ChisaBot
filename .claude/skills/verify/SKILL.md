---
name: verify
description: 前端页面、交互流程、样式或响应式布局改动交付前的零下载实机浏览器自验收流程。复用本机 Edge / Chrome / Chromium 采集桌面与移动端截图、检查零控制台报错与交互闭环。
---

# ChisaBot 实机浏览器 UI 自验收指南

## 核心原则

1. **禁止盲信“编译通过”**：凡涉及界面、表单、对话流、路由或样式改动，必须在本地真实无头浏览器中走通页面加载与核心交互后再提交。
2. **复用本机浏览器、零额外下载**：使用 [verify-ui.mjs](file:///c:/AI/ChisaBot/scripts/verify-ui.mjs)（基于根依赖 `playwright-core` 探测 `CHISABOT_VERIFY_BROWSER_PATH` / 本机 Edge / Chrome / Chromium），不得触发动辄上百 MB 的浏览器二进制下载。
3. **临时产物用完即收**：截图仅在必要人工审阅时用 `--out-dir` 定向导出；例行验收默认在 `os.tmpdir()` 专属目录中校验字节数后由 `finally` 自动清理。

## 标准命令

1. 验证驱动链路自身健康（内置响应式对话夹具页）：

```powershell
bun run verify:ui -- --self-test
```

2. 验收实际启动的前端预览/开发页面（桌面 `1440x900` + 移动 `390x844` 双视口 + 零控制台/页面报错 + 零 5xx + 无横向溢出）：

```powershell
bun run verify:ui -- --url http://127.0.0.1:4173/ --out-dir artifacts/ui-check
```

## 验收通过标准

- `ok === true` 且进程退出码为 `0`；
- `consoleErrors`、`pageErrors`、`server5xx` 三项数组全为空；
- `desktopOverflow === false` 且 `mobileOverflow === false`；
- `desktopScreenshotBytes > 1000` 且 `mobileScreenshotBytes > 1000`。
