# ChisaBot 聊天前端迁移清单：DSH 与去除 CopilotKit

核对日期：2026-11-07。对象为 `fix/chat-reliability` 工作树中的实际前端及共享类型，包含本轮尚未提交的气泡与滚动修复。本笔记给主设计提供前端事实、替换面和验收场景；服务端执行与 DSH 官方契约由主设计及其他资料负责。

## 结论：保留界面，替换状态和执行归属

推荐保留现有 React `ConversationView`、`ChatTranscript`、Composer、Markdown、工具卡片和滚动实现，把它们接到 ChisaBot 自有会话状态模块。该模块订阅后端映射后的 DSH 会话事件，并把用户操作提交给 ChisaBot 后端。浏览器负责展示、输入和明确需要前端完成的交互；工具执行、审批决议和续跑归服务器。

当前 CopilotKit 不只是一个聊天组件。它承担消息数组、运行状态、工具执行接力、审批停顿、附件状态、工具渲染器注册和沙箱组件展示。仅将 `useAgent` 换成新的 Hook，仍会留下多条依赖链和两套执行所有者。

## 1. 入口与状态所有者

| 现有入口 | 当前职责 | 迁移处置 |
|---|---|---|
| [`app/src/components/layout/authed-shell.tsx`](../../app/src/components/layout/authed-shell.tsx) 的 `ChatCopilot` | 在已认证应用中懒加载全局聊天 Provider | 换为自有聊天作用域/渲染器 Provider；继续保持聊天代码按需加载 |
| [`app/src/lib/copilot/provider.tsx:52`](../../app/src/lib/copilot/provider.tsx) 的 `CopilotProvider` | `/api/copilotkit`、cookie 凭据、错误回调、所有工具注册、ActiveBot | 后端接口仍走同源登录态；将执行注册移到服务器，将纯展示注册移到本地注册表 |
| [`channel-chat.tsx:393`](../../app/src/components/channels/channel-chat.tsx) 的 `ChannelChat` | `channel:${channel.id}` 本地 agent、`runtimeAgentId`、`threadId`；发消息、同步、恢复、停止、编辑重发、队列和状态补偿 | 改为消费一份 thread-scoped 会话状态；容器协调 UI，不再直接改 SDK Agent |
| [`conversation-view.tsx:28`](../../app/src/components/channels/conversation-view.tsx) 的 `ConversationView` | 接收 messages、busy/pending/stopping、提交/停止、草稿与队列回调；组织输入与转录区 | 保留为呈现入口，去掉 `Message`、`Attachment` 的 SDK 类型依赖 |
| [`chat-transcript.tsx`](../../app/src/components/channels/chat-transcript.tsx) | 消息投影、过程折叠、气泡、工具/活动卡、确认/审批、无回答状态、历史挂载与滚动 | 继续使用现有呈现算法；把 chat context、工具注册和活动渲染替换为自有接口 |
| [`composer/composer.tsx:807`](../../app/src/components/channels/composer/composer.tsx) 的 `useAttachments` | 附件上传状态、文件处理、粘贴/拖拽；外加现有本地草稿、技能 chip、语音、队列 | 替换 SDK 附件状态 Hook，复用上传 transport、去重和草稿逻辑 |

目前 `ChannelChat` 同时保留 `agent.messages`、缓存/early history、`turnsInFlight`、`runsInFlight`、`agent.isRunning`、`joining`、`awaitingReply`、`turnFailure`。这些值对应不同事实，不能合并成一个笼统的 `isRunning`。特别是 SDK connect 回放也会设置 `isRunning`；现有页面通过 `joining` 区分“恢复历史”和“正在回答”。证据：[`channel-chat.tsx:1930`](../../app/src/components/channels/channel-chat.tsx)。

## 2. 当前发送与恢复链路

### 发送有明确的已接收语义

`say()` → `deliver()` 等 runtime readiness 和 history join → 组装技能 system message、用户内容及附件 → 乐观加入消息 → 修补旧工具缺失结果 → `copilotkit.runAgent()`。模型选择保存和目录缺失检查也在这条路径。

