#!/bin/bash
# ChisaBot 宿主机：自托管 Magpie 网关的检查与原地更新（管理后台 → 模型平台 Magpie）。
#
# 由 chisabot-updater.py 以 root 调用；手动运行只用于排查：
#   bash magpie.sh --check                     比对在跑的镜像与该标签现在的摘要，写 spool/state/magpie.json
#   bash magpie.sh --update --job <id>         拉取并重建 Magpie；健康检查不过就回退到上一版摘要。
#                                              宿主机上还没有 Magpie 时，这一步就是「一键安装」（do_install）。
#
# 一键安装（管理后台 → 模型平台 Magpie →「一键安装」，docs/magpie.md §一键安装）：
#   - 只装官方镜像 ghcr.io/yetone/magpie（MAGPIE_INSTALL_ALLOW_CUSTOM=1 才允许别的仓库）；
#   - 先问镜像仓库这个标签的摘要，拉下来的必须是同一个摘要；
#   - 宿主机有 gh 或 cosign 时校验官方 CI 的构建来源证明（GitHub attestation），没通过就不启动；
#     MAGPIE_VERIFY=required 时没有校验工具也不装，=off 时跳过；
#   - compose 用更新程序目录里随版本发的模板（deploy/magpie.compose.yaml），端口只绑本机；
#   - Web key 在宿主机生成，只写进 root 600 的 private/magpie.env，和交给应用容器 API 用户（uid 1002）
#     只读的 spool/state/magpie-web.key —— 应用不用重启就能接上（server/src/magpie.ts createAutoMagpieService）。
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
# 一键安装用的模板（install.sh 从 deploy/magpie.compose.yaml 拷进更新程序目录）。
MAGPIE_TEMPLATE=${MAGPIE_TEMPLATE:-$U/magpie.compose.yaml}
# 一键安装只认的官方仓库，以及签名校验要求的来源仓库（GitHub attestation 的 --repo）。
MAGPIE_OFFICIAL_REPO=ghcr.io/yetone/magpie
MAGPIE_SOURCE_REPO=yetone/magpie
MAGPIE_INSTALL_ALLOW_CUSTOM=${MAGPIE_INSTALL_ALLOW_CUSTOM:-0}
# 签名校验：auto（有 gh / cosign 就校验，没通过不装）| required（没有校验工具也不装）| off。
MAGPIE_VERIFY=${MAGPIE_VERIFY:-auto}
MAGPIE_VERIFY_TIMEOUT_SEC=${MAGPIE_VERIFY_TIMEOUT_SEC:-180}
# Magpie 和 ChisaBot 共用的 Docker 网络（deploy/compose.yaml 的 magpie 网，start.sh 建）。
MAGPIE_NETWORK=${MAGPIE_NETWORK:-chisabot_magpie}
# 镜像里 Magpie 以 nonroot（65532）运行，/config 要它可写；Web key 文件交给应用容器的 API 用户（1002）。
MAGPIE_DATA_UID=${MAGPIE_DATA_UID:-65532}
MAGPIE_APP_UID=${MAGPIE_APP_UID:-1002}
# 「这套 Magpie 是 ChisaBot 装的」的标记：有它才把 Web key 交给应用，也据此认出一次没装完的安装。
MAGPIE_MARKER=$MAGPIE_DIR/.chisabot-managed
MAGPIE_ENV_FILE=$MAGPIE_DIR/private/magpie.env

STATE="$U/spool/state/magpie.json"
KEY_OUT="$U/spool/state/magpie-web.key"
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
# 兜底时输出为空：--check 据此说「不知道」；一键安装不接受空摘要（见 install_want_digest）。
remote_digest() {
  docker buildx imagetools inspect "$MAGPIE_IMAGE" --format '{{.Manifest.Digest}}' 2>/dev/null && return 0
  docker manifest inspect "$MAGPIE_IMAGE" >/dev/null 2>&1 && echo "" && return 0
  return 1
}

# 一键安装要核对的摘要：引用本身钉了 @sha256 就用它；否则必须从仓库拿到，拿不到（只有空的兜底）就失败，
# 不能在没核对摘要的情况下启动（fail closed）。
install_want_digest() {
  local pinned want
  case "$MAGPIE_IMAGE" in
    *@sha256:*)
      pinned="sha256:${MAGPIE_IMAGE##*@sha256:}"
      printf '%s' "$pinned" | grep -Eq '^sha256:[0-9a-f]{64}$' && { printf '%s' "$pinned"; return 0; }
      return 1 ;;
  esac
  want=$(docker buildx imagetools inspect "$MAGPIE_IMAGE" --format '{{.Manifest.Digest}}' 2>/dev/null | tr -d '[:space:]')
  printf '%s' "$want" | grep -Eq '^sha256:[0-9a-f]{64}$' || return 1
  printf '%s' "$want"
}

