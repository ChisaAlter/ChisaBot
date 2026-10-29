# DEVLOG

## Unreleased — 新话题页带附件（A1）+ 用户消息图片稳定显示

### 动机

在新话题页上给机器人发图片时，图片发不出去或者显示不出来，用户消息里只剩文字。要做到：新话题和已有对话里，发送中、发送后、刷新后都能看到图片；多张图正常成组；点开能看大图。

### 根因

1. **新话题页不支持附件。** `/channel/new` 还没有对话，附件没有地方上传（上传接口是 `/api/channels/:id/attachments`），所以这个页面的输入框根本没开附件：没有「附加文件」，粘贴 / 拖入的文件被丢掉，只有文字发出去。
2. **测试脚本选中了隐藏的输入框。** `KeepAliveStage` 会把上一段对话页留着、只是藏起来，所以页面上同时有两个输入框。测试脚本（cb-run.js）按选择器取第一个，拿到的是藏着的那一个，文件塞进了看不见的对话里，看起来就像「图片没发出去」。脚本由小爱自己修，本 PR 不改。

已有对话里，接口返回的图片部分（`readThreadMessages`）和渲染（单图、ImagePile）本身是对的，本 PR 补测试锁住，不改气泡外观。

### 返修（小爱审 2c0051c）的根因

1. **无条件删除会删掉真对话。** 第一版 `channel-page.tsx` 卸载时直接 `DELETE /api/channels/:id`，而「这是草稿」只记在这个标签页的 sessionStorage 里。复制标签页（sessionStorage 跟着复制）后在一边发了消息、另一边离开，或者机器人已经主动在里面说了话，这边仍以为是草稿，于是把一段有内容的对话删了，还写了 `channel.deleted` 审计、发了通知。
2. **关掉标签页的草稿永远留在库里。** 没有任何东西回收它们，只是看不见。
3. **发送和建草稿竞态。** `attaching` 是 ref，不进 `pending`：建草稿的 POST 还没回来时回车，`start` 会另建一段普通对话，两段都带着同一份字。
4. **建草稿期间再进来的文件被丢。** 第二次 `attach` 看到 `attaching` 直接 `return`。
5. 文件全被拒（类型不支持、太大）时也先建了草稿再跳过去，那边才说不收；草稿页被藏起来（去设置等）时要等留着的页面 10 分钟超时才回收；没有宽高的图片加载前高度为 0，加载后撑开。

### 二轮复审（02f97d07）的根因

1. **藏起来就回收太激进。** 返修把草稿对话的保活时长一律设成 0，于是在草稿页选好图、去设置看一眼再回来，页面已经卸载、草稿已经删了，图没了（字放回了新话题页，但这时用户不在那里）。真正需要立刻回收的只有「去新话题页」这一种：那边要重新开始，留着一段空草稿没有意义。
2. **回收后用返回键回到它是一张错误卡。** 草稿删了以后浏览器历史里还留着 `/channel/<id>`，返回键回去拿到 404，显示「对话不存在」。`client()` 抛出的错误又不带状态码，页面分不出 404 和别的错误。
3. **按表探测运行模式不可靠。** `drafts.ts` 用 `to_regclass` 看库里有没有 `openbot_local_threads` / `openbot_local_runs` 来决定能不能删。表在不等于消息存在本库：切过运行模式的库表还在，但新消息在 Intelligence 后端，这时判断「线程是空的」是错的。
4. **跳转那一下里加的文件会丢。** 草稿建好、`stashDraftFiles` 已经取走队列，到地址真正换过去之间（路由在加载），新话题页的输入框还在，再选的文件进了 `queued` 但没人再取。

### 改动

- **服务端**（`server/src/channels/routes.ts`）：`POST /api/channels` 接受可选的 `draft: true`，建的对话用 `DRAFT_AGENT_CHANNEL_DESCRIPTION` 做 description 标记。`isHiddenDraft`（标记 + `last_message_at is null`）在对话列表和直达对话查询里过滤掉：第一条消息记进来之前，它不出现在任何人、任何设备的列表里；记进来之后就和普通对话一样。没有表结构变化，不需要迁移。
- **客户端**
  - `app/src/lib/channels/draft-channel.ts`（新）：记着这个标签页刚建、还没发的草稿对话（sessionStorage，刷新后仍记得）。`holdDraftChannel` 在对话页卸载时（StrictMode 的二次挂载不算）还没发过就 `releaseDraftChannel`：立即 `DELETE`，写了一半的字放回新话题页（`new:<agent>`），文件丢掉。发出第一条后 `settleDraftChannel`，以后就是普通对话。
  - `composer.tsx`：新增 `onAttachWithoutChannel`。没有对话时，选择 / 粘贴 / 拖入的文件不上传，而是连同当前文字交给它。
  - `channel/new.tsx` + `start.ts`（`startDraft`）+ `mutations.ts`（`createDraftChannelMutationOptions`）：建草稿对话，`moveTextDraft` 把字挪过去，`stashDraftFiles` 把文件挪过去，`replace` 跳到 `/channel/<id>`（返回键不会回到一个空的新话题页）。不刷新对话列表（反正它不在列表里）。
  - `channel-chat.tsx`：刚建的草稿对话（`freshDraft`）跳过「恢复中」骨架和首次读历史（它还没有消息），直接显示开场介绍，所以跳转不闪；发送时 settle。`channel-page.tsx` 挂 `holdDraftChannel`。
- 用户消息图片：沿用已有的 width/height 预留占位（单张 `.rp-image-single`）和 ImagePile 叠放组；点开是原图。本 PR 不做缩放（B1 另开 PR）。

返修：

- **带条件删除**（`server/src/channels/drafts.ts` 新，`routes.ts`）：`DELETE /api/channels/:id?draft=1` 只在这段对话**仍是空草稿**时软删除：description 是草稿标记、`last_message_at` 为空、未删除，并且它的线程（`intelligence_channel_mappings.thread_id` → `openbot_local_threads`）里没有消息、也没有跑过一轮（`openbot_local_runs`）。否则回 409、什么都不动。这种删除不写 `channel.deleted` 审计、不发通知（草稿从没出现在任何列表里）。非成员照旧 404。客户端 `draft-channel.ts` 的删除改成带 `?draft=1`，不管结果。
- **24 小时清理**（`sweepAbandonedDrafts` + `startDraftSweeps`，在 `server/src/index.ts` 和 `startRetentionSweeps` 一起启动、一起停）：启动 60 秒后跑一次，之后每小时一次，每批最多 500 段，只删同时满足上面全部条件且 `created_at` 早于 24 小时前的。条件写在一条 `UPDATE … WHERE` 里，可以重复执行（删过的不再满足 `deleted_at is null`）。
- **保守处理**：消息不存在本库（只用 Intelligence 后端的部署）时无法确认线程是空的，条件删除和定时清理都**一律不删**（条件删除回 409）。这类部署的草稿只是看不见，不会被回收。二轮复审后改为直接由启动处传 `config.runtime.mode === "local"`（`DraftStorage.localConversations`），不再探测表在不在。
- **发送与建草稿互斥**（`channel/new.tsx`）：`attaching` 改成 state，并进输入框的 `pending`（发送键不可用），`start` 在建草稿时直接返回；反过来第一条消息正在发或已发出时不建草稿。
- **建草稿期间的文件追加**：再进来的文件追加到同一个队列，`startDraft` 在草稿建好之后才取文件（`files` 可以是函数），一起放进 `stashDraftFiles`，跳过去后一起放上。
- **先筛再建**（`composer.tsx` `handOff`）：交出文件之前按 `stageFiles` 同样的规则（`screenPickedFiles`）筛，拒收的说法留在新话题页；一个都不收就不建草稿。
- **藏起来就回收**：`KeepAliveStage` 的 `ttlMs` 可以按留着的那页定，`authed-shell.tsx` 对草稿对话给 0：藏起来立即卸载，走原来的卸载收尾（字放回新话题页、带条件删除）。普通对话照旧留 10 分钟。

二轮复审：

- **只有去新话题页才立即回收**（`draft-channel.ts` `draftKeptTtl`，`authed-shell.tsx`）：时长按「是不是草稿 + 当前地址」定，只有草稿对话且当前地址是 `/channel/new` 时给 0；去设置等别的页面照常留 10 分钟，回来图和上传都在。回调按 `pathname` 记忆（`useCallback`），留着的计时器不会每次渲染重来；先去设置、再从设置去新话题页时那一刻回收。
- **回收过的草稿 404 时静默跳走**：`client.ts` 新增 `ClientError`（带 HTTP 状态码），`client()` 失败时抛它。`releaseDraftChannel` 回收时把「这段属于哪个机器人」记进 sessionStorage（`chisabot-released-drafts:v1`，最多 50 条）。`channel-page.tsx` 读对话失败时用 `releasedDraftRedirect` 判断：是 404 且是本标签页回收过的，就 `replace` 跳到 `/channel/new?agent=…&topic=new`，跳之前按「加载中」显示、不闪错误卡；别的 404 和别的错误照旧。
- **运行模式直接传**（`drafts.ts`、`routes.ts`、`index.ts`）：去掉 `localThreadsPresent` 的表探测，`deleteEmptyDraft` / `sweepAbandonedDrafts` / `startDraftSweeps` / `createChannelStore` 都收 `{ localConversations }`，由 `index.ts` 按 `config.runtime.mode === "local"` 给；不给就当不是本地（不删）。
- **跳转那一下里加的文件追加过去**（`ui-memory.ts` `addDraftFiles` / `listenDraftFiles`，`composer.tsx`，`new.tsx`，`start.ts`）：`startDraft` 返回草稿对话的 id；跳转完成后把 `queued` 里剩下的交给 `addDraftFiles`：那段对话的输入框已经挂着就直接走 `stageFiles` 上传，还没挂着就并进暂存，挂上时一起取。
- **依赖重装**：dev-user-image 里所有工作区的 `node_modules` 删掉后 `bun install --frozen-lockfile` 重装；之前的 44 个 zod 类型错误来自脏的 `node_modules`，重装后 typecheck 0 错误，`bun.lock` 没变。
- **没有宽高的图片先占固定框**（`rich-previews.tsx` `reservedImageBox`）：240px 宽、4:3 的占位框，加载完知道了尺寸换成真比例；加载完仍读不出尺寸就不再限定。有宽高的图片不变。

