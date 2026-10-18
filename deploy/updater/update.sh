#!/bin/bash
# ChisaBot 宿主机更新程序：一次更新（docs/online-update.md）。
#
# 由 chisabot-updater.py 以 root 调用（管理后台 → 系统更新 → 更新 / 一键完整更新）。手动运行请用
# request.sh（走同一个队列，页面上看得到进度和历史）；直接运行本脚本只用于演练：
#   update.sh --job <id> --target <40 位提交> [--full | --code-only] [--dry-run] [--build-only] [--tag <镜像标签>]
#
#   （默认）      自动：依赖 / 底座没变 → 快速更新（只替换代码层）；变了 → 完整构建。
#   --full        强制完整构建（仓库根目录的 Dockerfile 从头构建：装依赖、构建前端、构建镜像）。
#   --code-only   只做快速更新；依赖变了就停下（旧行为）。
#   --dry-run     备份、构建，然后在切换之前停下（不动正在运行的容器）。
#   --build-only  只构建镜像（不备份、不切换），给手动部署用。
#   --tag         镜像标签；默认 auto-<UTC 时间>-<提交前 7 位>。
#
# 步骤（每步打印 "::step:: <key>"，key 与 shared/system-update.ts 的 UPDATE_STEPS / FULL_UPDATE_STEPS 一致）：
#   快速：prepare → deps → backup → frontend → image → swap → health → done
#   完整：prepare → deps → backup → build → load → swap → health → done
# 先打印 "::mode:: code|full"；最后一行一定是 "::result:: succeeded|failed|rolled_back"（被中断时由 trap 写 failed）。
#
# 快速更新：FROM 底座（BASE_IMAGE），只覆盖 app/dist、server/{src,drizzle,scripts}、shared、examples/zh-CN、
# agent-computer/src 和 build-info.json，层数固定（127 层上限）。依赖（bun.lock、package.json）、Dockerfile、docker/
# 有变化时做不了 —— 自动转为完整构建。
# 完整构建：docker buildx 的 docker-container 构建器（chisabot-builder，内存上限 FULL_BUILD_MEMORY，有层缓存），
# 从 ubuntu 起按仓库 Dockerfile 构建，层数约 40；成功上线后它成为新的底座（base.env、base-deps.sha256、
# 依赖树 deps-<标签>/），之后的代码改动又走快速更新。
# 内存紧的机器：构建期间停掉 PROTO_CONTAINERS，结束后（含失败）恢复。
set -uo pipefail
U=/opt/chisabot-updater
# shellcheck source=/dev/null
. "$U/config.env"
# 完整构建上线后写的底座（覆盖 config.env 里的 BASE_IMAGE / NODE_MODULES_BASE）。
# shellcheck source=/dev/null
[ -f "$U/base.env" ] && . "$U/base.env"
# shellcheck source=compose-image.sh
. "$U/compose-image.sh"
IMAGE_MODE=$(image_mode)
FULL_BUILD_MEMORY=${FULL_BUILD_MEMORY:-6g}
FULL_BUILDER=${FULL_BUILDER:-chisabot-builder}
# 同时跑的构建步骤数：冷缓存时多个阶段会并行（apt、bun install、vite），一起超过内存上限。
FULL_BUILD_PARALLELISM=${FULL_BUILD_PARALLELISM:-2}
BUILD_CACHE_MAX=${BUILD_CACHE_MAX:-20gb}
KEEP_IMAGES=${KEEP_IMAGES:-5}
KEEP_BACKUPS=${KEEP_BACKUPS:-5}

JOB="" TARGET="" DRY=0 BUILD_ONLY=0 TAG="" MODE_REQ=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --job) JOB="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --build-only) BUILD_ONLY=1; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    --full) MODE_REQ=full; shift ;;
    --code-only) MODE_REQ=code; shift ;;
    *) echo "未知参数 $1"; exit 64 ;;
  esac
done

