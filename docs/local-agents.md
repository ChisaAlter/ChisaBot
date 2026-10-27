# 本地 agent 与权限档位

> 2026-10-15。界面见 DESIGN.md §66；决定见 ADR-0010。代码：`shared/local-agents.ts`（共享定义）、`server/src/local-agents/service.ts`（服务器）、`pc/src/agent-runtime/`（电脑端运行时，PC 客户端和无界面节点共用）、`app/src/components/chat/local-agent-card.tsx`（任务卡片）、`app/src/components/local-agents/device-agents-panel.tsx`（设置页）。

## 1. 两条路，默认不变

| | 云端 agent 控制电脑（默认） | 本地 agent |
| --- | --- | --- |
| 谁在想 | 服务器上的机器人（你给它配的模型） | 电脑上的 agent：Claude Code / Codex CLI / OpenCode / Gemini CLI / Aider，或 ChisaBot 内置循环 |
| 怎么动手 | 每一步一个 `device_*` 工具调用，经 WebSocket 发到电脑执行（docs/pc-node.md） | agent 在电脑上自己读写文件、跑命令；服务器只收进度 |
| 电脑上要装什么 | 只要 ChisaBot PC / 无界面节点 | 再加上想用的 CLI agent（内置循环不用装） |
| 适合 | 零散操作、看看文件、点点鼠标、截图 | 一整件编码活儿（修 bug、跑测试、重构），或指定「用 Claude Code」 |
| 进度 | 聊天里的工具调用 | 聊天里的任务卡片（实时输出、停止、改动、应用改动） |

用户问「本地不装 agent，让云端的 agent 控制本地也可以吧？」——可以，而且这就是默认路径：什么都不装，机器人照样用 `device_*` 操作电脑。本地 agent 是加法：当你想让 Claude Code 这类专门的编程 agent（用它自己的账号）在你的电脑上干一整件活儿时才用。

## 2. 权限档位（每台设备一个，任务可以更严）

| 档位 | 档位之内（按能力开关执行） | 档位之外（能力是「允许」也要你批准） |
| --- | --- | --- |
| **只读** | 读文件、列目录、搜索、截图、系统信息、git 状态 / diff / log | 改文件、运行命令、鼠标键盘、打开程序、写剪贴板 |
| **工作区**（默认） | 上面这些 + 在工作区文件夹里写文件、工作目录在工作区里的命令、打开网址、写剪贴板 | 工作区外的写入和命令、鼠标键盘、打开文件 |
| **完全访问**（= 设备的完全访问开关，有时限） | 一切（ADR-0009：能力按「允许」、不弹审批；仍审计、紧急停止立即关闭） | — |

- 档位**只收紧**：它挂在设备 hub 上（`DeviceHubExtension.gate`），能力是「允许」的操作若在档位之外就改成「询问」，走原来的审批（PC 弹窗 + 网页 / 手机「等待你审批」卡片 + 本地 agent 卡片里的「允许 / 拒绝」），审批摘要写明原因（「要改的文件不在工作区文件夹里，档位「工作区」」）。「关闭」的能力仍然关闭，「询问」仍然询问。
- **只有用户能改档位**：设置 → 设备 → 某台电脑 → 本地 agent。机器人没有改档位、改文件夹的工具；`device_agent_run` 的 `profile` 参数只能比设备的档位更严（`narrowerProfile`）。
- 工作区文件夹：没单独设置时沿用设备的「允许的文件夹」。
- **「完全访问」档位就是 docs/pc-node.md §13 的完全访问开关**（ADR-0009：1 小时 / 24 小时 / 永久，只能由你在网页上打开，PC 上再确认一次，紧急停止立即关闭）。本地 agent 页把那张开关卡片嵌在档位下面，点「完全访问」档位就滚到它。这里存的档位只有「只读 / 工作区」两种；完全访问开着时实际档位 = 完全访问（所有能力按「允许」、不额外收紧、本地 agent 任务不再要批准、CLI agent 可以跳过它自己的逐条确认），到期 / 关闭后回到存的档位。接口 `PUT /api/local-agents/devices/:id` 传 `profile: "full"` 会被拒绝（400，提示去「权限」里打开）。
- 未知的设备操作（以后新加的）按最严处理：名字明显是只读的（`*_read/list/search/status/log/diff`）算之内，其余在只读和工作区里算之外。
- 服务器按字面路径判断（规整 `.` / `..`，Windows 不区分大小写）；电脑上内置 agent 再按真实路径（解析符号链接）判一次。