### 测试

- `server/tests/channel-routes.test.ts`：`draft` 参数解析与透传；草稿对话在有消息之前不进列表、有消息后出现；不作为直达（direct）投递的对话（真实 Postgres）。
- `app/tests/draft-channel.test.ts`：离开即删、字放回、文件清掉；发过不删；StrictMode 不算离开；普通对话不删；删除失败不抛；刷新后仍记得。
- `app/tests/composer-attach-without-channel.test.tsx`：没有对话时选择 / 拖入 / 粘贴都交出文件和文字。
- `app/tests/channel-new-attach.test.tsx`：新话题页选文件 → 建草稿对话 → 替换跳转，文字和附件都在、开始上传。
- `app/tests/user-image-thumbs.test.tsx`：接口返回的图片部分带 width/height；单图占位尺寸；多图叠放顺序；5 张显示 4 张 + 「+1」；点开大图是原图。
- `app/tests/open-at-latest.test.ts`：跟着 `freshDraft` 条件更新正则。
- 返修：
  - `server/tests/channel-routes.test.ts`：`?draft=1` 删除 → 204，不调普通删除、不写审计；不是空草稿 → 409；store 不支持 → 409；非成员 → 404。真实 Postgres：空草稿被条件删除（重复删也是 deleted）；说过话的（`last_message_at`）、线程里已有消息但还没记 activity 的（机器人主动说话）、普通对话都不删；非成员拒绝；清理只删超过 24 小时的空草稿，23 小时的、说过话的、线程有消息的、普通对话都不动，再跑一次结果不变。
  - `app/tests/channel-new-attach.test.tsx`：建草稿的请求挂着时发送键不可用、回车不另建对话；建草稿期间第二次选的文件和第一批一起放上、只建一段；文件全被拒时不建草稿。
  - `app/tests/draft-channel.test.ts`：默认删除请求是 `DELETE /api/channels/:id?draft=1`，回 409 也不抛。
  - `app/tests/draft-channel-hidden.test.tsx`（新）：草稿对话藏起来立即卸载并回收；普通对话照旧留着；外壳接线。
  - `app/tests/user-image-thumbs.test.tsx`、`app/tests/image-dims.test.tsx`：没有宽高的图片先是 240px、4:3 的占位框，加载完换成真比例（`image-dims` 里原来锁「没有样式」的那条跟着改）。
- 二轮复审：
  - `app/tests/draft-channel-hidden.test.tsx`：去新话题页立即卸载并回收、记下机器人；草稿页去设置再回来图还在、没回收；先去设置再去新话题页时才回收；时长规则；外壳接线。
  - `app/tests/draft-channel.test.ts`：回收时记下机器人（sessionStorage），发过的不记；回收过的 404 → 机器人 id，别的 404 / 500 / 断网 → null；对话详情读失败带状态码（`ClientError` 404）；对话页 replace 跳转接线；`addDraftFiles` 挂着时交给输入框、没挂着时并进暂存。
  - `app/tests/channel-new-attach.test.tsx`：草稿建好、跳转还在加载时再选的文件，跳过去后追加到输入框并上传（去掉 `addDraftFiles` 这条测试会失败）。
  - `server/tests/channel-routes.test.ts`：真实 Postgres 的条件删除和清理改为显式传 `{ localConversations: true }`；新增「非本地模式」：不传时条件删除回 kept、清理返回 null，空草稿不被删。

### 截图

`docs/images/user-image-thumbs/`，桌面 1024×640、手机 473×1024，返修时精简为 10 张：桌面是新话题上传中、发送后、刷新后，已有对话多图、大图，没发就离开回到新话题页（字放回来了）；手机是新话题上传中、发送后，已有对话多图，没发就离开。第一版各 16 张的完整场景在 2c0051c 的历史里。用的是组件级 harness（真实的 ChannelNewRoute / ConversationView / Composer / ChatTranscript + mock 接口），不是整个应用外壳。

### 局限

- 草稿对话只在去新话题页时立即回收；去别处藏着超过 10 分钟也会回收。之后在本标签页回到它（返回键、刷新）会静默跳到那个机器人的新话题页，字已经放回那里；在别的标签页或设备打开它的链接仍是「对话不存在」。
- 关掉标签页再也不回来：草稿对话最多留 24 小时（加上最多 1 小时的清理间隔），然后由定时清理软删除。只用 Intelligence 后端（库里没有本地线程表）的部署不清理，也不接受条件删除。
- 刷新草稿对话页后，还没发的文件不保留（文件只在内存里），文字保留。
- 第一条消息的活动记录如果写入失败，这段对话要等回复记进来才出现在列表里。
- 多张图是现有的叠放组，不是网格；草稿对话页不显示「试试这样问」建议。

## Hark 式链接卡 + GitHub 预览图（feat/hark-linkcard）

**动机**：对比反馈截图（2026-10-29，ChisaBot 与 Hark 各一张），我们的 GitHub 链接卡只有「图标 + 域名 + 标题 + 一行说明」，没有预览图；Hark 是上半 og:image 大图、下面两行标题和「GitHub · v0.1.13」。另外同一个「链接卡」有两份实现：正文链接卡（`rich-previews.tsx` 的 `LinkCard`，会取 `/api/link-preview`）和 json-render 的 `Link`（`rich.tsx` 的 `LinkCard`，只画模型写的字段），长得不一样，修一处另一处不跟着变。

**GitHub 的 og:image 为什么没显示（结论）**：
- 截图里的两张 GitHub 卡都是 json-render 的 `Link`（`.jr-link`），不是正文链接卡。旧组件只用模型写的 `url / title / description / image / meta`，从不调 `/api/link-preview`；模型几乎不会给 `image`（GitHub 的 og 图地址是现算的哈希，模型也写不出来），所以永远没有图。这是根因，本次修掉：缺的图、标题、站点名一律用预览补。
- 逐项排除的其它可能：
  - 服务端解析：在 box 上用 `guardedFetch` + `parsePage` 实跑 `https://github.com/ChisaAlter/ChisaBot`：200，`og:image` = `https://opengraph.githubassets.com/<hash>/ChisaAlter/ChisaBot`（1200×600），站点名 GitHub；这张图连下两次都是 200 `image/png`（约 114 KB）。github.com 首页、release 页同样解析得出图。解析没问题。
  - 相对 URL：GitHub 给的是绝对地址；`parse.ts` 本来就按 `<base href>` / 页面地址补全相对地址。
  - CSP：主应用的 CSP 是 Report-Only，`img-src 'self' data: blob: https:`；预览图走本站 `/api/link-preview/asset/…`（`'self'`），不会被拦。网关的强制 CSP 只挂在 `/login`。
  - egress 白名单：链接预览在 server 进程里用 `shared/net/guarded-fetch.ts` 直连公网，不走 agent-computer 的出口过滤代理，不受 Bot 放行名单影响。
- 一个要留意、但这次没改的点：`shared/net/ssrf.ts` 把 `198.18.0.0/15`（基准测试网段）当内网拒绝。box 的 DNS 是 fake-IP（`github.com` → `198.18.0.1`），在 box 上不放行时所有预览都是 `BlockedUrlError` → 422。如果 Haupt 的 DNS 也走 Clash 一类 fake-ip 代理，链接预览会全部退成兜底卡。按规定没有登 Haupt 核实；需要时在 Haupt 上 `getent ahosts github.com` 看一眼即可。SSRF 名单属于安全边界，不在这次改。

