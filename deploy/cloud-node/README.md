# 云端工作区节点（cloud-node）

服务器上一个独立的容器，里面是 Claude Code CLI 和 `chisabot-node`。配对后在 ChisaBot 里叫「云端工作区」，网页和手机上的
Claude Code 标签页就在它里面写代码（设计见 [docs/cloud-claude-code.md](../../docs/cloud-claude-code.md)，决定见 ADR-0014）。

## 安全边界

- 非 root（uid 1000，用户 `agent`），`cap_drop: ALL`，`no-new-privileges`，根文件系统只读，`/tmp` 是 tmpfs，2 核 / 4 GB / 512 个进程。
- 不挂 docker.sock，不用 host 网络，不发布任何端口。
- 配对时带 `--no-full-access`：本机永远拒绝完全访问；服务器也拒绝给云端工作区开完全访问。
- 独占一个 Docker 网桥，`firewall.sh` 丢弃这个网段发往私有网段（其他容器、内网、元数据地址）和主机的流量。节点只能出公网，
  连 ChisaBot 也走公网地址。
- 两个卷：`home`（Claude 凭据 `~/.claude/.credentials.json`、节点配置 `~/.chisabot-node/config.json`，都是 600）和 `workspace`
  （`projects/<工作区>/…`）。

## 部署

```sh
# 1. 镜像（Claude Code 版本固定，升级时改 CLAUDE_CODE_VERSION 重新构建）
docker build -t chisabot-cloudnode:2.1.165 --build-arg CLAUDE_CODE_VERSION=2.1.165 deploy/cloud-node
#    （镜像里带 Chromium + 中文字体，给「在云端完成登录」用；/tmp tmpfs 512 MB 够用）

# 2. 网桥（可以复用一个空闲的），再加防火墙
docker network create chisabot-cloudnode-net        # 记下网段：docker network inspect chisabot-cloudnode-net
sudo sh deploy/cloud-node/firewall.sh 172.29.0.0/16
# 主机上有只劫持 Claude 域名的 DNS（例如 sing-box TUN 的 fake-ip DNS）时：两处都设 CLOUDNODE_DNS
#   sudo CLOUDNODE_DNS=<CLOUDNODE_DNS> sh deploy/cloud-node/firewall.sh 172.29.0.0/16   （compose 也带上 CLOUDNODE_DNS=<CLOUDNODE_DNS>）

# 3. 安装码：ChisaBot 网页 设置 → 设备 → 添加设备 → 服务器，复制 cbp_ 开头的安装码（一次性）
CHISABOT_SERVER=https://你的域名:8443 CHISABOT_PAIR_CODE=cbp_xxx \
  docker compose -f deploy/cloud-node/compose.yaml up -d
```

第一次启动用安装码配对，以后重启直接用 home 卷里的设备令牌；每次启动都从服务器下载最新的 `chisabot-node.cjs`。

应用发版改了节点程序时不用手动重启：节点连着服务器，空闲（没有会话 / 登录流程）时会发现自己在跑的程序和服务器现在发的不一样，自己退出，容器按 `restart: unless-stopped` 重新起来并下载新版（同一个新版 15 分钟内只试一次、任何自动重启一小时最多一次）。网页 设置 → 云端工作区 的账号卡下面会提示「云端节点还在跑旧版节点程序」：新版给「重启节点」按钮，比这个功能还旧的节点给 `docker restart chisabot-cloudnode`。

## 登录 Claude

ChisaBot 网页：设置 → 云端工作区 →「**在云端完成登录**」：镜像里的无头 Chromium（和 Claude Code 同一个容器，所以同一个出口 IP、同一套防火墙）
打开 Claude 授权页，画面嵌在设置页里；你在里面登录、点「授权」，节点读到回调地址里的授权码，直接交给 `claude auth login`，不用复制粘贴。
浏览器用 `--remote-debugging-pipe` 控制（不开端口），`--no-sandbox`（容器本身就是沙箱：非 root、cap_drop ALL、只读根文件系统），配置目录在
`/tmp` 里，登录结束 / 取消就删掉。卡片底部显示浏览器和 Claude Code 各自看到的出口 IP（claude.ai 的 `/cdn-cgi/trace`），应该一样。

备用：「粘贴授权码」——授权页在你自己的浏览器里打开（用你电脑的 IP），复制授权码粘回来。

授权码、密码只经过节点进程，不进 ChisaBot 的数据库和日志。旧镜像（没有 Chromium）只显示粘贴授权码这一种。

## Claude 上游代理（可选）

设置 → 云端工作区 →「Claude 上游代理」：填 `http://`、`https://` 或 `socks5://[用户名:密码@]主机:端口`（自己的代理 / 静态住宅 IP），
「测试连接」显示出口 IP 和 claude.ai / api.anthropic.com 通不通。地址加密存在保险箱（保留名 `claude-proxy`），只在节点进程内存里。

