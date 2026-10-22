# Chat transcript scroll / anchor engine + send path — code audit

Scope: `app/src/components/channels/chat-transcript.tsx` (scroll engine, 3611-line snapshot), `channel-chat.tsx` (busy / restoring / hydrate wiring), `conversation-view.tsx`, `lib/chat/{use-tail-first-mount,tail-first-paint,send-scroll,blank-release,ui-memory}.ts`, `components/ui/message-scroller.tsx` + the `@shadcn/react` primitive it wraps, `composer/queue.ts` (Queued rows only), DESIGN.md §35/§83/§88/§94/§98.5/§106.
READ-ONLY: no source file was modified. One test file was run (see §7).

**Line-number convention.** `chat-transcript.tsx` line numbers are the HEAD blob (`git show HEAD:app/src/components/channels/chat-transcript.tsx`) — verified to be line-for-line identical to the 3611-line snapshot I read for every symbol cited. Other files: working tree.

**⚠ The working tree was being rewritten during this audit.** `app/src/components/channels/chat-transcript.tsx` went 3611 lines (11:04) → 3659 (11:10:22) → 3444 (11:10:52) → 3484 (11:12:53) → 3676 (11:14); `DESIGN.md` changed at 11:07. Two intermediate saves were inconsistent and threw at module evaluation — `ReferenceError: hydrating is not defined` in `useSmoothSendScroll`, then `ReferenceError: useOpeningWindow is not defined` in `ChatTranscript` — so the transcript could not render at all in those states. By 11:12:53 the writer had a coherent version: a new `useOpeningWindow(hydrating)` (`:3341`, ref-based, no state) feeds `useSmoothSendScroll` and `useFreshAnchor`, and the added regression test `app/tests/chat-restore-anchor.test.tsx` passes (2/2, §7). That version is **uncommitted and still moving**; every citation below is the HEAD blob, which is where the defects are proven. Re-anchor by symbol name when reviewing the new file.

---

## 1. Engine map (one paragraph, for orientation)

`ChatTranscript` renders one `MessageScrollerContent` child list: `[chat-tail placeholder][rows…]`, plus a library-owned spacer appended last (`spacerClassName="order-2"`, `chat-transcript.tsx:3023`). `chat-tail` is `display:contents` and is **always the first element child** (`:3078`) — it carries the "Thinking"/"Stopped"/queued lines and the app's own blank row `.chat-slack` (`:3112-3118`). Three writers compete for `scrollTop`: (a) the **library**, which on any childList mutation looks for `data-scroll-anchor="true"` and aligns it, writes its own spacer height, and on content resize calls `scrollToEnd` or re-anchors; (b) **SettleAtEnd**, which owns `.chat-slack` (`height` or `flex:1 0 0` + `min-height: max(100%, floor)`), writes `scrollTop` directly in ~8 places, and pins to the bottom for 2.5 s after a restore; (c) **useTailFirstMount / useKeepBottomOnPrepend**, which write `scrollTop` and change the mounted row window over several rAF commits per open.

---

## 2. Transition table

"slack" = `.chat-slack` height; "floor" = `content.minHeight`; "anchor" = `data-scroll-anchor="true"` on one row. px figures are **derived** (no browser/DB here) or quoted from DESIGN measurements, marked [§].

