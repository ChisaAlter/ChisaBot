# ProkBot 对照审查：ChisaBot 欠缺项与优化项

> 2026-11-18 对 `C:\AI\ProkBot`（Grok Bot 私服项目，自部署 Host + Mac/iOS 补丁客户端）做全量代码审查后，
> 与 ChisaBot 现有实现逐点对照的产出。用途：作为改造候选项的评估底稿，不是已批准的工作清单。
> ProkBot 侧引用为 `ProkBot:` 前缀的相对路径；ChisaBot 侧引用为本仓库相对路径。

## 0. 总体判断

- ProkBot 的代码纪律异常高（scrypt、哈希存令牌、timingSafeEqual、CSP、O_NOFOLLOW、DNS 钉扎 SSRF），
  但**架构层面 ChisaBot 在多数对应点上已经更强**：192-bit 一次性配对码（对方 6 位）、`guardedFetch`
  DNS 钉扎、AES-256-GCM 凭据封存、5 种 webhook 签名族、设备 E2EE、确定性审批规则引擎（对方靠 LLM
  分类器且故障模式不可审计）、agent-computer 的 `ACTING_PATHS` 白名单 + 人接管闸门 + 审计先行。
- 因此本文只列**对方有而我们没有**、**对方细节比我们更细**、以及**对方的坑我们要避免**三类。
  对方做得更差的地方（明文凭据、自声明 platform、http:// 接受、全局共享配额）已确认 ChisaBot 不踩，
  列入 §4 反面清单防回归。

## 1. 欠缺项（ProkBot 有、ChisaBot 没有的能力或防护）

### 1.1 Supervisor 静默排空升级 ★高价值
- **现状**：`deploy-serial.sh` 串行重启，进行中的回合（turn）随进程退出被打断。
- **参考**：`ProkBot:host/deploy/host-supervisor.mjs`——`/prepare-upgrade` 握手，新进程就绪且旧进程
  `runningTurns === 0` 后才停；单 child 不变量、5s 退避、SIGTERM→SIGKILL(15s)、健康检查钉 child.pid。
- **建议**：server 侧做「排空协议」：暴露 quiesce 端点，等活跃回合数归零（带上限超时）再退；
  部署脚本先拉起新实例再切流量。注意 `local-conversations.ts` 的租约/恢复语义要覆盖排空窗口。

### 1.2 Host↔Host 联邦协议（方向性）
- **现状**：无跨实例互联；IM/连接器都在单实例内。
- **参考**：`ProkBot:host/server/federation-identity.mjs`、`federation.mjs`、`federation-queue.mjs`——
  一次性邀请令牌换 ed25519 身份（指纹即 hostId）→ 签名信封（purpose+timestamp+nonce+sender-key，
  ±5min）→ digest 幂等去重 → per-peer 能力白名单。
- **建议**：仅当有跨实例共享需求时立项；立项时同时吸收 §4 的两条反面教训（远端不可代批审批、
  配额 per-principal）。

### 1.3 付费外部调用的任务账本
- **现状**：无「按次计费且可恢复」的外部任务抽象。
- **参考**：`ProkBot:host/runtime/media-services.mjs`——`requestKey+inputHash` 去重（输入变更回 409）、
  `providerJobId` 断点恢复防重复扣费、并发≤4、总时长≤20min、输出 magic-sniff + 内容哈希命名 + 0600。
- **建议**：接入按次计费生成类 API 时按此建 ledger；核心是「同一请求键重放不重复扣费」。

### 1.4 文件凭据的读时校验
- **现状**：文件类凭据写时设权限；ProkBot 连**读时也校验** `0600`（`ProkBot:host/deploy/credentials.mjs`
  `(stat.mode & 0o777) !== 0o600` 即拒读），能发现备份/拷贝把权限弄丢的情况。
- **建议**：server 侧文件凭据/令牌读取路径统一加 mode 校验 + `O_NOFOLLOW`。

### 1.5 原子写的唯一 tmp 名
- **参考**：`ProkBot:host/runtime/reliability/tool-journal.mjs:67` 用 `${path}.${pid}.${uuid}.tmp`；
  其 `host-automations.mjs` 用固定 `.tmp`，双进程并存（排空重叠窗口）时互相截断发布半成品。
