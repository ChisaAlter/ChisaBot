# 功能目录

ChisaBot 现在所有的功能，一项一行：**做什么 · 入口 · 代码 · 数据 · DESIGN § · 开关 / 状态 · 文档**。截至 main `0e23321`（2026-10-17）。

- 「入口」写用户在界面上怎么到达；设置页按 2026-10-16 的新分组（[settings-ia.md](settings-ia.md)）。
- 「代码」只写主要位置；`server/` 的测试在 `server/tests/<功能>*.test.ts`，网页测试在 `app/tests/`。
- 数据表的完整说明见 [data-model.md](data-model.md)。表名带 `chisabot_` 的都是开机 `CREATE TABLE IF NOT EXISTS` 建的（回滚安全）。
- 「状态」：**上线** = 默认可用；**隐藏** = 代码在、默认不显示，用开关恢复；**移除** = 代码已删、表保留。

## 开关一览

| 开关 | 默认 | 打开后 |
|---|---|---|
| `CHISABOT_EXTRAS=workflows,plugins,boundaries,components`（或 `all`） | 空（全部隐藏） | 分别恢复：工作流（含机器人工具 `list_workflows` / `run_workflow`）、插件与 MCP、权限规则（CEL）、UI 组件目录；`/api/capabilities.extras` 列出已开的 |
| `CHISABOT_ACCOUNTS_UI=1` | 关 | 设置 → 账号与连接 →「账号」（邀请朋友、停用、重置密码） |
| 网关 `auth/config.json` `"invites": true` | 关 | 允许发新邀请 / 直接建账号（已有账号照常登录） |
| `CHISABOT_GATEWAY_SECRET` | 部署时设 | 网关签名身份（多账号必需；单用户也建议开） |
| `COMPUTER_BROWSER_MODE=headless` | 有界面（Xvfb） | 云端浏览器回到无头模式 |
| `CHISABOT_IM=0` · `CHISABOT_SCHEDULES_SWEEP=0` · `CHISABOT_LIVE_PANEL_SWEEP=0` | 开 | 关掉 IM 连接 / 定时任务扫描 / 面板刷新扫描 |
| `CHISABOT_MODEL_FALLBACKS`（列表或 `off`） | 自动挑同平台 | 备用模型候选（设置里的「备用模型」优先） |
| `CHISABOT_LINK_PREVIEW_SHOTS=1` | 关 | 没有 og:image 时截图做链接卡缩略图 |
| `CHISABOT_PANEL_COMMANDS=1` | 关 | 允许管理员给右栏面板挂「本机命令」数据源（秒级取数；只给管理员，默认关） |
| `BOT_HANDOFF_MAX_DEPTH=1` | 0（关） | 恢复机器人之间交接 |
| 其他 | — | [architecture.md](architecture.md) §4、[configuration.md](configuration.md) |

---

## 1. 聊天

