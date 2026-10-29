# DEVLOG

## 回复风格对齐 Hark（feat/reply-style-hark）

**动机**：同一组 12 条消息分别发给 Hark 和 ChisaBot（v0.1.105，GPT-6-Luna）对比，ChisaBot 的问题集中在“说话方式”：
- 回答总是套「短导语 → 卡片 → 下一步建议」三段式，简单问题也被拉长成 3 个气泡；Hark 默认一个气泡、结论先行。原因就是 WORK_STYLE_GUIDANCE 里那条“必须采用三段式”。
- #5（参数对比表）：render_ui 画了表格卡，后面又用 Markdown 把同一张表写了一遍。
- #11（500 元以内降噪耳机）：搜了 8 次，一个型号都没给，最后反问“入耳还是头戴”。步数提醒要到第 10 次工具调用才出现，太晚；提示词里也没有“推荐题要收敛”的说法。
- #9（解方程）：输出 LaTeX（\[ … \]、\boxed），前端早已把 katex 换成空壳，所以原样显示成乱码。前端不恢复 katex（体积），改成让模型用 Unicode。

**改法**：
- shared/bot-prompt.ts：WORK_STYLE_GUIDANCE 改长度规则（默认 1 个气泡 1–4 句），删三段式那条，换成“长内容才用 doc 卡 / 文件，下一步建议有用才写”；render_ui 那条加“画过表格就不再写 Markdown 表格”；新增“推荐题”和“数学”两条。
- server/src/generative-ui/render-ui.ts：成功结果里加一句“画了表格就不要再写一份 Markdown 表格”。服务端不去删流式正文里的表格：文字已经流到浏览器，事后删会让界面和历史不一致，不安全。
- server/src/copilot.ts：withSearchBudget，按 run 数 web_search 次数，第 3 次起在结果后附收敛提醒，超过 5 次不再真的搜，直接让模型作答。
- 安全相关（UNTRUSTED_GUIDANCE、PROVENANCE_GUIDANCE、COMPUTER_GUIDANCE、NO_ANSWER_CAME）一字未动；server/tests/reply-style.test.ts 按改动前的 sha256 钉住，并检查内置机器人的提示词里仍有它们。

## SW 导致登录 state_mismatch（fix/sw-auth-navigation）

**现象**：开着 Service Worker 时，Chrome 登录最后落到 `/api/auth/error?error=state_mismatch`，但会话其实已经写入；屏蔽 SW 后正常，main 上也能复现。

**根因**：`app/public/sw.js` 在 activate 里 `navigationPreload.enable()`。preload 是浏览器对**每个**导航先发的请求，并不只限于 SW 要拦的那些，所以 `/api/auth/callback` 也会先被预请求一次。这个请求到达服务器，写好会话并消费掉 state。而 sw.js 对 `/api|/auth|/sign-in…`（`SKIP_NAV`）的导航不调 `respondWith`，此时 Chrome 会丢弃 preload 的响应，回退成普通网络请求再发一次；第二次 state 已经没了，于是 state_mismatch。

注意：「丢弃 preload 响应再发一次」是按 Chrome 的行为推断的，没有在真实浏览器里复现，需要测试 bot 在 Chrome 里确认 callback 只发一次。

**改法**：
- activate 改成 `navigationPreload.disable()`。preload 的开关存在 registration 上，换了 sw.js 也不会自己关，所以要显式关。
- `SW_VERSION` 从 2 改成 3。sw.js 内容变了，浏览器本来就会更新；资产缓存名不变，没有必要清缓存。
- 普通页面导航照旧在 SW 里 `fetch` 一次。如果激活前那一刻还有 preload 响应，就直接用它，不再发第二次。
- `SKIP_NAV` 路径照旧不 `respondWith`，由浏览器自己发一次。

**为什么不选「对跳过的路径 respondWith(preloadResponse)」**：那样认证回调就要经过 SW 转交，违背「/api 一律不拦」的原则。关掉 preload 的代价只是普通页面导航多等一次 SW 启动（几十毫秒），可以接受。

**测试**（`app/tests/sw-navigation.test.ts`）：
- `/api/auth/callback` 等路径的导航不 respondWith、SW 不 fetch；
- 激活时只调用 disable；
- 普通导航只 fetch 一次；
- 有 preload 响应时用它、不再 fetch。

## 审计 #5：nginx 真实 IP + 网关身份头防重放（fix/nginx-realip-gateway-replay）