**改法**：
- 新组件 `app/src/components/rich-previews/link-card.tsx`，正文链接卡和 json-render `Link` 共用。字段合并是纯函数 `app/src/lib/rich-previews/link-fields.ts`（`mergeLinkFields`）：给的优先（模型的 title / image / meta，正文链接的 `[标签](网址)`），缺的用预览补；模型给的 https 图先用，加载失败换预览的转存图；标题、图、站点名都给全了才不去问预览。
- 版式：固定宽约 280px（`min(280px, 100%)`）；有图时上半 40:21 的预留框放 og:image（cover，上方两角跟卡片圆角），下面两行粗体标题（固定两行高）、一行浅色「站点 · 补充信息」；没有图时同宽紧凑横卡。半透明底 + 内侧高光边（inset box-shadow），不用 backdrop-filter（聊天里卡多，模糊贵，也和 #363 的性能预算一致）。
- 不跳动：取预览时的骨架和有图的卡用同一套类、同一个预留比例、标题同样固定两行高；图片 `loading="lazy"`，`width` / `height` 用服务器量好的尺寸（没有就按 1200×630）。只有「最后确实没有图」时会收成紧凑横卡；给了标题的 json-render 卡在骨架里先把标题写上。
- 预览查询（类型、缓存、`previewQuery`）从 `rich-previews.tsx` 拆到 `link-preview-query.ts`，两处共用同一个查询缓存，不需要外层 Provider。
- 样式全在组件自己的 `link-card.css`，只有 `lc-` 开头的新类（多卡扇形叠放挂在已有的 `.rp-links[data-deck]` 容器下）；styles.css 一行没改。旧的 `.rp-link*` / `.jr-link*` 规则现在没人用了，按「不动已有样式」留着，等前端改版时一起清。

**测试**：`app/tests/link-card-unified.test.tsx`（字段合并优先级、有图 / 无图两种卡、骨架和卡片同尺寸、全给了不发请求）；`link-cards.test.tsx`、`json-render-rich.test.tsx` 按新类名更新断言。

**审查后修改（小爱对照 Hark 截图审 #380，2026-10-29）**：
- 范围：前端会把链接卡视觉重做成 Hark 那种错落叠放的卡片，所以 #380 只做数据侧和「不留空白」，图片内缩、圆角、字重、颜色这类视觉细节不在这里改（link-card.css 里只动了高度，styles.css 没动）。
- 动机：①模型写的标题常常只是「GitHub」「ChisaBot」，比 og:title 信息少，却因为「给了的优先」盖掉了 og:title；②有图的卡标题固定两行高、站点行固定一行高，一行标题时下面空出一大块。
- ① 标题选择（`link-fields.ts` 的 `isWeakLinkTitle`）：给的标题等于站点名、域名（带不带 `www.`、只写主名如 `github` 都算），或者整个被 og:title 包含，就改用 og:title；比较忽略大小写和首尾空白。没有 og:title 或预览降级时不换。
- 「站点 · 补充信息」所需字段：`mergeLinkFields` 对每个链接给出 `image`（+ `imageFallback`、宽高）、`site`（给的站点名 → og:site_name → 域名）、`extra`（给的 meta / 标签 → 模型写的一句话 description；和站点名或标题重复的不给），所以底下一行是 Hark 那样的「GitHub · v0.1.13」。
- ② 去掉真卡上标题 `height: 40px` 和站点行 `height: 18px`，高度跟着内容走；只有骨架（`.lc-skel`）里预留两行标题、一行站点。图区仍和骨架同一个预留比例，图到了不跳；文字区可能比骨架矮一行，这是允许的。
- 测试：字段合并挪到新的 `app/tests/link-fields.test.ts`，补了站点名 / 域名 / 被包含 / 不该换 / 降级不换和「站点 · 补充信息」的用例；`link-card-unified.test.tsx` 改成断言真卡文字区不定高、只有骨架定高。
- json-render-rich：见 PR 描述里的连跑结果。之前那一次 5 s 超时出现在改完大量文件后的第一次冷启动（`await import` 整个注册表要现转译）；这个用例里的链接卡不等 `/api/link-preview`（断言只要 `.lc-card`，骨架也带这个类），不是链接卡引起的。

## Unreleased — 对话记录增量同步 + 卡片共享时钟（性能清单第 5 项）

### 动机

- `use-thread-inbox.ts` 在服务器自己跑一轮时每 1.2 秒拉一次**整份**对话记录，再把本地和服务器的两份 `[id, content]` 各转成一整串 JSON 比较；长对话下每次轮询都传几百 KB 到 MB 级、在主线程上解析 + 两次全量 stringify，大多数时候内容其实没变。
- `work-card` / `worker-card` / `local-agent-card` 各自开一个 1 秒 `setInterval`，页面上同时有几张在跑的卡片就是几个计时器、几次独立的重画。

### 改动

- 服务器 `server/src/thread-messages-delta.ts` + `app.ts` 在 `/api/copilotkit/*` 上加一层中间件（本地后端和 Intelligence 两条路都会经过）：`GET …/threads/:id/messages` **带 `since` / `cursor` 参数时**改写响应：
  - `version` = 条数 + 逐条前缀哈希（按消息内容算，不依赖 `updated_at`，因为并非每个写入点都会更新它）；`since` 等于当前 version → 只回 `{ unchanged: true, version, cursor }`。
  - `cursor` 指向「除最后一条外」的前缀（最后一条可能还在流式增长）；带回来的 cursor 前缀仍吻合 → 只回 `{ start, messages: 尾部 }`；中间有编辑 / 删除 / 插入对不上 → 回整份（`start: 0`）。
  - 原始响应体哈希 → 前缀指纹做了 64 条的小缓存（只存哈希不存内容），「没变」的轮询不用再解析、逐条哈希。
  - **不带参数的旧客户端响应完全不变。**
- 客户端 `app/src/lib/copilot/thread-sync.ts`（纯函数）+ `use-thread-inbox.ts`：
  - 记下上次同步时服务器给的 version / cursor 和当时放进 agent 的那组消息对象；本地消息仍是同一组对象（逐个引用相同）时才带参数去问，否则（流式、发送、别的同步改过）拿整份。
  - unchanged → 什么都不做（不 setMessages、不重画）；尾部 → 前缀原样保留（同一批对象）拼上尾部，只比较尾部的 id + content，变了才 setMessages。
  - 回答对不上当前本地（请求途中本地被改过、start 越界、格式不对）就丢掉基准，下次拿整份重新对。旧服务器（没有 version）照旧整份比较。
- `app/src/lib/use-now.ts`：模块级共享时钟，第一个订阅者来时开一个 1 秒 interval、最后一个走时停；`useNow(active)` 用 `useSyncExternalStore` 订阅，不 active 时不订阅、停在最后看到的时间。三张卡片删掉各自的计时器改用它。
- 没改样式（`styles.css` 未动）、没升版本号。

### 局限

- AG-UI 的 `setMessages` 会 structuredClone 整份消息，所以**确实有变化**时 agent 里的对象引用仍会整体换新、该重画的照样重画；省下的是「没变化」的那些轮询（不传、不解析、不比、不 setMessages）和变化时的传输 / 比较量。
- 服务器端每次带参数的请求多一次响应体哈希；内容变了时还要解析 + 逐条哈希（2000 条约 6 ms），在服务器上做，不占浏览器主线程。

### 性能（本机 Bun 1.3.14 微基准，经真实中间件；客户端只算解析 + 比较）

| 场景 | 每次轮询传输 | 服务器 | 客户端 |
| --- | --- | --- | --- |
| 600 条 / 415 KiB，没变化：旧 → 新 | 425 KB → 83 B | 0.18 → 0.85 ms | 0.87 → 0.004 ms |
| 600 条，最后一条流式增长：旧 → 新 | 425 KB → 1.3 KB | 0.19 → 2.37 ms | 1.59 → 0.008 ms |
| 2000 条 / 1.4 MiB，没变化：旧 → 新 | 1.42 MB → 85 B | 0.88 → 6.09 ms | 6.24 → 0.011 ms |
| 2000 条，流式增长：旧 → 新 | 1.42 MB → 1.3 KB | 1.11 → 6.39 ms | 5.54 → 0.012 ms |

- 轮询路径的 React 更新次数：旧实现在内容没变时也不调 setMessages，所以两边一样（没变 0 次、变了 1 次）；测试锁住「没变化不触发更新」。
- 卡片计时器：N 张在跑的卡片从 N 个 interval（N 次独立提交）变成 1 个 interval（同一 tick 里一起更新）。

### 测试

- `server/tests/thread-messages-delta.test.ts`：首次读、unchanged、流式尾部、编辑 / 删除 / 截断回退整份、垃圾 token、旧客户端原样、缓存命中时旧 since 仍拿尾部。
- `app/tests/thread-sync.test.ts`：增量合并保留前缀引用、编辑 / 删除、没变化不更新、基准失效拒绝、旧格式兼容、结构化 content 按值比较。
- `app/tests/thread-inbox-incremental.test.tsx`：真 hook + 真轮询：首次整份、之后带 since/cursor、unchanged 时 `setMessages` 次数不变且 `agent.messages` 引用不变、尾部合并、本地改动后退回整份。
- `app/tests/shared-clock.test.tsx`：多张卡片只开 1 个 interval、不 active 的不重画、最后一个订阅者走后停、再来重新开。

### 返修（测试反馈）：界面实际路径接增量 + 共享时钟测试隔离

- **问题**：上面改的 `useThreadInbox` 服务器轮询在界面里没启用——唯一调用处 `channel-chat.tsx` 传 `pullServerTurns: false`，测试实测浏览器只发不带 since 的整份请求（600 条对话整份 484 KB）。
- **界面实际读对话记录的路径**（变化检测本身是 `useBotThread` 每 2 秒轮询很小的 `/api/bot-threads/…/sync` 变化戳，有变化就走 `connectAgent` 回放；整份记录只在下面这些地方读）：
  1. `readThreadMessages`（`lib/copilot/thread-messages.ts`，`…/messages?agentId=`）：`channel-chat.tsx` 的挂载预读 / 恢复、历史重试（1.5s/4s/10s）、远端一轮结束后补尾巴、「Bot 在别处说了话」时的拉取（0/750/1500ms 三次）、发送看门狗、断线补齐，以及 `transcript-cache.ts`。
  2. `useConversationSync` 每轮结束 800ms 后的对话顺序核对（同一 URL，不带 agentId，`fetch` + `credentials: include`）。
