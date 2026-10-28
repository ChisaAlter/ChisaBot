#!/bin/bash
# 依赖 / 底座指纹（docs/online-update.md）：这些文件变了，一键更新（只替换代码层）就做不了。
# 根 package.json 只取去掉顶层 "version" 行之后的内容：改版本号不算依赖变化。
# 用法：deps-fingerprint.sh <提交>   （读 /opt/chisabot-updater/mirror.git）
set -euo pipefail
G="git --git-dir=/opt/chisabot-updater/mirror.git"
{
  $G ls-tree -r "$1" -- \
    bun.lock tsconfig.base.json bunfig.toml app/package.json server/package.json Dockerfile docker \
    agent-computer/package.json agent-computer/bun.lock
  echo "package.json (without version):"
  $G show "$1:package.json" | sed '/^  "version": /d'
} | sha256sum | cut -d' ' -f1
