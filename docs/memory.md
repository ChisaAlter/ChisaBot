# 长期记忆（ChisaBot）

机器人跨对话、跨机器人记住关于你的事。设计见 DESIGN.md §50。

## 记什么

- 个人资料：称呼、所在城市、职业、生日、过敏 / 饮食要求等。
- 偏好：连同它成立的情境（「工作日在公司午饭」）。
- 人物、地点、项目与事项：同名只有一条，新内容并进去。
- 日志：一天一条，机器人做完有后续的事时写一句。

## 怎么用

- 对机器人说「记住……」「你记得我什么」「忘掉……」。
- 设置 → 记忆：查看、搜索、添加、编辑、删除（8 秒内可撤销）；按机器人关闭记忆。

## 接口

- `GET /api/memory-notes?q=&kind=` → `{ notes, bots }`
- `POST /api/memory-notes` `{ kind, subject?, content, context? }`
- `PATCH /api/memory-notes/:id`、`DELETE /api/memory-notes/:id`、`POST /api/memory-notes/forget { ids }`
- `PUT /api/memory-notes/bots/:agentId { enabled }`

## 存储

表 `chisabot_memory_notes`、`chisabot_memory_bots`（服务启动时自动建）。删除是真删。回滚到旧版本不影响这两张表。
