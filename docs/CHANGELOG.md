## Unreleased

- **修复点击「设置」切页延迟（拆解预加载炸弹、补齐空闲预取与消除挂载强制重排）**：`AccountMenu` 打开时仅预取 `/settings` 与 `SettingsSidebar`，`个人资料`/`绑定手机`/`定时任务`/`待处理` 改为单行悬停/聚焦/按压按需预取（`preloadAccountDialog`）；`vite.config.ts` 将 `_authed/_app/approvals.tsx` 拆出 `route-app-secondary` 避免拖入 `workflows`/`task-center.css` 等十余个无关分包；`_app.tsx` `IDLE_PRELOAD` 补齐 `"/_authed/settings/"` 且 `AuthedShell` 同步空闲预取 `SettingsSidebar`；`PageShell` 挂载跳过 `scrollTo(0)` + 同步读 `scrollTop` 且 `ChatTranscript` `SettleAtEnd` 在 `KeepAliveStage` 隐藏态（`data-visible="false"`）跳过 `pinNow()` 几何读取，彻底消除切入设置页全页强制重排，补充回归测试并更新客户端指纹（`app/vite.config.ts` · `app/src/components/layout/{account-menu,account-dialogs,authed-shell,page-shell}.tsx` · `app/src/components/channels/chat-transcript.tsx` · `app/src/routes/_authed/_app.tsx` · `app/tests/{router.test.ts,settings-open-fast.test.tsx}` · `pc/src/shell-fingerprint.json`）。
- **全量审查 M6 — Android 原生壳内存泄漏、主线程 I/O 与更新安全加固**：`Updater.kt`/`MainActivity.kt` 补 `close()` 释放 `AlertDialog`/`ioScope` 与半截文件并强制 HTTPS + 版本号白名单/`canonicalPath` 边界校验；`WebScreen.kt` 以 `@Volatile MainFrameUrlHolder` 替换 500ms `CountDownLatch` 阻塞、补 `onPause`/`onResume`/有序销毁/拍照缓存清理及 API ≤ 28 下载目录降级与 `applicationContext` 广播防泄漏；`AppViewModel.kt` 将 `contentResolver` 与 `CookieManager` 移至 `Dispatchers.IO` 并以 `NonCancellable` 保护 `runTurn` 复位；`GatewayAuth.kt` 1 MiB 读上限、`VoiceCallAudioManager.kt` API 31+ `setCommunicationDevice`，新增 `HardeningLogicTest`（`android/app/src/main/java/cn/ayase/chisabot/{MainActivity,Updater,AppViewModel,GatewayAuth,VoiceCallAudioManager,ui/WebScreen}.kt` · `android/app/src/test/java/cn/ayase/chisabot/HardeningLogicTest.kt`）。
- **全量审查 M4 — Web 首屏打包瘦身、闲置轮询降频与渲染内存优化**：剥离 `AgentProfile`/`GroupChatView`/`SideChatDrawer`/10 组重型工具渲染器与 `ConfirmHost` 出聊天首屏闭包，配合 `route-preload.ts` `MIN_PRELOAD_DEP_BYTES = 12_000` 与 `MAX_PRELOAD_CHUNKS = 30` 门禁将聊天首屏 `modulepreload` 从 87 降至 21（-75.9%）、静态闭包 JS 减少 327.8 KB raw / 117.0 KB gz；任务中心与审批收件箱空闲轮询降至 60s，9 处 KeepAlive 轮询接入 `useKeptVisibility()`，离线设备停轮询，`desktop-window.ts`/`use-now.ts`/`relative-time.ts` 接入后台暂停与共享时钟；抽取 `agent-orb.css`、`data-motion-rest="1"` 补齐 8 处无限动画、`favicon-tone.ts` 与 `computers/tabs.ts` 加 LRU 上限，新增 `web-perf-guardrails.test.tsx` 与更新客户端指纹（`app/src/{styles.css,routes/**,lib/**,components/**}` · `app/scripts/{route-preload,chunk-graph}.ts` · `pc/src/shell-fingerprint.json`）。
- **全量审查 M3 — Web 前端体验、错误态、资源回收与文案统一**：`session-client.ts` 过滤合成 `connect:` `runId`；补齐 `PanelRail` 失败 `ErrorCard`+重试与错误边界诊断、`AppSidebar`/`BotMiniRail` 骨架与错误重试、固定/暂停/通知/收藏写操作失败提示；修复 3 处 `URL.createObjectURL` 泄漏与解码竞态；`HandOffCard` 加互斥锁；`channel-chat.tsx` `stopTask` 清理延时器且 `stopping` 轮询接后台暂停；统一中文文案、补齐 `BotProfilePage`/`BotsPage` 错误重试、修复 `useVoiceCall` 清理依赖并收口 `objectConnectionKey`/`useSharedReducedMotion`，更新客户端指纹与 `web-ux-hardening.test.tsx`（`app/src/{lib/chat/session-client,lib/motion,lib/agents/mutations,lib/bot-lifecycle/mutations,hooks/use-voice-call,components/panels/panel-rail,components/app-sidebar/app-sidebar,components/approvals/inbox,components/channels/*,components/bot-profile/profile,components/settings/*,components/layout/profile-dialog,routes/bots.index}.ts(x)` · `pc/src/shell-fingerprint.json`）。
- **全量审查 M5 — PC 桌面端性能、稳定性、更新与安全边界加固**：限制 ACP/UIA/`git()`/`sandbox` 缓冲上限并补齐 `child.stdin` 错误处理；优化 Windows UIA 扫描与异常退出恢复；修复 `prewarmedChatWindow` 孤儿窗口泄漏、主线程同步写盘/`Atomics.wait`/`codesign` 阻塞、`local-web.js` 后置错误吞没、`manualInstall` 卡 0%、`updater.js` 状态残留及 `code-ops.backupOf()` 越界与符号链接校验；新增 `desktop-hardening.check.js` 并刷新 `shell-fingerprint.json`（`pc/src/{main,config,desktop-prefs,safe-fs,local-web,updater,headless,shell-fingerprint.json}` · `pc/src/agent/{code-ops,ops,win-ps-helper}.js` · `pc/src/agent-runtime/{acp-client,index,sandbox}.js` · `pc/src/ui/{ui,update}.js` · `pc/test/desktop-hardening.check.js`）。
- **全量审查 M2 — 部署更新链、Docker/s6 与 CI 流水线优化**：`dsh-release.sh`/`accounts-release.mjs` 注入 `CHISABOT_ACCOUNTS_LOCK_WAIT=120`、`accounts.mjs` 遇 `.maintenance` 跳过且 `accounts.service` 放行 exit 73 根治撞锁误回滚；修复 `deploy-serial.sh` 默认提前 `quiesce_app`、`pin-resources.sh` 多账号网识别、`update/rollback` 自动重刷 `isolate-sidecar-app.sh` 与陈旧规则清理、`update.sh` 异常备份/builder 回收、`install-updater.sh` 遗漏项及 `chisabot-updater.py` FD 泄漏与 2s 轮询风暴；优化 `Dockerfile`/`.dockerignore`、`Dockerfile.update` `curl` 健康检查、s6 禁用服务与内嵌 PG 参数、`compose.yaml` `shm_size`/tmpfs；CI 补全缓存与去重、对齐 PG16 并合并发版 `web-bundle` 构建（`deploy/**` · `docker/s6/**` · `Dockerfile` · `.dockerignore` · `scripts/ops/**` · `scripts/run-app-tests.ts` · `.github/workflows/{chisabot,perf,release}.yml`）。
- **全量审查 M1 — 服务端 CI 基线清零、核心状态机与性能内存治理**：清理 `route-access-registry.ts` 过时项并对齐 `restart-interrupted-run` 摘要断言；修复空频道 `connect()` 缺失 `RUN_STARTED`/`RUN_FINISHED` 信封、DSH `ToolLoopGuard` 并行 `Map<callId>` 追踪与 `local-conversations.ts` `emit()` 终态竞态；新增迁移 `0071_tool_operations_run_created_idx.sql`（自动执行）；`CB-031` 裁剪 `RUN_STARTED` 冗余 `context`/`tools` 并接入 `audit-retention.ts` 分批清理；20 处热路径切异步维护态检测；加固 `DshRuntimeAgent.reconnect`、`agents/lifecycle` 批量轮询、`guarded-fetch` 压缩流、`ModelBreakers`/`DshClientPool` 上限、`devices/hub` ping 与 `system-update` 异步读取（`server/src/{local-conversations,audit-retention,system-update,agents/*,conversations/*,devices/hub}.ts` · `server/drizzle/0071_*` · `shared/net/guarded-fetch.ts` · `runtime/dsh/src/{tool-loop-guard,plugin,model-router}.mjs`）。
- **聊天输入框上传图片支持点击大图预览，并结构性根治发送后对话记录弹跳**：`AttachmentStrip` 与 `Composer` 复用 `Lightbox` 支持本地上传中 `blob:` 与已上传图片点击预览、多图定位切换、`Esc` 回焦及移除/重试防误触；对话滚动移除视口 `.scroll-smooth`、关停 `MessageScrollerProvider autoScroll` 与 `.chat-slack` 弹性 `floor`/反向补留白，统一 `SettleAtEnd` 单源 `instant` 贴底与 `data-cb-pinned="true"` 关闭贴底 `overflow-anchor`，同步改造 `ComposerDock` 即时 `syncInset`、`BotBubbles` 流式结束防塌缩、`.chat-status-slot` Grid 叠放、`/sync` 短路与 `VirtualTranscriptRows` 锁底，修复 `tests/chat-scroll/` 回归盲区并更新 `pc/src/shell-fingerprint.json`（`attachment-strip.tsx` · `composer.tsx` · `dock.tsx` · `chat-transcript.tsx` · `channel-chat.tsx` · `virtual-transcript.tsx` · `bot-bubbles.tsx` · `use-conversation-sync.ts` · `styles.css` · `shadcn-react-message-scroller/lib/index.js` · `shell-fingerprint.json` · `tests/chat-scroll/bounce-regression.mjs`）。
- **修复容器部署因 `agent-runtime` 跨目录引用 `../agent/proxy` 启动失败并回滚的问题**：将代理实现收口至 `pc/src/agent-runtime/proxy.js`（`pc/src/agent/proxy.js` 保留重导出），`antigravity-managed.js` 改为引用 `./proxy`，并补充 `agent-runtime` 禁止越级 `require("../...")` 门禁测试，修复 `update.sh` / `Dockerfile` 仅复制 `pc/src/agent-runtime` 导致的容器启动崩溃（`pc/src/{agent-runtime/proxy,agent-runtime/antigravity-managed,agent/proxy,shell-fingerprint.json}` · `pc/test/agent-runtime.check.js`）。
- **修复聊天输入框附件上传失败持久化、重试保护与草稿恢复竞态**：`PersistedDraftFile` 新增 `failedReason` 持久化与恢复区分，新增 `mergeDraftAttachments` 在异步草稿恢复期间与实时增删/发送状态合并防覆盖，修复 `StrictMode`/切会话恢复中断与重试异常回写/禁用状态漏洞，并补充回归单测（`composer.tsx` · `draft-attachment-store.ts` · `composer-draft-restore.test.tsx`）。

## 0.1.191 — 2026-11-26

- 全端发版：`0.1.191`，Android `versionCode 371`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `40004bb3640818a0`；无新增数据库迁移。
- **修复频道图片与 Bot 资料库大文件上传 `413` 拦截**：移除 `/api/channels`（512 KiB）与 `/api/bots`（128 KiB）通配 `bodyLimit` 对后续挂载的大文件上传路由的遮蔽，改为按写路由精确挂载并收窄附件路由上限作用域，新增无库依赖共存回归测试（`server/src/{channels/routes,app,agents/lifecycle-routes}.ts` · `server/tests/route-body-limit-coexistence.test.ts`）。
- **定时条件基线、云端浏览器接管、DSH 护栏、安全加固与 Android 语音桥（`1e90265`–`67e070c`）**：新增定时任务结构化条件基线/边沿触发/冷却与 BFS 形式化验证、云端浏览器限流提示/API 风险检测/点击接管、DSH 泄漏/循环/预算护栏与 `StopSummary`、浏览器审批时间窗域绑定与记忆防污染加固，以及 Android `VoiceCallAudioManager` 同源桥与听写排障提示（`shared/schedules.ts` · `server/src/{schedules,computer,confirmations,memory-notes,agents}/*` · `runtime/dsh/src/*` · `agent-computer/src/*` · `app/src/{components/computer,lib/voice,lib/dictation}/*` · `android/.../{VoiceAudioBridge,ui/WebScreen}.kt`）。

## 0.1.190 — 2026-11-25

- 全端发版：`0.1.190`，Android `versionCode 370`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `4315e3bde1bc9a04`；无新增数据库迁移。
- **移除聊天直连子代理入口、增强任务卡片续聊与补丁预览并修复子代理运行时缺陷（#589，DESIGN §132）**：移除 `SubagentPickerChip`、`channel-chat.tsx` `@子代理` 直连与 `DirectSubagentRuntimeAgent`（定时任务/任务中心直派及 `subagent_*`/`agent_<slug>` 工具链保持不变）；增强 `LocalAgentCard` unified patch diff 预览、`needs_input` 追问表单与多轮续聊输入框，并修复 `AddProviderDialog` slug 冲突后缀、`guidanceText` 续聊引导、嵌套 `agent_subcall` `profile` 只收紧不放宽、PC 外部驱动伪造 `sess-<taskId>` 毒化及 `.asar` 下 `CHISABOT_SUBAGENT_CLI` 路径（`channel-chat.tsx` · `local-agent-card.tsx` · `agent-providers-page.tsx` · `local-agents/service.ts` · `pc/src/agent-runtime/{index,subagent-bridge}.js`）。
- **用户电脑后台无感操控全链路与 `agent-desktop` 旁路驱动（#591）**：新增 `desktop_windows` / `desktop_snapshot` / `desktop_act` / `window_screenshot`（PC 端常驻 Windows UIA 10 类 Pattern 与 `PrintWindow` 离屏按窗截屏、macOS 无 `frontmost` 后台 AX 与 `screencapture -l`、`DesktopDriver` SPI 旁路对接本机 `agent-desktop` 并强制禁用 `--headed`；服务端 `desktop-snapshot-store.ts` 严格反解 `@<snapshotId>:eN` 与不可信标注、四层自保护、密码框脱敏及 `directionEpoch` 回合授权闭环；按 `hello.features` 向下兼容老客户端，更新桌面客户端后生效，无新增数据库迁移；`shared/devices.ts` · `pc/src/{accessibility-bridge,agent/*,main,headless}.js` · `server/src/{devices/*,computer/desktop-browser-bridge,index}.ts`）。

## 0.1.189 — 2026-11-25

- 全端发版：`0.1.189`，Android `versionCode 369`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `c46c70aad9734565`；无新增数据库迁移。
- **输入框语音输入统一接入后台 ASR 配置（#592）**：`/api/audio/transcriptions` 与 `/api/capabilities.transcription` 统一接入 `speechService`（沿用 `/admin/models` 语音设置 → `SPEECH_ASR_*` → `TRANSCRIPTION_*`），放宽 `/api/speech/asr` 空闲超时，保存语音设置后即时失效前端缓存；彻底移除浏览器 `Web Speech API`（`SpeechRecognition`）兜底路径，未配置服务端 ASR 时隐藏输入框语音按钮（`server/src/{dictation/routes.ts,app.ts,index.ts}` · `app/src/{lib/dictation/recording.ts,components/channels/composer/use-dictation.ts,components/settings/speech-settings.tsx}`）。

## 0.1.188 — 2026-11-25

- 全端发版：`0.1.188`，Android `versionCode 368`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `07964e288351b644`；无新增数据库迁移。
- **无白边柔和磨砂质感恢复（`e3033865`）**：去除浅色 `glass` / `clear` / `porcelain` 表面实体白框与双层全圈白环，改用透明占位边框与轻柔顶部单线微光并柔和左栏选中行高光；下调 `sky`/`pure` 画布预合成表面不透明度恢复通透磨砂感，在 `html[data-canvas="wallpaper"]` 自动加厚釉面守住全矩阵 WCAG AA ≥ 4.5:1；同步 PC `skyglass-tokens.css` 并补充回归测试（`styles/{tokens,materials}.css` · `styles.css` · `bubble-and-panel-surface.test.ts` · `pc/src/ui/skyglass-tokens.css`）。

## 0.1.187 — 2026-11-25

- 全端发版：`0.1.187`，Android `versionCode 367`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `b1398c68b9ffb62c`；无新增数据库迁移。
- **精简模式、主题字体重构与面板/气泡材质统一（`9f6abbc8` · #586 · #587，DESIGN §155）**：新增精简模式开关与布局，修复 `Sidebar` `parked` 态误卸载聊天左栏；补齐 `claude` 全站衬线字体并将 `deepseek` 重构为 DSH `16px/20px`、`superellipse(1.5)`、`0.5px` 发丝边与冷蓝灰/纯画布光晕；新增 `--surface-bg-hold` 与 `--mat-*-hold` 消除面板弹出透明度跳变并统一双方聊天气泡至 `[data-surface="bubble"]` 单通道（`simple-mode.*` · `styles/{tokens,canvas,materials}.css` · `styles.css` · `bubble-and-panel-surface.test.ts`）。
- **对话内连接卡片与 Antigravity 托管代理支持（`9f6abbc8` · #588）**：优先推出对话内 GitHub 与个人数据源连接卡片并支持授权后自动续聊；新增本机 Antigravity 托管代理检测、桥接与设置页管理卡片（`github-tool.tsx` · `personal-sources-tool.tsx` · `connect-service.ts` · `pc/src/agent-runtime/antigravity-managed.js` · `antigravity-managed-card.tsx`）。
- **全局 P0/P1 安全与运行时增强（`f43bb0cd`）**：落地 PC 端 `safe-fs`、`code-ops`/`ops`/`proxy`/`mcp-host` 与 `updater` 安全加固、Android `GatewayAuth` 鉴权校验、IM 适配器安全加固、内联审批/确认卡增强及设备 Hub 与 MCP 扩展（`pc/src/{safe-fs,agent/*,updater}.js` · `android/.../GatewayAuth.kt` · `server/src/{im,devices,plugins}/*`）。
- **PC 安全自检与手动更新、群聊收敛交互及 MCP auto 模式 UI（`298921ac`）**：打通设置页 PC 安全自检卡、手动检查更新横幅、群聊收敛交互视图、应用包面板及管理端插件 MCP auto 模式 UI（`security-audit-card.tsx` · `update-banner.tsx` · `group-chat-view.tsx` · `admin/plugins/index.tsx`）。
- **DSH 运行时依赖修复（`08c0c9ac` · #584）**：修复 Dependabot PR #584 的 `ERESOLVE` 冲突，对齐 `@deepseek-ai/dsh*` 至 `0.2.2-rc.1` 并升级 `undici` 至 `8.12.2`（`runtime/dsh/package{,-lock}.json`）。

## 0.1.186 — 2026-11-24

- 全端发版：`0.1.186`，Android `versionCode 366`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `5904bcbcb0e58752`；无新增数据库迁移。
- **六套深度定制主题体系、自定义面板溢出对比度修复与深浅色平滑切换（`e0064245`，DESIGN §155）**：收束升级为天空星空 / 极光 / 青花瓷 / DeepSeek / Claude / coss ui 六套全维度定制主题与 3×2 预览卡并同步 PC 端与无损迁移；修复 `SmoothCollapse` 导致固定高度自定义面板内容溢出边框与底条压字及 `Ring` 对比度/窄列重叠/`0%` 残留圆点/`dark/cossui` 白底白字缺陷；新增 `theme-transition.ts` 协调器消除深浅翻转 1 帧撕裂并接入 GPU 合成层 240ms `View Transitions` 交叉淡入与快速连点防竞态（`theme-family.ts` · `appearance.ts` · `theme-provider.tsx` · `theme-transition.ts` · `live-panels.tsx` · `panel-board.tsx` · `charts.tsx` · `styles/{tokens,canvas,materials}.css` · `styles.css` · `pc/src/{main.js,shell-fingerprint.json,ui/skyglass-tokens.css}`）。

## 0.1.185 — 2026-11-24

- 全端发版：`0.1.185`，Android `versionCode 365`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `78166a2f4823832d`；无新增数据库迁移。
- **右边栏收起定位修复与 PC 小窗切大窗跨断点防撕裂（`aeddeb17`）**：修复 `.glass-rail[data-rail-motion="closing"]` 因 `top: 0` 锚定 padding box 导致收起时向上撞入顶栏并拉高的错位问题（改为 `top: var(--glass-top); height: auto;` 并同步安装提示偏移），对齐 28px 退场位移与 `.live-panel` 折叠过渡；新增 `useDeferWhileResizing` 在缩放期跨 `768px`/`1280px` 断点推迟 1 帧挂载左右栏重型内部子树以防半屏空白撕裂，为顶栏最大化入口接入 `triggerMaximizeToggle` 预护栏、小窗直接最大化下发 `transitioning: true` 并在切深浅色时同步主窗底色，补全 `html[data-resizing]` 抑制与回归测试（`use-defer-while-resizing.ts` · `panel-rail.tsx` · `sidebar.tsx` · `desktop-window.ts` · `glass-topbar.tsx` · `styles.css` · `pc/src/{main,compact-window}.js` · `narrow-rail-sheet-stability.test.tsx`）。

## 0.1.184 — 2026-11-24

- 全端发版：`0.1.184`，Android `versionCode 364`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `5984b599f6d42a71`；无新增数据库迁移。
- **多账号安全加固与鉴权/SSRF 门禁收口（`batch1/multi-account-security`）**：抽离 `Bun.serve` 升级路由至 `server/src/upgrade-routes.ts` 并与全量路由鉴权台账共享守卫（清空 `KNOWN_GAPS`）；本机 Agent 全路径统一接入 `canUseServerHost` / `serverHostAllowedFor` / `resolveTargetDevice` 门控；OAuth 回调移除 `DEV_ACTOR` 回退改为会话强绑定；修复 SSRF `%zone` 与 `metadata.goog`、`createAgentFetch` 接入 DNS 钉死 `guardedFetchStream` 并将 `no-raw-fetch.test.ts` 升级为 TS AST 门禁；同步修复组件函数作用域、实时面板与浏览器书签归属鉴权（`upgrade-routes.ts` · `local-agents/service.ts` · `plugins/{app-builder,routes}.ts` · `agents/endpoint.ts` · `shared/net/{ssrf,guarded-fetch}.ts` · `components/{functions,routes,store}.ts` · `live-panels/service.ts` · `browser-bookmarks/service.ts` · `route-auth-inventory.test.ts` · `no-raw-fetch.test.ts`）。
- **PC 桌面端语音通话音频增强接线（`pc/src/voice-audio.js`）**：`pc/src/main.js` 接入 `applyDesktopVoiceAudioSwitches`（Win/macOS 硬件 AEC3）与带 `fromServerPage` 守卫的 `registerVoiceAudioIpc`，`pc/src/web-preload.js` 在同源顶层框架守卫下暴露 `window.chisabotVoiceAudio.getPreferredConstraints()` 对接 `call-client.ts`，新增 `pc/test/voice-audio.check.js` 并同步更新 `pc/src/shell-fingerprint.json`（外壳指纹 `7314f9105596bec5` 不变，`clientHash` 更新为 `5984b599f6d42a71`）。
- **右边栏显隐裁切卡顿与 PC 小窗横竖屏切换性能优化（`f3582a0c`）**：展开态卸载宽/窄窗面板把手解决 `rail-tab-in` `forwards` 覆盖 `data-hidden` 露出问题；重构 `.rail-head` 弹性标签网格并提升 `MIN_WIDTH` 至 `320` 确保三标签与收起键完整可见；移除右边栏 `width`/`padding` 布局过渡改帧 0 落位与纯 GPU 关键帧并收紧面板刷新与子树记忆化；合并 PC 主进程 `window:state` 原子推送、同步预挂 `data-resizing`、消除全树样式标脏并预合成 `materials.css` 色标（`panel-rail.tsx` · `live-panels.tsx` · `live-panels-query.ts` · `chat-transcript.tsx` · `desktop-window.ts` · `resize-state.ts` · `styles.css` · `styles/{materials,tokens}.css` · `pc/src/{main,compact-window,web-preload}.js` · `narrow-rail-sheet-stability.test.tsx` · `pc/test/compact.check.js`）。
- **CI 测试回归修复、工程卫生与文档看板同步**：修复 `conversation-sync.test.ts` 与 `auth-client.test.ts` 共享进程 `window`/`localStorage` 污染及多行格式化打断的源码断言（`sidebar-search-nav.test.ts` · `pc/test/{window-chrome,login}.check.js`），完善 `biome.json` 忽略与 CI 单测覆盖；同步更新 `CHANGELOG.md`、`docs/{CHANGELOG,BACKLOG,ROADMAP,HANDOFF,release,pc-update-signing,accounts}.md`、`docs/rfc/hark-redesign.md` 与 `landing-redirect.tsx` 过期注释。

## 0.1.183 — 2026-11-23

