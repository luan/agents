---
name: plan-review
description: Compare an implementation plan against the current codebase
---

Load the visual-explainer skill and generate a self-contained HTML plan review.

## Inputs

Use `$@` as the plan path or plan text. If no path is given, ask for the plan.

## Data gathering before HTML

Read the plan in full. Extract goals, assumptions, proposed files/functions/types, migrations, tests, rollout/release notes, and explicit risks. Read every referenced file, plus importers/dependents that may be affected. Use ripgrep for existing patterns, similar implementations, public API boundaries, config/schema files, and tests.

## Source verification

For each proposed change, verify whether referenced files/functions/types exist, whether current behavior matches the plan, what ripple effects are missing, and whether the proposed test coverage fits the current test style. Cite plan sections and file:line evidence.

## Document spine

1. Explain whether the plan matches current behavior and the consequence of any mismatch.
2. Compare current and proposed behavior at the smallest useful scope.
3. Present source-grounded gaps, risks, and required corrections.
4. Conclude with approve, revise, or reject and concrete reasons.

Use architecture views only when the plan changes architectural relationships. Add file-level detail only where code location changes the recommendation.

Write to the requested path; otherwise use `~/.agent/diagrams/`. When visible review is permitted, inspect it in Dia; never launch Chrome or Chromium.
