# Crit Reviewer Focus Blocks

Use only the blocks needed by the review plan. All reviewers must use the raw diff as source of truth; when available, use raw git context from `git diff --stat {base_ref}...HEAD`, `git diff --name-only {base_ref}...HEAD`, and `git log --oneline --decorate --max-count=30 {base_ref}..HEAD`; read changed files for local/file-list diffs; and read any truncated files in full before making claims.

## Combined Reviewer

Use for small, low-risk diffs. Cover:

- Does the diff do what it claims, with no obvious edge-case breakage?
- Are tests appropriate for changed behavior, or is no test change reasonable?
- Is the implementation straightforward enough to merge unchanged?
- Any security, data exposure, public contract, migration, or rollout risk?

## Correctness, Integration, and Security

- Edge cases: empty, null, overflow, invalid state, concurrent access.
- Boundary semantics: verify external fields at their source definitions.
- Values crossing boundaries: trace producer to consumer, including destructuring.
- Dangerous fallbacks: permissive auth, production URLs, swallowed errors, silent defaults.
- External interactions: pagination, batching, retries, partial failure, rate limits.
- Injection, auth/authz gaps, data exposure, and input validation gaps.
- Error type conflation that loses specificity.

## Design and Maintainability

- Existing helpers/utilities that should be reused instead of duplicating logic.
- Incomplete refactors, leaky abstractions, broken module boundaries.
- Copy-paste with slight variation that should unify behind an existing abstraction.
- Parameter sprawl or redundant state instead of derived state.
- Stringly typed code where project constants/types already exist.
- Over-engineering: scaffolding, speculative abstractions, "might need it later".
- Unnecessary comments explaining WHAT instead of non-obvious WHY.
- Approach fitness: simpler alternative, goal mismatch, or solving the wrong problem.

## Tests, Operations, and Acceptance Criteria

- Missing or weak tests for changed critical behavior, regressions, migrations, and failure paths.
- Assertions that only prove implementation details or snapshots, not behavior.
- Dependency failures, bad network responses, empty data, malformed/adversarial input.
- Race conditions across async/concurrent paths.
- Silent contract changes: check callers when behavior changes.
- Performance: N+1 queries, O(n^2), unbounded growth, hot-path blocking work.
- Operational risk: sensitive logs, poor diagnostics, unsafe rollout/migration behavior.
- Premise check: does the fix actually fix the stated problem?
- Acceptance criteria coverage when PR/task context exists.
