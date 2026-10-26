# 架构决策记录（ADR）

记录「为什么这样做」的关键决定。新决定：复制 [0000-template.md](0000-template.md)，编号 +1，状态写「提议」，随实现 PR 一起合并
后改为「已采纳」。决定被推翻时不删旧 ADR，写新 ADR 并把旧的标成「被 ADR-xxxx 取代」。

| ADR | 决定 | 状态 |
|---|---|---|
| [0001](0001-bots-only-left-column.md) | 左栏只列机器人，没有对话列表 | 已采纳（ADR-0014 曾修订；ADR-0014 已于 2026-10-26 作废，左栏重新只有机器人） |
| [0002](0002-devices-belong-to-account.md) | 设备属于账号，不属于某个机器人 | 已采纳 |
| [0003](0003-cloud-agent-device-nodes.md) | 默认云端 agent + 设备节点，本地 agent 运行时可选 | 已采纳（本地 agent 见 ADR-0010） |
| [0004](0004-vault-design.md) | 密钥保险箱：机器人能用、看不到 | 已采纳 |
| [0005](0005-pages-sandbox.md) | 页面放在同源 `/p/`，CSP sandbox 隔离 | 已采纳 |
| [0006](0006-schedules-independent-of-routines.md) | 定时任务独立实现，不依赖上游 routines | 已采纳 |
| [0007](0007-version-reset-0-1-0.md) | 版本号归正为 0.1.0，各端对齐 | 已采纳 |
| [0008](0008-pr-per-feature-serial-deploy.md) | 一功能一 PR，串行部署，做好一版就发 | 已采纳 |
| [0009](0009-device-full-access.md) | 设备「完全访问」：有时限、只能主人打开的总开关 | 已采纳 |
| [0010](0010-local-agent-handoff.md) | 本地 agent 按任务交接；档位只收紧，完全访问 = 设备开关 | 已采纳 |
| [0011](0011-gateway-accounts.md) | 朋友账号放在登录网关里，网关签名告诉应用「这是谁」 | 已采纳 |
| [0013](0013-single-chat-path.md) | 机器人聊天只有一条路——频道聊天 | 已采纳 |
| [0014](0014-cloud-claude-code.md) | 云端工作区 + Claude Code + 电脑同步（修订 0001：左栏可切换「机器人｜Claude Code」） | 已作废（2026-10-26，CB-099：功能已删除） |
