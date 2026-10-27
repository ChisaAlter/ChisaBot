# 快速开始

[文档首页](README.md) · [模型配置](models.md) · [Magpie 集成](magpie.md) · [部署](../deploy/README.zh-CN.md)

## 选择运行方式

ChisaBot 的网页登录、API 和数据库可以部署在自己的服务器。使用 `CHISABOT_RUNTIME_MODE=local`，会话保存在自己的 PostgreSQL 中，无需登录 CopilotKit 或创建 Intelligence 项目。

模型可以使用自己的兼容服务，也可以连接第三方 API。需要统一多个供应商与模型时，先部署 Magpie，再让 ChisaBot 连接它。详见 [能力边界](chisabot.md)。

## 自托管步骤

1. 按 [deploy/README.zh-CN.md](../deploy/README.zh-CN.md) 准备自己的域名、持久化数据库、加密密钥与网页登录。使用仓库模板，不要复制别人的真实部署凭据。
2. 选择本地运行模式，并让服务端和前端使用同一个中文租户包。
3. 启动应用与认证网关，确认能登录、退出登录，再打开管理页面。
4. 在 **管理 → 模型配置** 填写协议、API 地址、密钥与部署默认模型。点 **测试连接**，成功后保存。
5. 打开 BOT 聊天，选择需要的模型，发送一条简单消息。检查回复成功且重启后会话可继续访问。

核心运行设置示例：

```dotenv
CHISABOT_RUNTIME_MODE=local
TENANT_PACKAGE_DIR=../examples/zh-CN
CHISABOT_SELF_HOST_BANNER=false
COPILOTKIT_TELEMETRY_DISABLED=true
DO_NOT_TRACK=1
```

数据库、加密与登录配置见部署模板。`local` 只表示会话运行后端，不代表默认关闭全部外部模型、插件或网络请求。

## 开发环境

准备 Bun 1.3.14、Docker 和 PostgreSQL。从自己的环境文件开始配置数据库与模型连接，再安装依赖：

```sh
bun install --frozen-lockfile
bun run generate:app-config
bun run typecheck
```

`TENANT_PACKAGE_DIR=../examples/zh-CN` 按服务端工作目录解析。前端生成配置时应使用相同租户包。数据库迁移及分开启动服务的方法见 [开发参考](development.md)。

上游开发参考中的 Intelligence 登录与学习容器步骤只用于 `intelligence` 模式；选择 `local` 时不需要这些步骤。仅运行 `bun run dev` 不会替你完成生产登录网关、数据库和所有工具服务的部署。

## 接入模型后的日常操作

- 更改整个部署的默认模型：在管理模型页面修改并保存；继承默认值的 BOT 随之改变。
- 只更改一个 BOT：在聊天输入框的模型选择器，或这个 BOT 的设置中修改。
- 两处同步：同一个 BOT 的聊天和设置共用持久化值，保存成功后同步，其他 BOT 保持自己的选择。
- 获取新增模型：在选择器中刷新；连接 Magpie 时，也要先在 Magpie 中启用供应商并开放模型。
- 恢复跟随默认：选择“部署默认”，清除这个 BOT 的独立覆盖值。

具体操作、失败处理与权限见 [模型配置与切换](models.md)。