**真实 IP。** 公网入口是 Cloudflare → nginx，`$remote_addr` 原来是 Cloudflare 边缘节点：`limit_req` 按边缘 IP 限流（一个节点后面的所有人共用额度、单个攻击者换节点就绕过），`X-ChisaBot-Client` / `X-Forwarded-For` 给应用的也是边缘 IP。现在 http 块里 `real_ip_header CF-Connecting-IP`，`set_real_ip_from` 只列 Cloudflare 官方 v4/v6 网段（https://www.cloudflare.com/ips/ ，2026-10-29 取）。不是从这些网段来的连接带的 `CF-Connecting-IP` 不被采信，所以绕过 Cloudflare 直连源站也伪造不了 IP。没有加 `real_ip_recursive`，CF 只给一跳。`scripts/ops/check-trust-boundary.sh` 和 `server/tests/trust-boundary-redline.test.ts` 检查指令与每个网段都在、且没有 `0.0.0.0/0` / `::/0`。Cloudflare 改网段时要同步改这三处。

**真实 IP（补充：别让客户端自带的头漏到应用）。** realip 只改 `$remote_addr`，nginx 默认仍把客户端发来的 `CF-Connecting-IP` 原样转给上游。绕过 Cloudflare 直连源站的人可以随便填这个头；应用如果读它，就能伪造 IP。IM OneBot 反向连接的失败限速原来就先读 `cf-connecting-ip`，换着填就能无限试 token。

- nginx：每个转发 location（14 个，含 Magpie 那个 server）都 `proxy_set_header CF-Connecting-IP ""` 清掉它，并 `proxy_set_header X-Real-IP $remote_addr`（realip 处理后的真实 IP）。nginx 的 `proxy_set_header` 不从外层继承（location 里只要写了一条就全不继承），所以逐个 location 写，不放在 server 级。
- 应用：新增 `gatewayClientIp`（`server/src/auth/gateway-identity.ts`）：X-Real-IP 优先，其次 X-Forwarded-For 第一段，从不读 CF-Connecting-IP；直连（不经网关）为 null。设备令牌限速（原 `devices/routes.ts` 自己的 `clientIp`）和 IM OneBot 失败限速都改用它，不再各写一份。
- 检查：`check-trust-boundary.sh` 用 awk 逐个 location 检查「有 proxy_pass 就必须两条都有」；`trust-boundary-redline` 测试用 `nginxPinsClientIpHeaders`（`shared/trust-boundary.ts`）做同样的检查，另有一条反例。
- 测试：`server/tests/im-onebot-rate-limit.test.ts`：换着伪造 `CF-Connecting-IP` 绕不过限速，伪造别人的 IP 也不会把别人拖进限速，计数键始终是网关给的真实 IP。
**防重放。** 身份头本来只靠 ±2 分钟时间窗：窗内截获的头（日志、代理、调试抓包）可以原样重放。

- 网关（`deploy/public/auth/server.ts` 的 `signIdentity`）和应用里的 `signGatewayIdentity` 在 payload 里加 `j`（16 字节随机数，base64url）。没有它的话，同一用户同一毫秒的两个并发请求会签出完全相同的头，按签名去重就会误拒正常请求。
- `GatewayReplayCache`：键 = 整个头的 SHA-256，过期 = 签发时间 + 2 分钟（之后 verify 本身就拒绝），上限 10 万条。满了先清过期的，仍满就丢最早的：宁可极端洪峰下少记几条，也不让内存无限涨或误拒正常用户。
- **在哪里消费**：只在 `serve()` 的 `fetch` 入口每个 HTTP 请求消费一次（含 WebSocket 升级）。应用内同一个请求会被 resolve 好几次（守卫中间件、CopilotKit 的身份和权限各一次、WebSocket 手动守卫），如果在 `resolveGatewayRequest` 里消费，第二次就会把自己当重放。`resolveGatewayRequest` 保持无状态。
- **兼容**：网关每个请求都是现签的（nginx `auth_request` 每个请求一次），正常请求不会出现同一个头两次。不带 `j` 的旧格式（升级前的网关签的）照旧放行、不去重，滚动升级不会断；网关升级后旧头最多 2 分钟就全部过期。
- **窗口没缩短**：有了一次性检查，窗口长短只影响缓存大小，不再决定重放面；网关和应用在同一台机器上，2 分钟留给时钟漂移和慢请求足够也不算多，缩短反而可能误拒长排队的请求。
- **防重放的边界（运维须知）**：
  - **只在内存里**：去重记录在应用进程内存里，不落盘。应用重启后清空：重启前签发、还没过期的头（最长 2 分钟）重启后可以再被用一次（前提是已经被截获）。
  - **多实例各记各的**：几个应用实例之间不共享，同一个头可以在每个实例上各用一次。现在只有一个应用进程；以后若横向扩容，要么把去重挪到共享存储（同样的 TTL），要么让 nginx 把同一会话固定到同一实例。
  - **上限 10 万条**：每个请求一条、TTL 2 分钟，大约对应持续 800 req/s。满了先清过期的，仍满就丢最早的：极端洪峰下可能漏记几条，换来内存有界、不误拒。
  - **旧格式过渡**：不带 `j` 的旧格式现在照旧放行，为了滚动升级不断。过渡期结束（确认网关都已升级）后会加一个开关，拒绝不带 `j` 的头，届时旧格式直接 401。