- **建议**：排查 ChisaBot 文件类 store 的原子写是否用固定 tmp 名；1.1 引入排空后此问题真实存在。

### 1.6 装载物 provenance 清单
- **参考**：`ProkBot:mac/patchers/desktop/release-recipes.mjs` + `recipes/manifest.json`——每件打补丁物料
  钉 `sourceSha256`/`targetSha256`，应用前验证输入哈希，错版本 fail-closed。
- **建议**：迁移为插件/技能包装载校验：清单声明 + 哈希钉 + 只暴露声明过的 binding；与
  `plugins/store.ts` 的 grant/policy/audit 三层挂接（grant 绑到具体 digest 而非裸 id）。

## 2. 值得优化项（双方都有、对方细节更细）

### 2.1 OAuth state 绑定补两点
- **现状**：`server/src/plugins/oauth.ts` 有 PKCE。
- **对照**（ProkBot 做了一半、漏了一半，漏的那半是它的真实漏洞）：
  - `redirect_uri` 必须只来自配置，不能从请求 Host 头推导（`ProkBot:connectors-oauth.mjs:38` 的坑）；
  - state 应绑定**完成者=发起者**（对方只验发起者存活，导致设备发起→管理员完成→凭据共享化）；
  - state 绑 config revision 防止授权途中配置被改；
  - token 交换 `redirect:'error'` 防凭据被重定向带跑。
- **建议**：逐条核对 oauth.ts，缺的补上；refresh 失败只在 `invalid_grant` 类错误清凭据，
  网络错误不清（`ProkBot:connectors-oauth.mjs:183` 的反例）。

### 2.2 审批/确认链路的两条细化
- **现状**：`confirmations/classify.ts` 确定性分类 + `tainted` 污点升格 + locked 类别；结构上优于对方。
- **可优化**：
  - 若未来引入 LLM 辅助审批，输入必须做 `trusted_user_instructions` /
    `untrusted_agent_narration_and_prior_actions` 显式分区 + 输出 enum 校验
    （`ProkBot:host-auto-review.mjs:13-18,49-54`），单布尔 taint 位不够；
  - 远端审批输入的参数做 per-method schema 白名单，不透传整个 args bag
    （`ProkBot:federation-task-bridge.mjs` 的教训：peer 给的 `scope:'always'` 原样执行）。

### 2.3 限流键不能用 socket 地址
- **参考**：`ProkBot:tailcat-ingress.mjs`——隧道 ingress 把所有 peer 折成 `127.0.0.1`，
  per-IP 桶被单 peer 打满全局。
- **建议**：排查 ChisaBot 现有 RateLimit 的 key：凡经 loopback 代理/隧道的入口，限流键必须取
  认证后的身份（用户/设备/peer id），不是 `socket.remoteAddress`；同步确认 X-Forwarded-For
  只在可信代理后启用。

### 2.4 配额按主体而非全局
- **参考**：`ProkBot:federation-tasks.mjs:61` 全局共享 10000 条上限，一个坏 peer 打满全员 429。
- **建议**：队列/历史/任务类上限一律 per-principal（per-user/per-bot/per-peer）计数。

### 2.5 吊销即断活连接
- **参考**：`ProkBot:proxy.mjs DeviceConnections`——按 deviceId 追踪全部活流，吊销即 destroy。
- **建议**：确认 ChisaBot 设备/令牌吊销后，该主体持有的 SSE/WS/长轮询是否即时掐断；
  若只断下次请求则为缺口。

### 2.6 代理头剥离细节
- **参考**：`ProkBot:server/proxy.mjs upstreamHeaders`——除固定黑名单外，把 `Connection:` 头里
  **点名**的 hop-by-hop 字段一并剥掉；响应删 `set-cookie`；上游凭据由代理注入而非透传客户端的。
- **建议**：server 内任何「代表客户端转发」的代码路径（模型代理、媒体、webhook 回调）对照一遍。

### 2.7 已认证路由也要限流和 body 上限
- **参考**：`ProkBot:index.mjs` `/api/*` 有 device 认证但无速率限制、无 body 上限——持牌设备可流式
  打满内存。
- **建议**：排查 ChisaBot 已认证 POST/上传路由是否都有 body cap；SSE 帧解析是否有 64MB 级上限
  （对方 `sseRewriter` 的做法）。

