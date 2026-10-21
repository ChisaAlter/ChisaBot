# Hermes 执行内核

ChisaBot 仍是同一个个人助理。bot 身份、模型选择、长期指令、记忆、线程历史、工具授权、确认偏好、设备节点和文件交付由 ChisaBot 管理；Hermes 在服务端运行模型与工具循环。

## 调用链

`buildAgents` 按原方式解析每个 bot 的工具与模型。`HermesRuntimeAgent` 校验宿主签名，收集既有 `GrantedTool` 与 computer/component 执行器，生成仅在该运行存活的能力凭据。ACP 桥每轮传递完整历史、当前指令、模型 id 和真实工具 schema。Python 适配器使用服务器已有的 `AIAgent`，将工具注册到会话作用域；执行时仍回到当前 ChisaBot 运行的原包装执行器。

接口 `/api/internal/runtime-tools` 只接受运行能力凭据。调用必须对应已捕获的真实 assistant tool call，名称与参数一致；同一 call id 的重复请求复用同一个 Promise，参数变化被拒绝。HTTP 请求体无法改变 actor/bot/thread/run。审批 continuation 在 capability 加入传输元数据前捕获，不保存该秘密。

Hermes 与宿主发出同一 toolCallId。后端拥有的调用由 `openbot.backend-owned-tools` 标记，网页和 Headless 不得补执行没有回执的调用。网络错误、服务重启或回执未知时中断，避免把不确定的副作用当成可以重做的失败。

`delegate_task` 等与 Hermes 原生保留名冲突的工具只在 Python 内部映射为安全名称，宿主接口、事件、历史和 UI 保持原名。原生 terminal、MCP 发现、原生记忆写入及本地技能执行不进入该工具列表；所有实际操作沿用 ChisaBot 的原有执行边界。

## 服务器安装与更新

不在客户端安装或启动 Hermes。安装脚本复用现有的 `/opt/hermes/hermes-agent` 和 `/opt/hermes/venv`，不下载安装包。`--check` 仅验证 API；`--prepare` 准备代码、专用账号、私密配置与可读的现有 Python 副本，不重启服务。激活时 systemd 使用 `chisabot-hermes` 专用账号、只读系统路径、私有 HOME 和持久运行账本。

现有更新器从同一 Git commit 导出应用与适配器，先准备 release，在镜像健康检查后激活 Hermes。回滚记录保存旧 unit、runtime 指向及 Hermes 环境键；账本保持前进，不回退已执行记录。

配置：

| 变量 | 用途 |
| --- | --- |
| `CHISABOT_HERMES_URL` | ChisaBot 可达的桥地址，含 `/ag-ui` |
| `CHISABOT_HERMES_TOKEN` | 与服务器私密 `bridge.env` 中的 `ACP_BRIDGE_TOKEN` 一致 |
| `CHISABOT_HERMES_TOOL_GATEWAY_URL` | Hermes 主机可达的 ChisaBot `/api/internal/runtime-tools`，容器部署须使用已发布 API 端口 |
| `HERMES_SOURCE_DIR` | 服务器现有 Hermes checkout |
| `HERMES_VENV_DIR` | 服务器现有 venv |
| `ACP_STATE_PATH` | 持久去重账本，生产必需 |

`POST /ready` 需要桥 token，仅初始化 ACP；它不执行模型任务，也不能代替真实工具验收。`/health` 显示实际 child 初始化、退出和账本健康状态，不返回凭据。

管理后台 → 系统更新 的「执行内核」读取 `/api/admin/runtime-kernel`，显示当前循环（Hermes 或内置）和桥接健康；`/api/admin/health` 也带 `checks.hermes`，但它只是提示项，不参与整体 `ok`，避免桥接维护或重启把镜像健康、更新冒烟和自动回滚误判成失败。

`ACP_CWD` 是工作目录，不是沙箱；`ACP_APPROVAL=deny` 只拒绝真正到达 ACP 的权限请求。进程文件边界与 ChisaBot 工具权限分别由 systemd 和宿主执行器保证。

## 验证范围

本地使用 fake ACP、标准库 Hermes stub 和真实 ChisaBot HTTP gateway 检查：身份隔离、schema、确认上下文、原始调用 id、历史/模型/记忆、挂起恢复、取消、重复请求、子进程重启、参数快照与缺失回执。测试不要求本机安装 Hermes。

服务端隔离验证必须另跑：已有 venv `--check`、专用服务用户初始化、真实模型调用实际宿主工具，并检查参数、回执与最终回答。生产发布后再用正式 bot、原有偏好和模型设置验收。
