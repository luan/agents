---
name: simplify
description: "Find simpler, smaller, or more idiomatic versions of a changeset without forcing churn. Use when reviewing or preparing diffs for unnecessary complexity, speculative abstraction, duplication, dead code, or scope creep."
argument-hint: "[base..head | file-list | PR#] [--auto]"
---

# Simplify

Assess whether a diff should be made smaller or clearer before deeper review. A clean **PASS** is a first-class result; do not invent cleanup work.

## Inputs

- `[base..head | file-list | PR#]` - diff source. Default: branch diff vs parent/trunk.
- `--auto` - apply confirmed simplifications that are behavior-preserving and low risk.

## Step 1: Scope

Use the same fixed-point and three-dot diff rules as `$code-review`. For local diffs, collect:

```bash
git diff --stat "$BASE"...HEAD
git diff --name-only "$BASE"...HEAD
git log --oneline --decorate --max-count=30 "$BASE"..HEAD
```

Read changed files that matter for any simplification claim. Do not rely only on summaries.

## Step 2: Decide Review Depth

- For <=200 changed lines in one area, inspect directly.
- For larger or multi-area diffs, dispatch one simplifier subagent with raw diff and relevant context.
- Use additional subagents only when there are independent file clusters that cannot be judged by one reviewer; never exceed two.

## Step 3: Simplification Checks

Look for confirmed opportunities to reduce risk or size:

- Dead code, commented-out code, unused shims, obsolete compatibility paths.
- Speculative abstractions, config, parameters, flags, or extension points with no current call sites.
- Duplicate logic where an existing local helper/type already covers the case.
- Incomplete refactors that keep both old and new paths unnecessarily.
- Scope creep unrelated to the stated task or PR.
- Redundant state that can be derived.
- Stringly typed code where existing constants/types are already used nearby.
- Tests or fixtures that assert implementation detail while simpler behavior assertions exist.

Do **not** flag:

- Mere style preferences.
- A different architecture that is not clearly smaller or safer for this diff.
- Abstractions that already have multiple real call sites or match established local patterns.
- Test verbosity that materially documents behavior.

## Step 4: Verification Gate

Every finding must answer:

1. What exact code can be removed, merged, or replaced?
2. Why is the result behavior-preserving or lower risk?
3. Which existing helper/type/pattern proves the simpler path is valid?
4. What verification should run after the change?

If any answer is weak, downgrade to optional or drop it.

## Step 5: Output

```text
# Simplify Summary

Verdict: PASS | SIMPLIFY_RECOMMENDED
Confidence: confirmed N, optional N, dropped N

## Confirmed Simplifications
| File:Line | Issue | Smaller Change | Verification |

## Optional
| File:Line | Idea | Why optional |

## Dropped
- <brief false-positive or preference summary>
```

Verdict rules:

- **PASS**: no confirmed simplification that materially reduces risk, size, or maintenance cost.
- **SIMPLIFY_RECOMMENDED**: at least one confirmed simplification worth doing before review or merge.

## Step 6: Fix

Skip unless `--auto` is present or the user asks to apply fixes.

Apply only confirmed, behavior-preserving simplifications. Preserve unrelated user changes. Run targeted verification and report changed paths plus checks.
