# ChisaBot PC 节点（服务器端 + Windows 客户端）

> 2026-10-10，image `local/chisabot:glass-20261010m`，客户端 `chisabot-pc` 0.1.0。
> 目标：服务器、PC、手机任何一端都能管理其他端；PC 既是远程聊天客户端，也是让服务器上的机器人在授权范围内操作这台电脑的「节点」（参考 OpenClaw 的 node：节点出站连接网关、声明命令面、危险命令需显式开启与审批）。

## 1. 角色

| 端 | 是什么 | 能做什么 |
| --- | --- | --- |
| **服务器** | 现有 ChisaBot（`chisabot-zh` 容器，公网 `https://<你的域名>:8443`，前面是 nginx 登录网关） | 机器人运行处；设备登记表、WebSocket 中转、审批、审计都在这里 |
| **PC（Windows）** | `ChisaBot PC` Electron 客户端 | ① 聊天窗口直接载入该服务器的网页；② 节点：执行机器人发来的操作（PowerShell、文件、截图、鼠标键盘、打开网址 / 文件、剪贴板） |
| **手机** | 现有网页（已适配 390px） | 聊天；在 设置 → 设备 管理所有 PC：开关能力、审批、紧急停止、撤销、看记录 |

「从任何一端管理其他端」：设备配置只存服务器一份。网页/手机改 → 服务器写库 → 推送给 PC；PC 改 → 发 `set_config` → 服务器写库 → 网页 5 秒内刷新。PC 客户端里的聊天窗口就是网页本身，所以在 PC 上也能管理其他 PC 和服务器（管理后台）。

## 2. 连接方式（传输）

- **PC 只做出站连接**：`wss://<服务器>/api/devices/agent/ws`，走现有 HTTPS 443/8443，不需要在 PC 上开任何入站端口，也能穿过 NAT。
- 握手头：`X-Device-Token: cbd_…`（设备令牌）、`Origin: <服务器 origin>`（网关拒绝没有 Origin 的 WebSocket）。
- 断线自动重连：1s → 2s → … 封顶 30s，带 ±30% 抖动；服务器每 25s 发 `ping`，PC 回 `pong`。
- 同一设备重复连接时，旧连接被替换（关闭码 4000）。撤销时服务器发 `{"type":"revoked"}` 并以 4401 关闭，PC 停止重连。
- 网关：`/api/devices/agent/` 前缀在 nginx 里**不做会话校验**（PC 没有网关 Cookie），只靠设备令牌；其它 `/api/devices/*` 仍在网关登录之后。令牌失败按 IP 限速（10 分钟 20 次）。

### 2.1 协议（JSON 文本帧，类型见 `shared/devices.ts`）

服务器 → PC：`welcome{device}`、`config{device}`、`approval_request{id,operation,summary,botName,expiresAt}`、`approval_closed{id,decision}`、`call{id,operation,args,botName,timeoutMs}`、`cancel{id}`、`revoked`、`ping`。

PC → 服务器：`hello{clientVersion,platform,osVersion,hostname,arch}`、`result{id,ok,result|error}`、`approval{id,decision}`、`set_config{name?,capabilities?,allowedRoots?,paused?}`、`local_audit{…}`、`pong`。

## 3. 登录与配对

1. PC 首次运行出现本机登录页（`pc/src/ui/login.html`，不是服务器的网页）：**服务器地址**（保存在本机，带最近用过的下拉；通用版留空由用户填写，自建版构建时预填）+ **账号** + **密码** + **记住登录**。先探测 `/auth/session`（→ `/health` → `/api/version`），再直接 `POST /auth/login`（和网关网页表单同一个请求，带 `Origin`），会话 Cookie 写进主窗口会话；密码从不保存（记住登录 = 网关发 30 天 Cookie）。启动时会话有效就直接进入，主窗口被跳到 `/login` 时换回本机登录页。电脑名称默认取主机名，可在网页 偏好设置 → 设备 里改。
2. 客户端先 `POST /auth/login`（网关登录，`remember: true`）；该部署没有网关时退回 Better Auth `POST /api/auth/sign-in/email`。得到会话 Cookie。
3. 用会话 Cookie 调 `POST /api/devices/enroll` → 服务器生成设备 `dev_…` 和令牌 `cbd_<32 字节 base64url>`，**令牌只返回这一次**，库里只存 SHA-256。
4. 令牌在 PC 上用 Electron `safeStorage`（Windows DPAPI，绑定当前 Windows 用户）加密保存；会话 Cookie 注入聊天窗口的独立分区，聊天窗口因此免登录。
5. 密码不落盘。之后节点连接只用设备令牌；网关会话过期只影响聊天窗口（会跳到登录页），不影响节点。
6. **已登录却没登记时自动补登记**（PC 0.1.1 起，`pc/src/agent/enrollment.js`）：启动时网页会话还有效但本机没有设备令牌（重装、DPAPI 解不开、旧版配置），客户端用这份会话 Cookie 自动调 `POST /api/devices/enroll`，连不上就每分钟重试；以前这种情况会打开聊天窗口但节点永远不连。托盘「重新登记这台电脑」/ 网页设备页「登记这台电脑」（桥 `enroll()`）在令牌无效或被撤销时也能用：令牌仍有效就只重连，不重复登记；被撤销的电脑从网页发起要先在本机确认；自动路径从不替换已有令牌。
7. 换服务器 / 退出登录（托盘菜单「切换服务器…」「退出登录…」）：退出登录时调 `POST /auth/logout` 和 `POST /api/devices/agent/unenroll`，清除 Cookie，回到登录页（地址和账号保留）；切换服务器在新服务器登录成功后才作废旧服务器上的令牌。

