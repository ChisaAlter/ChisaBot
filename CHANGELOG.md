# Changelog

## 0.1.41 — 2026-10-19

### 生产成熟度 · 截图 503 根因（LiveScreen ↔ HTTP 协调）

- **根因**：LiveScreen CDP screencast 与 HTTP `page.screenshot` 抢同一页面 → 超时/502 → 网关 opaque 503，大屏仍像健康直播。0.1.40 只停了展开时的客户端轮询。
- **agent-computer**：`capture-gate` — 直播中 HTTP `/screenshot` 立刻 503+`captureBusy`+`liveCast`（不打 CDP）；并发 HTTP 截图串行，第二路同样 busy；截图超时改 422+`pageTimeout`（15s 上限）。
- **网关**：`CaptureBusyError` 透传标志；422→`PageTimeoutError`。
- **UI**：识别 `liveCast` / `captureBusy` / `pageTimeout` 中文；liveCast 立刻停轮询；失败仍清帧（DOG-05）。
- 电车仍暂停。未改 PC / Android 外壳。

## 0.1.40 — 2026-10-19

### 生产成熟度 · 狗粮摩擦（v0.1.39 冒烟）

- **计算机截图 503 诚实**：大屏展开时停 HTTP `/screenshot` 轮询（LiveScreen 出图），避免与流双打导致 503 刷屏却仍像健康直播；失败退避上限 30s，连续 5 次失败暂停自动轮询等「重试」（对齐 DOG-05 清帧）。
- **暂停定时陈旧确认**：`paused` + `waiting` 改写为「暂停前在等确认 · 已暂停，不会自动继续」；主按钮隐藏「立即运行」（菜单仍可手动跑）；从不 auto-resume 电车。
- **已删机器人定时清理**：`DELETE /api/schedules/orphans` 硬删任意状态孤儿；扫周期 purge；设置页进页自动扫 + 一键可靠清理；孤儿判定含隐藏机器人（只清真删除）。
- **安装胶囊**：顶距 48→56px，减轻压住对话首行。


## 0.1.39 — 2026-10-19

### 生产成熟度 · PRD-P0-02 Magpie/边车隔离

- **网络隔离**：`scripts/ops/isolate-sidecar-app.sh` 在 `DOCKER-USER` 对 Magpie 及同网边车 **DROP → app:3001**（注释 `chisabot-sidecar-iso`）；App→Magpie `:3425`/`:3430` 保持畅通。
- **br_netfilter**：同桥流量必须 `bridge-nf-call-iptables=1`；`--apply` 会 modprobe 并写 sysctl.d / modules-load.d。
- **部署**：`deploy-serial` 默认 `--apply` + `--verify`（失败退出 8）；`deploy/magpie-isolate.service` 开机重放；`start.sh` root 时顺带 apply。
- **CI**：`isolateScriptCoversSidecarDeny` + trust-boundary red-line；`check-trust-boundary.sh` 校验脚本存在。
- **文档**：`docs/ops/trust-boundary.md` §5.1 who-can-reach-whom；production-checklist §9b。
- 电车仍暂停；多用户 UI 仍 opt-in；未强制卸下 shared Docker 网（可选人工拓扑，见信任边界文档）。

## 0.1.38 — 2026-10-19

### 生产成熟度 · 发送恢复诚实 + 弹窗毛玻璃

- **failed-send-attachments**：失败发送后附件 / 队列恢复 3 条路径转绿。频道 harness 补 `/api/bot-threads` 404（与生产频道「无 sync」一致，断线结算立即 `lost`）；失败 fixture 用 HTTP 500（非 502/503/504 连接断开类），恢复路径诚实、无假成功。
- **CB-029 / DESIGN §37.3**：弹窗・抽屉・菜单・popover 内容层静止后 `backdrop-filter: none`（底色已是 glass-3）；遮罩保留轻 blur + glass-hold。钉死 `glass-hold-panels.test.ts`。

## 0.1.37 — 2026-10-19

### 性能 / 测试

- **PRD-P2-03 / CB-025**：长对话首屏先挂最后一屏（`tail-first-paint`），rAF 分批往前补；上滑保留 scrollTop；`?message=` 仍靠 MessageFind 轮询。不做虚拟列表 / 不用 content-visibility。
- **测试漂移**：作曲器附件断言对齐产品中文（`移除` / `附件` / `队列消息` / `驳回此拒绝` 等）。

## 0.1.36 — 2026-10-19

### 生产成熟度 · P2 诚实 UI / 中文一致 / 日志脱敏余量
- **PRD-P2-01**：活动页状态中文 + 失败显眼；定时 run 卡死超过 20 分钟按失败展示（不再永远 busy）；已删机器人下的 active/paused 定时扫周期自动取消（从不 auto-resume）；Claude Code 零回合空闲会话标「空草稿」
- **PRD-P2-02**：作曲器附件拒绝/合并/超量文案与 `picked-files` 拒因中文化
- **PRD-P0-05 余**：更多 console 路径走 `reasonWithoutStatement`；CI `log-scrub-redline.test.ts` 红线

## 0.1.35 — 2026-10-19

### 生产成熟度 · 狗粮摩擦（浏览器 E2E follow-ups）
- 「已停止」锚点：服务器 `stoppedTurns` 与 fallback 一样从 RUN_STARTED 输入的**最新**消息往回找用户行（修 Math.min 误挂上一轮）；停止时跳过定时/任务等非人发 user 行；折叠行仍画出停止标记
- 安装横幅：仅可安装时出现；× 永久关掉；安装取消/超时 14 天 snooze（不再每个会话盖住聊天）
- 复制 / 重新生成：无障碍树单一 live `aria-label`，叠层文案 `aria-hidden`（不再堆「复制/已复制/复制失败」）
- 附件文件选择：隐藏 `input[type=file]` 可访问名为「选择文件」

## 0.1.34 — 2026-10-19

### 生产成熟度
- nginx 模板与生产同步：`sync-nginx.sh` apply-or-fail；deploy-serial 漂移检测；CI check-repo（#233）
- 非电车定时复验：fail→pause、stuck reclaim 计入连续失败、paused 永不 auto-resume；`partitionScheduleList`；电车仍暂停

## 0.1.33

### Added
- Trust-boundary network isolation: nginx clears Local-Caller; friend-up/start deny-by-default port binds; TRUSTED_ORIGINS loopback-only; CI `trust-boundary-redline`; `scripts/ops/check-trust-boundary.sh`; post-deploy anonymous admin-health 401 check; expanded `docs/ops/trust-boundary.md`.

### Notes
- Tram schedules stay paused. Multi-user accounts UI stays opt-in. No live CUTBACK_EXECUTE.

## 0.1.32

- Ops maturity **metrics timeseries + traffic-cut rollback**: minute-ring budgets with `rates` / `series` on `GET /api/admin/health` and scrape `GET /api/admin/health/budgets?hours=…`; file persist `/workspace/.chisabot-ops/budgets.json` (no managed SaaS). `scripts/ops/cutback.sh` dry-run by default (`CUTBACK_EXECUTE=1` to cut); `KEEP_IMAGES` default 5; RTO ~2–5 min in `docs/ops/traffic-cut-rollback.md`.


## 0.1.31

- Production maturity **send honesty + MCP abort**: `decideSendWatchdogAction` + automated tests that timeout/unpersisted/reply-hang never look like success; MCP SDK `AbortSignal` on connect/callTool; `grantedTools` honours Stop and suppresses late success; Drive merges abort; Composio/builtin entry-check (mid-flight vendor SDK limits documented).

## 0.1.30

- Production maturity **Track D** (friend pack + safe defaults): `deploy/friend-up.sh` one-click compose with loopback bind / no public single-user TRUSTED_ORIGINS; Better Auth Secure cookies when https public URL or `CHISABOT_SECURE_COOKIES`; `start.sh` refuses `0.0.0.0` app binds.
- UX: 设置 → 分享给朋友；机器人列表一点开聊（正确 bot 上下文）；docs/friend-deploy.md。

## 0.1.29

- Production maturity **Track B** (stability): hung-turn stop clears busy + force-unlock; 25min wall-clock abort; periodic expired lock sweep; connect snapshot capped by count/bytes for long threads.
- Schedules: reclaim stuck `running` (>20m) during sweep; auto-pause after 3 consecutive failures (never auto-resume); settings UI「需要关注」+ orphan live cleanup for deleted bots.

## 0.1.28

- Ops maturity (PRD-P1-02…06): process-local SEND/STREAM/SSRF error-budget counters on `GET /api/admin/health` (`budgets`); client beacon `POST /api/ops/budget`; `guardedFetch` / computer-stream proxy bump on deny/disconnect.
- CI SSRF red-line suite (`server/tests/ssrf-redline.test.ts`) — redirect→internal + mapped IPv6 must stay green.
- Docs: gateway/node trust-boundary diagram; recorded backup/rollback dry-run on Haupt (`docs/ops/backup-rollback-drill.md`).

## 0.1.27

- Hotfix ops health: computer probe uses real bot ids from `list()` (fake `__ops_health__` caused agent-computer 500); post-deploy smoke parses top-level `ok` only.

## 0.1.26

- Ops maturity (PRD-P1-01…03): `GET /api/admin/health` aggregates app/version, DB ping, Magpie, computer node, Local-Caller for monitors.
- Post-deploy hard smoke (`post-deploy-smoke.sh`) runs from updater `health.sh` after image swap; fails deploy (rollback) on version/capabilities/aggregate red. Model smoke stays advisory unless `STRICT_MODEL_SMOKE=1`.
- Docs: `docs/production-checklist.md`; monitoring/deploy/incidents playbook stub; `request.sh smoke`.
- Structured ops codes starter in `shared/ops-codes.ts` (`OPS_HEALTH_*`, greppable JSON lines).

## 0.1.25

- Production hardening: live computer stream keepalive (protocol sendPings + application `{type:ping}` through the proxy) so a static page + idle viewer is not dropped at 120s (CR-P2-12).
- SSRF leftovers: OAuth token/registration URLs refuse private/metadata hosts; media-model fetches default to `redirect:"error"` so API keys cannot follow a 302.
- Log scrub: cloud-cc / sync / oauth / passwords error paths use `reasonWithoutStatement`.
- Honesty: screen disconnect copy in Chinese; `/api/version` smoke test asserts no secret leakage; ping resets live-screen retry budget.

## 0.1.24

- Bot egress floor denies RFC1918 / loopback even under `allow_all` (aligned with navigation).
- Honest UI: search errors, install-hint cancel, deep-link keep-alive, late page-frame retry.
- Hardening: MCP resolve check, stream proxy errors, preview browser cache, Secure cookies on https, vault POST via guardedFetch.


What changed, for somebody deciding whether to upgrade. Written for the person running OpenBot, not
for the person who wrote the commit: a line belongs here when a deployment behaves differently
afterwards, and does not when only the code moved.

Newest first. `Unreleased` is what is on `main` and not yet tagged.

## Unreleased

- 代码审查安全批（#215，v0.1.23 / CR-P0-01…P1-03）：图片下载与 web_fetch 统一走 `guardedFetch`（钉死 DNS、逐跳拦 SSRF）；网关模式下本机管理员须带 `X-ChisaBot-Local-Caller`；发消息已落库后的第二段等待封顶，避免 composer 永久卡住。PC / Android 外壳未变，版本号对齐到 0.1.23（Android vc 229）。

- 计算机陈旧截图不再当直播（#214，v0.1.22 / DOG-05）：截图失败清帧 + 中文占位/重试；「在用浏览器」仅在有计算机活动时；空闲写「浏览器空闲」。PC / Android 外壳未变，版本号对齐到 0.1.22（Android vc 228）。
- Ctrl+K 正文命中深链到消息并高亮（#213，v0.1.21 / DOG-04）：`?message=<id>` + MessageFind（scrollIntoViewWithin + message-flash）；KeepAlive 地址键不含 message。PC / Android 外壳未变，版本号对齐到 0.1.21（Android vc 227）。
- 活动记录中文工具名/拒因 + 安装横幅不挡标题（#211，v0.1.20 / DOG-02/03）：审计页 computer_* 映射为打开网页/填写/运行命令等；接管英文拒因译中文；横幅显示时正文让位，安装失败/超时/关闭均永久记住。PC / Android 外壳未变，版本号对齐到 0.1.20（Android vc 226）。
> **按版本看**：下面这一节从 0.1.7 之后一直累积，实际已经分别随 v0.1.8 … v0.1.19 发布（服务器改动合并即上线）。
> 每条属于哪个版本、哪个 PR，见 [docs/CHANGELOG.md](docs/CHANGELOG.md)（按发版标签分组）。

- 发消息假成功深挖（#212，v0.1.19 / DOG-01）：connect 改消息快照（不再 ~825KB 事件回放）；12s send watchdog；发送中可停、抑制 sync 重接。v0.1.18 只覆盖隧道 drop，实机 sync 通时仍会静默。PC / Android 外壳未变，版本号对齐到 0.1.19（Android vc 225）。
- 发消息隧道挂掉不再假成功（#210，v0.1.18 / DOG-01）：sync 一路问不到时约 10 秒内提示「可能没发出去」并恢复草稿；识别 ERR_TUNNEL_*；问到过服务器后仍保留重启长等。
- UX P1–P3 全量体验（#209，v0.1.17）：接管「交还」可点、重启后控制权可重置；失败浏览不计「看了 N 网页」；设备列文件区分云端工作区与用户电脑；定时进聊天用绝对日期、侧栏相对时间刷新；活动记录中文与换行；安装横幅可永久关掉且接管时隐藏；干活卡标失败步；Claude Code 会话可归档删除；已删除机器人下已结束定时可一键清理。FIX-13/14 由 #208 快失败覆盖。只改服务器 + 网页，没有表结构变化；PC / Android 外壳未变，版本号对齐到 0.1.17（Android vc 223）。
- 定时 / 搜索 / 停止 UX P0（#208，v0.1.16）：定时任务跑完后按正文归类为等待确认 / 跳过 / 失败 / 成功，不再一律绿「已完成」；定时与 IM 触发的无人值守回合碰到要登录、要密钥、要你接管浏览器时立刻失败并清掉对话锁（不再挂死频道、灰掉发送）；Ctrl/⌘K 能搜消息正文并高亮摘要；点「停止」会取消进行中的联网搜索 / 打开网页等工具。只改服务器 + 网页，没有表结构变化；PC / Android 客户端外壳未变，版本号对齐到 0.1.16（Android vc 222）。
- 机器人能选原生下拉框、回合不再静默结束（DESIGN.md §100）：云端浏览器的快照把原生 `<select>` 的选项收进这个下拉框（`options`），机器人用「填写」（`computer_type`）填选项文字或值就直接选中（月份写 7 / Jul / 七月都行），点下拉框不再弹出系统列表把后面的操作卡住，下拉框里没有的选项会回 400 并列出可选项。计算机操作的普通失败（元素过期、找不到、没有这个选项、电脑暂时不可用）现在作为「没做成」的结果交回给机器人接着做，不再让 `POST /api/approvals/computer/:bot` 回 500、让这一轮停在半路；一轮做到一半停下、接力的某一步出错、或回复是空的，聊天里都会出「这一轮没有完成 / 没有做完」卡片和「重试」。启动日志 `computer-isolation` 的文案改为如实说明「每个机器人有自己的浏览器配置，共享进程和 /workspace」。只改服务器、网页和电脑服务代码（随服务器镜像更新），没有表结构变化；PC / Android 客户端不用更新。

- 设置重新整合 + 设置搜索 + 输入框权限（CB-083，DESIGN.md §97，docs/settings-ia.md）：设置左栏按「通用 · 机器人 · 电脑与设备 · 账号与连接 · 模型 · 系统」重新分组排序，「审批偏好」改名「权限与审批」并放进每个机器人的权限；所有页面地址不变。左栏顶部加了设置搜索（Ctrl/⌘ K 或 /），能搜页面和页面里的设置项（中文、拼音首字母、英文都行），跳过去会把那一块滚到中间并闪一下。聊天输入框「+」后面加了权限开关：「请求批准」（在电脑上运行命令、改文件、装软件前始终先问）/「完全访问」（橙色，直接做，允许的文件夹以外也自动加进去）；按机器人存在服务器、由服务器执行，打开完全访问要确认一次并记进活动记录；付款、关闭的设备能力、紧急停止、管理员身份运行等照旧拦着。没单独设过的机器人沿用原来的「操作你的电脑」偏好，行为不变。新表 `chisabot_bot_permissions`（开机建表，只新增；回滚镜像即可）。PC 客户端不用更新。
- 连续聊天时发消息不再整页上跳（CB-080，DESIGN.md §94）：以前每发一句，整段对话往上翻一页——刚发的那句被拉到顶上、下面留一屏空白，刚读到的回答被推走。现在上一条消息发出不到 5 分钟（一来一回聊着）时，新消息就出现在底部、对话跟着回答往上长，不翻页、不留空白；隔了 5 分钟以上（或这段对话第一句）照旧把新的一轮对齐到顶上。时间以服务器记下的发送时刻为准（新的只读接口 `GET /api/copilotkit/threads/:id/sent-at`），刷新后、换设备也一样。顺手修了：刷新后回到留着空白的对话再发一句时先往回跳一下；输入框打字长高时最后一行被盖住一帧；连续聊天里带干活卡的那一轮，卡片收起 / 回答多出一行时整段对话往回挪 5–45px 的那一下（底下的留白改成跟着内容同一次布局变，DESIGN.md §94.6）。只改网页 + 一个只读接口，没有表结构变化。
- 浏览器暗色图标 + 外侧去掉标签 + 放大页重排（CB-082，DESIGN.md §96）：暗色主题下 GitHub 这类黑色网站图标、深色字母块在标签栏、收藏栏、「收藏夹」下拉和管理面板里垫一块浅色小底板，不再黑上加黑（按图标本身的亮度判断，不是站点名单）。右栏「计算机」小画面上面不再有标签条，标签只在放大的浏览器里。放大的浏览器重排：标签栏、地址栏、收藏栏合成一块工具条，标签像 Chrome 一样坐在工具条上，「+」紧跟最后一个标签，关闭按钮在标签栏右端；屏幕按窗口剩余高度等比缩放，卡片永远不出滚动条，底栏「你正在控制浏览器 · 交还」始终在卡片里；手机上整屏显示。只改网页。
- 简单回合不出干活卡（CB-079，DESIGN.md §93）：像「看看我的电脑」这种只用了一两个只读工具（列设备、截屏、看文件列表、翻记忆…）、几秒钟就答完的一轮，结束后不再留「✓ 做了 2 步 7 秒」那一行，开场那句「我来查看…」也不再单独一个气泡，只剩回答和截图（干活时卡片照常显示；跑命令、改文件、上网、出错、要确认、超过 3 步或 15 秒的照旧保留卡片）。有卡片的一轮里开场那句收进卡片（点开在最前面）。回答里单独一行的图片不再多出一个空的小气泡。一轮答完后回答下面不再留一大块空：对话平滑落到正常底边距，刷新后也一样。只改网页。
- PC 本机小窗口无边框、圆角、只有一道边（PC 0.1.15，DESIGN.md §91）：「登录 ChisaBot」窗口不再是 Windows 原生白标题栏 + 系统边框，天空铺满到边、四角圆角（透明窗口由页面裁 8px 圆角，Windows 10 / 11 一样；不用系统窗框，因为它在 125% / 150% 缩放下会露浅色边），按住顶部拖动，右上角只有最小化 / 关闭，固定大小。审批（「需要你确认」）、本机确认、更新提示不再是「窗口边 + 卡片描边」两圈，整个窗口就是对话框；审批说明框按内容定高（最多约 8 行，再多框内滚动），窗口按内容定高、量好再显示。只改 PC 客户端（`pc/src`），外壳指纹不变，0.1.14 原地更新。新增 Windows 截图工作流 `.github/workflows/pc-shots.yml`。
- 窄窗口里输入框两边也留白（CB-078，DESIGN.md §92）：左栏展开的 700–1100px 窗口、1280 宽右栏展开、手机上，聊天输入框以前左右贴着左栏卡和窗口边（0px），消息却有留白。现在输入框左右至少 16px、底边 16px；右边有「面板」把手时让开把手，和消息列对齐；宽屏还是 672px 居中，和以前一样。Claude Code 会话页输入框左边从 4px（手机 10px）改成 16px。只改网页。
- 机器人浏览器多标签 + 收藏夹（CB-081，DESIGN.md §95，docs/browser-tabs.md）：「ChisaBot 浏览器」现在有标签栏——机器人和你看到同一组真标签（最多 8 个），接管后可以切换、关闭、新开，只看着时也能看出机器人在哪个标签上；右栏小画面上面也有一条。浏览器重启后恢复上次开着的标签。地址栏加了星标，下面是收藏栏（窄屏「收藏夹」下拉），可以改名、改网址、拖动 / 上下移排序、删除；收藏夹每个账号一份、所有机器人共用，第一次使用时放进新标签页原来的五个网站，新标签页上的常用网站就是收藏夹前 12 个。机器人多了 `computer_tabs`、`computer_bookmarks` 两个工具（只有你明确要求才改收藏夹）。新表 `chisabot_browser_bookmarks` / `chisabot_browser_bookmark_seeds`（开机建表，只新增；回滚镜像即可）。电脑服务代码随服务器镜像一起更新，不用换云端浏览器镜像。
- 中途说明文字收进干活卡、断线重接不再写两遍（CB-077，DESIGN.md §90）：机器人在两步之间说的话（「检查结果显示没装，我先用 winget 装」）以前在这一轮出错 / 被停 / 被中断、或者还在跑时，散在「✓ 做了 3 步」下面成一段淡色字；现在下一步一开始就收进卡片，这一轮没有结果时剩下的也收进去，点开卡片在步骤之间能看到它们；真正的结果照旧是气泡。本机的流断了（「暂时连不上模型服务」）而服务器还在回答时，重新接上后同一段话不再出现两遍（工具参数、工具结果也不再多一份）。Android 原生同样的收起规则。只改网页 / Android 代码，不改服务器。
- 「模型老断」修好了（CB-076，DESIGN.md §89）：以前机器人在电脑上跑几分钟的命令（比如 winget 装 Node.js）时，网络抖一下或服务器正好在更新，聊天里就是「暂时连不上模型服务」、那一步一直转、发出去的话被放回输入框——其实模型没出错，服务器那一轮多半还在跑。现在：浏览器这头断线时先问服务器，还在跑就自动接上、不报错，答完了就读回答案，只有服务器也没了才说「和 ChisaBot 服务器的连接断了」并把没完成的步骤收起来；断线后不会重发、不会把设备命令再跑一遍。服务重启时被打断的那一轮，开机自动补完并写明「服务刚才重启了」。更新器切换前先等正在回答的对话结束（最多 15 分钟，`DRAIN_SECONDS`；更新器脚本在下一次成功更新后自动换上）。没有表结构变化，回滚镜像即可。
- 每个机器人记住我的操作状态、消息不再往回跳（CB-075，DESIGN.md §88）：右栏「面板 / 计算机」、右栏展开和宽度按机器人记住；输入框草稿（含 @ / 命令小块）、滚动位置、干活卡展开按对话记住——去设置、切别的机器人再回来、刷新都还在（只存在这台浏览器的 localStorage，不上传）。一轮结束时最后一行变矮不再先画一帧往回跳；回到缓存的对话不再丢掉新一轮下面的留白；历史里的旧用户消息不再被对齐到顶上。失败但已经有回答的一轮算发出去了：输入框清空，「重试」重新生成。只改网页。
- 长对话里的图片不再加载时把消息推开（CB-071 后续，DESIGN.md §83.2）：以前网慢时第一次切到带图片的长对话，图片加载那一下整段对话会被顶上去一两帧再回到底部。现在服务器在存图（上传附件、聊天上传、机器人画图 / 改图 / 交付文件、链接预览转存图片）时读出宽高，读对话时随消息给网页，网页先按比例留好框。以前存的图第一次被读到时现算并记下。新表 `chisabot_image_dims`（开机建表，只加不改；回滚镜像即可，表留着无害）。消息 part 的 `metadata.width/height`、工具结果文件清单的 `width/height`、链接预览的 `imageWidth/imageHeight` 都是新增字段，旧客户端忽略。
- Android 原生第二轮（Android 0.1.14，DESIGN.md §86）：确认卡片（删除 / 发消息 / 付款 / 操作电脑，确认 · 取消 · 以后这类直接做）和云端浏览器的审批原生画在聊天里；可以发照片、拍照、发文本类文件（选了就上传，带进度和失败重试）；回答时可以停止；回答下面「重新生成」、最后一条消息「编辑」后重发（服务器截断，所有设备一致）；定时任务 / 后台任务结果 / 确认后接着做画成一行小字；原生设置：外观（跟随系统 / 浅色 / 深色）、账号与服务器、设备列表（只读）。图片在加载前按宽高留好位置。不改服务器。
- Claude 上游代理支持节点链接（CB-073，DESIGN.md §85）：设置 → 云端工作区 →「Claude 上游代理」除了 http / https / socks5，还能粘贴 `trojan://`、`vless://`（含 Reality / Vision）、`vmess://`、`ss://`、`hysteria2://` / `hy2://`、`tuic://` 链接。打开「用 sing-box 转换此链接」才能测试和保存：云端节点容器里起一个 sing-box，把节点转成只听 127.0.0.1、带随机密码的本地 socks5，Claude Code 和云端登录浏览器访问 Claude 的流量走它（其他网站照旧直连，和普通代理一样）。保存前先起好，起不来就不保存；保存后自动测一次并显示出口 IP 和国家 / 地区。页面只显示 协议 · 主机:端口 · 节点名，原链接加密存在保险箱。**需要新的云端节点镜像**（`deploy/cloud-node`，装了固定版本、校验过 sha256 的 sing-box 1.14.3）；旧镜像页面会提示更新，普通代理不受影响。没有表结构变化。
- 修「Claude 上游代理」的「测试连接」和登录浏览器的出口检查：它们其实一直没经过上游代理（Node 在 `agent: false` 时忽略 `createConnection`，悄悄直连），所以填了不通的代理也显示「连接正常」，节点链接保存后显示的出口 IP 也是服务器自己的。Claude Code 本身的流量不受影响（一直经转发器走上游）。只改云端节点代码（`pc/src/cloud-cc`），部署后要 `docker restart chisabot-cloudnode`。
- 机器人 ↔ Claude Code 原地切换（CB-072，DESIGN.md §84）：管理员左栏「机器人｜Claude Code」每切一次整个窗口闪一下（外壳整个重挂，第一次还会闪一帧整屏骨架），切回机器人左栏全部重读。现在两边共用一个外壳，顶栏和左栏容器不动，只有左栏内容交叉淡入、主区淡入一次；左栏两块都留着（滚动位置、展开的工作区还在），空闲 / 指针移上来时预取对面；切回机器人回到上次那条对话，切到 Claude Code 回到上次的会话。PC 客户端不用更新。只改网页。
- 设备状态标签居中（CB-070，DESIGN.md §82.6 补）：文泉驿正黑下「在线」「2 台在线」「成功」「完全访问」这类小标签（设备页、系统更新、IM、本机代理）里的字不再偏上 1px。只改网页。
- UI 对齐第二轮（CB-070，DESIGN.md §82.6–§82.10）：文泉驿正黑（Linux / 部分电脑默认中文字体）下，下拉框里的字、下拉菜单项、设备页能力标签（「截图·询问」）、审批「先问我 / 直接做」、消息下的「复制」不再偏上 1–2px；字体不支持半角标点时「检查（不生成图片）」「粘贴授权码（备用）」这类以括号结尾的按钮字不再偏左。一轮回答结束时，中间那句过程话不再一下子消失（下面的结果往上一跳），而是 0.2 秒收起。窄窗口 / 手机上右边缘的「面板」把手不再压住用户消息下的「编辑」和气泡右沿（手机上把手收窄到 24px）。只改网页。
- 电脑文件夹导入失败后残留、移除后无法重新导入（CB-074，DESIGN.md §87）：「电脑上的文件夹」第一次报错时左栏还会多出一个工作区，删掉后再导入同一个文件夹被「这个文件夹已经在同步一个工作区了」挡住。根因三处：节点重启后同步边车留在旧的网络命名空间里（连不上，全部失败）；新建失败不撤销；删工作区不拆同步（服务器的绑定 / 租约和电脑本机的记录都留着）。现在：新建 / 开启同步前服务器先探边车，连不上直接报错、什么都不建；主机装了边车看门狗（`chisabot-cloudnode-syncwatch.timer`，节点重启后自动把边车拉回同一个命名空间）；删工作区把绑定、租约、公钥、隧道一起拆掉并通知电脑；服务器启动时清掉已删工作区留下的记录。网页：选到一个以前同步过、工作区已删掉的文件夹时显示「解除旧的同步并重新导入」（已装的 0.1.13 / 0.1.14 也能用），新建失败会撤销留下的工作区并给中文原因，按钮变「重试」；弹窗底栏「取消」和「上传并创建」一行靠右。PC 客户端（0.1.15 起）：新建失败自己撤销，启动 / 收到通知时对账放下已删工作区的本机记录。没有表结构变化（只删孤儿行），回滚镜像即可。

- 按钮里的字居中、干活卡上下留白（CB-070，DESIGN.md §82）：设备页「生成安装命令」按钮的字不再被挤出按钮（容器的 `span` 样式伸进了按钮）；设置左栏「个人 / 管理」折叠按钮上下对称；「检查（不生成图片）」这类以全角括号结尾的按钮字居中（控件标签用半角标点）；同一排按钮同高；输入框放不下的占位文字收成「…」；空状态里的按钮不再贴着说明。聊天里干活卡 / 收成的「✓ 搜索 1 次 · …」一行和上面的确认卡、浏览卡之间留 10px，不再贴着。新增测量脚本 `tests/ui-align/`。只改网页。
- 打开对话落在最新一条、切机器人秒开（CB-071，DESIGN.md §83）：网慢 / 手机慢时，打开长对话常常停在中间某条旧消息、一路卡着滚——历史一段段到，被当成「刚发的一轮」对齐到顶上。现在恢复完成前不画回放的半截（先画上次看到的样子 / 先读到的存储 / 骨架），恢复期间和之后 2.5 秒钉在最新一条（图片加载撑高也在同一帧回到底部，看过的图片先按尺寸留好位置），人一滚就交回。切机器人时先画这台设备上次看到的那段对话，对话详情用左栏那一行先画，空闲 / 悬停时预取左栏前几个机器人的对话，切回来不再重读机器人资料、模型、组件、插件。服务器：接入回放不再每轮重传系统上下文、工具定义和前面的消息（35 轮的对话 3.4 MB → 0.23 MB），客户端得到的消息不变。没有表结构变化，回滚镜像即可。
- 机器人资料一张表 + 圆形头像（CB-069，DESIGN.md §81）：新建机器人、资料页「编辑」、管理弹窗「通用」现在是同一个表单——头像 · 名称 · 职责 · 它做什么，编辑时看到的就是新建时写的（「它做什么」原样存成提示词，不再前后补字）。头像可以上传图片（圆形取景框里拖动、缩放，存成 256×256）、选表情 + 底色、或用名字首字 + 底色；所有地方的机器人头像都是圆的。没设置过的机器人保持原来的花纹。新表 `chisabot_bot_avatars`（开机建表，回滚镜像即可，回滚后头像回到花纹）。见 `docs/bot-avatars.md`。
- 机器人读允许的文件夹之外的地方（PC 0.1.12 + 服务器）：以前让机器人看 `C:\AI` 这类不在「允许的文件夹」（默认桌面 / 文档 / 下载）里的路径，审批卡只写「列出：C:\AI」，批准后 PC 还是报「路径不在允许的文件夹内」。现在卡片写明「C:\AI 不在允许的文件夹里；批准后会把它加入允许的文件夹」，批准就加进去并立刻执行（审计 `roots_added`）；拒绝什么都不加。能力是「允许」或审批偏好是「直接做」时，碰到文件夹之外的路径也会先问。服务器端检查，已装的 PC 客户端也生效。见 docs/pc-node.md §5。
- PC 图标换不过来（PC 0.1.12）：重新安装后桌面 / 开始菜单 / 任务栏还是旧图标——Windows 按图标文件路径缓存，exe 路径不变就一直用旧图。快捷方式和窗口图标现在指向安装目录 `resources\icons\chisabot-<哈希>.ico`（新路径，必然重新读取），小尺寸存 BMP 并补齐 20 / 40 / 96；客户端每次启动检查所有指向自己的快捷方式（包括改过名的、任务栏固定的、指向旧安装位置的）并修好。外壳指纹变了：0.1.11 及更早的客户端这次更新会提示「此更新需要重新安装，以更新图标/组件」。见 docs/online-update.md §2.1。
- 空聊天也有「计算机」（DESIGN.md §79）：刚建好的机器人、或点了「新话题」还没发第一条消息时，右栏只有「面板」、没有「计算机」；现在和已有对话一样是「面板 | 计算机」两个标签（手机抽屉里也是）。计算机开着时发第一条消息，新对话里计算机继续开着。只改网页。
- Android 原生版（CB-068，DESIGN.md §80）：Android 客户端从网页外壳换成 Kotlin + Jetpack Compose 原生应用——登录（扫码绑定 / 账号密码）、机器人列表、聊天（流式回复、干活卡、短气泡、表格 / 代码 / 文档卡 / 图片 / 链接卡 / render_ui 卡片）、面板（只读）都是原生的，打开更快、滑动更顺；设置、管理、Claude Code 等还没做成原生的页面在应用里用网页打开，同一个登录。从旧版在线更新过来不用重新登录（同一个签名、同一份会话）。不改服务器。
- 文档卡 + 提示词第三版（Hark 第六轮，DESIGN.md §76）：长的总结、说明、学习笔记、调研结论不再是一个很长的气泡，而是一句结论 + 一张文档卡（标题、复制，正文是排好版的 Markdown；超过约 10 行先收起，点「展开全文」看全部，机器人边写边长时卡片高度不变）。草稿卡 / 文档卡上方的 Markdown 标题当卡片标题，不再塞进正文。机器人干活时两次工具之间不再写「我再核对一下」这类过程话，画了卡片后在卡片后面用一句结论收尾。只改网页和提示词。
- 干活卡在原位（Hark 第六轮，DESIGN.md §75）：机器人干活时那张「● 正在搜索…」卡片现在画在这一轮第一个干活的步骤那里，一直在原地——中间写一句过程话时不再消失又出现；点一下能看到已经做过的每一步；这一轮结束，同一个位置原地换成「✓ 搜索 2 次 · 看了 3 个网页 · 12 秒 ⌄」（高度不变，不跳），不再挂在回答下面那一排。「正在看有哪些技能」这类准备动作不再显示、不算步数。以表格 / 卡片收尾的回答，卡片前最后一句成为结果气泡，「我再核对一下」这类过程话收起。后台任务卡片不再露出「正在使用 skill_load」和 `**` 记号。只改网页。
- 电脑文件夹同步·PC 客户端（CB-064 P4b，PC 0.1.11，Windows）：ChisaBot PC 里「新建工作区 → 电脑上的文件夹」把一个文件夹传到云端，之后两边实时双向同步（自编译的 MIT 版 Mutagen 随客户端分发，经网关隧道，主机上没有新端口）；工作区「⋯ → 电脑同步」/ 对话头的同步药丸打开同步面板（开启、立即同步、交还云端、不同步的规则）；两边都改过的文件弹冲突对话框（用云端 / 用电脑 / 两份都留，挪走的那份进备份）；电脑上的 Git 仓库经同一条隧道同步提交（分叉不自动合并）。PC 正在使用时点「合入工作目录」会先和电脑交接（电脑先推上去再暂停，云端写完再拉回），电脑文件夹工作区的合入是「放进工作目录、不提交」。网页和手机只读，电脑离线时可以「强制收回到云端」。需要节点程序更新（重启 `chisabot-cloudnode` 重新下载 chisabot-node.cjs）；没有新表。旧 PC 客户端里这一项照旧灰掉。见 DESIGN.md §73.9、`docs/cloud-claude-code.md`「电脑文件夹同步（P4b）」。
- 电脑文件夹同步·服务器端（CB-064 P4a）：云端工作区可以和一台电脑的文件夹双向同步的底座——新边车容器 `cloudnode-sync`（`deploy/cloud-node/sync`：uid 1000 的 sshd 只听节点网络命名空间里的 127.0.0.1:2222、不发布端口，源码编译的 MIT 版 Mutagen 0.18.1 agent，gate 只放行同步 agent 和本工作区的 git）、电脑用设备令牌换一次性隧道票经网关 `/api/devices/agent/sync-tunnel` 进来、绑定 / 租约（谁能写工作目录）/ 交还 / 强制收回 / 撤销设备即收回、审计。新表 `chisabot_cc_sync_bindings`、`chisabot_cc_leases`、`chisabot_cc_sync_events`、`chisabot_cc_sync_conflicts`（开机建表，回滚镜像即可）。电脑端界面随下一个 PC 版本（P4b）；没有部署边车时什么都不变。部署者要重建 `chisabot-cloudnode` 并构建 `chisabot-cloudnode-sync`（见 `deploy/cloud-node/README.md`）。见 `docs/cloud-claude-code.md`「电脑文件夹同步（P4a）」。
- 「在云端完成登录」过得了 Cloudflare 人机验证（CB-066）：云端登录浏览器以前用无头 Chromium 默认的 UA（带 HeadlessChrome），claude.ai 一直停在「Verify you are human」，点了也过不去；现在用同版本普通 Chrome 的 UA、关掉 AutomationControlled，直接到 Claude 登录页。只改节点程序：节点重启（重新下载 chisabot-node.cjs）后生效，不用重建镜像。
- 云端 Claude Code GitHub 工作区（CB-063，P3）：Claude Code 左栏多了「新建工作区 · 从 GitHub」——选一个仓库（用 设置 → 账号连接 里已连的 GitHub 令牌），云端节点克隆它；每个会话在自己的工作树和 `cc/…` 分支上改，会话页多了「合入工作目录」（冲突时工作目录不动，可以「让 Claude 处理」）和「推送并开 PR」（确认卡：分支、提交、标题 → 推送 → PR 链接卡）；右栏多了「相对 main」「工作目录」两个视图；工作区可以删除。令牌只在克隆 / 推送那一次交给节点（临时 askpass，不落盘、不进日志）。新增 `CHISABOT_GITHUB_GIT_BASE`（可选，默认 https://github.com）。表只加列（回滚镜像即可）。见 DESIGN.md §73.7。
- 设备「打开」只做安全的打开（CB-030）：只能打开 http/https 网址，或允许的文件夹里已经存在的文件 / 文件夹；不再能启动程序、带参数、打开 .exe / .bat / .ps1 / .lnk 这类可执行文件和脚本、别的协议（`ms-settings:` 等）或网络路径——要运行程序走命令行能力和它的审批。服务器在发给电脑之前先检查，已装的旧版 PC 客户端也一样受保护；PC 客户端里同一套检查随下一个 PC 版本发布。能力名改成「打开网址 / 文件」。见 docs/pc-node.md §5。
- 只读工具的说法（CB-022）：机器人翻记忆、看 GitHub Issue / 文件、看页面 / 定时任务 / 面板 / 设备文件时，干活卡上写「正在翻记忆「护照」」「正在看 ChisaAlter/ChisaBot 的 Issue」这类中文，结束后的步骤清单里也列出来；这些读到的结果按规则不单独出卡（DESIGN.md §70.3）。顺带：记笔记不再写成「正在查记忆」，看面板不再写成「正在更新面板」。只改网页和后台任务卡片的说法。
- 页面卡 / 任务卡（CB-021、CB-023）：一轮里机器人把同一个页面做好又改两版，聊天里只留最后一版那一张卡（改的时候旧卡先留着，新版好了原地换）；后台任务卡在参数还在流时，先用任务名，没有任务名就用任务说明的头一句，都还没有时只写一行「正在安排后台任务…」，不再出笼统的「后台任务」。只改网页。见 DESIGN.md §54、§38.3。
- 在云端完成 Claude 登录 + Claude 上游代理（CB-066）：设置 → 云端工作区 多了「在云端完成登录」——云端节点容器里的无头浏览器打开 Claude 授权页，画面嵌在设置页里，你在里面登录、授权，节点自动拿到授权码完成登录；你的浏览器不访问 claude.com，登录和 Claude Code 用同一个出口（卡片上显示两边看到的 IP）。原来的粘贴授权码保留为备用。新增「Claude 上游代理」（http / https / socks5，可带用户名密码，测试连接显示出口 IP 和 claude.ai / api.anthropic.com 是否通）：只有 Claude 的域名走它，地址加密存在保险箱（保留名 `claude-proxy`）。需要重建云端节点镜像（`deploy/cloud-node` 现在装 Chromium）；旧镜像只显示粘贴授权码。见 DESIGN.md §73.8。
- 切暗色 / 亮色不再卡（CB-024）：天空背景只在「背景随时间变化」开关、拖预览时间时才淡变；切主题和每分钟的天色变化一帧换好。以前天空淡变 1.6 秒，期间所有毛玻璃逐帧重新模糊（切一次约 1.9 秒光栅化），现在约 0.2 秒，0.5 秒内画面停稳。外观不变。只改网页。见 DESIGN.md §7.4。
- 云端 Claude Code 标签页（CB-062，P2）：管理员的左栏最上面多了「机器人｜Claude Code」切换（记住选择）。Claude Code 那边是工作区 → 会话（先只有内置「草稿」），会话页是和 Claude Code 的对话：流式回答、接着上次（`--resume`）、「新的 Claude 会话」清上下文、停止、回答中再发一条排队、刷新后接着看；`npm test` 这类命令弹审批卡（允许 / 本会话总是允许 / 拒绝，2 分钟没人处理按拒绝），`git push` 一律拒绝；右栏看这一轮的改动 diff 和会话目录的只读文件，手机上是底部抽屉。只在部署了云端工作区节点、登录了 Claude 时可用。`deploy/cloud-node` 多了可选的 `CLOUDNODE_DNS`（主机上只劫持 Claude 域名的 DNS，`firewall.sh` 同时放行）。见 DESIGN.md §73.2–§73.6。
- 云端工作区 + Claude 登录（CB-061，P1）：新的手工部署容器 `deploy/cloud-node/`（Claude Code CLI + chisabot-node，非 root、根文件系统只读、没有 docker.sock、不发布端口，`firewall.sh` 只放公网），配对后在 设置 → 管理 → **云端工作区** 用自己的 Claude 订阅登录（打开授权页 → 粘授权码），授权码只经过节点上的登录进程，不进数据库和日志；云端工作区不能开完全访问。服务器新增 `/api/cloud-workspace/*`、`/api/claude-code/*` 和表 `chisabot_cloud_workspaces`、`chisabot_cc_*`（开机建表，回滚镜像即可）。没部署节点时什么都不变。见 `docs/cloud-claude-code.md`、ADR-0014、DESIGN.md §73.1。
- 商品 / 地点推荐用带图的卡片网格（CB-050）：机器人推荐、比较商品（或餐厅、酒店、景点）时先查现价和商品页，再画成一排卡片——图、名字、价格、一句卖点、角标、来源站点，整张点开商品页。图由服务器从商品图地址或商品页的 og:image 转存（和链接卡同一套检查与缓存），浏览器不直连第三方；图位固定，图晚到不改高度，取不到图时是名字首字的色块。面板里也能用（算一个大块，最多 4 个）。很长的对话打开时，历史晚到补在上面时画面保持在底部（CB-047）。干活卡不再显示「正在使用 skill_load」这类工具名。只改网页和提示词。见 DESIGN.md §72。
- 设置左栏在笔记本上不用滚（CB-058）：个人 / 管理 / 高级三组都能收起，默认只展开当前页所在的那组（在管理页就展开「管理」），点开过的会记住；屏幕矮（≤ 820px）时行高收紧一点。1280×800 / 1366×768 上展开的那组一眼看全。手机抽屉不变。只改网页。见 DESIGN.md §71.7。
- 管理页说中文（CB-056 / CB-057）：插件目录的说明（Parallel Search、Google Drive、Notion、事件触发）、权限规则三条快捷规则的说明、活动记录的表头 / 筛选 / 事件名 / 结果都改成中文（原始事件类型悬停可见）；手机上活动记录一条一张小卡，不再截掉右边几列。只改网页。见 DESIGN.md §71.6。
- 瘦身 P4c-1：上游 Routines 并入定时任务——机器人的 `create_routine` 等四个工具、`/api/routines`、`/internal/routines/run` 和容器里每分钟的 routines 扫描、`server/scripts/fire-routines.ts`、`deploy/openbot-zh-routines.*` 都删掉，`WORKER_SHARED_SECRET` / `CHISABOT_ROUTINES_WORKER` 不再读（`.env` 里留着也无害）。定时只剩 设置 → 定时任务（§55），`/routines` 照旧跳过去。机器人资料「动态」和重置 / 删除机器人的提示改读定时任务（重置会取消这个机器人为你设的任务）。生产没有 routines 数据；表不动，回滚镜像即可。见 `docs/slimming.md`。
- 干活卡结束后收成一行（CB-049 第二步）：机器人这一轮搜过、开过网页，回答下面（复制 / 重新生成那一排，一直看得见）多一行「搜索 2 次 · 看了 3 个网页 · 12 秒 ⌄」，点开列出每一步；只画了卡片的轮次不出。放在回答下面而不是上面，回答结束那一刻画面不跳。用时只在当场看着它干完时显示，从历史打开的对话只写次数。提示词再收一轮：不写「刚搜了一圈没翻到…」「这部分是我凭自己知识整理的」这类免责段，凭知识回答只在结论里带半句「以官网为准」；画了卡片后文字只留一句结论。去掉 41 条已经没人用的语音翻译。只改网页和提示词。见 DESIGN.md §69.3、§70.2。
- 干活卡（CB-049）：机器人一轮里开始搜索、开网页、写文件时，「思考中」那颗胶囊换成一行「● 正在搜索「iPhone 17 Pro 国行价格」 · 第 3 步 · 12 秒」，当前步骤原地换字；同一个位置、同样一行高，不改滚动。说法和后台任务卡片同一份。打开「调试：显示工具调用」时照旧显示每一行工具。只改网页。见 DESIGN.md §70。
- 对话像发短信（CB-048）：机器人一条回复按段画成几个短气泡，一个接一个淡入（短段贴着文字宽，表格 / 代码 / 清单 / 草稿整列宽）；要发出去的微信、邮件画成一张可一键复制的「草稿卡」；回答过程中补充的话被回应时，气泡顶上有一行回复引用；代码块的语言名和复制 / 下载在同一行、不再套在气泡里。提示词第二版：先给答案、一段一个意思、不提工具名、不说「我刚查了」，来源放最后一行；机器人用自己的名字自我介绍，不再说「我是 Muse Spark」。只改网页和提示词。见 DESIGN.md §69。
- 成熟度 3（非聊天页面，CB-051…CB-055）：账号菜单「待处理」改成真正的待处理——只列聊天里没点的确认卡片、要你亲自完成的操作、机器人在等你回答的问题（带机器人名字，参数折叠），没有了就一张「没有等你处理的事」；上游的开关和规则表（英文 allow / Target、「ChisaBot 桌面应用」）去掉，偏好只在 设置 → 审批偏好；菜单上的数也算上没点的确认卡片。手机上设备「完全访问」的时长按钮不再一个字一行。打开已删除的机器人 / 对话不再是一行红字，而是错误卡 + 「看我的机器人 / 回到聊天」；不存在的连接器页不显示原始 key。账号连接页空状态、残留的「AI 同事」改成人话；机器人资料页的「部署默认」显示模型名字。只改网页，接口和表不动。见 DESIGN.md §71。
- 删掉实时语音通话（CB-046 第 2 步）：输入框的波形按钮、悬浮通话窗、「语音聊天」卡片和服务端 `/api/voice/*` 都去掉，`VOICE_*` 环境变量不再读，`/api/capabilities` 不再返回 `voice`。本部署从没配过语音，界面不变；语音听写（`TRANSCRIPTION_*`）不受影响。`voice_sessions` 表不动（旧数据留着），回滚镜像即可。见 DESIGN.md §68.7。
- 只有一套聊天（CB-046）：机器人聊天只剩左栏点机器人进的频道聊天。旧地址 `/bot?agent=…(&thread=…)`、定时任务通知的「查看」、设置 → 定时任务的「打开对话」都直接打开那段对话的频道聊天（旧对话第一次打开时给它建一个频道，同一条对话、不复制消息）。原来只有旧聊天页才有的都搬过来了：确认卡片、定时任务 / 后台任务 / 本地 agent 的结果行、「确认后接着做」、备用模型小字、回答期间发消息（已排队 → 已读取）、右栏面板「问一句」、机器人「⋯」菜单里的「历史对话」。频道聊天里机器人现在也能委派后台任务、设定时任务、交给本地 agent（以前频道对话被当成群聊，没有这些工具；多机器人群聊仍然没有）。频道聊天上传的文件也存进机器人工作区 `uploads/`，机器人改图、找最近的文件都能用。旧聊天页的代码删掉（约 2,000 行）。没有表结构变化，回滚镜像即可。见 DESIGN.md §68、ADR-0013。
- 瘦身 P6-4（依赖变动，部署走完整构建）：去掉上游桌面端留下的服务端部分——Better Auth `electron` 插件与 `/api/auth/desktop`（依赖 `@better-auth/electron`）、组织登录（`OPENBOT_ORGANIZATION_AUTH_URL`，现在设了服务器会拒绝启动）、原生文件夹代理 `/api/host-access/*` 与 `host_*` 工具（管理 → 云端浏览器 里的「文件夹」区块随之去掉）。`.env.example` 不再列 OpenTag / Twilio / Expo 变量（P4b-2 起就不读了）。ChisaBot 的电脑访问一直走 设置 → 设备（PC 节点），行为不变。见 `docs/slimming.md`。
- 瘦身 P6-3（依赖变动，部署走完整构建）：删掉 `worker/`（上游 Intelligence 工作进程，生产 `local` 模式从不运行）、`scripts/setup-learning.ts` / `scripts/self-hosted-learning.ts` 与 `docs/automatic-learning.md`；依赖去掉 `@better-auth/sso`、`@better-auth/scim`、`@better-auth/expo`（原生 Expo 客户端早已删除，`EXPO_PROJECT_ID` 不再读）和 4 个 `@opentelemetry/*`（审计 OTel 导出 P6-1 已删）。`bun.lock` 重新生成。行为不变。见 `docs/slimming.md`。
- 朋友账号先隐藏（多用户以后再做）：设置 → 管理 →「账号」入口默认不显示，部署设 `CHISABOT_ACCOUNTS_UI=1` 才出现（`/api/capabilities` 多了 `accountsUi`）；登录网关 `config.json` 新增 `invites`（默认关）：关着时不能发邀请、不能直接建账号，未用的邀请链接失效，已有账号照常登录。网关多账号、签名身份、按人隔离都保留。**升级网关**：换 `deploy/public/auth/server.ts` 后重启登录服务；想继续邀请就在 `config.json` 加 `"invites": true`。（撤回了 #130 的删除。）
- 瘦身 P6-2：去掉 Better Auth 的 SSO / SCIM 插件和 `/api/auth/*` 里的公司身份提供者分支（`/api/auth/sso/*`、`/api/auth/scim/*`、SSO 配置加密、身份提供者表的读写）；登录页的「用公司邮箱登录」框去掉。`SSO_*` / `SCIM_*` 等环境变量不再读；审计类型 `identity_provider.*`、`session.break_glass`、`person.*provisioned` 不再写入（旧记录照常显示）。生产一直没配 SSO，登录只走网关，行为不变；表不动。见 `docs/slimming.md`。
- 瘦身 P6-1：去掉上游「企业控制」——每个请求前的能力开关闸门、模型允许名单（以及每轮写一行的 `model_usage`）、电脑网络策略 / MCP 允许名单覆盖层、长期不用的电脑自动停止、动作录制、离职（offboard）、审计 OpenTelemetry 导出（`OTEL_*` 不再读），以及 `/api/admin/enterprise/*`、`/api/admin/people/*`（朋友账号在 设置 → 管理 → 账号 管理，角色来自网关签名身份；该入口目前默认隐藏）。权限照旧由每个接口自己判断（本人 / 主人 / 管理员）；默认模型、备用模型（`enterprise_settings` 里的 `model_connection` / `model_fallbacks` 两行）照常读写；机器人电脑照旧收到「全部放行」的网络策略。表和旧数据不动。见 `docs/slimming.md`。
- 朋友账号（多账号，CB-040）：设置 → 管理 → **账号** 可以「邀请朋友」——生成一次性链接（1 / 3 / 7 天），朋友打开后自己设账号名和密码，直接进入自己的「助手」；管理员可以重置密码（发 24 小时链接）、停用（立刻退出所有设备）、删除。每个账号的机器人、对话、记忆、技能、密钥、GitHub、页面、定时任务、文件、设备、IM 都是分开的，朋友进不了管理页和 Magpie。设备只归主人：管理员也不能操作朋友的电脑，机器人的设备工具只看自己主人的设备；管理员的聊天列表不再出现别人的私有机器人。原管理员账号、数据和已登录的网页 / PC / 手机不受影响。**升级网关**：登录服务 `deploy/public/auth/server.ts` + `auth-web/login.*` + nginx 新模板（`X-ChisaBot-Identity`），`config.json` 加 `identitySecret`、应用 `.env` 加同值的 `CHISABOT_GATEWAY_SECRET` 才开启；不配置时和以前一样只有一个账号。见 `docs/accounts.md`、ADR-0011、DESIGN.md §64。
- 本地 agent 与权限档位（0.1.9）：① 机器人可以把一整件活儿交给你电脑上的 agent——Claude Code、Codex CLI、OpenCode / Gemini CLI / Aider（检测到装了才有），或 ChisaBot 内置循环（不用装，默认用机器人的模型、由服务器代调，也可以配本机模型）。在聊天里说「用 Claude Code 在我电脑上修这个 bug」，出一张任务卡片：实时输出、停止、改了哪些文件；默认在一次性 git worktree / 临时副本里做，你点「应用改动」才合回原文件夹，结果回到同一段对话。默认路径不变：什么都不装，云端机器人照样用 `device_*` 操作电脑。② **权限档位**（设置 → 设备 → 某台电脑 → 本地 agent）：只读 / 工作区 / 完全访问。档位只收紧——档位之外的操作，能力是「允许」也先出审批卡片（摘要写明档位）；「完全访问」就是 0.1.8 的完全访问开关（有时限，到期回到原档位）。任务可以要求更严的档位，不能更宽；只有你能改档位。③ 隔离与网络：git worktree（默认）、临时副本、bubblewrap（Linux）、macOS 沙盒、Docker / Podman（内置 agent）、WSL，按电脑上检测到的列出；可以断网。Claude Code 只在完全访问或系统级沙盒里跳过它自己的确认（root 下自动加 `IS_SANDBOX=1`）。CLI agent 用它自己登录的账号，ChisaBot 不碰凭据。新表 `chisabot_device_agent_settings`、`chisabot_local_agent_tasks`（开机建表，可回滚）。服务器 + 网页 + PC 0.1.9（服务器节点 chisabot-node 重新运行安装命令即可；旧客户端设置页显示「还没检测过」）。见 DESIGN.md §66、`docs/local-agents.md`、ADR-0010。
- 重新生成 / 编辑后重发：最后一条回答下面多了「重新生成」，自己发的消息下面多了「编辑」（点了原地改，发送后这条之后的对话换成新的回答，附件保留）。频道聊天和机器人聊天都有，回答进行中不显示。服务器真的截断对话（消息、回放事件、那几轮的运行记录），刷新、手机和电脑上看到的都一样；截掉那几轮里还在等的确认卡片作废、还在跑的后台任务停掉；还没收到截断的旧标签页再发消息也不会把截掉的内容带回来。新表 `chisabot_thread_truncations`（开机建表，可直接回滚）。服务器 + 网页。见 DESIGN.md §67。
- 手机上聊天里的页面卡片恢复「打开」按钮（窄屏只显示外链图标，以前整个藏掉，只剩缩略图能点）。见 DESIGN.md §54。
- 频道聊天不再丢正在写的回答（P0）：回答写到一半刷新页面、手机切后台再回来、网络抖一下，回来后接着一个字一个字往下写（服务器其实一直在写，只是页面没再接上）；回答中刷新后「停止」照样能用。同一段频道对话在手机和电脑上同时打开，一边发的另一边约 2 秒出现，回答两边同步流式。只改网页。见 DESIGN.md §64。
- 瘦身 P4b-3：去掉上游的自动学习（`/api/admin/learning`、学习设置、学到的技能注入；只在 Intelligence 模式下生效，本部署一直没用）、身份提供者管理接口（`/api/admin/identity-providers`）、每个机器人一台电脑的 Docker supervisor 配置（`COMPUTER_SUPERVISOR_URL` 不再读，机器人共用 `AGENT_COMPUTER_URL`）。表和旧数据不动。企业控制闸门、SSO/SCIM、语音暂留，原因见 `docs/slimming.md`。
- 瘦身 P4b-2：去掉上游的推送与可达性（Slack / Teams / 短信 / 手机推送，`/api/delivery*`）、群聊接口（`/api/groups`）、团队机器人接口（`/api/team-bots`）；机器人之间交接默认关闭（`BOT_HANDOFF_MAX_DEPTH` 默认 `0`，设 `1` 恢复）。旧的多机器人对话打开时显示「已不再支持」。网页里的群聊链接、团队机器人同意卡片、外部机器人回调令牌面板一并去掉。表和旧数据不动。见 `docs/slimming.md`。
- 成熟度 2（新朋友第一次用）：① 新建机器人只有名称必填，职责 / 提示词可以不填（提交时补一句基本说明，之后在资料页改）。② 机器人的空聊天多了 4 个「试试这样问」，点一下就发。③ 手机上建好机器人后左栏抽屉自动收起。④ 「AI 同事」等机翻文案改成「机器人」。⑤ 模型回答到一半断开时，出错卡片说中文（以前是 `AI SDK stream error`）。只改网页。见 DESIGN.md §63。
- 瘦身 P4b-1：服务器不再加载上游的演示录制（`/api/demonstrations`）、上游个人记忆（`/api/memory` 和每分钟的记忆同步）、主动研究（`/api/proactive`）、意图路由（`POST /api/route`）。长期记忆（设置 → 记忆）不受影响。表和旧数据不动，回滚镜像即可恢复。见 `docs/slimming.md`。
- 备用模型：设置 → 模型 新增「备用模型」，管理员排好顺序（最多 8 个），主模型额度用完（429 / 402 / quota）或模型服务 5xx / 过载时按这个顺序换下一个（以前只能自动挑同平台的模型，或改环境变量）；换过模型的那一轮，对话末尾有一行淡色小字「主模型额度用完，已改用 X」，刷新后还在。管理员自检（`/api/admin/smoke`、`smoke.sh`）也走同一套回退：主模型用不了但备用模型答上了算通过，结果里 `fallback` 写明换成了谁——部署不再因为免费额度用完而误回滚。设置存在 `enterprise_settings`（`model_fallbacks`，不新建表，可回滚）。服务器 + 网页。见 DESIGN.md §61、`docs/models.md`。
- 瘦身 P3：仓库里删掉不进任何发布物的上游目录（Tauri 桌面端、Expo 移动端、13 个外部框架适配器、Helm chart、SPIRE、supervisor、多余示例、上游笔记本全栈脚本与 docker-compose、上游 CI / 桌面签名 / 镜像发布流程）。服务端镜像、PC、Android 不受影响，部署行为不变。CI「ChisaBot checks」改成和镜像一样的 hoisted 安装，server typecheck 终于是绿的。见 `docs/slimming.md`。
- 瘦身 P4a：已经隐藏 / 重定向的上游页面代码删掉（人员与角色、企业控制、身份提供者、自动学习、组件游乐场、组件库、旧管理员设备页、群聊），旧地址仍然跳到新位置；机器人设置窗去掉「交接」「例行任务」两栏，接管窗口去掉「录制成工作流…」。只改网页，数据不动。见 `docs/slimming.md`。
- 生图 / 识图模型：设置 → 图片生成 并入 设置 → 模型 的「生图模型」（原配置不动，旧地址自动跳转），旁边新增「识图模型」：默认「跟随主模型」（图片直接给聊天模型），也可以选一个 OpenAI 兼容的看图模型——选了以后上传的图片先由它写详细描述和图中文字（按文件缓存，只描述一次），再交给聊天模型，机器人还能用 `image_inspect` 追问细节；聊天模型在模型目录里标明不能看图时自动用识图模型。每个人可以在 设置 → 生图与识图 换成自己的接口 / 密钥 / 模型（不设就用管理员的默认）。密钥加密、只显示末四位；普通用户只能填公网接口。新表 `chisabot_media_models`、`chisabot_image_descriptions`（开机建表，可回滚）。见 DESIGN.md §59、`docs/chat-files.md`。
- 成熟度 1：① 模型额度用完（429 / 402 / 「Daily free limit」）时自动换同平台的其它模型重发，被拒的模型冷却到它说的恢复时间，期间不再白等——以前默认免费模型额度一用完，每个机器人每句话都要转圈到两分钟再报英文错，一整天不可用。`CHISABOT_MODEL_FALLBACKS` 指定候选（`off` 关闭）。② 一轮出错的提示翻成中文并告诉你下一步（额度、限流、密钥、超时、上下文太长…）。③ 代码块和表格工具栏的提示改成中文。④ 模型把工具调用写成正文 `<tool_call>…` 时收进「思考」并说明没有执行。⑤ **升级网关**：部署 / 重启时不再是 nginx 白底 502（和乱码的「退出登录」），换成「ChisaBot 正在更新」等待页，好了自动回到原页面（新模板 `deploy/public/nginx.conf` + `auth-web/updating.*`）。服务器 + 网页 + 网关。见 DESIGN.md §60。
- 瘦身 P2：示例部署包 `examples/zh-CN` 不再自带机器人和频道（每人第一次进来自动得到私有的「助手」），共享技能只留两个与连接器无关的。服务启动时清理部署包里已不声明的包技能、从没用过的包频道和授给已删除机器人的授权（`CHISABOT_ORPHAN_SWEEP=0` 关掉）；删机器人时一并收回它的授权。用户自己的技能、用过的频道不动。升级前建议 `pg_dump` 这几张表（skills、skill_tools、plugin_grants、channels、channel_agents）。只改服务器。见 `docs/slimming.md`。
- 导航收敛（瘦身 P1）：顶栏只剩字标、左栏开关和窗口按钮；左栏只有搜索和机器人；账号菜单 = 个人资料 · 设置 · 定时任务 · 待处理 · 绑定手机 · 暗色 · 退出；设置左栏分「个人 / 管理 / 高级」。凭据并入「模型密钥」，技能管理并入 设置 → 技能，审计改名「活动记录」；右栏不再显示上游旧面板系统（数据保留）。旧地址（`/agents`、`/team-bots`、`/memory`、`/reachability`、`/responsibilities`、`/routines`、`/skills`、`/settings/passwords`）自动跳到新位置。只改网页。见 DESIGN.md §57。
- 聊天文件与图片生成：机器人聊天可以用 ＋、拖拽、粘贴上传文件（单个 ≤ 20 MB），存进机器人工作区；文件卡显示图片缩略图、PDF 可预览；机器人能把工作区文件交给你（`file_share`）、画图和改图。图片生成由管理员在 设置 → 图片生成 打开（默认关；支持 MiniMax image-01 等，「改图」在 MiniMax 上是以原图为参考重画）。新表 `chisabot_chat_files`、`chisabot_image_settings`（开机建表，可回滚）。见 DESIGN.md §56、`docs/chat-files.md`。
- 定时任务与提醒：在任何对话里说「明早 9 点提醒我…」「每个工作日 18:00 帮我…」，到点机器人回到那段对话里做；忙的时候排进当前回合。时间默认北京时间。周期任务停机晚了 >30 分钟跳过，一次性提醒 ≤6 小时照发并注明。多容器不会重复触发。网页右下角提示 + 浏览器通知；设置 → 定时任务 管理。IM 里设的任务把结果推回 IM（QQ 官方、企业微信受平台被动回复时间窗限制）。新表 `chisabot_schedules`、`chisabot_schedule_runs`；`CHISABOT_SCHEDULES_SWEEP=0` 关掉。见 DESIGN.md §55、`docs/schedules.md`。
- 页面：机器人能把行程、邀请函、报告做成单页网页，发一个不公开列出的链接 `/p/<随机串>/`，别人不用登录就能看；页面在 CSP sandbox 里运行，读不到 ChisaBot 的登录和接口。每次改动存一版（保留 50 版），设置 → 页面 可恢复、下线、删除。**升级网关**：公网 nginx 需要新模板里的 `location ^~ /p/` 规则（不转发 Cookie）。新表 `chisabot_pages` 等 4 张。见 DESIGN.md §54、`docs/pages.md`。
- GitHub 账号连接：设置 → 账号连接（原「账号与密码」）顶部可以贴一个 GitHub 令牌（推荐 fine-grained）。机器人能读你的仓库、issue、PR 和文件；建 issue、评论、开 PR 前在聊天里出确认卡片，你点「允许」服务器才发请求。令牌存在密钥保险箱里，机器人看不到。`CHISABOT_GITHUB_API_BASE` 可指向 GitHub Enterprise。见 DESIGN.md §53、`docs/github.md`。
- 密钥保险箱：设置 → 密钥 存 API 密钥 / 令牌，值用 `KEY_ENCRYPTION_KEY` 加密、只显示末四位。机器人需要时在聊天里出安全输入卡片（值直接交给服务器），调用接口时用 `{{secret:名字}}`，服务器只把它发往绑定的域名，模型、聊天记录和日志里都看不到值。见 DESIGN.md §52、`docs/vault.md`。
- 技能：设置 → 技能 存「某类事怎么做」，你的所有机器人按需加载，也能在输入框 `/名字` 调用；机器人可以在你同意后帮你存技能。和上游技能表是同一份。见 DESIGN.md §51、`docs/skills.md`。
- 长期记忆：机器人跨对话记住你本人、偏好（带情境）、身边的人、地方、在做的事和每天的日志，你的所有机器人共用；能搜、能改、能真删。设置 → 记忆 查看和编辑，可按机器人关掉。上游 personal memory 工具不再给机器人。新表 `chisabot_memory_notes`、`chisabot_memory_bots`。见 DESIGN.md §50、`docs/memory.md`。
- IM 接入：设置 → IM 接入 把机器人接到飞书 / Lark、QQ 官方机器人、QQ 个人号（OneBot 11，非官方有封号风险）、企业微信智能机器人、个人微信（扫码）、钉钉、Telegram。私聊都回，群里只回 @ 和回复；`/new` 开新话题。IM 回合只给文字类工具，电脑和设备默认不开。凭据加密保存，每个连接有测试和最近 100 条日志。**升级网关**：OneBot 反向 WebSocket 需要新模板里的 `/api/im/onebot/` 规则。`CHISABOT_IM=0` 关掉。见 DESIGN.md §49、`docs/im.md`。
- 云端机器人能真正管理你的每台设备、在上面写代码（0.1.8）：① 编码工具——`device_search`（像 ripgrep 一样按内容 / 文件名搜，带行号）、按行读大文件、`device_edit_file`（精确替换，对不上或不唯一就整个不改，返回 diff，改前备份——git 仓库里备份放在 `.git/chisabot-backups/`，不会出现在 `git status`）、`device_apply_patch`（unified diff，多文件、全部校验后才写）、`device_git`（只读子命令只要「读取文件」，提交等要「命令行」，push 每次都要你批准）、后台命令（构建、测试、开发服务器：启动后随时看输出、结束）、持久命令行会话（cd / 环境变量保留）、进程列表 / 结束、云端工作区和设备之间传文件。审批卡片（聊天里的确认卡片、设置 → 设备、PC 弹窗）直接显示着色的 diff。机器人按「搜索 → 读 → 改 → 跑测试 → 汇报 diff」的方式干活，不再整文件贴进聊天。② **完全访问**：设置 → 设备 → 某台设备 → 权限，可以为它打开 1 小时 / 24 小时 / 永久的完全访问——像本机装了一个智能体：不再逐次询问、不限文件夹（整台电脑）、命令不限 10 分钟、可以用管理员身份运行（Windows 弹一次 UAC；Linux / macOS 需要 root 或免密 sudo）。只能你自己在网页上打开，PC 上还要本机确认一次；所有操作照常记录；紧急停止（网页、PC 托盘、手机）立即关闭它。③ **服务器节点 chisabot-node**：设置 → 设备 → 添加一台服务器，复制一行命令到 Linux / macOS 服务器上运行，自动装好 Node.js、登记到你的账号、注册成 systemd / launchd 服务，断线自动重连。④ 设置 → 设备按 电脑 / 服务器 / 手机 分组，设备页新增「运行中」（后台命令可直接结束 + 最近的改动 diff）。⑤ 「打开应用 / 网址」能带参数启动任意程序，改为高风险能力（PC 开着「高风险操作始终在本机确认」时本机再问一次，CB-030）。⑥ 修复：完全访问的到期时间以前读不回来（显示一直是关）。数据库 devices 加一列 full_access_until（启动时自动加，旧版本忽略，可直接回滚）。服务器 + 网页 + PC 0.1.8（PC 要更新到 0.1.8 才有新工具；旧客户端的机器人会被告知需要更新）。见 docs/pc-node.md §12–§14、DESIGN.md §62。

- 聊天里的链接卡改版（像 Hark）：机器人把要你点开的链接单独放一行时，正文后面出一张紧凑卡片——站点图标或缩略图、页面标题、域名，`[下载 0.1.7](网址)` 这种写法的标签也显示在卡上；整张可点，新标签页 / PC 和安卓客户端里用系统浏览器打开，悬停轻微上浮。句子里的链接、来源列表不再出卡；那一行网址不再和卡片重复显示。网页取不到时也有「图标 + 域名 / 文件名」的兜底卡（以前卡片直接消失）。流式输出时不再拿半截网址去取预览，卡片位置先放同尺寸骨架，不跳版。机器人提示词加了什么时候用链接卡。没有 og:image 时的截图默认关闭（`CHISABOT_LINK_PREVIEW_SHOTS=1` 打开）。只改服务器和网页，PC / Android 不用更新。见 DESIGN.md §48。
- 机器人资料页重做，更简洁：页头一行就是头像、名字和「模型 · 运行中/已暂停」，右边直接是「开始聊天 / 编辑 / 删除」；下面只有「资料」（名称、职责、提示词，点编辑就地修改、一次保存）和「运行」（模型、暂停、通知）两张卡，有任务时才出现「任务」。去掉了重复的说明、空的任务分区、整宽的「已暂停」按钮和英文残留。「更新发到哪里」（推送 / Slack / Teams / 短信）挪到「通知」页。只改网页。见 DESIGN.md §47。
- 新建机器人改成一步：只填名称、职责和提示词，全部从空白开始，不再有「报销助手 / 财务」之类的示例；去掉「谁可以看到它」和「它在哪里运行」两步——机器人一律私有、一律在服务器上运行。服务器也强制私有：以前设成公开的自建机器人自动改为私有（迁移 0058，什么都不删；部署包自带的机器人不变）。输入框选中时不再有蓝色描边和光圈（只是描边略深、底色更实），按钮等的键盘焦点环改为中性墨色。只改服务器和网页；PC / 安卓自带登录页的同样改动随下一次客户端发版。见 DESIGN.md §46。

## 0.1.7（2026-10-14）

- 修复「桌面端不能操作本地电脑」：① 新关联的电脑能力默认改为「询问」（以前全部「关闭」，不进 设置 → 设备 → 权限 手动打开，机器人就什么都做不了）。现在直接让机器人截图、打开网址、跑命令、读写文件，电脑上和网页 / 手机上会弹出审批，批准后执行；命令行、写文件、鼠标键盘仍要在电脑本机再确认一次。② 已关联、能力还停在旧出厂值「全部关闭」且从没被人改过的电脑，服务器启动时自动改成「询问」并在操作记录里写一条（自己关掉过的不动；CHISABOT_DEVICE_ASK_DEFAULTS=0 关掉）。③ PC 0.1.7 首次连接时把桌面、文档、下载设为默认「允许的文件夹」（只在文件夹列表为空且没人改过时）。④ 在 ChisaBot PC 里，节点离线 15 秒以上、电脑还没登记、或装的是版本号归正前的 0.2.x 旧版（它永远不会自动更新到 0.1.x）时，聊天顶栏下面出现提示：「重新连接」/「登记」/「需要重新安装」+ 三步说明。⑤ 机器人提示词说明「询问」能直接调用、用户会看到审批。见 DESIGN.md §45、docs/pc-node.md §5。服务器 + 网页 + PC；0.2.x 旧版 PC 必须手动卸载后安装 0.1.7。

- 修复：模型如果把推理写在正文里、用 `<think>…</think>` 包着（部分 OpenAI 兼容模型会这样），现在也放进可折叠的「思考」里，不再出现在回复气泡、历史和复制内容中。没有这种标签的模型不受影响。只改服务器。见 DESIGN.md §44.1。
- 修复：机器人的英文「思考过程」不再混进聊天正文。收起的「思考了 N 秒」以前只是视觉上折叠，英文其实一直在页面里——Ctrl+F 搜得到、全选复制会夹在回答中间、读屏会念出来；现在收起时内容不在页面里，点开才显示。删除机器人时连带删除它右栏的面板并停止它们的定时刷新（以前面板行留着、到点还会刷新）；以前删机器人留下的孤儿面板在服务启动时自动清掉。只改服务器和网页，PC / Android 不用更新。见 DESIGN.md §44。
- 打开弹窗 / 抽屉更跟手：打开动画期间先不做毛玻璃，动画结束再加上（以前每一帧都要重新模糊整块背景）。4× CPU 下点击到第一帧普遍快 10–50ms、动画帧率 +3–6fps。外观不变。见 DESIGN.md §37.2。只改网页。
- 修复（全端同步上线后的回归）：一轮发送失败（上游 / 网络出错）后约 1 秒，刚发的那条消息被同步删掉，整段聊天记录往回跳一截。现在失败的那条留在本机照旧显示，同步只在两台设备的消息先后真的不一致时才重排。首屏也更轻：去掉三个从不执行的库（加载的 JS 4.00→3.43 MB）。见 DESIGN.md §42.7、§41.4。只改网页。
- 面板更靠得住（生产实测机器人自建面板全流程后修复）：① 可以让面板每天固定时刻刷新——说「每天早上 8 点刷新」，机器人会设成每天 08:00（北京时间，可指定别的时区），卡片底部显示「每天 08:00 刷新」，⋯ 菜单里可改回按间隔；以前只能「建好后每 24 小时」。② 在「计算机」里点「交还」后，因接管被推迟的面板立即重刷，不再挂着「计算机正由你接管」等 5 分钟。③ 本机命令取数的面板，「来源」不再是一个点不开的假链接（如 workspace.local），只显示名字。④ 机器人修面板时验证刷新不再连跑两三遍后台刷新。数据库加一列 live_panels.refresh_at（自动迁移，旧版本忽略它，可直接回滚）。只改服务器和网页，PC / Android 不用更新。见 DESIGN.md §43。
- 全端同步：同一个机器人在网页、装成应用的网页版、ChisaBot PC、安卓客户端上打开的是同一段对话，历史完整。一台设备上发的消息、正在流式输出的回答、排队消息和后台任务卡片，几秒内出现在其它开着的设备上（页面在前台时每 2 秒同步一次，切回前台立即同步）；在任一设备点「新对话」，所有设备一起换。第一次打开时沿用这台浏览器原来的对话，任何旧对话都不会被删除。机器人 ⋯ 菜单新增「历史对话」，可切回以前的对话。见 DESIGN.md §42。只改服务器和网页，PC / Android 客户端不用更新。
- 更跟手：点按钮、开关菜单、复制、发送、切右栏标签时不再卡一下。以前几乎每次点击都会让浏览器把整个界面（约 4000 个元素）的样式重算一两遍（4× CPU 降速下每次 130–230ms）；现在只重算点到的那一小块，打开菜单 / 弹窗也不再锁整页滚动、重排整页。界面外观不变。只改服务器网页，PC / Android 不用更新。见 DESIGN.md §41。
- 修复（后台任务 / 并发实测的收尾）：① 输入框底色更实，滚到它下面的消息不再透出来和占位符叠在一起（窄屏暗色最明显）。② 在任务卡片上点「停止」后，对话里会补一行「后台任务「x」已停止」，机器人一句话确认，之前那句「做完会把结果发到这里」不再悬着。③ 新任务卡片一出来就显示第一步（不再「正在准备 / 步骤 0/n」干等几秒）；同时有 2 个以上任务在跑时，卡片默认收成一行，点开看清单和按钮。④ 删除机器人时连带删除它的后台任务记录、隐藏的任务对话和排队消息，删之前先停掉它还在跑的任务；以前删机器人留下的这些孤儿记录在服务启动时自动清掉。⑤ 打开新对话时浏览器控制台不再报三条 404。⑥ 系统更新里的「自检」改成问模型一道随机加法题、有回复就算通过：以前让模型「原样回口令」，有的模型（Mimo）会当成提示注入拒绝，自检时好时坏。只改服务器和网页，PC / Android 不用更新。见 DESIGN.md §25、§38.3，`docs/admin-smoke.md`。

- 修复：右栏「计算机」标签带上琥珀色「需要你」圆点时文字被挤成「计算 / 机」两行。现在标签不换行，圆点是显示器图标上的角标。见 DESIGN.md §39。
- 修复：在右栏「计算机」里接管浏览器后，机器人跑本机命令的面板（如「服务器性能」）每次刷新都失败并显示英文报错；让机器人修，它说一句「我先把面板救回来」就没下文了。现在：聊天里碰到「你正接管着」，机器人会把话说完，告诉你去「计算机」点「交还」；面板卡片写明「计算机正由你接管…交还后几分钟内会自动刷新」，不算失败、5 分钟后自动重试；机器人修面板后必须真跑一次刷新（新工具 panel_refresh）确认成功才说修好了。部署 / 重启时有人正在接管，也不再把机器人永久卡在「有人在控制」。见 DESIGN.md §39。只改服务器和网页，PC / Android 不用更新。
- 机器人回答的时候也能继续发消息了：不会被拒绝（以前偶尔是「发了没反应」），也不会打断正在进行的回复。消息先显示为「已排队」，机器人在当前步骤结束后读到、并进手头的工作，最后回应到每一条；还没读到前可以撤回。见 DESIGN.md §38.1。
- 后台任务：耗时的独立工作（多来源调研、大量整理、多步骤网上操作）机器人可以交给后台并行去做，主对话照常聊天。对话里有一张任务卡片显示进度（当前步骤、步骤清单、用时），可以「补充说明」或「停止」；做完后结果自动回到对话，机器人用一两句话总结。每人同时最多 3 个。服务重启时没做完的任务会标成失败并写明原因。见 DESIGN.md §38.2–38.3。只改服务器和网页，PC / Android 客户端不用更新。

- 修复（生产实测后台任务时发现）：① 用户一次要 4 个以上后台任务时，机器人以为超过「同时 3 个」就不能委派，只开 3 个、自己设提醒等空位；现在它知道多出来的会自动排队（卡片显示「排队中」），要几个就委派几个。② 后台任务的结果里偶尔混进一个「⟦chisabot:worker-result:⟧」标记被原样显示，现在服务器和网页都会去掉。③ 机器人取消自己设的提醒时只抄了 id 的后半段就取消不掉（提醒照样到点叫醒），现在能认。④ 走 Anthropic 协议的非 Claude 模型（默认的 Mimo V2.6 Flash 就是）每次最多只输出 4096 token，长回答写到一半被截断；现在按模型目录里的「最大输出」给上限（封顶 32000，可用 CHISABOT_MAX_OUTPUT_TOKENS 调），目录里没有的模型照旧。只改服务器和网页。
- 修复：发送消息时整段聊天记录往上 / 往回跳一截（上一轮出过错的会话里每次都会）。聊天顶上的红色提示（上一轮没有回答的原因 / 较早消息无法加载）改为浮在聊天上面、不占版面，可以关掉；打开会话时不再显示早已过去的那一轮的旧错误，只有最后一轮出错才显示。
- 手机网页版：手机上打开（竖屏、横屏都算）一律用竖屏布局——左栏和面板是抽屉、输入框贴底；平板和电脑仍按窗口宽度。刘海 / 底部横条自动让开，键盘弹出时输入框贴在键盘上沿、最新消息不被盖住，输入框字号 16px（iPhone 不再自动放大页面），小按钮的可点范围撑到 44×44，从左边缘右划打开左栏、在抽屉上横划关上，表格在气泡里横向滚动。见 DESIGN.md §40。
- 可以把网页版「安装」成应用：浏览器里打开 8 秒后顶栏下面出现「安装 ChisaBot 应用」（安卓 / 电脑 Chrome、Edge 一键安装；iPhone Safari 教你「分享 → 添加到主屏幕」），关掉后 14 天内不再提示，ChisaBot PC / 安卓客户端里不出现。安装后电脑上默认宽屏、手机上默认竖屏。新增 service worker：页面永远先走网络（部署后刷新一次就是新版本），只缓存带哈希的 /assets/*，断网时给一张「网络不可用」卡片。只改服务器网页，PC / Android 客户端不用更新。见 `docs/pwa.md`。
- 修复：关闭弹窗（新建机器人向导的「取消」、右上角 ×、Esc、点弹窗外面）时卡顿。退出动画期间不再逐帧重算毛玻璃，只做淡出和缩放；关闭也不再重渲染向导内容。所有弹窗和抽屉的关闭都受益。只改服务器网页，PC / Android 不用更新。见 DESIGN.md §37。
- 修复：机器人聊天里 AI 正在输出时，画面有时会突然跳到上面更早的聊天记录再滑回来（会话超过 50 条消息时最明显）。现在在底部时整轮都贴着底部；自己往上翻看记录时不会被拽回去。只改服务器网页，PC / Android 客户端不用更新（它们加载的就是服务器上的网页）。见 DESIGN.md §35。

## 0.1.6（2026-10-13）

- 修复：服务器重启 / 在线更新时正在回复的那个对话会卡住约 2 分钟，期间发消息「没反应」（服务器返回 409 Thread already running，网页不提示）。现在服务器启动时释放被打断的对话锁；对一个已不在运行的对话点「停止」也会直接释放；发送失败时网页给出中文提示，不再静默。
- 修复：部署新版本后，开着的旧页面点进还没打开过的页面（例如 设置 → 模型）整页显示「无法加载此页面」。服务器对缺失的 /assets/* 回 404（以前回首页 HTML），网页识别到旧版本分包已不存在就自动刷新一次。
- ChisaBot PC 设备连接更稳：设备节点（WebSocket）和登记请求改走系统代理（与聊天窗口同一条路，支持 HTTP / SOCKS5 代理，代理不可用时退回直连），解决「窗口里能聊天、设备页却显示离线」；连接 70 秒收不到服务器消息就判定已断开并重连；休眠唤醒、解锁、聊天网页加载成功时立即重连；离线时显示真实原因和走的线路，设备页「这台电脑」多一个「重新连接」按钮。

## 0.1.5（2026-10-13）

- ChisaBot PC 小窗模式：右上角窗口按钮最左边新增「小窗模式」，一键把主窗口变成手机比例的竖长小窗（约 420×860，留在当前显示器、贴着原来的右上角），再点「恢复窗口」回到原来的大小、位置和最大化状态；快捷键 Ctrl+Shift+M。需要新版 PC 客户端（旧客户端不显示按钮）。
- 窄窗口（< 768px，含小窗）整理：PC 顶栏标题按钮收窄、主导航改成图标 + 当前一项的字，不再被切掉；机器人聊天的「面板」入口移进输入框工具栏，右边缘竖把手不再压住消息和卡片；抽屉里的机器人 ⋯ 菜单改为向下弹出，不再跑出窗口。
- ChisaBot PC「新版本已下载」提示窗（包括「此更新需要重新安装」）不再固定在主显示器右下角、压住别的程序和小窗：主窗口开着时挂在主窗口里、顶栏下面居中，跟着主窗口移动和进出小窗，宽度随窗口收窄；主窗口在托盘里时才放到右下角。
- 面板库不再是比右栏还宽的整屏抽屉：改成右栏卡片里的一层，与右栏同宽、高度随内容，宽窗口和窄窗口一致。

## 0.1.4（2026-10-13）

- 机器人浏览器不再被 Cloudflare 当成机器人封掉：托管浏览器在 Linux 上（镜像自带 Xvfb）默认改为在虚拟显示器里跑有界面 Chromium，不再用 headless。实测同一台服务器上 headless 打开 grok.com 的登录页 accounts.x.ai、x.ai 显示「Sorry, you have been blocked」、chatgpt.com 卡在「Just a moment...」，改后都能正常打开。想保留旧行为可设 `COMPUTER_BROWSER_MODE=headless`。
- 网站仍然拦截时（「Sorry, you have been blocked」「Access denied / Error 1020」），机器人会收到中文说明，不再反复重试，会告诉你可以「接管控制」亲自试或让管理员配置出口代理（`EGRESS_PROXY_DEFAULT`）；「计算机」里的拦截页顶部也会盖一条中文提示。见 `docs/configuration.md`「网站拦截机器人浏览器」。

## 0.1.3（2026-10-13）

- ChisaBot PC：更新换了图标后，桌面 / 开始菜单 / 任务栏还显示旧图标的问题修好了。PC 更新一直是下载完整安装包，但以「覆盖更新」模式运行时会保留旧快捷方式、不刷新 Windows 图标缓存。现在：每个安装包装完都会重写快捷方式并刷新图标缓存；新版本第一次启动再兜底一次（包括任务栏固定的图标）；`latest.yml` 新增 `chisabotShell`（外壳指纹：图标、安装脚本、Electron 版本等），和本机不同时弹「此更新需要重新安装，以更新图标/组件」，点「重新安装」后卸载旧版再全新安装（数据保留）。已装 0.1.2 的电脑在下次更新时自动换上新图标，不用手动重装。发布者：打包前 `npm run fingerprint`（CI 已自动），见 `docs/online-update.md` §2.1。

## 0.1.2（2026-10-13）

- 安卓扫码绑定：网页「设置 → 设备 → 绑定手机」显示一次性二维码（5 分钟有效、只能用一次、自动刷新，显示等待扫码 / 已绑定），安卓 App 登录页点「扫码绑定」扫一下，就登录到这个账号并直接进入主机器人，不用输入地址和密码。手机作为一台安卓设备出现在设备列表里，可以重命名、撤销或删除；撤销后手机半分钟内自动退出登录。手机只用来登录聊天，不会出现在机器人的设备工具里。账号密码登录照旧。**升级登录网关**：把 `deploy/public/auth/server.ts` 复制到网关目录并重启 `openbot-web-auth`（会话库原地加列，已有登录不受影响）；Nginx 需要 `location ^~ /api/devices/agent/` 例外（新模板已带）。见 `docs/pc-node.md` §10。
- 「绑定手机」更多入口：左下角头像菜单新增「绑定手机」（直接弹出二维码）和「设备管理」；ChisaBot PC 托盘菜单新增「绑定手机…」（打开主窗口并弹出二维码）；`/settings/devices?pair=1` 直接弹出二维码。

## 0.1.1（2026-10-13）

- 品牌：网页 favicon / PWA 图标、登录页、顶栏、PC、Android 图标换成 ChisaBot 品牌头像；README 重写并附截图。
- 右栏面板：机器人按面板设计规范制作、保存前检查；窄面板只有一层外壳、数字不折行、窄表格换简表。
- 设备：机器人现在知道你的电脑在不在线。以前电脑离线（或在线但能力全关）时，机器人拿不到任何设备工具、提示词里也没提，问「你能看到我的电脑吗」只会答「不能，我只有隔离的浏览器」。现在只要账号下关联了电脑，机器人就会读到一段「用户的电脑」说明：在线就如实说能用、用 `device_*` 工具、能力没开就告诉你去 设置 → 设备 → 权限 打开；离线就说「已关联但没连上，最后在线约 N 小时前，请打开 ChisaBot PC」。离线时只多给一个只读的 `device_list`，操作类工具仍只在设备在线时出现。`GET /api/devices/bot-tools/:botId` 多返回 `guidance`（机器人这次会读到的说明）。
- 设备页顶部新增「连接状态」卡：几台在线（都离线时写清怎么办）、你的所有机器人都能用、能力全关时给「打开权限」；在 PC 客户端里多一行「这台电脑」，没登记或令牌失效时给「登记这台电脑」按钮。
- ChisaBot PC 0.1.1：已登录却没登记的电脑会自己补登记。以前只有在本机登录页点「登录」才会登记设备；如果启动时网页会话还有效（记住登录 30 天）但本机没有设备令牌（重装、令牌解不开、旧版配置），客户端会照常打开聊天窗口，节点却永远不连，机器人看不到这台电脑，托盘只写「未登录」。现在启动时用还有效的会话补登记（连不上就每分钟重试）；托盘状态改成「已登录，但这台电脑还没登记为设备」，并新增「重新登记这台电脑」（令牌无效或被撤销时也能用；被撤销的电脑从网页重新登记要先在本机确认，自动路径从不替换已有令牌）。

- 新增「工作流」（顶栏第四个标签）：把 1–N 个机器人角色、技能和约束编排成固定步骤，像技能一样拿来就跑。自带 4 个预设（调研报告、代码审查〔两位审查员并行〕、每日简报、网页→面板〔需审批后存成右栏面板〕）；可新建、编辑（表单编辑器）、复制、删除、导入 / 导出 WORKFLOW.md。运行时填参数、给每个角色挑机器人，运行页实时显示每一步谁在做、输出、审批和 token / 用时。约束在服务器强制执行：最多步骤数、token 预算（估算）、总时间和单步时间、工具允许 / 禁止（不给模型、执行时复核）、步骤前人工审批、输出格式（JSON 校验与一次修正、字数上限），并写入运行记录和审计。也能在聊天里说「运行调研报告工作流」，或在长期任务里运行。新表 `workflows` / `workflow_runs` / `workflow_run_events`（迁移 0055）。见 `docs/workflows.md`。
- 输入框工具栏更紧凑：上下文平时只是一个小圆环（悬停显示百分比，点击才展开详情，≥70% 琥珀、≥90% 红照旧）；模型选择挪到右边、紧挨圆环和发送键，按钮变短（提供方标记 + 截断的名字，最宽约 160px，卡片窄于 420px 时只剩标记和箭头），「默认」标签从按钮挪进下拉列表；左边只留 ＋；去掉「Shift + Enter 换行」小字（写在发送键的悬停提示里）。机器人聊天和频道聊天一致。
- 聊天输入框重做：一张玻璃卡，上面输入区（自动长高到 8 行），下面一行工具栏——＋ 附件、模型选择（从输入框下面挪进卡里）、上下文读数、发送键；回复中发送键原地变成停止键。机器人聊天和频道聊天一致。
- 输入框新增「上下文 12.3k / 200k」读数和小圆环：当前对话占用的 token / 所选模型的上下文窗口，悬停看已用、剩余、输入 / 输出、缓存命中；≥70% 琥珀、≥90% 红并提示开新话题。用量是服务器在每次模型调用上实测的（最后一步的输入 + 输出，写在 RUN_FINISHED 的 `metadata.contextUsage`，`GET /api/copilotkit/threads/:id/context` 读取）；窗口来自模型目录的 `context_window`，目录里没有就不显示分母；没有实测用量时按文字估算并标「约」。
- 系统更新：依赖（`bun.lock` / `package.json`）、`Dockerfile` 或 `docker/` 变了时不再停在「需要完整构建」，页面直接给出「一键完整更新」：宿主机从 GitHub 拉最新代码，用仓库 `Dockerfile` 在限内存的 buildx 构建器里从头构建（装依赖、构建前端、构建镜像），照旧先备份数据库、健康检查、失败自动回滚；成功后新镜像就是之后快速更新的底座。「检查更新」真的从 GitHub 拉取（公开仓库不需要令牌），「上次检查」显示拉取时间。升级已有部署：把 `deploy/updater/` 的脚本装到 `/opt/chisabot-updater/`（`config.env` 补 `FULL_BUILD_MEMORY`、`GITHUB_FETCH`）并重启 `chisabot-updater`，见 `docs/online-update.md`。
- 镜像：`docker build .` 现在产出完整的 ChisaBot 镜像（hoisted 依赖树、前端带构建号、`/app/build-info.json`、`chisabot.commit` 标签、迁移等内嵌数据库就绪）。

- 计算机：机器人自己写的网页能在它的浏览器里打开了——工作区挂在 `https://workspace.local/<路径>`（浏览器内直接读工作区文件，不出网，只能读工作区）；`file:///workspace/…` 自动换成它。以前机器人说「我写个页面然后打开」，结果什么都打不开。
- 计算机：接管大屏停在空白页、画面一片白时，显示和右栏一致的「浏览器空闲」卡，不再是一块白色矩形。

## 0.1.0（2026-10-12，ChisaBot 首个公开版本）

ChisaBot 版本号从这一版重新计数（之前内部测试的 0.2.x 作废）：服务器 `package.json`、PC 客户端和 Android 客户端都是 0.1.0。
Android 的 `versionCode` 为 206（高于内部测试版的 205），已安装的 Android 会正常提示更新；装过 0.2.x 的 Windows 电脑
不会自动“更新”到更低的 0.1.0，需要卸载后手动装一次。

包含目前的全部功能：中文 Skyglass 界面、登录网关、本地 PostgreSQL 持久化、Magpie 模型目录与每 BOT 选模型、`render_ui`
生成式界面、管理后台一键在线更新与自检、PC 设备节点与在线更新、Android 客户端，以及 PC / Android 共用的本机登录页：
PC 和 Android 客户端打开后不再显示服务器的网页登录页，而是客户端自带的「登录 ChisaBot」页：服务器地址（保存在本机、
带最近用过的下拉，可省略 `https://`）、账号、密码（显示开关）、记住登录。客户端先检查地址能否连上，再直接请求登录网关，
错误分为「地址无法连接」「证书错误」「账号或密码错误」。密码不保存：记住登录时网关发 30 天的会话 Cookie，期间打开直接进入；
会话过期时回到这个登录页。PC 托盘菜单和 Android 长按图标新增「切换服务器」「退出登录」。登录网关的网页登录页
（`deploy/public/auth-web/login.html`）改为 ChisaBot 品牌和蓝天玻璃风格，接口不变；Magpie 登录页不变。
PC 修复：连不上服务器时设备连接的 `error` 事件没有监听，主进程可能报未捕获异常。

---

# 上游 OpenBot 版本记录

下面是 ChisaBot 分叉前 CopilotKit/OpenBot 的版本记录，版本号属于上游，不是 ChisaBot 的版本。

## OpenBot 0.1.2

### CopilotKit 1.77 and AG-UI 1.0

OpenBot now runs on CopilotKit 1.77.0 (`@copilotkit/runtime`, `react-core` and `a2ui-renderer`,
from 1.73.1), which carries the Intelligence client, and on AG-UI 1.0 (`@ag-ui/core` and
`@ag-ui/client` 1.0.1, from 0.0.59). A managed Intelligence project needs nothing changed; it is the
client in the server that moved. Among what comes with it: thread naming falls back to the first
message, the realtime connection keeps its place across a repeated checkpoint, an interrupt resume
gets a run id of its own, and generated A2UI controls no longer submit the page's own forms.

Bots served from their own endpoint keep working as they are. AG-UI 1.0 still accepts the earlier
event shapes, so `agent-bot`, `agent-langgraph` and the Python Bots were not changed.

A tool result's `error` field is gone from the `TOOL_CALL_RESULT` event, because AG-UI 1.0 does not
define one. The refusal is still in the result's text and on the tool message, which is where a
Bot's next turn reads it.

## OpenBot 0.1.1
- A password given to `curl` as `-uuser:password`, `--user=user:password` or `-u "user:pass word"` is
  now redacted in a Bot's recorded shell command. Only `-u user:password` with a space and no quotes
  was recognised, so the other spellings kept the password in the command that was stored or exported.
- A password, token or API key sent as a JSON field in a shell command is now redacted before the
  command is kept or exported. `curl -d '{"password":"x"}'` was recorded with the secret in clear,
  because only `NAME=value` and `--name value` forms were recognised and a quoted JSON key was
  neither. The key is still shown, so the command reads the same.

- A Bot's browser is now refused names under `.localhost`, such as `http://admin.localhost:5432`, the
  same as bare `localhost`. The whole `.localhost` zone is loopback and Chromium resolves it without
  DNS, but only the exact name `localhost` was on the refused list, so a deployment that had not opted
  into private hosts could still be pointed at its own services this way.

- `OPENBOT_SINGLE_USER` is now refused with a public name that starts with `127.`, such as
  `https://127.example.com` or `https://127.0.0.1.nip.io`. The check for a loopback address matched
  any host beginning `127.`, so a public address like that read as this machine and the no-sign-in
  administrator was allowed on it. Only a full 127.x.x.x address counts as loopback now.
- A cancellation the native host never collected is now dropped instead of being reported as
  pending forever. Every timed-out, stopped or revoked host operation queues a cancel for the desktop
  worker, and only that worker ever removed it: a worker that stopped polling left the entry in
  memory for the life of the process, so the Host access panel showed an operation that could never
  finish. A desktop that reconnects within the operation timeout is still told to stop.
- A Bot's shell now honours a Stop that landed before the command was spawned, not only one that
  arrives afterwards. A person who pressed Stop in the window between the request reaching the
  computer and the command starting got no answer until that command finished on its own.
- A file download refused because the computer's response carried no usable byte length now releases
  the connection before reporting the refusal. The unread body could be as large as the whole
  download budget, so a computer reached through a proxy that re-chunks left a transfer running and a
  connection checked out of the pool on every attempt.

- A conversation title cut at 60 characters no longer ends in half an emoji. `slice` counts UTF-16
  code units and an emoji is two of them, so a title cut between the halves rendered a replacement
  character in the sidebar and the picker, where the character itself should have been.

- A tool result that arrives before the call it answers is now paired with that call by the LangGraph
  Bot, as the sibling Bots already did. Read back from the durable thread store the result arrives
  first, which is a payload no provider accepts: a tool message with no preceding call, then a call
  with nothing following it. The model answers that with silence rather than an error, so the Bot
  stopped responding for the rest of the conversation.

- Pressing Stop now stops the computer even when the desktop worker never collects the instruction.
  A stop was queued with no timeout and the worker was the only thing that could ever remove it, so a
  worker that stopped polling left the entry in memory for the life of the process and the Host
  access panel showed an operation that could never finish, growing by one per press. Pressing Stop a
  second time also withdrew the first Stop before the desktop could collect it, and rejected a request
  that nobody was waiting for, which the server treats as fatal. A desktop that reconnects within the
  operation timeout is still told to stop.

### A computer refuses the cloud metadata address written through the NAT64 prefix

A Bot's computer is now refused the cloud metadata address when it is written through the NAT64
prefix (`64:ff9b::a9fe:a9fe` is 169.254.169.254), under every network policy including allow-all.
Only the plain and IPv4-mapped spellings were refused, so on a network with a NAT64 gateway the
metadata endpoint was one rewrite away. Browsing already refused this spelling; the computer's
filter now agrees.

### `?sslmode=require` on `DATABASE_URL` now connects to a managed database

A deployment pointed at RDS, Cloud SQL or Azure Database could not start. The server sent
`sslmode` to Postgres as a connection parameter instead of turning TLS on, so the connection went
out unencrypted and was refused with `no pg_hba.conf entry for host ... no encryption`, the very
error the Helm chart's README says `?sslmode=require` avoids. Migrations were unaffected, which is
why a deployment got as far as a migrated database and then crash-looped. `sslmode=require` now
encrypts the connection, and `sslmode=disable` turns TLS off. `sslmode=verify-full`, with an
optional `sslrootcert`, checks the certificate on Bun 1.4 and later and is refused on Bun 1.3,
which connects to any certificate. `verify-ca`, `prefer` and `allow` are refused with a message
naming the modes that work.

### A coworker the message speaks to is routed to without asking a model

Addressing a coworker by name went to the intent router like any other message, so the deployment
paid a model call to be told what the person had already said, and sometimes was told something
else. A message that speaks to a coworker by its full name now routes straight to them: it opens
with the name ("Risk Analyst, please check this"), names it with `@`, or asks it ("ask Risk Analyst
to review this"). It is recorded as `matched a coworker’s name in the message` with
`viaNameMatch: true` on the same `channel.routed` row. A name in passing ("don't send this to Risk
Analyst") and a word that only ends a name ("review this contract", "my meeting notes") still go
to the router. When the message addresses more than one coworker, or two share the addressed name,
it is refused with distinct labels, and the composer keeps the draft and asks the person to choose
instead of starting the default coworker. Explicit picker choices still use `viaMention: true`.

### A Bot's turn in a group is no longer offered coordination tools it cannot call

A Bot answering another Bot in a group conversation was offered `ask_person`, and `message_bot`
when hops allowed it, but every call was refused with "This run no longer has permission to
coordinate work in this conversation" and an `mcp.callback_refused` row nobody had caused. A run is
now offered these tools only when a call from it would be allowed, so that turn is offered neither.
A call that is refused anyway, from a schema offered earlier, is still refused and audited.

## OpenBot 0.1.0
**Before upgrading.** Six things change for an existing deployment:
- Automatic Learning is on unless an administrator saved it off. It does nothing until a Learning
  container is assigned; see below.
- A Bot's computer refuses the network until the server pushes its policy. A computer run without
  an API server can set `EGRESS_POLICY_REQUIRED=0` for the old behaviour.
- The upgrade runs migrations `0042_user_preferences`, `0043_plugin_logos`, `0044_voice_sessions`,
  `0045_channel_activity_source`, `0046_automatic_learning`, `0047_agent_pinning`,
  `0048_coworker_parity`, `0049_coworker_parity_lanes`, `0050_review_fixes` and
  `0051_routine_enabled_at`.
- An existing Windows clone checks text files out with LF only after
  `git rm -r --cached . && git reset --hard` on a clean tree.
- The signed-in app shows a bar offering CopilotKit's help self-hosting OpenBot, unless the
  deployment is on a paid Intelligence plan. Set `OPENBOT_SELF_HOST_BANNER=false` to remove it for
  everybody.
- An egress rule with a malformed IP range, such as `10.0.0.5/`, used to be read as `/0` and allow
  every IPv4 address. It is now refused, and a saved network policy that contains one is refused as
  a whole: the Bots under it fall back to an allowlist with nothing on it, so they reach nothing
  until the rule is corrected under Admin → Enterprise.

### A group reply the owner allows still reaches the Bot it names

A reply held until its owner allowed it to be shown in a group was written into the transcript and then stopped. The same reply allowed immediately was handed to the Bot it named. Allowing it now hands it on the same way.

**Before upgrading.** Four things change for an existing deployment:

### The app offers help self-hosting OpenBot, until you close it

A slim bar at the top of the signed-in app links to CopilotKit's engineers for help self-hosting
OpenBot. Closing it is saved to your preferences, so it stays closed on every device. A deployment
on a paid Intelligence plan (`pro`, `team`, `team_self_hosted` or `enterprise`, or a licence bought
through AWS Marketplace) never shows it; any other plan, or an entitlement that cannot be read,
shows it. A fork running OpenBot for its own organization hides it for everybody with
`OPENBOT_SELF_HOST_BANNER=false`.

### A request to the approvals API that is not JSON answers 400

A body that could not be parsed as JSON, sent to any approvals route that reads one, such as
`PATCH /api/approvals/preferences` or `POST /api/approvals/rules`, answered 500 with the parser's own
message. It now answers 400 "Supply a valid request.", as the delivery routes do.

### Syncing a memory source a policy refuses says why

When a connected app's policy refused the read behind a memory source's sync, `POST
/api/memory/sources/:id/sync` answered 503 "Memory is unavailable. Try again.", although the
refusal's own sentence was already saved on the source. It now answers 400 with that sentence, as
the plugin routes do for the same refusal.

### `@Ops Lead` in a group addresses Ops Lead, not Ops as well

In a group conversation, a reply naming `@Ops Lead` also addressed a Bot called Ops, because the
shorter name matched at the same `@`, so both answered. An email address addressed a Bot by its
domain: `jo@sam.com` reached a Bot called Sam. Where two names start at the same `@`, only the
longer one is now addressed, and an `@` straight after a letter or digit is not a mention.

### A webhook with many long top-level fields no longer stops the server

A trigger's event is cut to 32 KiB before it is recorded, keeping each top-level text field up to
1000 characters and an excerpt of the rest. A flat payload whose fields alone came to more than
that, such as forty 1000-character fields, left the excerpt nothing to give up, and the loop
trimming it never ended. That loop runs on the server's only thread, so every request stopped being
answered. The kept fields now get at most half the space, and the rest is still in the excerpt.

### A malformed IP range in an egress rule is refused instead of widening the rule

An egress `cidr` rule written `10.0.0.5/` was stored as `10.0.0.5/0`, which is every IPv4
address, so a typo for one host opened an allow-list to all of them. `/0x8` and `10.0.0.0/8/9` were
accepted the same way. A zone id such as `fe80::1%eth0` was accepted too, and then threw from the
filter on the first connection that policy judged. Each is now refused when the rule is saved, with
the sentence a malformed range already got. A rule like this saved earlier matches nothing.

### Deleting a channel twice is recorded once

A second `DELETE` of the same channel, from a retry or a second tab, still answers 204 as before.
It no longer tells every member again, and no longer writes another `channel.deleted` row to the
audit trail for a deletion that did not happen.

### A Bot's saved reply in a group is no longer replaced by a later error

In a group conversation, a Bot's reply was saved, then handed on: to Activity, to any consent
cards, and to the Bots it named. A fault in that hand-on, such as the audit trail being
unreachable, wrote the error's text over the saved reply and marked it failed, and a retry did not
bring the reply back. The reply now stays as saved, the fault is logged as
`group-turn-after-reply-error`, and any consent cards or handoff the fault interrupted are still
posted.

### The egress filter reaches an IPv6 upstream proxy and asks it for IPv6 hosts correctly

An upstream proxy configured at an IPv6 address, such as `http://[fd00::1]:3128`, could not be
reached: the filter handed the address to the socket with its brackets, and the socket looked it up
as a name. A `CONNECT` to an IPv6 host was also sent to the upstream without the brackets an
authority needs, as `CONNECT ::1:443`. Both now work.

### The Helm chart configures Slack, Teams, text messages, push, SCIM, inbound email and OpenTelemetry

These settings had no chart values and could only be passed through `config.extraEnv`. They now have
their own: `config.opentag`, `config.sms`, `config.push`, `config.deliveryPublicUrl`, `config.scim`,
`config.inboundEmail` and `config.otel`, with the OpenTag secret, the Twilio auth token, the Expo
access token, the SCIM bearer tokens and the OpenTelemetry headers under `secrets` (or an existing
Secret or store, by key). The install refuses what the server would refuse at boot, such as an
OpenTag secret under 32 characters or a partial set of Twilio settings. With none of them set, the
chart renders exactly as before, so a deployment already passing these through `config.extraEnv`
keeps working unchanged until it moves them across.

### A coworker at its own endpoint can hand work to another Bot

A grant letting a remote Bot (a coworker at its own endpoint) hand work to another Bot was accepted and stored, but the grant read kept only built-in Bots, so the remote Bot was never
offered `message_bot` and a call it made anyway was refused as not granted. The read now counts a
grant whatever the Bot's type, so a remote Bot hands work on through the same signed callback, grant
check, caps and audit rows as a built-in one, to a built-in Bot or to another remote Bot. The
coworker's handoff panel now offers it the same switches.

### A channel cursor with a malformed time reads as the first page, not a 500

`GET /api/channels` only checked that a cursor's time was a string before casting it with
`::timestamptz`, so a hand-edited or corrupted cursor such as `{"recency": "not-a-date"}` answered
500. A time that is not the UTC timestamp the list writes now reads as the first page, the way every
other malformed cursor already did.

### A playground component's Published switch publishes its source too

The Published switch on an admin component page called the generic publication endpoint for every
kind. For a browser-authored component that endpoint promoted the description and marked it
published without copying the playground draft, so Bots were offered a component the renderer could
not draw. Playground components now publish and withdraw both rows in one transaction; a missing or
empty description or HTML is refused instead of leaving a half-published component, and repeating
an unchanged publish no longer advances the revision.

### A proxy password containing `%` no longer stops every shell command

A proxy password with a `%` that does not start an escape, such as `p%zz`, made decoding it throw.
- In the computer's shell, which strips proxy credentials before every command, every `/exec`
  failed as a result.
- Resolving a Bot's egress proxy failed the same way.

Such a password is now taken as written, and it is still kept out of the shell's environment.

### Revoking a credential twice says so, instead of answering a server error

Revoking a credential that was already revoked, or that does not exist, now answers 404 with the
reason. Rotating one that is gone answers 404, and rotating one that is revoked or does not match
the key answers 409. Before, each answered a plain-text 500, as if the deployment were broken; a
double click on Revoke was enough to cause it. The refused-rotation audit row is written as before.

### The channel list no longer skips channels made in the same millisecond

The channel list's page cursor kept the last channel's time to the millisecond, while PostgreSQL
keeps it to the microsecond. Channels later in that same millisecond, as a package sync or an
import makes them, sorted after the cursor and were on no page. The cursor now carries the time to
the microsecond, as the audit trail's cursor already did.

### A package skill's slug has the same shape as one made in the app

The skills screen, the skills API and the store all accept a slug of 2 to 40 lowercase letters,
digits and hyphens that starts and ends with a letter or digit. `skills.yaml` accepted any length
and a trailing hyphen, so a package could seed `a`, `a-` or a sixty-character slug that nobody
could then edit. A package with such a slug is now refused at load, with a sentence naming it.
Every slug in `examples/fintech` already has the shape.

### A tenant package that repeats itself is refused by name, instead of failing at boot

Validation now refuses each of these, with a sentence naming the file and the repeated id:
- A skill named twice by one agent, or an agent listed twice in one channel's `permitted_agents`.
  Before, the server stopped at boot with a raw SQL error.
- An agent id repeated within `agents.yaml`, a channel id within `channels.yaml`, or a skill slug
  within `skills.yaml`. Before, the last entry silently won, though two files declaring the same
  agent were already refused.
- A remote agent left blank in `agents.yaml` but declared with an endpoint under `agents/` was
  dropped from every channel that named it. It is now treated as declared.

### `start.sh` and `stop.sh` see their own processes on Windows

In Git Bash on Windows, which has no `lsof`, `pgrep` or `pkill`, every process and port lookup in
the two scripts came back empty.
- `bash scripts/stop.sh` reported the app, the routine worker and the API server as not running,
  and left all three up.
- `start.sh` could not see a port held by another process.
- `start.sh` started another routine worker on every rerun, then reported that the one it had just
  started "did not stay up".

Where those tools are missing on Windows, the scripts now ask PowerShell, which ships with Windows.
Everywhere the tools exist they are used exactly as before.

### The supervisor and the Python Bots compare their tokens in constant time

The supervisor compared its bearer token with a plain string comparison, and the eleven Python Bots
compared the shared agent token as text, which answered 500 rather than 401 on a header carrying a
non-ASCII character. Both now compare bytes in constant time, as the server and the computer already
did. A wrong or missing token is refused exactly as before.

### A clone on Windows builds an image that starts

On Windows, where Git converts line endings by default, a clone checked every text file out with
CRLF. `docker build` copied the s6 service files into the image that way, so a service's `type`
read `longrun\r` and its scripts stopped on `set: -: invalid option`, and `bun run format:check`
failed on every file. `.gitattributes` now checks text files out with LF on every system. An
existing clone with nothing uncommitted picks this up after `git rm -r --cached . && git reset --hard`.

### A routine switched back on gets a fresh count of failures

A routine that fails ten times in a row is switched off, and someone has to switch it back on.
- **Before:** the failure count ignored that, so the first failure after re-enabling counted as the
  eleventh. The routine was switched straight off again with "failed ten times in a row", and the
  first-failure message never appeared.
- **Now:** failures are counted from when the routine was last switched on, recorded in a new
  `routines.enabled_at` column. The migration sets it to the time of the upgrade, so any failure
  streak already under way starts again from zero at that point. Adds migration
  `0051_routine_enabled_at`.

### Generated workspace files can be downloaded intact

`GET /api/computers/:botId/files/download?path=...` streams a generated file as an opaque
attachment instead of returning the 64 KB UTF-8 text extract. Downloads use the separate
`computer_download_file` / `download_file` permission, remain confined to the Bot workspace, are
capped at 100 MiB with `413`, and are recorded on the computer audit trail. Switching off **Cloud
computer use** under Admin → Enterprise refuses downloads as it refuses reads. Existing read, list
and write APIs are unchanged.

### Bots work as coworkers

A Bot can now carry on without anyone watching it. It runs standing **Responsibilities** fed by
schedules, signed webhooks, GitHub, Linear, Sentry, PagerDuty, inbound email and Slack messages,
drives its own computer while the app is closed, and keeps its browser profile, cookies and files
across restarts. Its questions and approval requests reach the person who owns the conversation in
Slack or Microsoft Teams (through OpenTag), by text message or by push, and the conversation
resumes when they answer; charts reach Slack and Teams as native charts. **Reachability** links
each of those places to a conversation.

Approvals become one personal flow across the browser, connected apps, shell, files, the host and
remote Bots, with custom rules, auto-review and host command modes (**Approvals**). Bots can
message each other, share a group conversation with attributed speakers, and be published to
teammates as **Team Bots**. **Memory** imports facts from connected apps with their source, and
optional background research suggests next steps. A browser demonstration can be recorded and
turned into a skill. Administrators get capability toggles, SSO-required sign-in, SCIM, network
egress policy, action recording, OpenTelemetry export, and **Passwords** with private sign-in
requests.

Upgrading runs migrations `0048_coworker_parity`, `0049_coworker_parity_lanes` and
`0050_review_fixes`.

### A Bot's computer refuses the network until its policy arrives

A computer used to allow every connection until the server had pushed its Bot's network policy,
which left up to 30 seconds of unfiltered access after every wake. It now refuses until the policy
arrives, and the server pushes it as the computer wakes. Cloud metadata and link-local addresses are
refused in every mode, including `allow_all`, and the browser's WebRTC traffic now goes through the
filter instead of around it. A computer run without an API server can set
`EGRESS_POLICY_REQUIRED=0` to keep the old behaviour.

### Parallel Search is in the plugin catalogue

Two catalogue entries reach Parallel's public-web search and extraction at
`https://search.parallel.ai/mcp`: **Parallel Search**, anonymous with provider-managed limits, and
**Parallel Search (API key)**, which sends a deployment credential as a bearer token. Nothing is
granted automatically. When a Bot holds both `web_search` and `web_fetch`, the built-in Bot guidance
describes them for public-web research, and the fintech example's Research Desk ships a
`research-public-web` skill that declares them. See
[Public-web research with Parallel](docs/parallel-research.md).

### `lodash-es` is pinned to the patched 4.18.0

A root `overrides` entry pins the transitive `lodash-es` to 4.18.0, the patched release, wherever a
dependency pulls it in.

### Provider and Bot lookups ignore inherited object properties

Unknown names such as `constructor` and `__proto__` no longer return an inherited
JavaScript object as a provider or Bot entry. Unknown providers return no spec, and
missing Bots raise the existing startup error. Configured providers and Bots are unchanged.

### A malformed `%` in a stream URL no longer returns a 500

A request to `/api/computers/<id>/stream` whose id held a broken percent-escape, such as `%zz`,
made the server throw and answer 500. It is now treated as not matching the stream route and goes
through normal routing. Valid ids behave as before.

### `start.sh` names the port to change on macOS

When the API server's or the app's port was held by another process, `start.sh` was meant to say
which setting to change, such as `Re-run with SERVER_PORT=<free port>`. On macOS, whose bash is
3.2, the run ended on `bad substitution` before printing it, because the hint upper-cased the
name with a bash 4 expansion. It is upper-cased with `tr` now, so the hint prints on either bash.

### `start.sh` starts the Docker services on Compose v5

On Docker Compose v5, `bash scripts/start.sh` stopped at
**1/4 Docker services** with `failed to get console: provided file is not a console`. The script
sends compose's output to `/dev/null` while its errors still reach the terminal. Compose saw that
terminal, chose its interactive build display, and could not draw it. The script now asks compose
for quiet progress through `COMPOSE_PROGRESS`, which older Compose versions ignore, so nothing
changes where it already worked.

### The skills pages say when the skills could not be read

When `GET /api/plugins` failed, **Agent Skills** said "You don't have any skills yet.", **Admin →
Skills** said "No skills yet.", and opening a skill to edit said "That skill no longer exists, or it
is not yours to edit.", to people who may have written a dozen. They now say the skills could not
be loaded. A list that arrived empty still reads as before, and a failed refetch over a list already
on screen keeps that list.

### A coworker can be pinned to the top of the Agents screen

A coworker's Manage tab has a **Pin** switch beside Hide, and pinned coworkers move into a
**Pinned** section at the top of `/agents`. Like hiding, pinning is personal: it changes nothing for
anyone else. It is stored next to `hidden_at` in `agent_preferences` as a new `pinned_at` column
(migration `0047_agent_pinning`), and each write sets only its own column, so pinning a hidden
coworker keeps it hidden and it comes back pinned when unhidden. `POST /api/agents/:id/pin` and
`/unpin` record `bot.pinned` and `bot.unpinned` on the trail, as hiding does.

### A hidden coworker can be found again on the Agents screen

Hiding a coworker took it off both lists on `/agents`, and Unhide is only in the coworker's dialog,
which only its card opens, so a hidden coworker had no way back short of typing its id into the
address bar. The screen now ends with a collapsed **Hidden** section listing them, each card opening
the dialog as before. It appears only when something is hidden. Hiding still changes nothing for
anyone else, and nothing on the server changed: the screen reads the `GET /api/agents?hidden=true`
list the server already served.

### A connector's own pages say when the plugin list could not be read

When `GET /api/plugins` failed, a connector's admin page said "Not a plugin", a tool's page said
"This deployment has not enabled that connector.", and a person's connected-account page said "This
is not a service you connect for yourself.", each about a connector that may be added and granted
right now. They now say the list could not be loaded, as the per-Bot grant page beside them already
did. A list that arrived without the connector still reads as before.

### Boundaries says when the policy could not be read

When `GET /api/computers/policy` failed, the Boundaries screen showed its title over nothing, for as
long as it was open. It now says "The boundary could not be read.", or the server's own reason, as
it did before the screen's read moved into a query.

### Browser controls are visible in chat and the Computer sidebar

Channel chats and standalone Bot chats now have a labeled Computer button and always-visible
Take control or Hand back controls. The same ownership state is shown in the chat, live Computer
sidebar, and full-size viewer. Standalone Bot chats can open the current live browser alongside
the conversation without losing the selected Bot or chat history.

### An administrator cannot grant a skill nobody has written

`POST /api/plugins/grants` checked that a skill existed for everybody except an administrator, whose
grant was stored whatever it named. A Bot's skills are read by slug alone, so the row waited for
whoever wrote a skill under that name next, and on a Bot the deployment shares that was one person's
instructions answering everybody. It is now refused with "There is no skill called …", as a grant
naming no app already was. Revoking one by hand still works.

### A remote Bot keeps answering when it asks for a learned skill that is not there

With Automatic Learning delivering skills, a Bot reached at an AG-UI endpoint (every shipped Bot
except a built-in one) ended the whole turn with "Skill is unavailable." in place of an answer when
its model asked for a skill by a name the snapshot does not hold, for a file the skill does not
list, or sent arguments that were not JSON. A built-in Bot's model is handed that sentence as the
call's result and carries on. A remote Bot's model now gets the same result and carries on too.

### An app or skill cannot be granted to a Bot that does not exist

An administrator's `POST /api/plugins/grants` for an app or a skill checked that the app or skill
existed but not the Bot, so a mistyped Bot id reached the insert, failed on the `plugin_grants`
foreign key, and answered 500 with no body. It is now refused with "There is no such Bot.", the
sentence the `bot` kind already used, and nothing is stored. Revoking still checks nothing.

### A malformed OAuth client is refused with a 400, not a 500

`POST /api/plugins/servers/:id/oauth-client` called `.trim()` on the client id and secret without
checking they were strings, so `{"clientId": 12345, "clientSecret": "s"}`, or a secret of `{}`, threw
outside the route's try and answered 500. It now answers the same 400 as an empty value, as the
other plugin routes do for their own fields, before the store or the audit trail is touched.

### Browser challenges can be handed to a person without losing the Bot's page

Bots pause for actionable browser challenges and resume from a fresh page snapshot after an explicit
handback. Requests survive viewer reconnects and distinguish completion from cancellation, expiry,
or an interrupted browser session. Managed browsing now uses full Chromium in headless or headed
mode. Local API deployments can opt into installed Chrome with dedicated per-Bot profiles, the same
in-app viewer, a loopback-only computer endpoint, and host shell execution disabled.

### A hidden Bot's app grants stay on the Plugins screens

Hiding a Bot from your own roster took it off the Plugins screens too: its row went from By Bot and
from each tool's switches, the counts could read "3 of 2 Bots", and its own page said there was no
such Bot. Its grants stayed in force, and nothing on any screen could take them away. The Plugins
screens now follow the rule the Handoff panel already does: a hidden Bot is shown when it holds one
of the grants the screen is about, marked "Hidden from your roster", and its own page draws its
grants. Nothing on the server changed.

### Revoking a function from a component that does not exist answers 404

`DELETE /api/components/:name/functions/:function` was the one grant write that did not check the
component exists. Against a name nobody has, it deleted nothing, answered `revoked: true` and wrote a
`component.function_revoked` row naming a component that was never there. It now answers 404 and
writes nothing, as granting a function and withholding a component already do. A function grant
cannot outlive its component, so there is no stored row this stops anybody removing.

### A wiped or restarted shared computer no longer leaves refs pointing at the dead page

Snapshots are ordered on the run of the browser that took them as well as the generation, so a
computer that is replaced cannot have its old page mistaken for its new one. That ordering was
reaching only the deployments that give each Bot its own container or sandbox, because the run was
read off the infrastructure and the deployment with one shared computer has none to read.

Two failures followed there, and both are fixed. A snapshot still in flight when somebody pressed
Reset brought the wiped page back, and the boundary went on deciding about its elements: a rule about
"Confirm transfer" firing on a click nowhere near one, or failing to fire on one that is. And a
computer that restarted counted generations from one again, so its first snapshots were dropped as
stale and refs kept resolving against a page nobody was on until the counter climbed back past it.

The computer now mints a run for each Bot's browser session, mints a new one when the Bot is reset,
and answers which run it is on. Nothing changes for a deployment that already reports one, and a
computer too old to answer leaves the ordering exactly where it was rather than refusing anything.

### `scripts/start.sh` no longer needs python3

The runtime health check in step 3 was a `python3` heredoc. On a machine without Python, and on
Windows, where `python3` is usually the Microsoft Store alias that exits 49, the run stopped there
with the server and worker up and the app never started. The check now runs in Bun, which the
script already requires, with the same output and exit status, and `python3` is gone from the
prerequisites in `docs/development.md`.

### An MCP tool that answers with a resource link is no longer read as an empty name

A tool that points at a file or a page often returns a `resource_link`: a URI, a name, and a
sentence of what it is, rather than the contents themselves. That part was named `[resource_link]`
and the URI was dropped, so the model was told a link arrived and never shown where it went. A
search that answered with pages produced no page it could open. The URI, name and description are
now read, each on its own labelled line. The URI leads and the name and description are bounded, so
a long name cannot push the pointer past the result cap; a server's `title` is shown over its `name`
when it gives one. A part that already carried text is unchanged.

### The Microsoft Agent Framework Bot answers on a plain OpenAI key

Picked with an OpenAI key, the Microsoft Agent Framework Bot failed every run with "Connection
error.". Compose writes `OPENAI_BASE_URL` empty when the choice is a plain OpenAI key, and the
OpenAI SDK only defaults an absent URL, so it was given "" as the address. The Bot now falls back to
`https://api.openai.com/v1` for an empty value, as its Anthropic branch already did for
`ANTHROPIC_BASE_URL`. An OpenAI-compatible endpoint is unchanged.

### `OPENBOT_ONE_COMPUTER_EACH=false` in `.env` is honoured by `start.sh`

`scripts/start.sh` read `OPENBOT_ONE_COMPUTER_EACH` from the environment alone, so the line that
`docs/configuration.md` tells people to put in `.env` was ignored: the supervisor was still started
and the server still told to give each Bot its own computer. It now reads the key as it reads every
other setting, the environment first, then `.env`, then the default of `true`.

### Skill selection keeps capabilities named across multiple JSON replies

When a model wraps its skill choice in prose or sends a revised JSON object, OpenBot reads each
complete `skills` list and offers the union of the named skills' granted tools. This also works with
Anthropic's OpenAI-compatible endpoint, which may ignore the request for bare JSON. Previously a
reply containing multiple objects fell back to offering every tool; replies with no valid `skills`
list still do.

### The AG2 Bot answers on a plain OpenAI key

Picked with an OpenAI key, the AG2 Bot failed every run. Compose writes `OPENAI_BASE_URL` empty when
the choice is a plain OpenAI key, and the OpenAI SDK only defaults an absent URL, so it was given ""
as the address. The Bot now falls back to `https://api.openai.com/v1` for an empty value, as its
Anthropic branch already did for `ANTHROPIC_BASE_URL`. An OpenAI-compatible endpoint is unchanged.

### The live screen keeps reconnecting after it has recovered

A dropped live screen retries five times, waiting half a second, then one, two, four and eight, and
then asks for Retry. The count of retries never went back to zero after a retry worked, so a screen
left open through five short drops over an afternoon gave up on the sixth, although each had
recovered within a second. The count now starts over once a reconnected screen shows a frame again,
so only five failures in a row end in Retry.

### A failed save of a Bot's browser control leaves no copy behind

The computer keeps who holds a Bot's browser, and its handoff requests, in one file per Bot under
the profiles volume, written to a temporary file first and renamed over it. When the write or the
rename failed, the temporary file stayed, a readable copy of that state beside the real one, and
every later failure added another. It is now removed whether or not the save succeeds, as the
learning setup and the model sign-in file already do.

### Every Bot's provider defaults live in one spec file

`shared/model-providers.json` now holds the provider facts and the default provider and model of
the thirteen Bots that read it: the three TypeScript Bots through `shared/model-providers.ts` and the
ten Python Bots through `shared/model_providers.py`. The Claude Agent SDK Bot does not read it.
`BOT_PROVIDER` and `BOT_MODEL` still win over both, and each Bot keeps its existing default,
including Mastra's `gpt-4o-mini`. Moving a Bot to a different model is one row in one file.

Both loaders check the file against their own list of providers and refuse in the same words, so a
wrong row now stops all thirteen at startup, naming the key, where the Python Bots used to start
clean and meet it at their first model call. The Mastra Bot also refuses a `BOT_PROVIDER` it does
not recognize (such as `google`) instead of quietly answering through OpenAI with a different model.

Compose used to substitute `gpt-5.5` for `agent-langgraph` whenever `BOT_MODEL` was unset, whatever
`BOT_PROVIDER` named. It now passes the unset value through, so the Bot's own row answers: an OpenAI
deployment keeps `gpt-5.5`, and a Google or Anthropic one stops being handed a model its vendor has
never heard of. The picked harness in Compose now also receives `GOOGLE_API_KEY` and
`GOOGLE_GENERATIVE_AI_BASE_URL`, so a harness picked on `BOT_PROVIDER=google` has its key.

### Automatic Learning, on by default

Every shipped Bot can now contribute completed conversations to a CopilotKit Intelligence Learning
container and receive the skills published from it. **Admin → Automatic Learning** chooses a default
container, overrides or excludes individual Bots, and pauses Learning. Chat, channels, routines and
handoffs all follow the same settings.

Learning is on unless an administrator has saved it off, and a saved off stays off. It collects and
delivers nothing until a container exists in the Intelligence project and is assigned:
`bun scripts/setup-learning.ts` creates or reuses one called `openbot` and writes it to `.env`, or
set `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` (Helm: `config.learning.containerId`), or enter it on
the Admin page. OpenBot starts and chats without one. Skills are reviewed and published in
Intelligence; nothing is approved automatically. See
[Automatic Learning](docs/automatic-learning.md). Adds migration `0046_automatic_learning`.

### Dictate messages and talk to a coworker in a live voice call

Deployments can configure transcription separately from their Bots' models, with a waveform composer
for recording, cancelling, transcribing, or sending speech. Optional OpenAI Realtime and Grok voice
adapters add a floating call widget. The live model handles conversation directly and delegates tools
and actions to the existing Bot in the same thread. Ending a call saves its transcript and a short
summary; later voice calls and typed messages receive that history. Calls start silently, and muting
affects the person's microphone. See [configuration](docs/configuration.md#live-voice-calls).

Voice summaries use the configured chat provider, including Anthropic keys and Claude or ChatGPT
plan sign-in. Retrying a failed summary refreshes its sidebar preview without replacing newer
activity. A call the voice service turns down says why, such as "The voice service is busy. Please
retry shortly.", and a call that cannot be saved says "Could not save this voice chat." and stays on
its card to retry. Caps on a call's context, captions and answers cut between characters, never
inside an emoji.

### The Pydantic AI Bot answers on a plain OpenAI key or an Anthropic key

Picked with either key, the Pydantic AI Bot failed every run. Compose writes the endpoint the choice
did not need as empty (`OPENAI_BASE_URL` for a plain OpenAI key, `ANTHROPIC_BASE_URL` for an
Anthropic key), and Pydantic AI builds each provider's client from the environment, so the SDK was
given "" as the address. The Bot now removes an empty value before building the model, as
`agent-langgraph-agui` already does, so the SDK uses its own endpoint. A real endpoint is unchanged.

### The Langroid Bot answers on a plain OpenAI key

Picked with an OpenAI key, the Langroid Bot failed every run with "Connection error.". Compose
writes `OPENAI_BASE_URL` empty when the choice is a plain OpenAI key, and the OpenAI SDK only
defaults an absent URL, so it was given "" as the address. The Bot now drops an empty
`OPENAI_BASE_URL` before it builds its client, as it already does for an empty `OPENAI_API_KEY`.
An OpenAI-compatible endpoint is unchanged.

### Find older conversations and keep chat preferences across devices

The sidebar loads older conversations as the person scrolls. Settings save the choice to emphasize
the agent or thread name in the database, with a preview. Agent directory cards have more space,
connected accounts use individual entries with stored app logos, and browser steps appear in a compact
expandable group instead of filling the conversation with screenshots.

## OpenBot 0.0.15
### A model provider's own sign-in can stand in for an API key

`OPENBOT_MODEL_OAUTH_FILE` names a credential file holding a Google or xAI OAuth grant. Set it and
the server mounts `POST /api/model-provider/v1/chat/completions`, which answers an ordinary Chat
Completions request using that grant, refreshing the access token 120 seconds before it expires and
again on a provider 401, and persisting the rotation under a lock the writer and the desktop share.
Leave it unset, which is every deployment that does not set it, and the route does not exist.

The caller authenticates with a separate local bearer taken from that file, compared in constant
time, never with the provider's own token: a refresh token never leaves the server process. The file
itself is refused unless it is a regular file under 64KB owned readable by nobody else, and a Google
grant must name a quota project. The upstream host, path and headers are fixed, so nothing a caller
sends can redirect the request.

Google is reached through its native generation API rather than a compatibility endpoint, with a
translation layer that carries streaming, tool calls and their results, inline images and
function-call thought signatures across in both directions. An API-key connection is unchanged and
still uses the compatibility endpoint.

**A provider 403 no longer reads as an expired sign-in.** It usually means a missing project or
resource permission, which signing in again cannot fix, so only a 401 now raises "sign in again".

### Desktop setup shows progress, chooses its own local ports, and can sign in to a provider

Downloads report transferred bytes, every running step reports elapsed time, and running, completed
and failed stages are told apart. Back preserves the connections already entered.

OpenBot now chooses its local ports by binding them rather than assuming them, holds them until the
whole set is settled, and writes them to the deployment's `.env` so a restart keeps the same
addresses. That covers a port another program holds and a port Windows has reserved, neither of
which the old fixed defaults survived. A port that becomes unavailable between choosing and starting
now says so and asks for another Start, where it previously refused before trying.

Setup can create a CopilotKit project, and offers Google Gemini and xAI as API-key choices alongside
OAuth sign-in. Google sign-in requires this build's own registered desktop client and quota project,
set at build time or by environment variable, and refuses with a message saying so when it has
neither; xAI falls back to a public client and works in any build. `desktop/PROVIDER_OAUTH.md`
describes what a distributor configures.

A deployment left behind by an earlier installation can be detected and reset from the app, which
removes that deployment's database volume and nothing else.

Startup failures keep enough of the log to name the cause, with every secret value redacted, and
carry a support link a whitelabel build can point elsewhere.

### A Bot's image pull finds the Docker credential helper beside Docker

A Docker install whose credential helper sits next to the `docker` binary rather than on the desktop
app's own PATH failed the pull with a PATH error naming the helper. The directory holding the
resolved `docker`, and the directory holding what it points at when it is a symlink, are now appended
to the PATH the engine is invoked with. Appended, so an existing helper still wins, and the inherited
PATH is now kept rather than replaced, which it was not before.

### OpenBot starts only on the Bun it pins

An installed or cached Bun that is not the pinned version is no longer accepted, on install and on
every start, and OpenBot acquires its own copy instead. The version already on the machine is left
exactly as it is and simply not used.

### Organization sign-in survives a callback that arrives in pieces

The loopback listener that receives an organization or provider sign-in read the callback once and
gave up if the whole request had not arrived, and on Windows the accepted socket inherited the
listener's non-blocking mode, so a timeout did not apply. A good sign-in could be answered "Sign-in
did not match". Both paths now read until the request line is complete, with a real timeout.

### Compose file lists separate correctly on Windows

The separator between Compose files fell back to `:` everywhere, which is right on macOS and Linux
and wrong on Windows, where a drive letter contains one. It now follows the platform. This is
reachable on every platform now that a port overlay is passed, where before it was macOS only.

## OpenBot 0.0.14
### A tool cannot be granted for an app this deployment has not added

Granting a Bot a connector's tool checked only that the person asking was an administrator, so a
grant naming an app that was never added was stored and then invisible — the page that reports a
grant nothing advertises is built from the connector's own row, and there was none. Adding that app
later put every such grant straight onto its Bots, with nobody having granted anything and nothing in
the trail saying so. The grant is now refused, naming the app. Taking a grant away is unaffected, so
a dead row an administrator can see is still one they can remove, and a tool a connector has stopped
advertising can still be granted: what a vendor lists today is not what somebody decided yesterday.

### The LiteLLM Bots keep the chosen provider on a model name that contains a slash

A model name the endpoint publishes with a slash in it — `qwen/qwen3-8b`, or the docs example
`openai/gpt-5.6-terra` — was treated as already carrying a provider. LiteLLM then took the first
half as the provider and sent only the rest, so a compatibility endpoint either failed with
`LLM Provider NOT provided` or received `gpt-5.6-terra` instead of the namespaced name. The ADK,
Strands, Agno, LlamaIndex and CrewAI Bots now keep the chosen provider in front, and the whole
model name reaches the endpoint.

### A Google Drive shortcut is read as the file it points at

Search and recent files return shortcuts as ordinary hits, and reading one by that id was refused
as a binary `application/vnd.google-apps.shortcut`. A document somebody had starred or filed as a
shortcut — the usual way a shared drive file is kept at hand — could be named and not opened. The
connector now follows the target once and reads that file the same way it would have if search had
returned it directly. A shortcut that names nothing, or another shortcut, is still declined.

### An MCP tool that answers in structuredContent is no longer read as empty

A tool that declares an output schema often puts the answer in `structuredContent` and leaves the
content list empty. That empty list was reported as "nothing was found", so the model filled the
gap from memory while the vendor had answered. The structured object is now read when the content
list had nothing to say. A tool that already sent text is unchanged.
The slash no longer names the provider on those five Bots, so a `BOT_MODEL` that relied on it to
reach somewhere other than `BOT_PROVIDER` is now read as part of the model name: `bedrock/…`,
`azure/…` and `openrouter/…` reach the provider `BOT_PROVIDER` names rather than the one written in
front of the slash. `BOT_PROVIDER` is the setting for that, and a model name written bare beside it
behaves as it did. The framework Bot `agent-langgraph` and the Langroid Bot are unchanged, because
neither read the slash that way.

### A Bot's computer no longer runs as root on Kubernetes

The image already builds `pwuser`, chowns `/workspace`, `/profiles` and `/app` to it, and the
all-in-one image drops to it through s6. A computer pod overrides the command to run the browser
process alone, so it never reached s6 and ran as uid 0. It now runs as `pwuser` in both the modes
this chart runs a computer in, `shared` and `sandbox`, with `HOME` and `BUN_INSTALL` set the way s6
sets them. `BUN_INSTALL` moves because its default is root-owned, and `bun add` in a Bot's shell
would otherwise stop working the moment the pod stopped being root.

**Kubernetes only.** The Compose and supervisor paths run `agent-computer/Dockerfile`, which builds
no such user and is still uid 0. That is the rest of the residual #261 named and is not this change.

**What it buys, and what it does not.** It is not a containment boundary against a Bot's own shell:
the image grants `pwuser` passwordless sudo for apt-get/apt/dpkg, which escalate to root by design,
and gVisor plus a computer per Bot remain the actual boundary. Nor does it change which Pod
Security Standard the pod meets: `runAsNonRoot` is a **restricted** control, not a baseline one,
and restricted also wants `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]` and a
seccomp profile, which are deliberately not set here for the sudo reason above. The pod met
baseline before this and still does not meet restricted after it. What it does buy is the org
policies and admission rules that reject uid 0 outright, that root-owned data stops accumulating
in the volumes, and that a bug yielding a constrained primitive lands as 1001.

**Before upgrading an existing release, two things.** The kubelet applies `fsGroup` only where the
volume plugin says it can: the EBS, PD and Azure Disk CSI drivers do, `hostPath` does not, and
hostPath is what rancher/local-path-provisioner hands out by default, which is the default
StorageClass on k3s. On storage that cannot, the computer now refuses to start and says so, rather
than coming up healthy with a browser profile Chromium silently replaced, which is what it did
before this release. Chown the directory, or set `computers.podSecurityContext: null`. And an
upgrade run with `helm upgrade --reuse-values` does not pick up a new key at all, so it keeps
running as root and says nothing; pass the value or drop the flag.

**In `computers.mode: sandbox`, existing Bots keep their old computer.** The server copies the pod
template into a Sandbox when it creates one and never updates it, so only Bots created after the
upgrade run as 1001. The server does restart, because the template checksum changes, which makes it
look like the change landed everywhere. The only lever today is `reset`, which deletes that Bot's
volumes and its logins.

`fsGroupChangePolicy: OnRootMismatch` is set deliberately. Unset means `Always`, which walks every
file on every mount; a real Chromium profile is tens of thousands of small ones, and in `sandbox`
mode that pass would run again on every resume from idle.

### Which email domains may sign in, decided by the deployment rather than the provider

Nothing in OpenBot filtered who could sign in. `INITIAL_ADMIN_EMAILS` decides who is an
administrator once they are in, which is a different question. The providers do not answer it
either: `MICROSOFT_OAUTH_TENANT_ID` defaults to `common`, which is any Microsoft account including
personal ones, and Okta has no equivalent setting. So a deployment reachable from the internet
admitted anybody who could complete the flow, as a non-administrator with access to its Bots.

`SIGNIN_ALLOWED_EMAIL_DOMAINS`, or `config.allowedEmailDomains` on the chart, names the domains
admitted. It is checked against the address the provider returns, in the same two hooks the removal
deny list uses, so it covers a first sign-in and an account that already exists. A refusal writes a
`session.refused` audit row naming the reason. Empty means no opinion, so nothing changes for a
deployment that does not set it.

Matching is exact with no wildcards, for the reason `AGENT_ENDPOINT_ALLOWED_HOSTS` gives:
`example.com` admits neither `sub.example.com` nor `evil-example.com`. Both sides go through the
same IDNA normalisation, so a list may be written `@Example.COM.` or in punycode and still mean
what it says.

**It is a filter, not a boundary, and the deployment is told so.** OpenBot does not require a
verified address, and Entra's `email` claim comes from a directory attribute that the signing-in
tenant's own administrator writes. Two consequences, both now enforced at start-up rather than
documented and hoped for:

- Naming domains while `MICROSOFT_OAUTH_TENANT_ID` names no directory is **refused**. That is
  `common`, and equally `organizations`, which Microsoft describes as admitting any work or school
  account in any directory, and `consumers`. Anybody can create a tenant and write your domain into
  their own user, so the list would refuse the honest and admit the rest while reading as a
  control. Set your directory GUID.
- A list that names nothing, which `SIGNIN_ALLOWED_EMAIL_DOMAINS=@` and a stray `.` both produce, is
  **refused**. It is a non-empty list no address can match, and left to run it turns every visitor
  away with nothing said at boot.

A deployment that names no domains and leaves the tenant multi-tenant warns instead of refusing,
because genuinely multi-tenant is a real deployment.

### No sign-in cannot be combined with a public address

`OPENBOT_SINGLE_USER=true` admits every request as one administrator. The flag is how somebody says
they meant that, and it still is. What was missing is the second question: one administrator and no
sign-in is a thing you run where only you can reach it, and nothing checked the address.

It is now refused alongside an `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL` or `TRUSTED_ORIGINS` entry
that the public internet routes to, and the refusal names the address it objected to. This is the
rule the chart already applies twice, in `validation.yaml`, moved to where a deployment that never
goes near Helm is asked it too: `.env.example` ships the flag on so that a clone runs, and README's
"Deploy it" hands that same `.env` to `docker run`, where the only thing separating a laptop from a
server is an address.

**Public, not "not loopback", and the difference is most of the deployments this flag has.** A home
server at `192.168.1.10`, a Tailnet address, a VPN address, `openbot.local`, a bare hostname with
no dot in it: none of those is loopback and none of them is a stranger's to reach. Refusing them
would refuse the feature's own audience, and the only way out would be to turn off the flag that
describes what the operator is doing. Those run, and warn once at boot that anybody on that network
is the administrator. Loopback is silent. A value that cannot be parsed as a URL counts as public,
because a value nobody could read is not one anybody checked.

Nothing on loopback changes, so the local workflow the flag exists for is untouched, and neither is
the chart's `config.singleUser` trial mode, which sets no public address. A deployment naming an
external authority through `OPENBOT_ORGANIZATION_AUTH_URL` is unaffected too: the authority wins
before this is consulted. Explicitly NOT gated on `NODE_ENV`: the image and the chart both set it
to `production` for every deployment including that trial, so it says nothing about who can reach
a deployment.

`docs/architecture.md`, `docs/deployment.md` and `docs/configuration.md` all described the old rule
and now describe this one.

### The EKS cluster recipe puts the node's IAM role out of a Bot's reach

A Bot has a shell, and a shell reaches whatever its pod reaches, including the instance metadata
service at 169.254.169.254 that hands out the node's IAM role. The NetworkPolicy excepts that
address, but it is off by default and does nothing on EKS until the VPC CNI is told to enforce it,
so the cluster config in the chart README now sets `disableIMDSv1` and `disablePodIMDS` on the node
group, which closes it at the node whatever the CNI is doing.

`disablePodIMDS` is the line that does the work: it sets the hop limit to 1, and that governs the
IMDSv2 token PUT, so a pod one hop further out than the node cannot get a token. `disableIMDSv1` is
written beside it to say so out loud rather than to change anything, because eksctl defaults it to
true and sets `httpTokens: required` for either flag. Pods on the cluster network are covered; one
running with `hostNetwork: true` is on the node and is not.

**It costs something, and the recipe says so.** The EBS CSI driver reads instance metadata from
IMDS, and its own documentation asks for a hop limit of 2 or greater in a containerized environment.
A hop limit of 1 also rules out `MutableCSINodeAllocatableCount`, which requires IMDS to be the
driver's metadata source. Take these two lines out if you need that.

Nothing in OpenBot wants pod-level IMDS: the chart reaches AWS through IRSA. Documentation only; no
chart template changed, and an existing cluster is unaffected until its node group is recreated.

### A large text file says so on the composer before it is sent

The model reads the first 120,000 characters of an attached text file and the rest is dropped. The
part said so to the model and nothing said so to the person attaching it, so a 1MB CSV was answered
from roughly a tenth of itself with nothing on screen to explain the answer. A staged file over that
ceiling now carries "may be cut" beside its size, with the exact number on hover. Warned, never
refused: the whole file is still uploaded and still stored.

Whether a file is text is decided by what the server read in its bytes, not by what the browser
called it, so a file the browser labelled an image and the server read as text is warned about too.
That is the file the old reading would have missed.

### ADK and Langroid Bots can call the tools OpenBot supplies

Both answered text prompts on an OpenAI key and neither could reliably use the tools the deployment
supplies them, so a Bot on either harness could talk but could not act. ADK now registers the
documented `AGUIToolset`. Langroid now sends each run's tool schemas and its complete message
history, tool results included, so a tool's answer reaches the model that asked for it. Each run
keeps its own tool and history state.

### Built-in Bots carry a model provider's sign-in failure through as itself

A built-in or LangGraph Bot whose model credential had expired ended the run as a generic failure,
which reads as the Bot being broken. The run now ends with `OPENBOT_MODEL_AUTH_REQUIRED` and says to
sign in to the model provider again.

The built-in Bot's tool loop also moved to the server, which owns the grants that decide what a tool
may do. The harness is given model input alone, and a tool result is resolved against the call that
produced it, so a Bot can carry a multi-step task across several tool calls rather than losing the
thread after the first.

### A deployment can name an organization authority that decides who it admits

`OPENBOT_ORGANIZATION_AUTH_URL` points at an OpenBot deployment configured with Google, Microsoft or
Okta, which verifies who somebody is and what roles they currently hold. It is separate from any
Intelligence connection, and the authority keeps its own secrets.

Naming one settles the sign-in question by itself: it wins over `OPENBOT_SINGLE_USER`, so a
deployment carrying a leftover single-user flag admits verified people rather than admitting
everybody as one administrator.

### A coworker can be a file of its own

The example package declared every coworker in one `agents.yaml`, so adding one meant editing a file
somebody else was editing too, and handing somebody a coworker meant handing them a fragment to
paste into the middle of theirs. A package may now also keep a coworker per file in an `agents/`
directory beside `agents.yaml`, and both are read. A package that keeps everything in `agents.yaml`
loads exactly as before. A file holds the coworker on its own or a list under `agents:`, only
`.yaml` and `.yml` are read, and files are read in filename order. Two declarations of the same id
stop the server and both files are named, rather than one quietly winning on the order a directory
was listed in. The directory is in the package checksum, so a coworker added or edited there is a
package change a running deployment notices.

### Ten more example coworkers, each doing one job

The example package shipped three coworkers, which is enough to prove the format and not enough to
give anybody ideas, and writing a `role_description` cold is the part that decides whether a
coworker answers usefully or vaguely. Ten more ship in `examples/fintech/agents/`, one file each:
reading an expense claim against the policy as written, turning a meeting note into the follow-ups
actually in it, drafting release notes from what shipped, triaging a support ticket, answering a new
starter from the handbook, writing a brief that names what it could not find, writing up an
interview with question, answer and observation kept apart, handing an on-call shift over from the
record, assembling what is known before a renewal decision, and grouping customer feedback into
themes it can cite. Each says what the job is, what the coworker must not do, and what to say when
it cannot find something. They grant nothing: a coworker names skills, a skill names tools, and what
it may call is what an administrator has granted. Delete the ones you do not want.

### Built-in and Mastra Bots can run on Anthropic API keys

The example built-in Bots and the Mastra Bot now use the selected model provider instead of
assuming OpenAI. A deployment with `BOT_PROVIDER=anthropic`, `BOT_MODEL=claude-sonnet-4-5` and an
Anthropic key routes built-in model calls, tool selection and Mastra runs through Anthropic's native
API. Source startup no longer waits for the unused OpenAI-only sample when Anthropic is selected.

### The Agno Bot answers on an OpenAI key

Picked with an OpenAI key, the Agno Bot failed every run before reaching OpenAI. Agno sends a
temperature and a `top_p` with each request, and LiteLLM refuses both for `gpt-5.5`, the model
Compose passes when the setup screen names none, so the run ended in `UnsupportedParamsError`. A
parameter the model does not take is now dropped instead, the way the LlamaIndex Bot already does
it. The Anthropic key and an OpenAI-compatible endpoint behave as before.

### The Pydantic AI Bot starts on an Ollama model named with its tag

Ollama names every model with a tag after a colon, as in `llama3.1:8b`, and that is the name the
setup screen passes on for an OpenAI-compatible endpoint. The Pydantic AI Bot took any colon in the
model's name to mean the name already carried a provider, so Pydantic AI read `llama3.1` as one,
refused it as unknown, and the Bot never started. A model's name now carries a provider only when it
begins with the chosen provider's own, as in `anthropic:claude-sonnet-4-5`.

### The Langroid Bot starts on an Anthropic key

Picked with an Anthropic key, the Langroid Bot exited on startup asking for an OpenAI key. It names
a model from any provider but OpenAI through litellm, which its image did not install, and Langroid
builds an OpenAI client for such a model all the same, from the `OPENAI_API_KEY` Compose writes
empty when the choice was not OpenAI. The image now installs Langroid's litellm extra and an empty
OpenAI key is treated as none, so the Bot starts and answers with the Anthropic model chosen.

### The AG2 Bot answers on an Anthropic key

The AG2 Bot built an OpenAI client whatever the setup screen chose, and read `BOT_MODEL` but never
`BOT_PROVIDER`. Picked with an Anthropic key, every run failed asking for an OpenAI key, because
Compose writes that one empty when the choice was Anthropic. It now reaches Anthropic through AG2's
own Anthropic client when that is the provider chosen, and OpenAI or an OpenAI-compatible endpoint
as before otherwise.

### The Microsoft Agent Framework Bot starts on an Anthropic key

The Microsoft Agent Framework Bot built an OpenAI client whatever the setup screen chose, and read
`BOT_MODEL` but never `BOT_PROVIDER`. Picked with an Anthropic key, it exited on startup asking for
an OpenAI key, because Compose writes that one empty when the choice was Anthropic. It now reaches
Anthropic through Agent Framework's own Anthropic client when that is the provider chosen, and
OpenAI or an OpenAI-compatible endpoint as before otherwise.

## OpenBot 0.0.13
### Fresh desktop setup installs its runtime before sign-in

Desktop setup installs local software before asking for an AI connection. Fresh Mac Podman
installations no longer duplicate stack port bindings. The shared installer downloads verified
prebuilt Bun binaries without developer tools; Linux setup also installs its native Podman runtime
and certificate bundle. (#604)

### Ctrl+B shows and hides the sidebar on a layout that does not write Latin letters

The sidebar toggle's tooltip names Ctrl+B, or ⌘B on a Mac, and the shortcut was recognised by the
character the key writes. On a Russian or Greek layout the B key writes "и" or "β", so the shortcut
did nothing there. It is now read the way the app's own shortcuts read it since Shift+N was fixed
for the same layouts: from the physical key when the layout writes a character outside ASCII there.

### Scrolling a Bot's browser no longer scrolls or zooms the page around it

While somebody drives a Bot's browser, a turn of the mouse wheel over its screen is sent to it, and
the screen was meant to keep the wheel from also acting on the app. React attaches its wheel handler
as a passive listener, which a browser does not allow to do that, so the wheel scrolled the frame
holding the Bot's screen along with the Bot's page, and Ctrl with the wheel zoomed the app. The
wheel is now handled by a listener that can hold it, so it reaches only the Bot's browser.

### Typing into a Bot's browser no longer triggers the app's own shortcuts

While somebody drives a Bot's browser, every keystroke is sent to it. The app's shortcuts listen for
keystrokes too, and they heard each one first, so typing a capital N into the Bot's browser, as in
"New York", started a new chat and took the person away from the Bot mid-word, and Ctrl+B there
also showed or hid the sidebar. A keystroke sent to the Bot's browser now reaches only the Bot's
browser. Escape still closes the view, and the paste shortcut still pastes.

### The Python LangGraph Bot on Anthropic answers after a skill was picked

A skill somebody picks reaches the Bot as a system message just ahead of their message, and it
stays in the conversation. Anthropic takes one system prompt, and its LangChain integration refuses
a system message that comes after a turn of the conversation, so with `BOT_PROVIDER=anthropic`
every run in that conversation failed from then on, before the model was asked. On Anthropic the
Python LangGraph Bot now puts every system message ahead of the conversation, in the order given,
where the integration joins them into its one prompt. Runs on OpenAI and Gemini are unchanged.

### The LangGraph Bot answers on Anthropic and Gemini

With `BOT_PROVIDER=anthropic` or `BOT_PROVIDER=google`, the LangGraph Bot answered nothing: every run
ended in an error before the model was asked. Those two providers take one system prompt, at the top,
and the Bot handed its model several: its own guidance, the context the app sends, and the
coworker's standing role, which the server puts at the head of every run. The provider's LangChain
integration refused the second one. On those two providers the Bot now folds them into one system
prompt, in the same order, and a skill picked for a message joins it. Runs on OpenAI are unchanged.

### The proof-of-concept Bot reads a model name set with whitespace around it

A `BOT_MODEL` carrying a leading space reached this Bot as it was written. Its startup check refuses
`gpt-5.6-*`, which rejects function tools on the API this Bot speaks, and that check matches from the
start of the name, so a padded one walked past it: the Bot started, reported healthy, and answered
nothing at all on the first turn that used a tool. An empty value was read the same way and asked the
provider for a model with no name. Both now fall back to the default, and the name is used trimmed.
`.env` was never a route to this — Compose, Bun and the desktop shell each strip the value first — so
it reached only deployments that set the variable directly, such as a Kubernetes manifest or
`docker run -e`.

### Pasting into a Bot's browser works on a layout that does not write Latin letters

While somebody drives a Bot's browser, Ctrl+V or Cmd+V is left to the local page so its paste event
can send the clipboard text across. The shortcut was recognised by the character the key writes,
and on a Russian or Greek layout the V key writes "м" or "ω", so the keystroke went to the Bot's
browser instead and nothing was pasted. The V is now read the way the app's own shortcuts read it
since Shift+N was fixed for the same layouts: from the physical key when the layout writes a
character outside ASCII there.

### Reading a large file from Google Drive no longer downloads all of it

`read_file_content` shows a Bot at most the first 20,000 characters of a file, but it downloaded the
whole file and held it in memory before cutting it. A 200 MB text file raised the server's memory by
more than 600 MB for one call, on the process that serves everybody else. The connector now stops
reading once it has more than it can show and cancels the rest of the download. What the Bot is shown
is unchanged, except that the note on a cut file no longer gives the file's full length, which is no
longer known.

### A Bot reads the text an MCP server returns as an embedded resource

A tool result can carry an embedded resource, and a text resource holds content, such as a file the
server read. The MCP connector passed text parts to the Bot and named every other part, so a text
resource reached the model as `[resource]` and its contents were dropped. GitHub's MCP server answers
`get_file_contents` for a text file this way: the Bot was told the download worked and never saw the
file. The text of an embedded resource is now passed on like a text part. A resource that carries
bytes is still named.

### The Google Drive connector reaches files in shared drives

Drive leaves shared drive items out of any `files.get` or `files.list` request that does not say it
supports shared drives, and none of the connector's requests said so. A document the person could
open in a shared drive was "File not found" to `get_file_metadata` and `read_file_content`, and never
appeared in `search_files` or `list_recent_files`. Those requests now say they support shared drives,
and the listings ask for shared drive items. Listings keep Drive's default `user` scope rather than
searching every shared drive.

### Google Drive search and recent files leave out what is in the trash

Drive's `files.list` returns trashed files unless the query excludes them, and neither `search_files`
nor `list_recent_files` did. A document somebody had thrown away came back to the Bot as a match or
as a recently changed file, with nothing in its line to say it was in the trash, so the Bot could
answer from it as though it were current. Both now ask Drive to leave the trash out. Reading a file by its
id is unchanged.

### New conversations are still named once some older ones could not be

Every pass of the job that names conversations offered at most twenty of those still without a name.
A conversation it had tried and could not name, for example because the model answered with no text
or the conversation opened with only an attachment, keeps no name, so it stayed among those twenty
and took a place on every pass, although offering it again did nothing. Once enough of them had built
up, a new conversation could miss out on every pass and keep showing its plain name in the sidebar.
A pass now skips any conversation that the job already holds work for, so new ones get a place. One
it could not name is still tried again later, as before.

### An offboarding one app refuses still records the apps that answered

Removing somebody withdraws each brokered account they connected. When the broker refused one of
those apps, the whole act stopped before anything was recorded: apps already withdrawn at Composio
kept their `composio_connections` row and left nothing on the trail saying the account had ended,
and the retry that #574 made the recovery then asked again, was told there was nothing to withdraw,
and wrote `vendorRevocationRequested: false` about a withdrawal this deployment had asked for and
got. Each app is now asked, recorded with the answer it actually gave and its row removed, and only
the apps that were refused are left standing for the retry. The act still fails and still answers
500, so a refusal is as loud as it was.

### Paging the audit trail no longer skips rows written in the same millisecond

`GET /api/admin/audit-events` hands out a `nextCursor` built from the last row's timestamp, which the
server read at millisecond precision while PostgreSQL keeps microseconds. The cursor therefore named a
moment just before that row, and the rows the next page should have started with, written earlier in
the same millisecond, were on no page at all. Anything that walked the trail page by page could miss
them without any sign of it. The cursor now carries the row's full timestamp. A cursor issued before
this change still reads.

### The New chat shortcut works on a Russian or Greek keyboard layout

Settings lists New chat as Shift+N, and the app matched the character the keystroke wrote. A layout
that writes another script has no key that writes an N: Shift and the N key write "Т" on Russian and
"Ν" on Greek, so the shortcut never fired there. When the character is not ASCII, the app now reads
the physical key instead. A layout that writes Latin letters, such as Dvorak, still goes by the letter.

### Enter that confirms a typed character no longer saves a name, a rule or a wizard step

Japanese, Chinese and Korean are typed through an input method, where Enter confirms the character
being built. In three fields that Enter also acted: editing a coworker's name or title saved it with
the character still unconfirmed, the new-coworker wizard moved on to its next step, and a boundary
rule was saved into the policy in force. Those fields now wait for the character, the way the chat
composer already does, and an ordinary Enter works as before.

### A built-in coworker can be edited where the deployment's own Bot is on localhost

A coworker created as Built in is stored pointing at the managed Bot's address. Editing its name,
title, role or visibility sent that address back as though somebody had typed it, and the server
checks an endpoint it is sent the way it checks a person's. `scripts/start.sh` puts the managed Bot on
`http://localhost:4201/ag-ui`, which that check refuses unless private hosts are opened, so every edit
failed with "That address is inside this deployment's own network, so an agent may not live there."
The dialog now leaves a built-in coworker's address where it is stored. A coworker somebody hosts
still sends its own endpoint, as before.

### A long page's text is cut between characters, not through one

A navigation hands the Bot the first 6000 UTF-16 code units of the page's readable text. When that
limit fell between the two halves of an emoji, the Bot was handed text ending on half a character,
which reads as U+FFFD: a broken character that is not on the page. It now stops one code unit short
in that case, which is what a control's name and value in a page snapshot already did.

### Tool selection reads a skill choice the model wrapped in a code fence

Before a run, the deployment's model picks which of a Bot's skills the message needs, so a Bot holding
many tools is offered only the relevant ones. The request asks for bare JSON, but an endpoint that
ignores `response_format`, as Anthropic's OpenAI-compatible one does, lets the model fence the object
or lead with a sentence. Every such answer read as no answer, so the Bot was offered every tool it
holds and the audit row said `unavailable`. The object is now read out of the answer, the way the
router already reads its own. A bare JSON answer is read as before.

### A long message reaches the coworker it is for, and is recorded

A message over 10,000 characters, such as a pasted email thread or log, was refused by the router
since it started capping the text it reads. The home composer carries on past a routing that fails,
so the message went to the default coworker rather than the one it is for, and a coworker chosen with
`@` or from the To: field started with no `channel.routed` row. The app now asks the router about the
message's opening, and the whole message still goes to the coworker. Shorter messages route as
before.

### Removing somebody is recorded even when retiring what they owned fails

Removing somebody denies their access and ends their sessions, then retires the credentials and
brokered connections they had granted this deployment. When that second half failed — a vault or
Composio not answering — the removal was already committed but nothing was written to the audit trail,
and removing them a second time reported success without retrying it, leaving those connections
standing. The removal is now recorded as soon as it takes effect, and removing somebody already
removed finishes the retirement that failed.

### Removing a connector takes its grants with it

A grant naming a connector's tool outlived the connector. Removing an app revoked every credential
and every brokered account and deleted the app itself, and left the grant rows behind, naming a
server that no longer existed. Nothing showed them: the page that reports grants a connector no
longer advertises reads them off the connector's own row, and there was none. Adding the same app
back — which mints the same id, and so the same tool names — put every action it had back on every
Bot that used to hold it, with nobody granting anything and no row in the trail saying a grant had
been made. An app's grants are now removed in the same step as the app, the removal records which
grants it released and from which Bots, and a migration drops the grants earlier removals left
behind. Grants for other connectors, and skill grants, are untouched.

### A vendor that broke no longer reads as a refusal to a Bot running its own loop

When a Bot that calls tools back from its own process, such as the LangGraph Bots, called a tool
whose vendor failed, or hit a fault in this deployment, the answer began "Refused." like a boundary
holding. The conversation drew it as blocked and the model read it as not allowed, while the audit
trail recorded a failed call. Only a refusal is marked now. A vendor that broke reads "That tool could
not be called: …", the way it already did for a Bot running here, and a refusal reads as before.

### A Bot running its own loop is told a vendor's error is the vendor's

A vendor that says no by answering with an error, the way an MCP server refuses a call, reached a Bot
running here as "The vendor reported an error: …", and reached a Bot calling tools back from its own
process, such as the LangGraph Bots, as the bare sentence. Those Bots pass the answer on as they
receive it, so their model read something like Google's "The caller does not have permission" as an
ordinary result, and could tell the person they had no access rather than that the vendor had refused.
Both kinds of Bot are now told the same thing. A result that is not an error, and this deployment's
own refusals, read as before.

### A long Composio result or failure is cut between characters, not through an emoji

A Composio action's answer over 20,000 characters, and a failure sentence as long, were cut by UTF-16
code unit. When the cut landed inside an emoji or any other character outside the Basic Multilingual
Plane, the text handed to the model ended on half of it: a lone surrogate that JSON carries as a bare
`\ud83d` and UTF-8 turns into a replacement character. The cut now stops one unit short in that case,
the way the MCP and built-in transports' cuts already do. Anything that fits is untouched, and the
note saying the answer was cut reads as before.

## OpenBot 0.0.12
### A deployment can broker its Bots into a few hundred apps through Composio

Composio holds a person's connections to a few hundred SaaS apps behind one account. A deployment
that sets `COMPOSIO_API_KEY` now has that broker: each person connects their own accounts, a Bot is
granted an app's tools the way it is granted any other, and every call is decided and recorded
through the gateway like the rest. Unset, there is nothing to connect, nothing to grant and no
Composio tool for a Bot to call, and the Plugins page says so under **More apps** rather than
pretending otherwise. See [docs/plugins/composio.md](docs/plugins/composio.md).

### A skill's grants are removed when it is uninstalled

Uninstalling a skill deleted the skill but left its tool grants, which are keyed by its slug. A new
skill created under the same slug then inherited them, and was offered on the Bots the old skill had
been granted to with no grant ever made for it. Uninstalling now removes a skill's grants along with
it, in one transaction, and an upgrade drops any grants already left orphaned this way.

### Malformed requests are refused instead of coerced, and a fail-open is closed

A pass across the write and query surface answers a malformed request with a 400 that names the bad
field, rather than coercing it, failing at the store, or letting it through: the plugin server and
tool-call endpoints, the admin people search and credential input, skill tools and grant ids, blank
route ids on routines, host-access, agents and channels, the routing text length, routine dispatch
and page-frame params, and the runtime env, tokens and model content the computer and supervisor
read. The app reads these responses more defensively too, degrading rather than throwing on a shape
it did not expect.

One of these closed a hole rather than tightening an edge: a skill installed with a non-string entry
in its `tools` list had that entry silently dropped, so the skill declared nothing and installed as a
success. It is refused now.

### Naming a conversation asks the endpoint OPENAI_BASE_URL names, not OpenAI

The job that names a conversation sent its request to api.openai.com whatever `OPENAI_BASE_URL` said,
while the Bots, the router and tool selection all used the configured endpoint. A deployment behind a
gateway, a proxy or a local model therefore sent its model key, and the opening of every
conversation, to OpenAI; OpenAI refused the key, so no conversation was ever named. The request now
goes to the same endpoint as every other model call. A deployment that never set `OPENAI_BASE_URL`
behaves as before.

### A Bot's question to a person survives a route that fails

Who "a person" is, is a seam a deployment fills in with its own on-call rota or duty desk. If that
route failed by throwing rather than by returning a refusal — a timeout, a 502, a name that does not
resolve — the error came straight back out of the tool, so the Bot's run ended with nothing said to
the person waiting, and no audit row recorded that the question had reached nobody. The Bot is now
told, in a sentence it can say, that nobody could be asked and that it must not claim otherwise, and
an `agent.escalation_failed` row goes down carrying what the route actually threw. Deployments using
the shipped in-conversation route are unaffected: it cannot fail.

### Resetting a Bot's computer while the Bot is acting signs it out

On a deployment with one shared computer, which is what the published image and the Helm chart run by
default, a reset takes about two seconds to close the browser before it deletes the profile. A Bot
action that arrived in that window started a new browser from the profile about to be deleted, so the
Bot stayed signed in to everything until that browser next closed, while the reset reported success
and the audit trail recorded the saved state as deleted. A Bot's browser is no longer reopened while
it is being closed: the action waits for the reset to finish and starts signed out. Computers the
supervisor makes per Bot were not affected.

### A long control name or value in a page snapshot is cut between characters

The computer's page snapshot keeps the first 200 UTF-16 code units of each control's accessible
name and value. When that limit fell between the two halves of an emoji, the Bot was handed text
ending on half a character, which reads as U+FFFD: a broken character that is not on the page, often
at the end of a message the Bot had just typed into a text box. The cut now stops one code unit
short in that case, the same rule tool results and relayed answers already follow.

### A Bot's shell can no longer read the deployment's keys from a neighbouring process

In the all-in-one image the API and the browser ran under one account, and a Bot's shell — a child
of the browser — could read a same-account process's environment through `/proc`, whatever its own
environment had been scrubbed to. One allowed `computer_run_command` returned `KEY_ENCRYPTION_KEY`,
the session-signing secret and the database password, none of it on the audit trail. The API and its
migrations now run as their own account, so the kernel refuses that read; the browser is handed only
the variables it needs, so its own environment carries none of those keys; and the files under
`/run/s6/container_environment` are closed to the shell. A deployment that runs each Bot in its own
sandboxed computer, as the documentation asks for, was never exposed to this.

## OpenBot 0.0.11
### The LlamaIndex Bot answers with the model the setup screen chose

The LlamaIndex Bot built an OpenAI client from `BOT_MODEL` and ignored `BOT_PROVIDER`, so it only
worked with an OpenAI model name sent to OpenAI. Picked with an Anthropic key, every run failed with
`Unknown model 'claude-sonnet-4-5'`; picked with an OpenAI-compatible endpoint, every run failed
with `Unknown model` for that endpoint's model, and an OpenAI model name went to api.openai.com
instead of the address given, because the client read `OPENAI_API_BASE` and not the
`OPENAI_BASE_URL` Compose passes. It now reaches the model through LiteLLM as `provider/model`, the
way the Agno Bot does, so all three choices answer. A model LiteLLM does not know is treated as able
to call tools, which the AG-UI workflow requires, and parameters a model does not accept, such as
the temperature LlamaIndex sends to a reasoning model, are dropped rather than refused.

### The Audit page says "not enforced" only under a dry-run refusal that went ahead

On a deployment in `dry-run`, the Audit page printed "dry-run: recorded, not enforced" under every
allowed action, because an allowed action is always carried out, and under a tool call content
inspection had refused, because that row copied `carriedOut: true` from the policy step before the
call was stopped. The line now appears only on a row the policy refused and dry-run let through,
which is the one case it describes. A tool call refused for carrying credential material is now
recorded with `carriedOut: false` in every mode. Rows already written keep their old value, and the
page reads them correctly either way.

### The Routines page says when nothing is there to run them

A routine needs a second process to fire it, and a deployment that never started one looked exactly
like a deployment that had: the routine was stored, its schedule was computed, and the page showed it
waiting with a next run time, right up until nobody's standup notes arrived. Every sweep now records
that it happened, and the page reads that record. Somebody with standing routines and nothing
sweeping is told so — that no worker has ever checked in, or when the last one did — instead of
being shown a page that looks correct. The window is the fifteen minutes a routine's own schedule
already has as its floor, so a gap longer than that is one no routine could have wanted.

### A long tool result or relayed answer is cut between characters, not through an emoji

A tool result over 20,000 characters, and a Bot's answer over 12,000 relayed back through a handoff,
were cut by UTF-16 code unit. When the cut landed inside an emoji or any other character outside the
Basic Multilingual Plane, the text handed to the model ended on half of it: a lone surrogate that
JSON carries as a bare `\ud83d` and UTF-8 turns into a replacement character. The cut now stops one
unit short in that case, the way an attached text file's already did. Anything that fits is
untouched, and the note saying the result was cut reads as before.

### A boundary rule can ask what started a run, not only whose authority it carries

A routine's turn goes through exactly the path a person's chat turn does, as the routine's owner:
their grants, their connections, their thread. That is the right design, and it is also why
`actor.id` cannot tell a scheduled run at three in the morning from the same person typing. The
trail already drew that distinction — `AuditInitiator` is signed into the run assertion and written
onto the row, so an investigator can see a routine caused something. A rule could not ask the same
question.

The policy context now carries `initiator`, with the kind and id the trail already records, so this
is writable:

```
deny: initiator.kind == "routine" && intent == "run_command"
```

A deployment happy for a Bot to run a shell while somebody watches, and not happy for it to do so
unattended, can now say so. The id is there too, so a single routine can be named rather than
scheduled runs as a class. `handoff` is its own kind, for a Bot that hands work to another Bot.

**Nothing is refused that was not refused before.** The field is neutral — `{kind: "person", id: ""}`
— everywhere a person is driving, which is every path that does not carry an initiator today,
including every action on a Bot's computer: those are driven by the browser, so they really are
somebody's session. It is required rather than optional for the reason #115 exists: cel-js throws on
an unbound identifier and a throw fails closed, so a field that were sometimes absent would turn one
rule about routines into a deployment that refused every ordinary click.

Replaying a rule against history reads the initiator off the row when it is there and treats a row
that predates the field, or carries a shape this version does not recognise, as a person.

### The Python LangGraph Bot tells its model why the deployment refused a tool call

When the deployment would not run a tool call from the Python LangGraph Bot — a token it no longer
accepts, one issued to another Bot, or a malformed call — it answered with the status and a reason
under `error`, and the Bot told its model only "Refused. Tool callback returned HTTP 403." The model
could say a call was refused but not why, and could not correct a call the deployment had named as
malformed. The reason now follows the status, the way the TypeScript LangGraph Bot already passes it
on. A refusal with no readable reason reads exactly as before.

### A tool argument that starts with "Basic" or "Bearer" is no longer refused as a credential

Content inspection read any MCP tool argument whose first word was "basic" or "bearer", in any case,
as an authorization header. A Bot searching Drive for "Basic onboarding checklist", or posting
"Bearer of bad news" to a channel, was refused because its arguments "contain credential material".
Those words are now refused only when what follows them is shaped like a credential: base64 that
decodes to `user:password` after `Basic`, and a token of at least 16 characters with a digit,
punctuation or mixed case after `Bearer`. A shorter bearer token, or a Basic value that does not
decode to `user:password`, is no longer caught by this pattern; the same value under an
`authorization` field is still refused by name.

## OpenBot 0.0.10
### The LangGraph Bot says a refused tool call was refused, not that it found nothing

When the deployment would not run a tool call from the LangGraph Bot — a token it no longer accepts,
or one issued to another Bot — it answered 401 or 403 with a reason and no result, and the Bot told
its model "The tool returned nothing." The model then told the person nothing was found. The Bot now
tells its model the call was refused, with the status and the deployment's reason, the way the
Python LangGraph Bot already does, and the transcript draws it as a refusal. A tool that answered is
passed on exactly as before.

### Revoking a grant with a blank ref or Bot is refused instead of reported as done

`DELETE /api/plugins/grants` checked its query params with truthiness, and a query param is
always a string: `?ref=%20%20` is truthy, so it skipped the 400, deleted zero rows by exact
match, still wrote a `plugin_revoked` audit row naming whitespace, and answered `ok:true`. The
`POST` twin already required trimmed non-empty strings. `DELETE` requires the same now and acts
on the trimmed values, so a blank ref or Bot is a 400 with the same message, no delete, and no
audit row.

### The Bot in the box and the LangGraph Bot read a message that has a file attached

A message with a file attached reached both Bots as `[object Object],[object Object]`, in place of
what the person typed and the file both: they read a message as a string, and one carrying a file is
a list of parts. Each part now reaches the model as what it is — the words, the text of an attached
file, an attached image — and a part neither can read is named rather than dropped.

### A fractional or out-of-range computer setting takes the fallback instead of breaking the boot

`numberFromEnv` accepted anything `Number` called finite and positive, so `PORT=80.5` bound
nothing usable, `PORT=99999` misbound at boot, a fractional timeout fired before any action could
finish, and `COMPUTER_MAX_BROWSERS=2.5` reached eviction math as a fraction — each reading as a
broken computer rather than a mistaken variable. Every reader is a port, a timeout, or a count,
so only whole numbers on sight are values now and anything else takes the documented fallback;
the port additionally keeps its 1–65535 range, the way the supervisor's own port parser already
does. Zero semantics are unchanged: `COMPUTER_BROWSER_IDLE_MS=0` still keeps browsers resident.

### A malformed page size is refused instead of silently coerced

`GET /channels` and `GET /api/admin/people` read `?limit=` with `Number.parseInt`, which
coerces: `?limit=12abc` arrived as 12, `?limit=3.9` as 3, and each answered 200 with a silently
wrong page. Both now share one strict parser with the audit list's rule: absent or blank leaves
the store default alone, a run of digits is clamped into range against the same ceiling the store
enforces, and anything else is a 400 naming the parameter, before the database is reached.

### A skill written with a non-string slug or summary is refused instead of failing the insert

`POST /api/plugins/skills` checked presence with truthiness and then ran the slug regex, which
coerces: `{"slug":123}` tested the string `"123"` and passed validation, and `{"summary":{}}` had
no check at all. Both reached the store, where the insert threw an uncaught error — a 500 for a
caller error. A slug, a title and instructions must be non-empty strings now, the slug pattern is
tested only after that, and a summary must be absent or a string; anything else is a 400 naming
the field, before any refusal check, store write, or audit row.

### More endpoints refuse a malformed request instead of coercing it or failing open

The same treatment reached the rest of the write and query surface: the agent tool-call endpoint's
name and arguments, the policy dry-run and audit-event list limits, a component's publication flag,
the sandboxed-component fields, and a catalogue entry are each checked and answered with a 400 that
names the bad field before the store is touched. The four hand-driven computer gestures — click,
type, key and scroll — validate their own payloads the same way, so a click with no coordinates or a
key with no key is refused rather than sent to the computer as a no-op.

One of these closed a hole rather than tightening an edge. A component's list of decision functions
was filtered to the strings in it, so `{"functions":[123,null,{}]}` became an empty list, the
permission check ran over nothing, and the answer came back `allowed` for functions the caller had in
fact named. The verdict is about the functions named now, or a 400; an absent list still means none.

### Generated interfaces, tables and forms

Generative UI is enabled by default; set `OPENBOT_GENERATIVE_UI=false` or `0` to disable it.
Bots can render A2UI interfaces, compare records in sortable tables, and collect related answers in
a form that waits for submission. LangGraph receives the component schemas needed to draw these
interfaces correctly.

The playground rejects invalid JSON before saving or publishing, confirms successful saves, and
shows published custom components in the administrator's gallery.

### A Bot's computer is rebuilt when it holds a token the deployment has stopped using

A computer checks every caller against the `COMPUTER_TOKEN` it was created with, and holds that one
for the life of the container. The shell mints the generated secrets once per deployment and does
not rotate them, precisely because a computer outlives a restart, so ordinarily there is nothing
here to go wrong. Setting a machine up again from nothing is the occasion where the token really
does change: the credential store is emptied, a new one is minted, compose rebuilds everything it
owns with it, and the computers, which the supervisor makes rather than compose, survive holding the
old one.

Everything then refuses, and nothing says why. The gateway allows the action and the trail records it
as carried out, the computer answers 401, and the screen says "Not authorised" while naming no token
and no container. Measured on a first run of v0.0.9 against a computer made by the install before it,
five days earlier: every page the Bot tried to open, and the live screen beside it, failed that way.

The supervisor now replaces a computer whose token is not the one it is handing out, the same way it
already replaces one built from an older image, keeping the profile and workspace volumes so the Bot
comes back with its logins and its files. A deployment that sets no token is left alone, because a
computer with no door on it is a choice the environment made rather than a mismatch to act on.

## OpenBot 0.0.9
### The People screen keeps a person's last sign-in when their sessions go away

`Last signed in` was `max(sessions.created_at)`, so it disappeared whenever the session rows behind
it did: on sign-out, on expiry, and when an administrator removed somebody. Restoring them did not
bring it back, and the person moved to the bottom of the list as somebody who had never signed in.
The moment of each sign-in is now recorded on the person, so the answer survives all three, and a
removed person's row shows when they were last here instead of leaving it out. Existing deployments
are backfilled from whatever sessions they still hold.

### A message can carry files

Pick them, drag them onto the composer or paste them in: up to eight files on one message, images up
to 8 MiB and text files up to 1 MiB, in the four image formats a model reads (PNG, JPEG, GIF, WebP)
and four text ones (plain text, Markdown, CSV and JSON). A file is uploaded as it is staged rather
than when the message is sent, so the send is immediate and a send that fails keeps what was
attached to it, instead of asking somebody to find eight files again. The bytes live in the
deployment's own database and are served back from the app's own origin, which is also why the type
is decided by reading the file rather than by believing what the browser called it: something that
claims to be text and is not UTF-8 is refused rather than stored and served as accepted text on the
client's word.

What reaches the model is bounded separately from what may be uploaded, because the two limits pay
for different things. An image goes whole. A text file is read up to 120,000 characters, roughly
30,000 tokens, which is one attachment's share of a window that also holds the conversation and up
to seven other files, and the part sent says where it was cut so the model is not left answering
about a file it read only part of. A megabyte of text is therefore stored whole and read as its
first eighth or so, and the person who attached it is not yet told that.

### Unsent attachments have to be swept, or somebody who stages 32 can attach nothing again

A file is stored when it is picked, not when it is sent, so every abandoned draft leaves bytes
behind and nothing in the image reclaims them. The Helm chart runs the sweep hourly and deletes
unsent files older than a day. Any other deployment has to run it:
`bun scripts/cull-staged-attachments.ts` from `/app/server`, one pass then exit, with the retention
window as its one optional argument. Unlike the routines sweep beside it, it needs only
`DATABASE_URL`, so an external cron can run it with one variable set.

This is not only about growth. A person may hold 32 unsent files across all their channels, which is
what bounds a client that ignores the eight-per-message cap, and the refusal on the 33rd tells them
anything still unsent is cleared within a day. That sentence is a promise made on the sweep's
behalf: where nothing runs it, the files are never cleared and anybody who reaches 32 can attach
nothing, in any channel, from then on. At 8 MiB a file, 32 staged files per person is the 256 MiB
to size storage against.

### Fresh desktop installs pin the latest published deployment

The desktop app resolves GitHub's latest published release on first setup and downloads that exact
tag's source and image manifest. It records the version after both downloads finish and reuses it
on subsequent starts, so new installs no longer stay tied to the app's old v0.0.8 default.

### The Bot computer refuses a malformed scroll or live input before the browser sees it

A non-finite wheel delta travelled into Playwright and came back as a 502 that read as a broken
computer, and any JSON object on the live-screen socket fell through to `Input.insertText` or
forwarded wrong-typed coordinates to CDP. Scroll deltas must be finite numbers now, and live
input must match its mouse, wheel, key, or text shape; anything else is a 400 naming the field.

### A non-string plugin grant or tool call is refused before it reaches the store

`POST /api/plugins/grants` and `POST /api/plugins/call` checked presence, not shape, so a JSON
number, object, or whitespace string passed and failed inside the store as a 500. Refs and Bot
ids must be non-empty strings now, and anything else is a 400 naming what is required.

### A fractional or infinite snapshot id is refused as malformed, not stale

A `snapshotId` of `1.5` or `Infinity` passed the acting routes and never matched the stored
integer, so the answer was a 409 stale snapshot and the caller retried a request that was
malformed. Non-integer ids are refused with a 400 naming the ref and its snapshot before any
decision or audit row.

### A `DATABASE_URL` with a port of zero is refused at start-up

`postgres://…:0/…` parsed and booted, and every query then failed against a port nothing listens
on. Ports outside 1-65535 are refused with a sentence naming `DATABASE_URL` before a socket is
ever opened.

### Setup installs the container engine, instead of telling somebody to go and get one

Setup ended at "Install Podman Desktop or Docker Desktop first" on any machine that had neither,
which is every machine this app is for: the step existed with nothing behind it, so the whole install
stopped at a download page. It installs one now, and a Compose with it, because Podman ships no
Compose implementation and a machine with a freshly installed Podman still cannot raise the stack.
Both are pinned to the digest of the release they were tested against and refused if it does not
match, because these are files this app then executes. Only what is missing is added: an engine
somebody already has is theirs, and a Compose that already answers is left alone. Windows installs
unattended; macOS and Linux each raise the platform's own authorization prompt, which is not
something to route around. The two plan sign-ins set the engine up as well, since they run in a
container themselves and previously named an obstacle with no way past it. Every engine command names
a resolved path rather than trusting the PATH this process was started with, so an engine installed a
minute ago can be used by the run that installed it.

### Setup ends with a question the Bot has to answer

Every step before the last one proves that something started, which is not the same as proving the
answers work. A refused key, a lapsed plan or a model the account cannot use each give a stack that
comes up clean and a Bot that cannot answer, and handing over at that point means somebody finds out
later, inside the product, with no idea which of their answers caused it. Setup now ends on a
question with one checkable answer and waits for it. A run that produces no text is a failure here
rather than an empty answer, because the framework catches its own 401 and logs it, leaving the whole
of a refusal in the container's log and nowhere else. The sentence on screen is OpenBot's own and
names the choice to change, with the harness's log behind a disclosure for the developer half.

### A subscription picks the Bot that can spend it

A plan is not a key, and only one Bot speaks each vendor's subscription. Signing in to a Claude plan
and keeping the default Bot gave a stack that came up clean and a Bot whose log read "Missing
credentials. Please pass an `api_key`", after two screens the person had answered correctly and with
no way to know which answer to change. A plan now re-points the Bot, and the model screen says which
Bot that will be while there is still a screen to say it on. A signed-in ChatGPT plan gets the Codex
model, because a plan token is a bearer for one address that langchain-openai pins on purpose and
cannot be reached by pointing `OPENAI_BASE_URL` at it. The vendor's own token store is kept beside
the `.env` as an owner-only file and mounted into the harness, so the renewals the provider makes
outlast the container: the access token on its own expires within the hour and nothing can renew it,
which would give a Bot that works in the morning and fails after lunch. The window also has an Edit
menu now, so the shortcut works on the screen whose own instruction is "paste the code it shows you";
macOS routes the clipboard through the menu bar, and a window without one has no Paste.

### Signing in to CopilotKit from the window works

The sign-in that creates a key for somebody had never been run end to end, and it failed four times
in a row, each time silently or with a message that named nothing. The session is called `cliToken`,
not `token`, so the first exchange failed with "error decoding response body" and no way to tell
which field or which endpoint; a failure carries the response now, masked, because the one that
diagnosed this also carried a live session token. Project ids are numbers, and requiring a string
dropped every project, so the screen told somebody with ten of them that the account had none: an
empty list and an unreadable one are told apart now, because one of them is a lie a person cannot
argue with. The keys endpoint declares `project_id` as a number with no coercion, so the string "7"
came back as a validation error on the last step of the flow. And the project tiles drew as blank
white rectangles, because the tile rule overrode the background to white and not the colour, asking
somebody to choose between six empty boxes. The sign-in address is kept on screen the way the plan
sign-ins keep theirs, for the machine whose browser is not the one in front of the person.

### An endpoint that needs no key can be connected

The compatible row names Ollama and vLLM in its own summary and then refused to continue without an
API key. Neither has one, so the two examples the screen offers by name were the two it would not
accept, and the way out was to invent a key and hope the endpoint ignored it. An address and a model
name are what that row needs. Both bundled Bots refused to start without `OPENAI_API_KEY` as well, so
fixing the screen alone would have given two dead containers complaining about a key that person's
server does not have: a base URL is a model and its key belongs to it, so a key is now required only
when nothing else names the endpoint, and plain OpenAI still refuses without one. Because a
deployment pulls the image the release pinned, and an image published before the Bots learned this
still refuses, a placeholder string is sent to an endpoint that reads no key. Ollama, vLLM, LM Studio
and llama.cpp all ignore the value. It is written in plain sight rather than put in the machine's
credential store, because it is not a credential, and a key somebody actually typed is used
unchanged. The model name reaches the bundled Bot too, which reads `AGENT_BOT_MODEL` and had been
left on a pin chosen for OpenAI's own catalogue.

### A model name no longer outlives the answer that chose it

The compatible row is the only one that names a model, and switching away from it kept the name.
Answering with an OpenAI key after trying a local endpoint left `BOT_MODEL=local-model`, so the Bot
asked OpenAI for a model only that person's own server has, and the last screen said "That account
cannot use the model that was chosen" about a model this run never chose. The name is removed rather
than emptied, so the compose default applies, and taken out of the file as well, because the writer
keeps the lines it did not write and that is what let it survive.

### Credentials go to the machine's own credential store, not the `.env`

The `.env` is a settings file, and a settings file is something somebody opens, reads out to support
or pastes into a chat. A model key, a plan token and the tokens these services prove themselves to
each other with are not settings. They go to the login Keychain on macOS, to DPAPI on Windows
encrypted to the signed-in user, and on Linux to an owner-only file, which is said out loud rather
than dressed up: no desktop Linux install can be assumed to be running a Secret Service daemon, and
refusing to save a credential because gnome-keyring is missing would fail more people than it
protects. The value never goes on a command line on any of them, since ps is readable by every
process the person runs. macOS goes through the Keychain itself rather than the `security` command,
whose password prompt truncates at 128 bytes with no error and an exit status of zero: an OpenAI
project key is 164 characters, so every one of them was stored cut short and read back cut short on
the next run, while the run that saved it worked fine. From the store the credentials reach the
containers and the host processes as environment, which compose resolves before it reads the `.env`,
so a secret arrives at exactly the services that declare it and is written down nowhere. What an
earlier version already wrote in plaintext is moved and then purged, or the change would have bought
nothing for anybody who already had OpenBot.

### The credential store is asked once per run, not once per screen

Four Keychain dialogs every time the setup screen mounted, each needing a click before the window
would go on, and four more for navigating between setup and OpenBot. macOS authorizes every
individual read of a stored password unless the application is signed with an identity the item's ACL
already trusts; a development build is re-signed on every compile, so its ACL never matches, and the
wizard reads four secrets to arrive filled in. The store is asked once per name per process now and
the answer is held in memory, absence included, or a machine with nothing stored is asked on every
mount for something that was never there. Writes go through the same memory and forgetting clears it,
so the two cannot disagree. This does not remove the prompts on a first run, and nothing in this
process can: that decision belongs to the operating system and to the signature.

### Stop stops the Bot that was picked, and the next Start no longer refuses because of it

Compose only acts on a profiled service when the profile is named, so Stop left the one container the
person actually chose running on their laptop after they had stopped the app, still holding its port.
The next Start then refused, saying something was already listening on 4206, about a container
OpenBot itself had started, which the person never saw and could not find, and there was no way
forward from that screen. A port this deployment already publishes is not a stranger on the port, so
the check reclaims our own and keeps its teeth for somebody else's.

### Stop stops the host processes on Windows

Measured on Windows Server 2022: Stop took the containers down, reported success, and left the server
answering on 3001, the routines worker up, and both halves of the app answering on 3010. Only the
containers had gone. The handles a window holds cover what that window started and die with it, so a
window stopping a stack an earlier one started held nothing, and the Windows arm returned success
with a comment saying the host processes end with the session. They do not. The pids are written
beside the logs when the processes start and Stop reads them, ending each process together with its
children, since `bun run serve` starts the real server as a grandchild. A sweep of the ports this
deployment publishes stays as a second pass for a stack whose pid file is gone. Separately, a
byte-order mark in front of `package.json`, which `Set-Content -Encoding UTF8` writes freely, made
the manifest unreadable and was reported as "the deployment is older than this version of OpenBot",
sending somebody looking for a newer installer over three bytes.

### The installed app is served without a development server

"Show OpenBot" did nothing on a machine where the stack was up. The window said OpenBot was running,
the button was there, and clicking it had no effect at all. The app host process was dead: it was
started through `vite preview` under `bun --bun`, and Vite's proxy calls `socket.destroySoon()` when
an upstream response ends, which bun's sockets do not implement, so the process died with a TypeError
on the first call the app made. It served its page, exited, and nothing listened on 3010 from then
on, while the shell went on reporting a stack that was up, because the containers were. The app is
served by a small server of its own now: a directory and one forwarded prefix, which is all an
install needs, with no Node and no Vite at runtime. The websocket upgrade the live screen needs is
forwarded rather than answered with HTML, a miss under `/assets` is a 404 rather than the page, and
paths are confined to the directory, since the deployment's `.env` sits two levels above it. The
button also shows what it was told: the call behind it already answered "OpenBot is not answering on
port 3010 yet, so there is nothing to show", and the click handler threw that sentence away, which is
why a dead process looked like a dead button.

### A conversation whose history this deployment cannot reach says so

Clicking a conversation in the rail drew the coworker's name and then nothing at all. The rail comes
from OpenBot's own database, so a channel is listed whatever the history store says, while the
messages live in the Intelligence project: pointing a deployment at a different project leaves the
platform answering `THREAD_NOT_FOUND`. That 404 is deliberately read as "no history" and has to stay
that way, because a thread id is minted before the thread exists, so a brand-new conversation 404s as
its normal opening move, and widening it would tell somebody their conversation was gone and invite
them to start it over. The two are told apart by `lastMessageAt`, which is set only once something
has been said: a conversation with none is genuinely new and silence is correct, while one that has
been spoken in and comes back empty has a history this deployment cannot reach. That one now says so,
in the notice slot beside the existing explanations for a deleted coworker and for turns that could
not be parsed.

### `bun run dev` no longer starts a routines worker that cannot start

`bun run dev` fanned out across every workspace, and one of them is the routines worker. That worker
is handed `DATABASE_URL`, `SERVER_INTERNAL_URL` and `WORKER_SHARED_SECRET` by `scripts/start.sh` and
by nothing else, so the copy this command started read none of them and threw at boot on every run,
printing a stack trace in between the app's output and the server's. It has never started
successfully. The command now starts the app and the server, which is what `README.md` and
`docs/development.md` already say it does. Routines are unaffected: `scripts/start.sh` starts the
worker exactly as before, and on Kubernetes the CronJob does.

### Double-clicking works while a person is driving a Bot's browser

A double click was sent to the Bot's browser as two separate first clicks, because every press said
it was the first one. Chrome fires `dblclick` on the page only when the second press says it is the
second, so the page never saw one at all and `event.detail` was always 1. Opening a row in a table,
expanding a node in a tree and double-clicking a word to select it were all things a person holding
the wheel simply could not do, with nothing on screen to say why — the clicks landed, they just each
counted as the first. The count the person's own browser worked out is now the one that is sent, so a
double click is a double click and a single one is unchanged.

### Pressing Enter works while a person is driving a Bot's browser

Taking the wheel of a Bot's browser is mostly for the sign-in it cannot do itself, and Enter is how a
sign-in ends. Every keystroke reached the page, and Enter reached it as a key press that produces no
character — which Chrome delivers to the page's own listeners and then does nothing further with. So
the form did not submit, a new line in a text box did not start, and a button somebody had tabbed to
was not pressed, while anything on the page listening for the key saw it arrive. There was nothing on
screen to explain it: the keystroke was not refused, it simply had no effect, and the way out was to
click the submit button instead. Enter now carries the carriage return a keyboard sends, which is
what makes Chrome carry out what the key means. Measured against Chromium 151: every other editing
key — Backspace, Delete, Tab, Home, End and the arrows — already did what it meant and is unchanged,
and a single-line field still holds exactly what was typed into it.

### A half-ticked box is no longer described to a Bot as ticked

The snapshot a Bot reads before it acts on a page says whether each box is ticked, and Playwright
writes that as `[checked]` for one that is and `[checked=mixed]` for one that is neither — which is
what the "select all" above a partly-ticked list carries. The parser treated any value other than
the string `false` as ticked, and `mixed` is one, so a half-ticked box was reported as done. A Bot
asked to select everything read it as already selected, clicked nothing, and said the rows were
chosen when most of them were not. `mixed` is now reported as not ticked, which is both the true
half of a yes-or-no answer and the one that gets the right action: clicking a half-ticked box ticks
it. An ordinary tick and an ordinary empty box are unchanged.

### A Bot cannot end its turn by asking a person nothing

`ask_person` is how a Bot stops and puts something to a person instead of guessing, and a call with
no question in it was already meant to come back as a sentence telling it to say what it needs. That
only happened when the field was missing altogether. A question that was present and empty was
carried out: the Bot was told its question had been put to somebody, its turn ended there, and the
trail took an escalation row with nothing in its question — the row an administrator counts these by,
saying a person was asked something that was never said. On a deployment whose escalation route is a
duty desk rather than the person already in the conversation, it is a page to somebody with no
question on it. A blank question is now refused with the sentence that was already written for it,
and a question typed with room around it is recorded as the question rather than as the spacing.

### A routine scheduled for Sunday says Sundays, whichever number it was written with

Crontab has always let Sunday be either 0 or 7, the scheduler here takes both, and a routine written
with 7 is stored and fires on Sunday like any other. Only the 0 spelling was recognised by the
sentence the Routines page draws and the Bot reads back, so a working weekend routine appeared on
that page as `0 9 * * 7` while its neighbour said "Sundays at 09:00" — the same schedule, described
two ways, with the raw one looking like something had gone wrong. Both spellings now read as Sunday,
and a list that names the day under both of its numbers says it once.

### A tenant package's theme may carry a comment

A package's `theme.css` is checked at start-up against what it is allowed to define: the `:root` and
`.dark` blocks, the approved variables, no imports and no URLs. A CSS comment defines none of those
and was being read as though it did. One above the blocks — the line a hand-written stylesheet opens
with, saying whose brand it is and where the colours came from — was left over once the blocks were
set aside and refused as a second selector; one inside a block was split on the semicolons around it
and refused as a variable name, with the comment quoted back as the name it was not. Because the
package is read while the deployment starts, that was not a warning: the deployment did not come up,
over a comment, saying nothing about comments. Comments are now taken out before the file is read as
definitions, which also closes a comment wedged into the middle of `url(` as a way past the rule
above it.

### Test connection stops reading once it has seen the agent answer

The button that checks an agent before it is registered sends it a real run and reads what comes
back, needing only the opening of the stream to tell an AG-UI agent from a web server that happens to
be reachable. It was reading the whole reply first and applying that limit afterwards, so the check
took as long as the agent's run did. An agent that streams for more than fifteen seconds — a Bot
working through a document, a model answering slowly — was given up on mid-answer and reported as
`The agent started answering and the connection broke`, about a connection that had not broken and an
agent that had answered correctly in its first two events. It now reads the opening it needs, closes
the connection, and answers in the time the agent took to start rather than the time it took to
finish.

### A key pasted with a line break in it is now refused, instead of reported as an unreachable agent

The box that holds an agent's key takes whatever is pasted into it, and what comes off a clipboard is
not always what was on the screen: a long key copied out of a wrapped terminal line brings the wrap
with it, and a hyphen copied out of a document has often been turned into an en dash on the way.
Neither can be sent as an HTTP header — the runtime refuses the value outright — and neither was
being looked at. On Test connection that refusal surfaced as "This server could not reach that
address", with a suggestion about tunnels and firewalls, about an agent that was running perfectly
well and had never been dialled. Stored on the Bot it was quieter and worse: the form said saved, and
every turn that Bot took afterwards failed on a value nothing on screen said anything about. Both
places now check the value before accepting it and say which kind of character is in the way. The
character is named; the key never is.

### A deployment directory pasted with a stray space goes where it says

The desktop setup screen asks where OpenBot should live, enables Start once that box is not blank
after trimming, and then sent the untrimmed string — the same trap the API URL, the gateway URL, the
intelligence key and the model key were taken out of, and this is the one of the five that is a
place on disk rather than a credential. A path copied with the space the selection picked up, or
with the newline a copied line carries, was used whole. A trailing space made a second directory
beside the one everything else means: the tray's Stop and the next launch both ask for the default
path, which has no space in it, so a person was left with a deployment nothing on screen could
reach. A leading space was worse, because a path starting with a space does not start with a
separator — it stopped being absolute, and the deployment was laid out relative to wherever the
window happened to be running from. The path is trimmed at both ends now. Spaces inside it are part
of a directory's name and are left alone.

### The desktop app notices a busy port whichever loopback holds it

The shell refuses to start when something already holds port 3001 or 3010, because otherwise the
readiness check that follows is answered by a server it never started: everything reads green and
none of it is yours. That readiness check asks both loopback addresses on purpose, since a process
binds whichever one its runtime resolved `localhost` to — Node picks `::1`, Bun picks `127.0.0.1` —
so an answer at either counts. The refusal in front of it asked only `127.0.0.1`, which meant a port
held on `::1` alone was reported free and the start went ahead into it. Both addresses are asked
now, so the two agree on what "in use" means and the person is told which port is taken and what
OpenBot wanted it for.

### A request for a secret no longer follows a Bot into tomorrow's conversations

An unanswered ask to take the wheel stops being shown after ten minutes, because control belongs to a
Bot's computer rather than to a conversation. The other prompt on that computer, the masked box a Bot
opens when it needs one value it must not be told, was never given the same treatment: it sat there
indefinitely, so every later conversation with that Bot was flagged as needing a person and showed a
request for a password, captioned with a label written for whoever asked half a day earlier. It now
expires on the same ten-minute window, and stops being answerable at the moment it stops being shown,
so a value typed into a box left open in an old tab is refused rather than sent to a page whose run
has ended. A request inside the window is unchanged, and a person actually holding the wheel is still
never timed out.

### `COMPUTER_BROWSER_IDLE_MS=0` now keeps browsers resident, as it says it does

Zero is the documented way to switch off the sweep that closes a Bot's browser after it has sat
untouched, and the sweep itself reads a timeout of zero as being switched off. The value never got
that far. It was read the way the cap on running browsers is, where zero would close every browser
the moment it opened and so has to be refused, and an operator who typed zero got the thirty-minute
default handed back instead. Their browsers went on being closed, which is a Bot signed out of a site
that only issues session cookies and a cold Chromium on its next turn. Zero is now kept for this one
setting. A blank variable, which is what an unset variable declared in a compose file arrives as, is
still not zero: it means "not set" and takes the default, as do a negative and anything that is not a
number.

### A flag or a family emoji in a channel preview is no longer cut in half

The one line a roster draws is cut to a cap, and the cut walked code points -- right for a plain
emoji, wrong for every emoji built out of more than one. A flag is two regional indicators, a family
is three people joined by zero-width joiners, a thumbs-up with a skin tone is the thumb plus a
modifier, and a keycap is a digit plus a variation selector plus an enclosing mark. Landing the cut
inside any of those left a boxed letter, a dangling joiner or a bare digit in the sidebar, in the
generated channel title, and in the excerpt the titler is shown. The cut is now taken between
grapheme clusters, so what a person sees as one character is kept or dropped whole. Plain text is
cut in exactly the same place as before.

### A scroll with an unusable `deltaY` is refused, rather than scrolling some other distance

`POST /computers/:botId/scroll` and `POST /computers/:botId/human/scroll` accepted any JSON number
as `deltaY`, and `1e999` is a JSON number: it parses to `Infinity`, passes the `typeof` check, and is
turned back into `null` by the hop to the Bot's computer, which reads the field as absent and scrolls
its own default distance. The caller was answered 200 for a scroll it had not asked for. A `deltaY`
that is not a finite number now answers 400 and the page is not touched, the way the timeout on
`exec` and the coordinates behind a person's click already did.

### An MCP call carrying `x-api-key` is stopped the same as one carrying `api-key`

The check that keeps credentials out of MCP tool arguments compared each argument name against a
list, and `api-key` was on it while `x-api-key` was not -- so the spelling that is more obviously a
credential header was the one that went out. `x-` is the conventional prefix for a non-standard
header and says nothing about the value, so it is now dropped before the comparison. The same pass
adds the spellings of names already on the list that were missing from it: `passwd` and `pwd` for
`password`, `auth_token` and `bearer_token` and `session_token` for `token`, `api_secret` and
`secret_key` and `signing_key` for `secret`, and `ssh_key` for `private_key`. Nothing new counts as
a credential: an argument named `x_axis`, `token_count`, `max_tokens` or `secretary` is passed as
before.

### One command to stop what `start.sh` started

Stopping the local stack meant four commands read off the end of a successful start, and the one
easiest to miss was the one that mattered: a Bot's computer is made by the supervisor rather than by
compose, so `docker compose down` left a Chromium running per Bot. `bash scripts/stop.sh` stops the
app, the routine worker, the API server, the compose services and every Bot computer, in that order,
and is safe to rerun. It kills a port holder only once that process has identified itself as
OpenBot, so an unrelated process on 3010 is named and left alone rather than killed. Nothing is
deleted: the database, the Bots' files and their browser profiles are volumes. `--keep-computers`
leaves the browsers signed in.

### The trail says when an identity provider was added, not only when one was taken away

Whoever holds an identity provider decides who can sign in at all, and the audit trail recorded only
half of that. Removing one through the administration screen was written down; registering one was
not, because registration is the sign-in library's own endpoint and nothing this deployment owns ran
on the way through. The event type for it had been declared and never written. Removing a provider
through the library's endpoint rather than the screen was unrecorded for the same reason. Both are
now written where the deployment already stands in front of those routes to check that the person
asking is an administrator, so a provider appearing or disappearing names itself and whoever did it.

### Two workers on one machine can no longer fire the same routine twice

Every process that claims work from the shared queue named itself after its hostname, and the queue
tells two claimants apart by that name alone. Two processes on one machine therefore had the same
name, so the lease meant nothing between them: one whose lease had lapsed was still told the item was
its own, and both went on to dispatch it. A routine fired that way opens two runs and sends the same
scheduled message twice. Nothing stops two workers running on one machine — the worker binds no port,
and `scripts/start.sh` looks for a process it does not start the way `bun run dev` does. The name now
always carries a random suffix, so a second process is a different claimant. It also keeps the
hostname, so a stuck claim still traces back to the machine holding it, and a blank `HOSTNAME` is no
longer read as a name — which had made every replica in a deployment share one.

### The desktop app writes its `.env` readable only by its owner

The desktop `.env` holds `KEY_ENCRYPTION_KEY` and every minted token, and those are now long-lived:
the first start writes them and every later start reads them back. It was created at the default
umask (`0644`), so on a shared macOS or Linux machine another local user could read the vault key off
disk. The file is now narrowed to `0600` after it is written. Windows has no equivalent mode and its
single-user desktop profile is already the boundary, so the change is Unix-only.

### The desktop app stops adding a banner to `.env` on every start

`env::write` keeps the lines it did not write, and its own header comment is one of them, so each
start preserved the previous banner and appended another. A deployment started fifty times had fifty
copies of "Written by OpenBot Desktop" and fifty blank lines stacked above its settings. The banner
is now recognised and replaced rather than kept, and comments somebody else put in the file are left
alone exactly as before.

### Starting the desktop app again keeps the secrets the first start generated

The shell generated a fresh set of secrets every time Start was pressed, including the
`KEY_ENCRYPTION_KEY` that encrypts the credential vault. The database survives a stop, so the second
session of an installed OpenBot met a vault it could no longer read: every stored credential failed
to decrypt, with an error that named an operation rather than a cause. It also handed the server a
`COMPUTER_TOKEN` that no computer created before the restart holds. The secrets an existing `.env`
already carries are now kept, and only generated when there is nothing usable to keep — a value
published in this repository does not count, and neither does a `KEY_ENCRYPTION_KEY` the server would
refuse to start on.

### The desktop app refuses a deployment download that writes outside its own directory

The shell fetches the release tarball and lays it out under the directory it manages. The check that
kept an entry inside that directory compared paths lexically -- `root.join(path).starts_with(root)`
-- and `Path::starts_with` matches components without resolving `..`, so `app/../../elsewhere`
started with the root and still landed outside it. An entry has to begin with a directory a
deployment wants, which `app` does, so the file filter did not stop it either. Every component of a
path inside the tree is now required to be an ordinary name, and the traversal is refused by name.

### A credential pasted with a stray space into the desktop setup screen now works

The setup screen enables its button on `value.trim() !== ""` and then sends the untrimmed string, so
a key copied from a provider's dashboard with the space the selection picked up arrived intact. The
model key was trimmed on the way into `.env`; the API URL, the gateway URL and the intelligence key
entered on the same screen were not, so Compose passed the space through, the provider rejected the
credential, and the failure the person saw named neither the space nor the field. All four are now
trimmed the same way.

### Example LangGraph and Mastra Bots no longer bind an ephemeral port on empty `PORT=`

An empty `PORT=` in compose or `.env` used to become `NaN` for those two example processes, so they listened on a random port while docs still named 4300/4400. They now use the same `listenPort` helper as `agent-bot`: empty is the documented default, and a prefix typo refuses to start.

### An empty app port is the default, not a random one

`APP_PORT=` and `SERVER_PORT=` in a compose file or leftover `.env` used to become `NaN` for the Vite
dev and preview servers, so the UI bound an ephemeral port while the proxy target was `http://localhost:`.
Both empty values now mean the documented defaults (3010 and 3001), and a non-numeric value refuses to start.

### The trail says what started a run, not only whose authority it had

A routine runs as the person who set it up, and a Bot handing work to another Bot runs as the person
who began the conversation. Both are correct, that is whose grants and whose connections are being
used, and both meant an action taken while somebody slept was written into the audit trail as though
they had taken it themselves. Telling the two apart meant correlating timestamps against
`routine_runs` by hand, and there was nothing at all to correlate a hop against.

Every audit row now also names what caused it: a person, a routine, another Bot handing work on, or
the deployment itself. It travels inside the signed run assertion, so a tool call, a hop, a Bot
stopping to ask its person and a stalled stream all say it, and a Bot cannot relabel its own run.
The Audit screen has a **Started by** column and a **Nobody watching** view that answers the
question directly. An unattended run is the one nobody is there to notice going
wrong, which is the reason it is worth being able to find.

The fourth of those exists so the column never overclaims. Two rows have no person behind them at
all: the boundary and isolation rows written at start-up, and the refusal written when a caller
cannot be identified at all. Those say the deployment, not a person, and they stay out of
**Nobody watching**, which asks what ran on somebody's authority rather than what the deployment did
by itself.

Nothing about existing rows changes. Every row already written, and every row a person's own click
writes from now on, reads as a person, because that is what it was.

### The live screen and live channel updates work again, and one request can no longer end the app

The app opened its two WebSockets against its own address, so they travelled through Vite's `/api`
proxy. Vite is run through bun, and under bun that proxy does not carry a WebSocket: neither the
Bot's screen nor live channel updates ever connected, and the browser retried in a loop. Worse, an
upgrade the server answered with an ordinary HTTP response — a 503 when a Bot's computer is not
running, which is exactly when somebody opens the screen — crashed the process that served the app,
taking the server and the worker with it in development. Where Vite serves the app — the dev server
and the desktop's `vite preview` — both sockets now address the server directly, so nothing upgrades
through the proxy and the proxy no longer offers to carry one. In production the server serves the
app itself and answers the upgrade on the same origin, so the sockets stay on the browser's own
host, which is what an ingress terminating TLS on 443 requires and a fixed server port would break.

## OpenBot 0.0.8
### A desktop shell that installs OpenBot and then becomes it

One window, on macOS, Windows and Linux. From a machine with nothing on it, one click fetches the
deployment for this release, pins every image to the digest the release published, generates the
secrets that are OpenBot's to generate, raises the containers, applies the migrations, installs the
dependencies, starts the host processes, waits until both the API and the app answer, and then shows
OpenBot in the same window. It is not a launcher for a browser tab. Stop takes the stack down, closing
the window hides it to the tray, a second launch hands over the window that already exists, and
quitting stops what starting started. Windows is told what it needs before anything else runs: WSL,
its kernel, virtualisation and administrator rights are each named with the command that fixes them,
because none of them is something OpenBot can fix on somebody's behalf.

### A title or name that is only spaces is refused rather than stored

Sandboxed components, skills, custom servers and the component catalogue each accepted a title, slug
or id made entirely of whitespace, and stored it. What came back was a row nobody could identify and,
in the catalogue's case, entries that were empty strings. Each endpoint now refuses those the way it
refuses a missing field, and the catalogue drops empty entries instead of keeping them.

### A malformed socket message no longer takes the screen down

The live screen and the channel socket both assumed every payload they received was an object of the
shape they expected. Anything else threw inside the handler, which in a browser means the surface
stops updating with nothing on screen to say why. Both check the shape first and ignore what does not
match.

### The worker refuses a bad server URL when it starts, not when it first needs it

`SERVER_INTERNAL_URL` was read as a string and used as one. A value that was not an http or https URL
failed later, inside whichever call happened first, with an error about that call rather than about
the setting. The worker validates its environment up front now and normalises the URL, so a typo stops
it immediately and says which variable is wrong.

### A sandbox template that is not valid JSON is reported as a sandbox error

A malformed template surfaced as a raw parse error from whatever tried to read it. It is a
`SandboxError` now, which is what the caller already handles and what the surface already knows how to
show.

### A duration written in capitals is understood

`durationMs` accepted `30s` and refused `30S`. Units are read case-insensitively now.

### The supervisor refuses a `HostPort` that is not a port

The value went through a bare `parseInt`, so `80abc` became 80 and an out-of-range number was used as
given. Digits and range are checked, and anything else refuses to start rather than binding somewhere
nobody asked for.

### The audit endpoint refuses a bad date or limit instead of guessing

An unparseable `from` or `to`, or a `limit` that was not a whole number, was coerced and the query ran
against whatever came out. All three are parsed strictly now and a bad one answers 400.

### Chat content that does not parse is dropped rather than thrown

One malformed entry in a user message threw and took the whole message with it. The malformed part is
dropped and the rest is delivered.

### The example package is read by a path the host accepts

It was addressed by a URL pathname, which is not a path on Windows. It is read by a real path now.

### The app can be served from a built bundle, and listens on both loopbacks

The app's only start script was `dev`, which runs a Vite dev server. That meant `NODE_ENV=development`
on a freshly installed product: the SDK drew its developer inspector over the top, with hot reloading
and source maps behind it. There is a `serve` script now that builds once and serves the build. Both
it and `dev` hand Vite to Bun directly, because `node_modules/.bin/vite` begins `#!/usr/bin/env node`
and a machine with Bun and no Node exits 127 without saying why. Vite is also told to listen on `::`,
since Node resolves `localhost` to `::1` and Bun to `127.0.0.1`, so binding one of them left whoever
asked for the other looking at nothing.

### A person's Stop is recorded as a stop, not as a failed action

Pressing Stop mid-action aborts the request, and the gateway wrote that outcome beside the decision
row as a failure — the same `computer.action_failed` type it writes when a computer is unreachable or
times out. The row's message already said the action was stopped, but anything counting failures by
type, the natural way to watch for outages, read every Stop as one. A stop now writes its own type,
`computer.action_stopped`: the action did not happen and nothing broke. The audit page already groups
it with the other did-not-happen outcomes, and a policy dry-run skips it the way it skips a failure,
since both sit beside a decision row that is already scored.

### A malformed `DATABASE_URL` is refused without printing the password

`DATABASE_URL` is taken apart before it reaches Bun, and the string most likely to fail that parse is
one with a stray character in the password. The refusal for an unparseable value quoted the whole
string back to name the fault, which wrote the database password into the log line that reported it.
It now names the variable and the shape it expects, the way the other refusals beside it already do,
and never echoes the value.

### Wiping a computer is recorded even if clearing its stored state fails

Resetting a computer destroys the profile first and wrote the audit row last, after two Postgres
deletes. A connection reset, a failover or a statement timeout in either delete threw before the row
was written, so the most destructive button in the product could leave a wiped computer -- every
login gone, no undo -- with nothing on the trail to say who wiped it or when. The row is now written
as soon as the profile is gone, which is the point after which nothing can be put back. A failure in
either delete is still reported to the caller.

### Pressing Stop is recorded as a stop, not as a computer that is not running

The computer transport answered a Stop correctly only when it arrived before the request left. The
caller's signal is handed to `fetch` precisely so a Stop can also land mid-action, and a fetch
aborted that way rejects with an `AbortError`, which fell through to the message for a computer that
cannot be reached. The person was told their own click had failed because the assistant's computer
was not running, and the gateway wrote that sentence into the action's audit row as its failure --
so a deliberate stop read back as an outage. A genuinely unreachable computer and a timeout still
say what they said.

### A component the server refused is no longer drawn anyway

A sandboxed component asks the server at call time whether the Bot may still use it, and a refusal
is recorded so the drawing can be replaced with a card saying so. The renderer looked that refusal
up under `props.toolCall.id`, which is the shape a tool HANDLER is given; a renderer's props carry
the id flat, as `toolCallId`. The lookup key was therefore always undefined, the refusal was never
found, and the component rendered as though it had been allowed -- so revoking a component from a
Bot did not take effect on screen until the five-second grant poll caught up, and a failed decision
request showed nothing at all.

### A component whose name has a stray space is the same component

The catalogue announcement asked whether each component's `name`, `title`, `kind` and `description`
were more than whitespace, and then published the untrimmed strings. A `name` is a component's
identity -- it is what `syncCatalogue` compares against what is already published, what `decide` and
`listForAgent` look up, and what a grant names -- so a build shipping `" weatherPanel "` added a
second catalogue row beside `weatherPanel`: published, ungranted by anybody, and impossible to hold
a Bot back from under the name people use. The four fields are now stored as the strings the guard
approved.

### A password with a `%` in it says so, instead of failing as `URI error`

`DATABASE_URL` is taken apart before it reaches Bun, and each part is percent-decoded. A part
holding a `%` that starts no escape -- `postgres://openbot:100%pure@host:5432/openbot`, which a
generated password produces often enough -- is a string `new URL` accepts and `decodeURIComponent`
rejects, so the server stopped with `URIError: URI error` and named neither the variable nor the
part. It now refuses with the same kind of sentence as every other malformed address: which part is
wrong, and that a literal `%` must be written `%25`.

A correctly encoded password is unaffected.

### An empty Bot `PORT` is unset, so NaN never reaches Bun.serve

`PORT=` on `agent-bot` and `agent-langgraph` used to parse as `NaN` (`??` does not treat empty as absent) and `Bun.serve` bound an ephemeral port while compose still published 4200/4201. A prefix typo (`42o0`) started on 42. Empty now means the shipped default; anything that is not a whole port number refuses to start.

### The server connects to Postgres on Windows, and `localhost` is no longer a coin toss

Two separate faults, both of which stop a deployment reaching its own database and neither of which
says so.

The connection address went to Bun as a URL. Bun reads such a URL's path, the database name, as the
path of a unix socket, ignores the host and the port, and fails to open a socket Windows does not
have (oven-sh/bun#27713). The server could not reach Postgres there at all, while `psql` inside the
container and a plain TCP connection from the same machine both worked, which makes it look like a
network fault rather than a parsing one. The address is now passed in parts, and `DATABASE_URL` is
removed from the environment as it is read, because Bun prefers that variable to the parts it was
handed and would otherwise put the address straight back through the same parser. A URL with no host
or no database is now refused by name instead of connecting somewhere nobody chose.

Separately, Compose published its loopback ports on `127.0.0.1` only. `localhost` resolves to `::1`
and `127.0.0.1` in an order the platform decides, and a client handed `::1` first does not fall back
to the other, so the same configuration worked on one machine and failed on the next for a reason
nothing in the error mentions. Every loopback port is now published on both addresses. Both are
loopback, so nothing became reachable from another host.

### A bad `COMPUTER_MEMORY_BYTES` refuses to start the supervisor, instead of capping a computer at 512 bytes

`COMPUTER_MEMORY_BYTES=512m` used to parse as `512` via `parseInt`, which Docker accepts as a memory
cap Chromium cannot live in. Empty `COMPUTER_MEMORY_BYTES=` is still unset (no cap). A value that is
not a whole number of bytes now exits before any computer is created.

### An IPv6 address in `AGENT_ENDPOINT_ALLOWED_HOSTS` now matches however it is written

The endpoint check compares the list against the address as the URL parser spells it, compressed
and lower-case, while the list kept each IPv6 entry as the operator wrote it. `[0:0:0:0:0:0:0:1]:8443`
was therefore a line that silently never matched, the failure the list's other refusals exist to
prevent. Stripping the brackets on both sides also folded two different names into one, so naming
`[fd00::1:8443]`, an address, admitted `[fd00::1]:8443`, another address on a port, and the other way
round. Bracketed entries are now stored in the parser's spelling, with the port kept as written, and
compared with their brackets on; an entry the parser does not read as an address is refused at boot,
naming the entry, as a URL or a wildcard already was. Names and IPv4 entries are unaffected.

### A Bot's own decline is only recorded against a Bot the caller may reach

A Bot reports that it declined a request through the person's session, and the audit row says
`reportedBy: the Bot itself`. The route wrote that row for any agent id in the path, without asking
whether the caller could reach that Bot, so any signed-in person could put a decline, in any words,
against any coworker, one they cannot see included, and an administrator reading the trail would take
it for something the Bot said. The route now asks the store first, as every other route on a Bot
does, and answers not found for a Bot the caller cannot reach, writing nothing.

### The engine socket the supervisor is given can be pointed somewhere else

Compose mounted `/var/run/docker.sock` into the supervisor as a fixed path. That is correct for
Docker, and for Podman on macOS, where `podman machine` symlinks it to the rootless socket inside the
virtual machine. It is wrong for rootless Podman on Linux, where the path is either absent or, with
`podman-docker` installed, a symlink to `/run/podman/podman.sock`, the rootful socket, which is not
the one running. The supervisor held a dead socket and every attempt to give a Bot a computer failed
with a message about not reaching Docker.

The mount source is now `ENGINE_SOCKET`, defaulting to `/var/run/docker.sock`, so nothing changes
unless it is set. On rootless Podman on Linux, set it to `$XDG_RUNTIME_DIR/podman/podman.sock`.

### A Bot's computer is waited for properly on Podman, and the supervisor can reach the engine there

Two things stopped OpenBot running on Podman, which nothing had tried before.

The supervisor could not reach the engine at all: `The supervisor could not reach Docker`. The socket
is there and the mount is right, but Podman's virtual machine runs SELinux and labels the socket in a
way a container is not allowed to read. The supervisor now declares `label=disable`, which is what
that needs and which changes nothing on Docker.

Then every cold start of a computer raced the first request to it. Readiness was read off the image's
`HEALTHCHECK`, and Podman does not report one: its images are OCI-manifest, the OCI image config has
no healthcheck field, and the instruction is dropped both when Podman builds an image and when it
pulls one that has it. With no health to read, the supervisor fell back to accepting a container that
was merely running, and a running container is not a browser that is answering, so the first request
arrived at a port nothing was listening on and came back as a computer that is not running. The
supervisor now states the healthcheck when it creates a computer instead of inheriting it, so
readiness no longer depends on how the image was built. On Docker the behaviour is unchanged.

## OpenBot 0.0.7
### The published service images are zstd rather than gzip

An image pull was already a compressed transfer, so this is not compression where there was none; it
is a better algorithm for the same job. `agent-computer` goes from 962 MB to 886 MB on the wire, and
zstd inflates several times faster, which on 2 GB of Chromium is worth more than the 8%. The saving
comes from recompressing the layers that arrived from somebody else's registry, where nearly all of
the bytes are, so the images no longer share layers with a gzip pull of the same base.

This applies to the five `ghcr.io/copilotkit/openbot-<service>` images and not to
`ghcr.io/copilotkit/openbot`. Reading a zstd layer needs a client that supports it, which Podman and
current containerd do; the single image is pulled by deployments running whatever they have, so it
stays gzip.

### A release publishes every service's image, not just the one

`ghcr.io/copilotkit/openbot` was the only image a release produced, so anything running the Compose
stack built `agent-computer`, the supervisor, both Bots and the migration image from source on
every machine. That needs a toolchain and it needs several minutes, most of them Chromium, and it
is the difference between a deployment and a laptop being able to start at all.

Each of those is now published beside it, at `ghcr.io/copilotkit/openbot-<service>`, carrying both
`linux/amd64` and `linux/arm64` so one reference works on a server and on an arm64 laptop. Every
image gets its own build provenance attestation, and `container-images.json` on the release pins a
digest for all of them rather than for one.

Nothing changes for a checkout: unset, `COMPUTER_IMAGE`, `SUPERVISOR_IMAGE`, `BOT_IMAGE`,
`LANGGRAPH_IMAGE` and `SERVER_IMAGE` name local tags and Compose builds them as before. Point them
at published digests and set `IMAGE_PULL_POLICY=missing` to pull instead. `docs/releasing.md` shows
reading the references out of `container-images.json`; `docs/configuration.md` lists the settings.

CI now builds those five Dockerfiles too. Nothing did before, because they are built by
`docker compose up --build`, which only the smoke journey runs and which cannot run in CI, so a
broken one surfaced during a release after the first image had already been pushed.

### A skill can be written in the conversation instead of retyped into a form

A skill is four fields and an instruction a Bot follows, and the instruction is the one that decides
whether the skill works. The only place to write it was a textarea on `/skills`, which meant having
the conversation, getting a good draft in the transcript, and then copying it out and retyping it.
Mostly nobody bothered, which is how a deployment runs for months with no skills in it.

The example package now ships a `skill-creator` skill, granted to `general-assistant`. A Bot holding
it is offered four tools for listing, reading and saving skills; every other Bot is offered none of
them. It interviews you about the skill you want, looks at what already exists before naming it,
rehearses it against one realistic request, and then saves it.

The save is a card, not something that happens quietly. It draws the command, the title, the declared
tools and the whole instruction, and writes nothing until a button is pressed. A skill appears in
everybody's `/` menu with somebody's name on it, and saving is also how an edit is spelled, so an
unattended save could replace a skill somebody is already using.

The tools run in the browser as the signed-in person, over the same `POST /api/plugins/skills` a
person uses, so who may take a slug is answered the same way and the `configuration.changed` audit
row is written the same way.

### Resetting a computer clears the activity pane

Resetting a Bot's computer deletes the browser profile it worked on, but the activity pane beside the
chat went on listing the commands and file operations that ran there. They sat alongside anything the
Bot did afterwards with nothing to tell the two apart, and only reloading the page cleared them. The
pane now forgets a Bot's history when that Bot's computer is reset. Stopping a browser is unchanged:
the profile survives a stop and is meant to resume, so what it did is still true of the machine.

### A person can set standing instructions that every coworker follows

Settings now has a box for standing instructions: one piece of text per person, saved once and
spliced into every built-in coworker's prompt, in every channel, on every run, including the runs a
routine starts overnight. It is the place for what is true of every task rather than of any one of
them, such as how somebody wants to be written to or what their company is and is not to be called.
A coworker's role still decides what it does; these decide how it does it, and the prompt says so,
so an instruction cannot quietly redefine what a coworker is for.

Instructions belong to the person who wrote them. Nobody, administrators included, can read or set
somebody else's, and they are deleted with the account. A coworker running at a remote AG-UI
endpoint is not sent them, since this deployment does not compose that prompt. Nothing is added to
any prompt until somebody writes something, so a deployment where nobody uses this behaves exactly
as before.

This adds migration `0026_user_instructions`, which creates one table.

### A coworker can be made in the conversation, and it starts able to reach nothing

A coworker without an endpoint runs on its role description, which becomes the standing instruction
handed to a model on every turn in every channel it is in. It is the hardest thing anybody is asked
to write cold, so people write a sentence, get a coworker that answers vaguely, and never go back to
the field that decided everything.

The example package now ships a `bot-creator` skill, granted to `general-assistant`, with tools for
listing, reading and saving coworkers. It asks the follow-up your last answer calls for, reads the
roster to say when something already does the job, and can be told to make one like an existing
coworker but for a different job, then go and read what that coworker actually runs on.

The card shows the name, the job, the skills and the entire role description, scrolled rather than
clamped, because that text runs on somebody's behalf. What is made is granted nothing: it can reach
no connector, no tool and no browser until somebody grants it, and a conversation with it says so.

Like the skill tools above, these run in the browser as the signed-in person over the endpoints a
person uses, so who may create a coworker is answered the same way and `bot.created` carries the
actor.

### A conversation has a name of its own

A channel's name was only the names of the Bots in it, so asking one Bot about six unrelated things
gave six rows reading the same thing, told apart by a preview of whatever was said last, which is
usually the tail of an answer and says nothing about the question. A conversation is now named from
its opening exchange, and the roster's second line holds that name instead of the preview, falling
back to the preview until a name exists. A row is never blank and never worse off than before.

Two things a deployment should know. The opening exchange, up to 600 code points, is sent to whatever
`tenantPackage.model` names, which is the same provider the Bots already use, so it is not new egress
but it is sent as housekeeping rather than because somebody asked for it. And the second line now
says what the conversation is about instead of what was last said.

It runs on the work queue rather than as a headless turn, so naming a conversation never takes the
Intelligence thread lock and cannot refuse somebody's own next message with a 409. A deployment with
no model key names nothing and carries on.

### The trail says who a coworker was opened to

Making a coworker public admits every signed-in person to it, and being admitted to a coworker is
being allowed to act as it — with the connectors, the tools and the browser it was granted. It is one
click in the coworker dialog. The `bot.created` and `bot.updated` rows recorded the name, the
endpoint and whether a key was set, and said nothing about this, so an edit that opened a coworker to
the whole deployment was byte-identical on the audit page to one that corrected its title. Both rows
now carry the visibility, on every edit rather than only the edit that moved it, so reading the trail
forward says who could reach each coworker at any point.

### Duplicating a Bot in the box keeps its instructions

A coworker that runs on this deployment's own Bot has no endpoint — it has a prompt, which is the
whole of what makes it that coworker. Duplicate rebuilt every copy from the endpoint alone, found
none, and fell back to the managed Bot with the prompt dropped, so the copy carried the name, the
title, the role and the avatar and none of the instructions. Its entire instruction became the one
sentence of role description, which is the shape behind the compliance answer this repository
already has a note about. The two coworkers the default package ships are both of this kind, and one
of them is a careful do-not-fabricate instruction. A copy now keeps the prompt and stays a Bot in the
box, which also means it can still be granted the right to hand work on — written as a hosted
coworker it could never hold that grant, however the original was set up — and copying one no longer
needs a managed Bot to fall back to.

### Hiding a coworker no longer hides the grants pointing at it

Hiding a coworker is a preference about your own roster — one row per person — and the grants saying
which Bots may hand work to it are a deployment-wide fact an administrator set. The Handoff section
joined the two, so hiding a coworker from your roster took every grant aimed at it off the screen:
the switch was gone, no note said why, and the count above the list quietly dropped by one. Those
grants were still in force, because a hop is decided by the grant and not by anybody's roster, so
the coworker went on being asked while the only screen that could stop it had stopped listing it.
A coworker you have hidden now appears in that list when a grant already points at it, marked as
hidden from your roster, so it can be switched off. One you have hidden with nothing granted to it
stays hidden.

### A tool call that failed no longer reads as one that worked

The audit page draws a row it does not recognise as `Allowed`, which is right for the many rows that
are neither a refusal nor a failure. Two rows that are failures were falling through to it: a
connector tool call this deployment permitted and the vendor did not complete, and a component's
data read that was granted and then broke. Both were drawn in the same muted colour as a call that
went through, and neither appeared under `Did not happen`, so the view an administrator opens to ask
what did not work here was short by exactly the rows they came for. A per-person connector fails on
this path every time somebody's token expires, so this was the most common failure the product has
and the one the trail was quietest about. Both now read as `Did not happen`, and both are in that
saved view. Neither is filed as a refusal: nothing was forbidden on either row.

### A blank agentId on a channel activity says which field was wrong

`POST /api/channels/:id/activity` accepted an `agentId` of only spaces, trimmed it to nothing, then
looked that up and answered `404 Agent not found`. The field was malformed rather than the agent
missing, so the answer sent whoever was integrating to look for a coworker that was never named. It
is now a `400` naming the field, which is what the same endpoint already did for malformed text.

### Audit payloads are redacted by the store as well as by its caller

Redaction of secrets out of audit payloads happened in `recordAuditEvent`, and every caller in the
tree goes through it. The store underneath it is exported, though, and its `insert` wrote whatever it
was handed, so a future direct caller would have written secrets to the audit table in cleartext.
`insert` now redacts too. Redaction is idempotent, so nothing about the existing path changes; this
is the floor under it rather than a fix to it.

### A stray space in NODE_ENV no longer lets the public example key through

A deployment that never changed `KEY_ENCRYPTION_KEY` encrypts its credential vault with the key
printed in `.env.example`, so the server refuses to start with it under `NODE_ENV=production`. That
refusal compared the variable exactly as written, while the other production refusal beside it —
private-host browsing — trimmed first. Both read the same env file, and a trailing space there is
invisible: Docker's `env_file` preserves it and so does every hosting dashboard with a text box. So
`NODE_ENV=production ` tripped one refusal, slipped past the other, and started the deployment on the
public key with only a warning at boot. Both gates now ask the same question the same way.

### A tool result from an MCP server with an empty part no longer crashes the turn

Reading a tool result cast every part to an object and asked for its type. A `null` or missing entry,
which a vendor's MCP server is free to send, threw instead, and the turn that had just called the
tool failed. Such a part is now named `[unknown]`, which is the same naming-rather-than-dropping the
surrounding code already does for parts it does not recognise, so the rest of the result still
reaches the Bot.

## OpenBot 0.0.6
### Setting up needs one Intelligence credential, not two

`COPILOTKIT_LICENSE_TOKEN` is no longer required. Managed Intelligence derives entitlement from the
project key, so the second credential people were sent to fetch had stopped existing, and startup
was still refusing to boot without it. A deployment now needs `INTELLIGENCE_API_URL`,
`INTELLIGENCE_GATEWAY_WS_URL` and `INTELLIGENCE_API_KEY`. A licence token is still read and still
forwarded to the runtime when set, which is what a self-hosted Intelligence with its own licence
needs.

The Helm chart failed harder than the docs did: it *required* `secrets.licenseToken`, so a
managed-Intelligence install was refused at `helm install` rather than merely misdocumented. That
value is now optional.

### Duplicating a coworker keeps the endpoint it was copied from

Duplicate used to point every copy at this deployment's own managed Bot, whatever the coworker being
copied ran on. Duplicating one you host yourself gave back something that looked identical on every
screen, carried the same name, title and role, and answered from a different process. The copy's
connection tab then said it ran here and stopped showing an endpoint at all, so the swap was
invisible in the one place you would have checked. A copy now runs where its original ran, and the
managed Bot is used only when the coworker being copied had no endpoint of its own, which is the
same fallback that applies when you create one without an endpoint. It does not inherit the
original's key: that is a reference into the vault, and two coworkers sharing one credential would
mean rotating either one's key silently changed the other's, so a copy starts without one. On a
deployment with no managed Bot configured, duplicating a coworker that brought its own endpoint now
works instead of being refused with advice to give it an endpoint it already had.

### Connecting an account survives a vendor that is down

Finishing a connection used to end on a blank server error if the vendor could not be reached at the
moment you were sent back, whether that was a refused connection, a name that would not resolve, or
fifteen seconds of silence. It now ends where every other failed connect already ended: back on
Connected accounts with a note, and nothing stored. Pressing Connect for a vendor this deployment
has not introduced itself to yet behaves the same way, answering 502 rather than a server error, and
that message now covers a vendor that could not be reached as well as one that turned the
registration down.

A connection whose grant cannot be written to the vault ends the same way, rather than on the blank
error it used to give somebody who had just finished consenting.

Because the person is told the same thing whatever went wrong, the server log is now where the
difference lives. Three lines to look for: `oauth-token-endpoint-unreachable` and
`oauth-registration-endpoint-unreachable` name the vendor and the cause, and
`oauth-connection-not-recorded` says a consent completed and could not be kept. A fourth,
`oauth-token-endpoint-unusable`, means the fault is this deployment's catalogue rather than the
vendor.

### A custom MCP server token is sent with the scheme it names

Every token stored against a custom MCP server went out as `Bearer`, whatever the vendor asked for.
A server that forwards the header to an API speaking Basic auth still answers the handshake and the
tool listing, so the Plugins page showed the connector connected and its tools offered, and every
real call came back 401. DataForSEO's hosted server behaves exactly this way.

A token that begins with `Basic ` or `Bearer ` is now sent as written, so paste the credential the
vendor gives you, scheme and all. A bare token is still sent as `Bearer`, so nothing already
working needs to change.

### A conversation is no longer stuck after a tool call went unanswered

A tool that runs in the browser can be torn down while its call is still open, most often because
the tab was closed or reloaded mid-run. The call stayed in the thread with no result, every retry
sent it back up, and the model API refused the whole conversation with `Tool result is missing for
tool call ...`. The next three things the person typed failed identically, and the only way out was
to notice that and start another channel.

A chat turn now drops a tool call nothing is going to answer before the conversation reaches the
model, on a built-in Bot and on a remote one alike. Routines already did this for the history they
seed, and now share the one filter, with a stricter rule than theirs was: a result counts as an
answer only if it arrives before the next thing the person said, matching what the model API
enforces, so a handler that resolves after the person has typed again no longer looks like an
answer. A routine's seeded history that held such a late result used to keep both halves and fail
at the model; it now drops both and runs. A result that sits ahead of its own call, or a second
answer to a call already answered, is dropped as well rather than sent where no provider accepts
it. Ids are never rewritten and the stored thread is untouched, so the transcript still shows what
happened and a call waiting on a resume still gets its result. The same filter also covers a Bot
answering a relayed question, whose seeded conversation kept every tool call and no tool result.

### Reopening a channel no longer hides the end of the last conversation

Opening a channel joins the realtime gateway, and the snapshot the join returns can lag the durable
store. When it did, the last exchange of a finished turn was missing from the transcript on every
reload, with no unread marker or anything else to explain the gap, and the stored copy never got a
chance to replace it because history was only restored into an empty channel.

The stored thread now wins whenever it holds more than the channel does and holds everything the
channel already shows. A message typed while history is still loading is not in the store yet, and
a run still streaming has messages the store has not seen, so neither is rolled back.

### The transcript stays with the question when an answer starts arriving

Sending a message carried it up to the top of the view, correctly, and then the Bot's first token
threw the conversation back to its very first message, with the answer being written several
screens below the fold. It happened on every turn, from wherever the reader happened to be
scrolled, so every answer began with a scroll back down to find it. The transcript now holds the
question in place for the whole turn, and the scroll that puts it there is animated rather than a
jump — unless the reader has asked their system for reduced motion.

### A conversation started from the sidebar is recorded like one started from the home screen

The trail had a `channel.routed` row for every conversation begun in the home composer — the
coworker it went to and why, whether inferred or named with `@` — and nothing at all for one begun
from the sidebar's +, a coworker's card or its profile, which read exactly like a row that failed
to write. Picking a coworker in that To: field is now recorded the same way an `@` is.

### A browser clock that runs ahead no longer hides what a routine said

The roster line and unread dot for a channel are moved by the last report that arrived, and only
ever forwards. A browser whose clock was ahead stamped its report into the future, and then every
report from a correct clock — a routine's reply, a relayed handoff answer, another member's browser
— was dropped without a word until the real time caught up: the reply was in the thread, and the
roster never said so. A reported time is now capped at the server's own clock.

### An empty supervisor PORT is unset, not an ephemeral bind

`PORT=` left blank in compose or a `.env` used to reach `Bun.serve` as `NaN`, so the supervisor
bound a random port while the published mapping still pointed at 4300. Empty now means the default
4300; a non-numeric or out-of-range value refuses to start instead of binding port 30 from a typo
like `30o0`.

### Tool arguments and results are redacted in the audit trail whatever their spelling

The sensitive-key list redacted `tool_result` and `tool_arguments` but not `toolResult` and
`toolArguments`, which is the spelling MCP and computer tool calls use. Those payloads were stored
verbatim in `audit_events.payload`, nested ones included, while every other sensitive key already
carried both spellings. New rows are redacted; rows already written are not rewritten, so a
deployment that has been running MCP or computer tools still holds unredacted arguments and results
in its existing trail.

### An IPv6 address listed in `AGENT_ENDPOINT_ALLOWED_HOSTS` is now actually allowed

A bracketed IPv6 host was normalised one way when the list was read and another way when an endpoint
was checked, so the two could never match: `[::1]:8080` became `::1]:8080` on one side and
`::1:8080` on the other. Registering a Bot at a listed IPv6 address was refused as a private
address anyway. IPv4 was unaffected.

### An empty `PORT` no longer starts the server on a port nobody asked for

`PORT` and `SERVER_PORT` name one number, and either is meant to move the server. A `PORT` that was
declared but empty — a compose file passing a variable the host never set, or `PORT=` left in a
`.env` next to a `SERVER_PORT` that was set — was read as "set to nothing": `SERVER_PORT` was
ignored, the number parsed to `NaN`, and the server came up on an ephemeral port while everything
that polls `SERVER_PORT` reported it had never started. An empty value now counts as unset, the way
every other setting already treats it, and a value that is not a whole port number (`30o1` used to
start the server on port 30) refuses to start instead.

### `TRUSTED_ORIGINS` falls back to the port the app is actually served on

Unset, it fell back to `http://localhost:3000`, while the app is served on 3010 everywhere else in
this repository. `appUrl` reads the first trusted origin, so a deployment that left the variable
blank built OAuth redirects against a port nothing was listening on.

### Coworkers are made in a wizard and managed in a dialog

Creating a coworker is now a three-step wizard — who it is, who may see it, then where it runs,
with **Built in** offered only when the deployment actually has a managed Bot to run it on.
Managing one is a dialog opened from wherever the coworker appears, with sections for its profile
(each field edited in place), what it may reach, its connection, handoff grants, routines, and the
hide/duplicate/delete verbs — usable on a phone, where the old side panel hid most of this. The
panel beside a conversation slims down to who-you-are-talking-to plus two buttons: start a new
channel, or open that dialog.

### Routines live on each coworker

The sidebar's global Routines entry is gone; a coworker's routines are a section of its own dialog,
since a routine is something *it* carries out. The `/routines` page still answers direct links.
Each routine row now wears its state as chips — the channel it posts to, how the last run went, and
either the next run, **Paused**, or **Due** when a firing is waiting on the sweep (which used to
render as "Next 5 hours ago").

### A built-in coworker is no longer asked for credentials it will never need

A coworker running on the deployment's own Bot was nagged for a callback token and shown an
endpoint form. Its connection tab now says what is true — it runs here, nothing to connect, nothing
to authenticate. In the same spirit, the handoff panel explains once when a coworker cannot hand
work on (it runs as its own agent, outside this deployment's loop) instead of offering switches the
server can only refuse; its existing grants stay visible so they can still be revoked.

### A conversation is given a name of its own

A channel was labelled with the names of the Bots in it, so every conversation with the same
coworker read the same on the roster, and the only thing telling two of them apart was a preview of
whatever was said last. That preview is usually the tail of an answer, which says nothing about the
question that prompted it. Once a conversation has an opening exchange, the deployment's own model
is asked for a few words naming what it is about, and the roster draws those words in place of the
preview. A deployment with no model key configured names nothing and looks exactly as it did before.

### A channel stops showing a working indicator once its turn has ended

Sending a message and then opening another channel before the reply arrived left the first channel
showing three bouncing dots on the roster, and they stayed there after the answer had landed and
been drawn into its preview, until the roster was refetched for some unrelated reason. A person's
own turn is reported by the browser, because the server is not told when one begins, and that
reporting was keyed on state belonging to the channel screen: opening another channel replaced the
screen, and the replacement reported the channel it had just opened rather than the one still
working. The report now belongs to the turn instead of to the screen, so the channel that was
running is the channel told when it stops. Opening a channel also no longer announces that it is
idle twice before anything has run in it.

### A hop the boundary refused now names the Bot that was refused

The audit page renders its Bot column from `payload.bot` and nothing else. `agent.handoff_offered`
and `agent.handoff_delivered` were given that key; the four rows either side of them — a hop
refused, a hop retried, and a hop that failed for good — were not, so they showed a dash where the
Bot belongs. Those are the rows somebody actually opens the trail for: a hop that happened is visible
in the transcript anyway, and a refused or lost one is visible nowhere else. All four now name the
asking Bot, exactly as the accepted pair and `agent.escalated` already did.

### A failed tool refresh no longer leaves a connector offering nothing

Refreshing a connector's tools replaced the list with a delete and then an insert, as two separate
statements. Whenever the second did not land — a pod killed mid-refresh, a dropped connection, or a
server answering `tools/list` with the same tool name twice, which the table refuses — the delete had
already committed on its own. The table is shared, so every replica lost that connector's tools at
once, every grant an administrator had made was silently un-offered, and the Bot was told it holds
none of that vendor's tools. Nothing brought them back until somebody read the error on the Plugins
page and pressed Refresh. The two statements are now one, so a bad refresh is recorded and the tools
already held are left alone, which is what the code always claimed to do.

### A rule tried in dry-run now says what it would have refused a Bot's tools

`dry-run` exists so a boundary can be measured against live traffic before it starts refusing
anybody. It worked that way for the browser, and not for connectors: a tool call the rule matched was
recorded only as the call that then went out, so `Blocked` on the audit page — and any query behind
it — answered "this rule would have refused none of them" about calls it would have refused. A rule
about `mcp.server`, `mcp.tool` or `mcp.effect` therefore looked inert, and enforcing it started
refusing Bots with nothing in the trail to have warned anybody. A refused tool call is now recorded
whatever the mode does with it, carrying `carriedOut` so a reader can tell a call this deployment
stopped from one dry-run recorded and let past. Enforcing deployments behave exactly as before.

### A policy dry-run no longer counts a failed action twice, or invents a change it did not make

Testing a boundary against recent history replayed three kinds of audit row, and one of them is a
duplicate: a permitted action that fails is recorded both as the decision that allowed it and as a
separate failure row, so every failed action was scanned and scored twice. Worse, a dry-run policy
carries a refused action out, so a refused action can fail too — and its two rows disagree, the
decision row saying "refused" and the failure row reading as "allowed", so a candidate policy that
refused it identically was reported as a new refusal it never introduced. The replay now scores each
action once, from the row that recorded its decision.

### A message no longer routes to a specialist because a longer word contained a connector's name

When the intent router falls back — it is unreachable, or it declines — and exactly one coworker can
reach a system the message names, the message goes to that coworker. The name was matched as a bare
substring, so "how do I deal with a slacker" matched the **slack** connector and "una jirafa" (a
giraffe) matched **jira**: a message naming neither system was pinned, for the life of the thread,
to a specialist that could not answer it. A connector's name now has to appear on a word boundary,
so a system named on its own still routes and one buried inside another word does not.

### The audit page no longer says "Allowed" about six kinds of refusal

A hop one Bot was not allowed to make, an endpoint this deployment would not dial, a rotation the
vault refused and a sign-in it turned away were all drawn as **Allowed**, in the muted colour every
ordinary row uses, and none of them appeared under **Blocked**. The same for a hop that ran out of
attempts and a question that reached nobody, which are "Did not happen" rather than allowed. The
page recognised six refusal types and the six added since were never added to it. Refusals now read
as refusals, the two saved views are built from the same lists the rows are labelled from, and a
refusal added later is added in one place or in none.

### A conversation deleted while a server was reconnecting no longer lingers on the screen

Announcements between servers travel as Postgres notifications, which reach whoever is subscribed at
the moment they are sent and are never replayed. While a server's subscription was down — a database
restart, a failover, a rolling upgrade — every channel deletion, pin and message announced in that
window was lost, and nothing afterwards asked for it again.

The browser could not notice. Its own connection to the server stayed open throughout, so the
refetch it already does when that connection comes back was never triggered, and the roster went on
showing a conversation that had been deleted until the page was reloaded.

A server now tells the browsers it is holding to refetch when its subscription is re-established.
Nothing to configure, and no change for a deployment whose database connection never drops.

### A Bot can answer with a picture instead of describing one

Ask for a chart and a Bot replied in prose, or handed back a fenced block of HTML for somebody to
read instead of look at. Set `OPENBOT_GENERATIVE_UI=true` and it may answer with an interface it
writes itself, drawn in the transcript. Off unless asked for, and deliberately so: it runs code a
model wrote, so a deployment acquires the capability by choosing it rather than by upgrading.

### The sidebar collapses, and the roster is reachable on a phone

The sidebar could always collapse, but nothing in the app ever drew the trigger. The only
affordance was a 16px transparent rail carrying `tabIndex={-1}`, which the eye could not find and
the keyboard could not reach. Below 768px that same sidebar becomes a sheet whose open state starts
false, so with no trigger the roster was unreachable on a phone, and the roster is how you reach a
channel, Skills, Agents and your own account. There is now a toggle in the header each screen
already draws, with Cmd/Ctrl+B on it, and the collapsed choice survives a reload: the state was
written to a cookie that nothing ever read back. Fifteen screens that previously drew no header bar
gain 40px above their heading, because the toggle has to sit at the pane's edge.

### A button drawn as a link answers the keyboard and announces itself

Six controls navigate rather than submit, so they render a router link through the shared button:
New skill, New agent, the sidebar's new-channel control, two empty-state returns, and the back
button that draws on five routes. Base UI was told each was a native `<button>`, so it wrote
`type="button"` onto an anchor, where it means nothing, and skipped the two things a non-button
needs: the `role="button"` that tells a screen reader what the control is, and Space-key
activation, which a `<button>` gets from the browser and an anchor does not.

### A Bot's answer comes back to the conversation that asked

**This reverses what 0.0.5 shipped.** The 0.0.5 notes below say the asking Bot does not relay text
on the addressed Bot's behalf, and the answer lands in that Bot's own conversation. In practice
that meant reading the answer somewhere you never asked anything, so it is now the other way
around: the addressed Bot works in a scratch conversation nobody is shown, and the asking Bot
relays what came back — attributed by name — into the conversation you are watching. What you read
is the asking Bot's account of the answer rather than the answer verbatim; very long answers are
clipped to keep the relay itself from failing.

### Channels say when a Bot is working in them

A channel whose Bot is mid-turn shows a working indicator on its roster avatar — including turns no
browser started, such as a handoff running on the server or a routine. An open conversation also
picks up turns that arrived while nobody here streamed them, so a relayed answer appears without
leaving and coming back.

### First sign-in gets an onboarding wizard

A new person lands in a short welcome wizard before the app; everyone who signed in before this
upgrade is stamped as already onboarded by the migration and sees nothing.

### Shift+N starts a new chat from anywhere

Bound across the signed-in app, shown under **Settings → Keyboard shortcuts**, and inert while you
are typing in a field. Handoff work is also picked up the moment it is queued rather than at the
next poll, so an answer's round trip no longer pays up to two seconds per leg.

### A Bot's shell can no longer reach the embedded database without a password

In the all-in-one image the cluster was `trust`-auth on loopback, and the Bot's shell runs in the
same container: it could `psql -h 127.0.0.1 -U openbot` with no password and read the audit trail,
the policy store, and the credential vault as the instance owner. The cluster now uses
`scram-sha-256` with a password generated on first init and kept beside the data, handed to the API
over the container environment. The shell has no way to learn it, so the connection is refused. An
external `DATABASE_URL` deployment is unaffected.

### A live screen that ends says so, instead of freezing the last frame

When a Bot's live screen ended — the computer stopped, or the socket failed — the message explaining
why was drawn only by a component the take-the-wheel view does not mount, so the screen sat frozen on
its last frame with nothing said. The reason is now shown where the live screen is.

### A Bot's browser drops the automation flags a person needs gone to sign in

The browser announced itself as automated (`navigator.webdriver`, the enable-automation switch),
which sites like Google refuse even when a real person has taken the wheel. Those flags are now off
at the source — the browser flag, not a script that patches `navigator.webdriver` and leaves the
other tells. A headless build still reports `HeadlessChrome` in its user agent, which only running
headed under a virtual display removes; that heavier change is tracked separately.

### An empty model reply, or a run with no question, no longer ends in silence

Two failures on strict OpenAI-compatible providers (z.ai GLM, Anthropic): a follow-up run that
carried only tool deltas and no human turn was refused outright, and a reply with no text and no tool
call ended the run with nothing on screen. A run with no human turn now carries a neutral
continuation, and an empty reply ends on a visible line rather than in silence. OpenAI, which
tolerated both, is unchanged.

### Embedded PostgreSQL initialises on a platform volume, and says so when it cannot

`EMBEDDED_POSTGRES=on` could not create its cluster on a platform whose persistent volume is an ext4
mount — Railway, and by the same mechanism most others — and it failed differently depending on where
the volume was mounted. Neither of the two paths this repo suggested worked, and the two suggestions
disagreed with each other: `docs/deployment.md` said `/var/lib/postgresql/data`, the `Dockerfile`
comment said `/var/lib/postgresql`.

Mounted at the parent, the mount arrives owned by root, `data` is not in it, and the image's
build-time `chown` is hidden underneath — so `initdb`, which has already dropped to the `postgres`
user, cannot create the directory. `postgres-init` now creates and chowns it first, as root, which is
the only step in a position to. This also fixes the plain
`docker run -v openbot-data:/var/lib/postgresql` case, which relied entirely on that hidden chown.

Mounted directly on the data directory, the mount arrives holding a `lost+found`, and `initdb` will
not initialise into a directory with anything in it. **The documented mount is now the parent,
`/var/lib/postgresql`**, which leaves `data` an ordinary subdirectory — what PostgreSQL's own hint
asks for, and what the `Dockerfile` already said. A volume already mounted at
`/var/lib/postgresql/data` and working — a Docker named volume, which arrives empty rather than with a
`lost+found` — keeps working and needs no change.

**The failure said nothing useful.** `api` waits on `postgres` and `migrate`, so neither started, the
container came up anyway, the platform reported the deploy a success, and the public URL served a
persistent 502 with the real reason visible only in the container log. A data directory that holds no
cluster and is not empty is now refused with a sentence naming the mount to use instead.

Reported by [@jerelvelarde](https://github.com/CopilotKit/OpenBot/issues/269) with the container logs
for both mount paths, which is what made the two failure modes separable.

### Turning on network policies no longer leaves the culler pod open

`networkPolicy.enabled` rendered policies selecting the server and the computers. The culler
CronJob's pod carries `component: culler` and was selected by neither, and a pod no policy selects
keeps the cluster default rather than being denied. So the switch fenced the API and the computers
and left open the one pod that wakes every five minutes carrying the API's whole environment,
`KEY_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` included, with a token allowed to create, patch and
delete Sandboxes. It has a third policy now, narrower than the other two, and
`networkPolicy.cullerExtraEgress` narrows its database egress separately from `extraEgress`. A
render that leaves any pod unfenced is refused by the chart checks.

### A sign-in a site opens in a new window is shown, and can be clicked

A Bot's browser was bound to the page it launched with, and to nothing the site opened afterwards.
Anything arriving in a new window or tab was invisible on the live screen and unreachable by input,
so the popup sign-ins that a person takes the wheel to complete were exactly the ones they could not
complete. Worse than invisible: a click at the place the popup's button was drawn went to the page
underneath it, so a person trying to finish a sign-in could navigate the page the Bot was working on
without seeing either result.

The browser now follows the window the site opens, and returns to the opener when it closes, which is
what a sign-in popup does when it succeeds. A snapshot taken before the change of page is refused
afterwards with the same "take a new snapshot" it already gives after a navigation, so a stale ref
cannot act on the wrong document.

Nothing to configure.

### Stopping a Bot's computer stops it, and the person watching is told

A computer somebody stopped came back up on its own about a second later, and reset did the same. The
live screen kept a loop asking for the Bot's current page once a second, asking for a page is what
starts a browser, and nothing tore that loop down when the browser it was showing went away. The same
loop kept the browser marked recently used, so a Bot with somebody watching was also immune to the
idle timeout and came straight back after being closed to stay under the cap on running browsers.
Those last two never involved a request at all, so nothing on the stop path could have covered them.

Two smaller failures went with it. A person who reconnected, leaving their old window open, could
have that old window's typing land in the page the new one was watching, with nothing said to either.
And a window closed while the browser was still starting left a screencast and its loop behind for a
connection that had already gone.

The screen is now held per connection rather than per Bot, so closing one only ever ends its own, and
teardown hangs off the browser closing rather than off the two requests that ask for it. A viewer
whose screen ends is sent a message saying why, whether the computer stopped, was reset, or the
screen was taken over by another window.

Nothing to configure, and no change for a deployment where nobody watches a Bot work. **The app does
not yet show that message**: it arrives at the browser and is held in state the live screen does not
read, so a person still sees the last frame until they reopen the screen. That half is tracked
separately in #287.

## OpenBot 0.0.5
### One Bot can hand work to another, and reach a person when no Bot will do

A Bot asked something it is not the right Bot for can now put the question to one that is. The
addressed Bot answers **as itself, in its own conversation**, with its own tools and its own
knowledge. The asking Bot does not relay text on its behalf, so what you read is the answer that
Bot actually gave rather than another Bot's summary of it. *(Reversed since: see Unreleased — the
answer is now relayed back into the conversation that asked.)* The asking conversation records
that the question was put and to whom. A Bot that judges no other Bot will do can instead reach
the person who asked it.

**No Bot may address any other until an administrator says so.** Which Bot may reach which is an
ordinary grant, made per Bot on that Bot's own screen under **Bots it may ask**, and a Bot with no
grant is told it cannot rather than quietly trying. The pair is directional: that list is who this
Bot may ask, not who may ask it, so letting two Bots ask each other is two switches. A Bot addressed
by a name two Bots answer to is refused and both are named, because picking one would be a guess
about which colleague a person meant.

Two ceilings, because a Bot deciding to ask another Bot is a Bot deciding to spend a run:
`BOT_HANDOFF_MAX_DEPTH` is how many Bots deep a chain may go and defaults to `1`, and **`0` switches
the capability off entirely**: the tool is not offered rather than offered and refused.
`BOT_HANDOFF_MAX_PER_RUN` is how many Bots one run may address and defaults to `3`. The Helm chart
takes the same two as `config.handoff.maxDepth` and `config.handoff.maxPerRun`.

A hop that fails is reported back by the Bot that asked, after its attempts are spent, rather than
leaving the person watching a conversation that never finishes. One rough edge to know about: a hop
that is retried leaves one "asked" line per attempt in the addressed Bot's own transcript, so a hop
that took three attempts reads there as having been asked three times.

No new tables: this uses the work queue that already fires the culler.

### A conversation that used a tool no longer stops answering for good

A channel could reach a state where every turn in it failed and the only thing it said was
`Tool result is missing for tool call call_…`. Not the turn: the conversation. Everything sent
afterwards failed the same way, including a question as ordinary as what two plus two is, and there
was nothing a person could do to it from the screen.

A tool result is matched to the call above it, and a thread read back from the platform does not
always carry the two in that order. Where the result was stored ahead of its own call, this
deployment counted the call answered, sent the history on unchanged, and the model provider rejected
the whole conversation while assembling it. Handing work to another Bot, asking a person, and
calling a connector's tool could each leave a thread in that shape.

A result now only answers a call it follows. One that arrives early is moved to sit after its call,
keeping what it actually said, and a result whose call is nowhere in the thread is dropped. Affected
conversations start answering again on their own; there is nothing to run and nothing to reset.

### The framework Bot answers on 5.6-tier models, and can be told how hard to think

Pointing `BOT_MODEL` at a `gpt-5.6-*` model gave a Bot that started, reported healthy, and then said
nothing: every run was a RUN_STARTED and a RUN_FINISHED with no text between them. Those models are
run on the Responses API, which streams content blocks where chat completions streams a string, and
the run read only the string — so every delta was dropped on the floor. Both shapes are read now.
Nothing changes for a deployment on 5.5 or on Anthropic or Google.

`BOT_REASONING_EFFORT` sets how hard a reasoning model thinks: `none`, `minimal`, `low`, `medium`,
`high`, `xhigh` or `max`. Unset, the model keeps its provider's default. A value the API does not
have, or one set where it cannot be sent — a provider that is not OpenAI, or a model not on the
Responses API — stops the Bot at startup with a message naming what to change, rather than starting
with a setting that goes nowhere.

### A Bot can be asked to do something on a schedule

"Every weekday at nine, post the standup notes here" is now something a Bot can be asked rather than
something somebody has to remember. A routine created this way runs under its own creator's grants —
it can do exactly what they could do in chat, and nothing more — and its reply lands in the channel as
an ordinary Bot message: it lights the unread dot the same way any other message does, and it appears
in the transcript rather than anywhere separate. A routine that fails posts one message about its
first failure and, after ten in a row, switches itself off with a final one rather than failing
forever unnoticed.

The deployment gains two tables, via migration `0021`.

**This needs a new process.** A worker fires due routines by calling this deployment's own API server,
and a deployment that never starts one schedules nothing — the routine sits on the Routines page with
a next run time like any other, and nothing on the screen says a worker is missing. `WORKER_SHARED_SECRET`
is the credential the worker presents; a deployment without it configured refuses every handoff rather
than accepting one it cannot attribute. `scripts/start.sh` runs the worker locally; the Helm chart
turns it on with `routines.enabled` and takes the secret as `secrets.workerSharedSecret`. No new port
is opened for any of this — the worker only ever calls out to the server it already trusts.

### Turn screenshots are swept in every deployment, not one

A page a Bot opens is photographed and kept in `computer_page_frame`, so a conversation read back
later shows what it was looking at. The reaper for those rows had one caller: the idle-computer
culler, which refuses to run unless each Bot has its own computer and is scheduled only by the Helm
chart's CronJob, which exists only when `computers.mode` is `sandbox`. On Compose, on the all-in-one
image, and on the chart's own default of `shared`, nothing ever called it. One browsing Bot over
ninety days is several hundred megabytes of rows that nothing was ever going to remove.

The sweep now runs on the server, on the same hourly timer that removes old audit rows, and does not
wait for a retention policy to be configured: a month of screenshots is what the store already meant
to keep. It also removes them in batches, because one statement over that much data held its locks
for seventeen seconds.

Deployments using `computers.mode: sandbox` are unaffected in what they keep. The culler no longer
purges frames, because the server does it there too and one owner is better than two.

**On upgrade, the first sweep removes the backlog.** A deployment that has been keeping every
screenshot since it was installed will lose the ones older than a month, about a minute after the
server starts. That is the window the store has always documented and the one sandbox deployments
have been enforcing, but it has never been applied anywhere else, so it is worth knowing before the
upgrade rather than after. It is drained in batches, forty thousand rows an hour, rather than in one
statement.

### A channel a Bot has spoken in unseen shows a dot

The sidebar marks a channel when a Bot has said something since you last had it open: a dot beside
the preview, the name a touch heavier. Opening the channel clears it, your own messages never set
it, and the channel you are looking at never shows it. The marker is yours alone — per member, on
the membership row like the pin — so one person reading does not clear anybody else's dot.

The deployment gains one nullable column, via migration `0019`.

### The API can reach Intelligence and sign-in when a NetworkPolicy is on

`networkPolicy.enabled` wrote a rule for the API server that named DNS, the database and the Bots'
computers, and nothing on 443. On a cluster that enforces policy the server could therefore reach
neither CopilotKit Intelligence, nor an identity provider, nor a Bot: nobody could sign in and no
conversation ran. Two of the five shipped `ci/` targets turn the policy on, and on GKE enforcement is
the default and cannot be switched off.

Nothing said so. The pod passed every probe and stayed Ready, because `/health` answers from a
literal, so the first evidence was a timeout to a hostname that read as the internet being down.

The API now reaches HTTP and HTTPS everywhere outside the cluster's private ranges, in every
`computers.mode` rather than only `sandbox`, cut by the same exception list the computers' own policy
uses. It still cannot address another pod, a node, or a cloud metadata endpoint.

`mode: sandbox` had been working only because a rule meant for the Kubernetes API server carried no
destination and so permitted everything. That rule now covers the API server alone, and
`networkPolicy.kubernetesApiCidr` narrows it to your cluster's service range; left empty it stays as
it was, because a chart cannot know that range.

### Taking the wheel stops the Bot's shell, not just its clicks

While a person held the wheel the Bot was refused on the page, and not in the shell. `/exec` and a
workspace write went through, so a Bot could keep running commands and rewriting its `/workspace`
underneath somebody who had taken the browser at a login wall. The guard existed and covered
navigation and the four page actions; the shell arrived later and was never wired to it.

Every acting path now asks the same question in one place, so the property the documentation states
is the property the computer has. Reading is deliberately not acting: `/files/read` and
`/files/list` still answer while a person drives, because a Bot that has just been stopped still has
to be able to say what it was doing.

Nothing to configure. A Bot that acts during a takeover gets the refusal it already got for a click,
and the trail records the attempt and the failure the same way.

### A computer that was suspended once suspends again

Scale-to-zero worked once per Bot. A computer suspended, resumed, used and then left alone again was
offered for suspension on every sweep after that and never suspended, and stayed awake until the next
day. Nothing reported it, because a sweep that offers work and suspends nothing looks exactly like a
fleet that is busy.

The queue keys a suspension on the Bot id and keeps the finished row so that a late offer of the same
key collides with it rather than running the work twice. Both are right. What was wrong is that the
finished row was kept for a day, which is the window the other half of the sweep needs: a suspension
that keeps failing is held back that long before anything tries it again. One number could not be
both, so there are now two, and a finished suspension is kept for the idle window instead. That is
the same clock the offer runs on, so a Bot cannot come back round as idle until its row has gone.

Nothing to configure, and the sweep already runs on a schedule. A deployment where each Bot has its
own computer stops paying for browsers that were used once.

### A Bot's egress proxy is reachable on Kubernetes, or the install is refused

The chart named no egress variable anywhere, so a Helm deployment read the per-Bot proxy settings
nowhere and every Bot went out directly. They were always settable through `computers.extraEnv`,
which reaches the computer in both the shared and the sandbox arrangement, but nothing in the chart
or its README said so, and a setting whose whole purpose is to give a security team a per-Bot
address is not one to leave undocumented.

The other half is that setting it was not enough. A computer is allowed 80 and 443 to public
addresses and nothing else, which is almost no proxies: they sit on a private address, or on 3128 or
8080. So a proxy the network policy provably blocks is now refused at `helm install`, naming
`networkPolicy.computerExtraEgress`, rather than found later as a Bot that fails on every page.
Nothing changes for a deployment that sets no proxy, or one that already opened a path to it.

### A finished turn shows the page it opened, not the one open now

Reopening a conversation made every past turn fetch the screen as it is now, so an answer about
Hacker News from an hour ago sat under a picture of whatever the Bot had open since.

A page is now photographed where it is opened. The server takes the frame the moment a navigation
succeeds and keeps it in `computer_page_frame` under the computer and the address, which is the one
moment the screen is certainly showing the page that was asked for. Reopening the conversation shows
that frame rather than the live screen, and a turn with nothing kept names the page instead of
drawing the wrong one.

The surface used to capture it itself once the turn went quiet, and that is a race it cannot win: a
reopened turn and one that has just finished are indistinguishable from inside the component, the
same computer is driven by other conversations in between, and a resumed computer starts blank. It
filed pictures of pages the turn never opened, or none at all. It only reads now.

**Redeploy the computers with the server.** A screenshot only says which page it is of on an
`agent-computer` built after that field was added, and this is what decides whether a frame is kept.
Where each Bot has a computer of its own there is nobody to race with, so an old computer's picture is
accepted and the feature works through a rollout. On ONE SHARED COMPUTER it cannot be: another Bot's
navigation lands between the navigation and the picture, and a frame that cannot be told apart from
theirs is refused. So a shared-computer deployment that updates the server and not the computer keeps
no frames until it does, and says so in the server log each time rather than leaving somebody to
wonder.

Two things followed from making a past turn a record. Its placeholder is decided by the turn being
over rather than by whether a live frame happens to be in hand, because a tile that was live a moment
ago keeps its last screenshot and used to fall through to "Waiting for the assistant's screen…" and
wait there for ever. And opening one full size shows that same kept frame, with no live stream and no
wheel: zooming a past turn used to mount the socket and offer Take control, so the one gesture for
looking closer at what a turn did replaced it with whatever the Bot has open now.

### A conversation keeps the browsing that produced its answers

Every turn in which a Bot used a tool was disappearing from the transcript on reload. The sentence
the Bot wrote stayed; the browsing that produced it did not, the inline screen went with it, and the
footer said some messages could not be read.

The history store writes a tool call as `{id, name, args}`. AG-UI describes
`{id, type: "function", function: {name, arguments}}`. The reader validated against the second,
treated the first as damage from an interrupted run, and dropped it. It is not damage: it is how
every tool call is stored, so what looked like a guard against one bad turn was deleting all of the
real ones. Observed on a live thread where every browsing turn was counted unreadable and every one
of them was well formed in the store's own dialect.

The two spellings are now read as the same thing. The check stays for turns that really are
malformed, and a mixed or unrecognised array is still refused rather than half-translated, because a
reader that rewrites what it does not recognise is worse than one that refuses it.

### Run this on Kubernetes

A Helm chart under `charts/openbot`, Bots and all, and the fixes that installing it for real turned
up. Proven on a real EKS cluster: five workloads, replicas across two nodes, EBS volumes bound, and a
Bot opening a real page from inside AWS with the decision in the audit trail.

One chart, five targets: EKS with a shared browser, EKS with a computer for each Bot, GKE, AKS and
somebody's own cluster, with nothing but values between them. There is no cloud branching in any template. Every place the clouds genuinely differ is a
value whose default is what a plain self-hosted cluster does: the cluster's own default StorageClass,
no RuntimeClass, a plain Kubernetes Secret, an Ingress. Identity is one `serviceAccount.annotations`
map, which is all IRSA, Workload Identity and AKS workload identity are. Secrets are a plain Secret
by default and an ExternalSecret against any backend when asked, so Secrets Manager, Secret Manager
and Key Vault are a values block rather than three code paths. Gateway API is supported beside
Ingress rather than instead of it. `charts/openbot/ci` holds a values file per target.

Two replicas by default, because horizontal is the point and one replica hides every bug that is
not. A bad install is refused at `helm install`, naming the value to change, rather than discovered
in a crash loop: no database or two of them, nobody who could sign in, nobody who would be an
administrator, a key of the wrong shape, both routers enabled, or a browser asked for inside more
than one replica.

**A Bot's computer is not in an API pod.** The image runs one beside the API so that a single
container works on its own, and `EMBEDDED_COMPUTER=off` turns it off. A replica must not carry a
browser: it is a few hundred megabytes holding one Bot's logins, so scaling the API would scale
those with it.

**Migrations no longer need a development tool.** `bun x drizzle-kit migrate` cannot run in the
shipped image at all. The CLI reads a TypeScript config, which needs the esbuild that
`bun install --production` correctly leaves out, so it printed "Reading config file", exited 1 and
said nothing else. `EMBEDDED_POSTGRES=on` was therefore starting a container whose database was
never migrated, and the first symptom was the API reporting that `users` does not exist.
`server/scripts/migrate.ts` uses the migrator inside `drizzle-orm`, which is a runtime dependency
already, and keeps the same journal, so a database migrated by either tool is migrated.

**A computer for each Bot, suspended when idle.** `computers.mode: sandbox` gives every Bot its own
browser as a `Sandbox` from `kubernetes-sigs/agent-sandbox`, which is built for this workload: an
isolated, stateful, singleton pod with a stable identity and persistent storage. Suspending is one
field, and it keeps the volumes, so a computer comes back with its logins rather than signed out of
everything. `shared` stays the default and needs nothing installed in the cluster.

**The NetworkPolicy would have fenced the API off from its own work.** Its egress named DNS and the
bundled database and nothing else, so on a cluster that enforces policy the API could not have
reached a Bot's computer or, with a managed database, the database. Both are allowed now, and turning
the policy on with an external database and no rule for it is refused rather than shipped. Worth
knowing either way: EKS runs its CNI with `--enable-network-policy=false`, so a policy there installs,
looks right, and does nothing at all.

**A cluster with no controller is refused at install.** `computers.mode: sandbox` needs the
agent-sandbox CRD, and without it the install succeeds, every pod is healthy, and the deployment
looks finished until the first Bot asks for a browser. The chart reads the cluster and refuses,
naming the one command that fixes it.

**What decides a computer is idle is the audit trail, not the browser.** Asking the browser would
wake it, so every computer anything asked about would come back up and the bill would never fall.

**Durable work, claimed by whichever replica gets there first.** `work_items` plus
`select ... for update skip locked` and a lease: no coordinator, no leader election, and a replica
added is throughput added. The idle-computer culler is its first user; scheduled routines and
hand-offs between Bots are the other two, which is why it is written once rather than three times
slightly differently. A CronJob runs the sweep, because a timer in the API fires in every replica and
suspending a browser somebody just started using is not something to do five times.

**Which run of a computer this is, across a suspend.** A resumed browser counts snapshot
generations from one again, so a ref the model still holds from before the suspend would match a row
nothing has overwritten and the boundary would decide about an element on a page that no longer
exists. The first answer here used the node and the pod address, and resuming a real computer
disproved it: a suspended sandbox is very often rescheduled onto the same node and handed the same
address back, so both were identical across a suspend and resume and the check would have said "same
run" for the exact case it exists to catch. It reads the `Ready` condition's transition time instead,
which moves every time a computer starts serving again.

**Which run of a computer this is, on more than one replica.** `sessionOf` answered from a map in
the process that started the computer, which is right until there are two: the replica that took a
snapshot is usually not the one handling the click, and the second had nothing to answer with. An
unknown session means "no opinion" and skips the generation check, so on exactly the deployment
shape it was written for, the check that stops a ref from a replaced computer resolving against a
live one was silently absent. It now asks the supervisor when it does not know, by listing rather
than by ensuring, so asking never starts a computer that had stopped.

### A routing trail says why a message was not routed, not only that it was not

Every untagged message writes a `channel.routed` row, and that row carried `fallback: true` for two
completely different situations: the router answering honestly that no specialist was a confident
match, which is the feature working, and the router not answering at all, which is an endpoint that is
down. Both read identically, so a deployment whose router had stopped working looked like one whose
messages were simply hard to route.

That is not hypothetical. The intent router spent an unknown period 404'ing on every deployment that
set `OPENAI_BASE_URL`, because a `/v1` was appended to a URL that already had one. It was fixed in
0.0.3, whose own note says untagged messages "silently stopped being routed and nothing said why".

The row now carries `undecided`, naming the cause: `unreachable`, `unparsed`, `off-roster`,
`unconfident`, or `one-candidate` — and `null` when the router did decide. Named values rather than a
sentence, because the useful question is how often, and a count needs something to group by.

Two smaller corrections came with it. A message routed to the only coworker that can reach the system
it names kept that as its reason and threw the cause away, so a router that had been down for a week
produced rows reading like reach-based routing working as intended; the cause now survives that path.
And an answer containing no JSON at all — a model replying in prose — was recorded as the router
naming a coworker off the roster, which sends whoever reads it to look at their roster rather than at
the model. It is now reported as unparsed, which is what it is.

Nothing changes about where a message goes. Every routing decision is the same decision it was.

### Notion joins the connector catalogue

Notion is now a governed MCP connector, reached through Notion's own hosted server on the
catalogue's default transport, as the person asking — the same grant, policy and audit machinery
Google Drive already runs through. Unlike Drive, it ships both read and write tools from the start;
the writing ones are named in the catalogue, and an advertised tool absent from that list classifies
as a read — so reconciling the write-tool names against what Notion's hosted server actually calls
them, on the first Refresh tools, is required, not cosmetic. A tool the server never advertised at
all still classifies as a write, same as any other connector.

There is no client to register: this deployment introduces itself to Notion on first connect. That
shortens setup but does not finish it — unlike Drive, whose tool list is this codebase's own code,
Notion's tool list is an answer from Notion's hosted server, so a deployment has recorded none of it
until Refresh tools has run at least once; and, like every other connector, a Bot gets nothing until
its tools are granted to it. Setup is enable at `/admin/plugins/notion`, connect an account at
`/settings/connected-accounts`, refresh tools, then grant — a bulk **Grant tools…** dialog on
`/admin/plugins/notion` grants a batch of tools to a batch of Bots in one pass, one grant and one
audit row per Bot per tool. No migration.

### Refresh tokens rotate in place, and replicas take turns spending them

A vendor that rotates refresh tokens invalidates the one it just handed out, so two replicas racing
to use a stale token would have the loser refused, or worse: a rotating vendor's reuse detection can
read that as a stolen token and revoke the whole connection. Every plugin call that mints an access
token now locks the credential's vault row for the length of the exchange, so a second replica waits
rather than races, and the rotated token is written back in the same transaction that held the lock.
Nothing to configure; a connection just stops going stale under concurrent traffic.

### An MCP token is spent only by its own server, and only at the address it was given

Pointing a server at a credential is the one place this deployment takes a reference to a stored
secret rather than the secret itself. Everywhere else, the value was typed into the same request that
stores it: a Bot's key is minted from what an administrator pasted and the id it gets is nobody's to
choose. So this is the one field where which secret and which address could be made to disagree, and
the add settles the disagreement by spending the credential: the tool refresh runs before the call
returns and sends what it decrypts to the URL from that same request.

Two ways they could disagree, and both are now refused. A server could be pointed at any `mcp`
credential in the vault, including one minted for a different vendor, so a token given to one server
was deliverable to another. And re-adding a server with a different URL rewrote the address while
keeping the credential, so the same token could be sent somewhere else entirely with no
cross-server trick at all: the token really did belong to that server, and only the address moved.

The second is why the first was not enough on its own. A credential now has to belong to the server
it is attached to, and a server that already holds one cannot be re-added at a different address.
Correcting a title or retrying an interrupted add sends the same URL and is unaffected. A server
holding no credential can still be re-addressed, because there is nothing to misdirect. Moving a
server that does hold one means removing it and adding it again with the token the new address is
meant to have, which is the honest description of what has happened anyway.

This matters more than "an administrator could misconfigure something". A stored credential cannot
be read back by anybody, by design: the credentials screen answers that a credential exists and
never what it is. These two shapes were the way around that, so a deployment where somebody has
used them should treat the credentials involved as disclosed and rotate them.

A token also stops outliving the server it was minted for. Re-adding a server without naming a
credential used to clear the pointer while leaving the credential live, and removing a server retires
its token by reading it off that pointer, so a cleared one meant the token survived its server and
could be attached to a freshly created one at any address, where there was no longer a stored address
to compare against. Three ordinary acts in a row and the binding above stopped meaning anything. The
pointer now survives a re-add that names none, removal therefore finds and retires it, and a retired
credential is refused rather than quietly attached to fail on its next call.

Curated servers keep working as they did. Their URL comes from the catalogue rather than the
request, and a per-instance hostname is matched against the vendor's own anchored pattern before
anything is stored, so re-adding one cannot point it at an address of the caller's choosing.

### A configured egress proxy reaches the browser that uses it

`EGRESS_PROXY_DEFAULT` and `EGRESS_PROXY_<BOT>` were documented as the way to give a Bot a stable
outbound address, and Compose passed neither to anything. `docker-compose.yml` named no egress
variable and had no `env_file`, so the shared computer resolved every Bot to no proxy and went out
directly, and under the supervisor the same emptiness meant there was nothing to forward into the
computers it creates.

The failure was silent, which for a setting whose purpose is to give a security team a per-Bot
address for network rules is the worst of the available failures. The stack started, the browser
left by the host, and the Computers screen reported "Leaves directly" because it was reading the
same empty environment.

They now live in `egress.env`, which both the computer and the supervisor are given. A file rather
than more `environment:` entries because `EGRESS_PROXY_<BOT>` is derived from a Bot's id and there
is no fixed set of names to list; a file of its own rather than `.env` because that one holds the
deployment's secrets and the container running a browser and a Bot's shell is deliberately not
given them. It is optional, so a deployment with no proxy is unchanged, and gitignored, because a
proxy URL can carry a password.

**Move these two out of `.env` and into `egress.env`.** In `.env` they reach no process.

### Screens without a conversation stop polling for a Bot that does not exist

Every surface asks which components its Bot holds, and asks again every few seconds so a revoked
grant leaves an open conversation quickly. The Bot it asked about was whichever one the surface
declared — and on a screen with no conversation at all, that was the placeholder id the routing
holder falls back to, which no package registers and the server answers 404 for. An admin page left
open polled a guaranteed miss every five seconds, indefinitely.

Nothing looked wrong. The screen rendered, because an absent grant list and an empty one draw the
same. The cost was the noise: a request log where the same 404 repeats forever is one where the 404
that matters is invisible.

The grant queries now wait for a surface to declare a real Bot, and simply do not run while the
placeholder holds. Conversation surfaces — the Bot page, channels — declare one and are unchanged.

### A rule can be tested against history before it is saved

A boundary was written blind: an administrator typed a CEL rule, saved it, and learned what it
actually matches from the refusals it produced in production. The trail already records every judged
computer action with the same facts the gateway judged it on, so the question "what would this rule
have done" had an answer nobody could ask.

The Boundaries page now has **Test first** beside **Add rule**. The candidate — the current policy
plus the drafted rule — is replayed over recent recorded actions, and the reply names each one it
would have decided differently and the rule that would have decided it. Nothing is saved and nothing
is decided; no audit row is written, because no action was permitted or refused.

Replay, not simulation: the context is rebuilt from the audit row exactly as the gateway built it at
decision time, through the same helpers, so a rule behaves here as it will behave live. The scan is
bounded and biased to recency, and the reply says how many rows it covered.

### A browser refusal names the element again

Every browser context carries a neutral all-empty `mcp` object, so a rule naming `mcp.effect`
evaluates to false instead of throwing. The refusal copy keyed on that object being present rather
than on its contents, so every live browser refusal took the tool-call branch and read
":  on  is blocked" — two empty strings where the element and the page belonged. The tests passed,
because their contexts omitted the field the gateway always attaches.

The branch now keys on the server and tool being named, which a real tool call always has. A refused
click reads "“Submit order” on shop.example is blocked by the rule ..." again, which is what the Bot
relays to the person asking.

### Knowledge searches instead of guessing

A package can say which of its skills each coworker gets, and the fintech example gives Knowledge the
four document skills it ships.

Knowledge is one of three coworkers in the box, described as answering company questions and citing
sources. The skills that would let it do that were seeded attached to nobody, so every clone started
with them paired to no Bot: the per-run narrowing that skills exist for was switched off until
somebody opened the Skills page and made the pairing by hand, in each deployment, again after each
new connector. The pairing belongs with the package, which wrote both files and knows which coworker
it meant them for.

THIS GRANTS NOTHING, which is what makes it safe to seed. A skill is an instruction; what a Bot may
call is its grants, and the offer each run is the intersection of the two. A skill naming a tool its
Bot does not hold loads nothing. Seeding an MCP grant would be the opposite, because those reach a
person's own account, so those stay an administrator's decision and are untouched here.

A redeploy takes back only what the package gave. Grants it made carry `tenant-package`, and a grant
an administrator made through the Skills page keeps their name and survives, because a deploy quietly
undoing a deliberate decision is the kind of change nobody traces back to the deploy that caused it.
A coworker naming a skill its package does not ship is refused at load rather than dropped, the same
as a channel naming an agent that is not there: a typo that silently attaches nothing looks exactly
like working.

### A Bot's computer is no longer on the same network as the database

Compose declared no networks, so every service shared one and reached the others by service name.
One of those services is the container a Bot's shell runs in, and another is PostgreSQL, whose
username and password are in the same file. A shell reaches whatever its container reaches, so a Bot
could open `postgres:5432` and authenticate: the audit trail, the policy store and the agent tables,
from the one container whose job is to run what a Bot asks for. The role Compose creates is the
instance owner, so the trail's append-only trigger was no defence either, being something its owner
can drop.

PostgreSQL and `migrate`, the only service that reaches it by name, are now on a `data` network of
their own. Everything else stays where it was. Nothing changes for a deployment that runs the API
server on the host, which reaches the database through the published port and never used the shared
network for it. **A deployment that runs the server inside Compose has to join that service to both
networks**, which is the one place the two are meant to meet.

The published port is now on loopback, as every other port in that file already was. Taking the
database off the Bots' network removes the name, not the address: a container's default gateway is
the host, and a port published on every interface answers there. From inside the computer container,
the gateway on `5432` accepted a connection and began authenticating as `openbot` on `openbot`, with
the password in the same file. **A deployment that reached the database from another machine over
this port has to reach it another way**, which is what publishing it on every interface was doing.

This does not reach back in time. A deployment that has been running with the two on one network
should assume a Bot could have read or written the database, and look at the trail with that in
mind.

### A credential in an MCP server address is refused in the query and the fragment too

Refusing `https://user:token@vendor.example/mcp` closed the userinfo spelling of a credential in the
address and left the two obvious ones open. `?token=`, `?api_key=` and their neighbours were still
accepted, and the address is stored and named in the trail exactly as given: audit redaction keys on
the field name, `url` is not a sensitive one, so the secret was written to `mcp_servers` and to an
append-only audit row in clear text. That is the same disclosure the userinfo rule exists to prevent,
one character away.

A parameter whose name reads as a credential is now refused, in the query string and in the fragment,
and the refusal points at the token field without repeating what was typed. The name is read rather
than matched against a list, so `?auth_token=`, `?x-api-key=` and `?X-Amz-Signature=` are refused
alongside `?token=`: a rule that only catches the spellings somebody thought of reads as a guard
while behaving like a gap. The test is on the parameter name rather than on the presence of a query,
because vendors route and version with parameters and a floor that refused every one of them would
be one an operator works around instead of with. `https://mcp.example.com/mcp?workspace=acme&version=2`
is unaffected, and so is an ordinary fragment. A credential written into the *path* is still
accepted: it is indistinguishable from a route, and at least one hosted provider addresses servers
that way. **A deployment where somebody has put a credential in an address should treat it as
disclosed and rotate it**, for the same reason as before: the audit row cannot be deleted.

`metadata.goog` is refused too. It is Google's own short name for the metadata server, published
beside `metadata.google.internal`, and it carries a dot and none of the suffixes this check lists, so
it read as an ordinary vendor name. The long spelling was only ever refused incidentally, by the
`.internal` rule. Both are now named, so the address this check was written for is refused on purpose
rather than by luck.

### A curated MCP server is pointed at its own kind of credential too

Adding a server by URL was made to check which credential it is being pointed at. Adding one from the
catalogue, the other half of the same screen, took the same field from the same request and stored it
unread, so a credential of any kind could be attached to a curated server and spent by the refresh
that runs before the add returns.

Worth being plain about the reach, because it is narrower than the path beside it. The column is a
foreign key, so an id naming nothing was already refused by the database, and the one entry in the
catalogue is reached with each person's own Google account, whose OAuth client is registered through
its own call and sent to an address pinned in code. Nothing could be delivered to an address a caller
chose. What was reachable was a credential of the wrong kind being accepted and spent on behalf of
somebody who never agreed to it, and a malformed id arriving as a database error rather than as a
refusal.

The rule now comes from the entry: a server the deployment holds one token for takes that token, and
a server answered as the person asking takes no credential when it is added, because its client
arrives through the call that mints it. Both add paths ask the same question in the same words, so a
credential that does not exist and one of the wrong kind are still refused identically and the
endpoint cannot be used to ask which ids are real. Adding a curated server the way the admin screen
does is unchanged.

Adding a curated server that is already there no longer clears the credential it points at. The
column holds the OAuth client that registering one put there, and re-adding the server to change an
instance host said nothing about that client, but cleared it anyway: the credential row was left
behind with nothing pointing at it and nothing to revoke it, and everybody who had connected their
account was told the deployment has no client registered. A re-add that names no credential now
leaves the one that is there alone.

### Name the private addresses an agent may live at

Refusing `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` in production closed a hole and took something with
it: bring your own agent is a headline capability, a company's own agent legitimately lives at an
internal address, and the only way to reach one was to lift the floor for everything. Telling people
to set that flag is exactly the advice that made it dangerous.

`AGENT_ENDPOINT_ALLOWED_HOSTS` names addresses instead. A comma-separated list of hosts, each
optionally with a port: `agents.internal` covers any port on that host, `10.0.0.42:9000` pins that
one. A deployment sets this and leaves the floor where it is.

It is narrow on purpose:

- **Agent endpoints only.** Browsing is not widened. A page can steer a Bot somewhere; an operator
  naming an address they run is a different act from a Bot following a link to it.
- **Exact matching.** No wildcards and no suffixes. A list written with a `*`, or written as URLs, is
  refused at startup with the entry named, rather than quietly never matching.
- **The never-allowed addresses stay never-allowed.** Cloud metadata is refused before the private
  rule is reached, so naming it changes nothing.
- **Every hop, not just the first.** A named address is reachable wherever it appears and an unnamed
  one is refused wherever it appears, so a redirect is not a way around registration.

Unset means none, which is what every deployment has today.

### A custom MCP server can only be pointed at its own token

Adding an MCP server by URL takes a credential id alongside the address, and the add is what spends
it: the tool refresh that runs before the call returns decrypts whatever that id names and sends it
to the address in the same request. Nothing checked which credential it was, so an administrator
could name any row in the vault, including one person's connector token, and have that person's
token delivered in clear text to an address of the administrator's choosing, before any Bot or grant
was involved. The credentials screen lists every row's id and, for a connector token, the person it
belongs to, so choosing one was a single read.

A custom server now has to be pointed at a credential of its own kind, the deployment's token for
that server. A person's connector token and the deployment's OAuth client are both refused, for the
same reason `POST /api/admin/credentials` already refuses to create either by hand: spending one
here uses a credential on behalf of somebody who never agreed to it. A credential that does not
exist is refused in the same words as one of the wrong kind, so the endpoint cannot be used to ask
which ids are real.

The field is unchanged for the case it exists for, and nothing changes for a server added through
the admin screen, which mints a token and points at the one it just made. If a deployment has a
custom server pointing at a credential of another kind, adding it again will now be refused, and the
answer is to give the server its own token.

### A failed action is recorded the same way it was decided

An action the policy allowed and the computer then failed is recorded twice, once for the decision
and once for the outcome, so the trail can tell an action that happened from one that was permitted
and did not. The second row was leaving out the command and the key that the first one carried.

A shell command that failed part-way therefore said a Bot had run something without saying what, in
the row somebody reading an incident reaches for first. The same omission picked the wrong element
branch, so that row also claimed the command had been looked for in the page snapshot and not found
— a page element a shell call never had. A failed file write kept its path throughout and is
unchanged.

Both rows now carry the same subject. Nothing about the boundary moves: the policy decided on a
complete context before and after, and no action is permitted that was not permitted before.

### Upgrading

**A deployment that sets `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` with `NODE_ENV=production` no
longer starts.** Remove the line and it starts again. Nothing else needs changing, and a deployment
that never set it is unaffected.

The switch lets a Bot reach addresses inside the deployment's own network — `10.0.0.5`,
`192.168.1.1`, `127.0.0.1:5432`, a link-local address — and it does that in two places, not one:
browsing, and the endpoint a Bot may be registered against. It exists for a laptop, where the
services a Bot is asked to look at are the ones running beside it.

The reason this is a refusal rather than a warning is how a deployment came to have it. `.env.example`
shipped the line on, and copying that file is the ordinary way an environment gets filled in, so the
path to a hosted deployment reaching its own network was not forgetting to set something, it was
inheriting something. It now ships commented out, which means a laptop that wants the old behaviour
uncomments it and everything else arrives without it. Under any other `NODE_ENV` the switch works
exactly as before, with a warning at boot saying it does not travel.

**The one-container image shipped with the switch on, and no longer does.** It set both
`AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` and `NODE_ENV=production`, so the image really did run
with private-host browsing enabled. Two things that worked there stop: a Bot browsing a private
address such as an intranet page, and registering a coworker at a private endpoint like
`http://10.0.0.20:8000/ag-ui`. Because the image bakes in `NODE_ENV=production`, there is no
override — a deployment that needs either of those wants the compose setup or its own image rather
than the all-in-one. The image continues to start, and everything else in it is unchanged.

The cloud metadata addresses — `169.254.169.254`, `metadata.google.internal`, and the IPv6 and
NAT64 spellings of them — were refused whatever this switch said, before and after. That floor has
not moved. What changed is that it is no longer the only thing left standing in a production
deployment that copied the example.

### The supervisor answers on loopback, not on every address the host has

The supervisor's port was published without an interface in front of it, so it bound every address
the machine had and answered anything that could route to it. This is the service that holds the
Docker socket, so reaching it is root on the host by way of four verbs, and `SUPERVISOR_TOKEN` is a
shared secret rather than a network boundary. The documentation already said not to expose it
outside the deployment network; the compose file did.

It is now published on `127.0.0.1`, like the computer's own port and the two Bots'. If you reach the
supervisor from another machine, that stops working and it was the thing worth stopping: put the
caller on the host, or run the server inside the compose network, where it reaches the supervisor as
`supervisor:4300` and never uses the published mapping at all. `SUPERVISOR_PORT` still chooses the
host port.

Nothing changes for a default deployment. `scripts/start.sh` already reached it on `localhost`.

### An agent's address is checked where it ends up, not only where it starts

`checkAgentEndpoint` decides whether this deployment will dial an address, and the request was then
handed to a fetch that followed redirects. The checked address and the dialled address were the same
address only while nobody redirected. An agent answering `307 Location: http://169.254.169.254/` put
the server on its own cloud metadata endpoint, on every run rather than once.

Every hop is now checked before it is followed, capped at three. Redirects are still followed,
because a deployment that puts its agent behind one has done nothing wrong, and each destination has
to be somewhere registering it directly would have been allowed to reach. The stored address is
checked before it is dialled too, which is the one address a check reading only `Location` headers
never looked at.

A hop that leaves the host the request was authorised for arrives with nothing that proves who we
are. The customer's key was given to us for their host, and this deployment's signed run assertion
names the Bot and the person and can spend their grants, so both stop at that boundary and do not
come back if the chain returns. A scheme upgrade to the same host and port keeps them.

Refusals are now on the audit trail as `agent.dial_refused`, with the address and the reason. A
refused run already told the person what happened; nothing told the deployment, and an agent that
has quietly started redirecting somewhere it should not is worth being able to count.

### A connector says which of its granted tools it no longer offers

A grant names `serverId/toolName`, and a Bot is told about a tool only when the grant and the vendor's
current tool list agree — so a grant on a tool the vendor has stopped listing reaches no model. That
is a property of what the vendor advertises today rather than of the grant, and nothing said it was
happening: the plugins page built its grant list from the advertised tools, so such a grant appeared
nowhere at all. The one screen an administrator reads to answer "what may this Bot do" was quietly
leaving some of the answer out.

A connector's page now has a "Held but not offered" section listing them, with how many Bots hold
each, and a refresh that leaves any behind writes an audit row naming the refs and the Bots. The
grants themselves are untouched: a tool the vendor starts listing again is offered again, and revoking
stays a decision somebody makes rather than a side effect of a vendor's bad afternoon.

Nothing changes for a connector whose grants all match its tool list, which is the normal case — the
section is not drawn and no row is written.

### Opening a new chat no longer logs a server error

A thread id is minted before the thread exists — the platform creates it on the first run — so reading
history on a brand-new conversation asks about a thread nothing has heard of yet. The platform answered
404, the runtime reported that as `500 Failed to fetch thread messages`, and every new chat left one in
the log with a stack trace behind it. Nothing was visibly broken, because the browser only reads a
history it got a 200 for; what was missing was any way to tell a thread that does not exist yet from a
history store that is down.

A thread the platform does not have now reads as having no messages. A 404 and only a 404: a 500 stays
a 500, because an outage answered with an empty history would tell the browser the conversation is gone
and invite somebody to start it over.

### Reconnecting a live screen no longer stops the screen you just reconnected

A Bot's screen allows one viewer, and opening a second `/stream` replaces the first. The replaced
socket is left open, because it belongs to a client that may still be using it, so on an ordinary
reconnect, where the browser opens the new connection before dropping the old one, the old socket
closed after the new one was already casting. Closing it stopped the session's viewer without asking
whether the closing socket was the one casting, so it stopped the replacement.

Both halves were silent. The screen stopped updating, and anything typed afterwards was dropped
without a word, because the input path looks for a viewer before it looks for anything it can report.

A close now stops casting only when the socket closing is the one that was casting.

### A sidebar channel row can be pinned or deleted

Right-click on a channel in the sidebar and a menu opens with two entries: Pin channel and Delete
channel.

Pin is held per member rather than per channel, so pinning one holds it at the top of your own
roster — newest first among pinned channels — and leaves every other member's roster unaffected.

Delete is confirmed in a dialog first, and it is soft. The channel disappears from every member's
roster and from a direct fetch of it, while the row, its transcript, and its Intelligence thread all
survive. That disappearance is live, not just on next load: every member's open tabs drop the row as
the delete lands, and a tab parked on the channel itself is sent home. The deletion is audited as its
own `channel.deleted` row. A channel the deployment package defines is refused, with the reason
named. Recovery today is clearing `channels.deleted_at` in the database directly; there is no restore
control in the product.

The deployment gains two nullable columns, via migration `0016`.

### An MCP server address that points inside the deployment is refused in three more spellings

Adding an MCP server by URL is checked before the address is stored, because that form is otherwise a
way to point the deployment at its own network. The check compared the literal hostname, and three
spellings of an address it means to refuse were getting through.

A trailing dot is the root-anchored form of the same name and reaches the same place, but it changed
the string enough that every rule missed it, so `https://localhost./`, `https://printer.local./` and
`https://metadata.google.internal./` were all accepted. `kubernetes.default.svc`, which is how a
service is addressed from inside a cluster, carries dots and none of the listed suffixes, so it read
as an ordinary vendor name.

The third is worth acting on rather than just noting. A credential typed into the address itself,
`https://user:token@vendor.example/mcp`, was accepted, and the address is stored and named in the
trail as given. Audit redaction works on field names and `url` is not one of the sensitive ones, so
the token was written to `mcp_servers` and to an audit row in clear text. The trail is append-only by
design, so that row cannot be deleted afterwards: **a deployment where somebody has done this should
treat that credential as disclosed and rotate it.** The address field now refuses a credential and
points at the token field instead.

A deployment that reaches its MCP servers by ordinary vendor hostnames sees no difference.

### One unreadable turn no longer takes a whole conversation down

Restoring a thread cast whatever the history store held straight to messages and handed it to the
transcript. A turn stored in a different shape — a tool call written `{id, name, args}` rather than
AG-UI's `{id, type: "function", function: …}`, which interrupted runs have produced — reached a
renderer that read `toolCall.function.arguments` and threw, so a single bad turn made the whole
conversation unopenable rather than that one message unreadable.

Each stored turn is now parsed against the schema AG-UI ships, and one that does not parse is left
out instead of being drawn. Checked where history enters the app rather than in one renderer, so
every surface that reads a transcript is covered by the same check.

**A turn that is left out is said out loud.** The conversation shows a line above it naming how many
earlier messages could not be read, because a record people read back must not have a hole in it that
nothing accounts for — a turn that silently disappears reads as one that was never sent. Multimodal
content and every well-formed tool call are unaffected, and a history that cannot be read at all
still opens the composer rather than blocking it.

### Refreshing no longer flashes white before the theme arrives

A person with the dark theme selected saw a white frame on every reload. The stored preference was
read early enough, but it was applied one paint too late: the browser had already drawn a frame
against the light palette by the time the app got to it. The document now decides its theme before
anything is drawn.

The browser was also drawing its own surfaces — scrollbars, form controls, the overscroll area —
light under a dark app, for the whole session rather than for a frame. Both themes now declare which
one they are, so those match too.

No configuration changes and nothing is stored differently; a deployment that was already on the
light theme sees no difference at all.

### `start.sh` refuses a port that answers but is not OpenBot

The startup checks asked whether a port answered, and treated that as proof the port belonged to this
stack. Those are not the same claim. Any single-page app serves its index.html for every path it does
not recognise, so an unrelated dashboard on a default port answers `200` to `/api/capabilities` as
readily as this server does.

The cost was not a wrong answer, it was a wrong answer three stages later. `require_free_or_ours`
reported "already up", so the server was never started; `wait_for` then printed a green
"server ready"; and the run failed at stage 3 inside `json.loads`, parsing that stranger's HTML. The
error names `char 0`, which reads like an empty response rather than a `<`, so the visible symptom
pointed nowhere near the port.

Each surface is now asked for something only it can produce: a `licenseStatus` field for the server,
its own `<title>` for the app, `/health` for the compose services. When a check gives up it says
whether the process failed to start or the port belongs to something else.

The root cause was in `.env.example`, and is fixed there too. The server reads `PORT`, this script
reads `SERVER_PORT`, `docs/configuration.md` documents `SERVER_PORT` as the setting, and only `PORT`
shipped. Moving the server by editing that one line left the script still looking at 3001. Both names
are now present, next to each other, saying they have to agree.

**A run may now stop where it used to continue.** That is the point: it stops at the port that is
wrong, naming it, rather than several steps later on a parse error.

### `docker compose up -d` configures the same stack `scripts/start.sh` does

`SUPERVISOR_TOKEN` and `COMPUTER_TOKEN` defaulted to the empty string in `docker-compose.yml`, so
which stack you got depended on how you brought it up. `scripts/start.sh` resolves both to their
`openbot-dev-*` defaults and exports them before calling compose. A plain `docker compose up -d` —
which this project's own shutdown notes tell you to use — passed an empty string instead.

`agent-computer` refuses to start without one, so that half failed loudly. The supervisor half was
the quiet one: the server kept the token it started with while the supervisor held an empty string,
and every call between them was refused at the door.

Both now carry the same defaults `start.sh` applies, as `COMPUTER_IMAGE` already did two lines down.
A value set in `.env` still wins, and a deployment should set one.

## OpenBot 0.0.4
### A click citing a ref this deployment cannot resolve is refused

A Bot acts on a page by citing a ref from a snapshot, and the server turns that ref back into the
element before the boundary judges it. When the lookup failed, the action went ahead anyway with the
element half of the decision left empty — so a rule like "never click anything named submit" was not
declining to match, it was never shown the element, the shipped default permitted, and the click
landed on whatever that ref points at now.

The computer's own staleness check does not cover this. It compares a citation against its own
counter, so it catches the cases where the two disagree; the case that bites is the one where the
computer is content and only this deployment is out of step, which is what restarting a computer
under a stored snapshot leaves behind. The same click on the same button under the same policy was
refused before a redeploy and carried out after it.

A citation this server holds a snapshot for and cannot resolve is now refused, and the person is told
to take a fresh snapshot. Actions that name no element — scrolling, a page-level keypress, a shell
call, a file read — are untouched, and a computer this deployment holds no snapshot for still has its
citation forwarded, because there it is the only party that can answer. The refusal is raised after
the decision row is written, so an action somebody tried to take still appears on the trail.

**A deployment may see refusals it did not see before.** That is the point: those are the actions that
were being carried out without the boundary seeing what they touched. A Bot that meets one takes a
fresh snapshot and continues.

### A package ships its skills, so tool selection works on a clone

Tool selection narrows a Bot's tools to the ones its matching skills declare, and a deployment starts
with no skills at all. There was no `skills.yaml`, nothing seeded any, and nothing ever created one
— so on every fresh clone there was nothing to match against and the narrowing never switched on.
Left to a screen it would have stayed that way until somebody sat down and mapped tools to skills by
hand, in each deployment, again after each new connector.

A tenant package may now carry `skills.yaml`. Each skill has a slug, a title, a summary, its
instructions, and the `serverId/toolName` refs it needs. They are seeded on boot as deployment
skills, everybody sees them in the `/` menu, and connecting a connector is the only step left.

`skills.yaml` is optional, so every existing package loads unchanged and ships no skills. A package
may declare tools for a connector nobody has added: an unknown ref sits inert, because the offer is
still intersected with the Bot's grants. Naming a tool in a package grants nothing, exactly as
before.

A skill somebody wrote in the deployment keeps its name. If a package ships a slug a person already
took, theirs stands, the package loses that one, and the deployment starts — a name is not worth
refusing to boot over.

The example package ships four: `/find-a-document`, `/whats-changed`, `/who-owns-this` and
`/check-a-claim`.

### The tools a skill needs can be picked where the skill is written

A package's skills arrive with their tools declared. A skill somebody writes here could not: the
`tools` field existed on the save endpoint and on no screen, so a skill written in the product declared
nothing, and the only way to change that was to call the API by hand. Writing or editing a skill now
lists the tools of every connected server, grouped by server, with the ones that change something
marked.

Picking a tool here is not granting it. The offer is still intersected with what the Bot was granted,
so a skill naming a tool its Bot does not hold selects the skill and loads nothing — which is why
anybody may write a skill while connecting a server stays an administrator's decision. The screen says
so, next to the choice.

A tool the skill names that no connected server offers is shown too, under its own heading, rather
than left out. A package ships skills declaring tools for connectors nobody has added yet, and a
skill outlives the server it was written against, so a screen that drew only what matched was
stating part of the declaration as though it were all of it.

## OpenBot 0.0.3
### A Bot is offered the tools its message needs, not every tool it holds

A model chooses the right tool reliably out of about ten and unreliably out of thirty, and it fails
quietly: it calls a plausible neighbour, or calls nothing and answers from what it already knew. Two
connectors is enough to cross that line, so a Bot holding more than twelve tools is now offered, for
each run, the tools of the skills that match the message.

Skills already declare the tools they need. That declaration is now what the offer is built from:
the deployment asks its own model which skills a message needs, and the Bot gets those skills' tools
plus every granted tool no skill has claimed. Nothing here can widen a Bot: the offer is intersected
with the grants, so naming a tool in a skill still grants nobody anything.

Nothing changes for a deployment that has not declared tools on any skill, or whose Bots hold twelve
tools or fewer. Those Bots are built exactly as before, with no extra model call.

There is a new audit event, `mcp.tools_discovered`, written before the run. It says how many tools
were offered out of how many granted, and why: the skills chosen, or that nothing was declared, or
that the choice could not be made. It answers "why did it call that", and the harder question, "why
did it not call anything at all" — which until now left no trace.

### The intent router works again behind a gateway

`OPENAI_BASE_URL` is documented ending in `/v1`, and the router appended `/v1/chat/completions` to
it, so every call went to `/v1/v1/chat/completions` and 404'd. The router reads a failure as "not
sure" and falls back to the default coworker, so on any deployment that set the variable — a
gateway, a proxy, a self-hosted model, which is the only reason to set it — untagged messages
silently stopped being routed and nothing said why. The version segment is now added only when the
configured URL does not already carry one.

## OpenBot 0.0.2
### Upgrading

`AGENT_TOOL_TOKEN` is generated for you on a laptop. `scripts/start.sh` mints one and writes it to
`.env`, the way it already did for `MANAGED_AGENT_TOKEN`. Without it no Bot could call a tool back
through the deployment, which is the correct default for a deployment and made every MCP tool dead
on arrival on a fresh clone. A value already set is kept, and `.env.example` still ships it empty,
so a deployment not using `start.sh` is unchanged and still fails closed.

`start.sh` also stops skipping work for services that are already answering. A Bot container is now
handed to `docker compose` on every run and the server is restarted when this run minted a secret,
because answering says a process is alive and not that it still agrees with the deployment. The cost
is that a run which rebuilds an image recreates the Bot containers, about five seconds; `supervisor`
already behaved this way.

Two configurations now refuse to start:

- A provider configured with no `INITIAL_ADMIN_EMAILS`. Set it to at least one address.
- No provider at all and no `OPENBOT_SINGLE_USER=true`. Configure a provider, or set that to say you
  meant a deployment where every visitor is one administrator. This no longer depends on `NODE_ENV`,
  which is unset by default and so let exactly the dangerous case through. A deployment already
  running open needs the line added before it will start again.

Registering an OpenID Connect provider needs every host in its discovery document in
`TRUSTED_ORIGINS`, not only the issuer. Better Auth 1.7 checks each endpoint it finds, so a Google
issuer also needs `oauth2.googleapis.com` and `openidconnect.googleapis.com`. Registration is
refused with the untrusted host named.

A Bot id may now contain only letters, digits, hyphen and underscore, and must start with a letter or
digit. The same rule container and volume names have always followed. A deployment whose
`COMPUTER_BOT_ID` breaks it refuses to start and says so, rather than answering 400 to everything.

`AUDIT_RETENTION_DAYS` is new and unset, which keeps the audit trail forever, as before. Set it to a
whole number of days to have old rows removed.

The local document index and the old connector tables are dropped by migration. `documents`,
`chunks`, `document_acls` and the four connector-bookkeeping tables are removed and their rows go
with them; this cannot be rolled back. A deployment that had been syncing into the local index loses
that copy, which is the point: answering now goes through a live system's own search.

**An MCP server pointed at a credential that no longer exists loses the pointer.** `mcp_servers`
now names its credential with a real foreign key, where the column was `text` against a `uuid`
primary key with nothing checking it — so a deployment is allowed to be holding a pointer to a vault
row that was deleted underneath it, and the screens read as though the server were still configured.
The migration clears those before adding the key, because it cannot add it otherwise. If this
happens, that connector correctly reports having no credential and an administrator registers it
again; nothing else is affected, and a deployment with no such pointer sees nothing.

**The old Google Drive connector is gone, and it is not the new one renamed.** It configured a
service account with domain impersonation and had the worker sync documents into a local pgvector
index guarded by our own ACL rows, so every person got the same answer computed from what one
credential could see, and revoking somebody's access left a cached copy of their documents behind.
`/admin/connectors` and its two screens, the connector catalogue and admin service, the sync
persistence and the worker's connector runner have all been removed. A deployment that was syncing
this way stops syncing and should enable the new connector at `/admin/plugins/google-drive`, where
each person connects their own account.

`knowledge.yaml` is still parsed and still refused when malformed, because it is part of the
deployment-package contract. Its `sources:` are now read by nothing.
`MANAGED_AGENT_AG_UI_URL` is no longer required to start. The one-container image does not carry a
Bot, so requiring it registered the shipped Risk Analyst against a host that was not there and every
conversation with it failed. Leave it unset for that image. A laptop `scripts/start.sh` still points
it at `agent-langgraph`. A URL with no `MANAGED_AGENT_TOKEN` still refuses to start; a leftover
token with no URL is ignored.

A `.env` copied from an older `.env.example` still has `MANAGED_AGENT_AG_UI_URL=http://localhost:4201/ag-ui`.
Unset it before `docker run --env-file .env`, or the coworker comes back.
The built-in Bot refuses to start without `OPENAI_API_KEY`. It used to start, report healthy, and
then fail every conversation, so a missing key looked like a working deployment. The LangGraph Bot
already refused the same way.

Sessions survive and nobody signs in again.

### Changed

- **This deployment does not search documents itself.** A Bot answers from a live system by calling
  that system's own search as the person asking, so the vendor decides what they may see and there is
  no second copy of anybody's documents here to keep in step, to secure, or to leave behind when
  somebody is removed. The local index that was being filled — `documents`, `chunks` and
  `document_acls` — and the connector that filled it have both been dropped. Retrieval over
  a copy of a customer's corpus is not a thing OpenBot does.

### Added
- **A skill can say which tools it needs.** `POST /api/plugins/skills` takes a `tools` list of
  `serverId/toolName` references, stored against the skill and returned with it. This is the unit
  tool retrieval will select over: a model picks a skill from its summary, and the skill says
  what to load. **It grants nothing.** A skill naming a tool a Bot was never granted still cannot
  call it, which is what keeps writing a skill open to anybody rather than to administrators
  only. A reference naming no tool this deployment has seen is refused when the skill is saved,
  so a typo is an error where it was written. Leaving the field out of a save leaves whatever was
  declared before, so nothing that predates it clears a declaration; sending an empty list is how
  a skill stops asking. Nothing consumes these yet — selection is the next piece, and until it
  lands a deployment behaves exactly as before.
- **A message with no `@` goes to the coworker it is for.** Typing without naming anyone used to
  reach the default coworker; to get a specialist you had to `@` them. Now an untagged message is
  routed to the coworker whose purpose matches it, chosen against each coworker's own description by
  the deployment's own model, before the channel is pinned. It is named, not silent: the channel
  header is the coworker it went to, and a `channel.routed` row records the choice, the reason, and
  the candidates it chose between (never the message itself). `@` still wins as an explicit override
  and skips routing entirely. If the router is uncertain or unreachable, it falls back to the same
  default the composer always used, and says so, rather than misroute or drop.

- **A Bot can answer from Google Drive, as the person asking.** Ask a Bot a question whose answer is
  in a document and it answers from the live file rather than from an index, citing a link that opens
  it. A Bot granted these tools reads Drive on the asker's own grant, so two people asking the same
  question get the answers their own accounts can see, and neither sees the other's documents.
  Read-only: the scope requested is `drive.readonly`, so a write is refused by Google before this
  deployment has to. Nothing is cached — the refresh token is stored and an access token is minted
  per call, so revoking access at Google takes effect on the next one rather than when a cache
  expires.

  Setting it up takes two people and neither can do the other's half. An administrator registers a
  Google Cloud OAuth client and enables the connector at `/admin/plugins/google-drive`; each person
  then connects their own account, and there is deliberately no endpoint for an administrator to
  connect one on somebody's behalf. The redirect URI has to match what is registered character for
  character, and the connector page states the exact string to paste, because a mismatch fails at
  Google with a message that never mentions OpenBot. See
  [docs/plugins/google-drive.md](docs/plugins/google-drive.md) for the whole setup and for what each
  failure means.

  **Disconnecting is not built yet.** The account page says so and points at Google's own third-party
  access settings, which is what withdraws it today.
- **Each tool a connector offers has its own screen**, at `/admin/plugins/<connector>/tools/<tool>`,
  with a switch per Bot. The connector page previously drew a button per Bot inside every tool row,
  which is a control per Bot per tool stacked in one list, and grew without bound as Bots were added.
- **Connected accounts**, at `/settings/connected-accounts`. What a Bot may read as you, and the
  scope the vendor actually granted rather than the one that was asked for.
- **A tool result that found nothing says so.** An empty result used to reach the model as an empty
  string, which reads as "the tool had nothing to say" rather than "there is nothing there" — and a
  model closes that gap from memory, which for a knowledge connector is the failure worth preventing.
- **The shipped Knowledge Bot answers from the tools it has.** Its instructions in
  `examples/fintech` told it to say no source was connected, which was honest when none could be:
  the connector this replaces had been removed and nothing had taken its place. With a connector
  granted it became the opposite of honest — the Bot called a tool, was handed a file listing, and
  said it had no access anyway. It now reports what its tools return, says so plainly when it has no
  tool or a tool reports a problem, and does neither of the two things worth forbidding: answering
  from its own memory as though it came from a source, or claiming to lack access to something a tool
  has just returned. A deployment with its own tenant package is unaffected.
- **`mcp.call_failed`.** A call this deployment permitted and the vendor did not complete now leaves
  a row of its own, carrying the vendor's own sentence. `mcp.call_succeeded` was written before the
  network call rather than after, so a call that died at the vendor recorded success and the Admin
  page agreed with it.
- **Releases are cut by a workflow, not by hand.** `Create release PR` bumps the version and promotes
  `## Unreleased` to a numbered section; merging the pull request it opens is what publishes. Merging
  builds and pushes one image to `ghcr.io/copilotkit/openbot`, signs a build provenance attestation
  for its digest, tags the commit and creates the GitHub Release with `container-images.json` so a
  deployment can name an exact digest rather than a tag somebody could move. See
  [docs/releasing.md](docs/releasing.md).
- **CI now runs the thing it ships.** Two checks were added. `migrations` refuses a schema change
  with no migration written for it, and a snapshot that has drifted from the schema. `image` builds
  the container, boots it with embedded PostgreSQL, and fails if it does not answer or if a
  supervised service is respawning. A single `verify` check covers every job, so branch protection
  needs one entry. The same checks run again against the release commit when a release is published,
  so they gate the release rather than the proposal for one.
- **Sign in with Google, Microsoft or Okta.** Any one of them turns sign-in on; configure several
  and the sign-in screen offers each, on matching buttons carrying each provider's own mark.
  `INITIAL_ADMIN_EMAILS` says who is an administrator. It is required whenever a provider is
  configured, because nothing else grants the role, and it is now a floor rather than a one-off:
  an address it names is made an administrator at every sign-in, so adding somebody to the list
  works even after they have already signed in.
- **SAML and OpenID Connect, registered while running.** `/admin/identity-providers` takes the
  metadata a company's identity team supplies and registers their own IdP. Somebody then types their
  email address on the sign-in screen and the domain decides which provider they are sent to, so a
  company mid-merger can run two. Registering, changing or removing one is administrator-only, which
  the upstream plugin does not require: it guards those routes with a session, and anybody who could
  reach them could register a provider for a domain and mint themselves colleagues.
- **A People screen.** `/admin/people` lists everybody who has signed in, with the provider they came
  through and when they were last here, and lets an administrator promote, demote, or remove
  somebody. Removing ends the session they are using and stops the next sign-in, keyed on the
  address so signing in again through the provider does not quietly create a new account. Every
  change is on the audit trail. Somebody named in `INITIAL_ADMIN_EMAILS` cannot be demoted or
  removed here, and nobody can do either to themselves.
- **One container that runs the whole thing.** The root `Dockerfile` builds an image carrying the
  app, the API, a Bot computer, and optionally PostgreSQL, supervised together. Point `DATABASE_URL`
  at a database you already run and the built-in one never starts; leave it unset and the container
  is self-contained. See [docs/deployment.md](docs/deployment.md) for the measured minimum sizes and
  the platforms it has been run on.
- **Bots can run commands.** `computer_run_command` runs a command in the Bot's `/workspace`, so a
  Bot can install a tool, unpack what it downloaded, or run what it was asked to run instead of only
  driving a browser. Governed like every other action: the policy decides, the audit row is written
  first, and a rule can refuse a shell outright with `intent == "run_command"` or refuse particular
  commands. The command is recorded; its output is not.
- **The audit trail shows the command.** A command row names what ran, the way a file row names the
  path, rather than reporting an element it was never about.
- **`COMPUTER_SANDBOX=on`** turns on Chromium's own sandbox where the host permits user namespaces.
  Which way it went is printed at start-up either way.
- **New chat.** The direct Bot chat has a button that starts a fresh conversation, which it had no way
  to do before: the thread was minted once and remembered for that Bot forever, so the only way out
  of a conversation was to clear the browser's storage by hand.
- **You can watch what a Bot is doing, not only what it is looking at.** The screen answered half the
  question: a Bot spending two minutes in a terminal showed a blank browser and one grey line per
  command, with the output nowhere. A command line in the transcript now opens to show what it
  printed, its exit code, and whether it was cut short or stopped. Beside the screen there is an
  Activity tab carrying every command, file read, file write and listing as they happen, newest
  first, with a count on the tab so a Bot working away from the browser is visible without switching
  to it. A saved file shows its path and size, never its contents. This is a live view of the open
  conversation; the record is still the audit trail.
- **Sign-in is on the audit trail.** Rows for signing in, for being refused, and for the configured
  administrator list granting somebody the role. Two questions had no answer before: who granted
  themselves administrator by editing `INITIAL_ADMIN_EMAILS`, and whether somebody just removed had
  ever been here, since removing them deletes the sessions that were the only evidence. A trail that
  is unavailable never blocks a sign-in.

### Fixed
- **A ref could resolve against a page from a computer that no longer existed.** The generation a
  computer stamps on a snapshot is unique only within one run of it, so a replaced container counts
  from one again and a ref the model is still holding matches a row nothing has overwritten. The
  policy then decides on an element from a dead page, and the audit row names it. Wiping a computer
  cleared the row for that reason and was the only thing that did; replacing one whose image changed
  did not, and the server was never told. A snapshot now carries which run of the computer took it,
  refs from an earlier run resolve to nothing, and the first snapshot of a new run replaces the old
  row however low its generation.
- **A migration stamped in the future silently swallowed the next one.** Drizzle runs a migration only
  when its journal timestamp is later than the newest one the database has recorded, so a migration
  stamped ahead of real time raises that ceiling and every migration written after it is skipped
  until the clock catches up. `drizzle-kit migrate` reports success the whole time. One migration was
  hand-written a day into the future and did exactly that to the next one to arrive: the table was
  never created, and the only sign was an integration test failing on a relation that did not exist.
  The timestamps are corrected, an older inversion between two earlier migrations is corrected with
  them, and the journal is now checked by a test, because nothing else in the build would notice.
  **If you ran a build between these, your database has the wrong ceiling recorded and will skip the
  next migration.** Repair it with
  `update drizzle.__drizzle_migrations set created_at = 1787359000000 where created_at = 1787444747113;`
  or start from a fresh database, where migrations all run in one pass and ordering cannot bite.
- **Every Bot ran a model two generations old, and it was costing tool calls.** The example package
  shipped `gpt-4.1` as the default for every built-in Bot. Asked to open a page behind a sign-in,
  those Bots answered "would you like me to prompt you to sign in?" and called nothing, three times
  out of three, while the prompt forbids that sentence in as many words. On `gpt-5.6-terra` the same
  question produces the tool call first try, so the package now runs `gpt-5.6-terra`. It is a
  default, not a commitment: `model.yaml` still decides.

  The Bots that answer over AG-UI stay on `gpt-5.5`, each for its own measured reason. The framework
  Bot answers nothing at all on `gpt-5.6-*` through the Responses API — `RUN_STARTED`, then
  `RUN_FINISHED`, no text — and the hand-written one cannot use function tools on
  `/v1/chat/completions` with a 5.6 model unless reasoning is turned off, which is the wrong trade
  for a Bot whose job includes deciding when to ask a person for help. It refuses to start on such a
  model now rather than failing one silent tool call at a time. Where a 5.6 model is set deliberately,
  the Responses API is switched on for it automatically, because a deployment that set the model and
  did not know about that switch got a Bot which started, looked healthy, and failed on its first
  tool call.
- **A Bot browsed to a vendor this deployment already connects to.** A Bot holding no grants was told
  nothing about connectors at all, so it treated a connected vendor as an ordinary website: asked
  about Google Drive it opened `drive.google.com`, met a sign-in page, and asked the person to sign
  in to an account the deployment had already connected. Every Bot is now told which vendors exist
  here, held or not, and says plainly which one it has not been granted rather than reaching for the
  browser.
- **A conversation was destroyed by a declined take-the-wheel.** A Bot that asks for help with a
  sign-in and never gets it left a tool call nothing ever answered, and every later turn in that
  thread failed at the provider. This was fixed once for the framework Bot and not for the Bot in the
  box, which is the one behind the Browser Bot, so it went on happening where most people would meet
  it. Both now answer their own unanswered calls with the truth rather than a fake success.
- **A Bot refused because a person had the wheel was told its refs were stale.** The computer flags a
  takeover, the surface branches on that flag, and the flag did not survive the server, so a Bot was
  sent back round the same action against the person who had just taken the browser. Reported and
  fixed by @beardthelion.
- **A person could not take the wheel unless the Bot offered it.** The button appeared only after a
  Bot called for help, so the control a person needs depended on the Bot getting one instruction
  right, and when it did not there was nothing to press. It is there whenever the Bot is driving now.
  The Bot asking for help is still its own row, with its reason.
- **The first message of a new channel could be lost.** A new channel's thread does not exist until
  its first run, so the join that restores history had nothing to settle against; the message was sent
  anyway after a deadline, while that join was still in flight, and the join finishing replaced it
  with the thread's messages, which were none. The deadline now ends the join and waits for it, so
  nothing is left in flight to overwrite anything. The transcript also says it is loading rather than
  showing an empty conversation, and the thinking line is visible for the first time: a CSS rule
  blanked the colour a gradient was built from, so the glyphs were painted with nothing. Reported and
  fixed by @zopeVaibhav.
- **The in-memory snapshot store disagreed with the table.** The database only ever moves a snapshot
  forward; the in-memory one, which is what a test reaches for when it has no database, took whatever
  arrived last. A test could therefore prove a boundary property that is false in a deployment.
  Reported by @beardthelion, fixed by @NathanTarbert.
- **A computer that had opened nothing still reserved a browser-sized frame.** That put a placeholder
  the height of a browser window into the middle of a conversation, above an answer that never
  involved the browser.
- **A Bot named after a deployment route was served without its guard.** The computer router steps
  aside for `/policy` and `/fleet`, which are its own paths and not about a Bot, because Hono matches
  `/*` against zero segments and a single-segment path arrives as a Bot id. It stepped aside on the
  name alone, so it covered everything under those names too: `/policy/status` is `/:botId/status`
  with a Bot called `policy`, and for that whole subtree the access check was never called at all.
  The guard now steps aside only for the deployment path itself, and a Bot may no longer be named
  after one: a package declaring it is refused, and a deployment that already holds such a Bot
  refuses to start and names it rather than serving it. Reported and fixed by @beardthelion.
- **Upgrading never reached a Bot's computer.** A computer is a container the supervisor makes, and it
  was reused by name whatever image it was built from, so once a Bot had one, rebuilding the image
  moved the tag and the container went on running the old one indefinitely with nothing to say so.
  `docker compose down` does not touch these either, because compose did not make them, so even a
  full teardown left them behind. That is worse than stale code: the computer is the browser, the
  workspace and the confinement around both, so a fix to any of them silently did not apply. A
  computer built from a different image is now replaced on next use. Its profile and its workspace
  are volumes and are kept, so a Bot comes back on the new image still signed in to what it was
  signed in to, with its files where it left them.
- **The audit trail could be erased with one statement.** It is append-only because a database
  trigger refuses updates and deletes, and that trigger is row-level, so `TRUNCATE` never reached it:
  anything holding `DATABASE_URL` could empty the table and nothing raised. That is the case the
  guarantee exists for, since it is enforced in the database precisely because the application is not
  the only thing that reaches the table. A statement-level trigger now refuses a truncate, and it
  answers before the retention setting is read, so declaring a retention window no longer permits one
  either. Retention itself is unchanged: rows older than the window are still removed, and recent
  ones are still refused. The connection the application uses is the database owner in the shipped
  compose file, and an owner can still disable or drop a trigger; closing that needs a role with
  `INSERT` and `SELECT` only, which is a separate change. Reported by @beardthelion, who also named
  the failure mode of the obvious fix and saved it from shipping as one.
- **A declined take-the-wheel destroyed the conversation.** A Bot that asks for help with a sign-in
  and never gets it left an assistant message holding a tool call that nothing ever answered, and
  every later turn in that thread failed at the provider. Declining once meant nothing you typed
  afterwards got an answer, with no way back but a new chat. Unanswered calls are now answered when
  the history is rebuilt, with the truth rather than a fake success: no result came, the run has
  ended, carry on without it and say what could not be done.
- **The audit trail could not say why a conversation went where it did.** It recorded the router's
  choice and recorded nothing at all when a person named a coworker with `@`, which is
  indistinguishable from a row that failed to write. A mention is now recorded too, as the person's
  own choice, without asking the model a question they had already answered. The audit page names the
  coworker and separates the three cases: chosen by the person, matched by the router, or the default
  because nothing matched.
- **A Bot with half a connector sent people to a sign-in box.** Granted a vendor's search but not its
  read, it found the document, could not read it, and opened the vendor's website to try, where it
  met a sign-in wall and asked the person to take the wheel. They already had access; the missing
  thing was the Bot's grant, and nothing said so. A gap in what a Bot holds is now reported as a gap:
  it names the capability it would need and says an administrator can grant it on that connector.
- **Answers arrived with no sign of where they came from.** Asked a compliance question, a Bot
  replied with a filing obligation, a dollar threshold, a deadline and a retention period, and the
  audit trail for that turn held one row: the routing decision. A confident unsourced answer is
  indistinguishable from a confident wrong one. Every Bot is now told to cite what it read and to say
  plainly when an answer is from its own knowledge instead. It is told this by the deployment rather
  than per agent, so it cannot be missing from the next Bot somebody adds, and it is explicitly not
  an instruction to go hunting for a source.
- **A Bot browsed to a vendor it already had tools for.** Granted Google Drive, asked what was in a
  document, it opened `drive.google.com` in its own browser, met a sign-in page that browser can
  never satisfy, and asked the person to sign in to an account they had already connected. A tool
  array says a tool exists; it does not say the tool is the way to reach that system, and it was
  competing with a page of prose about the browser that mentions connectors nowhere. A Bot is now
  told which systems it holds tools for, generated from its grants and placed before that prose, so
  enabling a connector changes what the Bot is told on its next run.
- **A question went to a coworker that had no way to answer it.** Routing read the sentence somebody
  wrote about what a coworker is for, which is not the same as what it can reach, so a question about
  a Drive document went to the one whose description says "company knowledge" and which held no Drive
  grants. Candidates now carry the systems they hold tools for. Purpose still decides first: a
  specialist with no connectors is still right for a question about its specialism.
- **A deny rule about submitting a form was walked around by typing.** `computer_type` takes a
  `submit` flag that presses Enter once the text is in, and the policy never saw a key, so a rule
  refused at the button and at the keypress let the third route through. Both shipped copies of that
  rule name both tools now, the key reaches the policy, and the audit row carries it — without it a
  row said a field was filled in rather than that a form was sent.
- **A Bot refused at the door left no trace.** A callback that could not prove which Bot it was
  returned 401 and wrote nothing, so a Bot holding a token the deployment no longer accepted had
  every call refused, returned nothing to its own model, and the model told the person there were no
  results. A false negative delivered as an answer, with the audit trail agreeing nothing had
  happened. Recorded now as `mcp.callback_refused`, naming the tool and the reason but no Bot or
  actor, since both arrive in the credential that just failed to verify.
- **An unanswered request for the wheel followed a Bot around.** Control belongs to a Bot's computer
  rather than to a conversation, so a request nobody took sat there indefinitely and every later
  conversation with that Bot showed a live prompt for work it was not doing, captioned with a reason
  written for somebody else. An unanswered ask now stops being shown after ten minutes and its reason
  goes with it. A person actually holding the wheel is never timed out.
- **`/admin/computers` listed nothing, ever.** Admin addressed the fleet through a per-Bot route with
  a placeholder id, which stopped working when that route began checking whether the caller may act
  as the Bot in the path. The screen renders nothing while the list is null, so a deployment with two
  running computers looked like one with none. The fleet has a route of its own, still
  administrator-only.
- **Every shipped component was recorded twice on a first start.** Two browsers announcing at once is
  ordinary and the insert was already safe for it; the answer was not, so the loser of that race
  named every component anyway and the caller wrote an audit row per name.
- **A Bot could reach the deployment's own network by writing the address a different way.** The
  guard refused `169.254.169.254` and the private ranges as usually written, but not the same
  addresses spelled as an IPv6-mapped or NAT64 form, an integer, or with a trailing dot, so a Bot
  talked into fetching one still reached cloud metadata or an internal host. The address is
  canonicalised before it is checked now, the mapped form of `0.0.0.0` (which reaches every local
  port) is refused, and the container credential endpoints a hosted deployment must never expose —
  ECS and Fargate's `169.254.170.2`, Alibaba's `100.100.100.200` — are refused even when the
  private-host opt-in is on. The same guard backs agent registration, so it is closed there too.
- **The supervisor could adopt a container it did not create.** When starting a Bot's computer hit a
  name already taken, it started whatever held the name and handed it the deployment's computer
  token, so on a Docker host shared with anything else it could drive a stranger's container as a
  Bot's. It now refuses a container that does not carry its own namespace label, read from the
  container rather than inferred, so a second deployment on the same host is never adopted.
- **Removing somebody left the credentials they had granted this deployment sitting in the vault.**
  Removing them from the People screen ended their sessions and stopped the next sign-in, and left the
  refresh token behind, unrevoked. They could not use it — the account comes from a session they no
  longer get — but "we removed their access" was not true of the token, which for a connector read as
  the person asking is the part that matters. Removing somebody now retires it, and each retirement is
  on the audit trail as `mcp.account_disconnected`. Deleting a person's row used to be worse, because
  it took the connection record with it and left the credential reachable by nothing at all; those are
  found and retired too. This stops the deployment holding a usable secret. It does **not** withdraw
  the grant at the vendor, which needs revoking there until disconnect ships, and the audit row says
  which of the two happened rather than implying both.
- **The one-container image registered a coworker it could not run.** `MANAGED_AGENT_AG_UI_URL`
  defaulted to `localhost:4201` and was required, so Risk Analyst appeared on the roster and every
  conversation with it failed. The URL is optional; the package omits that coworker when it is
  unset. `scripts/start.sh` still points it at `agent-langgraph` on a laptop.
- **A boundary rule applied on one server out of N.** The policy is read from memory on every action,
  which is right, but memory was only ever filled at boot. An administrator's new deny rule was
  enforced by whichever process served the request and roughly one action in N went through it, while
  the admin screen reported success because the row really was saved and the audit trail agreed
  because it records the boundary each process started with. Both honest, and both describing
  something other than what the fleet was enforcing. A write now announces on Postgres in the same
  transaction and every server re-reads, including on reconnect, so a server that was down when the
  rule changed catches up rather than waiting for a restart. Reset travels the same way.
- **A ref resolved on one replica and nowhere else.** The gateway turns the opaque ref in a click into
  the element it points at, and that mapping lived in a `Map` in the process that took the snapshot.
  On any other replica the ref resolved to nothing, so a deny rule written about the element did not
  match and the click went through, recorded as allowed with no rule. It is in Postgres now, keyed on
  the generation the computer stamped, so a ref from a superseded page still resolves to nothing.
- **Anybody signed in could act as anybody's Bot.** The Bot id travels in the path and the acting
  routes checked only that somebody was signed in, so a signed-in person could drive another person's
  private Bot, reset its browser, read its screen and fire its granted tools. Every route under a Bot
  id now asks the store the same question the roster already asks, and a Bot that does not exist and
  one belonging to somebody else answer identically.
- **The computer fleet listing was open to any signed-in person.** It ignores its `:botId` and returns
  every Bot's machine, so it told anybody who could reach it every Bot id in the deployment and
  whether each was running, private coworkers included. Administrator-only now.
- **A Bot id could name a directory outside the profiles volume.** The id arrives as a URL segment or
  a header, was joined onto a filesystem path, and `reset` deletes that path recursively as root, so
  `../../tmp/something` deleted it. Refused at the request boundary and again where the path is built.
- **A mistyped deny rule permitted instead of refusing.** A rule that parsed and evaluated but
  answered with something other than true or false was neither a match nor an error, so
  `deny: ["Submit order"]` — what somebody writes who reads the list as labels — let the action
  through with nothing logged, while the rule sat on the Boundaries page looking as though it were in
  force. Any non-boolean answer is now a broken rule and takes the existing fail-closed path.
- **Rotating a Bot's key left the old one live.** Editing a key wrote a new vault row and repointed
  the Bot at it, leaving the previous credential decryptable and still valid with nothing listing it,
  so rotation did not do the one thing rotation is for. Deleting a Bot left its key live too. Both
  revoke now.
- **Nothing recorded what changed about a Bot.** Ten mutating routes wrote one audit row between them
  and there was no event type for any of the other nine. A Bot's endpoint is where conversation
  content is sent, so "who pointed this Bot at that host, and when" is the first question in an
  incident and could not be answered. Eight event types and eight rows now, recording what changed and
  never a value.
- **The people list and the channel list grew without bound.** Both were read in full on every render,
  and reading one person ran the whole people aggregate over the deployment twice per role change.
  Both are paged now, and the people screen searches on the server so somebody can be found without
  walking pages.
- **A computer accumulated one browser per Bot, forever.** `COMPUTER_MAX_BROWSERS` and
  `COMPUTER_BROWSER_IDLE_MS` set the two limits. Nothing closed an idle one, so a deployment
  where every employee has a Bot trends toward a resident Chromium per employee in one container until
  it is killed for memory. There is a cap and an idle timeout, and closing one costs only a relaunch
  because the profile is on disk.
- **The audit screen's filters were sequential scans.** It filters by event type, by who did it and by
  what it was done to, and the only index was on the timestamp, over what becomes the largest table in
  the deployment. Each filter leads its own index now.
- **A deployment with no identity provider came up open by default.** Covered under Changed above,
  and listed here too because it is the one on this list that was reachable from the internet.
- **Registering a company's identity provider was owned by whoever registered it.** Better Auth
  answers its own listing route with only the providers the person asking registered, and refuses a
  removal from anybody else, so a second administrator opened the Identity providers screen, found
  it empty, and registered one that already existed. Worse, the row cascaded from that person's user
  row: deleting the administrator who set sign-in up deleted the company's sign-in with them. What is
  registered is a fact about the deployment, so reads and removals go through OpenBot's own
  administrator-only routes against the whole table, and a provider outlives the person who added it.
- **A customer's client secret was in the clear.** The SSO plugin writes `oidc_config` and
  `saml_config` as plaintext JSON, with the OAuth client secret for that company's directory inside
  them: the one secret here not going through `KEY_ENCRYPTION_KEY`. Both are now encrypted at rest.
  Rows written before this still read, and are re-encrypted the next time they are written. OAuth
  access and refresh tokens use Better Auth's own encryption, keyed on `BETTER_AUTH_SECRET`.
- **A failed provider registration looked like a button that did not work.** The error was rendered
  on the page behind the dialog, which was covering it.
- **Deleting a component in the playground could release one the build ships.** `DELETE
  /api/sandboxed/:name` deleted from the shared components table by name, without checking
  which kind of component the name belonged to. Naming a compiled component removed its
  governance row, and the foreign keys took that component's per-Bot withholdings and its
  function grants with it. Withholding is the half that fails open: a published component is
  available to every Bot unless a row says otherwise, so the next catalogue announcement brought
  the component back published, and available to a Bot it had deliberately been kept from. The
  audit row called it `kind: "sandboxed"`. The endpoint now refuses a name this surface does not
  own and answers 404, the way publishing already did. A governance row whose source is already
  gone is still this surface's to clear.
- **A write could follow a symlink out of the Bot's workspace.** The confinement resolved the
  directory a write would land in but not the name it would land on, so a link left at `notes.txt`
  pointing outside was followed by the write; a read through the identical link was already refused.
  The gateway had already decided and written the audit row against the path as it was asked for, so a
  rule written for `credentials/` never saw the file that was written and the trail named a file
  nothing had touched. A dangling link escaped the same way, because resolving the path throws where
  the write would still land. Links pointing back inside the workspace continue to work.
- **A Bot could become root inside its container.** `sudo` was granted as `NOPASSWD: ALL`, and the
  comment above it named the two conditions that made that acceptable: the container being one Bot's
  alone, and not holding a database. The image meets neither, because the supervisor is deliberately
  not in it and `EMBEDDED_POSTGRES=on` is a documented way to run it. So root read another Bot's
  workspace, the API's environment, and the audit database recording what it did. The grant now names
  the package managers, so `apt-get install` still works and `sudo cat /proc/1/environ` does not. It
  is a floor rather than a boundary: code a model wrote needs a computer per Bot with
  `COMPUTER_SUPERVISOR_URL` and a sandbox under it with `COMPUTER_RUNTIME=runsc`, both of which this
  already supports and neither of which the single-container image can reach.
- **A command could take the computer down, or outlive being stopped.** Output was accumulated in
  full and only trimmed at the end, so `cat` of a large file allocated until the process that owns
  the browser died; it is now bounded as it arrives, and still reports that it was truncated rather
  than quietly ending. A stop signalled bash alone, so `sleep 30 | cat` left its children holding the
  pipes and the call never returned; the whole process group is signalled now. A `timeoutMs` of zero
  or less killed the command before it started and called it a timeout; it has a floor as well as a
  ceiling.
- **Stop did not reach a running command.** The `/exec` route never took the person's abort, so the
  plumbing for it was dead code and a stopped run left the command finishing inside the container.
- **The live-screen socket did not check the address it was given.** Every acting path resolved
  through the gateway, which refuses a foreign or cloud-metadata address; this one asked the provider
  directly and then put `COMPUTER_TOKEN` in the query string of whatever it was told.
- **`COMPUTER_SHELL_ENV` refuses the names that run before a command.** Naming `GITHUB_TOKEN` is an
  operator deciding a Bot may use a token. Naming `BASH_ENV`, `ENV`, `LD_PRELOAD` or the shell option
  variables is handing a Bot a hook into every later command, which is unlikely to be what was meant,
  so those are refused and said out loud rather than passed. A name that is not a variable name is
  now reported too, instead of quietly disappearing.
- **A deny rule naming one field refused every action that did not have it.** `deny:
  contains(command, "rm -rf")`, the example the documentation gives, refused every click, keypress,
  navigation and file read in the deployment. Two correct behaviours combined into a wrong one: the
  policy context left out fields an action did not have, cel-js treats a missing field as an unknown
  identifier and throws, and a thrown deny counts as a match so that a mistyped deny refuses rather
  than quietly permitting. Every field is now bound, with a neutral value where the action has
  nothing to put there, so a rule about a shell answers honestly about a click instead of refusing
  it. Rules about the action they are for are unchanged. The audit row still omits what did not
  happen.
- **A command longer than 45 seconds reported failure while it carried on running.** The transport
  gave every call the same deadline, which was shorter than the shell's own 120 second default and
  600 second maximum, so `apt-get install` told the person the computer had not responded and then
  finished installing inside the container. A command now gets a deadline that outlasts the shell,
  which reports a timeout itself and says so.

- **A Bot's shell no longer inherits the deployment's environment.** Commands ran with the computer
  process's own environment, so `env` in the one-container image printed `KEY_ENCRYPTION_KEY` and
  the rest of `.env`. The shell now receives PATH, locale and terminal names, and the proxy
  variables. Userinfo is stripped from a proxy URL, so a password in `HTTP_PROXY` is not in `env`.
  Anything else is named in `COMPUTER_SHELL_ENV`.
- **A deployment served over plain HTTP could not start a conversation.** The chat surface minted
  identifiers with `crypto.randomUUID`, which browsers withhold outside a secure context. On a
  laptop `http://localhost` counts as one, so this never showed up in development; on a real
  address it does not, and the surface did nothing at all when you pressed send. No message, no
  error. Ids now come from an API with no such restriction.
- **A Bot asked to be signed in, in words, and nothing happened.** Handing over the browser is a tool
  call, and a sentence in the transcript is not one: "please sign in and let me know" leaves the
  person with no wheel to take and the page where it was. Bots wrote that sentence anyway, and one
  went further and asked for a username and password to be typed into a sign-in page nobody could
  reach. The guidance now says that calling `computer_request_help` is what asking means, names the
  sentences that are not it, and says the person cannot see the page at all until control is handed
  over. Asked to file an issue on a site it was not signed in to, a Bot now offers the wheel on the
  first attempt instead of the third.
- **A package Bot did not know it had a computer.** The instructions that make the computer usable —
  snapshot before acting, and ask a person to take the wheel at a sign-in rather than reporting the
  task as impossible — were imported by the two shipped Bots and by nothing else, so a built-in agent
  knew only the role its package gave it. The tools were on offer to it the whole time. Asked to file
  an issue on a site it was not signed in to, it browsed to the page, said it could not, and never
  called `computer_request_help`, so nobody was ever offered the wheel. Built-in agents are now told
  the same thing the shipped Bots are told, wherever a computer is configured.
- **A chat could quietly forget everything and carry on.** The browser remembers a thread id for each
  Bot, and nothing ever asked whether Intelligence still had that thread. Where it did not, the
  transcript loaded empty, every later message silently recreated an empty thread under the same id,
  and the Bot answered as though the conversation were new — with the reason nowhere but the server
  log, as a 404 flattened into a 500 by the time it reached the browser. A remembered thread is now
  checked before it is used: one the platform provably does not have is replaced, because there is no
  conversation left to lose, and a check that fails for any other reason keeps the thread and says on
  screen that earlier messages could not be loaded. A person reading a confident answer can now tell
  whether the Bot has read what came before it.
- **The first browser action a Bot was ever asked for failed.** Creating a computer and starting it
  are two calls to Docker, and a name the daemon has not published yet answers the second with a 404.
  The supervisor treats that as a lost race and rebuilds, which is right, but it went straight back
  round: the retry landed a millisecond later, saw the same unpublished name, and spent the only
  other attempt on it. The whole request then failed as Docker being unreachable, the person was told
  the computer could not be started, and the next message worked. It waits one poll interval before
  rebuilding now, which is what the health wait already uses for the same question.
- **A framework Bot asked for a browser action and nothing happened.** `agent-langgraph` ends a run
  when the model calls a tool the surface owns, which is how a tool that lives in the browser is
  supposed to work: the run finishes, the surface acts, and the next run carries the result. But the
  call was only reported to the surface from the node that executes this deployment's own tools, and
  that node is exactly what an ending run skips. The person saw their own message, no answer under
  it, and no explanation, because a run that finishes carrying nothing is not an error. Every Bot
  action in the browser was affected: opening a page, filling a form, asking for help at a sign-in.

### Changed

- **A retention policy for the audit trail.** `AUDIT_RETENTION_DAYS` removes rows older than the
  window it names, swept hourly by whichever server holds an advisory lock. Unset by default, because
  deleting somebody's audit trail because a default said so is the worse of the two failures. The
  trail stays append-only: the database permits a delete only when the transaction declares a
  retention window and only for rows already outside it, so removing recent rows is still impossible
  and an `UPDATE` still is under every condition.
- **`allowed_groups` is documented as a declaration, not a control.** The tenant package writes it and
  nothing reads it on any access path, and `users.groups` is written by nothing either, so both halves
  of the rule are waiting on group membership arriving from the identity provider. Channel access is
  membership alone. The columns stay, because they are the right shape for the rule they are named
  for. Thanks to [@NathanTarbert](https://github.com/CopilotKit/OpenBot/pull/92) and
  [@andreolf](https://github.com/CopilotKit/OpenBot/issues/82).
- **Running with no sign-in takes a flag and nothing else.** It used to be locked with
  `NODE_ENV=production`, which is exactly backwards: `NODE_ENV` is unset unless somebody sets it, so
  a container on a VM with a hand-written env file and no identity provider served every visitor on
  the internet as an administrator, silently, because nothing looked wrong from the outside. A
  deployment with no provider now refuses to start unless `OPENBOT_SINGLE_USER=true` says it was
  meant. `.env.example` ships that line switched on, so a clone still runs with no configuration at
  all, and the line is greppable in a way a default never was. `OPENBOT_DEV_NO_AUTH` is still
  honoured.
- **Requires Better Auth 1.7**, which adds an `issuer` to every account. Migrations `0002` and `0003`
  add the column and backfill existing rows with their provider's real issuer, so nobody is asked to
  sign in again. The column stays nullable on purpose: a rolling deploy runs migrations and then
  serves from old and new replicas at once, and an old replica writes an account without it, so
  making it required in the same release would break the first sign-in of everybody who landed on a
  replica that had not been replaced yet. The constraint belongs to a later release.
- **Where a Bot's computer runs is now a plug.** One `ComputerProvider` interface sits under the
  gateway, with the Docker supervisor as one implementation and a shared computer as another. A
  computer somewhere else is an adapter rather than a change to the governed path. Thanks to
  [@mu-hashmi](https://github.com/CopilotKit/OpenBot/pull/57) for the refactor.
- The address a provider hands back is checked before anything is sent to it, and the cloud metadata
  addresses are refused whatever a provider says.
- The container image runs as an unprivileged user rather than root.

## OpenBot 0.0.1
First tag.
