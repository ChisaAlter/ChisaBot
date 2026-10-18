#!/bin/bash
# 健康检查（docs/online-update.md）：容器 healthy、没有重启、本机 /health 200、公网登录页 200（PUBLIC_HEALTH_URL 为空或是示例域名时跳过），
# 给了构建号时 /api/version 必须是这一版。用法：health.sh <镜像> [构建号]
set -uo pipefail
. /opt/chisabot-updater/config.env
U=${CHISABOT_UPDATER_HOME:-/opt/chisabot-updater}
# CR-P1-02：网关模式下本机管理员接口要带 X-ChisaBot-Local-Caller。
LOCAL_CALLER=""
if [ -f "${COMPOSE_DIR}/.env" ]; then
  LOCAL_CALLER=$(grep -E '^[[:space:]]*CHISABOT_GATEWAY_SECRET=' "${COMPOSE_DIR}/.env" | head -1 | sed 's/^[^=]*=//' | tr -d '\r' | sed 's/^["'\'']//;s/["'\'']$//')
fi
HDR_CALLER=()
if [ -n "${LOCAL_CALLER}" ]; then HDR_CALLER=(-H "X-ChisaBot-Local-Caller: ${LOCAL_CALLER}"); fi
IMAGE="$1" TAG="${2:-}"
for i in $(seq 1 36); do
  H=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)
  [ "$H" = healthy ] && break
  sleep 5
done
IMG=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null)
echo "容器 $H，镜像 $IMG"
[ "$H" = healthy ] && [ "$IMG" = "$IMAGE" ] || { echo "容器不健康或镜像不对"; exit 1; }
R0=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER")
sleep 20
R1=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER")
H=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER")
[ "$R0" = "$R1" ] && [ "$H" = healthy ] || { echo "20 秒内重启过（$R0 → $R1）或不再健康（$H）"; exit 1; }
C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$LOCAL_URL/health")
echo "本机 /health $C"
[ "$C" = 200 ] || exit 1
case "${PUBLIC_HEALTH_URL:-}" in
  "")
    echo "PUBLIC_HEALTH_URL 没有配置：跳过公网登录页检查（配好 HTTPS 网关后在 /opt/chisabot-updater/config.env 填上）" ;;
  *chisabot.example.com*)
    echo "PUBLIC_HEALTH_URL 还是示例域名 chisabot.example.com：跳过公网登录页检查（改成自己的 https://<域名>:<端口>/login）" ;;
  *)
    P=$(curl -ks -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_HEALTH_URL")
    echo "公网 $PUBLIC_HEALTH_URL $P"
    [ "$P" = 200 ] || exit 1 ;;
esac
if [ -n "$TAG" ]; then
  V=$(curl -s --max-time 10 "$LOCAL_URL/api/version")
  echo "/api/version $V"
  echo "$V" | grep -q "\"buildId\":\"$TAG\"" || { echo "/api/version 不是新构建 $TAG"; exit 1; }
fi
# 部署后硬烟雾（docs/production-checklist.md）：version / capabilities / 聚合健康。失败 → 整次健康检查失败 → 更新器回滚。
# 模型往返默认仍只告警（STRICT_MODEL_SMOKE=1 才硬失败），避免上游额度抖动误回滚。
if [ -n "$TAG" ]; then
  if [ -x "$U/post-deploy-smoke.sh" ] || [ -f "$U/post-deploy-smoke.sh" ]; then
    bash "$U/post-deploy-smoke.sh" "$TAG" || { echo "部署后烟雾失败"; exit 1; }
  else
    echo "warn: post-deploy-smoke.sh 未安装，回退到旧的模型自检（仅记录）"
    S=$(curl -s --max-time 60 -X POST -H 'content-type: application/json' "${HDR_CALLER[@]}" -d '{}' "$LOCAL_URL/api/admin/smoke" | head -c 400)
    echo "模型自检（不影响结果）$S"
  fi
fi
echo "健康检查通过"
