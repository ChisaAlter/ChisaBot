# DSH 主内核迁移实施记录

设计：[完整迁移方案](../dsh-kernel-migration.md)。实施授权：2026-11-07；本记录更新至 2026-11-08，交接版 **R5**。

## 当前交付状态

**服务端已于 2026-11-08 14:52（Asia/Shanghai）上线 DSH；Android 已覆盖安装同一 React Web 前端的手机布局，关键实机路径验收通过。** 发布镜像为 `local/chisabot:dsh-release-20261108`，网页入口为 `assets/index-Bgiwo-mG.js`。随后按用户要求清理历史测试身份，当前生产只保留 Chisa 和一个 DSH Host。原历史读取、生产两轮真实模型与工具、隔离环境升级与兼容回滚已验证。

当前工作树基线为 `9a00ed625f1e3508fa66da2ea036f573db0c4f92`、包版本 `0.1.137`，发布包含未提交的聊天修复与迁移代码；不能把基线提交视为完整发布源码身份。部署批次保留实际源码、镜像信息和恢复材料；后续 Android 改动独立归档，不改变已发布服务端镜像。

| 工作包            | 当前实现与证据                                                                                                                         | 收尾责任                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P0 Host / 模型    | 固定 DSH `0.2.2-rc.1`；稳定路由、模型代理、长历史压缩和账号 Host 已发布；真实模型生产两轮完成                                          | Android 新壳继续复用已发布会话接口                   |
| P1/P2 会话 / 工具 | commands、binding、journal、操作账本、审批恢复、Stop / 编辑 fence、技能事务、checkpoint 和 rich inbox 已发布；故障及富补话实际场景通过 | 保留未知效果需实际回执核对的业务边界                 |
| P3 前端           | 自有 React 聊天已发布；富补话、审批多状态/竞争、编辑重生成、聊天和管理预览通过；Android 实机同一手机布局、系统文件与本地导出通过       | 手机当前为隔离验收环境；正式使用由用户登录生产账号   |
| P4 后台           | 定时、worker、任务中心、IM、handoff 都接同一运行器；保存执行身份和真实交付状态，未知副作用暂停                                         | 真实第三方 IM 验收由用户明确暂缓；不阻塞本轮其余收尾 |
| P5 历史 / 数据    | 导入、原始元数据归档、编辑分支、0063/0064 迁移完成；生产切换前后历史、附件及待决状态核对通过                                           | 原数据继续保留，验证 Bot 的新增记录单独归属          |
| P6 部署           | 完整镜像、账号独立域、配套备份和兼容回滚通过；按用户要求清理后生产仅 Chisa 的一个 Host，就绪、timer 正常，公网入口恢复                 | 同镜像安全标签只作恢复材料，不冒充旧代码回滚证据     |
| P7 依赖退休       | 生产源码无 CopilotKit 导入，发布镜像物理依赖目录无 CopilotKit；保留自有 builtin 兼容及 Intelligence 显式迁移入口                       | 开发测试依赖与生产执行依赖分开记录                   |

本目标 CI 累计触发 **0 次**、未通过 **0 次**，未提交或推送 Git。设备上原本没有 ChisaBot，先新装 `0.1.137` / versionCode `319`，随后以 `install -r` 升级为 WebView 主界面并保留应用数据。旧 Compose 验收仅为兼容证据；新主界面已有独立实机截图、DOM 和交互证据。手机当前连接隔离验收服务，未替用户登录生产账号。

## 生产切换结果

切换时先关闭接纳、排空旧执行并备份同批数据库和文件，再启动合格镜像、开通独立账号运行时、核对清单，完成真实冒烟后恢复公网。九个 Host 均为 ready，无 preparing/updateRequired；公开登录页返回 200，匿名受保护 API 返回 401。

