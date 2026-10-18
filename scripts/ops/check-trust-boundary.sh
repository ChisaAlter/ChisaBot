#!/bin/sh
# Deny-by-default trust-boundary check (v0.1.33+; nginx sync in v0.1.34).
# Run from repo root or any cwd; validates compose binds, nginx Local-Caller clear,
# friend TRUSTED_ORIGINS, sync-nginx round-trip. Exit 0 = green. Used by CI red-line (via bun test) and hosts.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
fail() { printf 'check-trust-boundary: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok: %s\n' "$*"; }

# 1) compose port publishes must be 127.0.0.1
for f in deploy/compose.yaml deploy/magpie.compose.yaml; do
  test -f "$f" || fail "missing $f"
  if grep -E '^[[:space:]]*-[[:space:]]*"?0\.0\.0\.0:' "$f" >/dev/null 2>&1; then
    fail "$f publishes on 0.0.0.0"
  fi
  if grep -E '^[[:space:]]*-[[:space:]]*"?[0-9]+:[0-9]+("|$|/)' "$f" >/dev/null 2>&1; then
    fail "$f has bare host port publish"
  fi
  grep -E '127\.0\.0\.1:[0-9]+:[0-9]+' "$f" >/dev/null || fail "$f has no 127.0.0.1 port bind"
  ok "$f loopback binds"
done

# 2) nginx clears Local-Caller on every app proxy
NGINX=deploy/public/nginx.conf
test -f "$NGINX" || fail "missing $NGINX"
passes=$(grep -c 'proxy_pass http://127.0.0.1:3001;' "$NGINX" || true)
clears=$(grep -c 'proxy_set_header X-ChisaBot-Local-Caller "";' "$NGINX" || true)
[ "$passes" -gt 0 ] || fail "nginx has no app proxy_pass"
[ "$clears" -ge "$passes" ] || fail "nginx Local-Caller clears ($clears) < app proxies ($passes)"
ok "nginx Local-Caller cleared on $passes app proxies"

# 3) friend TRUSTED_ORIGINS example is loopback http
EX=deploy/friend.env.example
origins=$(sed -n 's/^TRUSTED_ORIGINS=//p' "$EX" | head -1)
case "$origins" in
  *https://*) fail "friend.env.example TRUSTED_ORIGINS has https" ;;
  *http://localhost*|*http://127.0.0.1*) ok "friend.env.example TRUSTED_ORIGINS loopback" ;;
  *) fail "friend.env.example TRUSTED_ORIGINS unexpected: $origins" ;;
esac

# 4) bun red-line (when bun available)
if command -v bun >/dev/null 2>&1; then
  bun test shared/trust-boundary.test.ts server/tests/trust-boundary-redline.test.ts
  ok "bun trust-boundary red-line"
else
  ok "bun not installed — skipped unit red-line"
fi

# 5) nginx template render round-trip (v0.1.34 — durable sync, apply-or-fail on host)
test -f scripts/ops/sync-nginx.sh || fail "missing scripts/ops/sync-nginx.sh"
sh scripts/ops/sync-nginx.sh --check-repo
ok "sync-nginx --check-repo"

printf '\ncheck-trust-boundary: ALL GREEN\n'
