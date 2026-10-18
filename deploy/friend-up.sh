#!/bin/sh
# ChisaBot 好友一键 compose（Track D / PRD-P2-04）
# 安全默认：loopback 绑定、遥测关、单用户不配公网 TRUSTED_ORIGINS、密钥自动生成。
# 公网分享请继续配 deploy/public HTTPS 网关；不要把 :3001 直接暴露到公网。
set -eu
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
die() { printf 'friend-up: %s\n' "$*" >&2; exit 1; }

env_value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | tr -d '\r"\047'; }

# 1) .env：没有就从好友模板拷；已有则只补空密钥。
if ! test -f .env; then
  test -f friend.env.example || die "missing deploy/friend.env.example"
  cp friend.env.example .env
  chmod 600 .env
  say "已从 friend.env.example 创建 deploy/.env（权限 600）"
fi

# 2) 空 KEY_ENCRYPTION_KEY / CHISABOT_GATEWAY_SECRET 生成随机值（不打印）。
fill_secret() {
  name=$1
  min=${2:-32}
  cur=$(env_value "$name")
  if [ -n "$cur" ]; then return 0; fi
  val=$(openssl rand -hex 32)
  if grep -q "^${name}=" .env; then
    sed -i "s#^${name}=.*#${name}=${val}#" .env
  else
    printf '%s=%s\n' "$name" "$val" >> .env
  fi
  say "已生成空字段 ${name}（${#val} hex chars，≥${min}）"
}
command -v openssl >/dev/null 2>&1 || die "需要 openssl 生成密钥"
fill_secret KEY_ENCRYPTION_KEY 32
# 域名已填或用户想开多账号时预生成网关密钥（仍可不启用 accounts UI）
if [ -n "$(env_value CHISABOT_DOMAIN)" ] || [ "$(env_value CHISABOT_ACCOUNTS_UI)" = "1" ] || [ "$(env_value CHISABOT_ACCOUNTS_UI)" = "true" ]; then
  fill_secret CHISABOT_GATEWAY_SECRET 32
fi

# 3) 安全默认硬检查：TRUSTED_ORIGINS 仅 loopback http；compose 端口必须是 127.0.0.1（deny-by-default）。
origins=$(env_value TRUSTED_ORIGINS)
[ -n "$origins" ] || die "TRUSTED_ORIGINS 为空；好友包要求 http://localhost:3001,http://127.0.0.1:3001"
old_ifs=$IFS
IFS=,
for origin in $origins; do
  origin=$(printf '%s' "$origin" | tr -d ' \r')
  [ -n "$origin" ] || continue
  case "$origin" in
    https://*)
      die "OPENBOT_SINGLE_USER 下 TRUSTED_ORIGINS 不能含 https；公网请走 deploy/public 网关：$origin"
      ;;
    http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*)
      ;;
    *)
      die "TRUSTED_ORIGINS 条目必须是 loopback http（localhost / 127.0.0.1），拒绝：$origin"
      ;;
  esac
done
IFS=$old_ifs
check_compose_loopback() {
  f=$1
  test -f "$f" || return 0
  if grep -E '^[[:space:]]*-[[:space:]]*"?0\.0\.0\.0:' "$f" >/dev/null 2>&1; then
    die "$f 把端口绑到 0.0.0.0：内部口 deny-by-default，请绑 127.0.0.1。"
  fi
  if grep -E '^[[:space:]]*-[[:space:]]*"?[0-9]+:[0-9]+("|$|/)' "$f" >/dev/null 2>&1; then
    die "$f 含无主机绑定的端口发布（如 3001:3001）；必须写成 127.0.0.1:端口:端口。"
  fi
}
check_compose_loopback compose.yaml
check_compose_loopback magpie.compose.yaml
if ! grep -E '127\.0\.0\.1:3001:3001' compose.yaml >/dev/null 2>&1; then
  die "compose.yaml 未把应用绑在 127.0.0.1:3001；好友包要求 loopback。"
fi

# 4) 前端产物
if ! test -f ../app/dist/index.html; then
  say "构建前端…"
  (cd .. && TENANT_PACKAGE_DIR=../examples/zh-CN bun run --cwd app build) || die "前端构建失败"
fi

# 5) 启动（复用 start.sh：装更新器、建 magpie 网、up）
say "启动 ChisaBot（安全默认）…"
sh ./start.sh

say ""
say "—— 好友包已起来 ——"
say "本机：http://127.0.0.1:3001 （仅 loopback）"
if [ -n "$(env_value CHISABOT_DOMAIN)" ]; then
  say "公网：配好证书后在 deploy/public 执行 render-nginx.sh + compose up（见 docs/friend-deploy.md）"
  say "       https://$(env_value CHISABOT_DOMAIN):$(env_value CHISABOT_HTTPS_PORT)"
else
  say "下一步公网：在 .env 填 CHISABOT_DOMAIN，按 docs/friend-deploy.md 开 HTTPS 网关。"
fi
say "分享给朋友（多账号）：.env 设 CHISABOT_ACCOUNTS_UI=1，网关 config.json 设 invites:true + identitySecret=网关密钥；见 docs/accounts.md"
say "电车类定时默认保持暂停；不要 resume。"
