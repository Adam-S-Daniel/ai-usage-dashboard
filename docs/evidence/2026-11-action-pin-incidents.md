# Action pin incidents

Moved out of `AGENTS.md` (prompt-audit sweep 2026-11-17, issue #35).

- A stale `actions.lock` ran `actions/checkout@v7.0.1` at v7.0.0's commit with
  no error: [run 39357694809](https://github.com/Adam-S-Daniel/ai-usage-dashboard/actions/runs/39357694809).
- Tested 2026-10-20: a cross-repo reusable workflow gets no lockfile entry and
  runs the ref's live commit: [run 39359501093](https://github.com/Adam-S-Daniel/ai-usage-dashboard/actions/runs/39359501093).
