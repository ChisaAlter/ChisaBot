# 在线更新

ChisaBot 的共用网页、Windows / Android 外壳和服务器有各自的更新入口。服务器发布统一沿 [串行部署](ops/deploy.md)；DSH 的账号 Host、Session、备份与恢复见 [运行时运维](ops/dsh-runtime.md)，0067 / reader 4 兼容要求见 [命名迁移](ops/upstream-removal.md)。本页解释更新机制，实际部署状态见 [实施记录](pipeline-runs/20261108-assistant-production.md)。

## 1. 网页：「有新版本，点此刷新」

- 镜像构建时写 `/app/build-info.json`（版本、提交、构建号 = 镜像标签、构建时间），前端打包时同一个构建号
  经 `VITE_CHISABOT_BUILD_ID` 进入 bundle（`app/src/lib/version.ts`）。
- `GET /api/version`（`server/src/build-info.ts`）返回 `{ version, commit, buildId, builtAt }`，`Cache-Control: no-store`。
  应用里不要求登录（和 `/health` 一样只有版本信息），公网网关照常先认证会话。
- 网页每 5 分钟（页面可见时）、切回前台 / 窗口获得焦点时（距上次 ≥ 30 秒）问一次；打开后 20 秒做第一次。
  构建号不同就在顶部居中显示玻璃胶囊「有新版本，点此刷新」（`components/update-banner.tsx`，DESIGN.md §22）。
  可以关掉，同一个构建号关掉后不再提示。开发环境（`dev`）永不提示。
- **从不自动刷新。** 用户点了刷新时，如果机器人还在回复（`channel-chat.tsx` 通过 `useReportBusy` 登记），
  输入框上还挂着没发出去的附件（`composer.tsx` 通过 `useReportPendingAttachments` 登记：File 只在内存里，
  刷新就没了），或页面上有 **刷新会丢** 的没发出去的字（编辑中的消息、还没提交的审批回答——这些输入标
  `data-unsent-watch`），先弹确认框（`lib/activity.ts`），把三样会丢 / 会打断的事一起写清。聊天输入框的草稿
  不在其中：它记在 localStorage 里（`lib/chat/ui-memory.ts`，DESIGN.md §88），刷新回来还在。这里不扫整页的
  输入框：卡片表单、面板、搜索框里的字不是聊天草稿。
- 缓存：应用对 `index.html` 一律 `Cache-Control: no-cache`、带哈希的 `/assets/*` 永久缓存（直连 3001 时生效）。
  经公网网关（`/opt/chisabot-zh/public/nginx.conf`）时入口页和接口仍是 `no-store`（`cache-no-store.conf`，和 `security-headers.conf` 一起 include），入口页不会是旧的；
  例外：`location = /api/link-preview` 透传应用的 `Cache-Control`（成功 `private, max-age=600`，错误 `no-store`），上游没给时由 `$preview_cache_control` map 给错误补 `no-store`；
  **带哈希的 `/assets/*` 单独一段 `location ^~ /assets/`**：仍要登录（`auth_request`），成功响应
  `Cache-Control: private, max-age=31536000, immutable`（浏览器长期缓存，`CDN-Cache-Control: no-store` 让 Cloudflare 不缓存），
  非 200 是 `no-store`。以前所有资源都是 `no-store`，每次打开都要重新下载约 1 MB（gzip 后）的脚本。没有 service worker。

## 2. PC 客户端

- `electron-updater`（6.8.9）generic provider，更新源是一个公开目录：`latest.yml` + `ChisaBot-<版本>-x64-setup.exe`
  - `.blockmap`。目录按 `pc/src/build-config.js` 的顺序选：本机 `config.json` 的 `updateFeed` → 构建期 `updateFeed`
    （CI 变量 `CHISABOT_UPDATE_FEED`）→ `https://github.com/<owner>/<repo>/releases/latest/download/`（GitHub Releases，仓库须公开）。
    通用版（仓库 Releases 里的）就走最后一项；自建发布把自己的静态 HTTPS 目录写进 `CHISABOT_UPDATE_FEED`。
    `latest.yml` 里有安装包的 sha512，electron-updater 下载完会校验，不一致丢弃。