## 4. 设备登记表（迁移 `0054_pc_devices`）

- `devices`：id、owner_user_id、name、platform、os_version、hostname、arch、client_version、token_hash、capabilities(jsonb)、allowed_roots(jsonb)、paused、revoked_at、last_seen_at、last_ip、created_at。
- `device_bot_access`：(device_id, bot_id)。没有行 = 该机器人看不到这台电脑。
- `device_audit_events`：每个远程操作、每次配置改动、登记/撤销/紧急停止。机器人调用**先写一行 `requested`，结束后改成最终结果**（成功 / 失败 / 已拒绝 / 用户拒绝 / 审批超时 / 离线 / 超时）+ 耗时，进程崩溃也留下痕迹。登记、修改、撤销、删除另记一条到系统审计（`configuration.changed`，targetType `device`），管理后台 → 审计 可见。

## 5. 能力模型

| 能力 | 操作 | 默认 | 风险 |
| --- | --- | --- | --- |
| （始终可用） | `system_info` 系统版本、主机名、CPU、内存、屏幕 | — | 低 |
| `shell` 命令行 | PowerShell（`-EncodedCommand`，UTF-8 输出），超时默认 60s 最长 600s，stdout/stderr 各 64KB 上限，超时杀进程树 | 询问 | 高 |
| `files_read` 读取文件 | 列目录（≤500 项）、读文件（默认 256KB，最多 1MB，二进制返回 base64） | 询问 | 中 |
| `files_write` 写入文件 | 覆盖前备份为 `*.chisabot-bak`，可追加 | 询问 | 高 |
| `screenshot` 截图 | Electron `desktopCapturer` 主屏，物理分辨率截取后缩放到 ≤1600 宽；无 Electron 时 PowerShell `CopyFromScreen` 兜底 | 询问 | 中 |
| `input` 鼠标键盘 | `SetCursorPos` / `mouse_event`（DPI aware，物理像素坐标）、`SendKeys` 输入文字和按键 | 询问 | 高 |
| `open` 打开网址 / 文件 | 只做安全的打开（CB-030，2026-10-15）：http/https 网址用默认浏览器；允许的文件夹里**已存在**的文件 / 文件夹用默认程序（Electron `shell.openPath`，无界面节点 Windows `Invoke-Item -LiteralPath`、Linux `xdg-open`、macOS `open --`）。不启动程序（光写 `notepad` 不行）、不带参数、不打开可执行文件和脚本（.exe .bat .cmd .ps1 .vbs .js .msi .lnk .scr .hta .jar .reg .url .sh .app .desktop … 以及 Linux / macOS 上有执行位的文件，按解析符号链接后的真实路径再查一次）、不打开别的协议（`file:` `javascript:` `ms-settings:` …）和网络路径（`\\服务器\共享`）。服务器 `checkOpenTarget`（shared/devices.ts）发出前先拦，PC `open-target.js` 同一套规则再拦一次。要运行程序用命令行能力 | 询问 | 高（仍按高风险，本机确认） |
| `clipboard` 剪贴板 | 读 / 写文字 | 询问 | 中 |

