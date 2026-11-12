# ChisaBot 迁移到 DSH：实施设计所需的官方契约

核对日期：2026-11-07。本文固定官方源码 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，版本 `0.2.2-rc.1`；不把 Whale Isle 的下游改动计作官方能力。选型依据见 [DSH 内核评估](20261107-dsh-kernel-sources.md)。本文补充接入、持久化、停止、审批和恢复这些会直接改变实现的契约。

## 1. 实施设计应采用的决定

1. **使用独立、固定版本的 DSH Host，运行自定义 `chisabot` profile。** ChisaBot 后端通过 Host 的 Connection、Gateway 和 Session Controller 驱动会话；工具和审批由 ChisaBot 插件接入。`headless` 是执行一次任务后退出的 profile，不能拿它的名字代替常驻无界面 Host。[CLI][cli]
2. **复用官方 Host 连接契约，浏览器仍只连接 ChisaBot。** DSH API 默认使用启动 token 换 API Cookie 和 Peer，并非 `Authorization: Bearer`。Cookie 不交给浏览器用户，DSH 监听受控内部地址。[Connection][connection]
3. **保留旧聊天记录，首次继续时创建新的 DSH 执行段。** 通过明确标记的迁移上下文承接旧对话；完整原记录继续展示和检索。官方有合法 DSH event seed，没有 AG-UI/早期上游模板 历史导入器。[Agent create][agent-index]
4. **把流式展示和持久历史分开。** `follow` 每次开流先给 snapshot，再给持久事件和可选 assistant frames；它没有 `afterSeq` 参数。重连不能把上一次 transient revision 当新进程的持久游标。[Session types][session-types]
5. **审批的待答状态属于活跃 runtime。** 重启后不能继续向旧审批 Promise 回答或自动重放批准；业务 Outbox 可保留用户决定，但再次执行必须绑定新请求、复核权限与参数。[Approval][approval]
6. **停止当前轮、清空输入队列、终止后台任务是不同动作。** 官方 `session.cancel` 保留 inbox，返回接受取消请求；ChisaBot 必须在自己的停止语义里显式决定另外两项。[Session commands][session-commands]
7. **先保证同模型有界重试，跨模型 fallback 独立设计。** 官方 step 固定模型选择后，`agent/request` 不允许修改路由；不能仅靠 `request-error` 钩子修改下一步选择就声称完成了失败当前步的透明 fallback。[Agent loop][agent-loop]

## 2. 常驻 Host 的启动与装配

### 2.1 官方支持的启动入口

`dsh` 是官方支持的 Node 应用启动器。`dsh --profile <name>` 启动 `$DSH_HOME/profiles/<name>` 下的 profile；profile 包含 `package.json` 的 `dsh.profile.bundles` 和 `cordis.patch.yml`。组合顺序是 bundle patches → profile patch → home patch → 命令行 `--patch`。[CLI][cli]

`--from-default-profile` 会**替换**自定义 profile，不能作为每次服务启动的初始化动作。生产 profile 应由部署产物创建一次，再正常启动。`--dump-config` 可观察组合结果；它输出配置值，运营工具必须按可能含敏感配置处理。`--dump-config-schema` 读插件 schema，不执行正常 runtime 启动。[CLI][cli]

官方 Web profile 提供现成 Host 装配，可用 `dsh --profile web --no-open` 进行最初接口验证，但它仍会装配 Web UI、默认 preset 和工具，不能因此视为 ChisaBot 最终最小组合。[Web bundle][web]

### 2.2 自定义组合应复用什么

官方 Web bundle 的 Host plane 装配了 Session Controller、Workspace、Connection、Gateway/Remotes、文件上传与模型相关服务；浏览器 UI 是另一个装配面。最终 `chisabot` profile 应复用这些 Host 能力，配置自己的 Agent preset、授权工具和 persona，并排除默认 coding 工具、插件安装工具及 ChisaBot 不提供的 UI。[Web patch][web-patch]

