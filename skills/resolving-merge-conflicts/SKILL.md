---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
---

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand why each change was made and what the original intent was. Read commit messages and use `$vault` plus `vlt search/read/links` to recover related specs, tickets, decisions, and research.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Keep behavior within the two source intents and finish the active merge or rebase.

4. Discover the project's **automated checks** and run them — typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Finish the merge/rebase.** Stage only the resolved scope. Commit a merge when Git requires it; for a rebase, continue non-interactively until every commit is rebased.