- 全端发版：`0.1.183`，Android `versionCode 363`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `3cbd7edf912a2f07`；无新增数据库迁移。
- **主题、背景画布与纯 CSS 材质四轴重设计（DESIGN §154）**：外观体系重构为「模式（补齐 Web 跟随系统）× 7 套主题/单强调色 × 互斥三画布（净色 / 动态天空 / 壁纸）× 纯 CSS 三档材质（`glass`/`clear`/`solid`）」四条正交轴，彻底下线重型液态玻璃 SVG 透镜与 JS 光栅采样（删除 `liquid-glass.ts`、`sky-snapshot.ts`、`perf-mode-preference.tsx`）；动态天空 4 固定时刻精确映射且实时天气默认关闭（关闭/非天空/固定时刻保证 0 Open-Meteo 请求并支持城市设置），壁纸收敛为模糊 + 单层护眼薄幕 2 条滑块；CSS 拆分为 `tokens.css` / `canvas.css` / `materials.css` 5 层单通道与 `[data-surface]` 6 档语义（全仓 `!important` 188 → 81）；`AppearanceConfigV2`（`chisabot-appearance`）提供旧 16 键一次性无损迁移与唯一首屏 `appearanceBootScript()`，设置页将「忙碌发送模式」「隐私遮罩」迁回「对话与隐私」区块并升级账号菜单三态切换，同步更新 PC 原生窗桥接与 Android `WebScreen.kt` 跟随系统（`app/src/styles/{tokens,canvas,materials}.css` · `styles.css` · `appearance.ts` · `palette.ts` · `theme.ts` · `theme-family.ts` · `sky-background.tsx` · `wallpaper_core.html` · `appearance-preferences.tsx` · `settings/index.tsx` · `account-menu.tsx` · `pc/src/*` · `android/.../WebScreen.kt`）。

## 0.1.182 — 2026-11-23

- 全端发版：`0.1.182`，Android `versionCode 362`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `b1ab90640bd413a2`；无新增数据库迁移。
- **全站 UI 操作丝滑度与玻璃安全过渡动画全面升级**：统一 `motion.ts`、`motion-primitives.tsx` 与 `styles.css` 动效令牌及 `<SmoothCollapse>`/`useRetainedValue`/`usePresenceMount`/`<ContentEnter>`；修复 `[data-slot="sheet-content"]` 与 8 类弹出层 `backdrop-filter` 过渡并补齐 `glass-hold`；消除深浅色切换 240+ 并发过渡风暴（`theme-provider.tsx`）与 `ToggleTip` 快速点击吞没（`glass-topbar.tsx`）；改造全站 UI 原语、外壳左右栏、右栏面板、单树无闪暗 `Composer`、聊天思考胶囊/干活卡/Spotlight/Lightbox、11+ 二级页弹窗退场保活、20+ 折叠区与 `pc/src/ui/` 独立窗口，实机 `perf/jank.mjs` 多场景帧率提升 +44% 至 +888%（`motion.ts` · `styles.css` · `composer.tsx` · `glass-topbar.tsx` · `panel-rail.tsx` · `pc/src/ui/*`）。
- **手机端消息动作栏、输入框工具栏防重叠与切页流畅度修复（#581）**：`.chat-msg-action[data-held]` 改用 `display: none` 并以 `.chat-msg-actions` `min-height: 26px` 固定行高，消除回复中幽灵撤回图标与「引用」偏移；`composer.tsx` 与 `styles.css`（`.model-pill` `flex-shrink: 0` + `@container (max-width: 480px)` `flex-wrap`）解决手机端输入框工具栏挤压重叠；`section-rail.tsx` / `account-menu.tsx` 补充按下路由预加载，并优化 `html[data-phone]` 切页 `page-in-phone` 无位移淡入、`touch-action: manipulation` 与抽屉 `will-change: transform`（`styles.css` · `composer.tsx` · `section-rail.tsx` · `account-menu.tsx` · `mobile-chat-ui-fixes.test.tsx`）。

## 0.1.181 — 2026-11-22

- 全端发版：`0.1.181`，Android `versionCode 361`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `fdb6a75dfc274c7b`；含非破坏性索引迁移 `0070_core_performance_indexes.sql`（自动执行），公网 Nginx 同步建议更新以启用 HTTP/2 与 keepalive。
- **全栈性能优化落地（前后端 / DB / DSH / 云端浏览器 / 端侧 / 网关）**：前端消除 `SettleAtEnd` 标脏、`Arriving` 历史合成层与 `ChatStage`/`ChannelPage` 广播重渲，补齐 KeepAlive 轮询门控与流式 rAF/`mergeSnapshot` O(N+M)/`FitLine`/`renderUiFinal` LRU；剥离双份 Zod、`TasksRailCard` 43.2 KB 首屏 CSS 与跨区导入，合并 29 个图标块，`liquid-glass` 按需导入，清除 5 处 `transition: filter`、外观页 28 个缩略图模糊、`feTurbulence` 预烘焙与 4K 壁纸降采样（`chat-transcript.tsx` · `session-client.ts` · `authed-shell.tsx` · `panel-rail.tsx` · `vite.config.ts` · `styles.css` · `wallpapers/*`）。服务端补齐 16 条核心表索引与 PG 连接池 `max: 20`，`local-conversations.ts` 元数据投影去 `SELECT *` 与 `capture()` 尾消息拷贝，原生 `/messages` `tail`/`since` 防二次截尾，`plugins/store.ts` 并发批查，`usage-breakdown.ts` 下推 SQL，`memory-kv-prefix` / `safety-scanner` / `key-pool` 提速 `3.3×–11.4×`（`0070_core_performance_indexes.sql` · `local-conversations.ts` · `memory-notes/*` · `content-safety-scanner.ts` · `key-pool.ts`）。外围 `task-center`/`im`/`schedules` 自适应退避唤醒、`chat-files` 异步解压与带偏移零拷贝视图、DSH Linux `sh+cat` 宿主锁/零落盘内存凭据复用与空闲驱逐、`agent-computer` 事件驱动 `tabs` 与 33ms Ack 节流（`runtime/dsh/*` · `agent-computer/*` · `guarded-fetch.ts`）。端侧与部署新增 PC 常驻 STA helper 提速 `131×` 与零闪屏并行冷启，Nginx `http2 on;` + `upstream keepalive` 与 `trust-boundary` 同步，Android 隐去遮挡云朵/IME `derivedStateOf`/异步验签与 `Dockerfile` 瘦身（`pc/*` · `deploy/public/nginx.conf` · `shared/trust-boundary.ts` · `android/*` · `Dockerfile`）。
- **手机端顶栏移除重复头像并将待处理红点迁至抽屉按钮**：移除手机顶栏右上角重复头像与 `AccountMenu placement="topbar"` 分支，身份入口统一收束至左栏抽屉底部 `AccountCard`，并将待处理红点迁至手机左上角 `☰` 抽屉按钮；抽取共享待处理计数并清理 `.hk-avatar-btn` / `.glass-topbar .glass-avatar` 样式及更新测试（`pending-actions.ts` · `glass-shell.tsx` · `glass-topbar.tsx` · `account-menu.tsx` · `styles.css` · `pc-layout-topbar.test.ts` · `mobile-topbar.test.tsx`）。

- **手机端、Web 端与桌面端流畅度全面修复及护栏（DESIGN §153）**：服务端 `?tail=120` 尾读与后台静默补全（`thread-messages-delta.ts` · `thread-messages.ts` · `channel-chat.tsx`）；Android Edge-to-Edge 安全区与状态栏主题双向同步（`WebScreen.kt` · `theme-provider.tsx`）；`SkyBackground` / `appearance.ts` 运行时切主题令牌同帧同步；公网 `/login` 暗色横屏与触控热区（`login.html` · `login.css`）；手机端布局、热区、侧栏抽屉返回栈、右抽屉骨架与容错边界及桌面端流畅度护栏（`styles.css` · `page-shell.tsx` · `section-rail.tsx` · `panel-rail.tsx` · `tasks-rail-card.tsx` · `account-menu.tsx` · `bots.index.tsx` · `fallback-models.tsx` · `task-center.css` · `desktop-window.ts` · `chat-transcript.tsx` · `liquid-glass.ts` · `pc/`）。

- **PC 独立更新进度窗口极简改版（DESIGN §152）**：将桌面更新弹窗升级为独立可缩放/可最大化/可最小化的无边框纯白/深炭居中进度页（`880×600`，Windows `— / □ / ×`、macOS 原生红绿灯），移除 `pc/src/update-backdrop.js` 与 `update:fit` 主窗随动截图链路；接入 `deriveUpdateView` 全状态驱动、`dismissedDownloadVersion` 后台续下与网页「查看更新进度」唤起入口，以及 `feedToDownloadPage` / `resolveManualDownloadUrl` `https://` 手动下载链接（`pc/src/window-chrome.js` · `pc/src/update-placement.js` · `pc/src/build-config.js` · `pc/src/main.js` · `pc/src/preload.js` · `pc/src/ui/chrome.js` · `pc/src/ui/ui.js` · `pc/src/ui/update.*` · `devices.tsx` · `client-update-section.tsx` · `pc/test/update-window.check.js`）。

## 0.1.180 — 2026-11-22

- 全端发版：`0.1.180`，Android `versionCode 360`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `5d175b026b079ac5`；无需手动数据库迁移。
- **聊天状态胶囊磨砂统一、底部锚定防上漂、快照规范序与只读工具收敛（DESIGN §151）**：状态/干活胶囊恢复 `--lg-blur`（`styles.css` · `status-capsule.css` · `status-capsule.tsx` · `liquid-glass.ts`）；固定 `.chat-status-slot`、`holdBlank` 临时留白收敛与流式收尾保文（`chat-transcript.tsx` · `work-card.tsx` · `session-client.ts`）；`applyMessagesSnapshot` 与服务端出口封顶/脱载（`wire-events.ts` · `local-conversations.ts` · `routes.ts` · `confirmation-resume.ts`）；只读工具补全 `effect: "read"`、`isPreEffectFailure` 收敛与 `bot-factory-tool.tsx` 防重拉，同步新增/更新单元与真实浏览器回归测试。

## 0.1.179 — 2026-11-21

- 全端发版：`0.1.179`，Android `versionCode 359`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `e60cce22d806c1e4`；无需手动数据库迁移。
- **PC 右上角窗口控制键磨砂角托与高对比图标保护（DESIGN §150）**：将 `.win-ctrls` 重新纳入 `styles.css` `--lg-surface-strong` + `--lg-blur` + `--lg-shadow` 单通道规则并加入 `liquid-glass.ts` `LENS_SKIP_SELECTOR`，`glass-topbar.tsx` `WindowControls` 4 枚 SVG 图标描边加粗至 `1.25px` 并为深色/壁纸态补充 `--win-ctrl-shadow` 字缘保护与更清晰的悬停/按下对比（关闭键悬停清除额外阴影）；同步更新 `render-budget.test.ts`、`theme-glass-perf.test.tsx` §9/§10、`DESIGN.md` 与 `pc/src/shell-fingerprint.json`。

## 0.1.178 — 2026-11-21

- 全端发版：`0.1.178`，Android `versionCode 358`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `955713d4e85bf6eb`；无需手动数据库迁移。
- **聊天气泡与对话卡片磨砂玻璃一致性修复（CB-128 / DESIGN §149）**：移除 `app/src/styles.css` 渲染预算中误关闭 `.chat-bubbles [data-slot="bubble"] > [data-slot="bubble-content"]` 与 `[data-testid="chat-transcript"] :is(.jr-card, ...)` `--lg-blur` 的规则，仅保留 `.chat-bubble-bare` 无框无模糊及性能模式/减少透明度降级；同步恢复并强化 `app/tests/theme-glass-perf.test.tsx` 回归门禁，更新 `DESIGN.md` §149 与 `pc/src/shell-fingerprint.json`。

## 0.1.177 — 2026-11-21

- 全端发版：`0.1.177`，Android `versionCode 357`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `68e010822f6483be`；无需手动数据库迁移。
- **阶段感知实时插话与中断边界治理（DESIGN §149 / CB-143）**：DSH 插件与客户端支持 `STEER_CUT = "chisabot/steer"`、`phase`（`boundary | model | tools`）与只读工具超时后台化（`plugin.mjs` · `client.mjs` · `client.d.mts`）；服务端引入 `InboxDeliveryMode`（`"steer" | "queue"`）、单调 `epoch` 并发护栏、`PATCH .../inbox` 与侧边抽屉主线插话（`dsh-events.ts` · `dsh-runtime.ts` · `tool-gateway.ts` · `thread-inbox.ts` · `local-conversations.ts` · `side-threads.ts` · `routes.ts`）；前端提供默认「实时插话 / 排队」偏好开关、发送区模式切换、行内编辑/立即插话/撤回（`send-mode.ts` · `busy-send-mode-preference.tsx` · `queued-messages.tsx` · `composer.tsx` · `conversation-view.tsx` · `channel-chat.tsx` · `side-chat-drawer.tsx`）。
- **实时流、落库合批、连接池与单跳发送（DESIGN §149 / CB-143）**：`local-conversations.ts` 分离 live SSE 派发与 50ms 写库合批、移除逐 token `structuredClone` 与 500ms PG 轮询；`routes.ts` 与 `session-client.ts` 支持 `POST /commands` `Accept: text/event-stream` 单跳流式首字及背压合批；`dsh-client-pool.ts` 与 `dsh-runtime.ts` 复用 DSH Host 连接与健康缓存、跳过冗余 `/checkpoint`；`panels/api.ts` 为转发头查询加 30s TTL 缓存。
- **前端叶子级流式、长消息折叠、平滑吐字与空闲节流（DESIGN §149 / CB-143）**：`session-client.ts` + `chat-transcript.tsx` + `bot-bubbles.tsx` + `smooth-markdown.tsx` 实现按 `messageId` rAF 叶子流式更新与段级 `memo` 隔离；`fold-long-message.ts` 对超 20,000 字符正文做围栏安全折叠；`smooth-reveal.ts` 自适应零延迟贴合与高响应包络；`styles.css` 撤销可滚动聊天气泡/卡片 `--lg-blur` 损耗；`chat-transcript.tsx`（`<SettleAtEnd busy={busy || live} />`）、`use-motion-rest.ts` 与 `channel-chat.tsx`（`nextIdleInboxCheck`）消除闲置 shimmer 空耗、滚动收白跳变与稳态 `/inbox` 轮询。

## 0.1.176 — 2026-11-20

- 全端发版：`0.1.176`，Android `versionCode 356`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `d8d946f4939e3ee8`；无需手动数据库迁移。
- **窗口拉伸保留磨砂玻璃与液态玻璃拉伸暂停（DESIGN §148）**：删除 `app/src/resize-pause.css` 并移除 `main.tsx` 导入，仅保留 `initResizeState()` 供高开销后台渲染暂停；`liquid-glass.ts` 订阅 `subscribeResizing` 并在解码完成后原子替换 `data-lg-lens`（resize-pause.css · main.tsx · resize-state.ts · liquid-glass.ts · resize-pause.test.ts · liquid-glass-screen-ink.test.ts）。同时调轻 `.dark [data-slot="dialog-overlay"]` 至 `rgba(8, 12, 20, 0.22)` 并合并右栏「任务」顶栏为单一「任务中心」按钮（styles.css · tasks-rail-card.tsx · theme-glass-perf.test.tsx · task-center-board.test.tsx）。

## 0.1.175 — 2026-11-20

- 全端发版：`0.1.175`，Android `versionCode 355`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `18fca7763cc3ad9d`；无需手动数据库迁移。
- **全站弹窗、菜单、抽屉与浮层统一玻璃材质通道（DESIGN §147）**：清除 `styles.css` 与 `tasks-rail-card.css` 中账号菜单、弹窗、侧栏抽屉、模型/权限选择器、面板库、书签面板与任务详情窗的硬编码实底与历史静止态 `backdrop-filter: none`；将全站 24 类弹层统一纳入 `GLASS_SURFACE_SELECTOR`、四档玻璃 `--lg-surface` / `--lg-blur` 规则、Portal 光学字缘保护、`LENS_SKIP_SELECTOR` 与 `perf-noblur.css` / `resize-pause.css` 单通道降级（透明灯箱 `[data-slot="dialog-content"].bg-transparent` 保持豁免），同步更新 `render-budget.test.ts`、`glass-hold-panels.test.ts` 与 `theme-glass-perf.test.tsx` 回归门禁（appearance.ts · liquid-glass.ts · styles.css · perf-noblur.css · resize-pause.css · tasks-rail-card.css · pair-phone.tsx）。

## 0.1.174 — 2026-11-20

- 全端发版：`0.1.174`，Android `versionCode 354`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `a9ab9744e29e60dc`；无需手动数据库迁移。
- **账号菜单减负、统一「版本与更新」页与设置导航五组重组（DESIGN §146）**：`account-menu.tsx` 移除版本号副标题与「升级服务端」行；新增全员可见的 `/settings/updates` 与 `client-update-section.tsx` 聚合客户端/服务端版本、桌面端检查/重启安装/自动更新与端侧诊断日志，管理员同页复用 `UpdatesScreen` 管理服务端升级/推送桌面端更新/回滚/自检（旧 `/admin/system-update` 兼容且 `nav: false` 去重）；`registry.ts` 与 `settings-sidebar.tsx` 将 7 组重组为「顶部直达 / 助手能力 / 设备与连接 / 模型与用量 / 系统管理」5 组，同步更新 `client.ts`、`devices.tsx` 与单测（account-menu.tsx · client-update-section.tsx · settings/updates.tsx · system-update.tsx · registry.ts · settings-sidebar.tsx · pc-local-web-version.test.tsx · settings-search.test.ts）。
- **PC 更新弹窗实时磨砂玻璃背景**：新增 `pc/src/update-backdrop.js`、`pc/src/ui/update.css` 与 `pc/test/update-backdrop.check.js`，在 `pc/src/main.js` / `preload.js` / `ui/update.html` / `ui/update.js` 接入主窗区域实时截图裁切与磨砂背景通道（含单测与截图脚本适配）。

## 0.1.173 — 2026-11-20

