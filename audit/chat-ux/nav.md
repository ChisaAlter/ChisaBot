# Navigation audit — where the chat is remounted, re-joined or re-read

Read-only audit. No source file was modified. Scope = exactly the mount/render surface of the chat on
(a) bot switch from the left rail, (b) leave to `/settings` / `/approvals` and come back
(`返回聊天` / rail click / browser Back), (c) `/channel/new` → `/channel/:id` after the first message.

Siblings already own two adjacent surfaces and are cited rather than repeated:
`audit/chat-ux/composer.md` (composer repaint / remount table M1–M8, H6),
`audit/chat-ux/scroll.md` (anchor/scroll engine, D1–D7).

Runs (single file at a time, as instructed):

| command | result |
|---|---|
| `cmd /c "bun test app/tests/keep-alive.test.tsx"` | 13 pass / 0 fail (exit 1 is the `cmd` stderr artefact, not a failure) |
| `cmd /c "bun test app/tests/conversation-sync.test.ts"` | 15 pass / 0 fail |
| `node tests/nav-keep/nav.mjs` | needs a live preview server — **not run** in this environment |

---

## 1. What must NOT happen (invariants)

| # | Invariant | Asserted by |
|---|---|---|
| I1 | Going to another page must **keep the chat instance**: same `ChannelPage`, not unmounted, just hidden (`inert`, `aria-hidden`, frozen width+height). | DESIGN §98.2 (`DESIGN.md:2173-2180`: "回来 = 同一个实例变回可见：0 次整页加载、0 次接入、0 次读历史、0 帧骨架"). Unit: `app/tests/keep-alive.test.tsx:62-89` ("离开聊天再回来：同一个实例，不卸载、不重新挂载"), `:127-142` (route layer never remounts). E2E: `tests/nav-keep/nav.mjs:183-186`. |
| I2 | Coming back must **not re-connect** (`connectAgent` / replay). | `tests/nav-keep/nav.mjs:242` (`connects === 0`. "回来不重新接入 / 读历史"). DESIGN §98.1 (`DESIGN.md:2171`) records what a re-connect costs. §64 (`DESIGN.md:1253-1265`, esp. 64.1 `:1257` / 64.3 `:1261`) defines when a re-join *is* allowed: only when the stamp says the server is answering (or the seq changed). |
| I3 | Coming back must **not re-read history** (`GET /api/copilotkit/threads/:id/messages`). | `tests/nav-keep/nav.mjs:188` (`msgReads === 0`). DESIGN §83.2 rule 4 "不重复读" (`DESIGN.md:1732`). |
| I4 | Coming back must **not move the transcript** (no content swap, no scroll change, first frame identical). | `tests/nav-keep/nav.mjs:186-187` (`moves === 0`, first-paint position kept). DESIGN §98.5 (`DESIGN.md:2193-2199`); unit `app/tests/keep-alive.test.tsx:259-275` (scroll hold). |
| I5 | Opening / switching a conversation must **not present a turn as running** (send button → ■ 停止, "思考中" row, roster busy dot) unless this client can actually stop something. | **No test.** Only prose: DESIGN §98.1 (`DESIGN.md:2171`) names the symptom as the thing §98 removed, and §98.2 (`:2176`) claims it is gone. Violated today — P1. |
| I6 | Opening a conversation paints the **cached** transcript, then swaps **once** to the agent's copy. | DESIGN §83.1/§83.2 rule 1 (`DESIGN.md:1721`), §83.4 (`:1746`). No unit test covers the pre-restore source selection — violated today, P2. |
| I7 | Per-channel UI state must not survive into another channel (the chat of channel B must not restart from channel A's dialog/refs). | DESIGN §98.4 asserts only `ChannelChat`'s key (`app/tests/keep-alive.test.tsx:172-173` checks `RegisterBotChat` visibility, nothing about `ChannelPage` state). Violated today — P3. |

---

## 2. Trigger table

Legend: `CP` = `ChannelPage` (`components/channels/channel-page.tsx`), `CC` = `ChannelChat`,
`TR` = `ChatTranscript`, `Co` = `Composer`. "join" = `copilotkit.connectAgent` + `readThreadMessages`
(channel-chat.tsx:547-631).

| # | Scenario | Exact code path | Remounts CP / CC / TR / Co | Re-runs join (connect + history)? | Evidence |
|---|---|---|---|---|---|
| A | **Bot switch, rail click** A→B (both have channels) | `BotRow` Link → `/channel/B` → `ChatStage.useChatAddress` → `KeepAliveStage` render-phase `setKept` → same `CP` element with a new `channelId` → new query key + `placeholderData` → `ChannelBody` → `<CC key={channel.id}>` | **CP no · CC yes · TR yes · Co yes** | **join yes ×1** (mount effect). Store read also starts during CC's first render | Link `app-sidebar.tsx:374-387` (no `search` prop ⇒ the router drops the search, `router-core/dist/esm/router.js:332`); address `authed-shell.tsx:70-86`; `setKept` `keep-alive.tsx:49-53`; no key on CP `authed-shell.tsx:102-110`; placeholder `channel-page.tsx:74-77` + `queries.ts:105-117`; key `channel-page.tsx:268-274`; join `channel-chat.tsx:547-631` (`connectAgent` :555, `readThreadMessages` :573); early read `:434-440` |
| B | **Bot switch to a bot whose `计算机` was open** (`botUi(B).computer === true`) | A, then `useBotComputerTab` effect 2 fires `writeUrl(true, true)` because the new address has no `?watch` | CP no · CC no (second commit, same id) · TR/Co no | no | `use-bot-computer.ts:34-36`; `channel-page.tsx:128-137`; second `setKept` `keep-alive.tsx:50` |
| C | **`/settings` → `返回聊天`** | `to: "/"` → `ChatStage` address `null` + `idleVisible` true → `visible` true, `epoch+1` → `LandingRedirect` navigates to `/channel/A` **without search** → `?watch` gone → `useBotComputerTab` effect 2 `replace`-navigates `?watch=true` back | CP no · CC no · TR no · Co no | **no** (join effect deps unchanged: `channel-chat.tsx:624-631`; `useConversationSync` effect deps unchanged: `use-conversation-sync.ts:327`; only `kick()`: `channel-chat.tsx:644-655`) | `settings-sidebar.tsx:54`; `authed-shell.tsx:101`; `keep-alive.tsx:55-60`; `landing-redirect.tsx:42-47`; `use-bot-computer.ts:34-36`; history read is reachable **only** through the roster subscription `channel-chat.tsx:791-798` → `pull()` `:753-789` |
| D | **`/settings` → rail click, same bot, kept channel == `latestChannelFor(bot)`** | Link → `/channel/A` (search dropped) → address non-null, `visible` true, `epoch+1` → C's effect-2 navigation if the tab was open | none | **no** | `app-sidebar.tsx:374-387`; `latest.ts:8-18`; `keep-alive.tsx:55-60` |
| E | **`/settings` → rail click, same bot, kept channel ≠ `latestChannelFor(bot)`** (bot has several channels: 新话题, legacy `/bot` thread) | Link targets the most recent channel, not the one you left → different `channelId` → A's mechanics | **CP no · CC yes · TR/Co yes** | **join yes ×1** — you also silently land in a different conversation | `app-sidebar.tsx:698` + `latest.ts:8-18`; key `channel-page.tsx:272` |
| F | **`/approvals` → rail click** | `/approvals` is scope `"app"` (`glass-shell.tsx:79-83`), so the rail (and its socket) stayed mounted; only `visible` went false | same as C/D | no | as C/D. Contrast with settings: the socket is **torn down** there (see P6) |
| G | **Browser Back from `/settings` to `/channel/A?watch=true`** | the history entry restores the search, so no `?watch` drop, no effect-2 navigation | none | no | `keep-alive.tsx:49-60`; `use-bot-computer.ts:34-36` not entered (`watch === true`) |
| H | **`/channel/new?agent=X` → first message → `/channel/:id`** | `start` → create → `setQueryData(detail)` → `stashFirstMessage` → `navigate(replace)` → address `null`→`{id}` → `kept` was `null` ⇒ **CP mounts for the first time** → `CC` mounts → `takeFirstMessage` (destructive) → seed effect sends it | **CP yes (first mount) · CC yes · TR/Co yes** (the `/channel/new` ones unmount; `draftKey` `new:${agent}` → `channel.id`) | **join yes ×1** + one extra run for the seeded message | `new.tsx:144-162`, `:209`; `start.ts:22-32`; `keep-alive.tsx:49-53`; `channel-chat.tsx:420-423`, seed effect `:1597-1610` |
| I | **Return after > 10 min away** | TTL drops the kept page; the next visit is a fresh mount | **CP yes · CC yes · TR/Co yes** | **join yes ×1** + skeleton frames | `keep-alive.tsx:5,62-66` (documented in `DESIGN.md:2180`) |
| J | **`/` landing to a bot other than the kept one** (last-used / 主机器人 changed while away) | `idleVisible` false → kept stays hidden → landing target replaces `kept` | **CC yes** (different id) | **join yes ×1** | `landing.ts:25-35,51-59`; `authed-shell.tsx:96-101` |

Read-off:

* **C, D, F, G never remount and never re-join.** The §98 machinery does hold on the plain return path.
* Every path that ends in a **different channel id** (A, E, H, I, J) is a genuine `ChannelChat` remount and
  therefore a genuine join. A and E are the user's "bot switch"; I is the only *designed* remount on a
  plain return, and it is a 10-minute cliff.
* The reported "return also refreshes" is explained by I (TTL) or by B/C's extra location commit plus the
  join-flash of P1 when a hidden sync join is still open — **not** by a re-join on C/D/F/G (proven above).

---

## 3. PROVEN defects

### P1 — A join is presented as a running turn (send button → ■ 停止 on every remount)

**Mechanism (SDK level, proven).** `copilotkit.connectAgent` → `@copilotkit/core`'s connect wrapper sets
`agent.isRunning = true` before the stream starts and keeps it true through the replay
(`node_modules/@copilotkit/core/dist/index.mjs:70` fn, `:76` `agent.isRunning = true`,
`:128-131` `onReplayStarted → isRunning = true`); it is only cleared in `finalizeRun` (`:72-74`), i.e. when
the connect stream ends or is detached. `ChannelChat` joins in its mount effect (`channel-chat.tsx:555`)
and feeds that same `agent.isRunning` to five "a turn is running" consumers:

| consumer | line | visible effect during the join |
|---|---|---|
| `busy` | `channel-chat.tsx:1667` | "思考中" row when the last row is the user's (`chat-transcript.tsx:2894-2910`), `live` folding |
| `pending` | `:1758` | composer's `isBusy` (`composer.tsx:1173`): sends are parked/gated as if a turn were in flight |
| `stoppable` | `:1773-1775` | **primary button becomes 「停止机器人」** (`composer.tsx:1528,1536-1538`) |
| `useReportBusy('chat:…')` | `:1613` | "new version" refresh confirmation blocked |
| `chatBusy` → `reportChatRunning` | `:1615-1619` | roster / computer state says this chat is working |

So **A, E, H, I, J all look like "a message was just sent"**: Stop in the composer, thinking row, busy
roster. This is the exact symptom DESIGN §98.1 measured for the old remount path
(`DESIGN.md:2171`: "发送键闪成「■ 停止」约 0.3–0.8 秒") — §98 removed it for *page* navigation, but a bot
switch still remounts `ChannelChat`, so it is back on every switch. (Same finding as `scroll.md` D7; the
SDK citation and the fix scope below are new: it is not only `stoppable`.)

**Minimal patch** — one flag, used by all five consumers:

```tsx
// channel-chat.tsx
const [joining, setJoining] = useState(true);
// join effect's finally (:612-618), beside setRestoring(false):
if (current) { setRestoring(false); setJoining(false); openJoinGate.current(); }

const running = agent.isRunning && !joining;   // a real run, or a sync resume after the gate
// :1667  busy={running || turnsInFlight > 0}
// :1758  pending={running || turnsInFlight > 0}
// :1773  stoppable={running || runsInFlight > 0 || turnsInFlight > 0}
// :1613  useReportBusy(`chat:${channel.id}`, running || turnsInFlight > 0)
// :1615  const chatBusy = running || turnsInFlight > 0;
```

`joining` clears when the join gate opens (`:617`), which is exactly before the §64 sync `kick()`
(`:644-655`), so a later *resumed* run still shows Stop — which is correct.

**Risk.** A turn that is genuinely running and re-attached by the *mount* join (reload during an answer)
loses Stop until the sync join re-attaches it (≤2 s, `use-conversation-sync.ts:313`). Acceptable; if not,
gate on `joining && !awaitingReply.current`.

### P2 — The restore paints three different lists instead of one (`cached → early → agent`)

**Mechanism.** `cached` is snapshot once (`channel-chat.tsx:430-432`); an independent store read starts
during the first render (`:434-440`); when it resolves it calls `setEarly(...)` (`:449-454`) **and the
renderer prefers `early` over `cached`**:

```tsx
messages={transcriptMessages(restoring ? (early ?? cached ?? EMPTY_MESSAGES) : agent.messages, seed)}
//                                     ^^^^^^^^^^^^^^^ channel-chat.tsx:1674
```

Then the join effect merges the same read into the agent and flips `restoring` (`:573-581`, `:615`), so a
warm-cache open commits **twice** before it settles (cache → store read → agent copy). §83.1 promises one
swap ("完成后一次换成 agent 手里那份", `DESIGN.md:1721`) and rule 3 makes the cache the *first* frame
(`:1723`); `early` was meant only for "no cache, wait for the store". Effect: every bot switch / open
with a warm cache re-renders the whole transcript an extra time inside the restore window and can insert
rows the cache did not have *before* the agent copy lands. Scroll stays pinned by `hydrating`
(`chat-transcript.tsx:2940-2948`), so this is row churn + a second list identity, not a scroll jump — it
compounds `scroll.md` D6 (tail-first commits) and the first-paint cascade
(`chat-transcript.tsx:2992-3014`).

**Minimal patch:**

```tsx
messages={transcriptMessages(restoring ? (cached ?? early ?? EMPTY_MESSAGES) : agent.messages, seed)}
```

(one-line swap; `early` still covers the cold cache case). Delete `early` entirely only if you also drop
the `setEarly` `.then` at `:443-458`.

**Risk.** Low. The store read still reaches the transcript through the agent merge (`:579-580`), and `early`
stays as the cold-cache fallback (the `cached === null` case), which is the only case it was added for.

### P3 — `ChannelPage` has no key, so channel-scoped state crosses a bot switch

`KeepAliveStage` renders `<ChannelPage channelId={kept.channelId} …>` with no `key`
(`authed-shell.tsx:102-110`); `ChannelChat` below it *is* keyed (`channel-page.tsx:272`). Everything in
`ChannelPage` that is not derived from props therefore survives a channel change:

* `historyOpen` — reset only when the chat is **hidden** (`channel-page.tsx:147-149`). Switch bots with
  「历史对话」open and the dialog stays open, now fed by the **new** bot (`agentId` prop,
  `channel-page.tsx:198-206`): you see bot B's history list over bot B's chat without asking.
* `useComputerAutoWatch` refs — `runEpoch` / `dismissedEpoch` / `opening` / `auto` / `engaged` are never
  reset on `agentId` change (`auto-watch.ts:29-36,42-56`); a "dismissed this run" from A can suppress the
  auto-open of B's current run when the epoch numbers collide (both start at the same small integers).
* `useBotComputerTab`'s `previous` ref is guarded by `agentId` (`use-bot-computer.ts:43`), so *that* one
  is safe — do not "fix" it by keying the hook.

**Minimal patch** (one line, matches composer.md's recommendation "stop remounting the chat on a channel
switch" for the *other* direction — here we *want* the remount):

```tsx
renderKept={(kept, { visible, epoch }) => (
  <ChannelPage key={kept.channelId} … />
)}
```

Key by `channelId`, **not** by the whole address: `?watch` / `?settings` changes must keep the instance
(otherwise every computer-tab toggle would remount the chat).

**Risk.** `DetailPanel`'s `overlay` measurement and `MessageFind` re-run once per real channel change —
both already re-run today because `ChannelChat` remounts.

### P4 — `?watch` is dropped by the `/` hop, so the return path always performs an extra location commit

**Chain (proven).**
1. `返回聊天` goes to `/` (`settings-sidebar.tsx:54`), not to the remembered chat URL.
2. `LandingRedirect` then navigates with `{to, params, replace}` and **no `search`**
   (`landing-redirect.tsx:42-47`). TanStack Router's `buildLocation` returns `EMPTY_RECORD` when
   `dest.search` is falsy, then applies the destination's `validateSearch` to it
   (`@tanstack/router-core/dist/esm/router.js:332` + `applySearchMiddleware`: `if (!dest.search) return {}`).
   ⇒ `?watch`, `?settings` and `?message` are all gone on arrival (`chatSearchSchema`,
   `channel-page.tsx:34-43`).
3. `ChannelPage` returns with `watch === undefined`; `useBotComputerTab` reads the per-bot memory
   (`use-bot-computer.ts:22-23`) and, if the tab was open, **writes the URL back**:
   `useEffect(… if (agentId && open && watch === undefined) writeUrl(true, true))`
   (`use-bot-computer.ts:34-36`) → `navigate({search: prev => ({...prev, watch: true}), replace: true})`
   (`channel-page.tsx:128-137`).

Net: whenever 计算机 was open, a return from settings issues **two** location commits (the landing one and
the `?watch` replace) and a full shell re-render. No remount and no refetch (table row C), so it is not the
"refresh" — but it is a forced navigation the user did not ask for, it burns the `epoch` guard for nothing,
and it makes the `?watch` state look "self-healing" while `botUi` is briefly written to `false` and back
(`use-bot-computer.ts:29-46`).

**Minimal patch.** Carry the search through the return instead of re-deriving it. `footerLink` currently
takes `{label, to, icon}` only (`settings-sidebar.tsx:54`); widen it to `LinkOptions` (the `SectionRail` it
feeds already passes `linkOptions` per item, `:42`) and point it at the remembered location — `left-mode.ts`
already keeps the pathname **and** the search (`left-mode.ts:21-28`):

```tsx
const back = lastBotsLocation();
footerLink={{ label: "返回聊天", to: back?.pathname ?? "/", ...(back ? { search: back.search } : {}), icon: IconMessageCircle }}
```

(or, cheaper and independent: make `LandingRedirect` copy `watch`/`settings` from
`lastBotsLocation().search` when the target channel is the kept one). Then effect 2 has nothing to write
on the return path and can be narrowed to "only after a user action" (`setOpen` already writes the URL).

**Risk.** `?settings`/`?message` would also survive the return, which is probably what §84.5 already
promises ("直接回到上次停的那条对话（含查询参数）", `DESIGN.md:1764`).

### P5 — The rail row opens "the bot's most recent channel", not the conversation you left

`BotRow` links to `latestChannelFor(bot.id, channels.data)` (`app-sidebar.tsx:375-387`, `:698`), which is
"the channel with the greatest `lastMessageAt`" (`latest.ts:8-18`). A bot with more than one channel
(新话题 creates a new channel each time; legacy `/bot` threads are imported as channels) therefore does
**not** reopen the conversation you were in — table row E: full `ChannelChat` remount + join, and the
content is a different conversation. From the user's side ("切回 bot") this is indistinguishable from a
refresh that lost their place.

**Minimal patch.** Remember the opened channel per bot where the panel already remembers state, and let
the row prefer it:

```ts
// lib/chat/ui-memory.ts — BotUi gains `channel?: string`
// channel-page.tsx (already does this for threadUi at :88-92)
useEffect(() => { if (channel.data) setBotUi(agentId, { channel: channelId }); }, [agentId, channelId, channel.data]);

// app-sidebar.tsx BotRow
const latest = latestChannelFor(bot.id, channels.data);
const remembered = botUi(bot.id)?.channel;
const target = remembered && channels.data?.some(c => c.id === remembered) ? remembered : latest?.id;
```

**Risk.** A deleted channel would be remembered — the `some()` check above drops it.

### P6 — The channel-events socket lives inside the sidebar, so `/settings` tears it down and re-arms a roster refetch

`useChannelEvents()` is called from `AppSidebar` (`app-sidebar.tsx:647`), and `AppSidebar` is only rendered
by `LeftRail`; `/settings` and `/admin` swap in `SettingsSidebar` / `AdminSidebar` in the same slot
(`authed-shell.tsx:34-41`). So every settings round-trip closes the WebSocket (`use-channel-events.ts:288-294`)
and reopens it on return, and `onopen` unconditionally invalidates the roster
(`use-channel-events.ts:218-222`).

Consequence that reaches the chat: the invalidated roster refetch is the one thing on the return path that
can change the open channel's last-message signature, which is exactly the key of `ChannelChat`'s
roster-cache subscription (`channel-chat.tsx:791-798`) → `pull()` (`:753-789`) → **1–3
`readThreadMessages` + `setMessages` while you are looking at the transcript** — usually a no-op merge
(`mergeStoredMessages` returns the same array, `channel-chat.tsx:264`, so no commit), but on a thread whose
store copy is ahead it is a real re-render of the visible chat. On a quiet return the refetched values are
identical and `sameActivity` (`:127-138`) suppresses it entirely.

**Minimal patch.** Move `useChannelEvents()` (and optionally `usePrefetchBotChats`) up to
`ShellFrame` (`authed-shell.tsx:30-56`), where it outlives the sidebar swap; keep the roster UI where it
is. If it must stay, at least do not invalidate on `onopen` when the last close was a normal unmount.

**Risk.** One socket for longer = the roster is live in settings too (that is the point). No extra writes.

---

## 4. Verdicts on the eight suspected areas

**(i) `KeepAliveStage` render-phase `setKept`/`setEpoch` + frozen-size style — CORRECT, no defect proven.**
`setKept` (`keep-alive.tsx:49-53`) is a render-phase update of the *same* component, which React re-renders
before committing (legal, no warning); the `same()` comparator is module-stable (`authed-shell.tsx:88-89`),
so it cannot loop. `setEpoch` (`:55-60`) uses the standard "derive state from a prop change" pattern and
increments exactly on the hidden→visible edge (asserted: `keep-alive.test.tsx:88`). The frozen style
(`:115-122`) reads `size.current`, measured only while visible (`:68-84`); the width is frozen **and** the
height, so the `DetailPanel` container keeps its measured width (see viii). Only nit: if the window is
resized **while hidden**, the frozen box is stale for one frame on return; that is `scroll.md` D5's trigger,
not a nav defect.

**(ii) `ChannelPage` not keyed by `channelId` — REAL, P3.** Not a remount bug (a bot switch *should* reuse
the page), but channel-scoped state leaks: `historyOpen` (`channel-page.tsx:147-149`) and
`useComputerAutoWatch`'s refs (`auto-watch.ts:29-36`). `ChannelChat` underneath is correctly keyed.

**(iii) `useBotComputerTab` writing the URL on becoming visible — REAL but bounded, P4.** It does issue a
`replace` navigation on every return whenever the per-bot memory says 计算机 was open and the arriving
address has no `?watch` (`use-bot-computer.ts:34-36` → `channel-page.tsx:128-137`) — which is *always* the
case on the `返回聊天` path (P4 chain), and also right after a bot switch to such a bot (table row B).
It does **not** remount the chat and does not refetch: the address change is same-route, so `KeepAliveStage`
only replaces its `kept` object (`keep-alive.tsx:50`) and the epoch is unchanged. The epoch guard in effect 3
(`use-bot-computer.ts:39-46`) does hold on the hidden→visible commit — but **not** on the landing hop one
commit later (same epoch), where it briefly records `computer:false`; effect 1 (`:29-31`) re-asserts
`computer:true` once the URL arrives, so the memory is not permanently corrupted (verified by reading the
three effects together; no test covers it). The cost is the extra location commit, not a state loss.

**(iv) `useThreadActivity` kicking on return + `useConversationSync` re-joining — CORRECT on the plain
return; one caveat.** `useThreadActivity`'s effect does not depend on visibility (`thread-activity.ts:27-85`,
deps `[agentId, threadId]`); on return the only thing that happens is `kick()` → one `readSync`
(`:87-92`, `:59-64`), and the hidden poll had already been delivering every 10 s
(`HIDDEN_SYNC_INTERVAL_MS`, `:14`, `:34-41`). `useConversationSync` re-joins only when `seq` changed or
`running` is true (`use-conversation-sync.ts:291-320`), and its `last` baseline is *not* reset by hiding, so
a quiet return re-joins **zero** times. Caveat: while hidden, a `running:true` tick does `join("merge", true)`
(`:313`) — the connect sets `agent.isRunning = true` for its whole duration (P1), so if the user returns
inside that window the composer shows Stop and the transcript shows 思考中, which reads as "it refreshed
because I sent something". Fix P1, not this hook.

**(v) `ChannelBody key={channel.id}` — CORRECT.** `channel-page.tsx:270-274`. The key changes only when the
channel id changes, and the placeholder from the roster carries the same `id` and `threadId`
(`queries.ts:105-117`), so placeholder→detail does **not** remount. It is the *only* key in the chat tree
besides per-message keys (`chat-transcript.tsx`), which is right.

**(vi) `placeholderData: channelFromRoster` changing `threadId` — NOT a defect.** The placeholder is built
from the roster row, whose `threadId` is the same server field the detail returns (`queries.ts:105-117`,
`channelKeys.detail`), so the real data cannot change it and `useAgent`'s `threadId`
(`channel-chat.tsx:402-411`) never changes under a mounted `ChannelChat`. The placeholder's *absence* (row
not in the loaded pages) is the real gap — `ChannelBody` returns `null` for the round trip
(`channel-page.tsx:234`), already recorded as composer.md M1. Two more things the placeholder does change
without remounting: `active` and `lastMessageAt`, both read by `channelHistoryNotice` (`:844-851`) — safe.

