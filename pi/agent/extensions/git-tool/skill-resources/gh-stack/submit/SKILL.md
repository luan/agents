---
name: submit
description: Create or update native GitHub Stack PRs through Git-Spice with exact identity checks.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gs:*)"
  - "Bash(gh stack:*)"
  - "Bash(gh pr view:*)"
  - "Bash(gh api:*)"
  - "Bash(git status)"
  - Skill
---

# Submit a native GitHub Stack

Preflight:

```bash
git status --short
gs log short
gh stack view --json
```

`gs log short` must automatically reconcile every selected branch, upstream
branch, PR number, and GitHub node ID. Stop before mutation if identity is
missing or ambiguous.

Update existing PRs only:

```bash
gs stack submit --update-only --no-web
```

`--update-only` skips a branch that has no PR. It does not stop the run, and it
does not verify the remote head or base. Treat the preflight views as the
identity check, and stop before mutation when any selected branch lacks a PR or
an upstream mapping.

Add `--force` only when the user explicitly authorizes the planned history
rewrite. Create remote branches or PRs only when requested:

```bash
gs stack submit --fill --no-web
```

After submission, verify with `gh stack view --json` and `gh pr view`. Stop on
any unexpected branch, PR, base, or head change. Never use raw `git push` or
`gh pr create`.
