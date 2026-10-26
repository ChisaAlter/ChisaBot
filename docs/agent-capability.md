# 机器人「只会说、不会做」的能力审计

日期：2026-10-21 · 版本：v0.1.51 · 现场：星灵被要求去接腾讯 ima，连续三轮只解释、不调用工具。

这份文档回答两件事：**为什么它不动手**，以及**能不能换掉 agent 内核**。结论都有本机 Magpie 上的复现数据，不是猜测。

## 0. 结论

不是模型不会用工具。同一个 `codex/gpt-6-luna`，同一条 v0.1.51 提示词，在 Magpie 的 `/v1/chat/completions` 上：

- 给一个 `get_weather` 工具，问上海天气 → `finish_reason: tool_calls`，参数 `{"city":"Shanghai"}`。
- 给 26 个工具、问「去连腾讯 ima」→ 会调用工具，但 4 次里只有 1 次选 `web_search`；另外几次选 `device_list`、`connector_call`。它**动了，但拿错了工具**。
- 同一组 26 个工具里加上 `connect_service` → 4/4 都选 `connect_service`。

所以根因是分层的，按影响排序：

1. **意图没有对口的工具。** 「连接一个服务」在工具列表里没有对应动作，模型只能拿 `web_search`（描述只说查事实/新闻/天气）或近邻工具凑。
2. **工具过载，而且默认不收窄。** 一个普通机器人一轮拿到 20 个以上工具（接了电脑会到 40 左右）。仓库自己的设计写着「超过 10–15 个，模型开始选错或干脆不选」，但 `plugins/selection.ts` 的收窄只在「机器人有技能、且技能声明了工具」时才启动；新部署没有任何技能，等于从不收窄。
3. **提示词没有行动契约。** `PROVENANCE_GUIDANCE` 反复说「不要为了找来源去搜网」「搜不到就标明未核实」，本意是防止死循环，但模型把这套用到了「接入方式」上：先宣布没有，再解释。它没有任何一句要求「先调用工具，再说话」。
4. **推理档位没有设置。** Magpie 的目录为 `gpt-6-luna` 公布了 `reasoning_levels`，ChisaBot 的内置循环从不发送 `reasoning_effort`。小样本里 `high` 5/5、`medium` 4/5 会调 `web_search`，`low` 0/5。没设 = 交给网关默认。
5. **内核定位不同。** 内置循环是 CopilotKit 的 `BuiltInAgent`：AG-UI + AI SDK 的通用工具循环，强在卡片、审批、记忆、MCP、渠道；它不是为长任务调过的 agent，没有待办清单、计划/复核、子 agent、代码库上下文管理。`docs/local-agents.md` §10 已经坦白写过这一点。

## 1. 复现数据

探针在 `.local-run/magpie-*.mjs`（未入库），直接打本机 Magpie `127.0.0.1:3425`，模型 `codex/gpt-6-luna`，系统提示词用 v0.1.51 的真实段落（PROVENANCE + WORK_STYLE + 身份 + WEB_GUIDANCE），用户句「我是让你想办法去连腾讯ima知识库」。

### 1.1 工具数量决定选哪个工具

| 工具数 | `web_search` 描述 | 调用工具 | 选中 `web_search` |
| --- | --- | --- | --- |
| 2 | 现行 | 3/4 | 3/4 |
| 2 | 放宽 | 4/4 | 4/4 |
| 12 | 现行 | 4/4 | 4/4 |
| 26 | 现行 | 4/4 | **1/4** |
| 26 | 放宽 | 4/4 | **4/4** |

26 个工具时，没被选中的轮次选了 `device_list` / `connector_call`。这不是「不做事」，是「拿错工具之后照实说没找到」。

### 1.2 一个对口的工具胜过放宽十个描述

| 26 个工具里 | 选择 |
| --- | --- |
| 没有 `connect_service` | `web_search` ×2、`device_list` ×2、`connector_call` ×2 |
| 加上 `connect_service` | `connect_service` ×4 |

### 1.3 推理档位有边际影响

单轮、同一提示词：

| `reasoning_effort` | 是否调 `web_search` |
| --- | --- |
| 未设置 | 不稳定：单轮出现过 0/1，也出现过 4/5、5/5 |
| `none` | 0/1 |
| `low` | 0/1 |
| `medium` | 4/5 |
| `high` | 5/5 |

