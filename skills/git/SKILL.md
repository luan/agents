---
name: git
description: Git safety and local history workflow for repository identity, remote refresh, branch creation, selective changes, history surgery, or conflict recovery. Create branches only when user input requests one. Close a pull request without merging only on direct user request.
---

Inspect before mutation:

```bash
git status --short
git branch --show-current
git remote -v
git branch -vv
```

Account for worktree changes, current branch, upstream, and remote movement.
Keep the current branch unless user input requests a new branch. Task size,
change structure, and review convenience do not establish branch intent.

When a branch is requested:

- A new review layer or explicit stack branch: `gs branch create <name> --no-commit`.
- A temporary local utility or experiment branch: `git switch -c <name>`.
- Pass stack branch names unchanged because Git-Spice applies configured naming.
- Do not submit or track a temporary branch unless later user input requests it.

Use `git-surgeon` for precise hunk operations. Every operation addresses hunk
IDs. List them before mutation:

```bash
git-surgeon hunks                         # unstaged
git-surgeon hunks --staged
git-surgeon hunks --commit <sha>
git-surgeon hunks --commit <sha> --full   # line numbers for partial selection
git-surgeon show <id>
```

IDs remain stable while diff content is unchanged. Re-list when an ID no longer
resolves. Select part of a hunk with `<id>:5-30` or
`<id>:2-6,34-37`.

| Goal | Command |
| --- | --- |
| Stage | `git-surgeon stage <id>...` |
| Unstage | `git-surgeon unstage <id>...` |
| Discard | `git-surgeon discard <id>...` |
| Undo commit content into worktree | `git-surgeon undo <id> --from <sha>` |
| Amend an older commit | `git-surgeon amend <commit>` |
| Split one commit by hunks | `git-surgeon split <commit> --pick <id>...` |
| Reorder a commit | `git-surgeon move <sha> --after <sha>` |
| Fold one commit into a target | `git-surgeon fixup <target>` |
| Collapse a full range | `git-surgeon squash <oldest> -m "<message>"` |
| Commit selected hunks to another checked-out worktree branch | `git-surgeon commit-to <branch> <id>... -m "<message>"` |

Use fixup for one commit that belongs in an earlier commit. Squash collapses
every commit from its target through HEAD. Split requires a clean worktree.
History rewrite requires a known target and understood remote state.

For conflicts, read both source intents, resolve every marker, stage only the
resolved files, and continue through the tool that started the operation.
Run the relevant automated checks after resolution. Abort when intent is unclear
or checks expose an unresolved semantic conflict.

Pull request closure is destructive lifecycle mutation. Keep pull requests open
unless the user directly requests closing without merge. Stale, duplicate,
superseded, or inconvenient pull requests are not implicit close requests.

Completion requires requested local state, no unresolved conflict, every
worktree change accounted for, and no unrequested branch or pull request
lifecycle mutation.