切换前后原历史消息数、附件、技能、审批、暂停项及后台任务状态一致。开放后的新增内容来自一个验证 Bot、两轮已结算请求和必要频道；既有 5 条暂停补话、44 项任务中心状态、3 个完成 worker、26 条调度运行记录保留。原历史中 39 条消息经真实读取验证。生产真实两轮包含一次 `page_list` 回执，第二轮保留上下文，执行位于该账号独立 Host。

默认模型改为已验证的 `devin/swe-2`，保留原 endpoint、协议和凭据；已软删除 Bot 的覆盖值未变。备份和恢复脚本保留在私有部署批次。证据见 E16；最初生产冒烟因复用一次性签名 nonce 返回 401，修正为每请求签名后通过，未放松认证。

公开恢复日志中一次手动 reconcile 返回 73，原因是与正在运行的账号 timer 争用排他锁。随后只读检查确认 timer 连续成功，均为九个 ready、零 preparing / updateRequired；未关闭锁或重复切换生产。

## 已落实的运行规则

### 单账号整理与当前个人助理配置

用户明确要求只保留 Chisa 后，先备份应用数据库、登录数据库、运行时卷、工作区和浏览器配置，再删除其余八个历史测试身份及其八个 Bot、412 条对话、411 个频道和关联业务数据。四个可登录测试账号及会话同时撤销；八套多余 DSH 容器、卷、网络及连接文件已移除，测试 Bot 的浏览器通过既有清理接口移除。Chisa 的 426 条对话、87 个聊天文件与各所属表记录数保持一致；39 条原历史经 API 实际读取。

数据库安全审计按既有不可改写规则保留，删除账户不改写审计。一个同时被 Chisa 引用的工作区文件保留。首次删除触发审计保护时整个事务回滚，排除审计表后业务删除事务成功。维护已经解除，账号 timer 返回一个 ready、零 preparing / updateRequired，DSH 健康检查通过。恢复材料在本次私有单账号整理备份批次。

当前 Chisa 有七条记忆笔记；日历、邮箱、通知 Webhook 均未连接，没有 IM、推送设备或外部交付绑定。唯一现存定时任务保持 paused / waiting，未擅自恢复。日常对话与工具辅助可以使用；外部提醒送达、真实个人信息接入及连续日用效果仍需在相应入口完成配置与验证。内核迁移成功不等于这些个人助理流程已经开通。

### 会话与执行合同

- DSH 拥有模型/工具循环、执行历史与压缩；ChisaBot 保留账号、Bot、业务权限、长期记忆、任务及交付。
- HTTP 接纳回执来自持久 command。回执丢失或正文截断按同一 ID 查询；接纳之后的派发失败由恢复处理，不误报成未发送，也不重新创建请求。
- 执行 lease 与观察连接分开。API 重启重新接管现有 Host；已完成结果从账本读取。Host 退出后，对未知外部效果先暂停核对，不自动换 toolCallId 重做。
- 审批、技能答复、Stop 和编辑版本由服务端约束；页面关闭不把执行责任转给浏览器。handoff 的 scratch thread/run 和原 initiator 持久保存，恢复不创建另一次执行。
- 正式投影只接受已经 checkpoint 的 DSH 源前缀；实时 assistant 帧用于临时显示。源尾部丢失时不把未落盘序号冒充已提交事实。
- 多账号采用独立容器、私有卷和独立网络；未准备好的账号在保存 command 前返回准备中，正常 Bot 列表仍可读取。托管进程用于单账号环境，已有 managed Session 不会被静默转移或丢弃。
- `/api/copilotkit/...` 名称作为原生与远程 AG-UI 的兼容入口保留，不表示继续依赖 CopilotKit 包。
- 部署维护暂停新执行，已有执行可以结算和被停止。更新与回滚保留当前数据库、账号会话卷和工具账本；不自动导入旧备份倒退外部效果记录。
- 普通文字、仅附件和技能补话都保存在现有服务端 inbox 中；Stop 后刷新或换端仍是暂停项，“发送这条”仅派发指定项。技能权限及附件引用由服务端校验。
- 回滚还检查产品 `conversationReader:1`，避免只有相同 DSH 日志版本、却读不了富补话的旧预览镜像被当成兼容版本。