- **接法**：两条都改走新的 `readStoredRows`（`thread-messages.ts`）：
  - 每条对话（agentId + threadId 为键，最多 8 条）在内存里记下服务器上次发来的原始行和 version / cursor，下次带 `since` / `cursor`；第一次 `since=`（空），服务器回整份 + version / cursor。
  - `unchanged` → 直接复用上次那份原始行数组；`readThreadMessages` 按数组缓存解析结果，返回**同一个 `StoredThread` 对象**，`mergeStoredMessages` / `withStoredTail` 原样返回本地数组，调用方不 `setMessages`。
  - 尾部 → 前缀拼尾部（纯函数 `applyStoredAnswer`，`thread-sync.ts`）；回答对不上基准（start 越界、格式不对）→ 丢掉基准、再整份读一次。
  - 非 2xx（401 / 5xx）→ 清掉基准，返回值和以前一样（`readThreadMessages` 给 unavailable，顺序核对直接返回）；请求超时被 abort 的不更新基准。
  - 服务器不回 version（旧服务器）→ 不存基准，每次照旧整份。编辑 / 删除由服务器前缀对不上回整份，调用方拿到的始终是整份，合并 / 重建逻辑一行没改；流式仍走 connect / run 的事件流，不经过这里。
- **请求大小**（本机，真实 `readThreadMessages` + 真实服务器中间件，600 条对话）：

| 步骤 | 旧（整份） | 新 |
| --- | --- | --- |
| 挂载首读 | 532.6 KiB | 532.7 KiB（`since=`） |
| 之后没变化的每次读 | 532.6 KiB | 83 B（返回同一对象，不 setMessages） |
| Bot 新增一条回复 | 532.6 KiB | 3.2 KiB |
| 最后一条变长 | 532.6 KiB | 1.6 KiB |
| 较早消息被编辑 / 删除 | 532.6 KiB | 约 534 KiB（整份） |

- **共享时钟测试**：`shared-clock.test.tsx` 单跑能过、在 `bun run test:app` 共享进程里挂（前面文件留下的 `jest.useFakeTimers` 和没卸载、仍订阅着模块级时钟的卡片）。`use-now.ts` 加仅测试用的 `resetClockForTests()`，测试每个用例前后 `jest.useRealTimers()` + 卸载 + 还原时钟；共享进程里已通过，不需要加进 ISOLATED。
- **新测试**：`app/tests/stored-thread-sync.test.ts`（since → since+cursor、unchanged 返回同一对象、尾部、编辑 / 删除整份、对不上重读、401 清基准、旧服务器、顺序核对不带 agentId）；`app/tests/channel-history-incremental.test.tsx`（真 `ChannelChat` + 按协议回答的假服务器：挂载发 `since=`，Bot 在别处说话后的拉取都带 since+cursor、只拿到 unchanged、`setMessages` 0 次；存储新增一条后只传尾部、界面补上新回复且不重复）。

## SW 导致登录 state_mismatch（fix/sw-auth-navigation）

**现象**：开着 Service Worker 时，Chrome 登录最后落到 `/api/auth/error?error=state_mismatch`，但会话其实已经写入；屏蔽 SW 后正常，main 上也能复现。

**根因**：`app/public/sw.js` 在 activate 里 `navigationPreload.enable()`。preload 是浏览器对**每个**导航先发的请求，并不只限于 SW 要拦的那些，所以 `/api/auth/callback` 也会先被预请求一次。这个请求到达服务器，写好会话并消费掉 state。而 sw.js 对 `/api|/auth|/sign-in…`（`SKIP_NAV`）的导航不调 `respondWith`，此时 Chrome 会丢弃 preload 的响应，回退成普通网络请求再发一次；第二次 state 已经没了，于是 state_mismatch。

注意：「丢弃 preload 响应再发一次」是按 Chrome 的行为推断的，没有在真实浏览器里复现，需要测试 bot 在 Chrome 里确认 callback 只发一次。

**改法**：
- activate 改成 `navigationPreload.disable()`。preload 的开关存在 registration 上，换了 sw.js 也不会自己关，所以要显式关。
- `SW_VERSION` 从 2 改成 3。sw.js 内容变了，浏览器本来就会更新；资产缓存名不变，没有必要清缓存。
- 普通页面导航照旧在 SW 里 `fetch` 一次。如果激活前那一刻还有 preload 响应，就直接用它，不再发第二次。
- `SKIP_NAV` 路径照旧不 `respondWith`，由浏览器自己发一次。

**为什么不选「对跳过的路径 respondWith(preloadResponse)」**：那样认证回调就要经过 SW 转交，违背「/api 一律不拦」的原则。关掉 preload 的代价只是普通页面导航多等一次 SW 启动（几十毫秒），可以接受。

**测试**（`app/tests/sw-navigation.test.ts`）：
- `/api/auth/callback` 等路径的导航不 respondWith、SW 不 fetch；
- 激活时只调用 disable；
- 普通导航只 fetch 一次；
- 有 preload 响应时用它、不再 fetch。

## 审计 #5：nginx 真实 IP + 网关身份头防重放（fix/nginx-realip-gateway-replay）

**真实 IP。** 公网入口是 Cloudflare → nginx，`$remote_addr` 原来是 Cloudflare 边缘节点：`limit_req` 按边缘 IP 限流（一个节点后面的所有人共用额度、单个攻击者换节点就绕过），`X-ChisaBot-Client` / `X-Forwarded-For` 给应用的也是边缘 IP。现在 http 块里 `real_ip_header CF-Connecting-IP`，`set_real_ip_from` 只列 Cloudflare 官方 v4/v6 网段（https://www.cloudflare.com/ips/ ，2026-10-29 取）。不是从这些网段来的连接带的 `CF-Connecting-IP` 不被采信，所以绕过 Cloudflare 直连源站也伪造不了 IP。没有加 `real_ip_recursive`，CF 只给一跳。`scripts/ops/check-trust-boundary.sh` 和 `server/tests/trust-boundary-redline.test.ts` 检查指令与每个网段都在、且没有 `0.0.0.0/0` / `::/0`。Cloudflare 改网段时要同步改这三处。

**真实 IP（补充：别让客户端自带的头漏到应用）。** realip 只改 `$remote_addr`，nginx 默认仍把客户端发来的 `CF-Connecting-IP` 原样转给上游。绕过 Cloudflare 直连源站的人可以随便填这个头；应用如果读它，就能伪造 IP。IM OneBot 反向连接的失败限速原来就先读 `cf-connecting-ip`，换着填就能无限试 token。

- nginx：每个转发 location（14 个，含 Magpie 那个 server）都 `proxy_set_header CF-Connecting-IP ""` 清掉它，并 `proxy_set_header X-Real-IP $remote_addr`（realip 处理后的真实 IP）。nginx 的 `proxy_set_header` 不从外层继承（location 里只要写了一条就全不继承），所以逐个 location 写，不放在 server 级。
- 应用：新增 `gatewayClientIp`（`server/src/auth/gateway-identity.ts`）：X-Real-IP 优先，其次 X-Forwarded-For 第一段，从不读 CF-Connecting-IP；直连（不经网关）为 null。设备令牌限速（原 `devices/routes.ts` 自己的 `clientIp`）和 IM OneBot 失败限速都改用它，不再各写一份。
- 检查：`check-trust-boundary.sh` 用 awk 逐个 location 检查「有 proxy_pass 就必须两条都有」；`trust-boundary-redline` 测试用 `nginxPinsClientIpHeaders`（`shared/trust-boundary.ts`）做同样的检查，另有一条反例。
- 测试：`server/tests/im-onebot-rate-limit.test.ts`：换着伪造 `CF-Connecting-IP` 绕不过限速，伪造别人的 IP 也不会把别人拖进限速，计数键始终是网关给的真实 IP。
**防重放。** 身份头本来只靠 ±2 分钟时间窗：窗内截获的头（日志、代理、调试抓包）可以原样重放。

