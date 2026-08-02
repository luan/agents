---
name: diff-review
description: Generate a visual diff review for code changes
---

Load the visual-explainer skill and generate a self-contained HTML diff review.

## Scope detection

Interpret `$@` as a branch, commit, range, PR, or `HEAD`. If no argument is given, compare the working tree against `main`/`master`.

## Data gathering before HTML

Run the relevant git commands for: diff stats, name-status, changed files, line counts, public API/type/function changes, added/removed files, docs/changelog changes, tests touched, dependencies/config changes. Read changed files in full plus surrounding code paths needed to validate behavior. If reviewing committed work, read commit messages. If this session created the work, use available progress/plan notes for rationale.

## Source verification

Before generating, know and cite:

- exact changed files and line-count scope;
- each function/type/module name referenced;
- before/after behavior for important changes;
- likely coupling and test impact.

Use file paths, command outputs, or file:line evidence. Do not invent rationale or code paths.

## Required outcomes

The review must let the reader determine:

- what observable behavior changed;
- which interfaces or dependencies carry the change;
- what evidence supports the assessment;
- which risks or blockers change the merge decision.

Let those outcomes determine the sections and visuals. Include architecture, file maps, before/after views, or risk tables only when they reveal a relationship needed for the decision.

Write to the requested path; otherwise use `~/.agent/diagrams/`. When visible review is permitted, inspect it in Dia; never launch Chrome or Chromium.
