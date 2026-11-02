# pstack 移植方案（Cursor 插件 → ChisaBot）

上游：<https://github.com/cursor/plugins/tree/main/pstack>（MIT，作者 Lauren Tan / poteto）。
本文件记录调研结论、移植矩阵和适配规则。生成器：`scripts/pstack-port.mjs`。

## 调研结论（审查版）

- pstack 是提示词资产包，不是运行时代码：58 个 SKILL.md + 23 个 playbook + 2 个 agent + 1 个 Cursor Automations 包（benny）。
- 价值密度最高的是三层结构：`poteto-mode` 路由（任务 → playbook + 按需加载原则）→ 23 个 playbook → 24 条原则叶。
- 全部 SKILL.md 中只有一个超 ChisaBot 上限：`poteto-mode`（21,670 B > 20,000 字符 instructions 上限）。
- 深度绑定 Cursor 的点：`Task` 子代理（`subagent_type`、`run_in_background`、`readonly`、`environment:"cloud"`）、worktree、`pstack-models.mdc` 模型规则文件、Bugbot、Cursor Automations、会话转录文件（`agent-transcripts/*.jsonl`）、姊妹插件 cursor-team-kit 的 `deslop`/`control-ui`/`control-cli`。
- ChisaBot 同构原语：技能懒加载（`skill_load`）、`/slug` 调用、workflow 角色绑模型 + `group` 并行 + `handoff`、审批门、工具 allow/deny（computer/apps/handoff 等组）、`github_*` 工具、`skill_save`/`skill_edit` 自我改进。
- 结论：原则与文体纪律可近原文搬；多模型编排类（arena/swarm/interrogate）在 ChisaBot 里应落成工作流预设（比上游 prompt 模拟更强：有预算、审批、运行记录）；Cursor 运行环境类（worktree 编排、automations、autopilot）不搬。

## 适配规则（生成器实现）

1. frontmatter `name` → `slug`，`description` → `summary`（≤200 截断），正文 → `instructions`；`paths:`、`disable-model-invocation` 等 ChisaBot 不识别的字段丢弃。
2. slug 超长（>40）改名，正文与所有引用里的旧名统一替换：
   - `principle-migrate-callers-then-delete-legacy-apis` → `principle-migrate-then-delete`
   - `principle-separate-before-serializing-shared-state` → `principle-separate-before-serializing`
   - `principle-test-behavior-not-implementation` → `principle-test-behavior`
3. 相对引用 `[名称](../x/SKILL.md)` → `名称（/x）`；`references/*.md` 引用移除（上游附属文件未移植）。
4. `title` 中文化，`summary`/`instructions` 保留英文原文（保真 + 模型无差别）。
5. 每条末尾加来源行。上游更新后重跑 `node scripts/pstack-port.mjs`，只重写 `>>> pstack-port` 标记区间。

## 已落地

`examples/zh-CN/skills.yaml` 受管区块，41 条（排序：改写件与核心技能在前——技能目录页默认只展示前 40 条，原则叶靠 poteto-mode 索引按 slug 加载，排最后也能被 `skill_list` 搜到）：

- **改写件**（`scripts/pstack-port/adapted/`，手工改写为 ChisaBot 语义）：
  - `poteto-mode`：主路由。Task 子代理→`message_bot`/工作流，模型规则文件→每 BOT 模型配置，worktree→computer 云端工作区，Bugbot/PR→`github_*`。原 21.7KB 压到 ~3.5KB（删模型规则细节、压缩原则索引为单行表）。
  - `how`：去掉 Task/模型行，探索改为主线程读码（github_*/computer）或 message_bot 并行。
  - `why`：MCP 七类证据分类法保留，工具面映射为 `github_*` + apps 插件 + memory；内联 epistemics 要点（measured/inferred/guess 分层、来源清单）。
  - `architect`：arena 的"多候选+评审"改为"≥2 个结构不同候选，可自做或委托异模型 BOT"；红旗表保留。
  - `pstack-pb-investigation` / `pstack-pb-bug-fix` / `pstack-pb-feature`：三个 playbook 改写为独立技能（委托→message_bot，PR→`github_*`）。
- **纯转换**：24 条原则全部 + `unslop`、`technical-writing`、`tdd`、`benchmark-checklist`、`typescript-best-practices`、`blast-radius`、`correct`、`bro`、`in-your-own-words`、`sharpen`。
- **工作流预设**：`server/src/workflows/presets/pstack-adversarial-review.md`（interrogate 的工作流版）。

已知降级：`typescript-best-practices` 的 `references/patterns.md` 例子未搬；未移植 playbook（重构/性能/原型等）在 poteto-mode 里以内联要点代替。

## 移植矩阵（未搬资产处置）

| 上游资产                                                                                                                                                                                                                                                                                                                                                                                    | 处置                  | 原因 / ChisaBot 落点                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| playbook：refactoring / perf-issue / prototype / opening-a-pr                                                                                                                                                                                                                                                                                                                               | 可续改写              | 模式已立，照 `adapted/pstack-pb-*` 同样改                                                                               |
| `teach`、`figure-it-out`、`show-me-your-work`、`no-comments`、`poteto-help`、`ketchup`                                                                                                                                                                                                                                                                                                      | 视价值续搬            | teach 依赖已齐；其余依赖转录文件或子代理评审，需裁剪                                                                    |
| `swarm`、`arena`（完整竞速版）                                                                                                                                                                                                                                                                                                                                                              | 可再做工作流预设      | adversarial-review 已证明该形态                                                                                         |
| `agents/poteto-agent`、`comment-sicko`                                                                                                                                                                                                                                                                                                                                                      | 工作流角色 / 预置 BOT | agents.yaml `system_prompt` 或 workflow `bots[]`                                                                        |
| `automate-me`、`reflect`、`recall`                                                                                                                                                                                                                                                                                                                                                          | 不搬                  | ChisaBot 的 `skill_save`/`memory_*` 已覆盖；转录文件依赖不可移                                                          |
| `setup-pstack`、`automations/benny`、`deslop`（外部插件）、`statechart`、`make-bot-ui`、`ketchup-video`、`maintain-*`、`create-*-verification-skill`、`eval`、`hillclimb`、`runtime/trace-forensics`、`visual-parity`、`autopilot-*`、`orchestrate`、`shipping`、`babysit`、`multi-phase-plan`、`session-pickup`、`pause-safely`、`worktree-cleanup`、`autonomous-run`、`authoring-a-skill` | 不搬/延后             | Cursor 专属运行环境（Automations、cloud agents、worktree、CI 看护、转录审计）或需要本地仓库上下文；有具体需求再单独移植 |

## 约束备忘

- 技能：slug `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`（≤40）、title ≤60、summary ≤200、instructions ≤20,000；技能目录页只展示前 40 条。
- 工作流：步骤 prompt ≤8,000、内嵌技能 ≤8,000×12、角色 ≤8、步骤 ≤30、单步超时 ≤5 分钟（schema 上限）、`handoff` 只有 none/previous/all、并行组必须相邻且组内审批只能放首步。
- 租户包：`agents.yaml` 的 `skills:` 只能引用本包 `skills.yaml` 里的 slug，否则整包拒绝加载。

## 下一步

1. 续搬 playbook：refactoring、perf-issue、prototype、opening-a-pr（照 `adapted/` 现有模式）。
2. `teach`（how+why 已齐）、`show-me-your-work`（去转录段）、`no-comments`（评审批改为工作流步骤）。
3. `swarm`/`arena` 完整版工作流预设。
4. 视效果决定是否把 pstack 技能挂到预置 BOT（agents.yaml `skills:`）形成「工程模式」入口。