温度（0 / 0.2 / 0.5 / 1 / 未设）没有稳定差异，不是主因。

### 1.4 同一句话会随机走两条路

同一条件重复跑 5 次，现行描述 + 无 effort 是 4/5 调工具，不是 0/5。**截图里的三连拒绝是真实发生的，但不能用单次结果判断根因**；能稳定区分的是「26 个工具时选不选得中 web_search」和「有没有 connect_service 可选」。

### 1.5 换模型不解决选错工具

同一组 26 个工具、同一句话，各跑 4 次：

| 模型 | 选中 `web_search` | 另外选了什么 |
| --- | --- | --- |
| `codex/gpt-6-luna`（现场用的） | 2/4 | `connector_call` |
| `codex/gpt-6-astra` | 1/4 | `device_run_shell` ×3 |
| `codex/gpt-6.1-sol` | 3/4 | `memory_search`、`device_run_shell` |

三个模型都能调用工具，差别只在「猜哪个工具对」。这说明**工具路由**比换模型更值得先做。

## 2. 现在的内核到底能做什么

| 层 | 现状 | 后果 |
| --- | --- | --- |
| 运行循环 | `BuiltInAgent`（AI SDK），`maxSteps = 12` | 能连续调工具，但没有计划、待办、复核、子 agent |
| 工具面 | 联网、记忆、页面、面板、聊天文件、保险箱、定时、GitHub、设备、生成式 UI | 一轮 20+ 个；没有「任务/连接器/工作区」这种动作 |
| 工具收窄 | 需要「有技能且技能声明了工具」 | 新部署从不收窄，模型面对全量目录 |
| 提示词 | 角色 + 来源 + 不可信内容 + 说话方式 + 身份 + 联网顺序 | 没有行动契约；「不要乱搜」反而被过度执行 |
| 模型 | 每个机器人一个模型 ID，走网关 | 不设推理档位、温度、计划模型（除非显式开） |
| 工作区 | 只有接了电脑/设备才有 `device_*` | 没有电脑时，机器人不能读写文件、跑命令、改代码 |
| 审批 | 删除/付款/发消息会问；配置类动作没有类别 | 「装一个 MCP」没有安全的写入通道 |

## 3. 换内核：已有三条路，一条要写

### 3.1 按任务交接（已经能用，推荐先走）

`device_agent_run` 把一整件活儿交给电脑上的 Claude Code / Codex CLI / OpenCode / Gemini CLI / Aider，或电脑上的 ChisaBot 内置循环。进度、停止、改动审阅在聊天卡片里，结果回到同一段对话。电脑上没装 CLI 也能用内置循环。

- 适合：修 bug、跑测试、重构、长时间编码。
- 代价：电脑要在线，本地 agent 看不到聊天上下文，机器人要写完整指令。
- 文档：`docs/local-agents.md`、ADR-0010。

### 3.2 整个机器人换成远程内核（已经支持）

租户包里把机器人声明成：

```yaml
agents:
  - id: my-agent
    name: 我的机器人
    type: remote-ag-ui          # 或 remote-mastra
    endpoint: https://...
```

远程 agent 通过 AG-UI 接话，工具仍由 ChisaBot 的签名回调下发（授权、审批、审计还在服务器上）。代价：它自带提示词和循环，ChisaBot 的角色描述是它唯一的业务指令；内置的记忆/技能/生成式界面不一定都能用。

### 3.4 把鲸屿/DSH 或 Hermes 接进来（已写桥）

DSH 和 Hermes 都能说 **ACP（Agent Client Protocol）**：

- DSH：`dsh --profile acp`（`dsh acp`）
- Hermes：`hermes acp`（需要 ACP extra）

[`examples/acp-agent/`](../examples/acp-agent/) 是一个 ACP ↔ AG-UI 桥：ChisaBot 的 `remote-ag-ui`
机器人指向它，会话 → `session/new`，一轮 → `session/prompt`，`session/update` → 文本/推理/工具事件，
`session/request_permission` 由桥回答，`stopReason` → `RUN_FINISHED` / `RUN_ERROR`。换内核只换
`ACP_AGENT_CMD`。

