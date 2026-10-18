# 发布流程

ChisaBot 有两种「发布」：

1. **服务器 / 网页上线**：每个合并的 PR 都走，靠宿主机更新器换镜像。网页、PC 窗口里的网页、Android 的网页页面都随之更新。
2. **客户端发版**（PC + Android）：只在 `pc/` 或 `android/` 有改动、或需要统一版本号时做，打 `v0.1.x` 标签，出 GitHub Release，
   更新各自的更新源。

原则见 [decisions.md](decisions.md) §2：一功能一 PR、合并前 rebase、**绝不强推 main**、「做好一版就发」（验证过就合并 / 部署 / 发版，
不再逐项等确认，[ADR-0008](adr/0008-pr-per-feature-serial-deploy.md)）。版本记录见 [CHANGELOG](CHANGELOG.md)。

## 1. 版本号规则（[ADR-0007](adr/0007-version-reset-0-1-0.md)）

| 规则 | 说明 |
|---|---|
| 从 0.1.0 起 | 2026-10-12 归正；内部 0.2.x 全部作废。装着 0.2.x 的 PC 不会自动降级，要卸载后装 0.1.x 一次（数据保留） |
| **三处同一个版本** | 根 `package.json`（→ 服务器 `/api/version`）、`pc/package.json`、`android/app/build.gradle.kts` 的 `versionName`。CI 检查 PC 和 Android 一致，不一致不出包 |
| **versionCode 只增不减** | Android 按它判断更新（0.1.0 = 206，0.1.15 = 221）；每次发版 +1，即使只是版本号同步 |
| 补丁号递增 | 每次客户端发版 +0.0.1；只有服务器改动时可以只提升根 `package.json`（例：0.1.4 只是服务器版本号，没有客户端发版和标签） |
| 0.2.0 | 留给真机验证后的下一个大版本（CB-019） |

## 2. 服务器 / 网页上线

1. PR 合并（merge commit；合并前 `git rebase origin/main`，自己的分支用 `--force-with-lease`）。
2. 在宿主机上**只用串行部署脚本**：`sh deploy-serial.sh <合并提交前 7 位> <你的名字>`（仓库 [`scripts/ops/deploy-serial.sh`](../scripts/ops/deploy-serial.sh)）。
   它拿全局锁排队、等更新器空闲、**等所有对话的线程锁清零**（不打断正在回答的一轮），确认 main 包含你的提交，再请求更新。
3. 更新器自动选：
   - **快速更新**：依赖指纹没变 → 在底座镜像上只换代码层（约 1–2 分钟）；
   - **完整构建**：依赖 / Dockerfile 变了，或底座镜像不存在 → 仓库根 Dockerfile 限内存构建（约 4–6 分钟），成功后成为新底座。
4. 切换前 `pg_dump` 备份（保留 5 份）；切换后健康检查 + 模型自检；**失败自动回滚**到上一镜像。每次切换都留下
   `rollback-to-<上一镜像>.sh`（只有镜像还在时才有效，更新器保留最近 5 个镜像（见 docs/ops/traffic-cut-rollback.md））。
5. 上线后按 [testing.md](testing.md) §4 做生产检查。纯文档 PR（只改 `docs/`、`*.md`、`.github/` 模板）**不需要部署**。

细节：[ops/deploy.md](ops/deploy.md)、[online-update.md](online-update.md)。网关 / 登录服务 / 云端节点 / Magpie 不随一键更新，要手工部署。

## 3. 客户端发版

### 3.1 准备 PR

在一个 `release: vX.Y.Z` PR 里（也可以和最后一个功能 PR 合在一起）：

- 三处版本号改成 `X.Y.Z`，`versionCode` +1。
- 写 `.github/release-notes/vX.Y.Z.md`（GitHub Release 正文：Windows / Android / 随服务器更新三段，说清是否要重新安装）
  和 `vX.Y.Z.android.txt`（Android 更新提示的短文本）。
- 根 [CHANGELOG.md](../CHANGELOG.md) 和 [docs/CHANGELOG.md](CHANGELOG.md) 加这一版。
- **改了 PC 图标、安装器（`pc/build/installer.nsh`）、electron / electron-builder 版本或打包配置**：运行 `npm run fingerprint`
  更新 `pc/src/shell-fingerprint.json`（不更新 `npm test` 会失败）。见 §3.3。

### 3.2 构建与发布（`.github/workflows/release.yml`）

