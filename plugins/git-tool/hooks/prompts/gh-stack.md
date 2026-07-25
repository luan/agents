## Git tool strategy: GitHub Stacked PRs

This repository is configured with `agents.git-tool=gh-stack`. Use the `gh stack` CLI for stacked-branch workflows. Use the `ghs:submit`, `ghs:sync`, `ghs:restack`, and `ghs:stack` skills for pushing, creating or updating PRs, syncing with trunk, rebasing, branch creation, stack navigation, and stack inspection.

Do not use raw `git push`, `git rebase`, `git checkout -b`, or `gh pr create` for stack workflows. Ordinary `git status`, `git add`, and `git commit` remain allowed when they do not replace a `gh stack` operation.
