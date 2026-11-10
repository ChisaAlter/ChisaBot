#!/bin/bash
# CB-100b：updater shell 脚本的离线测试（假的 docker / python3 / jq，不连任何服务器）。
# 用法：bash deploy/updater/test-shell.sh
# shellcheck disable=SC2015  # pass/fail 都只 echo，A && B || C 足够
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAIL=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; FAIL=1; }

# 只放测试需要的系统命令，确保主机上真的 python3/jq/bun/node 不会混进来。
BASE="$TMP/base"; mkdir -p "$BASE"
for c in cat sed grep tr head tail wc dirname mktemp rm sh bash env; do
  ln -s "$(command -v "$c")" "$BASE/$c"
done
for dll in /usr/bin/msys-*.dll /usr/bin/lib*.dll; do
  [ -f "$dll" ] && cp -f "$dll" "$BASE/"
done

# ---------- 1. hermes-reach.sh：CHISABOT_AGENT_KERNEL 的规范化 ----------
mkdir -p "$TMP/h/bin" "$TMP/h/compose"
printf 'CONTAINER=fake-app\n' > "$TMP/h/config.env"
cat > "$TMP/h/bin/docker" <<'SH'
#!/bin/bash
# 假 docker exec：HERMES_URL 永远为空；KERNEL 取 FAKE_KERNEL（可能为空）。
case "$*" in
  *CHISABOT_HERMES_URL*) exit 0 ;;
  *CHISABOT_AGENT_KERNEL*) printf '%s\n' "${FAKE_KERNEL:-}" ;;
esac
SH
chmod +x "$TMP/h/bin/docker"
run_reach() { # $1=容器值 $2=.env 行；输出退出码
  if [ -n "$2" ]; then printf '%s\n' "$2" > "$TMP/h/compose/.env"; else rm -f "$TMP/h/compose/.env"; fi
  FAKE_KERNEL=$1 CHISABOT_UPDATER_CONFIG="$TMP/h/config.env" COMPOSE_DIR="$TMP/h/compose" \
    PATH="$TMP/h/bin:$BASE" bash "$HERE/hermes-reach.sh" >/dev/null 2>&1
  echo $?
}
for v in 'hermes' 'hermes # prod' '  hermes  ' '"hermes"' "'hermes'" '"Hermes" # prod' 'HERMES' $'hermes\r'; do
  [ "$(run_reach "$v" '')" = 1 ] && pass "容器值 [$v] 识别为 hermes" || fail "容器值 [$v] 应识别为 hermes"
  [ "$(run_reach '' "CHISABOT_AGENT_KERNEL=$v")" = 1 ] && pass ".env 值 [$v] 识别为 hermes" || fail ".env 值 [$v] 应识别为 hermes"
done

for v in 'builtin' '# hermes' 'hermesx' '"builtin # hermes"' ''; do
  [ "$(run_reach "$v" '')" = 0 ] && pass "容器值 [$v] 不是 hermes（skipped）" || fail "容器值 [$v] 不应识别为 hermes"
done

# ---------- 2. compose_network_drift：工具执行失败时回退 ----------
D="$TMP/d"; mkdir -p "$D/bin"
cat > "$D/bin/docker" <<'SH'
#!/bin/bash
case "$1 $2" in
  "compose -p") echo '{"networks":{"default":{"name":"net1","ipam":{"config":[{"subnet":"10.9.0.0/16"}]}}}}' ;;
  "inspect -f") echo 'net1 ' ;;
  "network inspect") echo '10.9.0.0/16 ' ;;
esac
SH
chmod +x "$D/bin/docker"
mk() { printf '#!/bin/bash\n%s\n' "$2" > "$D/bin/$1"; chmod +x "$D/bin/$1"; }
drift() { # 输出 "rc|stderr"
  local err rc
  err=$( (PROJECT=p COMPOSE_FILE=c CONTAINER=x PATH="$D/bin:$BASE" bash -c ". '$HERE/compose-image.sh'; compose_network_drift >/dev/null") 2>&1)
  rc=$?
  printf '%s|%s' "$rc" "$err"
}
mk python3 'cat >/dev/null; exit 7'               # 存在但执行失败
mk python  'cat >/dev/null; echo "not parsable output here"'  # 输出不可解析
mk jq      'cat >/dev/null; echo "net1 10.9.0.0/16"'          # 正常
r=$(drift)
[ "${r%%|*}" = 1 ] && pass "python3 失败、python 输出不可解析 → 回退到 jq，判定无漂移" || fail "应回退到 jq 且无漂移：$r"
case "$r" in *"python3 执行失败"*) pass "python3 失败有提示" ;; *) fail "缺 python3 失败提示：$r" ;; esac
case "$r" in *"::error::"*) fail "回退成功时不应报 ::error::" ;; *) pass "回退成功时不报 ::error::" ;; esac