这是一项明确的装配工作；官方没有一个已经完成 ChisaBot 业务授权的 `chisabot-host` 模板。实现时使用固定版本的生成 schema 和 `--dump-config` 落实准确依赖，不在设计中伪造一份未经启动的完整 YAML。

建议只保留一个模型路由配置来源：ChisaBot 已有连接配置生成 runtime 的 provider/model/credential 引用。长时运行所需的 Host 日志、JSONL session store、model catalog 和插件版本属于部署产物或 runtime 数据，不与浏览器状态混在一起。

### 2.3 Connection 的鉴权契约

官方 Connection 的 Web carrier 要求每次 RPC 和 WebSocket 都有认证。启动 token 通过以下两类入口换 cookie：[Connection][connection]

- 浏览器：根页面 `GET /?token=...`，写入 signed browser Cookie 后跳转到不含 token 的地址。
- API：`GET /connect?token=...&interactions=answer|none`，返回 302、Mux 地址和 signed API Cookie；默认 `none`。

HTTP carrier **不接受 Authorization header token**。ChisaBot 接入器应实现官方 API 握手，保留 Cookie，再用同一 Cookie 建立 HTTP 和 Gateway WebSocket；已有 Node `./client` entry 和 `installConnection`/transport hooks 可复用。不要在普通访问日志中记录 token 化 URL 或 Cookie。

API Cookie 绑定一个 owner-principal Peer。一个 API WebSocket 拥有其清理生命周期；socket 关闭后，旧 Cookie 的 HTTP 调用被拒绝。重连和 Host 重启后要重新 `/connect`，不能只无限复用旧 Cookie。[Connection][connection]

`interactions=none` 适合只调用方法和订阅自主管理流的接入；要通过 Remote Events 回答 `approval/request` 等 waterfall，则需要 owner answering Peer。另一条可行路径是在 ChisaBot 插件内挂终端 approval answerer，使用 ChisaBot 自有审批通道；设计必须明确选哪一条，不能同时让两处竞争回答。

**推荐：ChisaBot 插件拥有审批 answerer，后端适配器拥有会话流。** 这样现有业务审批、权限审计和 Outbox 可以接在同一处。Host 的 owner Cookie 是后端特权凭据，ChisaBot 后端仍须在每次调用前验证 actor、Bot、thread 与 runtime/session 映射。

原生 Gateway 支持非 owner principal 的资源授权，不能自动代替 ChisaBot 账号映射。`ctx.connection.createPeer({principal, interactions})` 是同进程入口，不能误写成任意外部用户可传入 principal 的 HTTP 参数。[Connection][connection] [Session Controller][session]

Web carrier 不支持 `--host 0.0.0.0`，只能 loopback 或具体本机 IP。内部同机部署优先 loopback；跨容器要指定具体可达地址并限制端口访问。外部 TLS 代理不能自动让上游 HTTP listener 的 Cookie 获得 `Secure`；Listener 自身的 TLS 才决定此属性。[Web bundle][web]

## 3. 历史导入与持久化

### 3.1 确实存在公开 seed 接口

`ctx.agents.create(options)` 接收：

- `sessionId`：Agent 和 Session 共用的执行身份。
- `seed?: readonly SessionEvent[]`：从 `seq = 0` 开始连续、lossless-JSON、通过 Session 语义验证的 DSH 事件。
- `meta.isSeeded` 和 `inheritedEventCount`：用于精确 fork 继承前缀。
- `setup(agentCtx, agent)`：在发布 Agent 之前配置工具、prompt、约束和监听器；不得在 setup 期间驱动模型。

`resume` 会重建 fresh scoped world，同样支持 setup。工具授权不能只在新建时安装，恢复时也必须按照当前权限重新组装。[Agent create/resume][agent-index]

`seed` 不是 `messages: [{role, content}]`。任意 AG-UI 消息直接转 JSONL 不满足 turn/step、request header、工具调用关系、surface 操作和 event seq 等不变量。Session format migration 面向 DSH 自己的历史版本，不是跨产品导入器。

### 3.2 推荐的旧会话承接策略

