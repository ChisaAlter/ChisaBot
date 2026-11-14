# Changelog

## Unreleased

## 0.1.148 — 2026-11-14

全端版本 0.1.148，Android versionCode 330。新增 PC macOS 桌面客户端（dmg / zip + `latest-mac.yml`），完成全页面 UI 布局稳定性整改，并修复桌面端离线安装包改名验签误拒问题。Windows 外壳指纹不变，无需重新安装；无需数据库迁移。

- **PC 客户端新增 macOS 版**（CB-123）：Electron 外壳适配 macOS——应用菜单（⌘C/⌘V/⌘Q 生效）、Dock 图标点击召回主窗口、关闭窗口常驻、窗口控制键用 macOS 原生红绿灯；打包产出 dmg（arm64 + x64）与 Squirrel.Mac 更新 zip + `latest-mac.yml`，在线更新复用同一条验签 / 指纹链（整包替换 `.app`，「稍后」退出时由 Squirrel 完成安装），并修复离线改名安装包验签（`scopedManifest` 仅在清单内漏签或篡改时拒绝）。CI `release.yml` 新增 `pc-mac` job，`latest-mac.yml` 随 `pc-sign` 一起签名；`check-release-assets` 同步校验 mac 资产。mac 打包配置不计入外壳指纹，现存 Windows 客户端不会因此被要求重新安装。dmg 目前无 Apple 代码签名，首次安装需 Gatekeeper 例外；Squirrel.Mac 要求证书签名，未签名构建的在线更新自动停用，Apple 签名落地后即生效。
- UI 布局稳定性（CB-122）：附件拒绝详情限高滚动，长名称/路径/文件名可收缩断行；异步按钮和任务数量不再挤动周边布局。修复独立授权页/404背景遮挡、小节标题竖排、短窗口弹窗按钮越界、嵌套任务遮罩、机器人文件卡和常驻指令错误布局。账号弹窗跨宽窄屏保留未保存内容；任务中心继续原位弹出。更新前端即可，无需数据库迁移或原生壳升级。

## 0.1.147 — 2026-11-14

全端版本 0.1.147，Android versionCode 329。模型等待改为由用户主动停止，任务中心统一在当前页面弹出，并包含数据库并发隔离和 Windows 更新提示修复。PC 外壳不变，无需强制重装。

- Windows：更新提示窗随主窗口居中；通过客户端代码指纹区分网页刷新与安装包更新，避免只有网页变化时反复提示下载安装包。
- 模型等待：移除聊天默认的 120 秒首段输出限制及底层 HTTP / 静默超时；模型尚未输出时继续等待，由用户点「停止」结束，不因沉默自动换模型。明确错误仍正常报出，显式调用方超时仍有效。需同时更新服务端与 DSH Host 源码，无需迁移数据库或更新客户端。
- 任务中心：账号菜单及右栏全部入口改为在当前页面上弹出，切换分区、查看详情和关闭均不跳转；保留 `/tasks?view=…&task=…` 旧链接。更新前端即可生效，无需数据库迁移。
- CI 测试：远程智能体鉴权的本地 HTTP 夹具改为双栈监听，兼容 `localhost` 解析到 IPv4 或 IPv6；连接失败显示实际传输错误，并检查回合确实完成。不改变生产鉴权规则或客户端行为。
- 数据库：修复 Bun 1.3.14 连接池在并发事务下把普通查询派入其他事务的问题，避免已确认写入的拒绝审计被其他事务回滚。普通查询显式保留连接，完成后释放；保留原有超时与不重放写入的策略。无需数据库迁移或重装客户端。
- 外观：切换玻璃材质或重新应用设置时，不再重复写入未变化的壁纸薄幕样式；薄幕浓度变化仍立即生效。
- 外观：新用户与「恢复默认」的玻璃材质改为「薄雾玻璃」（`mist`）；浅/深雾度默认仍为 16%（透光率 84%），雾度存成空值时也回到这个默认。已保存过任何外观设置（哪怕只改过雾度、壁纸或天空场景）、但没单独选过材质的用户继续用液态玻璃；只有自动写入的深浅主题、没有其它外观设置的，按新用户处理，用薄雾。第一次判定后把材质写入本地，之后每次加载都一致。
- 液态玻璃：浅色主题下整屏统一一种墨色，按各面板背后的真实亮度判定（低于 0.40 才整屏换深釉，回到 0.50 以上换回浅釉），亮的 Hark 天空不再被判成深色；判定不再存进本地，后渲染的卡片和用户自己的气泡也跟着整屏墨色走。

## 0.1.146 — 2026-11-11

全端版本 0.1.146，Android versionCode 328。新增「设置 → 智能体提供方」多实例配置中心、子代理随意直连唤起、按机器人独立授权挂载工具与外部智能体嵌套互调体系，并包含预设 9 幅艺术壁纸图库。PC 外壳与 Android 原生壳无破坏性改动，不强制重装。

- **智能体提供方与多账号隔离（设置 → 智能体提供方）**：双栏统一管理 Codex（`CODEX_HOME` 与影子 Home 按账号隔离 `auth.json`）、Claude Code（`CLAUDE_CONFIG_DIR` 与影子 Home）、Antigravity（`agy` / `agy_acp_server` 自动探测与 Windows 代理前缀自动补齐）、通用 ACP（支持官方 ACP Registry 在线检索与离线兜底，如 Codebuddy、Devin）、OpenCode、Gemini CLI、Aider、自定义命令及 ChisaBot 内置循环；支持服务器本机受控宿主与已配对电脑双运行环境、AES-GCM 敏感环境变量加密及单实例/全环境一键探活。
- **聊天直连唤起与按 Bot 工具派发**：私聊输入框左下角新增子代理选择胶囊并支持 `@智能体名` 点名直连（流式输出实时任务与代码 Diff 卡片）；机器人管理弹窗新增「子代理」页签，可按机器人授权全部/勾选指定实例，将其动态挂载为 `subagent_run` 及独立具名工具 `agent_<slug>`，同时支持 `mode: "wait"` 同步返回结果与 `mode: "async"` 后台回流。
- **外部智能体嵌套互调、任务中心与定时任务联动**：PC / 无头节点运行时内置一次性 Bearer 令牌保护的本地 MCP 子代理桥（自动注入 ACP `mcpServers`、Claude `--mcp-config`、Codex `-c mcp_servers` 与 CLI 回退并限制 `maxDepth` 递归深度）；任务中心支持选择 `agent:<id>` 作为执行器，定时任务支持绑定子代理实例到期自动派发。
- **预设艺术壁纸图库（设置 → 通用）**：内置印象油画（睡莲晨光、星夜罗纳、暮色麦浪）、东方意境（千里青绿、浮世沧浪、烟雨空山）与现代光影（光影回廊、流金玛瑙、极昼冰峡）共 9 幅 16:9 高清 WebP 艺术壁纸，支持按分类筛选、与 Hark 动态天空及本地上传壁纸无损来回切换（切往预设壁纸或天空不丢失已上传图片），并平滑兼容旧版壁纸预设 ID。

## 0.1.145 — 2026-11-11

全端版本 0.1.145，Android versionCode 327。升级聊天右栏「任务」卡片的 Skyglass 触感质感与全套原位交互（三点菜单、置顶与上下排序、丝滑详情弹窗、就地新建任务与异常人话化），告别点击跳页打断对话。PC 外壳与 Android 原生壳无破坏性改动，不强制重装。

- **右栏任务卡片 Skyglass 质感升级**：重构卡片内高光、语义微光晕、多层柔和阴影、悬浮/按压动效、类别微图标、置顶标记与错误提示块；严格保持浅/深主题 × 全部玻璃预设 × 7 套配色的 WCAG AA 4.5:1 状态文字对比度、3:1 图标对比度与 CIEDE2000 色差门禁。
- **原位三点菜单与置顶/排序**：每张任务、待确认与工作流卡片新增右上角 `⋯` 菜单，支持就地查看详情、开始/暂停/继续/重试/批准/拒绝、置顶/取消置顶、上移/下移、取消任务与停止工作流；依赖异常或排队阻塞卡片底部直接提供「取消任务」；置顶与顺序按分组持久化并通过 `POST /api/task-center/tasks/:id/priority` 同步服务端任务优先级；栏头新增「+ 新建」原位创建任务入口。
- **丝滑原位详情弹窗（免跳页）**：点击卡片主区域就地弹出 `TaskRailDetailDialog`，展示任务说明、人话化异常与原始报错折叠复制、执行计划/工作流步骤进度、交付物预览与下载、执行日志，以及前后置依赖/父子任务栈内切换（「← 返回上一任务」）与完整状态控制。
- **机器异常自动人话化**：自动解析 Rust/JSON 风格原始报错（如 `refresh_token_invalidated`、`rate_limit`、超时等），在卡片摘要与详情顶部展示清晰中文原因。

## 0.1.144 — 2026-11-11

全端版本 0.1.144，Android versionCode 326。修复独立 DSH 账号运行时被宿主机边车隔离规则误拦截导致对话报「模型太久没有回应」、以及图片被隐私门禁拦截后无法撤回锁死会话的问题，并包含自有命名空间收尾。PC 外壳与 Android 原生壳无破坏性改动，不强制重装。

- **边车网络隔离精准放行独立 DSH 账号容器**：`scripts/ops/isolate-sidecar-app.sh` 校验网络 `chisabot.runtime-owner` 与容器 `chisabot.runtime-owner` / `chisabot.runtime-family` 标签，放行专属点对点网络上的受控 DSH 运行时访问内部工具与模型网关（`:3001`）并自动清理陈旧 `DROP` 规则，`--verify` 新增运行时到 `:3001/health` 活探；Magpie、`new-api` 及任何未授权容器访问 `:3001` 仍被严格 `DROP`。
- **图片隐私门禁拦截与一键撤回逃生口**：修复开启隐私脱敏或模型不支持看图时发送图片卡死整条对话的问题；`POST /api/conversations/threads/:id/truncate` 支持 `mode: "withdraw"` 并兼容前置独立 `RUN_ERROR` 截断；错误卡片提供「撤回这条消息」，纯图片与带文字消息统一提供「编辑（可移除附件）」与「撤回（带文字自动回填输入框）」；`runtime/dsh` 对本地 `privacy-gate` 不触发模型熔断冷却、不空转同网关备用模型，并在后续纯文本轮次自动将历史被拒图片降级为说明文本。
- **错误归属与登录失效提示**：`friendlyStopReason` 保留「主模型 / 备用模型『…』请求失败」前缀与详情折叠入口；识别 Magpie OAuth `refresh_token_invalidated` / `session has ended` 为不可原地重试的「模型登录已失效」。
- 去上游印记与架构收尾（CB-118 / CB-016）：彻底移除旧会话兼容路由、旧前缀请求头、旧前缀环境变量别名、前端/网关历史兼容垫片、旧托管云会话客户端、Mastra 远程运行时与死依赖（锁文件清零相关上游包），将 `deploy/pin-resources.sh` 与 `docker/s6/scripts/database-identity.sh` 重构为通用存量卷与数据库身份保留逻辑，保障线上数据零丢失；退役旧 Hermes 过渡内核与孤儿死模块/示例包，收敛至唯一内置执行内核 DSH；新增数据库迁移 `0068_detachment_and_cleanup`，将 `intelligence_channel_mappings` 原地重命名为 `chisabot_channel_mappings`、清洗历史 JSONB 结构信封键名（不改用户消息正文）并清理 14 张零引用废弃表；更新 `LICENSE` 与 `docs/THIRD_PARTY_NOTICES.md`、重写 `.env.example`、脱敏隐私路径与域名、清理过时英文文档并补齐 CI `agent-computer` 类型检查门禁。
- QA510/511 P3 收尾（#511）：统一错误脱敏（密码内未编码 `/ # ? @` 贪婪打码、只有用户名时仅在用户名像令牌时打码、Docker `service:port` 连接上下文与裸内网 IPv6 打码、`Basic authentication` / 参数名 / locale / `localhost.example.com` 不误打码）；DSH 首输出超时文案写出实际总等待时间，单模型请求超时与首输出期限对齐且不再同模型重试；DSH 会话事件写盘前先脱敏截断；催办跳过条件式承诺；建群 Bot 不存在统一回 400。

## 0.1.143 — 2026-11-11

全端版本 0.1.143，Android versionCode 325。服务器更新生效于网页及两端的共用界面；Windows 客户端同时包含恢复和认证修复。

- 引用和预填只进入目标对话；确定拒收时完整恢复正文、引用和附件，并可跨重载保留。接纳结果未知时明确提示核对，不自动重发；迟到接纳不清掉后续新输入。
- 后台回答不抢输入焦点；离开并淘汰的会话释放观察资源，服务器任务继续。内核重连在原状态位置显示，追平历史后才恢复在线。
- 流式历史合并中间全量快照，保留每条有序事件和准确覆盖水位；进程中断后可恢复最后检查点之后的完整内容。
- 已接纳的确认和回答在忙碌时继续等待，不消耗真实失败次数；后续执行状态可见，可安全重试的失败可在原卡片继续处理。
- 活动任务、审批和通知历史使用明确分页；预览读取有界。过期提醒在交付前取消；完整个人上下文参与任务，纠正或遗忘记忆后不再注入隐藏副本。
- 巡检、定时保存、连接断开和列表重试使用真实结果及原位反馈，待处理期间避免重复操作或丢失编辑。
- Windows 记住当前完整路径；离线自动恢复与手动重试共用一次有期限请求，旧响应不覆盖新导航；登录、登记、退出也有等待期限。

验收范围与受控性能数据见 `docs/pipeline-runs/20261111-smooth-experience.md`。本版不新增外部接入配置，不强制重装；本轮未执行真实模型、设备、IM 外发或用户客户端安装操作。

## 0.1.142 — 2026-11-11

全端版本 0.1.142，Android versionCode 324。Windows 开始内置更新验签公钥；网页与服务器更新包含任务卡片和个人助理可靠性修复。

- 右栏任务卡片化：审批、工作流、活动任务与最近交付各自成卡，显示完整标题、状态、摘要和附件数；保留原有就地审批、暂停与继续。依赖异常使用警示色，工作流进度按实际完成步骤显示；手机任务抽屉加实底色，避免聊天文字穿透。状态字对比度在各主题预设和配色下达到 4.5:1，状态色差保持可辨；接口出错后轮询不再闪骨架屏，两个请求同时失败并恢复后提示自动消失；工作流卡片读屏念「已完成 N/M 步」；步骤全部完成未收尾时显示「正在收尾」；确认请求已在别处处理（409/404）时卡片立即消失，工作流步骤审批则等重新拉取后再更新、运行仍在则不先卸卡。面板抽屉关闭后焦点回到「打开面板」；液态玻璃下实心按钮的图标不再被混合模式冲淡。
- 新安装默认使用 DSH，显式内核配置优先；旧 Hermes 连接配置保留兼容入口，错误的内核名称不再悄悄落回其他执行器。
- 工作流接入本人通知：步骤审批、人工验收、完成和失败进入现有通知账本；已处理或已重试的旧状态不再发送提醒。
- 邮箱连接可单独设置 SMTP 主机、端口、用户名和密码，保存前验证发信连接；旧 IMAP 连接继续保留原有读取与发送方式。
- 只读工具失败正常返回错误；外部操作结果未知时可在原对话核对并继续，核对过程不重做原操作。
- 修复跨 Bot 交接时预先取得线程租约、又在后台容量准入等待自身租约造成的死锁，由执行器统一持有租约。
- 宿主故障和恢复沿现有本人通知交付链处理；API 不可用期间记录的状态在服务恢复后继续处理。
- Windows 通用版发布必须签名，客户端内置发布公钥；DSH 的 API、PostgreSQL 与 Host 恢复用例纳入必跑 CI，缺数据库或跳过测试不能报告通过。

## 0.1.141 — 2026-11-10

这一版合并：只装了 ChisaBot 的部署可在后台一键安装 Magpie（#518）。全端同步版本号 0.1.141（Android versionCode 323）；PC 外壳、Android 应用本体不变；宿主机更新程序随本次系统更新自升级并带上 Magpie 安装模板。

- Magpie 一键安装：只装了 ChisaBot、服务器上没有 Magpie 时，「管理后台 → 模型平台 Magpie」直接给出「一键安装」。宿主机更新程序只装官方镜像 `ghcr.io/yetone/magpie`，核对镜像摘要（仓库没给出摘要就不启动），有 gh / cosign 时校验官方签名，失败停在哪一步、原因是什么都显示在页面上，可以重试（上一轮一结束就能立刻再试，密钥保留）；装好后管理密钥由宿主机交给应用，几秒内自动接上，不用重启。找不到 iptables 时会找 `/usr/sbin`、`/sbin` 等常见路径，仍没有就在页面上警告隔离没补上。已经配好 Magpie 的部署不受影响。需要先做一次系统更新让更新程序带上安装模板。

## 0.1.140 — 2026-11-10

这一版合并：浏览器匿名出口放行公网 OAuth、隧道失败不再说成策略（#512）。全端同步版本号 0.1.140（Android versionCode 322）；PC 外壳、Android 应用本体不变。

- 浏览器出口：同一台电脑上所有 Bot 都是 `allow_all` 时，浏览器匿名出口也按 `allow_all` 放行（仍受私网底线 `ALWAYS_DENIED` 约束），Claude 等公网 OAuth 登录页不再被包仓库白名单拦截；有 `allowlist_only` / `deny_all` 时匿名继续拒绝。
- 提示更准确：代理隧道失败、DNS 失败改为「连不上这个网址。」，不再误报「网络策略不允许」；HTTP 拒绝返回中文页面，跳转到内网时按失败那一跳说明安全原因。
- 安全底线加固：主机名去掉 IPv6 `%zone` 后再判定，堵住 `::1%lo` 类绕过；`fec0::/10`、`64:ff9b:1::/48`、`2002::/16` 纳入 `ALWAYS_DENIED`；策略变更时断开已建立的 CONNECT 隧道。
- 浏览器启动只传代理地址不带凭据；远程控制轮询改为单一来源。

## 0.1.139 — 2026-11-10

这一版合并：长对话重连循环修复（#515）。全端同步版本号 0.1.139（Android versionCode 321）；PC 外壳、Android 应用本体不变。

- 重连核对只比对客户端手里已加载的那一段历史，长对话不再因为“历史对不上”反复整段重连。
- 重新加入会话带退避（`join-backoff`），断线后不再密集重试；重试请求一定会真正发出。
- 重连时服务器按增量快照补齐（`shared/connect-snapshot`），不再每次下发整段会话。
- 403 套餐受限时显示中文原因，不再只提示连接失败。

## 0.1.138 — 2026-11-10

这一版合并：DSH 会话运行时迁移与 早期上游模板 清理（#508）、QA508/QA509 回归修复（#509、#510）、设备审计摘要写入前打码（#514）。全端同步版本号 0.1.138（Android versionCode 320）；PC 外壳不变；Android 应用本体有改动（主界面改用共用网页手机布局），正常原地更新。

- 客户端发布：版本升至 0.1.138，Android versionCode 升至 320；Windows 安装包与 Android APK 由 Client release 构建发布。服务器部署和客户端发布分别记录。

- Android：主界面复用桌面同一套 React 前端的手机布局，保留登录、系统文件选择与导出、键盘和返回键行为。
- 执行内核：现役服务切换至 DSH，移除 早期上游模板 产品入口、销售跳转及旧执行接线；会话表原地迁移并保留历史、任务和审批。

- 聊天显示：流式与中断时的正文统一使用气泡；普通 Markdown 不再因标题和列表增多而自动变成折叠文档卡，代码围栏中的卡片指令保持原样。回合结束后释放消息高度保留，发送与错误卡出现时平滑跟随底部。
- 聊天记录「消失」修复：一轮里调用很多次设备工具后，重新打开对话不再一片空白。长对话的首屏窗口改按看得见的行计数，正在进行的这一轮（人发的那条到干活提示）一定显示；干活提示所在的行没挂上时画在末尾；上面还有历史时顶上一直有「显示更早的消息」。点「显示更早的消息」时正在看的行保持原地；打开一段服务器还在跑或等待审批的对话，首帧就显示干活提示，不再误挂「这一轮没有回答」。已结束的超长工具轮打开就能看到本轮问题；首帧直接停在底部；「显示更早的消息」不再比内容行先出现。看不见的过程行不再挂进 DOM，以缩短工具很多的对话的首帧长任务。
- 早期模型回退修复随 DSH 迁移退出现役执行路径；当前运行时与部署状态见 `docs/pipeline-runs/20261108-assistant-production.md`。
- 设备审计打码（#514）：设备操作审计摘要在写库前统一打码——覆盖 PowerShell `$env:`/`Env:\`/`SetEnvironmentVariable`/`setx`/`Set-Variable`、JSON/YAML 值、URL userinfo、`sk-`/`ghp_` 等密钥前缀（含 OPENAPI CLIENTID）；先打码再截断，扫描改为线性。
- QA508/QA509 回归修复（#509、#510）：所有运行失败路径共用同一套脱敏；任意 scheme 的 URL 凭据打码；`/api/groups` 仅管理员可用、inbox 响应 `no-store`；DSH 首输出超时切换备用模型并对失效模型熔断，最后一个候选也有首输出期限并明确结束回合；已知视觉模型 id 大小写不敏感匹配。
- 其他（#508）：排队消息发送失败不再丢失、附件随行；停止被接受后发来的消息提示稍等；会话错误先脱敏再写日志；图片 file part 以 image_url 发给 DeepSeek；IMAP 校验地址并限 993/143。

## 0.1.137 — 2026-11-07

这一版合并：右栏新增「任务」页签，把待确认审批、进行中任务与工作流进度集中到一屏。全端同步版本号 0.1.137（Android versionCode 319）；PC 外壳、Android 应用本体不变。

- 右栏「任务」页签：顶部分段由「面板 | 计算机」扩为「面板 | 任务 | 计算机」（无计算机能力时两段，子页签选择持久化）；有待确认事项时挂琥珀「需要你」圆点。
- TasksRailCard：任务中心待确认审批就地批准 / 拒绝；进行中工作流带步骤进度条、等待审批步骤就地批准 / 打回重做；进行中任务可暂停 / 继续；最近 5 条交付记录直达任务中心。
- Agent 管理卡从右栏移入任务中心「工具与 Agent」（Capabilities）页；「面板」页签只留实时面板。

## 0.1.136 — 2026-11-06

这一版合并：工作流（SOP 引擎）打回重做闭环、保留对话记忆的断点续跑、步骤级结构化验收门禁（`submit_gate_result`）、对话内工作流双向操控（`get_workflow_run` / `control_workflow_run`）、工具参数契约按需自省（`inspect_tool_schema`）、远程工具回调约束守卫与全工具回合停止守卫，以及 Android 面板标题去重与编译修复。全端同步版本号 0.1.136（Android versionCode 318）；PC 外壳不变；Android 应用本体有改动，正常原地更新。

- 工作流打回重做与断点续跑：审批拒绝或步骤配置 `onFailure: "reject"` 时可按 `rejectTo` 打回指定前序步骤重做（受 `maxReworks` 保护）；失败或停止的运行支持 `targeted_fix`（复用步骤底层 `threadId` 对话记忆定向修正）与 `full_redo`（清空记忆全新重跑），重试时自动叠加最新角色机器人绑定。
- 结构化验收门禁（Gate）：开启验收门的步骤注入专属工具 `submit_gate_result`（`pass / rework / fail / human` + `findings` 问题清单），支持未调用时自动追问、本步按 `maxLoops` 自修正闭环、跨步打回重做及 `human` 升级人工审批。
- 对话内工作流双向管控与契约自省：新增 `get_workflow_run`（查进度与卡点）、`control_workflow_run`（在聊天中直接批准、打回重做、断点重试或停止，强制绑定真实用户交互身份并采用异步受理语义）与 `inspect_tool_schema`（调用复杂工具前按需读取 JSON Schema 契约）。
- 工具治理边界加固：远程工具回调入口补齐 `guardWorkflowCallback` 与 `restrictToolsForWorkflow`，封堵工作流步骤越权调工具的后门；`confirmations.wrap` 对全部工具（含免审工具）统一执行已停止/已中止回合拦截。
- Android：修复面板标题去重（读 `props.text`）及 `parseSpec` / 简报小节类型编译问题。

## 0.1.135 — 2026-11-06

这一版合并：AI 输出归宿契约落地（每种输出在三端有明确画法，裸文本不再直接躺在壁纸上）、对话里就地连接 GitHub、「没发出去」改诚实判词加 90 秒事后对账、撤销/停止/取消在每个边界生效、定时任务/页面/凭据/模型降级的一批竞态修复。全端同步版本号 0.1.135（Android versionCode 317）；PC 外壳有改动，旧客户端在线更新走「重新安装」路径自动迁移；Android 应用本体有改动，正常原地更新。

- AI 输出契约（DESIGN §126）：每种 AI 输出形态在网页 / Android / IM 的归宿写进 `shared/output-contract` 一张表（原生 / 降级 / 不出现），两端解析测试按表逐条命名，新增输出形态漏画会被测试拦住；没有外壳的 render 内容自动补壳——并列卡片下的说明文字不再直接贴在壁纸上；`:::card` / `:::group` 写错名字或没闭合不再原文漏进气泡。
- GitHub 就地连接：对话里的「连接 GitHub」胶囊原地弹出设置里同一个令牌对话框（网页与 Android 同款），令牌只发往服务器、不进对话；Vault 里 GitHub 保留名的提示指到这条入口。
- person.surface 闸门：发起界面随回合走（Android UA 与 IM 记为 app 面），交互类等待（要人填的卡）只对网页发起的人开——Android / IM 发起的回合不再挂一张永远没人填的卡，直接给网页入口指引。
- 「没发出去」诚实化：证人缺席（服务器不可达）从「没发出去」改判「可能没发出去」，并开 90 秒有界对账——这句真落地就撤掉错误卡、把塞回输入框的草稿收走（你后来又打的字不碰）；证不出才停挂起的请求。
- 撤销 / 停止 / 取消在每个边界生效：设备紧急暂停与撤销先把持久状态落库再做旁路动作（审计写盘失败不再挡住控制面）；IM 适配器在排队执行前和真正发回复前各复校一次授权，被移除 / 吊销的人不再收到回复；回合锁等待可中止；截断墓碑读失败如实上报而不是当没有。
- pc / agent-computer：停止 / 撤销 / 暂停把在途 shell 命令与后台任务一并终止；会话清扫不再回收还有在途操作 / 截屏的会话；/health 未认证只回活、不吐身份、不建会话；工作区读写拒绝越出边界的符号链接。
- 部署侧：账号改密 / 停用 / 删除后并发登录留下的旧会话不再存活（拒绝即撤权）；updater 修管道读取死锁、状态文件改原子写；nginx 模板端口改从访问地址推导。
- 竞态修复一批：定时任务「立即运行 / 到点」认领加行锁、静默判定只看成功运行、时间串拒尾垃圾与不存在的本地时间、孤儿任务清理改信服务器列表；页面版本与素材写进同一条行锁事务；vault api_request 可中止、回体限流、302 暴露给调用方不自动跟跳、替换后域名复校；备用模型管道沿程传中止、首个真输出前的流错误按请求失败换下一个键；guarded-fetch / socket 生命周期与碎片清理；MCP 请求钉住解析出的公网地址、拒跟跳转、回体限流；服务端收件箱回复在回合结束后照样排空；断线重连按 revision 回填；设置草稿不被迟到的响应覆盖。
- Android：设备绑定 / 续期令牌只属于扫码时的服务器（换账号或换服务器登录后旧令牌不再误用，并发 401 共用一次续期）；会话代际挡迟到的历史与停止序列；对齐网页的干活步骤文案、`⟦files⟧` 成果卡、`:::card/group/brief`、链接卡与动作胶囊画法。

## 0.1.134 — 2026-11-06

这一版合并：发送看门狗不再把「受理到开跑」的静默前置误判成没发出去（服务端订阅即回执 RUN_STARTED）、上一轮收尾两处死等加 60 秒上界、前端接力 settle 重试 60 秒让位、看门狗落库检查增加收件箱证人。全端同步版本号 0.1.134（Android versionCode 316）；PC 外壳、Android 应用本体不变。

- 发送看门狗误报（「明明 AI 都输出了」）：`run()` 受理到真正开跑之间有一段合法静默前置——等上一轮收尾（`running.done` / 前端接力 `relay.closing`）、join 的收件箱写入、execute 的抢锁 + 三次串行事务 + `store.snapshot`——期间流上无事件、消息表也没有这条 id，12 秒看门狗两个证人全缺席就判 `hang`：stopAgent + forceUnlockThread + 报错卡 + 草稿回填；而服务端 execute 已派出、照常答完，回答经同步落回 → 错误卡和答案同屏。现在每条 /run 流订阅一建立就先回执一条 `RUN_STARTED`（AG-UI 校验器唯一合法首事件；下游真实 RUN_STARTED 去重，订阅者从头到尾只见一条），证人一永远即时成立，`hang` 只在「什么都没到服务器」时成立。
- 上一轮收尾等待有界：等 `running.done` / `relay.closing` 的两条 resume 路径以前无界死等，现在 60 秒（`RESUME_WAIT_MS`）超时如实 RUN_ERROR——消息确实没被受理时让浏览器去重发，不陪死掉的前置承诺挂下去；`closeFrontend` 的 settle 每秒重试也加 60 秒让位（`FRONTEND_CLOSE_GIVE_UP_MS`），腾出槽位让新回合进得来，没收尾的收件箱行维持原状留痕可查。
- 落库检查双证人（`sendReachedServer`）：正在回答时发来的消息走 join/排队路径，只进 `chisabot_thread_inbox`、不进 messages——单查 messages 会把「已排队」误判成「没到」。看门狗现在并行查 messages 表与服务端收件箱，任一证人确认即算到了；滚动部署期间旧服务端同样受益。

## 0.1.133 — 2026-11-05

这一版合并：回复看门狗超时不再把已落库消息塞回输入框（重复发送隐患）、队列排水失败的 parked 消息如实标注并可手动重试、活动记录打码防互递归/循环引用爆栈、PC 三处图标统一桌面构图。全端同步版本号 0.1.133（Android versionCode 315）；PC 外壳有改动（图标管线），旧客户端在线更新走「重新安装」路径自动迁移；Android 应用本体不变。

- 聊天修复（重复发送隐患）：`reply_hang` 看门狗超时分支直接 throw，绕过了统一出口的 `turnAnswered` 判定——明明已落库、机器人做了几步，那句已发出的话还是被塞回输入框，重试会把同一句话发两遍。现在 reply_hang 只记失败原因交统一出口判定：做出过东西就只挂原因不回填（重试走 `retryTurn`）；什么都没做成照旧回填草稿。消息没落库的 `hang` 保持回填不变。
- 队列 held 状态：趁机器人回答时发的消息进队列，轮到排水却失败后，parked 行不再谎称「排队」——标「没发出去」+ 整排一条手动「重试」；`heldBack` 的渲染镜像 `queueHeld` 进 ChatTranscript。
- 活动记录防炸：`redactUrl` 解析失败时回调 `redactText` 会互递归（URL 又被送回 redactUrl）直到 RangeError；`redactDetail` 对循环引用/超深嵌套递归爆栈——两处都让记录环节把正常电脑操作动作一起炸掉。现在坏 URL 只过 `redactPlain`、循环/超深子树降级为 null；`planFor`/`finish` 回调异常捕获后只告警（记录失败绝不影响动作本身，方法名进告警）。
- PC 图标统一：`.ico` 全尺寸帧（16–256）与托盘底图统一用整幅胸像（= 桌面构图），删掉 ≤64px 的脸部紧裁第二构图；托盘绿点/灰图/暂停角标的状态指示保留。外壳指纹随图标内容变化 → 旧客户端走整包重装路径，快捷方式与图标缓存自动刷新。

## 0.1.132 — 2026-11-05

这一版合并：压缩状态行不再给用户看、被压缩历史可按 id 取回（`history_recover`）、中国应用连接目录（directory）、液态玻璃防整屏翻暗、PC 更新源失效自愈、登录窗去外层框。全端同步版本号 0.1.132（Android versionCode 314）；PC 外壳有改动（更新器 + 登录窗），旧客户端在线更新走「重新安装」路径自动迁移；Android 应用本体不变。

- 聊天：「已压缩前文（较早的工具结果和超长消息已省略）」状态行整个移除——压缩是实现细节，永不出现在聊天里；压缩本身保留（长对话持续可用），数据库完整历史不丢。
- `history_recover`：压缩只作用于发给模型的副本，以前模型没有通道拿回被省略的细节。现在所有占位符自带消息 id（工具结果 / 超长消息 / 工具参数 / 摘要范围），新增只读工具按 id、toolCallId 或 from/to 范围从当前线程 `chisabot_local_threads（原早期线程表）.messages` 取回原文（非文本 part 渲染为 [附件]，30k 上限分页）；workflow 工具收窄与其他兄弟工具同走一层；只读、不弹确认卡。
- 中国应用连接目录（directory）：awesome-china-mcp 索引落成数据——目录是超集，每个服务给一条「怎么接」的路径（remote 端点 / stdio 走本机桥 / link 官方文档），catalogue 仍是审过的凭证白名单、单向晋升；管理后台新增目录页；connect_service 先查官方路径再落到搜索；vault 凭证支持 keyParam/keyHeader 落位。
- 液态玻璃：浅色档下先按全屏平均亮度一票否决（整体不暗就不许任何面板翻深釉，压在暗角上的靠升密度保可读），过闸后同一行的面板要过半共识才统一翻釉；LG_INK_LINE 0.5→0.45 配迟滞。修的是半深半浅壁纸把整屏翻暗。
- PC 更新源失效自愈：本机 `config.json` 的 `updateFeed` 覆盖优先级最高，源被遗弃（发版迁走 / 测试残留）时每次检查都「成功」但永远没结果——比失败更隐蔽。现在 checkForUpdates 回来的版本低于当前版本就判定源失效：状态挂 feedStale 露给本机标签（「更新源已失效（源上最高 x.y.z）」，不再谎称已是最新），若失效的是本机覆盖源则自动 setFeedURL 退回构建期/GitHub 源重查。
- PC 登录窗：卡片铺满窗口去掉外面那圈天空框（顶部 44px 拖动留白 + 侧边 16px 的不对称留白曾让它读成嵌套窗框），win-bar 改成压在卡面上的透明浮层，版本脚标钉在窗口底缘。

## 0.1.131 — 2026-11-04

这一版只有一个服务端功能：车队模型审计 `fleet_audit`。全端同步版本号到 0.1.131（Android versionCode 313）；PC 外壳、Android 应用本体不变。

- 车队模型审计 `fleet_audit`（DESIGN.md §125）：只读工具，把每个 bot 的职责、生效模型（覆盖 / 部署默认）、定时任务、频道活动和可用模型目录摊成证据包交给机器人评估「谁的模型配贵了 / 配弱了 / 缺能力」，给可执行的换模型建议；档位与负载线索按名字和关键词猜、明标待复核，远程 bot 只列不评，已删 bot 单列；`fleet/` 进确认分类的只读豁免，不需要确认卡；后台刷新面板的回合不给。

## 0.1.130 — 2026-11-04

这一版合并：桌面端改名 ChisaBot、品牌图标换朽叶千咲、管理员在对话里接自定义 MCP（`mcp_add`）与机器人自我地图、聊天气泡/胶囊收紧与跟进到点行折叠、右栏收起不再清「计算机」标签。全端同步版本号到 0.1.130（Android versionCode 312）；PC 外壳变更（图标 + 改名），旧客户端在线更新走「重新安装」路径自动迁移、不需要手动卸载。

- 聊天：收起右栏 / 关抽屉不再清「计算机」标签——只藏不关，再打开时状态还在。
- 聊天：机器人给自己排的跟进到点那行折叠（DESIGN.md §124）：唤醒话（「You scheduled this follow-up… Pick it up now…」）是写给模型的英文脚手架，以前整段平铺；现在和长期任务到点行同一画法——「定时任务已运行。」+ 原因 + 打算做什么，整条原文收进「详情」。唤醒消息格局提到 `shared/follow-up-turn.ts` 一处声明两端读；跟进 / 长期任务开的频道标题不再拿英文脚手架当「Asked:」；Android 触发帧同样改画一行淡字（以前整条英文帧画成用户气泡）。
- 聊天：气泡只要正文、胶囊只在干活时出现（DESIGN.md §123）：干活卡 / 状态胶囊只在思考和操作期间显示——这一轮一结束，那一行整行收起（§82.9 收成 0 高），不再留「✓ 搜索 2 次 · 12 秒 ⌄」的总结行（被停的、没有回答的轮次也一样收起；「◼ 已停止」「这一轮没有回答 + 重试」是另外的行，照旧）。提示词不再要求工具前先写「我去查一下」这类开场短句：气泡分几个都行、每个只装正文内容，不要没内容的短气泡。§93.1 的「简单回合才收」整套判断（isQuietWork / QUIET_TOOLS）删成「不在跑就收起」；Android 的 `Row.Work` 同步改成只在 live 时发出。
- 管理员在对话里添加自定义 MCP 服务器（DESIGN.md §120）：管理员把 Streamable HTTP 端点地址发给机器人即可接入——`mcp_add` 先出确认卡片（卡片上是探测到的真实工具清单而非裸地址），确认后走管理页同一个 `addCustomServer` 写入并把非 destructive 工具授权给当前机器人。新增第 5 个确认类别「添加连接器」（locked，与付款同级恒问，不能设成「直接做」）；工具仅对 admin 身份的网页对话可见，IM / 后台回合不提供；不接受明文 token 参数。
- 机器人的自我地图（DESIGN.md §121）：内置 Bot 的提示词新增一段「自我地图」——为当前对话的人工作（含对方是不是管理员）、自己就是 MCP 宿主（mcp_add / device_mcp_call 按本轮实际工具说）、执行内核（Hermes / 内置循环）在它之下、不要把其它 MCP 客户端的配置教程当成自己的接入方案。修的是星灵照「Hermes MCP 文档」答「给 Hermes 配 MCP」——它不知道 Hermes 是自己的内核，也不知道自己是宿主。actor 角色经 agent-resolver 逐层透传进 `builtInAgentConfiguration`，remote AG-UI Bot 不变。
- 品牌图标换成朽叶千咲（鸣潮）淡色底半身像（DESIGN.md §28，托腮姿势 / 白衬衫紫领结，二周年咖啡厅立绘画风）：`assets/brand/source.webp` 换新，网页 favicon / PWA / 登录网关 / PC 托盘与窗口 / Android 各密度图标全部重新生成；Android 自适应图标底色由海蓝改纯白。生成脚本从 Pillow 移植成 Node + sharp（`assets/brand/generate.mjs` + `pc/scripts/win-icon.mjs`，本机不再需要 Python）；`pc/build/icon.ico` 与哈希命名副本按新图重出，外壳指纹已重算（旧客户端走「重新安装」路径自动换图标）。
- 桌面客户端改名 ChisaBot（DESIGN.md §122）：productName / executableName / shortcutName / artifactName 去掉 PC 后缀，窗口标题、托盘、通知、网页设备页、服务端机器人说明文全端同步；安装包 `customInit` 先静默卸掉旧「ChisaBot PC」安装（注册表 + 默认目录两处入口），客户端启动把 `%APPDATA%\ChisaBot PC` 整体改名搬过来（设备令牌 / 会话 / 本机配置不丢），指向旧 exe 的快捷方式经 `LEGACY_EXE_BASENAMES` 重写指向新 exe。appId / APP_USER_MODEL_ID / 更新源路径不变；`latest.yml` 的 path 变为 `ChisaBot-<版本>-x64-setup.exe`。外壳指纹已重算，旧客户端走「重新安装」路径自动迁移，不需要手动卸载。

## 0.1.129 — 2026-11-04

这一版合并 #499 与 #500：「追问」改按需出现、真实用量回传校准估算；液态玻璃材质按规格全量重写并成为默认。全端同步版本号到 0.1.129（Android versionCode 311）；PC 外壳和 Android 应用本体不变。

- 液态玻璃材质重写（#500）：liquid 档换成完整材质——釉色/边缘/内光/墨一套 `--lg-*` 令牌（`@property` 注册，切换滑行），Chromium 下叠加 feDisplacementMap 边缘透镜 + 红蓝色散，其余浏览器退回纯 CSS 玻璃；表面下方 5×3 采样自适应墨与密度，`alphaForContrast` 兜底最暗墨过 4.5（上限 `--lg-tint-hi`：浅 0.85 / 深 0.9 / 暗底翻转 0.95）；外观设置拆成深浅两套雾度分开持久化；性能模式 / 减少透明度 / 强制色彩下不透明兜底，焦点圈、禁用、错误红不动；弹层、菜单、对话框保持原样，行只提亮一档；布局、字体、圆角、文案零改动，无新组件。`app/src/lib/liquid-glass.ts` 新增；DESIGN.md §10.6。
- 「追问」按需出现（#499）：链接卡浮层按钮不再常显，真鼠标悬停 / 键盘 :focus-visible 才出，触屏长按卡片 450ms 出现且松手吞掉那次 click 不误开链接；「已压缩前文」只标最近一次压缩的轮次；用量回传改用真实值校准估算。

## 0.1.128 — 2026-11-04

这一版合并 #490：Magpie 目录漏报上下文窗口的模型（devin/swe-2 等）能配上并作答，轮中模型回退真正可用。全端同步版本号到 0.1.128（Android versionCode 310）；PC 外壳和 Android 应用本体不变。

- 目录声明窗口抬过端点误报 + 轮中换模真修好（#490）：Magpie 的 /models 不给 devin/swe-2 带 context 字段，Hermes 的 Ollama 探测回落到 32K、卡在 64K 下限外，SWE-2 永远 configure-failed，表现成「这一轮没有收到回答」；同时轮中重试调公共 set_session_model 必撞 -32603 Session is busy（is_running 轮中恒真），备用模型根本落不上去。现在：服务端模型目录内置已知窗口表（swe-2/swe-1.7 系 262144，按官方 devin models），catalog 值经 _meta.chisabot.model.contextWindow 下发到适配器；适配器按目录值抬 compressor/_config_context_length/_ollama_num_ctx 三处下限（只抬不压、只作用于本轮模型）；轮中重试改用内部 _switch_model(keep_endpoint=True) 并以 command_op 防并发切换。model-catalog / hermes-runtime / copilot / chisabot_protocol / chisabot_acp；适配器测试新增 context floor 回归、rebuilding fake 同时覆盖 _switch_model 路径，model-catalog 测试新增已知窗口表回归。

## 0.1.127 — 2026-11-03

这一版合并 #488：模型配置失败透出真实原因、配不出来可落备用模型。全端同步版本号到 0.1.127（Android versionCode 309）；PC 外壳和 Android 应用本体不变。

- 模型拒绝错误不再吞因 + 主模型配不出来可走备用（#488）：适配器 `_configure` 原来 `except Exception: response = None` 把上游放在 `data.details` 里的真实原因（模型不在清单、provider 无法解析、AuthError 等）整个丢掉，界面只剩一句通用文案，「又拒绝」永远不可诊断。现在结构化 details 原样透传进错误详情、全文进服务端日志（capability 依旧脱敏）；会话本身丢失（进程重启后内存 session 没了）单独报「开新对话」，不再误报成模型拒绝；busy 等会话级 ACP 错误原样透传、不再被改写成 invalid_params。主模型 configure 失败从硬死改为冷却后进候选循环——配了备用模型时本轮直接跑备用（field_meta 照旧带 modelFallback），一次配错不再让整个机器人每轮必死。具名 custom provider 反查优先用 upstream `canonical_custom_identity`/`find_custom_provider_identity`（规范化 URL、扫描 `providers:` 新条目、可按模型反查），手写 base_url 精确匹配降级为旧版兜底。`chisabot_acp.py`；适配器测试新增 5 项回归。

## 0.1.126 — 2026-11-03

这一版合并 #486：Magpie 网关更新给拉取加上限时与心跳，页面补齐进度状态。全端同步版本号到 0.1.126（Android versionCode 308）；PC 外壳和 Android 应用本体不变。

- Magpie 更新拉取加上限时与心跳（#486）：此前 `docker compose pull` 被 `>/dev/null` 静默且无超时——registry 拉不动时任务永远停在「拉取镜像」。现在 pull 后台执行、每 15 秒往任务日志报「已用 N 秒」（`MAGPIE_PULL_HEARTBEAT_SEC`），900 秒超时判失败（`MAGPIE_PULL_TIMEOUT_SEC`），输出末尾进任务日志；`up -d` 加 120 秒兜底（`MAGPIE_UP_TIMEOUT_SEC`）。页面补齐「排队中 / 成功 / 未执行（宿主机拒掉的请求原来无声消失）」三态，进行中显示实时已用时长。`test-shell.sh` 新增 magpie.sh 覆盖。

## 0.1.125 — 2026-11-03

这一版合并 #482：聊天里工具步骤隐藏时不再残留孤零零的「在活动里看」。全端同步版本号到 0.1.125（Android versionCode 307）；PC 外壳和 Android 应用本体不变。

- 「在活动里看」跟着工具步骤开关一起藏（#482）：工具调用 / 浏览步骤默认不画（调试开关），但电脑工具调用旁的跳转链接不看这个开关——每个 `computer_*` 调用留下一颗孤儿链接挂在气泡外，用户报「不在气泡里的思考内容」。修复后它和过程行同开关：默认不画，开「调试：显示工具调用」照旧出现；干活卡展开步骤里的同款链接一并隐藏。`tool-steps` 25 项回归通过（含新增 3 项开关回归）。

## 0.1.124 — 2026-11-03

这一版合并 #483：横条输入框的附件挪到框上方。全端同步版本号到 0.1.124（Android versionCode 306）；PC 外壳和 Android 应用本体不变。

- 横条输入框附件挪到框上方（#483）：收起的横条是两头半圆的胶囊（`border-radius: 999px`），此前附件条画在框内、80px 缩略图把它撑成一块高圆角块、图还被胶囊边缘裁掉。现在附件条挪到框上方、与拒收提示同一列，横条始终保持一行高；条同时挪出 `DictationSurface`，语音输入中附件保持可见可删。展开态与 hero 输入框不变。`composer-pill` / `composer-paste` / `composer-attachment-strip` 等 60 项回归通过。

## 0.1.123 — 2026-11-03

这一版合并 #479：深色模式下聊天输入框边界补可见。全端同步版本号到 0.1.123（Android versionCode 305）；PC 外壳和 Android 应用本体不变。

- 深色输入框边界补可见（#479）：输入框走「无边框悬浮」设计（`border: 0`），深色下边界只剩 `--card-shadow` 黑色投影，压在深色天空 / 壁纸上几乎不可见。修复不改无边框结构，深色下给 `--lg-shadow` 叠一圈 `1px rgba(255,255,255,0.16)` 内描边、顶边再叠一档高光——胶囊 / 展开两种形态圆角自动跟随；拖窗口缩放 `--lg-shadow` 置 `none` 时连描边一起关，性能模式、附件拖拽 outline、高对比度 a11y 描边互不冲突。覆盖 `render-budget` / `resize-pause` / `theme-glass-perf` / `a11y-contrast` 回归。

## 0.1.122 — 2026-11-03

这一版合并 #478：主题配色与动态天象各扩到 8 款、卡片预览去同质。全端同步版本号到 0.1.122（Android versionCode 304）；PC 外壳和 Android 应用本体不变。

- 主题配色与动态天象 8+8（#478）：配色从 6 款扩到 8 款，新增「银杏暖金」（金黄）与「朱砂绛红」（正红）补齐色谱上缺席的暖金 / 红系，两款均带浅色与深色全套 token，WCAG 对比度由 `a11y-contrast` 全矩阵校验。动态天象卡从 6 张扩到 8 张：原来 auto / live / 晴空三张预览渐变几乎一样、场景也只挑了 4 个偏晴的；现在「智能跟随主题」「实时动态天象」之外排了 6 个互不相同的场景——晨霞初晓·檀香山（引擎场景 11）、晴空流云·帕洛阿尔托（0）、落日暖金·凤凰城（6）、高山雪霁·太浩湖（5）、风暴雷云·迈阿密（10）、静谧星夜·柏林（4），每张卡预览渐变独立。配套真实 DOM 渲染回归测试：8 张配色卡 + 8 张天象卡全挂、预览渐变两两不同。

## 0.1.121 — 2026-11-03

这一版合并 #477：修「计算机」标签跨页导航后掉回「面板」。全端同步版本号到 0.1.121（Android versionCode 303）；PC 外壳和 Android 应用本体不变。

- 「计算机」标签跨页导航不丢（#477）：`useBotComputerTab` 旧逻辑只要同机器人页里地址的 `watch` 从开着变没就当「用户关了」——但非后退的导航也丢 `watch`（`/` 落地跳回、左栏再点同一行、`use早期上游模板Chat` 落到同一段），epoch 不变的页面被误清记忆，回来永远停在「面板」。清除现在要求 `lastHistoryEventWasPop()`，只认真·后退 / 前进；普通导航保留记忆并由补地址 effect 把 `watch=true` replace 回来。回归测试覆盖非 pop 丢 `watch` 与真 popstate 后退两条路径。

## 0.1.120 — 2026-11-02

这一版合并八条 PR：Bot 造 Bot（coworker 数据模型 #470 → 工厂工具与双向授权 #471 → 渲染器 / 徽章 / 授权面板与群聊最小路由 #473）、模型熔断与 400 修复（#466 → #472）、IM P3 后续（#475）、构建分块守卫（#474）、公开发布资产闸门（#468），另加合并后测试断言修复（#476）。全端同步版本号到 0.1.120（Android versionCode 302）；PC 外壳和 Android 应用本体不变。

- Bot 造 Bot（#470 / #471 / #473）：`agent_profiles` 加 provenance 列 `created_by_agent_id` / `created_depth`（迁移 0062，刻意不设外键，创建者删除后出处仍在）；`createCoworker` 集中路由与工厂共用的校验 / 写入 / 审计；`create_bot` / `list_managed_bots` / `update_bot` / `disable_bot` 四个工具带审批（PREVIEW_VERBATIM 让审批卡原文展示完整提示词）、每人与深度上限在 advisory lock 事务内复查；建出的 Bot 自动得双向 `kind="bot"` 授权；前端四个工具渲染卡（锚点卡附「去和『X』聊天」）、机器人列表「由『X』创建」徽章、资料页管理员授权面板（隐藏的 Bot 仍可收回授权）、`/api/groups` 最小路由恢复（无 UI，成员校验仍在服务内）。
- 模型熔断与修复（#466 / #472）：主模型按 quota / unavailable / rejected 分类熔断，冷却从 `CHISABOT_MODEL_COOLDOWN_MS` 指数退避到 `CHISABOT_MODEL_MAX_COOLDOWN_MS`；首输出期限覆盖整条流头部读取；400 / 413 / 422 按请求拒绝处理不熔断——先做一次历史清洗重试（空内容占位、超长 tool result 截断、按 user 边界整轮裁剪）再回落；多模态按目标模型能力转换图片 / 文档部件；切换模型后 live agent 重绑、工具与系统提示保留、首个 token 等不到就放弃卡死的上游调用不等满超时。
- IM P3 后续（#475）：`allowPrivate` 只在管理员本次改动时才随表单发送（开 → 关也能收回）；企业微信不再把 `bot_info.userid` 当主人、钉钉只认 staff/userid 字段——宁缺毋错，没认出来就不回填。
- 构建分块守卫（#474）：`vite build` 钉死 `NODE_ENV=production`，非生产调用方不再触发 `browser` ↔ `vendor-markdown` 分块环；vendor 正则覆盖 `dev/lib/`；CI 加普通 + `NODE_ENV=test` 双构建和 chunk 图校验。
- 公开发布资产闸门（#468）：公开 Release 回退只取 `pc-generic-unsigned`，同名文件不再混入自建 PC 包；`check-release-assets.mjs` 校验 flavor 标记、资产白名单、`latest.yml` 与安装包路径 / 哈希 / 大小一致及签名在场性。
- 测试修复（#476）：`approvals-rules` 的 Link mock 补 router 感知（进程级 mock 不再污染共享进程里后面的文件）；`schema.test.ts` 契约补上 0062 的两列一索引；`tool-selection` 断言接受 developer 角色。

## 0.1.119 — 2026-11-02

这一版合并 #465：五个 IM 平台支持「扫码绑定」一键创建并填入凭据（微信 ClawBot、QQ 官方机器人、企业微信智能机器人、钉钉、飞书 / Lark），IM 通道同时打通双向能力——待确认操作推送 IM、全端「当前对话」同步、审批决定直接在 IM 里回复、模型回复回推 IM 线程。全端同步版本号到 0.1.119（Android versionCode 301）；PC 外壳和 Android 应用本体不变。

- IM 扫码一键绑定（#465）：连接表单里点「扫码绑定」出二维码，用对应平台手机端扫码确认即自动创建 / 绑定机器人并填入凭据，不再手动去开放平台建应用抄密钥。`server/src/im/qr-auth.ts` 实现五个平台的 start/poll 协议：微信 ClawBot 走 ilinkai get_bot_qrcode / get_qrcode_status；QQ 官方走 q.qq.com create_bind_task / poll_bind_result，`bot_encrypt_secret` 用任务创建时生成的密钥做 AES-256-GCM 解密；企业微信走 ai/qc/generate / query_result；钉钉走 oapi app/registration 设备码（source `DING_DWS_CLAW`）；飞书走 accounts.feishu.cn / accounts.larksuite.com 的 PersonalAgent 设备码授权（轮询识别 Lark 租户自动切域名）。`shared/im.ts` 平台元数据加 `qrAuth` / `qrHint`，五个平台的接入步骤改为扫码优先、保留手动填写路径。
- IM 通道双向打通：待确认操作直接推送到 IM（`confirmations.setOnOpened`，含标题、目标和前两条细节，回复「允许 / 拒绝」即可处理，同时支持 approvals 审批）；`bot-threads` 记录每个用户每个机器人的「当前对话」，网页 / PC / 手机 / IM 打开同一段（`resolveBotConversation`）；机器人回复回推 IM 线程；频道内活动按来源写回 intelligence channel（`recordChannelActivity` / `signalThreadBusy`）；`chat-origin.ts` 识别 IM 来源前缀提取干净正文。
- 引导页：修复固定天空背景遮住「欢迎来到 ChisaBot」标题和「继续」按钮的问题。
- 测试接入：`im-adapters`、`im-service.integration`、`confirmations` 三个测试文件接入 chisabot.yml 测试列表，集成测试进有 TEST_DATABASE_URL 的步骤。

## 0.1.118 — 2026-11-02

这一版合并 #462：修「发消息报 Invalid params」——具名自定义 provider（如 Magpie）的会话切到任何非默认模型后，每轮都在模型调用前被 ACP -32602 拒掉。同时桥接层开始透出适配器给出的真实拒绝原因，同类报错不再只剩一句通用语。另合并 #464：策展移植 Cursor 官方 pstack 插件的工程纪律体系；#461：模型调用失败的英文运维提示不再当成回复发给用户。全端同步版本号到 0.1.118（Android versionCode 300）；PC 外壳和 Android 应用本体不变。

- pstack 工程纪律移植（#464）：把 Cursor 官方 pstack 插件（MIT，Lauren Tan）的 41 个技能策展进 `examples/zh-CN` 租户包——24 条工程原则叶节点、unslop / technical-writing / tdd / benchmark-checklist 等纪律技能，以及改写过的 `poteto-mode` 工程模式总路由（把非琐碎工程任务导到 investigation / bug-fix / feature 三个 playbook 与 how / why / architect），聊天里 `/poteto-mode` 显式触发或由 BOT 从技能目录自动加载。新工作流预设「pstack-adversarial-review」：主审框定范围后两个异模型攻方并行实测，只有跑出证据的发现才算数，再由主审复核汇总（`pstack-adversarial-review.md`）。`scripts/pstack-port.mjs` 是上游 SKILL.md → skills.yaml 的可重跑生成器，适配规则和手工改写件收在 `scripts/pstack-port/adapted/`，随上游同步重跑即可。MIT 归属见 `docs/THIRD_PARTY_NOTICES.md`，移植矩阵见 `docs/pstack-port.md`。只有服务器与租户包更新。

- 发消息 Invalid params（模型明明可用）：Hermes `_switch_model` 在同 endpoint 换模型时把 `target_provider` 报成解析后的类型名 `custom`，而不是配置里的具名 provider（如 `magpie`）；`_make_agent` 拿裸 `custom` 调 `resolve_runtime_provider` 必抛 AuthError，被适配器包成 -32602。现在 `_make_agent` 用 keep_endpoint 携带的 `base_url` 反查具名 provider 再解析；匹配不到保持原样，错误依旧如实透出（`chisabot_acp.py`）。只有服务器 / Hermes 运行时更新，没有数据迁移。适配器测试新增端点重映射回归。

- 错误详情透传：桥接层原来只转发 `error.message`，把适配器放在 `error.data.details` 里的真实原因（如 "The requested host model was rejected or could not be configured"）整个丢掉，界面只剩 "Invalid params"。现在把 details 拼进 RUN_ERROR（截断 300 字符），同类拒绝界面直接显示真实原因（`bridge.mjs`，`fake-acp.mjs` 加 rpcError 注入，bridge 测试加回归）。只有服务器更新。

- 模型报错更准更简洁（#461）：模型 / provider 调用失败时，Hermes 写给命令行用户的英文提示（"… rejected your API key … Provider said: HTTP 401: …"）不再作为普通回复混进对话——流式片段丢弃，结果只含该文本时按分类抛 -32603，错误卡给准确中文标题；登录被服务商撤销（sign-in was revoked）单独提示「模型登录已失效，请重新登录」（`chisabot_protocol.py`、`chisabot_acp.py`、`friendly-error.ts`）。只有服务器 / Hermes 运行时更新。

- 频道输入框收起成横条（服务器 / 网页更新，PC 和 Android 窗口同步生效）：频道底部的输入框日常收成两头半圆的横条，一行里只有「+」、输入区、发送键左侧的下箭头和发送键；点下箭头展开成完整工具栏，展开后再点上箭头收起，选择记入 localStorage 跨刷新保留。附件列、引用条和「上传中 x%」提示照旧显示在横条上方；compact 编辑器行高从 1.6 收到 1.35，光标只比文本高一点。

- 修复云端电脑「看不到屏幕 / 电脑正忙」：Dockerfile 里装浏览器用的 `PLAYWRIGHT_VERSION` 钉在 1.62.1（chromium-1234），而 agent-computer 的 playwright 已升到 1.64.1（要 chromium-1248），新镜像里浏览器起不来、截图全 502、机器人的浏览器步骤全部失败。改为构建时直接从 `agent-computer/package.json` 读版本，依赖升级自动失效对应层。

## 0.1.117 — 2026-11-01

这一版合并 #457：去掉侧栏里没人用的 peer-hover，滚动时少做无谓的样式重算（不改界面）。只有网页更新，网关、登录服务（web-auth）、PC 和 Android 不变。

- 网页滚动（卡顿修复）：去掉 `ui/sidebar.tsx` 里没人用的 `SidebarMenuAction` / `SidebarMenuBadge` 的 `peer-hover` 写法。它生成 `:hover ~ *`，滚动时鼠标不动、内容在鼠标下移，悬停目标每帧都换，每条消息的整棵子树被反复标成需要重算样式。测试台上（`perf:jank -- --scenario=scroll --cpu=1`，240 条消息的对话）样式失效 5482→747 次（−86%）；帧率上的收益没有测出来。只有服务器 / 网页更新，PC 客户端不用更新，没有数据迁移。新增测试拦住 `peer-hover` / `peer-focus` / `peer-active`。

- 长对话（超过 96 条）打开后只自动挂最近 96 条，往上滚到顶附近时继续分批往前加载；以前是打开后一秒内把全部历史挂完。240 条的对话页面元素 9572→3989，原速（`--cpu=1`）下拖窗口宽度 43–45→70–74 fps，切频道长任务约 −50%。**行为变化**：还没加载的旧消息，浏览器自带的页内搜索（Ctrl+F）搜不到，要先往上滚；应用内搜索、`?message=` 深链、活动记录里的「在对话里看这一步」会先把历史挂全再定位，上次停在中间的位置也会挂全再恢复。只有服务器 / 网页更新，没有数据迁移。

## 0.1.116 — 2026-10-30

这一版合并 #425、#456、#447、#454、#455 和依赖更新 #382、#390、#385。Android 新增形象头像，PC、Android 与服务端统一升到 0.1.116（Android `versionCode` 298）；PC 外壳不变，不需要重新安装。

- Android 显示形象（shape）头像（#425）：机器人头像按形象（shape）绘制。
- 登录循环保护小补丁（#456，#442 后续）：`/api/me` 回 200 时清掉循环保护时间戳，登录成功后 30 秒窗口重新算；「登录状态异常」卡片打开时藏起启动骨架的「正在加载 ChisaBot…」；`perf/README.md` 构建命令改为 `bun run --cwd app build`。
- 聊天 Markdown 块级解析缓存（#447，卡顿修复 P1-4）：流式回复只重新解析变化的块；退出登录时清空缓存；streamdown 锁定 2.6.0。
- 面板 tooltip 懒挂载（#454，P2-2）：打开抽屉时不再强制读取样式。
- 打开设置提速（#455，FIX-PLAN P1-6）：账号菜单非模态、点击即切页，空闲时预取设置页，进出设置时藏着的聊天和右栏不重渲。
- 依赖更新：agent-computer 小版本（#382）、`@ag-ui/mastra` 1.1.6 → 2.0.1（#390）、GitHub Actions 小版本并为 Dependabot 加 7 天冷却（#385）。

## 0.1.115 — 2026-10-30

这一版合并 #449、#448：改窗口大小时暂停 WebGL 天空；切会话时左栏高亮先到、对话延后渲染。只有网页更新，网关、登录服务（web-auth）、PC 和 Android 不变。

- 改窗口大小不再卡（FIX-PLAN P2-3 的 JS 部分，dev4/perf-resize-pause）：拖动改窗口大小时 `<html>` 挂 `data-resizing`（下一帧挂上，最后一次 resize 后约 150ms 拿掉，`app/src/lib/resize-state.ts`，应用入口初始化一次）。WebGL 天空在这段时间暂停：节流循环不出帧，引擎也不再每个 resize 事件都改画布尺寸、重画一帧（画布保持旧尺寸由 CSS 拉满），停下后按最终尺寸改一次并当帧补画。`html[data-resizing]` 下去掉毛玻璃和阴影的 CSS 由前端另做。headless 4x 降速 resize 场景：帧率 13.8 → 48.7，长任务 4581ms → 163ms。
- 切会话即时反馈（FIX-PLAN P1-1，dev2/jank-chat-switch）：左栏点机器人先只重画高亮，导航排在这一帧之后，对话用 `useDeferredValue` 延后渲染；切换中旧的一页半透明且 `inert`，往旧会话发送会被拦下、草稿保留。4x 降速最差 INP 2216 → 80ms。

- 主题配色看得出来了（fix/palette-theme）：设置里 6 个配色以前只改了 `--accent-blue`，开关、导航选中这类小元素才变色，选「樱花绯粉」界面还是蓝的。现在每个配色的亮 / 暗都覆盖 `--accent-color`、`--accent-soft`、主按钮（`--ink-primary` / `--on-primary`）、聚焦（`--focus` / `--focus-line`），新增 `--glass-tint`（强调色 8–10%）叠进左栏、右栏、账号卡和输入框的毛玻璃；只要选了非 default 配色就不启动 Hark WebGL（不管「智能跟随主题」开没开；引擎只有固定蓝天 / 夜空，没有色相参数），天空直接用主题渐变，也更省，设置页场景选择处有提示「彩色主题下使用主题天空」。开关、加载图标、进度条、提示图标、侧栏选中条等写死的蓝色也跟随主题色；「模型加载失败 · 重试」在深色下提亮，对比度 ≥ 4.5。樱花亮色是粉白黄昏、暗色是深紫红夜，其余 4 个各自配好。主按钮文字对比度全部 ≥ 4.5。default（以及没有 data-palette 属性）与 main 像素一致：写死的蓝色改成 `var(--pal-accent, 原值)`，`--pal-accent` / `--pal-tint-layer` 只在非 default 配色下定义；布局不变。

## 0.1.114 — 2026-10-30

这一版只合并 #442：公网网关下会话过期不再卡在加载（直接去 `/login?next=`，带防死循环），手机抽屉导航后收起，`/channel/new` 总开新话题。Service Worker 升到 5。只有网页更新，网关、登录服务（web-auth）、PC 和 Android 不变。

- 手机左栏抽屉（审计 M3-1 / M3-11 / M3-14）：在抽屉里点会话行（包括搜索结果里的本地命中）、机器人「⋯」菜单里的「机器人资料」「历史对话」「新话题」「面板」，做完都会收起抽屉，不再盖在新页面上、看着像没点中（抽屉推迟一拍再关，触屏点完不会被抽屉的返回记录退回原页）。「电脑操作…」「设为 / 取消主机器人」「更换主机器人…」「恢复运行」「删除机器人…」打开的对话框挂在抽屉里，照旧不收。会话行的链接去掉了无效的 `type="button"`。
- `/channel/new?agent=…` 总是开新话题：以前它会转到这个机器人最近的对话；现在只有最近的那个对话还一条消息都没有时才复用它。资料页「开始聊天」、「去聊天」、「和它聊天」、交接卡片「去「X」的对话 →」、旧 `/bot?agent=` 地址、定时任务「查看」找不到原对话时、删除机器人后回主机器人，这些「接着聊」的入口先找最近的对话，行为不变。
- 公网网关下会话过期：应用收到网关的 401（`chisabotAuthRequired`）就整页跳到 `/login?next=当前地址`，登录后回到原页面；以前应用在页面里转到 `/sign`（网关不提供这个页面），会一直停在加载。网关注入的 workspace.js 本来有这个拦截，但应用画了自己的账号控件，它一看到就退出了，所以一直没生效。Service Worker（`SW_VERSION` 4）：导航拿到网关的 401（与前端同一判断：JSON 体带 `chisabotAuthRequired: true`）改成跳 `/login?next=`；「服务器响应慢，正在重试…」卡片探测到网关 401 直接去登录页，不再刷新回去再等 20 秒拿 503 卡片；`/login` 不再经过 SW。没有网关的部署（应用自己的 `/sign`）不变。未升级版本号。
- 登录跳转防死循环：会话其实有效、后端却仍回网关 401 时（身份头重放、签名校验失败，例如 secret 不一致或时钟偏差），以前会在应用和 `/login` 之间无限来回跳。现在跳 `/login` 前在 sessionStorage 记下时间，30 秒内回来又碰到这种 401 就不再跳，改为显示「登录状态异常」和「退出重新登录」按钮（先退出会话，再去 `/login`）。Service Worker（`SW_VERSION` 5）：从 `/login` 过来的导航拿到网关 401 原样交给浏览器；「正在重试」卡片和应用共用同一个时间戳，30 秒内再次碰到这种 401 也改为显示同样的提示和按钮。在应用自己的 `/sign` 页上去登录页不再带 `next`。

- 拖动改窗口大小时更顺（P2-3，perf/resize-glass-pause）：`html[data-resizing]` 期间，左栏、账号卡、右栏、输入框、卡片和弹出层去掉 `backdrop-filter` 和大阴影，换成不透明底色；松手 150ms 后恢复。新文件 `app/src/resize-pause.css`，只点名具体类，不用 `:has()`、不用通配、不加 `!important`。`data-resizing` 由 #449 的 `resize-state.ts` 挂上，本改动叠在 #449 上。

## 0.1.113 — 2026-10-30

这一版合并 3 个 PR：GitHub 仓库链接出竖版大卡（#439）、电脑端布局回退 #374 的顶栏改动（#440）、卡顿测量工具（#443，只加工具不改应用）。只有服务器 / 网页更新，PC 和 Android 不变。

- GitHub 仓库链接大卡（#439）：`github.com/owner/repo` 一律出竖版大卡。服务端先查 GitHub API 拿描述、星标和主人头像；og 图拿不到就用头像兜底，无图时画横幅（只留图标 / 首字，不重复域名）；私有或不存在的仓库也出 `owner/repo` 加头像；og 图或 API 回 429 时只缓存 5 分钟。
- 电脑端布局（#440）：顶栏不再放头像、搜索和左栏开关；身份只留左栏底部账号卡，搜索回到左栏，左栏开关挪到左栏上（和右栏开关对称）。手机顶栏右上角头像照旧。
- 卡顿测量工具（#443，P0，只加工具不改应用）：`perf/` 下的 `bun run perf:jank` 用 headless Chrome（1024×673、DPR 1.25、CPU 4x 降速）打开构建好的网页，`/api` 由自带的模拟服务器回答，不需要真后端；场景有空闲、侧栏、面板、切频道、滚动、流式回复、设置、改窗口大小、登录页光球，输出每个场景的帧率、长任务、样式 / 布局 / 脚本耗时和每次点击的 INP。`bun run perf:compare` 把两次结果打印成前后对比表，之后每个性能 PR 都贴这张表。CI 新增 `perf.yml`，PR 上自动对比 base 和 head，只写进 job summary，不会让 PR 失败。用法见 `perf/README.md`。

- 头像球空闲时不动（卡顿修复，FIX-PLAN P1-1 里的光球部分）：`AgentOrb` 在 idle 且没标 `active` 时停掉旋转网格和高光漂移、不做呼吸缩放（加 `is-still` 类和 `data-ambient`），思考 / 说话等忙碌状态和减少动态效果的处理不变。登录页和新手引导页只摆着一个球，原来每 8 秒要花约 0.6 秒算样式，现在约 0.01 秒（4x 降速）。只改前端；新属性 `active` 留给以后需要空闲也转的球（目前没有调用方传）。
- 切会话卡顿修复 P1-3：主区从只留 1 段聊天改成 LRU 留最近 4 段（`KeepAliveStage`）。A→B→A 切回最近看过的对话不再整页重挂、重新解析 markdown，4x 降速下（perf/ harness）A→B→A 切回 INP 384 → 256 ms、切换场景长任务合计 9.7 s → 6.0 s、样式重算 4.3 s → 2.7 s；切回 240 条长对话和流式场景暂时变慢，待 P1-5 / P3-3。藏着的段用 `content-visibility: hidden` + `inert`，外壳重渲不传进去；每段 10 分钟 TTL，藏着的合计元素数超预算时先放掉最久没看的（大会话先走）。流式中切走的回答照常往下写，切回时贴底的追到底。删掉 `.kept-chat[data-visible=false] *` 通配规则。未升级版本号。
- 切会话 / 长对话补历史不再整篇强制样式重算（jank P1-2，分支 dev4/perf-tail-first）：尾屏优先补行时，人在底部就不再每批读 `scrollHeight`，交给浏览器原生 `overflow-anchor` 保位、补完钉一次底；人已上滑时原生锚定保住眼前那一行，只有不支持 `overflow-anchor` 的浏览器（Safari）才量高度垫回去。补行改在空闲时做（`requestIdleCallback`，最多等 50ms），批次随已挂条数增长（40 起、单批封顶 100）。补行那一次提交里不再当场量布局：视口上临时挂 `data-tail-backfill`，聊天记录的贴底观察器和 message-scroller 的内容变化处理看到它就不读 scrollHeight / 逐行位置，补完最后一批的钉底放到下一帧；切频道时这一帧作废（以前只在卸载时取消，刚补完就切走会把新频道 keep-alive 恢复的上滑位置拽到底）。`message-scroller`（`@shadcn/react@0.3.0` 拷进 `app/src/vendor/shadcn-react-message-scroller`，只改三处）算内容高度只量最后一行、找第一条可见行改二分，不再逐行 `getBoundingClientRect`。新增 `app/src/lib/chat/transcript-data-layer.ts`：给后面 virtua 虚拟化用的数据层接口。打开在底部、流式贴底、上滑补行不跳、应用内搜索跳转行为不变。
- 长对话虚拟化（jank P3-3，分支 perf/virtua-transcript，flag `virtualTranscript`，默认关）：打开后对话除末尾 3 行外交给 `virtua` 的 `Virtualizer`（滚动容器不变），只挂视口附近的行；行高实测并按会话 + 消息 id 缓存，切回复用；前插历史用 `shift` 保位；流式中的回答常驻末尾，贴底跟随、上滑不抢；tail-first 补行整条不走。会话内 Ctrl/⌘+F 改为应用内搜索（只在 flag 打开时拦截）：在数据里搜，滚到命中行并闪一下高亮，Enter / ⇧Enter / ↑↓ 切换，Esc 关闭。打开：地址栏 `?virtualTranscript=1`（会记住，`=0` 关）或 `localStorage.setItem("chisabot.virtual-transcript","on")`；构建时 `VITE_VIRTUAL_TRANSCRIPT=1` 只改默认值。flag 关时行为不变。新依赖 `virtua`（MIT）。
- 切会话 / 长对话补历史不再整篇强制样式重算（jank P1-2，分支 dev4/perf-tail-first）：尾屏优先补行时，人在底部就不再每批读 `scrollHeight`，交给浏览器原生 `overflow-anchor` 保位、补完钉一次底；人已上滑时原生锚定保住眼前那一行，只有不支持 `overflow-anchor` 的浏览器（Safari）才量高度垫回去。补行改在空闲时做（`requestIdleCallback`，最多等 50ms），批次随已挂条数翻倍（40 起、单批封顶 160），400 条从 13 批降到 6 批。`message-scroller`（`@shadcn/react@0.3.0` 拷进 `app/src/vendor/shadcn-react-message-scroller`，只改两处）算内容高度只量最后一行、找第一条可见行改二分，不再逐行 `getBoundingClientRect`。新增 `app/src/lib/chat/transcript-data-layer.ts`：给后面 virtua 虚拟化用的数据层接口。打开在底部、流式贴底、上滑补行不跳、应用内搜索跳转行为不变。

## 0.1.112 — 2026-10-29

这一版合并 2 个 PR：链接预览服务端（#412）、冷打开频道只读一次完整历史（#421）。只有服务器 / 网页更新，PC 和 Android 不变。设置面板性能三连（#395 / #398 / #403）合并到当前 main 时 `glass-shell.tsx`、`glass-topbar.tsx` 有代码冲突，这一版没合。

- 链接预览（#412）：GitHub 预览图被 429 限流时回退到 `opengraph.githubassets.com/1/…` 和作者头像，不再无图还被缓存 24 小时；YouTube / bilibili 走 oEmbed / 接口出视频卡片，百度百科出百科卡片；验证码 / 反爬页按失败降级（30 分钟），不再当成正常卡片；Punycode 只在安全时显示成 Unicode，HTML 实体全部解码，直链图片标题用文件名。`/api/link-preview` 的非 2xx 响应由应用加 `no-store`。仓库里同时改了网关配置（`cache-no-store.conf` 拆分、精确 `location = /api/link-preview`），这一版**没有**上线到网关。
- 冷打开频道只读一次完整历史（#421）：左栏列表晚到时不再并发读两遍全量；断线重连的回填补上漏收的工具调用，前导句按刷新后的样子折进工作卡，重连后和手动刷新看到的一致。

- 设置 · 定时任务列表和详情（审查模块 13）：「去对话创建定时任务」和空状态的起手句只把中性的一句（如「帮我设一个定时任务：」「明天早上 9 点提醒我：」）填进对话输入框、不发送，不再预设 notify_push 推送、memory_dream 整理记忆或 personal_* 工具（S4）；详情的运行记录打开后拉 20 条，「显示更多」每次加 20 条，到服务端保留的 50 条为止，加载时旧记录不闪、键盘焦点不丢（S7）；暂停的任务在行内写「已暂停」，正在运行时「立即运行」置灰成「运行中」并说明「这次还没跑完，跑完才能再运行」，菜单里的同一项也一样（O8）。新组件 `components/schedules/schedule-runs.tsx`，测试 `app/tests/schedule-runs-more.test.tsx`。只改前端，未升级版本号。

### 设置页审查模块 12（未保存拦截、文案、技能名字）

- **未保存拦截**：常驻指令出现「有未保存的更改」时，点左栏别的设置页、浏览器后退会先弹确认（TanStack Router `useBlocker`），刷新 / 关标签走浏览器的 beforeunload 提示；新建 / 编辑技能、添加 / 编辑记忆、导入 SKILL.md 弹窗有改动时，按 Esc、点遮罩、点右上角 ✕ 先确认，「取消」按钮照常直接关。全站只用「确认」这一种做法，确认框沿用 `confirmDialog`。新增 `app/src/lib/unsaved.ts`、`app/src/components/ui/unsaved-guard.tsx`。
- **文案**：设置搜索里「主题配色」的说明改成从 `THEME_PALETTES` 生成（名字和数量都不写死）；「背景壁纸」去掉「内置流光壁纸」；精选技能不再写死「8 款」；左栏「我的生图与识图」改成和页面标题一致的「生图与识图」；「密钥」不再在左栏单列（/settings/vault 会跳到 账号连接 → API 密钥，单列的一项永远亮不起来），仍能搜到；常驻指令超长的服务端报错改成中文。
- **技能名字**：标题是中文时自动生成合法的名字（不会再变成 `--`），没手动改过名字就跟着标题走；标签写明「必填」。
- **常驻指令保存中**：不再禁用整个输入框，只禁用按钮；保存期间接着打的字不会被服务器返回值覆盖。
- **复审返修**：设备「权限」和「本机智能体」两个带保存栏的设置页也接上未保存拦截；确认框开着时 Esc 在捕获阶段被确认框吃掉、点确认框里的按钮不再冒泡到下面的弹窗，去掉「关掉后 150ms 内也算开着」；确认框取消 / 关闭后焦点回到原来的输入框；技能名字里拉丁字母少于 4 个（如「周报v2」）时也加 hash 后缀，避免撞名（服务端撞名报错本来就是中文）。

### Hermes：备用模型 / 输出上限下发，长历史按上下文窗口压缩

- **备用模型与输出上限**：Hermes 内核每轮在 `chisabotHermes.model` 里带上 `{id, fallbacks, maxOutputTokens}`（备用模型来自管理员配置的「备用模型」，最多 8 个；输出上限沿用内置内核的解析）。ACP 桥校验后转给 adapter，adapter 把备用链和 `max_tokens` 设到 Hermes agent，下一轮没带就恢复默认。Hermes 中途切到备用模型时，adapter 回报 `modelFallback`，桥写进 `RUN_FINISHED.metadata`，服务端校验（`from` 必须是主模型、`to` 必须是本轮给出的备用）后记 `model-fallback` 日志，复用现有「主模型额度用完，已改用 X」提示。
- **能力检测**：adapter 在 initialize 宣告 `chisabotModelControls`，桥 `/health` 带 `modelControls`。设置页「备用模型」只有检测到 `fallback: false` 时才写「在 Hermes 内核下不生效」，未检测到不猜。
- **长历史**：只作用于发给 Hermes 的那一份，数据库里的完整历史不动。按模型上下文窗口估算（字符估算；上一轮有 provider 真实用量时用它校准比例，限 0.8–3 倍，没有就乘 1.15 安全系数，宁可早压缩）：超过 70% 时较早的工具结果换成一行说明、超长旧消息只留首尾（最近 2 轮原样）；超过 85% 时较早轮次用已缓存的摘要代替（最近 4 轮原样，仍超 70% 再裁剪）。**本轮从不等摘要模型，首字时间不变**：没有现成摘要就只裁剪，回复结束后在后台生成 / 续写摘要（20 秒超时只用于后台），下一轮再用。摘要按「话题 + 轮次范围」缓存，更早的消息被编辑 / 删除 / 重新生成时失效；已有较短范围的摘要时只增量补后面几轮，连续续写 5 次或摘要超过 600 字时整段重摘。摘要模型用管理员在「模型 → 摘要模型」里配置的，未配置就用主模型；后台失败只记日志。同一次运行的续跑段复用同一个压缩方案，桥看到的输入仍只追加。
- **不二次压缩**：Hermes 自带上下文压缩默认开启（75% 触发，运行中和溢出时也会压缩），会和宿主压缩叠加。宿主压缩过的运行在 `model` 里带 `contextCompression: false`，adapter 在这次运行里关掉 Hermes 的 `compression_enabled`，其它运行保持 Hermes 默认。
- **「已压缩前文」**：压缩过的轮次在回复下方显示一行低调说明，有摘要时可展开查看（复用备用模型提示的样式类，未改 `styles.css`）。「开新话题」仍用现有上下文圆环。
- **数据库**：新增摘要缓存表 `chisabot_history_summaries`（含 `thread_id` 索引），服务启动后首次使用时 `CREATE TABLE IF NOT EXISTS` 建表（不走 drizzle 迁移，无需手动迁移，删表即清缓存）；摘要模型设置存在现有 `enterprise_settings`（键 `history_summary_model`）。
- **Token 对比**（测试夹具 30 轮长话题，`server/tests/history-budget.test.ts`；字符估算 × 1.15 安全系数）：改前 164,250；200k 窗口（约 82%）裁剪后 48,736；160k 窗口（超过 85%）当轮裁剪到 48,736，下一轮（31 轮，改前 168,116）用上后台摘要（较早 26 轮）后 33,212。
- 不升版本号。
### 首屏加载提速（PR A，分支 dev4/perf-first-load-split）

- 登录后首屏不再卡在「正在加载 ChisaBot…」：路由级拆分 + 固定 vendor 块，左栏 / 侧栏 / 右栏 / 频道页 / CopilotProvider / 电脑面板 / 实时面板卡片 / 生成式界面渲染 / Streamdown 按需加载（加载态用现有骨架组件），按路径 modulepreload 首屏块；天空着色器改在 Worker 里预热，引擎启动不再阻塞主线程 1 秒多。本地冷缓存实测（3 轮中位数）：设置页首屏 JS gzip 1.16 MB → 0.52 MB、LCP 3.8 s → 1.5 s；聊天首页 LCP 4.4 s → 2.2 s；最长长任务 1.4–1.7 s → 54–78 ms；入口块 gzip 957 KB → 138 KB。聊天首页首屏 JS 总量持平（旧聊天前端框架 + Markdown 是聊天必需）。详见 DESIGN.md §41.5。未升级版本号。
- 审查跟进：管理页首屏不再带 旧聊天前端框架 / Markdown（组件库预览单独成块、Provider 按需加载；管理页首屏 JS gzip 1,030,798 → 506,073 字节）；消掉 vendor-copilot↔vendor-mcp、vendor-markdown↔Mermaid 包装两处块循环，构建时加块图检查（有环或设置 / 管理首屏带上 旧聊天前端框架 / Markdown 就构建失败）；聊天区一挂上就预取 render_ui 渲染面，旧对话里的生成式界面卡片不再先闪骨架。

### render_ui 渲染面改为空闲预载（分支 dev4/render-ui-idle-preload，依赖 #414）

- 生成式界面渲染面（json-render-surface，约 28K gz）不再在聊天区一挂上就下载：对话历史里已有 render_ui 卡片时立即预载（不等 /api/capabilities 返回，从缓存打开的旧对话不再闪骨架），否则（部署开了生成式界面时）等浏览器空闲（requestIdleCallback，setTimeout 兜底）再预载，不和首屏抢带宽。未升级版本号。

## 0.1.111 — 2026-10-29

这一版合并 8 个 PR：机器人连发多条消息全部显示（#393）、附件缩略图（#401，server 新增依赖 `sharp`）、天空换场景渐变不再停在半路（#402）、表单提交测试只看写了 onSubmit 的文件（#405，只改测试）、联网搜索质量（#407）、流式回复时打字不乱序（#408）、空对话第一轮断线重连也补齐（#411）、新话题首字延迟（#413）。#406 这一版不合。只升级服务器版本号（根、`app`、`server` 为 `0.1.111`），PC / Android 外壳未变；没有表结构变化。

- 新话题首字延迟（PR perf/first-text）：发送这一帧就显示「思考中」（新建页和新对话第一帧都算忙，沿用现有样式）；新话题 `/run` 前不再串着等频道列表刷新、接入回放、读历史和面板会话（刚建的线程没东西可回放，面板会话和等待并行），线上实测 `/run` 发出从约 2.2 秒提前到约 0.84 秒；个人记忆 / 技能目录 / GitHub / 文件 / 待确认几段并行读取；研究类问题（新闻、价格、推荐、对比、天气…）把共享技能 research-public-web 的方法直接附在技能目录后，省一轮 skill_load，普通对话不加字；提示词改成能直接答的不搜、动手前先一句 15 字以内的话再调工具；服务器每轮记一行 `run-timing`（排队 / 记忆 / 组装 / 拼提示词 / 远端接住 / 首字 / 首个工具，只有毫秒数）。可插拔搜索 provider 未动。未升级版本号。

- 联网搜索质量（hark 对比 #3 #5 #8 #11）：线上 DuckDuckGo 对服务器出口 IP 一直回 202 反爬页，现在会认出来、记日志，并在 10 分钟内跳过它直接走 Bing；DuckDuckGo 不可用且 Bing 没有相关结果时，工具直接告诉模型「当前搜索源不可用」，这一轮别再搜。此前搜索全落到 Bing，而 Bing 对抓取常给完全无关的页面，模型于是一轮搜 6–9 次、最后写「未核实」。Bing 的结果现在先过相关性（查询里任一按空格分开的完整词出现在结果里就保留，否则按关键词兜底、命中一个即可，命中多的排前面），无关的不再交给模型；过滤后为空时说「没搜到相关结果」，不再误报搜索源不可用；Bing 的 `ck/a` 跳转链接还原成真实网址，模型能注明来源网站；没搜到时的提示不再叫模型「换个说法再搜一次」，改成最多再换一次关键词，之后读确定的网址或说明未核实；并在代码里按轮限次：一轮里已有 2 次没搜到相关结果、或已确认搜索源不可用后，后面的 web_search 直接返回「本轮不再搜索」，不再联网；DuckDuckGo 只有页面里有 anomaly 验证脚本且没有结果才算反爬（不再把所有 202 都当反爬）；Bing 跳转解出来若是内网 / 本机地址就保留原链接；web_search 描述加上「多条新闻 / 推荐尽量来自不同网站并注明来源」。DuckDuckGo 失败时服务器日志记一行（不含查询）。json-render 的 `List` / `Card` 遇到认不出的图标名不再画空的灰色方块。未升级版本号。

- 流式回复时打字不再乱序、不再残留（#408）：Composer 的 `agents` / `commands` 放进 ref，`triggers` 只建一次、`handleChange` 不再随每个流式块换引用，按键之间不会再被旧值写回（原来 4x 降速下边流式边打字会变成 `bcdefghija`、退格留残字）；测试 `app/tests/composer-stream-typing.test.tsx`。只改前端。

- 修复：新的空对话、第一轮从这台设备发出时，紧接着断线再重连仍然不补（上一条修复要有「上一次的变化戳」，空对话第一轮跑的时候一次都没记下）。现在跑的时候问到的序号也记着，断线后拿它比（#411）。

### 附件缩略图：`/api/attachments/:id?w=`（B1）

对话里的图片画出来最宽 320 CSS 像素，原来却每次都把原图（手机照片常常几 MB）整份传给浏览器。现在服务器的 `GET /api/attachments/:id` 支持 `?w=240|480|960`：用 sharp 把 PNG / JPEG / WebP 缩到这一档宽、转成 WebP（质量 80），放进进程内存 LRU 缓存（总上限 64 MiB / 2000 项，单项 ≤ 2 MiB，不落盘）；其他宽度 400，非图片、GIF / 动图、本来就不比这一档宽、缩完反而更大、sharp 不可用或解不开时都回原图。权限判断和原图完全一样，缓存只存字节、命中时仍查可见性但不读原图。前端用户消息里的单张图（320px）和一摞图（220px）按屏幕像素密度挑档位，点开大图仍拉原图。实测一个含 3 张手机照片 + 1 张截图的对话，打开时图片传输从 5.30 MB 降到 53.6 KB（桌面 1x）/ 203.6 KB（手机 2x）。缩图同时最多算 2 张（进程内排队，`sharp.concurrency(1)`），sharp 加载失败时第一次用到会打一条明确警告（只打一次）；已在本地构建的 Docker 镜像（Ubuntu 24.04）里确认 sharp linux-x64 能加载和缩放。复审返修：排队超过 8 个时新请求直接回原图（不缓存，下次照常缩）；前端图片尺寸记忆改按实际加载的地址记，缩略图的尺寸不再存到原图地址名下。新增依赖 `sharp@^0.34.5`（server），没有表结构变化，没有升版本号。

- 修复：机器人连发几条消息时只看得到最后一条（没工具的一轮中间那几条被当过程话藏起来，干活之后连发的几条也被收进干活卡）。现在最后一个干活的步骤之后的全部文字都照旧是气泡（和结果一样带链接卡、复制按钮）；记忆写入（memory_save 等）夹在回答中间不当分界；两步之间的过程话、干活前开场一句的收法不变（§90 / §93）。只改前端，不用手动操作。

### 修复：「一键整理记忆」先预览、可撤销、不再丢内容（审计 12-settings 必修 1）

- **先确认再整理**：设置 → 记忆 →「更多」→「整理记忆…」先调 `GET /api/memory-notes/dream` 预览，确认弹窗列出要合并的每一组（种类、主题、谁记的、几条并一条）；确认后 `POST /api/memory-notes/dream` 必须带回预览的 `token`，笔记在这期间变了就返回 409，什么都不改。
- **不再截断**：同组合并后超过 4000 字的整组跳过（弹窗里写明「超过 4000 字，不合并」），每条只去掉重复的行；原来会被 `slice(0, 4000)` 静默截掉。
- **分组更严**：分组键加上 `agent_id` 和 `context`，不同机器人、不同情境的同主题笔记不再被并到一起。
- **一个事务 + 可撤销**：整个整理在一个事务里（行锁、写备份、改、删），中途出错全部回滚。被并掉 / 改动的原文写进新表 `chisabot_memory_tidy_backups`（每人只留最近一次，7 天过期）；整理后 8 秒内可点「撤销」，之后在「更多」→「撤销上次整理」（`POST /api/memory-notes/dream/undo`）。撤销时已被再次编辑的笔记不覆盖。
- **机器人整理要审批，定时任务也不静默**：`memory_dream` 归入「删除」类审批（原来 `memory/` 全部跳过审批），Hermes 回调路径的记忆工具也包上审批。审批卡片逐组列出要合并的笔记，确认的是那一份预览（token）；每周整理的定时任务不再被直接拒绝，而是在聊天和「待处理」里留一张整理建议卡片，点「确认」后才执行；确认后记忆变了会作废旧确认、重出一张写明原因的卡片。删除审批设为「直接做」的照常执行，结果附撤销链接（`/settings/memory?undoTidy=…`），也可让机器人调新工具 `memory_dream_undo`。工具新增可选 `prepareConfirm`（审批前先算出要做的内容）。
- **按钮挪进「更多」菜单**：「整理记忆」不再和「添加」并排，复用现有 `DropdownMenu` 和 `confirmDialog`（`confirmDialog` 新增可选 `items` 列表），没有改 `styles.css`。
- 不升版本号。

### 消息渲染：尖括号、Mermaid、手机卡片按钮（审计 05 必修 1–3）

- 修复：正文里不加反引号的 `Vec<String>`、`Option<T>`、`HashMap<K, V>` 等泛型不再被当成 HTML 标签吞掉。交给 Streamdown 前，把不是标准 HTML 元素（或大小写不规范）的标签转成文字（新增 `app/src/lib/chat/escape-unknown-tags.ts`）；紧跟在字母、数字或下划线后面的开标签一律转成文字，所以和 HTML 同名的 `Vec<option>`、`List<object>`、`Result<a>`、`Vec<i>` 也不再丢字、变链接或让后文变斜体（`a<br>b`、`H<sub>2</sub>O`、`10<sup>3</sup>` 照旧按 HTML 显示）；围栏代码块、4 格缩进的代码块（含列表里的）、行内代码和 `<https://…>` 自动链接不动；`<details>`、`<kbd>` 等标准标签和 `<script>` / `onerror` 照旧由 Streamdown 清洗。
- 修复：重写 `mermaid-lite` 流程图解析。支持 `-->|标签|`、`-- 标签 -->`、`-. 标签 .->`、`== 标签 ==>`，链式 `A --> B --> C`、`A & B --> C`、分号分句、`subgraph … end`（画成带标题的虚线框）、`---` / `-.->` / `==>` / `<-->` / `--o` / `--x` / `~~~`，以及 `stateDiagram`（起止点、转移标签、复合状态）。以前这些写法会把 `B[读取] --> C[校验]` 整串当成一个节点。长标签按宽度折行，不再超出节点框；带标签的连线会把层间距撑开，标签不压到节点上。
- 修复：认不出的图（gantt、classDiagram、erDiagram、mindmap 等）、写坏的图，以及流式中还没写完（结尾 ``` 没到）的 Mermaid，卡片里显示原文代码，不再画出错乱的图或半张图。节点超过 500 个的图、解析中出现任何意外异常的图也一样回退成代码。状态图转移的解析改成先找 `-->` 再切分，10 万个空格的长输入从约 3 秒降到毫秒级。
- 修复：手机等没有悬停的设备上，卡片头的「预览 / 源码、追问、复制、全屏」按钮一直显示（`@media (hover: none)`），标题放不下时按钮换到下一行，不再点不到全屏。
- 新增：全屏查看 Mermaid / SVG 图时可以缩放（按钮 50%–800%，或 Ctrl / ⌘ + 滚轮），放大后在框内滚动查看，缩放时保持视野中心（`app/src/components/chat/diagram-zoom.tsx`）。
- 修复：`SmoothStreamdown` 取 `window.location?.origin ?? ""`，测试环境里没有 `location` 的 `window` 也能渲染（全量 `test:app` 里 `chat-card-touch` 曾因此失败）。
- 测试：新增 `app/tests/escape-unknown-tags.test.tsx`（9 个，经真实 Streamdown 渲染，含同名小写泛型和缩进代码块）、`app/tests/mermaid-lite.test.ts`（30 个：边、标签、链、`&`、subgraph、形状、折行不溢出、标签不压节点、回退、状态图、节点上限、长输入耗时等）、`app/tests/chat-card-touch.test.tsx`（8 个：触屏按钮常显的 CSS 断言、全屏按钮、没有 `location` 的 `window`、缩放组件）。前后截图见 `docs/DEVLOG.md`。
- 应修项 4–10（公式、语法高亮、表格等）这次不做。不改版本号。

### 修复：推荐类回答落在搜索结果上（0.1.108 验收 #8）

- 修复：推荐类问题（例：上海咖啡店）不再搜 4 次后答「基于常见门店印象，未核实」。搜索结果每条下面标出摘要里的地址 / 人均 / 价格，结果后面写明「推荐要用这些结果，来源写结果网址」；提示词要求推荐给名字 + 地址或人均 / 价格 + 来源，已有结果时不写「凭印象 / 未核实」。
- 修复：同一轮（同一个问题）最多联网搜索 2 次，要换角度就并行发两个；第 3 次起不联网，直接让模型用已有结果回答。新增 `server/src/web/search-grounding.ts`。

### 修复：回复质量 PR1（模块 8 审查第 1、3、5、7–11 条）

- 修复：给模型的「当前时间」按用户时区（Asia/Shanghai，和长期记忆、定时任务同一个）写，并写明时区和 UTC 偏移。以前按服务器进程时区（线上是 UTC），北京时间 0–8 点问「今天几号 / 明天」会和记忆里的日期差一天。新增 `server/src/agents/current-date.ts`。
- 修复：Hermes 内核下模型出错不再一律是「Hermes host turn execution failed」。适配器按 Hermes 的 `failure_reason` 或异常的状态码 / 类型，透传一个固定的分类句子（限流、额度、密钥、上下文过长、超时、服务不可用、模型不存在、内容拦截、中途断开），网页上能出对应的中文提示和下一步；服务商原文不外传。Hermes 返回的失败结果（以前会当成普通回复显示一段英文警告）也按出错处理。
- 返修（#416 审查）：Hermes 出错分类不再按异常文字猜——工具自己的「文件不存在 / Permission denied / timed out」不会再显示成「模型不存在 / 密钥无效 / 模型超时」，只认 HTTP 状态码和模型 SDK 的异常类型，其他走通用提示。403 先看错误内容：地区限制显示「模型服务商不支持服务器所在地区」，内容拦截显示内容安全提示，明确是密钥问题才说密钥无效，分不清就用通用提示。分类本身不会再因为奇怪的错误内容（如含 bytes 的 body）抛异常卡住这一轮。
- 修复：提示词里「来源」的写法只剩一种：整条回复最后统一写一行「来源：…」，同一站点只写一次，不在每条后面各写一遍、不做成链接卡。
- 提示词顺手修：卡片后的收尾必须是结论本身；公式分子分母是多项时加括号；拒绝后给正当替代；提示词里写上当前模型 id，用户明确问时能答；说话方式一段不再用英文标题指别的规则；写明记忆笔记不标出处和「说清答案出处」以谁为准。安全段（#381 sha256 钉住的几段）一字未改。
### 修复：新话题页可以直接带图片 / 文件，用户消息里的图片稳定显示

- 新话题页（`/channel/new`）的输入框原来不支持附件。现在在这里选择、粘贴或拖入文件时，会先建一段**草稿对话**（`POST /api/channels` 带 `draft: true`），把已输入的文字和文件交给它，再跳到 `/channel/<id>`（替换历史记录）。新对话的输入框会自动带上附件并开始上传，预览和文字都保留、不闪。
- 草稿对话在第一条消息记录进来之前，不进任何人的对话列表和直达对话（所有设备都一样；服务端用 `description` 标记加 `last_message_at is null` 过滤，没有表结构变化）。没发就离开（换到别的对话，或者留着的页面超时卸载）时立即 `DELETE`，写了一半的字放回新话题页。
- 用户消息里的图片：单张按已有的 width/height 预留占位尺寸，多张走现有的叠放组（ImagePile）。点开看大图拉原图。本 PR 不做缩略图缩放。
- 草稿对话的删除带条件（`DELETE /api/channels/:id?draft=1`）：服务端确认它仍是空草稿（草稿标记、没有 `last_message_at`、线程里没有消息也没跑过一轮）才删，否则回 409 不动；这种删除不写 `channel.deleted` 审计、不发通知。复制标签页或机器人主动说过话的对话不会再被误删。
- 服务端每小时清理一次超过 24 小时的空草稿对话（同样的条件，可重复执行）；不是本地运行模式（`runtime.mode` 不是 `local`，消息不在本库）的部署一律不删，由启动配置直接决定，不再探测表。
- 新话题页：建草稿的请求没回来时不能发送（不会另建一段对话）；这期间、以及跳转还没完成时再加的文件都会带过去；文件全被拒时不建草稿。
- 草稿对话页只在去新话题页时立即回收；去设置等别的页面照常留 10 分钟，回来图还在。本标签页回收过的草稿再打开（返回键、刷新）拿到 404 时，静默替换到那个机器人的新话题页，不显示「对话不存在」。
- 没有宽高的图片加载前先占 240px、4:3 的固定框，加载完换成真比例。
- 新增测试：草稿对话的建立、过滤、删除（服务端 + 客户端），新话题带图跳转后保留文字和附件，输入框在没有对话时交出文件，接口返回的附件渲染（单图占位、多图叠放、大图）。
- 没有改 `styles.css` 的已有样式，没有升版本号。
- 回归返修：草稿对话里写了一半的字，没发就去新话题页时，现在新话题页输入框一出现就有字。原来要等藏着的草稿页卸载、回收后才把字放回，而新话题页输入框只在挂载时读一次草稿，结果一直空着，去设置再回来才出现。现在新话题页挂载时先同步把字挪回来（`reclaimDraftText`）；新增组件测试 `draft-leave-new-topic.test.tsx`（修复前失败）。
- 回复过程照 Hark 改：等待时只在机器人一侧显示一行状态胶囊（转圈 + 当前动作 + 秒数），替代原来的「思考中」三点气泡和停顿时的占位气泡；一轮做完后干活卡自动收起（从历史打开的也默认收起），不再留在对话里；正文里只有「---」、空白或标点的过程话 / 步骤不再画成一项。胶囊用现有设计 token（`--r-pill`、`--glass-strong`、`--glass-shadow-sm`、`--dur-2`），不用模糊，动画只动 transform / opacity；减少动态效果时转圈静止，减少透明度 / 性能模式下为不透明底色。样式在组件自己的 `app/src/components/chat/status-capsule.css`（只有 `rs-` 开头的新类），styles.css 未改。新增 `app/tests/reply-steps.test.tsx`。未升级版本号。
- 回复过程按审查修正：只有代码块的回复不再整段消失（`isBlankNote` 只认整段都是 `---`、`***`、`…` 这类分隔符，可以夹空白）；工具失败后没有文字、或只回了 `---` 的一轮不再是一片空白：干活那一行不收起（「N 步失败」），下面一句「这一轮没有回答」和重试（走现有的重发入口）。读屏：干活卡按钮名字里带上当前动作，对话末尾保留一个一直挂着的 `role="status"`，「思考中」换成干活卡时照样读出；键盘点开步骤后这一轮收起时焦点移到收起后的那一行；停顿时的胶囊和以前的占位等高（22px）；切换频道回来秒数不归零；胶囊换成干活卡不再播一次淡入；深色的不透明底色改用 `--glass-bg-solid` token。未升级版本号。
- 回复过程第二轮审查修正（#404）：以卡片收尾、后面没有字的一轮（生成图片、分享文件、问人、确认卡 / 审批卡、宿主提示、活动卡）不再被当成「这一轮没有回答」挂重试——判断和真正画卡片用同一份 旧聊天前端框架 渲染器表，只画一行过程的计算机工具注册时标 `lineOnly`；窄屏（≤ 560px）上没有回答的那一行仍显示「N 步失败」（`data-unanswered`，样式在 `status-capsule.css`，没改 `styles.css`）；同一轮重新开始跑（重试、确认后接着跑）时胶囊和干活卡的秒数从 0 算，切换频道回来仍不归零。
- 回复过程第三轮审查修正（#404）：生成图片 / 分享文件没拿到文件、定时任务被拒或报错、生成界面画不出东西时，渲染器什么都不画，这一轮改为算「没有回答」并给重试；判断由各渲染器自己导出（和它决定画不画用同一个函数）。
- 工具步骤显示按审查（模块 7）修正：后台任务卡（`delegate_task`）不再在这一轮结束、任务还在跑时跟着干活卡一起收起，刷新后也在——`delegate_task` 不算干活步骤，干活卡的锚点自己画卡片时只收干活那一行；在跑时点开干活卡，还没返回的步骤写「正在…」，不再标「（失败）」；停止后这一轮的步骤留着（收起，可以点开），没返回的标「已停止」，不计进「N 步失败」；同时在跑的几步写「正在搜索 N 项」「正在读取 N 个网页」，点开每一项都在；读网页那一步写主机名 + 短路径（`httpbin.org/status/500`），HTTP 4xx / 5xx 算失败；后台任务卡收起的清单 / 结果正文 `inert`，展开按钮的 `aria-expanded` 跟着真实状态，进度用 `role=status` 播报；调试模式下的工具输出改成纯文本、超过 4000 字截断、点开才画。依赖 #404。
- 回复过程第四轮审查修正（#404）：电脑上的 agent（`device_agent_run`）、后台任务（`delegate_task`）被拒时不再算有回答，后台任务也不再一直挂着等待卡；一轮结束后工具一直没有结果时，骨架换成「…没有完成」，这一轮算没有回答、可以重试；`render_ui` 格式有误时，这一轮已经结束就写「界面格式有误，没能显示」，不再说会重新生成。

## 0.1.110 — 2026-10-29

这一版合并 4 个 PR：性能模式 / 减少透明度全局不模糊（#375）、Hark 顶栏外壳（#374）、打开对话只读一次历史（#394）、断线重连后补齐漏掉的消息（#396）。只升级服务器版本号（根、`app`、`server` 为 `0.1.110`），PC / Android 外壳未变；没有表结构变化。

### 修复：重连补消息（#396）与打开对话只读一次历史（#394）

- 修复：断线重连后漏掉的消息不补。本机一轮刚结束 / 刚接完时 sync 会把下一次变化戳只记成基线（免得重放刚收到的），要是紧接着断网，重连后问到的第一次戳也被当基线，断线期间别处写进来的消息就再也不补。现在隔了 15 秒以上才问到的那一次，序号变了就合并式接上补齐；平时 2 秒一次的轮询照旧只记基线。只改前端。

- 修复：打开一段对话只读一次历史。打开频道聊天时已经和接入同时读了一份存下的对话，接入一结束 `useConversationSync` 又把它当成「本机一轮结束」做顺序核对、整份再读一遍（首次打开 since 为空，等于整份传两次）。现在打开时那次接入结束不再核对；本机自己跑完一轮后的核对照旧。只改前端。

### Hark 顶栏（Hark 改版第 2 步，见 `docs/rfc/hark-redesign.md`）

- **顶栏外壳（`glass-topbar.tsx`）**：左上角换成圆形主页按钮（品牌头像，点回主页）+ 品牌名 + 左栏开关；右上角是搜索胶囊和圆形头像（账号菜单，向下弹出）；中间不放分段切换，只有「聊天」一个视图。PC 无边框窗口的 — □ ✕（`.win-ctrls`）仍在最右，新按钮都不参与拖动。
- **搜索**：电脑上搜索框从左栏卡片顶部移到顶栏右上角（同一个输入框、同一份搜索状态，结果仍画在左栏卡片里，左栏收起时一聚焦就展开）；设置 / 管理里同样的胶囊是按钮，点了回聊天并聚焦搜索。手机上搜索框留在左栏抽屉顶部，顶栏只放菜单、搜索两个圆钮和头像。
- **玻璃**：搜索胶囊用唯一材质 `.glass`（读 `--glass-filter`，20px），是顶栏唯一的模糊层，不做过渡和动画；圆钮是 `.glass.is-flat`，不叠模糊。桌面同屏模糊层 4 → 5（再开一个弹层 6），手机仍是 1。
- **测试**：`channel-pagination.test.tsx` 的搜索历史和组字 Esc 两条用例改为把顶栏的搜索框和左栏一起渲染（电脑上搜索框已不在左栏里）；新增 `hark-token-dark.test.ts`，检查和旧深色层同名的 Hark 令牌在 `html.dark` 里有深色值（DESIGN.md §10.5）。
- **设计规范**：DESIGN.md 新增 §10.5「Hark 令牌与同名旧令牌」：`html:root` 会压过旧 `.dark`，新增同名令牌必须在 `html.dark` 里给深色值。
- **开发日志**：`docs/DEVLOG.md` 末尾追加这次的动机、改动和前后截图（`docs/images/hark-topbar/`）。
- 没有新增 `!important`，没有升版本号；外观设置页、壁纸上传、`wallpaper_core.html`、`bot-bubbles.tsx` 都没有动。

### 性能模式 / 减少透明度：全局不模糊

- **全局规则（新增 `app/src/perf-noblur.css`，`main.tsx` 里紧跟 `styles.css` 引入）**：性能模式（`html[data-perf="on"]`）和系统「减少透明度」下，`*, *::before, *::after` 一律 `backdrop-filter: none`，`--lg-blur` 也设成 `none`。原来漏掉的 streamdown 代码块 / 图表操作条（Tailwind `supports-[backdrop-filter]:backdrop-blur`，8px）、对话框 / 抽屉遮罩、agent-orb 内嵌样式、外观设置的玻璃预览都一起关掉。
- **不透明底色**：新增 `--glass-bg-opaque`（浅 / 深各一份）；左右栏、输入框、顶栏搜索、弹层 / 菜单 / 对话框、手机抽屉、代码块操作条、外观设置预览都换成它，不留透明无底的块。全屏遮罩只去掉模糊，保留半透明压暗。
- **不用 `!important`**：选择器前缀 `html:not(#chisabot-no-blur)` 多一个 id 的优先级，压过所有类 / 属性规则；旧玻璃层的 `!important` 靠 `--lg-blur: none` 关掉。
- **实测（浏览器审计，可见且 computed `backdrop-filter` 不为 none 的元素）**：性能模式和减少透明度下，桌面、手机所有场景都是 0（main 上桌面聊天 1、设置页 14，手机 1、抽屉 2）；普通模式与 main 一致（桌面 5 / 设置页 16，手机 2 / 抽屉 6）。
- **测试**：新增 `app/tests/no-backdrop.test.ts`：引入顺序、两种开关都覆盖 `*` / `::before` / `::after`、不靠 `!important`、不许内联 `backdropFilter` / Tailwind important 模糊类 / 新的 `backdrop-filter … !important`，`styles.css` 里每条会模糊的规则都有不透明底色或写明原因的豁免。
- 规则写进 `DESIGN.md` §10.3.1。不改版本号。

- 链接卡组照 Hark 改版（依赖 #380 的数据修正，已合入本分支）：一条回复里 2–3 个链接在文字气泡下面错落叠成一叠（中间那张抬高在最前，左右两张倾斜约 -4° / 3.5°），单个链接是一张不倾斜的卡，手机上卡变窄、整叠不出屏，统一用 `LinkCardStack` / `LinkCard`。鼠标悬停或键盘聚焦把那张卡挪到主位（只改 transform，`--dur-2` + `--ease-out`，不重排），指针离开后保持最后一张在主位；触屏第一次点只挪到主位、再点才打开，鼠标点击直接打开；减少动态效果时直接切换。GitHub 等宽图按 og:image 原比例完整显示（有 og:image:width/height 用实际比例，否则 GitHub 2:1、其它 1.91:1 占位，不跳动），GitHub 链接底行给短标签（如「GitHub · v0.1.13」）。材质按 docs/design-system.md 改成我们的设计系统：卡片用主题实色 `--glass-bg-solid`（不模糊、亮暗跟随主题，不照搬 Hark 的固定深色），圆角 `--r-lg`、内缩 `--sp-2`、图片同心圆角 12px，文字 `--text` / `--text-secondary`。标题一律纯文本渲染；props 兼容 #391 的来源格式 `{ url, title, site, toolCallId }`（本 PR 未接入）。未改 styles.css，未升级版本号。
- 链接卡组修正（依赖 #397）：流式输出时链接卡先出和最终卡同尺寸的骨架占位（不模糊、无闪光，只动 opacity / transform，减少动态效果时静止）；悬停换主位不再触发整页样式重算——原因是 styles.css 里 `.glass-shell:has([data-slot=…])` 一类规则让 Chromium 按属性名 `data-slot` 把整页（约 3581 个元素）重算样式，卡组改用 `data-stack-slot` 避开，styles.css 未改（Ayase 真 Chrome：CPU 1× 下悬停最长任务 53 ms → 没有超过 50 ms 的任务；4× 降速下 160–479 ms → 39–51 ms）；用户消息里的 GitHub 等链接也用 LinkCard 卡组显示，靠右对齐。审查模块 6 前端项：「追问」按钮移到 `<a>` 外面（不再嵌套交互元素），触屏上明确显示（窄容器里的一叠直接去掉），隐藏时一律不接点击；小图（宽 < 280px）不放大、不裁切，居中放在主题色衬底上；预览结果存 sessionStorage（6 小时、最多 80 条），刷新后卡片直接按最终高度出现，重访 CLS 为 0；favicon `loading="lazy" decoding="async"` 并给宽高；URL / 编号关掉 Inter 的上下文字形替换（`calt` 0），「411x7」不再画成「411×7」；预览可选带 `kind: "video"` / `thumbnail` 时图上叠一个播放角标（不模糊、不接事件，服务端未改）。顶栏一项因 #374 未合并跳过。未升级版本号。

## 0.1.109 — 2026-10-29

这一版合并 3 个 PR：回复来源结构化（数据格式先行，生产环境 `CHISABOT_REPLY_SOURCES` 保持关闭，#391）、web_fetch 重试 + 搜索摘要降级、工具失败后这一轮一定有回答（#392）、壁纸与外观收尾（#376，只改 app）。只升级服务器版本号（根、`app`、`server` 为 `0.1.109`），PC / Android 外壳未变；没有表结构变化。

### 回复来源结构化（#391）

- 回复来源结构化（数据格式先行）：新增 `shared/reply-sources.ts`，来源 = 这一轮里成功的 `web_fetch`（网址、标题、站点、toolCallId），挂在这一轮最后一条有文字的助手消息上；不新增存储和事件，实时和历史都从同一批消息算出。部署开关 `CHISABOT_REPLY_SOURCES`（默认关，/api/capabilities 带 `replySources`）打开后，网页聊天的 Bot 不再在正文写「来源：」行。前端卡片另做；开关关着时行为不变，旧客户端不受影响。未升级版本号。

### web_fetch 重试与兜底回答（#392）

- web_fetch 超时 / 连接中断时重试并降级到搜索摘要，报错不再被说成「用户已停止这一轮」；工具失败后模型没再说话时补一段回答，这一轮一定有回复（Hark A4）（#392）

### 壁纸与外观收尾（#376）

- 壁纸与外观收尾（审查第 6 项 + 性能报告第 7 项）：天空引擎不再请求 `ipapi.co`（不把用户 IP 发给第三方），GPS 失败时改用浏览器时区估计位置；壁纸上传限类型（PNG / JPG / WebP / GIF / AVIF）和大小（原图 ≤ 20 MB、压缩后 ≤ 约 6 MB），超限或保存失败时用现有 toast 明确提示，不再假装“已应用”；壁纸图片改存 IndexedDB，localStorage 只留占位标记，旧数据自动迁移并清掉；外观滑块拖动时 localStorage 写入防抖（停手约 200ms 或页面隐藏时写），预览仍实时；修掉 `appearance-preferences.tsx` 的 6 个 Biome a11y 错误；自定义壁纸 URL 写进 CSS 时转义 `\`、`"` 并去掉换行；刷新时选的是自定义壁纸、localStorage 里只有占位标记的话，先只铺主题纯色、不挂天空，IndexedDB 读回就直接显示壁纸，读取失败、没有记录或超过约 1.5 秒才退回天空，不再先闪一下天空。不改样式和外观。


## 0.1.108 — 2026-10-29

这一版合并 1 个 PR：回复风格对齐 Hark（提示词 + 服务端，#381）。只升级服务器版本号（根、`app`、`server` 为 `0.1.108`），PC / Android 外壳未变；没有表结构变化。

### 回复风格对齐 Hark（#381）

- 回复风格对齐 Hark（提示词 + 服务端）：去掉「导语 → 卡片 → 下一步」固定三段式，默认一个气泡、1–4 句、结论先行；render_ui 画过表格卡后不再附一份 Markdown 表格（提示词 + 工具结果都提醒）；推荐类问题直接给 2–3 个带价格的选项再追问（web_search 工具描述里写明一般搜 1–3 次就收敛）；数学用 Unicode 纯文本，不用 LaTeX（前端不恢复 katex）。安全和不可信内容相关的提示词一字未改，新增测试按 sha256 钉住。未升级版本号。

- 修复（Android）：机器人干活之后连发几条消息只看得到最后一条（前面几条被当过程话收起）。规则同网页（#393）：一轮结束后，最后一个干活的步骤之后的全部文字都照旧是气泡，和结果一样带复制按钮；render_ui、记忆写入（memory_save 等）这类不算干活的工具夹在回答中间不当分界；还在跑时不变。不算干活的工具同网页：message_bot、file_share、image_generate、image_edit 也不再数进干活卡的「做了 N 步」、不单独出干活卡。要发新版 APK 才生效。

## 0.1.107 — 2026-10-29

这一版合并 2 个 PR：手机尺寸左栏抽屉改成 Hark 手机端的一层面板（#378）、链接卡照 Hark 改版 + 数据侧修正（GitHub 等站点的预览图、标题，#380）。只升级服务器版本号（根、`app`、`server` 为 `0.1.107`），PC / Android 外壳未变；没有表结构变化。

- 链接卡照 Hark 改版：正文里单独一行的链接和 json-render 的 `Link` 合并成一个组件（`app/src/components/rich-previews/link-card.tsx`）。有预览图时是固定宽约 280px 的竖卡：上半 og:image 大图（cover，上方两角圆角），下面两行粗体标题和一行浅色「站点 · 补充信息」；没有图时退成同宽的紧凑横卡。半透明底 + 内侧高光边，不用 backdrop-filter；骨架和卡片同尺寸，图片懒加载并预留宽高。json-render 的 `Link` 不再只用模型写的字段：缺的预览图、标题、站点名用 `/api/link-preview` 补全，模型给了的优先，所以 GitHub 等链接现在会显示 og:image。样式在组件自己的 `link-card.css`（只有 `lc-` 开头的新类），styles.css 未改。未升级版本号。
- 链接卡数据侧按审查修正：模型写的标题如果只是站点名 / 域名，或被 og:title 包含（如「GitHub」「ChisaBot」），改用 og:title；每个链接给出预览图、站点名和补充信息，底下一行是「站点 · 补充信息」（如「GitHub · v0.1.13」）。标题和站点行不再固定高度（只有骨架预留），一行标题时下面不再空一大块。视觉细节留给前端的叠放卡改版。

- 手机尺寸左栏抽屉改成 Hark 手机端的一层面板：全高、贴左、宽 `min(85vw, 320px)`、只有右侧圆角，去掉外层半透明白板和里面那张卡片；顶部一行是搜索 + 新建 + 关闭（和顶栏按钮同一条中线，PC 小窗放到窗口按钮 / 拖动条下面），中间列表，账号在同一块面板最下面、上面一条分隔线、下面让开安全区；右侧遮罩改成只压暗不模糊（点它关抽屉）；开关只动 transform、200ms，减少动态效果时不做动画。玻璃只有面板自己的 `.glass` 一层（打开时同屏模糊层 3 → 1），性能模式 / 减少透明度下面板为不透明底色。新增 `app/tests/mobile-drawer.test.tsx`；`render-budget.test.ts` 的模糊名单删掉两条旧抽屉规则。未升级版本号。


## 0.1.106 — 2026-10-29

这一版合并 1 个 PR：机器人聊天页对话记录增量同步 + 卡片共享时钟（性能清单第 5 项，#370）。只升级服务器版本号（根、`app`、`server` 为 `0.1.106`），PC / Android 外壳未变；没有表结构变化。

### 对话记录增量同步 + 卡片共享时钟（#370）

这一版把机器人聊天页同步服务器对话记录改成增量的（性能清单第 5 项）：`GET /api/conversations（原旧兼容路由）/threads/:id/messages` 新增可选的 `since` / `cursor` 参数，没变化只回 `unchanged`、变了只回尾部，界面实际读对话记录的两条路径——频道聊天页恢复 / 刷新历史（`readThreadMessages`：挂载、重试、Bot 在别处说话后的拉取、发送看门狗、断线补齐、转录缓存）和每轮结束后的对话顺序核对（`useConversationSync`）——都改成带 `since` / `cursor` 增量读：600 条对话没变化时一次读从约 530 KB 降到 83 B、新增一条约 3 KB，没变化时直接复用上次结果、不触发 `setMessages`；编辑 / 删除 / 读失败 / 旧服务器照旧整份。`useThreadInbox` 的服务器轮询也改成增量（界面目前未启用该轮询）。不带参数的旧客户端响应不变。干活 / 后台任务 / 本机代理卡片的每秒计时器合并成一个共享时钟（无订阅者时停），其测试在共享进程里先还原真定时器和时钟。没有表结构变化，没有升版本号。

## 0.1.105 — 2026-10-29

这一版合并 4 个 PR：修 `test:app` 测试互相干扰与过时测试（#368）、CI 补 Biome 新增问题检查 / 完整 `test:app` / pc/ 安装构建（#366）、nginx 只信任 Cloudflare 给的真实 IP + 网关身份头防重放（审计 #5，#372）、Service Worker 关掉 navigation preload 修登录 `state_mismatch`（#373）。只升级服务器版本号（根、`app`、`server` 为 `0.1.105`），PC / Android 外壳未变；没有表结构变化。#372 改了 `deploy/public/nginx.conf`，网关 nginx 配置随这次部署一起更新。

### 测试隔离（#368）

修 `bun run test:app` 的测试互相干扰和几个过时的测试（审查清单第 3 项第二部分）：电脑控制在换页面后重新挂上 focus/online 监听；日程测试不再用进程级的 `mock.module` 替换 `@/lib/client`；更新 5 个与现行行为不符的 server 测试。server 补声明测试直接用到的 `旧聊天运行时包`；CI 里 chisabot-node 打包失败改为让构建失败。schedule-fired 的 `Link` 替身有路由时交给真 `Link`、没有路由才按 params 填路径参数，移出隔离名单；avatar-picker-shape 拆 happy-dom 前先等 React 排队的工作跑完，不再报 Unhandled error，`test:app` 退出码恢复 0。不改版本号。

### CI 门禁（#366）

- CI 门禁加固：`scripts/biome-new-issues.ts` 在 Biome 自身出错（退出码非 0 且没有可解析的 JSON，例如 biome.json 写坏）时一律失败；改用 `process.exitCode`、正常返回，确保 `biome-base-*` 临时目录被清理；用法注释与 workflow 实际传的基线一致；新增 `scripts/biome-new-issues.test.ts`。修默认 `error` 输出自己调自己（有新增问题或 Biome 出错、又没传回调时——CI 正是这样调用——脚本卡死），找不到 Biome / git 可执行文件改为退出 2。

CI 补三道检查（审查清单第 3 项）：Biome 只拦改动文件里新增的诊断（全仓存量不拦，`scripts/biome-new-issues.ts`）；完整跑一遍 `bun run test:app`；pc/ 作为独立 npm 项目单独安装并打出 chisabot-node 无头包、校验 `--version`。不改版本号。

### 安全：nginx 真实 IP + 网关身份头防重放（审计 #5，#372）

- 安全（审计 #5）：公网 nginx 只信任 Cloudflare 官方网段给的 `CF-Connecting-IP`（`real_ip_header` + `set_real_ip_from`），`limit_req`、日志和 `X-ChisaBot-Client` / `X-Forwarded-For` 改按真实客户端 IP；网关身份头 `X-ChisaBot-Identity` 加一次性随机数 `j`，应用在 ±2 分钟有效期内只认一次，重放返回 401（去重缓存 TTL = 有效期、上限 10 万条）；nginx 每个转发都清掉客户端自带的 `CF-Connecting-IP`、把 `X-Real-IP` 设为真实 IP，IM OneBot 失败限速和设备令牌限速共用同一个取 IP 函数（`gatewayClientIp`），伪造头绕不过限速。未升级版本号。

### 修复：登录 state_mismatch（#373）

- 修复：开着 Service Worker 时 Chrome 登录最后落到 `/api/auth/error?error=state_mismatch`（会话其实已写入）。sw.js 不再开 navigation preload，激活时显式关掉（`SW_VERSION` 3）；`/api`、`/auth` 下的导航照旧不拦、只由浏览器发一次。未升级版本号。
  - 一次性过渡窗口：部署后，没刷新过的旧页面直接登录，或者刷新后在新 Service Worker 接管之前就登录，这一次仍由旧的 v2 Service Worker（开着 navigation preload）处理，可能还会出现一次 `state_mismatch`，再登录一次就好。新 SW 接管时间按代码算：页面 `load` 后用 `requestIdleCallback` 注册（超时 5 秒；浏览器不支持时固定 2 秒），再加上下载、安装 sw.js 的时间，`skipWaiting` + `clients.claim` 后立即生效，所以大约是刷新后 5 秒以内。之后不会再出现。

### 安全：PC 更新验签（审查第 7 项 / M7）

方案和 Jun 要做的密钥操作见 `docs/pc-update-signing.md`。**Windows 端到端跑完前不合并**；不改版本号，第一个带验签的版本号合并时定。

- **签名清单（`pc/src/update-signature.js`）**：发布时用 Ed25519 对 `latest.yml` 的规范化消息（version / path / 安装包 sha512 / size / chisabotShell / fullInstall）签名，写进新字段 `chisabotSig: '<keyId>:<base64>'`；安装包本身不改。
- **客户端（`pc/src/updater.js`）**：内置公钥表 `pc/src/update-keys.json`（主 + 备两把公钥）。下载完先进入「正在校验更新包签名」，验清单签名并重算下载文件的 sha512 / 大小，通过才弹「新版本已下载」、才能安装。缺签名、未知密钥、签名不符、哈希不符、公钥表损坏，一律删掉安装包、提示「更新包签名校验失败，已拒绝安装」、写审计 `update_rejected`、立即和退出时都不安装；没有「只告警不拦截」开关。
- **electron-updater 6.8.9 核对**：`app-update.yml` 没有 `publisherName` 时，`NsisUpdater.verifySignature` 直接返回通过，**根本不调用** `verifyUpdateCodeSignature`；复用缓存安装包时连这一步都不走。所以验签放在 `update-downloaded` 里自己做。另外 electron-updater 只在派发 `update-downloaded` 的那一刻决定挂不挂退出安装，所以启用验签后退出安装改由 `installOnQuit` 调 `autoUpdater.install(true, false)`。
- **自建版**：公钥表为空（自建版没配公钥）时保持旧行为（只有 sha512），网页「本机」页提示「此版本未启用更新验签」；可用仓库变量 `CHISABOT_UPDATE_PUBKEYS` 提供自己的公钥。
- **脚本**：`pc/scripts/sign-update.js`（签名，私钥来自 `PC_UPDATE_SIGNING_KEY` 或 `--key-file`，不打印；`--verify` / `--tamper-check` / `--require-keys` / `--keys-from-env`）、`pc/scripts/gen-update-key.js`（私钥只写到仓库外的文件，不打印）。`shell-fingerprint.js --stamp` 会去掉旧签名，签名永远是最后一步。
- **CI（`release.yml`）**：新 job `pc-sign` 绑定 Environment `pc-release`（只允许 `v*` 标签、不设审批人），用 Environment secret 自动签名并做验签 + 篡改自检；跑 electron-builder 的 Windows job 拿不到私钥。通用版发布时公钥表为空直接失败；发布必须从标签运行。
- 不买代码签名证书，Authenticode 第二阶段暂缓。仓库里没有任何真实密钥，测试用现生成的临时钥。

## 0.1.104 — 2026-10-29

这一版合并 5 个 PR：修复干净安装下缺声明的依赖（#365）、出口过滤代理按 Bot 独立鉴权（审计 H1 / L1，#364）、界面渲染性能预算（#363）、安装版 `/api` 代理不再转发失效的 `Content-Encoding`（#367）、Hark 改版第 1 步令牌层（#369）。只升级服务器版本号（根、`app`、`server` 为 `0.1.104`），PC / Android 外壳未变；没有表结构变化。

### 修复（#365）

- 根 `package.json` 补声明 `@json-render/core` / `@json-render/react`（0.21.0，与 app/server 及 lockfile 一致）。`shared/json-render` 不属于任何 workspace，在 Bun 默认的隔离 linker 下只能从根 `node_modules` 解析依赖；此前根未声明，导致干净安装后 server/app 的 typecheck 与 build 报 `Cannot find module '@json-render/core'`，只能靠 `--linker hoisted` 绕过。
- `app/package.json` 的 devDependencies 补声明 `@ag-ui/client`（1.0.1）、`rxjs`（7.8.1）、`esbuild`（0.28.2），版本均与 lockfile 中已解析的一致。app 的测试直接引用前两者，`vite.config.ts` 构建时动态 `import("esbuild")` 打包 pc headless 脚本；隔离 linker 下它们原本解析不到，导致 app typecheck 失败，esbuild 那一步也会被 try/catch 静默跳过。
- `bun.lock` 只在 workspace 声明区增加上述条目，没有新增或变更任何包解析结果。

### 安全：出口过滤代理按 Bot 独立鉴权（审计 H1 / L1，#364）

- **每个 Bot 独立的代理密钥（`agent-computer/src/egress.ts`）**：代理凭据改为 HMAC-SHA256(进程内随机主密钥, botId)，浏览器与 shell 都只拿本 Bot 的派生密钥；校验为定长摘要 + `timingSafeEqual`。
- **拒绝伪造凭据**：带了 botId 但密码为空、错误、或用 A 的密钥冒充 B，一律 403，不再降级。
- **无凭据连接走独立兜底**：不按任何 Bot 判定、不读任何 Bot 放行名单、不用 Bot 的上游代理，只放行默认软件源；本机任一 Bot 为 `allowlist_only` / `deny_all` 时拒绝；记节流日志 `EGRESS_ANONYMOUS`（只记来源与目标）。
- **硬拒绝网段**新增 `0.0.0.0/8` 与 `100.64.0.0/10`。
- **命令补传 botId**：服务器 `runCommand` 在 `/exec` body 中带 `botId`；电脑 `/exec` 缺省时回退到 `x-chisabot-bot-id` 请求头。
- 无需新增环境变量；电脑进程重启后旧代理凭据失效。

### 渲染预算（#363）

这组改动只做渲染性能，不改布局和配色：性能审计实测，主界面卡顿主要来自三处——同屏 14 层毛玻璃（全文档 91 个元素带 `backdrop-filter`，气泡、按钮、胶囊、滚动区里的卡片都在模糊）、WebGL 天空在空闲时也按满帧满分辨率重画（还开着 `preserveDrawingBuffer`）、以及 `background-position` / `box-shadow` 驱动的无限循环动画。这里把毛玻璃收到预算内、让天空默认只画一张快照、无限动画只动 `transform` / `opacity`，并加上性能模式的状态开关。外观设置页、壁纸上传和 `wallpaper_core.html` 都没有动。

- **毛玻璃预算（`styles.css`）**：
  - 大面板（左栏、右栏、输入框、顶栏、抽屉 / 对话框）统一 20px，弹层（菜单、选择框、浮层、提示）12px，任何地方都不超过 30px（`--glass-blur`、新增 `--glass-pop-filter`、`--blur-2/3` 改为 20 / 24px）。
  - 气泡、按钮、胶囊、对话里的卡片、设置页卡片、右栏里的小卡片、全屏遮罩不再模糊；旧的「三档玻璃材质」`!important` 层不改，也不新增 `!important`，只在这些元素自己身上把 `--lg-blur` 设成 `none`。
  - 正在做宽度动画的详情面板不再模糊，底色加厚代替。
  - 滚动区的渐隐遮罩（`scroll-fade-b`、右栏滚动区、横向卡片轨道）去掉。
  - 主界面同屏可见的模糊层：桌面 14 → 4，手机 10 → 1。
- **无限循环动画只动 `transform` / `opacity`**：工具行扫光、模型胶囊闪光、骨架闪光、保存提示、设备在线点、推理文字闪光等 10 个关键帧改为透明度呼吸；页面看不见时暂停所有无限动画（`lib/perf-mode.ts`）。
- **天空（`sky-background.tsx`）**：引擎拿到的 `requestAnimationFrame` 由宿主限到 15fps，画布按 0.6 倍分辨率绘制；默认（精选场景）只在启动、换场景、改窗口大小时醒来，换场景的交叉渐变（引擎 2.5s）画完才停在最后一帧，天气数据晚到时再醒一次把后续渐变画完；改窗口大小、从后台回来、从壁纸 / 性能模式切回天空时当帧立即重画，不会露出被清空的灰底；「背景随时间变化」时也只在页面可见、窗口有焦点且 2.5s 内有操作时才跑；设了壁纸或开了性能模式不启动引擎；不再强制 `preserveDrawingBuffer`；系统「减少动态效果」时退回快照。
- **性能模式与系统偏好**：新增 `chisabot.perf-mode` 状态（`<html data-perf="on">`），开启后所有毛玻璃关闭、大面板换成接近不透明的底色、天空不启动；系统「减少透明度」走同一套样式。设置入口留到后续 PR。
- **外观偏好只写改动过的键（`appearance.ts`）**：拖一下滑块不再把 8 个键（包括自定义壁纸的 data URL）全部重写一遍。
- **测试**：新增 `app/tests/render-budget.test.ts`，静态检查模糊半径、会模糊的选择器白名单、小元素关闭旧玻璃层、无限动画属性与滚动遮罩。

### 修复：安装版 `/api` 代理不再转发失效的 `Content-Encoding`（#367）

- **`app/serve.ts`**：Bun 的 `fetch` 已自动解压上游 gzip 响应，但代理原样转发了 `Content-Encoding: gzip` 和压缩时的 `Content-Length`，浏览器再解压一次就报 `ERR_CONTENT_DECODING_FAILED`，安装版 PC 客户端 `/api/me` 加载失败。现在转发前删掉 `content-encoding`、`content-length` 及逐跳头（`transfer-encoding`、`connection` 及其列出的头、`keep-alive` 等），其他头照常转发，多个 `Set-Cookie` 逐条保留。
- 新增测试：gzip 上游经代理后客户端可正常解析 JSON、不带 gzip 编码头、多值 `Set-Cookie` 保留。

### Hark 令牌（Hark 改版第 1 步，见 `docs/rfc/hark-redesign.md`，#369）

- **设计令牌（`styles.css` 开头）**：新增 `html:root` / `html.dark` 两套 Hark 令牌——文字基色 `--text` 加两档透明度（次要 `.5`、三级 `.3`，由 `color-mix` 算出 `--text-secondary` / `--text-tertiary`）、底色（`--regular-bg`、`--thin-bg`、`--composer-bg`、`--cell-bg`、气泡底色）、描边、强调色 `--accent-color`、状态色、圆角 `--r-*`、字号 `--fs-*`、行高、阴影 `--elev-*`、动效时长和默认静态壁纸渐变。选择器特异度 (0,1,1)，压过后面各层的同名令牌，不用 `!important`。
- **字体**：`--font` 改为 Inter Variable 打头（`@fontsource-variable/inter` 早已引入），中文仍回落到系统黑体。
- **唯一玻璃材质 `.glass`**（文件末尾，含 `.is-pop` 弹层、`.is-flat` 不叠模糊）：这一步只定义，还没有组件使用，第 2–4 步换上。
- **玻璃令牌拆分**：`--glass-blur` 从完整滤镜改为半径（20px），新增 `--glass-pop-blur`（12px）、`--glass-saturate`（160%），`backdrop-filter` 统一读 `--glass-filter` / `--glass-pop-filter`；数值与渲染预算相同，性能模式和「减少透明度」改为关掉 `--glass-filter`。
- **测试**：`render-budget.test.ts` 改读新令牌名（面板 20px、弹层 12px、饱和度 160–180%、文字透明度 .5 / .3），会模糊的选择器白名单加上 `.glass` / `.glass.is-pop`。
- 外观上的变化（拉丁字母和数字换成 Inter、次要文字稍淡）见 `docs/images/hark-tokens/` 的前后截图；布局不变，同屏可见模糊层不变（桌面 4、手机 1）。外观设置页、壁纸上传、`wallpaper_core.html`、`bot-bubbles.tsx` 都没有动，没有升版本号。

## 0.1.103 — 2026-10-29

这一版修复聊天 SVG 卡片的存储型 XSS（审查 S1，#362）：SVG 卡片和 Mermaid 卡片改用 DOMPurify（SVG profile）清洗，SVG 卡片改成 `<img>` 渲染，`/onerror`、`onbegin` 等写法不再能执行脚本；主应用同时加上 CSP（Report-Only，先只上报不拦截，便于观察后再收紧）。只改服务器 + 网页，没有表结构变化；PC / Android 客户端外壳未变，版本号仍为 0.1.100。

## 0.1.100 — 2026-10-28

这一版将「设置 → 通用 → 外观 → 自定义图片壁纸」底部的网络链接输入框（`https://...`）替换为**本地图片点击与拖拽上传横幅（`.appearance-upload-dropzone`）**，并在壁纸网格中直接提供**「上传本地壁纸」卡片**，支持点击选择或直接将电脑中的图片（PNG / JPG / WebP / GIF / AVIF）拖拽到上传区即可自动压缩保存并应用。全仓工作区子包、PC 客户端、服务端与 Android 客户端同步更新至 0.1.100（Android `versionCode` 297）。

## 0.1.99 — 2026-10-28

这一版统一对齐全仓工作区子包版本号（根 `package.json`、`app/package.json`、`server/package.json`、`agent-computer/package.json`、`pc/package.json`、`android/app/build.gradle.kts` 全部升级至 `0.1.99`，Android `versionCode` 296），并修复服务器 PC 客户端更新源文件名同步（`ChisaBot-PC-0.1.99-x64-setup.exe` 与 `latest.json`），确保桌面端在线更新正常推送安装。

## 0.1.98 — 2026-10-28

这一版完整复刻 **Hark** 的原生 WebGL 动态天空与天气壁纸引擎（`wallpaper_core.html`）以及 1:1 半透明液态玻璃设计系统：在 `#sky-root`（`<canvas id="gl">`）中实时渲染瑞利大气散射、多层体积流云、太阳轨迹与 12 个全球地标天象场景；首帧绘制完成时自动将 `body` 设为完全透明（`html[data-sky-painted] body { background: transparent }`）；修复 `@tailwindcss/vite`（LightningCSS）在同时声明 `-webkit-backdrop-filter` 与 `backdrop-filter` 时自动剥离无前缀 `backdrop-filter` 导致玻璃失去模糊透视的根本缺陷，全面对齐 Hark 的 `backdrop-filter: blur(50px)` 与 `plus-lighter` / `color-dodge` / `soft-light` 光学图层混合配方。PC 客户端、服务端与 Android 客户端同步更新至 0.1.98（Android `versionCode` 295）。

### Hark 原生 WebGL 动态天空引擎与 1:1 液态玻璃光学复刻

- **Hark 原生 WebGL 动态天空与天气引擎（`app/public/wallpaper_core.html`、`sky-background.tsx`、`appearance.ts`）**：
  - 完整引入 Hark 的 WebGL 实时大气散射、云层步进（Raymarching）与气象着色器（`wallpaper_core.html`），在 `#sky-root > <canvas id="gl">` 中以 60fps 渲染真实天空与流云。
  - 首帧 WebGL `gl.drawArrays` 完成时在 `<html>` 标记 `data-sky-painted`，立即隐藏静态垫片并将 `body` 背景置为 `transparent`，使所有玻璃面板直接透视底层 WebGL 实时天空画布。
  - 在「设置 → 通用 → 外观」中新增 **14 项 Hark 动态天空与气象场景选择**（含智能跟随主题、实时时钟天气，以及巴黎正午、雷克雅未克晴空、夏威夷碧海、特内里费星夜、大峡谷日出、开普敦晨光、悉尼海岸、苏黎世雪山、巴塔哥尼亚、乌斯怀亚、阿塔卡马星空、撒哈拉暖阳 12 个精选场景）。
- **修复 LightningCSS 剥离 `backdrop-filter` 并 1:1 复刻 Hark 玻璃混合配方（`styles.css`）**：
  - 移除覆盖层中冗余的 `-webkit-backdrop-filter` 声明（避免 LightningCSS 剥离标准 `backdrop-filter`），保留唯一无前缀 `backdrop-filter: blur(50px)`。
  - 1:1 采用 Hark 的设计令牌（`--fill-primary`、`--fill-tertiary`、`--stroke-primary`、`--stroke-composer`、`--bubble-user-bg`、`--bubble-agent-bg`、`--composer-bg`、`--thin-bg`、`--cell-bg`、`--regular-bg`）与图层混合模式（浅色模式 `background-blend-mode: plus-lighter, color-dodge, normal`，深色模式 `normal, soft-light`），让左栏卡片、左下角账号卡、对话气泡、底部输入框与右侧面板栏呈现纯正的 Hark 半透明毛玻璃质感。

## 0.1.97 — 2026-10-28

这一版彻底重构**液态玻璃（Liquid Glass）**面板的半透明光学质感：修复 `.glass-shell` 入场动画 `animation-fill-mode: both` 在 Chromium 中形成独立 Backdrop Root 导致子面板 `backdrop-filter` 无法透视背景壁纸的问题；将深色与浅色模式下的面板材质统一为冰白半透明晶块（默认 16% 不透明度 / 84% 透光率，告别深藏青色实心质感）；新增全局环境柔光球（`.chisabot-ambient-orbs`）、**雾蓝光晕**推荐壁纸以及**「玻璃面板不透明度」**无级滑块（5%–80%），并将左栏搜索框、机器人选中项、用户与机器人聊天气泡、底部输入框胶囊、右栏分段槽与实时卡片全部升级为半透明液态玻璃。PC 客户端、服务端与 Android 客户端同步更新至 0.1.97（Android `versionCode` 294）。

### 半透明液态玻璃光学重构与不透明度无级调节

- **修复 Chromium `backdrop-filter` 透视阻断（`styles.css`）**：移除液态玻璃与晶莹高透模式下 `.glass-shell` 与 `[data-slot="sidebar-wrapper"]` 的 `animation-fill-mode: both`，避免 Chromium 将外层容器提升为独立 Backdrop Root，让左栏、底栏输入框、气泡和右栏真正实时采样并折射背后的天空、环境光球与壁纸。
- **冰白半透明晶块材质（`styles.css`、`appearance.ts`）**：
  - 将浅色与深色模式下的 `--lg-surface` / `--lg-surface-strong` 重构为冰白半透明折射层（`rgba(255, 255, 255, α)`，默认 84% 透光率）配合 `blur(16px) saturate(195%)` 与立体曲面高光边框（`--lg-rim`），彻底消除深色模式下面板比背景更黑、看起来像不透明深色石板的问题。
  - 将左栏搜索框（`.side-search`）、新建按钮（`.glass-list-add`）、选中机器人胶囊（`.glass-bot-row.is-on`）、用户发送气泡与机器人回复气泡、底部输入框及模型/权限胶囊（`.model-pill` / `.perm-chip`）、右栏顶部分段槽（`.sg-segmented`）与内部看板卡片（`.rail-card .glass-card`）全部同步为半透明液态玻璃。
- **环境柔光球与「雾蓝光晕」壁纸（`sky-background.tsx`、`appearance.ts`）**：默认渲染跨面板边缘的柔光球层（`.chisabot-ambient-orbs`），即使未配置自定义壁纸也能直观看到面板边缘的半透明光影折射；内置壁纸新增**雾蓝光晕**（液态玻璃推荐）。
- **玻璃面板不透明度滑块（`appearance-preferences.tsx`）**：在「设置 → 通用 → 面板玻璃材质」下方新增**玻璃面板不透明度（5%–80%）**实时调节滑块，用户可自由定制通透程度。

## 0.1.96 — 2026-10-28

这一版在「设置 → 通用 → 外观」中新增 8 款精选主题配色、6 款内置流光壁纸与自定义图片壁纸配置（支持本地上传、链接输入、景深模糊与暗角遮罩调节），并将主界面左栏卡片、左下角账号卡、底部聊天输入框、对话气泡、右侧面板栏及内部看板卡片全面升级为具有曲面边缘高光与高饱和色彩折射的**液态玻璃（Liquid Glass）**材质。PC 客户端、服务端与 Android 客户端同步更新至 0.1.96（Android `versionCode` 293）。

### 多款主题配色、自定义壁纸与液态玻璃面板材质

- **8 款精选主题配色（`appearance.ts`、`appearance-preferences.tsx`、`styles.css`）**：支持在**晴空蓝**、**极光紫**、**翡翠森**、**樱花粉**、**深海蓝**、**暮光金**、**绯红星**、**曜石黑**之间一键切换，自动联动浅色/深色模式下的天空背景氛围与强调色令牌。
- **自定义壁纸与内置流光壁纸（`appearance.ts`、`sky-background.tsx`）**：
  - 提供**流光幻境**、**极光星夜**、**深海琉璃**、**绯樱春晓**、**落日旷野**、**霓虹幻夜** 6 款内置流光壁纸，支持上传本地图片（自动压缩为高清 WebP/JPEG 本地持久化）或粘贴图片 URL。
  - 支持调节**壁纸景深模糊（0–32 像素）**与**背景暗角遮罩（0%–75%）**，确保任何壁纸下文字依然清晰易读。
- **液态玻璃（Liquid Glass）面板材质系统（`styles.css`）**：
  - 为左栏（`.glass-side-card`）、左下角账号卡（`.acct-card`）、底部输入框（`.glass-composer`）、对话气泡、右侧面板栏（`.rail-card` 及内部实时卡片）引入多角度曲面高光边缘（`--lg-rim`）、对角折射光泽（`--lg-surface`）与高饱和背景模糊（`--lg-blur`），并支持在**液态玻璃**、**晶莹高透**、**经典磨砂**三档材质间切换。

## 0.1.95 — 2026-10-28

这一版清理并优化右栏「计算机」面板的视觉与活动记录展示：去掉与画面卡重复的顶部「大屏正在直播」横条，修复用户接管浏览器被显示为「请你帮忙 / 我来接管浏览器。」及重复刷屏的问题，将「【后台刷新面板，不是用户在聊天】…」内部提示词提炼为简短标题，并剥离网址中的 Cloudflare 验证串、改为单行省略排版。PC 客户端、服务端与 Android 客户端同步更新至 0.1.95（Android `versionCode` 292）。

### 右栏「计算机」面板视觉降噪与活动记录优化

- **去除顶部重复的大屏直播提示条（`computer-panel.tsx`）**：桌面端及「画面」标签页下，下方画面卡已完整展示「大屏正在直播」说明，不再在上方重复渲染两行相同的「画面正在大屏直播，这里暂停预览…」胶囊。
- **修正「你自己的操作」文案、图标与去重（`computer-activity-labels.ts`、`activity-groups.ts`、`activity-log.tsx`）**：
  - 用户点击「接管控制」产生的人工接管步骤由原先误用的终端图标 + `请你帮忙 / 我来接管浏览器。` 修正为手势图标 + `接管了浏览器`，并在同一组「你自己的操作」中对多次重复接管自动去重、隐藏组内每行重复的紫色「你」标签。
- **后台面板刷新标题提炼（`formatTurnPrompt`）**：将 `【后台刷新面板，不是用户在聊天】面板「xxx」…` 等内部系统提示词提炼为简明的 `刷新面板「xxx」`，不再在活动记录组头露出内部系统指令。
- **网址净化与单行紧凑排版（`shortUrl`、`styles.css`）**：剥离网址中的 `__cf_chl_*`、`utm_*` 等挑战/追踪参数与末尾斜杠，活动步骤改为单行左对齐 + 尾部省略号（悬停可看完整内容），彻底消除长网址折成四五行的杂乱现象。

## 0.1.94 — 2026-10-28

这一版修复云端电脑（`agent-computer`）在 Bun v1.3.14 下因 `node:net` Happy Eyeballs 定时器异常导致进程重启（「暂时连不上电脑」），并让 PC 桌面客户端在服务端版本更新或重连时立即触发更新检查。PC 客户端、服务端与 Android 客户端同步更新至 0.1.94（Android `versionCode` 291）。

### 云端电脑出口连接稳定性与 PC 客户端即时更新推送

- **修复云端电脑 `internalConnectMultipleTimeout` 崩溃（`agent-computer`）**：Bun v1.3.14 的 `node:net` 在启用 `autoSelectFamily: true` 且双栈目标连接超时时，内部定时器回调 `internalConnectMultipleTimeout` 会抛出未捕获的 `TypeError: null is not an object (evaluating 'context')` 导致 `agent-computer` 重启、前端计算机面板短暂显示「暂时看不到屏幕 / 暂时连不上电脑」。现改为禁用 `autoSelectFamily`、优先按 IPv4 排序并由 `tunnel()` 按已校验的固定地址列表顺序回退连接。
- **PC 桌面客户端即时接收更新推送**：
  - 网页在 PC 客户端内运行时（`PcLinkHint`），当检测到服务端版本（`/api/version`）与本机客户端版本不一致且开启了自动更新时，自动通过 `window.chisabotPC.checkUpdate()` 立即触发客户端后台检查与下载，不再等待数小时轮询。
  - PC 客户端节点重连成功时自动触发一次更新检查，并将后台定时检查间隔从 4 小时缩短至 30 分钟。

## 0.1.93 — 2026-10-28

这一版合入多标签页电脑控制选主（`CB-107`）、导航超时/502/503 自动恢复（`DF-13`）、记忆「全部撤销」防闪（`CB-111 P3`），并完成全项目深度安全与架构审查修复。PC 客户端、服务端与 Android 客户端同步更新至 0.1.93（Android `versionCode` 290）。

### 多标签页控制选主、PWA 慢响应恢复与记忆撤销优化

- **多标签页只保留一个 `control` 轮询源（`CB-107`，#330）**：通过 Web Locks 选主 + BroadcastChannel 广播（按账号隔离），多开标签页时仅由主标签页轮询电脑控制状态并同步给跟随标签页；主标签页后台节流时可见跟随标签页自动接管读取。
- **PWA 导航超时 / 502 / 503 自动恢复（`DF-13`，#335）**：Service Worker 区分断网与服务器响应慢（20s 超时或 502/503/504/522），显示「服务器响应慢，正在重试…」卡片并按指数退避探测恢复后自动回到原页面。
- **记忆「全部撤销」不闪新合并提示（`CB-111 P3`，#336）**：批量撤销合并的待删记忆时先清空合并集合再逐条恢复，避免中途闪出新的「已删除 N 条记忆」提示；补齐测试模块级状态重置与 bfcache 恢复保护。

### 全项目安全加固、跨平台兼容与可靠性修复

- **前后端安全加固**：
  - 聊天 SVG 代码块预览（`ArtifactCard`）新增 `sanitizeSvgMarkup` 严格剥离 `<script>`、`<foreignObject>`、`on*` 事件与危险协议属性；`.docx` 在线预览渲染后清理危险节点与事件属性；`app/serve.ts` 补齐安全响应头与上游不可达 502 保护。
  - 技能 URL 导入（`skill_import_url` 与 `/api/skills-chisa/import`）、个人数据源（日历 ICS、通知 Webhook）与 IM 外部地址统一接入 `guardedFetch` / `checkPublicUrl` SSRF 防护；IMAP/SMTP 开启 TLS 证书校验（`rejectUnauthorized: true`）与公网主机校验并过滤 CRLF 注入字符；`guardedFetch` 在跨源重定向时自动剥离敏感请求头并将 `301/302/303` POST 降级为 GET。
  - 容器镜像 `Dockerfile` 以受控的 `/usr/local/bin/chisabot-apt` 替代裸 `apt-get/dpkg` 免密 sudo，并将 `/app` 属主收紧为 `apiuser:apiuser`；公网认证网关优化单用户会话淘汰上限并优先保留管理员会话。
- **核心功能与多端跨平台修复**：
  - 修复每日晨报查询 `chisabot_schedules` 表使用了不存在的 `description` 列导致定时提醒为空的问题；入站 Webhook 增加速率限制与按日合并；备用模型（Fallback）补齐首包超时保护与 `AbortSignal` 监听器清理。
  - 修复 PC 客户端在 Windows 下 `processList` 因输出超 64KB 被截断导致 `JSON.parse` 崩溃及逐进程查 CPU 过慢的问题；`sandbox.js` 注入 `-c core.autocrlf=false` 防止 Worktree 翻转 CRLF 行尾；`builtin.js` 补齐符号链接真实路径校验与 CRLF 编辑适配；`shell-fingerprint.js` 归一化 `.nsh` 行尾。
  - `agent-computer` 的 `/exec` 支持按 `botId` 注入独立出口代理凭据，避免多机器人共用容器时策略互相阻断；Android 客户端附件上传改用有界分块读取防止 `SIZE == -1` 时 OOM。
- **工程化与 CI 完备性**：修复 Windows + Hoisted 模式下 `bun run typecheck`（退出码 66）与 `app build` 脚本兼容性；修复 `check-zh-localization.cjs` 对 10 个核心契约文件的固定校验；补齐 CI 工作流遗漏测试。

## 0.1.92 — 2026-10-28

这一版修正 0.1.91 的形象头像：真机测试发现默认左栏是「机器人列表」而不是「对话行」，表情没有接进去，选中、在跑、做完时头像都不会变。PC 客户端与服务端同步更新至 0.1.92（Android `versionCode` 289）。

### 形象头像的表情接进机器人列表

- 机器人列表的宽栏行、收起后的窄栏头像、当前对话的隐藏机器人行，现在都会把「被选中」和「在跑」（`busy`）传给形象头像；做完（`busy` 由真变假）的表情由头像自己根据变化触发。
- `ChannelAvatar` 新增 `working`：只让形象头像做「在跑」的表情，不加右下角的小圆点（机器人列表用）；对话行仍用 `typing`（带小圆点），行为不变。其他种类的头像（图片 / 表情 / 首字 / 花纹）不受影响。
- 新增回归测试 `channel-avatar-mood.test.tsx`。

### 测试

- MCP 全员默认开启的数据库测试补上 `mcp_servers` 的必填列 `vendor` / `provenance`，并不再 `DROP TABLE plugin_grants`（在完整表结构的库上原先会失败 / 误删表）。

## 0.1.91 — 2026-10-27

这一版新增有表情会动的「形象」头像，并修复多用户功能评审中发现的问题，同时清理 lint 存量错误。PC 客户端与服务端同步更新至 0.1.91（Android `versionCode` 288）。

### 形象头像（shape）

- **14 个形状 × 11 种颜色**：库里只存形状和颜色两个键名（`chisabot_bot_avatars.shape` / `color`）；形状是自画的一套，每个形状是同结构的闭合曲线，所以任意两个之间都能逐点变形（换形状时用 `motion` 的弹簧驱动）。
- **表情**：在跑 > 刚做完 > 被选中 > 待机。待机没有任何动画；被选中眼睛变大并弹一下；在跑时呼吸、眼睛左右看、偶尔眨眼；做完（`busy` 由真变假）后弯成开心的眼睛跳两下，约 2.4 秒后恢复。系统开了「减少动态效果」时只保留静态表情。
- **头像窗新增「形象」页**，新建时默认停在这一页，页内的「选中 / 工作中 / 做完了」按钮只改预览。旧网页遇到 `shape` 退回默认花纹，Android 原生退回渐变底加首字。

### 多用户功能评审后的修复

- **共享技能**：`installSkill` 重写时保留原 owner，导致「改成共享」和「全员共享安装全部」遇到同名个人技能时静默无效；新增显式的 `claimOwner` 与 `resolveSkillOwner`，批量安装返回 `skippedCount`，成员传 `shared` 得 403。
- **邀请默认关闭**：网关邀请恢复为默认关闭，管理页新增「允许添加新成员」开关，新建账号 / 邀请不再悄悄把它打开。
- **公共知识库**：自己的笔记与别人共享的笔记分开查询、各自限量（公共部分最多 200 条），按 id 取笔记走主键。
- **MCP 全员默认开启**：开关结果缓存 5 秒、读取失败时沿用上次结果并写日志；对「全员共用一个部署凭据」的服务器拒绝开启（409）。

### 质量

- 设备本地 agent 面板的 hooks 写在提前 return 之后，数据一到就会报「Rendered more hooks」，已修复；`computer-view` 轮询的 `finally` 不再 return。
- biome 错误从 211 个清到 0（无障碍与 hooks 依赖按原因逐个处理，不是整体关闭规则）；`biome.json` 显式 `recommended: true`。

## 0.1.90 — 2026-10-27

这一版让定时任务测试可并行运行（`CB-112`），并改进桌面客户端令牌无效时的提示与托盘表现、修正定时任务名后的留白。PC 客户端与服务端同步更新至 0.1.90（Android `versionCode` 287）。

### 定时任务测试并行运行互不干扰（`CB-112`，#333）

- 定时任务相关测试改为并行运行时互不干扰（仅测试，无产品代码改动）。

### 桌面客户端令牌无效提示与托盘不闪；定时任务名留白（#334）

- **PC 令牌无效提示**：401 未明确撤销时提示改为「设备令牌无效，请重新登记这台电脑（每 60 秒自动重试）」，托盘与设备页一致。
- **后台重试不闪**：定时重试不再把状态切到「正在连接…」，托盘不闪；再次 401 时提示原样保留，成功则照常上线。手动「立即重连」不受影响。
- **定时任务名留白**：短任务名（如「早报」）后不再留出大块空白；长名照旧省略，窄屏下时间仍换到第二行。

## 0.1.89 — 2026-10-27

这一版让连删记忆时的撤销提示不再越堆越高（`CB-111`）。PC 客户端与服务端同步更新至 0.1.89（Android `versionCode` 286）。

### 连删记忆时撤销提示不再堆叠（`CB-111`，#331）

- **最多 3 条**：同时最多显示 3 条单独的「撤销」；第 4 次起合并为一条「已删除 N 条记忆 · 全部撤销」，N 随各条到期实时递减。
- **全部撤销**：只撤合并进来的那些，屏幕上单独显示的 3 条不受影响。
- **一条不丢**：每条待删仍独立 8 秒计时、到期真删；关页时照常提交。
- **手机**：窄屏（≤640px）下提示区右侧让出位置，不再盖住记忆行末的「⋯」，并适配底部安全区。

## 0.1.88 — 2026-10-27

这一版让桌面客户端在握手被 HTTP 拒绝（401/5xx）后继续重连（`CB-113`）。PC 客户端与服务端同步更新至 0.1.88（Android `versionCode` 285）。

### 桌面客户端握手被拒后继续重连（`CB-113`，#332）

- **5xx 与其他非 401**：部署期间网关返回 503/502/500 等时，电脑不再永久停在「离线」，而是按原退避（1 秒→30 秒，带抖动）自动重连，上线后退避归零。
- **401 且明确撤销（`revoked: true`）**：照旧停止。
- **401 但未撤销**：显示「设备令牌无效」，不再退出，每 60 秒重试一次；「立即重连」可马上重试。
- **CI**：PR CI 新增 `pc-test`，与发版流程的 PC 测试一致。

## 0.1.87 — 2026-10-27

这一版只修测试与 CI 稳定性（`CB-109`、`CB-110`），并让 PC 客户端在主动断开时不再上报多余的连接错误。PC 客户端与服务端同步更新至 0.1.87（Android `versionCode` 284）。

### 定时任务测试补回 CI（`CB-109`，#329）

- `server/tests/schedules.test.ts` 的 3 条过时用例已修正（测试前先登记所用对话），并加入 CI。

### 偶发测试错误修复（`CB-110`，#328）

- 前端测试收尾时先排空 React 调度，不再偶发 `window is not defined`。
- **PC 客户端**：停止或立即重连时丢弃的连接（可能仍在握手）不再上报「closed before the connection was established」错误；`reconnect.check.js` 补充对应用例。

## 0.1.86 — 2026-10-27

这一版让电脑控制状态更清楚、连接异常时不再刷错误（`CB-103`）。PC 客户端与服务端同步更新至 0.1.86（Android `versionCode` 283）。

### 电脑控制三态与控制台报错（`CB-103`，#319）

- **控制三态**：`GET /control` 返回 `none / live / user_control`。你接管电脑时右栏显示「电脑由你控制中，暂停预览；活动记录照常更新」，不再拉截图，也不再报 503。
- **接管期间的活动记录**：被让路的步骤记为「已拒绝：电脑当前由你控制」。
- **连不上电脑时**：`GET /control` 始终返回 200（读取 3 秒超时），连不上时显示「暂时连不上电脑」，按 1→2→4→8→15 秒退避重试，不再打控制台错误、不弹错误提示。
- **单一轮询源**：同一个机器人的控制状态只有一个轮询源，多个提示和按钮共用，请求数大幅减少；恢复后更快回到正常预览。
- **说明**：Cloudflare beacon 的 CSP 报错与本应用无关。

## 0.1.85 — 2026-10-27

这一版修正记忆删除与撤销（`CB-106`），并修复电脑卡片的按钮嵌套报错（`DF-30`）。PC 客户端与服务端同步更新至 0.1.85（Android `versionCode` 282）。

### 记忆延迟删除，撤销不再重建（`CB-106`，#326）

- **8 秒后才真正删除**：确认删除后记忆先在界面上隐藏，8 秒到点才删库；撤销只是取消这次删除，不发请求，原记录（id、创建时间、所属机器人）原样保留。
- **连续删除**：每次删除各自计时、各自撤销，互不影响。
- **离开页面**：应用内跳转不会取消或提前删除；关闭标签页或刷新时立即提交待删除项。
- **删除失败**：记录回到列表并提示错误。

### 电脑卡片按钮嵌套修复（`DF-30`，#325）

- 截图失败时，电脑卡片外框不再是包着「重试」按钮的 `<button>`，消除 React hydration 报错；外观、点击和键盘操作（Enter / Space）不变，点「重试」只重新加载截图。

## 0.1.84 — 2026-10-27

这一版可以直接编辑定时任务，并显示时区（`CB-106` 第 3 部分）。PC 客户端与服务端同步更新至 0.1.84（Android `versionCode` 281）。

### 编辑定时任务与时区显示（`CB-106`，#327）

- **编辑定时任务**：新增编辑弹窗，可修改名称、重复规则、时间和内容，保存即生效。
- **时区显示**：任务卡片、详情和编辑弹窗都显示时区；相关控件补上读屏标签。暂不支持修改时区；按月/按小时的 cron 显示为「自定义」。
- **细节修补**：`?runs` 传入非法值时回落为 20 条（上限 500）；窄屏下短任务名完整显示、长任务名仍省略；任务详情在打开、回到页面或重连时，超过 60 秒自动刷新。

## 0.1.83 — 2026-10-27

这一版给侧栏搜索加上键盘导航与命中信息（`CB-106` 第 2 部分）。PC 客户端与服务端同步更新至 0.1.83（Android `versionCode` 280）。

### 侧栏搜索键盘导航与命中高亮（`CB-106`，#323）

- **键盘导航**：焦点留在搜索框，↑/↓ 在结果间移动高亮（首尾循环），Enter 打开高亮项，Esc 照旧清空；输入法组字时不拦截，组字中的 Esc 也不会关掉抽屉。读屏器可识别 combobox / listbox / option。
- **命中信息**：每条结果显示「机器人名 · 最近活动时间」，图片消息摘要显示为「[图片]」。
- **跳转定位**：从搜索结果跳到消息后，命中行保持在视口内并闪烁，不再被对话贴底或补高顶走。
- **测试**：新增侧栏搜索导航与命中信息测试，并加入 CI。

## 0.1.82 — 2026-10-27

这一版是定时提醒的后续修补（`CB-105b`）。PC 客户端与服务端同步更新至 0.1.82（Android `versionCode` 279）。

### 定时提醒后续（`CB-105b`，#324）

- **单条提醒时间不截断**：窄屏（360/390）下只省略任务名，时间单独显示；折叠行放不下时在逗号后换行。
- **超过 20 条运行记录**：`GET /api/schedules/:id?runs=N`（默认 20，最多 500），折叠范围和展开后每条的时间都正确。
- **跨年年份**：折叠范围跨年时两头都带年份，例如 `2025/12/30–2026/01/02`。
- **清理旧数据**：启动时幂等地把已暂停任务残留的 `next_run_at` 清空，不动启用中的任务；没有新增迁移。

## 0.1.81 — 2026-10-27

这一版让长期记忆的删除更安全、长列表更快（`CB-106` 第 1 部分）。PC 客户端与服务端同步更新至 0.1.81（Android `versionCode` 278）。

### 记忆删除确认、即时撤销与长列表（`CB-106`，#322）

- **删除确认 + 即时撤销**：删除一条记忆先弹确认；删除成功立即给 8 秒「撤销」，不再等列表重新加载；撤销时保留公共知识库标记；删除失败不再给撤销。
- **长列表分段渲染**：每个种类先显示 50 条，其余点「显示其余 N 条」，搜索时不截断。2000 条记忆时列表可见从约 4 秒降到约 1.7 秒。
- **路由内跳转**：「管理全部长期记忆 →」改为应用内跳转并先关闭弹窗，不再整页重载。
- **记忆写入详情**：不再把内部 id 当正文显示；聊天里「撤销此记忆」失败时显示错误，不再误报「已撤销」。

## 0.1.80 — 2026-10-27

这一版让停止和排队消息更可靠（`CB-104`），并修复已暂停定时任务的旧提醒看起来像刚到点（`CB-105`）。PC 客户端与服务端同步更新至 0.1.80（Android `versionCode` 277）。

### 停止和排队消息可靠化（`CB-104`，#320）

- **停止即时生效**：服务端停止加 1.5 秒宽限，运行时迟迟不响应也会按已停止收尾；输入框立即显示「停止中…」，支持 Esc 停止（输入法组字时不触发）。
- **停止失败可重试**：停止请求出错或超时立即显示「停止失败，重试」，本轮结束或新一轮开始时自动消失。
- **排队消息**：停止收尾期间发的新消息直接发送，不再卡在「已暂停 · 等待你发送」；暂停的补充消息不再误报「这一轮没有收到回答」，恢复时不再重复显示；多条暂停时可「全部发送」。
- **运行隔离**：已停止的运行按 run_id 隔离，停止后运行时的迟到事件一律丢弃。

### 定时提醒显示与暂停（`CB-105`，#321）

- **按消息自己的时间显示**：到点提醒按运行记录的时间显示「今天 07:00」或「10月16日 07:00」，旧消息里存的「今天」不再原样显示。
- **连续提醒折叠**：同一任务连续的到点提醒折成一行「到点 N 次」，可展开查看每一次。
- **暂停清空下次运行**：暂停时清空 `next_run_at`，恢复时重新计算；发出前再次复核状态，刚被暂停的那次记为 skipped 不发出。

## 0.1.79 — 2026-10-27

这一版把计算机面板的「活动」改为服务端持久记录（`CB-101`），按对话轮次分组展示机器人与你在电脑上的每一步操作。PC 客户端与服务端同步更新至 0.1.79（Android `versionCode` 276）。

### 计算机活动记录（`CB-101`，#318）

- **服务端持久化**：打开网页、点击、输入、运行命令、读写文件都写入 `computer_activity_steps`，经 LISTEN/NOTIFY + SSE 实时推送，SSE 不通时退回轮询；旧服务端返回 404 时前端退回旧版活动日志。
- **你的操作**：人工操作标为「你」，输入的文字不存，8 秒内连续操作合并为一条。
- **打码**：URL 中的 token/key/code/secret 参数、密码框内容和疑似密钥一律显示为 `••••`。
- **展示**：拒绝状态改为人话；连续探测类命令合并为「运行了 N 条命令」，失败命令单独显示退出码；新记录淡入高亮且不打断阅读位置；大屏直播时提示预览暂停。
- **双向跳转**：活动 ↔ 聊天工具调用互相定位；窄屏（< 768px）新增「画面 | 活动」分段切换。
- **并发归属修复**：每次工具调用独立携带 thread/run/toolCall id，按轮次分组，无归属的显示为「未归属的操作」。
- **迁移**：新增 `0060_computer_activity_steps`（只新建表和索引）；删除 agent 时一并删除其活动记录。

## 0.1.78 — 2026-10-26

这一版全面适配竖屏、手机网页与 Android（`CB-098`）：修复窄窗下左侧栏与右侧面板抽屉的裁切、点不动、关不掉，并新增统一的「返回键关闭抽屉」。PC 客户端与服务端同步更新至 0.1.78（Android `versionCode` 275）。

### 竖屏 / 手机网页 / Android 抽屉与安全区适配（`CB-098`，#315）

- **左侧栏抽屉**：移动端宽度改为 `min(18rem, 100vw - 48px)`，不再被裁切；新增「关闭侧栏」按钮，内容不再横向溢出。
- **右侧面板**：抽屉态的收起按钮改为「关闭面板」；PC 客户端小窗下「面板/计算机」切换和点遮罩关闭恢复正常（抽屉与遮罩不再落在窗口拖拽区里）。
- **返回键关闭抽屉**：新增 `overlay-back` 抽屉栈。手机浏览器 / PWA 按返回键先关闭最上层抽屉，URL 不变、历史不残留；Android `BackHandler` 先调用 `__chisabotBack()`，没有抽屉时才后退页面。
- **安全区与软键盘**：抽屉适配刘海和底部安全区；Android 加 `imePadding()`，软键盘不再遮住输入框。
- **测试**：新增 overlay-back 单测、Android `NativeLogicTest` 用例和 `tests/mobile-portrait` 端到端验收（6 种尺寸 × web/pc × 12 条路由，0 失败）。

## 0.1.77 — 2026-10-26

这一版是 CB-100 的后续修补（`CB-100b`、`CB-100c`）：Hermes 判定更严、连接超时快速失败，网关兼容旧账号控件标记，不再在应用上方多浮一个退出按钮。PC 客户端与服务端同步更新至 0.1.77（Android `versionCode` 274）。

### Hermes 后续（`CB-100b`，#316）

- 管理员自检里 agent 内核与 Hermes URL 不一致时判为失败；Hermes 连接超时会快速报错，不再长时间挂起。
- 更新器的 compose 网络漂移检查不再依赖 python3（只用 bash 内建读取）；新增真实数据库的 Hermes 不可达集成测试，补充回滚文档。

### 网关与界面细节（`CB-100c`，#317）

- 登录网关 `workspace.js` 同时识别新旧账号控件标记（`chisabot-account-control` / `早期上游模板-account-control`），新网关配旧应用镜像时不再浮出第二个「退出登录」按钮。
- 上下文用量显示文字说明；首屏加载时显示启动状态提示；修复 quick-spotlight 相关测试。

## 0.1.76 — 2026-10-26

这一版修复改名后 Hermes 不可达导致对话卡住的问题（`CB-100`），并彻底下线云端 Claude Code 工作区整套功能（`CB-099`）。PC 客户端与服务端同步更新至 0.1.76（Android `versionCode` 273）。

### 固定 compose 网络，Hermes 不可达时快速失败（`CB-100`）

- **默认网络固定**：`deploy/compose.yaml` 的默认网络固定为改名前的 `早期上游模板-zh_default`（`172.19.0.0/16`，网关 `172.19.0.1`），可用 `CHISABOT_NETWORK_NAME` / `CHISABOT_NETWORK_SUBNET` / `CHISABOT_NETWORK_GATEWAY` 覆盖；应用保留旧 DNS 别名 `早期上游模板-zh`。宿主机 Hermes 桥接（`172.19.0.1:4100`）、`.env` 与 ufw 规则无需改动。
- **快速失败与发布自检**：Hermes 不可达时对话立即报错，不再一直挂起；更新器新增 `hermes-reach.sh`、`compose-image.sh`，发布后自检会经 Hermes 实测，网络断开时发布不再“假通过”。

### 下线云端 Claude Code 工作区（`CB-099`）

- 删除 `/cc` 页面、设置 → 云端工作区、服务器 `cloud-cc` 模块、云端工作区节点（`deploy/cloud-node`）与电脑文件夹同步（`/agent/sync*` 隧道、`pc/src/sync`）；左栏恢复为只有机器人列表。
- `/cc`、`/cc/*` 重定向到 `/`；Android 去掉「Claude Code」菜单项；发布流程去掉 sync-bin。
- 保留本地 agent 的 `claude` 类型、`CLAUDE_CODE_OAUTH_TOKEN` 与保险箱 `claude-proxy` 条目；10 张 `chisabot_cc_*` / `chisabot_cloud_workspaces` 表停用但**不 drop**。已部署云端节点需按 PR #313 的上线步骤手工撤销设备并移除容器。

## 0.1.75 — 2026-10-26

这一版把仓库与部署里残留的 早期上游模板 命名统一改为 ChisaBot（上游归属 `早期上游基础模板` 保留）。PC 客户端与服务端同步更新至 0.1.75（Android `versionCode` 272）。

### 早期上游模板 → ChisaBot 统一命名

- **代码、文档、界面、包名**：标识符、错误名、界面文案与文档统一为 ChisaBot；`@早期上游模板/agent-computer` → `@chisabot/agent-computer`，根包名 `chisabot`；`.claude/skills`、`docs/chisabot-architecture.md`、systemd 单元文件（`chisabot-zh-attachments.*`、`chisabot-public-cert-reload.*`）改名。
- **环境变量**：全部 `旧前缀环境变量` 改为 `CHISABOT_*`；新增 `shared/env-compat.ts`，未设置新名字时自动沿用旧的 `旧前缀环境变量`（登录网关同样兼容），已部署的 `.env` 不用改也能继续运行。
- **请求头**：`旧前缀请求头` 改为 `x-chisabot-*`；服务端/电脑服务/登录网关两种名字都认，发往托管 Bot 与电脑服务时两种都带，兼容旧镜像与已安装客户端。
- **浏览器存储**：`早期上游模板…` 本地存储键改为 `chisabot…`，首屏脚本一次性把旧值复制过来（主题、语言、布局不丢）；Android 同时写新旧主题键。
- **部署**：compose 项目/服务/容器改为 `chisabot-zh` / `chisabot` / `chisabot-zh`，网关容器 `chisabot-web-auth`、`chisabot-public-gateway`，默认目录 `/opt/chisabot-zh`；数据卷按名字固定为原来的 `早期上游模板-zh_*`，不会换成空卷；更新器按容器实际挂载备份数据卷，数据库备份文件改名 `chisabot.dump`。
- **保留不改（持久化 / 外部依赖）**：Postgres 数据库与角色 `早期上游模板`、`早期上游模板_*` 表与迁移、`早期上游模板_session` 等 Cookie（PC 客户端依赖）、`chisabotRun` 等已存储的协议字段、`早期上游模板_magpie` 网络、上游 `ghcr.io/早期上游基础模板*` 镜像与 `早期上游基础模板` 归属、历史 CHANGELOG。

## 0.1.74 — 2026-10-26

这一版把多用户与后台统一配置落地（`CB-096`、`CB-097`）：管理员可在线开启账号与邀请、直接新建账号或签发管理员邀请、升降角色与直接改密；并可在后台统一配置全员共享的公共知识库、全局共享技能与全员默认 MCP。PC 客户端与服务端同步更新至 0.1.74（Android `versionCode` 271）。

### 多用户管理与管理员角色（`CB-096`，DESIGN.md §117）

- **账号管理默认开启并可在线开关邀请**：`CHISABOT_ACCOUNTS_UI` 默认开启；认证网关新增 `settings` 表与 `PUT /auth/admin/invites-enabled`，管理员可在 `/admin/accounts` 或 `/settings/share` 一键开启多账号与邀请，无需 SSH 改环境变量重启。
- **双轨创建与多管理员**：`POST /auth/admin/accounts` 直接新建账号（普通成员 / 管理员）；邀请链接可指定角色（`invites.role`）；`PATCH /auth/admin/accounts/:id` 支持升降角色与直接改密（改密立即吊销旧会话，内置主管理员不可降级或停用）。

### 知识库、技能与 MCP 后台统一配置（`CB-097`，DESIGN.md §118）

- **公共知识库（`CB-097a`）**：共享笔记对全员可见、仅管理员可编辑。
- **全局共享技能（`CB-097b`）**：管理员可新建、导入、编辑与删除全局技能，普通成员以只读共享技能看到。
- **MCP 全员自动授权（`CB-097c`）**：`PUT /api/plugins/servers/:id/auto-grant` 开启后，该 MCP 服务器的全部工具对所有机器人生效，无需逐个授权。

### 测试与质量

- `app/src/lib/activity.test.ts` 注册的 happy-dom 现在在文件结束时注销，避免其全局 `Request` 丢弃 `Origin` 头导致同进程后续 `deploy/public/auth/accounts.test.ts` 登录全部 403；`accounts.test.ts` 增加对应自检。
- 插件写操作回归名单补上 `setServerAutoGrantAllMutationOptions`（拒绝时刷新与 id 编码两项）。

## 0.1.73 — 2026-10-25

这一版完成 Hark 网页版与 Grok Bot 桌面端实测对标全量落地（`CB-089`–`CB-095`）：新增聊天内 Word（`.docx`）文件在线预览、对话选项卡片点选即锁定（防止重复发送且跨刷新/设备还原）、主机器人防误删拦截与一键更换、机器人资料页「文件与页面」归集、单聊机器人往来锚点卡（`BotExchangeCard`）、右栏头部「＋」快速新建面板与预设轮换，以及「设置 → 账号连接」四分类标签页（`全部 / 连接 / 登录信息 / 密钥`）。

### Word 在线预览、互斥选项卡片、主机器人防误删、资料页归集与连接中心升级

- **Word（`.docx`）文件在线预览（`CB-089`，DESIGN.md §111）**：同源 `.docx` 文件卡新增「预览」按钮与点击文件名弹窗预览；在首次点开时动态按需加载 `docx-preview@0.4.1`（不进首屏包，服务端不装 LibreOffice），超过 10 MB 或解析失败时温和回退为「无法预览，请点右上角下载查看」，纸张白底黑字且外链强制新标签页打开。
- **对话里的选项卡片选完就定（`CB-090`，DESIGN.md §112）**：`render_ui`（`json-render`）的 `Button` 新增 `choice: true` 属性；同一张卡片内带 `choice: true` + `ask` 的按钮共享 `ChoiceProvider` 作用域，用户点击任一选项后立即发送一次并将该按钮标为已选（`✓`、`data-choice="picked"`）、其余候选按钮禁用置灰（`data-choice="locked"`）；刷新或换设备时通过 `replyAfterToolCall` 检查该工具调用之后的首条用户消息自动恢复已选态。
- **主机器人防误删与更换主机器人（`CB-091`，DESIGN.md §8）**：主机器人在左栏菜单（展开态 `BotRow` 与收起态 `MiniBot`）中隐藏「删除机器人…」并改为「更换主机器人…」（`MainBotPickerDialog`）；从详情页等任意入口触发删除主机器人时，`DeleteBotDialog` 先拦截并提供「更换主机器人… / 取消主机器人」，卸任后才允许进入删除确认。
- **机器人资料页「文件与页面」分区（`CB-092`，DESIGN.md §113）**：`/bots/:id` 新增 `BotFilesAndPagesSection`，将该机器人的聊天文件（支持 `?before=` 游标分页加载更多）与单页网页按「今天 / 本周 / 更早」分组展示，空态整块隐藏（§47），点击直接复用图片灯箱、PDF、`.docx` 预览弹窗或进入页面详情。
- **机器人之间的往来锚点卡（`CB-093`，DESIGN.md §116）**：单聊中调用 `message_bot` 询问其他机器人时，主对话流渲染可展开的 `BotExchangeCard` 往来锚点卡（显示目标机器人、委派任务、约束、期望输出、状态徽标与对话跳转链接；达深度上限或目标机器人已删除时如实标注「已达上限 / 对方已删除」）。
- **右栏头部「＋」新建面板与预设轮换（`CB-094`，DESIGN.md §114）**：右栏「面板」标签头部新增常驻「＋」下拉菜单（`RailAddPanelMenu`，宽屏与窄屏抽屉通用），内置 9 个精选预设并支持点「换一批」轮换，点选后填入聊天输入框（`chisabot-prefill`）不自动发送。
- **账号连接页四分类标签与保险箱内嵌（`CB-095`，DESIGN.md §115）**：`/settings/connected-accounts` 顶部新增 `全部 | 连接 | 登录信息 | 密钥` 分段切换（同步 `?tab=` 参数），内嵌 `VaultSection` 保险箱管理并明确标注「服务器加密保存，机器人看不到明文」。

## 0.1.68 — 2026-10-24

这一版默认开放「设置 → 插件与 MCP」连接器管理，并借鉴 Muse / OpenGrokBot / Composio 等开源智能体项目将聊天内连接器体验升级为主动式（全景发现、自动开启与自授权、对话内直连个人邮箱/日历、随回复附带一键连接卡片）。PC 客户端与服务端同步更新至 0.1.68（Android `versionCode` 265）。

### 默认开放插件与 MCP 及主动式连接器体验升级

- **默认开放「插件与 MCP」并升级「账号连接」页面**：移除 `/admin/plugins` 路由簇的 `requireExtra("plugins")` 隐藏门控，在设置左栏「账号与连接」分组下默认展示「插件与 MCP」；`设置 → 账号连接` 页面新增「外部服务与 MCP 连接器」区块，直接展示可一键开启的官方连接器（Notion、Google Drive、Parallel Search）与插件管理入口，不再显示死胡同式的「现在没有别的应用可连」。
- **四层连接器全景盘点（`connect_service` 支持 `service="全部"`）**：当用户询问「你现在有什么连接器」「能连什么」时，`connect_service` 自动汇总内置直连数据源（Gmail / QQ / 163 / Outlook 邮箱 IMAP、Google / iCloud / 飞书日历 iCal/ICS、GitHub）、已启用的 MCP 连接器、官方内置目录与 Composio 状态，无需盲猜或误报「没有连接器清单工具」。
- **内置 Gmail / 邮箱与日历对话内主动直连（`email_connect` / `calendar_connect`）**：`connect_service` 直接识别 Gmail / QQ 邮箱 / 163 / Outlook 与 Google / 飞书 / iCloud 日历等内置个人数据源；`personal-sources` 新增 `email_connect`（自动按邮箱域名推断 `imap.gmail.com` 等服务器地址）与 `calendar_connect` 工具，支持用户在对话里直接发日历订阅链接或邮箱授权码由机器人当场连上，同时附带 `[打开账号连接](/settings/connected-accounts)` 链接卡。
- **官方目录连接器主动开启与工具自授权（`canAutoEnable`）**：管理员在对话中询问或要求开启 Notion、Google Drive 等官方目录连接器时，`connect_service` 主动调用 `store.addServer` 启用该连接器（Notion 自动完成 RFC 7591 动态 OAuth 客户端注册）并自动调用 `store.grant` 将非破坏性工具授权给当前机器人，随后返回 `[去连接 Notion 账号](/settings/connected-accounts/notion)` 卡片供用户一键完成授权。

## 0.1.67 — 2026-10-24

这一版修复了从聊天页进入「设置 / 管理后台」后点击左栏底部「返回聊天」无法切回聊天界面的问题。PC 客户端与服务端同步更新至 0.1.67（Android `versionCode` 264）。

### 设置与管理后台「返回聊天」导航修复

- **仅记录聊天会话路径（`/channel/...` 与 `/group/...`）**：在 `left-mode.ts` 中新增 `isBotsChatPath(pathname)` 并在 `rememberBotsLocation()` 中过滤非聊天路径，防止从 `/_authed/_app` 跳转到 `/settings` 或 `/admin` 的过渡帧中把 `/settings` 误记为最近一次机器人会话，导致设置左栏底部「返回聊天」按钮指向 `/settings` 自身而无法返回聊天。
- **使用已解析路由位置记录会话记忆**：`_authed/_app.tsx` 改为读取 `s.resolvedLocation ?? s.location`，避免在异步 `beforeLoad` 挂起阶段把目标设置路由写入会话位置记忆。

## 0.1.66 — 2026-10-24

这一版修复了当后台工具调用（如 `panel_refresh` 刷新实时看板、`web_fetch` 抓取网页或远程命令执行）耗时超过 12 秒时被客户端首段发送看门狗误调 `stopAgent()` 强行掐断并报 `这一轮出错了：This run was stopped.` 的问题，同时清除了已折叠步骤行残留的子元素外边距留白。PC 客户端与服务端同步更新至 0.1.66（Android `versionCode` 263）。

### 后台长耗时工具看门狗误停与折叠行留白修复

- **修复 12 秒首段看门狗提前调用 `stopAgent()` 掐断运行中工具的问题**：`channel-chat.tsx` 的 `deliver()` 在 `SEND_WATCHDOG_MS`（12 秒）超时分支中，先通过 `runEventSeenRef` 与 `readThreadMessages` 判断当前回合是否已到达服务器（`persisted`）；仅当消息确实未送达服务器（`first.kind === "hang"`）时才调用 `旧聊天前端框架.stopAgent()`，而已在服务端开始执行的回合无缝进入 180 秒 `SEND_REPLY_WATCHDOG_MS` 等待窗口，不再误杀耗时 12 秒以上的 `panel_refresh` 等后台工具调用。
- **运行取消事件（`HERMES_RUN_CANCELLED`）语义对齐与中文提示**：`onRunErrorEvent` 与 `stoppedTurnSubscriber` 识别 `HERMES_RUN_CANCELLED` / `This run was stopped.`，避免在已停止回合下方重复弹出英文错误卡片；`friendlyStopReason` 与 `isAbortFailure` 将 `This run was stopped` 纳入中断语义并转为中文说明。
- **消除已折叠步骤行（`data-folded`）残留外边距留白**：为 `[data-slot="message-scroller-item"][data-folded] > *` 补充 `margin: 0 !important; overflow: hidden;`，消除折叠后的干活卡（`.chat-work:not(:first-child)` 的 `margin-top: 10px`）在消息之间留下的额外纵向空隙。

## 0.1.65 — 2026-10-24

这一版彻底消除了发送消息时对话列表往上「翻页跳动 2/3 屏 + 底部垫出一大块空白」以及按下回车到消息上屏之间的两段式跳动问题，使发送消息、等待响应与流式输出全程自然贴底、零跳动。PC 客户端与服务端同步更新至 0.1.65（Android `versionCode` 262）。

### 发送消息零跳动与同步贴底优化

- **取消发送消息时的 2/3 屏翻页跳动与人工留白**：`useFreshAnchor` 对新发出的用户消息统一采用连续贴底模式（`continuous = true`，不再挂载 `data-scroll-anchor="true"`），彻底消除在已停止回合或间隔较久后发消息时把用户消息强行推到视口上 1/3、底部垫出 2/3 屏空白并在回答结束时再次回落跳动的问题。
- **同步插入乐观用户消息（消除 200ms 两段跳）**：`channel-chat.tsx` 的 `deliver()` 在已就绪且已接入的会话中跳过已完成的 `joinGatePromise` 微任务，并将 `target.addMessage(...)` 提前到 `await panelAuthoringForwardedProps(...)` 网络请求之前同步执行，使「清空输入框 + 标记运行中 + 用户消息与思考指示器上屏」合并在同一次 React 渲染提交中完成，并把 `waitingOnFirstToken` 收紧为仅在 `live` 成立时显示。
- **同步瞬时跟底与上一轮布局锁定**：移除 `useSmoothSendScroll` 在发送后对视口设置的 700ms `scroll-behavior: smooth`，避免流式增长期间异步平滑滚动滞后于 `scrollHeight` 导致 `seen.atBottom` 翻转与双滚动控制器互抢；`SettleAtEnd` 的 `pinNow` 在贴底且内容增长时在绘制前同步执行 `stickToBottom()`；`compactTurns` 排除已停止回合触发 `prevInterjected` 并禁止跨轮次追溯修改上一轮回复的 `replyTo` 引用头。

## 0.1.64 — 2026-10-24

这一版彻底消除了切换页面、切换机器人与发送消息时的对话列表闪烁、全量重绘和高度跳动问题，使会话切换与流式收发全面丝滑化。PC 客户端与服务端同步更新至 0.1.64（Android `versionCode` 261）。

### 对话列表零闪烁切换与丝滑收发优化

- **历史消息首帧实心直绘（消除切换闪烁）**：重构 `createFirstPaintDelays()`、`Arriving` 与 `BotBubbles` 的入场动画条件，打开或切换到已有历史消息的会话时统一以 `initial={false}` 在首帧直接实心渲染，不再重播 `opacity: 0` 与多段 `BEAT_SECONDS` 阶梯淡入；仅当会话稳定后实时新到达的消息才播放轻量入场过渡。
- **分段渐进挂载（Tail-First Mount）视口锁定**：修复 `useTailFirstMount` 在 `atBottomRef.current === true` 时向上分批补齐更早历史消息未同步补偿 `scrollTop` 的问题，在浏览器绘制前（`useLayoutEffect`）同步锁死视口位置。
- **跨页返回一步直达与全局事件流常驻**：将 `useChannelEvents()` 提升至顶层 `ShellFrame` 常驻（按 `QueryClient` 去重），进出「设置 / 管理后台」不再断开重连 `/api/channels/events` 或触发全列表 `invalidateQueries`；设置页「返回聊天」直接走 `modeTarget("bots")` 一步回到原会话路径，消除 `/` 中转空白帧；`usePanelBot()` 增加名册缓存与 `threadUi` 同步兜底，消除右栏延迟 50ms 显隐引起的宽度跳动。
- **流式输出 `React.memo` 隔离与底部零弹跳**：将 `replyTo` 拆为基础类型属性 `replyToId` / `replyToText` 并为 `TranscriptMessage` 提供值级比较函数 `sameTranscriptMessage`，彻底解决流式输出每个 token 到来时历史消息与富媒体卡片全量重绘的问题；将 `liveWorking` 与 `pausedAfterText` 收紧为仅在 `live` 阶段生效，消除点击发送瞬间 `<PauseDots />` 挂载又卸载造成的底部上下弹跳；本地流结束增加 3 秒保护期，防止被在途 `/sync` 轮询误触发 `liveTail` 清空重放。

## 0.1.63 — 2026-10-24

这一版修复了聊天流选中文本弹出底部横条、复制时将聊天记录向上顶起、以及云服务器性能监控看板因 `CHISABOT_PANEL_COMMANDS` 未默认开启导致创建失败的问题，并对齐了引用栏与链接卡片追问按钮样式。PC 客户端与服务端同步更新至 0.1.63（Android `versionCode` 260）。

### 聊天复制零位移与实时看板直连命令源修复

- **移除选中文本浮动条（修复弹窗与复制顶起聊天记录）**：移除挂载在 `MessageScroller` 底部、监听 `mouseup`/`keyup` 的 `SelectionQuoteToolbar`，解决划选文字或按 `Ctrl+C` 复制时在输入框上方插入整行按钮并压缩消息视口、把聊天记录向上顶起的问题；保留消息操作栏「引用」与卡片级「追问」按钮。
- **实时看板本机命令数据源默认向管理员开启与平滑降级**：`live-panels` 服务默认开启 `CHISABOT_PANEL_COMMANDS=1`（除非显式设为 `0`），使管理员创建云服务器 CPU / 内存 / 磁盘监控面板时可直接挂载 `command` 直连数据源；非管理员或禁用环境下自动剥离 `command` 源并引导写入字面值，不再因报错触发 `panel_fail`。
- **快捷键冲突与引用栏样式修复**：`QuickSpotlight` 仅绑定 `Alt+Space`（释放 `Ctrl+K` 归还左侧栏会话搜索），并通过 `chisabot-prefill` 直接向 `PromptArea` 填入指令；补齐输入框引用栏弯折图标与链接卡悬停「追问」胶囊样式。

## 0.1.62 — 2026-10-23

这一版全面升级 Hark 式卡片与个人助理体验：新增气泡外 `╭─` 双向回复引用胶囊、多卡片扇形牌组与悬停聚焦虚化、划词与卡片级一键追问、内联 Mermaid / SVG / HTML 交互预览卡、每日晨报卡片（Morning Brief，`CB-014`）、日历（ICS）与邮箱（IMAP）只读接入（`CB-013`）、PC 全局快捷键 `Alt+Space` 随手问浮窗、浏览器原生语音速记、记忆写入微胶囊提示（`✨ 已记住`）与一键撤销，以及右侧看板独立刷新小模型配置（`CB-088`）。PC 客户端与服务端同步更新至 0.1.62（Android `versionCode` 259）。

### Hark 式对话、每日晨报与个人助理全功能升级

- **Hark 式外部引用胶囊与双向追问**：回复引用采用气泡外 `╭─` 弯折引导线 + 紧凑胶囊样式，点击可双向平滑滚回原消息并高亮闪烁；聊天流或文档弹窗内划选文字即浮现「💬 引用追问」，所有文档卡、草稿卡、Mermaid/HTML 渲染卡、晨报卡、链接卡、文件卡均支持一键「追问」带入输入框引用栏。
- **多卡片扇形叠放与独立弹窗阅读器**：多张链接卡与图片牌组采用微倾角扇形叠放，鼠标悬停时当前卡片优先置顶放大、其余卡片柔和虚化；文档卡、Markdown/文本文件卡与图片灯箱均支持居中弹窗精读与一键下载。
- **内联 Mermaid / SVG / HTML 交互预览卡**：支持 `flowchart`、`sequenceDiagram`、`stateDiagram`、`pie` 零依赖矢量渲染与受控 HTML 沙箱预览，卡片顶部支持「预览 / 源码」一键切换与放大查看。
- **日历与邮箱只读接入（`CB-013`）+ 每日晨报卡片（`CB-014`）**：「偏好设置 → 账号连接」新增个人 ICS/WebCal 日历与 IMAP 收件箱只读连接（AES-256-GCM 加密存储），向机器人提供 `calendar_list_events`、`email_list_recent`、`morning_brief_generate` 工具，输出 2×2 杂志式「每日晨报卡片」。
- **全局 `Alt+Space` 随手问浮窗、语音速记、记忆微胶囊与看板独立小模型（`CB-088`）**：支持 `Alt+Space`（含 PC 客户端系统级全局快捷键）呼出随手问浮窗；未配服务端 Whisper 时自动启用浏览器 Web Speech API 语音听写；机器人写入长期记忆时在气泡下方显示 `✨ 已记住` 微胶囊并支持一键撤销；右侧看板每张卡片支持在 `⋯` 菜单单独指定后台刷新小模型。

## 0.1.61 — 2026-10-23

这一版升级云端 Claude Code 的「双端持久工作区 + 后台增量同步 + 云端 AI 任务隔离」体验：发消息前先对齐电脑最新改动、多轮会话工作树增量吸收本地修改、合入工作目录升级为三方合并（3-way merge），并解除新建导入阻塞与离线合入阻塞。PC 客户端与服务端同步更新至 0.1.61（Android `versionCode` 258）。

### 云端 Claude Code 双端持久工作区与三方合并

- **发消息前轻量增量对齐（`flushBeforeTurn`）**：工作区处于 `pc_active` 或 `syncing` 且绑定电脑在线时，启动新一轮云端对话前先下发 `sync_flush` 触发轻量 Mutagen `flush` + `gitSync`（最多等 8 秒，电脑离线或超时自动降级不阻塞），避免本地刚保存文件就发消息时 Claude 拿到旧代码。
- **多轮会话工作树增量同步（`refreshTreeFromWork`）**：已有会话在后续轮次启动前自动将主工作目录 `work/` 的新改动通过三方合并同步进 `trees/<session>`，并推进会话基线；与 Claude 未合入改动同位置冲突的文件自动跳过（不写入冲突标记污染工作树），在对话流发出 `notice` 提示。
- **三方合并合入与冲突解决闭环（`applyPatchThreeWay` + `settleResolvedConflicts`）**：「合入工作目录」升级为基于完整 blob 索引与临时 index 的 `git apply --cached --3way`，本地与 Claude 改同一文件的不同行可自动合并；同位置真冲突时支持点「让 Claude 处理」读取 `../../work/` 合并双方改动，合并后自动推进冲突文件基线。
- **解除入口阻塞与离线合入阻塞**：新建「电脑上的文件夹」或重新开启同步时，只要控制面绑定与 Mutagen 会话已建立，首次全量 `flush` 超时不再误调 `/abandon` 删库，而是保留 `syncing` 状态转入后台续传；后台轮询检测到首次同步完成或本机 `.git/HEAD` 变动时自动对齐 Git 历史；电脑合盖离线时在云端点击合入会自动将同步置为 `paused`、收回云端租约并立即完成合入。
- **Windows 私钥权限修复**：生成或读取同步 SSH 私钥时自动通过 `icacls` 收紧为当前用户只读，修复临时目录或自定义数据目录继承多用户权限导致 OpenSSH 拒绝加载密钥的问题。

## 0.1.60 — 2026-10-22

这一版是服务端 / 网页发版：机器人浏览器的多标签修「新建一个标签，那个标签点不进去」（§95）。`pc/` / `android/` 没有代码改动，客户端版本号对齐到 0.1.60（Android `versionCode` 257）。

### 新开的标签真的切过去（§95）

- **新标签会带到前台**：`profiles.openTab()` 以前只把新页 pin 成当前标签，没有像 `activateTab()` 那样 `bringToFront()`。Chromium 的 screencast 只合成真的在显示的那一页，于是标签栏已经高亮新标签、直播画面却还停在上一页——新标签在前台之前一帧都不会有（2026-10-22 反馈）。
- **点已经高亮的标签也重新激活**：标签栏里点「当前那一个」以前一个请求都不发（`if (!active)` 直接 return），而新开的标签在服务端一出生就是当前标签，正好落在这一支，所以点了毫无反应。现在接管状态下再点会重新 `activate` 一次（幂等，计算机会顺手 kick 转播，卡住的画面跟回来）；只看着时仍然不抢控制，切别的标签也照旧先接管。
- **验证**：`app/tests/browser-tabs.test.tsx` 新增两条（已高亮标签重按发 `activate`；只看着时点当前标签不接管），11 项通过；`旧前缀环境变量=1 bun test agent-computer/tests/tabs.test.ts` 在真 Chromium 里开三个标签、切换、关闭、上限、重启恢复全过。

## 0.1.59 — 2026-10-22

这一版把机器人的待回答问题放到对话里直接处理（§110），并对齐 Claude Code 左栏与机器人侧的外壳位置（§73.2）。`pc/` / `android/` 没有代码改动，客户端三处版本号对齐到 0.1.59（Android `versionCode` 256）。

### 对话里直接回答或关掉机器人的问题（§110）

- **点进对话就能答**：`questions.list()` 随问题返回 `channelId`，`PendingQuestion` 在提问所在的对话里、输入框正上方画出回答卡片，与「待处理」走同一个 `/api/approvals/questions/:id/respond` 接口；别的对话不会混入。
- **答不了的问题可以关掉**：新增 `POST /api/approvals/questions/:id/dismiss`（不写回答、不恢复回合，已答过则幂等 no-op）；「待处理」与对话内卡片都提供「不用回答了」，那段对话已经不存在时也能把侧栏挂着的数字清掉。
- **侧栏计数当场刷新**：回答或关闭后同时作废 `["approvals"]` 与 `["bot-lifecycle"]`，不用再等 15 秒轮询。

### 左栏外壳对齐（§73.2）

- Claude Code 左栏复用 `side-search-row`（搜索框 + 右侧「＋」新建工作区），账号卡放到面板外，与机器人侧共享同一套位置与尺寸，切换时不再跳动。

### 验证

- 新增 `app/tests/channel-question.test.tsx`，`server/tests/approvals-question-resume.integration.test.ts` 补齐 `channelId` 与 `dismiss` 用例。

## 0.1.58 — 2026-10-22

这一版是服务器 / 网页发版：切机器人、从设置回到对话不再「像刚发了一次消息」，发消息时的跳跃和输入框的闪烁一起收掉。`pc/` / `android/` 没有代码改动，也没有客户端发版和标签（同 0.1.4 的处理）。

### 打开对话不再像发了一次消息（§83 / §88.1 / §94）

- **恢复出来的历史不是「刚发出去的那一句」**：打开对话时历史是异步到的，`hydrating` 又在**同一次提交里**和恢复好的消息一起变成 false，旧逻辑只在 `hydrating` 期间记基线——于是恢复那一刻出现的最新一条用户消息被判成「人刚发的」，带上 `data-scroll-anchor`，滚动容器把它翻到视口上 1/3、下面垫 2/3 屏空白。现在「打开这段对话」是 `hydrating` 加上恢复完成后的 2.5 秒（`useOpeningWindow`），窗口里到的内容一律按历史补齐处理；窗口过后的真发送照旧翻页。这条还顺手修掉一个连带问题：以前那一下会把历史消息记成本机发出的时刻，之后 30 分钟的发送都不再翻页。
- **接入（connect 回放）不是一轮回答**：`旧聊天运行时包` 的 connect 从开始到回放结束都把 `agent.isRunning` 设成 true。以前它直接喂给 `busy` / `pending` / `stoppable`：每次切换机器人，发送键先变成「停止机器人」、对话末尾挂一行「思考中」，回放完再收回去——那个「停止」按下去撤掉的是回放本身。现在分开成 `agentLive`（发出去还是排队、能不能重新生成）和 `chatBusy`（画给人看的「机器人在回答」，接入期间不算），6 秒兜底。
- **不拽往上翻着读的人**：排队补话那一下只在人本来就在底部时才跟到底；打开长对话时第一批补进来的历史不再先钉一下底部、再被 §88.3 的「回到上次那一条」拽回去。
- **换一段对话就是换一页**：`ChannelPage` 按 channelId 分开，历史对话弹窗、计算机自动切标签不再跟到别的机器人身上。

### 输入框不再动不动塌成一行

- 编辑框高度只跟内容走。prompt-area 在失焦 150ms 后会把高度钉回一行、`overflow: hidden`，上一版又把它的高度过渡关掉了——点一下模型药丸 / 权限 / 消息区，写好的几行字当场被裁掉，点回来又弹开。超过组件给的 `maxHeight` 照旧在框里滚。
- 发送之后光标当场回输入框，不用等整轮回答结束（那笔「欠一次光标」照旧留给失败重来）。
- 聚焦时的底色改成同一支渐变：以前是渐变 ↔ 纯色，浏览器插不了值，0.2s 的过渡只能瞬间跳。

### 验证

- 新增 `app/tests/chat-restore-anchor.test.tsx`（恢复不带对齐标记；窗口过后的真发送照旧带）。
- `message-scroll-reduced-motion.test.tsx` 进独立进程名单：Motion 在第一次 import 时就把 `prefers-reduced-motion` 记死了，跟着整套跑必红。
- `bun scripts/run-app-tests.ts` 1425 项 + 10 个独立进程文件全绿；顺手修掉两个既有红灯（`panel-board.test.tsx` 注册 happy-dom 没注销、执行内核徽章没包 `<T>`）。

## 0.1.57 — 2026-10-22

这一版是服务器 / 网页发版：右栏自定义面板能自己看数了——面板可以挂直连数据源（https / 本机命令），宿主按秒级取数，不再每小时花 token 让模型重算一遍；卡片能两两并排、拖比例、拖高、折叠。`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

### 右栏面板：直连数据源、看板、卡片菜单（§109，参考 dsh-pad）

- **直连数据源**（最多 3 个）：http（只允许 https、拦内网、不跟重定向）或本机命令；宿主按每个源的间隔（2–3600 秒）自己取数，值回填到规范的 `live` state（`{"$state": "/live/<id>"}` 或 `/live/<id>/字段`），不花 token。只有浏览器在看的时候才取，同一源同时只跑一次、最多 3 个并发；取数失败不覆盖上一次的好值，只在来源那行标红写原因。
- **密钥与命令源**：`{{secret:名字}}` 走保险箱，只发往密钥绑定的域名、DNS 钉死、正文抹掉密钥值，明文密钥在保存前就被拒；命令源是这台机器上的 shell，默认关闭（`CHISABOT_PANEL_COMMANDS=1` 且管理员），5 秒超时、输出 64 KB、剥 ANSI。迁移 0059（`data_sources` / `source_state`）。
- **看板**：右栏 ≥480px 时两两并排（最小 200px）、分隔条拖比例、握把换行换位、单卡拖高（内部滚动）、点标题折叠；窄窗口抽屉里始终单列。布局按机器人记在本机，拖动期只写 DOM、松手才落盘；分隔条 / 握把可 Tab、方向键调整。
- **⋯ 菜单**：「让 AI 修改…」把「帮我改一下右栏这张「标题」面板：」**追加**到输入框（不自动发送）；「数据来源…」列出每个来源的名字、网址 / 命令、间隔、最近一次结果，底部「立即取数」；撤销也把数据源一起还原。
- 没做：面板级模型（`TurnRunner` 目前没有模型入参），记进 BACKLOG CB-088。

## 0.1.56 — 2026-10-22

这一版是服务器 / 网页发版：网页顶部「有新版本，点此刷新」点下去，输入框明明空着也会弹「输入框里还有没发送的内容」。现在这道确认只拦真会丢 / 会打断的事——机器人还在回复、没发出去的附件、编辑中的消息与还没提交的审批回答。`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

### 在线更新：刷新前的确认只拦真会丢的东西

- **不再扫整页输入框**：以前把机器人画的卡片表单（常带预填值）、右栏面板、搜索框、关掉的弹窗都当成聊天草稿；现在只认编辑中的消息和还没提交的审批回答（标了 `data-unsent-watch` 的输入），隐藏的不算。
- **聊天草稿不再拦人**：输入框里的字记在 localStorage（§88），刷新回来还在，不再为它弹确认。
- **附件单独提醒**：输入框上还挂着的附件（上传中的也算）、离开对话时收起来的那几个，刷新都会没（File 只在内存里），确认框写明有 N 个附件要重新选；回复还在跑时也照样写清它会在后台继续。
- **一句话说全**：确认框把会丢 / 会打断的几件事一起写清，标题按最要紧的一条来（回复中 → 附件 → 其它没发出去的内容）。

## 0.1.55 — 2026-10-22

这一版是服务器 / 网页发版：设置 → 云端工作区点「退出」看起来没生效——按钮停在「退出中…」，回来之后账号还是「已登录」。现在退出以节点上的真实登录状态为准，CLI 没退掉就直接清凭据再确认，并发的自动检查也不会再把刚退掉的账号改回「已登录」。`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

### 云端 Claude Code：退出 Claude 真的退出

- **以 `auth status` 为准**：`claude auth logout` 之后必须再问一次 `auth status`；CLI 没退掉（旧版没有这个子命令、网络卡住被超时结束、凭据没删掉）就删掉它自己报告的 `configDirectory` 里的 `.credentials.json`，再确认一次，还登着才报错——不再把没退掉的 CLI 当成功，下一次检查又变回「已登录」。
- **并发检查不再把它改回去**：服务器给每个节点的登录状态加了代次，退出发出之前的那次 `status` 结果回来时不写缓存；退出进行中的自动复查直接回缓存；网页上的自动复查也不会覆盖刚刷新出来的「已退出」。
- **失败看得见**：退出最长等 34 秒（健康时 2–4 秒），失败显示在账号卡底部红字「没有退出：…」并且按钮走失败态；操作记录新增「退出 Claude 没有成功」。

## 0.1.54 — 2026-10-22

这一版有两件事：机器人执行内核换成 **Hermes 运行时**（执行循环、工具路由与审批都交给它），以及把机器人电脑 / 浏览器这一路积累的坑修掉——多个窗口可以同时看同一块屏幕、屏幕不再互相顶掉、停止时不再假装在重连。`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

### 机器人电脑 / 浏览器（用户可见）

- **多个窗口同时看同一块屏幕**：以前第二个 `/stream` 会顶掉第一个，被顶掉的窗口显示「这块屏幕现在在另一个窗口看着，这边停下了」并停下（PC 客户端 + 网页、两个标签页都会触发）。现在一个机器人只保留一份 screencast、广播给所有窗口；新窗口加入时补发最近一帧（静止页面也不会黑屏）；最后一个窗口关掉才停播。输入仍然只由控制权决定，第二个窗口默认只读。
- **屏幕真的结束时不再假装重连**：电脑停止 / 重置 / 浏览器关闭时只显示原因 +「重试」，不再叠一层假的「正在重新连接…」。
- **部署重启后自己回来**：断线重连预算从 15 秒延长到约 90 秒（8 秒封顶），容器替换期间不会留下一个「连接已断开」。
- **第二个窗口自动挂上直播**：以前它的卡片截图被直播拒绝（`liveCast`）就永远不挂 LiveScreen，只显示「暂时看不到屏幕」；现在大屏展开直接用直播。
- **启动中关窗不会再拉起电脑**：最后一个观看者在浏览器启动期间离开时，follow / keepalive 直接拒绝注册（以前会每秒拉一次页面，等于重新拉起电脑）。
- **右栏不再把「大屏正在直播」当成故障**：以前显示 ⚠️「暂时看不到屏幕」+ 重试，其实电脑好好的；现在是中性的「大屏正在直播」，没有警告和重试。收起大屏后 1–2 秒接回画面（以前最多 10–12 秒）。
- **大屏关闭按钮**挪到卡片外、遮罩右上角（和 Esc 一样；接管时 = 交还并关闭），不再和地址栏星标叠在一列。
- **点标签自动接管**：只看着时点标签、`+`、收藏会先接管控制，而不是什么都不发生。
- **接管空闲自动交还**：人接管后超过一小时没有操作，自动交还给机器人。

### 内核：Hermes 运行时

- 所有内置机器人改走 Hermes / ACP 内核：执行循环、工具路由与审批由 Hermes 负责；先查再接；管理页显示内核与健康信息（信息性，不影响就绪判断）。
- 补上「先查再拒」、中文输入法首字被吞 / 输入框跳动等回归。

### 其它

- 审计表改成固定列宽，笔记本宽度下也能读。
- 触屏上 CC 工作区行的「＋ / ⋯」做到 44px 点按区。

### 客户端

- 版本号对齐 **0.1.54**（Android `versionCode` 252）；`pc/` / `android/` 没有代码改动，客户端只对齐版本号，原地更新。

## 0.1.53 — 2026-10-21

这一版是网页 / 服务器发版，最重要的一条是聊天输入框里的中文 / 日文输入法：合成期间不再把受控值写回编辑器，首个字符不会被吞掉；输入法确认候选字的 Enter 不再把半句话发出去；打字时输入框也不再上跳。`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

### 输入法（聊天输入框）

- **首字不再被吞**：合成期间 `onChange` 只记进 `pendingChangeRef`，`compositionend` 时一次提交；受控 `value` 不再在合成中写回 contenteditable，撤销正在进行合成的原因就没有了。
- **被打断也能接着打字**：切窗口 / 点走时有些输入法不送 `compositionend`。现在失焦按屏幕上已显示的文字提交并复位，输入框不会从此吞掉后面每次按键。
- **打字不再跳**：去掉编辑器的 `height 150ms` 过渡，`autoGrow` 的测量当帧生效。
- **`prompt-area` 0.6.8**：输入法确认候选字的 Enter 不再发送消息；旧 IME 上报的 `keyCode 229` 也按合成处理；一次合成只占一步撤销。锁文件原先停在 0.6.7。
- **验证**：新增 `app/tests/composer-composition.test.tsx` 两条（合成期间不可发送 / 打断后仍能输入），实现分别拿掉时两条会各自失败；composer 相关 110 项通过。

### 聊天可靠性与办公（CB-087 等）

- 聊天可靠性（CB-087）：保留追加、停止与失败标记下的消息节点，慢帧收回留白不再跳动；停止/失败后的补话跨刷新和重启保持暂停，提供单条主动发送与撤回。
- API 查询默认期限与调用方取消同时生效，长命令独立预算；收件箱解析失败保留队列，长历史轮询不再读取完整记录。数据库查询、锁与池等待有界，故障连接回收后新请求恢复，未确认写入不重放。
- Python 下载文件指导补齐 CLI 与子进程编码，相关请求、节点身份、持久队列和数据库故障回归纳入 CI。
- 连续办公补修：镜像内置 openpyxl / python-docx，避免缺库时手工拼文档；要求从重开的实际数据复核总和及依赖文档，并对可下载 CLI 的中文 stdout/stderr 做非 UTF-8 子进程实测。
- CB-087 发布验收完成：七项严格滚动与两项减少动态效果回归通过，正式模型单条发送、Stop、35 秒命令和独立 Office/Windows 编码验证通过；原始失败、Word 一次反馈修正与模型内容核验边界记录在 `docs/pipeline-runs/20261021-comprehensive-reliability.md`。

### 客户端

- 版本号对齐 0.1.53（Android `versionCode` 251）；无 `pc/` / `android/` 代码改动，外壳指纹仍是 `059438f4e6c98c74`，原地更新。

## 0.1.52 — 2026-10-21

这一版是服务器 / 网页发版：带路由前缀的模型 id 以前被判成「走 chat completions」，网关把 function tools 全丢掉，机器人于是只会道歉、不会动手——现在它们走 Responses API、先动手再回话；另外执行控制收口（用户按下停止之后，延迟子进程不再继续写文件）。`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

### 模型：带前缀的 id 也走 Responses API

- **`requiresResponsesApi` 只看最后一段**：网关的 id 是「路由/模型」（这个部署跑的是 `codex/gpt-6-luna`），旧实现拿整串匹配 → 判 false → 模型被推去 chat completions → 网关丢掉 function tools → 机器人对每个「你去办一下」都回一句道歉，而不是发工具调用。
- **有工具时追加 `ACTION_GUIDANCE`**：先把事做了再回话，不许在调用工具之前声称没有权限。
- **验证**：`server/tests/model-providers.test.ts` + `shared/model-providers.test.ts` 46 项、`server/tests/copilot.test.ts` 72 项。

### 执行控制（CB-086）

- 连续对话执行控制：前端工具结果返回前，补话继续排队，接力期间保持忙碌状态；完整回合结束后才兜底补送，失败或停止时保留队列。修复补话导致同一命令以不同调用 ID 再执行的问题。
- Web 停止按钮的取消信号贯通计算机审批入口、执行器与 shell 进程组；取消响应流也会终止当次未完成命令，避免页面已停止但延迟子进程继续写文件。
- 增加真实 SDK、独立 PostgreSQL、Linux 实际进程及 Web 副作用回归，并保护清锁期间 Stop 与失败结果写入的竞态。增量镜像同时更新计算机服务源码。

### 计算机接管与好友包

- 接管大屏不再被 keepalive pong 报「unknown type」；friend-up 前端构建找根 `node_modules` 的 vite。
- `Dockerfile.zh` 也安装本仓库的 `agent-computer`（好友包接管屏不再跑底座旧计算机）。

### Claude Code 工作台与侧栏收尾

- 会话树 / 左栏 / 切换按钮的一轮整理（`cc-tree`、`left-rail`、`left-mode-switch`、`cc/index`）。
- 侧栏翻页里那条永远不跑的滚动加载分支删掉（会话列表只在搜索态渲染，它没有调用点）。

### 文档

- `docs/audit-2026-10-21.md`：48 条路由 + 6 条关键流程的实机审查记录、这一轮修掉的 12 个产品问题、测试基线 210 → 0 的过程与那条运行器限制。

## 0.1.51 — 2026-10-20

这一版是网页 / 服务器发版：发消息时的翻页规则只在「真的隔了很久、而且机器人没在回答」时才生效，翻页也落在视口上 1/3——不再把刚发的那条顶到最上面、下面留一整屏空白。`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

### 发消息不再整段翻页（30 分钟界限、回答中补话不翻、翻页落在上 1/3）

- **界限 5 → 30 分钟**（`CONTINUOUS_SEND_MS`）：一来一回聊着的时候跨过 5 分钟太容易。
- **回答还在跑时补的那一句算连续**（`staysInSameTurn`）：`busy` 在按下发送时就是 true，所以在提交那一刻记（`noteSendWhileBusy` / `takeSendWhileBusy`，只认 60 秒内），消息出现时取走。
- **翻页时落在视口上 1/3**：`scrollMargin = 视口高 / 3 − 48` 定目标，对齐之前先把自己的留白垫到「问题下面有 2/3 视口」（不垫的话目标比能滚到的更远、会被夹回底部），对齐那一下也不收留白、不贴底。实测（1280×800、视口 583）问题落在离顶 218px，流式长回答 5.5 秒全程 10 次采样不动；原来落在 72px、下面一整屏空白。
- **验证**：`app/tests/send-scroll.test.ts` 13 项；`tests/rail-drag-scroll` 三场景全过；预览 + 假模型：上一条 35 分钟前 → 有标记、落在 218px；连续两条隔 8 秒 / 刷新后 5 分钟内 → 无标记、离底 0。

## 0.1.50 — 2026-10-20

这一版是服务器 / 网页发版：Claude Code 工作台重做，连接 / 授权页最后几句英文收尾，首页在当前用户读失败时不再空白。`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

### Claude Code 工作台重做

- **左栏**：收成一块玻璃面板；工作区标题右侧放 `+` / `⋯`，不再在每个目录底部多一行「新会话」；会话行平常只有标题。
- **会话操作**：悬停露出置顶 / 归档；右键菜单支持重命名、置顶、删除。重命名是行内输入框（Enter 保存、Esc 取消）；置顶记在本机 `localStorage`，归档在服务端保留记录。
- **会话页**：56px 头部；输入框改成参考图的大白卡，底栏 `+` / 「按需批准」/ 模型药丸 / 努力圆钮 / 深色发送停止键；运行中且没输入时是停止方块。
- 全部新样式限定在 `.cc-*`，机器人侧不动。

### 连接页与首页

- 连接 / 授权页最后几句英文提示翻成中文（账号行、管理页、个人页）。
- 当前用户读取失败时首页不再一直停在 loading，而是正常走到错误 / 空状态。

### 测试

- CC 树 / 切换 / UI 对齐共 28 个相关测试通过；生产构建通过；桌面、暗色、手机、右键菜单、行内重命名均用 Playwright 实测。

## 0.1.49 — 2026-10-20

这一版是服务器 / 网页发版：拖右栏跟手、侧栏一致性、分段选择键盘、模型失效说清楚、干活卡收尾，以及长命令不再被 12 秒看门狗掐断。`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

### 拖右栏把手不再把对话记录推走（DESIGN.md §106）

- **问题**：拖右栏左边缘的把手改宽度，松手时整段对话被推到上面、底下一整屏空白（1280 宽实测：内容列 6362 → 7749px、留白 1388px、视口里一条消息都没有）；同一篇文档卡也会因为多折两行跨过 300px 门槛，当场收起 / 展开。
- **修**：`SettleAtEnd` 的「跟着变」留白改为按「换行」作废（记 `layoutWidth`，换行时收掉 floor 与留白、同一帧贴底、滚动事件里不再补）；文档卡只按文字量一次，宽度变化不再重算。覆盖拖右栏、左栏收起、窗口缩放、右栏收起 / 展开动画。
- **回归**：`tests/rail-drag-scroll`（`bottom` / `mid` / `collapse` 三个真浏览器场景）；`bun test app/tests` 失败集合与改动前一致。

- **侧栏一致性**：机器人列表去掉独立标题行，搜索框右侧保留新建按钮；窄窗口弹出面板与常驻面板共用卡片样式和记住的宽度。部署服务器网页后，PC 客户端刷新即可生效，无需重装。

### 拖右栏更跟手：拖动期只写 DOM，不再每帧重渲染整栏

- **改法**：`PanelRail` 的 `pointermove` 不再 `setWidth`，直接写栏 / 卡片两格 inline style；松手才 `setWidth` + 写 `localStorage` 与按机器人记的那份。React 按自己上一次渲染的值 diff inline style，拖动期 state 不变就不会覆盖回去。
- **实测**（真浏览器 1280×800、CPU 4×、40 次 pointermove 往返、两次取中位数）：script 922ms → 446ms（−52%），task 4138ms → 3563ms（−14%），layout / style 次数不变（122 / 167）——省掉的是 React 那一层，排版照做。
- **功能不变**：拖到 500 松手 → 500 / localStorage 500；双击 → 380；方向键 ±20；Ctrl+Alt+B 收起 0 / 展开 400；`tests/rail-drag-scroll` 三场景在改后构建上仍全过。

### 模型失效与干活卡收尾

- **模型下线**：列表里没有的模型，发送前拦住，并说清楚是模型失效，而不是「机器人在回答前停止了」；失败已落库的一轮仍在。
- **干活卡**：做完 / 被停 / 没回答的一轮不再留「做了 N 步」；只说得出步数的卡整行收起，跑完只留回答。
- **长命令**：运行命令不再被 12 秒发送看门狗掐断（`signal is aborted without reason`）。

### 分段选择键盘约定

- 13 处 radiogroup 收敛成一个钩子；主题、记忆筛选、左栏切换等一并接上；认不出的地址给真正的 404。

### 测试基线

- 清基线撞出的 8 个产品问题已修；161 条测试改到当前中文界面 / 现有行为（剩跨文件污染另开一轮）。

## 0.1.48 — 2026-10-20

### 性能：省带宽、少等几秒、慢接口有日志

这一版没有新功能，只有 6 处性能改动（#263）；`pc/` / `android/` 没有代码改动，客户端只对齐版本号。

- **API gzip**：`/api/*` 加压缩；`/api/conversations（原旧兼容路由）/*`（SSE 流式）排除，避免攒块后一截一截地蹦。远程访问省带宽、首屏更快。
- **健康检查并行**：数据库 ping、Magpie、Computer 三个独立检查从顺序 `await` 改成 `Promise.all`，各自超时与返回结构不变；最坏耗时 21s → 8s。
- **前端请求缓存**：React Query 全局 `staleTime: 30_000`，切页面 / 开关弹窗导致组件重挂载时不再重复请求；显式设置 staleTime 的调用不受影响。
- **模型列表**：去掉 `refetchOnWindowFocus: "always"`，切回标签页不再每次重拉。
- **请求超时**：`client()` 默认 30s `AbortSignal.timeout`，服务端 hang 住时页面不再无限转圈；调用方显式传 `signal` 时用调用方的（SSE / 长轮询不受影响）。
- **慢请求日志**：服务端只记耗时 >1s 的 `/api/*` 请求（一行 JSON：method / path / durationMs），不记 query、请求体和请求头。
- **客户端**：三处版本号对齐 `0.1.48`，Android `versionCode` 245 → **246**；外壳指纹不变，原地更新。
- **验证**：CI 通过（typecheck / build / 相关测试）；`server/tests/ops-health.test.ts` 9 项通过。没有做线上压测，真实体感要等部署后再看。

## 0.1.47 — 2026-10-20

### 易用性第一批：失败与取消不再「假成功」

全面实机审查（6 路只读 + 本地真实全栈）列出的 3 条 P0、27 条 P1 里，这一版先落地聊天停止、共享技能保存、首次上手、审批与退出这几条；TOOLS-01（CC 克隆锁死）等留到下一批。

- **停止（CHAT-01）**：发送后、回答开始前按停止，本轮不再继续执行——实机 116ms 停止，回答没有流出来，有副作用的工具也不会在「已停止」之后开跑。**仍待收尾**：这条消息若已进会话，暂时没有「已停止」标记，字也不会回填输入框。
- **停止计数（CHAT-02）**：`finally` 里的 turn 计数改成 `Math.max(0, …)`，一次停止不再把计数减成负数、把跨设备同步静默关掉。
- **共享技能（SET-01）**：保存成功才清空草稿、关窗；失败保留整篇指令并在对话框里显示中文原因，不再「窗关了但没保存」。
- **首次上手（REAL-02）**：只填显示名称就能「保存并进入」，头像可以以后再换；必填流程不再要求先上传。
- **审批（TOOLS-04）**：`/api/approvals` 任一侧读取失败都显示失败与重试，不再落到「没有等你处理的事」。
- **退出（S-03）**：退出登录失败给中文 toast，成功才离开，不再静默关闭菜单。
- **文案（S-04）**：机器人操作、引导保存的兜底错误改成中文，不再把 `Failed to fetch` / `Coworker operation failed` 直接上屏。
- **CI 回归（#252）**：`deploy/compose.yaml` 的 `TRUSTED_ORIGINS` 改成 `${…:-…}` 后，信任边界红线测试直接拿整段插值做断言，main 一直红；测试改为校验回退默认值，并拒绝没有 `:-` 的写法。
- **客户端**：三处版本号对齐 `0.1.47`，Android `versionCode` 244 → **245**；`pc/` / `android/` 没有代码改动，外壳指纹不变，原地更新。

**验证边界**：REAL-02 与 CHAT-01 在本地真实栈（PostgreSQL 18.4 + 真实前端 + 流式假模型）实机复现；其余为代码 / 单测级。真实模型、线上登录、PC / Android 真机未跑；全量测试基线仍红（typecheck 312 errors、app 212 fail），不能当发版门禁。

## 0.1.46 — 2026-10-19

### PC 在线更新：真正的 NSIS 卸载器名是 `Uninstall ChisaBotPC.exe`

- **根因**：`isInstalledBuild` 只检查 `Uninstall ${productName}.exe`，也就是带空格的 `Uninstall ChisaBot PC.exe`；electron-builder 实际写的是按 `executableName` 命名的 `Uninstall ChisaBotPC.exe`。安装版因此被当成免安装版，`supported = false`，「检查更新」直接返回，不会请求 `latest.yml`。
- **修**：同时接受带空格和去掉空格的卸载器名；补一条使用真实文件名的测试。
- **影响**：0.1.11–0.1.45 的已安装版本都有这个判断，无法自更新；需要手动装一次 0.1.46，之后才能正常收到新版本。
- **客户端**：三处版本号对齐 `0.1.46`，Android `versionCode` 243 → **244**；外壳指纹不变，装好 0.1.46 后原地更新。

## 0.1.45 — 2026-10-19

### Claude Code 左栏：新建工作区上移，目录 → 会话更简

- **入口**：桌面上「新建工作区」固定到模式切换下面、目录树上方，打开现有 GitHub / 电脑文件夹对话框；目录树不再重复放底部按钮（`/cc` 手机整页仍保留底部入口）。
- **目录行**：保留三角折叠、来源图标、名称、右侧 `⋯`（电脑同步 / 删除工作区）；克隆中显示 spinner，克隆失败保留错误块 + 重试。名称下面的来源 / 默认分支第二行和常驻同步药丸不再显示。
- **会话行**：只留标题；悬停或当前会话显示删除（确认后归档）；每个目录下保留可见的「＋新会话」。
- **不变**：顶栏、会话页头、模型菜单、右栏和所有后端接口；同步、删除、新建等原有功能都还在。
- **客户端**：`pc/` / `android/` 没有代码改动，三处版本号对齐 `0.1.45`，Android `versionCode` 242 → **243**；外壳指纹不变，PC / Android 都是原地更新。

## 0.1.44 — 2026-10-19

### 机器人装好的工具真的在 PATH 上：`npm i -g` 之后下一条命令就能跑

- **根因**：`npm i -g` 已经装到 `/workspace/.npm-global`（0.1.41 的修复），但**运行中的容器里 `PATH` 没有这个目录**：
  `Dockerfile` 那条 `ENV PATH=…:/workspace/.npm-global/bin` 到不了运行时（s6-overlay 启动时重建 `PATH`，镜像与容器的
  `Config.Env` 里都没有这一项），而 `computer_run_command` 把进程的 `PATH` 原样交给机器人。于是安装那一轮成功、
  下一轮 `claude: not found`，机器人把自己**装成功**读成**装失败**，再改成「后台安装」又失败一次——测试机上
  `npm install -g @anthropic-ai/claude-code` 退出码 0、`/workspace/.npm-global/bin/claude --version` 正常，
  但 `command -v claude` 找不到，就是这么来的。
- **修**：`agent-computer/src/shell.ts` 的 `environmentForCommand` 在部署给的 `PATH` **之后**追加机器人自己的三个安装目录
  （`HOME` 就是工作区）：`.npm-global/bin`（npm 全局）、`.bun/bin`（bun 全局，`HOME` 是工作区时 bun 的默认位置）、
  `.local/bin`（`pip install --user`）。追加而非前置，装的包不会遮蔽镜像自己的 `node` / `bun`；已经在 `PATH` 里的条目
  保持原位；`WORKSPACE_DIR` 末尾带 `/` 也不会拼出 `//`。`PATH` 由这个函数拼，不再依赖镜像里的 `ENV PATH`。
- **验证**：在真实镜像里跑 `agent-computer/tests/shell.test.ts`，32 项全过（新增 5 项：目录追加顺序、重复不重加、
  尾斜杠、父进程没有 `PATH` 时不臆造、以及「装好的工具下一条命令能跑」的端到端用例）。同一镜像里用真实代码跑真实装好的
  `claude`：旧代码 `MISSING`，新代码 `2.1.303 (Claude Code)`。
- 仍然没改：npm 11 的 `allow-scripts` 默认闸门（装带 postinstall 的包仍需 `npm approve-scripts <包名>`，或接受它只装不跑脚本）；
  Ubuntu 的 PEP 668 也仍然拦 `pip install`（镜像里给了 `python3-venv`，`python -m venv` + pip 照常可用）。

## 0.1.43 — 2026-10-19

### 客户端发版补齐：PC / Android 对齐到 0.1.43

- **问题**：0.1.35 起每一版都只改服务器和网页，但发版照样推 `v0.1.x` 标签，标签会触发客户端发版工作流，
  而工作流第一件事就是核对「标签 == pc 版本 == android 版本」。客户端版本从 0.1.34 起再没动过，于是
  **每一次都在 50 秒内失败**（`标签 v0.1.42 与版本 v0.1.34 不一致`），PC / Android 的安装包一直停在 0.1.34。
- **修**：三处版本号一起改成 `0.1.43`（根 `package.json`、`pc/package.json`、`android/app/build.gradle.kts` 的
  `versionName`），`versionCode` 240 → **241**；补 `.github/release-notes/v0.1.43.md` / `.android.txt`。
- **外壳没变**：`pc/` 和 `android/` 自 `v0.1.34` 起零提交，外壳指纹仍是 `059438f4e6c98c74`，PC 和 Android 都是
  **原地更新**，不用重新安装。这一版装出来的行为和 0.1.34 一致，差别只是版本号。
- **Android 未签名**：仓库没有配 `ANDROID_*` 签名 Secrets，Release 里是 `-unsigned.apk`；
  要装到手机上，用自己的签名密钥签一次，自己的更新源照 [docs/ops/client-release.md](docs/ops/client-release.md) 走。
- 电车类定时仍暂停；未在真机上验证（CB-017 / CB-018）。

## 0.1.42 — 2026-10-19

### 接管后点不动、滚不动：输入不再被一次失败的查询关掉

- **根因**：大屏的输入（点击 / 键盘 / 地址栏 / 滚轮）除了 `driving`（控制权轮询给的那个事实）之外，还要看
  `inputReady` —— 它把「socket 开了」和「连上这一刻再读一次控制权、那个人还拿不拿着轮子」合成一个答案。
  断线重连时第二次读失败（部署、计算机忙、笔记本唤醒、网络闪断）就一直是 `false`，而它**只会在 `driving`
  由 false 变 true 的那一下重查**，人已经在开车，这个边沿不会再来：画面照旧一帧帧地来，点、打、滚全被无声丢掉。
  页面上写着「你正在控制浏览器」、按钮写着「交还」，却什么都没反应。
- **修**：`onReady` 只回答「这个 socket 能发了没有」（`open` = ready），`verifyOwnership` 和 `inputReady` 一起删；
  能不能操作只看 `driving`；人到底拿不拿着轮子由 agent-computer 的 `humanMayDrive()` 判断并回中文拒绝，
  大屏把它显示出来（说一句「先接管」好过什么都不说）。键盘 / 滚轮的监听不再依赖 `connected`。
- **顺带**：滚轮按 `deltaMode` 折算（行 ×16px、页 ×一个屏幕高）。报告「行」的浏览器一次只有 3，
  而 CDP 按像素算 —— 不折算是「一次挪 3px」，看起来就是滚不动。
- **顺带**：socket 没开时点地址栏不再留一个永远转的圈，改显示「屏幕正在重新连接，稍后再试。」
- **顺带**：计算机的英文拒因（「先接管才能操作」「屏幕还在打开」等）翻成中文再盖到画面上，认不出的原样显示。
  这些话在直播这条路上原来到不了：App 自己不通过就不发，计算机也就没机会拒绝。
- 回归：`app/tests/screen-connection.test.ts`（重连即 ready）、
  `app/tests/live-screen-mouse.test.tsx`（重连后滚轮照样带坐标发出去）、
  `app/tests/live-screen-blank-page.test.ts`（拒因说中文、认不出的不吞）。只改网页，不动数据。


### 计算机卡片：大屏直播后不再永久停轮询

- **根因**：`shouldPauseScreenshotPoll` 在 `liveCast`（或连续失败）时直接 `return`，不再排下一次定时器——大屏关了也不会自己回来。
- **修**：停改成慢。liveCast 固定 10s 探一次；连续失败指数退避（上限 30s）；底栏文案改成真实承诺。
- PR: https://github.com/ChisaAlter/ChisaBot/pull/256

### 模型网关 Magpie：不再写死版本，页面上可以一键升到最新

- **镜像不再钉死摘要**：`deploy/magpie.compose.yaml` 改成 `${MAGPIE_IMAGE:-ghcr.io/yetone/magpie:latest}`。
  想钉住自己验证过的版本，就把 `MAGPIE_IMAGE` 设成一个摘要（`deploy/.env`、compose 的 `environment`，
  或 `deploy/updater/config.env`）。
- **管理后台 → 模型平台 Magpie 多了一张「网关版本与更新」卡**：当前版本、镜像摘要、「已是最新 / 有新版本 / 未知」，
  两个按钮——「检查更新」和「更新到最新版」（宿主机上还没有这个容器时写「安装最新版」）。
- **宿主机每 30 分钟查一次** registry 的 manifest（`deploy/updater/magpie.sh --check`：只读，不拉镜像、不碰容器，
  所以不占更新锁），结果写 `spool/state/magpie.json`；点「检查更新」会立刻查一次。
- **「更新到最新版」**排队一个新的 `magpie` 动作：先 `pull`（拉不动就不动正在跑的容器）→ `up -d` 重建 → 健康检查，
  **不过就自动回退到上一版摘要**，并把这次更新报成失败。它和 ChisaBot 自己的更新共用一把锁，不会同时跑。
- **更新程序版本 3 → 4**（`deploy/updater/chisabot-updater.py` 的 `VERSION` 与 `shared/system-update.ts` 的
  `SYSTEM_UPDATE_UPDATER_VERSION` 一起改）。旧更新程序认不出 `magpie` 动作，页面会提示先做一次系统更新——
  而这次更新本身就会把更新程序升上来。
- 判断有没有新版比的是**镜像摘要**，不是版本号：Magpie 的镜像只有标签，版本号要问它自己的接口。**查不到远端摘要时说「未知」，
  不说「已是最新」**。
- 回归：`shared/system-update.test.ts`（投影：摘要决定一切、缺摘要时不宣称有新版）。

### 机器人自己的机器：`npm i -g` 不再要 root；ops 预算真正落盘

- **`npm install -g` 以 `pwuser` 跑**（`agent-computer/src/shell.ts`，命令的 `HOME` 是 `/workspace`），而 npm 的全局前缀原本是
  root 拥有的 `/usr/local`：每次安装都在一两秒内 `EACCES` 失败，模型把结果读成「调用被中断」而不是权限错误，于是退回「后台安装」
  再失败一次。`Dockerfile` 把全局前缀改到 `/workspace/.npm-global`，并**追加**（不是前置）到 `PATH`——装好的工具随工作区卷留到
  下一轮，也不会遮蔽镜像自己用的 `node` / `bun`。
- **ops 预算终于写得进盘**：`/workspace/.chisabot-ops/budgets.json` 在 `pwuser` 拥有的工作区卷里，而 API 跑在 `apiuser`，于是
  每次 flush 都 `EACCES`、`GET /api/admin/health/budgets` 永远是空的（只有一行 `[ops-metrics] flush failed` 警告）。
  `docker/s6/s6-rc.d/api/run` 在降权之前建好目录并 `chown apiuser`。
- **部署注意**：两处都在镜像里，`Dockerfile` 变了会触发一次完整构建。已有的工作区卷不用动，目录在容器启动时补建。
  npm 的 install script 仍然默认被拦（npm 11 的 `allow-scripts`），装带 postinstall 的包（例如 `@anthropic-ai/claude-code`）
  仍需要在机器人里跑一次 `npm approve-scripts <包名>`——这次没有改那个默认值，它是一道有意的供应链闸门。

## 0.1.41 — 2026-10-19

### 生产成熟度 · 截图 503 根因（LiveScreen ↔ HTTP 协调）

- **根因**：LiveScreen CDP screencast 与 HTTP `page.screenshot` 抢同一页面 → 超时/502 → 网关 opaque 503，大屏仍像健康直播。0.1.40 只停了展开时的客户端轮询。
- **agent-computer**：`capture-gate` — 直播中 HTTP `/screenshot` 立刻 503+`captureBusy`+`liveCast`（不打 CDP）；并发 HTTP 截图串行，第二路同样 busy；截图超时改 422+`pageTimeout`（15s 上限）。
- **网关**：`CaptureBusyError` 透传标志；422→`PageTimeoutError`。
- **UI**：识别 `liveCast` / `captureBusy` / `pageTimeout` 中文；liveCast 立刻停轮询；失败仍清帧（DOG-05）。
- 电车仍暂停。未改 PC / Android 外壳。

## 0.1.40 — 2026-10-19

### 生产成熟度 · 狗粮摩擦（v0.1.39 冒烟）

- **计算机截图 503 诚实**：大屏展开时停 HTTP `/screenshot` 轮询（LiveScreen 出图），避免与流双打导致 503 刷屏却仍像健康直播；失败退避上限 30s，连续 5 次失败暂停自动轮询等「重试」（对齐 DOG-05 清帧）。
- **暂停定时陈旧确认**：`paused` + `waiting` 改写为「暂停前在等确认 · 已暂停，不会自动继续」；主按钮隐藏「立即运行」（菜单仍可手动跑）；从不 auto-resume 电车。
- **已删机器人定时清理**：`DELETE /api/schedules/orphans` 硬删任意状态孤儿；扫周期 purge；设置页进页自动扫 + 一键可靠清理；孤儿判定含隐藏机器人（只清真删除）。
- **安装胶囊**：顶距 48→56px，减轻压住对话首行。


## 0.1.39 — 2026-10-19

### 生产成熟度 · PRD-P0-02 Magpie/边车隔离

- **网络隔离**：`scripts/ops/isolate-sidecar-app.sh` 在 `DOCKER-USER` 对 Magpie 及同网边车 **DROP → app:3001**（注释 `chisabot-sidecar-iso`）；App→Magpie `:3425`/`:3430` 保持畅通。
- **br_netfilter**：同桥流量必须 `bridge-nf-call-iptables=1`；`--apply` 会 modprobe 并写 sysctl.d / modules-load.d。
- **部署**：`deploy-serial` 默认 `--apply` + `--verify`（失败退出 8）；`deploy/magpie-isolate.service` 开机重放；`start.sh` root 时顺带 apply。
- **CI**：`isolateScriptCoversSidecarDeny` + trust-boundary red-line；`check-trust-boundary.sh` 校验脚本存在。
- **文档**：`docs/ops/trust-boundary.md` §5.1 who-can-reach-whom；production-checklist §9b。
- 电车仍暂停；多用户 UI 仍 opt-in；未强制卸下 shared Docker 网（可选人工拓扑，见信任边界文档）。

## 0.1.38 — 2026-10-19

### 生产成熟度 · 发送恢复诚实 + 弹窗毛玻璃

- **failed-send-attachments**：失败发送后附件 / 队列恢复 3 条路径转绿。频道 harness 补 `/api/bot-threads` 404（与生产频道「无 sync」一致，断线结算立即 `lost`）；失败 fixture 用 HTTP 500（非 502/503/504 连接断开类），恢复路径诚实、无假成功。
- **CB-029 / DESIGN §37.3**：弹窗・抽屉・菜单・popover 内容层静止后 `backdrop-filter: none`（底色已是 glass-3）；遮罩保留轻 blur + glass-hold。钉死 `glass-hold-panels.test.ts`。

## 0.1.37 — 2026-10-19

### 性能 / 测试

- **PRD-P2-03 / CB-025**：长对话首屏先挂最后一屏（`tail-first-paint`），rAF 分批往前补；上滑保留 scrollTop；`?message=` 仍靠 MessageFind 轮询。不做虚拟列表 / 不用 content-visibility。
- **测试漂移**：作曲器附件断言对齐产品中文（`移除` / `附件` / `队列消息` / `驳回此拒绝` 等）。

## 0.1.36 — 2026-10-19

### 生产成熟度 · P2 诚实 UI / 中文一致 / 日志脱敏余量

- **PRD-P2-01**：活动页状态中文 + 失败显眼；定时 run 卡死超过 20 分钟按失败展示（不再永远 busy）；已删机器人下的 active/paused 定时扫周期自动取消（从不 auto-resume）；Claude Code 零回合空闲会话标「空草稿」
- **PRD-P2-02**：作曲器附件拒绝/合并/超量文案与 `picked-files` 拒因中文化
- **PRD-P0-05 余**：更多 console 路径走 `reasonWithoutStatement`；CI `log-scrub-redline.test.ts` 红线

## 0.1.35 — 2026-10-19

### 生产成熟度 · 狗粮摩擦（浏览器 E2E follow-ups）

- 「已停止」锚点：服务器 `stoppedTurns` 与 fallback 一样从 RUN_STARTED 输入的**最新**消息往回找用户行（修 Math.min 误挂上一轮）；停止时跳过定时/任务等非人发 user 行；折叠行仍画出停止标记
- 安装横幅：仅可安装时出现；× 永久关掉；安装取消/超时 14 天 snooze（不再每个会话盖住聊天）
- 复制 / 重新生成：无障碍树单一 live `aria-label`，叠层文案 `aria-hidden`（不再堆「复制/已复制/复制失败」）
- 附件文件选择：隐藏 `input[type=file]` 可访问名为「选择文件」

## 0.1.34 — 2026-10-19

### 生产成熟度

- nginx 模板与生产同步：`sync-nginx.sh` apply-or-fail；deploy-serial 漂移检测；CI check-repo（#233）
- 非电车定时复验：fail→pause、stuck reclaim 计入连续失败、paused 永不 auto-resume；`partitionScheduleList`；电车仍暂停

## 0.1.33

### Added

- Trust-boundary network isolation: nginx clears Local-Caller; friend-up/start deny-by-default port binds; TRUSTED_ORIGINS loopback-only; CI `trust-boundary-redline`; `scripts/ops/check-trust-boundary.sh`; post-deploy anonymous admin-health 401 check; expanded `docs/ops/trust-boundary.md`.

### Notes

- Tram schedules stay paused. Multi-user accounts UI stays opt-in. No live CUTBACK_EXECUTE.

## 0.1.32

- Ops maturity **metrics timeseries + traffic-cut rollback**: minute-ring budgets with `rates` / `series` on `GET /api/admin/health` and scrape `GET /api/admin/health/budgets?hours=…`; file persist `/workspace/.chisabot-ops/budgets.json` (no managed SaaS). `scripts/ops/cutback.sh` dry-run by default (`CUTBACK_EXECUTE=1` to cut); `KEEP_IMAGES` default 5; RTO ~2–5 min in `docs/ops/traffic-cut-rollback.md`.


## 0.1.31

- Production maturity **send honesty + MCP abort**: `decideSendWatchdogAction` + automated tests that timeout/unpersisted/reply-hang never look like success; MCP SDK `AbortSignal` on connect/callTool; `grantedTools` honours Stop and suppresses late success; Drive merges abort; Composio/builtin entry-check (mid-flight vendor SDK limits documented).

## 0.1.30

- Production maturity **Track D** (friend pack + safe defaults): `deploy/friend-up.sh` one-click compose with loopback bind / no public single-user TRUSTED_ORIGINS; Better Auth Secure cookies when https public URL or `CHISABOT_SECURE_COOKIES`; `start.sh` refuses `0.0.0.0` app binds.
- UX: 设置 → 分享给朋友；机器人列表一点开聊（正确 bot 上下文）；docs/friend-deploy.md。

## 0.1.29

- Production maturity **Track B** (stability): hung-turn stop clears busy + force-unlock; 25min wall-clock abort; periodic expired lock sweep; connect snapshot capped by count/bytes for long threads.
- Schedules: reclaim stuck `running` (>20m) during sweep; auto-pause after 3 consecutive failures (never auto-resume); settings UI「需要关注」+ orphan live cleanup for deleted bots.

## 0.1.28

- Ops maturity (PRD-P1-02…06): process-local SEND/STREAM/SSRF error-budget counters on `GET /api/admin/health` (`budgets`); client beacon `POST /api/ops/budget`; `guardedFetch` / computer-stream proxy bump on deny/disconnect.
- CI SSRF red-line suite (`server/tests/ssrf-redline.test.ts`) — redirect→internal + mapped IPv6 must stay green.
- Docs: gateway/node trust-boundary diagram; recorded backup/rollback dry-run on <PROD_HOST> (`docs/ops/backup-rollback-drill.md`).

## 0.1.27

- Hotfix ops health: computer probe uses real bot ids from `list()` (fake `__ops_health__` caused agent-computer 500); post-deploy smoke parses top-level `ok` only.

## 0.1.26

- Ops maturity (PRD-P1-01…03): `GET /api/admin/health` aggregates app/version, DB ping, Magpie, computer node, Local-Caller for monitors.
- Post-deploy hard smoke (`post-deploy-smoke.sh`) runs from updater `health.sh` after image swap; fails deploy (rollback) on version/capabilities/aggregate red. Model smoke stays advisory unless `STRICT_MODEL_SMOKE=1`.
- Docs: `docs/production-checklist.md`; monitoring/deploy/incidents playbook stub; `request.sh smoke`.
- Structured ops codes starter in `shared/ops-codes.ts` (`OPS_HEALTH_*`, greppable JSON lines).

## 0.1.25

- Production hardening: live computer stream keepalive (protocol sendPings + application `{type:ping}` through the proxy) so a static page + idle viewer is not dropped at 120s (CR-P2-12).
- SSRF leftovers: OAuth token/registration URLs refuse private/metadata hosts; media-model fetches default to `redirect:"error"` so API keys cannot follow a 302.
- Log scrub: cloud-cc / sync / oauth / passwords error paths use `reasonWithoutStatement`.
- Honesty: screen disconnect copy in Chinese; `/api/version` smoke test asserts no secret leakage; ping resets live-screen retry budget.

## 0.1.24

- Bot egress floor denies RFC1918 / loopback even under `allow_all` (aligned with navigation).
- Honest UI: search errors, install-hint cancel, deep-link keep-alive, late page-frame retry.
- Hardening: MCP resolve check, stream proxy errors, preview browser cache, Secure cookies on https, vault POST via guardedFetch.


What changed, for somebody deciding whether to upgrade. Written for the person running 早期上游模板, not
for the person who wrote the commit: a line belongs here when a deployment behaves differently
afterwards, and does not when only the code moved.

Newest first. `Unreleased` is what is on `main` and not yet tagged.

## 0.1.115 — 2026-10-30

这一版合并 #449、#448：改窗口大小时暂停 WebGL 天空；切会话时左栏高亮先到、对话延后渲染。只有网页更新，网关、登录服务（web-auth）、PC 和 Android 不变。

- 修工作流审批 / 执行 / 恢复 / 启动的并发问题（审查模块 13 S5）：两次并发审批只有一个能过（状态条件更新，另一个返回 409），被审批的步骤只执行一次；执行前先原子占位（进程内同步占位 + 数据库 queued→running 条件更新）；运行中每 30 秒刷新心跳，开机恢复只把心跳超过 90 秒的运行标失败，部署重叠时不再误杀另一个容器正在跑的运行（心跳新鲜的过了租约再查一次）；启动时计数和插入放进同一事务并按用户加锁，并发启动也不会突破同时 3 个的上限。只改 `server/src/workflows/`，没有新迁移（心跳用现有的 `updated_at`）。

- 外观设置不再卡（模块 11 审计必修 1）：改雾度 / 配色 / 材质原来每一步都在 `<html>` 上改 `--lg-alpha`，玻璃变量挂在根上往下继承，整页约 390 个元素每一步重算一次样式（4 倍 CPU 降速下拖雾度一次 450ms、INP 2.6s）。现在 `--lg-alpha` / `--lg-surface(-strong)` / `--lg-blur` / `--lg-shadow` 注册成不继承、只声明在读它们的玻璃面板上，雾度写进一条单独的样式规则、每帧最多写一次，根上不再写行内变量；换配色时天空换场景（引擎会当场画一帧）挪到这次点击上屏之后，慢机上天空渐变帧拉开间隔、按下鼠标 / 按键后 300ms 内不出帧，不再挤进点击的那一帧（4x 降速下配色 INP 中位 360ms → 88ms）；也去掉了 PC 抽屉 `body:has(…) .glass-topbar *` 这条一插入元素就让整页重算的规则。
- 外观设置补齐：手机地址栏颜色（`meta theme-color`）跟着应用的深浅色和配色走；多个标签页之间的配色、材质、雾度、深浅色、性能模式通过 `storage` 事件同步；系统打开「减少动态效果」时天空当帧停下；启动骨架直接用用户选的配色（不再先闪默认天空色）；设置 › 通用 › 外观新增「性能模式」开关，打开后头像表情动画也停。只改前端，不改版本号。
- 修天空背景换场景时渐变偶尔停在半路（主线程卡的时候停在 0.76～0.98 一到四秒，要等下一次唤醒才跳完）：渐变一旦开始就一直醒着画到结束（最多 8 秒），引擎跳过不画的那一拍也续上；天气（open-meteo）响应的 body 读完时再叫醒一次天空，网慢时天气带来的那次渐变也能画出来。改动在 `app/src/components/sky-background.tsx` 和新文件 `app/src/lib/sky-fade.ts`，引擎 `wallpaper_core.html` 未改；空闲、失焦、隐藏时照旧不画。未升级版本号。

- 安卓 App 语音输入的麦克风权限（#419，安卓客户端改动，随下一个客户端版本发布，和 #400 一起）：WebView 只对我们自己的 origin、只放行录音（AUDIO_CAPTURE），没有系统权限时先弹系统授权、拒绝就不给；Manifest 声明 `RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS`（麦克风不是必需硬件）。服务器 / 网页未变。

- 形象头像在想 / 干活 / 被选中 / 做完了时像果冻一样持续变形，眼睛会眨会看，状态切换走弹簧；全局一个 rAF、只动在动且看得见的头像，减少动态效果 / 性能模式下不变形。头像编辑框的预览表情改为单选（修「做完了」时「工作中」还亮着）。
- 修「有新版本，点此刷新」明明输入框是空的也弹「输入框里还有没发送的内容」：那道确认原来扫整页的 `textarea` / contenteditable / `type="text"`，机器人画的卡片表单、面板、搜索框都会被当成聊天草稿；现在只认显式标了 `data-unsent-watch` 的输入（编辑中的消息、还没提交的审批回答），聊天的草稿本来记在 localStorage 里、刷新会恢复，不再拦人。文案也改成说清到底会丢什么。输入框上还挂着的附件（File 只在内存里）现在单独拦一下，确认框写明刷新后要重新选。
- 右栏自定义面板（§109，参考 dsh-pad）：面板可以挂最多 3 个直连数据源（https / 本机命令），宿主按秒级取数、值回填 `/live/<id>`，不再为刷新花 token；卡片可以两两并排、拖比例、单卡拖高、折叠，布局按机器人记在本机；⋯ 菜单新增「让 AI 修改…」与「数据来源…」。命令数据源默认关闭且只给管理员（`CHISABOT_PANEL_COMMANDS=1`）。见 [docs/live-panel-sources.md](docs/live-panel-sources.md)。

- 计算机陈旧截图不再当直播（#214，v0.1.22 / DOG-05）：截图失败清帧 + 中文占位/重试；「在用浏览器」仅在有计算机活动时；空闲写「浏览器空闲」。PC / Android 外壳未变，版本号对齐到 0.1.22（Android vc 228）。
- Ctrl+K 正文命中深链到消息并高亮（#213，v0.1.21 / DOG-04）：`?message=<id>` + MessageFind（scrollIntoViewWithin + message-flash）；KeepAlive 地址键不含 message。PC / Android 外壳未变，版本号对齐到 0.1.21（Android vc 227）。
- 活动记录中文工具名/拒因 + 安装横幅不挡标题（#211，v0.1.20 / DOG-02/03）：审计页 computer_* 映射为打开网页/填写/运行命令等；接管英文拒因译中文；横幅显示时正文让位，安装失败/超时/关闭均永久记住。PC / Android 外壳未变，版本号对齐到 0.1.20（Android vc 226）。
> **按版本看**：下面这一节从 0.1.7 之后一直累积，实际已经分别随 v0.1.8 … v0.1.19 发布（服务器改动合并即上线）。
> 每条属于哪个版本、哪个 PR，见 [docs/CHANGELOG.md](docs/CHANGELOG.md)（按发版标签分组）。
- 发消息假成功深挖（#212，v0.1.19 / DOG-01）：connect 改消息快照（不再 ~825KB 事件回放）；12s send watchdog；发送中可停、抑制 sync 重接。v0.1.18 只覆盖隧道 drop，实机 sync 通时仍会静默。PC / Android 外壳未变，版本号对齐到 0.1.19（Android vc 225）。
- 发消息隧道挂掉不再假成功（#210，v0.1.18 / DOG-01）：sync 一路问不到时约 10 秒内提示「可能没发出去」并恢复草稿；识别 ERR_TUNNEL_*；问到过服务器后仍保留重启长等。
- UX P1–P3 全量体验（#209，v0.1.17）：接管「交还」可点、重启后控制权可重置；失败浏览不计「看了 N 网页」；设备列文件区分云端工作区与用户电脑；定时进聊天用绝对日期、侧栏相对时间刷新；活动记录中文与换行；安装横幅可永久关掉且接管时隐藏；干活卡标失败步；Claude Code 会话可归档删除；已删除机器人下已结束定时可一键清理。FIX-13/14 由 #208 快失败覆盖。只改服务器 + 网页，没有表结构变化；PC / Android 外壳未变，版本号对齐到 0.1.17（Android vc 223）。
- 定时 / 搜索 / 停止 UX P0（#208，v0.1.16）：定时任务跑完后按正文归类为等待确认 / 跳过 / 失败 / 成功，不再一律绿「已完成」；定时与 IM 触发的无人值守回合碰到要登录、要密钥、要你接管浏览器时立刻失败并清掉对话锁（不再挂死频道、灰掉发送）；Ctrl/⌘K 能搜消息正文并高亮摘要；点「停止」会取消进行中的联网搜索 / 打开网页等工具。只改服务器 + 网页，没有表结构变化；PC / Android 客户端外壳未变，版本号对齐到 0.1.16（Android vc 222）。
- 机器人能选原生下拉框、回合不再静默结束（DESIGN.md §100）：云端浏览器的快照把原生 `<select>` 的选项收进这个下拉框（`options`），机器人用「填写」（`computer_type`）填选项文字或值就直接选中（月份写 7 / Jul / 七月都行），点下拉框不再弹出系统列表把后面的操作卡住，下拉框里没有的选项会回 400 并列出可选项。计算机操作的普通失败（元素过期、找不到、没有这个选项、电脑暂时不可用）现在作为「没做成」的结果交回给机器人接着做，不再让 `POST /api/approvals/computer/:bot` 回 500、让这一轮停在半路；一轮做到一半停下、接力的某一步出错、或回复是空的，聊天里都会出「这一轮没有完成 / 没有做完」卡片和「重试」。启动日志 `computer-isolation` 的文案改为如实说明「每个机器人有自己的浏览器配置，共享进程和 /workspace」。只改服务器、网页和电脑服务代码（随服务器镜像更新），没有表结构变化；PC / Android 客户端不用更新。

- 设置重新整合 + 设置搜索 + 输入框权限（CB-083，DESIGN.md §97，docs/settings-ia.md）：设置左栏按「通用 · 机器人 · 电脑与设备 · 账号与连接 · 模型 · 系统」重新分组排序，「审批偏好」改名「权限与审批」并放进每个机器人的权限；所有页面地址不变。左栏顶部加了设置搜索（Ctrl/⌘ K 或 /），能搜页面和页面里的设置项（中文、拼音首字母、英文都行），跳过去会把那一块滚到中间并闪一下。聊天输入框「+」后面加了权限开关：「请求批准」（在电脑上运行命令、改文件、装软件前始终先问）/「完全访问」（橙色，直接做，允许的文件夹以外也自动加进去）；按机器人存在服务器、由服务器执行，打开完全访问要确认一次并记进活动记录；付款、关闭的设备能力、紧急停止、管理员身份运行等照旧拦着。没单独设过的机器人沿用原来的「操作你的电脑」偏好，行为不变。新表 `chisabot_bot_permissions`（开机建表，只新增；回滚镜像即可）。PC 客户端不用更新。
- 连续聊天时发消息不再整页上跳（CB-080，DESIGN.md §94）：以前每发一句，整段对话往上翻一页——刚发的那句被拉到顶上、下面留一屏空白，刚读到的回答被推走。现在上一条消息发出不到 5 分钟（一来一回聊着）时，新消息就出现在底部、对话跟着回答往上长，不翻页、不留空白；隔了 5 分钟以上（或这段对话第一句）照旧把新的一轮对齐到顶上。时间以服务器记下的发送时刻为准（新的只读接口 `GET /api/conversations（原旧兼容路由）/threads/:id/sent-at`），刷新后、换设备也一样。顺手修了：刷新后回到留着空白的对话再发一句时先往回跳一下；输入框打字长高时最后一行被盖住一帧；连续聊天里带干活卡的那一轮，卡片收起 / 回答多出一行时整段对话往回挪 5–45px 的那一下（底下的留白改成跟着内容同一次布局变，DESIGN.md §94.6）。只改网页 + 一个只读接口，没有表结构变化。
- 浏览器暗色图标 + 外侧去掉标签 + 放大页重排（CB-082，DESIGN.md §96）：暗色主题下 GitHub 这类黑色网站图标、深色字母块在标签栏、收藏栏、「收藏夹」下拉和管理面板里垫一块浅色小底板，不再黑上加黑（按图标本身的亮度判断，不是站点名单）。右栏「计算机」小画面上面不再有标签条，标签只在放大的浏览器里。放大的浏览器重排：标签栏、地址栏、收藏栏合成一块工具条，标签像 Chrome 一样坐在工具条上，「+」紧跟最后一个标签，关闭按钮在标签栏右端；屏幕按窗口剩余高度等比缩放，卡片永远不出滚动条，底栏「你正在控制浏览器 · 交还」始终在卡片里；手机上整屏显示。只改网页。
- 简单回合不出干活卡（CB-079，DESIGN.md §93）：像「看看我的电脑」这种只用了一两个只读工具（列设备、截屏、看文件列表、翻记忆…）、几秒钟就答完的一轮，结束后不再留「✓ 做了 2 步 7 秒」那一行，开场那句「我来查看…」也不再单独一个气泡，只剩回答和截图（干活时卡片照常显示；跑命令、改文件、上网、出错、要确认、超过 3 步或 15 秒的照旧保留卡片）。有卡片的一轮里开场那句收进卡片（点开在最前面）。回答里单独一行的图片不再多出一个空的小气泡。一轮答完后回答下面不再留一大块空：对话平滑落到正常底边距，刷新后也一样。只改网页。
- PC 本机小窗口无边框、圆角、只有一道边（PC 0.1.15，DESIGN.md §91）：「登录 ChisaBot」窗口不再是 Windows 原生白标题栏 + 系统边框，天空铺满到边、四角圆角（透明窗口由页面裁 8px 圆角，Windows 10 / 11 一样；不用系统窗框，因为它在 125% / 150% 缩放下会露浅色边），按住顶部拖动，右上角只有最小化 / 关闭，固定大小。审批（「需要你确认」）、本机确认、更新提示不再是「窗口边 + 卡片描边」两圈，整个窗口就是对话框；审批说明框按内容定高（最多约 8 行，再多框内滚动），窗口按内容定高、量好再显示。只改 PC 客户端（`pc/src`），外壳指纹不变，0.1.14 原地更新。新增 Windows 截图工作流 `.github/workflows/pc-shots.yml`。
- 窄窗口里输入框两边也留白（CB-078，DESIGN.md §92）：左栏展开的 700–1100px 窗口、1280 宽右栏展开、手机上，聊天输入框以前左右贴着左栏卡和窗口边（0px），消息却有留白。现在输入框左右至少 16px、底边 16px；右边有「面板」把手时让开把手，和消息列对齐；宽屏还是 672px 居中，和以前一样。Claude Code 会话页输入框左边从 4px（手机 10px）改成 16px。只改网页。
- 机器人浏览器多标签 + 收藏夹（CB-081，DESIGN.md §95，docs/browser-tabs.md）：「ChisaBot 浏览器」现在有标签栏——机器人和你看到同一组真标签（最多 8 个），接管后可以切换、关闭、新开，只看着时也能看出机器人在哪个标签上；右栏小画面上面也有一条。浏览器重启后恢复上次开着的标签。地址栏加了星标，下面是收藏栏（窄屏「收藏夹」下拉），可以改名、改网址、拖动 / 上下移排序、删除；收藏夹每个账号一份、所有机器人共用，第一次使用时放进新标签页原来的五个网站，新标签页上的常用网站就是收藏夹前 12 个。机器人多了 `computer_tabs`、`computer_bookmarks` 两个工具（只有你明确要求才改收藏夹）。新表 `chisabot_browser_bookmarks` / `chisabot_browser_bookmark_seeds`（开机建表，只新增；回滚镜像即可）。电脑服务代码随服务器镜像一起更新，不用换云端浏览器镜像。
- 中途说明文字收进干活卡、断线重接不再写两遍（CB-077，DESIGN.md §90）：机器人在两步之间说的话（「检查结果显示没装，我先用 winget 装」）以前在这一轮出错 / 被停 / 被中断、或者还在跑时，散在「✓ 做了 3 步」下面成一段淡色字；现在下一步一开始就收进卡片，这一轮没有结果时剩下的也收进去，点开卡片在步骤之间能看到它们；真正的结果照旧是气泡。本机的流断了（「暂时连不上模型服务」）而服务器还在回答时，重新接上后同一段话不再出现两遍（工具参数、工具结果也不再多一份）。Android 原生同样的收起规则。只改网页 / Android 代码，不改服务器。
- 「模型老断」修好了（CB-076，DESIGN.md §89）：以前机器人在电脑上跑几分钟的命令（比如 winget 装 Node.js）时，网络抖一下或服务器正好在更新，聊天里就是「暂时连不上模型服务」、那一步一直转、发出去的话被放回输入框——其实模型没出错，服务器那一轮多半还在跑。现在：浏览器这头断线时先问服务器，还在跑就自动接上、不报错，答完了就读回答案，只有服务器也没了才说「和 ChisaBot 服务器的连接断了」并把没完成的步骤收起来；断线后不会重发、不会把设备命令再跑一遍。服务重启时被打断的那一轮，开机自动补完并写明「服务刚才重启了」。更新器切换前先等正在回答的对话结束（最多 15 分钟，`DRAIN_SECONDS`；更新器脚本在下一次成功更新后自动换上）。没有表结构变化，回滚镜像即可。
- 每个机器人记住我的操作状态、消息不再往回跳（CB-075，DESIGN.md §88）：右栏「面板 / 计算机」、右栏展开和宽度按机器人记住；输入框草稿（含 @ / 命令小块）、滚动位置、干活卡展开按对话记住——去设置、切别的机器人再回来、刷新都还在（只存在这台浏览器的 localStorage，不上传）。一轮结束时最后一行变矮不再先画一帧往回跳；回到缓存的对话不再丢掉新一轮下面的留白；历史里的旧用户消息不再被对齐到顶上。失败但已经有回答的一轮算发出去了：输入框清空，「重试」重新生成。只改网页。
- 长对话里的图片不再加载时把消息推开（CB-071 后续，DESIGN.md §83.2）：以前网慢时第一次切到带图片的长对话，图片加载那一下整段对话会被顶上去一两帧再回到底部。现在服务器在存图（上传附件、聊天上传、机器人画图 / 改图 / 交付文件、链接预览转存图片）时读出宽高，读对话时随消息给网页，网页先按比例留好框。以前存的图第一次被读到时现算并记下。新表 `chisabot_image_dims`（开机建表，只加不改；回滚镜像即可，表留着无害）。消息 part 的 `metadata.width/height`、工具结果文件清单的 `width/height`、链接预览的 `imageWidth/imageHeight` 都是新增字段，旧客户端忽略。
- Android 原生第二轮（Android 0.1.14，DESIGN.md §86）：确认卡片（删除 / 发消息 / 付款 / 操作电脑，确认 · 取消 · 以后这类直接做）和云端浏览器的审批原生画在聊天里；可以发照片、拍照、发文本类文件（选了就上传，带进度和失败重试）；回答时可以停止；回答下面「重新生成」、最后一条消息「编辑」后重发（服务器截断，所有设备一致）；定时任务 / 后台任务结果 / 确认后接着做画成一行小字；原生设置：外观（跟随系统 / 浅色 / 深色）、账号与服务器、设备列表（只读）。图片在加载前按宽高留好位置。不改服务器。
- Claude 上游代理支持节点链接（CB-073，DESIGN.md §85）：设置 → 云端工作区 →「Claude 上游代理」除了 http / https / socks5，还能粘贴 `trojan://`、`vless://`（含 Reality / Vision）、`vmess://`、`ss://`、`hysteria2://` / `hy2://`、`tuic://` 链接。打开「用 sing-box 转换此链接」才能测试和保存：云端节点容器里起一个 sing-box，把节点转成只听 127.0.0.1、带随机密码的本地 socks5，Claude Code 和云端登录浏览器访问 Claude 的流量走它（其他网站照旧直连，和普通代理一样）。保存前先起好，起不来就不保存；保存后自动测一次并显示出口 IP 和国家 / 地区。页面只显示 协议 · 主机:端口 · 节点名，原链接加密存在保险箱。**需要新的云端节点镜像**（`deploy/cloud-node`，装了固定版本、校验过 sha256 的 sing-box 1.14.3）；旧镜像页面会提示更新，普通代理不受影响。没有表结构变化。
- 修「Claude 上游代理」的「测试连接」和登录浏览器的出口检查：它们其实一直没经过上游代理（Node 在 `agent: false` 时忽略 `createConnection`，悄悄直连），所以填了不通的代理也显示「连接正常」，节点链接保存后显示的出口 IP 也是服务器自己的。Claude Code 本身的流量不受影响（一直经转发器走上游）。只改云端节点代码（`pc/src/cloud-cc`），部署后要 `docker restart chisabot-cloudnode`。
- 机器人 ↔ Claude Code 原地切换（CB-072，DESIGN.md §84）：管理员左栏「机器人｜Claude Code」每切一次整个窗口闪一下（外壳整个重挂，第一次还会闪一帧整屏骨架），切回机器人左栏全部重读。现在两边共用一个外壳，顶栏和左栏容器不动，只有左栏内容交叉淡入、主区淡入一次；左栏两块都留着（滚动位置、展开的工作区还在），空闲 / 指针移上来时预取对面；切回机器人回到上次那条对话，切到 Claude Code 回到上次的会话。PC 客户端不用更新。只改网页。
- 设备状态标签居中（CB-070，DESIGN.md §82.6 补）：文泉驿正黑下「在线」「2 台在线」「成功」「完全访问」这类小标签（设备页、系统更新、IM、本机代理）里的字不再偏上 1px。只改网页。
- UI 对齐第二轮（CB-070，DESIGN.md §82.6–§82.10）：文泉驿正黑（Linux / 部分电脑默认中文字体）下，下拉框里的字、下拉菜单项、设备页能力标签（「截图·询问」）、审批「先问我 / 直接做」、消息下的「复制」不再偏上 1–2px；字体不支持半角标点时「检查（不生成图片）」「粘贴授权码（备用）」这类以括号结尾的按钮字不再偏左。一轮回答结束时，中间那句过程话不再一下子消失（下面的结果往上一跳），而是 0.2 秒收起。窄窗口 / 手机上右边缘的「面板」把手不再压住用户消息下的「编辑」和气泡右沿（手机上把手收窄到 24px）。只改网页。
- 电脑文件夹导入失败后残留、移除后无法重新导入（CB-074，DESIGN.md §87）：「电脑上的文件夹」第一次报错时左栏还会多出一个工作区，删掉后再导入同一个文件夹被「这个文件夹已经在同步一个工作区了」挡住。根因三处：节点重启后同步边车留在旧的网络命名空间里（连不上，全部失败）；新建失败不撤销；删工作区不拆同步（服务器的绑定 / 租约和电脑本机的记录都留着）。现在：新建 / 开启同步前服务器先探边车，连不上直接报错、什么都不建；主机装了边车看门狗（`chisabot-cloudnode-syncwatch.timer`，节点重启后自动把边车拉回同一个命名空间）；删工作区把绑定、租约、公钥、隧道一起拆掉并通知电脑；服务器启动时清掉已删工作区留下的记录。网页：选到一个以前同步过、工作区已删掉的文件夹时显示「解除旧的同步并重新导入」（已装的 0.1.13 / 0.1.14 也能用），新建失败会撤销留下的工作区并给中文原因，按钮变「重试」；弹窗底栏「取消」和「上传并创建」一行靠右。PC 客户端（0.1.15 起）：新建失败自己撤销，启动 / 收到通知时对账放下已删工作区的本机记录。没有表结构变化（只删孤儿行），回滚镜像即可。

- 按钮里的字居中、干活卡上下留白（CB-070，DESIGN.md §82）：设备页「生成安装命令」按钮的字不再被挤出按钮（容器的 `span` 样式伸进了按钮）；设置左栏「个人 / 管理」折叠按钮上下对称；「检查（不生成图片）」这类以全角括号结尾的按钮字居中（控件标签用半角标点）；同一排按钮同高；输入框放不下的占位文字收成「…」；空状态里的按钮不再贴着说明。聊天里干活卡 / 收成的「✓ 搜索 1 次 · …」一行和上面的确认卡、浏览卡之间留 10px，不再贴着。新增测量脚本 `tests/ui-align/`。只改网页。
- 打开对话落在最新一条、切机器人秒开（CB-071，DESIGN.md §83）：网慢 / 手机慢时，打开长对话常常停在中间某条旧消息、一路卡着滚——历史一段段到，被当成「刚发的一轮」对齐到顶上。现在恢复完成前不画回放的半截（先画上次看到的样子 / 先读到的存储 / 骨架），恢复期间和之后 2.5 秒钉在最新一条（图片加载撑高也在同一帧回到底部，看过的图片先按尺寸留好位置），人一滚就交回。切机器人时先画这台设备上次看到的那段对话，对话详情用左栏那一行先画，空闲 / 悬停时预取左栏前几个机器人的对话，切回来不再重读机器人资料、模型、组件、插件。服务器：接入回放不再每轮重传系统上下文、工具定义和前面的消息（35 轮的对话 3.4 MB → 0.23 MB），客户端得到的消息不变。没有表结构变化，回滚镜像即可。
- 机器人资料一张表 + 圆形头像（CB-069，DESIGN.md §81）：新建机器人、资料页「编辑」、管理弹窗「通用」现在是同一个表单——头像 · 名称 · 职责 · 它做什么，编辑时看到的就是新建时写的（「它做什么」原样存成提示词，不再前后补字）。头像可以上传图片（圆形取景框里拖动、缩放，存成 256×256）、选表情 + 底色、或用名字首字 + 底色；所有地方的机器人头像都是圆的。没设置过的机器人保持原来的花纹。新表 `chisabot_bot_avatars`（开机建表，回滚镜像即可，回滚后头像回到花纹）。见 `docs/bot-avatars.md`。
- 机器人读允许的文件夹之外的地方（PC 0.1.12 + 服务器）：以前让机器人看 `C:\AI` 这类不在「允许的文件夹」（默认桌面 / 文档 / 下载）里的路径，审批卡只写「列出：C:\AI」，批准后 PC 还是报「路径不在允许的文件夹内」。现在卡片写明「C:\AI 不在允许的文件夹里；批准后会把它加入允许的文件夹」，批准就加进去并立刻执行（审计 `roots_added`）；拒绝什么都不加。能力是「允许」或审批偏好是「直接做」时，碰到文件夹之外的路径也会先问。服务器端检查，已装的 PC 客户端也生效。见 docs/pc-node.md §5。
- PC 图标换不过来（PC 0.1.12）：重新安装后桌面 / 开始菜单 / 任务栏还是旧图标——Windows 按图标文件路径缓存，exe 路径不变就一直用旧图。快捷方式和窗口图标现在指向安装目录 `resources\icons\chisabot-<哈希>.ico`（新路径，必然重新读取），小尺寸存 BMP 并补齐 20 / 40 / 96；客户端每次启动检查所有指向自己的快捷方式（包括改过名的、任务栏固定的、指向旧安装位置的）并修好。外壳指纹变了：0.1.11 及更早的客户端这次更新会提示「此更新需要重新安装，以更新图标/组件」。见 docs/online-update.md §2.1。
- 空聊天也有「计算机」（DESIGN.md §79）：刚建好的机器人、或点了「新话题」还没发第一条消息时，右栏只有「面板」、没有「计算机」；现在和已有对话一样是「面板 | 计算机」两个标签（手机抽屉里也是）。计算机开着时发第一条消息，新对话里计算机继续开着。只改网页。
- Android 原生版（CB-068，DESIGN.md §80）：Android 客户端从网页外壳换成 Kotlin + Jetpack Compose 原生应用——登录（扫码绑定 / 账号密码）、机器人列表、聊天（流式回复、干活卡、短气泡、表格 / 代码 / 文档卡 / 图片 / 链接卡 / render_ui 卡片）、面板（只读）都是原生的，打开更快、滑动更顺；设置、管理、Claude Code 等还没做成原生的页面在应用里用网页打开，同一个登录。从旧版在线更新过来不用重新登录（同一个签名、同一份会话）。不改服务器。
- 文档卡 + 提示词第三版（Hark 第六轮，DESIGN.md §76）：长的总结、说明、学习笔记、调研结论不再是一个很长的气泡，而是一句结论 + 一张文档卡（标题、复制，正文是排好版的 Markdown；超过约 10 行先收起，点「展开全文」看全部，机器人边写边长时卡片高度不变）。草稿卡 / 文档卡上方的 Markdown 标题当卡片标题，不再塞进正文。机器人干活时两次工具之间不再写「我再核对一下」这类过程话，画了卡片后在卡片后面用一句结论收尾。只改网页和提示词。
- 干活卡在原位（Hark 第六轮，DESIGN.md §75）：机器人干活时那张「● 正在搜索…」卡片现在画在这一轮第一个干活的步骤那里，一直在原地——中间写一句过程话时不再消失又出现；点一下能看到已经做过的每一步；这一轮结束，同一个位置原地换成「✓ 搜索 2 次 · 看了 3 个网页 · 12 秒 ⌄」（高度不变，不跳），不再挂在回答下面那一排。「正在看有哪些技能」这类准备动作不再显示、不算步数。以表格 / 卡片收尾的回答，卡片前最后一句成为结果气泡，「我再核对一下」这类过程话收起。后台任务卡片不再露出「正在使用 skill_load」和 `**` 记号。只改网页。
- 电脑文件夹同步·PC 客户端（CB-064 P4b，PC 0.1.11，Windows）：ChisaBot PC 里「新建工作区 → 电脑上的文件夹」把一个文件夹传到云端，之后两边实时双向同步（自编译的 MIT 版 Mutagen 随客户端分发，经网关隧道，主机上没有新端口）；工作区「⋯ → 电脑同步」/ 对话头的同步药丸打开同步面板（开启、立即同步、交还云端、不同步的规则）；两边都改过的文件弹冲突对话框（用云端 / 用电脑 / 两份都留，挪走的那份进备份）；电脑上的 Git 仓库经同一条隧道同步提交（分叉不自动合并）。PC 正在使用时点「合入工作目录」会先和电脑交接（电脑先推上去再暂停，云端写完再拉回），电脑文件夹工作区的合入是「放进工作目录、不提交」。网页和手机只读，电脑离线时可以「强制收回到云端」。需要节点程序更新（重启 `chisabot-cloudnode` 重新下载 chisabot-node.cjs）；没有新表。旧 PC 客户端里这一项照旧灰掉。见 DESIGN.md §73.9、`docs/cloud-claude-code.md`「电脑文件夹同步（P4b）」。
- 电脑文件夹同步·服务器端（CB-064 P4a）：云端工作区可以和一台电脑的文件夹双向同步的底座——新边车容器 `cloudnode-sync`（`deploy/cloud-node/sync`：uid 1000 的 sshd 只听节点网络命名空间里的 127.0.0.1:2222、不发布端口，源码编译的 MIT 版 Mutagen 0.18.1 agent，gate 只放行同步 agent 和本工作区的 git）、电脑用设备令牌换一次性隧道票经网关 `/api/devices/agent/sync-tunnel` 进来、绑定 / 租约（谁能写工作目录）/ 交还 / 强制收回 / 撤销设备即收回、审计。新表 `chisabot_cc_sync_bindings`、`chisabot_cc_leases`、`chisabot_cc_sync_events`、`chisabot_cc_sync_conflicts`（开机建表，回滚镜像即可）。电脑端界面随下一个 PC 版本（P4b）；没有部署边车时什么都不变。部署者要重建 `chisabot-cloudnode` 并构建 `chisabot-cloudnode-sync`（见 `deploy/cloud-node/README.md`）。见 `docs/cloud-claude-code.md`「电脑文件夹同步（P4a）」。
- 「在云端完成登录」过得了 Cloudflare 人机验证（CB-066）：云端登录浏览器以前用无头 Chromium 默认的 UA（带 HeadlessChrome），claude.ai 一直停在「Verify you are human」，点了也过不去；现在用同版本普通 Chrome 的 UA、关掉 AutomationControlled，直接到 Claude 登录页。只改节点程序：节点重启（重新下载 chisabot-node.cjs）后生效，不用重建镜像。
- 云端 Claude Code GitHub 工作区（CB-063，P3）：Claude Code 左栏多了「新建工作区 · 从 GitHub」——选一个仓库（用 设置 → 账号连接 里已连的 GitHub 令牌），云端节点克隆它；每个会话在自己的工作树和 `cc/…` 分支上改，会话页多了「合入工作目录」（冲突时工作目录不动，可以「让 Claude 处理」）和「推送并开 PR」（确认卡：分支、提交、标题 → 推送 → PR 链接卡）；右栏多了「相对 main」「工作目录」两个视图；工作区可以删除。令牌只在克隆 / 推送那一次交给节点（临时 askpass，不落盘、不进日志）。新增 `CHISABOT_GITHUB_GIT_BASE`（可选，默认 https://github.com）。表只加列（回滚镜像即可）。见 DESIGN.md §73.7。
- 设备「打开」只做安全的打开（CB-030）：只能打开 http/https 网址，或允许的文件夹里已经存在的文件 / 文件夹；不再能启动程序、带参数、打开 .exe / .bat / .ps1 / .lnk 这类可执行文件和脚本、别的协议（`ms-settings:` 等）或网络路径——要运行程序走命令行能力和它的审批。服务器在发给电脑之前先检查，已装的旧版 PC 客户端也一样受保护；PC 客户端里同一套检查随下一个 PC 版本发布。能力名改成「打开网址 / 文件」。见 docs/pc-node.md §5。
- 只读工具的说法（CB-022）：机器人翻记忆、看 GitHub Issue / 文件、看页面 / 定时任务 / 面板 / 设备文件时，干活卡上写「正在翻记忆「护照」」「正在看 ChisaAlter/ChisaBot 的 Issue」这类中文，结束后的步骤清单里也列出来；这些读到的结果按规则不单独出卡（DESIGN.md §70.3）。顺带：记笔记不再写成「正在查记忆」，看面板不再写成「正在更新面板」。只改网页和后台任务卡片的说法。
- 页面卡 / 任务卡（CB-021、CB-023）：一轮里机器人把同一个页面做好又改两版，聊天里只留最后一版那一张卡（改的时候旧卡先留着，新版好了原地换）；后台任务卡在参数还在流时，先用任务名，没有任务名就用任务说明的头一句，都还没有时只写一行「正在安排后台任务…」，不再出笼统的「后台任务」。只改网页。见 DESIGN.md §54、§38.3。
- 在云端完成 Claude 登录 + Claude 上游代理（CB-066）：设置 → 云端工作区 多了「在云端完成登录」——云端节点容器里的无头浏览器打开 Claude 授权页，画面嵌在设置页里，你在里面登录、授权，节点自动拿到授权码完成登录；你的浏览器不访问 claude.com，登录和 Claude Code 用同一个出口（卡片上显示两边看到的 IP）。原来的粘贴授权码保留为备用。新增「Claude 上游代理」（http / https / socks5，可带用户名密码，测试连接显示出口 IP 和 claude.ai / api.anthropic.com 是否通）：只有 Claude 的域名走它，地址加密存在保险箱（保留名 `claude-proxy`）。需要重建云端节点镜像（`deploy/cloud-node` 现在装 Chromium）；旧镜像只显示粘贴授权码。见 DESIGN.md §73.8。
- 切暗色 / 亮色不再卡（CB-024）：天空背景只在「背景随时间变化」开关、拖预览时间时才淡变；切主题和每分钟的天色变化一帧换好。以前天空淡变 1.6 秒，期间所有毛玻璃逐帧重新模糊（切一次约 1.9 秒光栅化），现在约 0.2 秒，0.5 秒内画面停稳。外观不变。只改网页。见 DESIGN.md §7.4。
- 云端 Claude Code 标签页（CB-062，P2）：管理员的左栏最上面多了「机器人｜Claude Code」切换（记住选择）。Claude Code 那边是工作区 → 会话（先只有内置「草稿」），会话页是和 Claude Code 的对话：流式回答、接着上次（`--resume`）、「新的 Claude 会话」清上下文、停止、回答中再发一条排队、刷新后接着看；`npm test` 这类命令弹审批卡（允许 / 本会话总是允许 / 拒绝，2 分钟没人处理按拒绝），`git push` 一律拒绝；右栏看这一轮的改动 diff 和会话目录的只读文件，手机上是底部抽屉。只在部署了云端工作区节点、登录了 Claude 时可用。`deploy/cloud-node` 多了可选的 `CLOUDNODE_DNS`（主机上只劫持 Claude 域名的 DNS，`firewall.sh` 同时放行）。见 DESIGN.md §73.2–§73.6。
- 云端工作区 + Claude 登录（CB-061，P1）：新的手工部署容器 `deploy/cloud-node/`（Claude Code CLI + chisabot-node，非 root、根文件系统只读、没有 docker.sock、不发布端口，`firewall.sh` 只放公网），配对后在 设置 → 管理 → **云端工作区** 用自己的 Claude 订阅登录（打开授权页 → 粘授权码），授权码只经过节点上的登录进程，不进数据库和日志；云端工作区不能开完全访问。服务器新增 `/api/cloud-workspace/*`、`/api/claude-code/*` 和表 `chisabot_cloud_workspaces`、`chisabot_cc_*`（开机建表，回滚镜像即可）。没部署节点时什么都不变。见 `docs/cloud-claude-code.md`、ADR-0014、DESIGN.md §73.1。
- 商品 / 地点推荐用带图的卡片网格（CB-050）：机器人推荐、比较商品（或餐厅、酒店、景点）时先查现价和商品页，再画成一排卡片——图、名字、价格、一句卖点、角标、来源站点，整张点开商品页。图由服务器从商品图地址或商品页的 og:image 转存（和链接卡同一套检查与缓存），浏览器不直连第三方；图位固定，图晚到不改高度，取不到图时是名字首字的色块。面板里也能用（算一个大块，最多 4 个）。很长的对话打开时，历史晚到补在上面时画面保持在底部（CB-047）。干活卡不再显示「正在使用 skill_load」这类工具名。只改网页和提示词。见 DESIGN.md §72。
- 设置左栏在笔记本上不用滚（CB-058）：个人 / 管理 / 高级三组都能收起，默认只展开当前页所在的那组（在管理页就展开「管理」），点开过的会记住；屏幕矮（≤ 820px）时行高收紧一点。1280×800 / 1366×768 上展开的那组一眼看全。手机抽屉不变。只改网页。见 DESIGN.md §71.7。
- 管理页说中文（CB-056 / CB-057）：插件目录的说明（Parallel Search、Google Drive、Notion、事件触发）、权限规则三条快捷规则的说明、活动记录的表头 / 筛选 / 事件名 / 结果都改成中文（原始事件类型悬停可见）；手机上活动记录一条一张小卡，不再截掉右边几列。只改网页。见 DESIGN.md §71.6。
- 瘦身 P4c-1：上游 Routines 并入定时任务——机器人的 `create_routine` 等四个工具、`/api/routines`、`/internal/routines/run` 和容器里每分钟的 routines 扫描、`server/scripts/fire-routines.ts`、`deploy/legacy-zh-routines.*` 都删掉，`WORKER_SHARED_SECRET` / `CHISABOT_ROUTINES_WORKER` 不再读（`.env` 里留着也无害）。定时只剩 设置 → 定时任务（§55），`/routines` 照旧跳过去。机器人资料「动态」和重置 / 删除机器人的提示改读定时任务（重置会取消这个机器人为你设的任务）。生产没有 routines 数据；表不动，回滚镜像即可。见 `docs/slimming.md`。
- 干活卡结束后收成一行（CB-049 第二步）：机器人这一轮搜过、开过网页，回答下面（复制 / 重新生成那一排，一直看得见）多一行「搜索 2 次 · 看了 3 个网页 · 12 秒 ⌄」，点开列出每一步；只画了卡片的轮次不出。放在回答下面而不是上面，回答结束那一刻画面不跳。用时只在当场看着它干完时显示，从历史打开的对话只写次数。提示词再收一轮：不写「刚搜了一圈没翻到…」「这部分是我凭自己知识整理的」这类免责段，凭知识回答只在结论里带半句「以官网为准」；画了卡片后文字只留一句结论。去掉 41 条已经没人用的语音翻译。只改网页和提示词。见 DESIGN.md §69.3、§70.2。
- 干活卡（CB-049）：机器人一轮里开始搜索、开网页、写文件时，「思考中」那颗胶囊换成一行「● 正在搜索「iPhone 17 Pro 国行价格」 · 第 3 步 · 12 秒」，当前步骤原地换字；同一个位置、同样一行高，不改滚动。说法和后台任务卡片同一份。打开「调试：显示工具调用」时照旧显示每一行工具。只改网页。见 DESIGN.md §70。
- 对话像发短信（CB-048）：机器人一条回复按段画成几个短气泡，一个接一个淡入（短段贴着文字宽，表格 / 代码 / 清单 / 草稿整列宽）；要发出去的微信、邮件画成一张可一键复制的「草稿卡」；回答过程中补充的话被回应时，气泡顶上有一行回复引用；代码块的语言名和复制 / 下载在同一行、不再套在气泡里。提示词第二版：先给答案、一段一个意思、不提工具名、不说「我刚查了」，来源放最后一行；机器人用自己的名字自我介绍，不再说「我是 Muse Spark」。只改网页和提示词。见 DESIGN.md §69。
- 成熟度 3（非聊天页面，CB-051…CB-055）：账号菜单「待处理」改成真正的待处理——只列聊天里没点的确认卡片、要你亲自完成的操作、机器人在等你回答的问题（带机器人名字，参数折叠），没有了就一张「没有等你处理的事」；上游的开关和规则表（英文 allow / Target、「ChisaBot 桌面应用」）去掉，偏好只在 设置 → 审批偏好；菜单上的数也算上没点的确认卡片。手机上设备「完全访问」的时长按钮不再一个字一行。打开已删除的机器人 / 对话不再是一行红字，而是错误卡 + 「看我的机器人 / 回到聊天」；不存在的连接器页不显示原始 key。账号连接页空状态、残留的「AI 同事」改成人话；机器人资料页的「部署默认」显示模型名字。只改网页，接口和表不动。见 DESIGN.md §71。
- 删掉实时语音通话（CB-046 第 2 步）：输入框的波形按钮、悬浮通话窗、「语音聊天」卡片和服务端 `/api/voice/*` 都去掉，`VOICE_*` 环境变量不再读，`/api/capabilities` 不再返回 `voice`。本部署从没配过语音，界面不变；语音听写（`TRANSCRIPTION_*`）不受影响。`voice_sessions` 表不动（旧数据留着），回滚镜像即可。见 DESIGN.md §68.7。
- 只有一套聊天（CB-046）：机器人聊天只剩左栏点机器人进的频道聊天。旧地址 `/bot?agent=…(&thread=…)`、定时任务通知的「查看」、设置 → 定时任务的「打开对话」都直接打开那段对话的频道聊天（旧对话第一次打开时给它建一个频道，同一条对话、不复制消息）。原来只有旧聊天页才有的都搬过来了：确认卡片、定时任务 / 后台任务 / 本地 agent 的结果行、「确认后接着做」、备用模型小字、回答期间发消息（已排队 → 已读取）、右栏面板「问一句」、机器人「⋯」菜单里的「历史对话」。频道聊天里机器人现在也能委派后台任务、设定时任务、交给本地 agent（以前频道对话被当成群聊，没有这些工具；多机器人群聊仍然没有）。频道聊天上传的文件也存进机器人工作区 `uploads/`，机器人改图、找最近的文件都能用。旧聊天页的代码删掉（约 2,000 行）。没有表结构变化，回滚镜像即可。见 DESIGN.md §68、ADR-0013。
- 瘦身 P6-4（依赖变动，部署走完整构建）：去掉上游桌面端留下的服务端部分——Better Auth `electron` 插件与 `/api/auth/desktop`（依赖 `@better-auth/electron`）、组织登录（`旧组织认证地址变量`，现在设了服务器会拒绝启动）、原生文件夹代理 `/api/host-access/*` 与 `host_*` 工具（管理 → 云端浏览器 里的「文件夹」区块随之去掉）。`.env.example` 不再列 OpenTag / Twilio / Expo 变量（P4b-2 起就不读了）。ChisaBot 的电脑访问一直走 设置 → 设备（PC 节点），行为不变。见 `docs/slimming.md`。
- 瘦身 P6-3（依赖变动，部署走完整构建）：删掉 `worker/`（上游 Intelligence 工作进程，生产 `local` 模式从不运行）、`scripts/setup-learning.ts` / `scripts/self-hosted-learning.ts` 与 `docs/automatic-learning.md`；依赖去掉 `@better-auth/sso`、`@better-auth/scim`、`@better-auth/expo`（原生 Expo 客户端早已删除，`EXPO_PROJECT_ID` 不再读）和 4 个 `@opentelemetry/*`（审计 OTel 导出 P6-1 已删）。`bun.lock` 重新生成。行为不变。见 `docs/slimming.md`。
- 朋友账号先隐藏（多用户以后再做）：设置 → 管理 →「账号」入口默认不显示，部署设 `CHISABOT_ACCOUNTS_UI=1` 才出现（`/api/capabilities` 多了 `accountsUi`）；登录网关 `config.json` 新增 `invites`（默认关）：关着时不能发邀请、不能直接建账号，未用的邀请链接失效，已有账号照常登录。网关多账号、签名身份、按人隔离都保留。**升级网关**：换 `deploy/public/auth/server.ts` 后重启登录服务；想继续邀请就在 `config.json` 加 `"invites": true`。（撤回了 #130 的删除。）
- 瘦身 P6-2：去掉 Better Auth 的 SSO / SCIM 插件和 `/api/auth/*` 里的公司身份提供者分支（`/api/auth/sso/*`、`/api/auth/scim/*`、SSO 配置加密、身份提供者表的读写）；登录页的「用公司邮箱登录」框去掉。`SSO_*` / `SCIM_*` 等环境变量不再读；审计类型 `identity_provider.*`、`session.break_glass`、`person.*provisioned` 不再写入（旧记录照常显示）。生产一直没配 SSO，登录只走网关，行为不变；表不动。见 `docs/slimming.md`。
- 瘦身 P6-1：去掉上游「企业控制」——每个请求前的能力开关闸门、模型允许名单（以及每轮写一行的 `model_usage`）、电脑网络策略 / MCP 允许名单覆盖层、长期不用的电脑自动停止、动作录制、离职（offboard）、审计 OpenTelemetry 导出（`OTEL_*` 不再读），以及 `/api/admin/enterprise/*`、`/api/admin/people/*`（朋友账号在 设置 → 管理 → 账号 管理，角色来自网关签名身份；该入口目前默认隐藏）。权限照旧由每个接口自己判断（本人 / 主人 / 管理员）；默认模型、备用模型（`enterprise_settings` 里的 `model_connection` / `model_fallbacks` 两行）照常读写；机器人电脑照旧收到「全部放行」的网络策略。表和旧数据不动。见 `docs/slimming.md`。
- 朋友账号（多账号，CB-040）：设置 → 管理 → **账号** 可以「邀请朋友」——生成一次性链接（1 / 3 / 7 天），朋友打开后自己设账号名和密码，直接进入自己的「助手」；管理员可以重置密码（发 24 小时链接）、停用（立刻退出所有设备）、删除。每个账号的机器人、对话、记忆、技能、密钥、GitHub、页面、定时任务、文件、设备、IM 都是分开的，朋友进不了管理页和 Magpie。设备只归主人：管理员也不能操作朋友的电脑，机器人的设备工具只看自己主人的设备；管理员的聊天列表不再出现别人的私有机器人。原管理员账号、数据和已登录的网页 / PC / 手机不受影响。**升级网关**：登录服务 `deploy/public/auth/server.ts` + `auth-web/login.*` + nginx 新模板（`X-ChisaBot-Identity`），`config.json` 加 `identitySecret`、应用 `.env` 加同值的 `CHISABOT_GATEWAY_SECRET` 才开启；不配置时和以前一样只有一个账号。见 `docs/accounts.md`、ADR-0011、DESIGN.md §64。
- 本地 agent 与权限档位（0.1.9）：① 机器人可以把一整件活儿交给你电脑上的 agent——Claude Code、Codex CLI、OpenCode / Gemini CLI / Aider（检测到装了才有），或 ChisaBot 内置循环（不用装，默认用机器人的模型、由服务器代调，也可以配本机模型）。在聊天里说「用 Claude Code 在我电脑上修这个 bug」，出一张任务卡片：实时输出、停止、改了哪些文件；默认在一次性 git worktree / 临时副本里做，你点「应用改动」才合回原文件夹，结果回到同一段对话。默认路径不变：什么都不装，云端机器人照样用 `device_*` 操作电脑。② **权限档位**（设置 → 设备 → 某台电脑 → 本地 agent）：只读 / 工作区 / 完全访问。档位只收紧——档位之外的操作，能力是「允许」也先出审批卡片（摘要写明档位）；「完全访问」就是 0.1.8 的完全访问开关（有时限，到期回到原档位）。任务可以要求更严的档位，不能更宽；只有你能改档位。③ 隔离与网络：git worktree（默认）、临时副本、bubblewrap（Linux）、macOS 沙盒、Docker / Podman（内置 agent）、WSL，按电脑上检测到的列出；可以断网。Claude Code 只在完全访问或系统级沙盒里跳过它自己的确认（root 下自动加 `IS_SANDBOX=1`）。CLI agent 用它自己登录的账号，ChisaBot 不碰凭据。新表 `chisabot_device_agent_settings`、`chisabot_local_agent_tasks`（开机建表，可回滚）。服务器 + 网页 + PC 0.1.9（服务器节点 chisabot-node 重新运行安装命令即可；旧客户端设置页显示「还没检测过」）。见 DESIGN.md §66、`docs/local-agents.md`、ADR-0010。
- 重新生成 / 编辑后重发：最后一条回答下面多了「重新生成」，自己发的消息下面多了「编辑」（点了原地改，发送后这条之后的对话换成新的回答，附件保留）。频道聊天和机器人聊天都有，回答进行中不显示。服务器真的截断对话（消息、回放事件、那几轮的运行记录），刷新、手机和电脑上看到的都一样；截掉那几轮里还在等的确认卡片作废、还在跑的后台任务停掉；还没收到截断的旧标签页再发消息也不会把截掉的内容带回来。新表 `chisabot_thread_truncations`（开机建表，可直接回滚）。服务器 + 网页。见 DESIGN.md §67。
- 手机上聊天里的页面卡片恢复「打开」按钮（窄屏只显示外链图标，以前整个藏掉，只剩缩略图能点）。见 DESIGN.md §54。
- 频道聊天不再丢正在写的回答（P0）：回答写到一半刷新页面、手机切后台再回来、网络抖一下，回来后接着一个字一个字往下写（服务器其实一直在写，只是页面没再接上）；回答中刷新后「停止」照样能用。同一段频道对话在手机和电脑上同时打开，一边发的另一边约 2 秒出现，回答两边同步流式。只改网页。见 DESIGN.md §64。
- 瘦身 P4b-3：去掉上游的自动学习（`/api/admin/learning`、学习设置、学到的技能注入；只在 Intelligence 模式下生效，本部署一直没用）、身份提供者管理接口（`/api/admin/identity-providers`）、每个机器人一台电脑的 Docker supervisor 配置（`COMPUTER_SUPERVISOR_URL` 不再读，机器人共用 `AGENT_COMPUTER_URL`）。表和旧数据不动。企业控制闸门、SSO/SCIM、语音暂留，原因见 `docs/slimming.md`。
- 瘦身 P4b-2：去掉上游的推送与可达性（Slack / Teams / 短信 / 手机推送，`/api/delivery*`）、群聊接口（`/api/groups`）、团队机器人接口（`/api/team-bots`）；机器人之间交接默认关闭（`BOT_HANDOFF_MAX_DEPTH` 默认 `0`，设 `1` 恢复）。旧的多机器人对话打开时显示「已不再支持」。网页里的群聊链接、团队机器人同意卡片、外部机器人回调令牌面板一并去掉。表和旧数据不动。见 `docs/slimming.md`。
- 成熟度 2（新朋友第一次用）：① 新建机器人只有名称必填，职责 / 提示词可以不填（提交时补一句基本说明，之后在资料页改）。② 机器人的空聊天多了 4 个「试试这样问」，点一下就发。③ 手机上建好机器人后左栏抽屉自动收起。④ 「AI 同事」等机翻文案改成「机器人」。⑤ 模型回答到一半断开时，出错卡片说中文（以前是 `AI SDK stream error`）。只改网页。见 DESIGN.md §63。
- 瘦身 P4b-1：服务器不再加载上游的演示录制（`/api/demonstrations`）、上游个人记忆（`/api/memory` 和每分钟的记忆同步）、主动研究（`/api/proactive`）、意图路由（`POST /api/route`）。长期记忆（设置 → 记忆）不受影响。表和旧数据不动，回滚镜像即可恢复。见 `docs/slimming.md`。
- 备用模型：设置 → 模型 新增「备用模型」，管理员排好顺序（最多 8 个），主模型额度用完（429 / 402 / quota）或模型服务 5xx / 过载时按这个顺序换下一个（以前只能自动挑同平台的模型，或改环境变量）；换过模型的那一轮，对话末尾有一行淡色小字「主模型额度用完，已改用 X」，刷新后还在。管理员自检（`/api/admin/smoke`、`smoke.sh`）也走同一套回退：主模型用不了但备用模型答上了算通过，结果里 `fallback` 写明换成了谁——部署不再因为免费额度用完而误回滚。设置存在 `enterprise_settings`（`model_fallbacks`，不新建表，可回滚）。服务器 + 网页。见 DESIGN.md §61、`docs/models.md`。
- 瘦身 P3：仓库里删掉不进任何发布物的上游目录（Tauri 桌面端、Expo 移动端、13 个外部框架适配器、Helm chart、SPIRE、supervisor、多余示例、上游笔记本全栈脚本与 docker-compose、上游 CI / 桌面签名 / 镜像发布流程）。服务端镜像、PC、Android 不受影响，部署行为不变。CI「ChisaBot checks」改成和镜像一样的 hoisted 安装，server typecheck 终于是绿的。见 `docs/slimming.md`。
- 瘦身 P4a：已经隐藏 / 重定向的上游页面代码删掉（人员与角色、企业控制、身份提供者、自动学习、组件游乐场、组件库、旧管理员设备页、群聊），旧地址仍然跳到新位置；机器人设置窗去掉「交接」「例行任务」两栏，接管窗口去掉「录制成工作流…」。只改网页，数据不动。见 `docs/slimming.md`。
- 生图 / 识图模型：设置 → 图片生成 并入 设置 → 模型 的「生图模型」（原配置不动，旧地址自动跳转），旁边新增「识图模型」：默认「跟随主模型」（图片直接给聊天模型），也可以选一个 OpenAI 兼容的看图模型——选了以后上传的图片先由它写详细描述和图中文字（按文件缓存，只描述一次），再交给聊天模型，机器人还能用 `image_inspect` 追问细节；聊天模型在模型目录里标明不能看图时自动用识图模型。每个人可以在 设置 → 生图与识图 换成自己的接口 / 密钥 / 模型（不设就用管理员的默认）。密钥加密、只显示末四位；普通用户只能填公网接口。新表 `chisabot_media_models`、`chisabot_image_descriptions`（开机建表，可回滚）。见 DESIGN.md §59、`docs/chat-files.md`。
- 成熟度 1：① 模型额度用完（429 / 402 / 「Daily free limit」）时自动换同平台的其它模型重发，被拒的模型冷却到它说的恢复时间，期间不再白等——以前默认免费模型额度一用完，每个机器人每句话都要转圈到两分钟再报英文错，一整天不可用。`CHISABOT_MODEL_FALLBACKS` 指定候选（`off` 关闭）。② 一轮出错的提示翻成中文并告诉你下一步（额度、限流、密钥、超时、上下文太长…）。③ 代码块和表格工具栏的提示改成中文。④ 模型把工具调用写成正文 `<tool_call>…` 时收进「思考」并说明没有执行。⑤ **升级网关**：部署 / 重启时不再是 nginx 白底 502（和乱码的「退出登录」），换成「ChisaBot 正在更新」等待页，好了自动回到原页面（新模板 `deploy/public/nginx.conf` + `auth-web/updating.*`）。服务器 + 网页 + 网关。见 DESIGN.md §60。
- 瘦身 P2：示例部署包 `examples/zh-CN` 不再自带机器人和频道（每人第一次进来自动得到私有的「助手」），共享技能只留两个与连接器无关的。服务启动时清理部署包里已不声明的包技能、从没用过的包频道和授给已删除机器人的授权（`CHISABOT_ORPHAN_SWEEP=0` 关掉）；删机器人时一并收回它的授权。用户自己的技能、用过的频道不动。升级前建议 `pg_dump` 这几张表（skills、skill_tools、plugin_grants、channels、channel_agents）。只改服务器。见 `docs/slimming.md`。
- 导航收敛（瘦身 P1）：顶栏只剩字标、左栏开关和窗口按钮；左栏只有搜索和机器人；账号菜单 = 个人资料 · 设置 · 定时任务 · 待处理 · 绑定手机 · 暗色 · 退出；设置左栏分「个人 / 管理 / 高级」。凭据并入「模型密钥」，技能管理并入 设置 → 技能，审计改名「活动记录」；右栏不再显示上游旧面板系统（数据保留）。旧地址（`/agents`、`/team-bots`、`/memory`、`/reachability`、`/responsibilities`、`/routines`、`/skills`、`/settings/passwords`）自动跳到新位置。只改网页。见 DESIGN.md §57。
- 聊天文件与图片生成：机器人聊天可以用 ＋、拖拽、粘贴上传文件（单个 ≤ 20 MB），存进机器人工作区；文件卡显示图片缩略图、PDF 可预览；机器人能把工作区文件交给你（`file_share`）、画图和改图。图片生成由管理员在 设置 → 图片生成 打开（默认关；支持 MiniMax image-01 等，「改图」在 MiniMax 上是以原图为参考重画）。新表 `chisabot_chat_files`、`chisabot_image_settings`（开机建表，可回滚）。见 DESIGN.md §56、`docs/chat-files.md`。
- 定时任务与提醒：在任何对话里说「明早 9 点提醒我…」「每个工作日 18:00 帮我…」，到点机器人回到那段对话里做；忙的时候排进当前回合。时间默认北京时间。周期任务停机晚了 >30 分钟跳过，一次性提醒 ≤6 小时照发并注明。多容器不会重复触发。网页右下角提示 + 浏览器通知；设置 → 定时任务 管理。IM 里设的任务把结果推回 IM（QQ 官方、企业微信受平台被动回复时间窗限制）。新表 `chisabot_schedules`、`chisabot_schedule_runs`；`CHISABOT_SCHEDULES_SWEEP=0` 关掉。见 DESIGN.md §55、`docs/schedules.md`。
- 页面：机器人能把行程、邀请函、报告做成单页网页，发一个不公开列出的链接 `/p/<随机串>/`，别人不用登录就能看；页面在 CSP sandbox 里运行，读不到 ChisaBot 的登录和接口。每次改动存一版（保留 50 版），设置 → 页面 可恢复、下线、删除。**升级网关**：公网 nginx 需要新模板里的 `location ^~ /p/` 规则（不转发 Cookie）。新表 `chisabot_pages` 等 4 张。见 DESIGN.md §54、`docs/pages.md`。
- GitHub 账号连接：设置 → 账号连接（原「账号与密码」）顶部可以贴一个 GitHub 令牌（推荐 fine-grained）。机器人能读你的仓库、issue、PR 和文件；建 issue、评论、开 PR 前在聊天里出确认卡片，你点「允许」服务器才发请求。令牌存在密钥保险箱里，机器人看不到。`CHISABOT_GITHUB_API_BASE` 可指向 GitHub Enterprise。见 DESIGN.md §53、`docs/github.md`。
- 密钥保险箱：设置 → 密钥 存 API 密钥 / 令牌，值用 `KEY_ENCRYPTION_KEY` 加密、只显示末四位。机器人需要时在聊天里出安全输入卡片（值直接交给服务器），调用接口时用 `{{secret:名字}}`，服务器只把它发往绑定的域名，模型、聊天记录和日志里都看不到值。见 DESIGN.md §52、`docs/vault.md`。
- 技能：设置 → 技能 存「某类事怎么做」，你的所有机器人按需加载，也能在输入框 `/名字` 调用；机器人可以在你同意后帮你存技能。和上游技能表是同一份。见 DESIGN.md §51、`docs/skills.md`。
- 长期记忆：机器人跨对话记住你本人、偏好（带情境）、身边的人、地方、在做的事和每天的日志，你的所有机器人共用；能搜、能改、能真删。设置 → 记忆 查看和编辑，可按机器人关掉。上游 personal memory 工具不再给机器人。新表 `chisabot_memory_notes`、`chisabot_memory_bots`。见 DESIGN.md §50、`docs/memory.md`。
- IM 接入：设置 → IM 接入 把机器人接到飞书 / Lark、QQ 官方机器人、QQ 个人号（OneBot 11，非官方有封号风险）、企业微信智能机器人、个人微信（扫码）、钉钉、Telegram。私聊都回，群里只回 @ 和回复；`/new` 开新话题。IM 回合只给文字类工具，电脑和设备默认不开。凭据加密保存，每个连接有测试和最近 100 条日志。**升级网关**：OneBot 反向 WebSocket 需要新模板里的 `/api/im/onebot/` 规则。`CHISABOT_IM=0` 关掉。见 DESIGN.md §49、`docs/im.md`。
- 云端机器人能真正管理你的每台设备、在上面写代码（0.1.8）：① 编码工具——`device_search`（像 ripgrep 一样按内容 / 文件名搜，带行号）、按行读大文件、`device_edit_file`（精确替换，对不上或不唯一就整个不改，返回 diff，改前备份——git 仓库里备份放在 `.git/chisabot-backups/`，不会出现在 `git status`）、`device_apply_patch`（unified diff，多文件、全部校验后才写）、`device_git`（只读子命令只要「读取文件」，提交等要「命令行」，push 每次都要你批准）、后台命令（构建、测试、开发服务器：启动后随时看输出、结束）、持久命令行会话（cd / 环境变量保留）、进程列表 / 结束、云端工作区和设备之间传文件。审批卡片（聊天里的确认卡片、设置 → 设备、PC 弹窗）直接显示着色的 diff。机器人按「搜索 → 读 → 改 → 跑测试 → 汇报 diff」的方式干活，不再整文件贴进聊天。② **完全访问**：设置 → 设备 → 某台设备 → 权限，可以为它打开 1 小时 / 24 小时 / 永久的完全访问——像本机装了一个智能体：不再逐次询问、不限文件夹（整台电脑）、命令不限 10 分钟、可以用管理员身份运行（Windows 弹一次 UAC；Linux / macOS 需要 root 或免密 sudo）。只能你自己在网页上打开，PC 上还要本机确认一次；所有操作照常记录；紧急停止（网页、PC 托盘、手机）立即关闭它。③ **服务器节点 chisabot-node**：设置 → 设备 → 添加一台服务器，复制一行命令到 Linux / macOS 服务器上运行，自动装好 Node.js、登记到你的账号、注册成 systemd / launchd 服务，断线自动重连。④ 设置 → 设备按 电脑 / 服务器 / 手机 分组，设备页新增「运行中」（后台命令可直接结束 + 最近的改动 diff）。⑤ 「打开应用 / 网址」能带参数启动任意程序，改为高风险能力（PC 开着「高风险操作始终在本机确认」时本机再问一次，CB-030）。⑥ 修复：完全访问的到期时间以前读不回来（显示一直是关）。数据库 devices 加一列 full_access_until（启动时自动加，旧版本忽略，可直接回滚）。服务器 + 网页 + PC 0.1.8（PC 要更新到 0.1.8 才有新工具；旧客户端的机器人会被告知需要更新）。见 docs/pc-node.md §12–§14、DESIGN.md §62。

- 聊天里的链接卡改版（像 Hark）：机器人把要你点开的链接单独放一行时，正文后面出一张紧凑卡片——站点图标或缩略图、页面标题、域名，`[下载 0.1.7](网址)` 这种写法的标签也显示在卡上；整张可点，新标签页 / PC 和安卓客户端里用系统浏览器打开，悬停轻微上浮。句子里的链接、来源列表不再出卡；那一行网址不再和卡片重复显示。网页取不到时也有「图标 + 域名 / 文件名」的兜底卡（以前卡片直接消失）。流式输出时不再拿半截网址去取预览，卡片位置先放同尺寸骨架，不跳版。机器人提示词加了什么时候用链接卡。没有 og:image 时的截图默认关闭（`CHISABOT_LINK_PREVIEW_SHOTS=1` 打开）。只改服务器和网页，PC / Android 不用更新。见 DESIGN.md §48。
- 机器人资料页重做，更简洁：页头一行就是头像、名字和「模型 · 运行中/已暂停」，右边直接是「开始聊天 / 编辑 / 删除」；下面只有「资料」（名称、职责、提示词，点编辑就地修改、一次保存）和「运行」（模型、暂停、通知）两张卡，有任务时才出现「任务」。去掉了重复的说明、空的任务分区、整宽的「已暂停」按钮和英文残留。「更新发到哪里」（推送 / Slack / Teams / 短信）挪到「通知」页。只改网页。见 DESIGN.md §47。
- 新建机器人改成一步：只填名称、职责和提示词，全部从空白开始，不再有「报销助手 / 财务」之类的示例；去掉「谁可以看到它」和「它在哪里运行」两步——机器人一律私有、一律在服务器上运行。服务器也强制私有：以前设成公开的自建机器人自动改为私有（迁移 0058，什么都不删；部署包自带的机器人不变）。输入框选中时不再有蓝色描边和光圈（只是描边略深、底色更实），按钮等的键盘焦点环改为中性墨色。只改服务器和网页；PC / 安卓自带登录页的同样改动随下一次客户端发版。见 DESIGN.md §46。

## 0.1.7（2026-10-14）

- 修复「桌面端不能操作本地电脑」：① 新关联的电脑能力默认改为「询问」（以前全部「关闭」，不进 设置 → 设备 → 权限 手动打开，机器人就什么都做不了）。现在直接让机器人截图、打开网址、跑命令、读写文件，电脑上和网页 / 手机上会弹出审批，批准后执行；命令行、写文件、鼠标键盘仍要在电脑本机再确认一次。② 已关联、能力还停在旧出厂值「全部关闭」且从没被人改过的电脑，服务器启动时自动改成「询问」并在操作记录里写一条（自己关掉过的不动；CHISABOT_DEVICE_ASK_DEFAULTS=0 关掉）。③ PC 0.1.7 首次连接时把桌面、文档、下载设为默认「允许的文件夹」（只在文件夹列表为空且没人改过时）。④ 在 ChisaBot PC 里，节点离线 15 秒以上、电脑还没登记、或装的是版本号归正前的 0.2.x 旧版（它永远不会自动更新到 0.1.x）时，聊天顶栏下面出现提示：「重新连接」/「登记」/「需要重新安装」+ 三步说明。⑤ 机器人提示词说明「询问」能直接调用、用户会看到审批。见 DESIGN.md §45、docs/pc-node.md §5。服务器 + 网页 + PC；0.2.x 旧版 PC 必须手动卸载后安装 0.1.7。

- 修复：模型如果把推理写在正文里、用 `<think>…</think>` 包着（部分 OpenAI 兼容模型会这样），现在也放进可折叠的「思考」里，不再出现在回复气泡、历史和复制内容中。没有这种标签的模型不受影响。只改服务器。见 DESIGN.md §44.1。
- 修复：机器人的英文「思考过程」不再混进聊天正文。收起的「思考了 N 秒」以前只是视觉上折叠，英文其实一直在页面里——Ctrl+F 搜得到、全选复制会夹在回答中间、读屏会念出来；现在收起时内容不在页面里，点开才显示。删除机器人时连带删除它右栏的面板并停止它们的定时刷新（以前面板行留着、到点还会刷新）；以前删机器人留下的孤儿面板在服务启动时自动清掉。只改服务器和网页，PC / Android 不用更新。见 DESIGN.md §44。
- 打开弹窗 / 抽屉更跟手：打开动画期间先不做毛玻璃，动画结束再加上（以前每一帧都要重新模糊整块背景）。4× CPU 下点击到第一帧普遍快 10–50ms、动画帧率 +3–6fps。外观不变。见 DESIGN.md §37.2。只改网页。
- 修复（全端同步上线后的回归）：一轮发送失败（上游 / 网络出错）后约 1 秒，刚发的那条消息被同步删掉，整段聊天记录往回跳一截。现在失败的那条留在本机照旧显示，同步只在两台设备的消息先后真的不一致时才重排。首屏也更轻：去掉三个从不执行的库（加载的 JS 4.00→3.43 MB）。见 DESIGN.md §42.7、§41.4。只改网页。
- 面板更靠得住（生产实测机器人自建面板全流程后修复）：① 可以让面板每天固定时刻刷新——说「每天早上 8 点刷新」，机器人会设成每天 08:00（北京时间，可指定别的时区），卡片底部显示「每天 08:00 刷新」，⋯ 菜单里可改回按间隔；以前只能「建好后每 24 小时」。② 在「计算机」里点「交还」后，因接管被推迟的面板立即重刷，不再挂着「计算机正由你接管」等 5 分钟。③ 本机命令取数的面板，「来源」不再是一个点不开的假链接（如 workspace.local），只显示名字。④ 机器人修面板时验证刷新不再连跑两三遍后台刷新。数据库加一列 live_panels.refresh_at（自动迁移，旧版本忽略它，可直接回滚）。只改服务器和网页，PC / Android 不用更新。见 DESIGN.md §43。
- 全端同步：同一个机器人在网页、装成应用的网页版、ChisaBot PC、安卓客户端上打开的是同一段对话，历史完整。一台设备上发的消息、正在流式输出的回答、排队消息和后台任务卡片，几秒内出现在其它开着的设备上（页面在前台时每 2 秒同步一次，切回前台立即同步）；在任一设备点「新对话」，所有设备一起换。第一次打开时沿用这台浏览器原来的对话，任何旧对话都不会被删除。机器人 ⋯ 菜单新增「历史对话」，可切回以前的对话。见 DESIGN.md §42。只改服务器和网页，PC / Android 客户端不用更新。
- 更跟手：点按钮、开关菜单、复制、发送、切右栏标签时不再卡一下。以前几乎每次点击都会让浏览器把整个界面（约 4000 个元素）的样式重算一两遍（4× CPU 降速下每次 130–230ms）；现在只重算点到的那一小块，打开菜单 / 弹窗也不再锁整页滚动、重排整页。界面外观不变。只改服务器网页，PC / Android 不用更新。见 DESIGN.md §41。
- 修复（后台任务 / 并发实测的收尾）：① 输入框底色更实，滚到它下面的消息不再透出来和占位符叠在一起（窄屏暗色最明显）。② 在任务卡片上点「停止」后，对话里会补一行「后台任务「x」已停止」，机器人一句话确认，之前那句「做完会把结果发到这里」不再悬着。③ 新任务卡片一出来就显示第一步（不再「正在准备 / 步骤 0/n」干等几秒）；同时有 2 个以上任务在跑时，卡片默认收成一行，点开看清单和按钮。④ 删除机器人时连带删除它的后台任务记录、隐藏的任务对话和排队消息，删之前先停掉它还在跑的任务；以前删机器人留下的这些孤儿记录在服务启动时自动清掉。⑤ 打开新对话时浏览器控制台不再报三条 404。⑥ 系统更新里的「自检」改成问模型一道随机加法题、有回复就算通过：以前让模型「原样回口令」，有的模型（Mimo）会当成提示注入拒绝，自检时好时坏。只改服务器和网页，PC / Android 不用更新。见 DESIGN.md §25、§38.3，`docs/admin-smoke.md`。

- 修复：右栏「计算机」标签带上琥珀色「需要你」圆点时文字被挤成「计算 / 机」两行。现在标签不换行，圆点是显示器图标上的角标。见 DESIGN.md §39。
- 修复：在右栏「计算机」里接管浏览器后，机器人跑本机命令的面板（如「服务器性能」）每次刷新都失败并显示英文报错；让机器人修，它说一句「我先把面板救回来」就没下文了。现在：聊天里碰到「你正接管着」，机器人会把话说完，告诉你去「计算机」点「交还」；面板卡片写明「计算机正由你接管…交还后几分钟内会自动刷新」，不算失败、5 分钟后自动重试；机器人修面板后必须真跑一次刷新（新工具 panel_refresh）确认成功才说修好了。部署 / 重启时有人正在接管，也不再把机器人永久卡在「有人在控制」。见 DESIGN.md §39。只改服务器和网页，PC / Android 不用更新。
- 机器人回答的时候也能继续发消息了：不会被拒绝（以前偶尔是「发了没反应」），也不会打断正在进行的回复。消息先显示为「已排队」，机器人在当前步骤结束后读到、并进手头的工作，最后回应到每一条；还没读到前可以撤回。见 DESIGN.md §38.1。
- 后台任务：耗时的独立工作（多来源调研、大量整理、多步骤网上操作）机器人可以交给后台并行去做，主对话照常聊天。对话里有一张任务卡片显示进度（当前步骤、步骤清单、用时），可以「补充说明」或「停止」；做完后结果自动回到对话，机器人用一两句话总结。每人同时最多 3 个。服务重启时没做完的任务会标成失败并写明原因。见 DESIGN.md §38.2–38.3。只改服务器和网页，PC / Android 客户端不用更新。

- 修复（生产实测后台任务时发现）：① 用户一次要 4 个以上后台任务时，机器人以为超过「同时 3 个」就不能委派，只开 3 个、自己设提醒等空位；现在它知道多出来的会自动排队（卡片显示「排队中」），要几个就委派几个。② 后台任务的结果里偶尔混进一个「⟦chisabot:worker-result:⟧」标记被原样显示，现在服务器和网页都会去掉。③ 机器人取消自己设的提醒时只抄了 id 的后半段就取消不掉（提醒照样到点叫醒），现在能认。④ 走 Anthropic 协议的非 Claude 模型（默认的 Mimo V2.6 Flash 就是）每次最多只输出 4096 token，长回答写到一半被截断；现在按模型目录里的「最大输出」给上限（封顶 32000，可用 CHISABOT_MAX_OUTPUT_TOKENS 调），目录里没有的模型照旧。只改服务器和网页。
- 修复：发送消息时整段聊天记录往上 / 往回跳一截（上一轮出过错的会话里每次都会）。聊天顶上的红色提示（上一轮没有回答的原因 / 较早消息无法加载）改为浮在聊天上面、不占版面，可以关掉；打开会话时不再显示早已过去的那一轮的旧错误，只有最后一轮出错才显示。
- 手机网页版：手机上打开（竖屏、横屏都算）一律用竖屏布局——左栏和面板是抽屉、输入框贴底；平板和电脑仍按窗口宽度。刘海 / 底部横条自动让开，键盘弹出时输入框贴在键盘上沿、最新消息不被盖住，输入框字号 16px（iPhone 不再自动放大页面），小按钮的可点范围撑到 44×44，从左边缘右划打开左栏、在抽屉上横划关上，表格在气泡里横向滚动。见 DESIGN.md §40。
- 可以把网页版「安装」成应用：浏览器里打开 8 秒后顶栏下面出现「安装 ChisaBot 应用」（安卓 / 电脑 Chrome、Edge 一键安装；iPhone Safari 教你「分享 → 添加到主屏幕」），关掉后 14 天内不再提示，ChisaBot PC / 安卓客户端里不出现。安装后电脑上默认宽屏、手机上默认竖屏。新增 service worker：页面永远先走网络（部署后刷新一次就是新版本），只缓存带哈希的 /assets/*，断网时给一张「网络不可用」卡片。只改服务器网页，PC / Android 客户端不用更新。见 `docs/pwa.md`。
- 修复：关闭弹窗（新建机器人向导的「取消」、右上角 ×、Esc、点弹窗外面）时卡顿。退出动画期间不再逐帧重算毛玻璃，只做淡出和缩放；关闭也不再重渲染向导内容。所有弹窗和抽屉的关闭都受益。只改服务器网页，PC / Android 不用更新。见 DESIGN.md §37。
- 修复：机器人聊天里 AI 正在输出时，画面有时会突然跳到上面更早的聊天记录再滑回来（会话超过 50 条消息时最明显）。现在在底部时整轮都贴着底部；自己往上翻看记录时不会被拽回去。只改服务器网页，PC / Android 客户端不用更新（它们加载的就是服务器上的网页）。见 DESIGN.md §35。

## 0.1.6（2026-10-13）

- 修复：服务器重启 / 在线更新时正在回复的那个对话会卡住约 2 分钟，期间发消息「没反应」（服务器返回 409 Thread already running，网页不提示）。现在服务器启动时释放被打断的对话锁；对一个已不在运行的对话点「停止」也会直接释放；发送失败时网页给出中文提示，不再静默。
- 修复：部署新版本后，开着的旧页面点进还没打开过的页面（例如 设置 → 模型）整页显示「无法加载此页面」。服务器对缺失的 /assets/* 回 404（以前回首页 HTML），网页识别到旧版本分包已不存在就自动刷新一次。
- ChisaBot PC 设备连接更稳：设备节点（WebSocket）和登记请求改走系统代理（与聊天窗口同一条路，支持 HTTP / SOCKS5 代理，代理不可用时退回直连），解决「窗口里能聊天、设备页却显示离线」；连接 70 秒收不到服务器消息就判定已断开并重连；休眠唤醒、解锁、聊天网页加载成功时立即重连；离线时显示真实原因和走的线路，设备页「这台电脑」多一个「重新连接」按钮。

## 0.1.5（2026-10-13）

- ChisaBot PC 小窗模式：右上角窗口按钮最左边新增「小窗模式」，一键把主窗口变成手机比例的竖长小窗（约 420×860，留在当前显示器、贴着原来的右上角），再点「恢复窗口」回到原来的大小、位置和最大化状态；快捷键 Ctrl+Shift+M。需要新版 PC 客户端（旧客户端不显示按钮）。
- 窄窗口（< 768px，含小窗）整理：PC 顶栏标题按钮收窄、主导航改成图标 + 当前一项的字，不再被切掉；机器人聊天的「面板」入口移进输入框工具栏，右边缘竖把手不再压住消息和卡片；抽屉里的机器人 ⋯ 菜单改为向下弹出，不再跑出窗口。
- ChisaBot PC「新版本已下载」提示窗（包括「此更新需要重新安装」）不再固定在主显示器右下角、压住别的程序和小窗：主窗口开着时挂在主窗口里、顶栏下面居中，跟着主窗口移动和进出小窗，宽度随窗口收窄；主窗口在托盘里时才放到右下角。
- 面板库不再是比右栏还宽的整屏抽屉：改成右栏卡片里的一层，与右栏同宽、高度随内容，宽窗口和窄窗口一致。

## 0.1.4（2026-10-13）

- 机器人浏览器不再被 Cloudflare 当成机器人封掉：托管浏览器在 Linux 上（镜像自带 Xvfb）默认改为在虚拟显示器里跑有界面 Chromium，不再用 headless。实测同一台服务器上 headless 打开 grok.com 的登录页 accounts.x.ai、x.ai 显示「Sorry, you have been blocked」、chatgpt.com 卡在「Just a moment...」，改后都能正常打开。想保留旧行为可设 `COMPUTER_BROWSER_MODE=headless`。
- 网站仍然拦截时（「Sorry, you have been blocked」「Access denied / Error 1020」），机器人会收到中文说明，不再反复重试，会告诉你可以「接管控制」亲自试或让管理员配置出口代理（`EGRESS_PROXY_DEFAULT`）；「计算机」里的拦截页顶部也会盖一条中文提示。见 `docs/configuration.md`「网站拦截机器人浏览器」。

## 0.1.3（2026-10-13）

- ChisaBot PC：更新换了图标后，桌面 / 开始菜单 / 任务栏还显示旧图标的问题修好了。PC 更新一直是下载完整安装包，但以「覆盖更新」模式运行时会保留旧快捷方式、不刷新 Windows 图标缓存。现在：每个安装包装完都会重写快捷方式并刷新图标缓存；新版本第一次启动再兜底一次（包括任务栏固定的图标）；`latest.yml` 新增 `chisabotShell`（外壳指纹：图标、安装脚本、Electron 版本等），和本机不同时弹「此更新需要重新安装，以更新图标/组件」，点「重新安装」后卸载旧版再全新安装（数据保留）。已装 0.1.2 的电脑在下次更新时自动换上新图标，不用手动重装。发布者：打包前 `npm run fingerprint`（CI 已自动），见 `docs/online-update.md` §2.1。

## 0.1.2（2026-10-13）

- 安卓扫码绑定：网页「设置 → 设备 → 绑定手机」显示一次性二维码（5 分钟有效、只能用一次、自动刷新，显示等待扫码 / 已绑定），安卓 App 登录页点「扫码绑定」扫一下，就登录到这个账号并直接进入主机器人，不用输入地址和密码。手机作为一台安卓设备出现在设备列表里，可以重命名、撤销或删除；撤销后手机半分钟内自动退出登录。手机只用来登录聊天，不会出现在机器人的设备工具里。账号密码登录照旧。**升级登录网关**：把 `deploy/public/auth/server.ts` 复制到网关目录并重启 `早期上游模板-web-auth`（会话库原地加列，已有登录不受影响）；Nginx 需要 `location ^~ /api/devices/agent/` 例外（新模板已带）。见 `docs/pc-node.md` §10。
- 「绑定手机」更多入口：左下角头像菜单新增「绑定手机」（直接弹出二维码）和「设备管理」；ChisaBot PC 托盘菜单新增「绑定手机…」（打开主窗口并弹出二维码）；`/settings/devices?pair=1` 直接弹出二维码。

## 0.1.1（2026-10-13）

- 品牌：网页 favicon / PWA 图标、登录页、顶栏、PC、Android 图标换成 ChisaBot 品牌头像；README 重写并附截图。
- 右栏面板：机器人按面板设计规范制作、保存前检查；窄面板只有一层外壳、数字不折行、窄表格换简表。
- 设备：机器人现在知道你的电脑在不在线。以前电脑离线（或在线但能力全关）时，机器人拿不到任何设备工具、提示词里也没提，问「你能看到我的电脑吗」只会答「不能，我只有隔离的浏览器」。现在只要账号下关联了电脑，机器人就会读到一段「用户的电脑」说明：在线就如实说能用、用 `device_*` 工具、能力没开就告诉你去 设置 → 设备 → 权限 打开；离线就说「已关联但没连上，最后在线约 N 小时前，请打开 ChisaBot PC」。离线时只多给一个只读的 `device_list`，操作类工具仍只在设备在线时出现。`GET /api/devices/bot-tools/:botId` 多返回 `guidance`（机器人这次会读到的说明）。
- 设备页顶部新增「连接状态」卡：几台在线（都离线时写清怎么办）、你的所有机器人都能用、能力全关时给「打开权限」；在 PC 客户端里多一行「这台电脑」，没登记或令牌失效时给「登记这台电脑」按钮。
- ChisaBot PC 0.1.1：已登录却没登记的电脑会自己补登记。以前只有在本机登录页点「登录」才会登记设备；如果启动时网页会话还有效（记住登录 30 天）但本机没有设备令牌（重装、令牌解不开、旧版配置），客户端会照常打开聊天窗口，节点却永远不连，机器人看不到这台电脑，托盘只写「未登录」。现在启动时用还有效的会话补登记（连不上就每分钟重试）；托盘状态改成「已登录，但这台电脑还没登记为设备」，并新增「重新登记这台电脑」（令牌无效或被撤销时也能用；被撤销的电脑从网页重新登记要先在本机确认，自动路径从不替换已有令牌）。

- 新增「工作流」（顶栏第四个标签）：把 1–N 个机器人角色、技能和约束编排成固定步骤，像技能一样拿来就跑。自带 4 个预设（调研报告、代码审查〔两位审查员并行〕、每日简报、网页→面板〔需审批后存成右栏面板〕）；可新建、编辑（表单编辑器）、复制、删除、导入 / 导出 WORKFLOW.md。运行时填参数、给每个角色挑机器人，运行页实时显示每一步谁在做、输出、审批和 token / 用时。约束在服务器强制执行：最多步骤数、token 预算（估算）、总时间和单步时间、工具允许 / 禁止（不给模型、执行时复核）、步骤前人工审批、输出格式（JSON 校验与一次修正、字数上限），并写入运行记录和审计。也能在聊天里说「运行调研报告工作流」，或在长期任务里运行。新表 `workflows` / `workflow_runs` / `workflow_run_events`（迁移 0055）。见 `docs/workflows.md`。
- 输入框工具栏更紧凑：上下文平时只是一个小圆环（悬停显示百分比，点击才展开详情，≥70% 琥珀、≥90% 红照旧）；模型选择挪到右边、紧挨圆环和发送键，按钮变短（提供方标记 + 截断的名字，最宽约 160px，卡片窄于 420px 时只剩标记和箭头），「默认」标签从按钮挪进下拉列表；左边只留 ＋；去掉「Shift + Enter 换行」小字（写在发送键的悬停提示里）。机器人聊天和频道聊天一致。
- 聊天输入框重做：一张玻璃卡，上面输入区（自动长高到 8 行），下面一行工具栏——＋ 附件、模型选择（从输入框下面挪进卡里）、上下文读数、发送键；回复中发送键原地变成停止键。机器人聊天和频道聊天一致。
- 输入框新增「上下文 12.3k / 200k」读数和小圆环：当前对话占用的 token / 所选模型的上下文窗口，悬停看已用、剩余、输入 / 输出、缓存命中；≥70% 琥珀、≥90% 红并提示开新话题。用量是服务器在每次模型调用上实测的（最后一步的输入 + 输出，写在 RUN_FINISHED 的 `metadata.contextUsage`，`GET /api/conversations（原旧兼容路由）/threads/:id/context` 读取）；窗口来自模型目录的 `context_window`，目录里没有就不显示分母；没有实测用量时按文字估算并标「约」。
- 系统更新：依赖（`bun.lock` / `package.json`）、`Dockerfile` 或 `docker/` 变了时不再停在「需要完整构建」，页面直接给出「一键完整更新」：宿主机从 GitHub 拉最新代码，用仓库 `Dockerfile` 在限内存的 buildx 构建器里从头构建（装依赖、构建前端、构建镜像），照旧先备份数据库、健康检查、失败自动回滚；成功后新镜像就是之后快速更新的底座。「检查更新」真的从 GitHub 拉取（公开仓库不需要令牌），「上次检查」显示拉取时间。升级已有部署：把 `deploy/updater/` 的脚本装到 `/opt/chisabot-updater/`（`config.env` 补 `FULL_BUILD_MEMORY`、`GITHUB_FETCH`）并重启 `chisabot-updater`，见 `docs/online-update.md`。
- 镜像：`docker build .` 现在产出完整的 ChisaBot 镜像（hoisted 依赖树、前端带构建号、`/app/build-info.json`、`chisabot.commit` 标签、迁移等内嵌数据库就绪）。

- 计算机：机器人自己写的网页能在它的浏览器里打开了——工作区挂在 `https://workspace.local/<路径>`（浏览器内直接读工作区文件，不出网，只能读工作区）；`file:///workspace/…` 自动换成它。以前机器人说「我写个页面然后打开」，结果什么都打不开。
- 计算机：接管大屏停在空白页、画面一片白时，显示和右栏一致的「浏览器空闲」卡，不再是一块白色矩形。

## 0.1.0（2026-10-12，ChisaBot 首个公开版本）

ChisaBot 版本号从这一版重新计数（之前内部测试的 0.2.x 作废）：服务器 `package.json`、PC 客户端和 Android 客户端都是 0.1.0。
Android 的 `versionCode` 为 206（高于内部测试版的 205），已安装的 Android 会正常提示更新；装过 0.2.x 的 Windows 电脑
不会自动“更新”到更低的 0.1.0，需要卸载后手动装一次。

包含目前的全部功能：中文 Skyglass 界面、登录网关、本地 PostgreSQL 持久化、Magpie 模型目录与每 BOT 选模型、`render_ui`
生成式界面、管理后台一键在线更新与自检、PC 设备节点与在线更新、Android 客户端，以及 PC / Android 共用的本机登录页：
PC 和 Android 客户端打开后不再显示服务器的网页登录页，而是客户端自带的「登录 ChisaBot」页：服务器地址（保存在本机、
带最近用过的下拉，可省略 `https://`）、账号、密码（显示开关）、记住登录。客户端先检查地址能否连上，再直接请求登录网关，
错误分为「地址无法连接」「证书错误」「账号或密码错误」。密码不保存：记住登录时网关发 30 天的会话 Cookie，期间打开直接进入；
会话过期时回到这个登录页。PC 托盘菜单和 Android 长按图标新增「切换服务器」「退出登录」。登录网关的网页登录页
（`deploy/public/auth-web/login.html`）改为 ChisaBot 品牌和蓝天玻璃风格，接口不变；Magpie 登录页不变。
PC 修复：连不上服务器时设备连接的 `error` 事件没有监听，主进程可能报未捕获异常。

---

早期基础框架来源与第三方开源许可证声明见 [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)。