mk jq 'cat >/dev/null; echo "net2 10.9.0.0/16"'   # jq 看到的期望网络不同 → 真漂移
r=$(drift); [ "${r%%|*}" = 0 ] && pass "回退后的工具能检出真实漂移" || fail "应检出漂移：$r"

mk jq 'cat >/dev/null; exit 5'; mk bun 'exit 1'; mk node 'echo'
r=$(drift)
[ "${r%%|*}" = 0 ] && pass "全部工具失败 → 按漂移处理" || fail "全部失败应返回漂移：$r"
case "$r" in *"::error::"*"全部执行失败"*) pass "全部工具失败报 ::error::" ;; *) fail "全部失败应报 ::error::：$r" ;; esac

mk ok 'cat >/dev/null; echo "net1 10.9.0.0/16"'
r=$(CHISABOT_PYTHON="$D/bin/ok" drift)
[ "${r%%|*}" = 1 ] && pass "CHISABOT_PYTHON 优先使用" || fail "CHISABOT_PYTHON 应优先：$r"

rm -f "$D/bin/python3" "$D/bin/python" "$D/bin/jq" "$D/bin/bun" "$D/bin/node"
r=$(drift)
[ "${r%%|*}" = 0 ] && case "$r" in *"::error::"*"都没有"*) true ;; *) false ;; esac \
  && pass "一个工具都没有 → ::error:: + 漂移（原行为不变）" || fail "无工具时行为变了：$r"

# ---------- 3. magpie.sh --update：拉取挂起有上限、有心跳；成功路径走完整步 ----------
M="$TMP/m"; mkdir -p "$M/bin" "$M/updater" "$M/magpie" "$M/updater/spool/state"
printf '' > "$M/magpie/compose.yaml"
for c in date sleep timeout mkdir; do ln -s "$(command -v "$c")" "$M/bin/$c"; done
cat > "$M/bin/python3" <<'SH'
#!/bin/bash
# 假 python3：write_state 把 STATE 路径当最后一个参数传进来——写一个标记文件。
cat >/dev/null
for a; do p=$a; done
printf '{"installed":true,"updateAvailable":false}\n' > "$p"
SH
chmod +x "$M/bin/python3"
cat > "$M/bin/curl" <<'SH'
#!/bin/bash
printf '200'
SH
chmod +x "$M/bin/curl"
run_magpie() { # $1..$n=追加的 env 覆盖（在默认赋值之后、命令之前传入，真正生效）；输出 "rc|输出"
  local out rc
  out=$(env CHISABOT_UPDATER_DIR="$M/updater" MAGPIE_DIR="$M/magpie" \
    MAGPIE_PULL_TIMEOUT_SEC=30 MAGPIE_PULL_HEARTBEAT_SEC=5 MAGPIE_UP_TIMEOUT_SEC=10 \
    MAGPIE_HEALTH_TIMEOUT_SEC=5 PATH="$M/bin:$BASE" "$@" bash "$HERE/magpie.sh" --update 2>&1)
  rc=$?
  printf '%s|%s' "$rc" "$out"
}

# 3a. pull 永远不回来：到 MAGPIE_PULL_TIMEOUT_SEC 判失败，期间有心跳日志
cat > "$M/bin/docker" <<'SH'
#!/bin/bash
case "$*" in
  "image inspect"*) printf 'ghcr.io/x/magpie@sha256:aaa\n' ;;
  "inspect "*) exit 0 ;;
  *" pull "*) exec sleep 90 ;;
esac
SH
chmod +x "$M/bin/docker"
r=$(run_magpie MAGPIE_PULL_TIMEOUT_SEC=8)
case "$r" in "2|"*"::result:: failed"*) pass "pull 挂起超上限 → ::result:: failed" ;; *) fail "pull 挂起未判失败：$r" ;; esac
case "$r" in *"拉取中"*) pass "拉取过程有心跳日志" ;; *) fail "缺心跳日志：$r" ;; esac
case "$r" in *"超过 8 秒"*) pass "失败原因带超时秒数" ;; *) fail "失败原因不含超时：$r" ;; esac

