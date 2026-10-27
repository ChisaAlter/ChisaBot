# 分支交接：多用户 / 多管理员 / 公共资源共享（feat/multi-user-unified-admin）

> 更新：2026-10-27。本文只写已核实的事实；路径均相对仓库根目录。

## 这条分支做了什么

| 编号 | 内容 | 主要位置 |
| --- | --- | --- |
| CB-096 | 账号角色（user/admin）、管理员直建账号、按角色发邀请、改角色、直接改密、「允许添加新成员」开关 | `deploy/public/auth/server.ts`、`app/src/routes/_authed/admin/accounts.tsx`、`app/src/lib/accounts.ts` |
| CB-097a | 公共知识库：管理员把记忆标为共享，全员可读，仅管理员可改 | `server/src/memory-notes/service.ts`、`shared/memory-notes.ts`、`app/src/routes/_authed/settings/memory.tsx` |
| CB-097b | 全局共享技能：管理员创建/导入/切换共享，成员只读 | `server/src/skills-chisa/tools.ts`、`server/src/plugins/store.ts`（`installSkill`）、`app/src/routes/_authed/settings/skills.tsx` |
| CB-097c | MCP「全员默认开启」 | `server/src/plugins/{store,routes}.ts`、`app/src/routes/_authed/admin/plugins/$key.tsx` |

## 本轮审查后修掉的问题

1. **共享技能静默失效**：`installSkill` 重写时保留原 owner，所以「把个人技能改成共享」和「全员共享安装全部」遇到同名个人技能时实际没变。现在 `installSkill` 有显式的 `claimOwner`，归属判定集中在 `resolveSkillOwner`（`server/src/skills-chisa/tools.ts`）；批量安装会返回 `skippedCount`，页面会如实提示；成员传 `shared` 得到 403。
2. **邀请默认值**：撤销了把网关邀请默认改成开启的改动，恢复为「默认关闭」（2026-10-15 的决定）。管理页新增「允许添加新成员」开关，新建账号 / 邀请不再悄悄把它打开；关闭时两个按钮置灰并提示。
3. **共享记忆挤掉自己的笔记**：自己的笔记与别人共享的公共知识库分开查询、各自限量（公共部分最多 200 条）；按 id 取笔记改为主键查询。
4. **MCP 全员授权**：开关结果缓存 5 秒（切换时立刻失效）；读取失败时沿用最近一次结果最多 5 分钟并写结构化日志，不再静默吞掉；对「全部成员共用一个部署凭据」的服务器拒绝开启（返回 409 和原因）；建表仍是运行时 `CREATE TABLE IF NOT EXISTS`，与 `chisabot_memory_notes` 一致。
5. 管理页里手绘的开关框换成标准 `PageRows`/`Item`；补上漏掉的 `aria-label`；恢复被误删的 `listForAgent` 性能注释；修正 `routes.ts` 里被拆开的注释。
6. `plugin-mutation-refresh` 测试补登记新的 mutation；`form-submit-controls` 为 Alt+Space 浮窗登记「单输入框隐式提交」的例外（与 `live-screen.tsx` 同理由）。

## 怎么验证

```sh
bun run typecheck                      # app、server（agent-computer 本机缺 playwright/spiffe，CI 也不检查它）
bun run test:app                       # 前端测试。不要直接 `bun test app/tests`：mock.module 会跨文件污染，见 docs/test-suite.md
bun test deploy/public/auth server/tests/multi-user-unified-admin.test.ts server/tests/health.test.ts
```

需要 PostgreSQL 的测试用 `TEST_DATABASE_URL` 指向**专用测试库**才会运行，否则被跳过或报「未配置」：
`server/tests/memory-notes.test.ts`、`server/tests/multi-user-unified-admin.test.ts` 里的 MCP 自动授权用例、
`server/tests/skill-ownership.integration.test.ts`（含新增的 `claimOwner` 用例）。
**这些在本机没有数据库的环境里没有运行过，合并前请在有库的环境跑一遍。**

## 已知但未处理

- `biome lint`：约 211 个 error / 700+ warning 是历史存量（集中在 `app/`，主要是 a11y 与 hooks 依赖），本分支改动的文件没有新增 error。CI 目前不跑 lint。机械地批量「修」`useExhaustiveDependencies` 有引入渲染循环的风险，建议分批处理。
- `app/src/styles.css` 里 4 处 biome 解析报错（以 `>` 开头的嵌套选择器），是 biome 版本对 CSS 嵌套的限制，不影响构建。
- 删除账号不会清理该用户的机器人与对话（页面已说明）。