## Unreleased — CI：Biome 只拦新增、完整 test:app、pc/ 安装构建（审查清单第 3 项）

### 动机

- 全仓 Biome 有上千个存量 error，CI 里一直没跑 Biome，新代码的问题也没人拦；一次改全仓风险太大。
- CI 只跑挑出来的 app 测试子集，其余 app/tests 文件改坏了没人发现。
- pc/ 是独立 npm 项目，平时 CI 只跑它的 node 测试；chisabot-node 无头包只在 app 构建里顺带打，失败时仅打印警告（默认 isolated linker 下 `ws` 解析不到会静默跳过）。

### 改动

- `scripts/biome-new-issues.ts`：取基线（默认 origin/main 的 merge-base）与当前工作区之间新增/修改/改名的文件和未跟踪文件，把基线版本连同基线的 biome 配置写进临时目录，两边各跑一次 `biome check --reporter=json`，按「文件 + 规则」比较 error/warning 数，变多就退出 1 并列出新增诊断（在 GitHub Actions 里输出 `::error` 注释）。存量问题不拦，顺手修掉的只会让数变少。
  - 局限：同一文件同一规则里「修一个、新增一个」数不变，拦不住；格式问题 Biome 每个文件只报一条。
- `.github/workflows/chisabot.yml` 新增三个 job：
  - `biome`：`fetch-depth: 0`，PR 以目标分支 base sha、push 以 `github.event.before` 为基线（没有基线时退回 HEAD^1）。
  - `app-tests`：hoisted 安装后跑 `bun run test:app`。web-and-models 里原有的子集保留不动。
  - `pc-build`：在 pc/ 里 `npm ci`（跳过 Electron 二进制下载），用和 `app/vite.config.ts` 里 chisabotNodeBundle 相同的 esbuild 参数打包 `src/headless.js`，`node --check` 并比对 `--version` 与 pc/package.json。pc/ 保持独立，不进 workspaces / 主构建；带 Electron 的 Windows 安装包仍由 release.yml 打。
- 不改任何版本号。

### 已知情况

- `test:app` 目前在 main 上会红：共享进程里有测试互相干扰，另有几个文件单独跑也失败。根因修复在 `fix/test-isolation` 分支，合入后这个 job 才会绿。

**回归后加固（小爱复查）**：
- 放行漏洞：原来 Biome 没输出 JSON（例如 biome.json 写坏、二进制出错）时，脚本直接 `continue`，最后算出「没有新增」、退出 0。现在只要退出码非 0、又解析不到 `diagnostics` 数组，就退出 2。
- 原来在 `try` 里调 `process.exit`，`finally` 不执行，`/tmp/biome-base-*` 会残留（本机临时目录里找到 10 个旧目录，已清掉）。现在整段包成 `run()`，返回退出码；入口只设 `process.exitCode`，所以临时目录总会被清理。
- 用法注释里原来写「CI 用 HEAD^1」，实际 workflow 传的是 PR base sha / push before，两者都没有才退回 HEAD^1。注释已改成一致。
- 测试 `scripts/biome-new-issues.test.ts`：在临时 git 仓库里覆盖五种情况，每个用例都断言临时目录被清理：
  - 正常改动、没有新增 → 0；
  - 加 debugger → 1；
  - biome.json 写坏 → 非 0；
  - 假 Biome 退出 3 且不输出 → 2；
  - 二进制不存在 → 失败。
- 实测：
  - 在本仓库跑一遍：没有新增，退出 0；
  - 临时写坏 biome.json：parse / deserialize 诊断变多，失败（之后已还原）；
  - 临时加 debugger：`noDebugger` 0 → 1，失败。
