---
name: structure
description: "Creates or revises a compact QRDSPI Structure Outline artifact that sketches implementation shape without task-level detail. Use when a chosen direction needs module seams, ordering, test seams, or review checkpoints clarified."
disable-model-invocation: true
argument-hint: "<topic-or-artifact> [--auto] [--continue]"
user-invocable: true
---

# Structure

## Quick start

Produce a short Structure Outline: how the work is shaped, not every task.

## Workflow

1. **Load context**
   - Search/read vault artifacts: question context, research, design, domain docs, decisions, prior structure, plans, and related docs.
   - Inspect code for module boundaries, interface seams, persistence/state boundaries, test seams, and patterns to preserve.
   - If direction or boundary choices are unresolved, ask a compact clarification batch before drafting.

2. **Outline the shape**
   - Keep it compact: target 1-2 screenfuls, hard cap around 120 lines, and prefer fewer than 6 vertical checkpoints.
   - Summarize affected seams; do not inventory every file, module, test, or UI surface.
   - Define change order, dependency edges, vertical checkpoints, test/check points, AFK/HITL boundaries, and risky review points.
   - Include C-header-like interface/type sketches only when a tiny signature clarifies a contract. No long code blocks.
   - Prefer vertical checkpoints over horizontal buckets. Avoid "all database, then all services, then all UI" plans.
   - Do not write task acceptance criteria or implementation minutia.

3. **Write the artifact**
   - Create new artifacts with `ct vault create -t structure --topic "..." --json`; parse the returned `path` and edit that file with `apply_patch`.
   - For existing artifacts, locate/read them with `ct vault read [-t structure] <stem> --json` or `ct vault list -t structure --json`, then edit the real file path with `apply_patch`.
   - Include:
     - chosen design direction being structured
     - affected seams, summarized
     - 3-6 vertical checkpoints
     - test/check points by checkpoint
     - HITL/review boundaries
     - risks or unknowns that change ordering

4. **Review**
   - Unless `--auto` is clearly safe, resolve the structure artifact to its real absolute local filesystem path and run `plannotator annotate "<absolute-path>" --gate --json`.
   - Do not pass vault stems, wiki-link targets, repo-relative paths, or artifact-link paths to Plannotator.
   - In the gate `instructions`, name the exact absolute file being reviewed and state that it is a structure outline.
   - If denied, revise the same artifact and re-gate.
   - Commit only after approval with `ct vault commit "<absolute-path>" --message "..." --json`.

## Final response

Report only the local result: structure artifact path, checkpoints, tests, risks, and review/commit status. Do not recommend follow-on QRDSPI phases.
