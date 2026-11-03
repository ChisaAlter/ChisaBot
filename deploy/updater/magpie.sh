#!/bin/bash
# ChisaBot 宿主机：自托管 Magpie 网关的检查与原地更新（管理后台 → 模型平台 Magpie）。
#
# 由 chisabot-updater.py 以 root 调用；手动运行只用于排查：
#   bash magpie.sh --check                     比对在跑的镜像与该标签现在的摘要，写 spool/state/magpie.json
#   bash magpie.sh --update --job <id>         拉取并重建 Magpie；健康检查不过就回退到上一版摘要
#
# 为什么必须在宿主机上做：应用容器没有 docker socket（docs/online-update.md §「为什么在宿主机」），
# 它只能往 spool 里放请求文件。页面上的「一键更新」走的也是这条路。
#
# 输出协议与 update.sh 相同（chisabot-updater.py 的 poll_job 逐行解析）：
#   ::step:: <key>  ::from:: <镜像>  ::to:: <镜像>  ::duration:: <秒>  ::result:: succeeded|failed  ::error:: <一句话>
set -u

U=${CHISABOT_UPDATER_DIR:-/opt/chisabot-updater}
# shellcheck source=/dev/null
[ -f "$U/config.env" ] && . "$U/config.env"

MAGPIE_DIR=${MAGPIE_DIR:-/opt/magpie}
MAGPIE_IMAGE=${MAGPIE_IMAGE:-ghcr.io/yetone/magpie:latest}
MAGPIE_CONTAINER=${MAGPIE_CONTAINER:-magpie}
MAGPIE_COMPOSE=${MAGPIE_COMPOSE:-$MAGPIE_DIR/compose.yaml}
# 健康探测：Magpie 的 web 控制台端口。没有 key 也回一句话，所以「有 HTTP 响应」就是活着。
MAGPIE_PROBE_URL=${MAGPIE_PROBE_URL:-http://127.0.0.1:3430/}
MAGPIE_HEALTH_TIMEOUT_SEC=${MAGPIE_HEALTH_TIMEOUT_SEC:-60}
# 拉取镜像的上限与心跳间隔。registry 不通时 docker 自己的重试能拖很久——没有上限的话
# 任务就无声地停在「拉取镜像」，页面上读作卡死；到点判失败比挂着更诚实。
MAGPIE_PULL_TIMEOUT_SEC=${MAGPIE_PULL_TIMEOUT_SEC:-900}
MAGPIE_PULL_HEARTBEAT_SEC=${MAGPIE_PULL_HEARTBEAT_SEC:-15}
# 重建容器的上限：up -d 平时几秒，给个宽裕的兜底。
MAGPIE_UP_TIMEOUT_SEC=${MAGPIE_UP_TIMEOUT_SEC:-120}

STATE="$U/spool/state/magpie.json"
JOB=""
MODE=""
STARTED=$(date +%s)

log() { echo "[$(date '+%H:%M:%S')] $*"; }
step() { echo "::step:: $1"; log "$2"; }
fail() { echo "::error:: $*"; echo "::result:: failed"; exit 2; }

# 本机现在这个标签指向的摘要（没拉过就是空）。
local_digest() {
  docker image inspect "$MAGPIE_IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null | sed 's/.*@//'
}

# 仓库里这个标签现在指向的摘要。buildx 是更新器的硬依赖（config.env 会检查），所以优先用它；
# 拿不到就退回 docker manifest inspect（多架构清单本身不带自己的摘要，只作为兜底判空）。
remote_digest() {
  docker buildx imagetools inspect "$MAGPIE_IMAGE" --format '{{.Manifest.Digest}}' 2>/dev/null && return 0
  docker manifest inspect "$MAGPIE_IMAGE" >/dev/null 2>&1 && echo "" && return 0
  return 1
}

installed() { docker inspect "$MAGPIE_CONTAINER" >/dev/null 2>&1; }

running_digest() {
  docker inspect "$MAGPIE_CONTAINER" --format '{{.Image}}' 2>/dev/null
}

# 状态文件是给应用容器只读读的（spool/state 挂载）。用 python3 写，避免手工拼 JSON 出错。
write_state() {
  local current="$1" latest="$2" available="$3" err="$4"
  mkdir -p "$(dirname "$STATE")"
  CURRENT="$current" LATEST="$latest" AVAILABLE="$available" ERR="$err" \
    IMAGE="$MAGPIE_IMAGE" CONTAINER="$MAGPIE_CONTAINER" INSTALLED="$5" \
    python3 - "$STATE" <<'PY'
import json, os, sys, tempfile
path = sys.argv[1]
body = {
    "installed": os.environ["INSTALLED"] == "1",
    "image": os.environ["IMAGE"],
    "container": os.environ["CONTAINER"],
    "currentDigest": os.environ["CURRENT"] or None,
    "latestDigest": os.environ["LATEST"] or None,
    "updateAvailable": os.environ["AVAILABLE"] == "1",
    "checkedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
error = os.environ["ERR"]
if error:
    body["error"] = error[:300]
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".magpie-", suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(body, f, ensure_ascii=False)
    f.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

# ---------- --check：只看，不动任何东西 ----------
do_check() {
  local current latest available=0 err=""
  installed || true
  current=$(local_digest)
  if ! latest=$(remote_digest); then
    err="无法查询 $MAGPIE_IMAGE 的远端摘要（网络或 registry 不可达）"
    latest=""
  fi
  if [ -n "$current" ] && [ -n "$latest" ] && [ "$current" != "$latest" ]; then
    available=1
  fi
  if installed; then inst=1; else inst=0; fi
  write_state "$current" "$latest" "$available" "$err" "$inst"
  log "current=${current:-未知} latest=${latest:-未知} 有新版=$available"
  return 0
}

# ---------- --update：拉取 + 重建 + 健康检查（失败回退）----------
do_update() {
  [ -f "$MAGPIE_COMPOSE" ] || fail "找不到 Magpie 的 compose 文件 $MAGPIE_COMPOSE（设 MAGPIE_DIR 或 MAGPIE_COMPOSE）"

  step prepare "准备：$MAGPIE_IMAGE"
  local before latest
  before=$(local_digest)
  echo "::from:: ${before:-$MAGPIE_IMAGE}"

  step pull "拉取镜像（先拉后换：拉不动就不动正在跑的容器）"
  # 拉几百 MB 是几分钟的事，输出又都在 docker 那边：放后台跑，这边每隔
  # MAGPIE_PULL_HEARTBEAT_SEC 往任务日志里报一次「已用 N 秒」，页面上的日志尾巴就一直在动；
  # 超过 MAGPIE_PULL_TIMEOUT_SEC 判失败。docker 输出留到 pull_log，结束把末尾几行并进
  # 任务日志——失败时里面就是 registry 的原文，不用上服务器翻。
  local pull_log pull_rc waited=0
  pull_log=$(mktemp)
  docker compose -f "$MAGPIE_COMPOSE" pull magpie >"$pull_log" 2>&1 &
  local pull_pid=$!
  while kill -0 "$pull_pid" 2>/dev/null; do
    sleep 5
    waited=$((waited + 5))
    if [ "$waited" -ge "$MAGPIE_PULL_TIMEOUT_SEC" ]; then
      kill "$pull_pid" 2>/dev/null || true
      wait "$pull_pid" 2>/dev/null || true
      tail -n 5 "$pull_log" | sed 's/^/  /'
      rm -f "$pull_log"
      fail "拉取 $MAGPIE_IMAGE 超过 ${MAGPIE_PULL_TIMEOUT_SEC} 秒（网络或 registry 不可达）；正在跑的 Magpie 没有动"
    fi
    if [ "$waited" -ge "$MAGPIE_PULL_HEARTBEAT_SEC" ] && [ $((waited % MAGPIE_PULL_HEARTBEAT_SEC)) -eq 0 ]; then
      log "拉取中…已用 $((waited / 60)) 分 $((waited % 60)) 秒"
    fi
  done
  wait "$pull_pid"
  pull_rc=$?
  sed 's/^/  /' "$pull_log" | tail -n 6
  rm -f "$pull_log"
  if [ "$pull_rc" -ne 0 ]; then
    fail "拉取 $MAGPIE_IMAGE 失败（网络或 registry 不可达）；正在跑的 Magpie 没有动"
  fi
  latest=$(local_digest)
  echo "::to:: ${latest:-$MAGPIE_IMAGE}"

  if [ -n "$before" ] && [ -n "$latest" ] && [ "$before" = "$latest" ] && installed; then
    log "已经是最新：$latest"
    write_state "$latest" "$latest" 0 "" 1
    echo "::duration:: $(( $(date +%s) - STARTED ))"
    echo "::result:: succeeded"
    return 0
  fi

  step swap "重建 Magpie 容器"
  if ! timeout "$MAGPIE_UP_TIMEOUT_SEC" docker compose -f "$MAGPIE_COMPOSE" up -d magpie >/dev/null 2>&1; then
    fail "重建 Magpie 失败或超过 ${MAGPIE_UP_TIMEOUT_SEC} 秒；旧容器可能仍在运行，请手动检查 docker compose -f $MAGPIE_COMPOSE ps"
  fi

  step health "健康检查"
  if ! wait_healthy; then
    log "新镜像没通过健康检查，回退到 ${before:-上一个镜像}"
    if [ -n "$before" ]; then
      # 把旧镜像打回这个标签，再重建。这样不管 compose 里写的是 ${MAGPIE_IMAGE} 还是一个
      # 字面标签，回退都真的会把旧镜像换回来 —— 只靠环境变量插值时，字面标签的 compose
      # 会静默不生效，看起来回退了其实还在跑新镜像，那比不回退更糟。
      docker tag "$before" "$MAGPIE_IMAGE" >/dev/null 2>&1 || true
      timeout "$MAGPIE_UP_TIMEOUT_SEC" docker compose -f "$MAGPIE_COMPOSE" up -d magpie >/dev/null 2>&1 || true
      if wait_healthy; then
        fail "新版本健康检查失败，已回退到 $before"
      fi
    fi
    fail "新版本健康检查失败，且回退没有成功——请手动检查 docker compose -f $MAGPIE_COMPOSE logs magpie"
  fi

  step done "完成"
  write_state "$latest" "$latest" 0 "" 1
  echo "::duration:: $(( $(date +%s) - STARTED ))"
  echo "::result:: succeeded"
}

wait_healthy() {
  local waited=0 code
  while [ "$waited" -lt "$MAGPIE_HEALTH_TIMEOUT_SEC" ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$MAGPIE_PROBE_URL" 2>/dev/null || echo 000)
    case "$code" in
      2*|3*|4*) return 0 ;;
    esac
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

case "$1" in
  --check) do_check ;;
  --update)
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --job) JOB=${2:-}; shift ;;
        --dry-run) MODE=dry ;;
        *) echo "unknown argument: $1" >&2; exit 64 ;;
      esac
      shift
    done
    if [ "${MODE:-}" = "dry" ]; then do_check; exit $?; fi
    do_update
    ;;
  *)
    echo "用法：magpie.sh --check | magpie.sh --update [--job <id>]" >&2
    exit 64
    ;;
esac
