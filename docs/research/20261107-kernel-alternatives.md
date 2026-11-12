# 脱离 旧聊天前端框架 的执行内核选择

2026-11-07。用户明确不希望继续以从 早期上游模板 继承的 旧聊天前端框架 为内核。本轮为方案评估，未修改产品代码或运行配置；前轮聊天修复仍待发布。

## 推荐：直接使用 AI SDK

直接依赖 Vercel AI SDK 的 `ToolLoopAgent` 或在需要逐步控制的路径使用 `streamText`，替换 旧聊天前端框架 `BuiltInAgent`。ChisaBot 保留账号、bot/thread、PostgreSQL 历史、工具授权、审批、记忆、任务与恢复，模型接入继续使用 Magpie。

这是基于已有工程资产的选择：`server/src/copilot.ts` 已使用 `@ai-sdk/openai` 和 `@ai-sdk/anthropic`；`server/src/agents/model-fallback.ts` 已包装 AI SDK 模型的 `doStream` / `doGenerate`；工具 schema 使用 Zod。可以复用这些能力，减少协议和状态转换。AI SDK 是独立项目，无需保留 旧聊天前端框架 才能使用。

### 版本与能力

锁文件当前解析 `ai@6.0.264`，来自 旧聊天前端框架 的传递依赖。核对该版本官方源码：`ToolLoopAgent` 已有工具循环、`stopWhen`、`prepareStep`、生命周期回调，`generate` / `stream` 接受取消信号与期限。默认 20 步是可配置策略，不能在迁移中又引入一个不适合长任务的固定上限。

- [6.0.264 ToolLoopAgent](https://github.com/vercel/ai/blob/ai%406.0.264/packages/ai/src/agent/tool-loop-agent.ts)
- [6.0.264 配置](https://github.com/vercel/ai/blob/ai%406.0.264/packages/ai/src/agent/tool-loop-agent-settings.ts)
- [6.0.264 streamText](https://github.com/vercel/ai/blob/ai%406.0.264/packages/ai/src/generate-text/stream-text.ts)

当前官方站点已展示 v7，部分参数和能力变化，不能把最新示例直接套在当前锁定依赖上。[官方 agent 概览](https://ai-sdk.dev/docs/agents/overview)、[循环控制](https://ai-sdk.dev/docs/agents/loop-control)。本建议不要求同时升级到 v7。

SDK 的循环不是可持久恢复的完整业务运行器。ChisaBot 仍要接好执行记录、工具幂等、审批后的 continuation、队列插话与取消、断线回放、上下文预算和错误归属；迁移应复用当前有用实现，而不是假定调用 `ToolLoopAgent` 就已经获得这些保证。[消息持久化指南](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence)

## 其他候选

- **Pi agent-core**：轻量 agent 执行核心，可作为更独立的内嵌后端候选；具体包身份、流式事件、steering/follow-up 与宿主责任见同期 Pi 官方源码核对笔记。若选择它，应使用核心库并注入 ChisaBot 工具，而不是再桥接整个 coding-agent CLI。
- **Mastra**：完整 TypeScript agent/workflow 框架，官方有持久工作流快照和 suspend/resume。若愿意将 ChisaBot 的部分编排与存储职责迁入框架，它有价值；只为替换模型工具循环，则会与已有任务、记忆和工作流体系重叠。[Agents](https://mastra.ai/docs/agents/overview)、[Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume)

## 完整脱离需要两步

1. 替换服务端 `BuiltInAgent` / runtime 运行路径，复用现有模型连接、工具、数据库与消息格式，验证长任务、审批续跑、取消和不重复执行。
2. 替换前端 `旧聊天前端框架Provider` / `useAgent` 及工具渲染注册依赖，再移除相关包。已有气泡、卡片和历史数据不必因替换会话驱动而重做。

只做第一步仍保留 旧聊天前端框架 的前端会话层，不能称为彻底脱离。当前未执行任何内核迁移，也没有以同任务对照证明候选更快或成功率更高。
