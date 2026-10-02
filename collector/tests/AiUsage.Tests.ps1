BeforeAll {
    Import-Module "$PSScriptRoot/../AiUsage.psm1" -Force
    $script:Now = [datetimeoffset]'2026-10-02T12:00:00Z'
}

Describe 'ConvertTo-ClaudeSource' {
    It 'maps session and weekly windows and skips null ones' {
        $resp = '{"five_hour":{"utilization":42.5,"resets_at":"2026-10-02T15:00:00+00:00"},"seven_day":{"utilization":10,"resets_at":"2026-10-06T00:00:00Z"},"seven_day_opus":null}' | ConvertFrom-Json
        $s = ConvertTo-ClaudeSource -Response $resp -Plan 'max' -Now $script:Now
        $s.ok | Should -Be $true
        $s.plan | Should -Be 'max'
        $s.fetched_at | Should -Be '2026-10-02T12:00:00Z'
        $s.windows.Count | Should -Be 2
        $s.windows[0].id | Should -Be 'five_hour'
        $s.windows[0].used_pct | Should -Be 42.5
        $s.windows[0].resets_at | Should -Be '2026-10-02T15:00:00Z'
        $s.windows[0].period_seconds | Should -Be 18000
        $s.windows[1].period_seconds | Should -Be 604800
    }
    It 'keeps a window with no reset time (no active session)' {
        $resp = '{"five_hour":{"utilization":0,"resets_at":null}}' | ConvertFrom-Json
        $s = ConvertTo-ClaudeSource -Response $resp -Plan 'pro' -Now $script:Now
        $s.windows.Count | Should -Be 1
        $s.windows[0].resets_at | Should -Be $null
    }
}

Describe 'ConvertTo-CodexSource' {
    It 'maps primary and secondary windows with unix reset times' {
        $resp = '{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":7,"reset_at":1790949600,"limit_window_seconds":18000},"secondary_window":{"used_percent":55,"reset_at":1791331200}}}' | ConvertFrom-Json
        $s = ConvertTo-CodexSource -Response $resp -Now $script:Now
        $s.ok | Should -Be $true
        $s.plan | Should -Be 'plus'
        $s.windows.Count | Should -Be 2
        $s.windows[0].used_pct | Should -Be 7
        $s.windows[0].resets_at | Should -Be '2026-10-02T14:00:00Z'
        $s.windows[0].period_seconds | Should -Be 18000
        $s.windows[1].period_seconds | Should -Be 604800
    }
    It 'handles a missing secondary window' {
        $resp = '{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":1,"reset_at":1790949600}}}' | ConvertFrom-Json
        (ConvertTo-CodexSource -Response $resp -Now $script:Now).windows.Count | Should -Be 1
    }
}

Describe 'ConvertTo-PlatformSource' {
    It 'flattens bucketed usage and cost pages by day and model' {
        $usage = '{"data":[{"starting_at":"2026-10-01T00:00:00Z","ending_at":"2026-10-02T00:00:00Z","results":[{"model":"claude-opus-5-5","uncached_input_tokens":100,"cache_creation":{"ephemeral_1h_input_tokens":5,"ephemeral_5m_input_tokens":10},"cache_read_input_tokens":200,"output_tokens":50}]},{"starting_at":"2026-10-02T00:00:00Z","ending_at":"2026-10-03T00:00:00Z","results":[]}]}' | ConvertFrom-Json
        $cost = '{"data":[{"starting_at":"2026-10-01T00:00:00Z","ending_at":"2026-10-02T00:00:00Z","results":[{"amount":"123.45","currency":"USD","description":"Claude Opus 5.5 Usage - Input Tokens","model":"claude-opus-5-5"},{"amount":"100","currency":"USD","description":"Web Search Usage","model":null}]}]}' | ConvertFrom-Json
        $s = ConvertTo-PlatformSource -UsagePages @($usage) -CostPages @($cost) -Now $script:Now
        $s.ok | Should -Be $true
        $s.usage.Count | Should -Be 1
        $s.usage[0].date | Should -Be '2026-10-01'
        $s.usage[0].model | Should -Be 'claude-opus-5-5'
        $s.usage[0].input | Should -Be 100
        $s.usage[0].cache_write | Should -Be 15
        $s.usage[0].cache_read | Should -Be 200
        $s.usage[0].output | Should -Be 50
        $s.costs.Count | Should -Be 2
        $s.costs[0].usd | Should -Be 1.2345
        $s.costs[1].model | Should -Be 'Web Search Usage'
        $s.costs[1].usd | Should -Be 1
    }
    It 'accepts flat rows with a date field' {
        $usage = '{"data":[{"date":"2026-10-01","model":"m","input_tokens":3,"cache_creation_input_tokens":1,"cache_read_input_tokens":2,"output_tokens":4}]}' | ConvertFrom-Json
        $s = ConvertTo-PlatformSource -UsagePages @($usage) -CostPages @() -Now $script:Now
        $s.usage[0].input | Should -Be 3
        $s.usage[0].cache_write | Should -Be 1
        $s.costs.Count | Should -Be 0
    }
}