- 网关（`deploy/public/auth/server.ts` 的 `signIdentity`）和应用里的 `signGatewayIdentity` 在 payload 里加 `j`（16 字节随机数，base64url）。没有它的话，同一用户同一毫秒的两个并发请求会签出完全相同的头，按签名去重就会误拒正常请求。
- `GatewayReplayCache`：键 = 整个头的 SHA-256，过期 = 签发时间 + 2 分钟（之后 verify 本身就拒绝），上限 10 万条。满了先清过期的，仍满就丢最早的：宁可极端洪峰下少记几条，也不让内存无限涨或误拒正常用户。
- **在哪里消费**：只在 `serve()` 的 `fetch` 入口每个 HTTP 请求消费一次（含 WebSocket 升级）。应用内同一个请求会被 resolve 好几次（守卫中间件、CopilotKit 的身份和权限各一次、WebSocket 手动守卫），如果在 `resolveGatewayRequest` 里消费，第二次就会把自己当重放。`resolveGatewayRequest` 保持无状态。
- **兼容**：网关每个请求都是现签的（nginx `auth_request` 每个请求一次），正常请求不会出现同一个头两次。不带 `j` 的旧格式（升级前的网关签的）照旧放行、不去重，滚动升级不会断；网关升级后旧头最多 2 分钟就全部过期。
- **窗口没缩短**：有了一次性检查，窗口长短只影响缓存大小，不再决定重放面；网关和应用在同一台机器上，2 分钟留给时钟漂移和慢请求足够也不算多，缩短反而可能误拒长排队的请求。
- **防重放的边界（运维须知）**：
  - **只在内存里**：去重记录在应用进程内存里，不落盘。应用重启后清空：重启前签发、还没过期的头（最长 2 分钟）重启后可以再被用一次（前提是已经被截获）。
  - **多实例各记各的**：几个应用实例之间不共享，同一个头可以在每个实例上各用一次。现在只有一个应用进程；以后若横向扩容，要么把去重挪到共享存储（同样的 TTL），要么让 nginx 把同一会话固定到同一实例。
  - **上限 10 万条**：每个请求一条、TTL 2 分钟，大约对应持续 800 req/s。满了先清过期的，仍满就丢最早的：极端洪峰下可能漏记几条，换来内存有界、不误拒。
  - **旧格式过渡**：不带 `j` 的旧格式现在照旧放行，为了滚动升级不断。过渡期结束（确认网关都已升级）后会加一个开关，拒绝不带 `j` 的头，届时旧格式直接 401。

## Unreleased — CI：Biome 只拦新增、完整 test:app、pc/ 安装构建（审查清单第 3 项）

### 动机

- 全仓 Biome 有上千个存量 error，CI 里一直没跑 Biome，新代码的问题也没人拦；一次改全仓风险太大。
- CI 只跑挑出来的 app 测试子集，其余 app/tests 文件改坏了没人发现。
- pc/ 是独立 npm 项目，平时 CI 只跑它的 node 测试；chisabot-node 无头包只在 app 构建里顺带打，失败时仅打印警告（默认 isolated linker 下 `ws` 解析不到会静默跳过）。

### 改动

- `scripts/biome-new-issues.ts`：取基线（默认 origin/main 的 merge-base）与当前工作区之间新增/修改/改名的文件和未跟踪文件，把基线版本连同基线的 biome 配置写进临时目录，两边各跑一次 `biome check --reporter=json`，按「文件 + 规则」比较 error/warning 数，变多就退出 1 并列出新增诊断（在 GitHub Actions 里输出 `::error` 注释）。存量问题不拦，顺手修掉的只会让数变少。
  - 局限：同一文件同一规则里「修一个、新增一个」数不变，拦不住；格式问题 Biome 每个文件只报一条。
- `.github/workflows/chisabot.yml` 新增三个 job：
  - `biome`：`fetch-depth: 0`，PR 以目标分支 base sha、push 以 `github.event.before` 为基线（没有基线时退回 HEAD^1）。
  - `app-tests`：hoisted 安装后跑 `bun run test:app`。web-and-models 里原有的子集保留不动。
  - `pc-build`：在 pc/ 里 `npm ci`（跳过 Electron 二进制下载），用和 `app/vite.config.ts` 里 chisabotNodeBundle 相同的 esbuild 参数打包 `src/headless.js`，`node --check` 并比对 `--version` 与 pc/package.json。pc/ 保持独立，不进 workspaces / 主构建；带 Electron 的 Windows 安装包仍由 release.yml 打。
- 不改任何版本号。

### 已知情况

- `test:app` 目前在 main 上会红：共享进程里有测试互相干扰，另有几个文件单独跑也失败。根因修复在 `fix/test-isolation` 分支，合入后这个 job 才会绿。

**回归后加固（小爱复查）**：
- 放行漏洞：原来 Biome 没输出 JSON（例如 biome.json 写坏、二进制出错）时，脚本直接 `continue`，最后算出「没有新增」、退出 0。现在只要退出码非 0、又解析不到 `diagnostics` 数组，就退出 2。
- 原来在 `try` 里调 `process.exit`，`finally` 不执行，`/tmp/biome-base-*` 会残留（本机临时目录里找到 10 个旧目录，已清掉）。现在整段包成 `run()`，返回退出码；入口只设 `process.exitCode`，所以临时目录总会被清理。
- 用法注释里原来写「CI 用 HEAD^1」，实际 workflow 传的是 PR base sha / push before，两者都没有才退回 HEAD^1。注释已改成一致。
- 测试 `scripts/biome-new-issues.test.ts`：在临时 git 仓库里覆盖五种情况，每个用例都断言临时目录被清理：
  - 正常改动、没有新增 → 0；
  - 加 debugger → 1；
  - biome.json 写坏 → 非 0；
  - 假 Biome 退出 3 且不输出 → 2；
  - 二进制不存在 → 失败。
- 实测：
  - 在本仓库跑一遍：没有新增，退出 0；
  - 临时写坏 biome.json：parse / deserialize 诊断变多，失败（之后已还原）；
  - 临时加 debugger：`noDebugger` 0 → 1，失败。
- 追加（复查）：
  - **默认 `error` 自递归**：`const error = options.error ?? ((line) => error(line))`，箭头函数里的 `error` 指向它自己。没传回调时（CI 和命令行入口都不传），一旦要输出错误（有新增问题、Biome 出错、git 出错），就无限调用自己。JSC 对严格模式的尾调用不加栈，所以不是爆栈而是卡死：旧脚本在子进程里 60 秒超时也没退出。之前的测试都传了 `log` / `error` 回调，所以没测出来。默认值改为 `console.error`；`log` 默认是 `console.log`，没有这个问题。
  - **找不到可执行文件**：`Bun.spawnSync` 遇到不存在的可执行文件直接抛错（ENOENT），不返回退出码，原来一路抛到入口、退出 1，和注释写的 2 不一致。现在 git 和 Biome 的启动都包一层，抛错转成内部失败、退出 2，报「启动不了 Biome / git」。
  - **测试**：新增 3 个子进程用例：`bun -e` 导入脚本、调用 `run()` 时不传回调，超时 60 秒，TMPDIR / TMP / TEMP 指到独立目录：
    - 有新增问题 → 退出 1，stderr 列出文件和 `noDebugger`；
    - 假 Biome 出错 → 退出 2，stderr 带原因；
    - 找不到 Biome → 退出 2。
    三个用例都断言没有残留的 `biome-base-*`。原「二进制不存在」用例改为断言 2。用旧脚本跑：前两个超时（退出码 null），后两个退出码 1；新脚本 8 个全过。

## Unreleased — test:app 测试干扰与过时测试（审查清单第 3 项第二部分）

### 动机

审查时记录 test:app 共享进程有 319 个失败。现在 main 上实测（Windows）：共享进程 1644 pass / 7 fail（212 个文件），隔离名单里 startup-resilience 1 fail；另有 5 个 server 测试单独跑也失败。

### 根因和改动

- **control-poll-single-source（干扰，2 个）**：`use-control.ts` 的 `listenForWake` 用模块级布尔值，只给第一个页面挂 focus/online/pagehide/pageshow 监听。GlobalRegistrator 每个文件换一个 happy-dom 窗口，并把新窗口的成员拷到同一个 globalThis 上，所以 `window` 看起来没变，`addEventListener` 和 `document` 却已经是新窗口的。监听永远挂在旧窗口上，后面的文件派发 focus 叫不醒 store。改为记住接监听时的 `window.document`，换了就重新挂；浏览器里页面不换，行为不变。
- **self-host-banner（app，干扰，1 个）**：`schedule-runs-query.test.ts` 用 `mock.module("@/lib/client")` 把 client 整个换成「永远返回一个日程」。Bun 的 mock.module 是进程级的，而且换不回来，排在后面的 self-host-banner 点关闭后，偏好被这个返回值覆盖，横幅又冒出来。改为在该测试里给 fetch 打桩并在 afterEach 还原。
- **gateway-account-control（单独跑也失败，4 个）**：happy-dom 20+ 默认禁用 JS 求值，Bun 下 VM 上下文里也没有 `eval`。改为 `new Function("window", "document", script)` 执行登录网关脚本，并在 afterEach 关闭窗口（脚本起了 45 秒的 setInterval）。
- **startup-resilience（单独跑也失败，1 个）**：v0.1.102 起根组件还会请求 `/wallpaper_core.html`，覆盖了测试里挂起的 `/api/me` 回调。测试只挂起 `/api/me`，其余请求返回 404。
- **server 测试（与现行行为不符）**：
  - guards：`/api/me` 多了 `profileNeedsSetup`（bd06cf50）。
  - user-preferences-routes：默认偏好多了 `mainBotId` / `brandAccent` / `brandRest`（79f6bf71）。
  - approvals-frontend：报错文案已改成中文「活跃会话」。
  - self-host-banner：横幅不再是 createApp 的最后一个参数，改为按参数名找位置。
  - bot-lifecycle-audit：**测试过时，不是代码 bug**。a1b235fd 起机器人一律私有（`server/src/agents/routes.ts` 固定 `visibility = "private"`，DESIGN.md「所有的机器人都是私有」），审计记录存下来的值 private 是对的。
