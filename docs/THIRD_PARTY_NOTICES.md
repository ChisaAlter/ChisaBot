# 第三方开源组件与代码来源说明

ChisaBot 部分早期基础框架源自 [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot)（MIT License），原始版权声明与自有模块版权声明一并保留于仓库根 [LICENSE](../LICENSE)。

## 核心执行与协议依赖

- **DSH 执行内核**（`runtime/dsh/package.json`）：使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `@deepseek-ai/dsh*` 系列包与 `@deepseek-ai/cordis`，各包许可遵循其发布包内声明。
- **[AG-UI](https://github.com/ag-ui-protocol/ag-ui)**：代理与会话事件交互协议类型。
- **[Magpie](https://github.com/yetone/magpie)**：可独立部署的模型网关，通过 HTTP API 集成；其源码、镜像和依赖遵循该项目自身的许可。

## 仓库内置第三方源码与字体

以下直接纳入仓库源码或静态资源的文件保留各自独立的版权与许可证声明：

- `app/src/vendor/shadcn-react-message-scroller/LICENSE.md`：MIT License，Copyright (c) 2023 shadcn。
- `app/src/components/ui/live-waveform.tsx`：MIT License，Copyright (c) 2025 Eleven Labs Inc.（改编自 [elevenlabs/ui](https://github.com/elevenlabs/ui)）。
- `app/src/lib/qr/qrcodegen.ts`：MIT License，Copyright (c) Project Nayuki（源自 [nayuki/QR-Code-generator](https://github.com/nayuki/QR-Code-generator)）。
- `app/src/assets/fonts/LICENSE-Sora.txt`：SIL Open Font License 1.1，Copyright 2019 The Sora Project Authors。

## 技能、IM 协议与架构设计参考

工程纪律技能与工作流（`examples/zh-CN/skills.yaml` 中 `# >>> pstack-port` 区块、`server/src/workflows/presets/pstack-adversarial-review.md`，见 [pstack-port.md](pstack-port.md)）移植自：

- [cursor/plugins 的 pstack 插件](https://github.com/cursor/plugins/tree/main/pstack)（MIT，Copyright (c) Cursor，作者 Lauren Tan / poteto）：24 条工程原则、`unslop`/`technical-writing`/`tdd`/`benchmark-checklist` 等技能正文按其 `SKILL.md` 原文移植，`pstack-adversarial-review` 按其 `interrogate` 技能流程改写为 ChisaBot 工作流格式。

IM 接入（`server/src/im/`，见 [im.md](im.md)）参考了以下项目的设计和公开协议格式，未直接复制其业务代码：

- [LangBot](https://github.com/langbot-app/LangBot)（Apache-2.0）：平台配置项与飞书、QQ 官方机器人、企业微信智能机器人、个人微信 ClawBot（iLink）的消息格式和流程。
- [larksuite/node-sdk](https://github.com/larksuite/node-sdk)（MIT，Copyright (c) Lark Technologies）：飞书长连接握手与 pbbp2 帧字段号（`server/src/im/feishu-proto.ts` 按其 `ws-client/proto-buf/pbbp2.js` 重写）。
- [OneBot 11](https://github.com/botuniverse/onebot-11) 标准：QQ 个人号协议端的正向 / 反向 WebSocket。
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)（AGPL-3.0）、[cc-connect](https://github.com/chenhg5/cc-connect)：仅参考产品形态，未使用代码。

任务触发、交付状态与聊天连续性设计参考了以下开源项目（仅借鉴公开架构与交互思路，未引入其受限资产或捆绑组件）：

- [aibot-fans/dsh-bot](https://github.com/aibot-fans/dsh-bot)（代码 Apache-2.0）：附件草稿持久性、会话连接所有权、触发水位与记忆来源溯源思路。
- [BotHarness/DeepSeekBot](https://github.com/BotHarness/DeepSeekBot)（MIT）：外部发件箱（Outbox）未知结果边界与备份校验思路。
- [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot)（Apache-2.0）：阅读视口锚点与错误恢复入口设计对照。

本说明记录主要代码来源与致谢，不替代 `node_modules` 各第三方依赖、外部服务或模型权重附带的完整许可证声明。
