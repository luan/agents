---
name: crit
description: 'Run an adversarial review of local changes, branch diffs, or PRs. Use when the user asks for review, critique, sanity check, or requested-changes prep.'
argument-hint: "[base..head | file-list | PR#] [--auto critical|high|medium|all] [--loop]"
user-invocable: true
allowed-tools:
  - Agent
  - Read
  - Glob
  - Grep
  - "Bash(git diff:*)"
  - "Bash(git branch:*)"
  - "Bash(git log:*)"
  - "Bash(git status:*)"
  - "Bash(git symbolic-ref:*)"
  - "Bash(ct repo:*)"
  - "Bash(ct task:*)"
  - "Bash(gt:*)"
  - "Bash(gh pr:*)"
---

# Crit

Adversarial review with enough context to catch real defects, without generating vault reports or running a committee. Prefer fewer, confirmed findings over broad speculation.

**NEVER review inline.** Always dispatch subagents via the Agent tool.

## Arguments

- `[base..head | file-list | PR#]` — diff source. Default: branch diff vs parent/trunk.
- `--auto critical|high|medium|all` — fix findings at or above the selected severity.
- `--loop` — after auto-fixes, re-run one review pass. Max 3 loops; stop when no fixable findings remain.

## Step 1: Scope

Resolve BASE:
```bash
gt parent
gt trunk
git symbolic-ref --short refs/remotes/origin/HEAD
```
Use the first command that returns a ref. Args override.

| Input        | Diff source                       |
| ------------ | --------------------------------- |
| (none)       | `git diff $BASE...HEAD`           |
| `main..HEAD` | BASE=main                         |
| file list    | `git diff HEAD -- <files>` + read |
| `#123`       | `gh pr diff 123`                  |

For local diffs, also run:
```bash
ct repo context --base $BASE --stat --cochanges
```
Use it for changed files, recent commits, diff-stat, and likely related files. Fetch PR title/body/labels with `gh pr view` if available.

**Large diffs (>3000 lines):** Truncate any file with >200 changed lines to first 50 + last 50 diff lines, but tell reviewers which files were truncated and require them to read those files in full before making claims.

**Bugfix detection:** If commit messages or PR title contain "fix"/"bugfix"/"hotfix", classify files as production vs test. ALL test-only → verdict **FAIL** with Critical: "Bugfix contains no production code changes."

## Step 2: Optional Product/Task Context

Do this once; do not turn it into a report-writing exercise.

```bash
git branch --show-current
ct task list --all
```

If a task clearly matches the branch, PR title, or user-provided topic, include its ID, status, blockers, and acceptance criteria in reviewer prompts. If no task context exists, continue.

## Step 3: Dispatch Reviewers

Spawn all reviewers in ONE message. Pass raw diffs and context, not summaries. Each reviewer must return only actionable findings and must not write files.

Append this protocol to every reviewer prompt:

```
## Output Protocol
Return a table: Severity | File:Line | Finding | Recommendation | Confidence
Severity: critical | high | medium | nit
Confidence: confirmed | likely | needs-check
Only include issues caused or exposed by this diff.
Do not include style preferences, generic best practices, or pre-existing issues unless the diff makes them worse.
Tag cross-cutting findings as [shared:<category>].
```

### Reviewer 1 — Correctness & Security

```
You are an adversarial correctness and security reviewer.

## Gather Context
1. Use the provided raw diff as the source of truth.
2. Run `ct repo context --base {base_ref} --format json` for supplemental repository context.
3. For local/file-list diffs, read changed files from the raw diff even if `ct repo context` disagrees.
4. If `truncated_files` is non-empty, read those files in full.

## Focus
- Edge cases: empty, null, overflow, invalid state, concurrent access
- Boundary semantics: verify what external fields actually mean at the source definition
- Values crossing boundaries: trace producer → consumer, including tuple/struct destructuring
- Dangerous fallbacks: permissive auth, production URLs, swallowed errors, silent defaults
- External interactions: pagination, batching, retries, partial failure, rate limits
- Injection, auth/authz gaps, data exposure
- Error type conflation that loses specificity
- Input validation gaps
- Missing tests for changed behavior that can regress
```

### Reviewer 2 — Design, Reuse & Maintainability

