# 切流回滚窗口（traffic-cut rollback）

[← 运维手册总览](README.md) · 相关：[deploy.md](deploy.md) §3 · [backup-rollback-drill.md](backup-rollback-drill.md) · [incidents.md](incidents.md)

> 目标：在**约定窗口内**把应用镜像切回上一版（或指定 `auto-…` 标签），库不动；脚本默认 **dry-run / no-op**，只有显式 `CUTBACK_EXECUTE=1` 才动流量。

## 1. 窗口与 RTO

| 项 | 值 |
|----|-----|
| 回滚窗口 | 最近 **`KEEP_IMAGES`** 个 `local/chisabot:auto-*` 镜像仍在本机（默认 **5**，见 `deploy/updater/config.env`） |
| 双标签保底 | 更新器清理时**不删**当前镜像与上一版（`CUR_IMAGE`）；即使 `KEEP_IMAGES` 被改小，至少能回一步 |
| **RTO（切镜像）** | **约 2–5 分钟**：`compose up --wait`（≤180s）+ `health.sh` / `post-deploy-smoke.sh` |
| **RPO（数据）** | 本路径**不回退数据库**；需要数据恢复另用 `backups/*/openbot.dump`（破坏性，另开变更窗口） |
| 默认安全姿势 | `scripts/ops/cutback.sh` **不执行**回滚，只证明镜像在、脚本语法对、打印 would_run |

超过窗口（镜像已被 prune）：走 revert PR + 正常 `deploy-serial.sh`，或 `request.sh update --full` 检出旧提交。

## 2. 工具

仓库脚本（拷到宿主机 `/opt/chisabot-ops/` 亦可）：

```sh
# 列表：当前容器、auto- 镜像、rollback-to-*.sh、KEEP_IMAGES
sh scripts/ops/cutback.sh --list

# Dry-run（默认）：上一版标签 + docker image inspect + bash -n + 打印 would_run
sh scripts/ops/cutback.sh
sh scripts/ops/cutback.sh --tag auto-202610181747-eb83b73

# 真切流（变更窗口内）：显式环境变量，禁止误触
CUTBACK_EXECUTE=1 sh scripts/ops/cutback.sh
```

等价手工路径（与网页「回滚到上一版」相同）：

```sh
ls -t /opt/openbot-zh/rollback-to-*.sh | head -1
sh /opt/openbot-zh/rollback-to-<tag>.sh
# 或：sh /opt/chisabot-updater/request.sh rollback
curl -s 127.0.0.1:3001/api/version
bash /opt/chisabot-updater/post-deploy-smoke.sh
```

`deploy-serial.sh` 用于**向前**部署某个 main 提交；切回已构建过的旧镜像请用本页 cutback / `rollback-to-*.sh`，不要为了回滚去「部署一个旧 sha」除非镜像已不在。

## 3. Haupt dry-run 记录（2026-10-19）

| 项 | 值 |
|----|-----|
| 主机 | Haupt（生产；本文不写公网 IP） |
| 当时运行 | `local/chisabot:auto-202610181759-7132ff3` · **v0.1.31** |
| 上一版脚本 | `rollback-to-auto-202610181747-eb83b73.sh`（v0.1.30） |
| `docker image inspect` 上一版 | **存在** |
| `cutback.sh`（无 EXECUTE） | DRY-RUN 通过；**未**切流量 |
| 当时 `KEEP_IMAGES` | 演练后主机改为 **5**（与本版默认一致） |

完整备份转储演练见 [backup-rollback-drill.md](backup-rollback-drill.md)。

## 4. 值班检查清单

1. `sh cutback.sh --list` → 至少看到当前 + 上一 `auto-` 镜像。  
2. `sh cutback.sh` → DRY-RUN 绿（image present、syntax ok）。  
3. 真故障且在窗口内 → 变更窗口 + `CUTBACK_EXECUTE=1`；切完看 `/api/version` 与烟雾。  
4. 磁盘紧时优先保回滚镜像，再砍 build cache（[cleanup.md](cleanup.md)）。
