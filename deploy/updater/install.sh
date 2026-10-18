#!/bin/bash
# Host setup for the ChisaBot updater (docs/online-update.md). Run as root on the Docker host.
# Normally called by deploy/install-updater.sh (which deploy/start.sh runs, and which writes config.env for this
# deployment first); running it directly still works:
#
#   bash install.sh                 # install / upgrade: the first 「一键更新」 without a base is a full build
#   bash install.sh <base-commit>   # an existing flattened base matches <base-commit>: code-only updates on it
#   bash install.sh --scripts-only  # self-upgrade after a successful update (update.sh runs it from the new
#                                   # commit): replace scripts only, no restart; the daemon re-execs itself when idle
#
#  - /opt/chisabot-updater/{config.env, scripts, mirror.git, spool/{requests,state}, jobs, backups}
#  - mirror.git is filled from https://github.com/$GITHUB_REPO (public repo: no token needed).
#  - spool/requests is owned by uid 1002 (the API user in the image), mode 700; spool/state is root, read-only for it.
#  - base-deps.sha256 = deps fingerprint of the commit the code-only base matches (empty = next update is full).
#  - systemd unit chisabot-updater (enabled, started) running python3 (>= 3.6), or python2.7 when there is no
#    usable python3 (CHISABOT_PYTHON overrides). Re-running switches an old python2 unit to python3.
# Files are replaced by write-to-temp + rename, so a running update.sh keeps reading its own (old) copy.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
U=${CHISABOT_UPDATER_HOME:-/opt/chisabot-updater}
SCRIPTS_ONLY=0
BASE_COMMIT=""
case "${1:-}" in
  --scripts-only) SCRIPTS_ONLY=1 ;;
  "") ;;
  *) BASE_COMMIT=$1 ;;
esac
FILES="compose-image.sh update.sh request.sh rollback.sh health.sh post-deploy-smoke.sh smoke.sh deps-fingerprint.sh rollback.template.sh git-askpass.sh chisabot-updater.py Dockerfile.update install.sh"
pick_python() { # python3 (>= 3.6) first, then python2
  local c
  for c in python3 python2 python; do
    command -v "$c" >/dev/null 2>&1 || continue
    "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) or sys.version_info[:2] == (2, 7) else 1)' 2>/dev/null \
      && { command -v "$c"; return; }
  done
}
PY=${CHISABOT_PYTHON:-$(pick_python)}
[ -n "$PY" ] || { echo "no python3 (>= 3.6) or python2.7 on this host" >&2; exit 5; }

# Refuse to install files that do not even parse (a broken self-upgrade would strand every later update).
for f in $FILES; do
  case "$f" in
    *.sh) bash -n "$HERE/$f" || { echo "$f does not parse; not installing" >&2; exit 1; } ;;
    *.py) "$PY" -c 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")' "$HERE/$f" \
            || { echo "$f does not compile with $PY; not installing" >&2; exit 1; } ;;
  esac
done

put() { # put <src> <dest> <mode>
  local tmp
  tmp="$2.new.$$"
  cp "$1" "$tmp" && chmod "$3" "$tmp" && mv -f "$tmp" "$2"
}

mkdir -p "$U"/{jobs,backups} "$U/spool/requests" "$U/spool/state"
CHANGED=""
for f in $FILES; do
  mode=0755
  case "$f" in Dockerfile.update|rollback.template.sh) mode=0644 ;; esac
  if ! cmp -s "$HERE/$f" "$U/$f"; then
    put "$HERE/$f" "$U/$f" "$mode"
    CHANGED="$CHANGED $f"
  fi
done
[ -z "$CHANGED" ] || echo "updated:$CHANGED"

UNIT=${CHISABOT_SYSTEMD_UNIT_DIR:-/etc/systemd/system}/chisabot-updater.service
UNIT_NEW=$(sed "s#^ExecStart=.*#ExecStart=$PY $U/chisabot-updater.py#" "$HERE/chisabot-updater.service")
UNIT_CHANGED=0
if [ "$UNIT_NEW" != "$(cat "$UNIT" 2>/dev/null)" ]; then
  printf '%s\n' "$UNIT_NEW" > "$UNIT.new.$$" && chmod 0644 "$UNIT.new.$$" && mv -f "$UNIT.new.$$" "$UNIT"
  UNIT_CHANGED=1
fi

if [ "$SCRIPTS_ONLY" = 1 ]; then
  # Called from inside update.sh (which holds update.lock). No restart: the daemon notices its new file and
  # re-execs itself once the job is finished; a changed unit only needs daemon-reload.
  [ "$UNIT_CHANGED" = 0 ] || systemctl daemon-reload
  exit 0
fi

[ -f "$U/config.env" ] || install -m 0644 "$HERE/config.env" "$U/config.env"
chown 1002:1002 "$U/spool/requests" && chmod 0700 "$U/spool/requests"
chown 0:0 "$U/spool/state" && chmod 0755 "$U/spool/state"
chmod 0700 "$U/backups" "$U/jobs"
[ -d "$U/mirror.git" ] || git init --bare -q "$U/mirror.git"
# shellcheck source=/dev/null
. "$U/config.env"
if ! git --git-dir="$U/mirror.git" rev-parse -q --verify refs/heads/main >/dev/null; then
  if [ "${GITHUB_FETCH:-auto}" != off ]; then
    git --git-dir="$U/mirror.git" fetch -q --no-tags "https://github.com/${GITHUB_REPO:-ChisaAlter/ChisaBot}.git" \
      "+refs/heads/${GITHUB_BRANCH:-main}:refs/heads/main" \
      && echo "mirror.git: main = $(git --git-dir="$U/mirror.git" rev-parse --short refs/heads/main)" \
      || echo "could not fetch from GitHub; push the repository: git push root@host:$U/mirror.git main" >&2
  else
    echo "GITHUB_FETCH=off: push the repository first: git push root@host:$U/mirror.git main" >&2
  fi
fi
if [ -n "$BASE_COMMIT" ]; then
  if git --git-dir="$U/mirror.git" cat-file -e "${BASE_COMMIT}^{commit}" 2>/dev/null; then
    bash "$U/deps-fingerprint.sh" "$BASE_COMMIT" > "$U/base-deps.sha256"
    echo "base-deps.sha256 = $(cat "$U/base-deps.sha256") (from $BASE_COMMIT)"
    [ -d "${NODE_MODULES_BASE:-/nonexistent}" ] || echo "NODE_MODULES_BASE $NODE_MODULES_BASE is missing: hardlink-copy a node_modules installed from this bun.lock there (or leave it: the next update is a full build)" >&2
  else
    echo "commit $BASE_COMMIT is not in $U/mirror.git" >&2
  fi
elif [ ! -s "$U/base-deps.sha256" ]; then
  : > "$U/base-deps.sha256"
  echo "no code-only base yet: the first update from 管理后台 → 系统更新 is a full build (repository Dockerfile)"
fi
docker buildx version >/dev/null 2>&1 || echo "warning: docker buildx is missing; full builds need it (package docker-buildx-plugin)" >&2
systemctl daemon-reload
systemctl enable chisabot-updater >/dev/null 2>&1
systemctl restart chisabot-updater
systemctl --no-pager status chisabot-updater | head -n 5 || true