## 已证明的根因与修复

| 实际故障                                                     | 根因与改动                                                                                                                                                                   | 对应证据                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 32k 首轮可答、后续轮压缩失败                                 | 每轮新逻辑模型 ID 触发 DSH 模型切换预检。相同 Session/model 改用稳定路由；真正切模型仍走原检查。此前按字符数推断“88 个工具把窗口占满”的结论已撤回                            | E01；原 32k、完整工具集三轮通过，未靠扩大窗口规避                           |
| 免密钥部署报缺 key，Anthropic 路径重复 `/v1`                 | pi-ai 需要调用凭据且与现有版本化 base 语义不同。采用本轮 capability 代理，真实目标只发送其配置要求的认证头，并规范目标路径                                                   | E02；OpenAI / Anthropic HTTP 与实际 Host 协议检查                           |
| 真模型推理流被 AG-UI 拒收                                    | `REASONING_START/END` 缺 `messageId`，推理角色也不符固定 schema。投影和收尾器按身份生成完整生命周期，保留推理内容                                                            | E03、E12；真实 parser 通过，实际模型产品链路随后完成                        |
| 事件已结算后，迟到实时帧再次拼接完整工具 JSON                | checkpoint 的异步边界暴露 durable-before-live 次序；旧 live start 把同一调用当作新 attempt，产生重复参数。修复使用上游 startedAfterSeq 与持久事件确定 attempt 身份           | E04；真实 parser 顺序测试及原 card-only 场景均通过                          |
| API 重启后半句冻结或重复执行                                 | 旧 wire stream 未闭合，历史保护又把本轮半句当作不可变旧消息。恢复按源水位闭合旧流并原位替换本轮消息                                                                          | E05；API SIGKILL 后模型请求仍为一次，只有一条完整回答                       |
| 工具效果发生但回执丢失后，模型再次尝试                       | 同调用去重不足以限制模型改用新调用 ID。未知效果现在产生持久 `operation_unknown` 暂停，工具账本保留待核对事实                                                                 | E05；实际子进程崩溃后效果一次、无新推理重做                                 |
| 后台恢复丢失或重新执行已完成任务                             | worker、任务中心和 handoff 原先重建执行身份；IM 的模型结果与外发之间缺持久交接。现在固定执行身份、保存输出/回执，模糊外发结果暂停                                            | E06、E07                                                                    |
| 文件已交付却因最后空文本报错                                 | DSH 的 `EMPTY_RESPONSE` 没有区分本轮有效交付。仅对本轮验证过的文件或 `render_ui` 成功结果承认完成，旧产物和真正空回答仍报错                                                  | E08 文件下载及 E04 卡片精确参数/空回答负例通过                              |
| 重建容器后旧 PID 阻止启动                                    | 数字 PID 不能证明持久目录所有权。Linux 改用 flock，Windows 使用命名管道；PID 仅作诊断                                                                                        | E02；两平台真实 Host 冲突/SIGKILL/重取所有权通过                            |
| 更新时残留 Hermes URL 把内核改回 Hermes                      | 更新器过去由 URL 判断是否激活旧桥。显式 DSH 部署不再走该激活路径；运行时就绪检查独立于模型告警                                                                               | E10；宿主 helper 的 `/command` PATH 故障亦已修复                            |
| 仅附件/技能补话在 Stop 后自动续发，刷新丢失                  | 富草稿此前留在前端内存，只有纯文字进服务端 inbox。现改为持久 typed message 与服务端解析的技能上下文，保留附件并仅恢复指定项                                                  | E14；两个浏览器恢复完整三项，指定附件发送后另外两项仍暂停                   |
| 小窗口长历史把摘要输出压到 1 token，切模型后摘要引用失效路由 | 固定 pi-ai 预留 4096 token，与旧 1024 headroom 不一致；原 summarizer 又选了已退休请求路由。修为匹配 headroom、明确摘要 1024 cap，并经上游公开 summarize 扩展使用当前授权模型 | E13；8k 九轮、六次摘要实际 wire cap 均 1024，兼容换模型成功、过小模型仍拒绝 |

