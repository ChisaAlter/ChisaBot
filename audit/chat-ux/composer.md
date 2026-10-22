# Composer flash / jump / focus audit

Read-only audit. No source files were modified. One existing test file was run:
`app/tests/composer-draft-memory.test.tsx` → 7 pass, 0 fail (confirms the mount-restore and
send-clears-draft paths below; the stray `ECONNREFUSED` on stderr is an unrelated fetch).

Base dirs for the bare filenames below:
`app/src/components/channels/`, `app/src/components/channels/composer/`, `app/src/lib/`,
`app/src/styles.css`, `app/src/components/layout/`.

---

## 0. The short version

The composer is **not** one flashing thing. Three independent mechanisms produce the complaint:

1. **The editor collapses to `minHeight` whenever it loses focus**, and `styles.css` deletes the
   150 ms transition that used to soften it. Clearing on send and clicking any toolbar control both
   land as a hard one-frame height snap. (`composer.tsx:1679`, `styles.css:1514-1521`, package code
   `node_modules/prompt-area/dist/chunk-QKZPGBZK.js:68,77`.)
2. **The composer is a fresh mount on every bot switch**, and each control in it fills in on its own
   schedule afterwards: shimmer pill → real pill, context ring `display:none` → 30 px, attachment
   strip re-uploaded and animated in, editor 38 px until focused. That is the "切 bot 像发送了一次"
   feeling, and it is not a re-render — it is a mount plus four asynchronous layout changes.
3. **A re-layout on return, and a surface transition that cannot interpolate**: leaving and
   re-entering the chat changes the shell's width budget (right rail hidden in settings), so the
   kept chat is un-frozen and re-laid out in one frame; and the composer surface swaps
   *gradient → flat colour* on `:focus-within`, which cannot interpolate, so it snaps.

The send→Stop swap is real but small: it is a glyph + colour change inside a fixed 34 px button
(`styles.css:1550-1582`), not a width change. It is loud only because it is the third surface
changing in the same 300 ms window.

---

## 1. Every cause of re-render / re-layout / unmount

### 1.1 Turn state that repaints the composer

| # | Cause | Evidence | What it does visually |
|---|---|---|---|
| S1 | `isSubmitting` set true on send, false in `finally` | `composer.tsx:1173,1333-1334,1411` | drives Stop; falls at the **end of the whole run** |
| S2 | Parent `pending` / `running` | `conversation-view.tsx:200-201,324-331`; `channel-chat.tsx:1758` | second, independent busy source in the same `isBusy` disjunction |
| S3 | `sending` (ids hidden while a send is out) | `composer.tsx:631,639-642,1349,1409` | attachment strip collapses on send, re-expands on failure |
| S4 | `rejected` list | `composer.tsx:453,560-577,796,1065` | `Collapse` opens above the form (`rejected-files.tsx:66`), 240 ms |
| S5 | `droppedAttachments` from the queue | `conversation-view.tsx:177-178,230-240` | fresh object → new rejection lines → another `Collapse` cycle |
| S6 | `staged` → `images`/`files`/`draft`/`sendable` memos | `composer.tsx:1112-1171,1178,1488` | strip, send-enabled, `queuedAttachmentCount` |
| S7 | focus debt `wantsFocus` | `composer.tsx:436,1414,1453-1466` | at turn end calls `editor.focus()` → editor re-expands + surface `:focus-within` flips |
| S8 | draft memory write on every `value` change | `composer.tsx:370-377`; `ui-memory.ts:215-228,156-173` | no React update (module store), but a full `JSON.stringify(prune(store))` + `localStorage.setItem` 150 ms after each typing burst — main-thread hitch while typing |
| S9 | `onAgentChange` effect | `composer.tsx:1179-1182` | no caller passes it today (`channel-chat.tsx:1636-1720`, `channel/new.tsx:201-225`) — inert |
| S10 | per-render rebuilds from the parent | `channel-chat.tsx:1658` (`toAgentOptions` returns a new array) → `composer.tsx:1174-1177` (`triggers`), `1670-1687` | new `triggers` every streaming token; churn, not a flash |

`isBusy` is a disjunction of S1 and S2 (`composer.tsx:1173`). The two settle on **different
commits**: `running` falls in `start`'s `finally` (`conversation-view.tsx:329`) before the composer's
`finally` runs (`composer.tsx:1405-1415`). Both directions are possible depending on batching; the
glyph is decided by a third, narrower predicate — `canStop` (`composer.tsx:1519`).