**默认「询问」（2026-10-14，0.1.7）**：新登记的电脑七项能力都是「询问」——机器人直接调用，PC 弹窗和网页 / 手机的「等待你审批」卡片谁先点算谁，2 分钟无人处理按拒绝；高风险项（命令行、写文件、鼠标键盘）在「允许」时也照样本机确认。以前默认全部「关闭」，用户不进权限页手动打开就什么都做不了。旧设备迁移：服务器启动时（`deviceStore.adoptAskDefaults`，幂等，`CHISABOT_DEVICE_ASK_DEFAULTS=0` 关掉）把能力仍是出厂「全部关闭」、并且审计里没有 `config_changed` / `kill_switch_*`（= 没人改过）的电脑改成「询问」，写审计 `defaults_ask`。默认文件夹：PC 0.1.7 的 `hello.suggestedRoots`（桌面、文档、下载），服务器只在文件夹列表为空且没人改过时采用（审计 `defaults_roots`）。手机绑定的设备仍是「关闭」（不是节点）。

每项三态：**关闭 / 询问（每次审批）/ 允许（直接执行，仍审计）**。文件类能力还受**允许的文件夹**约束：相对路径相对第一个文件夹；解析符号链接后比较前缀（Windows 不区分大小写），防止 `..` 和链接逃逸；没有文件夹时一律拒绝。

**允许的文件夹之外的路径（0.1.12，2026-10-16）**：以前机器人要列 / 读允许的文件夹之外的地方（例如 `C:\AI`），审批卡只写「列出：C:\AI」，用户批准后 PC 还是回「路径不在允许的文件夹内」——白批一次，机器人也说不清为什么。现在服务器（`server/src/devices/roots.ts`，按设备平台用 `path.win32` / `path.posix`，Windows 不区分大小写、`\` `/` 都认）在发出调用前判断：文件类操作（列目录、读、写、改、搜索、上传、下载，git / 补丁的 `cwd`）给的绝对路径不在任何允许的文件夹里 → **照样审批**（能力是「允许」、审批偏好是「直接做」也要问），卡片 / PC 弹窗写「C:\AI 不在允许的文件夹里；批准后会把它加入允许的文件夹」（盘符根写「整个 C:\」）；批准后先把文件夹（文件就是它所在的文件夹）加进设备的允许列表（审计 `roots_added`，上限 20 个）、推 `config` 给 PC，再在同一条连接上发调用，所以 PC 先拿到新列表。拒绝 / 超时什么都不加。能力「关闭」照旧直接拒绝，完全访问不查文件夹。相对路径、`device_run_shell` 不受影响。PC 端 `resolveInRoots` 照旧用真实路径再查一遍；它的报错现在列出允许的文件夹。

机器人工具（`server/src/devices/tools.ts`）：`device_list`、`device_system_info`、`device_run_shell`、`device_list_files`、`device_read_file`、`device_write_file`、`device_screenshot`、`device_input`、`device_open`、`device_clipboard`。**设备属于账号，不属于某个机器人**（2026-10-12 起）：这次运行的人名下的每台在线设备，他的任何机器人都能用；只有别人发布的团队机器人（`agent_profiles` 的主人是另一个人）拿不到。至少一台在线时才给操作类工具；某能力在所有在线设备上都关闭时对应工具不出现。**有关联设备但都离线时只给只读的 `device_list`**，并且不论在线与否，机器人提示词里都有一段「用户的电脑」说明（`deviceGuidance`，挂在 `device_list` 的 `guidance` 上、放在计算机提示词之后）：在线 → 如实说能用、能力没开就让用户去 设置 → 设备 → 权限；离线 → 说已关联但没连上、最后在线多久前、请打开 ChisaBot PC（2026-10-13：以前离线或能力全关时机器人只会说「我只有隔离的浏览器」）。安全边界不变：每台设备的能力默认全关、允许的文件夹、审批、紧急停止、审计都在 hub 里逐台生效。`deviceId` 可以是设备 id、设备名称或主机名；只有一台在线时可以省略，多台在线时必须指定（`resolveDevice`）。旧的 `device_bot_access` 表和 `botIds` 字段保留但不再参与授权（便于回滚）。上游桌面宿主的文件夹授权（host_* 工具）同样改为按人共用：发给桌面的操作仍带授权时的机器人 id（桌面端按它校验），真正发起的机器人在审批与审计里。截图原图留在服务器内存 30 分钟，工具返回 `/api/devices/<id>/screenshots/<sid>`，机器人可以在回复里用 Markdown 展示。

## 6. 安全

三道闸，任何一道说不就不执行：

1. **服务器**（`hub.invoke`）：已撤销 → 拒绝；紧急停止 → 拒绝；能力关闭 → 拒绝；离线 → 拒绝；「询问」→ 先建审批（PC 弹窗 + 网页/手机「等待你审批」卡片，谁先点算谁，2 分钟无人处理按拒绝），批准后再读一次最新配置。
2. **PC 本机**（`agent/core.js`）：本机紧急停止、本机那份能力开关（从服务器同步）再检查一次；**「高风险操作始终在本机确认」默认开启**——命令行、写入文件、鼠标键盘即使服务器设为「允许」也在 PC 上弹窗确认（服务器被攻破也不能静默操作这台电脑）。
3. **路径 / 进程约束**：允许的文件夹、输出上限、超时、取消即杀进程树。

紧急停止（kill switch）：PC 托盘菜单「紧急停止」、PC 设置页、网页设备详情都能按；立即取消进行中的调用和审批，之后一切远程操作被拒绝，直到在任一端解除。撤销：令牌作废并断开，PC 必须重新登录。

审计：服务器 `device_audit_events`（网页「操作记录」）+ PC 本机 `audit.jsonl`（PC 设置页「本机记录」，最多 2000 条）。

## 7. 网页（设计见 DESIGN.md §16）

- **设置 → 设备**（`/settings/devices`，模板 B；机器人「⋯ → 电脑操作…」弹窗和机器人资料页也列出同一批设备并链接到这里）：待审批卡片 → 设备列表（名称、系统与版本、客户端版本、在线 / 最后在线、关联时间、已开能力小标签、最近使用的机器人；右侧 ⋯ = 查看详情 / 能力与权限 / 重命名… / 撤销关联… / 删除…）→ 已撤销 → 添加一台电脑（下载卡片 + 三步说明 + 一键复制服务器地址）。
- **设备详情**（`/settings/devices/$deviceId`，模板 C）：72px 设备图标页头 + 徽标 + 「测试连接」「紧急停止 / 解除」；标签 权限（能力三态分段、允许的文件夹、谁可以使用 = 你的所有机器人 + 最近使用、名称，改动后出现未保存栏）/ 操作记录 / 设备（ID、关联时间、客户端版本、最近使用的机器人、危险区：撤销、删除）。
- **管理后台 → 设备（PC）**（`/admin/devices`，模板 E）：统计磁贴（设备 / 在线 / 待审批 / 紧急停止中）+ 全部设备（含所有者）。
- 下载：网关托管 `https://<你的域名>:8443/downloads/pc/`（需登录），清单 `latest.json`，设备页自动显示版本、大小、SHA-256。

