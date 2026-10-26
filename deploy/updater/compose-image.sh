#!/bin/bash
# 镜像写在哪（update.sh / rollback.sh 用 source 引入；docs/online-update.md）。
#
# 两种部署：
#  - compose 模式：compose 文件里直接写 `    image: local/chisabot:<标签>`（手写的 /opt/chisabot-zh/compose.yaml）。
#    切换 = 改这一行；上线前的 compose 留成 <compose>.before-<新标签>。
#  - env 模式：仓库自带的 deploy/compose.yaml 写的是 `image: ${CHISABOT_IMAGE:-…}`（deploy/start.sh 部署的）。
#    compose 文件在 git 仓库里，不能改；切换 = 改同目录 .env 的 CHISABOT_IMAGE（compose 自动读它）；
#    上一版镜像名记在 .image.before-<新标签>。
# 需要 COMPOSE_DIR、COMPOSE_FILE、IMAGE_REPO（config.env）。
# Hermes helpers share the existing deploy lock and image rollback record. Only an already
# configured Hermes deployment is upgraded; no model run, dependency install or token rotation.

image_mode() {
  # shellcheck disable=SC2016  # 找的就是字面的 ${CHISABOT_IMAGE
  if grep -q '^    image: \${CHISABOT_IMAGE' "$COMPOSE_DIR/$COMPOSE_FILE" 2>/dev/null; then echo env; else echo compose; fi
}

# set_image <镜像>：把部署指向这个镜像（不启动）。成功返回 0。
set_image() {
  local f
  if [ "$(image_mode)" = env ]; then
    f="$COMPOSE_DIR/.env"
    if grep -q '^CHISABOT_IMAGE=' "$f" 2>/dev/null; then
      sed -i "s#^CHISABOT_IMAGE=.*#CHISABOT_IMAGE=$1#" "$f"
    else
      printf 'CHISABOT_IMAGE=%s\n' "$1" >> "$f"
    fi
    grep -q "^CHISABOT_IMAGE=$1\$" "$f"
  else
    f="$COMPOSE_DIR/$COMPOSE_FILE"
    sed -i "s#^\(    image: \)$IMAGE_REPO:[A-Za-z0-9._-]*#\1$1#" "$f"
    grep -q "^    image: $1\$" "$f"
  fi
}

# previous_image <标签>：<标签> 上线之前的镜像（不知道时输出空）。
previous_image() {
  if [ -f "$COMPOSE_DIR/.image.before-$1" ]; then
    sed -n "1s#^\($IMAGE_REPO:[A-Za-z0-9._-]*\)\$#\1#p" "$COMPOSE_DIR/.image.before-$1"
  elif [ -f "$COMPOSE_DIR/$COMPOSE_FILE.before-$1" ]; then
    sed -n "s#^    image: \($IMAGE_REPO:[A-Za-z0-9._-]*\)\$#\1#p" "$COMPOSE_DIR/$COMPOSE_FILE.before-$1" | head -n 1
  fi
}

# CB-100：compose_network_drift — 正在运行的容器是否不在 compose 文件声明的默认网络上（名字或子网不一致）。
# 在 COMPOSE_DIR 里调用；需要 PROJECT、COMPOSE_FILE、CONTAINER。漂移时输出一行原因并返回 0，否则返回 1。
# 默认网络改名 / 换子网后，普通 `compose up -d` 会报「network … not found」或「needs to be recreated」，
# 或者把容器留在旧网络上；这时要 --force-recreate（update.sh / rollback.sh）。
# CB-100b：从 `compose config --format json`（stdin）里取默认网络的「名字 子网」。不再硬依赖 python3：
# 依次试 CHISABOT_PYTHON / python3 / python / jq / bun / node。某个工具存在但执行失败（非 0 退出、
# 或输出不是一行「名字 子网」）时换下一个继续。一个工具都没有返回 2；有工具但全部失败返回 3。
compose_default_network_from_json() {
  local input out tool tried=0 py_code jq_code js
  # 只用 bash 内建读 stdin：调用方的 PATH 里可能只有解析器本身（server/tests/compose-network-drift.test.ts）。
  IFS= read -r -d '' input || true
  py_code='
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
n = (d.get("networks") or {}).get("default") or {}
c = ((n.get("ipam") or {}).get("config") or [{}])[0] or {}
print(n.get("name") or "", c.get("subnet") or "")
'
  # shellcheck disable=SC2016  # jq 程序本身，不展开
  jq_code='(.networks.default // {}) as $n | "\($n.name // "") \((($n.ipam // {}).config // [{}])[0].subnet // "")"'
  js='let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let d;try{d=JSON.parse(s)}catch{process.exit(1)}const n=(d.networks||{}).default||{};const c=((n.ipam||{}).config||[{}])[0]||{};console.log((n.name||"")+" "+(c.subnet||""))})'
  for tool in "${CHISABOT_PYTHON:-}" python3 python jq bun node; do
    [ -n "$tool" ] || continue
    command -v "$tool" >/dev/null 2>&1 || [ -x "$tool" ] || continue
    tried=1
    case "${tool##*/}" in
      jq) out=$(printf '%s' "$input" | "$tool" -r "$jq_code" 2>/dev/null) ;;
      bun|node) out=$(printf '%s' "$input" | "$tool" -e "$js" 2>/dev/null) ;;
      *) out=$(printf '%s' "$input" | "$tool" -c "$py_code" 2>/dev/null) ;;
    esac || { echo "compose 网络漂移检查：$tool 执行失败，换下一个工具" >&2; continue; }
    # 只接受恰好一行「名字 子网」（两段都不含空白，各自可空）。
    if [[ "$out" != *$'\n'* ]] && [[ "$out" =~ ^[^[:space:]]*\ [^[:space:]]*$ ]]; then
      printf '%s\n' "$out"
      return 0
    fi
    echo "compose 网络漂移检查：$tool 的输出无法解析，换下一个工具" >&2
  done
  [ "$tried" = 1 ] && return 3
  return 2
}

