#!/bin/bash
# 管理后台 → 系统更新 → 回滚到上一版（docs/online-update.md）。
# 「上一版」= 当前镜像上线前的 compose（compose.yaml.before-<当前标签>，手动发布和一键更新都会留下它）。
# 用法：rollback.sh --job <id>
set -uo pipefail
U=/opt/chisabot-updater
. "$U/config.env"
# shellcheck source=compose-image.sh
. "$U/compose-image.sh"
JOB=""
[ "${1:-}" = "--job" ] && JOB="${2:-}"
RESULT=failed
trap 'echo "::result:: $RESULT"' EXIT
step() { echo "::step:: $1"; echo "[$(date '+%H:%M:%S')] $2"; }
fail() { echo "::error:: $*"; exit 2; }
case "$JOB" in ''|*[!A-Za-z0-9_-]*) fail "任务 id 无效" ;; esac
exec 9>"$U/update.lock"
flock -n 9 || fail "已经有一个更新或回滚在进行"

step prepare "准备回滚"
CUR_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null) || fail "找不到容器 $CONTAINER"
CUR_TAG=${CUR_IMAGE##*:}
BEFORE="$COMPOSE_DIR/$COMPOSE_FILE.before-$CUR_TAG"
PREV=$(previous_image "$CUR_TAG")
[ -n "$PREV" ] || fail "没有 $CUR_TAG 上线前的记录（compose.before / .image.before），无法确定上一版"
docker image inspect "$PREV" >/dev/null 2>&1 || fail "上一版镜像 $PREV 已经不在了"
echo "::from:: $CUR_IMAGE"
echo "::to:: $PREV"
echo "$CUR_IMAGE → $PREV"

step swap "切换到 $PREV"
(
  cd "$COMPOSE_DIR" || exit 1
  exec 8>.deploy.lock
  flock -w 60 8 || exit 1
  restore_hermes_release "$CUR_TAG" || exit 1
  if [ "$(image_mode)" = env ]; then
    set_image "$PREV" || exit 1
  else
    cp -p "$COMPOSE_FILE" "$COMPOSE_FILE.rolledback-$CUR_TAG-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$BEFORE" "$COMPOSE_FILE"
    grep -q "image: $PREV\$" "$COMPOSE_FILE" || exit 1
  fi
  RECREATE=()
  if DRIFT=$(compose_network_drift); then
    echo "网络配置变了（$DRIFT）：使用 --force-recreate"
    RECREATE=(--force-recreate)
  fi
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --no-deps --pull never "${RECREATE[@]}" --wait --wait-timeout 180 "$SERVICE"
) || fail "切换失败（compose 已改回上一版，请检查容器）"

step health "健康检查"
bash "$U/health.sh" "$PREV" "" || fail "回滚后健康检查没通过"
step done "已回滚到 $PREV"
RESULT=succeeded
exit 0
