---
name: design
description: "Creates or revises a compact QRDSPI Design Discussion artifact that chooses the solution direction and records tradeoffs. Use when evidence and user context are sufficient to decide desired behavior, boundaries, and architectural approach."
disable-model-invocation: true
argument-hint: "<topic-or-artifact> [--auto] [--continue]"
user-invocable: true
---

# Design

## Quick start

Produce a compact review brief: where the solution is going, which decisions matter, and why.

## Workflow

1. **Load context**
   - Search/read vault artifacts: question summary in conversation, research, domain docs, decisions, prior design, structure, plans, and related docs.
   - Inspect code enough to verify current state, architectural seams, patterns to follow, and patterns to avoid.
   - If vocabulary, scope, or user preference is still load-bearing, run a compact clarification batch with `ask_user`.

2. **Choose direction**
   - Separate facts from choices: facts belong to research; choices belong here.
   - Decide the smallest coherent solution direction that satisfies the intent.
   - Cluster related choices into a few load-bearing decisions instead of writing one section per detail.
   - Include tradeoffs only where alternatives were plausible and the choice affects implementation shape or user behavior.
   - Avoid implementation sequencing, task decomposition, and file-by-file instructions; they are out of scope for design.

3. **Write the artifact**
   - Create new artifacts with `ct vault create -t design --topic "..." --json`; parse the returned `path` and edit that file with `apply_patch`.
   - For existing artifacts, locate/read them with `ct vault read [-t design] <stem> --json` or `ct vault list -t design --json`, then edit the real file path with `apply_patch`.
   - Keep it reviewable: target 1-2 screenfuls, hard cap around 120 lines, and prefer 3-5 design decisions.
   - Link to research for evidence; do not copy long current-state findings into the design.
   - Include:
     - brief current state
     - desired end state
     - 3-5 design decisions with one-paragraph rationale each
     - rejected alternatives only when they explain a non-obvious choice
     - top patterns to follow / patterns to avoid
     - compatibility, migration, or rollback implications
     - open questions that block choosing the solution direction
   - Use at most one compact diagram, only when it replaces prose.
   - If the design needs more than 5 decisions, merge details under broader decisions or defer implementation-level choices out of the artifact.

4. **Review**
   - Unless `--auto` is clearly safe, resolve the design artifact to its real absolute local filesystem path and run `plannotator annotate "<absolute-path>" --gate --json`.
   - Do not pass vault stems, wiki-link targets, repo-relative paths, or artifact-link paths to Plannotator.
   - In the gate `instructions`, name the exact absolute file being reviewed and state that it is a design discussion.
   - If denied, revise the same artifact and re-gate.
   - Commit only after approval with `ct vault commit "<absolute-path>" --message "..." --json`.

## Final response

Report only the local result: design artifact path, key decisions, unresolved questions, and review/commit status. Do not recommend follow-on QRDSPI phases.
