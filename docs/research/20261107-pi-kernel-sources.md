# Pi 作为 ChisaBot 内嵌执行内核：官方证据

检索日期：2026-11-07。官方仓库 `badlogic/pi-mono` 当前重定向到 [`earendil-works/pi`](https://github.com/earendil-works/pi)，本次源码固定在 [`085c84e98e7f4c950f2be606466fff4f75d8fe7c`](https://github.com/earendil-works/pi/commit/085c84e98e7f4c950f2be606466fff4f75d8fe7c)（2026-11-06 23:59:42 UTC）。GitHub 与 npm 官方数据直接读取；未安装包或执行模型请求。

## 推荐的包与接法

**Pi 值得成为 ChisaBot 替换 CopilotKit 执行循环的首要候选；优先采用 `pi-agent-core` + `pi-ai` 的进程内接法，沿用 ChisaBot 的数据库历史、权限、审批、工作流和工具执行器。** 这是接口适配判断；此轮没有完成 Bun 运行、Magpie 协议或任务质量验证。

包名已有变化：npm 的旧 `@mariozechner/pi-agent-core`、`@mariozechner/pi-ai` 当前为 0.73.1，均标记 deprecated 并指向新 scope。当前包是 **`@earendil-works/pi-agent-core@1.5.0` 和 `@earendil-works/pi-ai@1.5.0`**。源码 package.json 与 npm latest 一致。新 core 的依赖为同版本 `pi-ai`、`pi-schema`，声明 Node `>=22.19.0`。[core package](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/agent/package.json)、[npm core](https://registry.npmjs.org/@earendil-works%2fpi-agent-core/latest)、[旧包废弃说明](https://registry.npmjs.org/@mariozechner%2fpi-agent-core/latest)

`pi-coding-agent` 是另一层：默认会创建模型运行时、文件设置、持久会话树、资源发现和默认工具。其 `SessionManager` 是 finalized model context 的权威源，直接覆盖 `session.agent.state.messages` 不能替换持久上下文。它可以定制或使用内存 manager，但 ChisaBot 已有这些职责时，直接采用这层会增加需要协调的状态。不要把“用 Pi”默认理解为把完整 coding CLI 接到后台。[Coding Agent SDK](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/coding-agent/docs/sdk.md)

## 公开接口能提供什么

| 能力               | 官方实际语义                                                                                                                                                  | ChisaBot 的责任                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 工具循环和流式事件 | `Agent` 执行模型与工具循环，发出 agent/turn/message/tool 生命周期事件；工具 executor 接收真实 `toolCallId`、解析后的参数、`AbortSignal` 和进度回调            | 把已有工具包装为 `AgentTool`，将事件映射到当前前端事件协议                   |
| 宿主历史与压缩     | `transformContext` 可裁剪/注入上下文，`convertToLlm` 过滤应用消息；`prepareRequest` 在每次模型请求前可加载 canonical persisted context                        | 用现有数据库和长历史预算策略作为权威来源；保留原始历史与消息 ID              |
| 工具授权           | `beforeToolCall` 在参数校验后、执行前运行，可以阻止工具；`afterToolCall` 可调整结果                                                                           | actor/bot 权限、审批卡、审计和授权撤销仍由 ChisaBot 负责                     |
| 可靠事件次序       | `Agent.subscribe` 按注册顺序 await listener；assistant `message_end` 处理是工具预检前的 barrier；`prompt`/`waitForIdle` 等 `agent_end` listener 完成才 settle | 可先持久化工具调用记录，再执行副作用；listener 必须处理失败与取消            |
| 用户插话           | `steer` 在当前 assistant turn 的工具调用全部完成后注入；`followUp` 在没有工具和 steering 时追加下一轮                                                         | “立即停止当前工具”仍需 `abort` 与工具实际取消，不能把 `steer` 当成抢占式中断 |
| 取消               | `Agent.abort()` 触发当前 AbortController；工具/hook 接收 signal 并必须配合；`waitForIdle()` 等实际结束                                                        | 设备进程树、外部请求、取消宽限和结果未知处理仍是宿主契约                     |
| 回合结束或继续     | `finishTurn` 可返回 `end`/`continue`；错误和 aborted 是硬退出。工具结果可 `terminate: true`，仅当整个批次都要求 terminate 时提前停止                          | 实现长任务预算、最终回答判定和审批挂起恢复；不依靠无限循环                   |

证据：[Agent README](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/agent/README.md)、[类型契约](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/agent/src/types.ts)、[Agent 实现](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/agent/src/agent.ts)。

## 不能漏掉的差异

1. **默认工具执行为 parallel。** `sequential` 可全局设置或由任一工具要求整批串行。ChisaBot 对审批和共享设备有现有顺序语义，初始接入应明确选串行，再逐项开放已证明可并发的工具。[工具模式](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/agent/README.md#with-tool-calls)
2. **core 并不等于持久任务引擎。** 公开 `Agent` 维护内存 transcript 和队列；宿主可通过 awaited event listener 持久化，并在 `prepareRequest` 读取权威历史。`AgentTool.replay` 提供副作用重放策略标记，但不能单凭这个字段宣称已经拥有 PostgreSQL 准入、审批恢复或 exactly-once。ChisaBot 现有的去重和未知结果规则要保留。[core exports](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/agent/src/index.ts)、[类型和 replay 字段](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/agent/src/types.ts)
3. **审批需要明确 continuation 契约。** `beforeToolCall` 可拒绝或异步等待，但不自动提供 ChisaBot 的审批持久化、跨重启继续和前端确认卡。`terminate` 只在全批次要求结束时生效，不能任意用于混合批次中的挂起。[Agent README](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/agent/README.md)
4. **事件不是 AG-UI 原样输出。** pi-ai 允许 text/thinking/tool deltas 交错，消费者必须按 `contentIndex` 区分；流中错误会表现为 error event 与最终 assistant message 的 stopReason，不能只依赖 throw。ChisaBot 需一处清晰映射，避免重现错误吞掉或正文分类不稳。[pi-ai stream/error contract](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/ai/README.md)
5. **Magpie 可通过自定义 provider 接入，但需实际验证。** `createProvider()` 支持自己的 model list、认证和 OpenAI/Anthropic 兼容端点；`pi-ai` 可以注入宿主凭据存储和自定义 `streamFn`。这支持保留完整网关模型 ID、宿主模型目录和密钥服务，不能据此保证所有 Magpie 路由的工具/图像/推理协议都已兼容。[自定义 providers](https://github.com/earendil-works/pi/blob/085c84e98e7f4c950f2be606466fff4f75d8fe7c/packages/ai/README.md#custom-providers)
6. **声明的运行时是 Node >=22.19.0。** 此轮未验证 Bun；如继续在 Bun 后端进程内运行，应先通过定向实际验证决定是否直接嵌入，不能把 TypeScript 等同于已证明兼容。

## 对主评估的结论

相较于把完整 Hermes 经 ACP 接入、再替换内部状态，Pi core 已把 ChisaBot 需要的几个接入点写成公开接口：工具执行前后、上下文准备、回合控制和可等待事件。它允许保留宿主的产品状态，同时复用成熟的 agent loop，因而架构匹配度值得优先验证。

应先用同一模型、同一套 ChisaBot 工具验证多步任务、插话、审批挂起/恢复、停止和跨重启去重；这些通过后才推荐迁移默认。Pi 的 API 也在演进（README 记载 `shouldStopAfterTurn` 已由 `finishTurn` 替代），应固定版本并以真实契约测试升级，而不是跟随 main 自动更新。
