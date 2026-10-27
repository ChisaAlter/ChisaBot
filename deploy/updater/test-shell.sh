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

[ "$FAIL" = 0 ] && echo "全部通过" || { echo "有失败"; exit 1; }