## 8. Windows 客户端（`pc/`，2026-10-11 起）

- 技术栈：Electron 44 + `ws`；无原生模块（输入/截图兜底都走 PowerShell），所以能在 Linux 上交叉打包。安装包用 electron-builder（NSIS，中文界面，可选安装目录，桌面 / 开始菜单快捷方式）+ 免安装 zip；只保留 zh-CN / en-US 两个 Chromium 语言包；exe 图标和版本信息（ChisaBot PC / ChisaBot / `pc/package.json` 的版本号）在打包时写入，未签名。

### 8.1 界面：和网页是同一个应用

- **主窗口 = 网页本身**：载入该服务器的 ChisaBot 网页（会话 Cookie 已注入独立分区），聊天、偏好设置、管理后台、Skyglass 布局、深色模式、时间天空与浏览器里完全一致，网页更新后 PC 自动跟着变，不需要重新发客户端。关闭即缩到托盘。
- **本机设置 = 网页的 偏好设置 → 设备 → 这台电脑**：在 PC 客户端里打开自己这台电脑的设备页时，页头多一个「这台电脑」徽标，标签多一个「本机」（节点连接、本机紧急停止、高风险操作始终在本机确认、开机自启、启动时隐藏到托盘、设备令牌是否加密、退出登录 / 换服务器）；「允许的文件夹」多一个「选择文件夹…」（系统文件夹选择器）；设备列表里自己那行带「这台电脑」。原来单独的本地「设置与权限」窗口已删除。托盘「这台电脑的权限…」「本机设置…」直接打开这两个网页位置。
- **原生只剩网页做不到的窗口**：登录页（模板 F 登录卡片样式，PC / Android 共用）、审批弹窗（右下角置顶）、本机确认窗（放松安全时）、离线页（主窗口载不出网页时；能按紧急停止，15 秒自动重试，恢复后回到原页面）、托盘菜单（系统菜单）。这几个窗口用 `pc/src/ui/skyglass-tokens.css` + `sky.js`——由 `pc/scripts/sync-skyglass.mjs` 从 `app/src/styles.css` 与 `app/src/lib/sky.ts` **逐字生成**（令牌、天空、星星、深色值），组件（按钮 40/32/48 药丸、输入框、玻璃卡片、徽标、异步按钮状态机）按网页同尺寸重写。深色 / 浅色和「背景随时间变化」跟随主窗口里网页的设置（网页切换后立即同步到原生窗口；没打开过网页时跟随系统）。