## 3. 检测

电脑连上服务器时（`hello` 之后）服务器发 `agent_detect`，电脑跑一遍 `--version`（每个最多 6 秒）回 `agents_detected`：
- agent：`claude` / `codex` / `opencode` / `gemini` / `aider`（PATH + `~/.local/bin`、`~/.npm-global/bin`、`%APPDATA%\npm` 等常见位置），内置循环始终可用。
- 沙盒：git（worktree）、副本（始终）、Linux bubblewrap（真的跑一次 `bwrap … true`，容器里没有 user namespace 时算不可用）、macOS `sandbox-exec`、Docker / Podman（`info` 能通）、Windows 的 WSL（`wsl --status`）和 Windows 沙盒（只检测，不自动用）。
- 是否以 root 运行（Claude Code 跳过确认需要 `IS_SANDBOX=1`）。

设置页「重新检测」随时再跑。结果存在 `chisabot_device_agent_settings.detected`。

## 4. 隔离方式（任务的工作目录）

| 方式 | 做法 | 改动什么时候生效 |
| --- | --- | --- |
| `worktree`（默认） | `git stash create` 拍下未提交的已跟踪改动，`git worktree add --detach` 到临时目录 | 你在卡片上点「应用改动」：`git apply --check` 通过后 `git apply` 到原仓库；「放弃」删掉 worktree |
| `copy` | 不是 git 仓库时 worktree 自动退成它；复制文件夹（上限 6 万个文件 / 800 MB） | 同上（补丁应用到原文件夹） |
| `none` | 直接在原文件夹里做（只读档位下只给有只读模式的 agent） | 立即 |
| `bwrap` | Linux：整个系统只读挂载，只有工作目录和 agent 自己的配置目录（`~/.claude` `~/.codex` …）可写，`--unshare-net` 断网 | 立即（写在工作目录里） |
| `sandbox-exec` | macOS：`(deny file-write*)` 只放行工作目录、临时目录和 agent 配置目录，可 `(deny network*)` | 立即 |
| `docker` / `podman` | 只给内置 agent：每条命令在一次性容器里跑（只挂载工作目录，`--network none`，镜像可配，默认 `debian:bookworm-slim`） | 立即 |
| `wsl` | Windows：在 WSL 里运行（agent 要装在 WSL 里） | 立即 |

改动统计：电脑在临时目录里建一个独立的 `GIT_DIR` 给工作树拍快照（不碰用户自己的 `.git` 和暂存区），结束时 `git diff --numstat` 得到文件列表和 +/-，补丁预览最多 24 KB 回到卡片。没有 git 的电脑不统计改动（卡片如实说）。临时目录三天后自动清理；电脑上的客户端重启后，还没应用的副本仍在临时目录里，但卡片上不能再一键应用（如实提示）。

## 5. CLI agent 怎么跑