RESULT=failed
PROTO_STOPPED=""
B="$U/build"
resume_proto() {
  if [ -n "$PROTO_STOPPED" ]; then
    for c in $PROTO_STOPPED; do docker start "$c" >/dev/null 2>&1 && echo "原型沙箱 $c 已恢复"; done
    PROTO_STOPPED=""
  fi
}
pause_proto() {
  for c in $PROTO_CONTAINERS; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = "true" ]; then
      docker stop "$c" >/dev/null 2>&1 && PROTO_STOPPED="$PROTO_STOPPED $c" && echo "构建期间暂停原型沙箱 $c"
    fi
  done
}
finish() {
  resume_proto
  [ "$RESULT" = succeeded ] || [ ! -d "$U/deps-$TAG.partial" ] || rm -rf "$U/deps-$TAG.partial"
  echo "::result:: $RESULT"
}
trap finish EXIT
trap 'echo "::error:: 被中断"; exit 130' INT TERM

step() { echo "::step:: $1"; echo "[$(date '+%H:%M:%S')] $2"; }
fail() { echo "::error:: $*"; exit 2; }
G() { git --git-dir="$U/mirror.git" "$@"; }

case "$JOB" in ''|*[!A-Za-z0-9_-]*) fail "任务 id 无效" ;; esac
case "$TARGET" in *[!0-9a-f]*|'') fail "目标提交无效" ;; esac
[ ${#TARGET} -eq 40 ] || fail "目标提交必须是 40 位"

exec 9>"$U/update.lock"
flock -n 9 || fail "已经有一个更新或回滚在进行"
START_TS=$(date +%s)

# ---------- prepare ----------
step prepare "准备：目标 ${TARGET:0:7}"
G cat-file -e "${TARGET}^{commit}" 2>/dev/null || fail "本机镜像里没有提交 ${TARGET:0:7}"
MAIN=$(G rev-parse refs/heads/main) || fail "本机镜像里没有 main"
if [ "$TARGET" != "$MAIN" ] && ! G merge-base --is-ancestor "$TARGET" "$MAIN"; then
  fail "提交 ${TARGET:0:7} 不在 main 上"
fi
CUR_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null) || fail "找不到正在运行的容器 $CONTAINER"
CUR_TAG=${CUR_IMAGE##*:}
[ -n "$TAG" ] || TAG="auto-$(date -u +%Y%m%d%H%M)-${TARGET:0:7}"
case "$TAG" in *[!A-Za-z0-9._-]*) fail "镜像标签无效" ;; esac
NEW_IMAGE="$IMAGE_REPO:$TAG"
[ "$NEW_IMAGE" != "$CUR_IMAGE" ] || fail "新镜像标签和当前一样"
echo "当前 $CUR_IMAGE → 新 $NEW_IMAGE"
echo "::from:: $CUR_IMAGE"
echo "::to:: $NEW_IMAGE"

# ---------- deps ----------
step deps "检查依赖与底座"
FP=$(bash "$U/deps-fingerprint.sh" "$TARGET") || fail "无法计算依赖指纹"
BASE_FP=$(cat "$U/base-deps.sha256" 2>/dev/null)
MODE=code
WHY=""
if [ "$MODE_REQ" = full ]; then
  MODE=full WHY="手动要求完整构建"
elif [ "$FP" != "$BASE_FP" ]; then
  MODE=full WHY="依赖（bun.lock / package.json）或 Dockerfile / docker/ 有变化"
elif [ -z "${BASE_IMAGE:-}" ] || ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  MODE=full WHY="底座镜像 ${BASE_IMAGE:-（未配置）} 不存在"
elif [ ! -d "${NODE_MODULES_BASE:-/nonexistent}" ]; then
  MODE=full WHY="依赖树 ${NODE_MODULES_BASE:-（未配置）} 不存在"
fi
if [ "$MODE" = full ] && [ "$MODE_REQ" = code ]; then
  fail "这次更新需要完整构建（$WHY），但指定了 --code-only"
fi
echo "::mode:: $MODE"
if [ "$MODE" = full ]; then
  echo "完整构建：$WHY"
  docker buildx version >/dev/null 2>&1 || fail "没有 docker buildx（完整构建需要 Docker 的 buildx 插件）"
  NEED_KB=12000000
else
  echo "依赖未变，底座 $BASE_IMAGE：快速更新"
  NEED_KB=2500000
fi
AVAIL_KB=$(df -Pk /var/lib/docker | awk 'NR==2{print $4}')
[ "${AVAIL_KB:-0}" -gt "$NEED_KB" ] || fail "磁盘剩余不足 $((NEED_KB/1000000)) GB（$((AVAIL_KB/1024)) MB），先清理再更新"

# ---------- backup ----------
BK=""
if [ "$BUILD_ONLY" = 1 ]; then
  step backup "只构建镜像：跳过备份"
else
  step backup "备份数据库与 compose"
  BK="$U/backups/$(date -u +%Y%m%dT%H%M%SZ)-$JOB"
  mkdir -p "$BK"
  docker exec "$CONTAINER" sh -c 'pg_dump -Fc "$(cat /run/s6/container_environment/DATABASE_URL)"' > "$BK/openbot.dump" \
    || fail "pg_dump 失败"
  [ -s "$BK/openbot.dump" ] || fail "数据库备份是空的"
  cp -p "$COMPOSE_DIR/$COMPOSE_FILE" "$BK/compose.yaml"
  for v in profiles workspace; do
    tar czf "$BK/$v-volume.tgz" -C "/var/lib/docker/volumes/${PROJECT}_$v" _data 2>/dev/null || echo "（卷 $v 未备份）"
  done
  echo "$CUR_IMAGE" > "$BK/image.txt"
  echo "::backup:: $BK"
  echo "数据库备份 $(stat -c %s "$BK/openbot.dump") 字节 → $BK"
fi

rm -rf "$B" && mkdir -p "$B/src" || fail "无法准备构建目录"
G archive "$TARGET" | tar -x -C "$B/src" || fail "导出源码失败"
VERSION=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$B/src/package.json" | head -n 1)
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "$MODE" = full ]; then
  # ---------- build（完整）----------
  step build "完整构建：安装依赖、构建前端、构建镜像（限内存 $FULL_BUILD_MEMORY）"
  # 构建器的设置（内存上限、并行数）变了就重建它（层缓存随之清空）。
  printf '[worker.oci]\n  max-parallelism = %s\n' "$FULL_BUILD_PARALLELISM" > "$U/buildkitd.toml"
  WANT="memory=$FULL_BUILD_MEMORY parallelism=$FULL_BUILD_PARALLELISM"
  if docker buildx inspect "$FULL_BUILDER" >/dev/null 2>&1 && [ "$(cat "$U/.builder-config" 2>/dev/null)" != "$WANT" ]; then
    echo "构建器设置变了（$(cat "$U/.builder-config" 2>/dev/null || echo 旧) → $WANT），重建 $FULL_BUILDER"
    docker buildx rm "$FULL_BUILDER" >/dev/null 2>&1 || true
  fi
  if ! docker buildx inspect "$FULL_BUILDER" >/dev/null 2>&1; then
    docker buildx create --name "$FULL_BUILDER" --driver docker-container --buildkitd-config "$U/buildkitd.toml" \
      --driver-opt "memory=$FULL_BUILD_MEMORY,memory-swap=$FULL_BUILD_MEMORY" --bootstrap >/dev/null 2>&1 \
      || fail "无法创建构建器 $FULL_BUILDER"
    echo "$WANT" > "$U/.builder-config"
    echo "已创建构建器 $FULL_BUILDER（内存上限 $FULL_BUILD_MEMORY，无 swap；同时最多 $FULL_BUILD_PARALLELISM 步）"
  else
    docker buildx inspect --bootstrap "$FULL_BUILDER" >/dev/null 2>&1 || fail "构建器 $FULL_BUILDER 启动失败"
  fi
  pause_proto
  BLOG="$U/jobs/$JOB.build.log"
  BARGS=(--builder "$FULL_BUILDER" --progress=plain
    --build-arg "VITE_CHISABOT_BUILD_ID=$TAG" --build-arg "VITE_MAGPIE_MANAGEMENT_URL=${VITE_MAGPIE_MANAGEMENT_URL:-}"
    --build-arg "CHISABOT_VERSION=${VERSION:-0.0.0}" --build-arg "CHISABOT_COMMIT=$TARGET" --build-arg "CHISABOT_BUILD=$TAG"
    --build-arg "CHISABOT_BUILT_AT=$BUILT_AT" --build-arg "CHISABOT_IMAGE=$NEW_IMAGE")
  # 进度：完整日志进 jobs/<任务>.build.log，页面上只显示每一步的开头和结果。
  docker buildx build "${BARGS[@]}" --target chisabot -t "$NEW_IMAGE" --load "$B/src" 2>&1 \
    | tee "$BLOG" | awk '
        # fflush()：Ubuntu 的 awk 是 mawk，管道里会攒到几 KB 才写，页面上的日志就停住不动。
        /^#[0-9]+ \[[^]]+\] / { sub(/^#[0-9]+ /, ""); if (!seen[$0]++) { print substr($0, 1, 160); fflush() } next }
        /^#[0-9]+ (DONE|CACHED|ERROR)/ { next }
        /^#[0-9]+ (exporting to (docker|oci) image format|exporting layers|sending tarball)/ { if (!loading++) { print "::step:: load"; print "导出并导入镜像到 Docker"; fflush() } next }
        /ERROR:|error:|failed to solve/ { print substr($0, 1, 300); fflush() }'
  CODE=${PIPESTATUS[0]}
  if [ "$CODE" != 0 ]; then
    echo "构建日志（最后 25 行，完整的在 $BLOG）："
    grep -v '^#[0-9]* \(sha256\|extracting\|transferring\)' "$BLOG" | tail -n 25 | cut -c1-300
    if grep -q 'cannot allocate memory\|ResourceExhausted\|signal: killed\|exit code: 137' "$BLOG"; then
      fail "完整构建内存不够（FULL_BUILD_MEMORY=$FULL_BUILD_MEMORY）：在 config.env 调大它或调小 FULL_BUILD_PARALLELISM，再点一次"
    fi
    fail "完整构建失败（docker buildx 退出码 $CODE）"
  fi
  step load "导入完成，检查镜像"
  docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || fail "镜像 $NEW_IMAGE 没有导入 Docker"
  [ "$(docker image inspect -f '{{index .Config.Labels "chisabot.commit"}}' "$NEW_IMAGE")" = "$TARGET" ] \
    || fail "新镜像的 chisabot.commit 标签不对"
  # 之后的快速更新用的依赖树（含 vite 等开发依赖）；只用缓存，几秒钟。失败只影响下一次是否还要完整构建。
  rm -rf "$U/deps-$TAG.partial" && mkdir -p "$U/deps-$TAG.partial"
  if docker buildx build "${BARGS[@]}" --target updater-deps --output "type=local,dest=$U/deps-$TAG.partial/out" "$B/src" >>"$BLOG" 2>&1 \
    && tar -xf "$U/deps-$TAG.partial/out/node_modules.tar" -C "$U/deps-$TAG.partial" && rm -rf "$U/deps-$TAG.partial/out" \
    && [ -d "$U/deps-$TAG.partial/node_modules" ]; then
    echo "依赖树已导出（之后的代码更新不必重装依赖）"
  else
    rm -rf "$U/deps-$TAG.partial"
    echo "（依赖树导出失败：下次更新仍会完整构建）"
  fi
  resume_proto
  LAYERS=$(docker image inspect -f '{{len .RootFS.Layers}}' "$NEW_IMAGE")
  [ "$LAYERS" -lt 110 ] || fail "新镜像有 $LAYERS 层，太接近 127 层上限"
  echo "镜像 $NEW_IMAGE 构建完成（$LAYERS 层，$(( $(date +%s) - START_TS )) 秒）"
  echo "::image:: $NEW_IMAGE"
