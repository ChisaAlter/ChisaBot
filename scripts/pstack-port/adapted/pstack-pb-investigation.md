---

name: pstack-pb-investigation
description: "调查类任务 playbook：只读，产出带引用的讲解或建议，不改代码。问题排查定位阶段也走这个。"
---

# 调查（playbook）

**你拥有答案。计划、路由、撰写。**

调查是只读工作：产出一份带引用的讲解或一条建议，不产出代码改动。

1. 机制问题走 **how** 技能；动机/历史问题同时走 **why** 技能。
2. 吞吐检查点一行：`throughput checkpoint: n/a, read-only investigation`。
3. 产出 **how** 形状的结果（Overview / Key Concepts / How It Works / Where Things Live / Gotchas）；如果问题是方案取舍，产出建议 + 取舍对照表。
4. 回复过一遍 **unslop**。

不出 PR，不派工，不跑 **architect**——除非这个调查是为后续改动做铺垫，是就把结论交给用户并说明下一步该路由到 Bug 修复或新功能。

**回复**：调查产出。"我们确定吗"类问题要给真实判断加理由；前提是错的就指出（自主权条款，见 poteto-mode）。
