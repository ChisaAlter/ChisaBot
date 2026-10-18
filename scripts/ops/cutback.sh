#!/bin/sh
# Traffic-cut rollback helper (docs/ops/traffic-cut-rollback.md).
#
# Default is a **dry-run / no-op**: prove the previous (or requested) image exists and
# print the exact command that would cut traffic. Never touches prod unless
# CUTBACK_EXECUTE=1 is set explicitly.
#
# Usage (on Haupt as root, or with CHISABOT_* overrides):
#   sh cutback.sh                         # dry-run → previous rollback target
#   sh cutback.sh --tag auto-YYYY…-abcdef # dry-run for a specific tag
#   sh cutback.sh --list                  # list keepable auto- images + rollback scripts
#   CUTBACK_EXECUTE=1 sh cutback.sh       # actually run rollback-to-*.sh (or request.sh rollback)
#
# Exit codes: 0 ok · 2 bad args · 3 image missing · 4 script missing · 5 execute failed
set -u

COMPOSE_DIR=${CHISABOT_COMPOSE_DIR:-/opt/openbot-zh}
UPDATER=${CHISABOT_UPDATER_DIR:-/opt/chisabot-updater}
APP=${CHISABOT_APP_CONTAINER:-openbot-zh}
IMAGE_REPO=${CHISABOT_IMAGE_REPO:-local/chisabot}
EXECUTE=${CUTBACK_EXECUTE:-0}
WANT_TAG=""
MODE=dry

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) WANT_TAG=${2:?}; shift 2 ;;
    --list) MODE=list; shift ;;
    --execute) EXECUTE=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1"; usage ;;
  esac
done

list_images() {
  docker images --format '{{.Tag}}\t{{.CreatedAt}}\t{{.ID}}' "$IMAGE_REPO" 2>/dev/null \
    | awk -F '\t' '$1 ~ /^auto-/' || true
}

current_tag() {
  img=$(docker inspect -f '{{.Config.Image}}' "$APP" 2>/dev/null) || return 1
  echo "${img##*:}"
}

previous_from_scripts() {
  # Newest rollback-to-*.sh points at the image that was current when the latest swap happened
  # (= immediate previous). File name is rollback-to-<tag>.sh
  ls -1t "$COMPOSE_DIR"/rollback-to-*.sh 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null \
    | sed 's/^rollback-to-//;s/\.sh$//'
}

echo "=== cutback $(date -u +%Y-%m-%dT%H:%M:%SZ) EXECUTE=$EXECUTE ==="

if [ "$MODE" = list ]; then
  echo "-- current container --"
  docker ps --filter "name=^${APP}$" --format '{{.Names}}\t{{.Image}}\t{{.Status}}' || true
  echo "-- auto- images (newest first) --"
  list_images | head -20
  echo "-- rollback scripts (newest first) --"
  ls -1t "$COMPOSE_DIR"/rollback-to-*.sh 2>/dev/null | head -10 || echo "(none)"
  echo "-- KEEP_IMAGES --"
  grep -E '^KEEP_IMAGES=' "$UPDATER/config.env" 2>/dev/null || echo "KEEP_IMAGES=(unset, updater default 3)"
  exit 0
fi

CUR=$(current_tag) || { echo "FAIL: cannot inspect $APP"; exit 3; }
if [ -n "$WANT_TAG" ]; then
  TAG=$WANT_TAG
else
  TAG=$(previous_from_scripts)
fi
[ -n "$TAG" ] || { echo "FAIL: no previous tag (no rollback-to-*.sh and no --tag)"; exit 4; }

echo "current:  $IMAGE_REPO:$CUR"
echo "target:   $IMAGE_REPO:$TAG"

if [ "$TAG" = "$CUR" ]; then
  echo "FAIL: target equals current — refusing"
  exit 2
fi

if ! docker image inspect "$IMAGE_REPO:$TAG" >/dev/null 2>&1; then
  echo "FAIL: image $IMAGE_REPO:$TAG not present (KEEP_IMAGES may have pruned it)"
  exit 3
fi
echo "image:    present"

SCRIPT="$COMPOSE_DIR/rollback-to-$TAG.sh"
if [ -f "$SCRIPT" ]; then
  echo "script:   $SCRIPT"
  if command -v bash >/dev/null 2>&1; then
    bash -n "$SCRIPT" && echo "syntax:   ok" || { echo "syntax:   FAIL"; exit 4; }
  fi
else
  echo "script:   missing ($SCRIPT) — can still use: sh $UPDATER/request.sh rollback"
  SCRIPT=""
fi

echo "-- deploy-serial can target a known commit once it is on main; cutback uses image tag --"
echo "would_run:"
if [ -n "$SCRIPT" ]; then
  echo "  sh $SCRIPT"
else
  echo "  ACTOR=cutback sh $UPDATER/request.sh rollback"
fi
echo "  curl -s 127.0.0.1:3001/api/version"
echo "  bash $UPDATER/post-deploy-smoke.sh"

if [ "$EXECUTE" != "1" ]; then
  echo "DRY-RUN: no traffic cut (set CUTBACK_EXECUTE=1 to execute)"
  exit 0
fi

echo "EXECUTE: cutting traffic to $IMAGE_REPO:$TAG"
if [ -n "$SCRIPT" ]; then
  sh "$SCRIPT" || { echo "FAIL: rollback script exited $?"; exit 5; }
else
  ACTOR=cutback sh "$UPDATER/request.sh" rollback || { echo "FAIL: request.sh rollback exited $?"; exit 5; }
fi
curl -s 127.0.0.1:3001/api/version || true
bash "$UPDATER/post-deploy-smoke.sh" || { echo "WARN: post-deploy-smoke failed after cut"; exit 5; }
echo "CUTBACK_DONE $IMAGE_REPO:$TAG"
exit 0
