#!/bin/sh
set -eu

gateway=chisabot-public-gateway
if [ "$(docker inspect --format '{{.State.Running}}' "$gateway" 2>/dev/null || true)" != true ]; then
    echo 'ChisaBot gateway is not running; certificate reload skipped.'
    exit 0
fi

# Invalid/missing renewed certificates must never replace the running workers.
docker exec "$gateway" nginx -t
docker exec "$gateway" nginx -s reload
