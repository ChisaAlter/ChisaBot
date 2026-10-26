# 测试与验证

ChisaBot 的测试分四层：**单元 / 集成测试 → 预览容器里的端到端 → 回归套件 → 生产只读检查**。改动越接近聊天和真实数据，越要往后面的层走。
生产安全规则见 [release.md](release.md) §4，部署流程见 [ops/deploy.md](ops/deploy.md)。

## 1. 单元 / 集成 / 类型检查

| 命令 | 范围 |
|---|---|
| `bun run typecheck` | 所有包（`app`、`server`、`agent-computer`、`shared`…）的 `tsc --noEmit` |
| `bun test` / 各包 `tests/` | ChisaBot 功能的服务器测试在 `server/tests/<功能>*.test.ts`（记忆、保险箱、定时任务、确认、设备、云端 CC…） |
| `app/tests/*.test.ts(x)` | 网页 DOM 测试；**需要 `NODE_ENV=test`**（镜像里是 production） |
| `pc/` 下 `npm test` | PC 客户端（含外壳指纹一致性：改了图标 / 安装器要先 `npm run fingerprint`） |
| `android/` Gradle 测试 | 原生 Android（CI 里跑） |
| CI「ChisaBot checks」（`.github/workflows/chisabot.yml`） | 每个 PR 必须绿；`bun install --linker hoisted`（和镜像一样） |
| `pc-shots.yml` | 改到 PC 窗口 UI 的 PR 在 Windows runner 上截图（Windows Server 2025、1024×768、无 GPU：**没有 DWM 圆角**，DPI 用 `--force-device-scale-factor` 模拟） |

比较方法：**分支对比 main 的「新增失败」**，不是要求全绿——main 上有已知失败（§5）。

## 2. 预览容器约定（端到端）

需要写数据的端到端都在**预览容器**里跑，不在生产上（服务器上的搭建方法见 [ops/preview.md](ops/preview.md)）：

- 用**生产镜像（或分支构建的镜像）+ 生产数据库的副本**起一个独立容器，绑 `127.0.0.1` 上自己的端口；每个 worker / 功能用自己的端口和容器名。
- **出网封锁**（或只放行假模型 / 假服务），保证预览里的机器人不会真的发消息、真的调第三方。
- 模型用**假模型**（OpenAI 兼容的 mock，见 `tests/chat-scroll/mock-model.mjs`），需要真模型时用一次性机器人。
- 浏览器用 playwright-core（镜像里的 Chromium），宽 1280 亮色 + 窄 390 暗色是最低覆盖；涉及布局的再加 900 / 1440。
- **一个预览容器只跑一轮端到端，跑完重建**（Bun SQL 问题，见 §5）；不要让两轮重叠。
- 跑完**拆掉**：容器、卷、临时网络、拷进去的源码和数据库副本。
- 可交互原型（给所有者点的）也用同样的隔离沙箱：数据副本 + 出网封锁。

## 3. 回归套件（仓库 `tests/`）

| 套件 | 何时必须跑 | 说明 |
|---|---|---|
| `tests/chat-scroll/regression.sh` | **任何改动聊天 / 同步 / 滚动** | 贴底不跳、发送不跳、轮询、窄屏、失败重发、上滑不拽（wide、narrow、failtwice、narrowfail、polltick、narrowpoll、up）；发送后任何消息被删也算失败。需要一段**长对话复制到预览里的一次性机器人**。见 [README](../tests/chat-scroll/README.md) |
| `tests/realtest/` | 改到机器人能不能把事办成（工具、模型、确认、计算机） | 有界面 Chrome 走真实网页聊天、真模型、一次性机器人：搜新闻、读网页、填表、文件、代码、多步表格、提醒 / 记忆 / 技能 / 网页、长任务，逐项截图（§101）。见 [README](../tests/realtest/README.md) |
| `tests/send-scroll/` | 改发送时的滚动 | 5 分钟规则、带干活卡的连续发送（§94） |
| `tests/bot-state/` | 改按机器人记住的状态 | 面板 / 计算机、草稿、滚动（§88） |
| `tests/open-scroll/` | 改打开对话 | 打开落在最新一条（§83） |
| `tests/fold-narration/`、`tests/quiet-turn/` | 改干活卡 | 中途说明收进卡（§90）、简单回合不出卡（§93） |
| `tests/composer-gutter/gutter.mjs` | 改输入框布局 | 只读的宽度扫描（§92） |
| `tests/mode-switch/` | 改左栏切换 | 机器人 ↔ Claude Code 不重挂（§84） |
| `tests/nav-keep/` | 改外壳 / 路由布局 / 留着的聊天 / 设置里的滚动 | 从设置 / 待处理 / 设备切回聊天不刷新、滚动原样、离开期间藏着的聊天不被挪（§98.5）、流式不断、藏着不轮询（§98）。预览里跑：全新生产库副本 + 假模型，`WIDTHS=1280,390 STREAM=1 SWITCH=1`；调试加 `NAVDBG=1 SCROLLALL=1`。一个预览容器只跑一轮 |
| `tests/native-select/turn.mjs` | 改云端浏览器操作 / 计算机工具 / 回合结束处理 | 原生下拉框快照与选择（API）、真模型选出 2000-07-12、接力 run 500 出「这一轮没有完成」+ 重试、计算机请求 500 后机器人自己恢复（§100）；单元 `agent-computer/tests/native-select.test.ts`（`CHISABOT_COMPUTER_BROWSER=1` 跑真 Chromium）、`server/tests/computer-tool-outcome.test.ts`、`app/tests/turn-unfinished.test.tsx`。见 [README](../tests/native-select/README.md) |
| `tests/rail-computer/` | 改右栏 | 空聊天也有「计算机」（§79） |
| `tests/ui-align/` | 改字体 / 按钮 / 标签 | 文字垂直居中审计（§82） |
| `tests/chat-concurrency/` | 改回答中发消息 / 后台任务 | §38 |
| `tests/cloud-cc/` | 改云端 Claude Code / 同步 | 含 Linux 上的 PC 替身 `sync-pc-standin.cjs` |
| `tests/dialog-close/` | 改弹窗 | 关闭性能探针（§37） |
| `tests/smoke/` | 冒烟 | `bun run test:smoke` |

