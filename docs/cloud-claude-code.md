# 云端 Claude Code（云端工作区 + Claude Code + 电脑同步）

> 2026-10-15。决定见 [ADR-0014](adr/0014-cloud-claude-code.md)；界面见 DESIGN.md §73；backlog CB-061…CB-065。
> 本文是设计稿 v2 的公开版（去掉了部署者自己的服务器细节）。每个阶段上线时更新下面的「实现状态」。

## 实现状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 文档：本文、ADR-0014、BACKLOG CB-061…CB-065 | 已合并 |
| P1 | 云端节点容器（`deploy/cloud-node/`）+ 设置 → 云端工作区 → Claude 登录 | 已上线（真实登录要用户自己点一次） |
| P2 | 左栏切换「机器人｜Claude Code」、「草稿」工作区、会话、对话、审批、右栏 / 手机抽屉 | 已上线 |
| P3 | GitHub 工作区：克隆、每会话 worktree + `cc/…` 分支、合入工作目录、推送并开 PR | 已完成（真实 GitHub 要用户先在 设置 → 账号连接 连 GitHub） |
| P4a | 电脑文件夹同步·服务器 / 节点 / 同步边车 / 隧道（绑定、租约、一次性隧道票、`cloudnode-sync`、自编译 MIT 版 `mutagen-agent`） | 已完成（Linux 替身 e2e 走通；电脑端随 P4b） |
| P4b | 电脑文件夹同步·PC 客户端（同步管理、「电脑上的文件夹」新建、同步面板、冲突对话框、交接 ①–⑤、Git 走隧道）+ PC 新版 0.1.11 | 已完成（Linux 电脑替身 e2e 走通；真实 Windows 未验证，见 CB-017） |
| P5 | ChisaCloudCode 留还是下线（单独决定） | 未开始 |

## 实现（以代码为准）

| 部分 | 代码 |
|---|---|
| 节点容器 | `deploy/cloud-node/`（Dockerfile、compose.yaml、entrypoint.sh、firewall.sh、README.md） |
| 节点运行时 | `pc/src/cloud-cc/`：`index.js`（登录、每一轮、快照、目录 / 文件 / diff / 撤销）、`git.js`（P3：克隆、会话工作树、合入、推送、相对 main）、`policy.js`（PreToolUse 规则）、`stream.js`（stream-json 解析）、`hook.js`（`chisabot-node cc-hook`）；`pc/src/headless.js` 在 `CHISABOT_CLOUD_WORKSPACE=1` 时接上 |
| 服务器 | `server/src/cloud-cc/service.ts`（设备 hub 扩展排在本地 agent 前面；`/api/cloud-workspace/*`、`/api/claude-code/*`） |
| 共享类型 | `shared/cloud-cc.ts` |
| 网页 | 设置 → 云端工作区 `app/src/routes/_authed/settings/cloud-workspace.tsx`；Claude Code 视图 `app/src/routes/_authed/_app/cc/`、`app/src/components/cloud-cc/`；`app/src/lib/cloud-cc.ts` |
| 测试 | `pc/test/cloud-cc.check.js`（模拟 CLI `tests/cloud-cc/mock-claude.cjs`：登录、两轮接着上次、审批、拒绝推送、停止、撤销）；`pc/test/cloud-cc-git.check.js`（模拟 GitHub `tests/cloud-cc/mock-github.cjs`：git http-backend + Basic 令牌，克隆 / 合入 / 冲突 / 推送 / 令牌不落盘） |

**设备连接上的消息**（同一条 WSS；旧客户端不认识就忽略）

- 服务器 → 节点：`cc_probe`（连上时问一次）、`cc_rpc{id, op, args}`（`status` / `login_start` / `login_code` / `login_cancel` / `logout` / `session_init` / `tree` / `read` / `diff` / `undo` / `running`；P3：`ws_clone` / `ws_merge` / `ws_push_preview` / `ws_push` / `ws_base_diff` / `ws_delete` / `ws_drop_tree`，`tree` / `read` 多了 `ref: "work"`）、`cc_turn{sessionId, turnId, workspaceId, prompt, claudeSessionId, resume, model, effort, rules, git?: {branch}}`、`cc_stop{sessionId}`、`cc_approval_result{approvalId, decision, always}`。
- 节点 → 服务器：`cc_info{claudeVersion, root, running}`（服务器据此登记云端工作区）、`cc_rpc_result{id, ok, result | error}`、`cc_event{sessionId, turnId, seq, event}`、`cc_approval_request{…, tool, summary, input, rule}`、`cc_done{ok, stopped, error, claudeSessionId, resumable, costUsd, turns, changes}`。

**一轮**：节点在 `projects/<工作区>/trees/<会话>` 里跑 `claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode default --settings <钩子> [--session-id U | --resume U] [--model] [--effort]`，提示词走标准输入；会话 id 由服务器生成（第一轮 `--session-id`，之后 `--resume`，「新的 Claude 会话」换一个）。每一轮前后用独立的 `GIT_DIR`（`.chisabot/snap/<会话>.git`）拍快照，diff 进改动卡和右栏，「撤销最后一轮」恢复到这一轮之前（之后目录又被改过就拒绝）。

**权限**（`policy.js`）：会话目录里的 Read / Grep / Glob / LS 和 Edit / Write 直接放行（目录外：读要审批，写拒绝）；只读命令白名单（`git status/diff/log/show`、`ls`、`cat`、`rg`…，按 `; && || |` 拆开每段都要在白名单里，不能有重定向和命令替换）直接放行；`git push`、改 remote、`gh`、`ssh/scp/rsync`、`sudo`、`curl` 往外发数据、改 `~/.claude` 一律拒绝（提示用「推送并开 PR」）；其他命令、目录外读取、每个域名第一次 WebFetch、MCP、不认识的工具弹审批卡，2 分钟没人处理按拒绝；「本会话总是允许」存进 `chisabot_cc_permission_rules`，下一轮随 `cc_turn` 带给节点。钩子问不到节点（进程不在、超时）一律拒绝。

**表**（开机 `CREATE TABLE IF NOT EXISTS`，回滚安全）：`chisabot_cloud_workspaces`、`chisabot_cc_workspaces`、`chisabot_cc_sessions`、`chisabot_cc_messages`（会话记录，parts 是 JSON：文字 / 工具 / 审批 / 改动 / 出错 / 提示 / 合入·PR）、`chisabot_cc_permission_rules`、`chisabot_cc_events`（操作记录，不含授权码、令牌、对话内容）。P3 只加列（`ADD COLUMN IF NOT EXISTS`）：工作区 `clone_state`、`clone_error`；会话 `pr_url`、`pr_number`、`merged_at`。P4a 新表：`chisabot_cc_sync_bindings`、`chisabot_cc_leases`、`chisabot_cc_sync_events`、`chisabot_cc_sync_conflicts`（见下面「电脑文件夹同步（P4a）」）。

**GitHub 工作区（P3，实现）**

- 接口：`GET /api/claude-code/github`（连没连）、`GET /github/repos`（仓库选择器）、`POST /workspaces {source:"github", repo, branch?, name?}`（立刻返回「克隆中」，后台 `ws_clone`，最长 16 分钟）、`POST /workspaces/:id/retry`、`DELETE /workspaces/:id`（草稿不能删；有会话在跑 / 开着同步不能删；节点上整个 `projects/<工作区>` 删掉，会话归档保留记录）、`POST /sessions/:id/merge`、`GET|POST /sessions/:id/push`（看要推的提交 / 推送并开 PR）、`GET /sessions/:id/diff?mode=base`、`GET /sessions/:id/files|file?ref=work`。
- 令牌：克隆和推送时服务器从保险箱（保留名 `github`）取出，随那一次 `cc_rpc` 下发；节点写一个**不含令牌**的临时 askpass 脚本（`$TMPDIR/chisabot-git-*/askpass.sh`，700，用完删目录），令牌只在那个 git 子进程的环境变量 `CHISABOT_GIT_TOKEN` 里，并且 `-c credential.helper=` 关掉 helper；远端地址不带令牌；git 的输出里出现令牌一律换成 `••••`。Claude 的进程拿不到令牌，所以它自己 `git fetch/push` 都不会成功（`git push` 本来就被规则拒绝）。
- 克隆地址 `https://github.com/<owner>/<repo>.git`（`CHISABOT_GITHUB_GIT_BASE` 可以改，测试替身 / GitHub Enterprise）；克隆后 `core.autocrlf input`、`core.filemode false`，提交署名是 GitHub 登录名 + `<登录名>@users.noreply.github.com`。
- 会话分支 `cc/<标题里的英文数字>-<会话 id 后 6 位>`（中文标题就是 `cc/session-xxxxxx`），建会话时定下来；第一轮时 `git worktree add -b <分支> trees/<会话> HEAD`（从工作目录当前的提交切出来）。快照 / 撤销照旧（独立 `GIT_DIR`，不碰工作树自己的 `.git`）。
- 合入 / 推送前，会话目录里没提交的改动先自动提交到会话分支（「ChisaBot 会话「标题」的改动」）。合入：工作目录有没提交的改动就拒绝；能快进就快进，不能就 `--no-ff` 合并提交；有冲突 `merge --abort` + `reset --hard` 回到合入前，返回冲突文件。推送：`git push origin cc/x:cc/x`（不强推；远端分支被改过就提示 rebase），然后服务器 `POST /repos/:repo/pulls`（目标 = 新建时选的分支），已经有同一分支的 PR 就返回那一个。
- 同一个工作区同一时间只做一件写 git 的事（克隆 / 合入 / 推送），那时候也不开新的一轮。租约（§4.3）在 P4 之前永远在云端：只有「仅云端 / 已暂停」能合入。
- 和设计稿的差别：「推送并开 PR」的审批卡是网页上的确认对话框（分支 → 目标、提交、PR 标题 / 说明 / 草稿 +「允许并推送」/「拒绝」），没有复用机器人 `github_create_pr` 的 `chisabot_github_actions` 表（不是机器人工具调用，是你自己点的按钮），操作记录里有 `pushed_pr`；会话归档后工作树先不自动清理（P3 不做 7 天清理，节点上有 `ws_drop_tree`，以后接上）。

