# 备份与回滚演练记录（PRD-P1-04）

[← 运维手册总览](README.md) · 相关：[deploy.md](deploy.md) §3、[online-update.md](../online-update.md)、[incidents.md](incidents.md)

> 目的：证明「更新器留下的备份 + `rollback-to-*.sh`」在生产机上可定位、可校验、语法正确、目标镜像仍在。  
> **本记录为 dry-run**：校验转储 TOC / 卷可读 / 回滚脚本 `bash -n` + 镜像存在，**未**对线上流量执行真实回滚（避免无变更窗口打断用户）。真回滚步骤写在文末，值班可照抄。

## 1. 演练元数据

| 项 | 值 |
|----|-----|
| 日期 | 2026-10-19（Asia/Shanghai） |
| 主机 | Haupt（生产；本文不写公网 IP） |
| 当时运行 | `local/chisabot:auto-202610181706-76cf6b6` · **v0.1.27** · health=healthy |
| 操作者 | Grok Bot（ops 列车） |
| 方式 | SSH 只读盘点 + `pg_restore --list` + `tar -tzf` + `bash -n`；**未** `sh rollback-to-*.sh` |

## 2. 备份里有什么（最新一份）

路径：`/opt/chisabot-updater/backups/20261018T170600Z-update-host-20261018170557/`  
（对应部署 job `update-host-20261018170557`，切到 76cf6b6 / 0.1.27 之前留下）

| 文件 | 大小（约） | 校验 |
|------|------------|------|
| `openbot.dump` | 6.9M | `file` → PostgreSQL custom v1.15；`pg_restore --list` TOC **752** 条，其中 **TABLE DATA ≈ 150**；dbname `openbot`，PG 16.15 |
| `compose.yaml` | 1.9K | 镜像行 `local/chisabot:auto-202610181702-b463e7f`（上一版 0.1.26） |
| `image.txt` | 41B | 同上标签 |
| `profiles-volume.tgz` | 115M | `tar -tzf` 可读 |
| `workspace-volume.tgz` | 104K | 26 条目，可读 |

另有两份较旧备份（同目录 `ls -1dt`）：`20261018T170253Z-…`、`20261018T165205Z-…`。更新器默认 `KEEP_BACKUPS=5`。

## 3. 回滚脚本（最新）

| 项 | 值 |
|----|-----|
| 脚本 | `/opt/openbot-zh/rollback-to-auto-202610181702-b463e7f.sh` |
| 含义 | 从当前 `…76cf6b6`（0.1.27）回到 `…b463e7f`（0.1.26） |
| `bash -n` | **syntax_ok** |
| 可执行位 | 是 |
| 目标镜像 | `docker image inspect local/chisabot:auto-202610181702-b463e7f` → **存在** |
| 行为摘要 | flock → 改 `.env` 的 `CHISABOT_IMAGE`（或 compose）→ `docker compose up -d --wait` → 探 `/health` 与公网 login → `ROLLBACK_DONE` |
| 数据库 | **不回退**（设计如此；数据恢复另用 `openbot.dump`） |

同目录仍有指向 `6d2fd49` / `bd25568` / `54c54d3` / `248a6bc` 的脚本；能否用取决于 `KEEP_IMAGES` 是否还留着对应镜像。

## 4. Dry-run 结论

| 检查 | 结果 |
|------|------|
| 备份目录非空且权限 `0700` 父目录 | 通过 |
| `openbot.dump` TOC 可列出（只读） | 通过 |
| 卷 tarball 可读 | 通过 |
| 最新 `rollback-to-*.sh` 语法 + 目标镜像在 | 通过 |
| 当前容器 healthy 且版本与 `/api/version` 一致 | 通过（0.1.27） |
| 真实执行回滚 / `pg_restore` 进库 | **未做**（无变更窗口；避免打断） |

**错误预算含义**：若下次健康检查失败触发自动回滚，预期会跑上述脚本族；本演练确认「脚本在、镜像在、转储可读」。

## 5. 真回滚时怎么做（变更窗口）

应用镜像（只换镜像，库不动）：

```sh
ls -t /opt/openbot-zh/rollback-to-*.sh | head -3
TAG=$(ls -t /opt/openbot-zh/rollback-to-*.sh | head -1 | xargs -n1 basename | sed 's/^rollback-to-//;s/\.sh$//')
docker image inspect "local/chisabot:$TAG" >/dev/null
sh /opt/openbot-zh/rollback-to-$TAG.sh
curl -s 127.0.0.1:3001/api/version
bash /opt/chisabot-updater/post-deploy-smoke.sh
```

或网页：设置 → 系统更新 →「回滚到上一版」。

数据库恢复（破坏性，先再 dump 一份当前库）：

```sh
BK=/opt/chisabot-updater/backups/<时间>-<任务>
# 停写或停应用后：
# pg_restore --clean --if-exists -d openbot "$BK/openbot.dump"
# 具体库名/角色以 compose 为准；恢复前对当前库再 pg_dump 一次。
```

## 6. 下次演练建议

- 选低峰窗口：**真跑一次** `rollback-to-*.sh` 再到原版本（或 revert PR），并跑 `post-deploy-smoke.sh`。
- 可选：把 `openbot.dump` restore 到一次性旁路 Postgres 容器做完整逻辑校验，仍不碰生产库。
