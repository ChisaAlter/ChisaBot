# ChisaBot 概览

> 截至 2026-10-17：服务器 main `0e23321`（PR #192），客户端最新 **v0.1.15**（PC 0.1.15 / Android 0.1.15，versionCode 221）。
> 变更见 [CHANGELOG](CHANGELOG.md)，看板见 [ROADMAP](ROADMAP.md)。

## 1. 它是什么

ChisaBot 是 [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) 的**中文私人助手分支**，自托管、全中文界面、蓝天磨砂玻璃风格。
一句话：**一台云端服务器上的机器人，替你在任何地方管理你所有的设备，并像一个贴身助手一样把事情做完。**

- 机器人（agent）在服务器上运行：聊天、联网搜索、开浏览器、做面板 / 页面、记住你、按时提醒你、帮你写代码。
- 你的电脑、服务器是机器人的**设备节点**：机器人能在上面读 / 改 / 写文件、跑命令、写代码；有后果的操作先问你。
- 网页、PC、Android、PWA 看到的是**同一段对话**，任何一端发的消息另一端几秒内出现。
- 仓库公开，任何人都能部署自己的一份（见 [README「给 AI 的部署引导」](../README.md#给-ai-的部署引导)）。

## 2. 核心目标（产品方向）

按优先级（来源：[decisions.md](decisions.md)）：

1. **在任何地方管理所有设备（包括本地电脑）**：云端机器人能读、改、写本地文件和代码；本地电脑有「完全访问」这样的权限档位，
   像本地 OpenClaw / Hermes 一样能干活，同时有权限控制、沙箱、agent 选择。
2. **体验向 Hark 看齐**：输出内容、思考 / 加载的呈现、自定义面板、链接卡、记忆、技能、保险箱、定时任务、页面……尽量接近 Hark。
3. **尽快做成「相对成熟、可以分享给朋友用」的产品**：先单用户；多用户（朋友账号）已经做好但默认隐藏。
4. **持续瘦身**：上游 ChisaBot 的企业功能（SSO、SCIM、团队、企业闸门……）逐步去掉，「先入口、后代码、最后数据」。

## 3. 组成

```
 网页 / PWA ─┐   PC 客户端（Windows, Electron）──┐   Android（原生 Kotlin + Compose）   IM（QQ/微信/飞书/…）
             │      聊天窗口 + 设备节点(WSS)      │      登录 + 聊天 + 面板                  │
             ▼                                    ▼               ▼                          ▼
        ┌──────────────── 公网网关（nginx + 登录服务，TLS）────────────────────────────────────┐
        └──────────────────────────────┬────────────────────────────────────────────────────┘
                                       ▼
        ┌──────── 应用容器：server（Hono + CopilotKit runtime）+ app（React）+ PostgreSQL + 云端浏览器 ──┐
        └───────┬───────────────────────────────┬──────────────────────────────┬───────────────────┘
                ▼                               ▼                              ▼
        模型网关（Magpie，可选）      宿主机更新器 chisabot-updater       云端工作区节点（Claude Code，可选）
```

| 组件 | 代码 | 做什么 | 怎么更新 |
|---|---|---|---|
| **Web 应用** | `app/`（React + TanStack Router + CopilotKit） | 聊天、设置、管理的唯一界面；PC 和 Android 的「更多设置」也加载它 | 随服务器部署，网页提示「有新版本，点此刷新」 |
| **服务器** | `server/`（Hono + CopilotKit runtime） | 跑每个机器人的回合、工具、定时任务、面板刷新、IM 连接；ChisaBot 自己的表开机自建 | 一键更新 / `deploy-serial.sh` |
| **云端浏览器** | `agent-computer/`（Chromium on Xvfb） | 机器人的浏览器 + `/workspace` 工作区；多标签、收藏夹、可接管 | 随服务器镜像 |
| **PC 客户端** | `pc/`（Electron, Windows） | 一个窗口加载服务器网页 + 一个**设备节点**（主动 WSS 连服务器）；小窗模式、托盘、电脑文件夹同步、本地 agent | electron-updater，外壳指纹变了要「重新安装」 |
| **无界面节点** | `pc/src/headless.js` → `chisabot-node` | Linux / macOS 服务器当设备（一行命令安装，systemd / launchd） | 节点自动下载新版 |
| **Android** | `android/`（Kotlin + Jetpack Compose，0.1.13 起原生） | 登录（扫码 / 账号密码）、机器人列表、聊天、面板、确认卡、附件；其余设置用应用内网页 | `latest.json` 更新源，versionCode 只增 |
| **公网网关** | `deploy/public/`（nginx + `auth/server.ts`） | TLS、登录（Argon2id + 会话）、签名身份、公开页面 `/p/`、设备 / OneBot 例外路由 | **手工部署**，不随一键更新 |
| **更新器** | `deploy/updater/`（python3, systemd） | 拉 main → 快速更新或完整构建 → 备份 → 切换 → 健康检查 → 失败自动回滚 | 每次成功更新后自升级 |
| **云端工作区节点** | `deploy/cloud-node/` | 云端 Claude Code（非 root、只读根、无 docker.sock）+ 同步边车（Mutagen） | 手工部署 |
| **模型网关** | Magpie（外部项目） | 多模型接入、目录、密钥；ChisaBot 也可直接接 OpenAI / Anthropic 兼容接口 | 独立 compose |

详细结构见 [architecture.md](architecture.md)，全部功能见 [features.md](features.md)，数据表见 [data-model.md](data-model.md)。

## 4. 现在的状态（2026-10-17）

- 单用户在用；朋友账号（多用户）代码在线但入口隐藏（`CHISABOT_ACCOUNTS_UI`、网关 `invites` 默认关）。
- 工作流、插件与 MCP、权限规则、UI 组件目录默认隐藏（`CHISABOT_EXTRAS` 可开）。
- 尚未在真实 Windows PC / 手机上完整验证（CB-017）；用户的 PC 需要手动重装到 0.1.x（CB-018）。
- 下一个大版本：0.2.0（真机验证之后，CB-019）。

## 5. 去哪里看

| 我想… | 看这里 |
|---|---|
| 知道有哪些功能、在哪、怎么开关 | [features.md](features.md) |
| 理解系统结构 | [architecture.md](architecture.md) · [data-model.md](data-model.md) · [ADR](adr/README.md) |
| 知道为什么这样设计 | [decisions.md](decisions.md) · [ADR](adr/README.md) |
| 改界面 | [DESIGN.md](../DESIGN.md) |
| 发版 / 上线 / 测试 | [release.md](release.md) · [ops/deploy.md](ops/deploy.md) · [testing.md](testing.md) |
| 看懂中文术语 | [glossary.md](glossary.md) |
