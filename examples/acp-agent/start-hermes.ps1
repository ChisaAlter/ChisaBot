# Start the ACP ↔ AG-UI bridge with Hermes as the agent.
#
#   powershell -ExecutionPolicy Bypass -File examples/acp-agent/start-hermes.ps1
#
# Then set CHISABOT_HERMES_URL=http://127.0.0.1:4100/ag-ui in ChisaBot's .env and restart it.
# The bridge owns the Hermes process; closing this window stops both.

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

$hermesAcp = Join-Path $env:LOCALAPPDATA "hermes\hermes-agent\.venv\Scripts\hermes-acp.exe"
if (Test-Path $hermesAcp) {
  $env:ACP_AGENT_CMD = "`"$hermesAcp`""
} else {
  $hermes = Get-Command hermes -ErrorAction SilentlyContinue
  if (-not $hermes) {
    $candidate = Join-Path $env:LOCALAPPDATA "hermes\bin\hermes.exe"
    if (Test-Path $candidate) { $hermes = Get-Item $candidate } else {
      throw "hermes not found. Finish the Hermes install (or add it to PATH), then retry."
    }
  }
  $env:ACP_AGENT_CMD = "`"$($hermes.Source)`" acp"
}
$workspace = Join-Path $root ".local-run\hermes-workspace"
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
$env:ACP_CWD = $workspace
# The bot's shell/file tools act in ACP_CWD. This is a dedicated workspace rather than the ChisaBot
# checkout, so a task cannot edit the product's own source by accident.
# $env:ACP_CWD = "C:\Users\me\hermes-workspace"

# Permission requests from Hermes are auto-approved by default. Uncomment to refuse every one:
# $env:ACP_APPROVAL = "deny"

# If ChisaBot and the bridge are not on the same machine, set a token and the same value in
# CHISABOT_HERMES_TOKEN:
# $env:ACP_BRIDGE_TOKEN = "change-me"

$bun = (Get-Command bun -ErrorAction SilentlyContinue)
if (-not $bun) {
  $fallback = Join-Path $env:APPDATA "npm\node_modules\bun\bin\bun.exe"
  if (Test-Path $fallback) { $bun = Get-Item $fallback } else { throw "bun not found on PATH." }
}

Write-Host "ACP bridge: hermes acp  (cwd: $env:ACP_CWD)"
Write-Host "Register http://127.0.0.1:4100/ag-ui in ChisaBot, or set CHISABOT_HERMES_URL to it."
& $bun.Source (Join-Path $PSScriptRoot "bridge.mjs")