早期“完整 UI 超时”曾实际停在 onboarding 示意输入框，未产生 command；这是验收脚本前置条件错误，已纠正。早期模型目录夹具把真实模型错误声明为 32k，后来使用真实目录参数修正；该修正与独立的 32k 稳定路由缺陷分别记录。

## 证据索引

`work/` 和 `perf/out/` 为本地忽略目录，记录地址、临时账号及执行关联信息，不随公开仓库发布。下面只给可检索的文件名与结果；不同测试组存在重叠，不累计成独立场景总数。

| 编号 | 实际环境与关键结果                                                                                                                                                                                                                                                                                                                                                     | 证据位置                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01  | 真实 Edge → 完整产品 API → Node DSH Host → 声明 32k 的受控 SSE provider，三轮路由、回答及刷新顺序一致；首个完整镜像候选同路径通过。该 provider 不按 token 上限截断输出，因此不证明完整工具集能装入 32k                                                                                                                                                                 | `work/dsh-full-32k.log`、`work/dsh-image-32k.log`；`perf/out/dsh-full-32k/`                                                                                                                                                                                                                                                                                                       |
| E02  | 固定 Host 的流式、备用模型、一次工具、重复 prompt、单 Session Stop、模型代理与真实进程所有权；Linux flock 分支通过                                                                                                                                                                                                                                                     | `runtime/dsh/tests/host.integration.test.mjs`、`runtime/dsh/tests/host-lease.test.mjs`；`work/kernel-coordination.md`、`work/dsh-lease-linux.log`                                                                                                                                                                                                                                 |
| E03  | 实际 `EventSchema` 与 `HttpAgent.runAgent` SSE parser 验证推理/正文/工具、恢复前缀及闭流修正：4 项/13 断言通过                                                                                                                                                                                                                                                         | `work/dsh-reasoning-projection.log`、`work/dsh-reasoning-types.log`                                                                                                                                                                                                                                                                                                               |
| E04  | durable 先结算、迟到 live、真实 retry 与历史 baseline 的投影顺序：7 项/20 断言通过；原实际 Host/PG card-only 场景 1 项/5 断言通过，精确 JSON、有效终态和下一轮真正空回答负例保留                                                                                                                                                                                       | `work/dsh-source-order.log`、`work/dsh-card-source-order.log`、`work/dsh-source-order-types.log`；此前失败留在 `work/dsh-card-only-accepted.log`                                                                                                                                                                                                                                  |
| E05  | 真 PostgreSQL + 真 Host + confirmations；最终接纳/维护/技能审计/未知效果/Host 审批恢复批次通过。另有 API SIGKILL 接回存活 Host                                                                                                                                                                                                                                         | `work/dsh-final-contracts.log`（9 项/137 断言，含两项导入）、`work/dsh-recovery-batch.log`                                                                                                                                                                                                                                                                                        |
| E06  | 无浏览器的定时、worker、任务中心通过；IM 使用真实服务与 OneBot 协议 fixture，重复输入、重建服务、回执丢失与已存输出恢复通过                                                                                                                                                                                                                                            | `work/dsh-background-keyless.log`；`work/dsh-boundary-im-final.log` 前一批 IM 两项/27 断言；该文件后一批含旧文件交付失败，已由 E08 修复                                                                                                                                                                                                                                           |
| E07  | 真 Host/PG 的 mounted handoff、Host 重启审批、已提交结果丢回执、队列重建通过；过期存储断言的审批续执行一次；Stop 后不复活。Team Bot 与设备 local-agent 协议 peer 路径通过                                                                                                                                                                                              | `work/dsh-actor-recovery.log`、`work/dsh-actor-late-approval.log`、`work/dsh-actor-stop.log`、`work/dsh-actor-paths.log`、`work/dsh-actor-device.log`                                                                                                                                                                                                                             |
| E08  | 实际图片字节进入 provider；编辑立即封住旧批准并建立新 Session；外部 AG-UI 原接口 run/connect/运行中 Stop 通过。真实文件保存/下载、跨账号 404、下一次真正空回答仍失败通过                                                                                                                                                                                               | `work/dsh-boundary-im-final.log` 后一批的三个通过项；`work/dsh-file-download-final.log`（1 项/8 断言）；`work/history-boundaries-coordination.md`                                                                                                                                                                                                                                 |
| E09  | 最终前端构建 + 受控 HTTP + Edge：宽 1280、窄 420、暗色，气泡外正文/自动文档卡/结束 slack 与 spacer 均 0；七滚动场景通过；接纳失败与未知效果刷新保持                                                                                                                                                                                                                    | `perf/out/dsh-ui-final/results.json`；`work/chat-ui-scroll-*.log`、`work/chat-ui-unknown-browser.log`、`work/chat-ui-contrast.log`、`work/chat-ui-coordination.md`                                                                                                                                                                                                                |
| E10  | 首个完整镜像非 root 运行；托管会话与 PG 备份、克隆恢复健康通过。账号独立容器实际隔离、热开通、跨账号拒绝、同时 Stop、四账号快照、兼容镜像替换保留 Session/新对话通过                                                                                                                                                                                                   | `work/dsh-candidate-backup.log`、`work/dsh-restore-check.log`、`work/account-isolation-coordination.md`、`work/dsh-deploy-status.md`；实际账号替换不等于完整回滚矩阵                                                                                                                                                                                                              |
| E11  | 源日志 flush / 未 flush 两种真实 Host SIGKILL：已提交前缀不变，超前游标拒绝，缺失/落后投影无模型工具重跑重建，效果各一次。Windows 与 Linux 均通过                                                                                                                                                                                                                      | `work/dsh-a26-linux.log`（2 项/36 断言）、`runtime/dsh/tests/source-durability.test.ts`、`work/kernel-coordination.md`                                                                                                                                                                                                                                                            |
| E12  | 真实上游模型经 Anthropic 通道运行完整产品：两轮完成，首轮实际 `page_list` / `memory_log` 回执，第二轮记住上下文；Edge 重开截图已检查。单次接纳 211.85/398.67 ms，总耗时 5.08/5.28 s                                                                                                                                                                                    | `work/dsh-live-product-final.log`、`work/dsh-live-product.json`、`perf/out/dsh-live-product/after.png`；这是两次观测，不是 P95 性能结论                                                                                                                                                                                                                                           |
| E13  | 真 Host + 受控摘要 provider：声明 8192 窗口、2048 普通输出，九轮、六次摘要实际 cap 1024；未完成事项/附件引用保留，显示原文完整，兼容模型续跑成功，4096 模型切换拒绝且无新请求                                                                                                                                                                                          | `work/dsh-a01-linux.log`（1 项/84 断言）、`work/kernel-coordination.md`；验证摘要机制，不代表真实模型摘要语义质量，也不认证 83/88 工具均可装入 32k                                                                                                                                                                                                                                |
| E14  | 真 Edge → 完整 API/Host + 受控模型：A11 混合队列跨浏览器/Stop/只发送指定附件，A12 allow/deny/handled/过期/两端竞争，A19 编辑/重生成，A23 聊天 HTML/JSON、管理预览及授权撤销均通过；页面错误为空                                                                                                                                                                        | `perf/out/dsh-final-acceptance/README.md` 及对应结果 JSON/截图；`work/dsh-inbox-final.log`（20 项/164 断言）、`work/chat-ui-a11-final.log`、`work/chat-ui-a12-*.log`、`work/chat-ui-a19.log`、`work/chat-ui-a23-*.log`                                                                                                                                                            |
| E15  | 实际镜像升级→新会话→旧兼容镜像回滚→返回新版；原消息/文件下载/待批/暂停项/更新后新会话均保留。合格发布镜像与兼容 overlay 回滚又验证富补话完整 payload、技能与已发送附件历史/下载；物理生产依赖无 CopilotKit                                                                                                                                                             | `work/dsh-release-check.log`、`work/dsh-final-rollout.log`、`work/dsh-qualified-release.log`、`work/dsh-product-reader-guard.log`；合格 reader 拒绝旧 rich-inbox 前预览版本                                                                                                                                                                                                       |
| E16  | 生产发布、九个独立 Host、旧历史读取和真实两轮模型/工具完成；默认模型修复保留连接合同；切换前后及开放后的数据清单可比                                                                                                                                                                                                                                                   | `work/dsh-production-apply.log`、`work/dsh-production-smoke.log`、`work/dsh-production-model-repair.log`、`work/dsh-cutover-inventory.{before,after,open}.json`、`work/dsh-release-image-build.log`；公开入口与 timer 状态另见 `work/dsh-deploy-status.md`                                                                                                                        |
| E17  | Android 新装原生 Compose 路径完成多轮/Stop/审批/文件下载/重开及跨端活动恢复；曾出现终态历史读取竞争，修复后完整后缀与执行唯一性通过。用户随后要求使用同一 Web 手机布局                                                                                                                                                                                                 | `perf/out/dsh-android/ACCEPTANCE.md`、`work/android-coordination.md`；只作为兼容性和旧实现故障证据；新主界面见 E18                                                                                                                                                                                                                                                                |
| E18  | Android 16 实机全屏 React 手机布局：400×845 CSS viewport，实际键盘打开后 400×502；同一前端资源与 App / phone 标记确认。审批、Stop、系统文件选择回传、中文文件名与 51 字节下载、抽屉 Back 同路由关闭通过。运行中关闭重开恢复完整回答，持久账本仅一个 command / DSH run / local run。实际代码导出保留 .js 扩展名及 65 字节内容，取消不影响聊天；最终构建与 52 项单测通过 | `perf/out/dsh-android-web/ACCEPTANCE.md`、该目录 `dom-final.json`、`dom-final-keyboard.json`、`final-*.png`、`file-selected-final.json`、`back-before.json` / `back-after.json`、`active-reopen-final.json` / `active-reopen-ledger.json`、`chisabot-web-export-final.js`、`export-cancel-state.json`、`unit-results.json`；`work/android-web-reference.md` 为同尺寸 Web 视觉比较 |