| # | Transition | What the engine does (fn → writes) | Visible effect | Verdict | file:line |
|---|---|---|---|---|---|
| 1 | **Mount with cached transcript** (bot switch, `ChannelChat key={channel.id}` remount; cache from `rememberTranscript`) | `useState` reads `threadUi(scrollKey)`; `restoring` starts `true` → `hydrating=true`; SettleAtEnd `until=∞`, `baseline` = cache's newest user id (`:683-696, 725-733`); `useTailFirstMount` restarts (`use-tail-first-mount.ts:38-49`) and rAF-mounts 36 → +28 rows/frame (`tail-first-paint.ts:11-17`, `use-tail-first-mount.ts:93-114`); first render rows get the 12×40 ms `Arriving` cascade (`:1379-1380, 1394-1415, 1441-1485`) | Transcript appears at the bottom, then rows above fade/slide in over ~0.4–0.6 s; 2–6 extra layout commits; no smooth scroll (quiet) | by design §83.2/§83.3 for the paint; **defect D6** for the multi-commit catch-up | `channel-chat.tsx:430-432, 1672-1677, 1767`; `chat-transcript.tsx:683-696, 2930-2936, 3078` |
| 2 | **Mount with no cache** (reload — the transcript cache is in-memory only, `transcript-cache.ts:13`; >12 threads; thread evicted) | `messages` = `early ?? cached ?? EMPTY`; while the 4 s read is pending the list is empty (`restoring=true`); on the read landing, `early` fills the list → `baseline` follows (`:3337-3340`); at restore end, `messages` swaps to `agent.messages` in the **same commit** as `hydrating:false` (`:3341`) | Skeleton → history appears; if the read *times out* (`thread-messages.ts:65`) `early` never fills, baseline stays `null` → the first history row is treated as a send → **H1**: anchor + 1/3 park + 2/3 blank (see §4) | defect (H1) | `channel-chat.tsx:506, 570-581, 1672-1677`; `chat-transcript.tsx:3328-3345, 2961-2963` |
| 3 | **Restoring `true→false`** | SettleAtEnd `else if (s.wasHydrating)`: `until = now + 2500`, `baseline = newest`; drops remembered slack when idle (`:731-741`); `useSmoothSendScroll` quiet for this commit (`:2651-2666`); `unanswered` card becomes eligible (`:2795-2799`) | Instant settle to bottom; a "已停止 / no answer" card may pop in at the tail; any row whose id appears/disappears unmounts/remounts and re-runs `Arriving` (0.2 s fade + 8 px slide, `ENTRANCE_SECONDS`) | by design §83.2 (pin), §93.4 (slack drop); re-animation of history rows is a defect (D1-adjacent) | `chat-transcript.tsx:731-741, 2795-2799, 1441-1485`; `lib/motion.ts:18` |
| 4 | **Restore ends after a failed/timed-out read** (`stored.availability === "unavailable"`) | `setRetryingHistory(true)` in the same tick as `setRestoring(false)` (`channel-chat.tsx:592-609, 615`); `restoring` prop = `restoring \|\| retryingHistory` (`:1766`) ⇒ the `messages` ternary flips **back** to `early ?? cached ?? EMPTY` (`:1672-1677`) | The just-restored replay is **replaced by an empty list → skeleton** for 1.5–15.5 s until a retry succeeds; then history refills | **defect D2** | `channel-chat.tsx:522, 592-609, 1672-1677, 1766`; `chat-transcript.tsx:3123` |
| 5 | **New user message, page-turn** (idle >30 min, first message, or `takeSendWhileBusy` stale) | `useFreshAnchor` returns the id (`:3341-3382`) → row gets `scrollAnchor` (`:3261-3265, 3280-3285`); SettleAtEnd layout effect pads slack to 2/3 viewport (`:784-817`); `useSmoothSendScroll` sets `scroll-behavior:smooth` for 700 ms (`:2666-2669`); library finds the anchor in its microtask and aligns it to `scrollMargin` = `paneHeight/3 − 48` (`:2993-3008, 3013`), writes its spacer | One smooth move of up to ~2/3 viewport; question lands ~1/3 from top with 2/3 blank below (measured 218 px target / 267 px spacer at 583 px viewport [§94.7]) | by design §94.7/§35 | `chat-transcript.tsx:2638-2676, 2938-2963, 3008-3014`; DESIGN §94.1 |
| 6 | **New user message, continuous** (<30 min or answer running) | No anchor; `sendMode.continuous` → SettleAtEnd converts the library spacer into slack, `scrollToEnd`, then restores `scrollTop` if unchanged (`:746-783`) | Screen does not move; the new bubble eats the blank; bottom follows afterwards | by design §94.2/§94.7 | same |
| 7 | **Assistant text grows** (chunk) | `MutationObserver` with `characterData:true` (`:1297-1307`) → `pinNow` (`:1069-1123`): consumes slack by `grew`; when slack is empty, library `handleResize` → `scrollToEnd` (following-bottom) **or** re-anchor the question if mode is `anchored-to-message` | No movement while slack lasts; then either bottom-follow (continuous) or the question stays at 1/3 and the answer streams below the fold (page-turn) | by design §94.6 / §94.7 | `chat-transcript.tsx:1025-1057, 1099-1109, 1297-1307`; dist `Ce`/`Te` |
| 8 | **Tool row appears / work card live→done** | Row appended (`renderRow:3217-3252`); `compactTurns` may hide the process line (`:3443-3583`) → row folded 220 ms (`:3206-3215`; `styles.css:7496-7513`) or unmounted if never shown (`:3129-3134`); height delta goes through `pinNow` | Row grows then shrinks; if at bottom, slack absorbs it; folding animates 220 ms; if not at bottom and slack=0, browser clamps `scrollTop` and `onScroll` re-pads (`:1139-1155`) | by design §88.1/§82.9 | `chat-transcript.tsx:1099-1121, 2850-2869, 3206-3215` |
| 9 | **Turn ends (busy true→false)** | `live` false → `compactTurns` retones last answer to `final`, adds `hidden`, work card collapses; `releaseRef` moves the library spacer into slack, `scrollToEnd`, restores `scrollTop`, then eases slack to 0 in rendered frames (`:1230-1292`, `blank-release.ts:8-17`); retries every frame up to 30 if the scroller is still aligning (`:855-871`) | Up to ~1 viewport of blank removed over ~0.3–1 s, transcript slides down to normal bottom padding | by design §93.3/§93.4 | `chat-transcript.tsx:854-871, 1230-1292` |
| 10 | **Queued row parked / removed** | `ScrollNewestQueuedIntoView` → `scrollToEnd()` whenever `queued.at(-1).id` changes (`:606-617`, used `:3177`); row renders inside `chat-tail` (order-1, under the messages) | **Instant jump to the bottom regardless of where the reader is**; also fires on removal (newest changes) | **defect D3** | `chat-transcript.tsx:606-617, 3097-3108, 3177` |
| 11 | **Anchor expiry (3 s)** | `useFreshAnchor`'s own `setState` (`:3373-3381`) re-renders the tree; the row's `data-scroll-anchor` flips to `"false"` | No scroll (attribute-only mutation; the library observes childList only) | by design §88.1(3) | `chat-transcript.tsx:3303-3304, 3367-3381` |
| 12 | **Width resize** (right-rail drag, window width, side rail collapse) | `reflowed()` compares `content.clientWidth` (`:982-996`): clears floor + slack, syncs `lastHeight`, `stickToBottom()` if it was at the bottom (`:1001-1007`), or leaves the position to Chrome's scroll anchoring when mid-history | Documented fixed: content 6362→7749→6362, slack ≤1 px, mid-history shift 0 px [§106] | by design §106 | `chat-transcript.tsx:982-1007, 1069-1096` |
| 13 | **Height shrink** (composer grows, keyboard opens, panel shortens) | `viewportSizes` observer: `shrink>0 && atBottom && no spacer` → `scrollTop += shrink` in the same frame (`:1316-1339`) | Last row stays above the composer; no jump | by design §94.4 | same |
| 14 | **Height grow** (window taller, devtools closed, keyboard closed, page that hid the composer) | **Nothing.** `reflowed()` only watches width; `viewportSizes` only handles `shrink>0`. `elastic()` has already left `minHeight: max(100%, floor)` + a `flex:1 0 0` slack (`:1025-1056`), so `100%` grows and the **slack row grows with it**; the library then calls `scrollToEnd` on the content resize | The whole transcript is pushed up by the height delta and a viewport-sized blank is now "the bottom"; the floor keeps the blank after the viewport shrinks again | **defect D5 / H2** | `chat-transcript.tsx:982-996, 1025-1056, 1316-1339` |
| 15 | **Page hidden → shown** (`KeepAliveStage`, settings/管理/CC round trip) | The chat is not unmounted; size is frozen while hidden [§98.2, §98.3]; no `visibilitychange` handler exists in the engine. On return: the viewport/content ResizeObservers fire; `look()` → `elastic()` re-floors at the current height; the queued/`scrollToEnd` writers and the library's `handleResize` still run | Exact restore if the frozen size is exact (that is the design). If the outer size differs (window resized while hidden, browser zoom, OS DPI change), D5 fires; if a queued row lands while hidden, D3 fires on return | by design §98.2/§98.3; D5/D3 for the exceptions | `chat-transcript.tsx:1308-1340, 606-617`; DESIGN §98.5 |
| 16 | **Re-open a scrolled-up conversation** (memo restore + tail catch-up) | SettleAtEnd `restore` = memo anchor (`:686-696`); during hydrating `active()` and `settle()` → `toRemembered()` (`:886-936`). In parallel `useKeepBottomOnPrepend` has `atBottom = useRef(true)` (`:2691`) and pins `scrollTop = scrollHeight` on the first `firstId` change (`:2703-2719`), which the rAF catch-up produces within 1–2 frames | Bottom flashes for ~1–2 frames, then the remembered row is restored → a visible up-down jump on every re-open of a scrolled-up thread | **defect D4** | `chat-transcript.tsx:686-696, 886-936, 2687-2719, 2936` |
| 17 | **Send button / composer flash on open** | Bot switch remounts `ChannelChat` (`channel-page.tsx:270-274`); the join/replay makes `agent.isRunning` true for a beat; `pending` = `agent.isRunning \|\| turnsInFlight>0` (`channel-chat.tsx:1667`) and `stoppable` adds `runsInFlight` (`:1773-1775`) → composer's `canStop` (`composer.tsx:1519`) draws ■ Stop | Send button flips to Stop for ~0.3–0.8 s on every bot switch [§98.1 measured this exact symptom], then back | defect D7 (by-design cause, avoidable presentation) | `channel-page.tsx:270-274`; `channel-chat.tsx:1667, 1773-1775`; `composer.tsx:1173, 1519`; DESIGN §98.1 |

