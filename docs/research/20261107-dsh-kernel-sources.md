# DSH 作为 ChisaBot 内核：官方接口核对

检索日期：2026-11-07。官方 `master`/HEAD 固定在 [`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`](https://github.com/deepseek-ai/deepseek-harness/commit/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)（2026-11-04 08:40 UTC），源码版本 **0.2.2-rc.1**。本笔记仅核对远端官方源码与文档；Whale Isle 的本地 0.2.1-rc.4 由主评估单独检查，不能把新接口直接视为旧版本已有。

## 判断

**DSH 可以作为 ChisaBot 的主 agent runtime，而且它公开的插件、会话与模型接口支持这种用途。若 ChisaBot 希望复用完整的多步执行、压缩、子代理和持久会话，应认真优先评估；若只需要替换一个循环，直接 AI SDK/Pi core 的接入范围更小。**

对交互聊天，优先评估 **独立 DSH Host + Session Controller/Gateway + ChisaBot 工具/审批插件**，再由 ChisaBot 后端转换自己的事件协议。现成 stdio SDK 可快速驱动任务，但目前缺少单会话取消与 live token 通道，不能把它直接当作完整聊天后端。此建议是接口匹配判断；尚未完成 ChisaBot 的多租户、Magpie、审批恢复与真实取消验收。

## 公开接入方式与真正差别

| 路径 | 官方契约 | 对 ChisaBot 的意义 |
|---|---|---|
| TypeScript SDK `@deepseek-ai/dsh-sdk-client` | `DeepSeekHarness`/`HarnessClient` 启动子进程，通过 stdio JSON-RPC 驱动完整 runtime；可选 profile、独立 `dshHome`、ordered patches、模型路由 | 适合任务调用和独立执行器；无需抓 CLI 文本 |
| Host/Client Gateway + Session Controller | Session 的 create/resume/prompt、queue/steer、cancel、history/follow；follow 可请求 `assistantStream: true`，包含快照、持久事件和实时 assistant frames | 更接近 ChisaBot 交互聊天需要的流式显示、独立停止与恢复读取 |
| 自定义 Cordis composition/plugin | public `Agent`、`ctx.tools`、`ctx.llm` 和扩展事件；核心 loop 实现可替换 | 可把 ChisaBot 工具、授权与模型接入放到明确插件接口，不必改写私有 agent 方法 |

来源：[SDK 家族](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/README.md)、[SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/README.md)、[Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/session-controller/README.md)、[Session wire types](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/session-controller/src/types.ts)、[Gateway](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/gateway/README.md)、[Core group](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/README.md)。

## SDK 有用，但不能忽略三个缺口

1. **没有 cancel 或 session-close 方法。** 官方列明放弃 turn 要关闭 runtime process。一个进程放多个活跃会话时，不能据此实现只停止其中一轮。Host 的 Session Controller 另有 `SessionCancelRequest`，应使用拥有这项语义的入口。
2. **SDK 的 `session.event` 是持久事件通道。** 实时 `agent/assistant-stream` frames 是 process-local；官方架构说明 Web Session-follow adapter 是其远程消费者。SDK 方法表没有该实时通知。每次 assistant 调用完成才把 compact stream 作为 `assistant/message`/`assistant/attempt` 提交，因此 SDK 通知不能等同逐 token 显示。
3. **普通 `run()` 的结果是一个活动区间。** 它等输入进入 durable inbox 后收集到下一个 whole-agent idle；`finalResponse` 是该区间最后一个 root assistant 文本，不是对某条 prompt 的严格因果响应。steering、注入上下文和其他 queued work 可能共同贡献。高层任务归属需要 ChisaBot 明确定义。

另外，`resumeSession(savedId)` 会恢复相同持久会话、修补中断尾部且不新增输入，但不会恢复 shell/browser 等外部进程；问题/审批等待也不能当作跨进程重启的持久待答句柄。

来源：[SDK protocol 方法与限制](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/protocol/README.md)、[SDK client 语义](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/README.md)、[架构与实时流](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#turn-flow)。

## 模型、工具、审批能如何接

- **不绑定 DeepSeek 模型。** 官方配置支持 Anthropic/OpenAI 等内置 provider，以及自定义 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 网关。每个 provider 对应一种协议，模型 ID、base URL、凭据和兼容选项可配置。接 Magpie 有正规路径，但具体工具、推理和图片协议仍须按实际模型验证。[模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/providers.md)
- **工具与权限有公开扩展点。** 工具注册到 `ctx.tools`；`tools/pre-execute` 能允许、拒绝或请求审批，`ctx.tools.guard()` 可最终拒绝；`tools/execute` 包裹执行时限，`tools/result` 观察最终结果。ChisaBot 可通过自己的插件调用既有工具执行器并保留 actor/bot 权限。[工具指南](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/cookbook/adding-a-tool.md)、[扩展 cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/cookbook/extension-cookbook.md)
- **SDK 可交给宿主回答审批和用户问题。** `approvalRequests: true` + `onRequest` 处理 `approval/request`，只允许一次操作；`onUserQuestion` 接原生问题，带取消 signal。传输丢失或回调失败不会被当成批准。这是实时交互接口，持久审批恢复仍需明确归属。[SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/client/README.md)
- **DSH Session log 是模型历史的权威来源。** 它由事件派生模型上下文，支持替换 `SessionPersistence`。若采用完整 DSH runtime，应让 ChisaBot 保存账号、bot/thread 映射、产品状态及显示投影，避免每轮又把完整历史双向重写进两套独立来源。这是基于官方数据所有权的架构建议。[Session log 与 persistence](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#session-log)

## 固定版本与组合选择

官方仍明确标注 developer preview，预告 breaking changes；SDK 没有协议版本协商，也没有兼容保证。插件 manifest 可通过 `engines.dsh` 声明兼容范围，但这只是加载兼容性检查，不能代替实际兼容契约。应固定 runtime、SDK、插件版本并随版本维护适配。[README](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/README.md)、[SDK 限制](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sdk/protocol/README.md#known-limitations-and-deferred-work)、[插件 engines 检查](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.md)

此次 npm registry 核对：`@deepseek-ai/dsh` 的 `latest` 是 `0.2.2-rc.1`；`@deepseek-ai/dsh-sdk-client` 的 `latest` 仍是 `0.0.1-rc.1`，`next` 才是 `0.2.2-rc.1`，且该精确版本已发布。不能无版本安装两个包后假设契约一致。当前 DSH 声明 Node **>=24.9.0**。[DSH registry](https://registry.npmjs.org/@deepseek-ai%2fdsh/latest)、[SDK registry](https://registry.npmjs.org/@deepseek-ai%2fdsh-sdk-client)、[固定源码 package](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/package.json)

`sdk-minimal` 是小型 coding runtime，仍自带持久 shell、图片读取、工作目录和自动压缩，默认 danger-full-access；它既非空循环，也没有完整 base 的设置、托管凭据、jobs 和 subagents。`sdk` 则继承完整 base，两者都支持 profile patches。ChisaBot 应创建明确的组合，而非仅因 minimal 名称直接选用。[sdk-minimal](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/sdk-minimal/README.md)、[sdk-app](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/sdk-app/README.md)

本轮没有安装、启动 runtime、调用模型或改动 ChisaBot 产品实现。现有气泡、大块空白和 Markdown 分类问题仍由 ChisaBot 前端负责；换内核不能自动修复这些显示行为。

## 与当前 ChisaBot、Whale Isle 的对照

主评估只读了本地 Whale Isle 的 vendor 和 ChisaBot 当前工作树。Whale Isle 的 [pin](C:/AI/Deepseek-Harness-Desktop/vendor/harness-upstream.json) 指向 `dsh-v0.2.1-rc.4` / `504a01a9578abc2c6f1fb896b1dc322c9fe24f66`；该 vendor 含下游扩展，pin 不是逐文件等同上游的证明。

- 本地旧版 [SDK client](C:/AI/Deepseek-Harness-Desktop/vendor/deepseek-harness/packages/sdk/client/README.md) 明确尚未实现服务端审批请求；这条限制不应外推到上文已经支持审批回传的官方 `0.2.2-rc.1`。
- 本地 [Agent](C:/AI/Deepseek-Harness-Desktop/vendor/deepseek-harness/packages/core/agent/README.md) 已有 `create/resume`、`followup/steer/inject/cancel` 和按 Agent 注册工具的作用域；[工具指南](C:/AI/Deepseek-Harness-Desktop/vendor/deepseek-harness/docs/cookbook/adding-a-tool.md) 规定工具观察 `exec.signal`。作用域能隔离注册，不等于自动完成 ChisaBot 的用户鉴权或进程隔离。
- 本地 [Session cancel](C:/AI/Deepseek-Harness-Desktop/vendor/deepseek-harness/packages/api/session-controller/src/commands.ts:638) 请求取消当前活动并保留待处理 inbox；返回值只是接受取消请求。ChisaBot 的“停止”还须对应其队列和后台任务语义，确认执行终止后再显示已停止。
- ChisaBot 的 [Hermes adapter](C:/Users/48818/.codex/worktrees/chat-reliability/ChisaBot/server/src/agents/hermes-runtime.ts:175) 当前组装 actor/bot/thread/run 身份及工具执行器；[内核入口](C:/Users/48818/.codex/worktrees/chat-reliability/ChisaBot/server/src/copilot.ts:1232) 每轮传完整历史并由宿主压缩。换成完整 DSH runtime 时，应保留身份、权限与工具执行契约，并明确改由 DSH Session 管理执行历史和压缩。
- 前端 [channel-chat](C:/Users/48818/.codex/worktrees/chat-reliability/ChisaBot/app/src/components/channels/channel-chat.tsx:421) 仍使用 CopilotKit `useAgent`，transcript 也依赖其工具渲染上下文。因此替换后端内核不会自动移除 CopilotKit；完整方案还包括把聊天状态和工具卡片注册迁到自有事件适配层，保留现有 React 界面及已修复的气泡/滚动行为。

建议分工：DSH 管执行循环、执行日志、上下文压缩与 Agent 生命周期；ChisaBot 管账号、Bot、渠道、长期记忆、产品任务及业务权限；ChisaBot 插件把授权工具和记忆接入 DSH，适配层将会话事件供给前端。按用户/工作区确定 runtime 隔离范围，不能把不同用户凭据放入一个无隔离的共享默认 profile。

对该项目，DSH 是完整内核的优先验证候选；这个判断来自已有 Whale Isle 集成经验与公开接口匹配程度，不代表已证明比当前 Hermes 更稳定。迁移验收应覆盖真实模型流、工具审批、单会话停止且其他会话继续、断线续读及进程重启后的历史恢复。
