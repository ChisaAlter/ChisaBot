#!/bin/bash
# 镜像写在哪（update.sh / rollback.sh 用 source 引入；docs/online-update.md）。
#
# 两种部署：
#  - compose 模式：compose 文件里直接写 `    image: local/chisabot:<标签>`（手写的 /opt/chisabot-zh/compose.yaml）。
#    切换 = 改这一行；上线前的 compose 留成 <compose>.before-<新标签>。
#  - env 模式：仓库自带的 deploy/compose.yaml 写的是 `image: ${CHISABOT_IMAGE:-…}`（deploy/start.sh 部署的）。
#    compose 文件在 git 仓库里，不能改；切换 = 改同目录 .env 的 CHISABOT_IMAGE（compose 自动读它）；
#    上一版镜像名记在 .image.before-<新标签>。
# 需要 COMPOSE_DIR、COMPOSE_FILE、IMAGE_REPO（config.env）。

image_mode() {
  # shellcheck disable=SC2016  # 找的就是字面的 ${CHISABOT_IMAGE
  if grep -q '^    image: \${CHISABOT_IMAGE' "$COMPOSE_DIR/$COMPOSE_FILE" 2>/dev/null; then echo env; else echo compose; fi
}

# set_image <镜像>：把部署指向这个镜像（不启动）。成功返回 0。
set_image() {
  local f
  if [ "$(image_mode)" = env ]; then
    f="$COMPOSE_DIR/.env"
    if grep -q '^CHISABOT_IMAGE=' "$f" 2>/dev/null; then
      sed -i "s#^CHISABOT_IMAGE=.*#CHISABOT_IMAGE=$1#" "$f"
    else
      printf 'CHISABOT_IMAGE=%s\n' "$1" >> "$f"
    fi
    grep -q "^CHISABOT_IMAGE=$1\$" "$f"
  else
    f="$COMPOSE_DIR/$COMPOSE_FILE"
    sed -i "s#^\(    image: \)$IMAGE_REPO:[A-Za-z0-9._-]*#\1$1#" "$f"
    grep -q "^    image: $1\$" "$f"
  fi
}

# previous_image <标签>：<标签> 上线之前的镜像（不知道时输出空）。
previous_image() {
  if [ -f "$COMPOSE_DIR/.image.before-$1" ]; then
    sed -n "1s#^\($IMAGE_REPO:[A-Za-z0-9._-]*\)\$#\1#p" "$COMPOSE_DIR/.image.before-$1"
  elif [ -f "$COMPOSE_DIR/$COMPOSE_FILE.before-$1" ]; then
    sed -n "s#^    image: \($IMAGE_REPO:[A-Za-z0-9._-]*\)\$#\1#p" "$COMPOSE_DIR/$COMPOSE_FILE.before-$1" | head -n 1
  fi
}