**全面替换**是 `CHISABOT_HERMES_URL`：设置后 `buildAgent` 在加载工具之前把所有 `built_in` 机器人
转成指向桥的 remote-ag-ui 机器人，现有的和以后新建的都走 Hermes。机器人的名字和 `system_prompt`
通过 standing role 送过去，桥在每会话第一轮作为宿主设定带给 Hermes；模型、插件工具、记忆工具不再
参与。未设置时行为不变。

本机对真 DSH 跑通了 `initialize → session/new → session/prompt`；没配 `DEEPSEEK_API_KEY` 时它返回
明确的 `RUN_ERROR`，不是挂起。**真 Hermes 也已经跑通**：Magpie 的 `codex/gpt-6-luna`，Hermes 在
ACP 会话里主动执行 `terminal(date)`，桥把 tool call/result 映射成 AG-UI，最后返回中文回答并
`RUN_FINISHED`。源码 checkout 上用 `hermes-acp` 时，桥会给它设 `HERMES_DISABLE_LAZY_INSTALLS=1`，
避免它每次启动都去补 PM 的依赖同步。

边界：

- 这条链路里 agent 用的是**它自己的工具**（shell / 文件 / 网页 / MCP / 子 agent），ChisaBot 的
  Notion / Gmail / 面板 / 记忆不在里面；要保留，需要把 ChisaBot 工具暴露成 MCP，再用
  `session/new` 的 `mcpServers` 传进去。
- ChisaBot 的审批卡覆盖不到 ACP 的 shell / 文件操作。桥默认自动 `allow_once`，必须收紧时用
  `ACP_APPROVAL=deny` 或在内核侧裁工具集（Hermes 的 `platform_toolsets.acp`、DSH 的 profile）。
- ACP session 映射在桥内存里，桥重启后重建；`session/load` 还没接。

### 3.5 重写内置循环（中等改动，保留平台）

保留 CopilotKit 的接入层，补四件事：

- **计划/待办**：一个 `plan` 工具 + 每步更新，长任务不再一口气答完。
- **工具路由**：默认技能分组（联网/记忆/文件/设备/面板/连接器），让 `selection` 在 20+ 工具时真正生效。
- **工作区**：没有电脑时也给一个受限的服务器工作区（读/写/搜索/跑测试）。
- **复核**：任务结束时对照计划检查「做了没有」，没做的写清楚。

## 4. 建议顺序

| 优先级 | 改动 | 状态 |
| --- | --- | --- |
| P0 | `web_search` 描述覆盖「外部服务怎么接入」 | 已改（本次） |
| P0 | `connect_service`：查部署连接器/授权/账号，再查官方接法 | 已加（本次） |
| P0 | 行动契约：没调用工具前不许说「我没有/需要管理员开通」 | 已合入 v0.1.52（#280） |
| P1 | 默认工具分组，让 20+ 工具时收窄 | 待做 |
| P1 | 推理档位：目录支持时默认 `medium`，可配置 | 待做 |
| P1 | 任务型请求自动建议 `device_agent_run`（有设备时） | 待做 |
| P2 | 工具合并（`panel_*`、`device_*` 各收成一个带 action 的工具） | 待做 |
| P2 | 计划/待办/复核 | 待做 |
| P3 | Hermes / DSH 内核（ACP 桥 + `CHISABOT_HERMES_URL`） | 已实现；Hermes 真机已验证 |
| P3 | 把 ChisaBot 工具暴露成 MCP，接进 ACP `mcpServers` | 待做 |

## 5. 验收指标

不要再看「回答像不像」，看这四个数：

1. **动手率**：动作类请求里，至少调用一次工具的比例（目标 > 90%）。
2. **选对率**：20+ 工具时，第一次调用选中意图对应工具的比例（目标 > 80%）。
3. **完成率**：端到端任务（接一个测试 MCP、建一个页面、在设备上跑一条命令）的成功率。
4. **代价**：每轮 token、延迟、工具步数。

探针脚本可以复用：`.local-run/magpie-rate-probe.mjs`、`magpie-toolcount-probe.mjs`、`magpie-connect-tool-probe.mjs`。
