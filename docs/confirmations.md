# 确认卡片 + 审批偏好

设计与界面：DESIGN.md §58。代码：`server/src/confirmations/`、`shared/confirmations.ts`、`app/src/components/chat/confirm-card.tsx`、`app/src/routes/_authed/settings/approvals.tsx`。

## 数据

| 表                          | 内容                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `chisabot_confirm_prefs`    | 每人每类一行：`mode` ask / auto，`note` 用户原话                                                                                      |
| `chisabot_confirm_rules`    | 用户的规则：原话、类别、mode、关键词（jsonb）、来源 user / bot、哪个机器人记的                                                        |
| `chisabot_confirm_requests` | 每张卡片：对话、工具调用 id、类别、标题、对象、细节、状态、在哪决定、`external`（`device:<hub 审批 id>`）、`consumed_at`、24 小时过期 |

都在开机时 `CREATE TABLE IF NOT EXISTS`，回滚到旧镜像不受影响（旧代码不读这些表）。

## 接口（登录后）

- `GET /api/confirmations/prefs` → `{ prefs, rules }`；`PUT /api/confirmations/prefs/:category` `{ mode, note? }`（purchase 不能 auto）
- `POST /api/confirmations/rules` `{ text, category, mode, keywords? }`；`DELETE /api/confirmations/rules/:id`
- `GET /api/confirmations/requests?thread=…&limit=…`；`POST /api/confirmations/requests/:id` `{ decision: "approve" | "deny" }`

## 流程

1. 工具被 `wrap()` 包住 → `check()`：付款一律问；带关键词的规则（全部命中，ask 优先）；这一类的偏好；没设 = 问。
2. 要问：非网页回合直接拒绝（告诉用户去网页 / 改偏好）；同一段对话里有「后来才确认」且没用过的同一个操作 → 放行一次；否则写一行卡片、在服务器上等（每 0.7 秒看一次，10 分钟）。
3. 用户点确认 → 工具继续执行；取消 → 返回「用户取消了，不要绕过」；停止 → 卡片「已停止」。
4. 工具已经不等了才确认 → `setResume` 注入的函数往对话里发一条 `⟦chisabot:confirm:<id>⟧` 用户消息（正在回答就进收件箱，空闲就用 governedTurnRunner 起一轮，initiator `confirm:<id>` 算网页回合）。
5. 设备「询问」：hub 先问 `before()`（auto = 不弹窗）；要问就照旧在电脑上弹窗，网页回合里同时 `opened()` 写一张 `external=device:<id>` 的卡片；任一边决定 → hub `decideInternal` → `closed()` 更新卡片。
6. 云端浏览器：`confirmAwareGate` 包住上游 `approvalService.gate`，同一段对话 20 分钟内确认过付款（confirm_action purchase）就放行，其余交给上游。
7. 云端浏览器点按钮（`computer_click`）：`confirmAwareGate` 先调 `confirmations.pageAction`——按钮字是发送 / 删除类（`categoryOfPageAction`）且这段对话 10 分钟内没确认过同一类，就按偏好走 `check()`（出卡片、等确认）；被取消抛 `ApprovalRefusedError`，机器人收到中文原因。发起者（网页聊天 / 定时任务…）由 `headless-tools.ts` 用 `withConfirmActor` 带进来。
