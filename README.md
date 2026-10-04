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

Fallback: `-SetAdminKey` prompts for an API key with hidden input and stores it in `~/.config/ai-usage/adminkey.xml`, encrypted with Windows DPAPI for your user account. Federation takes priority when both are set up.

## Data sources

| Section | Source | Login used |
|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` (undocumented) | Claude Code login, Windows or running WSL |
| ChatGPT | `chatgpt.com/backend-api/wham/usage` (undocumented, Codex limits) | `~/.codex/auth.json` |
| Claude platform | Admin API usage and cost reports | TPM key + federation (or DPAPI-encrypted API key) |

The collector never refreshes login tokens. If one expires, the page keeps the last numbers and says so until you open Claude Code or Codex.

## Tests

    pwsh collector/tests/Run-Tests.ps1
    node --test tests/    # the page: validation, escaping, saved-id handling, CSP hash

## Uninstall

    Unregister-ScheduledTask AiUsageCollector
    certutil -csp "Microsoft Platform Crypto Provider" -delkey ai-usage-wif   # only if you set up federation

Also archive the federation rule and issuer in the Console.
