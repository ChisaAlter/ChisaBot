<p align="center">
  <img src="docs/images/logo.png" width="132" height="132" alt="ChisaBot 标志">
</p>

<h1 align="center">ChisaBot</h1>

<p align="center"><b>中文、自托管、可配置模型的 AI 助手平台。</b><br>网页 · Windows PC 客户端 · Android 客户端，连同一台你自己的服务器。</p>

<p align="center">
  <a href="docs/README.md">文档首页</a> ·
  <a href="docs/getting-started.md">快速开始</a> ·
  <a href="docs/models.md">模型配置与切换</a> ·
  <a href="docs/magpie.md">Magpie 深度集成</a> ·
  <a href="deploy/README.zh-CN.md">自托管部署</a> ·
  <a href="https://github.com/ChisaAlter/ChisaBot/releases">下载客户端</a>
</p>

ChisaBot 是以 DSH 为执行内核的中文私人助手。服务器负责会话、任务、权限、审批和交付；PostgreSQL 保存产品历史，独立 DSH Host 保存模型执行 Session。网页、Windows 和 Android 共用聊天界面。模型由管理员接入，可以使用兼容 API 或自部署的 [Magpie](https://github.com/yetone/magpie) 网关；推理由所选模型服务处理。

## 截图

> 以下截图来自一个全新的演示实例（演示账号、演示机器人，没有任何真实对话）。

### 网页（服务器）

浅色：左边是机器人列表，中间是对话，右栏是「面板 | 任务 | 计算机」。

![ChisaBot 网页 · 浅色](docs/images/web-desktop-light.webp)

<details>
<summary>深色模式</summary>

![ChisaBot 网页 · 深色](docs/images/web-desktop-dark.webp)

</details>

<details>
<summary>登录页（认证网关）</summary>

![ChisaBot 登录页](docs/images/web-login.webp)

</details>

### PC 客户端（Windows）

ChisaBot PC 是无边框窗口，打开后直接进入你服务器上的 ChisaBot，右上角是窗口按钮；首次运行先在本机的「登录 ChisaBot」页填写服务器地址。

![ChisaBot PC 客户端](docs/images/pc-client.webp)

<sub>说明：截图在 Linux 服务器上渲染，不是在 Windows 上截的——客户端窗口里显示的就是这套网页（桌面窗口模式，带窗口按钮），外框阴影是后加的。</sub>

<details>
<summary>PC / Android 客户端的本机登录页</summary>

![ChisaBot 客户端登录页](docs/images/pc-login.webp)

</details>

### 手机

手机浏览器（390×844）里的对话和面板，以及 Android 客户端的登录页。

![ChisaBot 手机端](docs/images/mobile.webp)

## 已有功能

- **中文界面**：聊天、BOT 管理、设置与管理页面中文化，内置中文租户包位于 `examples/zh-CN/`。
- **网页登录**：登录页面、服务端会话与退出登录，认证网关保护页面及 API。
- **DSH 执行与持久化**：会话命令、展示历史和效果账本保存在 PostgreSQL，DSH Session 使用独立持久存储；重启后接回原执行。
- **模型配置**：管理员配置协议、API 地址、密钥与部署默认模型，并测试连接；密钥由服务端加密保存。
- **Magpie 模型目录**：读取网关实际开放的完整模型列表，保留供应商前缀，支持搜索和刷新。
- **每 BOT 独立选择**：聊天输入框与 BOT 设置修改同一个持久化值，两处及跨标签页同步，下一轮使用新模型。
- **工具与权限**：支持 AG-UI 接入、设备与云端浏览器、MCP 工具、审批和审计，按部署配置启用。
- **面板与云端浏览器**：机器人可以在右栏建面板（可定时刷新），也可以在服务器上的云端浏览器里打开和操作网页，右栏「面板 | 任务 | 计算机」切换查看。
- **客户端与在线更新**：Windows PC（Electron）和 Android 客户端连接你自己的服务器；服务器在「管理后台 → 系统更新」一键更新，网页和客户端各自提示新版本。

目录表示当前网关连接向 ChisaBot 开放的模型，不表示全部供应商缓存，也不保证每个上游模型均可调用。具体权限、额度和服务状态由上游决定。

## 开发与部署

开发依赖：Bun 1.3.14、Node.js 24.9 以上、Docker 和 PostgreSQL。DSH 的固定版本与部署接线见 [DSH 运维](docs/ops/dsh-runtime.md)。

```sh
bun install --frozen-lockfile --omit=peer
npm ci --prefix runtime/dsh
bun run typecheck
```

自托管模板及认证网关放在 `deploy/`，详见 [部署说明](deploy/README.zh-CN.md)。数据库连接、加密密钥、登录与模型连接需要按自己的环境配置。密码、模型密钥、数据库备份与浏览器资料不写入仓库。

项目维护：[路线图（看板）](docs/ROADMAP.md) · [Backlog](docs/BACKLOG.md) · [架构](docs/architecture.md) · [架构决策 ADR](docs/adr/README.md) · [参与开发](CONTRIBUTING.md) · [文档目录](docs/README.md)。

当前产品接口统一为 `/api/conversations`，模型执行交给 DSH；存量数据与部署资源的升级规则见 [迁移说明](docs/ops/upstream-removal.md)。发布版本与尚未完成的外部资源验收统一记录在 [实施记录](docs/pipeline-runs/20261108-assistant-production.md)。

`CHISABOT_SINGLE_USER=true` 只用于本地开发或由认证网关保护的内部服务；对外入口必须配置登录保护。详细能力边界与源码位置见 [架构与能力边界](docs/chisabot.md)。

## 给 AI 的部署引导

首次安装从 [快速开始](docs/getting-started.md) 进入，已有安装按 [部署、回滚与上线检查](docs/ops/deploy.md) 走串行更新器。环境配置、构建命令与网关初始化的完整步骤见 [自托管部署](deploy/README.zh-CN.md)。

1. **准备同一份版本**：根 `Dockerfile` 的 `chisabot` 目标构建前端、核心服务、DSH 依赖与云端工具；在 [DSH 运维](docs/ops/dsh-runtime.md) 配好账号 Host、targets、Session 卷和工具网关。`CHISABOT_AGENT_KERNEL=dsh` 是内核选择，账号运行环境仍须配置。
2. **沿现有资源升级**：保留数据库、Session、workspace、profiles、加密密钥和登录会话。`0067` / `0068` 表命名归一及存量挂载卷固定要求以 [迁移说明](docs/ops/upstream-removal.md) 为准。
3. **完成整个发布单元**：核心镜像由串行更新器处理；同一版本改到登录服务或 nginx 时，按 [网关运维](docs/ops/gateway.md) 同步。PC 和 Android 共用服务器网页，只有外壳发生变化才另发安装包，见 [发布流程](docs/release.md)。
4. **记录运行证据**：源码检查、镜像构建、数据库迁移、恢复演练、入口切换和真实客户端验收分别记在 [实施记录](docs/pipeline-runs/20261108-assistant-production.md)。该记录保存当前候选与生产状态；文档中的默认端口和资源名不代表某台服务器的实际配置。

维护中需要模型往返时使用 [管理员自检](docs/admin-smoke.md)，不向真实对话插入测试消息。密钥、会话库、证书和备份留在部署环境，配置文件中的实际值不写入日志或仓库。跨 reader 的恢复先检查兼容要求；保存的旧镜像不等于可用的回滚目标。

## 目录

| 路径                            | 内容                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app/`                          | 中文 Web 界面                                                                                                                                                                              |
| `server/`                       | Conversation API、历史、任务、审批、交付与 DSH 工具网关                                                                                                                                    |
| `runtime/dsh/`                  | 固定版本的 DSH Host、模型/工具循环与 Session 适配                                                                                                                                          |
| `agent-computer/`               | 云端浏览器、工作区和命令工具                                                                                                                                                               |
| `shared/`                       | 前后端共享类型与协议                                                                                                                                                                       |
| `examples/zh-CN/`               | 中文品牌、BOT、频道和技能配置                                                                                                                                                              |
| `deploy/`                       | 镜像配置、认证网关、DSH 账号运维与宿主机更新器                                                                                                                                             |
| `scripts/ops/`                  | 串行发布、网关同步和运维入口                                                                                                                                                               |
| `pc/`                           | ChisaBot PC（Windows，Electron）客户端：设备节点 + 在线更新                                                                                                                                |
| `android/`                      | ChisaBot Android 客户端（Kotlin 壳 + WebView，minSdk 24）：使用桌面同一 React 前端的手机布局；保留扫码 / 账号登录、系统文件与权限、返回键及 APK 在线更新（[说明](docs/android-native.md)） |
| `.github/workflows/release.yml` | 推 `v*` 标签时用 GitHub Actions 构建 PC + Android 安装包并发布到 Releases                                                                                                                  |
| `deploy/updater/`               | 宿主机在线更新服务（管理后台 → 系统更新）                                                                                                                                                  |
| `docs/`                         | 当前使用与运维文档；`pipeline-runs/` 保存实施证据，历史参考单独导航                                                                                                                        |
| `assets/brand/`                 | 品牌头像原图与生成脚本（`node assets/brand/generate.mjs` 生成网页、登录页、PC、Android 的全部图标），规则见 `DESIGN.md` §28                                                                |

第三方连接器按需启用；服务器执行由 DSH 和本地会话服务承担。本仓库不提供 ChisaBot 公共镜像。PC（`pc/`）和 Android（`android/`）客户端的通用安装包在本仓库的 GitHub Releases（CI 构建，首次运行填自己的服务器地址）；也可以自己构建并放到自己的更新源（见 [客户端发布](docs/ops/client-release.md)）。

## 来源与许可证

本项目基于 [MIT License](LICENSE) 开源，第三方开源组件与代码来源说明见 [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)。
