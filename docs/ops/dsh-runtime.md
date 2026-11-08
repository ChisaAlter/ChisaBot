# DSH 部署、更新与回滚

部署候选同时包含 ChisaBot、独立 Node 进程运行的 DSH Host、插件和兼容历史读取器。先在隔离环境验证完整镜像，再由现有宿主更新器串行发布。首次启用 DSH 前先保留一份能读取 DSH 数据的兼容镜像；产生新对话后，完全不认识 DSH 的旧镜像不能再作为回滚目标。

## 持久卷随容器重建保留

`deploy/compose.yaml` 新增 `/var/lib/chisabot-dsh`，物理卷默认名为 `openbot-zh_dsh`。原数据库、workspace、profiles 的卷名和网络保持原值。不要用 `docker compose down -v` 更新或回滚。

API 启动脚本先建立 DSH 根目录并设为 `apiuser` 所有、权限 `0700`，然后降权运行。每个账号的目录由 managed runtime 建立；不要把整个卷改成所有人可读。恢复时保留数字 uid/gid（默认 API 为 1002），原账号子目录不会由启动脚本递归改权限。

`CHISABOT_AGENT_KERNEL=dsh` 选择内核；`CHISABOT_DSH_ROOT` 指向持久卷。模型配置仍由 ChisaBot 管理。部署过程不写模型凭据，也不把 Host 的连接文件交给浏览器。

## 快速更新与完整构建

完整构建使用固定 Node 24.18.1 和 `runtime/dsh/package-lock.json` 安装 DSH。镜像构建时验证实际包版本与 manifest 相同，并生成 `/app/deploy/dsh/runtime-compat.json`，记录协议、运行时版本和历史读取器。

只改应用或插件源码时，快速更新先移除旧 `runtime/dsh/src`，再复制新源码；移除的插件文件不会残留在底座。DSH manifest/lockfile、Dockerfile、s6 脚本变化进入依赖指纹，必须完整构建。Bun 与 DSH 的 npm 安装树保持独立。

`deploy/Dockerfile.update`、`deploy/Dockerfile.glass` 只用于依赖相同且已经包含 DSH 的底座。首次迁移使用完整 Dockerfile 或 `deploy/Dockerfile.zh`；不要拿不含 DSH 的旧底座做源码覆盖。

更新器自身必须先安装本次脚本，包括 `dsh-release.sh`、`reader-compatibility.mjs` 和账号协调器；旧更新器不会识别新卷的备份和读取器检查。升级脚本不等于启动切流。

已有 DSH 部署更新时，先核对目标源码包含 DSH 运行时及发布工具，再构建候选；构建后的 `runtime-compat.json` 必须与当前 DSH 协议、运行时和 native history reader 相同，且产品 `conversationReader` 不低于当前版本，随后才暂停接纳、备份和切换。缺少 DSH 的旧 `main` 不会触发切流。兼容性检查通过也不代替候选的功能和恢复验收。

更新备份带 `backup-manifest.json`，只有更新器自己登记且已完成的 `kind:update` 批次参加 `KEEP_BACKUPS` 轮换。没有标记的手工/历史备份、未完成批次和带 `.keep` 的目录保留；符号链接不被清理。旧备份不会自动改成可删除批次。`KEEP_IMAGES` 至少保留三个不同的自动构建镜像身份，当前、上一版、底座和手工标签继续保护。

## 检查运行时，不调用模型

宿主更新器 `health.sh` 在 `/health` 之后执行 DSH readiness，回滚也执行。检查使用容器内 API 的环境和 uid，不依赖浏览器登录：

```sh
docker exec -e PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$CONTAINER" /command/with-contenv /command/s6-setuidgid apiuser \
  /usr/local/bin/bun /app/deploy/dsh/ops.ts health
```

它与产品健康检查复用 `runtime/dsh/src/readiness.mjs`，连接各已有绑定所属的 Host，验证 owner、插件协议、运行时版本及已绑定 Session 的日志读取。全新托管安装会打开一个没有模型请求的私有 probe Host，检查启动和持久目录写权限。输出只有计数和版本，不含账号、连接地址或 token。失败使发布失败，模型自检的告警规则不能覆盖这项失败。

## 切换前备份数据库与 DSH 日志

更新器在切换前创建 `CHISABOT_DSH_ROOT/.maintenance`，内容为当前 job ID。普通对话接纳及检查该标记的后台派发据此暂停，已有执行继续到可结算状态。标记不是全局模型断路器：既有活跃执行恢复、频道标题等模型消费者不全部受它阻挡。隔离验收仍须控制网络出口并核对可执行旧工作，不能仅凭标记断言“所有后台已关闭”。排空超时或状态不可读时保持旧镜像，不强制切换。

排空后，`backups/<批次>/cutover/` 保存：

- `chisabot.dump`：PostgreSQL 自定义格式备份，包含绑定、命令、工具操作账本、审批与展示历史。
- `dsh-volume.tgz`：完整 DSH 持久目录，不含部署暂停标记。
- `dsh-watermarks.json`：各 Session 的持久游标、展示事件最大序号和 runtime/reader 版本。
- `workspace-volume.tgz`、`profiles-volume.tgz`：文件产物与浏览器资料。