- 追加（复查）：
  - **默认 `error` 自递归**：`const error = options.error ?? ((line) => error(line))`，箭头函数里的 `error` 指向它自己。没传回调时（CI 和命令行入口都不传），一旦要输出错误（有新增问题、Biome 出错、git 出错），就无限调用自己。JSC 对严格模式的尾调用不加栈，所以不是爆栈而是卡死：旧脚本在子进程里 60 秒超时也没退出。之前的测试都传了 `log` / `error` 回调，所以没测出来。默认值改为 `console.error`；`log` 默认是 `console.log`，没有这个问题。
  - **找不到可执行文件**：`Bun.spawnSync` 遇到不存在的可执行文件直接抛错（ENOENT），不返回退出码，原来一路抛到入口、退出 1，和注释写的 2 不一致。现在 git 和 Biome 的启动都包一层，抛错转成内部失败、退出 2，报「启动不了 Biome / git」。
  - **测试**：新增 3 个子进程用例：`bun -e` 导入脚本、调用 `run()` 时不传回调，超时 60 秒，TMPDIR / TMP / TEMP 指到独立目录：
    - 有新增问题 → 退出 1，stderr 列出文件和 `noDebugger`；
    - 假 Biome 出错 → 退出 2，stderr 带原因；
    - 找不到 Biome → 退出 2。
    三个用例都断言没有残留的 `biome-base-*`。原「二进制不存在」用例改为断言 2。用旧脚本跑：前两个超时（退出码 null），后两个退出码 1；新脚本 8 个全过。

## Unreleased — test:app 测试干扰与过时测试（审查清单第 3 项第二部分）

### 动机

审查时记录 test:app 共享进程有 319 个失败。现在 main 上实测（Windows）：共享进程 1644 pass / 7 fail（212 个文件），隔离名单里 startup-resilience 1 fail；另有 5 个 server 测试单独跑也失败。

### 根因和改动

- **control-poll-single-source（干扰，2 个）**：`use-control.ts` 的 `listenForWake` 用模块级布尔值，只给第一个页面挂 focus/online/pagehide/pageshow 监听。GlobalRegistrator 每个文件换一个 happy-dom 窗口，并把新窗口的成员拷到同一个 globalThis 上，所以 `window` 看起来没变，`addEventListener` 和 `document` 却已经是新窗口的。监听永远挂在旧窗口上，后面的文件派发 focus 叫不醒 store。改为记住接监听时的 `window.document`，换了就重新挂；浏览器里页面不换，行为不变。
- **self-host-banner（app，干扰，1 个）**：`schedule-runs-query.test.ts` 用 `mock.module("@/lib/client")` 把 client 整个换成「永远返回一个日程」。Bun 的 mock.module 是进程级的，而且换不回来，排在后面的 self-host-banner 点关闭后，偏好被这个返回值覆盖，横幅又冒出来。改为在该测试里给 fetch 打桩并在 afterEach 还原。
- **gateway-account-control（单独跑也失败，4 个）**：happy-dom 20+ 默认禁用 JS 求值，Bun 下 VM 上下文里也没有 `eval`。改为 `new Function("window", "document", script)` 执行登录网关脚本，并在 afterEach 关闭窗口（脚本起了 45 秒的 setInterval）。
- **startup-resilience（单独跑也失败，1 个）**：v0.1.102 起根组件还会请求 `/wallpaper_core.html`，覆盖了测试里挂起的 `/api/me` 回调。测试只挂起 `/api/me`，其余请求返回 404。
- **server 测试（与现行行为不符）**：
  - guards：`/api/me` 多了 `profileNeedsSetup`（bd06cf50）。
  - user-preferences-routes：默认偏好多了 `mainBotId` / `brandAccent` / `brandRest`（79f6bf71）。
  - approvals-frontend：报错文案已改成中文「活跃会话」。
  - self-host-banner：横幅不再是 createApp 的最后一个参数，改为按参数名找位置。
  - bot-lifecycle-audit：**测试过时，不是代码 bug**。a1b235fd 起机器人一律私有（`server/src/agents/routes.ts` 固定 `visibility = "private"`，DESIGN.md「所有的机器人都是私有」），审计记录存下来的值 private 是对的。
- **server/package.json**：`local-conversations-inbox.integration.test.ts` 直接 import `@copilotkit/core`，补成 devDependency，版本取 lock 里已有的 1.77.0。
- **app/vite.config.ts**：chisabot-node 打包失败时，在 CI（环境变量 CI 非空）里直接让构建失败，其他地方照旧只告警。默认 isolated linker 下 `ws` 解析不到会静默跳过；CI 与镜像一样用 hoisted，在这里失败就说明镜像也会缺文件。本机和 Docker 构建行为不变。
- db-client-address 需要真实数据库，按要求跳过。

