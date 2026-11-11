# 主动任务中心：开源生态与接入决策

调研日期：2026-11-06（Asia/Shanghai）。本文核对官方仓库和当前 ChisaBot 源码，用于选择实现路径。上游默认分支会变化，实际安装应固定发布版本，并按已安装版本的接口适配。

## 推荐：ChisaBot 统一管理任务，外部 Agent 负责执行

保留 ChisaBot 的账号、BOT、PostgreSQL、工具权限、审批、记忆、设备通道和 Hermes 宿主工具网关，在这些能力上增加主动任务中心。Pi、DSH、Codex 等作为可替换执行器；Inbox、Outbox、任务授权、运行记录、交付物和预算由 ChisaBot 持有。这条路线能保留现有用户入口和数据，又能真正利用专业 Agent 的执行能力。

任务中心最值得参考的是 **Paperclip 的多执行器、预算与任务治理**，以及 **DSH Superagent 的信息源、授权、任务与执行分离**。Multica 的产品交互也很贴近目标，但当前采用带额外限制的许可，适合作为独立自托管服务或产品参考，不应当成普通 Apache-2.0 代码直接搬入 ChisaBot。

## 项目身份、能力与取舍

| 项目 | 一手资料确认的能力 | 许可与当前约束 | 对 ChisaBot 的选择 |
| --- | --- | --- | --- |
| [Multica](https://github.com/multica-ai/multica) | 任务看板、Agent/运行时、定时 autopilot、运行日志、Inbox、审核、费用；通过 daemon 驱动已有 CLI，包含 Pi 和 DSH | [Multica License](https://github.com/multica-ai/multica/blob/main/LICENSE)：完整 Apache-2.0 文本加附加条件，限制面向第三方托管、商业嵌入及品牌变更；官方自称 source-available | 参考任务/运行/审核的交互；若独立部署，用其 API 接入并保留其许可，不复制 UI 或后端进 MIT 核心 |
| [Paperclip](https://github.com/paperclipai/paperclip) | Node/React 多 Agent 调度、目标与任务、heartbeat、预算、审批、连接器、技能；支持 Pi、Codex、Hermes 等及自定义进程/HTTP adapter | [MIT](https://github.com/paperclipai/paperclip/blob/master/LICENSE)；完整产品还包含组织/公司等本项目暂不需要的领域 | 优先参考执行器接口、任务运行日志和成本控制；在已有 ChisaBot 上实现所需闭环，避免同时运行两套身份和任务数据库 |
| [Pi](https://github.com/earendil-works/pi) | 可扩展 harness，CLI、JSON、RPC、TypeScript SDK；支持技能与扩展。旧 `badlogic/pi-mono` 路径目前返回此项目内容 | [MIT](https://github.com/earendil-works/pi/blob/main/LICENSE)；当前 npm 包名 `@earendil-works/pi-coding-agent`，要求 Node 22.19+；没有内建权限隔离 | 优先作为独立子进程执行器接入；记录安装版本，读取该版本 `--help`，不把当前文档参数直接套给旧版本 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 基于 Cordis 的插件化 Agent harness；当前 npm 包 `@deepseek-ai/dsh`，Web/profile/插件体系 | [MIT 与开发预览状态](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)；接口可能破坏兼容；[安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)要求不要把 harness 当唯一安全边界 | 接入已安装 CLI/ACP 或专用 profile，固定版本；保留用户现有 DSH/鲸屿配置，不将个人运行环境当无人值守沙箱 |
| [DSH Superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) | 单 GitHub 仓库主动 Agent；可接飞书；事件评估、授权 Ticket、独立 Session/目录、并发 worker、待人工事项面板、恢复与通知 | [MIT](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/LICENSE)；官方明确为研究原型，非生产就绪；默认 worker/router 是 `danger-full-access` | 最贴近用户所说的 Super-Agent。复用其领域思路；如运行原项目，使用专用账号/隔离环境和独立 profile，不能直接作为全权限后台插件加载进个人 DSH |
| [superagent-ai/superagent](https://github.com/superagent-ai/superagent) | 当前定位为提示注入检测、隐私脱敏、仓库扫描的安全 SDK | README 标示 MIT；SDK 使用 `SUPERAGENT_API_KEY` 连接服务 | 同名但用途不同，不把它当主动任务编排器；本阶段不新增此依赖 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 编码任务看板、独立工作区、diff 审阅、多 CLI | [Apache-2.0](https://github.com/BloopAI/vibe-kanban/blob/main/LICENSE)；当前 README 明确宣布 sunsetting | 可参考工作区和审阅设计，不选为新的长期核心依赖 |
| [Mastra](https://github.com/mastra-ai/mastra) | TypeScript Agent/workflow 生态；ChisaBot 已安装 core/client 并保留 remote-mastra 接入 | [许可说明](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md)：核心 Apache-2.0，`ee/` 目录另用企业许可 | 优先复用已经接线的能力；不为增加主动任务而整体迁移内核或引入企业模块 |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) / [Composio](https://github.com/ComposioHQ/composio) | 标准工具接入；Composio 提供按用户的连接、工具发现、认证和触发器 | MCP 当前主线为 v2，ChisaBot 使用 v1 包；Composio SDK MIT，但托管服务与用户授权是独立依赖 | 继续经过 ChisaBot 现有连接器/授权通道。不要为此功能顺便升级 MCP 大版本，也不要把 SDK 开源等同于连接器后端可离线自托管 |

上表能力依据各仓库 README/链接文档；未安装的产品没有在本次调研中做运行验收。推荐基于接口适配、运维成本和许可，而非星数排名。

## 已有 ChisaBot 能力可以直接承接哪些工作

| 现有入口 | 当前源码中的事实 | 新任务中心如何使用 |
| --- | --- | --- |
| [`schedules/service.ts`](../../server/src/schedules/service.ts) | 有时区、cron、运行记录与 CAS 抢占；15 秒扫描，周期最密 15 分钟；错过执行和连续失败已有处理 | 周期巡检复用其调度经验与生命周期，不以每个网页标签的计时器调度 |
| [`db/schema/work.ts`](../../server/src/db/schema/work.ts) | `work_items` 保存 kind/key、租约、attempts、结果和错误；已完成记录保留去重身份 | 可复用持久工作机制，新增任务领域状态；租约过期不等于外部动作没发生 |
| [`approvals/`](../../server/src/approvals/) | 审批按 owner/run/tool-call 记录，包含动作、状态和决策；已有规则与执行恢复 | Outbox 展示同一份待批准动作。审批绑定具体对象和参数，修改内容后必须重新评估 |
| [`local-agents/service.ts`](../../server/src/local-agents/service.ts)、[`pc/src/agent-runtime/`](../../pc/src/agent-runtime/) | 设备 Agent 的检测、任务、权限档位、并发上限、流式进度、停止及改动应用 | 在现有适配器上增加 Pi/DSH，保留设备拥有者和工作区约束，避免第二条无审计 shell 入口 |
| [`plugins/mcp.ts`](../../server/src/plugins/mcp.ts)、[`plugins/composio.ts`](../../server/src/plugins/composio.ts) | MCP 经统一 Streamable HTTP 客户端；Composio 用户身份来自服务端连接，不来自模型参数 | 巡检仅调用本用户已授权的读工具；外部写操作经批准再调用相同连接器 |
| [`memory-notes/service.ts`](../../server/src/memory-notes/service.ts) | 已有按用户保存、检索、整理、遗忘的个人记忆 | 以来源、更新时间与用户明确偏好补全工作上下文；推测性兴趣与确认事实分开保存 |
| [`agents/handoff-*`](../../server/src/agents/) | 已有 BOT 交接及后台交付路径 | 专业 BOT 可承担子任务；统一任务中心增加依赖和父任务验收，不把一次回合结束等同于目标达成 |
| `examples/acp-agent/README.md`、`server/src/agents/hermes-runtime.ts`（历史过渡实现，后已由 DSH 替代） | 当时生产 Hermes 路径保留宿主身份、模型、工具权限与审批，使用运行工具网关和稳定执行账本 | 新任务执行应复用这条宿主集成。旧 `docs/agent-capability.md` 中“桥默认 allow_once、状态只在内存”的描述不能作为当前生产路径依据 |

**连接可见性与后台可用性必须分开。** Codex 当前会话看得到 Gmail、日历或 Drive 工具，不意味着 ChisaBot 进程拥有可续期的同一授权。后台连接必须在 ChisaBot 内登记、授权、探测，并显示连接健康和失效原因；不读取或复制 Codex 的私有令牌。

## Pi、DSH 与 Superagent 的实际接入边界

### Pi：先接结构化进度，再谈无人值守

[Pi RPC 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)定义 JSONL stdin/stdout、请求 ID、会话事件、取消和退出。当前 `prompt` 成功响应只代表接受，`agent_end` 之后仍可能重试或压缩；当前文档要求用 `agent_settled` 判断自动后续工作结束。适配器必须按已安装版本解析事件，持续读取 stdout、单独收 stderr，并保留真实失败结果。

Pi 官方说明默认拥有启动用户的文件、进程、网络和凭据权限，且默认不内建计划/子 Agent。ChisaBot 承担任务规划和依赖编排，Pi 负责分配给它的执行。workspace/worktree 只分离改动，不阻止读取主目录或访问网络；需要隔离的无人值守任务必须使用真正的容器/沙箱或只暴露宿主批准工具的集成。[Pi README](https://github.com/earendil-works/pi/blob/main/README.md)

### DSH Superagent：有可复用的恢复设计，但默认权限不适合直接照搬

其 [领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)将 Source、Trigger、授权 Mandate、Ticket 和 Assignment 分开；信息到达只增加上下文，不自动扩大原授权。这正适合把消息、日历更新和 CI 变化归入既有任务，避免每次巡检创建重复待办。

[架构文档](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)把领域变更放入事务，外部效果在提交后执行；Outbox 同时保存发送回执与效果记录。其 Outbox 是可靠发送机制，不等于用户要求的人工审批 Outbox。ChisaBot 还要在发送前保存可审阅内容与审批结果。

[执行文档](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)定义并发 worker、等待人工、重试和重启恢复；同一 Ticket 可更换 Assignment，保留工作目录和上下文。发生网络错误只适合重试已知可重试阶段；对“可能已发布、但未收到回执”的动作，应先查外部状态，不盲目重发。

原型 [部署文档](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md)要求专用 DSH profile，因为插件修改进程级 PATH 和 git 配置；worker/router 都以操作者 OS 用户全权限运行，命令 wrapper 可被绝对路径绕过。依赖 Node 22.19+/24+、pnpm、git、Python、tmux，准备目录命令由 `sh` 执行，文档仅支持 github.com。若启用原型，应放入专用 Linux 容器/VM/账号，用服务专属凭据；不要修改用户日常 Windows DSH profile。

## 主动任务中心的最小清晰契约

以下是针对 ChisaBot 的设计建议，并非某个上游已经为本项目完成的功能：

1. **信息发现**：每个 Source 保存拥有者、连接引用、范围、巡检节奏、游标、最近成功和错误。事件以源 ID 与源事件 ID 去重；读入邮件/网页只是数据，不能授予操作权限。
2. **理解与分类**：从用户明确目标、当前项目和事件证据生成候选，保存来源链接、理由、截止日期、优先级、L1–L5 及判定原因。置信度不足的项目留 Inbox，不悄悄删除。
3. **计划与执行**：Task 是目标，Run 是一次执行，子任务保存依赖。可并行的工作派给不同 Agent；共享写目录只给一个执行者。任务的验收标准在分派时确定。
4. **授权与 Outbox**：L1–L5 描述任务能自主完成到什么程度，不是权限等级。L5 也不能绕过发布、对外沟通、敏感修改的确认。Outbox 包含对象、完整内容/差异、理由、建议、费用与继续/修改/拒绝选项。
5. **验证和交付**：执行器退出零只证明进程完成；任务完成要求对应的文件、查询回执、测试或实际操作证据。交付物关联产生它的 Run，失败可定位并定向重试。
6. **长期运行**：数据库持有状态，worker 持租约；定期心跳、有限重试、时间/调用/并发预算、用户停止后不自动重启。未知外部结果单独展示并核对，不能直接标失败重做。
7. **看板与人工干预**：Inbox、Outbox、任务详情、Agent 进度、工具记录、错误与交付物共用任务 ID；允许暂停、取消、调整优先级、补充上下文、重试和历史回看。

## 配置、迁移与验收资料应随实现保存

可版本化内容包括信息源种类与范围模板、执行器类型/版本/协议、权限与预算模板、调度策略、数据库迁移、配置字段说明、备份恢复步骤。凭据、真实邮件正文、连接令牌、私人项目材料和执行日志应放在实例的数据目录/密钥存储中，不能写入 Git。

真实验收应沿一次完整任务追踪：已授权信息源读到实际变化 → 去重与分类 → 计划 → 一个真实执行器产出文件或其他可验收结果 → 需确认动作进入 Outbox → 用户确认后执行且记录回执 → 重启后任务、待审批和成果仍可查看。至少还要观察一次失败恢复和取消。没有完成授权的信息源应在看板显示“待连接”，不以模拟事件宣称已接通。

## 调研中可复用的工具经验

- 本次通用 `web` 搜索因未配置搜索提供商不可用；连接器搜索工具也未开放。GitHub 公共仓库搜索 API 成功找到了 Multica、DSH 与 Superagent，随后触发匿名限额；已知仓库的一手 README/文档通过 `raw.githubusercontent.com` 正常读取。遇到此类问题无需索取或复制用户令牌，优先读取官方公开原文。
- 分支与名称必须核实：DSH 使用 `master`，Superagent 原型使用 `main`；Pi 包名和仓库位置已变化。404 不是能力不存在，README 里的新路径和已安装 CLI 版本才决定下一步。
- 上游“支持某执行器”说明集成方向，不证明本机已安装、已登录、已具备隔离或能够完成任务。产品里应分别呈现检测、认证、健康和最近真实运行结果。
- MCP 官方当前主线是 v2，现有 `@modelcontextprotocol/sdk` 属于 [v1.x](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)。查询文档时跟随本项目版本，避免因主动任务开发引入无关的大版本迁移。
- [Composio 当前 SDK](https://github.com/ComposioHQ/composio/blob/master/README.md)提供动态发现和用户会话；本仓库已有适配层负责工具版本、身份和结果截断。使用已安装 SDK 的定义，不直接复制最新版 quickstart 替换生产调用。