- **更新验签**（`docs/pc-update-signing.md`）：发布时用 Ed25519 给 `latest.yml` 签名（`chisabotSig`），客户端用内置公钥
  （`pc/src/update-keys.json`）校验并重算安装包 sha512，不通过就删掉安装包、拒绝安装（「更新包签名校验失败，已拒绝安装」）。
  公钥表为空的构建（自建版没配 `CHISABOT_UPDATE_PUBKEYS`）不验签，保持只有 sha512 的旧行为，「本机」页提示「此版本未启用更新验签」。
- **安装包没有代码签名**：`build.win.verifyUpdateCodeSignature = false`（`app-update.yml` 里就不写 `publisherName`）。
  electron-updater 6.8.9 在没有 `publisherName` 时根本不调用 `verifyUpdateCodeSignature`，`pc/src/updater.js` 里把它设成通过只是两边一致。
  代码签名（Authenticode）是第二阶段，暂缓；以后有了证书：去掉这两处，配置 `win.signtoolOptions.publisherName`。
- 行为（`pc/src/updater.js`）：开着「自动更新」（默认开）时启动 30 秒后检查一次、之后每 4 小时一次；发现新版本就在
  后台下载；下载好后弹本机窗口（`src/ui/update.html`，Skyglass 对话框）「新版本已下载，重启以安装」：
  **立即重启**（`quitAndInstall(静默, 装完自动打开)`）/ **稍后**（下次退出时自动安装）。托盘菜单多一项「重启以安装」。
- 网页 偏好设置 → 设备 → 这台电脑（「本机」标签）：「自动更新」开关、「客户端版本」行（当前 / 新版本 / 状态 / 下载进度）
  - 「检查更新」或「立即重启以安装」。关掉自动更新只停定时检查，手动检查照样能下载。
- 新 IPC 都经过来源检查：`pc:check-update`、`pc:install-update` 走 `handleWeb`（主窗口 + 顶层框架 + 已登录服务器）；
  `update:current`、`update:answer` 走 `handleLocal`（`src/ui/` 下的本机页面）。网页只能把「新版本已下载」窗口叫出来，
  立即重启要在本机窗口里由本人点。
- 只有 NSIS 安装版会更新（安装目录里有 `Uninstall ChisaBot.exe`，改名前的 `Uninstall ChisaBotPC.exe` / `Uninstall ChisaBot PC.exe` 也认）；开发运行和免安装 zip 显示「只有安装版能自动更新」。
- **版本号重置（2026-10-12）**：首个公开版本定为 0.1.0。之前内部测试过的 0.2.x 安装版不会自动“更新”到更低的 0.1.0（不允许降级），要卸载后手动装一次 0.1.0，之后正常自动更新。

### 2.1 普通更新与「重新安装」（外壳指纹）

PC 的在线更新**从来不是热更新**：每次都下载完整的 NSIS 安装包（约 100 MB），sha512 校验后运行它。问题在于
electron-updater 一定以 `--updated /S` 运行安装包，electron-builder 的安装脚本在这个模式下：

- 保留已有的桌面 / 开始菜单快捷方式（`keepShortcuts`，`allowToChangeInstallationDirectory: true` 时启用），不重建；
- 不碰任务栏固定的快捷方式；只做一次不带 `SHCNF_FLUSH` 的 `SHChangeNotify`，Windows 图标缓存（按 exe 路径 + 图标序号缓存）
  照旧。

所以 exe 里的图标虽然已经换了（0.1.1 起就是品牌头像，已对 v0.1.2 安装包实测），用户看到的桌面、开始菜单、任务栏图标还是旧的。
另外聊天窗口加载的是服务器网页，网页更新是即时的——这也是「看起来只是在线热更新」的原因。

现在分成两种安装方式：

- **外壳指纹**（`pc/scripts/shell-fingerprint.js`）：对 `build/icon.ico`、`build/icons/*.ico`、`build/installer.nsh`、`assets/icon.png`、
  `assets/tray-*.png`、`package.json` 的 `main` / `productName` / `build`（`publish` 除外）/ `electron` 与
  `electron-builder` 版本 / `NATIVE_DEPENDENCIES` 里的原生依赖算 sha256（取 16 位）。版本号、更新源、纯 JS 依赖不算。
  `npm run fingerprint` 写 `src/shell-fingerprint.json`（打进 asar）；`npm test` 先跑 `--check`，过期就失败。
  CI 打包前 `--write`，打包后 `--stamp dist/latest.yml` 给 `latest.yml` 加一行 `chisabotShell: <指纹>`
  （sha512 是安装包的，不受影响）。发布者想强制所有人重新安装时用 `--stamp dist/latest.yml --full`，多一行 `fullInstall: true`。
