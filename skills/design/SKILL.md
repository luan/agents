---
name: design
description: "Creates or revises a compact QRDSPI Design Discussion artifact that chooses the solution direction and records tradeoffs. Use when evidence and user context are sufficient to decide desired behavior, boundaries, and architectural approach."
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
   - Create or update with `vault_write(op="create", type="design", ...)`.
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
   - Unless `--auto` is clearly safe, run `vault_review(op="gate", gateType="custom")` with a title that says "Design Discussion".
   - If denied, revise the same artifact and re-gate.
   - Commit only after approval with `vault_write(op="commit")`.

## Final response

Report only the local result: design artifact path, key decisions, unresolved questions, and review/commit status. Do not recommend follow-on QRDSPI phases.
