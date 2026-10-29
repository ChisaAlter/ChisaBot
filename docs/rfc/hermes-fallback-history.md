# RFC：Hermes 内核的备用模型 / 输出上限与长历史压缩

状态：已批准（模块 8 PR2；审稿决定见第 9 节，已全部落进代码）。分支 `feat/hermes-fallback-history`，从 origin/main 开，与 #416 无依赖。

## 1. 动机

审计报告 `08-reply-quality.md`：

- **第 2 项**：Hermes 内核下「备用模型」（429 自动换模型）和输出上限都不生效。内置循环用 `fallbackConnectionModel` 包模型，但 `hermesKernelAgent` 只把 `modelId` 交给 Hermes；适配器和桥里没有 fallback，`MAX_OUTPUT_CAP` 也只在内置路径。线上走 Hermes，管理员排的备用模型形同虚设。
- **第 4 项**：宿主侧没有上下文预算。桥每轮传完整历史，`sanitizeSeededHistory` 只去非法消息；话题一长只能撞上模型上限报错，没有「自动压缩 / 开新话题」的出路。

## 2. 备用模型与输出上限

- **传递**：服务端每轮在 `forwardedProps.chisabotHermes.model` 里传 `{id, fallbacks, maxOutputTokens}`。`fallbacks` 取管理员「备用模型」设置，去重、去掉主模型和非法 ID，最多 8 个；`maxOutputTokens` 沿用内置内核对该模型的解析（1..1,000,000）。
- **桥**（`examples/acp-agent/bridge.mjs`）：校验类型、数量、ID 字符（非法即 `ACP_INVALID_HOST_CONTEXT`），原样放进 ACP prompt 的 `_meta.chisabot.model`。
- **适配器**（`examples/hermes-agent`）：每轮用 Hermes 自带的 `agent_init_fallback._init_fallback_chain` 按主模型同一 provider / endpoint 建备用链，设 `agent.max_tokens`；下一轮没带就恢复默认（空链、原 max_tokens）。
- **回报切换**：Hermes 中途切到备用时，适配器在 prompt 返回的 `_meta.chisabot.modelFallback = {from, to, reason}`（reason 归一为 `quota` / `unavailable`）。桥写进 `RUN_FINISHED.metadata.modelFallback`。服务端只接受 `from` = 主模型且 `to` ∈ 本轮给出的备用，记 `model-fallback` 日志（与内置内核同一格式），前端复用现有「主模型额度用完，已改用 X」提示。
- **检测不支持**：适配器在 `initialize` 的 `_meta.chisabotModelControls = {fallback, maxOutputTokens}` 如实宣告（依据是当前 Hermes 是否有 `AIAgent._fallback_chain` 和 `_init_fallback_chain`、`max_tokens`）。桥 `/health` 带 `modelControls`（未初始化为 null），服务端 runtime-kernel 状态透传。设置页「备用模型」**只有检测到 `fallback: false`** 时才写「在 Hermes 内核下不生效」；旧桥 / 未初始化 / 没检测到都不提示，不猜。不支持的控制项适配器直接忽略。
- **范围**：备用链只建在主模型同一个 provider / endpoint 上；**跨 provider 备用（不同 base_url / key）暂不支持，列为后续工作**（见第 9 节）。

## 3. 历史压缩规则

只作用于发给 Hermes 的那一份历史（`server/src/agents/history-budget.ts`，在 `hermesKernelAgent` 的 prepare 里调用）。

- **估算**：本轮 token = 角色提示词 + 工具 schema（JSON 长度 / 4）+ 历史（复用 `context-usage.ts` 的 `estimateTokens`，字符近似），再乘一个系数：
  - 上一轮有 provider 返回的真实用量（最后一条带 usage 的 `RUN_FINISHED`，`lastMeasuredUsage`），且上一轮的压缩方案还在内存里：把上一轮实际发出去的内容按同一方案重新估算，系数 = 真实 / 估算，限制在 0.8–3 倍；
  - 否则（没有用量、重启后方案丢了）乘 **1.15 的安全系数**——估不准时宁可早压缩。
  - 上下文窗口取模型目录的 `contextWindow`（1.5 秒超时）；拿不到就不压缩。查上一轮用量 1 秒超时，超时按安全系数。
