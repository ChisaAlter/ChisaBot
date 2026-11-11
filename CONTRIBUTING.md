# 参与 ChisaBot 开发

ChisaBot 需求多、并行开发多，所以每个改动都按同一套流程走：**一条 backlog → 一个分支 → 一个 PR → 串行部署**。

- 要做什么、先做什么：[docs/ROADMAP.md](docs/ROADMAP.md)（看板）、[docs/BACKLOG.md](docs/BACKLOG.md)（带验收标准的条目）
- 系统怎么搭的：[docs/architecture.md](docs/architecture.md)，为什么这样搭：[docs/adr/](docs/adr/README.md)
- 界面规则：[DESIGN.md](DESIGN.md)（顶部有章节索引）
- 文档总目录：[docs/README.md](docs/README.md)

## 1. 开始之前

1. 在 BACKLOG 里找到对应条目，没有就新加一条（下一个 `CB-xxx`，写清验收标准）。GitHub Issues 打开后改用 issue 模板。
2. 标上 `status: in-progress`，在 ROADMAP「现在」写上分支名。
3. 从最新 `origin/main` 开分支（并行时用 worktree，见 [docs/dev/parallel-work.md](docs/dev/parallel-work.md)）：

| 类型             | 分支           | 例子              |
| ---------------- | -------------- | ----------------- |
| 新功能           | `feat/<名字>`  | `feat/approvals`  |
| 修缺陷           | `fix/<名字>`   | `fix/pages-h1`    |
| 维护 / 瘦身 / CI | `chore/<名字>` | `chore/pm-system` |
| 只改文档         | `docs/<名字>`  | `docs/adr-vault`  |

提交信息用 `类型(范围): 说明`，例如 `feat(devices): 设备上的精确替换编辑`，中文说明即可。

## 2. 一个 PR 必须带的东西

同一个 PR 里完成，不留到「以后补」：

- **测试**：改到的部分有单测 / 集成测试；`bun run typecheck`、相关包的测试、前端构建都过。
- **聊天滚动回归**：改到聊天、消息列表、同步、输入框、通知条的，跑 `tests/chat-scroll/regression.sh`，7 项全过。
- **截图**：有界面的改动附宽 1280、窄 420、暗色三张（前后对比更好）。
- **DESIGN.md**：新界面 / 新交互写一节（编号规则见并行协议 §4），并更新顶部章节索引。
- **docs**：功能文档 `docs/<功能>.md`；新表、新开关写进 [architecture.md](docs/architecture.md) 的功能表；架构取舍写 ADR。
- **CHANGELOG.md**：`Unreleased` 下一行，写给运行部署的人看（行为有什么不同、要不要更新客户端、要不要手动操作）。
- **BACKLOG / ROADMAP**：勾掉验收标准，条目移到「最近完成」，写 PR 号。
- **docs/CHANGELOG.md**：在「未发版」表里加一行（PR、合并时间、提交、内容、DESIGN / 条目）；客户端发版时把这些行移进新版本。
- **docs/features.md / data-model.md**：新功能、新入口、新开关、新表都要登记；长期规则变化记到 docs/decisions.md。发版流程和测试约定见 docs/release.md、docs/testing.md。
- **内部记录**：维护者自己的运行记录（部署机路径、镜像标签、回滚脚本）记在仓库之外；**仓库是公开的**，不要提交服务器 IP、真实域名、主机名、
  内网 DNS、密钥、真实用户数据。CI 里有一条「Private host info guard」按仓库变量 `PRIVATE_HOST_DENY` 检查这些标识（分号分隔的正则；
  维护者在 GitHub 的 Settings → Secrets and variables → Actions → Variables 里配置）——**模式本身不进仓库**，因为 CI 日志是公开的，
  守卫里写出地址等于它自己泄漏一次。变量没配时这一步只告警、不拦截。

## 3. 合并与部署

1. 合并前一刻 `git fetch && git rebase origin/main`，有冲突就重跑测试。
2. 只对自己的分支 `--force-with-lease`；**永远不要 force-push `main`**，不要删别人的分支 / tag。
3. GitHub 上 merge commit 合并。
4. 需要上线的：`deploy-serial.sh <合并提交>`，然后冒烟检查（[docs/ops/deploy.md](docs/ops/deploy.md)）。纯文档 PR 不部署。
5. 客户端（PC / Android）发版见 [docs/release.md](docs/release.md)。

## 4. 标签

| 组     | 标签                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型   | `type: feat` `type: bug` `type: chore` `type: docs` `type: perf`                                                                                                 |
| 范围   | `area: chat` `devices` `pc` `android` `settings` `memory` `skills` `vault` `github` `pages` `schedules` `images` `im` `approvals` `agents` `infra` `slim` `docs` |
| 优先级 | `P0`（线上坏了 / 阻塞发布）`P1`（这一轮）`P2`（排队）                                                                                                            |
| 状态   | `status: in-progress` `status: blocked` `status: needs-user` `status: deferred`                                                                                  |

里程碑：Hark parity · 精简 Slim · 设备核心 Devices core · 成熟度 Maturity · 0.2.0 release。
