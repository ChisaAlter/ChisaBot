#!/bin/bash
# Offline failure-path checks; no daemon, live database or running deployment is touched.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
. "$HERE/dsh-release.sh"
U=$TMP
cp "$HERE/../dsh/reader-compatibility.mjs" "$U/reader-compatibility.mjs"
CONTAINER=fixture
COMPOSE_DIR=$TMP
CURRENT='{"protocol":1,"runtimeVersion":"0.2.2-rc.1","historyReader":"dsh-0.2.2-rc.1","conversationReader":1}'
AVAILABLE=1 KERNEL=dsh BINDINGS=1 DB_FAILURE=0 IMAGE_FAILURE=0
BUSY=0
EXTERNAL_TARGETS=''
CANDIDATE=$CURRENT
CALLS=$TMP/calls
docker() {
  printf '%s\n' "$*" >> "$CALLS"
  case "$*" in
    'exec fixture test -f /app/deploy/dsh/ops.ts') [ "$AVAILABLE" = 1 ] ;;
    *'ops.ts bindings') [ "$DB_FAILURE" = 0 ] && printf '%s\n' "$BINDINGS" ;;
    *'ops.ts compatibility') printf '%s\n' "$CURRENT" ;;
    *'ops.ts health') [ "$DB_FAILURE" = 0 ] ;;
    *'ops.ts busy') [ "$DB_FAILURE" = 0 ] && printf '%s\n' "$BUSY" ;;
    *'ops.ts enabled') [ "$DB_FAILURE" = 0 ] && printf '1\n' ;;
    *'dirname "$CHISABOT_DSH_TARGETS_FILE"'*) printf '%s' "$EXTERNAL_TARGETS" ;;
    *'printenv CHISABOT_AGENT_KERNEL'*) printf '%s\n' "$KERNEL" ;;
    'run --rm --network none --entrypoint cat '*'/app/deploy/dsh/runtime-compat.json')
      [ "$IMAGE_FAILURE" = 0 ] && printf '%s\n' "$CANDIDATE" ;;
    *) echo "Unexpected docker invocation: $*" >&2; return 2 ;;
  esac
}
pass() { printf 'ok - %s\n' "$1"; }
reject() { if "$@"; then echo "Unexpected success: $*" >&2; exit 1; fi; }

