# ADR-0014：云端工作区 + Claude Code + 电脑同步

- 状态：已作废（2026-10-26，CB-099）
- 日期：2026-10-15
- 相关：docs/cloud-claude-code.md（已删除）、DESIGN.md §73、BACKLOG CB-061…CB-065、ADR-0001（左栏只有机器人，本 ADR 修订）、ADR-0003（云端 agent + 设备节点）、ADR-0010（本地 agent）、ADR-0013（只有一套聊天）

## 作废说明（2026-10-26，CB-099）

整个「Claude Code 工作区」功能已经从产品里删掉：`/cc` 视图、左栏的「机器人｜Claude Code」切换、设置 → 云端工作区、
云端工作区节点（`deploy/cloud-node/`）、电脑文件夹同步（server `cloud-cc/sync.ts`、`pc/src/sync`、`/agent/sync*`），以及
Claude 上游代理（`shared/proxy-links.ts`）。

原因：这个功能维护成本高（单独的节点容器、同步边车、Mutagen 组件、Claude 登录和代理），但用的人很少；它和产品主线
（机器人 + 本地 agent）也是两套界面。删掉以后左栏回到 ADR-0001：只有机器人列表。

保留：本地 agent（ADR-0010）的 `claude` 类型、`pc/src/agent-runtime`，以及规划模型用的 `CLAUDE_CODE_OAUTH_TOKEN`，这些都不属于本 ADR。
数据库里的 `chisabot_cloud_workspaces` 和 `chisabot_cc_*` 表没有 drop，只是不再使用（见 CB-099 PR 说明）。

下面是原来的决定，保留作记录。

## 背景

用户 2026-10-15 14:49：在 ChisaBot 的云端集成 Claude Code——网页上登录 Claude、和它对话、直接用它开发；15:44–15:56 定了入口、
工作区来源、云端是主副本、按工作区开关的电脑同步；17:01「这个功能推进吧」，§11 的三个待定问题按设计稿建议定。

已有的本地 agent（ADR-0010）是「机器人把一件活交给电脑上的 Claude Code」：一次性任务、结果回到机器人对话。这次要的是
「直接和 Claude Code 对话」：会话长期存在、隔天接着说、电脑关机也能接着写，项目平时放在云端。

## 决定

1. **云端工作区节点**：服务器旁边一个独立容器（`deploy/cloud-node/`），里面是 Claude Code CLI 和 `chisabot-node`，以普通设备身份配对
   （设备列表里叫「云端工作区」）。非 root（uid 1000）、`cap_drop ALL`、`no-new-privileges`、根文件系统只读、不挂 docker.sock、
   不用 host 网络、配对时 `--no-full-access`（永远不能开完全访问）。独占一个网桥，防火墙丢弃它发往私有网段和主机的流量，
   连 ChisaBot 也走公网地址。主机上不开新端口。
2. **Claude 账号**：用户在 设置 → 云端工作区 用自己的 Claude 订阅单独登录一次（打开授权页 → 复制授权码 → 粘回来）。凭据只在节点的
   home 卷里（600），授权码和令牌不进数据库、不进日志。不复制别处已登录的凭据（刷新令牌会轮换）。
3. **入口：左栏顶部切换「机器人｜Claude Code」**。修订 ADR-0001：左栏可以在两种内容之间切换；「机器人」那边仍然只放机器人、
   不列对话。「Claude Code」那边是工作区 → 会话的树，布局仿照 Claude Code 桌面版（左：工作区和会话，中：对话，右：可收起的
   文件 / 改动；手机上右栏是底部抽屉）。只有管理员能看到。
4. **会话 = 一个 Claude 会话 + 一个持久工作目录**。每一轮在节点上跑 `claude -p --output-format stream-json`，`--resume` 接着上次。
   会话的记录存在 ChisaBot 自己的表（`chisabot_cc_messages`），**不是**机器人聊天线程：ADR-0013 说的是机器人聊天只有一条路，
   Claude Code 会话不经过机器人的模型循环，所以单独存；界面复用聊天的展示组件（流式 Markdown、干活行、审批卡、改动卡）。
5. **权限**：PreToolUse 钩子就是节点程序自己（`chisabot-node cc-hook`）。只读操作和会话目录里的编辑直接放行；其他命令弹审批卡，
   可以选「本会话总是允许这条命令」；`git push`、`gh`、改 remote、`ssh`、`sudo`、改 `~/.claude` 一律拒绝（推送只走「推送并开 PR」）；
   不开 bypass。2 分钟没人处理按拒绝。
6. **云端是主副本**：每个工作区在云端都有一份；电脑上的文件夹只能从 ChisaBot PC 客户端选，同步按工作区开关，冲突从不静默覆盖
   （交接、租约、对比，见 docs/cloud-claude-code.md §4）。
7. **§11 的三个问题按建议**：会话改动手动「合入工作目录」；电脑同步先只做 Windows；右栏只读。
8. **许可边界**：ChisaCloudCode 桌面端 `app/*.go` 是作者本人写的，可以移入（逐文件确认来源后，以 MIT 发布）；ChisaCloudCode 里
   CloudCLI UI 派生的代码（AGPL）只看思路、不复制。Mutagen 自己编译、不加 `--sspl`，只含 MIT 代码。

## 后果

- 好处：网页 / 手机上直接让 Claude Code 写代码，电脑关机也能跑；和机器人聊天互不干扰；节点碰不到数据库、保险箱和其他容器。
- 代价：多一个手工部署的容器（不归 updater 管）；Claude 订阅要在节点上单独登录一次；会话记录和机器人聊天是两套存储。
- 「草稿」工作区（内置、只在云端、没有 Git 远端）里每个会话用自己的目录（`trees/<会话>`），互不影响；Git 工作区（P3）每个会话一个
  worktree + `cc/…` 分支；电脑文件夹的非 Git 工作区（P4）按设计稿 §3.2.6 共用工作目录、同一时间一个会话写。
- 回滚：表全是 `CREATE TABLE IF NOT EXISTS`，旧镜像忽略它们；节点容器可以单独停掉，ChisaBot 其余功能不受影响。
- 以后重新考虑：要给朋友账号用时（现在只有管理员）；要接 API Key 计费时；ChisaCloudCode 留还是下线（P5，动之前问用户）。

## 考虑过的其他方案

- 做一个「Claude Code」机器人放进左栏：v1 设计；用户要更像 Claude Code 桌面版的独立视图（v2）。
- 会话记录存成机器人聊天线程（thread kind `claude_code`）：要伪造一个机器人、走 CopilotKit runtime 的整套 agent 解析和权限；
  Claude Code 的事件（工具、审批、改动）和机器人消息结构不同。单独存更简单，展示组件照样复用。
- 直接复用 ChisaCloudCode：root + docker.sock + bypass，且 UI 是 AGPL 派生，不能进 MIT 仓库。
