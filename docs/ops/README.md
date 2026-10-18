# ChisaBot 运维手册（总览）

这套手册面向**自己部署、自己维护** ChisaBot 的人：从一台空服务器开始，到日常上线、回滚、巡检、清理和排障。
照着它做，不需要任何私人资料。第一次安装的最短路径看 [README「给 AI 的部署引导」](../../README.md#给-ai-的部署引导) 和
[自托管部署](../../deploy/README.zh-CN.md)；本手册讲的是装好之后怎么把它**长期稳定地跑下去**。

> **约定**：文中 `<SERVER_IP>`、`<YOUR_DOMAIN>`、`<PUBLIC_WEB_ROOT>` 之类的尖括号都是占位符，换成你自己的值。
> 端口（8443、2053、3001…）、目录（`/opt/openbot-zh`、`/opt/chisabot-updater`…）、容器名（`openbot-zh`…）是仓库模板和脚本的
> **默认值**，可以改；改了以后，凡是引用它的地方（`.env`、`config.env`、compose、nginx、systemd 单元）要一起改。
> 真实主机、域名、密码、密钥、证书、备份**不要**写进仓库或提交到 issue / PR。

## 章节

| # | 文档 | 解决什么问题 |
|---|---|---|
| 1 | [主机与端口规划](hosts.md) | 需要几台机器、什么配置、哪些端口对公网开放、哪些只绑 loopback |
| 2 | [容器与服务](containers.md) | 每个容器 / 镜像 / 卷 / systemd 单元是干什么的，哪些可以删 |
| 3 | [目录布局与凭据存放](layout.md) | 宿主机上每个目录放什么；各类密钥和凭据应该放在哪里、权限多少 |
| 4 | [部署、回滚与上线检查](deploy.md) | 合并后怎么上线、更新器怎么工作、怎么回滚、上线后查什么 |
| 5 | [网关与登录服务](gateway.md) | HTTPS 网关 nginx、登录服务、多账号开关、签名身份密钥、证书续期 |
| 5b | [信任边界图](trust-boundary.md) | Magpie / 网关 / 节点 / Local-Caller「谁可直连谁」（PRD-P1-05） |
| 5c | [备份与回滚演练](backup-rollback-drill.md) | 生产 dry-run 记录：转储 TOC、rollback 脚本、镜像在否（PRD-P1-04） |
| 6 | [云端工作区节点](cloud-node.md) | 云端 Claude Code 节点、同步边车、防火墙、可选的 Claude 出口路由 |
| 7 | [客户端发布](client-release.md) | PC / Android 的更新源目录、签名、发版流程、临时文件的安全删除 |
| 8 | [模型配置运维](model-config.md) | 默认模型、备用模型、生图 / 识图、免费额度用完时怎么办 |
| 9 | [预览与测试环境](preview.md) | 预览容器、假模型、出网封锁、生产只读检查与测试守则 |
| 10 | [监控与巡检](monitoring.md) | 每天 / 每次上线后的只读检查清单、宿主机定时任务 |
| 11 | [磁盘清理指南](cleanup.md) | 保留什么、可以删什么、清理顺序、清理后的副作用 |
| 12 | [常见故障与事故复盘](incidents.md) | 典型故障的现象与处理，过去事故的教训 |

相关的项目级文档：[生产上线清单](../production-checklist.md)、[发布流程](../release.md)（版本号规则、发版清单）、[测试与验证](../testing.md)（测试分层、回归套件）、
[在线更新](../online-update.md)（更新器内部设计）、[维护与排错](../operations.md)（备份、升级、连接故障）、[环境配置](../configuration.md)。

## 一页速查

| 项 | 默认 / 做法 |
|---|---|
| 应用 | 容器 `openbot-zh`（server + 网页 + PostgreSQL + 云端浏览器），只监听 `127.0.0.1:3001` |
| 公网入口 | `https://<YOUR_DOMAIN>:8443`（网关 nginx → 登录服务 `127.0.0.1:3002` 校验 → 应用） |
| Magpie 管理入口（可选） | `https://<YOUR_DOMAIN>:2053`，仅管理员 |
| 应用 compose 目录 | `/opt/openbot-zh/`（或你的检出里的 `deploy/`，以 `config.env` 的 `COMPOSE_DIR` 为准） |
| 更新器 | `/opt/chisabot-updater/`，systemd 服务 `chisabot-updater` |
| 上线 | `sh deploy-serial.sh <合并提交前 7 位> <你的名字>`（[deploy.md](deploy.md) §1）；纯文档 PR 不需要部署 |
| 切流回滚窗口 | [traffic-cut-rollback.md](traffic-cut-rollback.md)（`cutback.sh` 默认 dry-run） |
| 回滚 | 网页：设置 → 系统更新 →「回滚到上一版」；或运行 `ls -t /opt/openbot-zh/rollback-to-*.sh` 列出的第一个（最新）脚本 |
| 自检 | `sh /opt/chisabot-updater/smoke.sh` 或 `POST /api/admin/smoke`（模型往返）；聚合健康 `GET /api/admin/health`；部署后烟雾 `request.sh smoke` |
| 版本 | `curl -s 127.0.0.1:3001/api/version`（版本号 + 提交号） |
| 巡检 | [monitoring.md](monitoring.md) 的清单，根分区保持在 80% 以下 |

## 运维的几条硬规则

1. **绝不强推 `main`**。合并用 merge commit，合并前在自己的分支上 rebase，`--force-with-lease` 只用在自己的分支（[incidents.md](incidents.md)）。
2. **上线只走串行部署脚本**，不直接跑 `update.sh` / `request.sh update`。
3. **不在真实对话里测试**。自检用 smoke；端到端用一次性机器人 + 临时会话，或在预览容器里跑（[preview.md](preview.md)）。
4. **手工改的文件先备份**（`*.bak-<说明>-<日期>`），必要时同时写好回滚脚本。
5. **`rm -rf` 的路径变量先判空**：`[ -n "$R" ] && rm -rf "$DIR/$R"`。
6. **同一台机器上还有别的服务时**，清理、重启、改防火墙前先确认不会影响它们。
