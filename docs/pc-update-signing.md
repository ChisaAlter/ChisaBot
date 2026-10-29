# PC 更新验签（审查第 7 项 / M7）

> 状态：已实现（`fix/pc-update-signing`）。**Windows 端到端（§7.3）跑完之前不合并、不发版。**
> 合并前还要 Jun 先做 §4.3 的密钥操作，并把两个公钥写进 `pc/src/update-keys.json`，否则通用版发布会在 CI 失败。

## 0. 已定决定

| # | 决定 |
|---|------|
| ① | 主钥放 GitHub Actions secret，**CI 自动签名，不加人工审批**。签名 job 绑定 Environment `pc-release`：这个 Environment **只允许 `v*` 标签**，**不配审批人**。备用钥离线保存。客户端内置「主 + 备」两个公钥。 |
| ② | **不买代码签名证书**，第二阶段（Authenticode / publisherName）暂缓，见 §3.4。 |
| ③ | 自建版没配公钥：**保持旧行为（只有 sha512）并提示**「此版本未启用更新验签」。自建版可以用 `CHISABOT_UPDATE_PUBKEYS` 提供自己的公钥。 |
| ④ | 检查间隔保持 30 分钟。这个分支不改版本号；第一个带验签的版本（下文 vK）用哪个版本号，合并时定。 |
| ⑤ | **不加「只告警不拦截」开关**。通用版验签失败一律拒装。 |

签名做成独立脚本 `pc/scripts/sign-update.js`（带 `--verify`），CI 只是调用它，以后换成离线手签只要改调用方式（`--key-file`）。

## 1. 现状（改动前）

- **更新实现**：electron-updater 6.8.9，generic provider（`pc/src/updater.js`、`pc/package.json` 的 `build.publish`）。
  - **更新源**：按 `build-config.js` 的 `resolveFeed` 选，顺序是：
    1. 本机 `config.json` 的 `updateFeed`（只接受 https）；
    2. 构建期的 `updateFeed`（CI 变量 `CHISABOT_UPDATE_FEED`，自建版用）；
    3. `https://github.com/<repo>/releases/latest/download/`（通用版走这一项）。
  - **流程**：启动 30 秒后检查一次，之后每 30 分钟一次；agent 上线时如果版本和网页不一致，还会主动检查（`main.js` 的 `pc:check-update` / 上线检查）。读 `latest.yml` 后在后台下载完整的 NSIS 安装包，electron-updater 校验 sha512，然后两种安装方式二选一：
    - `quitAndInstall`（`--updated /S`）；
    - 「重新安装」：自己 spawn 安装包，参数 `/S --force-run`，由 `chisabotShell` 或 `fullInstall` 触发。
    - 选「稍后」时，退出程序时自动安装。
  - **清单格式**：electron-builder 标准的 `latest.yml`（version / files[url, sha512, size] / path / sha512 / releaseDate），CI 的 `shell-fingerprint.js --stamp` 再追加 `chisabotShell`，可选再加 `fullInstall: true`。
- **校验**：只有 HTTPS，加上**同一个源里**的 sha512。没有任何签名。
  - `package.json` 里 `win.signExecutable: false`、`verifyUpdateCodeSignature: false`；`updater.js` 把 `autoUpdater.verifyUpdateCodeSignature` 换成直接返回通过。
  - sha512 和安装包放在同一个地方，只能防下载损坏，防不了篡改。
- **发布流程**：`.github/workflows/release.yml`，推 `v*` 标签触发；windows-latest 上跑 `electron-builder --win nsis zip --publish never`，接着 stamp `latest.yml`、比对 sha512、上传 artifact；release job（ubuntu，`contents: write`）用 `gh release upload --clobber` 传到 GitHub Release。自建版只产出 artifact，由发布者自己复制到静态目录。
- **Windows 代码签名**：没有证书，安装包和 exe 都没签，SmartScreen 会提示「未知发布者」。

### 1.1 electron-updater 6.8.9：没有 publisherName 时 verifyUpdateCodeSignature 会不会被调用？