# CB-100：compose_network_drift — 正在运行的容器是否不在 compose 文件声明的默认网络上（名字或子网不一致）。
# 在 COMPOSE_DIR 里调用；需要 PROJECT、COMPOSE_FILE、CONTAINER。漂移时输出一行原因并返回 0，否则返回 1。
# 默认网络改名 / 换子网后，普通 `compose up -d` 会报「network … not found」或「needs to be recreated」，
# 或者把容器留在旧网络上；这时要 --force-recreate（update.sh / rollback.sh）。
# CB-100b：主机上没有任何 JSON 解析器时，不再静默当成「没漂移」：stderr 报清楚，并按漂移处理
# （--force-recreate 只是重建容器，比把容器留在错误网络上安全）。
compose_network_drift() {
  local json want want_name want_subnet have have_subnet rc
  json=$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" config --format json 2>/dev/null) || return 1
  rc=0
  want=$(printf '%s' "$json" | compose_default_network_from_json) || rc=$?
  if [ "$rc" = 2 ] || [ "$rc" = 3 ]; then
    if [ "$rc" = 2 ]; then
      echo "::error:: 检查 compose 网络漂移需要 python3、jq、bun 或 node 之一，主机上都没有；按漂移处理（--force-recreate）" >&2
    else
      echo "::error:: 检查 compose 网络漂移的工具（python3/jq/bun/node）全部执行失败或输出无法解析；按漂移处理（--force-recreate）" >&2
    fi
    echo "无法判断网络是否漂移（没有可用的 JSON 解析工具），保守起见 --force-recreate"
    return 0
  fi
  [ "$rc" = 0 ] || return 1
  want_name=${want%% *}
  want_subnet=${want#* }
  [ -n "$want_name" ] || return 1
  have=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$CONTAINER" 2>/dev/null) || return 1
  case " $have " in
    *" $want_name "*) ;;
    *) echo "容器 $CONTAINER 在网络 [${have% }] 上，compose 要求 $want_name"; return 0 ;;
  esac
  if [ -n "$want_subnet" ]; then
    have_subnet=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$want_name" 2>/dev/null)
    case " $have_subnet " in
      *" $want_subnet "*) ;;
      *) echo "网络 $want_name 的子网是 [${have_subnet% }]，compose 要求 $want_subnet"; return 0 ;;
    esac
  fi
  return 1
}

hermes_update_python() {
  local interpreter=${CHISABOT_HERMES_UPDATE_PYTHON:-${HERMES_VENV_DIR:-/opt/hermes/venv}/bin/python}
  [ -x "$interpreter" ] || { echo "Hermes 更新需要已有服务端 Python；没有安装依赖" >&2; return 1; }
  printf '%s\n' "$interpreter"
}

