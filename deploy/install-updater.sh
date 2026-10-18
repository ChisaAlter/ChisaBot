#!/bin/sh
# 安装或升级宿主机在线更新服务 chisabot-updater（管理后台 → 系统更新；docs/online-update.md）。
#
# deploy/start.sh 每次都会调用它；老部署（没装过、或装的是旧版）在服务器上运行一次：
#
#   cd /opt/chisabot-src && git pull && sudo sh deploy/install-updater.sh
#
# 可以反复运行（幂等）：
#  - 没装过：按这份部署生成 /opt/chisabot-updater/config.env（COMPOSE_DIR = 这个 deploy/ 目录，
#    PUBLIC_HEALTH_URL 取 deploy/.env 的 CHISABOT_DOMAIN + CHISABOT_HTTPS_PORT，GITHUB_REPO 取 git 远程，
#    FULL_BUILD_MEMORY 按本机内存），然后运行 deploy/updater/install.sh（脚本、mirror.git、systemd 服务）。
#  - 装过：脚本或服务和仓库里的不一样就升级；config.env 只修一处 —— PUBLIC_HEALTH_URL 是空的或还是示例域名
#    chisabot.example.com、而 deploy/.env 里有真实域名时改成真实的。别的配置一律不动。
#  - 容器还没挂更新目录（老 compose）：COMPOSE_DIR 就是这个 deploy/ 时用当前正在运行的镜像重建一次容器
#    （不重新构建，断开十几秒），让 管理后台 → 系统更新 能看到更新程序；别的目录只打印要加的几行。
#
# 选项：
#   --check        只检查、不改任何东西：打印会做什么；需要安装 / 升级时退出码 10，已是最新 0
#   --no-recreate  不重建容器（start.sh 用：它随后自己 compose up）
#   --quiet        已是最新时不打印
set -eu

CHECK=0 RECREATE=1 QUIET=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --no-recreate) RECREATE=0 ;;
    --quiet) QUIET=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "install-updater.sh：未知参数 $arg" >&2; exit 64 ;;
  esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/updater"
U=${CHISABOT_UPDATER_HOME:-/opt/chisabot-updater}
EXAMPLE_HOST=chisabot.example.com

say() { printf '%s\n' "[更新服务] $*"; }
warn() { printf '%s\n' "[更新服务] $*" >&2; }
die() { warn "$1"; exit "${2:-2}"; }

# ---------- 读 deploy/.env 里的非机密值（不把 .env 当 shell 执行）----------
env_value() {
  [ -f "$HERE/.env" ] || return 0
  sed -n "s/^$1=//p" "$HERE/.env" | tail -n 1 | tr -d '\r"'"'"
}

health_url_from_env() {
  domain=$(env_value CHISABOT_DOMAIN)
  port=$(env_value CHISABOT_HTTPS_PORT)
  port=${port:-8443}
  case "$domain" in ""|*[!A-Za-z0-9.-]*|"$EXAMPLE_HOST") return 0 ;; esac
  case "$port" in *[!0-9]*) port=8443 ;; esac
  if [ "$port" = 443 ]; then printf 'https://%s/login' "$domain"; else printf 'https://%s:%s/login' "$domain" "$port"; fi
}

github_repo_from_git() {
  url=$(git -C "$HERE/.." remote get-url origin 2>/dev/null || true)
  repo=$(printf '%s' "$url" | sed -n 's#^\(https://\|git@\|ssh://git@\)github\.com[:/]\([A-Za-z0-9_.-]*/[A-Za-z0-9_.-]*\)$#\2#p' | sed 's/\.git$//')
  printf '%s' "${repo:-ChisaAlter/ChisaBot}"
}

