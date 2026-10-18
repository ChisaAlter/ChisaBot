# Backlog（议题清单）

> 状态最后核对：2026-10-17（origin/main `0e23321`）。
>
> **为什么是文件**：仓库的 GitHub Issues 目前是关闭的（fork 默认关闭，自动化令牌没有仓库管理权限，开不了）。在仓库所有者打开
> Settings → General → Features → Issues 之前，这里就是 issue 列表；打开之后每一条按 ID 原样建成 GitHub issue，标签、里程碑、
> 验收标准一致，这个文件改成索引（ID → issue 编号）。标签和里程碑已经在 GitHub 上建好。

规则：

- 一条 = 一个可验收的结果。新需求先在这里加一条（下一个 ID），再开分支；PR 描述写 `Backlog: CB-0xx`。
- 状态写在标签行：`status: in-progress`（有人在做）、`blocked`（写明卡在哪）、`needs-user`（要用户操作 / 决定）、`deferred`（以后再做）。
- 做完：勾掉验收标准，整条移到文末「已完成」，写 PR 号和合并提交。
- 优先级：P0 立刻 / P1 这一轮 / P2 排队。里程碑见 [ROADMAP](ROADMAP.md)。

| ID | 标题 | 里程碑 | 标签 |
|---|---|---|---|
| [CB-001](#cb-001) | 审批卡片与审批偏好（Hark parity 第 5 项） | Hark parity | `type: feat` · `area: approvals` · `area: chat` · `P1` · `status: done` |
| [CB-002](#cb-002) | 生图 / 识图模型设置：管理员默认 + 每人可覆盖 | Hark parity | `type: feat` · `area: images` · `area: settings` · `P1` · `status: done` |
| [CB-003](#cb-003) | 成熟度扫查：设备流程优先的全量体验检查 | 成熟度 Maturity | `type: chore` · `area: devices` · `area: chat` · `P1` · `status: done`（三轮已上线） |
| [CB-004](#cb-004) | 设备上的编码工具：云端机器人读 / 改 / 写本地代码 | 设备核心 Devices core | `type: feat` · `area: devices` · `area: pc` · `P0` · `status: done` |
| [CB-005](#cb-005) | 无界面设备节点：Linux / macOS 服务器也能当设备 | 设备核心 Devices core | `type: feat` · `area: devices` · `area: infra` · `P1` · `status: done` |
| [CB-006](#cb-006) | 设备「完全访问」模式（像本地 OpenClaw / Hermes） | 设备核心 Devices core | `type: feat` · `area: devices` · `area: approvals` · `P1` · `status: done` |
| [CB-007](#cb-007) | 本地 agent 运行时与 agent 选择（可选） | 设备核心 Devices core | `type: feat` · `area: agents` · `area: devices` · `P1` · `status: done` |
| [CB-008](#cb-008) | 本地 agent 的沙箱 / 权限配置档 | 设备核心 Devices core | `type: feat` · `area: agents` · `area: approvals` · `P1` · `status: done` |
| [CB-009](#cb-009) | 瘦身 P3：删不发布的目录 + 修 server-typecheck CI | 精简 Slim | `type: chore` · `area: slim` · `area: infra` · `P1` · `status: done` |
| [CB-010](#cb-010) | 瘦身 P4a：删前端死页 | 精简 Slim | `type: chore` · `area: slim` · `area: settings` · `P1` · `status: done` |
| [CB-011](#cb-011) | 瘦身 P4b：不再构造上游服务端模块（表保留） | 精简 Slim | `type: chore` · `area: slim` · `area: infra` · `P1` · `status: done` |
| [CB-012](#cb-012) | 项目维护与文档系统（labels / milestones / ROADMAP / ADR / 模板） | 成熟度 Maturity | `type: docs` · `area: docs` · `P1` · `status: done（Issues 待仓库所有者打开）` |
| [CB-013](#cb-013) | Google 账号连接（Hark parity 最后一项） | Hark parity | `type: feat` · `area: settings` · `P2` · `status: deferred` |
| [CB-014](#cb-014) | 每日简报（Hark parity 第 9 项，可选） | Hark parity | `type: feat` · `area: schedules` · `P2` · `status: deferred` |
| [CB-015](#cb-015) | 瘦身 P4c：合并重复系统（依赖并行功能） | 精简 Slim | `type: chore` · `area: slim` · `P2` · `status: blocked` |
| [CB-016](#cb-016) | 瘦身 P5：DROP 上游空表（P4 稳定 ≥ 2 周后） | 精简 Slim | `type: chore` · `area: slim` · `area: infra` · `P2` · `status: blocked` |
| [CB-017](#cb-017) | 真机验证：Windows PC 客户端与安卓手机 | 0.2.0 release | `type: chore` · `area: pc` · `area: android` · `P1` · `status: needs-user` |
| [CB-018](#cb-018) | 用户的电脑需要手动重装 PC 0.1.x（现为 0.1.15）（0.2.x 不会自动更新） | 0.2.0 release | `type: chore` · `area: pc` · `P1` · `status: needs-user` |
| [CB-019](#cb-019) | 发版 0.2.0（PC + Android） | 0.2.0 release | `type: chore` · `area: infra` · `area: pc` · `area: android` · `P1` |
| [CB-020](#cb-020) | CI「ChisaBot checks」server-typecheck 在 main 上一直失败 | 精简 Slim | `type: bug` · `area: infra` · `P1` · `status: done` |
| [CB-021](#cb-021) | 一轮里两次 page_update 会出两张同一页面的卡片 | 成熟度 Maturity | `type: bug` · `area: pages` · `area: chat` · `P2` · `status: done` |
| [CB-022](#cb-022) | 只读工具的结果没有卡片（只有文字） | 成熟度 Maturity | `type: feat` · `area: chat` · `P2` · `status: done` |
| [CB-023](#cb-023) | 后台任务卡片在参数流完前显示笼统的「正在交给后台…」 | 成熟度 Maturity | `type: bug` · `area: chat` · `P2` · `status: done` |
| [CB-024](#cb-024) | 切换暗色外观卡约 400ms（毛玻璃重绘已修，长对话主线程见 CB-025） | 成熟度 Maturity | `type: perf` · `area: chat` · `area: settings` · `P2` · `status: done` |
| [CB-025](#cb-025) | 打开长对话首屏渲染约 1 秒 | 成熟度 Maturity | `type: perf` · `area: chat` · `P2` · `status: done` |
| [CB-026](#cb-026) | chisabot_bot_threads：确认没有孤儿指针行 | 成熟度 Maturity | `type: chore` · `area: chat` · `P2` |
| [CB-027](#cb-027) | IM 定时推送受平台被动回复窗口限制 | 成熟度 Maturity | `type: bug` · `area: im` · `area: schedules` · `P2` |
| [CB-028](#cb-028) | 「开场一句」只在显示时折叠，事件历史里仍保存 | 成熟度 Maturity | `type: chore` · `area: chat` · `P2` |
| [CB-029](#cb-029) | 弹窗打开动画仍有毛玻璃开销 | 成熟度 Maturity | `type: perf` · `area: settings` · `P2` · ✅ 0.1.38 |
| [CB-030](#cb-030) | 设备能力「打开」实际可执行任意命令，却标为非危险 | 设备核心 Devices core | `type: bug` · `area: devices` · `area: pc` · `P1` · `status: done` |
| [CB-031](#cb-031) | 本地对话事件表无上限增长 | 成熟度 Maturity | `type: chore` · `area: chat` · `area: infra` · `P2` |
| [CB-032](#cb-032) | 安卓签名改为 CI 内签名（需要仓库 Actions secrets） | 0.2.0 release | `type: chore` · `area: android` · `area: infra` · `P2` · `status: needs-user` |
| [CB-033](#cb-033) | 生产跨部署 stale-chunk 测试待跑 | 成熟度 Maturity | `type: chore` · `area: infra` · `P2` |
| [CB-034](#cb-034) | 用真实账号验证 GitHub 连接与 IM 接入 | 成熟度 Maturity | `type: chore` · `area: github` · `area: im` · `P2` · `status: needs-user` |
| [CB-035](#cb-035) | 备用模型：管理员排序的回退列表 + 对话里说明换了模型 + 自检走回退 | 成熟度 Maturity | `type: bug` · `area: models` · `area: chat` · `P0` · `status: done` |
| [CB-040](#cb-040) | 多用户：管理员给朋友开账号（每人独立的机器人 / 记忆 / 密钥 / 设备） | 成熟度 Maturity | `type: feat` · `area: infra` · `area: settings` · `P0` · `status: done（入口默认隐藏）` |
| [CB-041](#cb-041) | 真实聊天路径（频道聊天）刷新 / 断网后正在写的回答丢失 | 成熟度 Maturity | `type: bug` · `area: chat` · `P0` · `status: done` |
| [CB-042](#cb-042) | 重新生成 / 编辑后重发 | 成熟度 Maturity | `type: feat` · `area: chat` · `P1` · `status: done` |
| [CB-043](#cb-043) | 频道聊天的跨设备实时同步（手机发的桌面看不到） | 成熟度 Maturity | `type: bug` · `area: chat` · `area: pwa` · `P1` · `status: done` |
| [CB-044](#cb-044) | 登录页预填管理员账号名 | 成熟度 Maturity | `type: bug` · `area: infra` · `P1` · `status: done` |
| [CB-045](#cb-045) | 每人模型额度 / 用量上限 | 成熟度 Maturity | `type: feat` · `area: models` · `P2` |
| [CB-046](#cb-046) | 两套聊天实现（/bot 与 /channel）收成一套 | 成熟度 Maturity | `type: chore` · `area: chat` · `P1` · `status: done` |
| [CB-047](#cb-047) | 很长的对话打开时历史晚到，画面停在上面 | 成熟度 Maturity | `type: bug` · `area: chat` · `P2` · `status: done`（#146，继续观察） |
| [CB-048](#cb-048) | 对话像发短信：先答、短气泡、不讲方法、草稿卡 / 代码卡 / 回复引用（完成） | Hark parity | `type: feature` · `area: chat` · `P1` |
| [CB-049](#cb-049) | 主对话干活卡：当前步骤 + 用时，结束收成一行（完成） | Hark parity | `type: feature` · `area: chat` · `P1` |
| [CB-050](#cb-050) | 商品 / 地点推荐用带图的卡片网格（完成） | Hark parity | `type: feature` · `area: chat` · `P2` |
| [CB-051](#cb-051) | 「待处理」页是上游审批页：重复的开关、英文、已不存在的桌面应用、团队规则（完成） | 成熟度 Maturity | `type: bug` · `area: approvals` · `area: settings` · `P1` |
| [CB-052](#cb-052) | 手机上设备「完全访问」时长按钮一个字一行（完成） | 成熟度 Maturity | `type: bug` · `area: devices` · `area: pwa` · `P1` |
| [CB-053](#cb-053) | 找不到 / 读不到：机器人、对话只有一行红字没有出路；连接器页标题是原始 key（完成） | 成熟度 Maturity | `type: bug` · `area: settings` · `P2` |
| [CB-054](#cb-054) | 机翻 / 上游行话残留：账号连接空状态、「AI 同事」（完成） | 成熟度 Maturity | `type: bug` · `area: settings` · `P2` |
| [CB-055](#cb-055) | 机器人资料页模型下拉显示原始模型 id（完成） | 成熟度 Maturity | `type: bug` · `area: models` · `P2` |
| [CB-056](#cb-056) | 管理页英文：插件目录说明、权限规则快捷规则说明、活动记录事件类型（完成） | 成熟度 Maturity | `type: bug` · `area: settings` · `P2` |
| [CB-057](#cb-057) | 活动记录表格在 390 宽被截掉右边几列（完成） | 成熟度 Maturity | `type: bug` · `area: settings` · `area: pwa` · `P2` |
| [CB-058](#cb-058) | 设置左栏在 1280×860 下「管理 / 高级」7 项在可视区外，只有淡出提示（完成） | 成熟度 Maturity | `type: chore` · `area: settings` · `P2` |
| [CB-061](#cb-061) | 云端 Claude Code P1：云端工作区节点 + 网页登录 Claude | 设备核心 Devices core | `type: feat` · `area: agents` · `area: infra` · `P1` · `status: done`（#149）· 真实 Claude 登录 `needs-user` |
| [CB-062](#cb-062) | 云端 Claude Code P2：左栏切换、会话、对话、审批、右栏 / 手机抽屉 | 设备核心 Devices core | `type: feat` · `area: agents` · `area: chat` · `P1` · `status: done`（#150） |
| [CB-063](#cb-063) | 云端 Claude Code P3：GitHub 工作区（克隆、cc/ 分支、合入、推送并开 PR） | 设备核心 Devices core | `type: feat` · `area: agents` · `area: github` · `P1` · `status: done`（#151）· 连 GitHub `needs-user` |
| [CB-064](#cb-064) | 云端 Claude Code P4：电脑文件夹同步（PC 新版） | 0.2.0 release | `type: feat` · `area: pc` · `area: agents` · `P2` · `status: done`（#159、#160，v0.1.11）· 真机待验证 |
| [CB-065](#cb-065) | 云端 Claude Code P5：ChisaCloudCode 留还是下线 | 设备核心 Devices core | `type: chore` · `area: infra` · `P2` · `status: needs-user` |
| [CB-066](#cb-066) | 在云端完成 Claude 登录（远程浏览器）+ Claude 上游代理 | 设备核心 Devices core | `type: feat` · `area: agents` · `area: infra` · `P1` · `status: done`（#153、#158、#174、#177）· 登录 `needs-user` |
| [CB-067](#cb-067) | 新版本前功能精简：隐藏用不到的功能、新建机器人两格 | 精简 Slim | `type: chore` · `area: web` · `P1` · `status: done`（#163）· 4 项待所有者决定 |
| [CB-068](#cb-068) | Android 原生版（Kotlin + Compose） | 成熟度 Maturity | `type: feature` · `area: android` · `P1` · `status: done`（#168 v0.1.13、#176 v0.1.14） |
| [CB-069](#cb-069) | 新建 / 修改机器人统一表单 + 圆形头像（上传 / 表情 / 首字） | 成熟度 Maturity | `type: feat` · `area: web` · `P1` · `status: done`（#170） |
| [CB-070](#cb-070) | 全站 UI 文字对齐 + 干活卡上下间距 | 成熟度 Maturity | `type: fix` · `area: web` · `P1` · `status: done`（#172、#178、#182） |
| [CB-071](#cb-071) | 打开对话落在最新一条、不跳；切机器人秒开；接入回放瘦身 | 成熟度 Maturity | `type: bug` · `area: chat` · `P0` · `status: done` |
| [CB-072](#cb-072) | 机器人 ↔ Claude Code 切换整屏刷新 → 原地切换 | 成熟度 Maturity | `type: bug` · `area: web` · `P1` · `status: done` |
| [CB-073](#cb-073) | Claude 上游代理支持 trojan / vless 等节点链接（sing-box 转换） | 云端 Claude Code | `type: feature` · `area: cloud-cc` · `P1` · `status: done` |
| [CB-074](#cb-074) | 电脑文件夹导入失败后残留、移除后无法重新导入 | 成熟度 Maturity | `type: bug` · `area: pc` · `area: agents` · `P0` · `status: done` |
| [CB-077](#cb-077) | 中途说明文字没折叠进步骤；断线重接同一段话出现两遍 | 成熟度 Maturity | `type: bug` · `area: chat` · `P0` · `status: done` |
| [CB-075](#cb-075) | 每个机器人记住我的操作状态；消息记录仍会往回跳 | 成熟度 Maturity | `type: bug` · `area: chat` · `P0` · `status: done` |
| [CB-076](#cb-076) | 「模型老断」：长命令 / 断线 / 部署重启时这一轮被误报成「连不上模型服务」 | 成熟度 Maturity | `type: bug` · `area: chat` · `P0` · `status: done` |
| [CB-078](#cb-078) | 窄窗口里输入框两边没有间距 | 成熟度 Maturity | `type: bug` · `area: web` · `P1` · `status: done` |
| [CB-079](#cb-079) | 简单回合隐藏步骤卡；回答下面的空气泡和多余空白 | 成熟度 Maturity | `type: bug` · `area: chat` · `P1` · `status: done` |
| [CB-080](#cb-080) | 连续聊天时发消息整页上跳 | 成熟度 Maturity | `type: bug` · `area: chat` · `P1` · `status: done` |
| [CB-081](#cb-081) | 机器人浏览器多标签 + 收藏夹 | 成熟度 Maturity | `type: feat` · `area: computer` · `P1` · `status: done` |
| [CB-082](#cb-082) | 浏览器暗色图标 + 外侧去掉标签 + 放大页重排 + 旧测试 | 成熟度 Maturity | `type: bug` · `area: computer` · `P1` · `status: done` |
| [CB-083](#cb-083) | 设置重新整合 + 设置搜索；输入框权限（请求批准 / 完全访问） | 成熟度 Maturity | `type: feat` · `area: web` · `area: devices` · `P1` · `status: done` |
| [CB-084](#cb-084) | 从其他页面切回机器人页总要刷新一次 | 成熟度 Maturity | `type: bug` · `area: chat` · `area: web` · `P1` · `status: done` |

## CB-001

**审批卡片与审批偏好（Hark parity 第 5 项）**  
里程碑：Hark parity · 标签：`type: feat` `area: approvals` `area: chat` `P1` `status: done`

#### 背景

机器人做需要确认的事（花钱、发消息、写操作、设备上的危险能力）时，在聊天里出审批卡片；用户可以设「这类事不用问我 / 一律先问我」的偏好，机器人照着做。上游 server/src/approvals/（policy.ts allow/pre_approved/ask/hand_off）是起点。

#### 验收标准

- [ ] 聊天里出审批卡片：允许 / 拒绝，服务器原子地 pending→running，第二台设备 / 第二次点击不会重复执行
- [ ] 设置里能看到、改、删审批偏好；机器人每轮读到偏好并遵守
- [ ] 设备「询问」能力、GitHub 写操作沿用同一套卡片（或明确说明为什么不合并）
- [ ] 单测 + 预览 e2e + 生产一次性机器人 e2e 通过；聊天滚动回归 7/7
- [ ] DESIGN.md 新章节 + docs/approvals.md + CHANGELOG Unreleased

#### 相关

- 上游：server/src/approvals/、app/src/routes/_authed/_app/approvals.tsx
- 瘦身 P4c ⑤：合并后删团队审批规则、权限规则并入

> 完成：#112（合并 a679db3，2026-10-15），DESIGN.md §58。确认卡片在频道聊天里沿用（#136，§68）。

## CB-002

**生图 / 识图模型设置：管理员默认 + 每人可覆盖**  
里程碑：Hark parity · 标签：`type: feat` `area: images` `area: settings` `P1` `status: done`

#### 背景

§56 的生图目前只有管理员一个开关和一套接口（MiniMax image-01）。需要在「模型」设置里分别选生图模型和识图（看图）模型，管理员给默认值，每个用户可以覆盖成自己的。

#### 验收标准

- [ ] 设置里能分别选生图模型、识图模型；管理员设部署默认，用户可覆盖，清空覆盖回到默认
- [ ] image_generate / image_edit 和读图走所选模型；没配置时机器人如实说明去哪里配
- [ ] 密钥不进模型、不进日志（复用 §52 / 模型密钥）
- [ ] 测试 + 生产 e2e；DESIGN.md 章节、docs/chat-files.md 更新、CHANGELOG

#### 相关

- DESIGN.md §56、docs/chat-files.md

> 完成：#114（合并 5a7bdca，2026-10-15），DESIGN.md §59、docs/chat-files.md。

## CB-003

**成熟度扫查：设备流程优先的全量体验检查**  
里程碑：成熟度 Maturity · 标签：`type: chore` `area: devices` `area: chat` `P1` `status: done`

#### 背景

目标是「相对成熟、可以分享给朋友」。按真实用户路径把每个功能走一遍（设备流程优先），把发现的问题逐条记下并修。

#### 验收标准

- [x] 扫查清单覆盖：登录、新建机器人、聊天（流式 / 卡片 / 排队 / 后台任务）、设备关联与权限、记忆、技能、密钥、GitHub、页面、定时、文件与生图、IM、设置导航（2026-10-15 第一轮：设备流程 + 聊天 + 19 页 × 4 视图巡检；结果见 DESIGN.md §60 与 PR 描述）
- [x] 扫查第二轮（2026-10-15 03:00 起）：新朋友视角走真实路径（登录 → 建机器人 → /channel 聊天 → 上传 / 记忆 / 提醒 / 页面 / 停止 / 刷新 / 手机），见 DESIGN.md §63；新发现记为 CB-040…CB-046
- [ ] 每个问题变成一个 issue（type: bug，带 area 和优先级），能当场修的随 PR 修掉并关闭
- [ ] 宽 1280 / 窄 420 / 暗色三种截图证据
- [ ] 扫查结果汇总进 ROADMAP「现在」

> 第 1 轮 #115（§60）、第 2 轮 #122 / #124 / #125（§63 / §64）已上线。**第 3 轮已上线**（2026-10-15，#142 / #144 / #145，DESIGN §71）：非聊天页面（设置各栏、机器人资料、设备、页面、技能、记忆、密钥、GitHub、IM、面板、审批、模型、404 / 空 / 错误状态），1280 亮 / 390 暗，新朋友视角；缺陷记为 CB-051 起。完成时在 PR 里 `Backlog: CB-003`（issue 开启后改为 `Closes #编号`），同一个 PR 更新 docs/ 与 CHANGELOG.md（见 [CONTRIBUTING.md](../CONTRIBUTING.md)）。

## CB-004

**设备上的编码工具：云端机器人读 / 改 / 写本地代码**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: devices` `area: pc` `P0` `status: done`

#### 背景

用户核心诉求（2026-10-15）：在任何地方管理所有设备，云端机器人能读、改、写本地电脑上的文件和代码。现有 device_* 只有截图、打开、命令、读写文件等粗粒度能力。

#### 验收标准

- [x] 机器人能在授权文件夹里：列目录、按内容搜索、读文件片段、精确替换编辑、新建文件、跑测试 / 构建命令并看到输出
- [x] 每个写操作经过设备权限（关闭 / 询问 / 允许）和审计记录；危险命令仍要本机确认
- [x] 大文件 / 大输出截断并说明；二进制文件拒绝
- [ ] 在 PC 节点和无界面节点上都能用；预览 + 生产 e2e
- [x] docs/pc-node.md 与 DESIGN.md 更新、CHANGELOG

#### 相关

- DESIGN.md §16、§45；docs/pc-node.md

> 完成（2026-10-15，分支 feat/devices-1，0.1.8）：`device_search` / 按行读 / `device_edit_file` / `device_apply_patch` / `device_git` / 后台命令 + 持久会话 / 进程 / 传文件；审批卡片（聊天卡片、设置 → 设备、PC 弹窗）显示 diff。无界面节点上预览 + 生产 e2e 通过（真实编码循环：克隆 → 跑测试失败 → 搜索 / 读 / 精确替换 → 测试通过 → 提交）。**未勾的一项**：Windows PC 节点只有单元测试（同一套 agent 代码），真机验证随 0.1.8 PC 发版后做（CB-017）。

## CB-005

**无界面设备节点：Linux / macOS 服务器也能当设备**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: devices` `area: infra` `P1` `status: done`

#### 背景

除了 Windows 上的 ChisaBot PC，用户的 Linux 服务器、Mac 也要能关联成设备，让机器人去操作。

#### 验收标准

- [x] 一条命令安装 / 关联（令牌一次性），systemd / launchd 常驻，断线重连
- [x] 出现在 设置 → 设备，能力与权限模型和 PC 一致
- [x] 不需要图形界面；截图类能力在无显示器时如实报不可用
- [x] 安装、升级、卸载写进 docs/pc-node.md（或新 docs/node.md）

> 完成（2026-10-15，feat/devices-1）：设置 → 设备 →「添加一台服务器」生成一行安装命令（30 分钟有效的一次性安装码）；`chisabot-node` 和 PC 用同一套 agent 代码；有 systemd 时注册服务（root 系统级 / 普通用户 user 级），macOS 用 launchd；断线自动重连。e2e 在无 systemd 的一次性容器里跑（手动运行路径）；systemd / launchd 服务安装只有代码路径与单元测试，未在真机上验证。文档 docs/pc-node.md §14。

## CB-006

**设备「完全访问」模式（像本地 OpenClaw / Hermes）**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: devices` `area: approvals` `P1` `status: done`

#### 背景

用户希望 PC 能给机器人「完全权限」，同时保留权限控制 / 沙箱：一个明确的模式切换，而不是逐项打开七个能力。

#### 验收标准

- [x] 设备上有「完全访问」开关，打开前一次清楚的风险确认（本机 + 网页都显示状态）
- [x] 完全访问下命令 / 文件 / 键鼠不再逐次询问，但全部写审计，有一键急停（kill switch）
- [x] 随时可以退回「询问」；服务器重启后状态保持
- [x] ADR 记录这个取舍；DESIGN.md + docs/pc-node.md 更新

> 完成（2026-10-15，feat/devices-1）：1 小时 / 24 小时 / 永久，只能主人在网页打开（PC 本机再确认一次），机器人无法打开；急停 / 到期自动关闭；状态存 `devices.full_access_until`（服务器重启后保持，有真库回归测试）。ADR-0009，docs/pc-node.md §13。

## CB-007

**本地 agent 运行时与 agent 选择（可选）**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: devices` `P1` `status: done`

#### 背景

默认仍是「云端 agent + 设备节点」（见 ADR-0003）。用户说「做」：允许在设备上跑本地 agent 运行时（如 Claude Code / Codex 一类 CLI agent），并在机器人上选择由哪个 agent 回答。

#### 验收标准

- [x] 设备上自动检测可用的本地 agent（Claude Code / Codex / OpenCode / Gemini CLI / Aider + 内置循环），设置 → 设备 → 本地 agent 选默认；聊天里可以点名。**改动**：不做「机器人资料页整体换成本地 agent 回答」，改为按任务交接（ADR-0010 写明原因）
- [x] 本地 agent 的输出以聊天任务卡片呈现（实时输出、停止、改动、应用 / 放弃），结果回到同一段对话（沿用 §38）
- [x] 设备离线 / 没装 / 档位不允许时，机器人拿到中文原因，卡片不出现
- [x] 文档：docs/local-agents.md（含 OpenBot 服务器 agent 与 Claude Code / Codex 的对比）、ADR-0010、DESIGN.md §66

> 完成：PR feat/local-agent-1（`Backlog: CB-007`）。真机 Windows / macOS 验证归 CB-017。

## CB-008

**本地 agent 的沙箱 / 权限配置档**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: approvals` `P1` `status: done`

#### 背景

本地 agent 运行时需要成套的权限配置档（只读 / 工作区可写 / 完全访问 等），和设备能力、审批偏好一致。

#### 验收标准

- [x] 三档：只读 / 工作区 / 完全访问，界面上每档一句话；完全访问 = ADR-0009 的设备开关（有时限）
- [x] 档位在服务器的设备 hub 上强制执行（档位之外 → 审批卡片，摘要写明档位），改档位写设备审计；内置 agent 在电脑上按真实路径再判一次
- [x] 和完全访问、审批偏好不冲突：只收紧不放宽，优先级写在 docs/local-agents.md §2 和 ADR-0010；隔离方式（worktree / 副本 / bubblewrap / sandbox-exec / Docker / WSL）和联网开关

> 完成：PR feat/local-agent-1（`Backlog: CB-008`）。

## CB-009

**瘦身 P3：删不发布的目录 + 修 server-typecheck CI**  
里程碑：精简 Slim · 标签：`type: chore` `area: slim` `area: infra` `P1` `status: done`

#### 背景

删 desktop/（Tauri）、mobile/（Expo）、14 个 agent-*、charts/、spire/、supervisor/、worker/、多余 examples 与对应 CI / renovate 配置。worker/ 在 workspaces 与 Dockerfile 里，删了会改依赖指纹 → 一次完整更新。

#### 验收标准

- [x] 上述目录删除，examples/fintech 测试夹具保留（多个测试与 scripts/create-zh-tenant.ts 用它），worker/ 挪到 P4b（依赖指纹）
- [x] P3 没改依赖指纹（bun.lock / package.json / Dockerfile 一字未动）→ 快速更新；worker/ 与依赖变化放 P4b
- [x] CI「ChisaBot checks」server-typecheck 变绿（关联 issue 一起关掉）
- [x] docs/slimming.md 记 P3 结果；CHANGELOG

#### 相关

- 审查报告 §5；docs/slimming.md

> 完成：#113（见 docs/slimming.md「P3」）。

## CB-010

**瘦身 P4a：删前端死页**  
里程碑：精简 Slim · 标签：`type: chore` `area: slim` `area: settings` `P1` `status: done`

#### 背景

P1 已把这些页面隐藏 / 重定向：/agents、/team-bots、/group/*、/reachability、/memory（旧）、/admin/{people,enterprise,identity-providers,learning,playground}、/settings/components-gallery、/settings/passwords。删掉它们和只被它们用的 components/、lib/。

#### 验收标准

- [x] 页面与独占组件删除，旧地址仍重定向
- [x] app tsc / build / DOM 测试全过；初始 JS 不变大
- [x] docs/slimming.md、CHANGELOG

> 完成：#116（见 docs/slimming.md「P4a」）。

## CB-011

**瘦身 P4b：不再构造上游服务端模块（表保留）**  
里程碑：精简 Slim · 标签：`type: chore` `area: slim` `area: infra` `P1` `status: done`

#### 背景

移除并不再在 index.ts 构造：team-bots、群聊与 coordination/hand_off、delivery（Slack/Teams/Twilio/push）、proactive、上游 personal memory、learning、routing、demonstrations、SCIM/SSO/身份提供者、企业 gate（先把 model_connection 读写改为独立 KV）、supervisor 客户端；语音改为功能开关默认关。

#### 验收标准

- [ ] 上述模块不再加载，表与数据不动（回滚镜像即可恢复）
- [ ] server 测试、tsc、预览 e2e、生产自检通过
- [ ] docs/slimming.md 记录每个模块的处理与依赖

> 完成：P4b-1 #117、P4b-2 #121、P4b-3 #123、P6-1 #131（企业闸门）、P6-2 #132（SSO / SCIM）、P6-3 #134（worker/ 与依赖）、P6-4 #135（上游桌面端残留）、删语音 #137（2026-10-15）。表与数据未动。还剩的重复系统合并（定时任务 ↔ routines 等）归 CB-015（P4c），删空表归 CB-016（P5）。

## CB-012

**项目维护与文档系统（labels / milestones / ROADMAP / ADR / 模板）**  
里程碑：成熟度 Maturity · 标签：`type: docs` `area: docs` `P1` `status: done（Issues 待仓库所有者打开）`

#### 背景

用户 2026-10-15：「我们最近需求比较多比较杂，你要建立良好的项目维护系统和文档系统。」

#### 验收标准

- [ ] 标签、里程碑、在做 / 推迟 / 已知问题都有 issue，带验收标准
- [ ] docs/README.md 索引、docs/ROADMAP.md、docs/architecture.md、docs/ops/deploy.md、docs/adr/、docs/dev/parallel-work.md
- [ ] CONTRIBUTING.md、PR 模板、issue 模板（bug / feature）
- [ ] DESIGN.md 顶部章节索引；CHANGELOG Unreleased 补齐 §49–§57

> 完成：#111（合并 4fc6f10，2026-10-15）：docs/README.md 索引、ROADMAP、architecture、ops/deploy、adr/、dev/parallel-work、CONTRIBUTING、PR / issue 模板、DESIGN 章节索引。**未勾的一项**：GitHub Issues 在仓库上是关闭的，自动化令牌打不开；仓库所有者打开后按 ID 原样建 issue。

## CB-013

**Google 账号连接（Hark parity 最后一项）**  
里程碑：Hark parity · 标签：`type: feat` `area: settings` `P2` `status: deferred`

#### 背景

用户 2026-10-14 20:01：「Google账号不急」——放在 Hark parity 最后做。需要管理员在 Google Cloud 注册 OAuth 客户端。

#### 验收标准

- [ ] 设置 → 账号连接 里能连 Google（Gmail / 日历 / Drive 只读起步），令牌存保险箱
- [ ] 写操作（发邮件、建日程）走审批卡片
- [ ] 没配置 OAuth 客户端的部署里入口如实说明怎么配

## CB-014

**每日简报（Hark parity 第 9 项，可选）**  
里程碑：Hark parity · 标签：`type: feat` `area: schedules` `P2` `status: deferred`

#### 背景

PARALLEL.md 里的可选第 9 项：每天固定时间机器人把天气、日程、待办、关注的信息汇成一条简报。可以建立在 §55 定时任务之上。

#### 验收标准

- [ ] 用户在聊天里说一句就能设、改时间、停
- [ ] 内容来源可配置，空的部分不显示
- [ ] 推送到网页通知 / IM

## CB-015

**瘦身 P4c：合并重复系统（依赖并行功能）**  
里程碑：精简 Slim · 标签：`type: chore` `area: slim` `P2` `status: blocked`

#### 背景

等相关功能合并后再做：① 旧面板（bot_panel_*）→ 实时面板；② components 存储 → render_ui；③ host_* → device_*；④ 删 responsibilities、wake-up 并入定时任务；⑤ 审批合并后删团队审批规则、权限规则并入；⑥「账号与保险箱」合并；⑦ 决定 Composio 去留。

#### 验收标准

- [ ] 每一项一个 PR，只增不删数据
- [ ] 每项合并前确认依赖功能已上线并稳定
- [ ] docs/slimming.md 逐项记录

#### 进度

- [x] P4c-1（2026-10-15，#143）：上游 Routines（`routines` 工具 / 页面 / 扫描 / 接口）并入 ChisaBot 定时任务 §55，表留到 P5

#### 相关

- 审批（#112）、设备（#119）已合并，不再卡住。2026-10-15 起在做（分支 chore/slim-p4c），第一项：例行任务（routines）并入定时任务（§55）。

## CB-016

**瘦身 P5：DROP 上游空表（P4 稳定 ≥ 2 周后）**  
里程碑：精简 Slim · 标签：`type: chore` `area: slim` `area: infra` `P2` `status: blocked`

#### 背景

一个迁移 DROP 所有确认 0 行且无代码引用的上游表（约 60 张）。不可逆：旧镜像在 DROP 后不能直接回滚。

#### 验收标准

- [ ] 迁移前启动时断言这些表为 0 行，否则中止
- [ ] 迁移前 pg_dump 全库；回滚脚本先恢复库再换镜像
- [ ] 最早在 P4b 上线后 2 周

#### 相关

- 卡在：P4b 上线时间 + 2 周

## CB-017

**真机验证：Windows PC 客户端与安卓手机**  
里程碑：0.2.0 release · 标签：`type: chore` `area: pc` `area: android` `P1` `status: needs-user`

#### 背景

0.1.3–0.1.7 的 PC / 安卓改动（图标刷新、小窗、代理、设备默认询问、扫码绑定、PWA 安装、键盘与安全区）都只在模拟环境验证过。

#### 验收标准

- [ ] 真实 Windows：安装、自动更新、图标、小窗、设备连接与权限审批
- [ ] 真实安卓：扫码绑定、撤销后退出、更新
- [ ] iOS Safari 添加到主屏幕、安卓 Chrome 安装 PWA
- [ ] 问题逐条开 issue

## CB-018

**用户的电脑需要手动重装 PC 0.1.x（现为 0.1.15）（0.2.x 不会自动更新）**  
里程碑：0.2.0 release · 标签：`type: chore` `area: pc` `P1` `status: needs-user`

#### 背景

版本号归正为 0.1.x 之后，装着内部 0.2.x 构建的电脑永远不会自动更新到 0.1.x；PC 里已有「需要重新安装」提示（§45）。

#### 验收标准

- [ ] 用户卸载旧版、安装 0.1.7（或更新的版本）
- [ ] 设备页显示在线、能力为「询问」，机器人能截图 / 读文件

## CB-019

**发版 0.2.0（PC + Android）**  
里程碑：0.2.0 release · 标签：`type: chore` `area: infra` `area: pc` `area: android` `P1`

#### 背景

汇总 0.1.7 之后合并的服务器 / 网页 / 客户端变化发一次正式版本。

#### 验收标准

- [ ] CHANGELOG Unreleased 整理成 0.2.0
- [ ] 版本号同步（root、pc、android versionName / versionCode 递增）
- [ ] release notes（.github/release-notes/v0.2.0.md / .android.txt）
- [ ] 签名 APK + PC 安装包 + 更新源
- [ ] 真机验证 issue 关闭

#### 相关

- docs/releasing.md、docs/ops/deploy.md

## CB-020

**CI「ChisaBot checks」server-typecheck 在 main 上一直失败**  
里程碑：精简 Slim · 标签：`type: bug` `area: infra` `P1` `status: done`

#### 背景

至少从 0.1.3 起每个 main 提交都失败（本地镜像里 tsc 是干净的）。原因（run 38592051352）：CI 的干净 bun install（isolated linker）下 shared/ 里的文件解析不到 zod、@json-render/core、@json-render/react/schema（它们在 server/、app/ 的 node_modules），导致 TS2307 和连锁的 TS7006。

#### 验收标准

- [x] server-typecheck 在 CI 变绿（#113：CI 改 `bun install --linker hoisted`，同镜像）
- [x] 修复方式写进 docs/development.md、docs/slimming.md
- [x] 随瘦身 P3 一起修（#113）

## CB-021

**一轮里两次 page_update 会出两张同一页面的卡片**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: pages` `area: chat` `P2`

#### 背景

§54 已知问题：机器人在同一轮里对同一个页面调用两次 page_update，聊天里出现两张一样的页面卡片。

#### 验收标准

- [x] 同一轮、同一页面只显示一张卡（最后一版）
- [x] 不同页面仍各一张
- [x] 回归测试覆盖（`app/tests/chat-unify.test.ts`「page cards」）

> 2026-10-15（fix/chat-cards）：`supersededPageCalls` 留最后一次有结果的调用；下一次还在流时前一张照常显示，任何时刻只有一张。DESIGN.md §54。

#### 相关

- DESIGN.md §54、docs/pages.md

## CB-022

**只读工具的结果没有卡片（只有文字）**  
里程碑：成熟度 Maturity · 标签：`type: feat` `area: chat` `P2`

#### 背景

读类工具（如 GitHub 列表 / 读文件、记忆搜索等）的结果目前只体现在机器人的文字里，没有像写操作确认卡、文件卡那样的可视卡片。需要先定规则：哪些读结果值得出卡、哪些只在开场一句里带过（§27）。

#### 验收标准

- [x] DESIGN.md 写清读结果出卡的规则（§70.3：只读结果不出卡，干活卡 / 步骤清单里一句中文）
- [x] 按规则实现，结果卡不撑高聊天、不跳版（不加卡，只补说法）
- [x] 不增加首轮渲染时间

> 2026-10-15（fix/read-steps）：`shared/work-step.ts` 给记忆 / GitHub / 页面 / 定时任务 / 技能 / 面板 / 设备等读类工具补中文说法；顺带纠正 memory_save、panel_list 的说法。测试 `app/tests/work-steps.test.ts`。

#### 相关

- DESIGN.md §27、§31、§53

## CB-023

**后台任务卡片在参数流完前显示笼统的「正在交给后台…」**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `P2`

#### 背景

delegate_task 的工具参数还在流式输出时（默认模型约 6–8 秒），任务卡片只显示「后台任务 · 正在交给后台…」。

#### 验收标准

- [x] 参数里的任务名一出现就显示（先写 task 的模型用说明头一句）
- [x] 或者在拿到名字前不出卡，只出一行进度（「正在安排后台任务…」）
- [x] §38.3 更新

> 2026-10-15（fix/chat-cards）：`pendingWorkerTitle`（`app/src/lib/chat/worker-title.ts`），测试 `app/tests/chat-unify.test.ts`。

#### 相关

- DESIGN.md §38

## CB-024

**切换暗色外观卡约 400ms**  
里程碑：成熟度 Maturity · 标签：`type: perf` `area: chat` `area: settings` `P2`

#### 背景

性能审计后仍未优化：4× CPU 下切换主题约 400–480ms 长任务（强制布局 + 毛玻璃重绘，不是 JS）。曾尝试切换时禁用过渡，无收益已回退。

#### 验收标准

- [x] 4× CPU 下切换主题 INP < 200ms（普通页 136ms；长对话 105 条 ≈ 216ms，主线程是整页样式重算，随 CB-025 一起降）
- [x] 外观不变（切完稳定后截图与修复前一致）
- [x] 测量方法写进 docs 或 PR（DESIGN.md §7.4）

> 2026-10-15（fix/glass-perf）：根因不是 JS——天空 `--sky-*` 1.6 秒淡变期间每块毛玻璃逐帧重新模糊（4× CPU 预览：光栅化 1.9 秒、viz 1.45 秒、最后一帧 1.6 秒）。改成只有改天空设置时才淡变：光栅化 0.2 秒、viz 0.3 秒、最后一帧 0.47 秒；打开账号菜单 INP 120ms、长任务 79ms。

#### 相关

- DESIGN.md §41

## CB-025

**打开长对话首屏渲染约 1 秒**  
里程碑：成熟度 Maturity · 标签：`type: perf` `area: chat` `P2`

#### 背景

切到一个很长的对话时有约 1 秒的长任务（§41.4 后宽屏 4× CPU 2584ms 到消息可见）。消息列表为了不跳版（§35）没有虚拟化。

#### 验收标准

- [x] 长对话（>200 条）首屏只挂尾窗再分批补（`tail-first-paint` / `useTailFirstMount`；单元 + 挂载回归）
- [ ] §35 不跳版的回归全部通过（tests/chat-scroll/regression.sh）——部署后建议复跑；本批未改滚动容器定位算法
- [ ] 生产 4× CPU 首屏 < 1500ms 实机数字（狗粮 / FRA；本批以挂载有界断言代替）

#### 相关

- DESIGN.md §35、§41

#### 记录

- 2026-10-16 试过给消息行加 `content-visibility: auto`（分支 perf/cb-025-cv，未合并）：首屏中位数 1456ms → 1463ms 没有下降，chat-scroll 回归还多出跳版 → 放弃。
- 2026-10-19（v0.1.37）：分批挂载 / 先渲染最后一屏落地；短→长历史保持尾窗；上滑保留 scrollTop；不虚拟化。

## CB-026

**chisabot_bot_threads：确认没有孤儿指针行**  
里程碑：成熟度 Maturity · 标签：`type: chore` `area: chat` `P2`

#### 背景

全端同步（§42）把每个（用户, 机器人）的当前对话存在 chisabot_bot_threads。删机器人时 agents/purge.ts 会删对应行，但删用户、清理前遗留的行、IM / 后台对话是否会留下孤儿指针还没核对。

#### 验收标准

- [ ] 生产只读统计孤儿行（agent 不存在 / thread 不存在）
- [ ] 有则加开机清理（可用环境变量关掉）并说明
- [ ] 删用户时级联

#### 相关

- DESIGN.md §42

## CB-027

**IM 定时推送受平台被动回复窗口限制**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: im` `area: schedules` `P2`

#### 背景

从 IM 设的定时任务到点后把回复推回 IM 会话。QQ 官方机器人、企业微信只允许在用户消息后的一段时间内被动回复，超出窗口推送会失败。

#### 验收标准

- [ ] 推送失败时在网页通知和定时任务记录里写明原因
- [ ] 支持主动消息的平台走主动接口
- [ ] docs/im.md 写清各平台限制

#### 相关

- DESIGN.md §49、§55；docs/im.md、docs/schedules.md

## CB-028

**「开场一句」只在显示时折叠，事件历史里仍保存**  
里程碑：成熟度 Maturity · 标签：`type: chore` `area: chat` `P2`

#### 背景

§27 的过程话只在渲染时变灰 / 折叠，保存的事件历史里仍有完整内容，会进入后续轮的上下文。

#### 验收标准

- [ ] 决定是否在服务端裁剪（不影响已保存对话的显示）
- [ ] 如裁剪，上下文 token 下降可测

#### 相关

- DESIGN.md §27

## CB-029

**弹窗打开动画仍有毛玻璃开销**  
里程碑：成熟度 Maturity · 标签：`type: perf` `area: settings` `P2`

#### 背景

§37.2 关闭和打开动画期间已去掉 backdrop-filter，但整体打开到首帧仍有 10–50ms 级的模糊开销，低端设备可感知。

#### 验收标准

- [x] 低端设备（4× CPU）打开弹窗 INP < 100ms（2026-10-19，§37.3：内容层去掉静止态 `backdrop-filter`，遮罩保留轻 blur + glass-hold；`glass-hold-panels.test.ts`）
- [x] 外观不变（底色已是 `--glass-3` ≥0.86；毛玻璃几乎看不见）

> 完成（2026-10-19，feat/prod-failed-send-restore-cb029-glass，0.1.38）：DESIGN §37.3；弹窗 / 抽屉 / 菜单 / popover / select / combobox 内容层 `backdrop-filter: none`；遮罩仍轻模糊。右栏 live-panel 本就在 `.rail-card` 下无 backdrop。

#### 相关

- DESIGN.md §37

## CB-030

**设备能力「打开」实际可执行任意命令，却标为非危险**  
里程碑：设备核心 Devices core · 标签：`type: bug` `area: devices` `area: pc` `P1`

#### 背景

2026-10-12 代码审查发现：PC 节点的 open 能力可以被用来执行任意命令，但被归类为非危险能力（不需要本机二次确认）。

#### 验收标准

- [x] open 只能打开 URL / 文件 / 文件夹，不能带任意参数执行（2026-10-15，fix/safe-open）
- [x] 或者把它归为危险能力并本机确认
- [x] 测试覆盖绕过用例

> 完成（2026-10-15，feat/devices-1，0.1.8）：「打开」标为高风险，PC 开着「高风险操作始终在本机确认」时也会本机再问一次（`pc/test/code-ops.check.js` 覆盖带参数启动程序的用例）。仍可以带参数启动程序——这是这项能力的用途，按命令行同级对待。
>
> 收紧（2026-10-15，fix/safe-open）：「打开」只做安全的打开——http/https 网址，或允许的文件夹里已存在的文件 / 文件夹；不启动程序、不带参数、不打开可执行文件 / 脚本 / 快捷方式、别的协议和网络路径。服务器 `checkOpenTarget`（shared/devices.ts，测试 `server/tests/device-open-target.test.ts`）在发给设备前先拦，所以**已装的旧版 PC 也受保护**；PC 端 `pc/src/agent/open-target.js` + `ops.js open()` 同一套规则再拦一次、并要求在允许的文件夹里（`pc/test/ops.check.js`），随下一个 PC 版本发布。

#### 相关

- DESIGN.md §16；docs/pc-node.md

## CB-031

**本地对话事件表无上限增长**  
里程碑：成熟度 Maturity · 标签：`type: chore` `area: chat` `area: infra` `P2`

#### 背景

2026-10-12 代码审查：本地会话事件表没有保留策略，长期会无限增长。

#### 验收标准

- [ ] 给出保留策略（按对话 / 时间），不影响历史对话显示
- [ ] 迁移可回滚
- [ ] docs/operations.md 写明

## CB-032

**安卓签名改为 CI 内签名（需要仓库 Actions secrets）**  
里程碑：0.2.0 release · 标签：`type: chore` `area: android` `area: infra` `P2` `status: needs-user`

#### 背景

目前 APK 在部署机上离线签名，再把签名后的 APK 地址传给 CI。仓库所有者在 Settings → Secrets 加上 4 个 ANDROID_* secrets 后，CI 可以直接签名。

#### 验收标准

- [ ] 仓库所有者添加 ANDROID_* secrets
- [ ] release.yml 用 secrets 签名，去掉 signed_apk_url 路径（保留兼容一段时间）
- [ ] docs/releasing.md 更新

## CB-033

**生产跨部署 stale-chunk 测试待跑**  
里程碑：成熟度 Maturity · 标签：`type: chore` `area: infra` `P2`

#### 背景

PWA（§40）的跨部署旧分包自动刷新只在预览上验证过；生产上的脚本已准备好，等下一次部署后跑。

#### 验收标准

- [ ] 部署后跑一次，旧页面点进新分包页面能自动刷新一次
- [ ] 结果记在 docs/pwa.md

#### 相关

- docs/pwa.md

## CB-034

**用真实账号验证 GitHub 连接与 IM 接入**  
里程碑：成熟度 Maturity · 标签：`type: chore` `area: github` `area: im` `P2` `status: needs-user`

#### 背景

§49 IM 和 §53 GitHub 只用模拟服务和假令牌在生产验证过，用户还没有连接真实账号。

#### 验收标准

- [ ] 用户连接一个 fine-grained GitHub 令牌：读仓库 + 一次确认后的写操作
- [ ] 至少一个 IM 平台真实收发
- [ ] 问题逐条开 issue

## CB-035

**备用模型：管理员排序的回退列表 + 对话里说明换了模型 + 自检走回退**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: models` `area: chat` `P0` `status: done`（#118）

#### 背景

2026-10-15 01:50 生产默认模型 `clinepass/cline-free/mimo-v2.6-flash` 每日免费额度用完（429，约 19 小时），发布自检失败。§60.1 的回退只能挑同平台模型、
不能由管理员指定，对话里也看不出换了模型。运维上已把默认模型换成 `clinepass/cline-free/muse-spark-1.3-contributor`。见 DESIGN.md §61。

#### 验收标准

- [x] 设置 → 模型 →「备用模型」有序列表（添加 / 上移 / 下移 / 移除 / 保存，最多 8 个），存 `enterprise_settings.model_fallbacks`
- [x] 429 / 402 / quota 和 5xx / 529 在没有输出前按列表换模型；400 / 401 / 网络错误不换
- [x] 换过的那一轮在对话里有一行淡色小字「主模型额度用完，已改用 X」，刷新后仍在
- [x] `/api/admin/smoke` 走同一套回退并在结果里写明
- [x] 单元测试、预览 e2e（模拟 429 模型）、生产检查（临时机器人）

#### 相关

- DESIGN.md §61、docs/models.md、server/src/agents/model-fallback*.ts

## CB-040

**朋友账号 / 真正的多用户：邀请链接、各用各的、管理员管理账号**  
里程碑：成熟度 Maturity · 标签：`type: feature` `area: auth` `security` `P0` `status: done`

#### 背景

用户 2026-10-15 00:28 想把 ChisaBot 分享给朋友。生产是单用户（登录网关一个账号），共享账号 = 朋友拿到管理员的机器人、记忆、保险箱和设备。
见 ADR-0011、docs/accounts.md、DESIGN.md §65。

#### 验收标准

- [x] 网关多账号：`accounts` / `invites` 表，Argon2id，一次性邀请（有效期）、重置密码链接、停用、删除、直接创建；原管理员账号和已有会话不变
- [x] 网关给应用签名身份头（HMAC + 时间戳）；应用「网关身份」模式，第一次见到的朋友自动建 users / user_roles，角色以网关为准
- [x] 手机扫码会话、PC 登录 / 登记归正确的人；停用的账号所有会话失效
- [x] 隔离：机器人、对话、记忆、技能、保险箱、GitHub、页面、定时任务、聊天文件、生图设置、设备（含机器人的设备工具、审批）、IM、面板、审批偏好；管理页与 `/api/admin/*` 403，Magpie 403
- [x] 设置 → 管理 → 账号：列表、邀请、停用、重置、删除；新朋友直接得到「助手」
- [x] 单元测试（签名 / 验签、网关账号流程）+ 预览 e2e（两个用户，界面 + 直接 API）+ 生产 e2e（临时账号，验完删除）
- [ ] 每人每日消息上限（拆到 CB-045）

> **2026-10-15 10:05 先隐藏，多用户以后再做**：代码、网关多账号、签名身份、按人隔离全部保留；界面入口由 `CHISABOT_ACCOUNTS_UI=1` 打开（默认关），网关 `config.json` 的 `invites` 默认关（不能加新人）。09:11 一度删掉（#130），10:05 用户改为隐藏，已撤回。

#### 相关

- deploy/public/auth/server.ts、deploy/public/nginx.conf、server/src/auth/gateway-identity.ts、app/src/routes/_authed/admin/accounts.tsx

## CB-041

**真实聊天路径刷新 / 断网后正在写的回答丢失**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `P0`

#### 背景

左栏点机器人进的是频道聊天（`/channel/new` → `/channel/:id`，`ChannelChat`），不是各功能 e2e 一直在测的 `/bot`。2026-10-15 生产复现（成熟度扫查 f3.mjs）：发「写 600 字小故事《橘子》」，6 秒时刷新页面 → 3 / 10 / 25 / 45 秒都只看到用户那句、没有回答、也不显示在回答；下一句问「上一条故事的题目是什么」，机器人只能从用户消息里读到题目——回答根本没存下来。`/bot` 上同样操作回答完整保留（§42）。手机切后台、网络抖一下都会丢回答。

#### 验收标准

- [x] 频道聊天里回答写到一半刷新 / 关页 / 断网，服务器继续写完并存下；回到页面接着显示流式（或显示完整结果）（根因：服务器一直存着，前端截断接入后不再接；DESIGN.md §64）
- [x] 回答进行中刷新后「停止」按钮可用（f5.mjs：刷新后 1 s 内接着流，第 4 s 点停止 → 「已停止」）
- [x] e2e：刷新中途多次回答都在（预览 f4 / f5，生产检查见 PR）

## CB-042

**重新生成 / 编辑后重发**  
里程碑：成熟度 Maturity · 标签：`type: feat` `area: chat` `P1`

#### 背景

回答下面只有「复制」；用户消息不能编辑重发。ChatGPT / Claude / Hark 都有。需要服务器端截断线程（跨设备一致）。

#### 验收标准

- [x] 最后一条回答「重新生成」；用户消息「编辑」后重发，旧的后续消息被替换（所有设备一致）（频道聊天 + `/bot`；截断接口 + 墓碑 + 同步版本号，DESIGN.md §67；e2e：两台设备、刷新后一致）

#### 方案（2026-10-15 成熟度扫查记下；已按此实现，见 DESIGN.md §67——截断接口挂在 `/api/copilotkit/threads/<id>/truncate`，版本号用 `chisabot_thread_truncations` 行数）

- 服务器：`POST /api/bot-threads/:agentId/truncate {threadId, fromMessageId}`——只允许截最后一条用户消息那一轮、且对话没在跑；`openbot_local_threads.messages` 截到这条之前，`openbot_local_events` 删掉从第一个提到这条用户消息的事件（它那一轮的 RUN_STARTED）起的全部事件，写审计。重新生成 = 截掉最后一条用户消息再原样重发（换新 id，这样新一轮的 RUN_STARTED 带上它，回放里才看得到）；编辑 = 截掉后发新内容。
- 别的设备：截断后事件序号会变小再变大，单靠 `seq` 不可靠——同步戳里加一个对话版本（截断时 +1，如 `openbot_local_threads.updated_at` 或新列），版本变了就 `join("rebuild")`。
- 界面：最后一条回答下面「重新生成」，最后一条用户消息悬停「编辑」→ 气泡原地变输入框（发送 / 取消，§6 按钮状态机），频道聊天和 /bot 都要；回答进行中不显示。

## CB-043

**频道聊天的跨设备实时同步**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `area: pwa` `P1`

#### 背景

扫查 fr2.mjs：手机 390 打开同一个 `/channel/:id`，看到的是旧内容；手机发的一句 15 秒内桌面没出现。§42 的同步只做在 `/bot`。

#### 验收标准

- [x] 同一频道会话两台设备：一边发、另一边 5 秒内出现（含流式中的回答）（f6.mjs：手机→桌面 1.5 s、桌面→手机 2.0 s，回答同步流式，无重复；DESIGN.md §64）

## CB-044

**登录页预填管理员账号**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: infra` `P1`

#### 背景

生产登录页（网关手工部署的 login.html）账号框预填了管理员账号名。分享给朋友前要去掉（也泄露管理员用户名）。

#### 验收标准

- [x] 登录页账号框为空（浏览器自动填充照常）（2026-10-15：生产网关手工部署的 login.html / magpie-login.html 去掉预填的 `value`；仓库 deploy/public 本来就是空；PC / 安卓不带预填）

## CB-045

**每人模型额度 / 用量上限**  
里程碑：成熟度 Maturity · 标签：`type: feat` `area: models` `P2`

#### 背景

多用户（CB-040）之后，朋友共用管理员的模型额度，没有任何按人的用量统计或上限。

#### 验收标准

- [ ] 按人统计每日 token / 次数；管理员可给每人设日上限，超了在聊天里说人话

## CB-046

**两套聊天实现收成一套**  
里程碑：成熟度 Maturity · 标签：`type: chore` `area: chat` `P1`

#### 背景

机器人聊天有两条路：`/channel/*`（ChannelChat，左栏、用户日常用）和 `/bot?agent=`（CopilotChat，只有定时任务提醒的「查看」会进）。§42 跨设备同步、历史对话、刷新续写、各功能 e2e 都在 `/bot` 上；用户日常用的是频道聊天。功能、测试和修复都在分叉。

#### 验收标准

- [x] 定下一条主路径（ADR），另一条只做跳转；现有会话不丢 —— ADR-0013：频道聊天是唯一界面，`/bot` 经 `POST /api/channels/open-thread` 跳转（同一个 thread id，不复制消息），DESIGN.md §68
- [x] `/bot` 独有的功能搬进频道聊天（确认卡片、服务器行、备用模型小字、回答期间插话、`chisabot-ask`、历史对话、上传进工作区）；频道对话也有委派 / 定时任务 / 本地 agent（只排除多机器人群聊）
- [x] 所有 e2e 走用户真实点击的路径（聊天滚动、并发 e2e 改成频道选择器）
- [x] 频道聊天发送那一刻整页往下跳（滚动回归第一次在频道上跑就红，main 同样）—— DESIGN.md §68.4
- [x] 第 2 步（`chore/chat-unify-2`）：删掉语音（`/api/voice`、服务器 voice、shared voice-session、前端语音组件）—— DESIGN.md §68.7，`voice_sessions` 表保留

> PR 1 #136（2026-10-15 上线），PR 2 `chore/chat-unify-2`（语音）。

## CB-047

**很长的对话打开时历史晚到，画面停在上面**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `P2`

#### 背景

2026-10-15 频道版滚动回归（CB-046）里，174 条消息的对话副本偶尔打开后不在底部（发送前离底部 2 万 px），接着发送要平滑滚很远；
也见过发送后十几秒「较早的消息」整段补进来、画面被推走。推测：打开时读存下的对话（`readThreadMessages`，4 秒截止）超时，只剩接入快照里的尾巴，
之后重试 / 回答结束时的再读把前面整段补到上面，滚动区没有按「贴底」保持位置。main 上同一路径未改动。

#### 验收标准

- [x] 长对话打开后总在底部；历史晚到补在上面时，正在看底部的人画面不动（滚动回归 failtwice / polltick 用长对话连跑 5 次都过）
- 2026-10-16（CB-071，§83）：找到根因——历史一段段到时滚动容器把每一段当成刚发的一轮对齐到顶上；恢复完成前不画半截 + `SettleAtEnd` 钉底部，节流下冷打开 / 切换都落在底部。
- 2026-10-15（#146，§72.2）：加了 `useKeepBottomOnPrepend`——第一行变了而人在底部时，画完那一刻回到底部。预览里复现不出「先只有尾巴」：把第一次读历史拖 6 秒（冷启动 / 热启动各试），接入快照本身就带整段历史，打开即在底部（5/5）。等生产再见到时看是否还会停在上面，再关这一条。
- 2026-10-15 另见：滚动回归 `wide` 偶发 `removed:1`（回合结束时一条消息节点被换掉一次，画面不跳），main 20a2487 和 #146 上都是 2 次里 1 次，是已有的不稳定，待查是哪一条消息被重挂。

## CB-048

**对话像发短信：先答、短气泡、不讲怎么查的、草稿卡 / 代码卡 / 回复引用（向 Hark 看齐 第五轮）**  
里程碑：Hark parity · 标签：`type: feature` `area: chat` `P1`

#### 背景（2026-10-15 对话审计，同一模型 muse-spark、预览 + 生产各一轮，临时机器人）

按影响排序的差距：
1. 一条回答是一整块长气泡（iPhone 配置一问约 600 字、6 段塞在一个整列宽气泡里，段落之间没有间距）；Hark 是一条一条短消息、先给答案。
2. 气泡里讲方法：「刚用 web_fetch 读的」「以下是我刚用 web_search + web_fetch 读到的，不是凭记忆说的」「刚在本机用 date 查的」「这一份是我根据自己已有知识整理的…」。
3. 自称模型名：新机器人回「我是 Muse Spark」（提示词里没有机器人的名字）。
4. 草稿（给房东的微信）混在正文里、斜体，没法一键复制；Hark 是单独的草稿卡。
5. 代码块：语言名一行、复制 / 下载按钮又单独一行（streamdown 工具条类名没被 Tailwind 扫到：依赖在根 node_modules），卡片套在气泡里。
6. 回答过程中补充的消息（「只要 256G 的价格」）最后被回应了，但看不出回应的是哪一条；Hark 用回复引用。
7. 套话 / 陪伴腔：「好啊，帮你订。」「我在这儿陪你聊聊」。
8. 短回答也占满整列宽（一句话的气泡 540px 宽）。

#### 验收标准

- [x] 提示词第二版（`shared/bot-prompt.ts` `WORK_STYLE_GUIDANCE`）：先答、一段一个意思、空行分段、每段 ≤100 字、不讲工具和方法、来源放最后一张卡 / 一行、```draft 草稿、带语言名的代码块、一次只问一件事、过程中补充用 `> 原话` 引用、累 / 难过时一句体谅 + 一件能帮的事；`botIdentityGuidance(名字)`
- [x] 机器人回复按段画成多个气泡（`app/src/lib/chat/bubbles.ts` + `components/chat/bot-bubbles.tsx`），短段贴文字宽度，表格 / 代码 / 清单整列宽；一个接一个淡入（160ms 一拍），流式新段不排队
- [x] 草稿卡（复制按钮）、回复引用、代码卡（一行头部 + 不套气泡）
- [x] 生产复测（2026-10-15 13:39，#139 上线后，同一组 9 个问题，临时机器人）：每段都 ≤100 字、没有工具名、自称机器人名（「我是对话审计」）、草稿卡 / 代码卡正常、干活卡出现在 3 个调工具的问题里。剩下：对比类回答末尾仍有一段「刚只是粗搜了一遍…凭已有知识整理的」免责话 → 提示词再收一轮（#141，§69.3）
- 观察（未复现）：生产复测里新机器人第一句「你好」的回复整段出现了两遍（「…有什么需要我做的？你好，我是…」，这一轮用了 45 秒）；同样的路径再跑 3 次（含刷新后对比服务器存的）都正常。怀疑模型那一轮出过错被重试、两次输出接在一起；再出现时查这一轮的运行记录
- 后续拆出：CB-049（干活卡片）、CB-050（商品推荐带图）

## CB-049

**主对话里干活的过程画成一张「干活卡」，结束收成一行**  
里程碑：Hark parity · 标签：`type: feature` `area: chat` `P1`

#### 背景
审计：查 iPhone 价格时只有开场一句 +「正在查…」淡色小字 +「思考中」点点，搜了什么、开了哪些网页看不到；后台任务有任务卡片（§38.3），主对话的工具调用没有。Hark 的做法是一张实时的工作卡片代替状态播报。

#### 验收标准
- [x] 一轮里有工具调用时，「思考中」换成干活卡：当前步骤（搜索「…」/ 读取 apple.com.cn / 写文件 x）+ 第几步 + 用时（DESIGN.md §70）
- [x] 结束后收成一行「搜索 1 次 · 看了 3 个网页 · 12 秒 ⌄」，点开看步骤——放在结果下面复制 / 重新生成那一排（结束那一刻本来就出现），不在结果上方加行，所以不跳（DESIGN.md §70.2）
- [x] 不改变滚动高度跳动规则（§35 / §68.4），chat-scroll 回归 7/7

## CB-050

**商品 / 地点推荐用带图的卡片网格**  
里程碑：Hark parity · 标签：`type: feature` `area: chat` `P2`

#### 背景
审计：「推荐三款 2000 元以内的降噪耳机」画成纯文字清单卡，没查当前价格、没有图；Hark 是带图的商品网格（图、名字、价格、链接）。

#### 验收标准
- [x] render_ui 目录里有商品网格（图 / 名称 / 价格 / 一句卖点 / 链接），提示词要求推荐类先查现价再画（`Products`，#146，DESIGN §72）
- [x] 图片走服务器转存（同链接卡 §48.3），不直连第三方

## CB-051

**「待处理」页是上游审批页**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: approvals` `area: settings` `P1`

#### 背景（成熟度扫查第 3 轮，2026-10-15）
账号菜单「待处理」进 `/approvals`：顶上是上游的「更改前询问 / 自动审核 / 您电脑上的命令（ChisaBot 桌面应用…）」开关，和 设置 → 审批偏好（§58）重复且说法不同；下面「规则」区写「“ask”规则胜过“allow”规则。团队规则已锁定」，表单字段 Target、allow 英文；等待项显示机器人 id 和原始 JSON；聊天里没点的 §58 确认卡片反而不在这里。新朋友点「待处理」看到的是一页企业设置。生产上游 approval_* 表全是 0 行。

#### 验收标准
- [x] 待处理只列：没点的确认卡片、交给你的一步、在等你回答的问题；机器人显示名字；参数折叠；空状态 / 错误卡
- [x] 去掉上游开关和规则表；页尾入口到 设置 → 审批偏好；菜单上的数算上确认卡片
- [x] DOM 测试；1280 亮 / 390 暗截图（DESIGN.md §71.1）

## CB-052

**手机上设备「完全访问」时长按钮一个字一行**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: devices` `area: pwa` `P1`

#### 背景
390 宽 设置 → 设备 → 某台电脑 → 权限：「1 小时 / 24 小时 / 永久」被 `flex: 1` 挤成每个字一行。

#### 验收标准
- [x] 分段按钮不换行（`.sg-segmented-item` 全局）；窄屏分段独占一行、三段平分（DESIGN.md §71.2）

## CB-053

**找不到 / 读不到的状态**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: settings` `P2`

#### 背景
`/bots/<已删除>`、`/channel/<已删除>` 只有一行红字（对话页在左上角），没有返回；机器人资料接口 500 也说「找不到这个机器人」；`/settings/connected-accounts/<不存在>` 标题直接是 key（`nope`、`github`），说「这不是你自己连接的服务」。

#### 验收标准
- [x] 错误卡 + 出路按钮（看我的机器人 / 回到聊天），原始错误折叠在「查看详情」（DESIGN.md §71.3）
- [x] 连接器 key 不存在：「找不到这项连接」；`github` 指回账号连接页

## CB-054

**机翻 / 上游行话残留**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: settings` `P2`

#### 验收标准
- [x] 账号连接页空状态 / 错误不说「读取为询问者的连接器」「可能错误的列表」
- [x] 界面里不再出现「AI 同事」（机器人编辑框、加载失败文案、提议卡片）

## CB-055

**机器人资料页模型下拉显示原始模型 id**（第一轮 C8）  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: models` `P2`

#### 验收标准
- [x] 「部署默认（Muse Spark 1.3 Contributor）」这样显示目录里的名字，没有名字时才回退 id（DESIGN.md §71.4）

## CB-056

**管理页英文**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: settings` `P2`

#### 背景
`/admin/plugins` 插件目录的说明（Parallel Search、Google Drive、Notion、Routines…「Files in the Drive of whoever is asking」）；`/admin/boundaries` 三条快捷规则的说明（「Also stops the Bot pressing Enter…」）；`/admin/audit` 事件类型 `computer.policy_loaded`、`bot.created`，筛选「Boundary at start-up」。只有管理员看得到，但管理员就是用户本人。

#### 验收标准
- [x] 三处都是中文；事件类型显示中文名，原始类型放悬停 / 详情（DESIGN.md §71.6）

## CB-057

**活动记录表格在 390 宽被截掉右边几列**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: settings` `area: pwa` `P2`

#### 验收标准
- [x] 窄屏改成一条一张小卡（时间 · 操作 / 对象 / 机器人 · 谁发起 / 结果）（DESIGN.md §71.6）

## CB-058

**设置左栏在 1280×860 下「管理 / 高级」7 项在可视区外**  
里程碑：成熟度 Maturity · 标签：`type: chore` `area: settings` `P2`

#### 背景
左栏 19 项（个人 11 + 管理 6 + 高级 2），笔记本常见 1280×800 / 860 上「云端浏览器」以下要滚动，只有底部淡出提示。

#### 验收标准
- [x] 先定设计（行高 36px / 管理与高级可折叠 / 高级并入管理），再改；手机抽屉不受影响——三组都能折叠、默认只展开当前页所在的组，矮屏行高 34（DESIGN.md §71.7）

## CB-061

**云端 Claude Code P1：云端工作区节点 + 网页登录 Claude**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: infra` `P1` `status: needs-user`

#### 背景
用户 2026-10-15：在 ChisaBot 云端集成 Claude Code（设计 docs/cloud-claude-code.md、ADR-0014）。

#### 验收标准
- [x] `deploy/cloud-node/`：非 root、cap_drop ALL、根文件系统只读、不挂 docker.sock、不用 host 网络、`--no-full-access`；防火墙丢弃到私有网段和主机
- [x] 设备列表里「云端工作区」在线；连其他容器 / 主机端口失败；开不了完全访问
- [x] 设置 → 云端工作区：用 Claude 订阅登录（授权页 → 粘授权码）、退出、重新检查；模拟 CLI 走完成功 / 出错 / 过期 / 取消 / 退出
- [x] 授权码和令牌不进数据库和日志（grep 检查）
- [ ] 真实登录由用户点一次（needs-user）

## CB-062

**云端 Claude Code P2：左栏切换、会话、对话、审批、右栏 / 手机抽屉**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: chat` `P1`

#### 验收标准
- [x] 左栏切换「机器人｜Claude Code」（记住选择）；工作区 → 会话树，先只有内置「草稿」
- [x] 同一个会话两轮共享上下文（`--resume`）；「新 Claude 会话」清掉上下文；停止 1 秒内生效；回答中再发一条排队
- [x] `npm test` 出审批卡，允许后执行、拒绝后 Claude 换办法；「本会话总是允许」；`git push` 被拒并提示「推送并开 PR」
- [x] 刷新 / 换设备后接着看正在写的回答
- [x] 右栏「这一轮」diff + 只读文件，可收起；390 宽底部抽屉能拉起能收；亮 / 暗截图

## CB-063

**云端 Claude Code P3：GitHub 工作区**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: github` `P1`

#### 验收标准
- [x] 新建 → 从 GitHub：按钮「克隆中… → 已创建 ✓」；节点磁盘上没有 GitHub 令牌
- [x] 每个会话一个 worktree + `cc/…` 分支；合入工作目录（冲突时不动 `work/`）；推送并开 PR 要审批，出 PR 链接卡
- [x] 右栏「相对 main」「工作目录」两个视图
- [ ] 用真实 GitHub 走一遍（需要用户先在 设置 → 账号连接 连 GitHub；上线后检查）

实现见 DESIGN.md §73.7、`docs/cloud-claude-code.md`「GitHub 工作区（P3，实现）」。预览里对着模拟 GitHub（`tests/cloud-cc/mock-github.cjs`）e2e 通过。#151 已上线（2026-10-15），生产只读检查通过；只差用户连 GitHub 后的真实一遍。

## CB-064

**云端 Claude Code P4：电脑文件夹同步**  
里程碑：0.2.0 release · 标签：`type: feat` `area: pc` `area: agents` `P2`

#### 验收标准
- [x] 自编译 MIT 版 Mutagen 0.18.1（不加 `mutagensspl`）：边车里的 agent 由 `deploy/cloud-node/sync/Dockerfile` 源码编译；电脑端改用 PC 客户端里的 JS（`pc/src/sync/`）驱动 `mutagen.exe`，不移入 CCC 的 Go 助手（P4a，见 docs/cloud-claude-code.md）
- [x] 同步边车 sshd 只听 127.0.0.1:2222，主机没有新端口；隧道走网关 + 一次性票；撤销设备 / 强制收回 / 交还即断开、删公钥（P4a，Linux 替身 e2e）
- [x] PC 客户端（P4b）：「电脑上的文件夹」新建、同步面板、冲突对话框三选项、交接 ①–⑤、Git 走隧道；网页 / 手机状态药丸 + 强制收回；先只做 Windows；发 PC 新版（0.1.11）
- [ ] 在真实 Windows 上走一遍（电脑替身 e2e 用的是 Linux 上同一份同步管理代码 + 同一次编译的 Mutagen；Windows 专有的 ssh 包装器 / OpenSSH ProxyCommand 只有单元测试，归 CB-017）

P4a #159、P4b #160 已上线（2026-10-16），PC 客户端随 v0.1.11 发布。

## CB-066

**在云端完成 Claude 登录（远程浏览器）+ Claude 上游代理**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: infra` `P1`

用户 2026-10-15 20:36 / 20:37：登录要整个在云端完成（你的浏览器不碰 claude.com），登录和 Claude Code 同一个出口；可以设自己的代理 / 静态住宅 IP。

#### 验收标准
- [x] 设置 → 云端工作区「在云端完成登录」：节点容器里的浏览器画面嵌在设置页，可以点、打字、粘贴；回调时自动拿授权码完成登录；粘贴流程保留为备用
- [x] 浏览器和 Claude Code 的出口 IP 显示出来并一致；密码 / 授权码不进日志和数据库；结束后关浏览器、删配置目录
- [x] 「Claude 上游代理」：http / https / socks5 + 用户名密码，测试连接（出口 IP、claude.ai、api.anthropic.com），清除回到默认出口；只有 Claude 域名走它；加密存储、界面打码
- [x] claude.ai 的 Cloudflare 人机验证：云端浏览器用普通 Chrome UA + 关 AutomationControlled（#158），生产上直接到 Claude 登录页
- [ ] 生产上用户自己完成一次真实登录（需要用户的 Claude 账号）

## CB-068

**Android 原生版（Kotlin + Compose）**  
里程碑：成熟度 Maturity · 标签：`type: feature` `area: android` `P1`

用户 2026-10-16 08:22：「我需要原生的，kotlin实现」。DESIGN.md §80，计划 `docs/android-native.md`。

#### 验收标准
- [x] 第一阶段：登录、机器人列表、聊天（历史 / 发送 / 流式 / 干活卡 / 富卡片 / 图片）、面板只读原生；其余页面应用内网页兜底
- [x] 单测 + 模拟器连预览（假模型）浅色 / 深色截图；旧版在线更新不用重新登录
- [ ] 第二阶段：附件 / 拍照、回答期间插话（§38）、重新生成 / 编辑重发（§67）、确认卡、别的设备正在回答时流式续接
- [ ] 第三阶段：原生设置子集（主机器人、设备、模型）、通知、离线缓存、桌面小组件
- [ ] 真机验证（CB-017）

## CB-067

**新版本前功能精简：隐藏用不到的功能、新建机器人两格**  
里程碑：精简 Slim · 标签：`type: chore` `area: web` `P1`

用户 2026-10-16 01:21：「遍历审查chisabot的全部功能…没有必要的进行隐藏或者删除。马上准备推出发布给用户新版本了」；01:22「比如新建机器人的流程，一直不太好使。。」。DESIGN.md §74。

#### 验收标准
- [x] 全部功能过一遍，出审查表（保留 / 隐藏 / 删除 / 需用户决定 + 理由 + 风险），放 PR 描述
- [x] 工作流、插件与 MCP、权限规则、UI 组件目录默认隐藏（`CHISABOT_EXTRAS` 可恢复）；工作流不再给机器人工具；不删表、不删数据
- [x] 新建机器人只剩「名称 + 它做什么」，预览上 1280 亮 / 390 暗从 ＋ 到第一句回复走通
- [x] 删掉用不到的「对话里建机器人」前端工具
- [ ] 「需用户决定」的几项等用户回话

## CB-069

**新建 / 修改机器人统一表单 + 圆形头像（上传 / 表情 / 首字）**  
里程碑：成熟度 Maturity · 标签：`type: feat` `area: web` `P1`

用户要求：新建机器人和修改机器人用同一个表单，能上传头像，头像处处是圆的。DESIGN.md §81，`docs/bot-avatars.md`。

#### 验收标准
- [x] 新建弹窗、资料页「编辑」、管理弹窗「通用」是同一个表单：头像 · 名称 · 职责 · 它做什么；编辑看到的就是新建时填的
- [x] 头像三种：上传图片（圆形取景、256×256 WebP ≤ 256 KB）、表情 + 底色、名字首字 + 底色；没设置的老机器人保持花纹
- [x] 所有显示机器人头像的地方都是圆形；改头像后左栏 / 页头不刷新就跟着变
- [x] 头像窗三个分页高度一样，不跳（1280 亮 / 390 暗 e2e）
- [ ] 删除机器人后留下的孤儿头像行：以后的数据清理一起做

## CB-070

**全站 UI 文字对齐 + 干活卡上下间距**  
里程碑：成熟度 Maturity · 标签：`type: fix` `area: web` `P1`

用户 2026-10-16 08:31：「按键的UI文本没有居中对齐。检查全部UI文本的对齐情况」；08:46：干活卡 / 收成的「✓ …」行贴着上面的内容。DESIGN.md §82。

#### 验收标准
- [x] 测量脚本 `tests/ui-align/`：每个页面、菜单、弹窗、对话（进行中 / 结束 / 展开），1280 浅色 + 390 深色，两种中文字体
- [x] 根因先修共享样式（容器 span 规则伸进 Button、空状态按钮贴说明、控件标签全角标点），再修单页
- [x] 干活卡上下间距：和同一行上面的卡片 10px，和上一条消息 24px，进行中 / 结束 / 展开一致
- [x] 重测：Noto Sans CJK 下 0 个真标记，文泉驿下只剩修改前就有的字体问题（DESIGN §82.5）；`app/tests/ui-align.test.ts` 静态护栏进 CI
- [x] 第二轮（DESIGN §82.6–§82.10）：文泉驿下的下拉触发 / 菜单项 / `device-cap-chip` / 审批小分段 / 「复制」、没有 halt 时「（…）」偏左 4px、一轮结束时过程话一帧消失（改成 220ms 收起）、窄屏「面板」把手压住「编辑」——两种字体都只剩 §82.5 列的已知误报 / 输入框

## CB-071

**打开对话落在最新一条、不跳；切机器人秒开；接入回放瘦身**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `P0` `status: done`

用户 2026-10-16 反馈（网页版）：打开对话加载明显变慢、卡；不是停在最新一条而是中间某条旧消息；切机器人卡顿。DESIGN.md §83。
根因：历史一段段到（接入回放 + 存储补齐 + 晚到的小行 + 图片），滚动容器把每一段当成「刚发的一轮」对齐到顶上；回放每轮重传整段 input（35 轮 3.4 MB）；切机器人整页重挂、全部重读。网慢时一直如此（62b89f2 同样复现），不是 #164–#167 带来的。也关掉 CB-047。

#### 验收标准
- [x] 长对话冷打开第一帧在底部，之后不跳（节流 150ms/4Mbps/CPU×4，1280 + 390）
- [x] 切机器人再切回来：第一帧在底部、不跳；看过的对话先画上次的样子（不节流 ≤ 400 ms）
- [x] 接入回放不再每轮重传 context / tools / 旧消息（35 轮对话 3471 KB → 235 KB），客户端消息列表不变
- [x] 回归：`app/tests/transcript-cache.test.ts`、`app/tests/open-at-latest.test.ts`、`server/tests/slim-replay.test.ts`、`tests/open-scroll/open-scroll.mjs`
- [x] 后续（长对话图片加载闪动）：第一次见的图片也不推开消息——服务器存图时读出宽高（`chisabot_image_dims`，旧图读时现算），随消息 / 工具结果 / 链接预览给网页，网页先按比例留框（DESIGN.md §83.2）。回归 `server/tests/image-dims.test.ts`、`app/tests/image-dims.test.tsx`

## CB-072

**机器人 ↔ Claude Code 切换整屏刷新 → 原地切换**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: web` `P1` `status: done`

用户 2026-10-16 反馈（PC 0.1.13，网页同样）：左栏「机器人｜Claude Code」每切一次整个窗口闪一下。DESIGN.md §84。
根因：两边是两个兄弟布局路由，各自一个 `GlassShell`，切换时外壳整个卸载重挂；第一次切过去分包未到，等待画面在外壳之外画成整屏骨架；切回机器人经 `/` 再跳、左栏数据全部重读。不是整页导航，PC 外壳也没有重新加载。

#### 验收标准
- [x] 切换时外壳、顶栏、左栏容器不重挂；0 次文档导航；0 帧整屏骨架 / 空白（1280 + 390，亮 + 暗）
- [x] 左栏两块内容交叉淡入（150–220ms，减少动态效果时直接换），主区淡入一次；切回时左栏滚动 / 展开状态还在
- [x] 预取对面的分包和数据；分包未到时旧画面留着，直接打开 `/cc` 只画左栏骨架
- [x] 切回机器人回到上次的对话，切到 Claude Code 回到上次的会话
- [x] 回归：`app/tests/left-mode-switch.test.tsx`、`tests/mode-switch/mode-switch.mjs`

## CB-078

**窄窗口里输入框两边没有间距**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: web` `P1` `status: done`

用户 2026-10-16（PC 客户端约 884px 宽，左栏展开）：「当比较窄的时候，输入框两边没有间距了」。DESIGN.md §92。
根因：频道聊天的输入框列是上游的 `max-w-2xl px-0`，主区窄于 42rem 时满宽、左右 0px；Claude Code 会话页左边 4px。

#### 验收标准
- [x] 输入框卡片到左栏卡 / 右栏卡 / 窗口边左右 ≥ 16px、底边 16px（390 / 700 / 800 / 884 / 1000 / 1100 / 1280 / 1440，亮 + 暗，右栏开 / 关，左栏收起，新话题，Claude Code 会话）
- [x] 有「面板」把手时输入框右沿让开把手（≥ 4px），窄窗口里和消息列内容边对齐
- [x] 宽屏尺寸不变（672px 居中）
- [x] 回归：`app/tests/ui-align.test.ts`、`tests/composer-gutter/gutter.mjs`

## CB-080

**连续聊天时发消息整页上跳**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `P1` `status: done`

用户 2026-10-16：「我发现我现在输入，整个列表会上跳……如果 5 分钟之内我有输入，就不进行这个跳跃翻页，超过 5 分钟就按现在这种处理」。DESIGN.md §94。
根因：每条刚发的用户消息都带对齐标记，滚动容器把它对齐到顶上并留一屏 spacer（§35 / §88.1），连续聊天时每句都翻一页。

#### 验收标准
- [x] 上一条用户消息 <5 分钟（服务器时刻，本机兜底）：不对齐、不新留空白、底部跟着长，0 次往回
- [x] ≥5 分钟 / 第一句 / 刷新后上一条早就发了：照旧对齐到顶上
- [x] 打字（输入框长高）对话只为钉住底部挪动
- [x] 回归：`app/tests/send-scroll.test.ts`、`tests/send-scroll/`（预览 + 假模型，1280 / 390）

## CB-077

**中途说明文字没折叠进步骤；断线重接同一段话出现两遍**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `P0` `status: done`

用户 2026-10-16（星灵，0.1.14）截图：「检查结果显示 Node.js/npm 都未安装…」散在「做了 3 步 38 秒」下面；「刚才安装调用中断了…」在气泡里出现两遍。DESIGN.md §90。
根因：没有结果的轮次（出错 / 停止 / 中断 / 还在跑）过程话一直画在卡片外；liveTail 接入回放时 SDK 不清空已有的同 id 消息，正文接了两遍。

#### 验收标准
- [x] 后面又调了工具的过程话（实时也是）、结束后剩下的过程话收进干活卡，点开按位置列出；结果照旧是气泡
- [x] 刷新 / 重新打开一样
- [x] 本机的流断了、服务器接着写完时，同一段话、工具参数、工具结果都只有一份
- [x] Android 原生同样的收起规则（不发版）
- [x] 回归：`app/tests/fold-narration.test.ts`、Android `NativeLogicTest`、`tests/fold-narration/`（预览 + 假模型）

## CB-075

**每个机器人记住我的操作状态；消息记录仍会往回跳**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `P0` `status: done`

用户 2026-10-16：「消息记录仍会往回跳」「每个机器人记住我的操作状态（计算机/面板、草稿、滚动位置）」。DESIGN.md §88。

#### 验收标准
- [x] 发消息（干活卡、日程卡）全程 0 次往回跳（1280 / 390）
- [x] 右栏标签 / 展开 / 宽度按机器人记住；草稿、滚动位置、干活卡展开按对话记住；左栏点回来、切回来、刷新都还原
- [x] 回归：单测 + `tests/bot-state/bot-state.mjs`

## CB-074

**电脑文件夹导入失败后残留、移除后无法重新导入**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: pc` `area: agents` `P0` `status: done`

用户 2026-10-16 12:46（PC 0.1.13）：选 `C:\AI\Seelen-UI` 第一次报错但工作区还是出现了；移除后重新导入被「这个文件夹已经在同步一个工作区了。」挡住；底栏「取消」单独一行。DESIGN.md §87。
根因：节点重启后同步边车留在旧网络命名空间（ECONNREFUSED）；新建失败不撤销；删工作区不拆同步（服务器孤儿绑定 / 租约 + PC 本机记录）。

#### 验收标准
- [x] 新建失败：服务器、节点、电脑都不留东西，中文原因 + 重试（PC 新版自己撤；0.1.13 由网页撤）
- [x] 新建 / 开启同步前探边车；主机看门狗让边车跟上节点的网络命名空间
- [x] 删工作区拆掉绑定 / 租约 / 公钥 / 隧道并通知电脑；PC 对账后放下本机记录；服务器启动清孤儿
- [x] 残留的旧记录不再挡住导入：「解除旧的同步并重新导入」（0.1.13 / 0.1.14 也能用）
- [x] 底栏「取消 · 上传并创建」一行靠右
- [x] 回归：`server/tests/cloud-sync-cleanup.test.ts`、`pc/test/sync-forget.check.js`、预览 e2e（Linux 电脑替身）

## CB-065

**云端 Claude Code P5：ChisaCloudCode 留还是下线**  
里程碑：设备核心 Devices core · 标签：`type: chore` `area: infra` `P2` `status: needs-user`

#### 验收标准
- [ ] P4 上线两周后按使用情况给出建议；动 ChisaCloudCode 之前问用户

## CB-081

**机器人浏览器多标签 + 收藏夹**  
里程碑：成熟度 Maturity · 标签：`type: feat` `area: computer` `P1` `status: done`

用户 2026-10-16（「ChisaBot 浏览器」截图）：「这个浏览器。需要增加标签，可以多个浏览器，还需要增加一个收藏夹。」DESIGN.md §95，docs/browser-tabs.md。

#### 验收标准
- [x] 大屏 / 右栏 / 手机都有标签栏：多个真标签（机器人和人看到同一组），+ 新开、× 关、点击切换、标题 + 图标、当前高亮、放不下横向滚动
- [x] 只看着时标签栏显示机器人在哪个标签上；接管后才能切 / 关 / 开
- [x] 机器人工具 `computer_tabs`（list / new / switch / close），其余电脑工具跟着当前标签；直播跟着当前标签
- [x] 上限 8 个，超出有明确提示；浏览器重启后恢复标签
- [x] 收藏夹：星标收藏 / 取消、收藏栏（窄屏下拉）、改名 / 改网址 / 排序 / 删除；每用户一份、所有机器人共用；新表只新增；第一次使用放进起始页原来的五个；起始页常用网站 = 收藏夹
- [x] 机器人能读收藏、打开收藏；只有用户要求时才增删
- [x] 「多个浏览器」：按多标签做（理由见 DESIGN §95.1）
- [x] 回归：`agent-computer/tests/tabs.test.ts`、`server/tests/browser-bookmarks.test.ts`、`server/tests/computer-tabs-routes.test.ts`、`app/tests/browser-tabs.test.tsx`、预览 e2e

## CB-082

**浏览器暗色图标 + 外侧去掉标签 + 放大页重排 + 旧测试**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: computer` `P1` `status: done`

用户 2026-10-16：暗色模式下 GitHub 图标看不清；「外面不需要标签。这样展示太难看了。图2这个页面也要改一改，不好看，交还浏览器被挤到滚动条下面了」。DESIGN.md §96。

#### 验收标准
- [x] 暗色主题：深色墨图标（真 favicon / 字母块）在标签栏、收藏栏、收藏夹下拉、管理面板里都看得见（通用判断，不靠站点名单）
- [x] 右栏计算机上面没有标签条
- [x] 放大页不滚动：工具条（标签 + 地址栏 + 收藏栏）一块、「+」紧跟最后一个标签、× 在标签栏右端、屏幕等比缩放、底栏始终在卡片里；只看 / 接管、1280×840 / 1440×900 / 900 / 390、亮 / 暗都验过
- [x] `computer-control-button.test.tsx`、`rail-computer-entry.test.ts` 跟上现在的中文界面 / 源码，不改产品行为

## CB-084

**从其他页面切回机器人页总要刷新一次**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `area: web` `P1` `status: done`

用户 2026-10-17：「我从别的页面切回机器人页面，总是会刷新一次，这个能优化吗」。DESIGN.md §98。

#### 验收标准
- [x] 从设置 / 待处理 / 设备（左栏「返回聊天」、左栏点机器人、浏览器后退）回到聊天：不整页加载、不闪白、无骨架，桌面 1280 和手机 390
- [x] 聊天记录和滚动位置原样，不重新接入、不重读历史；回来后不跳动（§35、§94）
- [x] 离开期间正在写的回答不中断，回来就是写到哪儿了
- [x] 单测 + 预览 e2e（`tests/nav-keep/`）
- [x] 1280 第一次去设置时藏着的聊天不被挪动（#198，§98.5：离开那一刻钉住滚动位置 + 外壳里不用原生 scrollIntoView）

上线：#197 `dfcfac8`（2026-10-17 19:26 CST）；#198 修桌面端第一次去设置的滚动偏移。

## CB-083

**设置重新整合 + 设置搜索；输入框权限（请求批准 / 完全访问）**  
里程碑：成熟度 Maturity · 标签：`type: feat` `area: web` `area: devices` `P1` `status: done`

用户 2026-10-16：「设置里太乱了。全部重新整合重新分类排序。并且增加设置搜索。输入框增加一个权限设置。就参考图里这两种。」（参考 ChatGPT 的「完全访问」小标签和「应如何批准」弹层）。DESIGN.md §97，docs/settings-ia.md。

#### 验收标准
- [x] 盘点全部设置（docs/settings-ia.md），按新分类重新分组、排序、合并重复（审批偏好 → 权限与审批；生图与识图 → 我的生图与识图，归到模型组）；所有旧地址照常能打开
- [x] 一张登记表同时驱动左栏和设置搜索；搜索标题 / 说明 / 同义词（中文、拼音首字母、英文），跳到页面并高亮那一项；Ctrl/⌘ K 或 / 聚焦；空结果文案
- [x] 输入框「+」后的权限开关（请求批准淡色 / 完全访问橙色、弹层、了解更多、一次性确认、手机收成图标、键盘可用、亮 / 暗）
- [x] 服务器按机器人存、按机器人执行（完全访问自动放行设备「询问」的操作；请求批准始终问），审计记录改动；硬限制不放开；PC 客户端不用改
- [x] 设置 → 机器人 → 权限与审批 里同一个开关
- [x] 单测（登记表 / 搜索、服务器执行）+ 预览 e2e（搜索、旧地址、两档、假模型下请求批准出卡 / 完全访问直接执行）

## 已完成

最近合并的见 [ROADMAP「最近完成」](ROADMAP.md#最近完成) 和 [CHANGELOG](../CHANGELOG.md)。

## CB-073

**Claude 上游代理支持 trojan / vless 等节点链接（sing-box 转换）**  
标签：`type: feature` `area: cloud-cc` `P1` `status: done`

用户 2026-10-16 12:43：「Claude 上游代理」也要能填 trojan:// / vless:// / vmess:// / ss:// / hysteria2:// / tuic:// 分享链接，填了这类链接时要清楚地提示需要开启 sing-box 转换。DESIGN.md §85，docs/cloud-claude-code.md。

#### 验收标准
- [x] 解析器 `shared/proxy-links.ts`：六种协议、tls / reality（pbk、sid、fp）/ vision、ws / grpc / h2 / httpupgrade、ws `?ed=`、IPv6、url 编码 / 中文 / emoji 节点名、ss SIP002 + 旧式；不支持的写清楚原因（单测 `shared/proxy-links.test.ts`，有 sing-box 时每种出站都过 `sing-box check`）
- [x] 云端节点镜像带固定版本 sing-box（1.14.3，sha256 校验）；节点起 sing-box（127.0.0.1 随机端口 + 随机账号密码的 socks5），转发器把它当 socks5 上游，覆盖的流量和 http / socks5 代理一样；意外退出自动重启；日志不带密码
- [x] 网页：链接时显示识别结果 +「用 sing-box 转换此链接」开关（开了才能测试 / 保存）+ 一句机场节点风险提醒；保存后自动测，显示出口 IP 和国家
- [x] 预览 e2e：本机起的 trojan / vless reality / vmess ws / ss 测试服务端（不用真实节点），经节点 sing-box 测通 claude.ai + api.anthropic.com，杀掉 sing-box 后自动恢复，密码 / UUID 不出现在日志、数据库、接口里

## CB-076

**「模型老断」：长命令 / 断线 / 部署重启时这一轮被误报成「连不上模型服务」**  
标签：`type: bug` `area: chat` `P0` `status: done`

用户 2026-10-16 15:4x：「模型老断」——让机器人在电脑上用 winget 装 Node.js，一轮做到一半就是「暂时连不上模型服务」，「正在操作你的设备 第 3 步 · 401 秒」还在转。DESIGN.md §89。
线上证据（FRA 网关日志 + `openbot_local_runs` / `openbot_local_events`）：3 天里 0 条 RUN_ERROR（模型 / 上游没出过错）；用户可见的两次断都不是模型——
15:37:43 部署（`auto-202610160737-125cd05`）重启了应用，nginx「upstream prematurely closed」，那一轮被标 interrupted、事件停在 TOOL_CALL_END；
15:44:39 用户电脑到 Cloudflare 的连接整条断了（/run 流和频道 WebSocket 同一秒断，2 秒后换边缘节点重连），服务器那一轮照常跑到 15:54:06 RUN_FINISHED（一条 388 秒 + 一条 436 秒没有任何事件的 device_run_shell）。

#### 验收标准
- [x] 浏览器这头的流断了不再说成模型的错：先问服务器——还在跑就不报错、自动接上；答完了读回答案；服务器也没了才报「和 ChisaBot 服务器的连接断了」，并把没结果的步骤收起来（单测 `app/tests/connection-drop.test.ts`）
- [x] 断线后不重发任何东西（只读 `sync` / `messages`），设备命令不会因此再跑一遍
- [x] 确认长时间没动静的流不会被中间层当空闲掐掉：运行时本来每 15 秒写 `: keep-alive`（预览 + 掐 25 秒空闲的中间层实测 60 秒不出声的一轮不断），不另加
- [x] 服务重启时还在跑的那一轮，开机补完：没结果的工具调用补「被打断」结果 + 说明原因的 RUN_ERROR，对话记录也补上（`server/tests/restart-interrupted-run.integration.test.ts`）
- [x] 更新器切换前等正在回答的对话结束（最多 `DRAIN_SECONDS`=900 秒），不再拦腰截断
- [x] 预览 e2e（`wt-modeldrop-h`：假模型长时间不出声 + 会掐空闲 / 会整条断线的中间层 + 重启预览）：整条断线时修前报「暂时连不上模型服务」，修后不报错、回答完整、卡片不转；重启时报连接断了而不是模型

## CB-079

**简单回合隐藏步骤卡；回答下面的空气泡和多余空白**  
里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `P1` `status: done`

用户 2026-10-16 18:39 截图（「k看我当前的电脑」）：开场一句一个气泡、「✓ 做了 2 步 7 秒」、回答下面一个空的小气泡、截图下面一大块空。「做了 2 步 7 秒这个应该隐藏，下面还有额外的空白」。DESIGN.md §93。
根因：干活卡对任何一轮都画；开场一句按 §90 留成气泡；只有图片的一段画成空气泡（图片不内联画）；新一轮对齐到顶上时滚动容器垫的空在一轮结束后不收，刷新后还被放回去。

#### 验收标准
- [x] 做完的简单回合（1–3 个只读工具、都成功、有结果、没确认、≤15 秒）不画干活卡；实时照常显示；长 / 出错 / 停止 / 要确认 / 改东西的回合保留
- [x] 有干活卡的一轮里开场一句收进卡片（实时 / 结束 / 刷新一样）
- [x] 不画只有图片的空气泡，图片在回答下面
- [x] 一轮结束后回答下面只有正常底边距（平滑落下、不往回跳），刷新后一样
