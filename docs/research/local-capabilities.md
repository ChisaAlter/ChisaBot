# 本机能力与接入路径

盘点日期：2026-11-06（Asia/Shanghai）。源码基线：`47877bfa`，分支 `codex/proactive-task-center`。这份记录供任务中心实施与迁移使用；凭据、账号邮件、私人消息和服务连接地址不入库。

## 首选实施路径

保留 ChisaBot 的 PostgreSQL、身份与权限层，由任务中心调度既有工具和 Agent。首个真实执行器优先接 Codex CLI：本机可执行且登录有效；GitHub 信息发现优先使用已登录的 `gh` 或 ChisaBot 的 GitHub 连接。DSH 已有可运行的安装版，可通过独立 profile 接入。Pi 尚未发现安装，需在任务中心展示为待配置。

当前独立本地 ChisaBot 的直接阻塞是数据库：配置指向本机 PostgreSQL，连接探针返回 `ECONNREFUSED`；本机没有 PostgreSQL 进程或 5432 监听。应为本次任务中心建立独立数据库与数据目录，再启动应用，不把已有云端数据库当成本地测试库。

## CLI 与实际运行状态

| 能力 | 直接观察 | 接入决定 |
| --- | --- | --- |
| Bun | `bun --version`：1.3.14；仓库依赖已存在 | 使用现有 Bun workspace |
| Node.js | `node --version`：24.20.0 | 可运行 CLI 与无界面设备节点 |
| Git | 2.55.0.windows.5 | 工作树隔离与变更交付可复用 |
| GitHub CLI | 2.102.0；`gh auth status` 显示 keyring 登录有效 | 以 CLI 正常认证机制读取仓库；不提取 token |
| Codex CLI | 0.162.1；`codex login status` 显示 ChatGPT 登录 | 可进行独立工作区的实际任务验证；模型额度与单次任务结果仍由执行回执判定 |
| Claude Code | PATH 有 npm shim；`--version` 报目标 exe 不是当前 OS 的有效应用程序 | 当前不能列为可用执行器；需要修复安装后重测 |
| DSH | PATH 无 `dsh`；安装版 CLI `--version` 成功：0.2.1-rc.4 | 使用明确的 Node 与 CLI 路径，独立 `DSH_HOME`/profile；尚未验证新 profile 的模型认证 |
| Pi、uv、Docker、psql | PATH 未找到 | 展示未配置，不自动猜测执行路径 |
| Python | PATH 指向 WindowsApps alias；另有独立 Python 3.12.7 可执行文件，`--version` 成功 | 文档处理使用明确的运行时路径，不能把 alias 当成已验证 Python |

已确认的本机执行入口（部署配置应允许替换，不能写死进产品代码）：

```text
Codex: <用户目录>\Tools\codex\bin\codex.exe
DSH Node: C:\软件\Whale Isle\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
DSH CLI: C:\软件\Whale Isle\resources\vendor\deepseek-harness\apps\cli\lib\bin.js
Python: C:\AI\tools\python-3.12.7\python.exe
```

DSH CLI 的发行包名为 `@deepseek-ai/dsh`；当前安装的 launcher 提供 `headless`、`acp` 等 profile 入口。`--version` 仅证明入口能运行；真正接入前需验证独立 profile 的模型、权限、停止、进度和交付语义。现有 Whale Isle 进程正在运行，不修改其个人 profile、会话或凭据。

## 已有服务与本地启动条件

- 本机 Magpie 进程监听 loopback 3425；只读请求 `/v1/models` 返回 HTTP 200 和 13 个模型。该结果证明目录可读，尚未证明每个模型可推理。
- Whale Isle 运行中的 Node 服务监听 loopback 3080；T3 Code 运行中的 3773/9223 属于该应用。不要把 9223 当作可供本次任务接管的 Chrome。
- 盘点时 ChisaBot 3001、PostgreSQL 5432 未监听。新服务启动前仍须重新检查端口占用。
- 仓库 `.env` 已配置数据库与加密键；`OPENAI_API_KEY`、`COMPOSIO_API_KEY` 为空。未读取数据库中的连接记录，因为数据库不可达。
- 盘点时 `.env` 曾含旧前缀名称，当时由 `shared/env-compat.ts`（后已在去上游印记收尾中移除）在 [`server/src/index.ts`](../../server/src/index.ts) 最先加载映射为 `CHISABOT_*`。
- 实际数据库客户端是 Bun SQL + Drizzle，见 [`server/src/db/client.ts`](../../server/src/db/client.ts)。新任务中心应与既有数据库生命周期一致。

本次只检查本机服务。仓库已有云端部署、Hermes 安装、设备节点与远程 Agent 代码；没有连接云端主机验证当前服务、数据或权限，不能据文档认定它们已为新任务中心就绪。

## 应优先复用的 ChisaBot 能力

