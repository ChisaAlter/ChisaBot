# 个人助理生产化：现有能力、真实边界与必要修补

核对日期：2026-11-08。对象为当前 ChisaBot 工作树，包含已部署 DSH 迁移及尚未提交的实现。此文是生产计划的本地代码依据；本轮只读产品代码与已有证据，没有运行新测试、改变服务或外发消息。

## 结论：已有主体能力，生产计划应收口而非重建

此前开发的对话、记忆、技能、个人信息源、晨报、定时任务、后台 worker、任务中心、设备操作和审批都能继续使用。其中任务中心的来源去重、失败状态、依赖调度与 DSH 恢复已经有实际实现；不能沿用早期设计文档，把这些再列成待开发模块。

需要分开三件事：

1. **现有能力**：源代码、可见入口和执行接线存在，沿原模块修补。
2. **实例配置**：Chisa 尚未连接日历、邮箱、通知渠道，是使用配置缺口，不是整项功能未实现。
3. **生产合同**：部分既有路径对来源失败、发送回执、任务成功的定义不够严格；这些必须修复或明确限制首个发布范围。

推荐首个个人生产版本承诺：同一桌面聊天完成日程/收件箱摘要、资料整理、偏好记忆、文件成果、明确授权的提醒与任务；至少一个本人可接收的外部通知渠道完成实际送达。复用单个 Chisa 账号及现有 DSH Host，不扩回多租户运营平台，也不重新引入另一套 Agent 内核。

## 当前状态与证据如何使用

主线已经在生产只保留 Chisa 和一个 DSH Host；Chisa 的 426 条对话、87 个聊天文件保留，有七条记忆笔记。日历、邮箱、通知 Webhook 未连接；唯一现存定时任务处于 `paused / waiting`。这些为主代理本轮线上只读检查结果，记录在 [R5 实施记录](../pipeline-runs/20261107-dsh-migration.md) 的“单账号整理与当前个人助理配置”。现存暂停任务不作为验证载体，也不能因生产化计划自动恢复。

R5 的 E01–E18 已包含真实模型两轮、DSH 源日志与投影恢复、审批/Stop、后台入口、富补话、完整 Web UI、升级回滚及 Android 嵌入证据。对应实现未变时复用这些证据；新增工作只验改变的合同。真实外部 IM 外发仍由用户明确暂缓，协议 fixture 通过不能改写成真实收件成功。

旧目录 [features.md](../features.md) 明示截至 2026-10-17，仍把“每日简报”写成未做；[11 月 6 日映射](proactive-codebase-map.md) 也早于部分任务中心实现。计划与状态以当前源码和 R5 为准，不从旧目录推断缺失。

## 可复用能力与剩余动作

