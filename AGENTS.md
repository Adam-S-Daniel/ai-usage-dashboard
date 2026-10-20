<!-- BEGIN MANAGED SECTION — DO NOT EDIT ABOVE "## Repo-specific additions" -->
<!-- Source: _agent-guidance -->
<!-- Sections: none -->
<!-- Mode: stub -->

# AGENTS.md

> **Managed by [`_agent-guidance`].**
> Edit only below the `## Repo-specific additions` header.
> Everything above it will be overwritten on the next sync.

## Fleet guidance is delivered once per session — not by this file

The account's full guidance — incidents, fleet policy, machine layout, the
traps that cost real outages — is installed into **user memory**
(`~/.claude/CLAUDE.md`) by the `fleet-memory` SessionStart hook, so it is
loaded **once per session** no matter how many repos are attached
([2026-08-29: inlined per repo, it took 332.3k tokens](https://github.com/Adam-S-Daniel/_agent-guidance/blob/main/docs/evidence/2026-08-29-guidance-inlined-in-every-repo.md)).

**Check the session-start verdict before you rely on it.** The hook prints one
line:

- `fleet-guidance: installed (v<id>, <n> bytes)` or `fleet-guidance: current` —
  the full guidance is in context. Use it.
- `fleet-guidance: DEGRADED — <reason>` — it is **not** in context. You have
  only what is below. Read `agents-md/base.md` in the `_agent-guidance`
  checkout (or on GitHub) before non-trivial work, and say in your reply that
  you were running degraded.
- `fleet-guidance: skipped (FLEET_GUIDANCE_SKIP set)` — also not in context,
  but by the machine owner's deliberate choice, not a fault. User memory is
  GLOBAL on a durable machine, so the guidance would otherwise load in every
  unrelated project on that box; `FLEET_GUIDANCE_SKIP` opts out and removes any
  block an earlier session installed. Read `agents-md/base.md` the same way you
  would when degraded — just don't report it as a problem or try to "fix" it.

No verdict at all means the hook never ran — treat that as DEGRADED.

## Codex reads the same block, from `~/.codex/AGENTS.md`

The hook writes the same block to `~/.codex/AGENTS.md` whenever `~/.codex`
exists — Codex's global **user** instructions, outside its 32 KiB
`project_doc_max_bytes` project-doc budget. Register it once per machine with
`scripts/register-codex-hook.sh` from an `_agent-guidance` checkout, then
trust it in `/hooks`. `codex debug prompt-input` renders instructions loaded
from disk by its own diagnostic process; it does not run SessionStart hooks
or inspect an existing session or daemon. Verify delivery in the launched
session's initial instructions and verdict; see the
[2026-10-04 evidence](https://github.com/Adam-S-Daniel/_agent-guidance/blob/main/docs/evidence/codex-trust-and-daemon-0160.md#prompt-debugging-source-read-2026-10-04-cli-01600-rust-v01600).

For Codex Cloud, use **Manual** environment setup with persistent
`CODEX_HOME=/opt/codex`. Preserve the repository's dependency setup and run
`bash .claude/hooks/fleet-memory.sh --codex-cloud` in both setup and
maintenance; reset the cache for the first verification. Fresh setup and
cached maintenance were verified in the `_agent-guidance` environment. See
[`docs/codex-cloud.md`](https://github.com/Adam-S-Daniel/_agent-guidance/blob/main/docs/codex-cloud.md).
If the Cloud shell has no `codex debug prompt-input`, the saved task response's
raw initial instruction envelope is the echo-free proof of model-visible
delivery.

## The floor: rules that hold even when the guidance did not load

These are the ones with teeth. They are restated here, deliberately, because a
session that lost the guidance must not also lose these.

- **Branch protection is real.** Fleet repos are PR-only on their default
  branch; a direct push is rejected (GH013), even from the repo's own
  workflows. Never design a bot that pushes to a protected default branch.
- **Every `uses:` is pinned to a full 40-character commit SHA, with no
  trailing version comment.** The one carve-out is a ref into this account's
  own `cms-platform`, which stays on its release tag.
- **Never commit secrets or `.env` files, and never print personal data to a
  CI log** — logs, artifacts and git history on a public repo are public.
- **A successful `git push` does not mean your commit exists.** A refused
  pre-commit hook still lets the push report success. Verify with
  `git merge-base --is-ancestor <sha> origin/<branch>` — it is the only check
  that names both the commit and the ref.
- **"The watch finished" is not "CI passed."** Read the parsed conclusions;
  never infer pass/fail from a watch command's exit code.
- **A GitHub 404 means "not authorized", not "not there."** Never report a
  repo, PR or branch as gone on a 404 alone.
- **The fleet spans TWO owners** — `Adam-S-Daniel` and `jodidaniel`. A query
  scoped to one returns a plausible, complete-shaped, wrong answer.
- **Anything you name gets its link** — what you hand over, what you are
  waiting on, and what you cite as already done.
- **Merge with a merge commit** (`gh pr merge --merge`); do not amend
  published commits or force-push shared branches.
- **Keep this file under 32 KiB.** Codex truncates project instructions at
  that byte silently; the sync warns and the drift report flags
  `codex-truncated`.

<!-- END MANAGED SECTION -->
## Repo-specific additions

<!-- Add your repo-specific agent guidance below this line -->

### Action pins

Workflows name actions by release tag; [`.github/workflows/actions.lock`](.github/workflows/actions.lock) locks each tag to an exact commit, and the runner runs the locked commit even when it disagrees with the tag (a stale lockfile ran `actions/checkout@v7.0.1` at v7.0.0's commit with no error: [run 39357694809](https://github.com/Adam-S-Daniel/ai-usage-dashboard/actions/runs/39357694809)). The only guard is the `pester` job's "Verify action lockfile" step, which runs `gh actions-lock --verify` and fails on any finding, printing each finding's category. Write the exact tag by hand, then regenerate the lockfile with `gh actions-lock --no-narrow` (it keeps the tag as written) and commit both files; review an `actions.lock` diff as you would a SHA pin. A local action must be written `$/<path>`, not `./<path>`: `--verify` rejects `./` as `local-action`, and the default run rewrites it.

- **A lockfile that disagrees with its tags** fails that step as `unreachable-pin` (the tool says "Pinned commit not in upstream history" even when the commit is merely not the tag's). If upstream really moved, `gh actions-lock --accept-moved` re-resolves only the flagged pins to the tag's current commit; tested 2026-10-20, it fixes both a mismatched and an unreachable pin, while `--relock` alone leaves an unreachable pin failing and advances every moved ref. Review the diff before committing.
- **A GitHub API failure fails the step too** as `reachability-unknown`: `--verify` itself exits 0 then, so the step treats any finding as a failure. Re-run once the API is back.
- **A cross-repo reusable workflow (`jobs.<id>.uses`) is not locked**: it gets no lockfile entry and runs the ref's live commit (tested 2026-10-20, [run 39359501093](https://github.com/Adam-S-Daniel/ai-usage-dashboard/actions/runs/39359501093)), so pin one by full SHA.

### CI salient paths

[CI](.github/workflows/ci.yml) always reports `node-test` and `pester` on pull requests and pushes to `main`; both are intended required checks. Repository settings are managed separately. Each job detects changes after checkout, runs its suite on uncertain comparisons, and succeeds without testing when no salient path changed.

| Job | Salient paths |
|---|---|
| `node-test` | `index.html`, `tests/**`, `collector/AiUsage.psm1` (encryption interoperability), `.github/workflows/ci.yml`, `.github/workflows/actions.lock` |
| `pester` | `collector/AiUsage.psm1`, `collector/tests/**`, `.github/workflows/*`, `.github/actions/*` (lockfile verification covers every workflow and local action) |
