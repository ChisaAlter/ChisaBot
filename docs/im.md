# IM 接入：把机器人接到 QQ、微信、飞书、企业微信、钉钉、Telegram

设置 →「IM 接入」。每个**连接** = 一个平台账号 → 你的一个机器人：在那个平台上给它发消息，就由你选的机器人回复。

- 连接只属于你一个人，凭据（App Secret、Token 等）用部署的密钥加密存在你自己的数据库里，接口只回「已保存」，不回原文。
- 同一个平台可以接多个账号；不同连接可以对接不同的机器人。
- **私聊直接回复；群里只有 @ 机器人（或回复它的消息）才回复。**
- 在平台里发 `/new`（或「新话题」）开始新话题，`/id` 查看自己的用户 id（绑主人、填白名单用），`/help` 看说明。
- 每个（连接，会话）一条对话：同一个人私聊是一条，一个群是一条；机器人记得这条对话里之前说过的话。这些对话不出现在网页的「历史对话」里。
- 机器人以**你的身份**运行，会用到你的记忆、账号和插件。谁能用由两个名单决定，**都不填 = 机器人不理任何人**：
  - **主人的平台用户 id**：只填你自己。主人能聊天，也是唯一能在私聊里回复「允许 / 拒绝」审批待确认操作的人（群里、白名单里的其他人、别的对话的待确认都批不了；待确认详情只推私聊）。扫码绑定的平台（微信、QQ 官方、飞书）在绑定成功时会拿到扫码人自己的 id，自动加进主人名单，一般不用手填；
  - **白名单**（一行一个平台用户 id）：这些人也能聊天，但不能在 IM 里审批；
  - 两个名单都空时机器人不会沉默：给私聊它的人回一次「还没绑定主人：发 /id 拿到你的 id，填到连接设置的『主人』里」（同一个发件人 10 分钟内只回一次，群里不吭声）。升级前建的连接会把私聊过的人回填成主人；
  - 「允许使用电脑和设备」默认**关**：关着时机器人在 IM 里不能用云端浏览器和你关联的电脑 / 设备；打开后仍按设备的「询问」规则，需要审批的操作要去网页上确认；
  - 「允许内网地址」默认**关**，且**只有管理员能改**：打开后这个连接里管理员配置的协议端地址可以指向本机 / 内网 / Docker 容器（云元数据地址照样拦截）；用户和模型给的网址永远不放行。
- IM 里只能回文字：机器人不会在 IM 里画卡片 / 面板（render_ui、面板工具不提供）；附件（图片、文件、语音）这一版只告诉机器人「收到一张图片」，不发内容。
- 连接页能看到每个连接的状态（已连接 / 连接中 / 出错 + 原因 / 已停用 / 等待协议端连入）、最后一条消息的时间、「测试连接」和最近 100 条日志。断线会自动重连（1 秒起，指数退避，最长 1 分钟）。
- 运维开关：环境变量 `CHISABOT_IM=0` 让服务器开机时不连任何平台。

| 平台 | 方式 | 需要公网地址吗 | 官方？ |
| --- | --- | --- | --- |
| 飞书 / Lark | 自建应用 · 长连接 | 不需要 | 官方 |
| QQ 官方机器人 | QQ 开放平台 · WebSocket 网关 | 不需要 | 官方 |
| QQ 个人号 | OneBot 11（NapCat / LLOneBot） | 正向不需要；反向要能访问 ChisaBot | **非官方，有封号风险** |
| 企业微信 | 智能机器人 API 模式 · 长连接 | 不需要 | 官方 |
| 个人微信 | 微信 ClawBot（iLink）· 扫码授权 | 不需要 | 官方（灰度中） |
| 钉钉 | 企业内部应用机器人 · Stream 模式 | 不需要 | 官方 |
| Telegram | Bot API · 长轮询 | 不需要（服务器要能访问 api.telegram.org） | 官方 |

---

## 飞书