### 1.2 The box's own height

| # | Cause | Evidence | Effect |
|---|---|---|---|
| H-1 | PromptArea pins `height: minHeight` **whenever the editor is blurred** (`ie=false`), and `overflowY: hidden` | `chunk-QKZPGBZK.js:77` (`height: ie && qe ? qe+"px" : P+"px"`, `overflowY: ie?"auto":"hidden"`) | a multi-line draft is drawn 38 px tall and **clipped** while unfocused |
| H-2 | Blur handler collapses 150 ms later, unless focus stayed inside the editor's parent | `chunk-QKZPGBZK.js:68` (`Ot=150`), blur callback in `:77` (`S.parentElement?.contains(activeElement)`) | clicking `+`, model pill, permission chip, context ring, dictation or the transcript collapses the editor |
| H-3 | The app deletes the package's height/min-height transition | `styles.css:1514-1521` (`transition: none !important`) vs inline style `chunk-QKZPGBZK.js:77` (`transition:"height 150ms ease-out, min-height 240ms …"`) | every collapse/clear is a single-frame jump instead of a 150 ms ease |
| H-4 | Compact geometry | `composer.tsx:129-130,1678-1679` (`minHeight = 19*2 = 38`, `maxHeight = 200`), `styles.css:1509-1512` (15 px × 1.6 = 24 px/line) | each line is 24 px; a 3-line draft loses 34 px on blur (72 → 38) |
| H-5 | Send clears the draft in one commit | `composer.tsx:1336` (`setValue([])`) | N−1 lines vanish in one frame, box top edge jumps down |
| H-6 | Attachment strip still animates 240 ms | `attachment-strip.tsx:84`, `collapse.tsx:113-141` (`ENTRANCE_SECONDS`) | strip eases while the text snaps — a two-stage jump on clear |
| H-7 | Strip re-staged from memory on mount | `composer.tsx:873-879` (`takeDraftFiles` → `stageFiles`), teardown at `:850-872`, `ui-memory.ts:285-303` | tiles mount with `initial={{opacity:0,scale:.85}}` (`attachment-strip.tsx:200-206`) → fade/pop + `Collapse` open, ~0.2–1 s after the chat appears |
| H-8 | Rejection / "too many files" lines sit **above** the form | `composer.tsx:1644-1646,1738-1744` | `Collapse` grows upward; bottom-anchored layout keeps the form in place (see §3 H5) |
| H-9 | `notice` slot above the composer | `conversation-view.tsx:511-512`; `channel-chat.tsx:1690-1721` | see H5 verdict: shrinks the transcript, does not move the composer unless it overflows |

### 1.3 Controls inside the toolbar (each changes width after mount)

| # | Cause | Evidence | Effect |
|---|---|---|---|
| T1 | Model pill has three pre-data states | `model-picker.tsx:115-127` (`model-pill-loading` shimmer, `-warn`, `-static`) then `:163-178` | pill width/height changes when the query lands; `styles.css:1657-1673` shimmer starts on mount |
| T2 | Pill swaps chevron ↔ spinner while saving | `model-picker.tsx:177`; `styles.css:1622-1630` | width change, and again on failure |
| T3 | Context meter is `display:none` until its query has data | `context-meter.tsx:84-85`; `styles.css:4645` (`.context-meter.is-loading{display:none}`) | 30 px + 6 px gap appears next to Send after mount/GC → Send shifts sideways |
| T4 | Meter disappears for external bots / unavailable | `context-meter.tsx:83,85` | same shift, in reverse |
| T5 | Permission chip swaps icon ↔ spinner | `permission-chip.tsx:67-73`; `styles.css` `.perm-chip.is-busy` | small width change on every permission read |

### 1.4 CSS transitions / animations keyed on attributes