## 3. 已对照确认不欠缺（防止重复审查）

| 项 | ChisaBot 现状 | ProkBot 对照 |
|---|---|---|
| 配对码 | 192-bit `cbp_*` 一次性+5min | 6 位/30-bit，弱很多 |
| 出网 SSRF | `shared/net/guarded-fetch.ts` DNS 钉扎+私网拒 | `media-http.mjs` 同类但 IPv6 漏 NAT64/6to4 |
| 凭据封存 | `personal-sources/service.ts` AES-256-GCM | 仅 connectors 封存，其余明文 |
| Webhook 签名 | `responsibilities/signatures.ts` 5 家方案 | 单 HMAC |
| 审批 | 确定性规则+污点升格+locked 类别 | LLM 分类器，故障模式不可审计 |
| 远端审批 | `question-resume.ts` 校验 `actorId===ownerUserId` | member 端可被远端 resolve（漏洞） |
| Stream 鉴权 | upgrade 前手工 session+per-bot 检查，token 不出内网 | 一次性 ticket（等价目标） |
| 设备 E2EE | `shared/device-e2ee` | 无 |
| 插件版本 | `plugins/store.ts` 显式处理 version 继承 | 发布新版即执行（漏洞） |
| 管理页 XSS | React 转义 + 无裸 innerHTML 门禁 | textContent-only（同样安全） |

## 4. 反面清单（ProkBot 踩过的坑，ChisaBot 变更时防回归）

1. **自声明字段不当权限边界**：它的 `platform:'desktop'` 由配对方自报却 gate 执行提供方/WebAuthn
   通道。能力必须按 scope 签发。
2. **黑名单透传**：`/api/*` 只挡 2 条，上游新增管理 RPC 自动暴露。代理永远白名单。
3. **http:// 静默接受**：token/配对码全程明文；LAN 模式是默认路径。明文部署至少要显式确认。
4. **凭据明文落盘**：除一处外全明文。封存要统一覆盖到所有 provider key、推送私钥。
5. **TLS 代码存在但未接线**：compose 没传证书，文档宣称 HTTPS 实际不可部署。配置面存在≠可用，
   验收要跑通。
6. **授权完成后主体漂移**：OAuth/编辑连接把 live token 发给用户新输入的地址（先发包后验证）。
   换宿主必须重新证明身份连续性。
7. **备份是明文全量密钥包**：`.tar.gz` 含全部 token/key 仅 0600。备份要么加密要么明确标注为机密。
8. **审批输入未分区**：模型审批把 agent 自述和用户指令混喂（它倒是分区了，但自研审批若无分区
   同样中招）。
9. **opaque blob 无可审计锚点**：314 个压缩补丁包，host/iOS 无外部哈希。任何二进制/生成物进仓库
   都要带可验证摘要。
