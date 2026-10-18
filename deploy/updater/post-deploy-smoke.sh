#!/bin/bash
# 部署后硬烟雾（PRD-P1-03 / docs/production-checklist.md）：版本、capabilities 无密钥、
# 聚合健康面（含 Local-Caller）。失败退出非 0，给更新器健康检查用 → 失败会回滚。
# 模型往返仍走 smoke.sh（默认仅告警，不回滚；STRICT_MODEL_SMOKE=1 时一并硬失败）。
#
# 用法：post-deploy-smoke.sh [期望 buildId]
# 环境：读 /opt/chisabot-updater/config.env 的 LOCAL_URL；从 compose .env 取网关密钥。
set -uo pipefail
. /opt/chisabot-updater/config.env
EXPECT_BUILD="${1:-}"
LOCAL_CALLER=""
if [ -f "${COMPOSE_DIR}/.env" ]; then
  LOCAL_CALLER=$(grep -E '^[[:space:]]*CHISABOT_GATEWAY_SECRET=' "${COMPOSE_DIR}/.env" | head -1 | sed 's/^[^=]*=//' | tr -d '\r' | sed 's/^["'\'']//;s/["'\'']$//')
fi
HDR_CALLER=()
if [ -n "${LOCAL_CALLER}" ]; then HDR_CALLER=(-H "X-ChisaBot-Local-Caller: ${LOCAL_CALLER}"); fi

fail() { echo "::error:: post-deploy-smoke: $*"; exit 1; }
ok() { echo "post-deploy-smoke ok: $*"; }

# 1) 公开 /health
C=$(curl -s -o /tmp/cb-smoke-health.json -w '%{http_code}' --max-time 10 "$LOCAL_URL/health" || echo 000)
[ "$C" = 200 ] || fail "/health → $C"
grep -q '"status":"ok"' /tmp/cb-smoke-health.json || fail "/health body missing status=ok"
ok "/health 200"

# 2) /api/version：有 version/buildId；不泄密钥
V=$(curl -s --max-time 10 "$LOCAL_URL/api/version" || true)
echo "$V" | grep -q '"version"' || fail "/api/version missing version: $V"
echo "$V" | grep -q '"buildId"' || fail "/api/version missing buildId: $V"
echo "$V" | grep -qiE 'api[_-]?key|sk-[a-zA-Z0-9]|password|secret|DATABASE_URL|BEGIN (RSA |OPENSSH )?PRIVATE' \
  && fail "/api/version looks like it leaked a secret"
if [ -n "$EXPECT_BUILD" ]; then
  echo "$V" | grep -q "\"buildId\":\"$EXPECT_BUILD\"" || fail "/api/version buildId != $EXPECT_BUILD ($V)"
fi
ok "/api/version $V"

# 3) /api/capabilities：无密钥字段
CAP=$(curl -s --max-time 10 "$LOCAL_URL/api/capabilities" || true)
echo "$CAP" | grep -q '"mode"' || fail "/api/capabilities missing mode"
echo "$CAP" | grep -qiE 'api[_-]?key|sk-[a-zA-Z0-9]|license-token|tenant-api-key|password|DATABASE_URL' \
  && fail "/api/capabilities looks like it leaked a secret"
ok "/api/capabilities (no secrets)"

# 4) 聚合健康面（管理员 / Local-Caller）
HCODE=$(curl -s -o /tmp/cb-smoke-admin-health.json -w '%{http_code}' --max-time 20 \
  "${HDR_CALLER[@]}" "$LOCAL_URL/api/admin/health" || echo 000)
case "$HCODE" in
  200|503) ;;
  401|403)
    if [ -z "$LOCAL_CALLER" ]; then
      echo "post-deploy-smoke warn: /api/admin/health → $HCODE and no CHISABOT_GATEWAY_SECRET in compose .env (single-user without gateway?); skipping aggregate"
    else
      fail "/api/admin/health → $HCODE with Local-Caller set (gateway identity broken?)"
    fi
    ;;
  *) fail "/api/admin/health → $HCODE" ;;
esac
if [ "$HCODE" = 200 ] || [ "$HCODE" = 503 ]; then
  HBODY=$(cat /tmp/cb-smoke-admin-health.json)
  echo "aggregate health: $HBODY" | head -c 800; echo
  echo "$HBODY" | grep -q '"localCaller"' || fail "aggregate missing localCaller check"
  # Top-level ok only (nested checks.app.ok must not fool grep).
  if command -v python3 >/dev/null 2>&1; then
    echo "$HBODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("ok") is True else 1)'       || fail "aggregate health top-level ok!=true (HTTP $HCODE)"
  else
    echo "$HBODY" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true' || fail "aggregate health not ok (HTTP $HCODE)"
    # Prefer start-of-object: fragile without python — require HTTP 200 as well
    [ "$HCODE" = 200 ] || fail "aggregate health HTTP $HCODE without python parser"
  fi
  [ "$HCODE" = 200 ] || fail "aggregate health HTTP $HCODE (expected 200 when ok)"
  ok "/api/admin/health aggregate ok"
fi

# 5) 可选：模型往返（默认告警；STRICT_MODEL_SMOKE=1 硬失败）
if [ "${SKIP_MODEL_SMOKE:-0}" != 1 ]; then
  SCODE=$(curl -s -o /tmp/cb-smoke-model.json -w '%{http_code}' --max-time 60 -X POST \
    -H 'content-type: application/json' "${HDR_CALLER[@]}" -d '{}' \
    "$LOCAL_URL/api/admin/smoke" || echo 000)
  SBODY=$(cat /tmp/cb-smoke-model.json 2>/dev/null || echo "")
  echo "model smoke HTTP $SCODE: $(echo "$SBODY" | head -c 400)"
  if echo "$SBODY" | grep -q '"ok":true' && echo "$SBODY" | grep -q '"persisted":false'; then
    ok "model smoke"
  else
    echo "::error:: post-deploy-smoke: model smoke failed (HTTP $SCODE)"
    if [ "${STRICT_MODEL_SMOKE:-0}" = 1 ]; then
      fail "STRICT_MODEL_SMOKE=1 and model smoke red"
    fi
    echo "post-deploy-smoke note: model smoke is advisory (set STRICT_MODEL_SMOKE=1 to fail deploy)"
  fi
fi

echo "post-deploy-smoke PASSED"
