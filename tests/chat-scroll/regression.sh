#!/bin/sh
# 聊天滚动回归（DESIGN.md §35.4、§42.7）：send-jump.mjs 与 bounce-regression.mjs 的必过场景，任何一项不过退出码 1。
# 用法：
#   BASE=… BOT=… THREAD=… [NODE=node] [CASES="wide narrow …"] sh tests/chat-scroll/regression.sh
#   或仅传 DIST=app/dist（默认）直接跑离线多阶段流式 + 虚拟化 + 上滑零弹跳回归。
D=$(dirname "$0")
N=${NODE:-node}
DIST=${DIST:-app/dist}
CASES=${CASES:-"wide narrow failtwice narrowfail polltick narrowpoll up"}
fail=0
if [ -n "$BASE" ]; then
  for c in $CASES; do
    case $c in
      wide) set -- ;;
      narrow) set -- W=420 H=860 ;;
      failtwice) set -- FAIL=1 TWICE=1 ;;
      narrowfail) set -- W=420 H=860 FAIL=1 TWICE=1 ;;
      polltick) set -- POLLTICK=1 TWICE=1 ;;
      narrowpoll) set -- W=420 H=860 POLLTICK=1 TWICE=1 ;;
      up) set -- SCROLLUP=700 ;;
      *) echo "unknown case $c"; fail=1; continue ;;
    esac
    if env ASSERT=1 TAG="$c" "$@" "$N" "$D/send-jump.mjs" > "/tmp/send-jump-$c.log" 2>&1; then echo "PASS $c"; else echo "FAIL $c (/tmp/send-jump-$c.log)"; fail=1; fi
    grep -E "SCREENJUMPS|REMOVED|POLLTICK|PASS send|FAIL send" "/tmp/send-jump-$c.log" | cut -c1-400
  done
fi
if [ -f "$DIST/index.html" ]; then
  if "$N" "$D/bounce-regression.mjs" --dist "$DIST"; then
    echo "PASS bounce-regression"
  else
    echo "FAIL bounce-regression"
    fail=1
  fi
elif [ -z "$BASE" ]; then
  echo "missing BASE and $DIST/index.html"
  fail=1
fi
exit $fail