- **>70% 裁剪**：最近 2 轮原样；更早的工具结果换成「[较早的工具结果已省略，原长 N 字]」，超长旧消息（>4000 字）只留首 1500 + 尾 500 字，超长工具参数也截短。工具调用 ID 和调用 / 结果配对保留，多模态部分不动。
- **>85% 摘要（不阻塞）**：最近 4 轮之前的轮次用**已经缓存好的**摘要代替（一条「【较早对话摘要】本对话较早的 N 轮……」）：正好覆盖的摘要优先；没有就用覆盖其前缀的旧摘要（之后到保留轮次之间的原样，再照常裁剪）；一份都没有就本轮只裁剪。摘要后仍 >70% 再对剩下的轮次裁剪。
- **本轮从不调用摘要模型，首字时间不变**：需要新摘要时，prepare 只登记一个后台任务；回复结束（`RUN_FINISHED`）后才在后台生成 / 续写摘要并存缓存，**下一轮再用**。20 秒超时只用于这个后台任务；同一段同时只写一份。原来的阻塞式摘要路径已删除。
- **同一运行稳定**：方案按 runId 记住（最多 200 条），续跑段复用首段方案，保证桥要求的「同一运行输入只追加」（否则 `ACP_RUN_CONFLICT`）。

## 4. 摘要缓存

- **key**：话题（threadId）+ 被摘要的消息 ID 列表（范围）+ 这段消息内容的 sha256（id、role、content、toolCalls、toolCallId）。
- **命中**：范围和哈希都相同直接用。范围变长时找一条「消息 ID 是当前前缀、且前缀哈希一致」的旧摘要：本轮直接用它，后台只把新增几轮交给模型增量续写。
- **整段重摘**：每份摘要记 `extensions`（连续续写次数）。上一份已连续续写 **5 次**，或上一份摘要超过 **600 字**，后台就把整段重新摘要一次（`extensions` 归 0），防止越续越长、越续越走样。
- **失效**：较早消息被编辑 / 重新生成 → 哈希变，不再命中；删除 / 截断 → `local-conversations` 截断后按被删消息 ID 删除相关缓存（`message_ids ?| ARRAY[...]`）。
- **存储**：新表 `chisabot_history_summaries`（thread_id 外键到话题、话题删除时级联删除；through_message_id、message_ids jsonb、digest、summary、model、extensions、created_at），服务端首次使用时 `CREATE TABLE IF NOT EXISTS`（同 `chisabot_thread_truncations`，审稿确认可以），并建 `(thread_id, id DESC)` 索引，有单元测试核对建表和索引语句；每话题保留最新 10 条。不走 drizzle 迁移，删表即清缓存。

## 5. 摘要模型与回退

- 管理员在「模型 → 摘要模型」配置（`enterprise_settings.history_summary_model = {version:1, model}`，30 秒缓存，管理员 GET/PUT 接口）。未配置（「跟随主模型」）就用本轮主模型，不硬编码。
- 调用走现有连接（`connectionLanguageModel`），最多 1500 输出 token，中文提示，摘要 ≤600 字。
- **失败回退**：后台摘要抛错、返回空、或 20 秒超时（自己计时与调用赛跑，不依赖模型理会 abort，也不依赖 Windows 上 Bun 可能不触发的 `AbortSignal.timeout`），只记 `summary-failed` 日志，不存缓存；本轮早已按裁剪发出，回复不受影响。整个压缩外层再包 try/catch，出错就原样发历史。

## 6. 「已压缩前文」提示

- 服务端把本轮的 `{mode, summarizedTurns, beforeTokens, afterTokens, summary}` 写进 `RUN_FINISHED.metadata.historyCompaction`；新接口 `GET /api/copilotkit/threads/:id/compactions` 读出（同现有 `/fallbacks`）。
- 前端在该轮最后一条回复下显示一行低调说明：「已压缩前文（较早 N 轮由摘要代替）」或「已压缩前文（较早的工具结果和超长消息已省略）」；有摘要时用 `<details>` 可展开。复用备用模型提示的现有类，不改 `styles.css`。
- 「开新话题」复用现有上下文圆环，不做新 UI。

## 7. 数据库历史不变

压缩只生成新数组发给 Hermes，存库、导出、搜索、前端显示的都是完整历史；摘要消息（`hermes-history-summary`）不落库，下一轮读历史时也会被过滤掉。

### 7.1 Hermes 自带压缩会不会叠加（已读源码确认：会，已处理）

读的是部署用的 Hermes 源码（hermes-agent a938f00f）：

- 默认开启：`hermes_cli/config_defaults.py` 里 `compression.enabled = True`，阈值 0.50（窗口 <512K 时抬到 0.75）；`agent/agent_init.py` 把它设成 `agent.compression_enabled`。
- 自动触发点都受这个开关控制：开跑前的预检压缩（`turn_context_compaction.py`）、空闲压缩、运行中工具结果变多后的原生 / 预备压缩（`native_compaction.py`、`prepared_compaction.py`）、上下文溢出后的恢复压缩（`turn_recovery.py`，关掉时直接以 `compression_disabled` 失败而不是再压缩）。
- 适配器的 `_make_agent` 原来不碰这个开关，`restrict()` 只清掉了 context-engine 工具名。所以宿主压缩过的历史（已经是裁剪 / 摘要版本）到了 Hermes，按它自己的计数超过 75% 还可能再被压缩一次——**会叠加**。

