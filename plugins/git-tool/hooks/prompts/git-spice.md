## Git tool strategy: Git-Spice

This repository is configured with `agents.git-tool=git-spice`. Use Git-Spice for stacked-branch workflows. Use the `gs:submit`, `gs:sync`, `gs:restack`, and `gs:stack` skills for pushing, creating or updating Change Requests, syncing with trunk, rebasing/restacking, branch creation, stack navigation, and stack inspection.

Do not use raw `git push`, `git rebase`, `git checkout -b`, or `gh pr create` for stack workflows. Ordinary `git status`, `git add`, and `git commit` remain allowed when they do not replace a Git-Spice stack operation.
