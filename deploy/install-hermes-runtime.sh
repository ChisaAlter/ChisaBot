#!/bin/bash
# Install this checkout's adapter against the Hermes already installed on the server.
# No Hermes download, dependency install, or local-PC startup is performed.
set -euo pipefail
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE=$(dirname "$HERE")
RUNTIME=${CHISABOT_HERMES_RUNTIME_HOME:-/opt/hermes/chisabot-runtime}
HERMES_SOURCE=${HERMES_SOURCE_DIR:-/opt/hermes/hermes-agent}
HERMES_VENV=${HERMES_VENV_DIR:-/opt/hermes/venv}
STATE=${CHISABOT_HERMES_STATE_HOME:-/var/lib/chisabot-hermes}
BUN=${BUN_BIN:-/usr/local/bin/bun}
BIND=${ACP_BRIDGE_HOST:-172.19.0.1}
PORT=${ACP_BRIDGE_PORT:-4100}
USER_NAME=chisabot-hermes
CHECK_ONLY=0
PREPARE_ONLY=0
case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  --prepare) PREPARE_ONLY=1 ;;
  '') ;;
  *) echo 'Usage: install-hermes-runtime.sh [--check|--prepare]' >&2; exit 1 ;;
esac
[ "$(id -u)" = 0 ] || { echo 'Run this installer on the server as root.' >&2; exit 1; }
[ -f "$HERMES_SOURCE/run_agent.py" ] && [ -x "$HERMES_VENV/bin/python" ] && [ -x "$BUN" ] || { echo 'The existing server Hermes source, venv or Bun was not found.' >&2; exit 1; }
[ -f "$SOURCE/examples/hermes-agent/chisabot_acp.py" ] && [ -f "$SOURCE/examples/acp-agent/bridge.mjs" ] || { echo 'The checkout is missing the Hermes runtime adapter.' >&2; exit 1; }
HERMES_SOURCE_DIR="$HERMES_SOURCE" HERMES_DISABLE_LAZY_INSTALLS=1 "$HERMES_VENV/bin/python" -B "$SOURCE/examples/hermes-agent/chisabot_acp.py" --check
[ "$CHECK_ONLY" = 0 ] || exit 0

getent passwd "$USER_NAME" >/dev/null || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin "$USER_NAME"
install -d -m 0755 "$RUNTIME" "$RUNTIME/acp-agent" "$RUNTIME/hermes-agent"
install -m 0644 "$SOURCE/examples/acp-agent/bridge.mjs" "$RUNTIME/acp-agent/bridge.mjs"
install -m 0644 "$SOURCE/examples/hermes-agent/chisabot_acp.py" "$SOURCE/examples/hermes-agent/chisabot_protocol.py" "$RUNTIME/hermes-agent/"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "$STATE" "$STATE/workspace" "$STATE/hermes"

