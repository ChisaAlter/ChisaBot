# Pipeline runs

A pipeline run is a recorded feature flow: what was required, what was planned, and which pull
request carried the result. The note stays in the repository so the next change can see why the
workflow, image name, or release step looks the way it does.

## Convention

- Add one file per run: `docs/pipeline-runs/YYYYMMDD-CB-NNN.md`.
- `YYYYMMDD` is the day the note is added. `CB-NNN` is the run id, allocated in order (`CB-001`,
  `CB-002`, …). Do not reuse an id.
- The file states the requirements, the plan that was executed, the outcome, and the pull request
  URL. A placeholder URL is filled in when the pull request exists.
- Update the index below in the same change.
- Do not store secrets, tokens, customer data, or private deployment details. Name the GitHub
  variable or secret the workflow already uses; do not copy its value.

## Index

| Run | Date | Summary |
| --- | --- | --- |
| [CB-003](20261014-CB-003.md) | 2026-10-14 | Create Bot is one step (private, on this server, empty defaults, optional portrait). The sheet matches the other dialogs, and form fields no longer draw a blue focus ring. |
| [CB-001](20261014-CB-001.md) | 2026-10-14 | Container release runs on `ChisaAlter/ChisaBot` and publishes `ghcr.io/chisaalter/chisabot`. |