Not in scope but noted: `?message=` deep links are driven by `MessageFind` polling, unaffected by the above.

---

## 3. Defects, mechanism, minimal fix, risk

### D1 — a restore can hand the newest user message `data-scroll-anchor` (H1)

**Mechanism.** `useFreshAnchor` keeps a baseline of "the newest user id I have already accounted for". While `hydrating` it re-baselines every render (`:3337-3340`), then on the **first non-hydrating commit** compares the newest id against that baseline (`:3341-3345`). `channel-chat.tsx` changes *both* inputs in the same commit: `hydrating={restoring}` (`:1767`) and `messages={restoring ? (early ?? cached ?? EMPTY_MESSAGES) : agent.messages}` (`:1672-1677`). So "restore finished" and "the list is now a different list" are indistinguishable from "a user message arrived":
- no cache + read timed out (`thread-messages.ts:65`) → baseline `null` → **always** fires;
- cached/early list whose newest user id differs from `agent.messages` after `mergeStoredMessages` (other device wrote a turn, a turn landed after the cache snapshot, merge appended stored tail — `channel-chat.tsx:249-269`) → fires;
- ids stable (the common warm case) → does not fire.

The row then gets `scrollAnchor` (`:3261-3265`), `useSmoothSendScroll` is quiet on that commit (`:2651-2666`), and SettleAtEnd's new-turn branch **disarms the settle pin** (`s.until = 0`, `:741-742`) while padding slack to 2/3 viewport (`:784-817`). Result: the conversation is parked with the last question ~1/3 from the top and ~2/3 of a screen blank underneath — exactly what it looks like right after a send — and it stays there until the user scrolls (which is what sets the library's mode back to `free-scrolling`). No smooth scroll, so it reads as a hard "refresh".