**结论：不会被调用，钩子被跳过。** 对照 npm 上 electron-updater 6.8.9 的发布代码（`out/NsisUpdater.js`、`out/BaseUpdater.js`、`out/AppUpdater.js`）：

- `NsisUpdater.doDownloadUpdate` 下载完、sha512 校验通过后调用 `this.verifySignature(destinationFile)`，签名不通过就抛错、删文件。
- `NsisUpdater.verifySignature` 先读 `app-update.yml`（`this.configOnDisk.value`）里的 `publisherName`：
  - 读到的 `publisherName == null` → **直接 `return null`（= 通过），不调用 `this._verifyUpdateCodeSignature`**；
  - `app-update.yml` 不存在（ENOENT）→ 同样 `return null`。
  - 只有 `publisherName` 非空时，才会调 `_verifyUpdateCodeSignature(publisherName, file)`（也就是可被替换的 `verifyUpdateCodeSignature`）。
- 我们的 `build.win.verifyUpdateCodeSignature: false` 让 electron-builder 不往 `app-update.yml` 写 `publisherName`，所以这条校验从来没生效过；`updater.js` 里把 `verifyUpdateCodeSignature` 换成「通过」只是两边一致，**不是安全措施，也不能拿来挂我们自己的验签**。
- 另外：如果下载目录里已经有同一个 sha512 的安装包（上次下载过、还没装），`doDownloadUpdate` 走 `validateDownloadedPath` → 直接复用缓存，**这条路连 verifySignature 都不走**，但照样派发 `update-downloaded`。

所以验签只能放在 `update-downloaded` 里我们自己做：下载新包和复用缓存这两条路都会经过这里。

另一个实现时确认的细节：`BaseUpdater.executeDownload` 完成后先派发 `update-downloaded`，**然后**才 `addQuitHandler()`，而 `addQuitHandler` 只在**那一刻** `autoInstallOnAppQuit` 为 true 时才挂退出安装（之后再改成 true 也不会补挂）。验签是异步的，等验完再「恢复 autoInstallOnAppQuit」已经晚了。因此启用验签后 electron-updater 的退出安装一直关着，退出时由我们的 `installOnQuit` 调公开的 `autoUpdater.install(true, false)`（和 electron-updater 自己退出安装用的参数一样）。

## 2. 风险

只要拿到下面任一项，就能让**所有开着自动更新的客户端**静默安装任意 exe（以用户权限，NSIS 静默安装），等于远程执行代码：

- GitHub 账号或 token；
- 能推标签、能改 workflow 的人；
- 自建更新目录的写权限；
- 发布 job 的供应链（被投毒的 action 或依赖）。

30 分钟的检查间隔加上 agent 上线时的主动检查，会让这个攻击窗口很短、扩散很快（决定④：间隔不改，靠验签兜住）。本机 `config.json` 的 `updateFeed` 改写需要本地权限，风险较低，加了签名以后这一项也一并防住。

**验签之后还剩什么风险**：拿到 `PC_UPDATE_SIGNING_KEY`（GitHub 上 `pc-release` Environment 的 secret）的人仍然能签。决定①接受这个风险，换来全自动发版；缓解措施是 Environment 只允许 `v*` 标签（PR、分支上的 workflow 拿不到 secret）、私钥只在签名 job 的一个步骤里出现、主钥泄露时用离线备用钥轮换（§4.2）。

## 3. 方案：Ed25519 签名清单 + 客户端用内置公钥校验

### 3.1 签什么

对规范化消息签名（`pc/src/update-signature.js` 的 `canonicalMessage`，签名方和客户端共用这一份代码）：

```
chisabot-pc-update/v1
version=<version>
path=<安装包文件名>
sha512=<安装包 sha512，base64>
size=<files[] 里 url == path 那一项的 size；没有就空>
chisabotShell=<外壳指纹，去掉首尾空白；没有就空>
fullInstall=<true|false>
```