# 3b. 正常：pull 出输出、up -d 成功、健康检查过 → succeeded（docker 输出末尾进任务日志）
cat > "$M/bin/docker" <<'SH'
#!/bin/bash
case "$*" in
  "image inspect"*) printf 'ghcr.io/x/magpie@sha256:aaa\n' ;;
  "inspect "*) exit 1 ;;                      # 容器不存在 = 首次安装，继续走 swap+health
  *" pull "*) sleep 2; printf 'Pulled abc123\n' ;;
  *" up -d "*) exit 0 ;;
esac
SH
r=$(run_magpie)
case "$r" in "0|"*"::result:: succeeded"*) pass "安装路径 pull→swap→health→done 成功" ;; *) fail "安装路径未成功：$r" ;; esac
case "$r" in *"::step:: done"*) pass "成功路径走完所有步骤" ;; *) fail "缺 done 步：$r" ;; esac
case "$r" in *"Pulled abc123"*) pass "pull 输出末尾并进任务日志" ;; *) fail "pull 输出没进日志：$r" ;; esac
[ -f "$M/updater/spool/state/magpie.json" ] && pass "成功路径写了 magpie.json" || fail "成功路径没写 magpie.json"

# 3c. up -d 超时：回显「重建失败或超过 N 秒」并判失败
cat > "$M/bin/docker" <<'SH'
#!/bin/bash
case "$*" in
  "image inspect"*) printf 'ghcr.io/x/magpie@sha256:aaa\n' ;;
  "inspect "*) exit 1 ;;
  *" pull "*) exit 0 ;;
  *" up -d "*) exec sleep 60 ;;
esac
SH
r=$(run_magpie MAGPIE_UP_TIMEOUT_SEC=5)
case "$r" in "2|"*"超过 5 秒"*"::result:: failed"*) pass "up -d 超时 → 带秒数的失败" ;; *) fail "up -d 超时未判失败：$r" ;; esac


# ---------- 4. magpie.sh 一键安装：只装官方镜像、摘要一致、签名校验、失败可重试、装完交出密钥 ----------
I="$TMP/i"; mkdir -p "$I/bin" "$I/updater/spool/state"
for c in date sleep timeout mkdir chmod chown cp mv base64 id python3 touch; do ln -s "$(command -v "$c")" "$I/bin/$c"; done
printf 'services:\n  magpie:\n    image: ${MAGPIE_IMAGE:-ghcr.io/yetone/magpie:latest}\n' > "$I/updater/magpie.compose.yaml"
cat > "$I/bin/curl" <<'SH'
#!/bin/bash
printf '%s' "${FAKE_HTTP:-200}"
SH
# 假 docker：容器在不在看 $I/running；所有调用记进 $I/docker.log。
cat > "$I/bin/docker" <<'SH'
#!/bin/bash
echo "$*" >> "$FAKE_DIR/docker.log"
case "$*" in
  "buildx imagetools inspect"*) printf '%s\n' "${FAKE_REMOTE:-sha256:1111111111111111111111111111111111111111111111111111111111111111}" ;;
  "image inspect"*) printf 'ghcr.io/yetone/magpie@%s\n' "${FAKE_LOCAL:-sha256:1111111111111111111111111111111111111111111111111111111111111111}" ;;
  "inspect "*) [ -f "$FAKE_DIR/running" ] ;;
  "network inspect"*) exit 0 ;;
  "logs "*) echo "magpie: listening" ;;
  *" pull "*) printf 'Pulled\n' ;;
  *" up -d "*) [ "${FAKE_UP:-ok}" = ok ] && touch "$FAKE_DIR/running" ;;
  *" down"*) rm -f "$FAKE_DIR/running" ;;
esac
SH
chmod +x "$I/bin/curl" "$I/bin/docker"
run_install() { # 追加的 env 覆盖；输出 "rc|输出"
  local out rc
  out=$(env CHISABOT_UPDATER_DIR="$I/updater" MAGPIE_DIR="$I/magpie" FAKE_DIR="$I" \
    MAGPIE_PULL_TIMEOUT_SEC=30 MAGPIE_PULL_HEARTBEAT_SEC=5 MAGPIE_UP_TIMEOUT_SEC=10 MAGPIE_HEALTH_TIMEOUT_SEC=4 \
    PATH="$I/bin:$BASE" "$@" bash "$HERE/magpie.sh" --update --job magpie-test123 2>&1)
  rc=$?
  printf '%s|%s' "$rc" "$out"
}
reset_install() { rm -rf "$I/magpie" "$I/running" "$I/docker.log" "$I/updater/spool/state/"*; rm -f "$I/bin/gh" "$I/bin/cosign"; }