- **客户端**（`pc/src/updater.js` `requiresFullInstall`）：更新源的 `chisabotShell` 和本机指纹不同，或 `fullInstall: true`
  → 这次是「重新安装」：下载好后弹窗标题换成 **「此更新需要重新安装，以更新图标/组件」**，按钮「重新安装」。点了以后
  客户端自己运行下载好的安装包 `/S --force-run`（**不带 `--updated`**）：卸载旧版（保留数据，旧卸载程序拿到 `--updated`）、
  全新安装、重建桌面和开始菜单快捷方式，装好自动打开。选「稍后」时，退出 ChisaBot 的那一刻静默重新安装
  （`installOnQuit`；electron-updater 自带的退出安装会关掉，因为它一定带 `--updated`）。更新源没有 `chisabotShell`
  （旧发布）→ 普通更新。
- **安装脚本**（`pc/build/installer.nsh`，`build.nsis.include`）：每次安装（全新 / 更新 / 重新安装）结束都把还存在的桌面、
  开始菜单快捷方式按新 exe 重写（用户删掉的不再建），`SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH)`，并运行
  `ie4uinit.exe -show`（失败再试 `-ClearIconCache`）。
- **首次启动兜底**（`pc/src/shell-refresh.js`）：新版本启动 3 秒后，若打进包里的指纹和本机 `config.json` 的 `shellHash`
  不同（包括从没有这个功能的版本升上来），把指向本程序 exe 的桌面 / 开始菜单 / **任务栏固定** 快捷方式用
  `shell.writeShortcutLink(…, "update", { icon: exe, iconIndex: 0 })` 重写，再跑 `ie4uinit.exe -show`，记下新指纹，
  写一条本机记录 `shell_refresh`。
- **快捷方式图标指向按内容哈希命名的 .ico（0.1.12）**：0.1.11 在 Windows 11 上手动重新安装后，桌面 / 开始菜单 / 任务栏仍是旧图标
  ——exe 里是新图标（已解出 v0.1.11 安装包和旧名 ChisaBotPC.exe 的图标资源核对），但资源管理器按「图标文件路径 + 序号」缓存，
  exe 路径没变就继续用缓存里的旧图，`ie4uinit -show` 并不总能清掉。现在 `pc/scripts/win-icon.mjs` 生成 `build/icon.ico`
  （16 20 24 32 40 48 存 32 位 BMP，64 96 128 256 存 PNG）并按内容哈希复制一份 `build/icons/chisabot-<12 位哈希>.ico`，
  `build.extraResources` 打到 `resources/icons/`。安装脚本（`chisabotFindIcon`）和 `shell-refresh.js`（`findIcon`）把快捷方式的
  图标指向这个文件——新路径缓存里没有，必然重新读；换图标后哈希变、路径也变。安装脚本对每个快捷方式和 exe 再发
  `SHChangeNotify(SHCNE_UPDATEITEM)`。客户端每次启动都检查（`staleShortcuts`）：桌面、开始菜单 Programs（含一层子文件夹）、
  任务栏固定里**所有**指向本程序 exe 的 .lnk（不论名字），以及指向已不存在的旧安装位置里旧 exe（含改名前的 `ChisaBotPC.exe`）的 .lnk，图标不是这份
  .ico 就重写（外壳指纹没变也会修）。窗口 / 任务栏图标（`BrowserWindow.icon`）在 Windows 上也用这份多尺寸 .ico。
  换图标：改 `assets/brand/source.webp` 后 `node pc/scripts/win-icon.mjs && npm run fingerprint`（`npm test` 检查文件名和内容一致）。
- **已经装了 0.1.2 及更早版本的电脑**：它们不认识 `chisabotShell`，照旧以 `--updated /S` 运行新安装包。但新安装包里的
  `installer.nsh` 会重写快捷方式、刷新图标缓存，新版本第一次启动也会再刷新一次（它们的 `shellHash` 为空），所以不用手动重装，
  图标在这次更新后就换过来。从下一次外壳变化开始，它们已经是新客户端，走「重新安装」。