# iptables 常在 /usr/sbin、/sbin：systemd 或精简环境的 PATH 里可能没有。找到就输出完整路径。
find_iptables() {
  local p d
  p=$(command -v iptables 2>/dev/null) && [ -n "$p" ] && { printf '%s' "$p"; return 0; }
  for d in ${MAGPIE_IPTABLES_DIRS:-/usr/sbin /sbin /usr/local/sbin /usr/bin /bin}; do
    [ -x "$d/iptables" ] && { printf '%s' "$d/iptables"; return 0; }
  done
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
  local installable=0 managed=0 verification=""
  # 这一版 magpie.sh 会装：页面据此才给「一键安装」按钮（旧更新程序没有这个字段 → 提示先系统更新）。
  [ -f "$MAGPIE_TEMPLATE" ] && installable=1
  local isolation=""
  if [ -f "$MAGPIE_MARKER" ]; then
    managed=1
    verification=$(sed -n 's/^verification=//p' "$MAGPIE_MARKER" 2>/dev/null | tail -n 1)
    isolation=$(sed -n 's/^isolation=//p' "$MAGPIE_MARKER" 2>/dev/null | tail -n 1)
  fi
  CURRENT="$current" LATEST="$latest" AVAILABLE="$available" ERR="$err" \
    IMAGE="$MAGPIE_IMAGE" CONTAINER="$MAGPIE_CONTAINER" INSTALLED="$5" \
    INSTALLABLE="$installable" MANAGED="$managed" VERIFICATION="$verification" ISOLATION="$isolation" \
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
if os.environ.get("INSTALLABLE") == "1":
    body["installable"] = True
if os.environ.get("MANAGED") == "1":
    body["managed"] = True
if os.environ.get("VERIFICATION") in ("attested", "digest", "off"):
    body["verification"] = os.environ["VERIFICATION"]
if os.environ.get("ISOLATION") in ("applied", "failed", "no-iptables", "skipped"):
    body["isolation"] = os.environ["ISOLATION"]
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

# ---------- 拉取（安装和更新共用）----------
# 拉几百 MB 是几分钟的事，输出又都在 docker 那边：放后台跑，这边每隔
# MAGPIE_PULL_HEARTBEAT_SEC 往任务日志里报一次「已用 N 秒」，页面上的日志尾巴就一直在动；
# 超过 MAGPIE_PULL_TIMEOUT_SEC 判失败。docker 输出留到 pull_log，结束把末尾几行并进
# 任务日志——失败时里面就是 registry 的原文，不用上服务器翻。$1 = 失败原因后面接的半句话。
pull_image() {
  local suffix="${1:-}" pull_log pull_rc waited=0
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
      fail "拉取 $MAGPIE_IMAGE 超过 ${MAGPIE_PULL_TIMEOUT_SEC} 秒（网络或 registry 不可达）$suffix"
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
    fail "拉取 $MAGPIE_IMAGE 失败（网络或 registry 不可达）$suffix"
  fi
}

# ---------- 一键安装 ----------
# 镜像引用去掉 :tag / @digest 之后的仓库名（ghcr.io/yetone/magpie:latest → ghcr.io/yetone/magpie）。
image_repo() {
  local ref="${1%%@*}" last
  last="${ref##*/}"
  case "$last" in *:*) ref="${ref%:*}" ;; esac
  printf '%s' "$ref"
}

# 32 字节随机数 → 43 位 base64url（Magpie 要 16+ 位 A-Za-z0-9-._~）。
gen_key() {
  head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
}

# root 下 chown 失败是真错（权限不对 Magpie 起不来、应用读不到 key）；非 root（自测）只能跳过。
own() {
  chown "$1" "$2" 2>/dev/null && return 0
  [ "$(id -u)" != 0 ]
}

valid_key() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._~-]{16,256}$'
}

env_key() {
  sed -n 's/^MAGPIE_WEB_KEY=//p' "$MAGPIE_ENV_FILE" 2>/dev/null | tail -n 1 | tr -d '\r"'"'"
}