else
  # ---------- frontend（快速）----------
  step frontend "构建前端（限内存 $BUILD_MEMORY）"
  cp -al "$NODE_MODULES_BASE" "$B/src/node_modules" || fail "准备 node_modules 失败"
  # 完整构建导出的依赖树里还有各工作区自己的 node_modules（bun 的 isolated 布局），一起硬链接过来。
  NM_ROOT=$(dirname "$NODE_MODULES_BASE")
  if [ -f "$NM_ROOT/.chisabot-deps" ]; then
    (cd "$NM_ROOT" && find . -path ./node_modules -prune -o -name node_modules -type d -print -prune) | while read -r d; do
      mkdir -p "$B/src/$(dirname "$d")" && cp -al "$NM_ROOT/$d" "$B/src/$d"
    done
  fi
  printf '{"version":"%s","commit":"%s","buildId":"%s","builtAt":"%s","image":"%s"}\n' \
    "${VERSION:-0.0.0}" "$TARGET" "$TAG" "$BUILT_AT" "$NEW_IMAGE" > "$B/build-info.json"
  pause_proto
  docker run --rm --memory "$BUILD_MEMORY" --memory-swap "$BUILD_MEMORY" --network none \
    -v "$B/src:/src" -e VITE_CHISABOT_BUILD_ID="$TAG" -e VITE_MAGPIE_MANAGEMENT_URL="${VITE_MAGPIE_MANAGEMENT_URL:-}" \
    --entrypoint sh "$CUR_IMAGE" -c '
