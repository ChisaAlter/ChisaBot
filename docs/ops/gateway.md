# 网关与登录服务

[← 运维手册总览](README.md)

首次安装按 [deploy/public/README.zh-CN.md](../../deploy/public/README.zh-CN.md) 做。本页讲装好之后的维护。两者都**不随一键更新**。

## 1. 结构

```
浏览器 ──HTTPS──▶ openbot-public-gateway（nginx，host 网络，:8443 / :2053）
                     │ auth_request
                     ├──────────▶ openbot-web-auth（登录服务，127.0.0.1:3002，会话库 SQLite）
                     ▼
               openbot-zh（应用，127.0.0.1:3001）
```

- 模板：[`deploy/public/nginx.conf`](../../deploy/public/nginx.conf)（模板里的 `chisabot.example.com`、8443、2053 是占位；`render-nginx.sh` 按 `deploy/.env` 的 `CHISABOT_DOMAIN`、
  `CHISABOT_HTTPS_PORT`、`CHISABOT_MAGPIE_PORT`、`CHISABOT_CERT_NAME` 生成 `nginx.generated.conf`，再在 `.env` 设
  `CHISABOT_NGINX_CONF=./nginx.generated.conf`）、
  [`auth/server.ts`](../../deploy/public/auth/server.ts)、`auth-web/`（登录页、Magpie 登录页、`updating.html`）。
- 部署后的文件：`/opt/openbot-zh/public/`（[layout.md](layout.md)）。

## 2. nginx 网关

## 2.1 模板与生产同步（v0.1.34 · apply-or-fail）

网关 **不**随应用一键更新；以前手工改过 `/opt/openbot-zh/public/nginx.conf` 后，仓库模板与生产会漂移（v0.1.33 曾因此漏清 Local-Caller）。现用脚本强制对齐：

| 命令 | 场景 |
|---|---|
| `sh scripts/ops/sync-nginx.sh --check-repo` | CI / 合并前：模板 + 合成渲染仍含 Local-Caller 清头与安全标记 |
| `sh scripts/ops/sync-nginx.sh --check` | 宿主机：对照 live `nginx.conf` / `nginx.generated.conf`；漂移 → **非 0**（不要忽略） |
| `sh scripts/ops/sync-nginx.sh --apply` | 宿主机：按 `deploy/.env` 渲染 → 备份 → 安装 → `nginx -t` → reload |
| `sh scripts/ops/sync-nginx.sh --apply --dry-run` | 只渲染校验，不写盘 |

`deploy-serial.sh` 在镜像切换成功后默认跑 `--check`（`CHISABOT_SYNC_NGINX=check`）。若要随发版自动套模板：`CHISABOT_SYNC_NGINX=apply sh deploy-serial.sh …`。脚本找不到时跳过并打日志；**有**脚本而 check 失败则部署退出码 **7**。

相关：`scripts/ops/check-trust-boundary.sh` §5、[trust-boundary.md](trust-boundary.md) §7。


**改法**：

```sh
cd /opt/openbot-zh/public
cp nginx.conf nginx.conf.bak-<说明>-$(date +%Y%m%d)
# 改 nginx.conf（或从仓库模板重新渲染）
docker exec openbot-public-gateway nginx -t && docker exec openbot-public-gateway nginx -s reload
```

需要回退时写一个 `rollback-<说明>-<日期>.sh`：拷回备份 → `nginx -t` → reload。

**模板里的特殊规则**（改之前先理解它们为什么存在）：