dsh_require_compatible_image fixture:new
pass 'matching reader accepts rollback without touching live data'
CANDIDATE='{"conversationReader":2,"historyReader":"dsh-0.2.2-rc.1","runtimeVersion":"0.2.2-rc.1","protocol":1}'
dsh_require_compatible_image fixture:reader-2
pass 'newer product reader accepts existing records regardless of JSON property order'
PRIOR=$CURRENT
CURRENT=$CANDIDATE
CANDIDATE=$PRIOR
reject dsh_require_compatible_image fixture:reader-1
pass 'older product reader cannot ignore new delivery and outcome contracts'
READER2=$CURRENT
CANDIDATE='{"protocol":1,"runtimeVersion":"0.2.2-rc.1","historyReader":"dsh-0.2.2-rc.1","conversationReader":3}'
dsh_require_compatible_image fixture:reader-3
pass 'reader 3 accepts reader 2 background history'
CURRENT=$PRIOR
dsh_require_compatible_image fixture:reader-3
pass 'reader 3 accepts reader 1 history'
CURRENT=$CANDIDATE
CANDIDATE=$READER2
reject dsh_require_compatible_image fixture:reader-2
pass 'reader 2 cannot replay reader 3 persistent capacity waits'
CURRENT=$PRIOR
CANDIDATE='{"protocol":1,"runtimeVersion":"0.2.2-rc.1","historyReader":"different-native-reader","conversationReader":2}'
reject dsh_require_compatible_image fixture:native-mismatch
pass 'product reader upgrade never overrides a native history mismatch'
CANDIDATE='{"protocol":1,"runtimeVersion":"0.2.2-rc.1","historyReader":"dsh-0.2.2-rc.1","conversationReader":0}'
reject dsh_require_compatible_image fixture:invalid-reader
pass 'nonpositive product reader is invalid'
CANDIDATE='{"protocol":1,"runtimeVersion":"0.2.2-rc.1","historyReader":"dsh-0.2.2-rc.1","conversationReader":"2"}'
reject dsh_require_compatible_image fixture:string-reader
pass 'product reader must be an integer rather than a string'
CANDIDATE=$CURRENT
grep -q '^exec -e PATH=/command:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin fixture /command/with-contenv /command/s6-setuidgid apiuser /usr/local/bin/bun ' "$CALLS"
pass 'docker exec supplies the execline PATH and absolute uid wrapper'
CANDIDATE='{"protocol":1,"runtimeVersion":"0.2.3","historyReader":"dsh-0.2.3"}'
reject dsh_require_compatible_image fixture:new
pass 'different reader refuses rollback'
CANDIDATE='{"protocol":1,"runtimeVersion":"0.2.2-rc.1","historyReader":"dsh-0.2.2-rc.1"}'
reject dsh_require_compatible_image fixture:pre-rich-inbox
pass 'native log compatibility alone cannot authorize a product inbox rollback'
IMAGE_FAILURE=1
reject dsh_require_compatible_image fixture:pre-dsh
pass 'pre-DSH image refuses rollback after DSH data exists'
IMAGE_FAILURE=0 CANDIDATE=$CURRENT DB_FAILURE=1
reject dsh_require_compatible_image fixture:new
pass 'unreadable binding inventory does not permit blind rollback'
printf '%s\n' "$CURRENT" > "$COMPOSE_DIR/.dsh-reader.json"
printf '' > "$CALLS"
dsh_require_compatible_image fixture:new
! grep -q '^exec ' "$CALLS"
pass 'saved reader allows compatibility check while candidate container is down'
rm "$COMPOSE_DIR/.dsh-reader.json"
DB_FAILURE=0 BINDINGS=0 IMAGE_FAILURE=1
dsh_require_compatible_image fixture:pre-dsh
pass 'no DSH binding permits legacy rollback'
AVAILABLE=0 KERNEL=builtin
dsh_readiness
pass 'legacy installation does not acquire a new runtime requirement'
KERNEL=dsh
reject dsh_readiness
pass 'selected DSH without readiness tooling fails'
AVAILABLE=1 DB_FAILURE=1
reject dsh_readiness
pass 'runtime health failure fails release'
DB_FAILURE=0 DRAIN_SECONDS=0 BUSY=0
dsh_wait_idle
pass 'idle execution allows rollback'
BUSY=1
reject dsh_wait_idle
pass 'drain timeout refuses active rollback'
BUSY=invalid
reject dsh_wait_idle
pass 'invalid activity count refuses rollback'
dsh_record_reader
[ "$(cat "$COMPOSE_DIR/.dsh-reader.json")" = "$CURRENT" ]
pass 'enabled runtime retains reader record before container failure'
U=$TMP CHISABOT_DSH_ACCOUNTS_CONFIG='' EXTERNAL_TARGETS=''
dsh_accounts_check
pass 'managed deployment requires no account config'
EXTERNAL_TARGETS=/targets
reject dsh_accounts_check
pass 'external targets without explicit host config stop release'
NODE_FAILURE=0 NODE_CALLS=$TMP/node-calls
dsh_test_node() {
  printf '%s\n' "$*" >> "$NODE_CALLS"
  [ "$NODE_FAILURE" = 0 ] || return 1
  if [ "$1" = "$U/reader-compatibility.mjs" ]; then node "$@"; fi
}
CHISABOT_DSH_NODE=dsh_test_node CHISABOT_DSH_ACCOUNTS_CONFIG=/host/accounts.json
dsh_accounts_check
grep -q 'accounts-release.mjs check /host/accounts.json fixture /targets' "$NODE_CALLS"
pass 'external preflight binds configured coordinator to this API and target mount'
NODE_FAILURE=1
reject dsh_accounts_check
pass 'account config mismatch or missing coordinator fails release'
NODE_FAILURE=0 IMAGE_FAILURE=0 CANDIDATE=$CURRENT
dsh_snapshot "$TMP/cutover"
grep -q 'accounts.mjs snapshot /host/accounts.json .*/cutover/accounts' "$NODE_CALLS"
pass 'external backup dispatches coordinated account snapshot'
dsh_accounts_replace fixture:new
grep -q 'accounts-release.mjs replace /host/accounts.json fixture /targets fixture:new' "$NODE_CALLS"
pass 'replacement receives the same target image as the API'
EXTERNAL_TARGETS=''
reject dsh_accounts_check
pass 'host account config cannot silently act on a managed deployment'
# Source presence preflight precedes build/maintenance; the built image reader check remains authoritative.
SOURCE_MISSING=0
git() { [ "$SOURCE_MISSING" = 0 ]; }
dsh_require_source_tools fixture-commit
pass 'selected DSH accepts migrated source tooling'
SOURCE_MISSING=1
reject dsh_require_source_tools pre-dsh-commit
pass 'selected DSH rejects pre-migration source before publication'
rm -f "$COMPOSE_DIR/.dsh-reader.json"
AVAILABLE=0
dsh_require_source_tools legacy-commit
pass 'legacy source update does not gain DSH prerequisites'
echo 'DSH release failure-path checks passed'