**(vii) Any `key=` / conditional render that could swap the `ConversationView` subtree — one, and it is not
a key.** The subtree is `ChannelBody`'s three early returns: `isPending → null`
(`channel-page.tsx:234`), `error/!channel → ErrorCard` (`:235-255`), `multi-agent → notice` (`:258-266`).
All three unmount the whole `ConversationView` (composer, queue, scroll). `error` is reachable *while
mounted*: any invalidation of `channelKeys.all` (bot rename/delete: `lib/agents/mutations.ts:133`,
`lib/bot-lifecycle/mutations.ts:62`) that fails refetches into `channel.error`, and the card replaces the
live chat (`:213` passes `hasError`), losing the composer queue (`conversation-view.tsx:156`, whose unmount
cleanup releases the staged rows at `:277-286`) until a retry succeeds and `ChannelChat` mounts again
(new join). Low frequency, real. `DeleteBotDialog`'s own flow
navigates away first, so the common case is safe.

**(viii) Does going to `/settings` change `DetailPanel`'s measured width enough to flip `overlay`? — NO.**
`overlay = width < detailWidth + MIN_MAIN_WIDTH` = `width < 800` (`detail-panel.tsx:20-21,52-63`), measured
on the panel's own container. That container lives **inside** the kept page, whose width (and height) is
frozen to the visible value while hidden (`keep-alive.tsx:115-122`), so leaving removes the right rail and
the banner from the *main* pane without changing the panel's measured width. On return the frozen style is
dropped, the width is the same as before, and `overlay` does not flip. Even if it did, `{children}` (the
chat column) is rendered **outside** the `overlay ? <Sheet> : <motion.div>` branch (`detail-panel.tsx:66-68`),
so the branch swap cannot take the transcript or the composer with it (asserted for the narrow→wide→narrow
case: `app/tests/detail-panel.test.tsx:72-100`, `mounts === 1`). The one real cost of the frozen size is
that a window resize while hidden is not tracked (`scroll.md` D5/H2).