### 8.2 网页本机桥（`window.chisabotPC`）

- 由主窗口的 `web-preload.js` 注入，条件：页面 origin 等于已登录的服务器、顶层框架（iframe、同源弹窗都拿不到）。主进程对每次调用再核对：发送者是主窗口、顶层框架、URL 属于服务器 origin；本机页面的通道（`window.chisa`）只认 `src/ui/` 下的本机文件页面，两套通道互不相通。
- 接口：`state()`（不含令牌和账号）、`setLocal({localPaused, forceLocalApproval, autoStart, startHidden})`、`pickFolders()`（只返回用户在系统对话框里选的路径，网页再走服务器 API 保存）、`logout()`、`onChange()`。
- **收紧立即生效，放松要本机确认**：开启紧急停止 / 开启本机确认立即生效；解除紧急停止、关闭「高风险操作始终在本机确认」、退出登录都会弹出本机确认窗（本机文件页面、独立窗口，网页脚本看不到也点不到），取消则什么都不改。网页详情页的「紧急停止 / 解除」在这台电脑上先走本机桥再同步服务器。注意：按 §6 的设计，紧急停止仍可从任一端（网页 / 手机）解除；「高风险操作始终在本机确认」才是服务器无法改动的本机闸门。

### 8.3 其它

- 托盘：蓝（在线）/ 灰（离线，自动重连中）/ 红（紧急停止）；菜单：状态、打开 ChisaBot、这台电脑的权限…、本机设置…、紧急停止 / 解除…、退出。
- 审批倒数：服务器在 `approval_request` 里附带按服务器时钟算的 `remainingMs`，PC 用单调时钟倒数（PC 时钟不准也不会一弹出就「0 秒」）；网页卡片同理，本机算出的剩余时间不合理时按总时长重新倒数，到点显示「即将自动拒绝」。
- 开机自启：`app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] })`，静默进托盘并连接。
- 无界面节点：`node src/cli.js login|run|logout --server … --token-file …`，用于测试或在没有桌面的机器上跑。
- 发布：服务器 `/opt/chisabot-pc-build/build.sh`（`electronuserland/builder:wine` 容器里跑 electron-builder，NSIS 需要 x86 makensis + wine）→ `publish-pc.sh` 复制到网关 `/downloads/pc/` 并写 `latest.json`（版本、大小、SHA-256）；设备页下载卡片读它。

## 9. 已知限制 / 下一步

- 截图只截主屏；多屏、录屏、摄像头未做。浏览器自动化（CDP 控制本机 Chrome）未做——服务器端机器人已有自己的「计算机」浏览器。
- 机器人目前拿到的是截图地址，模型本身看不到图片内容（需要把截图作为图像内容块注入模型上下文，属于运行时改造，2026-10-11 评估后暂缓：各模型平台的工具结果图像格式不同，风险不低）。
- 客户端只在 Linux 版 Electron（同一份代码，Xvfb）里端到端跑过，没有在真实 Windows 上跑过：DPAPI、托盘、PowerShell 操作、截图、鼠标键盘、NSIS 安装 / 卸载、开机自启、SmartScreen 提示都待真机验证。
- 安装包未签名（Windows SmartScreen 会提示「未知发布者」）；无自动更新。
- 网页的审批是轮询（5 秒），不是推送；审批也还没并入 `/approvals` 审批页。
- 网关之外的部署（Better Auth 多用户）登录路径已实现但没有实际测过。

## 10. 手机扫码绑定（2026-10-13，界面见 DESIGN.md §33）

安卓 App 不输入地址和密码也能登录：网页上生成一次性二维码，手机扫码后成为账号下的一台设备（`platform = android`），并拿到登录网关的会话。