Describe 'Merge-Source' {
    It 'returns the new result when it succeeded' {
        $new = @{ ok = $true; fetched_at = 'b'; windows = @() }
        (Merge-Source -Previous @{ ok = $true; fetched_at = 'a' } -Result $new).fetched_at | Should -Be 'b'
    }
    It 'keeps previous data but flags the error when the new fetch failed' {
        $prev = '{"ok":true,"fetched_at":"a","plan":"max","windows":[{"id":"five_hour"}]}' | ConvertFrom-Json
        $m = Merge-Source -Previous $prev -Result @{ ok = $false; error = 'token expired' }
        $m.ok | Should -Be $false
        $m.error | Should -Be 'token expired'
        $m.fetched_at | Should -Be 'a'
        $m.windows[0].id | Should -Be 'five_hour'
    }
    It 'returns just the error when there is no previous data' {
        $m = Merge-Source -Previous $null -Result @{ ok = $false; error = 'x' }
        $m.ok | Should -Be $false
        $m.error | Should -Be 'x'
    }
}

Describe 'Select-ClaudeCredential' {
    It 'picks the credential that expires last' {
        $a = '{"claudeAiOauth":{"accessToken":"A","expiresAt":1000,"subscriptionType":"max"}}'
        $b = '{"claudeAiOauth":{"accessToken":"B","expiresAt":2000,"subscriptionType":"max"}}'
        (Select-ClaudeCredential -JsonCandidates @($a, $null, 'not json', $b)).accessToken | Should -Be 'B'
    }
    It 'returns null when nothing is usable' {
        Select-ClaudeCredential -JsonCandidates @($null, '') | Should -Be $null
    }
}

Describe 'Get-CodexCredential' {
    It 'reads token and account id from auth.json content' {
        $c = Get-CodexCredential -Json '{"tokens":{"access_token":"T","account_id":"acct"}}'
        $c.accessToken | Should -Be 'T'
        $c.accountId | Should -Be 'acct'
    }
    It 'returns null without tokens (API-key login)' {
        Get-CodexCredential -Json '{"OPENAI_API_KEY":"sk-x"}' | Should -Be $null
    }
}

Describe 'Admin key storage' {
    It 'round-trips the key through an encrypted file without storing it in plain text' {
        $dir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid()); New-Item -ItemType Directory $dir | Out-Null
        $secure = ConvertTo-SecureString 'sk-ant-admin01-TESTVALUE' -AsPlainText -Force
        Save-AdminKey -ConfigDir $dir -Key $secure
        Read-AdminKey -ConfigDir $dir | Should -Be 'sk-ant-admin01-TESTVALUE'
        ((Get-Content -Raw (Join-Path $dir 'adminkey.xml')) -match 'sk-ant-admin01') | Should -Be $false
    }
    It 'returns null when no key is stored' {
        $dir = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid()); New-Item -ItemType Directory $dir | Out-Null
        Read-AdminKey -ConfigDir $dir | Should -Be $null
    }
}

