# Pipeline run: prod send honesty + MCP abort (2026-10-19)

## Scope
生产成熟度残差（baseline **v0.1.30** → **v0.1.31**）：
1. 发送假成功诚实：看门狗决策可测，超时未落库 / 回答挂死绝不当成功
2. MCP AbortSignal：Stop 中断进行中的 MCP；Drive 合并 abort；Composio/builtin 入口拒绝
3. readiness / requirements / dogfood / pipeline-run 更新

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。**未** resume 电车定时。跳过完整浏览器 E2E（有单元/集成测）；跳过真机 CB-017/018 / metrics 时序 / 真回滚窗口。

## What changed
- `app/.../connection-drop.ts`：`decideSendWatchdogAction` + `isHonestSendFailureReason`；`channel-chat` 改用该决策
- `server/src/plugins/mcp.ts`：`signal` → SDK RequestOptions；`isMcpAbortError`；测试用 `allowPrivateHost`
- `plugins/tools.ts` / `store.ts` / `transport.ts`：AbortSignal 贯穿；停止后不呈现迟到成功
- Drive AbortSignal.any；Composio/builtin 入口 abort（文档：SDK 中途取消能力有限）

## Not in this PR
- 未 resume 电车；无表结构变更；PC 外壳指纹未变
- 完整浏览器 E2E（隧道断/模型挂/刷新后气泡）仍建议后续补
- 真机 CB-017/018 → 0.2.0；完整 metrics 时序；真回滚切流量；多用户默认仍需 `CHISABOT_ACCOUNTS_UI=1`

## Verify
1. `bun test app/tests/connection-drop.test.ts server/tests/mcp-protocol.test.ts server/tests/plugin-tools-abort.test.ts`
2. 硬刷新 → 芯片 0.1.31；MCP 工具跑着点停止 → 应见停止/拒绝，非完整成功结果
3. 电车仍暂停

## PR / release / deploy

- PR: (pending)
- Release: (pending)
- Deploy: (pending)
- **未** resume 电车定时
