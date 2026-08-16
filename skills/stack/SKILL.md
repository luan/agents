---
name: stack
description: Git-Spice stack workflow for explicit stack inspection, navigation, move, reorder, sync, restack, absorb, fixup, or amend requests. Do not invent stacks or stack layers from task size.
---

Inspect with compact machine-readable state:

```bash
git status --short
gs log short --json
```

The output order is unspecified. Use `current`, `down`, `ups`, `change`, and
`push`. Optional fields can be absent.

## Graph

```bash
gs up
gs down
gs top
gs bottom
gs trunk
gs branch onto <base> --branch <name> --restack=upstack
gs branch restack
gs upstack restack
gs stack restack
gs repo sync --restack
```

Create a stack layer only when user input establishes branch intent. Branch
creation procedure and naming live in `$git`.

For restack conflicts, resolve and stage files, then run `gs rebase continue`.
Use `gs rebase abort` when intent cannot be determined.

## Multi-commit changes

Stage only intended paths.

```bash
gs commit absorb
gs commit amend --no-edit
gs commit fixup <commit>
```

Use absorb when matching changes should be distributed across current-layer
commits. Absorb is incomplete while intended changes remain staged. Route a
known current top-commit remainder to amend. Route a known downstack target to
fixup. Stop on unclear ownership.

Preserve remote intent from the initiating request. When it requested PR
updates, use `$submit` after local stack completion without another permission
prompt.

Completion requires the requested graph relationships, no pending rebase, no
selected branch with `down.needsRestack=true`, intended changes in their target
commits, and every affected upstack branch restacked.
