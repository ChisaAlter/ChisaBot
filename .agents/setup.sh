#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIRED_BUN_VERSION="1.3.14"

BASHRC="$HOME/.bashrc"
touch "$BASHRC"
# Allow non-interactive shells (BASH_ENV=~/.bashrc) to pick up PATH exports.
sed -i '/case \$- in/,/esac/d' "$BASHRC" 2>/dev/null || true

append_line_once() {
  local line="$1"
  local file="$2"
  grep -qxF "$line" "$file" || printf '%s\n' "$line" >> "$file"
}

node_meets_min() {
  local bin="$1"
  [ -x "$bin" ] && "$bin" -e 'const [maj, min] = process.versions.node.split(".").map(Number); process.exit(maj > 24 || (maj === 24 && min >= 9) ? 0 : 1)' 2>/dev/null
}

# 1. Ensure Bun 1.3.14 (installed under $HOME so it persists across idle VM restarts).
if [ -x "$HOME/.bun/bin/bun" ] && [ "$("$HOME/.bun/bin/bun" --version 2>/dev/null || true)" = "$REQUIRED_BUN_VERSION" ]; then
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$HOME/.bun/bin:$PATH"
  append_line_once 'export BUN_INSTALL="$HOME/.bun"' "$BASHRC"
  append_line_once 'export PATH="$HOME/.bun/bin:$PATH"' "$BASHRC"
elif ! command -v bun >/dev/null 2>&1 || [ "$(bun --version 2>/dev/null || true)" != "$REQUIRED_BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash -s "bun-v${REQUIRED_BUN_VERSION}"
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$HOME/.bun/bin:$PATH"
  append_line_once 'export BUN_INSTALL="$HOME/.bun"' "$BASHRC"
  append_line_once 'export PATH="$HOME/.bun/bin:$PATH"' "$BASHRC"
fi

# 2. Ensure Node.js >= 24.9.0 (required by runtime/dsh; installed under $HOME).
NODE_PREFIX="$HOME/.local/node"
if node_meets_min "$NODE_PREFIX/bin/node"; then
  export PATH="$NODE_PREFIX/bin:$PATH"
  append_line_once 'export PATH="$HOME/.local/node/bin:$PATH"' "$BASHRC"
elif ! node_meets_min "$(command -v node 2>/dev/null || true)"; then
  case "$(uname -s)" in
    Linux) ;;
    *)
      echo "Node.js >= 24.9.0 is required; please install it manually on $(uname -s)." >&2
      exit 1
      ;;
  esac
  case "$(uname -m)" in
    x86_64) NODE_ARCH="x64" ;;
    aarch64 | arm64) NODE_ARCH="arm64" ;;
    *)
      echo "Unsupported architecture for Node.js download: $(uname -m)" >&2
      exit 1
      ;;
  esac

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  TARBALL="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -Eo "node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz" | head -n 1)"
  if [ -z "$TARBALL" ]; then
    echo "Failed to resolve latest Node.js v24 tarball for linux-${NODE_ARCH}" >&2
    exit 1
  fi
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/${TARBALL}" -o "$TMP_DIR/$TARBALL"
  mkdir -p "$NODE_PREFIX"
  rm -rf "${NODE_PREFIX:?}"/*
  tar -xJf "$TMP_DIR/$TARBALL" --strip-components=1 -C "$NODE_PREFIX"
  rm -rf "$TMP_DIR"
  trap - EXIT

  export PATH="$NODE_PREFIX/bin:$PATH"
  append_line_once 'export PATH="$HOME/.local/node/bin:$PATH"' "$BASHRC"
fi

# 3. Install workspace and subproject dependencies idempotently.
cd "$REPO_ROOT"

# Hoisted linker matches Dockerfile/CI so shared/ resolves workspace dependencies.
bun install --frozen-lockfile --omit=peer --linker hoisted
[ -f .env ] || cp .env.example .env
bun run generate:app-config

(cd agent-computer && bun install --frozen-lockfile --omit=peer)
npm ci --prefix runtime/dsh --no-audit --no-fund
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --prefix pc --no-audit --no-fund