数据库证据：0063 在全新 PostgreSQL 16 + vector 与已有 ensure 表库均完成迁移，历史计数/状态保留；0064 在已有账本的隔离数据库迁移通过。最初 PostgreSQL 18 环境缺 vector，迁移未通过；随后使用已有配套环境，没有削弱 SQL。来源：`work/dsh-schema-runtime.log`、`work/schema-coordination.md`、`work/background-coordination.md`。

依赖证据：全新生产安装 `--omit=peer` 后无 CopilotKit 包目录，AG-UI、Mastra、AI SDK 导入通过；服务端生产入口能到达真实数据库边界，E15 已检查发布镜像物理目录。来源：`work/retirement-coordination.md`、`work/dsh-production-deps-nopeers.log`、`work/dsh-retirement-loader-final.log`。开发测试依赖不进入该结论。

E15 的前两次 rich-inbox 全对象比较失败，分别来自维护控制状态正常变为 paused，以及已答项按既有十分钟读取窗口不再列在 inbox。修正观察口径后分别检查仍待处理的完整 payload、技能、已发送项的持久历史及文件字节；没有删除数据保留断言来制造通过。

## A01–A26 验收矩阵

“通过”指表中明确的环境和路径；“部分通过”保留尚缺操作。服务端合格镜像已发布，Android 同一 Web 主界面的证据独立列于 E18；原生旧界面证据留在 E17。

