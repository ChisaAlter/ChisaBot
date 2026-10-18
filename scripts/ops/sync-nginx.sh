#!/bin/sh
# Production nginx ↔ repo template sync (v0.1.34).
#
# Prevents silent drift (e.g. missing X-ChisaBot-Local-Caller clears) between
# deploy/public/nginx.conf and the live gateway conf on the host.
#
# Usage (from repo root or any cwd):
#   sh scripts/ops/sync-nginx.sh --check-repo          # CI / pre-merge: template + render round-trip
#   sh scripts/ops/sync-nginx.sh --check                # host: live conf must clear Local-Caller
#   sh scripts/ops/sync-nginx.sh --apply                # host: render → backup → install → nginx -t → reload
#   sh scripts/ops/sync-nginx.sh --apply --dry-run      # render + validate only (no write / reload)
#
# Env:
#   CHISABOT_PUBLIC_DIR   live gateway public dir (default /opt/openbot-zh/public)
#   CHISABOT_REPO         repo root with deploy/public/nginx.conf (default: discovered)
#   CHISABOT_GATEWAY      gateway container (default openbot-public-gateway)
#   ENV_FILE              for render-nginx.sh (default $PUBLIC_DIR/../.env)
#
# Exit 0 = green. Non-zero = drift / validate fail — do not ignore (apply-or-fail).
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
REPO=${CHISABOT_REPO:-$ROOT}
PUBLIC_DIR=${CHISABOT_PUBLIC_DIR:-/opt/openbot-zh/public}
GATEWAY=${CHISABOT_GATEWAY:-openbot-public-gateway}
MODE=check-repo
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check-repo) MODE=check-repo; shift ;;
    --check) MODE=check; shift ;;
    --apply) MODE=apply; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "sync-nginx: unknown arg $1" >&2; exit 64 ;;
  esac
done

