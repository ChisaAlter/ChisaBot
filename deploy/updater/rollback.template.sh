#!/bin/sh
# Roll back @NEW@ to @PREV@ (written by chisabot-updater, job @JOB@; docs/online-update.md).
# Only the image changes; the database is not reverted. The pre-update dump is in /opt/chisabot-updater/backups/.
set -eu
cd @COMPOSE_DIR@
exec 9>.deploy.lock
flock -w 60 9
# Refuse a pre-DSH reader before changing compose or private environment. Live data is kept.
bash -c 'U="$1"; . "$U/config.env"; . "$U/dsh-release.sh"; CONTAINER="$2"; COMPOSE_DIR="$PWD"; dsh_require_compatible_image "$3" || exit 1; enabled=$(dsh_enabled) || exit 1; [ "$enabled" != 1 ] || dsh_accounts_check' -- @UPDATER_HOME@ @CONTAINER@ @PREV@
# The updater's automatic rollback already holds admission with this job. A manually invoked
# rollback must acquire its own fence, and release only that fence after health succeeds/fails.
HELD=$(bash -c '
  . "$1/dsh-release.sh"; CONTAINER="$2"; COMPOSE_DIR="$PWD"
  enabled=$(dsh_enabled) || exit 1
  [ "$enabled" = 1 ] || { echo 0; exit 0; }
  existing=$(dsh_exec /bin/sh -c '\''cat "${CHISABOT_DSH_ROOT:?}/.maintenance" 2>/dev/null'\'') || existing=""
  [ "$existing" = "$3" ] && { echo 0; exit 0; }
  dsh_hold_admission "$3" || exit 1
  if dsh_wait_idle; then echo 1
  else dsh_release_admission "$3"; exit 1; fi
' -- @UPDATER_HOME@ @CONTAINER@ @JOB@)
RELEASE_ALLOWED=1
release_admission() {
  [ "$HELD" = 0 ] && return 0
  [ "$RELEASE_ALLOWED" = 1 ] || { echo 'Rollback incomplete; admission remains paused.' >&2; return 1; }
  bash -c '. "$1/dsh-release.sh"; CONTAINER="$2"; dsh_release_admission "$3"' -- @UPDATER_HOME@ @CONTAINER@ @JOB@
}
trap release_admission EXIT
if [ -f .image.before-@NEW_TAG@ ]; then
  # deploy/start.sh deployment: the image lives in .env (CHISABOT_IMAGE), compose.yaml is the repository's.
  if grep -q '^CHISABOT_IMAGE=' .env; then
    sed -i "s#^CHISABOT_IMAGE=.*#CHISABOT_IMAGE=@PREV@#" .env
  else
    printf 'CHISABOT_IMAGE=%s\n' @PREV@ >> .env
  fi
  grep -q "^CHISABOT_IMAGE=@PREV@\$" .env
else
  if [ -f @COMPOSE_FILE@.before-@NEW_TAG@ ]; then
    cp -p @COMPOSE_FILE@.before-@NEW_TAG@ @COMPOSE_FILE@
  else
    sed -i "s#image: @NEW@#image: @PREV@#" @COMPOSE_FILE@
  fi
  grep -q "image: @PREV@" @COMPOSE_FILE@
fi
RELEASE_ALLOWED=0
docker compose -p @PROJECT@ -f @COMPOSE_FILE@ up -d --no-deps --pull never --wait --wait-timeout 180 @SERVICE@
bash -c 'U="$1"; . "$U/config.env"; . "$U/dsh-release.sh"; CONTAINER="$2"; COMPOSE_DIR="$PWD"; enabled=$(dsh_enabled) || exit 1; [ "$enabled" != 1 ] || dsh_accounts_replace "$3"' -- @UPDATER_HOME@ @CONTAINER@ @PREV@
docker inspect -f '{{.State.Health.Status}} restarts={{.RestartCount}} image={{.Config.Image}}' @CONTAINER@
curl -fsS -o /dev/null -w 'local /health %{http_code}\n' @LOCAL_URL@/health
bash -c '. "$1/dsh-release.sh"; CONTAINER="$2"; dsh_readiness' -- @UPDATER_HOME@ @CONTAINER@
RELEASE_ALLOWED=1
PUBLIC='@PUBLIC_HEALTH_URL@'
[ -z "$PUBLIC" ] || curl -ksS -o /dev/null -w "$PUBLIC %{http_code}\n" "$PUBLIC" || true
echo ROLLBACK_DONE