- **改名迁移（0.1.129，ChisaBot PC → ChisaBot）**：`productName` / `executableName` / `shortcutName` / `artifactName` 一起去掉了 PC 后缀，
  默认安装目录从 `Programs\ChisaBot PC` 变成 `Programs\ChisaBot`。不带 `--updated` 的安装包会在 `customInit` 里先找到旧安装的
  卸载入口（注册表 `Uninstall\cn.ayase.chisabot.pc` / `Uninstall\ChisaBot PC`，兜底默认目录下的 `Uninstall ChisaBotPC.exe`）静默卸掉再装；
  客户端启动时把 `%APPDATA%\ChisaBot PC` 整个改名成 `%APPDATA%\ChisaBot`（设备令牌、会话、本机配置不丢），旧 exe 的快捷方式经
  `LEGACY_EXE_BASENAMES` 照旧重定向到新 exe。`appId` / `APP_USER_MODEL_ID` / 更新源路径不变。

发布：推 `v*` 标签（或手动运行）触发 `.github/workflows/release.yml`：windows-latest 上 `npm ci`、`npm test`、
`electron-builder --win nsis zip --x64 --publish never`，产物（安装包、zip、`latest.yml`、`.blockmap`）上传到该标签的
GitHub Release（通用版）。配置了仓库变量 `CHISABOT_SERVER_URL` / `CHISABOT_UPDATE_FEED` 时还会多打一份「自建版」作为
工作流产物，由发布者复制到自己的更新目录（任意静态 HTTPS 目录，例如 nginx 的 `location ^~ /downloads/chisabot-pc/`，
`Cache-Control: no-cache`）。**先放安装包和 .blockmap，最后放 latest.yml**，客户端永远不会看到指向不存在文件的 latest.yml；
保留上一版的安装包和 .blockmap（差分下载）。

## 2b. Android 客户端（`android/`）

- 原生 WebView 外壳（Kotlin，minSdk 24），载入同一个 ChisaBot 网页；登录 Cookie 由 WebView 保存。
- 通用版首次运行弹「服务器地址」；以后长按桌面图标 →「服务器地址」修改。自建版可用 `CHISABOT_SERVER_URL` 预填。
- 在线更新：启动时读 JSON 更新源（`CHISABOT_ANDROID_UPDATE_FEED`，否则
  `https://github.com/<owner>/<repo>/releases/latest/download/chisabot-android.json`）：
  `{"version","versionCode","url","sha256","notes"}`；`versionCode` 更大才提示（比较的是 versionCode，不是 versionName；0.1.0 的 versionCode 是 206，高于内部测试版 0.2.x 的 205，所以已装的能正常更新），下载后校验 sha256，交给系统安装器
  （需要「安装未知应用」权限，FileProvider 提供文件）。只有同一把签名密钥的 APK 能覆盖安装。
- CI 签名用仓库 Secrets：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`；
  没配置时产出未签名 APK（文件名带 `-unsigned`，不能直接安装，需要自己 `apksigner sign`）。

## 3. 服务器：管理后台 → 系统更新

```
浏览器 ──▶ ChisaBot 容器（没有 docker socket）
             │  /api/admin/system-update（仅管理员）
             │  写 requests/<id>.json            读 state/state.json（只读挂载）
             ▼                                      ▲
   /opt/chisabot-updater/spool/requests     /opt/chisabot-updater/spool/state
             │                                      │
             └──▶ chisabot-updater（宿主机 root，systemd，python3 / python2.7）──▶ update.sh / rollback.sh
```

- 应用更新请求是 `check`、`update`、`rollback`；同一宿主服务另处理独立的 `magpie` 网关更新（宿主机还没有 Magpie 时，这个动作就是一键安装，见 [magpie.md](magpie.md#一键安装只装了-chisabot-时)）。宿主机只接受登记的动作，不执行请求里的任意字符串；`update` 只能更新到
  本机镜像 `main` 的最新提交（请求里的 `expectCommit` 必须等于它，否则拒绝「main 已经变了」），可选 `"mode": "full"` 强制完整构建。
- 发布者通过 `scripts/ops/deploy-serial.sh` 进入同一个宿主队列，页面显示进度、日志与历史。`request.sh` 是该队列的底层接口；直接调用 `update.sh` 会绕过串行发布入口，不能代替 [部署流程](ops/deploy.md)。
- 认证就是文件系统权限：`spool/requests` 归 uid 1002（镜像里的 API 用户）、700；`spool/state` 归 root、只读挂载。
  公网网关先认证会话，`/api/admin/system-update` 再要求管理员。
- 同时只有一个任务：`/opt/chisabot-updater/update.lock`（flock，更新和回滚共用）；切换 compose 时再拿
  `/opt/chisabot-zh/.deploy.lock`（和手动发布脚本同一把锁）。
- **更新来源**：本机裸仓库 `/opt/chisabot-updater/mirror.git`，每 30 分钟和点「检查更新」时从
  `https://github.com/<GITHUB_REPO>.git` 拉 `GITHUB_BRANCH`（`config.env`）。仓库公开（ChisaAlter/ChisaBot 是公开的），**匿名拉取，
  不需要令牌**；「上次检查」显示拉取时间，拉取失败时显示原因。
  - 私有 fork：放 `/opt/chisabot-updater/github-token`（root 600，**只读**的 fine-grained token，只给 Contents: Read；
    `git-askpass.sh`，令牌只在宿主机，从不进容器或前端）；
  - 不想让宿主机联网：`GITHUB_FETCH=off`，由发布者推一份到本机镜像：`git push root@<host>:/opt/chisabot-updater/mirror.git main`。