- **server/package.json**：`local-conversations-inbox.integration.test.ts` 直接 import `@copilotkit/core`，补成 devDependency，版本取 lock 里已有的 1.77.0。
- **app/vite.config.ts**：chisabot-node 打包失败时，在 CI（环境变量 CI 非空）里直接让构建失败，其他地方照旧只告警。默认 isolated linker 下 `ws` 解析不到会静默跳过；CI 与镜像一样用 hoisted，在这里失败就说明镜像也会缺文件。本机和 Docker 构建行为不变。
- db-client-address 需要真实数据库，按要求跳过。

- 追加（小爱复查）：Linux 共享进程里 `agent-roster-error.test.tsx`「each Bot on /bots links to its profile and to its chat」挂，原因是 `schedule-fired.test.tsx` 把 `@tanstack/react-router` 的 `Link` 进程级地 mock 成丢掉 aria-label 的 `<span>`。已把它加进 `scripts/run-app-tests.ts` 的隔离名单，并把替身改成把所有 props 透传给 `<a>`（href = href ?? to）。两份文件同进程两种顺序都过，全量 `test:app` 通过。
- 追加（第二次复查）：
  - **schedule-fired 的 Link 替身**：上一版替身直接把 `to` 当 href，没用 params 填 `$agentId`；能过只是因为进了隔离名单。用 `bun test A B` 实测，bun 按命令行给的顺序跑文件：schedule-fired 在前时，agent-roster-error 期望 `/bots/mine-1`，实际拿到 `/bots/$agentId`。现在替身先 `useRouter({ warn: false })`：有 RouterProvider 就直接渲染真 `Link`（mock.module 会原地改写模块命名空间，所以 mock 之前先存住真的 `Link` / `useRouter`）；没有路由（本文件就是）才渲染 `<a>`，props 透传，href 用 params 填路径参数。已从隔离名单移出，两种顺序同进程都过。
  - **avatar-picker-shape 的 2 个 Unhandled error**：报错其实是 `window is not defined`（react-dom 在被动 effect 回调里读 `window.event` 时 window 已经没了），不是 window.event 的定义问题。最后一个用例被 cleanup 卸载时，React 已经往调度器排了被动 effect 回调（bun 下是 setImmediate）；`afterAll` 紧接着 `GlobalRegistrator.unregister()` 删掉了 window，回调晚一拍才跑。其他 React 测试文件都在 unregister 前 `await settleReactWork()`，这份漏了。补上后错误消失，没有屏蔽任何错误。
  - 验收：`bun run test:app` 和 `CI=1 bun run test:app` 都 0 失败、退出码 0。

## 2026-10-29 修复干净安装：补声明 @json-render/* 等缺失依赖（分支 fix/json-render-deps）

### 动机

- main 干净安装时是坏的：全新克隆后执行默认 `bun install`（Bun 1.3 对 workspaces 默认使用隔离 linker），`bun run typecheck` 在 server 阶段即失败：
  `shared/json-render/catalog.ts: Cannot find module '@json-render/core'`、`'@json-render/react/schema'`，`empty-sections.ts`、`panel-title.ts` 同样报错。
- 原因：`shared/` 不是 workspace，由 app 与 server 以相对路径引入。隔离 linker 下其中的裸导入只会沿目录向上解析到根 `node_modules`，而 `@json-render/*` 只在 app/server 的 package.json 中声明，根没有。hoisted linker 会把它们提升到根，所以此前只有 `--linker hoisted` 能跑通。
- 修好 server 之后，app typecheck 在隔离 linker 下暴露了同类问题：`app/tests/*` 直接 import `@ag-ui/client`、`rxjs`，`app/vite.config.ts` 构建时动态 `import("esbuild")`，但 app 都没声明它们（以前靠 hoisted 从别的包间接拿到）。esbuild 这一步包在 try/catch 里，解析失败时会被静默跳过，构建产物会缺少 pc headless 脚本。

### 改动

- 根 `package.json` 的 `dependencies` 增加 `@json-render/core`、`@json-render/react`，版本 `0.21.0`，与 app/server 及 lockfile 中已解析的版本一致。
- 这沿用仓库已有约定：`shared/` 用到的第三方包（`css-tree`、`parse5`、`zod`）本来就声明在根 `package.json`。没有把 `shared` 改成独立 workspace 包，以免改动所有相对导入路径和 workspace 配置。
- `app/package.json` 的 devDependencies 增加 `@ag-ui/client` 1.0.1、`rxjs` 7.8.1、`esbuild` 0.28.2，均为 lockfile 中已解析的版本：前两者与 server 的声明一致，esbuild 与 vite 实际使用的一致。只有测试和构建配置用到它们，所以放在 devDependencies。
- `bun.lock` 只在 workspace 声明区增加上述条目，没有新增或变更任何包解析结果，`bun install --frozen-lockfile` 可以通过。
- 未修改任何版本号。

### 验证

- 全新克隆、不复制 node_modules，用默认 `bun install` 与 `bun install --frozen-lockfile` 安装后，`bun run typecheck`、server build、app build 全部通过。
- 已知遗留（不在本 PR 范围）：`pc/` 是独立的 npm 项目（自带 package-lock，不在 Bun workspaces 内）。如果没有单独在 `pc/` 执行安装，app build 中 best-effort 的 chisabot-node 打包步骤会因解析不到 `ws` 而打出 warning 并跳过，但 app build 本身仍然成功。本 PR 修复后，这一步至少能加载 esbuild，并给出明确的跳过原因。

## 2026-10-29 出口过滤代理按 Bot 独立鉴权（分支 `fix/egress-auth-hardening`）

### 动机

审计（2026-10-28）H1 / L1：

- 出口过滤代理（agent-computer 内 127.0.0.1 上的 HTTP 代理）所有 Bot 共用同一个密钥，且 `botFromProxyAuthorization` 在密码为空时直接放行：任何进程写 `http://<别的botId>:@127.0.0.1:<port>` 就能按别的 Bot 的放行名单出网（v0.1.93 起 shell 本身就是这么发的）。
- 无凭据连接按「本机所有 Bot 策略」判定，单 Bot 电脑上等于按那个 Bot 判定。
- `0.0.0.0/8`、`100.64.0.0/10` 不在硬拒绝网段内。
- 服务器发往电脑 `/exec` 的 body 一直不带 botId，服务器发起的命令实际都走无凭据路径。

### 改动

- `agent-computer/src/egress.ts`
  - `botProxyKey`：HMAC-SHA256(进程内随机主密钥, `chisabot-egress-proxy:v1:` + botId)；`egressFor`（浏览器）与 `egressShellEnvironmentForBot`（shell）都用它。
  - `proxyCallerFrom`：凭据三态。无头 → anonymous；正确派生密钥 → bot；其余（非 Basic、无 botId、空密码、错误密码、A 冒充 B）→ rejected，直接 403，不降级。
  - `anonymousPolicies` / `ANONYMOUS_EGRESS_POLICY`：无凭据的独立兜底，只放行 `DEFAULT_EGRESS_DESTINATIONS`；只读各 Bot 的 mode 做上限（任一 `allowlist_only` / `deny_all` 即拒绝），从不读任何 Bot 的 rules，不用 Bot 的上游代理。集中在一个函数里，方便以后改成直接拒绝。
  - `noteAnonymousEgress`：节流日志 `EGRESS_ANONYMOUS`（每 60 秒逐条最多 5 条，其余计数），只记来源 socket 与目标 host:port，不记凭据。
  - `ALWAYS_DENIED` 新增 `0.0.0.0/8`、`100.64.0.0/10`。
- `agent-computer/src/index.ts`：`/exec` 在 body / query 无 botId 时回退到 `x-chisabot-bot-id` / `x-openbot-bot-id` 头，不回退到 `DEFAULT_BOT_ID`。
- `server/src/computer/gateway.ts`：`runCommand` 发往 `/exec` 的 body 带上网关自己的 `botId`。
- 测试：新增 `agent-computer/tests/egress-auth.test.ts`；更新 `egress-policy.test.ts`、`server/tests/command-timeout.test.ts`。

### 兼容

- 不新增环境变量；主密钥每次进程启动随机生成、只在内存。电脑重启后旧代理凭据失效。
- 不升版本号。

## 2026-10-29 — 安装版 `/api` 代理的 Content-Encoding

**动机**：性能实测（`chisabot-perf-2026-10-28`）发现，本地用 `bun serve.ts` 时 `/api/me` 直接失败，浏览器报 `ERR_CONTENT_DECODING_FAILED`。原因是 Bun 的 `fetch` 会自动解压上游 gzip 响应，而 `app/serve.ts` 把上游 `Response` 原样返回，保留了 `Content-Encoding: gzip` 和压缩后的 `Content-Length`。安装版 PC 客户端走的就是 `serve.ts`。

**改动**：

- 新增 `proxiedResponseHeaders()`：复制上游响应头，删掉 `content-encoding`、`content-length`，以及逐跳头 `transfer-encoding`、`connection`（及其列出的头）、`keep-alive`、`proxy-connection`、`trailer`、`upgrade`；`Set-Cookie` 用 `getSetCookie()` 逐条追加，多值不合并。
- `/api` 转发改为用上游的 body / status / statusText 和上述头重新构造 `Response`，body 仍是流式，不缓冲。
- `app/tests/serve.test.ts` 新增两条测试：头过滤单测；起一个返回 gzip 的上游假服务器，经真实 `serve.ts` 进程代理后，客户端能解析 JSON、无 gzip 编码头（含关闭自动解压直接读原始字节）、两条 `Set-Cookie` 都在。

