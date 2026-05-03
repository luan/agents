---
name: pr-descr
description: "Update PR title and description from branch context."
argument-hint: "[--auto]"
user-invocable: true
disable-model-invocation: false
allowed-tools:
  - "Bash(git status:*)"
  - "Bash(git diff:*)"
  - "Bash(git log:*)"
  - "Bash(git branch:*)"
  - "Bash(git show:*)"
  - "Bash(gh pr view:*)"
  - "Bash(gh pr edit:*)"
  - "Bash(gh pr list:*)"
  - "Bash(cat *PULL_REQUEST_TEMPLATE*)"
  - Read
---

# PR Description

Update an existing PR's title and description from branch context.

**Assumes PR already exists.** This skill NEVER pushes or submits.

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `pr-descr`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Infer the branch story from commits/diff and update the PR title/body accurately.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: PR text must describe actual diff and user impact, not aspirational scope.

## Context

Log: !`git log --oneline -10 2>/dev/null`
Status: !`git status -sb 2>/dev/null`
Template: !`cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null`

## Step 1: Check State

Resolve at runtime:

- **PR**: `gh pr view --json number,title,body,headRefName -q '{number,title,headRefName}'`. If empty, tell user and stop.
- **BASE**: `gh stack view --json 2>/dev/null | jq -r '.trunk // empty' || gt parent 2>/dev/null || gt trunk 2>/dev/null || git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/||' || echo main`

`--auto` → skip edge case questions, assume committed changes only. Without `--auto`:

**Edge cases — ask before proceeding:**

- **On main:** "You're on main. Did you mean to be on a feature branch?"
- **Uncommitted changes:** "Describe from just committed, or include uncommitted too?"
- **No commits ahead:** "Branch has no commits ahead. Describe uncommitted changes?"

If state is clear, proceed directly.

## Step 2: Get Diff

```bash
git diff $BASE...HEAD        # three-dot finds common ancestor
```

If including uncommitted (per Step 1): `git diff HEAD`

If diff is large, use `--stat` first and read key files.

## Step 3: Generate Title and Body

**Title**: conventional commit per /commit skill — `type(scope): description`. Max 72 chars — GitHub truncates longer titles in list views.

**Body**: Follow the repo's PR template if one exists — fill each section from the diff. Otherwise, if recent merged PRs share a consistent format, match it. Fallback: 1-3 sentences explaining WHY with high-level HOW. Don't restate what's obvious from the diff.

## Step 4: Preview and Update

Show title + body. Add observations only if genuinely useful:

- WHY is unclear → ask user for context
- Unrelated changes mixed in → suggest splitting
- Too large for one review → suggest multiple PRs

`--auto` → update directly. Without `--auto` → AskUserQuestion: "Update PR with this title and description?"

```bash
gh pr edit <NUMBER> --title "<title>" --body "<body>"
```

Show PR URL when done.
