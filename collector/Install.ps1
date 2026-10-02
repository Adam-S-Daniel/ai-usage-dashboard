#!/usr/bin/env pwsh
#Requires -Version 7
# One-time setup on Windows: creates the secret gist + config, registers a
# scheduled task that runs Collect.ps1 every N minutes, and prints the dashboard URL.
param(
    [switch]$SetAdminKey,                   # prompt for the Claude platform admin key and store it encrypted
    [int]$EveryMinutes = 5,
    [string]$PagesUrl,
    [string]$ConfigDir = (Join-Path $HOME '.config/ai-usage')
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$taskName = 'AiUsageCollector'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) is required: winget install GitHub.cli' }
gh auth status *> $null; if ($LASTEXITCODE -ne 0) { throw 'Run `gh auth login` first (needs the gist scope).' }

New-Item -ItemType Directory -Force $ConfigDir | Out-Null
$configPath = Join-Path $ConfigDir 'config.json'
$config = if (Test-Path $configPath) { Get-Content -Raw $configPath | ConvertFrom-Json -AsHashtable } else { @{} }

if (-not $config.gistId) {
    $seed = Join-Path ([IO.Path]::GetTempPath()) 'usage.json'
    '{}' | Set-Content $seed
    $url = gh gist create $seed --desc 'AI usage dashboard data'   # secret by default
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the gist. Try: gh auth refresh -s gist' }
    $config.gistId = ($url | Select-Object -Last 1).Trim().Split('/')[-1]
}
Import-Module (Join-Path $PSScriptRoot 'AiUsage.psm1') -Force
# The key is typed at a hidden prompt (never a command-line argument, so it stays out of shell
# history) and stored DPAPI-encrypted for this Windows user. A plain-text key left in
# config.json by an earlier version is moved into the encrypted file.
if ($config.adminKey) {
    Save-AdminKey -ConfigDir $ConfigDir -Key (ConvertTo-SecureString $config.adminKey -AsPlainText -Force)
    $config.Remove('adminKey')
}
if ($SetAdminKey) {
    $key = Read-Host 'Claude platform admin key (input hidden)' -AsSecureString
    if ($key.Length -gt 0) { Save-AdminKey -ConfigDir $ConfigDir -Key $key }
}
$config | ConvertTo-Json | Set-Content $configPath -Encoding utf8

# Publish the page: create the public repo on first run (code only, no usage data), then turn on GitHub Pages.
$root = Split-Path $PSScriptRoot
if (-not (Test-Path (Join-Path $root '.git'))) {
    git -C $root init -q -b main; git -C $root add -A; git -C $root commit -q -m 'AI usage dashboard'
}
if (-not (git -C $root remote)) {
    Push-Location $root
    gh repo create ai-usage-dashboard --public --source . --push
    Pop-Location
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the GitHub repo.' }
}
Push-Location $root; $repo = gh repo view --json nameWithOwner -q .nameWithOwner; Pop-Location
gh api -X POST "repos/$repo/pages" -f 'source[branch]=main' -f 'source[path]=/' *> $null   # fails harmlessly if already on
if (-not $PagesUrl) { $o, $n = $repo.ToLower().Split('/'); $PagesUrl = "https://$o.github.io/$n/" }

$collect = Join-Path $PSScriptRoot 'Collect.ps1'
$pwsh = (Get-Process -Id $PID).Path
# conhost --headless keeps a console window from flashing on every run.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$pwsh`" -NoProfile -File `"$collect`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

& $collect -ConfigDir $ConfigDir
Get-Content -Raw (Join-Path $ConfigDir 'usage.json') | ConvertFrom-Json | ForEach-Object {
    foreach ($s in $_.sources.PSObject.Properties) {
        '{0,-9} {1}' -f $s.Name, ($s.Value.ok ? 'ok' : "not ready: $($s.Value.error)")
    }
}
"`nScheduled task '$taskName' runs every $EveryMinutes min."
"Dashboard: $PagesUrl#$($config.gistId)"
