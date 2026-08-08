---
name: pr-descr
description: 'Update an existing pull request title and description from branch context. Use when the user asks to write, refresh, or improve PR metadata.'
argument-hint: "[--auto]"
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
- If the repo has a PR template, preserve its top-level headings unless the existing PR body has already intentionally changed them.
- Otherwise, if recent merged PRs share a consistent format, match it.
- Fallback: 1-3 tight sections with bullets only where they improve scanability.
- Write at the altitude of motivation, user and reviewer impact, and the behavior changes that matter for review. The diff already carries touched files, renamed symbols, and helper functions; leave those to it.
- Keep a "Changes" section only when the template asks for one, and keep it conceptual there.

**Testing / validation sections**:

"Testing", "QA", "Validation", and "Screenshots" sections answer one question: how was this change verified? Cover what applies:

- **Tests added or updated** — name them explicitly. A PR that changes behavior generally carries unit or UI test changes; when it carries none, say why.
- **Manual verification** — the scenario exercised and the environment it ran in.
- **User-facing changes** — before/after screenshots, GIFs, or video. These are load-bearing for UI review, not decoration.

Ask the user what they exercised when the section needs evidence you do not have. Under `--auto`, or when they cannot answer, record what you can verify and mark the rest unreported rather than inventing coverage.

Distinguish the two kinds of evidence. A green suite proves the assertions held; it does not prove a human looked at the feature. Report each as what it is.

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
