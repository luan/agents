---
name: submit
description: >
  Use this skill to push a gh-stack stack and create or update stacked pull requests.
  Replaces git push and gh pr create for stack workflows. Triggers: push, ship it, send
  this up, submit, update PRs, create PR, push stack, send PRs.
user-invocable: true
agent: general-purpose
allowed-tools:
  - "Bash(gh stack:*)"
  - "Bash(git status)"
  - "Bash(git branch:*)"
  - "Bash(gh pr view:*)"
  - Skill
---

# Submit gh-stack Stack

Push the stack and create or update stacked pull requests on GitHub.

Command contracts are based on the upstream CLI reference at <https://github.github.com/gh-stack/reference/cli/>.

## Modes

| Mode | Command | When |
| --- | --- | --- |
| **Default** | `gh stack push` | Always, unless the user explicitly asks otherwise |
| Create new PRs | `gh stack submit --auto` | User explicitly says "create PR" or "create PRs" |
| Create ready for review | `gh stack submit --auto --open` | User explicitly asks for non-draft PRs |

Default is `gh stack push`: it pushes every branch with `--force-with-lease --atomic`, which updates existing PRs, and it creates no new PRs. This avoids accidental publication of WIP stack branches.

`gh stack submit` creates a PR for every unsubmitted branch and links them into a Stack on GitHub. Always pass `--auto` — without it, submit opens a full-screen editor that needs a TTY. With `--auto`, new PRs are created as drafts unless `--open` is passed.

## Steps

1. Check stack state: `gh stack view --short 2>&1`.
2. Push or submit with the selected mode:

   ```bash
   gh stack push 2>&1
   # or gh stack submit --auto 2>&1
   ```

3. Refresh PR descriptions for every affected PR:
   - Fetch and read the current title/body with `gh pr view <PR> --json number,title,body,headRefName,url`. This current description is mandatory grounding.
   - Then run `Skill(pr-descr)` for each affected PR so the title and body match the final branch diff without blindly discarding existing PR context.
   - This applies to push and submit modes; existing PRs may still have stale descriptions, and `--auto` titles are auto-generated from commits.
4. Report created or updated PR URLs.
