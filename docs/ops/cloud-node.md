# 云端工作区节点

[← 运维手册总览](README.md)

云端工作区节点是服务器上的一个独立容器（Claude Code CLI + `chisabot-node`），配对后在 ChisaBot 里显示为「云端工作区」，
网页和手机上的 Claude Code 标签页在它里面写代码。设计见 [cloud-claude-code.md](../cloud-claude-code.md)，首次部署步骤见
[deploy/cloud-node/README.md](../../deploy/cloud-node/README.md)。它是**可选的**，不用云端 Claude Code 可以不装。

## 1. 部署要点

- 目录：建议把 `deploy/cloud-node/` 拷到 `/opt/chisabot-cloudnode/`，compose 项目名 `chisabot-cloudnode`。
- 镜像：`docker build -t chisabot-cloudnode:<版本> --build-arg CLAUDE_CODE_VERSION=<版本> deploy/cloud-node`。
  自己改 Dockerfile 再构建时加构建号（`<版本>-b1`、`-b2`…），并在改之前留 `Dockerfile.bak-<说明>`，方便重建旧镜像回滚。
- 配对：网页 设置 → 设备 → 添加设备 → 服务器，复制一次性的 `cbp_` 安装码：
  `CHISABOT_SERVER=https://<YOUR_DOMAIN>:8443 CHISABOT_PAIR_CODE=cbp_xxx docker compose -f compose.yaml up -d`。
  以后重启用 home 卷里的设备令牌。建议写一个自己的 `up.sh` 包住 `CLOUDNODE_TAG` / `CLOUDNODE_DNS` 等变量。
- 配对使用 `--no-full-access`：节点和服务器都拒绝给云端工作区开完全访问。

## 2. 安全边界（部署后验收）

uid 1000、根文件系统只读、`cap_drop: ALL`、`no-new-privileges`、进程数 512、内存 4 GB、`/tmp` tmpfs、不挂 docker.sock、
不用 host 网络、不发布端口。

```sh
docker exec chisabot-cloudnode id -u                    # 1000
docker exec chisabot-cloudnode ls /var/run/docker.sock  # 不存在
docker port chisabot-cloudnode                          # 空
docker exec chisabot-cloudnode curl -m 5 http://172.17.0.1:80   # 失败（主机 / 其他容器都连不上）
```

## 3. 防火墙

节点独占一个 Docker 网桥（示例网段 `172.29.0.0/16`，以 `docker network inspect` 为准）。`firewall.sh <网段>` 在 `DOCKER-USER`
链里放行已建立连接（以及可选的 DNS 例外），丢弃发往私有网段、主机、云元数据地址的流量。节点只能出公网，连 ChisaBot 也走公网地址。

```sh
sudo sh firewall.sh <节点网段>            # 添加
sudo sh firewall.sh <节点网段> remove     # 删除
```

`DOCKER-USER` 规则重启后会丢，建议包一个开机运行的 systemd 单元（例如 `chisabot-cloudnode-firewall.service`）。

## 4. 同步边车

- `chisabot-cloudnode-sync` 和节点共用网络命名空间，sshd 只听 `127.0.0.1:2222`；电脑只能经网关的
  `/api/devices/agent/sync-tunnel`（一次性隧道票）进来。
- **节点重启后边车要跟着重启**：`docker restart chisabot-cloudnode` 会给节点新的网络命名空间，边车还在旧的里面，连 2222 就是
  ECONNREFUSED（电脑文件夹新建 / 开启同步全部失败）。一定装上看门狗：

  ```sh
  cp deploy/cloud-node/sync-watch.sh /opt/chisabot-cloudnode/
  cp deploy/cloud-node/systemd/chisabot-cloudnode-syncwatch.* /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now chisabot-cloudnode-syncwatch.timer
  journalctl -t chisabot-syncwatch --since -1d | tail -3     # 看门狗日志
  ```

  服务器在新建 / 开启同步之前会先让节点探测边车，连不上就报错、什么都不建。
- 首次部署先起节点再起边车（`volume.subpath` 要求 `projects/` 已存在），或 `up -d` 两次。

## 5. 可选：主机级 Claude 出口路由

只在你需要让 Claude / Anthropic 的流量从特定出口（例如某个地区的代理节点）出去、其他流量直连时才用。更简单的做法是在网页
设置 → 云端工作区 →「Claude 上游代理」里填一个代理或节点链接（只作用于节点进程，[deploy/cloud-node/README.md](../../deploy/cloud-node/README.md)）。

主机级做法示例（sing-box）：

- `sing-box.service`，配置 `/etc/sing-box/config.json`（600，含出口节点凭据）。
- TUN 接口只路由 fake-ip 段（例如 `198.18.0.0/15`、`fc00::/18`），DNS 对 Claude 域名后缀（`anthropic.com`、`anthropic.ai`、`claude.ai`、
  `claude.com`、`claudeusercontent.com`、`clau.de` 等）返回 fake-ip，其余域名正常解析 → 只有 Claude 流量走 TUN。
- 节点 compose 和 `firewall.sh` 都设 `CLOUDNODE_DNS=<TUN 上的 DNS 地址>`，防火墙给这个 DNS 地址开例外。
- 换出口：改 outbound → `sing-box check -c /etc/sing-box/config.json` → `systemctl restart sing-box`。回退：`systemctl disable --now sing-box`。
- 验证：网页「在云端完成登录」卡片底部显示浏览器和 Claude Code 各自看到的出口 IP，两者应一致。

## 6. 日常维护

| 操作 | 做法 |
|---|---|
| 重启 / 按新配置重建 | `docker compose -f compose.yaml up -d`（没变化时是空操作）；只重启：`docker restart chisabot-cloudnode` |
| 应用上线后改了 `pc/src/cloud-cc` | 不用管：节点空闲时比对服务器发来的指纹，自己退出让容器重启并下载新程序（2026-10-22 起；网页账号卡也会提示，「重启节点」可以立刻做）。**比这版更旧的节点**还是 `docker restart chisabot-cloudnode`（节点程序只在启动时从应用下载）。节点重启后记得看同步边车有没有被看门狗拉起（§4） |
| 升级 Claude Code | 改 `CLAUDE_CODE_VERSION` 重新构建，换 `CLOUDNODE_TAG` 后 `up -d` |
| 从头重新配对 | 网页删除设备 → `docker volume rm chisabot-cloudnode_home` → 用新安装码 `up -d` |
| 登录 Claude / 连接 GitHub / 设置上游代理 | 网页 设置 → 云端工作区（需要所有者本人操作） |
| 停用 | `docker compose -f compose.yaml down`（卷保留）→ 网页撤销设备 → `firewall.sh <网段> remove` |
