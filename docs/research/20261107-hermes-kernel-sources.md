# Hermes 作为 ChisaBot 内核：官方接口与职责证据

检索日期：2026-11-07。官方 `main` 当次解析为 [`cf7003f3fa650e2cebc06a0af0c09dabaf5ee367`](https://github.com/NousResearch/hermes-agent/commit/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367)，提交时间为 2026-11-07 08:13:06 UTC。下文事实对应这个版本，不代表 ChisaBot 已部署的 Hermes 版本。搜索服务不可用，资料由官方 GitHub 原始文档与 GitHub API直接取得。

## 判断

**Hermes 有正式的外部宿主接入路径，具备做完整 agent 后端的定位。选择它的价值取决于是否让它实际承担自己的会话、模型、工具、记忆与执行管理。** 若宿主已经拥有这些能力、只需要模型调用与工具循环，深度改写 Hermes 内部状态的集成成本可能超过收益；这是职责划分上的推论，需要结合 ChisaBot 源码与运行证据判断。

不能将 Hermes 概括为“只能运行 CLI、不适合被嵌入”。官方明确列出定制 UI、CI 和嵌入式子 agent 的程序化使用方式。[Programmatic Integration](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/programmatic-integration.md)

## 官方建议的接入路径

| 使用方式                              | 官方定位与语义                                                                                                                        | 对 ChisaBot 评估的意义                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| ACP，stdio JSON-RPC                   | 面向已有 ACP 客户端的 IDE；暴露会话、提示、流式文本、工具事件、许可、取消、认证等                                                     | 可以用，但不应因为已有桥接就认定它是定制 Web 宿主的首选           |
| TUI gateway，stdio/WebSocket JSON-RPC | 官方推荐给想获得完整 Hermes 功能的自定义桌面/Web/TUI 宿主；有 `@hermes/shared/gateway-client`，具备能力发现、恢复连接、审批与会话事件 | 继续保留 Hermes 为主后端时，值得优先评估这一公共宿主路径          |
| HTTP API + SSE                        | 面向 OpenAI 兼容前端和非 Python 客户端；提供 `/v1/runs`、状态、事件、审批、steer、stop、capabilities                                  | 比仅把 agent 当作一次 Chat Completions 更能表达长期运行与人机交互 |
| Python 进程内 `run_agent.AIAgent`     | 官方列出的无子进程嵌入方式，`chat()` 或 `run_conversation()`                                                                          | 可以去掉 ACP 传输，但不自动解决宿主与 Hermes 的状态所有权重叠     |

以上来自 [Programmatic Integration](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/programmatic-integration.md) 与 [ACP Internals](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/acp-internals.md)。

## Hermes 自己拥有的能力

`AIAgent` 统一承担提示组装、provider/API mode 选择、可取消模型调用、顺序/并发工具执行、历史维护、压缩、重试、fallback、迭代预算和记忆落盘。其外围还有 SQLite 会话、技能、调度、平台网关与多种工具后端。它是带完整执行策略的 agent 系统，所提供的行为远超一个裸模型请求循环。[Architecture](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/architecture.md)、[Agent Loop Internals](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/agent-loop.md)

官方说明 `todo`、`memory`、`session_search`、`delegate_task` 等工具会在 registry 分发之前由 agent 层拦截。这解释了为什么外部宿主不能仅凭“注册同名工具”就假定已替换其语义；具体集成必须处理宿主工具与内建工具的所有权。[Agent Loop Internals](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/agent-loop.md#agent-level-tools)

HTTP API 的默认约定也是保留 Hermes 工具、记忆与技能，客户端 system/instructions 叠加到核心提示之上；它不是默认交出执行权、仅替宿主转发模型请求。[API Server](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/user-guide/features/api-server.md#system-prompt-handling)

## 兼容性应如何表述

Hermes **有明确的原生插件兼容契约**：文档化 `PluginContext` 方法增量演进，新增参数可选，已有返回字段不随意移除/改型，废弃必须给替代和迁移说明并保留至少后续两个 minor release。该契约只覆盖文档化扩展面。[Native plugin compatibility contract](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/plugins/index.md#native-plugin-compatibility-contract)

同一契约明确将运行时替换/包装 core functions、methods、module attributes、private tables 排除在受支持扩展方式之外；公开插件导入清单也不包含以下划线开头的名字。这不能被泛化为“整个 Hermes API 不稳定”，但足以说明依赖内部方法、内部字段的适配器不享有该公开插件兼容保证。[兼容契约](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/plugins/index.md#native-plugin-compatibility-contract)、[Public plugin API](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/plugins/public-api.md)

外部 wire 协议也需要版本与能力协商：官方当前明确要求 WebSocket 客户端调用 `client.capabilities` 声明支持 server requests，并标注这是影响既有集成的 breaking change。不能仅凭旧版接通或 import/signature 检查证明升级后的完整交互仍然可用。[Programmatic Integration：server requests](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/programmatic-integration.md#serverclient-requests-questions-the-agent-asks-you)

## 恢复与隔离的实际界限

- 当前 Runs API 有 durable idempotency admission、按 owner/profile 约束的运行控制和 unknown-execution 恢复；官方同时明确其分库事务不承诺全局 exactly-once。这是需接入正确的执行语义，不能简化为“支持重启，所以任意任务都自动安全重跑”。[API Server：Runs](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/user-guide/features/api-server.md#post-v1runs)
- TUI gateway 允许同一认证网关的多个客户端订阅同一活动会话；官方明确这不允许多个独立 gateway 进程同时写一个会话，也不代表 owner 重启后具有持久提示准入。[Programmatic Integration](https://github.com/NousResearch/hermes-agent/blob/cf7003f3fa650e2cebc06a0af0c09dabaf5ee367/website/docs/developer-guide/programmatic-integration.md)

## 对 ChisaBot 的建议

优先比较两种明确所有者的方案：让 ChisaBot 拥有状态/工具治理并采用轻量执行内核，或让 Hermes 拥有 agent 会话/执行、ChisaBot 通过文档化宿主协议接入。若选 Hermes，先确定它带来的独有收益，再决定采用的公开接口与固定版本。若其优势只用于少量研究/编码任务，将其作为可选执行器的接入成本更容易控制。

本研究未运行性能、可靠性或效果对照；不能据此宣称迁移某个内核后一定更快、更稳或模型更聪明。

## 当前项目的判断与依据

**建议：短期保留正在运行的 Hermes 并完成当前故障修复；长期把 Hermes 收敛为可替换的执行后端，不再作为全部机器人唯一的默认内核。先评估现有内置路径的能力差异，补齐后再以相同模型、工具和真实用户路径决定切换。** 这一轮是评估，没有修改内核设置或发布前轮修复。

2026-11-07 只读核对：生产 Hermes checkout 为 `40cc180823d182826536416de2fc27be44b4ac57`（提交日期 2026-10-20），适配器 release 为 ChisaBot `9a00ed625f1e3508fa66da2ea036f573db0c4f92`。上面的新官方接口说明需要按版本评估，不能假定现有部署已具备全部能力。

| 本地事实                                                                                                                                                                                                           | 对选择的影响                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChisaBot 拥有账号/bot/thread、数据库历史、权限审批、任务工作流和记忆；适配器设置 `skip_memory=True`、`skip_background_review=True`，关闭原生上下文文件、身份、checkpoints、trajectories 与原生工具，只保留宿主工具 | Hermes 的完整助手能力没有被整套复用；需要比较的是剩余执行循环收益与适配成本。参见历史路径 `docs/hermes-runtime.md`、`examples/hermes-agent/chisabot_acp.py`                        |
| 调用链为 ChisaBot → AG-UI/SSE → bridge → ACP stdio → Python adapter → AIAgent；工具再经 HTTP 回调 ChisaBot。每轮传完整历史，并翻译消息、工具 ID、审批 continuation、取消和错误                                     | 不只是换一次模型请求，多个协议阶段必须保持同一回合语义。参见历史路径 `examples/acp-agent/README.md`、[真实调用捕获](../../server/src/agents/runtime-tools.ts)                              |
| 模型 ID、fallback 与上下文参数从 ChisaBot 发给 Hermes；实际 provider、端点、凭据由 Hermes `load_config` / `resolve_runtime_provider` 解析，安装时首次复制独立配置                                                  | 有两个模型连接配置来源，需要显式同步；当前 wire 本身没有将 ChisaBot 的完整连接快照传过去。参见历史路径 `server/src/agents/hermes-runtime.ts`、`deploy/install-hermes-runtime.sh` |
| 自定义适配器包装 `_try_activate_fallback`，调用 `_switch_model`、`_init_fallback_chain`，改写私有状态；`--check` 只验证 import/签名                                                                                | 升级需验证行为，不能把公共插件契约等同于这些内部方法的兼容保证。参见历史路径 `examples/hermes-agent/chisabot_acp.py`                                                                 |
| 桥按会话排队，但多个会话共享一个 ACP 子进程代；取消超过宽限期会退役整个代，其所有 pending RPC 都被拒绝                                                                                                             | 存在某轮顽固取消影响同进程其他会话的结构性风险；此轮未执行并发故障注入。参见历史路径 `examples/acp-agent/bridge.mjs`                                                                       |
| 内置路径仍存在，但 `TOOL_STEPS=12`，Hermes 路径的 `compactHistory` 没有在 `BuiltInAgentWithSaneHistory.run` 同样接线                                                                                               | 直接删除 Hermes URL 不能视为等价迁移。需要先补齐任务长度、长上下文和恢复契约。参见历史路径 `server/src/copilot.ts`                                                                   |

当前故障需分别归因：气泡外正文、自动文档转换、留白来自 ChisaBot 前端；30 秒取消后调用失效备用并误报主模型 404，来自配置与适配策略。换内核不会自动修复前者。此前用同一网关直接调用 SWE-2 成功，只证明当时模型路由可用，未验证内核优劣。[故障证据](../pipeline-runs/20261107-chat-reliability.md)

运行记录也说明 Hermes 并非全面不可用：最近三天 `openbot_local_runs` 的状态计数为 finished 368、error 13、stopped 2、interrupted 1；这些是运行终态，不是任务质量或用户满意度。最近十条计时里远端 RUN_STARTED 到达耗时为 10–545ms，不能据此把 10–30 秒首段正文等待归因于协议传输；开始事件也不等于模型已接受请求。没有同条件内置路径对照，因此不报告速度胜负。

### 推荐推进顺序

1. 独立完成当前聊天修复，保留既有生产内核与用户数据。
2. 以已有 `AbstractAgent` 接口比较两个执行后端，先解决内置路径的 12 步限制与长历史处理差异；不另建框架。
3. 在相同模型/工具/任务下比较：直接回答、工具后回答、审批后继续、长对话、停止、断线/重启恢复、多机器人并行。关键条件是正确完成、工具不重复、取消不串会话以及可解释的错误归属，再比较时间与消耗。
4. 达到能力对齐且证据支持后再切默认。产品界面不增加让用户承担架构选择的“聊天/任务双内核”开关。某次工具结果未知时，不自动切另一个内核重跑副作用。

如果未来决定把会话、记忆、模型与工具生命周期整体交给 Hermes，应重新评估官方 gateway / Runs API；那是让 Hermes 成为真正后端的另一种产品架构，超出当前只替换执行循环的范围。