# uv's existing interpreter is often under /root. Copy the same interpreter distribution
# to a service-readable path; keep the existing venv and all its packages read-only.
PY_REAL=$(readlink -f "$HERMES_VENV/bin/python")
PY_ROOT=$(dirname "$(dirname "$PY_REAL")")
if [[ "$PY_REAL" = /root/* ]]; then
  PY_NAME=$(basename "$PY_ROOT")
  PY_TARGET="/opt/hermes/$PY_NAME"
  if [ ! -x "$PY_TARGET/bin/$(basename "$PY_REAL")" ]; then
    cp -a --reflink=auto "$PY_ROOT" "$PY_TARGET"
    chmod -R a+rX "$PY_TARGET"
  fi
  PY_REAL="$PY_TARGET/bin/$(basename "$PY_REAL")"
fi
SITE=$($HERMES_VENV/bin/python -B -c 'import sysconfig; print(sysconfig.get_path("purelib"))')

CONFIG_SOURCE=${HERMES_CONFIG_SOURCE:-/root/.hermes}
if [ ! -f "$STATE/hermes/config.yaml" ]; then
  [ -f "$CONFIG_SOURCE/config.yaml" ] || { echo 'The existing Hermes provider config is missing.' >&2; exit 1; }
  install -o "$USER_NAME" -g "$USER_NAME" -m 0600 "$CONFIG_SOURCE/config.yaml" "$STATE/hermes/config.yaml"
  [ ! -f "$CONFIG_SOURCE/.env" ] || install -o "$USER_NAME" -g "$USER_NAME" -m 0600 "$CONFIG_SOURCE/.env" "$STATE/hermes/.env"
fi
if [ ! -f "$STATE/bridge.env" ]; then
  TOKEN=$($HERMES_VENV/bin/python -B -c 'import secrets; print(secrets.token_urlsafe(48))')
  umask 077
  printf 'ACP_BRIDGE_TOKEN=%s\n' "$TOKEN" > "$STATE/bridge.env"
  chown root:root "$STATE/bridge.env"
fi

# Paths with whitespace or shell quotes are deliberately unsupported in the service config.
for value in "$RUNTIME" "$HERMES_SOURCE" "$STATE" "$PY_REAL" "$SITE" "$BUN" "$BIND" "$PORT"; do
  [[ "$value" != *[[:space:]\"\']* ]] || { echo 'Service paths must not contain whitespace or quotes.' >&2; exit 1; }
done
# Prepare can run while the current release serves traffic. Check the dedicated service
# user's real interpreter/venv combination as well as root's import environment.
runuser -u "$USER_NAME" -- env HOME="$STATE" HERMES_HOME="$STATE/hermes" \
  HERMES_SOURCE_DIR="$HERMES_SOURCE" PYTHONPATH="$SITE" HERMES_DISABLE_LAZY_INSTALLS=1 \
  PYTHONDONTWRITEBYTECODE=1 "$PY_REAL" -B "$RUNTIME/hermes-agent/chisabot_acp.py" --check
if [ "$PREPARE_ONLY" = 1 ]; then
  echo 'Hermes release prepared; the existing service has not been restarted.'
  exit 0
fi
cat > /etc/systemd/system/hermes-acp-bridge.service <<EOF
[Unit]
Description=ChisaBot Hermes runtime with governed host tools
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
EnvironmentFile=$STATE/bridge.env
Environment=HOME=$STATE
Environment=HERMES_HOME=$STATE/hermes
Environment=HERMES_SOURCE_DIR=$HERMES_SOURCE
Environment=PYTHONPATH=$SITE
Environment=HERMES_DISABLE_LAZY_INSTALLS=1
Environment=PYTHONDONTWRITEBYTECODE=1
Environment="ACP_AGENT_CMD=$PY_REAL -B $RUNTIME/hermes-agent/chisabot_acp.py"
Environment=ACP_CWD=$STATE/workspace
Environment=ACP_BRIDGE_HOST=$BIND
Environment=ACP_BRIDGE_PORT=$PORT
Environment=ACP_REQUIRE_HOST_CONTEXT=1
Environment=ACP_STATE_PATH=$STATE/bridge-state.json
Environment=ACP_APPROVAL=deny
ExecStart=$BUN $RUNTIME/acp-agent/bridge.mjs
WorkingDirectory=$STATE
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$STATE
RestrictSUIDSGID=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable hermes-acp-bridge.service >/dev/null
systemctl restart hermes-acp-bridge.service

# Authenticated readiness initializes ACP without submitting a model prompt or creating a session.
export READY_URL="http://$BIND:$PORT/ready" TOKEN_FILE="$STATE/bridge.env"
"$HERMES_VENV/bin/python" -B - <<'PY'
import json, os, time, urllib.request
with open(os.environ['TOKEN_FILE']) as handle:
    token = next(row.split('=', 1)[1].strip() for row in handle if row.startswith('ACP_BRIDGE_TOKEN='))
for attempt in range(30):
    try:
        request = urllib.request.Request(os.environ['READY_URL'], method='POST', headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=40) as response:
            data = json.load(response)
        if data.get('ok') and data.get('hostTools') and data.get('persistentState'):
            print('Hermes runtime ready: authenticated host tools, persistent run ledger, dedicated service user')
            break
    except Exception:
        pass
    time.sleep(1)
else:
    raise SystemExit('Hermes runtime readiness failed; inspect the service without printing its credentials')
PY

echo 'Bridge credential remains in the server-only bridge.env file; configure ChisaBot with the same token and a reachable tool gateway URL.'