- 每项一行、固定顺序、结尾换行，UTF-8。任何值里有换行 → 拒绝（防止拼出假行）。
- `files[]` 里 url == path 那一项的 sha512 必须和顶层 sha512 一致（electron-updater 下载校验用的是 files 那一项），不一致 → 拒绝。
- `fullInstall` 和 `updater.js` 的 `requiresFullInstall` 理解一致：只有 `true` / `"true"` 算 true。
- 签名写进 `latest.yml` 的新字段，单引号包起来：`chisabotSig: '<keyId>:<base64 签名>'`。keyId = 原始公钥（32 字节）sha256 的前 8 个十六进制字符。electron-updater 把未知字段原样放进 UpdateInfo（`chisabotShell` 就是这样读到的）。
- 安装包本身不改，签了 sha512 就等于签了安装包。`releaseDate`、`.blockmap` 等不在签名里：它们不影响装什么。
- 签名方和 electron-updater 都用 **js-yaml** 解析 `latest.yml`，值的类型一致，拼出来的消息逐字节相同（测试里有 js-yaml 往返测试）。
- 签名覆盖 version，`allowDowngrade = false` 保留：把旧的已签名清单重放回来也降不了级。

### 3.2 客户端（`pc/src/updater.js`）

- 启动时用 `update-signature.loadKeys()` 读内置公钥表 `pc/src/update-keys.json`（打进 asar）：
  - 有公钥 → **启用验签**；
  - 空表（`"keys": []`）→ 不验签，保持旧行为（决定③），`state.signing = false`，网页「本机」页提示「此版本未启用更新验签」；
  - 文件读不出来 / 格式不对 / keyId 和公钥对不上 → 当作启用验签但没有可用公钥：**所有更新都拒绝**（宁可装不上）。
- 启用验签时：
  - `autoInstallOnAppQuit` 一直是 false（原因见 §1.1）。
  - `update-downloaded` → 状态 `verifying`（网页显示「正在校验更新包签名」）→ 校验：
    1. `chisabotSig` 存在、格式对、keyId 在公钥表里、Ed25519 签名对得上规范化消息；
    2. 下载文件（`info.downloadedFile`）的大小等于签名覆盖的 size（有的话），sha512 自己再算一遍，等于签名覆盖的 sha512。
  - 通过 → `downloaded`，和以前一样弹窗「新版本已下载」，可以立即重启（`quitAndInstall(true, true)`）或稍后（退出时 `installOnQuit` → 普通更新 `autoUpdater.install(true, false)`，重新安装照旧自己 spawn `/S`）。
  - 失败 → 删掉下载文件，状态 `error`：「更新包签名校验失败，已拒绝安装：<原因>」，写审计日志 `update_rejected`，不弹窗、不安装（立即和退出时都不装）。缺签名、keyId 未知、签名不符、大小 / 哈希不符、公钥表坏了，一律拒绝。下次检查会重新下载、重新校验（文件已删，electron-updater 不会复用缓存）。
  - 没有「只告警不拦截」开关（决定⑤）。
- 校验结果的错误码（日志 / 审计里能看到）：`ERR_NO_SIGNATURE`、`ERR_SIGNATURE_FORMAT`、`ERR_UNKNOWN_KEY`、`ERR_SIGNATURE_MISMATCH`、`ERR_MANIFEST`、`ERR_SIZE_MISMATCH`、`ERR_HASH_MISMATCH`、`ERR_NO_FILE`、`ERR_NO_KEYS`。
- 依赖 Electron 自带 Node 的 `crypto.verify(null, …)`（Ed25519）。Electron 44 的 Node 是 BoringSSL 构建，支持 Ed25519；Windows 端到端里要实际确认（§7.3）。

### 3.3 签名脚本和 CI

