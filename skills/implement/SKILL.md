---
name: implement
description: "Implement one approved vault ticket or bounded spec slice through TDD, verification, code review, and commit."
disable-model-invocation: true
---

Load `/vault` and resolve the selected `ticket` or `spec` artifact with `vlt read`. Implement one bounded slice per session.

When working a ticket, claim it before editing by replacing its `## Status` section with `in_progress` and the current session identifier when available. Preserve its acceptance criteria and blocking links.

Use `/tdd` at the pre-agreed seams. If the artifact has no usable acceptance criteria or an unresolved blocker, return it to the shaping flow instead of silently redesigning it.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once the implementation and checks are green, use `/code-review` against the ticket or spec artifact.

Address confirmed review findings, then use `/commit` to commit the work to the current branch. After the commit, replace the ticket's `## Status` with `in_review` and append concise delivery evidence through `vlt update`.
