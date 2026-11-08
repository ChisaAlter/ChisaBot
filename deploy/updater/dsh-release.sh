#!/bin/bash
# Shared deployment contract. The same API uid, environment and durable volumes are used by health and rollback.
dsh_exec() {
  # docker exec does not inherit s6's service PATH; with-contenv itself needs execline's ifelse.
  docker exec -e PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    "$CONTAINER" /command/with-contenv "$@"
}

dsh_ops() {
  dsh_exec /command/s6-setuidgid apiuser /usr/local/bin/bun /app/deploy/dsh/ops.ts "$1"
}

dsh_available() {
  docker exec "$CONTAINER" test -f /app/deploy/dsh/ops.ts
}

dsh_external_targets_directory() {
  dsh_exec /bin/sh -c 'if [ -n "${CHISABOT_DSH_TARGETS_FILE:-}" ]; then dirname "$CHISABOT_DSH_TARGETS_FILE"; fi'
}

dsh_accounts_check() {
  local targets
  targets=$(dsh_external_targets_directory) || return 1
  if [ -z "$targets" ]; then
    [ -z "${CHISABOT_DSH_ACCOUNTS_CONFIG:-}" ] || { echo 'Account updater config set but API has no external targets.' >&2; return 1; }
    return 0
  fi
  [ -n "${CHISABOT_DSH_ACCOUNTS_CONFIG:-}" ] || { echo 'External DSH targets need CHISABOT_DSH_ACCOUNTS_CONFIG for coordinated release.' >&2; return 1; }
  "${CHISABOT_DSH_NODE:-node}" "${U:?}/accounts-release.mjs" check "$CHISABOT_DSH_ACCOUNTS_CONFIG" "$CONTAINER" "$targets"
}

dsh_accounts_replace() {
  local image=$1 targets
  dsh_accounts_check || return 1
  [ -n "${CHISABOT_DSH_ACCOUNTS_CONFIG:-}" ] || return 0
  dsh_require_compatible_image "$image" || return 1
  targets=$(dsh_external_targets_directory) || return 1
  "${CHISABOT_DSH_NODE:-node}" "${U:?}/accounts-release.mjs" replace "$CHISABOT_DSH_ACCOUNTS_CONFIG" "$CONTAINER" "$targets" "$image"
}

dsh_enabled() {
  if [ -n "${COMPOSE_DIR:-}" ] && [ -s "$COMPOSE_DIR/.dsh-reader.json" ]; then printf '1\n'
  elif dsh_available; then dsh_ops enabled
  else printf '0\n'; fi
}

dsh_hold_admission() {
  local owner=$1
  dsh_available || return 1
  dsh_exec /bin/sh -c '
    set -eu
    root=${CHISABOT_DSH_ROOT:?}
    umask 077
    (set -C; printf "%s\n" "$1" > "$root/.maintenance") || exit 1
    chown apiuser:apiuser "$root/.maintenance"
  ' -- "$owner"
}

dsh_release_admission() {
  local owner=$1
  dsh_available || return 1
  dsh_exec /bin/sh -c '
    set -eu
    marker=${CHISABOT_DSH_ROOT:?}/.maintenance
    [ -f "$marker" ] || exit 0
    [ "$(cat "$marker")" = "$1" ] || exit 1
    rm "$marker"
  ' -- "$owner"
}

dsh_readiness() {
  if dsh_available; then dsh_ops health; return $?; fi
  local kernel
  kernel=$(docker exec "$CONTAINER" sh -c 'cat /run/s6/container_environment/CHISABOT_AGENT_KERNEL 2>/dev/null || printenv CHISABOT_AGENT_KERNEL') || kernel=''
  if [ "$kernel" = dsh ]; then echo 'DSH readiness tooling is missing' >&2; return 1; fi
  return 0
}

dsh_wait_idle() {
  local waited=0 limit=${DRAIN_SECONDS:-900} count
  while :; do
    count=$(dsh_ops busy) || return 1
    [[ "$count" =~ ^[0-9]+$ ]] || return 1
    [ "$count" = 0 ] && return 0
    [ "$waited" -lt "$limit" ] || { echo 'DSH executions are still active; rollback cancelled.' >&2; return 1; }
    sleep 5
    waited=$((waited + 5))
  done
}

dsh_record_reader() {
  local enabled
  enabled=$(dsh_enabled) || return 1
  [ "$enabled" = 1 ] || return 0
  dsh_ops compatibility > "$COMPOSE_DIR/.dsh-reader.json.tmp" && chmod 0600 "$COMPOSE_DIR/.dsh-reader.json.tmp" \
    && mv "$COMPOSE_DIR/.dsh-reader.json.tmp" "$COMPOSE_DIR/.dsh-reader.json"
}

# A code rollback keeps the live database and DSH volume. Never restore a pre-release dump automatically.
dsh_require_compatible_image() {
  local target=$1 count current candidate
  if [ -n "${COMPOSE_DIR:-}" ] && [ -s "$COMPOSE_DIR/.dsh-reader.json" ]; then
    # This survives an exited/unstartable candidate container, when docker exec cannot query PG.
    current=$(cat "$COMPOSE_DIR/.dsh-reader.json") || return 1
  else
    dsh_available || return 0
    count=$(dsh_ops bindings) || return 1
    [ "$count" = 0 ] && return 0
    current=$(dsh_ops compatibility) || return 1
  fi
  candidate=$(docker run --rm --network none --entrypoint cat "$target" /app/deploy/dsh/runtime-compat.json) || {
    echo 'The target image cannot read existing DSH conversations; use the compatible rollback image.' >&2; return 1;
  }
  [ "$current" = "$candidate" ] || {
    echo 'The target DSH reader/protocol differs. A verified compatible reader is required before rollback.' >&2; return 1;
  }
}

dsh_snapshot() {
  local destination=$1 root source
  dsh_available || return 0
  dsh_accounts_check || return 1
  if [ -n "${CHISABOT_DSH_ACCOUNTS_CONFIG:-}" ]; then
    "${CHISABOT_DSH_NODE:-node}" "${U:?}/accounts.mjs" snapshot "$CHISABOT_DSH_ACCOUNTS_CONFIG" "$destination/accounts" || return 1
    dsh_record_reader || return 1
    return 0
  fi
  # A selected DSH deployment must use a persisted root; no path guessing or empty backup is accepted.
  root=$(docker exec "$CONTAINER" sh -c 'cat /run/s6/container_environment/CHISABOT_DSH_ROOT 2>/dev/null || printenv CHISABOT_DSH_ROOT') || return 1
  [ -n "$root" ] || { echo 'CHISABOT_DSH_ROOT is missing' >&2; return 1; }
  source=$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$root\"}}{{.Source}}{{end}}{{end}}" "$CONTAINER") || return 1
  [ -d "$source" ] || { echo 'DSH storage must be a mounted persistent directory before release.' >&2; return 1; }
  dsh_ops snapshot > "$destination/dsh-watermarks.json" || return 1
  dsh_record_reader || return 1
  tar czf "$destination/dsh-volume.tgz" --exclude='./.maintenance' -C "$source" . || return 1
  docker exec "$CONTAINER" sh -c 'pg_dump -Fc "$(cat /run/s6/container_environment/DATABASE_URL)"' > "$destination/chisabot.dump" || return 1
  [ -s "$destination/chisabot.dump" ] && [ -s "$destination/dsh-volume.tgz" ]
}