- `pc/scripts/sign-update.js`（在 `pc/` 下运行）：
  - `node scripts/sign-update.js dist/latest.yml`：私钥从环境变量 `PC_UPDATE_SIGNING_KEY`（PKCS8 PEM 文本）读，或 `--key-file <离线私钥.pem>`；写入（或替换）`chisabotSig` 一行。私钥不落盘、不打印，私钥解析错误也不回显原文。签名用的钥匙不在公钥表（默认 `src/update-keys.json`，可 `--keys`）里就拒绝签——客户端只认公钥表。签完先在内存里验一遍再写盘。
  - `--verify dist/latest.yml [--installer <安装包>] [--tamper-check]`：验清单签名 + 安装包大小和 sha512；`--tamper-check` 再把每个签名字段、安装包第一个字节各改一次，确认每次都被拒绝（CI 自检）。
  - `--require-keys`：公钥表为空就失败（通用版发布用）。
  - `--keys-from-env`：自建版按 `CHISABOT_UPDATE_PUBKEYS`（逗号或空白分隔的 base64 公钥）写公钥表；变量为空 → 空表 → 这个自建版不验签。
- `pc/scripts/shell-fingerprint.js --stamp` 会顺手去掉旧的 `chisabotSig`（盖章后签名一定失效）：**签名永远是发布的最后一步**。
- `.github/workflows/release.yml`：
  - `config`：发布（有标签）时必须从这个标签运行（`github.ref` 是 `refs/tags/vX`）。手动发布要在「Use workflow from」里选标签——Environment 只允许 `v*` 标签，从分支跑签名 job 会被 GitHub 拒绝，这里提前给出明确报错。
  - `pc`（windows，跑 electron-builder）：新增「Update keys」步骤——通用版发布时 `--require-keys`（公钥表为空直接失败），只构建不发布时只告警；自建版 `--keys-from-env`（仓库变量 `CHISABOT_UPDATE_PUBKEYS`）。产物改名为 `pc-<flavor>-unsigned`，附带 `update-keys.json`。**这个 job 拿不到签名私钥。**
  - 新 job `pc-sign`（ubuntu，只在发布时跑，`environment: pc-release`）：`npm ci --ignore-scripts --omit=dev`（只为 js-yaml，不跑安装脚本）→ 下载未签名产物 → 用 secret `PC_UPDATE_SIGNING_KEY` 签名 → `--verify --tamper-check` → 上传 `pc-<flavor>`。自建版没配公钥时跳过签名并告警。
  - `release` 改为依赖 `pc-sign`，仍然只下载 `*-generic`。
- 以后改成离线手签：去掉 `pc-sign` 的 secret，发版时下载 `pc-generic-unsigned`，本机 `node scripts/sign-update.js latest.yml --key-file <私钥>`，再上传 `latest.yml`；脚本不用改。

### 3.4 Windows 代码签名（第二阶段，暂缓）

决定②：**不买代码签名证书，第二阶段暂缓。**

- electron-updater 自带的 publisherName / Authenticode 校验要证书（OV / EV，或 Azure Trusted Signing 约 10 美元 / 月）。好处是能消掉 SmartScreen「未知发布者」、Windows 认得发布者；缺点是证书钥匙一样放在 CI，被入侵后一样能签。
- 现在的 Ed25519 验签免费、完全自控、可以离线签，和代码签名不冲突。以后要做：`build.win` 配证书和 `publisherName`，去掉 `verifyUpdateCodeSignature: false` 和 `updater.js` 里的「通过」替换，两层一起用。

## 4. 密钥

### 4.1 生成和保管

- 生成：`pc/scripts/gen-update-key.js --out <仓库外的路径.pem> [--label primary]`，用 Node `crypto.generateKeyPairSync('ed25519')`。
  - 私钥（PKCS8 PEM）写到 `--out`（权限 0600），**不打印**；拒绝写进仓库目录、拒绝覆盖已有文件。
  - 终端只输出 keyId、公钥（base64 raw，32 字节）和要放进 `update-keys.json` 的那一项。
- 两把钥匙：
  - **主钥**：放 GitHub Environment `pc-release` 的 secret `PC_UPDATE_SIGNING_KEY`，CI 自动签。
  - **备用钥**：离线保存（U 盘 / 密码管理器，至少两份），平时不用；公钥从 vK 起就内置进客户端。