| agent | 命令 | 档位映射 |
| --- | --- | --- |
| Claude Code | `claude -p <指令> --output-format stream-json --verbose` | 只读 → `--permission-mode plan`；工作区 → `--permission-mode acceptEdits`（改文件直接做，没预先允许的命令会被它拒绝并说明）；完全访问或系统级沙盒（bwrap / sandbox-exec）里 → `--dangerously-skip-permissions`，root 时加 `IS_SANDBOX=1`（ChisaCloudCode 2026-10-14 踩过：root 下不加它直接拒绝） |
| Codex CLI | `codex exec --json --skip-git-repo-check -C <目录> <指令>` | 只读 → `--sandbox read-only`；工作区 → `--sandbox workspace-write`（联网开关映射 `sandbox_workspace_write.network_access`）；完全访问 → `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode / Gemini CLI / Aider | `opencode run` / `gemini -p`（完全访问加 `--yolo`）/ `aider --message … --yes-always --no-auto-commits` | 没有可靠的只读模式：只在完全访问、一次性副本或系统级沙盒里交给它们 |

- 用的是 agent **自己登录的账号**（Claude Pro / API key / ChatGPT 账号），ChisaBot 不碰它们的凭据。
- 输出解析：Claude 的 stream-json（文字、工具调用「修改 a.ts」「运行 npm test」、结束时轮数和费用）、Codex 的 JSONL（新旧两种格式都认），其余按行。stderr 前 200 行也进卡片（黄色）。
- Windows 上 npm 装的 `.cmd` 要经过 cmd.exe：Claude / Codex 的指令走标准输入，其余去掉 cmd 特殊字符后走参数。
- 断网：CLI agent 要联网访问它自己的模型服务，所以断网的任务只给内置 agent（配电脑上的本地模型）。
- 超时：默认 45 分钟（`CHISABOT_LOCAL_AGENT_TIMEOUT_MS`），到点杀进程树。

## 6. ChisaBot 内置 agent（在电脑上跑的工具循环）

- 工具：`list_files` `read_file`（按行 offset/limit）`write_file` `edit_file`（唯一匹配替换）`search`（正则，跳过 .git / node_modules）`run`（Windows PowerShell，其余 sh；在 docker/podman/bwrap/sandbox-exec 里跑）。最多 40 步，每个任务最多 80 次模型调用（`CHISABOT_LOCAL_AGENT_LLM_CALLS`）。
- 模型：默认**服务器代调**——每一步电脑把对话发给服务器（`agent_llm`），服务器用这个机器人配置的模型连接（`resolveConnectionForAgent` → `connectionLanguageModel().doGenerate`）算出下一步，密钥不出服务器。也可以在设置页改成**本地模型**（OpenAI 兼容地址，如 Ollama `http://127.0.0.1:11434/v1`），对话和文件内容都不离开电脑。
- 档位之外的工具调用（只读里的写入 / 命令、工作区外的读写）先发 `agent_approval`，服务器走设备审批（卡片里「允许 / 拒绝」），拒绝就告诉模型换办法。

## 7. 一个任务的一生

1. 机器人调用 `device_agent_run({task, agent?, cwd?, profile?, isolation?, network?})`。服务器检查：电脑在线、没紧急停止、「命令行」能力不是关闭、agent 已检测到、工作目录在工作区里（完全访问除外）、隔离方式在这台电脑上可用、并发（每台电脑 2 个、每人 4 个）。不通过就返回中文原因，卡片不出现。
2. 写入 `chisabot_local_agent_tasks`，工具立刻返回 `taskId`，聊天里出现卡片。
3. 除非这台电脑开着「完全访问」，先审批（卡片里「允许 / 拒绝」、PC 弹窗、设备页，谁先点算谁，2 分钟无人处理按拒绝）。拒绝 → 任务「已停止」，对话里补一行结果。
4. 服务器发 `agent_run`；电脑准备工作目录 → 启动 agent → `agent_event` 一行行流回（服务器存最后 1500 行，卡片看最近 40 行，「查看全部」看完整记录）→ `agent_done`（摘要、退出码、改动）。
5. 结果作为一条以 `⟦chisabot:local-agent-result:<id>:<状态>⟧` 开头的消息回到原对话（同后台任务 §38.2：对话正在回答就进收件箱，否则起一轮无头回合让机器人用一两句话总结）。
6. 改动在一次性副本里时，卡片上「应用改动 / 放弃」（`agent_apply` / `agent_discard`，结果 `agent_applied`），设备审计记一行。
7. 停止：卡片「停止」或机器人 `device_agent_stop` → `agent_stop`，电脑杀进程树、丢掉副本。紧急停止（任一端）同样立即停掉所有本地 agent 任务；紧急停止中不能启动新任务。
8. 服务重启：没跑完的任务标成失败并写明原因。

设备审计（设置 → 设备 → 操作记录）：交出任务（`local_agent_task`）、结束（`local_agent_done`）、应用 / 放弃改动、改档位（`agent_profile_changed`）。

## 8. 协议（同一条设备 WebSocket，hub 把不认识的消息交给本地 agent 服务）

