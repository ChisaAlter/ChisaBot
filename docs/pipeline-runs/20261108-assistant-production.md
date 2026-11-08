# 个人助理生产交付实施记录

计划：[production-assistant-plan.md](../production-assistant-plan.md)。2026-11-08 用户授权执行，并要求复用、整合现有模块。主线是桌面客户端与服务器；真实 IM 外发仍暂缓。

## 当前状态

- 前期 DSH 迁移、聊天修复、Android 共用网页入口和生产计划已保存为本地基线 `e6ad6934`。本轮个人助理首个候选源码已提交为 `9244b43a0373c3634005808453c98afc0e7631bf`，版本 `0.1.137`。本机完整构建在首个基础镜像拉取时因 registry TCP 超时退出；随后使用远端既有 `chisabot-builder` 从同一 Git 归档**完整构建成功**，候选为 `local/chisabot:assistant-9244b43a`，实际 Docker ID `sha256:368559fe2a21650c1040e8ddf5c3b977454d5b0d993b2ddaf60c69f6c87f558c`。镜像内依赖、关键导入、reader2、0065 与构建身份检查通过，**尚未生产发布**。这份首个候选的证据继续保留，不代表后续 reader 3 版本。未推送或触发 CI。
- 当前 reader 3 / 0066 候选源码已整合提交为 `2862762a54e93ec81d0c7c3c7436e84983e60872`，从该提交的 Git archive 执行原根 Dockerfile 完整构建，原远端 builder 单次 exit 0。镜像为 `local/chisabot:assistant-2862762a`，实际 Docker ID `sha256:7a0eebc11b793356689622c751f49ac9f0772fcb33a8a46424d2e182bcd4310d`。**新完整镜像及真实模板上的增量恢复通过，仍待正式桌面、真实资源与生产放行，生产未切换**；身份、资源和恢复范围见下表。
- 最后确认的生产配置为 Chisa 一个账号、一个独立 DSH Host。2026-11-08 18:44:56 UTC 只读快照确认 `chisabot-zh` 仍为running/healthy，镜像为 `local/chisabot:dsh-release-20261108`；实际容器内 `runtime-compat.json` 为 DSH `0.2.2-rc.1`、conversationReader 1。既有暂停任务保持暂停，本轮未重放未知效果或清理用户历史。
- 信息源、成熟日历解析、SMTP/Webhook 持久交付、任务成果核验、通知恢复接线、综合 DSH 健康、读取器升级保护、A13 审批等待回执丢失与 A15 模型故障分支均已实现并有定向证据。独立宿主检查及连续失败/未知效果信号也已完成。
- 容量源码已实现账号级两槽与持久等待，复用原 run 账本、thread lease 及恢复 sweep，加入 0066 并将产品 reader 升到 3。容量基线曾保存于 WIP `485cd482`，其后 DB 兼容修复已随 `2862762a` 整合提交。Bun 1.3.14 命名 prepare 的协议错位已由合法分块实验定位，现显式采用 `prepare:false`，并完成 Drizzle JSON、裸 Date ISO 绑定及实际 PG 类型验证。**原直连 API SIGKILL 混合恢复 1 场景 / 24 断言通过**；混合后台/前台、审批 Stop/Edit 和设备生命周期既有证据继续有效。未重放写入、加 sleep 或改 SQL 前缀掩盖失败。reader 3 完整镜像及其增量迁移/恢复现已通过；9244 镜像和正式服务均不包含此项容量保护。
- **生产已重新可达**：23:41 发布前检查中 SSH 与正式登录入口恢复，独立 API/auth/DSH/computer/public 健康通过，运行中执行为 0，原完整备份仍 ready。此前 22:54 正式 PC 显示 522、22:57 后 TCP 22/443/8443 超时；主机当前报告本次启动时间为 23:08:39，重启原因尚未确定。没有执行本轮镜像切换、生产迁移或数据恢复。旧故障保留为事件，不能算作候选的合格观察期。
- 迁移和单账号整理的恢复批次已复制到更新器普通轮换之外的受限保护区，原批次仍保留。22:06–22:08 完成一次真实完整备份，既有每日备份 timer 已改用完整备份入口。**同批备份已用原生产镜像完成断网隔离恢复**：426 个历史会话、87 个原文件下载接口逐字节、7 条记忆、auth SQLite、1 个 binding 以及真实 DSH cursor30 均通过；暂停/待决/工具/IM 状态与 projection481839 读前后不变。首个 reader 2 候选随后从该模板完成0065迁移、生产模式API服务及auth冷启动、DSH reader2 readiness；reader 3 候选另在专用数据库完成65→67增量恢复，未迁移原模板或P4数据库。异机副本未配置。
- 11 月 9 日续作时已启动正式安装的 Windows 客户端，既有会话正常恢复到正式入口，历史、输入框和任务栏可见，不再显示 522。此为旧生产版本的入口/历史只读观察，未发送消息、修改用户数据或冒充本轮候选与重新登录验收。
- 已为同一安装版另开独立 PC 资料；SSH 隧道和候选服务端入口已接通，**PC 登录链路尚未接通**。入口复用正式 nginx/auth 和受信 TLS，内部 Docker 网络无默认路由、不开放公网；宿主与本机 curl 的证书校验通过，登录页 200、匿名接口保护有效。未导入旧 Cookie、设备令牌或伪造身份。桌面登录的 Node 网络栈不使用 Chromium 域名映射，源码同一 `auth.probe` 直连候选地址实际超时；仅加 `--host-resolver-rules` 或 curl 的 resolve 成功都不能证明 PC 能登录。专用 sing-box 代理启动与独立 Edge 启动均为 **blocked by policy，均未实际启动**；不换路绕过拒绝、不改全局代理/DNS或关闭 TLS。已撤回先前请用户在新 PC 窗口登录的步骤，待主代理在允许的执行条件具备后实际接通再继续。五个 P4 服务与根代理 SSH 隧道保留，维护标记、后台开关与外网封锁保持；模型/任务仍未验。
- 五个已无人消费的旧隔离 Host 已逐个确认空闲后停止；旧预览的容器、网络、卷、镜像与恢复定义已受限归档，原数据保留。操作后独立生产健康退出 0。Hermes 仍有生产中的旧 URL 探针引用，留待候选切换时处理，未直接停用。
- 既有 R5/E01–E18 未受改动影响的证据继续复用。下述“源码/隔离通过”和“正式用户路径通过”分别记录。