- 公钥表 `pc/src/update-keys.json`：

  ```json
  {
    "keys": [
      { "keyId": "<8 位>", "publicKey": "<base64>", "label": "primary" },
      { "keyId": "<8 位>", "publicKey": "<base64>", "label": "backup (offline)" }
    ]
  }
  ```

  仓库里现在是空表（`"keys": []`）：这个分支**没有生成、也没有提交任何真实密钥**，测试用的都是测试时现生成的临时钥。
- **绝对不进仓库**：私钥、私钥文件路径都不进。`.gitignore` 加了 `*.pem`、`update-signing*`。

### 4.2 轮换

- 正常轮换：版本 N 内置「旧 + 新」两个公钥，仍用旧钥签；N+1 起用新钥签（换 secret）；N+2 去掉旧公钥。
- 主钥泄露：立即删掉 secret；用离线备用钥（`--key-file`，本机签）签一个紧急版本，这个版本只内置「备用公钥 + 一把新主钥的公钥」；新主钥填进 secret；检查 Releases 里有没有被替换的文件。已经装了 vK 之后版本的客户端只认表里的钥匙，拿旧主钥签的东西在紧急版本之后就装不上了。

### 4.3 Jun 要做的（约 30 分钟，合并前）

1. **生成密钥**：在自己电脑上（仓库目录之外）运行两次：
   ```
   cd pc
   node scripts/gen-update-key.js --out D:\keys\chisabot-update-primary.pem --label primary
   node scripts/gen-update-key.js --out E:\offline\chisabot-update-backup.pem --label "backup (offline)"
   ```
   记下两次输出的 `update-keys.json entry` 那一行（只有公钥，可以公开）。
2. **配 Environment**：仓库 Settings → Environments → New environment `pc-release`：
   - Deployment branches and tags → **Selected branches and tags** → 添加规则，类型选 **Tag**，模式 `v*`（不要加任何分支）；
   - **不勾 Required reviewers**（决定①：不加人工审批）；
   - 不需要其它保护规则。
3. **填 secret**：同一个 Environment `pc-release` → Environment secrets → `PC_UPDATE_SIGNING_KEY`，值是主钥 `.pem` 文件的全文（含 `-----BEGIN PRIVATE KEY-----` 两行）。只放 Environment secret，不要放仓库级 secret。
4. **离线备份**：备用钥 `.pem` 存两份离线（U 盘 + 密码管理器），然后删掉电脑上的备用钥文件；主钥 `.pem` 填进 secret 后也删掉（或同样离线保存一份以便以后本机重签）。
5. **把两个公钥发给开发者**，写进 `pc/src/update-keys.json`（主 + 备两项）。没有这一步，通用版发布会在「Update keys」步骤失败。
6. （自建版，可选）要让自建版也验签：仓库变量 `CHISABOT_UPDATE_PUBKEYS` 填公钥（逗号分隔；用同一把主钥签就填同样两个公钥）。不填 = 自建版不验签、照旧更新，网页提示「此版本未启用更新验签」。
7. 以后发版和以前一样推 `v*` 标签，不用点审批。手动重跑发布要在「Use workflow from」里选这个标签。

## 5. 改动文件

- 新增：`pc/src/update-signature.js`（规范化消息、签名、验签、公钥表）、`pc/src/update-keys.json`（空公钥表）、`pc/scripts/sign-update.js`、`pc/scripts/gen-update-key.js`、`pc/test/update-signature.check.js`、`pc/test/update-verify.check.js`、本文。
- 修改：
  - `pc/src/updater.js`：`updateKeys` / `verifyDownload` / `onRejected`；`verifying` 状态；验签通过前不安装；启用验签时自己负责退出安装；文件头更新 §1.1 的结论。
  - `pc/src/main.js`：传入公钥表、`update_rejected` 审计、退出安装的审计文案。
  - `pc/scripts/shell-fingerprint.js`：`--stamp` 去掉旧的 `chisabotSig`。
  - `app/src/lib/pc-bridge.ts`、`app/src/components/devices/devices.tsx`：「正在校验更新包签名」、「此版本未启用更新验签」。
  - `.github/workflows/release.yml`：§3.3。
  - `docs/online-update.md`、`pc/README.md`、`DESIGN.md`、`.gitignore`、两处 CHANGELOG 的 Unreleased、`docs/DEVLOG.md`。

