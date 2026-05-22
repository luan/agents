---
name: research
description: "Creates or revises a factual QRDSPI research artifact about current system reality: behavior, constraints, code paths, vocabulary, risks, and unknowns. Use when objective evidence is needed before design, structure, planning, or implementation."
disable-model-invocation: true
argument-hint: "<topic-or-question-summary> [--auto] [--continue] [--depth medium|high|max]"
user-invocable: true
---

# Research

## Quick start

Create a vault research artifact that preserves user context but contains only factual evidence about how the system works today.

## Arguments

- `<topic-or-question-summary>`: optional only when prior context is sufficient or `--continue` is set
- `--auto`: skip conversational approval only; the Plannotator gate is still required
- `--continue`: revise an existing research artifact
- `--depth medium|high|max`: breadth of evidence gathering

## Workflow

1. **Load context**
   - Search/read vault artifacts: domain docs, decisions, research, design, structure, plans, and related docs.
   - If an intake summary exists, carry its context seed forward explicitly: preserve resolved user answers, vocabulary, scope boundaries, defaults, and non-goals.
   - Verify code/vault claims from intake; do not relitigate resolved user preferences unless new evidence contradicts them.

2. **Gather factual evidence**
   - Explore code after vocabulary and recorded decisions are clear.
   - Identify current behavior, interfaces, state/persistence paths, constraints, risks, vocabulary, tests, and unknowns.
   - Validate important claims with direct reads/searches. Prefer fresh Explore subagents when proposal bias is a risk.
   - Do not choose designs, recommend solutions, create tasks, or write implementation phases.

3. **Draft the artifact**
   - Create new artifacts with `ct vault create -t research --topic "..." --json`; parse the returned `path` and edit that file with `apply_patch`.
   - For existing artifacts, locate/read them with `ct vault read [-t research] <stem> --json` or `ct vault list -t research --json`, then edit the real file path with `apply_patch`.
   - Include scope, current behavior, code paths, public interfaces, constraints, vocabulary, tests, risks, unknowns, and related links.
   - Include "Input context preserved from intake" when applicable, separating user decisions/defaults from verified code facts.
   - For visual/stateful/architectural topics, add a lightweight visual section for Plannotator review: Mermaid for flows/sequences/state, Graphviz for architecture/dependency maps, or local SVG/PNG image references.

4. **Review**
   - Before the gate, ask at most one compact batch of targeted clarification questions about unresolved evidence gaps; do not frame these as approval.
   - Do not ask questions that code/vault exploration can answer. Prefer a concrete default recommendation plus a small choice set when a human choice is necessary.
   - Resolve the artifact to its real absolute local filesystem path before the gate. For vault artifacts, use the path returned by `ct vault create --json` or `ct vault read --json`, expanding `~` if needed. Do not pass vault stems, wiki-link targets, repo-relative paths, or artifact-link paths to Plannotator.
   - Run `plannotator annotate "<absolute-path>" --gate --json`. Use the normal long human-review timeout; do not set a short timeout for research gates.
   - In the gate `instructions`, name the exact absolute file being reviewed and state the artifact type/purpose so Plannotator is not left to infer whether it is research, a plan, or a fixture.
   - A handled approved Plannotator gate is sufficient approval to continue; do not ask the user for another approval afterward.
   - If denied with feedback, treat it as content feedback: revise and re-gate.
   - If unavailable, timed out, closed without result, or otherwise failed closed, treat it as a Plannotator/tool failure. Ask whether to retry the Plannotator gate or pause; do not ask the user to approve the research conversationally.
   - Keep `ct vault commit` blocked until a handled approved Plannotator result exists. Do not try to recover Plannotator feedback through separate artifact comment extraction. Plannotator annotations must arrive through the gate result.

5. **Commit**
   - Run `ct vault commit "<absolute-path>" --message "..." --json` only after approval. Never commit before the research gate, including with `--auto`.

## Final response

Report only the local result: artifact path, evidence covered, unresolved unknowns, and review/commit status. Do not recommend follow-on QRDSPI phases.