## 所有者与集成边界

| 工作包 | 当前所有者 | 复用与边界 | 状态 |
|---|---|---|---|
| P0 发布基线、在线配置与集成 | 主代理负责候选与生产放行；`release_assembly` 同步文档 | Git、生产配置、`index.ts`、迁移与既有远端 builder | `2862762a` 已冻结提交，完整镜像及增量恢复通过；新 API/DSH 正常停止保留，原 P4 五服务运行，生产未切换 |
| P1 信息源 / 日历及 P2 安全交付 | `sources_final` 已交付，主代理已消费 | 既有 personal-sources、安全表单及 IM 发送状态机抽取 | 源码冻结，定向数据/故障/组件验证通过；真实接入待资源 |
| P1 任务成果 | 原任务成果所有者已交付，主代理已消费 | 既有 payload、artifacts、事件、工具/交付记录；旧纯文本任务合同不变 | 源码冻结，真实 PG 与组件验证通过；正式桌面任务待验 |
| P2 通知整合 | 主代理 | 既有恢复 sweep 收集已提交生产者结果，同 ID 进入持久交付 | PG 崩溃缺口、去重/unknown、迁移幂等验证通过 |
| P3 更新与完整备份 | 原运维与恢复所有者已交付；主代理持生产写入权与留存副本接口 | 既有更新锁、排空、DSH snapshot、轮换与 timer | 原镜像完整恢复及候选 0065/API 服务冷启动通过；原恢复与旧 network-none 候选容器停止保留，P4 五服务继续运行；线上 reader 1 未改 |
| P3 综合健康 / 独立信号 | 主代理 / `assistant_monitoring` | 共用 DSH readiness；沿既有宿主检查和 systemd 接线 | 综合健康、实际 Host、独立检查与信号验证通过；宿主接线待部署 |
| P3 后台容量 | 容量及恢复所有者已交付，主代理已消费 | 复用既有 PG 执行租约、admission 和任务队列 | 统一后台两槽、前台独立接纳已实现，0066/reader3；混合并发、审批/设备、DB 兼容与实际类型验证通过，原直连 SIGKILL 恢复 1 场景/24 断言通过；新完整镜像及增量恢复通过，真实代表负载待验 |
| G09 A13 审批缺口 | 原审批所有者实现并验证；主代理已消费 | 同 call 重试恢复原待批；内部续执行保留 Stop/Edit 与暂停补充边界 | 真实 Host SIGKILL + API backend 重建通过，1 PASS / 32 断言；未创建第二张卡或重复效果 |
| G09 A15 模型故障 | 主代理，接手受 429 限流的模型所有者 | 原 fallback 预算/Host；仅修缺失分类和实际主备归属 | 最终实际 Host 8 个故障场景、前端错误解析通过 |
| P4/P5 桌面、真实连接与发布 | 主代理；恢复所有者已交付私人入口 | 正式安装 PC、独立资料、真实服务器与实际设备；密钥使用安全入口 | 严格 TLS 服务端入口与本机 SSH 隧道可用并保留；PC Node 路由未通。专用 sing-box 与独立 Edge 启动均被策略拒绝、均未启动；候选未发布、未真实登录 |