cd /src && bun scripts/generate-app-config.ts >/dev/null 2>&1 || echo "（generate-app-config 未成功，使用仓库里的配置）"
# routeTree.gen.ts 由 vite 的 TanStack Router 插件在构建时重新生成。
V=node_modules/vite/bin/vite.js; cd app && rm -rf dist && { [ -f "$V" ] || V=../$V; }
NODE_OPTIONS=--max-old-space-size=2800 node "$V" build > /tmp/vite.log 2>&1
code=$?
grep -v "^dist\|^ *dist" /tmp/vite.log | tail -n 12
exit $code
' || fail "前端构建失败"
  resume_proto
  [ -f "$B/src/app/dist/index.html" ] || fail "前端构建没有产出 index.html"
  grep -rqF "$TAG" "$B/src/app/dist/assets" || fail "前端产物里没有构建号 $TAG"
  echo "前端构建完成"

  # ---------- image（快速）----------
  step image "构建镜像 $NEW_IMAGE（底座 $BASE_IMAGE）"
  C="$B/ctx"
  mkdir -p "$C/app" "$C/server" "$C/examples" "$C/agent-computer"
  cp -a "$B/src/app/dist" "$C/app/dist"
  cp -a "$B/src/server/src" "$B/src/server/drizzle" "$B/src/server/scripts" "$C/server/"
  cp -a "$B/src/shared" "$C/shared"
  cp -a "$B/src/examples/zh-CN" "$C/examples/zh-CN"
  cp -a "$B/src/agent-computer/src" "$C/agent-computer/src"
  cp -p "$B/build-info.json" "$C/build-info.json"
  sed -e "s#@BASE_IMAGE@#$BASE_IMAGE#" -e "s#@COMMIT@#$TARGET#g" -e "s#@TAG@#$TAG#g" -e "s#@VERSION@#${VERSION:-0.0.0}#g" \
    "$U/Dockerfile.update" > "$C/Dockerfile" || fail "生成 Dockerfile 失败"
  docker build -q -t "$NEW_IMAGE" "$C" || fail "镜像构建失败"
  LAYERS=$(docker image inspect -f '{{len .RootFS.Layers}}' "$NEW_IMAGE")
  [ "$LAYERS" -lt 120 ] || fail "新镜像有 $LAYERS 层，太接近 127 层上限：需要完整构建（--full）"
  echo "镜像 $NEW_IMAGE 构建完成（$LAYERS 层）"
  echo "::image:: $NEW_IMAGE"