服务器 → 电脑：`agent_detect`、`agent_run{taskId, agent, prompt, cwd, profile, isolation, network, roots, skipPermissions, builtinModel, containerImage, timeoutMs}`、`agent_stop`、`agent_apply`、`agent_discard`、`agent_llm_result{reqId, ok, content|error}`、`agent_approval_result{reqId, approved}`。

电脑 → 服务器：`agents_detected{detection}`、`agent_started`、`agent_event{taskId, kind: text|tool|status|stderr|approval, text, step?}`、`agent_done{ok, exitCode, summary, diff, error?, stopped?}`、`agent_applied{ok, discarded?, error?}`、`agent_llm{reqId, messages, system}`、`agent_approval{reqId, operation, summary}`。

服务器只认「这台设备自己的任务」的消息；旧客户端不认识这些消息会忽略（设置页显示「还没检测过」，`device_agent_run` 照样可用但会因没有运行时而超时——请升级到带本地 agent 的客户端）。断线期间电脑把要发的消息存着（最多 2000 条），重连后补发。

## 9. 接口

`/api/local-agents`（需登录，只看自己的设备 / 任务）：`GET|PUT /devices/:id`（设置 + 检测结果 + 最近任务）、`POST /devices/:id/detect`、`GET /threads/:threadId/tasks`、`GET /tasks/:id`（完整记录）、`POST /tasks/:id/stop|apply|discard`。审批沿用 `POST /api/devices/approvals/:id`。

## 10. ChisaBot 服务器 agent vs Claude Code / Codex（老实说）

ChisaBot 的服务器 agent 来自 CopilotKit ChisaBot：**AG-UI 协议 + AI SDK 的通用工具循环**，强项是生成式界面（卡片、表单、页面）、审批与审计、定时任务、记忆 / 技能、MCP 和各种连接、IM 渠道、多机器人——它是个「私人助理 + 平台」。它**不是**专门的编程循环：没有针对大仓库的上下文管理（自动摘要、按需检索代码、文件树快照），编辑工具是通用的文件读写 / 补丁，没有专门调过的「改代码 → 跑测试 → 再改」提示词和工具集，也不会像 Claude Code 那样维护待办清单、自动压缩长会话。用户自己配的模型也决定上限。

Claude Code 和 Codex CLI 是**专门为写代码调过的 agent**：模型（Claude / GPT-5 系列）和工具、提示词一起优化，长时间在一个仓库里工作很稳，权限模式和沙盒也是为改代码设计的；代价是要装在电脑上、用它们自己的账号和额度，也没有 ChisaBot 的界面、记忆和渠道。

所以分工是：日常和跨应用的事、要在聊天里看见卡片和审批的事 → 服务器 agent（默认，`device_*`）；一整件编码活儿 → 交给电脑上的 Claude Code / Codex（`device_agent_run`），ChisaBot 负责下达、权限、进度、改动审阅和把结果带回对话。内置循环介于两者之间：在电脑上低延迟地跑同一套简单工具，可以用本地模型做私密 / 离线的小活儿，但编码能力不如前两者。

## 11. 已知限制

- Claude Code 在「工作区」档位下没有预先允许的命令会被它自己拒绝（`-p` 模式不能弹交互确认）；要它自由跑命令，用 bubblewrap / macOS 沙盒，或完全访问。把 Claude 的逐条权限请求转成 ChisaBot 审批卡片（`--permission-prompt-tool` + MCP）还没做。
- Windows 沙盒（Windows Sandbox）只检测不使用；Windows 上真正的隔离目前是 worktree / 副本 / WSL。
- 容器隔离只给内置 agent（CLI agent 的登录在容器里拿不到）。
- 断网只有系统级沙盒做得到；worktree / 副本不隔离网络和磁盘（它们是「一次性副本」，不是安全沙盒），所以在它们里面 Claude Code 不会跳过确认。
- 客户端重启后未应用的副本不能再从卡片应用（文件还在 `临时目录/chisabot-agent/`，三天后清理）。
- 真实 Windows / macOS 上的 CLI agent、bwrap、sandbox-exec、WSL 还没有真机跑过；e2e 用的是 Linux 容器里的无界面节点 + 模拟的 Claude Code CLI + 真实模型的内置 agent。