| 规则 | 原因 |
|---|---|
| `/api/devices/agent/` 不要求登录 | PC / 节点用设备令牌连接，不带浏览器 Cookie |
| `/api/im/onebot/` 转发 `Authorization`，且只在这里允许没有 Origin 的 WebSocket 升级 | IM 机器人（OneBot）从服务器端连接 |
| `^~ /p/`：公开、只允许 GET / HEAD、不转发 Cookie、`X-Frame-Options SAMEORIGIN` | 公开页面不能读到登录态；跨站子资源 GET 用 `$fetch_allowed` 放行 |
| 带哈希的 `/assets/*` 可长缓存 | 文件名随内容变化 |
| `auth_request_set $cb_identity` → `X-ChisaBot-Identity` | 多账号时把签名身份传给应用；在 `/api/devices/agent/`、`/api/im/onebot/`、`/p/` 上**清空**，防伪造 |
| 502 / 503 / 504 → `/auth/updating.html` | 更新切换的十几秒里显示「正在更新」，页面自动重试 |
| 访问日志带 User-Agent 和 `CF-Connecting-IP` | 套 CDN 时能看到真实来源 |
| 2053 的 auth-check 带 `X-ChisaBot-Require-Role admin` | Magpie 管理只给管理员 |
| 跨站写入、外站 Origin、缺 Origin 的 WebSocket 一律拒绝 | CSRF 防护 |
| 聊天 SSE 不缓存、不缓冲 | 流式回复 |

## 3. 登录服务

- 改法：拷 `auth/server.ts` / `auth-web/*` 到网关目录 → `docker restart openbot-web-auth`。会话库原地加列，已有登录不受影响。
- 自带测试：`docker exec openbot-web-auth bun test /auth/server.test.ts /auth/startup-report.test.ts`。
- 管理员账号和密码哈希在 `auth/config.json`（键：`username`、`passwordHash`、`publicOrigin`，多账号时还有 `identitySecret`、`invites`）。
  改密码：按 [deploy/public/README.zh-CN.md](../../deploy/public/README.zh-CN.md)「初始化认证配置」重新生成哈希；旧会话会失效。
- 登录页不预填账号名。
- 会话：普通 12 小时，记住登录 30 天；连续失败会暂停。

## 4. 多账号（朋友账号，默认关闭）

详见 [accounts.md](../accounts.md)。开关有两个，**生产默认都关**：

| 开关 | 位置 | 作用 |
|---|---|---|
| `"invites": true` | 网关 `auth/config.json`，改后重启登录服务 | 允许管理员发邀请、新账号注册 |
| `CHISABOT_ACCOUNTS_UI=1` | 应用 `.env`，改后重建应用容器 | 设置里显示「账号」页 |

启用顺序：① 登录服务新版本 + `config.json` 的 `identitySecret` + nginx 新模板 ② 应用 `.env` 加同值的 `CHISABOT_GATEWAY_SECRET`
③ 部署 / 重建应用。回滚网关时**先把 `.env` 里 `CHISABOT_GATEWAY_SECRET` 去掉并重建应用**，再换回旧网关。

- 内置管理员在应用里的身份是 `dev-local-user`（代码默认值，单用户模式下的本地管理员 id），不能被禁用或删除。
- 删除网关账号不会删应用里的数据；需要清理时按 `u_<id>` 删除该用户的机器人和对话，并且脚本要拒绝内置管理员 id。

**签名身份密钥轮换**：三处一起改（主副本文件、`auth/config.json` 的 `identitySecret`、`.env` 的 `CHISABOT_GATEWAY_SECRET`），
然后重启登录服务、重建应用。三处不一致时，应用会拒绝网关传来的身份。

## 5. 证书

- 证书放 `/etc/letsencrypt/live/<YOUR_DOMAIN>/{fullchain.pem,privkey.pem}`，网关挂载整个证书根目录（`CHISABOT_CERT_DIRECTORY`）。
- 续期用 acme.sh 或 certbot 的定时任务；续期后 `openbot-public-cert-reload.timer`（每天一次）运行 `reload-cert.sh`：先 `nginx -t` 再 reload。
- 安装 timer 前把 service 里的 `/opt/openbot-zh/public` 改成实际目录。
- 检查到期时间：`openssl x509 -enddate -noout -in /etc/letsencrypt/live/<YOUR_DOMAIN>/fullchain.pem`。

## 6. 备份

网关相关的需要备份：`auth/config.json`、`auth-data/sessions.sqlite`（用 SQLite 备份接口或停服务后复制）、`magpie-private.conf`、
`nginx.conf`、`secrets/`。都不进 Git。