## 已确认的集成决定

1. DSH 健康不另起 daemon：`runtime/dsh/src/readiness.mjs` 负责身份、协议、版本和会话读取；管理端使用受限输出，部署检查可检查完整绑定集合。
2. 个人通知与 SMTP 需要的持久记录不能伪造 IM connection/thread 外键。提取现有发送状态机制供两者复用，仅新增必要业务记录；新计划不增加第二个调度器。
3. 任务完成条件保存在现有 payload，检查结果保存在既有成果/事件。新增文件、交付或设备要求只适用于明确要求这些成果的任务，不使旧纯文本任务失效。
4. 个人通知仍由既有 DSH 恢复 sweep 调度。到点/任务完成/待批/待登录/失败从原持久行恢复；只通知显式连接之后的新事件，不选择“最近私聊”，不覆盖已有 unknown 正文或目标。
5. 产品 reader 2 保留 reader 1 读取能力并增加个人交付与任务成果合同。候选可从 1 升到 2；进入 reader 2 后不得用 reader 1 镜像回滚。线上 marker 保持 reader 1，不能提前把它写成候选版本。
6. 本轮增加生产依赖 `node-ical@0.27.5`、`nodemailer@10.4.0`；必须完整构建，不能把旧依赖镜像加源码覆盖当成已可用候选。
7. 后续容量源码新增持久等待和设备占位，由产品 reader 3 恢复；进入 reader 3 后不得回滚到 9244 的 reader 2 或更早镜像。实现合同为：前台不占后台两槽；DSH 人工等待释放后重新申请；旧设备中途审批及未确认停止仍占原槽，因为旧节点不能可靠确认已暂停。本轮不新增 PC 协议或发版；0066/reader 3 未部署至生产，正式服务和 9244 镜像不具备这项全局保护。

## 实现与有效验证

