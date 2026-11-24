# ChisaBot 主线状态与开发交接摘要

> 更新日期：2026-11-24（基线：`v0.1.183` + `Unreleased` `f3582a0c`）。全量看板与待办验收标准以 [ROADMAP.md](ROADMAP.md) 与 [BACKLOG.md](BACKLOG.md) 为准。

## 1. 当前主线状态

- **执行内核与会话层**：`CHISABOT_AGENT_KERNEL=dsh` 为现役唯一内置执行内核，客户端与服务端统一通过 `/api/conversations`、PostgreSQL `chisabot_local_*`（reader 4）及每账号独立 DSH Session 持久卷工作；已完成阶段感知实时插话、50ms 写库合批、单跳 SSE 与 DSH 连接池（`v0.1.177` / CB-143），以及 `0070_core_performance_indexes.sql` 16 条核心表索引迁移（`v0.1.181`）。
- **外观、多端体验与性能收口**：`v0.1.170` 合入 ProkBot 全量对标 Wave 1–10（CB-142）；`v0.1.181`–`v0.1.183` 连续落地全栈性能优化、PC 独立更新进度窗口（`DESIGN.md` §152）、全站 UI 丝滑过渡（§153）及主题/背景画布/纯 CSS 三档材质四轴重设计（§154，彻底下线重型液态玻璃透镜）；`Unreleased`（`f3582a0c`）已修复右边栏显隐裁切卡顿与 PC 小窗横竖屏切换性能，本轮同步收口 CI 测试回归、工程卫生与滞后文档。
- **PC 更新验签与客户端分发**：全端版本（根 `package.json`、`pc/package.json`、`android/app/build.gradle.kts`）自 2026-11-17 起统一同步发版；Windows / macOS 通用版自 `v0.1.142` 起强制启用 Ed25519 清单验签（公钥 `efcef1f2`，Authenticode 仍暂缓，见 [pc-update-signing.md](pc-update-signing.md)），桌面端内置本地前端并按「版本高者优先」加载（`v0.1.154` / CB-129），当前 Windows 外壳指纹 `7314f9105596bec5`。
- **多用户与配额状态**：网关签名身份（`CHISABOT_GATEWAY_SECRET`）、角色隔离、共享记忆/全局共享技能及按用户日/月模型配额上限（`CB-045` / 迁移 `0069`）已全部落地；`CHISABOT_ACCOUNTS_UI` 默认开启界面入口（仅需隐藏时设为 `0`/`false`），登录网关 `config.json` 仍需显式开启 `"invites": true` 才允许邀请新账号（见 [朋友账号](accounts.md)）。
- **真实待完成项**：`CB-120`/`CB-121`/`CB-122` 仍待正式登录环境实机验收；`CB-017`/`CB-018`/`CB-019`/`CB-032`/`CB-034`/`CB-067` 等真机终验、真实外部凭据、CI Android 签名 Secrets 与产品取舍项需所有者配合推进（详见 [ROADMAP.md](ROADMAP.md) 与 [BACKLOG.md](BACKLOG.md)）。

## 2. 常用本地验证命令

完整开发与测试规范见 [本地开发参考](development.md)、[测试与验证](testing.md) 与根 [AGENTS.md](../AGENTS.md)：

```sh
# 1. 本地快速门禁（typecheck +全仓 Biome 零错误零警告，每次提交前必跑）
bun run check

# 2. 服务端与前端测试（前端测试必须走 test:app 隔离运行，切勿裸跑 bun test app/tests）
bun run test:server
bun run test:app

# 3. 文档真相守卫与实机浏览器 UI 自验收
bun test server/tests/docs-truth-guards.test.ts
bun run verify:ui

# 4. 完整门禁（PR 前）与格式检查
bun run check:full
bun run format:check
```

涉及 PostgreSQL / `pgvector` 的服务端集成测试与 DSH 恢复测试（`bun run test:dsh`）必须使用独立测试库（`TEST_DATABASE_URL` / `CHISABOT_DSH_TEST_DATABASE_URL`），严禁连接正在使用的开发主库或生产数据库。

## 3. 关键文档导航

- **看板与待办**：[ROADMAP.md](ROADMAP.md) · [BACKLOG.md](BACKLOG.md)
- **视觉与性能红线**：[DESIGN.md](../DESIGN.md) · [desktop-performance-guardrails.md](desktop-performance-guardrails.md)
- **系统架构与数据表**：[architecture.md](architecture.md) · [data-model.md](data-model.md) · [features.md](features.md)
- **环境变量与部署运维**：[configuration.md](configuration.md) · [deploy/README.zh-CN.md](../deploy/README.zh-CN.md) · [ops/README.md](ops/README.md)
- **测试、发布与回滚**：[testing.md](testing.md) · [release.md](release.md) · [pc-update-signing.md](pc-update-signing.md) · [ops/deploy.md](ops/deploy.md)