当前 `runAgent()` 对运行失败可能返回 resolved Promise，因此页面另行订阅终态，再由 `turnFailure` 决定草稿是否恢复。发送超时还要同时检查历史和 inbox，判断是“没到服务器”“已入队”还是“已收到但尚未回答”。迁移后应由后端提供稳定 `requestId` 的 admission receipt 和可查询状态，前端不再通过三个间接来源猜是否接收。

必须保留的用户语义：

- 没被服务器接收：保留输入文字、技能 chip、附件，提供可重试发送。
- 已接收且已有部分回答/工具动作：保留聊天记录，重试绑定原要求；不要又把同一句放回输入框制造重复发送。
- 只有卡片而没有文字也可能是完整交付，不能一律报“没有回答”；失败或消失的卡片不能算成功。
- 新话题首条消息和卡片按钮的提问走同一个 admission 模块；不允许它们绕过正在执行/排队语义。

证据：[`channel-chat.tsx:1180`](../../app/src/components/channels/channel-chat.tsx)、[`channel-chat.tsx:1260`](../../app/src/components/channels/channel-chat.tsx)、[`channel-chat.tsx:1440`](../../app/src/components/channels/channel-chat.tsx)、[`tool-renderers.ts`](../../app/src/lib/copilot/tool-renderers.ts)。

### 恢复不能重复拼接流

打开对话先显示本地 transcript cache 或快速 history read，再由 connect 接实时状态。全端变化监测会重新 connect；为避免 AG-UI 在已有 id 的文字后再次追加整段，`use-conversation-sync.ts` 显式重置 live tail 的文字和工具参数，并替换已有工具结果。

新事件层应明确分开：

1. 持久事件：按 session/revision/seq 去重应用，负责历史恢复。
2. 临时输出：按 attempt/turn/step 与 chunk index 更新；不冒充 durable cursor。
3. 持久结算：用最终块替换对应临时 attempt，不再在尾部追加第二份。
4. 历史加载：与 live follow 分开，只在缺口或用户向前滚动时补读；补历史不切换执行状态。

具体 DSH envelope 字段由后端 Adapter 固定，浏览器不直接 import DSH runtime 类型。现有 AG-UI 回放补丁保留在旧历史/旧内核 Adapter 内，完成 DSH 切换后从主聊天路径退休。

证据：[`use-conversation-sync.ts:109`](../../app/src/lib/copilot/use-conversation-sync.ts)、[`thread-sync.ts`](../../app/src/lib/copilot/thread-sync.ts)、[`thread-messages.ts:90`](../../app/src/lib/copilot/thread-messages.ts)、[`transcript-cache.ts`](../../app/src/lib/copilot/transcript-cache.ts)。

## 3. 工具执行与卡片展示必须拆开

### 3.1 大部分工具卡片可直接迁移

`useRenderTool` 负责的 worker、local-agent、handoff、GitHub、vault、pages、schedule、chat files、bot factory、escalation、`render_ui` 等卡片，多数真实执行已在服务器。迁移其 React 组件与结果解析，替换注册入口即可。

`ToolRendererRegistry` 应按 wire tool name 注册可见呈现，输入稳定的 `{ callId, name, arguments, result, phase, threadId, botId, attemptId }`。展示契约要包括：是否仅为过程行、能否形成有效交付卡、结束后无结果时如何显示、未知工具的通用行。已有 `pickToolRenderer`、`registeredCardChecks`、`ToolTurnEndedContext` 与 `ToolRenderBoundary` 提供可复用逻辑。

来源：[`provider.tsx:68`](../../app/src/lib/copilot/provider.tsx)、[`tool-renderers.ts:90`](../../app/src/lib/copilot/tool-renderers.ts)、[`chat-transcript.tsx:2889`](../../app/src/components/channels/chat-transcript.tsx)。

### 3.2 前端工具执行会影响“整轮结束”的定义

计算机工具经 `approval-tools.tsx` 的包装 Hook 注册为前端工具。一次用户要求可能分为多段 wire run，中间浏览器执行工具，再由 CopilotKit续跑。所以目前页面不能以 SDK run idle 判断整轮结束，也不能据此自动清空队列。