fi

if [ "$BUILD_ONLY" = 1 ] || [ "$DRY" = 1 ]; then
  [ "$DRY" = 1 ] && echo "::dry-run:: 在切换前停下；正在运行的仍是 $CUR_IMAGE"
  step done "完成（未切换，用时 $(( $(date +%s) - START_TS )) 秒）"
  rm -rf "$B"
  [ -d "$U/deps-$TAG.partial" ] && echo "依赖树留在 $U/deps-$TAG.partial（未启用）"
  RESULT=succeeded
  exit 0
fi

# ---------- drain ----------
# 切换会重启应用容器，正在跑的那一轮会被拦腰截断（2026-10-16「模型老断」：15:37 一次部署打断了用户正在装 Node.js
# 的那一轮，DESIGN.md §89）。构建可能要好几分钟，期间用户又发了消息；所以在真正切换前再等一次：没有正在回答的
# 对话（线程锁）才切。最多等 DRAIN_SECONDS（默认 900 秒），到点还没空就照样切——重启后应用会把被打断的那一轮
# 补完（工具结果 + 说明原因的 RUN_ERROR），聊天里写清楚是服务重启，不会说成模型的错。DRAIN_SECONDS=0 关掉。
DRAIN_SECONDS=${DRAIN_SECONDS:-900}
busy_threads() {
  docker exec "$CONTAINER" sh -c 'export PGPASSWORD=$(cat /var/lib/postgresql/pgpassword 2>/dev/null); psql -h 127.0.0.1 -U openbot openbot -Atc "select count(*) from openbot_local_threads where lock_expires_at > now()"' 2>/dev/null | tr -dc 0-9
}
if [ "$DRAIN_SECONDS" -gt 0 ] 2>/dev/null; then
  step drain "等正在回答的对话结束再切换（最多 $DRAIN_SECONDS 秒）"
  WAITED=0
  while :; do
    N=$(busy_threads)
    [ -z "$N" ] && { echo "读不到对话状态，直接切换"; break; }
    [ "$N" = 0 ] && { [ "$WAITED" -gt 0 ] && echo "对话都已结束（等了 $WAITED 秒）"; break; }
    [ "$WAITED" -ge "$DRAIN_SECONDS" ] && { echo "注意：等了 $WAITED 秒仍有 $N 个对话在回答，照常切换（重启后会把被打断的那一轮补完）"; break; }
    [ $((WAITED % 60)) = 0 ] && echo "还有 $N 个对话在回答，等它们结束…（已等 $WAITED 秒）"
    sleep 5; WAITED=$((WAITED + 5))
  done
