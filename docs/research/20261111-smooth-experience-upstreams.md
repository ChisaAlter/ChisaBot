# 聊天与日常操作的流畅度：上游实现对照

核对日期：2026-11-11。ChisaBot 基线为 `9293dfc8` / 0.1.142。本次读取固定提交的源码与本项目对应模块，没有运行上游产品；下面分别记录源码行为、可采用的原则和已确认的本地差异。

**优先补全操作连续性，保留现有 Streamdown、virtua、会话恢复和任务账本。** 最明确的新增机会是：未发送附件在刷新或桌面页面重载后可以恢复。其余上游做法主要提供已有机制的检查标准，不值得再造一套消息、虚拟列表或重连系统。

## 项目身份与固定版本

| 项目                                                                                                                      | 本次固定提交           | 许可与采用范围                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [早期上游基础模板](https://github.com/ChisaAlter/ChisaBot/blob/main/docs/THIRD_PARTY_NOTICES.md)                          | `795f619b`，2026-11-10 | [MIT](https://github.com/ChisaAlter/ChisaBot/blob/main/docs/THIRD_PARTY_NOTICES.md)。参考消息身份和历史呈现；不恢复 旧聊天前端框架 生产依赖。                                 |
| [aibot-fans/dsh-bot](https://github.com/aibot-fans/dsh-bot/tree/fa15588fb62b7605d00c63bf23fa55b1ac54bb70)                 | `fa15588f`，2026-11-05 | [Apache-2.0 及组件许可](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/README.md#许可)。参考草稿、事件和任务状态；不复制美术或捆绑组件。 |
| [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot/tree/6b0cead52530ad6038aacc5dfacc66ce12f35926)       | `6b0cead5`，2026-11-10 | [Apache-2.0](https://github.com/milind-soni/OpenMausBot/blob/6b0cead52530ad6038aacc5dfacc66ce12f35926/LICENSE)。参考阅读位置和错误恢复入口。                                  |
| [BotHarness/DeepSeekBot（Tobs）](https://github.com/BotHarness/DeepSeekBot/tree/1a6ae707449a864193a02757f1ffe261cb36fd8a) | `1a6ae707`，2026-11-10 | [MIT](https://github.com/BotHarness/DeepSeekBot/blob/1a6ae707449a864193a02757f1ffe261cb36fd8a/LICENSE)。参考增量 Markdown 与可见窗口，作为补充对照。                          |

用户写的是 `openmuasebot`。GitHub 精确名称查询没有匹配；最接近且有完整桌面 Bot 实现的是 **OpenMausBot**，本文将它作为候选参考，未把名称推断写成已确认事实。另一个近名 [shamodorelit/Openmousebot](https://github.com/shamodorelit/Openmousebot/tree/ae3c0ea03f2a1d6338f982ac8e560a24c6eb6a08) 在该提交只有 `SKILL.md`，不具备本次所需的聊天产品源码。

## 1. 草稿应包括附件，清除时机跟随消息接纳

**上游事实。** dsh-bot 把文字与引用放在浏览器存储，附件放在 IndexedDB；内存保留当前会话的快速副本。读取附件期间用户已经添加新文件时，保留较新的内存值。发送失败保留编辑内容，成功后再清空。[草稿存储](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/ui/src/client/state/drafts.ts#L1-L150)、[发送接纳处理](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/ui/src/client/views/chat/Composer.tsx#L154-L188)。

**本地已确认差异。** `app/src/lib/chat/ui-memory.ts` 保存文字和滚动状态，但 `draftFiles` 只是 `Map<string, File[]>`；文件头明确说明刷新后附件消失。`composer.tsx` 的附件暂存与恢复也只通过 `stashDraftFiles` / `takeDraftFiles`。因此同一条草稿的文字能够回来，附件却需要重新选择；桌面离线页或页面重载会碰到这一边界。

**建议采用，优先级 P1。** 沿现有草稿入口增加本机附件持久化，继续使用同一对话身份和发送接纳逻辑。项目已有 `wallpaper-store.ts` 的原生 IndexedDB 使用经验，无需增加数据库依赖。先决定账号隔离、实际文件数量/大小上限及发送成功后的清除时机，避免把“暂存附件”变成永久文件库。

**实施成本：中。** 涉及异步恢复、用户边恢复边编辑和清除竞态。完成标准是“选择文件与输入文字 → 重载 → 两者仍对应原会话；发送失败保留，接纳成功清除；切账号不串草稿”。dsh-bot 的逐文件上传并不提供整体发送原子性，这段不应直接照搬。

## 2. 阅读位置由用户动作决定，消息身份不能随历史插入变化

**上游事实。** OpenMausBot 区分用户向上滚动与内容增长造成的离底变化；加载更早消息前记录当前高度，提交后补偿滚动位置；状态带会话身份，切换会话丢弃旧补偿。早期上游模板 的分页边界保存行 ID，而非只保存数组下标，避免前缀恢复使同一行换父节点后重新播放出现动画。[OpenMausBot 视口](https://github.com/milind-soni/OpenMausBot/blob/6b0cead52530ad6038aacc5dfacc66ce12f35926/src/hooks/use-transcript-viewport.ts#L50-L139)、[早期上游模板 历史分页](https://github.com/ChisaAlter/ChisaBot/blob/main/docs/THIRD_PARTY_NOTICES.md)。

**本地对应。** `chat-transcript.tsx`、`virtual-transcript.tsx`、`send-scroll.ts` 和 `ui-memory.ts` 已提供虚拟列表、发送定位、消息锚点及恢复状态。0.1.142 的七项滚动验收已有通过证据。

**建议采用为检查标准，保留现有实现。** 审查“向上阅读时新字/图片/卡片到达”“前插历史”“切会话后旧异步回调抵达”是否都由同一会话和消息身份约束；只修能证明的断点。不要把已有 virtua 换成上游自制窗口，也不要因普通布局增长强行重启跟随。

**实施成本：低至中，取决于本地发现。** 最关键的直接观察是第一条可见消息及其顶边偏移，而不是只看 `scrollTop` 或平均帧率。

## 3. 流式解析只处理变动尾部，已经完成的块保持稳定

**上游事实。** Tobs 的 `createMarkdownBlocks()` 缓存上一版文字和块，追加时保留前缀、重切末尾，并对未变化块复用对象；它把“除末尾两块”作为一个保留条件。其 Web 时间线另保存已测量高度，把远离视口的组表示为同高度间隔。[Markdown 分块](https://github.com/BotHarness/DeepSeekBot/blob/1a6ae707449a864193a02757f1ffe261cb36fd8a/apps/mobile/src/ui/markdown-blocks.ts#L112-L140)、[时间线窗口](https://github.com/BotHarness/DeepSeekBot/blob/1a6ae707449a864193a02757f1ffe261cb36fd8a/packages/client/src/client/timeline-window.ts#L6-L35)。

**本地对应。** `SmoothStreamdown` 已组合 Streamdown 块渲染、`createIncrementalBlockParser`、Markdown 缓存和按帧文字显示。`incremental-blocks.ts` 已明确记录“最后两块之外永远稳定”不成立，并处理链接定义、列表、HTML 与围栏的跨块影响。

**建议保留 ChisaBot 的正确性边界，不移植上游解析器。** 若诊断发现长回答仍反复解析全部前缀，应沿现有 parser/cache 的实际调用链修复启停或引用稳定性。Tobs 是性能机制的对照，不能据它的算法更短就替换当前实现。也不新增另一种 Markdown 语法或第二层虚拟列表。

**实施成本：低至中。** 后续需要区分文本接收频率、React 提交频率、实际重解析的字符数及最终渲染一致性；源码中的缓存不能单独证明用户已经更流畅。

## 4. 重连恢复同一会话，正常恢复不变成一串报错

**上游事实。** dsh-bot 用共享 `PodEvents` 持有 SSE 订阅；最后一个订阅者离开后延迟关闭，避免页面切换反复断连。正常续连利用 `Last-Event-ID`；主动新建连接或宿主序号回退时发出 `resync`；重新回到前台时恢复已关闭的连接。[事件连接](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/ui/src/client/api/events.ts#L8-L134)。

**本地对应。** `use-conversation-sync.ts`、`join-backoff.ts`、`connection-drop.ts` 与 `thread-sync.ts` 已有重接、增量合并和进展驱动退避；当前服务使用 DSH 的运行与事件身份，不等同于上游的房间 SSE。

**建议采用连接所有权和恢复语义，拒绝照搬另一套重试器。** 保持正常接纳、正在重连、已停止、历史暂不可读和操作结果未知的区别；恢复沿原运行身份进行，不重发用户指令。只有现有代码确实在路由切换或前台恢复时制造重复连接，才调整该连接拥有者。

**实施成本：中。** 真实验收应分别观察连接数量、回补后的消息身份、停止状态和用户可见提示。把 HTTP 重试次数降下来并不自动说明恢复正确。

## 5. 错误、部分完成和等待人处理各有合适入口

**上游事实。** OpenMausBot 的错误行先呈现简短原因，技术细节折叠；按认证、额度、权限等情况提供具体恢复入口。部分完成使用单独提示，重试按钮仅在调用方提供可重试动作时出现。dsh-bot 的任务卡底部按当前阶段显示“在做什么、等什么、失败原因或更新时间”，外部未交付另行展示。[错误行](https://github.com/milind-soni/OpenMausBot/blob/6b0cead52530ad6038aacc5dfacc66ce12f35926/src/components/ChatView.tsx#L178-L295)、[部分完成](https://github.com/milind-soni/OpenMausBot/blob/6b0cead52530ad6038aacc5dfacc66ce12f35926/src/components/PartlyDoneRow.tsx)、[任务卡](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/ui/src/client/views/chat/TaskCardItem.tsx#L16-L73)。

**本地对应。** `friendly-error.ts`、聊天错误卡、未知结果核对、`tasks-rail-card.tsx` 和任务详情已分别承担这些职责，且用户已选定任务卡形式。

**建议采用具体状态到具体动作的映射。** 优先消除实际出现的重复错误、过期按钮和任务已完成但界面仍忙；保留原位反馈及卡片尺寸。未知外部效果仍进入已有核对流程，不能把上游的通用“重试”按钮当成重新执行外部动作的授权。不要为了显得安静而隐藏真实失败。

**实施成本：低至中。** 一次状态改变后，聊天、任务卡与任务详情应展示一致事实；其他设备已处理的审批应及时撤下，用户输入不应因失败而丢失。

## 本轮建议顺序

1. 先修各审查线确认的消息身份、错误状态和异步操作竞态；这些直接影响用户是否敢连续操作。
2. 补未发送附件跨重载恢复，复用现有草稿与本机存储入口。
3. 对仍有证据的长回复/长历史成本做局部优化，保留 Streamdown 与 virtua。
4. 以宽窄窗、暗色、快速切换、失败后继续及长历史的实际操作确认体验；产品实现完成后再准备和执行这些验证。

本次浏览工具没有可用的搜索提供方，页面打开能力也不可用；最终来源均通过 GitHub 官方仓库 API 读取固定提交的真实源码与元数据。下载的只读源码片段位于忽略目录 `work/upstream-smooth-20261111/`。这份对照不包含性能测量结果，也不把上游截图或 README 宣传作为 ChisaBot 的验收证据。
