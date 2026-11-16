---
name: chisabot-formal-verification
description: 为 ChisaBot 中的并发锁/租约、权限策略、一次性审批门及客户端同步账本等高危状态机编写确定性 BFS 模型检验与 fast-check 属性测试。当新增或修改分布式锁、重连幂等逻辑、审批流或权限模型时启用。
---

# ChisaBot 核心状态机形式化验证指南

## 适用场景

当代码涉及以下四类高复杂度、传统单元测试难覆盖并发交错的逻辑时，必须同步维护形式化状态机证明：

1. **租约与 fencing token**（回合锁、心跳续约、超时回收与迟到写回拦截）；
2. **多维度授权裁决**（插件启用态 / Bot 授权 / 运行时策略 / 审计账本）；
3. **一次性状态消费**（多副本 CAS 抢占、载荷摘要绑定、终态不可逆）；
4. **乐观态与权威快照合并**（`clientMessageId` 去重、增量游标同步、断线重连幂等）。

## 标准落盘结构

1. 复用公共 BFS 模型检验器 [model-checker.ts](file:///c:/AI/ChisaBot/shared/verification/model-checker.ts)：
   - 定义 `StateModel<S>`，明确 `canonicalize`（去除无限递增计数器或对其设合理有限上界以避免假状态爆炸）、`isTerminal`、`transitions`（带精确 `guard`）与 `invariants`。
   - 用 `assertModelHolds(model)` 穷举全部可达状态并校验无非预期死锁。
2. 结合 `fast-check` 进行随机长动作流或真实纯函数属性测试（`numRuns >= 300`）。
3. **双变异体捕杀硬要求**：每个形式化测试文件必须注入并捕杀 **至少 2 个** 典型并发/安全缺陷变异体，使用 `exploreModel(faultyModel)` 显式断言：
   - `result.ok === false`；
   - `result.counterexample?.kind === "invariant"`；
   - `result.counterexample?.failedInvariant` 命中预期不变式名；
   - 反例包含最短可达动作序列。
4. 同步更新 [formal-statecharts.md](file:///c:/AI/ChisaBot/docs/formal-statecharts.md) 中的 Mermaid 状态图，并将测试路径加入 CI 与 `AGENTS.md` §7 自动门禁表。
