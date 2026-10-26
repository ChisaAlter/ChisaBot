param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9.-]*$')][string]$Server,
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_-]*$')][string]$User = 'root',
    [ValidateRange(1, 65535)][int]$Port = 22,
    [string]$IdentityFile,
    [string]$KnownHostsFile,
    [ValidatePattern('^/[A-Za-z0-9_./-]+$')][string]$DeploymentDirectory = '/opt/chisabot/deploy'
)
$ErrorActionPreference = 'Stop'
if ($DeploymentDirectory -match '/(?:\.|\.\.)(?:/|$)') { throw 'DeploymentDirectory must not contain dot path segments.' }
$configPath = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'Create deploy/.env from .env.example first.' }
$commonOptions = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes')
if ($IdentityFile) {
    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw 'IdentityFile does not exist.' }
    $commonOptions += @('-o', 'IdentitiesOnly=yes', '-i', (Resolve-Path -LiteralPath $IdentityFile).Path)
}
if ($KnownHostsFile) {
    if (-not (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf)) { throw 'KnownHostsFile does not exist.' }
    $commonOptions += @('-o', ('UserKnownHostsFile=' + (Resolve-Path -LiteralPath $KnownHostsFile).Path))
}
$sshOptions = $commonOptions + @('-p', [string]$Port)
$scpOptions = $commonOptions + @('-P', [string]$Port)
$target = "$User@$Server"
# Remote strings contain only strictly validated host/user/path characters.
& ssh @sshOptions $target "set -eu; umask 077; test -d '$DeploymentDirectory'; : > '$DeploymentDirectory/config.env.pending'; chmod 600 '$DeploymentDirectory/config.env.pending'"
if ($LASTEXITCODE -ne 0) { throw 'Remote deployment directory check failed.' }
$uploadDestination = $target + ':' + $DeploymentDirectory + '/config.env.pending'
& scp @scpOptions $configPath $uploadDestination
if ($LASTEXITCODE -ne 0) { throw 'Configuration upload failed.' }
$remote = @'
set -eu
umask 077
cd '__DEPLOYMENT_DIRECTORY__'
if [ ! -f .env ]; then
    tr -d '\r' < config.env.pending > .env
else
    # Preserve encryption keys and unrelated settings on an existing installation.
    awk -F= '
        FNR == NR {
            sub(/\r$/, "")
            if ($1 ~ /^(BOT_MODEL|BOT_PROVIDER|OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|CHISABOT_RUNTIME_MODE|OPENBOT_RUNTIME_MODE|SL_ENABLED|COPILOTKIT_TELEMETRY_DISABLED|DO_NOT_TRACK|CHISABOT_IMAGE|MAGPIE_NETWORK)$/ && length(substr($0, index($0, "=") + 1))) incoming[$1] = $0
            next
        }
        { sub(/\r$/, "") }
        $1 in incoming { print incoming[$1]; delete incoming[$1]; next }
        { print }
        END { for (key in incoming) print incoming[key] }
    ' config.env.pending .env > .env.next
    chmod 600 .env.next
    mv .env.next .env
fi
chmod 600 .env
rm config.env.pending
printf '%s\n' 'ChisaBot deployment configuration updated.'
sh ./start.sh
'@
$remote = $remote.Replace('__DEPLOYMENT_DIRECTORY__', $DeploymentDirectory)
$encodedConfigScript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote.Replace([string][char]13, '') + [char]10))
& ssh @sshOptions $target "printf '%s' '$encodedConfigScript' | base64 -d | sh"
if ($LASTEXITCODE -ne 0) { throw 'Server startup did not complete. Check the reported error.' }
