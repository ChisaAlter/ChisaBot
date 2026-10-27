# 术语表

界面和文档里的中文说法 ↔ 代码 / 上游的叫法。界面文字一律简体中文（[DESIGN.md](../DESIGN.md) §0）。

## 产品与界面

| 中文 | 英文 / 代码 | 说明 |
|---|---|---|
| 机器人 | bot、agent、coworker（上游「AI 同事」，已统一改为「机器人」） | 一个有名字、职责、提示词、模型的助手；在服务器上运行 |
| 主机器人 | primary bot | 左栏置顶的那个；每个新用户自动有一个私有「助手」 |
| 它做什么 | system prompt | 新建 / 编辑表单里的提示词，原样保存 |
| 职责 | role / responsibility（表单字段） | 一句话说明，显示在名字下面；不填时取「它做什么」第一句 |
| 频道聊天 | channel chat（`/channel/*`） | 唯一的聊天界面（ADR-0013）；旧 `/bot` 只做跳转 |
| 话题 · 新话题 · 历史对话 | thread | 一段对话；「新话题」开一段新的，所有设备跟着切 |
| 一轮 | turn / run | 用户一句 + 机器人这一次的全部回应 |
| 开场一句 | lead line | 一轮开头「我来查一下…」那句，结果出来后收起 |
| 干活卡 | work card | 「● 正在搜索… · 第 n 步 · 用时」，结束收成「✓ 搜索 2 次 · 12 秒」 |
| 中途说明 / 过程话 | narration | 两步之间机器人说的话；收进干活卡 |
| 短气泡 | bubbles | 一条回复按段拆成几个气泡 |
| 草稿卡 · 文档卡 · 代码卡 | draft / doc / code card | 要发出去的文字、长总结、代码各自的卡片 |
| 思考 | reasoning | 模型的推理，默认收起 |
| 链接卡 | link card | 单独一行的链接显示成卡片 |
| 富组件 · 生成式界面 | json-render、`render_ui` | 机器人画的卡片 / 图表（唯一的生成式界面） |
| 确认卡片 | confirm card（`confirm_action`） | 有后果的操作先在聊天里问 |
| 请求批准 · 完全访问 | permission mode `ask` / `full` | 输入框「+」后面的每个机器人权限开关（§97） |
| 先问我 · 直接做 | ask / auto | 审批偏好四类的取值 |
| 待处理 | pending（`/approvals`） | 只列等用户点头的事 |
| 回答中发消息 · 排队 · 已读取 | inbox | 机器人回答时继续发的消息 |
| 后台任务 · 任务卡 | worker（`delegate_task`） | 机器人交给后台跑的活 |
| 重新生成 · 编辑后重发 | regenerate / truncate | 服务器截断对话后重答 |
| 上下文读数 / 小饼图 | context meter | 当前对话用了模型上下文窗口的多少 |
| 备用模型 | model fallbacks | 主模型额度用完 / 出错时依次换用 |
| 生图 · 识图 | image generation / vision | 画图模型、看图模型 |
| 面板 | live panel | 右栏的实时小看板，定时刷新 |
| 计算机 · 云端浏览器 | computer、agent-computer | 机器人的浏览器 + 工作区；右栏「计算机」标签 |
| 接管 · 交还 | takeover / hand back | 用户亲自操作机器人的浏览器，再还给它 |
| 收藏夹 · 标签 | bookmarks / tabs | 云端浏览器的（§95） |
| 工作区 | workspace（`/workspace`、`https://workspace.local/`） | 机器人的文件目录 |
| 页面 | page（`/p/<slug>/`） | 机器人做的可分享单页网页 |
| 记忆 | memory notes | 长期记忆（不是上游 personal memory） |
| 技能 | skill | 「某类事怎么做」，按需加载 |
| 密钥 · 保险箱 | vault | 存 API 密钥 / 令牌，机器人能用、看不到 |
| 账号连接 | connected accounts | GitHub、保存的网站登录 |
| 定时任务 · 提醒 | schedule | 一次性或周期；上游 routines 已并入 |
| IM 接入 | IM connectors | QQ / 微信 / 飞书 / 企业微信 / 钉钉 / Telegram |
| 活动记录 | audit（上游「审计」） | 全部操作记录 |
| 自检 | admin smoke | 不碰对话的模型往返检查 |
| 系统更新 · 一键更新 · 完整更新 · 回滚 | updater | 宿主机更新器（快速 / 完整构建） |

## 设备

| 中文 | 英文 / 代码 | 说明 |
|---|---|---|
| 设备 · 设备节点 | device、node | 用户的电脑 / 服务器，主动用 WSS 连服务器；属于账号，不属于某个机器人 |
| 能力：关闭 / 询问 / 允许 | capability off / ask / allow | 每台设备每种能力（截图、文件、命令行、键鼠、打开…）的权限；新设备默认询问 |
| 允许的文件夹 | roots | 文件工具能碰的目录；之外的路径必问 |
| 完全访问 | full access（`devices.full_access_until`） | 每台设备 1h / 24h / 永久的总开关，只有主人能开（ADR-0009） |
| 急停 | kill switch | 立刻关掉设备的一切能力和完全访问 |
| 本机确认 | local confirm | PC 上弹出的二次确认 |
| 无界面节点 | headless node（`chisabot-node`） | Linux / macOS 服务器当设备 |
| 本地 agent | local agent（`device_agent_run`） | 设备上的 Claude Code / Codex / OpenCode / 内置循环 |
| 档位：只读 / 工作区 / 完全访问 | profile read-only / workspace / full | 本地 agent 的权限档位，只能收紧（ADR-0010） |
| 扫码绑定 | QR pairing | 手机扫一次性二维码登录（手机不是设备节点） |
| 小窗模式 | compact window | PC 手机形状的小窗（Ctrl+Shift+M） |
| 外壳指纹 · 重新安装 | shell fingerprint（`chisabotShell`） | PC 图标 / 安装器变化时要求完整重装 |

## 工程与流程

| 中文 | 说明 |
|---|---|
| 网关 · 登录服务 | 公网 nginx + `auth/server.ts`；手工部署，不随一键更新 |
| 签名身份 | 网关给应用的 `X-ChisaBot-Identity`（HMAC + 时间戳），多账号用 |
| 朋友账号 · 邀请链接 | 多用户（默认隐藏） |
| 快速更新 · 完整构建 · 底座镜像 | 只换代码层 / 整个镜像重建；完整构建成功后成为新底座 |
| 串行部署 | `deploy-serial.sh`：全局锁、等对话结束、再更新 |
| 预览容器 | 生产镜像 + 生产数据副本 + 出网封锁的测试实例 |
| 一次性机器人 · 临时会话 | 生产测试唯一允许的写入对象，跑完删除 |
| 只读检查 | 拦截所有非 GET 的生产浏览器检查 |
| 生产快照 | 上线前后对比的不变量（线程 / 机器人 / 设备 / 用户数、设置哈希） |
| 瘦身 P1–P6 | 去掉上游企业功能的阶段（先入口、后代码、最后数据） |
| Hark 对齐（parity） | 把 Hark 的能力和体验搬过来 |
| 成熟度扫查 | 以「新朋友第一次用」的视角找问题 |
| 隐藏（extras） | `CHISABOT_EXTRAS` 默认关、可恢复的功能 |
| 条目 CB-0xx | [BACKLOG](BACKLOG.md) 里一条带验收标准的需求 |
| DESIGN § | [DESIGN.md](../DESIGN.md) 的章节号；新章节取 main 上下一个空号 |
