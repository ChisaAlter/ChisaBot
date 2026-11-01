# ChisaBot PC（Windows 客户端）

架构与安全模型见 `../docs/pc-node.md`（§8 是客户端），界面规范见 `../DESIGN.md` §16。

- 主窗口就是服务器上的 ChisaBot 网页本身（同一套聊天 / 偏好设置 / 管理后台布局）；本机设置是网页的
  偏好设置 → 设备 → 这台电脑（「本机」标签），通过 `src/web-preload.js` 的本机桥做网页做不到的事。
- 原生窗口（登录页、审批弹窗、本机确认、离线页）在 `src/ui/`，令牌和天空由
  `node scripts/sync-skyglass.mjs` 从 `../app/src/styles.css`、`../app/src/lib/sky.ts` 生成（网页改了令牌就重跑）。

```sh
npm ci                 # 依赖（electron、electron-builder、ws）
npm test               # 节点核心与本机操作的单元测试（node:test，Linux 上也能跑）
npm start              # 本机运行 Electron
node src/cli.js run --server https://chisabot.example.com:8443 --token-file device.token   # 无界面节点
```

打包 Windows 安装包：推荐用 GitHub Actions（`.github/workflows/release.yml`，推 `v*` 标签即可，产物进 Releases）。
本地打包需要 Windows，或 x86_64 Linux + wine（如 `electronuserland/builder:wine` 容器）：

```sh
npx electron-builder --win nsis zip --x64 --publish never   # → dist/ChisaBot-PC-<版本>-x64-setup.exe / -portable.zip
```

构建期默认值在 `src/build-config.json`（仓库里为空 = 通用版：首次运行在本机登录页里填自己的服务器地址）。登录页 `src/ui/login.*`（Android 0.1.13 起是原生登录页，不再共用）。
CI 从仓库变量 `CHISABOT_SERVER_URL`、`CHISABOT_UPDATE_FEED` 写入；自建打包可以手动改这个文件，或
`npx electron-builder ... -c.publish.url=<你的更新目录>`。

在线更新：`src/updater.js`（electron-updater generic，更新源按 本机 config.json 的 `updateFeed` →
构建期 `updateFeed` → `https://github.com/<owner>/<repo>/releases/latest/download/` 的顺序选；安装包未签名、
校验 latest.yml 的 sha512），本机窗口 `src/ui/update.html`。详见 `../docs/online-update.md` §2。

更新验签：`src/update-signature.js` + 内置公钥表 `src/update-keys.json`，下载完先验 latest.yml 的 `chisabotSig`
（Ed25519）和安装包 sha512，不通过就拒装；公钥表为空 = 不验签（自建版没配公钥）。发布时签名 / 验签：
`node scripts/sign-update.js dist/latest.yml`（私钥来自 `PC_UPDATE_SIGNING_KEY` 或 `--key-file`）、
`node scripts/sign-update.js --verify dist/latest.yml --tamper-check`；生成密钥：`node scripts/gen-update-key.js --out <仓库外.pem>`；
自建版公钥：`CHISABOT_UPDATE_PUBKEYS=<base64,...> node scripts/sign-update.js --keys-from-env`（打包前）。签名必须在
`shell-fingerprint.js --stamp` 之后。详见 `../docs/pc-update-signing.md`。