# 内存小的机器：完整构建上限 = 物理内存 - 1.5 GB（至少 2g），同时只跑 1 步。
build_memory_for_host() {
  kb=$(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' /proc/meminfo 2>/dev/null)
  [ -n "$kb" ] || { echo "6g 2"; return; }
  gb=$(( (kb / 1024 - 1536) / 1024 ))
  if [ "$gb" -ge 6 ]; then echo "6g 2"; elif [ "$gb" -ge 2 ]; then echo "${gb}g 1"; else echo "2g 1"; fi
}

# set_env KEY VALUE：改 / 加 deploy/.env 的一行（以后 start.sh 和一键更新都从 .env 读镜像）。
set_env() {
  [ -f "$HERE/.env" ] || return 0
  if grep -q "^$1=" "$HERE/.env"; then sed -i "s#^$1=.*#$1=$2#" "$HERE/.env"
  else printf '%s=%s\n' "$1" "$2" >> "$HERE/.env"; fi
}

file_sum() { [ -f "$1" ] && cksum < "$1" || echo missing; }

# ---------- 现状 ----------
SCRIPTS="compose-image.sh update.sh request.sh rollback.sh health.sh post-deploy-smoke.sh smoke.sh deps-fingerprint.sh rollback.template.sh git-askpass.sh chisabot-updater.py Dockerfile.update install.sh"
WANT_VERSION=$(sed -n 's/^VERSION = "\([0-9]*\)".*/\1/p' "$SRC/chisabot-updater.py")
HAVE_VERSION=$(sed -n 's/^VERSION = "\([0-9]*\)".*/\1/p' "$U/chisabot-updater.py" 2>/dev/null || true)
STALE=""
for f in $SCRIPTS; do
  [ "$(file_sum "$SRC/$f")" = "$(file_sum "$U/$f")" ] || STALE="$STALE $f"
done
INSTALLED=0
[ -f "$U/config.env" ] && [ -f "$U/chisabot-updater.py" ] && INSTALLED=1
ACTIVE=$(systemctl is-active chisabot-updater 2>/dev/null || true)
# 旧 unit 写死 /usr/bin/python2（Ubuntu 24.04 等没有 python2）：有 python3 时也要升级 unit。
UNIT_FILE=${CHISABOT_SYSTEMD_UNIT_DIR:-/etc/systemd/system}/chisabot-updater.service
if [ -f "$UNIT_FILE" ] && grep -q '^ExecStart=.*python2 ' "$UNIT_FILE" && command -v python3 >/dev/null 2>&1; then
  STALE="$STALE chisabot-updater.service(python2→python3)"
fi
HEALTH_URL=$(health_url_from_env)
CUR_HEALTH=""
[ -f "$U/config.env" ] && CUR_HEALTH=$(sed -n 's/^PUBLIC_HEALTH_URL=//p' "$U/config.env" | tail -n 1 | tr -d '"')
FIX_HEALTH=0
if [ "$INSTALLED" = 1 ] && [ -n "$HEALTH_URL" ]; then
  case "$CUR_HEALTH" in ""|*"$EXAMPLE_HOST"*) FIX_HEALTH=1 ;; esac
fi
COMPOSE_DIR_CFG=""
[ -f "$U/config.env" ] && COMPOSE_DIR_CFG=$(sed -n 's/^COMPOSE_DIR=//p' "$U/config.env" | tail -n 1 | tr -d '"')
CONTAINER=$( [ -f "$U/config.env" ] && sed -n 's/^CONTAINER=//p' "$U/config.env" | tail -n 1 | tr -d '"' || true)
CONTAINER=${CONTAINER:-openbot-zh}
PROJECT=$( [ -f "$U/config.env" ] && sed -n 's/^PROJECT=//p' "$U/config.env" | tail -n 1 | tr -d '"' || true)
PROJECT=${PROJECT:-openbot-zh}
HAS_MOUNT=unknown
if command -v docker >/dev/null 2>&1 && docker inspect "$CONTAINER" >/dev/null 2>&1; then
  if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | grep -q '^CHISABOT_UPDATER_DIR='; then HAS_MOUNT=yes; else HAS_MOUNT=no; fi
fi

NEED=0
[ "$INSTALLED" = 1 ] || NEED=1
[ -z "$STALE" ] || NEED=1
[ "$ACTIVE" = active ] || NEED=1
[ "$FIX_HEALTH" = 0 ] || NEED=1
[ "$HAS_MOUNT" != no ] || NEED=1

if [ "$CHECK" = 1 ]; then
  say "已安装：$([ "$INSTALLED" = 1 ] && echo "是（版本 ${HAVE_VERSION:-?}，仓库里是 $WANT_VERSION）" || echo 否)；服务：${ACTIVE:-无}"
  [ -z "$STALE" ] || say "和仓库不一样的文件：$STALE"
  [ "$FIX_HEALTH" = 0 ] || say "PUBLIC_HEALTH_URL 是空的或还是示例域名，会改成 $HEALTH_URL"
  [ -n "$CUR_HEALTH" ] || [ "$INSTALLED" = 0 ] || say "PUBLIC_HEALTH_URL 为空：健康检查跳过公网登录页"
  [ "$INSTALLED" = 1 ] || say "会生成 config.env：COMPOSE_DIR=$HERE，PUBLIC_HEALTH_URL=${HEALTH_URL:-（空，deploy/.env 没有 CHISABOT_DOMAIN）}，GITHUB_REPO=$(github_repo_from_git)"
  [ "$HAS_MOUNT" != no ] || say "容器 $CONTAINER 没有挂更新目录（CHISABOT_UPDATER_DIR），会$([ "${COMPOSE_DIR_CFG:-$HERE}" = "$HERE" ] && echo "用当前镜像重建一次容器" || echo "提示在 $COMPOSE_DIR_CFG 的 compose 里加挂载")"
  if [ "$NEED" = 1 ]; then say "需要安装 / 升级（--check 模式，未做任何改动）"; exit 10; fi
  say "已是最新"
  exit 0
fi

if [ "$NEED" = 0 ]; then
  [ "$QUIET" = 1 ] || say "chisabot-updater 已是最新（版本 $HAVE_VERSION），无需改动"
  exit 0
fi

