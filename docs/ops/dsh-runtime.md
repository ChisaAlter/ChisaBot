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

更新器自身必须先安装本次脚本，包括 `dsh-release.sh`；旧更新器不会识别新卷的备份和读取器检查。升级脚本不等于启动切流。

## 检查运行时，不调用模型

宿主更新器 `health.sh` 在 `/health` 之后执行 DSH readiness，回滚也执行。检查使用容器内 API 的环境和 uid，不依赖浏览器登录：

```sh
docker exec -e PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  "$CONTAINER" /command/with-contenv /command/s6-setuidgid apiuser \
  /usr/local/bin/bun /app/deploy/dsh/ops.ts health
```

它连接各已有绑定所属的 Host，验证 owner、插件协议、运行时版本及已绑定 Session 的日志读取。全新托管安装会打开一个没有模型请求的私有 probe Host，检查启动和持久目录写权限。输出只有计数和版本，不含账号、连接地址或 token。失败使发布失败，模型自检的告警规则不能覆盖这项失败。

## 切换前备份数据库与 DSH 日志

更新器在切换前创建 `CHISABOT_DSH_ROOT/.maintenance`，内容为当前 job ID。服务端据此停止新执行接纳与后台派发，已有执行继续到可结算状态。排空超时或状态不可读时保持旧镜像，不强制切换。

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

## 回滚只切可读镜像，不倒退数据

现有 `rollback.sh` 和自动生成的回滚脚本在改 compose 前比较 DSH 读取器描述。已有 DSH 绑定时，目标缺少读取器或版本不匹配都会拒绝回滚。已登记的 `.dsh-reader.json` 让新容器无法启动时也能完成兼容性检查。

读取器描述同时包含 `conversationReader`，覆盖附件与技能补话等产品层数据。只支持相同 DSH 日志版本、但尚不支持这些补话的旧试验镜像也会被拒绝。首次正式切换保留已验收镜像作为兼容恢复基线；旧 Hermes 镜像只可在尚未产生任何 DSH 绑定时恢复。

通过检查后只恢复应用镜像和原运行时配置，继续挂载当前 PostgreSQL、DSH、workspace、profiles。不会自动导入发布前的数据库或会话备份，因此发布后新增的消息、审批、暂停输入、附件和已执行工具结果仍然保留。

需要灾难恢复时，先保持接纳和调度暂停，用匹配的应用/runtime 读取同批次快照，核对 Session 水位及工具账本。备份之后已经发生的外部效果仍然存在；未知操作必须先查询回执，不能自动重做。确认新旧历史、附件、审批和暂停输入均可读后再恢复派发。

## 发布验收

代码接线通过后，仍须由发布执行者验证完整镜像的非 root 启动、卷重建、三轮对话、后台调用以及一次真实切换/回滚。回滚后的历史必须包含切换后新建的回答、工具结果、审批、暂停补话和附件。源码检查不代替这些运行证据。