# 建安装目录：只补缺的，已有的一律不覆盖（重试、或者部署者自己改过 compose 都不受影响）。
prepare_files() {
  mkdir -p "$MAGPIE_DIR" "$MAGPIE_DIR/private" "$MAGPIE_DIR/magpie-data" || return 1
  chmod 755 "$MAGPIE_DIR" && chmod 700 "$MAGPIE_DIR/private" || return 1
  if [ ! -f "$MAGPIE_COMPOSE" ]; then
    cp "$MAGPIE_TEMPLATE" "$MAGPIE_COMPOSE.new.$$" && chmod 644 "$MAGPIE_COMPOSE.new.$$" \
      && mv -f "$MAGPIE_COMPOSE.new.$$" "$MAGPIE_COMPOSE" || return 1
    log "已写入 $MAGPIE_COMPOSE（来自随版本发布的模板）"
  fi
  if ! valid_key "$(env_key)"; then
    local key
    key=$(gen_key)
    valid_key "$key" || return 1
    ( umask 077; { [ -f "$MAGPIE_ENV_FILE" ] && grep -v '^MAGPIE_WEB_KEY=' "$MAGPIE_ENV_FILE"; printf 'MAGPIE_WEB_KEY=%s\n' "$key"; } \
      > "$MAGPIE_ENV_FILE.new.$$" ) && chmod 600 "$MAGPIE_ENV_FILE.new.$$" && mv -f "$MAGPIE_ENV_FILE.new.$$" "$MAGPIE_ENV_FILE" \
      || return 1
    log "已生成 Magpie 管理密钥（只保存在 $MAGPIE_ENV_FILE，root 可读）"
  fi
  own "$MAGPIE_DATA_UID:$MAGPIE_DATA_UID" "$MAGPIE_DIR/magpie-data" || return 1
  [ -f "$MAGPIE_MARKER" ] || printf 'installedBy=chisabot\nstartedAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MAGPIE_MARKER" || return 1
}

set_marker() { # set_marker key value
  local tmp="$MAGPIE_MARKER.new.$$"
  { grep -v "^$1=" "$MAGPIE_MARKER" 2>/dev/null; printf '%s=%s\n' "$1" "$2"; } > "$tmp" && mv -f "$tmp" "$MAGPIE_MARKER"
}

# 校验官方 CI 给这个摘要签的构建来源证明（actions/attest-build-provenance，推在镜像仓库里）。
# 结果写 VERIFIED：attested（签名校验通过）| digest（没有校验工具，只核对了官方仓库和摘要）| off。
VERIFIED=""
verify_image() {
  local digest="$1" repo out rc
  repo=$(image_repo "$MAGPIE_IMAGE")
  if [ "$MAGPIE_VERIFY" = off ]; then
    log "已按配置跳过签名校验（MAGPIE_VERIFY=off）"
    VERIFIED=off
    return 0
  fi
  if [ "$repo" != "$MAGPIE_OFFICIAL_REPO" ]; then
    log "自定义镜像 $repo 不做官方签名校验（MAGPIE_INSTALL_ALLOW_CUSTOM=1）"
    VERIFIED=off
    return 0
  fi
  [ -n "$digest" ] || fail "拿不到拉下来的镜像摘要，无法校验来源；没有启动 Magpie"
  if command -v gh >/dev/null 2>&1; then
    out=$(GH_PROMPT_DISABLED=1 timeout "$MAGPIE_VERIFY_TIMEOUT_SEC" gh attestation verify "oci://$repo@$digest" \
      --repo "$MAGPIE_SOURCE_REPO" --bundle-from-oci 2>&1)
    rc=$?
    if [ "$rc" -eq 0 ]; then
      log "签名校验通过：这份镜像由 github.com/$MAGPIE_SOURCE_REPO 的官方 CI 构建（GitHub attestation）"
      VERIFIED=attested
      return 0
    fi
    case "$out" in
      *"gh auth login"*|*"authentication"*|*"GH_TOKEN"*)
        log "gh 没有登录，改用其他方式校验" ;;
      *)
        printf '%s\n' "$out" | tail -n 3 | sed 's/^/  /'
        fail "镜像签名校验没有通过（不是 github.com/$MAGPIE_SOURCE_REPO 官方 CI 构建的，或者校验服务连不上）；没有启动 Magpie" ;;
    esac
  fi
  if command -v cosign >/dev/null 2>&1; then
    out=$(timeout "$MAGPIE_VERIFY_TIMEOUT_SEC" cosign verify-attestation --new-bundle-format \
      --type https://slsa.dev/provenance/v1 \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      --certificate-identity-regexp "^https://github\\.com/$MAGPIE_SOURCE_REPO/\\.github/workflows/" \
      "$repo@$digest" 2>&1 >/dev/null)
    rc=$?
    if [ "$rc" -eq 0 ]; then
      log "签名校验通过：这份镜像由 github.com/$MAGPIE_SOURCE_REPO 的官方 CI 构建（cosign）"
      VERIFIED=attested
      return 0
    fi
    printf '%s\n' "$out" | tail -n 3 | sed 's/^/  /'
    fail "镜像签名校验没有通过（不是 github.com/$MAGPIE_SOURCE_REPO 官方 CI 构建的，或者校验服务连不上）；没有启动 Magpie"
  fi
  if [ "$MAGPIE_VERIFY" = required ]; then
    fail "宿主机没有 gh 或 cosign，做不了签名校验（MAGPIE_VERIFY=required）；装上其中一个再重试"
  fi
  log "宿主机没有 gh 或 cosign，跳过签名校验；已核对来源是官方仓库 $MAGPIE_OFFICIAL_REPO，摘要与镜像仓库公布的一致"
  VERIFIED=digest
}