| 需求 | 当前实现入口 | 接入注意事项 |
| --- | --- | --- |
| 本地编码 Agent | [`pc/src/agent-runtime/`](../../pc/src/agent-runtime/)；[`server/src/local-agents/service.ts`](../../server/src/local-agents/service.ts) | 已有检测、CLI 输出、停止、工作树/副本、权限档位与设备回执；扩展执行器目录时保留现有入口 |
| CLI 检测 | [`detect.js`](../../pc/src/agent-runtime/detect.js) | 当前识别 Claude/Codex/OpenCode/Gemini/Aider，不含 Pi/DSH；应以实际退出状态判定可运行 |
| 远程节点 | [`pc/src/cli.js`](../../pc/src/cli.js) | 无界面 `login/run/logout`；通过既有设备配对与 WebSocket，不能绕过设备审批 |
| 日历、邮件、通知 | [`server/src/personal-sources/service.ts`](../../server/src/personal-sources/service.ts) | 已有 ICS、只读 IMAP、加密存储、晨报、入站/通知 Webhook、`checkProactiveUpdates`；发送邮件与推送通知有独立副作用，应纳入 Outbox |
| GitHub 信息 | [`server/src/github/service.ts`](../../server/src/github/service.ts)；[`responsibilities/github.ts`](../../server/src/responsibilities/github.ts) | 已有账号连接、按 owner/repository 绑定并校验 HMAC 的事件接收；事件不能自行选择执行身份 |
| MCP | [`server/src/plugins/mcp.ts`](../../server/src/plugins/mcp.ts) | 采用 MCP SDK Streamable HTTP、调用取消、认证放置和内网访问控制；本机 stdio server 不能只填 URL 就复用 |
| 外部 SaaS | [`server/src/plugins/composio.ts`](../../server/src/plugins/composio.ts) | 已有 SDK 接入；当前本地环境未配置 Composio key，需实际账号授权后才能巡检 |
| 技能与长期记忆 | [`docs/skills.md`](../skills.md)；[`server/src/memory-notes/service.ts`](../../server/src/memory-notes/service.ts) | 技能和个人记忆已有用户归属与存储；任务中心应引用这些存储，不新增相互漂移的个人档案副本 |
| 定时与异常恢复 | [`server/src/schedules/service.ts`](../../server/src/schedules/service.ts)；[`docs/schedules.md`](../schedules.md) | 已有扫描、比较交换与失败暂停；主动感知可接入相同生命周期；已暂停任务不能随功能部署恢复 |
| Hermes/ACP（历史过渡） | `examples/acp-agent/README.md`（后已退役下线） | 当时生产桥使用可信宿主上下文、运行绑定工具网关和稳定账本；通用 ACP 的权限回答不等于沙箱或完整宿主集成 |

工作树与副本用于变更隔离，不能当作 OS 安全沙箱。新执行器需要分别声明能做的事、所需权限、可用工具、实际认证和网络边界，不能只凭安装存在就判为 L5。

## 浏览器、Skills、文档生态

本机已存在 Chrome、Edge，以及 Playwright Chromium/headless-shell 安装。仓库已经依赖 `playwright-core` 并有 [`scripts/start-local-chrome-computer.ts`](../../scripts/start-local-chrome-computer.ts)。后台验证应启动独立 headless/profile，保留用户正在操作的浏览器与桌面。

本机 Codex Skills 包含 research、code-review、diagnosing-bugs、impeccable、ui-ux-pro-max、writing-for-agents 等；同时有文档、表格、演示文稿和 PDF 插件技能。本机 DSH 安装包声明包含 Python 文档处理库、Office skills、MCP、文件搜索、子 Agent、目标与定时插件。这里的安装与元数据不等于 ChisaBot 已加载；任务中心需要显式的技能目录、执行器兼容信息和加载记录。

Codex 本地 MCP 配置声明 `open-design`、`node_repl`、`ardot-remote`，Claude 配置声明 `open-design`。本次仅读取服务名称，未读取或转存认证配置，未执行服务健康检查。

当前编码会话还提供 Gmail、Google Calendar、Drive、GitHub 等连接器工具。它们可供本次建设阶段按授权调用，但会话中的连接器令牌、执行上下文和调度能力不自动成为 ChisaBot 后台能力。长期巡检应通过 ChisaBot 自身连接、受支持的 OAuth/MCP/Composio、ICS/IMAP 或用户明确提供的服务端凭据运行。

## 部署与验收依赖

1. 建立独立 PostgreSQL，启动 ChisaBot 和任务中心，保留现有加密键与数据的归属。
2. 用已登录 Codex、已登录 gh 和真实仓库完成第一条“发现 → Inbox → 执行 → 产物 → 验证”链路。
3. 为 DSH/Pi 等可选执行器记录可运行入口和独立配置；验证成功后才从“待配置”升级为“就绪”。
4. 通过应用正常设置连接邮件/日历/文档源，观察真实数据发现、去重、失败恢复和权限范围；当前本机没有这些连接的后台可用性证据。
5. 在 Outbox 验证批准、拒绝、撤回和恢复；真实外发只在对应动作获批后执行。
6. 使用服务管理/计划任务守护后台进程，验证进程重启、任务恢复和日志定位；本次盘点未创建后台服务。