- 节点进程里有一个只听容器 127.0.0.1 的转发器：Claude 的域名（`anthropic.com`、`claude.ai`、`claude.com` 及子域）走上游代理，
  其他域名（GitHub、npm…）照旧直连。Claude Code（`HTTPS_PROXY`，包括登录、换令牌）和云端登录浏览器（`--proxy-server`）都连这个转发器，
  所以登录和日常使用是同一个 IP。socks5 由代理解析域名。
- 防火墙不用改：代理在公网上就能连（`firewall.sh` 只丢私有网段和主机）。代理在内网 / 本机时要自己在 DOCKER-USER 里给它开一条 RETURN。
- 改了以后正在跑的那一轮不打断：它新建的连接马上按新设置走，下一轮整轮都用新设置。
- 服务器自己不直接连 Anthropic（模型走 Magpie，不受这个设置影响）。

### 节点链接（sing-box 转换）

也可以直接粘贴 `trojan://`、`vless://`（含 Reality / Vision）、`vmess://`（v2rayN base64 JSON）、`ss://`（SIP002 和旧式）、
`hysteria2://` / `hy2://`、`tuic://` 节点链接，打开「用 sing-box 转换此链接」后保存（DESIGN.md §85）。

- 镜像里装了固定版本的 sing-box（`SINGBOX_VERSION`，构建时按官方发布页的 sha256 校验，`/usr/local/bin/sing-box`）。
  旧镜像没有 sing-box：页面会提示更新镜像，普通 http / socks5 代理照常能用。
- 服务器把链接解析成 sing-box 出站（`shared/proxy-links.ts`）发给节点；节点起一个 sing-box 子进程，入站是只听容器 127.0.0.1
  随机端口、随机账号密码的 socks5，出站就是这个节点。上面的转发器把它当 socks5 上游，分流规则完全一样（只有 Claude 的域名走它）。
- 配置经标准输入给 sing-box，不落盘；sing-box 意外退出时节点进程按 1→30 秒退避重启；日志只转 warn 以上并抹掉密码 / UUID。
- 保存前先在节点上把 sing-box 起好，起不来就不保存、旧设置照常用。保存后网页自动测一次，显示出口 IP 和国家 / 地区。
- 节点服务器要在公网（`firewall.sh` 丢私有网段）；UDP 协议（hysteria2 / tuic）需要主机允许出站 UDP。

## 电脑文件夹同步的边车（cloudnode-sync）

```sh
docker build -t chisabot-cloudnode-sync:0.18.1 deploy/cloud-node/sync   # 源码编译 Mutagen v0.18.1 agent（不带 SSPL 代码）
docker compose -f deploy/cloud-node/compose.yaml up -d                   # 节点 + 边车一起
```

- 边车和节点共用网络命名空间（`network_mode: service:cloudnode`），sshd 只听 127.0.0.1:2222，**不发布端口**；电脑只能经
  ChisaBot 网关的 `/api/devices/agent/sync-tunnel`（一次性隧道票）进来，节点再连本机 2222。
- uid 1000、根文件系统只读、`cap_drop: ALL`、256 MB；只挂工作区卷的 `projects/`（不挂 home）。每把电脑公钥都是
  `restrict,command="chisabot-sync-gate <工作区> <绑定>"`，只能启动 Mutagen 同步 agent 和这个工作区的 git upload/receive-pack。
- compose 的 `volume.subpath` 要求 `projects/` 已经存在：节点入口每次启动都会建它；第一次部署时先起节点再起边车（或者 `up -d` 两次）。
- 检查：`docker port chisabot-cloudnode-sync` 为空；`docker logs chisabot-cloudnode-sync` 有 `Server listening on 127.0.0.1 port 2222`；
  主机 `ss -ltn` 没有 2222。
- **节点重启后边车要跟着重启**：`docker restart chisabot-cloudnode` 给节点一个新的网络命名空间，边车还留在旧的里面，
  节点连 2222 就是 ECONNREFUSED（电脑文件夹新建 / 开启同步全部失败）。装上看门狗，它每 30 秒比较两边的 netns，不一样就重启边车：
  ```sh
  cp deploy/cloud-node/sync-watch.sh /opt/chisabot-cloudnode/
  cp deploy/cloud-node/systemd/chisabot-cloudnode-syncwatch.* /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now chisabot-cloudnode-syncwatch.timer
  ```
  服务器在新建 / 开启同步之前也会先让节点 `sync_probe` 一次边车，连不上就直接报错、什么都不建（DESIGN.md §87）。

## 验收（部署后）

```sh
docker exec chisabot-cloudnode id -u                    # 1000
docker exec chisabot-cloudnode ls /var/run/docker.sock  # 不存在
docker port chisabot-cloudnode                          # 空
docker exec chisabot-cloudnode curl -m 5 http://172.17.0.1:80   # 失败（主机 / 其他容器都连不上）
```

## 停用

`docker compose -f deploy/cloud-node/compose.yaml down`（卷保留）；在 设置 → 设备 撤销这台设备；`firewall.sh <网段> remove`。