## 6. 兼容与过渡

- 已安装的老版本不认识 `chisabotSig`，照常按 sha512 安装下一版。vK（第一个带验签的版本，版本号合并时定）**这一跳本身没有保护**，没法避免；之后的每次更新都会被校验。
- 从 vK 起所有发布都必须签名（CI 强制）；给已发布的老版本补签没有意义。
- 回滚预案：如果 vK 的校验逻辑有 bug 导致装不上 vK+1，用户可以手动下载安装包覆盖安装（数据保留）。所以 vK 发布前必须做完 §7.3 的端到端测试。不提供「只告警不拦截」开关（决定⑤）。
- 被拒绝的更新每次检查（30 分钟）都会重新下载一遍再拒绝：只在源被篡改或配置错误时出现，审计日志里有 `update_rejected`。
- Android 不变。

## 7. 测试

### 7.1 单元测试（`cd pc && npm test`）

- `test/update-signature.check.js`：规范化消息；签名 + 验签（含下载文件大小和 sha512）；逐字段篡改（version / path / sha512 / size / chisabotShell / fullInstall）都失败，去掉 chisabotShell 也失败；攻击者换安装包并重算 sha512 → 失败；缺签名、格式错、未知 keyId、冒用 keyId、没有公钥；主备轮换和轮换后旧钥失效；公钥表空 / 正常 / 损坏；仓库里的公钥表能解析且不含私钥；`sign-update.js` 签名 / 重签 / `--verify` / `--tamper-check` / `--key-file` / 拒签各种情况，且输出里不含私钥；`--stamp` 去掉旧签名；`--require-keys` / `--keys-from-env`；js-yaml 往返；`gen-update-key.js` 只写仓库外文件、不覆盖、不打印私钥。所有密钥都是测试时现生成的临时钥。
- `test/update-verify.check.js`（假的 autoUpdater，模拟 6.8.9 的派发顺序）：启用验签时 electron-updater 不挂退出安装；通过 → verifying → downloaded，立即重启 / 稍后退出安装 / 重新安装两条路都对、只装一次；失败 → 文件删掉、error、`onRejected`、不弹窗、立即和退出时都不装、重新安装也不跑；没公钥 → 旧行为；用真签名的端到端（正确、陌生钥、没签名、换了一个字节、公钥表坏）。
- 原有的 `update.check.js` / `shell.check.js` 不变（不传 `updateKeys` = 旧行为）。

### 7.2 CI 自检

`pc-sign` 签完马上 `--verify --tamper-check`：验签通过，且每个字段 / 安装包一个字节被改后都验不过，否则不发布。

### 7.3 Windows 端到端（合并前必须做）

在 Windows 虚拟机上：先装 vK（用测试密钥构建：`update-keys.json` 放测试公钥，`updateFeed` 指向测试更新目录），再在测试源上分别放三种 vK+1：

- a）正确签名 → 能更新；
- b）改了 `latest.yml` 的 sha512 并换了安装包（不重签）→ 拒绝；
- c）用另一把钥匙签 → 拒绝；
- 另外确认：网页「本机」页在校验时显示「正在校验更新包签名」，拒绝时显示错误、审计日志有 `update_rejected`、下载目录里的安装包被删掉；Electron 里 Ed25519 校验可用。

a/b/c 都要覆盖「立即重启」和「稍后 → 退出时安装」两条路径，以及「重新安装」（`fullInstall: true`）一种。

## 8. 工作量

- 开发和单元测试、CI、文档：本分支。
- Windows 端到端：0.5 天。
- Jun 的密钥操作：约 30 分钟（§4.3）。
- 代码签名（第二阶段）：暂缓（决定②）。
