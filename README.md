# AI usage dashboard

Phone-friendly page showing Claude plan limits, ChatGPT (Codex) plan limits, and Claude platform API tokens and cost.
Each limit is drawn against how much of its period has elapsed.

- `index.html`: static page on GitHub Pages. Reads `usage.json` from a secret gist. No data is stored in this repo.
- `collector/`: PowerShell 7 script run by Windows Task Scheduler every 5 minutes. It reads the usage numbers and updates the gist. No AI involved.

## Install (Windows, PowerShell 7, `gh` logged in)

    pwsh D:\repos\adam-s-daniel\ai-usage-dashboard\collector\Install.ps1 -SetAdminKey

First run creates the public repo (code only), turns on Pages, creates the secret gist, and registers the scheduled task.
`-SetAdminKey` is optional (Claude platform section only). It prompts for the key with hidden input and stores it in `~/.config/ai-usage/adminkey.xml`, encrypted with Windows DPAPI for your user account. Rerun with `-SetAdminKey` to replace the key; delete that file to remove it. Open the printed link on your phone; the gist id is remembered there.

## Data sources

| Section | Source | Login used |
|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` (undocumented) | Claude Code login, Windows or running WSL |
| ChatGPT | `chatgpt.com/backend-api/wham/usage` (undocumented, Codex limits) | `~/.codex/auth.json` |
| Claude platform | Admin API usage and cost reports | DPAPI-encrypted `~/.config/ai-usage/adminkey.xml` |

The collector never refreshes login tokens. If one expires, the page keeps the last numbers and says so until you open Claude Code or Codex.

## Tests

    pwsh collector/tests/Run-Tests.ps1

## Uninstall

    Unregister-ScheduledTask AiUsageCollector
