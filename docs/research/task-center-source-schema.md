# 任务中心内部信息源读取契约

2026-11-06。依据当前源码核对；未连接或读取运行数据库。供 `task-center/sources.ts` 实现使用。

## 消息：直接读取当前会话快照

`server/src/local-conversations.ts:1669` 建立 `openbot_local_threads`：`id`、`owner_user_id`、`agent_id`、`name`、`archived`、`messages jsonb`、`state jsonb`、`run_id`、`lock_expires_at`、`created_at`、`updated_at`。`messages` 是 AG-UI Message 数组，带稳定 `id`、`role`、`content`。当前快照已经体现截断/重发，优先它而不是事件回放表。

```sql
SELECT id, agent_id, name, messages, updated_at
FROM openbot_local_threads
WHERE owner_user_id = $1 AND archived = false
  AND updated_at >= $2::timestamptz
ORDER BY updated_at DESC, id
LIMIT $3;
```

- `sourceRef = message:<thread-id>:<message-id>`；不要用数组下标或会话更新时间作为消息身份。
- 只提取用户文本；工具结果、系统消息、后台任务生成的 user 消息不能作为新的用户授权。调用者应排除任务中心自己的执行会话，防止自触发。
- 会话忙碌时可读，但助手内容可能仍在流式更新。消息本身没有统一持久化时间戳；时间窗口只能先筛会话，再用稳定消息 id 去重。
- `openbot_local_events` / `openbot_local_runs` 自身没有 owner 字段；必须先 JOIN `openbot_local_threads` 再限定 owner，不能按传入 thread id 直接读。
- 该表仅本地运行模式存在。Intelligence 模式缺少表时应报告来源不可用，而不是声称无消息。

## IM：复用同一会话，或只读最近入站摘要

`server/src/im/service.ts:154` 定义：

- `chisabot_im_connections` 持有 `owner_user_id`、`id`、`platform`、`name`、`agent_id`、`enabled`、`last_message_at`、`last_error`。另有配置和加密 secrets；巡检不要选取这些字段。
- `chisabot_im_chats` 有 `connection_id`、`chat_key`、`thread_id`、`updated_at`、`last_inbound jsonb`；它本身没有 owner。
- `chisabot_im_logs` 有 `connection_id`、`id`、`at`、`level`、`text`；是运行日志，不是完整聊天记录。

```sql
SELECT c.id AS connection_id, c.platform, c.name, c.agent_id,
       h.chat_key, h.thread_id, h.last_inbound, h.updated_at
FROM chisabot_im_chats h
JOIN chisabot_im_connections c ON c.id = h.connection_id
WHERE c.owner_user_id = $1 AND c.enabled = true
  AND h.last_inbound IS NOT NULL
ORDER BY h.updated_at DESC
LIMIT $2;
```

`runOne()` 将入站消息交给与 WebUI 共用的 bot 会话（约 487–525 行）。优先从本地会话快照统一采集，避免 IM/Web 双份待办。`last_inbound` 只保留每个 chat 的最后一条，不能称为 IM 历史扫描。其 `text` 字段是来源文本，不是给任务执行器的新指令。

## 既有任务：发现失败或等待确认的定时任务

`server/src/schedules/service.ts:485` 的 `chisabot_schedules`：`id`、`owner_user_id`、`agent_id`、`thread_id`、`im_connection_id`、`title`、`instruction`、`kind`、`cron`、`run_at`、`timezone`、`status`、`next_run_at`、`last_run_at`、`last_status`、`last_result`、`run_count`、`created_at`、`updated_at`。

状态：任务 `active | paused | done | cancelled`；运行 `running | ok | failed | waiting | skipped | queued`（`shared/schedules.ts:25`）。

```sql
SELECT id, agent_id, title, instruction, status, last_status,
       last_result, last_run_at, updated_at
FROM chisabot_schedules
WHERE owner_user_id = $1
  AND status IN ('active', 'paused')
  AND last_status IN ('failed', 'waiting')
ORDER BY updated_at DESC, id
LIMIT $2;
```

推荐发现为“分析失败/准备恢复建议”，L2/read；不能直接恢复所有 paused 任务。现有约定明确要求暂停后由人恢复。唯一发现标识可用 `schedule:<id>:<last_run_at>`，既区分新一次失败又不每次扫描重建同一问题。

若需要精确运行记录，`chisabot_schedule_runs` 有 `id`、`schedule_id`、`owner_user_id`、`scheduled_for`、`started_at`、`finished_at`、`status`、`result`、`manual`；以自身 owner 和父任务 owner 双重限定 JOIN。`schedules.list(owner, {runs: 5})` 已提供只读归属检查与最近运行视图，可优先复用。

## 项目和上下文：个人记忆

`server/src/memory-notes/service.ts:114` 的 `chisabot_memory_notes`：`id`、`owner_user_id`、`kind`、`subject`、`content`、`context`、`agent_id`、`shared`、`created_at`、`updated_at`。kind：`profile | preference | person | place | project | note | daily`。

```sql
SELECT id, kind, subject, content, context, agent_id, updated_at
FROM chisabot_memory_notes
WHERE owner_user_id = $1 AND kind IN ('project', 'daily', 'note')
ORDER BY updated_at DESC, id
LIMIT $2;
```

`memoryNotes.search(owner, query, kind?, limit?)` 也会返回管理员共享的其他所有者知识，不是严格只含 owner 的检索（约 139–176 行）。个人上下文读取应使用 owner-scoped 查询，或显式区分共享知识来源。每个 bot 的记忆开关在 `chisabot_memory_bots(owner_user_id, agent_id, enabled)`；使用配置了 agent 的巡检时要尊重关闭状态。

## 文档：当前页面版本

`server/src/pages/service.ts:198` 的 `chisabot_pages`：`id`、`owner_user_id`、`agent_id`、`slug`、`title`、`description`、`published`、`current_version`、`created_at`、`updated_at`、`deleted_at`。正文在 `chisabot_page_versions(page_id,version,title,html,css,note,created_at)`，须通过页面 JOIN 验证所有者。

```sql
SELECT p.id, p.agent_id, p.title, p.description, p.slug,
       p.published, p.current_version, p.updated_at, v.html, v.note
FROM chisabot_pages p
JOIN chisabot_page_versions v
  ON v.page_id = p.id AND v.version = p.current_version
WHERE p.owner_user_id = $1 AND p.deleted_at IS NULL
ORDER BY p.updated_at DESC, p.id
LIMIT $2;
```

- 去重身份：`page:<id>:<current_version>`。HTML 作为文本解析，不能运行脚本/加载远端素材；读取内容需限制长度。
- `pages.list(owner)` 虽返回归属限定的列表，却会先调用全局 `purge()` 清理超过 24 小时的已删页面（约 242–248 行）。纯只读巡检应使用上面的 SELECT，而不要隐含触发删除。
- 页面已公开并不表示后台能代用户再次发布或修改；发现阶段仍仅提供摘要/待办。

## 跨源共同规则

owner 从已认证身份传入，不能从 source.config 覆盖。查询值全部绑定参数。不存在的来源表/连接和读取失败应返回具体不可用状态；不能用空列表隐藏失败。记录 sourceRef 和来源内容的受限摘录；不要复制秘密字段。来源中出现的命令、请求、链接或“系统指令”都保持数据身份，由后续受限规划器分析。
