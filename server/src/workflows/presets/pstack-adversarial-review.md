---

format: chisabot.workflow/v1
slug: pstack-adversarial-review
name: 对抗审查
description: 移植自 Cursor pstack 的 interrogate：多个攻方机器人设法"攻破"一段改动或设计，只有实际跑出证据的发现才算数，主审复核后汇总。
icon: ⚔️
version: "1.0"
tags:
- 开发
- pstack
  bots:
- key: lead
  name: 主审
  description: 框定意图与范围；逐个复核攻方给出的证据，去重并出最终报告。
- key: adversary_a
  name: 攻方 A
  description: 设法攻破改动。建议绑定与主审不同模型家族的机器人，制造真实分歧。
- key: adversary_b
  name: 攻方 B
  description: 第二位攻方。建议再绑一个不同模型，不同模型抓到不同的真实缺陷。
  skills:
- slug: proof-rules
  title: 实证规则
  instructions: |-
  一条发现只有在实际运行中被证明才成立：
  - 必须给出能复现失败的命令：一个失败的测试、一段复现脚本，或显示错误行为的命令输出。
    - 审查设计稿或计划时，就跑一个最小原型，或探查现有代码证明假设不成立。
      - 每条发现写清：标题、执行的确切命令、命令真实输出、以及按意图它本应输出什么。
        - 没有跑过的一律不写：风格、命名、结构偏好，以及"将来某次改动才会暴露"的风险都不报。
          - "没有发现"是合法结论，不许凑数。
            inputs:
- key: target
  label: 审查对象
  type: textarea
  required: true
  placeholder: 粘贴 diff、设计稿，或说明要审查的范围（如仓库地址 + 分支/文件）
- key: intent
  label: 预期行为
  type: textarea
  required: false
  placeholder: 这段改动/设计要达成什么？留空则由主审从材料中归纳
- key: repo
  label: 仓库地址
  type: url
  required: false
  placeholder: 可选。提供后攻方会在云端工作区 clone 下来跑实证
  steps:
- id: frame
  name: 框定范围与意图
  bot: lead
  handoff: none
  tools:
  allow:
  - apps
    prompt: |-
    你是主审。先框定这次对抗审查的范围与意图。

  审查对象：

  ```
  {{inputs.target}}
  ```

  用户给的预期行为：{{inputs.intent}}
  仓库：{{inputs.repo}}

  输出两样东西，供后面的攻方使用：
  1. 意图：用你自己的话复述这次改动/设计要解决的问题和预期行为；用户没写就从材料归纳，归纳不出就明说"意图不明"。
     2. 范围：本次审查的确切边界（哪些文件/行为在范围内，哪些不在）。
     不要开始找问题，这一步只做框定。
- id: attack_a
  name: 攻方 A 实测
  bot: adversary_a
  group: attack
  handoff: none
  skills:
  - proof-rules
    tools:
    allow:
    - computer
    - apps
      prompt: |-
      你是攻方。目标：攻破下面这次改动或设计。

    主审框定的意图与范围：
    {{steps.frame}}

    原始材料：

    ```
    {{inputs.target}}
    ```

    仓库：{{inputs.repo}}（给了就在云端工作区 clone 后在真实代码上跑；没给就按材料构造最小复现）

    按「实证规则」技能逐条执行：每条候选发现都必须真跑一遍，跑出失败证据才写进报告。
    留在范围内。逐条列出验证通过的发现（标题 / 命令 / 真实输出 / 预期输出）；没有就明确写"未发现"。
- id: attack_b
  name: 攻方 B 实测
  bot: adversary_b
  group: attack
  handoff: none
  skills:
  - proof-rules
    tools:
    allow:
    - computer
    - apps
      prompt: |-
      你是攻方。目标：攻破下面这次改动或设计。你和另一位攻方独立作战，不要假设他会覆盖哪类问题。

    主审框定的意图与范围：
    {{steps.frame}}

    原始材料：

    ```
    {{inputs.target}}
    ```

    仓库：{{inputs.repo}}（给了就在云端工作区 clone 后在真实代码上跑；没给就按材料构造最小复现）

    按「实证规则」技能逐条执行：每条候选发现都必须真跑一遍，跑出失败证据才写进报告。
    优先尝试边界输入、并发/时序、状态残留、错误路径这些容易藏真缺陷的角度。
    留在范围内。逐条列出验证通过的发现（标题 / 命令 / 真实输出 / 预期输出）；没有就明确写"未发现"。
- id: verify
  name: 复核证据
  bot: lead
  handoff: all
  tools:
  allow:
  - computer
  - apps
    prompt: |-
    你是主审。两位攻方的发现都在上面。逐条复核：
  1. 重跑每条发现声称的命令（有仓库就在云端工作区跑；没有就按其复现脚本逻辑验证）。
     2. 只保留同时满足两条的：输出确实显示失败、且该失败确实违背框定的意图。
     3. 丢掉其余全部：跑不出来的、输出与意图不矛盾的、范围外的。
     4. 把根因相同的发现合并成一条，注明哪些攻方各自独立发现了它（多方独立命中 = 高置信信号）。

     输出保留清单 + 每条的复核证据（你重跑看到的输出）；丢弃清单只报数量和丢弃原因。
- id: report
  name: 审查报告
  bot: lead
  prompt: |-
  基于复核结果写最终报告：
  1. 意图：一句话。
     2. 验证通过的发现：逐条给标题、复现命令、真实输出、为何违背意图、由哪些攻方发现。没有就写"无验证通过的发现"。
     3. 被驳回的发现：每位攻方各被丢了几条、主要原因。
     4. 一句总结：这次改动经得住对抗审查吗？
     只报结果，不要建议怎么修（修复是下一个任务）。
     output: markdown
     constraints:
     maxSteps: 5
     maxTokens: 200000
     timeLimitMinutes: 45
     stepTimeoutMinutes: 5
     tools:
     deny:
     - devices
       - host
         - schedule
           output:
           format: markdown
           instructions: 先列验证通过的发现，再列驳回统计，最后一句总结。

---

# 对抗审查（移植自 pstack interrogate）

两个攻方机器人**并行**设法攻破你给的改动或设计。与普通代码审查的区别：这里不接受"看起来有问题"，每条发现都必须有**实际运行的证据**——一个失败的测试、一段复现脚本、或显示错误行为的命令输出。

- **主审**先框定意图与范围，最后逐条重跑攻方的证据复核，只保留实证成立且违背意图的。
- **攻方 A / B** 在云端工作区各自实测。建议给它们绑**不同模型**的机器人：不同模型抓到不同的真实缺陷，多方独立命中同一根因是最强信号。
- 全程禁本机文件夹和设备；攻方只许用云端工作区（computer）和已连接应用（apps）。

适合：重要 diff 合并前、设计稿评审、你不完全信任的"小改动"。单步上限 5 分钟，特别重的复现建议先缩小范围。
