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

Describe 'Usage encryption' {
    BeforeAll {
        $script:Key = New-UsageKey
        $script:Doc = '{"schema":1,"host":"example-host","note":"caf\u00e9 ✓"}'
    }
    It 'makes a 32-byte base64url key without padding' {
        $script:Key.Length | Should -Be 43
        (ConvertFrom-Base64Url $script:Key).Length | Should -Be 32
        ($script:Key -match '^[A-Za-z0-9_-]{43}$') | Should -Be $true
    }
    It 'round-trips the exact JSON, including non-ASCII' {
        Unprotect-UsageJson -Envelope (Protect-UsageJson -Json $script:Doc -Key $script:Key) -Key $script:Key | Should -Be $script:Doc
    }
    It 'uses a fresh IV, so two encryptions of the same input differ' {
        $a = Protect-UsageJson -Json $script:Doc -Key $script:Key
        $b = Protect-UsageJson -Json $script:Doc -Key $script:Key
        ($a -eq $b) | Should -Be $false
        ((ConvertFrom-Json $a).iv -eq (ConvertFrom-Json $b).iv) | Should -Be $false
    }
    It 'has exactly v, enc, iv and ct, with a 12-byte IV and a 16-byte tag after the ciphertext' {
        $e = Protect-UsageJson -Json $script:Doc -Key $script:Key | ConvertFrom-Json
        ($e.PSObject.Properties.Name -join ',') | Should -Be 'v,enc,iv,ct'
        $e.v | Should -Be 1
        $e.enc | Should -Be 'A256GCM'
        (ConvertFrom-Base64Url $e.iv).Length | Should -Be 12
        (ConvertFrom-Base64Url $e.ct).Length | Should -Be ([Text.Encoding]::UTF8.GetByteCount($script:Doc) + 16)
    }
    It 'throws on a tampered ciphertext, a tampered tag, or the wrong key' {
        $e = Protect-UsageJson -Json $script:Doc -Key $script:Key | ConvertFrom-Json
        $threw = @()
        foreach ($at in 0, -1) {
            $b = ConvertFrom-Base64Url $e.ct
            $b[$(if ($at -lt 0) { $b.Length - 1 } else { 0 })] = $b[$(if ($at -lt 0) { $b.Length - 1 } else { 0 })] -bxor 1
            $bad = [ordered]@{ v = 1; enc = 'A256GCM'; iv = $e.iv; ct = ConvertTo-Base64Url $b } | ConvertTo-Json -Compress
            $threw += try { Unprotect-UsageJson -Envelope $bad -Key $script:Key; $false } catch { $true }
        }
        $threw += try { Unprotect-UsageJson -Envelope ($e | ConvertTo-Json -Compress) -Key (New-UsageKey); $false } catch { $true }
        ($threw -join ',') | Should -Be 'True,True,True'
    }
    It 'rejects a key that is not 32 bytes' {
        $threw = try { Protect-UsageJson -Json $script:Doc -Key 'c2hvcnQ'; $false } catch { $true }
        $threw | Should -Be $true
    }
}

Describe 'Get-CollectDays' {
    It 'defaults to 30 when days is missing, empty, zero, negative or not a number' {
        foreach ($c in @{}, @{ days = '' }, @{ days = 0 }, @{ days = -5 }, @{ days = 'abc' }) { Get-CollectDays $c | Should -Be 30 }
    }
    It 'keeps a sensible value and caps at 300, inside the 310 daily buckets the paging can read' {
        Get-CollectDays @{ days = 90 } | Should -Be 90
        Get-CollectDays ([pscustomobject]@{ days = 300 }) | Should -Be 300
        Get-CollectDays @{ days = 301 } | Should -Be 300
        Get-CollectDays @{ days = 100000 } | Should -Be 300
    }
}