备份包含私密会话及凭据引用，应放在受限目录并按原部署的备份策略加密、转存。前置构建阶段的数据库快照只用于参考，配套恢复使用 `cutover` 同一批次。

`CHISABOT_DSH_TARGETS_FILE` 指向账号独立容器时，在宿主更新器的 `config.env` 配置协调器文件及宿主 Node：

```sh
CHISABOT_DSH_ACCOUNTS_CONFIG=/etc/chisabot/dsh-accounts.json
CHISABOT_DSH_NODE=/usr/local/bin/node
```

账号配置格式见[独立账号容器](dsh-accounts.md)。安装更新器时，`accounts.mjs` 和 `accounts-release.mjs` 一起复制到更新器目录。账号配置中的 API 容器及只读 targets 挂载必须属于当前部署。未配置协调器时，外部 targets 发布会在切换前失败，不能把 API 本地卷当成账号 Session 备份。

配置后，更新器在同一维护窗口调用 `accounts.mjs snapshot`，把每个账号卷、数据库、绑定与水位保存到 `cutover/accounts/`；workspace 和 profiles 继续保存在 `cutover/`。API 换到新镜像后、就绪检查之前，协调器以同一镜像执行 `reconcile --replace`，重新连接账号网络并保留账号卷。全部就绪后才原子更新宿主账号配置中的 `image`，其余配置字段保留。并发人工修改配置时停止并报告冲突。

账号容器部分替换失败会进入原有应用回滚流程，回滚镜像同样传给账号协调器。只有应用和所有账号运行时都通过检查才恢复接纳；失败则保留维护标记和当前数据，交由部署执行者核对后继续。

正常成功、切换前失败或成功回滚后，更新器只删除自己 job ID 的暂停标记。切换后状态未确认，或宿主被强制杀死时，标记保留：先检查上一轮更新的镜像、账号容器、健康、活动执行和备份状态，再显式删除对应 `.maintenance`，不要通过重发原命令恢复。

## 每日完整实例备份

`deploy/updater/complete-backup.sh` 复用同一更新锁、维护标记、排空和 `dsh_snapshot`。它用于已经选择 DSH 的私人实例，不改变现有非 DSH 更新入口。运行期间会在排空后暂停 API、正在运行的内嵌 computer 服务与登录容器，保存一致数据，然后恢复原来运行的服务；排空失败不停止服务。它没有安装新的常驻进程。

在宿主 `config.env` 中配置：

```sh
CHISABOT_FULL_BACKUP_DIR=/opt/chisabot-backups/full
CHISABOT_BACKUP_KEEP_DAILY=7
CHISABOT_BACKUP_KEEP_WEEKLY=4
CHISABOT_BACKUP_MAX_AGE_HOURS=30
CHISABOT_BACKUP_AUTH_CONTAINER=chisabot-web-auth
CHISABOT_BACKUP_GATEWAY_CONTAINER=chisabot-public-gateway
CHISABOT_BACKUP_EXTRA_PATHS='["/etc/letsencrypt","/etc/chisabot"]'
```

`EXTRA_PATHS` 必须按当前 bind mount 配置填写：部署目录之外的证书、密钥或配置根需要覆盖。脚本在暂停服务前核对活动配置挂载是否都被包含；不完整就失败，不把缺失认证材料的备份标为完成。配置路径以参数传给归档工具，不拼成 shell 命令。备份目录权限为 `0700`，内含凭据的配置和容器清单不输出到日志。

一个完成批次包含：

- `cutover/`：既有 DSH 快照与 PostgreSQL 转储；external 模式继续使用 `cutover/accounts/` 下的账号卷、DB、绑定和水位。
- `workspace-volume.tgz`、`profiles-volume.tgz`、`auth-data.tgz`：工作文件、已关闭 browser 的持久资料、已停止登录服务的 SQLite 及 WAL 文件。
- `config/`：实际部署目录、显式额外配置路径、原路径清单、受限容器信息、更新器与账号运行时配置。
- `build-info.json`、`runtime-compat.json`、`backup-manifest.json`：运行版本、reader 及归档文件清单/大小/完成时间。

运行与独立状态检查：

```sh
bash /opt/chisabot-updater/complete-backup.sh
bash /opt/chisabot-updater/complete-backup.sh --status
bash /opt/chisabot-updater/complete-backup.sh --status --require-offsite
```

`--status` 不访问业务 API，检查最近完成批次、归档是否仍存在且大小一致、年龄是否超过默认 30 小时；输出 `local` 和 `offsite`，不输出私密路径。只有本地副本时 `offsite:missing`；指定 `--require-offsite` 后将返回非零。已配置异地传输时状态检查自动要求异地回执。该状态证明备份文件可定位，真正可恢复仍由隔离恢复演练建立。

已有 `chisabot-db-backup.timer` 可保持原执行时间，由维护者为其 service 增加 drop-in，将 `ExecStart` 替换为上述入口；不要同时启用旧数据库脚本和另一套同时间备份。首次手动备份与恢复验证成功后，再切换既有 timer。安装更新器本身不自动创建/修改定时任务。

