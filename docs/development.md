# Development

Start with [Quick start](getting-started.md) for the current DSH, database, encryption and login setup. The maintained system layout is [Architecture](architecture.md); first installation uses the [self-hosting guide](../deploy/README.zh-CN.md), and existing deployments use [serial release and recovery](ops/deploy.md).

## Setup

Install Docker, [Bun](https://bun.sh) 1.3.14, Node.js 24.9 or later, `lsof`, `openssl`, and `curl`.
Configure your own environment and encryption key as described in Quick start before starting services.

```sh
cp .env.example .env
bun install --frozen-lockfile --omit=peer
```

`CHISABOT_RUNTIME_MODE=local` keeps product conversations in PostgreSQL. DSH also needs its account Host, targets and tool gateway configured; a model connection alone does not start that runtime. Follow [DSH operations](ops/dsh-runtime.md) for that wiring.

## Running services

Run `bun run dev` for the frontend and API (app 3010, server 3001); prepare the database and DSH Host separately. For an installed deployment, `deploy/start.sh` builds the root Dockerfile's `chisabot` target; upgrades follow [the serial release path](ops/deploy.md).

Historical note: the upstream laptop stack (`scripts/start.sh`, `stop.sh` and the root `docker-compose.yml`, including agent-bot, agent-langgraph, supervisor and SPIRE) was removed in slimming P3 on 2026-10-15. These are not current startup entrypoints.

**Nothing here sweeps staged attachments.** A file dropped into the composer is stored before the
message is sent, and the only thing that reclaims the ones never sent is
`bun scripts/cull-staged-attachments.ts` from `server/`. The local `bun run dev` process does not schedule it.
It needs only `DATABASE_URL`, and takes a
retention window in hours as its one optional argument, defaulting to 24. On a laptop that is
usually nothing, because the rows are small and the database is yours. It stops being nothing at
thirty-two: one person may hold that many unsent files across every channel at once, the refusal on
the next one promises they are cleared within a day, and where nothing sweeps they are not, so a
long-lived local deployment can reach a state where attaching anything is refused. Removing a file
in the composer deletes it outright, so it takes abandoned drafts rather than ordinary use.
For a persistent deployment, use the attachment timer described in the [self-hosting guide](../deploy/README.zh-CN.md#数据与兼容性) and the [operations guide](ops/deploy.md).

## Migrations

After changing the Drizzle schema:

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

Review generated migration files before sharing them. `start.sh` applies existing migrations when it starts the stack.

**Do not hand-edit a generated migration.** It leaves a file that no longer matches what the
generator produced. If the generated SQL will not work — `ADD COLUMN ... NOT NULL` fails on a table
that already has rows — split it instead: generate the column nullable, add the data step, then
generate the constraint.

**A constraint that tightens an existing column belongs to a later release**, not to the release that
adds the column. A rolling deploy runs the migrations and then serves from old and new replicas at
once, and an old replica writes rows without the new column: under `NOT NULL` its writes start
failing, so the release that added the column breaks for everybody who lands on a replica that has
not been replaced yet. Ship the column nullable, let the fleet turn over, then tighten it. `issuer`
on `accounts` is the worked example: the column is nullable and no migration tightens it.

**A data step is its own migration**, created with the flag that exists for it:

```sh
bun run --filter server db:generate -- --custom --name=backfill_something
```

A generator diffs schema against schema, so a rule like "the rows whose provider is Google get
Google's issuer" can never come out of one: it is not in the schema. `--custom` writes an empty file
registered in the journal, and it is the only migration anybody should be writing by hand.

CI enforces two things about this: `drizzle-kit check` for collisions and gaps between migrations,
and a generate-and-fail-if-dirty probe that refuses a schema change with no migration written for it.

**If `drizzle-kit migrate` hangs and then exits non-zero with no error**, the journal names a
migration file that is not there. A rebase does this: `meta/_journal.json` is a checked-in file, so
restoring it can reinstate entries for migrations that were renamed. `drizzle-kit check` reports
"Everything's fine" in that state, because it compares schemas rather than checking that the journal
and the directory agree. Compare `meta/_journal.json` against `ls server/drizzle/*.sql`.

## Quality checks

Run these before opening a pull request:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Integration tests expect a PostgreSQL database with pgvector. Point `TEST_DATABASE_URL` at a dedicated database such as `postgres://openbot:openbot@localhost:5432/openbot_test` before running them.

They refuse to use the application `chisabot` database. `DATABASE_URL` is still the application setting, and the database client removes it from the process environment after opening a connection to preserve the Windows Bun connection fix, so tests use `TEST_DATABASE_URL` as their immutable fixture address. Running them against a deployment you are using puts test Bots in its audit trail and its activity reports, so create a separate database and migrate that before running the integration suite.

CI uses `bun run test:ci` to verify the expected test count in addition to normal tests.

`bun run test:smoke` is separate and needs a deployment that is up, and a session on it:

```sh
# 先用 deploy/start.sh 起一个部署
export CHISABOT_SMOKE_COOKIE='better-auth.session_token=...'
bun run test:smoke
```

It drives one journey over HTTP against the running stack, so it covers the joins the rest of the
suite cannot reach: server to supervisor to computer, the gateway deciding before the browser acts,
and the audit row landing. Point it elsewhere with `CHISABOT_API_URL`. Without a deployment it is
skipped by `bun run test` and says what to start when asked for by name.

The session is not optional and not a convenience. Every route the journey proves is behind
`requireUser`, so without one the three tests that act on a computer answer 401 and the run reports
a broken deployment when nothing is broken. Take the cookie from a browser already signed in to the
deployment under test, from DevTools under Application, Cookies. It is a credential with that
person's reach: it belongs in the environment of the run, not in a file or a pull request comment.
Asked for without it, the run stops before the first test and names the variable.

`bun run test:live-screen` is separate for a related reason and needs no deployment, only this
directory's own dependencies:

```sh
cd agent-computer && bun install
cd .. && bun run test:live-screen
```

It drives the live screen against the real computer process with a real Chromium: a socket closing
while the browser is still starting, a second connection taking the screen from the first, the wheel
refusing input from the socket that owns it, and a browser closing by request or by the idle sweep.
Those need `agent-computer/src/index.ts`, which imports Playwright at module scope, and `playwright`
is declared only in `agent-computer/package.json`, which `bun install` at the root does not reach. So
without `CHISABOT_LIVE_SCREEN=1` the files skip before importing anything, which is what keeps
`bun run test` and CI working where that dependency was never installed.

## Contribution checklist

- Keep changes focused.
- Keep credentials, service-account JSON, customer data, and transcripts out of source control.
- Put sensitive behavior on the server, not only in the browser.
- Update [configuration](configuration.md), [architecture](architecture.md), or the root [README](../README.md) when behavior changes.
- Run the quality checks above and include the results in the pull request.