| # | Cause | Evidence | Effect |
|---|---|---|---|
| C1 | `.glass-main[data-mode="bots"] { animation: mode-in-bots … }` | `styles.css:7068-7071`; `authed-shell.tsx:46`; `left-mode.ts:12-14` | **does not** replay on settings→chat: `modeOfPath` returns `bots` for every non-`/cc` path, so the attribute value never changes. It replays only on a real bot↔CC switch, which is the intent, and `useModeSwitched` suppresses even the first one |
| C2 | `.glass-composer` transitions `background`, but rest and focus are different *kinds* of background | `styles.css:1491` (transition), `6281` (gradient), `6282` (flat `rgba`), also `3598-3603` | gradient→flat cannot interpolate: the surface **snaps** on every focus/blur, with an extra 200 ms shadow fade |
| C3 | Send/Stop button | `composer.tsx:1527-1549`; `styles.css:1550-1559` (bg/shadow/opacity 0.12–0.15 s), `1568-1577` (disabled grey), `1578-1582` (stop dark), `button.tsx:16` (150 ms colour set) | accent arrow → dark stop → grey disabled arrow, ≥3 appearances per turn |
| C4 | Icon swap is a hard replace | `composer.tsx:1536,1547`; the cross-fade promised at `styles.css:4611` has no rule (only `:hover`, `:4613`) | glyph pops; colour eases underneath it |
| C5 | `.btn-stack` / `data-btn-state` machinery | `button.tsx:124-146`; with no `state`/`feedback` and `size="icon"`, `stacked` is false (`button.tsx:140-143,169-175`) | no state machine is involved in send/stop — good; only the colour props change |
| C6 | Hidden chat disables scroll anchoring but nothing else | `styles.css:7837`; `keep-alive.tsx:115-122,132` | freeze/unfreeze of `width/height` on hide/show → one full re-layout on return |

### 1.5 Unmount / remount

| # | Cause | Evidence | When |
|---|---|---|---|
| M1 | `ChannelBody` returns `null` while the channel query is pending | `channel-page.tsx:233-234` | deep link, reload, a channel not in the loaded roster page, a just-created channel ⇒ **whole chat + composer unmounted** for one round trip |
| M2 | Placeholder only covers a roster row; there is no *previous* channel kept | `channel-page.tsx:74-77,103-104`; `queries.ts:90-103,105-120`; global `staleTime: 30_000` (`query-client.ts:10`) | `isPending` is only true with **no cached detail at all** (first visit, deep link, after `gcTime`, brand-new channel) — but then M1 fires and the composer is gone for the round trip |
| M3 | Kept page dropped after TTL | `keep-alive.tsx:5,62-66` (10 min) | coming back after 10 min = fresh mount |
| M4 | Kept page replaced on address change | `keep-alive.tsx:49-53`; `authed-shell.tsx:88-115` | bot/channel switch: new mount by design |
| M5 | Error path replaces the chat with an ErrorCard | `channel-page.tsx:235-255` | transient channel-query error = unmount |
| M6 | `/channel/new` renders nothing until profile + channel queries settle | `channel/new.tsx:164` | composer appears late, then `autoFocus` fires (`:207`) |
| M7 | `key={channel.id}` | `channel-page.tsx:268-274` | remounts `ChannelChat` only when the id actually changes (correct) |
| M8 | **No `key` on `<Composer>`** | `conversation-view.tsx:513-587` | switching `draftKey`/`channelId` in place does **not** remount (draft would then be stale — but M4/M1 always fire first) |

### 1.6 Explicitly *not* a cause

* `submitInFlight` is a **ref** (`composer.tsx:379,1329,1410`) — it guards against a double send and
  never causes a render by itself; only `setIsSubmitting` (`:1334,1411`) does.
* `useReportBusy` / `useReportPendingAttachments` — module-level `Set`/`Map` + `useEffect`, no state,
  no context, no subscription: `activity.ts:19-55`, called at `channel-chat.tsx:1613` and
  `composer.tsx:648`. They cannot re-render anything. (See H2.)
* `aria-busy={isBusy}` on the form (`composer.tsx:1648,1746`) — no CSS matches `[aria-busy]`
  (grep of `styles.css`), so it is invisible; keep it, it is free.
* `DetailPanel` does **not** unmount its children when closed (`detail-panel.tsx:67` renders
  `{children}` unconditionally), so opening/closing the settings pane is not a remount.

---

## 2. Per-event behaviour

### (a) Entering a conversation
1. Fresh mount if the page was not kept (M1/M3/M4): editor starts at 38 px (H-1) even when the draft
   restored from `ui-memory` is longer — the draft is correct (`composer.tsx:357-364`, test passes)
   but visually clipped; the first click expands it (H-3, no transition).