例：已有单元名确为 `chisabot-db-backup.service` 时，其 drop-in 内容为：

```ini
[Service]
ExecStart=
ExecStart=/bin/bash /opt/chisabot-updater/complete-backup.sh
```

默认轮换保留最近七个不同日期和四个不同周的完整快照；同一天多次运行不会挤掉全部日备份。`.keep`、未完成和未知目录仍保留。失败后的服务恢复由退出处理完成；服务或 DSH 恢复未确认时维护标记保留，不能仅因归档存在恢复接纳。

### 可选的加密异地副本

复用宿主已安装并已初始化的 Restic 仓库。`CHISABOT_BACKUP_RESTIC_ENV` 指向受限的私有环境文件，使用 Restic 原有的 `RESTIC_REPOSITORY`、`RESTIC_PASSWORD_FILE` 及对应后端凭据；不把凭据写入命令参数。只接受远程仓库类型，异机故障域仍须由部署方确认。此脚本不会安装 Restic、创建外部账户或初始化仓库。

传输在 API/登录/浏览器恢复后执行，成功保存 snapshot ID 回执；失败保留本地副本并返回失败。没有配置时明确显示缺少异地副本，不承诺 VPS 故障可恢复。Restic 的远端保留/清理继续由该仓库既有策略管理，完整备份脚本不自动 `forget` 其他快照。

### 用一个批次恢复

1. 选择 `state:complete` 且 reader 匹配的批次；异地恢复先用受限 Restic 凭据恢复该快照到独立暂存目录。保留当前实例的恢复材料。
2. 先在隔离环境恢复同批 PostgreSQL、账号 Session 卷、workspace/profiles、auth-data 与 `config/paths.json` 中的必要配置。保留数字 uid/gid，不对旧库自动 `--clean` 或覆盖生产。
3. 从归档版本启动应用和 DSH；恢复的外部账号连接文件可通过既有账号 reconcile 重建，不能把旧容器地址当成当前地址。认证配置必须与备份中的登录库和应用密钥匹配。
4. 验证登录、历史/附件、待批/暂停项、源水位和下一轮对话。未知外部效果继续待核对，不自动改成待发送；恢复不会撤销已经发生的外部动作。
5. 只有实际恢复结果合格，才在授权变更窗口采用该批次恢复生产。手工删除维护标记前先确认所属批次及应用/Host 健康。

## 回滚只切可读镜像，不倒退数据

现有 `rollback.sh` 和自动生成的回滚脚本在改 compose 前比较 DSH 读取器描述。已有 DSH 绑定时，目标缺少读取器、native 格式不同或产品读取器比当前旧，都会拒绝回滚。已登记的 `.dsh-reader.json` 让新容器无法启动时也能完成兼容性检查。

读取器描述同时包含 `conversationReader`，覆盖产品层数据：版本 1 包含附件与技能补话，版本 2 增加个人交付账本与任务成果要求；后续容量源码的版本 3 增加账号后台容量等待及恢复归属。目标镜像必须匹配 DSH 协议、运行时和日志版本，且产品读取器版本不低于当前版本。版本 2 开始接纳任务后，不能回滚至会忽略发送账本或成果要求的版本 1；版本 3 的持久容量等待也不能交给版本 2 恢复。旧 Hermes 镜像只可在尚未产生任何 DSH 绑定时恢复。

当前生产仍为 reader 1；`9244b43a` 的 reader 2 / 0065 镜像已完整构建，原镜像恢复和候选迁移、API 冷启动、DSH readiness 均通过，尚未发布。reader 3 / 0066 容量源码已完成 Bun 1.3.14 命名 prepare 协议错位的兼容修复：`createDatabase` 显式使用现成 `prepare:false` unnamed extended 模式，并完成标准 Drizzle JSON 映射、裸 Date 的 ISO 绑定及实际 PG 类型验证。原直连 API SIGKILL 混合恢复已通过，容量源码可进入候选装配；新的 reader 3 完整镜像及其迁移、恢复和发布验收仍待执行，不能提前升级线上 marker。最新状态见[实施记录](../pipeline-runs/20261108-assistant-production.md)。

通过检查后只恢复应用镜像和原运行时配置，继续挂载当前 PostgreSQL、DSH、workspace、profiles。不会自动导入发布前的数据库或会话备份，因此发布后新增的消息、审批、暂停输入、附件和已执行工具结果仍然保留。

需要灾难恢复时，先保持接纳和调度暂停，用匹配的应用/runtime 读取同批次快照，核对 Session 水位及工具账本。备份之后已经发生的外部效果仍然存在；未知操作必须先查询回执，不能自动重做。确认新旧历史、附件、审批和暂停输入均可读后再恢复派发。

## 发布验收

代码接线通过后，仍须由发布执行者验证完整镜像的非 root 启动、卷重建、三轮对话、后台调用以及一次真实切换/回滚。回滚后的历史必须包含切换后新建的回答、工具结果、审批、暂停补话和附件。源码检查不代替这些运行证据。