**在云端完成登录 / Claude 上游代理（实现，用户 2026-10-15 20:36 / 20:37 的要求，先于 P3 上线）**

- 远程浏览器：`pc/src/cloud-cc/browser.js`。节点容器里的 Chromium（`chromium` + `fonts-noto-cjk` 装进镜像），`--headless=new --no-sandbox --remote-debugging-pipe`，配置目录 `/tmp/chisabot-login-browser-*`（700），结束 / 取消 / 紧急停止时关进程、删目录。画面：CDP `Page.startScreencast`（JPEG，最多 ~8 帧 / 秒，只发最新一帧）→ `cc_browser_frame` → 服务器 `GET /api/cloud-workspace/claude/login/browser/:id/stream`（SSE）；输入：`POST …/input {events}` → `cc_browser_input` → `Input.dispatchMouseEvent / insertText / dispatchKeyEvent`。弹窗（Google 登录等）自动切过去，关掉切回来。主框架跳到 `…/oauth/code/callback?code=…&state=…` 时节点拿「code#state」直接写进等着的 `claude auth login`，然后发 `cc_browser_done`（只有登录结果）。地址栏只回传 origin + path。
- 出口：浏览器开一个临时标签页读 `https://claude.ai/cdn-cgi/trace`，节点进程用同样的路由（有上游就经上游）也读一次，两边的 `ip=` 放进 `cc_browser_state.egress` 和操作记录。
- 接口：`POST /api/cloud-workspace/claude/login/browser {width,height,mobile}`（先 `login_start` 再 `browser_start`）、`GET …/browser/:id/stream`、`POST …/browser/:id/input`、取消仍是 `DELETE /claude/login/:id`（同时 `browser_stop`）。`GET /api/cloud-workspace` 多了 `browserLogin`（节点 `cc_info.browser`）和 `proxy {configured, masked}`。
- 上游代理：`pc/src/cloud-cc/proxy.js`。服务器 `GET|PUT|DELETE /api/cloud-workspace/claude/proxy`、`POST …/proxy/test {url?}`；地址存保险箱保留名 `claude-proxy`（加密，保险箱页面只读，指回这里），节点连上时和每次修改时 `proxy_set` 下发。节点里一个只听 127.0.0.1 的转发器按主机分流：`anthropic.com` / `claude.ai` / `claude.com`（及子域）走上游（http / https CONNECT + Basic，socks5 + 用户名密码、远端解析），其他直连。Claude Code 的每一轮、`claude auth login/status/logout` 设 `HTTPS_PROXY=http://127.0.0.1:<端口>`（环境变量里没有密码），登录浏览器 `--proxy-server` 指向同一个转发器。改设置不杀正在跑的一轮。服务器自己没有直连 Anthropic 的调用。测试：`pc/test/cloud-cc-proxy.check.js`（http 带认证 / socks5 带认证 / 分流 / 打码 / 回调识别）；预览 e2e 用 `tests/cloud-cc/mock-claude-auth.cjs`（模拟授权页 + 测试上游代理，记录经过它的主机）。
- 节点链接（sing-box 转换，2026-10-16，DESIGN §85）：同一个设置也接受 `trojan://` / `vless://` / `vmess://` / `ss://` / `hysteria2://`（`hy2://`）/ `tuic://`。解析在 `shared/proxy-links.ts`（服务器和网页共用，单测 `shared/proxy-links.test.ts`），服务器 `PUT …/proxy {url, convert: true}`（没有 `convert` 返回 400「要先打开「用 sing-box 转换此链接」」）；保险箱里存原链接，下发给节点的是解析好的 sing-box 出站 `proxy_set {outbound}` / `proxy_test {outbound}`（不发原链接）。节点 `pc/src/cloud-cc/singbox.js` 起 sing-box（`-c stdin`，socks5 入站 127.0.0.1 随机端口 + 随机账号密码，`route.final = up`），转发器把它当 socks5 上游，所以经过它的流量和 http / socks5 代理完全一样。换节点先起新的、起好再停旧的；启动失败服务器不保存。sing-box 意外退出按 1→30 秒退避重启。`cc_info.singbox` = 节点镜像里的 sing-box 版本（存在 `chisabot_cloud_workspaces.info` 里，没有新列），没有时网页提示更新镜像。测试结果多了 `country`（`/cdn-cgi/trace` 的 `loc`）。节点检查 `pc/test/cloud-cc-singbox.check.js`（用一个本机 sing-box trojan 服务端；没有 sing-box 时跳过）。

**电脑文件夹同步（P4a，实现：服务器 + 节点 + 同步边车 + 隧道）**

- 代码：服务器 `server/src/cloud-cc/sync.ts`（`devices/routes.ts` 挂接口和隧道，撤销 / 删除 / 紧急停止时收回）；节点 `pc/src/cloud-cc/sync.js`；隧道 ProxyCommand `pc/src/sync/tunnel.js`（PC 客户端和测试共用）；边车 `deploy/cloud-node/sync/`（Dockerfile、sshd_config、gate.sh、entrypoint.sh）；compose 多了服务 `cloudnode-sync` 和卷 `sync-keys`、`sync-pub`、`sync-host`、`sync-state`。测试 `pc/test/cloud-cc-sync.check.js`。
- **和设计稿的差别**：电脑端不用 Go 的 `chisabot-sync` 助手，改成 PC 客户端里的 JS（`pc/src/sync/`）驱动自编译的 `mutagen.exe`，CI 不需要 Go 之外再加一套三平台编译；CCC 的 Go 代码只作参考。电脑和服务器之间用设备令牌的 HTTP 接口（不是设备 WSS 上的一问一答），服务器推给电脑的交接消息（`sync_begin` / `sync_end`）随 P4b 走设备 WSS。
- **边车 `cloudnode-sync`**：`debian:bookworm-slim` + `openssh-server` + Mutagen v0.18.1 源码编译的 `mutagen-agent`（`-tags mutagenagent`，**不加** `mutagensspl`，许可证在 `/opt/mutagen/LICENSE`）。uid 1000 运行 sshd（`/etc/chisabot-sync/sshd_config`：只听 127.0.0.1:2222、只认公钥、`DisableForwarding yes`、没有 sftp），`network_mode: service:cloudnode`（和节点共用网络命名空间，主机上没有端口，防火墙规则照旧生效），根文件系统只读、`cap_drop: ALL`、256 MB、`pids_limit 128`。只挂工作区卷的 `projects/` 子目录（compose `volume.subpath`）——不挂 home，碰不到 Claude 凭据。主机密钥在边车自己的卷，公钥写到 `sync-pub` 卷给节点读（电脑端 `StrictHostKeyChecking yes` 固定它）。
- **gate**（`chisabot-sync-gate <工作区> <绑定>`，authorized_keys 里每行 `restrict,command=…`）：只放行 `.mutagen/agents/0.18.1/mutagen-agent synchronizer --log-level=<级别>`（预装的 agent，在 `work/` 里启动）和这个工作区 `work/` 的 `git-upload-pack` / `git-receive-pack`；`forwarder`（端口转发）、`uname` 探测 / 安装 agent、任意命令一律退出 126。已知限制：Mutagen agent 的同步路径由电脑端在协议里给出，gate 管不到；边车只挂 `projects/`，所以最坏情况是同一个人的另一个工作区（整台节点只属于一个管理员）。
- **节点**：`sync_tunnel_open{tunnelId}` → 自己开出站 WSS `/api/devices/agent/sync-tunnel?tunnel=…`（设备令牌）→ 连 127.0.0.1:2222，二进制帧直接对接（WSS 发不出去时停读 sshd）；`cc_rpc sync_keys_set`（整份重写 `/sync-keys/authorized_keys`）/ `sync_host_key` / `sync_lease` / `sync_lease_get` / `ws_init_local` / `ws_manifest`（暂停时清单：路径、大小、sha256，默认不同步的规则 §4.6）。`ws_merge` 先过节点上的租约（`projects/<工作区>/.chisabot/lease.json`；电脑在用 → 拒绝；交接中要对得上交接号；文件读不懂不算放行）。
- **电脑接口（设备令牌，`/api/devices/agent/sync/*`）**：`POST /workspaces {name, label}`（「电脑上的文件夹」：节点先建空的 `work/`，成功了再记库，来源 `local`）、`POST /bind {workspaceId, pubKey(ssh-ed25519), label}`（一个工作区同一时间一台电脑；返回 `bindingId`、`epoch`、边车主机公钥、`workPath`、`sshUser`；状态 → 同步中，租约 `syncing`）、`POST /state {workspaceId, state: syncing|pc_active|conflict, detail}`（`pc_active` → 租约 `pc`）、`POST /release`（交还云端：租约 = 云端、已暂停、公钥删掉、这台电脑的隧道断开，两份都留）、`POST /ticket`（一次性隧道票：60 秒、用一次、绑定设备 + 工作区 + 绑定）、`GET /:workspaceId`。隧道 `GET /api/devices/agent/sync-tunnel?ticket=…`（电脑）/ `?tunnel=…`（节点），两边都要设备令牌；票不对、过期、用过、别的设备 → 关闭码 4403。紧急停止的设备拿不到票。
- **网页（管理员）**：`GET /api/claude-code/workspaces/:id/sync`（状态、绑定的电脑和在线情况、租约、隧道数、`canForceReclaim`）、`POST /api/claude-code/workspaces/:id/sync/force-reclaim`（只在电脑离线时：租约 = 云端、已暂停、公钥删掉、隧道断开）。撤销 / 删除电脑设备时它的绑定全部关掉、公钥删掉、隧道断开、工作区回「已暂停」。
- **审计**：`chisabot_cc_sync_events`（created / bind / pc_active / syncing / conflict / released / forced / revoked / recover / tunnel_open / tunnel_close{up, down, ms, why}），不记文件内容、公钥以外的密钥和隧道票。
- **e2e（Linux 替身）**：节点（桥接网，不是 host 网）+ 边车（`--network container:`）+ 电脑替身（`mutagen-linux-amd64` + 系统 OpenSSH + `tunnel.js`，ssh 包装器 `-F` 自己的配置、`HostKeyAlias` + `StrictHostKeyChecking yes`）：第一次同步 22 MB / 315 个文件，电脑改 → 云端几秒内可见，云端改 → 电脑可见，`.env` / `node_modules` 不上云，两边都改同一个文件 → Mutagen 冲突、两份都不被覆盖，交还后拿不到票、再开启恢复同一个 Mutagen 会话，撤销设备 → 公钥删掉 + 状态已暂停，电脑离线时强制收回，主机没有新监听端口，`docker port` 为空，数据库 / 日志里没有隧道票。