# CB-100：compose_network_drift — 正在运行的容器是否不在 compose 文件声明的默认网络上（名字或子网不一致）。
# 在 COMPOSE_DIR 里调用；需要 PROJECT、COMPOSE_FILE、CONTAINER。漂移时输出一行原因并返回 0，否则返回 1。
# 默认网络改名 / 换子网后，普通 `compose up -d` 会报「network … not found」或「needs to be recreated」，
# 或者把容器留在旧网络上；这时要 --force-recreate（update.sh / rollback.sh）。
# CB-100b：从 `compose config --format json`（stdin）里取默认网络的「名字 子网」。不再硬依赖 python3：
# 依次试 CHISABOT_PYTHON / python3 / python / jq / bun / node。某个工具存在但执行失败（非 0 退出、
# 或输出不是一行「名字 子网」）时换下一个继续。一个工具都没有返回 2；有工具但全部失败返回 3。
compose_default_network_from_json() {
  local input out tool tried=0 py_code jq_code js
  # 只用 bash 内建读 stdin：调用方的 PATH 里可能只有解析器本身（server/tests/compose-network-drift.test.ts）。
  IFS= read -r -d '' input || true
  py_code='
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
n = (d.get("networks") or {}).get("default") or {}
c = ((n.get("ipam") or {}).get("config") or [{}])[0] or {}
print(n.get("name") or "", c.get("subnet") or "")
'
  # shellcheck disable=SC2016  # jq 程序本身，不展开
  jq_code='(.networks.default // {}) as $n | "\($n.name // "") \((($n.ipam // {}).config // [{}])[0].subnet // "")"'
  js='let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d;try{d=JSON.parse(s)}catch{process.exit(1)}const n=(d.networks||{}).default||{};const c=((n.ipam||{}).config||[{}])[0]||{};console.log((n.name||"")+" "+(c.subnet||""))})'
  for tool in "${CHISABOT_PYTHON:-}" python3 python jq bun node; do
    [ -n "$tool" ] || continue
    command -v "$tool" >/dev/null 2>&1 || [ -x "$tool" ] || continue
    tried=1
    case "${tool##*/}" in
      jq) out=$(printf '%s' "$input" | "$tool" -r "$jq_code" 2>/dev/null) ;;
      bun|node) out=$(printf '%s' "$input" | "$tool" -e "$js" 2>/dev/null) ;;
      *) out=$(printf '%s' "$input" | "$tool" -c "$py_code" 2>/dev/null) ;;
    esac || { echo "compose 网络漂移检查：$tool 执行失败，换下一个工具" >&2; continue; }
    # 只接受恰好一行「名字 子网」（两段都不含空白，各自可空）。
    if [[ "$out" != *$'\n'* ]] && [[ "$out" =~ ^[^[:space:]]*\ [^[:space:]]*$ ]]; then
      printf '%s\n' "$out"
      return 0
    fi
    echo "compose 网络漂移检查：$tool 的输出无法解析，换下一个工具" >&2
  done
  [ "$tried" = 1 ] && return 3
  return 2
}

# CB-100：compose_network_drift — 正在运行的容器是否不在 compose 文件声明的默认网络上（名字或子网不一致）。
# 在 COMPOSE_DIR 里调用；需要 PROJECT、COMPOSE_FILE、CONTAINER。漂移时输出一行原因并返回 0，否则返回 1。
# 默认网络改名 / 换子网后，普通 `compose up -d` 会报「network … not found」或「needs to be recreated」，
# 或者把容器留在旧网络上；这时要 --force-recreate（update.sh / rollback.sh）。
# CB-100b：主机上没有任何 JSON 解析器时，不再静默当成「没漂移」：stderr 报清楚，并按漂移处理
# （--force-recreate 只是重建容器，比把容器留在错误网络上安全）。
compose_network_drift() {
  local json want want_name want_subnet have have_subnet rc
  json=$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" config --format json 2>/dev/null) || return 1
  rc=0
  want=$(printf '%s' "$json" | compose_default_network_from_json) || rc=$?
  if [ "$rc" = 2 ] || [ "$rc" = 3 ]; then
    if [ "$rc" = 2 ]; then
      echo "::error:: 检查 compose 网络漂移需要 python3、jq、bun 或 node 之一，主机上都没有；按漂移处理（--force-recreate）" >&2
    else
      echo "::error:: 检查 compose 网络漂移的工具（python3/jq/bun/node）全部执行失败或输出无法解析；按漂移处理（--force-recreate）" >&2
    fi
    echo "无法判断网络是否漂移（没有可用的 JSON 解析工具），保守起见 --force-recreate"
    return 0
  fi
  [ "$rc" = 0 ] || return 1
  want_name=${want%% *}
  want_subnet=${want#* }
  [ -n "$want_name" ] || return 1
  have=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CONTAINER" 2>/dev/null) || return 1
  case " $have " in
    *" $want_name "*) ;;
    *) echo "容器 $CONTAINER 在网络 [${have% }] 上，compose 要求 $want_name"; return 0 ;;
  esac
  if [ -n "$want_subnet" ]; then
    have_subnet=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$want_name" 2>/dev/null)
    case " $have_subnet " in
      *" $want_subnet "*) ;;
      *) echo "网络 $want_name 的子网是 [${have_subnet% }]，compose 要求 $want_subnet"; return 0 ;;
    esac
  fi
  return 1
}
