# 个人助理生产计划：OpenBot 与 DSH Bot 的可用经验

核对日期：2026-11-08（Asia/Shanghai）。本笔记核对官方仓库文档与源码，为 [ChisaBot 的 DSH 实施记录](../pipeline-runs/20261107-dsh-migration.md)之后的生产计划提供依据。这里的“源码可见”不代表已运行上游产品或完成其部署验收。

## 判断：保留 ChisaBot 已有能力，补齐任务与交付的最后一段

**建议继续使用 ChisaBot 的账号、界面、工具、审批、记忆和业务数据库，DSH 维持模型执行内核。** 借鉴上游的任务触发、交付状态、可审阅记忆和恢复边界；不把另一个 Bot 产品整体装入服务器，也不重新引入 CopilotKit 执行依赖。

这几个项目并没有提供一种“装上即可靠”的生产捷径。它们最有价值的共同点是：把用户意图、一次执行、对外交付和需要人处理的问题分开保存。ChisaBot 的实现与已有验收应先映射到这些契约，再修具体缺口。未配置邮箱、日历或通知通道，应作为实例开通项，不能据此把已有功能判为未实现。

## 1. 项目身份与本次固定版本

| 项目                               | 固定源码                                                                                                                                                             | 这次使用的范围                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **CopilotKit/OpenBot**             | [`e49a0a9fdfe13ea3062bd2c3dc427e337889cf5d`](https://github.com/CopilotKit/OpenBot/tree/e49a0a9fdfe13ea3062bd2c3dc427e337889cf5d)，提交时间 2026-11-08 08:29 UTC     | ChisaBot 的原上游；核对外部交付、调度和部署合同。仓库 MIT；其部署仍连接 CopilotKit Intelligence，不能作为本次去除该依赖后的直接部署模板。 |
| **aibot-fans/dsh-bot**             | [`fa15588fb62b7605d00c63bf23fa55b1ac54bb70`](https://github.com/aibot-fans/dsh-bot/tree/fa15588fb62b7605d00c63bf23fa55b1ac54bb70)，提交时间 2026-11-05 03:55 UTC     | 名称直接对应 `dsh-bot` 的社区 DSH 插件；主入口 Super-agent，把工作组织为任务与群。代码 Apache-2.0，资产和部分组件另有许可。               |
| **BotHarness/DeepSeekBot（Tobs）** | [`e421ab46416475bda9738ba81ea5df669d4d8749`](https://github.com/BotHarness/DeepSeekBot/tree/e421ab46416475bda9738ba81ea5df669d4d8749)，提交时间 2026-11-08 08:20 UTC | 独立社区产品，不能与上一行混称；核对外部发件箱、记忆可见性和备份恢复，仓库 MIT。                                                          |
| **DeepSeek Harness**               | [`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159)，`0.2.2-rc.1`            | 当前 ChisaBot 已固定的内核；本轮远端 HEAD 仍为该提交。沿用已有适配和升级检查。                                                            |

`deepseek-ai/dsh-bot` 在本轮公共 GitHub 查询中不存在。另一个近名项目 `Fei2411/DeepSeek-Bot` 当前重定向为 [Fei2411/DS-Bot](https://github.com/Fei2411/DS-Bot/tree/6559c9e7c4ef71c292e6ac50f690031133536fe0)，Apache-2.0；这里只核实身份，不把它作为本笔记的功能证据。DSH Bot 社区项目均不应标成 DeepSeek 官方 Bot 产品。

## 2. 先区分“任务做完”和“结果送到了”

**OpenBot 源码事实。** `deliveryOutbox` 保存完整交付目标、文本、唯一 dedupe key 和状态；路由在发送前再次检查会话权限与绑定。进程恢复遇到已经进入发送阶段的记录时标为 `unknown`，没有回执不当成普通失败重发。推送接纳与最终回执也是不同阶段。来源：[交付表](https://github.com/CopilotKit/OpenBot/blob/e49a0a9fdfe13ea3062bd2c3dc427e337889cf5d/server/src/db/schema/delivery.ts)、[发送与恢复逻辑](https://github.com/CopilotKit/OpenBot/blob/e49a0a9fdfe13ea3062bd2c3dc427e337889cf5d/server/src/delivery/router.ts#L530-L690)。

**Tobs 文档与源码一致的部分。** ADR-0039 将结果未知交给人工核对，要求重试复用原交付身份；实际 `outbound.ts` 有独立 intent、attempt 和 grant 状态，超时工具将无法判定的结果归类为 unknown。来源：[外部 Outbox 决策](https://github.com/BotHarness/DeepSeekBot/blob/e421ab46416475bda9738ba81ea5df669d4d8749/docs/adr/0039-external-outbox-is-idempotent-but-not-exactly-once.md)、[发送实现](https://github.com/BotHarness/DeepSeekBot/blob/e421ab46416475bda9738ba81ea5df669d4d8749/packages/core/src/messaging/outbound.ts)、[发送超时归属](https://github.com/BotHarness/DeepSeekBot/blob/e421ab46416475bda9738ba81ea5df669d4d8749/packages/core/src/messaging/bounded-delivery.ts)。

**ChisaBot 采用决定：** 保留新建的 IM 持久交付与未知结果处理，检查邮件、通知 Webhook、任务完成通知是否使用同样规则。各通道可保留自己的适配器，但在产品层应能回答：执行完成了吗、要送给谁、发送是否被接纳、最终结果是什么、谁需要处理。不能因聊天气泡已经出现就把外部通知标成成功。

**生产验收：** 一个真实授权目标能够收到预期内容；断开客户端后仍能交付；发送前失败可重试，发送后丢回执保持待核对；重复回执不产生第二次发送。对没有最终送达回执的通道，界面应只显示其实际可证明的“平台已接纳”。

## 3. 定时只是触发，交互聊天必须有自己的执行容量

**dsh-bot 源码事实。** `TriggerService` 处理时间、任务阶段和网页变化；网页第一次采样、无变化和读取失败都不会唤醒模型。任务结束时关闭触发器，暂停任务不被普通定时触发自动恢复。产生任务运行与推进触发水位在同一事务中完成。来源：[触发器实现](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/runtime/src/engine/triggers.ts#L208-L360)。

其 `Dispatcher` 给聊天和后台任务分配不同并发通道；先持久写入消息和待执行效果，再向 DSH 投递，历史去重后等待 flush。一个可借鉴的产品结果是：后台工作很多时，用户问一句进度仍能被接纳。来源：[投递与容量控制](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/runtime/src/effects/delivery.ts)。

**必须避开的边界。** dsh-bot 的内部投递允许持续退避重试；`DeliveryLedger` 在缺少持久接口时允许退回不查重，并用 `exactlyOnce` 命名健康字段。这是内部会话投递能力，不能搬成任意外部 API 的恰好一次承诺。ChisaBot 已固定支持 flush 的 DSH，应将必要能力缺失视为部署不就绪，而不是悄悄降低可靠性。来源：[去重账本](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/runtime/src/effects/ledger.ts)、[健康报告](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/runtime/src/effects/health.ts)。

**ChisaBot 采用决定：** 保留已有 schedules、任务中心和 durable runner，明确一个任务的业务所有者与触发来源，禁止再增加平行调度系统。任务的启停、过期补跑和运行预算必须显示在同一任务入口。若现有容量控制不能保护交互聊天，才在既有调度层补分配策略。

**生产验收：** 同时存在长后台任务时，发送消息、询问进度和停止仍可用；同一到期事件重放不重复建立执行；暂停任务在重启后保持暂停；未变化的信息源不会为“巡检”反复消耗模型。不要把 dsh-bot 的所有触发类型都设为首发必做项。

## 4. 记忆应可查看、纠正和溯源，存储形式不必照搬

**dsh-bot 源码事实。** 记忆服务记录 source、sourceRef 和 confidence，区分用户明确给出的记忆与自动提取；合并逻辑保护已经被用户编辑的条目。它的价值是让误记能定位来源、纠正后不被低质量提取立即覆盖。来源：[记忆写入与合并](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/runtime/src/memory/service.ts#L120-L160)、[提取入口](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/runtime/src/memory/extract.ts#L110-L154)。

**Tobs 当前设计事实。** 记忆是可直接查看的 Git 工作树；ADR-0068 明确替代旧的 accepted-commit 入库门槛。Git 历史和应用的可信操作归属是两件事，路径逃逸检查及用户编辑并发检查仍由服务负责。来源：[当前记忆权威](https://github.com/BotHarness/DeepSeekBot/blob/e421ab46416475bda9738ba81ea5df669d4d8749/docs/adr/0068-git-working-tree-is-current-memory.md)。不能把较旧 ADR-0047 中已经被替代的门槛作为其现行实现。

**ChisaBot 采用决定：** 沿用现有 PostgreSQL 记忆、设置页和工具，不为了借鉴引入 Git 双重权威。优先检查“明确记住→另开对话能用→纠正→遗忘”的完整路径，以及来源、更新时间和作用范围是否足以解释回答。用户要求遗忘的事实不应被旧摘要或后台提取重新写入。

**生产验收：** 用一组用户可控的偏好、人物和项目事实做跨会话读取、冲突纠正和删除验证；检查后续真实模型请求使用的是当前授权记忆。记忆条数、搜索命中率和 Git commit 数都不能替代这些结果。

## 5. 健康检查要暴露堵在哪里，恢复不能静默重放外部动作

**dsh-bot 可复用部分。** 健康报告包括各效果队列的待处理数、连续失败数、最早等待时间，以及尚未解决与最近恢复的问题；通知中心还按任务合并重复等待提醒并支持勿扰。比“进程存活”更接近日常助理需要的状态。来源：[队列健康](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/runtime/src/effects/health.ts)、[通知合并与勿扰](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/runtime/src/notify/service.ts)。

**备份要区分设计与已实现。** Tobs ADR-0042 描述协调数据库、记忆、附件与 DSH Session 的恢复契约，但本次固定源码的备份预览、manifest 和恢复回执仍把 Session 标记为 `unsupported`，原因为缺少便携 Session adapter。其已实现的 staging 校验和原子激活值得参考；不能据 ADR 宣称它已完整恢复 DSH 执行历史。来源：[备份设计](https://github.com/BotHarness/DeepSeekBot/blob/e421ab46416475bda9738ba81ea5df669d4d8749/docs/adr/0042-profile-backup-coordinates-database-files-and-dsh-sessions.md)、[实际 manifest 与 restore](https://github.com/BotHarness/DeepSeekBot/blob/e421ab46416475bda9738ba81ea5df669d4d8749/packages/core/src/portability/package.ts#L495-L515)、[恢复激活入口](https://github.com/BotHarness/DeepSeekBot/blob/e421ab46416475bda9738ba81ea5df669d4d8749/packages/core/src/bots/cli-profile-backup.ts)。

dsh-bot 的自动备份源码针对 SQLite 数据库文件，不能代替工作文件、浏览器登录与 DSH Session 的一致备份。来源：[SQLite 备份](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/packages/store/src/backup.ts)。

**ChisaBot 采用决定：** 保留已验收的数据库、DSH 卷、workspace、profiles 与兼容 reader 备份方案，补生产所需的计划备份、可用性告警和定期独立恢复证据。健康页优先展示模型请求、任务执行、待审批、待交付、未知结果、磁盘及最近可恢复备份；每种异常给出实际处理入口。恢复时未知外部效果继续保持待核对，不转换成普通待发送。

**生产验收：** 从一个真实备份恢复到隔离环境，读取新旧会话和文件、检查待审批与未交付项，再完成下一次授权对话。此要求可复用已有 DSH 回滚证据，只补备份代际、异机依赖或计划备份新增的缺口。

## 6. 直接采用、谨慎改写和本轮不引入

| 选择                 | 对 ChisaBot 的决定                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 直接采用行为契约     | 持久交付状态与回执、未知效果不盲重发、暂停语义、任务与交付分开、交互容量、来源可追溯记忆、队列等待时间和失败可见。                                                                                                     |
| 优先沿用已有实现     | DSH Host、Conversation、审批/工具账本、持久 IM 发件箱、任务中心、schedules、记忆、Vault、账号登录和 React UI；由本地能力映射决定修补点。                                                                               |
| 不复制上游全部架构   | OpenBot 的 Intelligence/worker 部署前提不适用于当前 DSH 方案；Tobs 的 Git 记忆、移动推送与 Bot 市场不作为生产首发前提；dsh-bot 的群协作布局不替换用户已选定的 ChisaBot 界面。                                          |
| 不把上游自动化当证明 | README 的自动自治、自我优化和“每天免费”服务额度不成为 ChisaBot 的生产承诺。依赖的第三方服务、任务类型和外部效果仍需各自真实证据。                                                                                      |
| 许可按组件处理       | OpenBot 与 Tobs 根许可证为 MIT；dsh-bot 代码 Apache-2.0，但鲸鱼娘图标/含图截图为 CC BY-NC-SA 4.0，打包的 `aibot-x-post` 非开源，独立电脑助手为 AGPL-3.0。借鉴设计与直接复制这些资产/组件是不同动作；本计划不引入后者。 |

许可来源：[OpenBot LICENSE](https://github.com/CopilotKit/OpenBot/blob/e49a0a9fdfe13ea3062bd2c3dc427e337889cf5d/LICENSE)、[Tobs LICENSE](https://github.com/BotHarness/DeepSeekBot/blob/e421ab46416475bda9738ba81ea5df669d4d8749/LICENSE)、[dsh-bot 的分项许可](https://github.com/aibot-fans/dsh-bot/blob/fa15588fb62b7605d00c63bf23fa55b1ac54bb70/README.md#许可)。OpenBot 的身份、加密与 TLS 部署要求可作为原则参照，服务依赖需按当前 ChisaBot 保持：[OpenBot 部署文档](https://github.com/CopilotKit/OpenBot/blob/e49a0a9fdfe13ea3062bd2c3dc427e337889cf5d/docs/deployment.md)。

## 7. 交给生产计划的五项决策

1. **执行基础继续用现有 DSH，不再换内核。** 先承认已通过的执行、恢复与界面证据，关注用户任务是否闭环。
2. **优先补齐既有邮件/通知通道的持久交付合同。** 一个首选真实通知渠道即可开始生产个人使用；无需同时开通所有 IM。
3. **统一任务状态与失败入口，保留现有调度器。** “定时到点”“任务完成”“发送被接纳”“人已处理”要分别可见。
4. **记忆和信息源先验证可信度与新鲜度。** 重点是纠正、遗忘、过期数据提示和连接故障，而不是新增记忆库。
5. **发布与恢复以完整实例为单位。** 版本、源码、数据库、DSH Session、文件和必要凭据恢复路径须可对应；按实际支持的边界展示恢复就绪状态。

本轮没有运行上游产品、安装插件或对生产实例发消息。源码快照与 GitHub 查询元数据保存在本地 `work/upstream-assistant-research/`，公开结论以上述固定提交链接为可追溯依据。