## 4. 生产检查（只读）

上线后：

1. `/api/version` 的提交号是你的；更新器 `request.sh status` 成功。
2. **管理员自检** `POST /api/admin/smoke`（或设置 → 系统更新 →「自检」）：随机两位数加法，模型回答非空即通过，不保存任何东西。
3. **生产快照**对比（上线前后）：线程数、机器人数、设备数、用户数、关键设置哈希、新表行数——除镜像 / 版本外一致。
4. **只读浏览器检查**：临时签发一个会话 → playwright 打开页面，**拦截所有非 GET 请求**（本地返回 204），有副作用的 GET（如第一次读收藏夹会写种子、
   `/api/computers/*`）也在本地伪造，WebSocket 本地关闭 → 断言页面 / 接口 → 删除会话。
5. 必须真写的生产 e2e（少数情况）：一次性机器人 + 临时会话，跑完用守卫脚本删除，并核对快照。

## 5. 已知问题与不稳定测试

| 问题 | 现象 | 处理 |
|---|---|---|
| **Bun 1.3.x SQL 连接错位（已加恢复，CB-087）** | 旧预览在事务 EOF 后出现 `bind message supplies 1 parameters, but prepared statement "" requires 8`，随后请求等待不结束；未证实生产发生 | SQL 监督层对协议错误/连接关闭立即淘汰故障池，查询及池等待有期限，取消未完成工作；失败请求不重放，新请求用新池。真实 PostgreSQL 与协议 fixture 覆盖静默连接、未确认 COMMIT、池等待及恢复；预览仍按一容器一轮保持隔离 |
| `approvals-rules.test.tsx` / `approval-tools.test.tsx` | main 上 2 个失败（「等待点击并入浏览器活动」DOM 用例），不是新改动引起；有时表现为超时 | 对比 main 时视为基线；修复待办 |
| app 全量测试中的上游英文用例 | 按文件跑时约 45 个上游测试文件在 main 上就失败（英文界面时代的文案断言） | 基线，不在范围内 |
| 全量跑时测试相互污染 | 个别改名后的测试在全量里失败、单独跑通过 | 单独复跑确认 |
| chat-scroll 节点替换与结束跳动（CB-087） | 基线七项出现旧消息重挂；结束留白按墙上时间追赶，慢帧倒退 | 渲染前协调窗口、稳定平级 keyed children、每帧有界收白；原七项严格阈值不变，整合构建复测并留 DOM reference / 逐帧数据。reduced-motion 额外覆盖宽窄屏；对应组件测试独立进程避免 Motion 媒体偏好缓存污染 |
| 长对话历史晚到（CB-047） | 冷预览上第一次打开超长对话，历史约 20 秒后到 → 偶发滚动回归 | 预热后再跑 |
| `live-screen-keyboard` Dvorak 用例 | 偶发失败，复跑通过 | 视为不稳定 |
| 冷启动第一个浏览器上下文 | 只读检查里客户端可能发两次 connect，被拦截后对话显示为空 | 测试脚本的已知假象，不代表生产问题 |
| CI 上 PC 测试 | 依赖平台的检查（如 sing-box 用例）曾让发版构建失败 | 发版前先跑一次只构建的 dispatch |