| 能力 | 现有实际合同与入口 | 处理方式 | 首个生产版本的验收对象 |
|---|---|---|---|
| 桌面/Web 对话与 DSH | `buildAgentFor`、自有 Conversation 和 DSH binding 共用；正文、工具、审批、补话与恢复已有 R5 证据。桌面客户端主窗口加载服务器同一 React 应用。 | **直接复用**；桌面原生窗口的实际使用路径单独补验，不能用 Android 证明。 | 已安装桌面端打开现有 Chisa 会话、文件成果、审批、Stop、重开；保持原历史与会话归属。参见 [pc/src/main.js](../../pc/src/main.js):3 与 R5 E09/E14/E16。 |
| 长期记忆 | `memory_search/save/update/forget/log`、按 Bot 开关、共享知识库、整理预览及撤销都在；每轮注入资料/偏好全文、人物/项目目录及最近两天日志，预算 7000 字符。 | **直接复用 + 语义补验**。不用因为七条笔记少就上向量库或换记忆框架。 | 跨会话记住带条件的偏好；纠正后用新值；忘记后不再通过正常记忆检索取到；外部内容不被升级为用户授权。参见 [memory-notes/service.ts](../../server/src/memory-notes/service.ts):169、293、457、597；[search.ts](../../server/src/memory-notes/search.ts):21；[index.ts](../../server/src/index.ts):1528。 |
| 技能与密钥 | 现有技能目录与回合选择保留；保险箱/安全输入能力已有独立模块。 | **直接复用**；接入凭据应走这些既有安全入口。 | 使用一个授权技能完成实际文件任务，密钥不进入普通模型参数和历史。技能选择已有 R5 修复，不另建技能目录。参见 [index.ts](../../server/src/index.ts):1519、1534、1583。 |
| 日历 | 账号连接页支持 ICS URL、`webcal://` 或内联 ICS；可读未来事件，没有日历创建/改期/删除的专用工具。 | **配置 + 解析修补**。首版承诺读取与提醒；日历写入不是现有能力。 | 使用真实授权订阅读取一次性、重复、例外、全天与跨时区事件；改期/取消后下次扫描正确。参见 [personal-sources/service.ts](../../server/src/personal-sources/service.ts):117、549、756、1300。 |
| 邮箱 | IMAP `EXAMINE INBOX` + `BODY.PEEK[HEADER.FIELDS ...]` 只读最近 1–20 封的主题、发件人、日期、标识；SMTP over TLS 可发送纯文本。未实现完整邮件正文/附件读取、收件箱修改、OAuth 授权链和标准回复引用头。 | **配置 + 发信可靠性修补**。首版可先限定为邮件摘要/草稿/确认后纯文本发送，不声称完整邮箱托管。 | 真实邮箱读取不标已读；重扫去重；确认前不发送；确认后一次接纳；丢回执显示待核对。参见 [personal-sources/service.ts](../../server/src/personal-sources/service.ts):222、321、337、648、899、1427。 |
| 晨报与人工巡检 | 已有 `morning_brief_generate`、`personal_check_updates`、天气/日程/邮件/定时/记忆聚合及 `brief` 卡片；账号连接页有生成晨报和巡检按钮。另有“资讯员→编辑”的工作流简报模板。 | **直接复用 + 来源状态修补**。不是新建晨报产品；区分个人晨报与新闻工作流。 | 日期/时区正确，真实条目带来源与更新时间，来源失败或未连接不能说“没有日程/邮件”；定时生成与发送分别留结果。参见 [service.ts](../../server/src/personal-sources/service.ts):797、1252、1525；[personal-sources.tsx](../../app/src/components/settings/personal-sources.tsx):89、122；[daily-brief.md](../../server/src/workflows/presets/daily-brief.md)。 |
| 定时与跟进 | `chisabot_schedules` 保存时间和运行状态；每 15 秒扫、暂停保持、连续硬失败暂停；Bot follow-up 使用同一 work queue，有次数/时限约束；回合共用 `governedTurnRunner`。 | **直接复用 + 实际到点/送达补验**。继续以 schedules 为用户定时入口，不复活旧 routines UI。 | 新建独立验收提醒，到点、重启、等待批准、取消各有准确状态；离线用户能在选定渠道收到并回到原任务。参见 [index.ts](../../server/src/index.ts):2549、3503；[schedules/service.ts](../../server/src/schedules/service.ts):875、1190、1490；[wake-up.ts](../../server/src/agents/wake-up.ts):33。 |
| 任务发现与 Inbox | 任务中心已有八类来源；邮件用 mailbox UID/Message-ID，文档用稳定条目身份；数据库唯一索引防重复；严格扫描保存失败并在连续失败后停源。 | **直接复用 + 真实来源配置/补验**。11 月 6 日“待建统一发现”已被后续代码部分完成。 | 一条真实来源变化进入一个任务；重扫不重复；新条目不会被老条目饿死；撤销连接显示失败。参见 [sources.ts](../../server/src/task-center/sources.ts):134、343、354、374；[service.ts](../../server/src/task-center/service.ts):179、707、748。 |
| 计划、依赖与 Outbox | 任务中心已有严格计划解析、最多六步、依赖、并发、租约、停止/暂停、风险决策、Outbox、错误与轨迹；执行调用原 Bot 或 local-agent 服务。 | **直接复用 + 成功条件修补**。不另建任务调度平台。 | 任务必须按实际成果判断完成；父任务等待子任务；审批后仍受具体工具权限限制；恢复已有执行而非重发。参见 [runtime.ts](../../server/src/task-center/runtime.ts):275、313、367；[service.ts](../../server/src/task-center/service.ts):765、809、950；[task-center.tsx](../../app/src/components/task-center/task-center.tsx):57。 |
| 后台 worker / handoff | 已有父子回合、持久身份、停止、审批等待、结果回父会话；迁移后使用持久执行读取，R5 E06/E07 有证据。 | **直接复用**。聊天子任务和长期任务中心维持各自产品归属，共享执行层。 | 只补新场景所改变的委派/成果合同，避免重复整套崩溃回归。参见 [workers/service.ts](../../server/src/workers/service.ts):252、326、417 与 R5 E06/E07。 |
| 外部提醒/消息 | 现有 IM 服务有持久 inbox/outbox、平台 receipt、授权撤销与 `outcome_unknown`；个人 Webhook 是另一条直接发送路径；旧 Slack/Teams/SMS/push 通知入口已经 no-op。 | **选择一个现役渠道配置 + 统一生产通知接线**，见下文。不能只给旧 push 表填值。 | 通知内容、目标、接纳与送达状态可查询；发送中崩溃不盲目重复；真实收件完成由用户单独授权目标。参见 [im/delivery.ts](../../server/src/im/delivery.ts):47、66、82；[index.ts](../../server/src/index.ts):586、2600；[notifier.tsx](../../app/src/components/schedules/notifier.tsx):8。 |
| 真实桌面执行 | 已有设备注册/WSS、能力开关、权限档位、授权目录、local-agent 任务、diff、应用/放弃、停止。`worktree/copy` 是副本隔离，不是系统沙箱；默认 `device_*` 不要求本地安装 coding agent。 | **主要是在线配置 + 实机补验**。首版选一台常用 Windows 设备及一种执行路径，不同时认证所有 CLI。 | 真桌面读指定目录、生成文件并实际打开、拒绝越界、停止长命令、掉线后准确显示；产生的成果与任务记录对应。参见 [shared/local-agents.ts](../../shared/local-agents.ts):1、48；[local-agents/service.ts](../../server/src/local-agents/service.ts):9；[local-agent-runner.ts](../../server/src/task-center/local-agent-runner.ts):47。R5 A18 的协议 peer 不替代此项。 |