---

## 5. Hypotheses (not proven here) and exactly what would prove them

| # | Hypothesis | What would prove it |
|---|---|---|
| H1 | The user's "return from another page refreshes" is the **10-minute TTL** (I), not a re-join. | In a scratch preview build (not this tree), set `ttlMs` to 60 s, run `node tests/nav-keep/nav.mjs`, and compare `msgReads`/`connects` for a return at 30 s vs 90 s (`keep-alive.tsx:64` is the only line that has to change). |
| H2 | On the PC client the same complaint comes from **window focus/visibility**, not navigation: `focus`/`visibilitychange` → `useThreadActivity` `now()` (`thread-activity.ts:69-73`) → a join if the server says running. | Not reproducible here (no server). Prove with the sync endpoint's `running` sampled while the window is re-focused: if `running:true` is returned for an idle thread, the join (and P1's flash) fires on focus. |
| H3 | `takeFirstMessage` in a `useState` initializer (`channel-chat.tsx:420-423`) can eat the first message when the render is discarded/re-run (StrictMode dev double-render, or an error/Suspense retry above). | Render `<ChannelChat>` under `<StrictMode>` in a test with a stashed message and assert exactly one send and a non-empty transcript. Production builds do not double-render, so this is dev-only until proven otherwise. |
| H4 | A side effect of P6: because the socket is closed in settings, the left rail's unread dot and `busy` row are stale for the whole time you are in settings. | Manual: with another device sending to a channel, stay in `/settings` for a minute; the rail's dot appears only after the return refetch. (E2E `nav.mjs` cannot see this — it asserts request counts only.) |

