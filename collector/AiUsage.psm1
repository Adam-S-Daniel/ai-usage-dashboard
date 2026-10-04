Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

# ---------- pure helpers (covered by tests) ----------

function ConvertTo-IsoUtc($Value) {
    if ($null -eq $Value -or $Value -eq '') { return $null }
    $d = if ($Value -is [datetimeoffset]) { $Value }
    elseif ($Value -is [datetime]) { [datetimeoffset]$Value.ToUniversalTime() }
    elseif ($Value -is [string]) { [datetimeoffset]::Parse($Value, [cultureinfo]::InvariantCulture) }
    else { [datetimeoffset]::FromUnixTimeSeconds([long]$Value) }
    $d.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
}

function Get-Prop($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] } else { return $null } }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { $p.Value } else { $null }
}

function ConvertTo-ClaudeSource {
    param($Response, [string]$Plan, [datetimeoffset]$Now)
    $defs = @(
        @{ id = 'five_hour'; label = 'Session (5 h)'; period = 18000 }
        @{ id = 'seven_day'; label = 'Week, all models'; period = 604800 }
        @{ id = 'seven_day_opus'; label = 'Week, Opus'; period = 604800 }
        @{ id = 'seven_day_sonnet'; label = 'Week, Sonnet'; period = 604800 }
    )
    $windows = foreach ($d in $defs) {
        $w = Get-Prop $Response $d.id
        if ($null -eq $w) { continue }
        $u = Get-Prop $w 'utilization'
        if ($null -eq $u) { continue }
        [ordered]@{
            id = $d.id; label = $d.label; used_pct = [double]$u
            resets_at = ConvertTo-IsoUtc (Get-Prop $w 'resets_at'); period_seconds = $d.period
        }
    }
    [ordered]@{ ok = $true; fetched_at = ConvertTo-IsoUtc $Now; plan = $Plan; windows = @($windows) }
}

function Get-WindowLabel([long]$Seconds) {
    if ($Seconds -eq 18000) { return 'Session (5 h)' }
    if ($Seconds -eq 604800) { return 'Week' }
    if ($Seconds % 86400 -eq 0) { return "$($Seconds / 86400)-day window" }
    "$([math]::Round($Seconds / 3600))-hour window"
}

function ConvertTo-CodexSource {
    param($Response, [datetimeoffset]$Now)
    $rl = Get-Prop $Response 'rate_limit'
    $defs = @(
        @{ id = 'primary_window'; period = 18000 }
        @{ id = 'secondary_window'; period = 604800 }
    )
    $windows = foreach ($d in $defs) {
        $w = Get-Prop $rl $d.id
        if ($null -eq $w) { continue }
        $u = Get-Prop $w 'used_percent'
        if ($null -eq $u) { continue }
        # The plan decides how long each window is (some plans only have a weekly one),
        # so the label comes from the reported length, not from primary/secondary.
        $period = Get-Prop $w 'limit_window_seconds'
        $period = if ($period) { [int]$period } else { $d.period }
        [ordered]@{
            id = $d.id; label = Get-WindowLabel $period; used_pct = [double]$u
            resets_at = ConvertTo-IsoUtc (Get-Prop $w 'reset_at'); period_seconds = $period
        }
    }
    [ordered]@{ ok = $true; fetched_at = ConvertTo-IsoUtc $Now; plan = (Get-Prop $Response 'plan_type'); windows = @($windows) }
}

function Expand-ReportRows($Pages) {
    # Yields @{date; row} for both bucketed ({starting_at, results[]}) and flat ({date, ...}) shapes.
    foreach ($page in $Pages) {
        foreach ($item in @(Get-Prop $page 'data')) {
            if ($null -eq $item) { continue }
            if ($item.PSObject.Properties['results']) {
                $date = (ConvertTo-IsoUtc $item.starting_at).Substring(0, 10)
                foreach ($r in @($item.results)) { if ($r) { @{ date = $date; row = $r } } }
            }
            else { @{ date = [string](Get-Prop $item 'date'); row = $item } }
        }
    }
}