# 4a. 不是官方镜像：一个文件都不写，不拉也不起（只看过一眼容器在不在）
reset_install
r=$(run_install MAGPIE_IMAGE=docker.io/someone/magpie:latest)
case "$r" in "2|"*"不是官方镜像"*"::result:: failed"*) pass "非官方镜像 → 拒绝安装" ;; *) fail "非官方镜像没拒：$r" ;; esac
[ ! -e "$I/magpie" ] && ! grep -qE "pull|up -d|network create" "$I/docker.log" 2>/dev/null && pass "拒绝时不写目录、不拉不起" || fail "拒绝时动了东西"

# 4b. 没有校验工具（auto）：核对摘要后装好；密钥只在 root 文件和交给应用的 0400 文件里
reset_install
r=$(run_install)
case "$r" in "0|"*"::result:: succeeded"*) pass "一键安装成功" ;; *) fail "一键安装没成功：$r" ;; esac
for st in prepare pull verify swap health connect done; do
  case "$r" in *"::step:: $st"*) ;; *) fail "安装缺步骤 $st：$r" ;; esac
done
pass "安装步骤 prepare→pull→verify→swap→health→connect→done 齐全"
case "$r" in *"跳过签名校验"*"官方仓库"*) pass "没有 gh/cosign 时如实说明只核对了摘要" ;; *) fail "缺「跳过签名校验」说明：$r" ;; esac
[ -f "$I/magpie/compose.yaml" ] && pass "写了 compose（来自模板）" || fail "没写 compose"
key=$(sed -n 's/^MAGPIE_WEB_KEY=//p' "$I/magpie/private/magpie.env")
printf '%s' "$key" | grep -Eq '^[A-Za-z0-9_-]{40,}$' && pass "生成了随机管理密钥" || fail "管理密钥格式不对：$key"
[ "$(stat -c %a "$I/magpie/private/magpie.env")" = 600 ] && [ "$(stat -c %a "$I/magpie/private")" = 700 ] \
  && pass "密钥文件 600、目录 700" || fail "密钥文件权限不对"
[ "$(cat "$I/updater/spool/state/magpie-web.key")" = "$key" ] && [ "$(stat -c %a "$I/updater/spool/state/magpie-web.key")" = 400 ] \
  && pass "密钥交给应用：同一把、0400" || fail "交给应用的密钥不对"
case "$r" in *"$key"*) fail "任务日志里出现了密钥" ;; *) pass "任务日志不含密钥" ;; esac
st=$(cat "$I/updater/spool/state/magpie.json")
case "$st" in *'"installed": true'*'"installable": true'*'"managed": true'*'"verification": "digest"'*) pass "magpie.json: installed/installable/managed/verification=digest" ;; *) fail "magpie.json 不对：$st" ;; esac
grep -q "pull magpie" "$I/docker.log" && grep -q "up -d magpie" "$I/docker.log" && pass "按 compose 拉取并启动" || fail "docker 调用不对"

# 4c. 再点一次（已装好）：走更新路径，不重新生成密钥
r=$(run_install)
[ "$(sed -n 's/^MAGPIE_WEB_KEY=//p' "$I/magpie/private/magpie.env")" = "$key" ] && pass "已装好时不换密钥" || fail "已装好时密钥被换了"
case "$r" in *"::step:: verify"*) fail "已装好还走了安装：$r" ;; *) pass "已装好 → 走更新路径" ;; esac

# 4d. 拉下来的摘要和仓库公布的不一致：不启动
reset_install
r=$(run_install FAKE_LOCAL=sha256:2222222222222222222222222222222222222222222222222222222222222222)
case "$r" in "2|"*"不一致"*"::result:: failed"*) pass "摘要不一致 → 不启动" ;; *) fail "摘要不一致没拦：$r" ;; esac
grep -q "up -d" "$I/docker.log" && fail "摘要不一致还启动了" || pass "摘要不一致时没有 up -d"

