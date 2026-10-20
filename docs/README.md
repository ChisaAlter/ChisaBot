# ChisaBot 文档

ChisaBot 是 CopilotKit/OpenBot 的中文私人助手分支：一台云端服务器上的机器人，替你在任何地方管理你所有的设备。
这一页是**全部文档的总索引**。截至 2026-10-17：服务器 main `0e23321`（PR #192），客户端最新 v0.1.15。

## 从这里开始

| 我想… | 看这里 |
|---|---|
| 一页看懂 ChisaBot 是什么、由哪几部分组成 | [概览 overview](overview.md) |
| 知道有哪些功能、入口在哪、代码在哪、怎么开关 | [功能目录 features](features.md) |
| 知道每个版本改了什么 | [版本记录 CHANGELOG](CHANGELOG.md)（按版本 / PR）· 部署者向的逐条说明在根 [CHANGELOG.md](../CHANGELOG.md) |
| 知道现在在做什么、接下来做什么 | [ROADMAP（看板）](ROADMAP.md) · [BACKLOG（带验收标准的条目）](BACKLOG.md) |
| 理解系统怎么搭的 | [架构 architecture](architecture.md) · [数据模型 data-model](data-model.md) · [ADR](adr/README.md) |
| 知道为什么这样做、有哪些长期规则 | [产品决策与需求原则 decisions](decisions.md) · [ADR](adr/README.md) |
| 改界面 | [DESIGN.md](../DESIGN.md)（顶部章节索引）· [设置的信息结构](settings-ia.md) |
| 提交改动 | [CONTRIBUTING](../CONTRIBUTING.md) · [并行开发协议](dev/parallel-work.md) |
| 自己部署、运维一套 ChisaBot | [运维手册 ops/](ops/README.md)（主机端口、容器、目录、部署回滚、网关、云端节点、发版、模型、测试环境、巡检、清理、故障复盘） |
| 发版、上线、回滚 | [发布流程 release](release.md) · [部署、回滚与上线检查](ops/deploy.md) · [在线更新](online-update.md) |
| 测试 | [测试与验证 testing](testing.md) |
| 看懂中文术语 | [术语表 glossary](glossary.md) |

## 项目管理

| 文档 | 内容 |
|---|---|
| [ROADMAP.md](ROADMAP.md) | 里程碑、现在 / 接下来 / 以后、最近完成 |
| [BACKLOG.md](BACKLOG.md) | CB-001 起的全部条目、验收标准、状态（GitHub Issues 未开启前它就是 issue 列表） |
| [decisions.md](decisions.md) | 所有者的长期规则（发布流程、测试安全、版本号、界面原则），带日期 |
| [CHANGELOG.md](CHANGELOG.md) | 0.1.0 → v0.1.15 及之后的 PR，按发版标签分组 |
| [adr/](adr/README.md) | 架构决策记录 0001–0014（0012 号空缺） |
| [pipeline-runs/](pipeline-runs/) | 个别功能的流水线运行记录 |

## 架构

- [ChisaBot 架构](architecture.md)：服务器 agent、公网网关、更新器、PC 节点、Android、云端浏览器、云端工作区，以及每个功能的代码位置、
  数据表和 DESIGN 章节、常用运行时开关。
- [数据模型](data-model.md)：全部 `chisabot_*` 表、本地对话表、仍在用的上游表、网关 SQLite、浏览器本地存储。
- [流式回复：从模型到屏幕](streaming.md)
- [分支与能力边界](chisabot.md)：本地模式、第三方推理、数据兼容和客户端状态。
- [OpenBot 原始架构](openbot-architecture.md)（上游参考；其中很多部分已瘦身掉，见 [slimming.md](slimming.md)）

## 功能文档（按范围）

完整列表见 [features.md](features.md)。

| 范围 | 文档 | DESIGN |
|---|---|---|
| 聊天 | [流式回复](streaming.md) · [聊天文件与图片生成](chat-files.md) | §24–§27、§30–§32、§35、§38、§42、§48、§56、§67–§70、§75、§76、§83、§88–§90、§92–§94 |
| 机器人 | [机器人头像](bot-avatars.md) · [BOT 配置](coworkers.md) | §46、§47、§74、§81 |
| 确认与权限 | [确认卡片与审批偏好](confirmations.md) | §58、§97 |
| 模型 | [模型配置与切换](models.md) · [Magpie 深度集成](magpie.md) | §15、§59–§61 |
| 面板 / 计算机 | [浏览器多标签与收藏夹](browser-tabs.md) · [侧栏与弹出面板一致性](sidebar-panel-parity.md) | §23、§29、§39、§43、§77、§79、§95、§96 |
| 设备 / PC / 手机 | [PC 节点与扫码绑定](pc-node.md) · [本地 agent 与权限档位](local-agents.md) · [Android 原生版](android-native.md) · [手机网页版与 PWA](pwa.md) | §16、§33、§36、§40、§45、§62、§66、§80、§86、§91 |
| 云端 Claude Code | [云端 Claude Code](cloud-claude-code.md) | §73、§84、§85、§87 |
| 记忆 · 技能 · 保险箱 | [长期记忆](memory.md) · [技能](skills.md) · [密钥保险箱](vault.md) | §50–§52 |
| GitHub · 页面 · 定时 | [GitHub 账号连接](github.md) · [页面](pages.md) · [定时任务与提醒](schedules.md) | §53–§55 |
| IM | [IM 接入](im.md) | §49 |
| 账号 | [朋友账号（多账号，默认隐藏）](accounts.md) | §65 |
| 设置 | [设置的信息结构与搜索](settings-ia.md) | §57、§71、§97 |
| 工作流（默认隐藏） | [工作流](workflows.md) | §26 |
| 瘦身 | [瘦身计划与进度](slimming.md) | §57、§74 |