# The page draws only per-model totals and per-day, per-model costs, so rows are summed to one per (date, model)
# in each list. The page enforces limits (10000 rows per list, 300 distinct models, 200-character strings,
# usd >= 0) and this function applies the same ones, reporting an error instead of publishing a document the
# page would reject. 300 days (the config maximum) fits with up to 33 models a day.
$script:MaxPlatformRows = 10000
$script:MaxPlatformModels = 300
$script:MaxModelChars = 200

# Model names are case-sensitive keys ([ordered]@{} would merge "Model" and "model").
function New-RowIndex { [System.Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal) }

function ConvertTo-PlatformSource {
    param($UsagePages, $CostPages, [datetimeoffset]$Now)
    $usage = New-RowIndex
    foreach ($e in Expand-ReportRows $UsagePages) {
        $r = $e.row
        $in = Get-Prop $r 'uncached_input_tokens'; if ($null -eq $in) { $in = Get-Prop $r 'input_tokens' }
        $cc = Get-Prop $r 'cache_creation'
        $cw = if ($cc) { [long](Get-Prop $cc 'ephemeral_1h_input_tokens') + [long](Get-Prop $cc 'ephemeral_5m_input_tokens') }
        else { [long](Get-Prop $r 'cache_creation_input_tokens') }
        $row = [ordered]@{
            date = $e.date; model = [string](Get-Prop $r 'model'); input = [long]$in; cache_write = $cw
            cache_read = [long](Get-Prop $r 'cache_read_input_tokens'); output = [long](Get-Prop $r 'output_tokens')
        }
        $k = "$($row.date)|$($row.model)"
        if ($usage.Contains($k)) { foreach ($f in 'input', 'cache_write', 'cache_read', 'output') { $usage[$k][$f] += $row[$f] } }
        else { $usage[$k] = $row }
    }
    $cents = New-RowIndex
    foreach ($e in Expand-ReportRows $CostPages) {
        $r = $e.row
        $model = Get-Prop $r 'model'; if (-not $model) { $model = Get-Prop $r 'description' }
        # amount is a decimal string in cents; summed as decimals so the total carries no floating-point noise
        $c = [decimal]::Parse([string]$r.amount, [cultureinfo]::InvariantCulture)
        $k = "$($e.date)|$([string]$model)"
        if ($cents.Contains($k)) { $cents[$k].cents += $c } else { $cents[$k] = @{ date = $e.date; model = [string]$model; cents = $c } }
    }
    # The page rejects a negative cost, so a (date, model) total below zero (a net credit) is shown as 0 and counted.
    $floored = 0
    $costs = foreach ($v in $cents.Values) {
        if ($v.cents -lt 0) { $floored++; $v.cents = [decimal]0 }
        [ordered]@{ date = $v.date; model = $v.model; usd = [double]($v.cents / 100) }
    }
    $models = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($m in @($usage.Values | % { $_.model }) + @($cents.Values | % { $_.model })) { [void]$models.Add($m) }
    if ($usage.Count -gt $script:MaxPlatformRows -or $cents.Count -gt $script:MaxPlatformRows) {
        return @{ ok = $false; error = "Too many usage rows for the page ($($usage.Count) usage, $($cents.Count) cost; the limit is $script:MaxPlatformRows). Lower days in config.json." }
    }
    if ($models.Count -gt $script:MaxPlatformModels) {
        return @{ ok = $false; error = "Too many models for the page ($($models.Count); the limit is $script:MaxPlatformModels)." }
    }
    if (@($models | ? { $_.Length -gt $script:MaxModelChars }).Count) {
        return @{ ok = $false; error = "A model name is longer than the page accepts ($script:MaxModelChars characters)." }
    }
    $out = [ordered]@{ ok = $true; fetched_at = ConvertTo-IsoUtc $Now; usage = @($usage.Values); costs = @($costs) }
    if ($floored) { $out.floored_credits = $floored }
    $out
}