Describe 'ConvertTo-PlatformSource aggregation' {
    It 'sums rows to one per date and model, as decimals, keeping first-seen order' {
        $cost = '{"data":[{"starting_at":"2026-10-01T00:00:00Z","results":[' +
            '{"amount":"0.1","model":"m1","description":"Input"},{"amount":"0.2","model":"m1","description":"Output"},{"amount":"0.2","model":"m1","description":"Cache"},' +
            '{"amount":"50","model":"m2","description":"Input"}]},{"starting_at":"2026-10-02T00:00:00Z","results":[{"amount":"100","model":"m1"}]}]}' | ConvertFrom-Json
        $usage = '{"data":[{"starting_at":"2026-10-01T00:00:00Z","results":[{"model":"m1","uncached_input_tokens":1,"cache_read_input_tokens":2,"output_tokens":3},{"model":"m1","uncached_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":30,"cache_creation_input_tokens":4}]}]}' | ConvertFrom-Json
        $s = ConvertTo-PlatformSource -UsagePages @($usage) -CostPages @($cost) -Now $script:Now
        $s.costs.Count | Should -Be 3
        ($s.costs | % { "$($_.date) $($_.model) $($_.usd)" }) -join ';' | Should -Be '2026-10-01 m1 0.005;2026-10-01 m2 0.5;2026-10-02 m1 1'
        $s.usage.Count | Should -Be 1
        $s.usage[0].input | Should -Be 11
        $s.usage[0].cache_read | Should -Be 22
        $s.usage[0].output | Should -Be 33
        $s.usage[0].cache_write | Should -Be 4
    }
    It 'turns 300 days x 4 models x 5 cost lines into 1200 cost rows' {
        $buckets = foreach ($d in 0..299) {
            $day = ([datetime]'2026-01-01').AddDays($d).ToString('yyyy-MM-ddT00:00:00Z')
            $results = foreach ($m in 1..4) { foreach ($c in 1..5) { @{ amount = '1.5'; model = "example-model-$m"; description = "line $c" } } }
            @{ starting_at = $day; results = @($results) }
        }
        $cost = @{ data = @($buckets) } | ConvertTo-Json -Depth 6 | ConvertFrom-Json
        $s = ConvertTo-PlatformSource -UsagePages @() -CostPages @($cost) -Now $script:Now
        $s.ok | Should -Be $true
        $s.costs.Count | Should -Be 1200
        $s.costs[0].usd | Should -Be 0.075
    }
    It 'reports an error rather than publishing more rows than the page accepts' {
        $rows = foreach ($i in 1..10001) { @{ date = '2026-10-01'; model = "m$i"; input_tokens = 1; output_tokens = 1 } }
        $usage = @{ data = @($rows) } | ConvertTo-Json -Depth 4 | ConvertFrom-Json
        $s = ConvertTo-PlatformSource -UsagePages @($usage) -CostPages @() -Now $script:Now
        $s.ok | Should -Be $false
        ($s.error -match 'Too many usage rows') | Should -Be $true
    }
}

Describe 'Get-ErrorText' {
    It 'maps each failure to a short fixed phrase with the source name' {
        $cases = [ordered]@{
            'Response status code does not indicate success: 401 (Unauthorized).' = 'claude: HTTP 401'
            'Response status code does not indicate success: 429 (Too Many Requests).' = 'claude: HTTP 429'
            'The request was canceled due to the configured HttpClient.Timeout of 30 seconds elapsing.' = 'claude: timeout'
            'Name or service not known (api.anthropic.com:443)' = 'claude: DNS failure'
            'No such host is known. (api.anthropic.com:443)' = 'claude: DNS failure'
            'Connection refused (127.0.0.1:1)' = 'claude: connection refused'
            'Token exchange failed: Response status code does not indicate success: 400 (Bad Request).' = 'claude: token exchange failed (HTTP 400)'
            'Token exchange failed: something odd' = 'claude: token exchange failed'
            'Federation was refused (401). Check the rule (issuer, subject, audience, service account) and the events on the Console.' = 'claude: federation refused (HTTP 401); check the rule and issuer in the Console'
            'No Claude Code login found. Run `claude` and log in.' = 'claude: no Claude Code login; run claude and log in'
            'Claude Code token expired. Open Claude Code to renew it.' = 'claude: Claude Code login expired; open Claude Code to renew it'
            'No Codex ChatGPT login found. Run `codex login`.' = 'claude: no Codex login; run codex login'
            'Claude platform access is not set up. Run Install.ps1 -SetupWif (or -SetAdminKey).' = 'claude: platform access is not set up; run Install.ps1 -SetupWif'
            'Could not create a key in the TPM (is the TPM present and enabled?): boom' = 'claude: signing key unavailable'
            'Bearer token is invalid' = 'claude: request failed'
            'something unexpected' = 'claude: request failed'
        }
        foreach ($m in $cases.Keys) { Get-ErrorText ([Exception]::new($m)) 'claude' | Should -Be $cases[$m] }
    }
    It 'prefers the real response status code when the exception carries one' {
        $ex = [pscustomobject]@{ Message = 'whatever'; Response = [pscustomobject]@{ StatusCode = 503 } }
        Get-ErrorText $ex 'codex' | Should -Be 'codex: HTTP 503'
    }
    It 'never lets any secret shape from the raw message into the output' {
        $secrets = 'sk-proj-ABCDEF123456', 'sk-OLDSTYLEKEY123456', 'sk-ant-admin01-SECRETVALUE', 'ghp_0123456789abcdefghij', 'github_pat_11ABCDEFG0123456789', 'x-api-key: HEADERSECRET', 'api_key=QUERYSECRET', 'token=TOKENSECRET', 'Authorization: Basic dXNlcjpwYXNz', 'Bearer abc.def.ghi', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'
        $raw = "GET https://api.example.com/v1/x?api_key=QUERYSECRET&token=TOKENSECRET failed: " + ($secrets -join ' ') + ' ' + ('x' * 5000)
        $out = Get-ErrorText ([Exception]::new($raw)) 'platform'
        $out | Should -Be 'platform: request failed'
        foreach ($s in $secrets) { $out.Contains($s) | Should -Be $false }
        $out.Length | Should -BeLessThan 100
    }
}

