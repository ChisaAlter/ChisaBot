# Hermes / DSH 的 agent 内核，接到 ChisaBot

这是一个 **ACP ↔ AG-UI 桥**：把 Hermes Agent 或 DeepSeek Harness（DSH）自己的 agent 循环接到
ChisaBot 的远程 agent 接口上。机器人不再是「CopilotKit + 通用工具循环」，而是 Hermes / DSH 在跑。

```
ChisaBot  ── AG-UI: POST /ag-ui + SSE ──>  bridge.mjs  ── ACP: stdio JSON-RPC ──>  hermes acp
                                                                                   dsh acp
```

为什么是两个内核共用一套：Hermes 和 DSH 都实现了 [Agent Client Protocol](https://agentclientprotocol.com/)。
ACP 本来就负责「编辑器 / 宿主 ⇄ coding agent」的会话、流式文字、工具调用、权限请求和取消，
用它比给每个内核写一套 SDK 适配稳。

| ACP（内核侧） | AG-UI（ChisaBot 侧） |
| --- | --- |
| `session/update` → `agent_message_chunk` | `TEXT_MESSAGE_START / CONTENT / END` |
| `agent_thought_chunk` | `REASONING_START / REASONING_MESSAGE_*` |
| `tool_call` | `TOOL_CALL_START / ARGS / END` |
| `tool_call_update`（completed / failed） | `TOOL_CALL_RESULT` |
| `session/request_permission` | 桥自动回答（见下面的安全边界） |
| `session/prompt` 的 `stopReason` | `RUN_FINISHED` / `RUN_ERROR` |
| 取消 / 超时 | `session/cancel` + `RUN_ERROR` |

## 先决条件

### DSH

```powershell
# 桌面版自带 CLI（Windows 示例）
$dsh = "C:\软件\Whale Isle\resources\vendor\deepseek-harness\apps\cli\lib\bin.js"
$node = "C:\软件\Whale Isle\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
& $node $dsh acp --help     # 应看到 "Serve automation clients over Agent Client Protocol stdio"
```

ACP 进程用 DSH 自己的模型配置。它报 `MISSING_CREDENTIAL` 时，在启动它的环境里设
`DEEPSEEK_API_KEY`（或在该 profile 里配置一个有凭据的 provider）。桌面 App 的登录态在 App 的
credential service 里，CLI 子进程读不到。

### Hermes

```bash
# 装 ACP extra（只装一次）
cd ~/.hermes/hermes-agent && python -c "import pm; pm.sync_venv(['acp'], explicit=True)"

hermes acp --check
hermes model                 # 确认 provider / 模型已经配好
```

## 启动桥

在 ChisaBot 仓库根目录：

```bash
# DSH
ACP_AGENT_CMD='"C:\软件\Whale Isle\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" "C:\软件\Whale Isle\resources\vendor\deepseek-harness\apps\cli\lib\bin.js" acp' \
ACP_CWD='C:\AI\ChisaBot' \
bun examples/acp-agent/bridge.mjs
```

```bash
# Hermes
ACP_AGENT_CMD='hermes acp' ACP_CWD='C:\Users\me\work' bun examples/acp-agent/bridge.mjs
```

`ACP_AGENT_CMD` 支持引号，所以带空格的 Windows 路径也能用；也可以直接传数组（见测试）。

默认监听 `127.0.0.1:4100`，`GET /health` 返回进程状态、已初始化状态和 session 数。

### 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `ACP_AGENT_CMD` | `dsh acp` | 启动哪个 ACP agent；Hermes 用 `hermes acp` |
| `ACP_CWD` | 当前目录 | ACP session 的工作目录（工具读写都在这里） |
| `ACP_BRIDGE_HOST` / `ACP_BRIDGE_PORT` | `127.0.0.1` / `4100` | 监听地址 |
| `ACP_APPROVAL` | `allow` | `allow`：`session/request_permission` 自动选 `allow_once`；`deny`：一律拒绝 |
| `ACP_BRIDGE_TOKEN` | 空 | 设置后 `/ag-ui` 要求 `Authorization: Bearer <token>` |
| `ACP_TURN_TIMEOUT_MS` | 15 分钟 | 一轮超时后发 `session/cancel` 并报错 |

## 在 ChisaBot 里注册

`agents.yaml`（租户包）或产品里的「新建机器人 → 外部 AG-UI」：

```yaml
agents:
  - id: hermes
    name: Hermes
    title: 会动手的助手
    role_description: 用 Hermes 自己的循环和工具完成任务；需要 shell、文件、网页时直接做。
    type: remote-ag-ui
    endpoint: http://127.0.0.1:4100/ag-ui
```

保存 / 重启后，这个机器人就在左栏。它对话时走 Hermes/DSH，不再走 CopilotKit 的内置循环。

ChisaBot 在 Docker 里、桥在宿主机时，endpoint 用 `http://host.docker.internal:4100/ag-ui`，
并把该主机加进 `AGENT_ENDPOINT_ALLOWED_HOSTS`（或对应部署配置）；`127.0.0.1` 在容器里指向容器自己。

## 安全边界（一定要看）

- **审批不经过 ChisaBot。** ACP 的 `session/request_permission` 默认被桥自动同意，因为 ChisaBot 的
  审批卡只覆盖它自己下发的工具，覆盖不到 Hermes/DSH 的 shell / 文件工具。想收紧：
  - 设 `ACP_APPROVAL=deny`（工具会被拒绝，agent 只能说话）；
  - Hermes：用 `platform_toolsets.acp` / `agent.disabled_toolsets` 去掉 `terminal`、`code_execution`；
  - DSH：在它的 profile 里限制工具 / 沙箱；
  - 桥只监听 `127.0.0.1`，放到网络上必须配 token + 反向代理鉴权。
- **工作目录就是权限范围。** `ACP_CWD` 是 agent 的 cwd；给它一个专用目录，不要给整个用户目录。
- **ChisaBot 的工具不会自动出现。** 这条链路里，agent 只有 Hermes/DSH 自己的工具（shell、文件、网页、
  MCP、子 agent）。ChisaBot 的 Notion / Gmail / 面板 / 记忆 / 页面不在里面。要保留它们，需要把
  ChisaBot 的工具暴露成一个 MCP server，再把地址放进 `session/new` 的 `mcpServers`——这是下一步。
- **桥重启后 ACP session 会重建。** 当前没有实现 ACP 的 `session/load`；ChisaBot 的 threadId 到
  ACP sessionId 的映射在内存里。
- **模型选择用内核自己的默认值。** ACP 的 `configOptions` / 模型选择器没有透传到 ChisaBot；要换模型，
  在内核自己的配置里换（`hermes model` / DSH profile）。

## 测试

```bash
bun test examples/acp-agent/bridge.test.ts
```

测试用 `fake-acp.mjs`，覆盖：文字 / 工具调用 / 权限回答 / `RUN_FINISHED`、同一 thread 复用 session、
`refusal` → `RUN_ERROR`、空消息拒绝、token 保护。真实链路只需要把 `command` 换成
`dsh acp` 或 `hermes acp`；本机对真 DSH 跑过 `initialize → session/new → session/prompt`，
缺 `DEEPSEEK_API_KEY` 时它正确返回了 `RUN_ERROR`，不是挂起或假装成功。