- 追加（小爱复查）：Linux 共享进程里 `agent-roster-error.test.tsx`「each Bot on /bots links to its profile and to its chat」挂，原因是 `schedule-fired.test.tsx` 把 `@tanstack/react-router` 的 `Link` 进程级地 mock 成丢掉 aria-label 的 `<span>`。已把它加进 `scripts/run-app-tests.ts` 的隔离名单，并把替身改成把所有 props 透传给 `<a>`（href = href ?? to）。两份文件同进程两种顺序都过，全量 `test:app` 通过。
- 追加（第二次复查）：
  - **schedule-fired 的 Link 替身**：上一版替身直接把 `to` 当 href，没用 params 填 `$agentId`；能过只是因为进了隔离名单。用 `bun test A B` 实测，bun 按命令行给的顺序跑文件：schedule-fired 在前时，agent-roster-error 期望 `/bots/mine-1`，实际拿到 `/bots/$agentId`。现在替身先 `useRouter({ warn: false })`：有 RouterProvider 就直接渲染真 `Link`（mock.module 会原地改写模块命名空间，所以 mock 之前先存住真的 `Link` / `useRouter`）；没有路由（本文件就是）才渲染 `<a>`，props 透传，href 用 params 填路径参数。已从隔离名单移出，两种顺序同进程都过。
  - **avatar-picker-shape 的 2 个 Unhandled error**：报错其实是 `window is not defined`（react-dom 在被动 effect 回调里读 `window.event` 时 window 已经没了），不是 window.event 的定义问题。最后一个用例被 cleanup 卸载时，React 已经往调度器排了被动 effect 回调（bun 下是 setImmediate）；`afterAll` 紧接着 `GlobalRegistrator.unregister()` 删掉了 window，回调晚一拍才跑。其他 React 测试文件都在 unregister 前 `await settleReactWork()`，这份漏了。补上后错误消失，没有屏蔽任何错误。
  - 验收：`bun run test:app` 和 `CI=1 bun run test:app` 都 0 失败、退出码 0。

## 2026-10-29 修复干净安装：补声明 @json-render/* 等缺失依赖（分支 fix/json-render-deps）

### 动机

- main 干净安装时是坏的：全新克隆后执行默认 `bun install`（Bun 1.3 对 workspaces 默认使用隔离 linker），`bun run typecheck` 在 server 阶段即失败：
  `shared/json-render/catalog.ts: Cannot find module '@json-render/core'`、`'@json-render/react/schema'`，`empty-sections.ts`、`panel-title.ts` 同样报错。
- 原因：`shared/` 不是 workspace，由 app 与 server 以相对路径引入。隔离 linker 下其中的裸导入只会沿目录向上解析到根 `node_modules`，而 `@json-render/*` 只在 app/server 的 package.json 中声明，根没有。hoisted linker 会把它们提升到根，所以此前只有 `--linker hoisted` 能跑通。
- 修好 server 之后，app typecheck 在隔离 linker 下暴露了同类问题：`app/tests/*` 直接 import `@ag-ui/client`、`rxjs`，`app/vite.config.ts` 构建时动态 `import("esbuild")`，但 app 都没声明它们（以前靠 hoisted 从别的包间接拿到）。esbuild 这一步包在 try/catch 里，解析失败时会被静默跳过，构建产物会缺少 pc headless 脚本。

### 改动

- 根 `package.json` 的 `dependencies` 增加 `@json-render/core`、`@json-render/react`，版本 `0.21.0`，与 app/server 及 lockfile 中已解析的版本一致。
- 这沿用仓库已有约定：`shared/` 用到的第三方包（`css-tree`、`parse5`、`zod`）本来就声明在根 `package.json`。没有把 `shared` 改成独立 workspace 包，以免改动所有相对导入路径和 workspace 配置。
- `app/package.json` 的 devDependencies 增加 `@ag-ui/client` 1.0.1、`rxjs` 7.8.1、`esbuild` 0.28.2，均为 lockfile 中已解析的版本：前两者与 server 的声明一致，esbuild 与 vite 实际使用的一致。只有测试和构建配置用到它们，所以放在 devDependencies。
- `bun.lock` 只在 workspace 声明区增加上述条目，没有新增或变更任何包解析结果，`bun install --frozen-lockfile` 可以通过。
- 未修改任何版本号。

### 验证

