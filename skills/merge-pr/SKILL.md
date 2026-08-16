---
name: merge-pr
description: Merge one pull request or a Git-Spice stack, or close a pull request without merging when explicitly requested.
argument-hint: "[PR-or-branch] [--close]"
disable-model-invocation: true
---

Resolve repository, branch, PR number, base, head SHA, and Git-Spice graph before
mutation.

- Merge one selected branch: `gs branch merge --branch <name>`.
- Merge a selected stack: `gs stack merge --branch <name>`.
- Use current configured merge behavior unless the user selects a method.
- Close without merging only when the request explicitly selects closure. Use
  the verified PR number and repository.

After merge, verify every requested change is merged. If Git-Spice blocks a
branch, report it and leave dependent branches unmerged. After closure, verify
the selected PR is closed and no other PR changed.