**电脑文件夹同步（P4b，实现：PC 客户端）**

- 代码：`pc/src/sync/`——`manager.js`（同步管理：新建 / 开启 / 交还 / 立即同步 / 冲突 / Git / 交接 / 监视）、`mutagen.js`（Mutagen 命令行封装，状态 → 五种状态）、`keys.js`（这台电脑的 ed25519，OpenSSH 私钥格式，只在本机）、`broker.js`（本机中转：只听 127.0.0.1，第一行口令 + 工作区，设备令牌只在主进程里换隧道票、开 WSS）、`tunnel.js`（多了 `--broker` 模式）；Windows 的 ssh 包装器 `pc/sync-shim`（Go，`ssh.exe` 包一层 `-F <ChisaBot 自己的 ssh 配置>` 调系统 OpenSSH，`--chisabot-proxy` 时自己就是 ProxyCommand，连本机中转）。`main.js` 接上设备 WSS 的 `sync_begin / sync_end / sync_cancel`，网页桥 `window.chisabotPC.sync`（`web-preload.js`；路径只能来自主进程弹的选择文件夹对话框）。
- 分发：`release.yml` 新的 `sync-bin` 任务在 Ubuntu 上编译 `mutagen.exe`（v0.18.1，`-tags mutagencli`，**不加** `mutagensspl`，`legal` 里没有 SSPL）和 `chisabot-ssh.exe`，打进 `pc/src/sync/bin/`（asar 里），客户端第一次用时复制到 `userData\sync\bin` 再运行（内容变了才复制）。`package.json` 的 `build` 没改 → 外壳指纹不变，0.1.10 → 0.1.11 走普通在线更新。需要 Windows 自带的 OpenSSH 客户端（`C:\Windows\System32\OpenSSH\ssh.exe`，Windows 10 1809 起默认装着），没有就在面板里说明。
- Mutagen：PC 客户端自己起守护进程（`mutagen daemon run`，数据目录 `userData\sync\mutagen`，环境变量里是 ssh 包装器目录和这次启动的中转口令），每个工作区一个会话 `cb-<工作区>`：`two-way-safe`、`--ignore-vcs`、§4.6 的规则、beta 端 `neighboring` 暂存。交还 = flush → Git → pause（不 terminate，留共同基线）→ `/release`；再开启 = resume，两边都改过的文件由 Mutagen 报冲突。
- 云端那份：「电脑上的文件夹」工作区的 `work/` 是云端自己的 Git 仓库（`ws_init_local` 时 `git init`，配置照 §4.5；`.git` 不走 Mutagen）。会话照 GitHub 工作区的样子在自己的工作树 + `cc/…` 分支上改，**从工作目录快照切出来**（临时 index + `commit-tree`，不动 `work/` 的 HEAD；GitHub 工作区在 `work/` 有电脑同步来的没提交改动时也一样）。「合入工作目录」对这类会话是**放进工作目录**：快照 → 会话分支的 diff 先 `git apply --check`，有一处对不上就一个文件都不写（冲突卡），否则只写文件、不提交，同步回电脑后在电脑上提交。电脑文件夹工作区没有「推送并开 PR」。
- Git 走隧道（§4.5）：电脑上的文件夹是 Git 仓库时，加一个远端 `chisabot`（`cb-<工作区>:<work 路径>`，走同一个 ssh 包装器 + 隧道，gate 只放行这个工作区的 upload/receive-pack）。HEAD 一样跳过；电脑落后 → 电脑 `reset --mixed` 快进；云端落后 → 电脑推到云端的 `refs/remotes/pc/<分支>`，节点 `ws_git_adopt` 快进（`update-ref` + `reset --mixed`，文件不动）；分叉 → 冲突（「以云端为准」先把电脑上的提交备份到 `chisabot/backup/<时间>`，或「在电脑上合并后再试」）。电脑上没装 git：只同步文件。空文件夹第一次开启 GitHub 工作区：先 `git fetch` 云端历史再让 Mutagen 搬文件。
- 冲突（图 4 右）：「用云端」= 电脑那份挪进 `userData\sync\backup\…`；「两份都留」= 电脑那份改名 `名.电脑副本.扩展名`；「用电脑」= `/agent/sync/resolve` → 节点 `ws_sync_drop` 把云端那份挪进 `projects/<工作区>/.chisabot/conflict-backup/<时间>/`（只在租约是「冲突」时）。two-way-safe 下「一边删了一边改了」由 Mutagen 保留改了的那份，所以三种选择都不会覆盖任何一份。处理完报「PC 正在使用」。
- 交接 ①–⑤（§4.3）：服务器 `withHandoff`（`sync.ts`）→ 设备 WSS `sync_begin{handoffId}` → 电脑 resume + flush + Git，暂停，写交接记录 `userData\sync\handoff\<工作区>.json`，`/agent/sync/handoff step=ready`（30 秒没 ready：这次不写，租约回电脑，报错）→ 租约 = `handoff:<号>`，节点只认带这个号的 `ws_merge` → `sync_end{changed}` → 电脑恢复、拉回、删记录、`step=released` → 租约回电脑。电脑在 ③ 之后被关掉：租约留在「交接」，电脑重启拿记录去 `step=recover`：服务器那次写入已经结束 → 恢复；记录对不上 / 读不懂 → 冲突 ·「交接未确认」（不算放行），冲突对话框里「重新对比两边」。交接没收尾时电脑报「PC 正在使用」会被改成冲突。
- 新接口（设备令牌）：`POST /api/devices/agent/sync/resolve {workspaceId, path, choice}`、`/git {op: info|adopt}`、`/handoff {handoffId, step}`；`/state` 多了 `conflicts[]`（存 `chisabot_cc_sync_conflicts`，网页面板显示「去电脑上处理」）。`GET /api/claude-code/workspaces/:id/sync` 多了 `conflicts`、`handoff`。没有新表、没有新列。
- 测试：`pc/test/sync-pc.check.js`（密钥格式 / ssh-keygen 认得、本机中转拒绝错口令和别的工作区、状态映射、副本名、快照切会话 + 放进工作目录 + 冲突不写、adopt 快进 / 云端领先 / 分叉、冲突挪备份只在租约冲突时）；电脑替身 `tests/cloud-cc/sync-pc-standin.cjs`（Linux 上同一份 `manager.js` + 同一次编译的 Mutagen + 系统 OpenSSH + Node 跑 tunnel.js，设备 WSS 照常连，交接消息走真实路径）。

**和设计稿的差别**：会话记录存在 `chisabot_cc_messages`，不是机器人聊天线程（ADR-0014 第 4 条）；「草稿」工作区每个会话一个自己的目录（`trees/<会话>`），不共用工作目录；审批卡只在会话里（以及操作记录），P2 还没有手机推送。

