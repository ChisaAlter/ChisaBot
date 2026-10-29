# ChisaBot 的 ACP 传输桥

生产 Hermes 接入使用 `examples/hermes-agent/chisabot_acp.py`，在服务器现有 Hermes venv 内运行。ChisaBot 保留机器人身份、个人指令、记忆、模型选择、工具权限、确认卡、账号和文件；Hermes 执行模型与工具循环。没有面向用户的聊天/任务双内核模式。

```
ChisaBot → AG-UI/SSE → bridge.mjs → ACP stdio → ChisaBot Hermes adapter → Hermes AIAgent
    ↑                                                     │
    └── 当前运行的工具网关：原有授权、确认、审计与工具执行器 ──┘
```

服务器安装和升级入口是 `deploy/install-hermes-runtime.sh`。不在个人电脑安装或启动 Hermes；本地开发仅运行 fake ACP 测试。旧的 `start-hermes.ps1` 已禁用。

## 宿主契约

每个运行携带服务端创建的 `forwardedProps.chisabotHermes`：版本、actor/bot/thread/run 身份、模型 ID 和本轮随机工具能力。桥验证其身份与 AG-UI 顶层相同，并要求 ACP adapter 宣告 `_meta.chisabotHostTools: 1`。

人设、个人指令、动态记忆和当前工具 schema 每轮通过 ACP metadata 更新；完整历史转换为 OpenAI 消息，保留工具调用与结果、图片。密钥和工具能力不拼进模型提示词。工具只能调用已在 ChisaBot 注册、绑定当前运行的执行器；浏览器请求自行附上的 schema 不构成授权。

会话按 actor/bot/thread 隔离。相同运行、相同输入重试重放已有事件，不再次提示模型。新工具结果构成续跑段；续跑消费结果，不重发原始用户请求。进程重启后，已经开始但未提交结果的运行标记为未知，不自动重复可能已经执行的动作。

工具的真实模型调用 ID 贯穿 ACP、AG-UI、工具网关、确认卡与审批恢复。Hermes 拥有的工具由 Hermes 循环调用，宿主 Headless 只观察结果，缺回执时报错或挂起。它不会猜测工具尚未执行然后再做一次。

排队取消只取消本请求。活动取消/超时先通知 ACP，等结束；超过宽限期则退役整个子进程代，旧事件无法流进下一轮。设备取消使用既有设备 cancel 协议；外部服务已经完成的动作仍须以实际回执为准。

备用模型与输出上限：宿主每轮可在 `model` 里带 `fallbacks`（最多 8 个模型 ID）和 `maxOutputTokens`（1..1000000），桥校验后原样转给 adapter。adapter 在 initialize 的 `_meta.chisabotModelControls` 宣告检测到的能力，桥把它放进 `/health` 的 `modelControls`（未初始化时为 `null`）。adapter 回报的切换（`_meta.chisabot.modelFallback`）经校验后写进 `RUN_FINISHED.metadata.modelFallback`，不合法的直接丢弃。`model.contextCompression: false`（宿主已经压缩过这次运行的前文）校验为布尔后原样转发，adapter 据此在这次运行里关掉 Hermes 自带的上下文压缩。

## 生产环境变量

| 变量 | 作用 |
| --- | --- |
| `ACP_AGENT_CMD` | 服务器现有 venv Python 加 ChisaBot Hermes adapter 路径 |
| `HERMES_SOURCE_DIR` | 服务器已有 Hermes 源码目录 |
| `ACP_CWD` | ACP 的运行目录；它是工作目录，不是沙箱 |
| `ACP_BRIDGE_HOST` / `ACP_BRIDGE_PORT` | 仅服务内可达的监听地址 |
| `ACP_BRIDGE_TOKEN` | ChisaBot 到桥的 Bearer 凭据，必须配置 |
| `ACP_REQUIRE_HOST_CONTEXT=1` | 拒绝缺少可信运行上下文的请求 |
| `ACP_STATE_PATH` | 稳定执行账本路径；生产宿主模式必须配置 |
| `ACP_TURN_TIMEOUT_MS` | 整轮超时，默认 15 分钟，包含 ACP prompt RPC |
| `ACP_CANCEL_GRACE_MS` | 取消宽限期，默认 2 秒 |
| `CHISABOT_HERMES_URL` | ChisaBot 使用的桥 `/ag-ui` 地址 |
| `CHISABOT_HERMES_TOKEN` | 与桥 token 相同，不能进入模型上下文 |
| `CHISABOT_HERMES_TOOL_GATEWAY_URL` | Hermes 可访问的 ChisaBot `/api/internal/runtime-tools` 地址 |

原始通用 ACP 模式保留用于协议测试，不提供 ChisaBot 的完整权限、模型、历史语义。不能用通用 `hermes acp` 加一个 URL 宣称生产内核迁移完成。

`ACP_APPROVAL` 只决定桥如何回答实际收到的 ACP permission 请求。设为 deny 不等于禁用所有 shell 或网络，更不构成沙箱。生产 adapter 仅暴露 ChisaBot 已装配的工具，不额外暴露宿主机 root 的原生终端或文件工具。

## 验证

```sh
bun test examples/acp-agent/bridge.test.ts
bun test server/tests/hermes-runtime.test.ts server/tests/runtime-tools.test.ts
```

这些是本地 fake 协议与宿主执行测试，不需要 Hermes。服务器还必须验证真实模型、搜索与文件工具、模型切换、确认/拒绝、停止和历史恢复后，才能认定迁移完成。