- **两种更新，update.sh 自动选**（页面上依赖变了时显示「这次需要完整构建」说明卡 + 主按钮「一键完整更新」，写着预计用时）：
  - **快速更新**（`UPDATE_STEPS`）：依赖没变，只替换代码层，约 2 分钟；
  - **完整构建**（`FULL_UPDATE_STEPS`：准备 → 检查依赖 → 备份 → 完整构建 → 导入镜像 → 切换 → 健康检查 → 完成）：`bun.lock`、
    各 `package.json`、`Dockerfile`、`docker/` 的指纹和底座不一样，或者底座镜像 / 依赖树不在了，或者当前镜像没有记录提交时。
    用仓库根目录的 `Dockerfile`（最后一段 `chisabot`）从 `ubuntu:24.04` 起完整构建：Playwright Chromium、s6、PostgreSQL 16、
    workspace 与生产依赖树使用 `bun install --frozen-lockfile --omit=peer --linker hoisted`；agent-computer 和 DSH 各用自身锁文件安装。
    构建同时包含前端（注入构建号）、`runtime/dsh`、`deploy/dsh`、`build-info.json` 与 `chisabot.commit` 标签。
    - 构建器：`docker buildx` 的 docker-container 驱动，名字 `chisabot-builder`，**内存上限 `FULL_BUILD_MEMORY`（默认 6g，不含 swap）**，
      构建期间暂停 `PROTO_CONTAINERS`；层缓存留在构建器里（超过 `BUILD_CACHE_MAX` 时修剪），所以下一次完整构建只重做变了的层。
      同时最多 `FULL_BUILD_PARALLELISM`（默认 2）步：冷缓存时 apt、`bun install`、vite 会并行，不限的话会一起超过内存上限
      （2026-10-12 第一次真实运行就因此 OOM，切换前停下、线上未受影响）；vite 用 node 跑、堆上限 3072 MB。
      完整日志在 `jobs/<任务>.build.log`，页面上显示每一步的开头和错误，内存不够时直接提示调哪个参数。
      内存上限或并行数改了，下次完整构建自动重建构建器（`.builder-config` 记着当前设置）。
    - 构建成功、切换并通过健康检查后，新镜像成为快速更新的**新底座**：写 `base.env`（`BASE_IMAGE`、`NODE_MODULES_BASE`、`BASE_COMMIT`，
      覆盖 `config.env` 同名项）、`base-deps.sha256`，并把构建时的完整依赖树（含 vite 等开发依赖，`--target updater-deps` 导出）放在
      `deps-<标签>/`（保留两份）。之后依赖不变的提交又走快速更新。没通过则底座不变，恢复必须满足当前 reader 要求。
    - 历史用时（FRA，6 核 / 24 GB，6g 上限、并行 2，2026-10-13 实测）：无缓存 358 秒（约 6 分钟，含备份），有缓存 226 秒（约 4 分钟，
      其中导出 + 导入镜像约 1 分钟）；快速更新约 60 秒。页面「预计」取最近一次同类更新的实际用时。