| 功能 | 做什么 | 入口 | 代码 | 数据 | DESIGN | 状态 · 文档 |
|---|---|---|---|---|---|---|
| 频道聊天（唯一的聊天） | 和一个机器人对话；`/bot?agent=` 旧地址跳转过来 | 左栏点机器人 | `app/src/components/channels/`、`app/src/components/chat/`、`server/src/channels/`、`server/src/local-conversations.ts` | `openbot_local_threads/_runs/_events`、`intelligence_channel_mappings`、`channel_agents` | §68 · ADR-0013 | 上线 · [streaming.md](streaming.md) |
| 留着的聊天 | 去设置 / 待处理 / 设备 / Claude Code 再回来，聊天是同一个没卸载过的实例（不重连、不重读、滚动原样）；藏 10 分钟后放掉 | — | `app/src/components/layout/authed-shell.tsx`、`app/src/components/layout/keep-alive.tsx`、`app/src/components/channels/channel-page.tsx` | — | §98 | 上线 |
| 流式回复 | 按帧匀速放字；断线先问服务器、能接上就接上 | — | `app/src/lib/typed-reveal.ts`、`app/src/lib/chat/` | — | §30、§89 | 上线 · [streaming.md](streaming.md) |
| 一轮的样子 | 短气泡、草稿卡、回复引用、代码卡、文档卡；开场一句 → 结果 | — | `app/src/components/chat/`、`app/src/lib/chat/` | — | §27、§69、§76 | 上线 |
| 干活卡 | 「● 正在搜索… · 第 n 步 · 用时」，原位；结束收成一行；中途说明收进卡；简单回合不出卡 | — | `app/src/lib/chat/work-steps.ts`、`app/src/components/chat/work-card.tsx` | — | §70、§75、§90、§93 | 上线 |
| 思考（推理） | 默认收起、只在点开时展开；`<think>` 标签转成思考 | — | `server/src/agents/think-tags.ts` | — | §44 | 上线 |
| 富预览 / 富组件 | 链接卡（单独一行的链接）、图片一摞、看大图、文件卡；json-render `render_ui` 37 个组件；商品 / 地点卡片网格 | — | `app/src/lib/rich-previews/`、`server/src/link-preview/`、`server/src/generative-ui/` | `chisabot_link_previews`、`chisabot_link_preview_assets`、`chisabot_image_dims` | §31、§32、§48、§72、§83.2 | 上线 |
| 输入框 | 一张玻璃卡 + 工具栏；＋ 上传、模型选择、上下文小饼图、发送 / 停止；**权限开关「请求批准 / 完全访问」** | 聊天底部 | `app/src/components/chat/`、`server/src/context-usage.ts` | `chisabot_bot_permissions` | §25、§78、§92、§97 | 上线 |
| 回答中发消息 · 后台任务 | 回答时继续发（排队 → 已读取）；机器人把活交给后台 worker，任务卡显示进度 | — | `server/src/thread-inbox.ts`、`server/src/workers/` | `chisabot_thread_inbox`、`chisabot_workers` | §38 | 上线 |
| 全端同步 · 历史对话 | 每个 (用户, 机器人) 的当前对话存在服务器，网页 / PWA / PC / Android 同一段；「历史对话」切换 | 机器人 ⋯ → 历史对话 / 新话题 | `server/src/bot-threads.ts`、`app/src/lib/copilot/use-conversation-sync.ts` | `chisabot_bot_threads` | §42、§64 | 上线 |
| 重新生成 / 编辑后重发 | 服务器真截断对话，所有设备一致 | 回答下「重新生成」、消息下「编辑」 | `server/src/thread-truncate.ts` | `chisabot_thread_truncations` | §67 | 上线 |
| 停止 | 「◼ 已停止」，跨刷新 / 设备记住 | 发送键变停止 | `server/src/local-conversations.ts` | 事件表 | §27 | 上线 |
| 聊天截图缩略图 | `computer_screenshot` 在聊天里出缩略图 | — | `server/src/chat-shots.ts` | `chisabot_chat_shots`（≤400KB、每人 200 张、30 天） | §27 | 上线 |
| 滚动与状态 | 贴底不跳、上滑不拽；打开落在最新一条；5 分钟内连续发不翻页；按机器人记住面板 / 计算机、草稿、滚动 | — | `app/src/components/chat/`、`app/src/lib/chat/` | 浏览器 localStorage `chisabot-ui-memory:v1`（`app/src/lib/chat/ui-memory.ts`） | §35、§83、§88、§94 | 上线 · `tests/chat-scroll/` |
| 聊天文件 · 生图 | ＋ / 拖拽 / 粘贴上传（≤20 MB）进机器人工作区；机器人交付文件、画图、改图、看图 | ＋；设置 → 模型（生图 / 识图） | `server/src/chat-files/` | `chisabot_chat_files`、`chisabot_image_settings`、`chisabot_media_models`、`chisabot_image_descriptions` | §56、§59 | 上线 · [chat-files.md](chat-files.md) |
| 备用模型 | 主模型 429 / 额度 / 5xx 时按管理员顺序换模型，聊天末尾一行说明 | 设置 → 模型 → 备用模型 | `server/src/agents/model-fallback.ts` | `enterprise_settings`（key `model_fallbacks`） | §60、§61 | 上线 · [models.md](models.md) |
| 实时语音通话 | — | — | — | `voice_sessions`（保留） | §68.7 | **移除**（#137）；语音听写不受影响 |

