# ChisaBot 自托管架构与能力边界

[文档首页](README.md) · [快速开始](getting-started.md) · [系统架构](architecture.md) · [模型配置](models.md) · [Magpie](magpie.md)

ChisaBot 是以 **DSH 为执行内核**的全中文自托管私人助手，覆盖网页端、Windows PC 客户端（Electron + 设备节点）、Android 客户端（Kotlin 壳 + 同源手机布局）以及主流 IM 渠道。项目基于 [MIT License](../LICENSE) 开源，第三方开源组件与早期代码来源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 1. 自托管软件与模型推理边界

软件部署位置与模型推理服务是两个相互独立的选择：

| 层次                     | ChisaBot 的运行方式                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 网页、API 服务与认证网关 | 部署在你自己的服务器或电脑上，不依赖任何官方托管云端控制面                                                               |
| 会话、记忆与业务账本     | `CHISABOT_RUNTIME_MODE=local`，完整保存在你自己的 PostgreSQL（`chisabot_*` 表）与 DSH Session 持久卷中                   |
| 执行内核                 | `CHISABOT_AGENT_KERNEL=dsh`，每账号独立 DSH Host 进程驱动模型/工具循环，经内部工具网关受控执行操作与审批                 |
| 模型推理网关             | 可接入自部署 Magpie 统一管理多家供应商与密钥，也可直连 OpenAI / Anthropic / Google 或本地 Ollama 等兼容接口              |
| 云端浏览器与设备节点     | 容器内 `agent-computer` 提供隔离浏览器与 `/workspace`；PC 客户端与 `chisabot-node` 通过 WSS 连接受控操作你的电脑与服务器 |

当接入第三方云端大模型 API 时，当前回合所需的上下文与工具定义会发送至你所配置的模型服务商；若希望推理过程同样完全留在受控硬件内，可将模型地址指向内网自建的兼容推理服务端，并按需关闭联网搜索与外部连接器。

## 2. 中文部署包与公网登录边界

`examples/zh-CN/` 提供默认中文品牌、共享技能与初始配置模板。`deploy/` 提供容器编排与 `deploy/public/` 前置 HTTPS 登录网关模板：

- 公网访问统一经前置认证网关完成 Argon2id 密码会话校验，再向仅监听回环地址（`127.0.0.1:3001`）的应用后端签发身份请求头。
- `CHISABOT_SINGLE_USER=true` 仅用于本机回环开发调试，或处在已启用前置 HTTPS 登录网关保护的内部后端；严禁将未受网关保护的单用户端口直接暴露到公网（详见 [安全信任边界](ops/trust-boundary.md) 与 [自托管部署](../deploy/README.zh-CN.md)）。

## 3. 命名空间与存量数据兼容

现役代码、HTTP 路由（`/api/conversations`）、请求头（`x-chisabot-*`）、环境变量（`CHISABOT_*`）与数据库会话表（`chisabot_local_*`、`chisabot_channel_mappings`）均已统一收敛至 ChisaBot 自有命名空间：

- 中文租户包的 `tenant.id` 保持为 `chisabot`，展示名称为 `ChisaBot`。
- 已部署实例升级时，启动脚本通过 `deploy/pin-resources.sh` 与数据库卷内的 `identity` 文件（`docker/s6/scripts/database-identity.sh`）保留原物理卷、网络与内置 PostgreSQL 角色身份，确保历史会话、保险箱密钥与工作区文件零丢失（详见 [命名切换与存量资源兼容](ops/upstream-removal.md)）。

## 4. 客户端与分发说明

- **网页 / PWA**：随服务端镜像同步更新，支持桌面三栏与手机单栏布局。
- **Windows PC（`pc/`）与无界面节点（`chisabot-node`）**：集成聊天窗口与本地文件/终端/编程代理节点能力，支持签名在线更新（见 [PC 更新签名](pc-update-signing.md) 与 [发布流程](release.md)）。
- **Android（`android/`）**：原生壳提供扫码绑定、相机/文件选择、通知与 APK 更新，主界面复用服务器手机端 React 布局。

自行构建或二次分发客户端安装包前，请替换为你自己的更新源地址、应用签名证书与服务器域名配置。