## 五项应进入生产计划的代码工作

### 1. 来源“新鲜、过期、失败、未连接”必须贯通晨报和聊天

直接聊天用的 `listEvents/listEmails` 捕获异常后返回缓存，调用方没有 freshness/error 字段；`checkProactiveUpdates` 又将空结果概括为“当前暂无……提醒”。`listEvents` 无近期事件时甚至返回最后十条旧事件。[service.ts](../../server/src/personal-sources/service.ts):696–751、1252–1287。

任务中心的 `scanCalendar/scanEmails` 已经纠正了这一点：缺连接和读取失败抛错，demo 邮箱拒绝进入真实巡检。[service.ts](../../server/src/personal-sources/service.ts):756–794。把这份严格合同扩展给现有聊天/晨报消费者，允许展示明确标注的缓存，不把缓存降级藏起来。

完成标准：断网、凭据失效、真实空列表各有不同呈现；缓存有采集时间；失败不生成“无需处理”的完成结论，也不推进成功游标。

### 2. 用成熟日历解析补齐实际订阅语义

当前解析逐个 `VEVENT` 取字段，将参数从字段名剥离，未消费 `TZID`、`RRULE`、`EXDATE`、`RECURRENCE-ID`；没有 `Z` 的时间统一当作 `+08:00`。[service.ts](../../server/src/personal-sources/service.ts):88–155。这会影响常见重复会议和跨时区日历，属于代码差距，连接成功不能替代修复。

保留现有存储/设置/工具，替换或增强解析器，限定查询时间窗口后展开重复规则，按 `UID + occurrence` 区分实例，遵守取消与例外。若首版不支持某种订阅语义，应明确拒绝/显示限制，不能安静漏掉会议。没有日历写入需求时，不引入一套新 OAuth/CalDAV 写服务。

### 3. 外发接纳、实际送达与结果未知必须一致

SMTP 在 DATA 已发送后超时仍走普通 Error，`email_send` 将错误捕获为 `REFUSAL_MARKER` 字符串；DSH gateway 对正常返回统一记录 `completed`，只对抛出的执行异常记录 `outcome_unknown`。因此现有通用崩溃保护不能保证覆盖 SMTP 已发送但未收到 250 的窗口。[service.ts](../../server/src/personal-sources/service.ts):948、1011、1445；[tool-gateway.ts](../../server/src/conversations/tool-gateway.ts):98–114。

`pushNotifyMessage` 只校验 HTTP 2xx，不解析平台业务结果、不保存发送回执；入站 Webhook 自动转发还吞掉异常后返回成功。[service.ts](../../server/src/personal-sources/service.ts):1115–1161、1241–1248。修补应复用现有持久交付模式、固定操作身份和未知结果处理，不另造一套后台平台。SMTP 的 250 只能表示服务器接纳，不能显示为收件人已阅读或已送达。

完成标准：授权前零发送；一次决定对应固定内容/目标；HTTP 200 + 平台失败码显示失败；已提交后丢回执显示待核对且不自动换 ID 重发；重启后可读同一记录。

通知的接线也需要收口：

- [index.ts](../../server/src/index.ts):586–599 的 `deliveryNotifications` 是精简后保留的空实现，后文没有重新赋值；wake-up、responsibility、部分审批和问题仍调用它。
- 任务中心 [index.ts](../../server/src/index.ts):2600–2623 先写站内活动，再以 `void ...pushToThread(...).catch(...)` 发送最近私聊 IM；外部失败不会进入 decision 的通知错误。
- [ScheduleNotifier](../../app/src/components/schedules/notifier.tsx):8–17 需要页面存活，每 20 秒轮询，只报告打开页面后的新事件。关掉应用后的及时送达不能由它保证。

