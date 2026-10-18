#!/bin/sh
# 在宿主机上排一个更新请求（和 管理后台 → 系统更新 的按钮走同一个队列；docs/online-update.md）。
# 进度、日志、历史都会出现在页面上，也写进 audit.log。手动直接运行 update.sh 的话页面看不到。
#
#   request.sh check                  从 GitHub 拉 main，刷新「待更新提交」
#   request.sh update [--full]        更新到本机镜像 main 的最新提交；依赖变了自动完整构建，--full 强制完整构建
#   request.sh rollback               回滚到上一版
#   request.sh status                 打印当前任务（步骤、最后几行日志）
#   request.sh smoke                  跑部署后烟雾（含 Local-Caller；不排队更新）
#
# 环境变量 ACTOR=<名字> 写进历史（默认 host:<用户>）。
set -eu
U=/opt/chisabot-updater
REQ="$U/spool/requests"
STATE="$U/spool/state/state.json"
ACTION=${1:-}
MODE=""
[ "${2:-}" = "--full" ] && MODE=full
case "$ACTION" in
  check|update|rollback) ;;
  smoke)
    EXPECT=""
    . "$U/config.env"
    # TAG optional: pass current buildId when known
    bash "$U/post-deploy-smoke.sh" ${2:-}
    exit $?
    ;;
  status)
    PY=$(command -v python3 || command -v python2 || echo false)
    "$PY" - "$STATE" <<'PY' 2>/dev/null || cat "$STATE"
from __future__ import print_function
import json, sys
s = json.load(open(sys.argv[1]))
j = s.get("job") or {}
print("current:", (s.get("current") or {}).get("image"), "| behind:", s.get("behind"), "| needs full:", s.get("depsChanged"))
print("job:", j.get("id"), j.get("action"), j.get("mode"), j.get("status"), "step:", j.get("step"), j.get("error") or "")
for line in (j.get("log") or [])[-12:]:
    print("  ", line)
PY
    exit 0 ;;
  *) echo "用法：$0 check | update [--full] | rollback | status | smoke" >&2; exit 64 ;;
esac
ID="$ACTION-host-$(date -u +%Y%m%d%H%M%S)"
ACTOR=$(printf %s "${ACTOR:-host:$(id -un)}" | tr -cd "A-Za-z0-9_.:@-" | cut -c1-60)
EXPECT=""
if [ "$ACTION" = update ]; then
  EXPECT=$(git --git-dir="$U/mirror.git" rev-parse refs/heads/main)
fi
TMP="$REQ/.$ID.tmp"
printf '{"id":"%s","action":"%s","actor":"%s"%s%s}\n' "$ID" "$ACTION" "$ACTOR" \
  "${EXPECT:+,\"expectCommit\":\"$EXPECT\"}" "${MODE:+,\"mode\":\"$MODE\"}" > "$TMP"
chown 1002:1002 "$TMP" 2>/dev/null || true
mv "$TMP" "$REQ/$ID.json"
echo "已排队 $ID（$ACTION${MODE:+ $MODE}）。看进度：$0 status，或打开 管理后台 → 系统更新"