---

## 6. Ordered, surgical fix set (all one- or two-line changes)

1. **P1** `joining` flag → `running` for `busy`/`pending`/`stoppable`/`useReportBusy`/`chatBusy`
   (`channel-chat.tsx:612-618, 1613-1619, 1667, 1758, 1773-1775`). This removes the "I just sent
   something" illusion from every remount, including the TTL return.
2. **P3** `key={kept.channelId}` on `ChannelPage` (`authed-shell.tsx:102-110`).
3. **P2** `cached ?? early` (`channel-chat.tsx:1674`).
4. **P4** carry the search through `返回聊天` (`settings-sidebar.tsx:54` / `landing-redirect.tsx:46`) and
   narrow `use-bot-computer.ts:34-36` to user actions.
5. **P6** move `useChannelEvents()` from `AppSidebar` (`app-sidebar.tsx:647`) to `ShellFrame`.
6. **P5** remember the opened channel per bot (`ui-memory` + `BotRow`), so "switch back to the bot" means
   the conversation you left.

Items 1–3 do not touch persistence, the server or any route; 4–6 are routing/plumbing only.

## 7. What is by design (do not "fix")

* A different channel id ⇒ `ChannelChat` remount + one join (A, E, H, J). `keep-alive.test.tsx:91-97`
  pins "the kept page is replaced, the page decides whether to remount".
* Board/right-rail hiding in settings, `mode` not changing in settings, and the chat being hidden not
  unmounted (`authed-shell.tsx:44-51`) — all asserted in `keep-alive.test.tsx:155-173`.
* The 10-minute TTL itself (`keep-alive.tsx:5`), if the product wants hidden chats to stop polling. Its
  *cost* (a full remount on a late return) is what item 1 of the fix set makes painless.
