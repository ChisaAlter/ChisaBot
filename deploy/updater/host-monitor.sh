#!/bin/bash
# Host checks and a persisted observation for the existing notification sweep.
# Reuse the account timer; never restart or repair services here.
set -uo pipefail
U=${CHISABOT_UPDATER_HOME:-/opt/chisabot-updater}
if ! . "$U/config.env" 2>/dev/null; then
  printf '%s\n' '{"type":"host-monitor","check":"config","ok":false,"state":"unreadable"}'
  exit 1
fi
export U CONTAINER COMPOSE_DIR
RESULT=0
ROWS=""
record() {
  printf '%s\n' "$1"
  ROWS+="$1"$'\n'
}
emit() {
  record "$(printf '{"type":"host-monitor","check":"%s","ok":%s,"state":"%s"}' "$1" "$2" "$3")"
  [ "$2" = true ] || RESULT=1
}

# Check the API separately: a working Host must not disguise a dead API process.
HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "${LOCAL_URL:-http://127.0.0.1:3001}/health" 2>/dev/null) || HTTP=000
if [ "$HTTP" = 200 ]; then emit app true ready; else emit app false unavailable; fi

# A persisted reader marks an established DSH deployment even if the API container is stopped.
if [ -s "${COMPOSE_DIR:-}/.dsh-reader.json" ]; then DSH=1
else
  DSH=$(timeout 20 bash -c '. "$U/dsh-release.sh"; dsh_enabled' 2>/dev/null) || DSH=unknown
fi
case "$DSH" in
  1)
    if timeout 60 bash -c '. "$U/dsh-release.sh"; dsh_available && dsh_readiness' >/dev/null 2>&1; then
      emit dsh true ready
    else emit dsh false unavailable; fi
    SIGNALS=$(timeout 20 bash -c '. "$U/dsh-release.sh"; dsh_ops signals' 2>/dev/null)
    SIGNALS_EXIT=$?
    if [[ "$SIGNALS" = \{*\} ]]; then
      if [ "$SIGNALS_EXIT" = 0 ]; then OK=true; else OK=false; RESULT=1; fi
      record "$(printf '{"type":"host-monitor","check":"assistant","ok":%s,"details":%s}' "$OK" "$SIGNALS")"
    else emit assistant false unreadable; fi ;;
  0) emit dsh true not_selected ;;
  *) emit dsh false unreadable ;;
esac

# backup-state owns artifact/age/offsite semantics; do not infer health from directory presence.
BACKUP=$(timeout 15 bash "$U/complete-backup.sh" --status 2>/dev/null)
BACKUP_EXIT=$?
if [[ "$BACKUP" = \{*\} ]]; then
  if [ "$BACKUP_EXIT" = 0 ]; then OK=true; else OK=false; RESULT=1; fi
  record "$(printf '{"type":"host-monitor","check":"backup","ok":%s,"details":%s}' "$OK" "$BACKUP")"
else emit backup false unreadable; fi

LIMIT=${CHISABOT_MONITOR_DISK_PERCENT:-80}
if [[ "$LIMIT" =~ ^([1-9][0-9]?|100)$ ]]; then
  USED=$(df -P / 2>/dev/null | awk 'END {value=$(NF-1); gsub(/%/, "", value); print value}')
  if [[ "$USED" =~ ^[0-9]+$ ]]; then
    if [ "$USED" -lt "$LIMIT" ]; then OK=true; else OK=false; RESULT=1; fi
    record "$(printf '{"type":"host-monitor","check":"disk","ok":%s,"usedPercent":%s,"limitPercent":%s}' "$OK" "$USED" "$LIMIT")"
  else emit disk false unreadable; fi
else emit disk false invalid_config; fi

# Set this to the active gateway certificate, not a copied or test certificate.
CERT=${CHISABOT_MONITOR_CERT_FILE:-}
DAYS=${CHISABOT_MONITOR_CERT_DAYS:-14}
if [ -z "$CERT" ]; then emit certificate false unconfigured
elif ! [[ "$DAYS" =~ ^[1-9][0-9]*$ ]] || [ "$DAYS" -gt 365 ]; then emit certificate false invalid_config
elif ! openssl x509 -in "$CERT" -noout >/dev/null 2>&1; then emit certificate false unreadable
elif openssl x509 -in "$CERT" -noout -checkend "$((DAYS * 86400))" >/dev/null 2>&1; then emit certificate true ready
else emit certificate false expiring; fi

# No webhook secrets or sending code on the host. The API consumes this observation through
# its existing read-only updater mount and uses the configured owner's durable delivery ledger.
if ! printf '%s' "$ROWS" | CHISABOT_MONITOR_NOTIFY_OWNER="${CHISABOT_MONITOR_NOTIFY_OWNER:-}" \
  "${CHISABOT_DSH_NODE:-node}" "$U/host-monitor-state.mjs" "$U/spool/state/host-monitor.json"; then
  emit observation false unwritable
fi
exit "$RESULT"
