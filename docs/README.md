# ChisaBot 文档

ChisaBot 是以 DSH 为执行内核的中文私人助手：服务器持续执行任务，网页、PC 和 Android 共用界面并连接你的设备。
这一页是**全部文档的总索引**。当前部署版本与验收记录见[个人助理实施记录](pipeline-runs/20261108-assistant-production.md)与[连续操作体验实施记录](pipeline-runs/20261111-smooth-experience.md)。

## 从这里开始

| 我想…                                                | 看这里                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 一页看懂 ChisaBot 是什么、由哪几部分组成             | [概览 overview](overview.md)                                                                                                 |
| 知道有哪些功能、入口在哪、代码在哪、怎么开关         | [功能目录 features](features.md)                                                                                             |
| 知道每个版本改了什么                                 | [版本记录 CHANGELOG](CHANGELOG.md)（按版本 / PR）· 部署者向的逐条说明在根 [CHANGELOG.md](../CHANGELOG.md)                    |
| 知道现在在做什么、接下来做什么                       | [ROADMAP（看板）](ROADMAP.md) · [BACKLOG（带验收标准的条目）](BACKLOG.md)                                                    |
| 查看个人助理生产交付方案与验收范围                   | [个人助理生产交付计划](production-assistant-plan.md)：复用能力、必要修补、桌面与服务器验收、发布恢复                         |
| 用个人助理整理资料、设提醒、接日历邮箱和检查发送结果 | [个人助理使用说明](personal-assistant.md)                                                                                    |
| 理解系统怎么搭的                                     | [架构 architecture](architecture.md) · [数据模型 data-model](data-model.md) · [ADR](adr/README.md)                           |
| 知道为什么这样做、有哪些长期规则                     | [产品决策与需求原则 decisions](decisions.md) · [ADR](adr/README.md)                                                          |
| 改界面                                               | [DESIGN.md](../DESIGN.md)（顶部章节索引）· [设置的信息结构](settings-ia.md)                                                  |
| 提交改动                                             | [CONTRIBUTING](../CONTRIBUTING.md) · [并行开发协议](dev/parallel-work.md)                                                    |
| 自己部署、运维一套 ChisaBot                          | [运维手册 ops/](ops/README.md)（主机端口、容器、目录、部署回滚、网关、云端节点、发版、模型、测试环境、巡检、清理、故障复盘） |
| 发布 DSH、核心服务与共用网页                         | [部署、回滚与上线检查](ops/deploy.md)（串行入口）· [DSH 运行时与恢复](ops/dsh-runtime.md) · [网关同步](ops/gateway.md)       |
| 了解命名空间切换与存量卷兼容边界                     | [命名切换与存量资源兼容](ops/upstream-removal.md)（0067 / 0068 迁移与卷固定）                                                |
| 测试                                                 | [测试与验证 testing](testing.md)                                                                                             |
| 看懂中文术语                                         | [术语表 glossary](glossary.md)                                                                                               |

## 当前维护入口

首次安装按 [快速开始](getting-started.md) → [自托管部署](../deploy/README.zh-CN.md) 配置应用、DSH 账号 Host 和认证网关。已有安装统一沿 [串行部署](ops/deploy.md) 更新：前端、核心服务和 DSH 依赖来自同一版本，独立 Host 使用匹配的运行配置；网关或登录服务有变化时纳入同次发布。PC / Android 外壳发包另见 [发布流程](release.md)，网页更新仍来自同一服务器。

当前代码位置和接口以 [架构](architecture.md) 为准：客户端统一调用 `/api/conversations`，DSH 通过产品工具网关执行带账号、机器人和回合身份的操作。

## 项目管理

| 文档                             | 内容                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------ |
| [ROADMAP.md](ROADMAP.md)         | 里程碑、现在 / 接下来 / 以后、最近完成                                         |
| [BACKLOG.md](BACKLOG.md)         | CB-001 起的全部条目、验收标准、状态（GitHub Issues 未开启前它就是 issue 列表） |
| [HANDOFF.md](HANDOFF.md)         | 当前主线状态摘要与开发交接快速入口                                             |
| [decisions.md](decisions.md)     | 所有者的长期规则（发布流程、测试安全、版本号、界面原则），带日期               |
| [CHANGELOG.md](CHANGELOG.md)     | 按发版标签分组的版本与 PR 记录                                                 |
| [adr/](adr/README.md)            | 架构决策记录 0001–0014（0012 号空缺）                                          |
| [pipeline-runs/](pipeline-runs/) | 带日期的实施、验收与发布证据                                                   |

