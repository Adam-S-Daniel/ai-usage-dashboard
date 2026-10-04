# AI usage dashboard

Phone-friendly page showing Claude plan limits, ChatGPT (Codex) plan limits, and Claude platform API tokens and cost.
Each limit is drawn against how much of its period has elapsed.

- `index.html`: static page on GitHub Pages. Reads `usage.json` from a secret gist. No data is stored in this repo.
- `collector/`: PowerShell 7 script run by Windows Task Scheduler every 5 minutes. It reads the usage numbers and updates the gist. No AI involved.

## Install (Windows, PowerShell 7, `gh` logged in)

    pwsh D:\repos\adam-s-daniel\ai-usage-dashboard\collector\Install.ps1

First run creates the public repo (code only), turns on Pages, creates the secret gist, and registers the scheduled task.
Open the printed link on your phone; the gist id is remembered there.

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

## Tests

    pwsh collector/tests/Run-Tests.ps1

## Uninstall

    Unregister-ScheduledTask AiUsageCollector
    certutil -csp "Microsoft Platform Crypto Provider" -delkey ai-usage-wif   # only if you set up federation

Also archive the federation rule and issuer in the Console.

## Agent setup

`skills.lock` pins the skill bundles from [adam-agentskills](https://github.com/Adam-S-Daniel/adam-agentskills) that cloud agent sessions in this repo install. `AGENTS.md` and the `skills-bootstrap` hook are delivered by [_agent-guidance](https://github.com/Adam-S-Daniel/_agent-guidance). Edit `AGENTS.md` only below its `## Repo-specific additions` header, and leave the hook alone.