已有 Hermes 分支会声明 `chisabot.backend-owned-tools`；`approval-context.ts` 跟踪声明和实际 tool call，在终态前阻止前端重复执行。这证明“浏览器展示了工具调用”与“浏览器获准执行工具”已是需要显式区分的两个事实。

推荐把 DSH 暴露的计算机/设备/外部工具全部交给服务器的授权执行器；浏览器收到工具事件只呈现，不凭名字自动 dispatch。确实依赖浏览器的交互应是明确的 interaction request，由绑定的客户端提交结果，后端决定续跑和幂等；不能继续复用 `runAgent` 自动工具续轮作为第二个 Agent loop。

必须保留调用归属 `actor/bot/thread/run/toolCall`，不能使用“当前屏幕上的 Bot”作为执行身份；切换对话后，原来的工具仍属于原 Bot。

来源：[`approval-tools.tsx:85`](../../app/src/lib/copilot/approval-tools.tsx)、[`approval-context.ts:18`](../../app/src/lib/copilot/approval-context.ts)、[`computer-tools.tsx`](../../app/src/lib/copilot/computer-tools.tsx)、[`channel-chat.tsx:1000`](../../app/src/components/channels/channel-chat.tsx)。

### 3.3 Gallery、技能创作和 HTML 沙箱不是纯工具卡

- `gallery-tools.tsx` 使用 `useFrontendTool` 和 `useHumanInTheLoop`，每次调用重新核对组件授权；已撤销的组件不能通过旧的工具列表执行。
- `skill-tools.tsx` 同时提供技能/工具目录读取和人工决策卡。前者迁到服务器工具，后者迁到持久 interaction。
- `sandboxed-tools.tsx` 和管理页 `component-preview.tsx` 仍使用 `OpenGenerativeUIActivityRenderer` 展示发布过的 HTML/CSS/JS。虽然 Provider 关闭了自动生成的 `generateSandboxedUi`，这些已发布组件仍是现有能力，不能随删包一起消失。

建议让已发布 HTML 组件使用专门的 sandbox iframe 呈现模块，沿用现有发布和组件授权；明确来源校验与消息协议，不让沙箱直接调用主页面的模型/工具。该模块必须覆盖聊天、组件列表预览、单组件管理预览三个消费者。json-render 的 `render_ui` 保留现有校验与 React 注册表，无需换成 DSH 的网页组件。

来源：[`gallery-tools.tsx:141`](../../app/src/lib/copilot/gallery-tools.tsx)、[`skill-tools.tsx:165`](../../app/src/lib/copilot/skill-tools.tsx)、[`sandboxed-tools.tsx:118`](../../app/src/lib/copilot/sandboxed-tools.tsx)、[`component-preview.tsx:80`](../../app/src/components/component-preview.tsx)、[`routes/_authed/admin/components/index.tsx`](../../app/src/routes/_authed/admin/components/index.tsx)、[`routes/_authed/admin/components/$name.tsx`](../../app/src/routes/_authed/admin/components/$name.tsx)。

## 4. 审批、确认和队列的产品契约

审批 UI 与 SDK 状态分离后，`ConversationScope` 至少提供稳定 `threadId`、`botId` 和用户操作接口。`confirm-card.tsx`、`queued-messages.tsx`、`worker-card.tsx`、`local-agent-card.tsx` 目前用 `useCopilotChatConfiguration()` 只为获取会话身份；无需继续依赖 CopilotKit 才能展示它们。

现有确认分两类：绑定 toolCall 的确认卡，以及未绑定 toolCall 的普通/后台确认。后者在聊天尾部显示，决议后由持久的恢复记录接替，避免同一次决议重复显示。新模型必须保留 `interactionId` 与可选 `callId`，不能强制所有确认都有工具调用。

当前审批 202 会调用 `stopAgent`，由服务端决议执行一次并继续原对话；普通“等待用户交还电脑”不会同样停掉续轮。DSH 路径应显式呈现 `waiting_for_approval`、`waiting_for_user` 等状态，审批等待不能被翻译成 cancelled、failed 或 completed。刷新后从服务端恢复待答卡；浏览器提交决定只返回 decision receipt，后端负责执行和继续。