采用“同一 ChisaBot 对话，多个执行段”的映射：旧记录保留原身份和存储；首次交给 DSH 时创建一个新 DSH Session，记录切换点、原 thread、源消息范围和迁移上下文版本。前端按执行段合并展示，用户仍看到一段连续对话。

迁移上下文携带已核对的目标、约束、已完成工作、未完成事项和最近必要对话。把它作为明确标记来源的上下文进入新 Session；不能把摘要当作旧工具已经由 DSH 执行过的证据。完整原记录继续保留，并可通过只读历史查询工具补取细节。此方案需要验证长对话承接质量，但无需伪造大量 DSH 执行事件。

已经运行、等待审批或存在未定副作用的旧轮次必须先达到清楚的终态或可恢复检查点，再建立新执行段。旧审批结果不能重写成新 DSH 工具调用的成功结果。

若后续必须原生导入全部历史，应单独实现 AG-UI→DSH 格式转换器，使用官方 Session validation、完整 tool call/result 对应、turn/step 闭合和读取重建检查验证；原始记录仍保留。公开 seed 使此方案可能，但不降低转换的语义成本。

### 3.3 存储不是双写历史

`SessionPersistence` 提供 `create/open/stat/list` 和 handle 的 `read/append/flush/close`。同一 backend 实例内一份 Session 只能有一个 writer。`append` 返回代表接受、排序和本实例可见，**`flush` 才是持久性屏障**；JSONL 实现有自己的存储行为，消费者应依公共契约设计。[Persistence][persistence]

发布 Agent 前，agent-loop 获取 write handle；运行事件由 backend 路由到 handle。创建 seed 在发布前写入，不能再通过 live event 路径重复灌入。关闭 writer 会完成持久化并释放拥有权。[Persistence][persistence]

DSH 保存模型执行历史；ChisaBot 保存业务消息映射、执行段、投影和检索索引。对话投影可以重新生成，不再成为每轮覆盖 DSH 原始日志的第二份执行真相。

进程中断后的恢复会补齐未完成工具的错误结果、未闭合 step 和 `turn/end {interrupted}`。恢复日志不代表重新运行工具，更不代表外部 shell/browser 进程已经恢复。[Persistence][persistence]

## 4. 流式会话、去重和重连

### 4.1 不要发明 `follow(afterSeq)`

固定版本的 `SessionFollowRequest` 有 `address`、`activate?`、`assistantStream?: true`、`maxMessages`、`turnWindow`，**没有 afterSeq/cursor 字段**。开流返回完整 opening snapshot：`header`、`cursor`、`records`、`hasMore`、`projections` 和可选 assistant baseline，然后才是 durable events 与 live frames。[Session types][session-types]

历史分页应使用新 `session.events`；`session.page` 是 deprecated alias。`throughSeq` 指定 inclusive cut；`events` 返回该次读取 cursor。`observeEvent` 只是被动订阅，`ready` 没有 snapshot cursor，不能靠它独自解决“读完历史后才开始订阅”的丢事件窗口。[Session Controller][session]

应优先复用 `SessionEventStream` / `RemoteJournalStream` 已有 follow-before-page、gap repair、generation replacement 逻辑，再转成 ChisaBot 浏览器协议。若为了兼容应用架构自己消费原始帧，就要完整承担同样的顺序语义。

### 4.2 两种序号各管什么

| 数据                   | 识别和顺序                                                                 | 重连处理                                                                             |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 持久事件               | Session ID + event `seq`                                                   | 从 opening snapshot、history page 和后续 events 重建；完整重复项可去重，缺口必须补读 |
| 实时 assistant attempt | `attemptId`、`revision`、`index`，并带 turn/step、`startedAfterSeq`        | opening baseline 替换旧 process-local 状态；不能跨 generation 比 revision 大小       |
| durable settlement     | `assistant/message` 或 `assistant/attempt`，end frame 指向 committed `seq` | 用它接替对应临时内容，不能追加第二份完整正文                                         |
| abandoned attempt      | live end 的 `kind: abandoned`                                              | 清理对应临时状态；不伪造成功持久消息                                                 |