## 2. 右栏：面板与计算机

| 功能 | 做什么 | 入口 | 代码 | 数据 | DESIGN | 状态 · 文档 |
|---|---|---|---|---|---|---|
| 实时面板 | 机器人按设计规范搭面板（≤2 磁贴 + 2 块），按小时或每天固定时刻刷新；常驻和弹出模式共用卡片布局及记住的宽度（[一致性](sidebar-panel-parity.md)）；来源 + 更新时间一行 | 右栏「面板」；在聊天里说 | `server/src/live-panels/`（`design.ts` 规范 + lint） | `live_panels`（迁移 0056/0057） | §29、§43、§77 | 上线 |
| 直连数据源 | 面板挂 ≤3 个 http / 本机命令数据源，宿主按 2–3600 秒取数并回填 `/live/<id>`（不花 token）；密钥走保险箱、内网拦截；命令源只给管理员且默认关 | 机器人 `panel_create` / `panel_update` 的 `dataSources` | `server/src/live-panels/sources.ts` | `live_panels.data_sources` / `source_state`（迁移 0059） | §109 | 上线 · [live-panel-sources.md](live-panel-sources.md) |
| 看板布局 · 卡片菜单 | 两两并排 / 调比例 / 拖高 / 折叠（按机器人记在本机）；⋯ 菜单加「让 AI 修改…」「数据来源…」 | 右栏面板卡片 | `app/src/components/panels/` | 浏览器 localStorage | §109 | 上线 · [live-panel-sources.md](live-panel-sources.md) |
| 云端浏览器（计算机） | 每个机器人一个 Chromium 配置（Xvfb 有界面，Cookie / 登录各自独立；同一进程、共用 `/workspace`）；原生下拉框用「填写」选中（§100）；工作区文件经 `https://workspace.local/` 打开 | 右栏「计算机」；放大后接管 / 交还 | `agent-computer/`、`server/src/computer/`、`app/src/components/computer/` | `computer_snapshot`、`computer_page_frame`（上游） | §23、§39、§79 | 上线 |
| 浏览器多标签 · 收藏夹 | 真标签（≤8，人和机器人同一组，重启恢复）；每账号收藏夹（星标、收藏栏、窄屏下拉、管理） | 放大的浏览器工具条 | `agent-computer/src/tabs.ts`、`server/src/browser-bookmarks/` | `chisabot_browser_bookmarks`、`chisabot_browser_bookmark_seeds` | §95、§96 | 上线 · [browser-tabs.md](browser-tabs.md) |
| 网站被拦时 | 硬拦截页返回中文提示，建议接管或出口代理 | — | `agent-computer/src/site-block.ts` | — | — | 上线 |

## 3. 机器人

