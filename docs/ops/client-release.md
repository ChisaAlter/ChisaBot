# 客户端发布（运维部分）

[← 运维手册总览](README.md)

版本号规则、发版 PR 清单、PC 外壳指纹的原理在 [release.md](../release.md) §1、§3。本页讲**发版时在服务器上要做的事**：
更新源目录、签名、上传和清理。

## 1. 更新源

| 更新源 | 目录（示例） | 内容 |
|---|---|---|
| PC 公开更新源 | `<PUBLIC_WEB_ROOT>/downloads/chisabot-pc/` | `latest.yml` + `ChisaBot-PC-<版本>-x64-setup.exe` + `.blockmap` |
| Android 公开更新源 | `<PUBLIC_WEB_ROOT>/downloads/chisabot-android/` | `latest.json` + 签名 APK |
| 登录后的下载页（可选） | `/opt/chisabot-zh/public/downloads/pc/` | `latest.json`（带 sha256 / 字节数），旧版移到 `archive-<版本>/` |
| CI 产物工作目录 | `/opt/chisabot-release/ci-<版本>/` | 每次下载下来的 artifact，留作重建更新源的来源 |

不自建更新源也可以：通用版直接从 GitHub Releases 更新（首次运行让用户填服务器地址）。

## 2. 签名

- Android 签名证书必须和用户已安装的一致：换签名 = 用户要卸载重装。签名密钥**离线备份**，绝不进仓库、不放 Web 根目录。
- 仓库没有配签名 Secrets 时，在自己的机器 / 服务器上用 `apksigner` 签（写一个 `sign.sh` 固定参数），记录证书指纹前缀用于核对。
- 想在 CI 里签：仓库所有者配 4 个 `ANDROID_*` Secrets（[release.md](../release.md) §3.2）。

## 3. 流程（仓库没有签名 Secrets 时）

1. **只构建**：dispatch `.github/workflows/release.yml`（分支 main，不填 `tag`），填
   `server_url=https://<YOUR_DOMAIN>:8443`、`update_feed=https://<YOUR_DOMAIN>/downloads/chisabot-pc/`、
   `android_update_feed=https://<YOUR_DOMAIN>/downloads/chisabot-android/latest.json`，得到预填了你服务器地址的自建版 artifact。
2. 下载 artifact 到 `ci-<版本>/`，用同一把签名密钥签两份 APK（通用版、自建版）。
3. 把签好的**通用版** APK 放到一个**下载目录之外**的临时 HTTPS 路径（随机目录名），再 dispatch 一次，带
   `tag=vX.Y.Z` + `signed_apk_url` + `signed_apk_sha256` → 出 GitHub Release（sha256 不一致会失败）。
4. 用只构建的自建版 artifact 更新你的更新源：
   - 先**整目录备份**：`cp -a downloads downloads-backup-$(date -u +%Y%m%dT%H%M%SZ)`；
   - 核对安装包的 sha512 与 `latest.yml` 一致；
   - 旧安装包归档，不删；
   - 三个更新源（PC `latest.yml`、Android `latest.json`、登录后的下载页）都指向新版。
5. 删除第 3 步的临时目录，**必须带判空保护**：

   ```sh
   R=<临时目录名>
   [ -n "$R" ] && [ -d "$PUB/$R" ] && rm -rf -- "$PUB/$R"
   ```

   曾经有空变量让 `rm -rf "$PUB/$R"` 删掉整个下载目录的事故（[incidents.md](incidents.md)）。
6. 记录每个版本的 workflow run id 和安装包 sha256（放在你自己的运维记录里）。

## 4. 发版后检查

- `curl -s https://<YOUR_DOMAIN>/downloads/chisabot-pc/latest.yml | head`：版本号、sha512、`chisabotShell` 外壳指纹。
- `curl -s https://<YOUR_DOMAIN>/downloads/chisabot-android/latest.json`：`versionCode` 比上一版大。
- 外壳指纹变了的版本，PC 会提示「此更新需要重新安装」，发版说明里写清楚。
- 内部旧版本（例如 0.2.x）不会自动降级到 0.1.x，需要用户手动卸载重装一次（数据保留）。
- 没在真机上验证的部分，发版说明里写清楚。
