# 工作流（预设工作流）

工作流把 **1–N 个机器人角色**、**技能**和**约束**编排成固定的步骤，像技能一样拿来就能跑。

- 入口：顶栏「工作流」（和 聊天 / 长期任务 / 技能 并列）。
- 在聊天里：对任何机器人说「运行调研报告工作流，主题是…」或输入 `/工作流 代码审查`，机器人会调用 `run_workflow` 并把运行页链接发给你。
- 在长期任务 / 定时任务里：任务的指令写「运行每日简报工作流」即可（这些回合同样有 `run_workflow`）。

## 为什么是独立的顶栏标签，而不是放在「技能」里

技能是**一段指令**（用 `/` 带进一次对话）；工作流是**一个可运行的程序**：有参数表单、多个机器人、运行记录、审批和进度。它需要「库 → 运行 → 运行页」这一整套页面，塞进技能页会让技能页同时承担两种完全不同的东西。所以单独一个标签，文件格式和用法则刻意和技能保持一致（可导入 / 导出 / 复制）。

## 文件格式：WORKFLOW.md

YAML 前言放完整定义，正文是给人看的说明。导入、导出、预设都是这个格式（`format: chisabot.workflow/v1`）。结构的权威定义在 `shared/workflows.ts`（zod，服务器和网页共用）。

```yaml
---
format: chisabot.workflow/v1
slug: code-review # 小写字母、数字、连字符
name: 代码审查
description: 一句话说明
icon: 🧑‍💻
bots: # 角色，1–8 个；运行时每个角色交给一个机器人（可重复）
  - key: security
    name: 安全审查员
    description: 职责
    botId: optional-default-bot-id
skills: # 内置技能（跟着文件走），步骤也可以引用「技能」页里的技能 slug
  - slug: review-format
    title: 审查意见格式
    instructions: |-
      ……
inputs: # 运行时填的参数：text / textarea / number / select / boolean / url
  - key: code
    label: 代码或 diff
    type: textarea
    required: true
steps:
  - id: security
    name: 安全审查
    bot: security # 角色 key
    group: review # 相邻且 group 相同的步骤并行
    handoff: none # previous（默认）/ all / none：前面步骤的输出怎么带进来
    skills: [review-format]
    approval: false # true = 这一步开始前要人批准
    approvalNote: 给审批人看的话
    panel: false # true = 这一步可以把面板直接存进机器人的右栏
    tools: { allow: [...], deny: [...] } # 只对这一步生效
    output: markdown # markdown / text / json
    prompt: |-
      审查 {{inputs.code}}，参考 {{steps.其他步骤}}
constraints:
  maxSteps: 3 # 最多执行几个步骤（每步 = 一个机器人回合）
  maxTokens: 60000 # token 预算（估算，见下）
  timeLimitMinutes: 15 # 整个运行的时间上限（不含等待审批）
  stepTimeoutMinutes: 4 # 单步上限（1–5）
  tools:
    deny: [computer, devices, host, apps, memory, schedule, handoff]
  output:
    format: markdown
    maxChars: 20000
    instructions: 先给表格，再给结论。
---

# 正文说明（Markdown）
```

工具分组：`computer`（云端浏览器 computer_*）、`devices`（device_*）、`host`（host_*）、`apps`（插件 / MCP）、`memory`、`schedule`（lifecycle 提醒）、`ui`（render_ui、组件、面板工具）、`handoff`（message_bot）。也可以写具体工具名。

## 运行怎么执行（复用了什么）

不是新的智能体引擎。**每个步骤 = 某个机器人在一个新对话里跑一个无头回合**，用的就是定时任务、长期任务、面板任务在用的 `governedTurnRunner`（`server/src/turns/run-turn.ts`）：同样的机器人解析、模型连接、授权检查、工具、审计、暂停检查。工作流执行器（`server/src/workflows/engine.ts`）只做编排：

1. 校验参数和每个角色的机器人（必须是你能用的机器人）。
2. 按阶段推进；并行组里的步骤同时跑（每步自己的对话，所以不会抢同一个线程锁）。
3. 每步的提示 = 角色 + 当前时间 + 要求（模板替换）+ 参数 + 技能全文 + 前面步骤的输出 + 约束说明。
4. 步骤结束后把它的对话**软删除**，不会出现在任何人的会话里；产出存在运行记录里。
5. 进度（流式文字、token、用时）每 1.2 秒写一次库，运行页每 1.5 秒刷新。

