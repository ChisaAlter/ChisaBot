# 来源与许可说明

ChisaBot 基于 [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) 定制。仓库根 [LICENSE](../LICENSE) 保留上游 MIT License 与 `Copyright (c) 2026 CopilotKit`。

与模型交互相关的主要项目：

- [AG-UI](https://github.com/ag-ui-protocol/ag-ui)：代理与用户交互协议。
- [CopilotKit](https://github.com/CopilotKit/CopilotKit)：运行与界面相关依赖，版本以各包清单和锁文件为准。
- [Magpie](https://github.com/yetone/magpie)：可独立部署的模型网关，通过 API 集成；其源码、镜像和依赖遵循该项目自身的许可。

工程纪律技能与工作流（`examples/zh-CN/skills.yaml` 中 `# >>> pstack-port` 区块、`server/src/workflows/presets/pstack-adversarial-review.md`，见 [pstack-port.md](pstack-port.md)）移植自：

- [cursor/plugins 的 pstack 插件](https://github.com/cursor/plugins/tree/main/pstack)（MIT，Copyright (c) Cursor，作者 Lauren Tan / poteto）：24 条工程原则、`unslop`/`technical-writing`/`tdd`/`benchmark-checklist` 等技能正文按其 SKILL.md 原文移植，`pstack-adversarial-review` 按其 `interrogate` 技能的流程改写为 ChisaBot 工作流格式。

IM 接入（`server/src/im/`，见 [im.md](im.md)）参考了这些项目的设计和公开协议格式，没有复制其代码：

- [LangBot](https://github.com/langbot-app/LangBot)（Apache-2.0）：平台配置项与飞书、QQ 官方机器人、企业微信智能机器人、个人微信 ClawBot（iLink）的消息格式和流程。
- [larksuite/node-sdk](https://github.com/larksuite/node-sdk)（MIT，Copyright (c) Lark Technologies）：飞书长连接握手与 pbbp2 帧字段号（`server/src/im/feishu-proto.ts` 按其 `ws-client/proto-buf/pbbp2.js` 重写）。
- [OneBot 11](https://github.com/botuniverse/onebot-11) 标准：QQ 个人号协议端的正向 / 反向 WebSocket。
- [AstrBot](https://github.com/AstrBotDevs/AstrBot)（AGPL-3.0）、[cc-connect](https://github.com/chenhg5/cc-connect)：只参考了产品形态，未使用代码。

这份说明记录明确的来源，不替代各第三方依赖、资源或模型权重附带的完整许可声明。桌面图标与服务商标记来源另见 [桌面图标说明](../desktop/src-tauri/icons/README.md) 和 [服务商标记说明](../desktop/src/marks/README.md)。原声明继续保留。