> 下文的「ChisaCloudCode」（简称 CCC）是作者的另一个项目（Windows 桌面端 + 服务器工作区），电脑同步的交接逻辑来自它的桌面端代码。

# 0. 一页看完

**要做的事**：在 ChisaBot 的云端集成 Claude Code。网页上登录 Claude、和它对话、直接用它开发。项目平时放在云端；想在电脑上改的时候，把它同步下来，改完交还。

1. **云端工作区节点**：服务器上一个独立容器，里面是 Claude Code 和 `chisabot-node`。非 root，不挂 docker.sock，连不到其他容器。电脑关机也能接着写代码。
2. **Claude 账号**：在 设置 → 云端工作区 里，用Claude 订阅 单独登录一次（打开授权页，复制授权码，粘回来）。API Key 以后可以作为备用。
3. **Claude Code 标签页**：左栏切到「Claude Code」，能看到工作区列表，每个工作区下面是它的会话。点开一个会话就在中间对话，右边看文件和 diff。一个会话对应一个 Claude 会话，有自己的工作树和分支 `cc/…`，隔天回来接着说。
4. **审批**：只读操作直接放行。其他命令弹 ChisaBot 审批卡，可以选「本对话总是允许」。推送只能通过「推送并开 PR」。不开 bypass。
5. **电脑同步（每个工作区单独开关）**：在 ChisaBot PC 客户端里给某个工作区打开「电脑同步」，文件就和电脑上的文件夹双向同步，状态显示「PC 正在使用」。关掉之后两份都保留；再打开时先对比，两边都改过的文件让你选。云端要写工作目录时，先和电脑交接，不会两边同时写。

**不做的**：不复制 CloudCLI UI 派生的代码；不做网页编辑器和网页终端（右栏只读）；不在主机上开新的公网端口。

§11 的三个待定问题（2026-10-15）按建议定：手动「合入工作目录」、电脑同步先只做 Windows、右栏只读。

---

# 1. 用户故事

| # | 我是谁 / 在哪 | 我想 | 这样就算做好了 |
|-|---|----|--------|
| U1 | 电脑前，第一次用 | 在网页里登录我的 Claude Pro | 不开终端、不碰服务器，三步登录成功，显示「已登录 · 邮箱 · Pro」 |
| U2 | 电脑前 | 把一个 GitHub 仓库变成云端工作区 | 「新建工作区 → 从 GitHub」选仓库，按钮依次显示「克隆中… → 已创建 ✓」，左栏出现这个工作区，状态「仅云端」 |
| U3 | 任何地方 | 在某个工作区里开一个会话修 bug | 「＋新会话」，Claude 在分支 `cc/<标题>` 上改；中间看到回复流式出来和干活卡，右栏看到这一轮的 diff |
| U4 | 地铁上，手机 | Claude 要跑 `npm test` | 手机收到审批卡和推送，点「允许」它就接着跑，点「拒绝」它换个办法；改动在底部抽屉里看 |
| U5 | 第二天 | 接着昨天的会话 | 同一个会话里 Claude 记得昨天改过什么；想重来就点「新会话」 |
| U6 | 改好了 | 推到 GitHub 开 PR | 「推送并开 PR」→ 审批卡（分支、提交、目标分支）→ 允许后出现 PR 链接卡 |
| U7 | PC 客户端里 | 把电脑上的项目文件夹放到云端 | 「新建工作区 → 电脑上的文件夹」选文件夹，看到不会上传的规则（node_modules、.env…），按钮显示上传进度；勾选「传完后开启同步」后状态变成「PC 正在使用」 |
| U8 | 在家，PC 客户端 | 在电脑上用自己的 IDE 改一个云端项目 | 在这个工作区上打开「电脑同步」，选一个空文件夹，文件和 Git 历史都拉下来，之后两边实时同步 |
| U9 | 出门前 | 交还给云端，在手机上接着让 Claude 改 | 「交还云端」→ 最后一次同步完成后状态变成「已暂停」，电脑上那份保留；手机上的会话能改工作目录 |
| U10 | 回家后 | 再打开同步 | 先对比。只有一边改过的文件自动合并；两边都改过的弹冲突对话框（用云端 / 用电脑 / 两份都留），不会悄悄覆盖 |
| U11 | 电脑开着同步时 | Claude 在云端跑会话 | 会话在自己的分支上改，不碰工作目录，所以照常跑；点「合入工作目录」时自动和电脑交接，电脑上正在改的文件不会被覆盖 |
| U12 | 担心安全 | 知道它碰不到别的东西 | 节点碰不到数据库、保险箱、其他容器和 Docker；主机上没有新开端口；紧急停止能立刻停掉所有任务 |
| U13 | 和主机器人聊天时 | 「用 Claude Code 把 README 翻译成英文」 | 主机器人用 `device_agent_run` 把活儿交给云端节点，任务卡片出现在原对话（v1 的 U8，保留） |

---

# 2. 界面

## 2.1 放在哪

- **左栏顶部的切换「机器人｜Claude Code」**（分段控件，记住上次的选择）。「机器人」就是现在的左栏，只放机器人，主机器人置顶。「Claude Code」换成工作区和会话的树。
- 这一条**修订 ADR-0001**（左栏只放机器人）：P0 写新的 ADR-0014，说明左栏可以在两种内容之间切换，但机器人那边仍然只放机器人。
- **ADR-0013（只有一套聊天）不受影响**：Claude Code 会话的对话区复用频道聊天的组件（消息流、短气泡 §69、干活卡 §70、审批卡、流式续看 §64、多端同步 §42），只是数据来源换成 Claude Code 会话。
- 账号、权限、操作记录留在 设置 → 云端工作区（图 5）。v1 设置页里的「仓库」标签搬进 Claude Code 视图的工作区列表。
- 没有云端节点或没登录 Claude 时，Claude Code 视图显示空状态卡：「先连接云端工作区」/「登录 Claude」，带一个按钮直接跳过去。

## 2.2 桌面：Claude Code 视图（图 1）

三栏，都是 Skyglass 玻璃卡，遵守仓库根目录 DESIGN.md（§9–§14 设计系统、反馈分三级、按钮状态机、动效 150–300 ms、亮色和暗色）。

- **左栏（约 284 px）**：切换控件 →「＋新建工作区」→ 工作区列表。每个工作区一行：折叠三角 · 名称 · **同步状态小药丸** · 第二行小字写来源（`GitHub · owner/repo` / `电脑文件夹 · D:\blog` / `内置 · 只在云端`）。展开后是会话：状态点（蓝 = 运行中，黄 = 等你批准，灰 = 空闲）· 标题 · 分支名 · 右侧状态字，最后是「＋新会话」。左栏底部是节点状态卡：「云端工作区 · 在线 · Claude Pro · 正在运行 1 / 2」，点「设置」进图 5。
- **中间**：对话头写标题，药丸依次是「工作区 · 分支」「接着上次 · N 轮」和同步状态；右侧按钮「合入工作目录」「推送并开 PR」、「⋯」菜单（新会话 / 重命名 / 停止 / 归档），还有收起或展开右栏的按钮。消息流和 v1 一样（干活卡、回复、审批卡、改动卡），改动卡点「在右侧看 diff」。PC 正在使用这个工作区时，对话里有一条提示：「会话在自己的分支上改；合入工作目录时会先和电脑交接」。输入框上方是模型和努力程度的药丸，右侧是发送和停止。
- **右栏（约 380 px，可以收起）**：分段「文件｜改动」。「改动」再分三个视图：「这一轮 / 相对 main / 工作目录（相对会话分支）」，上面列文件和 ±，下面是 diff（加行绿、删行红，等宽字体，带行号）。「文件」是只读的目录树和代码视图（≤ 1 MB），有改动的文件带圆点。收起后对话占满中间。

## 2.3 新建工作区（图 2）

玻璃弹窗，上方分段「从 GitHub｜电脑上的文件夹」。

- **网页 / 手机**：只能选「从 GitHub」。「电脑上的文件夹」显示为灰色，下面一行小字：「只能在 ChisaBot 电脑客户端里选」。搜索你的仓库（已连好的 GitHub）→ 选分支（默认是默认分支）→ 名称（默认用仓库名）→「创建」。按钮依次显示：创建 → 克隆中…（转圈）→ 已创建 ✓。也可以直接粘贴 GitHub 地址；没有权限的私有仓库提示「你的 GitHub 连接看不到这个仓库」。
- **PC 客户端**：选「电脑上的文件夹」→ 系统的选择文件夹对话框（PC 已经有 `showOpenDialog` 的用法）→ 检测结果卡：是不是 Git 仓库、分支、远端、文件数和大小，以及**不会上传的规则**（默认规则见 §4.6，「查看全部规则」能展开）→ 名称 → 复选框「传完后在这台电脑上开启同步（之后随时可以关）」→「上传并创建」。按钮依次显示：上传中 x% → 已创建 ✓。超过 2 GB 或 5 万个文件时先提醒，不硬拦。
- 「草稿」工作区是内置的，不能删除，只在云端，没有 Git 远端，适合「只聊天、写个小脚本」。