**Minimal fix** (tighter than the in-flight 2.5 s window; ~8 lines in `useFreshAnchor`):

```ts
// add `wasHydrating: boolean` to the memo, initialised to `hydrating`
if (hydrating) {
  memo.baseline = newestUserMessageId;
  memo.id = null;
  memo.continuous = false;
} else if (memo.wasHydrating) {
  // the commit that ENDS the restore: this list is history, whoever is newest
  memo.baseline = newestUserMessageId;
  memo.id = null;
  if (sendMode) sendMode.current = { id: null, continuous: false };
} else if (newestUserMessageId !== null && newestUserMessageId !== memo.baseline && newestUserMessageId !== memo.id) {
  /* existing send path */
}
memo.wasHydrating = hydrating;   // after memo.last = newestUserMessageId
```
`SettleAtEnd` already does this on the flip (`:731-741`); only `useFreshAnchor` and `useSmoothSendScroll` lack it. If the 2.5 s `opening` window currently in the working tree is kept, cap the *anchor* suppression to the flip commit (or ~250 ms): a real send 1 s after opening must still page-turn per §35.

**Risk.** Low for the flip-commit guard. A 2.5 s window instead suppresses §35 for "open → type fast → send" (no anchor, no 2/3 slack, plain bottom-follow) — acceptable but a behaviour change worth writing down. Do not key the guard on "no items yet": a channel opened by sending its first message (`seed`) must still anchor that first send.
*State of the in-flight fix (11:12):* it implements the flip-commit derivation with refs and only opens the window for a transcript that actually hydrated (`recovered`), so the `seed` case is safe. The only remaining delta from the sketch above is the window's **length** (2.5 s of "history is still arriving" after every restore) — keep it or shorten it to ~250 ms; either closes H1.

### D2 — a failed history read replaces the restored replay with an empty list