# A short, fixed vocabulary, never the raw exception text: that text can echo URLs, headers or response bodies
# on some platforms, and the page has no use for free-form detail. Input is the exception and the source name.
function Get-ErrorText {
    param($Exception, [string]$Source)
    $m = [string]$Exception.Message
    $code = try { [int]$Exception.Response.StatusCode } catch { 0 }
    if (-not $code -and $m -match 'status code does not indicate success: (\d{3})') { $code = [int]$Matches[1] }
    $what = if ($m -like 'Federation was refused (401)*') { 'federation refused (HTTP 401); check the rule and issuer in the Console' }
    elseif ($m -like 'No Claude Code login found*') { 'no Claude Code login; run claude and log in' }
    elseif ($m -like 'Claude Code token expired*') { 'Claude Code login expired; open Claude Code to renew it' }
    elseif ($m -like 'No Codex ChatGPT login found*') { 'no Codex login; run codex login' }
    elseif ($m -like 'Claude platform access is not set up*') { 'platform access is not set up; run Install.ps1 -SetupWif' }
    elseif ($m -like 'Token exchange failed*') { if ($code) { "token exchange failed (HTTP $code)" } else { 'token exchange failed' } }
    elseif ($m -like 'Could not create a key in the TPM*' -or $m -like 'Signing key *' -or $m -like 'The TPM-backed*') { 'signing key unavailable' }
    elseif ($code) { "HTTP $code" }
    elseif ($m -match '(?i)timeout|timed out') { 'timeout' }
    elseif ($m -match '(?i)name or service not known|no such host|nodename nor servname|temporary failure in name resolution') { 'DNS failure' }
    elseif ($m -match '(?i)refused') { 'connection refused' }
    else { 'request failed' }
    "${Source}: $what"
}

function Merge-Source {
    param($Previous, $Result)
    if ($Result.ok) { return $Result }
    $out = [ordered]@{}
    if ($Previous -is [System.Collections.IDictionary]) { foreach ($k in $Previous.Keys) { $out[$k] = $Previous[$k] } }
    elseif ($Previous) { foreach ($p in $Previous.PSObject.Properties) { $out[$p.Name] = $p.Value } }
    $out.ok = $false
    $out.error = $Result.error
    $out
}

function Select-ClaudeCredential {
    param([string[]]$JsonCandidates)
    $best = $null
    foreach ($j in $JsonCandidates) {
        if ([string]::IsNullOrWhiteSpace($j)) { continue }
        try { $o = (ConvertFrom-Json $j).claudeAiOauth } catch { continue }
        if (-not (Get-Prop $o 'accessToken')) { continue }
        if ($null -eq $best -or [long]$o.expiresAt -gt [long]$best.expiresAt) { $best = $o }
    }
    $best
}

function Get-CodexCredential {
    param([string]$Json)
    try { $t = Get-Prop (ConvertFrom-Json $Json) 'tokens' } catch { return $null }
    $tok = Get-Prop $t 'access_token'
    if (-not $tok) { return $null }
    @{ accessToken = $tok; accountId = (Get-Prop $t 'account_id') }
}

# ---------- workload identity federation (pure parts) ----------
# The laptop acts as its own OIDC issuer: it signs a short-lived JWT with a private key that
# never leaves the TPM, and trades it for a short-lived Claude platform token.

function ConvertTo-Base64Url([byte[]]$Bytes) {
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-Base64Url([string]$Text) {
    $b = $Text.Replace('-', '+').Replace('_', '/')
    [Convert]::FromBase64String($b.PadRight($b.Length + (4 - $b.Length % 4) % 4, '='))
}

function ConvertTo-Jwk {
    param([System.Security.Cryptography.RSA]$Rsa)
    $p = $Rsa.ExportParameters($false)   # public half only
    $n = ConvertTo-Base64Url $p.Modulus
    $e = ConvertTo-Base64Url $p.Exponent
    # kid = RFC 7638 thumbprint (members in lexical order, no whitespace)
    $canon = '{"e":"' + $e + '","kty":"RSA","n":"' + $n + '"}'
    $kid = ConvertTo-Base64Url ([System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canon)))
    [ordered]@{ kty = 'RSA'; n = $n; e = $e; alg = 'RS256'; use = 'sig'; kid = $kid }
}