| 范围 | 当前结果 | 决定性证据 / 剩余边界 |
|---|---|---|
| 信息源与日历 | 新鲜/缓存/失败/未连接贯通；RRULE、TZID/DST、例外、改期、取消、全天与浮动时区由固定版本 node-ical 处理；生产默认关闭 demo | 当前 12 个定向场景均有有效通过依据；最终受影响 4 场景 36 断言晚于 DB 时钟修复。真实来源未提供 |
| SMTP 与 Webhook | Nodemailer 替代手写 SMTP；平台接纳与 unknown 分开；未知发送不自动重试；仅无人值守 Webhook 明确 429 拒绝有限重试 | 真实 PG、受控 SMTP/HTTP、并发去重、重连取消与已提取 IM dispatcher 验证；无真实收件结论 |
| 安全连接与界面 | 连接工具跳转安全设置；密码与私密 URL 不再是普通模型工具参数；已有设置显示来源/发送状态 | 最终 app/server 类型通过；实际 React 桌面、时区弹窗和 390px 手机组件截图已检查，无横向溢出；不代替正式登录。旧历史凭据风险清点尚未完成 |
| 任务成果 | 文件检查实际存储字节，外发检查同 owner/run 接纳记录，设备检查原回执；结果复核保留原执行，普通 Retry 新版本；Stop 后迟到结果不翻转 | 27 个定向测试 / 99 断言；真实 PG 5 个场景（原 4 个 30 断言，加最终模型失败后效果不重做 8 断言），含真实文件 GET；真实模型报告语义仍待验 |
| 通知恢复与 0065 | 收集生产者 commit→通知 intent 的崩溃窗口；稳定 ID、过期/取消/静默/历史过滤；迁移包含 attempts/next_attempt_at 与日历时区 | 本机独立 PG 3 PASS / 13 断言；fresh migration→运行时 ensure→重复 migration 通过，Drizzle generate 无 schema 差异 |
| DSH 综合健康 | selected DSH 失败使 aggregate 503；未选 Hermes 不拖低当前内核健康；产品与部署共用身份/版本/持久读取探针 | ops-health 17 PASS / 68 断言，真实 Host readiness 通过；不调用模型 |
| 更新/读取器保护 | 仅轮换自己的完整更新批次；手工/未知/未完成/.keep 保留；至少三个不同自动镜像身份；reader 1→2 允许、2→1/非法版本拒绝 | 既有 Node/shell 故障分支与 Git Bash reader 兼容检查通过；连接恢复后已核对 helper/guard/accounts/install 于 11 月 8 日 14:21 UTC 安装，未重复安装；线上 marker 与受保护原件逐字节相同，仍为 reader 1 |
| 完整备份与原镜像恢复 | 同批 DB、DSH、workspace、profiles、auth、必要配置与版本清单，服务按原状态恢复；复用现有每日 timer | 22:06:58–22:08:37 真实作业，1.3 GiB / 16 artifacts，`state:complete`；99 秒是作业总长。真实 PG16/vector 恢复后，426 会话、87 文件逐字节、7 记忆、auth 与 DSH session 实读通过，状态不变；恢复容器已停止并保留模板。最终生产独立健康通过。新候选迁移/冷启动另验 |
| 模型故障 A15 | 401 终止、404/410 切备用、目录失效不请求、429 有限耗尽、首输出超时有限重试后备用、Stop 不 fallback；错误归属真实最后候选 | 真实 Host + loopback provider：8 子场景通过，含父测试共 9 PASS / 8.42 秒；前端错误解析 9 PASS / 22 断言。app 构建 54.16 秒通过 |
| 审批缺口 A13 | 同 call 恢复原 202；正文丢失仍按原 ID 传输重试；Host 换 generation 后旧流收尾；合法内部批准续执行不解冻补充；拒绝入场不覆盖原历史 | 真实 Host、PG、HTTP 丢回执/SIGKILL/API 重建：1 PASS / 32 断言，晚于最终修复；伪造 HTTP resume 和迟到 stopped source 均拒绝，批准恢复只有一次效果 |
| 独立监控与业务信号 | API/DSH/备份/磁盘/活动证书只读检查；沿既有索引取有限样本展示连续三个终态失败和 unknown，不自动重试效果；业务需处理不让镜像 readiness 回滚 | 宿主原七组检查通过；实际 PG 四场景 25 断言，真实 CLI 12 断言、路由隔离/脱敏 4 断言及新增宿主三态通过。输出明确 lower_bound / 未采样 IM；真实宿主 journal 和收件待验 |
| 首个 reader 2 完整候选 | 根 Dockerfile 完整安装生产依赖、构建前端并导入 Docker；未用旧依赖镜像覆盖源码 | 23:58:22–次日约00:07:18，单次远端 buildx exit0；镜像在 network-none/read-only/apiuser 下实际导入 Nodemailer10.4.0/node-ical0.27.5、业务关键模块、readiness/reader helper，通过0065/journal与前后端build身份检查；Node24.18.1导入亦通过。磁盘最低116.360 GiB、MemAvailable最低17.850 GiB；API服务冷启动见下一行 |
| reader 2 候选迁移与API冷启动 | 使用真实恢复模板的独立数据库，运行镜像原migrate入口；以production模式/uid1002启动真实API src/index.ts与复制的正式auth服务 | journal 记录数 65→66，新增应用的是 **0065，不是后续 0066**；表/索引/attempts/next_attempt_at/日历时区正确。API与auth健康200，未认证接口401，前端入口JS200/518540字节；候选CLI确认DSH0.2.2-rc.1、reader2、1runtime/1session/running0。全部36个work item和暂停/待决/tool/IM/binding/projection状态不变，delivery0；原模板仍为65条journal记录。环境物理断网，沿已有开关关闭部分后台并持maintenance；未启动完整s6/computer、不提交prompt、不替代正式用户路径 |
| reader 3 完整候选 | 冻结提交 `2862762a` 的 Git archive 27,868,907 bytes，原根 Dockerfile / `chisabot-builder` 单次完整 buildx exit0；不是 dirty 打包或 9244 覆盖源码 | version `0.1.137` / build `assistant-2862762a` / builtAt `2026-11-08T18:26:34Z`；linux/amd64，6,562,196,617 bytes。原 builder 10 GiB 硬限、60/8 GiB 磁盘/可用内存阈值不变，实际最低磁盘109.352 GiB、MemAvailable17.735 GiB。日志与实际镜像身份在 `work/assistant-release-remote-2862762a/` |
| reader 3 镜像增量恢复 | 真实 `assistant-2862762a` 从原模板迁移专用数据库 journal65→67，实际补齐0065/0066；`execution`为jsonb/nullable/default null，`capacity_active`为boolean/NOT NULL/default false，旧764条run的execution均为空、6条终态设备capacity均为false；以production模式启动新API3011与DSH3096 | **通过**。`/health`200，`/api/me`与`/api/admin/health`401，version精确匹配`2862762a`；reader3 readiness为1runtime/1session/running0，原session水位30不变。36条work逐行及commands/DSH/tool/inbox/binding/projection/capacity业务值不变，未重放；唯一control时间戳变化见下段。API/DSH已正常exit0停止保留，原P4五服务运行，模板journal65/P4journal66不变 |
| reader 3 实际产品历史读取 | 镜像内实际 `createDatabase`→生产历史consumer，读取2个既有会话；使用真实Bun JSON与只读事务 | **通过**：12条消息、2个toolCalls、2条事件，事务前中后类型稳定。这是内部真实产品consumer路径，不是已鉴权HTTP历史、真实桌面或模型验收；完整交接及证据索引见 `work/assistant-restore-acceptance.md` |
| reader 2 P4 服务端登录入口 | 正式 nginx→auth/API，既有证书、HTTPS publicOrigin 与 Secure Cookie 合同不变；SSH 隧道直达该组内部 443，保留独立 PC 资料 | 登录页/素材 200，匿名导航 302，保护 API/资源 401，内部入口 404，错误 Origin 403；宿主与本机 curl TLS 校验均为 0。Docker internal 网络忽略端口发布。Chromium 域名映射不作用于 PC Node 登录请求，`auth.probe` 超时；专用 sing-box 与独立 Edge 均被策略拒绝且未启动。仅服务端入口通过，无客户端登录/模型结论 |
| 账号后台两槽源码 | 统一runner、worker、schedule、task-center、handoff、确认续执行和设备Agent共享PG事务锁；原run行保存容量等待，不持thread lease、不耗执行预算，前台独立接纳 | 真实PG+DSH混合容量12断言、审批/Stop/Edit50断言、PG设备协议4场景26断言、原turn-runner34场景92断言通过；0066空库迁移、reader1/2→3及3→2拒绝通过。设备协议peer不替代真实Windows验收 |
| SQL 兼容与直连恢复 | `createDatabase` 显式采用 `prepare:false`；保留原生 Query 错误退池，不重放失败操作 | DB recovery 16 场景/81 断言、原 URL/TLS/超时/rollback/锁等待 30 场景/40 断言通过。原两后台+持久队列+前台的真实 API SIGKILL、重接不重放、队列续跑及槽位归零 **1 场景/24 断言通过**，无透明 proxy 或 trace wrapper；日志 `work/assistant-capacity-recovery-unnamed.log` |
| unnamed 绑定与实际调用方 | JSON 复用标准 Drizzle serializer/read mapper；实际裸 Date 绑定点使用 ISO，正常 schema Date mapper 不变 | 实际 PG 类型 2 场景/15 断言、JSON shape/audit 3 场景/5 断言、设备 expiry/记忆撤销/auth stamp 4 场景/23 断言通过；schedule 4 个场景有有效逐项结果，最终 pause/resume/skip/runNow/update/delete 组合 1 场景/10 断言通过。完整交接与日志索引见 `work/assistant-capacity-contract.md` |

