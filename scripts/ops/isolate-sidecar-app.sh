#!/bin/sh
# PRD-P0-02 residual: block Magpie / other shared-Docker-net sidecars from
# *initiating* TCP to the app admin port. App -> Magpie (:3425 / :3430) stays
# open; replies ride ESTABLISHED. Host scrape 127.0.0.1:3001 is untouched
# (does not traverse DOCKER-USER).
#
#   sh scripts/ops/isolate-sidecar-app.sh --apply    # idempotent (needs root + iptables)
#   sh scripts/ops/isolate-sidecar-app.sh --check    # rules present for every live peer
#   sh scripts/ops/isolate-sidecar-app.sh --verify   # live probe Magpie!-App + App->Magpie
#   sh scripts/ops/isolate-sidecar-app.sh remove
#
# Env:
#   CHISABOT_APP_CONTAINER   default openbot-zh
#   CHISABOT_APP_PORT        default 3001
#   CHISABOT_ISOLATE_NETWORKS  optional comma list; default = every user network the app is on
#   CHISABOT_MAGPIE_CONTAINER  default magpie (for --verify)
#
# Reboot: DOCKER-USER rules are ephemeral - enable deploy/magpie-isolate.service
# (or re-run --apply from deploy-serial / start.sh). See docs/ops/trust-boundary.md §5.1.
set -eu

APP=${CHISABOT_APP_CONTAINER:-openbot-zh}
PORT=${CHISABOT_APP_PORT:-3001}
MAGPIE=${CHISABOT_MAGPIE_CONTAINER:-magpie}
COMMENT=chisabot-sidecar-iso
MODE=${1:-}

case "$MODE" in
  --apply|apply) MODE=apply ;;
  --check|check) MODE=check ;;
  --verify|verify) MODE=verify ;;
  remove|--remove) MODE=remove ;;
  -h|--help|help|"")
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    printf 'isolate-sidecar-app: unknown mode %s (want --apply|--check|--verify|remove)\n' "$MODE" >&2
    exit 2
    ;;
esac

fail() { printf 'isolate-sidecar-app: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok: %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || fail "need docker"
command -v iptables >/dev/null 2>&1 || fail "need iptables"

# Same-bridge traffic only hits DOCKER-USER when br_netfilter is on.
ensure_bridge_nf() {
  if [ "$(id -u)" != 0 ]; then
    fail "br_netfilter/sysctl need root"
  fi
  if [ ! -e /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
    modprobe br_netfilter 2>/dev/null || fail "modprobe br_netfilter failed (same-bridge DROP needs it)"
  fi
  [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ] || fail "br_netfilter sysctl missing after modprobe"
  cur=$(cat /proc/sys/net/bridge/bridge-nf-call-iptables)
  if [ "$cur" != 1 ]; then
    sysctl -w net.bridge.bridge-nf-call-iptables=1 >/dev/null
    sysctl -w net.bridge.bridge-nf-call-ip6tables=1 >/dev/null
  fi
  # Persist across reboot (idempotent drop-in).
  if [ -d /etc/sysctl.d ]; then
    cat > /etc/sysctl.d/99-chisabot-sidecar-iso.conf <<'SYSCTL'
# ChisaBot PRD-P0-02: same-bridge sidecar DROP via DOCKER-USER needs br_netfilter.
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
SYSCTL
  fi
  # Ensure module on boot when systemd-modules-load is available.
  if [ -d /etc/modules-load.d ]; then
    printf 'br_netfilter\n' > /etc/modules-load.d/chisabot-sidecar-iso.conf
  fi
  ok "br_netfilter on (bridge-nf-call-iptables=1)"
}

if ! docker inspect "$APP" >/dev/null 2>&1; then
  if [ "$MODE" = check ] || [ "$MODE" = verify ]; then
    ok "app container $APP not running - skip"
    exit 0
  fi
  fail "app container $APP not found (start ChisaBot first)"
fi

# Collect user networks the app is on into $NETS (newline-separated).
NETS=""
if [ -n "${CHISABOT_ISOLATE_NETWORKS:-}" ]; then
  NETS=$(printf '%s' "$CHISABOT_ISOLATE_NETWORKS" | tr ',' '\n' | sed '/^$/d')
else
  NETS=$(docker inspect -f '{{range $k, $_ := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$APP" | while IFS= read -r n; do
    case "$n" in bridge|host|none|"") continue ;; *) printf '%s\n' "$n" ;; esac
  done)
fi

app_ip_on() {
  docker inspect -f "{{(index .NetworkSettings.Networks \"$1\").IPAddress}}" "$APP" 2>/dev/null | tr -d '\r'
}

