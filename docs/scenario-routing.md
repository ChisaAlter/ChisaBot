# 场景化模型路由

> 状态：分阶段落地中。本文随每个阶段更新「当前接入情况」一节。

把分散在各链路里的模型选择统一成一张**按场景配置**的路由表：聊天、输入建议、行内补全、历史摘要、
记忆抽取、审批审查、子代理、自动化、标题生成、图像理解、自检各自可以独立指定主模型、备用链、
思考强度、超时与输出上限。

## 为什么

之前模型选择分散在多处：自适应难度路由只管聊天主链路；审批审查复用运行时模型；标题、摘要、
图像理解各自为政。结果是低成本场景（标题、补全）和高价值场景（审批审查）无法用不同模型，
用量账本也无法按场景拆分成本。场景化路由把「哪个场景用什么模型」变成管理员可见、可配置、
可观测的一张表。

## 场景全集

| 场景键            | 含义                                 |
| ----------------- | ------------------------------------ |
| `chat`            | 对话每一轮的主模型调用               |
| `suggestions`     | 输入框下一步建议（后续 PR 落地）     |
| `completion`      | 行内补全 / 灰色续写（后续 PR 落地）  |
| `summarization`   | 长上下文压缩与对话摘要               |
| `memoryExtraction`| 从对话抽取长期记忆                   |
| `review`          | 审批卡自动审查与风险评级             |
| `subagent`        | 委派给子代理执行的任务               |
| `automation`      | 定时任务与 webhook 触发的后台运行    |
| `title`           | 会话标题自动命名                     |
| `vision`          | 图片描述与视觉 fallback              |
| `test`            | 设置页与部署后的模型连通性自检       |

场景键是闭集：配置里出现未知键会在保存时被 400 拒绝，防止拼写错误静默失效。

## 配置模型

每个场景六个字段，全部带「继承」语义：

| 字段          | 类型              | 继承语义                                     |
| ------------- | ----------------- | -------------------------------------------- |
| `model`       | string            | 空字符串 = 沿用该场景当前默认模型解析链      |
| `fallbacks`   | string[]（≤ 8）   | 空数组 = 沿用全局备用模型链                  |
| `effort`      | 思考强度档位      | `"default"` = 不覆盖思考强度                 |
| `timeoutMs`   | 1000–600000 整数  | `null` = 不覆盖超时                          |
| `maxTokens`   | 1–200000 整数     | `null` = 不覆盖输出上限                      |
| `useAdaptive` | boolean           | 仅 chat / subagent 有意义：场景内是否仍走自适应难度路由 |

**空配置 = 所有场景继承当前行为**，与升级前完全一致；逐场景、逐字段独立覆盖，不存在
「配了一个场景就改变其他场景」的隐式联动。

## 存储与 API

- 存储：`enterprise_settings` 单行（key `model_scenario_routes`，`{ version: 1, scenarios }`），
  不新建表；回滚到旧镜像时该行被忽略（旧版没有读取方）。
- 缓存：运行时读取缓存 30 秒，保存立即失效。
- API（仅管理员）：`GET / PUT /api/admin/scenario-routing`；非法输入 400 并逐条说明原因。

## 代码位置

| 层         | 位置                                                   |
| ---------- | ------------------------------------------------------ |
| 共享契约   | `shared/model-scenario-routing.ts`                     |
| 存储与服务 | `server/src/agents/model-scenario-routing.ts`          |
| 接线       | `server/src/index.ts`（service 实例、路由挂载、场景合成）        |
| 运行时     | `server/src/agents/dsh-runtime.ts` · `server/src/agents/scenario-connection.ts` · `server/src/chat-files/media-models.ts` |
| 测试       | `server/tests/model-scenario-routing.test.ts`          |

## 当前接入情况

| 阶段 | 内容                                                         | 状态   |
| ---- | ------------------------------------------------------------ | ------ |
| PR1  | 共享契约、校验、存储、缓存、管理员 GET/PUT API               | 本 PR  |
| PR2  | 运行时消费方接入（review / title / summarization / vision / chat） | 本 PR  |
| PR3  | 管理员 UI、Dry-run、按场景路由日志                           | 未开始 |

## 运行时接入（PR2）

空配置下每一处行为与升级前逐字节一致；以下为场景配置了主模型 / 备用链时的生效路径。

| 场景            | 接入点与语义                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `chat`          | DSH 运行时每一轮：场景主模型替换部署默认模型在链中的位置；`useAdaptive:false` 跳过难度分类；`effort` 具体档位覆盖分类结果；`maxTokens` 在窗口推导上限上再取小 |
| `summarization` | 压缩 / 摘要会话（`isSummarizationSession`）改用 summarization 场景链而非 chat 场景；usage kind 记为 `summary`                       |
| `review`        | 审批审查独立 completer：场景主模型 + 备用链按序尝试，任一成功即返回；技能 narrowing 不受场景影响                                     |
| `title`         | 会话标题生成：连接快照的 `defaultModel` 按场景覆盖（无备用链概念，失败由队列重试）                                                   |
| `vision`        | 识图解析：管理员未配置 custom 识图模型时，场景主模型用主连接（仅 OpenAI 兼容形状）合成部署级默认；个人 / 管理员显式配置始终优先        |

刻意未接入：

- `test`：连通性自检测的就是管理员在表单里指定的那个模型，场景覆盖违背自检语义；
- `subagent` / `automation` / `memoryExtraction` / `suggestions` / `completion`：消费方在后续 PR 落地时一并接入；
- `timeoutMs`：chat 主链路没有按次调用超时机制（一轮是多轮工具循环），将在具备机制的消费方（suggestions / completion / titler）接入。

usage kind 扩展：`suggestions` / `completion` / `title` / `vision` / `automation` 已加入 `USAGE_KINDS`，
本 PR 中 `summary` 开始按压缩会话正确记账；其余 kind 随消费方落地产生数据。

## 边界与不做的事

- 只做格式校验；模型是否真实存在、是否支持某个思考档位，由模型目录在使用侧裁决。
- 不取代自适应难度路由：chat 场景的 `useAdaptive` 为 true 时，难度分类仍在场景配置之内运行。
- 不记录任何 prompt / 对话内容；路由日志只写脱敏摘要与决议元数据。