reader 3 启动前后比较的唯一变化是1条既有 `paused=true` control行的 `updated_at`：`ThreadInbox.releaseInterrupted` 的启动幂等对账刷新了时间戳，行身份和paused值未变，不是inbox消息或效果重放。首次API启动漏设WorkingDir而找不到 `brand.yaml`，补回原cwd `/app/server` 后通过；历史helper的 `docker cp`→tmpfs模块路径失败时未实际执行，改为同helper直接 `bun -e` 后通过。接线问题及水位collector修正记录保留于本次证据的 `harness-corrections.json`，产品、镜像和迁移未改，未重做已绿步骤。本地安全结果在 `work/assistant-reader3-2862762a/`；完整交接 `work/assistant-restore-acceptance.md` 指向受限远端证据目录，其中私有快照不作为普通日志公开。

本轮 SQL 诊断的固定源码确认：simple-query `Q BEGIN` 自身已有一个 ReadyForQuery（`Z`），其后的额外 `Sync` 产生第二个 `Z`。在合法分块最小实验中，仅拆开这两个响应就能让 Bun 1.3.14 原生客户端发生原错误，recovering wrapper 同样失败；两者同批接收时均正确。这将故障定位到原生命名 prepare / pipeline 的协议状态处理，而不是恢复库内容或 SQL 参数数组。`split + prepare:false` 的两路对照均正确，现已在 `createDatabase` 采用其现成 unnamed extended 模式；代价是每次 Parse、不复用命名预处理语句，并取消同一连接的自动 pipeline，不能据此推导固定性能比例。修复不靠等待时间或 SQL 前缀改变时序。