| 功能 | 做什么 | 入口 | 代码 | 数据 | DESIGN | 状态 · 文档 |
|---|---|---|---|---|---|---|
| 新建 / 编辑机器人 | 一张表：头像 · 名称 · 职责 · 它做什么（原样存为提示词）；一律私有、在服务器上运行 | 左栏 ＋（Shift+N）；资料页「编辑」 | `app/src/components/agents/`、`server/src/agents/` | 上游 agents 表（迁移 0058 一律私有） | §46、§63、§74、§81 | 上线 |
| 圆形头像 | 上传（圆形裁剪 256² WebP）/ 表情 + 颜色 / 首字 + 颜色 | 表单头像 | `server/src/bot-avatars/` | `chisabot_bot_avatars` | §81 | 上线 · [bot-avatars.md](bot-avatars.md) |
| 资料页 | 页头 + 资料 / 运行 / 任务卡，就地编辑 | 机器人 ⋯ → 资料（`/bots/:id`） | `app/src/components/bot-profile/` | — | §47 | 上线 |
| 主机器人 · 首次运行「助手」 | 主机器人置顶；每个新用户自动得到私有「助手」 | 机器人 ⋯ → 设为主机器人 | `server/src/agents/` | — | §19 | 上线 |
| 对话里建机器人（save_bot） | — | — | — | — | §74 | **移除**（死代码，#163） |
| 机器人交接 | 机器人之间互相交活 | — | 上游 | — | — | 默认关（`BOT_HANDOFF_MAX_DEPTH`） |

## 4. 设备与电脑

| 功能 | 做什么 | 入口 | 代码 | 数据 | DESIGN | 状态 · 文档 |
|---|---|---|---|---|---|---|
| 设备列表 · PC 节点 | 设备属于账号，所有机器人都能用 `device_*` 工具；能力「关闭 / 询问 / 允许」，新设备默认询问；本机确认、审计、急停 | 设置 → 电脑与设备 → 设备 | `server/src/devices/`、`pc/src/agent/` | `devices`、`device_audit_events`（迁移 0054）、`devices.full_access_until` | §16、§45 · ADR-0002 | 上线 · [pc-node.md](pc-node.md) |
| 允许的文件夹 | 文件工具只在允许的文件夹里；之外的路径必问，批准即加入 | 设备详情 | `server/src/devices/roots.ts` | 设备配置 | §62 | 上线 |
| 编码工具 | `device_search` / 按行读 / `device_edit_file`（diff + 备份）/ `device_apply_patch` / `device_git` / 后台命令 / 持久 shell / 进程 | 聊天里说 | `server/src/devices/tools.ts` | — | §62 · ADR-0009 | 上线 |
| 完全访问 | 每台设备 1h / 24h / 永久，只有主人能在网页打开、PC 本机确认，急停关掉 | 设备详情；输入框权限开关（按机器人） | `server/src/devices/`、`server/src/confirmations/` | `devices.full_access_until`、`chisabot_bot_permissions` | §62、§97 · ADR-0009 | 上线 |
| 设备「打开」 | 只能打开 http/https 网址或允许文件夹里已有的文件 | — | `server/src/devices/`、`pc/src/agent/` | — | — | 上线（CB-030） |
| 无界面节点 `chisabot-node` | Linux / macOS 服务器当设备，一行命令安装 | 设备 → 添加一台服务器 | `pc/src/headless.js`、`server/src/devices/node-install.ts` | `devices` | §62 | 上线 |
| 本地 agent | 把整件活交给设备上的 Claude Code / Codex / OpenCode / Gemini / Aider 或内置循环；档位只读 / 工作区 / 完全访问；按任务隔离 | 聊天里说；设备详情 | `server/src/local-agents/`、`pc/src/agent-runtime/` | `chisabot_device_agent_settings`、`chisabot_local_agent_tasks` | §66 · ADR-0010 | 上线 · [local-agents.md](local-agents.md) |
| 扫码绑定手机 | 一次性二维码（5 分钟）→ 手机得到设备令牌 → 会话；撤销即退出 | 账号菜单 → 绑定手机；PC 托盘 | `server/src/devices/pairing.ts`、`android/…/Pairing.kt` | `devices` | §33 | 上线 |
| PC 客户端 | 窗口 + 设备节点；小窗模式（Ctrl+Shift+M）、托盘、无边框登录窗、连接提示、更新提示 | — | `pc/` | — | §16、§36、§45、§91 | 上线 · [pc-node.md](pc-node.md) |
| Android 原生 | 登录、机器人列表、聊天（流式、干活卡、富卡片）、面板、确认卡、附件、停止 / 重新生成 / 编辑、原生设置基础；其余页面应用内网页 | — | `android/` | — | §80、§86 | 上线 · [android-native.md](android-native.md) |
| 手机网页 · PWA | 手机永远窄布局；manifest + Service Worker（导航不缓存） | 浏览器「安装」 | `app/public/sw.js`、`app/src/lib/device.ts` | — | §40 | 上线 · [pwa.md](pwa.md) |