fi

# ---------- swap ----------
step swap "切换到 $NEW_IMAGE"
RB="$COMPOSE_DIR/rollback-to-$CUR_TAG.sh"
sed -e "s#@NEW@#$NEW_IMAGE#g" -e "s#@NEW_TAG@#$TAG#g" -e "s#@PREV@#$CUR_IMAGE#g" -e "s#@JOB@#$JOB#g" \
  -e "s#@COMPOSE_DIR@#$COMPOSE_DIR#g" -e "s#@COMPOSE_FILE@#$COMPOSE_FILE#g" -e "s#@PROJECT@#$PROJECT#g" \
  -e "s#@SERVICE@#$SERVICE#g" -e "s#@CONTAINER@#$CONTAINER#g" \
  -e "s#@LOCAL_URL@#${LOCAL_URL:-http://127.0.0.1:3001}#g" -e "s#@PUBLIC_HEALTH_URL@#${PUBLIC_HEALTH_URL:-}#g" "$U/rollback.template.sh" > "$RB.tmp" && chmod 755 "$RB.tmp" && mv "$RB.tmp" "$RB" \
  || fail "写回滚脚本失败"
echo "回滚脚本 $RB"
echo "::rollback:: $RB"
(
  cd "$COMPOSE_DIR" || exit 1
  exec 8>.deploy.lock
  flock -w 60 8 || { echo "拿不到 $COMPOSE_DIR/.deploy.lock"; exit 1; }
  if [ "$IMAGE_MODE" = env ]; then
    # 仓库自带的 compose.yaml 不改，镜像写进同目录 .env 的 CHISABOT_IMAGE。
    echo "$CUR_IMAGE" > ".image.before-$TAG"
    restore() { set_image "$CUR_IMAGE"; }
    set_image "$NEW_IMAGE" || { restore; echo "无法把 CHISABOT_IMAGE 写进 $COMPOSE_DIR/.env"; exit 1; }
  else
    cp -p "$COMPOSE_FILE" "$COMPOSE_FILE.before-$TAG"
    restore() { cp -p "$COMPOSE_FILE.before-$TAG" "$COMPOSE_FILE"; }
    set_image "$NEW_IMAGE" || { restore; echo "compose 里没有找到镜像行"; exit 1; }
  fi
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" config --quiet || { restore; exit 1; }
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --no-deps --pull never --wait --wait-timeout 240 "$SERVICE"
)
SWAP=$?

# ---------- health ----------
step health "健康检查"
OK=0
if [ "$SWAP" = 0 ] && bash "$U/health.sh" "$NEW_IMAGE" "$TAG"; then OK=1; fi
if [ "$OK" != 1 ]; then
  echo "::error:: 新版本健康检查没通过，自动回滚到 $CUR_IMAGE"
  docker logs --tail 15 "$CONTAINER" 2>&1 | cut -c1-240 | sed 's/^/  容器日志 | /'
  if sh "$RB" && bash "$U/health.sh" "$CUR_IMAGE" ""; then
    echo "已回滚到 $CUR_IMAGE"
    RESULT=rolled_back
    exit 3
  fi
  echo "::error:: 自动回滚后仍不健康，请人工处理（回滚脚本 $RB，备份 ${BK:-无}）"
  exit 4