# ---------- 前置条件 ----------
[ "$(id -u)" = 0 ] || die "需要 root 才能安装宿主机更新服务。请运行：sudo sh $HERE/install-updater.sh" 3
command -v systemctl >/dev/null 2>&1 && [ -d "${CHISABOT_SYSTEMD_RUNTIME_DIR:-/run/systemd/system}" ] \
  || die "这台机器没有 systemd（容器里或非 systemd 系统）：在线更新服务装不了，管理后台 → 系统更新 不可用。可以手动 git pull 后重新运行 deploy/start.sh。" 4
PY=""
for c in python3 python2 python; do
  command -v "$c" >/dev/null 2>&1 || continue
  if "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) or sys.version_info[:2] == (2, 7) else 1)' 2>/dev/null; then
    PY=$(command -v "$c"); break
  fi
done
[ -n "$PY" ] || die "没有可用的 Python（需要 python3 3.6+，或 python2.7）：Debian/Ubuntu：apt install -y python3；CentOS/Rocky：yum install -y python3" 5
for c in docker git flock curl; do
  command -v "$c" >/dev/null 2>&1 || die "缺少命令 $c，先安装它" 5
done
docker compose version >/dev/null 2>&1 || die "缺少 Docker Compose v2（docker compose），先安装 docker-compose-plugin" 5
if [ -f "$U/update.lock" ] && ! flock -n "$U/update.lock" true 2>/dev/null; then
  die "有一个更新或回滚正在进行，等它结束再运行（看进度：sh $U/request.sh status）" 6
fi

# ---------- config.env ----------
mkdir -p "$U"
if [ "$INSTALLED" = 0 ] && [ ! -f "$U/config.env" ]; then
  # shellcheck disable=SC2046  # 两个词：内存上限、并行数
  set -- $(build_memory_for_host)
  mem=$1 par=$2
  repo=$(github_repo_from_git)
  [ -n "$HEALTH_URL" ] || warn "deploy/.env 没有 CHISABOT_DOMAIN：PUBLIC_HEALTH_URL 留空，健康检查跳过公网登录页（配好网关后改 $U/config.env 或重新运行本脚本）"
  sed -e "s#^COMPOSE_DIR=.*#COMPOSE_DIR=$HERE#" \
      -e "s#^PUBLIC_HEALTH_URL=.*#PUBLIC_HEALTH_URL=$HEALTH_URL#" \
      -e "s#^GITHUB_REPO=.*#GITHUB_REPO=$repo#" \
      -e "s#^FULL_BUILD_MEMORY=.*#FULL_BUILD_MEMORY=$mem#" \
      -e "s#^FULL_BUILD_PARALLELISM=.*#FULL_BUILD_PARALLELISM=$par#" \
      "$SRC/config.env" > "$U/config.env.tmp"
  chmod 0644 "$U/config.env.tmp" && mv "$U/config.env.tmp" "$U/config.env"
  say "已生成 $U/config.env（COMPOSE_DIR=$HERE，GITHUB_REPO=$repo，完整构建内存上限 $mem）"
  COMPOSE_DIR_CFG=$HERE
elif [ "$FIX_HEALTH" = 1 ]; then
  cp -p "$U/config.env" "$U/config.env.bak-$(date -u +%Y%m%d%H%M%S)"
  sed -i "s#^PUBLIC_HEALTH_URL=.*#PUBLIC_HEALTH_URL=$HEALTH_URL#" "$U/config.env"
  say "PUBLIC_HEALTH_URL 改成 $HEALTH_URL（原来是空的或示例域名；原文件备份为 config.env.bak-*）"
fi

# ---------- 脚本、mirror.git、systemd ----------
CHISABOT_PYTHON=$PY bash "$SRC/install.sh"
say "chisabot-updater 版本 $WANT_VERSION 已安装（$PY）"

# ---------- 容器挂载 ----------
if [ "$HAS_MOUNT" = no ]; then
  if [ "${COMPOSE_DIR_CFG:-$HERE}" = "$HERE" ] && grep -q 'CHISABOT_UPDATER_DIR' "$HERE/compose.yaml"; then
    if [ "$RECREATE" = 1 ]; then
      image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
      set_env CHISABOT_IMAGE "$image"
      set_env CHISABOT_SOURCE_DIR "$(dirname "$HERE")"
      say "容器 $CONTAINER 还没挂更新目录：用当前镜像 $image 重建一次（不重新构建，断开十几秒）"
      (
        cd "$HERE"
        CHISABOT_IMAGE=$image docker compose -p "$PROJECT" -f compose.yaml up -d --no-build --wait --wait-timeout 180 openbot
      )
    fi
  else
    warn "容器 $CONTAINER 没有挂更新目录。在 ${COMPOSE_DIR_CFG:-你的 compose 目录} 的 compose 文件里给 openbot 服务加下面几行，再 docker compose up -d："
    warn "    volumes:"
    warn "      - $U/spool/requests:/var/lib/chisabot-updater/requests"
    warn "      - $U/spool/state:/var/lib/chisabot-updater/state:ro"
    warn "    environment:"
    warn "      CHISABOT_UPDATER_DIR: /var/lib/chisabot-updater"
  fi
fi
say "完成。管理后台 → 系统更新 可以检查和一键更新了（宿主机命令：sh $U/request.sh status）。"