- 全新克隆、不复制 node_modules，用默认 `bun install` 与 `bun install --frozen-lockfile` 安装后，`bun run typecheck`、server build、app build 全部通过。
- 已知遗留（不在本 PR 范围）：`pc/` 是独立的 npm 项目（自带 package-lock，不在 Bun workspaces 内）。如果没有单独在 `pc/` 执行安装，app build 中 best-effort 的 chisabot-node 打包步骤会因解析不到 `ws` 而打出 warning 并跳过，但 app build 本身仍然成功。本 PR 修复后，这一步至少能加载 esbuild，并给出明确的跳过原因。

## 2026-10-29 出口过滤代理按 Bot 独立鉴权（分支 `fix/egress-auth-hardening`）

### 动机

审计（2026-10-28）H1 / L1：

- 出口过滤代理（agent-computer 内 127.0.0.1 上的 HTTP 代理）所有 Bot 共用同一个密钥，且 `botFromProxyAuthorization` 在密码为空时直接放行：任何进程写 `http://<别的botId>:@127.0.0.1:<port>` 就能按别的 Bot 的放行名单出网（v0.1.93 起 shell 本身就是这么发的）。
- 无凭据连接按「本机所有 Bot 策略」判定，单 Bot 电脑上等于按那个 Bot 判定。
- `0.0.0.0/8`、`100.64.0.0/10` 不在硬拒绝网段内。
- 服务器发往电脑 `/exec` 的 body 一直不带 botId，服务器发起的命令实际都走无凭据路径。

### 改动

- `agent-computer/src/egress.ts`
  - `botProxyKey`：HMAC-SHA256(进程内随机主密钥, `chisabot-egress-proxy:v1:` + botId)；`egressFor`（浏览器）与 `egressShellEnvironmentForBot`（shell）都用它。
  - `proxyCallerFrom`：凭据三态。无头 → anonymous；正确派生密钥 → bot；其余（非 Basic、无 botId、空密码、错误密码、A 冒充 B）→ rejected，直接 403，不降级。
  - `anonymousPolicies` / `ANONYMOUS_EGRESS_POLICY`：无凭据的独立兜底，只放行 `DEFAULT_EGRESS_DESTINATIONS`；只读各 Bot 的 mode 做上限（任一 `allowlist_only` / `deny_all` 即拒绝），从不读任何 Bot 的 rules，不用 Bot 的上游代理。集中在一个函数里，方便以后改成直接拒绝。
  - `noteAnonymousEgress`：节流日志 `EGRESS_ANONYMOUS`（每 60 秒逐条最多 5 条，其余计数），只记来源 socket 与目标 host:port，不记凭据。
  - `ALWAYS_DENIED` 新增 `0.0.0.0/8`、`100.64.0.0/10`。
- `agent-computer/src/index.ts`：`/exec` 在 body / query 无 botId 时回退到 `x-chisabot-bot-id` / `x-openbot-bot-id` 头，不回退到 `DEFAULT_BOT_ID`。
- `server/src/computer/gateway.ts`：`runCommand` 发往 `/exec` 的 body 带上网关自己的 `botId`。
- 测试：新增 `agent-computer/tests/egress-auth.test.ts`；更新 `egress-policy.test.ts`、`server/tests/command-timeout.test.ts`。

### 兼容

- 不新增环境变量；主密钥每次进程启动随机生成、只在内存。电脑重启后旧代理凭据失效。
- 不升版本号。

## 2026-10-29 — 安装版 `/api` 代理的 Content-Encoding

**动机**：性能实测（`chisabot-perf-2026-10-28`）发现，本地用 `bun serve.ts` 时 `/api/me` 直接失败，浏览器报 `ERR_CONTENT_DECODING_FAILED`。原因是 Bun 的 `fetch` 会自动解压上游 gzip 响应，而 `app/serve.ts` 把上游 `Response` 原样返回，保留了 `Content-Encoding: gzip` 和压缩后的 `Content-Length`。安装版 PC 客户端走的就是 `serve.ts`。

**改动**：

- 新增 `proxiedResponseHeaders()`：复制上游响应头，删掉 `content-encoding`、`content-length`，以及逐跳头 `transfer-encoding`、`connection`（及其列出的头）、`keep-alive`、`proxy-connection`、`trailer`、`upgrade`；`Set-Cookie` 用 `getSetCookie()` 逐条追加，多值不合并。
- `/api` 转发改为用上游的 body / status / statusText 和上述头重新构造 `Response`，body 仍是流式，不缓冲。
- `app/tests/serve.test.ts` 新增两条测试：头过滤单测；起一个返回 gzip 的上游假服务器，经真实 `serve.ts` 进程代理后，客户端能解析 JSON、无 gzip 编码头（含关闭自动解压直接读原始字节）、两条 `Set-Cookie` 都在。

**未改**：WebSocket 转发、静态文件、版本号。

