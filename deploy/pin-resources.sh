#!/bin/sh
# Adopt existing physical resources from the running container before applying Compose defaults.
# Source this file; only explicit deployment entry points call the function below.
pin_existing_resources() (
  set -eu
  resource_env=$1
  resource_container=${2:-chisabot-zh}
  resource_value() { sed -n "s/^$1=//p" "$resource_env" 2>/dev/null | tail -n 1 | tr -d '\r"\047'; }
  resource_set() {
    resource_key=$1 resource_name=$2
    [ -n "$resource_name" ] || return 0
    case "$resource_name" in *[!a-zA-Z0-9_.-]*) echo "Invalid deployment resource name for $resource_key" >&2; exit 1 ;; esac
    [ -z "$(resource_value "$resource_key")" ] || return 0
    resource_tmp="$resource_env.resources.$$"
    (umask 077; awk -v key="$resource_key" '$0 !~ "^" key "=" { print }' "$resource_env" > "$resource_tmp"
      printf '%s=%s\n' "$resource_key" "$resource_name" >> "$resource_tmp")
    mv "$resource_tmp" "$resource_env"
  }
  if docker inspect "$resource_container" >/dev/null 2>&1; then
    for resource_pair in DATABASE:/var/lib/postgresql WORKSPACE:/workspace PROFILES:/profiles DSH:/var/lib/chisabot-dsh; do
      [ -z "$(resource_value CHISABOT_VOLUME_PREFIX)" ] || break
      resource_kind=${resource_pair%%:*} resource_path=${resource_pair#*:}
      resource_name=$(docker inspect -f "{{range .Mounts}}{{if and (eq .Type \"volume\") (eq .Destination \"$resource_path\")}}{{.Name}}{{end}}{{end}}" "$resource_container")
      resource_set "CHISABOT_${resource_kind}_VOLUME" "$resource_name"
    done
    resource_networks=$(docker inspect -f '{{range $name, $net := .NetworkSettings.Networks}}{{$name}}{{"\n"}}{{end}}' "$resource_container")
    resource_network=$(printf '%s\n' "$resource_networks" | sed -n '/_default$/p' | head -n 1)
    resource_set CHISABOT_NETWORK_NAME "$resource_network"
    # Exclude per-account DSH networks (labelled chisabot.runtime-owner) and prefer explicit magpie network names.
    magpie_network=""
    magpie_fallback=""
    for cand in $(printf '%s\n' "$resource_networks" | sed '/_default$/d;/^$/d'); do
      case "$cand" in bridge|host|none) continue ;; esac
      cand_owner=$(docker network inspect -f '{{if .Labels}}{{index .Labels "chisabot.runtime-owner"}}{{end}}' "$cand" 2>/dev/null | tr -d '\r' || true)
      case "$cand_owner" in ""|"<no value>") ;; *) continue ;; esac
      case "$cand" in
        *magpie*)
          magpie_network=$cand
          break
          ;;
        *)
          [ -n "$magpie_fallback" ] || magpie_fallback=$cand
          ;;
      esac
    done
    [ -n "$magpie_network" ] || magpie_network=$magpie_fallback
    resource_set MAGPIE_NETWORK "$magpie_network"
  fi
  resource_network=$(resource_value CHISABOT_NETWORK_NAME)
  if [ -n "$resource_network" ] && docker network inspect "$resource_network" >/dev/null 2>&1; then
    resource_subnet=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$resource_network")
    resource_gateway=$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$resource_network")
    for resource_pair in CHISABOT_NETWORK_SUBNET:$resource_subnet CHISABOT_NETWORK_GATEWAY:$resource_gateway; do
      resource_key=${resource_pair%%:*} resource_name=${resource_pair#*:}
      [ -z "$(resource_value "$resource_key")" ] || continue
      case "$resource_name" in *[!0-9./]*|"") echo 'Invalid existing IPv4 network configuration' >&2; exit 1 ;; esac
      printf '%s=%s\n' "$resource_key" "$resource_name" >> "$resource_env"
    done
  fi
)
