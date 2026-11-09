# 为每个账号准备独立 DSH 容器

多账号部署使用宿主机运行的 `deploy/dsh/accounts.mjs`，为每个账号建立独立容器、会话卷和网络。Web 服务只读运行时索引，不持有 Docker socket。每个 Host 只能挂载自己的 `/state`，不挂载应用数据库、其他账号的目录或部署凭据。

托管的 `createManagedDshRuntimes` 仍适用于单账号本地环境。它的独立进程和目录不构成多账号操作系统隔离；多账号切换应使用下面的 targets 配置。

如果已经存在 `managed:*` 绑定，先迁移其原始 Session 卷与绑定，再切换运行域。协调器会拒绝直接开通空容器，避免原会话在切换后失去对应日志。

## 配置 API 与宿主协调器

宿主机需要 Node 24、Docker 与 `flock`。API 必须启用真实账号认证：SSO，或签名登录网关且不启用 `CHISABOT_TRUST_UNSIGNED_LOCAL`。协调器会拒绝无认证的单用户管理员模式，否则账号容器通过工具网关网络也能直接调用管理员 API。先创建受限目录，再将它只读挂载到 API 容器：

```yaml
services:
  chisabot:
    volumes:
      - /var/lib/chisabot-account-targets:/var/lib/chisabot-account-targets:ro
    environment:
      CHISABOT_AGENT_KERNEL: dsh
      CHISABOT_DSH_TARGETS_FILE: /var/lib/chisabot-account-targets/targets.json
      CHISABOT_DSH_TOOL_GATEWAY_URL: http://chisabot-api:3001/api/internal/dsh-tools
```

`targets.json` 初始内容为 `[]`，所有者为 API uid/gid（默认 1002:1002），目录权限 `0700`、文件权限 `0600`。API 可以先启动；在 Host 就绪前，请求显示“这个账号的执行环境正在准备”，不会借用管理员实例。

宿主配置 `/etc/chisabot/dsh-accounts.json` 不包含模型密钥：

```json
{
  "apiContainer": "chisabot-zh",
  "image": "local/chisabot:verified-dsh",
  "stateDirectory": "/var/lib/chisabot-account-targets",
  "apiTargetsDirectory": "/var/lib/chisabot-account-targets",
  "apiPort": 3001,
  "apiUid": 1002,
  "apiGid": 1002,
  "resourcePrefix": "chisabot-dsh",
  "networkPool": "10.250.0.0/24",
  "runtimeMemory": "512m",
  "runtimeCpus": 1
}
```

`networkPool` 是本机预留、与已有 Docker 网络及宿主路由不重叠的私有 IPv4 网段；部署前根据实际网络选择，示例值不是自动探测结果。协调器从中逐个分配 `/29` 小子网，跳过已占用的 Docker 子网，避免每账号消耗 Docker 默认的大地址块。不配置时使用 Docker 默认池；默认池耗尽时应补配置，不删除其他项目网络或改动 Docker 全局设置。

运行一次：

```sh
node deploy/dsh/accounts.mjs reconcile /etc/chisabot/dsh-accounts.json
```

协调器通过 API 原有环境读取账号 ID 清单，不导出数据库连接。为每个账号创建一个只包含 API 与该 Host 的桥接网络；API 在各网络中的别名为 `chisabot-api`。Host 不发布宿主端口，仍可访问配置的模型服务。Host 根文件系统只读、去除 capabilities、禁止新权限，内存与进程数受限，只写自己的会话卷。

Host 使用 `NARB_DISABLE_NATIVE_CACHE=1`，由上游原生加载器直接加载镜像内固定的 `.node` 文件。默认加载器会把文件复制到临时目录再加载，而容器的 `/tmp` 为不可执行的 tmpfs；直接加载无需放宽根文件系统或临时目录权限。

每次启动时从唯一的账号网络接口读取具体 IPv4 地址作为监听地址，并只信任该地址和账号容器名。DSH 不支持 `0.0.0.0` 通配监听；重建或重启后的地址变化由启动过程重新读取，API 连接文件使用稳定的账号容器 DNS 名。

输出只有 `ready`、`preparing` 和 `updateRequired` 计数。通过认证健康检查后，连接文件和完整索引以 rename 发布。API 每次解析账号时读取新索引，所以新账号无需重启 API。账号 ID 不进入容器名；重用资源时核对完整 owner 标签，禁止覆盖名称冲突的资源。

## 新账号自动开通

把脚本放到 `/opt/chisabot-updater/accounts.mjs`，复制 `accounts.service` 与 `accounts.timer` 为 `chisabot-dsh-accounts.service` / `.timer`；根据宿主 Node 的实际路径调整 service 的 `ExecStart`。运行 `systemctl enable --now chisabot-dsh-accounts.timer`。每次运行完成后约 30 秒再检查一次账号清单。

协调器不会删除已不在清单里的容器或卷。删除账号的会话存储属于数据保留操作，另行按部署规则处理。索引只保留当前账号，旧账号不能继续使用已移除的映射。

## 更新镜像时先暂停和排空

日常协调不会替换镜像不同的现有 Host，只报告 `updateRequired`。这避免在用户执行途中更新内核。

使用现有维护入口创建 `.maintenance` 并等待活动执行结束，备份每个账号卷与同批次 PostgreSQL：

```sh
node deploy/dsh/accounts.mjs snapshot /etc/chisabot/dsh-accounts.json /var/backups/chisabot/account-cutover-001
```

目标备份目录必须不存在。协调器核对全部账号映射、DSH Session 状态、产品 lease 和正在派发的外部操作，再保存每个账号卷、PostgreSQL dump 和账号卷清单。清单包含实际 Host 镜像、会话绑定、每个 Session 的源游标与产品投影游标，用于核对同一批备份的关系。失败会保留不完整目录供诊断，但不会写入成功清单；不要用未完成的目录恢复。备份目录为 `0700`，包含私密会话，按部署备份政策转存。

随后更新配置中的 image 并运行：

```sh
node deploy/dsh/accounts.mjs reconcile /etc/chisabot/dsh-accounts.json --replace
```

`--replace` 要求维护标记存在、Host 没有活动 Session、两个镜像的历史读取器兼容。只停止和替换带匹配 owner 标签的容器，会话卷保留；完成后重新发布连接文件。验证历史和待决对象后，再解除维护标记。

在线更新器配置 `CHISABOT_DSH_ACCOUNTS_CONFIG` 为上述宿主配置的绝对路径，并通过 `CHISABOT_DSH_NODE` 指定 Node 24。更新器会在同一维护窗口调用账号快照、保留 API 的附件卷，然后更新 API 和账号 Host，完成就绪检查后才恢复接纳。外部 targets 未配置协调器时，更新器会拒绝发布。镜像回滚同样保留当前数据库和账号卷，不导入更新前的旧数据。具体接线见 [DSH 运行时部署](dsh-runtime.md)。

## 隔离验收

在一次性环境准备两个账号，检查：容器只挂载各自卷、无 Docker socket/DB 环境，两个容器不共用 bridge，分别通过对应连接文件读取正确 owner。两个账号建立 Session 后，停止 A 的 run 不影响 B；A 的 capability 不能支出 B 的工具。重建 API 后再次运行协调器，应重新接入各自网络并保留 Session。最后增加第三个账号，确认 timer 发布映射后原 API 进程即可接纳。

只在完整镜像和实际 Docker 网络上完成这些检查，才能把容器配置记为已验收。
