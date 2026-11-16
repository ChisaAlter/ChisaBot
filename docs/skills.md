# 技能（ChisaBot）

设计见 DESIGN.md §51。

- 技能 = 「某类事怎么做」的说明（Markdown）。存在 PostgreSQL `skills` 表（由 `server/src/skills-chisa/tools.ts` 统一管理），和聊天框的 `/名字` 是同一份。
- 机器人每轮看到目录，需要时用 `skill_load` 加载；支持 `skill_save` / `skill_edit` 保存个人技能、`skill_install_hub` 安装精选预置技能、`skill_import_url` 从外部链接导入 `SKILL.md`（均经过供应链内容安全扫描与污点回合审批守卫）。
- 设置 → 技能：新建、编辑、导入、删除（8 秒内可撤销）；共享技能只读（管理员在「技能管理」里维护）。

## 接口

- `GET /api/chisa-skills` → `{ skills: [{ slug, title, summary, instructions, mine }] }`
- `PUT /api/chisa-skills/:slug` `{ title, summary, instructions, create? }`（只能写自己的；名字被占用 409）
- `POST /api/chisa-skills/import` / `POST /api/chisa-skills/hub`：导入或安装精选技能
- `DELETE /api/chisa-skills/:slug`（只能删自己的）
