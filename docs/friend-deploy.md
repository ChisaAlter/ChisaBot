# 好友可装包（一键 compose）

> Track D / PRD-P2-04 · 基准 v0.1.30  
> 把 ChisaBot 装成「可以分享给朋友」的自托管助手：安全默认先到位，再谈公网与多账号。

相关：[自托管部署](../deploy/README.zh-CN.md)、[HTTPS 登录网关](../deploy/public/README.zh-CN.md)、[朋友账号](accounts.md)、[信任边界](ops/trust-boundary.md)、[生产清单](production-checklist.md)。

## 一键做什么

在仓库根目录（或 `deploy/`）：

```sh
sh deploy/friend-up.sh
```

脚本会：

1. 若没有 `deploy/.env`，从 `deploy/friend.env.example` 拷一份（权限 600）  
2. 为空的 `KEY_ENCRYPTION_KEY`（以及已填域名 / 多账号时的 `CHISABOT_GATEWAY_SECRET`）生成随机值，**不打印密钥**  
3. 硬检查：应用 compose 必须绑 `127.0.0.1:3001`；拒绝把单用户 `TRUSTED_ORIGINS` 配成 https 公网  
4. 需要时构建前端，再调用 `deploy/start.sh` 起容器  

起来后本机只在 **http://127.0.0.1:3001**。公网必须再走 HTTPS 登录网关，**禁止**把 `:3001` 直接映射到 `0.0.0.0`。

## 安全默认（相对裸 `.env.example`）

| 项 | 好友包默认 | 为何 |
|----|------------|------|
| 应用端口 | `127.0.0.1:3001` | 单用户 = 无登录；公网直连 = 人人管理员 |
| `TRUSTED_ORIGINS` | 仅 localhost / 127.0.0.1 | 与 `OPENBOT_SINGLE_USER` 共存；公网 Origin 在网关层 |
| 遥测 | `COPILOTKIT_TELEMETRY_DISABLED` + `DO_NOT_TRACK` | 自托管不外泄使用痕迹 |
| Secure cookie | https 公网 URL 或 `CHISABOT_SECURE_COOKIES=1` 时 Better Auth 强制 Secure | PRD-P2-04；网关 Cookie 本身已是 Secure |
| 私网 egress | 不默认开 `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | 机器人浏览器不随便打内网 |
| 确认偏好 | 未设 = 先问（付款锁定） | 见 [confirmations.md](confirmations.md) |

应用启动时仍会拒绝「单用户 + 公网 `OPENBOT_PUBLIC_URL` / `TRUSTED_ORIGINS`」组合（已有 `singleUserAllowed`）。

## 公网与分享给朋友

1. **HTTPS 网关**：按 [deploy/public/README.zh-CN.md](../deploy/public/README.zh-CN.md) 配证书与 `render-nginx.sh`，只开放自己的 HTTPS 端口。  
2. **多账号邀请**：`.env` 设 `CHISABOT_ACCOUNTS_UI=1`，登录网关 `config.json` 设同一 `identitySecret` / `CHISABOT_GATEWAY_SECRET`，并 `"invites": true`。设置 → 账号 →「邀请朋友」。详见 [accounts.md](accounts.md)。  
3. **网页里**：设置 → **分享给朋友**（本版新增）用同一套 ChisaBot 界面说明两条路径：邀请进你的实例，或让朋友自己 `friend-up.sh`。

## 明确不做

- 不 resume 电车类定时  
- 不把真机 CB-017/018 / 0.2.0 客户端门槛绑在本包上  
- 不用 Cursor cloud agents  