原直连恢复现已在兼容修复后通过；此前透明 wire witness 的单次通过及 native/recovering 各 660 次只读查询仍仅属诊断证据。unnamed 模式首绑不等待服务器 OID，实际 PG 验证发现的 JSON 和裸 Date 绑定差异已在原 schema/调用点完成适配。schedule 组合初跑由旧 `.rejects.toThrow` helper 阻塞 PG I/O；普通 await 在 15 ms 正常抛出同一 `ScheduleError`，测试改为先 await 捕获再断言同一类型后，组合在 568 ms 通过，未增加产品修正、扩大超时或削弱要求。最终交接为 `work/assistant-capacity-contract.md`；协议反例保存在 `work/assistant-capacity-double-ready*.log/jsonl`，最终组合日志为 `work/assistant-capacity-schedule-date-caller-fixed.log`。

详细日志与所有者交接保存在本机忽略目录 `work/assistant-*.md` 及对应 `.log`；配置归档含私密数据，不在公开文档输出。

## 放行矩阵：源码就绪不等于正式投产

| 项目 | 当前状态 | 下一负责动作 |
|---|---|---|
| G01 可追溯源码/镜像/更新 | `2862762a` 的 reader 3 源码、实际完整镜像及增量迁移/恢复通过，身份明确；生产未切换 | 主代理基于该镜像继续正式桌面、真实资源及生产放行；不沿用 reader 2 镜像身份或以 CI 填验收缺口 |
| G02 正式桌面对话 | 旧 R5 证据保留；已安装 PC 恢复正式既有会话和历史。候选服务端 TLS 入口通过，独立 PC 的 Node 路由未通；专用 sing-box 与独立 Edge 启动均 blocked by policy、均未启动，未登录 | 主代理保留现有服务和隧道；允许的执行条件具备后，实际接通客户端再请用户正常登录，不换路绕过拒绝。模型出口仍关闭，发布后另验正式路径 |
| G03 真实来源/晨报 | 隔离语义与组件通过；无真实日历/邮箱 | 用户有资源时在既有安全表单接入；主代理完成实际读源，密钥不发聊天 |
| G04 定时→本人收件 | 持久通知接线通过；本人 Webhook 无目标 | 用户在安全设置中配置本人目标并明确验收内容后，主代理完成实际提醒；IM 保持暂缓 |
| G05 批准→邮件发送 | 受控 SMTP/账本证据通过；无邮箱/授权收件目标 | 取得真实邮箱和具体收件授权后验收 |
| G06 任务成果 | 实际 PG/文件 GET/失败/取消验证通过；完整正式任务未验 | 客户端连通并正常认证后，主代理继续正常任务入口的真实报告/文件验证；发布后补正式服务器路径，不以内部 API 代替 |
| G07 记忆 | 原能力/七条笔记保留；本轮跨会话更正/遗忘待验 | 主代理在正式桌面使用新增专用测试事实，保留用户既有记忆 |
| G08 真 Windows 设备 | 原设备能力保留；本轮真实 device_* 文件/停止/离线未验 | 主代理经正常客户端在指定验收目录验证；不以 Android 或协议 peer 代替 |
| G09 恢复/模型故障 | 9244 的 A13/A15 与新交付/任务恢复证据有效；reader 3 的 DB 兼容、实际 PG 类型、原直连 SIGKILL 混合恢复及完整镜像增量恢复通过 | 主代理继续正式模型路径验收；内部历史consumer通过不代替真实桌面、模型或外发，不用 CI 或部署试错 |
| G10 备份/回滚 | 完整备份、原镜像真实隔离恢复、reader2候选冷启动、reader3完整镜像增量恢复与兼容保护通过；异机副本未完成 | 主代理保留已验收模板/候选接口；新API/DSH已停止保留，原恢复、network-none候选及P4的三套PG共享cluster仍须互斥启动；实际用户登录/模型回合另验，异机位置由用户提供 |
| G11 监控/告警 | 综合健康、独立宿主检查、连续失败/unknown 有界信号均通过；无真实宿主接线或本人告警收件 | 主代理在发布变更窗口装配既有账号 timer 的只读 hook，核对活动证书/journal；异机探测和外发仍待实际资源与目标 |
| G12 七天日用 | **未开始** | 必要正式路径和恢复合格后开始；此前522故障时段不能计入合格观察期 |