**未改**：WebSocket 转发、静态文件、版本号。

## 2026-10-29 发版 0.1.104

**合并的 PR**（按顺序，全部为 merge commit，未 rebase）：

- #365 `fix/json-render-deps` → `1c82f69`：干净安装（Bun 默认隔离 linker）下 `shared/json-render` 解析不到 `@json-render/*`，app 测试 / `vite.config.ts` 用到的 `@ag-ui/client`、`rxjs`、`esbuild` 也没声明，typecheck / build 只能靠 hoisted linker 才过；补声明，lockfile 解析结果不变。
- #364 `fix/egress-auth-hardening` → `6b155c8`：审计 H1 / L1——出口过滤代理原来所有 Bot 共用凭据，空 / 错密码会降级放行；改为 HMAC 派生的每 Bot 密钥，伪造一律 403，无凭据连接走不含 Bot 放行名单的兜底策略，硬拒绝补 `0.0.0.0/8`、`100.64.0.0/10`。
- #363 `perf/ui-render-budget` → `079c3aa`：性能审计发现卡顿主要来自同屏 14 层毛玻璃、空闲时也满帧重画的 WebGL 天空、驱动 layout / paint 的无限动画；收到渲染预算内（桌面同屏模糊层 14 → 4），不改布局和配色。
- #367 `fix/serve-proxy-content-encoding` → `0f0e356`：安装版 `app/serve.ts` 把 Bun 已解压的响应仍带着 `Content-Encoding: gzip` 转发，`/api/me` 报 `ERR_CONTENT_DECODING_FAILED`；转发前去掉编码 / 长度和逐跳头。
- #369 `feat/hark-tokens` → `8a93056`：Hark 改版第 1 步，只落令牌（深 / 浅两套、Inter Variable、唯一玻璃材质 `.glass`），玻璃参数沿用 #363 的预算。原 base 为 `perf/ui-render-budget`，#363 合入后改 base 为 main，diff 只有本 PR 的两个提交。

**冲突**：#364、#363、#367、#369 与 main 只在 `CHANGELOG.md`、`docs/CHANGELOG.md`（及 #364 / #367 的 `docs/DEVLOG.md`）冲突，均在 merge commit 里保留双方条目；DEVLOG 去掉了 #367 带来的重复一级标题。没有代码文件冲突。

**验证**：合并后的 main 上干净安装（`bun install --frozen-lockfile`）后 `bun run typecheck` 通过；相关测试（render-budget、sky-window、serve、egress-auth、egress-policy、command-timeout）109 pass / 0 fail。

**版本**：根、`app`、`server` 升到 `0.1.104`；PC / Android 不变（五个 PR 均未改 `pc/`、`android/`）。不打 tag、不发 Release。

**部署**（2026-10-29 04:10–04:22 北京时间）：部署前手动跑 `backup.sh`（`daily/20261029.dump`，767 条目）；`deploy-serial.sh ed93b05` 全量构建，镜像 `local/chisabot:auto-202610282010-ed93b05`，`/api/version` 为 `0.1.104` / `ed93b05`。`health.sh` 通过（容器 healthy、本机 `/health` 200、公网 `/login` 200），`request.sh smoke` PASSED（admin 模型自检 `ok:true persisted:false`），sidecar 隔离 ALL GREEN，未回滚。回滚目标 `auto-202610281801-d6cd2ec`；保留镜像：当前（即 BASE_IMAGE）ed93b05、上一版 d6cd2ec、`keep-628d527`，48edb21 已被 updater 按 `KEEP_IMAGES=1` 清理。

## 2026-10-29 发版 0.1.105

**合并的 PR**（按小爱给的顺序，全部为 merge commit，未 rebase、未强推；合并前核对 head 与审查时一致）：

- #368 `fix/test-isolation`（head `9c86a88`）→ `bcae53b`：修 `test:app` 共享进程里的测试互相干扰和 5 个过时的 server 测试，`test:app` 退出码恢复 0。与 main 无冲突，直接合并。
- #366 `fix/ci-biome-tests`（head `76c36bc` → `7f4f213`）→ `eaad514`：CI 新增 Biome「只拦新增问题」、完整 `test:app`、pc/ 独立安装 + chisabot-node 打包三道检查。
- #372 `fix/nginx-realip-gateway-replay`（head `5b2a2ae` → `f654611`）→ `7abf37f`：审计 #5——公网 nginx 只信任 Cloudflare 网段给的 `CF-Connecting-IP`，每个转发清掉客户端自带的 `CF-Connecting-IP` 并设 `X-Real-IP`；网关身份头加一次性随机数防重放。
- #373 `fix/sw-auth-navigation`（head `0ab4fb9` → `4114b19`）→ `d2387db`：sw.js 关掉 navigation preload（`SW_VERSION` 3），修 Chrome 登录回调被发两次导致的 `state_mismatch`。

**冲突**：#366、#372、#373 与 main 只在 `CHANGELOG.md`、`docs/CHANGELOG.md`、`docs/DEVLOG.md` 冲突。按要求把 origin/main merge 进 PR 分支、两边条目都保留、普通 push 到 PR 分支后再合并，所以这三个 PR 的 head 多了一个合并提交（见上）。没有代码文件冲突。

**验证**：合并后的 main 上 `bun install --frozen-lockfile`、`bun run typecheck`、`bun run build` 通过；本次改动相关测试（gateway-identity、im-onebot-rate-limit、trust-boundary-redline、guards、self-host-banner、user-preferences-routes、approvals-frontend、bot-lifecycle-audit、auth accounts、biome-new-issues、sw-navigation）142 pass / 0 fail。`bun run test:app` 在 Windows 本机负载较高时有 2 个用例超 5 秒默认超时（brokered-account-row、form-submit-controls，这一版都没改到），单独以 60 秒超时重跑 43 pass / 0 fail。

**版本**：根、`app`、`server` 升到 `0.1.105`；PC / Android 不变（四个 PR 均未改 `pc/`、`android/`）。不打 tag、不发 Release。

## 2026-10-29 — 手机尺寸左栏抽屉改成 Hark 的一层面板

**动机**：0.1.104 的 PC 小窗（420×860）反馈截图里，抽屉是「半透明白色外板 + 里面一张圆角卡片」，两层边缘都看得见；里面的卡片不到底，账号卡单独漂在下面、中间有缝；右侧没有压暗；关闭按钮单独浮在右上角，上面空一大块。目标是 Hark 手机端的样子：一层面板、一排顶栏、底部账号、右侧压暗。

**改动**：

- `ui/sidebar.tsx`：手机抽屉宽度变量改成 `min(85vw, 320px)`；抽屉元素加 `glass hk-drawer`（`.glass` 是唯一的玻璃层），遮罩加 `hk-drawer-overlay`。`ui/sheet.tsx` 的 `SheetContent` 新增可选的 `overlayClassName`，只加在这块抽屉自己的遮罩上。
- `styles.css`：删掉两条旧的抽屉玻璃规则（各自写了 `rgba(…, 0.72 / 0.86)` 底 + `backdrop-filter` + 16px 内边距）、手机安全区内边距和 PC 下 `top: 40px` 的规则，在原位置（文件中段，不在 #374 追加的文件末尾）新增「手机尺寸左栏抽屉」一节：
  - 面板全高、贴左、`border-radius: 0 20px 20px 0`、内边距 0；里面的 `.glass-side-card` / `.acct-card` 把旧三档玻璃层读的 `--lg-surface` / `--lg-blur` / `--lg-shadow` 设成透明 / none（不加 `!important`），不再是第二层。
  - 顶部一行：关闭按钮绝对定位到搜索行右端（搜索行右侧留出按钮宽度），行的中线 = 顶栏按钮的中线（`--safe-t + (--glass-top − 44px) / 2`）；PC 客户端里这一行从 44px 开始，让开 40px 高的窗口按钮 / 拖动条。设置页的 `.rail-title` 同样处理。
  - 账号卡：同一块面板最下面，用内投影画 1px 分隔线（旧玻璃层把 `border` 锁成 0），底部 `8px + 安全区`。
  - 遮罩：`rgba(0,0,0,.32)`（深色 `.5`），`backdrop-filter: none`。
  - 动画：`transition-property: transform`、200ms，开始 / 结束态 `transform: translateX(-100%)`、`opacity: 1`；`prefers-reduced-motion` 下 `transition: none`。
  - 性能模式 / 减少透明度：面板 `rgb(246,247,250)` / `rgb(29,31,36)`，与 #375 `perf-noblur.css` 的 `--glass-bg-opaque` 同色，`backdrop-filter: none`。
- 没有新增 `:has()`，没有 `!important`。

**实测**（Chrome，真手机 390×844 触屏 2x、PC 小窗 420×860 带窗口按钮，本地假数据）：

