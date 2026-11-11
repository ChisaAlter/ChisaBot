# 流式回复：从模型到屏幕

用户反馈（2026-10-13）：「AI 输出的时候一段一段的往外蹦，显得非常卡顿，改成流式的流畅输出」。

## 实测：卡顿在哪一层

同一个问题（约 300–800 字中文、不调工具），逐层打时间戳（脚本见本文末尾）：

| 层 | 测法 | 结果 |
| --- | --- | --- |
| 上游模型平台 → Magpie | 在宿主机 tcpdump 抓 Magpie 收到的 TLS 记录 | 每 ~180–200ms 到一批 |
| Magpie → ChisaBot 服务器 | 同一次抓包，Magpie 发出的明文 SSE | 与上一行逐批对齐（Magpie 不缓冲） |
| ChisaBot 服务器 | `POST /api/conversations/agent/<bot>/run` 直连 `127.0.0.1:3001` | AG-UI `TEXT_MESSAGE_CONTENT` 每个约 3 字，按上游节奏成批到达 |
| 自带网关（nginx :8443） | 同一请求经网关 | 与直连一致：无 gzip，`proxy_buffering off` |
| Cloudflare | 从外网经公网网关（TLS 端口） | 与直连一致（无 `Content-Encoding`，无攒批） |
| 浏览器 DOM | Playwright 每帧记录最后一条回复的文字长度 | **约 6 次/秒更新，每次跳 9–30 字** |

结论：传输链路是逐事件直通的，没有任何一层在缓冲。「一段一段」来自上游免费模型本身的出字节奏（约 5 批/秒，每批 10–25 个汉字，有时停顿 0.5–3 秒），界面原样一批一批画上去。服务器改不了上游节奏，所以在界面上把字匀速放出来。

## 做法

- `app/src/lib/chat/smooth-reveal.ts`（纯函数）：每帧按积压量放字——速度 = 积压 / 180ms（指数追赶），最少 40 字/秒；硬上限：收到的字最多 400ms 内显示。切口不落在 Markdown 记号中间（`- `、`1. `、`## `、`**`、` ``` ` 和后面第一个字一起放出），不拆 emoji 代理对。新内容不是旧内容的延续就整段显示。
- `app/src/lib/chat/use-smooth-text.ts`：requestAnimationFrame 驱动，只在有积压时跑；挂载时已有的内容（历史消息）直接显示；标签页在后台或系统「减少动态效果」时立刻整段显示；超过 6000 字时最多 30 帧/秒重画。
- `app/src/components/chat/smooth-markdown.tsx`：`SmoothStreamdown`（频道聊天、群聊、工作流步骤输出）。机器人聊天只有频道聊天一套（CB-046，DESIGN.md §68，ADR-0013），以前给旧 `/bot` 页面用的 `SmoothMarkdownRenderer` / `reasoning-zh.tsx` 已删。Streamdown 仍负责把未闭合的 `**` / ` ``` ` 先补上。复制按钮读消息原文，不受影响。
- 「开场一句 → 结果」的收起规则（DESIGN.md §27）照旧：它读的是 DOM 里的文字，最多晚 400ms 看到。
- 服务器给 `/api/conversations/*` 的 SSE 响应加 `X-Accel-Buffering: no` 和 `Cache-Control: no-cache, no-transform`（`server/src/app.ts` `markEventStreamUnbuffered`）。自带网关本来就不缓冲、不压缩 SSE（`deploy/public/nginx.conf`：`gzip_types` 不含 `text/event-stream`，`proxy_buffering off`）；这两个头是给自己部署、前面再套一层 nginx / CDN 的人用的。

## 自己部署时的检查清单

如果回复仍然成段出现，先确认链路没有缓冲：

```sh
# 直连服务器 vs 经过你的代理，比较 TEXT_MESSAGE_CONTENT 的到达时间
curl -N -s -X POST -H 'content-type: application/json' -H 'accept: text/event-stream' \
  -d '{"threadId":"probe-1","runId":"r1","messages":[{"id":"m1","role":"user","content":"写三百字"}],"tools":[],"context":[],"state":{},"forwardedProps":{}}' \
  https://你的域名/api/conversations/agent/<机器人 id>/run | while IFS= read -r l; do printf '%s %s\n' "$(date +%s.%N)" "${l:0:60}"; done
```

- nginx：`proxy_buffering off;`，`gzip_types` 里不要有 `text/event-stream`（或尊重 `X-Accel-Buffering`）。
- 其他代理 / CDN：关闭对 `text/event-stream` 的压缩和缓冲。
- 心跳：运行时本来就在 SSE 空闲时每 15 秒写一行注释 `: keep-alive`（2026-10-16 用会掐 25 秒空闲连接的中间层实测：60 秒不出声的一轮不会被掐）。
  机器人在电脑上跑几分钟的命令时流不会因为「没动静」被中间层掐断；注释行所有 SSE 解析器都忽略。
- 浏览器这头断线（换网、CDN 换边缘节点）时，网页先问服务器这一轮还在不在跑：在跑就自动接上、不报错；答完了就读回答案；
  服务器重启了才报「和 ChisaBot 服务器的连接断了」。只有服务器发来的 RUN_ERROR 才会说是模型的问题。

## 只有一套聊天（CB-046，2026-10-15）

机器人聊天的界面只有频道聊天（`components/channels/channel-chat.tsx` + `chat-transcript.tsx`）。`/bot?agent=&thread=` 只做跳转
（`POST /api/channels/open-thread`，DESIGN.md §68）。流式、刷新续写（§64）、跨设备（§42 / §64）、回答期间插话（§38.1，服务器收件箱 +
`useThreadInbox(..., { pullServerTurns: false })`）、确认卡片、服务器行（定时任务 / 后台任务 / 本地 agent / 确认后接着做）都在这一套里。
