# ChisaBot 文档

ChisaBot 是中文自托管 AI 助手平台，提供网页登录、本地会话持久化、可配置模型和 Magpie 多模型接入。以下指南从部署、使用到实现说明逐层展开。

## 使用与部署

| 文档 | 适合解决的问题 |
| --- | --- |
| [快速开始](getting-started.md) | 第一次部署，配置完成后怎样开始聊天 |
| [自托管部署](../deploy/README.zh-CN.md) | 镜像、持久化、认证网关与 Magpie 部署模板 |
| [模型配置与切换](models.md) | 全局连接、默认模型、每 BOT 独立选择和两处同步 |
| [Magpie 深度集成](magpie.md) | 网关协议、完整模型 ID、开放目录、调用密钥与排错 |
| [维护与排错](operations.md) | 备份、升级、连接故障与部署验收 |
| [分支与能力边界](chisabot.md) | 本地模式、第三方推理、数据兼容和客户端状态 |
| [来源与许可](THIRD_PARTY_NOTICES.md) | 上游项目与保留的许可证声明 |

需要找到具体答案：

- [在哪里填写模型 API 和密钥](models.md#管理员配置连接)
- [聊天输入框与 BOT 设置为什么是同一个值](models.md#bot-模型选择)
- [怎样让 Magpie 的多个模型进入选择器](magpie.md#配置顺序)
- [为什么 Magpie 模型多，而 ChisaBot 只显示少数](magpie.md#目录与调用密钥)
- [切换模型何时生效，运行中的回复使用哪个模型](models.md#目录缓存和运行快照)
- [模型不可用，怎样定位网关、权限或上游问题](operations.md#模型问题排查)

## 开发实现

[模型配置](models.md#api-与保存结构) 说明 API、共享类型、数据库结构和权限；[运行快照](models.md#目录缓存和运行快照) 说明缓存及策略与执行的一致性；[Magpie 请求链路](magpie.md#每-bot-选择与请求链路) 说明网关对接。各页附有对应源码入口。

默认中文租户包见 [examples/zh-CN](../examples/zh-CN/README.md)。内部 `OPENBOT_*` 环境变量、包名、协议及数据目录保留兼容，展示品牌为 ChisaBot。

## 上游技术参考

以下资料继承自 [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot)，用于查阅保留的工具、权限、框架与可选集成。Intelligence 和自动学习步骤，仅在选用相应能力时适用；本地自托管不要求 CopilotKit 托管服务。容器发布见 [发布](releasing.md)。功能流水记录见 [pipeline-runs](pipeline-runs/README.md)。

- [架构](architecture.md)：服务、端口、电脑、工具及安全边界。
- [环境配置](configuration.md)：环境变量和租户包 YAML。
- [开发参考](development.md)：迁移、分开启动服务与质量检查。
- [BOT 配置](coworkers.md)：持久配置、可见性、删除及外部 AG-UI 注册。
- [定时任务](routines.md)：后台工作进程、调度及执行身份。
- [自动学习](automatic-learning.md)：依赖 Intelligence 的可选能力。
- [联网研究](parallel-research.md)：Parallel Search 连接器。
- [Composio](plugins/composio.md)、[Google Drive](plugins/google-drive.md)、[Notion](plugins/notion.md)：按需配置的外部连接器。
- [容器部署](deployment.md)、[Kubernetes](../charts/openbot/README.md)：发布镜像 `ghcr.io/chisaalter/chisabot`。生产机仍用 `deploy/` 构建本地镜像。
- [发布](releasing.md)、[Windows 签名](windows-signing.md)：本仓库的容器镜像与 GitHub Release；Windows 签名仍是上游证书，见发布文首。
- [流水记录](pipeline-runs/README.md)：每次功能流水的需求、方案和拉取请求。
- [桌面模型 OAuth](../desktop/PROVIDER_OAUTH.md)、[桌面遥测](../desktop/TELEMETRY.md)：客户端可选配置。

文档只保存可复用说明与脱敏示例。真实登录密码、模型密钥、客户数据、对话和私人部署资料不写入文档或仓库。