**Mechanism.** `retryingHistory` is set inside the same continuation as `setRestoring(false)` (`channel-chat.tsx:592-609, 615`), and the `restoring` **prop** is `restoring || retryingHistory` (`:1766`). That prop selects the message source (`:1672-1677`), so for a thread whose first read failed, the agent's replay that was just painted is swapped for `early ?? cached ?? EMPTY` — usually `EMPTY` — and `ChatTranscript` draws the skeleton (`:3123`) until a retry (1.5/4/10 s, then a 15 s deadline) succeeds. This is the "refresh that looks like a send" for slow/cold servers. The 2.5 s settle window armed at the restore flip may cover the first second, but the retries at 4 s and 10 s land with `until` long expired, so nothing protects the position.

**Fix.** Split the two facts: keep using agent messages when the transcript already has content, and let `retryingHistory` drive only the notice/skeleton:

```tsx
messages={transcriptMessages(
  restoring && agent.messages.length === 0
    ? (early ?? cached ?? EMPTY_MESSAGES)   // nothing on screen yet: paint the cache / skeleton
    : agent.messages,                      // already restored (or retrying): never go back
  seed,
)}
```

**Risk.** A restored replay that is known-partial would now be drawn instead of the cache; that is what already happens after `finally` anyway, and the notice explains the gap. Keep `hydrating={restoring}` untouched (the pin must cover the retry window).

### D3 — parking a queued message scrolls to the bottom unconditionally

**Mechanism.** `ScrollNewestQueuedIntoView` calls `scrollToEnd()` in an effect keyed on `queued.at(-1)?.id` (`:606-617, 3177`). It ignores `hydrating`, the settle window, whether the reader is at the bottom, and it also fires when the newest queued row is *removed* (the id changes to the previous one). `scrollToEnd` is instant and also zeroes the library spacer, i.e. it destroys a page-turn state.

**Fix** (~10 lines): make it "reveal only if already near the bottom", and gate on the same facts the engine uses:

```tsx
function ScrollNewestQueuedIntoView({ newest, enabled, viewport }: {
  newest: string | null; enabled: boolean; viewport: React.RefObject<HTMLElement | null>;
}) {
  const { scrollToEnd } = useMessageScroller();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (newest === null || seen.current === newest) return;
    const first = seen.current === null;
    seen.current = newest;
    const el = viewport.current;
    if (!enabled || first || !el) return;                              // restore window / first paint
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return;  // reader is up: leave them
    scrollToEnd();
  }, [enabled, newest, scrollToEnd, viewport]);
  return null;
}
```
(`enabled = !hydrating && !opening`, `viewport` is the existing `viewportRef`.)

**Risk.** A parked row below the fold when the reader is up is not brought into view — correct, the composer already shows the queue count, and the reader chose to be up. Removing the "last id changed" trigger for removals avoids a second yank.

### D4 — `useKeepBottomOnPrepend` assumes "at bottom" before anything is measured, and fights the restore

**Mechanism.** `atBottom = useRef(true)` (`:2691`) and only a scroll event ever lowers it. On a remount of a conversation that was left scrolled up, the memo restore is in flight (`SettleAtEnd.restore`, `:686-696`), while `useKeepBottomOnPrepend` sees `firstId` change as the tail-first rAF catch-up prepends rows (`:2936`) and pins `scrollTop = scrollHeight` (`:2715-2718`). The restore then moves back (`:896-917`). Two frames of the bottom flash between the two.

**Fix** (~5 lines): decide from the DOM instead of from a ref that starts `true`:

```tsx
useLayoutEffect(() => {
  const el = viewport.current;
  const previous = seen.current;
  seen.current = firstId;
  if (!el || previous === null || firstId === null || previous === firstId) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (!nearBottom) return;                       // was: if (!atBottom.current) return;
  const behavior = el.style.scrollBehavior;
  el.style.scrollBehavior = "auto";
  el.scrollTop = el.scrollHeight;
  el.style.scrollBehavior = behavior;
}, [firstId, viewport]);
```
and/or accept an `initialAtBottom` from `threadUi(scrollKey)?.scroll?.atBottom ?? true` so a memo-restore mount starts at `false`.

**Risk.** During the very first commit `scrollHeight` may be 0 → treat `scrollHeight <= clientHeight` as "at bottom" so short/empty transcripts still pin.

### D5 — the "elastic" floor is width-aware only, so a taller viewport becomes blank space (H2)

