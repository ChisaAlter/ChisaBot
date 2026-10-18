# ROADMAP（看板）

ChisaBot 现在要做什么、接下来做什么、以后做什么。这一页就是看板：每一行指向 [BACKLOG](BACKLOG.md) 里一条带验收标准的条目
（GitHub Issues 打开后改为 issue 链接）和一个 [里程碑](https://github.com/ChisaAlter/ChisaBot/milestones)。

- **谁维护**：每个 PR 改自己那一行（开始做 → 「现在」，合并 → 「最近完成」）；主维护者每天过一遍，调整顺序、清理已完成。
- **方向**（2026-10-15）：尽快做成「相对成熟、可以分享给朋友用」的私人助手。核心是**在任何地方管理所有设备（包括本地电脑）**，
  云端机器人能读、改、写本地文件和代码；同时继续把上游 OpenBot 的企业功能瘦身掉；Hark 的能力逐项补齐。
- 上次整理：2026-10-17（对照 origin/main 0e23321 = PR #192 逐行核对；客户端最新 v0.1.15）。版本史见 [CHANGELOG](CHANGELOG.md)，功能全表见 [features.md](features.md)。

## 里程碑

| 里程碑 | 目标 | 状态 |
|---|---|---|
| [Hark parity](https://github.com/ChisaAlter/ChisaBot/milestone/1) | 记忆、技能、保险箱、GitHub、页面、定时、文件/生图、审批、生图/识图设置已上线；对话体验第五轮（短气泡、干活卡）已上线；简报、Google 账号最后 | 9 / 11 已上线（剩简报、Google 账号）；对话体验第六轮（干活卡在原位、文档卡、面板像 Hark）及后续 §88–§97 已上线 |
| [精简 Slim](https://github.com/ChisaAlter/ChisaBot/milestone/2) | P1–P5 收敛成私人助手（[docs/slimming.md](slimming.md)） | P1–P4b、P6-1…P6-4（企业闸门、SSO/SCIM、worker/、桌面端残留）、删语音、P4c-1（routines 并入定时任务）、发版前功能精简（#163，`CHISABOT_EXTRAS`）已上线；P4c 其余合并按依赖排；P5 删空表等 ≥ 2 周 |
| [设备核心 Devices core](https://github.com/ChisaAlter/ChisaBot/milestone/3) | 设备上的编码工具、无界面节点、完全访问、本地 agent | 编码工具 / 无界面节点 / 完全访问 / 本地 agent 已上线；云端 Claude Code P0–P4（含电脑文件夹同步、上游代理）已上线；输入框按机器人权限（#192）；待真机验证 |
| [成熟度 Maturity](https://github.com/ChisaAlter/ChisaBot/milestone/4) | 全量体验扫查 + 已知缺陷 / 性能尾巴 | 第 1、2、3 轮已上线（#115、#122、#124、#125；第 3 轮非聊天页面 #142、#144、#145）；10-16 一轮 CB-069…CB-083 全部上线 |
| [0.2.0 release](https://github.com/ChisaAlter/ChisaBot/milestone/5) | 下一次大版本，真机验证 | 0.1.x 已发到 v0.1.15（Android 原生、PC 同步）；等真机验证（CB-017 / CB-018） |

## 现在（进行中）

| 条目 | 内容 | 里程碑 | 分支 |
|---|---|---|---|
| [CB-012](BACKLOG.md#cb-012) | 文档整理：概览、功能目录、版本记录、决策日志、发布 / 测试手册、术语、数据模型 | 成熟度 | `docs/handbook-20261017` |

（2026-10-17 没有进行中的代码条目。）

## 接下来

| 条目 | 内容 | 为什么排在这 |
|---|---|---|
| [CB-067](BACKLOG.md#cb-067) | 功能精简留下的 4 项待决定：两个同名「助手」、IM 接入、个人生图与识图、云端浏览器管理页 | 需要所有者决定 |
| [CB-018](BACKLOG.md#cb-018) | 所有者电脑手动重装 PC 0.1.x（现在 0.1.15；0.2.x 不会自动更新） | 需要所有者；设备核心验收依赖它 |
| [CB-017](BACKLOG.md#cb-017) | 真机验证 Windows（含电脑文件夹同步）/ 安卓原生 | 需要所有者；0.2.0 发版前 |
| [CB-066](BACKLOG.md#cb-066) / [CB-063](BACKLOG.md#cb-063) | 所有者在云端登录 Claude 一次、连接 GitHub | 需要所有者；云端 Claude Code 真正可用的前提 |
| [CB-034](BACKLOG.md#cb-034) | 真实账号验证 GitHub / IM | 需要所有者 |
| [CB-019](BACKLOG.md#cb-019) | 发版 0.2.0 | 真机验证之后 |
| [CB-027](BACKLOG.md#cb-027) | IM 定时推送的平台窗口 | 需要真实平台验证 |
| 测试基线 | 修 main 上 `approvals-rules` / `approval-tools` 两个已知失败（[testing.md](testing.md) §5） | 让「对比 main 0 新增失败」更干净 |

## 以后

| 条目 | 内容 | 条件 |
|---|---|---|
| [CB-065](BACKLOG.md#cb-065) | 云端 Claude Code P5：ChisaCloudCode 留还是下线 | 要问所有者 |
| [CB-015](BACKLOG.md#cb-015) | 瘦身 P4c 其余合并（旧面板、components、responsibilities、审批规则…；routines 已并入定时任务 #143） | 各自依赖的功能上线并稳定后 |
| [CB-016](BACKLOG.md#cb-016) | 瘦身 P5 DROP 空表 | P4b 上线 ≥ 2 周 |
| [CB-013](BACKLOG.md#cb-013) | Google 账号连接 | 所有者说不急，Hark parity 最后一项 |
| [CB-014](BACKLOG.md#cb-014) | 每日简报（可选） | 定时任务稳定后 |
| [CB-045](BACKLOG.md#cb-045) | 每人模型额度 / 用量上限 | 多用户打开时 |
| [CB-025](BACKLOG.md#cb-025) / [CB-029](BACKLOG.md#cb-029) | 长对话首屏、弹窗模糊性能 | ✅ CB-025 0.1.37 尾屏优先；✅ CB-029 0.1.38 §37.3 |
| [CB-026](BACKLOG.md#cb-026) / [CB-028](BACKLOG.md#cb-028) / [CB-031](BACKLOG.md#cb-031) | 数据卫生：线程指针、过程话、事件表 | 数据轮 |
| [CB-032](BACKLOG.md#cb-032) / [CB-033](BACKLOG.md#cb-033) | CI 内安卓签名、生产 stale-chunk 测试 | 发布流程 |

## 最近完成

| 日期 | 内容 | PR | 设计 / 文档 |
|---|---|---|---|
| 2026-10-19 | 生产加固：直播屏 keepalive + SSRF/日志残留 + version 烟雾（→ v0.1.25） | #217 | /workspace/ChisaBot-production-readiness.md |
| 2026-10-17 | 切回机器人页不再刷新：外壳只有一个，聊天离开时留着（CB-084） | #197 | DESIGN.md §98 |
| 2026-10-17 | 第一次去设置时藏着的聊天不再被挪动（CB-084 收尾） | #198 | DESIGN.md §98.5 |
| 2026-10-17 | 文档整理：概览、功能目录、版本记录、决策日志、发布 / 测试手册、术语、数据模型（CB-012） | #193 | [README](README.md) |
| 2026-10-16 | 设置重新整合 + 设置搜索；输入框权限「请求批准 / 完全访问」（CB-083） | #192 | DESIGN.md §97、docs/settings-ia.md |
| 2026-10-16 | 浏览器暗色图标 + 外侧去掉标签 + 放大页重排（CB-082） | #191 | DESIGN.md §96 |
| 2026-10-16 | 窄窗口里输入框两边也留白（CB-078） | #187 | DESIGN.md §92 |
| 2026-10-16 | 简单回合不出干活卡、开场一句进卡片、不画空气泡、答完下面不留空（CB-079） | #188 | DESIGN.md §93 |
| 2026-10-16 | 中途说明文字收进干活卡；断线重接不再写两遍（CB-077） | #185 | DESIGN.md §90 |
| 2026-10-16 | 「模型老断」：断线不再误报成连不上模型、自动接上；部署不再截断正在回答的一轮（CB-076） | #184 | DESIGN.md §89 |
| 2026-10-16 | 每个机器人记住操作状态；消息不再往回跳（CB-075） | #183 | DESIGN.md §88 |
| 2026-10-16 | 电脑文件夹导入失败不留半个工作区、删了的工作区不再挡住重新导入（CB-074） | #181 | DESIGN.md §87 |
| 2026-10-16 | 机器人 ↔ Claude Code 原地切换，不再整屏刷新（CB-072） | #175 | DESIGN.md §84 |
| 2026-10-16 | 打开对话落在最新一条、不跳；切机器人秒开；接入回放瘦身（CB-071） | #173 | DESIGN.md §83 |
| 2026-10-16 | 浏览器多标签 + 收藏夹（CB-081） | #190 | DESIGN.md §95、[browser-tabs.md](browser-tabs.md) |
| 2026-10-16 | 5 分钟内连续发消息不翻页上跳（CB-080） | #189 | DESIGN.md §94 |
| 2026-10-16 | 客户端 v0.1.15：PC 登录窗无边框圆角、弹窗一道边（Android vc 221） | #186 | DESIGN.md §91、[CHANGELOG](CHANGELOG.md) |
| 2026-10-16 | 长对话图片宽高预留 | #180 | DESIGN.md §83.2 |
| 2026-10-16 | UI 对齐第一、二轮（CB-070） | #172、#178、#182 | DESIGN.md §82 |
| 2026-10-16 | 客户端 v0.1.14：Android 原生第二轮（确认卡、附件、停止、重新生成 / 编辑） | #176 | DESIGN.md §86 |
| 2026-10-16 | Claude 上游代理支持 trojan / vless 等节点链接（CB-073） | #174、#177 | DESIGN.md §85 |
| 2026-10-16 | 新建 / 修改机器人一张表 + 圆形头像（CB-069） | #170 | DESIGN.md §81、[bot-avatars.md](bot-avatars.md) |
| 2026-10-16 | 客户端 v0.1.13：Android 原生版 Kotlin + Compose（CB-068） | #168 | DESIGN.md §80、[android-native.md](android-native.md) |
| 2026-10-16 | 客户端 v0.1.12：允许的文件夹之外批准即加入；PC 图标（外壳指纹变更） | #169 | [release.md](release.md) §3.3 |
| 2026-10-16 | 空聊天也有「计算机」 | #167 | DESIGN.md §79 |
| 2026-10-16 | Hark 第六轮：干活卡在原位、文档卡、面板像 Hark、等待的那几秒 | #164、#165、#166 | DESIGN.md §75–§78 |
| 2026-10-16 | 发版前功能精简：工作流 / 插件与 MCP / 权限规则 / 组件目录默认隐藏；新建机器人两格（CB-067） | #163 | DESIGN.md §74 |
| 2026-10-16 | 客户端 v0.1.11：电脑文件夹同步 P4a / P4b（CB-064） | #159、#160、#161 | DESIGN.md §73、[cloud-claude-code.md](cloud-claude-code.md) |
| 2026-10-15 | 客户端 v0.1.10：设备「打开」只做安全的打开（CB-030） | #156、#157 | — |
| 2026-10-15 | 只读工具中文说法、页面卡 / 任务卡标题、切暗色不卡（CB-021…024） | #152、#154、#155 | DESIGN.md §7.4、§70.3 |
| 2026-10-15 | 云端 Claude Code P0–P3 + 在云端完成登录 + 上游代理（CB-061…063、CB-066） | #148–#151、#153、#158 | DESIGN.md §73、ADR-0014 |
| 2026-10-15 | 商品 / 地点推荐带图卡片网格（CB-050）、长对话历史晚到停在底部（CB-047） | #146 | DESIGN §72 |
| 2026-10-15 | 瘦身 P4c-1：上游 Routines 并入定时任务，只剩一套（CB-015，约 8.6k 行） | #143 | DESIGN §55、[slimming.md](slimming.md) |
| 2026-10-15 | 成熟度 3c：设置左栏三组可折叠、默认只展开当前页所在组，笔记本上不用滚（CB-058） | #145 | DESIGN §71.7 |
| 2026-10-15 | 成熟度 3b：管理页说中文（插件目录、权限规则、活动记录），手机上活动记录一条一张卡（CB-056、CB-057） | #144 | DESIGN §71.6 |
| 2026-10-15 | 成熟度 3：「待处理」只放等你点头的事、手机上完全访问时长按钮、找不到的错误卡、文案、资料页模型名（CB-051…CB-055） | #142 | DESIGN §71 |
| 2026-10-15 | 干活卡结束后收成一行「搜索 2 次 · 看了 3 个网页」、提示词去免责段（CB-049 完成） | #141 | DESIGN §70.2 |
| 2026-10-15 | 干活卡：「思考中」换成当前步骤 · 第几步 · 用时（CB-049） | #139 | DESIGN §70 |
| 2026-10-15 | 对话像发短信：短气泡、草稿卡、回复引用、代码卡、提示词第二版（CB-048） | #138 | DESIGN §69 |
| 2026-10-15 | 只有一套聊天：`/bot` 并入频道聊天、删语音（CB-046） | #136、#137 | DESIGN §68、ADR-0013 |
| 2026-10-15 | 重新生成 / 编辑后重发，所有设备一致（CB-042） | #129 | DESIGN §67 |
| 2026-10-15 | 朋友账号：邀请链接、网关签名身份、按人隔离（CB-040） | #128 | DESIGN §65、[accounts.md](accounts.md)、ADR-0011 |
| 2026-10-15 | 发版说明 v0.1.9（PC + Android，versionCode 215） | #127 | [releasing.md](releasing.md) |
| 2026-10-15 | 本地 agent（Claude Code / Codex / OpenCode）与权限档位 只读 / 工作区 / 完全访问（CB-007、CB-008） | #126 | DESIGN §66 · [local-agents.md](local-agents.md) · ADR-0010 |
| 2026-10-15 | 成熟度 4：窄屏页面卡片只留外链图标、登录页不预填（CB-044） | #125 | DESIGN §54 |
| 2026-10-15 | 频道聊天刷新 / 换设备接着看正在写的回答（CB-041 P0、CB-043） | #124 | DESIGN §64 |
| 2026-10-15 | 成熟度 2：只填名字建机器人、空聊天「试试这样问」（CB-003） | #122 | DESIGN §63 |
| 2026-10-15 | 瘦身 P6-4：删上游桌面端残留（electron 插件、组织登录、host-access），清理 .env.example（约 3.5k 行，完整构建） | #135 | [slimming.md](slimming.md) |
| 2026-10-15 | 瘦身 P6-3：删 worker/、Intelligence 开通脚本，去掉 SSO / SCIM / Expo / OTel 依赖（约 1.8k 行，完整构建） | #134 | [slimming.md](slimming.md) |
| 2026-10-15 | 朋友账号入口默认隐藏、网关邀请默认关（多用户以后再做；撤回 #130） | #133 | DESIGN §65、[accounts.md](accounts.md) |
| 2026-10-15 | 瘦身 P6-2：去掉 SSO / SCIM 插件与身份提供者分支（约 1.2k 行） | #132 | [slimming.md](slimming.md) |
| 2026-10-15 | 瘦身 P6-1：去掉上游企业控制闸门、`/api/admin/enterprise`、`/api/admin/people`、OTel 导出（约 5k 行） | #131 | [slimming.md](slimming.md) |
| 2026-10-15 | 瘦身 P4b-3：去掉自动学习、身份提供者管理接口、Docker supervisor 配置（约 3.0k 行） | #123 | [slimming.md](slimming.md) |
| 2026-10-15 | 瘦身 P4b-2：去掉推送与可达性、群聊、团队机器人接口，交接默认关（约 4.6k 行） | #121 | [slimming.md](slimming.md) |
| 2026-10-15 | 瘦身 P4b-1：服务器不再加载演示录制、上游个人记忆、主动研究、意图路由（约 7.8k 行） | #117 | [slimming.md](slimming.md) |
| 2026-10-15 | 设备核心：编码工具、完全访问、服务器节点 chisabot-node（0.1.8；CB-004/005/006） | #119 | DESIGN §62 · [pc-node.md](pc-node.md) §12–§14 · ADR-0009 |
| 2026-10-15 | 备用模型：管理员排好的回退顺序、对话里说明换了模型、自检走回退（CB-035） | #118 | DESIGN §61 · [models.md](models.md) |
| 2026-10-15 | 瘦身 P3：删不发布的上游目录（约 10 万行）+ CI「ChisaBot checks」修绿 | #113 | [slimming.md](slimming.md) |
| 2026-10-15 | 瘦身 P4a：删前端死页（约 1.2 万行） | #116 | [slimming.md](slimming.md) · DESIGN §57 |
| 2026-10-15 | 瘦身 P2：示例部署包精简、开机清孤儿授权 / 包技能 / 包频道 | #110 | [slimming.md](slimming.md) |
| 2026-10-15 | 成熟度 1：额度用完自动换模型、报错说人话、工具栏中文、部署等待页（CB-003） | #115 | DESIGN §60 |
| 2026-10-15 | 生图 / 识图模型在模型设置里配，每个人可覆盖（CB-002） | #114 | DESIGN §59 · [chat-files.md](chat-files.md) |
| 2026-10-15 | 确认卡片 + 设置 → 审批偏好（CB-001） | #112 | DESIGN §58 |
| 2026-10-15 | 项目维护与文档系统：ROADMAP / BACKLOG / ADR / 贡献指南 / 模板（CB-012） | #111 | [README](README.md) · [CONTRIBUTING](../CONTRIBUTING.md) |
| 2026-10-15 | 瘦身 P1：导航收敛 | #109 | DESIGN §57 |
| 2026-10-14 | 聊天文件与图片生成 | #108 | DESIGN §56 · [chat-files.md](chat-files.md) |
| 2026-10-14 | 定时任务与提醒 | #107 | DESIGN §55 · [schedules.md](schedules.md) |
| 2026-10-14 | 页面（可分享网页） | #105 #106 | DESIGN §54 · [pages.md](pages.md) |
| 2026-10-14 | GitHub 账号连接 | #104 | DESIGN §53 · [github.md](github.md) |
| 2026-10-14 | 密钥保险箱 | #103 | DESIGN §52 · [vault.md](vault.md) |
| 2026-10-14 | 技能 | #102 | DESIGN §51 · [skills.md](skills.md) |
| 2026-10-14 | 长期记忆 | #101 | DESIGN §50 · [memory.md](memory.md) |
| 2026-10-14 | IM 接入 | #99 #100 | DESIGN §49 · [im.md](im.md) |
| 2026-10-14 | 链接卡 | #98 | DESIGN §48 |
| 2026-10-14 | 0.1.7：设备默认「询问」、PC 连接提示 | #94 #95 #96 | DESIGN §45 · [pc-node.md](pc-node.md) |

更早的见 [CHANGELOG](CHANGELOG.md)（按版本）和根 [CHANGELOG.md](../CHANGELOG.md)。