实时 `chunk.index` 密集递增。开流 baseline 携带已累积 compact stream 和 `nextIndex`。durable settlement 与 live end 到达次序需按官方规则协调；失败 attempt 与成功 message 的展示行为不同。断线可以补全已提交消息，进程硬退出前尚未 settlement 的 token 不承诺持久保存。[Session types][session-types] [Session Controller][session]

普通物理断线触发重连；业务、持久化和无法修补的连续性错误是终态错误，不能一律无限重试。重连是恢复读取，不是自动再提交 prompt。

### 4.3 Prompt 幂等与完成状态

`session.prompt` 的 `requestId` 是提交相关身份；已在 inbox 或日志内出现的 requestId 返回原接受结果，不追加第二条用户消息。ChisaBot 应在发送前持久保留一个稳定 requestId；超时重试复用它，真正新的用户提交创建新 id。[Session Controller][session]

当前还有 `session.state`、`observeState`、`wait`：`SessionState` 提供 `cursor/active/running/queue/pendingInput`；`wait` 返回 `idle | input-required | timeout` 及有界 assistant output。`pendingInput` 变化本身不保证触发 observeState，wait 会自己定期刷新。[Session types][session-types]

`wait(afterSeq)` 的 afterSeq 是**输出筛选游标**，不是 follow 恢复游标，也不把最后一个回答自动归属于某一条 prompt。ChisaBot 的 run、子任务和交付状态仍须按业务标识关联。

## 5. 停止、审批与进程恢复

### 5.1 停止的三个层级

官方 `Agent.cancel(cause, {keepInbox})` 取消当前活动；省略 keepInbox 会清空队列。Host `session.cancel` 选择 `keepInbox: true`，因此 pending next-turn 和 next-step 输入继续存在。[Agent runtime types][agent-runtime] [Session commands][session-commands]

| ChisaBot 动作 | 必须处理的状态                                                                        |
| ------------- | ------------------------------------------------------------------------------------- |
| 停止当前回答  | 请求取消当前 turn，撤销当前审批等待，等待前台工具退出；保留队列与否由产品动作明确表达 |
| 停止本次任务  | 还需撤销这个任务拥有的待执行输入、子任务和后台作业，保留无关会话                      |
| 停止 runtime  | 停止接收新任务，按拥有关系回收全部 Agent/工具，flush 并关闭存储，再结束进程           |

返回 accepted 只是取消请求被接受。UI 的“已停止”应在对应活动和工具清理达到终态后显示；等待期间显示正在停止。不要为停止一条对话关闭共享 runtime，让其他会话失败。

### 5.2 审批的实际生命周期

`approval/request` 是 waterfall；每次 Agent 作用域注册一个 terminal answerer，自己的请求返回结果，其他请求 `next()`。`ask` 委托 answerer；`never` 是拒绝所有需审批请求，不是全部自动批准。answerer 缺失、抛错或返回无效值都变成 unavailable。[Approval][approval]

一次请求包含 Agent、tool、可选 callId、理由和 AbortSignal；要求处于打开的 turn。取消会撤回问题，晚到答案丢弃。`approval/asked`、`approval/decided` 是审计事件；pending questions、answerers、grants 留在 runtime 内，不是可从日志恢复的待执行授权。[Approval][approval]

ChisaBot 自有审批记录应保存 scope、调用身份、参数版本、请求代次、状态与结果。结果只能交给仍匹配的活跃请求。进程重启后旧请求标为失效/执行中断；用户已做决定可留作记录，但新请求需要重新绑定当前参数和当前权限，不能自动兑现旧 callback。

用户澄清问题与敏感动作审批不同。DSH `userQuestions` 对已经返回 pending 或原进程结束的问题有 `continued` 状态，后续 `answer` 作为新 `user-question-reply` steering 消息进入 Agent；不会复活已结束的 tool call。[User questions][questions]

## 6. 模型路由、重试和 fallback

### 6.1 当前公开能力