Describe 'ConvertTo-PlatformSource robustness' {
    It 'keeps models that differ only in case apart' {
        $usage = '{"data":[{"date":"2026-10-01","model":"Model-A","input_tokens":1},{"date":"2026-10-01","model":"model-a","input_tokens":2}]}' | ConvertFrom-Json
        $cost = '{"data":[{"date":"2026-10-01","model":"Model-A","amount":"100"},{"date":"2026-10-01","model":"model-a","amount":"200"}]}' | ConvertFrom-Json
        $s = ConvertTo-PlatformSource -UsagePages @($usage) -CostPages @($cost) -Now $script:Now
        $s.usage.Count | Should -Be 2
        $s.costs.Count | Should -Be 2
        ($s.costs | % { $_.usd }) -join ',' | Should -Be '1,2'
    }
    It 'floors a net-negative (date, model) cost at 0 and records how many were floored' {
        $cost = '{"data":[{"date":"2026-10-01","model":"m1","amount":"-500"},{"date":"2026-10-01","model":"m1","amount":"300"},{"date":"2026-10-01","model":"m2","amount":"-100"},{"date":"2026-10-01","model":"m2","amount":"300"}]}' | ConvertFrom-Json
        $s = ConvertTo-PlatformSource -UsagePages @() -CostPages @($cost) -Now $script:Now
        ($s.costs | % { "$($_.model)=$($_.usd)" }) -join ',' | Should -Be 'm1=0,m2=2'
        $s.floored_credits | Should -Be 1
        ($s.costs | ? { $_.usd -lt 0 }).Count | Should -Be 0
    }
    It 'omits floored_credits when nothing was floored' {
        $cost = '{"data":[{"date":"2026-10-01","model":"m1","amount":"100"}]}' | ConvertFrom-Json
        (ConvertTo-PlatformSource -UsagePages @() -CostPages @($cost) -Now $script:Now).Contains('floored_credits') | Should -Be $false
    }
    It 'reports an error for more than 300 models or a model name over 200 characters' {
        $rows = foreach ($i in 1..301) { @{ date = '2026-10-01'; model = "m$i"; input_tokens = 1 } }
        $s = ConvertTo-PlatformSource -UsagePages @(@{ data = @($rows) } | ConvertTo-Json -Depth 4 | ConvertFrom-Json) -CostPages @() -Now $script:Now
        $s.ok | Should -Be $false
        ($s.error -match 'Too many models') | Should -Be $true
        $ok = foreach ($i in 1..300) { @{ date = '2026-10-01'; model = "m$i"; input_tokens = 1 } }
        (ConvertTo-PlatformSource -UsagePages @(@{ data = @($ok) } | ConvertTo-Json -Depth 4 | ConvertFrom-Json) -CostPages @() -Now $script:Now).ok | Should -Be $true
        $long = @{ data = @(@{ date = '2026-10-01'; model = ('m' * 201); input_tokens = 1 }) } | ConvertTo-Json -Depth 4 | ConvertFrom-Json
        $s2 = ConvertTo-PlatformSource -UsagePages @($long) -CostPages @() -Now $script:Now
        $s2.ok | Should -Be $false
        ($s2.error -match 'longer than the page accepts') | Should -Be $true
        $edge = @{ data = @(@{ date = '2026-10-01'; model = ('m' * 200); input_tokens = 1 }) } | ConvertTo-Json -Depth 4 | ConvertFrom-Json
        (ConvertTo-PlatformSource -UsagePages @($edge) -CostPages @() -Now $script:Now).ok | Should -Be $true
    }
}