## 2.4 手机（图 3）

- 左栏变成整页列表：切换控件 → 工作区卡片（名称 + 状态药丸，展开后是会话）→ 底部「＋新建工作区」（只能从 GitHub）。
- 会话页：对话头收成「‹ 头像 标题 / 工作区 · 分支 ⋯」；审批卡的按钮竖着排，热区 ≥ 44 px；**右栏变成底部抽屉**（半屏，上拉到全屏，下拉收起），内容和桌面右栏一样（文件 / 改动），左右滑动切换文件。
- 电脑同步在手机上**只能看状态**，另外在电脑离线时可以「强制收回到云端」（§4.4）。

## 2.5 同步在界面上怎么显示（图 4）

- 工作区行、对话头、PC 的同步面板用的是**同一套状态药丸**：仅云端（灰）、同步中（蓝，转圈）、PC 正在使用（绿）、已暂停（琥珀）、冲突（红）。
- PC 客户端里，工作区「⋯ → 电脑同步」打开同步面板：开关、这台电脑的路径、上次同步时间和文件数、Git 是否一致、不同步的规则，以及按钮「交还云端（关闭同步）」「立即同步」。
- 网页和手机上点状态药丸，弹出同一个面板的只读版，写着「在 ×× 电脑上同步中」或「电脑离线 12 分钟」，电脑离线时多一个「强制收回到云端」。
- 进入「冲突」时，PC 上弹冲突对话框（图 4 右边），网页上显示「去电脑上处理」。

---

# 3. 主要流程

## 3.1 网页登录 Claude（订阅）——和 v1 一样

已经实测：Claude Code 2.1.165 的 `claude auth login --claudeai` 在没有终端时也会打印授权地址，然后等「Paste code here if prompted >」从标准输入读授权码（2026-10-15 在 Hark 沙盒里用空 HOME 试过，没有提交授权码）。所以不需要伪终端：

1. 「用 Claude 订阅登录」→ `POST /api/cloud-workspace/claude/login` → 服务器发 `cc_login_start` → 节点以 `agent` 用户启动登录命令，从输出里取出授权地址，回 `cc_login_url`。
2. 你在浏览器里授权，复制授权码，粘回来 → `POST …/login/:id/code` → 节点把它写进那个进程的标准输入 → `claude auth status --json` → 回 `cc_login_done{ok, email, plan}`。
3. 凭据只在节点的 home 卷里（`~/.claude/.credentials.json`，权限 600）。授权码和令牌都不进数据库，也不进日志。同一时间只能有一个登录流程，10 分钟过期。
4. 不复制 ChisaCloudCode 已经登录的那份凭据：刷新令牌会轮换，两边共用一份，迟早有一边被登出。

## 3.2 一轮对话

1. 发消息 → 服务器发现这个会话属于 Claude Code，就不跑 ChisaBot 的模型循环，交给 ClaudeCodeAgent（自定义 AG-UI agent）→ `cc_turn{sessionId, prompt, claudeSessionId?, cwd, model, effort}`。
2. 节点在**这个会话的工作树**里运行：`claude -p --output-format stream-json --verbose --include-partial-messages [--resume <id>] --permission-mode default --settings <钩子配置> --model <m>`。
3. `cc_event` 一行一行回来，变成聊天事件：文字增量 → 流式气泡；`tool_use` → 干活卡；`init` 里的 `session_id` 存进会话表。
4. `cc_done`：用独立的 GIT_DIR 给这一轮拍快照，算出 diff → 改动卡和右栏「这一轮」；费用和轮数记进审计。「撤销这一轮」就是恢复到这一轮开始前的快照。
5. 停止：`cc_stop` 结束整个进程树，会话保留。回答到一半又发一条：沿用收件箱（§38）排队。
6. **非 Git 工作区**（「草稿」、没有 `.git` 的电脑文件夹）：会话直接在工作目录里改，同一时间只能有一个会话在写；PC 正在使用时，每一轮都按 §4.3 交接。

## 3.3 权限 → 审批卡（和 v1 一样，已定）

PreToolUse 钩子 = 节点程序自己（`chisabot-node cc-hook`），通过本机 unix socket 问节点主进程。不能自动决定的，走 `hub.requestUserApproval`：聊天卡片、PC 弹窗、手机推送，谁先点算谁，2 分钟没人处理按拒绝。

| Claude 想做的 | 默认 |
|---|---|
| Read / Grep / Glob / LS（会话工作树里） | 直接允许 |
| Edit / Write（会话工作树里） | 直接允许（可以撤销这一轮） |
| 读或写会话工作树之外，包括工作目录 `work/` 和别的会话 | 读：弹审批卡；写：拒绝 |
| Bash 只读白名单（`git status/diff/log/show`、`ls`、`cat`、`rg`、`pwd`…） | 直接允许 |
| 其他 Bash（`npm test`、`pip install`、`git commit`…） | 审批卡，可以选「本对话总是允许这条命令」 |
| `git push`、`gh`、改 remote、`ssh`、`curl -X POST` | 一律拒绝，提示「请用『推送并开 PR』」 |
| WebFetch / WebSearch | 每个域名第一次弹卡，之后本对话内允许 |
| MCP、`sudo`、改 `~/.claude` | MCP 弹卡；另外两项拒绝 |

不开 bypass；节点安装时加 `--no-full-access`，**永远不能开完全访问**。规则存在 `chisabot_cc_permission_rules`，可以在设置里看到和删除。

## 3.4 GitHub 工作区

1. 新建：服务器从保险箱取出 GitHub 令牌，随 `ws_clone` 发给节点，只在这一次 git 命令的临时 askpass 里用，用完就删 → 克隆到 `projects/<工作区>/work`。
2. 每个会话一个持久工作树：`projects/<工作区>/trees/<会话>`，分支 `cc/<标题拼音或短 id>`，从工作目录当前所在的提交切出来。
3. **合入工作目录**：把会话分支合进 `work/` 当前分支（快进或者合并提交）。合并有冲突时不动 `work/`，在对话里提示「有冲突，让 Claude 先 rebase」，附一个「让 Claude 处理」按钮。要写 `work/`，所以要拿租约（§4.3）。
4. **推送并开 PR**：审批卡 → 令牌临时下发 → `git push` 会话分支 → 服务器用已有的 GitHub 连接开 PR（复用 `github_create_pr` 的确认流程）→ PR 链接卡。不需要租约，因为不碰 `work/`。
5. 清理：会话归档后工作树保留 7 天；工作区删除要二次确认，开着同步时不能删。

---

# 4. 电脑同步

## 4.1 原则

1. **云端是主副本**。每个工作区在云端有一个工作目录 `work/`。网页、手机和云端会话面对的都是它。
2. **同步按工作区开关**，默认关。打开 = 这台电脑**正在使用**这个工作区的工作目录。同一时间最多一台电脑。
3. **关闭同步不删任何东西**：两份都保留，以后各改各的。
4. **打开同步之前先对比**：只有一边改过的自动带过去；两边都改过的文件，以及分叉的 Git 提交，一律停下来问你。**永远不静默覆盖。**
5. **同一时间只有一方能写工作目录**。由服务器上的「租约」决定是谁，节点负责执行；交接沿用 CCC 的「同步开始 / 结束 / 交还」。

## 4.2 五种状态

| 状态 | 什么意思 | 谁能写 `work/` | 进入 / 离开 |
|---|---|---|---|
| **仅云端** | 没有绑定任何电脑 | 云端（合入、非 Git 会话） | 新建 GitHub 工作区后的默认状态；在 PC 上「开启同步」后离开 |
| **同步中** | 正在搬文件：第一次拉到电脑、交还、开启前对比、交接 | 暂时谁都不能写（这一步自己持有租约） | 自动进入和离开；按钮是转圈的状态，不能点 |
| **PC 正在使用** | 绑定的电脑开着同步，Mutagen 实时双向同步 | 电脑（在电脑上直接编辑）；云端要写需要先交接（§4.3） | 开启同步成功后进入；「交还云端」、强制收回或者出冲突时离开 |
| **已暂停** | 绑定还在（记得是哪台电脑、哪个文件夹），但同步关着 | 云端 | 交还或者强制收回后进入；在 PC 上再「开启同步」，经过「同步中（对比）」离开 |
| **冲突** | 对比时发现两边都改过的文件，或者 Git 分叉，或者 Mutagen 报冲突、一端被清空 | 谁都不能写，等你处理 | 你在 PC 上处理完后进入「PC 正在使用」；也可以选「先不同步」回到「已暂停」 |

另外几种细分（不单独算状态，作为状态药丸的附注）：「PC 正在使用 · 电脑离线 N 分钟」、「同步中 · 等电脑上线」、「已暂停 · 别的电脑」。这几种对应 CCC 里的 `disconnected`、`checking`、`unavailable`。

## 4.3 云端在 PC 正在使用时要做事：交接（沿用 CCC）

Claude 会话在**自己的工作树**里改，不碰 `work/`，所以 PC 开着同步也照常跑，**不用交接**。只有下面这些要写 `work/` 的事才需要交接：「合入工作目录」、非 Git 工作区的会话轮次、网页上的「撤销合入」。