- **DSH 部署的 update.sh 步骤**（快速与完整构建共用切换/恢复约束）：
  1. 准备：目标提交在 `main` 上，磁盘剩余 ≥ 2.5 GB（完整构建 ≥ 12 GB）；
  2. 检查依赖：`deps-fingerprint.sh` 包含 workspace、agent-computer、DSH 的 manifest / 锁文件以及 Docker 构建文件（根 `package.json` 忽略顶层 `version`）。指纹必须等于 `base-deps.sha256`（底座构建时的指纹），
     否则自动改为完整构建（`--code-only` 时停下）；
  3. 建立更新批次：保存 `pg_dump`、compose 和实际挂载的 profiles / workspace，登记在 `/opt/chisabot-updater/backups/<时间>-<任务>/`。这是切换前初始备份；DSH 的一致性快照在排空后完成；
  4. 构建前端与镜像：导出指定源码，快速构建复用匹配的依赖树；代码层包含 `app/dist`、server、shared、中文租户、agent-computer，以及 `runtime/dsh` / `deploy/dsh`。资源上限由宿主配置确定，镜像标签为 `auto-<UTC 时间>-<提交>`；
  5. 暂停 DSH 新命令接纳并排空产品回合和 DSH 执行，超时取消切换。按部署配置保存账号 Session、水位、数据库和工作文件到同一批次的 `cutover/`，检查备份完整性和目标镜像兼容性；
  6. 写入带当前恢复守卫的回滚脚本与原镜像/Compose 记录。**候选启动前**持久保存 `.dsh-reader.json` 的最低 reader 要求，然后启动应用并协调替换账号 Host；该要求不能被健康检查失败或旧进程观测降低；
  7. `health.sh` 检查镜像身份、容器 healthy、20 秒内未重启、本机健康、DSH 就绪、reader、构建号与配置的公网登录页。部署烟雾还检查版本、能力与聚合健康；模型往返默认只告警，`STRICT_MODEL_SMOKE=1` 才作为失败。失败时尝试受兼容守卫保护的恢复；旧版 reader 不兼容或恢复仍不健康时，保持接纳暂停，报告失败并使用兼容镜像处理；
  8. 成功后释放接纳、登记新底座并轮换本更新器创建的产物。镜像与完整更新备份保留数量读取 `KEEP_IMAGES` / `KEEP_BACKUPS`（仓库默认均为 5），手工、迁移、未完成和 `.keep` 恢复批次不参加普通轮换。