Describe 'New-PublishPayload' {
    BeforeAll {
        $script:Key = New-UsageKey
        $script:Big = { param($Models, $Days)
            $usage = New-Object System.Collections.ArrayList; $costs = New-Object System.Collections.ArrayList
            foreach ($d in 0..($Days - 1)) { $date = ([datetime]'2026-10-04').AddDays(-$d).ToString('yyyy-MM-dd')
                foreach ($m in 1..$Models) {
                    [void]$usage.Add([ordered]@{ date = $date; model = "example-model-$m"; input = 123456789; cache_write = 123456; cache_read = 1234567890; output = 12345678 })
                    [void]$costs.Add([ordered]@{ date = $date; model = "example-model-$m"; usd = 12.3456789 }) } }
            [ordered]@{ claude = [ordered]@{ ok = $true; plan = 'max'; windows = @() }; platform = [ordered]@{ ok = $true; fetched_at = '2026-10-04T12:00:00Z'; usage = @($usage); costs = @($costs) } }
        }
    }
    It 'publishes compact JSON that decrypts to exactly the stored text' {
        $p = New-PublishPayload -Sources (& $script:Big 2 3) -Now $script:Now -Key $script:Key
        ($p.json -match '\n') | Should -Be $false
        Unprotect-UsageJson -Envelope $p.text -Key $script:Key | Should -Be $p.json
    }
    It 'fits 300 days x 33 models inside the page cap, encrypted, with headroom' {
        $p = New-PublishPayload -Sources (& $script:Big 33 300) -Now $script:Now -Key $script:Key
        (ConvertFrom-Json $p.json).sources.platform.ok | Should -Be $true
        [Text.Encoding]::UTF8.GetByteCount($p.text) | Should -BeLessThan 3000000
    }
    It 'replaces the platform source with an error when the final text would exceed the limit, keeping the rest' {
        $p = New-PublishPayload -Sources (& $script:Big 5 20) -Now $script:Now -Key $script:Key -MaxBytes 20000
        $doc = Unprotect-UsageJson -Envelope $p.text -Key $script:Key | ConvertFrom-Json
        $doc.sources.platform.ok | Should -Be $false
        ($doc.sources.platform.error -match 'too much data') | Should -Be $true
        $doc.sources.claude.plan | Should -Be 'max'
        [Text.Encoding]::UTF8.GetByteCount($p.text) | Should -BeLessThan 20000
    }
    It 'keeps earlier platform rows when a size error and the previous snapshot fit' {
        foreach ($key in @('', $script:Key)) {
            $previous = (& $script:Big 2 3).platform
            $previous.fetched_at = '2026-10-01T12:00:00Z'
            $before = $previous | ConvertTo-Json -Depth 8 -Compress
            $p = New-PublishPayload -Sources (& $script:Big 5 20) -PreviousPlatform $previous -Now $script:Now -Key $key -MaxBytes 10000
            $doc = $p.json | ConvertFrom-Json
            $doc.sources.platform.ok | Should -Be $false
            ($p.json.Contains('"fetched_at":"2026-10-01T12:00:00Z"')) | Should -Be $true
            ($doc.sources.platform.usage | ConvertTo-Json -Depth 8 -Compress) | Should -Be ($previous.usage | ConvertTo-Json -Depth 8 -Compress)
            ($doc.sources.platform.costs | ConvertTo-Json -Depth 8 -Compress) | Should -Be ($previous.costs | ConvertTo-Json -Depth 8 -Compress)
            ($doc.sources.platform.error -match 'too much data') | Should -Be $true
            $doc.sources.claude.plan | Should -Be 'max'
            ([Text.Encoding]::UTF8.GetByteCount($p.text) -le 10000) | Should -Be $true
            ($previous | ConvertTo-Json -Depth 8 -Compress) | Should -Be $before
            if ($key) { Unprotect-UsageJson -Envelope $p.text -Key $key | Should -Be $p.json }
        }
    }
    It 'drops even the earlier platform rows when they cannot fit with the size error' {
        foreach ($key in @('', $script:Key)) {
            $previous = (& $script:Big 5 20).platform
            $before = $previous | ConvertTo-Json -Depth 8 -Compress
            $p = New-PublishPayload -Sources (& $script:Big 5 20) -PreviousPlatform $previous -Now $script:Now -Key $key -MaxBytes 10000
            $doc = $p.json | ConvertFrom-Json
            $doc.sources.platform.ok | Should -Be $false
            $doc.sources.platform.usage | Should -Be $null
            $doc.sources.platform.costs | Should -Be $null
            ($doc.sources.platform.error -match 'too much data') | Should -Be $true
            $doc.sources.claude.plan | Should -Be 'max'
            ([Text.Encoding]::UTF8.GetByteCount($p.text) -le 10000) | Should -Be $true
            ($previous | ConvertTo-Json -Depth 8 -Compress) | Should -Be $before
            if ($key) { Unprotect-UsageJson -Envelope $p.text -Key $key | Should -Be $p.json }
        }
    }
    It 'checks the encrypted text, not just the plain JSON' {
        $plain = New-PublishPayload -Sources (& $script:Big 5 20) -Now $script:Now
        $len = [Text.Encoding]::UTF8.GetByteCount($plain.text)
        $enc = New-PublishPayload -Sources (& $script:Big 5 20) -Now $script:Now -Key $script:Key -MaxBytes ($len + 100)
        (ConvertFrom-Json (Unprotect-UsageJson -Envelope $enc.text -Key $script:Key)).sources.platform.ok | Should -Be $false
    }
}