2. Model pill: shimmer → real pill (T1), width changes.
3. Context ring: absent (`display:none`) → 30 px (T3), Send shifts.
4. Stashed files re-uploaded and tiles animate in (H-7); strip `Collapse` opens 240 ms.
5. `autoFocus` on `/channel/new` focuses immediately (`composer.tsx:1453-1466`), so the editor grows
   once, 1 frame after paint.
*Avoidable*: mostly yes. `keepPreviousData` for the channel query removes M1; a content-based editor
height removes 1; T1/T3 are one-line CSS/JS fixes (§4).

### (b) Returning from another page
1. No remount inside 10 min (`keep-alive.tsx:49-53,62-66`) — good, and this is already the fix for
   the original "切回来总要刷新一次".
2. The hidden page is `inert` + `visibility:hidden` (`keep-alive.tsx:119-132`), so the caret is
   dropped when it is hidden; the editor therefore collapsed to 38 px *while hidden* (H-1/H-2) and
   comes back as a clipped one-line box. Nothing restores focus on return. ← **the main
   "回来输入框变样/闪一下"**
3. The shell's width budget changes on the way back: `rightHidden` is true outside `scope === "app"`
   (`authed-shell.tsx:49`), and the left rail is a different component (`:34-41`). The kept chat is
   frozen at the old width/height while hidden (`keep-alive.tsx:68-84,115-122`), so on return the
   freeze is removed and the composer re-centres to the new main width in one frame — a sideways
   snap, not a height change.
4. On the first click, the surface snaps gradient→flat + 200 ms shadow (C2).
5. `HandoffResumeNotice` re-arms its 1 s control poll (`handoff-resume-notice.tsx:35-87`), which can
   add/remove its card above the composer; `PendingQuestion` refreshes on its own 10 s interval
   (`approvals.ts:71-80`).
*Avoidable*: the focus/height loss needs H-1/H-3 addressed; the sideways re-centre is the shell's
width budget and not worth changing; the polls are fine.

### (c) Pressing Send
One commit (`composer.tsx:1333-1349`): `isSubmitting=true`, `setValue([])`, `setSending(riding)`,
`dismissRejections()`, `markDraftSent`. Then, in order:
1. editor N lines → 38 px in one frame (H-5, no transition H-3), box top edge jumps down;
2. strip eases closed over 240 ms (H-6) — a second, later movement;
3. button accent→dark, arrow→square (C3/C4);
4. 150 ms after the click the package's blur timer runs (`Ot=150`) and confirms the collapse (H-2);
5. `pending` rises (`conversation-view.tsx:200-201`), so nothing pulls the editor back;
6. the caret does **not** return until the turn ends (`composer.tsx:1412-1415,1456`), so the box stays
   unfocused and 38 px tall for the whole answer.
*Avoidable*: call `promptAreaRef.current?.focus()` immediately after `setValue([])` — focus inside
the editor's parent makes the package's 150 ms timer a no-op (`chunk-QKZPGBZK.js:77`), so the height
stays correct and the caret is where the person is about to type.

### (d) The answer ending
1. `running` false (`conversation-view.tsx:329`) then `isSubmitting` false
   (`composer.tsx:1411`): Stop → grey disabled Send (C3).
2. `wantsFocus` effect focuses the editor (`composer.tsx:1453-1466`) → surface re-enters
   `:focus-within` (C2 snap + 200 ms shadow) and the editor re-measures.
3. `useThreadContext` invalidates 400 ms later (`thread-context.ts:60-69`) → ring arc animates
   (`styles.css:4653`, 300 ms) — fine.
4. **If anything was parked**: the drain effect runs on the commit where `inFlight` went false
   (`conversation-view.tsx:405-458`), so the browser paints a Stop-less/Send frame and immediately
   starts the drained turn → the button flips Send → Stop within a few frames, and
   `queuedAttachmentCount` (`conversation-view.tsx:576-579`) changes under the composer.
*Avoidable*: the drain flash is fixable by having `ConversationView` keep a local `draining` flag set
in the same effect before `start()` and passing `inFlight || draining`; the surface snap is C2.

---

## 3. Hypothesis verdicts

### H1 — Send→Stop swap is the "flash", and `isBusy` can flip more than once per turn
**Partly true; the mechanism is mis-stated.**
* Not width: both branches are `size="icon"` and CSS pins the button to `34×34`
  (`composer.tsx:1527-1549`, `styles.css:1550-1554`). Icon and colour are what change; the promised
  icon cross-fade does not exist (`styles.css:4611-4613`).