## 运维、发布与测试

| 文档 | 适合解决的问题 |
| --- | --- |
| [快速开始](getting-started.md) | 第一次部署，配置完成后怎样开始聊天 |
| [自托管部署](../deploy/README.zh-CN.md) | 镜像、持久化、认证网关与 Magpie 部署模板 |
| [**运维手册（总览）**](ops/README.md) | 自己部署后长期运维的全部章节入口与一页速查 |
| [主机与端口规划](ops/hosts.md) | 机器配置、公网端口、只绑 loopback 的端口、防火墙 |
| [容器与服务](ops/containers.md) | 每个容器、镜像、卷、systemd 单元的用途 |
| [目录布局与凭据存放](ops/layout.md) | 宿主机目录、各类密钥应放在哪里与权限 |
| [部署、回滚与上线检查](ops/deploy.md) | 合并后怎么上线、更新器怎么工作、怎么回滚、上线后检查什么 |
| [网关与登录服务](ops/gateway.md) | nginx 规则、登录服务、多账号开关、签名身份密钥、证书 |
| [云端工作区节点](ops/cloud-node.md) | 节点部署与安全边界、防火墙、同步边车看门狗、可选出口路由 |
| [客户端发布（运维）](ops/client-release.md) | 更新源目录、APK 签名、发版上传与临时文件安全删除 |
| [模型配置运维](ops/model-config.md) | 默认 / 备用模型、生图识图、额度用完怎么办 |
| [预览与测试环境](ops/preview.md) | 预览容器、出网封锁、生产测试守则与只读检查 |
| [监控与巡检](ops/monitoring.md) | 每日 / 上线后的只读巡检清单、定时任务、日志 |
| [磁盘清理指南](ops/cleanup.md) | 保留什么、可以删什么、不要碰什么 |
| [常见故障与事故复盘](ops/incidents.md) | 典型故障处理、过去事故的教训、整机迁移 |
| [发布流程](release.md) | 版本号规则、服务器上线、客户端发版、外壳指纹与「重新安装」、自测规则 |
| [测试与验证](testing.md) | 单元测试、预览约定、回归套件、生产只读检查、已知不稳定测试 |
| [在线更新](online-update.md) | 网页提示刷新、PC / Android 自动更新、系统更新（宿主机更新器） |
| [管理员自检](admin-smoke.md) | 不碰任何对话的模型往返检查 |
| [维护与排错](operations.md) | 备份、升级、连接故障与部署验收 |
| [环境配置](configuration.md) | 环境变量和租户包 YAML |
| [来源与许可](THIRD_PARTY_NOTICES.md) | 上游项目与保留的许可证声明 |

常见问题：

- [在哪里填写模型 API 和密钥](models.md#管理员配置连接)
- [聊天输入框与 BOT 设置为什么是同一个值](models.md#bot-模型选择)
- [怎样让 Magpie 的多个模型进入选择器](magpie.md#配置顺序)
- [切换模型何时生效，运行中的回复使用哪个模型](models.md#目录缓存和运行快照)
- [模型不可用，怎样定位网关、权限或上游问题](operations.md#模型问题排查)

## 上游技术参考

以下资料继承自 [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot)，用于查阅保留的工具、权限、框架与可选集成。

- [开发参考](development.md)：迁移、分开启动服务与质量检查。
- [联网研究](parallel-research.md)：Parallel Search 连接器。
- [Composio](plugins/composio.md)、[Google Drive](plugins/google-drive.md)、[Notion](plugins/notion.md)：外部连接器（插件与 MCP 默认隐藏，`CHISABOT_EXTRAS=plugins`）。
- [上游容器参考](deployment.md)、[上游发布参考](releasing.md)、[Windows 签名](windows-signing.md)：继承的镜像、发布和签名流程（ChisaBot 的发版看 [release.md](release.md)）。
- 已在瘦身中删除：Tauri 桌面端 `desktop/`、Expo `mobile/`、Helm chart `charts/`、自动学习、`worker/`（见 [slimming.md](slimming.md)）。

默认中文租户包见 [examples/zh-CN](../examples/zh-CN/README.md)。内部 `OPENBOT_*` 环境变量、包名、协议及数据目录保留兼容，展示品牌为 ChisaBot。

文档只保存可复用说明与脱敏示例。真实主机、登录密码、模型密钥、客户数据、对话和私人部署资料不写入文档或仓库；
具体部署的私有运维资料由维护者保存在仓库之外。
