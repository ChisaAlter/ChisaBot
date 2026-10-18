# 常见故障与事故复盘

[← 运维手册总览](README.md)

## 1. 常见故障

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 所有 `/api` 挂起、对话加载不出来，日志有 `bind message supplies 1 parameters, but prepared statement "" requires 8` | Bun 1.3.x SQL 连接在事务中 EOF 后错位。目前只在被端到端反复冲击的**预览**容器里出现（约每个新容器 2 轮后），生产未出现过 | 预览：一个容器只跑一轮。生产若出现：重启应用容器（由预览推断，未在生产验证）。根治要升级 Bun 或在协议错误时重置连接池 |
| 所有发送返回 409 | 部署 / 重启时留下孤儿线程锁 | 新版本启动时会释放孤儿锁；部署一律走 `deploy-serial.sh`（会等线程锁清零） |
| 机器人不回答、自检失败 | 默认模型额度用完 / 上游故障 | 换默认模型、配备用模型（[model-config.md](model-config.md)） |
| 网页一直显示「正在更新」 | 应用容器没起来（502 / 503 / 504） | `request.sh status`、`docker logs openbot-zh`；更新失败会自动回滚，手动回滚见 [deploy.md](deploy.md) §3 |
| 登录后马上又回到登录页 | `publicOrigin` / `TRUSTED_ORIGINS` / 端口不一致，或两个入口用了不同 hostname | 核对 [gateway.md](gateway.md)，Origin 必须完全一致 |
| 多账号下身份被拒 | 签名身份密钥三处不一致 | [gateway.md](gateway.md) §4 |
| 电脑文件夹同步失败（ECONNREFUSED） | 节点重启后边车留在旧网络命名空间 | 装看门狗（[cloud-node.md](cloud-node.md) §4） |
| 改了节点程序但云端工作区行为没变 | 节点只在启动时下载程序 | `docker restart chisabot-cloudnode` |
| 部署时间突然变长、内存吃紧 | 底座镜像不存在或依赖变了 → 完整构建 | 预期内；内存不够就调 `FULL_BUILD_MEMORY` / `FULL_BUILD_PARALLELISM`，或加 swap |
| 回滚脚本报镜像不存在 | 镜像已被 `KEEP_IMAGES` 或手工清理删除 | 走 revert PR 或 `request.sh update --full` |
| PC 客户端不自动更新 | 装的是内部旧版本线（如 0.2.x），不会降级 | 手动卸载重装 0.1.x（数据保留） |

## 2. 事故复盘

以下是项目运维中真实发生过的事故，去掉了个人信息，保留经验教训。

### 2.1 `main` 被强推，标签和 PR 历史丢失

- **经过**：一个自动化 agent 用维护者的同一个账号对 `main` 做了强推，覆盖了一段提交历史；几个版本标签和 Release、十个分支被删，
  若干已合并 PR 的提交从 `main` 上消失。因为用的是同一个账号，事后无法从记录上区分是谁做的。
- **教训 / 规则**：
  - **绝不强推 `main`**；在仓库设置里给 `main` 开分支保护（禁止 force push、禁止删除）。
  - 合并前在自己的分支上 rebase；`--force-with-lease` 只用在自己的分支。
  - 自动化工具用**单独的账号或 GitHub App**，权限最小化，便于审计。
  - 标签和 Release 定期备份（例如镜像到另一个远端）。

### 2.2 删除确认流程误删了机器人

- **经过**：一个旧版本客户端上的删除确认流程删掉了一个正在使用的机器人。从更新器的数据库备份里恢复了它；恢复期间系统自动新建的
  同名机器人也保留了下来。
- **教训 / 规则**：
  - 恢复前**先对当前库做一次转储**，再从备份恢复。
  - 删除类操作要有清晰的二次确认，并且测试只在一次性机器人上做（[preview.md](preview.md) §3）。
  - 旧版本客户端要尽快升级；不能自动升级的版本线要明确通知用户。

### 2.3 空变量 `rm -rf` 删掉了整个公开下载目录

- **经过**：发版时清理临时目录，路径变量为空，`rm -rf "$PUB/$R"` 变成删除整个公开下载目录。随后从保留的 CI 产物目录重建了各版本
  安装包和更新源，但目录里的旧备份丢失。
- **教训 / 规则**：
  - 删除前一律判空：`[ -n "$R" ] && rm -rf -- "$PUB/$R"`；shell 脚本开 `set -u`。
  - 临时文件放在**下载目录之外**。
  - 动更新源之前先整目录备份；CI 产物至少保留最近几版，作为重建来源。

### 2.4 部署重启留下孤儿线程锁，所有发送 409

- **经过**：部署时应用在对话进行中被重启，线程锁没有释放，之后所有发送都返回 409。
- **教训 / 规则**：应用启动时释放孤儿锁（已修复）；部署脚本先等线程锁清零再切换；更新器切换前 drain 正在回答的对话。

### 2.5 默认免费模型额度用完

- **经过**：默认模型是有每日额度的免费模型，额度用完后机器人无法回答，管理员自检也失败。
- **教训 / 规则**：生产默认模型要有稳定额度；始终配置不同供应商的备用模型；自检失败要有告警。

## 3. 整机迁移（经验）

把部署迁到新主机时：

1. 新主机按 [hosts.md](hosts.md) 准备好，先部署**同一个提交**的镜像，不接流量。
2. 旧主机停写（或进入维护），`pg_dump` + 卷快照 + `.env` / `secrets/` / `auth/` / `auth-data/` / 证书 / 更新器目录拷到新主机。
3. 新主机恢复数据、起服务、跑 [monitoring.md](monitoring.md) 的巡检和自检。
4. 切 DNS（或在旧主机上临时把入口端口转发到新主机，等 DNS 生效）。
5. 旧主机保留为停止状态的回滚副本一段时间，确认稳定后再退役，并安全擦除上面的数据和密钥。

## 4. 部署失败速查（playbook stub）

更新器切换后健康检查 / `post-deploy-smoke.sh` 红灯时：

1. **看任务**：`sh /opt/chisabot-updater/request.sh status` — `status` / `step` / 最后几行 log；`audit.log` 与 `jobs/<id>/`。
2. **看容器**：`docker ps -a --filter name=openbot-zh`；`docker logs --tail 80 openbot-zh`。常见：迁移失败、`bind message supplies`、镜像拉错。
3. **确认回滚**：健康失败应自动跑 `rollback-to-*.sh`。再查 `/api/version` 是否已回到上一 `buildId`；容器 `RestartCount` 是否在涨。
4. **烟雾细节**：在宿主机 `bash /opt/chisabot-updater/post-deploy-smoke.sh <buildId>`；缺 Local-Caller 时先核对 compose `.env` 的 `CHISABOT_GATEWAY_SECRET`。
5. **聚合面**：`curl -s -H "X-ChisaBot-Local-Caller: …" 127.0.0.1:3001/api/admin/health` — 看 `checks.database` / `magpie` / `computer` 哪项 `ok:false`。
6. **仍红**：不要强推 main。修 PR → 合并 → `deploy-serial.sh`。镜像已不在时走 revert PR 或 `request.sh update --full`。
7. **写复盘**：把现象、根因、是否误回滚、后续监控项记进本节或新小节。

完整上线清单：[production-checklist.md](../production-checklist.md)。