fail() { printf 'sync-nginx: FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'sync-nginx: ok: %s\n' "$*"; }

TEMPLATE="$REPO/deploy/public/nginx.conf"
RENDER="$REPO/deploy/public/render-nginx.sh"
test -f "$TEMPLATE" || fail "missing template $TEMPLATE"
test -f "$RENDER" || fail "missing $RENDER"

assert_local_caller_clears() {
  conf=$1
  label=$2
  test -f "$conf" || fail "missing $label ($conf)"
  passes=$(grep -c 'proxy_pass http://127.0.0.1:3001;' "$conf" || true)
  clears=$(grep -c 'proxy_set_header X-ChisaBot-Local-Caller "";' "$conf" || true)
  [ "$passes" -gt 0 ] || fail "$label has no app proxy_pass to :3001"
  [ "$clears" -ge "$passes" ] || fail "$label Local-Caller clears ($clears) < app proxies ($passes) — template drifted or live conf stale"
  ok "$label Local-Caller cleared on $passes app proxies"
}

assert_security_markers() {
  conf=$1
  label=$2
  for needle in \
    'proxy_set_header X-ChisaBot-Local-Caller "";' \
    'auth_request /_openbot/auth-check;' \
    'location ^~ /api/devices/agent/' \
    'location ^~ /api/im/onebot/' \
    'location ^~ /p/'
  do
    grep -F "$needle" "$conf" >/dev/null || fail "$label missing marker: $needle"
  done
  ok "$label security markers present"
}

# Render template → $1 using ENV_FILE (real domain) or synthetic CI domain.
render_into() {
  out=$1
  tmpd=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpd'" EXIT
  cp "$TEMPLATE" "$tmpd/nginx.conf"
  env_file=${ENV_FILE:-}
  if [ -z "$env_file" ] && [ -f "$PUBLIC_DIR/../.env" ]; then
    env_file=$PUBLIC_DIR/../.env
  fi
  if [ -n "$env_file" ] && [ -f "$env_file" ]; then
    cp "$RENDER" "$tmpd/render-nginx.sh"
    chmod +x "$tmpd/render-nginx.sh"
    ENV_FILE=$env_file sh "$tmpd/render-nginx.sh" || fail "render-nginx.sh failed (need CHISABOT_DOMAIN in $env_file)"
    cp "$tmpd/nginx.generated.conf" "$out"
  else
    # Synthetic: prove sed substitutions keep Local-Caller clears
    D=${CHISABOT_DOMAIN:-ci.example.test}
    P=${CHISABOT_HTTPS_PORT:-8443}
    M=${CHISABOT_MAGPIE_PORT:-2053}
    C=${CHISABOT_CERT_NAME:-$D}
    o() { if [ "$1" = 443 ]; then printf '%s' "$D"; else printf '%s:%s' "$D" "$1"; fi; }
    OP=$(o "$P"); OM=$(o "$M")
    sed -e "s#/live/chisabot\.example\.com/#/live/$C/#g" \
        -e "s#chisabot\.example\.com:8443#$OP#g" \
        -e "s#chisabot\.example\.com:2053#$OM#g" \
        -e "s#listen 8443 ssl#listen $P ssl#" \
        -e "s#listen 2053 ssl#listen $M ssl#" \
        -e "s#chisabot\.example\.com#$D#g" \
        "$tmpd/nginx.conf" > "$out"
  fi
  assert_local_caller_clears "$out" "rendered"
  assert_security_markers "$out" "rendered"
}

case "$MODE" in
  check-repo)
    assert_local_caller_clears "$TEMPLATE" "repo template"
    assert_security_markers "$TEMPLATE" "repo template"
    out=$(mktemp)
    # Force synthetic path for CI determinism (ignore host .env)
    ENV_FILE= render_into "$out"
    grep -E 'ci\.example\.test|chisabot\.example\.com' "$out" >/dev/null \
      || fail "synthetic render lost server_name"
    rm -f "$out"
    ok "check-repo ALL GREEN"
    ;;
  check)
    LIVE=${CHISABOT_NGINX_LIVE:-}
    if [ -z "$LIVE" ]; then
      if [ -f "$PUBLIC_DIR/nginx.generated.conf" ]; then
        LIVE=$PUBLIC_DIR/nginx.generated.conf
      else
        LIVE=$PUBLIC_DIR/nginx.conf
      fi
    fi
    assert_local_caller_clears "$LIVE" "live $LIVE"
    assert_security_markers "$LIVE" "live $LIVE"
    t_clears=$(grep -c 'proxy_set_header X-ChisaBot-Local-Caller "";' "$TEMPLATE" || true)
    l_clears=$(grep -c 'proxy_set_header X-ChisaBot-Local-Caller "";' "$LIVE" || true)
    [ "$l_clears" -ge "$t_clears" ] || fail "live Local-Caller clears ($l_clears) < template ($t_clears) — run: sh scripts/ops/sync-nginx.sh --apply"
    ok "check ALL GREEN (live matches template Local-Caller floor)"
    ;;
  apply)
    test -d "$PUBLIC_DIR" || fail "PUBLIC_DIR missing: $PUBLIC_DIR (set CHISABOT_PUBLIC_DIR)"
    if [ -z "${ENV_FILE:-}" ] && [ -f "$PUBLIC_DIR/../.env" ]; then
      ENV_FILE=$PUBLIC_DIR/../.env
      export ENV_FILE
    fi
    [ -n "${ENV_FILE:-}" ] && [ -f "$ENV_FILE" ] || fail "ENV_FILE / $PUBLIC_DIR/../.env required for --apply (need CHISABOT_DOMAIN)"
    out=$(mktemp)
    render_into "$out"
    if [ "$DRY" = 1 ]; then
      ok "dry-run: would install to $PUBLIC_DIR (nginx -t + reload skipped)"
      rm -f "$out"
      exit 0
    fi
    stamp=$(date +%Y%m%d%H%M%S)
    for existing in "$PUBLIC_DIR/nginx.generated.conf" "$PUBLIC_DIR/nginx.conf"; do
      if [ -f "$existing" ]; then
        cp -a "$existing" "$existing.bak-nginx-sync-$stamp"
        ok "backed up $existing → $(basename "$existing").bak-nginx-sync-$stamp"
      fi
    done
    cp "$out" "$PUBLIC_DIR/nginx.generated.conf"
    if [ -f "$PUBLIC_DIR/nginx.conf" ]; then
      cp "$out" "$PUBLIC_DIR/nginx.conf"
      ok "installed rendered conf → nginx.conf + nginx.generated.conf"
    else
      ok "installed rendered conf → nginx.generated.conf"
    fi
    rm -f "$out"
    if docker inspect "$GATEWAY" >/dev/null 2>&1; then
      docker exec "$GATEWAY" nginx -t || fail "nginx -t failed — restore bak-nginx-sync-$stamp"
      docker exec "$GATEWAY" nginx -s reload || fail "nginx reload failed"
      ok "gateway $GATEWAY: nginx -t + reload"
    else
      ok "gateway container $GATEWAY not running — conf written; start gateway to pick up"
    fi
    assert_local_caller_clears "$PUBLIC_DIR/nginx.generated.conf" "post-apply"
    ok "apply ALL GREEN"
    ;;
  *) fail "unknown mode $MODE" ;;
esac