## 2026-10-29 发版 0.1.104

**合并的 PR**（按顺序，全部为 merge commit，未 rebase）：

- #365 `fix/json-render-deps` → `1c82f69`：干净安装（Bun 默认隔离 linker）下 `shared/json-render` 解析不到 `@json-render/*`，app 测试 / `vite.config.ts` 用到的 `@ag-ui/client`、`rxjs`、`esbuild` 也没声明，typecheck / build 只能靠 hoisted linker 才过；补声明，lockfile 解析结果不变。
- #364 `fix/egress-auth-hardening` → `6b155c8`：审计 H1 / L1——出口过滤代理原来所有 Bot 共用凭据，空 / 错密码会降级放行；改为 HMAC 派生的每 Bot 密钥，伪造一律 403，无凭据连接走不含 Bot 放行名单的兜底策略，硬拒绝补 `0.0.0.0/8`、`100.64.0.0/10`。
- #363 `perf/ui-render-budget` → `079c3aa`：性能审计发现卡顿主要来自同屏 14 层毛玻璃、空闲时也满帧重画的 WebGL 天空、驱动 layout / paint 的无限动画；收到渲染预算内（桌面同屏模糊层 14 → 4），不改布局和配色。
- #367 `fix/serve-proxy-content-encoding` → `0f0e356`：安装版 `app/serve.ts` 把 Bun 已解压的响应仍带着 `Content-Encoding: gzip` 转发，`/api/me` 报 `ERR_CONTENT_DECODING_FAILED`；转发前去掉编码 / 长度和逐跳头。
- #369 `feat/hark-tokens` → `8a93056`：Hark 改版第 1 步，只落令牌（深 / 浅两套、Inter Variable、唯一玻璃材质 `.glass`），玻璃参数沿用 #363 的预算。原 base 为 `perf/ui-render-budget`，#363 合入后改 base 为 main，diff 只有本 PR 的两个提交。

**冲突**：#364、#363、#367、#369 与 main 只在 `CHANGELOG.md`、`docs/CHANGELOG.md`（及 #364 / #367 的 `docs/DEVLOG.md`）冲突，均在 merge commit 里保留双方条目；DEVLOG 去掉了 #367 带来的重复一级标题。没有代码文件冲突。

**验证**：合并后的 main 上干净安装（`bun install --frozen-lockfile`）后 `bun run typecheck` 通过；相关测试（render-budget、sky-window、serve、egress-auth、egress-policy、command-timeout）109 pass / 0 fail。

**版本**：根、`app`、`server` 升到 `0.1.104`；PC / Android 不变（五个 PR 均未改 `pc/`、`android/`）。不打 tag、不发 Release。

**部署**（2026-10-29 04:10–04:22 北京时间）：部署前手动跑 `backup.sh`（`daily/20261029.dump`，767 条目）；`deploy-serial.sh ed93b05` 全量构建，镜像 `local/chisabot:auto-202610282010-ed93b05`，`/api/version` 为 `0.1.104` / `ed93b05`。`health.sh` 通过（容器 healthy、本机 `/health` 200、公网 `/login` 200），`request.sh smoke` PASSED（admin 模型自检 `ok:true persisted:false`），sidecar 隔离 ALL GREEN，未回滚。回滚目标 `auto-202610281801-d6cd2ec`；保留镜像：当前（即 BASE_IMAGE）ed93b05、上一版 d6cd2ec、`keep-628d527`，48edb21 已被 updater 按 `KEEP_IMAGES=1` 清理。

## 2026-10-29 发版 0.1.105

**合并的 PR**（按小爱给的顺序，全部为 merge commit，未 rebase、未强推；合并前核对 head 与审查时一致）：

- #368 `fix/test-isolation`（head `9c86a88`）→ `bcae53b`：修 `test:app` 共享进程里的测试互相干扰和 5 个过时的 server 测试，`test:app` 退出码恢复 0。与 main 无冲突，直接合并。
- #366 `fix/ci-biome-tests`（head `76c36bc` → `7f4f213`）→ `eaad514`：CI 新增 Biome「只拦新增问题」、完整 `test:app`、pc/ 独立安装 + chisabot-node 打包三道检查。
- #372 `fix/nginx-realip-gateway-replay`（head `5b2a2ae` → `f654611`）→ `7abf37f`：审计 #5——公网 nginx 只信任 Cloudflare 网段给的 `CF-Connecting-IP`，每个转发清掉客户端自带的 `CF-Connecting-IP` 并设 `X-Real-IP`；网关身份头加一次性随机数防重放。
- #373 `fix/sw-auth-navigation`（head `0ab4fb9` → `4114b19`）→ `d2387db`：sw.js 关掉 navigation preload（`SW_VERSION` 3），修 Chrome 登录回调被发两次导致的 `state_mismatch`。

