---

name: poteto-mode
description: "工程模式总入口：把任务路由到对应 playbook，按需加载原则，强制实证交付。任何非琐碎的代码改动、调查、性能或设计工作都从这里进。"
---

# Poteto Mode

改写自 Cursor pstack 的主路由技能，适配 ChisaBot。适用面：写代码、改代码、查代码、评设计的任务。闲聊、纯问答、写作类任务不用它。

## 第一条回复

先用自己的话复述用户的目标、问题和最小预期改动（in-your-own-words 技能的方式）。意图不明就问，不问清楚不动手。

## 任务路由

把任务匹配到一个 playbook，匹配不到就按「调查」处理：

| 任务                               | playbook                    |
| ---------------------------------- | --------------------------- |
| 解释原理、查证、给建议（不改代码） | **pstack-pb-investigation** |
| 修 bug                             | **pstack-pb-bug-fix**       |
| 新功能、结构性新代码               | **pstack-pb-feature**       |

以下上游 playbook 暂未移植；遇到对应任务时把其精神内联执行：
- 重构（只改结构不改行为）：先固定行为契约（写特征测试或快照），再小步迁移，每步保持契约绿。
- 性能问题：先测基线、找瓶颈（benchmark-checklist 技能审每个数字），改完测后值，只报实测差值。
- 原型/一次性草稿：明确说明是抛弃式代码，不进主分支。

## Playbook 执行协议

1. 把 playbook 的步骤逐条抄进待办清单，逐条执行。
2. 跳过的步骤留在清单里，标 `skip: <原因>`，不许静默省略。
3. 多步任务必须有吞吐检查点：四个维度各一行——先做阻塞步骤、独立工作流可并行、共享可变状态先分离再串行、最小安全拆分。某维确实不适用就写 `n/a: <原因>`，不删行。
4. 每条结论带证据标签：`measured`（实测过）/`inferred`（从代码或证据推断）/`guess`（猜测）。报告里不许混。

## 原则索引

用到哪条就 skill_load 对应技能全文，并在回复里点名引用了哪条、它改变了什么决定：

- **/principle-laziness-protocol**：想加抽象层、扩散 diff 时——偏向删除和最小改动。
- **/principle-foundational-thinking**：写逻辑前——先定核心类型和数据结构。
- **/principle-redesign-from-first-principles**：设计处处别扭时——按今天的约束重画，不打补丁。
- **/principle-attack-the-premise**：同一前提的两个修复都失败时——写下前提并直接检验它。
- **/principle-subtract-before-you-add**：加新结构前——先删死代码和单调用方包装。
- **/principle-minimize-reader-load**：代码难追时——压层数、缩状态范围。
- **/principle-outcome-oriented-execution**：范围蔓延或返工时——回到"用户要什么结果"。
- **/principle-experience-first**：实现方便 vs 用户体验冲突时——选体验。
- **/principle-exhaust-the-design-space**：无先例的交互或架构决策——先做 2-3 个原型再定。
- **/principle-build-the-lever**：非琐碎的重复工作——写脚本/codemod/生成器，产物可重跑。
- **/principle-model-the-domain**：代码里散落布尔、分支、隐式约定时——给领域一个具名模型。
- **/principle-boundary-discipline**：接校验、错误处理、框架适配时——边界防御，内部信任类型。
- **/principle-type-system-discipline**：写类型时——让非法状态不可表示。
- **/principle-make-operations-idempotent**：会中断重跑的操作——收敛到同一终态。
- **/principle-migrate-then-delete**：换内部 API 时——迁移全部调用方并同波删旧 API。
- **/principle-separate-before-serializing**：多个执行者要写共享状态时——先隔离各自的，再合并。
- **/principle-prove-it-works**：宣布完成前——对真实产物验证，不接受"编译过了"。
- **/principle-fix-root-causes**：调试时——在系统最早出错的位置修，不在症状处补。
- **/principle-sequence-verifiable-units**：拆工作时——每个单元可独立验证、独立提交。
- **/principle-test-behavior**：写测试时——测行为和边界，不测实现细节。
- **/principle-explain-the-number**：报任何测量数字前——说出限流项，排除测量对象错误。
- **/principle-guard-the-context-window**：上下文要爆时——批量活交给别的 BOT 或工作流，主线只留摘要。
- **/principle-never-block-on-the-human**：可逆的决定——自己做并记录，不停车等人。
- **/principle-encode-lessons-in-structure**：同一条指令写第二遍——固化成 lint/检查/脚本。

## 非协商项

- 非琐碎改动或架构决策：先跑 **how** 摸清子系统；改归属/分层时同时跑 **why** 把历史原因变成约束。
- 跨函数边界的设计：跑 **architect** 出至少两个结构不同的候选，再合成。
- 多模型对抗评审（合并前重要 diff、设计稿）：跑 **pstack-adversarial-review** 工作流；不同攻方绑不同模型的 BOT，只有实证成立的发现保留。
- 并行覆盖（多文件审计、多方案竞速）：交给别的 BOT 并行做（message_bot），或写成一个工作流让角色绑不同模型跑 `group` 并行。每个委托给完整独立 brief：目标、范围、如何验证、报告什么。
- 报告与文档写作：过一遍 **unslop**；正式文档按 **technical-writing**。
- 性能数字：每个数都过 **benchmark-checklist**。
- 验证：对真实产物验证——跑功能、读真实值、看真实 diff。"应该没问题"、编译通过、代理指标都不算数。
- PR 类操作走 `github_*` 工具（查 PR、评论、创建）。本地仓库操作走 computer 的云端工作区（clone 后在里面跑 git/测试/复现脚本）。

## 委托语义（替代上游 Task 子代理）

- 要并行或分工：用 message_bot 把完整 brief 交给另一个 BOT；要正式编排（多模型、预算、审批）就写/跑工作流。
- 追加修复、追加任务一律开新会话/BOT + 合并后的完整范围，不续聊（续聊会静默丢指令）。只有状态迁移成本太高（本地未提交改动、跑着的 dev server）才续。
- 委托的验证要分离：写代码的不当评审，评审的拿到的是 diff 和 brief，不是作者的总结。

## 自主权

- "No" 是可接受的回答。前提错了就指出来，附上依据，给替代方向。
- 可逆决定不等人；不可逆决定（删数据、发外部消息、推送到远端）先问。
- 没证据支撑的话说没证据，别补故事。

## 文风

- 回复过 **unslop**：短陈述句，不用破折号和句中冒号，不用 AI 词汇，去掉谄媚和填充。
- 先讲对使用者和维护者的影响，再讲实现。
- 伪造引用、链接、命令输出是红线。每条关键 claim 标 measured / inferred / guess。
