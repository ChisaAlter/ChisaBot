# Todos（todos.dev）多 Agent 工作台驱动机制调研

> 调研日期：2026-11-18。调研对象：ZEN（@supezen）在 X 上发布的一张「Todos 驱动 23 个 coding agent」兼容性表，及其背后的四类传输机制。本文用一手资料（官方文档、GitHub 仓库、协议规范）逐项核验该表的声明；凡未能找到一手来源的内容均标注「未证实」。

## 1. 调研对象

### 1.1 Todos 是什么

- Todos（todos.dev）是 @supezen 独立开发的「任务驱动工作台」：一个 Web/PWA + 桌面 App（macOS/Windows/Linux）产品，内置看板、常驻编排 Agent「Chief（大总管）」、跨机器构建调度，并内置一个远程 MCP Server（`https://todos.dev/api/mcp`，Streamable HTTP + Bearer Key，共 41 个工具）供外部 Agent 反向操作工作台。来源：[todos.dev](https://todos.dev/)、[docs/overview](https://todos.dev/docs/overview)、[docs/mcp](https://todos.dev/docs/mcp)。
- **不开源**。未找到公开源码仓库；产品为闭源 SaaS + 本机守护进程。机器侧的 agent 是 `tds` CLI（`npm install -g @todos-dev/cli`，`tds start` 起守护进程，每五分钟探测一次本机已安装/已登录的各家 CLI）。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)（"the `tds` daemon on the machine runs every turn by launching the CLI you installed"）、[npm @todos-dev/cli 在 docs/mcp-servers 中的引用](https://todos.dev/docs/mcp-servers)。
- 内置运行时叫 **pi**（用户提问「少了 pi，私有 rpc」时作者回复「Pi 是内置的，所以不在表里面」）。来源：[x.com/supezen/status/2122953944280551914 评论区](https://x.com/supezen/status/2122953944280551914)、[docs/runtimes](https://todos.dev/docs/runtimes)（"The default is Todos' built-in runtime (pi)"）。

### 1.2 原始 X 帖

- 帖子：[x.com/supezen/status/2122953944280551914](https://x.com/supezen/status/2122953944280551914)（2026-11-18 07:23 UTC）：「很多小伙伴对 Todos 调用 Coding Agent 底层原理非常感兴趣……根据这张表你可以 vibe coding 一个自己的工作台，少踩很多坑。」表格以图片形式发布，正文不可抓取其单元格内容；但 **Todos 官方文档的 [External runtimes](https://todos.dev/docs/runtimes) 页逐运行时给出了与表格一致的驱动方式**，本文以该文档页为「表格声明」的可引用载体，再逐项对照各家官方资料核验。
- 文档列出的 23 个外部运行时：Claude Code、Codex、Grok Build、Cursor、Antigravity、Devin、GitHub Copilot、Gemini CLI、omp、OpenCode、Qwen Code、Droid、Cline、dsh、Hermes Agent、Qoder CLI、OpenClaw、Amp、Kiro CLI、Auggie、ZCode、fx、Muse Code。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。

### 1.3 核心架构结论（文档已确认）

Todos 不自己实现 agent loop：每回合由 `tds` 守护进程以该 CLI 的「官方自动化入口」拉起你本机已登录的 CLI，模型调用/工具循环/文件编辑全由厂商 CLI 自己完成。Todos 在其上叠加三样东西：追加指令（各 CLI 的注入方式不同，见 §4 坑点）、平台工具（经 `tds mcp-bridge` 暴露为名为 `tds` 的 MCP server，工具形如 `mcp__tds__ask_user`）、团队密钥（注入进程环境）。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes) "What it actually is" 一节。

## 2. 四类驱动机制核验

下表为 Todos 文档声明的驱动方式（来源均为 [docs/runtimes](https://todos.dev/docs/runtimes)），后文逐类对照一手资料核验。

| 类别 | Agent | Todos 声明的入口 |
|---|---|---|
| Claude Agent SDK | Claude Code | `claude`，经 Claude Agent SDK |
| 私有 RPC | Codex | `codex app-server` |
| 私有 RPC | GitHub Copilot | `copilot`（其官方 SDK 驱动的 headless server） |
| 私有 RPC | omp | `omp` RPC 模式（`omp --mode rpc`） |
| 私有 RPC | Droid | `droid exec`（其 SDK 驱动的 JSON-RPC 模式） |
| 私有 RPC | Muse Code | `muse serve`（Muse Session Protocol，stdio JSON-RPC） |
| ACP | Grok Build | `grok`（`grok agent stdio`） |
| ACP | Devin | `devin`（`devin acp`） |
| ACP | Gemini CLI | `gemini`（`gemini --acp`） |
| ACP | OpenCode | `opencode`（`opencode acp`） |
| ACP | Qwen Code | `qwen`（`qwen --acp`） |
| ACP | Cline | `cline`（`cline --acp`） |
| ACP | dsh | `dsh`（`dsh --profile acp`） |
| ACP | Hermes Agent | `hermes acp` |
| ACP | OpenClaw | `openclaw acp`（桥接到本机 Gateway） |
| ACP | Kiro CLI | `kiro-cli acp`（默认 v2 引擎） |
| ACP | Auggie | `auggie --acp` |
| ACP | fx | `fx acp` |
| stream-json | Cursor | `cursor-agent -p --output-format stream-json` |
| stream-json | Antigravity | `agy` 流式 headless |
| stream-json | Qoder CLI | `qodercli -p --output-format stream-json`（国内版 `qoderclicn`） |
| stream-json | Amp | `amp -x --stream-json-thinking --stream-json-input`，回合间 `threads continue` |
| stream-json | ZCode | `zcode --prompt --output-format stream-json`，回合间 `--resume` |

### 2.1 Claude Agent SDK（1 个：`claude`）

官方文档证实：

- **进程形态**：SDK 在底层拉起 `claude` 二进制并以 stream-json 协议通信；streaming input 模式下会话保持打开，可随时再写一条 `SDKUserMessage`。来源：[code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)。
- **回合中插话**：支持。streaming input 模式可在响应进行中追加消息（官方文档专门教「send follow-up messages while it runs」），另有 `interrupt()` 可立即截断当前响应。来源：同上；[code.claude.com/docs/en/agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript)（`interrupt()` 在 `interrupt_receipt_v1` 能力下返回被打断时仍排队的消息列表）。
- **检查点/回退**：`enableFileCheckpointing: true` 打开文件检查点，每次发起回合的用户消息 UUID 即恢复点，`rewindFiles(userMessageId)`（Python `rewind_files`）把文件恢复到该消息时刻；**注意只回退文件、不回退会话历史**，且只跟踪 Write/Edit/NotebookEdit 工具的改动，`sed -i` 之类 Bash 改动不可回退。来源：[code.claude.com/docs/en/agent-sdk/file-checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)。
- **分叉**：`forkSession(sessionId, { upToMessageId })` 复制 transcript 成新会话，可从任意消息点分叉；**分叉不带原会话的文件检查点**（fork 后不能 rewind 到 fork 前的 checkpoint）。来源：[code.claude.com/docs/en/agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript)、[docs/sessions](https://code.claude.com/docs/en/agent-sdk/sessions)。
- **平台压缩**：SDK 自带自动压缩（接近窗口上限时压缩旧历史，流中发 `compact_boundary` 消息），也可发 `/compact` 手动触发；Todos 侧另用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_CODE_PROMPT_CACHE_TTL=1h` 控制窗口。来源：[code.claude.com/docs/en/agent-sdk/agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)、[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。
- 表格归类（SDK 独占一类）**成立**：SDK 是四种机制里唯一以库形式嵌入、且自带 fork/checkpoint 语义的通道。

### 2.2 私有 RPC（5 个）

#### Codex — `codex app-server` ✅

- 官方文档：`codex app-server` 是 Codex 给「富客户端」（VS Code 扩展、macOS App）用的双向 JSON-RPC 2.0 协议（**线上报文省略 `"jsonrpc":"2.0"` 头**），默认 stdio（JSONL），也支持 WebSocket/Unix socket。来源：[learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server)、[github.com/openai/codex `codex-rs/app-server-protocol/src/rpc.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/rpc.rs)。
- **回合中插话**：`turn/steer`（要求 `expectedTurnId` 匹配当前活动 turn，不产生新 `turn/started`）；另有 `turn/interrupt`。来源：[learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server) "Steer an active turn"、[PR #10821](https://github.com/openai/codex/commit/0d8b2b74c46aeb7c691fcaf96156ed7927ee1d16)。
- **回退/分叉**：`thread/fork` 复制历史成新 thread，`lastTurnId` 可截断到指定回合、`ephemeral: true` 内存态分叉；`thread/resume` 续接。来源：[codex-rs/app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、[learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server)。
- **压缩**：`thread/compact`（v2 触发式 RPC，异步执行）、`model_auto_compact_token_limit` 配置项（Todos 设置为窗口上限的 80%）。来源：[openai/codex PR #10445](https://github.com/openai/codex/pull/10445)、[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。

#### GitHub Copilot — `copilot` headless server ✅（注意：不是 ACP）

- `copilot --headless` 把 CLI 作为常驻服务跑起来；官方 `@github/copilot-sdk` 经 **私有 JSON-RPC**（`ping`、`session.create` 等私有方法词表，与 ACP 不同）通过 stdio 或 TCP 与之通信；SDK 内部即以 `copilot --headless --stdio` 拉起进程。来源：[docs.github.com/copilot-sdk backend-services](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/backend-services)、[github/copilot-sdk choosing-a-setup-path](https://github.com/github/copilot-sdk/blob/main/docs/setup/choosing-a-setup-path.md)、[github/copilot-sdk issue #530](https://github.com/github/copilot-sdk/issues/530)。
- **回合中插话**：SDK `send({ mode: "immediate" })` 回合中直接插入（steering），`send({ mode: "enqueue" })` 排队到下一回合，`abort()` 取消。来源：[docs.github.com/copilot-sdk compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility)。
- **会话续接**：`resumeSession()`/`getLastSessionId()`/`listSessions()`；回退/分叉未见私有协议原语，标记「未证实」（Todos 文档未把 Copilot 列入「session 可随代码回退」名单，即按重开会话处理）。来源：同上。
- **坑**：Copilot CLI 是「下载器 + 委派」结构会自动升级，v0.0.410 曾短期移除 `--headless --stdio` 造成 SDK 全版本失效——托管方必须 `cliPath` 固定版本或防自动升级。来源：[github/copilot-sdk issues #530/#532](https://github.com/github/copilot-sdk/issues/530)。
- 另有独立的 `copilot --acp [--stdio|--port]` ACP server（标准 ACP 词表），与 SDK 私有协议并存——同一个 CLI 两套自动化协议，容易混。来源：[docs.github.com copilot-cli-reference/acp-server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)。

#### omp — `omp --mode rpc` ✅

- `omp` 是 oh-my-pi（`github.com/can1357/oh-my-pi`，omp.sh）——Rust 内核 coding agent，四种入口：TUI、`omp -p` 单发、Node SDK、`omp --mode rpc`。RPC 模式是**自定义 JSONL-over-stdio 协议（明确不是 JSON-RPC 2.0）**：stdin 收命令、stdout 出 ready 帧/响应/事件，v2 协议支持大帧分块重组（`rpc_chunk`，单物理帧上限 1 MiB，重组上限 64 MiB）。来源：[github.com/can1357/oh-my-pi docs/rpc.md](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)、[omp.sh](https://omp.sh/)。
- **回合中插话**：协议内建 `steer` 命令（插入正在运行的回合）与 `followUp` 队列，`streamingBehavior: "steer"`、`set_steering_mode all|one-at-a-time`、`set_interrupt_mode immediate|wait`、`abort_and_restore_queue`（原子「撤回队列并中止」）等一整套 steering 语义。来源：同 docs/rpc.md 命令清单。
- **回退/分叉**：`fork`（`entryId` 可选，把会话切到分叉出的新会话文件）、`branch`/`navigate_tree` 会话树导航、`switch_session`/`open_session`。来源：同 docs/rpc.md。
- 这是五个私有 RPC 里协议表面最完整的一个（插话、排队、分叉、压缩事件 `manual_compaction`/`auto_compaction` 全部内建）。来源：同 docs/rpc.md。

#### Droid — `droid exec` JSON-RPC ✅

- `droid exec` 是 Factory 的 headless 模式；`-o/--output-format` 支持 `text|json|stream-json|stream-jsonrpc|acp`。**多回合用 `--input-format stream-jsonrpc --output-format stream-jsonrpc` 驱动原始 JSON-RPC**（旧 `stream-json` 输入已弃用）。方法：`droid.initialize_session`、`droid.load_session`、`droid.add_user_message`、`droid.session_notification`；官方明确「其余 session 方法可中断工作、更新设置、管理 MCP、检查上下文、**fork sessions**、压缩历史」。来源：[docs.factory.com/droid-exec/overview](https://docs.factory.com/droid-exec/overview)。
- **回合中插话**：官方 SDK `session.interrupt()` 可中断当前 turn；第三方集成证实「busy 时消息排队（默认）或 interrupt:true 打断并续接」「step-boundary steering」（即在工具调用边界插话）——与 Todos 文档「Droid 会在它正在跑的工具调用结束后收进消息」一致。来源：[docs.factory.com/sdk/typescript](https://docs.factory.com/sdk/typescript)、[zeron PR #1434](https://github.com/zeronsh/zeron/pull/1434)（第三方实现说明，非官方）。
- **会话续接**：`-s/--session-id` 续会话、`droid.load_session`；会话 fork 见上。来源：[docs.factory.com/droid-cli/cli-reference](https://docs.factory.com/droid-cli/cli-reference)。

#### Muse Code — `muse serve`（Muse Session Protocol, MSP）✅

- Meta 的 coding agent（dev.meta.ai，模型 muse-spark）。`muse serve` 起 host 进程，客户端经 **JSON-RPC 2.0 over stdio（NDJSON 分帧，保留 `"jsonrpc"` 字段——与 Codex 不同）** 驱动会话；协议是 pre-1.0。官方 SDK：`@muse-code/sdk`（github.com/meta-models/muse-code-sdk）。来源：[meta-models.github.io/muse-code-sdk msp-concepts](https://meta-models.github.io/muse-code-sdk/next/guides/msp-concepts/)、[msp-wire/framing-and-caps](https://meta-models.github.io/muse-code-sdk/next/guides/msp-wire/framing-and-caps/)。
- **回合中插话**：`turn/steer`（含 `expectedTurnId`）、`turn/interrupt`（优先通道）、`turn/cancel`；`turn/start` 的 `ifBusy: "queue"` 排队语义，ack 的 `disposition` 字段（`started|queued|…`）是唯一路由事实。来源：[cookbook/queue-steer-and-reclaim-turns](https://meta-models.github.io/muse-code-sdk/1.4/cookbook/queue-steer-and-reclaim-turns/)、[generated Turn 文档](https://meta-models.github.io/muse-code-sdk/1.4/generated/python/turn/)。
- **回退/分叉/压缩**：方法表里有 `session/fork`、`session/compact`、`session/resume`、`session/list`。来源：[generated MSP methods](https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/methods/)。
- **值得注意的矛盾**：MSP 协议原生支持 `session/fork`，但 Todos 文档明说 Muse Code「sessions cannot drop turns，回退时恢复代码但 CLI 会话重开」——即 Todos **没有使用** fork 能力，按重开处理。协议能力 ≠ 工作台实现的选择。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes) "sessions cannot drop turns" 段。

### 2.3 ACP（12 个）

ACP（Agent Client Protocol）是 Zed 主导的开放协议：客户端（编辑器/工作台）spawn agent 进程，stdio 上跑 newline-delimited JSON-RPC 2.0。规范要点（来源：[agentclientprotocol.com/protocol/schema](https://agentclientprotocol.com/protocol/schema)、[prompt-turn.md](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)）：

- `session/prompt` 发起一个回合；回合以 `stopReason`（`end_turn|max_tokens|max_turn_requests|refusal|cancelled`）结束；**规范原文：「Once a prompt turn completes, the Client may send another `session/prompt`」——v1 规范没有定义「回合中再发 prompt」的语义**，一个 session 同时只有一个活动回合（Qwen 的 acp-bridge 文档明说 "Serialize per-session prompts through promptQueue (ACP enforces one active prompt per session)"，来源：[qwen-code-docs ACP bridge](https://qwenlm.github.io/qwen-code-docs/en/developers/daemon/03-acp-bridge/)）。回合中唯一能做的是 `session/cancel`（notification，要求 agent 尽快停模型请求和工具调用并以 `cancelled` 回答原 prompt 请求）。所以「ACP 回合中插话」**不是规范能力，而是各实现方的行为差异**：有的 agent 把回合中收到的第二个 `session/prompt` 排队到下一回合，有的折叠进当前回合——Todos 文档逐家记录了这种差异（见 §3）。
- 规范**没有任何回退/检查点方法**。稳定方法里与会话存续相关的是 `session/load`（回放历史）、`session/resume`（不回放直接续）、`session/list`、`session/close`、`session/delete`。
- **`session/fork` 是 unstable RFD 扩展**（[agentclientprotocol.com/rfds/session-fork](https://agentclientprotocol.com/rfds/session-fork)），已进 v2 draft schema（`session.fork` capability），可选 `cursorId` 在指定位置分叉。也就是说 ACP 世界里「分叉」只能靠各实现走 unstable 扩展或私有 `_meta`/extMethod 实现；「截断会话历史」规范里完全不存在，只能依赖各 CLI 自身会话存储能否被截尾。
- 压缩有 `compaction_update`/`compaction_summary_chunk` 通知（需客户端声明 `session.compaction` capability）；`usage_update` 报上下文占用。来源：[prompt-turn.md §Session compaction](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)。
- ACP Registry（[agentclientprotocol.com/get-started/registry](https://agentclientprotocol.com/get-started/registry)，github.com/agentclientprotocol/registry）是官方 agent 名录，下述 agent 多数在册。

逐个核验（✅=官方一手来源证实该入口存在）：

| Agent | 入口 | 一手来源 |
|---|---|---|
| Grok Build | `grok agent stdio` ✅ | [docs.x.ai/build/cli/headless-scripting](https://docs.x.ai/build/cli/headless-scripting)（"runs Grok as an ACP agent over JSON-RPC on stdin/stdout"）、[github.com/xai-org/grok-build README](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md)（另有 `grok agent serve` WebSocket、`_meta.yoloMode` 等） |
| Qwen Code | `qwen --acp` ✅ | [qwen-code-docs architecture](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/)（`qwen --acp` hosts the agent behind ACP；`--acp` 已转正、旧名 `--experimental-acp` 弃用，[PR #1355](https://github.com/QwenLM/qwen-code/pull/1355)） |
| OpenCode | `opencode acp` ✅ | [opencode.ai/docs/cli/acp](https://opencode.ai/docs/cli/acp/)、[packages/opencode/src/acp/README.md](https://github.com/anomalyco/opencode/blob/ec3ae17e/packages/opencode/src/acp/README.md) |
| Devin | `devin acp` ✅ | [docs.devin.ai/cli/reference/commands](https://docs.devin.ai/cli/reference/commands)（`devin acp` ACP server over stdio） |
| fx | `fx acp` ✅ | [fx.sh/docs/using-fx/acp](https://fx.sh/docs/using-fx/acp)、[github.com/vercel-labs/fx](https://github.com/vercel-labs/fx)（Vercel Labs 的 Zig 单文件 agent） |
| dsh | `dsh --profile acp` ✅ | [github.com/deepseek-ai/deepseek-harness apps/cli README](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)（`dsh --profile acp`）、[packages/acp/acp/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)（明说支持 list/resume/close，**不支持 delete/fork/历史回放/additionalDirectories**） |
| Gemini CLI | `gemini --acp` ✅ | [geminicli.com/docs/cli/acp-mode](https://geminicli.com/docs/cli/acp-mode/)（`--acp`，JSON-RPC over stdio）、[PR #21171](https://github.com/google-gemini/gemini-cli/pull/21171)（`--experimental-acp` → `--acp`） |
| Cline | `cline --acp` ✅ | [docs.cline.bot/usage/acp](https://docs.cline.bot/usage/acp)、[apps/cli README](https://github.com/cline/cline/blob/main/apps/cli/README.md) |
| Hermes Agent | `hermes acp` ✅ | [hermes-agent.nousresearch.com programmatic-integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)（`hermes acp`，需 `hermes pm install --extra acp` 装 `agent-client-protocol` 依赖；其 adapter 的 server.py 实现 `new/load/resume/fork/list/cancel`——**是少数自报 session fork 能力的 ACP 实现**）、[acp-internals](https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals) |
| Kiro CLI | `kiro-cli acp` ✅ | [kiro.dev/docs/cli/acp](https://kiro.dev/docs/cli/acp/)（v1/v2/v3 三种 harness，`acp.agentEngine` 或 `--agent-engine` 选择；Todos 文档称其用默认 v2 引擎——Kiro 3.0+ 默认实为 v3，**这一点 Todos 文档与 Kiro 官方文档存在出入**，可能因为 Todos 场景带了 V2-only flag 或被识别为需要 V2 的客户端） |
| Auggie | `auggie --acp` ✅ | [docs.augmentcode.com/cli/acp/agent](https://docs.augmentcode.com/cli/acp/agent)（`auggie --acp`，v0.7.0+） |
| OpenClaw | `openclaw acp` ✅ | [docs.openclaw.ai/cli/acp](https://docs.openclaw.ai/cli/acp)（**桥接**：stdio 说 ACP，转发到本机运行中的 OpenClaw Gateway 的 WebSocket 会话；实现矩阵：prompt/cancel/listSessions/resume/close 已实现，loadSession 部分实现，无 fork） |

**未证实项**：12 个 ACP agent 的 ACP 入口全部找到一手来源；但各实现对「回合中第二个 prompt」的具体行为（排队 vs 折叠进当前回合 vs 报错）官方文档基本不写，Todos 文档的逐家行为记录（§3）目前是该信息的最佳来源，标记为「Todos 声称、未独立复测」。

### 2.4 stream-json（5 个）

这一类的共同特征：以 print/headless 模式输出逐行 JSON 事件，**单向**（每回合一次进程或一次 stdin 写入），协议无 fork/truncate/steer 原语，回退只能重开会话。

- **Antigravity `agy`** ✅：`agy -p/--print/--prompt` headless，`--output-format text|json|stream-json`（NDJSON：`init`/`step_update`/`result`）；`--input-format stream-json` 时进程常驻、stdin 逐行写 user 事件驱动多回合，`--conversation <id>` 续接。社区协议记录明确「一次只能在途一个回合；**没有 cancel、没有回合中输入**」。来源：[antigravity.google/docs/cli/headless](https://www.antigravity.google/docs/cli/headless/)、[2BAB antigravity-protocol docs/stream-json.md](https://github.com/2BAB/antigravity-protocol/blob/main/docs/stream-json.md)（社区记录，非官方）。
- **Cursor `cursor-agent`** ✅：`agent -p/--print` + `--output-format stream-json`（`system/init`、`user`、`assistant`、`tool_call`、`result` 事件），`--stream-partial-output` 出 token 增量，`--resume [chatId]` 续会话；headless 下审批规则不变，需 `--force` 才不拒绝写操作。来源：[cursor.com/docs/cli/headless](https://cursor.com/docs/cli/headless)。另注：`cursor-agent acp` 子命令也存在（见 OpenClaw acpx 表），Todos 选了 stream-json 而非 ACP。
- **Qoder CLI `qodercli`** ✅：`-p/--print` headless，`--output-format stream-json`，`--input-format stream-json` 可从 stdin 连续送结构化消息。来源：[docs.qoder.com/cli/run-in-scripts.md](https://docs.qoder.com/cli/run-in-scripts.md)。
- **Amp `amp`** ✅：`-x/--execute` 执行模式 + `--stream-json`（输出与 Claude Code stream-json 尽量同构），`--stream-json-thinking` 加思考块，`--stream-json-input` 让 stdin 逐行喂 user 消息、`steer: true` 字段表示「在 agent 忙时的下一个中断点处理」——**即 Amp 协议层支持回合中 steer**，但 Todos 文档说「Amp takes no message mid-turn」：Todos 用的是「每回合一次 `amp -x` + `amp threads continue` 续 thread」的形态，未启用 stdin steer。协议能力 vs 工作台用法再次分离。线程在 ampcode.com 上，`threads continue <id>` 跨进程续接。来源：[ampcode.com/docs/cli/streaming-json](https://ampcode.com/docs/cli/streaming-json)、[execute-mode](https://ampcode.com/docs/cli/execute-mode)。
- **ZCode `zcode`** ✅：Z.ai 开源 coding agent（[github.com/zai-org/ZCode](https://github.com/zai-org/ZCode)，Apache-2.0；无官方二进制发行，需 `pnpm` 从源码构建 `zcode.cjs` 或用社区安装脚本）。`zcode -p/--prompt` headless、`--output-format stream-json`、`--resume <sess_id>` 续会话、`--mode yolo` 默认放开权限；无 stdin prompt 模式（argv-only）。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)、[ZCode HEADLESS.md（社区包）](https://cdn.jsdelivr.net/npm/zcode-app-cli@3.17.2-45/docs/HEADLESS.md)、[multica issue #9705](https://github.com/multica-ai/multica/issues/9705)（第三方实测记录）。

## 3. 三个能力列的语义核验

### 3.1 回合中插话（mid-turn interjection / steering）

一手资料证实的真实机制分四档：

1. **协议原生 steer**：Claude Agent SDK streaming input（消息在工具调用间送达 + `interrupt()`）、Codex `turn/steer`、Copilot SDK `send({mode:"immediate"})`、omp `steer` 命令、Droid stream-jsonrpc 的 step-boundary 输入、Muse `turn/steer`、fx 自身 steering（Todos 文档：消息在下一次模型请求时并入运行中回合）、Amp `steer:true`。
2. **工具调用边界收件**：Qwen Code、Droid（Todos 文档：「pick one up after the tool calls they are running」）；Devin CLI ≥3000.11.92 在下一个工具调用或写答案时折入。
3. **排队到下一回合**：ACP 规范本身只允许回合结束后发下一个 `session/prompt`，所以多数 ACP agent 的「插话」实际是排队。Todos 文档点名不收回合中消息的：Cursor、Antigravity、Gemini CLI、Cline、dsh、Hermes Agent、Qoder CLI、OpenClaw、Amp（其用法）、Kiro CLI、Auggie、ZCode；OpenCode 在 macOS/Linux 可收文本（Windows 或带图片时排队）。
4. **兜底**：Todos 对任何外部运行时「中断正在执行的工具调用」都是直接截断当前回合、把消息作为下一回合立即执行。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes) "Differences from the built-in runtime"、[docs/conversation](https://todos.dev/zh/docs/conversation)。

**结论**：插话能力几乎完全由传输层决定。SDK/私有 RPC 六家里五家有原生 steer；ACP 里只有少数实现把第二个 prompt 折入回合（且行为不一）；stream-json 除 Amp 的 `steer` 字段（Todos 未用）外完全没有。

### 3.2 回退检查点：截断 / 分叉 / 重开

- **截断**（截掉会话历史尾部重试）：依赖 CLI 会话存储可写回。Todos 文档证实 Gemini CLI、OpenCode、Qwen Code、Droid、Qoder CLI 的会话能随代码一起回退，Cline 在 CLI 压缩过历史之前也可以（压缩点之后重开）。Gemini CLI 侧的一手佐证：自带 checkpointing（`~/.gemini/history/<project_hash>` 影子 git 仓库快照 + 会话历史 + 待执行 tool call 一起存，`/restore`、`/rewind` 可同时回退代码与会话）。来源：[geminicli.com/docs/cli/checkpointing.md](https://geminicli.com/docs/cli/checkpointing.md)、[docs/cli/rewind.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/rewind.md)。OpenCode 有 `/undo` `/redo` 会话级 revert 机制（[opencode ACP 文档提及](https://frank.dev.opencode.ai/docs/acp/)）。注意 **Qoder CLI 虽在 stream-json 组，但 Todos 声称其会话可截断**——说明「传输 = stream-json ⇒ 只能重开」不成立，能力列与传输列是正交的。
- **分叉**（复制会话到分支）：Claude SDK `forkSession`、Codex `thread/fork`、omp `fork`、Droid「fork sessions」、Muse `session/fork`、Hermes 的 ACP `session/fork`（unstable）、ACP v2 draft 的 `session.fork`。来源：§2 各节。
- **重开**（无回退原语，恢复代码后新开会话）：Todos 文档点名 Cursor、Antigravity、Devin、dsh、Hermes Agent、OpenClaw、Amp、Kiro CLI、Auggie、ZCode、fx、Muse Code「sessions cannot drop turns」。**与表格可能的出入**：Hermes、Muse 协议层明明有 fork——Todos 文档表明工作台侧按重开实现（可能因为 fork 语义是「整会话复制」而非「截到某点重试」）。Claude Code 的回退在 Todos 里表现为「rewindFiles 恢复文件 + 会话照常继续」（SDK 的文件检查点本来就不回退 transcript），严格说不属于截断也不属于分叉。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)、[code.claude.com file-checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)。

### 3.3 平台压缩

含义是「CLI 自己做上下文压缩，且工作台能设阈值/看到事件」，而非「压缩能力是否存在」（每家 CLI 都有自己的压缩）。

- Todos 声称可按平台阈值设的：Claude Code（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`）、Codex（`-c model_auto_compact_token_limit`）、Grok Build（`config.toml` `[session] auto_compact_threshold_percent`）、dsh（窗口探明后）、Devin（`agent.compaction_threshold_tokens`，需 CLI ≥3000.10.21）、fx（`FX_AUTO_COMPACT_PERCENT`，上限 fx 自己的 80%）。会向对话上报压缩事件的：Claude Code、Codex、Grok Build、dsh、Antigravity、Devin；`Compact now` 手动压缩在 dsh（`/compact` 经 `dsh --profile sdk`）、Antigravity（`/compact` on resumed conversation）、Devin 上可用，**且不重新测量上下文**。其余运行时「compact unseen，无手动压缩入口」。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。
- 一手佐证：Claude SDK 自动压缩 + `compact_boundary` 事件（[agent-loop docs](https://code.claude.com/docs/en/agent-sdk/agent-loop)）；Codex `thread/compact`（[PR #10445](https://github.com/openai/codex/pull/10445)）；Grok Build 文档含 `[session]` 配置（[docs.x.ai](https://docs.x.ai/build/cli/headless-scripting)）；Cline `--compaction agentic|basic|off`（[apps/cli README](https://github.com/cline/cline/blob/main/apps/cli/README.md)）；Muse `session/compact`（[MSP methods](https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/methods/)）。ACP 侧有 `compaction_update`/`usage_update` 标准通知（[prompt-turn.md](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)）。

## 4. 自建多 Agent 工作台的坑（从一手资料归纳）

1. **会话隔离比协议选择更费工**：Todos 给每个会话发一个 `~/.tds/<runtime>-home` 独立 home（Codex 的 `~/.tds/codex-home` 只软链 `auth.json`，Qwen 只带 `settings.json` 的登录部分且仅回合内有效，fx 是例外——它拒绝跟随链接，只能共享 `~/.fx`）。用户级配置/技能/MCP/记忆一律不带入，否则 agent 会把主人的个人配置带去任何一台团队机器。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。
2. **无审批环境是默认前提**：机器那头没有人点头，所以每家都要选「全自动档」并关掉 agent 自带的提问/计划/定时类工具——Amp `--dangerously-allow-all`、Kiro `--trust-all-tools`、ZCode `yolo`、fx `FX_PERMISSION_MODE=full-access`、Muse `allowAll + --disable-sandbox`、Droid Auto (High) 自治级、Hermes 关命令审批；OpenCode/Qwen/Droid 自己的 ask/question 工具、Qwen 的 plan mode/monitors/worktree 切换、Amp 的 `handoff`、Claude/Qoder 的后台任务与定时唤醒都要禁用（回合结束进程退出，遗留后台任务会死）。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。
3. **插话要按传输分两路设计**：SDK/RPC 侧有原生 steer；ACP 侧只能 cancel+重发或依赖实现的排队行为，而且 ACP 规范只说回合结束后才能发下一个 `session/prompt`——把「回合中插话」当作协议能力来设计会踩空，实测名单只能逐家积累。来源：[prompt-turn.md](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)、[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。
4. **回退三态不绑定传输**：截断取决于该 CLI 的会话日志能否被截尾重写（Gemini 影子 git+会话一起回退是可借鉴的形态），分叉取决于 fork 原语是否存在（SDK `forkSession` / Codex `thread/fork` / omp `fork` / Droid fork / MSP `session/fork` / ACP unstable `session/fork`），其余只能重开会话并带摘要续命（Todos 对换运行时/换机器的处理：新会话带对话摘要开场）。**流式 headless 组几乎全落在重开档**（Qoder 例外）。来源：§3.2 各引文。
5. **同一 CLI 可能有多个自动化协议，且会漂移**：Copilot 同时有私有 `--headless --stdio` JSON-RPC 和 `--acp`（两套方法词表）；Droid `stream-jsonrpc` 之外还有 `--output-format acp`；`cursor-agent` 也有 `acp` 子命令；omp 同时有 RPC 和 `omp acp` 两个自动化入口；Copilot CLI v0.0.410 曾悄悄砍掉 `--headless --stdio` 导致官方 SDK 全版本瘫痪——**锁定 CLI 版本、禁用自动升级是托管方的生存前提**（Todos 对 fx 也专门 `FX_AUTO_UPGRADE=0`）。来源：[github/copilot-sdk #530](https://github.com/github/copilot-sdk/issues/530)、[docs.factory.com/droid-exec](https://docs.factory.com/droid-exec/overview)、[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。
6. **指令注入各显神通**：系统提示注入没有统一口——Codex 是 developer instructions，Claude/Qoder/Copilot/omp/Droid 追加在预设提示后，Cursor/Devin/OpenClaw/Amp 协议完全不吃系统提示（指令得放在首条消息、变更时重发），Antigravity/Gemini/OpenCode/Qwen/Cline 走全局规则文件（`GEMINI.md`/`AGENTS.md`/`QWEN.md`/rules 目录），dsh 走 persona 配置补丁，Hermes 走 `SOUL.md`，Kiro 走自定义 agent `tds` 的 prompt，fx 走会话 system prompt（会话固定后变更的指令只能塞下一条消息）。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。
7. **事件流归一化差异大**：Amp stream-json 发完整消息而非 token 增量；Antigravity headless 不输出 thinking、模型名带档位；Gemini/Qwen/Cline 没有可选思考档；OpenClaw 桥接完全不报 token 用量；fx 不统计子 agent token；`mcp__tds__*` 工具名前缀每家拼法不同（Copilot `tds-`、OpenCode `tds_`、Cline `tds__`、Droid `tds___` 且藏在 tool search 后）；Gemini 会隐藏名为 `ask_user` 的工具（Todos 被迫改名 `ask_the_user`）；Cline/dsh 的 ACP 只收文本，图片要落成文件让 agent 自己读。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。
8. **会话存储位置决定镜像/迁移策略**：Amp 线程存 ampcode.com（换同账号机器可续）、OpenClaw 会话只在 Gateway 本机（换机必重开）、fx 会话混在用户自己的 `~/.fx/sessions` 里、ZCode/Muse 靠数据目录隔离。跨机调度的工作台必须逐家决定「镜像会话文件 vs 摘要重开」。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。
9. **签名的坑**：登录态复用但配置不复用；keyring 不在的机器（WSL/无头 Linux）各家行为不同（agy 落 token 文件、Amp 必须 `AMP_API_KEY`）；环境变量 token 优先级各家不同（Copilot `COPILOT_GITHUB_TOKEN>GH_TOKEN>GITHUB_TOKEN>copilot login>gh auth`，dsh 是 `DEEPSEEK_API_KEY` 优先于 CLI 自存 key）。来源：[todos.dev/docs/runtimes](https://todos.dev/docs/runtimes)。

## 5. 表格与一手资料的对照结论

**成立**：四类传输的归类与每家的启动入口全部被一手资料证实（`claude` SDK、`codex app-server`、Copilot headless stdio、omp `--mode rpc`、`droid exec` stream-jsonrpc、`muse serve` MSP、12 个 ACP 入口、5 个 stream-json headless）。能力列的方向也成立：SDK/私有 RPC 档的插话与分叉能力最强，ACP 规范本身无插话无回退（fork 仅为 unstable RFD），stream-json 基本是重开档。

**需注意/有出入的点**：

- **Amp 与 Qoder 是 stream-json 组的两个例外**：Amp 的 `--stream-json-input` 协议原生有 `steer` 字段（Todos 用法未启用）；Qoder 的会话 Todos 声称可随代码截断回退——若 X 表格把这两者按组归入「无插话/重开」则与官方能力不符（表格为图片无法逐格核对，此处按 Todos 文档记录）。
- **Muse/Hermes 协议层有 `session/fork` 但 Todos 按「重开」实现**——能力列标「重开」时容易误读为「协议不支持」。
- **Kiro 默认引擎版本**：Todos 文档称用「默认 v2 引擎」，Kiro 官方文档称 3.0+ 默认起 v3（除非带 V2-only flag 或客户端被识别为需 V2）——细节冲突，以 Kiro 文档为准。
- **omp RPC 不是 JSON-RPC**：官方 rpc.md 明确「This is a custom JSONL protocol, not JSON-RPC 2.0」，表格若标注「私有 RPC（JSON-RPC）」对 omp 不准确（是私有行协议）；Codex app-server 虽名义 JSON-RPC 2.0 但线上省略 `jsonrpc` 字段。
- **回合中插话的 ACP 逐家行为**（OpenCode 文本可入回合、Qwen/Droid 工具调用边界收件、其余排队）目前只有 Todos 文档逐家声称，未见各厂商官方文档逐一证实——作为「未独立复测」记录。

## 6. 参考来源汇总

- Todos：[官网](https://todos.dev/) · [External runtimes](https://todos.dev/docs/runtimes) · [对话（插话/倒回）](https://todos.dev/zh/docs/conversation) · [MCP](https://todos.dev/docs/mcp) · [X 原帖](https://x.com/supezen/status/2122953944280551914)
- Claude：[Agent SDK TS 参考](https://code.claude.com/docs/en/agent-sdk/typescript) · [streaming-vs-single-mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) · [file-checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing) · [agent-loop](https://code.claude.com/docs/en/agent-sdk/agent-loop) · [sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- Codex：[app-server 文档](https://learn.chatgpt.com/docs/app-server) · [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) · [turn/steer PR](https://github.com/openai/codex/commit/0d8b2b74c46aeb7c691fcaf96156ed7927ee1d16) · [thread/compact PR](https://github.com/openai/codex/pull/10445) · [OpenAI 博客](https://openai.com/index/unlocking-the-codex-harness/)
- Copilot：[SDK backend-services](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/backend-services) · [SDK 兼容性](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility) · [setup path](https://github.com/github/copilot-sdk/blob/main/docs/setup/choosing-a-setup-path.md) · [ACP server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) · [issue #530](https://github.com/github/copilot-sdk/issues/530)
- omp：[docs/rpc.md](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md) · [omp.sh](https://omp.sh/) · [SDK 文档](https://omp.sh/docs/sdk)
- Droid：[droid-exec](https://docs.factory.com/droid-exec/overview) · [cli-reference](https://docs.factory.com/droid-cli/cli-reference) · [TS SDK](https://docs.factory.com/sdk/typescript) · [droid-sdk repo](https://github.com/Factory-AI/droid-sdk-typescript)
- Muse：[muse-code docs](https://dev.meta.ai/docs/muse-code) · [muse-code-sdk](https://github.com/meta-models/muse-code-sdk) · [MSP concepts](https://meta-models.github.io/muse-code-sdk/next/guides/msp-concepts/) · [framing](https://meta-models.github.io/muse-code-sdk/next/guides/msp-wire/framing-and-caps/) · [queue/steer](https://meta-models.github.io/muse-code-sdk/1.4/cookbook/queue-steer-and-reclaim-turns/) · [methods](https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/methods/)
- ACP：[schema](https://agentclientprotocol.com/protocol/schema) · [prompt-turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md) · [session-fork RFD](https://agentclientprotocol.com/rfds/session-fork) · [v2 required-session-methods RFD](https://agentclientprotocol.com/rfds/v2/required-session-methods) · [registry](https://agentclientprotocol.com/get-started/registry)
- ACP agents：[grok-build](https://github.com/xai-org/grok-build) · [docs.x.ai headless](https://docs.x.ai/build/cli/headless-scripting) · [qwen-code-docs](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/) · [opencode acp](https://opencode.ai/docs/cli/acp/) · [devin acp](https://docs.devin.ai/cli/reference/commands) · [fx acp](https://fx.sh/docs/using-fx/acp) · [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) · [gemini --acp](https://geminicli.com/docs/cli/acp-mode/) · [cline --acp](https://docs.cline.bot/usage/acp) · [hermes acp](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration) · [kiro-cli acp](https://kiro.dev/docs/cli/acp/) · [auggie --acp](https://docs.augmentcode.com/cli/acp/agent) · [openclaw acp](https://docs.openclaw.ai/cli/acp)
- stream-json：[antigravity headless](https://www.antigravity.google/docs/cli/headless/) · [agy 协议社区记录](https://github.com/2BAB/antigravity-protocol/blob/main/docs/stream-json.md) · [cursor headless](https://cursor.com/docs/cli/headless) · [qoder headless](https://docs.qoder.com/cli/run-in-scripts.md) · [amp streaming-json](https://ampcode.com/docs/cli/streaming-json) · [amp execute-mode](https://ampcode.com/docs/cli/execute-mode) · [ZCode 源码](https://github.com/zai-org/ZCode) · [zcode HEADLESS.md](https://cdn.jsdelivr.net/npm/zcode-app-cli@3.17.2-45/docs/HEADLESS.md)
- Gemini 检查点：[checkpointing](https://geminicli.com/docs/cli/checkpointing.md) · [rewind](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/rewind.md) · [session-management](https://geminicli.com/docs/cli/session-management/)