## 架构

- [DSH 主内核完整设计与迁移方案](dsh-kernel-migration.md)：已实施完成的内核迁移设计（v0.1.138–v0.1.143）；上线证据见 [R5 实施记录](pipeline-runs/20261107-dsh-migration.md)。
- [个人助理生产交付计划](production-assistant-plan.md)：已实施完成的个人助理整合方案（v0.1.138–v0.1.143）；[现有能力核对](research/20261108-assistant-capability-baseline.md) · [开源实现核对](research/20261108-assistant-upstream-patterns.md)。
- [ChisaBot 架构](architecture.md)：服务器 agent、公网网关、更新器、PC 节点、Android、云端浏览器，以及每个功能的代码位置、数据表、DESIGN 章节与常用运行时开关。
- [数据模型](data-model.md)：会话与效果账本、当前业务表、网关 SQLite、浏览器本地存储。
- [流式回复：从模型到屏幕](streaming.md)
- [自托管部署与能力边界](chisabot.md)：本地存储、DSH 内核、第三方/自建推理、数据兼容与客户端形态。

## 功能文档（按范围）

完整列表见 [features.md](features.md)。

| 范围                 | 文档                                                                                                                                            | DESIGN                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 聊天                 | [流式回复](streaming.md) · [聊天文件与图片生成](chat-files.md) · [聊天可靠性](chat-reliability.md)                                              | §24–§27、§30–§32、§35、§38、§42、§48、§56、§67–§70、§75、§76、§83、§88–§90、§92–§94 |
| 机器人               | [机器人头像](bot-avatars.md) · [BOT 配置](coworkers.md)                                                                                         | §46、§47、§74、§81                                                                  |
| 确认与权限           | [确认卡片与审批偏好](confirmations.md)                                                                                                          | §58、§97                                                                            |
| 模型                 | [模型配置与切换](models.md) · [Magpie 深度集成](magpie.md)                                                                                      | §15、§59–§61                                                                        |
| 面板 / 计算机        | [浏览器多标签与收藏夹](browser-tabs.md) · [侧栏与弹出面板一致性](sidebar-panel-parity.md) · [面板的直连数据源与看板布局](live-panel-sources.md) | §23、§29、§39、§43、§77、§79、§95、§96、§109                                        |
| 设备 / PC / 手机     | [PC 节点与扫码绑定](pc-node.md) · [本地 agent 与权限档位](local-agents.md) · [Android 客户端](android-native.md) · [手机网页版与 PWA](pwa.md)   | §16、§33、§36、§40、§45、§62、§66、§80、§86、§91                                    |
| 记忆 · 技能 · 保险箱 | [长期记忆](memory.md) · [技能](skills.md) · [密钥保险箱](vault.md)                                                                              | §50–§52                                                                             |
| GitHub · 页面 · 定时 | [GitHub 账号连接](github.md) · [页面](pages.md) · [定时任务与提醒](schedules.md)                                                                | §53–§55                                                                             |
| IM                   | [IM 接入](im.md)                                                                                                                                | §49                                                                                 |
| 账号                 | [朋友账号（多账号，默认隐藏）](accounts.md)                                                                                                     | §65                                                                                 |
| 设置                 | [设置的信息结构与搜索](settings-ia.md)                                                                                                          | §57、§71、§97                                                                       |
| 工作流（默认隐藏）   | [工作流](workflows.md)                                                                                                                          | §26                                                                                 |
| 瘦身                 | [瘦身计划与进度](slimming.md)                                                                                                                   | §57、§74                                                                            |

## 运维、发布与测试

