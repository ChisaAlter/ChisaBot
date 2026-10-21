# Hermes runs only on the deployment server. Local development uses fake ACP tests.
$ErrorActionPreference = "Stop"
throw "Local Hermes startup is disabled. Deploy with deploy/install-hermes-runtime.sh on the server; run bun test examples/acp-agent/bridge.test.ts for local protocol tests."