## 外部依赖

用户已选“现有通知 Webhook”，但尚无具体目标；已确认暂无日历、邮箱和异机备份资源。已有 Android 设备不是本轮桌面/服务器的替代品。连接资源准备好时由用户在现有安全设置中输入，不收集聊天明文密钥；真实外发需具体目标和内容授权。

VPS 可达性前置条件已在 23:41 恢复：主代理先检查当前镜像/服务/维护 marker/真实备份并通过，再交回真实隔离恢复。此前已请用户从服务商控制台核对电源/故障通知；未收到重启原因。00:18 的只读宿主复核显示：前一 boot journal 最后记录为14:21:42 UTC，新 boot 从15:08:42 UTC开始；前后两次 kernel journal 未找到 OOM、panic、lockup 或磁盘 I/O 错误的匹配记录。现有日志仍不足以确定失联/重启原因。下一次生产变更仍先核对健康与活跃执行，不重装、重置磁盘或用旧数据库覆盖当前实例。

旧预览收尾已完成：逐一复核旧 API exited、五个隔离 Host 的真实 SDK sessions0/running0、3086 无连接及无现役消费者后，仅停止这五个 Host；旧预览共12容器、7网络、17卷、5镜像的定义/清单受限归档，容器与数据均未删除。当前真实恢复与新候选不在清理集合内，最后独立生产健康退出0。仍需在候选切换中处理旧 Hermes 探针配置，确认无活动/恢复消费者后再归档 unit，以及取得前台聊天加后台任务的代表性资源峰值。只读核查确认9244中任务中心每用户2、全局4，workers独立默认5/10，不同定时任务可并发，三者不共享名额；只调worker配置不能实现全局上限。后续源码沿既有PG租约/admission补了统一接线，DB兼容修复、原直连SIGKILL及新reader3完整镜像增量恢复均已通过；9244镜像和正式服务仍不含此保护，高峰余量也未测得。未测得代表负载之前不调整其他项目资源。

