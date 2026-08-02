---
name: project-recap
description: Generate a visual project recap for context switching
---

Load the visual-explainer skill and generate a self-contained HTML project recap.

## Data gathering before HTML

Read project identity files (`README`, changelog, package/build files), top-level tree, current git status, recent commits, unmerged/stale branches, TODO/FIXME in recent files, progress/todo memory if present, and key entry points/source files. Focus on what a returning developer needs to rebuild the mental model.

## Verify before generating

Cite command output or file:line evidence for project state, module/function/type names, recent activity, current blockers, and next-step claims. Do not fabricate momentum or rationale.

## Required outcomes

The recap must let a returning developer recover:

- the current operating behavior and constraints;
- the active work that changes the next action;
- the shortest execution, test, or deployment path needed to resume;
- verified blockers or risks that affect that path.

Let the evidence determine the composition. Add architecture, history, file maps, or command reference only when each improves next-action recoverability.

Write to the requested path; otherwise use `~/.agent/diagrams/`. When visible review is permitted, inspect it in Dia; never launch Chrome or Chromium.
