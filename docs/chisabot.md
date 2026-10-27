# ChisaBot 分支与能力边界

[文档首页](README.md) · [快速开始](getting-started.md) · [模型配置](models.md) · [Magpie](magpie.md)

ChisaBot 是 [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) 的中文自托管分支。产品展示名称统一为 ChisaBot，继续保留 MIT 许可证和上游版权声明。

## 软件自托管与模型推理

自托管软件与运行模型是两个独立选择。

| 组件 | 本分支的选择 |
| --- | --- |
| 网页、API、网页登录 | 部署在自己的服务器或电脑 |
| 对话与 BOT 配置 | `local` 模式保存在自己的 PostgreSQL |
| 模型推理 | 自托管兼容服务，或自己选择的第三方 API |
| Magpie | 可自部署；统一管理模型服务、账户和调用密钥 |
| CopilotKit Intelligence | 可选；本地运行模式不需要项目或托管服务 |

设置 `CHISABOT_RUNTIME_MODE=local` 后，服务端使用本地会话实现，不要求 `INTELLIGENCE_API_KEY`、`INTELLIGENCE_API_URL` 或 `INTELLIGENCE_GATEWAY_WS_URL`。本地模式不提供依赖 Intelligence 的自动学习及云端管理功能。

`CHISABOT_RUNTIME_MODE=intelligence` 保留上游运行方式，需要配置 Intelligence 项目连接。不要把上游文档中的要求当作本地模式的要求。

如果模型通过第三方 API 推理，对话请求会发送到所选模型服务。要将推理也留在自己控制的设备上，可接入 Ollama 等提供 OpenAI 兼容接口的自托管服务，并按需要关闭外部连接器、遥测与依赖联网的界面能力。模型本身的权重许可和硬件要求由所选模型决定。

## 中文与网页登录

`examples/zh-CN/` 包含中文品牌、BOT、频道与技能配置。`deploy/` 提供登录服务与认证网关模板，由网关验证登录后访问应用内部服务；登录会话、模型密钥和数据库保留在部署环境中。

`CHISABOT_SINGLE_USER=true` 仅适用于本地开发或由认证网关保护的内部服务。完整步骤见 [部署说明](../deploy/README.zh-CN.md)。

## 改名与数据兼容

以下内部名称继续保留，避免改名影响已有数据或接口：

- `CHISABOT_*` 环境变量、`@chisabot/*` 内部包名及协议标识。
- 现有租户 ID、数据库、Docker 服务、存储卷与本地数据目录。
- 桌面 Tauri 标识、二进制名称、移动应用标识与深层链接协议。

这些内部名称与 ChisaBot 展示品牌分别维护。中文租户包的 `tenant.id` 保留为 `chisabot`，`product_name` 为 `ChisaBot`。

## 客户端与上游资料

桌面和移动源码保留上游的安装、OAuth、遥测和发布集成。桌面安装流程中部分软件下载仍使用上游来源，分发前应检查自己的配置、构建与签名。私有源码仓库不表示已有 ChisaBot 公共镜像、桌面安装器或移动安装包。

[上游技术参考](README.md#上游技术参考) 保留架构、工具权限、插件和发布资料。涉及上游发布基础设施、Intelligence 及自动学习的步骤只在选用相应能力时适用。
