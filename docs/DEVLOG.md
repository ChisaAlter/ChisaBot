# DEVLOG

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

## 2026-10-29 性能模式 / 减少透明度：全局不模糊（分支 `perf/global-no-backdrop`）

### 动机

流畅优先。#363 给毛玻璃定了预算，性能模式下大部分面板也已经不模糊，但它是一个个选择器去关的：新加的、第三方的、Tailwind 写的模糊就会漏。实测 main 上开着性能模式，桌面聊天页还有 1 层（streamdown 代码块右上角的操作条 `div.pointer-events-auto.flex.shrink-0`，`backdrop-blur` 8px），设置页 14 层（外观设置的玻璃预览和色板的勾），手机抽屉 2 层（代码块操作条 + 遮罩）。系统「减少透明度」也一样。

### 改动

- **`app/src/perf-noblur.css`（新文件，`main.tsx` 里紧跟 `styles.css` 引入）**：
  - `html[data-perf="on"]:not(#chisabot-no-blur) *, …::before, …::after { --lg-blur: none; backdrop-filter: none }`，`@media (prefers-reduced-transparency: reduce)` 里同一套（前缀 `html:not(#chisabot-no-blur)`）。
  - 不用 `!important`：`:not(#id)` 给选择器加一个 id 的优先级，压过所有类 / 属性规则，引入顺序也不要紧；旧「三档玻璃」层的 `backdrop-filter: var(--lg-blur) !important` 不去比，直接把 `--lg-blur` 设成 `none`。
  - 不透明底色 `--glass-bg-opaque`（浅 `rgb(246 247 250)`、深 `rgb(29 31 36)`）：原来模糊的元素（左右栏、账号卡、输入框、顶栏搜索、菜单 / 选择框 / 浮层 / 对话框 / 抽屉、手机侧栏、提示条、代码块 / 图表操作条、外观设置的玻璃预览）都换成它；旧玻璃层改 `--lg-surface`。色板上的勾用实心深色。
  - 全屏遮罩、agent-orb 点阵层、电脑画面上的小标签只去掉模糊，保留自己的半透明底（压暗 / 装饰，不该变成不透明）。
- **审计**：`styles.css` 里所有会模糊的规则、Tailwind 的 `backdrop-blur-*`（dialog / sheet 遮罩、avatar-picker、chat-transcript、computer-view）、内联样式（无）、组件内嵌 `<style>`（agent-orb）、第三方样式（streamdown 2.6.0 的代码块 / 图表操作条和缩放按钮；copilotkit、prompt-area、tw-animate、shadcn 没有 `backdrop-filter`）。`agent-computer/`、`server/` 的页面不在 app 里，不受影响。
- **`app/tests/no-backdrop.test.ts`（新）**：引入顺序；两种开关都覆盖 `*` / `::before` / `::after` 且设了 `--lg-blur: none`；`perf-noblur.css` 不含 `!important`、页面上没有 `chisabot-no-blur` 这个 id；`app/src` 里不许内联 `backdropFilter`、Tailwind important 模糊类、新的 `backdrop-filter … !important`；两种开关的不透明名单一致；`styles.css` 里每条会模糊的规则都在不透明名单里，或者在豁免名单里写了原因（桌面左栏外层、平常就不模糊的小按钮 / 气泡 / 对话里的卡片 / 设置页卡片）。
- **`DESIGN.md` §10.3.1** 写下这条规则。
- 没改 `styles.css` 和 #374 改过的代码文件；没改版本号。

### 验证

浏览器审计（`noblur.mjs`，和之前一样数可见且 computed `backdrop-filter` 不为 none 的元素，含伪元素；减少透明度用 CDP `Emulation.setEmulatedMedia` 模拟）：

| 场景 | 普通（main） | 普通（本分支） | 性能模式（main → 本分支） | 减少透明度（main → 本分支） |
| --- | --- | --- | --- | --- |
| 桌面 聊天 / 代码块 / 账号菜单 | 5 | 5 | 1 → 0 | 1 → 0 |
| 桌面 设置页 | 16 | 16 | 14 → 0 | 14 → 0 |
| 手机 聊天 / 代码块 / 菜单 | 2 | 2 | 1 → 0 | 1 → 0 |
| 手机 设置页 | 1 | 1 | 1 → 0 | 1 → 0 |
| 手机 抽屉 | 6 | 6 | 2 → 0 | 2 → 0 |

深浅色结果相同。性能模式下原来模糊的元素底色 alpha 都是 1（遮罩除外，见上）。

截图（`docs/images/perf-noblur/`）：

- 性能模式代码块：`after-perf-code-desk-light.webp`、`after-perf-code-desk-dark.webp`（手机：`after-perf-code-phone-*.webp`）
- 性能模式面板：`after-perf-chat-desk-light.webp`、`after-perf-chat-desk-dark.webp`、`after-perf-settings-desk-*.webp`、手机抽屉 `after-perf-drawer-phone-*.webp`
- 普通模式前后：`before-normal-chat-desk-*.webp` / `after-normal-chat-desk-*.webp`，手机 `before-normal-chat-phone-*.webp` / `after-normal-chat-phone-*.webp`

![性能模式 代码块 浅色](images/perf-noblur/after-perf-code-desk-light.webp)
![性能模式 代码块 深色](images/perf-noblur/after-perf-code-desk-dark.webp)
![性能模式 面板 浅色](images/perf-noblur/after-perf-chat-desk-light.webp)
![性能模式 面板 深色](images/perf-noblur/after-perf-chat-desk-dark.webp)
