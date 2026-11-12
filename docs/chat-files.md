# 聊天文件与图片生成（ChisaBot）

设计见 DESIGN.md「聊天文件与图片生成」一节。

- 机器人聊天里上传的文件（≤ 20 MB）存进库（按人隔离）并写进机器人工作区 `uploads/`；消息里是 `/api/chat-files/<id>`。
- 机器人用 `file_share` 把工作区文件交给用户（聊天里出可下载的文件卡，图片 / PDF 可预览）。
- 图片生成默认关闭；管理员在 设置 → 模型 →「生图模型」选接口（MiniMax image-01，或 OpenAI 兼容 /v1/images），打开后机器人有 `image_generate` / `image_edit`。每张图按模型价格计费。旧地址 `/admin/images` 跳到这里。
- 识图：管理员在 设置 → 模型 →「识图模型」选「跟随主模型」（默认，图片直接给聊天模型）或单独的 OpenAI 兼容看图模型；选了后上传的图片先由它写详细描述 + OCR（按文件、模型缓存），文字给聊天模型，机器人还有 `image_inspect` 追问细节。
- 每个人可以在 设置 → 生图与识图（`/settings/media`）换成自己的生图 / 识图接口、密钥、模型，不设就用默认。密钥加密，只显示末四位；普通用户只能填公网接口。

## 接口

- `POST /api/chat-files`（multipart：`file`、`agentId`）→ `{ file }`
- `GET /api/chat-files?agentId=&images=1&limit=` → `{ files }`
- `GET /api/chat-files/:id`（本人；`?download=1` 强制下载）、`DELETE /api/chat-files/:id`
- 管理员：`GET|PUT /api/chat-files/settings/image`、`POST /api/chat-files/settings/image/test`（§56，保留兼容）
- 生图 / 识图设置：`GET /api/media-models/default`、`PUT /api/media-models/default/image|vision`（管理员）；`GET /api/media-models/me`、`PUT /api/media-models/me/image|vision`；`POST /api/media-models/test/image|vision`（`scope: default | personal`）

## 环境变量

- `MINIMAX_API_KEY`：MiniMax 图片接口的密钥（设置页没填密钥时用）；`OPENAI_BASE_URL` 指向 minimax 时也会沿用 `OPENAI_API_KEY`。
- `IMAGE_API_KEY`：OpenAI 兼容图片接口的密钥（设置页没填时用）。
