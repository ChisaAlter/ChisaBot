# ChisaBot UX full fixes — 2026-10-18

Branch: `fix/ux-p1-p3-full` (from main after #208 / v0.1.16)  
Repo: `/workspace/ChisaBot/repo` · no Cursor cloud agents

## PR checklist → FIX mapping

| FIX | Status | Change |
|-----|--------|--------|
| FIX-05 | done | Takeover foot `z-index` + stage flex shrink; canvas no longer steals 「交还」 clicks |
| FIX-06 | done | Release without requestId (post-restart); ZH control errors; clear stale handoff when bot holds / request terminal |
| FIX-07 | done | `doneLabel` / step lines count only successful fetches; failed steps marked |
| FIX-08 | done | `computer_list_files` vs `device_list_files` copy + result `note`; bot guidance |
| FIX-09 | done | `formatWhenAbsolute` for schedule fire messages; `useRelativeNow` on sidebar |
| FIX-10 | done | Activity log ZH labels + wrap layout; device ACTION_LABEL extras |
| FIX-11 | done | Install hint permanent dismiss; hidden while `.computer-takeover` open; takeover z=110 |
| FIX-12 | done | Collapsed/expanded work card shows failed step count / 「（失败）」 |
| FIX-13 | covered by #208 | Note in `control-blocks.test.ts`; fail-fast unattended |
| FIX-14 | covered by #208 | Same as FIX-13 / FIX-02 |
| FIX-15 | done | CC session row delete → `archiveSession` |
| FIX-16 | done | Schedules: bulk delete ended jobs under deleted bots |

## Tests

- `bun test app/tests/work-steps.test.ts shared/schedules.test.ts` — pass (incl. FIX-07 / FIX-09)
- `bun test app/tests/computer-control-button.test.tsx server/src/computer/control-blocks.test.ts` — pass
- `bunx tsc --noEmit` in `app/` and `server/` — pass

## Remaining risks

- FIX-05/06 need live takeover regression after deploy (canvas vs foot + restart handoff)
- FIX-08 is prompt/description only — model may still pick wrong tool until prompted
- FIX-15 archives (soft delete); empty drafts disappear from list but DB row remains
- FIX-16 requires bot list loaded; active orphans under deleted bots still need manual cancel
- Historical chat bubbles that already say 「今天」 / 「请点交还」 are not rewritten
