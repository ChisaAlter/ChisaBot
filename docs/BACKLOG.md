# Backlog（议题清单）

> 状态最后核对：2026-11-24（`v0.1.186`）。
>
> **为什么是文件**：仓库的 GitHub Issues 目前是关闭的（fork 默认关闭，自动化令牌没有仓库管理权限，开不了）。在仓库所有者打开
> Settings → General → Features → Issues 之前，这里就是 issue 列表；打开之后每一条按 ID 原样建成 GitHub issue，标签、里程碑、
> 验收标准一致，这个文件改成索引（ID → issue 编号）。标签和里程碑已经在 GitHub 上建好。

规则：

- 一条 = 一个可验收的结果。新需求先在这里加一条（下一个 ID），再开分支；PR 描述写 `Backlog: CB-0xx`。
- 状态写在标签行：`status: in-progress`（有人在做）、`blocked`（写明卡在哪）、`needs-user`（要用户操作 / 决定）、`deferred`（以后再做）、`dropped`（功能已下线不再执行）。
- 做完：勾掉验收标准，写 PR 号或版本说明。
- 优先级：P0 立刻 / P1 这一轮 / P2 排队。里程碑见 [ROADMAP](ROADMAP.md)。

| ID                | 标题                                                                              | 里程碑                | 标签                                                                                          |
| ----------------- | --------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| [CB-143](#cb-143) | 回复中途阶段感知实时插话与前后端全链路丝滑优化（Wave 1–3）                        | 成熟度 Maturity       | `type: feat` · `type: perf` · `area: chat` · `area: agents` · `P1` · `status: done`（#572 · `v0.1.177`）           |
| [CB-142](#cb-142) | ProkBot 全量对标：多端 AI 交互体验、多模态/实时语音、微应用生态、本机桥接与底座安全加固（Wave 1–10） | 成熟度 Maturity       | `type: feat` · `area: chat` · `area: agents` · `area: devices` · `area: infra` · `P1` · `status: done`（`v0.1.170`） |
| [CB-141](#cb-141) | 用户链接预览卡片与消息右沿对齐                                                    | 成熟度 Maturity       | `type: bug` · `area: chat` · `P1` · `status: done`（`v0.1.170` · 从 `wip/link-card-align-recovered` 提取合入 `main`） |
| [CB-140](#cb-140) | 皮肤轴升级为主题族：浅 / 深双槽独立选族、seed 派生令牌                          | 成熟度 Maturity       | `type: feat` · `area: settings` · `area: web` · `P1` · `status: done`（#562 · `v0.1.170`） |
| [CB-139](#cb-139) | 弹出面板颜色回归——底色多通道收口；窗口按钮条退出材质体系                | 成熟度 Maturity       | `type: bug` · `area: web` · `P1` · `status: done`（#565 · `v0.1.169`）                                     |
| [CB-138](#cb-138) | 右边缘「面板」把手不进液态玻璃材质，浅色下是一块白牌                    | 成熟度 Maturity       | `type: bug` · `area: web` · `P1` · `status: done`（#563 · `v0.1.168`）                                     |
| [CB-137](#cb-137) | PC 更新「稍后」永远不再提醒——待安装状态按周期重弹提示窗                    | 设备核心 Devices core | `type: bug` · `area: pc` · `P1` · `status: done`（#560 · `v0.1.167`）                                     |
| [CB-136](#cb-136) | PC 客户端发版后不收敛：待安装冻结检查 + 内置前端切换晚于页面加载                  | 设备核心 Devices core | `type: bug` · `area: pc` · `P1` · `status: done`（#558 · `v0.1.166`）                                     |
| [CB-135](#cb-135) | 网页新构建上线后页面不自动换新版，靠用户手点刷新横幅                            | 成熟度 Maturity       | `type: feat` · `area: web` · `P1` · `status: done`（#556 · `v0.1.165`）                                     |
| [CB-134](#cb-134) | 深浅 × 配色 × 动态天象组合混乱，外观模型重构为「模式 × 皮肤 × 背景」              | 成熟度 Maturity       | `type: feat` · `area: settings` · `area: web` · `P1` · `status: done`（#555 · `v0.1.165`）                  |
| [CB-133](#cb-133) | 左栏收起态与展开态元素过多，重新设计收敛为单条玻璃列                              | 成熟度 Maturity       | `type: feat` · `area: web` · `P1` · `status: done`（#553 · `v0.1.164`）                                     |
| [CB-132](#cb-132) | PC 恢复态窗口被拖到右缘出屏时「面板」把手被裁半条                                 | 成熟度 Maturity       | `type: bug` · `area: pc` · `P1` · `status: done`（#551 · `v0.1.163`）                         |
| [CB-131](#cb-131) | 聊天流式输出底边乱跳、干活卡收起留白残留与思考胶囊圆角不对齐                      | 成熟度 Maturity       | `type: bug` · `area: chat` · `P1` · `status: done`（#550 · `v0.1.162`）                       |
| [CB-130](#cb-130) | 聊天输入框悬浮可拖拽调整、收展 FLIP 过渡与 PC 小窗切换动画                        | 成熟度 Maturity       | `type: feat` · `area: chat` · `area: pc` · `P1` · `status: done`（`v0.1.160`）                |
| [CB-129](#cb-129) | 桌面端内置本地前端与「版本高者优先」同源加载                                      | 设备核心 Devices core | `type: feat` · `area: pc` · `area: web` · `P1` · `status: done`（`v0.1.154`）                 |
| [CB-128](#cb-128) | 多图附件与多卡片错落扇形牌组展示及生成式界面拆壳升级                              | 成熟度 Maturity       | `type: feat` · `area: chat` · `area: images` · `P1` · `status: done`（`v0.1.152`）            |
| [CB-127](#cb-127) | 任务中心四列看板与本地 Markdown（Autobahn / ROADMAP+BACKLOG）双向协同             | 成熟度 Maturity       | `type: feat` · `area: agents` · `area: web` · `P1` · `status: done`（`v0.1.151`）             |
| [CB-126](#cb-126) | 自定义壁纸按屏幕比例或自由框选裁剪与无损源图重裁                                  | 成熟度 Maturity       | `type: feat` · `area: settings` · `P1` · `status: done`（`v0.1.149`）                         |
| [CB-125](#cb-125) | 主 Agent 绑定管理、置顶展示与新会话暂停草稿无损切换                               | 成熟度 Maturity       | `type: feat` · `area: agents` · `area: web` · `P1` · `status: done`（`v0.1.149`）             |
| [CB-124](#cb-124) | 审查收尾：surface 依赖方向归位与 env / fetch / import 三道护栏                    | 成熟度 Maturity       | `type: chore` · `area: infra` · `P1` · `status: done`（`v0.1.149`）                           |
| [CB-123](#cb-123) | PC 客户端 macOS 版（dmg + 在线更新）                                              | 设备核心 Devices core | `type: feat` · `area: pc` · `P1` · `status: done`（#532 · `v0.1.148`，后续 Apple 签名待办）   |
| [CB-122](#cb-122) | 全页面 UI 审查整改：对齐、动态布局与弹窗可达性                                    | 成熟度 Maturity       | `type: bug` · `area: web` · `P1` · `status: in-progress`（#535 已合并 · `v0.1.148`）          |
| [CB-121](#cb-121) | 模型等待由用户停止，不因长时间无输出自动结束                                      | 成熟度 Maturity       | `type: bug` · `area: models` · `P1` · `status: in-progress`                                   |
| [CB-120](#cb-120) | 任务中心统一原位弹出，不跳转当前页面                                              | 成熟度 Maturity       | `type: bug` · `area: web` · `P1` · `status: in-progress`                                      |
| [CB-119](#cb-119) | 数据库普通查询与事务隔离、CI 收尾                                                 | 成熟度 Maturity       | `type: bug` · `area: infra` · `P1` · `status: done`（#530）                                   |
| [CB-118](#cb-118) | 全面清理 早期上游模板 印记、退役过渡内核与废弃空表收尾                            | 精简 Slim             | `type: chore` · `area: slim` · `area: infra` · `area: docs` · `P0` · `status: done`           |
| [CB-117](#cb-117) | 聊天、任务与桌面操作连续性优化                                                    | 成熟度 Maturity       | `type: bug` · `type: perf` · `area: chat` · `area: agents` · `P1` · `status: done`            |
| [CB-116](#cb-116) | 个人助理恢复、通知与发布接线收尾                                                  | 成熟度 Maturity       | `type: bug` · `area: infra` · `P1` · `status: done`                                           |
| [CB-115](#cb-115) | DSH 主内核与自有会话运行层                                                        | 成熟度 Maturity       | `type: feat` · `area: agents` · `area: chat` · `P1` · `status: done`                          |
| [CB-114](#cb-114) | 聊天模型回退错误归属、流式气泡与留白                                              | 成熟度 Maturity       | `type: bug` · `area: chat` · `area: models` · `P0` · `status: done`                           |
| [CB-001](#cb-001) | 审批卡片与审批偏好（Hark parity 第 5 项）                                         | Hark parity           | `type: feat` · `area: approvals` · `area: chat` · `P1` · `status: done`                       |
| [CB-002](#cb-002) | 生图 / 识图模型设置：管理员默认 + 每人可覆盖                                      | Hark parity           | `type: feat` · `area: images` · `area: settings` · `P1` · `status: done`                      |
| [CB-003](#cb-003) | 成熟度扫查：设备流程优先的全量体验检查                                            | 成熟度 Maturity       | `type: chore` · `area: devices` · `area: chat` · `P1` · `status: done`（三轮已上线）          |
| [CB-004](#cb-004) | 设备上的编码工具：云端机器人读 / 改 / 写本地代码                                  | 设备核心 Devices core | `type: feat` · `area: devices` · `area: pc` · `P0` · `status: done`                           |
| [CB-005](#cb-005) | 无界面设备节点：Linux / macOS 服务器也能当设备                                    | 设备核心 Devices core | `type: feat` · `area: devices` · `area: infra` · `P1` · `status: done`                        |
| [CB-006](#cb-006) | 设备「完全访问」模式                                                              | 设备核心 Devices core | `type: feat` · `area: devices` · `area: approvals` · `P1` · `status: done`                    |
| [CB-007](#cb-007) | 本地 agent 运行时与 agent 选择（可选）                                            | 设备核心 Devices core | `type: feat` · `area: agents` · `area: devices` · `P1` · `status: done`                       |
| [CB-008](#cb-008) | 本地 agent 的沙箱 / 权限配置档                                                    | 设备核心 Devices core | `type: feat` · `area: agents` · `area: approvals` · `P1` · `status: done`                     |
| [CB-009](#cb-009) | 瘦身 P3：删不发布的目录 + 修 server-typecheck CI                                  | 精简 Slim             | `type: chore` · `area: slim` · `area: infra` · `P1` · `status: done`                          |
| [CB-010](#cb-010) | 瘦身 P4a：删前端死页                                                              | 精简 Slim             | `type: chore` · `area: slim` · `area: settings` · `P1` · `status: done`                       |
| [CB-011](#cb-011) | 瘦身 P4b：不再构造上游服务端模块（表保留）                                        | 精简 Slim             | `type: chore` · `area: slim` · `area: infra` · `P1` · `status: done`                          |
| [CB-012](#cb-012) | 项目维护与文档系统（labels / milestones / ROADMAP / ADR / 模板）                  | 成熟度 Maturity       | `type: docs` · `area: docs` · `P1` · `status: done（Issues 待仓库所有者打开）`                |
| [CB-013](#cb-013) | Google 账号连接（Hark parity 最后一项）                                           | Hark parity           | `type: feat` · `area: settings` · `P2` · `status: deferred`                                   |
| [CB-014](#cb-014) | 每日简报（Hark parity 第 9 项，可选）                                             | Hark parity           | `type: feat` · `area: schedules` · `P2` · `status: done`（随个人助理晨报上线）                |
| [CB-015](#cb-015) | 瘦身 P4c：合并重复系统（依赖并行功能）                                            | 精简 Slim             | `type: chore` · `area: slim` · `P2` · `status: blocked`                                       |
| [CB-016](#cb-016) | 瘦身 P5：DROP 上游与已下线模块废弃空表（迁移 0068）                               | 精简 Slim             | `type: chore` · `area: slim` · `area: infra` · `P2` · `status: done`                          |
| [CB-017](#cb-017) | 真机验证：Windows PC 客户端与安卓手机                                             | 0.2.0 release         | `type: chore` · `area: pc` · `area: android` · `P1` · `status: needs-user`                    |
| [CB-018](#cb-018) | 旧内部 0.2.x 开发客户端手动覆盖重装为正式 0.1.x（当前 v0.1.183）                  | 0.2.0 release         | `type: chore` · `area: pc` · `P1` · `status: needs-user`                                      |
| [CB-019](#cb-019) | 发版 0.2.0（PC + Android）                                                        | 0.2.0 release         | `type: chore` · `area: infra` · `area: pc` · `area: android` · `P1`                           |
| [CB-020](#cb-020) | CI「ChisaBot checks」server-typecheck 在 main 上一直失败                          | 精简 Slim             | `type: bug` · `area: infra` · `P1` · `status: done`                                           |
| [CB-021](#cb-021) | 一轮里两次 page_update 会出两张同一页面的卡片                                     | 成熟度 Maturity       | `type: bug` · `area: pages` · `area: chat` · `P2` · `status: done`                            |
| [CB-022](#cb-022) | 只读工具的结果没有卡片（只有文字）                                                | 成熟度 Maturity       | `type: feat` · `area: chat` · `P2` · `status: done`                                           |
| [CB-023](#cb-023) | 后台任务卡片在参数流完前显示笼统的「正在交给后台…」                               | 成熟度 Maturity       | `type: bug` · `area: chat` · `P2` · `status: done`                                            |
| [CB-024](#cb-024) | 切换暗色外观卡约 400ms（毛玻璃重绘已修，长对话主线程见 CB-025）                   | 成熟度 Maturity       | `type: perf` · `area: chat` · `area: settings` · `P2` · `status: done`                        |
| [CB-025](#cb-025) | 打开长对话首屏渲染约 1 秒                                                         | 成熟度 Maturity       | `type: perf` · `area: chat` · `P2` · `status: done`                                           |
| [CB-026](#cb-026) | chisabot_bot_threads：确认没有孤儿指针行                                          | 成熟度 Maturity       | `type: chore` · `area: chat` · `P2`                                                           |
| [CB-027](#cb-027) | IM 定时推送受平台被动回复窗口限制                                                 | 成熟度 Maturity       | `type: bug` · `area: im` · `area: schedules` · `P2` · `status: done`                          |
| [CB-028](#cb-028) | 「开场一句」只在显示时折叠，事件历史里仍保存                                      | 成熟度 Maturity       | `type: chore` · `area: chat` · `P2`                                                           |
| [CB-029](#cb-029) | 弹窗打开动画仍有毛玻璃开销                                                        | 成熟度 Maturity       | `type: perf` · `area: settings` · `P2` · ✅ 0.1.38                                            |
| [CB-030](#cb-030) | 设备能力「打开」实际可执行任意命令，却标为非危险                                  | 设备核心 Devices core | `type: bug` · `area: devices` · `area: pc` · `P1` · `status: done`                            |
| [CB-031](#cb-031) | 本地对话事件表无上限增长                                                          | 成熟度 Maturity       | `type: chore` · `area: chat` · `area: infra` · `P2`                                           |
| [CB-032](#cb-032) | 安卓签名改为 CI 内签名（需要仓库 Actions secrets）                                | 0.2.0 release         | `type: chore` · `area: android` · `area: infra` · `P2` · `status: needs-user`                 |
| [CB-033](#cb-033) | 生产跨部署 stale-chunk 测试待跑                                                   | 成熟度 Maturity       | `type: chore` · `area: infra` · `P2`                                                          |
| [CB-034](#cb-034) | 用真实账号验证 GitHub 连接与 IM 接入                                              | 成熟度 Maturity       | `type: chore` · `area: github` · `area: im` · `P2` · `status: needs-user`                     |
| [CB-035](#cb-035) | 备用模型：管理员排序的回退列表 + 对话里说明换了模型 + 自检走回退                  | 成熟度 Maturity       | `type: bug` · `area: models` · `area: chat` · `P0` · `status: done`                           |
| [CB-040](#cb-040) | 多用户：管理员给朋友开账号（每人独立的机器人 / 记忆 / 密钥 / 设备）               | 成熟度 Maturity       | `type: feat` · `area: infra` · `area: settings` · `P0` · `status: done`（网关邀请默认关）     |
| [CB-041](#cb-041) | 真实聊天路径（频道聊天）刷新 / 断网后正在写的回答丢失                             | 成熟度 Maturity       | `type: bug` · `area: chat` · `P0` · `status: done`                                            |
| [CB-042](#cb-042) | 重新生成 / 编辑后重发                                                             | 成熟度 Maturity       | `type: feat` · `area: chat` · `P1` · `status: done`                                           |
| [CB-043](#cb-043) | 频道聊天的跨设备实时同步（手机发的桌面看不到）                                    | 成熟度 Maturity       | `type: bug` · `area: chat` · `area: pwa` · `P1` · `status: done`                              |
| [CB-044](#cb-044) | 登录页预填管理员账号名                                                            | 成熟度 Maturity       | `type: bug` · `area: infra` · `P1` · `status: done`                                           |
| [CB-045](#cb-045) | 每人模型额度 / 用量上限                                                           | 成熟度 Maturity       | `type: feat` · `area: models` · `P2` · `status: done`                                         |
| [CB-046](#cb-046) | 两套聊天实现（/bot 与 /channel）收成一套                                          | 成熟度 Maturity       | `type: chore` · `area: chat` · `P1` · `status: done`                                          |
| [CB-047](#cb-047) | 很长的对话打开时历史晚到，画面停在上面                                            | 成熟度 Maturity       | `type: bug` · `area: chat` · `P2` · `status: done`（#146，继续观察）                          |
| [CB-048](#cb-048) | 对话像发短信：先答、短气泡、不讲方法、草稿卡 / 代码卡 / 回复引用（完成）          | Hark parity           | `type: feature` · `area: chat` · `P1`                                                         |
| [CB-049](#cb-049) | 主对话干活卡：当前步骤 + 用时，结束收成一行（完成）                               | Hark parity           | `type: feature` · `area: chat` · `P1`                                                         |
| [CB-050](#cb-050) | 商品 / 地点推荐用带图的卡片网格（完成）                                           | Hark parity           | `type: feature` · `area: chat` · `P2`                                                         |
| [CB-051](#cb-051) | 「待处理」页是上游审批页：重复的开关、英文、已不存在的桌面应用、团队规则（完成）  | 成熟度 Maturity       | `type: bug` · `area: approvals` · `area: settings` · `P1`                                     |
| [CB-052](#cb-052) | 手机上设备「完全访问」时长按钮一个字一行（完成）                                  | 成熟度 Maturity       | `type: bug` · `area: devices` · `area: pwa` · `P1`                                            |
| [CB-053](#cb-053) | 找不到 / 读不到：机器人、对话只有一行红字没有出路；连接器页标题是原始 key（完成） | 成熟度 Maturity       | `type: bug` · `area: settings` · `P2`                                                         |
| [CB-054](#cb-054) | 机翻 / 上游行话残留：账号连接空状态、「AI 同事」（完成）                          | 成熟度 Maturity       | `type: bug` · `area: settings` · `P2`                                                         |
| [CB-055](#cb-055) | 机器人资料页模型下拉显示原始模型 id（完成）                                       | 成熟度 Maturity       | `type: bug` · `area: models` · `P2`                                                           |
| [CB-056](#cb-056) | 管理页英文：插件目录说明、权限规则快捷规则说明、活动记录事件类型（完成）          | 成熟度 Maturity       | `type: bug` · `area: settings` · `P2`                                                         |
| [CB-057](#cb-057) | 活动记录表格在 390 宽被截掉右边几列（完成）                                       | 成熟度 Maturity       | `type: bug` · `area: settings` · `area: pwa` · `P2`                                           |
| [CB-058](#cb-058) | 设置左栏在 1280×860 下「管理 / 高级」7 项在可视区外，只有淡出提示（完成）         | 成熟度 Maturity       | `type: chore` · `area: settings` · `P2`                                                       |
| [CB-061](#cb-061) | 云端 Claude Code P1：云端工作区节点 + 网页登录 Claude                             | 设备核心 Devices core | `type: feat` · `area: agents` · `area: infra` · `P1` · `status: dropped（已随 CB-099 下线）`  |
| [CB-062](#cb-062) | 云端 Claude Code P2：左栏切换、会话、对话、审批、右栏 / 手机抽屉                  | 设备核心 Devices core | `type: feat` · `area: agents` · `area: chat` · `P1` · `status: dropped（已随 CB-099 下线）`   |
| [CB-063](#cb-063) | 云端 Claude Code P3：GitHub 工作区（克隆、cc/ 分支、合入、推送并开 PR）           | 设备核心 Devices core | `type: feat` · `area: agents` · `area: github` · `P1` · `status: dropped（已随 CB-099 下线）` |
| [CB-064](#cb-064) | 云端 Claude Code P4：电脑文件夹同步（PC 新版）                                    | 0.2.0 release         | `type: feat` · `area: pc` · `area: agents` · `P2` · `status: dropped（已随 CB-099 下线）`     |
| [CB-065](#cb-065) | 云端 Claude Code P5：ChisaCloudCode 留还是下线                                    | 设备核心 Devices core | `type: chore` · `area: infra` · `P2` · `status: dropped（已随 CB-099 下线）`                  |
| [CB-066](#cb-066) | 在云端完成 Claude 登录（远程浏览器）+ Claude 上游代理                             | 设备核心 Devices core | `type: feat` · `area: agents` · `area: infra` · `P1` · `status: dropped（已随 CB-099 下线）`  |
| [CB-067](#cb-067) | 新版本前功能精简：隐藏用不到的功能、新建机器人两格                                | 精简 Slim             | `type: chore` · `area: web` · `P1` · `status: done`（#163）· 4 项待所有者决定                 |
| [CB-068](#cb-068) | Android 原生版（Kotlin + Compose）                                                | 成熟度 Maturity       | `type: feature` · `area: android` · `P1` · `status: done`（#168 v0.1.13、#176 v0.1.14）       |
| [CB-069](#cb-069) | 新建 / 修改机器人统一表单 + 圆形头像（上传 / 表情 / 首字）                        | 成熟度 Maturity       | `type: feat` · `area: web` · `P1` · `status: done`（#170）                                    |
| [CB-070](#cb-070) | 全站 UI 文字对齐 + 干活卡上下间距                                                 | 成熟度 Maturity       | `type: fix` · `area: web` · `P1` · `status: done`（#172、#178、#182）                         |
| [CB-071](#cb-071) | 打开对话落在最新一条、不跳；切机器人秒开；接入回放瘦身                            | 成熟度 Maturity       | `type: bug` · `area: chat` · `P0` · `status: done`                                            |
| [CB-072](#cb-072) | 机器人 ↔ Claude Code 切换整屏刷新 → 原地切换                                      | 成熟度 Maturity       | `type: bug` · `area: web` · `P1` · `status: done`                                             |
| [CB-073](#cb-073) | Claude 上游代理支持 trojan / vless 等节点链接（sing-box 转换）                    | 云端 Claude Code      | `type: feature` · `area: cloud-cc` · `P1` · `status: done`                                    |
| [CB-074](#cb-074) | 电脑文件夹导入失败后残留、移除后无法重新导入                                      | 成熟度 Maturity       | `type: bug` · `area: pc` · `area: agents` · `P0` · `status: done`                             |
| [CB-077](#cb-077) | 中途说明文字没折叠进步骤；断线重接同一段话出现两遍                                | 成熟度 Maturity       | `type: bug` · `area: chat` · `P0` · `status: done`                                            |
| [CB-075](#cb-075) | 每个机器人记住我的操作状态；消息记录仍会往回跳                                    | 成熟度 Maturity       | `type: bug` · `area: chat` · `P0` · `status: done`                                            |
| [CB-076](#cb-076) | 「模型老断」：长命令 / 断线 / 部署重启时这一轮被误报成「连不上模型服务」          | 成熟度 Maturity       | `type: bug` · `area: chat` · `P0` · `status: done`                                            |
| [CB-078](#cb-078) | 窄窗口里输入框两边没有间距                                                        | 成熟度 Maturity       | `type: bug` · `area: web` · `P1` · `status: done`                                             |
| [CB-079](#cb-079) | 简单回合隐藏步骤卡；回答下面的空气泡和多余空白                                    | 成熟度 Maturity       | `type: bug` · `area: chat` · `P1` · `status: done`                                            |
| [CB-080](#cb-080) | 连续聊天时发消息整页上跳                                                          | 成熟度 Maturity       | `type: bug` · `area: chat` · `P1` · `status: done`                                            |
| [CB-081](#cb-081) | 机器人浏览器多标签 + 收藏夹                                                       | 成熟度 Maturity       | `type: feat` · `area: computer` · `P1` · `status: done`                                       |
| [CB-082](#cb-082) | 浏览器暗色图标 + 外侧去掉标签 + 放大页重排 + 旧测试                               | 成熟度 Maturity       | `type: bug` · `area: computer` · `P1` · `status: done`                                        |
| [CB-083](#cb-083) | 设置重新整合 + 设置搜索；输入框权限（请求批准 / 完全访问）                        | 成熟度 Maturity       | `type: feat` · `area: web` · `area: devices` · `P1` · `status: done`                          |
| [CB-084](#cb-084) | 从其他页面切回机器人页总要刷新一次                                                | 成熟度 Maturity       | `type: bug` · `area: chat` · `area: web` · `P1` · `status: done`                              |
| [CB-085](#cb-085) | 搜索旁新建机器人；弹出面板与常驻面板一致                                          | 成熟度 Maturity       | `type: bug` · `area: web` · `P1` · `status: done`                                             |
| [CB-086](#cb-086) | 连续补话不重复执行；停止按钮终止当次计算机命令                                    | 成熟度 Maturity       | `type: bug` · `area: chat` · `area: computer` · `P1` · `status: done`                         |
| [CB-087](#cb-087) | 聊天可靠性全面修复：滚动、队列恢复、请求与编码                                    | 成熟度 Maturity       | `type: bug` · `area: chat` · `area: computer` · `P1` · `status: done`                         |
| [CB-088](#cb-088) | 面板级模型：刷新回合可以用面板自己选的模型                                        | 成熟度 Maturity       | `type: feat` · `area: web` · `area: models` · `P2` · `status: planned`                        |
| [CB-089](#cb-089) | Word（.docx）文件在线预览                                                         | Hark parity           | `type: feat` · `area: chat` · `P0` · `status: done`                                           |
| [CB-090](#cb-090) | 对话里的选项卡片：选完就定、不能重复点                                            | Hark parity           | `type: feat` · `area: chat` · `P0` · `status: done`                                           |
| [CB-091](#cb-091) | 主机器人不能直接删除；菜单里可以更换主机器人                                      | 成熟度 Maturity       | `type: bug` · `area: agents` · `P1` · `status: done`                                          |
| [CB-092](#cb-092) | 机器人资料页加「文件与页面」                                                      | 成熟度 Maturity       | `type: feat` · `area: agents` · `P1` · `status: done`                                         |
| [CB-093](#cb-093) | 机器人之间的往来视图（单聊里 @另一个机器人）                                      | Hark parity           | `type: feat` · `area: chat` · `area: agents` · `P1` · `status: done`                          |
| [CB-094](#cb-094) | 有面板以后也能从右栏快速新建                                                      | 成熟度 Maturity       | `type: feat` · `area: web` · `P2` · `status: done`                                            |
| [CB-095](#cb-095) | 账号连接页分标签（全部 / 连接 / 登录信息 / 密钥）                                 | 成熟度 Maturity       | `type: feat` · `area: settings` · `area: vault` · `P2` · `status: done`                       |
| [CB-096](#cb-096) | 引导页标题和「继续」按钮被天空背景遮住                                            | 成熟度 Maturity       | `type: bug` · `area: web` · `P2` · `status: done`                                             |

> CB-089…CB-095 来自 2026-10-25 对 Hark 网页版与 Grok Bot 桌面端的实测对标（只收有截图 / DOM 证据、且与 DESIGN.md 不冲突的项）。破冰卡、机器人主题色、衬线标题、环境时钟、吉祥物头像等与 §46.2 / §9.3 / §7.4 / §74 冲突的项不进 backlog，等所有者决定。

## CB-143

**回复中途阶段感知实时插话与前后端全链路丝滑优化（Wave 1–3）**

标签：`type: feat` · `type: perf` · `area: chat` · `area: agents` · `P1` · `status: done`

- 状态：已在分支 `feat/smooth-chat-and-live-steer` 完成 Wave 1–3 全量实现与自动化验证（规范见 `DESIGN.md` §149）。
- [x] **Wave 1 · 阶段感知实时插话**：DSH 插件/客户端支持 `STEER_CUT`、`phase` 追踪与只读工具 1s 自动后台化；服务端新增 `InboxDeliveryMode`（`"steer" | "queue"`）、单调 `epoch` 并发护栏、`PATCH .../inbox` 与侧边抽屉主线插话；前端默认开启实时插话并提供设置偏好、发送区切换与 `QueueDock` 行内编辑/立即插话/撤回。
- [x] **Wave 2 · 零等待 SSE、写库合批、DSH 连接池与单跳发送**：`local-conversations.ts` 解耦 live 推送与 50ms 写库合批、消除逐 token `structuredClone` 与 500ms PG 轮询；`routes.ts` 与 `session-client.ts` 实现 `POST /commands` 单跳 SSE 与背压合批；`dsh-client-pool.ts` 与 `dsh-runtime.ts` 复用 `DshHostClient`、健康缓存并跳过冗余 `/checkpoint`；`panels/api.ts` 增加 30s 转发头缓存。
- [x] **Wave 3 · 前端叶子级流式、长消息折叠与交互性能预算**：`useLiveMessageText`（rAF 合批）+ 结构签名门控 + `<LiveBotBubbles>`/`Segment`/`SmoothStreamdown` `memo`；>20k 围栏代码块安全折叠；`smooth-reveal.ts` 顺滑流贴合；保留裸代码块无模糊，普通聊天气泡与顶层对话卡片在 `v0.1.178` 恢复与侧栏一致的四档 `--lg-blur` 磨砂质感；`<SettleAtEnd busy={busy || live} />`、`useMotionRest` 与边缘触发 `nextIdleInboxCheck`。

## CB-142

**ProkBot 全量对标：多端 AI 交互体验、多模态/实时语音、微应用生态、本机桥接与底座安全加固（Wave 1–10）**

标签：`type: feat` · `area: chat` · `area: agents` · `area: devices` · `area: infra` · `P1` · `status: done`

- 状态：已由原开发分支 `feat/prokbot-parity` 合入 `main` 并随 `v0.1.170` 全端发版（Wave 1–10 全部 39 个 commit 经独立代码/安全复审闭环，对照清单见 [prokbot-comparison.md](prokbot-comparison.md) §6–§7，界面规范见 `DESIGN.md` §144）。
- [x] **Wave 1**：建档建分支 + 4 处半成品断口接通（多 Bot 置顶排序、20MB PDF/DOCX 上传、单实例聊天 TTS 与音频卡、DOM 示教录制 → 4 规则编译技能）+ `/admin/models` 语音服务管理台与音色试听。
- [x] **Wave 2**：AI 回复完成主动通知 + `(userId, channelId)` 前台抑制 + 全局频率策略 + WebAudio 5 档提示音 + 跨端 `chisabot://` 深链与 Android `ACTION_SEND` + `push_devices` 原生推送（APNs/FCM/Bark）+ 无界面幂等 `/api/intents`。
- [x] **Wave 3**：可插拔联网搜索后端 + 按模型覆写上下文/摘要阈值 + 多 Webhook 规则与 7 态流水面板 + Bot 常驻资料库 + 零 `blur(` 一键隐私遮罩 + 桌面壳右键/硬件加速/时区/出口白名单 + `docs/AI-INSTALL.md`。
- [x] **Wave 4**：按任务难度自适应路由 + 动态 `reasoning_effort`/Anthropic `thinking.budget_tokens` + 30 天路由日志与 Dry-Run + 本地时区/`kind`/`reasoning` 用量账本 + 热启停脱敏抓包观测器 + 7 角色系统提示词版本台（LCS Diff + 组装/工具透视）+ 7 开关 Harness 台。
- [x] **Wave 5**：Bot 配方与多文件技能一键脱敏分享 ZIP 生态 + 技能不可变版本栈/Diff/回滚 + 回合级 `requiresTools` 动态隐身 + 多文件只读技能包（事务替换 + `markUntrusted`）。
- [x] **Wave 6**：多生图/视频模型池 + ≤10 参考图 + `video_generate`/`video_inspect` 工具 + `<video>`/`<audio>` 聊天卡 + AI 生成 Bot 头像 + FFmpeg 纯管道音频转码 + 头像防像素炸弹 + 链接预览 Hover 零网络缓存 + 虚拟形象视线追踪/登录捂眼与 6 表情工位条。
- [x] **Wave 7**：全链路双向实时语音通话（60s 一次性票据 + WS Origin 校验 + 分态 VAD/真 `abort()` 打断 + 流式分句 PCM16 TTS + 播放回执与超时兜底 + 仅已播报入史 + 无 AEC 自动降级半双工 + PC/Android 原生 AEC3 钩子 + `AgentOrb` 声波共振）。
- [x] **Wave 8**：AI 自研微应用 / MCP 工具包（`app-builder` 仅落 `draft` + 固定 `process.execPath` 沙箱 `node-stdio` + Host 托管 OAuth + digest 锚定 + `requiresTools` 联动）+ 远端 MCP 全量增强 + 远程执行节点冷启动热切换与 DNS SSRF 拦截。
- [x] **Wave 9**：Coding Agent 同上下文续接/`needs_input` 追问/`status(waitMs)`/`pwd -P` 沙盒预检 + Chrome Cookie 单精确 `origin` 审批导入与 WebAuthn/Passkey 跨端转发 + 无障碍控件树语义操控与 `bundleId × directionEpoch` 代际授权 + 4 MiB 分块上传与原子下载 + 500 条脱敏环形诊断日志导出。
- [x] **Wave 10**：Supervisor 静默排空升级、付费外部调用 `(principal_id, request_key)` 幂等账本、凭据读时 `0600`/`O_NOFOLLOW` 与全仓唯一 tmp 原子写、装载物 Provenance 校验、OAuth `state` 绑定与刷新保护、审批 args 白名单与辅助审查分区、XFF 从右向左限流/配额/吊销断活流/hop-by-hop/body cap/64 MiB SSE 上限、Tool Journal 父子树与原子续跑、Handoff 双向对账、定时任务重启 `interrupted` 与去重账本、Ed25519 联邦签名基础协议。
- [x] **收官门禁验证**：`bun run check`（4,358 文件 `0 error 0 warning`）、12 项形式化+安全守卫 56/56（19,131 断言）、`bun run test:app` 373 文件（9 独立进程文件全绿 + 4 个长跑超时文件 `--timeout 15000` 复测 63/63 过）、全 10 波 `reviewer` 逐波终审通过。

## CB-141

**用户链接预览卡片与消息右沿对齐**

标签：`type: bug` · `area: chat` · `P1` · `status: done`

- 来源：`wip/link-card-align-recovered`（原 `codex/link-card-align`）提取合入 `main`。
- 原因：用户预览的外层容器已靠右，但满宽 flex 轨道里的单张链接卡仍从左边排列。
- [x] 修正用户链接卡轨道主轴对齐，保留助手左对齐和多卡扇形布局。
- [x] 隔离 fixture 浏览器检查入口 `tests/link-card-alignment/verify.mjs`（1280 亮 / 420 亮 / 390 暗：用户单卡与气泡右沿对齐，助手卡左对齐，多卡不溢出）。
- [ ] 聊天滚动七场景通过。
- [ ] 正式日用客户端确认卡片位置。

## CB-140

**皮肤轴升级为主题族：浅 / 深两个模式各自独立选族，令牌由 seed 派生**

标签：`type: feat` · `area: settings` · `area: web` · `P1` · `status: done`（#562 · `v0.1.170`）

原分支：`feat/theme-families`（已合入 `main` 并随 `v0.1.170` 发版）。CB-134 把模型收成「模式 × 皮肤 × 背景」后，皮肤轴仍是一条单选轴：一套皮肤的浅 / 深两版绑死在同一选项（造不出「浅色落樱 + 深色伦敦雨」混搭），10 套 `html[data-palette]` 静态令牌块躺样式表，明暗绑定皮肤只能靠 `boundMode` 特判翻转模式。按 DESIGN §143 重构：`ThemeFamily = { id, name, light, dark }`、`Seed = { ac, bg, fg, c }`，`AppearanceState` 换 `familyLight` / `familyDark` 双槽 + `customFamilies`，令牌全部由 `deriveSeed` 派生、启动脚本写 `data-theme-family`。

- [x] **双槽独立选族**：`setThemeHalf(mode, id)` 只写对应槽；族卡左右分半预览（各 seed 的 bg/ac 小样），8 内置族 + 第 9 张自定义族卡 / 编辑器（`chisabot-theme-families`）。
- [x] **seed 派生令牌**：`deriveSeed(seed, dark)` 出强调色 / 文字层级 / 边框 / 玻璃 / `--fam-sky-*` 四段天空；styles.css 删全部 `data-palette` 块，启动脚本（`familyBootScript`，构建时内联 `deriveSeed`）与 `applyAppearanceToDocument` 同一路径写 DOM。
- [x] **迁移与兼容**：`chisabot-theme-palette` 老键一次性映射迁移两槽（boot 与应用同规则）；`boundMode` 明暗绑定皮肤删除；auto 天象改随族 `seed.scene`，§140 昼夜配对不变式不动；壁纸 / 玻璃 / skySource 行为全部保留。
- [x] **验收**：`bun run check`（typecheck + biome 全仓 0 error 0 warning）、`bun run test:app` 全绿；`tests/appearance-model/appearance.mjs` 真浏览器验收全项 PASS（族半边点击、两槽独立、主题天空卡、壁纸互斥、420 无横向溢出、零控制台错误），1280 / 420 / 深色三张截图见 PR #562。
- [x] PR #562 合并并发版（`v0.1.170`）；后续部署后生产观察。

## CB-139

**弹出面板颜色回归——底色多通道收口；窗口按钮条退出材质体系**

- `type: bug` · `area: web` · `P1` · `status: done`（#565 · `v0.1.169`）
- 问题（2026-11-19 用户截图实测）：窄窗口「面板」抽屉是一块均匀 `rgb(29,31,36)` 实心板而左栏仍是半透明玻璃；面板弹出后右上角 4 个窗口控制键带上深色药丸底。审计：`.rail-sheet` 的底历史上有三条通道都能画（`--lg-surface` 材质变量、perf/减透明/高对比/`data-resizing` 兜底名单的直接 `background`、sheet 基类 `bg-popover`），每次修一条另一条还会画；`.win-ctrls` 在 `--lg-surface-strong` 画底名单里，面板展开触发整屏 `data-lg-ink` 翻深釉时它跟着变出一块药丸。
- 验收：
  - [x] `.rail-sheet` 从 perf-noblur（两段）与 resize-pause 的直接实心底名单剔除，底色只走 `--lg-surface` 一条通道
  - [x] `.win-ctrls` 移出 `--lg-surface-strong` 画底名单，4 键常态无底；悬停 / 按下 / 关闭红 / 焦点环不变（已于 `DESIGN.md` §150 / `v0.1.179` 调整恢复四档 `--lg-surface-strong` + `--lg-blur` 磨砂角托、`1.25px` 描边与光学字缘保护以防亮壁纸下按键不可见，并跳过液态位移滤镜）
  - [x] `theme-glass-perf` 回归门：`.win-ctrls` 不进任何 `--lg-*` 画底选择器；render-budget 名单同步
  - [x] 矩阵 probe（明暗 × mist × perf/减透明/高对比/forced-colors/resizing）计算值 + 截图确认面板与按键条行为

## CB-138

**右边缘「面板」把手不进液态玻璃材质，浅色下是一块白牌**

- `type: bug` · `area: web` · `P1` · `status: done`（#563 · `v0.1.168`）
- 问题：`.rail-tab` 不在液态玻璃材质名单也不在 `GLASS_SURFACE_SELECTOR`，浅色模式用 `--glass-2` 渲染成近乎不透明的白块、字对比不足（用户截图实测）。
- 验收：
  - [x] `.rail-tab` 进各材质（liquid / crystal / frosted / mist × 明暗 + 压深底翻墨）名单，取 `--lg-surface-strong` 小面材质
  - [x] 进 `GLASS_SURFACE_SELECTOR`——跟用户雾度滑块、采样翻墨（深底自动浅墨）
  - [x] 小面不进模糊预算（本地 `--lg-blur: none`），render-budget 测试同步
  - [x] 悬停变宽 / Ctrl+Alt+B / `--edge-clip-r` / 窄窗口抽屉入口不变

## CB-137

**PC 更新「稍后」永远不再提醒——待安装状态按周期重弹提示窗**

标签：`type: bug` · `area: pc` · `P1` · `status: done`（#560 · `v0.1.167`）

分支：`fix/update-remind`。问题（2026-11-18 用户实测）：新版本下载完弹一次提示窗 + 系统通知（showInactive 不抢焦点，易漏看），关掉之后直到进程退出都没有任何再提醒——常驻托盘的客户端几乎不退出，「稍后 = 退出时自动装」等价于「永远不装」。叠加 CB-136 的冻结 bug，客户端 14 小时没有任何新版本动静。

- [x] **周期重弹（main.js）**：`downloaded` 状态下每 30 分钟检查一次，距上次弹窗 ≥ 4 小时就再弹提示窗 + 系统通知，直到安装或被更新版本顶掉；弹窗已开时不重复发通知。
- [x] **测试**：pc 全量 204 项通过。
- [x] PR #560 合并，`v0.1.167` 发版。

## CB-136

**PC 客户端发版后不收敛：待安装冻结检查 + 内置前端切换晚于页面加载**

标签：`type: bug` · `area: pc` · `P1` · `status: done`（#558 · `v0.1.166`）

分支：`fix/pc-update-converge`。问题（2026-11-18 用户实测）：客户端 0.1.159 装着，0.1.160 下载完「待安装」后更新器永久停止检查（`check()` 对 downloaded 直接返回），错过 0.1.161–0.164 四次发版；应用常驻托盘几乎不退出，autoInstallOnAppQuit 也轮不到，客户端无限期落后。同时「内置前端优先 + 服务器更高切远程」的仲裁结果只存内存：启动探测一失败，整个会话锁死在旧 bundle，会话中嗅探到新版本也只广播状态不重载已加载页面。

- [x] **待安装不冻结检查（updater.js）**：`downloaded` 状态照常进入检查，复查时临时关 `autoDownload`——同版本不重复拉包，源上出现更新版本就顶掉待安装的重新下载；复查失败 / 源上没更新都保留待安装状态。
- [x] **local→remote 翻转即重载（local-web.js / main.js）**：`onModeChange` 带上 `prevMode`，探测 / 嗅探晚于页面加载导致模式翻到 `remote` 时重载聊天窗口一次换到服务器前端（serverVersions 单调递增，每会话最多一次）。
- [x] **测试**：update.check.js 新增「更新版本顶掉待安装」「复查失败 / 空结果保留待安装」，local-web.check.js 断言事件携带 prevMode；pc 全量 204 项通过。
- [x] PR #558 合并，`v0.1.166` 发版；观察实机客户端在发版后自行追平。

## CB-135

**网页新构建上线后页面不自动换新版，靠用户手点刷新横幅**

标签：`type: feat` · `area: web` · `P1` · `status: done`（#556 · `v0.1.165`）

分支：`feat/web-auto-reload`。问题：部署后常开页面挂着旧构建直到用户自己点「有新版本，点此刷新」——旧页面可以挂几天。机制已具备：`useNewVersion` 轮询、`refreshWouldInterrupt()` 在刷新无损时返回 null（没在回复、没挂附件、没有没发出去的字；聊天草稿在 localStorage）。缺的是自动扣扳机：横幅出现期间每 15 秒查一次 `refreshWouldInterrupt()`，null 即 `window.location.reload()`。

- [x] **无损自动刷新**：`update-banner.tsx` 起 15s 轮询，`refreshWouldInterrupt() === null` → reload（注入 `reload` prop 供测试）；横幅保持可见，手动点击 + 既有确认框路径不变。
- [x] **不刷的场景**：busy / 挂附件 / 有未发内容时继续等；点 ✕ 关掉（`dismiss()`）取消自动刷新；`pcUpdateActive`（downloading / downloaded）不显示横幅也不自动刷。
- [x] **验收**：`bun run check` 0/0 + `app/tests/update-banner.test.tsx` 4 项（空闲到点刷一次 / 忙时等 / 关掉不刷 / PC 更新中不刷）。
- [x] PR #556 合并发版 `v0.1.165`；串行部署后生产观察。

## CB-134

**深浅 × 配色 × 动态天象组合混乱，外观模型重构为「模式 × 皮肤 × 背景」**

标签：`type: feat` · `area: settings` · `area: web` · `P1` · `status: done`（#555 · `v0.1.165`）

用户（2026-11-19）：「现在的深浅，主题，动态天象太乱了。特别是我浅色主题+墨夜背景，或者深色主题+素白背景，都没法看」。审查确认是模型问题不是配色问题：四条轴争同一块天空、非 default 配色静默劫持天空成天象死选项、`--sky-lift` / `--sky-muted` 护栏断线、「背景随时间变化」与 live 天象卡重复。按 DESIGN §140 重构。

- [x] **背景三选一互斥**：`chisabot-sky-source`（`hark` / `theme`）新键；皮肤卡 = 强调色 + 主题天空（壁纸启用中只换强调色），配色不再静默停引擎；老存档按键缺失时的旧语义迁移（皮肤非 default → `theme`）。
- [x] **昼夜配对不变式**：`HARK_SCENE_INFO` 给 12 个场景标 day / dusk / night + darkness，`resolveEffectiveHarkScene` 收口配对（浅色下夜景 → 黄昏 / 雨景、深色下日景 → 夜景）。
- [x] **明暗绑定皮肤**：素白 `boundMode:"light"` / 墨夜 `boundMode:"dark"`，点击连模式一起切，色板带日 / 月角标；天象卡带昼 / 暮 / 夜角标 + 「主题天空」卡。
- [x] **可读性护栏接电**：`resolveSkyReadability` 按有效天空明暗写 `--sky-lift` / `--sky-muted`，live 每分钟重算；删「背景随时间变化」开关行与 `usesPaletteGradientSky`。
- [x] **验收**：`bun run check` 0/0 + 外观套件 152 项通过（新增 appearance-sky-model 契约）；真浏览器 harness `tests/appearance-model/appearance.mjs` 16 项断言全过（配对 / 互斥 / data-sky / 移动端无溢出）。
- [x] PR #555 合并发版 `v0.1.165`；串行部署后生产观察。

## CB-133

**左栏收起态与展开态元素过多，重新设计收敛为单条玻璃列**

标签：`type: feat` · `area: web` · `P1` · `status: done`（#553 · `v0.1.164`）

用户（2026-11-18 截图实测）：收起后的左栏是展开钮、搜索钮、＋胶囊、头像卡、账号卡 5 个形状各异的悬浮件；展开态还有「主机器人 ★」「其他」两行分组标签与账号卡行尾切换箭头，元素太多太乱。按 DESIGN §139 收敛。

- [x] **收起态单条玻璃列**：`BotMiniRail` / `SectionRail` 收起结构改为一整张 `.glass-mini-card`——顶部 `.glass-mini-head` 幽灵图标组（展开 · 搜索 · 新建，新建是唯一填充面）、`.glass-mini-scroll` 头像区、`.glass-mini-foot` 账号头像，区间 `.glass-mini-div` 细分隔线；设置 / 管理收起栏同结构。
- [x] **展开态去分组标签**：删「主机器人」「其他」`glass-sec` 标签，主机器人置顶带星、`.glass-bot-sep` 细分隔线；账号卡去 chevron、内边距 6→4、行高 44→40。
- [x] **验收**：相关单测 95/95、lint 0 错；本机 Edge 实机验收——收起态单条玻璃列 / 展开态分隔线 / 390 抽屉，pageerrors 0。
- [x] #553 合并，`v0.1.164` 全端发版（versionCode 344）；串行部署完成，生产 smoke 通过（/api/version 0.1.164，bundle 含 .glass-mini-head）。

## CB-132

**PC 恢复态窗口被拖到右缘出屏时「面板」把手被裁半条**

标签：`type: bug` · `area: pc` · `P1` · `status: done`（#551 · `v0.1.163`）

分支：`fix/rail-tab-edge-clip`。0.1.161 的 `--edge-clip-r` 让位逻辑只在挂载 + `window.resize` 时量越屏量（`lib/desktop-window.ts`）；拖窗口不产生任何 DOM 事件、`chisabotWindow` 桥也没有 bounds 回调，恢复态窗口被拖到右缘出屏后变量停在旧值，`.rail-tab` 跟着出屏被裁半条（用户 2026-11-18 截图实测，DESIGN §82.11）。修复：250ms 轮询 `screenX + outerWidth` 对 `screen.avail` 重算越屏量，值变才写样式、最大化恒 0、轮询内不走 IPC；网页侧轮询同时覆盖没有 bounds 回调的旧 PC 客户端。

- [x] **轮询重算**：`useDesktopWindow` 挂载后每 250ms 比对越屏量并写 `--edge-clip-r`；读 `screenX` / `outerWidth` 不引发布局，值不变时不写样式。
- [x] **最大化恒 0**：`isMaximized()` 初值与 `onMaximizedChange` 同一处更新本地缓存，轮询不另发 IPC。
- [x] **验收**：窗口移动后 ~250ms 内把手保持贴在可见右缘（不随窗口出屏）。真 Chromium `tests/rail-edge-clip/edge-clip.mjs`：改 screenX 不发事件，`.rail-tab` computed `right` 在轮询周期内 0 → 860px → 0，最大化恒 0px；单测 `app/tests/desktop-window-edge-clip.test.tsx` 5 项。
- [x] PR #551 合并发版 `v0.1.163`；串行部署后生产观察。

## CB-131

**聊天流式输出底边乱跳、干活卡收起留白残留与思考胶囊圆角不对齐**

标签：`type: bug` · `area: chat` · `P1` · `status: done`（#550 · `v0.1.162`）

分支：`fix/chat-stream-jumps`。流式回答的 markdown 整块提交（一帧 +100~230px）时 `stickToBottom` 一律走 smooth，追一次 ~1.5s、每块落地又重启，画面每 ~2s 出现一次 ~230px 的底边下砸再往回漂；回合中点开再收起干活卡，收起那帧 ~65px 的变矮被 §88.1 补成留白、busy 期间一路 `skip:busy` 挂到回合结束（输入框上方留一块空白）；「思考中」胶囊 / 干活步骤列表用 999px 胶囊 / `--r-md` 圆角，与气泡 `--r-bubble` 不对齐（DESIGN §94.9）。

- [x] **busy 贴底同帧 `instant`**：`SettleAtEnd` 在 `s.busy` 且内容长高时 `scrollTo` 用 `"instant"`——同帧直接贴底，看不见中间位置；视口带 `.scroll-smooth`，`"auto"` 会按 computed `scroll-behavior` 解析回平滑，必须 instant 才跳过 CSS 并掐断在飞的那次滚动；不忙仍 smooth、宽度换行分支不变。真机 painted 帧 >50px 下砸 11~16 次 @~230px → 0~1 次。
- [x] **干活卡点开 / 收走在 content 捕获阶段处理**：记 `touchedAt` 使收起帧不进 §88.1 补留白分支；§94.6 floor 在场时把留白冻成渲染高度而不是删掉。实测收起后底边间距与展开时持平（基线残留 +45~55px），回合末照常收完。
- [x] **圆角对齐气泡**：`.rs-capsule` / `.chat-thinking` / `.chat-work-steps` 的 `border-radius` 统一为 `var(--r-bubble, 16px)`，与消息气泡同一令牌。
- [x] **真机滚动回归 harness 落地**：`tests/chat-scroll/work-card-jump.mjs`（mock 后端 + playwright-core 驱动本机浏览器，rAF 与 post-RO 双采样，场景 A 流式下砸 / 场景 B 展开收起留白，支持 `--answer` 正文矩阵与 `--viewports`）+ `perf/mock-server.mjs` 新增 opt-in `toolTurn` 模式（commands+events AG-UI SSE、web_search×2+web_fetch、`holdMs`），向后兼容。
- [ ] `tests/chat-scroll/regression.sh` 对真实预览实例 7 项（需 BASE/BOT/THREAD + Postgres，本机无实例，以 work-card-jump harness 为替代证据，部署后建议预览补跑）。
- [x] PR #550 合并发版 `v0.1.162`；串行部署后生产观察。

## CB-130

**聊天输入框悬浮可拖拽调整、收展 FLIP 过渡与 PC 小窗切换动画**

标签：`type: feat` · `area: chat` · `area: pc` · `P1` · `status: done`（`v0.1.160`）

输入框原来整行占位遮住对话底边、收展与 PC 小窗 ⇄ 主窗切换都直接跳变没有过渡。改为悬浮卡片 + 8 向拖拽 + 两套补间动画（DESIGN §138）。

- [x] **悬浮输入框与滚动区自适应**：`.chat-composer-box` 脱离文档流悬浮在对话底边上，消息从卡片底下滚过；`--chat-composer-h` 按实测高度补滚动区底部内边距并同步抬高「回到底部」药丸；桌面四边 / 四角隐形把手可拉大缩小（最小 320×120、夹回面板、尺寸进 localStorage、双击还原），触屏保持原底栏（`composer/dock.tsx` + `dock-geometry.ts`，回归 `app/tests/composer-dock.test.ts`）。
- [x] **收展 FLIP 过渡与箭头方向**：横条 ⇄ 卡片换形补 WAAPI 反向补间（高度 + 圆角 + 淡入 220ms，`prefers-reduced-motion` 跳过）；收起显示上箭头、展开显示下箭头，可访问名不变。
- [x] **PC 小窗切换 bounds 补间**：~60Hz 插值补间窗口 bounds 240ms ease-out（macOS 交系统 `setBounds(target, true)`），补间途中宽 resize 不判离小窗、恢复落地才 `maximize`，系统减少动画时直接落位（`pc/src/compact-window.js`，回归 `pc/test/compact.check.js`）。

## CB-129

**桌面端内置本地前端与「版本高者优先」同源加载**

标签：`type: feat` · `area: pc` · `area: web` · `P1` · `status: done`（`v0.1.154`）

桌面客户端直接内置构建好的网页前端，仅向服务端请求 API 数据与认证/公开路由；当连接了尚未升级的旧版服务端时即可完整呈现桌面端最新 UI（如磨砂气泡、扇形牌组等），而当服务端版本高于桌面端时自动透传加载服务端最新前端（DESIGN §137）。

- [x] **内置暂存与 ASAR 验证打包**：新增 `pc/scripts/stage-web-bundle.js`，将 `VITE_CHISABOT_BUILD_ID="pc-<ver>"` 产物暂存进 `pc/src/web-bundle/`（排除 `node-agent/` 与 `*.map`，`.gitignore` 与 `biome.json` 忽略），在 `release.yml` 的 Windows `pc` 与 macOS `pc-mac` 流水线中随包打入 `resources/app.asar` 并以 `--verify-asar` 解析 Pickle 目录树校验完整性；`shell-fingerprint.js` 纳入前端共享源码同时保持 Windows 外壳指纹 `7314f9105596bec5` 不变。
- [x] **同源协议拦截与版本高者优先**：`pc/src/local-web.js` + `pc/src/main.js` 在保持主窗口真实服务器 `origin` 与 `persist:chisabot` Cookie 的前提下，仅本地接管同源 SPA 页面与 `/assets/*`；`/api`、`/auth`、`/login`、`/sign`、`/p`、`/downloads` 与写请求经 `net.request`（`redirect: "manual"`，剥离 Chromium 已解压编码头）透传服务端，保留 `302` `will-redirect`、`Set-Cookie` 与 SSE 流式响应，并通过 Electron 45 真实 E2E 验证服务端升级后自动切 `remote`。
- [x] **版本偏移感知与测试收口**：`shared/system-update.ts` 新增 `compareSemver` 让 `pc-<ver>` 仅在服务端严格更高时触发更新横幅；新增 `app/src/lib/version-skew.ts`，在 `AccountMenu` 展示双版本副标题与管理员升级服务端快捷入口，在 `app/src/lib/client.ts` 将本地超前时的裸 `404` 转为升级引导提示，并补齐 `pc/test/local-web.check.js`、`shared/system-update.test.ts` 与 `app/tests/pc-local-web-version.test.tsx`。

## CB-128

**多图附件与多卡片错落扇形牌组展示及生成式界面拆壳升级**

标签：`type: feat` · `area: chat` · `area: images` · `P1` · `status: done`（`v0.1.152`）

解决用户发送多张图片时仅错开 34px 过于紧凑且右对齐被裁切、以及 AI 使用 `Card > Carousel` 或同源 `/api/chat-files/...` 返回多图/多卡时被套进大玻璃框横向截断的问题（DESIGN §135）。

- [x] **多图扇形牌组与右对齐防裁切（`ImagePile`）**：实现 `imagePileGeometry(total)`（2 卡斜扇、3 卡居中品字、4+ 卡拱形 `+N`），`.rp-pile` 采用单格 CSS Grid + 旋转外接四向内边距，配合 `AttachmentTiles` 的 `w-full [container-type:inline-size]` 基准消除右对齐（`align="end"`）溢出与裁切；支持带 `caption` 与外链 `href` 的图注卡片及 `--rp-drop-unit` 窄屏竖向兜底。
- [x] **链接双卡 / 三卡斜向扇面统一（`LinkCardStack`）**：2 张链接卡主卡 `-2.5deg`、右卡 `+3.5deg` 且增大步距，`--lc-drop-unit: max(var(--lc-w), 196px)` 配合左/右槽竖向下沉 `0.32 / 0.4` 取代右卡标题 `padding-left` 缩进，1440px 与 390px 双视口零遮挡。
- [x] **生成式界面同源图片直引与无外框自动拆壳升级**：`shared/json-render/catalog.ts` 新增 `isSafeRenderImageSrc` 放行 `/api/chat-files/...` 与 `/api/channels/.../attachments/...`；`media-deck.ts` 与 `JsonRenderSurface` 将独立及嵌套的多图 / `2–3` 张链接容器直接渲染为 `ImagePile` / `LinkCardStack`；通过 `app/tests/image-pile-deck.test.tsx`、`shared/json-render/catalog.test.ts` 与实机 Edge 双视口截图校验。
- [x] **AI 气泡与全站磨砂玻璃一致性修复**：解除 `styles.css` 渲染预算对 `[data-slot="bubble-content"]` 与顶层 `.jr-card` 的 `--lg-blur: none` 封锁，仅保持 `.chat-bubble-bare` 裸代码容器透明无模糊；在 `perf-noblur.css` 与 `resize-pause.css` 对称补齐性能模式/减少透明度/拖拽缩放实色底退化（含 `--bubble-user-bg`），通过 `render-budget.test.ts`、`no-backdrop.test.ts`、`theme-glass-perf.test.tsx` 与实机 Edge `backdropFilter` 对比校验。

## CB-127

**任务中心四列看板与本地 Markdown（Autobahn / ROADMAP+BACKLOG）双向协同**

标签：`type: feat` · `area: agents` · `area: web` · `P1` · `status: done`（`v0.1.151`）

将 `autobahn` 的本地 Markdown 看板工作流与 ChisaBot 任务中心、右栏任务面板、本地智能体与服务端任务队列深度融合，并在派发任务完成后自动标为完成并回写摘要（DESIGN §134）。

- [x] **共享契约与零 `zod` 首屏隔离**：`shared/markdown-syntax.ts`、`shared/task-board-core.ts` 与 `shared/task-board.ts` 实现四列投影（`现在 / 接下来 / 以后 / 已交付`）、`board:v1:` `sourceRef` 编解码、围栏安全换行切片与标题/摘要降级，前端纯展示入口仅依赖 `task-board-core` 以防 `zod` 渗入 `shell` chunk。
- [x] **服务端双协议解析与 `admin` 安全写回**：`server/src/task-center/{markdown-board,board-discovery,markdown-board-parser,markdown-splice,file-lock}.ts` 与 `dialects/{autobahn,chisabot-docs}.ts` 兼容 `BACKLOG.md` + `autobahn.config.json` 及 `docs/ROADMAP.md` + `docs/BACKLOG.md`；`routes.ts` 对 `/roots` 与 `/boards*` 本机目录/看板写接口强制校验 `actor.role === "admin"`；采用 `resolveTaskSourcePath` / `allowedDocument` 沙箱、每路径互斥锁、临时文件回滚原子替换与 SHA-256 `baseRevision` `409` 乐观并发检查，并用 `markUntrusted` 包裹派发正文；`service.ts` / `runtime.ts` 在任务 `succeeded` 时经 `onSettled` 幂等标为完成并写入 `#### 交付摘要（ChisaBot 自动回写）`。
- [x] **前端双模看板与完整验收**：`task-board*.tsx`、`board-format.ts`、`use-board-mutations.ts`、`markdown-overlay-editor.tsx` 与 `tasks-rail-card.tsx` / `task-rail-detail-dialog.tsx` 提供个人四列看板（含 `原属：<泳道>`）、置顶备忘折叠、全大写柔化、规格胶囊、复选框实时落盘、CAS 重载/覆盖冲突处理、Companion `.md` 标签、1:1 覆盖层源码编辑器与「发到当前对话」；通过 `bun run check`、`task-center-markdown-board.test.ts`、`task-center-board.test.tsx`、Vite 分片构建、Edge 三视口实机 E2E、`tests/task-center/ui.mjs` 与 `verify:ui -- --self-test`。

#### 交付摘要（ChisaBot 自动回写）

- 实现个人任务四列投影看板与本机 Markdown（Autobahn 单文件 + ChisaBot `docs/ROADMAP.md` / `docs/BACKLOG.md` 双文件）双向协同。
- 本机授权目录与看板写接口限定 `admin` 权限，外部 Markdown 正文派发前经过 `markUntrusted` 边界隔离，任务成功后自动勾选完成并幂等追加摘要（自动降级冲突标题级别）。

## CB-126

**自定义壁纸按屏幕比例或自由框选裁剪与无损源图重裁**

标签：`type: feat` · `area: settings` · `P1` · `status: done`（`v0.1.149`）

在「设置 → 通用 → 外观」为本地上传/拖入的自定义壁纸提供比例裁剪弹窗与二次重裁能力（DESIGN §131）。

- [x] `app/src/lib/wallpaper-crop.ts`：提供 `当前屏幕 / 16:9 / 16:10 / 21:9 / 4:3 / 9:16 / 原图 / 自由` 8 档比例Presets，支持选区平移、八向拉伸、点选重定位、滚轮/`1×–4×` 缩放与像素区间转换。
- [x] `wallpaper-compress.ts` / `wallpaper-compress.worker.ts`：直接在 Worker 或离屏 Canvas 按原图选中像素裁剪并等比压缩；新增纯内存 `dataUrlToBlob`。
- [x] `wallpaper-store.ts` / `appearance.ts` / `appearance-preferences.tsx`：在 IndexedDB 持久化无损源图与上次选区比例，支持通过「裁剪区域」二次无损重裁，移除或恢复默认外观时自动清理；单测与交互回归全绿（`wallpaper-crop.test.tsx`）。

## CB-125

**主 Agent 绑定管理、置顶展示与新会话暂停草稿无损切换**

标签：`type: feat` · `area: agents` · `area: web` · `P1` · `status: done`（`v0.1.149`）

补齐主 Agent 的完整前后端校验、自愈、置顶交互与暂停会话恢复/切换引导，保障跨标签同步与草稿附件零丢失。

- [x] 服务端与共享校验：`shared/validators/primary-agent.ts`、`primary-agent-service.ts`、`primary-agent-routes.ts`、`clearMainBotIfMatches` CAS 清理、`POST /api/channels` 返回 `409 AGENT_PAUSED` 及 `user-preferences-routes.ts` 校验收口。
- [x] 前端与跨标签同步：`primaryAgentQueryOptions`、`BroadcastChannel` 跨标签缓存同步、`BotsPage` 置顶与操作菜单、`BotProfilePage` 异步切换按钮、`/channel/new` 徽标/切换器/暂停恢复与 `switchNewChannelRecipient` 草稿及暂存附件无损迁移。
- [x] 路由分块构建与测试：`BotsPage` / `BotChat` 去导出并抽离 `switchNewChannelRecipient` 至 `draft-channel.ts`，`chunk-guard` 双构建与 `primary-agent*.test.*` / `home-fallback-routing.test.tsx` 全绿。

## CB-124

**审查收尾：surface 依赖方向归位与 env / fetch / import 三道护栏**

标签：`type: chore` · `area: infra` · `P1` · `status: done`（`v0.1.149`）

分支：`chore/review-hygiene`。2026-11-14 全面审查后的修复批：行为不变，只收架构边界与护栏。

- [x] 依赖方向归位：`app/src/lib/chat/{bubbles,mermaid-lite}` → `shared/{chat-bubbles,mermaid-lite}`；`app/src/components/channels/chat-origin`（含测试）→ `shared/chat-origin`；egress 策略契约（类型 / `EGRESS_MODES` / 默认目的地 / `parseEgress*`）→ `shared/egress-policy.ts`，`agent-computer/src/egress.ts` 改为从 shared 导入并再导出；`server/src/computer/policy-network.ts` 改指 shared。
- [x] `server/tests/no-cross-surface-imports.test.ts`：跨 surface 相对 import 即挂；8 条「测试按真声明 pin 契约」按文件→specifier 白名单写原因，另有白名单过期检查。
- [x] `server/tests/no-raw-env.test.ts`：`server/src`（`config.ts` 之外）的新裸 `process.env.X` 即挂；15 个存量文件白名单写原因，另有白名单过期检查。
- [x] `no-raw-fetch.test.ts`：检测补 `win|window|globalThis|self.fetch(`；`lib/auth/login-redirect.ts` 进白名单。
- [x] `.gitignore`：HANDOFF.md / CLAUDE.md / GEMINI.md / `.cursor/` 防 `git add -A` 带进公开仓库。
- [x] `styles.css` §41① 措辞与 `universalAfterHas` 护栏一致（禁 `:has(…)` 后通配 `*`，不禁具体类后代）。
- [x] `bun run typecheck`（server / agent-computer / app）+ `lint` 0 error 0 warning；受影响用例全绿。
- [x] 顺手修 `server/src/personal-sources/service.test.ts` 两个存量失败：ICS 用例默认窗口跟 now 走（写死 `from`/`to`）；IMAP 演示域名撞 SSRF 拦截（改为断言内网域名被拒，即当前真实行为）。
- [x] PR、合并、CI。

## CB-123

**PC 客户端 macOS 版（dmg + 在线更新）**

标签：`type: feat` · `area: pc` · `P1` · `status: done`（#532 · `v0.1.148`）

分支：`feat/pc-macos`。`pc/` 的 Electron 外壳此前只出 Windows（NSIS + 免安装 zip）；本条目把同一套外壳（无边框主窗口 + 本机登录页 + 设备节点 + 在线更新）移植到 macOS。

- [x] 打包：`build/icon.icns`（`scripts/mac-icon.mjs` 从 `assets/icon.png` 生成）、`dmg` + `zip`（arm64 + x64）、`latest-mac.yml` 带 `chisabotShell` / `chisabotClient` 指纹；`npm run dist:mac` 本机验证产出四份安装包 + 清单。
- [x] 运行时：应用菜单（系统 role，⌘C/⌘V/⌘Q/⌘W 生效）、`activate` → 召回主窗口、关闭窗口常驻托盘 / Dock、开发态 Dock 图标、`titleBarStyle: hiddenInset` 原生红绿灯（网页侧 Windows 式按钮按 darwin 隐藏，顶栏左移让位，「小窗模式」按钮保留在右上）；`updater.js` darwin 支持（所有打包 `.app` 可更新，Squirrel.Mac 整包替换，`fullInstall` 标记不改变行为，验签后「稍后」由 before-quit 撑住退出直到 Squirrel 抓完包）。
- [x] `shell-fingerprint.js` 排除 `build.mac` / `build.dmg` / `build.mas`：加 mac 配置不改变 Windows 外壳指纹，现存 Windows 客户端不做无谓的「重新安装」。
- [x] `release.yml` 新增 `pc-mac`（macos-latest，generic / custom matrix）；`pc-sign` 给 `latest-mac.yml` 同样签 `chisabotSig`；`check-release-assets.mjs` 校验 mac 清单 / 资产并把 mac 资产挡在「没有 latest-mac.yml」之外。
- [x] darwin 更新单元测试（`test/update.check.js`）；本机构建 + 启动验证通过。
- [x] 实机验收（macOS arm64）：登录页 / 主窗口 / 应用菜单 / Dock / 托盘截图；dmg 装到 /Applications 启动正常；本地假更新源（自签证书 HTTPS + 测试 Ed25519 钥）端到端跑通 `latest-mac.yml` 验签 → 整包下载 → 「立即重启」触发 `quitAndInstall`；并实机确认 Squirrel 对 adhoc .app 永远拒装（requirement=cdhash）→ `updater.js` 按 `codesign -dv` 结果对未签名构建 `supported=false`。
- [ ] 后续（不在本条目）：Apple Developer 签名 + notarize（**mac 在线更新的前提**——Squirrel.Mac 要求证书签名）；「设备」页下载卡片列出 mac 资产。

## CB-122

**全页面 UI 审查整改：对齐、动态布局与弹窗可达性**

标签：`type: bug` · `area: web` · `P1` · `status: in-progress`（#535 已合并 · `v0.1.148`）

分支：`fix/ui-layout-stability`。完整审查记录16项：15项本机复现、1项原图光学观察；保留既有视觉体系与任务中心原位弹层。

- [x] 多条拒绝附件和连续文件名不推走编辑器，原因与关闭入口完整可达。
- [x] 提供方长名称、环境与探测路径不压缩图标或裁切操作；机器人文件卡不越界。
- [x] loading/state/mutation无feedback按钮宽度稳定；任务数量与服务状态不推移工作区。
- [x] 独立授权页、404可见；技能/Magpie小节标题不被操作挤成字符列。
- [x] 日历、邮箱、Webhook、导入技能和绑定手机弹窗短窗口底部可操作；新建任务二层遮罩清楚。
- [x] 常驻指令保存错误不挤压计数；个人资料/品牌草稿跨断点保留。
- [x] 当前字体/缩放检查光学对齐，禁止全站机械平移图标。
- [x] 本地门禁、相关回归与宽窄/深浅色实际渲染通过（#535 最终 CI 8/8 通过，含 Linux App tests 与 Jank harness）。
- [ ] 最终CI、串行部署、正常登录正式环境实机验收。

## CB-121

**模型等待由用户停止，不因长时间无输出自动结束**

标签：`type: bug` · `area: models` · `P1` · `status: in-progress`

- [x] 聊天不再施加默认首段输出期限；不因模型沉默自动换模型或结束回合。
- [x] DSH Host 的默认 HTTP 请求和流静默期限一并取消；显式调用方期限仍有效。
- [x] 本地真实 Host 验证静默 125 秒后正常返回、用户停止中止上游、明确错误及显式期限；OpenAI / Anthropic SDK 和 Node HTTP 静默期限回归通过，服务端类型检查通过。
- [x] 隔离 PostgreSQL 下的服务端集成 11 项及 Linux DSH 回归 57 项通过；前端构建和修改测试文件格式检查通过。
- [x] 完整快速门禁（server / agent-computer / app 类型检查及 lint）通过。
- [x] 增量 Biome 门禁通过，修改文件 error / warning 均为 0。
- [x] #533 最终 CI 与合并后主线 CI 全部通过；`6509519` 已串行部署，应用 / Host 健康及真实模型自检通过，数据存量与关键设置一致。
- [ ] 部署后从正式登录入口实机验收。

## CB-120

**任务中心统一原位弹出，不跳转当前页面**

标签：`type: bug` · `area: web` · `P1` · `status: in-progress`

- [x] 账号菜单、右栏栏头和全部「查看全部」入口共用外壳弹层，保留底下的聊天、设置或管理页面。
- [x] 分区、详情、关闭与重开不修改当前地址；旧 `/tasks?view=…&task=…` 深链接保留。
- [x] 宽屏、手机全屏、暗色与关闭交互通过本地前端隔离接口夹具验证（`tests/task-center/modal.mjs`）；覆盖原页节点不重挂、详情/分区不导航、嵌套新建焦点恢复、Esc/关闭/桌面遮罩关闭及旧深链接。
- [ ] 部署后按正式登录入口实机验收。

## CB-119

**数据库普通查询与事务隔离、CI 收尾**

标签：`type: bug` · `area: infra` · `P1` · `status: done`（#530）

分支：`chore/ci-query-isolation`。Bun 1.3.14 的池在兑现排队事务的连接保留请求后，可能仍将该连接派给普通查询；已返回成功的普通写入会随其他事务回滚。数据库适配层为普通查询显式保留连接，完成后释放，不重试写入。

- [x] 本地 PostgreSQL 集成测试：原 Bot 工厂并发场景得到 20 次成功、10 次拒绝及 10 条持久化拒绝审计；锁等待超时仍有拒绝审计。
- [x] 本地单连接回归确认普通写入不会进入其他事务，也不会被它回滚；延迟执行、结果模式、取消、SQL 文件执行与恢复的定向测试通过。
- [x] 手机抽屉测试保留原导航与收起抽屉的断言，不依赖 JSX 换行。
- [x] 壁纸薄幕样式同值不写，变值仍立即生效；外观 DOM 测试与真实 Chrome DOM 操作通过。
- [x] Changelog 测试允许新增条目，但仍检查玻璃说明相邻且列表连续；截图清理的大批量夹具一次写入，保留 205 / 400 行和并发清理断言。
- [x] DSH 容量夹具使用 2 秒执行预算、强制排队 3 秒；14 文件共 52 pass / 0 fail，保留真实本地 Host 的恢复与副作用断言。临时取消排队时暂停预算的逻辑后，用例在约 2 秒被停止并失败，确认仍能捕捉原始计时缺陷。
- [x] 鉴权 HTTP 夹具支持 localhost 的 IPv4 / IPv6 解析；旧 IPv4-only 监听在 IPv6-only localhost 环境复现零请求，双栈夹具通过。新增 IPv6 的 picked / bundled 回归，并检查无 RUN_ERROR 且确实完成回合，保留大小写匹配与客户凭据隔离。
- [x] 完整迁移库与必要本地验证已补齐；最终 CI 作为 #530 合并门禁，结果见 PR。此前同一收尾目标已至少 8 次 CI 未通过，所有者已授权针对 HTTP 失败补齐诊断后恢复最终检查，不再推送试错。

## CB-118

**全面清理 早期上游模板 印记、退役过渡内核与废弃空表收尾**

标签：`type: chore` · `area: slim` · `area: infra` · `area: docs` · `P0` · `status: done`

分支：`chore/upstream-detachment-and-closure`。见[命名切换与存量资源兼容](ops/upstream-removal.md)与[数据模型](data-model.md)。

- [x] 数据库迁移 `0068`：原地将 `intelligence_channel_mappings` 重命名为 `chisabot_channel_mappings`，归一历史事件 JSONB 兼容键名，并清理移除已下线模块的废弃空表（同步完成 CB-016）。
- [x] 代码层彻底移除旧 `/api/conversations（原旧兼容路由）` 路由、`旧前缀请求头` 请求头、环境变量旧前缀垫片及已退役的 Hermes / Intelligence / Mastra 代码与依赖；保留 `deploy/pin-resources.sh` 与 `docker/s6/scripts/database-identity.sh` 守护存量物理卷与数据库身份零丢失。
- [x] 合规与脱敏收口：更新 `LICENSE` 双行版权声明、`docs/THIRD_PARTY_NOTICES.md`、`CODEOWNERS`、中文 `.env.example` 与 `docs/configuration.md`，删除上游遗留英文文档并消除本机用户名与私人公网域名泄露，同步更新 `ROADMAP.md`、`BACKLOG.md`、`HANDOFF.md`。

## CB-117

**聊天、任务与桌面操作连续性优化**

标签：`type: bug` · `type: perf` · `area: chat` · `area: agents` · `area: pc` · `P1` · `status: done`

完成：[PR #522](https://github.com/ChisaAlter/ChisaBot/pull/522)（合并提交 `a76570e8`），`v0.1.143` 已打标。详见[审查与迭代记录](pipeline-runs/20261111-smooth-experience.md)。

- [x] 引用、预填与失败恢复只作用于目标草稿；附件可跨重载恢复，用户焦点不被后台完成抢走。
- [x] 会话观察资源随真实页面消费者释放，不停止服务器任务；已有重连状态在当前界面可见。
- [x] 有序事件保留，合并中间全历史快照并保存准确覆盖水位；恢复与最终历史完整。
- [x] 已接纳的回答/确认不会因正常忙碌等待丢失；真实失败可见且可恢复；过期通知取消。
- [x] 活动任务与待审批可持续访问；个人上下文完整参与任务，记忆纠正和遗忘没有隐藏副本。
- [x] 巡检、定时保存、连接断开的结果与原位反馈一致；桌面端恢复当前页面且不重复导航。
- [x] 全部实现后完成定向测试、实际宽窄窗/暗色交互、持久性与性能验证，并通过两路独立审查、最终 CI 合入主线发布（外部真实凭据与真机终验保留在对应 `needs-user` 条目）。

## CB-116

**个人助理恢复、通知与发布接线收尾**

标签：`type: bug` · `area: agents` · `area: infra` · `P1` · `status: done`

[PR #520](https://github.com/ChisaAlter/ChisaBot/pull/520)、[PR #521](https://github.com/ChisaAlter/ChisaBot/pull/521) 已合并；0.1.142 服务器及正式客户端已发布。证据见[个人助理实施记录](pipeline-runs/20261108-assistant-production.md#当前状态)。

- [x] 只读失败正常返回，未知效果可按账号核对并继续，原操作不重放。
- [x] 修复跨 Bot 租约死锁及忙碌状态误清除，真实 Host/PG 路径通过。
- [x] 工作流与宿主状态通知、独立 SMTP、默认 DSH 配置接线与本地验证完成。
- [x] 生产更新签名和必跑 DSH 数据库恢复 CI 通过。
- [x] 合并、服务器和客户端更新源发布完成；Windows 安装端已记录新版下载成功。正式收件仍依赖实际通知目标（归 `needs-user` 条目）。

## CB-115

**DSH 主内核与自有会话运行层**

标签：`type: feat` · `area: agents` · `area: chat` · `P1` · `status: done`

完成：`v0.1.138`–`v0.1.139` 已正式上线，后续在 `0067`/`0068` 完成自有命名空间收口。设计与阶段合同见 [DSH 完整迁移方案](dsh-kernel-migration.md)，验收证据见 [运行记录](pipeline-runs/20261107-dsh-migration.md)。

- [x] 固定版本无 UI Host、真实工具/审批、流式、单会话停止、恢复及自动备用模型通过。
- [x] 统一命令、线程绑定、运行、操作账本和展示事件，前端及所有后台入口迁移。
- [x] 旧历史/附件/暂停队列/审批完整保留，Android 同源手机布局与外部 AG-UI 兼容。
- [x] 上游运行时依赖退出，正式构建、切换与回滚守卫完成验收（外部真实账号连接与真机终验留在 `CB-017` / `CB-034`）。

## CB-114

**聊天模型回退错误归属、流式气泡与留白**

标签：`type: bug` · `area: chat` · `area: models` · `P0` · `status: done`

完成：已随 `v0.1.138` 及 DSH 主内核合并上线（过渡 Hermes 适配器已退役，统一由 DSH 路由与前端会话层承载）。

- [x] 当前目录排除失效备用项，无可用备用时主模型不再被切换期限提前取消；错误区分备用模型和工具结果未知。
- [x] 流式正文保持气泡，普通 Markdown 不自动变成文档，代码中的指令不被改写。
- [x] 结束、失败、连续发送和同步时无残留留白或突然滚动；完成桌面/窄屏渲染与七项滚动回归。
- [x] 随正式 DSH 服务端与客户端发布上线（真实外部凭据场景持续归 `needs-user` 条目验证）。

实现与回归入口：[聊天可靠性](chat-reliability.md)、[模型](models.md)。

## CB-089

**Word（.docx）文件在线预览**

里程碑：Hark parity · 标签：`type: feat` `area: chat` `P0` `status: done`

背景：机器人用 python-docx 生成 Word（`shared/bot-prompt.ts`），文件卡只能下载；PDF / 图片 / 文本早就能在弹窗里看（`rich-previews.tsx`）。Hark 点 .docx 进全屏纸张预览，Grok Bot 在文件卡下平铺页面缩略图。

- [x] 本站 .docx 文件卡可以点开预览（前端按需加载渲染库，不进首屏包）；超过 10 MB 或解析失败时写「无法预览，下载查看」并给下载按钮。
- [x] 弹窗沿用 PDF 预览的外壳（下载、Esc / 遮罩关闭、关闭动画不重算毛玻璃 §37）。
- [x] 首屏 JS 体积不增加（构建产物对比）。
- [x] 测试：识别规则、失败回退、非同源不预览。

不做：服务器端 docx → PDF（LibreOffice 让镜像大几百 MB，和 1–1.5 GB 运行内存冲突）；不承诺真实分页。

## CB-090

**对话里的选项卡片：选完就定、不能重复点**

里程碑：Hark parity · 标签：`type: feat` `area: chat` `P0` `status: done`

背景：render_ui 的 `Button` 已经能 `ask`（替用户发一句话），但点完以后其他选项还亮着，能再点、重复发送，刷新后也看不出选了哪个。Grok Bot 的选择题卡片选完就折叠其余选项。

- [x] `Button` 新增 `choice`（互斥选项）：同一张界面里带 `choice` 的按钮只能选一个；点了以后它标为已选，其余禁用；连点 / 双击只发一条。
- [x] 不带 `choice` 的 `ask`（新闻「展开讲讲」这类可以问多次的）行为不变；右栏面板不受影响。
- [x] 刷新 / 换设备后仍显示选过哪一个（从这张界面之后的用户消息推出来，不新建表）。
- [x] 提示词引导：给 2–5 个互斥选项时用 `Button` + `ask` + `choice`，不要写「回复 1/2/3」。选项不替代确认卡片（付款 / 对外发消息 / 删除仍走 §58）。
- [x] 测试：选择、恢复已选、重复点击被拦、非 choice 不受影响。

## CB-091

**主机器人不能直接删除；菜单里可以更换主机器人**

里程碑：成熟度 Maturity · 标签：`type: bug` `area: agents` `P1` `status: done`

背景：主机器人是「打开就面对的那一个」（§19），但左栏菜单、资料页、聊天旁的资料卡都能一键删掉它（连同会话、记忆、定时任务、面板，§44）。Grok Bot 的主 Bot 没有删除，只有「替换为其他 Bot」。

- [x] 主机器人的左栏菜单（展开 / 收起两种）没有「删除机器人…」，有「更换主机器人…」（左栏只有它一个时不显示「更换」）。
- [x] 任何入口打开删除弹窗时，如果它是主机器人，先显示拦截页：「更换主机器人… / 取消主机器人」；换掉之后同一个弹窗接着走删除。
- [x] 更换后星标、排序立即更新（偏好已经跨设备同步）。
- [x] 测试：候选列表规则、菜单项显示条件。

## CB-092

**机器人资料页加「文件与页面」**

里程碑：成熟度 Maturity · 标签：`type: feat` `area: agents` `P1` `status: done`

背景：找「三天前它做的那个文件」只能往上翻对话。数据已经按机器人存好（`chat_files.agent_id`、`pages.agent_id`，`GET /api/chat-files?agentId=` 已能筛选）。Grok Bot 的「资料库」按今天 / 本周 / 更早归集。

- [x] `/bots/:id` 加「文件与页面」分区，按今天 / 本周 / 更早分组，点开走现有预览（图片灯箱 / PDF / CB-089 的 docx / 页面）。
- [x] 一个都没有时整个分区不出现（§47）；超过 30 条可「加载更多」（文件列表接口加游标）。
- [x] 删除机器人后列表随之消失（§44）。
- [x] 接口分页与分桶单测。

不做（这一期）：从对话正文里提取文档卡（```doc）。

## CB-093

**机器人之间的往来视图（单聊里 @另一个机器人）**

里程碑：Hark parity · 标签：`type: feat` `area: chat` `area: agents` `P1` `status: done`

背景：服务端已有 Bot ⇄ Bot 交接（`server/src/agents/handoff.ts` 与 `server/src/channels/group.ts`），主对话流里 `message_bot` 以前只走隐藏的 `ToolLine`。

- [x] 主对话流新增 `BotExchangeCard` 往来锚点卡：折叠显示「与『B』往来」及状态徽标，展开显示任务、约束、期望输出与跳转入口；到达深度上限或对方已删除时在锚点注明「已达上限 / 对方已删除」。

## CB-094

**有面板以后也能从右栏快速新建**

里程碑：成熟度 Maturity · 标签：`type: feat` `area: web` `P2` `status: done`

背景：右栏只有在没有面板时显示 3 个预设（`panel-rail.tsx`），建了第一张就没有入口了。

- [x] 栏头加「＋」：浮层列预设，`↺` 换一批；点一项只填进输入框、不发送（同 `chisabot-prefill`）。
- [x] 窄窗口抽屉同样可用；键盘可操作。

不做：Hark 那种对话流模糊 + 输入框变形（整列模糊会逐帧重算毛玻璃，§37 / §41）。

## CB-095

**账号连接页分标签（全部 / 连接 / 登录信息 / 密钥）**

里程碑：成熟度 Maturity · 标签：`type: feat` `area: settings` `area: vault` `P2` `status: done`

- [x] `/settings/connected-accounts` 顶部分段控件，`?tab=` 记住；「密钥」渲染现有 vault 内容，`/settings/vault` 保持兼容。
- [x] 保险箱说明写「服务器加密保存，机器人看不到明文」，不写「零知识」（服务器持有 `KEY_ENCRYPTION_KEY`）。
- [x] 设置搜索「密钥」「登录」可直达；补测试。

不做：预置淘宝 / 京东 / 12306 等站点登录（反自动化重、封号风险）。

## CB-088

**面板级模型（dsh-pad 的「面板模型」）**

里程碑：成熟度 Maturity · 标签：`type: feat` `area: web` `area: models` `P2` `status: planned`

- [ ] 给 `TurnRunner` 加可选的模型覆盖，`governedTurnRunner` 按它解析连接，审计里记下用的是哪个模型。
- [ ] `live_panels` 加 `model` 列；卡片 ⋯ 菜单列出可用模型（与输入框的模型选择同一份目录），改完下一轮刷新生效。
- [ ] 无头回合里模型不可用（被删、没有凭据）时退回全局默认，并在卡片上写一句原因。
- [ ] 回归：面板刷新用指定模型、失败退回、菜单切换持久化。

背景：DESIGN.md §109.4；dsh-pad 的面板可以单独选模型，ChisaBot 现在只能跟随机器人 / 全局默认。

## CB-087

**聊天可靠性全面修复：滚动、队列恢复、请求与编码**

里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `area: computer` `P1` `status: done`

- [x] 修复长对话发送与结束时节点替换、滚动跳动，七项严格回归通过。
- [x] Stop/失败后补话跨刷新、重启和另一页面保留暂停，用户主动操作才恢复。
- [x] 以可复现用例修复已证实的读取超时和生成代码编码兼容问题。
- [x] 保持原有一次执行与命令取消回归，通过完整相关检查并发布、Web 复测。

PR #283 / #284 / #285 已发布，最终运行提交 `8a94383048c8c331fb7e7aa4db7127af510fbac1`。隔离预览 `3299` 已拆除。计数、失败纠正历史与模型内容核验边界见 [完整发布验收](pipeline-runs/20261021-comprehensive-reliability.md)。

## CB-086

**连续补话不重复执行；停止按钮终止当次计算机命令**

里程碑：成熟度 Maturity · 标签：`type: bug` `area: chat` `area: computer` `P1` `status: done`

- [x] 前端工具待返回时保留完整任务边界，补话排队且同一任务只执行一次。
- [x] 停止信号经过计算机审批入口传到实际进程组，停止后不再写入延迟副作用。
- [x] 回归测试、隔离 Web 执行控制与正式 Web 连续办公、代码、补话、停止和恢复测试通过。
- [x] 发布修复，核对 Web 资源与服务提交并保留实测证据。

完成：PR #278，合并提交 `e36fb3e2`，已上线并完成 12 条真实模型连续消息验收。基线滚动检查保留同类失败，详情见[发布验收](pipeline-runs/20261020-web-execution-control.md)。

## CB-085

**搜索旁新建机器人；弹出面板与常驻面板一致**

里程碑：成熟度 Maturity · 标签：`type: bug` `area: web` `P1` `status: done`

- [x] 左栏去掉独立「机器人」标题行，搜索框右侧保留新建按钮。
- [x] 弹出与常驻共用卡片底色、圆角、边框、间距和记住的内容宽度；窄屏不溢出。
- [x] 面板 / 计算机切换、收起按钮、Esc 和遮罩关闭行为通过浏览器验证。
- [x] 发布服务器网页，并确认桌面端加载新资源。PR #269，合并提交 `a24c5885`；部署与已安装 PC 的验证见 [发布验收](pipeline-runs/20261020-sidebar-panel-parity.md)。

说明：[侧栏与弹出面板一致性](sidebar-panel-parity.md)。

## CB-001

**审批卡片与审批偏好（Hark parity 第 5 项）**  
里程碑：Hark parity · 标签：`type: feat` `area: approvals` `area: chat` `P1` `status: done`

#### 背景

机器人做需要确认的事（花钱、发消息、写操作、设备上的危险能力）时，在聊天里出审批卡片；用户可以设「这类事不用问我 / 一律先问我」的偏好，机器人照着做。上游 server/src/approvals/（policy.ts allow/pre_approved/ask/hand_off）是起点。

#### 验收标准

- [x] 聊天里出审批卡片：允许 / 拒绝，服务器原子地 pending→running，第二台设备 / 第二次点击不会重复执行
- [x] 设置里能看到、改、删审批偏好；机器人每轮读到偏好并遵守
- [x] 设备「询问」能力、GitHub 写操作沿用同一套卡片（或明确说明为什么不合并）
- [x] 单测 + 预览 e2e + 生产一次性机器人 e2e 通过；聊天滚动回归 7/7
- [x] DESIGN.md 新章节 + CHANGELOG Unreleased（DESIGN.md §58 与 CHANGELOG 已补齐；审批说明合并于 DESIGN.md 与 docs/features.md，未另立独立 docs/approvals.md）

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

- [x] 设置里能分别选生图模型、识图模型；管理员设部署默认，用户可覆盖，清空覆盖回到默认
- [x] image_generate / image_edit 和读图走所选模型；没配置时机器人如实说明去哪里配
- [x] 密钥不进模型、不进日志（复用 §52 / 模型密钥）
- [x] 测试 + 生产 e2e；DESIGN.md 章节、docs/chat-files.md 更新、CHANGELOG

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
- [x] 每个问题变成一个条目（GitHub Issues 未开启前以 BACKLOG `CB-040…CB-046`、`CB-051…CB-058` 建档），能当场修的随 PR 修掉并关闭
- [x] 宽 1280 / 窄 420 / 暗色三种截图证据（第 1–3 轮 PR 与 DESIGN.md §60 / §63 / §71 已留证）
- [x] 扫查结果汇总进 ROADMAP（已汇总并随各批完成归档至 ROADMAP「最近完成」）

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

除了 Windows 上的 ChisaBot 桌面客户端，用户的 Linux 服务器、Mac 也要能关联成设备，让机器人去操作。

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
- [x] 文档：docs/local-agents.md（含 ChisaBot 服务器 agent 与 Claude Code / Codex 的对比）、ADR-0010、DESIGN.md §66

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

- [x] 上述模块不再加载，表与数据不动（回滚镜像即可恢复）
- [x] server 测试、tsc、预览 e2e、生产自检通过
- [x] docs/slimming.md 记录每个模块的处理与依赖

> 完成：P4b-1 #117、P4b-2 #121、P4b-3 #123、P6-1 #131（企业闸门）、P6-2 #132（SSO / SCIM）、P6-3 #134（worker/ 与依赖）、P6-4 #135（上游桌面端残留）、删语音 #137（2026-10-15）。表与数据未动。还剩的重复系统合并（定时任务 ↔ routines 等）归 CB-015（P4c），删空表归 CB-016（P5）。

## CB-012

**项目维护与文档系统（labels / milestones / ROADMAP / ADR / 模板）**  
里程碑：成熟度 Maturity · 标签：`type: docs` `area: docs` `P1` `status: done（Issues 待仓库所有者打开）`

#### 背景

用户 2026-10-15：「我们最近需求比较多比较杂，你要建立良好的项目维护系统和文档系统。」

#### 验收标准

- [ ] 标签、里程碑、在做 / 推迟 / 已知问题都有 issue，带验收标准
- [x] docs/README.md 索引、docs/ROADMAP.md、docs/architecture.md、docs/ops/deploy.md、docs/adr/、docs/dev/parallel-work.md
- [x] CONTRIBUTING.md、PR 模板、issue 模板（bug / feature）
- [x] DESIGN.md 顶部章节索引；CHANGELOG Unreleased 补齐 §49–§57

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
里程碑：Hark parity · 标签：`type: feat` `area: schedules` `P2` `status: done`（随个人助理晨报上线）

#### 背景

PARALLEL.md 里的可选第 9 项：每天固定时间机器人把天气、日程、待办、关注的信息汇成一条简报。可以建立在 §55 定时任务之上。

#### 验收标准

- [x] 用户在聊天里说一句就能设、改时间、停（已结合定时任务与 `morning_brief_generate` 工具落地，见 `server/src/personal-sources/service.ts`）
- [x] 内容来源可配置，空的部分不显示（设置 → 账号连接「日程、收件箱、通知推送与每日晨报」，详见 [personal-assistant.md](personal-assistant.md)）
- [x] 推送到网页通知 / IM（已接入个人通知账本与定时投递，`v0.1.140`–`v0.1.142` / `CB-116`；真实外部通知目标终验归 [CB-034](#cb-034)）

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

**瘦身 P5：DROP 上游与已下线模块废弃空表（迁移 0068）**  
里程碑：精简 Slim · 标签：`type: chore` `area: slim` `area: infra` `P2` `status: done`

#### 背景

显式迁移清理所有确认无现役消费者且已下线的废弃空表（包括云端 Claude Code `chisabot_cloud_workspaces` / `chisabot_cc_*`、`chisabot_legacy_imports`、`team_bot_*`、`proactive_*`、`demonstrations`、`organization_settings`、`memory_sources` 等）。不可逆变更配合更新器 `conversationReader`（reader 4）守卫与切换前完整 `pg_dump` 备份机制执行。

#### 验收标准

- [x] 核对全仓无现役消费者并在迁移 `0068` 中统一清理移除废弃空表
- [x] 更新器切换前自动执行全库 `pg_dump` 备份，并通过 reader 4 版本守卫拦截不兼容旧镜像回滚
- [x] 满足 P4b 与 CB-099 下线稳定窗口要求（2026-11-11 完成，详见 [data-model.md](data-model.md)）

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

**旧内部 0.2.x 开发客户端手动覆盖重装为正式 0.1.x（当前 v0.1.183）**  
里程碑：0.2.0 release · 标签：`type: chore` `area: pc` `P1` `status: needs-user`

#### 背景

版本号归正为 `0.1.x`（当前已推进至 `v0.1.183`）之后，若某台电脑仍残留早期内部 `0.2.x` 测试构建，因语义化版本比较不会自动降级更新到 `0.1.x`（PC 端已有「需要重新安装」提示，§45）；已重装正式签名 `0.1.x` 的客户端（如 `0.1.142+`）均正常走自动在线更新。

#### 验收标准

- [ ] 仍装有早期内部 `0.2.x` 测试构建的电脑手动卸载并安装最新正式签名 `0.1.x`（当前 `0.1.183`）
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

- docs/release.md、docs/ops/deploy.md

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

- [x] 长对话（>200 条）首屏只挂尾窗再分批补（`tail-first-paint` / `useTailFirstMount`；单元 + 挂载回归，并在 `v0.1.181` 补充服务端 `?tail=120` 尾片优先首读）
- [x] §35 不跳版的回归全部通过（`tests/chat-scroll/regression.sh` 已于 [CB-087](#cb-087) 七项严格回归通过）
- [ ] 生产 4× CPU 首屏 < 1500ms 实机数字（狗粮 / FRA；暂以挂载有界断言代替，待补实机采样）

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
里程碑：成熟度 Maturity · 标签：`type: bug` `area: im` `area: schedules` `P2` · `status: done`（Wave 5 · DESIGN §136）

#### 背景

从 IM 设的定时任务到点后把回复推回 IM 会话。QQ 官方机器人、企业微信只允许在用户消息后的一段时间内被动回复，超出窗口推送会失败。

#### 验收标准

- [x] 推送失败时在网页通知和定时任务记录里写明原因
- [x] 支持主动消息的平台走主动接口
- [x] docs/im.md 写清各平台限制

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
- [ ] docs/release.md 更新

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
- [x] 每人每日消息 / token 上限（已拆出并由 [CB-045](#cb-045) 于 `v0.1.153` / 迁移 `0069` 落地）

> **历史与现行说明**：2026-10-15 一度先隐藏界面入口；自 2026-10-21 起 `CHISABOT_ACCOUNTS_UI` 默认已开启（仅需隐藏时设为 `0` / `false`），登录网关 `config.json` 的 `invites` 仍默认关闭，需显式配置 `"invites": true` 后才允许邀请新账号（详见 [docs/accounts.md](accounts.md)）。

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

#### 方案（2026-10-15 成熟度扫查记下；已按此实现，见 DESIGN.md §67——截断接口挂在 `/api/conversations（原旧兼容路由）/threads/<id>/truncate`，版本号用 `chisabot_thread_truncations` 行数）

- 服务器：`POST /api/bot-threads/:agentId/truncate {threadId, fromMessageId}`——只允许截最后一条用户消息那一轮、且对话没在跑；`chisabot_local_threads（原早期线程表）.messages` 截到这条之前，`chisabot_local_events（原早期事件表）` 删掉从第一个提到这条用户消息的事件（它那一轮的 RUN_STARTED）起的全部事件，写审计。重新生成 = 截掉最后一条用户消息再原样重发（换新 id，这样新一轮的 RUN_STARTED 带上它，回放里才看得到）；编辑 = 截掉后发新内容。
- 别的设备：截断后事件序号会变小再变大，单靠 `seq` 不可靠——同步戳里加一个对话版本（截断时 +1，如 `chisabot_local_threads（原早期线程表）.updated_at` 或新列），版本变了就 `join("rebuild")`。
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
里程碑：成熟度 Maturity · 标签：`type: feat` `area: models` `P2` · `status: done`（Wave 1 · DESIGN §136 · 迁移 `0069`）

#### 背景

多用户（CB-040）之后，朋友共用管理员的模型额度，没有任何按人的用量统计或上限。

#### 验收标准

- [x] 按人统计每日 token / 次数；管理员可给每人设日上限，超了在聊天里说人话

## CB-046

**两套聊天实现收成一套**  
里程碑：成熟度 Maturity · 标签：`type: chore` `area: chat` `P1`

#### 背景

机器人聊天有两条路：`/channel/*`（ChannelChat，左栏、用户日常用）和 `/bot?agent=`（旧内置聊天组件，只有定时任务提醒的「查看」会进）。§42 跨设备同步、历史对话、刷新续写、各功能 e2e 都在 `/bot` 上；用户日常用的是频道聊天。功能、测试和修复都在分叉。

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
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: infra` `P1` `status: dropped（已随 CB-099 下线）`

> 云端 Claude Code 模块已于 2026-10-26（CB-099）整体下线，相关空表已在迁移 `0068` 中清理移除；未执行的云端登录验收随之终止。

#### 背景

用户 2026-10-15：在 ChisaBot 云端集成 Claude Code（历史设计 `docs/cloud-claude-code.md`、ADR-0014）。

#### 验收标准

- [x] `deploy/cloud-node/`：非 root、cap_drop ALL、根文件系统只读、不挂 docker.sock、不用 host 网络、`--no-full-access`；防火墙丢弃到私有网段和主机
- [x] 设备列表里「云端工作区」在线；连其他容器 / 主机端口失败；开不了完全访问
- [x] 设置 → 云端工作区：用 Claude 订阅登录（授权页 → 粘授权码）、退出、重新检查；模拟 CLI 走完成功 / 出错 / 过期 / 取消 / 退出
- [x] 授权码和令牌不进数据库和日志（grep 检查）
- ~~真实登录由用户点一次~~（已随 CB-099 下线取消）

## CB-062

**云端 Claude Code P2：左栏切换、会话、对话、审批、右栏 / 手机抽屉**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: chat` `P1` `status: dropped（已随 CB-099 下线）`

#### 验收标准

- [x] 左栏切换「机器人｜Claude Code」（记住选择）；工作区 → 会话树，先只有内置「草稿」
- [x] 同一个会话两轮共享上下文（`--resume`）；「新 Claude 会话」清掉上下文；停止 1 秒内生效；回答中再发一条排队
- [x] `npm test` 出审批卡，允许后执行、拒绝后 Claude 换办法；「本会话总是允许」；`git push` 被拒并提示「推送并开 PR」
- [x] 刷新 / 换设备后接着看正在写的回答
- [x] 右栏「这一轮」diff + 只读文件，可收起；390 宽底部抽屉能拉起能收；亮 / 暗截图

## CB-063

**云端 Claude Code P3：GitHub 工作区**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: github` `P1` `status: dropped（已随 CB-099 下线）`

#### 验收标准

- [x] 新建 → 从 GitHub：按钮「克隆中… → 已创建 ✓」；节点磁盘上没有 GitHub 令牌
- [x] 每个会话一个 worktree + `cc/…` 分支；合入工作目录（冲突时不动 `work/`）；推送并开 PR 要审批，出 PR 链接卡
- [x] 右栏「相对 main」「工作目录」两个视图
- ~~用真实 GitHub 走一遍~~（已随 CB-099 下线取消）

实现见 DESIGN.md §73.7、历史文档 `docs/cloud-claude-code.md`。#151 曾于 2026-10-15 上线，后随 CB-099 整体下线。

## CB-064

**云端 Claude Code P4：电脑文件夹同步**  
里程碑：0.2.0 release · 标签：`type: feat` `area: pc` `area: agents` `P2` `status: dropped（已随 CB-099 下线）`

#### 验收标准

- [x] 自编译 MIT 版 Mutagen 0.18.1（不加 `mutagensspl`）：边车里的 agent 由 `deploy/cloud-node/sync/Dockerfile` 源码编译；电脑端改用 PC 客户端里的 JS（`pc/src/sync/`）驱动 `mutagen.exe`，不移入 CCC 的 Go 助手（P4a，见历史文档 `docs/cloud-claude-code.md`）
- [x] 同步边车 sshd 只听 127.0.0.1:2222，主机没有新端口；隧道走网关 + 一次性票；撤销设备 / 强制收回 / 交还即断开、删公钥（P4a，Linux 替身 e2e）
- [x] PC 客户端（P4b）：「电脑上的文件夹」新建、同步面板、冲突对话框三选项、交接 ①–⑤、Git 走隧道；网页 / 手机状态药丸 + 强制收回；先只做 Windows；发 PC 新版（0.1.11）
- ~~在真实 Windows 上走一遍~~（已随 CB-099 下线取消）

P4a #159、P4b #160 曾于 2026-10-16 上线，后随 CB-099 下线。

## CB-066

**在云端完成 Claude 登录（远程浏览器）+ Claude 上游代理**  
里程碑：设备核心 Devices core · 标签：`type: feat` `area: agents` `area: infra` `P1` `status: dropped（已随 CB-099 下线）`

用户 2026-10-15 20:36 / 20:37：登录要整个在云端完成（你的浏览器不碰 claude.com），登录和 Claude Code 同一个出口；可以设自己的代理 / 静态住宅 IP。

#### 验收标准

- [x] 设置 → 云端工作区「在云端完成登录」：节点容器里的浏览器画面嵌在设置页，可以点、打字、粘贴；回调时自动拿授权码完成登录；粘贴流程保留为备用
- [x] 浏览器和 Claude Code 的出口 IP 显示出来并一致；密码 / 授权码不进日志和数据库；结束后关浏览器、删配置目录
- [x] 「Claude 上游代理」：http / https / socks5 + 用户名密码，测试连接（出口 IP、claude.ai、api.anthropic.com），清除回到默认出口；只有 Claude 域名走它；加密存储、界面打码
- [x] claude.ai 的 Cloudflare 人机验证：云端浏览器用普通 Chrome UA + 关 AutomationControlled（#158），生产上直接到 Claude 登录页
- ~~生产上用户自己完成一次真实登录~~（已随 CB-099 下线取消）

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
里程碑：设备核心 Devices core · 标签：`type: chore` `area: infra` `P2` `status: dropped（已随 CB-099 下线）`

#### 验收标准

- [x] 已于 2026-10-26（CB-099）决定整体下线云端 Claude Code，并在迁移 `0068` 中清理相关空表

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

## CB-096

**引导页标题和「继续」按钮被天空背景遮住**
里程碑：成熟度 Maturity · 标签：`type: bug` `area: web` `P2` `status: done`

用户 2026-11-01 截图：`/onboarding` 只看到光球和装饰输入框，看不到「欢迎来到 ChisaBot」和「继续」。固定天空背景 `#sky-root` 是 `position: fixed; z-index: 0`，引导页内容没有建立更高的层叠上下文，标题和按钮被盖在背景下面。

#### 验收标准

- [x] 引导页标题和「继续」按钮在亮 / 暗、桌面 / 窄屏下可见、可点击
- [x] 不改变主界面层级；`bun run typecheck` 通过
- [x] 前端构建通过

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
线上证据（FRA 网关日志 + `chisabot_local_runs（原早期运行表）` / `chisabot_local_events（原早期事件表）`）：3 天里 0 条 RUN_ERROR（模型 / 上游没出过错）；用户可见的两次断都不是模型——
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