```
You are a design and maintainability reviewer. Find the smallest real improvements that reduce future bugs.

## Gather Context
1. Use the provided raw diff as the source of truth.
2. Run `ct repo context --base {base_ref} --format json` for supplemental repository context.
3. For local/file-list diffs, read changed files from the raw diff even if `ct repo context` disagrees.
4. Search adjacent modules, utility directories, and shared packages before claiming duplication.
5. Read related cochanged files when `cochanges` are provided.

## Focus
- Existing helpers/utilities that should be reused instead of duplicating logic
- Incomplete refactors, leaky abstractions, broken module boundaries
- Copy-paste with slight variation that should unify behind an existing abstraction
- Parameter sprawl or redundant state instead of derived state
- Stringly-typed code where project constants/types already exist
- Over-engineering: scaffolding, abstractions with too few real call sites, "might need it later"
- Unnecessary comments explaining WHAT instead of non-obvious WHY
- Approach fitness: simpler alternative, goal mismatch, or solving the wrong problem
```

### Reviewer 3 — Tests, Operations & Devil's Advocate

```
You are a tests/operations reviewer and devil's advocate. Try to break the change in production.

## Gather Context
1. Use the provided raw diff as the source of truth.
2. Run `ct repo context --base {base_ref} --format json` for supplemental repository context.
3. For local/file-list diffs, read changed files from the raw diff even if `ct repo context` disagrees.
4. Read changed tests and production files together.
5. If PR/task context exists, compare the diff against stated acceptance criteria.

## Focus
- Missing or weak tests for critical behavior, regressions, migrations, and failure paths
- Test assertions that only prove implementation details or snapshots, not behavior
- Dependency failures, bad network responses, empty data, malformed/adversarial input
- Race conditions across async/concurrent paths
- Silent contract changes: check callers when behavior changes
- Performance: N+1 queries, O(n²), unbounded growth, hot-path blocking work
- Operational risk: logging sensitive data, poor diagnostics, unsafe rollout/migration behavior
- Premise check: does the fix actually fix the stated problem?
- Assumption inversion: what does each guard/filter incorrectly exclude?
```

## Step 4: Aggregate and Verify

1. **Approach assessment:** Rate the diff: Sound | Minor Concerns | Significant Concerns | Alternative Recommended. Consider goal alignment, premise, simpler alternatives, and scope.
2. **Deduplicate:** Same root cause → one finding with affected facets/files.
3. **Consensus:** Critical/high from any reviewer survives after verification. Medium/nit survives only if confirmed or shared by 2+ reviewers.
4. **Mandatory verification:** Read source at every finding's file:line ±20 lines. Classify each as Confirmed / False positive / Pre-existing / Uncertain. Remove false positives. Downgrade pre-existing issues unless the diff worsens them.
5. **Prune aggressively:** If you cannot explain the concrete failure mode, drop it.

Output directly in chat. Do **not** create a vault review, report, note, file, or canvas.

Use this format:

```
# Review Summary

Approach: <rating> — <one sentence>
Verification: <confirmed N, removed N, uncertain N>

## Fix Required
| Severity | File:Line | Finding | Recommendation |

## Nits / Optional
| File:Line | Finding | Recommendation |

## Ignored
- <brief false-positive or out-of-scope summary, collapsed>

Verdict: PASS | CHANGES_REQUESTED | FAIL
```

Verdict rules:
- **PASS**: no confirmed required fixes.
- **CHANGES_REQUESTED**: any confirmed high/medium required fix.
- **FAIL**: any confirmed critical issue, including bugfix-with-tests-only.

## Step 5: Fix

Skip this step when there are no confirmed fixable findings.

`--auto critical|high|medium|all` → auto-fix at or above the selected severity:
- `critical`: critical only
- `high`: critical + high
- `medium`: critical + high + medium
- `all`: everything, including nits

No `--auto` → ask: Fix all / Fix critical+high / Fix critical only / Skip.

Spawn one fix agent with only confirmed FIX items. It must fix, verify, self-check for debug artifacts and unused imports, and report changed paths plus verification.

If `--loop` is present, re-run Step 3 after fixes. Track fixed issues by file + description. Stop after no fixable findings remain, user stops, or 3 loops.

## Step 6: Summary

Output: Fixes Applied, Ignored, Remaining, Verification Run.
