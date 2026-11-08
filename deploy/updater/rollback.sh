#!/bin/bash
# 管理后台 → 系统更新 → 回滚到上一版（docs/online-update.md）。
# 「上一版」= 当前镜像上线前的 compose（compose.yaml.before-<当前标签>，手动发布和一键更新都会留下它）。
# 用法：rollback.sh --job <id>
set -uo pipefail
U=/opt/chisabot-updater
. "$U/config.env"
# shellcheck source=compose-image.sh
. "$U/compose-image.sh"
. "$U/dsh-release.sh"
JOB=""
[ "${1:-}" = "--job" ] && JOB="${2:-}"
RESULT=failed
DSH_ADMISSION_HELD=0
DSH_RELEASE_ALLOWED=1
finish() {
  if [ "$DSH_ADMISSION_HELD" = 1 ] && [ "$DSH_RELEASE_ALLOWED" = 1 ]; then
    dsh_release_admission "$JOB" || echo "::error:: DSH 接纳仍暂停，请检查 .maintenance 后恢复"
  elif [ "$DSH_ADMISSION_HELD" = 1 ]; then
    echo "::error:: 回滚尚未确认应用和账号容器就绪，保留 .maintenance"
  fi
  echo "::result:: $RESULT"
}
trap finish EXIT
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
dsh_require_compatible_image "$PREV" || fail "上一版不支持现有 DSH 历史，未切换"
DSH_ENABLED=$(dsh_enabled) || fail "无法读取 DSH 部署状态"
if [ "$DSH_ENABLED" = 1 ]; then
  dsh_accounts_check || fail "DSH 账号部署配置不完整，未切换"
  dsh_hold_admission "$JOB" || fail "无法暂停新的执行，未切换"
  DSH_ADMISSION_HELD=1
  dsh_wait_idle || fail "DSH 执行未结束，未切换"
fi

step swap "切换到 $PREV"
DSH_RELEASE_ALLOWED=0
(
  cd "$COMPOSE_DIR" || exit 1
  exec 8>.deploy.lock
  flock -w 60 8 || exit 1
  dsh_require_compatible_image "$PREV" || exit 1
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
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --no-deps --pull never "${RECREATE[@]}" --wait --wait-timeout 180 "$SERVICE" || exit 1
  if [ "$DSH_ENABLED" = 1 ]; then dsh_accounts_replace "$PREV" || exit 1; fi
) || fail "切换失败（compose 已改回上一版，请检查容器）"

step health "健康检查"
bash "$U/health.sh" "$PREV" "" || fail "回滚后健康检查没通过"
DSH_RELEASE_ALLOWED=1
step done "已回滚到 $PREV"
RESULT=succeeded
exit 0
