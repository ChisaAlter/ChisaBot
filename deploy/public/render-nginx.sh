#!/bin/sh
# 按 deploy/.env 生成网关配置 nginx.generated.conf（模板 nginx.conf 里的 chisabot.example.com、8443、2053 都是占位）。
#   CHISABOT_DOMAIN        必填，例如 chat.example.org
#   CHISABOT_HTTPS_PORT    ChisaBot 入口端口，默认 8443（Cloudflare 代理可用：443、2053、2083、2087、2096、8443）
#   CHISABOT_MAGPIE_PORT   Magpie 管理入口端口，默认 2053
#   CHISABOT_CERT_NAME     /etc/letsencrypt/live/<名字>/ 的目录名，默认等于域名
# 然后在 deploy/.env 设 CHISABOT_NGINX_CONF=./nginx.generated.conf，compose 就会挂这个文件。
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ENV_FILE=${ENV_FILE:-$HERE/../.env}
if [ -f "$ENV_FILE" ]; then
  # 只读需要的几项，不 source 整个 .env（里面有密钥）。
  for k in CHISABOT_DOMAIN CHISABOT_HTTPS_PORT CHISABOT_MAGPIE_PORT CHISABOT_CERT_NAME; do
    v=$(sed -n "s/^$k=//p" "$ENV_FILE" | tail -n 1 | tr -d '"'"'"' \r')
    [ -n "$v" ] && eval "[ -n \"\${$k:-}\" ] || $k=\$v"
  done
fi
: "${CHISABOT_DOMAIN:?在 deploy/.env 设置 CHISABOT_DOMAIN}"
P=${CHISABOT_HTTPS_PORT:-8443}
M=${CHISABOT_MAGPIE_PORT:-2053}
C=${CHISABOT_CERT_NAME:-$CHISABOT_DOMAIN}
o() { if [ "$1" = 443 ]; then printf '%s' "$CHISABOT_DOMAIN"; else printf '%s:%s' "$CHISABOT_DOMAIN" "$1"; fi; }
OP=$(o "$P"); OM=$(o "$M")
sed -e "s#/live/chisabot\.example\.com/#/live/$C/#g" \
    -e "s#chisabot\.example\.com:8443#$OP#g" \
    -e "s#chisabot\.example\.com:2053#$OM#g" \
    -e "s#listen 8443 ssl#listen $P ssl#" \
    -e "s#listen 2053 ssl#listen $M ssl#" \
    -e "s#:8443/#:$P/#g" \
    -e "s#chisabot\.example\.com#$CHISABOT_DOMAIN#g" \
    "$HERE/nginx.conf" > "$HERE/nginx.generated.conf.tmp"
mv "$HERE/nginx.generated.conf.tmp" "$HERE/nginx.generated.conf"
echo "已生成 $HERE/nginx.generated.conf：https://$OP（ChisaBot）、https://$OM（Magpie 管理）"
