# 朋友账号（多账号）

> **目前默认隐藏（2026-10-15）**：多用户以后再做。应用 `.env` 设 `CHISABOT_ACCOUNTS_UI=1` 才显示 设置 → 管理 →「账号」；登录网关 `config.json` 加 `"invites": true` 才能邀请 / 直接建账号（默认关，未用的邀请链接也打不开）。已有账号、签名身份、按人隔离不受这两个开关影响。

把 ChisaBot 分享给朋友：管理员发一个邀请链接，朋友自己设账号名和密码。每个账号的机器人、对话、记忆、技能、密钥、GitHub 连接、
页面、定时任务、聊天文件、生图 / 识图设置、设备、IM 接入、面板、审批都是分开的；朋友看不到管理员的任何东西，管理页也进不去。
决定与取舍见 [ADR-0011](adr/0011-gateway-accounts.md)，界面见 DESIGN.md §65，条目 BACKLOG CB-040。

## 管理员：怎么邀请朋友

1. 打开 设置 → 管理 → **账号**，点右上角「邀请朋友」。
2. 备注可填朋友的名字（只有你看得到），选有效期（1 / 3 / 7 天），点「生成链接」。
3. 复制弹出的链接（`https://你的地址/login?invite=cbi_…`）发给朋友。链接只能用一次；关掉窗口后看不到完整链接，没用的可以在「未使用的链接」里作废。
4. 朋友打开链接 → 设账号名（以后登录用）、称呼、密码 → 自动登录，得到一个自己的「助手」机器人。
5. 之后朋友用 账号名 + 密码 登录网页、PC 客户端；手机客户端在网页「绑定手机」扫码。
   账号名不分大小写（内置管理员也一样）；朋友不能取和管理员同名的账号名。

其它操作（账号行右边「⋯」）：**重置密码**（生成 24 小时有效的链接发给他，设好新密码后旧密码和所有已登录设备失效）、**停用 / 恢复**
（停用后立刻退出所有设备，数据保留）、**删除账号**（不能再登录；他在 ChisaBot 里的机器人和对话不删）。
内置管理员（服务器 `config.json` 里那个账号）不能在网页上改。

## 部署方：怎么打开

多账号默认关闭；不配置时和以前一样只有一个账号。

1. 生成一个密钥：`openssl rand -base64 48 | tr -d '\n/+='`。
2. 登录服务 `deploy/public/auth/config.json` 加 `"identitySecret": "<密钥>"`（可选 `"adminUserId"`，默认 `dev-local-user`，
   即 `OPENBOT_SINGLE_USER` 时的那个管理员）。
3. 应用环境（`.env`）加 `CHISABOT_GATEWAY_SECRET=<同一个密钥>`（或 `CHISABOT_GATEWAY_SECRET_FILE=/path`）。 本机调用（更新器自检、登录网关的设备状态探测）还要带请求头 `X-ChisaBot-Local-Caller: <同一个密钥>`——应用不再把「没有 X-Forwarded-For」当成管理员（CR-P1-02）；兄弟容器在共享 Docker 网络上直连 :3001 会被拒。紧急逃生：`CHISABOT_TRUST_UNSIGNED_LOCAL=1`（不安全，仅排障）。只在
   `OPENBOT_SINGLE_USER=true` 时生效。
4. nginx 用新模板 `deploy/public/nginx.conf`（`auth_request_set $cb_identity …` + `proxy_set_header X-ChisaBot-Identity …`，
   Magpie 的 `auth_request` 带 `X-ChisaBot-Require-Role admin`）。
5. 依次重启：登录服务 → nginx → 应用。顺序反了也安全：应用先开而网关还没发身份头时，经过网关的请求一律 401（会跳回登录页），直连本机的仍是管理员。

## 怎么工作

```
浏览器 ──Cookie──► nginx ──auth_request──► 登录服务：会话 → 账号 → X-ChisaBot-Identity: v1.<payload>.<HMAC>
                    │  auth_request_set $cb_identity
                    └──X-ChisaBot-Identity──► 应用：验签（±2 分钟）→ actor {id, role} → 所有路由 / 机器人运行
```

- 身份：`{u: 用户 id, n: 显示名, r: admin|user, t: 毫秒}`；管理员的 `u` 固定为 `dev-local-user`，朋友是 `u_` + 12 位随机串。
- 应用判定（`server/src/auth/gateway-identity.ts`）：有效头 → 这个人；无效头，或带 `X-Forwarded-For` / `X-Real-IP` 却没头 → 401；
  直连本机没有转发头 → 管理员（发布脚本、自检、更新器照常工作）。
- 第一次见到的朋友在 `users`（邮箱 `<id>@accounts.chisabot.local`，只是唯一键）和 `user_roles` 建行；之后 `ensureDefaultBot` 给他建「助手」。
- 网关表：`accounts`、`invites`（只存令牌的 SHA-256）、`sessions.user_id`（NULL = 内置管理员）。会话凭据指纹含账号密码哈希：
  重置密码 / 停用 / 删除后旧会话全部失效。登录对不存在的账号也做一次 Argon2 校验，响应时间不泄露账号是否存在；失败限速沿用原来的。
- 手机：`/auth/device-session` 时应用返回设备主人，会话归主人；主人停用 → 401。PC：登录后用会话登记，设备归当前账号。

## 隔离一览

| 区域 | 规则 |
|---|---|
| 机器人 | 私有机器人只有主人能看、能聊；管理员的聊天列表也不列朋友的私有机器人（管理员仍可按 id 管理） |
| 对话 / 历史 / 同步 | 按 `owner_user_id`，别人的对话 id 读不到、换不过去 |
| 记忆、技能（个人）、密钥、GitHub、页面、定时任务、聊天文件、IM、面板、审批偏好 | 全部按主人；共享技能（部署自带）大家都能用，只有管理员能改 |
| 生图 / 识图 | 每个人自己的覆盖；改默认只限管理员 |
| 设备 | 只有主人能看、能管理、能批准；机器人的 `device_*` 工具只看主人的设备；管理员也不能操作朋友的设备（管理员 `?all=1` 只能看到列表） |
| 管理页 / `/api/admin/*` / `/auth/admin/*` | 仅管理员（403）；Magpie 管理台 403 |

## 已知限制

- 朋友用的是部署的默认模型（管理员的额度），还没有每人每天的消息上限（CB-045）。
- 朋友账号只能是普通用户。
- 同一 Docker 网络里的其它容器直连应用端口仍然是管理员（和以前一样）。
- 删除网关账号不删除应用里的数据。
