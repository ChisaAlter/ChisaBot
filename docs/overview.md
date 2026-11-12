# ChisaBot 概览

当前部署版本和候选状态见[实施记录](pipeline-runs/20261108-assistant-production.md)，版本变更见 [CHANGELOG](CHANGELOG.md)。

## 1. 它是什么

ChisaBot 是以 **DSH 为执行内核**的中文私人助手，自托管、全中文界面，沿用蓝天磨砂玻璃风格。
一句话：**一台云端服务器上的机器人，替你在任何地方管理你所有的设备，并像一个贴身助手一样把事情做完。**

- 机器人（agent）在服务器上运行：聊天、联网搜索、开浏览器、做面板 / 页面、记住你、按时提醒你、帮你写代码。
- 你的电脑、服务器是机器人的**设备节点**：机器人能在上面读 / 改 / 写文件、跑命令、写代码；有后果的操作先问你。
- 网页、PC、Android、PWA 看到的是**同一段对话**，任何一端发的消息另一端几秒内出现。
- 仓库公开，任何人都能部署自己的一份（见 [README「给 AI 的部署引导」](../README.md#给-ai-的部署引导)）。

## 2. 核心目标（产品方向）

按优先级（来源：[decisions.md](decisions.md)）：

1. **在任何地方管理所有设备（包括本地电脑）**：云端机器人能读、改、写本地文件和代码；本地电脑有「完全访问」这样的权限档位，
   像本机命令行编程助手一样能干活，同时有权限控制、沙箱、agent 选择。
2. **体验向 Hark 看齐**：输出内容、思考 / 加载的呈现、自定义面板、链接卡、记忆、技能、保险箱、定时任务、页面……尽量接近 Hark。
3. **尽快做成「相对成熟、可以分享给朋友用」的产品**：先单用户；多用户（朋友账号）已经做好但默认隐藏。
4. **保持产品精简**：移除不再使用的推广、依赖和接线；保留用户数据、任务结果以及升级所需的兼容入口。

## 3. 组成

```
 网页 / PWA ─┐   PC 客户端（Windows, Electron）──┐   Android（Kotlin + WebView）   IM（QQ/微信/飞书/…）
             │      聊天窗口 + 设备节点(WSS)      │      登录 + 同源手机网页                  │
             ▼                                    ▼               ▼                          ▼
        ┌──────────────── 公网网关（nginx + 登录服务，TLS）────────────────────────────────────┐
        └──────────────────────────────┬────────────────────────────────────────────────────┘
                                       ▼
        ┌──────── 应用容器：server（Hono + Conversation）+ app（React）+ PostgreSQL + 云端浏览器 ──┐
        └───────┬───────────────────────────────┬──────────────────────────────┬───────────────────┘
                ▼                               ▼                              ▼
        模型网关（Magpie，可选）      独立 DSH Host / Session         宿主机更新器 chisabot-updater
```

| 组件           | 代码                                               | 做什么                                                                                     | 怎么更新                                     |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Web 应用**   | `app/`（React + TanStack Router + 自有会话客户端） | 聊天、设置、管理的共用界面；PC 与 Android 分别使用桌面和手机布局                           | 随服务器部署，网页提示「有新版本，点此刷新」 |
| **服务器**     | `server/`（Hono + Conversation）                   | 接纳命令、管理权限、任务、交付与历史；DSH 执行模型回合，数据库按版本迁移                   | 一键更新 / `deploy-serial.sh`                |
| **执行内核**   | `runtime/dsh/`（Node.js + DSH）                    | 每账号独立 Host，管理模型/工具循环和持久 Session                                           | 随固定依赖与兼容 reader 更新                 |
| **云端浏览器** | `agent-computer/`（Chromium on Xvfb）              | 机器人的浏览器 + `/workspace` 工作区；多标签、收藏夹、可接管                               | 随服务器镜像                                 |
| **PC 客户端**  | `pc/`（Electron, Windows）                         | 一个窗口加载服务器网页 + 一个**设备节点**（主动 WSS 连服务器）；小窗模式、托盘、本地 agent | electron-updater，外壳指纹变了要「重新安装」 |
| **无界面节点** | `pc/src/headless.js` → `chisabot-node`             | Linux / macOS 服务器当设备（一行命令安装，systemd / launchd）                              | 节点自动下载新版                             |
| **Android**    | `android/`（Kotlin 壳 + WebView）                  | 原生登录、扫码、系统权限和下载；聊天、卡片、面板与设置使用同一 React 手机布局              | `latest.json` 更新源，versionCode 只增       |
| **公网网关**   | `deploy/public/`（nginx + `auth/server.ts`）       | TLS、登录（Argon2id + 会话）、签名身份、公开页面 `/p/`、设备 / OneBot 例外路由             | **手工部署**，不随一键更新                   |
| **更新器**     | `deploy/updater/`（python3, systemd）              | 拉 main → 快速更新或完整构建 → 备份 → 切换 → 健康检查 → 失败自动回滚                       | 每次成功更新后自升级                         |
| **模型网关**   | Magpie（外部项目）                                 | 多模型接入、目录、密钥；ChisaBot 也可直接接 OpenAI / Anthropic 兼容接口                    | 独立 compose                                 |

详细结构见 [architecture.md](architecture.md)，全部功能见 [features.md](features.md)，数据表见 [data-model.md](data-model.md)。

## 4. 当前交付阶段

- 正式服务统一运行在 DSH 执行内核之上（`v0.1.138`–`v0.1.143` 已上线）；个人助理交付、恢复与连续操作体验验收见[实施记录](pipeline-runs/20261108-assistant-production.md)与[体验收口记录](pipeline-runs/20261111-smooth-experience.md)。
- 已完成自有命名空间切换（迁移 `0067` / `0068`，核心会话与频道映射表统一为 `chisabot_*`，reader 4）及历史过渡代码清理；存量挂载卷与数据库身份兼容规则见[命名切换与存量资源兼容](ops/upstream-removal.md)。
- 单用户是默认交付形态；多账号、工作流、插件、权限规则和组件目录沿现有配置开关按需开放。
- 日历、邮箱、本人通知目标与异机备份按实际外部账号连接配置启用。

## 5. 去哪里看

| 我想…                          | 看这里                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| 知道有哪些功能、在哪、怎么开关 | [features.md](features.md)                                                                 |
| 理解系统结构                   | [architecture.md](architecture.md) · [data-model.md](data-model.md) · [ADR](adr/README.md) |
| 知道为什么这样设计             | [decisions.md](decisions.md) · [ADR](adr/README.md)                                        |
| 改界面                         | [DESIGN.md](../DESIGN.md)                                                                  |
| 发版 / 上线 / 测试             | [release.md](release.md) · [ops/deploy.md](ops/deploy.md) · [testing.md](testing.md)       |
| 看懂中文术语                   | [glossary.md](glossary.md)                                                                 |
