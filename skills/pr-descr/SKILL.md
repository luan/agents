---
name: pr-descr
description: 'Update an existing pull request title and description from branch context. Use when the user asks to write, refresh, or improve PR metadata.'
argument-hint: "[--auto]"
user-invocable: true
disable-model-invocation: false
---

# PR Description

Update an existing PR's title and description from branch context.

**Assumes PR already exists.** NEVER push or submit.

## Context

Log: !`git log --oneline -10 2>/dev/null`
Status: !`git status -sb 2>/dev/null`
Template: !`cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null`
Current PR: !`gh pr view --json number,title,body,headRefName,url 2>/dev/null`

## Step 1: Check State

Resolve at runtime:

- **PR**: `gh pr view --json number,title,body,headRefName,url`.
  If empty, tell user and stop. Always read the returned current title and body before drafting; the current description is mandatory grounding, not optional context.
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

**Title**: conventional commit per $commit skill — `type(scope): description`. Max 72 chars — GitHub truncates longer titles in list views.

**Body**:

- Start from the current PR body.
- Preserve intentional user-authored context, links, reviewer guidance, checklists, and non-stale notes.
- Update stale or missing sections using the repo's PR template if one exists, but respect what each section is asking for.
- Otherwise, if recent merged PRs share a consistent format, match it.
- Fallback: 1-3 tight sections with bullets only where they improve scanability.
- Focus on motivation, user/reviewer impact, and the high-level abstractions or behavior changes that matter for review.
- Do not list low-level technical changes, touched files, renamed symbols, helper functions, or implementation minutiae that duplicate the diff.
- Do not create a "what changed" inventory unless the template explicitly requires it; even then, keep it conceptual.
- Don't blindly replace the existing description with a fresh body that ignores current content.

**Testing / validation sections**:

- Treat "Testing", "QA", "Validation", "Screenshots", and similar template sections as manual verification reports.
- Do not fill those sections with agent-run command output such as unit tests, lint, typecheck, or build commands unless the template explicitly asks for automated checks.
- Prefer concrete manual evidence: scenario tested, environment, screenshots, screen recordings, or videos when applicable.
- If manual testing seems necessary and there is no evidence, ask the user what they manually tested before updating the PR.
- If using `--auto` or the user cannot answer, do not invent coverage. Write "Manual testing not reported" or leave the template's unchecked/manual item unchanged, depending on the template.
- It is acceptable to perform manual validation yourself by running the app and capturing screenshots; use `$manual-testing` for that workflow, and only report what was actually exercised.

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