| 步骤 | 服务器 | 电脑（PC 客户端里的同步助手） | 节点 |
|---|---|---|---|
| ① 发起 | 生成交接号 `handoffId`，租约记成 `pc → handoff-pending`；电脑上显示「云端要写入工作目录」 | — | — |
| ② 同步开始 `sync_begin` | — | 先把电脑上的改动推上去（Mutagen resume + flush），同步 Git，然后**暂停** Mutagen，写下交还记录，回「已就绪」 | — |
| ③ 云端写入 | 租约 = `cloud:handoffId` | 电脑上能继续编辑，改动先留在本地 | 只接受带这个交接号的写入 |
| ④ 同步结束 `sync_end{changed}` | 写完后通知电脑 | `changed=false`：只恢复同步；`true`：恢复后 flush 拉回结果，同步 Git。暂停期间电脑上改过的文件照常合并，撞到同一个文件就进「冲突」 | — |
| ⑤ 交还 `sync_released` | 租约回到 `pc`，交接号作废 | 删掉交还记录 | — |

- **断线恢复**：服务器、电脑两边都记着交接（CCC 的 `sync_release_journal` 和 `lease.py` 的 claim/confirm/recover/release）。重启或断线后先对一遍交接号再继续。交接号对不上，或者记录读不出来，都**不算放行**，保留租约，状态变「冲突 · 交接未确认」。这个规则照搬 CCC 的注释：「An unreadable identity is not proof that a previously claimed lease ended」。
- **电脑 30 秒没响应**：这件事排队，界面显示「等电脑上线」，并给出「强制收回到云端」。强制收回后租约 = 云端，状态变「已暂停」，电脑上还没同步上来的改动留在电脑上，下次开启同步时对比。
- **没有交接号时**：节点拒绝任何对 `work/` 的写入。电脑没有租约时，Mutagen 保持暂停。

## 4.4 开、关、强制收回

- **开启同步（第一次，云端 → 电脑）**：在 PC 上选一个**空文件夹** → 生成这台电脑的 SSH 密钥（ed25519，只放在本机），公钥通过设备连接登记 → 先用 Git 把历史拉下来（`git fetch` 走同一条隧道）→ 建立 Mutagen 会话（two-way-safe）→ 第一次 flush 成功后租约 = pc，状态变「PC 正在使用」。如果选的文件夹不是空的，就走下面「再次开启」的对比流程。
- **开启同步（电脑文件夹 → 云端，图 2 右边）**：CCC 的 `migrateProjectLocked`：先在云端建一个空的 `work/`，Git 历史用 bundle 第一次上传，文件用 Mutagen 传，传完就是「PC 正在使用」（没勾选「开启同步」的话是「已暂停」）。
- **交还云端（关闭）**：flush → 同步 Git → 暂停 Mutagen（**不终止**，留着它的共同基线）→ 两边各记一份「暂停时清单」（路径、大小、sha256）→ 租约 = 云端 → 「已暂停」。
- **再次开启**：两边各自和暂停时的清单比，算出「云端改过的」和「电脑改过的」，取交集。
  - 没有交集：恢复 Mutagen，两边的改动自动合并 → 「PC 正在使用」。
  - 有交集，或者 Git 分叉：进「冲突」，电脑上弹冲突对话框。每个文件可以选「用云端 / 用电脑 / 两份都留」（两份都留 = 电脑那份另存为 `文件名.电脑副本.扩展名`）。Git 分叉时可以「在电脑上合并后再试」，或者「以云端为准」（电脑上的分支先备份到 `chisabot/backup/<时间>`）。处理完再恢复同步。
  - Mutagen 的 two-way-safe 模式本来就不会覆盖两边都改过的文件，这里是第二道保险。CCC 的「一端被清空就停下等确认」（`halted-on-root-emptied`，被删掉的文件移进备份）照搬。
- **强制收回（网页、手机，只在电脑离线时可用）**：二次确认 →「已暂停」。
- **换一台电脑**：另一台电脑要开启时，先请当前那台交还；那台离线的话先强制收回。
- **新建失败 / 删工作区**（DESIGN.md §87）：「电脑上的文件夹」新建中途任何一步失败都撤销（PC 终止 Mutagen 会话、去掉本机记录，服务器 `POST /api/devices/agent/sync/abandon` 删节点目录、绑定、租约和工作区行）；新建 / 开启同步前服务器先让节点 `sync_probe` 边车。删工作区时服务器拆掉绑定 / 租约 / 公钥 / 隧道，给电脑发 `sync_forget`；电脑用 `POST …/sync/reconcile` 对账，服务器确认工作区没了才放下本机记录（启动时也对一次）。同一个文件夹的旧记录指向已删的工作区时可以「解除旧的同步并重新导入」。

## 4.5 Git 怎么同步

- `.git` 不走 Mutagen（`--ignore-vcs`），提交历史用 Git 自己的传输，走同一条 SSH 隧道。逻辑照搬 CCC 的 `syncGitContext`：云端没有仓库时用 bundle 第一次上传；两边 HEAD 一样就跳过；一边是另一边的祖先就快进（`reset --mixed`，保留工作区文件）；分叉了就进「冲突」，不自动合并。
- 云端那份的 Git 配置：`core.autocrlf input`、`core.filemode false`、`core.symlinks false`。Windows 签出的换行和权限位不会变成假改动（CCC 的 `serverGitConfiguration`）。
- 会话分支 `cc/*` 在云端，开启同步时也随历史一起到电脑上；电脑上新建的分支随下一次 Git 同步上来。

## 4.6 默认不同步的规则

沿用 CCC 的 `syncIgnoreConfiguration`：`dist build out .next coverage .cache cache .tmp`（但**已经被 Git 跟踪的文件例外**，照样同步）、`node_modules .git .venv venv __pycache__ .env .env.*`（`.env.example` 和 `.env.sample` 例外）。电脑上的 `.env` 不会进云端。规则可以按工作区改，在同步面板里查看全部。

---

# 5. 架构

架构一句话：浏览器 / 手机 → ChisaBot 应用（工作区、会话、审批、同步协调、隧道转发）⇄ 设备 WSS ⇄ 云端节点容器（Claude Code CLI + chisabot-node）；P4 起 PC 的 Mutagen 经设备 WSS 隧道到节点旁边的同步边车（127.0.0.1:2222），主机上不开新端口。

## 5.1 云端节点容器 `cloudnode`（和 v1 一样）

- 镜像 `deploy/cloud-node/Dockerfile`（公开、通用）：`node:22-bookworm-slim`，加 git、ripgrep、procps 和固定版本的 `@anthropic-ai/claude-code`。用户 `agent`（uid 1000）。入口脚本每次启动从服务器下载最新的 `chisabot-node.cjs`。配对时加参数 `--name 云端工作区 --no-full-access`。
- 限制：2 核、4 GB 内存、`pids_limit 512`、根文件系统只读、/tmp 用 tmpfs、`cap_drop ALL`、`no-new-privileges`，不挂 docker.sock，不用 host 网络。
- 两个卷：`home`（Claude 凭据，**只挂给节点**）和 `workspace`（`projects/<工作区>/{work, trees/<会话>, .chisabot/}`、`scratch/`）。
- 部署目录自定（例如 `/opt/chisabot-cloudnode/`），手工部署，不归在线更新管。

## 5.2 隔离与出口（和 v1 一样）

- 节点独占一个 Docker 网桥（可以复用一个空闲的）。`firewall.sh`：DOCKER-USER 丢弃这个网段发往 10/8、172.16/12、192.168/16 的流量；INPUT 丢弃这个网段发往主机的流量。节点只能出公网，连 ChisaBot 也走 `https://<你的域名>`。
- 如果服务器所在地区访问 Claude 需要代理，在主机上按域名分流（例如 DNS fake-ip 只劫持 Claude 的域名），节点本身不需要配置。

## 5.3 同步边车 `cloudnode-sync`（新）

| 项 | 设计 | 为什么 |
|---|---|---|
| 网络 | `network_mode: service:cloudnode`，和节点共用网络命名空间；sshd **只听 127.0.0.1:2222**；**不发布任何端口** | Docker 发布的端口会绕过 ufw。这里主机上根本没有新端口 |
| 进程 | uid 1000 的 sshd（非 root 的 sshd 只能让同一个用户登录，正好够用）；预装和 PC 同版本的 `mutagen-agent` | 不需要 root，也不需要 SETUID 这些 capability（CCC 那个容器要 CHOWN/SETUID 等 7 项） |
| 限制 | `cap_drop ALL`、`no-new-privileges`、根文件系统只读、256 MB、`pids_limit 128`、/tmp 用 tmpfs | 照搬 CCC 同步容器的思路，再收紧一点 |
| 挂载 | 只挂 `workspace` 卷的 `projects/`，**不挂 home** | Claude 凭据不让同步这条路碰到 |
| 登录 | `authorized_keys` 里每台电脑、每个工作区一行：`restrict,command="chisabot-sync-gate <工作区> <绑定代号>" ssh-ed25519 …`；gate 只放行 Mutagen 的探测和 agent 启动，以及这个工作区路径下的 `git upload-pack/receive-pack` | 不能开终端，不能转发端口，也碰不到别的工作区。白名单在 P4 第一步按 Mutagen 0.18 实际发出的命令定稿 |
| 主机密钥 | 放在边车自己的小卷里；公钥在绑定时下发给电脑，电脑端 `StrictHostKeyChecking yes` | 照搬 CCC 的 `SSHHostKeyPinned` |
| 不用 docker.sock | 边车和节点都是 compose 里写死的两个服务，手工部署；**没有任何程序按账号去起容器** | CCC 用 docker.sock 按账号起同步容器，等于宿主机 root。这条路这里不走 |