现有队列需要保留：

- 忙时纯文字进服务端 inbox，可在下一步被读取；带附件/技能的消息目前留在本地队列。
- 入队后在聊天尾部只显示一次；被读入后同一消息进入正式记录。
- Stop 把当轮相关补话暂停保留，不自动在停止后继续发送；用户可逐条/全部发送或撤回。
- 不同设备恢复 remote queued item 后，不各自补发一遍。
- 任务结果、定时触发、IM 等后台输入在同一会话中可见，不要求原浏览器一直打开。

迁移推荐让新发送合同同时支持文本、附件引用和技能引用，队列持久归服务器；本地只保存尚未提交的草稿和失败项。这是明确的目标改进，不是当前已具备的行为。停止后的 paused 队列保留为产品语义，不能直接照搬 DSH cancel 默认行为。

来源：[`confirm-card.tsx:235`](../../app/src/components/chat/confirm-card.tsx)、[`approval-tools.tsx:170`](../../app/src/lib/copilot/approval-tools.tsx)、[`use-thread-inbox.ts:14`](../../app/src/lib/copilot/use-thread-inbox.ts)、[`queued-messages.tsx:11`](../../app/src/components/chat/queued-messages.tsx)、[`conversation-view.tsx:70`](../../app/src/components/channels/conversation-view.tsx)、[`channel-chat.tsx:1836`](../../app/src/components/channels/channel-chat.tsx)。

## 5. 停止、重试和编辑必须以服务端事实驱动

当前 Stop 同时发服务器停止请求、停 SDK，并立即清空本地 busy 计数以避免挂死；`stopping` 和失败重试又单独维护。迁移时改成：按下停止立即显示“停止中”，收到接受回执仍保持 stopping；只有执行终止事实到达，才显示“已停止”。断线时保留“停止结果待确认”，重连读取同一 request，不因超时宣告成功，也不取消其他线程。

重试区分未接收、已接收但未完成、已发生外部副作用三类。最后一类不自动重演工具。普通重新生成和编辑目前先由服务端截断旧版本，再同步本地消息，附件仍保留；其他设备按 revision 重建。DSH 的编辑/分支实现须由主设计确定，但前端保留“原记录可追溯、当前分支显示一致、旧流不能写入新版本”的契约。

来源：[`channel-chat.tsx:1699`](../../app/src/components/channels/channel-chat.tsx)、[`channel-chat.tsx:1732`](../../app/src/components/channels/channel-chat.tsx)、[`channel-chat.tsx:1770`](../../app/src/components/channels/channel-chat.tsx)、[`regenerate.ts`](../../app/src/lib/copilot/regenerate.ts)、[`connection-drop.ts`](../../app/src/lib/copilot/connection-drop.ts)。

## 6. 附件、Markdown 和历史形态

附件不能只替换为 DSH 的输入图片对象：产品已经拥有上传行、staged row id、channel 归属、下载路由、文件大小/类型约束、截断提示、草稿附件和历史附件卡。迁移时由 ChisaBot 继续拥有附件及访问授权，提交给 runtime 的是后端验证后的引用/内容。前端 `AttachmentDraft` 应携带 stable upload identity、状态、媒体类型、名称、大小及服务端引用。

继续支持无文字仅截图发送、上传进度、取消上传、失败重试、拖拽与粘贴、切换对话保留草稿、停下/失败后附件不丢失、编辑文字后保留附件。共享限制仍由 [`shared/attachments.ts`](../../shared/attachments.ts) 负责；不得为了适配 SDK 默默降低现有上传能力。

旧 AG-UI 历史存在两种工具调用形态：`{ id, name, args }` 和 `function.arguments`；assistant 的 `content:null` 在无正文工具回合是合法存储形态。现有 reader 会正规化并计数真正不可读的记录。新历史 Adapter 必须保留该兼容，不可把未知字段全部剥掉，不可因一个 malformed item 清空整段历史。

