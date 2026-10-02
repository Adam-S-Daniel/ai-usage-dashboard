# Runs the tests with Pester 5 when installed; otherwise with a minimal built-in shim
# that supports BeforeAll / Describe / It / Should -Be.
$testFile = "$PSScriptRoot/AiUsage.Tests.ps1"
if (Get-Module -ListAvailable Pester | Where-Object { $_.Version.Major -ge 5 }) {
    $r = Invoke-Pester -Path $testFile -PassThru
    exit $r.FailedCount
}

$script:Fail = 0; $script:Pass = 0
function BeforeAll([scriptblock]$Block) { . $Block }
function Describe([string]$Name, [scriptblock]$Block) { Write-Host $Name; . $Block }
function It([string]$Name, [scriptblock]$Block) {
    try { . $Block; $script:Pass++; Write-Host "  [+] $Name" }
    catch { $script:Fail++; Write-Host "  [-] $Name`n      $($_.Exception.Message)" }
}
function Should {
    param([Parameter(ValueFromPipeline)]$Actual, [switch]$Be, [Parameter(Position = 0)]$Expected)
    begin { $items = [System.Collections.Generic.List[object]]::new() }
    process { $items.Add($Actual) }
    end {
        $a = if ($items.Count -eq 1) { $items[0] } elseif ($items.Count -eq 0) { $null } else { $items }
        if (-not ($a -eq $Expected) -and -not ($null -eq $a -and $null -eq $Expected)) {
            throw "Expected '$Expected' but got '$a'"
        }
    }
}
. $testFile
Write-Host "`nPassed: $script:Pass  Failed: $script:Fail"
exit $script:Fail
