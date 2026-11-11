# 密钥保险箱（ChisaBot）

设计见 DESIGN.md §52。

- 存 API 密钥 / 令牌；值加密保存，机器人看不到，只能用 `{{secret:名字}}` 让服务器替换进 `api_request`。
- 每个密钥绑定允许的域名，发往别处一律拒绝；不跟随重定向；响应里的值被抹掉。
- 机器人需要密钥时调用 `vault_request_secret`，聊天里出安全输入卡片（只在网页聊天里可用）。
- 网站账号密码不放这里，用「账号与密码」和登录卡片（`computer_request_sign_in`）。

## 接口

- `GET /api/vault` → `{ secrets }`（无值）
- `POST /api/vault` `{ name, label, domains, value? }`（同名覆盖；value 留空 = 不改）
- `DELETE /api/vault/:id`
- `GET /api/vault/requests?name=`、`GET /api/vault/requests/:id`
- `POST /api/vault/requests/:id/fill` `{ value }`、`POST /api/vault/requests/:id/cancel`