## 5.4 同步隧道（PC ⇄ 节点，新）

1. PC 上的 Mutagen 通过 `MUTAGEN_SSH_PATH` 调用我们自己的 `ssh` 包装器（照搬 CCC `cmd/sync-ssh` 的做法：只转给系统的 OpenSSH，强制 `-F` 用自己的配置）。配置里写 `ProxyCommand chisabot-sync tunnel <工作区>`。
2. `chisabot-sync tunnel` 通过本机管道问 PC 主进程要一张**一次性隧道票**（主进程通过已有的设备 WSS 向服务器申请，60 秒有效，绑定设备、工作区和绑定代号），然后自己开一条 WSS 到 `wss://<你的域名>/api/devices/agent/sync-tunnel`，也就是走网关，路径和设备连接同一族。
3. 服务器验票后，通过节点的设备连接发 `sync_tunnel_open{ticket}`；节点自己再开一条出站 WSS 回来，连到本机的 127.0.0.1:2222。服务器把两条 WSS 的字节直接对接。
4. 服务器**只给「已绑定、开着同步（或者正在开启）」的那台电脑开隧道**，而且每次都写审计。紧急停止或撤销设备时，隧道立即断开。
5. 每条隧道是独立的 WSS，不挤占设备控制连接。吞吐受服务器应用转发的限制，对代码仓库够用；P4 会测一次 18 MB、312 个文件的首次同步要多久。

## 5.5 代码从哪来（许可）

| 来源 | 能不能用 | 怎么用 |
|---|---|---|
| **CCC `app/` 的 Go 桌面端同步代码**（`syncmgr.go`、`syncproject.go`、`sync_transport.go`、`syncempty.go`、`sync_release_journal.go`、`syncmonitor.go`、`cmd/sync-ssh`、`resources/lease.py` 等，约 4 千行） | **能**：作者本人写的 | 打包成一个小的 Go 程序 `chisabot-sync`（JSON over stdio），PC 主进程调用它。去掉 Pi、预览和 CloudCLI 路径相关的部分（`util.go` 的 `cloudcli-dist`、`main.go` 的 `/etc/cloudcli*`）。在 ChisaBot 里以 MIT 发布，提交说明写「作者本人从 ChisaCloudCode 桌面端移入」。P4 开工时逐个文件确认没有 CloudCLI 来源 |
| **CCC `cloudcli-ui/` 下的一切**（网页、服务端 `workspace-sync`、`workspace-bridge` 等） | **不能复制**：AGPL-3.0 + 第 7 条附加条款，ChisaBot 是公开的 MIT 仓库 | 只看它做了什么（例如「每个账号一个 SSH 容器、登记公钥、发主机密钥」），用 ChisaBot 自己的代码重写，而且做法不同：不用 docker.sock、不发布端口 |
| **Mutagen 0.18.1** | **能**：仓库里的代码默认是 MIT（Copyright Docker, Inc.），只有 `sspl/` 目录是 SSPL；**官方发布版从 v0.17 起默认带上 SSPL 代码** | **自己编译**，不加 `--sspl` 参数，这样只有 MIT 和其他非 copyleft 代码。作为独立程序随 PC 客户端分发，第三方声明里带上它的 MIT 许可。边车里的 `mutagen-agent` 用同一次编译的产物。CCC 现在随包带的 `mutagen.exe` 来源要在 P4 确认，不直接复用 |
| CopilotKit / ChisaBot 自己的代码 | 能 | — |

> 出处：Mutagen v0.18.1 的 LICENSE（https://raw.githubusercontent.com/mutagen-io/mutagen/v0.18.1/LICENSE），原文：「All code that resides under the sspl directory is made available under the terms of the Server Side Public License … From Mutagen v0.17 onward, SSPL-licensed code is included by default in official Mutagen release builds. Users wishing to create a Mutagen build with only MIT-licensed and non-copyleft-licensed code can do so by running the build script and omitting the `--sspl` flag.」

**不用 Go 的话**：也可以把同样的状态机用 JS 写进 `pc/src`（CCC 的 Go 代码当参考）。我更倾向 Go 助手：这套代码在 Windows 上已经跑通、带测试，重写容易丢掉那些边界情况（交还记录、清空保护、CRLF）。代价是 ChisaBot 的 CI 要多一套 Go 工具链和三平台编译。

## 5.6 凭据

| 凭据 | 存在哪 | 谁能碰到 |
|---|---|---|
| Claude 订阅（OAuth） | 节点 home 卷，权限 600 | 只有节点；边车和服务器都碰不到 |
| Anthropic API Key（可选，以后） | 保险箱（保留名 `anthropic`） | 每一轮作为环境变量下发，不落盘 |
| GitHub 令牌 | 保险箱（`github`） | 只在克隆和推送那一次临时下发 |
| 设备令牌 | 节点和 PC 各自的 `config.json`（权限 600） | 各自 |
| 电脑同步 SSH 私钥 | 只在那台电脑上（PC 数据目录，600）；公钥登记到服务器和边车 | 那台电脑 |
| 边车主机密钥 | 边车自己的卷 | 边车；公钥下发给电脑用来固定主机身份 |
| 隧道票 | 服务器内存，60 秒，用一次 | — |

---

# 6. 数据模型（草图）

全部 `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`，旧镜像会忽略，回滚安全，不删表。

| 表 | 字段 | 用途 |
|---|---|---|
| `chisabot_cloud_workspaces`（v1） | `device_id` PK、`owner_user_id`、`claude_auth` jsonb、`auth_preference`、`api_key_secret`、`created_at` | 节点本身和 Claude 登录状态（不含令牌） |
| `chisabot_cc_workspaces`（新，替代 v1 的 `cc_repos`） | `id`、`owner_user_id`、`node_device_id`、`name`、`source`（github / local / scratch）、`repo_full_name`、`default_branch`、`is_git`、`path`、`sync_state`（cloud_only / syncing / pc_active / paused / conflict）、`size_bytes`、`created_at`、`last_used_at` | 工作区 |
| `chisabot_cc_sessions`（改） | `id`、`workspace_id`、`thread_id`（聊天记录，thread kind = `claude_code`）、`claude_session_id`、`branch`、`tree_path`、`model`、`effort`、`turns`、`status`、`last_turn_at`、`archived_at` | 一个会话 = 一个 Claude 会话 + 一个工作树 |
| `chisabot_cc_sync_bindings`（新） | `id`、`workspace_id`、`pc_device_id`、`local_path_label`（只用来显示）、`binding_epoch`、`enabled`、`ssh_key_fpr`、`last_synced_at`、`paused_manifest_at`、`ignore_rules` jsonb | 哪台电脑、哪个文件夹（每个工作区最多一条有效绑定） |
| `chisabot_cc_leases`（新） | `workspace_id` PK、`holder`（cloud / pc / handoff）、`holder_device_id`、`handoff_id`、`binding_epoch`、`since`、`expires_at` | 谁能写 `work/`，以这张表为准 |
| `chisabot_cc_sync_events`（新） | `id`、`workspace_id`、`kind`（begin / end / released / forced / conflict / resolved）、`handoff_id`、`detail` jsonb、`at` | 交接和冲突的记录（审计和断线恢复） |
| `chisabot_cc_sync_conflicts`（新） | `id`、`binding_id`、`path`、`cloud_meta`、`pc_meta`、`resolution`（cloud / pc / both）、`resolved_at` | 冲突清单 |
| `chisabot_cc_permission_rules`（v1） | `scope`（session / workspace）等 | 「本对话总是允许」规则 |
| `chisabot_local_agent_tasks`（加列，v1） | `mode`、`claude_session_id`、`queue_position` | 每一轮复用任务表 |

# 7. 接口草图

