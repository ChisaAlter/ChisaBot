# GitHub 账号连接（ChisaBot）

设计见 DESIGN.md §53。

- 设置 → 账号连接 → GitHub：贴一个 GitHub 令牌（推荐 fine-grained，只选给机器人的仓库；需要 Contents / Issues / Pull requests 读写，Metadata 只读）。服务器先读 `/user` 验证，成功才加密存进保险箱（保留名 `github`，只发往 api.github.com）。
- 机器人读：`github_list_repos`、`github_list_issues`、`github_list_pulls`、`github_get_issue`、`github_read_file`。
- 机器人写：`github_create_issue`、`github_comment`、`github_create_pr`——聊天里先出确认卡片，用户点「允许」服务器才发请求；IM / 后台回合不能写。
- 令牌不进模型、聊天、日志；`api_request` 不能用 `{{secret:github}}`。
- `CHISABOT_GITHUB_API_BASE`：GitHub Enterprise 或测试替身（默认 https://api.github.com）。

## 接口

- `GET /api/github` → `{ connection }`（无令牌）
- `POST /api/github/connect` `{ token }`、`POST /api/github/check`、`DELETE /api/github`
- `GET /api/github/actions/latest?kind=&repo=`、`GET /api/github/actions/:id`
- `POST /api/github/actions/:id/approve`、`POST /api/github/actions/:id/reject`