function New-WifAssertion {
    param($Wif, [System.Security.Cryptography.RSA]$Rsa, [datetimeoffset]$Now, [int]$LifetimeSeconds = 120)
    $t = $Now.ToUnixTimeSeconds()
    $header = [ordered]@{ alg = 'RS256'; typ = 'JWT'; kid = (ConvertTo-Jwk -Rsa $Rsa).kid }
    $claims = [ordered]@{
        iss = Get-Prop $Wif 'issuer'; sub = Get-Prop $Wif 'subject'; aud = Get-Prop $Wif 'audience'
        iat = $t - 10; exp = $t + $LifetimeSeconds; jti = [guid]::NewGuid().ToString('N')   # jti makes each assertion single-use
    }
    $enc = { param($o) ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress))) }
    $signing = (& $enc $header) + '.' + (& $enc $claims)
    $sig = $Rsa.SignData([Text.Encoding]::ASCII.GetBytes($signing), [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $signing + '.' + (ConvertTo-Base64Url $sig)
}

function New-WifTokenRequest {
    param($Wif, [string]$Assertion)
    $body = [ordered]@{
        grant_type         = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
        assertion          = $Assertion
        federation_rule_id = Get-Prop $Wif 'ruleId'
        organization_id    = Get-Prop $Wif 'organizationId'
        service_account_id = Get-Prop $Wif 'serviceAccountId'
    }
    if (Get-Prop $Wif 'workspaceId') { $body.workspace_id = Get-Prop $Wif 'workspaceId' }
    $body
}

function Select-PlatformAuth {
    # 'wif' when federation is fully configured, else 'key' when an API key is stored, else nothing.
    param($Config, [string]$AdminKey)
    $wif = Get-Prop $Config 'wif'
    if ((Get-Prop $wif 'ruleId') -and (Get-Prop $wif 'organizationId') -and (Get-Prop $wif 'serviceAccountId')) { return 'wif' }
    if ($AdminKey) { return 'key' }
    $null
}

# ---------- gist encryption (pure) ----------
# The gist is readable by anyone with its id, and every revision stays public, so the document is
# AES-256-GCM encrypted. The key travels only in the dashboard link's #fragment, which no server sees.

function New-UsageKey { ConvertTo-Base64Url ([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) }

function Get-UsageKeyBytes([string]$Key) {
    $k = try { ConvertFrom-Base64Url $Key } catch { $null }
    if ($null -eq $k -or $k.Length -ne 32) { throw 'The usage key must be 32 bytes, base64url.' }
    , $k
}

function Protect-UsageJson {
    param([string]$Json, [string]$Key)
    $kb = Get-UsageKeyBytes $Key
    $iv = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(12)   # fresh per publish
    $plain = [Text.Encoding]::UTF8.GetBytes($Json)
    $ct = [byte[]]::new($plain.Length); $tag = [byte[]]::new(16)
    $aes = [System.Security.Cryptography.AesGcm]::new($kb, 16)
    try { $aes.Encrypt($iv, $plain, $ct, $tag) } finally { $aes.Dispose() }
    [ordered]@{ v = 1; enc = 'A256GCM'; iv = ConvertTo-Base64Url $iv; ct = ConvertTo-Base64Url ([byte[]]($ct + $tag)) } | ConvertTo-Json -Compress
}

function Unprotect-UsageJson {
    # Throws on a wrong key or any tampering (bad tag).
    param([string]$Envelope, [string]$Key)
    $kb = Get-UsageKeyBytes $Key
    $e = ConvertFrom-Json $Envelope
    if ((Get-Prop $e 'v') -ne 1 -or (Get-Prop $e 'enc') -ne 'A256GCM') { throw 'Not a usage envelope.' }
    $iv = ConvertFrom-Base64Url $e.iv
    $all = ConvertFrom-Base64Url $e.ct
    if ($iv.Length -ne 12 -or $all.Length -lt 16) { throw 'Malformed usage envelope.' }
    $n = $all.Length - 16
    $ct = [byte[]]$all[0..($n - 1)]; $tag = [byte[]]$all[$n..($all.Length - 1)]
    if ($n -eq 0) { $ct = [byte[]]::new(0) }
    $plain = [byte[]]::new($n)
    $aes = [System.Security.Cryptography.AesGcm]::new($kb, 16)
    try { $aes.Decrypt($iv, $ct, $tag, $plain) } finally { $aes.Dispose() }
    [Text.Encoding]::UTF8.GetString($plain)
}

# ---------- I/O (thin wrappers) ----------

function Get-WifKey {
    # Opens (or with -Create, makes) a 2048-bit RSA signing key held by the TPM. The private key
    # cannot be exported, by this user or anyone else; only this Windows user can ask it to sign.
    param([string]$Name = 'ai-usage-wif', [switch]$Create)
    if (-not $IsWindows) { throw 'The TPM-backed signing key is only supported on Windows.' }
    $provider = [System.Security.Cryptography.CngProvider]::new('Microsoft Platform Crypto Provider')
    if ([System.Security.Cryptography.CngKey]::Exists($Name, $provider)) {
        $key = [System.Security.Cryptography.CngKey]::Open($Name, $provider)
    }
    elseif ($Create) {
        $p = [System.Security.Cryptography.CngKeyCreationParameters]::new()
        $p.Provider = $provider
        $p.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
        $p.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
        $p.Parameters.Add([System.Security.Cryptography.CngProperty]::new('Length', [BitConverter]::GetBytes(2048),
                [System.Security.Cryptography.CngPropertyOptions]::None))
        try { $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::Rsa, $Name, $p) }
        catch { throw "Could not create a key in the TPM (is the TPM present and enabled?): $($_.Exception.Message)" }
    }
    else { throw "Signing key '$Name' not found. Run Install.ps1 -SetupWif." }
    [System.Security.Cryptography.RSACng]::new($key)
}

function Get-WifToken($Wif, [datetimeoffset]$Now) {
    $name = Get-Prop $Wif 'keyName'
    $rsa = if ($name) { Get-WifKey -Name $name } else { Get-WifKey }
    try { $assertion = New-WifAssertion -Wif $Wif -Rsa $rsa -Now $Now } finally { $rsa.Dispose() }
    $body = New-WifTokenRequest -Wif $Wif -Assertion $assertion | ConvertTo-Json -Compress
    try {
        # Same request the official SDK sends for a jwt-bearer exchange.
        $r = Invoke-RestMethod -Method Post -Uri 'https://api.anthropic.com/v1/oauth/token' -ContentType 'application/json' `
            -Body $body -TimeoutSec 30 -Headers @{ 'anthropic-beta' = 'oauth-2025-04-20,oidc-federation-2026-04-01' }
    }
    catch {
        $code = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
        if ($code -eq 401) { throw 'Federation was refused (401). Check the rule (issuer, subject, audience, service account) and the events on the Console Workload identity page.' }
        throw "Token exchange failed: $($_.Exception.Message)"
    }
    $r.access_token
}

function Get-PlatformHeaders($Config, [string]$ConfigDir, [datetimeoffset]$Now) {
    $key = Read-AdminKey -ConfigDir $ConfigDir
    switch (Select-PlatformAuth -Config $Config -AdminKey $key) {
        'wif' { @{ Authorization = "Bearer $(Get-WifToken (Get-Prop $Config 'wif') $Now)"; 'anthropic-beta' = 'oauth-2025-04-20'; 'anthropic-version' = '2023-06-01' } }
        'key' { @{ 'x-api-key' = $key; 'anthropic-version' = '2023-06-01' } }
        default { throw 'Claude platform access is not set up. Run Install.ps1 -SetupWif (or -SetAdminKey).' }
    }
}

# The admin key is kept as a SecureString exported with Export-Clixml. On Windows that is
# DPAPI encryption bound to the current Windows user on this machine.
function Save-AdminKey {
    param([string]$ConfigDir, [securestring]$Key)
    $Key | Export-Clixml -LiteralPath (Join-Path $ConfigDir 'adminkey.xml') -Force
}

function Read-AdminKey {
    param([string]$ConfigDir)
    $path = Join-Path $ConfigDir 'adminkey.xml'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    [System.Net.NetworkCredential]::new('', (Import-Clixml -LiteralPath $path)).Password
}

function Read-TextIfExists([string]$Path) { if (Test-Path -LiteralPath $Path) { Get-Content -Raw -LiteralPath $Path } }

function Get-ClaudeCredentialCandidates {
    $list = @(Read-TextIfExists (Join-Path $HOME '.claude/.credentials.json'))
    if ($IsWindows -and (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
        # Only read from WSL when it is already running, so this never boots it.
        $running = ((wsl.exe --list --running --quiet 2>$null) -join '') -replace "`0", ''
        if ($running.Trim()) { $list += ((wsl.exe -e sh -c 'cat ~/.claude/.credentials.json 2>/dev/null') -join "`n") }
    }
    $list
}

function Get-ClaudeSource([datetimeoffset]$Now) {
    $cred = Select-ClaudeCredential -JsonCandidates (Get-ClaudeCredentialCandidates)
    if (-not $cred) { throw 'No Claude Code login found. Run `claude` and log in.' }
    if ([long]$cred.expiresAt -lt $Now.ToUnixTimeMilliseconds()) { throw 'Claude Code token expired. Open Claude Code to renew it.' }
    $resp = Invoke-RestMethod -Uri 'https://api.anthropic.com/api/oauth/usage' -TimeoutSec 30 -Headers @{
        Authorization = "Bearer $($cred.accessToken)"; 'anthropic-beta' = 'oauth-2025-04-20'; 'User-Agent' = 'claude-code/2.0.0'
    }
    ConvertTo-ClaudeSource -Response $resp -Plan (Get-Prop $cred 'subscriptionType') -Now $Now
}

function Get-CodexSource([datetimeoffset]$Now) {
    $json = Read-TextIfExists (Join-Path $HOME '.codex/auth.json')
    $cred = if ($json) { Get-CodexCredential -Json $json }
    if (-not $cred) { throw 'No Codex ChatGPT login found. Run `codex login`.' }
    $headers = @{ Authorization = "Bearer $($cred.accessToken)"; 'User-Agent' = 'codex-cli' }
    if ($cred.accountId) { $headers['ChatGPT-Account-Id'] = $cred.accountId }
    $resp = Invoke-RestMethod -Uri 'https://chatgpt.com/backend-api/wham/usage' -TimeoutSec 30 -Headers $headers
    ConvertTo-CodexSource -Response $resp -Now $Now
}

function Get-ReportPages([string]$Url, $Headers) {
    $page = $null
    for ($i = 0; $i -lt 10; $i++) {
        $u = if ($page) { "$Url&page=$page" } else { $Url }
        $r = Invoke-RestMethod -Uri $u -TimeoutSec 30 -Headers $Headers
        $r
        if (-not (Get-Prop $r 'has_more')) { break }
        $page = $r.next_page
    }
}

# How many days of platform history to fetch (config.json "days"). Default 30, maximum 300: Get-ReportPages
# reads at most 10 pages of 31 daily buckets (310), and the page rejects rows older than 398 days.
function Get-CollectDays($Config) {
    $n = 0
    if (-not [int]::TryParse([string](Get-Prop $Config 'days'), [ref]$n) -or $n -le 0) { return 30 }
    [Math]::Min(300, $n)
}

function Get-PlatformSource([datetimeoffset]$Now, $Headers, [int]$Days) {
    $end = $Now.UtcDateTime.Date.AddDays(1).ToString('yyyy-MM-ddT00:00:00Z')
    $start = $Now.UtcDateTime.Date.AddDays(1 - $Days).ToString('yyyy-MM-ddT00:00:00Z')
    $base = 'https://api.anthropic.com/v1/organizations'
    $q = "starting_at=$start&ending_at=$end&bucket_width=1d&limit=31"
    $usage = @(Get-ReportPages "$base/usage_report/messages?$q&group_by[]=model" $Headers)
    $cost = @(Get-ReportPages "$base/cost_report?$q&group_by[]=description" $Headers)
    ConvertTo-PlatformSource -UsagePages $usage -CostPages $cost -Now $Now
}

function Publish-Gist([string]$GistId, [string]$Json) {
    $tmp = New-TemporaryFile
    try {
        @{ files = @{ 'usage.json' = @{ content = $Json } } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding utf8
        $out = gh api --method PATCH "gists/$GistId" --input $tmp.FullName --silent 2>&1
        if ($LASTEXITCODE -ne 0) { throw "gh failed: $out" }
    }
    finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
}

# What gets published, after encryption: compact JSON, at most 3.5 MB (the page refuses 4 MB; encryption adds a third).
# If it is too big the platform source is replaced by an error so the limits still publish, never a document the page rejects.
$script:MaxPublishBytes = 3500000

function New-PublishPayload {
    param($Sources, [datetimeoffset]$Now, [string]$Key, [int]$MaxBytes = $script:MaxPublishBytes)
    $build = {
        $j = [ordered]@{ schema = 1; generated_at = ConvertTo-IsoUtc $Now; host = [Environment]::MachineName; sources = $Sources } | ConvertTo-Json -Depth 8 -Compress
        @{ json = $j; text = $(if ($Key) { Protect-UsageJson -Json $j -Key $Key } else { $j }) }
    }
    $r = & $build
    if ([Text.Encoding]::UTF8.GetByteCount($r.text) -gt $MaxBytes) {
        $Sources['platform'] = [ordered]@{ ok = $false; error = 'platform: too much data for the page; lower days in config.json' }
        $r = & $build
        if ([Text.Encoding]::UTF8.GetByteCount($r.text) -gt $MaxBytes) { throw 'The usage document is too large for the page.' }
    }
    $r
}

function Invoke-AiUsageCollect {
    param([string]$ConfigDir = (Join-Path $HOME '.config/ai-usage'), [switch]$NoPublish)
    $config = Get-Content -Raw (Join-Path $ConfigDir 'config.json') | ConvertFrom-Json
    $statePath = Join-Path $ConfigDir 'usage.json'
    $prev = if (Test-Path $statePath) { try { (Get-Content -Raw $statePath | ConvertFrom-Json).sources } catch { $null } }
    $now = [datetimeoffset]::UtcNow
    $days = Get-CollectDays $config
    $fetchers = [ordered]@{
        claude   = { Get-ClaudeSource $now }
        codex    = { Get-CodexSource $now }
        platform = { Get-PlatformSource $now (Get-PlatformHeaders $config $ConfigDir $now) $days }
    }
    $sources = [ordered]@{}
    foreach ($name in $fetchers.Keys) {
        $result = try { & $fetchers[$name] } catch { @{ ok = $false; error = Get-ErrorText $_.Exception $name } }
        $sources[$name] = Merge-Source -Previous (Get-Prop $prev $name) -Result $result
    }
    # Encrypted when the install has a key; an older install keeps publishing plaintext until Install.ps1 reruns.
    $payload = New-PublishPayload -Sources $sources -Now $now -Key (Get-Prop $config 'key')
    Set-Content -LiteralPath $statePath -Value $payload.json -Encoding utf8
    if (-not $NoPublish) { Publish-Gist -GistId $config.gistId -Json $payload.text }
    $payload.json
}

Export-ModuleMember -Function ConvertTo-*, ConvertFrom-Base64Url, New-UsageKey, Protect-UsageJson, Unprotect-UsageJson, Get-WindowLabel, New-Wif*, Select-PlatformAuth, Get-WifKey, Merge-Source, Get-ErrorText, New-PublishPayload, Get-CollectDays, Select-ClaudeCredential, Get-CodexCredential, Save-AdminKey, Read-AdminKey, Invoke-AiUsageCollect
