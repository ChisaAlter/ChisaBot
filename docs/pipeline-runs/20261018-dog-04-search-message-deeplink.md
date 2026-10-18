# Pipeline run: DOG-04 content search message deep-link (2026-10-18)

## Scope
CB-UX-DOG-04 · FIX-03 follow-up：Ctrl+K 正文命中能打开会话，但 URL 只有 channel，不滚到消息。  
实现：`/workspace/ChisaBot/repo`（不用 Cursor cloud agents）。未 resume 电车定时。DOG-05 不同区，留下次。

## Status log
- 2026-10-18 ~16:25 CST Asia/Shanghai — 分支 `fix/dog-04-search-message-deeplink`；`?message=` 深链 + 滚入高亮。

## Root cause
- FIX-03 的 `ChannelSearchHit` 已带 `messageId`，`SearchHitRow` 却只 `to="/channel/$channelId"`，点命中只进频道默认滚动位。
- 聊天 KeepAlive（§98）下换查询参数不能重挂整页；高亮需独立读 URL 并只在可见频道的 DOM 里找 `[data-message-id]`。

## What changed
- `app/src/lib/channels/focus-message.ts` — `normalizeMessageSearchParam` / `findMessageRow` / `focusMessageInChat`（`scrollIntoViewWithin` + `message-flash`）
- `app/src/components/channels/message-find.tsx` — 看 `?message=`，可见时重试最多 4s
- `app/src/components/channels/channel-page.tsx` — `chatSearchSchema.message`；挂 `MessageFind`；`data-channel-id` / `data-channel-visible`
- `app/src/components/app-sidebar/app-sidebar.tsx` — `SearchHitRow` 带 `search={{ message }}`；手机点命中收抽屉
- `app/src/styles.css` — `.message-flash`（对齐 `.setting-flash`）
- Tests: `app/tests/focus-message.test.ts`；`scroll-within.test.ts` 补 DOG-04

## Not in this PR
- DOG-05 电脑陈旧截图 / screenshot 503
- 未 resume 电车定时
- 超长线程若某条尚未挂上 DOM，4s 内找不到则静默放弃（与设置搜索一致）

## How to verify
1. Ctrl/⌘K 搜一段已知正文（如「电车」）→ 点正文命中行。
2. 应进入该会话，URL 含 `?message=<id>`，该气泡滚到中间并蓝框闪约 2s。
3. 同会话再点另一条命中 → 滚到新消息并再闪。
4. 回归：无 `messageId` 的标题命中仍只进频道；设置搜索闪一下仍正常。

## PR / release
- PR: (pending)
- Release: v0.1.21 (pending)