**Mechanism.** `elastic()` sets `content.style.minHeight = "max(100%, <height>px)"` and leaves `.chat-slack` as `flex: 1 0 0` (`:1044-1056`). Any height increase makes `100%` larger, so the **slack row** grows by the delta; `floor` is not invalidated because `reflowed()` compares `clientWidth` only (`:989-996`) and `viewportSizes` handles `shrink > 0` only (`:1316-1339`). The content element then resizes, the library's `handleResize` (`mode === following-bottom`) calls `scrollToEnd` (`dist` `Ce`), and the transcript moves up by the delta; when the viewport shrinks back, the floor keeps the column at the old height so a screen of blank remains "below the last message". This is the same class of bug §106 fixed for width.

**Fix** (~8 lines, inside the `viewportSizes` observer, before `look()`):

```tsx
// existing observer already computes `shrink = lastClient - height` (< 0 when the viewport grew)
if (shrink < 0 && seen.atBottom && !active() && !s.restore && !anchoring() && (s.floor !== null || s.slack > 0)) {
  setSlack(0);                              // drop floor + slack together
  lastHeight = content.offsetHeight;
  stickToBottom();                          // same frame: last row stays at the bottom
}
```
`stickToBottom` already exists (`:1001-1007`).

**Risk.** On mobile-keyboard close, `setSlack(0)` removes the blank below the last row; if the reader is at the bottom this is invisible (the content bottom is clamped anyway). Skip it while a page-turn anchor is live (`anchoring()`), otherwise §94.7's 1/3 target gets pulled back to the bottom.

### D6 — every open performs several "list length changed" commits (H5)

**Mechanism.** `useTailFirstMount` mounts `initialMountedCount` (36 above 48 rows) and then extends by 28 **per rAF** until full (`tail-first-paint.ts:11-19`, `use-tail-first-mount.ts:93-114`). Each commit changes `items.slice(tailStart)` → the library's `handleContentChange` runs. Its prepend branch (`preserveScrollOnPrepend`, `indexOf(oldFirstChild) > 0`) is **dead here**, because `chat-tail` (`display:contents`) is permanently `children[0]` (`:3078`, explained at `:3046-3053`): index is 0, not `> 0`. So each commit falls through to `mode === "following-bottom" && autoScroll → scrollToEnd`, and `useKeepBottomOnPrepend` may also write `scrollTop` (D4). At the bottom these writes are no-ops; on a scrolled-up restore they are the jump in D4; the rest is repeated layout (each commit re-measures up to 28 Markdown rows).

**Fix.** Do not repaint the list under the restore pin; resume the catch-up when the restore ends:

```ts
// use-tail-first-mount.ts — the rAF catch-up effect
useEffect(() => {
  if (hydrating) return;            // SettleAtEnd owns the viewport until the restore is over
  ...
  step();
  return () => { cancelled = true; cancelAnimationFrame(raf); };
}, [scrollKey, total, hydrating]);
```
(take `hydrating` as a fourth argument and pass the prop through). Optionally mount the remaining rows in one commit if the thread is short (`mounted + 2*TAIL_FIRST_BATCH >= total`).

**Risk.** Very old history is revealed after the restore rather than during it (a few hundred ms later) — still inside the 4 s window `MessageFind` polls for `?message=`. The scroll-up trigger (`use-tail-first-mount.ts:79-91`) stays as the safety valve.

### D7 — the send button flashes to Stop on every bot switch

**Mechanism.** `ChannelChat` is keyed by channel and remounted on every switch (`channel-page.tsx:270-274`); during join/replay `agent.isRunning` is true, and `stoppable` includes it (`channel-chat.tsx:1773-1775`) → `canStop` (`composer.tsx:1519`) draws ■ Stop. DESIGN §98.1 already measured "发送键闪成「■ 停止」约 0.3–0.8 秒" for the old remount path and fixed it by keeping the chat mounted (§98.2); bot switching still remounts.

**Fix.** Keep `pending` as the gate for sending, but only offer Stop when there is something this client can abort:

```tsx
stoppable={runsInFlight > 0 || turnsInFlight > 0}
```
(or `stoppable && agent.isRunning && runsInFlight + turnsInFlight > 0`). The button then stays "Send" (disabled by `pending`) through the replay.

**Risk.** A run this client did not start (page reloaded mid-run, CopilotKit re-attached to a live run, handoff resume at `channel-chat.tsx:1703-1709` which raises `runsInFlight` only) would have no Stop. If that matters, keep `agent.isRunning` but debounce it (e.g. only after it has been continuously true past the join, or when `runsInFlight>0 || turnsInFlight>0 || awaitingReply`).

