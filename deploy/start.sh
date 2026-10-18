#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! test -f .env; then
  echo 'Missing deploy/.env. Copy .env.example and configure encryption keys first.' >&2
  echo '好友可装包一键入口：sh deploy/friend-up.sh（见 docs/friend-deploy.md）。' >&2
  exit 1
fi

# Track D 安全默认：拒绝把应用端口写成 0.0.0.0（单用户公网直连 = 人人管理员）。
if grep -E '^[[:space:]]*-[[:space:]]*"?0\.0\.0\.0:' compose.yaml >/dev/null 2>&1; then
  echo 'deploy/compose.yaml binds 0.0.0.0 — refused. Keep 127.0.0.1:3001 and put HTTPS in deploy/public/.' >&2
  exit 1
fi

# 读 .env 里的非机密值（不把 .env 当 shell 执行）。
env_value() { sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '\r"\047'; }

# 仓库在宿主机上的位置写进 .env（容器读它，系统更新页给出的升级命令里用）。
src_dir=$(cd .. && pwd)
if [ -w .env ] && [ "$(env_value CHISABOT_SOURCE_DIR)" != "$src_dir" ]; then
  if grep -q '^CHISABOT_SOURCE_DIR=' .env; then sed -i "s#^CHISABOT_SOURCE_DIR=.*#CHISABOT_SOURCE_DIR=$src_dir#" .env
  else printf 'CHISABOT_SOURCE_DIR=%s\n' "$src_dir" >> .env; fi
fi

# 镜像由在线更新管理（CHISABOT_IMAGE 是 local/chisabot:auto-…，管理后台 → 系统更新 写的）时不再重新构建：
# 用 deploy/Dockerfile.zh 覆盖同一个标签会弄坏回滚和快速更新的底座。要强制按当前检出重新构建：CHISABOT_FORCE_BUILD=1。
image=${CHISABOT_IMAGE:-$(env_value CHISABOT_IMAGE)}
image=${image:-local/chisabot:latest}
build=1
case "$image" in
  *:auto-*)
    if [ "${CHISABOT_FORCE_BUILD:-0}" != 1 ] && docker image inspect "$image" >/dev/null 2>&1; then
      build=0
      echo "镜像 $image 由在线更新管理：跳过构建，直接启动（强制按当前代码重新构建：CHISABOT_FORCE_BUILD=1 sh deploy/start.sh）"
    elif [ "${CHISABOT_FORCE_BUILD:-0}" = 1 ]; then
      image=local/chisabot:latest
      sed -i "s#^CHISABOT_IMAGE=.*#CHISABOT_IMAGE=$image#" .env
      echo "CHISABOT_FORCE_BUILD=1：按当前代码重新构建 $image"
    fi
    ;;
esac
export CHISABOT_IMAGE="$image"

if [ "$build" = 1 ] && ! test -f ../app/dist/index.html; then
  echo 'Build the frontend first: TENANT_PACKAGE_DIR=../examples/zh-CN bun run --cwd app build (from the repository root).' >&2
  exit 1
fi

# 在线更新服务（管理后台 → 系统更新）：没装或旧了就装 / 升级（root + systemd；不满足时只提示，不影响启动）。
# 不想装：CHISABOT_UPDATER=off sh deploy/start.sh
if [ "${CHISABOT_UPDATER:-on}" != off ]; then
  sh ./install-updater.sh --no-recreate --quiet \
    || echo '[更新服务] 没有装好（见上面的提示）；ChisaBot 照常启动，但 管理后台 → 系统更新 不能用。装好后再运行：sudo sh deploy/install-updater.sh' >&2
fi

# 记录来源提交：/api/version 和 系统更新 页显示当前版本、落后多少个提交。有未提交的改动时不记（镜像和提交对不上）。
if [ "$build" = 1 ]; then
  commit=""
  if git -C .. rev-parse --verify -q HEAD >/dev/null 2>&1 && git -C .. diff --quiet HEAD -- 2>/dev/null; then
    commit=$(git -C .. rev-parse HEAD)
  fi
  export CHISABOT_COMMIT="$commit"
  CHISABOT_VERSION=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' ../package.json | head -n 1)
  CHISABOT_BUILD="manual-$(date -u +%Y%m%d%H%M)${commit:+-$(printf %s "$commit" | cut -c1-7)}"
  CHISABOT_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  export CHISABOT_VERSION CHISABOT_BUILD CHISABOT_BUILT_AT
  [ -n "$commit" ] || echo '（工作区有未提交的改动：镜像不记录来源提交，系统更新页第一次只能完整构建）'
fi

docker compose -p openbot-zh -f compose.yaml config --quiet
# Read only the non-secret network name. Do not source .env as shell code.
magpie_network=${MAGPIE_NETWORK:-$(env_value MAGPIE_NETWORK)}
magpie_network=${magpie_network:-openbot_magpie}
case "$magpie_network" in *[!a-zA-Z0-9_.-]*|"") echo 'Invalid MAGPIE_NETWORK name.' >&2; exit 1 ;; esac
docker network inspect "$magpie_network" >/dev/null 2>&1 || docker network create "$magpie_network" >/dev/null
if [ "$build" = 1 ]; then
  docker compose -p openbot-zh -f compose.yaml up -d --build --wait --wait-timeout 180 openbot
else
  docker compose -p openbot-zh -f compose.yaml up -d --no-build --wait --wait-timeout 180 openbot
fi

# Opt in only on a Linux host with systemd. Keep names compatible with existing deployments.
if [ "${CHISABOT_ENABLE_TIMERS:-0}" = 1 ]; then
  if [ "$(id -u)" != 0 ] || ! command -v systemctl >/dev/null 2>&1; then
    echo 'CHISABOT_ENABLE_TIMERS=1 requires root and systemd.' >&2
    exit 1
  fi
  cp openbot-zh-*.service openbot-zh-*.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now openbot-zh-attachments.timer
fi
echo 'ChisaBot is bound to 127.0.0.1:3001. Configure the HTTPS gateway before public access.'