**冲突**：#366、#372、#373 与 main 只在 `CHANGELOG.md`、`docs/CHANGELOG.md`、`docs/DEVLOG.md` 冲突。按要求把 origin/main merge 进 PR 分支、两边条目都保留、普通 push 到 PR 分支后再合并，所以这三个 PR 的 head 多了一个合并提交（见上）。没有代码文件冲突。

**验证**：合并后的 main 上 `bun install --frozen-lockfile`、`bun run typecheck`、`bun run build` 通过；本次改动相关测试（gateway-identity、im-onebot-rate-limit、trust-boundary-redline、guards、self-host-banner、user-preferences-routes、approvals-frontend、bot-lifecycle-audit、auth accounts、biome-new-issues、sw-navigation）142 pass / 0 fail。`bun run test:app` 在 Windows 本机负载较高时有 2 个用例超 5 秒默认超时（brokered-account-row、form-submit-controls，这一版都没改到），单独以 60 秒超时重跑 43 pass / 0 fail。

**版本**：根、`app`、`server` 升到 `0.1.105`；PC / Android 不变（四个 PR 均未改 `pc/`、`android/`）。不打 tag、不发 Release。

**部署**（2026-10-29 08:45–08:58 北京时间）：部署前在 Haupt 另做数据库备份 `/opt/chisabot-backups/pre-release/v0.1.105-20261029T002243Z.dump`（`pg_restore -l` 767 条目），备份网关 `nginx.conf`（`nginx.conf.bak-pre-v0.1.105-20261029T002243Z`），给 d6cd2ec 打 `local/chisabot:keep-d6cd2ec` 防清理。`deploy-serial.sh 3856d36` 全量构建（依赖有变），镜像 `local/chisabot:auto-202610290045-3856d36`（同时成为 BASE_IMAGE），`/api/version` 为 `0.1.105` / `3856d36`。

**网关 nginx（#372）**：deploy-serial 只做 `sync-nginx --check`，不会套用新模板，所以手动把仓库 `deploy/public/nginx.conf` 按线上域名 / 端口渲染（与渲染旧模板得到的线上配置逐字节一致，只多出 #372 的 59 行），写入挂载进 `chisabot-public-gateway` 的 `/opt/chisabot-zh/public/nginx.conf`，容器内 `nginx -t` 通过后 `nginx -s reload`（容器未重建）。`nginx -T` 与渲染结果 md5 一致：22 条 `set_real_ip_from`、`real_ip_header CF-Connecting-IP`、14 个转发都清 `CF-Connecting-IP` 并设 `X-Real-IP`。宿主机 `/opt/chisabot-ops/deploy/public/nginx.conf` 模板同步为 main 版（已备份）。

**检查**：`request.sh smoke` PASSED（admin 模型自检 `ok:true persisted:false`），`health.sh` 通过，公网 `/login` 200，sidecar 隔离 ALL GREEN，未回滚。reload 后 access log 里经 Cloudflare 进来的请求记的是真实客户端 IP（从 Ayase 经 Cloudflare 发的请求带 CF-RAY，日志里是客户端公网 IP），reload 前同类请求是 172.71.x / 104.22.x / 162.158.x 等 Cloudflare 节点；reload 后唯一一条 Cloudflare 地址是 reload 前建立、reload 后才关闭的 WebSocket。线上 `sw.js` 的 `SW_VERSION` 为 `"3"`（公网 `/sw.js` 需要登录，未登录 401；应用容器内和 :3001 取到的都是 3，网关对已登录客户端返回 200）。

**镜像**：当前（BASE_IMAGE）3856d36、上一版回滚目标 `auto-202610282010-ed93b05`、`keep-d6cd2ec`、`keep-628d527`。

**待办**：`deploy/public/auth/server.ts`（网关签身份头时加 `j`）属于登录服务，不随一键更新，这次没有手工部署 `chisabot-web-auth`；在它更新前，网关签的仍是不带 `j` 的旧格式，应用照旧放行，防重放实际上还没生效。另外宿主机 `/opt/chisabot-ops/scripts/ops/sync-nginx.sh` 是旧版（要求 `/_openbot/auth-check` 标记），`--check` 读的是 10-18 生成、未挂载的 `nginx.generated.conf`，没有反映线上真实配置，建议之后把宿主机 ops 脚本同步成 main 版。
