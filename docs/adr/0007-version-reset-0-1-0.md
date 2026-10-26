# ADR-0007：版本号归正为 0.1.0，并对齐所有端

- 状态：已采纳
- 日期：2026-10-12
- 相关：CHANGELOG「0.1.0」；docs/releasing.md；BACKLOG CB-018

## 背景

内部构建已经用到 0.2.2–0.2.5，与对外发布不一致。用户：「版本号归正为0.1.0」。

## 决定

- ChisaBot 从 0.1.0 开始：根 `package.json`（→ `/api/version`）、`pc/`、`android` versionName 同一个版本号；Android versionCode 只增不减。
- 内部 0.2.x 构建和它们的 GitHub release / tag 删除；上游 ChisaBot 版本在 CHANGELOG 里标成「ChisaBot x.y.z」。
- CI 要求 pc 与 android 版本一致。

## 后果

- 装着 0.2.x 的 PC 永远不会自动「降级」到 0.1.x：必须手动卸载重装一次（PC 里有「需要重新安装」提示，§45）。
- 只改服务器的版本可以只升根版本号，不发客户端。