本轮修复应成为新前端的初始基线：所有可见 assistant 正文进入同一套气泡；普通多标题 Markdown 不自动变 doc 卡；围栏中的指令示例按代码保留；标题与代码组合仍有气泡底；idle 时不创建弹性留白；跟底平滑滚动遵守 reduced motion。换内核不会替代这些修复。

来源：[`composer/attachments.ts`](../../app/src/components/channels/composer/attachments.ts)、[`composer/composer.tsx`](../../app/src/components/channels/composer/composer.tsx)、[`chat-messages.ts`](../../app/src/components/channels/chat-messages.ts)、[`thread-messages.ts`](../../app/src/lib/copilot/thread-messages.ts)、[`bot-bubbles.tsx`](../../app/src/components/chat/bot-bubbles.tsx)、[`chat-transcript.tsx`](../../app/src/components/channels/chat-transcript.tsx) 当前 diff。

## 7. 建议的前端模块

| 模块 | 拥有的数据/行为 | 不应承担 |
|---|---|---|
| `chat/session-store` | 单会话不可变 snapshot、持久 seq、live attempts、admission 状态、执行状态、待答交互、队列投影 | 发模型请求、执行工具、批准动作 |
| `chat/session-client` | 同源鉴权 transport、发送/停止/决议命令、follow 生命周期、断线补读 | 渲染布局、从自然语言猜状态 |
| `chat/legacy-adapter` | 旧 AG-UI messages/events 与存储方言转为产品视图；保留旧链接、ID 和未知元信息 | 在 DSH 会话中偷偷重放旧工具 |
| `chat/renderers` | 工具/活动注册表、fallback 行、有效交付卡判断、错误隔离 | 自动 dispatch 工具 |
| `chat/conversation-scope` | thread/bot 身份与明确动作 callback，供卡片、队列、确认消费者使用 | 全局“最近活跃 Bot”执行身份 |
| `composer/attachment-state` | 上传状态、取消、重试，与现有草稿、队列协调 | 模型输入编码和权限决定 |
| `chat/sandbox-surface` | 已发布 HTML 组件与预览的 iframe 展示 | 主页面凭据、无限制宿主调用 |

这些名字是设计建议。目标是将当前 `ChannelChat` 的接入补偿移到一个有清楚合同的模块，并利用已存在的 `TranscriptDataLayer`、tail-first/可选虚拟化、stable row id 和 memo，而不是重写整个聊天视觉层。

执行状态建议使用 `idle / admitting / queued / running / waiting_for_approval / waiting_for_user / stopping / completed / cancelled / failed / interrupted` 中实际适用的维度。连接状态 `connecting / online / reconnecting / offline` 单独保存；历史状态 `loading / ready / partial / unavailable` 再单独保存。`completed` 等 run 终态属于具体 run；thread 还可接下一轮。不要把这三个维度塞进一个单值枚举后让“断线”覆盖“后台仍运行”。

## 8. 依赖移除范围

1. 替换所有 `@copilotkit/react-core/v2` Hook、Context、types、SDK sandbox renderer 后，删除 `app/package.json` 的 `@copilotkit/react-core` 以及 `main.tsx` 中 SDK CSS。
2. 删除/重写 `app/vite.config.ts` 的 CopilotKit vendor 分包、a2ui stub、管理预览分包特例；逐项判断其他包仍有消费者再删，不能把 Markdown/Streamdown/json-render 一并删掉。
3. 清理专门隐藏 SDK Inspector、推广弹窗及 SDK drag label 的 CSS，同时保留 ChisaBot 自有气泡和 Markdown 样式。
4. 管理组件两页及全局 shell 都需完成迁移，不能以聊天页能打开作为删包完成证据。
5. `@ag-ui/*` 与 CopilotKit 不等价。前端可以在自有类型覆盖全部消费者后移除直接运行依赖；旧历史 Adapter 和远程 AG-UI Bot 协议兼容仍有价值。服务器的外部 AG-UI 能力是否保留由主设计确认，不能因 DSH 成为内置内核便删除外部 Agent 产品入口。前端配置文案及 `lib/agents/form.ts` 明确仍允许填写外部 AG-UI endpoint。
6. `shared/reply-sources.ts` 使用 Message 子集，`shared/task-center.ts` 的 trace 仍描述 AG-UI event type；应改成产品层事件或明确 legacy variant，而不是导入 DSH 内部事件类型污染共享协议。

