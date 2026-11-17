import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 无界面节点 chisabot-node（docs/pc-node.md §14）：Linux / macOS（也能在 Windows 上跑）的服务器节点。
 *
 * - 节点程序是 pc/src/headless.js（和 PC 客户端同一套 agent 代码），网页构建时由 Vite 插件用 esbuild 打成单个
 *   `node-agent/chisabot-node.cjs`（app/vite.config.ts 的 chisabotNodeBundle），放在 APP_DIST_DIR 里；
 * - 安装脚本 install.sh 由这里按请求生成：检查 / 下载 Node.js（≥ 18）→ 下载节点程序 → 用一次性安装码配对 →
 *   注册成 systemd（root 用系统服务，普通用户用 systemd --user）或 launchd 服务，开机自启、断线自动重连。
 * 两个地址都在 /api/devices/agent/ 下面（网关不校验会话），只是公开代码，不含任何密钥；配对靠一次性安装码。
 */

export const NODE_BUNDLE_FILE = "node-agent/chisabot-node.cjs";

export async function readNodeBundle(appDistDir: string | undefined): Promise<Buffer | null> {
  const candidates = [
    appDistDir ? path.join(appDistDir, NODE_BUNDLE_FILE) : null,
    process.env.CHISABOT_NODE_BUNDLE || null,
  ].filter((p): p is string => !!p);
  for (const file of candidates) {
    try {
      return await readFile(file);
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** 安装脚本。server 只用于默认值，命令行里的 --server 优先。 */
export function installScript(server: string): string {
  const safeServer = server.replace(/[^A-Za-z0-9:/._\-[\]]/g, "");
  return `#!/bin/sh
# ChisaBot 服务器节点（chisabot-node）安装脚本 —— docs/pc-node.md §14
# 用法：curl -fsSL ${safeServer}/api/devices/agent/node/install.sh | sh -s -- --code cbp_xxx [--name 名称] [--no-service] [--no-full-access]
set -eu
SERVER="${safeServer}"
CODE=""
NAME=""
SERVICE=1
FULL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --no-full-access) FULL=0; shift ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done
[ -n "$CODE" ] || { echo "缺少 --code（在 ChisaBot 网页 设置 → 设备 → 添加设备 → 服务器 里复制完整命令）"; exit 2; }
SERVER="\${SERVER%/}"
if [ "$(id -u)" = 0 ]; then DIR=\${CHISABOT_NODE_DIR:-/opt/chisabot-node}; else DIR=\${CHISABOT_NODE_DIR:-$HOME/.chisabot-node}; fi
mkdir -p "$DIR"
dl() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }

# 1) Node.js ≥ 18：系统里有就用，没有就下载官方二进制到 $DIR/node（不动系统）
NODE=""
if command -v node >/dev/null 2>&1; then
  MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$MAJOR" -ge 18 ] 2>/dev/null && NODE=$(command -v node)
fi
if [ -z "$NODE" ] && [ -x "$DIR/node/bin/node" ]; then NODE="$DIR/node/bin/node"; fi
if [ -z "$NODE" ]; then
  OS=$(uname -s); ARCH=$(uname -m)
  case "$OS" in Linux) P=linux ;; Darwin) P=darwin ;; *) echo "不支持的系统：$OS（请先自行安装 Node.js 18+）"; exit 1 ;; esac
  case "$ARCH" in x86_64|amd64) A=x64 ;; aarch64|arm64) A=arm64 ;; armv7l) A=armv7l ;; *) echo "不支持的架构：$ARCH（请先自行安装 Node.js 18+）"; exit 1 ;; esac
  MIRROR=\${NODE_MIRROR:-https://nodejs.org/dist}
  dl "$MIRROR/latest-v22.x/SHASUMS256.txt" "$DIR/node.sums" || { echo "连不上 $MIRROR；可以设置 NODE_MIRROR=https://npmmirror.com/mirrors/node 重试，或先自行安装 Node.js 18+"; exit 1; }
  FILE=$(grep -o "node-v22[.0-9]*-$P-$A.tar.gz" "$DIR/node.sums" | head -n 1)
  SUM=$(grep " $FILE$" "$DIR/node.sums" | cut -d' ' -f1)
  [ -n "$FILE" ] || { echo "找不到 $P-$A 的 Node.js 安装包"; exit 1; }
  echo "下载 $FILE …"
  dl "$MIRROR/latest-v22.x/$FILE" "$DIR/node.tgz" || { echo "下载 Node.js 失败；可以设置 NODE_MIRROR=https://npmmirror.com/mirrors/node 重试，或先自行安装 Node.js 18+"; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then GOT=$(sha256sum "$DIR/node.tgz" | cut -d' ' -f1); else GOT=$(shasum -a 256 "$DIR/node.tgz" | cut -d' ' -f1); fi
  [ "$GOT" = "$SUM" ] || { echo "Node.js 安装包校验失败"; rm -f "$DIR/node.tgz"; exit 1; }
  rm -f "$DIR/node.sums"
  rm -rf "$DIR/node" && mkdir -p "$DIR/node" && tar xzf "$DIR/node.tgz" -C "$DIR/node" --strip-components=1 && rm -f "$DIR/node.tgz"
  NODE="$DIR/node/bin/node"
fi
echo "Node.js：$NODE（$("$NODE" -v)）"

# 2) 节点程序
dl "$SERVER/api/devices/agent/node/chisabot-node.cjs" "$DIR/chisabot-node.cjs.new"
mv -f "$DIR/chisabot-node.cjs.new" "$DIR/chisabot-node.cjs"

# 3) 配对（一次性安装码 → 设备令牌，存在 $DIR/config.json，权限 600）
set -- pair --server "$SERVER" --code "$CODE" --dir "$DIR"
[ -n "$NAME" ] && set -- "$@" --name "$NAME"
[ "$FULL" = 0 ] && set -- "$@" --no-full-access
"$NODE" "$DIR/chisabot-node.cjs" "$@"

# 4) 服务（开机自启、崩溃重启）
if [ "$SERVICE" = 1 ]; then
  "$NODE" "$DIR/chisabot-node.cjs" install-service --dir "$DIR" --node "$NODE"
else
  echo "未安装服务。手动运行：$NODE $DIR/chisabot-node.cjs run --dir $DIR"
fi
`;
}
