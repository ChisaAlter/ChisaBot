#!/bin/bash
# CB-100：从应用容器里按 CHISABOT_HERMES_URL 真的连一次 Hermes 桥接（docs/online-update.md）。
#
# v0.1.75 改名后 compose 默认网络被重建到别的子网，宿主机上的 Hermes 桥接（绑在旧网关 172.19.0.1:4100）
# 从容器里连不上了，但部署后的自检只直连模型、绕过 Hermes，发布照样「通过」，所有对话卡在「思考中」。
# 这里从容器的网络命名空间里发一个 HTTP 请求：任意 HTTP 状态都算连得上（握手成功），连接失败才算不可达。
#
# 用法：hermes-reach.sh            输出一行 "hermes=ok|unreachable|skipped ..."；不可达时退出 1。
# 环境：读 /opt/chisabot-updater/config.env 的 CONTAINER；容器里没有配置 CHISABOT_HERMES_URL 时跳过（退出 0）。
set -uo pipefail
. /opt/chisabot-updater/config.env
TIMEOUT_MS=${HERMES_REACH_TIMEOUT_MS:-5000}

# s6 把容器环境写在 /run/s6/container_environment（update.sh 取 DATABASE_URL 也是这样）；兜底用 printenv。
URL=$(docker exec "$CONTAINER" sh -c 'cat /run/s6/container_environment/CHISABOT_HERMES_URL 2>/dev/null || printenv CHISABOT_HERMES_URL 2>/dev/null' 2>/dev/null | tr -d '\r\n')
if [ -z "$URL" ]; then
  echo "hermes=skipped（容器里没有配置 CHISABOT_HERMES_URL）"
  exit 0
fi
case "$URL" in
  http://*|https://*) ;;
  *) echo "::error:: hermes=unreachable CHISABOT_HERMES_URL 不是 http(s) 地址：$URL"; exit 1 ;;
esac

# 用镜像里一定有的 bun 发请求（镜像不保证有 curl）。URL 作为参数传进去，不拼进脚本。
OUT=$(docker exec "$CONTAINER" bun -e '
const url = process.argv.at(-2), ms = Number(process.argv.at(-1));
try {
  const r = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(ms) });
  console.log("status=" + r.status);
} catch (e) {
  const code = e?.code ?? e?.cause?.code ?? e?.name ?? "Error";
  console.log("error=" + code + ": " + String(e?.message ?? e).slice(0, 200));
  process.exit(2);
}' "$URL" "$TIMEOUT_MS" 2>&1)
CODE=$?
if [ "$CODE" = 0 ] && printf '%s' "$OUT" | grep -q '^status='; then
  echo "hermes=ok $URL → HTTP ${OUT#status=}"
  exit 0
fi
echo "::error:: hermes=unreachable 应用容器 $CONTAINER 连不上 Hermes：$URL（${OUT:-无输出}）"
echo "  检查：hermes-acp-bridge 的 ACP_BRIDGE_HOST、.env 的 CHISABOT_HERMES_URL / AGENT_ENDPOINT_ALLOWED_HOSTS、ufw 规则，"
echo "  是否都和 compose 默认网络的网关一致（默认 openbot-zh_default 172.19.0.0/16，网关 172.19.0.1）。"
exit 1
