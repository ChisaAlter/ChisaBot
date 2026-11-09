#!/bin/bash
# Real archives and fake service commands; never a running deployment.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export FIXTURE_ROOT=$TMP
mkdir -p "$TMP"/{updater,compose/auth,auth-data,workspace,profiles,bin}
cp "$HERE/complete-backup.sh" "$HERE/backup-state.mjs" "$HERE/backup-config.mjs" "$TMP/updater/"
printf 'database snapshot\n' > "$TMP/auth-data/sessions.sqlite"
printf 'user file\n' > "$TMP/workspace/report.txt"
printf 'browser state\n' > "$TMP/profiles/state"
printf 'private login config\n' > "$TMP/compose/auth/config.json"
printf 'services: {}\n' > "$TMP/compose/compose.yaml"
for name in api computer auth; do printf 'up\n' > "$TMP/$name"; done
printf '[]\n' > "$TMP/containers.json"
NODE=$(command -v node)
cat > "$TMP/updater/config.env" <<EOF
CONTAINER=fixture-api
COMPOSE_DIR='$TMP/compose'
COMPOSE_FILE=compose.yaml
CHISABOT_DSH_NODE='$NODE'
CHISABOT_FULL_BACKUP_DIR='$TMP/full'
CHISABOT_BACKUP_AUTH_CONTAINER=fixture-auth
CHISABOT_BACKUP_GATEWAY_CONTAINER=fixture-gateway
LOCAL_URL=http://fixture.invalid
EOF
cat > "$TMP/updater/dsh-release.sh" <<'EOF'
dsh_enabled() { echo 1; }
dsh_accounts_check() { :; }
dsh_hold_admission() { echo "$1" > "$FIXTURE_ROOT/maintenance"; }
dsh_release_admission() { [ "$(cat "$FIXTURE_ROOT/maintenance")" = "$1" ] && rm "$FIXTURE_ROOT/maintenance"; }
dsh_wait_idle() { [ "${FAIL_AT:-}" != busy ]; }
dsh_snapshot() {
  [ "$(cat "$FIXTURE_ROOT/api")" = down ] && [ "$(cat "$FIXTURE_ROOT/auth")" = down ] || return 1
  [ "${FAIL_AT:-}" != snapshot ] || return 1
  mkdir "$1/accounts"
  printf 'database\n' > "$1/accounts/chisabot.dump"
  printf 'dsh session\n' > "$1/accounts/session.tgz"
}
dsh_ops() { printf '{"protocol":1,"runtimeVersion":"fixture"}\n'; }
dsh_readiness() { [ "$(cat "$FIXTURE_ROOT/api")" = up ] && [ "$(cat "$FIXTURE_ROOT/auth")" = up ]; }
EOF
cat > "$TMP/bin/docker" <<'EOF'
#!/bin/bash
set -eu
printf '%s\n' "$*" >> "$FIXTURE_ROOT/calls"
case "$*" in
  'inspect -f {{.State.Running}} fixture-auth') echo true ;;
  'inspect -f {{.State.Health.Status}} fixture-auth') [ "$(cat "$FIXTURE_ROOT/auth")" = up ] && echo healthy || echo unhealthy ;;
  'inspect fixture-api fixture-auth fixture-gateway') cat "$FIXTURE_ROOT/containers.json" ;;
  'exec fixture-api /command/s6-svstat -u /run/service/computer') [ "$(cat "$FIXTURE_ROOT/computer")" = up ] && echo true || echo false ;;
  'exec fixture-api /command/s6-svc -d /run/service/'*) echo down > "$FIXTURE_ROOT/$(basename "${@: -1}")" ;;
  'exec fixture-api /command/s6-svc -u /run/service/'*) echo up > "$FIXTURE_ROOT/$(basename "${@: -1}")" ;;
  'exec fixture-api /command/s6-svwait '*) : ;;
  'stop --time 30 fixture-auth') echo down > "$FIXTURE_ROOT/auth" ;;
  'start fixture-auth') echo up > "$FIXTURE_ROOT/auth" ;;
  'inspect -f '*'/workspace'*) echo "$FIXTURE_ROOT/workspace" ;;
  'inspect -f '*'/profiles'*) echo "$FIXTURE_ROOT/profiles" ;;
  'inspect -f '*'/auth-data'*) echo "$FIXTURE_ROOT/auth-data" ;;
  'exec fixture-api cat /app/build-info.json') echo '{"buildId":"fixture-build"}' ;;
  *) echo "Unexpected service command: $*" >&2; exit 2 ;;
esac
EOF
cat > "$TMP/bin/curl" <<'EOF'
#!/bin/bash
[ "$(cat "$FIXTURE_ROOT/api")" = up ]
EOF
chmod +x "$TMP/bin/docker" "$TMP/bin/curl"
# Git Bash lacks flock; lock correctness remains covered by Linux runtime checks, not this service-order fixture.
if ! command -v flock >/dev/null; then printf '#!/bin/bash\nexit 0\n' > "$TMP/bin/flock"; chmod +x "$TMP/bin/flock"; fi
export PATH="$TMP/bin:$PATH" CHISABOT_UPDATER_HOME="$TMP/updater"

bash "$TMP/updater/complete-backup.sh"
[ ! -e "$TMP/maintenance" ]
for name in api computer auth; do [ "$(cat "$TMP/$name")" = up ]; done
find "$TMP/full" -name workspace-volume.tgz -exec tar -tzf {} \; | grep -q report.txt
bash "$TMP/updater/complete-backup.sh" --status | grep -q '"local":"ready"'
if bash "$TMP/updater/complete-backup.sh" --status --require-offsite; then echo 'Missing offsite must not report ready' >&2; exit 1; fi
echo 'ok - full capture restores services, archives files and reports missing offsite'

if FAIL_AT=snapshot bash "$TMP/updater/complete-backup.sh"; then echo 'Snapshot failure was hidden' >&2; exit 1; fi
[ ! -e "$TMP/maintenance" ]
for name in api computer auth; do [ "$(cat "$TMP/$name")" = up ]; done
echo 'ok - snapshot failure restores selected services and releases its own maintenance'

before=$(wc -l < "$TMP/calls")
if FAIL_AT=busy bash "$TMP/updater/complete-backup.sh"; then echo 'Busy backup was accepted' >&2; exit 1; fi
[ ! -e "$TMP/maintenance" ]
tail -n +"$((before + 1))" "$TMP/calls" | grep -q 's6-svc -d' && { echo 'Busy backup stopped a service' >&2; exit 1; }
echo 'ok - active execution cancels backup before stopping services'
