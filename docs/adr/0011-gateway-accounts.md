# ADR-0011：朋友账号放在登录网关里，网关签名告诉应用「这是谁」

- 状态：已采纳
- 日期：2026-10-15
- 相关：DESIGN.md §65（账号）、[docs/accounts.md](../accounts.md)、BACKLOG CB-040、ADR-0002（设备属于账号）

## 背景

用户 2026-10-15 00:28：想把 ChisaBot 分享给朋友用。生产一直是「单用户」：应用以 `CHISABOT_SINGLE_USER=true` 运行，所有请求都是同一个
管理员 `dev-local-user`；公网只经过 nginx 网关 + 登录服务（`deploy/public/auth/server.ts`，一个账号、Argon2id、会话 Cookie）。
把这个账号给朋友，朋友就拿到了管理员的机器人、记忆、保险箱和设备（能在用户的电脑上跑命令）。

上游 ChisaBot 自己的多用户走 Better Auth + Google / Microsoft / Okta OAuth，对「发个链接给朋友」太重，而且要求每个人有那些账号。

## 决定

1. **账号在网关里**：登录服务的 SQLite 里加 `accounts`（账号名、显示名、Argon2id 密码、角色、停用）和 `invites`（一次性邀请 /
   重置密码链接，只存 SHA-256）。`config.json` 里原来那个账号仍是内置管理员，不进表、不能在网页上改，对应应用里的
   `dev-local-user`——原有数据一条不动，原有会话（网页、PC、手机）升级后继续有效。
2. **签名身份头**：`config.json` 加 `identitySecret`（≥32 字符）启用多账号。每次 `auth_request` 成功，登录服务在响应头给出
   `X-ChisaBot-Identity: v1.<base64url(JSON{u,n,r,t})>.<HMAC-SHA256>`，nginx 用 `auth_request_set` 原样转给应用（客户端自带的同名头
   被覆盖；不经登录的转发位置把它清空）。应用设 `CHISABOT_GATEWAY_SECRET` 为同一个值后进入「网关身份」模式
   （`server/src/auth/gateway-identity.ts`）：
   - 有头且验签通过、签发时间在 ±2 分钟内 → 这个人（第一次见到的朋友自动在 `users` / `user_roles` 建行，角色以网关为准）；
   - 有头但无效，或者请求经过了网关（带 `X-Forwarded-For` / `X-Real-IP`）却没有头 → 401；
   - 直连 `127.0.0.1:3001`、没有转发头（发布脚本、自检、更新器）→ 管理员，和以前一样。
   CopilotKit 运行（`resolveRequestActor`）、HTTP 路由（`requireUser`）、后台任务（`actorFor` 按主人读角色）用同一个判断。
3. **设备跟着人走**：手机用设备令牌换会话时，应用告诉网关设备主人（`ownerUserId`），会话就是那个人的；主人停用 / 不存在 → 不给会话。
   PC 登录后用会话登记设备，本来就归当前用户。设备只有主人能管理和批准操作，管理员也不能操作朋友的设备；机器人的设备工具只看自己主人的设备。
4. **管理员专属**：管理页（模型、云端浏览器、权限规则、系统更新、活动记录、账号）和 `/api/admin/*` 已有 `requireAdmin`；
   Magpie 管理台（2053）在 nginx 的 `auth_request` 上加 `X-ChisaBot-Require-Role: admin`，朋友得到 403。
5. **管理员聊天列表不出现朋友的私有机器人**（API 层过滤；管理员仍可通过 id 管理任何机器人，上游语义不变）。

## 后果

- 好处：发一个链接就能加朋友；不需要 OAuth；单账号部署（不配 `identitySecret`）行为完全不变；回滚网关文件后朋友会话自动失效、管理员不受影响。
- 代价 / 风险：
  - 同一 Docker 网络里的其它容器（如 Magpie、new-api）直连 `chisabot-zh:3001` 不带转发头时仍是管理员——和改动前一样，没有变差；
  - 朋友能用部署的默认模型（花管理员的额度）；没有每人限额（CB-045 未做）；
  - 网关账号与应用 `users` 行是两份：删除网关账号不删应用里的数据（他的机器人 / 对话留着，只是没人能登录）；
  - 朋友账号目前只能是普通用户（不能在网页上加第二个管理员）。
- 以后什么情况下要重新考虑：要接 Google 账号登录（CB-013）时，可以把 OAuth 也做在网关里，继续用同一个身份头；朋友多到需要配额 / 计费时。

## 考虑过的其他方案

- 打开上游 Better Auth 多用户：要配 OAuth 提供方，朋友要有 Google / Microsoft 账号，且会替换掉现有登录页、手机扫码会话、PC 登录流程，改动面大。
- 网关只转发明文 `X-User` 头（不签名）：nginx 能覆盖客户端的头，但同网络容器能伪造任何人；HMAC + 时间戳几乎不增加成本。
- 账号放应用库里、网关调应用校验密码：网关要依赖应用在线才能登录（部署 / 重启时登录页也挂），且密码校验离开了专门的低权限容器。