---

## 4. Hypothesis verdicts

**H1 — "a restore/open can hand the newest user message `data-scroll-anchor` because hydrating/baseline are keyed on the newest USER id rather than on 'this transcript was just opened'."**
**TRUE** for the baseline design; conditional on the id actually changing across the flip. Evidence: `chat-transcript.tsx:3337-3345` (baseline re-set while hydrating, compared on the first non-hydrating render), `channel-chat.tsx:1672-1677` + `:1767` (message source and `hydrating` flip in the same commit), `chat-transcript.tsx:2961-2963` (anchor set), `:741-742` (pin disarmed), `:784-817` (2/3 slack). Cases that fire: cold open whose store read timed out (`thread-messages.ts:65`), merge appended a newer stored turn (`channel-chat.tsx:249-269`), another device wrote while away. Warm cache with identical ids does **not** fire — so "restore always anchors" is too strong, and "restore never anchors" is wrong. The user's exact wording ("切个机器人 / 从设置回来，整段对话像发消息一样刷新一次") is reproduced by this path. The concurrent rewrite attempts the fix with a 2.5 s `opening` window (§7); a flip-commit guard is enough and does not suppress a real send.

**H2 — "the `elastic()` floor survives a viewport height change while hidden, so when shown again it must scroll somewhere."**
**TRUE as a mechanism, with the trigger corrected.** The floor is width-keyed and the slack is `flex-grow`, so a taller viewport converts into blank space and the library's next `scrollToEnd` moves the history up by the delta (`:1025-1056, 989-996, 1316-1339`; dist `Ce`). But hidden→shown itself is protected: the kept chat freezes its width **and height** while hidden (DESIGN §98.2) and the engine has no `visibilitychange` hook, so an exact restore does not move anything. The real triggers are window/OS resize, browser zoom/DPI while the page is hidden, closing devtools, the mobile keyboard, and any outer layout change to the chat column's **height** (width changes are §106-handled). Verdict: defect D5; "page hidden then shown" alone does not reproduce it.

**H3 — "SettleAtEnd's 2.5 s window re-pins on any content change; if `restoring`/`hydrating` flickers, the window restarts and yanks a user who scrolled up."**
**FALSE as stated, TRUE in a weaker form.** `restoring` is one-way (`channel-chat.tsx:506`, only `setRestoring(false)` at `:615`), so `hydrating` cannot flicker and the window cannot restart. The window *is* armed on every mount and re-armed only on the `hydrating` edge (`:725-742`). Within it, any content change does call `settle()` → `scrollToEnd` (`:918-937, 1297-1301`), which is by design §83.2. The user is released by wheel/touch/key/pointerdown on the viewport (`:940-963, 1341-1344`) — so a reader who scrolled up *before* the window opens (re-open of a scrolled-up thread) is protected only by `s.restore`, and if the memo anchor cannot be found (row not mounted yet by tail-first) `settle` falls back to `scrollToEnd` once `hydrating` is false (`:919-924`). That is a genuine but narrow yank, and D4 is the bigger one.

**H4 — "`busy` flapping mid-turn makes `live` flip, which folds/unfolds rows."**
**FALSE for the browser/tool relay case, TRUE for every early-ending path.** `turnsInFlight` deliberately spans the whole turn including the gaps between runs (`channel-chat.tsx:918-930, 1295-1319`) and `busy` = `agent.isRunning || turnsInFlight>0` (`:1667`), so relay turns do not flap. `live` is additionally guarded against the send gap by `settledRef` (`chat-transcript.tsx:2777-2789`, §68.4). But `live` **does** flip whenever `busy` goes false mid-turn: Stop clears both counters (`channel-chat.tsx:1434-1438`), the send watchdog stops the run on silence (`:1088-1093`), and `HandoffResumeNotice.run` raises only `runsInFlight` (`:1703-1709`), which is not part of `busy`. In those commits `compactTurns` treats the turn as finished: tone `final`, `hidden` gains the step lines, the work card collapses, `regenerateId` appears (`chat-transcript.tsx:3465-3582, 2967`) → 220 ms fold (`styles.css:7496-7513`) plus layout change. And if `busy` returns true with the list shape unchanged (queue drain reusing the same last id), `live` stays false for the rest of the turn. Verdict: not the cause of the complaint, but a real jump source around Stop/watchdog/handoff.

