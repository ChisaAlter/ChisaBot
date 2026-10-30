# perf/ — jank harness

Measures UI jank on a production build of the web app in headless Chrome, with no real backend:
the build is served by `mock-server.mjs`, which also answers `/api/*` from `fixtures/api.json`
(signed-in user, 2 channels, a 240-message thread for `c1`, an AG-UI SSE stream for sends).

## Conditions

- Viewport 1024×673 CSS px at DPR 1.25 (Jun's Ayase window), headless `google-chrome`.
- CPU throttled 4x (`Emulation.setCPUThrottlingRate`, `--cpu`), no network throttling unless `--net`.
- Fresh temporary Chrome profile per run (deleted afterwards); every run reloads the app.
- `--trace` / `--cpuprofile` add overhead (on main, a traced run had ~1.5–2x the long-task and script ms of untraced runs). Don't mix traced and untraced runs in one table.
- Numbers are relative. Compare a base and a head measured on the same machine, back to back.

## Usage

```sh
# 1. build the app. `bun run --cwd app build` finds vite either way: app/node_modules/vite with a
#    default (isolated) `bun install`, or node_modules/vite at the root with `--linker hoisted` (CI).
#    The CI workflow calls ../node_modules/vite directly because it installs hoisted; locally that path
#    usually doesn't exist, so don't copy it from perf.yml.
bun run generate:app-config && bun run --cwd app build
# 2. measure
bun run perf:jank -- --scenario=switch,orb --runs=3 --out=perf/out/head
# 3. measure the other build (e.g. a main build copied to /tmp/dist-main) and compare
bun run perf:jank -- --dist=/tmp/dist-main --scenario=switch,orb --runs=3 --out=perf/out/base
bun run perf:compare -- perf/out/base perf/out/head --interactions --label-before=main --label-after=PR
```

Options for `perf:jank` (`node perf/jank.mjs --help`):

| option | default | meaning |
|---|---|---|
| `--scenario=a,b` | `all` | scenarios below, comma separated, always run in the listed order |
| `--runs=N` | 1 | independent runs; `summary.json` takes the median per metric |
| `--out=dir` | `perf/out/run` | output directory (gitignored under `perf/out/`) |
| `--dist=dir` | `app/dist` | the build to serve |
| `--cpu=N` | 4 | CPU throttling rate |
| `--lat=ms` | 0 | extra latency on every mock `/api` response |
| `--net` | off | Chrome network emulation (60 ms RTT, 2.5 MB/s) |
| `--trace` | off | save a Chrome trace per scenario and add a main-thread breakdown (self time by category, forced style/layout with JS stacks) |
| `--cpuprofile` | off | save a `.cpuprofile` per scenario (open in DevTools) |
| `--react` | off | record React commits (component + cause); needs a profiling build for durations |
| `--screenshots` | off | PNGs of the settings and orb screens |
| `--chrome=path` | `$CHROME_PATH` or `/usr/bin/google-chrome` | Chrome binary |
| `--tag=name` | out dir name | label in file names and logs |

## Scenarios

| name | what it does |
|---|---|
| `idle` | chat page, 5 s with no input (also records DOM / CSS / animation counts in `idle.chat`) |
| `sidebar` | toggle the sidebar 4 times, 900 ms apart |
| `panel` | open / close the narrow-width side panel sheet twice |
| `switch` | switch channels c1 ↔ c2 4 times (first visit and again) |
| `scroll` | wheel 40 steps up then 40 down in the 240-message thread |
| `stream` | type in the composer and send; the mock streams a reply over ~5 s |
| `settings` | three phases: `settings-open-cold`, `settings-pages` (first 5 pages), `settings-open-warm` |
| `resize` | viewport width 1024→1504→1024 in 16 px steps every 33 ms (approximates a window drag) |
| `orb` | signed-out `/sign` page, 8 s idle: the cost of the agent-orb animation |

## Output

`<out>/run-N.json` per run, `<out>/summary.json` with medians. Per scenario (phase):

- `fps`, `p95` (frame gap ms) — from a rAF log
- `longTasks`, `longTaskMs`, `maxLongTask` — long-task observer
- `styleMs`, `layoutMs`, `scriptMs`, `taskMs`, `layouts`, `recalcs`, `nodes`, `jsHeapMB` — `Performance.getMetrics` deltas
- `interactions[]` — per click: `inp` and its parts (`inputDelay`, `processing`, `presentation`), `firstDomChange`, `firstFrameAfterChange`, `domSettled`, `fps1s`, `dropped1s`, `longTaskMs3s`, transitions / animations that started
- `requests[]` — `/api` calls during the phase
- `trace` (with `--trace`) — `mainMs`, `selfMs` by category, `forcedMs`, `forcedTop[]`

Summary columns in `summary.json`: `inpMax`, `firstFrameMax`, `droppedMax`, `forcedMs` are the worst value of the phase.

## Compare workflow (PR tables)

Every perf PR body has a before/after table at 4x:

1. Build main and the branch, measure both with the same `--scenario` and `--runs=3`.
2. `bun run perf:compare -- <out>` with one directory prints that run alone.
3. `bun run perf:compare -- <main-out> <branch-out> --label-before=main --label-after=PR` prints the markdown table.
   Cells show `before → after (Δ%)`; ✅/⚠️ mark a ≥10% change for the better/worse. `--interactions` adds a per-click table.

CI (`.github/workflows/perf.yml`) does the same on pull requests with 1 run and puts the table in the
job summary, plus the outputs as an artifact. It is `continue-on-error` and never blocks a PR.

## Files

- `jank.mjs` — CLI harness; `summary.mjs` — medians; `compare.mjs` — markdown table
- `trace-summary.mjs` — trace breakdown; `mock-server.mjs` + `fixtures/api.json` — build server and mock API
