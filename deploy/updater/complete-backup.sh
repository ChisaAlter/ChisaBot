#!/bin/bash
# Reuse the updater's maintenance, drain and DSH snapshot contracts for a full private-instance backup.
# run: complete-backup.sh [--status [--require-offsite]]; install this as the existing daily timer's ExecStart.
set -euo pipefail
umask 077
U=${CHISABOT_UPDATER_HOME:-/opt/chisabot-updater}
. "$U/config.env"
. "$U/dsh-release.sh"
NODE=${CHISABOT_DSH_NODE:-node}
ROOT=${CHISABOT_FULL_BACKUP_DIR:-/opt/chisabot-backups/full}
MAX_AGE=${CHISABOT_BACKUP_MAX_AGE_HOURS:-30}
if [ "${1:-}" = --status ]; then
  shift
  [ -z "${CHISABOT_BACKUP_RESTIC_ENV:-}" ] || set -- --require-offsite "$@"
  exec "$NODE" "$U/backup-state.mjs" status "$ROOT" "$MAX_AGE" "$@"
fi
[ $# = 0 ] || { echo 'Expected --status [--require-offsite] or no arguments' >&2; exit 64; }
AUTH=${CHISABOT_BACKUP_AUTH_CONTAINER:-chisabot-web-auth}
GATEWAY=${CHISABOT_BACKUP_GATEWAY_CONTAINER:-chisabot-public-gateway}
KEEP_DAILY=${CHISABOT_BACKUP_KEEP_DAILY:-7}
KEEP_WEEKLY=${CHISABOT_BACKUP_KEEP_WEEKLY:-4}
case "$ROOT" in /*) ;; *) echo 'Full backup directory must be absolute' >&2; exit 2 ;; esac
case "$ROOT" in /|/opt|/var|/var/lib|"$U"|"$U/backups"|"$COMPOSE_DIR") echo 'Full backups need a dedicated directory' >&2; exit 2 ;; esac
case "$AUTH:$GATEWAY:$CONTAINER" in *[!A-Za-z0-9_.:-]*) echo 'Invalid container name' >&2; exit 2 ;; esac
case "$KEEP_DAILY:$KEEP_WEEKLY:$MAX_AGE" in *[!0-9:]*) echo 'Invalid retention/age setting' >&2; exit 2 ;; esac
if [ -n "${CHISABOT_BACKUP_RESTIC_ENV:-}" ]; then
  command -v restic >/dev/null || { echo 'Configured offsite backup requires installed restic' >&2; exit 2; }
  [ -r "$CHISABOT_BACKUP_RESTIC_ENV" ] || { echo 'Restic environment file is unreadable' >&2; exit 2; }
fi
exec 9>"$U/update.lock"
flock -n 9 || { echo 'An update, rollback or backup is already running' >&2; exit 73; }
exec 8>"$COMPOSE_DIR/.deploy.lock"
flock -w 60 8 || { echo 'Deployment lock is busy' >&2; exit 73; }

JOB="full-backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"
DEST="$ROOT/$JOB"
HELD=0 API_STOPPED=0 COMPUTER_STOPPED=0 AUTH_STOPPED=0 RECOVERY_REQUIRED=0
restore_services() {
  local failed=0
  if [ "$COMPUTER_STOPPED" = 1 ]; then
    docker exec "$CONTAINER" /command/s6-svc -u /run/service/computer && \
      docker exec "$CONTAINER" /command/s6-svwait -u -t 30000 /run/service/computer && COMPUTER_STOPPED=0 || failed=1
  fi
  if [ "$AUTH_STOPPED" = 1 ]; then docker start "$AUTH" >/dev/null && AUTH_STOPPED=0 || failed=1; fi
  if [ "$API_STOPPED" = 1 ]; then
    docker exec "$CONTAINER" /command/s6-svc -u /run/service/api && \
      docker exec "$CONTAINER" /command/s6-svwait -u -t 30000 /run/service/api && API_STOPPED=0 || failed=1
  fi
  [ "$failed" = 0 ] || return 1
  local attempt
  for attempt in $(seq 1 30); do
    if curl --fail --silent --max-time 3 "${LOCAL_URL:-http://127.0.0.1:3001}/health" >/dev/null \
      && [ "$(docker inspect -f '{{.State.Health.Status}}' "$AUTH")" = healthy ]; then return 0; fi
    sleep 1
  done
  return 1
}
finish() {
  local status=$?
  trap - EXIT
  if [ "$RECOVERY_REQUIRED" = 1 ]; then
    if restore_services && dsh_readiness; then RECOVERY_REQUIRED=0; else status=1; fi
  fi
  if [ "$HELD" = 1 ]; then
    if [ "$RECOVERY_REQUIRED" = 0 ]; then
      dsh_release_admission "$JOB" || status=1
    else
      echo 'Service recovery failed; maintenance remains held. Restore API/computer/auth before releasing it.' >&2
    fi
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT TERM

[ "$(dsh_enabled)" = 1 ] || { echo 'Full-instance backup requires the configured DSH deployment' >&2; exit 2; }
dsh_accounts_check
[ "$(docker inspect -f '{{.State.Running}}' "$AUTH")" = true ] || { echo 'Authentication service is not running' >&2; exit 2; }
# Capture configuration as restricted files, never stdout. Container identities/secret env remain inside this batch.
mkdir -p "$DEST/config"
chmod 0700 "$ROOT" "$DEST" "$DEST/config"
"$NODE" "$U/backup-state.mjs" begin "$DEST" full
docker inspect "$CONTAINER" "$AUTH" "$GATEWAY" > "$DEST/config/containers.json"
cp -p "$U/config.env" "$DEST/config/updater.env"
[ ! -f "$U/base.env" ] || cp -p "$U/base.env" "$DEST/config/updater-base.env"
if [ -n "${CHISABOT_DSH_ACCOUNTS_CONFIG:-}" ]; then cp -p "$CHISABOT_DSH_ACCOUNTS_CONFIG" "$DEST/config/dsh-accounts.json"; fi
EXTRA=${CHISABOT_BACKUP_EXTRA_PATHS:-'[]'}
# Validate configuration coverage before taking services down; capture those paths after auth is stopped.
"$NODE" "$U/backup-config.mjs" "$DEST/config" "$COMPOSE_DIR" "$EXTRA" --check
dsh_hold_admission "$JOB"
HELD=1
dsh_wait_idle
RECOVERY_REQUIRED=1 API_STOPPED=1
docker exec "$CONTAINER" /command/s6-svc -d /run/service/api
docker exec "$CONTAINER" /command/s6-svwait -d -t 30000 /run/service/api
# Embedded browser profiles are live databases; close their owning process before archiving them.
if docker exec "$CONTAINER" /command/s6-svstat -u /run/service/computer | grep -qx true; then
  COMPUTER_STOPPED=1
  docker exec "$CONTAINER" /command/s6-svc -d /run/service/computer
  docker exec "$CONTAINER" /command/s6-svwait -d -t 30000 /run/service/computer
fi
AUTH_STOPPED=1
docker stop --time 30 "$AUTH" >/dev/null
mkdir "$DEST/cutover"
dsh_snapshot "$DEST/cutover"
for volume in workspace profiles; do
  source=$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"/$volume\"}}{{.Source}}{{end}}{{end}}" "$CONTAINER")
  [ -n "$source" ] && [ -d "$source" ] || { echo "Required $volume mount is missing" >&2; exit 1; }
  tar czf "$DEST/$volume-volume.tgz" -C "$source" .
done
AUTH_DATA=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/auth-data"}}{{.Source}}{{end}}{{end}}' "$AUTH")
[ -d "$AUTH_DATA" ] && [ -f "$AUTH_DATA/sessions.sqlite" ] || { echo 'Authentication database mount is missing' >&2; exit 1; }
tar czf "$DEST/auth-data.tgz" -C "$AUTH_DATA" .
# Preserve the actual deployment files, including the login config and bind-mounted key/certificate paths.
# The deploy tree is explicit; extra absolute paths are a JSON array in config.env, e.g. certificate/config roots.
"$NODE" "$U/backup-config.mjs" "$DEST/config" "$COMPOSE_DIR" "$EXTRA"
docker exec "$CONTAINER" cat /app/build-info.json > "$DEST/build-info.json"
dsh_ops compatibility > "$DEST/runtime-compat.json"
restore_services || { echo 'Backup captured but service recovery failed' >&2; exit 1; }
dsh_readiness
RECOVERY_REQUIRED=0
dsh_release_admission "$JOB"
HELD=0
"$NODE" "$U/backup-state.mjs" complete "$DEST"

# Offsite transfer is deliberately after service restoration. Restic encrypts using its ordinary private env/file credentials.
if [ -n "${CHISABOT_BACKUP_RESTIC_ENV:-}" ]; then
  (
    set -a
    . "$CHISABOT_BACKUP_RESTIC_ENV"
    set +a
    case "${RESTIC_REPOSITORY:-}" in sftp:*|s3:*|b2:*|azure:*|gs:*|rclone:*|rest:*) ;; *) echo 'Offsite repository must be remote' >&2; exit 2 ;; esac
    restic backup --json --tag chisabot-full -- "$DEST" > "$ROOT/.$JOB-restic.jsonl" 2> "$ROOT/.$JOB-restic-errors.log" \
      || { echo 'Offsite copy failed; local backup is retained. See the private Restic error log.' >&2; exit 1; }
  )
  "$NODE" "$U/backup-state.mjs" offsite-receipt "$DEST" "$ROOT/.$JOB-restic.jsonl"
  rm "$ROOT/.$JOB-restic.jsonl" "$ROOT/.$JOB-restic-errors.log"
else
  echo 'Local backup complete; offsite storage is not configured.'
fi
"$NODE" "$U/backup-state.mjs" prune "$ROOT" full "$KEEP_DAILY" "$KEEP_WEEKLY"
"$NODE" "$U/backup-state.mjs" status "$ROOT" "$MAX_AGE"