# 把 Web key 交给应用容器（spool/state 只读挂载进去，文件只给 API 用户读），再补上隔离规则。
# 应用每隔几秒看一眼这个文件，看到就接上，不用重启（server/src/magpie.ts createAutoMagpieService）。
handoff() {
  local key tmp
  key=$(env_key)
  valid_key "$key" || return 1
  mkdir -p "$(dirname "$KEY_OUT")" || return 1
  tmp="$KEY_OUT.new.$$"
  ( umask 077; printf '%s\n' "$key" > "$tmp" ) && chmod 400 "$tmp" && own "$MAGPIE_APP_UID:$MAGPIE_APP_UID" "$tmp" \
    && mv -f "$tmp" "$KEY_OUT" || { rm -f "$tmp"; return 1; }
  # PRD-P0-02：Magpie 不能主动连应用的 3001。规则按对端 IP 下，新容器要补一次（start.sh 也是这么做的）。
  # 没补上一律写警告并记进标记（magpie.json 的 isolation），页面据此提示；不再静默跳过。
  local iso="$U/isolate-sidecar-app.sh" ipt isolation
  if [ ! -f "$iso" ]; then
    isolation=skipped
    log "警告：更新程序目录里没有 isolate-sidecar-app.sh，隔离规则没有补上（见 docs/ops/trust-boundary.md §5.1），Magpie 本身已经可用"
  elif [ "$(id -u)" != 0 ]; then
    isolation=skipped
    log "警告：不是以 root 运行，隔离规则没有补上（见 docs/ops/trust-boundary.md §5.1），Magpie 本身已经可用"
  elif ! ipt=$(find_iptables); then
    isolation=no-iptables
    log "警告：宿主机上找不到 iptables（PATH、/usr/sbin、/sbin 都没有），隔离规则没有补上：Magpie 现在能主动连 ChisaBot。装上 iptables 后运行 sh $iso --apply（见 docs/ops/trust-boundary.md §5.1）"
  elif PATH="$(dirname "$ipt"):$PATH" CHISABOT_APP_CONTAINER="${CONTAINER:-chisabot-zh}" sh "$iso" --apply >/dev/null 2>&1; then
    isolation=applied
    log "已补上隔离规则：Magpie 不能主动连 ChisaBot"
  else
    isolation=failed
    log "警告：隔离规则没有补上（见 docs/ops/trust-boundary.md §5.1），Magpie 本身已经可用"
  fi
  [ -f "$MAGPIE_MARKER" ] && set_marker isolation "$isolation"
  return 0
}