**H5 — "`useTailFirstMount`'s rAF catch-up mounts rows in several commits on every open, which the scroller treats as new rows appended."**
**PARTIALLY TRUE.** Several commits per open: yes (`use-tail-first-mount.ts:93-114`, 28 rows/frame, 36 initial). "Appended": structurally the commits are prepends, but the library cannot recognise them: `chat-tail` is always `children[0]` (`:3078`), so its `indexOf(previousFirstChild) > 0` prepend check is never taken and the code falls through to the append/follow-bottom branch (`scrollToEnd`) — this is the same `order-2`/`display:contents` design the long comment at `:3025-3072` explains. Visible effect at the bottom: none (already at bottom). Visible effect when scrolled up: the D4 flash. So H5 is a perf/layout-pass and D4 amplifier, not an independent anchor jump.

---

## 5. Top 3 fixes, ordered

1. **D1 (restore must not look like a send) + D2 (a failed read must not empty the transcript).** Removes the only path that produces the *complete* send choreography on open — anchor, 1/3 park, 2/3 blank, pin disarmed — and the skeleton flash on slow servers. Expected effect on the complaint: "切机器人 / 从设置回来像发了一次消息" disappears; the transcript is either at the bottom or at the remembered row, and it stays there. Highest impact, lowest risk.
2. **D4 (keep-bottom before first measurement) + D3 (queued `scrollToEnd`).** Stops the engine from taking the viewport away from a reader who is up: no bottom flash on re-open of a scrolled-up thread, no jump when a correction is parked. Expected effect: "对话记录充满了跳跃" — the remaining jumps that happen while the user is *reading* rather than sending.
3. **D5 (floor is width-keyed) + D6 (one commit for the catch-up).** Removes the resize/return jumps and the blank-screen-at-the-bottom state, and cuts 3–6 layout passes per open. Expected effect: window/panel/keyboard changes and returning from another page no longer move the history; open feels settled rather than "loading itself".

D7 (Stop-button flash) is a one-line change from the same family and should ride along with #1: it is the "输入框特别容易闪" half of the complaint, with `§98.1` as the measured precedent.

---

## 6. What is *by design*, stated so it is not "fixed" by mistake

- Page-turn on a genuinely new turn (1/3 park + 2/3 slack + 700 ms smooth) — §35, §94.7. It must survive any H1 fix.
- Bottom pin for `SETTLE_AFTER_HYDRATE_MS` after a restore — §83.2. The problem is its *scope* after a restore that changed the newest id, not its existence.
- `chat-tail` first in DOM / `order-1` / `display:contents`, and the spacer `order-2` — load-bearing for the library's positional append detection; the accessibility debt is documented at `:3054-3071`.
- Folding rows at 220 ms instead of unmounting — §82.9.
- Dropping the remembered slack when a turn has already ended — §93.4.
- `CONTINUOUS_SEND_MS` is **30 min** in code (`send-scroll.ts:21`) while §94.2 still says 5 min — documentation drift, not a bug.

## 7. Test runs / artefacts

- `bun test app/tests/chat-restore-anchor.test.tsx` (untracked, added by the concurrent writer; not in HEAD). Its two cases are exactly H1: restore-then-render must not anchor the restored newest user message, while a later real send must.
  - 11:08 / 11:11, mid-write saves: **fail** on `ReferenceError: hydrating is not defined` (useSmoothSendScroll) and `ReferenceError: useOpeningWindow is not defined` (ChatTranscript) — module-evaluation errors, not assertion failures.
  - 11:13, coherent version: **2 pass, 0 fail, exit 1** — the exit code comes from 4 "Unhandled error between tests: AbortError: The animation was canceled." emitted by motion's frameloop when happy-dom tears the DOM down. Same environment family as the `message-scroll-reduced-motion` isolation artefact named in the brief; not a product signal.
- Not run (per brief): `message-scroll-reduced-motion.test.tsx` (isolation artefact).
- No live server/DB here; happy-dom has no layout, so no px could be measured first-hand. All px in §2 are derived from the code's formulas or quoted from DESIGN's browser measurements (§83.3, §93.3, §94.1, §94.7, §106), marked [§].
- Repo state at audit time: HEAD `227dedd8`; `chat-transcript.tsx` modified vs HEAD (+819/−484) and still being written (3484 lines at 11:12:53, 3676 at 11:14); `DESIGN.md` modified at 11:07; `app/tests/chat-restore-anchor.test.tsx` untracked. **Nothing in the working tree was verified beyond that one test file.**
