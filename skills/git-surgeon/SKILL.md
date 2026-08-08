---
name: git-surgeon
description: Non-interactive hunk-level git staging, unstaging, discarding, undoing, fixup, amend, squash, commit splitting, and commit reordering. Use when selectively staging, unstaging, discarding, reverting, squashing, splitting, or reordering individual diff hunks by ID instead of interactively.
---

# git-surgeon

CLI for hunk-level git operations without interactive prompts, so an agent can pick exactly which changes to stage, unstage, discard, or undo.

`git-surgeon --help` and `git-surgeon <command> --help` carry the full command surface and every flag. Read them for syntax; this skill covers what they cannot tell you — which operation fits the situation, and how the pieces behave.

## Hunk IDs

Every operation addresses hunks by id. Start by listing them:

```bash
git-surgeon hunks                      # unstaged
git-surgeon hunks --staged
git-surgeon hunks --commit <sha>       # hunks inside a commit
git-surgeon hunks --commit <sha> --full  # with line numbers, for line-range splits
```

- 7-character hex, derived from file path plus hunk content.
- Stable across runs while the diff content is unchanged; duplicates take `-2`, `-3` suffixes.
- An id that is not found means the diff moved — re-run `hunks` for fresh ids.

Address part of a hunk with a line range: `<id>:5-30`, or `<id>:2-6,34-37` for non-contiguous lines. `git-surgeon show <id>` prints the hunk with numbered lines to pick from.

## Choosing the operation

The commands overlap, and picking the wrong one rewrites more history than intended:

| Situation | Command | What it does to the range |
|---|---|---|
| New work belongs in an earlier commit | `fixup <target>` | Folds HEAD (or `--from <commit>`) into target; intermediate commits untouched |
| Staged work belongs in an earlier commit | `amend <commit>` | HEAD amends directly; older commits go through autosquash rebase |
| Several commits should become one | `squash <commit>` | Collapses **every** commit from `<commit>` through HEAD |
| One commit holds unrelated changes | `split <commit> --pick …` | Divides it by hunk selection |
| A commit sits in the wrong place | `move <sha> --after/--before/--to-end` | Reorders without changing content |
| A change should come back out | `undo <id> --from <sha>` | Reverse-applies into the working tree as unstaged changes |

`fixup` folds one commit into a non-adjacent earlier one. `squash` collapses the whole range between them. Reach for `fixup` unless collapsing the range is the actual goal.

Shared constraints: merge commits inside the range fail the operation (`squash --force` overrides), `split` needs a clean working tree, and `fixup`, `amend`, `move`, and `squash` autostash and restore a dirty tree. `squash` keeps the oldest commit's author unless given `--no-preserve-author`.

## Finding the fixup target with blame

`--blame` shows which commit introduced each surrounding line, which names the commit your new lines belong to:

```bash
git-surgeon hunks --blame
```

```
a1b2c3d src/auth.rs (+2 -0)
  8922b52  fn login(user: &str) {
  8922b52      validate(user);
  0000000 +    log_attempt(user);  # new line, not yet committed
  0000000 +    audit(user);        # new line, not yet committed
  8922b52  }
```

Context lines carry `8922b52` — the commit that added the function. Commit the hunk, then fold it in:

```bash
git-surgeon commit a1b2c3d -m "add login logging"
git-surgeon fixup 8922b52
```

`--blame` also takes `--staged` and `--commit <sha>`.

## Committing to a branch checked out elsewhere

`commit-to` applies hunks to another branch's tree without checking it out — the case that makes worktrees workable:

```bash
git-surgeon commit-to main <id1> <id2>:1-11 -m "message"
```

The hunks land on the target branch and leave the working tree. It fails when the patch does not apply cleanly there.

## Commit messages

`commit`, `commit-to`, `split`, `squash`, and `reword` take repeated `-m` flags for subject and body, exactly like `git commit`. `split` names the leftover commit with `--rest-message`, which also repeats.

## Upstream

`git-surgeon install-skill` writes this skill from the tool itself. Local edits here diverge from what a reinstall would produce.