Describe 'CI workflow' {
    It 'keeps both required checks available and pins every action' {
        if (-not (Get-Command ConvertFrom-Yaml -ErrorAction SilentlyContinue)) {
            if ($env:GITHUB_ACTIONS -or $env:CI) { throw 'ConvertFrom-Yaml is required in CI; the workflow must install the pinned powershell-yaml parser before running Pester.' }
            Write-Host '  YAML policy assertions skipped locally: no YAML parser is installed; CI installs the pinned powershell-yaml parser.'
            if (Get-Command Set-ItResult -ErrorAction SilentlyContinue) { Set-ItResult -Skipped -Because 'No YAML parser is installed locally; CI installs the pinned powershell-yaml parser.' }
            return
        }
        $ci = Get-Content -Raw "$PSScriptRoot/../../.github/workflows/ci.yml" | ConvertFrom-Yaml
        (@($ci.jobs.Keys | Sort-Object) -join ',') | Should -Be 'node-test,pester'
        $ci.on.Contains('pull_request') | Should -Be $true
        (@($ci.on.push.branches) -join ',') | Should -Be 'main'
        $ci.Contains('concurrency') | Should -Be $false
        $ci.permissions.contents | Should -Be 'read'
        foreach ($event in @('pull_request', 'push')) {
            if ($null -ne $ci.on[$event]) {
                $ci.on[$event].Contains('paths') | Should -Be $false
                $ci.on[$event].Contains('paths-ignore') | Should -Be $false
            }
        }
        foreach ($id in @('node-test', 'pester')) {
            $job = $ci.jobs[$id]
            $job.Contains('concurrency') | Should -Be $false
            ($job['timeout-minutes'] -gt 0) | Should -Be $true
            $job['runs-on'] | Should -Be 'ubuntu-latest'
            foreach ($step in $job.steps) {
                if ($step.Contains('uses')) {
                    ($step.uses -match '@[0-9a-f]{40}$') | Should -Be $true
                    if ($step.uses.StartsWith('actions/checkout@')) {
                        $step.with['persist-credentials'] | Should -Be $false
                    }
                }
            }
            $command = if ($id -eq 'node-test') { 'node --test tests/*.test.mjs' } else { 'pwsh -NoProfile -File collector/tests/Run-Tests.ps1' }
            @($job.steps | Where-Object { $_.run -eq $command }).Count | Should -Be 1
        }

        $parserSteps = @($ci.jobs.pester.steps | Where-Object { $_.name -eq 'Install YAML parser' })
        $parserSteps.Count | Should -Be 1
        $parserStep = $parserSteps[0]
        $parserStep['if'] | Should -Be "steps.changes.outputs.run == 'true'"
        $parserStep.shell | Should -Be 'pwsh'
        $pesterRunIndex = -1
        $parserRunIndex = -1
        for ($i = 0; $i -lt $ci.jobs.pester.steps.Count; $i++) {
            if ($ci.jobs.pester.steps[$i].name -eq 'Run tests') { $pesterRunIndex = $i }
            if ($ci.jobs.pester.steps[$i].name -eq 'Install YAML parser') { $parserRunIndex = $i }
        }
        ($parserRunIndex -lt $pesterRunIndex) | Should -Be $true

        $tokens = $null
        $parseErrors = $null
        $installerAst = [System.Management.Automation.Language.Parser]::ParseInput($parserStep.run, [ref]$tokens, [ref]$parseErrors)
        @($parseErrors).Count | Should -Be 0
        $installerCommands = @($installerAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Install-Module' }, $true))
        $installerCommands.Count | Should -Be 1
        ($installerCommands[0].CommandElements | ForEach-Object { $_.Extent.Text }) -join ' ' | Should -Be 'Install-Module -Name powershell-yaml -RequiredVersion 0.4.12 -Repository PSGallery -Scope CurrentUser -Force -ErrorAction Stop'
    }
}