Describe 'Workload identity federation' {
    It 'encodes bytes as unpadded base64url' {
        ConvertTo-Base64Url ([byte[]](251, 255)) | Should -Be '-_8'
    }
    It 'builds a public JWK with a stable RFC 7638 thumbprint as kid' {
        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        $jwk = ConvertTo-Jwk -Rsa $rsa
        $jwk.kty | Should -Be 'RSA'
        $jwk.alg | Should -Be 'RS256'
        $jwk.use | Should -Be 'sig'
        $jwk.kid.Length | Should -Be 43
        $jwk.kid | Should -Be (ConvertTo-Jwk -Rsa $rsa).kid
        ($jwk.Keys -contains 'd') | Should -Be $false
        $p = $rsa.ExportParameters($false)
        $jwk.n | Should -Be (ConvertTo-Base64Url $p.Modulus)
        $canon = '{"e":"' + $jwk.e + '","kty":"RSA","n":"' + $jwk.n + '"}'
        $jwk.kid | Should -Be (ConvertTo-Base64Url ([System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canon))))
    }
    It 'signs a short-lived RS256 assertion that verifies with the public key' {
        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        $wif = @{ issuer = 'https://boxy.ai-usage.internal'; subject = 'ai-usage-collector'; audience = 'https://api.anthropic.com' }
        $jwt = New-WifAssertion -Wif $wif -Rsa $rsa -Now $script:Now
        $parts = $jwt.Split('.')
        $parts.Count | Should -Be 3
        $dec = { param($s) $s = $s.Replace('-', '+').Replace('_', '/'); $s += '=' * ((4 - $s.Length % 4) % 4); [Convert]::FromBase64String($s) }
        $h = [Text.Encoding]::UTF8.GetString((& $dec $parts[0])) | ConvertFrom-Json
        $c = [Text.Encoding]::UTF8.GetString((& $dec $parts[1])) | ConvertFrom-Json
        $h.alg | Should -Be 'RS256'
        $h.kid | Should -Be (ConvertTo-Jwk -Rsa $rsa).kid
        $c.iss | Should -Be 'https://boxy.ai-usage.internal'
        $c.sub | Should -Be 'ai-usage-collector'
        $c.aud | Should -Be 'https://api.anthropic.com'
        $c.exp | Should -Be ($script:Now.ToUnixTimeSeconds() + 120)
        ($c.iat -le $script:Now.ToUnixTimeSeconds()) | Should -Be $true
        ($c.jti.Length -ge 32) | Should -Be $true
        $signed = [Text.Encoding]::ASCII.GetBytes($parts[0] + '.' + $parts[1])
        $rsa.VerifyData($signed, (& $dec $parts[2]), [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1) | Should -Be $true
        (New-WifAssertion -Wif $wif -Rsa $rsa -Now $script:Now) -eq $jwt | Should -Be $false
    }
    It 'builds the token exchange body, adding workspace_id only when set' {
        $wif = @{ ruleId = 'fdrl_1'; organizationId = 'org-uuid'; serviceAccountId = 'svac_1' }
        $b = New-WifTokenRequest -Wif $wif -Assertion 'a.b.c'
        $b.grant_type | Should -Be 'urn:ietf:params:oauth:grant-type:jwt-bearer'
        $b.assertion | Should -Be 'a.b.c'
        $b.federation_rule_id | Should -Be 'fdrl_1'
        $b.organization_id | Should -Be 'org-uuid'
        $b.service_account_id | Should -Be 'svac_1'
        $b.Contains('workspace_id') | Should -Be $false
        $wif.workspaceId = 'wrkspc_1'
        (New-WifTokenRequest -Wif $wif -Assertion 'a.b.c').workspace_id | Should -Be 'wrkspc_1'
    }
    It 'prefers federation over a stored key, and reports when neither is set up' {
        $ready = '{"wif":{"ruleId":"fdrl_1","organizationId":"o","serviceAccountId":"svac_1"}}' | ConvertFrom-Json
        $half = '{"wif":{"issuer":"https://x","subject":"s"}}' | ConvertFrom-Json
        Select-PlatformAuth -Config $ready -AdminKey 'k' | Should -Be 'wif'
        Select-PlatformAuth -Config $half -AdminKey 'k' | Should -Be 'key'
        Select-PlatformAuth -Config $half -AdminKey $null | Should -Be $null
        Select-PlatformAuth -Config ('{}' | ConvertFrom-Json) -AdminKey $null | Should -Be $null
    }
}

Describe 'Codex window labels' {
    It 'labels each window by its real length, not its position' {
        $resp = '{"plan_type":"prolite","rate_limit":{"primary_window":{"used_percent":50,"reset_at":1791331200,"limit_window_seconds":604800}}}' | ConvertFrom-Json
        $s = ConvertTo-CodexSource -Response $resp -Now $script:Now
        $s.windows[0].label | Should -Be 'Week'
        $s.windows[0].period_seconds | Should -Be 604800
    }
    It 'names 5-hour, multi-day and odd-length windows' {
        Get-WindowLabel 18000 | Should -Be 'Session (5 h)'
        Get-WindowLabel 604800 | Should -Be 'Week'
        Get-WindowLabel 2592000 | Should -Be '30-day window'
        Get-WindowLabel 10800 | Should -Be '3-hour window'
    }
}
