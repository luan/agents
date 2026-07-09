---
name: crit
description: "Run an adversarial review of local changes, branch diffs, or PRs without inventing work. Use when the user asks for review, critique, sanity check, or requested-changes prep."
argument-hint: "[base..head | file-list | PR#] [--auto critical|high|medium|all] [--loop]"
user-invocable: true
---

# Crit

Adversarial review that catches real defects and can explicitly say the change needs no revision. Prefer one confirmed blocker over many speculative suggestions.

**Do not review inline.** Dispatch reviewer subagents, but choose count and split from the diff shape.

## Inputs
- `[base..head | file-list | PR#]` - diff source. Default: branch diff vs parent/trunk.
- `--auto critical|high|medium|all` - fix findings at or above selected severity.
- `--loop` - after auto-fixes, re-run from simplify. Max 3 loops.

## 1. Scope and Context
Resolve BASE with first success unless args override: `gt parent`, `gt trunk`, then `git symbolic-ref --short refs/remotes/origin/HEAD`.

Diff sources: none -> `git diff $BASE...HEAD`; `main..HEAD` -> BASE=main; file list -> `git diff HEAD -- <files>` plus reads; `#123` -> `gh pr diff 123`.

For local diffs collect context with raw git: `git diff --stat "$BASE"...HEAD`, `git diff --name-only "$BASE"...HEAD`, and `git log --oneline --decorate --max-count=30 "$BASE"..HEAD`. Fetch PR metadata with `gh pr view` if available. Also run `git branch --show-current` and `task_read` when available; include a matching task's ID, status, blockers, and acceptance criteria.

Large diffs (>3000 lines): truncate any file with >200 changed lines to first 50 plus last 50 diff lines, list truncations, and require reviewers to read those files in full before making claims.

Bugfix guard: if commit messages or PR title contain "fix", "bugfix", or "hotfix", classify production vs test files. If every changed file is test-only, verdict **FAIL** with Critical: "Bugfix contains no production code changes."

## 2. Simplify First
Invoke `$simplify` on the same diff before risk review.

- `$simplify` **PASS**: record it and continue.
- **SIMPLIFY_RECOMMENDED**: include only confirmed simplification findings in review context.
- With `--auto medium` or `--auto all`: fix confirmed simplifications first, then refresh the diff.
- Optional simplification ideas are not requested changes.

## 3. Choose Review Plan
Write a one-paragraph plan before dispatch: changed areas, risk triggers, reviewer count, and split rationale.

- **1 reviewer**: <=200 changed lines, one coherent area, no security/auth/data migration/concurrency/public API/runtime behavior risk.
- **2 reviewers**: 200-1000 lines, one or two areas, or normal production behavior changes. Split correctness/integration vs tests/maintainability.
- **3 reviewers**: only for >1000 lines, 3+ areas/packages, cross-cutting refactors, security/auth/privacy, persistence/migrations, concurrency/async orchestration, public contracts, performance-sensitive paths, or unclear acceptance criteria.

Prefer file-cluster split for independent domains. Prefer role split for tightly coupled files. If task/PR acceptance criteria exist, assign one reviewer to verify criteria coverage.

## 4. Dispatch Reviewers
Spawn selected reviewers in one message. Pass raw diffs and context, not summaries. Reviewers must not write files. Use only the needed focus blocks from [REVIEWERS.md](REVIEWERS.md).

Append this protocol to every prompt:

```text
Return a table: Severity | File:Line | Finding | Recommendation | Confidence
Severity: critical | high | medium | nit
Confidence: confirmed | likely | needs-check
A clean review is valid. If there are no concrete findings, return "No findings" plus one sentence explaining why.
Only include issues caused or exposed by this diff.
Do not include style preferences, generic best practices, or pre-existing issues unless the diff makes them worse.
Every finding must state the concrete failure mode and trigger. If you cannot explain what breaks, omit it.
Tag cross-cutting findings as [shared:<category>].
```

## 5. Aggregate and Verify
1. Rate approach: Sound | Minor Concerns | Significant Concerns | Alternative Recommended.
2. Deduplicate by root cause.
3. Verify every candidate finding by reading source at file:line +/-20 lines. Classify Confirmed, False positive, Pre-existing, or Uncertain.
4. Keep critical/high after verification. Keep medium/nit only if confirmed and materially worth changing, or shared by 2+ reviewers.
5. Before requesting changes, ask: would this block merge for a capable teammate; what concrete risk remains if unchanged; is the recommendation smaller/safer?
6. Drop false positives, preferences, and "could be nicer" items. A PASS with no findings is a successful review.

Respond directly in chat; do not create a vault artifact, note, file, or canvas.

```text
# Review Summary
Approach: <rating> - <one sentence>
Review plan: <reviewer count and split rationale>
Simplify: PASS | SIMPLIFY_RECOMMENDED | not run (<reason>)
Verification: <confirmed N, removed N, uncertain N>

## Fix Required
| Severity | File:Line | Finding | Recommendation |

## Nits / Optional
| File:Line | Finding | Recommendation |

## Ignored
- <brief false-positive or out-of-scope summary, collapsed>

Verdict: PASS | CHANGES_REQUESTED | FAIL
```

Verdict rules: **PASS** means no confirmed required fixes; **CHANGES_REQUESTED** means any confirmed high/medium required fix; **FAIL** means any confirmed critical issue, including bugfix-with-tests-only.

## 6. Fix

Skip when there are no confirmed fixable findings. `--auto critical|high|medium|all` fixes at or above that severity. Without `--auto`, ask: Fix all / Fix critical+high / Fix critical only / Skip.

Spawn one fix agent with only confirmed fix items. It must fix, verify, self-check for debug artifacts and unused imports, and report changed paths plus verification. With `--loop`, re-run from Step 2; stop after no fixable findings remain, user stops, or 3 loops.