# Write peer lines "name ip" for network $1 to stdout.
peers_on() {
  docker network inspect -f '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}' "$1" 2>/dev/null \
    | while IFS= read -r line; do
        name=${line%% *}
        addr=${line#* }
        ip=${addr%%/*}
        [ -n "$name" ] && [ -n "$ip" ] || continue
        [ "$name" = "$APP" ] && continue
        printf '%s %s\n' "$name" "$ip"
      done
}

rule_exists() { iptables -t filter -C DOCKER-USER "$@" 2>/dev/null; }

rule_add() {
  rule_exists "$@" && return 0
  iptables -t filter -I DOCKER-USER "$@"
}

rule_del() {
  while rule_exists "$@"; do
    iptables -t filter -D DOCKER-USER "$@" || break
  done
}

apply_or_remove() {
  action=$1
  if [ -z "$NETS" ]; then
    ok "no user networks on $APP - nothing to isolate"
    return 0
  fi
  echo "$NETS" | while IFS= read -r net; do
    [ -n "$net" ] || continue
    app_ip=$(app_ip_on "$net")
    case "$app_ip" in
      [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;
      *) continue ;;
    esac
    if [ "$action" = apply ]; then
      rule_add -d "$app_ip" -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment "$COMMENT" -j RETURN
    else
      rule_del -d "$app_ip" -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment "$COMMENT" -j RETURN
    fi
    peers_on "$net" | while IFS= read -r pline; do
      [ -n "$pline" ] || continue
      peer_name=${pline%% *}
      peer_ip=${pline#* }
      if [ "$action" = apply ]; then
        rule_add -s "$peer_ip" -d "$app_ip" -p tcp --dport "$PORT" -m comment --comment "$COMMENT" -j DROP
        ok "DROP $peer_name($peer_ip) -> $APP($app_ip):$PORT on $net"
      else
        rule_del -s "$peer_ip" -d "$app_ip" -p tcp --dport "$PORT" -m comment --comment "$COMMENT" -j DROP
        ok "removed DROP $peer_name -> $APP:$PORT on $net"
      fi
    done
  done
  ok "$action done (comment=$COMMENT port=$PORT)"
}

check_rules() {
  if [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
    nf=$(cat /proc/sys/net/bridge/bridge-nf-call-iptables)
    [ "$nf" = 1 ] || fail "bridge-nf-call-iptables=$nf (need 1 or same-bridge DROP is a no-op) — run --apply"
  else
    fail "br_netfilter not loaded — run --apply"
  fi
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  peers_seen=0
  missing=0
  if [ -z "$NETS" ]; then
    ok "no user networks on $APP - isolation N/A"
    return 0
  fi
  # Use a single loop without nested pipe-state loss: dump pairs first.
  : > "$tmp.peers"
  echo "$NETS" | while IFS= read -r net; do
    [ -n "$net" ] || continue
    app_ip=$(app_ip_on "$net")
    case "$app_ip" in
      [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;
      *) continue ;;
    esac
    printf '%s %s\n' "$net" "$app_ip" >> "$tmp.nets"
    peers_on "$net" | while IFS= read -r pline; do
      [ -n "$pline" ] || continue
      printf '%s %s %s\n' "$net" "$app_ip" "$pline" >> "$tmp.peers"
    done
  done
  if [ ! -s "$tmp.peers" ]; then
    ok "no sidecar peers on app networks - isolation N/A"
    rm -f "$tmp.nets" "$tmp.peers"
    trap - EXIT
    return 0
  fi
  if [ -f "$tmp.nets" ]; then
    while read -r net app_ip; do
      [ -n "$app_ip" ] || continue
      if ! rule_exists -d "$app_ip" -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment "$COMMENT" -j RETURN; then
        printf 'missing ESTABLISHED RETURN for app %s on %s\n' "$app_ip" "$net" >&2
        missing=$((missing + 1))
      fi
    done < "$tmp.nets"
  fi
  while read -r net app_ip peer_name peer_ip; do
    peers_seen=$((peers_seen + 1))
    if ! rule_exists -s "$peer_ip" -d "$app_ip" -p tcp --dport "$PORT" -m comment --comment "$COMMENT" -j DROP; then
      printf 'missing DROP %s(%s) -> %s:%s on %s\n' "$peer_name" "$peer_ip" "$APP" "$PORT" "$net" >&2
      missing=$((missing + 1))
    else
      ok "rule present: $peer_name -> $APP:$PORT ($net)"
    fi
  done < "$tmp.peers"
  rm -f "$tmp.nets" "$tmp.peers"
  trap - EXIT
  [ "$missing" = 0 ] || fail "$missing isolation rule(s) missing - run: sh scripts/ops/isolate-sidecar-app.sh --apply"
  ok "all $peers_seen sidecar->app:$PORT DROP rules present"
}

verify_live() {
  check_rules
  if ! docker inspect "$MAGPIE" >/dev/null 2>&1; then
    ok "Magpie container $MAGPIE not running - skip live probe"
    return 0
  fi
  if docker exec "$MAGPIE" wget -q -T 2 -O /dev/null "http://$APP:$PORT/api/version" 2>/dev/null; then
    fail "Magpie can still reach $APP:$PORT - isolation not effective"
  fi
  ok "Magpie!-$APP:$PORT (blocked or unreachable)"
  if out=$(docker exec "$APP" node -e "fetch('http://magpie:3425/v1/models').then(r=>{console.log(r.status);process.exit(0)}).catch(e=>{console.error(String(e));process.exit(1)})" 2>&1); then
    ok "App->magpie:3425 still reachable (HTTP $(printf '%s' "$out" | head -1))"
  else
    printf '%s\n' "$out" >&2
    fail "App->magpie:3425 broken - isolation must not break Magpie↔ChisaBot model path"
  fi
}

case "$MODE" in
  apply) ensure_bridge_nf; apply_or_remove apply ;;
  remove) apply_or_remove remove ;;
  check) check_rules ;;
  verify) verify_live ;;
esac

printf '\nisolate-sidecar-app: %s ALL GREEN\n' "$MODE"