hermes_release_paths() {
  HERMES_RELEASE_ROOT=${CHISABOT_HERMES_RUNTIME_ROOT:-${CHISABOT_HERMES_RUNTIME_HOME:-/opt/hermes/chisabot-runtime}}
  HERMES_RELEASE_STATE=${CHISABOT_HERMES_STATE_HOME:-/var/lib/chisabot-hermes}
  HERMES_RELEASE_UNIT=${CHISABOT_HERMES_UNIT_FILE:-/etc/systemd/system/hermes-acp-bridge.service}
  case "$HERMES_RELEASE_ROOT:$HERMES_RELEASE_STATE:$HERMES_RELEASE_UNIT" in *[\ \"\']*)
    echo "Hermes 服务路径不能含空白或引号" >&2; return 1 ;; esac
  [[ "$HERMES_RELEASE_ROOT" = /* && "$HERMES_RELEASE_STATE" = /* && "$HERMES_RELEASE_UNIT" = /* ]] || return 1
}

# Return 0 only for an already configured installation. Reading .env never executes its contents.
hermes_release_enabled() {
  hermes_release_paths || return 2
  [ -f "$HERMES_RELEASE_UNIT" ] || return 1
  local interpreter
  interpreter=$(hermes_update_python) || return 2
  local selected
  "$interpreter" -B - "$COMPOSE_DIR/.env" "${CHISABOT_AGENT_KERNEL:-}" "${CHISABOT_HERMES_URL:-}" <<'PY'
import re, sys
from pathlib import Path
values = {}
path = Path(sys.argv[1])
for line in path.read_text(encoding='utf-8').splitlines() if path.exists() else []:
    match = re.match(r'^\s*(?:export\s+)?(CHISABOT_AGENT_KERNEL|CHISABOT_HERMES_URL)\s*=(.*)$', line)
    if match:
        values[match[1]] = match[2].strip().strip('"\'')
kernel = values.get('CHISABOT_AGENT_KERNEL', sys.argv[2]).strip()
url = values.get('CHISABOT_HERMES_URL', sys.argv[3]).strip()
raise SystemExit(0 if kernel == 'hermes' or url else 3)
PY
  selected=$?
  [ "$selected" = 0 ] && return 0
  [ "$selected" = 3 ] && return 1
  return 2
}

# Stage the adapter and bridge from the SAME exported commit as the image. This never changes a unit.
prepare_hermes_release() {
  local source=$1 commit=$2 interpreter release marker file selected
  HERMES_RELEASE_ENABLED=0
  if hermes_release_enabled; then :
  else
    selected=$?
    [ "$selected" = 1 ] && return 0
    return 1
  fi
  case "$commit" in *[!0-9a-f]*|'') return 1 ;; esac
  [ "${#commit}" = 40 ] || return 1
  interpreter=$(hermes_update_python) || return 1
  release="$HERMES_RELEASE_ROOT/releases/$commit"
  marker="$release/.chisabot-commit"
  for file in examples/acp-agent/bridge.mjs examples/hermes-agent/chisabot_acp.py examples/hermes-agent/chisabot_protocol.py deploy/install-hermes-runtime.sh; do
    [ -f "$source/$file" ] || { echo "目标提交缺少 Hermes 运行时文件" >&2; return 1; }
  done
  if [ -e "$release" ]; then
    [ -f "$marker" ] && [ "$(cat "$marker")" = "$commit" ] || { echo "已有 Hermes release 记录不匹配" >&2; return 1; }
    cmp -s "$source/examples/acp-agent/bridge.mjs" "$release/acp-agent/bridge.mjs" \
      && cmp -s "$source/examples/hermes-agent/chisabot_acp.py" "$release/hermes-agent/chisabot_acp.py" \
      && cmp -s "$source/examples/hermes-agent/chisabot_protocol.py" "$release/hermes-agent/chisabot_protocol.py" \
      || { echo "已有 Hermes release 内容与目标提交不同" >&2; return 1; }
  fi
  CHISABOT_HERMES_RUNTIME_HOME="$release" CHISABOT_HERMES_STATE_HOME="$HERMES_RELEASE_STATE" \
    bash "$source/deploy/install-hermes-runtime.sh" --prepare || return 1
  printf '%s\n' "$commit" > "$marker.tmp.$$" && chmod 0644 "$marker.tmp.$$" && mv -f "$marker.tmp.$$" "$marker" || return 1
  HERMES_RELEASE_SOURCE=$source
  HERMES_RELEASE_DIRECTORY=$release
  HERMES_RELEASE_ENABLED=1
  echo "Hermes 运行时 ${commit:0:7} 已准备，当前服务保持运行"
}

# Root-only transaction record. Save only Hermes env keys so image selection and unrelated settings survive.
snapshot_hermes_release() {
  [ "${HERMES_RELEASE_ENABLED:-0}" = 1 ] || return 0
  local tag=$1 interpreter active=0 enabled=0
  case "$tag" in *[!A-Za-z0-9._-]*|'') return 1 ;; esac
  interpreter=$(hermes_update_python) || return 1
  if systemctl is-active --quiet hermes-acp-bridge.service; then active=1; fi
  if systemctl is-enabled --quiet hermes-acp-bridge.service; then enabled=1; fi
  "$interpreter" -B - "$COMPOSE_DIR" "$tag" "$HERMES_RELEASE_ROOT" "$HERMES_RELEASE_UNIT" "$active" "$enabled" <<'PY'
import json, os, re, shutil, stat, sys, tempfile
from pathlib import Path
base, tag, root, unit = map(Path, (sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]))
snapshot = base / ('.hermes.before-' + str(tag))
if snapshot.exists():
    raise SystemExit('Hermes 回滚快照已存在，拒绝覆盖')
keys = r'CHISABOT_(?:AGENT_KERNEL|HERMES_URL|HERMES_TOKEN|HERMES_TOOL_GATEWAY_URL)'
environment = base / '.env'
lines = environment.read_text(encoding='utf-8').splitlines(keepends=True) if environment.exists() else []
managed = [line for line in lines if re.match(r'^\s*(?:export\s+)?' + keys + r'\s*=', line)]
current = root / 'current'
if os.path.lexists(current) and not current.is_symlink():
    raise SystemExit('Hermes current 必须是符号链接')
partial = Path(tempfile.mkdtemp(prefix=snapshot.name + '.tmp.', dir=base))
try:
    os.chmod(partial, 0o700)
    record = {'version': 1, 'unit': str(unit), 'root': str(root), 'managedEnv': managed,
              'active': sys.argv[5] == '1', 'enabled': sys.argv[6] == '1',
              'current': os.readlink(current) if current.is_symlink() else None}
    shutil.copy2(unit, partial / 'unit')
    os.chmod(partial / 'unit', 0o600)
    (partial / 'manifest.json').write_text(json.dumps(record), encoding='utf-8')
    os.chmod(partial / 'manifest.json', 0o600)
    os.rename(partial, snapshot)
except BaseException:
    shutil.rmtree(partial)
    raise
PY
}

configure_hermes_release() {
  [ "${HERMES_RELEASE_ENABLED:-0}" = 1 ] || return 0
  local interpreter
  interpreter=$(hermes_update_python) || return 1
  "$interpreter" -B - "$COMPOSE_DIR/.env" "$HERMES_RELEASE_STATE/bridge.env" "${LOCAL_URL:-http://127.0.0.1:3001}" \
    "${CHISABOT_HERMES_URL:-}" "${ACP_BRIDGE_HOST:-172.19.0.1}" "${ACP_BRIDGE_PORT:-4100}" <<'PY'
import os, re, sys, tempfile
from pathlib import Path
from urllib.parse import urlsplit
path, credentials = Path(sys.argv[1]), Path(sys.argv[2])
keys = ['CHISABOT_AGENT_KERNEL', 'CHISABOT_HERMES_URL', 'CHISABOT_HERMES_TOKEN', 'CHISABOT_HERMES_TOOL_GATEWAY_URL']
pattern = re.compile(r'^\s*(?:export\s+)?(' + '|'.join(keys) + r')\s*=(.*)$')
lines = path.read_text(encoding='utf-8').splitlines(keepends=True) if path.exists() else []
values = {}
for line in lines:
    match = pattern.match(line)
    if match:
        values[match[1]] = match[2].strip().strip('"\'')
tokens = [line.split('=', 1)[1].strip() for line in credentials.read_text(encoding='utf-8').splitlines() if line.startswith('ACP_BRIDGE_TOKEN=')]
if len(tokens) != 1 or not re.fullmatch(r'[A-Za-z0-9_-]{20,}', tokens[0]):
    raise SystemExit('Hermes bridge 凭据缺失或格式不正确')
url = values.get('CHISABOT_HERMES_URL') or sys.argv[4] or 'http://' + sys.argv[5] + ':' + sys.argv[6] + '/ag-ui'
parsed = urlsplit(url)
if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or any(c.isspace() for c in url):
    raise SystemExit('Hermes bridge 地址不正确')
local = urlsplit(sys.argv[3])
if local.scheme not in ('http', 'https') or not local.hostname:
    raise SystemExit('LOCAL_URL 不能确定 API 的宿主机发布端口')
try:
    port = local.port or (443 if local.scheme == 'https' else 80)
except ValueError:
    raise SystemExit('LOCAL_URL 端口不正确')
values.update(CHISABOT_AGENT_KERNEL='hermes', CHISABOT_HERMES_URL=url, CHISABOT_HERMES_TOKEN=tokens[0],
              CHISABOT_HERMES_TOOL_GATEWAY_URL='http://127.0.0.1:' + str(port) + '/api/internal/runtime-tools')
kept = [line for line in lines if not pattern.match(line)]
text = ''.join(kept)
if text and not text.endswith('\n'):
    text += '\n'
text += ''.join(key + '=' + values[key] + '\n' for key in keys)
fd, temporary = tempfile.mkstemp(prefix=path.name + '.tmp.', dir=path.parent)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
except BaseException:
    if os.path.exists(temporary): os.unlink(temporary)
    raise
PY
}

activate_hermes_release() {
  [ "${HERMES_RELEASE_ENABLED:-0}" = 1 ] || return 0
  local interpreter
  interpreter=$(hermes_update_python) || return 1
  CHISABOT_HERMES_RUNTIME_HOME="$HERMES_RELEASE_DIRECTORY" CHISABOT_HERMES_STATE_HOME="$HERMES_RELEASE_STATE" \
    bash "$HERMES_RELEASE_SOURCE/deploy/install-hermes-runtime.sh" || return 1
  "$interpreter" -B - "$HERMES_RELEASE_ROOT" "$HERMES_RELEASE_DIRECTORY" <<'PY'
import os, sys, uuid
from pathlib import Path
root, release = map(Path, sys.argv[1:])
current = root / 'current'
if os.path.lexists(current) and not current.is_symlink():
    raise SystemExit('Hermes current 必须是符号链接')
temporary = root / ('.current.' + uuid.uuid4().hex)
os.symlink(release, temporary)
os.replace(temporary, current)
PY
}

# Called under .deploy.lock by automatic, generated and admin rollbacks before restarting the image.
# The ledger is deliberately NOT restored: an already-started operation must retain its unknown state.
restore_hermes_release() {
  local tag=$1 interpreter snapshot status active enabled
  case "$tag" in *[!A-Za-z0-9._-]*|'') return 1 ;; esac
  snapshot="$COMPOSE_DIR/.hermes.before-$tag"
  [ -d "$snapshot" ] || return 0
  interpreter=$(hermes_update_python) || return 1
  status=$("$interpreter" -B - "$COMPOSE_DIR/.env" "$snapshot" <<'PY'
import json, os, re, sys, tempfile, uuid
from pathlib import Path
path, snapshot = map(Path, sys.argv[1:])
record = json.loads((snapshot / 'manifest.json').read_text(encoding='utf-8'))
if record.get('version') != 1 or not isinstance(record.get('managedEnv'), list):
    raise SystemExit('Hermes 回滚快照格式不正确')
unit, root = Path(record['unit']), Path(record['root'])
if not unit.is_absolute() or unit.name != 'hermes-acp-bridge.service' or not root.is_absolute():
    raise SystemExit('Hermes 回滚快照路径不正确')
pattern = re.compile(r'^\s*(?:export\s+)?CHISABOT_(?:AGENT_KERNEL|HERMES_URL|HERMES_TOKEN|HERMES_TOOL_GATEWAY_URL)\s*=')
lines = path.read_text(encoding='utf-8').splitlines(keepends=True) if path.exists() else []
text = ''.join(line for line in lines if not pattern.match(line))
if text and not text.endswith('\n'): text += '\n'
text += ''.join(record['managedEnv'])
if text and not text.endswith('\n'): text += '\n'
def atomic(target, data, mode):
    fd, temporary = tempfile.mkstemp(prefix=target.name + '.tmp.', dir=target.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        if os.path.exists(temporary): os.unlink(temporary)
        raise
atomic(path, text.encode('utf-8'), 0o600)
atomic(unit, (snapshot / 'unit').read_bytes(), 0o644)
current = root / 'current'
if os.path.lexists(current) and not current.is_symlink():
    raise SystemExit('Hermes current 必须是符号链接')
if record.get('current') is None:
    if current.is_symlink(): current.unlink()
else:
    temporary = root / ('.current.' + uuid.uuid4().hex)
    os.symlink(record['current'], temporary)
    os.replace(temporary, current)
print(('1' if record.get('active') else '0') + ' ' + ('1' if record.get('enabled') else '0'))
PY
  ) || return 1
  read -r active enabled <<< "$status"
  systemctl daemon-reload || return 1
  if [ "$enabled" = 1 ]; then systemctl enable hermes-acp-bridge.service >/dev/null || return 1
  else systemctl disable hermes-acp-bridge.service >/dev/null 2>&1 || return 1; fi
  if [ "$active" = 1 ]; then systemctl restart hermes-acp-bridge.service || return 1
  else systemctl stop hermes-acp-bridge.service || return 1; fi
  echo "已恢复镜像更新前的 Hermes 服务、运行时和环境（保留执行账本）"
}