* `isBusy` itself stays true for the whole turn (S1 and S2 rise in the same event and fall
  independently, so the disjunction never gaps). But the *rendered state* is `canStop`
  (`composer.tsx:1519` = `stoppable && !parking`), and that predicate is not monotone:
  - first keystroke mid-turn → `parking` true (`composer.tsx:1479-1490`) → Stop yields to Send, and
    parking again clears the box (`:1308`) → Stop returns (`:1519`, comment at `:1507-1518`);
  - an upload finishing flips `sendable` (`draft.ts:56-59` via `composer.tsx:1488`);
  - a queued drain flips it twice within a few frames after an answer ends (§2d(4));
  - each flip also toggles `disabled` (grey) via `canSend` (`composer.tsx:1491-1495,1543`).
  So **≥3 appearances per turn are guaranteed** (accent arrow, dark stop, grey arrow), more if
  anything is parked.
* Severity: small on its own (34 px, 150 ms colour). It is loud because it happens in the same
  window as H-5/H-6.

### H2 — `useReportPendingAttachments` / `useReportBusy` cause extra shell renders
**False.** `activity.ts:19-55`: two module-level collections and a `useEffect` each; no `useState`,
no context, no `useSyncExternalStore`, no subscriber list. `refreshWouldInterrupt()` reads them on
demand (`activity.ts:110-116`, `update-banner.tsx:19`). The `[key, count]` deps re-run an effect,
not a render. Nothing here reaches the shell.

### H3 — Auto-grow measurement + `transition: none !important` interacts badly with `Collapse`
**True, with the cause and the direction corrected.**
* The measurement itself is fine: the package writes an inline `height` from `scrollHeight` and only
  re-renders when the number changes (`chunk-QKZPGBZK.js:77`, `qe` state).