当前 reader 2 P4 的 PG、DSH、API、auth、gateway 五个专用服务及根代理的本机 SSH 隧道均保留；17:57 UTC 只读快照再次确认五服务运行、隧道 `127.0.0.1:55450` 仍监听，reader 3 增量验收结束时五服务仍运行。新增 reader 3 API3011/DSH3096已正常exit0停止保留，未替换原P4组或操作其共享PG；原模板journal65、P4journal66不变。原恢复 PG 和旧 network-none 候选 PG 停止。三套 PG 共用同一恢复 cluster，必须互斥启动。模型/第三方出口仍封锁，不在用户登录前自动解除维护或恢复旧任务。独立安装 PC 的 Node 路由未通，且认证窗口无法由工具可靠观察或代填；专用 sing-box 代理与独立 Edge 启动均被执行策略拒绝，均未实际启动，不通过另一工具或路径绕过。下一动作由主代理在允许的执行条件具备后解决客户端连通，再请用户正常认证；此时不让用户重复尝试未连通的窗口。后续任务、记忆与设备验证仍由主代理负责。真实模型连接已核对为 saved Anthropic，经 API capability 代理至既有 Magpie；维护标记不拦摘要命名循环，因此开放模型前还须按当时状态确认旧自动工作不会认领，并限定出口和时窗，不能只靠 marker。

设备容量保留一个明确恢复限制：首次claim提交到首次agent_run发出之间API崩溃，旧协议无法分辨未发送和已发送，也不对未知任务Stop回终态。源码保守保留未知占位，不自动重发或超时腾位；需真实设备终态或维护者核实设备已无执行后处理原记录。完整无损自动恢复需要后续设备幂等回执协议，本轮不能将该边界标通过。

## 验证与发布

本目标 CI **触发 0 次、未通过 0 次**。未 push、未发布本轮镜像。各模块先实现再定向验证；有效证据不无故重跑。实际用户路径、完整候选和恢复缺口不交给 CI，也不把模拟收件、组件截图或内部 API 检查记成正式桌面通过。

候选 9244 源码冻结后的整合 `bun run --cwd server typecheck` 与 `git diff --check` 均通过；日志 `work/assistant-integration-final-types.log`。此证据不覆盖后续容量接线。A13 和 G11 共用的临时本机 PostgreSQL 当时已在消费完证据后正常停止，测试数据目录保留；本轮诊断的专用 PG 运行状态见下段。前端资源已随同一 9244 完整镜像构建，结果见上表；后续容量接线没有沿用该镜像作为新版本证据。

容量源码及后续 DB 兼容修复已完成必要定向验证，最终 `server` typecheck 通过，日志为 `work/assistant-capacity-db-typecheck-final.log`；完整交接见 `work/assistant-capacity-contract.md`。原直连 SIGKILL 的 HTTP 500 / `08P01` 失败记录保留于 `work/assistant-capacity-recovery-after-db-fix.log` 与 `work/assistant-capacity-recovery-diagnostic.log`，修复后原直连场景通过于 `work/assistant-capacity-recovery-unnamed.log`。专有 WSL PG 由主代理协调运行，数据保留。本地 `485cd482` 是此前容量 WIP 检查点；完整源码已整合提交为 `2862762a`，对应完整镜像及增量恢复通过。冻结 Git 归档与构建身份见 `work/assistant-release-assembly.md` 及 `work/assistant-release-remote-2862762a/`，增量恢复的实际范围、差异解释与日志索引见 `work/assistant-restore-acceptance.md`。正式客户端、真实模型/外发、代表负载及实际资源边界仍须完成，尚未达到生产放行条件。

个人助理的日常入口、成果检查、连接安全表单、提醒、发送结果与记忆用法已整理为[使用说明](../personal-assistant.md)，并从文档索引链接。它对应本轮候选，未把尚未上线的新状态写成正式客户端已有功能。部署手册同时撤回了“只加列所以任意旧镜像回滚安全”的旧说明，改为实际reader兼容门槛与当前效果账本保留规则。
