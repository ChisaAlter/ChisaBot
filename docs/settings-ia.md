# 设置的信息结构（DESIGN.md §97）

2026-10-16 重新整合前后的全部设置项。导航和设置搜索都来自 `app/src/lib/settings/registry.ts`（一张登记表），
改分组 / 加页 / 加可搜索的项只改那里。**路由一个都没改**，旧地址照常能打开；早就存在的旧重定向（下表最后一节）照旧。

## 1. 整合前的清单（main b6d2dbd）

左栏分三组（`components/settings/settings-sidebar.tsx`）：

| 旧组 | 页 | 路由 | 页里的块 |
|---|---|---|---|
| 个人 | 通用 | /settings | 外观（主题、背景随时间变化）· 常驻指令 · 键盘快捷键 |
| 个人 | 记忆 | /settings/memory | 记忆列表（按种类筛选）· 哪些机器人用记忆 |
| 个人 | 技能 | /settings/skills | 技能列表（管理员页内进共享技能管理 /admin/skills） |
| 个人 | 定时任务 | /settings/schedules | 任务列表 |
| 个人 | 页面 | /settings/pages | 页面列表（复制链接、下线、删除） |
| 个人 | 账号连接 | /settings/connected-accounts (+ /$key) | GitHub、应用连接、保存的登录 |
| 个人 | 生图与识图 | /settings/media | 生图模型 · 识图模型（自己的） |
| 个人 | 密钥 | /settings/vault | 保险箱条目 |
| 个人 | 审批偏好 | /settings/approvals | 哪些事先问我 · 你的规则 · 最近的确认 |
| 个人 | 设备 | /settings/devices (+ /$deviceId) | 待审批 · 设备列表 · 添加手机 / 电脑 / 服务器；详情页：能力、文件夹、完全访问、审计 |
| 个人 | IM 接入 | /settings/im | 我的连接 |
| 管理 | 账号（默认隐藏，CHISABOT_ACCOUNTS_UI） | /admin/accounts | 邀请、停用、重置密码 |
| 管理 | 模型 | /admin/models | 聊天模型 · 备用模型 · 生图模型 · 识图模型（部署） |
| 管理 | 云端浏览器 | /admin/computers | 此部署中的计算机 |
| 管理 | 权限规则（默认隐藏，extras） | /admin/boundaries | 命中规则时 · 永远不允许 · 其余允许 |
| 管理 | 系统更新 | /admin/system-update | 版本 · 可用更新 · 回滚 · 历史 · 自检 · 调试 |
| 管理 | 活动记录 | /admin/audit | 全部操作记录 |
| 高级（默认隐藏） | 工作流 | /workflows | |
| 高级（默认隐藏） | 插件与 MCP | /admin/plugins | |

不在左栏、但存在的页：/admin/skills（共享技能管理，从 技能 页进）、/admin/credentials（模型密钥，从模型页进）、/admin/magpie（模型平台）、
/admin/components（UI 组件库）、/approvals（账号菜单 → 待处理）。

问题：「个人」一组 11 项、顺序没有逻辑（密钥夹在生图和审批中间；设备和云端工作区 / 云端浏览器分在两组）；「管理」混着模型、电脑、系统；
「审批偏好」和设备详情里的「完全访问」是两处管权限；没有搜索。

## 2. 新的分组（按常用程度排）

| 组 | 页（组内顺序） | 谁看得到 |
|---|---|---|
| （无标题） | 通用 | 所有人 |
| 机器人 | 权限与审批 · 记忆 · 技能 · 定时任务 · 页面 | 所有人 |
| 电脑与设备 | 设备 · 云端浏览器 | 设备所有人；云端浏览器管理员 |
| 账号与连接 | 账号连接 · 密钥 · IM 接入 · 账号 | 所有人；「账号」管理员 + CHISABOT_ACCOUNTS_UI |
| 模型 | 模型 · 我的生图与识图 | 「模型」管理员 |
| 系统 | 系统更新 · 活动记录 · 权限规则 | 管理员；「权限规则」extras |
| 高级 | 工作流 · 插件与 MCP | 管理员 + extras（默认整组不显示） |

- 合并：「审批偏好」改名「权限与审批」，顶部加「每个机器人的权限」（和聊天输入框的「请求批准 / 完全访问」是同一个值），底部「请求批准和完全访问是什么」（输入框「了解更多」落点 `#about`）。
- 「生图与识图」改名「我的生图与识图」，和管理员的「模型」（部署级）放同一组，不再像两个重复的入口。
- 管理员看到的组多：桌面左栏里除第一项外每组可折叠，没记过开关时只展开当前页所在的组（无当前组时展开「机器人」）；手机抽屉全列。
- 每页的说明（左栏第二行）统一成「名词、名词」或一句话，不带句号。

## 3. 设置搜索

- 左栏标题下的搜索框；**Ctrl/⌘ K** 或 **/** 聚焦（在设置里 Ctrl K 是搜设置，不是顶栏搜会话）；↑↓ 选、Enter 跳、Esc 清空。
- 搜页（标题、说明、同义词）和页里登记的「项」（主题、常驻指令、备用模型、回滚、Claude 上游代理、完全访问……）；同义词含拼音首字母（mx = 模型）和英文（dark、api key）。多个词用空格分开，每个词都要中。
- 跳到项：地址带 `#find=<页.项>`，页面加载后按项的标题文字找到那一块，滚到中间、蓝色描边闪一下（减弱动画时不闪、直接描边）。
- 没结果：「没有找到「…」相关的设置」+ 换个说法的提示。

## 4. 旧地址（都还在）

整合没有改任何路由。原有重定向照旧：/settings/passwords → /settings/connected-accounts、/settings/components-gallery → /settings、
/admin → /settings、/admin/images → /admin/models#image-model、/admin/devices → /settings/devices、/admin/learning → /settings/skills、
/admin/enterprise | identity-providers | people | playground → /settings、/memory → /settings/memory、/routines | /responsibilities → /settings/schedules、
/reachability → /settings/im、/skills → /settings/skills、/team-bots → /bots。