* What `06571706` did (`styles.css:1514-1521`) was delete the package's `height 150ms / min-height
  240ms` easing **globally for this editor**. That is why *clearing* now jumps: the same rule that
  fixed the typing hop also removed the only thing that softened N→1 lines (`composer.tsx:1336`) and
  the blur collapse (`chunk-QKZPGBZK.js:68,77`).
* The interaction with `Collapse` is real but secondary: the strip still eases 240 ms
  (`collapse.tsx:113-141`), the editor now moves in 0 ms, so one commit produces two different
  movements at two different times (H-6).
* Net: the hypothesis' *symptom* (box height jumps when clearing on send) is confirmed; the culprit is
  the global `!important` plus the package's blur-collapse model, not the measurement.

### H4 — `disabled` / `sendBlocked` flipping grey out the toolbar within a turn
**Partly true, wrong lever.** `disabled={!channel.active}` is per-channel
(`channel-chat.tsx:1671`) and `sendBlocked={modelSaving}` is a model-save mutation
(`channel-chat.tsx:1657`, `hooks.ts:6-8`) — neither flips on turn start/end. What *does* grey the send
button inside a turn is `canSend` → `sendable` → the draft (`composer.tsx:1488-1496,1543`), i.e. the
box going empty/non-empty and uploads finishing. `disabled` on the `+` button and the file input
(`composer.tsx:1603,1696`) only changes with `channel.active`; the leading/trailing controls have
their own disabled logic (`permission-chip.tsx:69`, `model-picker.tsx:132,149`). So a grey-out is a
**draft-state** effect, not a `disabled`-prop effect.

### H5 — The `notice` slot changes height and pushes the composer
**False for position, true for layout elsewhere; and there is an overflow edge case.**
`notice` and the composer are siblings inside a bottom-anchored column
(`conversation-view.tsx:511-512`, `styles.css:7559-7563`), with the composer last. Growing the notice
grows the box **upward**; the composer's bottom stays on the container's bottom padding, so the
composer does not move — the transcript (`flex-1 min-h-0`, `conversation-view.tsx:480`) loses the
height instead. Two caveats:
* the card itself is not animated (`pending-question.tsx:65-101`, `styles.css:6786`), so the
  transcript's viewport shrinks in one frame — that is the "screen jumps" people describe, and it is
  the transcript's, not the composer's;
* if the box's content ever exceeds the column, the box is `shrink-0` inside `overflow-hidden`
  (`glass-shell.tsx:48`) and the composer is clipped instead of scrolled.
Query refresh is real but does not resize: `approvals.ts:71-80` (10 s) and
`handoff-resume-notice.tsx:35-87` (1 s poll of `readControl`) re-render locally; height changes only
when a card enters/leaves.

### H6 — `Composer` is remounted somewhere on navigation
**Yes, in three places — none of them a `key` on the composer.**
* `ChannelBody` returns `null` while `channel.isPending` (`channel-page.tsx:233-234`): the entire chat
  and composer unmount for one `/api/channels/:id` round trip whenever there is no cached detail and
  no roster row (placeholder only covers roster rows: `channel-page.tsx:74-77,103-104`,
  `queries.ts:105-120`; the global `staleTime: 30_000` in `query-client.ts:10` means refetches are
  not the trigger — an empty cache is).
* `KeepAliveStage` sets `kept = null` after 10 min hidden (`keep-alive.tsx:5,62-66`) → next visit is a
  mount.
* `/channel/new` returns `null` until its queries settle (`channel/new.tsx:164`).
And there is **no** `key` on `<Composer>` (`conversation-view.tsx:513-587`); the only key is
`<ChannelChat key={channel.id}>` (`channel-page.tsx:272`), which is correct.

---

## 4. Three highest-impact, lowest-risk fixes (ordered)

### 1. Stop the editor collapsing: keep the caret in the box on send, and let height follow content
`composer.tsx`, right after the optimistic clear (`:1336`):
```ts
setValue([]);
promptAreaRef.current?.focus();   // before the 150ms blur timer; keeps `ie` true
```
`focus()` inside the editor's own parent makes the package's blur callback a no-op
(`chunk-QKZPGBZK.js:77`: `S.parentElement?.contains(activeElement)`), so the height stays measured and
the whole-answer collapse + the end-of-turn focus steal (`composer.tsx:1453-1466`) both disappear.

Same PR, `styles.css:1514-1521` — replace the blanket `transition: none !important` with a
content-driven height (removes the blurred-clip state as well):
```css
.glass-composer .prompt-area-editor {
  height: auto !important;      /* beats the package's inline px height (focused or not) */
  max-height: 200px;            /* COMPACT_MAX_HEIGHT_PX; inline max-height still applies */
  overflow-y: auto !important;
  transition: none;             /* keep the commit's original intent: no hop while typing */
}
```
Risk: low — `height:auto` + `max-height` is what the element already does while focused; the package's
measurement still runs and simply stops being authoritative.

### 2. Make the composer surface animatable, and give the send button one stable look
`styles.css:6281-6284` (and the duplicates at `3598-3603`): use two gradients, or two flat colours —
never gradient ↔ flat, which the `background 0.2s` at `:1491` cannot interpolate:
```css
.glass-composer            { background: linear-gradient(180deg, rgba(255,255,255,.97), rgba(255,255,255,.93)); }
.glass-composer:focus-within { background: linear-gradient(180deg, rgba(255,255,255,.99), rgba(255,255,255,.96)); }
```
Button (`composer.tsx:1527-1549` + `styles.css:1550-1582`): keep the single 34 px element and render
both glyphs stacked with an opacity cross-fade keyed on `data-stop`; drop the separate
`composer-stop` background rule in favour of a `data-stop` colour so the existing 150 ms colour
transition actually runs. This removes the pop in C4 and the extra colour step in C3 without touching
the accessible name (`getByLabelText("发送消息")` in `composer-draft-memory.test.tsx:63` stays valid).

### 3. Stop remounting the chat on a channel switch
`channel-page.tsx:74-77`: add `keepPreviousData` to the channel query so `isPending` is false on
switch (when the target channel has no cached detail), which makes `:233-234` stop returning `null`:
```ts
import { keepPreviousData } from "@tanstack/react-query";
...channelQueryOptions(channelId), placeholderData: keepPreviousData,
```
That is the whole fix: one line, and it removes the blank frame, the fresh composer mount and the
strip re-stage for every in-app bot switch. (The horizontal re-centre on returning from settings is
the shell's width budget — `authed-shell.tsx:49` — and the freeze at `keep-alive.tsx:115-122` is what
stops it happening while hidden; leave both alone.)

*(Next in line, not top-3: render the attachment strip's stashed tiles from `takeDraftFiles` as
skeletons before the re-upload lands (`composer.tsx:873-879`), and give `PendingQuestion`/the error
line a `Collapse` like `RejectedFiles` so the transcript's viewport does not jump in one frame
(`pending-question.tsx:51`).)*
