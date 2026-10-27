# 主机与端口规划

[← 运维手册总览](README.md)

## 1. 主机

一台 Linux 服务器就能跑完整的 ChisaBot（应用、数据库、网关、更新器）。

| 项 | 建议 | 说明 |
|---|---|---|
| 系统 | 带 systemd 的 64 位 Linux（例如 Ubuntu 24.04） | 更新器、证书重载、看门狗都是 systemd 单元 |
| CPU / 内存 | 4 核 / 8 GB 起；完整构建建议 6 核 / 16 GB 以上 | 完整构建默认限 6 GB（`FULL_BUILD_MEMORY`），4 GB 机器设 `3g` 并加 swap |
| 磁盘 | 100 GB 起，建议 200 GB 以上 | 镜像（每个约 5–6 GB）、构建缓存、5 份更新备份、数据库卷；见 [cleanup.md](cleanup.md) |
| 软件 | Docker Engine、Docker Compose v2、docker buildx、git、python3、Bun 1.3.14（构建用） | 版本见 [自托管部署](../../deploy/README.zh-CN.md) |
| 时区 | 建议主机用 UTC | 镜像标签、备份目录、日志都用 UTC 时间，排查时换算成本地时间 |

可选：一台**待机副本**（停止状态的同版本部署 + 数据库备份），用于整机迁移或主机故障时切换。切换方式参考
[incidents.md](incidents.md) §3「整机迁移」。

访问方式：

- 用 SSH 密钥登录（禁用密码登录），私钥只放在维护者自己的电脑 / 密钥管理工具里，不放仓库、不放服务器。
- Windows 维护者可以用 [`deploy/configure.ps1`](../../deploy/configure.ps1) / [`connect.ps1`](../../deploy/connect.ps1)，
  先核对服务器指纹写入 `known_hosts`（脚本用 `StrictHostKeyChecking=yes`）。

## 2. 公网端口

| 入口 | 默认端口 | 后端 | 说明 |
|---|---|---|---|
| ChisaBot 网页 / API | **8443**（TLS） | 网关 nginx → `127.0.0.1:3001` | 每个请求先经 `auth_request` 到登录服务 `127.0.0.1:3002` |
| 公开页面 | 8443 `/p/<slug>/` | 同上 | 不需要登录，只允许 GET / HEAD，CSP sandbox（[pages.md](../pages.md)） |
| Magpie 管理（可选） | **2053**（TLS） | 网关 → `127.0.0.1:3430` | 只有管理员可进；也可以只用应用内嵌的 `/magpie-admin/` |
| 客户端更新源（可选） | 443 | 你自己的静态站点 | `https://<YOUR_DOMAIN>/downloads/chisabot-pc/` 等，见 [client-release.md](client-release.md) |
| SSH | 22（建议改） | sshd | 只允许密钥 |

端口都可以改：网页端口改 `deploy/.env` 的 `CHISABOT_HTTPS_PORT` 和 `deploy/public/nginx.conf` 的 `listen`，并同步
`auth/config.json` 的 `publicOrigin`、`TRUSTED_ORIGINS`、更新器的 `PUBLIC_HEALTH_URL`。8443 / 2053 是 Cloudflare 代理支持的
HTTPS 端口，套 CDN 时方便；不套 CDN 时用 443 也可以。

套 CDN（例如 Cloudflare 代理）时：

- 源站证书用真实证书，CDN 的 SSL 模式用「完全（严格）」。
- 网关访问日志记录 `CF-Connecting-IP`，否则看到的都是 CDN 的地址。
- WebSocket 和 SSE 需要 CDN 支持长连接（聊天 SSE 不能被缓冲）。

## 3. 只绑 loopback / 内部网络的端口

| 端口 | 是什么 |
|---|---|
| `127.0.0.1:3001` | 应用（单管理员后端，**绝不能直接对外开放**） |
| `127.0.0.1:3002` | 登录服务（host 网络） |
| `127.0.0.1:3425` / `3430` | Magpie API / 管理端口 |
| `127.0.0.1:31xx–32xx`（示例段） | 预览容器，用完即拆，见 [preview.md](preview.md) |

检查：`ss -ltnp` 里除了 22 / 8443 / 2053（以及你自己的其他站点）外，不应有监听 `0.0.0.0` 或 `[::]` 的 ChisaBot 端口；

## 4. 防火墙

- 主机入站只放行 SSH 和网关端口（以及你其他站点需要的端口）。
- Docker 发布的端口会绕过 `ufw` 之类的前端规则，所以 compose 里一律写成 `127.0.0.1:<端口>:<端口>`。

## 5. 同机运行其他服务

ChisaBot 可以和别的站点共用一台机器（共用 80 / 443 的反代、共用 Docker）。这时：

- 网关只占用自己的端口，nginx 配置不要覆盖其他站点。
- 清理镜像 / 卷、`docker system prune`、重启 Docker、改防火墙之前，先列出其他项目的容器、镜像和卷，确认不会误删
  （[cleanup.md](cleanup.md)）。
- 资源紧张时，完整构建可以用 `PROTO_CONTAINERS` 临时暂停指定容器腾内存（更新器 `config.env`）。
