# 部署、回滚与上线检查

[← 运维手册总览](README.md)

面向维护一个已经在跑的 ChisaBot 部署的人。第一次安装看 [README「给 AI 的部署引导」](../../README.md#给-ai-的部署引导) 和
[自托管部署](../../deploy/README.zh-CN.md)，更新器的内部设计看 [online-update.md](../online-update.md)。路径是默认值，
按 [layout.md](layout.md) 替换成自己的。

## 1. 正常上线一个 PR

1. PR 合并到 `main`（merge commit），记下合并提交 `<sha>`。
2. **只用串行部署脚本**：把仓库的 [`scripts/ops/deploy-serial.sh`](../../scripts/ops/deploy-serial.sh) 拷到宿主机（例如
   `/opt/chisabot-ops/`），以 root 运行：

   ```sh
   sh /opt/chisabot-ops/deploy-serial.sh <合并提交前 7 位> <你的名字> 2>&1 | tee /opt/chisabot-ops/logs/deploy-<PR>.log
   ```

   它会：
   - 拿 `flock /run/cb-deploy.lock`（最多等 40 分钟），同一时间只一个人部署，其他人排队；
   - 等更新器空闲、没有排队请求，并**等所有对话的线程锁清零**（`openbot_local_threads.lock_expires_at > now()` 为 0，最多 20 分钟），
     不打断正在回答的一轮；
   - `request.sh check` 匿名拉公开仓库的 main 到 `mirror.git`，确认 main 包含你的提交（别人后来又合并的会一起上线）；
   - `request.sh update` 并等完成，确认 `openbot-zh` 的镜像标签含新提交。
   - 环境变量 `CHISABOT_UPDATER_DIR`、`CHISABOT_APP_CONTAINER` 可覆盖默认目录 / 容器名。
3. 退出码：**0** 已上线 · **3** 等部署锁超时 · **4** 线程锁一直不为 0（有对话在跑）· **5** 提交不在 main · **6** 没切换成功（看 `request.sh status`）· **7** nginx 模板漂移（`sync-nginx --check` 失败；跑 `--apply` 或设 `CHISABOT_SYNC_NGINX=apply`）。
4. **不要**直接运行 `update.sh`（网页看不到进度、按钮会卡住）或 `request.sh update`（会和别人的部署撞车）。
5. 上线后做 §5 的检查。

纯文档 / 流程类 PR（只改 `docs/`、`*.md`、`.github/` 模板）**不需要部署**：镜像里的网页和服务器没有变化。

## 2. 更新器（`/opt/chisabot-updater/`）

| 命令 | 作用 |
|---|---|
| `sh request.sh check` | 拉最新 main，算出落后几个提交 |
| `sh request.sh update [--full]` | 更新（自动选快速 / 完整；`--full` 强制完整构建） |
| `sh request.sh rollback` | 回到上一镜像 |
| `sh request.sh status` | 最近任务的状态和日志尾部 |
| `sh smoke.sh` | 管理员自检（模型往返一次，不保存） |

网页上的「检查更新 / 一键更新 / 回滚 / 自检」（设置 → 系统更新）走的是同一个队列。

- **快速更新**：依赖指纹（`deps-fingerprint.sh`，忽略根 `package.json` 的版本行）没变 → 用 `Dockerfile.update` 以底座镜像为基础只换代码层，约 1–2 分钟。
- **完整构建**：指纹变了、`Dockerfile` 变了，或底座镜像不存在 → 用仓库根 `Dockerfile` 在 buildx 构建器 `chisabot-builder` 里构建
  （内存 `FULL_BUILD_MEMORY`、并行 `FULL_BUILD_PARALLELISM`、层缓存上限 `BUILD_CACHE_MAX`），约 4–8 分钟；成功后写 `base.env`（新底座 + 依赖树）。
- **每次更新**：`pg_dump` + compose + 卷快照 → `backups/<时间>-<任务>/`（保留 `KEEP_BACKUPS`=5 份）→ 切换 → 健康检查（含模型自检、
  `PUBLIC_HEALTH_URL`）→ **失败自动回滚**。
- **drain**：切换前等正在回答的对话结束（`DRAIN_SECONDS`，默认 900 秒，0 关闭）。
- **镜像保留**：`KEEP_IMAGES`=5（切流窗口，见 [traffic-cut-rollback.md](traffic-cut-rollback.md)）。
- **自升级**：每次成功更新后，更新器用新版本的 `deploy/updater/` 升级自己。2026-10-13 之前的老部署跑一次
  `cd /opt/chisabot-src && git pull && sudo sh deploy/install-updater.sh`（`--check` 只看不做）。
- `config.env` 的键（首次安装生成，之后不覆盖）：`COMPOSE_DIR COMPOSE_FILE PROJECT SERVICE CONTAINER IMAGE_REPO BASE_IMAGE
  NODE_MODULES_BASE PROTO_CONTAINERS BUILD_MEMORY FULL_BUILD_MEMORY FULL_BUILD_PARALLELISM BUILD_CACHE_MAX LOCAL_URL
  PUBLIC_HEALTH_URL VITE_MAGPIE_MANAGEMENT_URL GITHUB_FETCH GITHUB_REPO GITHUB_BRANCH KEEP_IMAGES KEEP_BACKUPS`，
  说明见 [`deploy/updater/config.env`](../../deploy/updater/config.env)。自己的 fork 把 `GITHUB_REPO` 改成自己的 `owner/repo`。

## 3. 回滚

### 3.1 应用镜像

每次切换都会在 compose 目录留下 `rollback-to-<上一版镜像标签>.sh` 和 `compose.yaml.before-<新标签>`。镜像标签形如
`local/chisabot:auto-<UTC 时间>-<提交前 7 位>`，文件名本身就说明回到哪一次提交。

```sh
ls -t /opt/openbot-zh/rollback-to-*.sh | head -3     # 最新的就是「回到上一版」
docker image inspect local/chisabot:auto-<时间>-<提交> >/dev/null && echo 镜像还在
sh /opt/openbot-zh/rollback-to-auto-<时间>-<提交>.sh
```

- 网页上：设置 → 系统更新 →「回滚到上一版」，效果相同。
- **只换镜像，数据库不回退**。ChisaBot 自己的表都是开机 `CREATE TABLE IF NOT EXISTS`、迁移只加可空列，所以回滚到旧镜像是安全的。
  **例外**：瘦身 P5 之后的 DROP 迁移不能只换镜像回滚，必须先恢复数据库（[slimming.md](../slimming.md)）。
- 回滚脚本会越积越多，但**只有镜像还在的才有效**（默认只留 5 个镜像，清理磁盘后可能更少）。运行前先确认镜像存在。
- 需要更早的版本：在 main 上合并一个 revert PR 走正常上线，或检出对应提交后 `request.sh update --full`。
- 数据恢复：`/opt/chisabot-updater/backups/<时间>-<任务>/` 里的 `pg_dump`。恢复前先对当前库再做一次转储。

### 3.1.1 切流窗口脚本

约定窗口内（镜像仍在）用 [`scripts/ops/cutback.sh`](../../scripts/ops/cutback.sh)：默认 **dry-run**，`CUTBACK_EXECUTE=1` 才切流量。RTO / 保留策略见 [traffic-cut-rollback.md](traffic-cut-rollback.md)。

### 3.2 手工部署的部分

网关、登录服务、云端节点、出口路由不随一键更新（§4）。改它们之前在同目录留 `*.bak-<说明>-<日期>`，并写一个
`rollback-<说明>-<日期>.sh`（恢复备份 + `nginx -t` + reload / 重启）。回滚脚本用过一次后在文件名或旁边的说明里标出来，
避免以后有人把已经过时的状态再放回去——尤其是会放回旧登录页、旧单用户网关这类脚本。

### 3.3 云端节点

节点镜像带构建号（`-b1`、`-b2`…）。回滚到旧镜像：`CLOUDNODE_TAG=<旧标签> docker compose -f compose.yaml up -d`；旧镜像被清理掉时，
需要用当时的 `Dockerfile` 重建（改 Dockerfile 前留 `Dockerfile.bak-<说明>`）。见 [cloud-node.md](cloud-node.md)。

## 4. 不随一键更新的部分

| 部分 | 怎么更新 | 详见 |
|---|---|---|
| 公网网关 nginx（`deploy/public/nginx.conf`） | **`sync-nginx.sh --apply`**（备份+渲染+`nginx -t`+reload）；`deploy-serial` 默认 `--check` 漂移则失败 | [gateway.md](gateway.md) §2.1 |
| 登录服务（`deploy/public/auth/server.ts`、`auth-web/`） | 拷文件 → 重启 `openbot-web-auth` | [gateway.md](gateway.md) |
| 更新器自己（`deploy/updater/`） | 每次成功更新后自升级；老部署跑一次 `install-updater.sh` | §2 |
| 云端工作区节点 / 同步边车 | 手工构建镜像、`compose up -d`；改了 `pc/src/cloud-cc` 的部署后 `docker restart chisabot-cloudnode` | [cloud-node.md](cloud-node.md) |
| PC / Android 客户端 | 发版流程 | [client-release.md](client-release.md)、[release.md](../release.md) |
| Magpie 模型网关 | 独立 compose，手动（先备份配置） | [magpie.md](../magpie.md) |

## 5. 上线后检查（不碰任何真实对话）

1. `sh /opt/chisabot-updater/request.sh status` 显示刚才的任务成功；`curl -s 127.0.0.1:3001/api/version` 的提交号是你的。
2. **部署后烟雾**（更新器已在 `health.sh` 里自动跑）：失败会回滚。人手复跑：`bash /opt/chisabot-updater/post-deploy-smoke.sh` 或 `request.sh smoke`（[production-checklist.md](../production-checklist.md)）。
3. **管理员自检（模型）**：设置 → 系统更新 →「自检」，或 `sh /opt/chisabot-updater/smoke.sh`（[admin-smoke.md](../admin-smoke.md)）。默认不因模型红灯回滚。
4. **快照对比**：上线前后各取一次——线程数、机器人数、设备数、用户数、关键设置的哈希（如 `enterprise_settings`、`media_models`）、
   备用模型列表。除镜像 / 版本外应一致。
5. **只读浏览器检查**（需要时）：临时签发会话 + 拦截所有非 GET 请求（[preview.md](preview.md) §4）。
6. 改到聊天 / 同步 / 滚动的 PR：在预览里跑 `tests/chat-scroll/regression.sh`（[testing.md](../testing.md) §3）。
7. 改了 `pc/src/cloud-cc`（节点程序）：`docker restart chisabot-cloudnode`——节点只在容器启动时从应用下载 `chisabot-node.cjs`。
8. 更新项目看板：ROADMAP「最近完成」、BACKLOG 状态、[CHANGELOG](../CHANGELOG.md)。

## 6. 并行开发时

多个人（或多个自动化 agent）同时开发时，每个人用自己的 worktree、预览容器和端口，部署一律走 §1 的串行脚本。
协议见 [dev/parallel-work.md](../dev/parallel-work.md)。