首版指定一个本人通知目标，把到点提醒、待批准、执行失败、完成成果接到同一个可观察的交付入口。旧 `delivery_*` 表为空只说明没有旧配置，不意味着启用它就能发送；已工作的 `chisabot_im_outbox` 应优先复用。真实外发验收仍需用户指定收件目标并授权，不能由本研究自动执行。

### 4. 接入凭据不能经普通模型工具参数长期存储

`email_connect` 模型工具接受应用专用密码；`notify_webhook_connect` 接受完整 Webhook URL。连接配置本身加密，但调用参数先经模型/对话，且 DSH 操作账本在 `claim()` 中直接保存 `JSON.stringify(input.args)`。[service.ts](../../server/src/personal-sources/service.ts):1378–1412、1454–1471；[tool-operations.ts](../../server/src/conversations/tool-operations.ts):47–55。

复用现有账号连接设置表单或保险箱安全输入，让模型只接收已完成连接的引用与状态；同步检查确认卡、运行日志、错误与导出中的脱敏。生产路径应拒绝将 demo 连接当真实成功。demo 已有测试价值，移到明确的开发/验收入口即可，不需要删除全部夹具。

完成标准：实际授权码/带密钥 URL 不出现在普通会话、模型请求、工具参数账本与日志中；只有服务端受限凭据存储持有内容，撤销连接后后续调用失效。

### 5. 任务完成必须依据用户要的成果，不能只有一段总结

当前 Bot executor 只要求非空 `replyText`，任务服务再按非空 `summary` 把状态设为 `succeeded`、事件写“成果已交付”；`componentArtifacts` 收集的是呈现组件 JSON。已有计划/风险/依赖并没有独立可执行的成果验收合同。[runtime.ts](../../server/src/task-center/runtime.ts):367–401；[service.ts](../../server/src/task-center/service.ts):1002–1047。

为首版支持的少数任务类型补明确结果合同即可：资料整理检查报告引用与来源，文件任务检查持久文件引用及实际可读，消息任务检查交付账本，设备任务检查返回结果与文件/命令退出状态。只得到计划、等待人登录、拒绝工具或未找到资料时应显示对应状态，不因模型给出总结就标已完成。将原任务的完成条件、结果与检查证据关联在现有任务详情，不扩建通用评测平台。

完成标准：正常任务有可打开成果；让工具被拒绝或故意不给预期文件时不能仍显示成功；重试复用已确认的副作用记录；取消不会被迟到总结翻回成功。

## 不应再次列成“从零开发”的内容

- 任务中心已有来源表、去重索引、Inbox/Outbox、计划、依赖、执行、租约、停止、恢复、履历和 UI。旧映射中“增加统一任务域”的建议已经被相当部分实现。
- 任务中心的严格 scan 已区别空结果与来源失败，邮件身份已经不依赖易变的 IMAP 序号；只需把正确合同传给仍旧的直接读取入口。
- 记忆已有编辑、真删、按 Bot 开关、整理预览/撤销；先验证偏好更正与遗忘的真实语义，不为“生产级”这个词引入新数据库。
- 定时任务与提醒已有生产实现，paused 是用户/业务状态，不能通过恢复旧暂停项获得“自动助理在工作”的假证据。
- DSH 的执行、源日志、审批和恢复已按 R5 验证。新生产计划保留这些成果，集中解决上面消费者的真实缺口。

## 推荐首版实际验收流程

在相应实现完成后，用 Chisa 的明确授权源和独立验收任务完成下列短链路；不批量复制测试账号进生产。

1. **早晨信息**：真实日历/收件箱 → 包含数据时间与来源状态的晨报 → 固定本人通知目标 → 记录平台接纳/实际收件。任何未连接源显示待连接，其他已连接源仍可提供部分结果。
2. **工作整理**：桌面端指向一个授权目录/附件 → 任务中心计划与执行 → 可打开的报告/文件 → 用户检查结果。失败示例要覆盖缺文件或工具被拒绝，不能用总结代替成果。
3. **需要人决定的动作**：形成邮件草稿或其他对外内容 → 具体内容/目标进入既有审批 → 用户指定的测试收件目标 → 一次发送与持久回执；拒绝和结果未知各有明确状态。
4. **跨天记忆与跟进**：记录带条件偏好 → 新会话准确使用 → 更正 → 忘记；另建一次提醒验证关闭窗口后仍执行、暂停后不自动恢复。

新验收不替代 R5 的有效故障恢复证据，也不把模拟邮箱、demo Webhook 或协议 peer 当成真实业务接通。首版可在明确范围内投入个人生产使用；完整邮件管理、日历写入、多渠道互通和所有 coding-agent 客户端应按独立功能逐项扩展。
