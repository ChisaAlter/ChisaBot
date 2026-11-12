# 信息源接入交接

2026-11-06，产品实现与定向验证已完成；接线与真实账号验证由 root 继续。

## Root 接线

`createTaskSourceCollectors({ database, personalSources, github, localRootsFor?, localConversationsAvailable })` 位于 `server/src/task-center/sources.ts`，返回 `collect(owner, source)` 与 `capabilities(owner)`，直接传给任务中心。`localRootsFor(owner)` 必须由部署/设备策略提供账号获准读取的本机目录；不提供时本地文件扫描拒绝，不能以请求中的 path 自授权限。`localConversationsAvailable` 对应实际 local runtime 模式。

`validateTaskSourceConfig(kind, config)` 可在来源创建/更新前校验；collect 本身也校验。扫描只产生风险为 read 的整理/分析/草稿任务；来源正文通过 `markUntrusted` 标记。所有数据库源按 owner 绑定。

| kind       | config                                               | 真实读取路径                                                                 |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| calendar   | `{days?:1..30,limit?:1..50}`                         | 新增 personalSources.scanCalendar 严格刷新                                   |
| email      | `{unreadOnly?:boolean,limit?:1..20}`                 | 新增 personalSources.scanEmails，拒绝 demo，IMAP EXAMINE + BODY.PEEK         |
| github     | `{repo:"owner/repo",limit?:1..50}`                   | 新增 github.listOpenItems，固定 GET API，复用 vault 令牌                     |
| repository | `{path:"完整路径",files?:["相对文件"],limit?:1..50}` | 允许根内 Markdown/TXT 未完成复选框/TODO                                      |
| documents  | `{mode?:"files"                                      | "pages",path?:"完整路径",files?:[],limit?:1..50}`                            | 有 path/files 模式读取文件；否则读取自己页面当前版本 |
| messages   | `{days?:1..90,threadIds?:[],limit?:1..50}`           | 本地模式自己的非归档会话：未回复用户消息，以及最近回复仍有未闭环线索的上下文 |
| tasks      | `{includeMemory?:boolean,limit?:1..50}`              | 失败/等待的已有定时任务与个人未闭环记忆                                      |
| webhook    | `{}`                                                 | 既有入站 Webhook 最新事件                                                    |

文件源规范化真实路径并检查符号链接边界；递归最多 2 层、100 文件，每文件最多 512 KiB。仓库源当前读取仓库内项目文档待办；GitHub 源读取打开的 Issue/PR。不会根据文件文字执行命令。

每次扫描先读取该账号该来源已有 sourceRef，再应用发现数量上限，避免前 20 条已知事项永久挡住后续待办。核心服务的数据库唯一索引仍是并发去重权威。调用 collect 前需已运行 taskCenter.ensure()。

## 当前边界与待接线点

- `messages` 必须排除任务中心执行会话，当前排除 `task-center:` / `tc_` 前缀及任务标记；root 的执行会话请采用一致前缀，或告知实际命名调整。
- 邮件沿用 20 封近期摘要窗口；稳定身份优先 IMAP UIDVALIDITY/UID，随后 Message-ID，不再依赖易变 seq。读取失败抛错，旧聊天列表保留缓存行为。
- 日历严格巡检不使用旧事件补空；当前 parser 不展开 RRULE（沿用既有日历能力）。
- Webhook 原模块只保存最新事件和个人日志，并非完整独立事件队列。
- 私有邮件/日历/GitHub 的真实验收依赖已连接的应用账号；不会借用 Codex 连接器凭据。

尚未向 CI 推送或触发 CI。

## 验证

- `bun test server/tests/task-center-sources.test.ts`：9 项通过，覆盖实际 Windows 文件读取、项目真实 BACKLOG 提取、目录越界、符号链接越界、owner 拒绝、邮件稳定身份/协议失败、信息来源封装、缺连接错误，以及发现上限不会阻塞后续待办。
- 最新 `bun run --cwd server typecheck` 通过（退出码 0）。中途并行代码曾出现 `plugins/mcp.ts:473` ReadableStream 类型错误，最新运行已消失。
- 未运行私有邮箱/日历/GitHub 的真实外部读取；本模块未取得这些应用账号的连接确认。测试中的协议样例与依赖替身不作为真实账号验收。
