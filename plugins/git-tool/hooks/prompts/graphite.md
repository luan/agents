## Git tool strategy: Graphite

This repository is configured with `agents.git-tool=graphite`. Use Graphite for stacked-branch workflows. Use the `gt:submit`, `gt:sync`, `gt:restack`, and `gt:stack` skills for pushing, creating or updating PRs, syncing with trunk, rebasing/restacking, branch creation, stack navigation, and stack inspection.

Do not use raw `git push`, `git rebase`, `git checkout -b`, or `gh pr create` for stack workflows. Ordinary `git status`, `git add`, and `git commit` remain allowed when they do not replace a Graphite stack operation.