- 全端发版：`0.1.173`，Android `versionCode 353`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `e4c6b8a6173cf36e`；无需手动数据库迁移，新增可选环境变量 `CHISABOT_PC_UPDATE_FEED_URL` / `CHISABOT_PC_UPDATE_WATCH_INTERVAL_MS`。
- **磨砂玻璃通透感恢复与文字层可读性优化（DESIGN §145）**：移除 `mist` / `crystal` / `frosted` 的 `--lg-aa-boost` 自动顶升（仅保留 `liquid` 自适应），恢复三页签与全站半透明磨砂；提亮 `.dark` 全站墨色（`--ink-1` `#ffffff` / `--ink-2` `#edf2fb` / `--ink-3` `#d6e0f0` / `--ink-4` `0.78`）与 `deriveSeed` 深色派生色阶，叠加克制光学字缘微投影（主按钮/代码/输入控件豁免）；修复 `liquid-glass.ts` 同源鉴权壁纸设 `crossOrigin="anonymous"` 丢 Cookie（styles.css · theme-family.ts · liquid-glass.ts · liquid-glass-screen-ink.test.ts）。
- **桌面端更新服务端 WebSocket 主动推送**：新增 `server/src/devices/pc-release-watcher.ts`（`guardedFetch` + ETag 2 分钟监听 `latest.yml`，零在线客户端零请求），`DeviceHub` 支持 `notifyUpdateAvailable` 与 `hello` 落后即单播，`POST /api/devices/push-update` + 系统更新页「推送桌面端更新」支持管理员秒级广播；PC 客户端（`core.js` / `updater.js` / `main.js`）接入推送、聚焦/唤醒/服务端版本更高节流触发（`nudge`）、10 分钟兜底与开始下载轻通知/托盘进度，保持客户端自有更新源 + Ed25519 验签边界不变（shared/devices.ts · pc-release-watcher.ts · hub.ts · routes.ts · config.ts · index.ts · system-update.tsx · pc/src/* · online-update.md）。

## 0.1.172 — 2026-11-20

- 全端发版：`0.1.172`，Android `versionCode 352`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `100230f7caedaf89`；无需手动数据库迁移。
- **右栏任务面板材质统一与全站文本可读性优化（DESIGN §145）**：删除 `tasks-rail-card.css` 中 `.rail-sheet:has(... .task-rail)` 实黑底覆盖，右栏「面板 / 任务 / 计算机」统一走 `--lg-surface` 且深色内嵌卡改为暗色半透内层；`theme-family.ts` 改为输出严格单调的 `--fam-ink-2/3/4` 与压暗版深色 `--glass-tint`，不再内联遮蔽 `html[data-wallpaper="on"]` 与 `prefers-contrast: more`；`styles.css` 恢复壁纸完整薄纱护栏并为 `mist` / `crystal` / `frosted` 接入 `--lg-aa-boost`；`liquid-glass.ts` 修复 `position: fixed` 面板 `offsetParent === null` 漏采并按 5×3 网格 85%/15% 分位色实时自适应补偿（tasks-rail-card.css · theme-family.ts · styles.css · liquid-glass.ts · contrast-model.ts）。

## 0.1.171 — 2026-11-19

- 全端发版：`0.1.171`，Android `versionCode 351`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹 `21dcd6dc82559950`；完整包含 `v0.1.170`（CB-140 / CB-141 / CB-142 Wave 1–10），无需手动数据库迁移。
- **Android 编译阻塞与服务端架构边界/测试回归修复**：修复 `MainActivity.kt` KDoc 嵌套 `/*` 编译失败；拆出 `server/src/tools/contract.ts` 与 `server/src/computer/execution-node-net.ts` 并将 `execution-node-store.ts` 迁至 `server/src/admin/`，恢复 `server/src/computer/` 零凭据/连接器依赖边界；`/api/agent-tools/call` 统一 `formatMcpCallFailure`；`/api/devices` 按需 `bodyLimit` + `readJsonObject` 免阻塞 chunked 无体 POST；`provider-oauth` 改为鉴权后 32 MiB 有界流读取（断流 400 / 超限 413）；`im-window-expiry.test.ts` 与 `schedules-safety.test.ts` 适配 `reclaimInterruptedOnBoot`、`$13`/`$14` 字段位与 `ScheduleDedupLedger` 槽位去重。

## 0.1.170 — 2026-11-19

- 全端发版：`0.1.170`，Android `versionCode 350`；PC 外壳指纹 `7314f9105596bec5` 不变（原地自动更新），客户端代码指纹更新为 `21dcd6dc82559950`；无需手动数据库迁移（22 张 `chisabot_*` 表开机幂等自建）。
- **ProkBot 全量对标 Wave 1–10 合集落地（已合入 `main`，DESIGN §144，CB-142）**：全量对齐 AI ↔ 用户交互体验并集成 2026-11-18 安全运维基线（详情见 `docs/prokbot-comparison.md`）：① **Wave 1–2**：多 Bot 置顶排序、20MB PDF/DOCX 上传、单实例 TTS 与音频卡片、DOM 示教录制编译技能、ASR/TTS 设置与试听、主动通知（`(userId, channelId)` 前台抑制 + `push_devices` + `chisabot://` 深链 + `/api/intents`）；② **Wave 3–5**：可插拔联网搜索、按模型上下文阈值、多 Webhook 7 态流水、Bot 常驻资料库、零 `blur(` 隐私遮罩、PC 桌面偏好、`docs/AI-INSTALL.md`、自适应路由与动态推理强度、本地时区用量账本、热启停脱敏观测器、7 角色系统提示词版本台、Harness 台、Bot/技能 ZIP 脱敏分享与技能版本栈/多文件只读包；③ **Wave 6–7**：多模型图像/视频池、`video_generate`/`video_inspect`、音视频聊天卡、AI Bot 头像与防像素炸弹、FFmpeg 纯管道转码、Hover 零网络缓存、虚拟形象互动微交互，以及全链路双向实时语音通话（一次性票据 + Origin 校验 + VAD/真打断 + 流式分句 TTS + 仅已播报入史 + PC/Android AEC3 钩子 + `AgentOrb` 共振）；④ **Wave 8–10**：`app-builder` 沙箱微应用与 Host OAuth、远端 MCP 全量增强与执行节点热切换；Coding Agent 续接/`needs_input`/`status(waitMs)`/`pwd -P`、Chrome Cookie/Passkey 跨端审批、无障碍代际授权、4 MiB 分块传输与环形诊断日志；Supervisor 排空升级、付费账本、`0600`/`O_NOFOLLOW` 与唯一 tmp、Provenance/OAuth/审批白名单/XFF 右向左限流/吊销断活流/SSE 上限、Tool Journal/Handoff/定时任务重启保护及 Ed25519 联邦基础协议。全仓 `bun run check` 4,358 文件 0/0、12 项形式化+安全守卫 56/56、全量 `test:app` 373 文件全过，Wave 1–10 独立审查全闭环。
- 修正用户单张链接预览卡片对齐：在 `.rp-stack[data-align="end"] .lc-stack-track` 补充 `justify-content: flex-end`，单张链接卡右沿与消息气泡对齐，保留助手左对齐与多卡扇形布局（link-card.css · tests/link-card-alignment/verify.mjs，DESIGN §135，CB-141）。
- 主题族重构（模式 × 主题族双槽）：`familyLight` / `familyDark` 两槽独立选族、允许混搭；族卡左右分半预览，`setThemeHalf(mode, id)` 只写对应槽；全部令牌改由 `deriveSeed(seed)` 派生（删 `data-palette` 静态块），启动脚本写 `data-theme-family`；8 内置族 + 自定义族编辑器（`chisabot-theme-families`）；旧 `chisabot-theme-palette` 一次性映射迁移；`boundMode` 明暗绑定皮肤删除，auto 天象改随族 seed.scene，选族不再动天空来源（theme-family.ts 新增 · palette.ts 兼容层 · appearance.ts · appearance-preferences.tsx · sky-background.tsx · styles.css，DESIGN §143，CB-140）。验证：`app/tests/theme-family.test.ts`、`palette-theme.test.ts`、`appearance-*.test.tsx` 迁移 + `tests/appearance-model/appearance.mjs` 族半边点击路径。

## 0.1.169 — 2026-11-19

- 弹出面板与窗口按钮条材质收口（CB-139，DESIGN §142）：`.rail-sheet` 移出 perf-noblur / resize-pause 的直接实心底名单，底色只经 `--lg-surface` 一条通道（与每个 `.rail-card` 同升同降，不再单独长成另一块颜色）；`.win-ctrls` 退出 `--lg-surface-strong` 画底名单——4 个窗口控制键常态无底，悬停 / 按下 / 关闭红 / 焦点环不变；新增回归门断言 `.win-ctrls` 不进任何 `--lg-*` 画底选择器（styles.css · perf-noblur.css · resize-pause.css · theme-glass-perf.test.tsx · render-budget.test.ts）。

## 0.1.168 — 2026-11-18

- 右边缘「面板」把手接入液态玻璃材质：`.rail-tab` 进各材质名单与 `GLASS_SURFACE_SELECTOR`，取 `--lg-surface-strong` 小面釉 + `--lg-ink`，随雾度滑块、深底自动翻墨；小面不进模糊预算（本地 `--lg-blur: none`）。悬停变宽 / Ctrl+Alt+B / `--edge-clip-r` / 窄窗抽屉不变（styles.css · appearance.ts，CB-138，DESIGN §141）。

## 0.1.167 — 2026-11-18

- PC 更新待安装周期提醒：`downloaded` 状态每 30 分钟检查、距上次弹窗 ≥4h 重弹提示窗 + 通知，直到安装或被顶掉；弹窗已开不重复通知（main.js，CB-137）。

## 0.1.166 — 2026-11-18

- PC 客户端发版不收敛修复：`downloaded` 待安装状态不再让 `check()` 永久返回——复查临时关 `autoDownload`，同版本不重下、更新版本顶掉待安装（复查失败 / 源上无更新保留待安装）；`local-web` 的 `onModeChange` 带 `prevMode`，local→remote 翻转即重载聊天窗口换服务器前端，每会话最多一次（updater.js · local-web.js · main.js，CB-136）。验证：`update.check.js` / `local-web.check.js` 新增用例，pc 全量 204 项通过。

## 0.1.165 — 2026-11-18

- 网页新构建空闲自动刷新：横幅挂着时每 15s 查 `refreshWouldInterrupt()`，null（无损）即自动 reload；busy / 关掉提示 / `pcUpdateActive` 不刷；手动点击确认路径不变（update-banner.tsx · activity.ts · version.ts，DESIGN §22，CB-135）。验证：`app/tests/update-banner.test.tsx` 4 项（空闲刷一次 / 忙等 / 关不刷 / PC 更新中不刷）。
- 外观模型重构（模式 × 皮肤 × 背景）：皮肤只管强调色与配套主题渐变，天空背景三选一互斥（`chisabot-sky-source` 新键，老存档按旧语义迁移）；天象场景按明暗自动配对、素白 / 墨夜明暗绑定；`--sky-lift` / `--sky-muted` 由有效天空驱动；删「背景随时间变化」重复开关（palette.ts · appearance.ts · sky-background.tsx · appearance-preferences.tsx · styles.css，DESIGN §140，CB-134）。

## 0.1.164 — 2026-11-18

- 左栏收敛：收起态 5 个分离悬浮件合成一条通顶玻璃列（`.glass-mini-head` 幽灵图标组 + `.glass-mini-scroll` 头像区 + `.glass-mini-foot` 账号，`.glass-mini-div` 分区）；展开态删「主机器人 / 其他」分组标签改 `.glass-bot-sep` 细分隔线，账号卡去 chevron、内边距 6→4、行高 44→40（app-sidebar.tsx · section-rail.tsx · account-menu.tsx · styles.css，DESIGN §139，CB-133）。

## 0.1.163

- 「面板」把手越屏让位改为 250ms 轮询重算：拖窗口不触发 resize、桥无 bounds 回调，0.1.161 只在挂载 + resize 时量 `--edge-clip-r`，窗口被拖到右缘出屏后把手被裁半条；现按 `screenX + outerWidth − avail` 轮询、值变才写、最大化恒 0（lib/desktop-window.ts，DESIGN §82.11，CB-132）。验证：`app/tests/desktop-window-edge-clip.test.tsx` + 真 Chromium `tests/rail-edge-clip/edge-clip.mjs`（860px 越屏量 ~250ms 内跟上）。
- 全端发版：PC / macOS / Android 同步 `0.1.163`（versionCode 343），PC 客户端代码指纹 `19869a09efc81c8c`，外壳指纹不变。

## 0.1.162

- 聊天滚动：流式回答中内容长高后贴底改用 `scrollTo` `"instant"`（视口 `.scroll-smooth` 下 `"auto"` 会解析回平滑；不忙仍 smooth、宽度换行不变）——真机 painted 帧 >50px 下砸 11~16 次 @~230px → 0~1 次（`tests/chat-scroll/work-card-jump.mjs`，DESIGN §94.9）。
- 干活卡点开 / 收起在 content 捕获阶段处理：记 `touchedAt` 让收起的 ~65px 变矮不再被 §88.1 补成留白挂到回合结束（实测 gap 220→与展开持平），§94.6 floor 在场时冻成渲染高度不删。
- 状态胶囊 / 干活步骤圆角统一 `var(--r-bubble, 16px)`，与消息气泡同一令牌（status-capsule.css、styles.css）。
- 全端发版：PC / macOS / Android 同步 `0.1.162`（versionCode 342），PC 客户端代码指纹 `4ad625f7f58ace59`，外壳指纹不变。

## 0.1.161

- 右缘「面板」把手：恢复态窗口被拖得右缘出屏时按实测越屏量收回（`--edge-clip-r`，最大化恒 0、浏览器恒回落 0，lib/desktop-window.ts）。
- 面板抽屉（`.rail-sheet`，portal 挂载）并入 `.glass-shell` 薄纱令牌作用域——`--lg-surface` 兜底回落 `var(--popover)→--glass-3` 时不再读 `:root` 深色 0.9 死底，与常驻栏同材质；删两条被 `!important` 覆盖的死背景。
- 全端发版：PC / macOS / Android 同步 `0.1.161`（versionCode 341），PC 客户端代码指纹 `404d59334e921e59`，外壳指纹不变。

## 0.1.160

- 聊天输入框悬浮化：脱离文档流浮在对话底边上、消息从卡片底下滚过（`--chat-composer-h` 补滚动区底部内边距 +「回到底部」药丸抬高）；桌面端卡片四边 / 四角可拖拽拉大缩小（最小 320×120、夹回面板、尺寸进 localStorage、双击把手还原），触屏保持原底栏（`composer/dock.tsx`，DESIGN §138）。
- 输入框收展补 WAAPI FLIP 过渡（220ms，圆角 + 淡入，reduced-motion 跳过）；切换箭头方向修正——收起时上箭头、展开时下箭头（可访问名不变）。
- PC 小窗 ⇄ 主窗切换补窗口 bounds 补间动画（240ms ease-out；macOS 用系统动画；补间途中宽 resize 不判离小窗、恢复落地才最大化；系统减少动画时直接落位），`pc/test/compact.check.js` 新增回归。
- 全端发版：PC / macOS / Android 同步 `0.1.160`（versionCode 340），PC 客户端代码指纹 `9cf3ce76564afe8b`，外壳指纹不变。

## 0.1.159

- 主题配色：素白星尘 / 墨夜星尘补 `data-palette` 明暗令牌块（0.1.156 起选择器可见但选了不生效）；PC `skyglass-tokens.css` 生成物同步。
- 服务端配额预留释放 / 用量记账失败告警的 reason 改用 `reasonWithoutStatement`，不再把含 SQL 的原始 `error.message` 写进日志。
- 全端发版：PC / macOS / Android 同步 `0.1.159`（versionCode 339），外壳指纹不变。

## 0.1.158

- Android：WebView 加载失败的英文错误页遮挡中文提示（出错置 INVISIBLE）；首屏失败「重新连接」落空（无已提交 URL 时退回 origin+path 加载）。错误文案居中。
- 构建链：`Dockerfile` / `deploy/Dockerfile.zh` 补 `patches/` 进 bun install 上下文（`patchedDependencies` 必备）。
- 全端发版：PC / macOS / Android 同步 `0.1.158`（versionCode 338），外壳指纹不变。

## 0.1.157

- 输入框裸网址识别：网址后紧跟中文等非 ASCII 文字时，下划线与可点范围不再把尾巴吞进链接（`bun patch` 修正 `prompt-area@0.7.1` 的 URL 匹配字符集，回归测试 `app/tests/composer-link-boundary.test.tsx`）。
- 聊天浮动面与 PC 窗口按钮进玻璃面名单：「正在处理」状态胶囊、确认卡 / 提问卡 / 核对卡 / 交接提示等直接浮在壁纸上的元素此前不在 `GLASS_SURFACE_SELECTOR`，吃不到 `--lg-*` 釉面变量，只能落到 `:root` 烘焙的 `--glass-strong` 别名（深色 = 不透明 navy）或被 `.glass-shell` 薄纱化的 `--glass-3`（≈透明）；现统一为与气泡 / 侧栏同档的 `--lg-surface-strong` 釉面（`.rs-capsule` 等带持续动画的胶囊不加 backdrop-filter），`perf-noblur` / `resize-pause` 不透明兜底同步扩充。
- 聊天滚动：机器人开始回答时不再「整段往上挪一下」——「思考中」/ 干活 / 暂停 /「已停止」状态行包进固定 38px 槽（`chat-status-slot`，DESIGN.md §94.8），胶囊出现、换样、收起不再改列高；代价是末条消息下常驻一行状态位空白。「已停止」卡更高的部分仍会长列。
- 全端发版：PC / macOS / Android 同步 `0.1.157`（versionCode 337），PC 客户端代码指纹 `72c326725a367466`，外壳指纹不变。

## 0.1.156

- 外观偏好：主题配色新增素白星尘 / 墨夜星尘（非纯白纯黑、带星空质感）；玻璃材质默认统一薄雾玻璃（legacy liquid 回落并入 mist）；艺术壁纸图库 9 → 15 幅（新增 6 幅程序化生成，`scripts/generate-wallpapers.ts`）；「我的模型配额与用量」迁至独立的「设置 → 配额与用量」页（模型分组）并修复明细文本溢出。

## 0.1.155

- 修复群聊私密记忆泄露（注入 + 工具检索双路径）：个人记忆装配改经 `createPersonalMemoryLoader`，`isGroupChat`/`threadId` 不再被丢弃；群聊回合补 `forwardedProps.isGroupChat` 标记；标记经 `buildAgentFor → AgentResolutionContext → loadToolsForActor` 穿到 `memoryNotes.tools`，`memory_search` 在群聊回合按群聊视图检索（恢复路径同样判定传入）；加源码门禁防回归。

- 配额上限原子化：`QuotaService.admit` 按用户配额行串行准入并把预留量先写进账本，并发请求不再双双放行；结算按差量写回，失败调用零结算释放预留，记账失败改结构化告警。

- DSH 孤儿执行收尾：恢复接管的回合在内核会话空闲、内核持续不可达或恢复连续失败约 5 分钟时按 `interrupted` 收尾，残留 `dispatching` 操作统一落 `outcome_unknown`，不再卡部署排空。

- 聊天气泡与浮动面板底材统一：用户气泡与机器人气泡统一为同一面 liquid glass（`--lg-surface-strong` + `--lg-ink`），弃用 0.3 半透明的 `--bubble-user-bg`；必须阅读的聊天浮动面板（核对表单、待答面板、历史提示 / 重试条、接管提示）统一升至 `--glass-3`，面板内控件与小胶囊归 `--glass-2`；干活卡展开的步骤 / 过程话收进 `--glass-3` 气泡卡；DESIGN.md §443 同步。

## 0.1.154

- 版本统一为 0.1.154，Android versionCode 336；Windows 外壳指纹（`7314f9105596bec5`）不变，无需重新安装；PC 客户端代码指纹更新为 `d17e97707583d003`。
- **桌面端内置本地前端与「版本高者优先」同源加载（CB-129 · DESIGN §137）**：新增 `pc/scripts/stage-web-bundle.js`（打包前置暂存 `pc/src/web-bundle/` 并通过 `--verify-asar` 直接读取 ASAR Pickle 头树验证）、`pc/src/local-web.js`（基于 `ses.protocol.handle` 与 Chromium `net.request` `redirect: "manual"`，按 server origin 独立维护 `/api/version` 裁决态，被动嗅探与登录/恢复主动探测驱动 `local` / `remote` 自动切换，剥离 Chromium 解压编码头、保留 `Set-Cookie` / `will-redirect` / SSE 流与路径穿越防御）及 `pc/src/main.js` 接线；`pc/scripts/shell-fingerprint.js` 排除 `src/web-bundle` 与 `routeTree.gen.ts` 同时将 `app/` 与 `shared/` 前端源码纳入 `clientHash`；`release.yml` 在 `pc` 与 `pc-mac` 流水线统一构建内置前端并验包。共享与前端侧通过 `shared/system-update.ts` 新增 `compareSemver` 收敛 `isNewerBuild("pc-<ver>", ...)`，新增 `app/src/lib/version-skew.ts` 联动 `version.ts`、`pc-bridge.ts`、`client.ts`（裸 `404` 提示升级服务端）与 `account-menu.tsx`（双版本副标题与管理员升级快捷入口），补齐 Electron 45 真实 E2E、`pc/test/local-web.check.js`、`shared/system-update.test.ts` 与 `app/tests/pc-local-web-version.test.tsx`；无需数据库迁移。

## 0.1.153

- 版本统一为 0.1.153，Android versionCode 335；Windows 外壳指纹（`7314f9105596bec5`）不变，无需重新安装；PC 客户端代码指纹更新为 `b0a46e5236d43b82`。
- **全域原生融合（Wave 0–6 · DESIGN §136）**：数据库迁移 `0069_native_system_unification.sql` 统一扩展 `chisabot_user_quotas` / `chisabot_usage_ledger`、`chisabot_local_threads` 侧边会话列、`chisabot_im_outbox(files)` 与 `workflow_runs` `resume_token_hash` 恢复列；服务端原生打通 `key-pool`、`quotas/service`（`CB-045`）、`dsh` 多模态图片回传、`agent-computer` 人工接管与国内外 CAPTCHA 阻断、`pc` 原生 `stdio` MCP（修复 `discoverLocalMcpConfigs` 跨平台宿主路径拼接）与局域网配对、`channels/group` 接力守卫、`side-threads`、工作流脱敏毕业与单次 `resumeToken` 恢复、`memory-notes` 四级隔离与 4000 字稳定前缀、`session-search` + `chat-files` 分块、`content-safety-scanner` + `AsyncLocalStorage` 污点强制审批、`im` 非号主/群聊隔离与 Discord/Slack 适配器、`window-expiry` 降级与定时连败免疫（`CB-027`），以及 `audio/speech-service`（`/api/speech/tts`、`asr`）。前端补全配额/密钥池设置、多 Bot 群聊入口与 `/side` 抽屉、以及语音播放 Hook；验证新增 4 份形式化证明（共 8 份，详见 `docs/formal-statecharts.md`）与 `scripts/chisa-bench.ts`（`bun run bench`）。

## 0.1.152

- 版本统一为 0.1.152，Android versionCode 334；Windows 外壳指纹（`7314f9105596bec5`）与 PC 客户端代码指纹（`d165de18744a81f9`）不变，无需重新安装。
- **多图与多卡片错落扇形牌组展示及聊天气泡磨砂统一（CB-128 · DESIGN §135）**：`rich-previews.tsx` / `styles.css` / `chat-transcript.tsx` 推出 `imagePileGeometry(total)` 与带 `[container-type:inline-size]` 基准的单格 CSS Grid 扇形牌组（支持 `caption`、`href` 外链入口、点击直开 `Lightbox` 与窄屏 `--rp-drop-unit` 竖向兜底，修复右对齐 `align="end"` 裁切）；`link-card.tsx` / `link-card.css` 补充 2 卡斜扇与 `--lc-drop-unit` 下限兜底，去掉右卡 `padding-left` 缩进；`shared/json-render/catalog.ts` 新增 `isSafeRenderImageSrc` 允许同源 `/api/chat-files/...` 与 `/api/channels/.../attachments/...`，`media-deck.ts` + `json-render-surface.tsx` + `registry.tsx` 自动将 `Card > Carousel` 或独立多图/多链接容器拆壳升级为扇形牌组，`shared/bot-prompt.ts` 同步更新多图引导；同时解除 `styles.css` 渲染预算对 `[data-slot="bubble-content"]` 与顶层 `.jr-card` 的 `--lg-blur: none` 封锁并在 `perf-noblur.css` / `resize-pause.css` 对称补齐实色退化（裸代码块维持无框透明），使 AI 输出气泡与侧栏/右栏/输入框磨砂质感保持一致，附实机验证与单测（`app/tests/image-pile-deck.test.tsx`、`render-budget.test.ts`、`no-backdrop.test.ts`、`theme-glass-perf.test.tsx`）。

## 0.1.151

- 版本统一为 0.1.151，Android versionCode 333；Windows 外壳指纹（`7314f9105596bec5`）不变，无需重新安装（PC 客户端代码指纹同步更新为 `d165de18744a81f9`）。
- **任务中心四列看板与本地 Markdown 双向协同（CB-127 · DESIGN §134）**：共享层拆分 `shared/task-board-core.ts`（零运行时 `zod` 的 `TASK_BOARD_COLUMNS`、`resolveTaskBoardPlacement`、`board:v1:` `sourceRef` 编解码与看板类型）、`shared/task-board.ts`（Zod 校验 Schema）、`shared/markdown-syntax.ts`（栅栏跟踪、偏移切片与标题/摘要降级）及 `shared/task-center.ts` `lane` 字段；服务端新增 `server/src/task-center/dialects/{autobahn,chisabot-docs}.ts`、`markdown-board-parser.ts`、`markdown-splice.ts`、`file-lock.ts`、`board-discovery.ts` 与 `markdown-board.ts`（基于 `roots.list` ∪ `localRoots` 与 `resolveTaskSourcePath` / `allowedDocument` 的目录沙箱、每文件互斥锁、原子写入、SHA-256 CAS `409`、派发正文 `markUntrusted` 包裹），并在 `routes.ts`（`/roots` 与 `/boards*` 本机写接口强制 `actor.role === "admin"`）、`service.ts`、`runtime.ts` 接入 `scheduleTask`、`recordTaskEvent` 及 `onSettled -> completeCardFromTask` 终态自动回写（幂等标记完成并追加/更新 `#### 交付摘要（ChisaBot 自动回写）` 与 `board_writeback` / `board_writeback_failed` 审计事件）。前端扩展 `app/src/lib/task-center-api.ts` 与 `labels.ts`（均只依赖 `shared/task-board-core` 以防 `zod` 渗入首屏 `shell`），新增 `app/src/components/task-center/{board-format.ts,use-board-mutations.ts,markdown-overlay-editor.tsx,task-board-card.tsx,task-board-doc-panel.tsx,task-board-detail.tsx,task-board.tsx}`（四列个人看板 + 本地 Markdown 看板、deshout 句首柔化、规格胶囊、Pointer Capture 拖拽与无障碍菜单、复选框物理落盘、CAS 重载/覆盖冲突处理、覆盖层编辑器与机器人派发），补充 `task-center.css` / `tasks-rail-card.css` 并完成 `task-center.tsx` / `task-center-dialog.tsx` / `tasks.tsx` / `tasks-rail-card.tsx` / `task-rail-detail-dialog.tsx` 联动。测试见 `server/tests/task-center-markdown-board.test.ts`、`app/tests/task-center-board.test.tsx` 与 `tests/task-center/ui.mjs`。
- **工程基建与门禁收口（`chore/engineering-foundations-overhaul`）**：收口服务端出网与 `process.env` 边界，根除 `mock.module` 测试污染与业务组件裸 `useEffect`（统一迁入 `app/src/hooks/`），开启全仓 Biome 零警告检查并清零生产代码 `!` 非空断言及 `biome-ignore` 敷衍抑制，引入确定性状态空间模型检验器（`shared/verification/model-checker.ts`，覆盖锁租约 / 插件三层授权 / 一次性审批 / 聊天账本）及零下载实机 Edge/Chrome UI 自验收驱动（`scripts/verify-ui.mjs`）。

## 0.1.150

- 版本统一为 0.1.150，Android versionCode 332；Windows 外壳指纹不变，无需重新安装。
- **设备扫码绑定与节点配对全链路修复（#538 · DESIGN §33）**：服务端改动 `server/src/devices/routes.ts`（统一 `hasJsonBody` 与 `readJsonObject` 覆盖 `/pairing`、`/agent/pair`、`/agent/session`、`/enroll`、`/bot-tools/:botId/probe` 并拒绝 `[]` 载荷，`/agent/pair` 改用 `auditControlChange` 并将 `pairing.complete` 移至 `201` 返回前）与 `server/src/devices/pairing.ts`（`Entry.endedAt` 修复 `node` 终态被 `sweep` 提前清理，`MAX_ENTRIES` 淘汰优先清理已结束条目）；前端改动 `app/src/lib/devices.ts`（`pairingErrorMessage` 保留中文错误并按 HTTP 状态码映射英文 `ClientError`）、`app/src/components/devices/pair-phone.tsx`（`useCountdown` 按绑定码 `id` 同步派生倒计时，引入 `openRef` / `rotateTicket` 处理轮询 `expired`/`cancelled`/`404` 自动换码与 `MAX_AUTO_REFRESH` 上限，修复刷新失败过期态分支）与 `app/src/components/devices/full-access.tsx`（`AddServerCard` 增加 `AbortController` 与卸载作废）；Android 端改动 `android/app/src/main/java/cn/ayase/chisabot/GatewayAuth.kt`（域名小写、沿 `cause` 链统一纯中文网络错误、过滤非中文 `error` 响应并保留 `401` 中文停用原因）、`Pairing.kt`（保留 query 字面量 `+`）、`AppViewModel.kt`（异步解绑旧服与清除过期 `loggedIn` 标记）及 `ui/WebScreen.kt`（按 `origin` 重建 `WebView` 并拦截 `/sign` 路径同步执行 `vm.logout()`）。回归测试见 `server/tests/devices-pairing.test.ts`、`app/tests/pair-phone-dialog.test.tsx` 与 `android/app/src/test/java/cn/ayase/chisabot/NativeLogicTest.kt`。

## 0.1.149

- 版本统一为 0.1.149，Android versionCode 331；Windows 外壳指纹不变，无需重新安装。
- CB-126（`DESIGN §131`）：设置页「外观」支持上传/拖入本地壁纸时通过 `WallpaperCropDialog`（`app/src/components/settings/wallpaper-crop-dialog.tsx` + `wallpaper-crop.ts`）按 `当前屏幕 / 16:9 / 16:10 / 21:9 / 4:3 / 9:16 / 原图 / 自由` 比例框选、八向拉伸、平移、滚轮/`1×–4×` 滑块缩放及键盘微调；`wallpaper-compress.ts` / Worker 支持直接按原生像素选区 `PixelCropRect` 裁剪压缩并新增纯内存 `dataUrlToBlob`；`wallpaper-store.ts` 与 `appearance.ts` 在 IndexedDB 持久化 `custom-source` 无损源图及上次裁剪参数，支持外观页「裁剪区域」二次无损重裁并在移除/恢复默认时自动清理。
- CB-125：新增 `shared/validators/primary-agent.ts`、`server/src/agents/primary-agent-service.ts`、`server/src/settings/primary-agent-routes.ts`，接管主 Agent 校验、CAS 自愈、`POST /api/channels` 的 `409 AGENT_PAUSED` 拦截及 `taskCenter` 默认执行人解析；前端新增 `primaryAgentQueryOptions` / `BroadcastChannel` 跨标签同步、`BotsPage` 置顶与主 Agent 操作菜单、`BotProfilePage` 异步切换开关、`/channel/new` 主 Agent 徽标与暂停恢复/切换条，并将 `switchNewChannelRecipient` 收进 `app/src/lib/channels/draft-channel.ts`（保障路由导出纯洁与 `[chisabot-chunk-guard]` 通过）；附单测与 UI 回归 `primary-agent*.test.*`。
- CB-124（分支 `chore/review-hygiene`）：`bubbles` / `mermaid-lite` / `chat-origin`（含各自测试）与 egress 策略契约挪进 `shared/`（新增 `shared/egress-policy.ts`；`agent-computer/src/egress.ts` 改为导入并再导出，原有 `../src/egress` 调用方不变）；`server/computer/policy-network.ts` 改指 shared。新增 `server/tests/no-cross-surface-imports.test.ts`（跨 surface 相对 import 即挂；8 条「测试按真声明 pin 契约」按文件→specifier 白名单）与 `server/tests/no-raw-env.test.ts`（`config.ts` 之外的新裸 `process.env.X` 即挂；15 个存量文件白名单）。`no-raw-fetch` 检测补 `win|window|globalThis|self.fetch(`，`lib/auth/login-redirect.ts` 进白名单。`styles.css` §41① 措辞与 `universalAfterHas` 护栏对齐。`.gitignore` 收 HANDOFF.md / CLAUDE.md / GEMINI.md / `.cursor/`。

## 0.1.148

- 版本统一为 0.1.148，Android versionCode 330；Windows 外壳指纹不变，无需重新安装。
- #532 / CB-123：PC 客户端 macOS 版——`pc/` Electron 外壳适配 macOS（应用菜单、Dock 激活召回、关闭常驻、登录项 / 托盘沿用、`titleBarStyle: hiddenInset` 原生红绿灯 + 网页按 darwin 隐藏 Windows 式窗口按钮）；打包 `dmg` + `zip`（arm64 / x64）+ `build/icon.icns`（`scripts/mac-icon.mjs` 生成）+ `latest-mac.yml`；`updater.js` 新增 darwin 支持与离线改名安装包 `scopedManifest` 验签兼容性修复；`shell-fingerprint.js` 排除 `build.mac/dmg/mas` 不影响 Windows 外壳指纹；`release.yml` 新增 `pc-mac` job、`pc-sign` 同步签名 `latest-mac.yml`；`check-release-assets.mjs` 校验 mac 清单与资产。dmg 暂无 Apple 代码签名（Stage 2）；实机验证 Squirrel.Mac 对 adhoc 签名永远拒装（requirement=cdhash），`updater.js` 据此对未签名 .app `supported=false`，签名落地后更新链即生效。
- #535 / CB-122：完整 UI 审查整改，统一标题重排、异步状态占位、弹窗高度与稳定状态所有权，修复附件反馈、提供方、独立授权页/404、任务导航及文件卡布局；保留既有字体光学裁切，不作全站图标平移。DESIGN §133；正式登录实机验收待完成。

## 0.1.147

- 版本统一为 0.1.147，Android versionCode 329；PC 外壳不变。Windows 更新提示窗随主窗口居中，使用客户端代码指纹区分网页刷新与安装包更新。
- #533 / CB-121：聊天等待改为用户主动停止，移除默认 120 秒首段输出、HTTP 请求与流静默期限；保留明确错误、停止传播和显式调用方期限。服务端与 DSH Host 已同步部署至 `6509519`，健康、模型自检及存量对比通过；正式客户端长任务仍待实机验收。DESIGN §101.10。
- #531 / CB-120 任务中心弹层：账号菜单和右栏入口不再跳转页面，弹层内切换分区、查看详情不改当前地址，关闭后继续原页；旧任务深链接保留。服务端与网页已部署，正式登录入口仍待实机验收。

- #530 / CB-119：鉴权 HTTP 夹具支持 IPv4 / IPv6 双栈，保留 `HTTP://LOCALHOST` 大小写匹配与客户凭据隔离断言，新增 picked / bundled 的 IPv6 实际 HTTP 回归；不再吞掉连接错误，额外检查 RUN_ERROR 为空且收到一次 RUN_FINISHED。私有挂载命名空间内将 localhost 仅解析到 ::1 时，旧夹具复现零请求，新夹具通过。
- CB-119：普通数据库查询执行期间显式保留连接，修复 Bun 1.3.14 排队事务与普通查询的隔离问题；增加单连接回滚隔离、取消与 SQL 文件执行回归，保留 Bot 工厂 30 次并发创建的 10 条拒绝审计断言。手机抽屉接线测试不再依赖 JSX 换行格式；外观设置不再重复写入未变化的壁纸薄幕根样式。
- CI 测试维护：Changelog 的玻璃说明仍须相邻且列表连续，但允许其上方新增日志；截图过期清理以批量夹具保留原有 205 / 400 行覆盖，避免逐行提交耗尽清理测试时限。
- DSH 容量测试：短回合夹具的执行预算由 700ms 改为 2 秒，同时强制排队由 1 秒延长为 3 秒，继续验证完整排队时间不消耗执行预算；不改变生产超时与原有停止、交付和副作用次数断言。

## 0.1.146

- 智能体提供方多实例、子代理直连与 Bot 工具派发（DESIGN §132）：新增 `shared/agent-providers.ts`、同构运行时影子 Home（`shadow-home.js`）、原生 stdio ACP 客户端（`acp-client.js`）与嵌套子代理本地 MCP 桥（`subagent-bridge.js` / `subagent-mcp-stdio.js`）；服务端新增 `chisabot_agent_instances`（AES-GCM 敏感环境变量加密）与 `chisabot_bot_agent_grants`、服务器本机受控宿主（`server-host.ts`）、ACP Registry 检索（`acp-registry.ts`）与 `DirectSubagentRuntimeAgent`；支持 `subagent_*` 与具名工具 `agent_<slug>` 的 `wait` / `async` 双模调用、聊天框 `@智能体` / `SubagentPickerChip` 直连唤起、任务中心 `agent:<id>` 执行器及定时任务 `agentInstanceId` 绑定。
- 预设艺术壁纸图库（DESIGN §131）：`app/public/wallpapers/` 内置印象油画、东方意境、现代光影三大系列共 9 幅 16:9 WebP 画作与轻量缩略图；`appearance.ts` 新增 `ARTISTIC_WALLPAPER_PRESETS`、`WALLPAPER_CATEGORIES` 与 `LEGACY_WALLPAPER_ID_MAP` 平滑迁移并移除内联几何 SVG；`AppearancePreferences` 支持按分类分段筛选、画作卡片预览及已上传自定义壁纸保留一键重启用。
- 版本：0.1.146（根、app、server、agent-computer、runtime/dsh、pc；Android versionCode 328）；PC 外壳不变。

## 0.1.145

- 右栏任务原位交互与卡片质感升级（DESIGN §130）：升级 Skyglass 卡片内高光、语义微光晕、柔和阴影与悬浮/按压反馈（保持全部主题/配色 WCAG AA 对比度与无 `:has()` / 无额外 `backdrop-filter` 约束）；新增右上角 `⋯` 菜单（查看详情、开始/暂停/继续/重试/批准/拒绝、置顶/取消置顶、上移/下移、取消任务/停止工作流）、置顶与排序持久化（`task-rail-order.ts` + `POST /api/task-center/tasks/:id/priority`）、阻塞任务直出取消按钮、「+ 新建」弹窗入口与机器报错人话化；点击卡片改为原位弹出 `TaskRailDetailDialog`（支持任务/审批/工作流详情、交付物预览下载、报错折叠复制与依赖任务栈内返回），不再整页跳走。
- 版本：0.1.145（根、app、server、agent-computer、runtime/dsh、pc；Android versionCode 327）；PC 外壳不变。

## 0.1.144

- 修复独立 DSH 账号运行时隔离误伤：`scripts/ops/isolate-sidecar-app.sh` 按 `chisabot.runtime-owner` + `chisabot.runtime-family` 放行专属点对点网络上的 DSH 容器访问内部工具与模型网关 `:3001`、清理陈旧 `DROP` 规则并在 `--verify` 增加 `:3001/health` 活探，继续严格阻断 Magpie / `new-api` 等边车。
- 图片隐私门禁拦截与撤回：`POST /api/conversations/threads/:id/truncate` 新增 `mode: "withdraw"` 并兼容独立 `RUN_ERROR` 截断；前端错误卡片、纯图片消息与图文消息支持一键撤回与编辑移除附件；`runtime/dsh` 本地 `privacy-gate` 不触发熔断，后续纯文本轮次自动降级历史被拒图片；保留模型归属前缀并识别 `refresh_token_invalidated` 登录失效。
- CB-118 / CB-016 去上游印记与架构收尾：移除旧兼容路由、旧前缀请求头/环境变量、前端与网关历史垫片、旧托管云会话模式、Mastra/Twilio 死依赖并净化 `bun.lock`；`pin-resources.sh` 与 `database-identity.sh` 通用化保留存量卷与数据库身份；退役 Hermes 过渡内核、孤儿模块（`demonstrations`、`team-bots`、`supervisor`、`work/culler` 等）与 `examples/fintech`；新增迁移 `0068_detachment_and_cleanup` 重命名 `chisabot_channel_mappings`、原地归一历史 JSONB 信封键并清理 14 张零引用废弃表；更新 `LICENSE`、`docs/THIRD_PARTY_NOTICES.md`、`.env.example`、看板文档与 CI `agent-computer` typecheck 门禁。
- #511 QA510/511 P3 收尾：密码含未编码 `/ # ? @` 贪婪打码、单用户名令牌识别、Docker `service:port` 与裸内网 IPv6 脱敏；DSH 总等待时间文案、单模型超时不重发、会话事件写盘前脱敏（`runtime/dsh/src/redact.mjs`）；条件式承诺不触发催办；`/api/groups` 未知 Bot 回 400。
- 版本：0.1.144（根、app、server、agent-computer、runtime/dsh、pc；Android versionCode 326）；PC 外壳不变。

## 0.1.143

- 聊天草稿、会话观察释放、重连状态、流式检查点、续执行、任务分页、记忆与设置操作修复；未知接纳不自动重发，失败草稿跨重载保留完整内容。
- Windows 补正确恢复路径与有期限的重连/认证请求；Android 继续使用共用前端手机布局，versionCode 325。
- 本地行为、恢复与性能证据见[体验迭代记录](pipeline-runs/20261111-smooth-experience.md)。合并、部署与正式更新源分别验收，版本记录本身不代表用户已安装。

## 0.1.142

- 任务面板卡片化，移除多余箭头；未知操作可在原对话核对后继续，只读失败不再误挂起。
- 修复跨 Bot 交接租约死锁和忙碌状态误清除；工作流与宿主告警接入既有通知账本；SMTP 支持独立连接设置。
- 新安装默认 DSH，维护和部署探针一致；DSH PostgreSQL/Host 恢复用例进入必跑 CI。Windows 通用版开始强制签名发布并内置公钥。
- 版本：0.1.142（根、app、server、pc；Android versionCode 324）。服务器部署和客户端发布分别验收。
## 0.1.141

- #518 Magpie 一键安装：`admin/magpie` 在未配置 Magpie（无 `MAGPIE_ADMIN_URL`、也无一键装好的）时整页换成 `MagpieInstallSection`；`deploy/updater/magpie.sh` 增 `do_install`（只装 `ghcr.io/yetone/magpie`，核对摘要，有 gh/cosign 时校验构建来源，`MAGPIE_VERIFY=auto|required|off`），`magpie.json` 新增 `installable`/`managed`/`verification`/`isolation`；`install.sh` 随版本拷 `magpie.compose.yaml` 与 `isolate-sidecar-app.sh`；`server/src/magpie.ts` 自动读取宿主机交来的管理密钥，不用重启；更新程序先 `poll_job` 再收请求，失败后可立即重试。
- 版本：0.1.141（根、app、server、pc；Android versionCode 323）；PC 外壳、Android 应用本体不变。

## 0.1.140

- #512 浏览器匿名出口：`agent-computer/src/egress.ts` 在本机全部 Bot 为 `allow_all` 时匿名同样 `allow_all`（受 `ALWAYS_DENIED`），否则保持原匿名策略；`normalizeHost` 去 IPv6 zone，`ALWAYS_DENIED` 增 `fec0::/10`、`64:ff9b:1::/48`、`2002::/16`，策略变更掐断在途 CONNECT，HTTP/502 中文拒绝页；`screencast.ts` `navigationProblem` 把隧道/代理/DNS 失败归为「连不上」；`profiles.ts` 启动只传 `{server}`；`use-control.ts` 轮询单一来源。
- 版本：0.1.140（根、app、server、pc；Android versionCode 322）；PC 外壳、Android 应用本体不变。

## 0.1.139

- #515 长对话重连循环：`use-conversation-sync` 核对只比已加载窗口；`join-backoff` 重接退避、重试必发；`shared/connect-snapshot` 增量快照，`conversations/routes`、`runner`、`local-conversations` 配合下发；`friendly-error` 把 403 套餐限制翻成中文原因；回归测试 `app/tests/connect-loop-regression.test.tsx`。
- 版本：0.1.139（根、app、server、pc；Android versionCode 321）；PC 外壳、Android 应用本体不变。

## 0.1.138

- 版本：0.1.138（根、app、server、pc；Android versionCode 320）；PC 外壳不变，Android 应用本体有改动。服务器部署与客户端发布分别记录。
- Android 主界面改为桌面共用 React 前端的手机布局，保留原生登录、文件选择、导出、键盘及返回键能力。
- 正式服务器已完成 DSH 与 conversation reader 4 迁移，保留原会话、消息、任务和审批；移除 早期上游模板 产品入口与现役接线。
- CB-114（`fix/chat-reliability`）：流式正文使用聊天气泡，普通 Markdown 不再自动转文档，修复残留空白与滚动突跳；早期 Hermes 回退实现已由 DSH 运行时替代。正式部署与恢复记录见 `pipeline-runs/20261108-assistant-production.md`。
- #514 设备审计打码：`devices/store`、`devices/hub`、`computer/activity-store` 写审计摘要前统一走 `computer/activity-redact`（环境变量写法、JSON/YAML 值、URL userinfo、密钥前缀高熵判定、先打后截、线性扫描）；`confirmations/service` 复用同一 `redactText`。
- #509/#510：运行失败统一脱敏、任意 scheme URL 凭据打码、`/api/groups` 管理员限定与 inbox `no-store`；DSH 首输出超时换备用模型 + 失效模型熔断、最后候选保留首输出期限、只承诺不行动催办边界。

## 0.1.137

- 右栏顶部分段扩为「面板 | 任务 | 计算机」三段（`RailTab` 增 `tasks`，子页签持久化 `chisabot-panel-rail-subtab`），无计算机能力时两段；有待确认审批时「任务」挂 needs-you 圆点。
- 新增 `TasksRailCard` / `useRailTasksSummary`：聚合任务中心 outbox 待确认（就地 `decide`）、工作流 `ACTIVE_RUN_STATUSES`（步骤进度条 + `waiting_approval` 步骤就地 `approve`/`reject`）、进行中任务（`pause`/`resume`）与近期交付；styles 增三段滑块位移与 `data-count="3"` 窄宽。
- `AgentsRailCard` 从右栏移入任务中心 Capabilities 视图；「面板」页签只剩实时面板。
- 版本：0.1.137（根、app、server、pc；Android versionCode 319）；PC 外壳、Android 应用本体不变。

## 0.1.136

- 工作流闭环与续跑：步骤支持 `rejectTo`/`maxReworks`、`onFailure`（`fail/reject/continue`）、`retryStrategy`（`targeted_fix/full_redo`）；`targeted_fix` 保留步骤底层 `threadId` 续跑并注入结构化修改反馈，重试自动叠加最新角色绑定。
- 结构化验收门禁（Gate）：步骤开启 `gate` 时注入 `submit_gate_result`（`pass/rework/fail/human` + `findings`），支持本步自修正闭环、跨步打回与人工升级。
- Bot 工具治理与工作流操控：新增 `get_workflow_run`、`control_workflow_run`（服务端强绑定 `person` 身份 + 异步受理）与 `inspect_tool_schema`；远程工具回调入口接入 `guardWorkflowCallback` + `restrictToolsForWorkflow`；`confirmations.wrap` 对所有工具统一执行回合停止守卫。
- Android：面板标题去重读 `props.text` 及编译修复。
- 版本：0.1.136（根、app、server、pc；Android versionCode 318）；PC 外壳不变；Android 应用本体有改动正常原地更新。

## 0.1.135

- AI 输出契约（§126）：`shared/output-contract` 一张表定每种输出在 web/app/IM 的归宿（native/degraded/none）+ 完整性测试；无壳 render 内容自动补壳（`shared/json-render/shell` + web/Android 两侧）；`:::card/group` 容错；GitHub 就地连接胶囊两端同款；`person.surface` 闸门让 App/IM 回合不开等人填的卡。
- 「没发出去」诚实化：`persisted:null` 改判 `unverified`（不是「没到」是「核实不了」），channel-chat 90 秒迟到对账——落地就撤卡收草稿；`ui-memory` 增 `sendLanded`/`listenSendLanded`，composer `retractRestoredDraft` 只收没被改过的那份。
- 撤销/停止/取消在每个边界生效：设备紧急操作先落库再旁路、IM 发回复前后复校 `canUseConnection`、回合锁等待可中止、墓碑读失败拒默；pc 在途 shell/后台任务随 stop 终止；agent-computer 会话清扫保活在途操作、/health 探针不建会话、工作区符号链接拒出。
- 竞态修复：schedules 认领行锁 + 静默只看成功 + 时间校验；pages 行锁事务；vault api_request 中止/限流/拒跟跳/域名复校；model-fallback 中止传播 + 首输出前流错误走下一键；guarded-fetch/socket 生命周期；MCP 钉公网地址；收件箱回复排空；重连按 revision 回填；设置草稿防迟到覆盖。
- deploy：auth 改密/停用/删除下旧会话不再存活；updater 管道死锁 + 状态原子写；nginx 端口从访问地址取。
- Android：设备绑定/续期令牌只属当前登录服务器 + 会话代际；输出渲染对齐网页（干活步骤、files 成果卡、:::card/group/brief、链接卡、动作胶囊、GitHub 连接对话框）。
- 版本：0.1.135（根、app、server、pc；Android versionCode 317）；PC 外壳有改动走「重新安装」路径；Android 应用本体有改动正常原地更新。

## 0.1.134

- 发送看门狗误报修复：每条 /run 流订阅即回执 RUN_STARTED（下游真实 RUN_STARTED 去重）——「受理到开跑」的静默前置（等收尾/抢锁/落快照）不再被误判成「没发出去」并停掉在途回合；hang 只在真的什么都没到服务器时成立。
- 上一轮收尾等待有界：`running.done`/`relay.closing` 两处死等 60 秒上界超时如实报错；`closeFrontend` 的 settle 重试 60 秒让位，不再永久堵死对话。
- 落库检查双证人：收件箱（join/排队路径）也算「到了」——单查 messages 会把已排队误判成没到；滚动部署期间旧服务端同样受益。
- 版本号 0.1.134（根、app、server、pc；Android versionCode 316）；PC 外壳、Android 应用本体不变。

## 0.1.133

- 修重复发送隐患：`reply_hang` 看门狗超时不再直接 throw 回填草稿，交统一出口按 `turnAnswered` 判定——已落库且做出过东西的一轮只挂原因，重试走消息上的「重试」；什么都没做成才回填。
- 队列 held：排水失败的 parked 消息标「没发出去」+ 手动重试，不再挂着「排队」干等。
- 活动记录防炸：坏 URL 不再互递归爆栈（redactPlain 兜底）、循环/超深 detail 降级为 null；plan/finish 异常只告警不传给动作。
- PC 图标统一：.ico 全尺寸帧与托盘底图改用整幅胸像（桌面构图），托盘状态角标保留；新哈希 ico + 指纹走整包重装路径。
- 版本号 0.1.133（根、app、server、pc；Android versionCode 315）；PC 外壳有改动走「重新安装」路径；Android 应用本体不变。

## 0.1.132

- 「已压缩前文」状态行移除：压缩是实现细节不显示在聊天里；压缩保留、库里历史不丢。
- `history_recover`：占位符自带消息 id，模型可按 id / toolCallId / 范围从当前线程消息表取回被省略的原文（只读、30k 分页、不弹确认卡）。
- 中国应用连接目录（directory）：服务全景超集（remote / stdio 本机桥 / link 文档路径），catalogue 白名单单向晋升；管理后台目录页；vault 凭证 keyParam/keyHeader。
- 液态玻璃防整屏翻暗：全屏亮度一票否决 + 行内过半共识；LG_INK_LINE 0.5→0.45 带迟滞。
- PC 更新源失效自愈：feed 报回的版本低于当前版本 → feedStale 标记 + 本机覆盖源自动退回下一级（构建期/GitHub）重查；本机标签显示失效源信息。
- PC 登录窗：卡片铺满窗口去掉外层天空框，win-bar 透明浮层，版本脚标钉底缘。
- 版本号 0.1.132（根、app、server、pc；Android versionCode 314）；PC 外壳有改动走「重新安装」路径；Android 应用本体不变。

## 0.1.131

- 车队模型审计 `fleet_audit`（§125）：只读工具，机器人据此评估每个 bot 的模型配得对不对并给换模型建议；远程 bot 只列不评，fleet/ 只读豁免不需确认。
- 版本号 0.1.131（根、app、server、pc；Android versionCode 313）；PC 外壳、Android 应用本体不变。

## 0.1.130

- 桌面端改名 ChisaBot：productName / 可执行文件 / 快捷方式 / 安装包名去 PC 后缀；安装包 customInit 静默卸旧「ChisaBot PC」，启动时迁移 userData 目录，指向旧 exe 的快捷方式/pin 重写指向新 exe；appId 与更新源路径不变。
- 品牌图标换朽叶千咲淡色底半身像：全端 favicon/PWA/登录页/PC/安卓图标重出；生成脚本 Pillow → Node+sharp（generate.mjs / win-icon.mjs），不再依赖 Python。
- 管理员在网页对话里 `mcp_add` 接自定义 MCP：探测出确认卡、「添加连接器」类别 locked 恒问、非 destructive 工具自动授权、不收明文凭据。
- 机器人自我地图：为当前对话的人工作（含是否管理员）、自己是 MCP 宿主、执行内核在下层，别把别家客户端教程当接入方案。
- 聊天：气泡只要正文、胶囊只在干活时出现（§123）；唤醒话折叠成一行（§124）；收起右栏/关抽屉不再清「计算机」标签。
- 版本号 0.1.130（根、app、server、pc；Android versionCode 312）；PC 外壳变更（图标 + 改名），旧客户端走「重新安装」路径自动迁移。

## 0.1.129

- 液态玻璃材质重写（#500）：liquid（默认档）换完整材质——`--lg-*` 令牌 + `@property` 滑行，Chromium 加 feDisplacementMap 边缘透镜与红蓝色散，其余浏览器纯 CSS；背景 5×3 采样自适应墨/密度，`alphaForContrast` 兜底最暗墨 ≥4.5；深浅两套雾度设置；性能/减透明度/强制色彩不透明兜底，弹层菜单行保持原样。
- 「追问」按需出现（#499）：链接卡浮层按钮改悬停 / :focus-visible / 触屏长按 450ms 才出，「已压缩前文」只留最新一条，用量回传用真实值校准估算。
- 版本号 0.1.129（根、app、server、pc；Android versionCode 311）；PC 外壳、Android 应用本体不变。

## 0.1.128

- 目录声明窗口抬过端点误报 + 轮中换模真修好（#490）：Magpie /models 不给 swe-2 带 context，Ollama 探测回落 32K < Hermes 64K 下限导致 configure 永远失败；轮中重试调公共 set_session_model 必撞 -32603 busy，备用模型落不上去。现在服务端 catalog 内置已知窗口表（swe-2/swe-1.7 系 262144）并经 contextWindow 下发，适配器按目录值抬上下文下限（只抬不压），轮中重试改走 _switch_model。
- 版本号 0.1.128（根、app、server、pc；Android versionCode 310）；PC 外壳、Android 应用本体不变。

## 0.1.127

- 模型配置失败透出真实原因并可落备用（#488）：configure 异常被吞成通用文案，主模型配不出来直接硬死；现在 `data.details` 原文进错误详情、全文进服务端日志，失败冷却该模型并换下一个健康候选，session 丢失 / busy 单独如实报；具名 custom provider 反查改用 upstream canonical identity。
- 版本号 0.1.127（根、app、server、pc；Android versionCode 309）；PC 外壳、Android 应用本体不变。

## 0.1.126

- Magpie 更新拉取加上限时与心跳（#486）：pull 静默无超时会永远停在「拉取镜像」；改为后台执行 + 每 15 秒心跳 + 900 秒判失败，`up -d` 加 120 秒兜底，pull 输出末尾进任务日志。页面补齐排队中 / 成功 / 未执行三态与实时已用时长。
- 版本号 0.1.126（根、app、server、pc；Android versionCode 308）；PC 外壳、Android 应用本体不变。

## 0.1.125

- 「在活动里看」跟着工具步骤开关一起藏（#482）：步骤行默认隐藏时，电脑工具旁的跳转链接成了气泡外的孤儿；现在与过程行同开关，干活卡展开步骤里的同款链接一并隐藏。
- 版本号 0.1.125（根、app、server、pc；Android versionCode 307）；PC 外壳、Android 应用本体不变。

## 0.1.124

- 横条输入框附件挪到框上方（#483）：缩略图塞进 999px 圆角胶囊会把它撑成高圆角块、图被边缘裁掉；附件条挪到框上方与拒收提示同列，横条保持一行高，语音输入中附件保持可见可删。展开态与 hero 输入框不变。
- 版本号 0.1.124（根、app、server、pc；Android versionCode 306）；PC 外壳、Android 应用本体不变。

## 0.1.123

- 深色模式输入框边界补可见（#479）：无边框悬浮设计只靠黑色投影当边、压深底几乎看不见；给 `--lg-shadow` 叠 1px 白色内描边 + 顶边高光，圆角随胶囊 / 展开形态，缩放暂停时照旧整体关阴影。
- 版本号 0.1.123（根、app、server、pc；Android versionCode 305）；PC 外壳、Android 应用本体不变。

## 0.1.122

- 主题配色与动态天象各扩到 8 款、卡片预览去同质（#478）：配色新增银杏暖金与朱砂绛红（浅 / 深色全套 token，对比度过 a11y 矩阵）；天象卡在 auto / live 之外加晨霞初晓·檀香山、风暴雷云·迈阿密等 6 个互不相同的场景，每张卡预览渐变独立，附真实渲染回归测试。
- 版本号 0.1.122（根、app、server、pc；Android versionCode 304）；PC 外壳、Android 应用本体不变。

## 0.1.121

- 「计算机」标签跨页导航不丢（#477）：同机器人页里非后退导航丢 `watch`（`/` 落地跳回、左栏再点同一行）不再清「计算机」记忆——清除要求 `lastHistoryEventWasPop()`，只认真·后退 / 前进，记忆保留时补地址 effect 把 `watch=true` replace 回来。
- 版本号 0.1.121（根、app、server、pc；Android versionCode 303）；PC 外壳、Android 应用本体不变。

## 0.1.120

- Bot 造 Bot（#470 / #471 / #473）：`agent_profiles` provenance 列（迁移 0062）+ `createCoworker` 集中服务；create / list / update / disable 四工具带审批与每人、深度上限；双向 `kind="bot"` 授权；前端工具渲染卡、「由『X』创建」徽章、管理员授权面板、`/api/groups` 最小路由恢复。
- 模型熔断与修复（#466 / #472）：主模型分类熔断 + 指数冷却；400 / 413 / 422 按请求拒绝先清洗重试再回落；多模态按模型能力转换；切换模型后工具与系统提示保留、首 token 限时不等死。
- IM P3 后续（#475）：`allowPrivate` 仅在改动时发送；企微 / 钉钉主人回填只认安全字段，认不出不回填。
- 构建守卫（#474）：`vite build` 钉死 `NODE_ENV=production` 修 `browser` ↔ `vendor-markdown` 分块环，CI 加双构建 + chunk 图校验。
- 发布闸门（#468）：公开 Release 只收 `pc-generic-unsigned`，`check-release-assets.mjs` 校验 flavor / 白名单 / `latest.yml` 一致性 / 签名在场。
- 测试修复（#476）：Link mock router 感知、schema 契约补 0062 列与索引、tool-selection 断言接受 developer 角色。
- 版本号 0.1.120（根、app、server、pc；Android versionCode 302）；PC 外壳、Android 应用本体不变。

## 0.1.119

- IM 扫码一键绑定（#465）：微信 ClawBot / QQ 官方机器人 / 企业微信智能机器人 / 钉钉 / 飞书（Lark）连接表单内嵌「扫码绑定」，扫码确认自动创建 / 绑定机器人并填入凭据（`server/src/im/qr-auth.ts`；QQ 凭据 AES-256-GCM 解密，飞书识别 Lark 租户自动切域名）。
- IM 通道双向打通：待确认操作推送 IM 可直接回复处理（含 approvals 审批）、bot-threads 全端「当前对话」同步、模型回复回推 IM 线程、频道活动按来源写回。
- 引导页：修复固定天空背景遮住标题和「继续」按钮。
- 版本号 0.1.119（根、app、server、pc；Android versionCode 301）；PC 外壳、Android 应用本体不变。

## 0.1.118

- pstack 工程纪律移植（#464）：`examples/zh-CN` 租户包新增 41 个策展技能（24 条原则 + 纪律技能 + 改写的 `poteto-mode` 路由与三个 playbook）；新工作流预设 `pstack-adversarial-review`（异模型攻方并行实测 + 主审复核）；`scripts/pstack-port.mjs` 生成器固化上游适配规则，归属进 `docs/THIRD_PARTY_NOTICES.md`。

- 发消息 Invalid params（#462）：具名自定义 provider（如 Magpie）会话切到非默认模型后每轮在模型调用前被 ACP -32602 拒——`_make_agent` 现在用 keep_endpoint 携带的 base_url 反查具名 provider 再解析（`chisabot_acp.py`）；桥接层把 `error.data.details` 里的真实拒绝原因拼进 RUN_ERROR（`bridge.mjs`）。

- 模型报错更准更简洁（#461）：模型调用失败的英文运维提示不再当成回复发给用户——`reply_failure_category` / `turn_failure` 识别后按分类报错，登录被撤销单独提示「模型登录已失效，请重新登录」（`chisabot_protocol.py`、`friendly-error.ts`）。

- 频道输入框日常收成两头半圆的横条（只有 +、输入区、发送键旁的展开箭头、发送键），箭头切换完整工具栏并记住选择；compact 编辑器行高收紧，光标只比文本高一点。

- 修复云端电脑「看不到屏幕」：Dockerfile 浏览器版本改从 `agent-computer/package.json` 派生，消除 playwright 与 Chromium 的版本错配。

- 版本号 0.1.118（根、app、server、pc；Android versionCode 300）；只有服务器 / Hermes 运行时与网页更新，PC 外壳、Android 应用本体不变。

## 0.1.117

- 滚动时不再因 `peer-hover` 反复标脏整段对话（`ui/sidebar.tsx` 里没人用的两处，`no-group-has.test.ts` 加守卫）。未升级版本号。

- 版本号 0.1.117（根、app、server）；只有网页更新。

## Unreleased

- 引导页：修复固定天空背景遮住「欢迎来到 ChisaBot」标题和「继续」按钮的问题。未升级版本号。

- 长对话只自动挂最近 96 条（`TAIL_FIRST_CAP`），上滚继续加载；应用内搜索、`?message=` 深链、活动记录跳转会先挂全。浏览器 Ctrl+F 搜不到没加载的旧消息。未升级版本号。

## 0.1.116

- Android 形象头像（#425）；登录循环保护补丁（#456）；Markdown 块级解析缓存（#447）；面板 tooltip 懒挂载（#454）；打开设置提速（#455）；依赖更新（#382、#390、#385）。

- 版本号 0.1.116（根、app、server、PC、Android，versionCode 298）。

## 0.1.115

- 改窗口大小时暂停 WebGL 天空，<html> 挂 data-resizing；停下后按最终尺寸重画一次（#449）。

- 切会话即时反馈：左栏高亮先到，对话延后渲染；切换中旧页半透明、不可输入，不会发到旧会话（#448）。

- 版本号 0.1.115（根、app、server）；只有网页更新。

## 0.1.169 — 2026-11-19

- 主题配色看得出来了：6 个配色的亮 / 暗都覆盖强调色、强调浅底、主按钮、聚焦色，新增 `--glass-tint` 把强调色叠进左栏 / 右栏 / 输入框毛玻璃；非 default 配色一律不启动 WebGL（不管是否智能跟随），天空用主题渐变（樱花：粉白黄昏 / 深紫红夜），设置页提示「彩色主题下使用主题天空」；写死的蓝色（开关、进度条、加载图标等）改用主题变量；「模型加载失败 · 重试」深色对比度 ≥ 4.5。主按钮对比度 ≥ 4.5，default 与 main 像素一致、布局不变（fix/palette-theme）。

## 0.1.114

- 公网网关下会话过期：收到网关 401（`chisabotAuthRequired`）整页去 `/login?next=`，不再停在 `/sign` 加载；30 秒内又碰到就显示「登录状态异常」和「退出重新登录」，不再来回跳（#442）。

- Service Worker 升到 5：导航拿到网关 401 去 `/login?next=`，从 `/login` 回来的 401 原样交给浏览器（#442）。

- 手机抽屉里导航后自动收起；`/channel/new?agent=` 总开新话题，只有最近的对话还没消息时才复用（#442）。

- 版本号 0.1.114（根、app、server）；只有网页更新。

## 0.1.169 — 2026-11-19

- 拖动改窗口大小时更顺：改大小期间暂时去掉大面积毛玻璃和阴影，换成不透明底色，松手后恢复。

## 0.1.113

- GitHub 仓库链接出竖版大卡：服务端查 GitHub API 拿描述、星标、头像，og 图拿不到用头像兜底；429 只缓存 5 分钟（#439）。

- 电脑端顶栏回退：只留左下账号卡，搜索和左栏开关回到左栏；手机不变（#440）。

- 卡顿测量工具 `perf/`（`bun run perf:jank` / `perf:compare`，CI `perf.yml` 只写 job summary 不拦 PR），不改应用代码（#443）。

- 版本号 0.1.113（根、app、server）；只有服务器 / 网页更新。

## 0.1.112

- 链接预览：GitHub 预览图 429 时回退（`opengraph.githubassets.com/1/…`、作者头像），失败短 TTL；YouTube / bilibili / 百度百科走接口出卡片；反爬 / 验证页降级；Punycode 同形字保留 `xn--`；非 2xx 一律 `no-store`（#412，网关配置改动未上线）。

- 冷打开频道只读一次完整历史；断线重连回填补上漏收的工具调用，和手动刷新一致（#421）。

- 版本号 0.1.112（根、app、server）；只有服务器 / 网页更新。

## 0.1.169 — 2026-11-19

- 定时任务设置页（审查模块 13）：起手句中性、只填不发（S4）；运行记录「显示更多」20→40→50（S7）；行内「已暂停」，运行中「立即运行」置灰并说明原因（O8）。未升级版本号。

## 0.1.169 — 2026-11-19

- 设置页审查模块 12：常驻指令有未保存的更改时，切左栏 / 浏览器后退先确认（`useBlocker`），刷新 / 关标签有 beforeunload 提示；技能、记忆、导入 SKILL.md 弹窗有改动时 Esc / 点遮罩 / ✕ 先确认（全站统一用确认）。设置文案和真实功能对齐：配色说明从 `THEME_PALETTES` 生成，去掉「内置流光壁纸」，精选技能不写死数量，左栏「生图与识图」和页面标题一致，「密钥」不在左栏单列（并在 账号连接 → API 密钥，仍能搜到），常驻指令超长报错改中文。中文标题的技能自动生成合法名字并标「必填」；常驻指令保存中只禁用按钮。测试 `app/tests/settings-audit-12.test.ts`。不升版本号。
- 设置页审查模块 12 复审返修：设备权限 / 本机智能体两个保存栏页接上未保存拦截；确认框 Esc 和点击不再传到下面的弹窗（去掉 150ms 窗口）；取消后焦点回原输入框；拉丁字母少于 4 个的技能名字加 hash 后缀。测试 `app/tests/settings-audit-12-confirm.test.tsx`。不升版本号。
- `docs/DEVLOG.md` 记录设置页审查模块 12 的动机、改动和前后截图（`docs/images/settings-audit/`）。

## 0.1.169 — 2026-11-19

- Hermes 内核：每轮下发备用模型链和输出上限（`model:{id,fallbacks,maxOutputTokens}`），adapter 设到 Hermes agent，切到备用模型时回报并复用现有提示和日志；设置页只在检测到 Hermes 不支持时注明「不生效」。
- Hermes 内核长历史压缩：按上下文窗口估算（有上一轮真实用量就校准，否则乘 1.15 安全系数早压缩），超过 70% 裁掉旧工具结果和超长旧消息，超过 85% 用缓存的摘要代替较早轮次。本轮不等摘要模型（首字时间不变），回复结束后后台写摘要、下一轮再用；按话题 + 轮次范围缓存，较早消息编辑 / 删除 / 重新生成时失效，续写 5 次或超 600 字整段重摘；摘要模型可在「模型 → 摘要模型」配置，默认跟随主模型。宿主压缩过的运行关掉 Hermes 自带压缩，避免二次压缩。数据库完整历史不动；回复下方显示可展开的「已压缩前文」。新增运行时建表的摘要缓存表 `chisabot_history_summaries`。长话题样本 token：改前 164,250 → 裁剪 48,736 → 下一轮摘要 33,212（31 轮样本改前 168,116）。
## 0.1.111

- 新话题首字延迟：发送即显示「思考中」；新话题 `/run` 前不再串行等列表刷新、接入回放、读历史、面板会话（线上实测 `/run` 发出 ~2.2s → ~0.84s）；个人记忆几段并行读；研究类问题预置 research-public-web 技能（普通对话不加字）；提示词：能直接答的不搜、动手前一句 ≤15 字再调工具；服务器每轮一行 `run-timing` 分段计时。未升级版本号。

- 联网搜索质量（hark 对比 #3 #5 #8 #11）：认出 DuckDuckGo 的 202 反爬页并冷却 10 分钟直接走 Bing；搜索源不可用时明确告诉模型别再搜；Bing 回退的结果先过相关性（任一完整词命中即保留，关键词兜底）、跳转链接还原成真实网址（内网地址不还原）；过滤后为空报「没搜到相关结果」而不是「搜索源不可用」；没搜到时不再叫模型连搜，并在代码里限次：一轮 2 次没搜到或搜索源不可用后不再联网搜索；DuckDuckGo 要有 anomaly 标记才算反爬；web_search 描述要求多条结果尽量来自不同网站并注明来源；DuckDuckGo 失败时服务器日志记一行。json-render 的 `List` / `Card` 遇到认不出的图标名不再画空的灰色方块。未升级版本号。

- 天空背景换场景渐变不再停在半路：主线程卡的时候渐变会停在 0.76～0.98 一到四秒才跳完，现在渐变开始后一直醒着画到结束（最多 8 秒），引擎跳过不画的那一拍也续上；天气（open-meteo）响应的 body 读完时再叫醒一次天空，网慢时天气带来的那次渐变也能画出来。只改 `sky-background.tsx`，新增 `lib/sky-fade.ts`，`wallpaper_core.html` 未改。未升级版本号。

- 附件缩略图：`GET /api/attachments/:id?w=240|480|960` 用 sharp 缩成 WebP（进程内存 LRU，64 MiB / 2000 项，单项 ≤ 2 MiB），其他宽度 400，非图片 / GIF / 不必缩 / sharp 不可用时回原图；权限判断同原图。用户消息的单张图和一摞图改拉缩略图，点开大图仍是原图。打开一个含 4 张图的对话，图片传输 5.30 MB → 53.6 KB（桌面）/ 203.6 KB（手机 2x）。缩图同时最多 2 张、其余排队；sharp 加载失败只打一次明确警告；Docker 镜像里已确认 sharp 可用。排队超过 8 个直接回原图（不缓存）；图片尺寸记忆按实际加载的地址记，缩略图尺寸不再记在原图名下。新增依赖 `sharp`，未升级版本号。

- 修复：机器人连发多条消息只显示最后一条——`compactTurns` 以最后一个干活的步骤（`isWorkCall`，不含记忆写入）为界，之后的全部文字都是回答气泡（tone 为 final，带链接卡、复制按钮）；测试 `app/tests/consecutive-replies.test.ts`。

- 流式回复时打字不再乱序、不再残留（#408）：Composer 的 `agents` / `commands` 放进 ref，`triggers` 只建一次、`handleChange` 不再随每个流式块换引用，按键之间不会再被旧值写回（原来 4x 降速下边流式边打字会变成 `bcdefghija`、退格留残字）；测试 `app/tests/composer-stream-typing.test.tsx`。只改前端。

- 修复：空对话第一轮从本机发出后断线不补——`useConversationSync` 记下本机在跑时问到的序号（`seenSeq`），没有 `last` 基线时拿它比；打开后第一次问照旧只记基线（#411）。
- 只升级服务器版本号（根、`app`、`server` 为 `0.1.111`），PC / Android 外壳未变。

## 0.1.169 — 2026-11-19

- 修复「一键整理记忆」（审计 12-settings 必修 1）：先预览、弹窗列出要合并的组再确认（带 token，期间有变化返回 409）；合并后超过 4000 字的整组不合并，不再截断；分组区分机器人和情境；整个整理在一个事务里，原文写入 `chisabot_memory_tidy_backups`，可在 8 秒内或「更多」→「撤销上次整理」恢复；`memory_dream` 归入「删除」审批：卡片逐组列出预览、按 token 执行，每周整理的定时任务改为留一张整理建议卡片等确认（不再直接拒绝），确认后记忆变了会重出卡片说明原因；删除设为「直接做」时照常执行并附撤销链接，新增 `memory_dream_undo`；按钮移入「更多」菜单。不升版本号。

## 0.1.169 — 2026-11-19

- 修复：当前时间按用户时区（Asia/Shanghai）写并标明时区，和长期记忆同一天；测试 `server/tests/reply-quality.test.ts`。
- 修复：Hermes 适配器透传模型出错的分类（限流 / 上下文过长 / 超时等），网页出对应提示；测试 `examples/hermes-agent/tests/`、`app/tests/hermes-error-categories.test.ts`。
- 返修：Hermes 出错分类跳过内置异常（工具的 FileNotFoundError / PermissionError / timed out 不再冒充模型错误），只按 HTTP 状态码 + 模型 SDK 异常类型；403 看 body 分地区限制 / 内容拦截 / 密钥，分不清走通用提示；分类函数不再抛异常（body 序列化兜底、bytes 解码、截断 64KB），适配器出错时一定 run.fail。
- 提示词：来源只在末尾写一次；卡片收尾写结论；公式加括号；拒绝给替代；写上当前模型；记忆笔记与出处规则写明优先级。
## 0.1.169 — 2026-11-19

- 新话题页支持选择 / 粘贴 / 拖入附件：先建一段不进列表的草稿对话（`POST /api/channels` `draft: true`），把文字和文件带过去再跳转；没发就离开（去新话题页时立即，去设置等别处留 10 分钟）时带条件删除（`?draft=1`，服务端确认仍是空草稿才删，否则 409，不写审计不发通知），字放回新话题页；本标签页回收过的草稿再打开 404 时静默跳回那个机器人的新话题页；服务端每小时清理超过 24 小时的空草稿（非 `local` 运行模式不删）。建草稿期间不能发送、建草稿和跳转期间再加的文件一起带过去、全被拒不建草稿；没有宽高的图片先占固定框。用户消息里的图片按已有尺寸稳定占位，多图走叠放组，点开看原图。没有表结构变化，未升级版本号。
- 回归返修：没发就离开草稿对话去新话题页时，写了一半的字在新话题页输入框第一次渲染时就在（新话题页挂载时同步 `reclaimDraftText`，不再等草稿页卸载回收后才放回）；测试 `app/tests/draft-leave-new-topic.test.tsx`。
## 0.1.169 — 2026-11-19

- 回复过程照 Hark 改：等待时只在机器人一侧显示一行状态胶囊（转圈 + 当前动作 + 秒数），替代原来的「思考中」三点气泡和停顿时的占位气泡；一轮做完后干活卡自动收起（从历史打开的也默认收起），不再留在对话里；正文里只有「---」、空白或标点的过程话 / 步骤不再画成一项。胶囊用现有设计 token（`--r-pill`、`--glass-strong`、`--glass-shadow-sm`、`--dur-2`），不用模糊，动画只动 transform / opacity；减少动态效果时转圈静止，减少透明度 / 性能模式下为不透明底色。样式在组件自己的 `app/src/components/chat/status-capsule.css`（只有 `rs-` 开头的新类），styles.css 未改。新增 `app/tests/reply-steps.test.tsx`。未升级版本号。
- 回复过程按审查修正：只有代码块的回复不再整段消失（`isBlankNote` 只认整段都是 `---`、`***`、`…` 这类分隔符，可以夹空白）；工具失败后没有文字、或只回了 `---` 的一轮不再是一片空白：干活那一行不收起（「N 步失败」），下面一句「这一轮没有回答」和重试（走现有的重发入口）。读屏：干活卡按钮名字里带上当前动作，对话末尾保留一个一直挂着的 `role="status"`，「思考中」换成干活卡时照样读出；键盘点开步骤后这一轮收起时焦点移到收起后的那一行；停顿时的胶囊和以前的占位等高（22px）；切换频道回来秒数不归零；胶囊换成干活卡不再播一次淡入；深色的不透明底色改用 `--glass-bg-solid` token。未升级版本号。
- 回复过程第二轮审查修正（#404）：以卡片收尾、后面没有字的一轮（生成图片、分享文件、问人、确认卡 / 审批卡、宿主提示、活动卡）不再被当成「这一轮没有回答」挂重试——判断和真正画卡片用同一份 旧聊天前端框架 渲染器表，只画一行过程的计算机工具注册时标 `lineOnly`；窄屏（≤ 560px）上没有回答的那一行仍显示「N 步失败」（`data-unanswered`，样式在 `status-capsule.css`，没改 `styles.css`）；同一轮重新开始跑（重试、确认后接着跑）时胶囊和干活卡的秒数从 0 算，切换频道回来仍不归零。
- 回复过程第三轮审查修正（#404）：生成图片 / 分享文件没拿到文件、定时任务被拒或报错、生成界面画不出东西时，渲染器什么都不画，这一轮改为算「没有回答」并给重试；判断由各渲染器自己导出（和它决定画不画用同一个函数）。
- 工具步骤显示按审查（模块 7）修正：后台任务卡（`delegate_task`）不再在这一轮结束、任务还在跑时跟着干活卡一起收起，刷新后也在——`delegate_task` 不算干活步骤，干活卡的锚点自己画卡片时只收干活那一行；在跑时点开干活卡，还没返回的步骤写「正在…」，不再标「（失败）」；停止后这一轮的步骤留着（收起，可以点开），没返回的标「已停止」，不计进「N 步失败」；同时在跑的几步写「正在搜索 N 项」「正在读取 N 个网页」，点开每一项都在；读网页那一步写主机名 + 短路径（`httpbin.org/status/500`），HTTP 4xx / 5xx 算失败；后台任务卡收起的清单 / 结果正文 `inert`，展开按钮的 `aria-expanded` 跟着真实状态，进度用 `role=status` 播报；调试模式下的工具输出改成纯文本、超过 4000 字截断、点开才画。依赖 #404。
- 回复过程第四轮审查修正（#404）：电脑上的 agent（`device_agent_run`）、后台任务（`delegate_task`）被拒时不再算有回答，后台任务也不再一直挂着等待卡；一轮结束后工具一直没有结果时，骨架换成「…没有完成」，这一轮算没有回答、可以重试；`render_ui` 格式有误时，这一轮已经结束就写「界面格式有误，没能显示」，不再说会重新生成。

## 0.1.110

- 修复：断线重连后漏掉的消息不补——`useConversationSync` 隔 15 秒以上才问到变化戳时不再只记基线，序号变了就合并式接上；测试 `app/tests/reconnect-backfill.test.tsx`。

- 修复：打开对话时历史读两遍——打开时的接入结束后不再做顺序核对（那边刚读过），本机一轮结束后的核对不变；测试 `app/tests/channel-open-single-read.test.tsx`。

- Hark 改版第 2 步（顶栏外壳）：左上圆形主页按钮、右上搜索胶囊 + 头像，中间只留「聊天」一个视图；PC 窗口按钮、手机、深浅色都可用；搜索胶囊用 `.glass`（顶栏唯一模糊层），同屏模糊层桌面 5、手机 1。DESIGN.md §10.5 写明同名 Hark 令牌必须在 `html.dark` 给深色值。不升版本号。
- `docs/DEVLOG.md` 记录 Hark 顶栏（第 2 步）的动机、改动和前后截图。

- 性能模式和系统「减少透明度」下全局关掉毛玻璃：一条 `*, *::before, *::after { backdrop-filter: none }`（`app/src/perf-noblur.css`，不用 `!important`），漏网的代码块操作条、遮罩、外观预览一起关掉；原来模糊的面板换成不透明底色 `--glass-bg-opaque`。实测两种模式下桌面、手机可见模糊层都是 0，普通模式与 main 一致。新增 `app/tests/no-backdrop.test.ts` 防止新的模糊绕过；规则见 DESIGN.md §10.3.1。
- 只升级服务器版本号（根、`app`、`server` 为 `0.1.110`），PC / Android 外壳未变。

## 0.1.169 — 2026-11-19

- 链接卡组照 Hark 错落叠放（依赖 #380）：多个链接叠成一叠、悬停 / 聚焦 / 触屏第一次点换到主位（只改 transform，离开后保持最后一张），GitHub 宽图按原比例完整显示、底行「GitHub · v0.1.13」；材质改用设计系统令牌（`--glass-bg-solid`、`--r-lg`、`--sp-2`，不模糊），标题纯文本，props 兼容 #391 来源格式（未接入）
- 链接卡组修正（依赖 #397）：流式输出时同尺寸骨架占位；悬停换主位不再整页重算样式（卡组属性 `data-slot` → `data-stack-slot`，避开 styles.css 的 `:has([data-slot=…])`，styles.css 未改；CPU 1× 最长任务 53 ms → 不超过 50 ms）；用户消息里的链接也显示成卡组（靠右）；「追问」移出 `<a>`、触屏明确显示、隐藏时不接点击；小图不放大不裁切；预览存 sessionStorage，刷新不跳（重访 CLS 0）；favicon 懒加载；URL 关 `calt`；可选 `kind: "video"` 播放角标（服务端未改）。顶栏一项跳过（#374 未合并）。未升级版本号。

## 0.1.109

- 壁纸与外观收尾（审查第 6 项 + 性能报告第 7 项）：天空引擎不再请求 `ipapi.co`（不把用户 IP 发给第三方），GPS 失败时改用浏览器时区估计位置；壁纸上传限类型（PNG / JPG / WebP / GIF / AVIF）和大小（原图 ≤ 20 MB、压缩后 ≤ 约 6 MB），超限或保存失败时用现有 toast 明确提示，不再假装“已应用”；壁纸图片改存 IndexedDB，localStorage 只留占位标记，旧数据自动迁移并清掉；外观滑块拖动时 localStorage 写入防抖（停手约 200ms 或页面隐藏时写），预览仍实时；修掉 `appearance-preferences.tsx` 的 6 个 Biome a11y 错误；自定义壁纸 URL 写进 CSS 时转义 `\`、`"` 并去掉换行；刷新时选的是自定义壁纸、localStorage 里只有占位标记的话，先只铺主题纯色、不挂天空，IndexedDB 读回就直接显示壁纸，读取失败、没有记录或超过约 1.5 秒才退回天空，不再先闪一下天空。不改样式和外观。（#376）
- 回复来源结构化（数据格式先行）：新增 `shared/reply-sources.ts`，来源 = 这一轮里成功的 `web_fetch`（网址、标题、站点、toolCallId），挂在这一轮最后一条有文字的助手消息上；不新增存储和事件，实时和历史都从同一批消息算出。部署开关 `CHISABOT_REPLY_SOURCES`（默认关，/api/capabilities 带 `replySources`）打开后，网页聊天的 Bot 不再在正文写「来源：」行。前端卡片另做；开关关着时行为不变，旧客户端不受影响。未升级版本号。（#391）
- web_fetch 超时 / 连接中断时重试并降级到搜索摘要，报错不再被说成「用户已停止这一轮」；工具失败后模型没再说话时补一段回答，这一轮一定有回复（Hark A4）（#392）
- 只升级服务器版本号（根、`app`、`server` 为 `0.1.109`），PC / Android 外壳未变。


## 0.1.108

- 回复风格对齐 Hark（提示词 + 服务端）：去掉「导语 → 卡片 → 下一步」固定三段式，默认一个气泡、1–4 句、结论先行；render_ui 画过表格卡后不再附一份 Markdown 表格（提示词 + 工具结果都提醒）；推荐类问题直接给 2–3 个带价格的选项再追问（web_search 工具描述里写明一般搜 1–3 次就收敛）；数学用 Unicode 纯文本，不用 LaTeX（前端不恢复 katex）。安全和不可信内容相关的提示词一字未改，新增测试按 sha256 钉住。未升级版本号。（#381）
- 只升级服务器版本号（根、`app`、`server` 为 `0.1.108`），PC / Android 外壳未变。

## 0.1.169 — 2026-11-19

- 修复（Android）：`Turns.buildTurn` 一轮结束后以最后一个干活的步骤（`WorkSteps.splitsReply`：网页的 `isWorkCall` 再去掉记忆写入）为界，之后的全部文字都是回答气泡（`Kind.Result`、可复制）；`WorkSteps.NOT_WORK` 补齐网页的 message_bot / file_share / image_generate / image_edit；测试 `NativeLogicTest.allTextAfterLastWorkStaysVisible`、`notWorkMatchesWeb`。

## 0.1.107

- 链接卡照 Hark 改版：正文里单独一行的链接和 json-render 的 `Link` 合并成一个组件（`app/src/components/rich-previews/link-card.tsx`）。有预览图时是固定宽约 280px 的竖卡：上半 og:image 大图（cover，上方两角圆角），下面两行粗体标题和一行浅色「站点 · 补充信息」；没有图时退成同宽的紧凑横卡。半透明底 + 内侧高光边，不用 backdrop-filter；骨架和卡片同尺寸，图片懒加载并预留宽高。json-render 的 `Link` 不再只用模型写的字段：缺的预览图、标题、站点名用 `/api/link-preview` 补全，模型给了的优先，所以 GitHub 等链接现在会显示 og:image。样式在组件自己的 `link-card.css`（只有 `lc-` 开头的新类），styles.css 未改。未升级版本号。
- 链接卡数据侧按审查修正：模型写的标题如果只是站点名 / 域名，或被 og:title 包含（如「GitHub」「ChisaBot」），改用 og:title；每个链接给出预览图、站点名和补充信息，底下一行是「站点 · 补充信息」（如「GitHub · v0.1.13」）。标题和站点行不再固定高度（只有骨架预留），一行标题时下面不再空一大块。视觉细节留给前端的叠放卡改版。

- 手机尺寸左栏抽屉（Hark 手机端）：一层全高面板，宽 `min(85vw, 320px)`、右侧圆角；顶部搜索 + 新建 + 关闭一行，账号在面板底部（分隔线 + 安全区）；遮罩只压暗、点它关闭；只动 transform 的 200ms 开关动画，减少动态效果时关闭；玻璃只剩面板一层，性能模式 / 减少透明度下不透明。
- 只升级服务器版本号（根、`app`、`server` 为 `0.1.107`），PC / Android 外壳未变。


## 0.1.106

- 对话记录同步改成增量：`…/threads/:id/messages` 支持可选 `since` / `cursor`（没变回 `unchanged`、变了只回尾部，旧客户端不变），界面实际路径（频道聊天页 `readThreadMessages` 的各处读历史、每轮结束后的顺序核对）都带 since/cursor 增量读，600 条对话没变化一次读约 530 KB → 83 B，没变化不 `setMessages`，编辑 / 删除 / 读失败 / 旧服务器照旧整份；三张卡片的每秒计时器合并为共享时钟。（#370）
- 只升级服务器版本号（根、`app`、`server` 为 `0.1.106`），PC / Android 外壳未变。

## 0.1.105

- 修复：开着 Service Worker 时 Chrome 登录最后落到 `/api/auth/error?error=state_mismatch`（会话其实已写入）。sw.js 不再开 navigation preload，激活时显式关掉（`SW_VERSION` 3）；`/api`、`/auth` 下的导航照旧不拦、只由浏览器发一次。未升级版本号（#373）。
  - 一次性过渡窗口：部署后，没刷新过的旧页面直接登录，或者刷新后在新 Service Worker 接管之前就登录，这一次仍由旧的 v2 Service Worker（开着 navigation preload）处理，可能还会出现一次 `state_mismatch`，再登录一次就好。新 SW 接管时间按代码算：页面 `load` 后用 `requestIdleCallback` 注册（超时 5 秒；浏览器不支持时固定 2 秒），再加上下载、安装 sw.js 的时间，`skipWaiting` + `clients.claim` 后立即生效，所以大约是刷新后 5 秒以内。之后不会再出现。

- 安全（审计 #5）：公网 nginx 只信任 Cloudflare 官方网段给的 `CF-Connecting-IP`（`real_ip_header` + `set_real_ip_from`），`limit_req`、日志和 `X-ChisaBot-Client` / `X-Forwarded-For` 改按真实客户端 IP；网关身份头 `X-ChisaBot-Identity` 加一次性随机数 `j`，应用在 ±2 分钟有效期内只认一次，重放返回 401（去重缓存 TTL = 有效期、上限 10 万条）；nginx 每个转发都清掉客户端自带的 `CF-Connecting-IP`、把 `X-Real-IP` 设为真实 IP，IM OneBot 失败限速和设备令牌限速共用同一个取 IP 函数（`gatewayClientIp`），伪造头绕不过限速。未升级版本号（#372）。

- CI 门禁加固：`scripts/biome-new-issues.ts` 在 Biome 自身出错（退出码非 0 且没有可解析的 JSON，例如 biome.json 写坏）时一律失败；改用 `process.exitCode`、正常返回，确保 `biome-base-*` 临时目录被清理；用法注释与 workflow 实际传的基线一致；新增 `scripts/biome-new-issues.test.ts`。修默认 `error` 输出自己调自己（有新增问题或 Biome 出错、又没传回调时——CI 正是这样调用——脚本卡死），找不到 Biome / git 可执行文件改为退出 2（#366）。
- CI：新增 Biome「只拦新增问题」检查（`scripts/biome-new-issues.ts`，与基线逐文件按规则比诊断数）、完整 `bun run test:app`、pc/ 独立安装 + chisabot-node 打包检查（审查清单第 3 项）（#366）。

- 修 test:app 共享进程里的测试干扰（use-control 的 wake 监听、schedule-runs-query 的 mock.module 泄漏），修 gateway-account-control / startup-resilience 及 5 个 server 测试；server 补 `旧聊天运行时包` 开发依赖；CI 下 chisabot-node 打包失败即构建失败；schedule-fired 的 `Link` 替身不再漏给其他文件（有路由时用真 `Link`），移出隔离名单；avatar-picker-shape 拆 DOM 前先 `settleReactWork`，`test:app` 退出码恢复 0（#368）。
- 只升级服务器版本号（根、`app`、`server` 为 `0.1.105`），PC / Android 外壳未变。

## 0.1.169 — 2026-11-19

- PC 更新验签（审查第 7 项 / M7，**Windows 端到端跑完前不合并**）：发布时用 Ed25519 给 `latest.yml` 签名（`chisabotSig`，覆盖版本、安装包 sha512 / 大小、外壳指纹、是否重新安装），客户端用内置主 + 备公钥校验并重算下载文件的 sha512，不通过一律删掉安装包、拒装、写审计；自建版没配公钥时保持旧行为并在「本机」页提示（可用 `CHISABOT_UPDATE_PUBKEYS` 提供公钥）。CI 新增 `pc-sign` job（Environment `pc-release`，只允许 `v*` 标签、不设审批），新增 `pc/scripts/sign-update.js`（带 `--verify`）和 `gen-update-key.js`。核对 electron-updater 6.8.9：没有 `publisherName` 时 `verifyUpdateCodeSignature` 根本不被调用。不改版本号。详见 `docs/pc-update-signing.md`。

## 0.1.104

- 修复干净安装（默认隔离 linker）下 `shared/json-render` 解析不到 `@json-render/*`、typecheck/build 失败的问题：根 `package.json` 补声明这两个依赖；app 补声明测试与 vite.config 直接用到的 `@ag-ui/client`、`rxjs`、`esbuild`（版本均与 lockfile 一致）（#365）。
- 出口过滤代理按 Bot 独立鉴权：HMAC 派生的每 Bot 代理密钥，空密码 / 错误密码 / 冒充一律拒绝，无凭据连接改走不含任何 Bot 放行名单的独立兜底策略并记节流日志；硬拒绝新增 `0.0.0.0/8`、`100.64.0.0/10`；服务器发往电脑的命令带上 botId（#364）
- 渲染性能：毛玻璃收到预算内（大面板 20px、弹层 12px，气泡 / 按钮 / 胶囊 / 滚动区卡片不再模糊，同屏可见层数桌面 14 → 4），WebGL 天空默认只画快照（换场景保留完整的 2.5s 渐变，改窗口大小 / 回到前台 / 切回天空当帧重画、不闪灰）、动态天空限 15fps / 0.6 倍分辨率且空闲即停，无限动画只动 transform / opacity，新增性能模式状态与「减少透明度 / 动态效果」适配，外观偏好只写改动过的键（#363）
- 安装版 `app/serve.ts` 转发 `/api` 时去掉已失效的 `Content-Encoding` / `Content-Length` 和逐跳头，修复 gzip 响应导致 `/api/me` 加载失败（`ERR_CONTENT_DECODING_FAILED`）；多值 `Set-Cookie` 照常保留（#367）
- Hark 改版第 1 步（令牌层）：深 / 浅两套 Hark 设计令牌、Inter Variable 字体、唯一玻璃材质 `.glass`（暂未使用）；玻璃令牌拆成半径（面板 20px、弹层 12px、饱和度 160%）+ `--glass-filter` / `--glass-pop-filter`，次要 / 三级文字透明度 .5 / .3。不改布局，不升版本号（#369）。
- 只升级服务器版本号（根、`app`、`server` 为 `0.1.104`），PC / Android 外壳未变。

## 0.1.103

- 聊天 SVG / Mermaid 卡片改用 DOMPurify 清洗、SVG 卡片改为 `<img>` 渲染，修复存储型 XSS（审查 S1，#362）；主应用加 CSP Report-Only。只升级服务器版本号（根、`app`、`server` 为 `0.1.103`），PC / Android 外壳未变。

## 0.1.100

- 将自定义壁纸设置中的网络 URL 输入框替换为本地图片点击/拖拽上传区域与壁纸网格内直达上传卡片，全端同步升级至 `0.1.100`（`versionCode` 297）

## 0.1.99

- 统一同步全仓子包版本号（`app`、`server`、`agent-computer`、`pc`、`android` 全部升级至 `0.1.99`，`versionCode` 296），并修复服务器桌面端更新源安装包文件名与 `latest.json` 同步

## 0.1.98

- 完整引入 Hark 原生 WebGL 动态天空与天气壁纸引擎（`wallpaper_core.html`，含 12 个全球地标天象与实时时钟天气），并 1:1 复刻 Hark 的 50px 高斯模糊与图层混合半透明液态玻璃设计系统，修复构建器（LightningCSS）剥离 `backdrop-filter` 导致玻璃失去半透明模糊透视的问题（versionCode 295）

## 0.1.97

- 重构液态玻璃（Liquid Glass）高透光学质感：修复 Chromium Backdrop Root 阻断背景透视的问题，改用冰白半透明晶块材质（默认 84% 透光率）与环境柔光球折射，新增「雾蓝光晕」壁纸与「玻璃面板不透明度（5%–80%）」无级调节滑块，并将聊天气泡、搜索框、分段槽与右栏实时卡全部升级为半透明液态玻璃（versionCode 294）

## 0.1.96

- 新增 8 款精选主题配色（晴空蓝、极光紫、翡翠森、樱花粉、深海蓝、暮光金、绯红星、曜石黑）、6 款内置流光壁纸与自定义图片壁纸配置（支持本地上传、链接输入、景深模糊与暗角遮罩调节），并将主界面各板块全面升级为液态玻璃（Liquid Glass）高透折射材质（versionCode 293）

## 0.1.95

- 优化右栏「计算机」面板与活动记录：去除重复的顶部「大屏正在直播」提示条，将人工接管步骤由「请你帮忙 / 我来接管浏览器。」修正为「接管了浏览器」并去重，提炼后台面板刷新标题，净化长网址参数并改为单行紧凑排版（versionCode 292）

## 0.1.94

- 修复云端电脑（`agent-computer`）在 Bun v1.3.14 下因 `node:net` Happy Eyeballs 定时器异常导致的进程重启（「暂时连不上电脑」）；网页检测到服务端新版本或 PC 节点重连时立即触发桌面端在线更新检查（versionCode 291）

## 0.1.93

- 多标签页电脑控制选主（`CB-107`）、PWA 导航超时/502/503 自动恢复（`DF-13`）、记忆「全部撤销」防闪烁（`CB-111 P3`），以及全项目深度安全加固（SVG/Docx 预览净化、技能/数据源/IM SSRF 与 TLS/CRLF 防护、容器权限收紧）、PC 客户端 Windows 进程列表与 Worktree 行尾修复、多机器人 `/exec` 出口代理隔离与工程化修复（versionCode 290）

## 0.1.92

- 形象头像的表情接进默认左栏的机器人列表（宽栏、窄栏、当前对话行）：被选中、在跑、做完时会变表情（versionCode 289）

## 0.1.91

- 形象头像：14 个形状 × 11 种颜色，换形状时变形，被选中 / 机器人在跑 / 做完一轮时有表情；技能共享、公共知识库与 MCP 全员授权的修复；邀请默认关闭并增加「允许添加新成员」开关；清理 lint 存量错误并修复设备本地 agent 面板的 hooks 顺序问题（versionCode 288）

## 0.1.90

- 定时任务测试并行互不干扰（`CB-112`，#333）；桌面客户端令牌无效提示写明每 60 秒重试、后台重试托盘不闪，定时任务短名不再留白（#334）（versionCode 287）

## 0.1.89

- 连删记忆撤销提示最多 3 条，其余合并为「全部撤销」；手机不再盖住「⋯」（`CB-111`）（versionCode 286）

## 0.1.88

- 桌面客户端握手遇 5xx 退避重连、401 非撤销每 60 秒重试、明确撤销才停止；PR CI 加入 pc-test（`CB-113`）（versionCode 285）

## 0.1.87

- 定时任务测试修正并加入 CI（`CB-109`）；测试收尾排空 React 调度修偶发 window is not defined，PC 客户端主动断开的握手中连接不再报错（`CB-110`）（versionCode 284）

## 0.1.86

- 电脑控制三态（none / live / user_control），接管时暂停预览不再报 503；`/control` 恒 200 并带退避，连不上时不刷控制台错误；每个机器人单一轮询源（`CB-103`）（versionCode 283）

## 0.1.85

- 记忆删除改为 8 秒后才真删、撤销不再重建（保留原 id 与创建时间）（`CB-106`）；电脑卡片外框不再 button 套 button（`DF-30`）（versionCode 282）

## 0.1.84

- 定时任务可编辑（名称、重复规则、时间、内容）并显示时区；`?runs` 非法值回落、窄屏任务名宽度、详情超过 60 秒自动刷新（`CB-106`）（versionCode 281）

## 0.1.83

- 侧栏搜索键盘导航（↑/↓/Enter、输入法友好、读屏器语义）、命中显示机器人与最近活动时间、跳转后命中行不再被顶走（`CB-106`）（versionCode 280）

## 0.1.82

- 定时提醒后续：窄屏单条时间不截断、超过 20 条运行记录时时间正确、跨年范围带年份、启动时清空已暂停任务残留的 next_run_at（`CB-105b`）（versionCode 279）

## 0.1.81

- 记忆删除确认与即时撤销（保留公共知识库标记）、长列表每类先显示 50 条、「管理全部长期记忆」改为应用内跳转、写入详情不再显示内部 id（`CB-106`）（versionCode 278）

## 0.1.80

- 停止和排队消息可靠化：停止宽限 1.5 秒、Esc 停止、失败可重试、停止中消息直接发送、暂停补充消息不再误报与重复（`CB-104`）；到点提醒按运行时间显示、连续提醒折叠、暂停清空 next_run_at（`CB-105`）（versionCode 277）

## 0.1.79

- 计算机活动记录改为服务端持久化（`CB-101`）：按轮次分组、你的操作与打码、合并命令、拒绝文案、活动 ↔ 聊天双向跳转、窄屏「画面 | 活动」切换、新增迁移 0060（versionCode 276）

## 0.1.78

- 竖屏 / 手机网页 / Android 全面适配（`CB-098`）：左侧栏与右侧面板抽屉不再裁切、可点击可关闭，返回键先关闭抽屉，安全区与软键盘适配（versionCode 275）

## 0.1.77

- Hermes 后续：内核/URL 不一致判失败、连接超时快速失败、漂移检查去 python3（`CB-100b`）；网关兼容旧账号控件标记不再重复浮出退出按钮、上下文用量文字、首屏加载提示（`CB-100c`）（versionCode 274）

## 0.1.76

- 固定 compose 默认网络为 `早期上游模板-zh_default`（`172.19.0.0/16`），Hermes 不可达时快速失败并纳入发布自检（`CB-100`）；彻底下线云端 Claude Code 工作区、云端节点与电脑文件夹同步，`/cc` 重定向到 `/`，相关数据表保留不 drop（`CB-099`）（versionCode 273）

## 0.1.75

- 早期上游模板 → ChisaBot 统一命名：代码、文档、界面、包名、环境变量（兼容旧 `旧前缀环境变量`）、请求头（新旧双认）、本地存储（自动迁移）、部署容器与目录；数据库/表/Cookie/数据卷等持久化名字保留

## 0.1.74

- 多用户管理与管理员角色（`CB-096`，§117：在线开启账号/邀请、直接新建账号、管理员邀请、升降角色与直接改密）；后台统一配置公共知识库（`CB-097a`）、全局共享技能（`CB-097b`）与 MCP 全员自动授权（`CB-097c`，§118）

## 0.1.73

- Hark / Grok Bot 实测对标全量落地（`CB-089`–`CB-095`）：Word（`.docx`）文件在线预览（`CB-089`，§111：同源 `.docx` 文件卡弹窗预览，按需动态加载 `docx-preview@0.4.1` 不进首屏包，>10 MB 或解析失败回退下载提示）；对话选项卡片选完就定（`CB-090`，§112：`render_ui` 的 `Button` 新增 `choice: true`，点选后标 `✓` 并锁定同卡其余候选按钮，刷新/换设备从后续首条用户消息自动还原已选态）；主机器人防误删与更换（`CB-091`，§8：主机器人左栏菜单隐藏「删除机器人…」改为「更换主机器人…」，`DeleteBotDialog` 拦截直接删除）；机器人资料页「文件与页面」归集（`CB-092`，§113：按今天/本周/更早分桶与游标分页）；单聊机器人往来锚点卡 `BotExchangeCard`（`CB-093`，§116）；右栏栏头「＋」快速新建面板与「换一批」预设轮换（`CB-094`，§114）；账号连接页 `全部 | 连接 | 登录信息 | 密钥` 四分类标签与保险箱内嵌（`CB-095`，§115）

## 0.1.68

- 默认开放「设置 → 插件与 MCP」并在「设置 → 账号连接」直接展示官方可开启连接器（Notion、Google Drive、Parallel Search）；升级 `connect_service` 支持 `service="全部"` 四层连接器全景盘点、识别内置 Gmail/QQ/163/Outlook 邮箱与日历数据源、对官方目录连接器主动开启并自动将工具授权给当前机器人；新增对话内直连工具 `email_connect`（自动匹配 Gmail 等 IMAP 服务器）与 `calendar_connect`，并随回复输出可点击的账号连接卡片（versionCode 265）

## 0.1.67

- 修复从聊天页进入「设置 / 管理后台」后点击左栏底部「返回聊天」无法切回聊天界面的问题：`rememberBotsLocation()` 仅记录 `/channel/...` 与 `/group/...` 会话路径，且 `_authed/_app.tsx` 基于 `s.resolvedLocation ?? s.location` 读取已确认位置，防止过渡帧中把 `/settings` 误记为最近会话导致「返回聊天」指向设置页自身（versionCode 264）

## 0.1.66

- 修复后台工具调用（如 `panel_refresh` 刷新面板、`web_fetch` 等）耗时超过 12 秒时被首段发送看门狗提前调用 `stopAgent()` 误杀并报 `这一轮出错了：This run was stopped.` 的问题：仅在确认消息未送达服务器（`hang`）时中止，已送达服务器的回合进入 180 秒回复看门狗；识别 `HERMES_RUN_CANCELLED` 并清除已折叠行（`data-folded`）子元素外边距留白（versionCode 263）

## 0.1.65

- 彻底消除发送消息时对话列表往上跳动：取消新发用户消息的 `data-scroll-anchor` 1/3 视口翻页与底部 2/3 屏空白垫高，统一走自然贴底跟进；`deliver()` 将用户消息乐观入列提前至 `panelAuthoringForwardedProps` 网络请求之前同步执行，并与 `live` 门控对齐，消除回车后 200ms 两段跳；移除 `useSmoothSendScroll` 的 700ms `scroll-behavior: smooth` 并在 `SettleAtEnd` 内容增长时绘制前同步 `stickToBottom()`；禁止已停止回合或新回合追溯给上一轮回复补挂 `╭─` 引用头（versionCode 262）

## 0.1.64

- 彻底消除切换页面、切换机器人与发送消息时的对话列表闪烁、全量重绘与高度跳动：历史消息与多段气泡在打开/切换会话时首帧 `initial={false}` 直接实心绘制；修复 `useTailFirstMount` 顶部渐进挂载时的 `scrollTop` 同步补偿；`useChannelEvents()` 提升至 `ShellFrame` 常驻且设置页「返回聊天」一步直达原会话；`usePanelBot()` 首帧同步解析 `routeBotId`；`TranscriptMessage` 与 `BotBubbles` 补齐值级 `React.memo` 隔离，消除流式 token 全量重绘、点击发送瞬间 `<PauseDots />` 弹跳及流结束被在途 `/sync` 误清空重放（versionCode 261）

## 0.1.63

- 修复聊天流划选文字出现异常弹窗及按 `Ctrl+C` 复制时把聊天记录往上顶的问题（移除 `MessageScroller` 内联 `SelectionQuoteToolbar`，保留消息操作栏「引用」与卡片「追问」）；实时看板对管理员默认开启 `CHISABOT_PANEL_COMMANDS=1` 并支持非管理员平滑降级，修复创建云服务器性能监控面板失败；释放 `Ctrl+K` 快捷键冲突并对齐引用栏与链接卡追问样式（versionCode 260）

## 0.1.62

- Hark 式对话与个人助理 8 大特性全量上线：气泡外 `╭─` 双向回复引用胶囊、多卡片扇形叠放与悬停聚焦虚化、划词与卡片级一键「追问」、内联 Mermaid/SVG/HTML 交互预览卡、每日晨报卡片（`CB-014`）、日历 ICS 与邮箱 IMAP 只读接入（`CB-013`）、PC 全局快捷键 `Alt+Space` 随手问浮窗、Web Speech 浏览器原生语音速记、`✨ 已记住` 记忆写入微胶囊与一键撤销、右侧看板独立刷新小模型配置（`CB-088`）（versionCode 259）

## 0.1.61

- 云端 Claude Code 双端工作区与增量同步升级：启动回合前先触发在线电脑 `sync_flush` 对齐刚保存的改动（8 秒预算，离线/超时自动降级）；多轮对话前将 `work/` 的新增改动三方增量同步进会话工作树 `trees/<session>`；「合入工作目录」升级为 `git apply --cached --3way` 三方合并（同文件不同位置自动合入，同位置冲突支持「让 Claude 处理」读取 `../../work/` 合并并自动推进基线）；新建/开启同步首轮 `flush` 超时转入后台续传不再误删工作区，电脑离线时云端合入自动暂停同步并收回租约完成合入；修复 Windows 下同步 SSH 私钥继承目录权限导致 OpenSSH 拒读的问题（versionCode 258）

## 0.1.60

- 机器人浏览器多标签（§95）：「新建一个标签点不进去」。`profiles.openTab()` 少了 `bringToFront()`，新页成了当前标签却没有真的显示——Chromium 的 screencast 只合成在显示的那一页，画面停在上一页；而点已经高亮的标签以前不发请求（新标签恰好就是这个状态），所以毫无反应。现在新标签带到前台，接管状态下再点当前标签会重新 `activate`（幂等，顺手 kick 转播）。客户端只对齐版本号（versionCode 257）

## 0.1.59

- 对话内直接回答或关掉机器人的问题（§110）：待回答问题画在提问所在的对话输入框上方，与「待处理」共用同一个回答接口；新增 `POST /api/approvals/questions/:id/dismiss`（「不用回答了」），对话已删时也能清掉侧栏挂着的数字；回答或关闭后当场刷新 `bot-lifecycle` 计数。Claude Code 左栏搜索行与面板外账号卡和机器人侧逐像素对齐（§73.2）。客户端只对齐版本号（versionCode 256）

## 0.1.58

- 聊天：切机器人 / 从别的页面回到对话不再「像刚发了一次消息」——恢复出来的那条历史消息不再被当成刚发出的（对齐到视口 1/3、底下垫 2/3 屏空白），接入回放也不再被画成一轮回答（发送键不再先变「停止机器人」、末尾不再挂「思考中」）；往上翻着读时排队补话不再被拽回底部。输入框高度只跟内容走（以前失焦就塌成一行、写好的几行被裁掉），发送后光标当场回输入框。纯服务器 / 网页改动，`pc/` / `android/` 没有代码改动，也没有客户端发版。

## 0.1.57

- 右栏自定义面板（§109）：面板可挂最多 3 个直连数据源（https / 本机命令），宿主按每个源的间隔自己取数、值回填 `/live/<id>`，不再每小时花 token 让模型重算；卡片两两并排、拖比例、拖高、折叠，布局按机器人记在本机；⋯ 菜单新增「让 AI 修改…」「数据来源…」。密钥走保险箱、明文拒收；命令源默认关闭且只给管理员（`CHISABOT_PANEL_COMMANDS=1`）。客户端只对齐版本号（versionCode 255）

## 0.1.56

- 在线更新：「有新版本，点此刷新」的确认只拦真会丢的东西——回复中、输入框上没发出去的附件（含离开对话时收起来的）、编辑中的消息与还没提交的审批回答；不再扫整页输入框（卡片表单 / 面板 / 搜索框误报），聊天草稿本来会记住就不再拦。客户端只对齐版本号（versionCode 254）

## 0.1.55

- 云端 Claude Code：退出 Claude 以节点上的 `claude auth status` 为准——`claude auth logout` 之后必须再确认一次，CLI 没退掉（旧版没有这个子命令 / 网络卡住被超时结束 / 凭据没删掉）就删掉它自己报告的 `configDirectory` 里的 `.credentials.json` 再确认，还登着才报错；服务器让退出发出之前的那次 `status` 结果作废，并发的自动复查不会把刚退掉的账号改回「已登录」；失败显示在账号卡底部红字。客户端只对齐版本号（versionCode 253）

## 0.1.54

- 机器人电脑（大屏 / 直播）：多个窗口同时看同一块屏幕，不再互相顶掉（以前第二个窗口会让第一个显示「另一个窗口看着」并停下）；屏幕真的结束（停止 / 重置 / 浏览器关闭）不再叠假的「正在重新连接…」；断线重连预算约 90 秒，部署重启后自己回来；第二个窗口自动挂上直播；启动中关窗不再拉起电脑。客户端只对齐版本号（versionCode 252）
- 机器人电脑（右栏 / 大屏）：右栏把「大屏正在直播」显示成中性的「大屏正在直播」而不是 ⚠️「暂时看不到屏幕」；收起大屏 1–2 秒接回画面；关闭按钮挪到卡片外右上角；点标签自动接管；人工接管空闲一小时自动交还
- 内核：所有内置机器人走 Hermes / ACP 运行时；管理页显示内核与健康信息；先查再接、输入法首字被吞等回归一并修掉

## 0.1.53

- 输入法（聊天输入框）：合成期间不再把受控值写回编辑器，首字不再被吞；输入法确认候选字的 Enter 不再发送；合成被打断（失焦、拿不到 compositionend）时按已显示文字提交并复位；去掉高度过渡，打字不再上跳。`prompt-area` 升到 0.6.8（锁文件原先停在 0.6.7）。客户端只对齐版本号（versionCode 251）
- 聊天可靠性（CB-087）：修复长聊天节点替换和结束时跳动；Stop/失败/重启后补话持久暂停，由用户单条恢复；请求期限、长命令预算、数据库异常恢复及 Python 生成编码指导一并补齐。发布验收记录见 `docs/pipeline-runs/20261021-comprehensive-reliability.md`

## 0.1.52

- 模型：带路由前缀的 id（如 `codex/gpt-6-luna`）也走 Responses API，function tools 不再被网关丢掉；有工具时追加「先动手再回话」的行动指引（versionCode 250）
- CB-086：前端工具接力期间补话排队，完整回合空闲后才补送；停止信号经审批入口传到命令进程组。回归检查实际只执行一次、停止后无延迟副作用、恢复及刷新；补齐清锁与失败结果写入竞态保护
- 计算机接管：keepalive pong 不再报 unknown type（接管屏不再被误判掉线）；`Dockerfile.zh` 安装本仓库的 agent-computer
- Claude Code 工作台与侧栏收尾；删掉侧栏翻页里永远不跑的滚动加载分支
- 文档：`docs/audit-2026-10-21.md` 记录 48 条路由 / 6 条流程的实机审查与测试基线

## 0.1.51

- 发消息翻页收紧：30 分钟内接着聊、或上一轮还在回答时补话都不翻页；真隔久了翻页也落在视口上 1/3（对齐前先垫够留白），回答流式期间位置不动。客户端只对齐版本号（versionCode 249）

## 0.1.50

- Claude Code 工作台重做：左栏单块玻璃，工作区 `+ / ⋯`，会话悬停置顶 / 归档，右键重命名 / 置顶 / 删除；输入框大白卡、`+` / 按需批准 / 模型 / 努力 / 发送停止。连接 / 授权页英文收尾；当前用户读取失败时首页不再空白。客户端只对齐版本号（versionCode 248）

## 0.1.49

- 拖右栏：§106 松手不再把对话推走；拖动期只写 DOM（script −52%）；侧栏一致性（新建进搜索行、弹出/常驻同款）。分段选择键盘约定；模型失效说清楚并拦发送；干活卡收尾；长命令不再被 12s 看门狗掐。客户端只对齐版本号（versionCode 247）

## 0.1.48

- 性能 6 处（#263）：API gzip（排除 SSE）、健康检查并行（最坏 21s→8s）、React Query 全局 staleTime 30s、模型列表不再窗口聚焦重拉、client 默认 30s 超时、慢请求日志。无 pc/android 代码改动，客户端只对齐版本号（versionCode 246）

## 0.1.47

- 易用性第一批：回答开始前按停止不再继续执行（停止标记 / 草稿回填待补）、turn 计数不再变负；共享技能保存失败保留草稿；首启只填名称即可进入；审批单边失败不再装成空；退出失败给中文提示；机器人 / 引导兜底文案中文；修 #252 的 `TRUSTED_ORIGINS` 插值红线回归。客户端只对齐版本号（versionCode 245）

## 0.1.46

- PC 在线更新：安装版一直 `supported=false`（实际卸载器叫 `Uninstall ChisaBotPC.exe`，代码只找带空格的 `Uninstall ChisaBot PC.exe`），检查更新直接返回。两种名字都接受；0.1.11–0.1.45 需手动装一次 0.1.46，之后才能自更新。客户端三处对齐 0.1.46（versionCode 244）

## 0.1.45

- Claude Code 左栏：新建工作区固定到模式切换下方；目录行保留折叠 / 来源 / ⋯，会话只留标题；＋新会话、同步、删除等原功能保留；顶栏、会话页头、模型菜单不变。客户端只对齐版本号（versionCode 243）（电车仍暂停）

## 0.1.44

- 机器人装好的工具真的在 PATH 上：`npm i -g` 装成功却 `command not found`，机器人把装好了读成装失败；命令的 PATH
  现在追加工作区的 `.npm-global/bin`、`.bun/bin`、`.local/bin`（追加不前置）（#258）（电车仍暂停）

## 0.1.43

- 客户端发版补齐：PC / Android 版本号对齐 0.1.43（versionCode 241）。外壳自 0.1.34 起无改动、指纹不变，原地更新；
  0.1.35–0.1.42 全是服务器 / 网页改动，客户端发版此前一直因「标签与版本不一致」失败（电车仍暂停；APK 未签名）

## 0.1.42

- 接管后点不动/滚不动：输入只看 driving，重连不再被失败的归属查询关掉；滚轮 deltaMode 折算；拒因中文（#257）
- 计算机卡片大屏直播后慢探恢复，不再永久停轮询（#256）
- Magpie 镜像可一键升级 + 回退不靠 compose 插值（#254/#255）；npm i -g 与 ops 预算落盘（#253）（电车仍暂停）

## 0.1.41

- 截图 503 根因：LiveScreen 直播时 HTTP 截图让路（captureBusy）；并发串行；超时 422（电车仍暂停）

## 0.1.40

- 狗粮摩擦：截图 503 诚实轮询 / 暂停定时陈旧确认 / 孤儿定时硬删 / 安装胶囊顶距（电车仍暂停）

## 0.1.39

- Magpie/边车 → app:3001 DOCKER-USER 隔离（PRD-P0-02；电车仍暂停）

## 0.1.38

- 发送失败附件恢复诚实（failed-send-attachments）+ CB-029 弹窗静止态去大面积毛玻璃（电车仍暂停）

## 0.1.37

- 长对话首屏尾屏优先挂载（CB-025 / PRD-P2-03）+ 作曲器测试中文断言对齐（电车仍暂停）

## 0.1.36

- P2 诚实 UI / 中文一致 / 日志脱敏余量：活动失败可见、CC 空草稿、孤儿定时自动取消、作曲器拒因中文、CI log-scrub 红线（电车仍暂停）

## 0.1.34

- nginx sync-nginx apply-or-fail + 非电车定时 fail→pause 复验（电车仍暂停）

# ChisaBot 版本记录（按版本 / PR）

ChisaBot 自己的版本史，从 0.1.0（首个公开版本）起，按**发版标签**分组，每组列出进入该版本的 PR。时间均为北京时间（UTC+8）。

- 一个 PR 归到「第一个包含它的发版标签」（`git merge-base --is-ancestor`）。服务器 / 网页改动合并后就随一键更新上线，
  不必等发版；发版标签主要对 **PC / Android 客户端**有意义（它们加载服务器网页，所以网页改动不需要客户端发版）。
- 面向部署者的逐条说明（升级要注意什么）在仓库根 [CHANGELOG.md](../CHANGELOG.md)；每个版本的用户发版说明在
  `.github/release-notes/v<版本>.md`；GitHub Release 页 `https://github.com/ChisaAlter/ChisaBot/releases/tag/v<版本>`。
- 版本规则见 [release.md](release.md) 和 [ADR-0007](adr/0007-version-reset-0-1-0.md)。

## 当前状态（2026-10-19）

| 项                                                      | 值                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| [#231](https://github.com/ChisaAlter/ChisaBot/pull/231) | 10-19                                                                | 信任边界网络隔离；Local-Caller 绑定；deny-by-default 端口；CI red-line | `83a17422` |
| 服务器 / 网页（main）                                   | 本发版提交，`/api/version` = **0.1.32**                              |
| 最新客户端发版                                          | **v0.1.32**（2026-10-19）                                            |
| PC 外壳指纹 `chisabotShell`                             | `059438f4e6c98c74`（0.1.12 起；0.1.11 及更早更新时提示「重新安装」） |
| Android versionCode                                     | 236（只增不减）                                                      |

---

## 未发版（main 上，已随服务器上线）

- Claude Code 左栏：新建工作区固定在模式切换下方；目录行保留折叠 / 来源 / ⋯，会话只留标题；＋新会话、同步、删除等原功能保留；顶栏、会话页头、模型菜单不变。
- PC 在线更新：识别的卸载器名补上 electron-builder 实际写出的 `Uninstall ChisaBotPC.exe`（去掉 productName 里的空格）；0.1.11–0.1.45 安装版此前 `supported=false`，检查更新直接返回。

## v0.1.32（2026-10-19）

运维残余：错误预算分钟环时序（health `budgets.rates/series` + `/api/admin/health/budgets` + workspace 文件）与切流回滚窗口（`cutback.sh` 默认 dry-run，KEEP_IMAGES=5，RTO ~2–5 min）。无表结构变更；PC / Android 外壳未变。

## v0.1.31（2026-10-19）

- Track D：好友一键 compose + 安全默认（PRD-P2-04）。详见根 CHANGELOG。

## v0.1.29（2026-10-19）

- Track B 稳定性：挂死回合清锁 / 长线程快照封顶 / 定时失败态诚实 UI。详见根 CHANGELOG。

## v0.1.28（2026-10-19）

- PRD-P1-02…06：错误预算计数 / SSRF CI 红线 / 信任边界图 / 备份演练记录。详见根 CHANGELOG。


## v0.1.27 — 2026-10-19

PC 0.1.27 · Android vc 233。热修 [#219](https://github.com/ChisaAlter/ChisaBot/pull/219)：computer 探活 + 烟雾顶层 ok。

| PR                                                      | 日    | 说明                         | 合入       |
| ------------------------------------------------------- | ----- | ---------------------------- | ---------- |
| [#219](https://github.com/ChisaAlter/ChisaBot/pull/219) | 10-19 | computer probe / smoke parse | `76cf6b6d` |

---

## v0.1.26 — 2026-10-19

PC 0.1.26（外壳未变，原地更新）· Android 0.1.26（vc 232）。主线：运维可观测 [#218](https://github.com/ChisaAlter/ChisaBot/pull/218)（聚合健康 + 部署后烟雾）。

| PR                                                      | 日    | 说明                                                                    | 合入       |
| ------------------------------------------------------- | ----- | ----------------------------------------------------------------------- | ---------- |
| [#218](https://github.com/ChisaAlter/ChisaBot/pull/218) | 10-19 | `/api/admin/health`；post-deploy-smoke；production-checklist；ops-codes | `b463e7ff` |

---

## v0.1.25 — 2026-10-19

PC 0.1.25（外壳未变，原地更新）· Android 0.1.25（vc 231）。主线：生产加固 [#217](https://github.com/ChisaAlter/ChisaBot/pull/217)（流 keepalive + 审查残留）。

| PR                                                      | 日    | 说明                                                            | 合入       |
| ------------------------------------------------------- | ----- | --------------------------------------------------------------- | ---------- |
| [#217](https://github.com/ChisaAlter/ChisaBot/pull/217) | 10-19 | 直播屏 ping/pong；OAuth/media SSRF 残留；日志脱敏；version 烟雾 | `6d2fd497` |

---

## v0.1.24 — 2026-10-18

PC 0.1.24（外壳未变，原地更新）· Android 0.1.24（vc 230）。主线：代码审查后续 [#216](https://github.com/ChisaAlter/ChisaBot/pull/216)（egress 私网地板 + P2）。

| PR                                                      | 日    | 说明                                                                         | 合入       |
| ------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- | ---------- |
| [#216](https://github.com/ChisaAlter/ChisaBot/pull/216) | 10-18 | egress ALWAYS_DENIED RFC1918/loopback；P2 诚实 UI / 硬化；vault guardedFetch | `00acb60f` |

---

## v0.1.23 — 2026-10-18

PC 0.1.23（外壳未变，原地更新）· Android 0.1.23（vc 229）。主线：代码审查安全批 [#215](https://github.com/ChisaAlter/ChisaBot/pull/215)（SSRF / 本机信任边界 / 发送看门狗）。

| PR                                                      | 日    | 说明                                                       | 合入       |
| ------------------------------------------------------- | ----- | ---------------------------------------------------------- | ---------- |
| [#215](https://github.com/ChisaAlter/ChisaBot/pull/215) | 10-18 | guardedFetch SSRF；X-ChisaBot-Local-Caller；reply watchdog | `fc8ca300` |

---

## v0.1.22 — 2026-10-18

PC 0.1.22（外壳未变，原地更新）· Android 0.1.22（vc 228）。主线：狗粮 DOG-05 [#214](https://github.com/ChisaAlter/ChisaBot/pull/214)（计算机陈旧截图 / 503 诚实 UI）。

| PR                                                      | 日    | 说明                                   | 合入       |
| ------------------------------------------------------- | ----- | -------------------------------------- | ---------- |
| [#214](https://github.com/ChisaAlter/ChisaBot/pull/214) | 10-18 | 清陈旧帧 + 诚实「在用」文案 + 中文 503 | `25deaec8` |

---

## v0.1.21 — 2026-10-18

PC 0.1.21（外壳未变，原地更新）· Android 0.1.21（vc 227）。主线：狗粮 DOG-04 [#213](https://github.com/ChisaAlter/ChisaBot/pull/213)（Ctrl+K 正文命中深链到消息并高亮）。

| PR                                                      | 日    | 说明                            | 合入       |
| ------------------------------------------------------- | ----- | ------------------------------- | ---------- |
| [#213](https://github.com/ChisaAlter/ChisaBot/pull/213) | 10-18 | 搜索命中 `?message=` + 滚入高亮 | `5d9f6294` |

---

## v0.1.20 — 2026-10-18

PC 0.1.20（外壳未变，原地更新）· Android 0.1.20（vc 226）。主线：狗粮 DOG-02/03 [#211](https://github.com/ChisaAlter/ChisaBot/pull/211)（活动记录中文 + 安装横幅避让）。

| PR                                                      | 日    | 说明                                      | 合入       |
| ------------------------------------------------------- | ----- | ----------------------------------------- | ---------- |
| [#211](https://github.com/ChisaAlter/ChisaBot/pull/211) | 10-18 | 活动记录工具名/拒因中文；安装横幅不挡标题 | `1fe795cd` |

---

## v0.1.19 — 2026-10-18

PC 0.1.19（外壳未变，原地更新）· Android 0.1.19（vc 225）。主线：狗粮 DOG-01 深挖 [#212](https://github.com/ChisaAlter/ChisaBot/pull/212)（v0.1.18 实机仍假成功 → connect 快照 + send watchdog）。

| PR                                                      | 日    | 说明                                                      | 合入       |
| ------------------------------------------------------- | ----- | --------------------------------------------------------- | ---------- |
| [#212](https://github.com/ChisaAlter/ChisaBot/pull/212) | 10-18 | DOG-01：connect 消息快照 + 12s send watchdog + 发送中可停 | `f2de07e1` |
| —                                                       | 10-18 | **release v0.1.19**（三处版本 + Android vc 225）          | —          |

---

## v0.1.18 — 2026-10-18

PC 0.1.18（外壳未变，原地更新）· Android 0.1.18（vc 224）。主线：狗粮 DOG-01 [#210](https://github.com/ChisaAlter/ChisaBot/pull/210)（隧道挂掉发消息假成功 → 短时明确报错并恢复草稿）。

| PR                                                      | 日期  | 说明                                             | 合入              |
| ------------------------------------------------------- | ----- | ------------------------------------------------ | ----------------- |
| [#210](https://github.com/ChisaAlter/ChisaBot/pull/210) | 10-18 | 发消息 unreachable 快失败 + ERR_TUNNEL           | squash `cdcc7346` |
| —                                                       | 10-18 | **release v0.1.18**（三处版本 + Android vc 224） | —                 |

## v0.1.17 — 2026-10-18

PC 0.1.17（外壳未变，原地更新）· Android 0.1.17（vc 223）。主线：UX P1–P3 [#209](https://github.com/ChisaAlter/ChisaBot/pull/209)（FIX-05..16：交还可点、控制权重置、失败浏览诚实、设备/时间/活动记录、安装横幅、CC 删会话、定时孤儿清理）。P0 [#208](https://github.com/ChisaAlter/ChisaBot/pull/208) 已在 v0.1.16。

| PR   | 合并            | 内容                                                                                                                                                                                                        | DESIGN / 条目            |
| ---- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| #209 | 10-18`2be44adf` | UX P1–P3：交还可点 / 重启后控制权重置；失败浏览不计成功；设备 vs 云端列文件文案；定时绝对日期 + 侧栏相对时间刷新；活动记录中文；安装横幅可关；干活卡失败步；CC 会话归档删除；已删机器人下已结束定时一键清理 | CB-UX-05…06 · FIX-05..16 |
| —    | 10-18           | **release v0.1.17**（三处版本 + Android vc 223）                                                                                                                                                            | —                        |

---

## v0.1.16 — 2026-10-18

PC 0.1.16（外壳未变，原地更新）· Android 0.1.16（vc 222）。主线：UX P0 [#208](https://github.com/ChisaAlter/ChisaBot/pull/208)（定时状态诚实、无人值守快失败、会话正文搜索、停止真取消）；并收纳 v0.1.15 之后已随服务器上线的网页 / 服务器 PR。

| PR   | 合并                  | 内容                                                                                                                                                                                                                                                                      | DESIGN / 条目   |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| #188 | 10-16 20:37 `a34d8a0` | 简单回合不出干活卡、开场一句收进卡片、不画空气泡、答完下面不留空                                                                                                                                                                                                          | §93 · CB-079    |
| #190 | 10-16 21:26 `7e6c7a9` | 云端浏览器多标签（最多 8 个，人和机器人同一组，重启恢复）+ 收藏夹（每账号一份，地址栏星标、收藏栏、管理）                                                                                                                                                                 | §95 · CB-081    |
| #191 | 10-16 22:49 `b6d2dbd` | 暗色下黑色网站图标垫浅色底板；右栏「计算机」去掉标签条；放大的浏览器一体工具条、画面按剩余高度适配                                                                                                                                                                        | §96 · CB-082    |
| #189 | 10-16 23:56 `9bfb1c1` | 上一句发出不到 5 分钟时新消息不再整页上跳（≥5 分钟照旧对齐到顶）                                                                                                                                                                                                          | §94 · CB-080    |
| #192 | 10-17 00:47 `0e23321` | 设置左栏重新分组（通用 · 机器人 · 电脑与设备 · 账号与连接 · 模型 · 系统）+ 设置搜索（Ctrl/⌘K 或 /）；输入框权限「请求批准 / 完全访问」按机器人、服务器执行、有审计                                                                                                        | §97 · CB-083    |
| #195 | 10-17 15:48 `1de1daf` | Claude Code 页 / 设置 → 云端工作区打开或窗口回到前台时，缓存「未登录」或超过 60 秒就后台复查云端 Claude 登录（节流，检查中显示「正在确认」不先闪「登录 Claude」）；服务器在节点在线时每 5 分钟复查一次                                                                    | §73.1 · §73.5   |
| #196 | 10-17 17:33 `f749de4` | 云端浏览器卡死保护：操作租约到期自动放行并丢弃卡住的浏览器，启动 / 关闭 / 起始页都有上限（不再需要重启容器）；删除机器人时一起删它的浏览器；「云端浏览器」列表标出「已删除的机器人」并可删除                                                                              | §99             |
| #197 | 10-17 19:24 `dfcfac8` | 从设置 / 待处理 / 设备切回机器人页不再「刷新一次」：外壳只有一个，聊天离开时留着不卸载（不重新接入、不重读历史、发送键不闪「停止」、滚动原样、正在写的回答不断）                                                                                                          | §98 · CB-084    |
| #198 | 10-17 20:16 `fb01084` | 第一次从聊天去设置时，藏着的聊天不再被挪几十像素（回聊天滚动位置一像素不差）：离开那一刻钉住滚动位置 1.5 秒；设置左栏 / 设置搜索只滚自己的容器                                                                                                                            | §98.5 · CB-084  |
| #199 | 10-18 00:04 `a0b8ecc` | 机器人能选网页上的原生下拉框（快照列出选项，用「填写」选中，点开不再卡住）；计算机操作失败交回给机器人接着做，一轮做到一半停下 / 出错 / 空回复都会出「这一轮没有做完」+「重试」，不再静默结束                                                                             | §100            |
| #201 | 10-18 03:4x `7152106` | 真实任务验收修复：计算机工具打到这次调用所属对话的机器人（不再打进别的机器人的浏览器）；备用模型坏了不再挡路、一时限流只冷却 1 分钟；定时任务里要确认的步骤放卡片等你确认（不再永远做不成）；步数快用完时提醒收尾；中文加粗、工作区文件链接正常显示；云端浏览器能用 WebGL | §101            |
| #202 | 10-18 05:20 `bc014b7` | 后台回合（定时任务）放的确认卡片在聊天里也能看到、点确认后机器人接着做完；机器人的电脑里有 Python（含 pip / venv）；读网页只读看得见的字；主模型 30 秒没输出就换备用模型                                                                                                  | §101.7–§101.10  |
| #203 | 10-18 06:01 `5882897` | 回复里指向下载卡片的站内链接不再被改坏（404）；页面忙、截图 / 快照超时不再被说成「元素不在了」，机器人不再原地反复快照                                                                                                                                                    | §101.11–§101.12 |
| #204 | 10-18 06:23 `a2bb4ed` | 回复里直接贴出的「https://workspace.local/文件」（没写成 Markdown 链接）也换成下载地址，PC 客户端里点了能下载                                                                                                                                                             | §101.13         |
| #205 | 10-18 06:3x `905b872` | 回复里用 HTML 写的工作区文件链接（`<a href="primes.py" download>`）也换成下载地址，不再显示「[blocked]」                                                                                                                                                                  | §101.14         |
| #206 | 10-18 09:07 `e003981` | 机器人自己电脑上的前台命令可以跑到 10 分钟：`computer_run_command` 收 `timeoutSec` / `timeoutMs`（默认 120 秒、最多 600 秒），超时后说清楚别原样重跑；长命令的请求不再被 Cloudflare 100 秒 / Bun 空闲超时中途切断                                                         | §102            |
| #207 | 10-18`8e97ef0`        | #206 合并记录与上线复测（文档）                                                                                                                                                                                                                                           | §102            |
| #208 | 10-18`347a045`        | UX P0：定时 run 状态诚实（等待/跳过/失败不再绿「已完成」）；无人值守（定时/IM）碰到登录/密钥/接管时快失败并清锁；Ctrl+K 会话正文搜索+高亮；停止取消进行中联网工具                                                                                                         | CB-UX-01…04     |
| —    | 10-18                 | **release v0.1.16**（三处版本 + Android vc 222）                                                                                                                                                                                                                          | —               |

## v0.1.15 — 2026-10-16

PC 0.1.15（外壳未变，原地更新）· Android 0.1.15（vc 221）。

| PR   | 合并                   | 内容                                                                                                                | DESIGN / 条目  |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------- |
| #180 | 10-16 15:33 `125cd05`  | 存图时记下宽高（新表 `chisabot_image_dims`），长对话图片加载不再推开消息                                            | §83.2          |
| #182 | 10-16 15:56 `1a5b58a`  | 设备状态标签文字居中（文泉驿正黑）                                                                                  | §82.6 · CB-070 |
| #181 | 10-16 15:58 `57663f0`  | 电脑文件夹导入失败自动撤销、删掉的工作区不再挡住重新导入；云端节点同步边车看门狗；PC 端同步自恢复（随 0.1.15 发布） | §87 · CB-074   |
| #183 | 10-16 17:05 `e0ae06a`  | 每个机器人记住操作状态（面板 / 计算机、草稿、滚动位置）；消息不再往回跳                                             | §88 · CB-075   |
| #184 | 10-16 17:29 `579b653`  | 「模型老断」：断线先问服务器再报错、能接上就接上；重启打断的一轮补完说明；更新器先等对话答完（drain）               | §89 · CB-076   |
| #185 | 10-16 17:43 `e278d66`  | 中途说明文字收进干活卡；断线重接不再写两遍（Android 同步）                                                          | §90 · CB-077   |
| #186 | 10-16 19:49 `e93a4cf`  | PC 登录窗无边框圆角、确认 / 更新弹窗只有一道边、审批框按内容定高；**release v0.1.15**                               | §91            |
| #187 | 10-16 19:57 `a888f310` | 窄窗口 / 手机输入框左右至少 16px 留白                                                                               | §92 · CB-078   |

## v0.1.14 — 2026-10-16

PC 0.1.14（原地更新）· Android 0.1.14（vc 220，原生第二轮）。

| PR   | 合并                  | 内容                                                                                       | DESIGN / 条目         |
| ---- | --------------------- | ------------------------------------------------------------------------------------------ | --------------------- |
| #172 | 10-16 11:50 `5f88a49` | 全站对齐审计：按钮里的字居中、干活卡上下留白                                               | §82 · CB-070          |
| #173 | 10-16 12:24 `e2ffffe` | 打开对话落在最新一条、不跳；切机器人秒开；接入回放瘦身（3.4 MB → 0.23 MB）                 | §83 · CB-071          |
| #175 | 10-16 14:33 `a435ce6` | 机器人 ↔ Claude Code 原地切换，不再整屏刷新                                                | §84 · CB-072          |
| #174 | 10-16 14:56 `b38f0d8` | Claude 上游代理支持 trojan / vless / vmess / ss / hysteria2 / tuic 链接（sing-box 转换）   | §85 · CB-073          |
| #176 | 10-16 15:09 `45baa2d` | Android 原生第二轮：确认卡片、附件、停止、重新生成 / 编辑、原生设置基础                    | §86                   |
| #177 | 10-16 15:14 `e93f3aa` | 「测试连接」真的经过 Claude 上游代理                                                       | §85 · CB-073          |
| #178 | 10-16 15:23 `1e0380c` | 对齐第二轮：下拉 / 菜单项 / 设备标签 / 审批小分段 / 复制；过程话收起不跳；面板把手不压消息 | §82.6–§82.10 · CB-070 |
| #179 | 10-16 15:21 `a515bc3` | 修 CI 上 sing-box 检查用例（release pc-test）                                              | —                     |

## v0.1.13 — 2026-10-16

**Android 换成原生应用**（Kotlin + Jetpack Compose，vc 219，约 2.3 MB）· PC 0.1.13（原地更新）。

| PR   | 合并                  | 内容                                                                                                                    | DESIGN / 条目 |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------- |
| #170 | 10-16 10:45 `e8e0025` | 新建 / 修改机器人同一张表（头像 · 名称 · 职责 · 它做什么）+ 圆形头像（上传 / 表情 / 首字，新表 `chisabot_bot_avatars`） | §81 · CB-069  |
| #168 | 10-16 10:57 `ab80dbf` | Android 原生版：登录、机器人列表、聊天、面板原生，其余应用内网页；**release v0.1.13**                                   | §80 · CB-068  |
| #171 | 10-16 11:14 `2fcb755` | PC 登录页测试不再比对 Android 网页登录页（修 release pc-test）                                                          | —             |

## v0.1.12 — 2026-10-16

PC 0.1.12（**外壳指纹变为 `059438f4e6c98c74`，旧客户端提示「重新安装」**）· Android 0.1.12（vc 218，最后一个 WebView 外壳）。

| PR   | 合并                  | 内容                                                                                                                            | DESIGN / 条目 |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| #163 | 10-16 02:37 `62b89f2` | 新版本前功能精简：工作流、插件与 MCP、权限规则、UI 组件目录默认隐藏（`CHISABOT_EXTRAS`）；新建机器人只要名称 + 可选「它做什么」 | §74 · CB-067  |
| #164 | 10-16 03:14 `b54f64d` | Hark 第六轮：干活卡在原位、文档卡、提示词第三版                                                                                 | §75 / §76     |
| #165 | 10-16 04:11 `5cab078` | 面板像 Hark：搭建步骤、来源一行、最多两个磁贴 + 两块                                                                            | §77           |
| #166 | 10-16 04:22 `b28eb65` | 等待的那几秒：上下文小饼图、一句话后的小点、换字不叠字、手机回到底部                                                            | §78           |
| #167 | 10-16 09:21 `7f118e6` | 空聊天也有「计算机」                                                                                                            | §79           |
| #169 | 10-16 09:58 `fa0731e` | 允许的文件夹之外：批准即加入；Windows 图标指向按哈希命名的 .ico；**release v0.1.12**                                            | —             |

## v0.1.11 — 2026-10-16

PC 0.1.11：**电脑上的文件夹 ↔ 云端 Claude Code 双向同步** · Android vc 217。

| PR   | 合并                  | 内容                                                                                  | DESIGN / 条目 |
| ---- | --------------------- | ------------------------------------------------------------------------------------- | ------------- |
| #159 | 10-16 00:12 `14609a5` | 电脑文件夹同步 P4a：同步边车、隧道、绑定、租约                                        | §73 · CB-064  |
| #160 | 10-16 01:28 `20a8481` | 电脑文件夹同步 P4b：PC「电脑上的文件夹」、同步面板、冲突对话框、交接、Git over tunnel | §73 · CB-064  |
| #161 | 10-16 01:52 `969fc56` | **release v0.1.11**                                                                   | —             |

## v0.1.10 — 2026-10-15

PC 0.1.10（设备「打开」只做安全的打开）· Android vc 216。这一版包含云端 Claude Code P0–P3、只有一套聊天、瘦身 P6 和多个体验轮。

| PR   | 合并                  | 内容                                                                                           | DESIGN / 条目           |
| ---- | --------------------- | ---------------------------------------------------------------------------------------------- | ----------------------- |
| #128 | 10-15 06:34 `b903e2c` | 朋友账号：邀请链接、网关签名身份、按人隔离                                                     | §65 · ADR-0011 · CB-040 |
| #129 | 10-15 07:17 `0699b25` | 重新生成 / 编辑后重发，服务器截断、所有设备一致                                                | §67 · CB-042            |
| #130 | 10-15 09:33 `5c86017` | 去掉朋友账号（随后被 #133 撤回）                                                               | —                       |
| #131 | 10-15 09:45 `93e6c50` | 瘦身 P6-1：上游企业控制闸门、`/api/admin/enterprise`、`/api/admin/people`、OTel 导出           | slimming                |
| #132 | 10-15 10:02 `db6991b` | 瘦身 P6-2：SSO / SCIM 插件与身份提供者分支                                                     | slimming                |
| #133 | 10-15 10:22 `6e6bc11` | 朋友账号入口默认隐藏（`CHISABOT_ACCOUNTS_UI`）、网关邀请默认关；撤回 #130                      | §65                     |
| #134 | 10-15 10:39 `0dfbc39` | 瘦身 P6-3：删 `worker/`、Intelligence 开通脚本，去掉 SSO / SCIM / Expo / OTel 依赖（完整构建） | slimming                |
| #135 | 10-15 11:25 `cc475e3` | 瘦身 P6-4：上游桌面端残留（electron 插件、组织登录、host-access）                              | slimming                |
| #136 | 10-15 12:10 `7898961` | 只有一套聊天：`/bot` 只做跳转，功能搬进频道聊天                                                | §68 · ADR-0013 · CB-046 |
| #137 | 10-15 12:59 `b01803d` | 删掉实时语音通话                                                                               | §68.7                   |
| #138 | 10-15 13:27 `ebca4c7` | 对话像发短信：短气泡、草稿卡、回复引用、代码卡；提示词第二版                                   | §69 · CB-048            |
| #139 | 10-15 13:36 `23c58bf` | 干活卡：当前步骤 · 第几步 · 用时                                                               | §70 · CB-049            |
| #140 | 10-15 14:09 `085384a` | 看板整理（文档）                                                                               | —                       |
| #141 | 10-15 15:15 `8ee816d` | 干活卡结束后收成一行、提示词去免责段                                                           | §70.2 · CB-049          |
| #143 | 10-15 15:27 `35bbfa9` | 瘦身 P4c-1：上游 Routines 并入定时任务                                                         | §55 · CB-015            |
| #142 | 10-15 15:29 `20a2487` | 成熟度 3：「待处理」只放等你点头的事、找不到的错误卡、文案                                     | §71 · CB-051…055        |
| #144 | 10-15 16:19 `ede44be` | 管理页说中文、活动记录窄屏卡片                                                                 | §71.6 · CB-056/057      |
| #145 | 10-15 16:24 `f39a438` | 设置左栏在笔记本上不用滚                                                                       | §71.7 · CB-058          |
| #147 | 10-15 16:29 `010f84e` | 成熟度第 3 轮完成（文档）                                                                      | —                       |
| #146 | 10-15 17:01 `613880e` | 商品 / 地点推荐带图卡片网格；长对话历史晚到停在底部                                            | §72 · CB-050 / CB-047   |
| #148 | 10-15 17:52 `5ccdff7` | 云端 Claude Code 设计、ADR-0014（P0）                                                          | ADR-0014                |
| #149 | 10-15 18:17 `c00c1ec` | 云端工作区节点 + Claude 登录（P1）                                                             | §73 · CB-061            |
| #150 | 10-15 19:51 `e34f381` | Claude Code 标签页：左栏切换、会话、对话、审批、右栏 / 手机抽屉（P2）                          | §73 · CB-062            |
| #152 | 10-15 21:16 `3f23935` | 切暗色不再让毛玻璃逐帧重模糊                                                                   | §7.4 · CB-024           |
| #153 | 10-15 21:35 `6c5c662` | 在云端完成 Claude 登录（远程浏览器）+ Claude 上游代理                                          | §73 · CB-066            |
| #154 | 10-15 22:01 `b8d8b15` | 同一轮同一页面一张页面卡；后台任务卡参数流时的标题                                             | CB-021 / CB-023         |
| #155 | 10-15 22:16 `0d0a23b` | 只读工具在干活卡里有中文说法、结果不单独出卡                                                   | §70.3 · CB-022          |
| #156 | 10-15 22:19 `4438faf` | 设备「打开」只做安全的打开（网址或允许文件夹里的文件）                                         | CB-030                  |
| #151 | 10-15 22:35 `9bc5a20` | 云端 Claude Code GitHub 工作区：克隆、`cc/` 分支、合入、推送并开 PR（P3）                      | §73 · CB-063            |
| #158 | 10-15 23:01 `6d2da6f` | 云端登录浏览器过得了 Cloudflare 人机验证                                                       | CB-066                  |
| #157 | 10-15 23:14 `2db2190` | **release v0.1.10**                                                                            | —                       |

## v0.1.9 — 2026-10-15

本地 agent 与权限档位 · Android vc 215。

| PR   | 合并                  | 内容                                                                                       | DESIGN / 条目               |
| ---- | --------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| #122 | 10-15 04:18 `b271b33` | 成熟度 2：只填名字建机器人、空聊天「试试这样问」、手机收起抽屉                             | §63 · CB-003                |
| #121 | 10-15 04:30 `6a40c80` | 瘦身 P4b-2：推送与可达性、群聊与团队机器人接口；交接默认关                                 | slimming                    |
| #123 | 10-15 05:08 `cede86a` | 瘦身 P4b-3：自动学习、身份提供者管理接口、Docker supervisor 配置                           | slimming                    |
| #124 | 10-15 05:12 `5da8d15` | 频道聊天刷新 / 切后台 / 换设备接着看正在写的回答                                           | §64 · CB-041 / CB-043       |
| #125 | 10-15 05:30 `5a3ef42` | 手机上页面卡片恢复「打开」；登录页不预填                                                   | §54 · CB-044                |
| #126 | 10-15 05:57 `8eafd30` | 本地 agent（Claude Code / Codex / OpenCode / 内置循环）与权限档位 只读 / 工作区 / 完全访问 | §66 · ADR-0010 · CB-007/008 |
| #127 | 10-15 06:09 `3675e67` | **release v0.1.9**                                                                         | —                           |

## v0.1.8 — 2026-10-15

设备编码工具 · 完全访问 · 服务器节点 · Hark 对齐的一大批功能 · 瘦身 P1–P4b-1 · Android vc 214。

| PR   | 合并                  | 内容                                                                      | DESIGN / 条目                   |
| ---- | --------------------- | ------------------------------------------------------------------------- | ------------------------------- |
| #97  | 10-14 17:03 `e040565` | 机器人资料页重做：简洁高效                                                | §47                             |
| #98  | 10-14 18:09 `c96b7a2` | 链接卡改版（单独一行的链接出紧凑卡）                                      | §48                             |
| #99  | 10-14 18:27 `dc0d8f9` | IM 接入：QQ / 微信 / 飞书 / 企业微信 / 钉钉 / Telegram                    | §49                             |
| #100 | 10-14 18:39 `42b2647` | 网关放行 OneBot 反向 WebSocket                                            | §49                             |
| #101 | 10-14 20:33 `8f9e6ec` | 长期记忆（所有机器人共用）                                                | §50                             |
| #102 | 10-14 21:01 `452804e` | 技能                                                                      | §51                             |
| #103 | 10-14 21:35 `5a332cf` | 密钥保险箱：安全输入卡片 + `api_request` 域名绑定                         | §52 · ADR-0004                  |
| #104 | 10-14 22:39 `7f43385` | GitHub 账号连接：读仓库 / Issue / PR / 文件，写操作先确认                 | §53                             |
| #105 | 10-14 22:56 `d5d3dcc` | 页面：机器人做可分享的单页网页                                            | §54 · ADR-0005                  |
| #106 | 10-14 23:10 `a036771` | 页面换标题时正文同名 `<h1>` 跟着换                                        | §54                             |
| #107 | 10-14 23:16 `083d135` | 定时任务与提醒                                                            | §55 · ADR-0006                  |
| #108 | 10-14 23:44 `776530d` | 聊天文件与图片生成                                                        | §56                             |
| #109 | 10-15 00:10 `085f446` | 导航收敛（瘦身 P1）                                                       | §57                             |
| #110 | 10-15 00:28 `53502ba` | 示例包精简 + 孤儿数据清理（瘦身 P2）                                      | slimming                        |
| #111 | 10-15 01:07 `4fc6f10` | 项目维护与文档系统（ROADMAP、BACKLOG、架构、ADR、部署手册、CONTRIBUTING） | CB-012                          |
| #112 | 10-15 01:09 `a679db3` | 确认卡片 + 审批偏好                                                       | §58 · CB-001                    |
| #114 | 10-15 01:46 `5a7bdca` | 生图 / 识图模型设置，每人可覆盖                                           | §59 · CB-002                    |
| #115 | 10-15 01:55 `87b80c8` | 成熟度 1：额度用完自动换模型、报错说人话、部署等待页                      | §60 · CB-003                    |
| #116 | 10-15 02:26 `5dce8b3` | 瘦身 P4a：删前端死页                                                      | slimming                        |
| #113 | 10-15 02:46 `b82d105` | 瘦身 P3：删不发布的上游目录，CI「ChisaBot checks」修绿                    | slimming · CB-009/020           |
| #118 | 10-15 03:14 `025564d` | 备用模型：管理员排序、对话里说明、自检走回退                              | §61 · CB-035                    |
| #117 | 10-15 03:19 `db42fde` | 瘦身 P4b-1：演示录制、上游个人记忆、主动研究、意图路由不再加载            | slimming                        |
| #119 | 10-15 03:50 `592de47` | 设备编码工具、完全访问、服务器节点 `chisabot-node`                        | §62 · ADR-0009 · CB-004/005/006 |
| #120 | 10-15 04:00 `ecd1444` | **release v0.1.8**                                                        | —                               |

## v0.1.7 — 2026-10-14

设备默认「询问」+ PC 连接提示 · Android vc 213。

| PR              | 合并                  | 内容                                                                                 | DESIGN / 条目         |
| --------------- | --------------------- | ------------------------------------------------------------------------------------ | --------------------- |
| #67             | 10-13 16:58 `75853b2` | 回答期间也能发消息 + 后台任务 + 任务卡片                                             | §38                   |
| #68             | 10-13 17:24 `a7ea134` | 发送时整段聊天跳一截：顶上提示改浮层                                                 | §35.4                 |
| #69             | 10-13 17:54 `d2ed930` | 计算机被接管时不再悄悄停、面板不误报                                                 | §39                   |
| #70             | 10-13 18:06 `91f617c` | 手机竖屏布局 + PWA                                                                   | §40                   |
| #71 / #72       | 10-13 18:09 / 19:25   | 并发实测修复（超并发排队、输入框不透字、停止有下文、删机器人清后台任务）             | §38                   |
| #73 / #74       | 10-13 20:16 / 20:28   | 一次点击不再重算整页样式（去掉 `group-has-*`）                                       | §41                   |
| #75             | 10-13 21:05 `d0fb0e5` | 全端同步 + 历史对话                                                                  | §42                   |
| #76 / #77 / #79 | 10-13 20:52–22:08     | 弹窗用到才加载、首屏包瘦身、打开动画期间不带毛玻璃                                   | §41.3 / §41.4 / §37.2 |
| #78             | 10-13 21:50 `6b87a07` | 发送失败后同步不再删掉刚发的消息                                                     | §42.7                 |
| #80             | 10-13 22:16 `2ac984d` | 面板每天固定时刻刷新、交还即重刷                                                     | §43                   |
| #81 / #82 / #83 | 10-14 00:09–00:47     | 思考内容收起就不在页面里、只在点开时展开；`<think>` 推理不进回答；删机器人连带清面板 | §44                   |
| #93             | 10-14 16:16 `9bb8afa` | 新建机器人一步完成、一律私有、在服务器上                                             | §46                   |
| #94 / #95       | 10-14 16:09 / 16:18   | 设备默认「询问」+ PC 里提示没连上 / 旧版需重装                                       | §45                   |
| #96             | 10-14 16:34 `f36a3c4` | **release v0.1.7**                                                                   | —                     |

> **2026-10-14 15:27 事故**：main 被强推回 `95b7326`，PR #84–#92（Cursor / 流水线 agent 的工作和 v0.1.7 / v0.1.8 / v0.3.0 发版 PR）
> 连同标签被清掉，它们不在任何现存版本里。之后重新做了 0.1.7（#93–#96）。从此规定**绝不强推 main**（见 [decisions.md](decisions.md)）。

## v0.1.6 — 2026-10-13

| PR  | 合并                  | 内容                                                         |
| --- | --------------------- | ------------------------------------------------------------ |
| #65 | 10-13 16:34 `296aa4a` | 关弹窗不卡：退出动画不重算毛玻璃（§37）                      |
| #66 | 10-13 16:27 `cbe3ef3` | PC 设备节点走系统代理、重连更稳；**release 0.1.6**（vc 212） |

## v0.1.5 — 2026-10-13（含服务器专用的 0.1.4）

| PR  | 合并                  | 内容                                                                                                              |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| #58 | 10-13 15:38 `0bbab04` | 机器人浏览器默认有界面运行（Xvfb），避免被 Cloudflare 拦截。**0.1.4** 只提升了服务器版本号，没有客户端发版 / 标签 |
| #61 | 10-13 15:40 `1bed1fc` | 流式回复时不再跳回上面的聊天记录（§35）                                                                           |
| #62 | 10-13 15:55 `1d4c081` | 容器重启后对话不再卡死（孤儿线程锁）                                                                              |
| #63 | 10-13 15:56 `da8a73c` | PC 小窗模式 + 窄窗口整理（§36）；**release 0.1.5**（vc 211）                                                      |
| #64 | 10-13 16:05 `bcbea63` | 部署后打开旧页面不再整页报错（过期分包自动刷新）                                                                  |

## v0.1.3 — 2026-10-13

| PR  | 合并                  | 内容                                             |
| --- | --------------------- | ------------------------------------------------ |
| #57 | 10-13 13:42 `825bcd2` | 全站对齐 / 字号 / 菜单 / 动效审计（§34）         |
| #59 | 10-13 15:19 `e41c061` | PC 外壳指纹：图标 / 安装器变了时提示「重新安装」 |
| #60 | 10-13 15:20 `c5c7b53` | **release 0.1.3**（vc 209）                      |

## v0.1.2 — 2026-10-13

| PR        | 合并                  | 内容                                                                   |
| --------- | --------------------- | ---------------------------------------------------------------------- |
| #50       | 10-13 12:41 `d2d1f90` | 流式回复按帧匀速放字（§30）                                            |
| #51 / #52 | 10-13 12:42           | 聊天富预览（链接卡、图片一摞、看大图）；富组件 17 → 37 个（§31 / §32） |
| #53 / #54 | 10-13 12:42           | 服务器版本号 0.1.1；测试数据补全                                       |
| #55       | 10-13 13:08 `5550f48` | Android 扫码绑定 + **0.1.2**（vc 208）（§33）                          |
| #56       | 10-13 13:21 `85ed43b` | 绑定手机入口（头像菜单、PC 托盘、`?pair=1`）                           |

## v0.1.1 — 2026-10-13

0.1.0 之后第一天（10-12 晚 → 10-13 上午）的全部工作。

| PR               | 内容                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| #4–#13           | 默认隐藏工具调用与思考、render_ui 坏节点只跳过自己、新建面板直接进面板栏、个人资料（头像 / 显示名）、首次登录先设头像和名称 |
| #14–#16、#19–#26 | 右栏「面板 \| 计算机」（§23）、计算机实时画面 / 起始页 / 机器人写的网页可打开、重启后导航修复                               |
| #17、#23         | 隐藏「游乐场」和「谁可以进入」；设置大幅精简、偏好设置与管理后台合并                                                        |
| #18、#21         | 品牌字标（最终 Sora「Chisa」红 +「Bot」墨色）                                                                               |
| #27、#28         | 聊天中间列没有底板（§24）                                                                                                   |
| #29、#30         | 设备列表：设备属于账号，所有机器人可管理（ADR-0002）                                                                        |
| #31–#35          | 一键完整更新（从 GitHub 拉代码、限内存完整构建）                                                                            |
| #34、#36         | 输入框重做 + 上下文读数（§25）                                                                                              |
| #37              | 预设工作流（§26）                                                                                                           |
| #38–#44          | 向 Hark 看齐第一至四轮：内置联网、实时面板、一轮收成一句话 + 结果、停止标记、截图缩略图（§27）                              |
| #45              | 在线更新默认安装                                                                                                            |
| #46              | 品牌头像做标志 + README 重写（§28）                                                                                         |
| #47              | 机器人面板设计规范 + 保存前检查（§29）                                                                                      |
| #48              | 机器人知道电脑在不在线                                                                                                      |
| #49              | **release 0.1.1**（vc 207）                                                                                                 |

## v0.1.0 — 2026-10-12（首个公开版本，`a7937ef`）

用户要求「版本号归正为 0.1.0」（ADR-0007）：此前的内部 0.2.2–0.2.5 构建和 GitHub release v0.2.4 / v0.2.5 被删除，所有端统一为 0.1.0，
Android versionCode 从 206 起只增不减。装着 0.2.x 的 PC 需要卸载后重装一次（不能降级）。

0.1.0 已包含：蓝天磨砂玻璃统一设计系统（一个外壳覆盖聊天 / 设置 / 管理）、左栏只列机器人（ADR-0001）、Magpie 模型平台、PC 设备节点
（出站 WSS、每设备令牌、能力默认关、审批 / 审计 / 急停）、json-render 生成式界面（render_ui 是唯一的生成式界面）、v4 布局（右上只有窗口按钮、
打开即进入机器人聊天）、首次运行自动建「助手」、一键在线更新（网页 + PC，宿主机更新器、自动回滚）、管理员自检（不碰对话）、
PC / Android 客户端自带登录页、仓库公开可部署。