# 4e. 有 gh：校验通过记 attested；校验不过不启动
reset_install
printf '#!/bin/bash\necho "$*" >> "$FAKE_DIR/gh.log"\nexit 0\n' > "$I/bin/gh"; chmod +x "$I/bin/gh"
r=$(run_install)
case "$r" in "0|"*"签名校验通过"*) pass "gh attestation 通过 → 安装" ;; *) fail "gh 通过没装上：$r" ;; esac
grep -q "attestation verify oci://ghcr.io/yetone/magpie@sha256:1111" "$I/gh.log" && grep -q -- "--repo yetone/magpie" "$I/gh.log" \
  && pass "按摘要、按官方仓库校验" || fail "gh 参数不对：$(cat "$I/gh.log")"
case "$(cat "$I/updater/spool/state/magpie.json")" in *'"verification": "attested"'*) pass "magpie.json 记 attested" ;; *) fail "没记 attested" ;; esac
reset_install
printf '#!/bin/bash\necho "Error: no matching attestations" >&2\nexit 1\n' > "$I/bin/gh"; chmod +x "$I/bin/gh"
r=$(run_install)
case "$r" in "2|"*"签名校验没有通过"*"::result:: failed"*) pass "签名校验不过 → 失败" ;; *) fail "签名校验不过没拦：$r" ;; esac
grep -q "up -d" "$I/docker.log" && fail "校验不过还启动了" || pass "校验不过时没有 up -d"

# 4f. required 且没有校验工具：不装
reset_install
r=$(run_install MAGPIE_VERIFY=required)
case "$r" in "2|"*"做不了签名校验"*) pass "MAGPIE_VERIFY=required 无工具 → 不装" ;; *) fail "required 没生效：$r" ;; esac

# 4g. 健康检查不过：停掉容器、留目录；修好后重试直接成功，密钥不变
reset_install
r=$(run_install FAKE_HTTP=000)
case "$r" in "2|"*"没有响应"*"可以直接重试"*) pass "健康检查不过 → 带原因的失败" ;; *) fail "健康检查失败信息不对：$r" ;; esac
case "$r" in *"magpie: listening"*) pass "失败时把容器日志尾巴带进任务日志" ;; *) fail "缺容器日志：$r" ;; esac
[ ! -f "$I/running" ] && pass "失败后容器已停掉" || fail "失败后容器还在"
[ ! -f "$I/updater/spool/state/magpie-web.key" ] && pass "没装好不交密钥" || fail "没装好就交了密钥"
key1=$(sed -n 's/^MAGPIE_WEB_KEY=//p' "$I/magpie/private/magpie.env")
r=$(run_install)
case "$r" in "0|"*"::step:: verify"*"::result:: succeeded"*) pass "重试接着安装并成功" ;; *) fail "重试没成功：$r" ;; esac
[ "$(sed -n 's/^MAGPIE_WEB_KEY=//p' "$I/magpie/private/magpie.env")" = "$key1" ] && pass "重试沿用同一把密钥" || fail "重试换了密钥"

# 4h. 别人自己装的 Magpie（有容器、没有 compose、没有标记）：不去动它
reset_install; touch "$I/running"
r=$(run_install)
case "$r" in "2|"*"找不到 Magpie 的 compose 文件"*) pass "外部 Magpie → 照旧报错，不覆盖" ;; *) fail "外部 Magpie 被动了：$r" ;; esac
[ ! -e "$I/magpie" ] && pass "外部 Magpie 时不建目录" || fail "外部 Magpie 时建了目录"

# 4i. --check：新脚本报 installable，旧更新程序没有模板时不报
reset_install
env CHISABOT_UPDATER_DIR="$I/updater" MAGPIE_DIR="$I/magpie" FAKE_DIR="$I" PATH="$I/bin:$BASE" bash "$HERE/magpie.sh" --check >/dev/null 2>&1
case "$(cat "$I/updater/spool/state/magpie.json")" in *'"installed": false'*'"installable": true'*) pass "--check 报 installable" ;; *) fail "--check 没报 installable" ;; esac
env CHISABOT_UPDATER_DIR="$I/updater" MAGPIE_DIR="$I/magpie" MAGPIE_TEMPLATE="$I/none.yaml" FAKE_DIR="$I" PATH="$I/bin:$BASE" bash "$HERE/magpie.sh" --check >/dev/null 2>&1
case "$(cat "$I/updater/spool/state/magpie.json")" in *installable*) fail "没有模板却报了 installable" ;; *) pass "没有模板时不报 installable" ;; esac

[ "$FAIL" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