`AgentOptions` 可以给 provider/model/reasoningEffort/maxTokens；`agent.model.select(selection)` 写入以后 step 的完整模型选择。step preparation 捕获 selection；官方 `agent/request` 明确拒绝在这个位置改 provider、model 或 reasoningEffort。[Agent runtime types][agent-runtime] [Agent loop][agent-loop]

`dsh-llm-retry` 在 `agent/request-error` 上实现同模型请求重试。默认 normal policy 是五次重试，匹配 EMPTY_RESPONSE、RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT；normal 支持有限预算和 backoff，always 会不断尝试直到成功、取消或卸载。ChisaBot 应选明确有界策略，避免把无限等待带回聊天。[Retry][retry]

错误钩子的返回值是 `{kind: 'retry'} | undefined`，没有返回新 model 的字段；重试保留当前 step。文档不能写成“收到错误 → model.select(backup) → retry”就已支持当前请求跨模型切换。需要在实施阶段验证合法的 step 恢复入口，或在正式 provider adapter 的路由契约内完成替代，并让实际模型和失败 attempt 正确入日志。

**建议第一条验证路径：明确主模型、同模型有界重试、终态可解释、用户可选择备用模型继续；自动跨模型 fallback 在公开契约验证通过后再接回。** 若 ChisaBot 当前自动 fallback 必须作为迁移等价条件，它应是切流前的独立完成项，不能以同模型重试代替。不能在未知是否产生外部副作用时自动重放整条用户任务。

### 6.2 凭据和模型目录

`llm-pi-ai` 支持多 provider、自定义 baseURL 和模型元数据。`apiKeyEnv` 是 credential reference，每次请求重新解析；同一路由一个协议。stored credential 优先于同名进程环境值，轮换环境变量不一定改变实际凭据。[Provider][provider] [Credentials][credentials]

凭据记录按插件 `<scope>/<id>` 命名，这是插件归属，不是 ChisaBot actor 隔离。隔离方案应由部署/适配器明确建立：独立用户或执行域的 DSH_HOME、最小环境、受控 provider 引用；不能依赖不同 sessionId 自动隔离进程环境或共享 credentials store。

工具也应在 `setup` 的 Agent scope 注册，只暴露该 Bot、当前 actor 和任务已获授权的集合。scope 隔离注册与生命周期，无法把可执行任意本机代码的插件变成安全沙箱。[Agent create/resume][agent-index]

## 7. 影响切流的具体验证项

以下是当前契约留下的实现检查点，已有事实不需要重复调查：

- 自定义 profile 的 Host 依赖树能从固定产物启动，使用官方连接握手完成一次 session create/prompt/follow/cancel；此时再确定最终最小插件清单。
- ChisaBot 的 actor/Bot/thread 绑定在恢复 Session 和重新加载工具时仍生效；不同执行域凭据不串用。
- follow snapshot 与实时 attempt settlement 转成前端消息后不重复、不漏末段；重连不重复提交用户输入。
- runtime 重启后日志恢复为 interrupted，旧审批不能授权新动作；原始旧聊天仍完整可读，迁移上下文正确承接。
- 明确“停止当前回答”与“停止任务”的队列/后台作业行为，并实测一条会话停止时其他会话继续。
- 自动跨模型 fallback 若作为保留功能，必须通过合法公开入口实现并覆盖模型目录、推理/图片能力、失败 attempt 和工具副作用边界。

[cli]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/cli/README.md
[web]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/web-app/README.md
[web-patch]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/web-app/cordis.patch.yml
[connection]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/connection/README.md
[agent-index]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/index.ts
[agent-runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts
[agent-loop]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent-loop/src/agent.ts
[persistence]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/session/session-persistence/README.md
[session]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/session-controller/README.md
[session-types]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/session-controller/src/types.ts
[session-commands]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/session-controller/src/commands.ts
[approval]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/user-approval/README.md
[questions]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/user-questions/README.md
[retry]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-retry/README.md
[provider]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm-pi-ai/README.md
[credentials]: https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/credentials/credentials/README.md