| 编号                           | 当前结论                          | 证据与实际边界                                                                                                                                                             |
| ------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 新对话/连续多轮/长历史     | 机制与用户路径通过                | E01 稳定路由、E12/E16 真模型连续对话、E13 小窗口长历史压缩与模型变更；受控摘要证据不泛化成真实模型语义质量或完整工具集最低窗口                                             |
| A02 Markdown/正文气泡          | 通过（Web 受控呈现）              | E09 宽窄暗色、标题/代码/围栏、流式和结束布局；E01 完整产品正文截图                                                                                                         |
| A03 滚动/旧页/窄屏             | 通过（Web 回归）                  | E09 七场景 screenJumps/upJumps/removed 均 0，结束无新增人工空白                                                                                                            |
| A04 仅附件/卡片交付            | 通过（实际 Host/PG）              | E08 文件保存与下载、权限及真正空回答负例通过；E04 卡片精确 JSON、有效终态和下一轮空回答负例通过；最终 UI 见 A23                                                            |
| A05 接纳响应丢失               | 通过                              | E05 接纳后派发失败仍返原回执；E09 响应正文截断按同 ID 查询，不重复 POST/草稿                                                                                               |
| A06 断线/关闭/另端恢复         | 通过                              | E05/E09 API 与 HttpAgent 恢复；E17 原生跨端活动恢复；E18 从 React 输入框发送后运行中关闭重开 App，恢复原路由及完整单条回答，账本仅一条 command 和一次执行                  |
| A07 重复/乱序/缺口/generation  | 通过（定向故障与实际原场景）      | E11 源水位与重建通过；E04 durable-before-live、真实 retry、历史 baseline 和原 card-only 参数重复场景通过                                                                   |
| A08 并行会话中的模型 Stop      | 通过（隔离环境）                  | E02 单 Host Session Stop，E10 两账号同时运行：A 停止、B 完成；跨账号 Stop 拒绝                                                                                             |
| A09 工具 Stop/晚回调           | 通过                              | E07 确认终止后才释放 lease，设备协议与迟到回执受限；E14/E17 原客户端 Stop，E18 新 WebView 实际停止按钮与持久停止状态通过                                                   |
| A10 审批中 Stop/迟到批准       | 通过                              | E05 停止终态持久化、重新打开不回到等待；E07 已停止 handoff 重建不产生新效果                                                                                                |
| A11 补话/附件/技能/Stop        | 通过（完整 Web 产品）             | E14 三种 payload 持久保存，Stop/刷新/另一浏览器恢复一致，仅指定附件发送，另外两项保持暂停；E15 回滚后仍可读                                                                |
| A12 审批决定与竞争             | 通过（完整 Web 产品）             | E05 执行一次与事务；E14 allow/deny/handled/过期和两浏览器相反决定竞争，单一有效决定/工具结果，刷新保留                                                                     |
| A13 审批期间 Host 重启         | 通过（已保存等待）                | E05 Host 重启后原操作一次；E07 故意过期的已存 handoff 断言经持久批准后续执行一次。waiting 已写但 gateway202 未到 Host 的精确窗口尚无独立证据                               |
| A14 效果发生但回执丢失         | 通过                              | E05 实际副作用后进程崩溃、未知结果暂停且无模型新调用；E11 未落盘尾部不重做；人工/外部回执核对仍是后续业务动作                                                              |
| A15 主/备模型失败归属          | 部分通过                          | E02 有界重试/备用与早期实际 SWE-2 helper 链路；E09 错误分类。全产品真实模型完成见 E12，配额/目录过旧等故障组合未全在最终镜像验收                                           |
| A16 多模态/推理/参数/切模型    | 定向合同通过                      | E02 协议与认证、E08 图片、E03/E12/E16 推理及真实模型、E13 实际摘要输出 cap 与兼容/过小模型切换边界；不泛化为所有 provider 能力                                             |
| A17 无浏览器后台入口           | 受控链路通过；真实 IM 用户暂缓    | E06 定时、worker、任务中心、真实 IM 服务+协议回执/重建均通过；第三方真实平台送达按用户要求暂不测                                                                           |
| A18 handoff/子执行/local-agent | 受控链路通过                      | E07 原 actor/initiator、稳定执行身份、审批恢复/过期/Stop/丢回执均通过；设备为真实 Hub + 协议 peer，不宣称物理 CLI 执行验收                                                 |
| A19 导入/编辑/重新生成         | 通过                              | E08 编辑即时 fence；E05 原始身份/元数据原子导入；E14 实际编辑重发、重生成/重开只有一条修改后用户消息与一条回答，重生成使用新 ID                                            |
| A20 切换后回滚                 | 通过（实际隔离镜像操作）          | E15 更新后新会话、旧历史/工具/文件字节、待批和暂停富补话在兼容回滚后保留；生产切换沿用该流程及独立备份，未为验收故意回退生产                                               |
| A21 多账号/Team Bot 授权       | 通过（实际隔离域）                | E05 HTTP越权拒绝；E10 私有卷/桥接网络、热开通、账号预检503且未存command、跨令牌拒绝；E07 Team Bot 使用实际 teammate 身份与同意规则                                         |
| A22 Android/远程 AG-UI         | 当前客户端路径通过                | E08 远程接口及 E17 新装原生功能兼容通过；E18 按用户新要求完成同 React 手机界面、系统文件与代码导出。设备原包不存在，不能宣称原安装版本通过；正式账号登录未在隔离服务中验收 |
| A23 HTML/json-render 预览      | 通过（完整 Web 产品）             | E04 有效交付/精确参数；E14 聊天 HTML/JSON 重开保留、撤权移除 iframe 并拒绝、管理图库/详情按保存样例参数呈现                                                                |
| A24 源日志重建投影             | 通过（故障注入）                  | E11 缺失与落后投影重建一致，不派发模型或工具；E04 迟到实时帧问题单独追踪，不覆盖此正式源重建证据                                                                           |
| A25 API 重启/lease恢复         | 通过                              | E05 接回存活 Host、原模型请求一次；E06 worker/任务 lease 观察原执行；E07 handoff 原执行/结果一次                                                                           |
| A26 flush/未flush尾部          | 通过（Windows/Linux真实进程崩溃） | E11 已提交源前缀不变，未持久尾部未越过提交水位；恢复错误为结果未知，效果一次，不重用已提交 sourceSeq                                                                       |

