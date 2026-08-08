---
name: implement
description: "Implement one bounded change from conversation context or a named vault artifact through TDD, verification, code review, and commit."
disable-model-invocation: true
---

Use conversation context as the source of scope and acceptance criteria. When the user supplies a vault artifact, load `$vault`, resolve it with `vlt read`, and treat it as implementation input without depending on its artifact type.

Inspect the relevant code and tests before editing. Ask for a missing decision only when it prevents a safe implementation.

Use `$tdd` at the agreed seams. Require observable acceptance criteria before changing behavior.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once the implementation and checks are green, use `$code-review` against the request and any supplied artifact.

Address confirmed findings, then use `$commit` to commit the work to the current branch. Report delivered behavior, verification, and remaining risk.