## 5. 云端 Claude Code

| 功能 | 做什么 | 入口 | 代码 | 数据 | DESIGN | 状态 · 文档 |
|---|---|---|---|---|---|---|
| 云端工作区节点 | 手工部署的容器：Claude Code CLI + 节点，非 root、只读根、无 docker.sock、不发布端口 | 设置 → 电脑与设备 → 云端工作区（管理员） | `deploy/cloud-node/`、`server/src/cloud-cc/` | `chisabot_cloud_workspaces` | §73 · ADR-0014 | 上线（手工部署） · [cloud-claude-code.md](cloud-claude-code.md) |
| Claude 登录 | 「在云端完成登录」：节点里的浏览器打开授权页，画面嵌在设置页 | 云端工作区 | `pc/src/cloud-cc/`、`server/src/cloud-cc/` | — | §73 | 上线；**需所有者登录一次** |
| Claude 上游代理 | http / socks5，或 trojan / vless / vmess / ss / hy2 / tuic 链接（sing-box 转换）；只有 Claude 域名走它 | 云端工作区 →「Claude 上游代理」 | `server/src/cloud-cc/` | 原始链接存保险箱 | §85 | 上线 |
| Claude Code 标签页 | 左栏「机器人｜Claude Code」切换（原地）；工作区 → 会话；流式、`--resume`、审批、排队 | 左栏顶部切换（管理员） | `app/src/routes/_authed/_app/cc/`、`app/src/components/cloud-cc/` | `chisabot_cc_workspaces`、`chisabot_cc_sessions`、`chisabot_cc_messages`、`chisabot_cc_events`、`chisabot_cc_permission_rules` | §73、§84 | 上线 |
| GitHub 工作区 | 克隆仓库，每个会话 `cc/…` 分支，合入、推送并开 PR | 新建工作区 → 从 GitHub | `server/src/cloud-cc/` | 同上 | §73 | 上线；需连 GitHub |
| 电脑文件夹同步 | PC「电脑上的文件夹」↔ 云端双向同步（Mutagen MIT 版，经设备隧道）；冲突对话框、交接、失败自动撤销 | PC：新建工作区 → 电脑上的文件夹 | `pc/src/sync/`、`server/src/cloud-cc/sync.ts`、`deploy/cloud-node/sync/` | `chisabot_cc_sync_bindings`、`chisabot_cc_leases`、`chisabot_cc_sync_conflicts`、`chisabot_cc_sync_events` | §73、§87 | 上线；未在真实 Windows 验证（CB-017） |

## 6. Hark 同款能力