**流程**
1. 网页「设置 → 设备 → 绑定手机」→ `POST /api/devices/pairing`（需登录）签发绑定码 `cbp_<32 位 base64url>`（192 bit，只存 SHA-256，5 分钟有效，一次性，每人最多 3 个未用码，放在服务进程内存里；重启后旧码失效，网页自动换新码）。二维码内容 `chisabot://pair?server=<网页的 https 源>&code=<绑定码>`（`shared/devices.ts` 的 `pairingUri`）。网页每 2 秒 `GET /api/devices/pairing/:id` 看状态（pending / bound / expired / cancelled，只有签发人能看），关窗 `DELETE` 作废。
2. 手机 `POST /api/devices/agent/pair {code, name, model, osVersion, clientVersion}`（公开路径，和 PC 节点同一个 Nginx 例外 `location ^~ /api/devices/agent/`）→ 码立即作废 → 在**签发人**名下登记一台安卓设备 → 返回一次性明文设备令牌 `cbd_…`（和 PC 同一张表、同一种令牌）。失败按 IP 计数（与设备令牌共用：10 分钟 20 次失败），另外每 IP 10 分钟最多 30 次尝试。
3. 手机 `POST /auth/device-session`（登录网关，带 `Origin` 和 `X-Device-Token`）→ 网关把令牌交给应用 `POST /api/devices/agent/session`（只认未撤销的手机设备，顺便记最后在线）→ 签发 30 天网关会话，会话行记下 `device_id`。之后 App 和浏览器一样带 Cookie 打开网页，直接进入主机器人。会话过期时 App 用设备令牌静默续期。
4. 撤销 / 删除：网关每 30 秒左右（有请求时）问一次应用 `GET /api/devices/agent/state/:id`，答 `active:false` 就删除这台手机的所有会话，下一次请求 401，App 回到登录页并提示已撤销；续期也会被拒。应用暂时连不上时最多沿用上次结果 10 分钟。App 里「退出登录」会先 `POST /api/devices/agent/unenroll` 作废自己的令牌。

**边界**
- `state` 只回答直连应用的请求：经过公网 Nginx 的请求都带 `X-Forwarded-For`，一律 404；网关在本机直连 `127.0.0.1:3001`（`CHISABOT_AUTH_APP_URL` 可改，必须是直连）。反向代理必须设置 `X-Forwarded-For`（模板里已设置）。
- 手机设备不是机器人可操作的节点：不进 `device_*` 工具和「用户的电脑」提示（`forOwner` 排除 `android` / `ios`），不能连 `/api/devices/agent/ws`（403），能力保持全关。
- 绑定码只换得到签发人自己的设备和会话；网关会话和密码登录是同一种（单用户网关部署下就是这个账号）。
- 只支持本仓库的登录网关部署（`deploy/public/`）。不经网关、用 Better Auth 多用户登录的部署还没有手机会话（App 会提示改用账号密码，`/auth/device-session` 不存在时）。
- 升级已有部署：更新应用镜像，再把 `deploy/public/auth/server.ts` 复制到网关目录并重启 `chisabot-web-auth`（会话库原地加两列，已有登录不受影响）；Nginx 需要有 `/api/devices/agent/` 例外（新模板已带；以前手工加过 PC 节点例外的部署不用改）。

## 11. 网络：系统代理与重连（0.1.6）

- 聊天窗口是 Chromium，自动用系统代理；设备节点（`ws`）和登记 / 校验令牌请求跑在 Node 里。0.1.6 起它们也走
  同一条路：`session.resolveProxy(url)` 问出 Chromium 的代理（PAC / 系统代理 / 命令行），`src/agent/proxy.js`
  按列表依次尝试（HTTP / HTTPS 代理用 CONNECT，SOCKS5 无认证 CONNECT，`DIRECT` 直连），全部失败才报错。
  只有 `DIRECT` 时与以前完全一样。
- 重连：指数退避 1–30 秒；70 秒收不到服务器任何消息（服务器每 25 秒 ping）判定连接已死并重连；休眠唤醒、
  解锁屏幕、聊天网页从服务器加载成功时 `reconnectNow()` 跳过退避立刻重连。
- 离线时托盘 / 网页设备页显示真实原因（例如「服务器返回 403」「代理拒绝了连接」）和线路（`networkRoute`）；
  设备页「这台电脑」的「重新连接」调 `pc:reconnect`。

## 12. 编码工具（0.1.8，2026-10-15）

让云端的机器人像本机的编码智能体一样改用户设备上的代码：先搜、再按行读、精确改、跑测试、看 diff。实现在 `pc/src/agent/code-ops.js`（PC 客户端和服务器节点共用）+ `pc/src/agent/textdiff.js`（无依赖的 Myers 行差异 / unified diff 解析与应用，和 `git apply` 互通），服务器工具在 `server/src/devices/tools.ts`。