- **回滚到上一版**（`rollback.sh`）：原镜像由当前版本的 `.image.before` / `compose.yaml.before` 记录确定；先检查运行时、原生历史与产品 reader 兼容性，暂停接纳、排空，再协调核心服务和账号 Host。当前数据库与 Session 不倒退。0067 / reader 4 生效后，reader 1–3 不能成为回滚目标。详见 [回滚流程](ops/deploy.md#3-回滚) 和 [DSH 恢复](ops/dsh-runtime.md)。
- 进度：脚本输出 `::step::` / `::error::` / `::result::` 标记，守护进程解析后把步骤、日志尾巴（60 行）写进 state.json，
  页面运行中每 2 秒刷新。守护进程重启（`KillMode=process`）不会打断正在跑的更新，新进程接着读日志。
- 审计：容器在请求被接受 / 拒绝时写 `configuration.changed`（`targetType: system_update`），宿主机写完一个任务后
  管理后台下次读取时补一条结果；宿主机自己另有 `/opt/chisabot-updater/audit.log`。
- 实际发布沿串行入口。更新器支持 `update.sh --job manual-xxxx --target <sha> [--full] --dry-run`（备份 + 构建，切换前停下）和 `--build-only --tag <标签>`（只构建）；这些产物仍须沿现有发布步骤完成 reader、数据与健康检查，构建成功不代表已上线。

### 安装（默认自动）

需要 root、systemd、Docker Engine + Compose v2 + **buildx 插件**（`docker buildx version`）、git、flock、curl，以及 **python3（3.6+）**——
Ubuntu 24.04 等只有 python3 的系统直接可用；没有可用 python3 的老系统（CentOS 7）退回 python2.7。`install.sh` 先找 python3、再找 python2，
把找到的解释器写进 systemd unit（老 unit 写死 `/usr/bin/python2` 的，重新运行会改成 python3）。自测：`python3 deploy/updater/test_updater.py`
（`bun test server/tests/updater-python.test.ts` 会用本机有的 python3 / python2 各跑一次）。

`deploy/start.sh` 每次都会运行 **`deploy/install-updater.sh`**（`--no-recreate --quiet`），没装或旧了就装 / 升级，所以按 README 部署的
服务器默认就有在线更新。它是幂等的，也可以单独运行：

```sh
sudo sh deploy/install-updater.sh            # 安装或升级（已是最新时什么也不做）
sh deploy/install-updater.sh --check         # 只检查：打印会做什么，需要安装 / 升级时退出码 10，不改任何东西
```

- **没装过**：按这份部署生成 `/opt/chisabot-updater/config.env`（以 `deploy/updater/config.env` 为模板）：`COMPOSE_DIR` = 仓库的 `deploy/`、
  `PUBLIC_HEALTH_URL` = `deploy/.env` 的 `CHISABOT_DOMAIN` + `CHISABOT_HTTPS_PORT`（443 不写端口；没填域名时留空 = 健康检查跳过公网登录页）、
  `GITHUB_REPO` = `git remote get-url origin` 里的 GitHub owner/repo、`FULL_BUILD_MEMORY` / `FULL_BUILD_PARALLELISM` 按物理内存（≥ 7.5 GB：6g / 2；
  更小：内存 − 1.5 GB、并行 1）。然后运行 `deploy/updater/install.sh`：脚本、`mirror.git`（从 GitHub 拉 main）、spool 权限、systemd 服务。
- **装过**：脚本或 unit 和仓库里的不一样就升级（先 `bash -n` / 编译检查，写临时文件再改名，正在跑的 update.sh 不受影响）。`config.env` 只改一处：
  `PUBLIC_HEALTH_URL` 是空的或还是示例域名 `chisabot.example.com`、而 `deploy/.env` 里有真实域名时改成真实的（原文件备份 `config.env.bak-*`）。
  有更新正在进行时拒绝运行。
- **容器没挂更新目录**（老 compose / 老容器）：`COMPOSE_DIR` 就是这个 `deploy/` 时，把 `.env` 的 `CHISABOT_IMAGE` 设成**正在运行的镜像**，
  用它重建一次容器（`up --no-build`，断开十几秒）；`COMPOSE_DIR` 是别的目录（手写 compose，例如 `/opt/chisabot-zh`）时只打印要加的几行。
- 前置条件不满足（不是 root、没有 systemd、没有 Python）时给出明确的一句话并退出（非 0）；`start.sh` 里只是提示，照常启动。

仓库的 `deploy/compose.yaml` 自带：

```yaml
volumes:
  - ${CHISABOT_UPDATER_HOME:-/opt/chisabot-updater}/spool/requests:/var/lib/chisabot-updater/requests
  - ${CHISABOT_UPDATER_HOME:-/opt/chisabot-updater}/spool/state:/var/lib/chisabot-updater/state:ro
environment:
  CHISABOT_UPDATER_DIR: /var/lib/chisabot-updater
```

没装更新服务时这两个目录由 Docker 建（root 所有、空的），页面显示「宿主机更新服务没有安装」和安装命令，请求写不进去时返回 503。

**两种 compose（`deploy/updater/compose-image.sh`）**：

- **env 模式**（`deploy/start.sh` 部署：compose 写的是 `image: ${CHISABOT_IMAGE:-…}`）：仓库里的 `compose.yaml` 从不修改，切换 = 改
  同目录 `.env` 的 `CHISABOT_IMAGE`，上一版记在 `deploy/.image.before-<新标签>`；更新成功后，仓库检出（root 所有、没有本地改动、能快进时）
  快进到这次的提交，下次手动 `start.sh` 用的也是新代码。装了在线更新后 `start.sh` 看到 `CHISABOT_IMAGE` 是 `auto-*` 就不再构建、只启动
  （避免用根 `Dockerfile` 覆盖更新器管理的同名标签）；`CHISABOT_FORCE_BUILD=1` 强制按当前检出构建 `local/chisabot:latest`。
- **compose 模式**（手写 compose，`image: local/chisabot:<标签>` 写死）：和以前一样改这一行，留 `compose.yaml.before-<新标签>`。

**镜像的来源提交**：`start.sh` 使用根 `Dockerfile` 的 `chisabot` 目标，传入 `CHISABOT_COMMIT`（工作区没有未提交改动时）等构建信息。镜像内 `/app/build-info.json` 和 `chisabot.commit` 标签用于版本显示。快速更新还需要更新器登记的底座、对应依赖树和指纹；缺少这些材料时完整构建，不能只凭镜像来自同一 Dockerfile 就跳过依赖检查。

**健康检查地址**：`PUBLIC_HEALTH_URL` 为空或还是示例域名时 `health.sh` 跳过公网登录页检查（日志里写明），不会因为它把好好的新版本回滚掉；
页面上显示提示，教你改。

**自升级**：一次更新成功后，`update.sh` 运行新提交里的 `deploy/updater/install.sh --scripts-only`：只换 `/opt/chisabot-updater/` 下的脚本
和 unit（不碰 config.env、mirror、compose），守护进程发现自己的文件变了、手上没有任务时重新 exec 自己。装了 v3 以后更新服务跟着仓库走，
不用再手动升级。v3 之前的更新程序没有这个钩子，要手动运行一次 `sudo sh deploy/install-updater.sh`（页面会提示「更新程序是旧版本」）。
（unit 换了解释器时 `--scripts-only` 只 daemon-reload，下次服务重启才生效；`install-updater.sh` 会直接重启。）

**页面上的几种状态**（管理后台 → 系统更新）：

| 状态                   | 原因                                                                                           | 页面给的命令                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 还没装宿主机更新服务   | 容器没有 `CHISABOT_UPDATER_DIR`（老 compose）                                                  | `cd <仓库> && git pull && sudo sh deploy/install-updater.sh` |
| 宿主机更新服务没有安装 | 挂了目录，但 state.json 从没写过                                                               | 同上                                                         |
| 更新程序离线           | state.json 超过 2 分钟没更新                                                                   | `sudo systemctl restart chisabot-updater`，不行再重装        |
| 更新程序是旧版本       | state.json 的 `updaterVersion` < 3                                                             | 同第一行（不重建容器）                                       |
| 配置提示               | `warnings`：`health_url_example` / `health_url_missing` / `compose_missing` / `buildx_missing` | 说明怎么改                                                   |

`<仓库>` 取容器环境变量 `CHISABOT_SOURCE_DIR`（`start.sh` 写进 `deploy/.env`），没有就按 README 的 `/opt/chisabot-src`。

### 老部署怎么升级到可一键更新

2026-10-13 之前部署的服务器（当时在线更新是可选的第 7 步）多半没装更新服务，系统更新页是空的、收不到更新。在服务器上运行一次：

```sh
cd /opt/chisabot-src && git pull && sudo sh deploy/install-updater.sh
```

然后 管理后台 → 系统更新 →「检查更新」→「一键完整更新」（第一次完整构建，约 4–8 分钟；小内存机器更久，先加 swap）。
已经装了旧版更新程序的（页面显示「更新程序是旧版本」，或在 Ubuntu 24.04 上因为没有 python2 根本起不来）运行同一行即可：
升级脚本、unit 改用 python3、修正示例域名，不重建容器。之前手工改过 `chisabot-updater.py` / unit 的，这一步会用仓库版本覆盖（已经兼容 python3）。

手动安装（不用 install-updater.sh）仍然可以：编辑 `deploy/updater/config.env` 后在 `deploy/updater/` 下 `bash install.sh`，
再自己给 compose 加上面的挂载。已经有压平底座的老部署：`bash install.sh <底座对应的提交>`（写 `base-deps.sha256`，`NODE_MODULES_BASE` 放一份与 bun.lock 一致的 node_modules）。

依赖或底座变了（指纹不符）：更新器会选择完整构建；页面可点「一键完整更新」，发布者仍通过 [串行部署入口](ops/deploy.md) 请求更新。

回滚完整更新与快速更新使用同一条受保护的恢复路径：管理后台「回滚到上一版」，或核对过 reader 守卫的当前生成脚本。保留现有数据库与 Session；若旧版不兼容，使用兼容镜像恢复。`base.env` 是之后构建的底座记录，不用于绕过数据读取器要求；不要通过修改指纹伪装依赖兼容。存量卷固定与数据库身份兼容见 [命名切换与存量资源兼容](ops/upstream-removal.md)。

### 当前 Compose 网络

新安装默认网络为 `${CHISABOT_NETWORK_NAME:-chisabot-zh_default}`，默认子网 `172.19.0.0/16`、网关 `172.19.0.1`。存量安装由 `deploy/pin-resources.sh` 固定实际卷和网络，DSH Host / targets 按 [DSH 运维](ops/dsh-runtime.md) 接线。更新程序发现运行中容器不在 Compose 声明的默认网络上时会自动执行 `--force-recreate`；当前 DSH 恢复必须先经过上述 reader / Session / 账号 Host 守卫，不能直接修改镜像变量后裸跑 `docker compose` 绕过检查。