| 方式 | 结果 |
|---|---|
| 推送 `v*` 标签，或 workflow_dispatch 填 `tag` | 通用版：PC 安装包 + Android APK 发到 GitHub Release；首次运行让用户填服务器地址，从 GitHub Releases 更新 |
| workflow_dispatch 不填 `tag`，填 `server_url` / `update_feed` / `android_update_feed` | **只构建**自建版（预填自己的服务器地址和更新源）作为 artifact，自己发布到自己的静态目录 |
| `signed_apk_url` + `signed_apk_sha256` | 仓库没配 Android 签名 Secrets 时：离线签好的通用版 APK 地址，Release 用它代替未签名 APK（sha256 不一致就失败） |

推荐顺序（仓库没有签名 Secrets 时）：只构建 dispatch → 下载 artifact → 在自己的机器上用同一把签名密钥签两份 APK →
带 `tag` + `signed_apk_url` 的 dispatch 出 Release → 用只构建的自建版 artifact 更新自己的更新源（核对 `latest.yml` 的 sha512）。
签名密钥绝不进仓库；CI 内签名需要仓库所有者配 4 个 `ANDROID_*` Secrets（CB-032）。服务器端的更新源目录、签名与上传步骤见 [ops/client-release.md](ops/client-release.md)。

### 3.3 PC 外壳指纹与「重新安装」

- electron-updater 用 `--updated` 静默跑 NSIS 安装器时会保留旧快捷方式、不刷图标缓存。所以 PC 有一个**外壳指纹**
  （`pc/scripts/shell-fingerprint.js`：图标、`installer.nsh`、electron / builder 版本、去掉 publish 的打包配置的哈希），CI 写进
  `latest.yml` 的 `chisabotShell`。
- 客户端发现新版指纹和自己不同 → 提示 **「此更新需要重新安装，以更新图标/组件」**，点「重新安装」后以完整安装方式运行（数据保留）；
  指纹相同 → 普通原地更新。
- 历史：`a37303ffb08b9d60`（0.1.3–0.1.11）→ `059438f4e6c98c74`（0.1.12 起，换了按哈希命名的 `.ico`）。
- 安装器每次都重写快捷方式、刷新图标缓存；客户端每次启动检查所有指向自己的快捷方式。

### 3.4 Android

- 签名证书必须和已安装的一致（换签名 = 用户要卸载重装）。
- 更新源是 `latest.json`（GitHub Releases 或自建目录），客户端按 `versionCode` 比较。
- 0.1.13 起是原生应用（Kotlin + Compose），从 WebView 外壳在线更新过来不需要重新登录（同一签名、同一会话）。

### 3.5 发版后

- GitHub Release 页、三个更新源（PC `latest.yml`、Android `latest.json`、登录后的下载页）都指向新版；旧安装包归档，不删。
- 清理临时文件时**必须**先判断变量非空：`[ -n "$R" ] && rm -rf "$DIR/$R"`（曾有空变量把整个下载目录删掉的事故）。
- 更新 ROADMAP「最近完成」、BACKLOG 状态、[CHANGELOG](CHANGELOG.md)。
- 真机验证（Windows、手机）仍是待办（CB-017），发版说明里写清没在真机上跑过的部分。

## 4. 自测与生产安全规则

- **绝不碰真实对话**：自测用 `POST /api/admin/smoke`（设置 → 系统更新 →「自检」），模型往返一次，什么都不保存。
- 生产端到端：只用**一次性机器人**（标题「临时测试（会删除）」）+ **临时签发的会话**，跑完删除机器人和会话；删除只走带快照的守卫脚本。
- 生产检查默认**只读**：在浏览器层拦截所有非 GET 请求；需要写的流程放进预览容器（生产数据副本、出网封锁）。
- 上线前后各取一次生产快照（线程数、机器人数、设备数、关键设置哈希），除镜像 / 版本外必须一致。
- 设备相关的端到端：用一次性的节点容器配对，跑完删除设备；**不在生产上配对 / 解绑真实手机**。

## 5. 检查清单

- [ ] 分支基于最新 `origin/main`，合并前已 rebase，CI「ChisaBot checks」绿
- [ ] 类型检查、相关测试、改到聊天就跑 `tests/chat-scroll/regression.sh`（[testing.md](testing.md)）
- [ ] DESIGN.md 章节号取 main 上下一个空号；BACKLOG / ROADMAP / CHANGELOG 已更新
- [ ] 合并 → `deploy-serial.sh` → 自检 → 只读生产检查 → 快照对比
- [ ] 客户端发版：三处版本一致、versionCode +1、发版说明、外壳指纹、签名 APK、更新源