| | 改前 | 改后 |
|---|---|---|
| 面板 | 0,0,288×844（PC 0,40,288×820），直角，内边距 12 / 16px | 0,0,320×844（PC 320×860），右侧 20px 圆角，内边距 0 |
| 模糊层 | 3（抽屉、列表卡、账号卡） | 1（抽屉 `.glass`） |
| 遮罩 | `rgba(40,60,90,.16)` + `blur(4px)` | `rgba(0,0,0,.32)` / 深色 `.5`，无模糊 |
| 顶部一行 | 关闭按钮单独一行（y=6 / PC 50），搜索在 y=84 / PC 120 | 搜索 + 新建 + 关闭同一行，手机 y=6（与菜单按钮同一条中线），PC y=44（窗口按钮下面） |
| 账号 | 浮在卡片下面（12,776,263×56） | 面板底部整宽（0,784,320×60），上方分隔线 |
| 性能模式 / 减少透明度 | — | 不透明底，0 层模糊 |

点遮罩关闭：手机（减少动态效果）和 PC 小窗都关上了。

截图（`docs/images/mobile-drawer/`）：

| | 改前 | 改后 |
|---|---|---|
| 手机 浅色 | ![](images/mobile-drawer/before-phone-light.webp) | ![](images/mobile-drawer/after-phone-light.webp) |
| 手机 深色 | ![](images/mobile-drawer/before-phone-dark.webp) | ![](images/mobile-drawer/after-phone-dark.webp) |
| PC 小窗 浅色 | ![](images/mobile-drawer/before-pcsmall-light.webp) | ![](images/mobile-drawer/after-pcsmall-light.webp) |
| PC 小窗 深色 | ![](images/mobile-drawer/before-pcsmall-dark.webp) | ![](images/mobile-drawer/after-pcsmall-dark.webp) |

**测试**：新增 `app/tests/mobile-drawer.test.tsx`（面板只有一层 `.glass`、遮罩存在、点遮罩关抽屉、抽屉规则不写模糊 / 里面卡片关掉旧玻璃层 / 遮罩不模糊、只动 transform 200ms、减少动态效果无动画、性能模式和减少透明度不透明）；`render-budget.test.ts` 的模糊名单删掉两条已经不模糊的旧抽屉选择器。

**未改**：桌面宽窗口的左栏、#374 改过的顶栏 / 左栏文件、#375 的 perf-noblur.css、版本号。

**部署**（2026-10-29 08:45–08:58 北京时间）：部署前在 Haupt 另做数据库备份 `/opt/chisabot-backups/pre-release/v0.1.105-20261029T002243Z.dump`（`pg_restore -l` 767 条目），备份网关 `nginx.conf`（`nginx.conf.bak-pre-v0.1.105-20261029T002243Z`），给 d6cd2ec 打 `local/chisabot:keep-d6cd2ec` 防清理。`deploy-serial.sh 3856d36` 全量构建（依赖有变），镜像 `local/chisabot:auto-202610290045-3856d36`（同时成为 BASE_IMAGE），`/api/version` 为 `0.1.105` / `3856d36`。

**网关 nginx（#372）**：deploy-serial 只做 `sync-nginx --check`，不会套用新模板，所以手动把仓库 `deploy/public/nginx.conf` 按线上域名 / 端口渲染（与渲染旧模板得到的线上配置逐字节一致，只多出 #372 的 59 行），写入挂载进 `chisabot-public-gateway` 的 `/opt/chisabot-zh/public/nginx.conf`，容器内 `nginx -t` 通过后 `nginx -s reload`（容器未重建）。`nginx -T` 与渲染结果 md5 一致：22 条 `set_real_ip_from`、`real_ip_header CF-Connecting-IP`、14 个转发都清 `CF-Connecting-IP` 并设 `X-Real-IP`。宿主机 `/opt/chisabot-ops/deploy/public/nginx.conf` 模板同步为 main 版（已备份）。

**检查**：`request.sh smoke` PASSED（admin 模型自检 `ok:true persisted:false`），`health.sh` 通过，公网 `/login` 200，sidecar 隔离 ALL GREEN，未回滚。reload 后 access log 里经 Cloudflare 进来的请求记的是真实客户端 IP（从 Ayase 经 Cloudflare 发的请求带 CF-RAY，日志里是客户端公网 IP），reload 前同类请求是 172.71.x / 104.22.x / 162.158.x 等 Cloudflare 节点；reload 后唯一一条 Cloudflare 地址是 reload 前建立、reload 后才关闭的 WebSocket。线上 `sw.js` 的 `SW_VERSION` 为 `"3"`（公网 `/sw.js` 需要登录，未登录 401；应用容器内和 :3001 取到的都是 3，网关对已登录客户端返回 200）。

**镜像**：当前（BASE_IMAGE）3856d36、上一版回滚目标 `auto-202610282010-ed93b05`、`keep-d6cd2ec`、`keep-628d527`。

**待办**：`deploy/public/auth/server.ts`（网关签身份头时加 `j`）属于登录服务，不随一键更新，这次没有手工部署 `chisabot-web-auth`；在它更新前，网关签的仍是不带 `j` 的旧格式，应用照旧放行，防重放实际上还没生效。另外宿主机 `/opt/chisabot-ops/scripts/ops/sync-nginx.sh` 是旧版（要求 `/_openbot/auth-check` 标记），`--check` 读的是 10-18 生成、未挂载的 `nginx.generated.conf`，没有反映线上真实配置，建议之后把宿主机 ops 脚本同步成 main 版。

## 2026-10-29 发版 0.1.106

- #370 `perf/thread-inbox-incremental`（head `47ea175` → `d554c24`）→ `6d91044`：对话记录 `…/threads/:id/messages` 支持 `since` / `cursor` 增量读，频道聊天页读历史和每轮结束后的顺序核对都改成增量；三张卡片的每秒计时器合并为共享时钟。

**冲突**：与 main 只在 `CHANGELOG.md`、`docs/CHANGELOG.md`、`docs/DEVLOG.md` 冲突，把 origin/main merge 进 PR 分支、两边都保留、普通 push 后再合并。没有代码文件冲突。

**版本**：根、`app`、`server` 升到 `0.1.106`；PC / Android 不变。不打 tag、不发 Release。

**0.1.106 部署**（2026-10-29 10:03–10:16 北京时间）：部署前在 Haupt 另做数据库备份 `/opt/chisabot-backups/pre-release/v0.1.106-20261029T020328Z.dump`（`pg_restore -l` 767 条目）。`deploy-serial.sh 0ba9676` 镜像 `local/chisabot:auto-202610290203-0ba9676`（同时成为 BASE_IMAGE），`/api/version` 为 `0.1.106` / `0ba9676`。`request.sh smoke` PASSED（admin 模型自检 `ok:true persisted:false`），`health.sh` 通过，公网 `/login` 200，容器 healthy、无重启，sidecar 隔离 ALL GREEN，未回滚。网关 nginx 配置未变（md5 与部署前备份一致），`nginx -T` 仍有 22 条 `set_real_ip_from`、`real_ip_header CF-Connecting-IP`。镜像清理：更新器已自动删除 `auto-202610282010-ed93b05`，手动删除 `keep-d6cd2ec`；保留当前（BASE）0ba9676、上一版 3856d36、`keep-628d527`。

## 2026-10-29 发版 0.1.107

- #378 `fix/mobile-drawer-hark`（head `c25464a` → `274ed1a`）→ `adbe51f`：手机尺寸左栏抽屉改成 Hark 手机端的一层全高面板。
- #380 `feat/hark-linkcard`（head `8975949` → `8747ef7`）→ `c5dcb0a`：链接卡照 Hark 改版，数据侧修正标题 / 预览图（GitHub 预览图）。

**流程**：先在临时 worktree 里本地试合并（PR 分支各自 merge 最新 main、再 `--no-ff` 合进 main，顺序 #378 → #380），`bun install --frozen-lockfile`、`typecheck`、`build`、`test:app`（222 个文件 1722 pass / 0 fail，退出码 0）全部通过后，才把 PR 分支普通 push、main 快进到本地验证过的合并提交，线上 main 树与验证结果一致。

**冲突**：两个 PR 与 main 都只在 `CHANGELOG.md`、`docs/CHANGELOG.md`、`docs/DEVLOG.md` 冲突，两边都保留；没有代码、package.json 或锁文件冲突。发版时去掉了从旧 PR 分支带回 Unreleased 的 #373 重复条目（它已在 0.1.105 发布）。

**版本**：根、`app`、`server` 升到 `0.1.107`；PC / Android 不变。不打 tag、不发 Release。

**0.1.107 部署**（2026-10-29 12:07 北京时间开始）：部署前在 Haupt 另做数据库备份 `/opt/chisabot-backups/pre-release/v0.1.107-20261029T040728Z.dump`（`pg_restore -l` 767 条目）。`deploy-serial.sh 6790ef7` 镜像 `local/chisabot:auto-202610290407-6790ef7`（同时成为 BASE_IMAGE），`request.sh smoke` PASSED（admin 模型自检 `ok:true persisted:false`），`health.sh` 通过，公网 `/login` 200，容器 healthy、无重启、日志无错误，sidecar 隔离 ALL GREEN，未回滚。网关 nginx 配置未变（22 条 `set_real_ip_from`、`real_ip_header CF-Connecting-IP`）。镜像：更新器已自动删除 3856d36；保留当前（BASE）6790ef7、上一版 0ba9676、`keep-628d527`。
