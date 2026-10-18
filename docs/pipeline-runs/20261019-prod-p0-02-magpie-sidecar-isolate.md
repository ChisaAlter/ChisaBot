# Pipeline run: PRD-P0-02 Magpie/sidecar → app isolation (2026-10-19)

## Scope
生产成熟度安全残余（baseline **v0.1.38** → **v0.1.39**）：
1. Trust-boundary **PRD-P0-02 residual**：共享 Docker 网可达 app 端口 → Magpie/边车 **不能发起** 到 `:3001`
2. Local-Caller 仍为宿主机刮数 only；文档 who-can-reach-whom；CI/check；readiness/requirements/dogfood/pipeline-run
3. **未** resume 电车；**未**默认打开多用户 UI；**未**强制卸 shared net（可选人工拓扑）

实现：`/workspace/ChisaBot/repo`（**不用** Cursor cloud agents）。

## What changed
- `scripts/ops/isolate-sidecar-app.sh`：`--apply` / `--check` / `--verify`；br_netfilter + DOCKER-USER DROP（`chisabot-sidecar-iso`）
- `deploy-serial.sh`：部署后 apply+verify（失败退出 8）；拷贝脚本到 `/opt/chisabot-ops`
- `deploy/magpie-isolate.service`：开机 oneshot 重放
- `deploy/start.sh`：root 时顺带 apply
- `shared/trust-boundary.ts` `isolateScriptCoversSidecarDeny` + red-line / unit tests
- `docs/ops/trust-boundary.md` §5.1；production-checklist §9b

## Not in this PR
- 未 resume 电车；无表结构变更；PC / Android 外壳指纹未变
- 未翻转 `CHISABOT_ACCOUNTS_UI`；未 live cutback
- 跳过 CB-017/018 / 0.2.0；未强制 App 卸下 `openbot_magpie`（host.docker.internal 路径仅文档）

## Verify
1. `bun test shared/trust-boundary.test.ts server/tests/trust-boundary-redline.test.ts`
2. `sh scripts/ops/check-trust-boundary.sh`
3. 宿主机：`isolate-sidecar-app.sh --verify`（Magpie!-app；App→magpie:3425）
4. 部署后：post-deploy-smoke PASSED；版本 0.1.39；电车仍 paused

## PR / release / deploy

- PR: (pending)
- Release: (pending)
- Deploy: (pending)
- **未** resume 电车定时
