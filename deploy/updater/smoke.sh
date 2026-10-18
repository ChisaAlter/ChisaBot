#!/bin/sh
# 管理员自检（docs/admin-smoke.md）：一次真实的模型往返，不建对话、不写消息。
# 用法：smoke.sh [机器人 id]     通过时退出码 0，否则 1。
set -u
. /opt/chisabot-updater/config.env
# CR-P1-02：网关模式下本机管理员接口要带 X-ChisaBot-Local-Caller（= CHISABOT_GATEWAY_SECRET）。
LOCAL_CALLER=""
if [ -f "${COMPOSE_DIR}/.env" ]; then
  LOCAL_CALLER=$(grep -E '^[[:space:]]*CHISABOT_GATEWAY_SECRET=' "${COMPOSE_DIR}/.env" | head -1 | sed 's/^[^=]*=//' | tr -d '\r' | sed 's/^["'\'']//;s/["'\'']$//')
fi
if [ -n "${1:-}" ]; then BODY="{\"agentId\":\"$(printf '%s' "$1" | tr -cd 'A-Za-z0-9._:-')\"}"; else BODY='{}'; fi
if [ -n "${LOCAL_CALLER}" ]; then
  OUT=$(curl -s --max-time 60 -X POST -H 'content-type: application/json' -H "X-ChisaBot-Local-Caller: ${LOCAL_CALLER}" -d "$BODY" "$LOCAL_URL/api/admin/smoke")
else
  OUT=$(curl -s --max-time 60 -X POST -H 'content-type: application/json' -d "$BODY" "$LOCAL_URL/api/admin/smoke")
fi
echo "$OUT"
echo "$OUT" | grep -q '"ok":true' && echo "$OUT" | grep -q '"persisted":false'