**HTTP**（要登录，只有管理员能用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cloud-workspace` | 节点、Claude 登录状态、用量 |
| POST / DELETE | `/api/cloud-workspace/claude/login[/:id[/code]]`、`/claude/logout`、`/claude/check` | 登录（和 v1 一样） |
| GET / POST | `/api/claude-code/workspaces` | 列出 / 新建 `{source:'github', repo, branch, name}`（PC 上传另走下面的 sync 接口） |
| GET / PATCH / DELETE | `/api/claude-code/workspaces/:id` | 详情（包括同步状态）/ 重命名、改不同步的规则 / 删除（开着同步时不能删） |
| GET / POST | `/api/claude-code/workspaces/:id/sessions` | 列出 / 新会话 `{title, fromRef?}` |
| POST | `/api/claude-code/sessions/:id/{stop, new-claude-session, undo-turn, merge, push}` | 停止 / 新 Claude 会话 / 撤销这一轮 / 合入工作目录（需要租约）/ 推送并开 PR（弹审批） |
| GET | `/api/claude-code/workspaces/:id/files?ref=work\|session:<id>&path=` · `/file` · `/diff?base=&head=` | 右栏用：目录树、只读文件、diff |
| GET | `/api/claude-code/workspaces/:id/sync` | 同步状态、绑定、租约、冲突（网页和手机只读） |
| POST | `/api/claude-code/workspaces/:id/sync/force-reclaim` | 电脑离线时强制收回（二次确认） |
| GET / DELETE | `/api/cloud-workspace/permission-rules` | 「总是允许」规则 |

登录状态缓存在 `chisabot_cloud_workspaces.claude_auth`，在节点重连、`/claude/check`、以及节点在线时服务器每 5 分钟的定期复查时刷新（同一节点并发检查合并）。网页打开 Claude Code / 设置 → 云端工作区、窗口回到前台时，若缓存「未登录」或超过 60 秒，会节流地自动调 `/claude/check`（`app/src/lib/claude-auth-recheck.ts`，DESIGN.md §73.1）。

**退出 Claude**（`POST /api/cloud-workspace/claude/logout`，2026-10-22 修「退出无效」）：节点以 `claude auth status --json` 为准——先问一次确认确实登着，再跑 `claude auth logout`（最多 10 秒，卡住就 SIGKILL），然后**必须再问一次** `auth status`；CLI 没退掉（旧版没有 `auth logout`、网络卡住被超时结束、凭据没删掉）就直接删掉它自己报告的 `configDirectory` 里的 `.credentials.json`，再确认一次，还登着才回错误（页面卡片底部一行红字）。服务器在发 `logout` 之前把该节点的「登录状态代次」+1：退出之前发出、退出之后才回来的 `status` 结果一律不写回缓存，否则一次并发的自动检查会把刚退掉的账号改回「已登录」。

**设备连接上的消息**（复用同一条 WSS，旧客户端会忽略不认识的消息）

- 服务器 → 节点：v1 的 `cc_*`、`ws_clone`、`ws_tree`、`ws_read`、`ws_push`，再加 `ws_merge{session, handoffId}`、`ws_manifest`、`ws_lease{holder, handoffId}`、`sync_key_add/remove`、`sync_tunnel_open{ticket}`。
- 服务器 → PC：`sync_bind_ok{hostKey, workspacePath, epoch}`、`sync_begin{handoffId}`、`sync_end{handoffId, changed}`、`sync_force_released`、`sync_tunnel_ticket`。
- PC → 服务器：`sync_bind{workspaceId?, pubKey, mode:'pull'|'push'}`、`sync_ready{handoffId}`、`sync_released{handoffId}`、`sync_state{state, detail, checkedAt}`（来自 Mutagen 的状态，映射照搬 CCC `syncSessionInfo`）、`sync_conflicts[...]`、`sync_resolve{...}`、`sync_tunnel_request`。
- 节点 → 服务器：v1 的那些，加上 `ws_manifest_result`、`ws_merge_result`。

---

# 8. 安全模型

| 威胁 | 措施 |
|---|---|
| Claude 被注入后想控制主机 | 非 root，没有 docker.sock，没有 capability，不能开完全访问 |
| 想连数据库、保险箱、其他容器 | 独占网段，加 DOCKER-USER 和 INPUT 丢弃规则 |
| **同步用的 SSH 绕过 ufw 暴露到公网** | **sshd 只听 127.0.0.1，边车不发布端口**；唯一的入口是网关上的 `/api/devices/agent/sync-tunnel`，要一次性票，票绑定设备、工作区和绑定代号。验收：主机 `ss -ltn` 没有新的监听，`docker port` 是空的，从外网扫不到 |
| 偷到一台电脑的同步私钥 | 这把钥匙只在 gate 白名单里能用，只够得到这一个工作区，而且必须先有那台电脑的设备令牌才能拿到隧道票；撤销设备或者关闭绑定后，公钥立刻从边车删除 |
| 同步这条路碰到 Claude 凭据 | 边车不挂 home 卷 |
| 两边同时写导致丢数据 | 租约只有一个持有者，交接要有交接号；Mutagen 用 two-way-safe；开启前先对比；清空保护；交接记录读不出来不算放行 |
| 电脑上的机密被同步进云端 | 默认排除 `.env*`、`node_modules` 等；规则在新建时就给你看 |
| 偷偷推送、删远端分支 | 节点里没有 GitHub 凭据，推送只能通过审批 |
| 令牌进日志 | 授权码、令牌、API Key、隧道票不进数据库和日志；测试里专门 grep 检查 |
| 别人用 Claude 订阅 | 只有管理员能用（朋友账号看不到 Claude Code 标签页） |

**紧急停止**：结束所有 Claude 进程，断开所有同步隧道，拒绝新的轮次。

ChisaCloudCode 现在的 root + docker.sock + bypass 问题按已定的决定，**先冻结，以后再收紧，动它之前要你同意**（§10 第 5 条）。

---

# 9. 分阶段计划和验收

每个阶段一个或两个 PR，都走现有流程：tsc 和构建通过，app / server 测试和 main 比没有新增失败，预览 e2e（用模拟的 Claude CLI），聊天滚动回归 7/7，1280 亮色和 390 暗色截图检查，然后 CI → 合并 → `deploy-serial` → 生产检查。界面改动一律按 DESIGN.md，也按「原型要能点」的规则：P2 先在隔离沙盒里出一个能点的原型。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 文档** | ADR-0014「云端工作区 + Claude Code + 电脑同步」（修订 ADR-0001：左栏可以切换；写明许可边界）；BACKLOG CB-052…CB-057；`docs/cloud-claude-code.md`（本设计的公开版，去掉服务器细节）；ROADMAP | 文档合并；不部署 |
| **P1 节点 + Claude 登录** | `deploy/cloud-node/`；服务器上起容器、配对、加防火墙；节点的 `cc_login_*`；服务器的 `/api/cloud-workspace/claude/*`；设置 → 云端工作区（图 5） | 设备列表里「云端工作区」在线；`id -u`=1000；没有 docker.sock；连其他容器和主机端口都失败；`getent hosts api.anthropic.com` 返回 198.18.x；开不了完全访问；用模拟 CLI 走完登录、出错、过期、取消、退出；数据库和日志里 grep 不到授权码；**真实登录由用户自己点一次** |
| **P2 Claude Code 标签页 + 对话 + 审批** | 左栏切换；工作区和会话树（先只有「草稿」）；会话 = 聊天线程（kind `claude_code`）；ClaudeCodeAgent、流式、接着上次、停止、排队；钩子 → 审批卡、规则、审计；右栏（这一轮的 diff、只读文件）；手机底部抽屉 | 同一个会话两轮共享上下文；「新 Claude 会话」会清掉上下文；`npm test` 出审批卡，允许后执行，拒绝后 Claude 换办法；`git push` 被拒并给出提示；停止 1 秒内生效；刷新或换设备后还能接着看正在写的回答（§64）；右栏可以收起；390 宽度下抽屉能拉起、能收；亮色和暗色截图正常 |
| **P3 GitHub 工作区** | 新建（图 2 左）；`work/` + 每个会话的工作树和 `cc/…` 分支；合入工作目录；推送并开 PR；右栏的「相对 main」和「工作目录」两个视图 | 选仓库后按钮依次显示「克隆中… → 已创建 ✓」；节点磁盘上 grep 不到 GitHub 令牌；会话分支出现；改动卡和 `git diff` 一致；撤销能恢复；合入有冲突时不动 `work/`；推送要审批，允许后出现 PR 链接卡（用测试仓库） |
| **P4 电脑文件夹同步**（**要发 PC 新版**，例如 0.2.0，PC 和节点版本一起，ADR-0007） | `chisabot-sync` Go 助手（从 CCC `app/` 移入并精简）+ 自己编译的 MIT 版 Mutagen 随 PC 一起分发；边车 `cloudnode-sync` 和 gate；隧道接口；绑定、租约、交接、冲突；PC 上的「电脑上的文件夹」新建（图 2 右）和同步面板、冲突对话框（图 4）；网页和手机的只读状态，加上强制收回 | 主机 `ss -ltn` 没有新端口，`docker port` 是空的；状态按图 4 流转；电脑上改文件，几秒内云端右栏「工作目录」里能看到；交还后两份都在；暂停期间两边都改同一个文件，再开启时出冲突对话框，三个选项各验一次，**没有一次静默覆盖**；Git 分叉进冲突；PC 开着同步时点「合入工作目录」，交接 ①–⑤ 走完，电脑上正在改的文件不丢；交接中途杀掉 PC 进程，重启后按交接记录恢复，不会两边同时写；电脑离线时强制收回能用；撤销设备后隧道断开、公钥被删；首次同步 18 MB 的耗时记录下来 |
| **P5 CCC 留还是下线** | P4 上线两周后，看 CCC 的实际使用（auth.db、会话、同步记录）再决定；收紧 CCC 是单独的小任务，**动之前问你** | 按到时候的清单 |

估计工作量：P1 约 1 天，P2 1.5–2 天（大头），P3 约 1 天，P4 2–3 天（另加 PC 发版）。

---

