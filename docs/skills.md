# 技能（ChisaBot）

设计见 DESIGN.md §51。

- 技能 = 「某类事怎么做」的说明（Markdown）。存在 `skills` 表，和聊天框的 `/名字` 是同一份。
- 机器人每轮看到目录，需要时 `skill_load`；用户同意后可以 `skill_save` / `skill_edit` 存或改用户自己的技能。
- 设置 → 技能：新建、编辑、删除（8 秒内可撤销）；共享技能只读（管理员在「技能管理」里维护）。

## 接口

- `GET /api/chisa-skills` → `{ skills: [{ slug, title, summary, instructions, mine }] }`
- `PUT /api/chisa-skills/:slug` `{ title, summary, instructions, create? }`（只能写自己的；名字被占用 409）
- `DELETE /api/chisa-skills/:slug`（只能删自己的）
