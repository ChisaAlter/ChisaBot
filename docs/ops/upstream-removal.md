# 升级到自有 Conversation 命名

本次清理删除聊天中的上游推广横幅、销售链接和相关配置，现役会话接口、模块、协议与新部署资源统一使用 ChisaBot 命名。实现与验收状态见[个人助理实施记录](../pipeline-runs/20261108-assistant-production.md)；清理后的 reader 4 候选已接入私人入口，未切换生产。

## 更新会话表时保留原数据

迁移 `0067_conversation_namespace` 将三张表原地改名：

| 原表 | 当前表 |
|---|---|
| `openbot_local_threads` | `chisabot_local_threads` |
| `openbot_local_runs` | `chisabot_local_runs` |
| `openbot_local_events` | `chisabot_local_events` |

迁移同步约束、索引和事件序列名称，保留表对象、记录、外键、原始消息和待决输入；不创建空库替换历史。旧迁移及旧快照继续保留，以便新安装完整重放迁移。若两代同名用途的表同时存在，迁移会拒绝猜选，需要先核对数据来源。

产品 reader 升为 **4**，可从 1、2、3 升级；升级后禁止用 reader 1–3 镜像读取该数据库。更新器在候选启动、可能执行迁移之前，先持久保存最低 reader 要求；即使随后健康检查失败，旧进程的快照和健康检查也不能降低该要求，回滚及账号替换仍须满足 reader 4。

部署本次迁移前，先安装随版本提供的宿主更新器 helper，并保留 reader 4 兼容恢复镜像。若迁移后的候选不健康，保持新执行暂停，使用兼容镜像恢复。发布仍沿串行更新器，在备份、排空与隔离升级验收完成后执行。

## 原安装的登录、草稿和设备继续使用

新客户端主动请求 `/api/conversations`。旧 `/api/copilotkit` URL 只在服务端集中适配入口转换，仍经过相同的账号鉴权与权限检查。旧保存事件、签名续执行输入和未知效果记录只在读取边界转换，不改写原历史或重新产生效果。

认证网关改用当前产品 Cookie 和 `chisabotAuthRequired`。旧 Cookie 的读取、续期和撤销集中在认证兼容模块；旧桌面收到的登录失效响应仍可正常跳转。登录 Cookie 迁移后，回退核心服务时仍需使用支持两代 Cookie 的认证网关及当前会话库；直接恢复只识别旧 Cookie 的网关会让已迁移的客户端失去登录。旧浏览器主题、草稿和设置在首次读取前迁移，已有的新设置优先。

已安装 Agent 的旧 header 和环境变量只在 `shared/legacy-headers.ts`、`shared/legacy-compat.ts` 读取。发送给旧 Agent 的必要双 header 也集中于该模块；业务代码使用当前名称。

## 现有卷和数据库身份不能按名字重建

新部署默认使用 `chisabot` 卷、网络和内置数据库身份。已有部署仍需挂载原来的物理资源。`deploy/start.sh`、更新器与安装入口会调用 `deploy/legacy-resources.sh`，把运行中容器的真实挂载和网络固定到部署配置；无运行容器时识别旧资源，并在新旧数据库卷同时存在时要求明确选择。

使用原入口启动或更新。若必须直接调用 Compose，先在部署目录执行以下兼容准备，再使用原 `.env` 和 Compose 命令：

```sh
. ./legacy-resources.sh
pin_existing_resources .env chisabot-zh
```

内置 PG 的身份标记保存在原数据库卷。已有集群保留原角色和数据库，新集群才采用当前名称。发布前的排空检查通过集中 schema 适配读取旧表，迁移后改读新表；不得先把维护脚本中的 SQL 改为新表再去排空尚未升级的实例。

## 依赖使用现有独立协议入口

项目已移除直接 CopilotKit 依赖。官方 `@ag-ui/mastra` 的主入口继续承担 Mastra 协议转换；它不加载单独的 CopilotKit 集成入口。开发、CI 和 Docker 安装统一使用 `--omit=peer`，实际干净安装中没有 CopilotKit 包。Bun 锁文件仍记录官方包声明的可选 peer 解析元数据；这些记录不进入安装产物。

AG-UI、MCP、DSH 和现有界面组件继续使用。必要的来源与许可证见项目 [LICENSE](../../LICENSE) 和 [README](../../README.md)；历史迁移、研究资料及已有用户消息中的原名称不作为运行时依赖，也不因产品清理而删除。