没有用机器人互相 `message_bot` 的交接链来实现：那是模型自己决定找谁、什么时候停，无法保证步骤顺序，也没法在步骤之间卡预算、卡时间、等人批准。

## 约束（服务器强制）

| 约束            | 怎么执行                                                                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最多步骤数      | 每个阶段开始前检查已执行步数，超出即失败                                                                                                                                                                                                                                           |
| Token 预算      | 估算（中日韩字符 1 个 = 1 token，其他每 4 字符 1 token；包含提示和输出，不含工具调用内容）。每步开始前检查；流式输出时实时累计，超出立即中止这个回合                                                                                                                               |
| 时间上限        | 整个运行一个计时器（等待审批时暂停计时），超时中止当前回合                                                                                                                                                                                                                         |
| 单步时间上限    | 每步一个计时器，超时中止                                                                                                                                                                                                                                                           |
| 工具允许 / 禁止 | 步骤回合的发起者是 `{ kind: "workflow", id: "<运行>/<步骤>" }`；装工具时（`loadToolsForActor`、找别的机器人、面板工具、无头的 computer_* 和组件）按规则过滤，被禁止的工具不出现在模型面前；执行时再复核一次，硬调会被拒绝并记审计。工作流步骤永远拿不到 `run_workflow`（不能套娃） |
| 人工审批        | 步骤 `approval: true` 时，运行停在 `waiting_approval`，运行页显示「批准并继续 / 拒绝」；批准后从这一步继续，拒绝则运行结束                                                                                                                                                         |
| 输出格式        | `json`：从回复里提取 JSON，失败就让机器人修正一次，仍失败则运行失败；`maxChars`：超出截断并记录                                                                                                                                                                                    |

审计：运行内的事件写在 `workflow_run_events`（运行页「运行记录」）；开始、结束、审批决定、约束拦截另外写进全局审计（`workflow.run_started` / `workflow.run_finished` / `workflow.approval_decided` / `workflow.constraint_blocked`，发起者 `workflow`）。工作流的增删改记 `configuration.changed`。

限制：一个人同时最多运行 3 个工作流；步骤里如果调用了需要「工具审批」的能力（例如设备设为「每次询问」），回合会挂起，工作流不等待工具审批，这一步记为失败并提示原因。服务器重启时正在跑的运行会标成失败（等待审批的不受影响）。

## 接口

`/api/workflows`（需要登录，只看得到预设、自己的工作流和自己的运行）：

| 方法               | 路径                    | 说明                                                  |
| ------------------ | ----------------------- | ----------------------------------------------------- |
| GET                | `/`                     | 预设、我的工作流、最近 12 次运行                      |
| GET / PUT / DELETE | `/:id`                  | 详情（含 WORKFLOW.md）/ 保存 / 删除（预设只读）       |
| POST               | `/`                     | 新建（`{ definition }`）                              |
| POST               | `/import`               | 导入（`{ markdown }`）                                |
| POST               | `/validate`             | 校验并生成 WORKFLOW.md                                |
| GET                | `/:id/export`           | 下载 `<slug>.workflow.md`                             |
| POST               | `/:id/duplicate`        | 复制为我的工作流                                      |
| POST               | `/:id/runs`             | 运行（`{ inputs, bindings: { 角色key: 机器人id } }`） |
| GET                | `/runs`、`/runs/:runId` | 运行列表 / 运行详情（含事件）                         |
| POST               | `/runs/:runId/approve`  | `{ stepId, decision: "approve"                        | "reject", comment? }` |
| POST               | `/runs/:runId/cancel`   | 停止                                                  |
| DELETE             | `/runs/:runId`          | 删除运行记录（会先停止）                              |

## 预设

`server/src/workflows/presets/*.md`，启动时读取并校验：

- **调研报告**：研究员（可用云端浏览器）→ 撰稿人 → 审校。
- **代码审查**：安全审查 ∥ 质量审查（并行）→ 主审汇总；禁止所有工具。
- **每日简报**：资讯员 → 编辑。
- **网页→面板**：网页阅读员 → （需审批）面板设计师把数据存成右栏面板。

只有一个机器人也能跑：运行时把所有角色都交给它。

## 自检（不污染对话）

单元测试：`cd server && bun test tests/workflows.test.ts`（预设解析、往返、约束、审批、并行、取消）。

线上端到端：用管理员会话调 `POST /api/workflows/preset:code-review/runs`，等运行结束后 `DELETE /api/workflows/runs/<id>`。步骤对话在每步结束时已软删除，运行记录删除后不留痕迹。
