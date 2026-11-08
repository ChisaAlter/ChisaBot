#!/bin/bash
# Isolated orchestration checks; real backup-state/openssl/curl, fixture Docker and disk response.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(cd "$HERE/../../work" && pwd -P)
TMP=$(mktemp -d "$WORK/host-monitor.XXXXXX")
cleanup() {
  local target
  target=$(cd "$TMP" && pwd -P) || return
  case "$target" in "$WORK"/host-monitor.*) rm -rf -- "$target" ;; esac
}
trap cleanup EXIT
export FIXTURE_ROOT=$TMP
mkdir -p "$TMP"/{updater,compose,bin,full/batch}
cp "$HERE"/{host-monitor.sh,complete-backup.sh,backup-state.mjs,dsh-release.sh} "$TMP/updater/"
NODE=$(command -v node)
REAL_CURL=$(command -v curl)
export REAL_CURL
"$NODE" "$HERE/backup-state.mjs" begin "$TMP/full/batch" full
printf 'fixture database\n' > "$TMP/full/batch/database.dump"
"$NODE" "$HERE/backup-state.mjs" complete "$TMP/full/batch" >/dev/null
printf '{}\n' > "$TMP/compose/.dsh-reader.json"
MSYS2_ARG_CONV_EXCL=/CN=fixture.invalid openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=fixture.invalid' \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1
MSYS2_ARG_CONV_EXCL=/CN=fixture.invalid openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=fixture.invalid' \
  -keyout "$TMP/short-key.pem" -out "$TMP/short-cert.pem" >/dev/null 2>&1
cat > "$TMP/updater/config.env" <<EOF
CONTAINER=fixture-api
COMPOSE_DIR='$TMP/compose'
LOCAL_URL=http://127.0.0.1:1
CHISABOT_DSH_NODE='$NODE'
CHISABOT_FULL_BACKUP_DIR='$TMP/full'
CHISABOT_MONITOR_DISK_PERCENT=80
CHISABOT_MONITOR_CERT_FILE='$TMP/cert.pem'
EOF
cat > "$TMP/bin/docker" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "$FIXTURE_ROOT/docker-calls"
case "$*" in
  'exec fixture-api test -f /app/deploy/dsh/ops.ts') [ "${CONTAINER_DOWN:-0}" = 0 ] ;;
  *'ops.ts health') [ "${DSH_DOWN:-0}" = 0 ] ;;
  *'ops.ts signals')
    [ "${ASSISTANT_UNREADABLE:-0}" = 0 ] || exit 1
    if [ "${ASSISTANT_ATTENTION:-0}" = 1 ]; then printf '{"ok":false,"state":"needs_attention","unknown":{"personalDeliveriesAtLeast":1,"toolOperationsAtLeast":0},"coverage":{"unknownCounts":"lower_bound"}}\n'; exit 1
    else printf '{"ok":true,"state":"clear_in_sample","coverage":{"unknownCounts":"lower_bound"}}\n'; fi ;;
  *) echo 'Unexpected Docker mutation or query' >&2; exit 2 ;;
esac
EOF
cat > "$TMP/bin/curl" <<'EOF'
#!/bin/bash
if [ "${APP_DOWN:-0}" = 1 ]; then exec "$REAL_CURL" "$@"; fi
printf 200
EOF
cat > "$TMP/bin/df" <<'EOF'
#!/bin/bash
if [ "${DISK_FULL:-0}" = 1 ]; then USED=99; else USED=20; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\nfixture with-space 100 20 80 %s%% /\n' "$USED"
EOF
chmod +x "$TMP/bin/"*
export CHISABOT_UPDATER_HOME="$TMP/updater" PATH="$TMP/bin:$PATH"
run() {
  local expected=$1; shift
  set +e
  env "$@" bash "$TMP/updater/host-monitor.sh" > "$TMP/result"
  local code=$?
  set -e
  cat "$TMP/result"
  [ "$code" = "$expected" ]
}
if [ "${1:-}" = --signals ]; then
  run 0
  grep -q '"check":"assistant","ok":true.*"state":"clear_in_sample"' "$TMP/result"
  run 1 ASSISTANT_ATTENTION=1
  grep -q '"check":"dsh","ok":true' "$TMP/result"
  grep -q '"check":"assistant","ok":false.*"state":"needs_attention"' "$TMP/result"
  grep -q '"check":"certificate","ok":true' "$TMP/result"
  run 1 ASSISTANT_UNREADABLE=1
  grep -q '"check":"assistant","ok":false,"state":"unreadable"' "$TMP/result"
  echo 'ok - business attention and unreadable signals remain independent from ready DSH'
  exit 0
fi
run 0
grep -q '"check":"backup","ok":true.*"local":"ready","offsite":"missing"' "$TMP/result"
echo 'ok - real backup status keeps offsite missing distinct from local ready'
run 1 APP_DOWN=1
grep -q '"check":"app","ok":false' "$TMP/result"
grep -q '"check":"dsh","ok":true' "$TMP/result"
grep -q '"check":"certificate","ok":true' "$TMP/result"
echo 'ok - real connection refusal is visible while independent checks continue'
run 1 DSH_DOWN=1
grep -q '"check":"app","ok":true' "$TMP/result"
grep -q '"check":"dsh","ok":false' "$TMP/result"
run 1 CONTAINER_DOWN=1
grep -q '"check":"dsh","ok":false' "$TMP/result"
echo 'ok - Host failure and inaccessible API container never become DSH success'
"$NODE" -e 'const fs=require("fs"),p=process.argv[1],d=JSON.parse(fs.readFileSync(p));d.completedAt="2000-01-01T00:00:00.000Z";fs.writeFileSync(p,JSON.stringify(d))' "$TMP/full/batch/backup-manifest.json"
run 1 DISK_FULL=1
grep -q '"check":"backup","ok":false.*"local":"stale"' "$TMP/result"
grep -q '"check":"disk","ok":false,"usedPercent":99' "$TMP/result"
echo 'ok - real stale backup and disk threshold signal independently'
mv "$TMP/cert.pem" "$TMP/old-cert.pem"
cp "$TMP/short-cert.pem" "$TMP/cert.pem"
run 1
grep -q '"check":"certificate","ok":false,"state":"expiring"' "$TMP/result"
echo 'ok - actual short-lived X509 certificate signals expiration window'
mv "$TMP/full/batch" "$TMP/retained-batch"
printf 'CHISABOT_MONITOR_CERT_FILE=\n' >> "$TMP/updater/config.env"
run 1
grep -q '"check":"backup","ok":false.*"local":"missing"' "$TMP/result"
grep -q '"check":"certificate","ok":false,"state":"unconfigured"' "$TMP/result"
echo 'ok - missing backup and unconfigured active certificate remain visible'
if grep -Eq 's6-svc| start | stop |restart|reconcile|snapshot| run ' "$TMP/docker-calls"; then
  echo 'Monitor invoked a mutation' >&2; exit 1
fi
