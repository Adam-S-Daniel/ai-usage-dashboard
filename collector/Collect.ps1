#!/usr/bin/env pwsh
# Collects usage once and publishes it to the gist. Run by the scheduled task.
param([string]$ConfigDir = (Join-Path $HOME '.config/ai-usage'), [switch]$NoPublish)
Import-Module "$PSScriptRoot/AiUsage.psm1" -Force
try { Invoke-AiUsageCollect -ConfigDir $ConfigDir -NoPublish:$NoPublish | Out-Null }
catch {
    "$(Get-Date -Format o) $($_.Exception.Message)" | Add-Content (Join-Path $ConfigDir 'error.log')
    exit 1
}