| 功能 | 做什么 | 入口 | 代码 | 数据 | DESIGN | 状态 · 文档 |
|---|---|---|---|---|---|---|
| 长期记忆 | 个人资料 / 偏好 / 人物 / 地点 / 项目 / 日志；所有机器人共用、可按机器人关；能真删 | 设置 → 机器人 → 记忆 | `server/src/memory-notes/` | `chisabot_memory_notes`、`chisabot_memory_bots` | §50 | 上线 · [memory.md](memory.md) |
| 技能 | 「某类事怎么做」，机器人按需加载、经同意存下；`/名字` 调用 | 设置 → 机器人 → 技能 | `server/src/skills-chisa/` | 上游 `skills` 表 | §51 | 上线 · [skills.md](skills.md) |
| 密钥保险箱 | 机器人能用、看不到：安全输入卡、`{{secret:名字}}` 只发往绑定域名 | 设置 → 账号与连接 → 密钥 | `server/src/vault/` | `chisabot_vault_secrets`、`chisabot_vault_requests` | §52 · ADR-0004 | 上线 · [vault.md](vault.md) |
| GitHub 连接 | 贴令牌；读仓库 / Issue / PR / 文件；建 issue / 评论 / 开 PR 先确认 | 设置 → 账号与连接 → 账号连接 | `server/src/github/` | `chisabot_github_connections`、`chisabot_github_actions`（令牌在保险箱 `github`） | §53 | 上线 · [github.md](github.md) |
| 页面 | 机器人做单页网页，公开链接 `/p/<随机串>/`，CSP sandbox；50 个版本 | 设置 → 机器人 → 页面；聊天页面卡 | `server/src/pages/` | `chisabot_pages`、`_page_versions`、`_page_assets`、`_page_origins` | §54 · ADR-0005 | 上线 · [pages.md](pages.md) |
| 定时任务与提醒 | 一次性 / 周期（≥15 分钟），北京时间；到点回到原对话；IM 来源推回 IM | 设置 → 机器人 → 定时任务；账号菜单 | `server/src/schedules/` | `chisabot_schedules`、`chisabot_schedule_runs` | §55 · ADR-0006 | 上线 · [schedules.md](schedules.md) |
| 确认卡片 · 权限与审批 | 对外发消息 / 删除 / 付款 / 操作电脑四类「先问我 / 直接做」（付款永远问）；自然语言规则；每个机器人的权限 | 设置 → 机器人 → 权限与审批；聊天里的卡片 | `server/src/confirmations/` | `chisabot_confirm_prefs`、`_rules`、`_requests`、`chisabot_bot_permissions` | §58、§97 | 上线 · [confirmations.md](confirmations.md) |
| 待处理 | 只列等你点头的事（没点的确认卡、要你亲自做的步骤、机器人在等的问题） | 账号菜单 → 待处理（`/approvals`） | `app/src/routes/_authed/_app/approvals.tsx` | 同上 | §71 | 上线 |
| IM 接入 | 飞书 / Lark、QQ 官方、QQ 个人号（OneBot 11）、企业微信、个人微信、钉钉、Telegram；私聊都回、群里只回 @ | 设置 → 账号与连接 → IM 接入 | `server/src/im/`、`shared/im.ts` | `chisabot_im_connections`、`_chats`、`_logs` | §49 | 上线（`CHISABOT_IM=0` 关）· [im.md](im.md)；**待决定是否保留** |
| 联网搜索 · 抓取 | 内置 `web_search` / `web_fetch` | — | `server/src/agents/` | — | §27 | 上线 |
| 每日简报 | — | — | — | — | — | 未做（CB-014） |
| Google 账号连接 | — | — | — | — | — | 未做（CB-013，最后） |

## 7. 设置、管理与系统