处理：宿主压缩过的运行，`model` 里多带 `contextCompression: false`（`hermesWireModel` 第三个参数，`hostCompacted(runId)` 来自本轮的压缩结果）；桥校验是布尔后原样转发；适配器在这次运行里设 `agent.compression_enabled = False`，其它运行恢复 agent 原来的值。没压缩的运行不带这个字段，Hermes 保持自己的默认（窗口真满时它仍可自救）。

## 8. 测试计划

- `server/tests/history-budget.test.ts`：<70% / 未知窗口不变；78% 裁剪（最近 2 轮原样、原数组不变）；>85% 本轮只裁剪且不调用摘要模型、后台写好后下一轮用上（未配置摘要模型时用主模型、最近 4 轮原样）；下一轮先用前缀摘要并在后台只续写新增一轮；续写 5 次 / 摘要超 600 字时整段重摘；编辑失效 / 截断失效；后台摘要抛错和挂起只影响后台（本轮立即裁剪，任务 50ms 超时、记日志、同段去重）；真实用量校准（系数 1、1.2 倍、3 倍上限、方案丢失退回安全系数）和无校准时早压缩；同一运行方案稳定；建表与 thread_id 索引语句；token 对比。
- `hermes-runtime.test.ts`（wire model 含 `contextCompression: false`、切换校验、metadata 合并与日志）、`hermes-health.test.ts`（modelControls 解析）、`history-summary-settings.test.ts`（解析、缓存、管理员接口）。
- `examples/acp-agent/bridge.test.ts`：透传（含 `contextCompression`）、health、非法输入（含非布尔的压缩开关）、不支持时 false/false、伪造的切换被丢弃。
- Python `examples/hermes-agent/tests`：备用链和 `max_tokens` 设到 agent、下一轮恢复、不支持时不动、协议解析边界；**mock Hermes 429**：假 provider 对主模型抛 429，按 Hermes 的恢复流程走 `_try_activate_fallback(reason=rate_limit)` 换到第一个备用并重试，回报 `modelFallback {from, to, reason: quota}`；宿主压缩过的运行 `compression_enabled` 为 False、下一轮恢复。
- 前端：`chat-unify.test.ts`（提示挂在该轮最后一行、运行中不显示）、`hermes-history-notes.test.ts`（设置页提示只在检测到不支持时出现、compactions 读取）。
- DB 相关（真库建表、截断删缓存）由测试 bot 跑。

**Token 对比**（30 轮长话题夹具；数字是代码实际用的估算，即字符估算 × 1.15 安全系数）：改前 164,250（字符估算 142,826）；200k 窗口（约 82%）裁剪后 48,736；160k 窗口（超过 85%）第一轮也只裁剪到 48,736，后台写好摘要后，下一轮（31 轮，改前 168,116）摘要较早 26 轮后 33,212。

## 9. 审稿决定（已落实）

1. 暂不支持跨 provider 备用，列为后续工作（备用链仍只建在主模型同一 provider / endpoint 上）。
2. 继续用字符估算；上一轮有 provider 真实用量时用它校准比例；估算不确定时宁可早压缩（安全系数 1.15）。
3. 每增量续写 5 次，或摘要超过 600 字，整段重新摘要。
4. 体验优先，首字时间不能变长：本轮只裁剪，回复结束后后台生成摘要，下一轮再用；20 秒超时只用于后台；阻塞式摘要路径已删除。
5. 运行时 CREATE TABLE 可以（同 thread_truncations）；threadId 索引加了测试。
6. 加了 mock Hermes 429 切换备用模型的 Python 适配器单元测试（桥的透传 / 回报另有测试）。
7. 读了 Hermes 源码：自带压缩会和我们的叠加，已对宿主压缩过的运行关掉 Hermes 压缩（见 7.1）。

## 10. 风险与后续

1. 适配器依赖 Hermes 内部接口（`_fallback_chain`、`_init_fallback_chain`、`compression_enabled`），Hermes 升级可能改名；已用能力检测 / `hasattr` 兜底，但需在部署的 Hermes 版本上实测一次 429 切换。
2. **后续工作**：跨 provider 的备用模型（不同 base_url / key）。
3. 目前 Hermes 运行的 `RUN_FINISHED` 还不带 provider 用量，所以 Hermes 话题大多走 1.15 安全系数；等桥 / 适配器回报 usage 后校准自动生效。
4. 摘要会丢细节；已用「续写 5 次或超 600 字整段重摘」限制漂移。
5. 第一次超过 85% 的那一轮只裁剪（摘要下一轮才有）；裁剪后仍超窗时由 Hermes 报错（宿主压缩过的运行关掉了 Hermes 自救压缩，换来不二次压缩）。
6. 审计第 3 项（错误分类透传）不在本 RFC 范围。

## 11. 当前进度

审稿决定已全部写进代码和测试，与本 RFC 一起提交；推送 `feat/hermes-fallback-history` 并向 main 开 PR。