fi

# ---------- done ----------
if [ "$MODE" = full ]; then
  # 新镜像成为之后快速更新的底座。
  if [ -d "$U/deps-$TAG.partial/node_modules" ]; then
    touch "$U/deps-$TAG.partial/.chisabot-deps"
    rm -rf "$U/deps-$TAG" && mv "$U/deps-$TAG.partial" "$U/deps-$TAG"
    {
      echo "# 由 update.sh 在完整构建 $TAG 上线后写入（docs/online-update.md）；覆盖 config.env 的同名项。"
      echo "BASE_IMAGE=$NEW_IMAGE"
      echo "NODE_MODULES_BASE=$U/deps-$TAG/node_modules"
      echo "BASE_COMMIT=$TARGET"
    } > "$U/base.env.tmp" && mv "$U/base.env.tmp" "$U/base.env"
    echo "$FP" > "$U/base-deps.sha256.tmp" && mv "$U/base-deps.sha256.tmp" "$U/base-deps.sha256"
    BASE_IMAGE=$NEW_IMAGE
    echo "新底座 $NEW_IMAGE（之后依赖不变的更新走快速更新）"
    # 只留现在和上一份依赖树。
    ls -1dt "$U"/deps-*/ 2>/dev/null | grep -v '\.partial/$' | tail -n +3 | xargs -r rm -rf
  else
    echo "（没有依赖树，底座不变；下次更新仍会完整构建）"
  fi
  docker buildx prune --builder "$FULL_BUILDER" -f --max-used-space "$BUILD_CACHE_MAX" >/dev/null 2>&1 \
    || docker buildx prune --builder "$FULL_BUILDER" -f --keep-storage "$BUILD_CACHE_MAX" >/dev/null 2>&1 || true
fi
# 更新程序自己也跟着升级（新提交里的 deploy/updater/）：只换脚本，守护进程空闲时自动重新加载。失败不影响这次更新。
if [ -f "$B/src/deploy/updater/install.sh" ]; then
  if bash "$B/src/deploy/updater/install.sh" --scripts-only 2>&1 | sed 's/^/更新程序 | /'; then :; fi
fi
# deploy/start.sh 部署的（env 模式）：仓库检出没有本地改动、能快进时快进到这次的提交，和正在运行的版本保持一致
# （下次手动 start.sh 用的 compose.yaml 也是新的）。归 root 的检出才动，失败只记一行。
REPO_DIR=$(dirname "$COMPOSE_DIR")
if [ "$IMAGE_MODE" = env ] && [ -d "$REPO_DIR/.git" ] && [ "$(stat -c %u "$REPO_DIR")" = 0 ]; then
  if [ -z "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ] \
    && git -C "$REPO_DIR" fetch -q "$U/mirror.git" "$TARGET" 2>/dev/null \
    && git -C "$REPO_DIR" merge -q --ff-only "$TARGET" >/dev/null 2>&1; then
    echo "仓库 $REPO_DIR 已快进到 ${TARGET:0:7}"
  else
    echo "（仓库 $REPO_DIR 有本地改动或不能快进，没有同步；需要时手动 git pull）"
  fi
fi
step done "完成：$NEW_IMAGE 已上线（用时 $(( $(date +%s) - START_TS )) 秒）"
echo "::duration:: $(( $(date +%s) - START_TS ))"
rm -rf "$B"
# 只保留最近 KEEP_IMAGES 个一键更新镜像；不动正在用的、上一版（回滚目标）、底座和手动发布的 glass-* 等。
docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' "$IMAGE_REPO" | awk '$1 ~ /:auto-/' | sort -k2 -r | awk '{print $1}' \
  | tail -n +"$((KEEP_IMAGES + 1))" | while read -r img; do
    if [ "$img" != "$NEW_IMAGE" ] && [ "$img" != "$CUR_IMAGE" ] && [ "$img" != "${BASE_IMAGE:-}" ] && docker rmi "$img" >/dev/null 2>&1; then
      echo "清理旧镜像 $img"
    fi
  done
ls -1dt "$U"/backups/*/ 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -rf
docker image prune -f >/dev/null 2>&1
RESULT=succeeded
exit 0
