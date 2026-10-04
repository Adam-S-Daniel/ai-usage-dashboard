# AI usage dashboard

Phone-friendly page showing Claude plan limits, ChatGPT (Codex) plan limits, and Claude platform API tokens and cost.
Each limit is drawn against how much of its period has elapsed.

- `index.html`: static page on GitHub Pages. Reads `usage.json` from a secret gist, encrypted (AES-256-GCM) by the collector. No data is stored in this repo.
- `collector/`: PowerShell 7 script run by Windows Task Scheduler every 5 minutes. It reads the usage numbers and updates the gist. No AI involved.

## Install (Windows, PowerShell 7, `gh` logged in)

    pwsh D:\repos\adam-s-daniel\ai-usage-dashboard\collector\Install.ps1

First run creates the public repo (code only), turns on Pages, creates the secret gist, and registers the scheduled task.
Open the printed link on your phone: `<pages url>#<gist id>.<key>`. The key lives only in the URL fragment, which browsers never send to a server, so GitHub and anyone who learns the gist id see only ciphertext. The id and key are remembered in this device's browser storage for the site's origin.

Run `Install.ps1 -Rotate` the first time after upgrading (the old gist's revision history is still plaintext), and whenever the link may have leaked. It creates a new gist and key, publishes to it, then deletes the old gist and its history. Open the new link afterward; a bare `#<gist id>` link still works for a gist that was never encrypted.

## Claude platform access (optional)

Preferred: Workload Identity Federation. No Anthropic secret is stored on the laptop.

    pwsh D:\repos\adam-s-daniel\ai-usage-dashboard\collector\Install.ps1 -SetupWif

This creates a non-exportable RSA key in the TPM and prints the issuer URL, public key, subject and audience to enter in the Console (Settings > Workload identity). The rule must target an admin-role service account with scope `org:admin`. Paste the rule, organization and service account IDs back at the prompts. Each run, the collector signs a 2-minute JWT with the TPM key and trades it for a short-lived token.

What federation does not do: shrink what the credential can reach. The rule's `org:admin` scope is full Admin API access, and it reaches further than an admin API key: only an `org:admin` OAuth token can manage service accounts, federation issuers and federation rules. Code running as you on this machine can sign with the TPM key while it is here, and with that scope could register a second issuer of its own. If the machine is ever compromised, archive the rule and issuer, then review the organization's issuers, rules and service accounts.

Fallback: `-SetAdminKey` prompts for an API key with hidden input and stores it in `~/.config/ai-usage/adminkey.xml`, encrypted with Windows DPAPI for your user account. Federation takes priority when both are set up.

## Data sources

| Section | Source | Login used |
|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` (undocumented) | Claude Code login, Windows or running WSL |
| ChatGPT | `chatgpt.com/backend-api/wham/usage` (undocumented, Codex limits) | `~/.codex/auth.json` |
| Claude platform | Admin API usage and cost reports | TPM key + federation (or DPAPI-encrypted API key) |

The collector never refreshes login tokens. If one expires, the page keeps the last numbers and says so until you open Claude Code or Codex.

## Configuration

`~/.config/ai-usage/config.json` accepts an optional `days`: how many days of Claude platform history to fetch. The default is 30 and the maximum is 300 (larger values are capped). The collector reads at most 10 pages of 31 daily buckets (310), and the page rejects data older than 398 days, so 300 is the most that both can carry. A missing, zero, negative or non-numeric value means 30.

The page and the collector agree on size by construction. The collector sums the platform usage and cost lines to one row per (date, model), which is all the page draws, and publishes compact JSON. The page accepts up to 10,000 rows per list, 300 distinct models, 200-character strings and 4 MB of text (the encrypted envelope, which is about a third larger than the JSON inside it). The collector applies the same row, model and string limits, and checks the final published text against 3.5 MB: 300 days with 33 models a day is about 2.2 MB encrypted. When the final text exceeds the size limit, the collector keeps earlier platform rows with an error if they fit; otherwise it publishes only the platform error (the other sources still publish). Lower `days` in that case. The page rejects a negative cost, so a (date, model) total that nets below zero (a credit) is published as 0 and counted in the platform source's `floored_credits`. The page still accepts the older, un-aggregated shape in gists published earlier.

A failed source publishes only a short fixed phrase and the source name (`claude: HTTP 401`, `codex: timeout`, `platform: DNS failure`, `claude: request failed`), never the raw exception text, which could echo a URL, header or response body.

The local `~/.config/ai-usage/usage.json` is plaintext compact JSON followed by a newline. The collector and installer read it with `Get-Content -Raw | ConvertFrom-Json`, which accepts compact and pretty JSON. The gist receives compact JSON encrypted in an envelope when a key is configured.

## Tests and CI

    node --test tests/*.test.mjs
    pwsh -NoProfile -File collector/tests/Run-Tests.ps1

[CI](.github/workflows/ci.yml) runs both suites on Ubuntu for pull requests and pushes to `main`, with `node-test` and `pester` intended as required checks. Changes outside each suite's salient paths report success without running that suite. The workflow policy test uses `ConvertFrom-Yaml`: CI installs the pinned `powershell-yaml` 0.4.12 module before Pester and fails if the parser is unavailable. Locally, when the module is absent, only the workflow policy assertions are visibly skipped.

The jobs and their steps omit `timeout-minutes` because GitHub reports timed-out jobs as cancelled, which can block a required check.

## Uninstall

    Unregister-ScheduledTask AiUsageCollector
    certutil -csp "Microsoft Platform Crypto Provider" -delkey ai-usage-wif   # only if you set up federation

Also archive the federation rule and issuer in the Console.

## Agent setup

`skills.lock` pins the skill bundles from [adam-agentskills](https://github.com/Adam-S-Daniel/adam-agentskills) that cloud agent sessions in this repo install. `AGENTS.md` and the `skills-bootstrap` hook are delivered by [_agent-guidance](https://github.com/Adam-S-Daniel/_agent-guidance). Edit `AGENTS.md` only below its `## Repo-specific additions` header, and leave the hook alone.
