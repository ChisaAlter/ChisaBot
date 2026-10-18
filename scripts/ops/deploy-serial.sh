#!/bin/sh
# 并行开发时的串行部署（在部署宿主机上以 root 运行）：
#   sh deploy-serial.sh <期望的 main 提交前缀> [WHO]
# - flock /run/cb-deploy.lock：同一时间只一个人 / worker 部署（拿不到锁就排队，最多 40 分钟）
# - 等 updater 没有在跑的任务、没有排队的请求、线程锁 = 0
# - request.sh check → 确认本机镜像仓库的 main 包含期望提交 → request.sh update → 等完成
# - 打印最终 status；退出码 0 = 期望提交已上线
# 说明见 docs/ops/deploy.md。只走 updater 队列，从不直接调用 update.sh。
set -u
WANT=${1:?commit prefix}; WHO=${2:-hark-worker}
U=${CHISABOT_UPDATER_DIR:-/opt/chisabot-updater}
APP=${CHISABOT_APP_CONTAINER:-openbot-zh}
exec 9>/run/cb-deploy.lock
flock -w 2400 9 || { echo "DEPLOY-LOCK TIMEOUT"; exit 3; }
echo "[$(date -u +%T)] lock held by $WHO for $WANT"
st() { python3 -c "import json;j=(json.load(open('$U/spool/state/state.json')).get('job') or {});print(j.get('status') or '')" 2>/dev/null; }
busy() { s=$(st); [ "$s" = running ] || [ "$s" = queued ] || ls $U/spool/requests/*.json >/dev/null 2>&1; }
locks() { echo "select count(*) from openbot_local_threads where lock_expires_at > now()" | docker exec -i "$APP" sh -c 'export PGPASSWORD=$(cat /var/lib/postgresql/pgpassword); psql -h 127.0.0.1 -U openbot openbot -At'; }
for i in $(seq 1 240); do busy || break; sleep 10; done
for i in $(seq 1 120); do [ "$(locks)" = 0 ] && break; sleep 10; done
[ "$(locks)" = 0 ] || { echo "THREAD LOCKS STILL >0, giving up"; exit 4; }
ACTOR=$WHO sh $U/request.sh check; sleep 5
for i in $(seq 1 60); do busy || break; sleep 5; done
HEAD=$(git --git-dir=$U/mirror.git rev-parse refs/heads/main)
case "$HEAD" in $WANT*) ;; *) echo "mirror main $HEAD != wanted $WANT (someone merged after you?) — deploying mirror head only if it contains wanted"; git --git-dir=$U/mirror.git merge-base --is-ancestor $WANT $HEAD || { echo "WANTED NOT IN MAIN"; exit 5; } ;; esac
ACTOR=$WHO sh $U/request.sh update; sleep 8
for i in $(seq 1 180); do busy || break; sleep 10; done
sh $U/request.sh status
docker ps --format '{{.Image}}' --filter name=^$APP\$ | grep -q "$(echo $HEAD | cut -c1-7)" || { echo "NOT DEPLOYED"; exit 6; }
# v0.1.34: nginx template sync — never silent-drift Local-Caller clears.
# Default: --check live conf (apply-or-fail). Set CHISABOT_SYNC_NGINX=apply to render+reload from repo template.
SYNC_NGINX=${CHISABOT_SYNC_NGINX:-check}
REPO_OPS=${CHISABOT_REPO_OPS:-}
if [ -z "$REPO_OPS" ]; then
  for cand in /opt/chisabot-ops /opt/openbot-zh/../ChisaBot/repo /opt/chisabot-src; do
    if [ -f "$cand/scripts/ops/sync-nginx.sh" ]; then REPO_OPS=$cand; break; fi
  done
fi
# Also try alongside this script (when deploy-serial lives in repo checkout)
HERE_OPS=$(CDPATH= cd -- "$(dirname "$0")/../.." 2>/dev/null && pwd || true)
if [ -z "$REPO_OPS" ] && [ -n "$HERE_OPS" ] && [ -f "$HERE_OPS/scripts/ops/sync-nginx.sh" ]; then
  REPO_OPS=$HERE_OPS
fi
if [ -n "$REPO_OPS" ] && [ -f "$REPO_OPS/scripts/ops/sync-nginx.sh" ]; then
  case "$SYNC_NGINX" in
    apply|1|yes)
      echo "[$(date -u +%T)] sync-nginx --apply"
      sh "$REPO_OPS/scripts/ops/sync-nginx.sh" --apply || { echo "NGINX SYNC APPLY FAILED"; exit 7; }
      ;;
    skip|0|no) echo "[$(date -u +%T)] sync-nginx skipped (CHISABOT_SYNC_NGINX=$SYNC_NGINX)" ;;
    *)
      echo "[$(date -u +%T)] sync-nginx --check"
      sh "$REPO_OPS/scripts/ops/sync-nginx.sh" --check || { echo "NGINX DRIFT — run: CHISABOT_SYNC_NGINX=apply sh deploy-serial … or sh scripts/ops/sync-nginx.sh --apply"; exit 7; }
      ;;
  esac
else
  echo "[$(date -u +%T)] sync-nginx script not found — skipped (install repo ops scripts on host)"
fi

# v0.1.39: Magpie/sidecar -> app:3001 isolation (PRD-P0-02). apply-or-fail + live verify.
# Set CHISABOT_ISOLATE_SIDECAR=skip to skip (not recommended on Haupt).
ISOLATE=${CHISABOT_ISOLATE_SIDECAR:-apply}
ISO_SH=""
for cand in "$REPO_OPS/scripts/ops/isolate-sidecar-app.sh" /opt/chisabot-ops/isolate-sidecar-app.sh "$HERE_OPS/scripts/ops/isolate-sidecar-app.sh"; do
  if [ -n "$cand" ] && [ -f "$cand" ]; then ISO_SH=$cand; break; fi
done
# Prefer copy into /opt/chisabot-ops when we have a repo script (durable across updater rebuilds of app image)
if [ -n "$ISO_SH" ] && [ -d /opt/chisabot-ops ]; then
  dest=/opt/chisabot-ops/isolate-sidecar-app.sh
  if [ "$ISO_SH" != "$dest" ]; then
    cp -f "$ISO_SH" "$dest"
  fi
  chmod +x "$dest"
  ISO_SH=$dest
  if [ -f "$REPO_OPS/deploy/magpie-isolate.service" ] || [ -f /opt/chisabot-src/deploy/magpie-isolate.service ]; then
    unit=${REPO_OPS:+$REPO_OPS/deploy/magpie-isolate.service}
    [ -f "$unit" ] || unit=/opt/chisabot-src/deploy/magpie-isolate.service
    if [ -f "$unit" ] && command -v systemctl >/dev/null 2>&1; then
      cp -f "$unit" /etc/systemd/system/chisabot-magpie-isolate.service
      systemctl daemon-reload
      systemctl enable chisabot-magpie-isolate.service >/dev/null 2>&1 || true
    fi
  fi
fi
if [ -n "$ISO_SH" ]; then
  case "$ISOLATE" in
    skip|0|no) echo "[$(date -u +%T)] isolate-sidecar skipped (CHISABOT_ISOLATE_SIDECAR=$ISOLATE)" ;;
    *)
      echo "[$(date -u +%T)] isolate-sidecar --apply + --verify"
      sh "$ISO_SH" --apply || { echo "SIDECAR ISOLATE APPLY FAILED"; exit 8; }
      sh "$ISO_SH" --verify || { echo "SIDECAR ISOLATE VERIFY FAILED (Magpie still reaches app, or App->Magpie broken)"; exit 8; }
      ;;
  esac
else
  echo "[$(date -u +%T)] isolate-sidecar-app.sh not found — skipped (install scripts/ops on host)"
fi
echo "DEPLOYED $HEAD"; exit 0