| 文档                                        | 适合解决的问题                                                       |
| ------------------------------------------- | -------------------------------------------------------------------- |
| [快速开始](getting-started.md)              | 第一次部署，配置完成后怎样开始聊天                                   |
| [本地开发参考](development.md)              | 本地数据库迁移、分开启动服务与质量检查；生产使用本表的部署入口       |
| [自托管部署](../deploy/README.zh-CN.md)     | 镜像、持久化、认证网关与 Magpie 部署模板                             |
| [**运维手册（总览）**](ops/README.md)       | 自己部署后长期运维的全部章节入口与一页速查                           |
| [主机与端口规划](ops/hosts.md)              | 机器配置、公网端口、只绑 loopback 的端口、防火墙                     |
| [容器与服务](ops/containers.md)             | 每个容器、镜像、卷、systemd 单元的用途                               |
| [目录布局与凭据存放](ops/layout.md)         | 宿主机目录、各类密钥应放在哪里与权限                                 |
| [部署、回滚与上线检查](ops/deploy.md)       | 合并后怎么上线、更新器怎么工作、怎么回滚、上线后检查什么             |
| [DSH 运行时与恢复](ops/dsh-runtime.md)      | 账号 Host、targets、Session、完整备份与兼容恢复                      |
| [命名切换与存量资源兼容](ops/upstream-removal.md) | 0067 / 0068 表重命名、废弃表清理与存量卷固定                    |
| [网关与登录服务](ops/gateway.md)            | nginx 规则、登录服务、多账号开关、签名身份密钥、证书                 |
| [客户端发布（运维）](ops/client-release.md) | 更新源目录、APK 签名、发版上传与临时文件安全删除                     |
| [模型配置运维](ops/model-config.md)         | 默认 / 备用模型、生图识图、额度用完怎么办                            |
| [预览与测试环境](ops/preview.md)            | 预览容器、出网封锁、生产测试守则与只读检查                           |
| [监控与巡检](ops/monitoring.md)             | 每日 / 上线后的只读巡检清单、定时任务、日志                          |
| [磁盘清理指南](ops/cleanup.md)              | 保留什么、可以删什么、不要碰什么                                     |
| [常见故障与事故复盘](ops/incidents.md)      | 典型故障处理、过去事故的教训、整机迁移                               |
| [发布流程](release.md)                      | 版本号规则、服务器上线、客户端发版、外壳指纹与「重新安装」、自测规则 |
| [测试与验证](testing.md)                    | 单元测试、预览约定、回归套件、生产只读检查、已知不稳定测试           |
| [在线更新](online-update.md)                | 网页提示刷新、PC / Android 自动更新、系统更新（宿主机更新器）        |
| [管理员自检](admin-smoke.md)                | 不碰任何对话的模型往返检查                                           |
| [维护与排错](operations.md)                 | 备份、升级、连接故障与部署验收                                       |
| [环境配置](configuration.md)                | 环境变量和租户包 YAML                                                |
| [第三方许可与代码来源](THIRD_PARTY_NOTICES.md) | 第三方开源组件、内置源码许可与架构参考说明                        |

常见问题：

- [在哪里填写模型 API 和密钥](models.md#管理员配置连接)
- [聊天输入框与 BOT 设置为什么是同一个值](models.md#bot-模型选择)
- [怎样让 Magpie 的多个模型进入选择器](magpie.md#配置顺序)
- [切换模型何时生效，运行中的回复使用哪个模型](models.md#目录缓存和运行快照)
- [模型不可用，怎样定位网关、权限或上游问题](operations.md#模型问题排查)

## 可选集成

以下是按需接入的现有能力，是否可用取决于部署配置和实际授权。

- [联网研究](parallel-research.md)：Parallel Search 连接器。
- [Composio](plugins/composio.md)、[Google Drive](plugins/google-drive.md)、[Notion](plugins/notion.md)：外部连接器（插件与 MCP 默认隐藏，`CHISABOT_EXTRAS=plugins`）。

<a id="历史技术参考"></a>

## 历史与演进参考

以下资料用于追溯架构决策或历史收敛过程。当前运行结构以 [架构](architecture.md) 为准，生产发布沿上文维护入口执行。

- [瘦身记录](slimming.md) 与 [去上游印记说明](ops/upstream-removal.md)：记录已移除组件、0067 / 0068 数据库整理与存量数据保护边界。
- [研究资料](research/) 与 [架构决策](adr/README.md)：保留当时的调研对比与设计决定；后续状态演进在实施记录与看板中跟踪。

默认中文租户包见 [examples/zh-CN](../examples/zh-CN/README.md)。文档只保存可复用说明与脱敏示例；真实主机地址、登录密码、模型密钥、客户数据与私人部署资料不写入文档或公开仓库。