## 安装与验收范围

Android 安装包位于 `android/app/build/outputs/apk/debug/app-debug.apk`，版本 `0.1.137` / `319`，最终包已于 15:39 覆盖安装在连接设备上。当前交付为 debug 实机验收包，未上传应用商店或修改 APK 更新源。长按图标选择“切换服务器”可回到现有登录流程；手机仍使用隔离环境，正式账号需要用户登录。

临时键盘检查结束后已恢复原 WeType 默认输入法及原启用列表，证据 `ime-restored.json`。文件选择只使用任务创建的图片，导出只写任务文件。实际 Android 文件回传的 ClipData、中文下载 filename*、代码导出 MIME 提示问题均已修复；本地 blob 导出使用系统保存窗口，内存传输上限 20 MB，普通服务器文件继续由 DownloadManager 下载。

最终 Android 源码、APK 与文档随同一部署批次单独归档；已发布网页资源没有新增变动，无需为壳修复重建服务端。A15 中尚未覆盖的真实 provider 故障组合、A13 精确丢失等待回执窗口仍按表中范围记录；真实外部 IM 维持用户暂缓。

运维使用入口：[DSH 部署与回滚](../ops/dsh-runtime.md)、[账号独立运行时](../ops/dsh-accounts.md)、[命名切换与存量资源兼容](../ops/upstream-removal.md)。运行命令、临时资源和恢复所有者留在工作记录中，不把私有部署信息写入公开文档。