do_install() {
  step prepare "准备安装：$MAGPIE_IMAGE"
  echo "::from:: 未安装"
  local repo want got
  repo=$(image_repo "$MAGPIE_IMAGE")
  if [ "$repo" != "$MAGPIE_OFFICIAL_REPO" ] && [ "$MAGPIE_INSTALL_ALLOW_CUSTOM" != 1 ]; then
    fail "MAGPIE_IMAGE 指向 $repo，不是官方镜像 $MAGPIE_OFFICIAL_REPO；一键安装只装官方镜像（确实要用别的，设 MAGPIE_INSTALL_ALLOW_CUSTOM=1）"
  fi
  command -v docker >/dev/null 2>&1 || fail "宿主机上没有 docker"
  [ -f "$MAGPIE_TEMPLATE" ] || fail "更新程序目录里没有 Magpie 的安装模板（$MAGPIE_TEMPLATE）；先在「系统更新」里更新一次"
  prepare_files || fail "写不了安装目录 $MAGPIE_DIR（磁盘满了或者权限不对）"
  docker network inspect "$MAGPIE_NETWORK" >/dev/null 2>&1 || docker network create "$MAGPIE_NETWORK" >/dev/null 2>&1 \
    || fail "建不了 Docker 网络 $MAGPIE_NETWORK"

  step pull "拉取官方镜像"
  # 先问镜像仓库这个标签现在的摘要，拉下来的必须就是它：中途被换掉的镜像不启动。
  # 拿不到摘要就不装（fail closed）：不能在没核对摘要的情况下启动。
  want=$(install_want_digest) \
    || fail "查不到镜像仓库公布的 $MAGPIE_IMAGE 摘要（docker buildx imagetools inspect 没有返回摘要：buildx 缺失、网络或镜像仓库不可达），无法核对拉下来的镜像；还没有启动任何东西，检查后可以重试"
  pull_image "；还没有启动任何东西，可以重试"
  got=$(local_digest)
  [ -n "$got" ] || fail "拿不到拉下来的镜像摘要，无法和镜像仓库公布的核对；没有启动 Magpie，可以重试"
  if [ "$want" != "$got" ]; then
    fail "拉下来的镜像摘要（${got#sha256:}）和镜像仓库公布的（${want#sha256:}）不一致；没有启动 Magpie，可以重试"
  fi
  echo "::to:: ${repo}@${got}"

  step verify "校验镜像来源"
  verify_image "$got"
  set_marker verification "$VERIFIED"
  set_marker digest "$got"

  step swap "启动 Magpie"
  if ! timeout "$MAGPIE_UP_TIMEOUT_SEC" docker compose -f "$MAGPIE_COMPOSE" up -d magpie >/dev/null 2>&1; then
    timeout 60 docker compose -f "$MAGPIE_COMPOSE" down >/dev/null 2>&1 || true
    fail "启动 Magpie 失败或超过 ${MAGPIE_UP_TIMEOUT_SEC} 秒；已清掉没起来的容器，可以重试"
  fi

  step health "健康检查"
  if ! wait_healthy; then
    docker logs --tail 5 "$MAGPIE_CONTAINER" 2>&1 | sed 's/^/  /'
    timeout 60 docker compose -f "$MAGPIE_COMPOSE" down >/dev/null 2>&1 || true
    fail "Magpie 启动后 ${MAGPIE_HEALTH_TIMEOUT_SEC} 秒内没有响应，已停掉这个容器；安装目录保留，可以直接重试"
  fi

  step connect "接入 ChisaBot"
  handoff || fail "Magpie 已经在运行，但没能把管理密钥交给 ChisaBot（写不了 $KEY_OUT）；修好权限后点重试即可"
  set_marker installedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  step done "完成"
  write_state "$got" "$want" 0 "" 1
  echo "::duration:: $(( $(date +%s) - STARTED ))"
  echo "::result:: succeeded"
}

# ---------- --update：拉取 + 重建 + 健康检查（失败回退）----------
do_update() {
  # 宿主机上还没有 Magpie（没有 compose、也没有容器）→ 一键安装；ChisaBot 装过但上次没装完
  # （有标记、没容器）→ 接着装。别人自己装的 Magpie（有容器、没有 compose）照旧报错，不去动它。
  if [ ! -f "$MAGPIE_COMPOSE" ]; then
    installed && fail "找不到 Magpie 的 compose 文件 $MAGPIE_COMPOSE（设 MAGPIE_DIR 或 MAGPIE_COMPOSE）"
    do_install
    return
  fi
  if [ -f "$MAGPIE_MARKER" ] && ! installed; then
    do_install
    return
  fi

  step prepare "准备：$MAGPIE_IMAGE"
  local before latest
  before=$(local_digest)
  echo "::from:: ${before:-$MAGPIE_IMAGE}"

  step pull "拉取镜像（先拉后换：拉不动就不动正在跑的容器）"
  # 拉几百 MB 是几分钟的事，输出又都在 docker 那边：放后台跑，这边每隔
  # MAGPIE_PULL_HEARTBEAT_SEC 往任务日志里报一次「已用 N 秒」，页面上的日志尾巴就一直在动；
  # 超过 MAGPIE_PULL_TIMEOUT_SEC 判失败。docker 输出留到 pull_log，结束把末尾几行并进
  # 任务日志——失败时里面就是 registry 的原文，不用上服务器翻。
  pull_image "；正在跑的 Magpie 没有动"
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

  # ChisaBot 装的这套：顺手把管理密钥文件补齐（被误删、或者从旧版升级上来时还没有）。
  if [ -f "$MAGPIE_MARKER" ] && ! handoff; then
    log "警告：没能把管理密钥交给 ChisaBot（$KEY_OUT），Magpie 本身已更新"
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