1. 打开 [飞书开放平台](https://open.feishu.cn/app)（国际版 Lark：open.larksuite.com）→ 创建**企业自建应用**。
2. 「添加应用能力」→ 添加**机器人**。
3. 「权限管理」开通：
   - `im:message`（获取与发送单聊、群组消息）
   - `im:message.p2p_msg:readonly`（读取用户发给机器人的单聊消息）
   - `im:message.group_at_msg:readonly`（接收群聊中 @ 机器人消息事件）
4. 「凭证与基础信息」复制 **App ID**、**App Secret** → ChisaBot 设置 → IM 接入 → 添加连接 → 飞书，填进去，选机器人，「保存并连接」。状态变成「已连接」再做下一步（飞书要求先有长连接在线，才允许把订阅方式改成长连接）。
5. 回到飞书「事件与回调」→ 订阅方式选**使用长连接接收事件** → 添加事件 **接收消息 `im.message.receive_v1`**。
6. 「版本管理与发布」创建版本、发布（企业管理员审核通过后生效）。
7. 在飞书里搜索机器人名字私聊，或把它拉进群 @ 它。

回复用飞书富文本的 `md` 标签，飞书客户端会显示 Markdown；失败时自动改发纯文本。

## QQ 官方机器人

1. 打开 [QQ 开放平台](https://q.qq.com) 注册开发者（个人也可以），创建机器人。
2. 「开发设置」复制 **AppID**、**AppSecret**，填进 ChisaBot。
3. 「沙箱配置」把自己的 QQ 号、要测试的 QQ 群加进沙箱。机器人上线（提审通过）前，只有沙箱里的人和群能用。
4. 若开放平台要求 **IP 白名单**，把 ChisaBot 服务器的公网 IP 加进去。
5. 「接收范围」默认「QQ 私聊和 QQ 群」；要用 QQ 频道选「QQ 私聊、QQ 群和频道」（频道机器人需要在开放平台开通对应能力）。

注意：

- QQ 群只推送 @ 机器人的消息；私聊直接推送。
- 被动回复有时限（群约 5 分钟、私聊约 60 分钟），机器人想得太久回复可能发不出去，日志里会写原因。
- QQ 不允许在消息里带未报备的网址：发送被拒时 ChisaBot 会把网址换成「[链接已省略]」重发一次。
- QQ 官方已经推荐 Webhook 方式；WebSocket 网关目前仍可用，这一版用 WebSocket（不需要公网回调地址）。

## QQ 个人号（OneBot 11）

> ⚠️ 这不是 QQ 官方接口。协议端模拟 QQ 客户端登录，腾讯可能限制或封禁这个号。**请用小号**，不要用常用号，不要在大群里刷屏。

1. 在一台能常开的电脑 / 服务器上安装 [NapCat](https://github.com/NapNeko/NapCatQQ)（推荐）或 [LLOneBot](https://github.com/LLOneBot/LuckyLilliaBot)，用要当机器人的 QQ 号扫码登录。
2. 二选一：
   - **正向 WebSocket**：在协议端网络配置里新建「WebSocket 服务端」，监听 `0.0.0.0:3001`，设置 token。ChisaBot 里连接方式选「正向」，地址填 `ws://协议端IP:3001`，Access Token 填同一个 token。ChisaBot 服务器要能访问这个地址。**注意**：地址指向本机 / 内网 / Docker 兄弟容器（`ws://127.0.0.1:3001`、`ws://192.168.x.x:3001`、`ws://napcat:3001`）时，需要管理员在这个连接里打开「允许内网地址」开关才连得上——开关只对这个连接自己配置的协议端主机名生效，云元数据地址照样拦；没有管理员改不了开关时，请改用反向。
   - **反向 WebSocket（推荐）**（协议端在家里内网、ChisaBot 在公网时用）：ChisaBot 里连接方式选「反向」，保存后弹窗会显示「地址」（`wss://你的域名/api/im/onebot/<连接id>`）和 Token；在协议端新建「WebSocket 客户端」填进去。
3. 消息格式 array / string 都可以。

自部署的人注意：如果 ChisaBot 前面有登录网关（像本仓库 `deploy/` 的登录页），要让 `/api/im/onebot/` 不经过登录校验、并支持 WebSocket 升级（和 `/api/devices/agent/` 一样）——这条路只认连接自己的 token，失败 20 次 / 10 分钟会被限速。协议端不是浏览器，连进来时不带 `Origin`：网关如果拒绝「没有 Origin 的 WebSocket 升级」（本仓库 nginx.conf 的 `$socket_origin_allowed`），要对这条路放行，同时把 `Authorization` 原样转给后端。

## 企业微信智能机器人

1. [企业微信管理后台](https://work.weixin.qq.com/wework_admin/frame) → 应用管理 → **智能机器人** → 创建机器人 → **API 模式**。
2. 连接方式选**长连接**，复制 **Bot ID**、**Secret**，填进 ChisaBot。
3. 设置可见范围（谁能和它聊）。
4. 在企业微信里找到机器人私聊，或把它加进群里 @ 它。

回复是流式消息（先显示「正在思考」，答完一次性换成完整 Markdown）；超出一条的部分主动发送。同一个机器人同时只能有一个长连接：如果在别处（比如另一个程序）也连了，这边会被顶掉，状态显示原因，5 分钟后再试。

> 企业微信「自建应用」（回调模式）需要公网回调地址和消息加解密，这一版没有做；智能机器人不需要公网地址，功能足够时优先用它。

## 个人微信（微信 ClawBot）

这是微信官方开放给 AI 助手的接口（iLink Bot API，`https://ilinkai.weixin.qq.com`）：

1. 手机微信更新到最新版本。
2. ChisaBot 添加连接 → 个人微信 → 点「**扫码授权**」，用要接入的微信扫码并在手机上确认。授权令牌只存在服务器上，浏览器拿不到。
3. 保存。在微信里找到 **ClawBot（微信助手）** 发消息，就由你选的机器人回复。

注意：仍在灰度，部分账号 / 版本可能用不了；授权过期后状态会显示「授权已过期」，编辑连接重新扫码即可。目前只支持私聊。

## 钉钉

1. [钉钉开放平台](https://open-dev.dingtalk.com) → 应用开发 → 企业内部应用 → 创建应用 → 添加「**机器人**」能力。
2. 机器人配置里**消息接收模式选「Stream 模式」**，发布。
3. 「凭证与基础信息」复制 **Client ID（AppKey）**、**Client Secret（AppSecret）**，填进 ChisaBot。
4. 在钉钉里私聊机器人，或把它加进群 @ 它。回复用消息里的 sessionWebhook 发 Markdown。

## Telegram

1. Telegram 里找 [@BotFather](https://t.me/BotFather)，发 `/newbot` 创建机器人，复制 **Bot Token**，填进 ChisaBot。
2. 要在群里用：把机器人拉进群；保持 BotFather 的 privacy mode 开启即可（群里 @ 它或回复它的消息才会收到）。
3. 同一个 Token 只能有一个地方收消息：如果别处在用这个 Token（或设置了 webhook），状态会显示冲突原因。
4. 服务器访问不了 api.telegram.org 时，「API 地址」可以填反向代理。

---

## 实现与来源

代码在 `server/src/im/`（`service.ts` 存库、排队、跑回合；`adapters/*.ts` 每个平台一个；`feishu-proto.ts` 飞书长连接帧编解码），设置页在 `app/src/routes/_authed/settings/im.tsx` + `app/src/components/im/im.tsx`，平台清单和字段在 `shared/im.ts`。设计说明见 DESIGN.md §49。

参考过的开源项目（只借鉴设计和公开协议格式，**没有复制 GPL / AGPL 代码**）：

| 项目 | 许可 | 借鉴了什么 |
| --- | --- | --- |
| [LangBot](https://github.com/langbot-app/LangBot) | Apache-2.0 | 平台清单和每个平台的配置项；飞书长连接、QQ 官方 WebSocket、企业微信智能机器人长连接（`aibot_*` 帧）、个人微信 ClawBot / iLink 接口（扫码、getupdates、sendmessage、context_token）的消息格式与流程 |
| [飞书 Node SDK](https://github.com/larksuite/node-sdk) | MIT | 长连接 `/callback/ws/endpoint` 握手、pbbp2 帧字段号、ping / pong、分片合并和回执 |
| [OneBot 11 标准](https://github.com/botuniverse/onebot-11) · [NapCat](https://github.com/NapNeko/NapCatQQ) | 标准文档 | 正向 / 反向 WebSocket、消息段、CQ 码、`send_*_msg` 动作 |
| [AstrBot](https://github.com/AstrBotDevs/AstrBot) | AGPL-3.0 | 只参考产品形态（一个连接对一个机器人、群里 @ 才回），未使用代码 |
| [cc-connect](https://github.com/chenhg5/cc-connect) | 未声明许可 | 只参考产品形态（会话命令 `/new`），未使用代码 |
| [Koishi](https://github.com/koishijs/koishi) · [NoneBot2](https://github.com/nonebot/nonebot2) 适配器 | MIT | 适配器抽象（平台无关的入站消息 + 回复接口）的思路 |