| 功能 | 做什么 | 入口 | 代码 | 数据 | DESIGN | 状态 · 文档 |
|---|---|---|---|---|---|---|
| 设置分组 · 搜索 | 通用 · 机器人 · 电脑与设备 · 账号与连接 · 模型 · 系统；Ctrl/⌘K 或 / 搜索（拼音首字母、英文） | 账号菜单 → 设置 | `app/src/lib/settings/registry.ts` | — | §57、§71.7、§97 | 上线 · [settings-ia.md](settings-ia.md) |
| 通用 | 外观（主题、背景随时间变化）、常驻指令、快捷键 | 设置 → 通用 | `app/src/routes/_authed/settings/index.tsx`、`app/src/lib/sky.ts` | 用户偏好 | §7 | 上线 |
| 模型 | 聊天模型、模型密钥、备用模型、生图 / 识图模型；Magpie | 设置 → 模型（管理员） | `server/src/model-settings.ts`、`server/src/magpie.ts` | `enterprise_settings` 等 | §15、§59、§61 | 上线 · [models.md](models.md)、[magpie.md](magpie.md) |
| 我的生图与识图 | 个人覆盖部署默认 | 设置 → 模型 | `server/src/chat-files/media-models.ts` | `chisabot_media_models` | §59 | 上线；**待决定是否保留** |
| 云端浏览器管理 | 部署里的计算机、快照、登录状态 | 设置 → 电脑与设备 → 云端浏览器（管理员） | `app/src/routes/_authed/admin/computers.tsx` | 上游表 | — | 上线；**待决定是否保留** |
| 系统更新 · 自检 | 版本、检查更新、一键更新 / 完整更新、回滚、历史、自检 | 设置 → 系统 → 系统更新 | `server/src/system-update.ts`、`deploy/updater/`、`server/src/admin-smoke.ts` | 宿主机 spool | §22 | 上线 · [online-update.md](online-update.md)、[admin-smoke.md](admin-smoke.md) |
| 活动记录 | 全部操作审计，中文事件名；手机一条一卡 | 设置 → 系统 → 活动记录 | `server/src/audit.ts` | `audit_events` 等 | §71.6 | 上线 |
| 朋友账号（多用户） | 邀请链接、网关签名身份、按人隔离一切数据 | 设置 → 账号与连接 → 账号 | `deploy/public/auth/server.ts`、`server/src/auth/gateway-identity.ts` | 网关 SQLite `accounts`、`invites`、`sessions.user_id` | §65 · ADR-0011 | **隐藏**（`CHISABOT_ACCOUNTS_UI`、`invites`）· [accounts.md](accounts.md) |
| 工作流 | 1–N 个机器人 + 技能的预设流程 | 设置 → 高级 | `server/src/workflows/` | `workflows`、`workflow_runs`、`workflow_run_events` | §26 | **隐藏**（`CHISABOT_EXTRAS=workflows`）· [workflows.md](workflows.md) |
| 插件与 MCP | Composio、Google Drive、Notion、Parallel Search 等连接器 | 设置 → 高级 | `server/src/plugins/` | `mcp_servers`、`plugin_grants` 等 | — | **隐藏**（`plugins`） |
| 权限规则（CEL） | 上游策略引擎（0 条 = 全允许） | 设置 → 系统 | 上游 | — | — | **隐藏**（`boundaries`） |
| UI 组件目录 | 上游组件库 | 只能输地址 | 上游 | — | — | **隐藏**（`components`） |
| 品牌 | 头像 logo；字标「Chisa」红 +「Bot」墨色，每人可改 | 点左上字标 | `assets/brand/`、`app/src/components/layout/` | 用户偏好 | §28 | 上线 |
| 时间天空 | 背景随时间变化 | 设置 → 通用 | `app/src/lib/sky.ts` | localStorage `chisabot-sky` | §7 | 上线 |

## 8. 已移除（瘦身）

上游企业功能分阶段移除，**表和数据一律保留**到 P5（见 [slimming.md](slimming.md)）：人员 / 角色、企业控制闸门、SSO / SCIM / 身份提供者、
自动学习、组件游乐场、旧群聊 `/group/*`、推送与可达性（Slack / Teams / 短信 / 手机推送）、团队机器人接口、演示录制、上游个人记忆、
主动研究、意图路由、Docker supervisor、上游 routines（并入定时任务）、上游桌面端残留（electron 插件、组织登录、host-access）、
Tauri 桌面端 `desktop/`、Expo `mobile/`、13 个外部框架 agent、Helm chart、`worker/`、实时语音。旧地址都重定向到新位置。

## 9. 待所有者决定（2026-10-16 功能审查留下）

1. 左栏两个同名「助手」（10-15 恢复误删时留下）：改名或删一个。
2. IM 接入（还没有任何连接）：留还是隐藏。
3. 个人「我的生图与识图」（单人时和「模型」页重复）。
4. 「云端浏览器」管理页（偏技术，但机器人上网要用）。