来源：[`app/package.json`](../../app/package.json)、[`app/src/main.tsx`](../../app/src/main.tsx)、[`app/vite.config.ts:163`](../../app/vite.config.ts)、[`app/src/styles.css`](../../app/src/styles.css)、[`app/src/lib/agents/form.ts`](../../app/src/lib/agents/form.ts)、[`shared/reply-sources.ts`](../../shared/reply-sources.ts)、[`shared/task-center.ts:200`](../../shared/task-center.ts)。

## 9. 前端迁移验收矩阵

本矩阵定义后续实施验收；此次资料调查未运行应用或测试。

| 场景 | 必须看到的结果 |
|---|---|
| 新会话首条消息、仅附件、技能 chip | 每次只有一条接收记录；内容与附件不丢；用户自己的文字不被技能正文替换 |
| 打开已有会话/从设置返回 | 恢复历史不冒充新回答；不闪停止按钮、不跳到半截历史 |
| 后台运行时切 Bot/切 thread | 原任务继续且归属不变；回到原线程显示正确最新状态 |
| 普通文本、长 Markdown、代码围栏、表格、标题+代码 | 正文留在气泡；普通长文不突然变卡；格式在流式和完成后稳定 |
| 工具连续执行并逐步输出 | 工具卡和文字顺序稳定；单个 token 不令全部已完成卡片重渲染 |
| tool-only 图片/文件/确认卡完成 | 有效卡片算可见结果；不会附加误导的“没有回答/重新执行” |
| 工具失败/无结果/未知工具 | 有可理解的失败或未完成状态；不留永久 skeleton、不让整段聊天白屏 |
| 断网再连接/重复帧/乱序与缺口 | 已接收请求不重发；文字和工具参数不重复；缺口补读后顺序一致 |
| 浏览器关闭后模型完成 | 重开可读完整回答及工具结果；不依赖浏览器补一轮模型请求 |
| 接收前停止、工具中停止、审批时停止 | 停止状态有据可查；未获授权的工具不执行；其他线程继续 |
| 停止失败或响应丢失 | 显示待确认/可重试；不虚报“已停止”，不新发一份任务 |
| 忙时补话、附图补话、多设备排队 | 同一内容只入队/读取一次；停止后 paused 消息保留待用户发送 |
| 审批允许/拒绝/过期/刷新/两设备竞争决定 | 同一请求最多一次有效决定；卡片与最终工具结果一致 |
| 组件授权在运行中撤销 | 已有可读结果保留；新调用由服务器按当前授权决定 |
| 编辑/重新生成、另一设备同时观察 | 附件保留；revision 切换明确；旧流不污染新版本 |
| 长历史补页/搜索跳转/用户向上阅读 | 保留阅读锚点；新 token 不抢滚动；结束后无大块空白 |
| 桌面/窄屏、明暗主题、reduced motion | 同等信息和操作可达；滚动和气泡不溢出 |
| 管理组件列表及单组件预览 | Gallery、json-render、已发布 sandbox HTML 都能正常展示 |
| 旧 AG-UI 历史、外部 Agent 对话 | 保留可读性、工具结果、附件和现有入口；单项损坏可见且不清空历史 |

## 10. 给主设计的决策点

- DSH Session 事件需要由服务器映射为稳定产品事件；前端从 receipt/状态事实驱动，不以自然语言或 Promise resolve 代替完成。
- 工具执行应统一到服务器；纯渲染注册表是前端去 CopilotKit 的核心工作，Gallery/HITL/沙箱预览必须作为同一迁移范围。
- 新内核一上线就要覆盖 Stop 的 paused 补话语义、审批恢复和后台交付；这些不是后续 polish。
- AG-UI 的保留范围应按外部 Agent/旧记录兼容确定。删除 CopilotKit 与废除 AG-UI 不能混为同一决定。