| 机器人工具 | 节点操作 | 能力 | 说明 |
| --- | --- | --- | --- |
| `device_search` | `search` | 读取文件 | 类似 ripgrep：`pattern`（正则，`literal` 按字面）+ `glob`（`*.ts`、`src/**/*.py`、`*.{js,jsx}`），返回 文件:行号:内容（可带上下文）；默认跳过 node_modules / .git / dist 等和二进制、>4MB 文件；最多 1000 条、5 万个文件、60 秒 |
| `device_read_file`（带 `startLine`/`endLine`） | `read_range` | 读取文件 | 流式按行读，带行号「N│」，一次最多 2000 行，返回 `totalLines` / `more` |
| `device_edit_file` | `edit_file` | 写入文件 | 一处或多处 `oldText → newText`：必须逐字一致且唯一（出现多次时报出行号，`replaceAll` 全部替换），任何一处失败整个不改；保留 CRLF；备份（git 仓库里的文件在 `.git/chisabot-backups/<相对路径>`，不会出现在 `git status` 里；其它地方是旁边的 `*.chisabot-bak`）；返回 unified diff 和 +/- 行数；`dryRun` 只看 diff |
| `device_apply_patch` | `apply_patch` | 写入文件 | unified diff（多文件、`/dev/null` 新建 / 删除、改名）；先全部校验再统一写盘；允许行号偏移，空白不同再宽松匹配一次 |
| `device_git` | `git` | 只读子命令（status / diff / log / show / branch 列表 / remote -v / blame / ls-files / stash list）= 读取文件；其余 = 命令行 | 不经过 shell，参数逐个传；禁止 `--output` `--exec` `--upload-pack` `-c` 等会执行或写任意文件的参数；`GIT_TERMINAL_PROMPT=0`；**push 每次都要人批准**（能力是「允许」也问，完全访问除外） |
| `device_run_shell`（`background: true`）/ `device_shell_output` / `device_shell_kill` | `exec_start` / `exec_poll` / `exec_list` / `exec_kill` | 命令行 | 后台命令：立刻返回 `jobId` 和开头输出（最多等 `waitMs`），之后按字节偏移 `since` 取新输出（可等最多 25 秒），每个任务保留最后 2MB；默认最长 2 小时，同时最多 20 个，结束 1 小时后清理；紧急停止 / 撤销时全部结束 |
| `device_run_shell`（`session`） | `shell` | 命令行 | 持久会话：同名会话里 `cd`、`export` / `$env:` 留到下一条命令（每条命令结束时把 `pwd` 和环境写回会话） |
| `device_processes` | `process_list` / `process_kill` | 命令行 | 进程列表（按 CPU 排序、可过滤）、按 pid 结束 |
| `device_upload` / `device_download` | `file_upload` / `file_download` | 写入 / 读取文件 | 机器人云端工作区 ↔ 设备，3MB 一块、最大 200MB，上传完校验 sha256，覆盖前备份 |

- 命令行：Windows = PowerShell；Linux / macOS = `$SHELL`（bash / zsh）→ bash → sh。前台输出各 64KB，超长时保留开头 30% 和结尾（编译 / 测试的结论通常在最后）。
- 审批卡片带改动：`edit_file`（每处 old → new）、`apply_patch`（补丁本身）、`write_file`（新内容开头）的 diff 同时出现在网页「等待你审批」和 PC 弹窗里，加行绿、删行红。审计行的 detail 里记下实际 diff 的开头（≤900 字符），设备页「运行中 → 最近的改动」可以展开看。
- 旧客户端：`hello.features` 是客户端支持的操作名单（0.1.8 起）。没有它的客户端只支持最初的 10 个操作，服务器对新操作直接回「请更新到 0.1.8」，不会发过去。
- 机器人提示词（`deviceGuidance`）：先 device_search 找、device_read_file 按行读需要的部分（不把大文件整个贴进聊天）、device_edit_file / device_apply_patch 改、device_run_shell 跑测试（长的用 background），回复里只放相关的 diff 片段和测试结果；用户要求或明显期望时才 commit，push 只在用户要求时做。

## 13. 完全访问（0.1.8，2026-10-15）

用户要「像本机装了 OpenClaw / Hermes 一样」：一台设备可以打开「完全访问」。