10. **Windows 路径分隔符**：`path.relative` 出 `\` 导致其附件正则全灭。涉及路径正则一律先
    `split(sep).join('/')`（ChisaBot 若上 Windows host 同样适用）。

## 5. 落地优先级建议

| 序 | 项 | 理由 |
|---|---|---|
| 1 | 1.5 唯一 tmp 名 + 1.4 读时权限校验 | 小改动，直接消隐患 |
| 2 | 2.3/2.4/2.5/2.7 限流与配额审计 | 一轮 grep+单测即可收口 |
| 3 | 2.1 OAuth state 绑定核对 | 安全敏感，逐条核对即可 |
| 4 | 2.2 审批 args schema 白名单 | 结构性小改 |
| 5 | 1.1 排空升级 | 单独立项，涉及租约语义 |
| 6 | 1.6 装载物 provenance | 配合插件体系演进 |
| 7 | 1.3 任务账本 | 等有计费型 API 时 |
| 8 | 1.2 联邦 | 方向性需求出现时 |


## 6. 2026-11-19 全量交互对照审查补完（AI↔用户交互专项）

> 2026-11-19 基于 `C:\AI\ProkBot` 全仓 385 个非第三方文本/源码文件进行全量代码级对比审查，聚焦「AI 与用户交互」维度，并与 ChisaBot 源码逐点反证核实（与 §0–§5 去重）。

### 6.1 4 处 ChisaBot「底层已建、前端/路由断线」半成品断口

1. **聊天 TTS 朗读断线**：`app/src/hooks/use-speech-playback.ts` 与 `app/src/lib/audio/speech.ts` 全仓零调用；`server/src/audio/speech-service.ts:714-731` 的 `speech_synthesize` 合成音频后直接丢弃字节仅返回字节数文本。
2. **DOM 演示录制断线**：`agent-computer/src/demonstration.ts:1-144` 已实现 DOM 语义手势录制与脱敏，但 `server/src/index.ts:5273-5285,5418-5424` 未向 `agent-computer` WebSocket 透传 `?recording=`，`app/src/` 零消费者。
3. **左侧栏多 Bot 置顶断线**：`app/src/components/agents/agent-dialog.tsx:459` 提供固定按钮写库，但 `server/src/agents/profile-store.ts:546-556` 未按 `pinnedAt` 排序、`app/src/components/app-sidebar/app-sidebar.tsx:755-818` 仅消费单选 `mainBotId` 忽略 `bot.pinned`。
4. **20MB PDF/DOCX 聊天上传断线**：`server/src/chat-files/service.ts` 已实现 20MB 存储与 PDF/DOCX 解析分块检索，但 `app/src/lib/chat-files.ts:38` 的 `uploadChatFile` 全仓零调用；聊天输入仅走 `/api/channels/:channelId/attachments`（`picked-files.ts` + `shared/attachments.ts` 硬限图片 ≤8MB、纯文本 ≤1MB）。

### 6.2 19 项经代码实证的高价值缺口（ProkBot 有 / ChisaBot 无）

1. **AI 回复完成主动通知 + 跨端前台抑制 + 原生移动推送（APNs/FCM）+ 桌面自定义提示音**（`ProkBot:host/runtime/reply-notifier.mjs`、`host-notifications.mjs`、`host/clients/shared/notification-frequency.mjs`、`host/server/push-{service,config,transports}.mjs`、`mac/clients/desktop/{notifications,sounds}.mjs`、`ios/clients/ios/GBPush.m`）。
2. **全链路实时语音通话**（WS 双向流 + 服务端 WebRTC VAD + 分态打断 + 播放排空回执 + 复用主 Bot 工具链 + 客户端 AEC3：`ProkBot:host/server/voice*.mjs`、`mac/clients/desktop/voice.mjs`、`ios/clients/ios/GBVoice*.m`、`GBAudioProcessing.cc`）。吸收时须补流式分句 TTS、打断即 abort 后台推理、静默期降门槛。
3. **语音服务（ASR/TTS）可视化管理台、音色库搜索/试听与聊天 TTS 闭环**（`ProkBot:host/server/public/{speech,voice}.js`、`voice-{catalog,config}.mjs`）。
4. **端到端「演示任务 → 编译成技能」（Teach by Demonstration）**（`ProkBot:host/runtime/host-teach.mjs`、`teach-skill/{SKILL.md,prepare.py}` + 接通我方 `agent-computer/src/demonstration.ts`）。
5. **AI 对话内自研可执行后端微应用 / MCP 工具包**（`app-builder` + 单 JSON 包 + 隔离运行态 + Host 托管 OAuth 注入：`ProkBot:host/server/applications.mjs`、`plugin-package.mjs`、`plugin-client.mjs`、`host/runtime/box-applications.mjs`）。吸收时补沙箱隔离并挂接 `plugins/store.ts` 三层授权。
6. **按任务难度自适应路由 + 动态思考强度（`reasoning_effort`）+ 30 天路由日志与在线 Dry-Run 试跑器**（`ProkBot:host/runtime/model-{policy,router}.mjs`、`routing-log.mjs`、`host/server/models.mjs`、`public/{model,routing-log}.js`）。须改用已配轻量模型，避开对方硬编码外部 SaaS 坑。
7. **系统级快捷入口与跨端 `agent` 深链直达**（语音/快捷指令无界面发消息 + 冷热深链路由 + 系统分享扩展：`ProkBot:host/server/mobile-app-intents.mjs`、`ios/clients/ios/GB{AppIntents,DeepLinks}.m`、`mac/clients/desktop/main.mjs`、`ios/patchers/ios/extensions.py`）。
8. **Bot 配方与多文件技能一键脱敏打包分享与断点续导（Sharing ZIP 生态）**（`ProkBot:host/server/sharing*.mjs`、`host/runtime/sharing-{client,import}.mjs`、`public/sharing.js`）。
9. **AI 视频生成 + 视频理解子会话 + 聊天内音视频播放卡片**（`ProkBot:host/runtime/media-{runtime,services,video-session}.mjs`、`host/server/media-providers.mjs`）。避开写死自建端点与 90MB base64 内联。
10. **多生图/视频模型池自主选型 + Schema 参数透传 + 多参考图（≤10）+ AI 生成 Bot 头像**（`ProkBot:host/server/media-{settings,providers,api}.mjs`、`public/media.js`）。
11. **系统提示词版本化工作台**（多角色编辑 + LCS Diff + 最近一轮脱敏组装结构与生效工具透视：`ProkBot:host/runtime/prompt-runtime.mjs`、`host/server/prompt-{settings,api}.mjs`、`public/prompt{s,-diff}.js`）。
12. **可配置 + 按模型覆写的多供应商联网工具（含在线测试）**（`ProkBot:host/runtime/web-services.mjs`、`host/server/web-settings.mjs`、`public/media-web.js`）。
13. **桌面端按域名审批导入本机 Chrome 登录态（Cookie Origin Approval）与 Passkey/WebAuthn 跨端转发**（`ProkBot:host/server/desktop-browser.mjs`、`mac/clients/desktop/browser-providers.mjs`）。需在 `pc/` 自研跨平台实现。
14. **按 Bot 持久化的常驻参考资料库管理入口 + 每回合只读防注入清单**（`ProkBot:host/server/library.mjs`、`host/runtime/host-library-files.mjs`）。复用 `chat_file_search` 分块索引，避开全量重传 100MiB。
15. **面向用户的多 Webhook 规则与 7 态执行流水管理面板**（释放 ChisaBot 已有 `responsibilities/{triggers,signatures,trigger-routes}.ts` 强后端，对标 `ProkBot:host/server/webhooks*.mjs`、`public/webhooks.js`）。
16. **按模型自助覆写上下文容量与摘要阈值**（`ProkBot:host/runtime/context-policy.mjs`、`public/model.js`）。
17. **管理台一键隐私遮罩模式（`data-private`）+ 桌面壳基础项（原生右键菜单、显式时区覆盖、硬件加速开关、出口白名单）**（`ProkBot:host/server/public/privacy.js`、`mac/clients/desktop/{external-links,settings,main}.mjs`）。
18. **管理台可视化热配置/热切换远程执行节点**（`ProkBot:host/server/execution-node.mjs`、`host/deploy/execution-gateway.mjs`、`host/runtime/remote-box.mjs`、`public/execution.js`）。
19. **面向 AI 代理的端到端自动化部署与验收剧本（`docs/AI-INSTALL.md`）**（`ProkBot:docs/AI-INSTALL.md`）。

### 6.3 10 项交互细节优化与打假/避坑约束

- **10 项细节优化**：① 本机 Coding Agent 同上下文续接/`needs_input`追问/`status(waitMs)`/`pwd -P` 预检；② 远端 MCP SSE/OAuth2/单工具开关/`customInstructions`/`nextCursor`/图片透传/超时防自动重试提示/`mcp-last-good` 降级保护；③ 虚拟形象闲置凝视/输密码闭眼/同屏多 Bot 去重表情/顶栏忙碌条；④ 技能不可变版本栈+Diff+回滚、按 `requiresTools` 动态隐身、多文件只读技能包；⑤ 4MiB 分块上传与原子分块下载/视频上限/桌面 `nativeImage` 缩略图；⑥ FFmpeg 16kHz 单声道 WAV 转码与流式 TTS 防 OOM；⑦ 无障碍控件树语义读写 + 按 `bundleId` 绑定 `directionEpoch`；⑧ 本地时区切日 + `kind` + `reasoning` Token 账本 + 热启停脱敏抓包观测器 + Harness 高消耗能力开关台；⑨ Tool Journal 父子会话保护与原子续跑 / Handoff 启动三方对账 / 定时任务重启标 `interrupted`；⑩ 链接预览 Hover 纯缓存探测、Bark `curl` 解析+单设备测试、PNG/JPEG/WebP 防像素炸弹校验、端侧诊断日志导出。
- **打假收窄（勿重复造轮子）**：ChisaBot 的本机多 CLI 委托与人工审批转发、公共共享文本知识库、PDF/DOCX 分块全文检索、以及 5 厂商签名 Webhook 后端均已存在或强于对方；侧栏折叠遵守 `DESIGN.md §139` 不强加自定义分组文件夹噪音。
- **避坑提醒**：勿照搬 ProkBot 语音静默期 640ms 缓冲、非流式整轮 TTS、打断不中止后台推理、单 `viewedAgentId` 吞通知、裸 `fetch` 出网、硬编码外部 SaaS 分类器、`length` 直接报错、45s 主模型同步审批、`codex-bridge` 一刀切拒批、资料库每轮重传 100MiB。

## 7. 10 波次全量落地进度总表（分支：`feat/prokbot-parity`）

- [ ] **Wave 1**：建档建分支 + 4 处半成品断口全接通（多 Bot 置顶排序、20MB PDF/DOCX 上传、聊天 TTS 朗读与音频卡片、DOM 示教录制→编译技能）+ 语音服务（ASR/TTS）管理台与音色试听
- [ ] **Wave 2**：AI 回复完成主动通知 + 按 `channelId` 前台抑制 + 全局频率策略 + 桌面提示音 + 跨端 `agent` 深链（PC/Android）+ `push_devices` 原生推送（APNs/FCM + Bark `curl`）+ 无界面快捷入口 API
- [ ] **Wave 3**：可插拔联网搜索后端 + 按模型覆写上下文/摘要阈值 + 多 Webhook 规则与 7 态流水面板 + Bot 常驻参考资料库与防注入清单 + 一键隐私遮罩 + 桌面壳右键/时区/硬件加速/出口白名单 + `docs/AI-INSTALL.md`
- [ ] **Wave 4**：按任务难度自适应路由 + 动态 `reasoning_effort` + 30 天路由日志与 Dry-Run 试跑 + 本地时区/用途/`reasoning` 用量账本 + 热启停脱敏抓包观测器 + 多角色系统提示词版本台（LCS Diff + 组装/工具透视）+ Harness 开关台
- [ ] **Wave 5**：Bot 配方与多文件技能一键脱敏分享 ZIP 生态 + 技能不可变版本栈/Diff/回滚 + 按 `requiresTools` 动态隐身 + 多文件只读技能包
- [ ] **Wave 6**：AI 视频生成/理解子会话 + 聊天 `<video>`/`<audio>` 卡片 + 多生图/视频模型池与多参考图 + AI 生成 Bot 头像 + FFmpeg 音频转码 + 虚拟形象情感微交互 + 头像防像素炸弹 + 链接预览 Hover 零网络探测
- [ ] **Wave 7**：全链路双向实时语音通话（WS 双向流 + 服务端 VAD/分态打断 + 真中止推理 + 流式分句 TTS + 播放回执 + 仅已播报入史 + 客户端 AEC3/WebAudio + `AgentOrb` 声波共振）
- [ ] **Wave 8**：AI 自研可执行后端微应用 / MCP 工具包（`app-builder` + 沙箱 `node-stdio` + Host 托管 OAuth + digest 锚定）+ 远端 MCP 全量增强 + 远程执行节点热切换
- [ ] **Wave 9**：Coding Agent 同上下文续接/`needs_input`/`status(waitMs)`/`pwd -P` + Chrome Cookie 按域名审批导入与 Passkey 跨端转发 + 无障碍控件树语义操控与 `bundleId` 回合授权 + 4MiB 分块上传下载 + 端侧诊断日志
- [ ] **Wave 10**：可靠性与 2026-11-18 安全/运维全量加固（Supervisor 排空升级、付费媒体幂等账本、凭据读时 0600/`O_NOFOLLOW`、唯一 tmp 名、装载物 provenance、OAuth state/审批白名单/限流配额/吊销断活流/hop-by-hop/body cap/SSE 上限、Tool Journal 父子树与原子续跑、Handoff 三方对账、定时任务重启 `interrupted`、联邦签名信封基础协议）
