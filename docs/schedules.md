# 定时任务与提醒（ChisaBot）

设计见 DESIGN.md §55。

- 在对话里让机器人设：一次性（「明早 9 点提醒我…」「半小时后…」）或周期（每天 / 工作日 / 每周几 / 每月几号 / 每小时 / 每隔 N 分钟 / cron）。时间按用户时区，默认 Asia/Shanghai，最密每 15 分钟。
- 到点后在原来的对话里执行，结果作为机器人回复出现；来自 IM 的推回 IM。网页弹提示，后台时发浏览器通知。
- 服务器进程内每 15 秒扫描（`CHISABOT_SCHEDULES_SWEEP=0` 关掉）；比较交换保证同一时刻只触发一次。
- 周期任务停机晚了 30 分钟以上跳过这一次；一次性提醒晚 6 小时以内照发，更晚记为错过。

## 接口
- `GET /api/schedules` → `{ schedules }`（含最近 5 次运行）；`?all=1` 含更早结束的
- `GET /api/schedules/:id`
- `PATCH /api/schedules/:id` `{ title?, instruction?, paused?, timezone?, when? }`
- `POST /api/schedules/:id/run`（立即运行，202）、`POST /api/schedules/:id/skip`（跳过下一次）
- `DELETE /api/schedules/:id`
- `GET /api/schedules/events?after=ISO` → 之后跑完的运行（网页通知用）

## 机器人工具
`schedule_create`、`schedule_list`、`schedule_update`、`schedule_cancel`、`schedule_skip_next`、`schedule_run_now`。

## 表
`chisabot_schedules`（任务）、`chisabot_schedule_runs`（每次运行，每个任务留最近 50 次）；IM 会话表加了 `chisabot_im_chats.last_inbound`。全部开机 `CREATE … IF NOT EXISTS`，回滚安全（旧版本忽略这些表）。

## 失败诚实与暂停策略（Track B / v0.1.34）

- 回复按正文归类：`ok` / `waiting` / `failed` / `skipped`（见 `classifyScheduleReply`）。
- **连续 3 次硬失败** → 自动 `paused`（`next_run_at` 清空）。**从不自动 resume**；人手在设置页打开开关或 `paused=false` 才恢复。
- 卡死 `running` >20 分钟：扫表回收为 failed；同样计入连续失败，可触发自动暂停。
- 设置页分区：`needsAttention`（失败/等确认/运行中）· 孤儿（已删机器人）可一键清理（`partitionScheduleList`）。
- **电车类噪音定时（如「和 Claude 聊电车」）按产品策略保持 paused**，发版列车不 resume；本仓库自动化也不自动恢复任何 paused 任务。