- **只有设备主人在网页上能打开**：`PATCH /api/devices/:id {fullAccess: "1h" | "24h" | "permanent" | "off"}`（管理员也不能替别人打开；手机不行；紧急停止中要先解除）。机器人没有任何工具能改设备配置。PC 本机（`set_config.fullAccess = "off"`）只能关，不能开。
- **PC / 节点本机再同意一次**：配置下发后，PC 客户端弹本机确认窗（网页脚本点不到）；服务器节点按安装时的选择（`--no-full-access` = 永远拒绝，配置里 `allowFullAccess:false`）。拒绝时节点立刻发 `fullAccess: "off"` 把它关回去，并记审计 `full_access_declined`。
- **开着时**：服务器和节点都把所有能力当「允许」（不审批、跳过「高风险操作始终在本机确认」）；文件操作不限「允许的文件夹」（整台电脑、所有盘，相对路径相对第一个允许的文件夹或主目录）；前台命令最长 24 小时，后台命令默认不限时；`elevated: true` 可用——Windows 第一次弹一次 UAC 启动管理员助手（`powershell -Verb RunAs`，同一台电脑上的临时目录 + 随机密钥交换命令，父进程退出 / 空闲 30 分钟 / 关闭完全访问 / 紧急停止时退出），Linux / macOS 要节点本身是 root 或有免密 sudo（`sudo -n` 先探测，不行就说明原因）。
- **到期**：存 `devices.full_access_until`（开机 `ALTER TABLE … ADD COLUMN IF NOT EXISTS`，可空，旧镜像忽略它，所以回滚安全）。永久 = `9999-12-31`。服务器到点写审计 `full_access_expired` 并重推配置；节点按服务器给的剩余毫秒数自己也倒数（不信本机时钟），到点结束后台命令和管理员助手。
- **仍然有的**：每个操作照常写审计（detail 里标「完全访问」）；紧急停止（网页设备页、PC 托盘、手机网页）立即取消进行中的操作、结束后台命令，并**同时关闭完全访问**（解除紧急停止不会自动恢复）；撤销同样。PC 托盘在完全访问时多「关闭完全访问」，状态写「在线 · 完全访问」。

## 14. 服务器节点 chisabot-node（0.1.8，2026-10-15）

Linux / macOS（也能在 Windows 上跑）的无界面节点，和 PC 客户端同一套 agent 代码、同一个协议，命令行用 bash / zsh，没有截图 / 鼠标键盘（有 X 显示和 xdotool 时才有）。

- **安装**：设置 → 设备 → 添加一台服务器 →「生成安装命令」（一次性安装码 `cbp_…`，30 分钟、用一次，`POST /api/devices/pairing {kind:"node"}`）→ 在服务器上运行
  `curl -fsSL https://<服务器>/api/devices/agent/node/install.sh | sh -s -- --server https://<服务器> --code cbp_… [--no-full-access] [--name 名称] [--no-service]`。
  脚本：找 Node.js ≥18，没有就从 nodejs.org（`NODE_MIRROR` 可换镜像）下载 v22 二进制到节点目录并校验 sha256 → 下载 `chisabot-node.cjs` → `pair`（`POST /api/devices/agent/pair`，安装码换设备令牌，令牌写 `config.json` 权限 600）→ `install-service`。
- **目录**：root = `/opt/chisabot-node` + 系统服务 `chisabot-node.service`（systemd）/ `/Library/LaunchDaemons/cn.ayase.chisabot.node.plist`；普通用户 = `~/.chisabot-node` + `systemctl --user`（尝试 `loginctl enable-linger`）/ `~/Library/LaunchAgents`。没有 systemd 时打印手动运行命令。
- **运行**：`Restart=on-failure`，断线 1–30 秒指数退避重连，70 秒没消息判定断线；被网页撤销时退出码 0（不再被拉起）。命令：`pair | run | install-service | uninstall-service | status | logout`。
- **程序从哪来**：`pc/src/headless.js` 在网页构建时由 Vite 插件 `chisabotNodeBundle`（app/vite.config.ts）用 esbuild 打成单文件 `dist/node-agent/chisabot-node.cjs`（含 ws，约 250KB），服务器在 `GET /api/devices/agent/node/chisabot-node.cjs` 原样提供；`install.sh` 由 `server/src/devices/node-install.ts` 生成。两个地址都在网关的 `/api/devices/agent/` 例外里（不需要会话），只是公开代码，配对靠安装码。客户端版本写作 `0.1.8-node`，网页据此把它归为「服务器」（服务器图标）。
- **安全**：和 PC 一样默认全部「询问」（审批在网页 / 手机上点）；没有本机弹窗，所以「高风险操作始终在本机确认」不适用；完全访问见 §13。
